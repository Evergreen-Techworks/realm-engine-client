'use strict';
// Machine-wide single-instance lock: one Realm Engine per Windows user, whichever
// folder or copy it was started from.
//
// Electron's app.requestSingleInstanceLock() is scoped to userData, and the
// portable repoints userData at the RE_ASSETS folder beside its EXE. So two
// copies in two folders (a new download next to the one already open) each got
// their own lock and ran two whole apps against one game: two injector loops,
// and a race for :4440/:2050 whose loser kept running headless.
//
// The lock is a named pipe server, \\.\pipe\RealmEngine-instance-<user>-<hash>:
//   - libuv creates the first pipe instance with FILE_FLAG_FIRST_PIPE_INSTANCE,
//     so a second listen() fails with EADDRINUSE while any copy holds it;
//   - the pipe is a kernel object owned by the process's handles, so a crash or
//     a kill releases it with the process: there is no lock file to go stale;
//   - the losing copy connects to it to ask the owner to show its window.
//
// Wire protocol (newline-delimited JSON, one exchange per connection):
//   owner  -> hello { type: 'hello', pid }
//   caller -> focus { type: 'focus', pid }   (after its beforeFocus hook)
//   owner  -> ack   { type: 'ack', pid }     (after its onFocusRequest hook)
//
// Nothing here requires Electron, so it can be tested under plain Node.

const crypto = require('crypto');
const net = require('net');
const os = require('os');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_CHARS = 1024;
const DEFAULT_REPLY_TIMEOUT_MS = 3000;
const DEFAULT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 150;
const OWNER_CONNECTION_IDLE_MS = 5000;
// The owner vanished between our failed listen() and our connect(): it quit or
// crashed, so the name may be free now.
const RETRYABLE_CONNECT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECLOSED']);

function currentUser(env = process.env) {
  let username = '';
  try {
    username = os.userInfo().username || '';
  } catch {
    /* no passwd entry / profile: fall back to the environment */
  }
  return {
    username: username || env.USERNAME || env.USER || 'user',
    domain: env.USERDOMAIN || '',
  };
}

// Named pipes live in one machine-global namespace (not per logon session), so
// the name carries the Windows account, lowercased because Windows account
// names are case-insensitive. The readable part is sanitized; the hash of
// domain\user keeps two accounts that sanitize alike, or the same name in two
// domains, apart. Returns null off Windows: there is no pipe namespace to share.
function machineInstancePipePath({ platform = process.platform, user = currentUser() } = {}) {
  if (platform !== 'win32') return null;
  const readable = String(user.username).toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 32) || 'user';
  const account = (String(user.domain || '') + '\\' + String(user.username)).toLowerCase();
  const digest = crypto.createHash('sha256').update(account, 'utf8').digest('hex').slice(0, 12);
  return '\\\\.\\pipe\\RealmEngine-instance-' + readable + '-' + digest;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Calls onMessage(message) for each complete JSON line; returns false (and
// stops) on an oversized or malformed one.
function lineReader(onMessage, onInvalid) {
  let buffered = '';
  return (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        /* handled below */
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        onInvalid();
        return;
      }
      if (onMessage(message) === false) return;
    }
    if (buffered.length > MAX_MESSAGE_CHARS) onInvalid();
  };
}

function send(socket, message) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify({ v: PROTOCOL_VERSION, pid: process.pid, ...message }) + '\n');
}

function serveConnection(socket, sockets, onFocusRequest, log) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  // A client that connects and never speaks must not pin a pipe instance.
  socket.setTimeout(OWNER_CONNECTION_IDLE_MS, () => socket.destroy());
  socket.setEncoding('utf8');
  let handled = false;
  socket.on('data', lineReader((message) => {
    if (handled || message.type !== 'focus') {
      socket.destroy();
      return false;
    }
    handled = true;
    try {
      onFocusRequest({ pid: Number(message.pid) || null });
    } catch (error) {
      log('focus request handler failed: ' + (error && error.message ? error.message : error));
    }
    // Acknowledge even if showing the window failed: this copy is alive and owns
    // the game, so the caller must still exit rather than start a second app.
    send(socket, { type: 'ack' });
    socket.end();
    return false;
  }, () => socket.destroy()));
  send(socket, { type: 'hello' });
}

function listenExclusive(pipePath, onFocusRequest, log) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => serveConnection(socket, sockets, onFocusRequest, log));
    const onListening = () => {
      server.removeListener('error', onError);
      // An accept failure after this point must not crash the app.
      server.on('error', (error) => log('instance lock server error: ' + error.message));
      let released = null;
      const release = () => {
        if (!released) {
          released = new Promise((done) => {
            // On Windows each accepted connection is itself an instance of the
            // pipe, so the name stays taken until those close too.
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          });
        }
        return released;
      };
      resolve({ release });
    };
    const onError = (error) => {
      server.removeListener('listening', onListening);
      resolve({ error });
    };
    server.once('listening', onListening);
    server.once('error', onError);
    try {
      server.listen(pipePath);
    } catch (error) {
      onError(error);
    }
  });
}

function requestFocus(pipePath, { timeoutMs, beforeFocus, log }) {
  return new Promise((resolve) => {
    let settled = false;
    let owner = null;
    const socket = net.connect(pipePath);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ acknowledged: false, owner, error: codedError('ETIMEDOUT', 'The running copy did not answer within ' + timeoutMs + 'ms') });
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (error) => finish({ acknowledged: false, owner, error }));
    socket.on('close', () => finish({ acknowledged: false, owner, error: codedError('ECLOSED', 'The running copy closed the connection without answering') }));
    socket.on('data', lineReader((message) => {
      if (message.type === 'hello' && !owner) {
        owner = { pid: Number(message.pid) || null };
        try {
          beforeFocus(owner);
        } catch (error) {
          log('beforeFocus failed: ' + (error && error.message ? error.message : error));
        }
        send(socket, { type: 'focus' });
        return true;
      }
      if (message.type === 'ack' && owner) {
        finish({ acknowledged: true, owner: { pid: Number(message.pid) || owner.pid } });
        return false;
      }
      finish({ acknowledged: false, owner, error: codedError('EPROTO', 'Unexpected reply from the running copy: ' + message.type) });
      return false;
    }, () => finish({ acknowledged: false, owner, error: codedError('EPROTO', 'Malformed reply from the running copy') })));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the lock at pipePath, or hand focus to whoever holds it.
 *
 * Resolves (never rejects) to one of:
 *   { status: 'acquired', release }  this process owns the lock until release()
 *                                    or exit. onFocusRequest runs for each later
 *                                    copy that asks.
 *   { status: 'focused', owner }     another copy holds it and acknowledged the
 *                                    focus request: exit without starting.
 *   { status: 'unreachable', error, owner }
 *                                    another copy holds it but did not answer
 *                                    (hung, or not ours to talk to): exit and
 *                                    tell the user.
 *   { status: 'unavailable', error } the pipe could not be created for some
 *                                    other reason. No copy is known to be
 *                                    running; the caller decides whether to go on.
 */
async function acquireInstanceLock(pipePath, options = {}) {
  const {
    onFocusRequest = () => {},
    beforeFocus = () => {},
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    attempts = DEFAULT_ATTEMPTS,
    log = () => {},
  } = options;
  if (!pipePath) throw new TypeError('acquireInstanceLock needs a pipe path');
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const listened = await listenExclusive(pipePath, onFocusRequest, log);
    if (listened.release) return { status: 'acquired', release: listened.release };
    if (listened.error.code !== 'EADDRINUSE') return { status: 'unavailable', error: listened.error };

    const asked = await requestFocus(pipePath, { timeoutMs: replyTimeoutMs, beforeFocus, log });
    if (asked.acknowledged) return { status: 'focused', owner: asked.owner };
    last = asked;
    if (!RETRYABLE_CONNECT_CODES.has(asked.error && asked.error.code)) break;
    if (attempt < attempts) await delay(RETRY_DELAY_MS);
  }
  return { status: 'unreachable', error: last && last.error, owner: last && last.owner };
}

// Windows only lets the foreground process hand the foreground on. Chromium's
// own single-instance path calls AllowSetForegroundWindow(owner) before it
// notifies the owner; this is the same call for a copy in another folder, so
// the owner's focus() can raise its window rather than only flash the taskbar.
// Best effort: false if koffi or the call is unavailable.
let allowForegroundFn;
function allowSetForegroundWindow(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (allowForegroundFn === undefined) {
      allowForegroundFn = null;
      const koffi = require('koffi');
      // Win32 BOOL is a 4-byte int, not C bool.
      allowForegroundFn = koffi.load('user32.dll').func('int __stdcall AllowSetForegroundWindow(uint32_t dwProcessId)');
    }
    return allowForegroundFn ? allowForegroundFn(pid) !== 0 : false;
  } catch {
    return false;
  }
}

module.exports = {
  acquireInstanceLock,
  allowSetForegroundWindow,
  machineInstancePipePath,
  currentUser,
  PROTOCOL_VERSION,
};
