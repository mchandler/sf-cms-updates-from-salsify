'use strict';

const { execFile } = require('child_process');

const EXEC_OPTS = {
  maxBuffer: 5 * 1024 * 1024,
  // shell: true on Windows lets the shell resolve `sf` through PATHEXT to
  // whichever entry point is installed (sf.cmd from npm, sf.exe from the
  // standalone installer). Naming one of them directly fails with ENOENT on
  // machines that have the other. Args are internal constants plus the org
  // alias, which ORG_ALIAS_RE below restricts to letters, digits, dot, dash
  // and underscore - so no shell-injection surface is opened.
  shell: process.platform === 'win32',
};

// Must start with an alphanumeric so an alias can never be read as a flag by
// the shell or by the sf CLI itself.
const ORG_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function errorDetail(err, stdout, stderr) {
  try {
    const parsed = JSON.parse(stdout);
    const msg = parsed && (parsed.message || (parsed.result && parsed.result.message));
    if (msg) return String(msg).trim();
  } catch (_) {
    // Not JSON - fall through to the stream output.
  }
  if (stderr && stderr.trim()) return stderr.trim();
  return err.message;
}

function runSf(args) {
  return new Promise((resolve, reject) => {
    execFile('sf', args, EXEC_OPTS, (err, stdout, stderr) => {
      if (err) {
        // With --json the CLI writes its real diagnostic to stdout and exits
        // non-zero, leaving stderr empty - so reporting stderr alone yields a
        // bare "Command failed" with no reason. Prefer the structured message.
        return reject(new Error(`sf ${args.join(' ')} failed: ${errorDetail(err, stdout, stderr)}`));
      }
      resolve(stdout);
    });
  });
}

function parseSfJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Could not parse ${label} output: ${e.message}`);
  }
}

// A real SF access token is a single opaque string with no whitespace. Newer
// CLI versions REDACT it in `sf org display --json`, returning the literal
// "[REDACTED] Use 'sf org auth show-access-token' to view" - which contains
// spaces and the word REDACTED. Anything matching those is not a usable token.
function looksLikeRealToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/\s/.test(value)
    && !/REDACTED/i.test(value);
}

async function fetchSession(orgAlias) {
  if (!ORG_ALIAS_RE.test(orgAlias)) {
    throw new Error(
      `Invalid org alias "${orgAlias}" - must start with a letter or digit and contain only letters, digits, dot, dash, underscore`
    );
  }
  // `sf org display --json` gives us instanceUrl + username (never redacted)
  // and, on OLDER CLI versions, the real accessToken too. On NEWER versions the
  // token comes back redacted, so we fall back to
  // `sf org auth show-access-token` - which older CLIs don't have. Trying
  // display first and only falling back when the token is redacted keeps this
  // working across CLI versions (the fallback is never invoked on CLIs that
  // lack the subcommand).
  const displayOut = await runSf(['org', 'display', '--target-org', orgAlias, '--json']);
  const display = parseSfJson(displayOut, 'sf org display');
  const result = display && display.result;
  if (!result || !result.instanceUrl) {
    throw new Error(`sf org display did not return instanceUrl for org "${orgAlias}"`);
  }

  let accessToken = result.accessToken;
  if (!looksLikeRealToken(accessToken)) {
    const tokenOut = await runSf([
      'org', 'auth', 'show-access-token', '--target-org', orgAlias, '--no-prompt', '--json',
    ]);
    const token = parseSfJson(tokenOut, 'sf org auth show-access-token');
    accessToken = token && token.result && token.result.accessToken;
  }

  if (!looksLikeRealToken(accessToken)) {
    throw new Error(`Could not obtain a usable access token for org "${orgAlias}"`);
  }

  return {
    accessToken,
    instanceUrl: result.instanceUrl.replace(/\/$/, ''),
    username: result.username || null,
  };
}

function createSession(orgAlias) {
  let cached = null;
  return {
    orgAlias,
    async get() {
      if (!cached) cached = await fetchSession(orgAlias);
      return cached;
    },
    async refresh() {
      cached = await fetchSession(orgAlias);
      return cached;
    },
  };
}

module.exports = { createSession, ORG_ALIAS_RE };
