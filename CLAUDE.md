# concat-editor — conversational AI video editing on a live Concat project

Drop raw footage in `inbox/`. Ask for an edit in plain language. The result is a
live Concat project (`projects/<slug>/concat.json`) plus an exported MP4 in
`outbox/` — the project stays open and editable in the Concat GUI afterward.
Nothing gets flattened or burned in.

## First run

If `my-style.md` doesn't exist yet, ask the user (two or three short rounds of
multiple choice, same convention as free247editor):
- Format: vertical 9:16 (default for social), 16:9, or both
- Captions: full subtitles, word-by-word, or bold-key-word; position upper/
  middle/lower third; colors
- Hook: big text in the first 3s, or none
- Pace: tight cuts or natural (don't trim every breath)
- Graphics: minimal, some, or heavy camera moves/overlays
- Color: natural, warm, cool, B&W, orange-teal
- Sound: voice only, light SFX, or SFX + music bed

Write their answers verbatim as plain bullets to `my-style.md`. Never edit this
file yourself afterward — only the user's own words go in it.

`my-rules.md` is append-only. When feedback on an edit is a lasting rule (says
"always"/"never", is about style, or repeats something said before), append it
with the user's exact words and today's date. **Rules beat style; style beats
this project's defaults.** Read both files before every edit.

## Pipeline (what `concat-edit` runs)

1. `node tools/transcribe.mjs inbox/<file>` (or `--local` for faster-whisper) →
   word-level transcript JSON beside the video.
2. `node tools/cut-silences.mjs <transcript.json>` → silence EDL + re-timed
   transcript. Deterministic — no approval needed.
3. `node tools/find-cut-candidates.mjs <silence-transcript.json>` → stutter/
   retake/false-start candidates. **Show each candidate with context to the
   user before cutting anything** — this is a judgment call, not mechanical.
   Write approved ones to an `approved-cuts.json` (`{"cuts":[{start,end,reason}]}`)
   and run `node tools/apply-cuts.mjs <transcript> --cuts approved-cuts.json`.
4. Read `my-style.md` + `my-rules.md`.
5. Run the `concat-edit` skill: opens/creates the Concat project, carves the
   cut natively on the timeline from the EDLs, adds caption clips styled per
   `my-style.md`, applies any emphasis camera-move keyframes, saves the
   project, and exports to `outbox/<slug>-v1.mp4`.
6. Tell the user where the live project is (`projects/<slug>/`, reopenable in
   the Concat GUI) and where the export landed. Keep this to 3-5 bullets.

## Conventions carried over from free247editor

- Never modify the user's original file in `inbox/`; always copy into a
  project folder first.
- The mistake-cut approval gate is mandatory — mechanical detection can't
  distinguish an emphatic repeat from a flub.
- Notes the user gives after watching a draft either refine `my-style.md`
  (one-off for this video) or get appended to `my-rules.md` (a lasting rule) —
  ask if it's unclear which.

## What this project deliberately does not do (see the plan for why)

No HTML/GSAP motion-graphics authoring, no 406-card template library, no TTS/
voice cloning, no background removal, no speed ramps in the MVP. See
`.claude/skills/concat-edit/SKILL.md` for what the Concat-backed pipeline can
and can't express (particularly around caption styles).
