# Rack 工作区：方案与机柜编辑

当前接通方案列表、创建、固定 HALL Polygon 快照、二维机柜编辑和数据库保存。启动见 [本地运行说明](RACK_LOCAL_SETUP.md)，API 见 [RACK_API.md](RACK_API.md)，完整操作与数据边界见 [RACK_LAYOUT.md](RACK_LAYOUT.md)。

1. 打开 http://localhost:5193/ → Northern DC Campus → Navigation → Rack。
2. New empty plan → 名称/HALL → Save empty plan；新方案自动捕获受支持边界。旧方案先 Capture room input。
3. Edit layout → Add rack → 在图中或清单选中柜；可拖动，或在属性中改中心坐标、旋转、锁定、删除。
4. Focus rack 放大单柜；Fit room 复位。Spatial checks 显示越界、孔洞、重叠；点击诊断定位。
5. 无上述冲突后 Save layout；Refresh plans 或整页重进后从数据库重读。放弃未保存更改用 Discard changes。

本机演示：`Rack editor demo — Hall A1`，ID `24b5422e-8206-4a76-bdf5-9f7e93a05aac`。旧 `Rack UI demo — Hall A1` 未修改。本机数据不随 Git 分发，组员自行创建。

列表严格继承项目/场景/Facility revision，默认每页 20 项。方案元数据需要 rack.read；快照图面还需 facility.read；写入需要 rack.write。viewer 无编辑入口，后端独立拒绝写入。

编辑状态和重试意图随工具标签保留，关闭/换上下文走 dirty 保护。创建/编辑有 beforeunload 提示；整页刷新后沿用平台行为回项目列表，未保存草稿不保证恢复，已保存数据可重读。有草稿时不能切换方案，先保存或放弃。

锁定柜先单独保存解锁才能移动/删除。保存携带版本和幂等 key；旧版本拒绝覆盖，提供 Reload saved version / Discard changes；结果不确定时禁改并用 Retry same save 恢复。具体 contract 见布局说明。

图面读取固定快照，来源变化后仍能查看旧图和机柜，但阻止新写入；不自动重绑定，也没有实时推送。合成 Facility 和假设机柜规格均明确标识；空间检查无冲突不是完整工程验证。

已增加 [规划矩形禁放区与前后维护净距](RACK_CONSTRAINTS.md) 和 [设备/U 位与容量假设](RACK_EQUIPMENT.md)：在 Planning constraints 与 Equipment & capacity 设置，同机柜一起保存。设备可上架/迁移/卸架、查看柜内 U 位图和三维用量；选柜后显示容量表。通道连通、正式预算、布局优化和 Rack Assistant 尚未实现。全局 Ask about Rack 仍是既有入口，不能当作 Rack 业务集成。

历史证据分别见 [方案工作区](records/2026-10-28-rack-ui/)、[坐标显示](records/2026-10-28-rack-floorplan/)，本轮见 [机柜编辑](records/2026-10-28-rack-editor/)。本轮未进行浏览器断网响应丢失故障注入。

第十三轮：Catalog 已有 Models / Technologies / Rule examples；Rack 支持 Add from catalog 与固定版本规格。主图支持 Expand map、Fit racks、图层和用量着色。详见 [RACK_CATALOG.md](RACK_CATALOG.md)。
