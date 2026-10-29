# Interchange contract

## 输入

- Facility 引用固定 `projectId/scenarioId/revisionId/containerId/revisionEtag`，container 必须是本项目 HALL。
- 支持的投影 Polygon 转为房间局部米制，保留孔洞与 sourceGeometry、坐标转换信息；不支持时明确 unavailable，不按面积虚构边界。
- Catalog 设备必须固定 `{modelId,version}`；后端解析尺寸/资源需求，拒绝 unknown version 和修改规格。机柜型号来自服务端 rack_models。
- 障碍、净距、机柜限值和可选房间预算目前是有来源说明的 ASSUMED 输入，不能升级成 Facility 权威数据。

## 输出与交接

Plan 布局返回固定快照、独立整数版本、柜位置、设备/U 位、约束、源状态及两种局部报告。候选附 baseVersion、snapshotId、facilityInput、inputFingerprint、算法版本/预算和未安排原因；`persisted:false`、`validationState:NOT_RUN`。

候选 body 与普通布局保存相同，前端不能把 candidate.canStage 当服务器写入许可；保存再次授权、核对 Facility/快照/版本、锁定对象并完整检查。陈旧候选必须重新生成。

目前没有 Network/Power/Simulation 的正式导出契约或上游事件订阅。设备是方案内实例，不自动成为全局资产或跨工具端点。正式 handoff 未来需要版本、稳定对象引用、单位/未知/来源和范围声明，不允许靠名称猜测映射。
