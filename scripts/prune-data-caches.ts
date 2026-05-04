/**
 * public/data/apartments.json에 실제로 쓰이는 지오코드·교통 캐시 키만 남기고 나머지를 삭제합니다.
 * (파일 용량 줄이기용. 데이터 갱신 자체는 npm run data:build가 필요합니다.)
 *
 * 사용: npx tsx scripts/prune-data-caches.ts [--dry-run]
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";

const ROOT = process.cwd();
config({ path: path.join(ROOT, ".env.local") });
config();

const APARTMENTS_PATH = path.join(ROOT, "public", "data", "apartments.json");
const GEO_PATH = path.join(ROOT, "data", "cache", "geocode.json");
const TRANSIT_PATH = path.join(ROOT, "data", "cache", "transit-google.json");

type Apt = {
  city: string;
  roadName: string;
  complexName: string;
  lat: number;
  lng: number;
  latestTrade: { areaM2: number };
};
type DataFile = { apartments?: Apt[] };

function stableId(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 14);
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const apartmentsRaw = await readFile(APARTMENTS_PATH, "utf8");
  const data = JSON.parse(apartmentsRaw) as DataFile;
  const apartments = data.apartments ?? [];
  const departureUnix = getDepartureUnix();

  const geoKeys = new Set<string>();
  const transitKeys = new Set<string>();

  for (const apt of apartments) {
    geoKeys.add(stableId(`${apt.city} ${apt.roadName}`));
    const groupKey = `${apt.city}|${apt.roadName}|${apt.complexName}|${apt.latestTrade.areaM2}`;
    transitKeys.add(stableId(`${groupKey}|${apt.lat}|${apt.lng}|${departureUnix}`));
  }

  await mkdir(path.dirname(GEO_PATH), { recursive: true });

  const geoAll = JSON.parse(await readFile(GEO_PATH, "utf8")) as Record<string, unknown>;
  const geoPruned: Record<string, unknown> = {};
  for (const k of geoKeys) {
    if (k in geoAll) geoPruned[k] = geoAll[k];
  }

  const transitAll = JSON.parse(await readFile(TRANSIT_PATH, "utf8")) as Record<string, unknown>;
  const transitPruned: Record<string, unknown> = {};
  for (const k of transitKeys) {
    if (k in transitAll) transitPruned[k] = transitAll[k];
  }

  console.log(
    [
      `[prune-caches] apartments: ${apartments.length.toLocaleString("ko-KR")}개 기준`,
      `geocode ${Object.keys(geoAll).length.toLocaleString("ko-KR")} → ${Object.keys(geoPruned).length.toLocaleString("ko-KR")} 키`,
      `transit ${Object.keys(transitAll).length.toLocaleString("ko-KR")} → ${Object.keys(transitPruned).length.toLocaleString("ko-KR")} 키`,
      `교통 기준 departure_unix=${departureUnix} (.env의 TRANSIT_DEPARTURE_ISO와 data:build와 동일해야 재사용 가능)`,
    ].join("\n"),
  );

  const missingGeo = [...geoKeys].filter((k) => !(k in geoAll)).length;
  const missingTransit = [...transitKeys].filter((k) => !(k in transitAll)).length;
  if (missingGeo) console.warn(`[prune-caches] 경고: 지오코드 캐시에 없는 키 ${missingGeo}건 (다음 data:build에서 API 필요)`);
  if (missingTransit) console.warn(`[prune-caches] 경고: 교통 캐시에 없는 키 ${missingTransit}건 — departure 시각 또는 좌표/그룹키 불일치일 수 있음`);

  if (dryRun) {
    console.log("[prune-caches] --dry-run: 파일은 쓰지 않았습니다.");
    return;
  }

  await writeFile(GEO_PATH, `${JSON.stringify(geoPruned, null, 2)}\n`);
  await writeFile(TRANSIT_PATH, `${JSON.stringify(transitPruned, null, 2)}\n`);
  console.log("[prune-caches] geocode.json, transit-google.json 반영 완료");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
