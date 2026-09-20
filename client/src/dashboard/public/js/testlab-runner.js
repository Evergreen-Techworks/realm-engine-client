// TESTLAB_PRIVATE_ONLY
//
// Private-build-only renderer helper for the unattended run mode: listens on
// its own dashboard websocket connection for a launch request broadcast by
// the server-side plugin (client/plugins/testlab-runner.ts), launches the
// named saved account by calling the SAME launch path the account's own
// Launch button uses (window._launchAccountByLabel, added to app.js), and
// reports the outcome back. Never touches account credentials itself — it
// only ever sees a label string and an ok/error result.
//
// Loaded as a plain classic <script> tag (see index.html), independent of
// app.js's module graph. A 404 for this path in a customer build is
// harmless: this file, its manifest entry (client/private-only.json) and the
// server-side plugin it talks to are all excluded from customer builds.
(function () {
  'use strict';

  var RECONNECT_DELAY_MS = 2000;
  var LAUNCH_RESULT_TYPE = 'testlabLaunchResult';
  var LAUNCH_REQUEST_DATA_TYPE = 'testlabLaunch';

  var ws = null;

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(proto + '//' + location.host);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    ws.onclose = scheduleReconnect;
    ws.onerror = function () {
      /* onclose follows every error on a WebSocket; nothing extra to do here */
    };
    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!msg || msg.type !== 'pluginData' || msg.dataType !== LAUNCH_REQUEST_DATA_TYPE) return;
      handleLaunchRequest(msg.data || {});
    };
  }

  function scheduleReconnect() {
    ws = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  }

  function replyToLaunch(runId, ok, error) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: LAUNCH_RESULT_TYPE, runId: runId, ok: !!ok, error: ok ? null : error || 'launch-failed' }));
      }
    } catch (err) {
      /* best effort — the plugin times out its own wait if this never arrives */
    }
  }

  function handleLaunchRequest(data) {
    var runId = String(data.runId || '').trim();
    var accountLabel = String(data.accountLabel || '').trim();
    var serverName = data.serverName ? String(data.serverName) : undefined;
    if (!runId || !accountLabel) return;

    if (typeof window._launchAccountByLabel !== 'function') {
      replyToLaunch(runId, false, 'launch-failed');
      return;
    }

    try {
      var outcome = window._launchAccountByLabel(accountLabel, serverName);
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(
          function (result) {
            replyToLaunch(runId, !!(result && result.ok), result && result.error);
          },
          function () {
            replyToLaunch(runId, false, 'launch-failed');
          },
        );
      } else {
        replyToLaunch(runId, false, 'launch-failed');
      }
    } catch (err) {
      replyToLaunch(runId, false, 'launch-failed');
    }
  }

  connect();
})();
