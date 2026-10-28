# 项目进展记录

> 记录原则：只记实际发生的修改与验证；设计方向、已实现、未验证分别说明。
> 工作目录：`C:\Users\RHH\Desktop\AI-INFRA-Rack`。
> 操作约束：仅本地开发；不自动 commit、push、改远程或向原老师仓库写入。提交由用户自行完成。

## 当前状态

| 内容 | 状态 |
| --- | --- |
| 起始基线 | 当前副本初始提交 `638a769`；第一轮开始时工作区干净，后续保留前轮未提交修改 |
| 已实现 | Rack 领域基础与三项空间规则（74 项测试）；另有空方案持久化/创建读取 API、项目权限与来源核对（10 项数据库/API 集成测试） |
| 已记录 | 基础契约、坐标、方案初始状态/版本、来源比较、三项空间规则、清单覆盖声明与未检查范围、遗留问题 |
| 部分推进 | 总清单阶段 0–2；阶段 3 完成空方案存储/权限/API 最小切片；阶段 5 提前完成三项离线空间规则 |
| 运行基线 | 原平台已接通独立 PostgreSQL/PostGIS 与 S3 对象存储，两个示例项目可读；见 2026-10-28 记录 |
| 尚未开始 | 机柜/设备表与保存、正式工作区页面、设备分配、净距/通道/容量等其他规则、布局算法、候选、Assistant |
| Git | 所有修改留在工作区，未提交、未推送；远程地址保持原样 |

当前安排：2026-10-28 用户恢复数据库/平台初始化并允许 Docker；已完成隔离的本地开发运行基线，后续继续按小步推进 Rack 功能。

当前可通过独立的[只读可视化预览](RACK_PREVIEW.md)查看合成样例；正式工作区 Rack 编辑器与方案保存尚未实现。三项局部空间检查不代表完整方案验证通过。

## 2026-10-27：第一轮基础工作

### 1. 本轮目标与范围调整

最初按总清单准备推进最小读写闭环；随后根据用户要求收窄为基础工作。
这轮停在环境基线、基础数据契约和领域包骨架，不扩展完整平台功能。
所有操作均在 Rack 副本中进行，没有在 `C:\Users\RHH\Desktop\AI-INFRA` 中执行修改。

### 2. 环境与原代码检查

- 系统：Windows，PowerShell。
- Node：`v22.22.1`；npm：`10.9.4`，满足项目 Node >= 22.9 的要求。
- 起始提交：`638a769 first commit`。
- 原远程：`https://github.com/Honghe-R/AI-INFRA-Rack.git`，未修改。
- 未发现适用的 `AGENTS.md`。
- 初始没有 `node_modules`、`.env`；已执行 `npm ci --no-audit --no-fund` 安装依赖。
- Docker 命令存在，但 Linux 引擎未运行，连接 `dockerDesktopLinuxEngine` 失败。
- 本轮没有启动 Docker、创建 `.env`、执行迁移/seed 或启动长驻前后端服务。
- 启动检查时，5173、8787、55432、59000、59001 未发现监听。
- 注意：两个副本继承相同 Compose 项目名 `ai-infra-dev`。后续启动 Rack 数据栈前要单独配置项目名、数据卷和端口，避免两个项目共用状态。

### 3. 已完成的修改

| 文件/目录 | 内容及目的 |
| --- | --- |
| [RACK_FOUNDATION.md](RACK_FOUNDATION.md) | 记录本轮范围、基础字段、坐标约定和后续接口/版本设计方向 |
| [AGENTS.md](AGENTS.md) | 固定仅修改副本、只做本地工作、不自动提交/推送、持续更新记录的约束 |
| [packages/rack/package.json](packages/rack/package.json) | 新增 npm workspace，使用原生 Node 测试，无外部运行依赖 |
| [model.js](packages/rack/src/model.js) | 型号和实例分离；检查有限数值、UUID、单位字段、来源、旋转与锁定类型；未知容量保持 null |
| [geometry.js](packages/rack/src/geometry.js) | 围绕中心旋转，计算四角、正面边与边界框，明确为室内局部米制坐标 |
| [index.js](packages/rack/src/index.js) | 暴露有限且明确的基础 API |
| [basic-rack.json](packages/rack/examples/basic-rack.json) | 可复现的合成 42U 示例，明确非厂商规格且容量未知 |
| [model.test.js](packages/rack/src/tests/model.test.js) | 17 项测试，覆盖缺失/非法参数、来源、不可变数据、旋转、型号不匹配与数值退化 |
| [包说明](packages/rack/README.md) | 运行方式、导出 API 与当前不覆盖的能力 |
| [package-lock.json](package-lock.json) | 注册新 workspace；npm 同时校正既有 Facility 包遗漏的依赖元数据，未新增第三方依赖 |
| [RACK_PROJECT_TODO.md](RACK_PROJECT_TODO.md) | 添加进展入口，只勾选有证据的基础事项，保留未完成项 |
| [README.md](README.md) | 增加本课程 Rack 扩展的文档入口，保留原平台说明 |
| [records/2026-10-27-foundation](records/2026-10-27-foundation) | 保存命令与测试/构建摘要，方便后续比较 |

### 4. 验证结果

| 验证 | 结果与边界 | 证据 |
| --- | --- | --- |
| 初始依赖安装 | 成功；新包注册后再次同步 workspace | 本轮命令记录与 lockfile |
| 原平台构建 `npm run build` | 成功；有既有 esbuild/oxc 配置提示，未影响构建 | [baseline-build.txt](records/2026-10-27-foundation/baseline-build.txt) |
| 修改前 `npm test` | 1038 通过、16 失败、380 跳过；其中前端 47 个文件/608 测试通过 | [baseline-tests.txt](records/2026-10-27-foundation/baseline-tests.txt) |
| Rack 测试 | 17 通过，0 失败，0 跳过；不依赖数据库和模型服务 | [rack-tests.txt](records/2026-10-27-foundation/rack-tests.txt) |
| 修改后全仓回归 | 1055 通过、16 失败、380 跳过；与修改前的失败名称完全相同，新增 Rack 17 项均通过 | [regression-tests.txt](records/2026-10-27-foundation/regression-tests.txt) |

已定位的 16 项基线失败：

1. Facility 工具测试 13 项：未配置 `DATABASE_URL` 时仍构建需要 pool 的工具，报数据库 pool 缺失。
2. API Assistant 测试 2 项：无数据库时 fixture 的 repository 未初始化，调用 `createUser` 失败。
3. RBAC 客户端目录校验 1 项：生成文本与工作副本的 LF/CRLF 差异导致字节比较失败。

本轮不修改这些原模块的业务或测试，以便保持新增基础工作的边界。没有声称全仓测试通过，也没有把跳过的数据库测试当作验证成功。

另以 workspace 包名导入 `@ai-infra/rack` 并执行合成示例，确认安装链接与公开导出可用。原测试会临时重写 `packages/db/bin/migrate.js` 的文件形式，本轮已恢复该测试副作用，未保留对原模块的修改。最终代码差异中只有 Rack 基础包、文档与锁文件，不包含数据库或前端业务代码变更。

### 5. 已确定的基础约定

- 型号和实例分离；实例包含项目与方案身份，但服务端归属校验尚未实现。
- 米制局部坐标、中心位置、逆时针四分之一转；0 度正面为局部 -Y。
- 尺寸/坐标不能使用数字字符串、NaN 或 Infinity；未知容量为 null。
- 示例仅为合成训练数据，不能据此声称真实机柜容量已确认。
- 数据输入有效不代表布局/容量可行，基础函数不返回“工程验证通过”。
- 版本方向暂选独立 Rack Plan 绑定设施输入，持久化前还需评审工作区/Assistant 适配。

### 6. 未完成与下一步

- Docker 引擎未运行，原平台迁移/seed/端到端基线仍待做。
- 完整机房输入、障碍/净距、预算与设备 contract 尚未确定。
- 版本策略只是设计方向，尚无 Rack Plan、并发控制或过期校验实现。
- 没有 Rack 数据库表、API、权限目录、页面或 Assistant surface。
- 下一小步建议：隔离本地 Compose 环境并验证原平台运行，再设计“创建/读取一个空 Rack Plan”的持久化闭环。
- 下一轮追加记录，注明新增文件、运行命令、成功/失败/跳过和待办；不删除本轮历史。

## 2026-10-27：第二轮，离线空方案基础

### 1. 目标与范围调整

原定补运行基线；检查时 Docker 引擎已可连接，临时准备了副本专用隔离配置并尝试下载镜像。
原 MinIO 镜像返回 401，PostGIS 下载尚未完成。随后用户明确“先不要弄 Docker，先整其他的”。
已停止本轮启动的 Compose 下载进程，撤回本轮新增的 Compose、环境示例和启动脚本修改，删除本轮新建的 `.env` 及未使用的运行助手。
此前的 Rack 基础代码与文档保留；没有执行迁移、seed、前后端启动或数据库写入。
Docker 可能保留已下载的镜像缓存，本轮没有清理全局 Docker 数据。尝试摘要见 [attempt.txt](records/2026-10-27-local-runtime/attempt.txt)。

调整后本轮只实现“创建一个空的内存方案，并识别上游来源引用变化”，不做数据库和网页。

### 2. 实际修改

| 文件 | 作用 |
| --- | --- |
| [input.js](packages/rack/src/input.js) | 抽出已有错误、对象、UUID 和文本检查，供型号与方案复用；不引入外部依赖 |
| [model.js](packages/rack/src/model.js) | 复用上述基础校验，保持原有公开导出和行为 |
| [plan.js](packages/rack/src/plan.js) | 新增设施来源引用、空 Rack Plan 构造与来源变化比较 |
| [index.js](packages/rack/src/index.js) | 新增三个公开 API |
| [empty-plan.json](packages/rack/examples/empty-plan.json) | 合成的空方案创建输入，标识与版本 token 均不是真实设施数据 |
| [plan.test.js](packages/rack/src/tests/plan.test.js) | 新增 15 项测试，涵盖来源绑定、字段校验、初始状态、不可变性、版本过期和身份变更 |
| [RACK_FOUNDATION.md](RACK_FOUNDATION.md) | 第 9 节记录完整创建字段、比较结果及服务层待办；调整下一阶段方向 |
| [包说明](packages/rack/README.md)、[总清单](RACK_PROJECT_TODO.md) | 更新已有能力和局部完成项，不将整个阶段标记完成 |
| [AGENTS.md](AGENTS.md) | 固定用户暂缓 Docker/环境初始化的最新要求 |

### 3. 设计选择与边界

- Rack 方案初始独立版本为 1，与上游设施 ETag 分离。
- 初始 `DRAFT / NOT_RUN`、空机柜列表；不允许创建调用方直接传入 PASSED、已有版本或非空机柜列表。
- 来源绑定项目、场景、revision、机房和不透明 revision ETag；项目/场景自报不一致会拒绝。
- `UNCHANGED / STALE / DIFFERENT_SOURCE` 分开表达；换机房或 revision 不能伪装成普通版本刷新。
- 这些是纯数据检查。数据库中的真实归属、授权、权威最新版本、边界快照、冻结来源 checksum 仍未验证或实现。
- 创建返回的内容没有保存到数据库/文件；JSON 可序列化不等于已经完成保存闭环。

### 4. 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run test --workspace @ai-infra/rack` | 32 通过、0 失败、0 跳过（原 17 项 + 新增 15 项） | [rack-tests.txt](records/2026-10-27-plan-foundation/rack-tests.txt) |
| 通过 workspace 包名导入并运行样例 | 成功创建未校验草稿；更换设施 ETag 后返回 STALE | [example-output.txt](records/2026-10-27-plan-foundation/example-output.txt) |
| 新增/调整代码的 `node --check` | 通过 | 本轮命令记录 |
| `git diff --check` | 通过；Git 有既有 LF/CRLF 提示 | 本轮命令记录 |

本轮没有重跑全仓构建/测试；第一轮全仓的 16 项基线失败仍作为历史记录保留，不能将本轮 32 项通过解读为全仓通过。
数据库、S3 下载和浏览器检查没有完成，也没有把环境受阻当作业务测试通过。

### 5. 下一小步

先离线定义机房局部米制边界与输入快照，建立边界/障碍数据检查，再逐步补包含和碰撞规则。
数据库/API 的“空方案创建与读取”闭环延后，不自动恢复 Docker 工作。
本轮未 commit、未 push，老师原目录没有修改。

## 2026-10-27：第三轮，离线机房输入与单柜空间检查

### 1. 本轮目标与范围

沿第二轮下一步推进局部米制机房输入与空间规则，不涉及 Docker、数据库或网页。
为控制范围，仅支持明确声明的轴对齐矩形机房和矩形障碍，检查单个机柜越界与障碍冲突。
真实设施转换、非矩形空间、机柜间碰撞、净距与容量留到后续。

### 2. 实际修改

| 文件 | 内容与目的 |
| --- | --- |
| [room.js](packages/rack/src/room.js) | 新增不可变的矩形机房输入副本；检查单位、局部坐标声明、原点说明、来源、有限正跨度、障碍归属/重复/数量与完整性声明 |
| [spatial.js](packages/rack/src/spatial.js) | 新增单柜房间包含/障碍冲突检查，复用四方向占地；返回规则、证据、问题及未检查范围 |
| [index.js](packages/rack/src/index.js) | 暴露机房构造器、单柜检查与两个常量 |
| [rectangular-room.json](packages/rack/examples/rectangular-room.json) | 10m × 8m 合成矩形机房和一个障碍，明确非真实设施与调查结果 |
| [spatial-demo.mjs](packages/rack/examples/spatial-demo.mjs) | 无服务、无文件写入的四场景可执行演示 |
| [spatial.test.js](packages/rack/src/tests/spatial.test.js) | 新增 21 项测试，覆盖有效/无效输入、旋转、四墙越界、边角接触、微小间隙、不完整清单和多项诊断 |
| [基础约定第 10 节](RACK_FOUNDATION.md#10-第三轮矩形机房输入与单柜空间检查已实现离线) | 记录输入 contract、规则语义、结果状态、局限与运行命令 |
| [包说明](packages/rack/README.md)、[总清单](RACK_PROJECT_TODO.md) | 更新能力与局部完成项，未勾选完整空间引擎或阶段验收 |

### 3. 关键选择与适用边界

- 输入必须显式是米制 ROOM_LOCAL；不自动把经纬度、毫米或多边形包围框当成可用矩形机房。
- 房间原点用描述记录，沿用 X 右、Y 上；尚无真实设施投影/原点变换。
- 机柜恰好贴房间边界视为占地被包含；碰到障碍边或角视为冲突。维护净距未检查。
- 不暗设数值容差；浮点贴边可能被保守报错，微小正间隙也不等于可通行净距。
- 障碍数组和覆盖声明必填；UNKNOWN 时无已知问题也返回 INCOMPLETE / NOT_CHECKED。
- 已知越界或冲突返回诊断，不把合法但摆放不合理的数据当作结构错误拒绝。
- 输出含来源和未检查范围；不返回整体 feasible，不更新 Plan 的 NOT_RUN 状态。
- snapshotId 只是调用方提供的标识，没有持久化、hash、权威新鲜度或 Plan/room 真实绑定验证。
- 单柜检查按代码结构对障碍做线性遍历 O(m)，输入最多 256 个障碍；本轮没有做实测性能/扩展性实验。

### 4. 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run test --workspace @ai-infra/rack` | 53 通过、0 失败、0 跳过（原有 32 + 新增 21） | [rack-tests.txt](records/2026-10-27-spatial-foundation/rack-tests.txt) |
| `node packages/rack/examples/spatial-demo.mjs` | 通过包名导入并输出四场景：CHECKED_SCOPE_CLEAR、ISSUES_FOUND、ISSUES_FOUND、INCOMPLETE；另用断言检查顺序与状态 | [spatial-demo.json](records/2026-10-27-spatial-foundation/spatial-demo.json) |
| 三个新增实现/演示文件的 `node --check` | 通过 | 本轮命令记录 |
| 文档本地链接与 `git diff --check` | 检查无缺失链接/空白错误；有既有 LF/CRLF 提示 | 本轮命令记录 |

只验证本轮涉及的 Rack 领域代码与样例，没有重跑全仓构建/测试；第一轮 16 项基线失败仍为历史结果，不能宣称全仓通过。
没有启动 Docker、数据库、前后端、迁移或 seed；没有新增外部依赖，也没有改动原平台业务代码。

### 5. 下一小步

可继续离线补机柜之间的占地碰撞检查，以及多柜场景的结构化诊断；仍需明确这是局部检查，不是完整方案可行性。
真实设施到局部几何的转换与 Plan 输入绑定待单独补齐，数据库/API/界面继续延后。
所有修改保留在工作区，未 commit、未 push，未改动老师原目录。

## 2026-10-27：第四轮，多柜碰撞与汇总

### 1. 本轮目标与范围

按第三轮下一步，补机柜之间的占地碰撞和多柜结构化诊断。
继续纯离线开发，不启动 Docker、数据库、迁移、seed 或前后端，不扩展页面、算法和 Assistant。

### 2. 实际修改

| 文件 | 内容与目的 |
| --- | --- |
| [layout.js](packages/rack/src/layout.js) | 新增 `checkRackLayout`；检查布局声明、型号/机柜清单及引用，复用单柜规则并遍历全部无序机柜对 |
| [spatial.js](packages/rack/src/spatial.js) | 增加稳定规则 ID `rack.space.rack_collision`，单柜行为保持不变 |
| [index.js](packages/rack/src/index.js) | 暴露多柜检查和型号/机柜数量上限常量 |
| [layout.test.js](packages/rack/src/tests/layout.test.js) | 新增 21 项测试，包含接触/包含/旋转、未知清单、空布局、归属声明/引用错误、上限与修复后重算 |
| [layout-demo.mjs](packages/rack/examples/layout-demo.mjs) | 六场景合成演示，直接通过 workspace 包名调用；不保存方案 |
| [基础设计第 11 节](RACK_FOUNDATION.md)、[包说明](packages/rack/README.md)、[清单](RACK_PROJECT_TODO.md) | 记录字段、汇总状态、接触策略、规模约束与未覆盖内容 |

### 3. 设计选择与适用边界

- 仅检查一个声明项目/方案中的所提供机柜清单；拒绝混用方案、项目不符、重复机柜/型号 ID 或缺失型号。
- 柜间有正面积内部重叠才报 `RACK_PAIR_OVERLAP`，边/角接触允许占地规则通过；维护净距依然未检查。
- 与障碍的接触仍按原保守冲突规则处理，不修改第三轮规则语义。
- 每个无序对只报告一次，证据包含双方 ID、米制占地与重叠区域；锁定机柜不豁免规则。
- 新增机柜清单 COMPLETE / UNKNOWN 声明。未知清单无已知问题返回 INCOMPLETE，空清单返回 NOT_CHECKED。
- `rackReports` 保持单柜规则原报告；最外层诊断汇总单柜问题和柜间冲突，结果不可变，不推进方案版本/验证状态。
- 上限为 256 台机柜、256 个型号；不能静默截断或跳过超限/错误条目。
- 本轮自报归属一致不代表真实 Plan 绑定、来源新鲜、授权或真实机房清单完整，这些仍由未来服务层实现。

### 4. 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run test --workspace @ai-infra/rack` | 74 通过、0 失败、0 跳过（原 53 + 新增 21）；单柜旧测试保持通过 | [rack-tests.txt](records/2026-10-27-layout-collision/rack-tests.txt) |
| `node packages/rack/examples/layout-demo.mjs` | 六场景分别为 CHECKED_SCOPE_CLEAR、ISSUES_FOUND、CHECKED_SCOPE_CLEAR、ISSUES_FOUND、INCOMPLETE、NOT_CHECKED；另断言混合诊断和碰撞计数 | [layout-demo.json](records/2026-10-27-layout-collision/layout-demo.json) |
| 256 台上限测试 | 遍历 32640 个无序对，无重复计数；不是实际性能基准 | 同上测试证据 |
| 新实现/演示 `node --check`、本地文档链接、`git diff --check` | 通过；Git 仍有既有 LF/CRLF 提示 | 本轮命令记录 |

未重跑全仓构建/测试，第一轮 16 项基线失败是历史结果；没有宣称全仓通过。
没有新增第三方依赖或修改原平台业务模块。没有启动服务、执行迁移/seed、写数据库或访问远程仓库。

### 5. 下一小步

可继续定义机柜正面/背面的维护净距、缺失值和接触策略，再离线实现对应规则。
真实设施输入转换、Plan 绑定、容量、存储/API/界面继续作为独立后续阶段。
本轮未 commit、未 push；所有修改在 Rack 副本，老师原目录未改动。

## 2026-10-27：第五轮，只读可视化预览

- 用户要求在可视化平台查看，新增独立本地预览；没有启动 Docker 或数据库。
- `npm run rack:preview` 启动，地址为 http://127.0.0.1:5183/，当前保持运行供用户查看。
- 新增 [预览服务](scripts/rack-preview.mjs)、[页面](apps/web/rack-preview/index.html)、[交互](apps/web/rack-preview/preview.js)、[样式](apps/web/rack-preview/preview.css) 与[运行说明](RACK_PREVIEW.md)。
- 提取[共享样例](packages/rack/examples/layout-scenarios.mjs)，CLI 演示和预览复用同一组输入。预览在 Node 中直接调用现有领域规则，未复制规则到浏览器。
- 支持六个场景、机柜属性查看、诊断点击定位、重叠高亮、检查范围与原始报告。仅展示合成数据，不支持编辑、保存或真实项目读取；未接入原工作区。
- Rack 74 项测试通过；HTTP 检查确认六场景报告/几何与领域函数一致、写请求返回 405、非白名单仓库文件返回 404，见 [http-checks.txt](records/2026-10-27-preview/http-checks.txt) 和 [rack-tests.txt](records/2026-10-27-preview/rack-tests.txt)。
- 实际浏览器验证场景切换和碰撞双方定位，见 [browser-checks.txt](records/2026-10-27-preview/browser-checks.txt) 与[截图](records/2026-10-27-preview/preview-overlap.png)。
- 仅新增只读预览服务，未执行迁移、seed、提交或推送，未修改老师原目录；全仓测试本轮未重跑。

## 2026-10-28：第六轮，接通原平台开发环境

### 1. 范围与环境

- 用户要求接通数据库，随后明确允许使用 Docker。仅初始化 Rack 副本的开发环境，不扩展完整 Rack 功能。
- 本轮起始 HEAD 为用户已提交的 `a8c3cc1`，工作区干净；本轮没有执行 commit、push 或修改 remotes。
- Docker Desktop Linux 引擎可用。此前无容器；新栈名为 `ai-infra-rack-dev`，数据卷、数据库名和端口独立于原目录。
- 先检查过免 Docker 路径并下载 PostgreSQL/PostGIS 官方压缩包，但没有解压、安装、初始化或注册本机数据库服务；改用 Docker 后删除本轮这两个不再需要的下载文件。

### 2. 实际修改

- 新增 [compose.rack.yaml](compose.rack.yaml)：仅本机端口，PostGIS 与 RustFS 固定镜像摘要、独立卷。原 `compose.yaml` 未修改。
- 原 MinIO 镜像拉取返回 401；RustFS 1.0.4 通过既有 S3 驱动工作，不修改存储业务接口。
- 新增 [.env.rack.example](.env.rack.example)、[初始化助手](scripts/rack-setup.mjs) 和 `npm run rack:setup`；生成随机本地凭证，拒绝覆盖已有 `.env` 或用环境变量将初始化指向其他栈。
- `dev-stack.mjs` 支持选择 Compose 文件，输出不再打印硬编码的示例凭证。
- `dev.mjs` 直接调用 npm 的 Node 入口以兼容 Windows，按所拥有的进程树停止子进程；按配置同时启动本地合成瓦片。
- API 支持可选 `HOST`，本副本配置为 `127.0.0.1`；默认无该配置时保留原监听行为。
- 修复数据库启动中接受连接后提前断开会令探针不结束的问题；新增两个真实 TCP 回归测试。
- 增加 [运行说明](RACK_LOCAL_SETUP.md)，更新 AGENTS、README、总清单；没有改动前端页面样式或组件。

### 3. 已完成与验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 容器、建桶、六个迁移、两个组织/项目与设施样例 | 成功；初次导入每项目 5 个资产 | [setup.txt](records/2026-10-28-platform/setup.txt) |
| 对当前尚未编辑的样例重复初始化 | 迁移跳过 6 个，资产仍为 v1 unchanged，没有新增项目 | [setup-repeat.txt](records/2026-10-28-platform/setup-repeat.txt) |
| 两项目 project/scenario/facility/assets API | HTTP 200；分别 9/10 个容器、13/22 个几何、各 5 个资产 | [runtime-checks.txt](records/2026-10-28-platform/runtime-checks.txt) |
| 基本访问检查 | API 无凭证 401；另一组织身份读取设施 403 | 同上；不等于数据库 RLS 审计 |
| RustFS 与原 S3 驱动 | PUT/HEAD/GET、签名下载成功；临时对象已删除 | 同上 |
| 本地合成瓦片 | HTTP 200 image/png；不是地理底图 | 同上 |
| 实际浏览器 | 打开 Northern DC Campus，看到建筑、机房及公用接口几何 | [browser-checks.txt](records/2026-10-28-platform/browser-checks.txt)、[截图](records/2026-10-28-platform/platform.png) |
| Rack 测试 / 数据库探针回归 | 74/74、2/2 通过 | [rack-tests.txt](records/2026-10-28-platform/rack-tests.txt)、[probe-tests.txt](records/2026-10-28-platform/probe-tests.txt) |
| 应用停止与重启 | 发送中断后 8797/5193/8088 无残留监听，随后重启并重新检查运行 | [lifecycle.txt](records/2026-10-28-platform/lifecycle.txt) |

首次启动遇到数据库探针提前断开问题，修复后完成初始化；检查脚本曾误将资产列表当作分页对象，已按原数组 contract 修正并通过。
未重跑全仓测试/构建，首轮 16 个失败仅作为历史结果，不声称本轮全部消除或全仓通过。

### 4. 当前入口、协作及边界

- 原平台：http://localhost:5193/，先点击 Northern DC Campus；当前服务保持运行。
- 组员获得代码后按运行说明初始化自己的本地环境。页面布局未改；端口、服务配置和初始化命令有变化。
- `.env`、前端本地组织配置和 Docker 数据卷不会被 Git 传给组员；示例脚本可重建基础数据，用户后续编辑的数据不会自动同步。
- 本地数据库沿用初始化超级用户，不能据此声称 RLS 已验证；生产账号隔离仍待做。
- Assistant 没有配置 LLM，仍返回不可用；正式 Rack 编辑页面、Rack 存储/API/保存仍未实现。
- 后续选择一个 Rack 小闭环继续；本轮没有推进其余全部阶段，没有修改老师原目录。

## 2026-10-28：第七轮，空 Rack 方案持久化

### 1. 目标与实际修改

- 接通“创建空方案 → 数据库保存 → 按 ID 重新读取”的后端闭环，不展开完整 Rack 页面、编辑、算法或 Assistant。
- 本轮起始 HEAD 为用户已提交的 `9777b5f`。已有环境保留，没有重跑 seed 或改动示例业务行。
- 新增 [迁移 007](data-scripts/007_rack_plans.sql)：`rack_plans`、复合外键、项目内唯一创建 key、基础 CHECK、索引、启用并强制 RLS。
- 新增 [服务](apps/api/src/services/rack-plans.js)、[路由](apps/api/src/routes/rack.js)，在 API 中装配；API workspace 依赖已有 Rack 领域包，lockfile 只新增这一条 workspace 依赖，没有新增第三方包。
- 增加 `rack.read/write`、预设映射和客户端生成导出；普通编辑者可创建，viewer/org-admin 只读，未扩大 system-admin/showcase 的 Rack 内容访问。
- 新增 [API contract](RACK_API.md)、[集成测试](apps/api/src/tests/rack-plans.test.js)，更新基础设计、清单和运行说明。
- `.gitattributes` 固定生成权限目录为 LF，避免 Windows 检出使既有字节一致性测试再次失败。
- 上一轮通用运行检查改为对照磁盘迁移数量，新增迁移后仍可运行；原证据文本作为历史结果保留。

### 2. 设计选择与边界

- 方案 ID/时间/创建人由服务端产生；项目来自路径，状态固定为独立 `1 / DRAFT / NOT_RUN`，不接受客户端覆盖或非空 placements。
- 首个存储切片只允许 HALL + DRAFT 设施来源；数据库核对项目/场景/revision/容器，锁住来源并检查当前 ETag，然后插入。
- 没有复制机房边界或转换局部坐标；保存空方案不代表空间/容量可以验证。
- 同项目同 key 同规范化请求重放原方案，改变请求则 409；并发 key 锁与唯一约束避免重复创建。
- GET 与幂等重试重新读权威 ETag，报告 UNCHANGED/STALE/UNAVAILABLE；不改绑保存引用、不更新 Rack 版本，也不跟随 Facility 冻结 Rack 状态。
- 新表复合外键拒绝跨项目/场景来源，RLS 按事务项目限制读写。内部服务仍要求调用入口先授权。
- 来源容器删除因引用被阻止；完整解绑/归档与 Facility 删除错误交互仍待后续设计。冻结输入 checksum、机柜存储、修改并发、列表/分页、完整审计与 UI 都未实现。

### 3. 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 现有本地库升级 | 007 成功，旧 6 个迁移跳过 | [migrate.txt](records/2026-10-28-rack-persistence/migrate.txt) |
| 独立空库迁移与重复执行 | 7 个全应用，再执行 7 个全跳过；仅删除本检查创建的独立临时库 | [migration-checks.txt](records/2026-10-28-rack-persistence/migration-checks.txt) |
| Rack API/数据库测试 | 10 通过、0 失败、0 跳过；覆盖真实 FK、普通非 owner/非 superuser 的 RLS、权限、过期和并发来源更新 | [rack-api-tests.txt](records/2026-10-28-rack-persistence/rack-api-tests.txt) |
| RBAC 包回归 | 72 通过、0 失败、0 跳过，含数据库 catalog/preset 一致性和客户端一致性 | [rbac-tests.txt](records/2026-10-28-rack-persistence/rbac-tests.txt) |
| Rack 领域回归 | 74 通过、0 失败、0 跳过 | [rack-tests.txt](records/2026-10-28-rack-persistence/rack-tests.txt) |
| 真实运行 API + Vite 代理 | 创建 201，viewer 读取 200，同 key 重试 200，viewer 写/异组织读 403，旧来源 409；临时方案已按唯一 key 清理 | [live-api-checks.txt](records/2026-10-28-rack-persistence/live-api-checks.txt) |
| Web 构建 | 成功；保留原 esbuild/oxc 配置提示和较大 bundle 提示 | [web-build.txt](records/2026-10-28-rack-persistence/web-build.txt) |

初次测试文件有括号语法错误，修正后运行；首次真实 API 检查恰逢开发 watcher 重启出现代理连接拒绝，等待服务恢复后重跑通过。
以上是针对改动的验证；没有重跑全仓测试，也不宣称第一轮全部基线失败已修复。本地 API 仍用初始化数据库用户，新表的普通角色 RLS 测试不等于平台全量数据库权限审计。

### 4. 下一步与操作约束

- 先补方案列表与工作区创建/查看入口；随后独立处理真实几何输入、机柜编辑和保存。
- 当前平台外观未变；正式 Rack 页仍占位，空方案 API 不能当成完整机柜布局保存。
- 只修改 Rack 副本；没有 commit、push 或改变 remotes，老师原目录没有改动。

## 2026-10-28：第八轮，平台 Rack 空方案工作区

### 1. 范围与起点

- 用户同意将上一轮空方案后端接到平台：方案列表、选择 HALL 创建空方案、查看并刷新重读。
- 起始 HEAD 为用户已提交的 `fdc974c`，工作区干净。仅修改 `AI-INFRA-Rack` 副本；没有 commit、push 或修改 remotes。
- 保持现有独立 Docker 栈和业务数据，没有新增迁移，也没有重跑 setup/seed。

### 2. 实际修改与决策

- [Rack service](apps/api/src/services/rack-plans.js) / [路由](apps/api/src/routes/rack.js)：新增 rack.read 保护的 GET 列表，可按场景/来源 revision 过滤，默认 20、上限 50。
- 采用 `created_at DESC, plan_id DESC` 的 keyset 分页；时间与 cursor 都在 SQL 内比较，避免 JS 毫秒转换丢掉 PostgreSQL 微秒。cursor 查询也受项目与同过滤范围限制。
- [RackSurface](apps/web/src/rack/RackSurface.jsx)：替换原 Rack 占位页，展示真实列表、创建表单和保存详情；沿用平台 token 样式，窄窗口上下排列。
- [API client](apps/web/src/api/client.js) 增加列表/详情/幂等创建与取消信号；Facility 读取也可取消。复用平台当前身份桥，不单独构造认证路径。
- 入口与页面检查 rack.read，写操作检查 rack.write；Facility 读权限单独检查。后端 guard 仍是授权边界。
- 工作区增加按 tab 更新 routeState 的入口，重新点击已有工具保留原路由。Rack 表单、所选方案和待确认创建意图随工具标签保留；未保存表单接 dirty 关闭/上下文切换保护。
- 提交时先记录精确 body 与 UUID key；结果不确定时锁定输入并用同 key 重试，明确拒绝则允许修正。读取会中止并忽略卸载后的旧响应。
- 详情明确显示 NOT_RUN、空 placements、保存/当前来源 ETag 和变化原因。没有把 Facility 来源未变化当成 Rack 验证通过。
- 新增 [操作说明](RACK_WORKSPACE.md)，更新 API、基础设计、清单、运行说明和 README；仅勾选空方案范围的实际完成项。

### 3. 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Rack API / 真数据库 | 12 通过、0 失败、0 跳过；新增分页/同时间排序/过滤/权限/参数上限与来源变化 | [rack-api-tests.txt](records/2026-10-28-rack-ui/rack-api-tests.txt) |
| Web Rack 状态/渲染、客户端、registry、open-views | 37 通过 | [web-tests.txt](records/2026-10-28-rack-ui/web-tests.txt) |
| Web shell/toolbar/导入边界/权限客户端/上下文/项目入口回归 | 73 通过 | [web-shell-tests.txt](records/2026-10-28-rack-ui/web-shell-tests.txt) |
| Web 构建 | 成功；沿用既有 esbuild/oxc 与较大 bundle 提示 | [web-build.txt](records/2026-10-28-rack-ui/web-build.txt) |
| 实际浏览器 | 创建、保留未保存表单、dirty 关闭提示、整页刷新重读相同 ID、viewer 只读均验证 | [步骤](records/2026-10-28-rack-ui/browser-checks.md)、[截图](records/2026-10-28-rack-ui/platform.png)、[详情](records/2026-10-28-rack-ui/detail.png)、[viewer](records/2026-10-28-rack-ui/viewer.png) |
| 演示方案 SQL / API 一致性 | 数据库只有该 ID 一条；列表/详情/viewer 响应一致 | [只读检查](records/2026-10-28-rack-ui/check-saved-demo.mjs)、[输出](records/2026-10-28-rack-ui/saved-demo-checks.txt) |

测试命令分别为 `node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js`、证据文件首行记录的两组 `npm run test --workspace @ai-infra/web -- ...`、`npm run build --workspace @ai-infra/web`。
本轮开发过程中，分步保存 App/provider 的 HMR 曾出现临时旧绑定错误；完整代码写入并重载后页面与回归通过。没有重跑全仓测试，也不宣称原始基线失败全部修复。

### 4. 保留数据、限制与下一步

- 有意保留本机方案 `Rack UI demo — Hall A1`，ID `3abd796d-461a-45f6-a0ce-ced7bce99020`；没有添加到 seed，组员需自行创建。
- 整页刷新沿用平台行为回到项目列表，重新进入 Rack 能读数据库；没有自动恢复工作区或跨重载保存未提交表单/创建意图。
- 未做浏览器断网后“服务器提交成功但响应丢失”的故障注入；幂等接口已有真实并发/重放测试，UI 保留重试意图，但仍需以后验证该端到端故障路径。
- 没有真实房间几何/局部坐标、机柜编辑和存储、设备/容量、优化、Rack Assistant 或正式验证；只完成本轮空方案闭环。
- 下一小步应先确认真实 HALL 几何到米制局部输入的 contract，再做最小机柜编辑；完整性能和生产认证仍待后续。
- 没有改老师原目录或执行任何 Git 提交/推送操作。

## 2026-10-28：第九轮，绑定机房的只读米制平面图

### 1. 范围与起点

- 用户同意先接真实 HALL 几何和只读平面图，不展开机柜编辑/保存。
- 起始 HEAD 为用户已提交的 `743b57e`，工作区干净。继续仅修改 `AI-INFRA-Rack`；没有 commit、push、修改 remotes 或老师原目录。
- 使用已有 Docker 开发栈、007 表和演示方案；没有新增迁移或重跑初始化/seed。

### 2. 实际修改与设计

- [领域显示转换](packages/rack/src/room-view.js)：只接受显式匹配的 WGS84 UTM 米制 SRID/CRS，平移为局部坐标。外环 min easting/min northing 作为原点，网格东/北轴，不旋转、简化或用包围框替代 Polygon。
- 凹形与内环保留；Polygon 净面积扣除孔洞。限制 4096 点、64 环、每轴 10 km，其他 CRS、3D、非法/退化/超限数据明确拒绝。
- [Rack service](apps/api/src/services/rack-plans.js) 新增只读 roomView，同条 SQL 的 MVCC 快照核对保存来源 ETag/生命周期并读取唯一 HALL 边界；多候选不自动选择，来源过期不返回当前边界代替历史几何。
- [路由](apps/api/src/routes/rack.js) 新增 `GET plans/:planId/room-view`，原 guard 检查 rack.read 后再次检查 facility.read；自定义 Rack-only 角色不能通过该路径获得 Facility 几何。
- [RackRoomView](apps/web/src/rack/RackRoomView.jsx) 在方案详情前部显示 SVG 平面图、网格、米制比例尺、网格北向、范围与面积。支持按钮/滚轮缩放、拖动/键盘平移和 Fit room；原方案元数据收在 Saved plan details。
- 前端沿用身份客户端、取消/忽略旧请求，核对响应的方案版本与保存来源；不写数据库、不推进 Rack 状态。来源审核和合成样例属性明确可见。
- 新增 [平面图 contract](RACK_FLOORPLAN.md)，更新 API、工作区、基础设计、运行说明、清单和 README。

### 3. 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Rack 领域包 | 80 通过（原 74 + 新 6），0 失败/跳过 | [domain-tests.txt](records/2026-10-28-rack-floorplan/domain-tests.txt) |
| 真数据库/API | 16 通过（原 12 + 新 4），0 失败/跳过；含凹形/孔洞、变化来源、非法/多边界/超限、独立 Facility 权限 | [api-tests.txt](records/2026-10-28-rack-floorplan/api-tests.txt) |
| Web 相关回归 | 53 通过；均匀缩放、Y 轴、锚点缩放/平移、内环路径、单位/来源、API 编码取消、shell 与导入边界 | [web-tests.txt](records/2026-10-28-rack-floorplan/web-tests.txt) |
| Web 构建 | 成功，保留既有 esbuild/oxc 与大 bundle 提示 | [web-build.txt](records/2026-10-28-rack-floorplan/web-build.txt) |
| 实际运行 API 与数据库对照 | 顶点逐个符合投影坐标减原点；面积与 PostGIS 差 < 1e-6 m²；admin/viewer 200、其他组织 403；原方案行未改 | [脚本](records/2026-10-28-rack-floorplan/check-live-room.mjs)、[输出](records/2026-10-28-rack-floorplan/live-checks.txt) |
| 浏览器 | 原方案图面、按钮/滚轮缩放、指针/键盘平移、复位、刷新重读和整页重开通过 | [步骤](records/2026-10-28-rack-floorplan/browser-checks.md)、[图面](records/2026-10-28-rack-floorplan/floorplan.png)、[来源](records/2026-10-28-rack-floorplan/source.png) |

命令：`npm run test --workspace @ai-infra/rack`；`node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js`；Web 证据首行列出的定向 vitest；`npm run build --workspace @ai-infra/web`；`node --env-file=.env records/2026-10-28-rack-floorplan/check-live-room.mjs`。
初次新增来源状态测试误写了数据库不存在的 FROZEN 枚举，按平台 VALIDATED 状态修正后通过；React SVG title 多节点提示也已修正，最终测试无该提示。
没有重跑全仓测试，不宣称原始基线问题全部修复；未在浏览器做凹形/孔洞夹具展示或故障注入。

### 4. 当前边界与下一步

- 演示图源自现有 Facility 合成样例，不是实测工程图。UTM 是网格米，未校核地面距离/投影误差，现有配准审核 NOT_RECORDED；图面只读不等于工程有效。
- 机房 Polygon 没有持久化为方案输入快照；设施变更后阻止显示，显式重绑定/恢复历史几何仍待做。已打开图面通过刷新/重开复核来源，不是实时更新。
- 障碍物完整性 UNKNOWN，Rack 验证 NOT_RUN。现有矩形空间规则不适用于任意实际 Polygon，本轮没有将外包框当作可用区域或调用这些规则验证实际机房。
- 下一小步先设计固定输入/重绑定与 Polygon 包含/碰撞 contract，再推进最小机柜放置和持久化。设备容量、优化与 Rack Assistant 仍未实现。
- 没有改动演示方案、设施边界或 ETag；测试仅创建并清理自己的临时夹具。用户的演示方案和 Git HEAD 保留。

## 后续记录格式

每轮追加一个日期标题，至少写清：

1. 目标和范围；
2. 实际修改及文件链接；
3. 设计选择和适用边界；
4. 验证命令及结果；
5. 遗留问题与下一小步；
6. 是否执行提交/推送（默认不执行）。
