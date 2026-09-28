import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChannel } from '../public/js/monitor.js';

const playlist = (seq, end = false) => `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:${seq}
#EXTINF:4,
a.ts
#EXTINF:4,
b.ts${end ? '\n#EXT-X-ENDLIST' : ''}`;

function mockFetch(body, status = 200) {
  globalThis.fetch = async (url) => ({
    ok: status < 400,
    status,
    url,
    headers: new Headers({ 'content-type': status < 400 ? 'application/vnd.apple.mpegurl' : 'text/plain' }),
    text: async () => body,
  });
}

const ch = { url: 'https://x.com/live.m3u8' };
const opts = { wrap: (u) => u };

test('播放列表在更新为在线，长时间不更新为卡住', async () => {
  mockFetch(playlist(10));
  const first = await checkChannel(ch, null, opts);
  assert.equal(first.status, 'online');

  const again = await checkChannel(ch, first, opts);
  assert.equal(again.status, 'online'); // 刚检测过，还在容忍期内

  const old = { ...first, lastSeqChangeAt: Date.now() - 60_000 };
  const stalled = await checkChannel(ch, old, opts);
  assert.equal(stalled.status, 'stalled');

  mockFetch(playlist(11));
  const moved = await checkChannel(ch, stalled, opts);
  assert.equal(moved.status, 'online');
});

test('ENDLIST 识别为点播，HTTP 错误为离线', async () => {
  mockFetch(playlist(1, true));
  assert.equal((await checkChannel(ch, null, opts)).status, 'vod');

  mockFetch('域名解析失败', 502);
  const r = await checkChannel(ch, null, opts);
  assert.equal(r.status, 'offline');
  assert.equal(r.error, 'HTTP 502 域名解析失败');

  mockFetch('<html>not a playlist</html>');
  assert.equal((await checkChannel(ch, null, opts)).status, 'offline');
});
