// Maps free247editor's EDL/transcript/style data onto live Concat timeline
// operations. Two different shapes of work here, for a reason verified
// against Concat's actual source (concat-project/src/commands/{mod,clips}.rs):
//
// - Cutting is NOT a pure function. `SplitClips`/`RemoveClips` take real clip
//   ids, and ids are minted server-side (the head of a split keeps its id,
//   the tail mints a new one) — there is no way to predict them client-side
//   without replaying the mint counter. So `cutTimelineByEDLs` is a stateful
//   async function that round-trips with a live ConcatClient: split at every
//   delete-range boundary, re-read the track's current clips after each
//   split, then remove the spans that fall inside a delete range with one
//   `ripple:true` call. Multiple EDL passes (e.g. silence then mistakes) are
//   applied in sequence, each against the timeline the previous pass left
//   behind — exactly mirroring how the vendored scripts chain (apply-cuts.mjs
//   operates on cut-silences.mjs's output timeline).
//
// - Caption planning IS a pure function: each caption clip is independent
//   (no cross-referencing of other clips' ids), so `planCaptionClips` just
//   returns an array of `addTextClip` command objects from a retimed
//   transcript + a style, with no engine round-trip needed. Verified:
//   `AddTextClip`'s `start` is only a *request* — the engine snaps to
//   `nearest_free_start` on the given track if it would overlap an existing
//   clip, so captions MUST go on a dedicated track, never the video track
//   (confirmed empirically in the Phase 0 spike).

const MIN_CLIP_SECONDS = 1 / 60; // Concat's own floor on clip duration

function activeTimeline(project) {
  return project.timelines.find((t) => t.id === project.activeTimelineId) ?? project.timelines[0];
}

function trackClips(project, trackId) {
  return activeTimeline(project)
    .clips.filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

/**
 * Carves one pass of cuts into the given track: splits at every delete-range
 * boundary, then removes the spans with ripple so later clips close the gap.
 * `deleteRanges` are `{start, end}` in the CURRENT state of this track's
 * timeline (i.e. after any prior pass already applied).
 *
 * @returns {Promise<object>} the Project after the pass.
 */
export async function cutTimelineByEDLs(client, projectPath, trackId, edlPasses) {
  let project = await client.projectDocument(projectPath);
  for (const deleteRanges of edlPasses) {
    if (!deleteRanges.length) continue;

    // Every boundary we need a cut at, ascending, deduped.
    const boundaries = [...new Set(deleteRanges.flatMap((r) => [r.start, r.end]))]
      .filter((t) => t > 0)
      .sort((a, b) => a - b);

    for (const time of boundaries) {
      const clips = trackClips(project, trackId);
      // The one clip whose span strictly contains this boundary (a boundary
      // that already lands exactly on an existing edge needs no split).
      const target = clips.find((c) => time > c.start + 1e-6 && time < c.start + c.duration - 1e-6);
      if (!target) continue;
      const result = await client.editApply(projectPath, { op: 'splitClips', clipIds: [target.id], time });
      project = result.project;
    }

    const clips = trackClips(project, trackId);
    const removeIds = clips
      .filter((c) => deleteRanges.some((r) => c.start >= r.start - 1e-3 && c.start + c.duration <= r.end + 1e-3))
      .map((c) => c.id);
    if (removeIds.length) {
      const result = await client.editApply(projectPath, { op: 'removeClips', clipIds: removeIds, ripple: true });
      project = result.project;
    }
  }
  return project;
}

/** my-style.md's caption-mode prose, loosely matched to one of three strategies. */
export function inferCaptionMode(styleText = '') {
  const s = styleText.toLowerCase();
  if (s.includes('word-by-word') || s.includes('word by word')) return 'word-by-word';
  if (s.includes('bold key word') || s.includes('karaoke') || s.includes('highlight')) return 'bold-key-word';
  return 'full-subtitles';
}

/** upper/middle/lower third -> offsetY, from my-style.md's prose. */
export function inferCaptionOffsetY(styleText = '') {
  const s = styleText.toLowerCase();
  if (s.includes('upper')) return -0.35;
  if (s.includes('middle') || s.includes('center')) return 0;
  return 0.35; // lower third default
}

function baseTextStyle({ offsetY, color = '#ffffff', fontWeight = 800, dim = false } = {}) {
  return {
    color: dim ? '#ffffff99' : color,
    fontWeight,
    shadow: true,
    background: '#00000066',
    align: 'center',
  };
}

/**
 * Pure: {captions:[{words:[{text,start,end}]}]} + a style -> addTextClip
 * command objects, ready for sequential editApply calls on a dedicated
 * caption track. No clip ids are referenced across commands, so these can
 * be submitted independently and in any order.
 */
export function planCaptionClips({ transcript, captionTrackId, mode, offsetY }) {
  const commands = [];
  for (const group of transcript.captions) {
    if (mode === 'word-by-word') {
      for (const w of group.words) {
        const duration = Math.max(w.end - w.start, MIN_CLIP_SECONDS);
        commands.push({
          op: 'addTextClip',
          trackId: captionTrackId,
          start: w.start,
          duration,
          offsetY,
          above: false,
          style: { ...baseTextStyle({ offsetY }), content: w.text },
        });
      }
    } else if (mode === 'bold-key-word') {
      // Approximation only: true per-word karaoke highlight registered over
      // a multi-word line is not achievable (TextStyle has no per-word
      // x-anchor). Closest readable result: a dim full-phrase plate, plus
      // one bold current-word clip per word on a track above it.
      const full = group.words.map((w) => w.text).join(' ');
      const duration = Math.max(group.end - group.start, MIN_CLIP_SECONDS);
      commands.push({
        op: 'addTextClip',
        trackId: captionTrackId,
        start: group.start,
        duration,
        offsetY,
        above: false,
        style: { ...baseTextStyle({ offsetY, dim: true }), content: full },
      });
      for (const w of group.words) {
        const wDuration = Math.max(w.end - w.start, MIN_CLIP_SECONDS);
        commands.push({
          op: 'addTextClip',
          trackId: captionTrackId,
          start: w.start,
          duration: wDuration,
          offsetY,
          above: true,
          style: { ...baseTextStyle({ offsetY }), content: w.text },
        });
      }
    } else {
      // full-subtitles: one clip per phrase group.
      const text = group.words.map((w) => w.text).join(' ');
      const duration = Math.max(group.end - group.start, MIN_CLIP_SECONDS);
      commands.push({
        op: 'addTextClip',
        trackId: captionTrackId,
        start: group.start,
        duration,
        offsetY,
        above: false,
        style: { ...baseTextStyle({ offsetY }), content: text },
      });
    }
  }
  return commands;
}

/**
 * Pure: a simple "push in" emphasis keyframe pair (scale 1.0 -> targetScale
 * over `seconds` from the clip's own start) for a given already-created
 * clip id. `seconds` and the clip's own duration together determine the
 * keyframe's `at` fraction (0..1 of the clip's own length).
 */
export function planPushInKeyframes({ clipId, clipDurationSeconds, seconds = 0.6, targetScale = 1.15 }) {
  const at = Math.min(seconds / clipDurationSeconds, 1);
  return [
    { op: 'setClipKey', clipId, property: 'scale', at: 0, value: 1.0, ease: [0, 0, 1, 1] },
    { op: 'setClipKey', clipId, property: 'scale', at, value: targetScale, ease: [0.42, 0, 0.58, 1] },
  ];
}
