# 浏览器验收

目标：`http://localhost:5193/`，现有 Northern DC Campus 项目、Rack tab、下方 Ask about Rack。没有创建、保存、删除或重命名 Rack 方案。

1. 本机未配置模型时，Ask about Rack 自动显示首次配置表单，Send 禁用并提示先配置。
2. 创建名为“验收连接（合成凭证）”的测试连接，地址为保留的无效域名 `https://rack-test.invalid/v1`、模型 `synthetic-model`，Key 仅为明确合成测试字符串。点击保存后设置收起、模型服务标签出现。
3. 再打开设置，地址已规范化为 `/v1/chat/completions`；Key 字段为空，提示留空保留；测试/删除按钮可见。
4. 刷新网页重新进入项目→Rack→Ask about Rack，直接显示已保存服务/模型，没有再次要求填写。
5. 仅修改连接名称，Key 留空保存成功。没有点击“测试已保存连接”，没有任何外部模型请求。
6. 点击删除后出现专门确认区，确认删除本轮合成连接；重新显示首次配置、空 Key、Send 禁用。没有覆盖已有真实连接：验收开始时本人连接确认为空。
7. 重新收起/打开助手，留下无测试通知的空白首次配置表单；最终截图 first-setup.png，不含凭证。真实模型自然语言与业务工具能力仍待用户填自己 API 后验收。

老师平台：用户询问连接方式时，曾只读打开 Ask about Power，页面显示 api.deepseek.com、deepseek-flash 和 deepseek-v4-pro。没有提问、切模型或修改配置/业务数据。用户随后要求仅处理我们平台，之后不再操作老师平台。这个观察不证明老师 Key 保存或计费方式。
