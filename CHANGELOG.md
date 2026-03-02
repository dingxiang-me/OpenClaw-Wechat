# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- 新增远端 Bot 端到端脚本：`npm run wecom:remote:e2e -- --bot-url <公网回调>`
- 新增回包编排模块：`src/wecom/outbound-delivery.js`
- 新增回包编排单测：`tests/wecom-outbound-delivery.test.mjs`
- 新增入站内容构建模块：`src/wecom/inbound-content.js`
- 新增入站内容构建单测：`tests/wecom-inbound-content.test.mjs`
- 新增 Bot `msgtype=file` 入站处理：下载文件并注入会话上下文
- 新增 Bot 引用消息上下文透传：支持解析并前置 `quote` 内容
- 新增本地媒体路径回传支持：`/abs/path`、`file://`、`sandbox:/...`
- 新增 Bot `feedback.id` 透传：首包与 stream-refresh 回包可携带 feedback
- 新增 WeCom 出站目标解析：支持 `user/group/party/tag` 目标格式
- 新增动态 Agent workspace 模板播种：`dynamicAgent.workspaceTemplate` 在首条命中时自动复制 bootstrap 文件
- 新增 `webhook` 目标直发能力：`outbound.sendText` 与 `inbound.deliverReply` 支持 `webhook:<url|key>` 文本/媒体回传
- 新增命名 Webhook 目标映射：支持 `channels.wecom.webhooks` / `accounts.<id>.webhooks` 与 `WECOM_WEBHOOK_TARGETS`
- 新增 Agent 端到端自检脚本：`npm run wecom:agent:selfcheck`（URL 验证 + 加密 POST）
- 新增状态可观测项：`/status` 与 Bot `/status` 增加命名 Webhook 目标统计

### Changed
- P3 模块化拆分第一步：Bot 回包链路从 `src/index.js` 抽离到独立模块（保持行为兼容）
- Bot 模式媒体回传补齐：`response_url` mixed 优先，`webhook_bot` fallback 支持 `image/file` 回传（失败自动降级链接）
- 文档补充远端 E2E 指令（中英文 README + 渠道文档）
- 文档补充 webhook/Bot 模式媒体回传能力说明（README/README.en/渠道文档）
- Agent 最终回包支持媒体批量发送：可同时处理文本 + 媒体（含部分失败提示）
- 移除仓库内 `docs/compare-sunnoy-gap.md`（仅保留本地副本）
- `chat:wc...` / `group:wr...` 出站目标改为调用企业微信 `appchat/send`，避免旧路径兼容问题
- 远端 E2E 升级为矩阵模式：`wecom:remote:e2e` 支持 `--mode agent|bot|all`
- `wecom:selfcheck` 增加命名 Webhook 目标校验与统计输出

## [0.5.0] - 2026-03-02

### Added
- 新增动态 Agent 路由模式：`channels.wecom.dynamicAgent.mode`（`deterministic` / `mapping` / `hybrid`）
- 新增确定性 Agent ID 生成配置：`idStrategy`、`deterministicPrefix`、`autoProvision`、`allowUnknownAgentId`
- 新增群聊触发模式：`channels.wecom.groupChat.triggerMode`（`direct` / `mention` / `keyword`）
- 新增群聊关键词触发配置：`channels.wecom.groupChat.triggerKeywords`
- 新增差异对比文档：`docs/compare-sunnoy-gap.md`

### Changed
- 动态路由核心改造：支持按用户/群确定性生成稳定 Agent 路由键
- 回包路由器返回结构增强：新增 `deliveryPath`、`finalStatus` 与每层 `attempt` 的耗时/状态
- 自建应用链路默认关闭“处理中/排队中”提示，仅保留异步补发观察链路
- 状态输出增加动态路由 mode 与群聊触发模式可视化

### Fixed
- 修复群聊 direct 模式下不必要的 `@` 剥离导致命令识别偏差
- 修复回包降级链路缺少可观测字段，导致问题定位成本高的问题

## [0.4.10] - 2026-03-02

### Added
- 新增动态 Agent 路由策略：`channels.wecom.dynamicAgent.*`（支持 `userMap/groupMap/mentionMap/adminUsers`）
- 新增动态路由核心模块：`src/core/agent-routing.js`
- 新增 Webhook 统一适配层：`src/wecom/webhook-adapter.js`（Bot JSON 与自建应用 XML 入站抽象）
- 新增 Bot `msg_item` 图文回包能力（支持 `response_url` 发送 mixed payload）
- 新增测试：动态路由与适配层（`tests/wecom-p1-routing-adapter.test.mjs`）
- 新增 Bot 端到端自检脚本：`npm run wecom:bot:selfcheck`
- 自检覆盖 Bot 回调全链路：`GET 健康探针`、`POST 签名+加密消息`、`stream-refresh` 轮询回包
- `wecom:smoke` 新增可选开关：`--with-bot-e2e`（回归时可一并跑 Bot E2E）

### Changed
- 自建应用与 Bot 链路统一接入 `routeOverrides`，确保动态路由结果真实生效
- `/status` 与 Bot `/status` 增加动态路由状态展示
- 自建应用模式默认不再发送“消息已收到，正在处理中，请稍等片刻。”
- Bot 模式新增独立超时参数：`channels.wecom.bot.replyTimeoutMs` / `WECOM_BOT_REPLY_TIMEOUT_MS`
- 文档补充 Bot 自检与超时参数说明（中英文 README + 渠道文档）

### Fixed
- 修复媒体结果仅有 `mediaUrl/mediaUrls` 时 Bot 回包只能文本兜底的问题
- 移除遗留 `clawdbot.plugin.json`，避免旧架构文件干扰 OpenClaw 原生插件加载
- 修复文档对“处理中提示”行为描述过时的问题

## [0.4.9] - 2026-03-02

### Added
- 新增企业微信 AI 机器人 Bot 模式（JSON 回调）配置：`channels.wecom.bot.*` / `WECOM_BOT_*`
- 新增 Bot 模式原生 stream 路由：支持 `msgtype=stream` 刷新请求与增量内容回包
- 新增 Bot 流式会话状态管理与过期清理
- 新增核心测试覆盖 Bot 模式配置解析与环境变量回退

### Changed
- 文档明确区分两种模式：
  - Bot 模式：原生 stream（推荐）
  - Agent 模式：多消息增量回包（非原生 stream）
- `register` 启动逻辑支持 Bot-only 场景（无需自建应用账号也可加载路由）

## [0.4.8] - 2026-03-02

### Added
- 新增 WeCom 可配置流式回复：`channels.wecom.streaming.*` / `WECOM_STREAMING_*`
- 新增流式参数：最小增量字符数（`minChars`）与最短发送间隔（`minIntervalMs`）
- 新增核心测试覆盖流式配置解析与边界收敛

### Changed
- WeCom 回复链路接入 block 增量发送（以多条文本消息模拟流式，适配企业微信不可编辑消息限制）
- `/status` 命令新增流式回复状态展示
- 文档与示例同步新增流式配置（`README.md`、`.env.example`、`openclaw.plugin.json`）

## [0.4.7] - 2026-03-02

### Added
- 新增 WeCom 超时后异步补发链路：dispatch 超时/排队时自动轮询 transcript 并在拿到 final 后回推企业微信
- 新增异步补发调优参数：`WECOM_LATE_REPLY_WATCH_MS`、`WECOM_LATE_REPLY_POLL_MS`

### Changed
- `dispatch timed out` 不再立即返回失败文案，优先切换到“处理中 + 异步补发”流程
- 新增超时后晚到 dispatcher 回包抑制，避免与异步补发并发造成重复回复

### Fixed
- 修复会话排队或长耗时场景下，用户只收到“处理中/超时”而收不到最终回复的问题

## [0.4.6] - 2026-03-01

### Added
- 新增发送者授权策略：`channels.wecom.allowFrom`、`channels.wecom.accounts.<id>.allowFrom`
- 新增发送者未授权拒绝文案：`allowFromRejectMessage`、`WECOM_ALLOW_FROM_REJECT_MESSAGE`
- 新增核心测试覆盖 `allowFrom` 解析、账户级覆盖与授权判定

### Changed
- 群聊 mention 触发匹配从简单 `includes` 升级为边界感知匹配，降低邮箱文本误触发
- 群聊 mention 清理逻辑增强：移除 `@提及` 时不再误删 email 片段
- `/status` 增加发送者授权策略状态展示

### Fixed
- 修复账户级 `allowFrom` 无法覆盖全局配置的问题
- 修复 `requireMention=true` 场景中 `test@example.com` 被误判为 mention 的问题

## [0.4.5] - 2026-03-01

### Added
- 新增命令白名单策略：`channels.wecom.commands.*` 与 `WECOM_COMMANDS_*`
- 新增管理员绕过配置：`channels.wecom.adminUsers` 与 `WECOM_ADMIN_USERS`
- 新增群聊触发策略：`channels.wecom.groupChat.*` 与 `WECOM_GROUP_CHAT_*`
- 新增文本防抖合并：`channels.wecom.debounce.*` 与 `WECOM_DEBOUNCE_*`
- 新增核心测试覆盖命令解析、策略配置和防抖配置边界

### Changed
- 文本入站链路接入防抖调度；命令消息优先直通，自动冲刷队列
- `/status` 增加命令白名单、群聊触发、防抖状态展示
- 版本升级为 `0.4.5`

### Fixed
- 修复新策略已实现但未接入主处理链路的问题（文本仍走旧路径）
- 修复群聊场景下命令判定偏差（支持先去除 mention 再识别 `/` 指令）

## [0.4.4] - 2026-03-01

### Added
- 新增 WeCom API 出站代理支持：`channels.wecom.outboundProxy`、`channels.wecom.accounts.<id>.outboundProxy`
- 新增环境变量代理支持：`WECOM_PROXY` 与 `WECOM_<ACCOUNT>_PROXY`
- 新增代理配置解析测试，覆盖账户级/渠道级/环境变量优先级
- 新增媒体回包自动判型：`deliverReply` 支持 `image/video/file`，并可基于 URL 后缀推断

### Changed
- 所有 WeCom API 调用链路（`gettoken`、消息发送、媒体下载/上传）统一接入代理能力
- `/status` 命令新增代理状态提示（已启用/未启用）
- 版本升级为 `0.4.4`

## [0.4.3] - 2026-03-01

### Added
- 新增语音转写回退链路：当企业微信回调未提供 `Recognition` 时，插件会自动下载语音并调用本地 `whisper-cli/whisper`
- 新增 AMR/非兼容格式自动转码：支持用 `ffmpeg` 转为 `wav` 后再转写
- 新增本地转写配置项：`channels.wecom.voiceTranscription.*`（provider/command/modelPath 等）
- 新增语音相关核心测试：配置解析与音频格式判断

### Changed
- `/status` 命令新增语音转写状态展示（模型、启用状态）
- 语音失败时改为主动回包错误原因，避免“无响应”体感
- 版本升级为 `0.4.3`

### Fixed
- 修复本地语音转写临时文件过早清理问题：避免 `whisper-cli` 偶发读取不到输入文件（code 2）

## [0.4.1] - 2026-02-28

### Changed
- 插件元数据全面对齐 OpenClaw：`package.json`、`openclaw.plugin.json`、运行时版本统一为 `0.4.1`
- `/status` 命令支持按当前账户显示，避免多账户场景下状态误报
- callback 验签不再输出敏感 token 信息，日志仅保留账户与路由信息

### Added
- 多账户 webhook 路由：按 `webhookPath` 分组注册，并按签名动态匹配账户
- 多账户同路径支持：同一路径下可通过不同 callback token/AES key 区分账户
- 临时文件延迟清理机制：媒体文件保留 30 分钟后自动删除，兼容排队执行场景
- `wecom:selfcheck` 自检脚本：校验配置、AES Key、`gettoken` 连通性与本地 webhook 健康
- `wecom:selfcheck --all-accounts` 批量体检：一次检查全部已发现账户并支持 JSON 报告
- `wecom:smoke` 回归脚本：串联语法检查、全账户体检、网关健康与状态摘要
- `tests/wecom-core.test.mjs`：覆盖会话 key、去重、签名匹配、分段逻辑等核心回归
- 并存排查文档：`docs/troubleshooting/coexistence.md`

### Fixed
- 修复旧实现只注册单一路由、导致 `channels.wecom.accounts` 实际不可用的问题
- 修复 `pairing required/no deliverable reply` 场景下可能过早删除媒体临时文件的问题
- AES key 增加长度校验，错误配置将明确报错（避免静默异常）
- 修复部分场景下仅产生 block 回复导致用户“看起来无回复”的问题：现在会回退发送累计 block 文本
- 修复长文本分段时的 `trim` 内容损失问题（保留原始空白与换行）

## [0.3.2] - 2026-01-29

### Added

#### 媒体消息扩展
- **视频消息接收**：支持接收用户发送的视频，自动下载保存到临时目录
- **视频消息发送**：新增 `sendWecomVideo()` 函数，支持发送视频到企业微信
- **文件消息接收**：支持接收用户发送的文件/文档，自动识别可读类型（.txt, .md, .json, .pdf 等）
- **文件消息发送**：新增 `sendWecomFile()` 函数，支持发送文件到企业微信
- **链接分享消息**：支持接收用户分享的链接，提取标题、描述和 URL

#### Chat UI 集成
- **消息同步到 Transcript**：用户消息和 AI 回复写入 session transcript 文件
- **实时广播**：通过 gateway broadcast 实时推送消息到 Chat UI
- **Gateway 方法**：新增 `wecom.init` 和 `wecom.broadcast` 方法

### Changed
- `processInboundMessage()` 函数签名扩展，支持更多消息类型参数
- HTTP 路由处理器新增 video、file、link 类型消息分发

## [0.3.1] - 2026-01-28

### Fixed
- **消息分段按字节计算**：企业微信限制 2048 字节（非字符），中文占 3 字节，修复长消息被截断问题
- **新增 getByteLength() 函数**：精确计算 UTF-8 字节长度
- **二分查找分割点**：使用二分查找算法精确定位字节分割位置

### Added
- **处理状态提示**：收到消息后立即发送"⏳ 收到您的消息，正在处理中，请稍候..."，缓解用户等待焦虑
- **详细调试日志**：记录分段数量、字节长度等信息便于排查问题

## [0.3.0] - 2026-01-28

### Added

#### 阶段一：核心稳定性
- **Token 并发安全**：使用 Promise 锁防止多个请求同时刷新 access_token
- **消息自动分段**：超过 2048 字符的消息自动在自然断点处分割发送
- **XML 安全加固**：禁用实体处理防止 XXE 攻击，添加 1MB 请求体限制
- **错误处理完善**：记录完整堆栈日志，二次发送失败不再吞没异常

#### 阶段二：媒体功能
- **图片上传**：新增 `uploadWecomMedia()` 函数上传临时素材
- **图片发送**：新增 `sendWecomImage()` 函数发送图片消息
- **图片 Vision**：下载用户图片保存到临时文件，AI 可读取分析
- **deliverReply 媒体支持**：支持 `mediaUrl` 和 `mediaType` 参数

#### 阶段三：用户体验
- **命令系统**：支持 `/help`、`/status`、`/clear` 命令
- **Markdown 转换**：AI 回复中的 Markdown 自动转换为可读纯文本格式
- **API 限流**：RateLimiter 类限制并发（最多 3 个）和频率（200ms 间隔）

#### 阶段四：高级功能
- **多账户支持**：Token 缓存按账户隔离，支持 `WECOM_<ACCOUNT>_*` 格式配置
- **语音转文字**：支持企业微信自带语音识别（Recognition 字段）
- **群聊支持**：capabilities 支持 group 类型，群聊会话 ID 格式 `wecom:group:<chatId>`

### Changed
- `capabilities.media.outbound` 改为 `true`
- `capabilities.markdown` 改为 `true`
- `capabilities.chatTypes` 改为 `["direct", "group"]`
- 插件版本升级至 0.3.0

### Fixed
- 修正 capabilities 声明与实际实现不符的问题
- 修复长消息可能导致发送失败的问题

## [0.1.0] - 2026-01-27

### Added
- 初始版本
- 基础文本消息收发
- 消息加解密和签名验证
- access_token 缓存
- 图片消息接收（仅传 URL）
