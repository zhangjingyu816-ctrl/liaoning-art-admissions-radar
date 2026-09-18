# 辽宁美术设计招生雷达

这是一个不依赖 AI 模型的招生信息监测网站。普通 Node.js 脚本定时访问院校官方招生页面，使用固定关键词筛选美术与设计类公告，并将结果写入网站数据文件。

## 自动更新

- GitHub Actions 按北京时间每天 09:00—21:30 每 30 分钟运行一次 `scripts/update-admissions.mjs`；22:00—次日 08:59 停止，不调用任何 AI 模型。
- 院校来源配置位于 `config/sources.json`。
- 自动发现结果写入 `dist/data/notices.json`，网页使用合并后的 `dist/data/feed.json`。
- 抓取运行状态写入 `dist/data/status.json`。
- 网站优先读取 GitHub 自动更新的数据，同时保留人工核验的内置记录和本地数据作为故障回退。

自动发现记录会标注“待人工复核”。抓取脚本只使用院校官方域名，不调用 OpenAI 或其他生成式 AI 服务。

## 本地运行

```powershell
node scripts/update-admissions.mjs
python -m http.server 8080 --directory dist
```

然后访问 `http://localhost:8080`。

