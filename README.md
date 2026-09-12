# Manga → Obsidian 漫画元数据导出 用户脚本 技术文档

## 一、基本信息

- **文件名**：`manga-obsidian.user.js`（版本号由脚本头 `@version` 维护，当前 1.8.1）
- **类型**：Tampermonkey / Greasemonkey 用户脚本
- **用途**：在浏览器漫画详情页一键提取元数据 + 封面图，导出为 Obsidian 兼容的 Markdown 文件（YAML frontmatter 格式）
- **代码量**：约 1346 行，纯 JavaScript，无外部依赖
- **运行环境**：浏览器端，通过 Tampermonkey 注入到匹配的页面

---

## 二、支持站点（8 个）

| 域名 | 适配器名 | 默认年龄 | 默认地区 | @match 模式 | 特殊说明 |
|---|---|---|---|---|---|
| bakamh.com | BakaMH | 18+ | 韩漫 | `/manga/*` | 别名字段可能繁体 |
| www.mangacopy.com | MangaCopy | 全年龄 | 日漫 | `/comic/*` | 标签含 `#` 前缀需去掉 |
| www.2026copy.com | MangaCopy | 全年龄 | 日漫 | `/comic/*` | 复用 MangaCopy 适配器 |
| komiic.com | Komiic | 全年龄 | 日漫 | `/comic/*` | 标题格式 `名称(原名)` |
| www.baozimh.com | BaoziMH | 全年龄 | (空) | `/comic/*` | 标签含地区信息需提取 |
| 18comic.vip | 18comic | 18+ | (空) | `/album/*` | 标题含 `[标签]` 需剥离 |
| manga.bilibili.com | Bilibili | 全年龄 | (空) | `/detail/*` | SPA 页面，需等 Vue 渲染；话数格式含完结标识 |
| www.webtoons.com | WEBTOON | 全年龄 | 韩漫 | `/*/list*` | 多语言路径，只显示最新 10 话 |

---

## 三、GM 权限说明

```js
// @grant    GM_xmlhttpRequest   // 跨域 HTTP 请求（下载封面图片 / 检测更新时抓取页面）
// @grant    GM.xmlHttpRequest   // 同上，新版 API 兼容
// @grant    GM_setValue         // 持久化存储（追更数据）
// @grant    GM_getValue         // 读取持久化存储
// @connect  *                   // 允许向任意域名发请求
// @run-at   document-idle       // 页面加载完成后运行
```

---

## 四、全局常量

```js
STATUS_MAP = {
    '连载': '连载', '连载中': '连载', '連載中': '连载', '連載': '连载',
    '完结': '完结', '完結': '完结', '已完结': '完结', '已完結': '完结',
    '休刊': '有生之年', '休載': '有生之年', '休载': '有生之年',
}
// 归一化到漫画库里实际使用的三种状态：完结 / 连载 / 有生之年

DEFAULT_AGE = '18+'           // 全局兜底年龄分级
COVER_DIR  = '未处理漫画'     // 封面存放目录名（md 中的封面路径前缀）
REGIONS    = ['', '日漫', '韩漫', '国漫', '港台', '欧美']  // 地区下拉选项
```

---

## 五、代码结构（按文件顺序）

```
第 1-20 行    用户脚本头（@name, @match, @grant 等）
第 22-37 行   全局常量（STATUS_MAP, DEFAULT_AGE, COVER_DIR, REGIONS）
第 39-43 行   追更存储层（TRACK_KEY, loadTracker, saveTracker, trackKey）
第 45-101 行  DOM 工具函数（text, linkTexts, parseChineseDate, getExtension, sanitizeFilename, isoDateOffset, parseRelativeDate, parseTitlePair）
第 104-168 行 BakaMH 适配器（extractBakamh, canMountBakamh, waitBakamhReady）
第 170-235 行 MangaCopy 适配器（extractMangacopy, canMountMangacopy, waitMangacopyReady）
第 237-303 行 Komiic 适配器（extractKomiic, canMountKomiic, waitKomiicReady）
第 305-371 行 BaoziMH 适配器（extractBaozimh, canMountBaozimh, waitBaozimhReady）
第 373-436 行 18comic 适配器（extract18comic, canMount18comic, waitReady18comic）
第 438-507 行 Bilibili 适配器（extractBilibili, canMountBilibili, waitBilibiliReady）
第 509-588 行 WEBTOON 适配器（extractWebtoon, canMountWebtoon, waitWebtoonReady）
第 590-627 行 各站点 parseChapters 函数（8 个，轻量话数提取，用于追更检测）
第 629-640 行 ADAPTERS 分发表（域名 → 适配器函数映射 + 默认配置）
第 642-660 行 YAML 工具函数（plain, wiki, splitMulti）
第 662-708 行 buildMarkdown() — 生成 Obsidian YAML frontmatter
第 710-760 行 下载函数（downloadBlob, downloadText, gmRequestBlob, gmRequestHtml, downloadImage）
第 762-880 行 检测更新面板（openCheckPanel）
第 882-970 行 UI 层（getTrackKey, isTracked, toggleTrack, refreshCheckBtn, mountButton）
第 972-1346 行导出弹窗（openExportDialog）+ 初始化（init）
```

---

## 六、各站点适配器详细说明

### 6.1 通用 extract() 返回格式

所有适配器的 `extract()` 返回相同结构的对象：

```js
{
    名称: string,       // 简体标题
    原名: string,       // 原文标题
    作者: string[],     // 作者数组，每人一个元素
    题材: string[],     // 标签/题材数组
    简介: string,       // 作品简介
    总话数: string,     // 数字字符串，如 "234"
    更新时间: string,   // ISO 格式 "YYYY-MM-DD" 或自然语言
    封面URL: string,    // 封面图片完整 URL
    封面扩展名: string, // "jpg" / "png" / "webp"
    是否完结: string,   // "连载" / "完结" / "有生之年" / ""（空则导出时默认"连载"）
    地区: string,       // "日漫" / "韩漫" / "国漫" 等
}
```

### 6.2 各站点 DOM 选择器

**BakaMH** (`bakamh.com`)
- 标题：`#manga-title h1`
- 别名：`.post-content_item` 中 h5 为「别名」的项
- 作者/分类/标签：同上，按 h5 文字匹配
- 状态：同上，经 STATUS_MAP 归一化
- 简介：h5 含「简介」的项的 div p
- 话数：`ul.main.version-chap > li` 的数量
- 更新时间：第一个章节的 `.chapter-release-date`
- 封面：`.summary_image img` 的 data-src / data-lazy-src / src

**MangaCopy** (`www.mangacopy.com`, `www.2026copy.com`)
- 标题：`ul > li > h6[title]` 或 `h6`
- 别名：li > span 为「別名/别名」的下一个兄弟元素
- 作者/题材/状态/更新：同上按 label 匹配
- 简介：`p.intro`
- 话数：`a[href*="/chapter/"]` 去重计数（排除 `.comicParticulars-botton`）
- 封面：img src 含 `/cover/`，去掉 `.{数字}x{数字}.{ext}` 后缀

**Komiic** (`komiic.com`)
- 标题：`h1.ComicMain__title`，格式 `名称(原名)` 需拆分
- 作者/类型/状态/更新：`dl.ComicMain__specs dt` 按文字匹配取 dd
- 题材：`.v-chip__content` 或链接文字
- 简介：无显式字段，为空
- 话数：`a[href*="/chapter/"]` 去重计数
- 封面：img src 匹配 `/comics/.../cover` 或 `komiic.com/...cover`

**BaoziMH** (`www.baozimh.com`)
- 标题：`h1.comics-detail__title`
- 作者：`h2.comics-detail__author`，按 `+` / `＋` 分割，去掉括号内容
- 标签：`.tag-list .tag`，从中提取状态标签（BZ_STATUS_TAGS）和地区（BZ_REGION_NORM）
- 简介：`p.comics-detail__desc`
- 话数：`a[href*="comic_id="]` 去重计数
- 更新时间：`.comics-detail` 内匹配中文日期
- 封面：img alt 等于标题的图片，去掉 `?` 后参数

**18comic** (`18comic.vip`)
- 标题：`h1#book-name`，去掉首尾 `[标签]`
- 作者：`[itemprop="author"][data-type="author"] a` 去重
- 题材：`[itemprop="genre"][data-type="tags"] a` 去重
- 简介：`meta[property="og:description"]`
- 话数：`.episode ul.btn-toolbar a[href*="/photo/"]` 去重计数（至少为 1）
- 更新时间：`[itemprop="datePublished"]` 取最新
- 封面：从 URL 提取 albumId，拼接 CDN URL

**Bilibili** (`manga.bilibili.com`)
- 标题：`.manga-info h1.manga-title`（注意页面 title 有后缀）
- 作者：`h2.author-name`，按 `，,／/、` 分割
- 题材：`span.manga-styles`，值为 `--` 时视为空
- 简介：`div.introduction-text`
- 话数/完结状态：`.last-update span.v-middle`
  - 连载格式：`更新至 XX 话` → 总话数=XX，是否完结=连载
  - 完结格式：`[完结] 共 XX 话` → 总话数=XX，是否完结=完结
- 更新计划：`.update-schedule span.v-middle`
- 封面：`meta[property="og:image"]`，去掉 `@\d+\w*\.\w+$` 后缀取原图

**WEBTOON** (`www.webtoons.com`)
- 标题：`h1.subj`
- 作者：`.author_area` 内的链接文字，过滤「作家資訊」
- 题材：`h2.genre`
- 简介：`meta[property="og:description"]`
- 话数：页内 `a[href*="episode_no"]` 的 `episode_no` 参数取最大值
- 更新计划：`.day_info`
- 封面：`meta[property="og:image"]`

---

## 七、追更系统

### 7.1 存储结构

```js
// GM_setValue('manga_tracker', {
//   "manga.bilibili.com/detail/mc39285": {
//     site: "manga.bilibili.com",   // 站点域名
//     url: "https://manga.bilibili.com/detail/mc39285",  // 完整 URL
//     title: "高手",                // 漫画标题
//     chapters: "234",              // 追更时的话数
//     addedAt: "2026-06-05",        // 追更日期
//     lastCheck: "2026-06-05"       // 最后检测日期（null=未检测过）
//   },
//   ...
// })
```

### 7.2 追更按钮逻辑

- 未追更时：`🔖 追更`（灰色 #6c757d）
- 已追更时：`✅ 已追更`（绿色 #28a745）
- 点击切换，追更时调用当前适配器的 `extract()` 保存元数据
- 再次点击确认后取消追更

### 7.3 检测更新逻辑

1. 弹出面板，列出所有追更漫画
2. 点击「🚀 开始检测」
3. 逐个用 `gmRequestHtml(url)` 跨域请求页面 HTML
4. 用 `DOMParser` 解析为 DOM
5. 调用对应站点的 `parseChapters(doc)` 提取最新话数
6. 与存储的话数对比：
   - ✅ 有更新（绿色）：显示 `旧 → 新`
   - ⬜ 无变化（灰色）
   - ❌ 检测失败（红色）：显示错误原因
7. 检测完成后有更新的排最前面
8. 每行有「🔗 访问」跳转和「取消追更」按钮

### 7.4 parseChapters 函数（8 个）

每个站点一个轻量函数，只提取话数，不提取其他元数据：

| 站点 | 解析方式 |
|---|---|
| BakaMH | `ul.main.version-chap > li` 数量 |
| MangaCopy | `a[href*="/chapter/"]` 去重计数 |
| Komiic | `a[href*="/chapter/"]` 去重计数 |
| BaoziMH | `a[href*="comic_id="]` 去重计数 |
| 18comic | `.episode ul.btn-toolbar a[href*="/photo/"]` 去重计数 |
| Bilibili | `.last-update span.v-middle` 正则匹配 |
| WEBTOON | `a[href*="episode_no"]` 的最大值 |

---

## 八、导出弹窗 UI

### 8.1 按钮布局

```
右下角底部：[🔖 追更]  [📥 导出 Obsidian MD]   ← 并排
右下角上方：[🔄 检测更新 (N)]                   ← 有追更时才显示
```

### 8.2 导出弹窗功能

- **字段编辑区**：名称、原名、地区（下拉）、总话数（可手动修改）
- **题材选择**：标签 chip 点击切换，全选/清空按钮
- **预览区**：实时显示生成的 Markdown
- **底部按钮**：
  - 📋 复制 MD → 剪贴板
  - 🖼 下载封面 → 下载封面图片
  - 💾 下载 MD → 下载 .md 文件
  - 📦 全部下载 → MD + 封面一起下载

---

## 九、Markdown 输出格式

```yaml
---
类型: "[[漫画]]"
名称: 恶女的变身
原名: 恶女的变身
作者:
  - "[[作者A]]"
  - "[[作者B]]"
封面: 未处理漫画/恶女的变身.jpg
阅读状态: 想读
地区: "[[韩漫]]"
题材:
  - "[[奇幻]]"
  - "[[恋爱]]"
开始阅读:
阅读进度:
总话数: 247
是否完结: 连载
评分:
年龄: 全年龄
简介: 截然不同的她们，展开精彩绝伦的宫中激斗！
更新时间: 在周二更新
---
```

### 关键规则

- 多作者/多题材自动拆分（splitMulti 处理 `,` `，` `、` `／` `/` 分隔符）
- `是否完结` 空值时默认输出 `连载`
- `年龄` 空值时使用站点 defaultAge，兜底 DEFAULT_AGE（18+）
- 封面路径格式：`未处理漫画/{sanitizeFilename(名称)}.{扩展名}`
- md 文件带 BOM（`﻿`）兼容中文
- wiki-link 格式：`"[[xxx]]"`（带双引号）

---

## 十、工具函数说明

| 函数 | 用途 |
|---|---|
| `text(el)` | 获取元素文本，合并空白 |
| `linkTexts(container)` | 获取容器内所有 `<a>` 的文本数组 |
| `parseChineseDate(s)` | 解析 `2026年6月5日` → `2026-06-05` |
| `getExtension(url)` | 从 URL 提取文件扩展名 |
| `sanitizeFilename(s)` | 替换文件名非法字符为 `_` |
| `isoDateOffset(daysAgo)` | 返回 N 天前的 ISO 日期 |
| `parseRelativeDate(s)` | 解析相对日期（3天前/2个月前等） |
| `parseTitlePair(s)` | 拆分 `名称(原名)` 格式 |
| `plain(s)` | 去换行，用于 YAML 值 |
| `wiki(s)` | 包裹为 `"[[xxx]]"` wiki-link |
| `splitMulti(arr)` | 拆分含分隔符的字符串数组 |
| `gmRequestBlob(url)` | GM 跨域请求返回 Blob |
| `gmRequestHtml(url)` | GM 跨域请求返回 HTML 文本 |
| `downloadBlob(blob, filename)` | 创建下载链接并触发 |
| `downloadText(filename, content)` | 下载文本文件（带 BOM） |
| `downloadImage(url, filename)` | 下载图片（GM 优先，fallback fetch） |

---

## 十一、注意事项

1. **SPA 页面**（Bilibili）：页面内容由 Vue/React 动态渲染，`waitReady` 需轮询等待元素出现
2. **WEBTOON 分页**：页面只显示最新 10 话，话数从 URL 参数 `episode_no` 取最大值
3. **封面下载**：优先用 `GM_xmlhttpRequest` 绕跨域限制，失败后 fallback 到 `fetch`
4. **Bilibili 封面**：og:image 带 `@500w.avif` 尺寸后缀，需去掉取原图
5. **Bilibili 话数**：连载格式 `更新至 XX 话`，完结格式 `[完结] 共 XX 话`
6. **Bilibili 反爬**：`console.log(document.documentElement.outerHTML)` 可能返回空壳，需用「网页另存为」获取完整 HTML
7. **追更数据**：存储在 Tampermonkey 的 GM_setValue 中，跨浏览器不共享
8. **检测更新**：逐个请求，有频率限制风险，大量追更时可能较慢
9. **作者拆分**：所有作者字段经 `splitMulti()` 统一拆分，确保每个作者独立一行
10. **地区选项**：导出弹窗下拉为 `['', '日漫', '韩漫', '国漫', '港台', '欧美']`

---

## 十二、新增站点模板

```js
// 1. 在脚本头添加 @match
// @match  https://newsite.com/manga/*

// 2. 实现 4 个函数
function extractNewSite() {
    const data = {};
    data.名称 = text(document.querySelector('...'));
    data.原名 = data.名称;
    data.作者 = linkTexts(document.querySelector('...'));  // 必须返回数组
    data.题材 = [...];   // 数组
    data.简介 = '...';
    data.总话数 = '...'; // 数字字符串
    data.更新时间 = '...';
    data.封面URL = '...'; // 完整 URL
    data.封面扩展名 = getExtension(data.封面URL);
    data.是否完结 = '';   // '连载'/'完结'/'有生之年'/''（空则默认连载）
    data.地区 = '';
    return data;
}
function canMountNewSite() { return !!document.querySelector('...'); }
async function waitNewSiteReady() { /* 轮询等待 */ }
function parseChaptersNewSite(doc) { /* 从 DOM 解析话数，返回 string 或 null */ }

// 3. 注册到 ADAPTERS
'newsite.com': {
    extract: extractNewSite,
    canMount: canMountNewSite,
    waitReady: waitNewSiteReady,
    label: 'NewSite',
    defaultAge: '全年龄',  // 或 '18+'
    defaultRegion: '',      // 或 '日漫'/'韩漫' 等
    parseChapters: parseChaptersNewSite,
},
```

---

## 十三、Obsidian 库配套文件

用户的 Obsidian 漫画库位于 `D:\Documents\Obsidian\Comics\`，结构：

```
Comics/
├── 漫画库/           ← 导出的 md 文件存放处
├── 未处理漫画/       ← 封面图片存放处
├── 漫画封面/
├── 漫画书架.md       ← Dataview 画廊视图（统计/筛选/搜索/卡片网格）
├── 维护工具/
│   └── 同步工具.md   ← 阅读状态同步 + 长期未更新检索
├── 标签库/
├── 模板/
└── 附件/
```

漫画库中每部漫画的 md 文件包含 YAML frontmatter，字段与脚本导出格式一致。
