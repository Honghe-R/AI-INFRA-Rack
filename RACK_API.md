# Rack 空方案 API v1

2026-10-28 实现的最小持久化闭环。只创建和读取空方案，不能保存机柜布局。
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
| `placements` | 空数组；本轮没有机柜表或布局文档存储 |
| `createdAt`、`createdBy` | 数据库时间、认证用户 ID |
| `facilityInputStatus` | 服务端读取的来源状态，见下节 |

相同项目内，同 key + 相同规范化请求返回 **200** 和同一个方案，`meta.replayed=true`；
并发重试也只产生一条记录。同 key + 不同请求返回 **409 IDEMPOTENCY_KEY_REUSED**。
key 在不同项目可独立使用，无过期清理机制；生命周期随方案记录。
重试会重新检查当前用户权限，并重算来源状态，响应不是对首次 JSON 的逐字重放。
因此旧请求重试能找到原方案，同时可能显示 STALE，不会偷偷改绑其输入。

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

成功/错误均保留原平台的 `meta.correlation_id`。本轮没有列表、更新、删除、布局保存或校验 API；
`GET /.../rack/plans` 也没有实现，不能把空方案保存当作完整编辑闭环。

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
- 只有创建人/时间和请求 correlation 日志，没有完整的业务审计/outbox 链路。
- 该表限定版本 1、DRAFT、NOT_RUN。扩展修改命令时必须新增迁移和并发控制，不能只改服务返回值。

测试见 [本轮证据](records/2026-10-28-rack-persistence)。
下一步先补方案列表和工作区中的创建/查看入口，再推进真实几何输入和机柜保存。
