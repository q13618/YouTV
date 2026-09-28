// 频道健康检查：拉取 HLS 播放列表，判断 在线 / 卡住(不更新) / 离线。
import { parseHls } from './parser.js';

export const STATUS = {
  unknown: { label: '未检测', cls: 'unknown' },
  checking: { label: '检测中', cls: 'checking' },
  online: { label: '在线', cls: 'online' },
  stalled: { label: '卡住', cls: 'stalled' },
  vod: { label: '点播', cls: 'vod' },
  offline: { label: '离线', cls: 'offline' },
};

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) {
      // 代理返回的错误是简短的纯文本说明，一并显示
      const detail = /text\/plain/.test(res.headers.get('content-type') || '') ? (await res.text()).slice(0, 60) : '';
      throw new Error(`HTTP ${res.status}` + (detail ? ` ${detail}` : ''));
    }
    // 经代理时用原始地址解析相对路径，代理会返回 X-Final-Url
    return { text: await res.text(), finalUrl: res.headers.get('x-final-url') || res.url };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('超时');
    if (e instanceof TypeError) throw new Error('网络错误/CORS 被拦截');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// prev: 该频道上一次的检测结果，用于判断媒体序号是否在前进
export async function checkChannel(channel, prev, { wrap, timeoutMs = 10000 }) {
  const started = performance.now();
  const result = {
    checkedAt: Date.now(),
    status: 'offline',
    error: '',
    latencyMs: 0,
    variants: prev?.variants || [],
    mediaSequence: null,
    lastSeqChangeAt: prev?.lastSeqChangeAt || Date.now(),
    targetDuration: 0,
    segmentCount: 0,
  };
  try {
    let { text, finalUrl } = await fetchText(wrap(channel.url), timeoutMs);
    let pl = parseHls(text, unwrapFinal(finalUrl, channel.url));
    if (pl.type === 'master') {
      result.variants = pl.variants.map(({ bandwidth, resolution }) => ({ bandwidth, resolution }));
      if (!pl.variants.length) throw new Error('主播放列表无码流');
      // 从最低码率的子流开始检测以节省流量；失败时再换其他子流试（最多 3 路）
      const candidates = pl.variants.slice().reverse().slice(0, 3);
      let lastErr;
      for (const v of candidates) {
        try {
          ({ text, finalUrl } = await fetchText(wrap(v.url), timeoutMs));
          pl = parseHls(text, unwrapFinal(finalUrl, v.url));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) throw new Error('子码流 ' + lastErr.message);
    }
    if (pl.type !== 'media') throw new Error('不是有效的 HLS 播放列表');
    result.latencyMs = Math.round(performance.now() - started);
    result.targetDuration = pl.targetDuration;
    result.segmentCount = pl.segments.length;
    // 用 "媒体序号 + 分片数" 表示播放列表末尾的位置
    result.mediaSequence = pl.mediaSequence + pl.segments.length;
    if (!pl.segments.length) throw new Error('播放列表中没有分片');
    if (pl.endList) {
      result.status = 'vod';
    } else {
      if (prev && prev.mediaSequence !== null && prev.mediaSequence === result.mediaSequence) {
        const stalledFor = Date.now() - result.lastSeqChangeAt;
        const limit = Math.max(3 * (pl.targetDuration || 6), 20) * 1000;
        result.status = stalledFor > limit ? 'stalled' : 'online';
        if (result.status === 'stalled') result.error = `播放列表 ${Math.round(stalledFor / 1000)} 秒未更新`;
      } else {
        result.lastSeqChangeAt = Date.now();
        result.status = 'online';
      }
    }
  } catch (e) {
    result.status = 'offline';
    result.error = e.message || String(e);
    result.latencyMs = Math.round(performance.now() - started);
  }
  return result;
}

// 代理返回的是代理地址时，退回到原始地址作为相对路径的基准
function unwrapFinal(finalUrl, original) {
  if (!finalUrl || finalUrl.includes('/proxy?url=')) return original;
  return finalUrl;
}

// 简单的并发队列
export function createQueue(concurrency) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= concurrency || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return {
    push(fn) {
      return new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
    },
    setConcurrency(n) { concurrency = n; next(); },
    get size() { return waiting.length + active; },
  };
}
