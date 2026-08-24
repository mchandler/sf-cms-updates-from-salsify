'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify');

const COLUMNS = ['row', 'identifier', 'parentId', 'sourceUrl', 'group', 'contentId', 'errorCode', 'errorMessage'];

function timestampSlug() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function createErrorLog(orgAlias) {
  const file = path.resolve(process.cwd(), `errors-${orgAlias}-${timestampSlug()}.csv`);
  let stringifier = null;
  let stream = null;

  const api = {
    file,
    count: 0,
    log(record) {
      // Created lazily so a clean run leaves no empty CSV behind.
      if (!stringifier) {
        stringifier = stringify({ header: true, columns: COLUMNS });
        stream = fs.createWriteStream(file);
        stringifier.pipe(stream);
      }
      api.count++;
      stringifier.write({
        row: record.row ?? '',
        identifier: record.identifier ?? '',
        parentId: record.parentId ?? '',
        sourceUrl: record.sourceUrl ?? '',
        group: record.group ?? '',
        contentId: record.contentId ?? '',
        errorCode: record.errorCode ?? '',
        errorMessage: String(record.errorMessage ?? '').slice(0, 500),
      });
    },
    close() {
      if (!stringifier) return Promise.resolve();
      return new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
        stringifier.end();
      });
    },
  };

  return api;
}

module.exports = { createErrorLog, COLUMNS, timestampSlug };
