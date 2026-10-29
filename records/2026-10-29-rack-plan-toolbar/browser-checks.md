# 浏览器验收

## 老师平台（只读）

- 打开 Power Overview，查看其107设备/130连接/24回路的 Wiring / By level 切换。
- 点击 By level 只改变展示；可见 Utility、Main low voltage、Sub-distribution、Row、Rack feed、Device feed 分层。
- 读取 Add entrance/device/circuit、Bind intake 与右侧详情方式；未点击新增、导入提交、验证或发布，未拖动老师对象。

## 本地平台

1. 无 Plan：七个 Rack 命令显示 Select a saved Plan first，避免无上下文操作。
2. 选择“自动设计示例 · 22台设备”v2，Overview 展示3柜/22台，未选择方案时的流程卡片收起；可进入同一工作台。
3. 平面 → 立面：3柜/22台真实 U 位；点击 ToR switch · 1U 1，Inspector 显示 Rack03、U25、1U、10kg、0.3kW、目录v1。
4. 切换容量表，设备选择仍保留；表格 U16/42、U16/42、U26/42，功率12/12、12/12、10.2/12kW。
5. Add rack：表单默认中心坐标四舍五入为0.01m精度（避免 HTML step 不匹配）；设置X55.15，提交后自动创建v2共享草稿，4柜/22台，选择新增 Rack4。
6. Add equipment：选择ToR v1、数量2，确认后设备页24台、2待上架；机柜草稿仍4柜。自动上架按钮解释须先保存草稿。
7. Add exclusion zone：X60、Y45.82、1×1m，确认后进入空间规则并选中新增区域。仍4柜/24台，共用草稿，后端空间检查4柜/6对/1区域/8维护带。
8. 点击Auto design，有草稿时明确阻止覆盖；Capacity limits 展示22安装/2待上架和库存功率34.8kW；Check results进入当前草稿报告。
9. Discard changes恢复3柜/22台、0待上架、0禁放区，仍保存v2，没有点击Save。
10. 从无草稿状态打开Add rack后取消，没有Unsaved changes、仍v2/3柜。
11. 修正一个实际发现的联动问题：选择旧ToR后新增机柜时，Inspector不能把旧设备错误归到新柜。最终浏览器复测同一工作台中ToR详情→新增Rack4，自动回到平面，详情显示Rack4、0设备；再次Discard恢复3柜。
12. 最后保留原v2示例、无dirty，以机柜立面/容量方式展示并截图。本轮未保存任何演示修改、未删除或新建本地方案。

## 开发期间工具现象

- 模块热更新曾重置工作区到项目列表，重新打开原方案；发生在开发修改后，没有保存/重复创建数据。
- 一次精确getByLabel匹配设备型号失败，改用已观察到的dialog内combobox选择成功，并补显式aria-label。
- 小视口Inspector按既有响应式规则下移；展开工作台可同时显示立面和右侧详情。窄屏顶部命令行可横向滚动。
