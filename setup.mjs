#!/usr/bin/env node
// Builds concat-cli from a pinned commit (no evidence it ships as a release
// binary — Concat's release CI bundles only the GUI app), checks required
// tools, and runs the Phase 0 headless smoke test. Set CONCAT_CLI_PATH in
// .env to skip the build if you already have a binary.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const envPath = resolve(root, '.env');
if (!existsSync(envPath) && existsSync(resolve(root, '.env.example'))) {
  copyFileSync(resolve(root, '.env.example'), envPath);
}
try { process.loadEnvFile(envPath); } catch {}

function has(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (status ${r.status})`);
}

console.log('Checking required tools...');
for (const [name, cmd] of [['node', 'node'], ['git', 'git'], ['ffmpeg', 'ffmpeg'], ['ffprobe', 'ffprobe']]) {
  if (!has(cmd)) throw new Error(`${name} not found on PATH`);
  console.log(`  ok: ${name}`);
}

for (const dir of ['inbox', 'outbox', 'my-sounds', 'projects']) {
  mkdirSync(resolve(root, dir), { recursive: true });
}

let cliPath = process.env.CONCAT_CLI_PATH;
if (cliPath && existsSync(cliPath)) {
  console.log(`Using CONCAT_CLI_PATH override: ${cliPath}`);
} else {
  if (!has('cargo')) {
    throw new Error(
      'cargo not found. concat-cli has no published release binary (Concat\'s ' +
      'release CI builds only the GUI app), so it must be built from source. ' +
      'Install Rust: https://rustup.rs, then re-run setup.mjs.',
    );
  }
  if (spawnSync('pkg-config', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('pkg-config not found (needed by ffmpeg-sys). Install it: brew install pkgconf');
  }

  const commit = process.env.CONCAT_COMMIT;
  if (!commit) throw new Error('CONCAT_COMMIT not set in .env');
  const engineDir = resolve(root, 'engine');
  if (!existsSync(engineDir)) {
    console.log(`Cloning jub0t/Concat into engine/ ...`);
    run('git', ['clone', 'https://github.com/jub0t/Concat.git', engineDir]);
  }
  console.log(`Checking out pinned commit ${commit} ...`);
  run('git', ['checkout', commit], { cwd: engineDir });

  console.log('Building concat-cli (cargo build --profile quick -p concat-cli, first build takes a few minutes)...');
  run('cargo', ['build', '--profile', 'quick', '-p', 'concat-cli'], { cwd: resolve(engineDir, 'src') });
  cliPath = resolve(engineDir, 'src/target/quick/concat-cli');
  if (!existsSync(cliPath)) throw new Error(`Expected binary not found at ${cliPath}`);

  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const updated = env.includes('CONCAT_CLI_PATH=')
    ? env.replace(/CONCAT_CLI_PATH=.*/, `CONCAT_CLI_PATH=${cliPath}`)
    : env + `\nCONCAT_CLI_PATH=${cliPath}\n`;
  writeFileSync(envPath, updated);
  console.log(`Built: ${cliPath}`);
}

const version = spawnSync(cliPath, ['--version'], { encoding: 'utf8' });
console.log(`concat-cli version: ${version.stdout.trim()}`);

if (!process.env.GROQ_API_KEY) {
  console.log(
    '\nNo GROQ_API_KEY set. Get a free key at https://console.groq.com/keys and add it ' +
    'to .env, or use `--local` with tools/transcribe.mjs (needs `pip install faster-whisper`).',
  );
}

console.log('\nRunning Phase 0 smoke test (synthetic clip, headless create -> edit -> export)...');
run('node', [resolve(root, 'tools/phase0-smoke.mjs')]);
console.log('\nSetup complete.');
