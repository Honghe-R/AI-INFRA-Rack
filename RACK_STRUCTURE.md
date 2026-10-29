# Rack 工作区结构

2026-10-29 第十八轮：[Capacity](RACK_ROOM_BUDGET.md) 已扩展为每柜 + 方案范围机房功率/冷却假设预算、安装/库存总量、未知/超限。下文历史轮次描述以最新增量为准；正式跨方案容量与连续通道仍待实现。

2026-10-28 起拆分原先集中在 Plans 内的界面；10 月 29 日第十六轮已接入真实布局搜索，详见 [算法与候选](RACK_PLANNER.md)。全部工作仅在 AI-INFRA-Rack 副本。

## 九个分区（第十五轮按 Rack 流程调整）

分区按 Rack 的输入、摆柜、设备上架和资源检查组织，不要求与 Site 的名称或数量一致。沿用旧 functionId 保留已有标签、方案与草稿。

| 导航 | 当前内容 | 后续细节 |
| --- | --- | --- |
| Overview | 流程入口、模块状态、所选方案/草稿的机柜和设备数量、当前检查状态 | 更完整的指标与告警摘要 |
| Plans | 创建、分页选择、方案元数据、打开布局 | 方案复制、历史、比较 |
| Inputs & impact | 实际固定来源/快照、设备型号版本清单、输入关系图、草稿与保存版对比和检查影响 | 持久化依赖历史、外部变化订阅及显式重绑定 |
| Rack layout | 独立机房主画布、缩放/聚焦、机柜位置/旋转/锁定 | 行列、连续通道与编辑体验 |
| Space rules | 图上障碍和维护带、禁放区与前后净距输入 | 权威障碍来源、侧向净距和通路规则 |
| Devices & U slots | 自定义或 Catalog 型号设备、上架/卸架、U 位立面 | 全局硬件资产身份、深度/导轨等兼容性 |
| Capacity | 选择机柜、设置三维假设限值、U 与重量/电力/冷却汇总 | 机房正式预算与容量分配 |
| Layout options | 两种确定性机柜重排算法、完整检查、指标/逐柜变更比较、图面预览、确认转草稿后保存 | 持久化候选历史、设备自动装箱、连续通道与更多优化 |
| Checks | 当前空间和设备报告、诊断、未检查范围 | 持久化 Validation Run、完整覆盖和工程验证 |

Checks 使用 route functionId `validate`，没有调用 Facility 的验证/冻结操作。没有把现有范围检查改称完整工程通过。Layout options 标明 Partial scope；Inputs & impact 是读取现有输入的局部功能，不等于正式依赖服务。

## 操作顺序

1. 进入 Rack，Overview 显示模块结构。
2. 到 Plans 创建或选择方案，点 Open layout；也可以在其他分区的 Active Rack plan 下拉选择。
3. Inputs & impact 查看输入，Rack layout 摆机柜，Space rules 设置空间条件，Devices & U slots 安排设备，Capacity 查看和调整假设限值。
4. 在任一已有编辑页进入 Edit layout；分区间共用一个草稿。到 Checks 查看全部问题，再 Save layout 一起保存。
5. 总览的模块卡片和左侧子导航都可切换分区。草稿或不确定请求存在时，不允许换方案。

创建中的表单也会保留，不能通过切页绕过原有不确定请求保护。Plans 的分页和权限不变；其他分区的下拉提供当前页方案，需要更多方案时通过 Manage plans 分页选择。

## 实现组织

- `apps/web/src/rack/rack-sections.js`：分区 ID、名称、说明和实现状态，是工具注册与工作区的共同定义。
- `state/tool-registry.js`：把分区声明给已有 shell，左侧导航自动呈现，仍需 rack.read。
- `RackSurface.jsx`：方案选择、创建、共享 routeState、总览入口和待实现页面。
- `RackSections.jsx`：总览与模块状态。
- `RackOptions.jsx` / `rack-options-state.js`：生成参数、比较、临时预览、确认与共享草稿，后台通过布局服务调用独立规划器和 PostGIS 适配器。
- `RackInputs.jsx` / `rack-inputs.js`：输入引用、可选择的关系图、草稿对比和保守影响提示，复用同一编辑器实例的数据与检查。
- `RackEditor.jsx`：保持一个编辑器实例，按分区显示画布/设备/约束/报告，共享选中机柜、检查、版本和保存状态。
- `RackEquipment.jsx`：按 equipment/capacity/diagnostics 模式展示同一份设备数据；设备与容量分别有页面，检查页只显示诊断。

已有编辑面板通过 hidden 隐藏而不是切页时销毁，保留选中设备、相机和请求状态；隐藏仅用于呈现，不构成授权。前后端原有权限仍生效，保存仍检查所有分区的数据，一处冲突不能通过切页绕过。关闭/换上下文的 dirty 保护和 UUID 精确重试沿用原机制。

旧 Rack `overview` 路由原来名为 Plans，现在对应真正总览；方案 ID 和草稿字段保留，Plans 独立使用 `plans`。未知路由回到 Overview。不改变设备、方案、Facility 数据或已有数据库示例。

## 后续填充顺序

输入关系、Layout options 和设备页 [自动上架](RACK_ALLOCATION.md) 已接通。工作区 Assistant 已有 [Rack 专用工具接线](RACK_ASSISTANT.md)，暂不配模型，真实对话待验收；聊天没有写入/应用工具。正式依赖历史、预算、连续通道、硬件资产和验证历史仍待完善。输入关系图不是物理拓扑，机房图继续在 Rack layout。

第十四轮验证保留在 `records/2026-10-28-rack-sections/`。第十五轮 103 项前端定向测试及构建通过；实际浏览器验证来源/型号清单、节点选择、跨页草稿对比、放弃恢复，未保存测试草稿。证据见 `records/2026-10-28-rack-inputs/`，详细进展见根 PROGRESS.md。
