// ==UserScript==
// @name         Manga → Obsidian 漫画元数据导出 (多站点)
// @namespace    https://bakamh.com/
// @version      1.8.1
// @description  在漫画详情页一键提取元数据 + 封面，导出为 Obsidian 兼容的 Markdown。支持 bakamh / mangacopy / komiic / baozimh / 18comic / bilibili / webtoons
// @author       yaarb55646
// @homepageURL  https://github.com/yaarb55646/manga-obsidian-userscript
// @supportURL   https://github.com/yaarb55646/manga-obsidian-userscript/issues
// @updateURL    https://raw.githubusercontent.com/yaarb55646/manga-obsidian-userscript/main/manga-obsidian.user.js
// @downloadURL  https://raw.githubusercontent.com/yaarb55646/manga-obsidian-userscript/main/manga-obsidian.user.js
// @match        https://bakamh.com/manga/*
// @match        https://www.mangacopy.com/comic/*
// @match        https://www.2026copy.com/comic/*
// @match        https://komiic.com/comic/*
// @match        https://www.baozimh.com/comic/*
// @match        https://18comic.vip/album/*
// @match        https://manga.bilibili.com/detail/*
// @match        https://www.webtoons.com/*/list*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STATUS_MAP = {
        '连载':   '连载中',
        '连载中': '连载中',
        '連載中': '连载中',
        '完结':   '已完结',
        '完結':   '已完结',
        '已完结': '已完结',
        '已完結': '已完结',
    };

    const DEFAULT_AGE = '18+';
    const COVER_DIR  = '未处理漫画';
    const REGIONS    = ['', '日漫', '韩漫', '国漫', '港台', '欧美'];

    // ---------- 追更存储 ----------
    const TRACK_KEY = 'manga_tracker';
    function loadTracker()  { return GM_getValue(TRACK_KEY, {}); }
    function saveTracker(o) { GM_setValue(TRACK_KEY, o); }
    function trackKey(hostname, urlPath) { return hostname + urlPath; }

    // ---------- DOM 工具 ----------
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

    function linkTexts(container) {
        if (!container) return [];
        return Array.from(container.querySelectorAll('a')).map(a => text(a)).filter(Boolean);
    }

    function parseChineseDate(s) {
        const m = (s || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (!m) return '';
        return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }

    function getExtension(url) {
        const m = (url || '').match(/\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/);
        return m ? m[1].toLowerCase() : 'jpg';
    }

    function sanitizeFilename(s) {
        return String(s).replace(/[\\\/:*?"<>|]/g, '_').trim() || 'manga';
    }

    function isoDateOffset(daysAgo) {
        const d = new Date();
        d.setDate(d.getDate() - (daysAgo || 0));
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function parseRelativeDate(s) {
        if (!s) return '';
        const t = String(s).trim();
        const iso = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
        const cn = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (cn) return `${cn[1]}-${String(cn[2]).padStart(2,'0')}-${String(cn[3]).padStart(2,'0')}`;
        if (/剛剛|刚刚|刚才|剛才/.test(t)) return isoDateOffset(0);
        const rels = [
            { re: /(\d+)\s*(?:秒|分鐘|分钟|小時|小时)/, mul: 0 },
            { re: /(\d+)\s*(?:天|日)前/,             mul: 1 },
            { re: /(\d+)\s*(?:週|周|星期)前/,         mul: 7 },
            { re: /(\d+)\s*(?:個月|个月)前/,          mul: 30 },
            { re: /(\d+)\s*年前/,                    mul: 365 },
        ];
        for (const { re, mul } of rels) {
            const m = t.match(re);
            if (m) return isoDateOffset(parseInt(m[1], 10) * mul);
        }
        return t;
    }

    function parseTitlePair(s) {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        const m = t.match(/^(.+?)\s*[\(（](.+?)[\)）]\s*$/);
        if (m) return { name: m[1].trim(), orig: m[2].trim() };
        return { name: t, orig: t };
    }

    // ---------- BakaMH 适配器 ----------
    function getItemContentBakamh(label) {
        const items = document.querySelectorAll('.post-content_item');
        for (const item of items) {
            const h5 = item.querySelector('h5');
            if (!h5) continue;
            const headingText = text(h5).replace(/[:：]\s*$/, '');
            if (headingText === label) {
                return item.querySelector('.summary-content') || item.querySelector('div:not(.summary-heading)');
            }
        }
        return null;
    }

    function extractBakamh() {
        const data = {};
        data.名称 = text(document.querySelector('#manga-title h1'));

        const alias = getItemContentBakamh('别名');
        data.原名 = text(alias) || data.名称;

        data.作者 = linkTexts(getItemContentBakamh('作者'));

        const genres = linkTexts(getItemContentBakamh('分类'));
        data.地区 = genres[0] || '';

        data.题材 = linkTexts(getItemContentBakamh('标籤') || getItemContentBakamh('标签'));

        const statusRaw = text(getItemContentBakamh('状态'));
        data.是否完结 = STATUS_MAP[statusRaw] || statusRaw;

        const summaryItem = Array.from(document.querySelectorAll('.post-content_item'))
            .find(el => el.querySelector('h5') && /简介/.test(el.querySelector('h5').textContent));
        if (summaryItem) {
            const body = summaryItem.querySelector('div p') || summaryItem.querySelector('div');
            data.简介 = text(body);
        } else {
            data.简介 = '';
        }

        const chapters = document.querySelectorAll('ul.main.version-chap > li, ul.version-chap > li');
        data.总话数 = chapters.length || '';

        const firstChapter = chapters[0];
        if (firstChapter) {
            const dateEl = firstChapter.querySelector('.chapter-release-date i')
                        || firstChapter.querySelector('.chapter-release-date');
            data.更新时间 = parseChineseDate(text(dateEl));
        } else {
            data.更新时间 = '';
        }

        const img = document.querySelector('.summary_image img');
        data.封面URL = img
            ? (img.dataset.src || img.dataset.lazySrc || img.getAttribute('data-lazy-src') || img.src || '')
            : '';
        data.封面扩展名 = getExtension(data.封面URL);
        return data;
    }

    function canMountBakamh() {
        return !!document.querySelector('#manga-title');
    }

    async function waitBakamhReady() { return true; }

    // ---------- MangaCopy 适配器 ----------
    function findInfoItemMangacopy(label) {
        const spans = document.querySelectorAll('ul > li > span');
        for (const span of spans) {
            const t = text(span).replace(/[:：]\s*$/, '');
            if (t === label) return span.nextElementSibling;
        }
        return null;
    }

    function extractMangacopy() {
        const data = {};

        const h6 = document.querySelector('ul > li > h6[title]') || document.querySelector('h6');
        const titleTrad = text(h6);
        data.原名 = titleTrad;

        const aliasEl = findInfoItemMangacopy('別名') || findInfoItemMangacopy('别名');
        const aliasRaw = text(aliasEl);
        const aliasParts = aliasRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        data.名称 = aliasParts[0] || titleTrad;

        data.作者 = linkTexts(findInfoItemMangacopy('作者'));

        const themeEl = findInfoItemMangacopy('題材') || findInfoItemMangacopy('题材');
        data.题材 = linkTexts(themeEl).map(t => t.replace(/^#/, ''));

        data.地区 = '';

        const statusEl = findInfoItemMangacopy('狀態') || findInfoItemMangacopy('状态');
        const statusRaw = text(statusEl);
        data.是否完结 = STATUS_MAP[statusRaw] || statusRaw;

        data.简介 = text(document.querySelector('p.intro'));

        const chapterLinks = [...document.querySelectorAll('a[href*="/chapter/"]')]
            .filter(a => !a.classList.contains('comicParticulars-botton'));
        const uniqueHrefs = new Set(chapterLinks.map(a => a.href));
        data.总话数 = uniqueHrefs.size || '';

        const updateEl = findInfoItemMangacopy('最後更新') || findInfoItemMangacopy('最后更新');
        data.更新时间 = text(updateEl);

        const coverImg = [...document.querySelectorAll('img')].find(img => {
            const src = img.dataset.src || img.src || '';
            return /\/cover\//.test(src);
        });
        let coverUrl = coverImg ? (coverImg.dataset.src || coverImg.src || '') : '';
        coverUrl = coverUrl.replace(/\.\d+x\d+\.(jpg|jpeg|png|webp)$/i, '');
        data.封面URL = coverUrl;
        data.封面扩展名 = getExtension(coverUrl);

        return data;
    }

    function canMountMangacopy() {
        return !!document.querySelector('p.intro') || !!document.querySelector('h6[title]');
    }

    async function waitMangacopyReady() {
        for (let i = 0; i < 30; i++) {
            const links = document.querySelectorAll('a[href*="/chapter/"]');
            if (links.length > 1) return;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // ---------- Komiic 适配器 ----------
    function findKomiicSpec(label) {
        const dts = document.querySelectorAll('dl.ComicMain__specs dt');
        for (const dt of dts) {
            if (text(dt) === label) return dt.nextElementSibling;
        }
        return null;
    }

    function extractKomiic() {
        const data = {};

        const h1 = document.querySelector('h1.ComicMain__title') || document.querySelector('h1');
        const pair = parseTitlePair(text(h1));
        data.名称 = pair.name;
        data.原名 = pair.orig;

        const authorEl = findKomiicSpec('作者');
        data.作者 = linkTexts(authorEl);

        const typeEl = findKomiicSpec('类型') || findKomiicSpec('類型');
        if (typeEl) {
            data.题材 = [...typeEl.querySelectorAll('.v-chip__content')]
                .map(el => text(el)).filter(Boolean);
            if (!data.题材.length) data.题材 = linkTexts(typeEl);
        } else {
            data.题材 = [];
        }

        const statusEl = findKomiicSpec('状态') || findKomiicSpec('狀態');
        const statusRaw = text(statusEl?.querySelector('.v-chip__content')) || text(statusEl);
        data.是否完结 = STATUS_MAP[statusRaw] || statusRaw;

        const updateEl = findKomiicSpec('更新');
        data.更新时间 = parseRelativeDate(text(updateEl));

        data.简介 = '';

        const chapterLinks = [...document.querySelectorAll('a[href*="/chapter/"]')];
        const uniqueHrefs = new Set(chapterLinks.map(a => a.href));
        data.总话数 = uniqueHrefs.size || '';

        data.地区 = '';

        const coverImg = [...document.querySelectorAll('img')].find(img => {
            const src = img.src || '';
            return /\/comics\/[^\/]+\/cover/.test(src) || /komiic\.com\/.*cover/i.test(src);
        });
        const coverUrl = coverImg ? coverImg.src : '';
        data.封面URL = coverUrl;
        data.封面扩展名 = getExtension(coverUrl);

        return data;
    }

    function canMountKomiic() {
        return !!document.querySelector('h1.ComicMain__title') || !!document.querySelector('dl.ComicMain__specs');
    }

    async function waitKomiicReady() {
        for (let i = 0; i < 30; i++) {
            const ready = document.querySelector('dl.ComicMain__specs dt')
                       && document.querySelectorAll('a[href*="/chapter/"]').length > 1;
            if (ready) return;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // ---------- BaoziMH 适配器 ----------
    const BZ_STATUS_TAGS = ['連載中', '連載', '连载中', '连载', '已完結', '完結', '已完结', '完结'];
    const BZ_REGION_NORM = {
        '國漫': '国漫', '国漫': '国漫',
        '日漫': '日漫',
        '韓漫': '韩漫', '韩漫': '韩漫',
        '港漫': '港漫',
        '臺漫': '台漫', '台漫': '台漫',
        '美漫': '美漫',
        '歐美': '欧美', '欧美': '欧美',
    };

    function extractBaozimh() {
        const data = {};

        const titleRaw = text(document.querySelector('h1.comics-detail__title'));
        data.名称 = titleRaw;
        data.原名 = titleRaw;

        const authorRaw = text(document.querySelector('h2.comics-detail__author'));
        data.作者 = authorRaw.split(/[+＋]/)
            .map(s => s.replace(/[（(][^（()）]*[)）]/g, '').trim())
            .filter(Boolean);

        const tags = [...document.querySelectorAll('.tag-list .tag')].map(t => text(t));
        let statusTag = '', regionTag = '';
        const themeTags = [];
        for (const tag of tags) {
            if (!statusTag && BZ_STATUS_TAGS.includes(tag)) { statusTag = tag; continue; }
            if (!regionTag && BZ_REGION_NORM[tag])         { regionTag = BZ_REGION_NORM[tag]; continue; }
            themeTags.push(tag);
        }
        data.是否完结 = STATUS_MAP[statusTag] || statusTag;
        data.地区 = regionTag;
        data.题材 = themeTags;

        data.简介 = text(document.querySelector('p.comics-detail__desc') || document.querySelector('.comics-detail__desc'));

        const chapterLinks = [...document.querySelectorAll('a[href*="comic_id="]')];
        const uniqueHrefs = new Set(chapterLinks.map(a => a.href));
        data.总话数 = uniqueHrefs.size || '';

        const dateScope = document.querySelector('.comics-detail') || document.body;
        const dateMatch = dateScope.textContent.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        data.更新时间 = dateMatch
            ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`
            : '';

        const coverImg = [...document.querySelectorAll('img')].find(i => (i.getAttribute('alt') || '').trim() === titleRaw);
        let coverUrl = coverImg ? (coverImg.src || coverImg.getAttribute('src') || '') : '';
        coverUrl = coverUrl.replace(/\?.*$/, '');
        data.封面URL = coverUrl;
        data.封面扩展名 = getExtension(coverUrl);

        return data;
    }

    function canMountBaozimh() {
        return !!document.querySelector('h1.comics-detail__title');
    }

    async function waitBaozimhReady() {
        for (let i = 0; i < 20; i++) {
            if (document.querySelector('h1.comics-detail__title') && document.querySelector('.tag-list .tag')) return;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // ---------- 18comic 适配器 ----------
    function extract18comic() {
        const data = {};

        const titleRaw = text(document.querySelector('h1#book-name'));
        const firstBracket = titleRaw.indexOf('[');
        const lastBracket  = titleRaw.lastIndexOf(']');
        if (firstBracket > 0 && lastBracket > firstBracket) {
            data.名称 = titleRaw.slice(0, firstBracket).trim();
            const orig = titleRaw.slice(lastBracket + 1).trim();
            data.原名 = orig || data.名称;
        } else {
            data.名称 = titleRaw;
            data.原名 = titleRaw;
        }

        const authorEls = document.querySelectorAll('[itemprop="author"][data-type="author"] a');
        const authorSet = new Set([...authorEls].map(a => text(a)).filter(Boolean));
        data.作者 = [...authorSet];

        const tagEls = document.querySelectorAll('[itemprop="genre"][data-type="tags"] a');
        const tagSet = new Set([...tagEls].map(a => text(a)).filter(Boolean));
        data.题材 = [...tagSet];

        const ogDesc = document.querySelector('meta[property="og:description"]');
        data.简介 = ogDesc ? (ogDesc.getAttribute('content') || '').trim() : '';

        let lastDate = '';
        document.querySelectorAll('[itemprop="datePublished"]').forEach(el => {
            const v = (el.getAttribute('content') || '').trim();
            if (v && v > lastDate) lastDate = v;
        });
        data.更新时间 = lastDate;

        const chapterLinks = [...document.querySelectorAll('.episode ul.btn-toolbar a[href*="/photo/"]')];
        const uniqueHrefs = new Set(chapterLinks.map(a => a.href));
        data.总话数 = uniqueHrefs.size || 1;

        const albumId = (location.pathname.match(/\/album\/(\d+)/) || [])[1] || '';
        let coverUrl = '';
        if (albumId) {
            const img = document.querySelector(`img[src*="/media/albums/${albumId}"]`);
            coverUrl = img ? (img.getAttribute('src') || '') : `https://cdn-msp.18comic.vip/media/albums/${albumId}.jpg`;
            coverUrl = coverUrl.replace(/\?.*$/, '');
        }
        data.封面URL = coverUrl;
        data.封面扩展名 = getExtension(coverUrl);

        data.是否完结 = '';
        data.地区 = '';

        return data;
    }

    function canMount18comic() {
        return !!document.querySelector('h1#book-name');
    }

    async function waitReady18comic() {
        for (let i = 0; i < 20; i++) {
            if (document.querySelector('h1#book-name') && document.querySelector('[itemprop="author"][data-type="author"]')) return;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // ---------- Bilibili 适配器 ----------
    function extractBilibili() {
        const data = {};

        // 标题：取 manga-info 内的 h1（非页面 title）
        const infoBlock = document.querySelector('.manga-info') || document.body;
        const titleEl = infoBlock.querySelector('h1.manga-title');
        data.名称 = text(titleEl);
        data.原名 = data.名称;

        // 作者：格式为 "作者名，出版社" 或 "作者A / 作者B"
        const authorEl = infoBlock.querySelector('h2.author-name');
        const authorRaw = text(authorEl);
        data.作者 = authorRaw.split(/[，,／/、]/).map(s => s.trim()).filter(Boolean);

        // 题材标签
        const styleEl = infoBlock.querySelector('span.manga-styles');
        const styleRaw = text(styleEl);
        if (styleRaw && styleRaw !== '--') {
            data.题材 = styleRaw.split(/[,，、\/]/).map(s => s.trim()).filter(Boolean);
        } else {
            data.题材 = [];
        }

        // 简介
        const introEl = document.querySelector('div.introduction-text');
        data.简介 = text(introEl);

        // 话数与完结状态：连载格式 "更新至 XX 话"，完结格式 "[完结] 共 XX 话"
        const lastUpdateEl = infoBlock.querySelector('.last-update span.v-middle');
        const lastUpdateRaw = text(lastUpdateEl);
        let chMatch = lastUpdateRaw.match(/\[完结\]\s*共\s*(\S+)\s*话/);
        if (chMatch) {
            data.总话数 = chMatch[1];
            data.是否完结 = '已完结';
        } else {
            chMatch = lastUpdateRaw.match(/更新至\s*(\S+)\s*话/);
            data.总话数 = chMatch ? chMatch[1] : '';
            data.是否完结 = '连载中';
        }

        // 更新时间 / 更新计划
        const scheduleEl = infoBlock.querySelector('.update-schedule span.v-middle');
        data.更新时间 = text(scheduleEl);

        // 封面：优先用 og:image，去掉 @ 尺寸后缀（保留扩展名）
        const ogImg = document.querySelector('meta[property="og:image"]');
        let coverUrl = ogImg ? (ogImg.getAttribute('content') || '') : '';
        coverUrl = coverUrl.replace(/@\d+\w*\.\w+$/, '');
        data.封面URL = coverUrl;
        data.封面扩展名 = getExtension(coverUrl);

        // 地区：Bilibili 无显式字段
        data.地区 = '';

        return data;
    }

    function canMountBilibili() {
        return !!document.querySelector('.manga-info h1.manga-title');
    }

    async function waitBilibiliReady() {
        for (let i = 0; i < 30; i++) {
            const title = document.querySelector('.manga-info h1.manga-title');
            const author = document.querySelector('.manga-info h2.author-name');
            if (title && author && text(title)) return;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // ---------- WEBTOON 适配器 ----------
    function extractWebtoon() {
        const data = {};

        // 标题
        const titleEl = document.querySelector('h1.subj');
        data.名称 = text(titleEl);
        data.原名 = data.名称;

        // 作者：只取链接文字，去掉「作家資訊」按钮
        const authorArea = document.querySelector('.author_area');
        const authorNames = authorArea
            ? [...authorArea.querySelectorAll('a:not([class]), a[href*="creator"], a[href*="author"]')]
                .map(a => text(a))
                .filter(t => t && !/作家資訊|作者資訊|Creator Info/i.test(t))
            : [];
        // 如果没找到链接，回退取第一个文本节点
        if (!authorNames.length && authorArea) {
            const first = authorArea.childNodes[0];
            if (first && first.textContent) {
                const raw = first.textContent.replace(/\s+/g, ' ').trim();
                if (raw && !/作家資訊/.test(raw)) authorNames.push(raw);
            }
        }
        data.作者 = authorNames.length ? authorNames : [];

        // 题材
        const genreEl = document.querySelector('h2.genre');
        const genreRaw = text(genreEl);
        data.题材 = genreRaw ? [genreRaw] : [];

        // 简介
        const ogDesc = document.querySelector('meta[property="og:description"]');
        data.简介 = ogDesc ? (ogDesc.getAttribute('content') || '').trim() : '';

        // 话数：从页内 episode_no 参数取最大值
        const epNos = [...document.querySelectorAll('a[href*="episode_no"]')]
            .map(a => {
                const m = (a.getAttribute('href') || '').match(/episode_no=(\d+)/);
                return m ? parseInt(m[1], 10) : 0;
            })
            .filter(n => n > 0);
        data.总话数 = epNos.length ? String(Math.max(...epNos)) : '';

        // 更新计划
        const scheduleEl = document.querySelector('.day_info');
        data.更新时间 = text(scheduleEl);

        // 封面
        const ogImg = document.querySelector('meta[property="og:image"]');
        data.封面URL = ogImg ? (ogImg.getAttribute('content') || '') : '';
        data.封面扩展名 = getExtension(data.封面URL);

        data.是否完结 = '';
        data.地区 = '';

        return data;
    }

    function canMountWebtoon() {
        return !!document.querySelector('h1.subj') && !!document.querySelector('.author_area');
    }

    async function waitWebtoonReady() {
        for (let i = 0; i < 30; i++) {
            if (document.querySelector('h1.subj') && document.querySelector('a[href*="episode_no"]')) return;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    function parseChaptersWebtoon(doc) {
        const links = [...doc.querySelectorAll('a[href*="episode_no"]')];
        const nums = links.map(a => {
            const m = (a.getAttribute('href') || '').match(/episode_no=(\d+)/);
            return m ? parseInt(m[1], 10) : 0;
        }).filter(n => n > 0);
        return nums.length ? String(Math.max(...nums)) : null;
    }

    // ---------- 各站点 parseChapters（轻量话数提取，用于追更检测） ----------
    function parseChaptersBakamh(doc) {
        const lis = doc.querySelectorAll('ul.main.version-chap > li, ul.version-chap > li');
        return lis.length ? String(lis.length) : null;
    }

    function parseChaptersMangacopy(doc) {
        const links = [...doc.querySelectorAll('a[href*="/chapter/"]')]
            .filter(a => !a.classList.contains('comicParticulars-botton'));
        const unique = new Set(links.map(a => a.getAttribute('href') || a.href));
        return unique.size ? String(unique.size) : null;
    }

    function parseChaptersKomiic(doc) {
        const links = [...doc.querySelectorAll('a[href*="/chapter/"]')];
        const unique = new Set(links.map(a => a.getAttribute('href') || a.href));
        return unique.size ? String(unique.size) : null;
    }

    function parseChaptersBaozimh(doc) {
        const links = [...doc.querySelectorAll('a[href*="comic_id="]')];
        const unique = new Set(links.map(a => a.getAttribute('href') || a.href));
        return unique.size ? String(unique.size) : null;
    }

    function parseChapters18comic(doc) {
        const links = [...doc.querySelectorAll('.episode ul.btn-toolbar a[href*="/photo/"]')];
        const unique = new Set(links.map(a => a.getAttribute('href') || a.href));
        return unique.size ? String(unique.size) : null;
    }

    function parseChaptersBilibili(doc) {
        const el = doc.querySelector('.last-update span.v-middle');
        if (!el) return null;
        const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
        let m = raw.match(/\[完结\]\s*共\s*(\S+)\s*话/);
        if (m) return m[1];
        m = raw.match(/更新至\s*(\S+)\s*话/);
        return m ? m[1] : null;
    }

    // ---------- 适配器分发 ----------
    const ADAPTERS = {
        'bakamh.com':        { extract: extractBakamh,    canMount: canMountBakamh,    waitReady: waitBakamhReady,    label: 'BakaMH',    defaultAge: '18+',    defaultRegion: '韩漫', parseChapters: parseChaptersBakamh },
        'www.mangacopy.com': { extract: extractMangacopy, canMount: canMountMangacopy, waitReady: waitMangacopyReady, label: 'MangaCopy', defaultAge: '全年龄', defaultRegion: '日漫', parseChapters: parseChaptersMangacopy },
        'www.2026copy.com':  { extract: extractMangacopy, canMount: canMountMangacopy, waitReady: waitMangacopyReady, label: 'MangaCopy', defaultAge: '全年龄', defaultRegion: '日漫', parseChapters: parseChaptersMangacopy },
        'komiic.com':        { extract: extractKomiic,    canMount: canMountKomiic,    waitReady: waitKomiicReady,    label: 'Komiic',    defaultAge: '全年龄', defaultRegion: '日漫', parseChapters: parseChaptersKomiic },
        'www.baozimh.com':   { extract: extractBaozimh,   canMount: canMountBaozimh,   waitReady: waitBaozimhReady,   label: 'BaoziMH',   defaultAge: '全年龄', defaultRegion: '',    parseChapters: parseChaptersBaozimh },
        '18comic.vip':       { extract: extract18comic,   canMount: canMount18comic,   waitReady: waitReady18comic,   label: '18comic',   defaultAge: '18+',    defaultRegion: '',    parseChapters: parseChapters18comic },
        'manga.bilibili.com':{ extract: extractBilibili,  canMount: canMountBilibili,  waitReady: waitBilibiliReady,  label: 'Bilibili',  defaultAge: '全年龄', defaultRegion: '',    parseChapters: parseChaptersBilibili },
        'www.webtoons.com': { extract: extractWebtoon,   canMount: canMountWebtoon,   waitReady: waitWebtoonReady,   label: 'WEBTOON',  defaultAge: '全年龄', defaultRegion: '韩漫', parseChapters: parseChaptersWebtoon },
    };
    const currentAdapter = () => ADAPTERS[location.hostname];

    // ---------- YAML 生成 ----------
    function plain(s) {
        if (s == null) return '';
        return String(s).replace(/\r?\n/g, ' ').trim();
    }

    function wiki(s) {
        return `"[[${plain(s)}]]"`;
    }

    // 拆分 "A,B" / "A，B" / "A / B" 为独立数组元素
    function splitMulti(arr) {
        if (!Array.isArray(arr)) return [];
        const result = [];
        arr.forEach(item => {
            String(item).split(/[,，、／\/]/).map(s => s.trim()).filter(Boolean).forEach(s => result.push(s));
        });
        return result;
    }

    function buildMarkdown(d, overrides, selectedTags) {
        const tags   = Array.isArray(selectedTags) ? selectedTags : d.题材;
        const name   = overrides?.名称   ?? d.名称;
        const orig   = overrides?.原名   ?? d.原名;
        const region = overrides?.地区   ?? d.地区;
        const total  = overrides?.总话数 ?? d.总话数;

        const lines = [];
        lines.push('---');
        lines.push(`类型: "[[漫画]]"`);
        lines.push(`名称: ${plain(name)}`);
        lines.push(`原名: ${plain(orig)}`);

        const authors = splitMulti(d.作者);
        if (authors.length) {
            lines.push(`作者:`);
            authors.forEach(a => lines.push(`  - ${wiki(a)}`));
        } else {
            lines.push(`作者: `);
        }

        const coverPath = name
            ? `${COVER_DIR}/${sanitizeFilename(name)}.${d.封面扩展名 || 'jpg'}`
            : '';
        lines.push(`封面: ${coverPath}`);
        lines.push(`阅读状态: 想读`);
        lines.push(`地区: ${region ? wiki(region) : ''}`);

        if (tags && tags.length) {
            lines.push(`题材:`);
            tags.forEach(t => lines.push(`  - ${wiki(t)}`));
        } else {
            lines.push(`题材: `);
        }

        lines.push(`开始阅读: `);
        lines.push(`阅读进度: `);
        lines.push(`总话数: ${plain(total)}`);
        lines.push(`是否完结: ${plain(d.是否完结) || '连载'}`);
        lines.push(`评分: `);
        lines.push(`年龄: ${plain(d.年龄) || DEFAULT_AGE}`);
        lines.push(`简介: ${plain(d.简介)}`);
        lines.push(`更新时间: ${plain(d.更新时间)}`);
        lines.push('---');
        lines.push('');
        return lines.join('\n');
    }

    // ---------- 下载 ----------
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    function downloadText(filename, content) {
        const blob = new Blob(['﻿' + content], { type: 'text/markdown;charset=utf-8' });
        downloadBlob(blob, filename);
    }

    function gmRequestBlob(url) {
        return new Promise((resolve, reject) => {
            const xhr = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
                      || (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);
            if (!xhr) { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
            xhr({
                method: 'GET',
                url,
                responseType: 'blob',
                onload: r => {
                    if (r.status >= 200 && r.status < 300) resolve(r.response);
                    else reject(new Error('HTTP ' + r.status));
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }

    async function downloadImage(url, filename) {
        let blob;
        try {
            blob = await gmRequestBlob(url);
        } catch (e) {
            const resp = await fetch(url, { credentials: 'omit' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            blob = await resp.blob();
        }
        downloadBlob(blob, filename);
    }

    function gmRequestHtml(url) {
        return new Promise((resolve, reject) => {
            const xhr = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
                      || (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);
            if (!xhr) { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
            xhr({
                method: 'GET',
                url,
                onload: r => {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject(new Error('HTTP ' + r.status));
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }

    // ---------- 检测更新面板 ----------
    async function openCheckPanel() {
        const tracker = loadTracker();
        const entries = Object.entries(tracker);
        if (!entries.length) { alert('没有追更的漫画'); return; }

        const mask = document.createElement('div');
        mask.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.65);
            z-index: 1000000; display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, "Microsoft YaHei", sans-serif;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: #ffffff; width: 92%; max-width: 800px; max-height: 85vh;
            display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
            box-shadow: 0 16px 64px rgba(0,0,0,0.5); color: #111;
        `;

        // 头部
        const head = document.createElement('div');
        head.style.cssText = `
            padding: 16px 24px; background: #2c2c34; color: #ffffff;
            display: flex; justify-content: space-between; align-items: center;
        `;
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 17px; font-weight: 700;';
        title.textContent = `🔄 检测更新（共 ${entries.length} 部）`;
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'background:transparent;color:#fff;border:none;font-size:22px;cursor:pointer;padding:0 6px;';
        closeBtn.onclick = () => mask.remove();
        head.appendChild(title);
        head.appendChild(closeBtn);

        // 列表区
        const list = document.createElement('div');
        list.style.cssText = 'flex:1; overflow-y:auto; padding: 16px 24px;';

        // 底部
        const foot = document.createElement('div');
        foot.style.cssText = 'padding: 12px 24px; background:#ececf2; border-top:1px solid #ccc; display:flex; justify-content:space-between; align-items:center;';
        const statusText = document.createElement('div');
        statusText.style.cssText = 'font-size:13px; color:#444;';
        statusText.textContent = '点击「开始检测」逐个检查更新...';
        const startBtn = document.createElement('button');
        startBtn.textContent = '🚀 开始检测';
        startBtn.style.cssText = 'padding:10px 20px; background:#17a2b8; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:700; cursor:pointer;';
        foot.appendChild(statusText);
        foot.appendChild(startBtn);

        box.appendChild(head);
        box.appendChild(list);
        box.appendChild(foot);
        mask.appendChild(box);
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        document.body.appendChild(mask);

        // 构建列表项
        const items = [];
        for (const [key, entry] of entries) {
            const row = document.createElement('div');
            row.style.cssText = `
                display: flex; align-items: center; gap: 12px;
                padding: 12px 16px; margin-bottom: 8px;
                background: #f8f9fa; border-radius: 8px; border: 1px solid #e0e0e0;
            `;

            const info = document.createElement('div');
            info.style.cssText = 'flex:1; min-width:0;';
            const nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-size:15px; font-weight:700; color:#222; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
            nameEl.textContent = entry.title;
            const metaEl = document.createElement('div');
            metaEl.style.cssText = 'font-size:12px; color:#888; margin-top:4px;';
            metaEl.textContent = `${entry.site} · 话数: ${entry.chapters || '未知'}`;
            info.appendChild(nameEl);
            info.appendChild(metaEl);

            const statusEl = document.createElement('div');
            statusEl.style.cssText = 'font-size:13px; font-weight:600; min-width:120px; text-align:center;';
            statusEl.textContent = '等待检测';
            statusEl.style.color = '#999';

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex; gap:6px;';

            const jumpBtn = document.createElement('button');
            jumpBtn.textContent = '🔗 访问';
            jumpBtn.style.cssText = 'padding:5px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; font-size:12px; cursor:pointer; color:#333;';
            jumpBtn.onclick = () => window.open(entry.url, '_blank');

            const unfollowBtn = document.createElement('button');
            unfollowBtn.textContent = '取消追更';
            unfollowBtn.style.cssText = 'padding:5px 10px; background:#fff; border:1px solid #dc3545; border-radius:4px; font-size:12px; cursor:pointer; color:#dc3545;';
            unfollowBtn.onclick = () => {
                const t = loadTracker();
                delete t[key];
                saveTracker(t);
                row.remove();
                refreshCheckBtn();
                title.textContent = `🔄 检测更新（共 ${Object.keys(loadTracker()).length} 部）`;
                if (!Object.keys(loadTracker()).length) mask.remove();
            };

            actions.appendChild(jumpBtn);
            actions.appendChild(unfollowBtn);
            row.appendChild(info);
            row.appendChild(statusEl);
            row.appendChild(actions);
            list.appendChild(row);

            items.push({ key, entry, statusEl, row });
        }

        // 开始检测
        startBtn.onclick = async () => {
            startBtn.disabled = true;
            startBtn.textContent = '检测中...';
            startBtn.style.background = '#6c757d';
            let updated = 0, failed = 0, unchanged = 0;

            for (const item of items) {
                const { entry, statusEl, row } = item;
                statusEl.textContent = '⏳ 检测中...';
                statusEl.style.color = '#999';

                // 找到对应站点的 parseChapters
                const hostname = entry.site;
                const adapter = ADAPTERS[hostname];
                if (!adapter || !adapter.parseChapters) {
                    statusEl.textContent = '❌ 不支持';
                    statusEl.style.color = '#dc3545';
                    failed++;
                    statusText.textContent = `检测中... ✅${updated} ⬜${unchanged} ❌${failed}`;
                    continue;
                }

                try {
                    const html = await gmRequestHtml(entry.url);
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    const newChapters = adapter.parseChapters(doc);

                    if (newChapters === null) {
                        statusEl.textContent = '❌ 解析失败';
                        statusEl.style.color = '#dc3545';
                        failed++;
                    } else if (newChapters !== entry.chapters) {
                        statusEl.textContent = `✅ ${entry.chapters} → ${newChapters}`;
                        statusEl.style.color = '#28a745';
                        row.style.borderColor = '#28a745';
                        row.style.background = '#f0fff4';
                        updated++;
                        // 更新存储
                        const t = loadTracker();
                        if (t[item.key]) {
                            t[item.key].chapters = newChapters;
                            t[item.key].lastCheck = isoDateOffset(0);
                            saveTracker(t);
                        }
                    } else {
                        statusEl.textContent = `⬜ 无变化 (${entry.chapters})`;
                        statusEl.style.color = '#999';
                        unchanged++;
                        const t = loadTracker();
                        if (t[item.key]) {
                            t[item.key].lastCheck = isoDateOffset(0);
                            saveTracker(t);
                        }
                    }
                } catch (e) {
                    statusEl.textContent = `❌ ${e.message}`;
                    statusEl.style.color = '#dc3545';
                    row.style.borderColor = '#dc3545';
                    row.style.background = '#fff5f5';
                    failed++;
                }

                statusText.textContent = `检测中... ✅${updated} ⬜${unchanged} ❌${failed}`;
            }

            // 有更新的排前面
            items.sort((a, b) => {
                const order = s => s.startsWith('✅') ? 0 : s.startsWith('❌') ? 2 : 1;
                return order(a.statusEl.textContent) - order(b.statusEl.textContent);
            });
            items.forEach(i => list.appendChild(i.row));

            startBtn.textContent = '✅ 检测完成';
            startBtn.style.background = '#28a745';
            statusText.textContent = `完成！✅ 有更新 ${updated}  ·  ⬜ 无变化 ${unchanged}  ·  ❌ 失败 ${failed}`;
            refreshCheckBtn();
        };
    }

    // ---------- UI ----------
    function getTrackKey() {
        return trackKey(location.hostname, location.pathname);
    }

    function isTracked() {
        const tracker = loadTracker();
        return !!tracker[getTrackKey()];
    }

    function toggleTrack(btn) {
        const tracker = loadTracker();
        const key = getTrackKey();
        if (tracker[key]) {
            // 取消追更
            delete tracker[key];
            saveTracker(tracker);
            btn.textContent = '🔖 追更';
            btn.style.background = '#6c757d';
        } else {
            // 追更
            const adapter = currentAdapter();
            let data;
            try { data = adapter.extract(); } catch (e) { alert('提取失败：' + e.message); return; }
            tracker[key] = {
                site: location.hostname,
                url: location.href,
                title: data.名称 || data.原名 || '未知',
                chapters: String(data.总话数 || ''),
                addedAt: isoDateOffset(0),
                lastCheck: null,
            };
            saveTracker(tracker);
            btn.textContent = '✅ 已追更';
            btn.style.background = '#28a745';
        }
        refreshCheckBtn();
    }

    function refreshCheckBtn() {
        const checkBtn = document.getElementById('__manga_check_btn');
        if (!checkBtn) return;
        const tracker = loadTracker();
        const count = Object.keys(tracker).length;
        checkBtn.style.display = count > 0 ? '' : 'none';
        checkBtn.textContent = count > 0 ? `🔄 检测更新 (${count})` : '🔄 检测更新';
    }

    function mountButton() {
        if (document.getElementById('__manga_export_btn')) return;

        const BASE_BTN = `
            position: fixed; z-index: 999999;
            padding: 12px 20px; color: #ffffff;
            border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
            cursor: pointer; box-shadow: 0 6px 16px rgba(0,0,0,0.35);
            font-family: -apple-system, "Microsoft YaHei", sans-serif;
        `;

        // 导出按钮
        const btn = document.createElement('button');
        btn.id = '__manga_export_btn';
        btn.textContent = '📥 导出 Obsidian MD';
        btn.style.cssText = BASE_BTN + 'right: 24px; bottom: 24px; background: #5B4ED1;';
        btn.addEventListener('mouseenter', () => btn.style.background = '#4636B8');
        btn.addEventListener('mouseleave', () => btn.style.background = '#5B4ED1');
        btn.addEventListener('click', openExportDialog);
        document.body.appendChild(btn);

        // 追更按钮
        const trackBtn = document.createElement('button');
        trackBtn.id = '__manga_track_btn';
        const tracked = isTracked();
        trackBtn.textContent = tracked ? '✅ 已追更' : '🔖 追更';
        trackBtn.style.cssText = BASE_BTN + `right: 220px; bottom: 24px; background: ${tracked ? '#28a745' : '#6c757d'};`;
        trackBtn.addEventListener('mouseenter', () => { if (!isTracked()) trackBtn.style.background = '#5a6268'; });
        trackBtn.addEventListener('mouseleave', () => { trackBtn.style.background = isTracked() ? '#28a745' : '#6c757d'; });
        trackBtn.addEventListener('click', () => toggleTrack(trackBtn));
        document.body.appendChild(trackBtn);

        // 检测更新按钮
        const checkBtn = document.createElement('button');
        checkBtn.id = '__manga_check_btn';
        checkBtn.style.cssText = BASE_BTN + 'right: 24px; bottom: 72px; background: #17a2b8; font-size: 13px; padding: 8px 14px;';
        checkBtn.addEventListener('mouseenter', () => checkBtn.style.background = '#138496');
        checkBtn.addEventListener('mouseleave', () => checkBtn.style.background = '#17a2b8');
        checkBtn.addEventListener('click', openCheckPanel);
        document.body.appendChild(checkBtn);
        refreshCheckBtn();
    }

    async function openExportDialog() {
        const adapter = currentAdapter();
        if (!adapter) { alert('当前站点未适配'); return; }

        const btn = document.getElementById('__manga_export_btn');
        const oldText = btn?.textContent;
        if (btn) btn.textContent = '⏳ 加载中...';
        try { await adapter.waitReady(); } catch (e) { /* ignore */ }
        if (btn) btn.textContent = oldText;

        let data;
        try { data = adapter.extract(); }
        catch (e) { alert('提取失败：' + e.message); return; }
        if (!data.名称 && !data.原名) { alert('未能提取漫画名称，页面结构可能变了'); return; }

        data.年龄 = adapter.defaultAge || DEFAULT_AGE;
        if (!data.地区 && adapter.defaultRegion) data.地区 = adapter.defaultRegion;

        const overrides = {
            名称:   data.名称,
            原名:   data.原名,
            地区:   data.地区,
            总话数: data.总话数,
        };
        const selectedTags = new Set(data.题材);

        const mask = document.createElement('div');
        mask.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.65);
            z-index: 1000000; display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, "Microsoft YaHei", sans-serif;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: #ffffff; width: 92%; max-width: 1100px; max-height: 92vh;
            display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
            box-shadow: 0 16px 64px rgba(0,0,0,0.5); color: #111;
        `;

        // 头部
        const head = document.createElement('div');
        head.style.cssText = `
            padding: 16px 24px; background: #2c2c34; color: #ffffff;
            display: flex; justify-content: space-between; align-items: center;
        `;
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 17px; font-weight: 700;';
        title.textContent = `导出预览 [${adapter.label}] — ${data.名称 || data.原名}`;
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'background:transparent;color:#fff;border:none;font-size:22px;cursor:pointer;padding:0 6px;';
        closeBtn.onclick = () => mask.remove();
        head.appendChild(title);
        head.appendChild(closeBtn);

        // 字段编辑区
        const fieldSection = document.createElement('div');
        fieldSection.style.cssText = 'padding: 14px 24px; background: #f4f4f8; border-bottom: 1px solid #d8d8de; display: grid; grid-template-columns: 1fr 1fr 140px 110px; gap: 10px 14px; align-items: end;';

        function mkInput(labelText, key, value) {
            const wrap = document.createElement('div');
            const lab = document.createElement('div');
            lab.textContent = labelText;
            lab.style.cssText = 'font-size: 12px; color: #444; font-weight: 700; margin-bottom: 4px;';
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = value ?? '';
            inp.style.cssText = 'width: 100%; padding: 6px 10px; border: 1px solid #bbb; border-radius: 4px; font-size: 13px; box-sizing: border-box; background: #fff; color: #111;';
            inp.addEventListener('input', () => { overrides[key] = inp.value; refreshPreview(); });
            wrap.appendChild(lab); wrap.appendChild(inp);
            return wrap;
        }

        function mkSelect(labelText, key, value, options) {
            const wrap = document.createElement('div');
            const lab = document.createElement('div');
            lab.textContent = labelText;
            lab.style.cssText = 'font-size: 12px; color: #444; font-weight: 700; margin-bottom: 4px;';
            const sel = document.createElement('select');
            sel.style.cssText = 'width: 100%; padding: 6px 10px; border: 1px solid #bbb; border-radius: 4px; font-size: 13px; box-sizing: border-box; background: #fff; color: #111;';
            options.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = opt || '（留空）';
                if (opt === value) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', () => { overrides[key] = sel.value; refreshPreview(); });
            wrap.appendChild(lab); wrap.appendChild(sel);
            return wrap;
        }

        fieldSection.appendChild(mkInput('名称（简体）', '名称', data.名称));
        fieldSection.appendChild(mkInput('原名（原文）', '原名', data.原名));
        fieldSection.appendChild(mkSelect('地区', '地区', data.地区, REGIONS));
        fieldSection.appendChild(mkInput('总话数', '总话数', data.总话数));

        // 题材选择
        const tagSection = document.createElement('div');
        tagSection.style.cssText = 'padding: 14px 24px; background: #f4f4f8; border-bottom: 1px solid #d8d8de;';
        const tagLabel = document.createElement('div');
        tagLabel.textContent = `题材（点击切换 · 共 ${data.题材.length} 项）`;
        tagLabel.style.cssText = 'font-size: 14px; color: #222; font-weight: 700; margin-bottom: 12px;';
        tagSection.appendChild(tagLabel);

        const tagWrap = document.createElement('div');
        tagWrap.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px;';

        function setChipState(chip, on) {
            if (on) {
                chip.style.background = '#5B4ED1';
                chip.style.color = '#ffffff';
                chip.style.borderColor = '#5B4ED1';
            } else {
                chip.style.background = '#ffffff';
                chip.style.color = '#555';
                chip.style.borderColor = '#bbb';
            }
        }

        data.题材.forEach(tag => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.textContent = tag;
            chip.style.cssText = `
                padding: 7px 14px; border-radius: 16px; cursor: pointer;
                font-size: 13px; font-weight: 600; user-select: none;
                border: 1px solid #5B4ED1;
            `;
            setChipState(chip, true);
            chip.addEventListener('click', () => {
                const on = !selectedTags.has(tag);
                if (on) selectedTags.add(tag); else selectedTags.delete(tag);
                setChipState(chip, on);
                refreshPreview();
            });
            tagWrap.appendChild(chip);
        });

        if (data.题材.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '（页面无题材）';
            empty.style.cssText = 'color: #888; font-size: 13px;';
            tagWrap.appendChild(empty);
        }
        tagSection.appendChild(tagWrap);

        // 全选 / 清空
        const tagBtns = document.createElement('div');
        tagBtns.style.cssText = 'margin-top: 12px; display: flex; gap: 8px;';
        const mkSmall = (label) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = 'padding: 5px 12px; font-size: 12px; background: #fff; border: 1px solid #888; border-radius: 4px; cursor: pointer; color: #222; font-weight: 600;';
            return b;
        };
        const selectAll  = mkSmall('全选');
        const selectNone = mkSmall('清空');
        selectAll.onclick  = () => { data.题材.forEach(t => selectedTags.add(t)); tagWrap.querySelectorAll('button').forEach(c => setChipState(c, true));  refreshPreview(); };
        selectNone.onclick = () => { selectedTags.clear();                          tagWrap.querySelectorAll('button').forEach(c => setChipState(c, false)); refreshPreview(); };
        tagBtns.appendChild(selectAll);
        tagBtns.appendChild(selectNone);
        tagSection.appendChild(tagBtns);

        // 预览区
        const ta = document.createElement('textarea');
        ta.spellcheck = false;
        ta.style.cssText = `
            flex: 1; min-height: 320px;
            border: none; padding: 20px 24px;
            font-size: 15px; line-height: 1.7;
            color: #111111; background: #ffffff;
            font-family: ui-monospace, "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
            font-weight: 500; resize: none; outline: none; white-space: pre;
        `;

        function currentTags() { return data.题材.filter(t => selectedTags.has(t)); }
        function refreshPreview() { ta.value = buildMarkdown(data, overrides, currentTags()); }
        refreshPreview();

        // 底部
        const foot = document.createElement('div');
        foot.style.cssText = `
            padding: 14px 24px; background: #ececf2;
            display: flex; gap: 10px; justify-content: flex-end; align-items: center;
            border-top: 1px solid #ccc;
        `;
        const hint = document.createElement('div');
        hint.style.cssText = 'flex: 1; font-size: 12px; color: #444;';
        hint.textContent = data.封面URL
            ? `封面源: ${data.封面URL.split('/').pop()}`
            : '⚠ 未找到封面图';
        foot.appendChild(hint);

        const mkBtn = (label, primary) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = primary
                ? 'padding: 10px 18px; background: #5B4ED1; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 700; cursor: pointer;'
                : 'padding: 10px 16px; background: #fff; color: #222; border: 1px solid #888; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;';
            return b;
        };

        const getFilename = () => sanitizeFilename(overrides.名称 || overrides.原名 || 'manga');

        const copyBtn = mkBtn('📋 复制 MD');
        copyBtn.onclick = async () => {
            await navigator.clipboard.writeText(ta.value);
            copyBtn.textContent = '✓ 已复制';
            setTimeout(() => copyBtn.textContent = '📋 复制 MD', 1500);
        };

        const mdBtn = mkBtn('💾 下载 MD');
        mdBtn.onclick = () => downloadText(`${getFilename()}.md`, ta.value);

        const coverBtn = mkBtn('🖼 下载封面');
        coverBtn.onclick = async () => {
            if (!data.封面URL) { alert('未找到封面图'); return; }
            coverBtn.textContent = '下载中...';
            try {
                await downloadImage(data.封面URL, `${getFilename()}.${data.封面扩展名}`);
                coverBtn.textContent = '✓ 已下载';
                setTimeout(() => coverBtn.textContent = '🖼 下载封面', 1500);
            } catch (e) {
                coverBtn.textContent = '🖼 下载封面';
                alert('封面下载失败：' + e.message);
            }
        };

        const bothBtn = mkBtn('📦 全部下载', true);
        bothBtn.onclick = async () => {
            downloadText(`${getFilename()}.md`, ta.value);
            if (data.封面URL) {
                try {
                    await downloadImage(data.封面URL, `${getFilename()}.${data.封面扩展名}`);
                } catch (e) {
                    alert('MD 已下载，但封面失败：' + e.message);
                    return;
                }
            }
            bothBtn.textContent = '✓ 完成';
            setTimeout(() => mask.remove(), 700);
        };

        foot.appendChild(copyBtn);
        foot.appendChild(coverBtn);
        foot.appendChild(mdBtn);
        foot.appendChild(bothBtn);

        box.appendChild(head);
        box.appendChild(fieldSection);
        box.appendChild(tagSection);
        box.appendChild(ta);
        box.appendChild(foot);
        mask.appendChild(box);
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        document.body.appendChild(mask);
    }

    // ---------- 启动 ----------
    function init() {
        const adapter = currentAdapter();
        if (!adapter) return;
        const tryMount = () => {
            if (adapter.canMount()) { mountButton(); return true; }
            return false;
        };
        if (tryMount()) return;
        let n = 0;
        const timer = setInterval(() => {
            if (tryMount() || ++n >= 40) clearInterval(timer);
        }, 300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
