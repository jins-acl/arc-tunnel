'use strict';

let currentStatus = null;
let currentCategory = 'all';
const diagnosticEvents = [];
let statusRefresh = null;
let statusRefreshQueued = false;

const byId = (id) => document.getElementById(id);
const phaseLabels = { idle: '空闲', running: '进行中', failed: '失败' };

function setText(id, value) {
  byId(id).textContent = String(value);
}

function setCard(id, title, detail) {
  const card = byId(id);
  card.querySelector('strong').textContent = title;
  card.querySelector('small').textContent = detail;
}

function showOffline(show) {
  byId('offline-banner').hidden = !show;
}

function renderStatus(snapshot) {
  currentStatus = snapshot;
  const connected = Boolean(snapshot.extension.connected);
  const recovering = snapshot.extension.reconnectPhase !== 'idle';
  const overall = byId('overall-status');
  overall.textContent = connected ? (recovering ? '恢复处理中' : '运行正常') : '扩展未连接';
  overall.className = `status-pill ${connected && !recovering ? 'ok' : 'warn'}`;

  setCard('broker-card', '运行中', `端口 ${snapshot.broker.port} · 协议 v${snapshot.broker.protocolVersion} · 已运行 ${formatDuration(snapshot.broker.uptimeMs)}`);
  setCard('extension-card', connected ? '已连接' : '未连接', `连接代次 ${snapshot.extension.generation} · 最近同步 ${formatSyncTime(snapshot.extension.lastSyncAt)}`);
  setCard('recovery-card', recoveryLabel(snapshot), snapshot.recentError ? snapshot.recentError.summary : '最近无错误');
  setText('agent-count', snapshot.agents.connected);
  setText('grace-count', snapshot.agents.grace);
  setText('claimed-tab-count', snapshot.workload.claimedTabs);
  setText('pending-count', snapshot.workload.pendingCommands);
  setText('connection-detail', connected ? '扩展通道可用，状态只读展示' : '等待浏览器扩展重新连接');
  showOffline(false);
}

function recoveryLabel(snapshot) {
  const inventory = phaseLabels[snapshot.recovery.inventorySync] || snapshot.recovery.inventorySync;
  const recording = phaseLabels[snapshot.recovery.recordingCleanup] || snapshot.recovery.recordingCleanup;
  return `清单 ${inventory} · 录制清理 ${recording}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function formatSyncTime(timestamp) {
  if (timestamp == null) return '尚未同步';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function appendEvent(event) {
  diagnosticEvents.push(event);
  if (diagnosticEvents.length > 200) diagnosticEvents.splice(0, diagnosticEvents.length - 200);
  renderEvents();
}

function setCategory(category) {
  currentCategory = category;
  renderEvents();
}

function visibleEvents() {
  return diagnosticEvents.filter((event) => currentCategory === 'all' || event.category === currentCategory);
}

function renderEvents() {
  const list = byId('event-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const visible = visibleEvents();
  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '暂无符合筛选条件的事件';
    list.appendChild(empty);
    return;
  }
  for (const event of visible.slice().reverse()) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.className = 'event-meta';
    time.dateTime = new Date(event.timestamp).toISOString();
    time.textContent = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const type = document.createElement('span');
    type.className = `event-meta event-level-${event.level}`;
    type.textContent = `${event.category} · ${event.code}`;
    const summary = document.createElement('span');
    summary.textContent = event.summary;
    item.appendChild(time);
    item.appendChild(type);
    item.appendChild(summary);
    list.appendChild(item);
  }
}

async function copyDiagnostics() {
  const payload = { status: currentStatus, events: visibleEvents() };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  const button = byId('copy-diagnostics');
  const original = button.textContent;
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = original; }, 1600);
}

function fetchStatus() {
  if (statusRefresh) {
    statusRefreshQueued = true;
    return statusRefresh;
  }
  statusRefresh = (async () => {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error('status unavailable');
      renderStatus(await response.json());
    } catch {
      showOffline(true);
    }
  })().finally(() => {
    statusRefresh = null;
    if (statusRefreshQueued) {
      statusRefreshQueued = false;
      void fetchStatus();
    }
  });
  return statusRefresh;
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('diagnostic', (message) => {
    try {
      appendEvent(JSON.parse(message.data));
      void fetchStatus();
    } catch { showOffline(true); }
  });
  source.addEventListener('RESET', () => {
    diagnosticEvents.splice(0, diagnosticEvents.length);
    renderEvents();
    void fetchStatus();
  });
  source.onopen = () => showOffline(false);
  source.onerror = () => showOffline(true);
}

byId('event-filter').addEventListener('change', (event) => setCategory(event.target.value));
byId('copy-diagnostics').addEventListener('click', () => { void copyDiagnostics(); });
renderEvents();
void fetchStatus();
connectEvents();
