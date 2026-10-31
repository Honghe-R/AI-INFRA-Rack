# Rack 副本：本地完整平台运行

已于 2026-10-28 接通原平台数据库与对象存储；这是开发环境，不是生产部署。
只在 `C:\Users\RHH\Desktop\AI-INFRA-Rack` 执行以下命令。

AI Assistant 现在可直接在 Ask about Rack 内首次填写接口地址、模型 ID 和 API Key，保存后自动使用，无需为个人连接改环境文件或重启。凭证在操作系统用户数据目录的 AI-INFRA-Rack 下加密持久化，不随 Git 同步；备份时要同时保留连接目录和分开的主密钥目录。多人/多实例部署限制及内网网关配置见 [连接说明](RACK_ASSISTANT_CONNECTION.md)。

## 第一次初始化

需要 Node >= 22.9、npm 和已运行的 Docker Desktop（Linux containers）。

```powershell
npm ci
npm run rack:setup
npm run dev
```

`rack:setup` 从 `.env.rack.example` 生成被 Git 忽略的 `.env`，随机生成本地凭证，
启动 `compose.rack.yaml` 中的两个依赖，执行全部迁移（当前 11 个）、身份/权限示例和 Facility 示例初始化。已有副本只需 `npm run migrate`，不要重复初始化或 reset。
已有 `.env` 不会被覆盖；如不符合 Rack 隔离配置会停止并说明原因。
不要在终端预先导出其他数据库、Compose 或存储配置；初始化助手会拒绝相关环境覆盖，避免操作其他环境。

初始化脚本是开发样例的导入工具。后续已经编辑示例项目时，不要把它当成日常启动命令：
Facility seed 会替换它负责的示例行。正常重启按下一节操作。

## 日常启动与停止

启动 Docker Desktop 后，在副本根目录执行：

```powershell
npm run dev:up
npm run dev
```

打开 **http://localhost:5193/**，点击 **Northern DC Campus**，即可查看 **Site & Facility** 的场地、建筑和机房边界。
建议使用较宽的浏览器窗口；窄侧栏中导航和属性面板会折叠或挤压画布。
默认先进入个人账号登录页，不再展示全部账号供任意切换。首次由操作者在副本根目录执行：

```powershell
npm run rack:account -- --subject dev-user --login admin
```

打开输出路径 `.local-runtime/auth/activate-admin.txt` 中的一次性链接，设置自己的密码，再以 `admin` 登录。链接24小时有效，只可成功使用一次；没有统一默认密码。登录保持8小时，左下角只显示本人账号，可点开退出。操作前请保存布局草稿，退出会丢弃未保存的浏览器状态。

可以用同一命令为已有后端身份分别开通账号，例如 `--subject dev-editor --login editor` 或 `--subject dev-viewer --login viewer`，每个人通过自己的激活链接设置密码。该命令不会新增项目权限或修改设备／方案。账号文件和激活链接均在被Git忽略且禁止通过Web访问的 `.local-runtime/auth/` 下；激活后由操作者清理对应链接文件。完整契约和生产部署边界见 [Local sign-in](doc/tools/rack/local-sign-in.md)。

只有明确设置 `RACK_AUTH_MODE=demo` 才保留旧的开发身份切换，且要求开发服务器绑定本机。正常演示使用默认的 `password` 模式。

`npm run dev` 同时启动 API、前端和本地合成网格瓦片。当前默认显示 Plan only，
可直接看设施几何；本地瓦片也是合成网格，不是卫星图或真实地图。

在启动终端按 **Ctrl+C** 停止本次启动的应用进程。
再执行以下命令可停止依赖容器，保留数据库和对象存储的数据卷：

```powershell
npm run dev:down
```

不要为正常重启运行 `dev:reset`：该命令会删除所选 Compose 栈的数据卷。
若端口被占用，先确认当前运行的进程或终端，不要盲目结束其他项目的服务。

## 本副本的隔离配置

| 内容 | 地址/名称 |
| --- | --- |
| Compose 项目 | `ai-infra-rack-dev`，使用 `compose.rack.yaml` |
| 数据库 | `127.0.0.1:55532`，数据库 `rack_facility` |
| S3 对象存储 | `http://127.0.0.1:59100`，桶 `rack-dev-assets` |
| 存储管理控制台 | `http://127.0.0.1:59101`，本地凭证在 `.env` 中 |
| API | `http://127.0.0.1:8797` |
| 前端 | `http://localhost:5193/` |
| 合成瓦片 | `http://127.0.0.1:8088` |
| 独立 Rack 样例预览 | `npm run rack:preview`，`http://127.0.0.1:5183/` |
| 持久化卷 | `ai-infra-rack-dev_rack-db-data`、`ai-infra-rack-dev_rack-object-data` |

所有端口仅绑定本机。没有修改老师原目录，也没有启动原目录的 Compose 栈。
原 `compose.yaml` 保留；本副本 `.env` 的 `AI_INFRA_COMPOSE_FILE` 选择 Rack 栈。
PostGIS 与 RustFS 使用固定镜像摘要，避免后续拉取的镜像内容悄然变化。
原项目的 MinIO 镜像目前拉取返回 401；Rack 栈改用 RustFS 1.0.4，保持原 S3 驱动与 API。
本轮验证了建桶、PUT/HEAD/GET、签名下载及示例资产导入；不代表全部 S3 能力都已验证。

## 检查与范围

```powershell
npm run dev:status
node --test scripts/tests/probes.test.mjs
npm run test --workspace @ai-infra/rack
node --env-file=.env records/2026-10-28-platform/check-runtime.mjs
```

最后一条需要 `npm run dev` 正在运行；读取两个示例项目，并在对象存储中创建、读取、删除一个唯一临时检查文件。
运行证据见 [records/2026-10-28-platform](records/2026-10-28-platform)。

原平台已接通，另有 [空 Rack 方案创建/读取 API](RACK_API.md)。已有环境更新代码后先运行 `npm run migrate`，不必重跑 seed。
正式 Rack 入口已接通方案列表、创建、固定机房快照与机柜编辑保存，操作见 [Rack 工作区说明](RACK_WORKSPACE.md)。
选择方案后可查看绑定机房的只读米制平面图，支持范围与来源过期处理见 [RACK_FLOORPLAN.md](RACK_FLOORPLAN.md)。
机柜/约束/设备已可同事务保存，Layout options 支持布局候选；Devices & U slots 支持 [自动上架](RACK_ALLOCATION.md)。[Rack Assistant 工具已接线](RACK_ASSISTANT.md)，按用户要求暂不配置LLM，因此聊天当前不可用。更新本轮代码不需要新迁移或重跑seed。
当前本地数据库沿用初始化用户（超级用户）连接，适合这份单机开发基线；
生产部署须拆分迁移/应用账号并重新验证数据库 RLS。两组织的 API 拒绝检查不能代替 RLS 安全审计。
开发身份切换、HTTP、本机凭证和这套服务不应用于公网部署。
