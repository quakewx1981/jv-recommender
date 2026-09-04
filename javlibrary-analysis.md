# javlibrary.com 作为数据源 / 镜像源 可行性分析

> 分析背景：接续 jv-recommender（javdb/javbus 推荐油猴脚本）与「飞牛 OS 建 javdb 镜像站」两个既有项目，评估把 **javlibrary.com** 纳入作为补充数据源或镜像目标的可行性。
> 分析时间：2026-09-04
> 重要前提：**本沙箱无法对 javlibrary 做真实 HTML 抓取验证**——沙箱代理到 javlibrary.com 的隧道建立失败（HTTP 000）；WebFetch（独立出口）虽能触达，但被 Cloudflare 挡在挑战页。因此下文「实测」与「推断」已分别标注。

---

## 1. 实时连通性验证（本次实测）

| 探测目标 | 方式 | 结果 |
|---|---|---|
| `jdforrepam.com`（javdb 镜像） | 沙箱代理 curl | ✅ HTTP 200，App API 正常 |
| `api.github.com` | 沙箱代理 curl | ✅ HTTP 200，代理本身正常 |
| `www.javlibrary.com/` | 沙箱代理 curl | ❌ HTTP 000，10s 超时断连（隧道建不起来） |
| `www.javlibrary.com/cn/main.php` | WebFetch（独立出口） | ⚠️ 返回 Cloudflare 挑战页 `Just a moment...`（503/403 类） |

**结论（实测）：**
- 沙箱代理**整体正常**，但出口 IP 被 javlibrary 的 Cloudflare **彻底阻断/不可路由** → 沙箱内无法直连。
- javlibrary 全站处于 **Cloudflare 反爬保护**之后，非浏览器客户端（curl / 简单 fetch）一律拿不到真实 HTML。
- 用户（常熟家庭宽带 + 115 浏览器）在真实浏览器里**可以正常访问** javlibrary —— 这点与 javdb 不同：javdb 在用户侧也常被墙需镜像，javlibrary 在用户侧反而可达。

---

## 2. javlibrary.com 架构与数据（实测 + 常识）

### 已确认（本次）
- Cloudflare 保护，需通过 JS 挑战取得 `cf_clearance` cookie 才能拿到正文；数据中心 IP 会被硬挑战甚至直接封。
- 无公开 JSON API（WebFetch 抓到的挑战页里没有任何 `/api/` 端点或业务签名参数）。

### 业界常识（javlibrary 长期结构，供参考，未在本沙箱逐一验证）
- **服务器渲染 PHP**：路径带语言前缀 `/en/ /cn/ /tw/ /ja/ ...`，`/cn/main.php` 是中文版首页，列出近期新增，分页用 `?page=N`。
- **关键页面**：
  - 影片详情 `vl_movie.php?keyword=...` / `?id=...`
  - 搜索 `vl_searchbyid.php?keyword=...&page=N`
  - 按演员 `vl_star.php?s=...`、按类型 `vl_genre.php?g=...`
- **元数据字段**：标题（/cn/ 含中文译名）、封面（DMM `pics.dmm.co.jp` 或 javlibrary 自有 CDN）、发行日、制作商/发行商、类型标签、演员、样图、**社区星级评分（0.5–5.0 平均分 + 投票数）**。
- **没有** javdb 那种 reviews_count / want_watch / watched 统计；**没有**磁链（磁链是第三方油猴脚本从外部索引站注入的）。
- 封面多为 DMM 外链图，热链常被 referer 拦截；javlibrary 自有 CDN 也存一份。

---

## 3. 两种用途的可行性评估

### 3.1 作为 jv-recommender 油猴脚本的数据源
**可行，但需换思路——脚本内增强，而非服务端爬取。**

- 油猴脚本运行在**用户真实浏览器**里，浏览器已通过 Cloudflare 验证，能直接读已渲染的 DOM → **不存在爬取障碍**。
- 可做的增强（类似现有 JavLibrary Enhancer 类脚本）：
  - 在当前浏览页解析 `.videos .video` 卡片，提取标题/评分/演员 → 做「按评分排序的推荐」。
  - 注入磁链（需接外部磁链索引，javlibrary 自身无磁链）。
- **数据短板**（相对 javdb）：评分只是简单平均星 + 投票数，没有 javdb 的贝叶斯加权 + 评分人数 + 想看/看过；「热度」只能近似用投票数，远不如 javdb 丰富。
- **判断**：javdb 已能很好地满足「评分+热度推荐10部」需求，javlibrary 作为补充价值有限（最大卖点是**中文译名/中文类型**，对中文用户友好）。优先级低。

### 3.2 作为 fnOS 镜像站源
**❌ 不推荐。**

- 镜像 = 服务端爬取，而 javlibrary 同时具备三道服务端死穴：
  1. **Cloudflare**：数据中心 IP 被硬挡，需解 JS 挑战 + 长期维护 `cf_clearance` cookie；
  2. **无 API**：只能逐页爬 HTML，结构一改就崩，脆弱；
  3. **图片外链 DMM**： hotlink 易被拦，镜像图片需另存，存储与版权都麻烦。
- 对比 javdb：javdb 有 **App JSON API + 签名**，且存在可直接连通的镜像域名（jdforrepam.com），服务端爬取顺畅 —— 这正是我们已产出 `javdb-mirror/` 骨架的原因。
- 要让 javlibrary 镜像跑通，得用**住宅代理 + 无头浏览器农场**解 Cloudflare，对「仅自用浏览」属于过度工程。

---

## 4. 结论与建议

1. **镜像站**：继续用 **javdb** 路线（已有 `javdb-mirror/` 骨架），**不要**把 javlibrary 作为镜像源。两者难度不在一个量级。
2. **jv-recommender**：维持 javdb 为主数据源。若想要中文译名/类型，可**另写一个 javlibrary 站内增强脚本**（纯 in-page DOM 解析，零爬取），但优先级低、且磁链仍需外部源。
3. **本次未完成项**：javlibrary 的**真实 HTML 结构**未能在沙箱实测（Cloudflare + 代理阻断）。如需真实验证，请在你的 115 浏览器里做（见下）。

---

## 5. 如何在你本地真实验证（绕过沙箱限制）

沙箱到 javlibrary 不通，但你的真机可以。任选其一：

**A. 浏览器控制台一键 dump 结构**（访问 `https://www.javlibrary.com/cn/main.php` 后按 F12 运行）：
```js
const cards=[...document.querySelectorAll('.videos .video')];
console.log('卡片数:',cards.length);
console.log(cards[0] && cards[0].outerHTML.slice(0,600));
```

**B. 让我写「javlibrary 站内增强油猴脚本」**：在你浏览器内解析 DOM，做评分排序推荐 + 磁链注入，**不依赖任何服务端爬取**，立即可用。需要的话告诉我，我直接产出 `.user.js`。

> 注：沙箱侧任何进一步 curl/WebFetch 探针都会被 Cloudflare 挡回挑战页，无信息增量；真实验证请走上面 A/B。
