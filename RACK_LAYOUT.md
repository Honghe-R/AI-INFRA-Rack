# Rack 布局编辑与保存 v1

日期：2026-10-28。已完成机柜手工编辑的小闭环；设备、容量、障碍物、维护净距、算法和 Rack Assistant 尚未接入。

## 本地更新与演示

仅在 `C:\Users\RHH\Desktop\AI-INFRA-Rack` 操作。已有环境执行 `npm run migrate` 后启动 `npm run dev`，无需重跑 seed。首次使用按 [运行说明](RACK_LOCAL_SETUP.md)。

1. 打开 http://localhost:5193/ → Northern DC Campus → Navigation → Rack。
2. 创建空方案。受支持的 HALL Polygon 与来源元数据在创建事务中固定；旧方案用 Capture room input 显式捕获一次。
3. Edit layout → 选择假设型号 → Add rack。选中柜后可输入中心 X/Y、改名称、旋转、锁定和删除；也可在图面拖动未锁定柜。
4. 点击清单或 Focus rack 放大到单柜；Fit room 查看全场。机柜正面为粗线，坐标保留精度，不吸附网格。
5. Spatial checks 会向 API 请求检查，显示冲突代码、对象名称与高亮；点击诊断定位。无冲突后 Save layout。
6. Refresh plans 或整页重开，读取同一方案 ID、快照和保存机柜。Discard changes 放弃本次草稿。

本机保留 `Rack editor demo — Hall A1`，ID `24b5422e-8206-4a76-bdf5-9f7e93a05aac`。它是本机数据，不随 Git 分发；组员自行创建。原 `Rack UI demo — Hall A1` 未修改。

## 输入与存储

`008_rack_layout.sql` 新增下列数据，并将 `rack_plans.version` 从固定 1 改为正整数：

| 表 | 含义 |
| --- | --- |
| rack_models | 两个共享只读演示型号，600/800 × 1200 mm，42U，ASSUMED；重量/电力/冷却限值均为 null |
| rack_room_snapshots | 每方案唯一固定输入：局部 Polygon、来源几何 ID/CRS、投影原点、转换与来源版本、创建人/时间 |
| rack_placements | 柜 ID、型号引用、名称、中心坐标、方向和锁定；归属方案/项目 |
| rack_layout_commands | 成功写命令的 UUID、请求 hash、应用版本、执行人/时间；用于幂等恢复 |

机柜表通过复合 FK 绑定同项目方案快照。快照、机柜和命令表启用并强制项目 RLS；共享型号不含项目私有数据，无型号写 API。型号不能经现有 API 更改；以后改规格需新 ID，不能重新解释已有布局。

坐标沿用 [平面图 contract](RACK_FLOORPLAN.md)：受支持的 WGS84 UTM 投影米，平移为局部 X 东/Y 北；机柜中心为位置，逆时针四分之一转。最大 256 柜，坐标 ±10000 m，名称 1–160 字符，型号只能来自服务端目录。拒绝未知字段、重复 ID、伪造项目/方案归属、非有限数和非法方向。

保存成功整个机柜集合原子替换，推进方案版本、更新修改人/时间并记录命令；失败整体回滚。不修改 Facility 表、几何或 ETag。没有设备数据、历史版本恢复、删除方案或来源重绑定 API。

## HTTP contract

共同前缀：`/api/v1/projects/:projectId/rack/plans/:planId`。沿用身份客户端、后端 guard、`{data,meta}` / `{error,meta}` 和 correlation ID。

| 方法/后缀 | 权限 | 行为 |
| --- | --- | --- |
| GET /layout | rack.read + facility.read | 单语句读取版本、固定输入、来源状态、型号、已存机柜；ETag 为带引号的方案版本 |
| POST /room-snapshot | rack.write + facility.read | 显式捕获旧方案输入；已捕获则返回原快照；请求 `{contract_version:1}` |
| POST /layout/check | rack.read + facility.read | 仅计算提交的草稿；不写数据、不推进版本，viewer 也可检查 |
| PUT /layout | rack.write + facility.read | 检查版本、来源、快照、型号、锁定及真实 Polygon 后保存整个集合 |

布局 GET 的 `data` 包含：`contractVersion, projectId, planId, scenarioId, version, facilityInput, sourceStatus, snapshot, placements, models, validationState`。
`snapshot` 是 null 或 `{snapshotId,room,view,sourceGeometry,facilityInput}`；`view.boundaryLocalM` 包含所有外环/内环坐标。

check 和 save 的 body 相同（示意 UUID 要换成实际值）：

```json
{
  "contract_version": 1,
  "snapshot_id": "<fixed snapshot UUID>",
  "placements": [{
    "rackId": "<rack UUID>",
    "modelId": "10000000-0000-4000-8000-000000000001",
    "name": "A01", "xM": 3, "yM": 3,
    "rotationDeg": 0, "locked": false
  }]
}
```

写命令必须带 `Idempotency-Key: <UUID>` 与 `If-Match: "N"`；`N` 为当前正整数版本。成功 200，返回当前完整 layout 与 `meta.replayed, meta.applied_version`。
新捕获推进版本，创建时自动捕获仍为初始 v1，已存在快照的重复捕获不推进；每次成功布局保存（包括同值保存）推进一次。

缺头 428；结构/目录/锁定错误 400；旧版本 412 `RACK_VERSION_CONFLICT`；来源过期、快照不匹配、同 key 不同请求 409；几何冲突 422 `RACK_LAYOUT_CONFLICT`，`error.details[0].report` 包含诊断。不存在/权限沿用 404/401/403。

服务器先锁住方案行；同 key 精确重试在版本/来源检查之前恢复成功结果，避免响应丢失后被自身版本变更阻塞。hash 包含操作、If-Match 和解析后的原请求 body；请保持键顺序/数组顺序及值，不重新生成重试意图。
返回的是**当前布局**，可能高于命令原来应用的版本；原应用版本见 `meta.applied_version`。权限每次重查，不以 key 代替授权。
不同 key/相同基础版本的并发写入只有一个成功，另一个 412。命令记录没有过期清理/数量限额，后续需补策略。

保存时再锁 Facility ETag/revision 并复读，避免在核对来源与提交之间被设施写入越过。来源变化不会替换原快照；GET/check 仍可查看旧快照，新的保存/捕获被阻止。没有实时推送，已打开页面通过刷新复查，后端写入始终重查。

## 实际空间规则与限制

后端用领域包按服务端型号生成矩形占地，再用 PostGIS 对固定 Polygon 运算；前端坐标/颜色仅供交互，保存始终重算。

| 规则 | 实际语义 |
| --- | --- |
| RACK_OUTSIDE_ROOM | ST_Covers(room, footprint) 为 false；检查整个占地，不能只检查角点或包围框 |
| RACK_HOLE_CONFLICT | 占地接触或覆盖任一内环区域；小孔完全被占地盖住也拒绝 |
| RACK_PAIR_OVERLAP | 两柜内部相交；机柜边/角相切允许 |

外墙相切允许；孔洞相切保守拒绝。使用存储浮点坐标的 PostGIS 拓扑语义，没有额外 epsilon/网格吸附或施工净距容差。微小正重叠仍是冲突；工程容差模型待补。

报告状态为 `ISSUES_FOUND`、`CHECKED_SCOPE_CLEAR` 或空布局 `NOT_CHECKED`；包含 `scope,diagnostics,racksChecked,pairsChecked,obstacleCoverage,uncheckedRules`。诊断有 code、severity、双方 rackIds 和文字。

`CHECKED_SCOPE_CLEAR` 仅覆盖 Polygon 包含、内环和柜间重叠。障碍清单 UNKNOWN；维护净距、通道、设备、U 位、重量、电力、冷却和工程精度均未检查。方案 `validationState` 仍为 `NOT_RUN`，不自动发布/冻结。
现有 Facility 合成数据配准审核为 NOT_RECORDED；型号是假设规格，容量未知。图上能放置不等于工程方案可实施。

已保存锁定柜必须先独立保存解锁，再移动/旋转/替换型号/删除；同请求同时解锁并移动也拒绝。名称可修改。前端同步禁用受限操作，后端独立执行规则。

## 工作区状态与恢复

编辑草稿放在 tab routeState，切换工具后保留；选其他方案/新建入口在有草稿时禁用。dirty 接工作区关闭/上下文保护和 beforeunload 提示。未保存内容没有跨整页重载持久化保证。
草稿检查做 250 ms debounce、取消旧请求并按精确 body 关联结果；取消/旧响应不能覆盖新草稿诊断。
网络/超时/5xx 结果不确定时保留精确 body、基础版本和 UUID key，禁改/禁丢弃，使用 Retry same save；即使刷新后版本或来源变化也允许重试此意图。后端明确拒绝后可修正或丢弃。
旧方案捕获的临时重试 key 只存在组件内；重挂载会丢 key，但服务器保证一个方案只捕获一个快照，重复捕获不替换原输入。

## 验证与剩余工作

领域 83 项、真实 DB/API 26 项、相关 Web 57 项通过，Web 构建成功；见 [证据目录](records/2026-10-28-rack-editor/) 和 [进展](PROGRESS.md)。验证仅覆盖对应范围，不代表全仓或工程校核通过。
实际页面已验证添加、重叠拦截、表单改位置/旋转、锁定、拖动、切换工具保留、dirty 关闭保护及保存重读。并发冲突和事务失败回滚主要由真实 API/数据库测试验证。
没有浏览器断网响应丢失故障注入；未做完整压力/性能实验、正式审计、最小权限生产部署或完整无障碍审计。
下一步补障碍与维护净距输入/规则，再做设备及容量闭环，之后推进算法、候选应用与 Rack Assistant。
