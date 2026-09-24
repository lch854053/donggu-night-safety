import importlib.util
import json
from pathlib import Path
import unittest

from shapely.geometry import LineString, Polygon

spec = importlib.util.spec_from_file_location("enrich_vworld_roads", Path(__file__).with_name("enrich_vworld_roads.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def road(name, y=0):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, y], [40, y]]},
            "properties": {"id": f"road-{y}", "name": name, "widthMeters": 3, "pedestrianAccess": "yes"}}


def street(name, y=0):
    return ({"properties": {"rn": name}}, LineString([(0, y), (40, y)]))


class VWorldRoadTests(unittest.TestCase):
    def test_shipped_labels_and_road_grades_match_the_refresh_report(self):
        metadata = json.loads(module.META_PATH.read_text())
        roads = json.loads(module.ROAD_PATH.read_text())["features"]
        self.assertEqual(sum(r["properties"].get("roadNameSource") == module.ROAD_NAMES for r in roads),
                         metadata["renamedRoadSegments"])
        self.assertTrue(all(r["properties"].get("fallbackName") for r in roads
                            if r["properties"].get("roadNameSource") == module.ROAD_NAMES))
        self.assertEqual(sum(bool(r["properties"].get("planningRoadGrade")) for r in roads),
                         metadata["planningGradeMatchedRoadSegments"])
        self.assertEqual(sum(r["properties"].get("planningRoadStatus") == "집행완료" for r in roads),
                         metadata["planningGradeScoredRoadSegments"])
        self.assertTrue(all(r["properties"].get("planningRoadName") for r in roads
                            if r["properties"].get("planningRoadGrade")))

    def test_only_unambiguous_full_length_generated_labels_are_enriched(self):
        roads = {"features": [road("학운동 도로 abc123-1"), road("기존 도로명", 20),
                              road("지원동 도로 abc123-2", 30)]}
        counts = module.enrich_names(roads, [street("남문로")], lambda x, y: (x, y))
        self.assertEqual(counts["renamed"], 1)
        self.assertEqual(roads["features"][0]["properties"]["name"], "남문로")
        self.assertEqual(roads["features"][0]["properties"]["fallbackName"], "학운동 도로 abc123-1")
        self.assertEqual(roads["features"][0]["properties"]["widthMeters"], 3)
        self.assertEqual(roads["features"][1]["properties"]["name"], "기존 도로명")
        self.assertEqual(roads["features"][2]["properties"]["name"], "지원동 도로 abc123-2")
        module.enrich_names(roads, [street("남문로")], lambda x, y: (x, y))
        self.assertEqual(roads["features"][0]["properties"]["name"], "남문로")

    def test_crossing_and_multiple_full_matches_do_not_invent_a_name(self):
        roads = {"features": [road("학운동 도로 abc123-1")]}
        crossing = ({"properties": {"rn": "교차로"}}, LineString([(20, -20), (20, 20)]))
        counts = module.enrich_names(roads, [crossing], lambda x, y: (x, y))
        self.assertEqual(counts["unmatched"], 1)
        counts = module.enrich_names(roads, [street("남문로"), street("백서로", 1)], lambda x, y: (x, y))
        self.assertEqual(counts["ambiguous"], 1)
        self.assertNotIn("roadNameSource", roads["features"][0]["properties"])

    def test_missing_match_restores_original_label_on_refresh(self):
        roads = {"features": [road("학운동 도로 abc123-1")]}
        module.enrich_names(roads, [street("남문로")], lambda x, y: (x, y))
        module.enrich_names(roads, [street("동명로", 20)], lambda x, y: (x, y))
        self.assertEqual(roads["features"][0]["properties"]["name"], "학운동 도로 abc123-1")
        self.assertNotIn("fallbackName", roads["features"][0]["properties"])

    def test_api_requires_all_pages_and_nonempty_data(self):
        def broken(url):
            return {"response": {"status": "OK", "record": {"total": "1001"},
                                 "result": {"featureCollection": {"features": ([{"id": str(i)} for i in range(1000)]
                                                                            if "page=1" in url else [])}}}}
        with self.assertRaisesRegex(RuntimeError, "페이지가 비어"):
            module.fetch_layer("LT_L_SPRD", [0, 0, 1, 1], "key", "domain", broken)
        with self.assertRaisesRegex(RuntimeError, "비었거나"):
            module.fetch_layer("LT_L_SPRD", [0, 0, 1, 1], "key", "domain",
                               lambda url: {"response": {"status": "OK", "record": {"total": "0"}}})

    def test_api_paginates_without_losing_or_duplicating_features(self):
        def reply(url):
            first = "page=1" in url
            self.assertIn("geomFilter=BOX", url)
            self.assertIn("domain=registered.example", url)
            return {"response": {"status": "OK", "record": {"total": "1001"},
                                 "result": {"featureCollection": {"features":
                                     [{"id": str(i)} for i in range(1000)] if first else [{"id": "1000"}]}}}}
        self.assertEqual(len(module.fetch_layer("LT_L_SPRD", [0, 0, 1, 1], "key", "registered.example", reply)), 1001)

    def test_only_single_completed_planning_grade_is_eligible_for_scoring(self):
        polygon = Polygon([(0, -2), (40, -2), (40, 2), (0, 2)])
        def planning(name, grade, status, geometry=polygon):
            return ({"properties": {"dgm_nm": name, "grad_se": grade, "exc_nam": status}}, geometry)
        roads = {"features": [road("동명로")]}
        matches, _ = module.enrich_grades(roads, [planning("소로3류", "소로", "미집행")], lambda x, y: (x, y))
        self.assertEqual(matches["matched"], 1)
        self.assertEqual(matches["scored"], 0)
        self.assertEqual(roads["features"][0]["properties"]["planningRoadStatus"], "미집행")
        matches, _ = module.enrich_grades(roads, [planning("중로2류", "중로", "집행완료")], lambda x, y: (x, y))
        self.assertEqual(matches["scored"], 1)
        self.assertEqual(roads["features"][0]["properties"]["planningRoadGrade"], "중로")
        matches, _ = module.enrich_grades(roads, [planning("중로2류", "중로", "집행완료"),
                                                 planning("소로3류", "소로", "집행완료")], lambda x, y: (x, y))
        self.assertEqual(matches["ambiguous"], 1)
        self.assertNotIn("planningRoadGrade", roads["features"][0]["properties"])

    def test_short_crossing_and_unknown_scale_do_not_claim_road_kind(self):
        crossing = Polygon([(18, -2), (22, -2), (22, 2), (18, 2)])
        roads = {"features": [road("동명로")]}
        matches, _ = module.enrich_grades(roads, [({"properties": {"dgm_nm": "대로1류",
                            "grad_se": "대로", "exc_nam": "집행완료"}}, crossing)], lambda x, y: (x, y))
        self.assertEqual(matches["unmatched"], 1)
        self.assertNotIn("planningRoadGrade", roads["features"][0]["properties"])
        wide = Polygon([(0, -2), (40, -2), (40, 2), (0, 2)])
        matches, _ = module.enrich_grades(roads, [({"properties": {"dgm_nm": "기타도로시설",
                            "grad_se": "", "exc_nam": "집행완료"}}, wide)], lambda x, y: (x, y))
        self.assertEqual(matches["unclassified"], 1)


if __name__ == "__main__":
    unittest.main()
