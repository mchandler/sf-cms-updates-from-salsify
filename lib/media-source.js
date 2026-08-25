'use strict';

const { API_VERSION, sleep } = require('./http');
const { chunkedQuery } = require('./lookups');

const OBJECT = 'CMS_Media_Source__c';
const URL_FIELD = 'Source_URL__c';
const CONTENT_FIELD = 'Managed_Content_Id__c';

// Managed_Content_Id__c is unique and flagged External Id, so the write is an
// upsert keyed on it rather than a read-then-insert. That makes the step
// idempotent - a re-run over the same content writes nothing new - and removes
// the race between two runs resolving the same URL at once.
const UPSERT_PATH = `/services/data/${API_VERSION}/composite/sobjects/${OBJECT}/${CONTENT_FIELD}`;
const UPSERT_BATCH = 200;

// Source_URL__c is Text(255). A longer URL cannot be stored, and the insert
// would fail with STRING_TOO_LONG part-way through a batch, taking the rest of
// the batch's diagnostics with it. Filtered out up front and reported instead.
const URL_MAX = 255;

// Ids come back from the Connect API as 18 characters, but a row written by
// hand or by another tool may hold the 15-character form. Both denote the same
// record, so comparisons are made on the case-sensitive 15-character prefix.
function idKey(id) {
  return String(id || '').slice(0, 15);
}

// Managed_Content_Id__c is free text, so it can hold anything a person typed.
// SOQL will not tolerate that: `WHERE Id IN ('not-an-id')` is rejected outright
// with "invalid ID field", and so is a well-formed id with a trailing space -
// which takes down the whole query, and with it the run, over one bad row.
// Anything that is not a bare 15- or 18-character id is reported as unusable
// and never reaches the query.
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

function isWellFormedId(id) {
  return SF_ID.test(String(id || ''));
}

// A missing object is a hard stop rather than a silent fall back to the old
// behaviour: every org this tool is pointed at is supposed to have it, so an
// absence means the wrong org or an undeployed change, and continuing would
// quietly produce content with no source record for anyone to find later.
async function assertAvailable(client) {
  let describe;
  try {
    describe = await client.get(`/services/data/${API_VERSION}/sobjects/${OBJECT}/describe`);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(
        `This org has no ${OBJECT} object.\n` +
        'It records which Salsify URL each CMS image came from, and this tool requires it.\n' +
        'Deploy the object and its Source_URL__c and Managed_Content_Id__c fields, then re-run.'
      );
    }
    // An object the running user cannot see describes as 403, not 404, and the
    // fix is a permission set rather than a deployment.
    if (e.status === 403) {
      throw new Error(
        `The running user has no access to ${OBJECT}.\n` +
        'This tool requires read and write on it. Grant access and re-run.'
      );
    }
    throw e;
  }

  // The write is an upsert keyed on an external id, so it updates an existing
  // row as readily as it inserts one - which is the ordinary case on a re-run
  // and on every backfill. Create permission alone is not enough.
  for (const [able, verb] of [['queryable', 'query'], ['createable', 'create'], ['updateable', 'update']]) {
    if (!describe[able]) throw new Error(`The running user cannot ${verb} ${OBJECT}. Check object permissions.`);
  }

  const byName = new Map((describe.fields || []).map((f) => [f.name, f]));
  for (const name of [URL_FIELD, CONTENT_FIELD]) {
    const field = byName.get(name);
    if (!field) throw new Error(`${OBJECT} has no ${name} field. Deploy the current version of the object and re-run.`);
    if (!field.createable || !field.updateable) {
      throw new Error(`The running user cannot write ${OBJECT}.${name}. Check field-level security.`);
    }
  }
  return true;
}

// Source_URL__c is not unique, so the org can hold more than one row per URL.
// Every one is kept, ordered by Id, because the caller cannot know which are
// usable until it has checked the content they name: picking the lowest Id here
// and discarding the rest would throw away a valid row in favour of a broken
// one, and - since a replacement row necessarily gets a higher Id - the run
// would fail the same way forever.
function indexByUrl(records) {
  const byUrl = new Map();
  const duplicates = [];

  for (const r of records) {
    const url = r[URL_FIELD];
    const contentId = r[CONTENT_FIELD];
    if (!url || !contentId) continue;

    if (!byUrl.has(url)) byUrl.set(url, []);
    const rows = byUrl.get(url);
    if (rows.length) duplicates.push(url);
    rows.push({ mediaSourceId: r.Id, contentId });
  }

  for (const rows of byUrl.values()) rows.sort((a, b) => (a.mediaSourceId < b.mediaSourceId ? -1 : 1));
  return { byUrl, duplicates: [...new Set(duplicates)] };
}

async function fetchByUrls(client, urls, paceMs) {
  const usable = [...urls].filter((u) => u && u.length <= URL_MAX);
  if (usable.length === 0) return { byUrl: new Map(), duplicates: [] };

  const records = await chunkedQuery(
    client,
    usable,
    (inList) => `SELECT Id, ${URL_FIELD}, ${CONTENT_FIELD} FROM ${OBJECT} WHERE ${URL_FIELD} IN (${inList})`,
    paceMs
  );
  return indexByUrl(records);
}

function toUpsertRecord(sourceUrl, contentId) {
  return {
    attributes: { type: OBJECT },
    [CONTENT_FIELD]: contentId,
    [URL_FIELD]: sourceUrl,
  };
}

// Rows are { sourceUrl, contentId }. Returns one result per row, in order, so
// the caller can attribute a failure to the URL that caused it.
//
// Managed_Content_Id__c is unique, so a content record has at most one row and
// this upsert overwrites whatever Source_URL__c it held. That is a correction
// rather than a loss: the content's ExternalId is a hash of the URL that made
// it, so a row disagreeing with the URL resolved here was already wrong.
async function upsertPointers(client, rows, { paceMs = 0 } = {}) {
  const results = [];

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const slice = rows.slice(i, i + UPSERT_BATCH);
    let batch = [];
    try {
      const res = await client.patch(UPSERT_PATH, {
        allOrNone: false,
        records: slice.map((r) => toUpsertRecord(r.sourceUrl, r.contentId)),
      });
      batch = Array.isArray(res) ? res : [];
    } catch (e) {
      // A whole-batch failure is still per-row news to the caller.
      const message = String(e.body || e.message).slice(0, 500);
      for (const row of slice) results.push({ ...row, success: false, errorCode: 'MEDIA_SOURCE_REQUEST_FAILED', errorMessage: message });
      if (paceMs > 0) await sleep(paceMs);
      continue;
    }

    for (let j = 0; j < slice.length; j++) {
      const r = batch[j];
      if (r && r.success) {
        results.push({ ...slice[j], success: true, mediaSourceId: r.id });
        continue;
      }
      const first = ((r && r.errors) || [])[0] || {};
      results.push({
        ...slice[j],
        success: false,
        errorCode: first.statusCode || 'MEDIA_SOURCE_UPSERT_FAILED',
        errorMessage: String(first.message || JSON.stringify(r)).slice(0, 500),
      });
    }

    if (paceMs > 0 && i + UPSERT_BATCH < rows.length) await sleep(paceMs);
  }

  return results;
}

module.exports = {
  OBJECT, URL_FIELD, CONTENT_FIELD, URL_MAX, UPSERT_BATCH, UPSERT_PATH,
  assertAvailable, fetchByUrls, indexByUrl, upsertPointers, toUpsertRecord, idKey, isWellFormedId,
};
