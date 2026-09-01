'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

// Header matching is deliberately loose: the documented columns are
// "identifier" and "url", but exports in the wild arrive as "SKU",
// "ProductCode", "External_Id__c", "Image URL" and so on. Normalising to
// lowercase alphanumerics accepts all of them.
const IDENTIFIER_KEYS = ['identifier', 'sku', 'productcode', 'stockkeepingunit', 'externalid', 'externalidc', 'code', 'id'];
const URL_KEYS = ['url', 'imageurl', 'sourceurl', 'newurl', 'link'];

const NAME_MAX = 80;

function normalizeKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(normalized, candidates) {
  for (const c of candidates) {
    const v = normalized.get(c);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Keyed on the source URL, not the identifier: one upload then serves every
// product or category sharing that image. Deliberately the same `binimg-`
// namespace and derivation as ../sf-cms-url-to-binary, so a URL that tool has
// already brought into the org is adopted rather than uploaded a second time.
function externalIdFor(sourceUrl) {
  return `binimg-${crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`;
}

function slugFor(sourceUrl) {
  let last = sourceUrl;
  try { last = path.basename(new URL(sourceUrl).pathname) || sourceUrl; } catch (_) { /* use the raw string */ }
  const cleaned = last.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'image').slice(0, 40);
}

// The hash leads rather than trails. apiName must begin with a letter, may hold
// only underscores and alphanumerics, may not end in an underscore or contain
// two consecutive ones, and must be unique per content type - and a Salsify
// filename satisfies none of that reliably. Leading with the constant `binimg`
// prefix and the URL hash makes the name letter-initial and unique by
// construction, and keeps it unique after the 80-character truncation clips the
// human-readable tail.
function buildNames(sourceUrl) {
  const externalId = externalIdFor(sourceUrl);
  const slug = slugFor(sourceUrl);

  const urlName = `${externalId}-${slug}`.replace(/-+/g, '-').replace(/-+$/, '').slice(0, NAME_MAX).replace(/-+$/, '');
  const apiName = `${externalId}_${slug}`
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, NAME_MAX)
    .replace(/_+$/, '');

  return { externalId, urlName, apiName };
}

// A CSV row is addressed by identifier *and* url, never by identifier alone:
// `add` accepts several images for one product, so the identifier is not a key.
function rowKey(identifier, url) {
  return `${identifier}\u0000${url || ''}`;
}

// `delete` identifies the entity and removes whatever it currently holds, so a
// url column is meaningless there and is accepted blank or absent entirely.
//
// `allowRepeatIdentifier` is set for `add`, the one action where several rows
// for one identifier are meaningful: it appends, so two rows are two images.
// swap and delete keep the hard conflict, because there a second url is a
// question about which single image the entity should end up with, and the
// operator has to answer it.
async function loadCsv(csvPath, { requireUrl = true, allowRepeatIdentifier = false } = {}) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const rows = [];
  const byUrl = new Map();
  const rowsByIdentifier = new Map();

  const parser = fs.createReadStream(csvPath).pipe(
    parse({ bom: true, columns: true, relax_column_count: true, skip_empty_lines: true, trim: true })
  );

  let rowNum = 1;
  for await (const record of parser) {
    rowNum++;
    const normalized = new Map();
    for (const [k, v] of Object.entries(record)) normalized.set(normalizeKey(k), v);

    const identifier = pick(normalized, IDENTIFIER_KEYS);
    const url = pick(normalized, URL_KEYS);

    if (!identifier) {
      rows.push({ rowNum, identifier, url, skipReason: 'missing identifier' });
      continue;
    }
    if (requireUrl && !url) {
      rows.push({ rowNum, identifier, url, skipReason: 'missing url' });
      continue;
    }
    if (url && !isHttpUrl(url)) {
      rows.push({ rowNum, identifier, url, skipReason: `url is not a valid http(s) URL: "${url}"` });
      continue;
    }

    // The same identifier and url twice is a harmless duplicate in every action:
    // it would ask for one image to be linked to one entity twice, so the later
    // row is dropped rather than allowed to become a second identical link.
    const priorRows = rowsByIdentifier.get(identifier) || [];
    const sameUrl = priorRows.find((p) => p.url === url);
    if (sameUrl) {
      rows.push({
        rowNum, identifier, url,
        skipReason: `duplicate row for identifier "${identifier}" with the same url (first seen row ${sameUrl.rowNum})`,
      });
      continue;
    }
    if (priorRows.length && !allowRepeatIdentifier) {
      rows.push({
        rowNum, identifier, url,
        skipReason: `conflicting url for identifier "${identifier}" (row ${priorRows[0].rowNum} uses ${priorRows[0].url || '(blank)'})`,
      });
      continue;
    }
    priorRows.push({ rowNum, url });
    rowsByIdentifier.set(identifier, priorRows);

    if (url) {
      if (!byUrl.has(url)) {
        byUrl.set(url, { sourceUrl: url, identifiers: [], firstRow: rowNum, ...buildNames(url) });
      }
      byUrl.get(url).identifiers.push(identifier);
    }

    rows.push({ rowNum, identifier, url, skipReason: null });
  }

  // Deterministic, so a dry run and the real run agree and so --max-rows takes
  // the same slice every time.
  for (const image of byUrl.values()) image.identifiers.sort();

  const eligible = rows.filter((r) => !r.skipReason);
  return {
    rows,
    byUrl,
    stats: {
      totalRows: rowNum - 1,
      eligible: eligible.length,
      skipped: rows.length - eligible.length,
      distinctUrls: byUrl.size,
      distinctIdentifiers: new Set(eligible.map((r) => r.identifier)).size,
    },
  };
}

module.exports = { loadCsv, buildNames, externalIdFor, slugFor, isHttpUrl, rowKey, NAME_MAX };
