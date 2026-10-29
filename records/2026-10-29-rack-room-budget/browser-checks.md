# 本地浏览器验收：机房预算

2026-10-29，在 http://localhost:5193/ 的本地副本操作，没有访问老师平台。

1. Northern DC Campus → Rack Overview，选择 Rack room budget demo — shared power and cooling → Capacity。
2. 保存版 v2，三柜/四设备，两台安装/两台未分配；预算控件禁用。报告机房已安装功率/冷却各2、预算3、剩余1，完整库存5并提示全部安装会超限。方案设备报告 INCOMPLETE（有未分配），机房安装范围 CHECKED_SCOPE_CLEAR，二者作用范围不同。
3. Edit layout → Room power limit 改1，等当前共享后端检查返回。机房 ISSUES_FOUND，功率2/1、剩余-1、ROOM_BUDGET_EXCEEDED；Save layout禁用，原单柜未因此变成超限。
4. 清空功率限值，报告 INCOMPLETE；功率限值/剩余 Unknown、状态 UNKNOWN，需求仍2，不猜成0或无限。
5. Discard changes，页面提示 Saved layout restored，无 Unsaved changes，回到Saved v2、预算3。没有点击Save。最终页面保留Capacity示例。
6. 修复窄视口表格末列逐字挤压：预算表设680px最小宽度，窄窗口横向滚动，保留完整列和词语。

截图：room-budget-conflict.jpg（临时超限）、room-budget.jpg（恢复后的保存版预算表）。界面最初方案select的label定位无匹配，换DOM实际combobox角色成功；一次Playwright放弃按钮交互超时但页面无变化，读取最新AX后点按钮完成。没有改变业务断言或保存测试草稿。

本轮浏览器未重复模型对话、布局重排/分配转草稿全流程；此前流程见第十六/十七轮。预算对候选和分配的约束、权限/原子保存由本轮真实HTTP集成测试及独立示例覆盖。
