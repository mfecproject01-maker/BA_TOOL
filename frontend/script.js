// ─────────────────────────────────────────────────────────────
//  SQL File Converter — script.js
//  Flow:
//    SQL  → upload → POST /convert (auto) → backend mapping → render
//    CSV/Excel → parse local → render (ไม่ผ่าน backend)
//    Override → POST /override/:id → sync ทันที
// ─────────────────────────────────────────────────────────────

function resolveApiBase() {
  // รับค่าจาก window.API_BASE ที่ inject ใน index.html ก่อน
  const configured = (window.API_BASE || '').trim();
  if (configured) return configured.replace(/\/$/, '');

  const { hostname } = window.location;
  const host = hostname || 'localhost';

  // local dev
  if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000';

  // production → ใช้ Render backend
  return 'https://ba-tool-backend.onrender.com';
}

let API_BASE = resolveApiBase();

async function fetchWithApiFallback(path, options) {
  const candidates = [API_BASE];
  if (API_BASE === 'http://localhost:8000') candidates.push('http://127.0.0.1:8000');
  if (API_BASE === 'http://127.0.0.1:8000') candidates.push('http://localhost:8000');

  let lastErr = null;
  for (const base of [...new Set(candidates)]) {
    try {
      const res = await fetch(`${base}${path}`, options);
      API_BASE = base;

      // Detect session-not-found responses and surface a premium overlay
      if (res.status === 404) {
        try {
          const body = await res.clone().json().catch(() => ({}));
          const msg = (body && (body.detail || body.message || body.error)) || '';
          if (/session not found|session.*not found|session.*expired/i.test(msg) || /session not found/i.test(msg)) {
            // show overlay but continue returning response so existing callers can handle it
            try { showSessionExpiredOverlay(); } catch (e) { /* ignore */ }
          }
        } catch (e) {}
      }

      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Unable to reach API');
}

// ── State ──────────────────────────────────────────────────
let currentData   = {};  // { [tableName]: { headers, rows, fileName, fileType, backendCols? } }
let uploadedFiles = [];  // { name, type, fileObj }
let sessionId     = null;
let converted     = false;

// ─── File Input / Drag & Drop ──────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => handleFiles(e.target.files));

function onDragOver(e)  { e.preventDefault(); document.getElementById('dropzone').classList.add('drag-over'); }
function onDragLeave()  { document.getElementById('dropzone').classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
}

// ═══════════════════════════════════════════════════════════
//  DATABASE SELECTION
// ═══════════════════════════════════════════════════════════

const _DB_LOGOS = {
  postgres: {
    label: 'PostgreSQL', color: '#336791',
    logo: 'images/logo-postgresql.svg'
  },
  mysql: {
    label: 'MySQL', color: '#4479a1',
    logo: 'images/logo-mysql.svg'
  },
  sqlserver: {
    label: 'SQL Server', color: '#cc2927',
    logo: 'images/logo-sqlserver.svg'
  },
  oracle: {
    label: 'Oracle', color: '#f80000',
    logo: 'images/logo-oracle.svg'
  },
};

function _dbKey(dbId) {
  const id = (dbId || '').toLowerCase();
  if (id.includes('postgres'))                          return 'postgres';
  if (id.includes('mysql'))                             return 'mysql';
  if (id.includes('oracle'))                            return 'oracle';
  if (id.includes('sqlserver') || id.includes('mssql')) return 'sqlserver';
  return null;
}

function _renderDbBadge(typeEl, infoEl, dbId) {
  if (!dbId) {
    typeEl.innerHTML          = '—';
    typeEl.style.background   = '';
    typeEl.style.borderColor  = '';
    infoEl.innerHTML          = '';
    return;
  }
  const key  = _dbKey(dbId);
  const meta = key ? _DB_LOGOS[key] : null;
  if (meta) {
    typeEl.innerHTML = `
      <span class="db-brand-mark">
        <img src="${meta.logo}" alt="${meta.label} logo" class="db-brand-logo">
      </span>`;
    typeEl.style.background  = `${meta.color}18`;
    typeEl.style.borderColor = `${meta.color}66`;
    infoEl.innerHTML = `<div class="db-details" style="color:${meta.color}bb">${dbId}</div>`;
  } else {
    typeEl.textContent        = dbId;
    typeEl.style.background   = '';
    typeEl.style.borderColor  = '';
    infoEl.innerHTML = `<div class="db-details">${dbId}</div>`;
  }
}

function onSourceDbChange() {
  const src = document.getElementById('sourceDbSelect').value;
  filterDestOptionsForSource(src);
  _renderDbBadge(
    document.getElementById('sourceDbType'),
    document.getElementById('sourceDbInfo'),
    src
  );
}

function onDestDbChange() {
  _renderDbBadge(
    document.getElementById('destDbType'),
    document.getElementById('destDbInfo'),
    document.getElementById('destDbSelect').value
  );
}

// ═══════════════════════════════════════════════════════════
//  HANDLE FILES — entry point
// ═══════════════════════════════════════════════════════════
async function handleFiles(files) {
  if (!files || files.length === 0) return;

  const supported = Array.from(files).filter(f => /\.(csv|xlsx|sql)$/i.test(f.name));
  if (!supported.length) {
    showStatus('uploadStatus', 'error', 'ไม่รองรับไฟล์ประเภทนี้ (CSV, Excel, SQL เท่านั้น)');
    return;
  }

  currentData   = {};
  uploadedFiles = [];
  sessionId     = null;
  converted     = false;
  document.getElementById('fileList').innerHTML = '';
  document.getElementById('convertBtn').disabled = true;
  clearUI();

  const dupIssues = await detectDuplicates(supported);
  if (dupIssues.length > 0) {
    const decision = await showDuplicateModal(dupIssues, supported);
    if (decision === 'cancel') {
      showStatus('uploadStatus', 'error', '⚠️ ยกเลิกการอัปโหลด — กรุณาเลือกไฟล์ใหม่');
      return;
    }
  }

  setLoading(true);

  const sqlFiles   = supported.filter(f => /\.sql$/i.test(f.name));
  const localFiles = supported.filter(f => /\.(csv|xlsx)$/i.test(f.name));

  supported.forEach(f => {
    const ext  = f.name.split('.').pop().toLowerCase();
    const type = ext === 'sql' ? 'sql' : ext === 'csv' ? 'csv' : 'excel';
    uploadedFiles.push({ name: f.name, type, fileObj: f });
    renderFileChip(f.name, type);
  });

  await Promise.all(localFiles.map(f => parseLocalFile(f)));

  if (sqlFiles.length > 0) {
    showStatus('uploadStatus', 'info', `⏳ กำลัง mapping ${sqlFiles.length} SQL file กับ backend...`);
    await sendSQLToBackend(sqlFiles);
  } else {
    setLoading(false);
    onAllDone();
  }
}

// ─── Parse CSV / Excel locally ─────────────────────────────
function parseLocalFile(file) {
  return new Promise(resolve => {
    const ext    = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();

    if (ext === 'csv') {
      reader.onload = e => {
        try { parseCSV(file.name, e.target.result); } catch {}
        resolve();
      };
      reader.readAsText(file, 'utf-8');
    } else {
      reader.onload = e => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          wb.SheetNames.forEach(sheet => {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet]);
            if (rows.length > 0) {
              const key = file.name.replace(/\.[^/.]+$/, '') +
                          (wb.SheetNames.length > 1 ? '_' + sheet : '');
              currentData[key] = { headers: Object.keys(rows[0]), rows, fileName: file.name, fileType: 'excel' };
            }
          });
        } catch {}
        resolve();
      };
      reader.readAsArrayBuffer(file);
    }
  });
}

function parseCSV(fileName, text) {
  const lines    = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) return;
  const headers = parseCSVLine(nonEmpty[0]);
  const rows    = nonEmpty.slice(1).map(line => {
    const vals = parseCSVLine(line);
    return headers.reduce((obj, h, i) => { obj[h] = vals[i] ?? ''; return obj; }, {});
  });
  currentData[fileName.replace(/\.[^/.]+$/, '')] = { headers, rows, fileName, fileType: 'csv' };
}

function parseCSVLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

// ═══════════════════════════════════════════════════════════
//  BACKEND — POST /convert
// ═══════════════════════════════════════════════════════════
async function sendSQLToBackend(sqlFiles) {
  const sourceDb = document.getElementById('sourceDbSelect').value;
  const destDb   = document.getElementById('destDbSelect').value;

  if (!sourceDb || !destDb) {
    showStatus('uploadStatus', 'error', '❌ กรุณาเลือก Source และ Destination Database ก่อน');
    setLoading(false);
    onAllDone();
    return;
  }

  const form = new FormData();
  sqlFiles.forEach(f => form.append('files', f, f.name));
  form.append('source_db', sourceDb);
  form.append('dest_db',   destDb);

  try {
    const res = await fetchWithApiFallback('/convert', { method: 'POST', body: form });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    sessionId = data.session_id;

    applyBackendTables(
      data.tables,
      data.unknown || {},
      data.byte_anomalies || {},
      data.duplicate_tables || {},
      data.fk_errors || []
    );

    const unknownCount = Object.values(data.unknown || {}).flat().length;
    const anomalyCount = Object.values(data.byte_anomalies || {}).flat().length;
    const contentDups  = data.content_dup_warnings || [];

    if (unknownCount > 0) renderUnknownWarnings(data.unknown);
    if (data.fk_errors && data.fk_errors.length > 0) renderFKErrors(data.fk_errors);
    if (anomalyCount > 0) renderByteAnomalyWarnings(data.byte_anomalies);
    if (contentDups.length > 0) renderContentDupWarnings(contentDups);

    const dbPairLabel = data.source_db && data.dest_db
      ? ` [${data.source_db} → ${data.dest_db}]` : '';
    showStatus('uploadStatus', 'success',
      `✓ Backend mapping สำเร็จ${dbPairLabel} — ${Object.keys(data.tables).length} table` +
      (unknownCount ? ` (⚠️ ${unknownCount} unknown type)` : '') +
      (anomalyCount ? ` (🔴 ${anomalyCount} byte anomaly)` : '') +
      (contentDups.length ? ` (🔁 ${contentDups.length} content ซ้ำ)` : '')
    );

  } catch (err) {
    showStatus('uploadStatus', 'error', '❌ Backend: ' + err.message);
  } finally {
    setLoading(false);
    onAllDone();
  }
}

function applyBackendTables(tables, unknown, byteAnomalies = {}, duplicateTables = {}, fkErrors = []) {
  const dupTableNames = new Set(Object.keys(duplicateTables));

  Object.entries(tables).forEach(([tableKey, cols]) => {
    const fileName    = cols[0]?.file || 'unknown.sql';
    const baseName    = tableKey.includes('__') ? tableKey.split('__')[0] : tableKey;
    const isDuplicate = cols[0]?.is_duplicate || tableKey.includes('__') || dupTableNames.has(baseName);
    const unknownCols = (unknown[tableKey] || []).map(u => u.column_name || u.column);
    const anomalyCols = (byteAnomalies[tableKey] || []).filter(a => a && typeof a === 'object').map(a => a.column_name);
    const tableFkErrors = (fkErrors || []).filter(e => e.table === tableKey || e.table === baseName);

    currentData[tableKey] = {
      headers    : cols.map(c => c.column_name),
      rows       : [],
      fileName,
      fileType   : 'sql',
      isDuplicate,
      backendCols: cols.map(c => {
        const fkError = tableFkErrors.find(e => e.column === c.column_name);
        return {
          ...c,
          isUnknown    : unknownCols.includes(c.column_name),
          isByteAnomaly: anomalyCols.includes(c.column_name),
          fkError,
        };
      })
    };
  });
}

function onAllDone() {
  converted = true;
  const tableCount = Object.keys(currentData).length;
  const rowCount   = Object.values(currentData).reduce((s, t) => s + t.rows.length, 0);

  updateStats(uploadedFiles.length, tableCount, rowCount);
  updateBadges(tableCount, rowCount, sessionId ? 'mapped' : 'loaded');
  renderTypePanel();
  renderTables();
  document.getElementById('convertBtn').disabled = false;

  if (sessionId) {
    const card = document.getElementById('sessionCard');
    const disp = document.getElementById('sessionIdDisplay');
    if (card) card.style.display = 'block';
    if (disp) disp.textContent   = sessionId;
  }
}

// ═══════════════════════════════════════════════════════════
//  CONVERT BUTTON
// ═══════════════════════════════════════════════════════════
async function convertData() {
  const sqlFiles = uploadedFiles.filter(f => f.type === 'sql').map(f => f.fileObj);

  if (!sqlFiles.length) {
    showStatus('convertStatus', 'success', '✓ ไม่มีไฟล์ SQL — ข้อมูล local พร้อมแล้ว');
    return;
  }

  const sourceDb = document.getElementById('sourceDbSelect').value;
  const destDb   = document.getElementById('destDbSelect').value;
  if (!sourceDb || !destDb) {
    showStatus('convertStatus', 'error', '❌ กรุณาเลือก Source และ Destination Database ก่อน');
    return;
  }

  if (sessionId) await deleteSession(true);

  setLoading(true);
  showStatus('convertStatus', 'info', '⏳ Re-mapping กับ backend...');
  await sendSQLToBackend(sqlFiles);
  setLoading(false);

  const card = document.getElementById('sessionCard');
  const disp = document.getElementById('sessionIdDisplay');
  if (sessionId) {
    if (card) card.style.display = 'block';
    if (disp) disp.textContent = sessionId;
  }
}

async function syncSessionDiagnostics() {
  if (!sessionId) return;

  const res = await fetchWithApiFallback(`/result/${sessionId}`);
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  }

  const data = await res.json();
  applyBackendTables(
    data.tables,
    data.unknown || {},
    data.byte_anomalies || {},
    data.duplicate_tables || {},
    data.fk_errors || []
  );

  document.getElementById('unknownWarnings')?.remove();
  document.getElementById('byteAnomalyWarnings')?.remove();
  document.getElementById('fkErrorPanel')?.remove();

  if (Object.values(data.unknown || {}).flat().length > 0) renderUnknownWarnings(data.unknown);
  if ((data.fk_errors || []).length > 0) renderFKErrors(data.fk_errors);
  if (Object.values(data.byte_anomalies || {}).flat().length > 0) {
    renderByteAnomalyWarnings(data.byte_anomalies);
  }

  renderTypePanel();
  renderTables();
}

// ═══════════════════════════════════════════════════════════
//  RESULT / DELETE SESSION
// ═══════════════════════════════════════════════════════════
async function fetchResult() {
  if (!sessionId) { showStatus('convertStatus', 'error', 'ยังไม่มี session'); return; }
  setLoading(true);
  try {
    const res = await fetchWithApiFallback(`/result/${sessionId}`);
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || res.statusText);
    const data = await res.json();
    applyBackendTables(
      data.tables,
      data.unknown || {},
      data.byte_anomalies || {},
      data.duplicate_tables || {},
      data.fk_errors || []
    );
    if (Object.values(data.byte_anomalies || {}).flat().length > 0)
      renderByteAnomalyWarnings(data.byte_anomalies);
    renderTypePanel();
    renderTables();
    showStatus('convertStatus', 'success', '✓ Refresh result สำเร็จ');
  } catch (err) {
    showStatus('convertStatus', 'error', '❌ ' + err.message);
  } finally { setLoading(false); }
}

async function deleteSession(silent = false) {
  if (!sessionId) return;
  try {
    await fetchWithApiFallback(`/session/${sessionId}`, { method: 'DELETE' });
    if (!silent) showStatus('convertStatus', 'success', '✓ ลบ session แล้ว');
  } catch {}
  sessionId = null;
}

async function handleDeleteSession() {
  await deleteSession();
  const card = document.getElementById('sessionCard');
  const disp = document.getElementById('sessionIdDisplay');
  if (card) card.style.display = 'none';
  if (disp) disp.textContent   = '—';
}

// ═══════════════════════════════════════════════════════════
//  TYPE PANEL
// ═══════════════════════════════════════════════════════════
function renderTypePanel() {
  const body = document.getElementById('typeTableBody');
  if (!body) return;
  const keys  = Object.keys(currentData);

  if (!keys.length) {
    body.innerHTML = '<tr><td colspan="3"><div class="empty-hint">No file loaded</div></td></tr>';
    return;
  }

  const sqlKey = keys.find(k => currentData[k].backendCols);

  if (sqlKey) {
    const cols = currentData[sqlKey].backendCols;
    body.innerHTML = cols.map(col => `
      <tr class="${col.isUnknown ? 'row-unknown' : ''}">
        <td>
          <span class="col-name">${col.column_name}</span>
          ${col.isUnknown ? '<span class="unk-badge">?</span>' : ''}
        </td>
        <td>
          <span class="inferred-badge">${col.logical_type || col.raw_type || '—'}</span>
          <div class="src-type">${col.source_sql_type || ''}</div>
        </td>
        <td>
          <span class="inferred-badge">${col.final_type || col.source_sql_type || '—'}</span>
        </td>
      </tr>`).join('');
  } else {
    const firstKey = keys[0];
    const first = currentData[firstKey];
    body.innerHTML = first.headers.map(h => {
      const inf = inferLocalType(first.rows.map(r => r[h]));
      return `<tr>
        <td><span class="col-name">${h}</span></td>
        <td><span class="inferred-badge">${inf}</span></td>
        <td><span class="inferred-badge">${inf}</span></td>
      </tr>`;
    }).join('');
  }
}

function inferLocalType(values) {
  const s = values.filter(v => v !== '' && v != null).slice(0, 50);
  if (!s.length)                                    return 'VARCHAR';
  if (s.every(v => /^-?\d+$/.test(v)))             return 'INT';
  if (s.every(v => /^-?\d+(\.\d+)?$/.test(v)))     return 'DECIMAL';
  if (s.every(v => /^\d{4}-\d{2}-\d{2}/.test(v))) return 'DATE';
  if (s.every(v => /^(true|false|0|1)$/i.test(v))) return 'BOOLEAN';
  return 'VARCHAR';
}

// ═══════════════════════════════════════════════════════════
//  RENDER TABLES
// ═══════════════════════════════════════════════════════════
const FILE_TYPE_META = {
  csv  : { label:'CSV',   icon:'📄', color:'var(--accent)',  dim:'rgba(0,214,143,0.12)' },
  excel: { label:'Excel', icon:'📊', color:'var(--accent2)', dim:'rgba(0,148,255,0.12)' },
  sql  : { label:'SQL',   icon:'🗃️',  color:'var(--warn)',    dim:'rgba(245,166,35,0.12)' },
};

function buildDestBadge() {
  const destVal = document.getElementById('destDbSelect')?.value;
  if (!destVal) return '';
  const shortLabel = destVal.length > 16 ? destVal.slice(0, 14) + '…' : destVal;
  return `<span class="dest-ctx-badge" title="Destination: ${escapeHtmlAttr(destVal)}">
    <svg width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
      <path d="M12 21V11"/><path d="m8 15 4-4 4 4"/>
    </svg>Target: ${escapeHtml(shortLabel)}</span>`;
}

function renderTables() {
  const grid = document.getElementById('tablesGrid');
  const bulk = document.getElementById('bulkSection');
  const keys  = Object.keys(currentData);

  if (!keys.length) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">📭</div>
      <div class="empty-state-text">ไม่พบตารางในไฟล์นี้</div>
    </div>`;
    bulk.classList.remove('visible');
    return;
  }

  const groups = {};
  keys.forEach(k => {
    const ft = currentData[k].fileType || 'csv';
    if (!groups[ft]) groups[ft] = [];
    groups[ft].push(k);
  });

  bulk.classList.add('visible');

  grid.innerHTML = ['csv','excel','sql'].filter(ft => groups[ft]).map(ft => {
    const meta      = FILE_TYPE_META[ft];
    const tkeys     = groups[ft];
    return `
      <div class="type-group">
        <div class="type-group-header" style="--g-color:${meta.color};--g-dim:${meta.dim}">
          <span class="type-group-icon">${meta.icon}</span>
          <span class="type-group-label">${meta.label}</span>
          <span class="type-group-count">${tkeys.length} table${tkeys.length>1?'s':''}</span>
          <div class="type-group-line"></div>
        </div>
        <div class="tables-subgrid">
          ${tkeys.map(k => buildTableCard(k)).join('')}
        </div>
      </div>`;
  }).join('');
}

function buildTableCard(k) {
  const t     = currentData[k];
  const isSql = !!t.backendCols;

  const pillsBlock = isSql
    ? `<div class="backend-cols" id="pills-${k}">${buildPillsHTML(t.backendCols)}</div>`
    : '';

  const previewCols = isSql ? MAP_HEADERS : t.headers;
  const previewSrc  = isSql ? toMappingRows(t.backendCols) : t.rows;
  const previewRows = previewSrc;

  const dupBannerRow = t.isDuplicate
    ? `<tr><th colspan="${previewCols.length || 1}" class="preview-th-dup">⚠ DUPLICATE TABLE</th></tr>`
    : '';
  const theadHtml = previewCols.map((h, idx) =>
    `<th class="${idx === 0 && isSql ? 'preview-th-num' : ''}" title="${escapeHtmlAttr(h)}">${escapeHtml(h)}</th>`).join('');
  const tbodyHtml = previewRows.map((r, i) =>
    `<tr class="${i % 2 === 1 ? 'preview-row-alt' : ''}">
      ${previewCols.map((h, idx) =>
        `<td class="${idx === 0 && isSql ? 'preview-td-num' : ''}">${escapeHtml(String(r[h] ?? ''))}</td>`
      ).join('')}
    </tr>`
  ).join('');
  const noDataHtml = `<tr><td colspan="${previewCols.length || 1}" class="no-data-cell">No data</td></tr>`;

  const sessionTag = sessionId
    ? `<span class="session-tag" title="session: ${sessionId}">🔗 mapped</span>` : '';

  return `
  <div class="table-card${t.isDuplicate ? ' is-duplicate' : ''}">
    <div class="table-card-header" onclick="openTableModal('${k}')" title="คลิกเพื่อดูตารางแบบเต็ม">
      <div class="table-card-icon">${isSql ? '🗃️' : '📊'}</div>
      <div style="min-width:0;flex:1">
        <div class="table-card-name" title="${k}">
          <span>${k.includes('__') ? k.split('__')[0] : k}</span>
          ${sessionTag}
          ${t.isDuplicate ? '<span class="dup-badge">⚠ DUPLICATE</span>' : ''}
          ${buildDestBadge()}
        </div>
        <div class="table-card-meta">
          <span>${t.headers.length}</span> cols ·
          ${isSql
            ? `<span class="mapped-label">backend mapped</span> · ${t.fileName}`
            : `<span>${t.rows.length.toLocaleString()}</span> rows · ${t.fileName}`}
        </div>
      </div>
      <div class="expand-hint">
        <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
        expand
      </div>
    </div>
    ${pillsBlock}
    <div class="preview-wrap">
      <table class="preview-table">
        <thead>${dupBannerRow}<tr>${theadHtml || '<th>—</th>'}</tr></thead>
        <tbody>${tbodyHtml || noDataHtml}</tbody>
      </table>
    </div>

    <div class="table-card-actions">
      ${isSql ? `
      <button class="btn-card-dl xlsx" onclick="downloadTableXLSX('${k}')">⬇ Mapping XLSX</button>
      ` : `
      <button class="btn-card-dl csv"  onclick="downloadTable('${k}','csv')">⬇ CSV</button>
      <button class="btn-card-dl xlsx" onclick="downloadTable('${k}','xlsx')">⬇ XLSX</button>
      `}
    </div>
  </div>`;
}

function buildTypeFlowHTML(backendCols) {
  if (!backendCols.length) {
    return `<span class="bcol-empty-hint">ไม่มีคอลัมน์</span>`;
  }

  return backendCols.map(c => {
    const constraintBadges = [];
    if (c.is_pk) constraintBadges.push('<span class="type-badge badge-pk">🔑 PK</span>');
    if (c.fk) constraintBadges.push(
      `<span class="type-badge badge-fk" title="FK → ${c.fk.ref_table}.${c.fk.ref_column || '?'}">🔗 FK</span>`
    );
    if (c.isUnknown) constraintBadges.push('<span class="type-badge badge-unknown">❓ Unknown</span>');
    if (c.isByteAnomaly) constraintBadges.push('<span class="type-badge badge-anomaly">🔴 Anomaly</span>');

    const typeFlow = [
      c.source_sql_type,
      c.raw_type,
      c.logical_type,
      c.standard_type,
      c.final_type,
    ].filter(t => t).map((t, i) => {
      const badges = ['source', 'raw', 'logical', 'standard', 'final'];
      const badgeClass = badges[i] || 'unknown';
      return `<span class="type-badge badge-${badgeClass}">${t}</span>`;
    });

    const nullableInd = c.nullable && c.nullable.toUpperCase() === 'NOT NULL' ? '❌' : '✓';

    return `
    <div class="type-flow-row">
      <div class="column-info">
        <span class="col-name">${c.column_name}</span>
        <span class="nullable-ind" title="${c.nullable}">${nullableInd}</span>
      </div>
      <div class="type-flow-badges">
        ${typeFlow.join('<span class="flow-arrow">→</span>')}
      </div>
      <div class="constraint-badges">
        ${constraintBadges.join('')}
      </div>
    </div>`;
  }).join('');
}

function renderUnknownWarnings(unknown) {
  document.getElementById('unknownWarnings')?.remove();
  const items = Object.entries(unknown).flatMap(([tbl, cols]) =>
    cols.map(c => `<li><b>${tbl}</b>.<span>${c.column_name}</span> — ${c.reason||'ไม่รู้จัก type'}</li>`)
  );
  if (!items.length) return;
  const div = document.createElement('div');
  div.id        = 'unknownWarnings';
  div.className = 'warn-panel';
  div.innerHTML = `
    <div class="warn-panel-header">
      ⚠️ Unknown Types (${items.length})
      <button onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <ul>${items.join('')}</ul>`;
  document.getElementById('tablesGrid').insertAdjacentElement('beforebegin', div);
}

function renderByteAnomalyWarnings(byteAnomalies) {
  document.getElementById('byteAnomalyWarnings')?.remove();
  const items = Object.entries(byteAnomalies).flatMap(([tbl, cols]) =>
    cols
      .filter(c => c && typeof c === 'object')
      .map(c => `
      <li>
        <div class="anomaly-row">
          <span class="anomaly-loc"><b>${tbl}</b>.<code>${c.column_name}</code></span>
          <span class="anomaly-tag">source: <em>${c.source_type}</em> → raw: <em>${c.raw_type}</em></span>
        </div>
        <div class="anomaly-detail">${c.detail || ''}</div>
        <div class="anomaly-file">📄 ${c.file || ''}</div>
      </li>`)
  );
  if (!items.length) return;

  const div = document.createElement('div');
  div.id        = 'byteAnomalyWarnings';
  div.className = 'warn-panel byte-anomaly-panel';
  div.innerHTML = `
    <div class="warn-panel-header byte-anomaly-header">
      <span>🔴 ตรวจพบข้อมูลไม่ปกติ — Byte Conversion Anomaly (${items.length} คอลัมน์)</span>
      <div class="anomaly-actions">
        <span class="anomaly-hint">คอลัมน์เหล่านี้ถูกแปลงเป็น byte แต่ type ต้นทางไม่ใช่ decimal — กรุณาตรวจสอบ mapping</span>
        <button onclick="this.closest('#byteAnomalyWarnings').remove()">✕</button>
      </div>
    </div>
    <ul>${items.join('')}</ul>`;
  document.getElementById('tablesGrid').insertAdjacentElement('beforebegin', div);
}

function renderContentDupWarnings(warnings) {
  document.getElementById('contentDupWarnings')?.remove();
  const items = warnings.map(w => `
    <li>
      <div class="anomaly-row">
        <span class="anomaly-loc"><b>${w.file}</b></span>
        <span class="anomaly-tag">🔁 เหมือนกับ <em>${w.duplicate_of}</em></span>
      </div>
      <div class="anomaly-detail">${w.msg}</div>
    </li>`);
  const div = document.createElement('div');
  div.id        = 'contentDupWarnings';
  div.className = 'warn-panel';
  div.innerHTML = `
    <div class="warn-panel-header">
      🔁 พบไฟล์ที่มีเนื้อหาซ้ำกัน (${warnings.length} ไฟล์) — แยก table ให้อัตโนมัติแล้ว
      <button onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <ul>${items.join('')}</ul>`;
  document.getElementById('tablesGrid').insertAdjacentElement('beforebegin', div);
}

// ═══════════════════════════════════════════════════════════
//  DOWNLOAD
// ═══════════════════════════════════════════════════════════
const MAP_HEADERS = ['file','ลำดับ','column_name','source_sql_type','raw_type','logical_type','final_type','nullable','is_pk','fk_ref'];

function toMappingRows(backendCols) {
  return backendCols.map((c, i) => ({
    'ลำดับ'          : i + 1,
    column_name     : c.column_name,
    file            : c.file            || '',
    raw_type        : c.raw_type        || '',
    logical_type    : c.logical_type    || '',
    final_type      : c.final_type      || '',
    source_sql_type : c.source_sql_type || '',
    nullable        : c.nullable        || 'NULL',
    is_pk           : c.is_pk ? 'PK' : '',
    fk_ref          : c.fk ? `${c.fk.ref_table}.${c.fk.ref_column || '?'}` : '',
  }));
}

async function downloadTable(key, fmt) {
  const t = currentData[key];
  if (!t) return;

  if (t.backendCols && sessionId && fmt === 'csv') {
    setLoading(true);
    try {
      const res = await fetchWithApiFallback(`/export/${sessionId}/csv/${key}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      triggerDownload(await res.blob(), `${key}.csv`);
    } catch (err) {
      showStatus('convertStatus', 'error', '❌ ' + err.message);
    } finally { setLoading(false); }
    return;
  }

  const headers = t.backendCols ? MAP_HEADERS : t.headers;
  const rows    = t.backendCols ? toMappingRows(t.backendCols) : t.rows;
  const name    = t.backendCols ? key + '_mapping' : key;

  if (fmt === 'csv') {
    const body = [headers.map(escCSV).join(','),
      ...rows.map(r => headers.map(h => escCSV(r[h] ?? '')).join(','))
    ].join('\n');
    triggerDownload(new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8;' }), name + '.csv');
  } else {
    const wb = XLSX.utils.book_new();
    const ws = makeSheet(rows, headers);
    if (t.backendCols) ws['!cols'] = [{wch:8},{wch:24},{wch:16},{wch:14},{wch:14},{wch:20},{wch:32},{wch:12}];
    XLSX.utils.book_append_sheet(wb, ws, 'data');
    XLSX.writeFile(wb, name + '.xlsx');
  }
}

async function downloadAllCSV() { showTableSelectorModal('csv'); }

function downloadAllExcel() {
  const keys = Object.keys(currentData);
  if (!keys.length) return;
  const wb = XLSX.utils.book_new();

  keys.forEach(k => {
    const t       = currentData[k];
    const headers = t.backendCols ? MAP_HEADERS : t.headers;
    const rows    = t.backendCols ? toMappingRows(t.backendCols) : t.rows;
    const ws      = makeSheet(rows, headers);
    if (t.backendCols) ws['!cols'] = [{wch:8},{wch:24},{wch:16},{wch:14},{wch:14},{wch:20},{wch:32},{wch:12}];
    XLSX.utils.book_append_sheet(wb, ws, k.substring(0, 31));
  });

  XLSX.writeFile(wb, makeExportFilename(keys, 'xlsx'));
  showStatus('convertStatus', 'success', '✓ ดาวน์โหลด Excel สำเร็จ');
}

function makeSheet(rows, headers) {
  if (rows.length) return XLSX.utils.json_to_sheet(rows, { header: headers });
  return XLSX.utils.aoa_to_sheet([headers]);
}

function dlCSV(name, table) {
  const body = [table.headers.map(escCSV).join(','),
    ...table.rows.map(r => table.headers.map(h => escCSV(r[h] ?? '')).join(','))
  ].join('\n');
  triggerDownload(new Blob(['\uFEFF' + body], { type: 'text/csv;charset=utf-8;' }), name + '.csv');
}

function dlExcel(name, table) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet(table.rows, table.headers), name.substring(0, 31));
  XLSX.writeFile(wb, name + '.xlsx');
}

function escCSV(v) {
  const s = String(v);
  return (s.includes(',')||s.includes('"')||s.includes('\n')) ? '"'+s.replace(/"/g,'""')+'"' : s;
}

function triggerDownload(blob, filename) {
  const a = Object.assign(document.createElement('a'),
    { href: URL.createObjectURL(blob), download: filename, style: 'display:none' });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function makeExportFilename(tableKeys, ext) {
  const clean = tableKeys.map(k => k.replace(/[^\w]/g, '_'));
  const joined = clean.length > 5
    ? `${clean[0]}_and_${clean.length - 1}_more`
    : clean.join('_');
  return `${joined}_confluent.${ext}`;
}

// ═══════════════════════════════════════════════════════════
//  FULLSCREEN TABLE MODAL
// ═══════════════════════════════════════════════════════════
let _modalKey      = null;
let _modalSort     = { col: null, dir: 'asc' };
let _modalFilter   = '';

function openTableModal(key) {
  _modalKey    = key;
  _modalSort   = { col: null, dir: 'asc' };
  _modalFilter = '';

  const t     = currentData[key];
  const isSql = !!t.backendCols;
  const cols  = isSql ? MAP_HEADERS : t.headers;
  const src   = isSql ? toMappingRows(t.backendCols) : t.rows;

  const overlay = document.createElement('div');
  overlay.className = 'table-modal-overlay';
  overlay.id        = 'tableModalOverlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeTableModal(); });

  const destBadgeHtml = buildDestBadge();

  overlay.innerHTML = `
    <div class="table-modal" id="tableModal">
      <div class="table-modal-header">
        <div class="table-modal-icon">${isSql ? '🗃️' : '📊'}</div>
        <div style="min-width:0;flex:1">
          <div class="table-modal-title-row">
            <div class="table-modal-title">${key.includes('__') ? key.split('__')[0] : key}${currentData[key]?.isDuplicate ? ' <span class="dup-badge">⚠ DUPLICATE</span>' : ''}</div>
            ${destBadgeHtml}
          </div>
          <div class="table-modal-meta">${cols.length} cols · ${src.length.toLocaleString()} rows · ${t.fileName}</div>
        </div>
        <div class="table-modal-search">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="text" id="modalSearchInput" placeholder="ค้นหา..." oninput="onModalSearch(this.value)" autocomplete="off">
        </div>
        <button class="table-modal-close" onclick="closeTableModal()" title="ปิด (Esc)">✕</button>
      </div>
      <div class="table-modal-toolbar">
        ${isSql ? `
        <button class="btn-card-dl xlsx" style="flex:0;padding:6px 14px;font-size:0.75em"
          onclick="downloadTableXLSX('${key}')">⬇ Mapping XLSX</button>
        ` : `
        <button class="btn-card-dl csv" style="flex:0;padding:6px 14px;font-size:0.75em"
          onclick="downloadTable('${key}','csv')">⬇ CSV</button>
        <button class="btn-card-dl xlsx" style="flex:0;padding:6px 14px;font-size:0.75em"
          onclick="downloadTable('${key}','xlsx')">⬇ XLSX</button>
        `}
        <div class="modal-row-count" id="modalRowCount">
          แสดง <span id="modalVisibleCount">${src.length.toLocaleString()}</span> / ${src.length.toLocaleString()} แถว
        </div>
      </div>
      <div class="table-modal-body" id="tableModalBody"></div>
    </div>`;

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  renderModalTable(cols, src, isSql);
  setTimeout(() => document.getElementById('modalSearchInput')?.focus(), 50);
}

function closeTableModal() {
  const overlay = document.getElementById('tableModalOverlay');
  if (overlay) overlay.remove();
  document.body.style.overflow = '';
  _modalKey = null;
}

function onModalSearch(val) {
  _modalFilter = val.toLowerCase().trim();
  const t     = currentData[_modalKey];
  if (!t) return;
  const isSql = !!t.backendCols;
  const cols  = isSql ? MAP_HEADERS : t.headers;
  const src   = isSql ? toMappingRows(t.backendCols) : t.rows;

  const body = document.getElementById('tableModalBody');
  const existingRows = body?.querySelectorAll?.('.modal-preview-table tbody tr');
  if (existingRows && existingRows.length > 0 && !_modalSort.col) {
    let visCount = 0;
    existingRows.forEach((tr, idx) => {
      if (!src[idx]) return;
      const r = src[idx];
      const match = !_modalFilter || cols.some(h => String(r[h] ?? '').toLowerCase().includes(_modalFilter));
      tr.style.display = match ? '' : 'none';
      if (match) visCount++;
    });
    const countEl = document.getElementById('modalVisibleCount');
    if (countEl) countEl.textContent = visCount.toLocaleString();
    if (_modalFilter) renderModalTable(cols, src, isSql);
    return;
  }

  renderModalTable(cols, src, isSql);
}

function onModalSort(colIdx) {
  const t     = currentData[_modalKey];
  if (!t) return;
  const isSql = !!t.backendCols;
  const cols  = isSql ? MAP_HEADERS : t.headers;
  const src   = isSql ? toMappingRows(t.backendCols) : t.rows;

  const col = cols[colIdx];
  if (_modalSort.col === col) {
    _modalSort.dir = _modalSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    _modalSort.col = col;
    _modalSort.dir = 'asc';
  }
  renderModalTable(cols, src, isSql);
}

function renderModalTable(cols, src, isSql) {
  let rows = src;
  if (_modalFilter) {
    rows = src.filter(r =>
      cols.some(h => String(r[h] ?? '').toLowerCase().includes(_modalFilter))
    );
  }

  if (_modalSort.col) {
    const sc = _modalSort.col;
    const dir = _modalSort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = String(a[sc] ?? ''), bv = String(b[sc] ?? '');
      const an = parseFloat(av), bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
      return av.localeCompare(bv) * dir;
    });
  }

  const countEl = document.getElementById('modalVisibleCount');
  if (countEl) countEl.textContent = rows.length.toLocaleString();

  const hl = _modalFilter;

  function hlCell(val) {
    const s = String(val ?? '');
    if (!hl) return escapeHtml(s);
    const idx = s.toLowerCase().indexOf(hl);
    if (idx === -1) return escapeHtml(s);
    return (
      escapeHtml(s.slice(0, idx)) +
      '<mark>' + escapeHtml(s.slice(idx, idx + hl.length)) + '</mark>' +
      escapeHtml(s.slice(idx + hl.length))
    );
  }

  const isPkIdx  = cols.indexOf('is_pk');
  const fkRefIdx = cols.indexOf('fk_ref');

  const theadHtml = cols.map((h, i) => {
    const isSorted = _modalSort.col === h;
    const sortCls  = isSorted ? (_modalSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '';
    const icon     = isSorted ? (_modalSort.dir === 'asc' ? '▲' : '▼') : '⇅';
    const numCls   = (i === 0 && isSql) ? 'modal-th-num' : '';
    return `<th class="${sortCls} ${numCls}" onclick="onModalSort(${i})" title="${escapeHtmlAttr(h)}">
      ${escapeHtml(h)}<span class="sort-icon">${icon}</span>
    </th>`;
  }).join('');

  let tbodyHtml;
  if (!rows.length) {
    tbodyHtml = `<tr><td colspan="${cols.length}" class="modal-no-results">
      <span>🔍</span>ไม่พบข้อมูลที่ตรงกับ "${escapeHtml(_modalFilter)}"
    </td></tr>`;
  } else {
    tbodyHtml = rows.map((r) => {
      const tds = cols.map((h, ci) => {
        const baseCls = (ci === 0 && isSql) ? 'modal-td-num' : '';
        const rawVal  = r[h] ?? '';

        if (ci === isPkIdx && isSql) {
          const isPk = rawVal === 'PK' || rawVal === true || rawVal === 'true' || rawVal === 1;
          const content = isPk
            ? `<span class="cell-pk-icon"><span class="pk-key">🔑</span> PK</span>`
            : `<span style="color:var(--text3);font-size:0.85em">—</span>`;
          return `<td class="${baseCls}" title="PK">${content}</td>`;
        }

        if (ci === fkRefIdx && isSql) {
          const val = String(rawVal);
          const content = val
            ? `<span class="cell-fk-icon">
                <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                ${hlCell(val)}
              </span>`
            : `<span style="color:var(--text3);font-size:0.85em">—</span>`;
          return `<td class="${baseCls}" title="${escapeHtmlAttr(val)}">${content}</td>`;
        }

        if (h === 'final_type' && isSql) {
          const curVal = String(rawVal);
          return `<td class="${baseCls}" title="${escapeHtmlAttr(curVal)}">${hlCell(curVal)}</td>`;
        }

        if (h === 'nullable' && isSql) {
          const curVal = String(rawVal || 'NULL');
          return `<td class="${baseCls}" title="${escapeHtmlAttr(curVal)}">${hlCell(curVal)}</td>`;
        }

        return `<td class="${baseCls}" title="${escapeHtmlAttr(String(rawVal))}">${hlCell(rawVal)}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
  }

  const body = document.getElementById('tableModalBody');
  if (!body) return;
  body.innerHTML = `
    <table class="modal-preview-table">
      <thead><tr>${theadHtml}</tr></thead>
      <tbody>${tbodyHtml}</tbody>
    </table>`;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _modalKey) closeTableModal();
});

// ═══════════════════════════════════════════════════════════
//  DUPLICATE DETECTION
// ═══════════════════════════════════════════════════════════
function _fnv32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function _readAsText(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result || '');
    r.onerror = () => resolve('');
    r.readAsText(file, 'utf-8');
  });
}

async function detectDuplicates(files) {
  const issues   = [];
  const nameSet  = new Map();
  const hashSet  = new Map();
  const tableSet = new Map();

  for (const file of files) {
    const nameLower = file.name.toLowerCase();

    if (nameSet.has(nameLower)) {
      issues.push({
        type  : 'filename',
        label : '📄 ชื่อไฟล์ซ้ำ',
        detail: `"${file.name}" ซ้ำกับไฟล์ที่อัปโหลด`,
        files : [nameSet.get(nameLower), file.name],
      });
    } else {
      nameSet.set(nameLower, file.name);
    }

    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'sql' || ext === 'csv') {
      const text = await _readAsText(file);
      const hash = _fnv32(text.replace(/\s+/g, ' ').trim());
      if (hashSet.has(hash)) {
        issues.push({
          type  : 'content',
          label : '🔁 เนื้อหาเหมือนกัน',
          detail: `"${file.name}" มีเนื้อหาเหมือนกับ "${hashSet.get(hash)}" ทุกประการ`,
          files : [hashSet.get(hash), file.name],
        });
      } else {
        hashSet.set(hash, file.name);
      }

      if (ext === 'sql') {
        const tableMatches = [...text.matchAll(
          /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_."`\[\]]+)\s*\(/gi
        )];
        for (const m of tableMatches) {
          const tname = m[1].replace(/["`\[\]]/g, '').split('.').pop().toLowerCase();
          if (tableSet.has(tname)) {
            issues.push({
              type  : 'table',
              label : '🗃️ Table ซ้ำข้ามไฟล์',
              detail: `Table "${tname}" พบทั้งใน "${tableSet.get(tname)}" และ "${file.name}"`,
              files : [tableSet.get(tname), file.name],
            });
          } else {
            tableSet.set(tname, file.name);
          }
        }
      }
    }
  }

  return issues;
}

function showDuplicateModal(issues, files) {
  return new Promise(resolve => {
    document.getElementById('dupModalOverlay')?.remove();

    const rows = issues.map(iss => `
      <tr>
        <td><span class="dup-type-badge">${iss.label}</span></td>
        <td class="dup-detail">${iss.detail}</td>
      </tr>`).join('');

    const overlay = document.createElement('div');
    overlay.id        = 'dupModalOverlay';
    overlay.className = 'dup-modal-overlay';
    overlay.innerHTML = `
      <div class="dup-modal">
        <div class="dup-modal-icon">⚠️</div>
        <div class="dup-modal-title">พบข้อมูลที่อาจซ้ำกัน — กรุณา Verify ก่อนดำเนินการ</div>
        <div class="dup-modal-sub">
          ตรวจพบ <strong>${issues.length}</strong> รายการที่ต้องระวัง
          จากไฟล์ที่อัปโหลดทั้งหมด <strong>${files.length}</strong> ไฟล์
        </div>
        <table class="dup-table">
          <thead><tr><th>ประเภท</th><th>รายละเอียด</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="dup-modal-hint">
          หากแน่ใจว่าต้องการดำเนินการต่อ คลิก <b>ดำเนินการต่อ</b>
          หรือ <b>ยกเลิก</b> เพื่อเลือกไฟล์ใหม่
        </div>
        <div class="dup-modal-actions">
          <button class="dup-btn-cancel"   id="dupBtnCancel">✕ ยกเลิก</button>
          <button class="dup-btn-proceed"  id="dupBtnProceed">✓ ดำเนินการต่อ</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    document.getElementById('dupBtnProceed').onclick = () => { overlay.remove(); resolve('proceed'); };
    document.getElementById('dupBtnCancel').onclick  = () => { overlay.remove(); resolve('cancel'); };
  });
}

// ═══════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════
function renderFileChip(name, type) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.innerHTML = `
    <span class="file-type-badge ${type}">${type.toUpperCase()}</span>
    <span class="file-name" title="${name}">${name}</span>
    <button class="file-remove" onclick="this.parentElement.remove()">✕</button>`;
  document.getElementById('fileList').appendChild(div);
}

function clearUI() {
  document.getElementById('tablesGrid').innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">🗄️</div>
      <div class="empty-state-text">อัปโหลดไฟล์ CSV, Excel หรือ SQL เพื่อเริ่มต้น</div>
    </div>`;
  document.getElementById('bulkSection').classList.remove('visible');
  const _tb = document.getElementById('typeTableBody');
  if (_tb) _tb.innerHTML = '<tr><td colspan="3"><div class="empty-hint">No file loaded</div></td></tr>';
  const card = document.getElementById('sessionCard');
  if (card) card.style.display = 'none';
  document.getElementById('unknownWarnings')?.remove();
  document.getElementById('byteAnomalyWarnings')?.remove();
  document.getElementById('fkErrorPanel')?.remove();
  document.getElementById('contentDupWarnings')?.remove();
  updateStats(0,0,0);
  updateBadges(0,0,'ready');
}

function updateStats(files, tables, rows) {
  document.getElementById('statFiles').textContent  = files;
  document.getElementById('statTables').textContent = tables;
  const statRows = document.getElementById('statRows');
  if (statRows) statRows.textContent = rows.toLocaleString();
}

function updateBadges(tables, rows, status) {
  const bt = document.getElementById('badgeTables');
  const br = document.getElementById('badgeRows');
  if (bt) bt.textContent = String(tables);
  if (br) br.textContent = String(rows.toLocaleString());
  const b = document.getElementById('badgeStatus');
  if (b) { b.textContent = status; b.className = 'process-badge'; }
}

function showStatus(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className   = 'status-bar '+type+' show';
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 4000);
}

function setLoading(on) {
  document.getElementById('loadingBar').classList.toggle('active', on);
}

async function checkHealth() {
  try {
    const res = await fetchWithApiFallback('/health');
    const payload = await res.json();
    setBackendStatus(res.ok && String(payload.status || '').toLowerCase() === 'ok');
  } catch { setBackendStatus(false); }
}

function setBackendStatus(ok) {
  const dot = document.getElementById('backendDot');
  const lbl = document.getElementById('backendLabel');
  if (!dot||!lbl) return;
  dot.className   = 'status-dot '+(ok?'online':'offline');
  lbl.textContent = ok ? 'API Online' : 'API Offline';
}

/* ────────────────────────────────────────────────────────────
   Username onboarding, avatar generator, multi-tab sync,
   profile chip editor, and session-expired overlay logic
   ─────────────────────────────────────────────────────────── */

function initialsFromName(name) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0,1).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}

function gradientFromName(name) {
  const palette = [ ['#7c3aed','#06b6d4'], ['#06b6d4','#60a5fa'], ['#34d399','#60a5fa'], ['#f472b6','#f97316'], ['#60a5fa','#7c3aed'] ];
  let sum = 0; for (let i=0;i<name.length;i++) sum = (sum*31 + name.charCodeAt(i))|0;
  const idx = Math.abs(sum) % palette.length; const p = palette[idx];
  return `linear-gradient(135deg, ${p[0]}, ${p[1]})`;
}

function renderProfile(name) {
  const elName = document.getElementById('profileName');
  const elAvatar = document.getElementById('profileAvatar');
  if (elName) elName.textContent = name || 'Guest';
  if (elAvatar) {
    const initials = initialsFromName(name || '');
    elAvatar.textContent = initials;
    elAvatar.style.background = gradientFromName(name || '');
  }
}

function validateUsername(name) {
  if (!name) return { ok:false, msg:'Required' };
  const trimmed = name.trim();
  if (!trimmed) return { ok:false, msg:'Cannot be only spaces' };
  if (trimmed.length < 2) return { ok:false, msg:'Minimum 2 characters' };
  if (trimmed.length > 30) return { ok:false, msg:'Maximum 30 characters' };
  return { ok:true, value: trimmed };
}

function showUsernameModal() {
  const modal = document.getElementById('usernameModal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden','false');
  const input = document.getElementById('usernameInput');
  const save = document.getElementById('saveUsernameBtn');
  const avatar = document.getElementById('modalAvatar');
  const feedback = document.getElementById('usernameFeedback');
  if (input) { input.value = ''; input.focus(); }
  if (save) save.disabled = true;

  function onInput() {
    const v = input.value || '';
    const g = gradientFromName(v);
    avatar.textContent = initialsFromName(v);
    avatar.style.background = g;
    const ok = validateUsername(v);
    if (!ok.ok) { feedback.textContent = ok.msg; save.disabled = true; }
    else { feedback.textContent = ''; save.disabled = false; }
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!save.disabled) saveUsername();
    }
    if (e.key === 'Escape') { e.preventDefault(); }
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  save.addEventListener('click', saveUsername);
}

function saveUsername() {
  const input = document.getElementById('usernameInput');
  if (!input) return;
  const v = input.value || '';
  const ok = validateUsername(v);
  if (!ok.ok) return;
  localStorage.setItem('username', ok.value);
  renderProfile(ok.value);
  // close modal
  const modal = document.getElementById('usernameModal'); if (modal) { modal.style.display = 'none'; modal.setAttribute('aria-hidden','true'); }
}

function handleLocalUsernameChange(name) {
  renderProfile(name);
}

window.addEventListener('storage', (e) => {
  if (e.key === 'username') {
    handleLocalUsernameChange(e.newValue || 'Guest');
  }
});

// Inline profile edit
function enableProfileEdit() {
  const chip = document.getElementById('profileChip');
  const btn  = document.getElementById('profileEditBtn');
  if (!chip || !btn) return;
  btn.addEventListener('click', () => {
    const nameEl = document.getElementById('profileName');
    const current = nameEl.textContent || '';
    const input = document.createElement('input'); input.type = 'text'; input.value = current; input.className = 'profile-inline-input'; input.style.padding='6px 8px'; input.style.borderRadius='8px'; input.style.border='1px solid rgba(255,255,255,0.06)';
    const save = document.createElement('button'); save.textContent='Save'; save.className='btn'; save.style.marginLeft='8px';
    const cancel = document.createElement('button'); cancel.textContent='Cancel'; cancel.className='btn'; cancel.style.marginLeft='6px';
    nameEl.replaceWith(input);
    btn.style.display = 'none';
    chip.appendChild(save); chip.appendChild(cancel);

    function cleanup() {
      const span = document.createElement('div'); span.id = 'profileName'; span.className='username'; span.textContent = input.value || 'Guest';
      input.replaceWith(span); save.remove(); cancel.remove(); btn.style.display='inline-block'; renderProfile(span.textContent);
    }

    save.addEventListener('click', () => {
      const ok = validateUsername(input.value);
      if (!ok.ok) { input.focus(); return; }
      localStorage.setItem('username', ok.value);
      cleanup();
    });
    cancel.addEventListener('click', () => { cleanup(); });
    input.addEventListener('keydown', (e) => { if (e.key==='Enter') save.click(); if (e.key==='Escape') cancel.click(); });
    input.focus();
  });
}

// Session expired overlay
function showSessionExpiredOverlay() {
  const o = document.getElementById('sessionExpiredModal');
  if (!o) return; o.style.display = 'flex';
  const btn = document.getElementById('reuploadBtn');
  btn.onclick = () => {
    // reset workspace state
    currentData = {}; uploadedFiles = []; sessionId = null; converted = false;
    document.getElementById('fileList').innerHTML = '';
    clearUI();
    o.style.display = 'none';
    // reopen onboarding
    showUsernameModal();
  };
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('username');
  if (!saved) {
    // lock interactions by showing modal
    showUsernameModal();
  } else {
    handleLocalUsernameChange(saved);
  }
  enableProfileEdit();
  // wire profile chip click to open onboarding modal for quick rename
  document.getElementById('profileChip')?.addEventListener('click', (e) => { if ((e.target||{}).id !== 'profileEditBtn') showUsernameModal(); });
});


function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.getElementById('btnDark').classList.toggle('active',  theme === 'dark');
  document.getElementById('btnLight').classList.toggle('active', theme === 'light');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function setSelectOptions(selectEl, placeholder, values) {
  if (!selectEl) return;
  const current = selectEl.value;
  selectEl.innerHTML = `<option value="">${placeholder}</option>` +
    values.map(v => `<option value="${v}">${v}</option>`).join('');
  selectEl.value = values.includes(current) ? current : '';
}

function filterDestOptionsForSource(sourceDb) {
  const allDbs = Array.isArray(window._allDbs) ? window._allDbs : [];
  const dstSel = document.getElementById('destDbSelect');
  if (!allDbs.length || !dstSel) return;
  setSelectOptions(dstSel, '-- Select Destination --', allDbs);
  onDestDbChange();
}

async function loadDbPairs() {
  try {
    const res = await fetchWithApiFallback('/db-pairs');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.pairs || !data.pairs.length) return;

    window._dbPairs = data.pairs;
    const sources = [...new Set(data.pairs.map(p => p.source_db).filter(Boolean))];
    window._allDbs = [...new Set(data.pairs.flatMap(p => [p.source_db, p.dest_db]).filter(Boolean))];

    const srcSel = document.getElementById('sourceDbSelect');
    setSelectOptions(srcSel, '-- Select Source --', sources);
    filterDestOptionsForSource(srcSel.value);
    onSourceDbChange();
  } catch {}
}

// ═══════════════════════════════════════════════════════════
//  PROCESSING LOGS CONSOLE
// ═══════════════════════════════════════════════════════════
const LOG_REFRESH_MS = 1500;
const LOG_DOM_LIMIT = 2000;
let _logPollTimer = null;
let _logEntries = [];
let _logKeys = new Set();

function initProcessingLogs() {
  bindLogControls();
  fetchProcessingLogs();
  if (_logPollTimer) clearInterval(_logPollTimer);
  _logPollTimer = setInterval(fetchProcessingLogs, LOG_REFRESH_MS);
}

function bindLogControls() {
  document.getElementById('logsSearchInput')?.addEventListener('input', applyLogFilters);
  document.getElementById('logsLevelFilter')?.addEventListener('change', applyLogFilters);
}

function normalizeLogLevel(log) {
  const rawLevel = String(log.level || 'INFO').toUpperCase();
  const message = String(log.message || '');
  if (rawLevel === 'WARN') return 'WARNING';
  if (rawLevel === 'SUCCESS') return 'SUCCESS';
  if (/success|succeeded|complete|completed|initialized|created/i.test(message)) return 'SUCCESS';
  if (rawLevel === 'ERROR' || rawLevel === 'CRITICAL' || rawLevel === 'FATAL') return 'ERROR';
  if (rawLevel === 'WARNING') return 'WARNING';
  return 'INFO';
}

function normalizeLog(log) {
  const timestamp = String(log.timestamp || '').trim() || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const message = String(log.message || '').trim();
  const level = normalizeLogLevel(log);
  return { timestamp, level, message };
}

function getLogKey(log) {
  return `${log.timestamp}|${log.level}|${log.message}`;
}

async function fetchProcessingLogs() {
  const consoleEl = document.getElementById('logsConsole');
  if (!consoleEl) return;

  try {
    const res = await fetchWithApiFallback('/logs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    if (!Array.isArray(payload)) throw new Error('Invalid logs payload');

    const freshLogs = [];
    payload.map(normalizeLog).forEach(log => {
      const key = getLogKey(log);
      if (_logKeys.has(key)) return;
      _logKeys.add(key);
      _logEntries.push(log);
      freshLogs.push(log);
    });

    if (freshLogs.length) {
      appendLogLines(freshLogs);
      updateLogCounters();
      setLogStatus(inferLogStatus(freshLogs[freshLogs.length - 1], true));
    } else {
      setLogStatus(_logEntries.length ? inferLogStatus(_logEntries[_logEntries.length - 1], false) : 'CONNECTED');
    }

    toggleLogEmptyState();
  } catch (err) {
    setLogStatus('ERROR');
    if (!_logEntries.length) {
      const empty = document.getElementById('logsEmptyState');
      if (empty) empty.textContent = `Unable to connect to /logs: ${err.message}`;
    }
  }
}

function appendLogLines(logs) {
  const consoleEl = document.getElementById('logsConsole');
  if (!consoleEl) return;
  const fragment = document.createDocumentFragment();
  logs.forEach(log => fragment.appendChild(createLogLine(log)));
  consoleEl.appendChild(fragment);
  trimLogDom(consoleEl);
  applyLogFilters(false);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function createLogLine(log) {
  const line = document.createElement('div');
  line.className = `log-line ${log.level.toLowerCase()}`;
  line.dataset.level = log.level;
  line.dataset.search = `${log.timestamp} ${log.level} ${log.message}`.toLowerCase();

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = `[${log.timestamp}]`;

  const level = document.createElement('span');
  level.className = 'log-level';
  level.textContent = log.level.padEnd(7, ' ');

  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = log.message;

  line.append(time, level, message);
  return line;
}

function trimLogDom(consoleEl) {
  const lines = consoleEl.querySelectorAll('.log-line');
  const overflow = lines.length - LOG_DOM_LIMIT;
  if (overflow <= 0) return;
  for (let i = 0; i < overflow; i++) lines[i].remove();
}

function applyLogFilters(shouldScroll = true) {
  const query = (document.getElementById('logsSearchInput')?.value || '').trim().toLowerCase();
  const level = document.getElementById('logsLevelFilter')?.value || 'ALL';
  const consoleEl = document.getElementById('logsConsole');
  if (!consoleEl) return;

  consoleEl.querySelectorAll('.log-line').forEach(line => {
    const levelMatches = level === 'ALL' || line.dataset.level === level;
    const textMatches = !query || line.dataset.search.includes(query);
    line.classList.toggle('hidden', !(levelMatches && textMatches));
  });

  if (shouldScroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function updateLogCounters() {
  const counts = { INFO: 0, SUCCESS: 0, WARNING: 0, ERROR: 0 };
  _logEntries.forEach(log => { counts[log.level] = (counts[log.level] || 0) + 1; });
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value.toLocaleString(); };
  setText('logCountAll', _logEntries.length);
  setText('logCountInfo', counts.INFO || 0);
  setText('logCountSuccess', counts.SUCCESS || 0);
  setText('logCountWarning', counts.WARNING || 0);
  setText('logCountError', counts.ERROR || 0);
}

function inferLogStatus(latestLog, hasNewLogs) {
  if (!latestLog) return 'CONNECTED';
  if (latestLog.level === 'ERROR') return 'ERROR';
  if (latestLog.level === 'SUCCESS' || /complete|completed|created|initialized|success/i.test(latestLog.message)) return 'COMPLETED';
  return hasNewLogs ? 'PROCESSING' : 'CONNECTED';
}

function setLogStatus(status) {
  const badge = document.getElementById('logsStatusBadge');
  if (!badge) return;
  const normalized = ['CONNECTED', 'PROCESSING', 'ERROR', 'COMPLETED'].includes(status) ? status : 'CONNECTED';
  badge.textContent = normalized;
  badge.className = `logs-status-badge ${normalized.toLowerCase()}`;
}

function toggleLogEmptyState() {
  const empty = document.getElementById('logsEmptyState');
  if (!empty) return;
  empty.style.display = _logEntries.length ? 'none' : 'flex';
}

async function clearProcessingLogs() {
  try {
    await fetchWithApiFallback('/logs', { method: 'DELETE' });
  } catch (err) {
    setLogStatus('ERROR');
    return;
  }
  _logEntries = [];
  _logKeys = new Set();
  const consoleEl = document.getElementById('logsConsole');
  if (consoleEl) consoleEl.querySelectorAll('.log-line').forEach(line => line.remove());
  updateLogCounters();
  setLogStatus('CONNECTED');
  const empty = document.getElementById('logsEmptyState');
  if (empty) empty.textContent = 'Waiting for backend logs...';
  toggleLogEmptyState();
  await fetchProcessingLogs();
}

function downloadProcessingLogs() {
  const body = _logEntries.length
    ? _logEntries.map(formatLogLine).join('\n')
    : 'No logs captured.';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  triggerDownload(new Blob([body], { type: 'text/plain;charset=utf-8' }), `processing_logs_${stamp}.txt`);
}

function formatLogLine(log) {
  return `[${log.timestamp}] ${log.level.padEnd(7, ' ')} ${log.message}`;
}

function toggleLogsPanel() {
  document.getElementById('logsPanelCard')?.classList.toggle('collapsed');
}


// ════════════════════════════════════════════════════════════════════════════
//  MAINTENANCE MODE — polling จาก Admin Console
// ════════════════════════════════════════════════════════════════════════════

let _inMaintenance   = false;
const MAINT_POLL_ACTIVE_MS  = 8_000;   // poll ทุก 8 วิ ขณะ maintenance (< backend TTL 10 วิ)
const MAINT_POLL_NORMAL_MS  = 15_000;  // poll ทุก 15 วิ ปกติ (ลดจาก 30 เพื่อ sync เร็วขึ้น)
let _maintPollTimer  = null;

/** block/unblock ทุก interactive element */
function _setAppLocked(locked) {
  // ปุ่มหลัก
  ['convertBtn', 'fileInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
  // dropzone
  const dz = document.getElementById('dropzone');
  if (dz) {
    dz.style.pointerEvents = locked ? 'none' : '';
    dz.style.opacity       = locked ? '0.3' : '';
  }
  // select dropdowns
  ['sourceDbSelect', 'destDbSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
  // download buttons
  document.querySelectorAll('.download-btn, .export-btn, [onclick*="download"], [onclick*="export"]').forEach(el => {
    el.disabled = locked;
    el.style.pointerEvents = locked ? 'none' : '';
    el.style.opacity       = locked ? '0.3' : '';
  });
}

/** แสดง/ซ่อน overlay และ block ทุก interaction */
function _applyMaintenanceUI(active, reason = '') {
  const overlay = document.getElementById('maintenanceOverlay');
  if (!overlay) return;

  if (active === _inMaintenance && overlay.style.display === (active ? 'flex' : 'none')) return;

  _inMaintenance = active;
  overlay.style.display = active ? 'flex' : 'none';
  _setAppLocked(active);

  // reason text
  const reasonEl = document.getElementById('maintenanceReason');
  if (reasonEl) reasonEl.textContent = reason ? `💬 ${reason}` : '';

  // status dot ใน topbar
  const dot = document.getElementById('backendDot');
  const lbl = document.getElementById('backendLabel');
  if (active) {
    if (dot) dot.className = 'status-dot maintenance';
    if (lbl) lbl.textContent = '🔧 Maintenance';
  } else {
    checkHealth();
  }

  // ปรับ poll interval — ถ้า maintenance ให้ poll ถี่ขึ้นเพื่อ auto-refresh เมื่อกลับมา
  clearInterval(_maintPollTimer);
  _maintPollTimer = setInterval(checkMaintenance, active ? MAINT_POLL_ACTIVE_MS : MAINT_POLL_NORMAL_MS);
}

/** poll maintenance API แล้ว apply UI */
async function checkMaintenance() {
  try {
    const res = await fetch(`${API_BASE}/system/maintenance`);
    if (!res.ok) return;
    const payload = await res.json();
    const active  = payload?.data?.maintenance ?? false;
    const reason  = payload?.data?.reason ?? '';

    // ถ้าเพิ่งกลับมาจาก maintenance → reload หน้าเพื่อ reset state ทั้งหมด
    if (_inMaintenance && !active) {
      window.location.reload();
      return;
    }

    _applyMaintenanceUI(active, reason);
  } catch {
    // network fail → fail-open ไม่ block user
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setTheme(localStorage.getItem('theme') || 'dark');
  checkMaintenance();
  checkHealth();
  loadDbPairs();
  initProcessingLogs();
  setInterval(checkHealth, MAINT_POLL_NORMAL_MS);
  _maintPollTimer = setInterval(checkMaintenance, MAINT_POLL_NORMAL_MS);
});

// ── Download XLSX ─────────────────────────────────────────
async function downloadAllXLSX() { showTableSelectorModal('xlsx'); }

async function downloadTableXLSX(tableName) {
  const t = currentData[tableName];
  if (!t?.backendCols) {
    showStatus('convertStatus', 'error', '❌ ไม่มีข้อมูล SQL สำหรับตารางนี้');
    return;
  }

  setLoading(true);
  try {
    const res = await fetchWithApiFallback(`/export/${sessionId}/xlsx/${tableName}`);
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || res.statusText);
    const blob = await res.blob();
    triggerDownload(blob, makeExportFilename([tableName], 'xlsx'));
    showStatus('convertStatus', 'success', `✓ ดาวน์โหลด ${tableName}_confluent.xlsx สำเร็จ`);
  } catch (err) {
    showStatus('convertStatus', 'error', '❌ ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════════════════════
//  TABLE SELECTOR MODAL
// ═══════════════════════════════════════════════════════════
function showTableSelectorModal(fmt) {
  const allKeys = Object.keys(currentData).filter(k => currentData[k].backendCols);
  if (!allKeys.length) {
    showStatus('convertStatus', 'error', '❌ ไม่มีข้อมูล SQL — กรุณาอัปโหลดไฟล์ SQL ก่อน');
    return;
  }

  document.getElementById('tblSelOverlay')?.remove();

  // state
  let selected = new Set(allKeys);
  let query    = '';

  // group tables by prefix (e.g. "hr", "inv") — split at first uppercase or underscore
  function getPrefix(name) {
    const m = name.match(/^([a-z]+)/i);
    return m ? m[1].toLowerCase() : name[0].toLowerCase();
  }
  const groups = {};
  allKeys.forEach(k => {
    const p = getPrefix(k);
    (groups[p] = groups[p] || []).push(k);
  });
  const groupKeys = Object.keys(groups).sort();

  function filteredKeys() {
    const q = query.trim().toLowerCase();
    return q ? allKeys.filter(k => k.toLowerCase().includes(q)) : allKeys;
  }

  function render(overlay) {
    const body   = overlay.querySelector('.tsel-body');
    const counter = overlay.querySelector('.tsel-counter');
    const btnExp  = overlay.querySelector('.tsel-btn-export');
    const visible = filteredKeys();
    const selectedVisible = visible.filter(k => selected.has(k)).length;

    counter.innerHTML = `<span class="tsel-count-num">${selected.size}</span> / ${allKeys.length} tables selected`;
    btnExp.disabled   = selected.size === 0;

    // progress bar
    const pct = allKeys.length ? Math.round(selected.size / allKeys.length * 100) : 0;
    overlay.querySelector('.tsel-progress-fill').style.width = pct + '%';

    if (query.trim()) {
      // flat search result view
      body.innerHTML = visible.length === 0
        ? `<div class="tsel-no-result">ไม่พบ table ที่ตรงกับ "<b>${query}</b>"</div>`
        : `<div class="tsel-flat-grid">${visible.map(k => chipHTML(k)).join('')}</div>`;
    } else {
      // grouped view
      body.innerHTML = groupKeys.map(prefix => {
        const keys = groups[prefix];
        const allSel = keys.every(k => selected.has(k));
        const noneSel = keys.every(k => !selected.has(k));
        const partial = !allSel && !noneSel;
        return `<div class="tsel-group" data-prefix="${prefix}">
          <div class="tsel-group-header">
            <button class="tsel-group-toggle ${allSel ? 'all' : noneSel ? 'none' : 'partial'}" data-prefix="${prefix}" title="${allSel ? 'ยกเลิกทั้งกลุ่ม' : 'เลือกทั้งกลุ่ม'}">
              <span class="tsel-group-check">${allSel ? '✓' : partial ? '−' : ''}</span>
            </button>
            <span class="tsel-group-name">${prefix}</span>
            <span class="tsel-group-count">${keys.filter(k => selected.has(k)).length} / ${keys.length}</span>
          </div>
          <div class="tsel-group-chips">${keys.map(k => chipHTML(k)).join('')}</div>
        </div>`;
      }).join('');
    }

    // bind chip toggles
    body.querySelectorAll('.tsel-chip2').forEach(chip => {
      chip.onclick = () => {
        const k = chip.dataset.key;
        selected.has(k) ? selected.delete(k) : selected.add(k);
        render(overlay);
      };
    });

    // bind group toggles
    body.querySelectorAll('.tsel-group-toggle').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const prefix = btn.dataset.prefix;
        const keys   = groups[prefix];
        const allSel = keys.every(k => selected.has(k));
        allSel ? keys.forEach(k => selected.delete(k)) : keys.forEach(k => selected.add(k));
        render(overlay);
      };
    });
  }

  function chipHTML(k) {
    const on  = selected.has(k);
    const dup = currentData[k]?.isDuplicate;
    return `<button class="tsel-chip2${on ? ' on' : ''}${dup ? ' dup' : ''}" data-key="${k}">
      ${dup ? '<span class="tsel-dup-badge">DUP</span>' : ''}
      <span class="tsel-chip2-name">${k}</span>
      <span class="tsel-chip2-check">${on ? '✓' : ''}</span>
    </button>`;
  }

  const overlay = document.createElement('div');
  overlay.id        = 'tblSelOverlay';
  overlay.className = 'tsel-overlay';
  overlay.innerHTML = `
    <div class="tsel-modal">
      <div class="tsel-modal-header">
        <div class="tsel-modal-title">Export ${fmt.toUpperCase()}</div>
        <div class="tsel-counter"></div>
      </div>
      <div class="tsel-progress-bar"><div class="tsel-progress-fill"></div></div>
      <div class="tsel-toolbar">
        <div class="tsel-search-wrap">
          <span class="tsel-search-icon">⌕</span>
          <input class="tsel-search" placeholder="ค้นหา table..." autocomplete="off" spellcheck="false" />
        </div>
        <div class="tsel-toolbar-btns">
          <button class="tsel-btn-all" id="tselBtnAll">เลือกทั้งหมด</button>
          <button class="tsel-btn-all" id="tselBtnNone">ยกเลิกทั้งหมด</button>
        </div>
      </div>
      <div class="tsel-body"></div>
      <div class="tsel-modal-footer">
        <button class="tsel-btn-cancel">ยกเลิก</button>
        <button class="tsel-btn-export">Export ${fmt.toUpperCase()}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  render(overlay);

  // search
  overlay.querySelector('.tsel-search').oninput = (e) => {
    query = e.target.value;
    render(overlay);
  };

  overlay.querySelector('#tselBtnAll').onclick  = () => { selected = new Set(allKeys); render(overlay); };
  overlay.querySelector('#tselBtnNone').onclick = () => { selected = new Set(); render(overlay); };
  overlay.querySelector('.tsel-btn-cancel').onclick = () => overlay.remove();
  overlay.querySelector('.tsel-btn-export').onclick = () => { overlay.remove(); doExportSelected(fmt, [...selected]); };

  // close on backdrop click
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  // focus search
  setTimeout(() => overlay.querySelector('.tsel-search')?.focus(), 50);
}

async function doExportSelected(fmt, selectedKeys) {
  if (!selectedKeys.length) return;
  const qs  = selectedKeys.map(k => `tables=${encodeURIComponent(k)}`).join('&');
  setLoading(true);
  try {
    const res = await fetchWithApiFallback(`/export/${sessionId}/${fmt}?${qs}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    triggerDownload(await res.blob(), makeExportFilename(selectedKeys, fmt));
    showStatus('convertStatus', 'success', `✓ Export ${fmt.toUpperCase()} สำเร็จ (${selectedKeys.length} tables)`);
  } catch (err) {
    showStatus('convertStatus', 'error', '❌ ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════════════════════
//  buildPillsHTML
// ═══════════════════════════════════════════════════════════
function buildPillsHTML(backendCols) {
  if (!backendCols || !backendCols.length) {
    return '<span class="bcol-empty-hint">ไม่มีคอลัมน์</span>';
  }

  const importantCols = backendCols.filter(c =>
    c.is_pk || c.fk || c.isUnknown || c.isByteAnomaly || c.fkError
  );

  if (!importantCols.length) {
    return '<span class="bcol-empty-hint">No PK, FK, or errors</span>';
  }

  const MAX_PILLS = 12;
  const visible   = importantCols.slice(0, MAX_PILLS);
  const more      = importantCols.length - MAX_PILLS;

  const pillsHtml = visible.map(c => {
    const hasError = c.isUnknown || c.isByteAnomaly || c.fkError;
    const classes = [
      'bcol-pill',
      hasError        ? 'has-error'    : '',
      c.isUnknown     ? 'unknown'      : '',
      c.isByteAnomaly ? 'byte-anomaly' : '',
    ].filter(Boolean).join(' ');

    const pkTag  = c.is_pk ? '<span class="pill-tag pill-tag-PK">PK</span>' : '';
    const fkTitle = c.fk ? `FK -> ${formatFkRef(c.fk)}` : '';
    const fkTag  = c.fk
      ? `<span class="pill-tag pill-tag-FK" title="${fkTitle}">FK</span>`
      : '';
    const errTag = hasError ? '<span class="pill-tag pill-tag-ERR">ERR</span>' : '';
    const anomBadge = c.isByteAnomaly
      ? '<span class="anomaly-pill-badge">⚠</span>'
      : '';

    const typeLabel = c.final_type || c.source_sql_type || '?';

    return `<span class="${classes}" title="${c.column_name} : ${c.source_sql_type || ''} → ${typeLabel}">
      ${pkTag}${fkTag}${errTag}
      <em>${c.column_name}</em>
      <span style="color:var(--text3);margin-left:3px">${typeLabel}</span>
      ${anomBadge}
    </span>`;
  }).join('');

  const morePill = more > 0
    ? `<span class="bcol-more">+${more} more…</span>`
    : '';

  return pillsHtml + morePill;
}

function formatFkRef(fk) {
  if (!fk) return '';
  if (typeof fk === 'string') return fk;
  return `${fk.ref_table || '?'}${fk.ref_column ? '.' + fk.ref_column : ''}`;
}

function renderFKErrors(fkErrors) {
  document.getElementById('fkErrorPanel')?.remove();
  if (!fkErrors || !fkErrors.length) return;

  const items = fkErrors.map(e => {
    const isErr = (e.level || 'error') === 'error';
    const icon  = isErr ? '❌' : '⚠️';
    return `<li class="fk-err-item ${e.level}">
      <span class="fk-err-icon">${icon}</span>
      <span><b>${e.src}</b> — ${e.msg}</span>
    </li>`;
  });

  const div = document.createElement('div');
  div.id        = 'fkErrorPanel';
  div.className = 'warn-panel fk-panel';
  div.innerHTML = `
    <div class="warn-panel-header">
      🔗 FK Validation (${fkErrors.length} รายการ)
      <button onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <ul style="list-style:none;display:flex;flex-direction:column;gap:4px">
      ${items.join('')}
    </ul>`;
  document.getElementById('tablesGrid').insertAdjacentElement('beforebegin', div);
}

// [FIX] beforeunload — wrap ด้วย try-catch ป้องกัน error ใน console
// เมื่อ API_BASE เป็น localhost แต่ user เปิดจาก Vercel
window.addEventListener('beforeunload', () => {
  if (sessionId) {
    try {
      fetch(`${API_BASE}/session/${sessionId}`, { method: 'DELETE', keepalive: true });
    } catch {}
  }
});

// ═══════════════════════════════════════════════════════════
//  REFERENCES PANEL
// ═══════════════════════════════════════════════════════════
let _databaseSupportLoading = false;

async function loadDatabaseSupportDocumentation() {
  if (_databaseSupportLoading) return;
  _databaseSupportLoading = true;
  renderDatabaseSupportLoading();

  try {
    const res = await fetchWithApiFallback('/database-support', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    validateDatabaseSupportPayload(data);
    renderDatabaseSupportDocumentation(data);
  } catch (err) {
    renderDatabaseSupportError(err);
  } finally {
    _databaseSupportLoading = false;
  }
}

function validateDatabaseSupportPayload(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid database support payload');
  if (!Array.isArray(data.database_support_matrix)) throw new Error('Missing database_support_matrix');
  if (!data.references || typeof data.references !== 'object') throw new Error('Missing references');
}

function renderDatabaseSupportLoading() {
  const state = document.getElementById('refDynamicState');
  const refs = document.getElementById('refBody');
  const versions = document.getElementById('versionSupportBody');
  if (state) {
    state.className = 'ref-dynamic-state loading';
    state.innerHTML = `
      <div class="ref-loading-spinner"></div>
      <div>
        <div class="ref-state-title">Loading database support documentation...</div>
        <div class="ref-state-sub">Fetching latest compatibility matrix from FastAPI</div>
      </div>`;
    state.style.display = 'flex';
  }
  if (refs) refs.innerHTML = renderReferenceSkeletons();
  if (versions) versions.innerHTML = renderVersionSkeletons();
}

function renderDatabaseSupportError(err) {
  const state = document.getElementById('refDynamicState');
  const refs = document.getElementById('refBody');
  const versions = document.getElementById('versionSupportBody');
  if (state) {
    state.className = 'ref-dynamic-state error';
    state.innerHTML = `
      <div>
        <div class="ref-state-title">Unable to load database support data</div>
        <div class="ref-state-sub">${escapeHtml(err.message || 'Unknown error')}</div>
      </div>
      <button class="ref-retry-btn" type="button" onclick="loadDatabaseSupportDocumentation()">Retry</button>`;
    state.style.display = 'flex';
  }
  if (refs) refs.innerHTML = '';
  if (versions) versions.innerHTML = '';
  updateReferenceHeader(null);
}

function renderDatabaseSupportDocumentation(data) {
  const state = document.getElementById('refDynamicState');
  const refs = document.getElementById('refBody');
  const versions = document.getElementById('versionSupportBody');
  if (state) state.style.display = 'none';
  updateReferenceHeader(data);
  if (refs) refs.innerHTML = renderReferenceSections(data.references);
  if (versions) versions.innerHTML = renderVersionSupport(data);
}

function updateReferenceHeader(data) {
  const project = data?.project || {};
  const count = data ? countReferences(data.references) : 0;
  const title = document.getElementById('refHeaderTitle');
  const sub = document.getElementById('refHeaderSub');
  const badge = document.getElementById('refFabBadge');
  if (title) title.textContent = project.document || 'Database Compatibility Documentation';
  if (sub) sub.textContent = data ? `${count} refs · ${project.generated_date || 'live config'}` : 'Unavailable';
  if (badge) badge.textContent = count;
}

function countReferences(references) {
  return Object.values(references || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
}

function renderReferenceSections(references) {
  const groups = Object.entries(references || {}).filter(([, items]) => Array.isArray(items) && items.length);
  if (!groups.length) return '<div class="ref-empty-block">No reference links available.</div>';

  let start = 1;
  return groups.map(([key, items], index) => {
    const html = renderReferenceSection(key, items, index + 1, start);
    start += items.length;
    return html;
  }).join('');
}

function renderReferenceSection(key, items, sectionNum, start) {
  return `
    <div class="ref-section dynamic-section">
      <div class="ref-section-label">
        <span class="ref-section-num">${sectionNum}</span>
        <span class="ref-section-title">${formatReferenceGroupTitle(key)}</span>
      </div>
      <ol class="ref-list" start="${start}">
        ${items.map(renderReferenceItem).join('')}
      </ol>
    </div>`;
}

function renderReferenceItem(item) {
  const owner = item.vendor || item.organization || 'Documentation';
  const category = item.category || 'reference';
  const host = getUrlHost(item.url);
  return `
    <li class="ref-item">
      <div class="ref-item-num"></div>
      <div class="ref-item-body">
        <div class="ref-item-top">
          <span class="ref-tag ${getRefTagClass(category)}">${escapeHtml(formatCategoryLabel(category))}</span>
          <span class="ref-author">${escapeHtml(owner)}.</span>
        </div>
        <div class="ref-title">${escapeHtml(item.title || 'Untitled reference')}</div>
        <div class="ref-item-bottom">
          <a class="ref-link" href="${escapeHtmlAttr(item.url || '#')}" target="_blank" rel="noopener">
            <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            ${escapeHtml(host)}
          </a>
        </div>
      </div>
    </li>`;
}

function renderVersionSupport(data) {
  const matrix = Array.isArray(data.database_support_matrix) ? data.database_support_matrix : [];
  if (!matrix.length) return '<div class="ref-empty-block">No database support matrix available.</div>';

  return `
    <div class="ver-intro dynamic-intro">
      ${escapeHtml(data.project?.name || 'BA Tool')} · Compatibility data loaded from backend configuration.
    </div>
    <div class="support-table-wrap">
      <table class="support-table">
        <thead>
          <tr>
            <th>Database</th>
            <th>Minimum</th>
            <th>Recommended</th>
            <th>Technical Notes</th>
          </tr>
        </thead>
        <tbody>
          ${matrix.map(renderSupportTableRow).join('')}
        </tbody>
      </table>
    </div>
    <div class="ver-grid dynamic-grid">
      ${matrix.map(renderVersionCard).join('')}
    </div>`;
}

function renderSupportTableRow(item) {
  const versions = item.supported_versions || {};
  const notes = Array.isArray(item.technical_notes) ? item.technical_notes : [];
  return `
    <tr>
      <td><span class="ref-tag ${getRefTagClass(item.database)}">${escapeHtml(item.database || 'Unknown')}</span></td>
      <td>${escapeHtml(versions.minimum || '-')}</td>
      <td>${escapeHtml(versions.recommended || '-')}</td>
      <td>${notes.map(note => `<span class="support-note-chip">${escapeHtml(note)}</span>`).join('')}</td>
    </tr>`;
}

function renderVersionCard(item) {
  const versions = item.supported_versions || {};
  const notes = Array.isArray(item.technical_notes) ? item.technical_notes : [];
  return `
    <div class="ver-card dynamic-card">
      <div class="ver-card-head">
        <span class="ref-tag ${getRefTagClass(item.database)}">${escapeHtml(item.database || 'Database')}</span>
        <span class="ver-range">${escapeHtml(versions.minimum || '-')} - ${escapeHtml(versions.recommended || '-')}</span>
      </div>
      <div class="ver-features">
        ${notes.map(note => `<span class="ver-feature">${escapeHtml(note)}</span>`).join('')}
      </div>
    </div>`;
}

function renderReferenceSkeletons() {
  return Array.from({ length: 3 }).map((_, sectionIndex) => `
    <div class="ref-section dynamic-section skeleton-section">
      <div class="ref-skeleton title"></div>
      ${Array.from({ length: sectionIndex === 2 ? 1 : 3 }).map(() => `
        <div class="ref-skeleton-card">
          <div class="ref-skeleton small"></div>
          <div class="ref-skeleton line"></div>
          <div class="ref-skeleton short"></div>
        </div>`).join('')}
    </div>`).join('');
}

function renderVersionSkeletons() {
  return `
    <div class="ref-skeleton line wide"></div>
    <div class="ver-grid dynamic-grid">
      ${Array.from({ length: 4 }).map(() => `
        <div class="ver-card dynamic-card">
          <div class="ref-skeleton title"></div>
          <div class="ref-skeleton line"></div>
          <div class="ref-skeleton short"></div>
        </div>`).join('')}
    </div>`;
}

function formatReferenceGroupTitle(key) {
  return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function formatCategoryLabel(category) {
  return String(category || 'reference')
    .replace(/_/g, ' ')
    .replace(/sqlserver/i, 'SQL Server')
    .replace(/postgresql/i, 'PostgreSQL')
    .replace(/mysql/i, 'MySQL')
    .replace(/oracle/i, 'Oracle')
    .replace(/ansi sql/i, 'ANSI')
    .replace(/avro logical types/i, 'Avro');
}

function getRefTagClass(value) {
  const key = String(value || '').toLowerCase();
  if (key.includes('postgres')) return 'ref-tag-pg';
  if (key.includes('mysql')) return 'ref-tag-mysql';
  if (key.includes('sqlserver') || key.includes('sql server') || key.includes('mssql')) return 'ref-tag-mssql';
  if (key.includes('oracle')) return 'ref-tag-oracle';
  if (key.includes('ansi')) return 'ref-tag-ansi';
  if (key.includes('avro')) return 'ref-tag-avro';
  return 'ref-tag-ansi';
}

function getUrlHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'external link'; }
}

function toggleReferences() {
  const panel = document.getElementById('refPanel');
  const fab   = document.getElementById('refFab');
  const isOpen = panel.classList.toggle('open');
  if (fab) fab.classList.toggle('open', isOpen);
  if (isOpen) loadDatabaseSupportDocumentation();
}

function switchRefTab(tab) {
  const tabs  = { refs: 'tabRefs',    version: 'tabVersion'  };
  const panes = { refs: 'paneRefs',   version: 'paneVersion' };
  Object.keys(tabs).forEach(t => {
    document.getElementById(tabs[t]) ?.classList.toggle('active', t === tab);
    document.getElementById(panes[t])?.classList.toggle('active', t === tab);
  });
}