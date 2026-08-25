'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpload } = require('../lib/upload');
const { buildNames } = require('../lib/csv-load');
const checkpoint = require('../lib/checkpoint');
const { createFakeOrg, createErrorLogStub, WORKSPACE } = require('./fake-org');

const BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// Checkpoint and journal writes are relative to cwd, so each run gets its own
// throwaway directory rather than littering the repo.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salsify-test-'));
  const prev = process.cwd();
  process.chdir(dir);
  return () => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); };
}

function makeCfg(overrides = {}) {
  return {
    org: 'testorg', workspaceId: WORKSPACE, folderId: null, action: 'swap', entity: 'product',
    dryRun: false, force: false, yes: true, unpublish: true,
    paceMs: 0, batchSize: 25, downloadConcurrency: 1, uploadConcurrency: 1,
    cacheDir: os.tmpdir(), csvPath: 'test.csv', ...overrides,
  };
}

// Pre-seeding the cache file is what keeps the download phase - and the network
// - out of these tests: it only fetches URLs that have no cacheFile yet.
function seedWork(state, urls) {
  return urls.map((url, i) => {
    const cacheFile = path.join(os.tmpdir(), `salsify-test-img-${process.pid}-${i}.png`);
    fs.writeFileSync(cacheFile, BYTES);
    state.images[url] = { cacheFile, mimeType: 'image/png', bytes: BYTES.length, status: 'downloaded' };
    return { sourceUrl: url, identifiers: ['SKU1'], firstRow: 2, title: 'Test Product', ...buildNames(url) };
  });
}

async function run({ org, cfg: cfgOverrides = {}, urls }) {
  const restore = sandbox();
  try {
    const { client, org: fake } = createFakeOrg(org);
    const cfg = makeCfg(cfgOverrides);
    const state = checkpoint.emptyState(cfg, '00D000000000001EAA');
    const errorLog = createErrorLogStub();
    const work = seedWork(state, urls);
    const step = await runUpload({ client, state, cfg, work, errorLog });
    return { fake, state, errorLog, step, image: state.images[urls[0]] };
  } finally {
    restore();
  }
}

const URL_A = 'https://images.salsify.com/image/upload/s--abc--/one.jpg';

test('a pointer resolves the URL and nothing is uploaded', async () => {
  const { fake, image, step } = await run({
    urls: [URL_A],
    org: {
      contents: [{ Id: '20Y000000000001AAA', ExternalId: 'binimg-whatever', isPublished: true }],
      mediaSources: [{ Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000001AAA' }],
    },
  });

  assert.equal(image.contentId, '20Y000000000001AAA');
  assert.equal(image.origin, 'pointer');
  assert.equal(step.reused, 1);
  assert.equal(fake.calls.create.length, 0, 'nothing uploaded');
  assert.equal(fake.calls.upsert.length, 0, 'no pointer written - one already existed');
});

test('content found by externalId gets the pointer it was missing', async () => {
  const { externalId } = buildNames(URL_A);
  const { fake, image } = await run({
    urls: [URL_A],
    org: { contents: [{ Id: '20Y000000000002AAA', ExternalId: externalId, isPublished: true }] },
  });

  assert.equal(image.contentId, '20Y000000000002AAA');
  assert.equal(image.origin, 'externalId');
  assert.equal(fake.calls.create.length, 0, 'nothing uploaded');
  assert.equal(fake.mediaSources.length, 1, 'the missing pointer was backfilled');
  assert.equal(fake.mediaSources[0].Source_URL__c, URL_A);
  assert.equal(fake.mediaSources[0].Managed_Content_Id__c, '20Y000000000002AAA');
});

test('an unknown URL is uploaded and recorded', async () => {
  const { fake, image } = await run({ urls: [URL_A], org: {} });

  assert.equal(fake.calls.create.length, 1, 'one upload');
  assert.equal(image.origin, 'created');
  assert.equal(image.published, true);
  assert.equal(fake.mediaSources.length, 1);
  assert.equal(fake.mediaSources[0].Source_URL__c, URL_A);
  assert.equal(fake.mediaSources[0].Managed_Content_Id__c, image.contentId);
});

test('a pointer naming content that no longer exists is ignored, not linked', async () => {
  const { fake, image, errorLog } = await run({
    urls: [URL_A],
    org: { mediaSources: [{ Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000009AAA' }] },
  });

  assert.ok(errorLog.codes().includes('MEDIA_SOURCE_DANGLING'));
  assert.notEqual(image.contentId, '20Y000000000009AAA', 'never adopts the dead id');
  assert.equal(fake.calls.create.length, 1, 'falls through to a fresh upload');
});

test('a pointer naming content in another workspace is ignored', async () => {
  const { fake, image, errorLog } = await run({
    urls: [URL_A],
    org: {
      contents: [{ Id: '20Y000000000003AAA', ExternalId: 'binimg-elsewhere', AuthoredManagedContentSpaceId: '0Zu000000000999AAA' }],
      mediaSources: [{ Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000003AAA' }],
    },
  });

  assert.ok(errorLog.codes().includes('MEDIA_SOURCE_WRONG_WORKSPACE'));
  assert.notEqual(image.contentId, '20Y000000000003AAA');
  assert.equal(fake.calls.create.length, 1);
});

test('duplicate pointers resolve to the lowest Id, deterministically', async () => {
  const { image } = await run({
    urls: [URL_A],
    org: {
      contents: [
        { Id: '20Y000000000004AAA', ExternalId: 'binimg-a', isPublished: true },
        { Id: '20Y000000000005AAA', ExternalId: 'binimg-b', isPublished: true },
      ],
      mediaSources: [
        { Id: 'a0X002', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000005AAA' },
        { Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000004AAA' },
      ],
    },
  });
  assert.equal(image.contentId, '20Y000000000004AAA');
});

test('adopted content that is not published is published before anything links to it', async () => {
  const { fake, image } = await run({
    urls: [URL_A],
    org: {
      contents: [{ Id: '20Y000000000006AAA', ExternalId: 'binimg-x', isPublished: false }],
      mediaSources: [{ Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000006AAA' }],
    },
  });

  assert.deepEqual(fake.calls.publish, [['20Y000000000006AAA']]);
  assert.equal(image.published, true);
});

test('a failed pointer write does not fail the image', async () => {
  const restore = sandbox();
  try {
    const { client, org } = createFakeOrg({});
    org.upsertFails = true;
    const cfg = makeCfg();
    const state = checkpoint.emptyState(cfg, '00D000000000001EAA');
    const errorLog = createErrorLogStub();
    const work = seedWork(state, [URL_A]);

    const step = await runUpload({ client, state, cfg, work, errorLog });

    assert.equal(step.succeeded, 1, 'the image itself uploaded');
    assert.equal(state.images[URL_A].published, true, 'and is publishable and linkable');
    assert.equal(state.images[URL_A].mediaSourceStatus, 'failed');
    assert.ok(errorLog.codes().includes('FIELD_CUSTOM_VALIDATION_EXCEPTION'));
    // The promise that "a later run will retry it" is only true if the step
    // does not report itself finished.
    assert.equal(step.status, 'pending', 'the step stays retryable');
  } finally {
    restore();
  }
});

test('a dry run writes nothing at all', async () => {
  const { fake, errorLog } = await run({
    urls: [URL_A],
    cfg: { dryRun: true },
    org: {},
  });

  assert.equal(fake.calls.create.length, 0, 'no content created');
  assert.equal(fake.calls.upsert.length, 0, 'no pointer written');
  assert.equal(fake.calls.publish.length, 0, 'nothing published');
  assert.equal(errorLog.count, 0);
});

test('a dry run still reads the pointer, so its plan reflects reality', async () => {
  const { fake, image } = await run({
    urls: [URL_A],
    cfg: { dryRun: true },
    org: {
      contents: [{ Id: '20Y000000000007AAA', ExternalId: 'binimg-y', isPublished: true }],
      mediaSources: [{ Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000007AAA' }],
    },
  });

  assert.equal(image.contentId, '20Y000000000007AAA');
  assert.equal(image.origin, 'pointer');
  assert.equal(fake.calls.upsert.length, 0);
});

test('one upload serves several identifiers sharing a URL', async () => {
  const restore = sandbox();
  try {
    const { client, org } = createFakeOrg({});
    const cfg = makeCfg();
    const state = checkpoint.emptyState(cfg, '00D000000000001EAA');
    const errorLog = createErrorLogStub();
    const work = seedWork(state, [URL_A]);
    work[0].identifiers = ['SKU1', 'SKU2', 'SKU3'];

    await runUpload({ client, state, cfg, work, errorLog });

    assert.equal(org.calls.create.length, 1);
    assert.equal(org.mediaSources.length, 1, 'one URL, one source record');
  } finally {
    restore();
  }
});

test('a malformed pointer id does not take the run down with it', async () => {
  const { externalId } = buildNames(URL_A);
  const { fake, image, errorLog } = await run({
    urls: [URL_A],
    org: {
      contents: [{ Id: '20Y000000000008AAA', ExternalId: externalId, isPublished: true }],
      // A trailing space is enough: SOQL rejects the whole Id IN () filter.
      mediaSources: [{ Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000008AAA ' }],
    },
  });

  assert.ok(errorLog.codes().includes('MEDIA_SOURCE_MALFORMED_ID'));
  assert.equal(image.contentId, '20Y000000000008AAA', 'still resolved, by externalId');
  assert.equal(fake.calls.create.length, 0, 'and nothing was uploaded needlessly');
});

test('a broken low-Id row does not hide a good high-Id row', async () => {
  const { image, errorLog } = await run({
    urls: [URL_A],
    org: {
      contents: [{ Id: '20Y000000000010AAA', ExternalId: 'binimg-good', isPublished: true }],
      mediaSources: [
        // Lowest Id, but names content that no longer exists.
        { Id: 'a0X001', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000099AAA' },
        { Id: 'a0X002', Source_URL__c: URL_A, Managed_Content_Id__c: '20Y000000000010AAA' },
      ],
    },
  });

  assert.equal(image.contentId, '20Y000000000010AAA', 'the usable row wins');
  assert.equal(image.origin, 'pointer');
  assert.equal(errorLog.count, 0, 'a recovered URL is not an error');
});

test('a URL too long for the field is never sent to the API', async () => {
  const long = 'https://images.salsify.com/image/upload/s--x--/' + 'a'.repeat(260) + '.jpg';
  const restore = sandbox();
  try {
    const { client, org } = createFakeOrg({});
    const cfg = makeCfg();
    const state = checkpoint.emptyState(cfg, '00D000000000001EAA');
    const errorLog = createErrorLogStub();
    const work = seedWork(state, [long]);

    const step = await runUpload({ client, state, cfg, work, errorLog });

    assert.equal(step.succeeded, 1, 'the image still uploads');
    assert.equal(org.calls.upsert.length, 0, 'no doomed upsert is attempted');
    assert.equal(step.status, 'completed', 'and it is not a failure that blocks the run');
  } finally {
    restore();
  }
});
