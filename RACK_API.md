# Rack 方案与布局 API v1

2026-10-29 新增只读 `POST .../plans/:planId/layout/options`，按保存版本/固定快照生成两种有限布局候选，需 rack.read 与 facility.read。完整请求/响应、边界与错误见 [RACK_PLANNER.md](RACK_PLANNER.md)。候选确认转普通共享草稿后仍通过原 PUT layout 保存；没有新迁移或独立 candidate apply 写入路径。

2026-10-28 已扩展为版本化布局保存。本文前半部分为方案创建/列表/详情；布局操作见文末及 [布局 contract](RACK_LAYOUT.md)。
原平台启动方式见 [RACK_LOCAL_SETUP.md](RACK_LOCAL_SETUP.md)。已有环境更新代码后执行 `npm run migrate`，
再启动/重启 `npm run dev`；不必重新运行 seed。

## 创建

`POST /api/v1/projects/:projectId/rack/plans`

需要已认证用户在路径指定项目拥有 `rack.write`。
开发时通过 `http://localhost:5193/api/...` 请求可使用既有 Vite 身份代理；
直接请求 API 端口需要合法 bearer token。生产环境不应使用开发身份代理。

必填请求头：`Content-Type: application/json`、`Idempotency-Key: <UUID>`。
每个新的创建意图生成一个 UUID；重试同一个创建意图复用该 UUID。

```json
{
  "contract_version": 1,
  "name": "机房 A 的 Rack 草稿",
  "scenario_id": "<场景 UUID>",
  "facility_input": {
    "revision_id": "<设施 revision UUID>",
    "container_id": "<HALL 容器 UUID>",
    "revision_etag": "<刚读取的设施 ETag>"
  }
}
```

尖括号内容须替换成真实值；可从原场景列表和 Facility revision GET 返回值中取得。
创建必须同时满足：场景、revision、容器均真实属于路径项目，容器属于该 revision/场景，
容器类型为 HALL，设施 revision 是 DRAFT，且请求 ETag 与数据库当前 ETag 精确相同。
当前不接受 BUILDING/FLOOR、冻结输入或用户自报的边界；空方案创建不要求已有可用局部几何，
也不意味着房间已具备开展布局检查的条件。

拒绝未知字段，包括客户端提交的 plan ID、项目归属、版本、状态、校验结果、创建人和 placements。
名称沿用领域构造器的非空/长度检查并 trim；UUID 规范化为小写；ETag 保持不透明且区分大小写。

成功为 **201**，返回标准 `{data, meta}`，`meta.replayed=false`，并设置 `Location` 为读取路径。
`data` 是既有 camelCase Rack contract 加服务端元数据：

| 字段 | 创建时的含义 |
| --- | --- |
| `contractVersion` | 固定 1 |
| `planId`、`projectId`、`scenarioId` | 服务端生成方案 ID，归属经真实数据库核对 |
| `name` | 规范化名称 |
| `version`、`state`、`validationState` | `1`、`DRAFT`、`NOT_RUN`，与 Facility 生命周期独立 |
| `facilityInput` | projectId/scenarioId/revisionId/containerId/revisionEtag，保存创建时的来源引用 |
| `placements` | 创建时为空数组；后续 GET/创建重放返回实际保存的 placements |
| `createdAt`、`createdBy` | 数据库时间、认证用户 ID |
| `facilityInputStatus` | 服务端读取的来源状态，见下节 |

相同项目内，同 key + 相同规范化请求返回 **200** 和同一个方案，`meta.replayed=true`；
并发重试也只产生一条记录。同 key + 不同请求返回 **409 IDEMPOTENCY_KEY_REUSED**。
key 在不同项目可独立使用，无过期清理机制；生命周期随方案记录。
重试会重新检查当前用户权限，并重算来源状态，响应不是对首次 JSON 的逐字重放。
因此旧请求重试能找到原方案，同时可能显示 STALE，不会偷偷改绑其输入。

## 列表

`GET /api/v1/projects/:projectId/rack/plans`

需要该项目的 `rack.read`。可选查询参数：

| 参数 | 规则 |
| --- | --- |
| `scenario_id` | UUID，只读该场景 |
| `revision_id` | UUID，只读绑定该 Facility revision 的方案 |
| `limit` | 十进制整数 1–50，默认 20 |
| `cursor` | 上一页 `nextCursor`，为上一页最后一个方案的 UUID |

返回 `200`、标准 `meta.correlation_id`，以及 `data: { items: [方案响应], nextCursor: UUID或null }`。
items 使用下方单条 GET 的结构，也重新计算来源状态。未知参数、非法 UUID 或超限 limit 返回 400 `RACK_INPUT_INVALID`。
始终按项目过滤，场景/revision 过滤取交集；没有匹配记录返回空页，不透露其他项目的记录。
排序为 `created_at DESC, plan_id DESC`，用数据库原始时间精度与 ID 做 keyset 分页；翻页须保留原过滤参数。
cursor 只在同项目、同过滤范围内查找，错误范围、不存在或已删除的 cursor 返回空页。
分页不固定整个列表快照；新插入的方案通过刷新首页查看，翻页不会因这些新记录产生 offset 位移。
本轮没有数据库迁移或规模性能承诺；大规模排序/索引优化留待实测。

## 读取

`GET /api/v1/projects/:projectId/rack/plans/:planId`

需要该项目的 `rack.read`。返回 **200** 和同样的 `data` 结构。
不存在的方案、错误项目下的方案 ID 或非法方案 UUID 返回 404。
存储字段和当前来源状态在同一 SQL 语句中读取；GET 不写库，不更新版本或验证状态。

`facilityInputStatus` 包含：

| 字段 | 含义 |
| --- | --- |
| `status=UNCHANGED` | 当前 ETag 与保存值相同且来源仍是 DRAFT；不表示布局已验证 |
| `status=STALE` | ETag 已变化或来源不再为 DRAFT；当前切片不能据此继续编辑/验证布局 |
| `status=UNAVAILABLE` | 来源 ETag 行缺失，无法确认当前版本 |
| `reasons` | `ETAG_CHANGED`、`SOURCE_NOT_DRAFT`、`ETAG_MISSING` 的适用组合 |
| `currentRevisionEtag`、`lifecycleState` | 当前服务端读取值；ETag 缺失时为 null |

来源变更不修改保存的 `facilityInput.revisionEtag`，不自动重绑方案，不推进 Rack 版本，
也不让 Facility 验证通过变成 Rack 验证通过。

## 拒绝行为

| HTTP | code / 情形 |
| --- | --- |
| 400 | `UNSUPPORTED_CONTRACT_VERSION` / `RACK_INPUT_INVALID`，包括非法 key UUID、未知字段和非法参数 |
| 401 | 未认证 |
| 403 | 无对应项目权限（沿用原权限错误 code） |
| 404 | 项目、方案、场景/revision/容器的声明归属不成立或对象不存在 |
| 409 | `IDEMPOTENCY_KEY_REUSED`、`RACK_ROOM_REQUIRED`、`RACK_SOURCE_STATE_UNSUPPORTED`、`RACK_SOURCE_ETAG_MISSING`、`RACK_SOURCE_STALE` |
| 428 | `IDEMPOTENCY_KEY_REQUIRED` |

成功/错误均保留原平台的 `meta.correlation_id`。方案命名/方案删除尚无更新接口；布局保存、快照和局部空间检查见文末。

## 存储与权限边界

- `007_rack_plans.sql` 新增 `rack_plans`、两个项目级权限及预设映射；不修改既有迁移。
- project-admin/editor 可创建和读取；project-viewer、organisation-admin 只读。
  system-admin 和 showcase 没有因此获得 Rack 内容权限。自定义角色仍按实际授权判定。
- 复合外键约束真实项目/场景/revision/容器身份；来源容器被引用后不能直接删除。
  后续需定义显式解绑/归档和与 Facility 删除操作的完整交互，不静默丢弃方案。
- 新表启用并强制 RLS；普通角色需要在事务中设置 `app.project_id`。服务统一用 `withTenant`，
  即使本地初始化超级用户绕过 RLS，也始终在查询中显式限定 project_id。
- 创建在同一事务锁住幂等 key、读取/锁住来源、比较版本并插入；不修改上游设施表或 ETag。
- 内部服务要求调用方先授权；本轮只有经过原路由 guard 的 HTTP 入口，未开放 Assistant 工具入口。
- 另记录最近修改人/时间、成功布局命令的 hash/版本/执行人，以及请求 correlation 日志；没有完整历史版本恢复或 outbox 审计链路。
- 008 迁移将版本约束扩展为 >=1，并新增快照、型号、机柜和幂等命令表；状态仍限定 DRAFT、NOT_RUN。

首次存储验证见 [持久化证据](records/2026-10-28-rack-persistence)，列表和页面验证见 [工作区证据](records/2026-10-28-rack-ui)。
本轮机柜编辑保存及独立版本控制已接通，详见 [布局说明](RACK_LAYOUT.md)。

## 只读机房平面图

`GET /api/v1/projects/:projectId/rack/plans/:planId/room-view` 需要同时具有 `rack.read` 与 `facility.read`。
按保存来源的项目/场景/revision/HALL 读取唯一投影边界，在同条 SQL 内复核来源 ETag 和生命周期。
返回可显示的米制 Polygon 或明确的阻止/不支持状态；不创建快照，不更新方案或设施数据。
完整字段、状态码、支持范围和转换约定见 [RACK_FLOORPLAN.md](RACK_FLOORPLAN.md)。

## 固定输入与机柜布局

第十轮新增 `GET /layout`、`POST /room-snapshot`、`POST /layout/check`、`PUT /layout`，均在单方案路径下；详见 [请求/响应、并发与规则 contract](RACK_LAYOUT.md)。
读取/检查同时需要 rack.read 和 facility.read，捕获/保存同时需要 rack.write 和 facility.read。写请求要求 UUID Idempotency-Key 与带引号正整数 If-Match。保存时重算固定 Polygon 检查，422 拒绝几何冲突，412 拒绝旧版本；错误不留下部分机柜。
创建时自动捕获支持的唯一边界；旧方案显式捕获。固定快照来源变化后仍可查看，新的写入阻止；旧 `/room-view` 仍只读取未过期的当前来源。方案 validationState 保持 NOT_RUN。

## 第十一轮补充：空间约束 contract

`GET /plans/:planId/layout` 现在返回 `constraints`；布局 check POST 与保存 PUT 的 v1 请求增加可选 `constraints`。完整字段、诊断与边界见 [RACK_CONSTRAINTS.md](RACK_CONSTRAINTS.md)。省略字段保留数据库已有值，显式 null 拒绝；机柜与约束同事务保存，复用 If-Match、UUID 幂等 key、来源锁及既有权限。

报告新增障碍 ID、FRONT/REAR、障碍数、维护带数和规划来源。非空布局无已知冲突但障碍覆盖 UNKNOWN 或净距未设时为 INCOMPLETE；已声明完整且明确净距后才可能 CHECKED_SCOPE_CLEAR。该状态不推进整体 NOT_RUN。空机柜清单仍检查已提供障碍，存在问题返回 ISSUES_FOUND；无问题返回 NOT_CHECKED。

迁移 009 为旧方案填入未知覆盖、空障碍与 null 净距，不改版本或原机柜。真实 API 32 项通过，迁移 9 项首次/重复通过；证据见 [本轮记录](records/2026-10-28-rack-constraints/)。

## 第十二轮补充：设备与容量

010 迁移新增 rack_plans.equipment，旧方案初始化为空清单/未知覆盖且不推进版本。layout GET 返回 equipment；v1 check/save 请求增加可选 equipment，省略保留存储值、显式 null 拒绝。check 响应并列增加 equipmentReport，空间 report 保持原范围。

支持同方案唯一设备 ID、规格、已上架/未上架状态、U 闭区间与三维容量假设。设备与机柜同一版本/事务保存，复用身份、权限、来源锁和幂等；已知冲突 422/RACK_EQUIPMENT_CONFLICT，不存在/外部柜引用 400，旧版本 412。设备 ID 不是全局物理资产注册，限值不是正式预算，整体 NOT_RUN 不变。完整字段、规则、报告和限制见根 [RACK_EQUIPMENT.md](RACK_EQUIPMENT.md)。

## 第十三轮：只读 Catalog 与固定型号引用

GET /api/v1/projects/:projectId/rack/catalog 需要 rack.read，返回精确版本组件/型号及规则示例，无写接口。equipment.devices 可选 catalogRef {modelId,version}，check/save 核对四项规格，非法引用/规格返回 400/RACK_INPUT_INVALID。省略引用为方案自定义假设，原事务/版本/权限语义保留。详见 [RACK_CATALOG.md](RACK_CATALOG.md)。
