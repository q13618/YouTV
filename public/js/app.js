import { parseChannelList, dedupe, isHlsPlaylist } from './parser.js';
import { checkChannel, createQueue, STATUS } from './monitor.js';

const $ = (sel) => document.querySelector(sel);
const LS_CHANNELS = 'youtv.channels';
const LS_SETTINGS = 'youtv.settings';

const DEFAULT_SETTINGS = {
  interval: 60,
  concurrency: 6,
  maxPreviews: 9,
  useProxy: true,
  alertSound: false,
  view: 'grid',
  preview: false,
};

const SAMPLE = `#EXTM3U
#EXTINF:-1 group-title="测试源",Unified Streaming 直播
https://demo.unified-streaming.com/k8s/live/stable/scte35.isml/.m3u8
#EXTINF:-1 group-title="测试源",Mux 测试流
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 group-title="测试源",Apple 多码率示例
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
#EXTINF:-1 group-title="测试源",无效地址示例
https://example.invalid/live/offline.m3u8`;

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储已满或被禁用 */ }
}

const state = {
  channels: load(LS_CHANNELS, []),
  settings: { ...DEFAULT_SETTINGS, ...load(LS_SETTINGS, {}) },
  results: new Map(),
  pending: new Set(),
  proxyAvailable: false,
  filter: { q: '', group: '', status: '' },
  visible: [],
  playingIndex: -1,
};

const queue = createQueue(state.settings.concurrency);

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function proxyOn() { return state.proxyAvailable && state.settings.useProxy; }
function playUrl(url) { return proxyOn() ? '/proxy?url=' + encodeURIComponent(url) : url; }
function checkUrl(url) { return proxyOn() ? '/proxy?raw=1&url=' + encodeURIComponent(url) : url; }

function fmtBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Mbps' : Math.round(bps / 1e3) + ' kbps';
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  return new Date(ts).toLocaleTimeString();
}
function statusOf(id) {
  if (state.pending.has(id) && !state.results.has(id)) return 'checking';
  return state.results.get(id)?.status || 'unknown';
}

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

let audioCtx;
function beep() {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch { /* 浏览器不允许自动发声 */ }
}

// ---------- 渲染 ----------
function filteredChannels() {
  const { q, group, status } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.channels.filter((ch) => {
    if (group && ch.group !== group) return false;
    if (status) {
      const s = statusOf(ch.id);
      if (status === 'offline' ? s !== 'offline' : status === 'online' ? !(s === 'online' || s === 'vod') : s !== status) return false;
    }
    if (needle && !(`${ch.name} ${ch.url} ${ch.group}`.toLowerCase().includes(needle))) return false;
    return true;
  });
}

function renderStats() {
  const counts = { online: 0, stalled: 0, offline: 0, other: 0 };
  for (const ch of state.channels) {
    const s = statusOf(ch.id);
    if (s === 'online' || s === 'vod') counts.online++;
    else if (s === 'stalled') counts.stalled++;
    else if (s === 'offline') counts.offline++;
    else counts.other++;
  }
  $('#stats').innerHTML = `
    <span class="stat">共 <b>${state.channels.length}</b></span>
    <span class="stat online">在线 <b>${counts.online}</b></span>
    <span class="stat stalled">卡住 <b>${counts.stalled}</b></span>
    <span class="stat offline">离线 <b>${counts.offline}</b></span>
    ${counts.other ? `<span class="stat unknown">待检测 <b>${counts.other}</b></span>` : ''}`;
  const bad = counts.stalled + counts.offline;
  document.title = (bad ? `(${bad}⚠) ` : '') + 'YouTV 直播监控台';
}

function renderGroups() {
  const groups = [...new Set(state.channels.map((c) => c.group).filter(Boolean))].sort();
  const sel = $('#filterGroup');
  const cur = state.filter.group;
  sel.innerHTML = '<option value="">全部分组</option>' + groups.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
  sel.classList.toggle('hidden', !groups.length);
}

function tileInfo(ch) {
  const r = state.results.get(ch.id);
  const top = r?.variants?.[0];
  const parts = [];
  if (top?.resolution) parts.push(top.resolution);
  if (top?.bandwidth) parts.push(fmtBitrate(top.bandwidth));
  if (r?.variants?.length > 1) parts.push(`${r.variants.length} 路码流`);
  if (r?.latencyMs && r.status !== 'offline') parts.push(`${r.latencyMs} ms`);
  return parts.join(' · ');
}

function tileHTML(ch) {
  return `
    <div class="tile-media">
      ${ch.logo ? `<img class="logo" src="${esc(ch.logo)}" alt="" loading="lazy" onerror="this.remove()">` : `<div class="logo-text">${esc(ch.name.slice(0, 4))}</div>`}
      <span class="badge"></span>
      <button class="del" title="删除频道">✕</button>
      <div class="play-hint">▶ 点击观看</div>
    </div>
    <div class="tile-body">
      <div class="name" title="${esc(ch.name)}">${esc(ch.name)}</div>
      <div class="meta"></div>
      <div class="err"></div>
    </div>`;
}

function updateTile(el, ch) {
  const s = statusOf(ch.id);
  const r = state.results.get(ch.id);
  el.dataset.status = s;
  const badge = el.querySelector('.badge');
  badge.className = 'badge ' + STATUS[s].cls;
  badge.textContent = (state.pending.has(ch.id) && s !== 'checking' ? '⟳ ' : '') + STATUS[s].label;
  el.querySelector('.meta').textContent = [ch.group, tileInfo(ch), r ? fmtAgo(r.checkedAt) : ''].filter(Boolean).join(' · ');
  const err = el.querySelector('.err');
  err.textContent = r?.error || '';
  err.title = r?.error || '';
}

function renderGrid() {
  releaseAllPreviews();
  const grid = $('#grid');
  grid.className = state.settings.view === 'list' ? 'list' : 'grid';
  state.visible = filteredChannels();
  const frag = document.createDocumentFragment();
  for (const ch of state.visible) {
    const el = document.createElement('article');
    el.className = 'tile';
    el.dataset.id = ch.id;
    el.innerHTML = tileHTML(ch);
    updateTile(el, ch);
    frag.appendChild(el);
  }
  grid.replaceChildren(frag);
  $('#empty').classList.toggle('hidden', state.channels.length > 0);
  if (state.channels.length && !state.visible.length) {
    grid.innerHTML = '<p class="muted center">没有符合筛选条件的频道</p>';
  }
  renderStats();
  observeTiles();
}

function refreshTile(id) {
  const ch = state.channels.find((c) => c.id === id);
  const el = document.querySelector(`.tile[data-id="${id}"]`);
  if (ch && el) updateTile(el, ch);
  renderStats();
}

// 定时刷新 "xx 秒前"
setInterval(() => {
  for (const el of document.querySelectorAll('.tile')) {
    const ch = state.channels.find((c) => c.id === el.dataset.id);
    if (ch) updateTile(el, ch);
  }
}, 10000);

// ---------- 检测 ----------
function scheduleCheck(ch) {
  if (state.pending.has(ch.id)) return;
  state.pending.add(ch.id);
  refreshTile(ch.id);
  queue.push(async () => {
    const prev = state.results.get(ch.id);
    const r = await checkChannel(ch, prev, { wrap: checkUrl });
    state.pending.delete(ch.id);
    if (!state.channels.some((c) => c.id === ch.id)) return; // 已被删除
    state.results.set(ch.id, r);
    const wasOk = prev && (prev.status === 'online' || prev.status === 'vod');
    if (wasOk && (r.status === 'offline' || r.status === 'stalled')) {
      toast(`⚠️ ${ch.name}：${STATUS[r.status].label}（${r.error}）`, 6000);
      if (state.settings.alertSound) beep();
    }
    refreshTile(ch.id);
    if (state.filter.status) scheduleRender();
  });
}

let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => { renderPending = false; renderGrid(); }, 1500);
}

function checkAll() {
  state.channels.forEach(scheduleCheck);
}

let loopTimer;
function startLoop() {
  clearInterval(loopTimer);
  loopTimer = setInterval(checkAll, Math.max(10, state.settings.interval) * 1000);
}

// ---------- 小窗预览 ----------
const previews = new Map(); // id -> { video, hls }
const visibleTiles = new Set();
let observer;

function observeTiles() {
  observer?.disconnect();
  visibleTiles.clear();
  if (!state.settings.preview) return;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      if (e.isIntersecting) visibleTiles.add(id); else { visibleTiles.delete(id); releasePreview(id); }
    }
    fillPreviews();
  }, { threshold: 0.3 });
  document.querySelectorAll('.tile').forEach((el) => observer.observe(el));
}

function fillPreviews() {
  if (!state.settings.preview || $('#playerDialog').open) return;
  for (const id of visibleTiles) {
    if (previews.size >= state.settings.maxPreviews) break;
    if (previews.has(id)) continue;
    if (statusOf(id) === 'offline') continue;
    const ch = state.channels.find((c) => c.id === id);
    const el = document.querySelector(`.tile[data-id="${id}"] .tile-media`);
    if (!ch || !el) continue;
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'preview';
    el.prepend(video);
    const hls = attachHls(video, ch.url, { preview: true });
    previews.set(id, { video, hls });
  }
}

function releasePreview(id) {
  const p = previews.get(id);
  if (!p) return;
  p.hls?.destroy();
  p.video.removeAttribute('src');
  p.video.load();
  p.video.remove();
  previews.delete(id);
}
function releaseAllPreviews() { [...previews.keys()].forEach(releasePreview); }

// ---------- 播放 ----------
function attachHls(video, url, { preview = false, onError } = {}) {
  const src = playUrl(url);
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls(preview
      ? { capLevelToPlayerSize: true, maxBufferLength: 6, backBufferLength: 0, startLevel: 0, lowLatencyMode: false }
      : { lowLatencyMode: true, backBufferLength: 30 });
    hls.loadSource(src);
    hls.attachMedia(video);
    let lastRecover = 0;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      // 解码类错误先尝试恢复一次；短时间内反复出错或编码不兼容则直接报错
      const incompatible = data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !incompatible && Date.now() - lastRecover > 10000) {
        lastRecover = Date.now();
        hls.recoverMediaError();
        return;
      }
      onError?.(data);
    });
    video.play?.().catch(() => {});
    return hls;
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src; // Safari 原生支持 HLS
    video.play?.().catch(() => {});
    return null;
  }
  onError?.({ details: '当前浏览器不支持 HLS 播放' });
  return null;
}

const ERROR_TEXT = {
  manifestLoadError: '播放列表加载失败',
  manifestLoadTimeOut: '播放列表加载超时',
  manifestParsingError: '播放列表格式错误',
  manifestIncompatibleCodecsError: '当前浏览器不支持该视频编码（可换 Chrome/Edge/Safari 试试）',
  levelLoadError: '子码流加载失败',
  levelLoadTimeOut: '子码流加载超时',
  fragLoadError: '视频分片加载失败',
  fragLoadTimeOut: '视频分片加载超时',
  bufferAppendError: '视频解码失败',
};

const player = { hls: null, statsTimer: null };

function openPlayer(index) {
  const ch = state.visible[index];
  if (!ch) return;
  state.playingIndex = index;
  releaseAllPreviews();
  closePlayerMedia();
  const dlg = $('#playerDialog');
  $('#playerTitle').textContent = ch.name;
  $('#playerUrl').textContent = ch.url;
  $('#playerError').classList.add('hidden');
  $('#levelSelect').innerHTML = '<option value="-1">自动</option>';
  const video = $('#player');
  player.hls = attachHls(video, ch.url, {
    onError: (data) => {
      const box = $('#playerError');
      box.textContent = `播放失败：${ERROR_TEXT[data.details] || data.details || data.type}${data.response?.code ? `（HTTP ${data.response.code}）` : ''}`;
      box.classList.remove('hidden');
    },
  });
  if (player.hls) {
    player.hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      $('#levelSelect').innerHTML = '<option value="-1">自动</option>' + data.levels.map((l, i) =>
        `<option value="${i}">${l.height ? l.height + 'p' : '码流 ' + (i + 1)} ${fmtBitrate(l.bitrate)}</option>`).join('');
    });
  }
  player.statsTimer = setInterval(renderPlayerStats, 1000);
  if (!dlg.open) dlg.showModal();
}

function renderPlayerStats() {
  const video = $('#player');
  const hls = player.hls;
  const ch = state.visible[state.playingIndex];
  const r = ch && state.results.get(ch.id);
  let buffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) buffered = video.buffered.end(i) - video.currentTime;
  }
  const q = video.getVideoPlaybackQuality?.();
  const level = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : null;
  const rows = [
    ['状态', video.paused ? '已暂停' : video.readyState >= 3 ? '播放中' : '缓冲中'],
    ['分辨率', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—'],
    ['当前码率', level ? fmtBitrate(level.bitrate) : '—'],
    ['估算带宽', hls?.bandwidthEstimate ? fmtBitrate(hls.bandwidthEstimate) : '—'],
    ['缓冲', buffered.toFixed(1) + ' 秒'],
    ['直播延迟', hls?.latency ? hls.latency.toFixed(1) + ' 秒' : '—'],
    ['丢帧', q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}` : '—'],
    ['监测状态', r ? `${STATUS[r.status].label}（${fmtAgo(r.checkedAt)}）` : '—'],
  ];
  $('#playerStats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

function closePlayerMedia() {
  clearInterval(player.statsTimer);
  player.hls?.destroy();
  player.hls = null;
  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

// ---------- 导入 / 导出 ----------
async function readFiles(files) {
  const out = [];
  const skipped = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      if (!window.JSZip) throw new Error('JSZip 未加载，无法解析 zip');
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || entry.name.startsWith('__MACOSX')) continue;
        if (!/\.(m3u8?|txt|csv|json|tsv)$/i.test(entry.name)) { skipped.push(entry.name); continue; }
        out.push(...parseEntry(await entry.async('string'), entry.name, skipped));
      }
    } else {
      out.push(...parseEntry(await file.text(), file.name, skipped));
    }
  }
  return { channels: out, skipped };
}

function parseEntry(text, name, skipped) {
  // zip 里若是单个 HLS 播放列表文件（非频道列表），无法得知其网络地址，跳过并提示
  if (isHlsPlaylist(text) && !/#EXTINF:[^\n]*,[^\n]*\n\s*https?:/i.test(text)) {
    skipped.push(name + '（是 HLS 播放列表本身，不是频道地址列表）');
    return [];
  }
  const base = name.split('/').pop().replace(/\.\w+$/, '');
  return parseChannelList(text, name).map((ch) => ({ ...ch, group: ch.group || base }));
}

function applyImport(list, mode) {
  const before = state.channels.length;
  state.channels = mode === 'replace' ? dedupe(list) : dedupe([...state.channels, ...list]);
  if (mode === 'replace') { state.results.clear(); state.pending.clear(); }
  save(LS_CHANNELS, state.channels);
  renderGroups();
  renderGrid();
  checkAll();
  return mode === 'replace' ? state.channels.length : state.channels.length - before;
}

function exportM3U() {
  const text = '#EXTM3U\n' + state.channels.map((c) =>
    `#EXTINF:-1${c.group ? ` group-title="${c.group}"` : ''}${c.logo ? ` tvg-logo="${c.logo}"` : ''},${c.name}\n${c.url}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
  a.download = 'youtv-channels.m3u';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 事件绑定 ----------
function bindEvents() {
  $('#search').addEventListener('input', (e) => { state.filter.q = e.target.value; renderGrid(); });
  $('#filterGroup').addEventListener('change', (e) => { state.filter.group = e.target.value; renderGrid(); });
  $('#filterStatus').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#filterStatus').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    state.filter.status = b.dataset.status;
    renderGrid();
  });
  $('#viewMode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.settings.view = b.dataset.view;
    save(LS_SETTINGS, state.settings);
    syncViewButtons();
    renderGrid();
  });
  $('#togglePreview').addEventListener('change', (e) => {
    state.settings.preview = e.target.checked;
    save(LS_SETTINGS, state.settings);
    if (!e.target.checked) releaseAllPreviews();
    observeTiles();
  });

  $('#grid').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const id = tile.dataset.id;
    if (e.target.closest('.del')) {
      const ch = state.channels.find((c) => c.id === id);
      if (ch && confirm(`删除频道「${ch.name}」？`)) {
        state.channels = state.channels.filter((c) => c.id !== id);
        state.results.delete(id);
        releasePreview(id);
        save(LS_CHANNELS, state.channels);
        renderGroups();
        renderGrid();
      }
      return;
    }
    openPlayer(state.visible.findIndex((c) => c.id === id));
  });

  $('#btnCheckAll').addEventListener('click', () => { checkAll(); toast('已开始检测所有频道'); });
  $('#btnLoadSample').addEventListener('click', () => applyImport(parseChannelList(SAMPLE), 'merge'));

  // 播放器
  const dlg = $('#playerDialog');
  $('#btnClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { closePlayerMedia(); state.playingIndex = -1; fillPreviews(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#btnPrev').addEventListener('click', () => openPlayer((state.playingIndex - 1 + state.visible.length) % state.visible.length));
  $('#btnNext').addEventListener('click', () => openPlayer((state.playingIndex + 1) % state.visible.length));
  $('#btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#playerUrl').textContent); toast('已复制'); } catch { toast('复制失败'); }
  });
  $('#levelSelect').addEventListener('change', (e) => { if (player.hls) player.hls.currentLevel = Number(e.target.value); });
  document.addEventListener('keydown', (e) => {
    if (!dlg.open || e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') $('#btnPrev').click();
    if (e.key === 'ArrowRight') $('#btnNext').click();
  });

  // 导入
  const imp = $('#importDialog');
  let pickedFiles = [];
  const showPicked = () => { $('#importResult').textContent = pickedFiles.length ? '已选择：' + pickedFiles.map((f) => f.name).join('、') : ''; };
  $('#btnImport').addEventListener('click', () => { pickedFiles = []; $('#pasteInput').value = ''; showPicked(); imp.showModal(); });
  $('#fileInput').addEventListener('change', (e) => { pickedFiles = [...e.target.files]; showPicked(); });
  const drop = $('#dropZone');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pickedFiles = [...e.dataTransfer.files]; showPicked(); });
  $('#btnDoImport').addEventListener('click', async (e) => {
    e.preventDefault();
    const mode = imp.querySelector('input[name=importMode]:checked').value;
    try {
      const { channels, skipped } = await readFiles(pickedFiles);
      channels.push(...parseChannelList($('#pasteInput').value));
      if (!channels.length) {
        $('#importResult').textContent = '没有找到任何直播地址' + (skipped.length ? `；已跳过：${skipped.join('、')}` : '');
        return;
      }
      const n = applyImport(channels, mode);
      imp.close();
      toast(`导入完成：${mode === 'replace' ? '共' : '新增'} ${n} 个频道` + (skipped.length ? `，跳过 ${skipped.length} 个文件` : ''), 5000);
    } catch (err) {
      $('#importResult').textContent = '导入失败：' + err.message;
    }
  });

  // 设置
  const set = $('#settingsDialog');
  $('#btnSettings').addEventListener('click', () => {
    const s = state.settings;
    $('#setInterval').value = s.interval;
    $('#setConcurrency').value = s.concurrency;
    $('#setMaxPreviews').value = s.maxPreviews;
    $('#setUseProxy').checked = s.useProxy;
    $('#setUseProxy').disabled = !state.proxyAvailable;
    $('#setAlertSound').checked = s.alertSound;
    set.showModal();
  });
  $('#btnSaveSettings').addEventListener('click', () => {
    const s = state.settings;
    s.interval = Math.max(10, Number($('#setInterval').value) || DEFAULT_SETTINGS.interval);
    s.concurrency = Math.min(20, Math.max(1, Number($('#setConcurrency').value) || DEFAULT_SETTINGS.concurrency));
    s.maxPreviews = Math.min(36, Math.max(1, Number($('#setMaxPreviews').value) || DEFAULT_SETTINGS.maxPreviews));
    s.useProxy = $('#setUseProxy').checked;
    s.alertSound = $('#setAlertSound').checked;
    if (s.alertSound) beep(); // 用户交互时初始化音频
    save(LS_SETTINGS, s);
    queue.setConcurrency(s.concurrency);
    startLoop();
    renderProxyNotice();
    releaseAllPreviews();
    fillPreviews();
  });
  $('#btnExport').addEventListener('click', exportM3U);
  $('#btnClearAll').addEventListener('click', () => {
    if (!confirm('确定清空所有频道？')) return;
    applyImport([], 'replace');
    set.close();
  });
}

function syncViewButtons() {
  $('#viewMode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.settings.view));
}

function renderProxyNotice() {
  const el = $('#proxyNotice');
  if (state.proxyAvailable) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '提示：当前未检测到本地代理服务，浏览器会直接访问直播源。若很多频道显示 “网络错误/CORS 被拦截”，请用 <code>npm start</code> 启动内置服务后再打开本页面。';
}

async function detectProxy() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    state.proxyAvailable = res.ok && (await res.json()).proxy === true;
  } catch { state.proxyAvailable = false; }
}

// 首次打开且本地没有列表时，尝试读取站点根目录下的 channels.m3u / channels.txt
async function loadBundledChannels() {
  for (const name of ['channels.m3u', 'channels.txt', 'channels.json']) {
    try {
      const res = await fetch(name, { cache: 'no-store' });
      if (!res.ok) continue;
      const list = parseChannelList(await res.text(), name);
      if (list.length) return list;
    } catch { /* 忽略 */ }
  }
  return [];
}

async function init() {
  bindEvents();
  syncViewButtons();
  $('#togglePreview').checked = state.settings.preview;
  await detectProxy();
  renderProxyNotice();
  if (!state.channels.length) {
    const bundled = await loadBundledChannels();
    if (bundled.length) { state.channels = bundled; save(LS_CHANNELS, bundled); }
  }
  renderGroups();
  renderGrid();
  checkAll();
  startLoop();
}

init();
