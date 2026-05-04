#!/usr/bin/env python3
"""
실거래 CSV 여러 파일 + 단지 세대수(XLSX/선택 CSV)를 합친 후
data/preprocessed/trades-with-households.csv 한 파일로 출력합니다.

TypeScript 빌드(data:build)는 이 파일이 있으면 루트 CSV 전체 재스캔·매칭을 건너뜁니다.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re as std_re
import sys
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import regex as re
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent

MAX_PRICE_MANWON = 110_000
MIN_AREA_M2 = 40


def compact_text(value: str) -> str:
    v = std_re.sub(r"\([^)]*\)", "", value)
    return re.sub(r"[^\p{Letter}\p{Number}]", "", v).lower()


def normalize_household_complex_name(raw: str) -> str:
    name = std_re.sub(r"\([^)]*\)", "", raw).strip()
    previous = None
    while previous != name:
        previous = name
        name = re.sub(r"(?:단지|아파트)\s*$", "", name).strip()
    return name


def household_complex_compact(raw_complex: str) -> str:
    return compact_text(normalize_household_complex_name(raw_complex))


def split_comma_fragments(raw: str) -> list[str]:
    return list(dict.fromkeys([s.strip() for s in raw.split(",") if s.strip()]))


def trade_city_road_candidate_lines(si_gun_gu: str, road: str) -> list[str]:
    lines: set[str] = set()
    tr = road.strip()
    lines.add(f"{si_gun_gu.strip()} {tr}".strip())
    tok = si_gun_gu.strip().split()
    if len(tok) >= 3 and tok[-1].endswith("동"):
        lines.add(f"{' '.join(tok[:-1])} {tr}".strip())
    return list(lines)


def household_compound_lookup_keys(raw_complex: str, addr_segment: str) -> list[str]:
    name_part = household_complex_compact(raw_complex)
    address_part = normalize_address_for_match(addr_segment.strip())
    return [f"{address_part}|{name_part}"] if name_part and address_part else []


def household_compound_keys_trade(complex_name: str, city: str, road: str) -> list[str]:
    keys: list[str] = []
    seen: set[str] = set()
    for candidate in trade_city_road_candidate_lines(city, road):
        for compound in household_compound_lookup_keys(complex_name, candidate):
            if compound not in seen:
                seen.add(compound)
                keys.append(compound)
    return keys


def normalize_address_for_match(value: str) -> str:
    addr = compact_text(value)
    if addr.startswith("서울특별시"):
        addr = "서울" + addr[len("서울특별시") :]
    elif addr.startswith("경기도"):
        addr = "경기" + addr[len("경기도") :]
    return addr


def household_address_key(addr: str) -> str:
    na = normalize_address_for_match(addr)
    return f"addr:{na}" if na else ""


def stable_id_parts(*parts: str) -> str:
    h = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()
    return h[:14]


def parse_keyword_list(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return []
    return [kw.strip() for kw in raw.split(",") if kw.strip()]


def normalize_complex_filter_mode(raw: str | None) -> str:
    mode = (raw or "").strip()
    if mode in ("", "officetel_only"):
        return "officetel_only"
    if mode in ("none", "off"):
        return "none"
    if mode in ("officetel_and_villa", "villa_strict", "strict"):
        return "officetel_and_villa"
    sys.exit(
        f'FILTER_COMPLEX_MODE must be none, officetel_only, or officetel_and_villa. Got "{raw}".',
    )


def excluded_keywords(mode: str, extra: list[str]) -> list[str]:
    off = ["오피스텔", "근린생활", "근린생활시설", "근린형"]
    villa = ["(주택)", "주택)", "(주택", "(다세대", "도시형생활주택", "다세대", "연립", "빌라", "주상복합"]
    if mode == "none":
        return []
    if mode == "officetel_only":
        dedup = list(dict.fromkeys(off + extra).keys())
    else:
        dedup = list(dict.fromkeys(off + villa + extra).keys())
    return sorted(dedup, key=len, reverse=True)


def keyword_hit(name: str, keywords: Iterable[str]) -> str:
    for kw in keywords:
        if kw and kw in name:
            return kw
    return ""


def should_exclude_complex_name(name: str, mode: str, extra_kw: list[str]) -> str:
    kws = excluded_keywords(mode, extra_kw)
    return keyword_hit(name, kws)


def normalize_date(ym: str | None, d: str | None) -> str:
    ym = (ym or "").strip()
    d = ((d or "").strip()).zfill(2)
    if len(ym) != 6 or len(d) != 2:
        return ""
    return f"{ym[:4]}-{ym[4:6]}-{d}"


def is_cancelled(row: dict[str, str]) -> bool:
    value = (row.get("해제사유발생일") or "").strip()
    return bool(value and value != "-")


def row_get(row: dict[str, Any], *, keys: tuple[str, ...]) -> str:
    for key in keys:
        v = row.get(key)
        if pd.isna(v):
            continue
        s = str(v).strip()
        if s:
            return s
    return ""


def read_trade_frames(root: Path) -> list[tuple[str, pd.DataFrame]]:
    names = sorted(p.name for p in root.glob("*.csv"))
    frames: list[tuple[str, pd.DataFrame]] = []
    for name in names:
        path = root / name
        last_err: Exception | None = None
        decoded = False
        for encoding in ("utf-8-sig", "utf-8", "cp949"):
            try:
                df = pd.read_csv(path, dtype=str, encoding=encoding, keep_default_na=False)
                if "시군구" not in df.columns:
                    last_err = ValueError("열 '시군구' 없음 — 아파트 실거래 CSV가 아닐 수 있습니다.")
                    break
                frames.append((name, df))
                decoded = True
                break
            except UnicodeDecodeError as exc:
                last_err = exc
                continue
            except Exception as exc:
                last_err = exc
                break
        if not decoded and last_err is not None:
            print(f"[warn] skipped csv: {name} ({last_err})", file=sys.stderr)
    return frames


@dataclass
class HouseholdEntry:
    complex_name: str
    road_name_address: str
    lot_address: str
    households: int
    classification: str
    source: str


def household_compound_keys_entry(entry: HouseholdEntry) -> list[str]:
    compound_keys: list[str] = []
    seen_keys: set[str] = set()
    fragments = split_comma_fragments(entry.road_name_address or "")
    fragments.extend(split_comma_fragments(entry.lot_address or ""))
    for fragment in dict.fromkeys(fragments):
        for compound in household_compound_lookup_keys(entry.complex_name, fragment):
            if compound not in seen_keys:
                seen_keys.add(compound)
                compound_keys.append(compound)
    return compound_keys


def households_from_sheet_rows(rows: list[dict[str, Any]], source: str, allowed_classification: frozenset[str] | None) -> list[HouseholdEntry]:
    out: list[HouseholdEntry] = []
    for row in rows:
        cn = row_get(row, keys=("단지명", "아파트명", "공동주택명", "kaptName", "KAPT_NAME"))
        rn = row_get(
            row,
            keys=(
                "도로명주소",
                "도로명 주소",
                "새주소",
                "주소",
                "kaptAddr",
                "KAPT_ADDR",
            ),
        )
        jal = row_get(row, keys=("법정동주소", "지번주소", "구주소", "lotAddress"))
        hraw = row_get(
            row,
            keys=(
                "세대수",
                "총세대수",
                "세대 수",
                "전체세대수",
                "kaptdaCnt",
                "KAPTDA_CNT",
                "households",
            ),
        )
        clf = row_get(row, keys=("단지분류", "주택유형", "분류", "classification"))
        try:
            hv = float(str(hraw).replace(",", "").strip())
        except ValueError:
            continue
        if not cn or hv <= 0 or hv != int(hv):
            continue
        hi = int(hv)
        if allowed_classification is not None and clf and clf not in allowed_classification:
            continue
        out.append(HouseholdEntry(cn, rn, jal, hi, clf, source))
    return out


def load_household_entries(
    xlsx_path: Path,
    csv_path: Path | None,
    allowed_classification: frozenset[str] | None,
) -> list[HouseholdEntry]:
    entries: list[HouseholdEntry] = []
    if csv_path and csv_path.is_file():
        for enc in ("utf-8-sig", "utf-8", "cp949"):
            try:
                df = pd.read_csv(csv_path, dtype=str, encoding=enc, keep_default_na=False)
                rows = df.to_dict(orient="records")
                entries.extend(households_from_sheet_rows(rows, "data/households.csv", allowed_classification))
                break
            except UnicodeDecodeError:
                continue

    if xlsx_path.is_file():
        xf = pd.ExcelFile(xlsx_path)
        for sheet in xf.sheet_names:
            df = pd.read_excel(xf, sheet_name=sheet, dtype=str)
            df = df.fillna("")
            rows = df.to_dict(orient="records")
            entries.extend(
                households_from_sheet_rows(rows, xlsx_path.name, allowed_classification),
            )
    return entries


def build_household_index(entries: list[HouseholdEntry]) -> dict[str, HouseholdEntry]:
    idx: dict[str, HouseholdEntry] = {}
    address_idx: dict[str, HouseholdEntry] = {}
    duplicate_addr: set[str] = set()

    for e in entries:
        for compound_key in household_compound_keys_entry(e):
            if compound_key not in idx:
                idx[compound_key] = e

        fragment_lines = split_comma_fragments(e.road_name_address or "")
        fragment_lines.extend(split_comma_fragments(e.lot_address or ""))
        for fragment in dict.fromkeys(fragment_lines):
            if not fragment:
                continue
            ak = household_address_key(fragment)
            if not ak:
                continue
            if ak in address_idx:
                duplicate_addr.add(ak)
            else:
                address_idx[ak] = e

    for ak, entry_addr in address_idx.items():
        if ak not in duplicate_addr and ak not in idx:
            idx[ak] = entry_addr

    return idx


def find_household_entry(index: dict[str, HouseholdEntry], complex_name: str, city: str, road: str) -> HouseholdEntry | None:
    for compound_key in household_compound_keys_trade(complex_name, city, road):
        hit = index.get(compound_key)
        if hit is not None:
            return hit
    for candidate_line in trade_city_road_candidate_lines(city, road):
        addr_fallback = household_address_key(candidate_line)
        if addr_fallback and addr_fallback in index:
            return index[addr_fallback]
    return None


def dedupe_latest_per_complex_area(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], int]:
    """동일 (시군구·도로명·단지명·전용㎡)에서는 계약일 최신 거래만 유지. 동일 일자면 거래금액이 높은 쪽."""
    best_by_key: dict[str, dict[str, str]] = {}
    for r in rows:
        key = f'{r["city"]}|{r["roadName"]}|{r["complexName"]}|{r["areaM2"]}'
        prev = best_by_key.get(key)
        if prev is None:
            best_by_key[key] = dict(r)
            continue
        d_prev, d_cur = prev["dealDate"], r["dealDate"]
        p_prev, p_cur = int(prev["priceManwon"]), int(r["priceManwon"])
        if d_cur > d_prev or (d_cur == d_prev and p_cur > p_prev):
            best_by_key[key] = dict(r)

    merged = list(best_by_key.values())
    return merged, len(rows) - len(merged)


def main() -> None:
    load_dotenv(ROOT_DIR / ".env.local")
    load_dotenv(ROOT_DIR / ".env")

    filter_mode = normalize_complex_filter_mode(os.environ.get("FILTER_COMPLEX_MODE"))
    extra_kw = parse_keyword_list(os.environ.get("FILTER_COMPLEX_EXCLUDE_KEYWORDS"))
    min_hh = int(os.environ.get("MIN_HOUSEHOLDS") or "0")

    if "HOUSEHOLD_ALLOWED_CLASSIFICATIONS" in os.environ:
        clf_source = os.environ["HOUSEHOLD_ALLOWED_CLASSIFICATIONS"]
    else:
        clf_source = "아파트"
    clf_parts = parse_keyword_list(clf_source)
    allowed_clf: frozenset[str] | None = None if not clf_parts else frozenset(clf_parts)

    out_dir = ROOT_DIR / "data" / "preprocessed"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_csv = out_dir / "trades-with-households.csv"
    out_summary = out_dir / "preprocess-summary.json"

    xlsx_path = ROOT_DIR / "20260501_단지_기본정보.xlsx"
    hh_csv_opt = ROOT_DIR / "data" / "households.csv"

    entries = load_household_entries(xlsx_path, hh_csv_opt if hh_csv_opt.is_file() else None, allowed_clf)
    hh_index = build_household_index(entries)
    household_loaded = len(entries) > 0

    frames = read_trade_frames(ROOT_DIR)
    raw_rows = 0
    skipped_complex_rows = 0
    skipped_samples: dict[str, str] = {}

    csv_filtered: list[tuple[str, int, dict[str, str]]] = []

    for file_name, df in frames:
        raw_rows += len(df)

        records = df.to_dict(orient="records")
        for i, raw in enumerate(records):
            row = {str(k): ("" if pd.isna(v) else str(v)) for k, v in raw.items()}

            city = (row.get("시군구") or "").strip()
            road = (row.get("도로명") or "").strip()
            complex_name = (row.get("단지명") or "").strip()

            if complex_name and filter_mode != "none":
                hit = should_exclude_complex_name(complex_name, filter_mode, extra_kw)
                if hit:
                    skipped_complex_rows += 1
                    if len(skipped_samples) < 60 and complex_name not in skipped_samples:
                        skipped_samples[f"{hit}|||{complex_name}"] = complex_name

            try:
                area_m2 = float(str(row.get("전용면적(㎡)", "")).strip())
            except ValueError:
                area_m2 = float("nan")
            try:
                price = float(str(row.get("거래금액(만원)", "")).replace(",", "").strip())
            except ValueError:
                price = float("nan")

            deal = normalize_date(row.get("계약년월"), row.get("계약일"))

            if not city or not road or not complex_name or not deal:
                continue
            if filter_mode != "none":
                if should_exclude_complex_name(complex_name, filter_mode, extra_kw):
                    continue
            if not (city.startswith("서울특별시") or city.startswith("경기도")):
                continue
            if is_cancelled(row):
                continue
            if area_m2 != area_m2 or area_m2 < MIN_AREA_M2:
                continue
            if price != price or price > MAX_PRICE_MANWON:
                continue

            try:
                byear_f = float(str(row.get("건축년도", "")).strip())
                built_year = int(byear_f) if byear_f == byear_f else ""
            except ValueError:
                built_year = ""

            excel_row = i + 2
            tid = stable_id_parts(
                file_name,
                str(excel_row),
                city,
                road,
                complex_name,
                deal,
                str(area_m2),
                str(price),
            )

            csv_filtered.append(
                (
                    file_name,
                    excel_row,
                    {
                        "id": tid,
                        "city": city,
                        "roadName": road,
                        "complexName": complex_name,
                        "areaM2": str(area_m2),
                        "dealDate": deal,
                        "priceManwon": str(int(price)),
                        "building": (row.get("동") or "-").strip() or "-",
                        "floor": (row.get("층") or "-").strip() or "-",
                        "builtYear": str(built_year) if built_year != "" else "",
                        "lotNumber": (row.get("번지") or "").strip(),
                        "tradeType": (row.get("거래유형") or "").strip(),
                        "brokerageLocation": (row.get("중개사소재지") or "").strip(),
                        "_sourceCsv": file_name,
                        "_excelRow": str(excel_row),
                    },
                )
            )

    before_household = len(csv_filtered)

    filtered_out: list[dict[str, str]] = []
    dropped_no_match = 0
    dropped_below_min = 0

    if not household_loaded:
        if min_hh > 0:
            print(
                "[warn] MIN_HOUSEHOLDS 설정됨 단, 단지 세대수 파일 없음 → 전처리 결과에 세대수 없이 거래만 씁니다.",
                file=sys.stderr,
            )
        for _, _, rdict in csv_filtered:
            rr = dict(rdict)
            rr["households"] = ""
            rr["householdsSource"] = ""
            rr["householdClassification"] = ""
            filtered_out.append(rr)
    else:
        enforce_min = min_hh > 0
        for _, _, rd in csv_filtered:
            he = find_household_entry(hh_index, rd["complexName"], rd["city"], rd["roadName"])
            if he is None:
                dropped_no_match += 1
                continue
            if enforce_min and he.households < min_hh:
                dropped_below_min += 1
                continue

            rr = dict(rd)
            rr["households"] = str(he.households)
            rr["householdsSource"] = he.source
            rr["householdClassification"] = he.classification or ""
            filtered_out.append(rr)

    rows_before_area_dedupe = len(filtered_out)
    filtered_out, dedupe_same_complex_area_drop = dedupe_latest_per_complex_area(filtered_out)
    if dedupe_same_complex_area_drop:
        print(
            f"[dedupe] 단지·㎡ 동일 구거래 제외: {dedupe_same_complex_area_drop:,}건 → {len(filtered_out):,}건 유지",
            file=sys.stderr,
        )

    fieldnames = [
        "id",
        "city",
        "roadName",
        "complexName",
        "areaM2",
        "dealDate",
        "priceManwon",
        "building",
        "floor",
        "builtYear",
        "lotNumber",
        "tradeType",
        "brokerageLocation",
        "_sourceCsv",
        "_excelRow",
        "households",
        "householdsSource",
        "householdClassification",
    ]

    with out_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for rr in filtered_out:
            writer.writerow(rr)

    summary = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sourceCsvFiles": [n for n, _ in frames],
        "householdIndexSize": len(entries),
        "householdSources": [hh_csv_opt.name if hh_csv_opt.is_file() else None, xlsx_path.name if xlsx_path.is_file() else None],
        "rawRows": raw_rows,
        "skippedComplexFilterRows": skipped_complex_rows,
        "skippedComplexSamples": list(skipped_samples.keys())[:60],
        "filteredRowsBeforeHousehold": before_household,
        "preprocessDroppedNoHouseholdMatch": dropped_no_match,
        "preprocessDroppedMinHouseholds": dropped_below_min,
        "filteredRowsBeforeAreaDedupe": rows_before_area_dedupe,
        "dedupeDroppedOlderSameComplexArea": dedupe_same_complex_area_drop,
        "filteredRowsFinal": len(filtered_out),
        "householdMerged": household_loaded,
        "criteria": {
            "FILTER_COMPLEX_MODE": filter_mode,
            "MIN_HOUSEHOLDS": min_hh,
            "HOUSEHOLD_ALLOWED_CLASSIFICATIONS": list(allowed_clf) if allowed_clf is not None else "all",
        },
        "outputCsv": str(out_csv.relative_to(ROOT_DIR)),
    }

    with out_summary.open("w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"[done] wrote {out_csv.relative_to(ROOT_DIR)} ({len(filtered_out):,} rows)")
    print(f"[done] summary {out_summary.relative_to(ROOT_DIR)}")


if __name__ == "__main__":
    main()
