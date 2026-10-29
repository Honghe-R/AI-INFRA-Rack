# Tool surface

领域包 `packages/rack` 定义纯规则/算法，API service 负责权限后的租户读取、权威 PostGIS 检查与写事务。Web 与 Assistant 必须复用这套服务，不能自行写表或复制另一套判定。

| 业务操作 | 消费者 | read/write 与范围 |
| --- | --- | --- |
| list/get plan、read room/layout/catalog | Web、部分 Assistant 投影 | READ，本项目有上限 |
| check layout/equipment/capacity、explain source | Web、Assistant | READ，固定输入和有限范围 |
| generate existing-rack options | Web、Assistant | READ，64 movable、16384 poses/option |
| allocate unassigned equipment | Web、Assistant | READ，128未分配、64目标柜 |
| generate demand design | 本轮 Web/API，Assistant 投影后续补 | READ，空方案，见需求规划预算 |
| create/save/rename/delete/restore plan | Web | WRITE，权限/版本/幂等/审计事务 |

Assistant 已接 Rack 只读和候选工具，但模型尚未配置；自然语言结果不能等于保存授权。涉及应用候选必须经用户复核和原普通保存。需求规划不是“已经开放给模型的新工具”，后续应按相同 scope/schema/预算投影。

当前并非完整平台 named-command 注册框架迁移。文档描述服务边界与现有投影，不捏造 publish、正式验证、批量全项目资产或跨工具写权限。必须保留未知字段、来源、固定版本和可解释的失败原因。
