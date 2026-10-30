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

## 2026-10-28：第十轮，固定输入、Polygon 检查与机柜编辑保存

### 1. 范围与起点

- 用户同意一次推进较完整增量：固定机房输入 → Polygon 检查 → 型号/放置持久化 → 添加/移动/旋转/锁定/删除 → 保存重读与并发/权限验证。
- 起始 HEAD `db57805`（Platform Rack Workspace Initial Visualization），工作区干净。仅在 `AI-INFRA-Rack` 副本工作，没有 commit、push、改 remotes 或写老师原目录。
- 继续使用已运行的隔离开发栈；新增并应用 008 迁移，之前 7 个跳过，没有重跑 setup/seed、重置卷或替换现有演示数据。

### 2. 实际修改与关键决策

- [迁移 008](data-scripts/008_rack_layout.sql)：机柜型号、每方案固定 Polygon 快照、机柜实例、成功写命令记录；方案版本从固定 1 扩展为 >=1，新增最近修改人/时间。新私有表启用并强制项目 RLS，复合外键防跨项目引用。
- 型号目录提供两种 ASSUMED 演示尺寸，容量均未知。没有型号写 API，不将假设规格当厂商认证；修改规格以后需新 ID。
- [领域规范化](packages/rack/src/edit-layout.js)：最多 256 柜、严格字段、服务端目录派生占地、去重 ID、坐标/方向校验。已存锁定柜必须先单独保存解锁，再改变位置/方向/型号或删除。
- [方案服务](apps/api/src/services/rack-plans.js)：新方案在同事务自动捕获受支持的唯一边界；旧方案保留显式捕获。原列表/详情返回真实版本和已存 placements，不再固定为空方案。
- [布局服务](apps/api/src/services/rack-layout.js) 与 [路由](apps/api/src/routes/rack.js)：layout GET、snapshot POST、check POST、layout PUT。读取图面/check 需 rack.read + facility.read，捕获/保存需 rack.write + facility.read，复用原身份/guard。
- Polygon 规则使用 PostGIS 的 ST_Covers、内环 ST_Intersects、柜间内部 ST_Relate；局部坐标显式设 SRID 0，不被 GeoJSON 默认的 WGS84 标签误解释。不用包围框或仅角点判定完整占地。
- 外墙接触允许、孔洞接触拒绝、柜边接触允许、正重叠拒绝；无额外 epsilon。只检查 Polygon 包含/孔洞/柜间重叠，障碍 UNKNOWN、方案 NOT_RUN。维护空间、通道、设备、容量与工程精度未检查。
- 写操作锁方案行，要求 If-Match 和 UUID key；成功事务整体替换 placements、推进版本、记录 hash。失败回滚；同请求重试先恢复成功命令，返回当前布局及原 applied_version；不同意图复用 key 拒绝。
- 写时锁住 Facility ETag/revision 并复查；来源改变保留固定快照，但新写阻止。没有自动替换旧图、修改 Facility 或实现重绑定。
- [编辑器](apps/web/src/rack/RackEditor.jsx) 接 [工作区](apps/web/src/rack/RackSurface.jsx)、[图面](apps/web/src/rack/RackRoomView.jsx)：选择型号、添加、指针拖动/数值编辑、四方向、锁定、删除、清单/诊断定位与高亮、前边粗线、保存/放弃/重读。
- 草稿与精确保存意图存在 tab routeState；切工具保留、dirty 关闭/上下文保护及 beforeunload。异步检查 debounce/取消并按 body 绑定结果，结果不确定时保留 key/body 禁止修改，支持同 key 恢复，即使刷新后基础版本/来源改变也保留重试入口。
- 新增根目录 [RACK_LAYOUT.md](RACK_LAYOUT.md)，更新 API、操作、坐标、基础设计、运行、README 和清单；没有宣称设备/容量或整个阶段完成。

### 3. 验证与证据

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| Rack 领域包 | 83 通过、0 失败/跳过；含严格编辑输入、型号归属、锁定规则 | [domain-tests.txt](records/2026-10-28-rack-editor/domain-tests.txt) |
| 真数据库/API | 26 通过、0 失败/跳过；包含/孔洞/凹口桥接、贴边/重叠/旋转、原子失败、保存读取、同 key 并发重放、不同 writer 412、后续版本重放、来源并发更新、锁定、独立 Facility 权限、新表 RLS 读写 | [api-tests.txt](records/2026-10-28-rack-editor/api-tests.txt) |
| Web 定向回归 | 57 通过；编辑草稿/显示几何/异常输入、客户端版本头/身份/取消、原图面/详情/shell/导入边界 | [web-tests.txt](records/2026-10-28-rack-editor/web-tests.txt) |
| Web build | 成功；保留既有工具提示和 >500 kB bundle 提示 | [web-build.txt](records/2026-10-28-rack-editor/web-build.txt) |
| 迁移 | 本机 008 成功、旧 7 跳过；随机临时空库全 8 首次应用，重复全跳过无漂移，清理仅该临时库 | [本机迁移](records/2026-10-28-rack-editor/migrate.txt)、[脚本](records/2026-10-28-rack-editor/check-migration.mjs)、[输出](records/2026-10-28-rack-editor/migration-checks.txt) |
| 实际浏览器 | 添加、冲突禁存、位置/旋转修正、锁定/解锁限制、拖动、工具切换保留、dirty 关闭、临时柜删除、整页重进 v4 | [步骤](records/2026-10-28-rack-editor/browser-checks.md)、[图面](records/2026-10-28-rack-editor/layout.png) |
| 实际运行 SQL/API 对照 | v4、2 柜、固定快照/坐标一致；admin/viewer 200、另一组织 403；旧 v1 demo 仍无快照/机柜 | [脚本](records/2026-10-28-rack-editor/check-live-layout.mjs)、[输出](records/2026-10-28-rack-editor/live-checks.txt) |

命令：`npm run test --workspace @ai-infra/rack`；`node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js`；Web/build 命令见对应证据首行；`node --env-file=.env records/2026-10-28-rack-editor/check-migration.mjs` 与 `check-live-layout.mjs`。

开发验证中修正两项测试夹具问题：比较机柜数组时原地 sort 意外改变“精确重试”请求，已改为 toSorted；临时 HTTP server 端口复用时碰到旧 keepalive socket，测试客户端关闭连接避免跨夹具复用。最终 26 项通过。还修正了暂时清空数字输入时的非法 SVG 坐标，以及结果不确定后版本变化仍需允许精确重试的 UI 路径。
仅运行上述范围，未重跑全仓，不宣称原基线全部修复；没有进行浏览器断网响应丢失故障注入或完整性能实验。

### 4. 保留数据、边界与下一步

- 保留本机 `Rack editor demo — Hall A1`，ID `24b5422e-8206-4a76-bdf5-9f7e93a05aac`，v4，A01 locked、A02 90°/已拖动。图面支持继续编辑，当前无未保存草稿。
- 原 `Rack UI demo — Hall A1` 未捕获或更改；没有将个人演示写入 seed，组员拉代码、迁移并自行创建方案。
- 合成 Facility / 假设型号 / NOT_RECORDED 配准 / UNKNOWN 障碍 / NOT_RUN 均如实保留。当前可保存的空间布局不等于完整工程规划。
- 未做设备与 U 位/重量/电力/冷却、障碍/禁放区、前后维护净距/通道、布局算法/候选、Rack Assistant、正式验证/发布、历史恢复或完整审计。全局 Assistant 未配置 provider 的既有状态没有改动。
- 版本冲突当前保留草稿并让用户重读/放弃，没有自动合并；不确定保存跨工具切换保留意图，整页重载未保存意图不保证恢复。
- 固定快照仅可通过当前 API 创建一次；源变化后的显式重绑定、命令历史保留限额、生产最小权限及正式性能分析待做。
- 下一步先完成障碍/禁放区和维护净距的输入/规则，再推进设备与容量闭环，随后算法、候选、Assistant 和课程材料。
- 全部工作留在本地，未执行 commit/push 或改 remotes；老师原目录未修改。

## 2026-10-28：第十一轮，规划禁放区与前后维护净距

### 1. 范围与起点

- 承接上一轮可保存机柜编辑，只推进规划矩形禁放区、前后维护距离、图面与后端保存检查；不展开设备、算法或 Assistant。
- 起始 HEAD `51bee42`，工作区干净。只修改 `AI-INFRA-Rack`，没有 commit、push、改 remotes 或改老师原目录。
- 使用现有隔离开发栈，应用 009；旧 8 项迁移跳过，没有运行 setup/seed 或重置数据卷。

### 2. 实际修改与设计

- [009 迁移](data-scripts/009_rack_spatial_constraints.sql) 为 rack_plans 增加 JSONB spatial_constraints，沿用强制 RLS；默认 UNKNOWN / ASSUMED / 空障碍 / null 净距，旧方案版本、快照和机柜保留。
- [领域规则](packages/rack/src/constraints.js) 严格规范化来源、覆盖声明、最多 64 个轴对齐矩形和净距。障碍边长至少 0.001 m，净距为 0 或 0.001–10 m；拒绝极小正值避免浮点退化。
- [布局服务](apps/api/src/services/rack-layout.js) 在原 Polygon 检查中增加障碍包含/孔洞、柜与障碍、维护带与房间/孔洞/其他柜/障碍检查。前方为 -local Y，四方向旋转，维护带无侧向扩展，允许带间共享。外墙接触允许、孔洞和障碍接触拒绝、柜实体与带相切允许。
- 约束与机柜同事务/独立版本保存，复用来源锁、If-Match、UUID key 和权限；旧客户端省略 constraints 保留已存值，显式 null 拒绝。失败不会部分保存。
- 报告增加 obstacleIds、side、障碍数、维护带数与来源。无冲突但 UNKNOWN 或净距 null 时 INCOMPLETE；声明完整且明确净距后可 CHECKED_SCOPE_CLEAR，仍不代表整体工程通过，NOT_RUN 保留。
- [约束面板](apps/web/src/rack/RackConstraints.jsx) 支持来源、覆盖声明、净距开关/数值、障碍增删/数值编辑/定位；[图面](apps/web/src/rack/RackRoomView.jsx) 增加前后虚线带、障碍块和冲突高亮；检查结果绑定整份草稿，旧结果不能放行保存。
- 新增根 [RACK_CONSTRAINTS.md](RACK_CONSTRAINTS.md)，同步布局、API、工作区、基础设计、运行、README 与总清单；只勾选本轮有证据的矩形障碍和前后净距。

### 3. 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 领域包 | 89 通过，0 失败/跳过 | [domain-tests.txt](records/2026-10-28-rack-constraints/domain-tests.txt) |
| 数据库/API | 32 通过，0 失败/跳过；含持久化/省略兼容/幂等/回滚、孔洞/凹口、四方向、相切、零/未知、共享带、侵入与权限 | [api-tests.txt](records/2026-10-28-rack-constraints/api-tests.txt) |
| Web 定向回归 | 62 通过，含约束输入、草稿/显示、原图面、客户端与 shell/导入边界 | [web-tests.txt](records/2026-10-28-rack-constraints/web-tests.txt) |
| Web build | 成功；保留原有工具及 >500 kB bundle 提示 | [web-build.txt](records/2026-10-28-rack-constraints/web-build.txt) |
| 迁移 | 本机 009 成功；独立临时空库 9 项首次应用、重复全跳过，清理仅该临时库 | [migrate.txt](records/2026-10-28-rack-constraints/migrate.txt)、[脚本](records/2026-10-28-rack-constraints/check-migration.mjs)、[结果](records/2026-10-28-rack-constraints/migration-checks.txt) |
| 实际浏览器 | 禁放区/维护冲突禁存、诊断定位、修复保存 v2、整页重开重读通过 | [步骤](records/2026-10-28-rack-constraints/browser-checks.md)、[冲突](records/2026-10-28-rack-constraints/conflict.png)、[图面](records/2026-10-28-rack-constraints/layout.png) |
| 运行 SQL/HTTP 对照 | 快照、全精度位置与约束一致；viewer GET/check 200，另一组织两项 403；旧 v4/v1 及 Facility ETag 保留 | [脚本](records/2026-10-28-rack-constraints/check-live-constraints.mjs)、[结果](records/2026-10-28-rack-constraints/live-checks.txt) |

复现命令：`npm run test --workspace @ai-infra/rack`；`node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js`；Web 定向命令见证据首行；`npm run build --workspace @ai-infra/web`；`node --env-file=.env records/2026-10-28-rack-constraints/check-live-constraints.mjs`。迁移探针同目录 check-migration.mjs。

仅运行表内范围，没有重跑全仓，不宣称原平台基线全部通过。开发期间 watcher 重启曾造成暂时 502，重试恢复；未做浏览器断网或响应丢失故障注入。

### 4. 保留数据、限制与下一步

- 新演示 `Rack constraints demo — Hall A1`：`88e1821b-e8fe-49ce-ba9e-ecfda6925c77`，v2，两柜、一个 1×1 m 假设禁放区、前 1 m / 后 0.5 m；页面已重开验证，无未保存草稿。旧演示 v4/v1 保留。
- 来源仍为合成 Facility、假设规格和规划输入；配准 NOT_RECORDED、整体验证 NOT_RUN。DECLARED_COMPLETE 仅是本次规划假设的声明，不表示已调查真实机房。
- 障碍仅轴对齐矩形，未接权威障碍来源；共享维护空间不保证同时维护。侧面净距、连续通路/冷热通道、施工容差、设备/U 位/重量/电力/冷却仍未实现。
- 重绑定、布局算法、候选应用、Rack Assistant、正式验证/发布、完整审计和性能实验仍待做。复杂度与输入规模边界见空间约束文档，不能当吞吐量承诺。
- 下一小步建议设备规格、U 位分配和容量的最小闭环，然后再做自动布局与 Assistant。所有改动保持本地，未 commit/push。

## 2026-10-28：第十二轮，设备上架、U 位与每柜容量假设

### 1. 范围与起点

- 用户同意继续上一轮建议的“设备能上架、能检查、能保存、图上能看到”闭环；本轮不展开自动布局、Assistant 或正式容量服务。
- 起始 HEAD `ab5575a`，工作区干净，上一轮已由用户提交。继续只改 `AI-INFRA-Rack`，没有 commit/push、改 remotes 或写老师原目录。
- 沿用现有隔离开发栈，应用 010，旧 9 项跳过；不运行 setup/seed、不 reset 数据或卷。

### 2. 修改与关键设计

- [迁移 010](data-scripts/010_rack_equipment.sql) 在既有强制 RLS 的 rack_plans 增加 equipment JSONB；默认空清单/UNKNOWN/ASSUMED，不改旧方案版本、快照、机柜、空间条件。没有修改已应用的历史迁移。
- [领域 equipment](packages/rack/src/equipment.js)：严格规格/数量/来源输入，最多 512 设备、256 柜限值；方案内 UUID 唯一，安装只引用同请求布局机柜。未上架用 null rackId/startU 保留设备规格，不消耗柜资源。设备是方案内实例，没有独立共享型号库或全局资产身份。
- U1 在底部，闭区间占用，支持 1–100 U 的全宽单面设备；同柜区间重叠、超出型号柜高产生可解释诊断；不同柜独立。删除装有设备的机柜必须先卸架，柜的位置锁不限制设备分配。
- 重量、电力、冷却需求分别求和；未知需求和上限保持 null，显式 0 不代表无限。报告已知小计、总量/未知数、限值来源与状态；已知小计超限即报错，未知不能抵消已知错误。补偿求和和四机器 epsilon 表示误差比较避免小数相加误报，不是工程余量。
- 型号规格保持不变；可为每柜显式声明三维方案假设限值，记录 equipment 来源说明。未接正式容量预算或扣账，不改变 Facility。
- [布局服务](apps/api/src/services/rack-layout.js)：GET 返回 equipment，原 check/save body 可选 equipment，省略保留已存值，显式 null 拒绝。check 并列返回 equipmentReport；原空间 report 范围保留，状态独立。保存重算两份报告，以同一版本/来源锁/UUID key/事务更新所有数据；错误整体回滚，旧版本 412，设备冲突 422/RACK_EQUIPMENT_CONFLICT。
- [设备面板与立面](apps/web/src/rack/RackEquipment.jsx)：规格输入、选择柜/起始 U、迁移/卸架/移除、限值假设、容量表、可滚动柜内图与诊断选择。整份设备加入草稿、check/save body，只有当前 body 的两份报告才能放行保存；未保存内容沿用 tab dirty/重试保护。
- 新增根 [RACK_EQUIPMENT.md](RACK_EQUIPMENT.md)，同步 API、布局、工作区、基础、运行、README 和总清单；清单按实际范围细分，全局资产与正式容量仍未勾选。

### 3. 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Rack 领域包 | 101 通过、0 失败/跳过（含新增 12）；输入/未知/零/身份/区间/迁移/三维容量/小数边界与 512 清单 | [domain-tests.txt](records/2026-10-28-rack-equipment/domain-tests.txt) |
| 数据库/API | 37 通过、0 失败/跳过（含新增 5）；设备持久化、精确重试/旧版本/省略兼容、全字段回滚、迁移/卸架/删柜保护、权限/来源与原 RLS 回归 | [api-tests.txt](records/2026-10-28-rack-equipment/api-tests.txt) |
| Web 定向回归 | 67 通过；设备草稿隔离、输入与立面、容量未知/来源及已有空间、客户端、工作区与导入边界 | [web-tests.txt](records/2026-10-28-rack-equipment/web-tests.txt) |
| Web build | 成功；保留既有 >500 kB bundle 提示 | [web-build.txt](records/2026-10-28-rack-equipment/web-build.txt) |
| 迁移 | 本机 010 成功，旧 9 跳过；随机临时空库 10 项首次应用、重复全跳过无漂移，清理仅探针库 | [本机](records/2026-10-28-rack-equipment/migrate.txt)、[脚本](records/2026-10-28-rack-equipment/check-migration.mjs)、[结果](records/2026-10-28-rack-equipment/migration-checks.txt) |
| 浏览器 | 建柜/设备、超限/重叠/越界/清空 U、卸架保留、修复保存 v2、整页重开、容量与立面确认 | [步骤](records/2026-10-28-rack-equipment/browser-checks.md)、[容量冲突](records/2026-10-28-rack-equipment/capacity-conflict.png)、[U 冲突](records/2026-10-28-rack-equipment/u-conflict.png)、[最终图面](records/2026-10-28-rack-equipment/equipment.png) |
| 实际 SQL/HTTP | equipment 与数据库一致、快照保留；5U/90kg/3.3kW 汇总一致；admin/viewer GET、viewer check 200，另一组织 GET/check 403；旧三演示和 Facility ETag 保留 | [脚本](records/2026-10-28-rack-equipment/check-live-equipment.mjs)、[结果](records/2026-10-28-rack-equipment/live-checks.txt) |

命令：`npm run test --workspace @ai-infra/rack`；`node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js`；Web 定向命令见证据首行；`npm run build --workspace @ai-infra/web`；`node --env-file=.env records/2026-10-28-rack-equipment/check-migration.mjs` 和同目录 check-live-equipment.mjs。

没有重跑全仓，不宣称原平台基线全部通过。格式化/HMR 期间一次暂时 502，Retry layout 恢复并保留草稿；最后截图写盘成功，随后浏览器标签标记工具超时，已核对文件存在。不做浏览器故障注入或正式性能实验。

### 4. 保留数据、限制与下一步

- 独立演示 `Rack equipment demo — Hall A1`，ID `cb017b9b-ca11-483b-a5fd-c8f527195072`，v2。C01 为假设 42U 柜，GPU U35–38、ToR U41；5U 占用、37U 空余；90/500 kg，电力/冷却各 3.3/6 kW。整页重开后无未保存草稿。
- 设备报告在声明范围内 CHECKED_SCOPE_CLEAR；空间报告故意保持 UNKNOWN 障碍/未设净距的 INCOMPLETE，全局 NOT_RUN，配准 NOT_RECORDED，不将演示标成完整工程通过。旧三个演示 v2/v4/v1、设施来源 ETag 与原规格保留；没有把个人演示写入 seed。
- 尚无全局物理资产身份/不可变设备型号库、深度导轨兼容、双面/半宽安装、机房预算/正式容量分配、PDU/冗余、动态热仿真/楼板载荷。冷却为独立声明总需求，不从功率自动推导。
- 设备文档为方案内 JSONB、每次全量检查保存，沿用现有简化历史/审计；生产账户隔离、正式性能与大规模诊断需要后续工作。复杂度/输入上限见设备说明，不能当吞吐保证。
- 下一小步可做可解释的规则式机柜布局候选：只生成预览，重新检查后再应用；之后接 Rack Assistant。机房正式预算、依赖关系和通道规则仍需后续补齐。
- 所有更改保持本地，HEAD 未推进，未 commit/push，未修改老师原目录。

## 2026-10-28：第十三轮，本地 Catalog、型号版本绑定与主画布增强

### 范围与修改

- 起始 HEAD `d6484b4`、工作区干净；只修改 AI-INFRA-Rack。参考用户提供的老师截图，未导入线上数据、未写老师平台或原目录；不 commit/push、不改 remotes。
- 新增 [目录领域定义](packages/rack/src/catalog.js)、[规则示例](packages/rack/src/catalog-examples.js)：11 个组件版本、5 个组合型号；固定组件版本，机箱派生 U 高度，整机资源独立声明 ASSUMED，未知保留 null。没有把 PSU/冷板额定值当设备消耗或预算。
- 新增项目 rack.read 保护的 GET /rack/catalog，无写接口；前端 Catalog 从占位变为 Models / Technologies / Rule examples，支持筛选、组合清单、字段来源与真实规则报告。目录为随代码发布的只读示例，不是外部同步、数据库目录服务或审批系统。
- 设备新增可选 catalogRef {modelId,version}；领域 normalize 在 check/save 核对精确型号及四项规格，拒绝伪造或回退 latest。UI 可从型号添加未上架设备，固定规格只读；显式 Detach 转自定义假设保留身份/安装。旧设备和省略兼容保留。
- 复用原 JSONB、If-Match、幂等 key、来源锁、原子事务和 RLS，没有新迁移，没有 setup/seed/reset。v1 定义指纹测试固定内容，变更需新版本并留存旧版本。
- 主画布新增 Expand map（浏览器 Fullscreen API，失败显示原因）、Fit racks、U/功率显示着色、障碍和维护带显示开关。已有机柜默认聚焦；隐藏图层不取消检查，颜色来自当前完整请求的报告。80% 是显示阈值，不是保存规则。原房间约 106×92 m，整房缩放时柜体很小，保留 Fit room 与局部聚焦两种查看方式。
- 新增 [六柜脚本](scripts/rack-catalog-demo.mjs)，只访问 localhost 且检查隔离栈配置，仅允许已知合成 Facility；通过正常 API 创建独立方案并检查/保存，重复不覆盖已有非空方案。脚本不适用于真实设施。
- 根目录新增 [RACK_CATALOG.md](RACK_CATALOG.md)，更新 README、基础设计和待办；原早期文档仍保留历史边界，以本轮补充为准。

### 验证与证据

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| Rack 领域 | 107 通过，0 失败/跳过；新增版本、规格防伪、未知与组合/示例测试 | [domain-tests.txt](records/2026-10-28-rack-catalog/domain-tests.txt) |
| 数据库/API | 39 通过，0 失败/跳过；新增目录授权、固定引用持久化/回放、伪造回滚/旧版本/转自定义 | [api-tests.txt](records/2026-10-28-rack-catalog/api-tests.txt) |
| Web 定向回归 | 最终 82 通过，10 文件；含 Catalog 渲染/客户端/草稿、着色/聚焦、原 Rack 与 shell/导入边界 | [web-tests.txt](records/2026-10-28-rack-catalog/web-tests.txt) |
| Web build | 成功，保留原 >500 kB 包大小及 esbuild/oxc 提示 | [web-build.txt](records/2026-10-28-rack-catalog/web-build.txt) |
| 独立演示 | 正常 API check/save 后 GET 精确相等；重复脚本保留 v2，不覆盖 | [创建](records/2026-10-28-rack-catalog/demo-create.txt)、[重复](records/2026-10-28-rack-catalog/demo-repeat.txt) |
| 旧数据/权限 | 复用 SQL/HTTP 检查，四个旧示例及 Facility ETag 保留；viewer 读/检查 200、另一组织 403 | [previous-demos.txt](records/2026-10-28-rack-catalog/previous-demos.txt) |

命令：npm run test --workspace @ai-infra/rack；node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js；Web 命令在证据首行；npm run build --workspace @ai-infra/web。没有重跑全仓、性能实验或本轮实际浏览器点击回归；前端验证为定向渲染/状态测试、构建和运行 HTTP。

### 本机数据、运行与限制

- 新方案 **Rack catalog demo — six racks**，ID `e446aafb-1846-4a69-af10-636fd50ba87c`，v2；6 柜、17 台型号设备、一个假设禁放区、前 1 m/后 0.5 m 维护带。空间 CHECKED_SCOPE_CLEAR；部分资源未知，设备 INCOMPLETE、整体 NOT_RUN。
- 原来四个示例保持不变。开始验证时本地服务已停，重新启动副本 npm run dev；日志在忽略的 .local-runtime/catalog-dev.log。Vite 在本机监听 IPv6 localhost，因此演示脚本使用 localhost；首次 IPv4 请求失败发生在任何写入前，修正后完成。
- 未做外部目录同步、目录编辑审批、全局硬件资产、正式预算、连续通道、候选、Assistant 或工程认证。仍以可解释布局候选为后续方向。
- 全部工作留本地，未执行 commit/push；老师原目录和线上平台未改。

## 2026-10-28：第十四轮，Rack 九分区结构与既有功能归位

### 范围与修改

- 用户要求像 Site 一样分区，先铺大致结构、后填细节。起始 HEAD `fe4db05`、工作区干净；只改 AI-INFRA-Rack，未 commit/push 或改老师目录/平台。
- 新增 [共同分区定义](apps/web/src/rack/rack-sections.js)，工具注册与 Rack 工作区统一消费。侧栏提供 Overview、Plans、Layout、Equipment、Constraints、Capacity、Candidates、Dependencies、Checks；保留原 rack.read 入口权限。
- 新增 [总览与结构页面](apps/web/src/rack/RackSections.jsx)：模块状态卡、真实所选方案/草稿摘要、候选四步流程骨架、真实 Facility 引用与正式依赖管理的待实现边界。没有假生成/假应用操作。
- [工作区](apps/web/src/rack/RackSurface.jsx) 增加跨分区方案选择，Plans 保留创建/分页/元数据，并可进入布局。原 overview 路由转为真正总览，原方案与草稿字段保留。
- [编辑器](apps/web/src/rack/RackEditor.jsx) 按分区展示已有主画布/机柜属性/设备/约束/容量/检查；保持同一实例和共享草稿，不因切页丢失选择、相机、未保存数据和精确重试请求。容量/设备/诊断使用同一设备组件的显示模式。
- 显式说明所有编辑分区一起保存；当前报告问题在其他分区也提示，可跳 Checks，不能通过隐藏问题面板绕过整份检查。Checks 为当前范围报告，整体 NOT_RUN 保留，不触发 Facility 验证/冻结。
- 新增根 [RACK_STRUCTURE.md](RACK_STRUCTURE.md)，更新操作、README、待办和本进展。没有后端、Schema、迁移或示例数据更改。

### 验证

- Web 定向 **100 通过、12 文件、0 失败**，覆盖新增导航/状态卡、九分区路由保留同一方案/dirty 草稿/精确请求及拒绝直接关 dirty 标签、设备/容量/诊断显示模式，以及既有 Rack、Catalog、客户端、shell、导入边界。证据：[web-tests.txt](records/2026-10-28-rack-sections/web-tests.txt)。
- Web build 成功，保留既有 esbuild/oxc 和 >500 kB 包大小提示；证据：[web-build.txt](records/2026-10-28-rack-sections/web-build.txt)。
- 本轮只改前端结构，未重跑领域/数据库 API 全套；没有浏览器控制工具，未做实际点击回归，不将静态渲染/状态测试写成浏览器验收。

### 遗留与下一步

- 目录/设备身份、空间、容量仍按已有有限范围工作；正式预算、硬件资产、连续通道、持久化验证、算法、候选应用和 Rack Assistant 未实现。
- Candidates/Dependencies 页面是可扩展结构；依赖页仅展示已保存输入，不是实时依赖图。后续先补输入追踪和影响分析，再做候选生成/预览/应用与 Assistant。
- 所有代码保持本地，未 commit/push、改 remotes 或修改老师原目录。

## 2026-10-28–29：第十五轮，Rack 专用导航和输入影响可视化

### 范围与实际修改

- 用户明确分区应适合 Rack，不照搬 Site，并要求加快推进。延续第十四轮未提交改动，HEAD 仍为 `fe4db05`；仅修改 AI-INFRA-Rack，没有 commit/push、改 remotes 或修改老师目录/线上平台。
- 分区顺序调整为 Overview、Plans、Inputs & impact、Rack layout、Space rules、Devices & U slots、Capacity、Layout options、Checks。保留所有 route functionId 和共享草稿机制；不是为对齐 Site 而添加模块。
- 新增 [RackInputs.jsx](apps/web/src/rack/RackInputs.jsx) 与 [rack-inputs.js](apps/web/src/rack/rack-inputs.js)：从编辑器已有布局、约束、设备、草稿和当前完整请求报告生成输入关系图；节点选择高亮下游，提供对应页面入口、真实 Facility/快照引用、精确目录版本和设备数量汇总。
- 比较最近读取的保存版与当前草稿，显示机柜、空间条件、设备和限值变化及保守检查影响；null/0/NaN 分别处理，版本冲突注明比较基准，来源状态明确是最近读取结果。整份保存仍由原后端复核权限、版本、来源和全部规则。
- 更新根 [结构](RACK_STRUCTURE.md)、[操作](RACK_WORKSPACE.md)、[总清单](RACK_PROJECT_TODO.md)，新增 [输入说明](RACK_INPUTS.md)。没有后端、迁移、数据库、目录或演示数据变更。

### 验证与证据

- Web 定向 **103 项通过、13 文件**；含输入影响路径、真实固定版本、未知/零/非法值变化、版本/来源警告及原导航/草稿/设备/空间/Catalog/shell 回归。[结果](records/2026-10-28-rack-inputs/web-tests.txt) 首行保留命令。
- Web build 成功，保留已有 >500 kB bundle 提示，[结果](records/2026-10-28-rack-inputs/web-build.txt)。未重跑后端/数据库/领域全套，不宣称全仓通过。
- 实际浏览器读取本机六柜/17 设备示例的来源与五类型号版本；节点选择更新下游；Edit → Layout 临时改名 → Inputs 识别共享草稿变化 → Discard 恢复，无 dirty 标记，保存版本仍为 v2。没有点击保存，原示例不变。[步骤与限制](records/2026-10-28-rack-inputs/browser-checks.md)。首次临时标签定位失效，换独立标签后完成；非业务失败。

### 边界与下一步

- 图表示现有数据消费关系，不是物理网络或机房图；机房主图仍在 Rack layout。变化提示包括元数据、列表重排，是保守提示而非精确增量规则计算；所有规则仍整份检查。
- 尚无持久化依赖历史、上游事件订阅、显式重绑定和 Network/Power/Thermal 跨工具关联。Layout options 保持 Planned，没有假生成/假应用功能。
- 下一步是有边界、可解释的布局候选预览，再逐步接安全应用和 Rack Assistant；这轮不同时扩展算法与后端。

## 2026-10-29：第十六轮，确定性布局规划、比较预览与草稿应用

### 范围和修改

- 用户授权接通主体算法及必要输入/检查，本轮完成已有机柜的重排闭环；继续在第十四/十五轮未提交变更上工作，HEAD 仍为 `fe4db05`，只改 AI-INFRA-Rack。未 commit/push、改 remotes 或修改老师目录/平台。
- 新增 [规划器](packages/rack/src/planner.js)：row-scan-v1 与 largest-first-v1 两种确定性贪心策略；锁定柜先固定，保留全部柜/设备身份和分配，网格/旋转可配置。明确有限搜索失败不是无解证明；未放置对象保留原位但禁止选用候选。
- 新增 [PostGIS 批次适配器](apps/api/src/services/rack-planner-geometry.js)，复用实际 Polygon/孔洞/障碍/双向前后维护策略，原 [布局服务](apps/api/src/services/rack-layout.js) 对每个完整候选再次做原空间与设备检查，错误不准选用。没有把包围框当房间几何。
- 新增只读 POST layout/options，需 rack.read + facility.read，服务读取保存版与固定输入，不接受自报设施/设备。校验版本、快照与来源，返回输入指纹、算法版本/参数、指标/报告、未放置原因及完整草稿 body。限制 64 可移动柜、两候选、每柜 2048/每候选16384 提议、128 批次、5 秒 SQL/批次间15秒时间预算。
- [Layout options](apps/web/src/rack/RackOptions.jsx) 现为实页：参数、现状/两候选比较、逐柜变化、图面预览、未放置与报告、勾选复核。通过 [草稿适配](apps/web/src/rack/rack-options-state.js) 检查归属/基准/来源/无现有草稿后进入原共享草稿，再走原 Save layout。原权限、If-Match、源锁、锁定、UUID 幂等、全量规则和事务均保留。
- 候选只在当前编辑器内暂存，无迁移/候选表/新写入端点。原主图转草稿与放弃时新增 Fit racks，避免候选移到远处后旧相机看不到。当前整体验证仍 NOT_RUN。
- 新增根 [RACK_PLANNER.md](RACK_PLANNER.md)，同步 API、基础设计、结构、工作区、README 与清单，按本轮有限范围勾选算法和预览/应用项。

### 验证与证据

| 范围 | 最终结果 | 证据 |
| --- | --- | --- |
| Rack 领域 | 113 通过，0 失败/跳过；新增策略/重复性、锁定、异形尺寸排序、四方向维护、超大柜空网格、输入与搜索上限 | [domain-tests.txt](records/2026-10-29-rack-planner/domain-tests.txt) |
| 数据库/API | 43 通过，0 失败/跳过；新增只读性、来源/版本/权限、真实几何、精确重放、原子保存/幂等/旧版/锁定；32 组批次适配器与完整检查差分 | [api-tests.txt](records/2026-10-29-rack-planner/api-tests.txt) |
| Web 定向 | 107 通过，14 文件；候选转草稿复制与拒绝路径、客户端、原 Rack/Catalog/shell/边界 | [web-tests.txt](records/2026-10-29-rack-planner/web-tests.txt) |
| Web build | 成功；保留原 esbuild/oxc 和 >500 kB bundle 提示 | [web-build.txt](records/2026-10-29-rack-planner/web-build.txt) |
| 浏览器 | 生成两候选、比较/预览、复核禁用、两策略转草稿、自动聚焦、放弃恢复，无保存演示改动 | [步骤](records/2026-10-29-rack-planner/browser-checks.md)、[截图](records/2026-10-29-rack-planner/options.jpg) |
| 本机只读重放 | 6 柜/17 设备，两次候选精确相同；前后五个旧示例完整布局相等 | [脚本](records/2026-10-29-rack-planner/check-live-planner.mjs)、[摘要](records/2026-10-29-rack-planner/live-checks.txt)、[输入与结果](records/2026-10-29-rack-planner/live-results.json) |

命令：npm run test --workspace @ai-infra/rack；node --env-file-if-exists=.env --test apps/api/src/tests/rack-plans.test.js；Web 定向命令保留在证据首行；npm run build --workspace @ai-infra/web；node --env-file=.env records/2026-10-29-rack-planner/check-live-planner.mjs。

第一次 API 运行 43 项通过；并行记录时出现 5 项测试服务器的 `fetch failed`，没有规则断言失败；原始输出保留在 [失败记录](records/2026-10-29-rack-planner/api-tests-transient-fetch-failures.txt)，原因未确定。独立重跑最终 43 项全过，未用跳过或放宽断言掩盖。前端新增测试初次有括号语法错误，已修复，最终 107 项通过。没有重跑全仓或宣称平台全部基线通过。

### 初步表现、限制和后续

- 本机六柜样例两次端到端约 5.399 / 4.369 秒（当时并行跑回归）；每候选提交 9728 姿态，无未放置柜。现状柜体包围面积约23.92→15.84 m²，总中心搬动344.122 m；两策略因同尺寸/同顺序而相同，明确不是排序有效性的证明，也不是等量释放工程空间。
- 空间 CHECKED_SCOPE_CLEAR；未知设备资源保持 equipment INCOMPLETE，整体 NOT_RUN。生成/转草稿不写数据库，实际保存只在独立临时 API fixture 完成，五个旧演示与合成 Facility 保留。
- 当前是现有机柜的贪心重排；未实现设备自动装箱、新柜需求规划、连续通道、正式机房预算、持久化候选历史/独立审批凭证、生产并发限流/异步取消或全局最优。算法和时限不是工程认证或生产 SLA。
- 下一步可接 Rack Assistant 的真实查询/解释/生成候选工具，或补设备自动分配；本轮不混入这些功能。全部更改留本地，由用户决定提交。

## 2026-10-29：第十七轮，Rack Assistant工具接线与未分配设备自动上架

### 范围与实际修改

- 用户要求继续补需要的内容，本轮先完成Assistant只读工具接线；发现本机无模型配置后，用户明确“先不用配模型，先搞其他的”，因此继续补设备自动分配，没有配置模型或改`.env`。起始HEAD为用户当前的`25cbc9d`，全部更改留本地，未commit/push、改remotes或触碰老师目录/平台。
- [Rack Assistant适配器](apps/api/src/services/rack-assistant.js) 注册rack@1/guide及五个rack_工具：方案列表/读取、真实容量、原完整检查、原布局候选摘要。Host/HTTP/context/execution链路携带服务端校验的所选方案和Rack整数版本；入口与每次调用均需rack.read + facility.read。客户端dirty/版本仅作提示，不接受模型自报范围。
- [前端会话](apps/web/src/assistant/useAssistantSession.js) 根据活动工具和所选方案隔离会话；Rack不混入Facility选择/ETag/UI action/附件。Overview补真实范围和提问示例。没有聊天写入或自动把摘要放入地图；模型未配置时保留真实不可用错误。说明见 [RACK_ASSISTANT.md](RACK_ASSISTANT.md)。
- [纯领域分配器](packages/rack/src/allocator.js) 大U优先/稳定UUID/首次适配连续U，只处理未分配设备，保留已装设备、全部身份/型号/来源/限值和柜位置，排除锁定柜。三种资源及柜已有需求全部已知才尝试分配；未知、碎片、不足、无目标都有原因，可保留部分成功。上限128未分配/64目标柜/100U。
- 原 [布局服务](apps/api/src/services/rack-layout.js) 新增只读equipmentOptions：只读tenant事务、保存版本/来源/快照校验、领域分配、原PostGIS与设备完整复核，返回指纹/报告/原保存body，无迁移/新候选表。路由需两项read权限，普通保存仍需write并走原版本/幂等/来源锁和原子事务。
- [设备自动分配页](apps/web/src/rack/RackAllocation.jsx) 放在Devices & U slots，展示分配表、剩余原因、空闲U变化/三种容量、只读立面、明确复核，转同一共享草稿后保存。零新增或错误阻止选用，部分设备保留未分配不丢失身份；整体NOT_RUN不变。说明见 [RACK_ALLOCATION.md](RACK_ALLOCATION.md)。同步README、基础/结构/操作/API/设备文档和有证据的待办项。

### 验证与证据

证据目录：[records/2026-10-29-rack-assistant](records/2026-10-29-rack-assistant/)，具体命令见 [commands.md](records/2026-10-29-rack-assistant/commands.md)。

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| Rack领域 | 122通过、0失败/跳过；新增连续U/资源/未知/零/锁/部分/规模/输入不变 | domain-tests.txt |
| Assistant适配与Host投影 | 15通过、0失败/跳过；注册、授权、范围、分页、调用预算、摘要和真实orchestrator接线 | adapter-tests.txt |
| Assistant领域回归 | 84通过、0失败/跳过；沿用provider/registry/prompt/orchestrator机制 | assistant-tests.txt |
| 真实数据库/HTTP | 54通过、0失败/跳过；Rack与原Assistant API，跨项目/版本/来源、viewer只读生成、分配重复与原子保存 | api-tests.txt |
| Web定向 | 167通过，14文件；新分配客户端/复核/部分草稿、会话隔离及原Rack/Assistant相关回归 | web-tests.txt |
| Web构建 | 成功，保留已有esbuild/oxc和大于500kB bundle提示 | web-build.txt |
| 浏览器 | 真实生成/容量/立面/确认/共享草稿/放弃；无模型真实错误 | browser-checks.md、allocation-preview.jpg |
| 独立示例 | 新示例正常HTTP创建并保存v2；五个旧示例完整布局前后相等 | create-allocation-demo.mjs、demo-create.txt、allocation-demo.json |

初次适配测试stub未满足既有provider工厂的配置契约，补齐stub；无endpoint工厂500与启动后HTTP503区分记录，没有更改无模型产品行为。浏览器开发watch重启时一度502，刷新恢复。未跳过或放宽业务断言；没有运行全仓或宣称整个平台全通过。

### 本机状态、限制与下一步

- 新示例 **Rack allocation demo — unassigned devices**，ID `44b72453-8cf6-47ff-ab61-0d4c28c99c21`，v2，3柜/6设备/5未分配。建议新增3台，另外100U与重量未知两台保留未分配；C柜U1–14、70/100kg、6/6kW功率与冷却。所有规格为合成假设。
- 浏览器转草稿后完整检查完成、Save可用，但未保存演示；已Discard恢复初始v2、1台原安装/5未分配，无dirty。实际持久化在临时隔离fixture验证。候选比较保留在本地浏览器，方便用户复核。
- 用户明确不配模型；未声称真实模型自然语言对话或外部provider端到端通过。后续需要模型时再接入，不阻塞普通规划。聊天仍无修改/应用、实体定位或候选自动传地图。
- 自动分配不是全局装箱最优，也不重排已装设备；仍缺正式机房总预算/跨柜依赖、连续通道、工程级物理兼容、持久化验证/候选历史、大规模性能与生产限流。下一步优先补机房级预算输入/总需求对比和可复现性能实验，再整理汇报架构与演示，不以模块入口代替实现。
- 未执行任何commit/push，老师原目录与线上平台未改。

## 2026-10-29：第十八轮，机房功率/冷却假设预算与自动分配守卫

### 范围与实际修改

- 用户要求继续补缺项，沿用“暂不配置模型”。起始HEAD为cbe1615；仅改AI-INFRA-Rack，未commit/push、改remotes或触碰老师原目录/平台。
- 新增 [room-budget.js](packages/rack/src/room-budget.js)：严格ASSUMED来源与可空双限值、冻结输入、全柜已安装需求/完整库存需求、独立状态/剩余/未知与结构化超限。锁定柜需求计入；未分配仅作库存提示，不预扣安装预算。不是权威Facility容量服务。
- 原 [设备检查](packages/rack/src/equipment.js) 接入roomCapacity与原diagnostics；已知小计超限不被未知掩盖，普通保存422并原子回滚。原 [布局服务](apps/api/src/services/rack-layout.js) 同时兼容旧客户端equipment缺少roomBudget而保留已存值，显式null才关闭。预算和设备/布局同版本、权限/来源锁/幂等事务，无迁移和新端点。
- [分配器](packages/rack/src/allocator.js) 升级unassigned-first-fit-decreasing-v2，每次新增前检查全柜剩余预算；UNKNOWN_ROOM_BUDGET与ROOM_BUDGET_EXCEEDED解释保留未分配。布局重排候选完整复核同一预算，超限canStage=false。
- 新增 [Capacity机房卡片](apps/web/src/rack/RackRoomCapacity.jsx)：来源/功率/冷却限值、安装/库存总量、剩余/状态/诊断；编辑与现有共享草稿和完整检查绑定。Inputs识别预算变化；窄窗口表格横向滚动，避免末列逐字挤压。
- Assistant容量工具返回方案范围总量，单柜筛选不缩小机房范围；报告诊断设备ID最多20项并附总数/截断标识。没有配置模型或修改.env。
- 新增根 [RACK_ROOM_BUDGET.md](RACK_ROOM_BUDGET.md)，同步README、基础/结构/操作/API/设备/算法/Assistant说明与有证据的待办小项。历史轮次描述按当轮保留，以最新补充为准。

### 验证与证据

目录：[records/2026-10-29-rack-room-budget](records/2026-10-29-rack-room-budget/)，命令见 [commands.md](records/2026-10-29-rack-room-budget/commands.md)。

| 范围 | 最终结果 | 证据 |
| --- | --- | --- |
| Rack领域 | 135通过、0失败/跳过；全柜/单柜差异、锁定/库存、未知/零、浮点、严格schema、分配限额/部分结果/不变性 | domain-tests.txt |
| 数据库HTTP + 适配/投影 | 50+16=66通过、0失败/跳过；预算持久化/旧客户端保留、显式删除、权限/旧版本、422所有字段和命令回滚、只读候选/分配/普通保存、Assistant全柜口径与截断 | api-tests.txt |
| Web定向 | 171通过，15文件；预算控件/未知/非法值、共享草稿复制与请求、依赖影响和原Rack/Assistant回归 | web-tests.txt |
| Web构建 | 成功；保留既有大于500kB bundle提示 | web-build.txt |
| 真实浏览器 | 保存版2/3/1与库存5、编辑预算1超限且保存禁用、空白未知、Discard恢复无dirty的v2；窄视口检查 | browser-checks.md、room-budget.jpg |
| 独立本机示例 | 正常HTTP创建v2；2kW待装被预算阻止，1kW刚好可装；超限写入422，六个旧示例与新示例布局检查前后不变 | create-room-budget-demo.mjs、demo-create.txt、room-budget-demo.json |

第一次API运行时Docker Desktop未启动，数据库55532拒绝连接，50失败/15通过，原始结果保留api-tests-db-unavailable.txt；启动已安装Docker与原ai-infra-rack-dev栈后独立重跑66全过，没有跳过/放松断言。未迁移/seed/setup/reset或删卷。启动本地API8797/Web5193用于验收，未配置provider的警告符合用户决定。不是全仓通过声明。

### 本机示例、限制与下一步

- 新示例 **Rack room budget demo — shared power and cooling**，ID00afc319-b755-4ac7-9e11-d55bde7a283d，v2，3柜/4设备，其中2台已安装。功率/冷却需求各2、预算3、剩余1kW；总库存5kW。规格和预算均为合成假设，原六个示例保留。浏览器临时改动均放弃，未保存分配候选。
- 缺省预算保持旧设备检查的单柜范围，独立机房报告INCOMPLETE并保留未检查标识；显式启用但未知时算法不猜测。已安装范围CHECKED_SCOPE_CLEAR不等于所有库存能安装，整体validationState始终NOT_RUN。
- 未纳入同房间其他方案、机柜空载功耗、PUE/回路/冗余/降额、热仿真、楼板载荷。正式权威容量分配、跨方案并发预留和上游事件仍未实现，不能宣称工程可行。
- 下一步优先连续通道/访问连通检查、版本绑定验证记录，再做可复现性能/算法比较实验和汇报架构/API材料。真实模型按用户决定继续搁置。全部改动本地留给用户提交。

## 2026-10-29：第十九轮，多排机房演示与设备概览

- 仅在 AI-INFRA-Rack 本地工作，起始 HEAD 4b3b0bd；未 commit/push、修改 remotes、老师目录或平台，未配置模型。
- 新增 scripts/lib/rack-hall-demo.mjs 和 scripts/rack-hall-demo.mjs，以既有 Catalog、布局/设备/预算 schema 和普通 API 生成 32 柜、236 台安装、8 台待上架；24 锁定、8 可重排，安装功率/冷却各 240kW，预算各 246kW。用法和边界见 [RACK_HALL_DEMO.md](RACK_HALL_DEMO.md)。
- RackHallInventory.jsx 增加库存、按名称前缀分组、地图选柜联动、只读 U 位立面、设备/容量入口；RackRoomView 增加标签开关与缩放字号。
- 新方案完整机房演示 · 32柜 / 多排混合设备，ID 4b8f7bf3-9015-455f-8bc8-ef3520f0d748，v2；七个旧方案与源方案不变，重跑保留示例。候选未应用/保存。
- 新增领域场景测试 4 通过；Web 定向 50 通过（12 文件），构建成功；真实 HTTP 创建/保存/重读、分配和双策略试算通过。浏览器验证地图、颜色、标签、A01 三台 GPU 加 ToR 立面、分配与双候选。证据见 [本轮目录](records/2026-10-29-rack-hall-demo/commands.md)。未运行全仓测试。
- 自动上架新增 2 GPU，6 台保留并说明原因。布局两候选相同、8 柜移动、0 未放置、24 锁定柜不变；包围面积 120.84→1188.149m²，当前扫描算法不保证比手工更紧凑，不称为优化效果提升。
- 初次 Web 测试误计数立面容器 class，修正测试匹配后通过；初次脚本请求空响应，重试成功，原始日志保留。浏览器 checkbox 自动操作未生效，重新观察后通过原生点击确认。无放宽业务断言。
- 局部设备区与通道为合成假设，无连续访问/疏散/热仿真、网络连线、正式分区实体、权威全局容量或验证历史。后续优先通道连通、版本绑定验证、规模实验和汇报材料。

## 2026-10-29：第二十轮，点阵工作台、拖拽与对象 Inspector

- 用户强调汇报可视化，采用“主画布 + 右侧对象详情”，不扩展园区/建筑导航。仅本地 AI-INFRA-Rack，起始 HEAD ec71d17；未提交/推送或修改老师目录/平台，未配置模型。
- 新增 [RackWorkbench.jsx](apps/web/src/rack/RackWorkbench.jsx) 与 [workbench-view.js](apps/web/src/rack/workbench-view.js)：点阵背景、等比例机柜图形、设备区/全房自动适配、定位缩略图、负载颜色、禁放/维护图层、搜索、添加机柜、完整工作台演示模式。
- 机柜点击后右侧查看尺寸/坐标/方向、U与功率、真实柜内立面；服务器/交换机可点击查看型号版本、U区间、重量、功率与冷却。8 台待上架设备另有入口，未知与零区分。
- 拖动保留点击偏移并以 0.1/0.5/1m 吸附，松手一次更新原共享草稿，取消/丢失捕获取消视觉预览；方向键微调与右侧90°旋转。位置锁定继承保存版与草稿。原精确编辑放入折叠区。
- 原编辑器检查与保存按钮复用至工作台，演示模式同样能编辑/保存/放弃；权限、来源锁、版本、幂等重试和后端事务未更改。视口保留真实 Polygon/孔洞/米制坐标，没有按面积伪造矩形；点阵不是物理网格。
- 验证：Web 定向 56/13 文件通过，构建成功；新增6项覆盖坐标/留白/吸附/真实图形与对象区分。浏览器有效拖拽→检查通过可保存；重叠→RACK_PAIR_OVERLAP和维护带冲突、保存禁用；服务器/交换机/待上架详情正确。见 [证据](records/2026-10-29-rack-studio/commands.md)。
- 测试移动全部放弃，API重读仍为v2、32/236/8、D08原始位置；本轮未保存演示改动。初次直连API误用开发身份header返回401，使用既有Web代理正常读取；未改认证。SVG title警告修正后重跑无该警告。
- 窄屏详情移到下方；设备区只是显示范围，全房模式大房间中的机柜仍小。本轮没有无限画布/滚轮缩放、拖动设备换U、网络连线或工程验证。连续通道、正式验证历史和规模实验仍待后续。
- 根目录操作说明：[RACK_VISUAL_WORKBENCH.md](RACK_VISUAL_WORKBENCH.md)。未运行后端全套/全仓测试，不声明整个平台通过。

## 2026-10-29：第二十一轮，新用户操作闭环与旧示例清理

### 实际修改与适用范围

- 用户要求按新用户“新建→布置→删除”核查，并删除截图中的旧示例。本轮只在 AI-INFRA-Rack 工作，HEAD 为 a80b35e；没有 commit/push、修改 remotes、老师原目录/平台或配置模型。
- 新建成功自动进入布局；顶部增加机柜/设备/约束/容量/检查/方案管理步骤入口，保留原跨页共享草稿。创建事务捕获可用 Polygon，不另推进 v1；没有边界仍保留原空方案/显式 capture 路径。
- 新增 011_rack_plan_lifecycle.sql 的 deleted_at/deleted_by 与活动列表索引，已在本机隔离 rack_facility 应用；无 reset、seed、删卷或历史数据清空。组员已有环境需要 npm run migrate。
- 原方案服务/路由新增重命名、软删除、恢复；原命令表记录幂等请求，与布局共用方案行锁、整数版本和租户事务。活动/已删除列表分开，已删除方案的布局/图面/检查/候选/保存410。旧创建重试不能重新创建已删除方案。
- RackPlanActions 增加确认、权限/草稿禁用、精确重试和标签卸载取消；画布 Inspector 增加“删除选中机柜”，复用精确编辑器删除逻辑，有设备或已保存锁定柜阻止直接删除。设备/禁放区原有删除入口继续复用。
- 实测发现浏览器可能缓存已删除布局410，导致恢复后仍打不开；Rack API全部响应含错误设Cache-Control:no-store，Web Rack请求也绕过缓存。再次恢复到v7后直接Open layout成功，无需手动清缓存。
- 新增根目录 RACK_USER_JOURNEY.md，更新 API/工作区/本地迁移说明和待办增量；历史轮次描述按当轮保留，以本轮状态为准。

### 清理与数据保留

- 截图中的7个旧单功能demo以正常DELETE API移入“已删除方案”，不再出现在正常列表；按确切名称、当前版本和项目/revision匹配，没有批量删除其他方案。每个方案清理前后数据库布局/快照/设备/约束内容SHA256一致，完整32柜演示和Facility envelope前后相同。
- 保留正常示例“完整机房演示 · 32柜 / 多排混合设备”，ID4b8f7bf3-9015-455f-8bc8-ef3520f0d748，仍为v2。没有新建替代大示例或修改其布局。
- 浏览器验收新建481e475a-269c-44fa-a404-d0d1d3ab6c48：v1空方案→2柜、GPU U1–4、ToR U42、1禁放区、前后0.6m、房间10/10kW预算、首柜500kg/8/8kW→保存v2→重命名v3→删除v4→恢复v5。恢复后四类内容与v2严格相等；空柜删除草稿生效、有设备柜禁删，Discard恢复2柜。
- 随后临时方案删除v6→再次通过UI恢复v7并立即打开布局验证缓存修复→验收完移入已删除v8。正常列表最终仅保留完整演示，无dirty。本机清理不会随Git自动清理组员数据库。

### 验证与证据

目录：[records/2026-10-29-rack-user-journey](records/2026-10-29-rack-user-journey/)，执行方式见commands.md。

| 范围 | 最终结果 | 证据 |
| --- | --- | --- |
| 数据库迁移 | 011已应用，仅增加软删除字段/索引 | migration.txt |
| Rack真实数据库/HTTP | 53通过，0失败/跳过；含新生命周期、租户/权限/前置条件、删除与保存并发、缓存头与原Rack/Assistant回归 | api-tests-final.txt |
| Web定向 | 46通过、8文件；含管理权限/草稿、精确重试、transport版本/幂等/缓存/已删除过滤、空柜删除守卫 | web-tests.txt |
| Web构建 | 成功，保留既有>500kB bundle提示 | web-build.txt |
| 浏览器实际操作 | 新建/跨页布置/错误阻止保存/保存/重命名/删除/恢复/再次打开/空柜删除与Discard | browser-checks.md、restored-layout.png |
| 本机示例清理 | 7个旧示例内容不变；完整演示与Facility不变；正常列表仅完整演示 | cleanup-results.json、final-local-state.json、clean-plans.png |

首轮API在既有同时创建测试发生一次fetch failed（52/53），原日志保留api-tests.txt；独立重跑53/53，补缓存修复后最终再跑53/53。首轮新增前端断言依赖input属性顺序失败，修正为对同一input独立检查disabled与原意图值，最终46/46，未放宽业务条件。浏览器开发watch重启一度502，服务恢复后Retry成功；测试/工具操作错误及真实产品断点分开记录。未运行全仓，不声明整个平台所有测试通过。

### 仍未覆盖

- 本轮入口使用已有Facility项目/场景/HALL，不新增园区或机房向导；无支持边界时不能凭面积直接布柜。
- 删除方案可恢复，没有永久删除/清空回收站；机柜、设备和禁放区只在未保存时可Discard，已保存删除无单对象回收站。
- 正式验证历史、连续通道连通、权威跨方案容量预留和规模实验仍待后续。INCOMPLETE允许保存无已知冲突草稿，整体NOT_RUN未改，不能当作工程认证。模型继续按用户要求搁置。
- 后续优先根据组员实际使用反馈再修交互断点，随后补正式验证记录与通道连通；没有为本轮擅自展开其他算法或全清单。

## 2026-10-29：第二十二轮，规范文档与需求驱动自动设计

### 目标和实际修改

- 中断前标准文档已保存，本轮恢复并接通自动设计。仅AI-INFRA-Rack，起始HEAD a80b35e；未commit/push、改remotes、老师目录/平台、模型或.env。
- 已只读查看老师Power107设备/130连接/24回路、Network40设备/144连接的点阵、Inspector、容量/来源/新鲜度；Rack/Floorplan当前为占位。未移动/导出/新增/验证/发布老师数据，见[参考记录](doc/tools/rack/reference-observations.md)。
- 新建[标准8份工具规范](doc/tools/rack/Overview.md)，另加算法与参考记录两文件，总索引已链接。按规范再实现需求展开→多资源装箱→紧凑几何→权威复核→共享草稿保存。
- 新增[demand-planner.js](packages/rack/src/demand-planner.js)：精确目录版本数量、稳定ID、输入顺序First Fit/资源占比Best Fit、连续U、三维限值/柜数/预算、有限紧凑矩阵。设备不丢失，未知/超大/柜数/预算/空间失败保留原因；至多16组/128设备/32柜、每策略256整体提案、批16。
- POST layout/design-options只读，复用租户/RBAC、保存版/快照/源状态、SQL5秒/总15秒及原PostGIS完整检查；生成不写库，非空方案拒绝覆盖。候选body复用原共享草稿与版本/权限/幂等原子保存，无迁移。
- [RackDemandDesign](apps/web/src/rack/RackDemandDesign.jsx)接空方案数量/限值/净距/来源/房间预算表单、课程示例、策略比较、点阵对象详情、复核转草稿。新建提示与流程更新，空白工作台不重复展示；只读候选不跳保存版管理页。
- RoomFloorplan辅助视图统一点阵/自动适配，去掉手动缩放/平移，真实Polygon/孔洞/米制和图层不变。操作见根[RACK_DEMAND_DESIGN.md](RACK_DEMAND_DESIGN.md)。

### 验证与证据

目录：[本轮命令与日志](records/2026-10-29-rack-demand-design/commands.md)。

| 范围 | 最终结果 | 证据 |
| --- | --- | --- |
| Rack领域 | 140通过，0失败/跳过；含5项需求测试，未知/零/上限、确定性/不变性/库存保留/预算/搜索预算 | domain-tests.txt |
| 真实DB/HTTP | 56通过，0失败/跳过；凹Polygon/孔洞、只读无命令、普通保存、旧版/源/租户/目录/非空及原回归 | api-tests-final.txt |
| Web定向 | 48通过，9文件；需求表单/transport/共享草稿守卫、原工作台和点阵无缩放 | web-tests.txt |
| 构建 | 成功；既有>500kB提示保留 | web-build.txt |
| 浏览器较早候选 | 新建→22台需求/40kW预算→2候选→柜/ToR详情→复核/草稿→保存/重读v2；3柜/22台全装 | browser-checks.md、saved-design.json、saved-layout.png |

- 本机自建“自动设计示例 · 22台设备”，ID8fbee1e3-7b0a-4584-b785-5a289e9bbdb3，v2；001和原32柜示例仍v2，未修改。
- 首轮领域4失败/API2失败源于测试模型缺字段和生成柜漏作用域上下文；补全并正确剥离HTTP字段后全过，无放宽业务断言。首轮日志保留。首次Vite局部node_modules入口失败，修正根入口后启动。开发热更新曾清空临时候选，重开同一v1再生成，没有重复创建。
- 最后视觉复核修正几何排序：从含维护带面积改为展示的机柜占地区指标；领域同需求无遮挡大房间为2.64m²，重跑领域/HTTP通过。浏览器保存的是修正前4.32m²，不能把代码数字当浏览器证据。
- 追加gapM=0真实HTTP测试发现浮点近似共边导致GEOS错误，GeometryCollection单独不足；0最小间距时增加1微米数值分隔，未放宽权威检查规则。定向3/3后重跑完整领域140/140、HTTP56/56，失败和诊断日志保留。本机较早API也需重启加载该修复。
- 自动审批拒绝“重启API并清空本轮自建示例”的组合命令，随后保留旧进程/数据、另启预览也被拒绝；均未执行，未返回具体原因。之后未再尝试进程/配置变更；API8797/Web5193保留。需下次正常重启开发服务加载最终排序，尚未浏览器复验；未停止用户进程、清空示例或修改.env/端口配置。
- 未迁移/seed/reset/删卷，未运行全仓；未配置模型提示、既有pg查询排队弃用提示保留，不声明整个平台通过。

### 边界与下一步

- 仅空方案/一种柜型号/合成目录，单柜限值须显式声明，房间预算仅本方案假设。复杂障碍只找完整矩阵，有限搜索失败不是无解证明，不保证全局最优。
- 连续通道/疏散、正式Validation Run、候选历史、跨方案权威预算、网络/供电/热验证仍待实现，整体NOT_RUN。需求规划的Assistant投影未补，原工具可用但模型继续搁置。
- 下一步：正常重启后复核最终排序，再按规范做通道连通、版本绑定验证及可复现规模/算法实验。所有改动本地留用户提交。

## 2026-10-29：第二十三轮，Plan 命令行与 Rack 多视图

### 目标、修改与边界

- 根据用户要求参考老师Power的展示/操作方式，保留Plans新建、重命名、软删除和恢复。本轮HEAD为20b85e0，仅AI-INFRA-Rack，无commit/push、remotes或老师原目录/平台数据修改；没有模型、数据库、API、端口和进程配置变更。
- 老师Power Overview仅只读查看Wiring/By level和已有107设备/130连接/24回路；只切换展示，未调用老师写命令。Rack采用自己的机柜、设备、禁放区操作。
- shell顶部从无命令改为Add rack、Add equipment、Add exclusion zone、Constraints、Capacity limits、Auto design、Check results。注册在原工具表，通过活跃tab/plan绑定请求交给RackEditor；未选Plan解释阻止原因，权限继续过滤。
- 新增RackAddDialog与rack-commands：三类添加有真实表单，取消不产生草稿；确认时创建/复用同一版本草稿。设备绑定目录版本、一次1–128台、总512台，先进入待上架库存；机柜256/禁放区64上限保留。约束/容量进入原编辑页，候选/检查进入原模块，不另造保存API。
- 保留原源新鲜度/快照/版本/权限/未决保存保护；候选不能覆盖现有草稿，删除方案和无Facility权限时消费/拒绝未处理命令，避免恢复后误执行旧操作。
- Overview与Layout都显示工作台；选定方案后收起未选方案的导航说明。新增RackViews的机柜立面/容量表，与真实平面切换、共用稳定ID/Inspector；切换展示不改坐标。容量只用当前body对应的后端报告，未知不变成零。新添加柜回到平面并选中。
- 浏览器发现并修正旧设备选择串到新增柜的详情问题；设备选择必须与当前柜归属一致。修正添加窗口初始坐标的小数步进不匹配，明确设备型号aria-label。
- 操作说明：[RACK_PLAN_WORKBENCH.md](RACK_PLAN_WORKBENCH.md)；规范更新：[ui-pattern.md](doc/tools/rack/ui-pattern.md)。正式Validation Run、连续通道、工程供电/热验证继续待后续，不扩大本轮后端算法范围。

### 验证与保留数据

证据：[records/2026-10-29-rack-plan-toolbar](records/2026-10-29-rack-plan-toolbar/commands.md)。

| 范围 | 结果 |
| --- | --- |
| Rack前端+tool registry/open views/shell/toolbar | 19文件129测试通过，0失败；新增6项命令/不变性/边界/多视图测试 |
| Web构建 | 成功；原esbuild/oxc及>500kB提示保留 |
| 浏览器 | 无Plan阻止、三视图/ToR详情、添加柜/2台设备/禁放区组合草稿、容量/检查、自动设计防覆盖、取消与Discard、详情修复复测 |
| 保存状态 | 验收草稿均Discard；原示例v2、3柜/22安装、0待上架/禁放区。没有保存、删除或新建方案 |

- 本轮无后端修改，未重跑领域/数据库测试、未运行全仓；不声明整个平台全部通过。首次小范围42/42通过后扩充为129/129；首次diff检查的新增行末空格已清除。
- 运行中的上一轮日志由原进程自动追加。本轮未重启，因此上一轮最终算法排序/零间距修复的浏览器运行版本限制仍保留；本轮只验证新UI与既有检查/草稿流程。
- 下一步按实际使用反馈补交互；若继续算法/验证工作，先正常重启加载上一轮最终API，再做正式版本绑定验证记录与通道连通。模型继续搁置，所有提交留用户完成。

## 2026-10-29：第二十四轮，AI Agent 与个人 API 接入调研

### 范围与实际产出

- 根据用户要求调研 DrClaw 等项目如何管理 Agent、让用户接入自己的 API。本轮起始 HEAD 0799add、工作区干净；只在 AI-INFRA-Rack 副本工作，无 commit/push、remote 或老师原目录/平台修改。
- 新增根目录 [RACK_ASSISTANT_RESEARCH.md](RACK_ASSISTANT_RESEARCH.md)：区分模型连接、Agent、会话/运行；整理 DrClaw 固定版本源码及 Open WebUI 官方连接文档，给出用户操作流程、建议架构、接口草案、现有缺口、实施次序与验收要求。
- 更新 [RACK_ASSISTANT.md](RACK_ASSISTANT.md) 调研入口，明确新增内容是设计，个人连接页面尚未上线；原部署级 Assistant 与 5 个 Rack 工具保持不变。

### 结论与证据边界

- DrClaw 核查 main commit 4f96df0d9df0eae24a992afabe08edec5fc575f0：providers/active_provider 管理连接，配置有 Key/Base/Model，LiteLLM 适配调用，Web 保存要求重启。所读本地配置路径会明文保存及回填 Key，不能直接照搬成多人 Rack 的个人密钥接口；没有认定每 Agent 独立 Key 或设置页已有连接测试。
- Open WebUI 区分管理员后端连接与实验性浏览器 Direct Connections；后者 Key 在浏览器 localStorage，依赖 CORS。模型发现失败不等于聊天失败，tools 兼容性需单独测试。LibreChat 仅引用配置示例的 schema/自定义地址校验，不声称已核实其个人凭证实现。
- Rack 推荐个人连接 + 现有固定 Rack Agent + 后端工具；数据库只放连接元数据/secretRef，凭证独立存储，遵循现有 secrets 规范。聊天只引用获授权连接 ID，后端按请求解析 provider；不能通过修改全局 provider 切换用户。
- 本地已核查 provider、Host、路由、config、secrets、Web session 和 Rack 工具。缺口为个人连接 CRUD/测试、可写凭证存储、请求级 provider/脱敏/缓存隔离、设置页面与会话连接身份；按数量自动设计仍未投影为 Assistant 工具。
- 原蓝图部署级配置限制需要作为扩展规范明确调整：管理接口一次性收凭证，chat 不收 Key/任意地址/provider 实现。本轮未改动该规范或运行逻辑。

### 验证与下一步

- 文档检查：`git diff --check` 通过，新增研究文档另经 `git diff --no-index --check` 检查通过（新文件未暂存）。未运行测试/构建，因为只有 Markdown 文档变更；不声明真实模型或新设置页面已验证。
- 本轮仅只读调研，无第三方代码克隆/安装、迁移、服务重启、端口/环境配置、真实 Key 读取/保存或模型调用。没有浏览器操作或数据库变更；前轮运行版本限制保持原记录。
- 下一步按文档先完善连接/Secret Store 扩展规范和最小后端，再做用户设置页及 Assistant 连接选择。此时可用假 provider 验证，不需用户发送 API Key；真实服务验收放在本地安全配置完成后。

## 2026-10-29：第二十五轮，Ask about Rack 首次配置与持久连接

### 实际范围与修改

- 用户要求首次配置后直接在下方 Ask about Rack 使用，并询问老师平台连接方式。本轮起始 HEAD0799add，保留第二十四轮未提交文档；仅修改 AI-INFRA-Rack，无 commit/push、remote 或老师原目录/平台写入。
- 用户随后明确只处理我们的平台；之后没有继续查看或操作老师平台。此前仅只读打开老师 Ask about Power，看到 api.deepseek.com、deepseek-flash/ deepseek-v4-pro，未发送消息/换模型/修改业务或配置。页面不能证明 Key 保存位置和计费账号。
- 先新增根 [连接契约](RACK_ASSISTANT_CONNECTION.md)，再实施每认证用户一条默认连接。Ask about Rack 内首次自动展示配置，保存后自动使用；支持修改、Key 留空保留/替换、独立测试、删除确认。浏览器不保存或回填 Key，保存不请求模型。
- 新增 [assistant-connections.js](apps/api/src/services/assistant-connections.js) 与 [地址传输](apps/api/src/services/assistant-endpoint.js)：应用外文件元数据、独立目录主密钥、AES-256-GCM 凭证、认证用户隔离、乐观版本、原子替换和失败清理、主密钥遗失保护、轮换/删除取消在途请求。首版单 API 实例本地适配器，不是多实例 Secret Manager。
- 默认 HTTPS 公网/全部 DNS 结果检查/实际 socket 绑定已检查 IP/禁止重定向、限制响应大小与取消。管理员精确 origin 允许校园内网/本地网关；用户表单不能自行放开内网。测试用合成 ping 工具区分普通响应和工具往返，限并发/冷却且错误不回显上游 body/Key。
- Host 改为按获授权个人连接构建本轮 provider/脱敏器，保留原 Rack/Facility 权限、工具、限额、审计；无部署模型也可进入个人设置。chat 只收连接ID/版本，连接/版本/模型绑定会话；修改时取消旧请求，不全局切 provider，不静默回退。
- 新增连接管理 API、个人 provider metadata、Assistant no-store；Web 接入 [设置表单](apps/web/src/assistant/AssistantConnection.jsx)、原 hook/transport/Composer，复用现有消息入口。更新原蓝图扩展、Assistant/基础/本地启动说明和环境模板（非真实.env）。

### 验证与运行状态

证据：[本轮命令](records/2026-10-29-rack-assistant-connection/commands.md)、[浏览器链条](records/2026-10-29-rack-assistant-connection/browser-checks.md)。

| 范围 | 最终结果 |
| --- | --- |
| 连接服务/API/地址传输与原工具投影 | 30/30通过，0跳过；含重建实例持久化、并发更新、跨用户隔离、密文篡改/主密钥丢失、取消、工具往返、DNS/重定向/大小限制 |
| Assistant包 | 84/84通过，0跳过 |
| 真实DB/HTTP | 64/64通过，0跳过；新个人连接真实组装Host调用Rack容量工具，不改方案且拒绝外项目/他人连接 |
| Web定向 | 7文件171/171通过；构建成功，既有bundle/esbuild/oxc提示保留 |
| 浏览器 | 首次配置→保存→刷新自动恢复→Key留空修改→确认删除；合成连接已清理，最终空白设置页 |

- 首次 DB 新夹具未填真实默认预算造成63/64，修正为 loadConfig({}) 后定向1/1、完整64/64，无放宽业务断言。HMR因hook数量变化出现旧页面错误，正常刷新后全部流程通过；原日志保留，不隐瞒初次失败。
- 只重启经核实的本机Rack API8797，最终进程27024；Web5193/DB55532保留，无迁移、seed、reset、删卷、端口/真实.env/认证变更。前轮算法源码随正常重启加载，但本轮未重新验收算法效果。
- 本机浏览器使用无效域名和合成Key，仅保存/刷新/修改/删除，没有点击付费测试或请求外部模型。临时单元/HTTP夹具用假provider，本机网关传输测试只连接临时localhost。没有读取/输出真实Key。
- 源码/文档定向 diff whitespace 检查通过；旧轮进程自动追加的原始运行日志保留，含HMR堆栈行末空格，全量diff检查不作为源码检查通过。新文件另做未暂存检查。未运行全仓，不声明整个平台所有测试通过。

### 边界与下一步

- 真实模型问答质量、真实服务tools兼容性、真实额度/限流仍待用户在本地表单自行配置后验收。当前不向用户索取聊天中的API Key。
- 首版每用户仅一条个人连接，单API实例文件存储；Windows依赖运行账户目录ACL，非云KMS。多连接/共享连接、多实例集中存储以后另做；容器需持久挂载数据与主密钥目录，组员各自配置、不随Git传凭证。
- 现有5个Rack工具未扩大，按数量自动设计的Assistant投影仍待下一小步；聊天没有保存/删除工具。既有正式Validation Run、连续通道和工程验证缺口保留。
- 所有修改留本地，由用户提交。

## 2026-10-30：第二十六轮，平台界面统一英文

### 目标与实际修改

- 按用户要求把我们平台内置中文界面改为英文。起始 HEAD `03f2130`、工作区干净；全部操作仅在 AI-INFRA-Rack 副本，无老师原目录/平台操作，无 commit/push 或 remote 修改。
- 翻译 Rack 方案管理、添加对象、按数量自动设计、布局画布、机房清单、立面、容量表、检查提示、详情面板、操作说明和无障碍标签，统一 Rack / Equipment / Exclusion zone / Plan 等术语。
- 翻译 Ask about Rack 的首次连接配置、加载/保存/测试/删除提示及相关后端错误；错误码、字段契约、权限、算法与密钥存储方式保持原实现。更新现有界面测试断言，无新增业务功能。
- 新建表单的默认连接名和规划假设改为英文；已有中文方案名、设备名、用户内容和数据库记录未批量修改。保留旧禁放区名称后缀的读取兼容表达式。项目开发文档继续中文记录。

### 验证结果与运行边界

- [验证记录](records/2026-10-30-rack-english-ui/commands.md)：Web 定向 21 文件 226/226 通过；连接服务/API/地址传输及原工具投影 30/30 通过，均零跳过。前端生产构建成功，保留既有 esbuild/oxc 与 bundle 大小提示；未运行全仓或本轮真实数据库集成测试，不声明全仓通过。
- 首次 Web 检查有两条翻译后的旧断言未匹配实际英文（加载提示与 inventory 大小写），修正断言后相同范围完整通过，无放宽功能检查。
- 前端、API、Rack 领域源码汉字扫描仅余旧数据后缀兼容表达式；源码与新增记录最终 whitespace 检查通过。
- 本机 5193/8797 当前无监听，Docker Desktop Linux engine 未启动；本轮没有重启服务或改变容器、数据库、端口、环境配置，也未做运行页面的浏览器验收。查看时按 RACK_LOCAL_SETUP.md 启动 Docker Desktop，再运行 `npm run dev:up` 和 `npm run dev`。
- 不读取/输出真实 .env 或 API Key，无付费模型调用。已有模型回答语言由用户输入及模型响应决定，本次仅统一平台内置文案。

### 遗留与下一步

- 启动本地平台后可人工检查英文长文案在窄屏和详情面板的换行；本轮已有静态渲染与构建验证，尚未做浏览器视觉验收。
- 既有真实模型兼容性、工程验证与算法扩展缺口沿用上轮，不在语言统一中扩大实现。
- 所有修改留本地，由用户自行提交。

## 2026-10-30：第二十七轮，恢复本地平台访问

- 用户打开 localhost:5193 出现 ERR_CONNECTION_REFUSED。核查时 5193/8797 均无监听，Docker Desktop Linux engine 未运行；原因为本地服务未启动。
- 先以断言验证 Rack 副本的 Compose 文件、项目名和数据库端口隔离配置（不输出 .env 内容），启动 Docker Desktop，执行 `npm run dev:up` 恢复 `ai-infra-rack-dev` 数据库和对象存储。启动脚本报告 rack-dev-assets 桶已创建；未运行迁移、seed、reset 或删除数据卷。
- 隐藏后台启动组合命令被工具策略拒绝，改用现有执行会话运行 `npm run dev`，成功启动 API8797、Web5193、合成瓦片8088；未停止任何原进程。当前启动会话 99043，前端PID16608、API PID29948、瓦片PID17252（仅当次观测）。
- 验证 Web首页 HTTP200、API `/readyz` HTTP200；按真实组织范围和已有开发身份，Northern DC Campus / Cascade Ridge Campus 的项目列表和 scenario 读取均 HTTP200，各1个scenario。初次裸项目请求未带组织范围得到403，随后误用主组织示例中的null得到404；改用已有数据库只读查询获得真实组织范围后成功，未放宽权限或更改配置。
- 本轮只恢复运行、只读核查并追加记录，未改业务源码；保留上轮未提交英文修改。没有老师目录/平台操作、真实模型调用、密钥输出、commit/push 或 remote 修改。应用进程需保持运行；关闭进程或重启电脑后，按 RACK_LOCAL_SETUP.md 的日常启动步骤恢复。
- 未重复运行上轮单元测试或构建，因为没有新增业务代码变更；本轮结论仅为本地启动和上述HTTP读取通过，不代表浏览器全部操作或工程功能已验收。

## 2026-10-30：第二十八轮，已保存名称与示例数据统一英文

- 用户指出 Plans 列表中的中文方案名，并明确要求不区分作者，一并改英文；该要求覆盖第二十六轮保留已存中文名称的选择。保留前轮未提交修改，只操作 AI-INFRA-Rack 副本与其隔离本地数据库。
- 新增可审阅的 [本地数据维护脚本](records/2026-10-30-rack-data-english/translate-rack-data.mjs)：默认预览、明确 `--apply` 后应用，限定 Rack Compose 项目与本机55532/rack_facility，未知翻译停止，写入前在 Git 忽略目录备份，单事务与原版本/内容条件防并发覆盖。
- 已应用3个方案、253处文本：3个方案名、244个设备名、4个禁放区名和2处假设来源。完整机房/自动设计方案为英文，已删除的用户流程示例也改英文且仍保持删除。版本分别2→3、2→3、8→9；ID、上架关系、坐标、约束数值、容量和生命周期不变，不伪造修改者或重写旧命令哈希。
- 修改 [机房示例生成器](scripts/lib/rack-hall-demo.mjs) 为英文，runner保留旧名称识别以避免其他已有数据库产生重复示例；早期离线预览HTML、动态文案和6个场景也改英文。历史Markdown/验收证据保持原语言，不改写既往记录。
- [本轮验证](records/2026-10-30-rack-data-english/commands.md)：4/4机房夹具测试通过，修改脚本语法检查通过；两个活动方案详情/完整布局HTTP200且无中文，已删方案详情HTTP200且删除状态保留。备份与当前非文本字段比较一致；首次Date对象与备份ISO字符串比较类型不一致，修正序列化后完整通过。复跑维护预览0变更，机房demo重跑保留原方案且不新建/保存候选。临时5184离线预览HTML/JS/6场景HTTP200且无中文，验收后关闭临时服务。
- 未迁移、seed/reset、删卷或改动老师目录/平台；未读取输出真实凭证、调用模型或commit/push。现有本地服务继续运行，用户刷新页面读取新名称；数据库变更不随Git传播，其他已有本地库需要按记录手动预览/应用相同维护，新生成机房示例直接使用英文。
- 本轮仅文案与已授权名称维护，未重复全仓测试/生产构建或浏览器视觉验收；既有业务功能缺口仍沿用前轮。源码、进展与新增记录 whitespace 检查通过，备份确认被Git忽略。

## 后续记录格式（第十七轮后沿用）

每轮追加一个日期标题，至少写清：

1. 目标和范围；
2. 实际修改及文件链接；
3. 设计选择和适用边界；
4. 验证命令及结果；
5. 遗留问题与下一小步；
6. 是否执行提交/推送（默认不执行）。
