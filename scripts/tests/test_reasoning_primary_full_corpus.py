import unittest

from scripts.reasoning_primary_full_corpus import deterministic_negative, normalize_primary


class ReasoningPrimaryFullCorpusTests(unittest.TestCase):
    def test_explicit_negative_intent(self):
        for stem in (
            "Which statement is NOT true?", "All are true EXCEPT:",
            "Which finding is least likely?", "Choose the INCORRECT statement.",
            "Which of the following is false?",
            "Which finding would most likely not be observed?",
            "Under which principle will the doctor not be held responsible?",
        ):
            self.assertTrue(deterministic_negative(stem), stem)

    def test_incidental_not_is_not_negative(self):
        for stem in (
            "A fracture has not healed. What is the next step?",
            "Labor is not progressing. What is the diagnosis?",
            "Which program includes children not attending school?",
            "The vaccine is damaged if not refrigerated. Which is most susceptible?",
            "She is not taking medications. What explains these changes?",
        ):
            self.assertFalse(deterministic_negative(stem), stem)

    def test_safe_lexical_normalization_only(self):
        self.assertEqual(normalize_primary("Sickle-cell vaso-occlusive crisis"),
                         normalize_primary("Sickle cell vaso occlusive crisis"))
        self.assertNotEqual(normalize_primary("Carbon monoxide poisoning"),
                            normalize_primary("Cyanide poisoning"))


if __name__ == "__main__":
    unittest.main()
