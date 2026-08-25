'use strict';

const fs = require('fs');
const path = require('path');

const { sleep } = require('./http');
const { createProgress } = require('./progress');
const { save: saveCheckpoint, appendJournal, compact } = require('./checkpoint');
const { createBinaryContent, publish, PUBLISH_CHUNK, UploadVerificationError } = require('./cms-binary');
const { fetchExistingContentByExternalId, fetchContentByIds } = require('./lookups');
const mediaSource = require('./media-source');
const { readContents } = require('./content-read');
const { downloadAll, DownloadError } = require('./download');
const { slugFor, NAME_MAX } = require('./csv-load');
const { ask } = require('./prompt');

// Above this many creates, ask before starting. CMS content cannot be deleted
// through any Salesforce API, so every record this step creates is permanent.
// That makes an accidental full-catalogue run the one mistake this tool cannot
// walk back, and it is worth one keystroke to prevent.
const CONFIRM_THRESHOLD = 50;
const MEAN_CREATE_MS = 1100;

const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

function fileNameFor(sourceUrl, mimeType) {
  return `${slugFor(sourceUrl)}.${EXT_BY_MIME[mimeType] || 'bin'}`;
}

// Falls back to the URL basename when the parent record could not be read. The
// CMS title becomes the storefront's alt text and cannot be changed after
// creation, so a meaningful default matters.
function titleFor(sourceUrl) {
  let base = '';
  try { base = decodeURIComponent(path.basename(new URL(sourceUrl).pathname)); } catch (_) { /* fall through */ }
  if (!base || base === '/') base = slugFor(sourceUrl);
  return base.slice(0, NAME_MAX);
}

function confirmLargeRun(count, cfg) {
  const eta = Math.round((count * (MEAN_CREATE_MS + cfg.paceMs)) / Math.max(1, cfg.uploadConcurrency) / 60000);
  console.log('');
  console.log(`  About to create ${count} CMS content record(s) in workspace ${cfg.workspaceId}.`);
  console.log(`  Estimated ${eta} minute(s) at the current pacing and concurrency.`);
  console.log('  CMS content cannot be deleted through the API - these records are permanent.');

  if (cfg.yes) {
    console.log('  Proceeding (--yes).');
    return Promise.resolve(true);
  }
  if (!process.stdin.isTTY) {
    console.error('  Refusing to start a run this size with no terminal attached. Re-run with --yes to proceed.');
    return Promise.resolve(false);
  }
  return ask(`  Type the number ${count} to continue: `, '').then((answer) => answer === String(count));
}

function patchImage(state, cfg, sourceUrl, patch) {
  Object.assign(state.images[sourceUrl] || (state.images[sourceUrl] = {}), patch);
  appendJournal(state, cfg, { image: sourceUrl, patch });
}

// Work is per distinct source URL, never per identifier: several products or
// categories can name the same image, and all of them map to one externalId, so
// iterating by identifier would race two creates onto the same key and fail the
// second with DUPLICATE_VALUE.
async function runUpload({ client, state, cfg, work, errorLog }) {
  const step = state.steps.upload;
  if (step.status === 'completed' && !cfg.force) {
    console.log('[Upload] Already completed (checkpoint). Use --force to re-run.');
    return step;
  }
  // Counters describe this run, not the sum of every run against this
  // checkpoint, so they are reset rather than accumulated.
  step.status = 'in_progress';
  step.succeeded = 0;
  step.failed = 0;
  step.reused = 0;

  if (work.length === 0) {
    console.log('[Upload] Nothing to upload.');
    step.status = 'completed';
    compact(state, cfg);
    return step;
  }

  const pending = work.filter((w) => !(state.images[w.sourceUrl] || {}).contentId);
  if (pending.length) {
    await resolveExisting({ client, state, cfg, pending, step, errorLog });
  }

  const todo = work.filter((w) => !(state.images[w.sourceUrl] || {}).contentId);
  console.log(`[Upload] ${todo.length} image(s) to create, ${work.length - todo.length} already present`);

  if (todo.length === 0) {
    await publishAll({ client, state, cfg, work, errorLog });
    step.failed += (await writePointers({ client, state, cfg, work, errorLog })) || 0;
    step.status = step.failed > 0 ? 'pending' : 'completed';
    compact(state, cfg);
    return step;
  }

  if (cfg.dryRun) {
    console.log('[Upload] DRY RUN - no content is created and nothing is published.');
    for (const w of todo.slice(0, 10)) console.log(`    would create ${w.externalId}  <-  ${w.sourceUrl}`);
    if (todo.length > 10) console.log(`    ...and ${todo.length - 10} more`);
    for (const w of todo) {
      const image = state.images[w.sourceUrl] || (state.images[w.sourceUrl] = {});
      image.contentId = `DRYRUN:${w.externalId}`;
      image.published = true;
      image.origin = 'created';
    }
    await writePointers({ client, state, cfg, work, errorLog });
    step.status = 'completed';
    return step;
  }

  await downloadPhase({ state, cfg, todo, errorLog });

  const ready = todo.filter((w) => (state.images[w.sourceUrl] || {}).cacheFile);
  if (ready.length >= CONFIRM_THRESHOLD && !(await confirmLargeRun(ready.length, cfg))) {
    throw new Error('Upload not confirmed; nothing was created.');
  }

  const progress = createProgress('Upload', ready.length, { printEvery: Math.max(1, Math.floor(ready.length / 40)) });
  let done = 0;
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= ready.length) return;
      const item = ready[index];
      const image = state.images[item.sourceUrl];

      // Write-ahead: a crash between the request and its response leaves an
      // unambiguous marker, and the adoption lookup above finds whatever landed.
      patchImage(state, cfg, item.sourceUrl, { status: 'creating', externalId: item.externalId });

      try {
        const created = await createBinaryContent(client, {
          workspaceId: cfg.workspaceId,
          folderId: cfg.folderId,
          title: item.title || titleFor(item.sourceUrl),
          apiName: item.apiName,
          urlName: item.urlName,
          externalId: item.externalId,
          mimeType: image.mimeType,
          fileName: fileNameFor(item.sourceUrl, image.mimeType),
          bytes: fs.readFileSync(image.cacheFile),
        });
        patchImage(state, cfg, item.sourceUrl, {
          contentId: created.managedContentId, contentKey: created.contentKey,
          md5: created.md5, status: 'created', origin: 'created', error: null,
        });
        progress.record({ ok: 1 });
        step.succeeded++;
      } catch (e) {
        const code = e instanceof UploadVerificationError ? 'UPLOAD_VERIFY_FAILED' : (e.status ? `HTTP_${e.status}` : 'UPLOAD_FAILED');
        const message = String(e.body || e.message).slice(0, 500);
        patchImage(state, cfg, item.sourceUrl, { status: 'failed', error: `${code}: ${message}` });
        progress.record({ fail: 1 });
        step.failed++;
        errorLog.log({
          row: item.firstRow, identifier: item.identifiers.join(' '), sourceUrl: item.sourceUrl,
          errorCode: code, errorMessage: message,
        });
      }

      progress.print(done++);
      if (done % 50 === 0) saveCheckpoint(state, cfg);
      if (cfg.paceMs > 0) await sleep(cfg.paceMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(cfg.uploadConcurrency, ready.length) }, worker));
  saveCheckpoint(state, cfg);

  await publishAll({ client, state, cfg, work, errorLog });
  step.failed += (await writePointers({ client, state, cfg, work, errorLog })) || 0;

  // A step that failed rows stays pending, so simply running the same command
  // again retries them. Only a clean pass is 'completed', which is what makes
  // --force unnecessary for the ordinary "it half-worked, run it again" case.
  step.status = step.failed > 0 ? 'pending' : 'completed';
  compact(state, cfg);
  console.log(`[Upload] Created ${step.succeeded}, reused ${step.reused}, failed ${step.failed}`);
  return step;
}

// Two ways an image can already be in the org, tried in that order.
//
// CMS_Media_Source__c is the authority: it holds the source URL as readable
// text, so it answers directly, and it is what every run from here on maintains.
//
// The ExternalId hash is the fallback, and it is not vestigial. It is the only
// thing that recognises content uploaded before CMS_Media_Source__c existed,
// and because the hash cannot be reversed, the pointer for that content can
// only ever be written here - while the CSV still holds the URL that made it.
async function resolveExisting({ client, state, cfg, pending, step, errorLog }) {
  const fromPointer = await resolveFromMediaSource({ client, cfg, pending, errorLog });
  for (const item of pending) {
    const contentId = fromPointer.get(item.sourceUrl);
    if (contentId) recordAdoption(state, cfg, item, { contentId, origin: 'pointer', hasPointer: true });
  }

  const unpointed = pending.filter((w) => !(state.images[w.sourceUrl] || {}).contentId);
  if (unpointed.length) {
    const existing = await fetchExistingContentByExternalId(
      client, cfg.workspaceId, unpointed.map((w) => w.externalId), cfg.paceMs
    );
    let byHash = 0;
    for (const item of unpointed) {
      const found = existing.get(item.externalId);
      if (!found) continue;
      byHash++;
      recordAdoption(state, cfg, item, { contentId: found, origin: 'externalId', hasPointer: false });
    }
    if (byHash) {
      console.log(`[Upload] ${byHash} content record(s) matched by externalId; a ${mediaSource.OBJECT} row will be written for each`);
    }
  }

  const adopted = pending.filter((w) => (state.images[w.sourceUrl] || {}).contentId);
  step.reused = adopted.length;
  if (adopted.length) console.log(`[Upload] Adopted ${adopted.length} content record(s) that already exist for these URLs`);
  if (adopted.length === 0 || cfg.dryRun) return;

  // Adoption is the common case in an org that has run this tooling before, and
  // publishing is a deployment: re-publishing something already live costs a
  // deployment record for no change. Read the adopted records first so
  // publishAll only acts on the ones that are genuinely not published.
  const adoptedIds = [...new Set(adopted.map((item) => state.images[item.sourceUrl].contentId))];
  let live = 0;
  for await (const c of readContents(client, adoptedIds, { batchSize: cfg.batchSize, paceMs: cfg.paceMs })) {
    if (c.kind === 'error' || !c.isPublished) continue;
    live++;
    for (const item of adopted) {
      if (state.images[item.sourceUrl].contentId === c.contentId) patchImage(state, cfg, item.sourceUrl, { published: true });
    }
  }
  console.log(`[Upload] ${live} of ${adoptedIds.length} adopted record(s) are already published`);
}

function recordAdoption(state, cfg, item, { contentId, origin, hasPointer }) {
  const patch = { contentId, externalId: item.externalId, status: 'reused', origin };
  if (hasPointer) patch.mediaSourceStatus = 'present';
  if (!cfg.dryRun) {
    patchImage(state, cfg, item.sourceUrl, patch);
    return;
  }
  // A dry run assumes the publish below would succeed, so the link step can plan
  // against a realistic world instead of reporting that nothing is publishable.
  // The caveat is printed alongside.
  Object.assign(state.images[item.sourceUrl] || (state.images[item.sourceUrl] = {}), patch, { published: true });
}

// A pointer is a plain text field with no referential integrity behind it, so
// it is verified before anything is linked to what it names. One that has been
// orphaned, or that names content in another workspace, is treated as absent:
// the ExternalId pass and, failing that, a fresh upload will produce something
// this run can safely link.
async function resolveFromMediaSource({ client, cfg, pending, errorLog }) {
  const resolved = new Map();
  const { byUrl, duplicates } = await mediaSource.fetchByUrls(client, pending.map((w) => w.sourceUrl), cfg.paceMs);

  if (duplicates.length) {
    console.warn(`  ${duplicates.length} URL(s) hold more than one ${mediaSource.OBJECT} row; the lowest usable Id wins`);
  }
  if (byUrl.size === 0) {
    console.log(`[Upload] No ${mediaSource.OBJECT} row matched these URLs`);
    return resolved;
  }

  // Only well-formed ids reach the query. A malformed one is not merely
  // useless, it is fatal: SOQL rejects the whole `Id IN (...)` filter, so a
  // single bad row would abort every run against this org.
  const queryable = [];
  for (const rows of byUrl.values()) {
    for (const row of rows) if (mediaSource.isWellFormedId(row.contentId)) queryable.push(row.contentId);
  }
  const live = await fetchContentByIds(client, [...new Set(queryable)], cfg.paceMs);

  let unusable = 0;
  for (const [sourceUrl, rows] of byUrl) {
    // Rows are ordered by Id, and the first usable one wins. Stopping at the
    // lowest Id regardless of whether it works would discard a good row for a
    // broken one, and no later run could recover: a replacement row always has
    // a higher Id, so it would lose the same tiebreak every time.
    let chosen = null;
    const rejected = [];

    for (const row of rows) {
      const reason = rejectionFor(row, live, cfg);
      if (!reason) { chosen = row; break; }
      rejected.push({ row, reason });
    }

    if (chosen) {
      resolved.set(sourceUrl, chosen.contentId18);
      continue;
    }
    unusable++;
    for (const { row, reason } of rejected) {
      errorLog.log({ sourceUrl, contentId: row.contentId, errorCode: reason.code, errorMessage: reason.message });
    }
  }

  console.log(`[Upload] ${resolved.size} URL(s) resolved from ${mediaSource.OBJECT}` +
              (unusable ? `, ${unusable} URL(s) had no usable row` : ''));
  return resolved;
}

// Why a CMS_Media_Source__c row cannot be used, or null if it can. The row is
// annotated with the real 18-character id on success, since the stored value
// may be the 15-character form.
function rejectionFor(row, live, cfg) {
  if (!mediaSource.isWellFormedId(row.contentId)) {
    return { code: 'MEDIA_SOURCE_MALFORMED_ID', message: `${mediaSource.OBJECT} ${row.mediaSourceId} holds "${row.contentId}", which is not a Salesforce id` };
  }
  const content = live.get(row.contentId) || live.get(mediaSource.idKey(row.contentId));
  if (!content) {
    return { code: 'MEDIA_SOURCE_DANGLING', message: `${mediaSource.OBJECT} ${row.mediaSourceId} names ${row.contentId}, which no longer exists` };
  }
  if (content.AuthoredManagedContentSpaceId !== cfg.workspaceId) {
    return { code: 'MEDIA_SOURCE_WRONG_WORKSPACE', message: `${mediaSource.OBJECT} ${row.mediaSourceId} names content in space ${content.AuthoredManagedContentSpaceId}, not ${cfg.workspaceId}` };
  }
  row.contentId18 = content.Id;
  return null;
}

// Always after the content exists, never before: if this fails, the content is
// still there and the next run finds it by ExternalId and retries the pointer.
// The reverse order would leave a row naming content that was never created.
// A failure here is logged and does not fail the row - the image is uploaded,
// published and linked either way.
async function writePointers({ client, state, cfg, work, errorLog }) {
  const rows = [];
  const tooLong = [];
  for (const item of work) {
    const image = state.images[item.sourceUrl];
    if (!image || !image.contentId) continue;
    if (image.mediaSourceStatus === 'present' || image.mediaSourceStatus === 'written') continue;
    // Placeholder ids exist only inside a dry run, and are counted there so the
    // report covers the pointers a real run would write for content it creates.
    if (!cfg.dryRun && String(image.contentId).startsWith('DRYRUN:')) continue;
    // Longer than the field can hold, so the upsert could only ever fail, and
    // would fail identically on every future run. The image itself is fine -
    // the ExternalId hash still recognises it - so this is a note, not a error.
    if (item.sourceUrl.length > mediaSource.URL_MAX) { tooLong.push(item.sourceUrl); continue; }
    rows.push({ sourceUrl: item.sourceUrl, contentId: image.contentId });
  }
  if (tooLong.length) {
    console.warn(`  ${tooLong.length} URL(s) exceed ${mediaSource.URL_MAX} characters and cannot be recorded in ${mediaSource.OBJECT}`);
    for (const u of tooLong.slice(0, 3)) console.warn(`    ${u.slice(0, 80)}...`);
  }
  if (rows.length === 0) return;

  if (cfg.dryRun) {
    console.log(`[Upload] DRY RUN - would write ${rows.length} ${mediaSource.OBJECT} record(s).`);
    for (const r of rows.slice(0, 10)) console.log(`    would record ${r.sourceUrl}`);
    if (rows.length > 10) console.log(`    ...and ${rows.length - 10} more`);
    return;
  }

  console.log(`[Upload] Recording ${rows.length} URL(s) in ${mediaSource.OBJECT}`);
  const results = await mediaSource.upsertPointers(client, rows, { paceMs: cfg.paceMs });

  let ok = 0;
  let bad = 0;
  for (const r of results) {
    if (r.success) {
      ok++;
      patchImage(state, cfg, r.sourceUrl, { mediaSourceStatus: 'written', mediaSourceId: r.mediaSourceId });
      continue;
    }
    bad++;
    patchImage(state, cfg, r.sourceUrl, { mediaSourceStatus: 'failed' });
    errorLog.log({ sourceUrl: r.sourceUrl, contentId: r.contentId, errorCode: r.errorCode, errorMessage: r.errorMessage });
  }

  console.log(`[Upload] ${mediaSource.OBJECT}: wrote ${ok}` + (bad ? `, failed ${bad}` : ''));
  if (bad) console.warn('  The image(s) are uploaded and linked; only the source record failed.');
  saveCheckpoint(state, cfg);
  // Counted into the step so it stays 'pending' and the next plain re-run
  // retries the write. Without this the step would report completed and skip
  // straight past this function, and the record would never be written.
  return bad;
}

// Never routed through the Salesforce client: no org access token may be
// attached to a Salsify request.
async function downloadPhase({ state, cfg, todo, errorLog }) {
  const outstanding = todo.filter((w) => !(state.images[w.sourceUrl] || {}).cacheFile);
  if (outstanding.length === 0) return;

  console.log(`[Download] Fetching ${outstanding.length} image(s) from source`);
  const progress = createProgress('Download', outstanding.length, { printEvery: Math.max(1, Math.floor(outstanding.length / 20)) });
  const byUrl = new Map(todo.map((w) => [w.sourceUrl, w]));
  let done = 0;

  await downloadAll(
    outstanding.map((w) => w.sourceUrl),
    { cacheDir: cfg.cacheDir, concurrency: cfg.downloadConcurrency, timeoutMs: cfg.timeoutMs },
    (sourceUrl, result, err) => {
      const item = byUrl.get(sourceUrl);
      if (err) {
        progress.record({ fail: 1 });
        patchImage(state, cfg, sourceUrl, { status: 'failed', error: `${err.code}: ${err.message}` });
        errorLog.log({
          row: item && item.firstRow, identifier: item ? item.identifiers.join(' ') : '', sourceUrl,
          errorCode: err instanceof DownloadError ? err.code : 'DOWNLOAD_FAILED',
          errorMessage: err.message,
        });
      } else {
        progress.record({ ok: 1 });
        patchImage(state, cfg, sourceUrl, {
          cacheFile: result.path, mimeType: result.mimeType, bytes: result.bytes,
          md5: result.md5, status: 'downloaded', error: null,
        });
      }
      progress.print(done++);
    }
  );
}

// Publication is a deployment, so a 201 on the call is not proof the content is
// live. Nothing is linked to content that is merely believed published.
async function publishAll({ client, state, cfg, work, errorLog }) {
  const toPublish = [...new Set(
    work
      .map((w) => state.images[w.sourceUrl])
      .filter((i) => i && i.contentId && !String(i.contentId).startsWith('DRYRUN:') && !i.published)
      .map((i) => i.contentId)
  )];
  if (toPublish.length === 0) return;

  console.log(`[Upload] Publishing ${toPublish.length} content record(s)`);
  for (let i = 0; i < toPublish.length; i += PUBLISH_CHUNK) {
    const chunk = toPublish.slice(i, i + PUBLISH_CHUNK);
    try {
      await publish(client, chunk, 'Image update');
    } catch (e) {
      for (const id of chunk) {
        errorLog.log({ contentId: id, errorCode: 'PUBLISH_FAILED', errorMessage: String(e.body || e.message).slice(0, 500) });
      }
    }
    if (cfg.paceMs > 0) await sleep(cfg.paceMs);
  }

  console.log('[Upload] Verifying published state...');
  const live = new Set();
  for await (const c of readContents(client, toPublish, { batchSize: cfg.batchSize, paceMs: cfg.paceMs })) {
    if (c.kind !== 'error' && c.isPublished) live.add(c.contentId);
  }
  for (const [sourceUrl, image] of Object.entries(state.images)) {
    if (image.contentId && live.has(image.contentId)) patchImage(state, cfg, sourceUrl, { published: true });
  }

  const unconfirmed = toPublish.filter((id) => !live.has(id));
  console.log(`[Upload] Confirmed published: ${live.size}/${toPublish.length}`);
  if (unconfirmed.length) {
    console.warn(`  ${unconfirmed.length} record(s) are not confirmed published; nothing will be linked to them.`);
    for (const id of unconfirmed) {
      errorLog.log({ contentId: id, errorCode: 'PUBLISH_UNCONFIRMED', errorMessage: 'Content did not report isPublished after publish' });
    }
  }
  saveCheckpoint(state, cfg);
}

module.exports = { runUpload, titleFor, fileNameFor, CONFIRM_THRESHOLD };
