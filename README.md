# OpenClaw-Wechat 企业微信插件

[中文 README](./README.md) | [English README](./README.en.md)

OpenClaw-Wechat 是一个面向 OpenClaw 的企业微信渠道插件，支持两种接入方式：

- `Agent 模式`：企业微信自建应用（XML 回调，经典模式）
- `Bot 模式`：企业微信智能机器人 API 模式（JSON 回调，原生 stream）
- `Webhook 目标出站`：将消息主动投递到企业微信群 Webhook 或命名 Webhook 目标

适用于“个人微信扫码进入企业微信应用对话”、“企业内员工问答助手”、“多账户多业务线消息分流”等场景。

## 目录

- [重大更新（v1.9.0）](#重大更新v190)
- [功能概览](#功能概览)
- [模式对比](#模式对比)
- [5 分钟极速上手](#5-分钟极速上手)
- [前置要求](#前置要求)
- [安装与加载](#安装与加载)
- [配置文件与路径职责](#配置文件与路径职责)
- [快速开始](#快速开始)
- [文档工具（WeCom Doc）](#文档工具wecom-doc)
- [配置参考](#配置参考)
- [消息能力矩阵](#消息能力矩阵)
- [命令与会话策略](#命令与会话策略)
- [环境变量速查](#环境变量速查)
- [公网回调与 Gateway Auth](#公网回调与-gateway-auth)
- [Webhook 与 Heartbeat 运维](#webhook-与-heartbeat-运维)
- [与其他渠道并存建议](#与其他渠道并存建议)
- [故障排查](#故障排查)
- [开发与发布](#开发与发布)
- [FAQ](#faq)
- [版本与贡献](#版本与贡献)

## 重大更新（v1.9.0）

这次版本的重点不只是“能创建企微文档”，而是把 **WeCom Doc 做成一个可用、可诊断、可运维的完整工具链**。  
现在 `OpenClaw-Wechat` 已经同时具备：

- 后台可视化配置
- WeCom Doc 文档/表格/收集表工具
- 文档权限与协作者管理
- 分享链接可用性诊断
- 文档权限打不开问题的直接诊断
- 链接文本输出完整性修复（URL 下划线不再丢失）

### 这次版本解决了什么

| 场景 | 旧问题 | 现在的处理方式 |
|---|---|---|
| 创建文档后自己打不开 | 文档创建成功，但发起人没被自动授权 | `create` 默认自动把当前企微请求人加入协作者 |
| 分享链接能发出来，但别人打开像“文档不存在” | 无法快速判断是权限、分享码还是 guest 访问问题 | `validate_share_link` 直接诊断 `guest / blankpage / scode / 路径资源 ID` |
| 只知道“更新成员权限成功”，但还是打不开 | 成员权限、查看规则、外部分享是三套概念，容易混淆 | `diagnose_auth` 直接输出企业内/企业外访问、查看成员、协作者与请求人角色 |
| 把分享链接路径当成 `docId` 使用 | 后续 API 调用报 `invalid docid` | `create/share/get_auth` 结果显式返回真实 `docId`，并给出使用提示 |
| 链接里有下划线，发出去后被改坏 | Markdown 清洗误伤 URL | 文本格式化已修复，URL 下划线完整保留 |

### 可视化配置能力（Control UI）

| 项目 | 现状 | 说明 |
|---|---|---|
| WeCom 配置表单 | ✅ | `channels.wecom` 支持在后台页面直接编辑与保存 |
| 中文字段标签 | ✅ | 常用字段（如 `corpId`、`callbackToken`、`accounts.*`）均已中文化 |
| 敏感项标记 | ✅ | `secret/token/aesKey` 字段按敏感项展示 |
| 状态展示 | ✅ | `Connected` 不再长期 `n/a`，默认账号显示名中文化为“默认账号” |
| 入站状态追踪 | ✅ | 收到回调后自动更新 `Last inbound`（重启后首次入站前为 `n/a` 属正常） |
| 文档工具开关 | ✅ | `tools.doc` 等文档相关配置可被 schema 正确识别 |

### 文档工具升级摘要

| 能力层 | 新增内容 |
|---|---|
| 文档基础 | `create`、`rename`、`get_info`、`share`、`delete` |
| 权限管理 | `grant_access`、`add_collaborators`、`set_join_rule`、`set_member_auth`、`set_safety_setting` |
| 运维诊断 | `get_auth`、`diagnose_auth`、`validate_share_link` |
| 表格/收集表 | `get_sheet_properties`、`create_collect`、`modify_collect`、`get_form_info`、`get_form_answer`、`get_form_statistic` |

### 你升级后能直接获得的变化

- 在 OpenClaw 后台的 `Channels -> WeCom` 页面可直接配置并保存核心参数。
- 在同一个插件里直接调用 `wecom_doc`，不需要额外安装第二个 WeCom Doc 插件。
- 现在排查“为什么这个链接打不开”不需要再手翻日志和原始 JSON，工具会直接给出结论。
- 文档创建、协作者授权、分享链接诊断已经形成闭环，适合直接上线给真实企微用户使用。

## 5 分钟极速上手

适合“先跑起来再细调”的场景。

### Step 1. 安装插件

```bash
openclaw plugins install @dingxiang-me/openclaw-wechat
```

如果你是在本地开发或要直接跑仓库源码，再用下面这套：

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

### Step 2. 在 OpenClaw 里启用插件

如果你是通过 `openclaw plugins install` 安装，在 `~/.openclaw/openclaw.json` 增加：

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat"],
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

如果你是源码路径加载，再使用下面这版（多一个 `load.paths`）：

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat"],
    "load": {
      "paths": ["/path/to/OpenClaw-Wechat"]
    },
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

### Step 3. 选择一种模式配置

| 模式 | 回调路径 | 企业微信侧类型 | 最少需要的配置 |
|---|---|---|---|
| Agent（自建应用） | `/wecom/callback` | 自建应用 API 接收 | `corpId/corpSecret/agentId/callbackToken/callbackAesKey` |
| Bot（智能机器人） | `/wecom/bot/callback` | 智能机器人 **API 模式** | `bot.enabled/token/encodingAesKey` |

### Step 4. 重启并自检

```bash
openclaw gateway restart
openclaw gateway status
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --all-accounts
```

### Step 5. 发一条消息验证

| 验证项 | 预期结果 |
|---|---|
| 文本消息 | 机器人返回文本 |
| 图片消息（Bot） | 不再提示“图片接收失败”，可识别图像内容 |
| `openclaw gateway status` | `RPC probe: ok` 且 WeCom 状态正常 |

## 功能概览

### 核心能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 企业微信入站消息处理 | ✅ | 文本、图片、语音、链接、文件/视频（Agent + Bot） |
| AI 自动回复 | ✅ | 接入 OpenClaw Runtime，自动路由 Agent |
| Bot 原生 stream 协议 | ✅ | `msgtype=stream` 刷新与增量回包 |
| Bot 卡片回包 | ✅ | 支持 `markdown/template_card`，失败自动降级文本 |
| 多账户 | ✅ | `channels.wecom.accounts.<id>` |
| 发送者授权控制 | ✅ | `allowFrom` + 账户级覆盖 |
| 私聊策略（DM） | ✅ | `dm.mode=open/allowlist/deny` + 账户级覆盖 |
| 事件欢迎语（enter_agent） | ✅ | `events.enterAgentWelcome*` 可配置 |
| 命令白名单 | ✅ | `/help` `/status` `/clear` `/new` 等 |
| 群聊触发策略 | ✅ | 支持 `direct/mention/keyword` 三种模式 |
| 企业微信文档工具 | ✅ | 内置 `wecom_doc` 工具：创建/重命名/分享/权限管理/收集表/表格属性 |
| 文本防抖合并 | ✅ | 窗口期内多条消息合并投递 |
| 异步补发（超时后） | ✅ | transcript 轮询补发最终回复 |
| 观测统计 | ✅ | 入站/回包/错误计数 + 最近失败样本（`/status`） |
| WeCom 出站代理 | ✅ | `outboundProxy` / `WECOM_PROXY` |

### 媒体能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 图片识别（入站） | ✅ | 支持 URL 下载、类型识别、必要时解密后识别 |
| 图片发送（出站） | ✅ | Agent 模式支持 |
| 语音/视频/文件发送（出站） | ✅ | 自动判型上传后发送（语音支持 AMR/SILK） |
| 语音转写（本地） | ✅ | 企业微信 Recognition 优先，缺失时回退本地 whisper |
| Bot 模式媒体回传 | ✅ | `active_stream` 优先 `msg_item(image)`；失败自动降级媒体链接，`response_url`/Webhook Bot 继续兜底 |
| Bot 思考过程展示 | ✅ | 识别 `<think>/<thinking>/<thought>`，映射到原生 `thinking_content` 折叠区 |
| Bot 文件入站 | ✅ | 支持 `msgtype=file` 下载并注入会话上下文 |
| Bot 引用消息上下文 | ✅ | 自动将 `quote` 内容前置到本轮上下文 |

## 模式对比

| 维度 | Agent 模式（自建应用） | Bot 模式（智能机器人 API） |
|---|---|---|
| 回调数据格式 | XML | JSON |
| 企业微信创建方式 | 应用管理 -> 自建应用 | 智能机器人 -> **API 模式** |
| 回调路径默认值 | `/wecom/callback` | `/wecom/bot/callback` |
| 回复机制 | 主动调用 WeCom 发送 API | 回调响应 `stream` + 轮询刷新 |
| 流式体验 | 多条消息模拟增量 | 原生 stream 协议 |
| 思考展示 | 不适用 | 支持 `<think>` 标签映射到 `thinking_content` |
| 出站媒体（图/语音/视频/文件） | 支持 | 支持（`active_stream msg_item(image)` + `response_url/Webhook` 回包，video 自动按 file 回传） |
| 典型场景 | 标准企业应用、菜单/回调体系 | 对话机器人、连续流式问答 |

### 回调路径规划建议

| 场景 | 建议 |
|---|---|
| 同时开 Agent + Bot | 使用不同路径：`/wecom/callback` 与 `/wecom/bot/callback` |
| 多账户 Agent | 每个账户独立路径（如 `/wecom/sales/callback`） |
| 与 Telegram/Feishu 并存 | 不复用任何 webhook path，避免路由冲突 |

## 前置要求

| 项目 | 说明 |
|---|---|
| OpenClaw | 已安装并可正常运行 Gateway |
| 企业微信管理员权限 | 可创建应用或智能机器人并配置回调 |
| 公网入口 | 企业微信需回调到可访问 URL（常见用 Cloudflare Tunnel） |
| Node.js | 与 OpenClaw 运行环境一致 |
| 本地语音识别（可选） | `whisper-cli` 或 `whisper` |
| ffmpeg（推荐） | AMR 等格式转码时需要 |

## 安装与加载

### 方式 A：通过 OpenClaw 安装（推荐）

```bash
openclaw plugins install @dingxiang-me/openclaw-wechat
```

安装后插件会进入 `~/.openclaw/extensions/openclaw-wechat/`。这个目录主要用于 OpenClaw 运行时发现插件，通常**不建议**直接手改其中的 `package.json`、`package-lock.json`、`openclaw.plugin.json`。

### 方式 B：本地路径加载（开发模式）

```bash
git clone https://github.com/dingxiang-me/OpenClaw-Wechat.git
cd OpenClaw-Wechat
npm install
```

在 `~/.openclaw/openclaw.json` 中配置插件加载：

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-wechat"],
    "load": {
      "paths": ["/path/to/OpenClaw-Wechat"]
    },
    "entries": {
      "openclaw-wechat": {
        "enabled": true
      }
    }
  }
}
```

## 配置文件与路径职责

Issue #25 里问到的几个路径，职责完全不同。先把边界理清：

| 路径 | 应不应该手改 | 作用 |
|---|---|---|
| `~/.openclaw/openclaw.json` | **应该** | OpenClaw 主配置入口。插件加载、`channels.wecom.*`、`bindings`、`env.vars` 都写这里 |
| `~/.openclaw/extensions/openclaw-wechat/package.json` | 一般不要 | 已安装插件包的元数据，不是业务配置入口 |
| `~/.openclaw/extensions/openclaw-wechat/openclaw.plugin.json` | 一般不要 | 插件 manifest / schema，供 OpenClaw 识别配置结构 |
| `~/.openclaw/extensions/openclaw-wechat/package-lock.json` | 不要 | 安装锁文件，不承载运行配置 |
| `~/.openclaw/agents/<id>/sessions/sessions.json` | 不要 | 运行时会话索引，属于状态数据，不是配置文件 |
| `~/.openclaw/agents/<id>/sessions/*.jsonl` | 不要 | 会话 transcript / 运行产物 |

Windows 对应关系也是同一套逻辑，例如：

| Windows 示例路径 | 结论 |
|---|---|
| `D:\\Win\\AppData\\LocalLow\\.openclaw\\openclaw.json` | 这是主配置文件，参数加这里 |
| `D:\\Win\\AppData\\LocalLow\\.openclaw\\extensions\\openclaw-wechat\\openclaw.plugin.json` | 这是插件 schema，不是让你填业务参数的地方 |
| `D:\\Win\\AppData\\LocalLow\\.openclaw\\agents\\main\\sessions\\sessions.json` | 这是运行态索引，不要手动写参数 |

### 参数应该放到哪里

| 参数类型 | 推荐位置 |
|---|---|
| 插件启用 / 加载 | `plugins.enabled`、`plugins.allow`、`plugins.entries.openclaw-wechat` |
| 企业微信业务配置 | `channels.wecom.*` |
| 多账号配置 | `channels.wecom.accounts.<id>.*` |
| 文档工具默认账号 | `channels.wecom.defaultAccount` |
| 账号到 Agent 路由 | OpenClaw 根配置 `bindings` |
| 敏感信息 | 优先 `env.vars.*` 或系统环境变量；其次写入 `openclaw.json` |

### Control UI、文件、环境变量怎么分工

| 方式 | 适合什么 |
|---|---|
| Control UI | 日常调整常规字段：`corpId`、`callbackToken`、`accounts.*`、`tools.doc` |
| `openclaw.json` | 结构化配置、版本管理、多人协作、`bindings` |
| `env.vars` / 系统环境变量 | Secret、代理、不同环境下的覆盖项 |

## 快速开始

### 1) 企业微信侧准备

#### Agent 模式（自建应用）

1. 创建自建应用，拿到 `AgentId`、`Secret`
2. 在“我的企业”拿到 `CorpId`
3. 开启“接收消息”，配置：
   - URL: `https://你的域名/wecom/callback`
   - Token: 自定义随机字符串
   - EncodingAESKey: 企业微信生成

#### Bot 模式（智能机器人）

1. 创建智能机器人时选择 **API 模式**
2. 配置回调 URL：`https://你的域名/wecom/bot/callback`
3. 获取并保存 `token` 与 `encodingAesKey`

### 2) OpenClaw 最小配置示例

#### Agent 最小可用

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "corpId": "wwxxxx",
      "corpSecret": "xxxx",
      "agentId": 1000004,
      "callbackToken": "xxxx",
      "callbackAesKey": "xxxx",
      "webhookPath": "/wecom/callback"
    }
  }
}
```

#### Bot 最小可用（Bot-only）

```json
{
  "channels": {
    "wecom": {
      "enabled": true,
      "bot": {
        "enabled": true,
        "token": "xxxx",
        "encodingAesKey": "xxxx",
        "webhookPath": "/wecom/bot/callback"
      }
    }
  }
}
```

### 3) 启动与验证

```bash
openclaw gateway restart
openclaw gateway status
openclaw plugins list
npm run wecom:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --account default
```

`wecom:selfcheck` 帮助：

```bash
node ./scripts/wecom-selfcheck.mjs --help
```

`wecom:bot:selfcheck` 帮助：

```bash
node ./scripts/wecom-bot-selfcheck.mjs --help
```

## 文档工具（WeCom Doc）

插件现在内置了 `wecom_doc` 工具，不需要额外安装第二个插件。它复用当前 `OpenClaw-Wechat` 的账号、代理和多账户配置。

### 支持的动作

| action | 说明 | 关键参数 |
|---|---|---|
| `create` | 新建文档/表格，可创建后立即授权 | `docName` `docType` `viewers?` `collaborators?` |
| `rename` | 重命名文档 | `docId` `newName` |
| `get_info` | 获取文档基础信息 | `docId` |
| `share` | 获取文档分享信息 | `docId` |
| `get_auth` | 获取文档权限信息 | `docId` |
| `diagnose_auth` | 诊断为什么打不开文档/链接 | `docId` |
| `validate_share_link` | 校验分享链接对 guest/外部访问是否可用 | `shareUrl` |
| `delete` | 删除文档或收集表 | `docId` 或 `formId` |
| `grant_access` | 批量增删查看人/协作者 | `docId` `viewers?` `collaborators?` `remove*?` |
| `add_collaborators` | 快速添加协作者 | `docId` `collaborators` |
| `set_join_rule` | 修改文档可见范围/加入规则 | `docId` `request` |
| `set_member_auth` | 修改文档通知成员与权限 | `docId` `request` |
| `set_safety_setting` | 修改文档安全设置 | `docId` `request` |
| `create_collect` | 创建收集表 | `formInfo` `spaceId?` `fatherId?` |
| `modify_collect` | 修改收集表 | `oper` `formId` `formInfo` |
| `get_form_info` | 获取收集表定义 | `formId` |
| `get_form_answer` | 获取收集表答案 | `repeatedId` `answerIds?` |
| `get_form_statistic` | 获取收集表统计 | `requests` |
| `get_sheet_properties` | 获取在线表格属性 | `docId` |

### 启用方式

默认启用。你也可以显式配置：

```json
{
  "channels": {
    "wecom": {
      "defaultAccount": "docs",
      "tools": {
        "doc": true,
        "docAutoGrantRequesterCollaborator": true
      },
      "accounts": {
        "docs": {
          "corpId": "wwxxxx",
          "corpSecret": "xxxx",
          "agentId": 1000008,
          "tools": {
            "doc": true
          }
        }
      }
    }
  }
}
```

### 账号选择规则

`wecom_doc` 在执行时按下面顺序选择账号：

1. 工具参数里的 `accountId`
2. 当前 agent 绑定账号
3. `channels.wecom.defaultAccount`
4. 第一个启用了文档工具的可用账号

### 创建后自动授权

默认开启：如果 `wecom_doc` 是在企业微信会话里被调用，插件会把当前发送者自动加成文档协作者，避免“文档已创建但发起人无权限查看”。

`create` / `share` 结果现在会明确返回真实 `docId`，后续做权限、分享和诊断时应优先使用这个 `docId`，不要直接拿分享链接路径里的片段代替。

可关闭：

```json
{
  "channels": {
    "wecom": {
      "tools": {
        "doc": true,
        "docAutoGrantRequesterCollaborator": false
      }
    }
  }
}
```

### 使用示例

- “帮我新建一个企微文档，标题是《周会纪要》”
- “把这个文档改名为《Q2 Roadmap》”
- “查询文档 `docxxxx` 的权限信息”
- “诊断为什么这个企微文档链接打不开”
- “校验这个企微文档分享链接为什么对外打不开”
- “创建一个企微文档，并把我加成协作者”
- “给文档 `docxxxx` 添加协作者 `dingxiang`”
- “把文档 `docxxxx` 授权给 `alice` 查看，给 `bob` 协作”
- “把文档 `docxxxx` 的查看规则改成仅企业内部可见”
- “创建一个收集表，标题是《报名表》”
- “查询收集表 `formxxxx` 的定义和题目”
- “读取这份收集表最近一次提交答案”
- “获取这个表格的 sheet 属性”

### 推荐工作流

| 目标 | 推荐动作顺序 |
|---|---|
| 创建后立刻给业务同事协作 | `create` -> `grant_access` / `add_collaborators` |
| 判断“为什么别人打不开这个文档” | `diagnose_auth` -> `validate_share_link` |
| 给外部链接排障 | 先看 `validate_share_link`，再决定是否执行 `set_join_rule` |
| 后续继续操作同一文档 | 始终使用 `create/share` 返回的真实 `docId`，不要直接复制分享链接路径片段 |

### 常见误区

| 误区 | 正确做法 |
|---|---|
| 分享链接路径里的 ID 就是 `docId` | 不一定。以后续工具返回的真实 `docId` 为准 |
| “加了协作者”就等于任何浏览器都能打开 | 不是。协作者权限、企业内访问、企业外访问、外部分享是不同层级 |
| 链接能在企业微信里打开，就代表外部环境也能打开 | 不成立。`guest` 视角可能仍然是 `blankpage` |

## 配置参考

### 主配置键（`channels.wecom`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否启用 WeCom 渠道 |
| `corpId` | string | - | 企业 ID（Agent 模式） |
| `corpSecret` | string | - | 应用 Secret（敏感） |
| `agentId` | number/string | - | 应用 AgentId |
| `callbackToken` | string | - | 回调 Token（敏感） |
| `callbackAesKey` | string | - | 回调 AES Key（敏感） |
| `webhookPath` | string | `/wecom/callback` | Agent 回调路径（非 default 账户未配置时自动生成 `/wecom/<accountId>/callback`） |
| `agent` | object | - | 兼容旧配置：`agent.corpId/corpSecret/agentId`（与顶层 Agent 字段等价） |
| `outboundProxy` | string | - | WeCom 出站代理 |
| `defaultAccount` | string | - | 多账号下的默认账号 ID（文档工具等优先使用） |
| `tools.doc` | boolean | `true` | 是否启用 `wecom_doc` 文档工具 |
| `webhooks` | object | - | 命名 Webhook 目标映射（如 `{ "ops": "https://...key=xxx" }`） |
| `accounts` | object | - | 多账户配置（支持 `accounts.<id>.bot` 独立 Bot 配置） |

兼容说明：支持旧字段与旧结构迁移：`name`、`token` / `encodingAesKey`、`agent.*`、`dynamicAgents.*`、`dm.createAgentOnFirstMessage`、`dm.allowFrom`、`workspaceTemplate`、`commandAllowlist/commandBlockMessage`、`commands.blockMessage`、以及 inline 账户写法 `channels.wecom.<accountId>`。新配置建议优先使用 `accounts.<id>`、`callbackToken/callbackAesKey`、`commands.*` 与 `dynamicAgent.*`。

提示：`accounts.<id>` 现在支持 Bot-only 账号（仅配置 `bot.*`），不再强制要求 `corpId/corpSecret/agentId`。
兼容提示：当使用默认新路径时会自动附加 legacy alias，便于旧回调地址平滑迁移：Agent 默认路径会附加 `/webhooks/app`（多账号为 `/webhooks/app/<id>`），Bot 默认路径会附加 `/webhooks/wecom`（多账号为 `/webhooks/wecom/<id>`）。若 alias 与另一类路由冲突会自动跳过并告警。

### Bot 配置（`channels.wecom.bot`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 启用 Bot 模式 |
| `token` | string | - | Bot 回调 Token（敏感） |
| `encodingAesKey` | string | - | Bot 回调 AESKey（43 位，敏感） |
| `webhookPath` | string | `/wecom/bot/callback` | Bot 回调路径（非 default 账户未配置时自动生成 `/wecom/<accountId>/bot/callback`） |
| `placeholderText` | string | `消息已收到...` | stream 初始占位文案（可设为空字符串） |
| `streamExpireMs` | integer | `600000` | stream 状态保留时间（30s~1h） |
| `replyTimeoutMs` | integer | `90000` | Bot 等待模型回包超时（15s~10m） |
| `lateReplyWatchMs` | integer | `180000` | Bot 超时后异步补发观察窗口（30s~10m） |
| `lateReplyPollMs` | integer | `2000` | Bot 异步补发轮询间隔（500ms~10s） |
| `card` | object | 见下方 | Bot 卡片回包策略（`response_url` / `webhook_bot`） |

> 重要限制：企业微信官方 Bot 在群聊里通常仅对 `@机器人` 消息触发回调。  
> 因此 Bot 模式下即使配置 `groupChat.triggerMode=direct/keyword`，也会按 `mention` 处理（插件会输出告警）。

#### Bot 卡片配置（`channels.wecom.bot.card`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 启用卡片回包 |
| `mode` | string | `markdown` | `markdown`（兼容优先）或 `template_card` |
| `title` | string | `OpenClaw-Wechat` | 卡片标题 |
| `subtitle` | string | - | 卡片副标题 |
| `footer` | string | - | 卡片底部说明 |
| `maxContentLength` | integer | `1400` | 卡片正文最大长度（自动截断） |
| `responseUrlEnabled` | boolean | `true` | 是否在 `response_url` 层发送卡片 |
| `webhookBotEnabled` | boolean | `true` | 是否在 `webhook_bot` 层发送卡片 |

### 多账户 Bot 覆盖配置（`channels.wecom.accounts.<id>.bot`）

当你启用了 `accounts` 多账户时，可以为每个账户单独配置 Bot 回调密钥、路径、超时和代理；若未配置，则回退到 `channels.wecom.bot`。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 是否启用该账户 Bot |
| `token` / `callbackToken` | string | - | 该账户 Bot 回调 Token（兼容旧字段） |
| `encodingAesKey` / `callbackAesKey` | string | - | 该账户 Bot 回调 AESKey（兼容旧字段） |
| `webhookPath` | string | `/wecom/bot/callback` | 该账户 Bot 回调路径 |
| `placeholderText` | string | `消息已收到...` | stream 初始占位文案 |
| `streamExpireMs` | integer | `600000` | stream 状态保留时间 |
| `replyTimeoutMs` | integer | `90000` | Bot 等待模型回包超时 |
| `lateReplyWatchMs` | integer | `180000` | 超时后异步补发观察窗口 |
| `lateReplyPollMs` | integer | `2000` | 异步补发轮询间隔 |
| `card` | object | - | 该账户专用卡片回包配置（覆盖全局 `bot.card`） |

### 多账户文档工具覆盖（`channels.wecom.accounts.<id>.tools`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `doc` | boolean | `true` | 是否启用该账户的 `wecom_doc` 工具 |
| `outboundProxy` / `proxyUrl` / `proxy` | string | - | 该账户 Bot 专用代理（优先于全局） |

### 授权与指令策略

| 模块 | 配置键 | 作用 |
|---|---|---|
| 发送者授权 | `allowFrom` / `accounts.<id>.allowFrom` | 限定可对话用户；支持 `*` |
| 拒绝文案 | `allowFromRejectMessage` | 未授权提示 |
| 管理员 | `adminUsers` | 绕过命令白名单 |
| 命令白名单 | `commands.enabled` + `commands.allowlist` | 限制 `/` 指令 |
| 私聊策略 | `dm.mode` + `dm.allowFrom` + `dm.rejectMessage` | 控制私聊开放/白名单/拒绝 |
| 事件策略 | `events.enabled` + `events.enterAgentWelcomeEnabled` + `events.enterAgentWelcomeText` | 控制事件处理与 enter_agent 欢迎语 |
| 群聊触发 | `groupChat.enabled` + `triggerMode` + `mentionPatterns` + `triggerKeywords` | 控制群消息触发条件（自建应用支持 `direct/mention/keyword`；Bot 模式按平台限制固定 `mention`） |
| 动态路由 | `dynamicAgent.*`（兼容 `dynamicAgents.*`、`dm.createAgentOnFirstMessage`） | 动态 Agent + workspace bootstrap 播种 |

### 吞吐与稳定性

| 模块 | 配置键 | 说明 |
|---|---|---|
| 文本防抖 | `debounce.enabled/windowMs/maxBatch` | 合并短时间多条文本 |
| Agent 增量回包 | `streaming.enabled/minChars/minIntervalMs` | 多消息模拟流式 |
| 异步补发 | `WECOM_LATE_REPLY_WATCH_MS/POLL_MS` | dispatch 超时后补发最终回复 |
| 观测统计 | `observability.enabled/logPayloadMeta` | 记录入站/回包/错误并在 `/status` 展示 |

### 语音转写（本地）

| 键 | 默认 | 说明 |
|---|---|---|
| `voiceTranscription.enabled` | `true` | 开启回退转写 |
| `provider` | `local-whisper-cli` | `local-whisper-cli` / `local-whisper` |
| `command` | 自动探测 | 本地命令路径 |
| `modelPath` | - | whisper-cli 模型路径 |
| `model` | `base` | whisper 模型名 |
| `timeoutMs` | `120000` | 单次转写超时 |
| `maxBytes` | `10485760` | 最大音频大小 |
| `ffmpegEnabled` | `true` | 不兼容格式自动转码 |
| `transcodeToWav` | `true` | 优先转为 wav |

### 多账户示例

```json
{
  "channels": {
    "wecom": {
      "outboundProxy": "http://127.0.0.1:7890",
      "accounts": {
        "default": {
          "enabled": true,
          "corpId": "ww-default",
          "corpSecret": "secret-default",
          "agentId": 1000004,
          "callbackToken": "token-default",
          "callbackAesKey": "aes-default",
          "webhookPath": "/wecom/callback",
          "allowFrom": ["*"]
        },
        "sales": {
          "enabled": true,
          "corpId": "ww-sales",
          "corpSecret": "secret-sales",
          "agentId": 1000005,
          "callbackToken": "token-sales",
          "callbackAesKey": "aes-sales",
          "webhookPath": "/wecom/sales/callback",
          "outboundProxy": "http://10.0.0.5:8888",
          "bot": {
            "enabled": true,
            "token": "sales-bot-token",
            "encodingAesKey": "sales-bot-aes",
            "webhookPath": "/wecom/sales/bot/callback",
            "replyTimeoutMs": 120000,
            "outboundProxy": "http://10.0.0.9:7890"
          },
          "allowFrom": ["alice", "wecom:bob"],
          "allowFromRejectMessage": "销售助手未授权，请联系管理员。"
        }
      }
    }
  }
}
```

### 使用 OpenClaw `bindings` 做账号级 Agent 路由

`OpenClaw-Wechat` 不自己实现第二套路由规则；账号到 Agent 的稳定绑定，直接走 OpenClaw 核心 `bindings`。插件会把 `channel=wecom` 和 `accountId=<id>` 传给核心路由层。

示例：

```json
{
  "bindings": [
    {
      "match": {
        "channel": "wecom",
        "accountId": "sales"
      },
      "agentId": "sales"
    },
    {
      "match": {
        "channel": "wecom",
        "accountId": "support"
      },
      "agentId": "support"
    }
  ]
}
```

这套绑定优先级高于插件里的动态账号猜测，适合多账号、多业务线、同一 OpenClaw 上挂多个 WeCom 入口的场景。

## 消息能力矩阵

### Agent 模式

| 类型 | 入站 | 出站 | 备注 |
|---|---|---|---|
| 文本 | ✅ | ✅ | 自动分段 |
| 图片 | ✅ | ✅ | 入站可识别，出站可发送 |
| 语音 | ✅ | ✅ | 入站支持本地转写回退；出站支持 AMR/SILK |
| 视频 | ✅ | ✅ | 下载并可回包 |
| 文件 | ✅ | ✅ | 下载并可回包 |
| 链接 | ✅ | ❌ | 提取标题/描述/URL |

### Bot 模式

| 类型 | 入站 | 出站 | 备注 |
|---|---|---|---|
| 文本 | ✅ | ✅ | 原生 stream |
| 图片 | ✅ | ✅ | `response_url` mixed + webhook fallback |
| 语音 | ✅ | ✅ | 以文本结果回传 |
| 文件 | ✅ | ✅ | Bot 文件入站下载；出站可按 file 回传 |
| mixed（图文） | ✅ | ✅ | 聚合后回文本 |
| 链接/位置 | ✅ | ✅ | 转换为文本上下文 |

## 命令与会话策略

### 命令

| 命令 | 说明 |
|---|---|
| `/help` | 查看帮助 |
| `/status` | 查看运行状态 |
| `/clear` | 清理会话（兼容映射到 `/reset`） |
| `/new` | 新建会话（兼容映射到 `/reset`） |
| `/reset` | 重置会话 |
| `/compact` | 压缩会话（由上层运行时支持） |

### 会话策略

- 默认账号一用户一会话：`wecom:<userid>`
- 非默认账号一用户一会话：`wecom:<accountId>:<userid>`
- 群聊可配置“仅 @ 才触发”，避免误触发

### 出站目标格式

- `user`：`wecom:alice` / `user:alice`
- `group(chat)`：`group:wrxxxx` / `chat:wcxxxx`（自动走 `appchat/send`）
- `party`：`party:2` / `dept:2`
- `tag`：`tag:ops`
- `webhook`：`webhook:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx` 或 `webhook:key:xxx`
- `webhook(命名)`：`webhook:ops`（从 `channels.wecom.webhooks.ops` 或 `accounts.<id>.webhooks.ops` 解析）

## 环境变量速查

### 核心与回调

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECOM_CORP_ID` | Agent 必填 | 企业 ID |
| `WECOM_CORP_SECRET` | Agent 必填 | 应用 Secret |
| `WECOM_AGENT_ID` | Agent 必填 | AgentId |
| `WECOM_CALLBACK_TOKEN` | Agent 必填 | 回调 Token |
| `WECOM_CALLBACK_AES_KEY` | Agent 必填 | 回调 AESKey |
| `WECOM_WEBHOOK_PATH` | 否 | Agent 回调路径（默认 `/wecom/callback`） |
| `WECOM_WEBHOOK_TARGETS` | 否 | 命名 Webhook 目标映射（`name=url`，多个用 `,`/`;` 分隔） |

### Bot

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECOM_BOT_ENABLED` | 否 | 是否启用 Bot 模式 |
| `WECOM_BOT_TOKEN` | Bot 必填 | Bot Token |
| `WECOM_BOT_ENCODING_AES_KEY` | Bot 必填 | Bot EncodingAESKey |
| `WECOM_BOT_WEBHOOK_PATH` | 否 | Bot 回调路径 |
| `WECOM_BOT_PLACEHOLDER_TEXT` | 否 | stream 占位文案 |
| `WECOM_BOT_STREAM_EXPIRE_MS` | 否 | stream 保留时长 |
| `WECOM_BOT_REPLY_TIMEOUT_MS` | 否 | Bot 等待模型回包超时 |
| `WECOM_BOT_LATE_REPLY_WATCH_MS` | 否 | Bot 超时后补发观察窗口 |
| `WECOM_BOT_LATE_REPLY_POLL_MS` | 否 | Bot 补发轮询间隔 |
| `WECOM_BOT_CARD_ENABLED` | 否 | 是否启用 Bot 卡片回包 |
| `WECOM_BOT_CARD_MODE` | 否 | 卡片模式：`markdown` / `template_card` |
| `WECOM_BOT_CARD_TITLE` | 否 | 卡片标题 |
| `WECOM_BOT_CARD_SUBTITLE` | 否 | 卡片副标题 |
| `WECOM_BOT_CARD_FOOTER` | 否 | 卡片底部说明 |
| `WECOM_BOT_CARD_MAX_CONTENT_LENGTH` | 否 | 卡片正文最大长度 |
| `WECOM_BOT_CARD_RESPONSE_URL_ENABLED` | 否 | response_url 层卡片开关 |
| `WECOM_BOT_CARD_WEBHOOK_BOT_ENABLED` | 否 | webhook_bot 层卡片开关 |
| `WECOM_<ACCOUNT>_BOT_*` | 否 | 账户级 Bot 覆盖（如 `WECOM_SALES_BOT_TOKEN`） |
| `WECOM_<ACCOUNT>_BOT_PROXY` | 否 | 账户级 Bot 媒体下载/回包代理 |

### 策略与流控

| 变量 | 说明 |
|---|---|
| `WECOM_ALLOW_FROM` / `WECOM_<ACCOUNT>_ALLOW_FROM` | 发送者白名单 |
| `WECOM_ALLOW_FROM_REJECT_MESSAGE` / `WECOM_<ACCOUNT>_ALLOW_FROM_REJECT_MESSAGE` | 未授权提示 |
| `WECOM_ADMIN_USERS` | 管理员用户列表 |
| `WECOM_COMMANDS_ENABLED` / `WECOM_COMMANDS_ALLOWLIST` / `WECOM_COMMANDS_REJECT_MESSAGE` | 命令白名单策略 |
| `WECOM_DM_POLICY` / `WECOM_DM_MODE` / `WECOM_DM_ALLOW_FROM` / `WECOM_DM_REJECT_MESSAGE` | 私聊策略（支持 `WECOM_<ACCOUNT>_DM_*` 覆盖） |
| `WECOM_EVENTS_ENABLED` / `WECOM_EVENTS_ENTER_AGENT_WELCOME_ENABLED` / `WECOM_EVENTS_ENTER_AGENT_WELCOME_TEXT` | 事件处理与 enter_agent 欢迎语（支持 `WECOM_<ACCOUNT>_EVENTS_*`） |
| `WECOM_GROUP_CHAT_ENABLED` / `WECOM_GROUP_CHAT_REQUIRE_MENTION` / `WECOM_GROUP_CHAT_MENTION_PATTERNS` | 群触发策略 |
| `WECOM_DEBOUNCE_ENABLED` / `WECOM_DEBOUNCE_WINDOW_MS` / `WECOM_DEBOUNCE_MAX_BATCH` | 文本防抖 |
| `WECOM_STREAMING_ENABLED` / `WECOM_STREAMING_MIN_CHARS` / `WECOM_STREAMING_MIN_INTERVAL_MS` | Agent 增量回包 |
| `WECOM_LATE_REPLY_WATCH_MS` / `WECOM_LATE_REPLY_POLL_MS` | 异步补发窗口与轮询频率 |
| `WECOM_OBSERVABILITY_ENABLED` / `WECOM_OBSERVABILITY_PAYLOAD_META` | 观测统计与载荷元信息日志开关 |

### 语音回退转写

| 变量 | 说明 |
|---|---|
| `WECOM_VOICE_TRANSCRIBE_ENABLED` | 启用本地语音转写回退 |
| `WECOM_VOICE_TRANSCRIBE_PROVIDER` | `local-whisper-cli` / `local-whisper` |
| `WECOM_VOICE_TRANSCRIBE_COMMAND` | 转写命令 |
| `WECOM_VOICE_TRANSCRIBE_MODEL_PATH` | whisper-cli 模型路径 |
| `WECOM_VOICE_TRANSCRIBE_MODEL` | whisper 模型名 |
| `WECOM_VOICE_TRANSCRIBE_TIMEOUT_MS` | 转写超时 |
| `WECOM_VOICE_TRANSCRIBE_MAX_BYTES` | 音频大小上限 |
| `WECOM_VOICE_TRANSCRIBE_FFMPEG_ENABLED` | 是否允许 ffmpeg 转码 |
| `WECOM_VOICE_TRANSCRIBE_TRANSCODE_TO_WAV` | 是否优先转 WAV |

## 公网回调与 Gateway Auth

### 目标

企业微信访问你的回调地址时，必须直接命中 OpenClaw 网关的 webhook 路由。  
不能被这些中间层拦住：

- Gateway Auth / Token 鉴权
- 反向代理登录页 / SSO
- 前端 WebUI 路由
- 另一台静态站点或错误 upstream

### 推荐架构

| 场景 | 推荐做法 |
|---|---|
| 单域名 | 将 `/wecom/*`、legacy `/webhooks/app*`、`/webhooks/wecom*` 单独反代到 OpenClaw 网关端口 |
| 有 Gateway Auth / Zero Trust | 对上述 webhook 路径做认证豁免，不要求 Authorization/Cookie |
| 前端与网关共用域名 | 前端只接管 `/ui`、静态资源等路径，不要吞掉 `/wecom/*` |
| 最稳妥 | 单独给企微回调使用一个子域名，只代理到 OpenClaw |

### 最小验证

| 探测 | 预期 |
|---|---|
| `curl -i http://127.0.0.1:8885/wecom/callback` | `200` + `wecom webhook ok` |
| `curl -i http://127.0.0.1:8885/wecom/bot/callback` | `200` + `wecom bot webhook ok` |
| `curl -i https://你的域名/wecom/callback` | 与本机一致，不应返回 HTML、401/403 或跳转 |
| `curl -i https://你的域名/wecom/bot/callback` | 与本机一致，不应返回 HTML、401/403 或跳转 |

### 常见返回值的含义

| 现象 | 结论 | 处理 |
|---|---|---|
| `200` + `wecom webhook ok` / `wecom bot webhook ok` | 路由命中正常 | 继续做 URL 验证与企业微信后台配置 |
| `200` + HTML | 请求被前端/WebUI 接走 | 单独为 `/wecom/*` 配反代，不要落到前端 |
| `401/403` | 被 Gateway Auth / Zero Trust / 反代鉴权拦截 | 为 webhook 路径放行认证 |
| `301/302/307/308` | 被登录页、SSO 或前端路由重定向 | 取消 webhook 路径重定向，直接代理到网关 |
| `502/503/504` | OpenClaw 网关端口不可达 | 先修网关存活与 upstream |
| `404` | 路径写错或插件路由没注册 | 核对 `webhookPath`、插件启用状态和 legacy alias |

### 反代示例（Nginx）

```nginx
server {
  listen 443 ssl http2;
  server_name wecom.example.com;

  location /wecom/ {
    proxy_pass http://127.0.0.1:8885;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /webhooks/app {
    proxy_pass http://127.0.0.1:8885;
  }

  location /webhooks/wecom {
    proxy_pass http://127.0.0.1:8885;
  }
}
```

### Cloudflare Tunnel 示例

```yaml
ingress:
  - hostname: wecom.example.com
    service: http://127.0.0.1:8885
  - service: http_status:404
```

建议把企微回调放到单独子域名，不要和前端登录页共用同一套路由规则。

### 自检建议

```bash
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --all-accounts
npm run wecom:callback:matrix -- --agent-url https://你的域名/wecom/callback --bot-url https://你的域名/wecom/bot/callback
```

现在自检会明确提示这些原因：

- `route-not-found`
- `html-fallback`
- `gateway-auth`
- `redirect-auth`
- `gateway-unreachable`

如果你要把新路径和 legacy alias 一次跑完，直接用：

```bash
npm run wecom:callback:matrix -- \
  --agent-url https://你的域名/wecom/callback \
  --bot-url https://你的域名/wecom/bot/callback \
  --agent-legacy-url https://你的域名/webhooks/app \
  --bot-legacy-url https://你的域名/webhooks/wecom
```

## Webhook 与 Heartbeat 运维

### 适用场景

| 需求 | 推荐方式 |
|---|---|
| 手工发一条群通知 | `openclaw message send --channel wecom --target webhook:<name>` |
| 让 agent 处理后发到群 | `openclaw agent --deliver --reply-channel wecom --reply-to webhook:<name>` |
| 固定周期发摘要/巡检结果 | OpenClaw `agents.defaults.heartbeat` + `target: "wecom"` + `to: "webhook:<name>"` |

### 先配置命名 Webhook

```json
{
  "channels": {
    "wecom": {
      "webhooks": {
        "ops": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
        "dev": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=yyy"
      }
    }
  }
}
```

多账号时，也可以挂到 `channels.wecom.accounts.<id>.webhooks`。

### 直接发送

```bash
openclaw message send --channel wecom --target webhook:ops --message "服务已恢复正常"
```

### 让 Agent 结果投递到群

```bash
openclaw agent \
  --message "整理今天的告警摘要" \
  --deliver \
  --reply-channel wecom \
  --reply-to webhook:ops
```

### 用 Heartbeat 定时投递到群

当前机器上的 OpenClaw `2026.3.2` 支持把 heartbeat 直接投递到指定渠道和目标。  
对 WeCom Webhook 的推荐写法是：

```json
{
  "channels": {
    "wecom": {
      "webhooks": {
        "ops": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
      }
    }
  },
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "30m",
        "target": "wecom",
        "to": "webhook:ops",
        "prompt": "检查网关状态、最近告警和企业微信通道健康；如果一切正常，以三行内摘要输出。",
        "ackMaxChars": 300
      }
    }
  }
}
```

多账号 webhook 场景可以再加：

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "target": "wecom",
        "to": "webhook:ops",
        "accountId": "sales"
      }
    }
  }
}
```

说明：

- `target: "wecom"` 指定投递到 WeCom 渠道
- `to: "webhook:ops"` 指定 WeCom 渠道里的命名 webhook 目标
- `accountId` 只在多账号场景需要
- 如果不设 `target`，heartbeat 默认运行但不会向外发送消息

### 运维常用命令

```bash
openclaw system heartbeat last
openclaw config get agents.defaults.heartbeat
openclaw status --deep
openclaw logs --follow
```

需要手工触发一次立即执行：

```bash
openclaw system event --mode now --text "立即执行下一轮运维心跳"
```

## 与其他渠道并存建议

建议固定以下三点，减少“偶发无回复/冲突”风险：

1. 配置 `plugins.allow` 显式白名单（至少包含 `openclaw-wechat`）
2. 各渠道使用独立 webhook path，不复用
3. 同一台机器尽量只运行一个 OpenClaw gateway 进程

详细说明见：[`docs/troubleshooting/coexistence.md`](./docs/troubleshooting/coexistence.md)

## 故障排查

### 快速定位表

| 现象 | 先看什么 | 常见原因 | 处理建议 |
|---|---|---|---|
| 回调验证失败 | `curl https://域名/wecom/callback` | URL 不通、Token/AESKey 不一致 | 先通公网，再核对配置 |
| `curl /wecom/callback` 返回 WebUI 页面 | 反向代理路由与回调路径 | 域名把 `/wecom/callback` 转发到了前端/静态站点 | 单独为 `/wecom/*` 配置反向代理到 OpenClaw 网关端口 |
| `curl https://域名/wecom/callback` 返回 `401/403` | Gateway Auth / Zero Trust / 反代鉴权 | webhook 路径被要求登录或带 Token | 对 `/wecom/*`、`/webhooks/app*`、`/webhooks/wecom*` 做认证豁免 |
| `curl https://域名/wecom/callback` 返回 `301/302/307/308` | 登录跳转 / SSO / 前端路由 | webhook 被重定向到登录页或前端 | 让 webhook 路径直接反代到 OpenClaw 网关 |
| 能收到消息但不回复 | `openclaw gateway status` + `openclaw logs --follow` | 模型超时、会话排队、权限策略拦截 | 查看 dispatch/allowFrom/commands 日志 |
| Bot 图片识别失败 | `wecom(bot): failed to fetch image url` | URL 失效、返回非图像流 | 已支持 octet-stream+解密兜底，先升级到最新版本 |
| 语音转写失败 | `wecom: voice transcription failed` | 本地命令或模型路径错误 | 检查 `command`、`modelPath`、`ffmpeg` |
| 启动出现账号体检告警 | `wecom: account diagnosis ...` | 多账号 Token/Agent/路径存在冲突风险 | 按日志 `code` 与账户列表调整配置，优先处理 `warn` 级别 |
| `wecom:selfcheck -- --all-accounts` 提示 `account '<id>' not found or incomplete` | 账号配置结构 | 旧版本自检脚本没完全识别 `agent` 子块、legacy inline 账户，或账号字段确实缺失 | 升级到最新版本后重跑；再核对 `channels.wecom.accounts.<id>` 是否包含完整 Agent 凭据 |
| gettoken 失败 | 企业微信 API 返回码 | CorpId/Secret 错或网络受限 | 检查凭据/配置代理 |

### 推荐检查命令

```bash
openclaw gateway status
openclaw status --deep
openclaw logs --follow
npm run wecom:selfcheck -- --all-accounts
npm run wecom:agent:selfcheck -- --all-accounts
npm run wecom:bot:selfcheck -- --all-accounts
```

## 开发与发布

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 语法与单测 |
| `WECOM_E2E_ENABLE=1 npm run test:e2e:remote` | 运行远程 E2E 测试（默认跳过；支持 `WECOM_E2E_*` 与兼容 `E2E_WECOM_*` 两套变量） |
| `WECOM_E2E_MATRIX_ENABLE=1 npm run test:e2e:matrix` | 运行远程矩阵 E2E（签名验签/异常请求/stream refresh/去重链路） |
| `npm run test:e2e:prepare-browser` | 远程浏览器沙箱就绪检查（可选自动安装 Chromium） |
| `npm run test:e2e:collect-pdf` | 收集远端浏览器沙箱中的 PDF 产物到本地 |
| `npm run wecom:selfcheck -- --all-accounts` | 配置+网络体检 |
| `npm run wecom:agent:selfcheck -- --account <id>` | Agent 单账号端到端链路体检（URL 验证 + 加密 POST） |
| `npm run wecom:agent:selfcheck -- --all-accounts` | Agent 多账号端到端链路体检（逐账号跑 URL 验证 + 加密 POST） |
| `npm run wecom:bot:selfcheck -- --account <id>` | Bot 端到端链路体检（URL 验证/签名/加密/stream-refresh，支持多账户） |
| `npm run wecom:callback:matrix -- --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 公网回调矩阵体检（可附带 legacy alias URL） |
| `npm run wecom:remote:e2e -- --mode all --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 远端矩阵验证（Agent+Bot） |
| `npm run wecom:remote:e2e -- --mode all --agent-url <公网Agent回调> --bot-url <公网Bot回调> --prepare-browser --collect-pdf` | 远端矩阵验证（含浏览器沙箱检查与 PDF 回收） |
| `WECOM_E2E_BOT_URL=<...> WECOM_E2E_AGENT_URL=<...> npm run wecom:remote:e2e -- --mode all` | 用环境变量驱动远端 E2E（兼容旧 `E2E_WECOM_*`） |
| `npm run wecom:e2e:scenario -- --scenario full-smoke --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 场景化 E2E（预置 smoke/queue 场景） |
| `npm run wecom:e2e:scenario -- --scenario callback-matrix --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 只做公网回调矩阵检查 |
| `npm run wecom:e2e:scenario -- --scenario compat-smoke --agent-url <新Agent回调> --agent-legacy-url <旧Agent回调> --bot-url <新Bot回调> --bot-legacy-url <旧Bot回调>` | 兼容矩阵验证（新旧回调地址都跑一遍） |
| `npm run wecom:e2e:scenario -- --scenario matrix-smoke --bot-url <公网Bot回调>` | Bot 协议矩阵验证（验签/异常请求/stream-refresh/去重；需 `WECOM_BOT_TOKEN/WECOM_BOT_ENCODING_AES_KEY`） |
| `npm run wecom:e2e:compat -- --agent-url <新Agent回调> --agent-legacy-url <旧Agent回调> --bot-url <新Bot回调> --bot-legacy-url <旧Bot回调>` | 兼容矩阵快捷命令（等价 `--scenario compat-smoke`） |
| `npm run wecom:e2e:full -- --agent-url <公网Agent回调> --bot-url <公网Bot回调>` | 一键 full-smoke（默认带 `--prepare-browser --collect-pdf`） |
| `GitHub Actions -> CI -> Run workflow` | 在仓库 CI 手动触发远程 E2E：设置 `run_remote_e2e=true`，可选 `e2e_scenario`（含 `compat-smoke`）与浏览器参数 |
| `npm run wecom:smoke` | 升级后快速回归（Agent 主链路） |
| `npm run wecom:smoke -- --with-bot-e2e` | 升级后快速回归（含 Bot E2E） |
| `openclaw gateway restart` | 重启网关 |

### 发版建议流程

1. 更新 `CHANGELOG.md` 与版本号
2. 运行 `npm test` 与 `wecom:selfcheck`
3. 打 tag 并发布 GitHub Release
4. （可选）发布 npm 包

## FAQ

### Q1：Bot 模式回调一直失败？
通常是机器人创建成“标准模式”。请重建为 **API 模式**（JSON 回调）。

### Q2：为什么图片偶发识别失败？
企业微信可能返回非标准 `content-type` 或加密媒体流。插件已增加类型识别与解密兜底；仍失败时请查看日志中的 header/下载错误。

### Q3：Telegram 和 WeCom 会互相影响吗？
理论上独立；实战中若复用 webhook 路径、多进程抢占、或 `plugins.allow` 未收紧，会出现干扰。按“并存建议”配置可大幅降低风险。

### Q4：支持个人微信吗？
支持企业微信场景下的“微信插件入口”（个人微信扫码进入企业应用对话），不等同于“个人微信网页版协议”。

### Q4.1：为什么 Bot 模式在“微信插件入口”里看不到机器人联系人？
这是企业微信产品形态差异，不是插件故障。  
在很多租户里，“微信插件入口”主要对应**自建应用（Agent 回调）**可见，Bot 模式（智能机器人 API）不会以可直接会话的联系人形态出现。

建议：
1. 需要稳定私聊入口：优先用自建应用（Agent 模式）
2. 需要群聊通知/群内对话：优先用 Webhook Bot / Bot 模式
3. 需要两者兼顾：并行启用 Agent（入口）+ Bot（群能力）
4. 运行 `npm run wecom:bot:selfcheck -- --account <id>`（或 `--all-accounts`）可看到 `bot.entry.visibility` 提示，用于快速确认该行为属于产品形态差异而非插件故障

### Q5：为什么 `curl https://域名/wecom/callback` 返回的是 WebUI 页面？
这是路由层问题，不是插件正常行为。`GET /wecom/callback`（无 `echostr`）应返回纯文本 `wecom webhook ok`。  
若返回 WebUI，说明你的反向代理把该路径转发到了前端服务而不是 OpenClaw 网关。

建议按顺序排查：
1. 本机验证：`curl http://127.0.0.1:8885/wecom/callback`（应返回 `wecom webhook ok`）
2. 公网验证：`curl -i https://你的域名/wecom/callback`
3. 代理配置：为 `/wecom/*` 单独反代到 OpenClaw 网关端口，不要落到 WebUI 路由

### Q6：自建应用群聊怎么开？为什么群里不 @ 就不触发？
先区分两种通道能力：
1. **群机器人（Webhook Bot）**：可直接添加到企微群，天然适合群聊收发；但群聊通常仅 `@机器人` 时才会回调。
2. **自建应用（Agent 回调）**：插件支持处理 `ChatId` 群消息；但是否能收到“普通群消息”取决于企业微信实际下发能力（很多租户里普通群只能加机器人，无法像成员一样加自建应用）。

如果你的场景是“普通群里稳定对话”，优先用 **Webhook Bot 模式**（注意通常仍需 `@机器人` 才触发）。  
如果你确认企业微信会把群消息回调到自建应用（日志里有 `chatId=...`），再配置触发模式：

```json
{
  "channels": {
    "wecom": {
      "groupChat": {
        "enabled": true,
        "triggerMode": "direct"
      }
    }
  }
}
```

同时确认企业微信侧前提：
1. 自建应用已开启“接收消息”并完成 URL 验证
2. 应用可见范围包含该群成员
3. 日志里能看到 `chatId=...`（若没有 `chatId`，说明企业微信没有把群消息推送到该回调）

若你在企微侧只能给群添加“机器人”而不能添加“自建应用”，这不是插件配置问题，属于企微产品形态差异；建议走 Bot 模式承载群聊，自建应用用于私聊/应用会话/主动推送。

### Q7：多账号创建了两个 agent，但只有一个回复，或者会话串了？

这是多账号隔离问题，不是“企微互相干扰”。

从当前版本开始：

1. Agent 会话 key 已按账号隔离
2. `wecom:selfcheck -- --all-accounts` 会识别 `accounts.<id>`、`agent` 子块、legacy inline 账户
3. `bindings.match.channel=wecom + accountId=<id>` 可以把不同账号稳定路由到不同 Agent

建议排查顺序：

1. 跑 `npm run wecom:selfcheck -- --all-accounts`
2. 确认每个账号 `config.account` 都是 `OK`
3. 在 `openclaw.json` 中为多账号配置 `bindings`
4. 确认会话 key 形态符合预期：默认账号为 `wecom:<userid>`；非默认账号为 `wecom:<accountId>:<userid>`

## 版本与贡献

- 版本记录：[`CHANGELOG.md`](./CHANGELOG.md)
- 渠道文档：[`docs/channels/wecom.md`](./docs/channels/wecom.md)
- 问题排查：[`docs/troubleshooting/coexistence.md`](./docs/troubleshooting/coexistence.md)
- 许可证：MIT

欢迎提交 Issue / PR。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=dingxiang-me/OpenClaw-Wechat&type=Date)](https://star-history.com/#dingxiang-me/OpenClaw-Wechat&Date)
