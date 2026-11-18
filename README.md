# 五五客厅

十个项目合成**一套服务**：搜磁力、看书、听音乐、看视频，加上下载中心、媒体库、笔记库、追更日历、相册、投屏。

对外只有一个地址、一个端口，十间屋子同源：

```
http://127.0.0.1:8890
  /magnet/     搜磁力
  /book/       书房
  /music/      听音乐
  /vod/        看视频
  /download/   下载中心
  /library/    媒体库
  /notes/      笔记库
  /calendar/   追更日历
  /photos/     相册
  /cast/       投屏
```

前四间是原来就有的（三个 Web 项目由客厅统一转发、页面里的本地绝对路径会被改写到各自前缀下；书房由客厅直接出页面）。后六间是新装的，直接跑在客厅这一个 Node 进程里：一套 `lib/<房间>.mjs` 模块 + 一份 `runtime/<房间>.json`，不开新进程、不加新端口。

## 现在有什么

| 房间 | 现在是什么 | 对外路径 | 内部端口 | 主色 |
|---|---|---|---|---|
| 搜磁力 | magnet-search，20 源聚合，边下边播 | `/magnet/` | 7788（播放器 8801） | `#7EA6E0` |
| 看书 | 客厅自带书房阅读器：多源搜索**边搜边出**、全屏沉浸阅读；Reader Web 做解析/书架引擎 | `/book/` | 1122 | `#D6A05E` |
| 听音乐 | 聆听音乐网页版，网易云 + 酷我，完整曲播放 | `/music/` | 8811 | `#DD7768` |
| 看视频 | 请看，9 个采集站；开屏是**推荐首页**（精选 + 电影/电视剧/短剧/综艺四区），点卡进详情 | `/vod/` | 8900 | `#A996DD` |
| 下载中心 | 磁力 + 直链队列，进度/速度/剩余时间，暂停、继续、删除；下完可直接播、可跳媒体库 | `/download/` | 不占 | `#5FADA8` |
| 媒体库 | 扫本地影片、豆瓣刮削（海报/年份/评分/简介）、剧集聚合、继续观看 | `/library/` | 不占 | `#9CAC69` |
| 笔记库 | 划线、随手记、标签、全文检索、导出 Markdown | `/notes/` | 不占 | `#C0B79C` |
| 追更日历 | RSS/Atom 订阅 + 手动追更 + B 站番剧表，倒计时与周视图 | `/calendar/` | 不占 | `#C489A9` |
| 相册 | 本地相片索引、缩略图（视频抽首帧）、时间轴、大图、DLNA 投屏 | `/photos/` | 不占 | `#7FB4C4` |
| 投屏 | 手机画面投到 Mac（scrcpy 5.0.1），六种预设、一键启停、录屏 | `/cast/` | 不占 | `#E0A46E` |

内部端口只给客厅用，不再是对外入口。8890 是唯一门牌。**新六间不占任何端口**。

## 它到底怎么合

- **同一条通道**：浏览器只连 8890。`/magnet`、`/music`、`/vod` 由客厅转发给各自进程；`/book` 由客厅自己出页面；后六间由客厅自己的房间模块直接处理。
- **同源路径改写**：三个 Web 项目原本都把自己的接口写成 `/api/...`、`/lib/...`、`/proxy?...` 这种根路径。客厅在返回 HTML / JS / JSON / m3u8 时，把引号或反引号紧跟的本地绝对路径改写到前缀下。
- **房间注册表**：`lib/rooms.mjs` 声明十间屋子（id、名字、主色、页面文件），把 `/<id>/` 的页面请求、`/api/<id>/...` 的接口请求分给对应的 `lib/<id>.mjs`；某间模块没落盘时只有那间房报「还没装好」，客厅照常运行。
- **统一外壳**（不改别人的项目代码）：客厅在转发三个旧前端时，给它们套同一套顶栏（`← 回客厅` + 主色圆点 + 房名）、页脚和同一套颜色/圆角/滚动条/字体；页面内部 DOM 与脚本一行不动。样式在 `public/assets/legacy-shell.css`，注入逻辑在 `lib/legacy_shell.mjs`。
- **两个注入**（不改别人的项目代码）：客厅在转发磁力页时补一个「⬇ 加入下载」按钮，在转发视频页时补一个「✎ 记一笔」按钮，两者分别打 `/api/download/add` 与 `/api/notes/create`。
- **不复制业务**：搜索、播放、下载、书源解析仍由各自项目处理；客厅负责同源、改写、状态、启停、以及这六间新房的全部逻辑。

## 用起来

- 点门 = 进屋。前四间没开的话会自动启动，等它起来再推门；后六间点门直接跳过去。
- 进了前四间的屋，顶栏可以「新窗口 / 刷新 / 停止」；后六间页面自己带一条「客厅」返回。
- 切到别的门，音乐不会停：四个 iframe 都活着。
- 首页一屏概览：杭州天气（open-meteo）、今日待办（可勾选/新增）、下载进度、最近在读、下次追更。点「下载 / 最近在读 / 下次追更」三格直接进对应房间。
- 门上的数字和状态每 8 秒刷新一次：亮着点是就绪，灰的是没开，闪的是启动中。
- 顶部「全部启动」一把叫醒三个网页服务。
- 快捷键：`1` 磁力 / `2` 书 / `3` 音乐 / `4` 影视 / `5` 下载 / `6` 媒体库 / `7` 笔记 / `8` 追更 / `9` 相册 / `0` 投屏，`Esc` 回客厅。

### 看书（书房）

1. 多源搜索改成**边搜边出**：某个书源一有命中就立刻把书追加到列表，顶部显示「已搜 N / T 个源 · 命中 M 条 · 仍在搜索中…」，搜完变成「搜索完成，共 M 条（N 个源有结果）」。
2. 追加是纯追加：不清空已有结果、不跳滚动位置、不闪屏（内部只 append，不整块重渲染）；换新关键词才允许清空。
3. **全屏阅读模式**：工具条「⛶ 全屏」或 `Esc` 切换；进入后隐藏顶栏、书架/书源面板、目录与工具条，正文居中、行宽约 38 字/行随窗口自适应；字号、纸色、夜间设置全程保留；退出后回到进入前的位置。
4. 选中正文点右下角「✎ 收笔记」会把书名、章节和原句收进笔记库。

### 下载中心

1. 顶栏「加入下载」支持两种：直链 URL（http/https）和 `magnet:?xt=urn:btih:...`。
2. 直链用 Node 自带 fetch 流式落盘：先写 `.part`，完成后原子改名；支持 `Range` 断点续传（服务器不认 Range 时自动从头下）。
3. 磁力走 npm 装的 `webtorrent`，**惰性加载**——第一次真的加磁力任务时才 import，装不上或加载失败只影响磁力，直链照常。
4. 每个任务显示进度百分比、速度（最近 5 秒滑动平均）、剩余时间、总大小、磁力还会显示节点数。
5. 暂停保留 `.part` 断点；继续重新排队（直链续传、磁力重连）；删除默认只删记录，勾选后才连文件一起删。
6. 落盘目录默认 `~/Downloads/五五下载/`（`config/download.json` 可改），重名自动加 `(1)`，绝不覆盖已有文件。
7. 已完成的任务卡片上有 **「▶ 播放」**（当前页弹层直接播，走 `/api/download/file`，支持 Range）和 **「在媒体库打开」**（跳 `/library/?focus=<路径>`，没索引过的会先解析刮削再打开详情）。
8. 重启后：进行中的任务转成「已暂停」，已完成记录保留；磁力搜索页每条结果后面的「⬇ 加入下载」也走同一个接口。

### 媒体库

1. 扫 `~/Movies`、`~/Downloads/五五下载`、`~/Downloads`（`config/library.json` 可改），识别 mp4/mkv/mov/avi/m4v/ts/webm/flv/rmvb 等。
2. 文件名解析出「片名 + 年份 + 季/集」，去豆瓣猜条目（`subject_suggest` + `subject_abstract`），拿到标题、年份、评分、类型、地区、片长、简介。
3. 海报带 `Referer` 从豆瓣图床取回，缓存在 `runtime/library/posters/<豆瓣id>.jpg`，页面走本地缓存，不热链。
4. 刮不到就如实显示「未匹配到豆瓣条目」，只展示本地大小、时长、分辨率，**不编造评分和简介**。
5. 剧集按「名称 + 季 + 集」聚合（`S01E03` / `第4集` / `EP12` 三种写法都认），详情里列出每集与已看进度。
6. 点一集用 `<video>` 内嵌播放（走 `/api/library/media`，支持 Range），每 5 秒上报一次进度；下次打开从上次位置续播，「继续观看」横条在页面顶部。
7. 路径全部校验在配置目录内，越权读写一律 403。

### 笔记库

1. 六种来源：看书（划线）、看片（随手记）、下载（随想）、听歌、相册、随手记。
2. 书房里选中正文点右下角「✎ 收笔记」→ 带书名+章节+引用存进来；视频页右上角「✎ 记一笔」→ 带片名+集数+「看到几分几秒」存进来。
3. 检索：中文按二元组切、英文按词切，标题/标签/来源/正文加权打分，命中高亮；支持按相关度/时间排序，来源与标签可叠加筛选。
4. 标签云带数量，点标签即筛；支持标签改名/合并（`/api/notes/tag/rename`）。
5. 导出 Markdown：单条、当前筛选结果、或整库；结构是「标题 → 来源+链接+时间 → 引用块 → 正文 → #标签」。

### 追更日历

1. 订阅源：默认少数派、机核、36 氪（`config/calendar.json` 可改），可增删；页面打开时距上次抓取超过 10 分钟就在后台刷新。
2. 抓取失败如实标记「抓取失败 + 原因 + 上次成功时间」（36 氪被 WAF 拦时就是这么显示的），不假装成功。
3. 番剧追更接 B 站番剧时间表 `api.bilibili.com/pgc/web/timeline`，本周哪部番几点更新一目了然，封面缓存在 `runtime/calendar/covers/`。
4. 手动追更条目支持番剧/剧集/连载书，写「每周几 + 时间」或「每 N 天」，自动算下一次更新与倒计时。
5. 周视图七列（周一到周日），未读提醒按「上次查看时间」算。

### 相册

1. 索引 `~/Downloads`、`~/Desktop`、`~/Pictures`（`config/photos.json` 可改），识别 jpg/jpeg/png/heic/webp/gif/mov/mp4/m4v。
2. 时间优先 EXIF/元数据（`ffprobe creation_time` → `sips -g creation` → 文件 mtime），并过滤 1970 纪元零值；按年月归类。
3. 缩略图用 `sips -Z 480 -s format jpeg`（失败用 ffmpeg 兜底）生成到 `runtime/photos/thumbs/`，并发上限 4，已存在则跳过；首次索引在后台跑，页面显示进度。
4. `~/Pictures/Photos Library.photoslibrary` 受系统保护读不了，会如实记进「跳过原因」，页面明说「系统相册库受保护，未索引」。
5. 大图走 `/api/photos/full`（支持 Range），←/→ 切换、Esc 关闭，底栏显示文件名/时间/尺寸/目录。
6. 视频条目的缩略图用 `ffmpeg` 抽首帧（0.5/1/3/6/20 秒逐点试，明显黑帧继续往后挑）；真抽不到就显示「▶ + 文件名 + 时长」的卡片，不会出现一块纯黑。
7. 大图预览可以点 `×`、按 `Esc`、点遮罩三种方式关闭，关闭时停掉视频、清掉 `src`，并回到原来的滚动位置。
8. 投屏走 SSDP 发现 MediaRenderer + SOAP `SetAVTransportURI`；**没设备就说没设备**，并给可复制的直链/下载原图作为降级。客厅默认只监听 127.0.0.1，电视访问不到——只有 `node hub.mjs --lan` 启动时投屏才真的能连上，页面会把这条限制和本机局域网 IP 一起标出来。

### 投屏

> 注意这跟相册的「DLNA 投屏」是两件事：相册那个是把**照片推到电视**；这一间是把**手机整块屏幕投到这台 Mac**。

1. 后端不重写参数，直接调 `~/D盘/bin/scrcpy-mac/投屏`——那份脚本已经把 Windows 那套 `.bat` 的三个毛病踩平了（`--window-aspect-ratio` 在 scrcpy 5.0.1 里根本不存在、`--crop` 的 height=0 会被拒、序列号与分辨率写死换机就错位）。客厅只负责「起哪个预设、什么时候停」。
2. 六个预设：`default` / `full` / `pro` / `crop169` / `铺满` / `视频`。`crop169` 的裁剪几何按 `adb shell wm size` 实测值算，不写死。
3. 进程是 `detached` 起的，日志落在 `runtime/cast.log`，pid 落盘 `runtime/cast.json`；客厅重启后能认回自己起的那一个，也会校验 pid 命令行里确实有 `scrcpy` 才敢杀，避免误伤手动开的窗口或 pid 复用。
4. 设备靠 `adb devices -l` 自动发现；未授权（`unauthorized`）会明确说「请在手机上点允许 USB 调试」，不会含糊地报失败。多设备可在 `POST /api/cast/start` 里传 `serial`。
5. 录屏走 `投屏 录`，默认落到 `~/Movies/scrcpy-<时间戳>.mp4`（`config/cast.json` 的 `recordDir` 可改）。
6. 页面每 3 秒刷一次状态；投屏中会自动跟日志。首页那道门的数字是「已连接设备数」，投屏时会变成「投屏中 · 预设名」。
7. 快捷键 `0` 进投屏（`1`–`9` 已被前面九间占满）。

## 端口

| 端口 | 谁在用 |
|---|---|
| 8890 | 客厅，唯一对外入口 |
| 7788 | 磁力搜索（内部） |
| 8801 | 磁力播放器（内部，按需拉起） |
| 8811 | 聆听音乐（内部） |
| 8900 | 请看（内部） |
| 1122 | Reader Web（书房解析引擎，内部） |

音乐原来占 8801，和磁力播放器默认端口撞车，导致「边下边播」起不来。现在音乐固定 8811，8801 留给播放器；磁力搜索的健康判定也兼容了播放器当前的 `{ok,data}` 信封。

## 数据落在哪

```
runtime/
├── book-sources.json        # 书源搜索缓存（自动生成，约 2.9MB）
├── home.json                # 首页待办清单
├── download.json            # 下载任务队列（含已完成记录）
├── library.json             # 影片分组、刮削缓存、播放进度
├── library/posters/         # 豆瓣海报缓存 <id>.jpg
├── notes.json               # 笔记库全部数据
├── calendar.json            # 订阅源、抓取条目、手动追更、未读游标
├── calendar/covers/         # 番剧封面缓存
├── photos.json              # 相片索引（文件、时间、缩略图 id）
└── photos/thumbs/           # 缩略图 <sha1>.jpg
```

`runtime/` 全是运行时数据，删掉不会坏，只是要重新扫/重新抓。用户的影片、照片、书库原始文件一律只读，不写、不移、不删。

## 命令

```bash
cd ~/D盘/项目/五五客厅
./hub.sh start       # 启动（已装 launchd 的话由它托管）
./hub.sh status      # 看客厅状态（十间房都在这一屏）
./hub.sh open        # 起来并打开浏览器
./hub.sh stop
./hub.sh log         # 跟日志
./hub.sh install     # 注册开机自启（com.wuwu.wuwu-living）
./hub.sh uninstall   # 取消开机自启
```

手机在同一个 Wi-Fi 下想看，可以 `./hub.sh stop && node hub.mjs --lan`，然后访问 `http://<Mac 的局域网 IP>:8890`。默认只监听本机。

## 接口

前四间沿用原来的接口（`/api/book/*` 见下），后六间统一在 `/api/<房间>/` 下：

| 房间 | 主要接口 |
|---|---|
| 下载中心 | `GET /api/download/list`、`POST /api/download/add`（`{url}` 或 `{magnet}`）、`/pause`、`/resume`、`/delete`、`/clear-done`、`GET /api/download/detail?id=` |
| 媒体库 | `GET /api/library/list`、`POST /api/library/scan`、`GET /api/library/scan-status`、`GET /api/library/detail?id=`、`GET /api/library/poster?id=`、`GET /api/library/media?path=`、`POST /api/library/progress` |
| 笔记库 | `GET /api/notes/list?q=&source=&tag=&sort=`、`POST /api/notes/create`、`/update`、`/delete`、`/tag/rename`、`GET /api/notes/stats`、`GET /api/notes/export?ids=&q=&tag=` |
| 追更日历 | `GET /api/calendar/overview`、`POST /api/calendar/feed/add`、`/feed/remove`、`/feed/refresh`、`GET /api/calendar/bangumi`、`POST /api/calendar/track/add`、`/track/update`、`/track/remove`、`/seen` |
| 投屏 | `GET /api/cast/state`、`GET /api/cast/devices`、`GET /api/cast/presets`、`POST /api/cast/start`（`{preset,serial,extra}`）、`POST /api/cast/stop`、`POST /api/cast/record`、`GET /api/cast/log?lines=` |
| 相册 | `GET /api/photos/list?month=&offset=&limit=`、`POST /api/photos/scan`、`GET /api/photos/scan-status`、`GET /api/photos/thumb?id=`、`GET /api/photos/full?id=`、`GET /api/photos/info?id=`、`POST /api/photos/dlna/discover`、`/dlna/cast` |
| 首页 | `GET /api/home/summary`（天气/待办/下载/在读/追更/十间房小结一次取全）、`GET/POST /api/home/todos` |
| 书房 | `POST /api/book/search-start`、`GET /api/book/search-status?job=`（**进行中就返回 items**，另有 `revision` / `hits` / `rawHits`，只追加不重排） |
| 视频推荐 | `GET /api/vod/recs`（精选 8 部 + 电影/电视剧/短剧/综艺四区，10 分钟缓存）、`GET /api/vod/img?u=`（海报代理 + 落盘缓存） |
| 下载播放 | `GET /api/download/file?id=`（只允许该任务自己落盘的文件，支持 Range） |
| 媒体库深链 | `GET /api/library/ensure?path=`（未索引的先解析刮削再入库） |

书房接口：`/api/book/info`、`/api/book/ensure`、`/api/book/search-start`（POST `{q}`）、`/api/book/search-status?job=`、`/api/book/search-books?q=`、`/api/book/shelf`、`/api/book/open`、`/api/book/chapter`、`/api/book/progress`。

## 改东西

- **换路径 / 换内部端口**：改 `config/apps.json` 里的 `dir`、`base`、`port`，`./hub.sh restart` 生效；对外路径是 `path`。
- **改门面**：`public/五五客厅.html`，单文件，CSS/JS 都在里面。
- **加第六、第七间新房**：在 `lib/rooms.mjs` 的 `ROOM_LIST` 加一行（id、名字、主色、页面文件），再写 `lib/<id>.mjs`（导出 `meta`、`handle(ctx)`、`summary()`、可选 `init()`）和 `public/<页面>.html`，主色在 `public/assets/room.css` 里补一条 `body[data-room="<id>"]`。`hub.mjs` 不用动。
- **改书房**：`public/书房.html` + `hub.mjs` 的书房接口。书房末尾有一段独立的「收笔记」脚本，只负责选中的句子→`/api/notes/create`，与阅读逻辑无关，可直接改那一段。
- **改多源搜索**：`lib/book_source_search.mjs` 是搜索/规则解析器；`lib/export_book_sources.py` 从 Reader 数据库导出 `runtime/book-sources.json`。
- **改音乐完整链路**：`~/Doubao/chats/2026-11-16/new-chat-1/聆听音乐网页版/server.mjs` 里的 `kuwoFullUrl()`；`kuwoPlayUrl()` 只作为 11 秒试听回落。

### 改写规则要留意

`REWRITE` 只处理**引号/反引号紧跟**的本地绝对路径（例如 `fetch('/api/x')`、`src="/lib/a.mjs"`、`"/proxy?u="`）：

```js
magnet: ['/api/', '/lib/', '/player', '/favicon.ico']
music:  ['/api/', '/assets/']
vod:    ['/api/', '/hls.min.js', '/proxy']
```

如果哪天某个项目新增了新的根路径请求（比如 `/static/...`），把它加进对应数组，否则浏览器会去 8890 根路径找，得到 404。外部 URL、绝对 http 地址不会被改。

## 文件

```
五五客厅/
├── hub.mjs                  # 单端口服务：客厅页 + 三条转发 + 书房接口 + 新房分发
├── hub.sh                   # 启停 / 自启
├── config/
│   ├── apps.json            # 四个老项目的位置、内部端口、对外路径
│   ├── download.json        # 下载目录、并发、磁力开关
│   ├── library.json         # 影片扫描目录、并发、缓存天数
│   ├── calendar.json        # 订阅源、抓取间隔
│   └── cast.json            # 投屏默认预设、scrcpy/adb 路径、录屏目录
├── lib/
│   ├── rooms.mjs            # 房间注册表 + 分发 + 首页汇总粘合
│   ├── home.mjs             # 首页：天气、待办、聚合
│   ├── download.mjs         # 下载队列（直链 fetch / 磁力 webtorrent）
│   ├── library.mjs + library_parse/douban/media.mjs  # 媒体库：扫描、解析、刮削
│   ├── notes.mjs            # 笔记库：存储、检索、导出
│   ├── calendar.mjs + calendar_feeds.mjs             # 追更日历：RSS 抓取、排期
│   ├── photos.mjs + photos_dlna.mjs                  # 相册：索引、缩略图、DLNA 投屏
│   ├── cast.mjs             # 投屏：调 scrcpy-mac 的「投屏」，管进程与设备
│   ├── reader_query.py      # 只读 Reader 数据库（书源统计/分组）
│   ├── export_book_sources.py
│   └── book_source_search.mjs
├── public/
│   ├── 五五客厅.html         # 首页（十扇门 + 一屏概览 + 舞台）
│   ├── 书房.html             # 书房阅读器（末尾带「收笔记」）
│   ├── 下载中心.html 媒体库.html 笔记库.html 追更日历.html 相册.html 投屏.html
│   └── assets/room.css       # 六间新房共用的公共样式与主色
├── runtime/                  # 运行时数据（见上）
└── README.md
```

## 排障

**某间房显示「未装好」**：看 `/tmp/wuwu-living.err.log` 里 `[rooms] 加载 xxx 失败`；多半是 `lib/<id>.mjs` 语法错误或 `runtime/<id>.json` 被写坏（写坏会被当空数据处理，不会 500）。改完 `./hub.sh restart`。

**首页有数字但某间房是「—」**：那间房的 `summary()` 抛错或没导出。日志里搜 `summary 失败`。

**下载磁力一直没速度**：先看页面上的节点数。本机 UDP/DHT 受限时磁力会很慢甚至拿不到元数据，这不影响直链下载；页面会如实显示「等待 DHT 节点」而不是假装在跑。

**媒体库刮不到**：豆瓣接口要带 UA 和 `Referer: https://movie.douban.com/`，且中文片名命中率更高。刮削结果缓存 30 天，想重刮删掉 `runtime/library.json` 里对应条目的 `scrapedAt` 或整份删掉重扫。

**相册索引很慢**：首次要生成缩略图（1070 张约几分钟），页面顶部会显示进度；缩略图生成后不再重复。`ffmpeg`/`sips` 缺失会退化为「只有原图、没有缩略图」。

**相册投屏找不到设备**：先确认客厅是不是用 `--lan` 起的（默认只听 127.0.0.1，电视访问不到）；再看电视是否支持 MediaRenderer（很多电视只支持 AirPlay/Miracast，不一定能被 DLNA 发现）。

**追更日历某源一直失败**：页面会写原因。36 氪之类上了 WAF 的站会拦非浏览器请求，属正常，换源即可。

**旧三房顶上多了一条「← 回客厅」**：那就是统一外壳。它只注入、不改三个工程内部；如果某页内容被顶栏压住，改 `public/assets/legacy-shell.css` 里对应房间的让位规则（顶栏高 46px）。

**视频推荐里有的海报是首字方块**：海报走 `/api/vod/img` 代理取图，采集站海报有防盗链或已失效时就会降级成「首字 + 渐变底」，不是坏图；缓存落在 `runtime/vod/posters/`。

**接口偶发 `ERR_HTTP_HEADERS_SENT`**：说明某个处理分支在已经发出响应之后又写了一次。`/tmp/wuwu-living-actions.log` 里会带 `hub.mjs:xxxx` 行号；现在的兜底 404 已经在写之前检查 `res.headersSent`，房间模块返回 `undefined` 也按「已处理」对待。

## 已知边界

1. **音乐完整链路依赖第三方解析 `api.fanxing.life`**，它只负责把酷我 `mobi.kuwo.cn` 的加密地址解出来。第三方接口失效时，播放器会回落到 11 秒试听并明确提示。
2. **手机 App 能免费听，不等于网页直链能免费听**。当前做法是优先找可播的免费替代源，找不到才试听。
3. **磁力下载受本机网络环境影响**：DHT/UDP 被限时只能拿到很少的节点，速度会很低甚至停在「等待 DHT 节点」。直链下载不受影响。
4. **豆瓣刮削依赖公开的 suggest/abstract 接口**，没有 key，命中率取决于片名是否规范；刮不到就显示未匹配，不编数据。
5. **相册投屏要求客厅监听局域网**（`--lan`），且电视要真的支持 DLNA MediaRenderer；否则只给直链与下载。
6. **书房多源搜索覆盖 3,359 条有搜索规则的书源，不是 7,538 条全部**；完整搜索约 60–90 秒，结果取决于当时能响应的站点。
7. **笔记库检索是二元组 + 加权打分的轻量实现**，不是倒排索引；万条量级仍然够快，再大要换存储。
