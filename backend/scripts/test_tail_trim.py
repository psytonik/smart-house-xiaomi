"""Run: venv-mlx/bin/python -m unittest discover -s scripts -p 'test_*.py'"""
import unittest

import numpy as np

from tail_trim import trim_head, trim_tail

SR = 24000


def speech(seconds, amp=0.4):
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))).astype(np.float32)


def hiss(seconds, amp=0.03):
    return (amp * np.random.default_rng(1).standard_normal(int(SR * seconds))).astype(np.float32)


class TrimHead(unittest.TestCase):
    def test_cuts_the_hiss_before_the_first_word_but_keeps_the_speech(self):
        word = speech(1.5)
        out = trim_head(np.concatenate([hiss(0.6), word]), SR)
        # about HEAD_KEEP of the hiss is left, not 0.6 s
        self.assertLess(len(out), len(word) + int(0.2 * SR))
        self.assertGreater(len(out), len(word))
        np.testing.assert_allclose(out[-len(word) + 2000 :], word[2000:], atol=1e-6)  # the speech itself is untouched

    def test_fades_in(self):
        out = trim_head(np.concatenate([hiss(0.6), speech(1.5)]), SR)
        self.assertEqual(out[0], 0.0)

    def test_the_hiss_that_is_left_is_nearly_silent(self):
        noise = hiss(0.6, 0.03)
        out = trim_head(np.concatenate([noise, speech(1.5)]), SR)
        kept = out[: int(0.04 * SR)]  # the first half of what is kept before the word
        self.assertLess(np.sqrt(np.mean(kept**2)), 0.15 * np.sqrt(np.mean(noise**2)))  # at least 16 dB quieter than the hiss was

    def test_leaves_a_phrase_that_starts_at_once_alone(self):
        x = np.concatenate([hiss(0.05), speech(1.5)])
        np.testing.assert_array_equal(trim_head(x, SR), x)

    def test_is_idempotent(self):
        once = trim_head(np.concatenate([hiss(0.6), speech(1.5)]), SR)
        np.testing.assert_array_equal(trim_head(once, SR), once)

    def test_silence_and_tiny_input_are_returned_as_they_are(self):
        self.assertEqual(len(trim_head(np.zeros(SR), SR)), SR)
        self.assertEqual(len(trim_head(np.zeros(100, dtype=np.float32), SR)), 100)

    def test_works_together_with_the_tail_trim(self):
        x = np.concatenate([hiss(0.5), speech(1.0), np.zeros(int(1.0 * SR), dtype=np.float32), speech(0.5, 0.2)])
        out = trim_head(trim_tail(x, SR), SR)
        self.assertLess(len(out), len(x) - int(0.8 * SR))


if __name__ == "__main__":
    unittest.main()
