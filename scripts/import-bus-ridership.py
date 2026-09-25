#!/usr/bin/env python3
"""Aggregate the municipal quarterly ZIP to average 20–23h boardings/alightings per stop/day.

The ZIP stays local; only per-stop summaries are published. A row is a grouped transaction,
so sum 거래건수 rather than counting CSV rows. Transfers are reported separately by the
source and are not added to boardings or alightings here.
"""

import argparse
import csv
import io
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEATURES = ROOT / "public/data/safety-features.geojson"
META = ROOT / "public/data/meta.json"
FIELDS = ("nightRidershipPeriod", "nightWeekdayBoarding", "nightWeekdayAlighting",
          "nightWeekendBoarding", "nightWeekendAlighting")


def aggregate(archive, stops):
    totals = defaultdict(Counter)
    dates = set()
    matched = Counter()
    conflicts = 0
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            if not re.fullmatch(r"20260[456]\d\d(?:-20260[456]\d\d)?\.csv", member):
                raise ValueError(f"예상하지 못한 ZIP 항목: {member}")
            with z.open(member) as stream:
                reader = csv.reader(io.TextIOWrapper(stream, encoding="cp949", newline=""))
                header = next(reader)
                if len(header) != 13 or header[:8] != ["거래일자", "요일", "시간", "버스ID", "노선코드", "노선명", "정류장번호", "정류장명"]:
                    raise ValueError(f"CSV 열 순서 오류: {member}")
                for row in reader:
                    if len(row) != 13 or not re.fullmatch(r"2026-(04|05|06)-\d\d", row[0]):
                        continue  # 재삽입된 헤더 및 구분선
                    day = date.fromisoformat(row[0])
                    dates.add(day)
                    if row[2].strip().zfill(2) not in ("20", "21", "22", "23") or row[9] not in ("승차", "하차"):
                        continue
                    stop = stops.get("KJB" + row[6].strip())
                    if stop is None:
                        continue
                    ars = stop.get("arsNumber")
                    if ars and row[8].strip() and str(ars) != row[8].strip():
                        conflicts += 1
                        continue
                    count = int(row[11])
                    if count < 0:
                        raise ValueError("음수 거래건수")
                    kind = "weekday" if day.weekday() < 5 else "weekend"
                    direction = "Boarding" if row[9] == "승차" else "Alighting"
                    totals[stop["id"]][kind + direction] += count
                    matched[stop["id"]] += count
    expected = {date.fromordinal(d) for d in range(date(2026, 4, 1).toordinal(), date(2026, 6, 30).toordinal() + 1)}
    if dates != expected:
        raise ValueError(f"승하차 자료의 날짜가 누락되거나 초과됐습니다: {len(dates)}/91")
    if conflicts or len(matched) < 100:
        raise ValueError(f"정류장 매칭 확인 필요: {len(matched)}개, ARS 불일치 {conflicts}행")
    days = Counter("weekday" if d.weekday() < 5 else "weekend" for d in dates)
    return totals, days, len(matched)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", required=True, type=Path, help="20260630 분기 승하차 ZIP")
    args = parser.parse_args()
    features = json.loads(FEATURES.read_text())
    buses = [f for f in features["features"] if f["properties"]["type"] == "bus_stop"]
    if not buses:
        raise ValueError("먼저 node scripts/fetch-real-data.mjs --only=bus를 실행하세요")
    stops = {f["properties"]["nodeId"]: f["properties"] for f in buses}
    totals, days, count = aggregate(args.zip, stops)
    for feature in buses:
        props = feature["properties"]
        for key in FIELDS:
            props.pop(key, None)
        sums = totals.get(props["id"])
        if sums:
            props.update(nightRidershipPeriod="2026-04-01~2026-06-30",
                         nightWeekdayBoarding=round(sums["weekdayBoarding"] / days["weekday"], 1),
                         nightWeekdayAlighting=round(sums["weekdayAlighting"] / days["weekday"], 1),
                         nightWeekendBoarding=round(sums["weekendBoarding"] / days["weekend"], 1),
                         nightWeekendAlighting=round(sums["weekendAlighting"] / days["weekend"], 1))
    meta = json.loads(META.read_text())
    meta["sources"]["bus_ridership"] = {
        "source": "전남광주통합특별시_시내버스 노선별 승하차 인원_20260630",
        "period": "2026-04-01~2026-06-30", "hours": "20:00–23:59",
        "weekdayDays": days["weekday"], "weekendDays": days["weekend"],
        "matchedStops": count, "excludedTransfers": True,
        "metric": "정류장별 1일 평균 거래건수(승차·하차 분리)",
    }
    FEATURES.write_text(json.dumps(features, ensure_ascii=False, separators=(",", ":")))
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    print(f"야간 승하차 집계: 정류장 {count}곳, 평일 {days['weekday']}일·주말 {days['weekend']}일")


if __name__ == "__main__":
    main()
