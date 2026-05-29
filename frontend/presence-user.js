/**
 * presence.js  —  User-side WebSocket tracker
 * Drop <script src="presence.js"></script> on every page the user visits.
 * Works for both logged-in users and guests.
 */

(function () {
  'use strict';

  // ── ใช้ BA-tool backend (ไม่ใช่ admin console) ──────────────────────────
  // window.API_BASE ถูก inject ใน index.html ก่อน script นี้โหลดเสมอ
  // production: https://ba-tool-backend.onrender.com
  // local dev:  http://localhost:8000
  function resolveWsUrl() {
    const base = (window.API_BASE || '').trim().replace(/\/$/, '');
    if (base) {
      // แปลง http(s):// → ws(s)://
      return base.replace(/^http/, 'ws') + '/ws/presence';
    }
    // fallback local dev
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const host = isLocal ? 'localhost:8000' : 'ba-tool-backend.onrender.com';
    return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + host + '/ws/presence';
  }

  const WS_URL = resolveWsUrl();

  const PING_INTERVAL = 25_000;   // ms — must be < HEARTBEAT_INTERVAL on server
  const RECONNECT_DELAY = 5_000;

  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getUserId() {
    // Adjust to however your app stores the logged-in user id
    try {
      const session = JSON.parse(
        localStorage.getItem('ba_session') || sessionStorage.getItem('ba_session') || 'null'
      );
      return session?.user_id ?? session?.id ?? null;
    } catch {
      return null;
    }
  }

  function buildPayload() {
    return {
      event:      'user_online',
      user_id:    getUserId(),
      page:       location.pathname + location.search,
      user_agent: navigator.userAgent,
      timestamp:  new Date().toISOString(),
    };
  }

  // ── Connection ────────────────────────────────────────────────────────────

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && ws.readyState < 2) return; // already open / connecting

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify(buildPayload()));
      startPing();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event === 'pong') return; // heartbeat ack
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      stopPing();
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => ws.close();
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  function stopPing() {
    clearInterval(pingTimer);
  }

  // ── Page change tracking (SPA support) ───────────────────────────────────

  function notifyPageChange() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'page_change',
        page:  location.pathname + location.search,
      }));
    }
  }

  // Intercept pushState / replaceState for SPA navigation
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method];
    history[method] = function (...args) {
      orig.apply(this, args);
      notifyPageChange();
    };
  });
  window.addEventListener('popstate', notifyPageChange);

  // ── Cleanup on tab close ─────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    stopPing();
    ws?.close();
  });

  // ── Boot ──────────────────────────────────────────────────────────────────

  connect();
})();