'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ATTEMPTS = 4;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

class DownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Magic bytes lead, because the source hosts sometimes serve an HTML error page
// under an image/jpeg content type. The header is a fallback and the URL
// extension a last resort.
function sniffMagic(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function mimeFromHeader(header) {
  if (!header) return null;
  const value = String(header).split(';')[0].trim().toLowerCase();
  return ALLOWED_MIME.has(value) ? value : null;
}

function mimeFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).replace('.', '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
  } catch (_) { /* not a parseable URL; nothing to infer */ }
  return null;
}

function sniffMime(buffer, contentTypeHeader, url) {
  return sniffMagic(buffer) || mimeFromHeader(contentTypeHeader) || mimeFromUrl(url);
}

function looksLikeHtml(buffer) {
  const head = buffer.subarray(0, 200).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml');
}

function urlHash(sourceUrl) {
  return crypto.createHash('sha256').update(sourceUrl).digest('hex');
}

function cachePathFor(cacheDir, sourceUrl, mimeType) {
  const ext = EXT_BY_MIME[mimeType] || 'bin';
  return path.join(cacheDir, `${urlHash(sourceUrl)}.${ext}`);
}

function findCached(cacheDir, sourceUrl) {
  const prefix = urlHash(sourceUrl);
  for (const ext of [...Object.values(EXT_BY_MIME), 'bin']) {
    const file = path.join(cacheDir, `${prefix}.${ext}`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  }
  return null;
}

function mimeForFile(file) {
  const ext = path.extname(file).replace('.', '').toLowerCase();
  for (const [mime, e] of Object.entries(EXT_BY_MIME)) if (e === ext) return mime;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deliberately uses bare fetch rather than the Salesforce client: no org access
// token may ever be attached to a third-party request.
async function fetchWithRetry(sourceUrl, { timeoutMs, maxAttempts }) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(15000, 1000 * Math.pow(2, attempt - 1)));
    try {
      const res = await fetch(sourceUrl, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 || res.status === 429) {
        lastError = new DownloadError(`HTTP_${res.status}`, `Source returned HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new DownloadError(`HTTP_${res.status}`, `Source returned HTTP ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    } catch (e) {
      if (e instanceof DownloadError && !/^HTTP_5|^HTTP_429/.test(e.code)) throw e;
      lastError = e.name === 'TimeoutError' || e.name === 'AbortError'
        ? new DownloadError('TIMEOUT', `Timed out after ${timeoutMs}ms`)
        : (e instanceof DownloadError ? e : new DownloadError('NETWORK', e.message));
    }
  }
  throw lastError;
}

async function downloadImage(sourceUrl, options = {}) {
  const cacheDir = options.cacheDir || '.image-cache';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;

  fs.mkdirSync(cacheDir, { recursive: true });

  const cached = findCached(cacheDir, sourceUrl);
  if (cached) {
    const buffer = fs.readFileSync(cached);
    const mimeType = sniffMagic(buffer) || mimeForFile(cached);
    return {
      fromCache: true,
      path: cached,
      bytes: buffer.length,
      mimeType,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      md5: crypto.createHash('md5').update(buffer).digest('hex'),
    };
  }

  const { buffer, contentType } = await fetchWithRetry(sourceUrl, { timeoutMs, maxAttempts });

  if (buffer.length === 0) throw new DownloadError('EMPTY_BODY', 'Source returned a zero-length body');
  if (looksLikeHtml(buffer)) throw new DownloadError('HTML_RESPONSE', 'Source returned an HTML document, not an image');

  const mimeType = sniffMime(buffer, contentType, sourceUrl);
  if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
    throw new DownloadError('NOT_AN_IMAGE', `Unsupported media type: ${mimeType || contentType || 'unknown'}`);
  }

  const file = cachePathFor(cacheDir, sourceUrl, mimeType);
  writeFileAtomic(file, buffer);

  return {
    fromCache: false,
    path: file,
    bytes: buffer.length,
    mimeType,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    md5: crypto.createHash('md5').update(buffer).digest('hex'),
  };
}

// Runs downloads with bounded concurrency. Salesforce pacing does not apply
// here: the source host is a third party with its own tolerances.
async function downloadAll(urls, options, onResult) {
  const list = [...urls];
  const concurrency = Math.max(1, options.concurrency || 6);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      const sourceUrl = list[index];
      try {
        onResult(sourceUrl, await downloadImage(sourceUrl, options), null);
      } catch (e) {
        onResult(sourceUrl, null, e instanceof DownloadError ? e : new DownloadError('NETWORK', e.message));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
}

module.exports = {
  downloadImage, downloadAll, sniffMime, sniffMagic, looksLikeHtml,
  cachePathFor, findCached, urlHash, DownloadError, ALLOWED_MIME, EXT_BY_MIME,
};
