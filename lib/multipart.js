'use strict';

const crypto = require('crypto');

// Builds a multipart/form-data body. Salesforce's Connect API is strict about
// part names - the CMS content create rejects any binary part not called
// "contentData" - so callers name every part explicitly.
//
// parts: [{ name, filename, contentType, body: Buffer|string }]
function buildMultipartBody(parts) {
  const boundary = `----sfcmsboundary${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];

  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${escapeHeaderValue(part.filename)}"`;
    header += `\r\nContent-Type: ${part.contentType}\r\n\r\n`;

    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(String(part.body), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return { boundary, buffer: Buffer.concat(chunks) };
}

// A quote or CR/LF in a filename would break out of the Content-Disposition
// header. Source filenames come from third-party URLs, so they are not trusted.
function escapeHeaderValue(value) {
  return String(value).replace(/[\r\n]/g, ' ').replace(/"/g, "'");
}

module.exports = { buildMultipartBody, escapeHeaderValue };
