# 老师平台只读观察（2026-10-29）

来源：用户授权查看 https://202.120.39.134:5500/ 的 Northern DC Campus。由用户手动处理浏览器证书提示后，通过浏览器亲自打开已有版本与对象查看。未新增/移动/修改/验证/发布/删除任何老师数据，未导出老师示例用于本地种子。

| 页面/版本 | 实际观察 | Rack 可借鉴 / 边界 |
| --- | --- | --- |
| Power /18ff33d2 | 107 devices、130 connections、24 circuits；点阵、Wiring/By level、方向和 snap 控件、点击对象 Inspector | 点阵和对象详情；电力图是层级示意，不能照搬为米制楼层布局 |
| Power ats-a Inspector | Identity、Declaration、Supply path、Protection、Capacity and load、Redundancy、Provenance；Delivered1.1MVA、Demand192kVA、Headroom916kVA、Utilisation17.3%，标DERIVED；Basis NOT PROVIDED | 负载/余量/利用率、派生与缺失来源；这些 kVA/MVA 不等于 Rack kW 可直接换算 |
| Network /a2074084 | 40设备、3层、144连接；By plane/By rack/Blast radius、方向、Tier bands；leaf-0-0 可选 | 图形分组/过滤、稳定身份和详情联动；网络连接和机柜占地职责不同 |
| Network Inspector/overview | Identity、Ports and endpoints、Connectivity、Capacity and policy、Resilience、Provenance；目录未pin、17 open findings；部分能力 Provisional/Not provided | 说明未固定输入、缺失证据、局部覆盖；Current 也不是所有能力都完备 |
| Network /8a2d4bdd | 空示例，“scope has nothing to draw”、no_result 明确区别无结果与无缺陷 | 空状态要引导下一步，不能假装检查通过 |
| Rack、Floorplan | Overview只有工具占位与版本/lifecycle上下文，无实际编辑器 | 当前老师线上无可直接照搬的完整Rack；我们需自行完成核心流程 |

不同工具图数据属于不同 revision。Power版本切Network会提示无本工具设计，并可只读打开已有Network版本；未创建新revision。Power pins显示Facility已固定，Rack/Catalog等未固定。说明跨工具输入引用和新鲜度比单纯“画大图”更重要。

这是对这些页面的观察，不是对老师所有模块或算法的审计。没有把 Power 的现存“5 devices moved”状态当作本次修改，也没有点击 Put them back。参考结论优先落实到交互、来源/未知提示和文档边界。
