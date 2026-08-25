'use strict';

// An in-memory stand-in for the subset of the Salesforce API this tool uses.
// Enough to drive runUpload end to end - SOQL routing, the Connect batch read,
// the multipart create and the sObject Collections upsert - so the resolution
// order can be tested without an org.

const crypto = require('crypto');
const { API_VERSION } = require('../lib/http');

const WORKSPACE = '0Zu000000000001AAA';

function inListValues(soql) {
  const m = /IN\s*\(([^)]*)\)/i.exec(soql);
  if (!m) return [];
  return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '').replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
}

function createFakeOrg({ contents = [], mediaSources = [], workspaceId = WORKSPACE } = {}) {
  const org = {
    workspaceId,
    // { Id, ExternalId, AuthoredManagedContentSpaceId, isPublished }
    contents: contents.map((c) => ({ isPublished: false, AuthoredManagedContentSpaceId: workspaceId, ...c })),
    // { Id, Source_URL__c, Managed_Content_Id__c }
    mediaSources: [...mediaSources],
    calls: { query: [], create: [], publish: [], upsert: [], batch: [] },
  };

  let nextContent = 1000;
  let nextSource = 1000;

  function runQuery(soql) {
    org.calls.query.push(soql);
    const values = inListValues(soql);

    if (/FROM CMS_Media_Source__c/i.test(soql)) {
      return org.mediaSources.filter((r) => values.includes(r.Source_URL__c));
    }
    if (/FROM ManagedContent/i.test(soql) && /WHERE Id IN/i.test(soql)) {
      // Salesforce rejects the entire filter if any value is not an id, and
      // that is the failure this guard exists to prevent - so the fake refuses
      // it too rather than quietly tolerating what the org would not.
      for (const v of values) {
        if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(v)) {
          const err = new Error(`MALFORMED_QUERY: invalid ID field: ${v}`);
          err.status = 400;
          throw err;
        }
      }
      return org.contents.filter((c) => values.includes(c.Id) || values.includes(c.Id.slice(0, 15)));
    }
    if (/FROM ManagedContent/i.test(soql)) {
      const ws = /AuthoredManagedContentSpaceId\s*=\s*'([^']+)'/i.exec(soql);
      return org.contents.filter(
        (c) => values.includes(c.ExternalId) && (!ws || c.AuthoredManagedContentSpaceId === ws[1])
      );
    }
    if (/FROM Organization/i.test(soql)) return [{ Id: '00D000000000001EAA' }];
    throw new Error(`fake-org: unrouted SOQL: ${soql}`);
  }

  const client = {
    async get(urlPath) {
      if (urlPath.includes('/sobjects/CMS_Media_Source__c/describe')) {
        if (org.describeMissing) {
          const err = new Error('HTTP 404');
          err.status = 404;
          throw err;
        }
        if (org.describeForbidden) {
          const err = new Error('HTTP 403');
          err.status = 403;
          throw err;
        }
        return org.describe || {
          createable: true,
          queryable: true,
          updateable: true,
          fields: [
            { name: 'Source_URL__c', createable: true, updateable: true },
            { name: 'Managed_Content_Id__c', createable: true, updateable: true },
          ],
        };
      }
      if (urlPath.includes('/query?q=')) {
        const soql = decodeURIComponent(urlPath.split('/query?q=')[1]);
        return { records: runQuery(soql), done: true };
      }
      throw new Error(`fake-org: unrouted GET ${urlPath}`);
    },

    async post(urlPath, body) {
      if (urlPath.endsWith('/connect/batch')) {
        org.calls.batch.push(body);
        return {
          results: body.batchRequests.map((r) => {
            const id = r.url.split('/').pop();
            const c = org.contents.find((x) => x.Id === id);
            if (!c) return { statusCode: 404, result: [{ errorCode: 'NOT_FOUND', message: 'missing' }] };
            return {
              statusCode: 200,
              result: {
                managedContentId: c.Id,
                contentKey: `KEY_${c.Id}`,
                externalId: c.ExternalId,
                isPublished: c.isPublished === true,
                contentSpace: { id: c.AuthoredManagedContentSpaceId },
                contentBody: { 'sfdc_cms:media': { source: { type: 'file' }, url: `/x?fileHash=${c.fileHash || 'deadbeef'}` } },
              },
            };
          }),
        };
      }
      if (urlPath.endsWith('/connect/cms/contents/publish')) {
        org.calls.publish.push(body.contentIds);
        for (const id of body.contentIds) {
          const c = org.contents.find((x) => x.Id === id);
          if (c) c.isPublished = true;
        }
        return { success: true };
      }
      throw new Error(`fake-org: unrouted POST ${urlPath}`);
    },

    async patch(urlPath, body) {
      if (urlPath.includes(`/composite/sobjects/CMS_Media_Source__c/Managed_Content_Id__c`)) {
        org.calls.upsert.push(body.records);
        return body.records.map((r) => {
          if (org.upsertFails) return { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'nope' }] };
          const contentId = r.Managed_Content_Id__c;
          const existing = org.mediaSources.find((m) => m.Managed_Content_Id__c === contentId);
          if (existing) {
            existing.Source_URL__c = r.Source_URL__c;
            return { id: existing.Id, success: true, created: false };
          }
          const id = `a0X${String(nextSource++).padStart(15, '0')}`;
          org.mediaSources.push({ Id: id, Source_URL__c: r.Source_URL__c, Managed_Content_Id__c: contentId });
          return { id, success: true, created: true };
        });
      }
      throw new Error(`fake-org: unrouted PATCH ${urlPath}`);
    },

    async postMultipart(urlPath, boundary, buffer) {
      if (!urlPath.startsWith(`/services/data/${API_VERSION}/connect/cms/contents/`)) {
        throw new Error(`fake-org: unrouted multipart ${urlPath}`);
      }
      // Recover the rich input so the created record carries the real externalId.
      const text = buffer.toString('latin1');
      const jsonPart = /name="json"\r\n[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
      const rich = JSON.parse(jsonPart[1]);
      const binary = /name="contentData"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
      const bytes = Buffer.from(binary[1], 'latin1');
      const fileHash = crypto.createHash('md5').update(bytes).digest('hex');

      org.calls.create.push(rich);
      const id = `20Y${String(nextContent++).padStart(15, '0')}`;
      org.contents.push({
        Id: id, ExternalId: rich.externalId,
        AuthoredManagedContentSpaceId: workspaceId, isPublished: false, fileHash,
      });
      return {
        managedContentId: id,
        contentKey: `KEY_${id}`,
        contentBody: { 'sfdc_cms:media': { source: { type: 'file', ref: 'r' }, url: `/x?fileHash=${fileHash}` } },
      };
    },

    async del() { throw new Error('fake-org: del not used'); },
  };

  return { org, client };
}

function createErrorLogStub() {
  const rows = [];
  return {
    rows,
    file: '(test)',
    get count() { return rows.length; },
    log(row) { rows.push(row); },
    close() { return Promise.resolve(); },
    codes() { return rows.map((r) => r.errorCode); },
  };
}

module.exports = { createFakeOrg, createErrorLogStub, WORKSPACE };
