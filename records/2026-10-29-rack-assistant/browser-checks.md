# 第十七轮真实浏览器验收

仅访问副本 http://localhost:5193/，未访问或修改老师平台。

1. Rack Overview展示Assistant范围说明。选六柜旧示例，Ask about Rack打开，上传禁用。
2. 发送“查询各机柜剩余 U 位和功率容量”，收到真实的未配置LLM_ENDPOINT/LLM_MODEL提示。用户决定暂不配模型，没有外部模型回复。
3. API watch开发重启一度使旧详情GET出现502，刷新列表恢复，无方案改写。
4. 受隔离栈/合成来源保护的普通HTTP脚本创建独立 **Rack allocation demo — unassigned devices**，v2，3柜/6设备，前后五个旧示例完整布局相等。
5. Devices & U slots → Generate device allocation，3个新增分配、2个保留未分配、1个锁定柜排除。8U/4U/2U分别位于C柜U1–8、9–12、13–14。
6. C柜空闲U42→28，重量70/100kg，功率6/6kW、冷却6/6kW。100U设备报告连续U不足，重量未知设备报告UNKNOWN_DEVICE_RESOURCE。原设备保持A柜原位。
7. U立面只读，未勾复核时Use allocation as draft禁用。勾选后进入共享草稿，4/6 installed、2 unassigned，有dirty标记，方案切换禁用。
8. 完整检查后Save layout可用，但没有点击保存。Discard恢复saved v2、1/6 installed、5 unassigned、无dirty。
9. 保留临时候选比较画面与未勾选复核状态，[截图](allocation-preview.jpg)。真实持久化在隔离数据库fixture验证，不把浏览器可保存写成已保存。

原生下拉框初次Playwright label未命中，改用可访问控件和键盘。没有放宽测试或跳过。
