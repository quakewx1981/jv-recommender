# JAV 智能推荐（javdb / javbus）

根据影片「评分 + 热度」综合评定，在 javdb / javbus 页面推荐 10 部影片的 Tampermonkey 油猴脚本。

## 功能
- **综合评分** = `0.6 × 评分归一 + 0.4 × 热度归一`（列表越靠前越热）
- **数据源**：排行榜(周/月)、关键字搜索、当前页面
- **分类下拉 + 关键字输入**（分类按名称近似走搜索）
- **「推荐 10 部」** 取综合分 Top10；**「随机换一批」** 加权随机（偏高质量但换花样）
- 右上浮动面板，可拖拽 / 最小化，带调试日志

## 支持站点
- https://www.javdb.com
- https://www.javbus.com

## 安装
1. 安装浏览器扩展 Tampermonkey（或 Violentmonkey）。
2. 将 `jv-recommender-1.01.001.user.js` 内容粘贴进「添加新脚本」并保存；或直接把该 `.user.js` 拖入扩展安装。
3. 打开 javdb / javbus 任意页面，右上角出现面板即可使用。

## 说明 / 已知限制
- javdb 评分依赖封面角标 `.score`；javbus 列表页无评分，仅按热度（列表位置）推荐。
- 选择器默认值基于经验。若站点改版导致抓取为空，请用面板调试日志核对 `CONFIG.dom` 后手动调整。
- 版本号格式 `1.01.001`，文件名与脚本内 `@version` 同步。

## 更新 / 自动更新
- 脚本已配置 `@updateURL` 与 `@downloadURL`，指向本仓库 raw，支持 Tampermonkey / Violentmonkey 自动更新：
  - 检查更新：`jv-recommender.meta.js`（固定文件名，仅含版本信息，体积小、检查快）
  - 下载更新：`jv-recommender-1.01.001.user.js`（带版本号）
- 在扩展里对该脚本开启「检查更新 / 自动更新」即可，无需手动重装。

### 发版步骤（每次升版本都要做）
1. 修改脚本内 `@version` 为新版本（如 `1.01.002`）。
2. 将脚本文件重命名为对应版本号（`jv-recommender-1.01.002.user.js`）。
3. 同步修改脚本内 `@downloadURL` 末尾文件名、本 README「安装」步骤里的文件名。
4. 重新生成 `jv-recommender.meta.js`：把其中 `@version` 与 `@downloadURL` 文件名一并更新到新版本。
5. 提交并推送：
   ```bash
   git add -A && git commit -m "release: v1.01.002" && git push
   ```
