'use strict';

const API_VERSION = 'v64.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function backoffDelay(attempt) {
  return Math.min(60000, 2000 * Math.pow(2, attempt));
}

function createClient(session, options = {}) {
  const maxAttempts = options.maxAttempts ?? 6;

  // payload is either { json } or { buffer, contentType }. Keeping it a
  // descriptor rather than a pre-serialised body lets the multipart upload
  // share this retry and token-refresh loop rather than reimplementing it.
  async function request(method, urlPath, payload) {
    const sess = await session.get();
    const url = `${sess.instanceUrl}${urlPath}`;

    let attempt = 0;
    let refreshedOnce = false;

    while (true) {
      const headers = {
        'Authorization': `Bearer ${(await session.get()).accessToken}`,
        'Accept': 'application/json',
      };
      let body;
      if (payload && payload.buffer !== undefined) {
        headers['Content-Type'] = payload.contentType;
        body = payload.buffer;
      } else if (payload && payload.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(payload.json);
      }

      let res;
      try {
        res = await fetch(url, { method, headers, body });
      } catch (netErr) {
        if (attempt >= 3) throw new Error(`Network error after ${attempt} retries: ${netErr.message}`);
        const wait = backoffDelay(attempt);
        console.warn(`  Network error (${netErr.message}); retrying in ${wait}ms...`);
        await sleep(wait);
        attempt++;
        continue;
      }

      if (res.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        console.warn('  401 Unauthorized - refreshing SF CLI session...');
        await session.refresh();
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          const text = await safeText(res);
          throw new HttpError(res.status, text, url);
        }
        const wait = backoffDelay(attempt);
        console.warn(`  HTTP ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})...`);
        await sleep(wait);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new HttpError(res.status, text, url);
      }

      if (res.status === 204) return null;
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    }
  }

  async function safeText(res) {
    try { return await res.text(); } catch (_) { return ''; }
  }

  return {
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body) => request('POST', urlPath, body === undefined ? undefined : { json: body }),
    patch: (urlPath, body) => request('PATCH', urlPath, body === undefined ? undefined : { json: body }),
    del: (urlPath) => request('DELETE', urlPath),
    postMultipart: (urlPath, boundary, buffer) =>
      request('POST', urlPath, { buffer, contentType: `multipart/form-data; boundary=${boundary}` }),
  };
}

module.exports = { createClient, HttpError, API_VERSION, sleep };
