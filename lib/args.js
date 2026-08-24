'use strict';

const fs = require('fs');
const path = require('path');

const { exitSync } = require('./exit');
const { ORG_ALIAS_RE } = require('./auth');
const { ENTITY_NAMES, ALL_GROUP_NAMES, entityForGroups } = require('./entities');

const ACTIONS = ['swap', 'add', 'delete'];

const USAGE = `Usage:
  node update-media.js --org <alias> --workspace <id> --csv <path> \\
                       --action swap|add|delete --entity product|category [options]
  node update-media.js --config <config.json> [options]

Updates product and category imagery from a CSV of identifier,url pairs. Each
source image is downloaded and uploaded into the CMS as binary media, then
associated to the matching product or category. Identifiers are the SKU for
products and the external id for categories.

Actions:
  swap    Replace the entity's current image with the one in the CSV. Uploads
          and publishes first, then removes the old link, adds the new one, and
          unpublishes the displaced content if nothing else still uses it.
  add     Upload, publish and associate the new image without removing anything.
  delete  Remove the entity's image links and unpublish the content if nothing
          else still uses it. The url column is not needed.

Options:
  --org <alias>                Org alias (required unless in config)
  --workspace <id>             CMS workspace id (required unless in config)
  --csv <path>                 Input CSV with identifier,url columns (required unless in config)
  --action <name>              ${ACTIONS.join(' | ')} (required unless in config)
  --entity <name>              ${ENTITY_NAMES.join(' | ')} (inferred from --groups if omitted)
  --folder <id>                Folder within the workspace for new content
  --groups <list>              Restrict to specific media groups:
                               ${ALL_GROUP_NAMES.join(', ')}
  --dry-run                    Report intended changes; write nothing
  --force                      Re-run steps that already completed
  --yes                        Skip the confirmation before a large or destructive run
  --no-unpublish               Change links only; leave displaced content published
  --max-rows <n>               Process only the first n eligible identifiers
  --cache-dir <path>           Download cache location (default: .image-cache)
  --pace <ms>                  Delay between requests (default: 300)
  --batch-size <n>             Items per CMS batch request, max 25 (default: 25)
  --download-concurrency <n>   Parallel source downloads (default: 6)
  --upload-concurrency <n>     Parallel binary uploads, max 4 (default: 1)
  --timeout <ms>               Per-download timeout (default: 30000)
  --group <name=id>            Pin an image group id (repeatable)
  --config <path>              JSON config file (alternative to the flags above)
`;

// Never returns: writes synchronously and exits, so validation below cannot
// keep running on a config that is already known to be bad.
function fail(msg) {
  exitSync(1, `${msg}\n\n${USAGE}\n`);
}

function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) fail(`${flag} requires a value`);
  return v;
}

function parseArgs(argv) {
  const out = {
    configPath: null, org: null, workspaceId: null, csvPath: null, action: null, entity: null,
    folderId: null, groupNames: null, dryRun: false, force: false, yes: false, unpublish: null,
    maxRows: null, cacheDir: null, paceMs: null, batchSize: null,
    downloadConcurrency: null, uploadConcurrency: null, timeoutMs: null, groups: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--config':                out.configPath = takeValue(argv, i++, a); break;
      case '--org':                   out.org = takeValue(argv, i++, a); break;
      case '--workspace':             out.workspaceId = takeValue(argv, i++, a); break;
      case '--csv':                   out.csvPath = takeValue(argv, i++, a); break;
      case '--action':                out.action = takeValue(argv, i++, a); break;
      case '--entity':                out.entity = takeValue(argv, i++, a); break;
      case '--folder':                out.folderId = takeValue(argv, i++, a); break;
      case '--groups':                out.groupNames = takeValue(argv, i++, a).split(','); break;
      case '--dry-run':               out.dryRun = true; break;
      case '--force':                 out.force = true; break;
      case '--yes':                   out.yes = true; break;
      case '--no-unpublish':          out.unpublish = false; break;
      case '--max-rows':              out.maxRows = parseInt(takeValue(argv, i++, a), 10); break;
      case '--cache-dir':             out.cacheDir = takeValue(argv, i++, a); break;
      case '--pace':                  out.paceMs = parseInt(takeValue(argv, i++, a), 10); break;
      case '--batch-size':            out.batchSize = parseInt(takeValue(argv, i++, a), 10); break;
      case '--download-concurrency':  out.downloadConcurrency = parseInt(takeValue(argv, i++, a), 10); break;
      case '--upload-concurrency':    out.uploadConcurrency = parseInt(takeValue(argv, i++, a), 10); break;
      case '--timeout':               out.timeoutMs = parseInt(takeValue(argv, i++, a), 10); break;
      case '--group': {
        const pair = takeValue(argv, i++, a);
        const eq = pair.indexOf('=');
        if (eq < 1) fail(`--group must be <developerName>=<id>, got: ${pair}`);
        out.groups[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case '-h':
      case '--help':
        exitSync(0, `${USAGE}\n`);
        break;
      default:
        fail(`Unknown argument: ${a}`);
    }
  }

  return out;
}

function loadConfigFile(configPath) {
  const abs = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) fail(`Config file not found: ${abs}`);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    fail(`Could not read config: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Config is not valid JSON: ${e.message}`);
  }
}

function positiveInt(value, flag, { min = 1, max = Infinity } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${flag} must be an integer between ${min} and ${max === Infinity ? 'unbounded' : max}`);
  }
}

function resolveConfig(argv) {
  const cli = parseArgs(argv);
  const fromFile = cli.configPath ? loadConfigFile(cli.configPath) : {};

  const groupNames = cli.groupNames ?? fromFile.groupNames ?? null;
  const explicitEntity = cli.entity ?? fromFile.entity ?? null;

  const cfg = {
    org: cli.org ?? fromFile.org ?? null,
    workspaceId: cli.workspaceId ?? fromFile.workspaceId ?? null,
    csvPath: cli.csvPath ?? fromFile.csvPath ?? null,
    action: cli.action ?? fromFile.action ?? null,
    // --groups is more specific than --entity, so it can stand alone: naming
    // tileImage is already saying "categories".
    entity: explicitEntity ?? entityForGroups(groupNames),
    entityWasExplicit: explicitEntity != null,
    folderId: cli.folderId ?? fromFile.folderId ?? null,
    groupNames,
    dryRun: cli.dryRun || !!fromFile.dryRun,
    force: cli.force || !!fromFile.force,
    yes: cli.yes || !!fromFile.yes,
    unpublish: cli.unpublish ?? fromFile.unpublish ?? true,
    maxRows: cli.maxRows ?? fromFile.maxRows ?? null,
    cacheDir: cli.cacheDir ?? fromFile.cacheDir ?? '.image-cache',
    paceMs: cli.paceMs ?? fromFile.paceMs ?? 300,
    batchSize: cli.batchSize ?? fromFile.batchSize ?? 25,
    downloadConcurrency: cli.downloadConcurrency ?? fromFile.downloadConcurrency ?? 6,
    uploadConcurrency: cli.uploadConcurrency ?? fromFile.uploadConcurrency ?? 1,
    timeoutMs: cli.timeoutMs ?? fromFile.timeoutMs ?? 30000,
    groups: Object.assign({}, fromFile.groups || {}, cli.groups),
  };

  if (!cfg.org) fail('Missing --org (or "org" in config)');
  // Checked here as well as in lib/auth.js so a bad alias is a clean usage
  // error at startup rather than a thrown error part-way into the run.
  if (!ORG_ALIAS_RE.test(cfg.org)) {
    fail(`--org must be a valid CLI alias - letters, digits, dot, dash, underscore, starting with a letter or digit: ${cfg.org}`);
  }
  if (!cfg.workspaceId) fail('Missing --workspace (or "workspaceId" in config)');
  if (!cfg.csvPath) fail('Missing --csv (or "csvPath" in config)');
  if (!cfg.action) fail(`Missing --action (one of ${ACTIONS.join(', ')})`);
  if (!ACTIONS.includes(cfg.action)) fail(`Unknown --action "${cfg.action}". Valid: ${ACTIONS.join(', ')}`);
  if (!cfg.entity) {
    fail(`Missing --entity (one of ${ENTITY_NAMES.join(', ')}). It can be omitted only when --groups names groups belonging to a single entity.`);
  }
  if (!ENTITY_NAMES.includes(cfg.entity)) fail(`Unknown --entity "${cfg.entity}". Valid: ${ENTITY_NAMES.join(', ')}`);

  if (cfg.groupNames) {
    cfg.groupNames = cfg.groupNames.map((g) => String(g).trim()).filter(Boolean);
    if (cfg.groupNames.length === 0) fail(`--groups needs at least one of: ${ALL_GROUP_NAMES.join(', ')}`);
    const unknown = cfg.groupNames.filter((g) => !ALL_GROUP_NAMES.includes(g));
    if (unknown.length) fail(`Unknown --groups value(s): ${unknown.join(', ')}. Valid: ${ALL_GROUP_NAMES.join(', ')}`);
  }

  // --no-unpublish is about retiring displaced content, and `add` displaces
  // nothing. Saying it there is a misunderstanding worth naming.
  if (cfg.action === 'add' && cfg.unpublish === false) {
    fail('--no-unpublish does not apply to --action add; that action never displaces content');
  }

  if (!Number.isInteger(cfg.paceMs) || cfg.paceMs < 0) fail('--pace must be a non-negative integer');
  positiveInt(cfg.batchSize, '--batch-size', { min: 1, max: 25 });
  positiveInt(cfg.downloadConcurrency, '--download-concurrency', { min: 1, max: 32 });
  positiveInt(cfg.uploadConcurrency, '--upload-concurrency', { min: 1, max: 4 });
  positiveInt(cfg.timeoutMs, '--timeout', { min: 1000 });
  if (cfg.maxRows != null) positiveInt(cfg.maxRows, '--max-rows');

  cfg.cacheDir = path.resolve(process.cwd(), cfg.cacheDir);
  cfg.csvPath = path.resolve(process.cwd(), cfg.csvPath);
  if (!fs.existsSync(cfg.csvPath)) fail(`CSV not found: ${cfg.csvPath}`);

  // `delete` identifies the entity and removes whatever it holds, so the url
  // column is optional there and blank rows are not an error.
  cfg.requireUrl = cfg.action !== 'delete';

  return cfg;
}

module.exports = { resolveConfig, USAGE, ACTIONS };
