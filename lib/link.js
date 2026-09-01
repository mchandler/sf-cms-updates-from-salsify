'use strict';

const fs = require('fs');
const path = require('path');

const { API_VERSION, sleep } = require('./http');
const { createProgress } = require('./progress');
const { save: saveCheckpoint, appendJournal, compact } = require('./checkpoint');
const { fetchLinksByParent } = require('./lookups');
const { timestampSlug } = require('./error-log');
const { ask } = require('./prompt');

const COMPOSITE_BATCH_SIZE = 200;

// Removing links is the destructive half of this tool, so everything needed to
// recreate them is written to disk before the first delete: object, parent,
// group, media and sort order. Restoring produces new row ids but identical
// rows.
function writeRollback(orgAlias, action, deletes) {
  const file = path.resolve(process.cwd(), `rollback-${orgAlias}-${action}-${timestampSlug()}.json`);
  fs.writeFileSync(file, JSON.stringify(deletes.map((d) => ({
    object: d.object, linkId: d.linkId, parentId: d.parentId,
    groupId: d.groupId, contentId: d.contentId, sortOrder: d.sortOrder,
  })), null, 2));
  return file;
}

// swap    keep a link that already points at the replacement, delete the rest of
//         the group, insert one new link at SortOrder 0.
// add     insert only, appended after whatever the group already holds. An
//         identical parent+group+content link is left alone so a re-run does not
//         stack duplicates.
// delete  remove every link the parent holds in the target groups.
//
// `add` can carry several targets for one parent, so the plan tracks what it has
// already decided per parent and group as well as what the org holds: two rows
// appending to the same group must land at consecutive sort orders, and two rows
// whose different urls resolve to the same content must not become two identical
// links.
function planLinks({ action, entity, targets, existingLinks, groupIdByName }) {
  const byParent = new Map();
  for (const link of existingLinks) {
    const parentId = link[entity.parentField];
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push({
      object: entity.object,
      linkId: link.Id,
      parentId,
      groupId: link.ElectronicMediaGroupId,
      contentId: link.ElectronicMediaId,
      sortOrder: link.SortOrder ?? 0,
    });
  }

  const deletes = [];
  const inserts = [];
  const planned = new Map();
  let kept = 0;

  const plannedFor = (parentId, groupId) => {
    const key = `${parentId}|${groupId}`;
    let entry = planned.get(key);
    if (!entry) planned.set(key, (entry = { count: 0, contentIds: new Set() }));
    return entry;
  };

  for (const target of targets) {
    const existing = byParent.get(target.parentId) || [];

    for (const groupName of entity.groups) {
      const groupId = groupIdByName.get(groupName);
      const inGroup = existing.filter((l) => l.groupId === groupId);

      if (action === 'delete') {
        deletes.push(...inGroup.map((l) => ({ ...l, group: groupName, identifier: target.identifier, rowNum: target.rowNum })));
        continue;
      }

      if (action === 'swap') {
        // At most one survivor, so a group holding several copies of the
        // replacement is collapsed to one rather than left duplicated.
        let keeper = null;
        for (const l of inGroup) {
          if (!keeper && l.contentId === target.contentId) { keeper = l; continue; }
          deletes.push({ ...l, group: groupName, identifier: target.identifier, rowNum: target.rowNum });
        }
        if (keeper) { kept++; continue; }
        inserts.push({
          object: entity.object, parentField: entity.parentField, parentId: target.parentId,
          contentId: target.contentId, groupId, group: groupName, sortOrder: 0,
          identifier: target.identifier, rowNum: target.rowNum, sourceUrl: target.sourceUrl,
        });
        continue;
      }

      // add
      const soFar = plannedFor(target.parentId, groupId);
      if (inGroup.some((l) => l.contentId === target.contentId) || soFar.contentIds.has(target.contentId)) {
        kept++;
        continue;
      }
      const nextSort = (inGroup.length ? Math.max(...inGroup.map((l) => l.sortOrder)) + 1 : 0) + soFar.count;
      soFar.count++;
      soFar.contentIds.add(target.contentId);
      inserts.push({
        object: entity.object, parentField: entity.parentField, parentId: target.parentId,
        contentId: target.contentId, groupId, group: groupName, sortOrder: nextSort,
        identifier: target.identifier, rowNum: target.rowNum, sourceUrl: target.sourceUrl,
      });
    }
  }

  // Deterministic order, so a dry-run plan and the real run agree.
  deletes.sort((a, b) => (a.linkId < b.linkId ? -1 : 1));
  inserts.sort((a, b) => (`${a.parentId}${a.group}` < `${b.parentId}${b.group}` ? -1 : 1));
  return { deletes, inserts, kept };
}

function toInsertRecord(row) {
  return {
    attributes: { type: row.object },
    [row.parentField]: row.parentId,
    ElectronicMediaId: row.contentId,
    ElectronicMediaGroupId: row.groupId,
    SortOrder: row.sortOrder,
  };
}

function confirmDeletes(count, cfg) {
  console.log('');
  console.log(`  About to remove ${count} existing media link(s) with --action ${cfg.action}.`);
  console.log(`  A rollback file describing every one of them is written first.`);

  if (cfg.yes) {
    console.log('  Proceeding (--yes).');
    return Promise.resolve(true);
  }
  if (!process.stdin.isTTY) {
    console.error('  Refusing to remove links with no terminal attached. Re-run with --yes to proceed.');
    return Promise.resolve(false);
  }
  return ask(`  Type the number ${count} to continue: `, '').then((answer) => answer === String(count));
}

async function runDeletes({ client, state, cfg, deletes, errorLog }) {
  const step = state.steps.link;
  const totalBatches = Math.ceil(deletes.length / COMPOSITE_BATCH_SIZE);
  const progress = createProgress('Unlink', totalBatches);
  console.log(`[Link] Removing ${deletes.length} existing link(s) in ${totalBatches} batch(es)`);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const slice = deletes.slice(batchIndex * COMPOSITE_BATCH_SIZE, (batchIndex + 1) * COMPOSITE_BATCH_SIZE);
    const ids = slice.map((d) => d.linkId).join(',');

    let results = [];
    try {
      const res = await client.del(`/services/data/${API_VERSION}/composite/sobjects?ids=${encodeURIComponent(ids)}&allOrNone=false`);
      results = Array.isArray(res) ? res : [];
    } catch (e) {
      console.error(`[Link] Delete batch ${batchIndex + 1} failed entirely: ${e.message}`);
      for (const d of slice) {
        errorLog.log({
          row: d.rowNum, identifier: d.identifier, parentId: d.parentId, group: d.group, contentId: d.contentId,
          errorCode: 'DELETE_REQUEST_FAILED', errorMessage: String(e.body || e.message).slice(0, 500),
        });
      }
      progress.record({ fail: slice.length });
      step.failed += slice.length;
      progress.print(batchIndex);
      if (cfg.paceMs > 0) await sleep(cfg.paceMs);
      continue;
    }

    let ok = 0;
    let bad = 0;
    for (let i = 0; i < slice.length; i++) {
      const d = slice[i];
      const r = results[i];
      if (r && r.success) {
        ok++;
        // Displaced content becomes a candidate for the guarded unpublish. A
        // record this run created or reused is never a candidate, which the
        // retire step re-checks against live state.
        markDisplaced(state, cfg, d.contentId, d);
        continue;
      }
      bad++;
      const first = ((r && r.errors) || [])[0] || {};
      errorLog.log({
        row: d.rowNum, identifier: d.identifier, parentId: d.parentId, group: d.group, contentId: d.contentId,
        errorCode: first.statusCode || 'DELETE_FAILED',
        errorMessage: String(first.message || JSON.stringify(r)).slice(0, 500),
      });
    }

    progress.record({ ok, fail: bad });
    step.deleted += ok;
    step.failed += bad;
    saveCheckpoint(state, cfg);
    progress.print(batchIndex);
    if (cfg.paceMs > 0 && batchIndex + 1 < totalBatches) await sleep(cfg.paceMs);
  }
}

function markDisplaced(state, cfg, contentId, from) {
  if (!contentId) return;
  const entry = state.displaced[contentId] || (state.displaced[contentId] = { status: 'pending', identifiers: [] });
  if (from.identifier && !entry.identifiers.includes(from.identifier)) entry.identifiers.push(from.identifier);
  appendJournal(state, cfg, { displaced: contentId, patch: { status: entry.status, identifiers: entry.identifiers } });
}

async function runInserts({ client, state, cfg, inserts, errorLog }) {
  const step = state.steps.link;
  const totalBatches = Math.ceil(inserts.length / COMPOSITE_BATCH_SIZE);
  const progress = createProgress('Link', totalBatches);
  console.log(`[Link] Creating ${inserts.length} new link(s) in ${totalBatches} batch(es)`);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const slice = inserts.slice(batchIndex * COMPOSITE_BATCH_SIZE, (batchIndex + 1) * COMPOSITE_BATCH_SIZE);

    let results = [];
    try {
      const res = await client.post(`/services/data/${API_VERSION}/composite/sobjects`, {
        allOrNone: false,
        records: slice.map(toInsertRecord),
      });
      results = Array.isArray(res) ? res : [];
    } catch (e) {
      console.error(`[Link] Insert batch ${batchIndex + 1} failed entirely: ${e.message}`);
      for (const row of slice) {
        errorLog.log({
          row: row.rowNum, identifier: row.identifier, parentId: row.parentId, group: row.group,
          sourceUrl: row.sourceUrl, contentId: row.contentId,
          errorCode: 'COMPOSITE_REQUEST_FAILED', errorMessage: String(e.body || e.message).slice(0, 500),
        });
      }
      progress.record({ fail: slice.length });
      step.failed += slice.length;
      progress.print(batchIndex);
      if (cfg.paceMs > 0) await sleep(cfg.paceMs);
      continue;
    }

    let ok = 0;
    let bad = 0;
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const r = results[i];
      if (r && r.success) { ok++; continue; }
      bad++;
      const first = ((r && r.errors) || [])[0] || {};
      errorLog.log({
        row: row.rowNum, identifier: row.identifier, parentId: row.parentId, group: row.group,
        sourceUrl: row.sourceUrl, contentId: row.contentId,
        errorCode: first.statusCode || 'INSERT_FAILED',
        errorMessage: String(first.message || JSON.stringify(r)).slice(0, 500),
      });
    }

    progress.record({ ok, fail: bad });
    step.inserted += ok;
    step.failed += bad;
    saveCheckpoint(state, cfg);
    progress.print(batchIndex);
    if (cfg.paceMs > 0 && batchIndex + 1 < totalBatches) await sleep(cfg.paceMs);
  }
}

async function runLink({ client, state, cfg, entity, targets, groupIdByName, errorLog }) {
  const step = state.steps.link;
  if (step.status === 'completed' && !cfg.force) {
    console.log('[Link] Already completed (checkpoint). Use --force to re-run.');
    return step;
  }
  step.status = 'in_progress';
  step.inserted = 0;
  step.deleted = 0;
  step.kept = 0;
  step.failed = 0;

  if (targets.length === 0) {
    console.log('[Link] Nothing to link.');
    step.status = 'completed';
    compact(state, cfg);
    return step;
  }

  // Read live rather than trusting the checkpoint: a re-run must see what the
  // org holds now, so links already correct are kept and links already gone are
  // simply absent.
  console.log(`[Link] Reading current ${entity.object} links for ${targets.length} ${entity.name}(s)...`);
  const existingLinks = await fetchLinksByParent(
    client, entity, targets.map((t) => t.parentId),
    entity.groups.map((g) => groupIdByName.get(g)), cfg.paceMs
  );
  console.log(`  Found ${existingLinks.length} existing link(s) in ${entity.groups.join(' + ')}`);

  const { deletes, inserts, kept } = planLinks({ action: cfg.action, entity, targets, existingLinks, groupIdByName });
  step.kept = kept;

  if (cfg.dryRun) {
    console.log('[Link] DRY RUN - no records written.');
    console.log(`  Would remove ${deletes.length} link(s), create ${inserts.length}, keep ${kept} already correct`);
    for (const d of deletes.slice(0, 10)) console.log(`    remove ${d.identifier}  ${d.group}  link ${d.linkId} -> ${d.contentId}`);
    if (deletes.length > 10) console.log(`    ...and ${deletes.length - 10} more removals`);
    for (const row of inserts.slice(0, 10)) console.log(`    link   ${row.identifier}  ${row.group}  <- ${row.sourceUrl || row.contentId}`);
    if (inserts.length > 10) console.log(`    ...and ${inserts.length - 10} more links`);
    // So a dry run of the retire step below reports something realistic.
    for (const d of deletes) state.displaced[d.contentId] = state.displaced[d.contentId] || { status: 'pending', identifiers: [] };
    step.status = 'completed';
    return step;
  }

  if (deletes.length) {
    const file = writeRollback(cfg.org, cfg.action, deletes);
    console.log(`[Link] Rollback data for all ${deletes.length} link(s) written to ${file}`);
    state.rollbackFile = file;
    if (!(await confirmDeletes(deletes.length, cfg))) {
      throw new Error('Link removal not confirmed; nothing was changed.');
    }
    // Deletes run first so an entity never carries the old and new link at once.
    await runDeletes({ client, state, cfg, deletes, errorLog });
  } else {
    console.log('[Link] No existing links to remove.');
  }

  if (inserts.length) {
    await runInserts({ client, state, cfg, inserts, errorLog });
  } else if (cfg.action !== 'delete') {
    console.log('[Link] Every target already links to its image - nothing to create.');
  }

  // Stays pending if anything failed, so a re-run retries it. The plan is
  // rebuilt from live links every time, so retrying is safe: links already gone
  // are simply absent and links already correct are kept.
  step.status = step.failed > 0 ? 'pending' : 'completed';
  compact(state, cfg);
  console.log(`[Link] Removed ${step.deleted} | created ${step.inserted} | kept ${step.kept} | failed ${step.failed}`);
  return step;
}

module.exports = { runLink, planLinks, writeRollback, toInsertRecord, COMPOSITE_BATCH_SIZE };
