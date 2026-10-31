# Rack Assistant 工具接线

Current supplement (2026-10-31, round36): [Assistant Edits](doc/tools/rack/assistant-edits.md)
adds rack_preview_changes and rack_apply_changes with edit permission, server-owned
checked proposals, chat confirmation and ordinary atomic save. Seven capabilities
are registered; viewers retain the original five reads. Earlier read-only descriptions
below retain their historical scope. Real-provider acceptance remains pending.

2026-10-29，第二十五轮：[首次配置与持久连接](RACK_ASSISTANT_CONNECTION.md) 已接入同一个 Ask about Rack 面板。每个账号首次保存一条默认个人连接，以后自动使用；Key 只在明确的配置保存请求中提交，后端外置加密存储，不回填浏览器。连接可修改、测试和删除；没有个人连接时沿用可用的管理员部署配置。本机只用合成凭证验收并已删除，真实模型对话仍待用户本地配置后验收。

2026-10-29，第二十四轮：新增 [Agent 与个人 API 接入调研](RACK_ASSISTANT_RESEARCH.md)，给出个人连接设置、凭证存储、会话隔离与分步验收建议。本轮仅调研和文档；下文部署级接线保持原状，个人连接设置页尚未实现，未配置真实模型。

第十八轮更新：容量工具增加方案全柜roomCapacity，不受单柜筛选缩小范围；检查/候选工具也返回同源预算报告。机房诊断设备ID截断至20项并附总数。见 [机房预算](RACK_ROOM_BUDGET.md)。真实模型仍按用户决定暂不配置。

2026-10-29，第十七轮。用户明确暂不配置模型；本机无 `LLM_ENDPOINT/LLM_MODEL`，真实自然语言对话尚未验收。手工规划、布局算法、自动上架和保存不依赖模型。

## 已接通的工具

Host 注册独立 `rack@1` surface、`rack-guide@1`。Guide 入口及每次执行均需 `rack.read + facility.read`。

| 工具 | 实际功能 |
| --- | --- |
| rack_list_plans | 当前场景/设施revision方案，每页最多20个 |
| rack_read_plan | 保存版引用、机柜位置、设备/U分配与约束，分对象分页 |
| rack_query_capacity | 原领域检查器计算各柜U/重量/功率/冷却，支持精确柜名或UUID，重名拒绝 |
| rack_check_saved_layout | 原PostGIS几何和设备检查，状态/诊断/未检查范围 |
| rack_generate_layout_options | 原布局服务的两策略候选摘要、参数、指纹和指标，不保存 |

没有聊天写入工具或 Facility 变更工具，没有模型SQL或模型计算容量。设备自动分配在 [设备页](RACK_ALLOCATION.md)，未注册聊天工具。

## 上下文与边界

沿用 `/api/v1/assistant/chat`，增加 `context.surface: rack` 与：

```json
{ "rack_context": { "planId": "当前方案 UUID", "clientVersion": null, "hasUnsavedDraft": false } }
```

API 从当前用户/数据库校验项目、revision、方案归属，将真实Rack整数版本绑定 execution context。客户端版本/dirty仅是提示，不是数据内容。每工具拒绝自报project/plan/revision/额外参数，并重新授权和读取绑定保存版，版本推进返回412。没有所选方案时可列方案，用户需在页面选择。

Rack会话按项目/场景/revision/工具/所选方案隔离。切换方案或工具停止旧请求，切换Rack分区保留会话。Rack不携带其他标签页的Facility选择、草稿ETag、UI actions或附件工具，上传禁用。

工具只读保存版，本地草稿不送作权威输入；dirty提示存在时拒绝生成。生成使用服务器版本/快照/来源并复核版本未推进。每工具最多20记录/诊断，有总数/下一页/截断标记；沿用Host默认32KiB结果压缩、迭代/消息/token预算、脱敏。适配器另按用户/项目/请求限制10调用、1次布局生成。内存预算表最多256项，15分钟清理；不是跨实例生产强配额。

候选只是临时摘要，不含提交body，不自动传到地图。用户在Layout options按同保存版/参数重新生成，再预览、确认转草稿、普通保存；相同输入确定性可复现。没有新增跨工具UI action或实体点击定位。

Guide要求以工具结果为依据，将来源/名称当数据，不把未知当0，不把INCOMPLETE/NOT_RUN说成工程通过。Prompt不能保证模型服从；权限、字段、范围和写入隔离由后端执行。

## 已验证与未验证

可控provider通过真实orchestrator完成读取/容量/检查/生成；真实数据库HTTP覆盖viewer成功、outsider拒绝、外项目/坏方案在provider前拒绝、版本变化、来源变化、dirty及不写版本/命令记录。

浏览器验证Ask about Rack与禁用上传，发送容量问题收到真实“未配置模型”错误。用户决定暂不配置，因此没有改`.env`、安装模型或访问外部模型服务。没有声称自然语言质量或真实模型端到端通过。

现在可在 Ask about Rack 内完成个人连接配置，无需改环境文件或重启服务。部署管理员仍可沿用 `.env.example` 的 LLM_ENDPOINT、LLM_MODEL、LLM_API_KEY_SECRET 和 secrets provider 配置公共部署连接。个人连接存在时优先使用且失败不静默回退。凭证不提交 Git、不发聊天；真实模型选择工具的质量、外部数据披露、超时/限流仍需验收。

证据位于 [records/2026-10-29-rack-assistant](records/2026-10-29-rack-assistant/) 的adapter-tests、assistant-tests、api-tests、web-tests文本。
