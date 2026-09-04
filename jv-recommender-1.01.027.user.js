// ==UserScript==
// @name         JAV 智能推荐 (javdb / javbus)
// @namespace    https://github.com/quakewx1981/jv-recommender
// @version      1.01.027
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
// 稳定发布文件：更新源固定指向 jv-recommender.user.js（无版本号），无需随版本号改文件名
// @updateURL    https://raw.githubusercontent.com/quakewx1981/jv-recommender/main/jv-recommender.user.js
// @downloadURL  https://raw.githubusercontent.com/quakewx1981/jv-recommender/main/jv-recommender.user.js
// @run-at       document-idle
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_addStyle, GM_setValue, GM_getValue */

(function () {
  'use strict';

  /* ============================== 配置区 ============================== */
  // 想调权重 / 抓几页 / 改选择器，都改这里。
  const CONFIG = {
    version: '1.01.027',
    recommendCount: 10,      // 推荐数量
    fetchPages: 5,           // HTML 数据源最多抓取的列表页数（候选池大小）
    searchPages: 3,          // 搜索源抓取页数（每页 pageSize 部，实测 3 页约 120 部候选）
    pageSize: 40,            // 搜索每页数量（API limit）
    scoreFetchN: 18,         // 补全详情的候选数（榜单/搜索已按分排序，前 18 部必含 top10，减少补分耗时）
    concurrency: 16,         // 详情补全并发数（实测 16 并发稳定，提速明显）
    rankPages: 20,           // “高分榜”翻页数（每页 20 部，20 页≈400 部；实测 monthly 可翻页，daily/yearly 翻页无效）
    classicPages: 2,         // “经典高分”每个关键词翻的页数（每页 40 部）
    classicConcurrency: 5,   // “经典高分”并发的关键词数（5 词 × 2 页 = 10 并发）
    allMaxPages: 25,         // “全站候选”网页源最多翻页数（≈500 部全站快照；调大覆盖更全但更慢）
    allEnrichN: 80,          // 全站候选粗排后补真实详情的候选数（与其它源口径一致；越大越准但越慢）
    enrichAll: true,         // 全站候选是否补真实详情（评分人数/想看/看过），关闭则退回网页角标
    minWatched: 200,         // 看过人数低于此值不推荐（无该数据的条目保留）
    requireMagnet: true,     // 推荐结果只保留有磁链的影片（javdb 走匿名 App API /api/v1/movies/{id}/magnets 校验）
    magnetTimeoutMs: 8000,   // 单部影片磁链校验超时(ms)，超时视为“未知”并保留
    defaultYear: 0,          // 年代筛选默认值（0=不限；>0 表示只保留发行年 ≤ 该值的影片）
    hideRecommended: false,  // “隐藏已推荐”：候选池剔除此前推荐过的影片，配合“随机换一批”避免重复
    recKey: 'jvr_recommended', // 已推荐影片番号集合的 GM_setValue 存储键
    // “经典高分（跨年）”的关键词表：javdb 搜索接口不支持空 query，
    // 故用一组高频宽泛词各自搜索（服务端 movie_sort_by=score 排序）后合并去重，
    // 近似得到覆盖全站、跨越多个年代的高分候选池。实测可召回 2001~2026 各年份影片。
    classicKeywords: ['AV', '中文字幕', '4K', 'HD', '熟女', '巨乳', '素人', '人妻', '女教師', '単体作品'],
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
      // javdb 选择器参照 JavdBviewed(javdb.com 列表/详情页实测结构)核对修正：
      // 列表容器 .movie-list → 卡片 .item → 内嵌 a(链接 /v/ID) → div.video-title > strong(番号)
      javdb: {
        itemSel: '.movie-list .item, .masonry .item', // 标准网格 .movie-list，兼容瀑布流 .masonry；去掉裸 .item 避免误抓非影片块
        linkSel: 'a',                                  // 卡片内首个 a 即影片链接（JavdBviewed 实测用 querySelector('a')）
        coverSel: 'img',
        uidSel: 'div.video-title > strong',            // 番号（已验证；原 .uid 为经验值易取空）
        titleSel: '.meta .name',                       // 中文标题（取不到时 parse 内回退 uid）
        scoreSel: '.score',                            // 评分角标，如 "9.20"（网页 10 分制，parse 内 >5 转 5 分制）
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

  // ---- 磁链校验 ----
  // 磁链是独立端点 GET /api/v1/movies/{id}/magnets（javdb-cli 明确标注 works anonymously），
  // 返回 data.magnets 为数组；详情接口 /api/v4/movies/{id} 里并没有 magnets 计数字段。
  // 缓存值语义：数字=磁链条数，null=未知（请求失败/超时/站点不支持），绝不可当成 0 过滤掉。
  const magnetCache = new Map();
  async function fetchMagnetCount(id) {
    if (!id) return null;
    if (magnetCache.has(id)) return magnetCache.get(id);
    let n = null;
    try {
      const d = await Promise.race([
        jdbApiGet('/api/v1/movies/' + id + '/magnets'),
        sleep(CONFIG.magnetTimeoutMs).then(() => { throw new Error('timeout'); }),
      ]);
      const arr = (d && d.magnets) ? d.magnets : null;
      if (Array.isArray(arr)) n = arr.length;
      else if (d && typeof d.total === 'number') n = d.total;
    } catch (e) { n = null; }
    magnetCache.set(id, n);
    return n;
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
            if (r.status < 200 || r.status >= 300) {
            let msg = 'HTTP ' + r.status;
            if (r.status === 401 || r.status === 403) msg += '（该接口需登录 javdb 账号）';
            reject(new Error(msg)); return;
          }
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
    const y = m.release_date ? parseInt(String(m.release_date).slice(0, 4), 10) : NaN;
    return {
      id: m.id || '',
      uid: m.number || '',
      title: (m.title || m.origin_title || '').trim(),
      cover: m.thumb_url || m.cover_url || '',
      rating: null,
      year: isNaN(y) ? null : y,
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
        // 匿名高分榜：App API /api/v1/rankings（无需登录）。
        // 实测：period=monthly 可正常翻页（约 1900 部），但返回的几乎全是当年新片；
        // period=daily/yearly 翻页无效（每页都返回同样 49 部），故此处只翻 monthly 并对齐 limit=20。
        // 求“以前的高分”请用下面的“经典高分（跨年）”源。
        { id: 'rankings_movies', label: '高分榜（近期，匿名）', mode: 'api', paged: true, pages: CONFIG.rankPages, limit: 20, apiPath: '/api/v1/rankings', apiParams: { type: 'all', period: 'monthly' } },
        // 经典高分：多关键词搜索合并（服务端按评分排序），覆盖 2001~2026 各年代，配“年代”下拉挑老高分
        { id: 'classic', label: '经典高分（跨年，搜老片）', mode: 'api', paged: true, pages: CONFIG.classicPages, limit: 40,
          multiKeyword: CONFIG.classicKeywords, apiPath: '/api/v2/search',
          apiParams: (kw) => ({ q: kw || '', movie_sort_by: 'score' }) },
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
          // 番号：优先 uidSel(div.video-title > strong)，取不到再退回 .uid（兼容旧结构）
          let uidEl = el.querySelector(d.uidSel);
          if (!uidEl) uidEl = el.querySelector('.uid');
          const uid = uidEl ? uidEl.textContent.trim() : '';
          const titleEl = el.querySelector(d.titleSel);
          const score = el.querySelector(d.scoreSel);
          let rating = score ? parseFloat(score.textContent) : NaN;
          if (isNaN(rating)) rating = null;
          else if (rating > 5) rating = rating / 2; // javdb 网页角标为 10 分制，统一转 5 分制与 API 源一致
          // 发行年：从卡片文本里取 19xx/20xx（javdb 卡片含发行日期，如 2021-03-26）
          const ym = (el.textContent || '').match(/\b(?:19|20)\d{2}\b/);
          const year = ym ? parseInt(ym[0], 10) : null;
          out.push({
            id,
            uid,
            // 标题取不到时回退番号，保证展示非空
            title: (titleEl && titleEl.textContent.trim()) ? titleEl.textContent.trim() : (uid || ''),
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
      // ---- App API 源（热播榜 / 高分榜 / 经典高分 / 搜索）----
      // opts: { yearFilter } —— 年代阈值 >0 时先在补分前做“年代预筛”，
      // 否则补分名额（scoreFetchN）会被榜单靠前的新片占满，老片拿不到真实评分。
      async apiFetch(sourceId, keyword, opts) {
        opts = opts || {};
        const src = this.sources.find((s) => s.id === sourceId);
        if (!src || src.mode !== 'api') throw new Error('该数据源非 API 模式');
        const pages = src.paged ? (src.pages || CONFIG.searchPages) : 1;
        const t0 = Date.now();
        // 关键词列表：多关键词源（经典高分）用内置词表逐词搜索后合并；其余源用单一关键词
        const isMulti = !!(src.multiKeyword && src.multiKeyword.length) && !keyword;
        const kwList = isMulti ? src.multiKeyword.slice() : [keyword || ''];
        if (isMulti) log('经典高分: 用', kwList.length, '个关键词各搜', pages, '页（服务端按评分排序）…');

        let list = [];
        const seen = new Set();
        // 关键词分批并发（每批 classicConcurrency 个），批内各页并发
        await mapLimit(kwList, isMulti ? CONFIG.classicConcurrency : 1, async (kw) => {
          const base = typeof src.apiParams === 'function' ? src.apiParams(kw, 1) : Object.assign({}, src.apiParams);
          const pageNums = [];
          for (let p = 1; p <= pages; p++) pageNums.push(p);
          const results = await mapLimit(pageNums, pages, async (pg) => {
            const params = Object.assign({}, base, { page: pg });
            if (!base.limit) params.limit = src.limit || CONFIG.pageSize;
            try {
              const data = await jdbApiGet(src.apiPath, params);
              return (data && data.movies) ? data.movies : [];
            } catch (e) { log((isMulti ? '“' + kw + '”第' : '第'), pg, '页失败:', e.message); return []; }
          });
          let added = 0;
          (results || []).forEach((arr) => (arr || []).forEach((m) => {
            if (m && m.id && !seen.has(m.id)) { seen.add(m.id); list.push(m); added++; }
          }));
          if (isMulti) log('关键词“' + kw + '”新增', added, '部，累计', list.length, '部');
        });

        // 多关键词 / 多页合并 + 按 id 去重
        if (!list.length) { log('API 返回 0 部影片'); return []; }
        log('候选', list.length, '部（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
        let movies = list.map((m, i) => jdbMovieFromApi(m, 0, i));

        // 年代预筛：只保留“有发行年且 ≤ 阈值”的影片，再补分。
        // 无年份条目在此丢弃——榜单类数据源即使无 year 字段也几乎全是新片，保留会稀释结果。
        const yf = opts.yearFilter || 0;
        if (yf > 0) {
          const before = movies.length;
          const kept = movies.filter((m) => m.year != null && m.year <= yf);
          if (kept.length >= CONFIG.recommendCount) {
            movies = kept;
            log('年代预筛: 保留', movies.length + '/' + before, '部（发行年 ≤ ' + yf + '），补分中…');
          } else if (kept.length === 0 && movies.some((m) => m.year != null)) {
            // 该源带发行年却一部老片都没有（如“高分榜”只覆盖当年），无需再补分，直接引导换源
            log('年代预筛: 0/' + before + ' 部发行年 ≤ ' + yf + '，该数据源缺少老片');
            return [];
          } else {
            log('年代预筛: 命中仅', kept.length, '部（发行年 ≤ ' + yf + '），不足 ' + CONFIG.recommendCount + ' 部，保留全部候选');
          }
        } else {
          log('正在补全评分…');
        }
        await this.fillScores(movies, yf > 0);
        return movies;
      },
      // 对前 N 部并行拉详情，补评分 / 评分人数 / 想看·看过数
      // full=true（已做年代预筛）时放宽补分数量，保证老片能拿到真实评分
      async fillScores(movies, full) {
        const n = full
          ? Math.min(movies.length, Math.max(CONFIG.scoreFetchN, CONFIG.scoreFetchN * 4))
          : CONFIG.scoreFetchN;
        const top = movies.slice(0, n);
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
            }
          } catch (e) { /* 补分失败不影响推荐 */ }
          // 磁链走独立端点校验；失败/超时为 null（未知），不会被当成“无磁链”
          m.magnets = await fetchMagnetCount(m._apiId);
          done++;
          if (done % 8 === 0 || done === top.length) log('补全进度:', done + '/' + top.length);
        });
        const got = movies.filter((m) => m.rating != null).length;
        log('详情补全:', got + '/' + top.length, '部（评分/评分人数/想看数）');
      },

      // 全站候选两段式补分：先用网页角标粗排，取潜力 Top N 拉真实详情
      // （评分/评分人数/想看数/看过数），使全站源评分口径与热播榜/搜索等 API 源一致。
      // 避免全站源只靠网页角标、热度退化为列表位置、且无法做冷门过滤。
      async enrichCandidates(movies, yearFilter) {
        if (!CONFIG.enrichAll) return;
        let withId = movies.filter((m) => m.id);
        if (!withId.length) return;
        // 年代预筛：与 API 源一致，先圈定老片再补分，避免补分名额被新片占满
        if (yearFilter && yearFilter > 0) {
          const kept = withId.filter((m) => m.year != null && m.year <= yearFilter);
          if (kept.length) {
            withId = kept;
            log('全站候选年代预筛: 保留', withId.length, '部（发行年 ≤ ' + yearFilter + '）');
          } else {
            log('全站候选年代预筛: 无影片命中（发行年 ≤ ' + yearFilter + '），需翻更多页');
          }
        }
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
              }
            }
          } catch (e) { /* 详情失败则保留网页角标，不影响推荐 */ }
          // 磁链独立端点校验（网页 id 与 App API 内部 id 一致，可直接复用）
          m.magnets = await fetchMagnetCount(m.id);
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

  // 保证最终推荐全部有磁链：
  // ① 对磁链数未知的补查（补分只覆盖前 N 部，Top10 里可能混进未校验的）
  // ② 剔除确认无磁链的（magnets === 0）；null 表示未知，保留不误杀
  // ③ 不足 10 部时从候选池按综合分递补，递补项同样先校验磁链
  async function ensureMagnets(picked, pool, randomize) {
    if (!CONFIG.requireMagnet) return picked;
    const need = CONFIG.recommendCount;
    const key = (m) => m.id || m._apiId || m.uid || m.title;

    // ① 复核未知的
    const unknown = picked.filter((m) => m.magnets == null && (m._apiId || m.id));
    if (unknown.length) {
      log('磁链校验: 复核', unknown.length, '部…');
      await mapLimit(unknown, CONFIG.concurrency, async (m) => {
        m.magnets = await fetchMagnetCount(m._apiId || m.id);
      });
    }

    // ② 剔除确认无磁链的
    let ok = picked.filter((m) => m.magnets !== 0);
    const dropped = picked.length - ok.length;
    if (dropped) log('磁链过滤: 移除', dropped, '部（无磁链）');

    // ③ 递补
    if (ok.length < need) {
      const seen = new Set(ok.map(key));
      const rest = pool.filter((m) => !seen.has(key(m)));
      // 已确认有磁链的直接取（最快路径）
      const ready = rest.filter((m) => m.magnets > 0);
      if (!randomize) ready.sort((a, b) => b.composite - a.composite);
      else ready.sort(() => Math.random() - 0.5);
      for (const m of ready) { if (ok.length >= need) break; ok.push(m); }
      // 还不够就分批校验剩余候选：按综合分从高到低，每批 concurrency 部，凑够即停
      // （一次性并发全池会在“几乎都无磁链”的极端情况下打出几百个请求）
      if (ok.length < need) {
        const maybe = rest.filter((m) => m.magnets == null && (m._apiId || m.id));
        if (maybe.length) {
          if (!randomize) maybe.sort((a, b) => b.composite - a.composite);
          else maybe.sort(() => Math.random() - 0.5);
          log('磁链递补: 分批校验候补（最多', maybe.length, '部）…');
          for (let i = 0; i < maybe.length && ok.length < need; i += CONFIG.concurrency) {
            const batch = maybe.slice(i, i + CONFIG.concurrency);
            await mapLimit(batch, CONFIG.concurrency, async (m) => {
              m.magnets = await fetchMagnetCount(m._apiId || m.id);
            });
            for (const m of batch) {
              if (ok.length >= need) break;
              if (m.magnets > 0) ok.push(m);
            }
          }
        }
      }
      if (ok.length < need) log('磁链递补: 候选池耗尽，仅', ok.length + '/' + need, '部确认有磁链');
    }
    return ok;
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
      #jvr-panel .jvr-rec { display:inline-block; margin-top:5px; margin-right:6px; padding:2px 7px; border-radius:4px;
        background:#3a2f4a; color:#c9a6ff; font-size:11px; font-weight:700; }
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
        <label>年代（按发行年，求老片时选；数据源请搭配“经典高分（跨年，搜老片）”）</label>
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
        <label style="display:flex;flex-direction:row;align-items:center;gap:6px;margin-top:6px;">
          <input type="checkbox" id="jvr-hiderec" style="width:auto;flex:none;" />
          隐藏已推荐（换一批不重复）
        </label>
        <div style="margin-top:7px;font-size:12px;color:#9aa4b2;display:flex;align-items:center;gap:8px;">
          <span>已推荐记录：<b id="jvr-reccount" style="color:#c9a6ff;">0</b> 部</span>
          <button id="jvr-clearrec" style="background:#3a2f4a;color:#c9a6ff;border:none;border-radius:5px;padding:2px 9px;cursor:pointer;font-size:11px;">清除</button>
        </div>
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

    // 已推荐：隐藏开关 + 清除记录 + 计数
    const hideRecEl = panel.querySelector('#jvr-hiderec');
    hideRecEl.checked = !!CONFIG.hideRecommended;
    hideRecEl.onchange = () => {
      CONFIG.hideRecommended = hideRecEl.checked;
      log('隐藏已推荐:', hideRecEl.checked ? '开启' : '关闭');
    };
    const recCountEl = panel.querySelector('#jvr-reccount');
    const refreshRecCount = () => { recCountEl.textContent = String((GM_getValue(CONFIG.recKey, []) || []).length); };
    refreshRecCount();
    panel.querySelector('#jvr-clearrec').onclick = () => {
      GM_setValue(CONFIG.recKey, []);
      lastRecBefore = new Set();
      refreshRecCount();
      log('已清除推荐记录');
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
      if (typeof last.hideRec === 'boolean') {
        hideRecEl.checked = last.hideRec;
        CONFIG.hideRecommended = last.hideRec;
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
  let lastRecBefore = new Set(); // 本运行开始前已记录的“已推荐”番号集合（供结果项标记徽章）

  async function runRecommend(randomize) {
    const site = detectSite();
    const ad = adapters[site];
    // 载入本运行前的“已推荐”集合（用于徽章标记与隐藏过滤，两个分支路径都依赖它）
    lastRecBefore = new Set(GM_getValue(CONFIG.recKey, []));
    let sourceId = panel.querySelector('#jvr-source').value;
    let keyword = panel.querySelector('#jvr-kw').value.trim();
    const cat = panel.querySelector('#jvr-cat').value;
    const yearFilter = parseInt(panel.querySelector('#jvr-year').value, 10) || 0;

    // 分类 + 关键字组合：分类并入关键字；若选了分类/关键字但当前是排行榜类固定列表，则改用搜索源
    const FIXED_LIST = ['hot_daily', 'hot_weekly', 'hot_monthly', 'rankings_movies', 'classic'];
    if (cat || keyword) {
      keyword = ((keyword || '') + ' ' + (cat || '')).trim();
      if (FIXED_LIST.indexOf(sourceId) >= 0) sourceId = 'search';
    }
    GM_setValue('jvr_last', { source: sourceId, cat, kw: keyword, year: yearFilter, hide: CONFIG.bayes.hideLowScore, hideRec: CONFIG.hideRecommended });

    const resultsEl = panel.querySelector('#jvr-results');

    // 搜索源必须有“关键字/分类”，否则 API 返回 0（全站高分应走热播榜）
    if (sourceId === 'search' && !keyword) {
      resultsEl.innerHTML = '<div class="jvr-empty">搜索源需输入关键字/分类；想从全站高分推荐请选“高分榜”或“经典高分”</div>';
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
        all = await ad.apiFetch(sourceId, keyword, { yearFilter });
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
        if (sourceId === 'all') await ad.enrichCandidates(all, yearFilter);
      }
      if (!all.length) {
        resultsEl.innerHTML = yearFilter > 0
          ? '<div class="jvr-empty">该数据源没有发行年 ≤ ' + yearFilter + ' 的影片。<br>求老高分请改用“经典高分（跨年，搜老片）”源，或放宽年代条件。</div>'
          : '<div class="jvr-empty">未抓到任何影片，检查选择器/网络</div>';
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
      // 磁链过滤（候选池层面）：只剔除“已确认 0 条磁链”的，未知(null)保留不误杀，
      // 减少最终推荐阶段的递补次数
      if (CONFIG.requireMagnet) {
        const before = lastPool.length;
        lastPool = lastPool.filter((m) => m.magnets !== 0);
        if (before !== lastPool.length) log('磁链过滤(候选池): 移除', before - lastPool.length, '部（确认无磁链）');
      }
      // 年代筛选：只保留发行年 ≤ 阈值的影片（0=不限）。
      // 严格模式（必须 year != null 且 ≤ 阈值）优先；若严格结果不足，退回宽松（保留无年份条目）。
      if (yearFilter > 0) {
        const before = lastPool.length;
        const strict = lastPool.filter((m) => m.year != null && m.year <= yearFilter);
        const hasYearInfo = lastPool.some((m) => m.year != null);
        if (strict.length >= CONFIG.recommendCount) {
          lastPool = strict;
          log('年代过滤: 保留', lastPool.length + '/' + before, '部（发行年 ≤ ' + yearFilter + '，已排除无年份条目）');
        } else if (hasYearInfo) {
          // 数据源带年份信息却几乎没有老片（如“高分榜”只覆盖当年）→ 判定该源不适用，交由空池提示引导换源
          lastPool = strict;
          log('年代过滤: 仅', strict.length + '/' + before, '部发行年 ≤ ' + yearFilter + '（该数据源缺少老片）');
        } else {
          log('年代过滤: 该数据源无发行年字段，无法按年代筛选');
        }
      }
      // 已推荐过滤：剔除本运行开始前已记录的影片（开启时），避免“换一批”重复推荐
      if (CONFIG.hideRecommended && lastRecBefore.size) {
        const full = lastPool;
        let kept = full.filter((m) => !(m.uid && lastRecBefore.has(m.uid)));
        // 不足 recommendCount 时，按综合分补回评分最高的已推荐影片，保证凑够 10 部
        if (kept.length < CONFIG.recommendCount) {
          const hidden = full.filter((m) => m.uid && lastRecBefore.has(m.uid))
            .sort((a, b) => b.composite - a.composite);
          kept = kept.concat(hidden.slice(0, CONFIG.recommendCount - kept.length));
        }
        if (kept.length !== full.length) {
          log('隐藏已推荐: 从候选池移除', full.length - kept.length, '部（来自已推荐记录）');
        }
        lastPool = kept;
      }
      if (!lastPool.length) {
        const tip = yearFilter > 0
          ? '当前数据源没有发行年 ≤ ' + yearFilter + ' 的影片。<br>请改选“经典高分（跨年，搜老片）”源再试。'
          : '候选池为空，换个数据源或放宽筛选条件';
        resultsEl.innerHTML = '<div class="jvr-empty">' + tip + '</div>';
        log('候选池: 0 部，已终止');
        return;
      }
      log('候选池:', lastPool.length, '部 | 评分中…');
      // 先按综合分取候选，再校验磁链并从候选池递补，保证最终推荐全部有磁链
      let picked = randomize
        ? weightedSample(lastPool, CONFIG.recommendCount)
        : topN(lastPool, CONFIG.recommendCount);
      picked = await ensureMagnets(picked, lastPool, randomize);
      if (!picked.length) {
        resultsEl.innerHTML = '<div class="jvr-empty">候选池中没有确认有磁链的影片。<br>可放宽其它筛选条件，或把 CONFIG.requireMagnet 关掉。</div>';
        return;
      }
      // 记录本次推荐影片到“已推荐”集合（供隐藏与标记）；并更新面板计数
      const recNow = new Set(GM_getValue(CONFIG.recKey, []));
      picked.forEach((m) => { if (m.uid) recNow.add(m.uid); });
      GM_setValue(CONFIG.recKey, Array.from(recNow));
      const rcEl = panel.querySelector('#jvr-reccount');
      if (rcEl) rcEl.textContent = String(recNow.size);
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
      if (m.magnets != null) parts.push(m.magnets > 0 ? '磁链 ' + m.magnets : '无磁链');
      if (!parts.length) parts.push('无评分数据');
      // 热力色：贝叶斯加权分 → 蓝(冷)→绿→红(热)
      const c = m.bayes != null ? heatColor(m.hNorm) : 'rgb(154,164,178)';
      const cA = c.replace('rgb(', 'rgba(').replace(')', ',0.2)');
      const badge = m.bayes != null ? '加权 ' + m.bayes.toFixed(2) + ' · ' : '';
      // “已推荐”徽章：本运行前已记录推荐过的影片（本次新增的不标，避免自我标记）
      const recTag = (lastRecBefore && m.uid && lastRecBefore.has(m.uid)) ? '<span class="jvr-rec">已推荐</span>' : '';
      item.innerHTML = `
        <div class="jvr-thumb"><img data-cover="${m.cover}" alt=""></div>
        <div class="jvr-meta">
          <a href="${m.url}" target="_blank" title="${m.title}">${i + 1}. ${m.uid || m.title}</a>
          <div class="jvr-sub">${m.title}</div>
          <div class="jvr-sub">${parts.join(' · ')} · 热度 ${(m.pNorm * 100).toFixed(0)}%</div>
          ${recTag}<span class="jvr-score" style="background:${cA};color:${c}">${badge}综合 ${(m.composite * 100).toFixed(1)}</span>
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
