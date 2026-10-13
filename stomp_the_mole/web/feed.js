/* Stomp the Mole: shared client for the data feed (DESIGN.md "Data feed").

   Connects to ws://<page host>/ws, reconnects every second, estimates the server
   clock and hands hello / state / event messages to callbacks. Used by the floor
   renderer and the scoreboard; future wall and ceiling pages can use it unchanged.

     const feed = StompFeed.connect({onHello, onState, onEvent, onStatus});
     feed.serverNow()               // server clock in ms, for animations
     feed.sendClient('floor', 'running')

   While messages arrive, it also sends {"type":"beat"} to the server at most once per second. A page
   that hangs (or a PC that freezes) keeps its connection open but stops beating, and the server stops
   counting it in "screens" after a few seconds (so the floor takes its score band back). The beat goes
   out from the message handler, not a timer: background tabs throttle timers, never message delivery.
*/
(function (global) {
  'use strict';

  const RECONNECT_MS = 1000;
  const STALE_MS = 3000;   // state arrives at 30 Hz; this much silence means a dead link
  const BEAT_MS = 1000;    // at most one "beat" per this long (the server's limit is 3 s of silence)
  // Clock offset = max of (msg.now - performance.now()) over the last SLOTS seconds.
  // The max is the sample with the least network delay; the window lets it follow drift.
  const SLOT_MS = 1000;
  const SLOTS = 8;

  function feedUrl() {
    const override = new URLSearchParams(global.location.search).get('ws');
    if (override) return override;
    const proto = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + (global.location.host || '127.0.0.1:8080') + '/ws';
  }

  function connect(handlers) {
    handlers = handlers || {};
    const slotMax = new Float64Array(SLOTS);
    const slotId = new Float64Array(SLOTS);
    let offset = 0;
    let ws = null;
    let lastMessageAt = 0;
    let lastBeatAt = -Infinity;
    let retryTimer = 0;
    let role = null;
    let audioState = null;

    const feed = {
      url: feedUrl(),
      config: null,          // config body of the latest hello
      connected: false,      // socket open
      received: false,       // at least one message ever arrived
      serverNow: function () { return performance.now() + offset; },
      // Remembered, and sent again on every reconnect.
      sendClient: function (newRole, newAudio) {
        role = newRole;
        audioState = newAudio;
        sendClientMessage();
      },
    };

    function call(fn, arg) {
      if (typeof fn !== 'function') return;
      try {
        fn(arg);
      } catch (err) {
        console.error('feed handler failed:', err);
      }
    }

    function resetClock() {
      slotMax.fill(-Infinity);
      slotId.fill(-1);
    }

    function addClockSample(localNow, serverNow) {
      const value = serverNow - localNow;
      const id = Math.floor(localNow / SLOT_MS);
      const slot = id % SLOTS;
      if (slotId[slot] !== id) {
        slotId[slot] = id;
        slotMax[slot] = value;
      } else if (value > slotMax[slot]) {
        slotMax[slot] = value;
      }
      let best = -Infinity;
      for (let i = 0; i < SLOTS; i++) {
        if (slotId[i] > id - SLOTS && slotMax[i] > best) best = slotMax[i];
      }
      offset = best;
    }

    function sendClientMessage() {
      if (!ws || ws.readyState !== 1 || role === null) return;
      try {
        ws.send(JSON.stringify({ type: 'client', role: role, audio: audioState || 'none' }));
      } catch (err) {
        // the close handler deals with a broken socket
      }
    }

    function sendBeat(localNow) {
      if (!ws || ws.readyState !== 1) return;
      lastBeatAt = localNow;
      try {
        ws.send('{"type":"beat"}');
      } catch (err) {
        // the close handler deals with a broken socket
      }
    }

    function setConnected(value) {
      if (feed.connected === value) return;
      feed.connected = value;
      call(handlers.onStatus, value);
    }

    function scheduleReconnect() {
      if (!retryTimer) retryTimer = setTimeout(open, RECONNECT_MS);
    }

    function drop() {
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch (err) { /* already closed */ }
        ws = null;
      }
      setConnected(false);
      scheduleReconnect();
    }

    function onMessage(ev) {
      const localNow = performance.now();   // before parsing, so parse time is not counted as delay
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      lastMessageAt = localNow;
      if (localNow - lastBeatAt >= BEAT_MS) sendBeat(localNow);
      if (typeof msg.now === 'number') addClockSample(localNow, msg.now);
      feed.received = true;
      if (msg.type === 'hello') {
        feed.config = msg.config || null;
        call(handlers.onHello, msg);
      } else if (msg.type === 'state') {
        call(handlers.onState, msg);
      } else if (msg.type === 'event') {
        call(handlers.onEvent, msg);
      }
      // anything else is ignored
    }

    function open() {
      retryTimer = 0;
      let sock;
      try {
        sock = new WebSocket(feed.url);
      } catch (err) {
        scheduleReconnect();
        return;
      }
      ws = sock;
      sock.onopen = function () {
        resetClock();   // a restarted server may have a new clock
        lastMessageAt = performance.now();
        lastBeatAt = -Infinity;
        setConnected(true);
        sendClientMessage();
      };
      sock.onmessage = onMessage;
      sock.onclose = drop;
      sock.onerror = drop;
    }

    setInterval(function () {
      if (feed.connected && performance.now() - lastMessageAt > STALE_MS) drop();
    }, 1000);

    resetClock();
    open();
    return feed;
  }

  global.StompFeed = { connect: connect };
})(window);
