'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mediaSource = require('../lib/media-source');
const { createFakeOrg } = require('./fake-org');

test('indexByUrl keeps every row for a URL, ordered by Id', () => {
  const { byUrl, duplicates } = mediaSource.indexByUrl([
    { Id: 'a0X002', Source_URL__c: 'https://x/1.jpg', Managed_Content_Id__c: '20Y002' },
    { Id: 'a0X001', Source_URL__c: 'https://x/1.jpg', Managed_Content_Id__c: '20Y001' },
    { Id: 'a0X003', Source_URL__c: 'https://x/2.jpg', Managed_Content_Id__c: '20Y003' },
  ]);

  // Both survive: the caller cannot tell which is usable until it has looked at
  // the content they name.
  assert.deepEqual(byUrl.get('https://x/1.jpg').map((r) => r.contentId), ['20Y001', '20Y002']);
  assert.deepEqual(byUrl.get('https://x/2.jpg').map((r) => r.contentId), ['20Y003']);
  assert.deepEqual(duplicates, ['https://x/1.jpg']);
});

test('isWellFormedId rejects what SOQL would refuse to filter on', () => {
  assert.equal(mediaSource.isWellFormedId('20YWr000002uUIPMA2'), true);
  assert.equal(mediaSource.isWellFormedId('20YWr000002uUIP'), true, '15-character form');
  assert.equal(mediaSource.isWellFormedId('20YWr000002uUIPMA2 '), false, 'trailing space breaks the query');
  assert.equal(mediaSource.isWellFormedId('not-an-id'), false);
  assert.equal(mediaSource.isWellFormedId(''), false);
  assert.equal(mediaSource.isWellFormedId(null), false);
});

test('indexByUrl ignores rows missing either half of the mapping', () => {
  const { byUrl } = mediaSource.indexByUrl([
    { Id: 'a0X001', Source_URL__c: '', Managed_Content_Id__c: '20Y001' },
    { Id: 'a0X002', Source_URL__c: 'https://x/2.jpg', Managed_Content_Id__c: null },
  ]);
  assert.equal(byUrl.size, 0);
});

test('assertAvailable requires update rights, since the write is an upsert', async () => {
  const { client, org } = createFakeOrg();
  org.describe = {
    createable: true, queryable: true, updateable: false,
    fields: [
      { name: 'Source_URL__c', createable: true, updateable: true },
      { name: 'Managed_Content_Id__c', createable: true, updateable: true },
    ],
  };
  await assert.rejects(() => mediaSource.assertAvailable(client), /cannot update/);
});

test('assertAvailable names a permissions problem when describe is forbidden', async () => {
  const { client, org } = createFakeOrg();
  org.describeForbidden = true;
  await assert.rejects(() => mediaSource.assertAvailable(client), /no access to CMS_Media_Source__c/);
});

test('idKey compares 15- and 18-character ids as the same record', () => {
  assert.equal(mediaSource.idKey('20YWr000002s1u1MAA'), mediaSource.idKey('20YWr000002s1u1'));
});

test('a URL longer than the field is never queried - it could not have been stored', async () => {
  const { client, org } = createFakeOrg();
  const long = 'https://images.salsify.com/' + 'a'.repeat(300);
  const { byUrl } = await mediaSource.fetchByUrls(client, [long], 0);
  assert.equal(byUrl.size, 0);
  assert.equal(org.calls.query.length, 0, 'no query should be issued');
});

test('upsertPointers batches at 200 and keys on the external id', async () => {
  const { client, org } = createFakeOrg();
  const rows = Array.from({ length: 205 }, (_, i) => ({ sourceUrl: `https://x/${i}.jpg`, contentId: `20Y${i}` }));

  const results = await mediaSource.upsertPointers(client, rows);

  assert.equal(results.length, 205);
  assert.equal(org.calls.upsert.length, 2, 'two batches');
  assert.equal(org.calls.upsert[0].length, 200);
  assert.equal(org.calls.upsert[1].length, 5);
  assert.ok(results.every((r) => r.success));
  assert.equal(org.calls.upsert[0][0].Managed_Content_Id__c, '20Y0');
  assert.equal(org.calls.upsert[0][0].attributes.type, 'CMS_Media_Source__c');
});

test('upsertPointers is idempotent - a second pass creates nothing new', async () => {
  const { client, org } = createFakeOrg();
  const rows = [{ sourceUrl: 'https://x/1.jpg', contentId: '20Y001' }];

  await mediaSource.upsertPointers(client, rows);
  await mediaSource.upsertPointers(client, rows);

  assert.equal(org.mediaSources.length, 1);
});

test('a whole-batch failure is reported per row, not swallowed', async () => {
  const { client } = createFakeOrg();
  client.patch = async () => { const e = new Error('boom'); e.body = 'server said no'; throw e; };

  const results = await mediaSource.upsertPointers(client, [
    { sourceUrl: 'https://x/1.jpg', contentId: '20Y001' },
    { sourceUrl: 'https://x/2.jpg', contentId: '20Y002' },
  ]);

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.success === false));
  assert.equal(results[0].errorCode, 'MEDIA_SOURCE_REQUEST_FAILED');
});

test('assertAvailable explains a missing object rather than throwing a 404', async () => {
  const { client, org } = createFakeOrg();
  org.describeMissing = true;
  await assert.rejects(() => mediaSource.assertAvailable(client), /has no CMS_Media_Source__c object/);
});

test('assertAvailable refuses a field the running user cannot write', async () => {
  const { client, org } = createFakeOrg();
  org.describe = {
    createable: true, queryable: true, updateable: true,
    fields: [
      { name: 'Source_URL__c', createable: false, updateable: true },
      { name: 'Managed_Content_Id__c', createable: true, updateable: true },
    ],
  };
  await assert.rejects(() => mediaSource.assertAvailable(client), /field-level security/);
});

test('assertAvailable passes on a healthy org', async () => {
  const { client } = createFakeOrg();
  assert.equal(await mediaSource.assertAvailable(client), true);
});
