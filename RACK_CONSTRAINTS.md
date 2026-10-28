# Rack 规划禁放区与前后维护净距

日期：2026-10-28。当前增量在已保存布局上补齐显式规划障碍、前后维护带、后端冲突检查及图面显示。它们是 Rack 方案内的假设，不修改 Facility，不把合成样例升级为实测数据。

## 操作

已有副本执行 `npm run migrate`（当前 9 个迁移），再启动 `npm run dev`；不重跑 seed 或 reset。
打开 http://localhost:5193/ → Northern DC Campus → Rack，选择方案 → Edit layout。

- Planning constraints：记录来源/假设说明；Obstacle coverage 默认为 UNKNOWN，只有明确声明清单完整时才选择 DECLARED_COMPLETE。
- 勾选 Check front/rear maintenance distances 后输入前、后净距。未设置为 null，表示不检查；显式 0 表示零要求。正值至少 0.001 m、最多 10 m，使用方案统一要求，不按型号猜数。
- Add obstacle：新增一个轴对齐矩形规划禁放区；输入中心 X/Y、宽/深、名称。选择下拉框或图中区域，Focus obstacle 定位，Remove obstacle 移除草稿项。
- 图中虚线区域标识机柜前/后维护带，粗线仍表示机柜正面；区域随 0/90/180/270° 旋转。实心块为规划禁放区。
- Spatial checks 会显示冲突代码、机柜/障碍名称和 FRONT/REAR；点击诊断定位。冲突时禁存；修复后 Save layout 把机柜和规划条件一起存库。
- 未知障碍或未设置净距时，无已知冲突返回 INCOMPLETE，仍允许保存草稿。它不是完整验证通过。

演示方案名为 `Rack constraints demo — Hall A1`，本机保留；其他组员迁移后自行创建。前两轮的演示方案保留原版本。

## 存储与 HTTP contract

009 迁移仅向已有受项目 RLS 保护的 `rack_plans` 增加 `spatial_constraints` JSONB 列。旧方案初始化为 UNKNOWN、空障碍、null 净距；不移动柜、不推进原版本、不改固定 Polygon 快照。已应用的 001–008 迁移未修改。
`GET /layout` 新增 `data.constraints`；`POST /layout/check` 和 `PUT /layout` 在原 v1 body 中增加可选 `constraints`：

```json
{
  "obstacleCoverage": "UNKNOWN",
  "source": { "kind": "ASSUMED", "reference": "Group planning assumption; not surveyed." },
  "obstacles": [{
    "obstacleId": "<UUID>", "name": "Assumed column / no-go area",
    "xM": 6, "yM": 2, "widthM": 1, "depthM": 1
  }],
  "clearance": { "frontM": 1, "rearM": 0.5 }
}
```

仅接受以上字段，拒绝 null 文档、缺字段、额外字段、非法/重复 ID、数字字符串和非有限值。source.kind 只接受 ASSUMED，reference 为 1–512 字符；名称 1–160 字符。最多 64 个障碍、256 柜；障碍中心 ±10000 m，宽深 0.001–10000 m；单位、原点、轴继承固定房间输入。矩形障碍无独立旋转，不支持任意 Polygon 绘制。

请求不含 constraints 时使用当前已存条件，供旧客户端兼容；明确提交 null 拒绝，不能隐式清空其他人的条件。清空需提交完整文档（空 obstacles、null clearance 等）。编辑器总是发送完整条件，检查结果绑定精确 body，草稿随 tab 保留。
写请求仍用 UUID Idempotency-Key + If-Match，锁定方案与来源、检查版本/权限/源新鲜度，重新计算全部规则后同事务写条件和机柜、推进版本、记录成功命令。失败 422 不留下部分条件或机柜；412 防止旧版本覆盖。未知输入允许草稿保存，已知几何冲突不允许。读/check 要 rack.read + facility.read，写要 rack.write + facility.read；没有新授权旁路。

## 空间语义

维护带按柜宽生成，不扩展左右侧边；0° 正面为局部 -Y，绕中心逆时针旋转后仍跟随物理正面。全方案采用同一组 frontM/rearM。正距生成紧邻机柜边的带状矩形，零不生成退化多边形。

| 检查 | 语义 |
| --- | --- |
| OBSTACLE_OUTSIDE_ROOM | 障碍整个矩形不被固定 Polygon 覆盖，或接触/覆盖内环；即使空机柜清单也检查 |
| RACK_OBSTACLE_CONFLICT | 柜实体接触或覆盖声明障碍；障碍被完全包住也拒绝 |
| CLEARANCE_OUTSIDE_ROOM | 任一维护带越出完整 Polygon 或接触内环 |
| CLEARANCE_RACK_CONFLICT | 其他柜实体内部进入维护带；不比较维护带相互之间的重叠 |
| CLEARANCE_OBSTACLE_CONFLICT | 任一维护带接触或覆盖声明障碍 |

两柜可以共享维护带；这只表达本轮几何模型，不证明可同时检修。机柜接触维护带外边缘可接受；障碍接触维护带保守拒绝。维护带/障碍可接触外墙，但不能碰内环。使用 PostGIS SRID 0 平面拓扑，完整 Polygon 检查，不只检查角点；没有额外 epsilon 或施工容差。

报告保留旧字段并增加 obstacleIds、可选 side（FRONT/REAR）、obstaclesChecked、clearanceBandsChecked、clearance、planningSource；scope 显示实际检查范围。状态顺序：

1. 任一已知冲突 → ISSUES_FOUND。
2. 无冲突且空机柜 → NOT_CHECKED（障碍越界仍可以产生冲突）。
3. 非空无冲突，但覆盖 UNKNOWN 或 clearance=null → INCOMPLETE。
4. 非空无冲突且 DECLARED_COMPLETE、明确净距 → CHECKED_SCOPE_CLEAR，仅针对声明输入和所列规则。

uncheckedRules 保留未声明障碍、未设置净距及侧向净距、通路连通/通道、设备、容量和工程精度。`DECLARED_COMPLETE` 只是用户的规划范围声明，不是设施审核或测绘认证。全方案 `validationState=NOT_RUN`，不冻结/发布。

## 限制、复杂度与验证

没有自动导入 Facility 柱、门、梁、消防或设备区域；不能默认真实房间无障碍。没有侧向净距、门扇/通道/疏散/连通性、共享维护区并发作业分析、设备/重量/电力/冷却或行业标准校核。源变化仍禁写、保留原图；没有重绑定。
按 n 柜、m 障碍，规则包含 O(n²+n·m+m) 组空间比较，最多 2n 个维护带；复杂 Polygon 谓词成本另依赖边界复杂度。256/64 是请求上限，不是性能承诺；本轮未做正式基准或吞吐实验。
证据见 [本轮目录](records/2026-10-28-rack-constraints/) 和 [PROGRESS.md](PROGRESS.md)。下一步做设备分配、U 位/重量/电力/冷却输入及容量汇总，再进入算法、候选与 Rack Assistant。
