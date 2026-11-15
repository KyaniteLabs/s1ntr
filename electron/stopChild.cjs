'use strict';

const { spawn } = require('node:child_process');

// `child.killed` turns true as soon as kill() delivers a signal, not when the
// process exits. Gating the SIGKILL escalation on it meant a Studio that
// ignored SIGTERM was never force-killed. Exit is known only from exitCode or
// signalCode, which Node sets when the child actually ends.
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopChild(child, { graceMs = 5_000, platform = process.platform } = {}) {
  if (!child || hasExited(child)) return;

  if (platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return;
  }

  child.kill('SIGTERM');
  setTimeout(() => {
    if (!hasExited(child)) child.kill('SIGKILL');
  }, graceMs).unref();
}

module.exports = { stopChild };
