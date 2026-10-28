# 浏览器验证：设备上架与容量

日期：2026-10-28；使用已有 http://localhost:5193/，合成样例和隔离开发栈。

1. 新建 `Rack equipment demo — Hall A1`，绑定 Data Hall A1，保持之前三个演示不变。
2. Edit layout，新增假设型号机柜 C01，记录 equipment planning reference。
3. Add device 创建 `Assumed GPU server`：4U、80 kg、3 kW 电力/3 kW 冷却，指定 C01/U35，柜内图占 U35–38；设备 ID 保持稳定。
4. 启用本方案假设限值：500 kg、2 kW 电力、6 kW 冷却。后端报告 Power EXCEEDED，RACK_CAPACITY_EXCEEDED，Save layout 禁用。截图 capacity-conflict.png；随后将电力假设上限改为 6 kW（演示假设，未调整真实工程规格）。
5. 添加 `Assumed ToR switch`：1U、10 kg、0.3 kW 电力/冷却，指定 C01/U37。出现 DEVICE_U_OVERLAP、柜内红色重叠、保存禁用。点击诊断选中 GPU，定位 C01；截图 u-conflict.png。
6. 将交换机改为 Unassigned，设备 ID、名称、规格保留，起始 U 输入消失；再次选 C01，上架默认 U1。此步骤验证卸架不删除规格；移动到其他柜及用量重算由 API 测试覆盖。
7. 输入 U43，明确 DEVICE_U_OUT_OF_BOUNDS；清空 Starting U，显示输入错误并禁存，图面未出现 NaN。修正 U41。
8. 后端设备报告 CHECKED_SCOPE_CLEAR：2/2 installed、5/42 U、37 free、90 kg/500 kg、电力和冷却各 3.3/6 kW。空间报告仍 INCOMPLETE（本演示没有声明障碍完整或配置净距），整体 NOT_RUN。
9. Save layout 成功得到 v2。整页 reload → 项目 → Navigation/Rack → 重选演示，读回 v2、一柜、两设备、来源、限值和 U 位。选择 Capacity rack=C01，确认容量表和柜内图一致；截图 equipment.png。

本机方案 ID `cb017b9b-ca11-483b-a5fd-c8f527195072`，最终为已保存只读视图，无未保存草稿。平台仍在用户原有浏览器标签。

开发时格式化触发 watcher/HMR，一次布局请求短暂 502，Retry layout 后恢复，草稿与设备保留；不是数据重置。最终截图文件已成功写盘，但随后浏览器工具保存标签标记超时，已从文件系统核对截图存在。本轮没有做浏览器断网/响应丢失故障注入；完整权限、幂等与事务回滚由 API 测试覆盖。
