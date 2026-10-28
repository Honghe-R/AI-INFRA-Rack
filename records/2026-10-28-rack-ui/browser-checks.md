# 实际浏览器验证，2026-10-28

入口：`http://localhost:5193/`，本机隔离开发栈。使用原有 in-app browser，未调整窗口尺寸。

1. Dana Whitfield / dev-user 进入 Northern DC Campus → Navigation → Rack。
2. 首次列表为空，打开 New empty plan，填写 `Rack UI demo — Hall A1`，选择 `Data Hall A1`。
3. 切换 Site & Facility 标签再回 Rack：名称与 HALL 均保留，Rack 标签标为 Unsaved changes。
4. 关闭 Rack：显示 `Discard unsaved changes?` 与专门原因，选择 Keep editing，内容保留。
5. Save empty plan：出现保存成功提示、列表记录及详情；状态 v1 / DRAFT / NOT_RUN，placements 为 0，来源 UNCHANGED。
6. 整页 reload 回到平台项目列表；重新打开该项目和 Rack，列表仍有该方案。选择后 ID 与保存前相同：`3abd796d-461a-45f6-a0ce-ced7bce99020`。
7. 切换 Mei Lin / dev-viewer，重新进入该项目和 Rack：可读列表与详情，显示 Read-only access，未出现 New empty plan。
8. 恢复原 Dana Whitfield / dev-user 身份，重新进入 Rack 并选择该方案。
9. 只读脚本 `check-saved-demo.mjs` 确认数据库只有这一个 ID，SQL、列表、单条 GET 与 viewer GET 一致。

演示方案有意保留在本机数据库供用户查看；不属于种子数据，不随 Git 传播。

截图：`platform.png` 为管理员列表，`detail.png` 为保存详情，`viewer.png` 为只读页面。
窄窗口采用列表/详情上下排列，详情需要向下滚动；未通过截图声称宽屏布局或所有浏览器通过。

浏览器没有做断网/提交后丢响应故障注入，未穷举慢请求或所有上下文切换；来源过期、分页、拒绝路径由 API/状态测试覆盖。
