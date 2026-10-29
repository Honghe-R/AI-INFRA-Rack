# Rack Planner

本工具负责一个 HALL 内的机柜摆放、设备与连续 U 位分配、局部空间和容量检查。课程 Option 2.2 的核心是可解释的规划过程，而不只是展示几台设备。

## 所有权与边界

Rack 拥有 Plan、机柜实例、方案内设备库存/安装关系、规划禁放区和假设预算。Facility 拥有机房 Polygon、孔洞及其版本；Rack 读取并固定副本，不修改 Facility。Catalog 提供版本化规格；目前接入的是本地合成只读目录。Network 拥有网络连接，Power 拥有供电路径/回路，不能把 Rack 的 kW 检查称作完成这两个工具。

## 规范索引

1. [UI 与用户流程](ui-pattern.md)
2. [跨工具输入输出](interchange-contract.md)
3. [实体与不变量](entity-model.md)
4. [存储与事务](storage-shape.md)
5. [HTTP 契约](backend-api-contracts.md)
6. [业务操作面与 Assistant](tool-surface.md)
7. [检查和验收](verification-requirements.md)
8. [需求驱动规划算法与开发顺序](demand-planning.md)
9. [老师平台只读参考记录](reference-observations.md)

## 开发基线（2026-10-29）

已实现：固定机房快照、点阵工作台、拖拽/详情、手工布置、已有柜重排、待上架分配、局部规则、共享草稿和原子保存、方案软删除/恢复、RBAC、Assistant 只读/候选工具。

本轮增量：空方案按目录型号数量生成机柜/U 位/布局候选，经过原规则复核后沿用共享草稿保存；准确实现状态和验证结果见根目录 PROGRESS.md。设计文档定义验收目标，不是通过证明。

待实现：连续访问/疏散通道、正式版本绑定 Validation Run、候选持久化历史、跨方案权威预算预留、厂商完整适配、网络/供电/热工程验证。大模型配置按用户决定暂缓，不能声称自然语言端到端已验收。
