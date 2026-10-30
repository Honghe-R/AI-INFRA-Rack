# 第二十五轮：首次配置连接的验证记录

工作目录固定为 `C:\Users\RHH\Desktop\AI-INFRA-Rack`；起始 HEAD `0799add`，保留第二十四轮文档改动。没有提交、推送、remote 修改、迁移、seed、reset 或修改老师原目录/在线数据。

```powershell
node --test apps/api/src/tests/assistant-connections.test.js apps/api/src/tests/assistant-projection.test.js apps/api/src/tests/rack-assistant.test.js
npm run test --workspace @ai-infra/assistant
node --env-file=.env --test apps/api/src/tests/rack-plans.test.js apps/api/src/tests/assistant.test.js
npm run test --workspace @ai-infra/web -- src/tests/assistant-connection.test.jsx src/tests/assistant-render.test.jsx src/tests/assistant-session.test.js src/tests/assistant-state.test.js src/tests/api-client.test.js src/tests/shell-render.test.jsx src/tests/assistant-tool-surface-render.test.jsx
npm run build --workspace @ai-infra/web
git diff --check -- . ':!records/2026-10-29-rack-demand-design'
```

新文件尚未暂存，另逐一使用 `git diff --no-index --check -- NUL <file>` 检查源码与文档。源码检查不把旧轮正在追加的运行日志当作源码；全量 diff 检查曾报告旧日志新增堆栈行末空格，原始日志保持不变。

| 范围 | 最终结果 | 日志 |
| --- | --- | --- |
| 连接服务/HTTP、地址安全、原投影与 Rack 工具 | 30/30，通过，0跳过 | api-tests.txt |
| Assistant 包 | 84/84，通过，0跳过 | assistant-tests.txt |
| 真实数据库/HTTP | 64/64，通过，0跳过；含个人连接→实际组装 Host→Rack 容量工具→答案，权限与无写入 | db-tests.txt |
| 前端定向 | 7文件171/171，通过 | web-tests.txt |
| 构建 | 成功；既有 esbuild/oxc 与 >500kB bundle 提示保留 | web-build.txt |
| 浏览器 | 首次配置、保存、刷新恢复、留空保留 Key、删除确认与清理 | browser-checks.md、first-setup.png |

首次 DB 集成是63/64，新增测试给 Host 传空 config，undefined 的迭代预算使其未进入模型循环。修正夹具为正常 `loadConfig({})` 默认值后定向1/1、完整64/64；没有修改或放宽生产预算/权限。原日志 db-tests-first.txt 保留。最早29项 API 测试通过，后补真实 HTTP 配置生命周期后30项全部通过。

修改 hook 数量期间，Vite 热更新使旧页面遇到 React Hook 顺序错误；正常刷新后恢复并完成全部浏览器流程。该过程由旧轮 web-server-errors.txt 自动记录，没有把它当作验收后的残留产品错误。

只正常重启了本地8797端口上已核实的 Rack API，先 PID33908→42184，最终加载全部代码为27024；使用隐藏后台进程，日志保留在本目录。Web仍5193，数据库仍55532。没有改端口/环境文件/认证配置或清理用户方案。此次正常重启也加载了前轮算法源码，但本轮没有重新声称验收算法布局效果。

没有读取/输出真实 Key、填真实凭证或调用外部模型。服务测试使用注入假 provider；地址传输测试仅连接临时本机 HTTP 服务器。临时数据库项目按原夹具清理，临时文件目录仅删除测试自身创建且核对路径前缀的目录。
