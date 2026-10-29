# 需求驱动规划 v1：先规范，再按此实现

## 输入与目标

只支持空的已保存方案（无柜/设备/单柜限值），已有边界快照且 Facility 未变。保留已保存禁放区和房间预算，允许请求覆盖完整 constraints 和 roomBudget。请求 demand：

```json
{
  "groups": [{"modelId":"demo-gpu-4u","version":1,"quantity":8}],
  "rackModelId":"10000000-0000-4000-8000-000000000001",
  "maxRacks":16,
  "rackLimits":{"maxWeightKg":800,"maxPowerKw":12,"maxCoolingKw":12},
  "sourceReference":"Course planning assumptions; confirm before engineering use",
  "gapM":0.2,
  "constraints":{"obstacleCoverage":"UNKNOWN","source":{"kind":"ASSUMED","reference":"User planning assumptions"},"obstacles":[],"clearance":{"frontM":1,"rearM":0.6}}
}
```

单柜上限显式输入；目录规格由后端按版本解析，不能客户端随意提供。未知设备需求保留未分配并阻止采用；启用但未知房间预算也阻止采用。未提供预算沿用保存值，未记录预算只做局部规划并显式 INCOMPLETE。

优先满足全部设备，其次减少柜数，再比较机柜包围面积。目标是有限搜索中的可用紧凑候选，不声称全局最优。

## 算法与预算

基线：输入顺序 First Fit；启发式：按 U/重量/功率/冷却占单柜比例的最大值降序 Best Fit。各柜从 U1 连续向上装，按同一资源浮点容差判断。使用量不超过显式上限，柜型号已知上限不能被假设放宽。无法放入的设备仍留库存并有原因。

几何阶段枚举紧凑矩阵的列数与0/90°方向，在真实房间包围盒内有限平移。行距保守预留前+后维护带和 gap，柜间横向 gap。每一整体排列经 PostGIS Polygon/孔洞/障碍筛选，随后运行原全布局/设备检查。只找完整矩阵，复杂障碍可能需要手工或后续局部搜索。

形状按界面展示的机柜占地区包围面积、最长跨度排序，维护带仍全部参与可行性检查。gap 是最小间距；0时额外留1微米数值分隔，避免浮点导致名义共边Polygon发生微小重叠及GEOS错误，不放宽检查容差或替代工程净距。整体提案使用GeometryCollection保留独立柜占地，最终仍逐柜完整复核。

最多16需求组、128设备、32柜；每种装箱策略最多256个整体几何提案、每批16个，包含所有允许列数/方向的公平轮询；SQL5秒、请求15秒。固定输入摘要派生稳定 ID；算法无随机种子和 IO。受限搜索无结果表述为 NO_COMPACT_LAYOUT/SEARCH_LIMIT，不能宣称房间装不下。

## 开发和验收顺序

1. 固定本文 schema/状态/边界及8份规范。
2. 纯领域需求展开/资源装箱/几何提案，测试未知、上限、确定性和不丢设备。
3. 接只读 design-options 服务、原 PostGIS 检查、普通保存格式及 HTTP 契约测试。
4. 空方案主入口的数量/限值/净距表单，比较与确认转共享草稿，沿用工作台保存。
5. 统一辅助预览点阵与自动适配；实际浏览器完整流程验收并记录证据。
6. 下一轮再做连续通道、正式验证记录和规模实验；不在本轮扩展网络/供电拓扑。
