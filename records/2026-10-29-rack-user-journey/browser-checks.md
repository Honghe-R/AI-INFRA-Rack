# 真实浏览器验收

2026-10-29，在现有 http://localhost:5193/ 的 Rack 标签完成，无真实模型配置。

1. New empty plan 输入“用户流程验收 · 临时方案”，选择 Data Hall A1，保存后自动进入 Rack layout。
2. 新建v1自动具备固定Polygon，Edit layout添加两柜，切换Devices页仍保留同一草稿。
3. Catalog添加GPU server 4U分配首柜U1；添加ToR switch 1U。一次输入追加成U142，真实报DEVICE_U_OUT_OF_BOUNDS并禁用保存；改U42后冲突清除。
4. 创建禁放区，默认中心与Rack1重叠，真实报RACK_OBSTACLE_CONFLICT；将X移到40m后清除。前后净距各0.6m。
5. Capacity启用房间预算，功率/冷却各10kW；首柜限值500kg/8kW/8kW。Checks中仍明确INCOMPLETE及工程NOT_RUN。
6. Save layout持久化v2；普通HTTP重读，实际2柜/2台设备、GPU U1–4、ToR U42、1障碍、净距、柜限值和房间预算均正确。保存内容见journey-saved.json。
7. Plans重命名到“两柜服务器与交换机”v3；确认删除v4后从正常列表消失；勾选查看已删除方案能找到并恢复v5。HTTP对比固定快照、placements、constraints、equipment四类与v2逐项严格相等，见journey-restore.json。
8. 恢复后曾看到已删除410错误；确认HTTP读为200，修复浏览器缓存风险：Rack请求/响应no-store。修改API触发开发watch，短暂502后Retry恢复。
9. Edit layout选空Rack2，Inspector“删除选中机柜”使草稿只剩1柜；选有两台设备的Rack1，删除按钮disabled并提示先卸架/迁移。Discard changes恢复保存的2柜。没有保存这次机柜删除。
10. 临时方案正常API删除v6，再通过UI恢复v7，直接Open layout正确展示Saved v7、2柜/2已安装/0待上架，无需清缓存；截图restored-layout.png。
11. 完成后临时方案软删除v8，切换到保留的32柜完整演示。正常列表只有完整演示，已删除可恢复，标签无unsaved。截图clean-plans.png。

7个旧demo的清理通过正常DELETE，逐项内容hash不变；保留32柜完整演示与Facility未改，见cleanup-results.json。
初次浏览器表单操作使用了不匹配的locator、未滚到控件或把数字追加输入；重新观察/用聚焦后全选修正。此类自动化输入问题与真实产品断点分开，未把它们记成应用失败。
本轮没有浏览器断网注入；精确重试、权限、项目隔离、版本竞争的证据来自真实DB/HTTP测试和Web定向测试，不能称为浏览器全面故障注入通过。
