#!/usr/bin/env node
// Thin wrapper over concat-cli's persistent JSON-RPC stdin/stdout transport
// (`concat-cli api`, no single-request argument — one call per line in,
// one Reply or Event per line out). Wire format verified against
// jub0t/Concat @ afe8383, crates/concat-api/src/{rpc,message}.rs:
//
//   call:  {"jsonrpc":"2.0","id":<n>,"method":"<area.verb>","params":{...}}
//   reply: {"jsonrpc":"2.0","id":<n>,"result":...} | {"jsonrpc":"2.0","id":<n>,"error":{...}}
//   event: {"jsonrpc":"2.0","method":"export.progress"|"export.done"|"export.failed",...}
//          (events never carry an "id" key — that's how we tell them apart from replies)
//
// edit.apply / project.open / project.create / project.get / edit.undo / edit.redo
// all reply with a `View` = { project, canUndo, canRedo, settings, createdId? }.
// createdId is the id the LAST creating command minted — for a `batch` command
// that means only the batch's final sub-command's id comes back; callers that
// need an earlier id from the same batch must re-read it from `project`
// (clips/media are appended, so the new one is the one not seen before) or from
// a project.document call after saving.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class ConcatClient {
  #proc;
  #rl;
  #nextId = 1;
  #pending = new Map(); // id -> {resolve, reject}
  #eventHandlers = new Set();
  #closed = false;

  constructor(cliPath) {
    this.#proc = spawn(cliPath, ['api'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.#rl = createInterface({ input: this.#proc.stdout });
    this.#rl.on('line', (line) => this.#onLine(line));
    this.#proc.on('exit', (code) => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) {
        reject(new Error(`concat-cli exited (code ${code}) before replying`));
      }
      this.#pending.clear();
    });
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray non-JSON output; ignore
    }
    if (Object.hasOwn(msg, 'id')) {
      // A Reply. id is JSON-RPC's (number here, matching what we sent).
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new ConcatApiError(msg.error));
      else pending.resolve(msg.result);
    } else {
      // An Event: {"method": "...", "params": {...}}, no id.
      for (const handler of this.#eventHandlers) handler(msg.method, msg.params);
    }
  }

  onEvent(handler) {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  /** Low-level: one JSON-RPC call. */
  call(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('concat-cli has exited'));
    const id = this.#nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#proc.stdin.write(line + '\n');
    });
  }

  async close() {
    this.#proc.stdin.end();
    await new Promise((r) => this.#proc.once('exit', r));
  }

  // ---- typed helpers, one per Request variant we use ----

  version() {
    return this.call('version');
  }

  /** @returns {Promise<{job,path,output}>} */
  projectCreate({ location, name, video }) {
    return this.call('project.create', { location, name, ...(video ? { video } : {}) });
  }

  projectOpen(path) {
    return this.call('project.open', { path });
  }

  projectSave(path, name) {
    return this.call('project.save', { path, ...(name ? { name } : {}) });
  }

  projectDocument(path) {
    return this.call('project.document', { path });
  }

  mediaImport(path, file) {
    return this.call('media.import', { path, file });
  }

  /** One Command object, exactly as concat-project's tagged-by-"op" enum expects. */
  editApply(path, command) {
    return this.call('edit.apply', { path, command });
  }

  editApplyBatch(path, commands) {
    return this.editApply(path, { op: 'batch', commands });
  }

  /**
   * Starts an export and resolves when it finishes (export.done), or rejects
   * on export.failed / process exit. onProgress, if given, is called with
   * {frame, total, stage} for each export.progress event.
   */
  exportRun(path, spec, onProgress) {
    return new Promise((resolve, reject) => {
      this.call('export.run', { path, ...spec }).then(({ job }) => {
        const off = this.onEvent((method, params) => {
          if (params.job !== job) return;
          if (method === 'export.progress') onProgress?.(params);
          else if (method === 'export.done') {
            off();
            resolve(params);
          } else if (method === 'export.failed') {
            off();
            reject(new ConcatApiError(params.error));
          }
        });
      }, reject);
    });
  }
}

export class ConcatApiError extends Error {
  constructor({ code, message }) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
