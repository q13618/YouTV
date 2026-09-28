// 频道列表解析：支持 M3U/M3U8(IPTV 列表)、纯文本(每行一个 URL 或 "名称,URL")、CSV、JSON。
// 同时用于浏览器与 Node 测试，不依赖任何 DOM API。

const URL_RE = /(https?:\/\/[^\s,;"'<>|]+)/i;

export function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'ch_' + (h >>> 0).toString(36);
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const file = parts.pop() || u.hostname;
    const base = file.replace(/\.m3u8?$/i, '');
    // index/playlist/master 这类通用文件名没有意义，改用上一级目录名
    if (/^(index|playlist|master|live|chunklist|mono|stream)$/i.test(base) && parts.length) {
      return decodeURIComponent(parts.pop());
    }
    return decodeURIComponent(base);
  } catch {
    return url;
  }
}

function makeChannel({ name, url, group, logo }) {
  url = url.trim();
  return {
    id: hashId(url),
    name: (name || '').trim() || nameFromUrl(url),
    url,
    group: (group || '').trim(),
    logo: (logo || '').trim(),
  };
}

// 判断文本是否是 HLS 播放列表本身（而不是 IPTV 频道列表）
export function isHlsPlaylist(text) {
  return /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text);
}

function parseM3U(text) {
  const out = [];
  let pending = null;
  let group = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      const attrs = parseAttrs(line);
      pending = {
        name: comma >= 0 ? line.slice(comma + 1) : '',
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
      };
      if (!pending.name) pending.name = attrs['tvg-name'] || '';
    } else if (line.startsWith('#EXTGRP:')) {
      group = line.slice(8).trim();
    } else if (line.startsWith('#')) {
      continue;
    } else if (URL_RE.test(line)) {
      const url = line.match(URL_RE)[1];
      const info = pending || {};
      out.push(makeChannel({ ...info, group: info.group || group, url }));
      pending = null;
    }
  }
  return out;
}

function parseJSON(text) {
  let data = JSON.parse(text);
  if (!Array.isArray(data)) data = data.channels || data.streams || data.list || Object.values(data);
  const out = [];
  for (const item of data) {
    if (typeof item === 'string') {
      if (URL_RE.test(item)) out.push(makeChannel({ url: item.match(URL_RE)[1] }));
    } else if (item && typeof item === 'object') {
      const url = item.url || item.src || item.link || item.stream || item.hls || '';
      if (!URL_RE.test(url)) continue;
      out.push(makeChannel({
        name: item.name || item.title || item.channel || '',
        url,
        group: item.group || item.category || '',
        logo: item.logo || '',
      }));
    }
  }
  return out;
}

// 纯文本/CSV：每行找出 URL，其余部分作为名称；"#分组名" 或 "分组名,#genre#" 作为分组
function parseLines(text) {
  const out = [];
  let group = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const genre = line.match(/^(.+?),\s*#genre#\s*$/i);
    if (genre) { group = genre[1].trim(); continue; }
    const m = line.match(URL_RE);
    if (!m) {
      if (line.startsWith('#') && !line.startsWith('#EXT')) group = line.replace(/^#+/, '').trim();
      continue;
    }
    const url = m[1];
    let rest = line.replace(url, ' ').replace(/^[\s,;|\t]+|[\s,;|\t]+$/g, '');
    // CSV 可能有多列：名称,URL,分组
    const cols = rest.split(/\s*[,;|\t]\s*/).filter(Boolean);
    const name = (cols[0] || '').replace(/^"|"$/g, '');
    const g = (cols[1] || '').replace(/^"|"$/g, '');
    if (/^(name|名称|频道|channel)$/i.test(name)) continue; // 表头
    out.push(makeChannel({ name, url, group: g || group }));
  }
  return out;
}

export function parseChannelList(text, filename = '') {
  text = text.replace(/^﻿/, '');
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/\.json$/i.test(filename) || /^[[{]/.test(trimmed)) {
    try { return dedupe(parseJSON(trimmed)); } catch { /* 当作文本继续 */ }
  }
  if (/#EXTINF/i.test(trimmed)) return dedupe(parseM3U(trimmed));
  return dedupe(parseLines(trimmed));
}

export function dedupe(list) {
  const seen = new Map();
  for (const ch of list) if (!seen.has(ch.id)) seen.set(ch.id, ch);
  return [...seen.values()];
}

// ---------- HLS 播放列表解析（用于健康检查） ----------

export function resolveUrl(ref, base) {
  try { return new URL(ref, base).href; } catch { return ref; }
}

export function parseHls(text, baseUrl) {
  if (!/^\s*#EXTM3U/.test(text)) return { type: 'invalid' };
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = lines[i].slice(lines[i].indexOf(':') + 1);
      const bw = attrs.match(/(?:^|,)BANDWIDTH=(\d+)/);
      const res = attrs.match(/RESOLUTION=(\d+x\d+)/);
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) { uri = lines[j]; break; }
      }
      if (uri) variants.push({
        bandwidth: bw ? Number(bw[1]) : 0,
        resolution: res ? res[1] : '',
        url: resolveUrl(uri, baseUrl),
      });
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: 'master', variants };
  }
  const tag = (name) => {
    const l = lines.find((x) => x.startsWith(name + ':'));
    return l ? l.slice(name.length + 1) : null;
  };
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF:')) {
      const dur = parseFloat(lines[i].slice(8));
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          segments.push({ duration: dur, url: resolveUrl(lines[j], baseUrl) });
          i = j;
          break;
        }
      }
    }
  }
  return {
    type: 'media',
    targetDuration: Number(tag('#EXT-X-TARGETDURATION')) || 0,
    mediaSequence: Number(tag('#EXT-X-MEDIA-SEQUENCE')) || 0,
    endList: lines.includes('#EXT-X-ENDLIST'),
    segments,
  };
}
