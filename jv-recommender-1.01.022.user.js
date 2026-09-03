// ==UserScript==
// @name         JAV 智能推荐 (javdb / javbus)
// @namespace    https://github.com/quakewx1981/jv-recommender
// @version      1.01.022
// @description  根据影片评分与热度综合评定，推荐 10 部影片；支持分类/关键字筛选与随机换一批。
// @author       浮云
// @match        https://www.javdb.com/*
// @match        https://javdb.com/*
// @match        https://www.javbus.com/*
// @match        https://javbus.com/*
// @match        https://javbus.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      javdb.com
// @connect      javdb.org
// @connect      www.javdb.com
// @connect      javbus.com
// @connect      javbus.tv
// @connect      www.javbus.com
// 允许跨域加载图片 CDN（封面图 blob）
// @connect      *
// 升级版本时，请同步修改下方两个 URL 里的文件名（保持版本号一致）
// @updateURL    https://raw.githubusercontent.com/quakewx1981/jv-recommender/main/jv-recommender.meta.js
// @downloadURL  https://raw.githubusercontent.com/quakewx1981/jv-recommender/main/jv-recommender-1.01.022.user.js
// @run-at       document-idle
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_addStyle, GM_setValue, GM_getValue */

(function () {
  'use strict';

  /* ============================== 配置区 ============================== */
  // 想调权重 / 抓几页 / 改选择器，都改这里。
  const CONFIG = {
    version: '1.01.022',
    recommendCount: 10,      // 推荐数量
    fetchPages: 5,           // HTML 数据源最多抓取的列表页数（候选池大小）
    searchPages: 3,          // 搜索源抓取页数（每页 pageSize 部，实测 3 页约 120 部候选）
    pageSize: 40,            // 搜索每页数量（API limit）
    scoreFetchN: 18,         // 补全详情的候选数（榜单/搜索已按分排序，前 18 部必含 top10，减少补分耗时）
    concurrency: 16,         // 详情补全并发数（实测 16 并发稳定，提速明显）
    allMaxPages: 25,         // “全站候选”网页源最多翻页数（≈500 部全站快照；调大覆盖更全但更慢）
    allEnrichN: 80,          // 全站候选粗排后补真实详情的候选数（与其它源口径一致；越大越准但越慢）
    enrichAll: true,         // 全站候选是否补真实详情（评分人数/想看/看过），关闭则退回网页角标
    minWatched: 200,         // 看过人数低于此值不推荐（无该数据的条目保留）
    defaultYear: 0,          // 年代筛选默认值（0=不限；>0 表示只保留发行年 ≤ 该值的影片）
    pageDelay: 250,          // HTML 翻页抓取间隔(ms)，避免被限流
    weights: { rating: 0.6, popularity: 0.4 }, // 综合评分权重
    // 贝叶斯加权评分（借鉴 Javdb 增强脚本）：W = (rb*score + m*C) / (rb + m)
    // rb=评分人数，m=基准人数(虚拟评分人数，越大越保守)，C=基准分(5分制，亦为隐藏低分阈值)
    bayes: {
      m: 200,           // 基准人数（越大越需要真实评分才能摆脱基准分）
      C: 3.75,          // 基准分，同时是隐藏低分的阈值
      CMax: 4.75,       // 100% 热度对应分（仅影响颜色与归一上界）
      curveFactor: 0.5, // 热力色曲线：<1 拉开低分差异，>1 拉开高分差异
      hideLowScore: false, // 是否隐藏加权分低于 C 的影片
    },
    debug: true,             // 面板内调试日志
    // javdb 卡片选择器（如站点改版，按 F12 核对后改这里）
    dom: {
      javdb: {
        itemSel: '.masonry .item, .item',
        linkSel: 'a.box',
        coverSel: 'img',
        uidSel: '.uid',
        titleSel: '.meta .name',
        scoreSel: '.score', // 评分角标，如 "9.20"
      },
      javbus: {
        itemSel: '.movie-box',
        linkSel: 'a',
        coverSel: 'img',
        uidSel: '.photo-info .uid, .uid',
        titleSel: '.photo-info',
        scoreSel: null, // javbus 列表页无评分
      },
    },
  };

  /* ============================== 工具函数 ============================== */
  const log = (...a) => { if (CONFIG.debug) pushLog(a.map(String).join(' ')); };

  function detectSite() {
    const h = location.hostname;
    if (h.includes('javdb')) return 'javdb';
    if (h.includes('javbus')) return 'javbus';
    return null;
  }

  function origin() { return location.origin; }

  function absUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//.test(path)) return path;
    return origin() + (path.startsWith('/') ? '' : '/') + path;
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Accept': 'text/html,*/*' },
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve(r.responseText);
          else reject(new Error('HTTP ' + r.status + ' ' + url));
        },
        onerror: (e) => reject(new Error('NETERR ' + url)),
      });
    });
  }

  function toNum(v) {
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  // 分批并发执行（避免一次性发过多请求被限流）
  async function mapLimit(items, limit, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += limit) {
      const batch = items.slice(i, i + limit);
      const r = await Promise.all(batch.map(fn));
      for (const x of r) out.push(x);
    }
    return out;
  }

  // 详情缓存：同一部影片不重复请求（借鉴 JavdbBuddy 的多层缓存思路）
  const detailCache = new Map();
  async function fetchDetailCached(id) {
    if (detailCache.has(id)) return detailCache.get(id);
    const d = await jdbApiGet('/api/v4/movies/' + id);
    detailCache.set(id, d);
    return d;
  }

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /* ============================== JavDB App API ============================== */
  // 逆向自 JavDB.apk 1.9.28：jdsignature = "{ts}.{suffix}.{md5(ts+prefix)}"
  const JDB_API = {
    host: 'https://javdb.com',        // 当前生效 host（首次成功后更新为可用节点）
    hosts: ['https://javdb.com', 'https://jdforrepam.com'], // 主站 + 镜像，任一失败自动切换（借鉴 javdb-cli 的 host 探测）
    prefix: '71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa',
    suffix: 'lpw6vgqzsp',
    appVersion: '1.9.28',
    appVersionNumber: '10928',
    userAgent: 'Dart/3.4 (dart:io)',
  };

  function md5(s) {
    function rotateLeft(l, r) { return (l << r) | (l >>> (32 - r)); }
    function add(x, y) { const l = (x & 0xffff) + (y & 0xffff); const m = (x >>> 16) + (y >>> 16) + (l >>> 16); return (m << 16) | (l & 0xffff); }
    function cmn(q, a, b, x, s, t) { a = add(a, q); a = add(a, x); a = add(a, t); a = rotateLeft(a, s); a = add(a, b); return a; }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function md5cycle(x, k) {
      let a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = add(a, x[0]); x[1] = add(b, x[1]); x[2] = add(c, x[2]); x[3] = add(d, x[3]);
    }
    function md5blk(s) { const m = []; for (let i = 0; i < 64; i += 4) m.push(s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8) | (s.charCodeAt(i + 2) << 16) | (s.charCodeAt(i + 3) << 24)); return m; }
    function md51(s) {
      const nblk = ((s.length + 8) >> 6) + 1; const blks = []; for (let i = 0; i < nblk * 16; i++) blks.push(0);
      for (let i = 0; i < s.length; i++) blks[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
      blks[s.length >> 2] |= 0x80 << ((s.length % 4) * 8);
      blks[nblk * 16 - 2] = s.length * 8;
      const x = [1732584193, -271733879, -1732584194, 271733878];
      for (let i = 0; i < blks.length; i += 16) md5cycle(x, blks.slice(i, i + 16));
      return x;
    }
    function rhex(n) { let s = '', j; for (let i = 0; i < 4; i++) { j = (n >>> (i * 8)) & 0xff; s += ('0' + j.toString(16)).slice(-2); } return s; }
    const b = md51(s); let out = ''; for (let i = 0; i < 4; i++) out += rhex(b[i]); return out;
  }

  function jdbSign(ts) {
    ts = ts || Math.floor(Date.now() / 1000);
    return ts + '.' + JDB_API.suffix + '.' + md5(String(ts) + JDB_API.prefix);
  }

  function jdbPublicParams() {
    return {
      app_channel: 'official',
      app_version: JDB_API.appVersion,
      app_version_number: JDB_API.appVersionNumber,
      platform: 'android',
      system_version: '13',
      device_model: 'Pixel 6',
      device_name: 'Pixel',
      device_uuid: 'abcd1234abcd1234',
      lang: 'en',
    };
  }

  // GM_xhr GET JSON，返回 envelope.data（已解析对象）；主站失败自动切换镜像
  function jdbApiGet(path, extraParams) {
    const params = Object.assign(jdbPublicParams(), extraParams || {});
    const qs = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    const sig = jdbSign();
    const hosts = JDB_API.hosts;
    function tryHost(i) {
      if (i >= hosts.length) return Promise.reject(new Error('全部 host 失败: ' + path));
      const url = hosts[i] + path + (qs ? '?' + qs : '');
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { 'jdsignature': sig, 'user-agent': JDB_API.userAgent, 'accept-language': 'en' },
          onload: (r) => {
            if (r.status < 200 || r.status >= 300) { reject(new Error('HTTP ' + r.status)); return; }
            try {
              const env = JSON.parse(r.responseText);
              // 业务错误（签名/参数）不重试，直接抛出
              if (![1, true, '1'].includes(env.success)) { reject(new Error('API ' + (env.action || 'err') + ': ' + (env.message || ''))); return; }
              JDB_API.host = hosts[i]; // 记住可用 host，后续请求优先
              resolve(env.data || {});
            } catch (e) { reject(new Error('JSON 解析失败')); }
          },
          onerror: () => reject(new Error('网络错误')),
        });
      }).catch((e) => {
        log('API host 失败:', hosts[i], '→', e.message, (i + 1 < hosts.length ? '尝试镜像' : '已无备用'));
        return tryHost(i + 1);
      });
    }
    return tryHost(0);
  }

  // 把 App API 影片对象映射为内部结构（列表无评分，rating 稍后补全）
  function jdbMovieFromApi(m, baseOffset, i) {
    return {
      id: m.id || '',
      uid: m.number || '',
      title: (m.title || m.origin_title || '').trim(),
      cover: m.thumb_url || m.cover_url || '',
      rating: null,
      position: baseOffset + i + 1,
      url: m.id ? origin() + '/v/' + m.id : '',
      source: 'api',
      _apiId: m.id || '',
    };
  }

  /* ============================== 站点适配器 ============================== */
  // 每个适配器负责：构造数据源 URL、解析单页影片。
  const adapters = {
    javdb: {
      name: 'javdb',
      sources: [
        { id: 'hot_daily', label: '热播日榜', mode: 'api', apiPath: '/api/v1/rankings/playback', apiParams: { filter_by: 'high_score', period: 'daily' } },
        { id: 'hot_weekly', label: '热播周榜', mode: 'api', apiPath: '/api/v1/rankings/playback', apiParams: { filter_by: 'high_score', period: 'weekly' } },
        { id: 'hot_monthly', label: '热播月榜', mode: 'api', apiPath: '/api/v1/rankings/playback', apiParams: { filter_by: 'high_score', period: 'monthly' } },
        { id: 'top250', label: 'Top250', mode: 'html' },
        // 全站候选：网页逐页爬（/?page=N 全站最新流快照），列表自带评分角标，无需补分；受 allMaxPages 限制
        { id: 'all', label: '全站候选(网页)', mode: 'html' },
        // 搜索由服务端按评分排序(movie_sort_by=score)并翻多页，从全站候选中产生结果
        { id: 'search', label: '关键字搜索', mode: 'api', paged: true, apiPath: '/api/v2/search', apiParams: (kw) => ({ q: kw || '', movie_sort_by: 'score' }) },
        { id: 'current', label: '当前页面', mode: 'html' },
      ],
      // 常见分类（按名称走搜索，近似分类筛选）
      categories: ['剧情', '爱情', '喜剧', '动作', '科幻', '恐怖', '奇幻', '动画', '纪录片', '痴女', '人妻', '巨乳', '萝莉', '潮吹', '肛交', '多人运动', '制服', '角色扮演', '素人', '单体作品'],
      // ---- HTML 源（Top250 / 当前页面）----
      buildUrl(sourceId, keyword, page) {
        const p = page > 1 ? '&page=' + page : '';
        switch (sourceId) {
          case 'top250': return origin() + '/top250' + (page > 1 ? '?page=' + page : '');
          case 'current': return origin() + location.pathname + location.search + (page > 1 ? (location.search ? '&' : '?') + 'page=' + page : '');
          default: return origin() + '/?page=' + page;
        }
      },
      parse(doc, baseOffset, ctx) {
        const d = CONFIG.dom.javdb;
        const items = doc.querySelectorAll(d.itemSel);
        const out = [];
        items.forEach((el, i) => {
          const link = el.querySelector(d.linkSel);
          const href = link ? link.getAttribute('href') : '';
          const m = href ? href.match(/\/v\/([^/?#]+)/) : null;
          const id = m ? m[1] : '';
          const cover = el.querySelector(d.coverSel);
          const uid = el.querySelector(d.uidSel);
          const title = el.querySelector(d.titleSel);
          const score = el.querySelector(d.scoreSel);
          let rating = score ? parseFloat(score.textContent) : NaN;
          if (isNaN(rating)) rating = null;
          else if (rating > 5) rating = rating / 2; // javdb 网页角标为 10 分制，统一转 5 分制与 API 源一致
          // 发行年：从卡片文本里取 19xx/20xx（javdb 卡片含发行日期，如 2021-03-26）
          const ym = (el.textContent || '').match(/\b(?:19|20)\d{2}\b/);
          const year = ym ? parseInt(ym[0], 10) : null;
          out.push({
            id,
            uid: uid ? uid.textContent.trim() : '',
            title: title ? title.textContent.trim() : '',
            cover: cover ? (cover.getAttribute('data-src') || cover.getAttribute('src')) : '',
            rating,
            year,
            position: baseOffset + i + 1,
            url: absUrl(href),
            source: ctx.sourceId,
          });
        });
        return out;
      },
      // ---- App API 源（热播榜 / 搜索）----
      async apiFetch(sourceId, keyword) {
        const src = this.sources.find((s) => s.id === sourceId);
        if (!src || src.mode !== 'api') throw new Error('该数据源非 API 模式');
        const base = typeof src.apiParams === 'function' ? src.apiParams(keyword) : Object.assign({}, src.apiParams);
        // 搜索源翻多页，从全站候选中产生结果（服务端已按评分排序）
        const pages = src.paged ? CONFIG.searchPages : 1;
        const t0 = Date.now();
        const pageNums = [];
        for (let p = 1; p <= pages; p++) pageNums.push(p);
        const results = await mapLimit(pageNums, pages, async (pg) => {
          const params = Object.assign({}, base, { limit: CONFIG.pageSize, page: pg });
          try {
            const data = await jdbApiGet(src.apiPath, params);
            return (data && data.movies) ? data.movies : [];
          } catch (e) { log('第', pg, '页失败:', e.message); return []; }
        });
        // 多页合并 + 按 id 去重
        let list = [];
        const seen = new Set();
        results.forEach((arr) => (arr || []).forEach((m) => {
          if (m && m.id && !seen.has(m.id)) { seen.add(m.id); list.push(m); }
        }));
        if (!list.length) { log('API 返回 0 部影片'); return []; }
        log('候选', list.length, '部（' + ((Date.now() - t0) / 1000).toFixed(1) + 's），正在补全评分…');
        const movies = list.map((m, i) => jdbMovieFromApi(m, 0, i));
        await this.fillScores(movies);
        return movies;
      },
      // 对前 N 部并行拉详情，补评分 / 评分人数 / 想看·看过数
      async fillScores(movies) {
        const top = movies.slice(0, CONFIG.scoreFetchN);
        let done = 0;
        await mapLimit(top, CONFIG.concurrency, async (m) => {
          if (!m._apiId) { done++; return; }
          try {
            const d = await fetchDetailCached(m._apiId);
            const mv = (d && d.movie) ? d.movie : d;
            if (mv) {
              const s = mv.score;
              const r = s != null ? parseFloat(s) : NaN;
              m.rating = isNaN(r) ? null : r;
              m.reviews = toNum(mv.reviews_count);
              m.wantWatch = toNum(mv.want_watch_count);
              m.watched = toNum(mv.watched_count);
              m.magnets = toNum(mv.magnets_count);
            }
          } catch (e) { /* 补分失败不影响推荐 */ }
          done++;
          if (done % 8 === 0 || done === top.length) log('补全进度:', done + '/' + top.length);
        });
        const got = movies.filter((m) => m.rating != null).length;
        log('详情补全:', got + '/' + top.length, '部（评分/评分人数/想看数）');
      },

      // 全站候选两段式补分：先用网页角标粗排，取潜力 Top N 拉真实详情
      // （评分/评分人数/想看数/看过数），使全站源评分口径与热播榜/搜索等 API 源一致。
      // 避免全站源只靠网页角标、热度退化为列表位置、且无法做冷门过滤。
      async enrichCandidates(movies) {
        if (!CONFIG.enrichAll) return;
        const withId = movies.filter((m) => m.id);
        if (!withId.length) return;
        // 粗排：网页角标降序、同分按列表位置
        const ranked = withId.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.position - b.position);
        const top = ranked.slice(0, CONFIG.allEnrichN);
        log('全站候选补分: 拟对', top.length, '部拉取真实评分…');
        let done = 0;
        await mapLimit(top, CONFIG.concurrency, async (m) => {
          try {
            const d = await fetchDetailCached(m.id);
            const mv = (d && d.movie) ? d.movie : d;
            if (mv) {
              const r = mv.score != null ? parseFloat(mv.score) : NaN;
              if (!isNaN(r)) {
                m.rating = r;
                m.reviews = toNum(mv.reviews_count);
                m.wantWatch = toNum(mv.want_watch_count);
                m.watched = toNum(mv.watched_count);
                m.magnets = toNum(mv.magnets_count);
              }
            }
          } catch (e) { /* 详情失败则保留网页角标，不影响推荐 */ }
          done++;
          if (done % 16 === 0 || done === top.length) log('补分进度:', done + '/' + top.length);
        });
        const got = top.filter((m) => m.reviews != null).length;
        log('全站候选补分完成:', got + '/' + top.length, '部拿到真实评分人数');
      },
    },

    javbus: {
      name: 'javbus',
      sources: [
        { id: 'hot', label: '热门' },
        { id: 'new', label: '最新' },
        { id: 'search', label: '关键字搜索' },
        { id: 'current', label: '当前页面' },
      ],
      categories: ['素人', '熟女', '巨乳', '萝莉', '痴女', '人妻', '制服', '角色扮演', '肛交', '潮吹', '多人运动', '单体作品', '中文字幕', '高清', '无码', '有码'],
      buildUrl(sourceId, keyword, page) {
        const p = page > 1 ? '?page=' + page : '';
        switch (sourceId) {
          case 'hot': return origin() + '/popular' + p;
          case 'new': return origin() + '/' + p;
          case 'search': return origin() + '/search/' + encodeURIComponent(keyword || '') + p;
          case 'current': return origin() + location.pathname + location.search + (page > 1 ? (location.search ? '&' : '?') + 'page=' + page : '');
          default: return origin() + '/';
        }
      },
      parse(doc, baseOffset, ctx) {
        const d = CONFIG.dom.javbus;
        const items = doc.querySelectorAll(d.itemSel);
        const out = [];
        items.forEach((el, i) => {
          const link = el.querySelector(d.linkSel);
          const href = link ? link.getAttribute('href') : '';
          const m = href ? href.match(/\/([A-Za-z0-9-]+)$/) : null;
          const id = m ? m[1] : '';
          const cover = el.querySelector(d.coverSel);
          const info = el.querySelector(d.titleSel);
          const uidEl = el.querySelector(d.uidSel);
          let rating = null; // javbus 列表无评分
          const ym = (el.textContent || '').match(/\b(?:19|20)\d{2}\b/);
          const year = ym ? parseInt(ym[0], 10) : null;
          out.push({
            id,
            uid: uidEl ? uidEl.textContent.trim() : '',
            title: info ? info.textContent.replace(/\s+/g, ' ').trim() : '',
            cover: cover ? (cover.getAttribute('data-src') || cover.getAttribute('src')) : '',
            rating,
            year,
            position: baseOffset + i + 1,
            url: absUrl(href),
            source: ctx.sourceId,
          });
        });
        return out;
      },
    },
  };

  /* ============================== 评分引擎 ============================== */
  // 综合分 = w_r * 评分归一 + w_p * 热度归一
  function normalizeRating(r) {
    if (r == null) return null;
    let v = r;
    if (v > 10) v = v / 10;          // 百分制 → 0~1
    else if (v <= 5) v = v / 5;      // 5 分制（JavDB App API 详情）
    else v = v / 10;                 // 10 分制（JavDB 网页角标）
    return Math.max(0, Math.min(1, v));
  }

  // 贝叶斯加权评分：W = (rb*score + m*C) / (rb + m)
  // 评分人数为 0 时完全回归基准分 C；无评分则返回 null
  function bayesScore(m) {
    if (m.rating == null) return null;
    const rb = (m.reviews != null && m.reviews > 0) ? m.reviews : 0;
    const C = CONFIG.bayes.C, mm = CONFIG.bayes.m;
    // 无评分人数（网页源 / 补分失败）时直接用平均分，避免全部退化成基准分 C 丢失排序信息
    if (rb === 0) return m.rating;
    return (rb * m.rating + mm * C) / (rb + mm);
  }

  // 加权分归一到 [C, CMax] → 0~1
  function heatNorm(b) {
    if (b == null) return null;
    const C = CONFIG.bayes.C, CMax = CONFIG.bayes.CMax;
    if (CMax <= C) return 0;
    return Math.max(0, Math.min(1, (b - C) / (CMax - C)));
  }

  // 热力色：0=蓝 → 0.5=绿 → 1=红（曲线只影响颜色，不影响排序）
  function heatColor(heat) {
    const h = Math.pow(Math.max(0, Math.min(1, heat == null ? 0 : heat)), CONFIG.bayes.curveFactor);
    const r = h > 0.5 ? Math.round(255 * ((h - 0.5) * 2)) : 0;
    const g = h < 0.5 ? Math.round(255 * (h * 2)) : Math.round(255 * (1 - (h - 0.5) * 2));
    const b = h < 0.5 ? Math.round(255 * (1 - (h * 2))) : 0;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function buildCandidates(movies, sourceId) {
    // 热度信号优先用真实数据（想看 + 看过）；数据源无该字段时退回列表位置
    const popKey = (m) => (m.wantWatch || 0) + (m.watched || 0);
    const hasPop = movies.some((m) => popKey(m) > 0);
    const maxPop = Math.max(...movies.map(popKey), 1);
    const maxPos = Math.max(...movies.map((m) => m.position), 1);
    return movies.map((m) => {
      const bayes = bayesScore(m);
      const hNorm = heatNorm(bayes);
      const pNorm = hasPop
        ? popKey(m) / maxPop
        : 1 - (m.position - 1) / Math.max(maxPos - 1, 1); // 0~1
      let composite;
      if (hNorm == null) {
        // 无评分站点（javbus）仅靠热度
        composite = pNorm;
      } else {
        composite = CONFIG.weights.rating * hNorm + CONFIG.weights.popularity * pNorm;
      }
      return Object.assign({}, m, { bayes, hNorm, pNorm, composite });
    });
  }

  // 加权随机：权重用 composite^2，偏高质量但允许多样性
  function weightedSample(pool, n) {
    const arr = pool.slice();
    const picked = [];
    while (picked.length < n && arr.length) {
      const total = arr.reduce((s, x) => s + x.composite * x.composite + 1e-6, 0);
      let r = Math.random() * total;
      let idx = 0;
      for (let i = 0; i < arr.length; i++) {
        r -= arr[i].composite * arr[i].composite + 1e-6;
        if (r <= 0) { idx = i; break; }
      }
      picked.push(arr.splice(idx, 1)[0]);
    }
    return picked;
  }

  function topN(pool, n) {
    return pool.slice().sort((a, b) => b.composite - a.composite).slice(0, n);
  }

  /* ============================== UI 面板 ============================== */
  let panel, logBox;

  function pushLog(msg) {
    if (!logBox) return;
    const line = document.createElement('div');
    line.textContent = '› ' + msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function buildPanel() {
    GM_addStyle(`
      #jvr-panel { position: fixed; top: 12px; right: 12px; z-index: 999999; width: 560px;
        background: #1c1f26; color: #e8e8e8; border: 1px solid #333; border-radius: 10px;
        font: 14px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,.5); overflow: hidden; }
      #jvr-panel .jvr-h { display:flex; justify-content:space-between; align-items:center;
        padding: 10px 14px; background:#262b36; cursor:move; font-weight:600; }
      #jvr-panel .jvr-h button { background:#3a4150; color:#fff; border:none; border-radius:5px;
        padding:2px 10px; cursor:pointer; font-size:12px; }
      #jvr-panel .jvr-b { padding: 14px 16px; max-height: 78vh; overflow:auto; }
      #jvr-panel label { display:block; margin: 7px 0 4px; color:#9aa4b2; font-size:12px; }
      #jvr-panel select, #jvr-panel input { width:100%; box-sizing:border-box; padding:7px 9px;
        background:#11151c; color:#e8e8e8; border:1px solid #3a4150; border-radius:6px; }
      #jvr-panel .jvr-row { display:flex; gap:10px; margin-top:10px; }
      #jvr-panel .jvr-row button { flex:1; padding:9px; border:none; border-radius:7px; cursor:pointer;
        font-weight:600; color:#fff; }
      #jvr-panel .jvr-go { background:#2f7d4f; } #jvr-panel .jvr-rand { background:#3a5a8c; }
      #jvr-panel .jvr-item { display:flex; gap:14px; padding:12px 0; border-bottom:1px solid #2a2f3a; }
      #jvr-panel .jvr-thumb { width:130px; height:182px; flex:none; border-radius:8px; overflow:hidden;
        background:#0e1116 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='%23555' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='2' ry='2'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'/%3E%3Cpolyline points='21 15 16 10 5 21'/%3E%3C/svg%3E") center/40px no-repeat; }
      #jvr-panel .jvr-thumb img { width:100%; height:100%; object-fit:contain; display:block; opacity:0; transition:opacity .2s ease; }
      #jvr-panel .jvr-meta { flex:1; min-width:0; }
      #jvr-panel .jvr-meta a { color:#7fb2ff; text-decoration:none; font-weight:600; font-size:15px;
        display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #jvr-panel .jvr-sub { color:#9aa4b2; font-size:12px; line-height:1.45; }
      #jvr-panel .jvr-score { display:inline-block; margin-top:5px; padding:2px 7px; border-radius:4px;
        background:#3a2f1c; color:#ffcf6b; font-size:12px; font-weight:700; }
      #jvr-panel .jvr-log { margin-top:12px; padding:9px; background:#0e1116; border-radius:6px;
        max-height:120px; overflow:auto; font:11px/1.4 monospace; color:#8b94a3; }
      #jvr-panel .jvr-empty { color:#9aa4b2; text-align:center; padding:16px 0; }
    `);

    panel = document.createElement('div');
    panel.id = 'jvr-panel';
    panel.innerHTML = `
      <div class="jvr-h"><span>🎬 JAV 智能推荐</span><button id="jvr-min">—</button></div>
      <div class="jvr-b" id="jvr-body">
        <label>数据源</label>
        <select id="jvr-source"></select>
        <label>分类（近似筛选，可选）</label>
        <select id="jvr-cat"><option value="">— 不限 —</option></select>
        <label>年代（按发行年，求老片时选；配 Top250 出“以前的高分”）</label>
        <select id="jvr-year">
          <option value="">— 不限 —</option>
          <option value="2020">2020 年及以前</option>
          <option value="2015">2015 年及以前</option>
          <option value="2010">2010 年及以前</option>
          <option value="2005">2005 年及以前</option>
          <option value="2000">2000 年及以前</option>
        </select>
        <label>关键字（数据源选“关键字搜索”时生效）</label>
        <input id="jvr-kw" placeholder="如 SSIS, 女教师, 4K..." />
        <label style="display:flex;flex-direction:row;align-items:center;gap:6px;margin-top:8px;">
          <input type="checkbox" id="jvr-hide" style="width:auto;flex:none;" />
          隐藏低分（加权分 &lt; <b id="jvr-ct">3.75</b>）
        </label>
        <div class="jvr-row">
          <button class="jvr-go" id="jvr-run">推荐 10 部</button>
          <button class="jvr-rand" id="jvr-rand">随机换一批</button>
        </div>
        <div id="jvr-results"><div class="jvr-empty">点“推荐 10 部”开始</div></div>
        <div class="jvr-log" id="jvr-log"></div>
      </div>`;
    document.body.appendChild(panel);
    logBox = panel.querySelector('#jvr-log');

    const site = detectSite();
    const ad = adapters[site];
    const sel = panel.querySelector('#jvr-source');
    ad.sources.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.label; sel.appendChild(o);
    });
    const cat = panel.querySelector('#jvr-cat');
    ad.categories.forEach((c) => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c; cat.appendChild(o);
    });
    const yearSel = panel.querySelector('#jvr-year');

    panel.querySelector('#jvr-min').onclick = () => {
      const b = panel.querySelector('#jvr-body');
      b.style.display = b.style.display === 'none' ? 'block' : 'none';
    };
    panel.querySelector('#jvr-run').onclick = () => runRecommend(false);
    panel.querySelector('#jvr-rand').onclick = () => runRecommend(true);

    const hideEl = panel.querySelector('#jvr-hide');
    panel.querySelector('#jvr-ct').textContent = String(CONFIG.bayes.C);
    hideEl.checked = !!CONFIG.bayes.hideLowScore;
    hideEl.onchange = () => {
      CONFIG.bayes.hideLowScore = hideEl.checked;
      log('隐藏低分:', hideEl.checked ? '开启' : '关闭', '（阈值 ' + CONFIG.bayes.C + '）');
    };

    makeDraggable(panel.querySelector('.jvr-h'), panel);

    // 恢复上次配置
    const last = GM_getValue('jvr_last', null);
    if (last) {
      sel.value = last.source || sel.value;
      cat.value = last.cat || '';
      yearSel.value = last.year || '';
      panel.querySelector('#jvr-kw').value = last.kw || '';
      if (typeof last.hide === 'boolean') {
        hideEl.checked = last.hide;
        CONFIG.bayes.hideLowScore = last.hide;
      }
    }
    log('JVR 版本:', CONFIG.version, '| 站点:', site, '| 适配器已加载');
  }

  function makeDraggable(handle, el) {
    let dx, dy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      dx = e.clientX - el.offsetLeft; dy = e.clientY - el.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - dx) + 'px';
      el.style.top = (e.clientY - dy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  /* ============================== 主流程 ============================== */
  let lastPool = []; // 缓存候选池，供“随机换一批”复用

  async function runRecommend(randomize) {
    const site = detectSite();
    const ad = adapters[site];
    let sourceId = panel.querySelector('#jvr-source').value;
    let keyword = panel.querySelector('#jvr-kw').value.trim();
    const cat = panel.querySelector('#jvr-cat').value;
    const yearFilter = parseInt(panel.querySelector('#jvr-year').value, 10) || 0;

    // 分类 + 关键字组合：分类并入关键字；若选了分类/关键字但当前是热播榜，则改用搜索源
    if (cat || keyword) {
      keyword = ((keyword || '') + ' ' + (cat || '')).trim();
      if (sourceId.indexOf('hot_') === 0) sourceId = 'search';
    }
    GM_setValue('jvr_last', { source: sourceId, cat, kw: keyword, year: yearFilter, hide: CONFIG.bayes.hideLowScore });

    const resultsEl = panel.querySelector('#jvr-results');

    // 搜索源必须有“关键字/分类”，否则 API 返回 0（全站高分应走热播榜）
    if (sourceId === 'search' && !keyword) {
      resultsEl.innerHTML = '<div class="jvr-empty">搜索源需输入关键字/分类；否则请选“热播周榜”从全站高分影片推荐</div>';
      log('搜索源：缺少关键字，已终止');
      return;
    }

    resultsEl.innerHTML = '<div class="jvr-empty">抓取候选中…</div>';

    if (randomize && lastPool.length) {
      render(weightedSample(lastPool, CONFIG.recommendCount), '随机换一批');
      return;
    }

    try {
      const src = ad.sources.find((s) => s.id === sourceId);
      let all = [];
      if (src && src.mode === 'api') {
        all = await ad.apiFetch(sourceId, keyword);
      } else {
        // 全站候选源翻页更深（allMaxPages），其余 HTML 源用 fetchPages；间隔随源调整
        const maxPages = (sourceId === 'all') ? CONFIG.allMaxPages : CONFIG.fetchPages;
        const pageDelay = (sourceId === 'all') ? 120 : CONFIG.pageDelay;
        const t0 = Date.now();
        let offset = 0;
        for (let p = 1; p <= maxPages; p++) {
          const url = ad.buildUrl(sourceId, keyword, p);
          log('抓取:', url);
          const html = await gmFetch(url);
          const doc = parseDoc(html);
          const movies = ad.parse(doc, offset, { sourceId });
          if (!movies.length) { log('第', p, '页无影片，停止翻页'); break; }
          log('第', p, '页解析到', movies.length, '部');
          all = all.concat(movies);
          offset += movies.length;
          if (p < maxPages) await sleep(pageDelay);
        }
        if (sourceId === 'all') log('全站候选快照: 已爬', Math.min(maxPages, Math.ceil(offset / 20)), '页 / 共', all.length, '部（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
        // 全站候选两段式：粗排后补真实详情，使评分/热度口径与 API 源一致
        if (sourceId === 'all') await ad.enrichCandidates(all);
      }
      if (!all.length) {
        resultsEl.innerHTML = '<div class="jvr-empty">未抓到任何影片，检查选择器/网络</div>';
        return;
      }
      lastPool = buildCandidates(all, sourceId);
      // 过滤冷门：看过人数低于阈值的不推荐（无该数据的条目保留，避免误杀）
      if (CONFIG.minWatched > 0) {
        const b = lastPool.length;
        lastPool = lastPool.filter((m) => m.watched == null || m.watched >= CONFIG.minWatched);
        if (b !== lastPool.length) log('过滤冷门: 移除', b - lastPool.length, '部（看过人数 < ' + CONFIG.minWatched + '）');
      }
      if (CONFIG.bayes.hideLowScore) {
        const before = lastPool.length;
        lastPool = lastPool.filter((m) => m.bayes == null || m.bayes >= CONFIG.bayes.C);
        if (before !== lastPool.length) log('隐藏低分: 过滤', before - lastPool.length, '部（加权分 < ' + CONFIG.bayes.C + '）');
      }
      // 年代筛选：只保留发行年 ≤ 阈值的影片（0=不限）。求“以前的高分”时配 Top250 使用
      if (yearFilter > 0) {
        const before = lastPool.length;
        lastPool = lastPool.filter((m) => m.year == null || m.year <= yearFilter);
        if (before !== lastPool.length) log('年代过滤: 保留', lastPool.length, '部（发行年 ≤ ' + yearFilter + '）');
        else log('年代过滤: 阈值 ' + yearFilter + '（无影片被过滤）');
      }
      log('候选池:', lastPool.length, '部 | 评分中…');
      const picked = randomize
        ? weightedSample(lastPool, CONFIG.recommendCount)
        : topN(lastPool, CONFIG.recommendCount);
      render(picked, randomize ? '随机推荐' : '综合 Top' + CONFIG.recommendCount);
    } catch (e) {
      log('错误:', e.message);
      resultsEl.innerHTML = '<div class="jvr-empty">出错：' + e.message + '</div>';
    }
  }

  // 通过文件头魔数判断 MIME 类型，比 HTTP Header 更可靠
  function mimeFromBuffer(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 4) return 'image/jpeg';
    const h = Array.from(u8.slice(0, 4)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
    if (h.startsWith('ffd8ff')) return 'image/jpeg';
    if (h === '89504e47') return 'image/png';
    if (h === '47494638') return 'image/gif';
    if (h === '52494646') return 'image/webp';
    return 'image/jpeg';
  }

  // javdb 的 App API 返回的 cover 指向 tp.spfcas.com（混淆 CDN，返回加密数据，无法直接当图片显示）。
  // 而网页真实封面在 c0.jdbstatic.com，二者文件名（/{xx}/{xxx}.jpg）完全一致，仅域名/路径不同。
  // 故将 cover URL 改写为 jdbstatic 真实地址即可；jdbstatic 不校验 referer，浏览器原生 img 可直接显示。
  function realCover(url) {
    if (!url) return url;
    // 同时覆盖 small_covers（thumb_url）与 covers（cover_url）两种路径，统一改写为真实地址
    return url.replace(/^https?:\/\/[^/]+\/[^/]+\/(?:small_)?covers\//, 'https://c0.jdbstatic.com/covers/');
  }

  function loadCover(img, url) {
    if (!url) { log('封面: URL 为空'); return; }
    const real = realCover(url);
    log('封面加载: ' + real + (real !== url ? ' (源 ' + url + ')' : ''));
    let tried = 0;
    img.onload = () => {
      log('封面 img.onload: ' + real + ' w=' + img.naturalWidth + ' h=' + img.naturalHeight);
      img.style.opacity = '1';
    };
    img.onerror = () => {
      log('封面 img.onerror: ' + real + ' | 重试=' + tried);
      if (tried === 0) { tried = 1; img.referrerPolicy = 'no-referrer'; img.src = real; }
      else { img.style.display = 'none'; }
    };
    img.removeAttribute('referrerpolicy');
    img.src = real;
  }

  function render(list, mode) {
    const el = panel.querySelector('#jvr-results');
    if (!list.length) { el.innerHTML = '<div class="jvr-empty">无结果</div>'; return; }
    // 清理旧 object URL，避免内存泄漏
    el.querySelectorAll('.jvr-thumb img').forEach((img) => {
      if (img.src && img.src.startsWith('blob:')) {
        try { URL.revokeObjectURL(img.src); } catch (e) {}
      }
    });
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'jvr-sub';
    head.style.cssText = 'margin:4px 0 6px;color:#9aa4b2;';
    head.textContent = mode + '（共 ' + list.length + ' 部）';
    el.appendChild(head);
    list.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'jvr-item';
      const parts = [];
      if (m.year != null) parts.push(m.year + '年');
      if (m.rating != null) parts.push('评分 ' + m.rating.toFixed(2) + '/5');
      if (m.reviews != null) parts.push(m.reviews + '人评');
      if ((m.wantWatch || 0) + (m.watched || 0) > 0) parts.push('想看' + (m.wantWatch || 0) + '/看过' + (m.watched || 0));
      if (!parts.length) parts.push('无评分数据');
      // 热力色：贝叶斯加权分 → 蓝(冷)→绿→红(热)
      const c = m.bayes != null ? heatColor(m.hNorm) : 'rgb(154,164,178)';
      const cA = c.replace('rgb(', 'rgba(').replace(')', ',0.2)');
      const badge = m.bayes != null ? '加权 ' + m.bayes.toFixed(2) + ' · ' : '';
      item.innerHTML = `
        <div class="jvr-thumb"><img data-cover="${m.cover}" alt=""></div>
        <div class="jvr-meta">
          <a href="${m.url}" target="_blank" title="${m.title}">${i + 1}. ${m.uid || m.title}</a>
          <div class="jvr-sub">${m.title}</div>
          <div class="jvr-sub">${parts.join(' · ')} · 热度 ${(m.pNorm * 100).toFixed(0)}%</div>
          <span class="jvr-score" style="background:${cA};color:${c}">${badge}综合 ${(m.composite * 100).toFixed(1)}</span>
        </div>`;
      el.appendChild(item);
      const thumb = item.querySelector('.jvr-thumb img');
      if (thumb) loadCover(thumb, m.cover);
    });
  }

  /* ============================== 启动 ============================== */
  function init() {
    if (!detectSite()) { console.log('[JVR] 非 javdb/javbus 页面，跳过'); return; }
    if (document.getElementById('jvr-panel')) return;
    buildPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
