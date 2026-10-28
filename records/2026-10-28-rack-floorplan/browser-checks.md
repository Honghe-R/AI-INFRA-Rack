# Rack 只读平面图浏览器验证

2026-10-28，原有 in-app browser，`http://localhost:5193/`，保留当前窗口尺寸。

1. Dana Whitfield / dev-user 进入 Northern DC Campus → Navigation → Rack，选择已有 `Rack UI demo — Hall A1`。
2. 详情加载 Data Hall A1 的米制多边形。可见边界轻微倾斜，保留原投影形状，没有拉正为矩形。
3. X/Y 范围显示 106.30 / 91.64 m，多边形面积 9229.79 m²，内环 0。
4. Zoom in floorplan 从 1.00× 到 1.25×。
5. 图面按 ArrowRight：通过 DOM 读取边界 path 前后比较，路径发生变化。
6. 在当前截图图面内由 [350,420] 拖到 [400,450]：path 改变；滚轮向上后缩放由 1.25× 到 1.82×。
7. Fit room 恢复 1.00×；Refresh plans 后重新读取仍显示相同 HALL 和尺寸。
8. 整页 reload 回项目列表，再进入同项目 → Rack → 原方案，图面重新读取成功，仍为相同尺寸和面积。
9. 展开 Coordinates and source，显示 EPSG:32618、原点 [284382.071, 4324510.556] m、合成样例来源和 NOT_RECORDED 配准审核状态。
10. 收起来源面板，图面按 0 复位，保留此页面供用户查看。

截图 `floorplan.png` 为最终只读平面图，`source.png` 为展开来源的显示。
`check-live-room.mjs` 对照同一演示方案的数据库顶点/面积，另验证 viewer 200、其他组织 403；没有在浏览器切换 viewer。

凹形和内环由真实 PostGIS/API 以及 SVG evenodd 渲染测试覆盖；没有为截图改动种子边界，也没有浏览器端故障注入。
