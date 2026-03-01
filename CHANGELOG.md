# Changelog

All notable changes to this project will be documented in this file.

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
