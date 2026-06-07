/**
 * presence-user.js  —  User-side WebSocket tracker for BA Tool
 * Detects current app state and reports meaningful page names to Admin Console.
 */

(function () {
  'use strict';

  function resolveWsUrl() {
    const base = (window.ADMIN_API_BASE || '').trim().replace(/\/$/, '');
    if (base) return base.replace(/^http/, 'ws') + '/ws/presence';
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const host = isLocal ? 'localhost:8000' : 'admin-console-batool.onrender.com';
    return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + host + '/ws/presence';
  }

  const WS_URL         = resolveWsUrl();
  const PING_INTERVAL  = 25_000;
  const RECONNECT_DELAY = 5_000;

  let ws             = null;
  let pingTimer      = null;
  let reconnectTimer = null;

  // ── Detect current BA Tool page/state ────────────────────────────────────

  function getCurrentPage() {
    try {
      // มีผลลัพธ์ mapping แล้ว (sessionCard แสดงอยู่)
      const sessionCard = document.getElementById('sessionCard');
      if (sessionCard && sessionCard.style.display !== 'none' && sessionCard.style.display !== '') {
        return window._converted ? 'BA Tool: Converted' : 'BA Tool: Mapping Result';
      }
      // กำลัง bulk export
      const bulkSection = document.getElementById('bulkSection');
      if (bulkSection && bulkSection.classList.contains('visible')) {
        return 'BA Tool: Bulk Export';
      }
      // เปิด Reference panel
      const refPanel = document.getElementById('refPanel');
      if (refPanel && refPanel.classList.contains('open')) {
        return 'BA Tool: Reference';
      }
      // มีไฟล์ upload แล้วแต่ยังไม่ map
      if (window._uploadedFiles && window._uploadedFiles.length > 0) {
        return 'BA Tool: File Uploaded';
      }
      // หน้าหลัก
      return 'BA Tool: Home';
    } catch {
      return 'BA Tool';
    }
  }

  function getUsername() {
    return localStorage.getItem('username') ||
           sessionStorage.getItem('username') ||
           null;
  }

  function buildPayload() {
    return {
      event:      'user_online',
      user_id:    getUsername(),
      page:       getCurrentPage(),
      user_agent: navigator.userAgent.slice(0, 80),
      timestamp:  new Date().toISOString(),
    };
  }

  // ── Connection ────────────────────────────────────────────────────────────

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && ws.readyState < 2) return;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify(buildPayload()));
      startPing();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event === 'pong') return;
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

  function stopPing() { clearInterval(pingTimer); }

  // ── Page change tracking ──────────────────────────────────────────────────

  function notifyPageChange() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'page_change',
        page:  getCurrentPage(),
      }));
    }
  }

  // ── Observe DOM changes to detect state changes ───────────────────────────
  // เมื่อ sessionCard หรือ bulkSection เปลี่ยน visibility → แจ้ง page change

  function observeStateChanges() {
    const targets = ['sessionCard', 'bulkSection', 'refPanel'];
    const observer = new MutationObserver(() => notifyPageChange());

    targets.forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    });
  }

  // รอให้ DOM พร้อมก่อน observe
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeStateChanges);
  } else {
    observeStateChanges();
  }

  // ── Visibility / activity tracking ───────────────────────────────────────

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notifyPageChange();
  }, { passive: true });

  // SPA navigation support
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method];
    history[method] = function (...args) { orig.apply(this, args); notifyPageChange(); };
  });
  window.addEventListener('popstate', notifyPageChange);

  // ── Username change ───────────────────────────────────────────────────────

  window.addEventListener('ba_username_changed', () => {
    if (ws) { ws.close(); setTimeout(connect, 100); }
    else connect();
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => { stopPing(); ws?.close(); });

  // ── Boot ──────────────────────────────────────────────────────────────────

  connect();
})();
