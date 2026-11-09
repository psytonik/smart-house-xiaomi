"""Cuts the mumbled "tail" the voice sometimes adds after the end of the phrase: a pause, then a burst of rumble or babble.

The speech is followed by a silence of at least MIN_GAP seconds, and whatever comes after that silence is not part of the phrase
(a real pause between words inside one short phrase is much shorter). The cut is made a little after the speech ends, with a fade.
"""
import numpy as np

FRAME = 0.02
MIN_GAP = 0.8
KEEP = 0.25  # seconds of the pause kept after the speech
FADE = 0.12


def trim_tail(audio, sr):
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    n = int(sr * FRAME)
    frames = len(x) // n
    if frames < 10:
        return x
    rms = np.sqrt(np.mean(x[: frames * n].reshape(frames, n) ** 2, axis=1))
    loud = np.percentile(rms, 95)
    if loud < 1e-4:
        return x
    quiet = rms < 0.15 * loud
    need = int(MIN_GAP / FRAME)
    i = 0
    seen_speech = False
    while i < frames:
        if not quiet[i]:
            seen_speech = True
            i += 1
            continue
        j = i
        while j < frames and quiet[j]:
            j += 1
        if seen_speech and j - i >= need and j < frames:  # a long silence with sound after it: that sound is the tail
            end = min(len(x), (i * n) + int(KEEP * sr))
            out = x[:end].copy()
            f = min(len(out), int(FADE * sr))
            out[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)
            return out
        i = j
    return x


HEAD_LOUD = 0.2  # a frame this loud (compared with the loud part of the phrase) is the speech; before it there is only hiss
HEAD_KEEP = 0.08  # seconds kept before it: words may start softly ("ф", "п"); the hiss in them is faded out, see below


def trim_head(audio, sr):
    """Cuts the hiss the voice makes before the first word (up to half a second of white noise), keeping HEAD_KEEP before the speech
    and fading in over all of it with a curve that stays near zero for most of that time (the hiss sits at -20...-28 dB and is heard
    when it is let through for 0.1 s), so a soft start of a word is not cut off but the hiss before it is not heard."""
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    n = int(sr * FRAME)
    frames = len(x) // n
    if frames < 10:
        return x
    rms = np.sqrt(np.mean(x[: frames * n].reshape(frames, n) ** 2, axis=1))
    loud = np.percentile(rms, 95)
    if loud < 1e-4:
        return x
    onset = int(np.argmax(rms >= HEAD_LOUD * loud))
    start = max(0, onset * n - int(HEAD_KEEP * sr))
    if start == 0:
        return x
    out = x[start:].copy()
    f = min(len(out), onset * n - start)
    out[:f] *= np.linspace(0.0, 1.0, f, dtype=np.float32) ** 2
    return out
