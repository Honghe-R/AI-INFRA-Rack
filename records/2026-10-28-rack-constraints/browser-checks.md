# 浏览器检查：规划禁放区与前后维护空间

日期：2026-10-28。使用现有 http://localhost:5193/，未重新初始化栈。

1. 创建独立 `Rack constraints demo — Hall A1`，不修改前两轮演示。新增 B01（0°）与 B02（90°），均为 ASSUMED 600×1200 mm 型号。
2. 在 Planning constraints 记录合成来源，启用前 1 m / 后 0.5 m 净距。图面出现随方向旋转的蓝/琥珀色虚线带。
3. 新增 1×1 m `Assumed no-go block`，初始位于 B01，出现 RACK_OBSTACLE_CONFLICT，Save layout 禁用。
4. 将障碍 X 改到 56.5，出现 B02 实体与前维护带冲突；改为 57 后只剩 CLEARANCE_OBSTACLE_CONFLICT [FRONT]，诊断可定位机柜，见 conflict.png。
5. 改到 X=58、Y=45.82，声明本次规划假设下障碍清单完整，得到 CHECKED_SCOPE_CLEAR：2 柜、1 对、1 障碍、4 维护带。仍显示侧面/通路/容量等未检查及 NOT_RUN。
6. Save layout 成功，得到 v2；退出编辑状态，已保存值继续显示。
7. 整页 reload 回到项目列表，依次重新打开 Northern DC Campus → Navigation → Rack → Rack constraints demo。重新读到 v2、两柜、一障碍、前 1 / 后 0.5、来源和完整性声明；服务重新检查无诊断。
8. 点击 B02 清单定位图面，保存 layout.png。页面停留在该演示，只读已保存状态，无未保存草稿。

UI 自动化曾因列表按钮在 AX 显示为 checkbox 而精确 role 定位失败，按实际文字定位后通过；不是业务失败。没有做浏览器断网故障注入；凹形、孔洞、四方向、共享维护带等由数据库/API 自动测试覆盖。
