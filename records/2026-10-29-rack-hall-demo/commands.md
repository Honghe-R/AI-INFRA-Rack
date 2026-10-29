# 第十九轮验证

工作目录 C:\Users\RHH\Desktop\AI-INFRA-Rack；未提交或推送。开发服务沿用 Web5193、API8797、本地隔离 PostGIS55532。

```powershell
node --test scripts/tests/rack-hall-demo.test.mjs
npm run test --workspace @ai-infra/web -- src/tests/rack-hall-inventory.test.jsx src/tests/rack-surface.test.jsx src/tests/rack-editor.test.jsx src/tests/rack-sections.test.jsx src/tests/rack-options.test.jsx src/tests/rack-allocation.test.jsx src/tests/rack-inputs.test.jsx src/tests/rack-equipment.test.jsx src/tests/rack-room-budget.test.jsx src/tests/rack-constraints.test.jsx src/tests/rack-catalog.test.jsx src/tests/rack-floorplan.test.jsx
npm run build --workspace @ai-infra/web
npm run rack:demo:hall -- 4c11ab8d-5d57-4ad8-ad55-ac08574fba46 e446aafb-1846-4a69-af10-636fd50ba87c
git diff --check
```

- fixture-tests.txt：4 通过；web-tests.txt：最终 50 通过/12 文件；web-build.txt：成功，bundle 仍较大。
- demo-create.txt：普通 HTTP 创建并保存 v2、重读相同，7 个旧方案和来源不变，分配及双策略通过；demo-retain.txt：再次运行保留已有示例。
- 单次本机 smoke：检查 373.62ms、保存 465.23ms、分配 353.64ms、双候选 2212.91ms；不代表吞吐量或扩展性结论。
- web-tests-initial.txt 保存初始 SSR 测试正则误计容器的问题，修正匹配后通过。demo-create-api-startup.txt 保存初始空响应，原因未确定，重试成功。
- 未修改后端算法，本轮没有重跑整个 API/全仓测试。真实本地 API 覆盖本例实际检查/持久化/试算。
