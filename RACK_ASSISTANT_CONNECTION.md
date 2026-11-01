# Ask about Rack：首次配置与持久连接

## 本地 Codex CLI（2026-11-01，Round76）

进入项目 → Rack → Ask about Rack，在 `Connection` 选择 `Local Codex CLI` 即可使用运行后端的这台电脑已有的 Codex 模型连接。`Model API` 仍是默认方式，已有地址、模型和加密 Key 保留，可以随时切回。刷新或切换工具后恢复 API 模式；两种连接使用独立会话上下文，切换时停止旧会话，操作授权重新确认。CLI 失败时显示错误，不自动切到 API。

此接入把 CLI 作为结构化模型提供方：后端通过 stdin 发送有界对话与平台工具定义，CLI 用 JSON 返回回答或工具请求，原 Assistant Host 继续负责 Rack 工具执行、账号权限、操作确认、预算、保存校验和审计。它没有另建 MCP 服务。CLI 原生 shell、文件修改、浏览器、MCP、hooks、插件等能力关闭，运行目录是临时目录；开发代理工作区仍是平台原有的独立能力。

CLI 使用后端机器的本地凭证，默认只向本机 `dev-user` 账号开放，其他登录用户不能借用该凭证。服务端可用 `ASSISTANT_CODEX_ENABLED=0` 关闭，用 `ASSISTANT_CODEX_SUBJECTS` 指定逗号分隔的允许账号 subject，或用 `ASSISTANT_CODEX_CLI_PATH` 指定绝对 `.exe`/`.js` 路径。管理员修改环境变量后需重启后端。不要把本机凭证分发到浏览器。

当前读取本地配置中显式的 `model`、`model_provider` 和所选 provider 的简单传输字段（name/base_url/wire_api/env_key/requires_openai_auth），不复制普通用户配置中的通知、MCP、hooks 或项目指令。需要对应凭证环境变量可被后端读取；模型或凭证变化会使旧连接版本失效。复杂 profile/额外认证 header 等配置暂不支持。

每轮模型调用超时 90 秒，每账号同时最多一个 CLI 子进程，取消会结束所拥有的进程树并清理临时目录。每轮启动独立 ephemeral CLI、重发有界对话，不复用原生 CLI 会话，因此会有启动延迟及额外 token 开销；继续使用原中转站时消耗该站额度。本轮没有新增依赖或数据库迁移。真实平台只读工具查询与浏览器验收记录见 PROGRESS.md Round76。

2026-10-29，第二十五轮。本文先确定本轮实现契约，实际验证与遗留范围见 PROGRESS.md。

## 用户流程

用户仍从下方 Ask about Rack 打开助手。没有可用连接时，面板内提示首次配置；填写连接名称、Base URL、模型 ID 和 API Key 后保存。以后刷新网页、关闭浏览器或重启本机 API，继续使用已保存连接，无需重复输入。更换电脑/服务器或切换平台账号需要使用相应账号的配置。

面板内保留“模型连接”入口，支持查看非敏感信息、修改地址/模型、留空保留原 Key、替换 Key、测试和删除个人连接。保存不发送模型请求；测试按钮单独说明会使用少量模型用量，并只发送合成消息与无业务数据的 ping 工具。

本轮收窄为每个认证用户一条个人连接，保存即为其默认。多连接列表/团队共享连接留待以后。没有个人连接时可使用管理员已有部署连接；已有个人连接失败时不自动回退。不是每次聊天都配置，也不把 Key 留在浏览器。

本机可打开 [本地平台](http://localhost:5193/)，进入项目 → Rack → 下方 Ask about Rack。Base URL 支持 `https://服务商域名/v1`，也接受完整 Chat Completions 地址；模型 ID 按服务商控制台填写。Key 只在此表单输入，不需要发给开发者或贴到聊天。

## 后端与持久化

- 首版沿用 OpenAI-compatible Chat Completions 适配器和现有 Rack Agent。服务端控制协议实现；用户只配置地址和模型。
- 本地单 API 实例采用应用目录外的文件元数据与 AES-256-GCM 加密凭证文件，不新增数据库迁移。相较调研中建议的数据库元数据，这一阶段采用文件适配器以减少部署步骤；后续多实例服务器需迁移至数据库元数据与集中 Secret Store。
- 默认存储在操作系统用户数据目录下的 AI-INFRA-Rack，元数据/加密凭证与主密钥分目录；支持管理员指定目录。目录不在项目、Git 或容器镜像中。Unix 目录/文件采用 0700/0600；Windows 依赖运行 API 的系统用户目录 ACL。此本地存储不等于云 KMS，不防御已控制该系统用户的攻击者，备份/搬迁需同时保留数据与主密钥。
- 每个用户的写操作在单进程串行，凭证不可变版本写入后原子替换元数据；失败不使半条连接对外可见。主密钥缺失/损坏时不静默覆盖已有密文。
- `GET /api/v1/assistant/connection` 返回本人连接和是否有 Key，不返回明文或 secretRef；`PUT` 首次创建/修改，更新必须匹配当前连接版本；`DELETE` 同样要求版本；`POST …/test` 测试保存版。
- 聊天只提交 connection_id、connection_version、允许的模型；后端验证归属与版本，为本轮构建独立 provider/脱敏器，继续使用原 Host 权限、工具预算、审计和持久化。轮换/删除中止该连接在途请求。
- 连接/版本/模型进入会话 context key。客户端切换时停止旧请求，服务端验证绑定；不会把旧连接回复写到新会话。
- `GET /api/v1/assistant/provider` 返回调用者实际默认连接的非敏感元信息及 configured 状态。所有 Assistant API 禁止 HTTP 缓存。

管理员可选变量（普通本地用户无需配置）：`ASSISTANT_CONNECTION_DIR`、`ASSISTANT_KEY_DIR` 指定两处绝对目录，`ASSISTANT_ALLOWED_ORIGINS` 指定逗号分隔的精确 origin，例如 `https://models.example.edu:8443`。修改管理员变量需要正常重启 API。容器部署需把这两处目录挂成持久卷，不能依赖容器可写层。

## 自定义地址与测试

默认只允许 HTTPS 公网地址，拒绝 URL 用户名/密码、query/hash、本地/保留地址和重定向。每次模型请求重新解析并检查全部 DNS 结果，再将已检查 IP 绑定实际连接，保留原主机名用于 TLS 校验；限制响应大小、超时，沿用取消能力。管理员可通过精确 origin 白名单允许校园内网或本地网关；用户表单不能自行开放内网权限。

Base URL 支持 `/v1` 或完整 `/chat/completions`，统一成一个完整请求地址，避免重复拼接。模型 ID 手填，不依赖 `/models`。

测试先请求合成 ping 工具调用，再携带合成 tool result 完成往返。普通聊天可用、模型是否主动调用工具、工具往返成功分别报告；不自动将一次未调用工具认定为永不支持。真实模型还需按 Rack 场景进一步验收。测试限并发与冷却，不自动重试已响应的付费请求。

## 老师平台只读观察

本轮只打开 Power 的 Ask about Power。页面显示服务 `api.deepseek.com`，当前 `deepseek-flash`，模型菜单还列 `deepseek-v4-pro`。未发送消息、切换模型或改动业务数据。

这些页面标签可确认其展示的服务/模型；不能从标签判断 Key 的保存位置、是否共用额度、实际 endpoint 路径或计费账户。继承代码使用后端 Chat Completions 代理，但这不构成老师线上具体部署配置的证明。

用户随后明确仅处理我们的平台；后续不再查看或操作老师平台。
