// ==UserScript==
// @name         JAV 智能推荐 (javdb / javbus)
// @namespace    https://github.com/quakewx1981/jv-recommender
// @version      1.01.001
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
// 升级版本时，请同步修改下方两个 URL 里的文件名（保持版本号一致）
// @updateURL    https://raw.githubusercontent.com/quakewx1981/jv-recommender/main/jv-recommender.meta.js
// @downloadURL  https://raw.githubusercontent.com/quakewx1981/jv-recommender/main/jv-recommender-1.01.001.user.js
// @run-at       document-idle
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_addStyle, GM_setValue, GM_getValue */

(function () {
  'use strict';

  /* ============================== 配置区 ============================== */
  // 想调权重 / 抓几页 / 改选择器，都改这里。
  const CONFIG = {
    version: '1.01.001',
    recommendCount: 10,      // 推荐数量
    fetchPages: 5,           // 每个数据源最多抓取的列表页数（候选池大小）
    pageDelay: 250,          // 翻页抓取间隔(ms)，避免被限流
    weights: { rating: 0.6, popularity: 0.4 }, // 综合评分权重
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

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /* ============================== 站点适配器 ============================== */
  // 每个适配器负责：构造数据源 URL、解析单页影片。
  const adapters = {
    javdb: {
      name: 'javdb',
      // 候选来源类型
      sources: [
        { id: 'rank_week', label: '排行榜(周)' },
        { id: 'rank_month', label: '排行榜(月)' },
        { id: 'search', label: '关键字搜索' },
        { id: 'current', label: '当前页面' },
      ],
      // 常见分类（按名称走搜索，近似分类筛选）
      categories: ['剧情', '爱情', '喜剧', '动作', '科幻', '恐怖', '奇幻', '动画', '纪录片', '痴女', '人妻', '巨乳', '萝莉', '潮吹', '肛交', '多人运动', '制服', '角色扮演', '素人', '单体作品'],
      buildUrl(sourceId, keyword, page) {
        const p = page > 1 ? '&page=' + page : '';
        switch (sourceId) {
          case 'rank_week': return origin() + '/rankings?period=week' + (page > 1 ? '?page=' + page : '');
          case 'rank_month': return origin() + '/rankings?period=month' + (page > 1 ? '?page=' + page : '');
          case 'search': return origin() + '/search?q=' + encodeURIComponent(keyword || '') + p;
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
          out.push({
            id,
            uid: uid ? uid.textContent.trim() : '',
            title: title ? title.textContent.trim() : '',
            cover: cover ? (cover.getAttribute('data-src') || cover.getAttribute('src')) : '',
            rating,
            position: baseOffset + i + 1,
            url: absUrl(href),
            source: ctx.sourceId,
          });
        });
        return out;
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
          out.push({
            id,
            uid: uidEl ? uidEl.textContent.trim() : '',
            title: info ? info.textContent.replace(/\s+/g, ' ').trim() : '',
            cover: cover ? (cover.getAttribute('data-src') || cover.getAttribute('src')) : '',
            rating,
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
    // javdb 评分 0-10；奇葩值做个夹紧
    let v = r;
    if (v > 10) v = v / 10;
    return Math.max(0, Math.min(1, v / 10));
  }

  function buildCandidates(movies, sourceId) {
    // 热度归一：列表越靠前越热门（排行榜本身即热度排序）
    const maxPos = Math.max(...movies.map((m) => m.position), 1);
    return movies.map((m) => {
      const rNorm = normalizeRating(m.rating);
      const pNorm = 1 - (m.position - 1) / Math.max(maxPos - 1, 1); // 0~1
      let composite;
      if (rNorm == null) {
        // 无评分站点（javbus）仅靠热度
        composite = pNorm;
      } else {
        composite = CONFIG.weights.rating * rNorm + CONFIG.weights.popularity * pNorm;
      }
      return Object.assign({}, m, { rNorm, pNorm, composite });
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
      #jvr-panel { position: fixed; top: 12px; right: 12px; z-index: 999999; width: 340px;
        background: #1c1f26; color: #e8e8e8; border: 1px solid #333; border-radius: 10px;
        font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,.5); overflow: hidden; }
      #jvr-panel .jvr-h { display:flex; justify-content:space-between; align-items:center;
        padding: 8px 12px; background:#262b36; cursor:move; font-weight:600; }
      #jvr-panel .jvr-h button { background:#3a4150; color:#fff; border:none; border-radius:5px;
        padding:2px 8px; cursor:pointer; font-size:12px; }
      #jvr-panel .jvr-b { padding: 10px 12px; max-height: 60vh; overflow:auto; }
      #jvr-panel label { display:block; margin: 6px 0 3px; color:#9aa4b2; font-size:12px; }
      #jvr-panel select, #jvr-panel input { width:100%; box-sizing:border-box; padding:6px 8px;
        background:#11151c; color:#e8e8e8; border:1px solid #3a4150; border-radius:6px; }
      #jvr-panel .jvr-row { display:flex; gap:8px; margin-top:8px; }
      #jvr-panel .jvr-row button { flex:1; padding:8px; border:none; border-radius:7px; cursor:pointer;
        font-weight:600; color:#fff; }
      #jvr-panel .jvr-go { background:#2f7d4f; } #jvr-panel .jvr-rand { background:#3a5a8c; }
      #jvr-panel .jvr-item { display:flex; gap:8px; padding:7px 0; border-bottom:1px solid #2a2f3a; }
      #jvr-panel .jvr-item img { width:46px; height:62px; object-fit:cover; border-radius:4px; background:#000; }
      #jvr-panel .jvr-meta { flex:1; min-width:0; }
      #jvr-panel .jvr-meta a { color:#7fb2ff; text-decoration:none; font-weight:600;
        display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #jvr-panel .jvr-sub { color:#9aa4b2; font-size:11px; }
      #jvr-panel .jvr-score { display:inline-block; margin-top:3px; padding:1px 6px; border-radius:4px;
        background:#3a2f1c; color:#ffcf6b; font-size:11px; font-weight:700; }
      #jvr-panel .jvr-log { margin-top:10px; padding:8px; background:#0e1116; border-radius:6px;
        max-height:120px; overflow:auto; font:11px/1.4 monospace; color:#8b94a3; }
      #jvr-panel .jvr-empty { color:#9aa4b2; text-align:center; padding:14px 0; }
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
        <label>关键字（数据源选“关键字搜索”时生效）</label>
        <input id="jvr-kw" placeholder="如 SSIS, 女教师, 4K..." />
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

    panel.querySelector('#jvr-min').onclick = () => {
      const b = panel.querySelector('#jvr-body');
      b.style.display = b.style.display === 'none' ? 'block' : 'none';
    };
    panel.querySelector('#jvr-run').onclick = () => runRecommend(false);
    panel.querySelector('#jvr-rand').onclick = () => runRecommend(true);

    makeDraggable(panel.querySelector('.jvr-h'), panel);

    // 恢复上次配置
    const last = GM_getValue('jvr_last', null);
    if (last) {
      sel.value = last.source || sel.value;
      cat.value = last.cat || '';
      panel.querySelector('#jvr-kw').value = last.kw || '';
    }
    log('站点识别:', site, '| 适配器已加载');
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
    const sourceId = panel.querySelector('#jvr-source').value;
    let keyword = panel.querySelector('#jvr-kw').value.trim();
    const cat = panel.querySelector('#jvr-cat').value;

    // 分类 + 关键字组合：若选了分类且数据源非搜索，则把分类并入关键字走搜索
    if (cat && sourceId !== 'search') {
      keyword = keyword ? (keyword + ' ' + cat) : cat;
    }
    GM_setValue('jvr_last', { source: sourceId, cat, kw: keyword });

    const resultsEl = panel.querySelector('#jvr-results');
    resultsEl.innerHTML = '<div class="jvr-empty">抓取候选中…</div>';

    if (randomize && lastPool.length) {
      render(weightedSample(lastPool, CONFIG.recommendCount), '随机换一批');
      return;
    }

    try {
      let all = [];
      let offset = 0;
      for (let p = 1; p <= CONFIG.fetchPages; p++) {
        const url = ad.buildUrl(sourceId, keyword, p);
        log('抓取:', url);
        const html = await gmFetch(url);
        const doc = parseDoc(html);
        const movies = ad.parse(doc, offset, { sourceId });
        if (!movies.length) { log('第', p, '页无影片，停止翻页'); break; }
        log('第', p, '页解析到', movies.length, '部');
        all = all.concat(movies);
        offset += movies.length;
        if (p < CONFIG.fetchPages) await sleep(CONFIG.pageDelay);
      }
      if (!all.length) {
        resultsEl.innerHTML = '<div class="jvr-empty">未抓到任何影片，检查选择器/网络</div>';
        return;
      }
      lastPool = buildCandidates(all, sourceId);
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

  function render(list, mode) {
    const el = panel.querySelector('#jvr-results');
    if (!list.length) { el.innerHTML = '<div class="jvr-empty">无结果</div>'; return; }
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'jvr-sub';
    head.style.cssText = 'margin:4px 0 6px;color:#9aa4b2;';
    head.textContent = mode + '（共 ' + list.length + ' 部）';
    el.appendChild(head);
    list.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = 'jvr-item';
      const score = m.rating != null ? m.rating.toFixed(2) : '无评分';
      item.innerHTML = `
        <img src="${m.cover}" referrerpolicy="no-referrer" alt="">
        <div class="jvr-meta">
          <a href="${m.url}" target="_blank" title="${m.title}">${i + 1}. ${m.uid || m.title}</a>
          <div class="jvr-sub">${m.title}</div>
          <div class="jvr-sub">评分 ${score} · 热度 ${(m.pNorm * 100).toFixed(0)}%</div>
          <span class="jvr-score">综合 ${(m.composite * 100).toFixed(1)}</span>
        </div>`;
      el.appendChild(item);
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
