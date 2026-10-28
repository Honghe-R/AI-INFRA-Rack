# 第十七轮验证命令

全部在 `C:\Users\RHH\Desktop\AI-INFRA-Rack` 执行。没有seed/setup/migrate、commit或push。

```powershell
npm run test --workspace @ai-infra/rack
node --test apps/api/src/tests/rack-assistant.test.js apps/api/src/tests/assistant-projection.test.js
npm run test --workspace @ai-infra/assistant
node --env-file=.env --test apps/api/src/tests/rack-plans.test.js apps/api/src/tests/assistant.test.js
npm run test --workspace @ai-infra/web -- src/tests/assistant-session.test.js src/tests/assistant-state.test.js src/tests/assistant-render.test.jsx src/tests/assistant-tool-surface-render.test.jsx src/tests/rack-surface.test.jsx src/tests/rack-editor.test.jsx src/tests/rack-sections.test.jsx src/tests/rack-options.test.jsx src/tests/rack-allocation.test.jsx src/tests/rack-inputs.test.jsx src/tests/rack-equipment.test.jsx src/tests/rack-constraints.test.jsx src/tests/rack-catalog.test.jsx src/tests/rack-floorplan.test.jsx
npm run build --workspace @ai-infra/web
node --env-file=.env records/2026-10-29-rack-assistant/create-allocation-demo.mjs
git diff --check
```

最终分别122、15、84、54、167项通过，无失败/跳过，构建成功；不是全仓测试。浏览器为真实UI流程，模型调用用可控provider在测试中执行。本机未配真实模型，不能据此声称自然语言端到端通过。
