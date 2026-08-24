'use strict';

const { sleep } = require('./http');
const { createProgress } = require('./progress');
const { save: saveCheckpoint, appendJournal, compact } = require('./checkpoint');
const { unpublish, PUBLISH_CHUNK } = require('./cms-binary');
const { fetchLinksByContent } = require('./lookups');
const { ALL_MEDIA_JUNCTIONS } = require('./entities');

// Verdicts are acted on in chunks rather than computed for the whole set and
// applied later, so a reference count can never go stale between the check and
// the unpublish.
const VERIFY_CHUNK = 200;

function patch(state, cfg, contentId, fields) {
  Object.assign(state.displaced[contentId] || (state.displaced[contentId] = {}), fields);
  appendJournal(state, cfg, { displaced: contentId, patch: fields });
}

// A displaced content is safe to unpublish only if nothing anywhere still points
// at it. The reference query deliberately spans every junction and every media
// group, not just the ones this run targeted: a record shared with an
// out-of-scope group such as `attachment`, or with an entity this run never
// touched, must keep serving.
async function evaluateChunk({ client, cfg, chunk, protectedIds }) {
  const verdicts = new Map();
  const checkedAt = new Date().toISOString();

  for (const id of chunk) {
    if (protectedIds.has(id)) {
      verdicts.set(id, { contentId: id, verdict: 'skip', reason: 'This content was created or reused by this run', liveReferences: '', referencingObjects: '', checkedAt });
    }
  }

  const candidates = chunk.filter((id) => !verdicts.has(id));
  if (candidates.length === 0) return [...verdicts.values()];

  const refs = new Map(candidates.map((id) => [id, []]));
  for (const junction of ALL_MEDIA_JUNCTIONS) {
    const links = await fetchLinksByContent(client, junction, candidates, cfg.paceMs);
    for (const l of links) {
      const bucket = refs.get(l.ElectronicMediaId);
      if (bucket) bucket.push(junction.object);
    }
  }

  for (const id of candidates) {
    const found = refs.get(id) || [];
    verdicts.set(id, found.length > 0
      ? { contentId: id, verdict: 'skip', reason: 'Still referenced by live media links', liveReferences: found.length, referencingObjects: [...new Set(found)].join(' '), checkedAt }
      : { contentId: id, verdict: 'unpublish', reason: 'No live references remain', liveReferences: 0, referencingObjects: '', checkedAt });
  }

  return [...verdicts.values()];
}

async function runRetire({ client, state, cfg, errorLog }) {
  const step = state.steps.retire;
  if (step.status === 'completed' && !cfg.force) {
    console.log('[Retire] Already completed (checkpoint).');
    return step;
  }
  step.status = 'in_progress';
  step.unpublished = 0;
  step.keptReferenced = 0;
  step.failed = 0;

  if (!cfg.unpublish) {
    console.log('[Retire] Skipped (--no-unpublish). Displaced content is left published.');
    step.status = 'completed';
    compact(state, cfg);
    return step;
  }

  const pool = Object.keys(state.displaced).filter((id) => state.displaced[id].status !== 'unpublished');
  if (pool.length === 0) {
    console.log('[Retire] No content was displaced; nothing to unpublish.');
    step.status = 'completed';
    compact(state, cfg);
    return step;
  }

  console.log(`[Retire] Checking ${pool.length} displaced content record(s) for remaining references.`);
  console.log('         CMS content cannot be deleted through the API; unpublishing is the available action and it is reversible.');

  // A dry run has not removed the links, so every candidate would still show a
  // live reference and every verdict would be "skip". Reporting that as the
  // outcome would be a lie, so say what would be considered and stop.
  if (cfg.dryRun) {
    console.log(`[Retire] DRY RUN - ${pool.length} content record(s) would be checked for remaining references and`);
    console.log('         unpublished only where none are found. The check runs against live links, which this');
    console.log('         run has not changed, so no verdict can be given here.');
    step.status = 'completed';
    return step;
  }

  // Never retire what this run put there. The externalId namespace is shared, so
  // a swap can legitimately reuse content that a previous run linked elsewhere.
  const protectedIds = new Set(Object.values(state.images).map((i) => i.contentId).filter(Boolean));

  const totalChunks = Math.ceil(pool.length / VERIFY_CHUNK);
  const progress = createProgress('Retire', totalChunks);

  for (let i = 0; i < pool.length; i += VERIFY_CHUNK) {
    const chunk = pool.slice(i, i + VERIFY_CHUNK);
    const chunkIndex = Math.floor(i / VERIFY_CHUNK);
    const verdicts = await evaluateChunk({ client, cfg, chunk, protectedIds });

    const retire = [];
    let skips = 0;
    for (const v of verdicts) {
      if (v.verdict === 'unpublish') { retire.push(v.contentId); continue; }
      skips++;
      patch(state, cfg, v.contentId, { status: 'kept', reason: v.reason, liveReferences: v.liveReferences });
    }
    step.keptReferenced += skips;

    for (let j = 0; j < retire.length; j += PUBLISH_CHUNK) {
      const slice = retire.slice(j, j + PUBLISH_CHUNK);
      // Write-ahead, so a crash between the call and its response leaves the id
      // marked pending and the next run simply re-checks it live.
      for (const id of slice) patch(state, cfg, id, { status: 'unpublishing' });
      try {
        await unpublish(client, slice);
        for (const id of slice) patch(state, cfg, id, { status: 'unpublished', reason: 'No live references remain', unpublishedAt: new Date().toISOString() });
        step.unpublished += slice.length;
        progress.record({ ok: slice.length });
      } catch (e) {
        step.failed += slice.length;
        progress.record({ fail: slice.length });
        for (const id of slice) {
          patch(state, cfg, id, { status: 'failed', reason: String(e.body || e.message).slice(0, 200) });
          errorLog.log({ contentId: id, errorCode: 'UNPUBLISH_FAILED', errorMessage: String(e.body || e.message).slice(0, 500) });
        }
      }
      if (cfg.paceMs > 0) await sleep(cfg.paceMs);
    }

    progress.record({ skip: skips });
    saveCheckpoint(state, cfg);
    progress.print(chunkIndex);
    if (cfg.paceMs > 0) await sleep(cfg.paceMs);
  }

  // Content left published because something still referenced it may become
  // retirable once a later run unlinks that reference, so the step only reports
  // completed when it acted on everything it saw.
  step.status = step.failed > 0 || step.keptReferenced > 0 ? 'pending' : 'completed';
  compact(state, cfg);
  console.log(`[Retire] Unpublished ${step.unpublished} | left published ${step.keptReferenced} | failed ${step.failed}`);
  return step;
}

module.exports = { runRetire, evaluateChunk, VERIFY_CHUNK };
