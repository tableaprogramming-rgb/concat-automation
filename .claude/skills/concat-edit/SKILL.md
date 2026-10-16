---
name: concat-edit
description: Turn a transcribed, cut-decided video into a live Concat project and an exported MP4. This is the orchestrator that replaces free247editor's hyperframes/hyperframes-cli skill pair — nothing here renders through Chrome/GSAP; everything lands as real, reopenable Concat timeline clips.
---

# concat-edit

Drives the Concat engine (`concat-cli`, built from source by `setup.mjs`) via
`tools/concat-client.mjs` and `tools/edl-to-concat.mjs` to turn transcription +
cut decisions + style preferences into a live Concat project plus an exported
MP4. Run this after transcription and cut decisions are already made — this
skill does not transcribe or decide what to cut; it executes those decisions.

## Inputs this skill expects

- `inbox/<file>` — the raw video, untouched.
- `<file-stem>.json` — word-level transcript from `tools/transcribe.mjs`.
- `<file-stem>.silence-edl.json` — from `tools/cut-silences.mjs` (always run;
  deterministic, no approval needed).
- `<file-stem>.mistakes-edl.json` — from `tools/apply-cuts.mjs`, only if the
  user approved mistake-cut candidates from `tools/find-cut-candidates.mjs`.
  Skip this pass entirely if there were no approved cuts.
- The final retimed transcript (`*.mistakes-transcript.json` if the mistakes
  pass ran, else `*.silence-transcript.json`) — this is the timeline captions
  must be placed on, since its `start`/`end` fields already account for every
  cut.
- `my-style.md` / `my-rules.md` — read both; rules override style.

## What it does, step by step

1. Group the retimed transcript's words into caption phrases (a handful of
   words each, split on natural pauses >0.3s or sentence punctuation — this
   grouping is an editorial judgment call, make it yourself based on reading
   speed, don't hardcode a fixed word count).
2. Pick a caption mode from `my-style.md`'s prose via
   `inferCaptionMode(styleText)` (`full-subtitles` | `word-by-word` |
   `bold-key-word`) and a vertical position via `inferCaptionOffsetY`.
3. `client.projectCreate({location: 'projects', name: slug})`, then
   `client.projectDocument(path)` to read the starter timeline's track ids.
   Track layout convention: **tracks[0] = video, tracks[1] = captions, a
   further track for any camera-move/overlay clips if used.** Never reuse the
   video track for anything else — Concat silently snaps a clip's `start` to
   the nearest free slot on a track it collides on, so captions placed on the
   video track will NOT land where you asked.
4. `client.mediaImport(path, inboxFile)`, then one `addClip` on the video
   track (`ripple:false` — you want the raw full-length clip first; the cut
   pass below carves it).
5. `cutTimelineByEDLs(client, path, videoTrackId, [silenceEDL.delete_ranges,
   mistakesEDL?.delete_ranges ?? []])` — carves the cut natively via
   split+remove-with-ripple. Pass EDLs in the same order the scripts produced
   them (silence first, mistakes second — mistakes' ranges are expressed on
   the post-silence timeline, exactly matching what carving the silence pass
   first produces).
6. `planCaptionClips({transcript, captionTrackId, mode, offsetY})` then submit
   each returned command via `client.editApply(path, cmd)` sequentially (they
   don't reference each other's ids, so order doesn't matter, but submit one
   at a time — Concat's `nearest_free_start` placement depends on what's
   already on the track).
7. Optional emphasis: for a hook or a moment the user flagged, grab that
   clip's id from the post-cut project state and call
   `planPushInKeyframes({clipId, clipDurationSeconds})`, submitting each
   keyframe via `editApply`. Skip this for plain talking-head edits — it's for
   emphasis, not every clip.
8. `client.projectSave(path)` — the live `concat.json` is now the deliverable
   a human can reopen in the Concat GUI.
9. `client.exportRun(path, {output: 'outbox/<slug>-v1.mp4', crf: 20, preset:
   'medium'}, onProgress)` — await `export.done`.
10. Report back in 3-5 bullets: what got cut (durations from the EDLs), what
    captions/style were applied, where the live project is
    (`projects/<slug>/`, reopenable in Concat), and where the export landed.

## What this cannot do (don't attempt, don't apologize for it — just skip it)

- **True karaoke captions** (one word highlighted in place within a multi-word
  line) — `TextStyle` has no per-word x-anchor. `bold-key-word` mode is the
  closest approximation: a dim full-phrase plate plus a bold current-word clip
  stacked above it, readable as "one word lit up at a time," not true karaoke.
  Tell the user this up front if they ask for karaoke captions specifically.
- **The 406-card HyperFrames motion-graphics library** — not ported, not
  approximated. If a user references a specific "card" or asks for bespoke
  animated graphics beyond a simple push-in/pan, say this is out of scope for
  now rather than attempting a weak native substitute.
- **Word-by-word captions at scale** — each word is its own clip. Fine for a
  30-60s short-form clip; for a multi-minute video, warn the user this may
  mean hundreds of clips and suggest `full-subtitles` instead, or confirm
  they still want it.

## Verification before calling it done

Don't just trust `export.done` firing. Check the export file actually has the
expected duration (sum of EDL keep ranges) with `ffprobe`, and tell the user
the project is reopenable in Concat's GUI — if this is the first edit of a
session, actually suggest they open it once to confirm before trusting the
pipeline on a longer video.
