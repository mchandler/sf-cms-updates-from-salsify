'use strict';

const fs = require('fs');

// Windows makes process.stdout/stderr asynchronous when they point at a
// console, so process.exit() can discard output that was written but not yet
// flushed - typically the tail of the final summary or the usage text. Both
// helpers below guarantee the text lands before the process goes away. On
// POSIX the streams are synchronous already and neither costs anything.

// For the async path: flush whatever the console streams still hold, then go.
// Callers must treat this as terminal - it is always the last statement.
//
// Windows needs more care than a nested write callback. readline leaves stdin
// referenced, and tearing down an async handle that is already closing trips a
// libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)` in win/async.c) which
// aborts the process after the work is done - alarming, and it loses the exit
// code. Releasing stdin first, guarding against re-entry, and capping the wait
// keeps the exit orderly whether or not a prompt was ever shown.
const FLUSH_TIMEOUT_MS = 250;
let exiting = false;

function exitAfterFlush(code) {
  if (exiting) return;
  exiting = true;
  process.exitCode = code;

  try {
    if (process.stdin && !process.stdin.destroyed) {
      process.stdin.pause();
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
    }
  } catch (_) {
    // stdin already gone; nothing to release.
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(code);
  };

  // Never wait forever for a stream that may already be closing.
  const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    process.stdout.write('', () => {
      try {
        process.stderr.write('', finish);
      } catch (_) {
        finish();
      }
    });
  } catch (_) {
    finish();
  }
}

// For synchronous validation failures, where returning to the caller would let
// the run continue past the error. fs.writeSync bypasses the buffered console
// streams entirely, so the message is on screen before process.exit().
function exitSync(code, text) {
  try {
    fs.writeSync(code === 0 ? 1 : 2, text);
  } catch (_) {
    // A closed or broken stdio handle is not worth failing over.
  }
  process.exit(code);
}

module.exports = { exitAfterFlush, exitSync };
