# 2026-10-29 浏览器验收

仅 http://localhost:5193/，原有 Rack catalog demo — six racks，保存 v2。没有修改老师平台，没有保存本机演示变更。

1. Rack → Layout options → 选择六柜方案，显示网格 0.5 m、旋转开关、两策略比较、64 可移动柜/每柜与整候选提议上限。
2. Generate：实际约 4.625 秒返回两候选；各 6 柜、无未放置项；现状包围面积 23.92 m²、候选 15.84 m²，总搬动距离 344.122 m。两策略同一布局，页面明确说明排序不保证改进。
3. 图上显示候选机柜及维护带，明确 Option preview · not saved；空间 CHECKED_SCOPE_CLEAR、设备 INCOMPLETE、整体 NOT_RUN。未勾选复核时 Use selected option as draft 禁用。
4. 勾选后选用，进入 Rack layout；出现 dirty 标签、共享草稿提示、方案下拉禁用，6 柜身份和设备保留，原保存 v2 不变。后台自动重查期间 Save layout 暂时禁用。
5. 测试中发现转换后的原画布仍停在旧视角，已修复为选用候选和放弃草稿时 Fit racks。二次选用另一策略后实际观察缩放从原 9.96× 调整到 14.78×，候选位置可见。
6. 未点击 Save layout；Discard changes 恢复原保存方案。候选切页仍可查看，确认动作会在新选用后重置。

真实持久化应用/重试/版本/源变化/锁定/权限路径由数据库 API 测试中的独立临时 fixture 验证，不以浏览器放弃草稿冒充保存验收。未做本轮浏览器断网、深色/移动端或故障注入。
