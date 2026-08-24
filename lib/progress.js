'use strict';

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 ? 0 : 2)} ${units[i]}`;
}

// printEvery keeps the upload phase readable: it processes ~9,600 items one at
// a time, and a line each would bury everything else and slow the run down.
function createProgress(label, total, options = {}) {
  const printEvery = Math.max(1, options.printEvery || 1);
  const start = Date.now();
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  return {
    record({ ok = 0, fail = 0, skip = 0 } = {}) {
      succeeded += ok;
      failed += fail;
      skipped += skip;
    },
    print(index, force = false) {
      const done = index + 1;
      if (!force && done % printEvery !== 0 && done !== total) return;
      const pct = total > 0 ? Math.round((done / total) * 100) : 100;
      const skipText = skipped > 0 ? ` skip=${skipped}` : '';
      const elapsed = Date.now() - start;
      let eta = '';
      if (done > 0 && done < total) {
        eta = ` | eta ${formatDuration((elapsed / done) * (total - done))}`;
      }
      console.log(`  [${label}] ${done}/${total} (${pct}%) | ok=${succeeded} fail=${failed}${skipText} | ${formatDuration(elapsed)}${eta}`);
    },
    summary() {
      return { succeeded, failed, skipped, elapsedMs: Date.now() - start };
    },
  };
}

module.exports = { createProgress, formatDuration, formatBytes };
