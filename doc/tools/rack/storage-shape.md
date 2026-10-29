# Storage shape

当前持久化在 PostgreSQL/PostGIS，使用既有租户事务/RLS。Rack 表与 Facility 表分离：

- rack_plans：方案引用、version、spatial_constraints/equipment JSONB、创建/修改身份、deleted_at/deleted_by；活动列表索引排除已删。
- rack_room_snapshots：方案固定房间输入 document JSONB 与 snapshot_id。
- rack_placements：方案柜清单，UUID、型号、位置/旋转/locked。
- rack_models：服务端机柜定义。
- rack_layout_commands：幂等键、请求 hash、applied_version 和 actor；布局/生命周期使用同一个方案行锁。
- 设备目录暂为领域包只读版本数据，无新的全局资产表。

普通保存一个事务内核对版本、锁 Facility token/lifecycle、读取源状态、规范化、检查、替换布局/库存/约束、推进版本并记录命令；失败整体回滚。相同 key 和请求可回放，不同请求复用 key 冲突。

候选生成使用 readOnly 事务和 query/deadline 上限，不写候选、设备或命令表；需求规划不新增迁移。浏览器草稿临时存在共享状态，重载可能丢失，不能当持久化历史。Rack HTTP no-store，避免恢复后缓存410。无对象存储、跨请求候选缓存或正式 Validation Run 表。

本机迁移011已应用；其他已有库需 npm run migrate。不要以 reset/seed 清空组员数据。
