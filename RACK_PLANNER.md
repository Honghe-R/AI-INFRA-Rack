# Rack 布局算法、候选预览和应用

2026-10-29，第十六轮。入口：Rack → Layout options → 选方案 → Generate layout options。

当前闭环：读取保存版 → 有限网格搜索 → 完整后端检查 → 比较/预览 → 明确勾选 → Use selected option as draft → Save layout。生成和选用为草稿均不写数据库；保存才推进 Rack 版本。

## 算法范围与输入

算法重新安排**现有未锁定机柜**的位置和可选四方向旋转；不新增/删除柜、不移动锁定柜，不更换型号，不改变设备身份、设备所属机柜/U 位或容量假设。先在 Rack layout 建柜、Space rules 配置约束、Devices & U slots 配置设备、Capacity 配置假设限值，保存后再生成。存在未保存/不确定保存请求时不能生成或覆盖草稿。

必要输入已复用现有真实契约：固定 HALL Polygon 及内环、服务器机柜型号与占地、机柜身份/锁定状态、显式障碍/前后维护净距、设备清单、每柜容量假设、方案版本及 Facility 来源。新参数只有网格步长、是否旋转和策略。障碍或资源未知仍明确显示未知，不补虚构预算。

## 两种确定性策略

| 策略/版本 | 排序 | 搜索 |
| --- | --- | --- |
| INPUT_ORDER / row-scan-v1 | 保存版稳定机柜顺序（当前 API 按 rack UUID 排序） | 从房间局部坐标下方逐行向上、每行向右扫描 |
| LARGEST_FIRST / largest-first-v1 | 占地面积降序，同面积按 UUID 字典序 | 同一套网格与检查器 |

先固定锁定柜；逐台尝试位置与方向，保留第一个接受的位置。前后维护带随方向旋转，允许维护带共享；双向检查新柜实体与已放柜维护带，以及新维护带与已放柜实体。房间包围框**只提议位置**，实际 Polygon、凹口、孔洞与障碍由 PostGIS 判断。

生成器在 `packages/rack/src/planner.js`，无网络/数据库依赖；通过注入的 pickPosition 回调查询批次。`apps/api/src/services/rack-planner-geometry.js` 用与原空间检查一致的接触策略筛选；**每个最终完整候选再次调用 rack-layout 原空间检查和原设备检查**，最终报告与手工 check 一致。32 组四方向/孔洞/凹口/禁放区/双向维护侵入差分测试覆盖适配器与原检查器的一致性。

这是一版贪心可行位置搜索，排序不保证优于基线；不会宣称全局最优。没有回溯、多目标优化、连续冷热通道、真实楼板/配电/热仿真，也没有设备自动装箱。机柜未找到位置不等于证明机房无解。

## 边界、未放置与指标

- 网格步长 0.1–5 m，默认 0.5 m；允许旋转时按当前方向优先，再尝试其余四分之一转。
- 一次最多两候选、64 个未锁定机柜；每柜最多 2,048 个提议姿态、每候选最多 16,384 个，128 个为一批。已锁定机柜仍计入原 256 柜方案上限。
- 查询单次最多 5 秒，服务在批次间和完整检查前后检查 15 秒时间预算。运行中的 SQL 需等到完成/超时；因此不是精确 15 秒的响应 SLA。页面 Stop waiting 取消等待，不承诺立即中断服务器计算。
- `NO_GRID_POSITION`：已扫描当前有限网格，受此前贪心选择影响；`SEARCH_LIMIT`：提议次数耗尽。未放置柜在部分预览中保留原位与身份，整候选禁止选用为草稿。
- 所有候选保留每台柜身份；最终空间或设备报告存在错误时同样禁止选用。UNKNOWN/INCOMPLETE 保持原有有限范围语义，整体 NOT_RUN。
- 包围面积为所有机柜**柜体占地**的轴对齐整体包围框面积，不含维护带，不是可用机房面积/利用率；不能把减少的包围面积当作等量释放的工程空间。
- 另列搬动机柜数、中心移动距离之和（m）、提出姿态数和耗时。面积和移动距离是独立取舍，不合成虚假最优分。

固定参数/输入无随机数；返回算法版本、输入 SHA256 指纹、基准版本、固定快照和设施引用，可重跑结果。指纹用于解释/复现，不是用户可持有的授权凭证。

## HTTP contract

`POST /api/v1/projects/:projectId/rack/plans/:planId/layout/options` 是只读计算，需要 `rack.read` 与 `facility.read`，使用项目 tenant 上下文/RLS。

```json
{
  "contract_version": 1,
  "base_version": 2,
  "snapshot_id": "<stored snapshot UUID>",
  "options": { "grid_step_m": 0.5, "allow_rotation": true, "strategy": "COMPARE" }
}
```

不接受客户端自报机房、设备或预算；服务从保存版读取。省略 options 使用默认，显式 null 拒绝。strategy 可为 COMPARE、INPUT_ORDER、LARGEST_FIRST。

响应包含 `projectId/planId/baseVersion/snapshotId/facilityInput/inputFingerprint/options/limits`、现状指标与两类报告 `baseline`、`candidates`、`elapsedMs`、`scope: EXISTING_RACK_RELOCATION`、`persisted: false`、`validationState: NOT_RUN`。每候选含 algorithmId、optionId、placements、metrics、unplaced、positionsSubmitted、两类完整报告、canStage，以及原 save 接受的完整 body。

参数非法 400；旧基准版本 412/RACK_VERSION_CONFLICT；快照不匹配 409/RACK_SNAPSHOT_MISMATCH；来源不再是同一可写草稿 409/RACK_SOURCE_STALE；查询/计算预算超时 503/RACK_PLANNING_TIMEOUT；权限和项目不可见沿用原 403/404。无输入柜时明确拒绝，不能把空方案当成规划成功。

## 候选应用与生命周期

候选暂存于当前编辑器页面，无新候选表、迁移或后台任务；切分区保留，整页重载/方案重读/保存推进版本后会清除。重新生成替换旧结果，无服务端候选历史或过期清理任务。

选用前必须人工勾选复核，前端检查同一项目/方案/保存版本/快照/设施引用、权限、无共享草稿、无未放置柜和无报告错误，再复制完整 body 到原共享草稿。图面自动聚焦新位置；继续手改也允许，属于普通草稿编辑。

保存沿用 `PUT .../layout`：`rack.write`、facility.read、If-Match、UUID 幂等 key、保存版锁定柜约束、来源锁、整份空间/设备检查和原子事务。候选不创建额外绕过路径；没有单独承诺“原候选已审批”的签名 apply 端点。前端候选归属提示不是安全边界，后端仍对每个普通保存请求独立裁决。

## 验证与初步性能

见 [本轮证据](records/2026-10-29-rack-planner/) 和根 PROGRESS.md。只读重放脚本：

```powershell
node --env-file=.env records/2026-10-29-rack-planner/check-live-planner.mjs
```

脚本限制隔离本地数据库/栈和已知合成 Facility，仅 GET 和只读 options POST，比较前后五个旧示例完整数据。六柜/17 设备、0.5 m 网格，两次结果相同；包围面积约 23.92 → 15.84 m²，搬动距离约 344.122 m；两策略在这一同尺寸输入上相同，不能据此证明排序效果。两次端到端约 5.399 / 4.369 秒（并行回归时），服务约 5.376 / 4.352 秒，仅是本机样例测量，不是吞吐量或大规模扩展性承诺。

复杂度受提议姿态数、锁定/已放柜数、障碍数及 Polygon 顶点影响；每批次重新解析几何，终检还包含柜间两两比较。生产级并发限流、异步任务/取消、空间索引/缓存和大规模实验待补。本轮保持限制可见，不将课程原型当成生产调度服务。
