# 未分配设备自动上架

2026-10-29，第十七轮。只修改 Rack 副本，未提交或推送；不增加迁移。

## 操作

Rack → Devices & U slots，选择 **Rack allocation demo — unassigned devices**，点击 **Generate device allocation**。

页面展示设备/目标柜/连续 U 区间、空闲 U 前后变化、分配后重量/功率/冷却需求与限值、只读柜内立面、未分配原因。复核后 **Use allocation as draft**，再 **Save layout**。生成和转草稿不写数据库，普通保存才改变方案。

独立合成示例有 3 柜/6 台设备，5 台原本未分配：3 台可上架；100U 设备因连续位置不足、另一台因重量未知保留未分配；1 个锁定柜不作为目标。规格全部是假设，不是厂商数据或工程认证。浏览器验收后已放弃草稿，示例保留 v2 初始状态。

自己的方案先 Edit layout，填写设备需求和目标柜容量限值假设并保存。已有草稿时禁止生成，避免混用草稿与保存版。

## 算法

纯领域实现：[allocator.js](packages/rack/src/allocator.js)。`unassigned-first-fit-decreasing-v1`：

1. 规范化设备并运行原设备检查，已有 U 重叠/越界/超限先修复。
2. 只将未分配设备按 U 高度降序排序，相同高度按 UUID 字典序。
3. 目标柜按 UUID 排序，排除锁定柜。原安装位置、柜位置、型号版本、来源与限值保持。
4. 从 U1 向上找第一个连续空闲区间。只有该设备及目标柜已有设备的三种需求、柜限值全部已知且不超限时才分配。
5. 补偿求和与四机器精度容差和原检查器一致，不是工程裕量。最终再跑完整设备检查，API 同时跑原 PostGIS 空间检查。

`null` 不当 0 或无限容量。设备未知返回 `UNKNOWN_DEVICE_RESOURCE`；无目标柜返回 `NO_UNLOCKED_RACK`；其他返回 `NO_ELIGIBLE_POSITION`，附每柜 `NO_CONTIGUOUS_U`、`UNKNOWN_RACK_CAPACITY`、`CAPACITY_EXCEEDED` 拒绝计数。它们只解释该贪心过程，不证明一般问题无解。

上限：128 台未分配设备、64 个未锁定目标柜、100U/柜；原库存512设备/256柜限制保持。搜索有界，同步运行；资源检查需遍历目标柜设备。没有新柜创建、已装设备重排、双面安装、全局资产分配、最优解或大规模并发性能结论。

## API / 保存 contract

`POST /api/v1/projects/:projectId/rack/plans/:planId/layout/equipment-options`

```json
{ "contract_version": 1, "base_version": 2, "snapshot_id": "保存版快照 UUID" }
```

需要 `rack.read + facility.read`，使用 tenant READ ONLY 事务，只从服务器读取数据，拒绝自报设备/限值/未知字段。旧版412；来源/快照冲突409；参数/规模400；单SQL5秒超时503。

响应含项目/方案/基准版本/快照/Facility引用、SHA256输入指纹、`scope: UNASSIGNED_DEVICES_ONLY`、`persisted: false`、`validationState: NOT_RUN`、基线设备报告和一个候选。候选包含算法版本、`assignments`、设备 `unassigned`、指标、完整报告、普通保存 `body`。

复用布局草稿 contract，候选 `unplaced: []` 专指机柜，未分配设备另放 `unassigned`。允许部分上架，其余完整保留；至少有新增分配、无设备/空间错误才可选用。零新增分配不可选用，INCOMPLETE 不升级成整体验证通过。

前端复核权限、归属/版本/快照/来源、确认和无旧草稿后复制 body；普通 PUT 再查权限、If-Match、来源锁、锁定机柜、全部规则，沿用原子事务与UUID幂等重试。没有新候选表或历史，输入指纹不是审批凭证。

## 证据

统一保存在 [records/2026-10-29-rack-assistant](records/2026-10-29-rack-assistant/)：`domain-tests.txt`、`api-tests.txt`、`web-tests.txt`、`web-build.txt`、`browser-checks.md`、`allocation-preview.jpg`。

[示例脚本](records/2026-10-29-rack-assistant/create-allocation-demo.mjs) 只允许指定隔离栈/本机合成来源，通过正常 HTTP 创建独立新示例，重复按名称复用、不覆盖。前后比较五个旧示例完整布局相等；不要在用户编辑该演示后用脚本重置它。真实保存与拒绝路径通过隔离数据库测试 fixture 验证，浏览器只转草稿并放弃。
