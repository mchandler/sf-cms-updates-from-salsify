'use strict';

const crypto = require('crypto');

const { API_VERSION } = require('./http');
const { buildMultipartBody } = require('./multipart');

const CONTENTS_PATH = `/services/data/${API_VERSION}/connect/cms/contents/`;
const PUBLISH_PATH = `/services/data/${API_VERSION}/connect/cms/contents/publish`;
const UNPUBLISH_PATH = `/services/data/${API_VERSION}/connect/cms/contents/unpublish`;
const PUBLISH_CHUNK = 200;

const CONTENT_TYPE = 'sfdc_cms__image';
const MEDIA_NODE = 'sfdc_cms:media';

// The image bytes must travel in a part named exactly "contentData"; anything
// else comes back as POST_BODY_PARSE_ERROR naming the part it wanted. The rich
// input rides alongside in a part named "json". There is no separate upload
// endpoint - /contents/<id>/media, /versions and /variants are all 404 - so
// content and bytes are created together and this cannot be batched.
const JSON_PART = 'json';
const BINARY_PART = 'contentData';

function buildRichInput({ workspaceId, folderId, title, apiName, urlName, externalId, mimeType, fileName }) {
  return {
    apiName,
    contentSpaceOrFolderId: folderId || workspaceId,
    contentType: CONTENT_TYPE,
    externalId,
    title,
    urlName,
    contentBody: {
      [MEDIA_NODE]: {
        // type must be 'file'; omitting it fails validation, and supplying it
        // without a contentData part fails with "This image reference isn't
        // available."
        source: { type: 'file', mimeType, fileName },
      },
    },
  };
}

// Salesforce puts fileHash=<md5 of the stored bytes> in the media URL it hands
// back. The /cms/media/ path itself is not readable with a bearer token, so
// this hash is the only practical way to prove the upload holds what we sent.
function extractFileHash(content) {
  const media = content && content.contentBody && content.contentBody[MEDIA_NODE];
  const url = media && media.url;
  if (!url) return null;
  const m = /[?&]fileHash=([0-9a-f]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

class UploadVerificationError extends Error {
  constructor(expected, actual) {
    super(`Uploaded bytes do not match: expected md5 ${expected}, content reports ${actual || 'none'}`);
    this.expected = expected;
    this.actual = actual;
  }
}

async function createBinaryContent(client, opts) {
  const { bytes, mimeType, fileName } = opts;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('createBinaryContent requires a non-empty Buffer');
  }

  const richInput = buildRichInput(opts);
  const { boundary, buffer } = buildMultipartBody([
    { name: JSON_PART, contentType: 'application/json', body: JSON.stringify(richInput) },
    { name: BINARY_PART, filename: fileName, contentType: mimeType, body: bytes },
  ]);

  const result = await client.postMultipart(CONTENTS_PATH, boundary, buffer);

  const expected = md5(bytes);
  const actual = extractFileHash(result);
  if (actual !== expected) throw new UploadVerificationError(expected, actual);

  const media = result.contentBody[MEDIA_NODE];
  return {
    managedContentId: result.managedContentId,
    contentKey: result.contentKey,
    ref: media.source && media.source.ref,
    md5: expected,
    bytes: bytes.length,
  };
}

async function publish(client, contentIds, description) {
  return client.post(PUBLISH_PATH, { description, contentIds });
}

async function unpublish(client, contentIds) {
  return client.post(UNPUBLISH_PATH, { contentIds });
}

module.exports = {
  createBinaryContent,
  publish,
  unpublish,
  extractFileHash,
  md5,
  UploadVerificationError,
  CONTENTS_PATH,
  PUBLISH_CHUNK,
  MEDIA_NODE,
  CONTENT_TYPE,
};
