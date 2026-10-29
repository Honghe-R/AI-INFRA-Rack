# 机房功率与冷却规划预算

2026-10-29，第十八轮。只在 AI-INFRA-Rack 副本开发；没有迁移、提交或推送。

## 使用和演示

打开本地平台 http://localhost:5193/ → Northern DC Campus → Rack → Capacity，选择 **Rack room budget demo — shared power and cooling**。

示例包含三柜，其中一柜锁定。两台已安装设备合计功率/冷却各 2 kW，方案假设预算各 3 kW，剩余各 1 kW。完整库存包含两台未分配设备，共 5 kW；库存超预算只是未来安装提示，不阻止保存现有的 2 kW 安装状态。

点击 Edit layout 后可启用/关闭预算、填写来源和两个限值；修改触发原共享完整检查。临时把功率预算改为 1，会显示 ROOM_BUDGET_EXCEEDED 并禁用 Save；空白表示未知而不是零。保存复用原布局版本、权限、幂等和原子事务。放弃草稿恢复保存版。

在 Devices & U slots 生成设备分配：2 kW 待装设备因预算不足保留未分配；1 kW 设备可以安装，安装后刚好 3 kW。生成只读，应用仍需复核、转草稿、普通保存。示例保留初始 v2，没有保存算法结果。

## Contract 和规则

原 `equipment` JSON 增加可选字段，没有新端点：

```json
{
  "roomBudget": {
    "maxPowerKw": 3,
    "maxCoolingKw": 3,
    "source": {
      "kind": "ASSUMED",
      "reference": "本方案规划假设的来源说明"
    }
  }
}
```

两个限值均必填，取 null 或 0–1000000 的有限数字；null 未知、0 显式零容量。来源仅允许 ASSUMED，reference 为 1–512 字符非空文本；不接受伪造的 Facility 权威类型和额外字段。规范化冻结嵌套对象，不修改调用者数据。

- `roomBudget` 缺省或 null：未记录。为兼容旧数据，原设备检查状态维持原先单柜范围；独立 `roomCapacity` 为 INCOMPLETE，设备报告 uncheckedRules 包含 ROOM_POWER_COOLING_BUDGET。
- 旧客户端提交整个 equipment 但省略 roomBudget，检查和保存均保留已经保存的预算。主动关闭须显式传 null；仍需普通 rack.write、版本和事务检查。
- `checkEquipment().roomCapacity` 的 scope 为 PLAN_INSTALLED_DEVICE_DEMAND。汇总所有柜中已安装设备，包括锁定柜；库存总需求另列 `resources.*.inventory`，包含未分配设备。
- 每维报告 knownSubtotal、total、unknownDevices、limit、remaining、status。已知小计即超限时，其他未知设备不能掩盖错误；存在未知项时 total/remaining 为 null。
- 两维独立检查；不由功率推算冷却。补偿求和与四机器精度比较沿用单柜政策，处理 0.1+0.2 等浮点边界，不是工程裕量。
- 已知超限加入原 equipmentReport.diagnostics，code ROOM_BUDGET_EXCEEDED、ruleId rack.capacity.room_budget、rackId null，普通保存返回 422/RACK_EQUIPMENT_CONFLICT，所有字段/版本/命令记录均回滚。

布局候选使用同一检查，机房错误令 canStage=false；只重排机柜不能消除设备总需求超限。自动分配器升级为 **unassigned-first-fit-decreasing-v2**，每次新增分配前重算全柜已安装总量；预算/已安装需求未知时返回 UNKNOWN_ROOM_BUDGET，加入后超限返回 ROOM_BUDGET_EXCEEDED。缺省预算继续原单柜模式，明确保留未检查项。

Assistant 容量工具使用相同总量，筛选单柜也不会把机房总量缩成该柜；诊断设备 ID 最多返回前 20 个并附总数/截断标识。没有配置真实模型或新增聊天写入。

实现位置：[领域预算](packages/rack/src/room-budget.js)、[设备检查](packages/rack/src/equipment.js)、[分配器](packages/rack/src/allocator.js)、[原服务](apps/api/src/services/rack-layout.js)、[容量页](apps/web/src/rack/RackRoomCapacity.jsx)。JSONB 原列保存，无数据库迁移。

## 适用边界

这是**一个 Rack 方案的已安装设备需求与显式假设预算的比较**。不在 Facility 容量服务里预留/扣减容量，也不检测同一房间其他方案的占用；真实权威容量分配、跨方案并发预留和依赖事件仍待实现。

没有机柜空载功耗、PUE、供电回路/冗余/降额、气流/热仿真和楼板承载；没有推导全局房间重量限值。完整库存覆盖 UNKNOWN 仍是不完整；无超限不是整体验证或工程认证，方案 validationState 仍为 NOT_RUN。

## 证据与剩余工作

记录目录：[records/2026-10-29-rack-room-budget](records/2026-10-29-rack-room-budget/)。领域 135 项、Web 定向 171 项通过；数据库/HTTP 50 项及适配/投影 16 项共 66 项通过，无失败/跳过。Web build 成功，保留既有大于 500 kB bundle 提示。不是全仓验收。

浏览器验证预算超限禁用保存、空白保持未知、放弃恢复 v2；记录 [browser-checks.md](records/2026-10-29-rack-room-budget/browser-checks.md)。[示例脚本](records/2026-10-29-rack-room-budget/create-room-budget-demo.mjs) 限定本机独立栈和合成来源，用普通 HTTP 新建并保存独立示例；确认超限保存 422、只读生成无写入以及六个旧示例完整布局不变。不要把脚本当用户示例重置工具。

接下来优先补连续通道/访问连通检查、版本绑定的验证记录，再做可复现规模和算法比较实验；同时仍需汇报架构图、API/contract 材料和演示整理。模型配置按用户决定继续搁置。
