# 2026-10-28 浏览器验证记录

入口：http://localhost:5193/，使用既有 Dana Whitfield 开发身份；所有操作均针对 Rack 副本自己的演示方案，没有改 Facility。

- 新建 `Rack editor demo — Hall A1`，ID `24b5422e-8206-4a76-bdf5-9f7e93a05aac`；初始 v1 已有固定 HALL Polygon 快照，清单为空。
- Edit layout 后添加 A01、A02。两柜重叠时出现 `ISSUES_FOUND / RACK_PAIR_OVERLAP`，诊断包含 A02 ↔ A01 和文字，Save layout 禁用。
- 将 A02 移到 x=54.5/y=45.82，旋转 90°；检查变为 CHECKED_SCOPE_CLEAR，保存后 v2、两柜均能从服务器重读。
- 锁定 A01，保存到 v3；再次编辑并取消锁定时，X/Y、旋转和删除仍禁用，提示先保存解锁。Discard 恢复已保存的锁定。
- Focus A02 放大图面，实际指针拖动后 x=55.50169946275522；SVG 外层 pan/zoom 与机柜 drag 均能工作。单柜前边用粗线标识。
- 切到 Site & Facility 再回 Rack，未保存 x 坐标仍在，Rack tab 仍显示 Unsaved changes。
- Close Rack 出现 `Discard unsaved changes?` 和 `Rack changes have not been saved.`；Keep editing 回到草稿，随后保存到 v4。
- 再次编辑，添加临时第三柜后 Delete rack，恢复两柜；Discard 退出，无额外数据库版本变化。
- 整页 reload 回到 Projects；重新进 Northern DC Campus → Rack，选相同方案，读到 v4、A01 locked、A02 90°/x=55.502（三位显示，底层精度保留）。
- 最终保留 saved 状态，聚焦 A02，截图 [layout.png](layout.png)。原 v1 `Rack UI demo — Hall A1` 未捕获或改动。
- [只读运行检查](live-checks.txt) 另外对照 HTTP/SQL、admin/viewer、另一组织拒绝和旧方案未变。

边界：浏览器没有做断网后服务器已提交但响应丢失的故障注入，也没有开两个浏览器模拟并发。并发、幂等恢复、源更新锁、权限、事务回滚、凹形/孔洞检查由真实数据库/API 测试支撑。没有把浏览器图面当作测量或工程验证。
