import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelList, parseHls, isHlsPlaylist } from '../public/js/parser.js';

test('解析 IPTV M3U 列表', () => {
  const list = parseChannelList(`#EXTM3U
#EXTINF:-1 tvg-logo="http://x/logo.png" group-title="新闻",新闻频道
http://a.com/news/index.m3u8
#EXTINF:-1,体育
https://b.com/sport.m3u8`);
  assert.equal(list.length, 2);
  assert.deepEqual(
    { name: list[0].name, group: list[0].group, logo: list[0].logo, url: list[0].url },
    { name: '新闻频道', group: '新闻', logo: 'http://x/logo.png', url: 'http://a.com/news/index.m3u8' },
  );
  assert.equal(list[1].name, '体育');
});

test('解析纯文本 / CSV / genre 分组，去重并跳过表头', () => {
  const list = parseChannelList(`名称,地址
央视,#genre#
CCTV-1,http://a.com/cctv1.m3u8
CCTV-1 重复,http://a.com/cctv1.m3u8
https://c.com/live/room42/index.m3u8
频道A | https://d.com/a.m3u8 | 地方台`);
  assert.equal(list.length, 3);
  assert.equal(list[0].name, 'CCTV-1');
  assert.equal(list[0].group, '央视');
  assert.equal(list[1].name, 'room42'); // 通用文件名 index 改用目录名
  assert.equal(list[2].name, '频道A');
  assert.equal(list[2].group, '地方台');
});

test('解析 JSON', () => {
  const list = parseChannelList(JSON.stringify({ channels: [{ title: 'A', url: 'http://a.com/a.m3u8' }, 'http://b.com/b.m3u8'] }), 'x.json');
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'A');
  assert.equal(list[1].name, 'b');
});

test('解析 HLS 主播放列表和媒体播放列表', () => {
  const master = parseHls(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
high/index.m3u8`, 'https://h.com/live/master.m3u8');
  assert.equal(master.type, 'master');
  assert.equal(master.variants[0].resolution, '1920x1080');
  assert.equal(master.variants[1].url, 'https://h.com/live/low/index.m3u8');

  const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.0,
seg100.ts
#EXTINF:6.0,
seg101.ts`;
  assert.ok(isHlsPlaylist(text));
  const media = parseHls(text, 'https://h.com/live/low/index.m3u8');
  assert.equal(media.type, 'media');
  assert.equal(media.mediaSequence, 100);
  assert.equal(media.segments.length, 2);
  assert.equal(media.segments[1].url, 'https://h.com/live/low/seg101.ts');
  assert.equal(media.endList, false);
  assert.equal(parseHls('<html>', '').type, 'invalid');
});
