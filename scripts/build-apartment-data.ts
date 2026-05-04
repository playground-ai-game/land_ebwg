import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import iconv from "iconv-lite";

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
};

type Apartment = {
  id: string;
  complexName: string;
  address: string;
  city: string;
  roadName: string;
  builtYear: number | null;
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
  };
  summary: {
    rawRows: number;
    filteredRows: number;
    apartmentsBeforeTransit: number;
    apartments: number;
    geocodeMissing: number;
    transitMissing: number;
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

const ROOT_DIR = process.cwd();
config({ path: path.join(ROOT_DIR, ".env.local") });
config();

const DATA_DIR = path.join(ROOT_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const REPORT_DIR = path.join(DATA_DIR, "reports");
const PUBLIC_DATA_PATH = path.join(ROOT_DIR, "public", "data", "apartments.json");

const MAX_PRICE_MANWON = 110_000;
const MIN_AREA_M2 = 40;
const MAX_TRANSIT_MINUTES = 60;
const TRANSIT_ORIGIN = "강남역";
const TRANSIT_ORIGIN_FOR_GOOGLE = "Gangnam Station, Seoul, South Korea";
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DRY_RUN = process.argv.includes("--dry-run");
const LOG_EVERY_GROUPS = 50;
const CACHE_SAVE_EVERY_GROUPS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const trade = normalizeTrade(row, fileName, index + 2);
      if (trade) trades.push(trade);
    });
  }

  return { sourceFiles: fileNames, rawRows, trades };
}

function groupTrades(trades: Trade[]) {
  const groups = new Map<string, Trade[]>();

  for (const trade of trades) {
    const key = `${trade.city}|${trade.roadName}|${trade.complexName}`;
    const existing = groups.get(key);
    if (existing) existing.push(trade);
    else groups.set(key, [trade]);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => b.dealDate.localeCompare(a.dealDate) || b.priceManwon - a.priceManwon);
  }

  return groups;
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

async function buildData() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(path.dirname(PUBLIC_DATA_PATH), { recursive: true });

  const { sourceFiles, rawRows, trades } = await readCsvTrades();
  const groups = groupTrades(trades);
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
  console.log(`[filter] Eligible trades: ${trades.length.toLocaleString("ko-KR")}`);
  console.log(`[group] Apartments to check: ${groups.size.toLocaleString("ko-KR")}`);
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
    },
    summary: {
      rawRows,
      filteredRows: trades.length,
      apartmentsBeforeTransit: groups.size,
      apartments: apartments.length,
      geocodeMissing: geocodeMissing.length,
      transitMissing: transitMissing.length,
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
