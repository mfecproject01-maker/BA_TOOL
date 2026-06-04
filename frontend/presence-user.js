/**
 * presence.js  —  User-side WebSocket tracker
 * Drop <script src="presence.js"></script> on every page the user visits.
 * Works for both logged-in users and guests.
 */

(function () {
  'use strict';

  // ── ใช้ Admin Console backend เพื่อส่งสถานะ (Presence) ──────────────────
  // window.ADMIN_API_BASE ถูกกำหนดใน index.html ก่อน script นี้โหลดเสมอ
  // production: https://admin-console-batool.onrender.com
  // local dev:  http://localhost:8000 (หรือพอร์ตอื่นๆ ตามการตั้งค่า)
  function resolveWsUrl() {
    const base = (window.ADMIN_API_BASE || '').trim().replace(/\/$/, '');
    if (base) {
      // แปลง http(s):// → ws(s)://
      return base.replace(/^http/, 'ws') + '/ws/presence';
    }
    // fallback local dev / production
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const host = isLocal ? 'localhost:8000' : 'admin-console-batool.onrender.com';
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
      username:   localStorage.getItem('username') || null,
      session_id: window.sessionId || null,
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
        username: localStorage.getItem('username') || null,
        session_id: window.sessionId || null,
      }));
    }
  }

  // Presence state reporting (ACTIVE / BACKGROUND /INACTIVE)
  let inactivityTimer = null;
  const INACTIVE_DELAY = 3000; // 3s debounce

  function sendPresence(status) {
    const payload = {
      event: 'presence_update',
      status,
      username: localStorage.getItem('username') || null,
      session_id: window.sessionId || null,
      last_activity: new Date().toISOString(),
      page: location.pathname + location.search,
    };
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      // best-effort HTTP fallback
      try {
        if (window.API_BASE) fetch(window.API_BASE + '/presence', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }).catch(()=>{});
      } catch(e){}
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
      sendPresence('ACTIVE');
    } else {
      sendPresence('BACKGROUND');
      inactivityTimer = setTimeout(() => {
        if (document.visibilityState !== 'visible') sendPresence('INACTIVE');
      }, INACTIVE_DELAY);
    }
  }, { passive:true });

  ['mousemove','keydown','click','touchstart'].forEach(ev => {
    window.addEventListener(ev, () => {
      if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
      sendPresence('ACTIVE');
    }, { passive:true });
  });

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

  window.addEventListener('ba_username_changed', () => {
    if (ws) {
      ws.close();
      // wait a tiny bit for the close event to fire and clear the timer, then reconnect
      setTimeout(connect, 100);
    } else {
      connect();
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────

  connect();
})();
