# 验证命令与范围

工作目录始终为 `C:\Users\RHH\Desktop\AI-INFRA-Rack`，本轮 HEAD 为 `20b85e0`。没有执行 commit/push、改 remotes 或修改老师原目录/平台数据。

```powershell
npm run test --workspace=@ai-infra/web -- src/tests/rack- src/tests/tool-registry.test.js src/tests/open-views.test.js src/tests/shell-render.test.jsx src/tests/toolbar-structure.test.jsx
npm run build --workspace=@ai-infra/web
git diff --check
```

- web-tests.txt：19 文件、129 测试通过。新增 6 项覆盖命令权限/阻止原因、候选草稿保护、组合添加/不变性、版本/目录/数量边界、数量表单、立面与容量未知值。
- web-build.txt：构建成功；保留已有 esbuild/oxc 和 >500kB 提示。
- 首次较小范围 8 文件42项通过，随后加入 shell/registry/其余 Rack 定向回归为129项。没有后端变更，没有重复领域/数据库测试，也没有运行全仓测试。
- 首次 diff 检查发现新增行末空格，已清除后再次检查。
- 浏览器具体流程见 browser-checks.md；toolbar.png、elevations.png、capacity.png 为实际截图。截图使用窄屏与展开工作台状态；立面完整图可见右侧交换机 Inspector。

旧轮运行日志 api-server.txt / web-server.txt 会由既有开发进程自动追加；本轮未重启服务或改配置。上一轮 API 算法最终排序/零间距修复的运行版本限制仍按上一轮记录保留，不能把本轮 UI 验收当作这些算法的再次验收。
