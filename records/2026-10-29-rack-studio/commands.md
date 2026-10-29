# 第二十轮：可视化工作台验证

工作目录仅 C:\Users\RHH\Desktop\AI-INFRA-Rack；起始 HEAD ec71d17。未 commit、push、改 remotes、改老师目录/线上平台，未配置模型，未修改后端或数据库 schema。

```powershell
npm run test --workspace @ai-infra/web -- src/tests/rack-workbench.test.jsx src/tests/rack-editor.test.jsx src/tests/rack-floorplan.test.jsx src/tests/rack-surface.test.jsx src/tests/rack-sections.test.jsx src/tests/rack-inputs.test.jsx src/tests/rack-options.test.jsx src/tests/rack-allocation.test.jsx src/tests/rack-equipment.test.jsx src/tests/rack-room-budget.test.jsx src/tests/rack-constraints.test.jsx src/tests/rack-catalog.test.jsx src/tests/rack-hall-inventory.test.jsx
npm run build --workspace @ai-infra/web
git diff --check
```

- web-tests.txt：56 通过 / 13 文件，新增 6 项覆盖物理坐标/旋转占地、禁放区视口、响应式留白和指针反算、吸附不变性、Inspector 已安装/待上架/未知资源区分、真实 Polygon 孔洞和只读呈现。
- web-build.txt：成功；bundle 大于 500kB 的既有提示仍存在，不视为性能优化。
- 首次新增测试全部通过，但暴露 React 对 SVG title 多 children 的警告；改为单一模板字符串后最终输出无该警告。
- saved-state.json：用 Web5193 的普通 dev proxy GET 重读保存方案，v2、32 柜、236 已安装、8 待上架、D08 仍为原始坐标。最初直接访问 API8797 携带 x-dev-subject 返回 401；该 header 必须由既有 Web 开发代理转换成签名 token，改走正常代理成功，没有绕过认证。
- 浏览器步骤和限制见 browser-checks.md；截图 rack-inspector.jpg / device-inspector.jpg。
- 未重跑后端全套或全仓测试；本轮 API 真实调用覆盖普通布局检查和重读，未执行测试保存。
