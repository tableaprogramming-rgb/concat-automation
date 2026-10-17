# concat-editor-automation

A conversational AI video editor: drop raw footage in `inbox/`, describe the
edit in plain language, and get back a **live, still-editable video project**
— not just a flattened MP4.

## Why this exists

This project is built on the same idea as [**free247editor**](https://github.com/riecodes/free247editor):
let Claude do the actual video editing — transcribe the footage, decide what
to cut (dead air, stutters, false starts), write captions, time the pacing —
driven entirely by conversation instead of a timeline UI.

That worked well, but it had one real pain point. free247editor's rendering
engine ([Herk Edit Kit](https://github.com/nateherkai/herk-edit-kit)) builds
each edit as an HTML+GSAP animation, screen-captures it frame-by-frame with
headless Chrome, and bakes the result into an MP4 with FFmpeg. Every caption,
every zoom, every cut becomes permanent pixels. There's no project file left
behind — once it's rendered, a human can't open it back up in an editor and
keep tweaking it. The AI's work and the human's work couldn't hand off to each
other.

**Concat** fixes that. [`jub0t/Concat`](https://github.com/jub0t/Concat) is a
real, open-source, CapCut-class video editor (Rust, GPU-accelerated) that
exposes a full JSON-RPC/gRPC/CLI API operating on **live, structured project
state** — the same `concat.json` you'd see if you opened its GUI. Driving
Concat through that API instead of rendering through Chrome means every cut,
caption, and camera move lands as a real timeline clip, not a baked-in pixel.
The result is a project you can hand back to a human, open in Concat, and
keep editing by hand — something free247editor's pipeline could never do.

So: **this project keeps free247editor's "brain" (transcription, cut
decisions, style learning) and replaces its "hands"** — swapping the
Chrome/GSAP/FFmpeg render backend for native Concat API calls.

## How it works

```
inbox/raw.mp4
     │
     ▼
tools/transcribe.mjs              word-level transcript (Groq Whisper or local faster-whisper)
     │
     ▼
tools/cut-silences.mjs            deterministic dead-air/pause trimming → EDL
     │
     ▼
tools/find-cut-candidates.mjs     proposes stutters/false starts/retakes (review required)
tools/apply-cuts.mjs              applies only the cuts you approve → EDL
     │
     ▼
.claude/skills/concat-edit        drives Concat's JSON-RPC API:
     │                              • carves the cut natively (split + remove, no ffmpeg)
     │                              • adds caption clips on their own track, styled per your preferences
     │                              • applies emphasis camera-move keyframes
     ▼
projects/<slug>/concat.json       ← live project, reopenable in the Concat GUI
outbox/<slug>-v1.mp4              ← exported video
```

Nothing here renders through a browser. Every operation — the cut, the
captions, the zooms — is a real Concat timeline command (`addClip`,
`splitClips`, `addTextClip`, `setClipKey`, …), verified against Concat's
actual API, not approximated.

## What you get vs. what you give up

Concat's command API genuinely covers the essentials: trimming, styled
captions (font, color, position, background plate), keyframed zooms/pans,
effects, speed ramps, background removal. But it's not a 1:1 replacement for
HyperFrames' bespoke HTML/GSAP compositions:

- **True karaoke captions** (one word highlighted in place within a line) —
  not achievable; Concat's text clips have no per-word anchor. The closest
  approximation is a dim full-phrase plate with a bold current-word clip
  stacked above it.
- **The 406-card HyperFrames motion-graphics template library** — not
  ported. Simple camera moves (push-in, pan) are supported natively; bespoke
  animated graphics are out of scope for now.
- **Word-by-word captions** mean one clip per word — fine for a short-form
  clip, potentially hundreds of clips for a long video.

See `.claude/skills/concat-edit/SKILL.md` for the full list of what's
supported and what's deliberately deferred.

## Requirements

- Node.js 20+, Git, FFmpeg/ffprobe
- Rust (cargo) — `concat-cli` has no published release binary, so it's built
  from a pinned source commit. Install via [rustup.rs](https://rustup.rs) if
  you don't have it.
- `pkg-config` (`brew install pkgconf` on macOS) — needed by one of Concat's
  build dependencies.
- A free [Groq API key](https://console.groq.com/keys) for transcription, or
  `pip install faster-whisper` to transcribe locally with `--local`.
- [Claude Code](https://claude.com/claude-code), to actually run the
  conversational editing skill.

## Setup

```bash
git clone https://github.com/tableaprogramming-rgb/concat-automation.git
cd concat-automation
node setup.mjs
```

`setup.mjs` will:
1. Check for Node, Git, FFmpeg/ffprobe, cargo, and pkg-config.
2. Clone `jub0t/Concat` into `engine/` and build `concat-cli` from a pinned
   commit (first build takes a few minutes).
3. Run a headless smoke test — creates a tiny synthetic project, edits it,
   and exports an MP4 — to confirm the whole pipeline actually works on your
   machine before you trust it with real footage.

Then copy `.env.example` to `.env` (done automatically by `setup.mjs` if
missing) and add your `GROQ_API_KEY`, or plan to use `--local` instead.

Note: `CLAUDE.md` — the master workflow that orchestrates transcription, cut
decisions, and the `concat-edit` skill — is kept local and isn't tracked in
this repo. A fresh clone needs its own `CLAUDE.md` for Claude to follow the
full pipeline end to end; see "How it works" above for what it should wire
together.

## Using it

1. **Drop your raw footage** in `inbox/`.
2. **Open this folder in Claude Code** and just ask for what you want, e.g.:
   > "Edit my recording in inbox/raw.mp4 — cut the dead air, add bold
   > captions, and export it."
3. **First time only**, Claude will ask a few quick multiple-choice questions
   about your style (caption look, format, pacing, color) and save your
   answers to `my-style.md`. It won't ask again.
4. Claude runs the pipeline: transcribes the footage, trims silence
   automatically, and — if it finds likely stutters or false starts — shows
   you each one in context before cutting anything. Nothing mechanical gets
   cut without your say-so.
5. You get two things back:
   - **`projects/<slug>/concat.json`** — a live Concat project. Open it in
     the [Concat](https://github.com/jub0t/Concat) app any time to manually
     adjust, retime, or restyle whatever the AI did.
   - **`outbox/<slug>-v1.mp4`** — the exported video, ready to post.
6. **Give feedback** on the result in plain language. One-off notes refine
   that video; lasting preferences ("always/never do X") get appended to
   `my-rules.md` and apply to every future edit automatically.

### Manually running individual steps

Each stage is also a standalone CLI tool, useful for debugging or running
outside of Claude:

```bash
node tools/transcribe.mjs inbox/raw.mp4 [--local]
node tools/cut-silences.mjs inbox/raw.json
node tools/find-cut-candidates.mjs inbox/raw.silence-transcript.json
node tools/apply-cuts.mjs inbox/raw.silence-transcript.json --cuts approved-cuts.json
```

## Project layout

```
CLAUDE.md                       master workflow Claude follows (local only, not tracked in this repo)
setup.mjs                       builds concat-cli, runs the Phase 0 smoke test
my-style.md / my-rules.md       your preferences (created on first run)
inbox/   outbox/   my-sounds/   raw footage in, finished video out, your audio assets
tools/
  transcribe.mjs, transcribe_local.py      vendored from free247editor (MIT)
  cut-silences.mjs                         vendored from Herk Edit Kit (MIT)
  find-cut-candidates.mjs, apply-cuts.mjs  vendored from Herk Edit Kit (MIT)
  concat-client.mjs                        JSON-RPC client for concat-cli
  edl-to-concat.mjs                        EDL → native Concat timeline commands
  phase0-smoke.mjs, phase1-smoke.mjs        headless integration tests
.claude/skills/concat-edit/     the orchestrator skill that ties it all together
projects/<slug>/                live Concat projects (generated, gitignored)
engine/                         Concat source + build (generated, gitignored)
```

## Credits

- [riecodes/free247editor](https://github.com/riecodes/free247editor) (MIT) —
  the conversational editing workflow and transcription tooling this project
  builds on.
- [nateherkai/herk-edit-kit](https://github.com/nateherkai/herk-edit-kit)
  (MIT) — the silence/mistake-cut detection scripts, vendored unchanged.
- [jub0t/Concat](https://github.com/jub0t/Concat) (AGPL-3.0) — the editing
  engine this project drives over its JSON-RPC API. Invoked as a separate
  process over IPC, not linked or modified.
