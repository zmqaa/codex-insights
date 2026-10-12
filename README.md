# Codex Insight

Codex Insight 是本机运行的 Codex 会话 Token 监控工具。它读取 Codex 的 `rollout-*.jsonl` 会话日志，在本地 API 和 React Dashboard 中展示累计 Token、缓存命中率、会话时间线及项目/模型汇总。

Dashboard 使用简体中文界面；统计字段的累计口径会明确区分缓存输入和推理 Token，避免重复计入。

它不会调用 OpenAI API，也不需要登录、密钥、联网服务或数据库。服务只绑定 `127.0.0.1`。关闭网页标签不会停止 Node 服务；请在启动它的终端按 **Ctrl+C** 退出。

## Windows 快速启动

需要 Node.js 22.12 或更新的 LTS 版本（附带 npm）。在项目根目录运行 PowerShell：

```powershell
.\scripts\start-windows.ps1
```

如果 PowerShell 阻止本地脚本，可对这一次调用使用进程级策略，不用修改系统策略：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

脚本会在首次启动时安装依赖、构建前后端，然后以前台进程启动服务。终端会打印本地地址，通常是 `http://127.0.0.1:4173`；若该端口被占用，服务会尝试后续本地端口。按 Ctrl+C 停止服务。

也可以手动执行：

```powershell
npm install
npm run build
npm start
```

### 开发模式

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 前端通过本机代理访问监听在 `127.0.0.1:4174` 的 API。关闭两个开发进程时在终端按 Ctrl+C。

## 静态托管版（浏览器本地读取）

如果要把同款 Dashboard 放到服务器上供其他人打开，可构建纯静态版本：

```powershell
npm run build:hosted
```

将 `apps/web/hosted-dist/` 发布到静态网站服务器即可；推荐使用 HTTPS。访客打开后选择自己的 `.codex` 文件夹（或其中的 `sessions` 文件夹），网页在访客浏览器中递归读取 `rollout-*.jsonl` 并运行相同的解析、聚合和 Dashboard。日志正文、会话路径和统计结果不会发送到托管服务器；服务器只提供网页资源。访问网页本身仍需要连到托管站点。

支持目录访问 API 的浏览器会按设置的间隔增量检查日志，授权句柄会尝试保存在浏览器 IndexedDB 中；浏览器可能在后续访问时要求重新授权。其他浏览器使用目录选择兼容入口生成一次文件夹快照，Codex 继续写入后需要重新选择文件夹更新。若浏览器禁止直接选择目录，请通过 HTTPS 访问，并使用较新的 Chrome 或 Edge。

概览页的 **保存 HTML 快照** 会把当时显示的页面和样式打包成单个离线 HTML 文件。它保留当前图表和统计数据，但属于静态快照；继续变化的数据需要重新生成。

`npm run dev` 和普通的 `npm run build` / `npm start` 仍使用原有本地 Node 扫描器与 API，因此本地 Dashboard 继续实时检查日志；静态托管构建输出到独立目录，不会覆盖本地版。

## 数据源

默认扫描：

- 设置了 `CODEX_HOME` 时，扫描 `${CODEX_HOME}/sessions/`；
- 否则扫描当前用户目录下的 `.codex/sessions/`。

程序递归发现名称符合 `rollout-*.jsonl` 的文件。扫描器只用只读方式打开日志，不修改、截断或删除 Codex 会话文件；它不扫描无关目录，也跳过目录树中的符号链接。若自定义位置，在 **Settings → Session data source** 粘贴一个已存在的绝对目录。目录选择只保存在当前浏览器的本地存储中；也可在启动前设置 `CODEX_INSIGHT_SESSIONS` 环境变量。

首次启动服务会扫描默认目录下的匹配会话日志。开发/验证代码时可将 `CODEX_INSIGHT_SESSIONS` 指向匿名 fixture，避免触碰真实会话文件：

```powershell
$env:CODEX_INSIGHT_SESSIONS = (Resolve-Path .\fixtures).Path
npm start
```

## Token 统计口径

统计核心将 `event_msg` 中 `payload.type = token_count` 的 `payload.info.total_token_usage` 当作**会话累计快照**。它不会逐条相加快照，也不会把 `last_token_usage` 再加到累计值中；相同会话、时间戳和计数的重复快照会去重。时间线和日期汇总使用相邻累计快照的增量。

| 指标 | 定义 |
| --- | --- |
| `total_tokens` | 保留日志报告的累计总量。通常等于输入 + 输出；不一致时保留原始总量并显示校验警告。 |
| 输入 Token | `input_tokens`，**已经包含**缓存输入。 |
| 缓存输入 | `cached_input_tokens`，输入 Token 的子集，不会再叠加进总量。 |
| 未缓存输入 | `max(0, input_tokens - cached_input_tokens)`。缓存超过输入时显示异常提示并将未缓存输入钳制为 0。 |
| 输出 Token | `output_tokens`。 |
| 推理输出 | `reasoning_output_tokens`，输出 Token 的子集，不会再叠加进输出或总量。 |
| 缓存命中率 | `cached_input_tokens / input_tokens × 100%`，显示两位小数；输入为 0 时显示 N/A。 |

### API 价格等值估算

Dashboard 的“API 价等值”和按模型统计使用 OpenAI 官网公开的 Standard 短上下文 API 美元单价，按模型分别计算：未缓存输入 × 输入单价 + 缓存输入 × 缓存输入单价 + 输出 × 输出单价，再除以 1,000,000。

价格表于 2026-10-12 核对，详见 [OpenAI API 定价](https://developers.openai.com/api/docs/pricing)。这是 API 价格的等值估算，不是 Codex 订阅费用或实际 API 账单；没有公开 API 单价对应的模型（例如内部模型标识）会标为“无 API 价”，不计入小计。会话日志没有逐请求上下文长度、缓存写入或工具费用，因此估算不包含长上下文倍率、缓存写入、工具调用及其他处理模式的额外费用。修改价格表时应同步更新 `apps/server/src/pricing.ts` 中的核对日期和单价。

日期图表按快照时间点的 UTC 日期归属增量；“Today”也按 UTC 日界线计算。界面时间可切换本地时区或 UTC。时间范围统计基于有时间戳的快照增量；缺少时间戳的快照仍包含在全部历史的会话累计值中，但不猜测它属于哪一天。

日志可能发生重置或快照时间乱序。扫描器会对计数下降标记 reset，并将新段当前值计入一次；按时间排序快照，并给出异常/置信度提示。若多个文件合并后无法可靠归属模型，显示“Mixed / unknown”；可靠识别到切换时，增量按快照时的模型上下文归属。该规则是日志可观察信息的最佳归属，不代表模型服务端账单。

**累计 Token 与上下文窗口占用不是同一个指标。** MVP 不从最后一个输入统计或会话累计值推测上下文窗口用量，也不显示未经日志验证的窗口占用。

## 页面功能

- Dashboard：今日、近 7 天、近 30 天、全部历史和自定义时间范围；Token 指标卡、按日堆叠图、项目/模型汇总和近期会话。
- Sessions：按会话 ID、项目名、模型搜索，按项目、模型和时间范围筛选，按最近活动/总量/输出排序。
- Session detail：累计指标、Token 变化曲线、模型分配、快照增量和 reset 事件；支持复制摘要与导出统计 JSON/CSV。
- Settings：自定义会话目录、2/3/5/10 秒刷新周期、主题、时间显示方式和路径隐私设置。默认刷新周期为 3 秒。
- 页面打开时轮询本地 API；服务端按配置周期增量检查日志追加、截断和覆盖。关闭浏览器标签不等于退出服务器。

导出只包含统计数据、项目名、模型名、会话 ID 和统计时间点，不导出提示词、工具输出或源码正文。项目表默认只显示目录末级名称；会话完整日志路径默认隐藏，需在详情或设置中主动显示。

## 本地 API

服务仅监听 IPv4 loopback（`127.0.0.1`），不开放到局域网。请求会校验 Host 和浏览器 Origin；不启用 CORS。API 提供：

- `GET /api/health`
- `GET /api/summary?range=today|7d|30d|all|custom`
- `GET /api/sessions?q=&project=&model=&sort=activity|total|output&page=&limit=`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/timeline`
- `GET /api/projects`、`GET /api/models`
- `GET /api/settings`、`POST /api/settings`、`POST /api/refresh`
- `GET /api/export?format=json|csv&range=...`

绝对源路径不会出现在列表、汇总、导出或手动刷新响应中。`GET /api/settings?revealPath=1` 和会话详情 `?revealPath=1` 仅供界面在用户明确请求显示时使用。设置修改仅接受 loopback 请求，并拒绝非本机 Origin。

## CLI 调试和真实日志复核

CLI 只输出会话统计和项目末级目录名，不输出完整日志路径或会话正文：

```powershell
# 扫描自动发现的默认 sessions 目录
npm run scan

# 显式扫描一个 sessions 根目录
npm run scan -- "C:\Users\you\.codex\sessions"
```

规格中的参考会话值已放入匿名 fixture `fixtures/rollout-reference-session.jsonl`。测试与 CLI 对它得到：

```text
totalTokens             2,279,416
inputTokens             2,241,216
cachedInputTokens       2,146,048
uncachedInputTokens        95,168
outputTokens               38,200
reasoningOutputTokens       7,175
cacheHitRate                 95.75%
```

该 fixture 不含用户的真实日志。本次实现没有读取或修改用户的真实会话日志，因此**尚未用指定的 `rollout-2026-10-12T10-08-22-01a12dde-3fdc-77e3-bb77-0ff66e3adfca.jsonl` 文件做本机复核**。用户可在本机对实际 sessions 根目录运行上面的 CLI，并检查对应会话 ID 的统计。

## 开发和测试

```powershell
npm install
npm test
npm run build
npm run scan -- .\fixtures
```

自动化测试覆盖累计快照解析、重复文件/快照去重、缓存与推理子集口径、缓存率零输入、半行追加、坏行跳过、日志截断/覆盖、时间戳乱序、跨日 UTC 归属、多模型分配、API 路径隐私、跨 Origin 拒绝及统计导出。测试只创建和清理系统临时目录中的合成 JSONL 文件，不接触 Codex 原始会话日志。

## 已知限制

- 扫描结果保存在 Node 进程内存中；进程重启后会重新扫描原始 JSONL。自定义目录和显示偏好保存在浏览器本地存储中。
- 文件列表每次轮询会递归检查目录并比较文件元数据，但只读取新增字节；大量历史日志会占用更多内存和聚合时间。
- 日期归属采用 UTC；缺失时间戳的快照无法分配到日期范围。
- 多模型使用依据日志中的 `turn_context` 与 Token 快照时间归属；信息不足时显示混合/未知。
- 不显示未经日志证实的上下文窗口占用；不估算 API 等效价格或 Plus 账户账单。
- 关闭标签页不会自动结束服务，MVP 需要在启动终端按 Ctrl+C。暂不包含系统托盘、后台服务或单实例管理。
