// ─── State ───────────────────────────────────────────────
let SESSION_ID   = mkUUID();
let EXEC_N       = 0;
let CELL_N       = 0;
let CHAT_N       = 0;
let CHAT_TABLE_N = 0;
let currentAbortController = null;
const CELL_ABORTS = new Map();
const CELLS      = new Map();
let currentMode  = 'chat';

// Makino Cloud 테이블 카탈로그 (CLAUDE.md 기반)
const MAKINO_CATALOG = [
  { domain: '고객/거래처', tables: [
    { name: 'new_q1',  label: '거래처' },
    { name: 'contact', label: '연락처' },
  ]},
  { domain: '영업', tables: [
    { name: 'new_q4',         label: '영업문의' },
    { name: 'new_q3',         label: '영업기회' },
    { name: 'new_ordersales', label: '수주 (Order Sales)' },
  ]},
  { domain: '서비스', tables: [
    { name: 'new_call',  label: '서비스접수' },
    { name: 'new_web',   label: 'Web접수' },
    { name: 'new_q112',  label: '서비스케이스 (A/S)' },
    { name: 'appointment', label: '방문일정 (약속)' },
    { name: 'new_part',  label: '부품사용내역' },
  ]},
  { domain: '장비/설비', tables: [
    { name: 'new_serial',       label: 'Serial 관리' },
    { name: 'new_seriallist',   label: 'Serial 설치정보' },
    { name: 'new_safeinspection', label: '안전점검' },
  ]},
  { domain: '구매', tables: [
    { name: 'new_po', label: 'P.O 관리' },
  ]},
];

// 전체 테이블 평면 목록
const MAKINO_ALL_TABLES = MAKINO_CATALOG.flatMap(g => g.tables.map(t => ({ ...t, domain: g.domain })));

function mkUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ─── Mode ────────────────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  document.getElementById('chat-view').classList.toggle('hidden', mode !== 'chat');
  document.getElementById('notebook-view').classList.toggle('hidden', mode !== 'notebook');
  document.getElementById('nb-controls').style.display = mode === 'notebook' ? 'flex' : 'none';
  document.getElementById('tab-chat').classList.toggle('active', mode === 'chat');
  document.getElementById('tab-nb').classList.toggle('active', mode === 'notebook');
}

// ─── Helpers ─────────────────────────────────────────────
function renderMd(text) {
  if (typeof DOMPurify !== 'undefined' && typeof marked !== 'undefined')
    return DOMPurify.sanitize(marked.parse(text));
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function buildMessage(question) { return question; }

function renderTable(rows) {
  if (!rows || rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const tblId = `ctbl-${++CHAT_TABLE_N}`;
  const header = keys.map(k => `<th>${esc(k)}</th>`).join('');
  const body = rows.map(row =>
    `<tr>${keys.map(k => `<td>${esc(String(row[k] ?? ''))}</td>`).join('')}</tr>`
  ).join('');
  return `<div class="tbl-wrap" id="${tblId}"><table class="tbl"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>
          <div class="tbl-count">${rows.length.toLocaleString()}건</div>`;
}

async function streamChat(message, onText, onTool, onTable, onDone, onError, signal) {
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: SESSION_ID }),
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if      (ev.type === 'text')  onText?.(ev.text);
        else if (ev.type === 'tool')  onTool?.(ev.name);
        else if (ev.type === 'table') onTable?.(ev.rows);
        else if (ev.type === 'done')  onDone?.();
        else if (ev.type === 'error') onError?.(ev.message);
      }
    }
  } finally {
    reader.cancel();
  }
}

// ─── Session ─────────────────────────────────────────────
function newSession() {
  SESSION_ID = mkUUID();
  const area = document.getElementById('chat-area');
  area.innerHTML = '';
  const w = document.createElement('div');
  w.id = 'chat-welcome'; w.className = 'chat-welcome';
  w.innerHTML = `<h2>무엇이든 물어보세요</h2>
    <p>Makino CRM 데이터에 대해 자연어로 질문하세요</p>
    <div class="chat-welcome-chips">
      <span class="chip" onclick="quickChat('담당자별 활성 서비스케이스 개수 알려줘')">담당자별 활성 서비스케이스 개수</span>
      <span class="chip" onclick="quickChat('이번달 매출 합계는?')">이번달 매출</span>
      <span class="chip" onclick="quickChat('최근 주문 10건 보여줘')">최근 주문 10건</span>
    </div>`;
  area.appendChild(w);
  CHAT_N = 0; CHAT_TABLE_N = 0;
  CELLS.clear(); EXEC_N = 0; CELL_N = 0;
  document.getElementById('cells').innerHTML = '';
  document.getElementById('welcome-msg').style.display = '';
  if (currentMode === 'notebook') addCell('ai');
  toast('새 세션이 시작되었습니다.');
}

// ─── Sidebar ─────────────────────────────────────────────
let _sbCollapsed = false;
function toggleSidebar() {
  _sbCollapsed = !_sbCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', _sbCollapsed);
}

// ─── Catalog Tree (Makino Cloud) ──────────────────────────
function loadCatalog() {
  renderCatalogTree();
}

function renderCatalogTree() {
  const tree = document.getElementById('catalog-tree');
  tree.innerHTML = `
    <div class="cat-conn">
      <div class="cat-conn-row" style="cursor:default">
        <span class="cat-conn-icon">☁️</span>
        <span class="cat-conn-name">Makino Cloud</span>
        <span class="cat-conn-status connected" title="connected"></span>
      </div>
    </div>` +
  MAKINO_CATALOG.map(g => `
    <div class="cat-conn" id="cat-group-${esc(g.domain)}">
      <div class="cat-conn-row" onclick="toggleGroup('${esc(g.domain)}')">
        <span class="cat-conn-chev" id="cat-chev-${esc(g.domain)}">▶</span>
        <span class="cat-conn-name">${esc(g.domain)}</span>
      </div>
      <div class="cat-tables" id="cat-tables-${esc(g.domain)}">
        ${g.tables.map(t => `
          <div class="cat-table-row">
            <span class="cat-table-name" title="${esc(t.name)}">${esc(t.label)}</span>
            <span class="cat-table-cnt" style="font-size:9px;color:#94a3b8">${esc(t.name)}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function toggleGroup(domain) {
  const tablesEl = document.getElementById(`cat-tables-${domain}`);
  const chevEl   = document.getElementById(`cat-chev-${domain}`);
  const isOpen   = tablesEl.classList.contains('open');
  tablesEl.classList.toggle('open', !isOpen);
  chevEl.classList.toggle('open', !isOpen);
}


// ─── Chat ─────────────────────────────────────────────────
async function sendChat() {
  const ta = document.getElementById('chat-ta');
  const q = ta.value.trim();
  if (!q) return;
  ta.value = ''; autoResizeTA(ta);
  document.getElementById('chat-welcome') && (document.getElementById('chat-welcome').style.display = 'none');
  appendChatMsg('user', q);
  const typingId = appendTyping();
  const sendBtn = document.getElementById('chat-send-btn');
  currentAbortController = new AbortController();
  sendBtn.textContent = '취소';
  sendBtn.onclick = () => currentAbortController?.abort();
  sendBtn.classList.remove('primary');
  let mid = null;
  try {
    await streamChat(
      buildMessage(q),
      (text) => {  // onText
        if (mid === null) { removeTyping(typingId); mid = beginStreamBubble(); }
        appendStreamToken(mid, text);
      },
      (name) => {  // onTool
        if (mid === null) { removeTyping(typingId); mid = beginStreamBubble(); }
        const b = document.getElementById(`cbubble-${mid}`);
        if (b) { b.dataset.status = '1'; b.dataset.acc = b.dataset.acc || ''; b.innerHTML = `<span style="color:#475569">🔍 ${esc(name)} 조회 중...</span>`; }
      },
      (rows) => {  // onTable
        try {
          if (mid === null) { removeTyping(typingId); mid = beginStreamBubble(); }
          const extras = document.getElementById(`cextras-${mid}`);
          if (extras) extras.insertAdjacentHTML('beforeend', renderTable(rows));
          document.getElementById('chat-area').scrollTop = 9999;
        } catch(e) { console.error('table render error:', e, rows); }
      },
      () => {      // onDone
        if (mid === null) { removeTyping(typingId); mid = beginStreamBubble(); }
        finalizeStreamBubble(mid);
      },
      (msg) => {   // onError
        removeTyping(typingId);
        appendChatMsg('ai', `오류: ${msg}`, true);
      },
      currentAbortController.signal,
    );
  } catch(err) {
    removeTyping(typingId);
    if (err.name === 'AbortError') {
      if (mid !== null) finalizeStreamBubble(mid);
    } else {
      appendChatMsg('ai', `오류: ${err?.message || String(err)}`, true);
    }
  } finally {
    currentAbortController = null;
    sendBtn.textContent = '전송';
    sendBtn.onclick = sendChat;
    sendBtn.classList.add('primary');
  }
}

function beginStreamBubble() {
  const mid = ++CHAT_N;
  const area = document.getElementById('chat-area');
  const div = document.createElement('div');
  div.className = 'chat-msg ai'; div.id = `cmsg-${mid}`;
  div.innerHTML = `<div class="chat-avatar ai">AI</div>
    <div class="chat-content">
      <div class="chat-bubble ai" id="cbubble-${mid}"></div>
      <div class="chat-extras" id="cextras-${mid}"></div>
    </div>`;
  area.appendChild(div); area.scrollTop = area.scrollHeight;
  return mid;
}

function appendStreamToken(mid, text) {
  const bubble = document.getElementById(`cbubble-${mid}`);
  if (!bubble) return;
  if (bubble.dataset.status) { delete bubble.dataset.status; }
  bubble.dataset.acc = (bubble.dataset.acc || '') + text;
  bubble.innerHTML = renderMd(bubble.dataset.acc);
  document.getElementById('chat-area').scrollTop = 9999;
}

function finalizeStreamBubble(mid) {
  const bubble = document.getElementById(`cbubble-${mid}`);
  if (!bubble) return;
  bubble.innerHTML = renderMd(bubble.dataset.acc || bubble.textContent || '');
  document.getElementById('chat-area').scrollTop = 9999;
}

function onChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function quickChat(q) { document.getElementById('chat-ta').value = q; sendChat(); }

function appendChatMsg(role, text, isError = false) {
  const area = document.getElementById('chat-area');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const bubbleStyle = isError ? ' style="color:#f87171"' : '';
  div.innerHTML = `<div class="chat-avatar ${role}">${role === 'user' ? '나' : 'AI'}</div>
    <div class="chat-content"><div class="chat-bubble ${role}"${bubbleStyle}>${esc(text)}</div></div>`;
  area.appendChild(div); area.scrollTop = area.scrollHeight;
  return div;
}

function appendTyping() {
  const id = ++CHAT_N;
  const area = document.getElementById('chat-area');
  const div = document.createElement('div');
  div.className = 'chat-msg ai'; div.id = `typing-${id}`;
  div.innerHTML = `<div class="chat-avatar ai">AI</div>
    <div class="chat-content"><div class="chat-bubble typing">
      <div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>
    </div></div>`;
  area.appendChild(div); area.scrollTop = area.scrollHeight;
  return id;
}

function removeTyping(id) { document.getElementById(`typing-${id}`)?.remove(); }


// ─── Notebook ─────────────────────────────────────────────
function addCell(type, text = '') {
  const id = ++CELL_N;
  CELLS.set(id, { type });
  document.getElementById('welcome-msg').style.display = 'none';
  const ph = type === 'ai' ? '자연어로 질문하세요 (예: 담당자별 활성 서비스케이스 개수 알려줘)' : 'SELECT TOP 10 * FROM table_name';
  const el = document.createElement('div');
  el.className = 'cell'; el.id = `cell-${id}`;
  el.innerHTML = `<div class="cell-hdr">
    <span class="badge ${type}">${type === 'ai' ? 'AI' : 'SQL'}</span>
    <span class="exec-num" id="en-${id}">In [&nbsp;]:</span>
    <span class="cell-preview" id="prev-${id}"></span>
    <div class="cell-acts">
      <button class="btn btn-sm" id="rbtn-${id}" onclick="runCell(${id})">▶ 실행</button>
      <button class="btn btn-sm danger" onclick="deleteCell(${id})">×</button>
    </div>
  </div>
  <div class="cell-in ${type}">
    <textarea class="cell-ta" id="ta-${id}" placeholder="${ph}"
      onkeydown="onCellKey(event,${id})" oninput="autoResizeTA(this);updatePreview(${id})"
      rows="2">${text}</textarea>
  </div>
  <div class="cell-out hidden" id="out-${id}"></div>`;
  document.getElementById('cells').appendChild(el);
  const ta = el.querySelector('textarea');
  if (text) { updatePreview(id); autoResizeTA(ta); }
  ta.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return id;
}

function deleteCell(id) {
  document.getElementById(`cell-${id}`)?.remove();
  CELLS.delete(id);
  if (!document.getElementById('cells').children.length)
    document.getElementById('welcome-msg').style.display = '';
}

function updatePreview(id) {
  const ta = document.getElementById(`ta-${id}`);
  const prev = document.getElementById(`prev-${id}`);
  if (ta && prev) prev.textContent = ta.value.slice(0, 70);
}

function onCellKey(e, id) {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); runCell(id); }
  if (e.key === 'Tab' && CELLS.get(id)?.type === 'sql') {
    e.preventDefault();
    const ta = e.target, s = ta.selectionStart;
    ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = s + 2;
  }
}

async function runCell(id) {
  const cell = CELLS.get(id); if (!cell) return;
  const input = document.getElementById(`ta-${id}`)?.value.trim(); if (!input) return;
  const el = document.getElementById(`cell-${id}`);
  const outEl = document.getElementById(`out-${id}`);
  const rBtn = document.getElementById(`rbtn-${id}`);
  const enEl = document.getElementById(`en-${id}`);
  el.classList.add('running'); el.classList.remove('has-error');
  const abort = new AbortController();
  CELL_ABORTS.set(id, abort);
  rBtn.textContent = '⏹ 취소';
  rBtn.onclick = () => abort.abort();
  enEl.innerHTML = 'In [*]:';
  outEl.classList.remove('hidden');
  outEl.innerHTML = `<div class="out-inner"><div class="running-row"><div class="spinner"></div><span>${cell.type === 'ai' ? 'AI 분석 중...' : 'SQL 실행 중...'}</span></div></div>`;
  const n = ++EXEC_N;
  try {
    if (cell.type === 'ai') await runAI(id, input, n, abort.signal);
    else await runSQL(id, input, n, abort.signal);
  } catch(err) {
    if (err.name !== 'AbortError') {
      el.classList.add('has-error');
      outEl.innerHTML = `<div class="out-inner"><div class="out-error">오류: ${esc(err.message)}</div></div>`;
    }
  } finally {
    CELL_ABORTS.delete(id);
    el.classList.remove('running');
    enEl.innerHTML = `In [${n}]:`;
    rBtn.textContent = '▶ 실행';
    rBtn.onclick = () => runCell(id);
    rBtn.disabled = false;
  }
}

async function runAI(id, question, n, signal) {
  const outEl = document.getElementById(`out-${id}`);
  outEl.innerHTML = '<div class="out-inner"><div class="out-answer"></div></div>';
  const ansEl = outEl.querySelector('.out-answer');
  let acc = '';
  try {
    await streamChat(
      buildMessage(question),
      (text) => { acc += text; ansEl.innerHTML = renderMd(acc); outEl.closest('.notebook')?.scrollBy(0, 99); },
      (name) => { ansEl.innerHTML = `<span style="color:#475569">🔍 ${esc(name)} 조회 중...</span>`; },
      (rows) => { ansEl.insertAdjacentHTML('beforeend', renderTable(rows)); },
      ()     => { ansEl.innerHTML = renderMd(acc); },
      (msg)  => { ansEl.innerHTML = `<span style="color:#f87171">오류: ${esc(msg)}</span>`; },
      signal,
    );
  } catch(err) {
    if (err.name === 'AbortError') {
      if (acc) ansEl.innerHTML = renderMd(acc);
      else ansEl.innerHTML = '<span style="color:#94a3b8">취소되었습니다.</span>';
    } else {
      throw err;
    }
  }
}

async function runSQL(id, sql, n, signal) {
  const outEl = document.getElementById(`out-${id}`);
  outEl.innerHTML = '<div class="out-inner"><div class="running-row"><div class="spinner"></div><span>SQL 실행 중...</span></div></div>';
  try {
    const resp = await fetch('/api/sql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
      signal,
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      outEl.innerHTML = `<div class="out-inner"><div class="out-error">오류: ${esc(data.error || resp.status)}</div></div>`;
    } else if (!data.rows || data.rows.length === 0) {
      outEl.innerHTML = `<div class="out-inner"><div class="out-answer">해당 조건에 맞는 데이터가 없습니다.</div></div>`;
    } else {
      outEl.innerHTML = `<div class="out-inner">${renderTable(data.rows)}</div>`;
    }
  } catch(err) {
    if (err.name === 'AbortError') {
      outEl.innerHTML = '<div class="out-inner"><span style="color:#94a3b8">취소되었습니다.</span></div>';
    } else {
      outEl.innerHTML = `<div class="out-inner"><div class="out-error">오류: ${esc(err.message)}</div></div>`;
    }
  }
}

// ─── Shared Helpers ───────────────────────────────────────

function autoResizeTA(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 280) + 'px';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function toast(msg, ms = 3200) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span><button class="toast-close" onclick="this.closest('.toast').remove()">×</button>`;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

async function runAll() {
  const btn = document.getElementById('run-all-btn'); btn.disabled = true;
  for (const el of document.querySelectorAll('.cell')) {
    const id = parseInt(el.id.replace('cell-',''));
    if (!isNaN(id)) await runCell(id);
  }
  btn.disabled = false;
}

function clearAll() {
  document.querySelectorAll('.cell-out').forEach(o => { o.classList.add('hidden'); o.innerHTML = ''; });
  EXEC_N = 0;
  document.querySelectorAll('.exec-num').forEach(e => { e.innerHTML = 'In [&nbsp;]:'; });
  document.querySelectorAll('.cell').forEach(e => e.classList.remove('running','has-error'));
}

function quickAsk(q) {
  const id = addCell('ai', q); updatePreview(id);
  const ta = document.getElementById(`ta-${id}`); if (ta) autoResizeTA(ta);
  setTimeout(() => runCell(id), 100);
}

// ─── Sidebar resize ───────────────────────────────────────
(function() {
  const resizer = document.getElementById('sb-resizer');
  const sb = document.getElementById('sidebar');
  let sx, sw;
  resizer.addEventListener('mousedown', e => {
    sx = e.clientX; sw = sb.offsetWidth;
    resizer.classList.add('active');
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
  function mv(e) { sb.style.width = Math.max(140, Math.min(480, sw + e.clientX - sx)) + 'px'; }
  function up()  { resizer.classList.remove('active'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
})();

// ─── Theme ────────────────────────────────────────────────
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  document.getElementById('theme-btn').textContent = isDark ? '☀' : '🌙';
}

(function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = saved === 'dark' || (!saved && prefersDark);
  if (useDark) document.documentElement.classList.add('dark');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = useDark ? '☀' : '🌙';
})();

// ─── Init ─────────────────────────────────────────────────
setMode('chat');
loadCatalog();  // 동기: Makino 카탈로그 렌더링 + localStorage 복원
