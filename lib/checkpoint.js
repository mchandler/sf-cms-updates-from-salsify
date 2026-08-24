'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic } = require('./atomic-write');

// One state file per (org, workspace, action, entity). Keying on the org alone
// would let a production run resume a sandbox rehearsal's checkpoint; omitting
// the action and entity lets a category swap and a product add against the same
// workspace collide, so the second reads the first's completed steps and
// reports its counts.
function stateKey(orgAlias, workspaceId, action, entity) {
  const suffix = String(workspaceId || '').slice(-6) || 'nows';
  return `${orgAlias}-${suffix}-${action}-${entity}`.replace(/[^A-Za-z0-9_.-]/g, '');
}

function checkpointPath(cfg) {
  return path.resolve(process.cwd(), `checkpoint-${stateKey(cfg.org, cfg.workspaceId, cfg.action, cfg.entity)}.json`);
}

function journalPath(cfg) {
  return path.resolve(process.cwd(), `checkpoint-${stateKey(cfg.org, cfg.workspaceId, cfg.action, cfg.entity)}.journal.jsonl`);
}

function lockPath(cfg) {
  return path.resolve(process.cwd(), `checkpoint-${stateKey(cfg.org, cfg.workspaceId, cfg.action, cfg.entity)}.lock`);
}

function emptyState(cfg, organizationId) {
  return {
    orgAlias: cfg.org,
    action: cfg.action,
    entity: cfg.entity,
    organizationId: organizationId || null,
    workspaceId: cfg.workspaceId,
    folderId: cfg.folderId || null,
    csvPath: cfg.csvPath,
    // Keyed on the source URL: one entry per distinct image, however many
    // identifiers reference it.
    images: {},
    // Content ids displaced by the link step, awaiting the guarded unpublish.
    displaced: {},
    steps: {
      upload: { status: 'pending', succeeded: 0, failed: 0, reused: 0 },
      link: { status: 'pending', inserted: 0, deleted: 0, kept: 0, failed: 0 },
      retire: { status: 'pending', unpublished: 0, keptReferenced: 0, failed: 0 },
    },
    timestamp: new Date().toISOString(),
  };
}

// Per-item durability goes to an append-only journal; the full document is
// rewritten at batch and step boundaries. load() replays the journal over the
// JSON, so a run killed mid-step resumes from the last item rather than the
// last save.
function appendJournal(state, cfg, entry) {
  if (cfg.dryRun) return;
  fs.appendFileSync(journalPath(cfg), JSON.stringify(entry) + '\n');
}

function applyJournalEntry(state, entry) {
  if (!entry) return;
  if (entry.image) {
    const current = state.images[entry.image] || (state.images[entry.image] = {});
    Object.assign(current, entry.patch || {});
    return;
  }
  if (entry.displaced) {
    const current = state.displaced[entry.displaced] || (state.displaced[entry.displaced] = {});
    Object.assign(current, entry.patch || {});
  }
}

function replayJournal(state, cfg) {
  const file = journalPath(cfg);
  if (!fs.existsSync(file)) return 0;
  let applied = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    // A crash mid-append can leave a truncated final line. Everything before it
    // is still valid, so skip the fragment rather than discarding the run.
    try { entry = JSON.parse(line); } catch (_) { continue; }
    applyJournalEntry(state, entry);
    applied++;
  }
  return applied;
}

function load(cfg) {
  const file = checkpointPath(cfg);
  if (!fs.existsSync(file)) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse checkpoint ${file}: ${e.message}`);
  }
  state.images = state.images || {};
  state.displaced = state.displaced || {};
  const replayed = replayJournal(state, cfg);
  if (replayed > 0) state.journalReplayed = replayed;
  return state;
}

function save(state, cfg) {
  if (cfg.dryRun) return;
  state.timestamp = new Date().toISOString();
  writeFileAtomic(checkpointPath(cfg), JSON.stringify(state, null, 2));
}

// Fold the journal into the JSON and start a fresh one.
function compact(state, cfg) {
  if (cfg.dryRun) return;
  save(state, cfg);
  const file = journalPath(cfg);
  if (fs.existsSync(file)) fs.rmSync(file);
}

function backup(cfg) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const made = [];
  for (const file of [checkpointPath(cfg), journalPath(cfg)]) {
    if (!fs.existsSync(file)) continue;
    const dst = `${file}.bak-${stamp}`;
    fs.renameSync(file, dst);
    made.push(dst);
  }
  return made.length ? made : null;
}

const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

// A hard kill leaves the lock behind, and a long run is exactly when a hard
// kill happens. If the recorded process was on this machine and is no longer
// running, the lock is stale and holding it would only force the operator to
// delete a file by hand. A pid on another host cannot be checked, so that falls
// back to the age window.
function holderIsAlive(held) {
  if (!held || !held.pid) return false;
  if (held.host && held.host !== os.hostname()) return true;
  try {
    process.kill(held.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireLock(cfg) {
  const file = lockPath(cfg);
  if (fs.existsSync(file)) {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* treat unreadable as stale */ }
    const age = held && held.startedAt ? Date.now() - Date.parse(held.startedAt) : Infinity;
    if (held && age < LOCK_STALE_MS && holderIsAlive(held)) {
      const err = new Error(
        `Another run holds the lock for this org, workspace, action and entity (pid ${held.pid} on ${held.host}, started ${held.startedAt}).\n` +
        `If that run is gone, delete ${file} and try again.`
      );
      err.code = 'LOCKED';
      throw err;
    }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }, null, 2));
  return file;
}

function releaseLock(cfg) {
  try { fs.rmSync(lockPath(cfg)); } catch (_) { /* already gone */ }
}

module.exports = {
  stateKey, checkpointPath, journalPath, lockPath,
  emptyState, load, save, compact, backup,
  appendJournal, replayJournal, holderIsAlive, acquireLock, releaseLock,
};
