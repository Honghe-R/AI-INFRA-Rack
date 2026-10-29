# 验证命令与范围

只在 C:\Users\RHH\Desktop\AI-INFRA-Rack 执行。使用现有隔离 .env，不输出凭证，不修改老师目录。

```powershell
npm run migrate
node --env-file=.env --test apps/api/src/tests/rack-plans.test.js
npm run test --workspace @ai-infra/web -- src/tests/rack-surface.test.jsx src/tests/rack-editor.test.jsx src/tests/rack-sections.test.jsx src/tests/rack-workbench.test.jsx src/tests/rack-constraints.test.jsx src/tests/rack-equipment.test.jsx src/tests/rack-room-budget.test.jsx src/tests/api-client.test.js
npm run build --workspace @ai-infra/web
git diff --check
```

本轮测试最终 API 53/53，无跳过；Web 46/46，8文件；构建成功，已有大包提示保留。未运行全仓。
api-tests.txt保留首轮网络fetch failed，api-tests-rerun.txt为独立重跑53/53，api-tests-final.txt为补缓存修复后53/53。
web-tests-attribute-order.txt为断言属性顺序错误，最终web-tests.txt已通过，没有删除业务断言。

本机数据清理经过正常版本化API；读DB仅用来校验持久化内容未变。下面两条为本机单次记录脚本，不是初始化入口：

```powershell
node --env-file=.env records/2026-10-29-rack-user-journey/archive-old-demos.mjs
node --env-file=.env records/2026-10-29-rack-user-journey/archive-old-demos.mjs --apply
node --env-file=.env records/2026-10-29-rack-user-journey/finish-journey.mjs
```

第一个默认只读列出确切7项；--apply才软删除。脚本限制Rack隔离库、项目、revision和确切名称。
finish-journey只整理本轮固定ID的临时浏览器验收方案，其他环境不要照搬ID。
两个脚本均可处理已删除目标；没有永久删除行为，不运行seed/setup/reset。
