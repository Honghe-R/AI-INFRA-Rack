# Backend API contracts

base = `/api/v1/projects/:projectId/rack/plans`。所有接口要求有效项目身份；布局/图纸还要求 facility.read。

| 操作 | 路由 | 权限/关键前置条件 |
| --- | --- | --- |
| 列表/详情 | GET base、base/:planId | rack.read；分页和 deleted=true 分列表 |
| 创建 | POST base | rack.write；contract_version=1、name、scenario_id、facility_input；Idempotency-Key |
| 重命名/软删/恢复 | PATCH/DELETE base/:planId、POST .../restore | rack.write、If-Match、Idempotency-Key |
| 布局/图面 | GET .../layout、.../room-view | rack.read + facility.read |
| 捕获快照 | POST .../room-snapshot | rack.write + facility.read、If-Match、Idempotency-Key |
| 完整局部检查 | POST .../layout/check | rack.read + facility.read；contract_version、snapshot_id、placements、constraints/equipment |
| 已有柜重排 | POST .../layout/options | rack.read + facility.read；base_version、snapshot_id、options |
| 待上架分配 | POST .../layout/equipment-options | rack.read + facility.read；base_version、snapshot_id |
| 按数量规划（本轮） | POST .../layout/design-options | rack.read + facility.read；base_version、snapshot_id、demand；空方案、固定源未变 |
| 普通保存 | PUT .../layout | rack.write + facility.read；If-Match、Idempotency-Key；完整 body |

设计候选 demand schema、算法与边界见 [demand-planning](demand-planning.md)。只读生成不需要写入幂等键。返回统一 `{data,...}`，候选 envelope 绑定输入版本，body 复用保存格式。请求参数严格拒绝未知字段。

错误：400结构/目录错误，401未认证，403缺权限，404范围中不存在，409源/快照/非空方案/幂等冲突，410已删，412旧版本，422保存局部冲突，428缺版本/幂等，503生成时限。错误不允许产生部分保存。没有 publish/validate 工程签章 API。
