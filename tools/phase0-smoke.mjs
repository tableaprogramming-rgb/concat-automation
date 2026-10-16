#!/usr/bin/env node
// Phase 0 validation spike: can concat-cli run fully headless (no GUI) and
// produce a playable MP4 + a concat.json that reopens in the GUI? See the plan
// at silly-herding-otter.md for why this gates everything else.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ConcatClient } from './concat-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(resolve(root, '.env')); } catch {}

const cliPath = process.env.CONCAT_CLI_PATH;
if (!cliPath || !existsSync(cliPath)) {
  console.error(`CONCAT_CLI_PATH not set or not found: ${cliPath}`);
  process.exit(1);
}

const projectsDir = resolve(root, 'projects');
mkdirSync(projectsDir, { recursive: true });
const sample = resolve(root, 'inbox/smoke-sample.mp4');
const output = resolve(root, 'outbox/smoke.mp4');
mkdirSync(resolve(root, 'inbox'), { recursive: true });
rmSync(resolve(projectsDir, 'smoke'), { recursive: true, force: true });
if (!existsSync(sample)) {
  console.log('No sample clip in inbox/; generating a synthetic 6s test pattern...');
  const r = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed to generate the synthetic sample clip');
}
mkdirSync(resolve(root, 'outbox'), { recursive: true });

const client = new ConcatClient(cliPath);
try {
  const version = await client.version();
  console.log('version:', JSON.stringify(version));

  const projectPath = resolve(projectsDir, 'smoke');
  const created = await client.projectCreate({ location: projectsDir, name: 'smoke' });
  const activeTimeline = (p) => p.timelines.find((t) => t.id === p.activeTimelineId) ?? p.timelines[0];
  console.log('project.create -> timeline', activeTimeline(created.project).id, 'tracks', activeTimeline(created.project).tracks.length);

  const imported = await client.mediaImport(projectPath, sample);
  const mediaId = imported.project.media.at(-1).id;
  console.log('media.import -> mediaId', mediaId);

  const trackId = activeTimeline(imported.project).tracks[0].id;
  const addClip = await client.editApply(projectPath, { op: 'addClip', mediaId, trackId, start: 0, ripple: true });
  const clipId = addClip.createdId;
  console.log('addClip -> clipId', clipId);

  const caption = await client.editApply(projectPath, {
    op: 'addTextClip',
    trackId,
    above: true,
    start: 0,
    duration: 2,
    offsetY: 0.35,
    style: { content: 'HELLO PHASE 0' },
  });
  console.log('addTextClip -> clipId', caption.createdId);

  await client.projectSave(projectPath);
  console.log('project.save -> ok, concat.json written at', projectPath);

  const result = await client.exportRun(
    projectPath,
    { output, crf: 23, preset: 'veryfast' },
    (p) => console.log(`export.progress: ${p.frame}/${p.total} (${p.stage})`),
  );
  console.log('export.done ->', JSON.stringify(result));
} finally {
  await client.close();
}
