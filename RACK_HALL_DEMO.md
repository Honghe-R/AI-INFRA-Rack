# Rack Hall Demonstrations

## Larger demonstration — updated 2026-10-31, round33

Open `http://localhost:5193/` → **Northern DC Campus** → **Rack**, refresh plans if needed, and select **Large Hall Demo · 128 Racks / 8 Equipment Rows**. Choose **Expand workbench** for the large floor view.

| Item | Large hall | Preserved original hall |
| --- | --- | --- |
| Racks | 128, rows A–H, 16 per row | 32, rows A–D, eight per row |
| Installed / unassigned devices | 944 / 8 | 236 / 8 |
| Total inventory | 952 | 244 |
| Locked / movable racks | 96 / 32 | 24 / 8 |
| Installed power / cooling | 960 kW each | 240 kW each |
| Assumed room budgets | 966 kW each | 246 kW each |
| Power utilization | 54%–98.75%,80 high-load/48 normal | 54%–98.75%,20 high-load/12 normal |

The larger example is a separate plan. Local ID: `879a2cbc-87d4-4c7a-93c3-ca435e3f34f3`, upgraded from saved version2 to3. Round33 expanded its inventory in place after checking that its equipment was still the exact generated round32 fixture and saving a backup; rack geometry and constraints were preserved. Other plans were unchanged. The original plan's current name is **Full Hall Demo · 32 Racks / Mixed Equipment Rows**; the runner also recognizes its legacy name below.

### Equipment and layout

All cabinets are assumed42U, alternating800mm/600mm widths,1,200mm depth. Equipment density now matches the32-rack example: both cabinets and installed inventory scale by four. These remain teaching assumptions, not production load certification. Profiles repeat after four rows:

| Rows | Per-rack contents | Installed devices |
| --- | --- | --- |
| A, E | Three GPU servers and one ToR switch | 128 |
| B, F | Ten compute servers and one ToR switch | 352 |
| C, G | One GPU server, four compute servers and one ToR switch | 192 |
| D, H | Repeated network/compute/inference profiles from the original demo | 272 |

Installed totals:144 GPU servers,576 compute servers,224 switches. Row names describe this example, not persistent zones or network links. Per-rack power limits vary4–12kW with1,000kg weight limits. Front/rear bands remain1m/0.6m with alternating faces. Four no-placement rectangles reserve central/north/south aisles and staging. The API checks the real HALL Polygon, including holes.

### View and demonstrate

1. **Floor layout** shows128 cabinets. Color by **Power** uses actual checked power/limit ratios:80 cabinets at or above80%,48 below80%, none over limit. The threshold and palette are unchanged. Dense views hide labels that cannot fit; selection always reveals the label. Hover titles/search retain every identity. Select B01: ten compute servers plus a switch,21/42U occupied,8.3/10kW. G01: GPU plus four compute servers and a switch,13/42U,6.5/8kW.
2. **Rack elevations** and **Capacity table** use the same plan and selection.
3. **Equipment allocation** admits two pending GPUs. Four compute servers exceed the remaining budget, the100U device has no eligible position and one device has unknown resources. Preview does not save.
4. **Layout options**,2m grid, rotations disabled, COMPARE: two stageable candidates,32 movable racks relocated,96 locked placements and all equipment retained. Compare before applying: bounded greedy relocation does not guarantee a better or globally optimal layout.

This occupies part of the approximately9,230m² room. Obstacle coverage remains UNKNOWN, eight devices remain unassigned and whole-plan validation remains NOT_RUN. Empty diagnostics do not certify connected egress, airflow, electrical distribution or network cabling.

### Reproduce locally

Pulling code does not transfer the local database. Prepare an isolated Rack stack, synthetic Facility/Catalog and source plan, then run:

```powershell
npm run rack:demo:hall -- <local-project-uuid> <source-plan-uuid> --large
```

Omit `--large` to create/retain the32-rack example. The runner checks the isolated environment/synthetic source, uses ordinary authorized APIs and compares other active scoped plans before/after. Existing matching demos are retained exactly, including edits. A40×40m minimum extent is required; actual Polygon feasibility is checked separately. No reset/seed, migration or teacher access.

For an existing sparse round32 demo, explicitly upgrade only its generated equipment:

```powershell
npm run rack:demo:hall -- <local-project-uuid> <original-source-plan-uuid> --upgrade-large-equipment
```

Use the same source plan as creation. The upgrade refuses changed equipment or rack identities/models, preserves current positions/constraints and writes a pre-upgrade JSON backup before a versioned API save. An already upgraded inventory is a no-op. Ordinary `--large` still retains existing plans without upgrading them.

Saved inventory capacity is now2,048 devices, while saved racks remain256. Domain limits live in `packages/rack/src/limits.js`; update browser mirrors with `node scripts/rack-sync-limits.mjs` and check with `--check`. Browser runtime imports no backend package. The existing1MiB HTTP body cap still applies; the fixture and the integration-test2,048-device body fit it. Relocation still allows64 movable racks, allocation64 unlocked targets/128 pending devices, demand design32 generated racks. These separate search budgets were not needed to run this128-rack/944-installed-device example and remain bounded.

[Round33 evidence](records/2026-10-30-rack-density-upgrade/commands.md): full Rack domain tests, fixture/parity tests, DB/HTTP boundary checks, upgrade/readback/preview preservation, browser color/capacity/elevation checks and a successful Web build. A single local relocation comparison took14.6s; this is not a scaling benchmark or SLA. The full Web suite has one inherited import-boundary failure, recorded separately. [Round32 evidence](records/2026-10-30-rack-large-hall/commands.md) describes the superseded sparse fixture.

## Historical round19 record

第二十轮更新：Rack layout 已改为点阵工作台与右侧 Inspector。现在点“设备区”或“整个房间”自动适配，点“展开工作台”同时展开画布和详情；原 Fit racks / Expand map 控件仍用于 Space rules 和算法候选图。最新操作见 [RACK_VISUAL_WORKBENCH.md](RACK_VISUAL_WORKBENCH.md)。

本地平台 http://localhost:5193/ → Northern DC Campus → Rack，选择 **完整机房演示 · 32柜 / 多排混合设备** → **Rack layout**。

## 内容与查看方法

| 项目 | 数量与含义 |
| --- | --- |
| 机柜 | 32 个，A–D 四排，每排 8 个，42U |
| 已安装设备 | 236 台，GPU 服务器、计算服务器和 ToR 交换机 |
| 待上架设备 | 8 台，包含预算不足、尺寸过大、资源未知的例子 |
| 锁定 | A/B/C 共 24 柜位置锁定，D 排 8 柜可重排 |
| 功率 / 冷却 | 已安装各 240kW，假设预算各 246kW |
| 总库存 | 244 台：38 GPU、148 计算、56 ToR、2 其他，含待上架 |

A 排每柜 3 GPU + 1 ToR，共 32 台；B 排每柜 10 计算 + 1 ToR，共 88 台；C 排每柜 1 GPU + 4 计算 + 1 ToR，共 48 台；D 排是交换机、计算与混合柜，共 68 台。

1. **Fit racks** 聚焦柜群，**Expand map** 放大，**Rack labels** 切换编号，Color by 选择 power 查看负载颜色。
2. 地图下方“机房设备概览”显示实际库存，点 A01 等机柜按钮联动选柜并展示真实 U 位立面。分组仅来自名称前缀，不是空间分区实体或网络拓扑。
3. “管理设备与 U 位”和“查看容量与预算”进入现有功能页。
4. Devices & U slots 生成自动上架：新增 2 台 GPU，4 台计算因全房预算保留，100U 设备无合适位置，资源未知设备保留。生成预览不保存。
5. Layout options 使用 **2m** 网格、关闭 **Allow quarter-turn rotations**、比较两种策略。本例两候选相同，8 柜移动、0 未放置、24 锁定柜不变，均可复核转草稿。但柜群包围面积由 120.84 增至 1188.149m²，总移动约 396.503m；当前贪心扫描从房间边缘找位置，不保证比手工方案紧凑，应比较后决定是否采用。

## 数据与范围

这是 Hall A1 内的一块局部设备区，不代表整个约 9229 平方米机房铺满。规格、预算、限值、禁放区均为合成假设，不是老师平台资产或厂商认证数据。

四个矩形是主通道、南北通道预留和维护暂存禁放区，只检查柜体及维护带侵占。真实障碍覆盖未知，连续通道、出入口连通、疏散、冷热气流、网络布线未实现；整体状态仍为 NOT_RUN。

## 组员复现

代码更新不会把本机数据库演示自动传给组员。在自己的独立开发栈准备合成 Facility、Catalog 和源方案后运行：

```powershell
npm run rack:demo:hall -- <本机项目UUID> <本机源方案UUID>
```

脚本限制 Rack 本地隔离栈及合成来源，通过普通授权 API 创建/检查/保存，不 reset，不改源方案。相同名称的已有示例保持原样，避免覆盖手动修改。创建前后逐一比对旧方案。不要将老师平台或原目录作为运行目标。

本机 ID `4b8f7bf3-9015-455f-8bc8-ef3520f0d748`，v2；原七个方案和源方案保持不变。候选未应用/保存。

## 验证

新增场景测试 4 项、Web 定向 50 项（12 文件）通过，Web 构建成功。真实 HTTP 完成创建/保存/重读、自动上架和两策略试算；浏览器检查地图、选柜立面、分配和布局候选。见 [本轮命令](records/2026-10-29-rack-hall-demo/commands.md)。不是全仓测试或规模性能结论。
