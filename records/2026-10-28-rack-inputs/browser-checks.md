# 本地浏览器检查

对象：http://localhost:5193/，仅本地 Rack 副本；通过 cua_repl 浏览器 API 操作。

1. 打开 Northern DC Campus → Rack，实际侧栏显示 Overview、Plans、Inputs & impact、Rack layout、Space rules、Devices & U slots、Capacity、Layout options、Checks。
2. Inputs & impact 选择 Rack catalog demo — six racks，显示保存 v2、6 柜、17 台目录设备、0 自定义设备、5 种精确型号版本以及实际 room snapshot/Facility 引用；整体 NOT_RUN。
3. 选择 Devices & model pins，下游显示 U & resource checks、Versioned plan save；不包含空间检查。检查了实际截图：浅色主题下图与侧栏正常显示，长页面通过纵向滚动查看；没有做移动端或深色主题验收。
4. Edit layout → Rack layout → A01 → 临时改名 A01 input-impact probe → Inputs & impact。草稿跨页保留，Active Rack plan 禁用，识别 Rack layout 未保存改动，提示两类检查的保守影响。
5. Discard changes：显示 Saved v2、No draft is open，方案下拉恢复可用，无 dirty 标记。没有点击 Save layout，数据库演示保持原样。

首次可见临时标签发生定位/标签归属失效，换独立测试标签后完成以上流程。未测试外部源实际变更、权限切换、断网或保存响应丢失；这轮不改后端和数据库。
