#!/usr/bin/env node
'use strict';

// Checked before anything else loads. package.json's `engines` field is
// advisory - npm does not enforce it without engine-strict - so on an older
// runtime the first symptom would otherwise be `fetch is not defined` thrown
// from inside a request, which says nothing about the real cause.
const MIN_NODE_MAJOR = 18;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `This tool requires Node ${MIN_NODE_MAJOR} or newer; this is Node ${process.versions.node}.\n` +
    'It relies on the built-in fetch API, which older versions do not provide.\n' +
    'Install a current LTS release from https://nodejs.org and run `node --version` to confirm.\n'
  );
  process.exit(2);
}
if (typeof fetch !== 'function') {
  process.stderr.write(
    `Node ${process.versions.node} does not expose a global fetch.\n` +
    'Upgrade to Node 18 or newer, or start it with --experimental-fetch.\n'
  );
  process.exit(2);
}

const { resolveConfig } = require('./lib/args');
const { createSession } = require('./lib/auth');
const { createClient } = require('./lib/http');
const { resolveEntity, restrictGroups, defaultGroupsFor } = require('./lib/entities');
const { loadCsv, rowKey } = require('./lib/csv-load');
const { fetchMediaGroups, fetchParents, fetchOrgId } = require('./lib/lookups');
const checkpoint = require('./lib/checkpoint');
const { createErrorLog } = require('./lib/error-log');
const { createReport, writeRunReport } = require('./lib/report');
const { formatDuration, formatBytes } = require('./lib/progress');
const { exitAfterFlush } = require('./lib/exit');
const { ask } = require('./lib/prompt');

const mediaSource = require('./lib/media-source');

const { runUpload } = require('./lib/upload');
const { runLink } = require('./lib/link');
const { runRetire } = require('./lib/retire');

// A mismatch here is a hard refusal rather than a warning: the realistic hazard
// is a sandbox rehearsal followed by a production run that finds the old file,
// and this tool removes media links.
function assertSameOrg(state, cfg, organizationId) {
  if (state.organizationId && organizationId && state.organizationId !== organizationId) {
    throw new Error(
      `Checkpoint belongs to organization ${state.organizationId}, but --org ${cfg.org} is ${organizationId}.\n` +
      'Refusing to resume across orgs. Move the checkpoint aside to start fresh.'
    );
  }
  if (state.workspaceId && state.workspaceId !== cfg.workspaceId) {
    throw new Error(
      `Checkpoint was written for workspace ${state.workspaceId}, but --workspace is ${cfg.workspaceId}.\n` +
      'Refusing to resume across workspaces.'
    );
  }
}

async function resolveCheckpoint(cfg, organizationId) {
  const existing = checkpoint.load(cfg);

  if (cfg.dryRun) {
    // A dry run never writes state, but reading one lets it see what a previous
    // real run actually produced.
    if (!existing) return checkpoint.emptyState(cfg, organizationId);
    assertSameOrg(existing, cfg, organizationId);
    console.log(`Reading existing checkpoint for context (dry run will not write it): ${checkpoint.checkpointPath(cfg)}`);
    return existing;
  }

  if (!existing) return checkpoint.emptyState(cfg, organizationId);
  assertSameOrg(existing, cfg, organizationId);

  console.log(`\nFound checkpoint: ${checkpoint.checkpointPath(cfg)}`);
  console.log(`  written ${existing.timestamp}`);
  if (existing.journalReplayed) console.log(`  replayed ${existing.journalReplayed} journal entr(ies)`);
  for (const name of ['upload', 'link', 'retire']) {
    const s = existing.steps[name] || {};
    console.log(`  ${name.padEnd(7)}: ${s.status}`);
  }
  if (existing.csvPath && existing.csvPath !== cfg.csvPath) {
    console.warn(`  WARNING: checkpoint was written for ${existing.csvPath}`);
  }

  const answer = String(await ask('Resume from this checkpoint? [Y/n]: ', 'y')).toLowerCase();
  if (answer === 'n' || answer === 'no') {
    const moved = checkpoint.backup(cfg);
    if (moved) console.log(`  backed up to ${moved.join(', ')}`);
    return checkpoint.emptyState(cfg, organizationId);
  }
  existing.folderId = cfg.folderId || existing.folderId;
  existing.csvPath = cfg.csvPath;
  return existing;
}

// Resolves every eligible CSV row to a parent record and, for swap and add, to
// the published CMS content that will be linked. Rows that cannot be resolved
// are reported and dropped rather than silently ignored.
function buildTargets({ cfg, entity, rows, parents, state, errorLog }) {
  const targets = [];
  const skipped = new Map();
  const seen = new Set();

  const note = (row, code, message) => {
    skipped.set(rowKey(row.identifier, row.url), message);
    errorLog.log({ row: row.rowNum, identifier: row.identifier, sourceUrl: row.url, errorCode: code, errorMessage: message });
  };

  for (const row of rows) {
    if (row.skipReason) {
      skipped.set(rowKey(row.identifier, row.url), row.skipReason);
      errorLog.log({ row: row.rowNum, identifier: row.identifier, sourceUrl: row.url, errorCode: 'CSV_SKIP', errorMessage: row.skipReason });
      continue;
    }
    if (seen.has(rowKey(row.identifier, row.url))) continue;

    if (parents.ambiguous.has(row.identifier)) {
      note(row, 'AMBIGUOUS_IDENTIFIER', `More than one ${entity.sobject} has ${entity.matchField} = '${row.identifier}'`);
      continue;
    }
    const parentId = parents.map.get(row.identifier);
    if (!parentId) {
      note(row, 'PARENT_NOT_FOUND', `No ${entity.sobject} with ${entity.matchField} = '${row.identifier}'`);
      continue;
    }

    let contentId = null;
    if (cfg.action !== 'delete') {
      const image = (state.images || {})[row.url] || {};
      if (!image.contentId) {
        note(row, 'NO_CMS_CONTENT', image.error || 'No CMS content was created for this url');
        continue;
      }
      if (!image.published) {
        note(row, 'CONTENT_NOT_PUBLISHED', 'The replacement content is not confirmed published; nothing was linked to it');
        continue;
      }
      contentId = image.contentId;
    }

    seen.add(rowKey(row.identifier, row.url));
    targets.push({ identifier: row.identifier, rowNum: row.rowNum, parentId, contentId, sourceUrl: row.url });
  }

  return { targets, skipped };
}

function printSummary(state, cfg, entity, csv, errorLog, report, elapsedMs) {
  console.log('\n' + '='.repeat(64));
  console.log('Summary');
  console.log('='.repeat(64));
  const u = state.steps.upload;
  const l = state.steps.link;
  const r = state.steps.retire;
  // `delete` never uploads and `add` never retires, so those steps report as
  // not applicable rather than as work left pending.
  const status = (step, applies) => String(applies ? step.status : 'n/a').padEnd(12);
  console.log(`  Upload: ${status(u, cfg.action !== 'delete')} created=${u.succeeded} reused=${u.reused} failed=${u.failed}`);
  console.log(`  Link:   ${status(l, true)} created=${l.inserted} removed=${l.deleted} kept=${l.kept} failed=${l.failed}`);
  console.log(`  Retire: ${status(r, cfg.action !== 'add')} unpublished=${r.unpublished} left published=${r.keptReferenced} failed=${r.failed}`);

  const images = Object.values(state.images || {});
  const bytes = images.reduce((a, i) => a + (i.bytes || 0), 0);
  console.log(`\n  ${csv.stats.distinctIdentifiers} ${entity.name}(s) over ${csv.stats.distinctUrls} distinct source URL(s)`);
  if (bytes) console.log(`  ${formatBytes(bytes)} of image data`);
  if (csv.stats.skipped) console.log(`  ${csv.stats.skipped} CSV row(s) were skipped before any lookup`);

  if (report) console.log(`\n  Report: ${report.file}`);
  if (errorLog.count > 0) console.log(`  Errors: ${errorLog.count} row(s) in ${errorLog.file}`);
  if (state.rollbackFile) console.log(`  Rollback: ${state.rollbackFile}`);
  if (!cfg.dryRun) console.log(`  Checkpoint: ${checkpoint.checkpointPath(cfg)}`);
  console.log(`\n  Elapsed: ${formatDuration(elapsedMs)}`);
}

async function main() {
  const start = Date.now();
  const cfg = resolveConfig(process.argv.slice(2));

  let entity;
  const defaultedGroups = cfg.groupNames ? null : defaultGroupsFor(cfg.entity, cfg.action);
  try {
    entity = restrictGroups(resolveEntity(cfg.entity), cfg.groupNames || defaultedGroups);
  } catch (e) {
    console.error(`${e.message}\n`);
    return exitAfterFlush(1);
  }

  console.log('sf-cms-updates-from-salsify');
  console.log(`  Org:        ${cfg.org}`);
  console.log(`  Workspace:  ${cfg.workspaceId}${cfg.folderId ? ` (folder ${cfg.folderId})` : ''}`);
  console.log(`  Action:     ${cfg.action}`);
  console.log(`  Entity:     ${entity.name} -> ${entity.object} [${entity.groups.join(', ')}]`);
  if (defaultedGroups) {
    console.log(`              default for --action ${cfg.action}; pass --groups to target others`);
  }
  console.log(`  Identifier: ${entity.sobject}.${entity.matchField}`);
  console.log(`  CSV:        ${cfg.csvPath}`);
  console.log(`  Pace ${cfg.paceMs}ms | batch ${cfg.batchSize} | download x${cfg.downloadConcurrency} | upload x${cfg.uploadConcurrency}${cfg.force ? ' | FORCE' : ''}`);
  if (cfg.dryRun) console.log('  *** DRY RUN - nothing is written ***');
  if (cfg.action !== 'add' && !cfg.unpublish) console.log('  *** --no-unpublish - displaced content stays published ***');
  console.log('');

  let csv;
  try {
    csv = await loadCsv(cfg.csvPath, { requireUrl: cfg.requireUrl, allowRepeatIdentifier: cfg.action === 'add' });
  } catch (e) {
    console.error(`Could not read the CSV: ${e.message}\n`);
    return exitAfterFlush(2);
  }
  console.log(`Loaded ${csv.stats.totalRows} row(s): ${csv.stats.eligible} eligible, ${csv.stats.skipped} skipped, ` +
              `${csv.stats.distinctIdentifiers} distinct identifier(s), ${csv.stats.distinctUrls} distinct URL(s)`);
  if (csv.stats.distinctUrls && csv.stats.distinctUrls < csv.stats.distinctIdentifiers) {
    console.log(`  (${csv.stats.distinctIdentifiers - csv.stats.distinctUrls} identifier(s) share an image - each URL is uploaded once)`);
  }
  if (csv.stats.eligible === 0) {
    console.error('\nNothing to do: no eligible rows.');
    return exitAfterFlush(1);
  }

  const session = createSession(cfg.org);
  try {
    const s = await session.get();
    console.log(`\nAuthenticated as ${s.username} on ${s.instanceUrl}\n`);
  } catch (e) {
    console.error(`Could not obtain a session: ${e.message}\n`);
    console.error('Check that the CLI is installed and this org is authorised:');
    console.error('  sf --version');
    console.error('  sf org list');
    console.error(`  sf org login web --alias ${cfg.org}`);
    return exitAfterFlush(2);
  }

  const client = createClient(session);
  const errorLog = createErrorLog(cfg.org);
  let report = null;
  let state = null;
  let locked = false;

  try {
    const organizationId = await fetchOrgId(client);
    state = await resolveCheckpoint(cfg, organizationId);
    state.organizationId = state.organizationId || organizationId;

    if (!cfg.dryRun) {
      checkpoint.acquireLock(cfg);
      locked = true;
    }

    // Checked before any work starts. `delete` never resolves a URL, so it has
    // no use for the object and is not held to it.
    if (cfg.action !== 'delete') {
      await mediaSource.assertAvailable(client);
      console.log(`${mediaSource.OBJECT} is present and writable`);
    }

    const groupIdByName = await fetchMediaGroups(client, entity.groups, cfg.groups);
    console.log('Media groups: ' + [...groupIdByName].map(([n, id]) => `${n}=${id}`).join(', '));

    let rows = csv.rows;
    // --max-rows bounds the identifiers processed, not the CSV lines read, so a
    // large file can be worked through a slice at a time. Rows are in file
    // order, so the slice is the same on every run.
    if (cfg.maxRows) {
      const keep = new Set();
      for (const r of rows) {
        if (r.skipReason || keep.size >= cfg.maxRows) continue;
        keep.add(r.identifier);
      }
      rows = rows.filter((r) => r.skipReason || keep.has(r.identifier));
      console.log(`--max-rows ${cfg.maxRows}: processing ${keep.size} identifier(s) this run`);
    }

    const identifiers = rows.filter((r) => !r.skipReason).map((r) => r.identifier);
    console.log(`Resolving ${new Set(identifiers).size} identifier(s) against ${entity.sobject}.${entity.matchField}...`);
    const parents = await fetchParents(client, entity, identifiers, cfg.paceMs);
    console.log(`  Matched ${parents.map.size}` +
                (parents.ambiguous.size ? `, ${parents.ambiguous.size} ambiguous and dropped` : ''));

    if (cfg.action !== 'delete') {
      // One work item per distinct URL, carrying the label of the first
      // identifier that names it. The CMS title becomes the storefront's alt
      // text and cannot be changed after creation, so it is taken from the
      // parent record rather than from the Salsify filename.
      // Only URLs that at least one resolvable identifier names. Uploading an
      // image whose every identifier is missing or ambiguous would create a
      // permanent CMS record that nothing could ever link to.
      const wanted = new Set(
        rows.filter((r) => !r.skipReason && r.url && parents.map.has(r.identifier)).map((r) => r.url)
      );
      const work = [...csv.byUrl.values()]
        .filter((image) => wanted.has(image.sourceUrl))
        .map((image) => {
          const labelled = image.identifiers.find((id) => parents.map.has(id));
          return { ...image, title: parents.labels.get(parents.map.get(labelled)) };
        });
      await runUpload({ client, state, cfg, work, errorLog });
    }

    const { targets, skipped } = buildTargets({ cfg, entity, rows, parents, state, errorLog });
    console.log(`\n${targets.length} ${entity.name}(s) ready to ${cfg.action}`);

    await runLink({ client, state, cfg, entity, targets, groupIdByName, errorLog });

    if (cfg.action !== 'add') {
      await runRetire({ client, state, cfg, errorLog });
    }

    report = createReport(cfg.org, cfg.action);
    writeRunReport(report, {
      cfg, entity, state, rows: csv.rows, skipped,
      targetsByRow: new Map(targets.map((t) => [rowKey(t.identifier, t.sourceUrl), t])),
    });
    await report.close();
    await errorLog.close();

    printSummary(state, cfg, entity, csv, errorLog, report, Date.now() - start);
    return exitAfterFlush(errorLog.count > 0 ? 1 : 0);
  } catch (e) {
    console.error(`\nFatal error: ${e.message}`);
    await errorLog.close();
    if (state) printSummary(state, cfg, entity, csv, errorLog, report, Date.now() - start);
    return exitAfterFlush(2);
  } finally {
    if (locked) checkpoint.releaseLock(cfg);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  exitAfterFlush(2);
});
