'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCsv } = require('../lib/csv-load');
const { planLinks } = require('../lib/link');
const { resolveEntity, restrictGroups, defaultGroupsFor } = require('../lib/entities');

const URL_A = 'https://images.salsify.com/image/upload/a.jpg';
const URL_B = 'https://images.salsify.com/image/upload/b.jpg';

function csvFile(body) {
  const file = path.join(os.tmpdir(), `salsify-csv-${process.pid}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(file, body);
  return file;
}

test('add accepts two urls for one identifier; swap still refuses them', async () => {
  const file = csvFile(`identifier,url\n9211774,${URL_A}\n9211774,${URL_B}\n`);
  try {
    const forAdd = await loadCsv(file, { allowRepeatIdentifier: true });
    assert.equal(forAdd.stats.eligible, 2);
    assert.equal(forAdd.stats.distinctIdentifiers, 1);

    const forSwap = await loadCsv(file, { allowRepeatIdentifier: false });
    assert.equal(forSwap.stats.eligible, 1);
    assert.match(forSwap.rows[1].skipReason, /conflicting url/);
  } finally {
    fs.unlinkSync(file);
  }
});

// The duplicate rule is about the pair, not the identifier: the same image twice
// would ask for one link to be created twice.
test('an identical row is still dropped, even for add', async () => {
  const file = csvFile(`identifier,url\n9211774,${URL_A}\n9211774,${URL_A}\n`);
  try {
    const csv = await loadCsv(file, { allowRepeatIdentifier: true });
    assert.equal(csv.stats.eligible, 1);
    assert.match(csv.rows[1].skipReason, /duplicate row/);
  } finally {
    fs.unlinkSync(file);
  }
});

test('add defaults to the detail group for products and leaves the list tile alone', () => {
  const groups = defaultGroupsFor('product', 'add');
  assert.deepEqual(groups, ['productDetailImage']);
  assert.deepEqual(restrictGroups(resolveEntity('product'), groups).groups, ['productDetailImage']);

  // Only `add` is narrowed; swap still writes both groups.
  assert.equal(defaultGroupsFor('product', 'swap'), null);
  assert.deepEqual(resolveEntity('product').groups, ['productListImage', 'productDetailImage']);
});

test('two adds for one product take consecutive sort orders after what exists', () => {
  const entity = restrictGroups(resolveEntity('product'), ['productDetailImage']);
  const groupIdByName = new Map([['productDetailImage', '0ZG000000000001']]);
  const targets = [
    { identifier: '9211774', rowNum: 2, parentId: '01t000000000001', contentId: 'CONTENT_A', sourceUrl: URL_A },
    { identifier: '9211774', rowNum: 3, parentId: '01t000000000001', contentId: 'CONTENT_B', sourceUrl: URL_B },
  ];
  const existingLinks = [{
    Id: '0ZM000000000001', ProductId: '01t000000000001',
    ElectronicMediaId: 'CONTENT_OLD', ElectronicMediaGroupId: '0ZG000000000001', SortOrder: 0,
  }];

  const { deletes, inserts, kept } = planLinks({ action: 'add', entity, targets, existingLinks, groupIdByName });
  assert.equal(deletes.length, 0);
  assert.equal(kept, 0);
  assert.deepEqual(inserts.map((i) => [i.contentId, i.sortOrder]), [['CONTENT_A', 1], ['CONTENT_B', 2]]);
});

// Two distinct urls can resolve to one adopted content record, which would
// otherwise plan the identical link twice in a single run.
test('two rows resolving to the same content produce one link', () => {
  const entity = restrictGroups(resolveEntity('product'), ['productDetailImage']);
  const groupIdByName = new Map([['productDetailImage', '0ZG000000000001']]);
  const targets = [
    { identifier: '9211774', rowNum: 2, parentId: '01t000000000001', contentId: 'CONTENT_A', sourceUrl: URL_A },
    { identifier: '9211774', rowNum: 3, parentId: '01t000000000001', contentId: 'CONTENT_A', sourceUrl: URL_B },
  ];

  const { inserts, kept } = planLinks({ action: 'add', entity, targets, existingLinks: [], groupIdByName });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].sortOrder, 0);
  assert.equal(kept, 1);
});

test('an add already present in the org is kept, not stacked', () => {
  const entity = restrictGroups(resolveEntity('product'), ['productDetailImage']);
  const groupIdByName = new Map([['productDetailImage', '0ZG000000000001']]);
  const targets = [
    { identifier: '9211774', rowNum: 2, parentId: '01t000000000001', contentId: 'CONTENT_A', sourceUrl: URL_A },
    { identifier: '9211774', rowNum: 3, parentId: '01t000000000001', contentId: 'CONTENT_B', sourceUrl: URL_B },
  ];
  const existingLinks = [{
    Id: '0ZM000000000001', ProductId: '01t000000000001',
    ElectronicMediaId: 'CONTENT_A', ElectronicMediaGroupId: '0ZG000000000001', SortOrder: 3,
  }];

  const { inserts, kept } = planLinks({ action: 'add', entity, targets, existingLinks, groupIdByName });
  assert.equal(kept, 1);
  assert.deepEqual(inserts.map((i) => [i.contentId, i.sortOrder]), [['CONTENT_B', 4]]);
});
