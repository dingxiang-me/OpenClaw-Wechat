# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.9.5] - 2026-03-08

### Added
- 新增 Bot `thinking_content` 支持：当模型输出包含 `<think>` / `<thinking>` / `<thought>` 标签时，插件会自动拆分正文与思考内容，并通过企业微信 Bot 原生 `thinking_content` 字段展示折叠思考区
- 新增 `thinking-parser` 与回归测试，覆盖闭合标签、未闭合标签和代码块内标签忽略

### Changed
- Bot block/final 流式状态现在会把思考内容单独写入流状态，不再和可见正文混在一起
- Bot stream refresh 现在会把 `thinking_content` 一并返回给企业微信客户端
- Bot block-fallback 在只有思考内容时也能保留思考区，不会直接丢失

### Fixed
- 修复 Bot 流式输出中 `<think>` 标签内容被直接混入正文的问题

## [1.9.4] - 2026-03-08

### Added
- 新增 `wecom:callback:matrix`，可一次检查公网 Agent/Bot 回调以及可选 legacy alias，并直接给出 `route-not-found` / `html-fallback` / `gateway-auth` / `redirect-auth` / `gateway-unreachable`
- 新增公网回调矩阵脚本测试，覆盖全绿链路与常见反代故障分类

### Changed
- `wecom:remote:e2e` 现在会先执行公网回调矩阵检查，再继续账号自检与 Agent/Bot E2E
- `wecom:e2e:scenario` 新增 `callback-matrix` 场景，可单独做公网回调联调
- Agent/Bot 自检脚本统一复用同一套回调健康诊断 helper，减少升级后判断口径漂移

## [1.9.3] - 2026-03-08

### Added
- 新增公网回调 / Gateway Auth 运维文档：补充反向代理、Cloudflare Tunnel、认证豁免与 `curl` 期望返回值
- 新增 Webhook / Heartbeat 运维手册：补充命名 webhook 配置、`openclaw message send` / `openclaw agent --deliver` 用法，以及 OpenClaw `agents.defaults.heartbeat -> target: "wecom" -> to: "webhook:<name>"` 配置示例
- 新增本地链路级回归测试：覆盖 Bot mixed 多图入站到内容构建，以及 Agent 两条加密文本回调经过防抖合并后只触发一次处理

### Changed
- `wecom:selfcheck`、`wecom:agent:selfcheck`、`wecom:bot:selfcheck` 增强公网回调诊断，显式识别 `gateway-auth` / `redirect-auth`
- README（中英文）与渠道文档补充公网回调、反代认证与 Heartbeat 运维说明

## [1.9.2] - 2026-03-08

### Added
- `wecom:agent:selfcheck` 新增 `--all-accounts`，可逐账号执行 Agent URL 验证与加密 POST 体检，输出统一多账号报告
- 新增 Agent 自检回归测试，覆盖多账号发现与 `--url + --all-accounts` 冲突校验

### Changed
- README（中英文）与渠道文档补充 Agent 多账号 E2E 自检命令，文档不再只展示单账号写法

## [1.9.1] - 2026-03-08

### Fixed
- 修复多账号 Agent 会话隔离：默认账号继续使用 `wecom:<userid>`，非默认账号改为 `wecom:<accountId>:<userid>`，避免不同企业微信账号串到同一会话
- 修复 `wecom:selfcheck -- --all-accounts` 与运行时配置解析不一致的问题，统一支持 `channels.wecom.accounts.<id>`、`accounts.<id>.agent` 与 legacy inline 多账号写法
- 修复运行时默认账号回退：显式账号缺失时优先回退到 `channels.wecom.defaultAccount`，再回退到 `default` / 第一个可用账号
- 修复 Agent / webhook 兼容性边界：Agent webhook 非法方法返回更明确，Bot 非法请求体返回稳定 `400`

### Added
- 新增多账号回归测试，覆盖会话 key 生成、`selfcheck` 多账号发现、legacy inline 账号识别与 webhook 边界行为
- README（中英文）新增配置文件路径职责、OpenClaw `bindings` 账号级路由示例和多账号排障说明

## [1.9.0] - 2026-03-08

### Added
- 重大更新：内置 `wecom_doc` 文档工具套件，支持文档/表格/收集表的一整套操作，不需要额外安装第二个插件
- 新增文档基础动作：`create`、`rename`、`get_info`、`share`、`get_auth`、`delete`
- 新增文档权限动作：`grant_access`、`add_collaborators`、`set_join_rule`、`set_member_auth`、`set_safety_setting`
- 新增文档诊断动作：`diagnose_auth`，可直接输出企业内/企业外访问、查看成员、协作者与请求人角色判断
- 新增分享链接诊断动作：`validate_share_link`，可从 guest 视角校验 `blankpage`、`scode`、路径资源 ID 与外部可访问性
- 新增收集表动作：`create_collect`、`modify_collect`、`get_form_info`、`get_form_answer`、`get_form_statistic`
- 新增表格属性动作：`get_sheet_properties`
- 新增创建后自动授权：在企业微信会话里调用 `create` 时，默认把当前请求人自动加入协作者
- 新增高层权限输入：创建文档时即可直接传 `viewers` / `collaborators`
- 新增文档工具测试覆盖：文档 API client、工具注册、权限诊断、分享链接诊断、账号路由、自动授权、manifest/schema

### Changed
- `create` / `share` / `get_auth` / `diagnose_auth` 结果现在会明确返回真实 `docId`，减少把分享链接路径误当 `docId` 的误用
- README 与 WeCom 渠道文档大幅补充文档工具说明、权限诊断说明、分享链接诊断说明和使用示例

### Fixed
- 修复 WeCom 文本格式化误伤 URL 下划线的问题：`markdownToWecomText` 现在会保留链接中的 `_`

## [1.8.0] - 2026-03-06

### Added
- 重大更新：支持 WeCom 后台可视化配置（Control UI 可直接编辑 `channels.wecom`）
- 新增 WeCom 渠道配置 schema 暴露能力，后台配置页可稳定识别并渲染 WeCom 表单
- 新增 WeCom 配置项中文化 UI hints（含敏感字段标记与常用字段说明）
- 新增 WeCom 入站活动状态缓存，用于渠道状态中的 `lastInbound` 可视化展示
- 新增 Bot 卡片回包能力：`channels.wecom.bot.card`（支持 `markdown` / `template_card`）
- 新增卡片回包分层开关：`bot.card.responseUrlEnabled`、`bot.card.webhookBotEnabled`
- 新增 `outbound-bot-card` 模块与回归测试，统一卡片 payload 构建与长度截断
- 新增多账号冲突诊断：启动时输出 `wecom: account diagnosis ...`（重复 callbackToken / bot token、共享路径等）
- 新增场景化远端 E2E 脚本：`npm run wecom:e2e:scenario -- --scenario <bot-smoke|agent-smoke|full-smoke|bot-queue>`
- 新增账号路径诊断单测与默认路径单测（Agent/Bot）
- 新增 sunnoy 风格配置兼容层：支持 `agent.*`、`dynamicAgents.*`、`dm.createAgentOnFirstMessage`
- 新增 legacy inline account 兼容解析（`channels.wecom.<accountId>`）及对应回归测试
- 新增 legacy 指令配置兼容：`commandAllowlist`、`commandBlockMessage`
- 新增 legacy 动态路由模板兼容：顶层 `workspaceTemplate` 自动映射到 `dynamicAgent.workspaceTemplate`
- 新增 legacy 兼容：`dm.allowFrom` 与 `commands.blockMessage`
- 新增 legacy `name` 字段兼容（渠道与账户级）
- 改进命令策略：当配置了 `commands.allowlist`（或 `commandAllowlist`）且未显式关闭时，自动启用命令白名单
- 修复账户级 `dm.allowFrom` 兼容：`accounts.<id>.dm.allowFrom` 在归一化后保持生效
- 调整 manifest：`accounts.<id>` 不再强制 `corpId/corpSecret/agentId`，支持 Bot-only 账号配置
- 新增 Bot 路由兼容：默认新路径会自动注册 legacy alias（`/webhooks/wecom` / `/webhooks/wecom/<id>`），并在与 Agent 路径冲突时自动跳过
- 新增 Agent 路由兼容：默认新路径会自动注册 legacy alias（`/webhooks/app` / `/webhooks/app/<id>`），并在与 Bot 路径冲突时自动跳过
- 新增 Agent 自检增强：`wecom:agent:selfcheck` 在默认新路径场景下会额外探测 legacy alias（`/webhooks/app`）
- 新增远端浏览器 E2E 辅助脚本：`test:e2e:prepare-browser`（沙箱就绪检查）与 `test:e2e:collect-pdf`（回收 PDF 产物）
- 新增远端 E2E 联动参数：`wecom:remote:e2e` / `wecom:e2e:scenario` 支持 `--prepare-browser`、`--collect-pdf`、`--browser-prepare-mode`、`--browser-require-ready`
- 新增一键命令：`npm run wecom:e2e:full`（full-smoke + 浏览器准备检查 + PDF 回收）
- 新增远端 E2E 环境变量兼容：`wecom:remote:e2e` / `wecom:e2e:scenario` 支持 `WECOM_E2E_*` 与 legacy `E2E_WECOM_*` 默认参数注入
- 新增场景化兼容矩阵：`wecom:e2e:scenario --scenario compat-smoke` 支持新旧回调 URL 双链路验证（Agent/Bot）
- 新增兼容矩阵快捷命令：`npm run wecom:e2e:compat`（等价 `wecom:e2e:scenario --scenario compat-smoke`）
- CI 远端联调增强：`workflow_dispatch` 支持选择 `e2e_scenario`、浏览器准备模式与 PDF 回收参数
- FAQ 补充：明确 Bot 模式在“微信插件入口”可见性的产品限制，并给出 Agent/Bot 并行方案建议
- 新增远端矩阵 E2E：`test:e2e:matrix`，覆盖 Bot 回调验签、异常请求、stream-refresh 与重复消息去重链路
- 新增 `matrix-smoke` 场景：`wecom:e2e:scenario --scenario matrix-smoke` 可直接触发 Bot 协议矩阵回归
- 新增 Bot 可见性诊断：`/status` 与 `wecom:bot:selfcheck` 输出“微信插件入口联系人”提示，避免将产品形态差异误判为插件故障
- 新增 Bot 自检多账户参数：`npm run wecom:bot:selfcheck -- --account <id>` 与 `--all-accounts`（支持 scoped `WECOM_<ACCOUNT>_BOT_*` 环境变量）
- 新增安装元数据：`package.json` 增加 `openclaw.install`（`defaultChoice=npm` + `npmSpec=@dingxiang-me/openclaw-wechat`）
- 新增命令兼容映射：`/new` 与 `/clear` 一样会转换为 `/reset`（Agent/Bot 双模式，支持 `/new` 白名单兼容）
- 新增 Bot 自检插件加载诊断：输出 `plugins.enabled / plugins.entry.openclaw-wechat / plugins.allow` 三项结果
- 新增 Bot 自检 URL 验证检查：`e2e.url.verify` 覆盖 `GET echostr` 验签 + 解密回显
- 新增 Bot 自检本地回调健康诊断：可识别 `html-fallback/route-not-found/gateway-unreachable` 并输出修复提示

### Changed
- 渠道状态展示增强：`Connected` 默认按 `running && configured` 计算，不再长期显示 `n/a`
- 账号展示增强：默认账户显示名统一为“默认账号”，避免 UI 中仅显示 `default`
- Agent/Bot webhook 入站链路统一写入活动时间戳，`Last inbound` 展示准确性提升
- Bot 回包链路增强：当无媒体且卡片开启时，`response_url` / `webhook_bot` 优先发送卡片并自动降级文本
- 多账号默认回调路径自动分配：
  - Agent：非 default 账户缺省为 `/wecom/<accountId>/callback`
  - Bot：非 default 账户缺省为 `/wecom/<accountId>/bot/callback`
- `openclaw.plugin.json` 与 README（中英文）补充自动路径与账号体检说明
- Bot 配置解析增强：在 legacy `agent` 配置块存在时，自动将顶层 `token/encodingAesKey/webhookPath` 识别为 Bot 配置
- 动态路由增强：支持私聊/群聊维度开关（`dmCreateAgentOnFirstMessage`、`groupEnabled`）
- 远端 E2E 兼容增强：`test:e2e:remote` 支持 `WECOM_E2E_*` 与 legacy `E2E_WECOM_*` 两套环境变量
- 语法检查范围增强：`test:syntax` 从仅 `src` 扩展到 `src + scripts + tests`，降低脚本/测试回归漏检风险

## [1.7.2] - 2026-03-05

### Changed
- Bot 群聊触发策略收紧：在企业微信官方 Bot 模式下，`groupChat.triggerMode=direct/keyword` 会自动规范为 `mention` 并输出告警，避免“配置可写但平台不回调”的误导
- Bot `/status` 与 `/help` 文案增强：明确“群聊通常仅 @ 机器人消息触发（平台限制）”
- 文档更新：README 与 `docs/channels/wecom.md` 明确 Bot 群聊触发限制与配置降级行为

### Added
- 新增回归测试 `tests/wecom-bot-inbound-executor-helpers.test.mjs`，覆盖 Bot 群聊策略规范化
- 更新命令处理测试，覆盖 Bot 状态文案中的平台限制提示

## [1.7.1] - 2026-03-05

### Added
- 新增事件策略 `events.*`：支持处理 `MsgType=event`，并支持 `enter_agent` 自动欢迎语
- 新增事件策略环境变量：`WECOM_EVENTS_*` 与 `WECOM_<ACCOUNT>_EVENTS_*`
- 新增事件链路测试：覆盖 XML 事件字段解析、事件调度与 `enter_agent` 欢迎语发送

### Changed
- `/status` 增加事件策略状态展示（是否启用事件处理与欢迎语）
- 文档更新：README（中英文）与渠道文档新增事件策略配置说明

## [1.7.0] - 2026-03-05

### Added
- 新增私聊策略 `dm.mode`：支持 `open` / `allowlist` / `deny`，并支持账户级覆盖（`accounts.<id>.dm`）
- 新增私聊策略环境变量：`WECOM_DM_POLICY|MODE`、`WECOM_DM_ALLOW_FROM`、`WECOM_DM_REJECT_MESSAGE`，并支持 `WECOM_<ACCOUNT>_DM_*` scoped 覆盖
- 新增 WeCom 可观测指标存储：入站量、回包成功/失败、错误计数与最近失败样本
- 新增 `/status` 观测输出：展示入站/回包统计、成功率和最近一次失败原因
- 新增 Bot mixed 入站增强：支持 `file/link/location/voice` 子项解析与文件/语音链路接入
- 新增测试覆盖：DM 策略解析/拦截、可观测统计、mixed 文件与语音解析、回包指标记录

### Changed
- Agent/Bot 入站守卫统一接入 DM 策略，按配置执行放行/拒绝
- 回包编排链路统一埋点（active_stream / response_url / webhook_bot / agent_push）并上报最终状态
- Bot 入站内容构建从“单类型”提升为“mixed 聚合”流程，支持同一条 mixed 消息中组合文件与语音内容

### Fixed
- 修复 Bot 入站执行流在新增 DM 策略依赖后的测试注入缺失问题（`resolveWecomDmPolicy is required`）

## [1.6.1] - 2026-03-04

### Added
- Bot 可见性诊断补齐：`/status` 与 `wecom:bot:selfcheck` 新增“微信插件入口联系人”提示，避免将产品形态差异误判为故障
- Bot 体检支持账户维度：`npm run wecom:bot:selfcheck -- --account <id>` 与 `--all-accounts`
- Bot 体检新增插件加载诊断：`plugins.enabled / plugins.entry.openclaw-wechat / plugins.allow`
- 新增脚本级回归测试：覆盖 Bot 体检多账户发现与参数冲突（`--all-accounts` + `--url`）

### Changed
- 命令兼容增强：`/new` 与 `/clear` 在 Agent/Bot 双模式统一映射到 `/reset`，并兼容白名单
- 插件安装元数据完善：`package.json` 增加 `openclaw.install`（`defaultChoice=npm` + `npmSpec=@dingxiang-me/openclaw-wechat`）

## [1.5.0] - 2026-03-04

### Added
- Bot 模式补齐语音 URL 下载 + 本地转写链路：支持从 `voice.url/media_url/download_url/file_url` 拉取音频并接入本地转写
- Bot 多账号能力增强：支持 `channels.wecom.accounts.<id>.bot` 独立配置与 `WECOM_<ACCOUNT>_BOT_*` 环境变量覆盖
- Bot 路由增强：同一路径支持多账户签名匹配并按账户分组注册 webhook
- Bot 回包增强：支持从回复文本中提取 `/workspace/...` 本地图片并自动打包为 `active_stream msg_item(image)`
- 新增/扩展回归测试，覆盖 Bot 多账号、语音转写、workspace 图片打包等关键路径（总测试数提升到 264）

### Changed
- `register-runtime` 启动日志升级：支持展示 Bot 多账户加载状态与 webhook 聚合信息
- `openclaw.plugin.json` 新增 `accounts.<id>.bot` schema 与敏感字段标记
- README（中英文）补充多账户 Bot 覆盖配置与环境变量说明

### Fixed
- 修复 Bot 入站内容构建依赖注入缺失导致的运行时异常（`resolveWecomVoiceTranscriptionConfig is required`）
- 修复 Bot dispatcher 在多账号场景下因未携带匹配账户配置导致的 401 响应问题
- 修复路由注册与依赖工厂在多账号 Bot resolver 接入后的兼容性回归

## [1.4.1] - 2026-03-03

### Added
- 新增配置兼容测试：`tests/wecom-account-config-core.test.mjs`，覆盖旧字段与新字段映射行为
- 自检脚本新增本地 webhook 健康诊断提示（`html-fallback` / `route-not-found` / `gateway-unreachable`）

### Changed
- Agent 账户配置兼容旧字段：`token` / `encodingAesKey` 自动映射到 `callbackToken` / `callbackAesKey`
- `wecom:selfcheck` 与 `wecom:agent:selfcheck` 同步支持旧字段读取，并输出更明确的失败原因
- `openclaw.plugin.json` schema 增加旧字段兼容声明，避免升级后被严格校验拦截

### Fixed
- 修复旧配置字段在新版本下可能导致 webhook 路由未注册、健康探针返回 WebUI HTML 的兼容性问题

## [1.4.0] - 2026-03-03

### Added
- 新增 WeCom 架构拆分模块（本轮核心）：`workspace-*`、`account-config-core`、`api-client-send-*`、`inbound-content-handler-*`、`media-download-*`、`media-url-*`、`webhook-bot-http`、`bot-inbound-dispatch-runtime`
- 新增 Agent 入站错误处理模块：`src/wecom/agent-inbound-error.js`
- 新增 Bot 入站执行辅助模块：`src/wecom/bot-inbound-executor-helpers.js`
- 语法检查脚本升级为自动扫描：`find src -name '*.js' -print0 | xargs -0 -n1 node -c`

### Changed
- 完成一次性“全量拆分”重构：将 WeCom 主链路中的配置解析、入站处理、出站发送、媒体处理、Webhook 适配等大文件拆分为职责模块，保持对外行为兼容
- `agent-inbound-processor`、`bot-inbound-executor`、`webhook-bot`、`inbound-content`、`media-download`、`media-url-utils`、`workspace-tools` 均完成瘦身与分层
- 插件版本升级到 `1.4.0`

### Fixed
- 修复 `smartDecryptWecomFileBuffer` 拆分后 reason 值兼容性（`decrypt-failed`）与日志语义保持一致
- 修复发布前版本元数据不一致问题（`package.json` / `package-lock.json` / `openclaw.plugin.json` 对齐）

## [1.3.3] - 2026-03-03

### Added
- 新增 Agent 入站分发器模块：`src/wecom/agent-inbound-dispatch.js`
- 新增 Agent 入站分发单测：`tests/wecom-agent-inbound-dispatch.test.mjs`
- README / README.en 底部新增 Star History 区块

### Changed
- `agent-webhook-handler` 改为复用入站分发器，去除重复的异步任务分发分支
- 版本号由 `0.5.x` 直接提升为 `1.3.3`

### Fixed
- `accounts` 缺失或非数组时，Agent webhook 健康检查稳定返回 `wecom webhook not configured`，不再走异常路径

## [0.5.4] - 2026-03-03

### Added
- 新增 WeCom 插件依赖注入拆分模块：`plugin-processing-deps`、`plugin-route-runtime-deps`
- 新增 active stream `msg_item` 构建独立模块：`src/wecom/outbound-stream-msg-item.js`
- 新增与本轮拆分配套的单测覆盖（deps 工厂重导出、stream msg_item、媒体判型补充）
- 新增远程 E2E 快捷命令说明：`WECOM_E2E_ENABLE=1 npm run test:e2e:remote`

### Changed
- WeCom 运行时组合层继续瘦身：`plugin-composition` 改为引用拆分后的 deps 模块
- Bot 媒体目标判型逻辑统一到 `media-url-utils` 单一实现，避免多处实现漂移
- 文档澄清自建应用与群机器人边界，明确普通群聊优先使用 Bot 模式

### Fixed
- 修复文档中“自建应用可直接加入普通群”的歧义描述，避免错误部署预期
- 修复媒体类型推断规则不一致（`heic/heif/mkv` 支持差异）导致的回包行为偏差

## [0.5.3] - 2026-03-03

### Added
- 新增 Bot 活跃流恢复索引（session -> stream 历史映射），支持回包阶段按会话兜底恢复可用 stream
- 新增 `/workspace/...` 路径自动提取与宿主机路径映射工具（`extractWorkspacePathsFromText`、`resolveWorkspacePathToHost`）
- 新增 tiny file 文本兜底工具：`buildTinyFileFallbackText`（用于规避企业微信文件上传最小字节限制）
- 新增回归测试：Bot 活跃流恢复、active_stream 媒体链接回包、workspace 路径提取与 tiny file 文本兜底

### Changed
- Agent 出站媒体发送链路新增小文件兜底：`file` 且小于 5 bytes 时自动改为文本回传
- Agent 文本最终回包新增 `/workspace/...` 文件自动回传能力（检测到存在文件时自动发送并追加提示）
- Bot 回包 `active_stream` 层支持媒体链接内容，不再在有媒体时直接判定 `stream-media-unsupported`

### Fixed
- 修复 Bot 回包在 streamId 缺失/失效时无法按会话恢复活跃 stream 的问题
- 修复含中文标点的 `/workspace/...` 路径提取误识别问题

## [0.5.2] - 2026-03-03

### Added
- 新增 Bot 文件下载能力模块：`src/wecom/media-download.js`
- 新增 Bot 文件智能解密：自动识别明文文件并按需解密 AES 媒体，失败自动回退原始字节
- 新增文件名智能推断：支持 `explicitName / Content-Disposition / URL` 多来源合并推断并自动补扩展名
- 新增媒体下载错误构造器：输出 `status/statusText/content-type/url/bodyPreview`
- 新增媒体下载单测：`tests/wecom-media-download.test.mjs`

### Changed
- Bot `msgtype=file` 入站处理升级：文件落盘前接入智能解密与文件名推断
- `fetchMediaFromUrl` 返回结构增强：补充 `contentDisposition/finalUrl/status/source` 元信息

### Fixed
- 修复部分 Bot 文件回调在“已是明文内容”场景被误解密导致文件损坏的问题
- 修复文件名常被回落为泛化名称（如 `file`）导致可读性差的问题
- 修复媒体下载失败日志信息过少、难以定位远端错误的问题

## [0.5.1] - 2026-03-03

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
- Agent 出站媒体补齐语音：支持 `mediaType=voice` 或 `.amr/.silk` 自动判型后上传并发送语音消息
- 文档补充远端 E2E 指令（中英文 README + 渠道文档）
- 文档补充 webhook/Bot 模式媒体回传能力说明（README/README.en/渠道文档）
- Agent 最终回包支持媒体批量发送：可同时处理文本 + 媒体（含部分失败提示）
- 移除仓库内 `docs/compare-sunnoy-gap.md`（仅保留本地副本）
- `chat:wc...` / `group:wr...` 出站目标改为调用企业微信 `appchat/send`，避免旧路径兼容问题
- 远端 E2E 升级为矩阵模式：`wecom:remote:e2e` 支持 `--mode agent|bot|all`
- `wecom:selfcheck` 增加命名 Webhook 目标校验与统计输出
- 账户配置发现/归一化逻辑从 `src/index.js` 拆分到 `src/wecom/account-config.js`，降低主文件复杂度
- 文档补充两类高频问题排查：`/wecom/callback` 返回 WebUI 路由误配、群聊 direct 模式前置条件

### Fixed
- 修复 OpenClaw 2026.3+ 下 WeCom 回调路由注册失败（未显式声明 `registerHttpRoute.auth` 导致 webhook 404）

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
