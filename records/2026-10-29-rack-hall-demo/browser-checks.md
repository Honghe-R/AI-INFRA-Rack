# 浏览器检查

在真实本地 localhost:5193 的 Northern DC Campus / Rack 选中新示例：

- 32 柜、236 已安装、8 待上架、24 锁定的实际统计正确。
- Fit racks、power 着色、Expand map 和标签开关正常；截图 hall-layout.jpg 展示四排机柜、维护带和四个预留区。
- 点 A01：9.3/12kW，3 GPU 占 U1–12，ToR 占 U13；42U 立面与设备页实际数据一致。
- 管理设备与 U 位→生成分配：2 GPU 分别放入 D08/D07 U18–21，其余 6 台保留；未转草稿或保存。
- Layout options 网格 2m，关闭旋转；生成两候选，页面显示 2405ms，8 移动、0 未放置；两种结果相同，已声明检查仍 INCOMPLETE。包围面积变大，不能称为更优。
- Playwright uncheck 未改变状态；重新获取当前 AX 后用当前控件原生点击，确认 Value=0，再生成成功。未更改业务代码来规避检查。
- 返回 Rack layout 保持已保存 v2；未应用或保存任何候选。
