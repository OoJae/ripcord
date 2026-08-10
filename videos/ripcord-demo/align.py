"""Align the VO script's sections to the real waveform.

Whisper's transcript is the ground truth for TIMING; the script is the ground
truth for TEXT. Match each script section's word sequence into the transcript
by normalized tokens, then emit exact scene in/out points.
"""

import json
import re
import sys

SECTIONS = [
    ("01-number", "Every DeFi loan has one number that matters"),
    ("02-leak", "Most liquidations aren't lightning strikes"),
    ("03-watching", "Watching is not protection"),
    ("04-actor", "Ripcord is the part that acts"),
    ("05-slid", "On the 1st of August a real position"),  # whisper writes digits
    ("06-pull", "Ripcord read the chain Drafted a defense"),
    ("07-stats", "21 seconds from sensing the danger"),  # whisper writes digits
    ("08-onchain", "That transaction is on Base"),
    ("09-sense", "Here's how it works A sensor reads the position"),
    ("10-argue", "A planner proposes exactly one action"),
    ("11-guard", "Then the Guard 14 deterministic rules"),  # whisper writes digits
    ("12-modes", "And you choose how much rope it gets"),
    ("13-panic", "Except in panic An unreachable owner"),
    ("14-market", "Ripcord also sells its own risk engine"),
    ("15-close", "322 tests Every"),  # whisper writes digits; the VO speaks them
]

norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())

words = json.load(open("transcript.json"))
toks = [norm(w["text"]) for w in words]


def find(seq, start_at):
    """Anchor on the section's FIRST word, then score the rest of the phrase.

    Anchoring matters: a purely fuzzy window can score 5/5 while starting two
    words into the previous sentence, which would cut every scene in early.
    """
    target = [norm(t) for t in seq.split() if norm(t)]
    head = target[0]
    best, best_score, best_span = None, -1, 10**9
    for i in range(start_at, len(toks)):
        # the candidate must actually BE the section's first word
        if not (toks[i] == head or (len(head) > 3 and head in toks[i]) or (len(toks[i]) > 3 and toks[i] in head)):
            continue
        score, j = 1, i + 1
        for t in target[1:]:
            for k in range(j, min(j + 3, len(toks))):
                if toks[k] == t or (len(t) > 3 and t in toks[k]) or (len(toks[k]) > 3 and toks[k] in t):
                    score += 1
                    j = k + 1
                    break
        span = j - i
        # Prefer the tightest span at equal score: a repeated common head word
        # ("on ... On the 1st of August") otherwise wins simply by being first,
        # dragging the scene start back into the previous sentence.
        if score > best_score or (score == best_score and span < best_span):
            best_score, best, best_span = score, i, span
    return best, best_score, len(target)


cursor, scenes = 0, []
for sid, anchor in SECTIONS:
    idx, score, total = find(anchor, cursor)
    if idx is None or score < max(2, total * 0.5):
        print(f"!! could not place {sid} (score {score}/{total})", file=sys.stderr)
        sys.exit(1)
    scenes.append({"id": sid, "wordIndex": idx, "start": words[idx]["start"], "match": f"{score}/{total}"})
    cursor = idx + 1

# Each scene runs until the next one begins; the last runs to the end of speech.
AUDIO_END = 140.136
for i, s in enumerate(scenes):
    s["end"] = round(scenes[i + 1]["start"], 3) if i + 1 < len(scenes) else AUDIO_END
    s["dur"] = round(s["end"] - s["start"], 3)
    s["start"] = round(s["start"], 3)

json.dump(scenes, open("scenes.json", "w"), indent=2)
print(f"{'id':<12}{'start':>8}{'end':>9}{'dur':>8}   match   first words")
for s in scenes:
    txt = " ".join(w["text"] for w in words[s["wordIndex"] : s["wordIndex"] + 6])
    print(f"{s['id']:<12}{s['start']:>8.2f}{s['end']:>9.2f}{s['dur']:>8.2f}   {s['match']:>6}   {txt}")
print(f"\ntotal covered: {scenes[-1]['end'] - scenes[0]['start']:.2f}s of {AUDIO_END}s audio")
