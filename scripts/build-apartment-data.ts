import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import iconv from "iconv-lite";
import XLSX from "xlsx";

type CsvRow = Record<string, string | undefined>;

type Trade = {
  id: string;
  city: string;
  lotNumber: string;
  complexName: string;
  areaM2: number;
  dealDate: string;
  priceManwon: number;
  building: string;
  floor: string;
  builtYear: number | null;
  roadName: string;
  tradeType: string;
  brokerageLocation: string;
  /** `scripts/preprocess_trades.py` 병합 CSV에서 이미 채운 세대수(있으면 단지 재조회 대신 사용) */
  preloadHouseholds?: number;
  preloadHouseholdSource?: string | null;
};

type Apartment = {
  id: string;
  complexName: string;
  address: string;
  city: string;
  roadName: string;
  builtYear: number | null;
  households: number | null;
  householdsSource: string | null;
  lat: number;
  lng: number;
  transitMinutes: number;
  transitText: string;
  latestTrade: Trade;
  recentTrades: Trade[];
};

type DataFile = {
  generatedAt: string | null;
  sourceFiles: string[];
  criteria: {
    maxPriceManwon: number;
    minAreaM2: number;
    transitOrigin: string;
    maxTransitMinutes: number;
    departureLabel: string;
    householdFileLoaded: boolean;
    householdMatchRequired: boolean;
    complexNameFilter: {
      mode: "none" | "officetel_only" | "officetel_and_villa";
      appliedKeywords: string[];
      officetelOnlyKeywords: string[];
      officetelAndVillaKeywords: string[];
    };
    minHouseholds: number;
    householdAllowedClassifications: string[];
    /** Python 병합 CSV를 읽었을 때 상대 경로 */
    pythonMergedCsv?: string | null;
  };
  summary: {
    rawRows: number;
    filteredRowsCsv: number;
    preprocessDroppedNoHouseholdMatch: number;
    preprocessDroppedMinHouseholds: number;
    filteredRows: number;
    skippedComplexFilter: number;
    skippedComplexSamples: string[];
    apartmentsBeforeTransit: number;
    apartments: number;
    geocodeMissing: number;
    transitMissing: number;
    skippedTransitOverOneHour: number;
    dedupeDroppedOlderSameComplexArea: number;
  };
  apartments: Apartment[];
};

type Cache<T> = Record<string, T>;

type GeocodeCacheEntry = {
  lat: number;
  lng: number;
  matchedAddress: string;
};

type TransitCacheEntry = {
  minutes: number;
  text: string;
  status: string;
  departureUnix: number;
};

type HouseholdEntry = {
  complexName: string;
  roadNameAddress: string;
  lotAddress: string;
  households: number;
  classification: string;
  source: string;
};

const ROOT_DIR = process.cwd();
config({ path: path.join(ROOT_DIR, ".env.local") });
config();

const DATA_DIR = path.join(ROOT_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const REPORT_DIR = path.join(DATA_DIR, "reports");
const PUBLIC_DATA_PATH = path.join(ROOT_DIR, "public", "data", "apartments.json");
const HOUSEHOLDS_CSV_PATH = path.join(DATA_DIR, "households.csv");
const HOUSEHOLDS_XLSX_PATH = path.join(ROOT_DIR, "20260501_단지_기본정보.xlsx");

const PREPROCESSED_DIR = path.join(DATA_DIR, "preprocessed");
const PREPROCESSED_MERGED_CSV_DEFAULT = path.join(PREPROCESSED_DIR, "trades-with-households.csv");
const PREPROCESSED_TRADES_PATH_OVERRIDE = process.env.PREPROCESSED_TRADES_PATH?.trim();
const PREPROCESSED_MERGED_CSV =
  PREPROCESSED_TRADES_PATH_OVERRIDE && PREPROCESSED_TRADES_PATH_OVERRIDE.length > 0
    ? path.resolve(ROOT_DIR, PREPROCESSED_TRADES_PATH_OVERRIDE)
    : PREPROCESSED_MERGED_CSV_DEFAULT;
const PREPROCESSED_SUMMARY_JSON = path.join(PREPROCESSED_DIR, "preprocess-summary.json");
const SKIP_PYTHON_MERGED_INPUT = process.env.DATA_SKIP_PYTHON_MERGE === "1";

const MAX_PRICE_MANWON = 110_000;
const MIN_AREA_M2 = 40;
const MAX_TRANSIT_MINUTES = 60;
const MIN_HOUSEHOLDS = Number(process.env.MIN_HOUSEHOLDS ?? 0);
const TRANSIT_ORIGIN = "강남역";
const TRANSIT_ORIGIN_FOR_GOOGLE = "Gangnam Station, Seoul, South Korea";
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DRY_RUN = process.argv.includes("--dry-run");
const LOG_EVERY_GROUPS = 50;
const CACHE_SAVE_EVERY_GROUPS = 100;
const HOUSEHOLD_ALLOWED_CLASSIFICATIONS = parseKeywordList(process.env.HOUSEHOLD_ALLOWED_CLASSIFICATIONS ?? "아파트");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseKeywordList(raw: string | undefined) {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

const EXCLUDED_COMPLEX_KEYWORDS_OFFICETEL_DEFAULT = [
  "오피스텔",
  "근린생활",
  "근린생활시설",
  "근린형",
];

const EXCLUDED_COMPLEX_KEYWORDS_VILLA_DEFAULT = [
  "(주택)",
  "주택)",
  "(주택",
  "(다세대",
  "도시형생활주택",
  "다세대",
  "연립",
  "빌라",
  "주상복합",
];

const EXCLUDED_COMPLEX_KEYWORDS_EXTRA = parseKeywordList(process.env.FILTER_COMPLEX_EXCLUDE_KEYWORDS);

function normalizeComplexFilterMode(value: string | undefined): "none" | "officetel_only" | "officetel_and_villa" {
  const mode = value?.trim() ?? "";
  if (mode === "" || mode === "officetel_only") return "officetel_only";
  if (mode === "none" || mode === "off") return "none";
  if (mode === "officetel_and_villa" || mode === "villa_strict" || mode === "strict") return "officetel_and_villa";
  throw new Error(
    `FILTER_COMPLEX_MODE must be one of none, officetel_only, officetel_and_villa. Received: "${value}".`,
  );
}

const FILTER_COMPLEX_MODE = normalizeComplexFilterMode(process.env.FILTER_COMPLEX_MODE);

function keywordHit(name: string, keywords: string[]) {
  return keywords.find((keyword) => keyword && name.includes(keyword)) ?? "";
}

function excludedComplexKeywordsForMode(mode: "none" | "officetel_only" | "officetel_and_villa") {
  if (mode === "none") return [];
  if (mode === "officetel_only") {
    const dedup = new Map<string, true>();
    for (const keyword of [...EXCLUDED_COMPLEX_KEYWORDS_OFFICETEL_DEFAULT, ...EXCLUDED_COMPLEX_KEYWORDS_EXTRA]) {
      dedup.set(keyword, true);
    }
    return [...dedup.keys()].sort((a, b) => b.length - a.length);
  }

  const dedup = new Map<string, true>();
  for (const keyword of [
    ...EXCLUDED_COMPLEX_KEYWORDS_OFFICETEL_DEFAULT,
    ...EXCLUDED_COMPLEX_KEYWORDS_VILLA_DEFAULT,
    ...EXCLUDED_COMPLEX_KEYWORDS_EXTRA,
  ]) {
    dedup.set(keyword, true);
  }
  return [...dedup.keys()].sort((a, b) => b.length - a.length);
}

function shouldExcludeComplexName(name: string, mode: "none" | "officetel_only" | "officetel_and_villa") {
  if (mode === "none") return null;
  const hit = keywordHit(name, excludedComplexKeywordsForMode(mode));
  return hit ? hit : null;
}

function formatElapsed(startedAt: number) {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${minutes}m ${String(restSeconds).padStart(2, "0")}s`;
}

function shouldFailFast(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("401") || message.includes("403") || message.includes("NotAuthorizedError");
}

async function fetchWithRetry(url: URL, init: RequestInit | undefined, label: string) {
  const retryStatuses = new Set([429, 500, 502, 503, 504]);
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok || !retryStatuses.has(response.status) || attempt === 3) {
      return response;
    }

    lastResponse = response;
    console.warn(`[retry] ${label}: ${response.status} ${response.statusText} (attempt ${attempt}/3)`);
    await sleep(500 * attempt);
  }

  return lastResponse ?? fetch(url, init);
}

function stableId(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 14);
}

function parsePrice(value: string | undefined) {
  return Number((value ?? "").replaceAll(",", "").trim());
}

function parseNumber(value: string | undefined) {
  return Number((value ?? "").trim());
}

function parseLooseNumber(value: string | undefined) {
  return Number((value ?? "").replaceAll(",", "").trim());
}

function compactText(value: string) {
  return value
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .toLowerCase();
}

/** 실거래·단지표 단지명 차이 완화: 괄호 블록 제거 후 끝의 '단지'·'아파트'만 반복 제거 */
function normalizeHouseholdComplexName(raw: string) {
  let name = raw.replace(/\([^)]*\)/g, "").trim();
  let previous = "";
  while (previous !== name) {
    previous = name;
    name = name.replace(/(?:단지|아파트)\s*$/u, "").trim();
  }
  return name;
}

function householdComplexCompact(rawComplexName: string) {
  return compactText(normalizeHouseholdComplexName(rawComplexName));
}

function splitCommaAddressFragments(raw: string) {
  return [...new Set(raw.split(",").map((segment) => segment.trim()).filter(Boolean))];
}

/** 시군구에 법정동이 포함될 때(…구 ○○동), 단지표 도로명과 맞추기 위해 마지막 동 토큰을 뺀 '시·구 + 도로' 변형 */
function tradeCityRoadCandidateLines(siGunGu: string, road: string) {
  const lines = new Set<string>();
  const trimmedRoad = road.trim();
  lines.add(`${siGunGu.trim()} ${trimmedRoad}`.trim());
  const tokens = siGunGu.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 3 && /동$/u.test(tokens[tokens.length - 1] ?? "")) {
    lines.add(`${tokens.slice(0, -1).join(" ")} ${trimmedRoad}`.trim());
  }
  return [...lines];
}

/** 단지 주소 문자열 한 덩어리(도로명 등) → 검색 합성키 */
function householdCompoundLookupKeys(rawComplexName: string, rawAddressSegment: string) {
  const namePart = householdComplexCompact(rawComplexName);
  const addressPart = normalizeAddressForMatch(rawAddressSegment.trim());
  return namePart && addressPart ? [`${addressPart}|${namePart}`] : [];
}

function householdCompoundKeysForTrade(complexName: string, city: string, road: string) {
  const compoundKeys = new Set<string>();
  for (const candidate of tradeCityRoadCandidateLines(city, road)) {
    for (const key of householdCompoundLookupKeys(complexName, candidate)) {
      compoundKeys.add(key);
    }
  }
  return [...compoundKeys];
}

/** 단지 DB 한 행: 도로명·법정동에 다중 주소(쉼표)가 있으면 각각 인덱싱 */
function householdCompoundKeysForHouseholdEntry(entry: HouseholdEntry) {
  const compoundKeys = new Set<string>();
  const roadChunks = entry.roadNameAddress ? splitCommaAddressFragments(entry.roadNameAddress) : [];
  const lotChunks = entry.lotAddress ? splitCommaAddressFragments(entry.lotAddress) : [];
  for (const fragment of [...new Set([...roadChunks, ...lotChunks])]) {
    for (const key of householdCompoundLookupKeys(entry.complexName, fragment)) {
      compoundKeys.add(key);
    }
  }
  return [...compoundKeys];
}

function normalizeAddressForMatch(value: string) {
  return compactText(value)
    .replace(/^서울특별시/, "서울")
    .replace(/^경기도/, "경기");
}

function householdAddressKey(addressLine: string) {
  const normalizedAddress = normalizeAddressForMatch(addressLine);
  return normalizedAddress ? `addr:${normalizedAddress}` : "";
}

function getFirstValue(row: CsvRow, columnNames: string[]) {
  for (const columnName of columnNames) {
    const value = row[columnName]?.trim();
    if (value) return value;
  }
  return "";
}

function normalizeDate(yearMonth: string | undefined, day: string | undefined) {
  const ym = (yearMonth ?? "").trim();
  const dd = (day ?? "").trim().padStart(2, "0");
  if (ym.length !== 6 || dd.length !== 2) return "";
  return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${dd}`;
}

function isCancelled(row: CsvRow) {
  const value = row["해제사유발생일"]?.trim();
  return Boolean(value && value !== "-");
}

function isSeoulOrGyeonggi(city: string) {
  return city.startsWith("서울특별시") || city.startsWith("경기도");
}

function normalizeTrade(row: CsvRow, sourceFile: string, rowIndex: number): Trade | null {
  const city = row["시군구"]?.trim() ?? "";
  const roadName = row["도로명"]?.trim() ?? "";
  const complexName = row["단지명"]?.trim() ?? "";
  const areaM2 = parseNumber(row["전용면적(㎡)"]);
  const priceManwon = parsePrice(row["거래금액(만원)"]);
  const dealDate = normalizeDate(row["계약년월"], row["계약일"]);

  if (!city || !roadName || !complexName || !dealDate) return null;

  const complexHit = shouldExcludeComplexName(complexName, FILTER_COMPLEX_MODE);
  if (complexHit) return null;

  if (!isSeoulOrGyeonggi(city)) return null;
  if (isCancelled(row)) return null;
  if (!Number.isFinite(areaM2) || areaM2 < MIN_AREA_M2) return null;
  if (!Number.isFinite(priceManwon) || priceManwon > MAX_PRICE_MANWON) return null;

  return {
    id: stableId(`${sourceFile}|${rowIndex}|${city}|${roadName}|${complexName}|${dealDate}|${areaM2}|${priceManwon}`),
    city,
    lotNumber: row["번지"]?.trim() ?? "",
    complexName,
    areaM2,
    dealDate,
    priceManwon,
    building: row["동"]?.trim() ?? "-",
    floor: row["층"]?.trim() ?? "-",
    builtYear: Number.isFinite(parseNumber(row["건축년도"])) ? parseNumber(row["건축년도"]) : null,
    roadName,
    tradeType: row["거래유형"]?.trim() ?? "",
    brokerageLocation: row["중개사소재지"]?.trim() ?? "",
  };
}

async function readCsvTrades() {
  const fileNames = (await readdir(ROOT_DIR))
    .filter((fileName) => fileName.endsWith(".csv"))
    .sort();

  const trades: Trade[] = [];
  let rawRows = 0;
  let skippedComplexFilter = 0;

  const skippedComplexSamples: string[] = [];
  const skippedComplexDedup = new Set<string>();

  for (const fileName of fileNames) {
    const filePath = path.join(ROOT_DIR, fileName);
    const buffer = await readFile(filePath);
    const utf8Content = buffer.toString("utf8");
    const content = utf8Content.includes("시군구") ? utf8Content : iconv.decode(buffer, "cp949");
    const rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as CsvRow[];

    rawRows += rows.length;
    rows.forEach((row, index) => {
      const complexName = row["단지명"]?.trim() ?? "";
      if (!complexName || FILTER_COMPLEX_MODE === "none") {
        //
      } else {
        const hit = shouldExcludeComplexName(complexName, FILTER_COMPLEX_MODE);
        if (hit) {
          skippedComplexFilter += 1;

          if (!skippedComplexDedup.has(complexName) && skippedComplexSamples.length < 60) {
            skippedComplexDedup.add(complexName);
            skippedComplexSamples.push(`${hit}|||${complexName}`);
          }
        }
      }

      const trade = normalizeTrade(row, fileName, index + 2);
      if (trade) trades.push(trade);
    });
  }

  return { sourceFiles: fileNames, rawRows, trades, skippedComplexFilter, skippedComplexSamples };
}

function groupTrades(trades: Trade[]) {
  const groups = new Map<string, Trade[]>();

  for (const trade of trades) {
    const key = `${trade.city}|${trade.roadName}|${trade.complexName}|${trade.areaM2}`;
    const existing = groups.get(key);
    if (existing) existing.push(trade);
    else groups.set(key, [trade]);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => b.dealDate.localeCompare(a.dealDate) || b.priceManwon - a.priceManwon);
  }

  return groups;
}

/** 동일 단지·동일 전용면적(㎡)마다 계약일이 가장 최신인 거래만 남김. 동일일자면 거래금액이 높은 쪽. */
function dedupeTradesLatestPerComplexArea(trades: Trade[]): { trades: Trade[]; dropped: number } {
  const bestByKey = new Map<string, Trade>();
  for (const trade of trades) {
    const key = `${trade.city}|${trade.roadName}|${trade.complexName}|${trade.areaM2}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, trade);
      continue;
    }
    const byDate = trade.dealDate.localeCompare(existing.dealDate);
    if (byDate > 0 || (byDate === 0 && trade.priceManwon > existing.priceManwon)) {
      bestByKey.set(key, trade);
    }
  }
  const out = [...bestByKey.values()];
  return { trades: out, dropped: trades.length - out.length };
}

async function readJsonCache<T>(fileName: string): Promise<Cache<T>> {
  try {
    const content = await readFile(path.join(CACHE_DIR, fileName), "utf8");
    return JSON.parse(content) as Cache<T>;
  } catch {
    return {};
  }
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isAllowedHouseholdClassification(classification: string) {
  if (HOUSEHOLD_ALLOWED_CLASSIFICATIONS.length === 0) return true;
  return HOUSEHOLD_ALLOWED_CLASSIFICATIONS.includes(classification);
}

function rowsToHouseholdEntries(rows: CsvRow[], source: string) {
  const entries: HouseholdEntry[] = [];
  for (const row of rows) {
    const complexName = getFirstValue(row, ["단지명", "아파트명", "공동주택명", "kaptName", "KAPT_NAME"]);
    const roadNameAddress = getFirstValue(row, [
      "도로명주소",
      "도로명 주소",
      "새주소",
      "주소",
      "kaptAddr",
      "KAPT_ADDR",
    ]);
    const lotAddress = getFirstValue(row, ["법정동주소", "지번주소", "구주소", "lotAddress"]);
    const householdsValue = getFirstValue(row, [
      "세대수",
      "총세대수",
      "세대 수",
      "전체세대수",
      "kaptdaCnt",
      "KAPTDA_CNT",
      "households",
    ]);
    const classification = getFirstValue(row, ["단지분류", "주택유형", "분류", "classification"]);
    const households = parseLooseNumber(householdsValue);

    if (!complexName || !Number.isFinite(households) || households <= 0) continue;
    if (classification && !isAllowedHouseholdClassification(classification)) continue;

    entries.push({
      complexName,
      roadNameAddress,
      lotAddress,
      households,
      classification,
      source,
    });
  }
  return entries;
}

async function readHouseholdEntries() {
  const entries: HouseholdEntry[] = [];

  try {
    const buffer = await readFile(HOUSEHOLDS_CSV_PATH);
    const utf8Content = buffer.toString("utf8");
    const content = utf8Content.includes("세대") ? utf8Content : iconv.decode(buffer, "cp949");
    const rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as CsvRow[];
    entries.push(...rowsToHouseholdEntries(rows, "data/households.csv"));
  } catch {
    // Optional file.
  }

  try {
    const workbook = XLSX.readFile(HOUSEHOLDS_XLSX_PATH);
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<CsvRow>(workbook.Sheets[sheetName], {
        defval: "",
        raw: false,
      });
      entries.push(...rowsToHouseholdEntries(rows, path.basename(HOUSEHOLDS_XLSX_PATH)));
    }
  } catch {
    // Optional file.
  }

  return entries;
}

function buildHouseholdIndex(entries: HouseholdEntry[]) {
  const index = new Map<string, HouseholdEntry>();
  const addressIndex = new Map<string, HouseholdEntry>();
  const duplicateAddressKeys = new Set<string>();

  for (const entry of entries) {
    for (const compoundKey of householdCompoundKeysForHouseholdEntry(entry)) {
      if (!index.has(compoundKey)) index.set(compoundKey, entry);
    }

    const fragmentLines = [
      ...splitCommaAddressFragments(entry.roadNameAddress),
      ...splitCommaAddressFragments(entry.lotAddress),
    ].filter(Boolean);
    const uniqueFragments = [...new Set(fragmentLines)];

    for (const fragment of uniqueFragments) {
      const addressKey = householdAddressKey(fragment);
      if (!addressKey) continue;
      if (addressIndex.has(addressKey)) {
        duplicateAddressKeys.add(addressKey);
      } else {
        addressIndex.set(addressKey, entry);
      }
    }
  }

  for (const [key, entry] of addressIndex) {
    if (!duplicateAddressKeys.has(key) && !index.has(key)) {
      index.set(key, entry);
    }
  }

  return index;
}

function findHouseholdEntry(index: Map<string, HouseholdEntry>, complexName: string, city: string, road: string) {
  for (const compound of householdCompoundKeysForTrade(complexName, city, road)) {
    const found = index.get(compound);
    if (found) return found;
  }
  for (const candidate of tradeCityRoadCandidateLines(city, road)) {
    const byAddress = index.get(householdAddressKey(candidate));
    if (byAddress) return byAddress;
  }
  return null;
}

/** 단지 기본정보와 매칭·세대수 기준으로 실거래 행을 먼저 걸러 지오코딩·대중교통 API 호출량을 줄인다. */
function preprocessTradesWithHouseholds(
  trades: Trade[],
  householdIndex: Map<string, HouseholdEntry>,
  options: {
    householdFileLoaded: boolean;
    minHouseholds: number;
  },
) {
  const { householdFileLoaded, minHouseholds } = options;
  let droppedNoMatch = 0;
  let droppedBelowMin = 0;

  if (!householdFileLoaded) {
    if (minHouseholds > 0) {
      console.warn(
        "[preprocess] MIN_HOUSEHOLDS가 설정되어 있지만 단지·세대수 파일을 찾지 못했습니다. 세대수 전처리는 건너뜁니다.",
      );
    }
    console.log("[preprocess] 단지 DB 없음 → 실거래 전체를 다음 단계로 넘김");
    return { trades, droppedNoMatch: 0, droppedBelowMin: 0 };
  }

  const enforceMinHouseholds = minHouseholds > 0;
  const filtered: Trade[] = [];

  for (const trade of trades) {
    const householdEntry = findHouseholdEntry(householdIndex, trade.complexName, trade.city, trade.roadName);

    if (!householdEntry) {
      droppedNoMatch += 1;
      continue;
    }

    if (enforceMinHouseholds && householdEntry.households < minHouseholds) {
      droppedBelowMin += 1;
      continue;
    }

    filtered.push(trade);
  }

  console.log(
    `[preprocess] 단지 DB 매칭·세대수: 입력 ${trades.length.toLocaleString("ko-KR")}건 → 유지 ${filtered.length.toLocaleString("ko-KR")}건 (단지 불일치 제외 ${droppedNoMatch.toLocaleString("ko-KR")}건 · 세대 미만 제외 ${droppedBelowMin.toLocaleString("ko-KR")}건 · 최소 세대 ${minHouseholds > 0 ? minHouseholds.toLocaleString("ko-KR") : "설정 안 함"})`,
  );

  return { trades: filtered, droppedNoMatch, droppedBelowMin };
}

async function geocodeAddress(address: string): Promise<GeocodeCacheEntry | null> {
  if (!KAKAO_REST_API_KEY) return null;

  const url = new URL("https://dapi.kakao.com/v2/local/search/address.json");
  url.searchParams.set("query", address);

  const response = await fetchWithRetry(url, {
    headers: {
      Authorization: `KakaoAK ${KAKAO_REST_API_KEY}`,
    },
  }, "Kakao geocode");

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      [
        `Kakao geocode failed: ${response.status} ${response.statusText}`,
        detail ? `Response: ${detail}` : "",
        "Check that KAKAO_REST_API_KEY is the REST API key, not the JavaScript key.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const body = (await response.json()) as {
    documents?: Array<{ x: string; y: string; address_name: string }>;
  };
  const first = body.documents?.[0];
  if (!first) return null;

  return {
    lat: Number(first.y),
    lng: Number(first.x),
    matchedAddress: first.address_name,
  };
}

function getDepartureUnix() {
  if (process.env.TRANSIT_DEPARTURE_ISO) {
    return Math.floor(new Date(process.env.TRANSIT_DEPARTURE_ISO).getTime() / 1000);
  }

  const now = new Date();
  const next = new Date(now);
  next.setHours(10, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return Math.floor(next.getTime() / 1000);
}

async function fetchTransitMinutes(
  lat: number,
  lng: number,
  departureUnix: number,
): Promise<TransitCacheEntry | null> {
  if (!GOOGLE_MAPS_API_KEY) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", TRANSIT_ORIGIN_FOR_GOOGLE);
  url.searchParams.set("destinations", `${lat},${lng}`);
  url.searchParams.set("mode", "transit");
  url.searchParams.set("departure_time", String(departureUnix));
  url.searchParams.set("language", "ko");
  url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

  const response = await fetchWithRetry(url, undefined, "Google transit");
  if (!response.ok) {
    throw new Error(`Google transit failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as {
    rows?: Array<{ elements?: Array<{ status: string; duration?: { value: number; text: string } }> }>;
  };
  const element = body.rows?.[0]?.elements?.[0];
  if (!element?.duration) {
    return element ? { minutes: Number.POSITIVE_INFINITY, text: element.status, status: element.status, departureUnix } : null;
  }

  return {
    minutes: Math.ceil(element.duration.value / 60),
    text: element.duration.text,
    status: element.status,
    departureUnix,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

type PythonPreprocessSummary = {
  generatedAt?: string;
  rawRows?: number;
  skippedComplexFilterRows?: number;
  skippedComplexSamples?: string[];
  filteredRowsBeforeHousehold?: number;
  preprocessDroppedNoHouseholdMatch?: number;
  preprocessDroppedMinHouseholds?: number;
  filteredRowsFinal?: number;
  sourceCsvFiles?: string[];
  householdMerged?: boolean;
};

function tradeFromMergedPythonCsv(row: CsvRow): Trade {
  const hhRaw = row["households"]?.trim() ?? "";
  const parsedHh = hhRaw !== "" ? parseLooseNumber(hhRaw) : Number.NaN;
  const preloadHouseholds = Number.isFinite(parsedHh) && parsedHh > 0 ? parsedHh : undefined;

  const byRaw = row["builtYear"]?.trim();
  const builtNum = parseNumber(byRaw ?? undefined);
  const builtYear = Number.isFinite(builtNum) ? builtNum : null;

  const trade: Trade = {
    id: row["id"]?.trim() ?? stableId(JSON.stringify(row)),
    city: row["city"]?.trim() ?? "",
    roadName: row["roadName"]?.trim() ?? "",
    complexName: row["complexName"]?.trim() ?? "",
    areaM2: parseNumber(row["areaM2"]),
    dealDate: row["dealDate"]?.trim() ?? "",
    priceManwon: parseLooseNumber(row["priceManwon"]),
    building: row["building"]?.trim() ?? "-",
    floor: row["floor"]?.trim() ?? "-",
    builtYear,
    lotNumber: row["lotNumber"]?.trim() ?? "",
    tradeType: row["tradeType"]?.trim() ?? "",
    brokerageLocation: row["brokerageLocation"]?.trim() ?? "",
  };

  if (preloadHouseholds !== undefined) {
    trade.preloadHouseholds = preloadHouseholds;
    const src = row["householdsSource"]?.trim() ?? "";
    trade.preloadHouseholdSource = src !== "" ? src : "python_preprocess";
  }

  return trade;
}

async function tryLoadPythonPreprocessedMergedTrades(): Promise<null | {
  trades: Trade[];
  rawRows: number;
  skippedComplexFilter: number;
  skippedComplexSamples: string[];
  filteredRowsCsv: number;
  preprocessDroppedNoMatch: number;
  preprocessDroppedBelowMin: number;
  sourceFiles: string[];
  bundledHousehold: boolean;
}> {
  if (SKIP_PYTHON_MERGED_INPUT || !(await fileExists(PREPROCESSED_MERGED_CSV))) {
    return null;
  }

  let summaryParsed: PythonPreprocessSummary | null = null;
  if (await fileExists(PREPROCESSED_SUMMARY_JSON)) {
    try {
      summaryParsed = JSON.parse(await readFile(PREPROCESSED_SUMMARY_JSON, "utf8")) as PythonPreprocessSummary;
    } catch {
      summaryParsed = null;
    }
  }

  const csvContent = await readFile(PREPROCESSED_MERGED_CSV, "utf8");
  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as CsvRow[];

  const trades: Trade[] = rows.map(tradeFromMergedPythonCsv).filter((t) => t.city && t.roadName && t.complexName && t.dealDate);

  const bundledHousehold = Boolean(summaryParsed?.householdMerged);

  console.log(
    `[inputs] Python 병합 CSV 사용: ${path.relative(ROOT_DIR, PREPROCESSED_MERGED_CSV)} (${trades.length.toLocaleString(
      "ko-KR",
    )}건 입력)`,
  );
  if (summaryParsed?.generatedAt) console.log(`[inputs] preprocess-summary: ${summaryParsed.generatedAt}`);
  if (!bundledHousehold) {
    console.log(
      "[inputs] preprocess-summary 에 householdMerged=false → 단지 매칭·세대수는 Node 빌드에서 다시 적용합니다.",
    );
  }

  return {
    trades,
    rawRows: summaryParsed?.rawRows ?? trades.length,
    skippedComplexFilter: summaryParsed?.skippedComplexFilterRows ?? 0,
    skippedComplexSamples: summaryParsed?.skippedComplexSamples ?? [],
    filteredRowsCsv: summaryParsed?.filteredRowsBeforeHousehold ?? trades.length,
    preprocessDroppedNoMatch: summaryParsed?.preprocessDroppedNoHouseholdMatch ?? 0,
    preprocessDroppedBelowMin: summaryParsed?.preprocessDroppedMinHouseholds ?? 0,
    sourceFiles:
      summaryParsed?.sourceCsvFiles && summaryParsed.sourceCsvFiles.length > 0
        ? [...summaryParsed.sourceCsvFiles]
        : [path.relative(ROOT_DIR, PREPROCESSED_MERGED_CSV)],
    bundledHousehold,
  };
}

async function buildData() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(path.dirname(PUBLIC_DATA_PATH), { recursive: true });
  await mkdir(PREPROCESSED_DIR, { recursive: true });

  let rawRows = 0;
  let skippedComplexFilter = 0;
  let skippedComplexSamples: string[] = [];
  let sourceFiles: string[] = [];
  let tradesAfterHouseholdGate: Trade[] = [];
  let filteredRowsCsv = 0;
  let preprocessDroppedNoMatch = 0;
  let preprocessDroppedBelowMin = 0;

  let pythonMergedInputRelative: string | null = null;
  let householdEntries: HouseholdEntry[];
  let householdIndex: Map<string, HouseholdEntry>;
  let householdFileLoaded: boolean;

  const pyMergedArtifact = await tryLoadPythonPreprocessedMergedTrades();

  if (pyMergedArtifact) {
    pythonMergedInputRelative = path.relative(ROOT_DIR, PREPROCESSED_MERGED_CSV);
    rawRows = pyMergedArtifact.rawRows;
    skippedComplexFilter = pyMergedArtifact.skippedComplexFilter;
    skippedComplexSamples = pyMergedArtifact.skippedComplexSamples;
    filteredRowsCsv = pyMergedArtifact.filteredRowsCsv;

    sourceFiles = [...pyMergedArtifact.sourceFiles, path.relative(ROOT_DIR, PREPROCESSED_MERGED_CSV)].filter(
      (value, index, arr) => arr.indexOf(value) === index,
    );

    const pythonHouseholdComplete =
      pyMergedArtifact.bundledHousehold &&
      pyMergedArtifact.trades.length > 0 &&
      pyMergedArtifact.trades.every((t) => typeof t.preloadHouseholds === "number");

    if (pythonHouseholdComplete) {
      tradesAfterHouseholdGate = pyMergedArtifact.trades;
      preprocessDroppedNoMatch = pyMergedArtifact.preprocessDroppedNoMatch;
      preprocessDroppedBelowMin = pyMergedArtifact.preprocessDroppedBelowMin;
      householdEntries = [];
      householdIndex = new Map<string, HouseholdEntry>();
      householdFileLoaded = true;
      console.log(`[inputs] 세대수·단지 매칭은 병합 CSV에 포함되어 Node 전처리를 건너뜁니다.`);
    } else {
      householdEntries = await readHouseholdEntries();
      householdIndex = buildHouseholdIndex(householdEntries);
      const hhLoadedFlag = householdEntries.length > 0;
      householdFileLoaded = hhLoadedFlag;
      const rerun = preprocessTradesWithHouseholds(pyMergedArtifact.trades, householdIndex, {
        householdFileLoaded: hhLoadedFlag,
        minHouseholds: MIN_HOUSEHOLDS,
      });
      preprocessDroppedNoMatch = rerun.droppedNoMatch;
      preprocessDroppedBelowMin = rerun.droppedBelowMin;
      tradesAfterHouseholdGate = rerun.trades;
    }
  } else {
    const raw = await readCsvTrades();
    sourceFiles = raw.sourceFiles;
    rawRows = raw.rawRows;
    skippedComplexFilter = raw.skippedComplexFilter;
    skippedComplexSamples = raw.skippedComplexSamples;
    filteredRowsCsv = raw.trades.length;
    householdEntries = await readHouseholdEntries();
    householdIndex = buildHouseholdIndex(householdEntries);
    householdFileLoaded = householdEntries.length > 0;
    const rerun = preprocessTradesWithHouseholds(raw.trades, householdIndex, {
      householdFileLoaded,
      minHouseholds: MIN_HOUSEHOLDS,
    });
    tradesAfterHouseholdGate = rerun.trades;
    preprocessDroppedNoMatch = rerun.droppedNoMatch;
    preprocessDroppedBelowMin = rerun.droppedBelowMin;
  }

  const beforeAreaDedupe = tradesAfterHouseholdGate.length;
  const dedupLatest = dedupeTradesLatestPerComplexArea(tradesAfterHouseholdGate);
  tradesAfterHouseholdGate = dedupLatest.trades;
  const dedupeDroppedOlderSameComplexArea = dedupLatest.dropped;

  const groups = groupTrades(tradesAfterHouseholdGate);

  const shouldApplyHouseholdFilter = MIN_HOUSEHOLDS > 0 && householdFileLoaded;
  const geocodeCache = await readJsonCache<GeocodeCacheEntry>("geocode.json");
  const transitCache = await readJsonCache<TransitCacheEntry>("transit-google.json");
  const departureUnix = getDepartureUnix();
  const apartments: Apartment[] = [];
  const geocodeMissing: string[] = [];
  const transitMissing: string[] = [];
  const startedAt = Date.now();
  const counters = {
    processed: 0,
    geocodeCacheHits: 0,
    geocodeApiCalls: 0,
    transitCacheHits: 0,
    transitApiCalls: 0,
    overTransitLimit: 0,
  };

  console.log(`[start] CSV rows: ${rawRows.toLocaleString("ko-KR")}`);
  console.log(`[complex-filter] Mode: ${FILTER_COMPLEX_MODE}`);
  console.log(`[complex-filter] Skipped CSV rows before other filters: ${skippedComplexFilter.toLocaleString("ko-KR")}`);
  console.log(`[filter] 거래건 (단지 매칭·세대선별 전 · 가격/면적/지역 적용 후): ${filteredRowsCsv.toLocaleString("ko-KR")}`);
  console.log(`[filter] 거래건 (단지 매칭·세대선별 후): ${beforeAreaDedupe.toLocaleString("ko-KR")}`);
  if (dedupeDroppedOlderSameComplexArea > 0) {
    console.log(
      `[dedupe] 동일 단지·동일 ㎡ 에서 과거 거래 제외: ${dedupeDroppedOlderSameComplexArea.toLocaleString("ko-KR")}건 → 거래건 ${tradesAfterHouseholdGate.length.toLocaleString("ko-KR")}건`,
    );
  }
  console.log(`[group] 단지·㎡(평형) 그룹 수 · 지오코딩·대중교통 검사 대상: ${groups.size.toLocaleString("ko-KR")}`);
  console.log(`[households] entries loaded: ${householdEntries.length.toLocaleString("ko-KR")}`);
  console.log(`[households] allowed classifications: ${HOUSEHOLD_ALLOWED_CLASSIFICATIONS.join(", ") || "all"}`);
  console.log(
    `[households] min filter: ${
      shouldApplyHouseholdFilter ? `${MIN_HOUSEHOLDS.toLocaleString("ko-KR")}+` : "off"
    }`,
  );
  if (MIN_HOUSEHOLDS > 0 && !householdFileLoaded) {
    console.warn(
      "[households] MIN_HOUSEHOLDS가 설정되어 있지만 단지·세대수 파일을 찾지 못했습니다. 세대수 필터가 적용되지 않습니다.",
    );
  }
  console.log(`[cache] Geocode: ${Object.keys(geocodeCache).length.toLocaleString("ko-KR")}, Transit: ${Object.keys(transitCache).length.toLocaleString("ko-KR")}`);
  console.log(`[criteria] ${TRANSIT_ORIGIN} transit <= ${MAX_TRANSIT_MINUTES} minutes`);

  const logProgress = (force = false) => {
    if (!force && counters.processed % LOG_EVERY_GROUPS !== 0) return;

    const percent = ((counters.processed / groups.size) * 100).toFixed(1);
    console.log(
      [
        `[progress] ${counters.processed.toLocaleString("ko-KR")}/${groups.size.toLocaleString("ko-KR")} (${percent}%)`,
        `elapsed=${formatElapsed(startedAt)}`,
        `shown=${apartments.length.toLocaleString("ko-KR")}`,
        `geo cache/api/missing=${counters.geocodeCacheHits}/${counters.geocodeApiCalls}/${geocodeMissing.length}`,
        `transit cache/api/missing/over=${counters.transitCacheHits}/${counters.transitApiCalls}/${transitMissing.length}/${counters.overTransitLimit}`,
      ].join(" | "),
    );
  };

  for (const [groupKey, group] of groups) {
    counters.processed += 1;
    const latestTrade = group[0];
    const address = `${latestTrade.city} ${latestTrade.roadName}`;
    const householdEntry = findHouseholdEntry(householdIndex, latestTrade.complexName, latestTrade.city, latestTrade.roadName);
    const preloadOk =
      typeof latestTrade.preloadHouseholds === "number" && Number.isFinite(latestTrade.preloadHouseholds);
    const households = preloadOk ? latestTrade.preloadHouseholds! : householdEntry?.households ?? null;
    const householdsSourceResolved = preloadOk
      ? latestTrade.preloadHouseholdSource !== undefined &&
        latestTrade.preloadHouseholdSource !== null &&
        latestTrade.preloadHouseholdSource !== ""
        ? latestTrade.preloadHouseholdSource
        : "python_preprocess"
      : householdEntry?.source ?? null;

    const geocodeKey = stableId(address);
    let geocode = geocodeCache[geocodeKey];

    if (geocode) counters.geocodeCacheHits += 1;

    if (!geocode && !DRY_RUN) {
      counters.geocodeApiCalls += 1;
      let fetchedGeocode: GeocodeCacheEntry | null = null;
      try {
        fetchedGeocode = await geocodeAddress(address);
      } catch (error) {
        if (shouldFailFast(error)) throw error;
        console.warn(`[warn] Geocode skipped: ${address} (${error instanceof Error ? error.message : String(error)})`);
      }
      if (fetchedGeocode) {
        geocode = fetchedGeocode;
        geocodeCache[geocodeKey] = fetchedGeocode;
        await sleep(120);
      }
    }

    if (!geocode) {
      geocodeMissing.push(address);
      logProgress();
      if (counters.processed % CACHE_SAVE_EVERY_GROUPS === 0) {
        await writeJson(path.join(CACHE_DIR, "geocode.json"), geocodeCache);
        await writeJson(path.join(CACHE_DIR, "transit-google.json"), transitCache);
      }
      continue;
    }

    const transitKey = stableId(`${groupKey}|${geocode.lat}|${geocode.lng}|${departureUnix}`);
    let transit = transitCache[transitKey];

    if (transit) counters.transitCacheHits += 1;

    if (!transit && !DRY_RUN) {
      counters.transitApiCalls += 1;
      let fetchedTransit: TransitCacheEntry | null = null;
      try {
        fetchedTransit = await fetchTransitMinutes(geocode.lat, geocode.lng, departureUnix);
      } catch (error) {
        if (shouldFailFast(error)) throw error;
        console.warn(`[warn] Transit skipped: ${address} (${error instanceof Error ? error.message : String(error)})`);
      }
      if (fetchedTransit) {
        transit = fetchedTransit;
        transitCache[transitKey] = fetchedTransit;
        await sleep(120);
      }
    }

    if (!transit || !Number.isFinite(transit.minutes)) {
      transitMissing.push(address);
      logProgress();
      if (counters.processed % CACHE_SAVE_EVERY_GROUPS === 0) {
        await writeJson(path.join(CACHE_DIR, "geocode.json"), geocodeCache);
        await writeJson(path.join(CACHE_DIR, "transit-google.json"), transitCache);
      }
      continue;
    }

    if (transit.minutes > MAX_TRANSIT_MINUTES) {
      counters.overTransitLimit += 1;
      logProgress();
      if (counters.processed % CACHE_SAVE_EVERY_GROUPS === 0) {
        await writeJson(path.join(CACHE_DIR, "geocode.json"), geocodeCache);
        await writeJson(path.join(CACHE_DIR, "transit-google.json"), transitCache);
      }
      continue;
    }

    apartments.push({
      id: stableId(groupKey),
      complexName: latestTrade.complexName,
      address,
      city: latestTrade.city,
      roadName: latestTrade.roadName,
      builtYear: latestTrade.builtYear,
      households,
      householdsSource: householdsSourceResolved,
      lat: geocode.lat,
      lng: geocode.lng,
      transitMinutes: transit.minutes,
      transitText: transit.text,
      latestTrade,
      recentTrades: group.slice(0, 30),
    });

    logProgress();
    if (counters.processed % CACHE_SAVE_EVERY_GROUPS === 0) {
      await writeJson(path.join(CACHE_DIR, "geocode.json"), geocodeCache);
      await writeJson(path.join(CACHE_DIR, "transit-google.json"), transitCache);
    }
  }

  logProgress(true);

  apartments.sort((a, b) => a.transitMinutes - b.transitMinutes || b.latestTrade.dealDate.localeCompare(a.latestTrade.dealDate));

  const output: DataFile = {
    generatedAt: new Date().toISOString(),
    sourceFiles,
    criteria: {
      maxPriceManwon: MAX_PRICE_MANWON,
      minAreaM2: MIN_AREA_M2,
      transitOrigin: TRANSIT_ORIGIN,
      maxTransitMinutes: MAX_TRANSIT_MINUTES,
      departureLabel: "평일 오전 10시",
      householdFileLoaded,
      householdMatchRequired: householdFileLoaded,
      complexNameFilter: {
        mode: FILTER_COMPLEX_MODE,
        appliedKeywords: excludedComplexKeywordsForMode(FILTER_COMPLEX_MODE),
        officetelOnlyKeywords: excludedComplexKeywordsForMode("officetel_only"),
        officetelAndVillaKeywords: excludedComplexKeywordsForMode("officetel_and_villa"),
      },
      minHouseholds: shouldApplyHouseholdFilter ? MIN_HOUSEHOLDS : 0,
      householdAllowedClassifications: HOUSEHOLD_ALLOWED_CLASSIFICATIONS,
      pythonMergedCsv: pythonMergedInputRelative,
    },
    summary: {
      rawRows,
      filteredRowsCsv,
      preprocessDroppedNoHouseholdMatch: preprocessDroppedNoMatch,
      preprocessDroppedMinHouseholds: preprocessDroppedBelowMin,
      filteredRows: tradesAfterHouseholdGate.length,
      skippedComplexFilter,
      skippedComplexSamples,
      apartmentsBeforeTransit: groups.size,
      apartments: apartments.length,
      geocodeMissing: geocodeMissing.length,
      transitMissing: transitMissing.length,
      skippedTransitOverOneHour: counters.overTransitLimit,
      dedupeDroppedOlderSameComplexArea,
    },
    apartments,
  };

  await writeJson(PUBLIC_DATA_PATH, output);
  await writeJson(path.join(CACHE_DIR, "geocode.json"), geocodeCache);
  await writeJson(path.join(CACHE_DIR, "transit-google.json"), transitCache);
  await writeJson(path.join(REPORT_DIR, "geocode-missing.json"), geocodeMissing);
  await writeJson(path.join(REPORT_DIR, "transit-missing.json"), transitMissing);

  console.log(JSON.stringify(output.summary, null, 2));
  if (!KAKAO_REST_API_KEY) console.warn("KAKAO_REST_API_KEY is missing. Geocoding was skipped.");
  if (!GOOGLE_MAPS_API_KEY) console.warn("GOOGLE_MAPS_API_KEY is missing. Transit filtering was skipped.");
}

buildData().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
