# Codex Insight — 本地 Codex Token 监控与分析平台

> 版本：v1.0（MVP 开发规格）  
> 日期：2026-10-12  
> 交付对象：Codex 开发 Agent  
> 项目性质：本地优先、单机使用、可扩展的开源工具

## 1. 项目目标

开发一个在 Windows 为主、兼容 macOS/Linux 的本地 Web 工具，读取 Codex 的本地会话日志，按会话、项目、模型和时间展示**真实累计 Token 用量**，包括输入、缓存输入、未缓存输入、输出、推理输出和缓存命中率。用户打开网页即可查看；打开期间实时刷新；退出后无需常驻服务。

核心问题：Codex `/status` 所示的上下文窗口占用不等于一次会话的累计 Token。应用必须明确区分两者，避免误读。

### 1.1 第一阶段必须实现

- 扫描本机 Codex 会话 JSONL 文件，识别会话及其路径、开始时间、模型（若日志可提供）。
- 会话列表：可搜索、按时间范围 / 项目 / 模型过滤，默认最近活动排序。
- 会话详情：累计 Token 五项指标、缓存命中率、时间趋势、活动时间、数据是否仍在更新。
- 全局概览：今日、近 7 天、近 30 天及全部历史的用量统计；按项目 / 模型聚合。
- 打开网页期间自动检测日志增量并更新（目标延迟 ≤ 5 秒，允许配置）。
- 一键复制会话统计摘要；支持 CSV / JSON 导出**统计数据**，不导出提示词正文。
- 友好的加载、空目录、权限错误、日志损坏状态；深色和浅色主题。
- 可运行的自动化测试、README、Windows 启动方式。

### 1.2 第一阶段明确不做

- 不调用 OpenAI API，不要求登录、联网、密钥或付费。
- 不改变 Codex 客户端原生 UI，也不修改 Codex 原始日志。
- 不实现 Codex Plugin / MCP / DSH 适配（仅做未来扩展的接口设计）。
- 不将 API 等效成本当成 Plus 账户的真实账单；MVP 不依赖动态价格接口。
- 不采集提示词、工具参数、源码正文，不做聊天内容搜索。
- 不引入账号系统、云同步、遥测、远程服务器或复杂数据库。

## 2. 目标用户和使用流程

目标用户是在本地使用 Codex 编程的开发者，想知道单次任务真实消耗了多少 Token，历史哪些会话最“重”，缓存实际是否有效。

使用流程：
1. 运行 `npm run dev`（开发）或生产启动脚本。
2. 浏览器自动或手动打开本地地址（例如 `http://127.0.0.1:4173`，端口允许自动退让）。
3. 程序自动发现默认 `CODEX_HOME`（若设置）或 `~/.codex/sessions/`，如路径不正确可在设置中指定。
4. 首页立即显示近期会话；点击会话查看详细指标及曲线。
5. Codex 继续执行任务时，页面自动更新。关闭启动程序时本地服务退出。

> 注意：关闭浏览器标签页不一定会自动终止 Node 进程。MVP 以显式关闭启动进程作为可靠退出方式；不要错误声称关标签即关服务。可选后续实现桌面包装层来管理生命周期。

## 3. UI 页面及交互需求

### 3.1 Dashboard（首页）

- 顶部显示数据源状态、最后刷新时间、会话总数、扫描文件数、异常日志数。
- 时间范围：今日 / 7 天 / 30 天 / 全部 / 自定义。
- 指标卡：总 Token、输入 Token、缓存输入、未缓存输入、输出、推理输出、缓存命中率。
- 堆叠用量图：按日分组，区别缓存输入、未缓存输入、输出；推理输出是输出的子集，不与输出重复堆叠。
- 按模型与项目汇总表，可排序、点击钻取。
- 最近会话列表及搜索入口。

### 3.2 Sessions（会话列表）

每行展示：会话标识/可用标题、项目路径（默认只展示末级目录）、模型、开始时间、最后活动时间、总 Token、输出 Token、缓存率、状态。可根据实际日志数据缺失显示“未知”，不要猜测。

搜索与筛选：会话 ID、项目名、模型、时间范围；排序：最后活动、总 Token、输出 Token。

### 3.3 Session Detail（会话详情）

- 顶部展示会话 ID、项目、模型（可能存在模型切换）、开始 / 最后更新、日志文件路径（需用户交互后才显示完整路径）。
- 统计卡：`total_tokens`、`input_tokens`、`cached_input_tokens`、`uncached_input_tokens`、`output_tokens`、`reasoning_output_tokens`。
- 比例条 / 图例；必须注明子集关系。
- 累计 Token 随时间变化折线图，允许切换展示各个 Token 维度。
- 事件列表：按时间显示单次统计增量、统计重置或日志异常（不显示对话原文）。
- 显示当前窗口上下文占用**仅当日志中存在对应可验证数据**；和累计 Token 单独展示，不得把最后一次 `input_tokens` 或 `total_tokens` 当作窗口占用。
- 复制摘要、导出统计 JSON/CSV。

### 3.4 Settings（设置）

- Codex 会话根目录；自动发现 / 自定义配置。
- 刷新频率：2 / 5 / 10 秒；默认 3 秒，支持手动刷新。
- 主题与时间格式。
- 隐私模式：默认隐藏完整文件路径；不会读取或展示会话正文。

## 4. 数据来源与解析规范（关键）

### 4.1 文件发现

- 默认扫描 `${CODEX_HOME:-~/.codex}/sessions/` 下递归的 `rollout-*.jsonl` 文件。
- 目录结构、字段名随 Codex 版本可能改变：必须容错，抽象 parser / adapter，不可硬编码依赖某一个日期层级。
- Windows 路径包含空格、中文时应正常工作，注意 UTF-8 与日志尾部正在写入的半行 JSON。
- 扫描文件大小、修改时间；增量读取追加的数据，必要时处理文件缩短/轮转/替换。
- 不读取无关目录，不越权访问敏感文件；路径应经过标准化及安全检查。

### 4.2 JSONL 基础结构

常见事件（示意，实际以日志为准）：

```json
{"timestamp":"2026-10-12T02:15:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2241216,"cached_input_tokens":2146048,"output_tokens":38200,"reasoning_output_tokens":7175,"total_tokens":2279416},"last_token_usage":{}}}}
```

解析逻辑须：

1. 逐行解析；忽略与统计无关的事件。对 `event_msg` + `payload.type=token_count` 识别 `payload.info.total_token_usage`（可能为空）。
2. 同一会话累计快照：**不能逐条求和**。正常情况下以该会话（或同一计数段）最新累计快照为准；绘制时间图时保存快照点。
3. 对统计重置、文件合并、模型切换、重复快照、时间戳乱序等情况设计显式逻辑；不得简单使用“最大值”解决所有问题。若无法可靠合并，需提示数据不确定，并优先避免重复计数。
4. 如有 `last_token_usage`，其含义是单次/最近一次统计，不能再加入 `total_token_usage` 总量。
5. 输入包含缓存：`uncached_input_tokens = max(0, input_tokens - cached_input_tokens)`；应记录异常（如缓存超过输入），不默默产生负数。
6. 输出包含推理：`reasoning_output_tokens ⊆ output_tokens`。总量通常 `total_tokens = input_tokens + output_tokens`；如字段不一致，保留原始记录值并提供校验警告，不要擅自改写。
7. 缓存命中率统一定义：`cached_input_tokens / input_tokens × 100%`（输入为 0 时显示 N/A）。
8. 模型、项目路径、会话 ID 可从 `session_meta` / turn context 等元数据获取；缺失则显示未知。若同一会话多模型使用，不要把全部 Token 直接归给最后一个模型；无法按模型归属时标记“混合/未知”。
9. 日志可能包含累计摘要快照和会话恢复/重置；为避免跨文件重复统计，以稳定会话标识为键，在聚合时去重，清楚记录置信程度。
10. JSONL 末尾正在写入的不完整行先保留缓冲，待完整换行后解析；损坏中间行跳过并记录错误数，不中止全部扫描。

### 4.3 类型建议

```ts
type TokenUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type SessionSummary = {
  id: string;
  startedAt?: string;
  updatedAt?: string;
  projectPath?: string;
  modelNames: string[];
  usage: TokenUsage;
  logPath: string; // 只在服务端保留；API 默认不公开
  warnings: string[];
};

type UsagePoint = {
  timestamp: string;
  usage: TokenUsage;
  model?: string;
  kind: 'snapshot' | 'reset' | 'warning';
};
```

所有数值用整数处理；Node 的 JS Number 在安全整数范围内足够通常使用，超限须明确报错或引入安全序列化策略。

## 5. 技术架构

建议 Monorepo，但不要过度工程化：

```text
codex-insight/
├── apps/
│   ├── web/              # React + TypeScript + Vite
│   └── server/           # Node.js + TypeScript + Fastify 或 Express
├── packages/
│   ├── core/             # 日志解析、增量读取、聚合、类型与计算
│   └── shared/           # 前后端共享 DTO / schema
├── fixtures/             # 匿名化 JSONL 测试样例
├── scripts/              # Windows 启动及构建辅助
├── README.md
└── package.json
```

- Node.js LTS + TypeScript；包管理统一 npm 即可。
- Web：React + Vite；图表选 Recharts / ECharts 任一成熟库；基础 CSS 即可，UI 清晰优先。
- Server：仅监听 `127.0.0.1`；静态页面及本地 API 同源，避免开放 CORS。
- 实时刷新：服务端轮询文件变化或使用 `fs.watch` 辅以可靠轮询；前端通过 2–5 秒轮询或 SSE 更新。
- 数据存储：MVP 不用 SQLite，服务器内存缓存扫描结果；重启时重新加载原始 JSONL。历史大时可增加可重建的磁盘索引，不得把缓存作为唯一数据源。
- API：`GET /api/health`、`GET /api/summary?range=...`、`GET /api/sessions?...`、`GET /api/sessions/:id`、`GET /api/sessions/:id/timeline`、`GET /api/projects`、`GET /api/models`；Settings 的路径修改应本地验证并有访问控制。
- 所有接口仅返回统计、元数据，不返回 prompt、tool output、代码正文。避免泄露完整绝对路径。
- 生产模式应由一个 Node 进程提供静态前端与 API；使用浏览器访问而非需要两个开发服务器常驻。

## 6. 本地安全和隐私

- 默认只绑定 `127.0.0.1`，不暴露到局域网；拒绝由命令行无意配置为公网监听。
- 防止远程网页滥用 localhost API：谨慎处理 Origin、Host、CORS 和可能修改设置的请求；敏感操作应使用本地会话验证或一次性启动令牌。MVP 优先只读 API。
- 防止路径遍历：不提供任意文件读取接口；自定义日志目录仅用于扫描受信任目录下的受支持 JSONL。
- 不记录对话正文到应用日志、缓存、浏览器或导出文件。
- README 清楚说明会话元数据及项目名称可能敏感，本工具默认只本地处理。

## 7. 测试与质量标准

### 7.1 必须具备的单元测试

- 正确解析 `token_count` 累计快照。
- 重复快照不会重复计数。
- 缓存输入不再和总输入重复相加；推理输出不与输出重复相加。
- 缓存命中率计算，包括输入为 0 的处理。
- 不完整 JSONL 末行等待追加；坏行跳过并报告。
- 日志追加、截断/覆盖、重复文件、mtime 变化。
- 多会话、跨天聚合，时区边界；跨日期的会话消耗分配规则要明确。优先使用快照增量时间点进行归属，缺乏可靠时间点时显示估计/未知。
- 同一会话切换模型时，不错误把所有用量算给单一模型。

### 7.2 真实验收基准

用户提供的单一 Codex 会话日志文件名：

`rollout-2026-10-12T10-08-22-01a12dde-3fdc-77e3-bb77-0ff66e3adfca.jsonl`

来自该文件最后一次有效累计统计（须由实际日志复核）：

| 指标 | 期望值 |
|---|---:|
| totalTokens | 2,279,416 |
| inputTokens | 2,241,216 |
| cachedInputTokens | 2,146,048 |
| uncachedInputTokens | 95,168 |
| outputTokens | 38,200 |
| reasoningOutputTokens | 7,175 |
| cacheHitRate | 95.75%（两位小数） |

注意：**258K 是当时 Codex 上下文窗口总容量，不是本会话 Token 累计上限。** 某个时点 `/status` 显示的 97,569 是上下文占用，不能用它替代 2,279,416。

此为验收参考记录，开发期间不要把值硬编码到生产逻辑；应另建匿名化 fixture 覆盖相同统计特点。在用户没有提供真实文件时，保证 fixture 测试通过，实际文件校验步骤写入 README。

### 7.3 完成定义

- `npm install` / `npm run dev` / `npm run build` / `npm test` 全部可运行。
- Windows 11 上可快速启动和打开页面；macOS/Linux 在路径兼容方面有合理实现。
- 页面无明显错误，数据变化后 ≤5 秒刷新（正常本地负载）。
- 正常大小日志扫描无明显卡顿；大量历史日志需增量或分页处理。
- 两位小数的缓存命中率与累计 Token 计算正确。
- 文档明确指标口径、局限及本地隐私说明。

## 8. 实施顺序

**里程碑 A：数据可信**：建立 core 的解析、增量扫描、去重、异常处理与测试；先开发 CLI 调试输出，与 PowerShell 结果对齐。

**里程碑 B：本地 API**：实现会话列表、详情、趋势、聚合与增量刷新；补足接口测试。

**里程碑 C：Dashboard**：实现首页、列表、详情和筛选，使用真实数据而不是假数据；美化布局与空状态。

**里程碑 D：交付**：可执行构建、README、Windows 启动脚本、匿名 fixture、性能和安全检查。

先完成 A，再进入 B/C；**统计正确性高于视觉效果**。

## 9. 后续版本路线（不要在 MVP 中实现）

- v1.1：API 等效成本估算（可编辑的模型单价与生效日期，区分缓存输入/未缓存输入/输出；绝不称为 Plus 实际扣费）；多模型维度更精细。
- v1.2：Codex 内 Skill / Plugin / MCP 查询入口，复用 `packages/core`；不假设可以在 Codex 原生输入框旁永久插入 UI。
- v1.3：DSH / Qwen 统计适配器，标准化不同 Harness 的口径；可横向比较任务耗时、总量、缓存率，但标注不同系统可比性限制。
- v1.4：Windows 系统托盘封装、单实例管理、启动即打开网页、关闭即结束服务。
- v2：会话效率诊断，如重复上下文传输、长时间无输出、压缩节点与成本趋势；判断必须基于可观察证据，避免把高缓存读取量简单归为浪费。

## 10. 交给 Codex 的执行指令

请在**当前空项目目录**中依据本文件实现 Codex Insight MVP。可以自主选择必要的非核心 UI 库，但不得扩大 MVP 范围。优先保证 Token 统计语义正确、Windows 路径和 JSONL 增量读取可靠、本地安全，再做可视化。每完成一个里程碑运行相关测试，最后执行完整构建与测试，并报告：

1. 项目结构、启动命令、主要完成的功能；
2. 测试数量与结果、构建结果；
3. 能否用本地真实会话复核 2,279,416 Token 的基准（若未访问该文件，则明确说明尚未验证）；
4. 已知限制、下一阶段待办。

无需每步都询问用户；遇到不影响安全与架构的实现细节，请合理自行决策。不修改或删除用户原有 `.codex` 日志。
