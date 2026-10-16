#!/usr/bin/env node
// Phase 1 integration check: a synthetic EDL (one mid-clip removal) and a
// tiny two-group transcript, run through the real pipeline — carve the cut
// natively, add captions on a dedicated track, save, export — then assert
// the output duration matches the EDL's math and the project is well-formed.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ConcatClient } from './concat-client.mjs';
import { cutTimelineByEDLs, planCaptionClips, inferCaptionMode, inferCaptionOffsetY } from './edl-to-concat.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(resolve(root, '.env')); } catch {}

const cliPath = process.env.CONCAT_CLI_PATH;
if (!cliPath || !existsSync(cliPath)) {
  console.error(`CONCAT_CLI_PATH not set or not found: ${cliPath}`);
  process.exit(1);
}

const projectsDir = resolve(root, 'projects');
const projectPath = resolve(projectsDir, 'phase1');
rmSync(projectPath, { recursive: true, force: true });
mkdirSync(projectsDir, { recursive: true });
const sample = resolve(root, 'inbox/smoke-sample.mp4'); // 6s synthetic clip
const output = resolve(root, 'outbox/phase1.mp4');
mkdirSync(resolve(root, 'outbox'), { recursive: true });

// Synthetic silence EDL: remove 2.0-3.0s (a fake "dead air" gap) from the 6s source.
const silenceEDL = { delete_ranges: [{ start: 2.0, end: 3.0 }] };
// Synthetic mistake EDL: remove 0.5s more, expressed on the POST-silence-cut
// timeline (5s long) at 4.0-4.5s — mirrors how apply-cuts.mjs chains after cut-silences.mjs.
const mistakesEDL = { delete_ranges: [{ start: 4.0, end: 4.5 }] };
const expectedDuration = 6.0 - (silenceEDL.delete_ranges[0].end - silenceEDL.delete_ranges[0].start)
  - (mistakesEDL.delete_ranges[0].end - mistakesEDL.delete_ranges[0].start); // 4.5s

// Retimed transcript on the FINAL post-cut timeline (hand-crafted for this test).
const transcript = {
  captions: [
    { start: 0.2, end: 1.0, words: [{ text: 'Hello', start: 0.2, end: 0.6 }, { text: 'world', start: 0.6, end: 1.0 }] },
    { start: 2.5, end: 3.2, words: [{ text: 'it', start: 2.5, end: 2.7 }, { text: 'works', start: 2.7, end: 3.2 }] },
  ],
};
const styleText = 'Captions: full subtitles, lower third, bold.';

const client = new ConcatClient(cliPath);
try {
  await client.projectCreate({ location: projectsDir, name: 'phase1' });
  let project = await client.projectDocument(projectPath);
  const timeline = project.timelines.find((t) => t.id === project.activeTimelineId) ?? project.timelines[0];
  const videoTrackId = timeline.tracks[0].id;
  const captionTrackId = timeline.tracks[1].id; // dedicated track, never shared with video

  const imported = await client.mediaImport(projectPath, sample);
  const mediaId = imported.project.media.at(-1).id;
  await client.editApply(projectPath, { op: 'addClip', mediaId, trackId: videoTrackId, start: 0, ripple: false });

  project = await cutTimelineByEDLs(
    client, projectPath, videoTrackId,
    [silenceEDL.delete_ranges, mistakesEDL.delete_ranges],
  );
  const finalClips = project.timelines.find((t) => t.id === project.activeTimelineId).clips
    .filter((c) => c.trackId === videoTrackId);
  const videoSpan = Math.max(...finalClips.map((c) => c.start + c.duration));
  console.log(`cut pass -> ${finalClips.length} clip(s) on video track, span ${videoSpan.toFixed(3)}s (expected ~${expectedDuration}s)`);

  const mode = inferCaptionMode(styleText);
  const offsetY = inferCaptionOffsetY(styleText);
  const captionCmds = planCaptionClips({ transcript, captionTrackId, mode, offsetY });
  for (const cmd of captionCmds) await client.editApply(projectPath, cmd);
  console.log(`captions -> ${captionCmds.length} clip(s) added, mode=${mode}`);

  await client.projectSave(projectPath);
  const result = await client.exportRun(projectPath, { output, crf: 23, preset: 'veryfast' });
  console.log('export.done ->', JSON.stringify(result));

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output], { encoding: 'utf8' });
  const actualDuration = Number(probe.stdout.trim());
  const ok = Math.abs(actualDuration - expectedDuration) < 0.15;
  console.log(`exported duration: ${actualDuration}s (expected ~${expectedDuration}s) -> ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
} finally {
  await client.close();
}
