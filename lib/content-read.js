'use strict';

const { API_VERSION, sleep } = require('./http');

const BATCH_PATH = `/services/data/${API_VERSION}/connect/batch`;
const MAX_BATCH = 25;

// The media node lives under different keys depending on how the content was
// authored: URL references and UI uploads both use 'sfdc_cms:media', but some
// content types put the source at the top of contentBody. Probe both rather
// than assuming, and report anything that matches neither instead of guessing.
const MEDIA_KEYS = ['sfdc_cms:media', 'media'];

function mediaNode(contentBody) {
  if (!contentBody || typeof contentBody !== 'object') return null;
  for (const key of MEDIA_KEYS) {
    if (contentBody[key] && typeof contentBody[key] === 'object') return contentBody[key];
  }
  return contentBody;
}

function classifyContent(content) {
  const node = mediaNode(content && content.contentBody) || {};
  const source = node.source || {};

  // Salesforce puts the stored file's MD5 in the media URL. It costs nothing to
  // surface here and lets callers recognise two records holding identical bytes.
  const fileHashMatch = /[?&]fileHash=([0-9a-f]+)/i.exec(node.url || '');

  const base = {
    fileHash: fileHashMatch ? fileHashMatch[1].toLowerCase() : null,
    contentId: content.managedContentId || null,
    contentKey: content.contentKey || null,
    title: content.title || null,
    urlName: content.urlName || null,
    externalId: content.externalId || null,
    isPublished: content.isPublished === true,
    workspaceId: (content.contentSpace && content.contentSpace.id) || null,
    contentType: (content.contentType && content.contentType.fullyQualifiedName) || null,
  };

  if (source.type === 'url' && source.url) {
    return { ...base, kind: 'url', sourceUrl: source.url, mimeTypeHint: source.mimeType || null };
  }
  if (source.type === 'file' || source.ref || source.isExternal === false) {
    return { ...base, kind: 'binary', sourceUrl: null, mimeTypeHint: source.mimeType || null };
  }
  return { ...base, kind: 'unknown', sourceUrl: null, mimeTypeHint: null };
}

function buildBatchRequest(contentIds) {
  return {
    batchRequests: contentIds.map((id) => ({
      method: 'Get',
      url: `/${API_VERSION}/connect/cms/contents/${id}`,
    })),
  };
}

function extractError(sub) {
  const result = sub && sub.result;
  const first = Array.isArray(result) ? result[0] : result;
  if (first && typeof first === 'object') {
    return {
      errorCode: first.errorCode || `HTTP_${sub.statusCode}`,
      errorMessage: String(first.message || JSON.stringify(first)).slice(0, 500),
    };
  }
  return { errorCode: `HTTP_${sub && sub.statusCode}`, errorMessage: String(result || '').slice(0, 500) };
}

// A generator rather than an array: the working set is ~9,600 contents and the
// caller checkpoints as it goes, so there is no reason to hold every body in
// memory at once.
async function* readContents(client, contentIds, { batchSize = MAX_BATCH, paceMs = 0 } = {}) {
  const size = Math.min(Math.max(1, batchSize), MAX_BATCH);
  const ids = [...contentIds];

  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    const batchIndex = Math.floor(i / size);

    let response;
    try {
      response = await client.post(BATCH_PATH, buildBatchRequest(slice));
    } catch (e) {
      for (const id of slice) {
        yield { contentId: id, kind: 'error', batchIndex, errorCode: 'BATCH_REQUEST_FAILED', errorMessage: e.message.slice(0, 500) };
      }
      if (paceMs > 0) await sleep(paceMs);
      continue;
    }

    const results = (response && response.results) || [];
    for (let j = 0; j < slice.length; j++) {
      const sub = results[j];
      if (!sub) {
        yield { contentId: slice[j], kind: 'error', batchIndex, errorCode: 'NO_SUBRESULT', errorMessage: 'Batch response had no entry for this request' };
        continue;
      }
      if (sub.statusCode < 200 || sub.statusCode >= 300) {
        yield { contentId: slice[j], kind: 'error', batchIndex, ...extractError(sub) };
        continue;
      }
      yield { ...classifyContent(sub.result), batchIndex };
    }

    if (paceMs > 0 && i + size < ids.length) await sleep(paceMs);
  }
}

module.exports = { readContents, classifyContent, mediaNode, MAX_BATCH, MEDIA_KEYS };
