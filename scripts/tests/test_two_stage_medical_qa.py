import unittest

from scripts.two_stage_medical_qa import INCORRECT, SUSPICIOUS


class MedicalQATests(unittest.TestCase):
    def test_frozen_adjudication_count(self):
        self.assertEqual(len(INCORRECT), 28)

    def test_suspicious_fragments_are_detected(self):
        for label in ("this", "considered confirmed", "most appropriate treatment"):
            self.assertIsNotNone(SUSPICIOUS.search(label))


if __name__ == "__main__":
    unittest.main()
