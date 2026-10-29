# Entity model

| 实体 | 关键字段/关系 | 不变量 |
| --- | --- | --- |
| RackPlan | planId、projectId、scenarioId、name、version、facilityInput、deletedAt | 一个方案一个 HALL；独立版本；已删不可编辑 |
| RoomSnapshot | snapshotId、room、view.boundaryLocalM、sourceGeometry、facilityInput | 固定输入；Polygon 与孔洞均保留 |
| RackModel | modelId、widthM/depthM、heightU、三种可空资源上限、source | 米/kg/kW/U；规格与实例分离 |
| Placement | rackId、modelId、name、xM/yM、rotationDeg、locked | 中心坐标；0/90/180/270°；属于本方案 |
| Equipment | coverage、source、devices、rackLimits、可选 roomBudget | 方案内库存；未知不等于零 |
| Device | deviceId、name、heightU、weightKg/powerKw/coolingKw、catalogRef?、rackId/startU | 连续 U；待分配两字段均 null；不能悬空引用 |
| SpatialConstraints | obstacleCoverage、source、obstacles、clearance | 矩形禁放区；前/后净距，非通道连通证明 |
| Candidate | algorithmId、optionId、metrics、unplaced、reports、body | 临时派生；不绕过普通保存 |

目录引用固定版本且需求须与版本一致，未知需求保留 null。自定义设备为显式假设。所有结构拒绝未知字段、数值字符串、非有限数与越界值；ID 唯一且以 UUID 表达。Y 轴显示反转不改变数据，0°正面为局部 -Y。

已保存锁定柜不能通过同次修改 locked=false 并移动绕过保护，先保存解锁。删除柜前须处理设备与其 rackLimits。资源限值可空；需求规划为保守装箱要求单柜三维限值已知，不能拿 unknown 当无限。
