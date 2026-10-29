# 第十八轮验证命令

全部在 C:\Users\RHH\Desktop\AI-INFRA-Rack 执行，2026-10-29。没有 commit/push、迁移、seed、setup 或 reset；不操作老师目录/平台。

```powershell
npm run test --workspace @ai-infra/rack
node --env-file=.env --test apps/api/src/tests/rack-plans.test.js apps/api/src/tests/rack-assistant.test.js apps/api/src/tests/assistant-projection.test.js
npm run test --workspace @ai-infra/web -- src/tests/assistant-session.test.js src/tests/assistant-state.test.js src/tests/assistant-render.test.jsx src/tests/assistant-tool-surface-render.test.jsx src/tests/rack-surface.test.jsx src/tests/rack-editor.test.jsx src/tests/rack-sections.test.jsx src/tests/rack-options.test.jsx src/tests/rack-allocation.test.jsx src/tests/rack-inputs.test.jsx src/tests/rack-equipment.test.jsx src/tests/rack-constraints.test.jsx src/tests/rack-catalog.test.jsx src/tests/rack-floorplan.test.jsx src/tests/rack-room-budget.test.jsx
npm run build --workspace @ai-infra/web
node --env-file=.env records/2026-10-29-rack-room-budget/create-room-budget-demo.mjs
git diff --check
```

领域 135；数据库/API 50 + 适配/投影 16 = 66；Web 171/15文件；最终均通过，无跳过。build 成功，有既有 >500kB bundle 提示。没有重跑全仓。

首次数据库测试因 Docker Desktop 未启动、127.0.0.1:55532 拒绝连接而 50 项失败、15 项通过，保留 api-tests-db-unavailable.txt。启动已安装 Docker Desktop，然后仅运行 `docker compose -f compose.rack.yaml -p ai-infra-rack-dev up -d` 恢复原隔离栈，独立重跑成功。没删除卷或改配置。之后 `npm run dev` 启动本地 API8797/Web5193，Assistant 无 provider 的既有警告符合用户暂不配置模型的决定。

浏览器另见 browser-checks.md；页面测试只改临时草稿并放弃，没有保存示例改动。实际保存/拒绝在独立 HTTP 示例和临时集成 fixture 验证。
