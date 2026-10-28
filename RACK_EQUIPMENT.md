# Rack 设备上架与容量

2026-10-29 第十七轮新增 [未分配设备自动上架](RACK_ALLOCATION.md)：大U优先、连续U首次适配、保留原分配/锁定柜，三种资源未知时不猜测；可预览部分结果、原因及容量/立面，再转共享草稿走原保存。原手工设备 contract 保持。

日期：2026-10-28。承接机柜布局和空间约束，补齐方案内设备清单、U 位、重量/电力/冷却汇总、保存与柜内立面。采用合成假设，不是厂商型号库或工程认证。

## 操作

已有副本执行 `npm run migrate`（当前 10 个迁移），继续 `npm run dev`；不要重跑 seed 或 reset。打开 http://localhost:5193/ → Northern DC Campus → Rack，选择方案 → Edit layout。

1. 添加或选择机柜；在 Equipment & capacity 记录假设来源和设备清单覆盖声明。
2. Add device 创建唯一设备身份，输入名称、1–100 U 高度及重量 kg、功率 kW、冷却需求 kW。空白需求表示未知，显式 0 表示无需求。默认未上架。
3. Assigned rack 选择机柜，Starting U 为设备底部 U 编号；占用闭区间 `[startU, startU + heightU - 1]`，U1 在柜底。首版只支持占满柜宽的单面设备，不支持共享同一 U 的前后安装或半宽设备。
4. 修改 Assigned rack/Starting U 可迁移；Unassigned 保留设备 ID/规格并释放旧柜 U 位及用量；Remove device 从本次规划清单移除。已装设备的柜不能直接删除，先卸架；柜的位置锁不锁住设备编辑。
5. Capacity rack 选择柜，查看重量、电力、冷却与 U 位用量。默认读取型号限值；当前两种假设型号的三个限值都未知。Use plan-assumed capacity limits 可显式记录本方案三个假设上限，来源为本面板说明，不修改型号目录或 Facility。
6. 柜内图从 U42 向下到 U1，可滚动；点击设备选择其规格。重叠位置为红色，越界会在 Equipment diagnostics 报错，点击诊断定位柜和设备。
7. 已知 U 位冲突、越界或已知用量超限阻止 Save layout；未知项允许保存规划草稿并保留 INCOMPLETE。保存机柜、空间条件、设备与容量假设为同一个版本，刷新后重读。

本机保留独立 `Rack equipment demo — Hall A1`。其设备和限值只是课程演示，未写入 seed；组员拉代码并迁移后自行创建方案。

## 数据 contract

010 迁移仅向已有项目隔离并强制 RLS 的 rack_plans 增加 equipment JSONB 列；旧方案使用 UNKNOWN、空设备与空限值，版本和原数据不变。领域实现见 [equipment.js](packages/rack/src/equipment.js)，服务复用 [rack-layout.js](apps/api/src/services/rack-layout.js)。

`GET /layout` 返回 `equipment`；`POST /layout/check`、`PUT /layout` 在原 contract_version=1 的 body 增加可选 equipment。省略保留当前已存值，显式 null 拒绝。示例：

```json
{
  "coverage": "DECLARED_COMPLETE",
  "source": {"kind": "ASSUMED", "reference": "Course demonstration; not a vendor specification."},
  "devices": [{
    "deviceId": "<UUID>", "name": "Assumed server", "heightU": 4,
    "weightKg": 80, "powerKw": 3, "coolingKw": 3,
    "rackId": "<rack UUID in this layout>", "startU": 35
  }],
  "rackLimits": [{"rackId": "<rack UUID>", "maxWeightKg": 500, "maxPowerKw": 6, "maxCoolingKw": 6}]
}
```

字段严格校验，拒绝多余/缺失字段、数字字符串、非有限数和重复 UUID（大小写归一）。source.kind 仅 ASSUMED，reference 1–512 字符；设备名 1–160。最多 512 设备、256 个柜限值。heightU 为 1–100 整数；startU 为 1–10000 整数并再按柜高检查。需求和限值为显式 null 或 0–1000000 有限数（kg/kW），不会猜默认值。

未上架设备必须 `rackId:null,startU:null`，仍保留全部规格。已上架设备与限值只能引用同一请求布局内的柜；跨方案/项目的柜 ID 拒绝。每个设备 ID 仅一条记录；没有跨方案物理资产唯一性、已有 Assets 实体引用或不可变设备型号目录，不能把随机 ID 当作实物防重复认证。设备规格在本方案内可编辑、跟随版本保存。

每个限值行覆盖该柜的三个容量字段，null 保留未知；没有该行时读取型号三个限值。不是正式容量承诺/分配，不调用容量服务、不扣账，不写上游 Facility。

## 规则与报告

check 响应中的原 `report` 继续只描述空间检查；并列新增 `equipmentReport`。其字段包含 status、coverage、planningSource、devicesChecked、installedDevices、unassignedDeviceIds、racks、diagnostics、uncheckedRules。`racks` 每柜返回 heightU、devicesInstalled、requestedU、occupiedU、freeU、uStatus 和 capacities。

- DEVICE_U_OUT_OF_BOUNDS：设备闭区间超过柜高。不是只检查总 U 数。
- DEVICE_U_OVERLAP：同柜任意两设备的闭区间有交集；相邻 `[1,2]` 与 `[3,4]` 允许，不同柜相同 U 允许。
- RACK_CAPACITY_EXCEEDED：某维度的已知需求小计大于明确上限。诊断包含 dimension、knownSubtotal、limit 和 unit；即便另有未知需求，也能据已知小计判定超限。

容量维度分别返回 knownSubtotal、total（有未知项则 null）、unknownDevices、limit、limitSource 和 status。无未知需求且已知上限内为 WITHIN_LIMIT；有未知需求或上限未知为 UNKNOWN；已知小计超限优先为 EXCEEDED。空柜的已列需求为 0，但限值未知仍是 UNKNOWN。占用 U 使用柜内合法位置的并集，另列 requestedU；冲突时不能用 requestedU 或 freeU 掩盖错误。

容量加法使用补偿求和，比较允许四个机器 epsilon × max(小计,上限) 的浮点表示差，避免 0.1+0.2 在 0.3 限值处误报；不代表工程余量。上限 0 时任何真实正需求仍超限。显示精度不参与后端判定。

状态按顺序：有已知诊断 ISSUES_FOUND；设备清单为空 NOT_CHECKED；其余若清单覆盖 UNKNOWN、存在未上架设备或任一柜容量 UNKNOWN，则 INCOMPLETE；否则 CHECKED_SCOPE_CLEAR。该状态仅针对这份清单和 U 位/三维总量范围。布局的空间报告可能独立为 INCOMPLETE；整体验证始终 NOT_RUN。

## 权限、事务与兼容

读/check 仍需要 rack.read + facility.read，保存需要 rack.write + facility.read。省略 equipment 的旧请求使用存储值重新检查；不能通过删柜意外遗失设备。显式删设备/清空清单是完整文档变更。

保存复用 If-Match、UUID Idempotency-Key、Rack 行锁和 Facility 来源锁；先重新规范化并计算空间与设备规则，再同一事务更新条件、设备、机柜、版本与命令。设备冲突返回 422/RACK_EQUIPMENT_CONFLICT，旧版本 412，输入/不存在柜引用 400；失败整体回滚。相同 key 精确重试恢复成功结果，变更意图复用 key 拒绝；来源变动仍禁写。没有单独的设备 API、独立版本或设备权限旁路。

前端整个 equipment 文档加入检查 body，只有匹配当前 body 的两份后端报告才能放行保存。数字输入暂时清空时显示错误、禁存，不绘制 NaN。草稿仍存在工作区 tab；整页重载前应保存。

## 适用边界与下一步

没有设备深度/导轨/接口兼容检查、双面安装、PDU/供电冗余、机房正式预算、动态热仿真、楼板载荷、跨方案资产占用或完整历史审计。冷却是显式需求总和，功率不是自动推导冷却量，不据此宣称温度或气流可行。

按 n 柜、d 设备、l 限值，建索引与汇总约 O(n+d+l)，同柜 U 冲突比较最坏 O(d²)，绘制/统计占用 U 最多 d×100；诊断最坏同为 O(d²)。512 是受理上限，不是吞吐量承诺；未做正式性能实验，生产仍需应用/迁移账户分离。

证据见 [records/2026-10-28-rack-equipment](records/2026-10-28-rack-equipment/) 和根 [PROGRESS.md](PROGRESS.md)。下一轮可做可解释的规则式布局候选，保持候选预览、校验与应用分开，再接 Rack Assistant；正式预算与依赖仍需独立补齐。
