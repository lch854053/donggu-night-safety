import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("import_sidewalks", Path(__file__).with_name("import-sidewalks.py"))
sidewalks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidewalks)


class ClassifyAccessTests(unittest.TestCase):
    def test_thresholds_are_inclusive_boundaries(self):
        self.assertEqual(sidewalks.classify_access(0.8), "yes")
        self.assertEqual(sidewalks.classify_access(0.79), "partial")
        self.assertEqual(sidewalks.classify_access(0.3), "partial")
        self.assertEqual(sidewalks.classify_access(0.29), "no")
        self.assertEqual(sidewalks.classify_access(1.0), "yes")
        self.assertEqual(sidewalks.classify_access(0.0), "no")

    def test_custom_thresholds(self):
        self.assertEqual(sidewalks.classify_access(0.5, full=0.5, partial=0.4), "yes")
        self.assertEqual(sidewalks.classify_access(0.4, full=0.5, partial=0.4), "partial")

    def test_rejects_out_of_range_coverage(self):
        for value in (-0.1, 1.1, float("nan")):
            with self.assertRaises(ValueError):
                sidewalks.classify_access(value)


class MeanWidthTests(unittest.TestCase):
    def test_averages_only_measured_widths(self):
        self.assertEqual(sidewalks.mean_width([3, 2, 0, None]), 2.5)
        self.assertEqual(sidewalks.mean_width([2.25, 0]), 2.2)

    def test_all_unmeasured_yields_none(self):
        self.assertIsNone(sidewalks.mean_width([0, None]))
        self.assertIsNone(sidewalks.mean_width([]))


if __name__ == "__main__":
    unittest.main()
