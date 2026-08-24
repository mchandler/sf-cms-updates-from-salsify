'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify');

const { timestampSlug } = require('./error-log');

const COLUMNS = [
  'row', 'identifier', 'entity', 'action', 'parentId', 'sourceUrl',
  'contentId', 'contentStatus', 'groups', 'displacedContentIds',
  'displacedOutcome', 'status', 'error',
];

// Streamed rather than assembled at the end: a large run lasts a long time and
// this is the audit trail a crash must not take with it.
function createReport(orgAlias, action) {
  const file = path.resolve(process.cwd(), `report-${orgAlias}-${action}-${timestampSlug()}.csv`);
  const stringifier = stringify({ header: true, columns: COLUMNS });
  const stream = fs.createWriteStream(file);
  stringifier.pipe(stream);
  let rows = 0;

  return {
    file,
    get rows() { return rows; },
    write(row) {
      rows++;
      stringifier.write({
        row: row.row ?? '',
        identifier: row.identifier ?? '',
        entity: row.entity ?? '',
        action: row.action ?? '',
        parentId: row.parentId ?? '',
        sourceUrl: row.sourceUrl ?? '',
        contentId: row.contentId ?? '',
        contentStatus: row.contentStatus ?? '',
        groups: row.groups ?? '',
        displacedContentIds: row.displacedContentIds ?? '',
        displacedOutcome: row.displacedOutcome ?? '',
        status: row.status ?? '',
        error: String(row.error ?? '').slice(0, 500),
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
        stringifier.end();
      });
    },
  };
}

// One row per CSV row, whether it was processed or skipped, so the report
// accounts for the whole input rather than only the successful part.
function writeRunReport(report, { cfg, entity, state, rows, targetsByIdentifier, skipped }) {
  const displacedByIdentifier = new Map();
  for (const [contentId, entry] of Object.entries(state.displaced || {})) {
    for (const identifier of entry.identifiers || []) {
      if (!displacedByIdentifier.has(identifier)) displacedByIdentifier.set(identifier, []);
      displacedByIdentifier.get(identifier).push({ contentId, status: entry.status, reason: entry.reason });
    }
  }

  for (const row of rows) {
    const image = row.url ? (state.images || {})[row.url] : null;
    const target = targetsByIdentifier.get(row.identifier);
    const displaced = displacedByIdentifier.get(row.identifier) || [];
    const reason = row.skipReason || skipped.get(row.identifier) || null;

    report.write({
      row: row.rowNum,
      identifier: row.identifier,
      entity: entity.name,
      action: cfg.action,
      parentId: target ? target.parentId : '',
      sourceUrl: row.url,
      contentId: image ? image.contentId : '',
      contentStatus: image ? image.status : '',
      groups: target ? entity.groups.join(' ') : '',
      displacedContentIds: displaced.map((d) => d.contentId).join(' '),
      displacedOutcome: [...new Set(displaced.map((d) => d.status).filter(Boolean))].join(' '),
      status: reason ? 'skipped' : (target ? 'processed' : 'skipped'),
      error: reason || (target ? '' : 'not processed'),
    });
  }
}

module.exports = { createReport, writeRunReport, COLUMNS };
