import importlib.util
import json
from pathlib import Path
import unittest

from pyproj import Transformer
from shapely.geometry import LineString, shape
from shapely.ops import transform, unary_union

spec = importlib.util.spec_from_file_location("import_roads", Path(__file__).with_name("import-roads.py"))
roads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(roads)


def edge(coords, name="a", attrs=("same",)):
    return {"line": LineString(coords), "ufid": name, "attrs": attrs}


class ImportRoadTests(unittest.TestCase):
    def test_merge_preserves_length_and_source_ids_including_tiny_connectors(self):
        edges = [edge([(0, 0), (10, 0)]), edge([(10.1, 0), (10, 0)], "b"),
                 edge([(10.1, 0), (40, 0)], "c")]
        result = roads.merge_chains(edges)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["ids"], ["a", "b", "c"])
        self.assertAlmostEqual(result[0]["line"].length, 40)

    def test_junctions_attribute_changes_and_gaps_are_not_merged(self):
        examples = [
            [edge([(0, 0), (10, 0)]), edge([(10, 0), (20, 0)], "b"), edge([(10, 0), (10, 5)], "c")],
            [edge([(0, 0), (10, 0)]), edge([(10, 0), (20, 0)], "b", ("other",))],
            [edge([(0, 0), (10, 0)]), edge([(10.001, 0), (20, 0)], "b")],
            [edge([(0, 0), (10, 0)]), edge([(10, 0), (20, 0)], "b"),
             edge([(10, -5), (10, 0), (10, 5)], "c")],
        ]
        for edges in examples:
            self.assertEqual(len(roads.merge_chains(edges)), len(edges))

    def test_even_splitting_preserves_geometry_and_avoids_short_tail(self):
        line = LineString([(0, 0), (51, 0), (51, 51)])
        parts = list(roads.split_evenly(line, 50))
        self.assertEqual(len(parts), 3)
        self.assertTrue(all(abs(p.length - 34) < 1e-9 for p in parts))
        self.assertTrue(unary_union(parts).equals(line))

    def test_shipped_roads_are_inside_donggu_and_preserve_clipped_length(self):
        project = Path(__file__).resolve().parent.parent
        boundaries = json.loads((project / "scripts/data/donggu-admin-boundaries.geojson").read_text())
        data = json.loads((project / "scripts/data/road-segments.geojson").read_text())
        meta = json.loads((project / "public/data/roads-meta.json").read_text())
        project_to_meters = Transformer.from_crs(4326, 5179, always_xy=True).transform
        boundary = unary_union([transform(project_to_meters, shape(f["geometry"])) for f in boundaries["features"]])
        tolerance_boundary = boundary.buffer(0.005)  # WGS84 decimal rounding only
        total = 0
        source_ids = set()
        for feature in data["features"]:
            line = transform(project_to_meters, shape(feature["geometry"]))
            self.assertTrue(line.is_valid and not line.is_empty)
            self.assertTrue(tolerance_boundary.covers(line), feature["properties"]["id"])
            self.assertLessEqual(line.length, meta["maxSegmentMeters"] + 0.01)
            total += line.length
            source_ids.update(feature["properties"]["sourceIds"])
        self.assertLess(abs(total - meta["totalLengthKm"] * 1000), 2)
        self.assertEqual(len(source_ids), meta["matchedRecords"])


if __name__ == "__main__":
    unittest.main()
