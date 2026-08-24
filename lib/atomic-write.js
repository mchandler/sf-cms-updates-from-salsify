'use strict';

const fs = require('fs');

// Windows can transiently refuse to replace an existing file while an
// antivirus scanner, the search indexer, or an open editor holds a handle on
// it, surfacing as EPERM/EACCES/EBUSY. Both the checkpoint and the download
// cache write this way thousands of times in a run, so a single unlucky moment
// would otherwise abort it. Retry briefly, then fall back to writing in place
// rather than losing the work.
const REPLACE_RETRIES = 5;
const REPLACE_RETRY_MS = 60;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(e.code);
      if (!retryable || attempt >= REPLACE_RETRIES) {
        fs.writeFileSync(file, data);
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing left to clean up */ }
        return;
      }
      sleepSync(REPLACE_RETRY_MS);
    }
  }
}

module.exports = { writeFileAtomic };
