'use strict';

const readline = require('readline');

// Asks a question and resolves with the trimmed answer, or with `fallback` when
// there is no terminal to answer it - long runs are expected under nohup or a
// scheduled task, where a prompt nobody can answer would hang forever.
//
// The promise must settle exactly once, and the answer has to win. rl.close()
// emits 'close' synchronously, so a close handler that resolves the fallback
// will settle the promise before the answer callback's own resolve runs - and
// since resolving twice is a silent no-op, whatever the operator typed is
// discarded. Guarding the settle is what keeps the typed answer authoritative.
function ask(question, fallback) {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${question}${fallback} (no terminal attached)\n`);
    return Promise.resolve(fallback);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rl.question(question, (answer) => {
      settle(String(answer).trim());
      rl.close();
    });
    // Covers Ctrl-D or the stream ending without an answer.
    rl.on('close', () => settle(fallback));
  });
}

module.exports = { ask };
