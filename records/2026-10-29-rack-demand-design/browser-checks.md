# 浏览器验收

通过in-app browser操作本地localhost:5193，不对老师平台执行写操作。

1. Northern DC Campus → Rack → New empty plan → Data Hall A1，创建“自动设计示例 · 22台设备”。v1无柜/库存。
2. 空方案主布局显示数量表单；示例8 GPU、12计算服务器、2 ToR。单柜800kg/12/12kW，正面1m/背面0.6m/间距0.2m。
3. 首次无房间预算，663ms产生两候选，均3柜/22台全装/0未满足/4.32m²。空间INCOMPLETE（障碍完整性未知），设备CHECKED_SCOPE_CLEAR。Rack03显示26/42U、10.2/12kW及14台设备。
4. 开发期导航元信息热更新触发页面重载，候选消失；重开同一v1方案，未重复创建。填同参数并声明房间预算40/40kW。
5. 第二次676ms，同样两候选，预算CHECKED_SCOPE_CLEAR。ToR详情U25、1U/10kg/0.3/0.3kW、demo-tor-1u@1。只读预览不跳到保存版编辑页。
6. 复核→采用为草稿，dirty与3柜/22台正确，完整检查后Save layout启用。保存重读v2，dirty清除；独立API读取保存于saved-design.json。
7. 保存版图、清单、Inspector仍能查看立面；布局/设备/预算一起持久化。001和原32柜演示仍v2。

浏览器验收是排序修正前的候选。代码最后修正为比较机柜占地区包围面积，领域测试2.64m²并重跑HTTP回归。自动审批拒绝重启/备用预览，最终排序未再浏览器复验，未改已保存4.32m²示例。不可把代码测试数字写成浏览器已保存结果。

老师平台观察见doc/tools/rack/reference-observations.md，未导出/复制老师示例作为本地种子。
