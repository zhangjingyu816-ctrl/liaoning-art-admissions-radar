# 辽宁美术设计招生雷达

这是一个不依赖 AI 模型的招生信息监测网站。普通 Node.js 脚本定时访问院校官方招生页面，使用固定关键词筛选美术与设计类公告，并将结果写入网站数据文件。

## 网站功能

- 245 所院校均可点击打开院校档案，按 2024、2025、2026 三年展示已核验专业与待补充项目。
- 全国 3D 地图按城市中心点聚合院校；三维底图连接失败时，完整城市清单仍可使用。
- 九大美院已全部纳入，首批三年档案严格区分“已核验”和“待补充”。
- 只有相邻年度官方专业表都完成核验后，才把专业标为“新增”或“取消”。

## 自动更新

- GitHub Actions 按北京时间每天 09:00—21:30 每 30 分钟运行一次 `scripts/update-admissions.mjs`；22:00—次日 08:59 停止，不调用任何 AI 模型。
- 院校来源配置位于 `config/sources.json`，目前含 15 个官方招生栏目。
- 自动发现结果写入 `dist/data/notices.json`，网页使用合并后的 `dist/data/feed.json`。
- 抓取运行状态写入 `dist/data/status.json`。
- 网站优先读取 GitHub 自动更新的数据，同时保留人工核验的内置记录和本地数据作为故障回退。

自动发现记录会标注“待人工复核”。抓取脚本只使用院校官方域名，不调用 OpenAI 或其他生成式 AI 服务。

### 2027 校考日历

- `config/calendar-2027.json` 保存首批 12 所跟踪院校、核实过的公告及人工校正后的日程。其他官方栏目见 `config/calendar-watch-2027.json`。
- 独立工作流每 30 分钟检查一次，继续使用雷达已发现的线索，并复核院校公开原文。具有明确场次和完整日期的记录会进入 `dist/data/calendar-2027.json`。图片、读不到的公告和不能确认适用范围的日期保留在运行产物「calendar-source-audit」供核对。
- 已确认的新日期或院校公告会触发既有 Pages 发布。小程序可读取网页的 `data/calendar-2027.json`。同一固定事件 ID 的人工日期更新以 `config/calendar-2027.json` 中的记录为准。
- 本地运行 `node scripts/update-exam-calendar.mjs`。如需读取可选 PDF 附件，使用 Poppler 的 `pdftotext`。用 `node --test scripts/update-exam-calendar.test.mjs` 验证识别规则。

## 本地运行

```powershell
node scripts/update-admissions.mjs
python -m http.server 8080 --directory dist
```

然后访问 `http://localhost:8080`。

