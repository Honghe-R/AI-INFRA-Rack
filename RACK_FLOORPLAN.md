# Rack 机房平面图与坐标

日期：2026-10-28。本文说明几何转换和旧只读 room-view API；当前工作区已使用固定快照和可编辑机柜，见 [布局说明](RACK_LAYOUT.md)。

## 入口与操作

打开 <http://localhost:5193/> → Northern DC Campus → Navigation → Rack，选择 `Rack editor demo — Hall A1`。旧方案无快照时先 Capture room input。
其他本地库可以先创建自己的空方案，再选择它。

- 拖动图面或使用方向键平移。
- 滚轮、+ / − 按钮或键盘 + / − 缩放。
- Fit room、Home 或 0 恢复完整机房视图。
- Coordinates and source 查看坐标原点、投影、几何 ID、来源与地理配准审核状态。
- Saved plan details 查看原来的方案元数据。

图面、网格和比例尺使用相同的等比例坐标变换；窗口变窄时图面同比缩放。视口变化仅保存在当前组件内，不写数据库或推进方案版本。

## 来源与坐标 contract v1

权威测量输入是 Facility `geometry_records.projected_geometry`；不从经纬度差或屏幕像素估算米数。
精确查找方案保存的 project/scenario/revision/container，只接受唯一一条 HALL 的 `FLOOR_BOUNDARY` 或 `ROOM_BOUNDARY`。
两种 role 同时存在、多 ordinal 或其他多候选情况不自动择一。

当前支持：

- 匹配的 WGS 84 UTM：EPSG:32601–32660（北半球）与 32701–32760（南半球），列中的 CRS 字符串必须与几何 SRID 一致。
- 通过 PostGIS `ST_IsValid` 的非空二维 Polygon，保留凹形轮廓及所有内环；不简化，不转换成矩形。
- 最多 4096 点、64 个环；X/Y 范围分别大于零且不超过 10 km。

不支持的 CRS（含地理经纬度、英尺、Web Mercator）、多多边形、3D、非法几何和超限数据均返回明确原因。
坐标定义：`xM = easting - originEasting`，`yM = northing - originNorthing`。
原点为外环最小 easting 与最小 northing 的组合，可能在凹形房间外；不宣称其为墙角。
X 指向投影网格东，Y 指向投影网格北；不旋转到墙轴，Grid N 不等于真北。
SVG 显示层反转 Y，且所有方向共用单一比例，不改存储坐标。
宽高是外环的 X/Y 范围，不等同于墙长；面积按外环减内环计算。

UTM 单位为投影网格米。本轮未校核投影变形、地面距离/测量精度、房间所在 UTM 分区是否适宜，以及上游变换是否工程审核通过。
来源与 `transformReviewState` 随响应显示；没有审核记录的输入仍可只读显示，但不是工程验证结果。
演示库来源是 `dev-seed-facility`，图中明确标为合成样例，不能当作实测机房。

## 版本、安全与错误行为

新增 `GET /api/v1/projects/:projectId/rack/plans/:planId/room-view`，需要同时拥有该项目的 `rack.read` 与 `facility.read`。
单条 SQL 的同一 MVCC 语句快照内读取方案、设施 ETag、生命周期和几何，避免分次请求混合两个来源版本。
仍经 `withTenant` 且每个引用显式约束项目；使用现有身份/guard，不改变预设权限。

只有设施状态仍为 DRAFT、当前 ETag 与方案保存引用相同才返回边界；否则 `BLOCKED / FACILITY_SOURCE_CHANGED`，view 和 sourceGeometry 为 null。
以上是旧 room-view 接口的行为。当前布局接口读取固定快照；来源变化时仍返回旧图和已存机柜，但阻止新写入。旧方案需显式捕获，显式重绑定仍未实现。
来源后续变化不会实时推送到已打开的图；Refresh plans、重新打开或重新加载才复核。将来写命令仍须在提交时重新核对版本。
后端不传输超 4096 点几何的坐标；前端只画经过该 contract 生成的局部坐标。图面加载失败可重试，卸载会取消并忽略旧响应。

`AVAILABLE` 仅说明只读图可显示。`obstacleCoverage=UNKNOWN`，Rack 状态仍为 `NOT_RUN`。
此 Polygon 视图与现有矩形 `createRoomSnapshot` 是两种不同契约；没有把它交给矩形规则引擎，没有将包围框当作允许放柜范围。

## 响应结构

标准封装 `data` 含 `contractVersion`、`planId`、`planVersion`、原 `facilityInput`、`facilityInputStatus`、`room`、`status`、`reason`、`sourceGeometry`、`view`。

| 字段 | 内容 |
| --- | --- |
| status | AVAILABLE / BLOCKED / UNAVAILABLE / UNSUPPORTED |
| reason | AVAILABLE 时 null；其余为稳定原因码 |
| sourceGeometry | geometryId、role、crs、srid、provenanceReference、transformReviewState；无可读候选或来源过期时 null |
| view.unit / frame / transform | m / ROOM_LOCAL / TRANSLATE_ONLY |
| view.sourceCrs / originProjectedM | 上游 CRS 和 [easting, northing] 原点（米） |
| view.axes | GRID_EAST / GRID_NORTH |
| view.boundaryLocalM | 保留所有环的局部 Polygon；这是米制几何，不能作为 WGS84 GeoJSON 使用 |
| view.extentM / areaM2 / interiorRingCount | X/Y 范围、净多边形面积、内环数量 |
| view.obstacleCoverage | UNKNOWN |

原因码：`FACILITY_SOURCE_CHANGED`、`BOUNDARY_MISSING`、`BOUNDARY_AMBIGUOUS`、`CRS_UNSUPPORTED`、`DIMENSION_UNSUPPORTED`、`INVALID_BOUNDARY`、`GEOMETRY_TYPE_UNSUPPORTED`、`GEOMETRY_TOO_COMPLEX`、`EXTENT_UNSUPPORTED`。
上述可预期的数据状态返回 200；认证/权限/不存在沿用 401/403/404 和标准 correlation ID，底层故障沿用 5xx。

## 验证与下一步

见 [本轮证据](records/2026-10-28-rack-floorplan/)。领域包 80 项、真实数据库/API 16 项、相关 Web 53 项通过，构建成功。
只读运行检查逐点核对投影坐标减原点，并与 PostGIS 面积对照；未改方案行或种子数据。

后续一轮已完成固定快照、PostGIS Polygon 检查和机柜放置保存，见 [本轮证据](records/2026-10-28-rack-editor/)。障碍、净距和容量仍待实现。
不能直接用旧矩形规则引擎验证当前有旋转/凹形/孔洞的实际 Polygon。
