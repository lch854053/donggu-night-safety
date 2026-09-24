"""Supplement NGII road labels and planning road grades without replacing their geometry.

After import-roads.py and import-sidewalks.py, run with VWORLD_DATA_API_KEY set, then
run npm run score-roads. Only unambiguous, executed planning grades affect the
road-activity proxy; unexecuted designations are display-only.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import urlopen

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
ROAD_PATH = ROOT / "scripts/data/road-segments.geojson"
META_PATH = ROOT / "public/data/vworld-roads-meta.json"
BOUNDARY_PATH = ROOT / "scripts/data/donggu-admin-boundaries.geojson"
ROAD_NAMES = "LT_L_SPRD"
PLANNING_ROADS = "LT_C_UPISUQ151"
GENERATED_NAME = re.compile(r" 도로 [0-9a-f]{6}-\d+$")
NAME_MATCH_METERS = 5
NAME_COVERAGE = 0.8
ROAD_GRADES = frozenset(("소로", "중로", "대로", "광로"))


def fetch_layer(layer, bbox, key, domain, get_json=None):
    """Fetch every page, rejecting partial/empty results before modifying files."""
    if get_json is None:
        def get_json(url):
            with urlopen(url, timeout=60) as response:
                return json.load(response)

    features = []
    total = None
    for page in range(1, 101):
        params = {
            "service": "data", "request": "GetFeature", "data": layer,
            "key": key, "domain": domain, "format": "json", "size": "1000",
            "page": str(page), "geometry": "true", "attribute": "true",
            "geomFilter": "BOX(" + ",".join(str(v) for v in bbox) + ")", "crs": "EPSG:4326",
        }
        url = "https://api.vworld.kr/req/data?" + urlencode(params)
        for attempt in range(3):
            try:
                result = get_json(url)["response"]
                break
            except (OSError, ValueError, KeyError):
                if attempt == 2:
                    raise RuntimeError(f"VWorld {layer} {page}페이지 조회 실패 — 기존 데이터 보존") from None
                time.sleep(2 * (attempt + 1))
        if result.get("status") != "OK":
            raise RuntimeError(f"VWorld {layer} 응답 오류: {result.get('error', {}).get('code', result.get('status'))}")
        count = int(result["record"]["total"])
        if count <= 0 or (total is not None and count != total):
            raise RuntimeError(f"VWorld {layer} 원본이 비었거나 페이지 사이 총건수가 변경됨")
        total = count
        page_features = result["result"]["featureCollection"]["features"]
        if not page_features:
            raise RuntimeError(f"VWorld {layer} {page}페이지가 비어 있음")
        features.extend(page_features)
        if len(features) >= total:
            break
    if len(features) != total or len({f["id"] for f in features}) != total:
        raise RuntimeError(f"VWorld {layer} 누락/중복 응답 {len(features)}/{total}")
    return features


def within_boundary(features, boundary, to_meters):
    """Return source features and geometries clipped to the administrative boundary."""
    selected = []
    for feature in features:
        geometry = shape(feature["geometry"])
        if not geometry.is_valid:
            raise ValueError(f"Invalid VWorld geometry: {feature['id']}")
        clipped = transform(to_meters, geometry).intersection(boundary)
        if not clipped.is_empty and (clipped.area > 0 if "POLYGON" in geometry.geom_type.upper() else clipped.length > 0):
            selected.append((feature, clipped))
    return selected


def enrich_names(roads, named_lines, to_meters):
    """Name only generated-label roads with exactly one >=80%-length match within 5m."""
    geometries = [g for _, g in named_lines]
    names = [f["properties"]["rn"].strip() for f, _ in named_lines]
    if not geometries or any(not name for name in names):
        raise ValueError("VWorld 도로명 선형이나 도로명 속성이 비었습니다")
    tree = STRtree(geometries)
    counts = Counter()
    for road in roads["features"]:
        props = road["properties"]
        if props.get("roadNameSource") == ROAD_NAMES:
            props["name"] = props.pop("fallbackName")
            del props["roadNameSource"]
        if not GENERATED_NAME.search(props["name"]):
            continue
        line = transform(to_meters, shape(road["geometry"]))
        groups = defaultdict(list)
        for index in tree.query(line.buffer(NAME_MATCH_METERS)):
            geometry = geometries[index]
            if line.distance(geometry) <= NAME_MATCH_METERS:
                groups[names[index]].append(geometry)
        matched = [name for name, parts in groups.items()
                   if line.intersection(unary_union([part.buffer(NAME_MATCH_METERS) for part in parts])).length
                   / line.length >= NAME_COVERAGE]
        if len(matched) == 1:
            props["fallbackName"] = props["name"]
            props["name"] = matched[0]
            props["roadNameSource"] = ROAD_NAMES
            counts["renamed"] += 1
        elif len(matched) > 1:
            counts["ambiguous"] += 1
        else:
            counts["unmatched"] += 1
    return counts


def enrich_grades(roads, planning, to_meters):
    """Match a single planning designation covering >=80% of each centerline.

    A designation is only score-eligible if its grade is recognized and its
    execution status is complete. Matched unexecuted designations remain
    explicitly marked as unscored in the UI.
    """
    geometries = [geometry for _, geometry in planning]
    tree = STRtree(geometries)
    counts = Counter()
    grade_status = Counter()
    for road in roads["features"]:
        properties = road["properties"]
        for key in ("planningRoadName", "planningRoadGrade", "planningRoadStatus"):
            properties.pop(key, None)
        line = transform(to_meters, shape(road["geometry"]))
        groups = defaultdict(list)
        for index in tree.query(line):
            geometry = geometries[index]
            if geometry.intersects(line):
                item = planning[index][0]["properties"]
                groups[(item.get("dgm_nm") or "", item.get("grad_se") or "",
                        item.get("exc_nam") or "미확인")].append(geometry)
        matches = [designation for designation, parts in groups.items()
                   if line.intersection(unary_union(parts)).length / line.length >= NAME_COVERAGE]
        if len(matches) == 1:
            name, grade, status = matches[0]
            if grade in ROAD_GRADES:
                properties["planningRoadName"] = name or grade
                properties["planningRoadGrade"] = grade
                properties["planningRoadStatus"] = status
                counts["matched"] += 1
                grade_status[(grade, status)] += 1
                if status == "집행완료":
                    counts["scored"] += 1
            else:
                counts["unclassified"] += 1
        elif len(matches) > 1:
            counts["ambiguous"] += 1
        else:
            counts["unmatched"] += 1
    return counts, grade_status


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", default=os.environ.get("VWORLD_DOMAIN") or "donggu-night-safety.vercel.app")
    args = parser.parse_args()
    key = (os.environ.get("VWORLD_DATA_API_KEY") or os.environ.get("VWORLD_API_KEY") or "").strip()
    if not key:
        parser.error("VWORLD_DATA_API_KEY 또는 VWORLD_API_KEY 환경변수가 필요합니다")
    boundary_data = json.loads(BOUNDARY_PATH.read_text())
    boundary_wgs84 = unary_union([shape(f["geometry"]) for f in boundary_data["features"]])
    to_meters = Transformer.from_crs(4326, 5179, always_xy=True).transform
    boundary = transform(to_meters, boundary_wgs84)
    if not 40e6 < boundary.area < 60e6:
        raise ValueError("동구 경계 범위가 예상과 다릅니다")
    minx, miny, maxx, maxy = boundary_wgs84.bounds
    bbox = [round(v, 3) for v in (minx - .001, miny - .001, maxx + .001, maxy + .001)]

    named = fetch_layer(ROAD_NAMES, bbox, key, args.domain)
    planned = fetch_layer(PLANNING_ROADS, bbox, key, args.domain)
    names_inside = within_boundary(named, boundary, to_meters)
    planning_inside = within_boundary(planned, boundary, to_meters)
    if not names_inside or not planning_inside:
        raise ValueError("동구 안 VWorld 도로 자료가 0건입니다 — 기존 데이터 보존")
    roads = json.loads(ROAD_PATH.read_text())
    if len(roads["features"]) < 1000:
        raise ValueError("도로구간 입력이 비정상적으로 적습니다 — 기존 데이터 보존")
    matches = enrich_names(roads, names_inside, to_meters)
    grade_matches, grade_status = enrich_grades(roads, planning_inside, to_meters)
    metadata = {
        "source": "VWorld 2D 데이터 API 2.0", "fetchedAt": datetime.now(timezone.utc).date().isoformat(),
        "requestBBox": bbox, "roadNamesLayer": ROAD_NAMES, "planningLayer": PLANNING_ROADS,
        "sourceRows": {ROAD_NAMES: len(named), PLANNING_ROADS: len(planned)},
        "insideBoundary": {ROAD_NAMES: len(names_inside), PLANNING_ROADS: len(planning_inside)},
        "nameMatchMeters": NAME_MATCH_METERS, "nameCoverageThreshold": NAME_COVERAGE,
        "renamedRoadSegments": matches["renamed"], "ambiguousRoadSegments": matches["ambiguous"],
        "unmatchedGeneratedNames": matches["unmatched"],
        "planningGradeMatchedRoadSegments": grade_matches["matched"],
        "planningGradeScoredRoadSegments": grade_matches["scored"],
        "planningGradeAmbiguousRoadSegments": grade_matches["ambiguous"],
        "planningGradeUnclassifiedRoadSegments": grade_matches["unclassified"],
        "planningGradeStatusCounts": {f"{grade}/{status}": count for (grade, status), count in grade_status.items()},
        "planningStatusCounts": dict(Counter(feature["properties"].get("exc_nam") or "미확인"
                                             for feature, _ in planning_inside)),
        "notes": ["NGII 도로의 형상·폭원·인도 속성은 유지하며, 도로명·검증된 계획상 규모만 보강",
                  "계획상 규모는 단일 지정이 도로 길이 80% 이상 겹치고 집행완료일 때만 폭원 proxy와 혼합",
                  "미집행·부분집행·미확인 규모는 위치 참고용이며 실제 통행량·인도 유무를 뜻하지 않음"],
    }
    write_json(ROAD_PATH, roads)
    write_json(META_PATH, metadata)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
