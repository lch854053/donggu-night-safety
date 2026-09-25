"""Import NGII road centerlines; all topology/length operations use source meters."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET

import shapefile
from pyproj import CRS, Transformer
from shapely.geometry import LineString, shape
from shapely.ops import substring, transform, unary_union

ROOT = Path(__file__).resolve().parent.parent
BOUNDARY_URL = (
    "https://raw.githubusercontent.com/vuski/admdongkor/"
    "dd1881663fcabc69b81393604e91ebf3a4202e9a/"
    "ver20260701/HangJeongDong_ver20260701.geojson"
)
SOURCE = "국토지리정보원 연속수치지형도 도로중심선"
ATTRIBUTION = (
    "본 데이터는 통계청 통계지리정보서비스(SGIS, https://sgis.kostat.go.kr)에서 "
    "공공누리 제1유형으로 개방한 행정동 경계를 가공한 것이며"
    "(가공: vuski/admdongkor, https://github.com/vuski/admdongkor), CC BY 4.0으로 배포됩니다."
)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def line_parts(geometry):
    if geometry.geom_type == "LineString":
        if geometry.length > 0:
            yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from line_parts(part)


def merge_chains(edges):
    """Join only exact degree-2 endpoints with identical attributes, never snap gaps.

    Existing interior vertices block joins too, preserving T-junctions represented
    by an endpoint on another line. Crossings are not invented as routing nodes.
    """
    incident = defaultdict(list)
    interior = set()
    for i, edge in enumerate(edges):
        coords = list(edge["line"].coords)
        incident[coords[0]].append(i)
        incident[coords[-1]].append(i)
        interior.update(coords[1:-1])
    used = set()
    chains = []
    for i, edge in enumerate(edges):
        if i in used:
            continue
        used.add(i)
        coords = list(edge["line"].coords)
        ids = {edge["ufid"]}
        for _ in range(2):
            while coords[-1] not in interior and len(incident[coords[-1]]) == 2:
                candidates = [j for j in incident[coords[-1]] if j not in used]
                if len(candidates) != 1:
                    break
                j = candidates[0]
                other = edges[j]
                if other["attrs"] != edge["attrs"]:
                    break
                points = list(other["line"].coords)
                if points[-1] == coords[-1]:
                    points.reverse()
                if points[0] != coords[-1]:
                    raise ValueError("Endpoint mismatch")
                coords.extend(points[1:])
                ids.add(other["ufid"])
                used.add(j)
            coords.reverse()
        # Canonical direction makes segment IDs repeatable.
        if tuple(coords) > tuple(reversed(coords)):
            coords.reverse()
        chains.append({"line": LineString(coords), "attrs": edge["attrs"], "ids": sorted(ids)})
    return chains


def split_evenly(line, maximum):
    count = math.ceil(line.length / maximum)
    for i in range(count):
        yield substring(line, line.length * i / count, line.length * (i + 1) / count)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shp", type=Path, required=True)
    parser.add_argument("--max-length", type=float, default=50)
    args = parser.parse_args()
    if not math.isfinite(args.max_length) or args.max_length <= 0:
        parser.error("--max-length must be positive")
    crs = CRS.from_wkt(args.shp.with_suffix(".prj").read_text())
    if crs.to_epsg() != 5179:
        raise ValueError(f"Expected EPSG:5179; got {crs}")
    to_meters = Transformer.from_crs(4326, crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, 4326, always_xy=True).transform
    boundary_path = ROOT / "scripts/data/donggu-admin-boundaries.geojson"
    if boundary_path.exists():
        boundary_data = json.loads(boundary_path.read_text())
    else:
        with urllib.request.urlopen(BOUNDARY_URL, timeout=120) as response:
            all_boundaries = json.load(response)
        selected = [f for f in all_boundaries["features"]
                    if str(f["properties"].get("adm_cd2", "")).startswith("12210")]
        boundary_data = {"type": "FeatureCollection", "source": BOUNDARY_URL,
                         "attribution": ATTRIBUTION, "features": selected}
    if len(boundary_data["features"]) != 13:
        raise ValueError("Expected Dong-gu's 13 administrative dongs")
    dongs = [(f["properties"]["adm_nm"].split()[-1],
              transform(to_meters, shape(f["geometry"]))) for f in boundary_data["features"]]
    boundary = unary_union([g for _, g in dongs])
    if not boundary.is_valid or not 40e6 < boundary.area < 60e6:
        raise ValueError("Unexpected Dong-gu boundary geometry/area")
    reader = shapefile.Reader(str(args.shp), encoding="cp949")
    edges = []
    excluded = Counter()
    classes = Counter()
    # Keep every meaningful classification change as a chain break.
    fields = ("RDDV", "SCLS", "RDLN", "RVWD", "ONSD", "PVQT", "DVYN", "NAME", "RDNM", "REST")
    for item in reader.iterShapeRecords(bbox=boundary.bounds):
        record = item.record.as_dict()
        geometry = shape(item.shape.__geo_interface__)
        if not geometry.is_valid:
            raise ValueError(f"Invalid road {record['UFID']}")
        if not geometry.intersects(boundary):
            continue
        # RDD001 matches named expressways in the supplied source; retain raw
        # codes for other categories rather than infer pedestrian permission.
        if record["RDDV"] == "RDD001":
            excluded["expressway"] += 1
            continue
        classes[record["RDDV"]] += 1
        for line in line_parts(geometry.intersection(boundary)):
            edges.append({"line": line, "ufid": record["UFID"],
                          "attrs": tuple(record[f] for f in fields)})
    if not edges:
        raise ValueError("No roads in boundary")
    edges.sort(key=lambda e: (e["ufid"], e["line"].wkb_hex))
    chains = merge_chains(edges)
    # Preserve local demolition corrections when the older NGII shapefile is re-imported.
    retired = set(json.loads((ROOT / "config/retiredRoadSegments.json").read_text())["segmentIds"])
    features = []
    retired_length = 0
    for chain in chains:
        attrs = dict(zip(fields, chain["attrs"]))
        token = hashlib.sha256(("|".join(chain["ids"]) + chain["line"].wkb_hex).encode()).hexdigest()[:16]
        for index, segment in enumerate(split_evenly(chain["line"], args.max_length)):
            segment_id = f"ngii-{token}-{index + 1}"
            if segment_id in retired:
                retired_length += segment.length
                excluded["demolished_segments"] += 1
                continue
            midpoint = segment.interpolate(0.5, normalized=True)
            dong = next((name for name, polygon in dongs if polygon.covers(midpoint)), "동구")
            road_name = attrs["RDNM"] or attrs["NAME"]
            coordinates = [[round(x, 8), round(y, 8)]
                           for x, y in transform(to_wgs84, segment).coords]
            features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coordinates},
                             "properties": {"id": segment_id,
                                            "name": road_name or f"{dong} 도로 {token[:6]}-{index + 1}",
                                            "source": SOURCE, "sourceIds": chain["ids"],
                                            "adminDong": dong, "roadClass": attrs["RDDV"],
                                            "widthMeters": attrs["RVWD"], "lanes": attrs["RDLN"],
                                            "pedestrianAccess": "unverified"}})
    features.sort(key=lambda f: f["properties"]["id"])
    lengths = [shape(f["geometry"]).length for f in features]
    if not all(length > 0 for length in lengths):
        raise ValueError("Rounding collapsed a segment")
    original_length = sum(e["line"].length for e in edges)
    merged_length = sum(c["line"].length for c in chains)
    if abs(original_length - merged_length) > 0.001:
        raise ValueError("Merging changed total road length")
    xml_path = args.shp.with_suffix(".xml")
    metadata_date = ET.parse(xml_path).findtext(".//CreaDate") if xml_path.exists() else None
    report = {
        "source": SOURCE, "sourceFile": args.shp.name,
        "sourceSha256": {ext: hashlib.sha256(args.shp.with_suffix(ext).read_bytes()).hexdigest()
                         for ext in (".shp", ".dbf", ".prj")},
        "sourceCrs": "EPSG:5179", "outputCrs": "EPSG:4326",
        "sourceMetadataCreated": metadata_date, "sourceSurveyDate": None,
        "boundarySource": boundary_data["source"], "boundaryAsOf": "2026-07-01",
        "boundaryAreaKm2": round(boundary.area / 1e6, 3),
        "sourceRecords": len(reader),
        "matchedRecords": len({ufid for feature in features for ufid in feature["properties"]["sourceIds"]}),
        "clippedParts": len(edges), "mergedChains": len(chains), "segments": len(features),
        "totalLengthKm": round((original_length - retired_length) / 1000, 3), "maxSegmentMeters": args.max_length,
        "excluded": dict(excluded), "roadClasses": dict(classes),
        "routingReady": False,
        "notes": ["원본 XML 생성일은 도로 측량·갱신 기준일이 아님",
                  "정확히 일치하는 차수 2 끝점만 동일 속성일 때 병합; 틈새 스냅·입체교차 연결 없음",
                  "보행 가능 여부 미검증; 경로 안내용 네트워크가 아닌 도로별 참고지수 표시용"],
    }
    write_json(boundary_path, boundary_data)
    write_json(ROOT / "scripts/data/road-segments.geojson", {"type": "FeatureCollection", "features": features})
    write_json(ROOT / "public/data/roads-meta.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
