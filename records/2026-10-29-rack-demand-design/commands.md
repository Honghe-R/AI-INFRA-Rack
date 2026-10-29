# 验证与证据

仅在 C:\Users\RHH\Desktop\AI-INFRA-Rack，沿用隔离DB55532，无迁移/seed/reset/删卷。

```powershell
npm run test --workspace @ai-infra/rack
node --env-file=.env --test apps/api/src/tests/rack-plans.test.js
npm run test --workspace @ai-infra/web -- src/tests/rack-demand-design.test.jsx src/tests/rack-options.test.jsx src/tests/rack-floorplan.test.jsx src/tests/rack-editor.test.jsx src/tests/rack-workbench.test.jsx src/tests/rack-constraints.test.jsx src/tests/rack-surface.test.jsx src/tests/rack-sections.test.jsx src/tests/api-client.test.js
npm run build --workspace @ai-infra/web
git diff --check
```

最终日志：domain-tests.txt、api-tests-final.txt、web-tests.txt、web-build.txt。浏览器：browser-checks.md、saved-design.json、saved-layout.png。具体计数见PROGRESS.md；未运行全仓。

domain-tests-first.txt保留4失败：测试柜缺name/source，以及实际生成柜漏projectId/planId领域上下文。补真实上下文，API出票时剥离作用域字段，未放宽规则。api-tests-first.txt为54/56（同上下文导致2失败）；修复后api-tests.txt为56/56。排序修正后重跑最终日志。

首次Vite入口误写apps/web/node_modules，修正为根node_modules后启动。API8797/Web5193正常；既有未配置模型、pg查询排队弃用提示保留，未改认证。

浏览器较早候选为3柜/22台、4.32m²。代码随后按展示的机柜占地区指标排序，领域测试2.64m²。重启API并清空本轮自建示例的组合命令被自动审批阻止；改用保留旧进程/数据、启动备用预览的操作也被拒绝，均未执行、未提供具体原因。之后不再尝试进程/配置变更，保留现有v2示例。最新排序通过代码/临时HTTP测试，尚无新排序浏览器证据。

无停止用户进程、清空现有示例、变更.env、新增端口配置、commit/push或改remotes。HTTP夹具只清理本测试临时项目，用户方案未改。

追加零间距验收曾出现GEOSCovers TopologyException，api-zero-gap.txt/api-zero-gap-diagnostic.txt保留；仅改GeometryCollection仍不足（api-zero-gap-fixed.txt），最终在0最小间距时增加1微米数值分隔，保留严格原规则，api-zero-gap-final.txt为3/3通过。之后重跑完整领域140/140与HTTP56/56（api-tests-final.txt）。浏览器运行中的API也需正常重启才能加载这项修复。
