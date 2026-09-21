"""Enrich road segments with sidewalk access attributes from NGII sidewalk polylines.

Source shapefile: 국토지리정보원 연속수치지형도 보행로(인도) N3L_A0033320 계열.
안전디딤돌 IF_0095는 같은 데이터에서 좌표를 제거한 속성 API이므로 점수 계산에
쓸 수 없고, 도곽 단위 원본 파일을 연 1회 수동 교체하는 것을 전제로 한다.

사용:
  .venv/bin/python scripts/import-sidewalks.py --shp "/다운로드/N3L_A0033320.shp"

pipeline 순서: import-roads.py → import-sidewalks.py → score-roads.ts
(import-roads.py를 다시 실행하면 인도 속성이 지워지므로 본 스크립트를 재실행한다.)
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import LineString, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "국토지리정보원 연속수치지형도 보행로(인도)"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def classify_access(coverage, full=0.8, partial=0.3):
    """전체 길이 중 인도 반경 내에 덮인 비율로 인도 인접 등급을 분류한다."""
    if not math.isfinite(coverage) or coverage < 0 or coverage > 1:
        raise ValueError(f"coverage must be within [0, 1]; got {coverage}")
    if coverage >= full:
        return "yes"
    if coverage >= partial:
        return "partial"
    return "no"


def mean_width(widths):
    """측정된 폭원만 평균한다. WIDT=0(미측정)은 결측으로 제외한다."""
    measured = [w for w in widths if w and w > 0]
    if not measured:
        return None
    return round(sum(measured) / len(measured), 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shp", type=Path, required=True)
    parser.add_argument("--cover-radius", type=float, default=10,
                        help="구간 길이 대비 인도 덮임 비율을 재는 반경(미터)")
    parser.add_argument("--full-coverage", type=float, default=0.8)
    parser.add_argument("--partial-coverage", type=float, default=0.3)
    args = parser.parse_args()
    if not math.isfinite(args.cover_radius) or args.cover_radius <= 0:
        parser.error("--cover-radius must be positive")
    if not 0 <= args.partial_coverage <= args.full_coverage <= 1:
        parser.error("coverage thresholds must satisfy 0 <= partial <= full <= 1")
    crs = CRS.from_wkt(args.shp.with_suffix(".prj").read_text())
    if crs.to_epsg() != 5179:
        raise ValueError(f"Expected EPSG:5179; got {crs}")
    to_meters = Transformer.from_crs(4326, crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, 4326, always_xy=True).transform
    boundary_path = ROOT / "scripts/data/donggu-admin-boundaries.geojson"
    boundary_data = json.loads(boundary_path.read_text())
    if len(boundary_data["features"]) != 13:
        raise ValueError("Expected Dong-gu's 13 administrative dongs")
    boundary = unary_union([shape(f["geometry"]) for f in boundary_data["features"]])
    boundary = transform(to_meters, boundary)
    if not boundary.is_valid or not 40e6 < boundary.area < 60e6:
        raise ValueError("Unexpected Dong-gu boundary geometry/area")

    reader = shapefile.Reader(str(args.shp), encoding="cp949")
    lines, widths = [], []
    sidewalk_features = []
    matched = set()
    for item in reader.iterShapeRecords(bbox=boundary.bounds):
        record = item.record.as_dict()
        geometry = shape(item.shape.__geo_interface__)
        if not geometry.is_valid:
            raise ValueError(f"Invalid sidewalk {record['UFID']}")
        if not geometry.intersects(boundary):
            continue
        matched.add(record["UFID"])
        clipped = geometry.intersection(boundary)
        for part in clipped.geoms if hasattr(clipped, "geoms") else [clipped]:
            if part.geom_type == "LineString" and part.length > 0:
                lines.append(part)
                widths.append(record["WIDT"] or 0)
                # 산출물 보관용: 잘라낸 인도를 4326으로 재투영해 저장한다(지도 표시·재사용 대비).
                sidewalk_features.append(
                    {"type": "Feature",
                     "geometry": {"type": "LineString",
                                  "coordinates": [[round(x, 6), round(y, 6)]
                                                  for x, y in transform(to_wgs84, part).coords]},
                     "properties": {"ufid": record["UFID"], "kind": record["KIND"],
                                    "quality": record["QUAL"], "width": record["WIDT"] or None}})
    if not lines:
        raise ValueError("No sidewalks in boundary")
    sidewalk_features.sort(key=lambda f: (f["properties"]["ufid"], f["geometry"]["coordinates"][0]))
    write_json(ROOT / "scripts/data/donggu-sidewalks.geojson",
               {"type": "FeatureCollection", "features": sidewalk_features})

    roads_path = ROOT / "scripts/data/road-segments.geojson"
    roads = json.loads(roads_path.read_text())
    tree = STRtree(lines)
    distribution = Counter()
    access_km = Counter()
    width_sources = 0
    for feature in roads["features"]:
        segment = transform(to_meters, shape(feature["geometry"]))
        candidates = tree.query(segment.buffer(args.cover_radius))
        nearby = [lines[i] for i in candidates]
        if nearby:
            covered = unary_union([line.buffer(args.cover_radius) for line in nearby])
            coverage = segment.intersection(covered).length / segment.length
        else:
            coverage = 0.0
        access = classify_access(coverage, args.full_coverage, args.partial_coverage)
        distribution[access] += 1
        access_km[access] += segment.length / 1000
        properties = feature["properties"]
        properties["pedestrianAccess"] = access
        properties["sidewalkWidthMeters"] = mean_width(
            [widths[i] for i in candidates]) if nearby else None
        if properties["sidewalkWidthMeters"] is not None:
            width_sources += 1
    write_json(roads_path, roads)

    xml_path = args.shp.with_suffix(".xml")
    metadata_date = ET.parse(xml_path).findtext(".//CreaDate") if xml_path.exists() else None
    total_km = sum(access_km.values())
    report = {
        "source": SOURCE, "sourceFile": args.shp.name,
        "sourceSha256": {ext: hashlib.sha256(args.shp.with_suffix(ext).read_bytes()).hexdigest()
                         for ext in (".shp", ".dbf", ".prj")},
        "sourceCrs": "EPSG:5179", "outputCrs": "EPSG:4326",
        "sourceMetadataCreated": metadata_date, "sourceSurveyDate": None,
        "sourceRecords": len(reader), "matchedRecords": len(matched),
        "clippedParts": len(sidewalk_features),
        "coverRadiusMeters": args.cover_radius,
        "coverageThresholds": {"full": args.full_coverage, "partial": args.partial_coverage},
        "access": {key: distribution.get(key, 0) for key in ("yes", "partial", "no")},
        "accessKm": {key: round(access_km.get(key, 0), 3) for key in ("yes", "partial", "no")},
        "totalLengthKm": round(total_km, 3),
        "segmentsWithMeasuredWidth": width_sources,
        "notes": ["원본 XML 생성일은 인도 측량·갱신 기준일이 아님",
                  "인도 미커버 구간은 실제 부재와 지형도 미작성이 섞여 있어 감점은 보수적으로 -3점",
                  "안전디딤돌 IF_0095는 본 원본의 무좌표 속성 API라 미사용"],
    }
    write_json(ROOT / "public/data/sidewalks-meta.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
