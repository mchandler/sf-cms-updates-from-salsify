'use strict';

const { API_VERSION, sleep } = require('./http');

const SOQL_IN_CHUNK = 200;
const SOQL_PACE_MS = 100;

function escapeSoqlValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function queryPath(soql) {
  return `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
}

async function queryAll(client, soql) {
  const records = [];
  let path = queryPath(soql);
  while (path) {
    const res = await client.get(path);
    if (res && Array.isArray(res.records)) records.push(...res.records);
    path = res && res.nextRecordsUrl ? res.nextRecordsUrl : null;
  }
  return records;
}

// Queries go out as GET, so the whole SOQL statement rides in the request
// line, and Salesforce answers 431 once that passes roughly 16 KB. A count cap
// alone is fine for Ids but not for long values: 200 URL-encoded source URLs
// come to about 22 KB. Chunks therefore also close on the encoded length of
// the request path, with headroom left for the host and the rest of the line.
const SOQL_MAX_ENCODED = 12000;
const ENCODED_COMMA = encodeURIComponent(',').length;

function inListChunks(values, buildSoql) {
  const baseLength = queryPath(buildSoql('')).length;
  const chunks = [];
  let current = [];
  let length = baseLength;
  for (const v of values) {
    const quoted = `'${escapeSoqlValue(v)}'`;
    const cost = encodeURIComponent(quoted).length;
    if (current.length > 0 && (current.length >= SOQL_IN_CHUNK || length + ENCODED_COMMA + cost > SOQL_MAX_ENCODED)) {
      chunks.push(current.join(','));
      current = [];
      length = baseLength;
    }
    length += cost + (current.length > 0 ? ENCODED_COMMA : 0);
    current.push(quoted);
  }
  if (current.length > 0) chunks.push(current.join(','));
  return chunks;
}

async function chunkedQuery(client, values, buildSoql, paceMs = SOQL_PACE_MS) {
  const unique = [...new Set([...values].filter((v) => v && String(v).trim() !== ''))];
  const chunks = inListChunks(unique, buildSoql);
  const records = [];
  for (let i = 0; i < chunks.length; i++) {
    records.push(...(await queryAll(client, buildSoql(chunks[i]))));
    if (i + 1 < chunks.length && paceMs > 0) await sleep(paceMs);
  }
  return records;
}

// A multi-store org can hold several ElectronicMediaGroup records sharing a
// DeveloperName. This tool rewrites media links, so guessing wrong would repoint
// images for the wrong store. Refuse instead, and let the operator pin the Id.
async function fetchMediaGroups(client, groupNames, pinned = {}) {
  const inList = groupNames.map((n) => `'${escapeSoqlValue(n)}'`).join(',');
  const records = await queryAll(
    client,
    `SELECT Id, DeveloperName FROM ElectronicMediaGroup WHERE DeveloperName IN (${inList}) ORDER BY Id`
  );

  const byName = new Map();
  for (const r of records) {
    if (!byName.has(r.DeveloperName)) byName.set(r.DeveloperName, []);
    byName.get(r.DeveloperName).push(r.Id);
  }

  const missing = groupNames.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new Error(`Org is missing ElectronicMediaGroup record(s) with DeveloperName: ${missing.join(', ')}`);
  }

  const resolved = new Map();
  const ambiguous = [];
  for (const name of groupNames) {
    const ids = byName.get(name);
    if (ids.length === 1) {
      resolved.set(name, ids[0]);
      continue;
    }
    const pin = pinned[name];
    if (!pin) {
      ambiguous.push(`${name} (${ids.join(', ')})`);
      continue;
    }
    if (!ids.includes(pin)) {
      throw new Error(`--group ${name}=${pin} does not match any ElectronicMediaGroup with that DeveloperName: ${ids.join(', ')}`);
    }
    resolved.set(name, pin);
  }

  if (ambiguous.length) {
    throw new Error(
      `More than one ElectronicMediaGroup shares a DeveloperName: ${ambiguous.join('; ')}.\n` +
      'Re-run with --group <name>=<id> for each, so the correct store is targeted explicitly.'
    );
  }

  return resolved;
}

// Neither Product2.ProductCode nor ProductCategory.External_Id__c is
// guaranteed unique, and this tool removes media links - guessing which record
// an identifier meant is not recoverable. Ambiguous values are reported and
// dropped rather than resolved arbitrarily.
//
// The label comes back with the Id because the CMS title is set at creation and
// can never be changed afterwards, so it has to be right the first time.
async function fetchParents(client, entity, identifiers, paceMs = SOQL_PACE_MS) {
  const records = await chunkedQuery(
    client,
    identifiers,
    (inList) =>
      `SELECT Id, Name, ${entity.matchField} FROM ${entity.sobject} ` +
      `WHERE ${entity.matchField} IN (${inList})`,
    paceMs
  );

  const map = new Map();
  const labels = new Map();
  const ambiguous = new Set();
  for (const r of records) {
    const key = r[entity.matchField];
    if (!key) continue;
    if (map.has(key)) {
      ambiguous.add(key);
      continue;
    }
    map.set(key, r.Id);
    labels.set(r.Id, entity.name === 'product' ? `${r.Name} - ${key}` : r.Name);
  }
  for (const key of ambiguous) {
    labels.delete(map.get(key));
    map.delete(key);
  }

  return { map, labels, ambiguous };
}

async function fetchLinksByParent(client, entity, parentIds, groupIds, paceMs = SOQL_PACE_MS) {
  const groupList = groupIds.map((id) => `'${escapeSoqlValue(id)}'`).join(',');
  return chunkedQuery(
    client,
    parentIds,
    (inList) =>
      `SELECT Id, ${entity.parentField}, ElectronicMediaId, ElectronicMediaGroupId, SortOrder ` +
      `FROM ${entity.object} WHERE ${entity.parentField} IN (${inList}) AND ElectronicMediaGroupId IN (${groupList})`,
    paceMs
  );
}

// No group predicate: the unpublish guard has to see every reference, including
// ones held by media groups this run does not manage.
async function fetchLinksByContent(client, junction, contentIds, paceMs = SOQL_PACE_MS) {
  return chunkedQuery(
    client,
    contentIds,
    (inList) =>
      `SELECT Id, ${junction.parentField}, ElectronicMediaId, ElectronicMediaGroupId ` +
      `FROM ${junction.object} WHERE ElectronicMediaId IN (${inList})`,
    paceMs
  );
}

// The workspace predicate is not optional: ExternalId is unique per content
// space at best, and adopting a record from another space would link the
// storefront to content its channel does not serve.
async function fetchExistingContentByExternalId(client, workspaceId, externalIds, paceMs = SOQL_PACE_MS) {
  const records = await chunkedQuery(
    client,
    externalIds,
    (inList) =>
      `SELECT Id, ExternalId, AuthoredManagedContentSpaceId FROM ManagedContent ` +
      `WHERE AuthoredManagedContentSpaceId = '${escapeSoqlValue(workspaceId)}' AND ExternalId IN (${inList})`,
    paceMs
  );
  const map = new Map();
  for (const r of records) {
    if (r.AuthoredManagedContentSpaceId !== workspaceId) continue;
    map.set(r.ExternalId, r.Id);
  }
  return map;
}

// A CMS_Media_Source__c row holds its content id in a plain text field, so
// nothing in the org guarantees the target still exists or that it lives in the
// workspace this run is writing to. Linking a storefront to a dangling or
// foreign content id is exactly the kind of damage the ExternalId lookup's
// workspace predicate already guards against, so pointers get the same check.
async function fetchContentByIds(client, contentIds, paceMs = SOQL_PACE_MS) {
  const records = await chunkedQuery(
    client,
    contentIds,
    (inList) =>
      `SELECT Id, ExternalId, AuthoredManagedContentSpaceId FROM ManagedContent WHERE Id IN (${inList})`,
    paceMs
  );
  // Keyed on both forms: the API returns 18-character ids, but a row written by
  // hand may hold the 15-character one.
  const map = new Map();
  for (const r of records) {
    map.set(r.Id, r);
    map.set(String(r.Id).slice(0, 15), r);
  }
  return map;
}

async function fetchOrgId(client) {
  const res = await queryAll(client, 'SELECT Id FROM Organization LIMIT 1');
  return res[0] ? res[0].Id : null;
}

module.exports = {
  SOQL_IN_CHUNK,
  escapeSoqlValue,
  queryAll,
  chunkedQuery,
  fetchMediaGroups,
  fetchParents,
  fetchLinksByParent,
  fetchLinksByContent,
  fetchExistingContentByExternalId,
  fetchContentByIds,
  fetchOrgId,
};
