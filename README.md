# YouTV 直播监控台

一个简单易用的 HLS（m3u8）直播流监控 Web 应用：批量导入直播地址，自动检测每路直播是否在线，点击任意频道即可观看。

## 功能

- **导入频道**：支持 zip 压缩包（自动读取包内所有列表文件）、m3u / m3u8 频道列表、txt、csv、json，也可直接粘贴地址；支持拖拽上传。
- **自动监测**：定时拉取每路直播的播放列表，判断状态：
  - 🟢 **在线**：播放列表正常且在持续更新
  - 🟠 **卡住**：播放列表能访问，但超过 3 个分片时长没有更新（推流中断的典型表现）
  - 🔴 **离线**：无法访问、超时、HTTP 错误或不是有效的 HLS
  - 🟣 **点播**：带 `#EXT-X-ENDLIST` 的非直播流
- 显示分辨率、码率、码流数量、响应时间、最后检测时间和错误原因。
- **监控墙**：卡片 / 列表两种视图，按名称、地址、分组、状态筛选；可开启"实时预览画面"（只播放屏幕内可见的频道，数量可限制）。
- **点击观看**：弹窗播放器，支持清晰度切换，显示实时分辨率、码率、缓冲、直播延迟、丢帧；键盘 ← → 切换频道。
- 频道掉线时弹出提醒，可选提示音；浏览器标签页标题显示异常数量。
- 频道列表和设置保存在浏览器本地（localStorage），可导出为 M3U。

## 快速开始

需要 Node.js 18 及以上版本，无需安装任何依赖：

```bash
npm start
# 或者：PORT=8080 node server.js
```

打开 <http://localhost:8080>，点击 **导入频道** 上传 zip 或列表文件即可。

也可以把频道列表命名为 `channels.m3u`、`channels.txt` 或 `channels.json` 放到 `public/` 目录下，首次打开页面时会自动加载。

## 为什么需要内置服务（代理）

浏览器直接访问别人的直播源时，常因对方服务器没有开启 CORS 而被拦截。`server.js` 提供了一个轻量代理：`/proxy?url=...`，会把播放列表里的分片、子码流、密钥地址都改写为经代理访问，从而绕过跨域限制。

- 页面会自动检测代理是否可用；也可在 ⚙️ 设置中关闭。
- 如果直播源本身支持 CORS，也可以把 `public/` 目录作为纯静态网站部署（不走代理）。

### 代理安全选项（环境变量）

| 变量 | 说明 |
| --- | --- |
| `PORT` / `HOST` | 监听端口 / 地址，默认 `8080` / `0.0.0.0` |
| `ALLOWED_HOSTS` | 只允许代理这些域名，逗号分隔，支持 `*.example.com`。**部署到公网时强烈建议设置**，否则代理可被他人滥用 |
| `ALLOW_PRIVATE` | 设为 `1` 时允许代理内网地址（默认禁止，防止 SSRF）。直播源在内网时需要开启 |
| `UPSTREAM_TIMEOUT_MS` | 上游请求超时，默认 `15000` |

## 支持的列表格式

```text
# M3U / M3U8（IPTV 列表）
#EXTM3U
#EXTINF:-1 tvg-logo="http://.../logo.png" group-title="新闻",新闻频道
http://example.com/live/news/index.m3u8

# 纯文本 / CSV：每行一个地址，或 "名称,地址[,分组]"
CCTV-1,http://example.com/cctv1.m3u8
http://example.com/live/room42/index.m3u8

# "分组,#genre#" 格式
央视,#genre#
CCTV-1,http://example.com/cctv1.m3u8

# JSON
[{ "name": "频道A", "url": "http://example.com/a.m3u8", "group": "地方台" }]
```

zip 中的文件若没有写分组，会用文件名作为分组名。

## 开发

```bash
npm test   # 运行解析器与检测逻辑的单元测试
```

目录结构：

```
server.js            静态文件服务 + HLS 代理（零依赖）
public/index.html    页面
public/js/app.js     界面、预览、播放器、导入导出
public/js/monitor.js 健康检测逻辑
public/js/parser.js  频道列表与 HLS 播放列表解析
test/                单元测试
```

播放使用 [hls.js](https://github.com/video-dev/hls.js)，zip 解析使用 [JSZip](https://stuk.github.io/jszip/)，均从 jsDelivr CDN 加载。
