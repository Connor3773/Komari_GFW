# 架构与兼容性

## 组件

采用 TypeScript 开发、构建为宿主可执行的普通 JavaScript，发布标准 Komari 插件 ZIP。管理界面使用本地静态 HTML/CSS/JavaScript，不依赖外部 CDN 或运行时 npm。

```text
后台总览 / 配置页面
        |
管理员鉴权 HTTP API
        |
配置与任务协调器 ------ 插件独立持久化目录
        |
Komari Ping 任务 ------ 已有 Agent ------ 5 个 TCP 目标
        |
近期指标查询 ------ 样本配对 / 去重 ------ 告警状态机
                                          |
                                 持久化通知队列
                                          |
                                系统通知 RPC / 渠道
```

## 宿主接口

严格模式为每台受检服务器额外创建一个正向 TCP 任务，目标为该服务器的 `地址:测试端口`，clients 绑定选定的境内探针（排除受检服务器自己）。结果以 `(受检服务器 UUID, 正向任务 ID, 探针 UUID)` 归属，不与探针自身作为受检服务器时的主动监测混淆。告警状态机将 5 个服务器主动探测样本（3 个反向大陆目标、2 个非大陆对照目标）与所有正向探针样本配对处理；任一缺失即不完整。

- `admin:listClients` 获取服务器基本信息，立即投影为必要字段，不返回或存储 token。
- `admin:addPingTask` / `admin:editPingTask` / `admin:getAllPingTasks` / `admin:deletePingTask` 管理专属 TCP 任务；`default_on` 恒为 false。
- 使用 `public:queryMetrics` 查询最近 8 分钟的 `ping.latency_ms`，`fill_empty: false`、`max_points: 4000`。1.6.1 的此接口只接受正整数点数；原始窗口由查询时段决定。检查 `downsampled`，聚合数据不用于连续次数确认。
- `common:getRecords` 在 1.6.1 内部使用 rollup 查询，不把它当作精确原始采样接口。这是深入源码核验后对初步方案的细化。
- `admin:getSettings` 检查通知开关、渠道和模板，只保留需要的检查结果。
- `admin:sendNotification` 发送事件。使用 `clients: []`，在 `message` 中放已经脱敏的名称/IP/状态，防止宿主按 UUID 补入完整 Client。
- 使用 `server.cron` 驱动采集；插件状态持久化到 `__storageDir__`。历史清理只经官方数据库 RPC，不直接打开数据库文件。

## 状态与一致性

原始采样在 Komari 1.6.1 为短期内存数据，服务重启或时间窗口超出范围后可能不可用。查询保持在最近数分钟，缺失时等待新数据，不用聚合值伪造有效检测轮次。

每个服务器有独立的样本游标、健康状态、连续告警/恢复计数、未解除事件和最后处理时间。5 个目标各取一个未消费的新样本，要求处于允许的时间偏差内；任何结果不得被多次消费。遇到过期、查询失败或配置变化，重置连续确认但不解除既有告警。

定时器、配置保存、任务同步、通知发送通过串行执行锁避免重叠。状态和待发送事件在投递前写入双槽校验日志（`state-0.json` / `state-1.json`），成功后保存投递状态。序号和 SHA-256 用于选择完整的最新副本，写入中断时保留另一槽；两槽均损坏时拒绝静默重置。没有变化时跳过写盘。此方案避免本次 Windows 宿主测试遇到的沙箱 `renameSync` 无效句柄问题，不承诺断电级事务或严格 exactly-once 投递。

通知失败最多尝试 5 次并指数退避，超过 24 小时不补发陈旧事件。检测配置变更取消旧待发通知并保留仍被监测服务器的告警标志；仅脱敏开关改变则按最新策略格式化待发消息。正向目标地址因服务器 IP 更新而改变时也重置采样起点，任务源签名随状态持久化。

0.1.4 根据 `admin:listClients` 的完整成功结果清理删除引用。整批校验记录类型、UUID 和重复项后才更新列表；接口错误或未知结构不修改选择，离线节点仍在列表中也不移除。受检列表、探针列表、逐服务器测试端口与监测状态同步裁剪，schema 1 仅增加可选 `selectionNotice` 提示。自动调整提升配置修订号并持久化，防止旧页面覆盖；保存时也会用最新列表先裁剪失效 ID，再校验严格模式端口，不让已删除且不可见的项目阻塞保存。

按用户要求，只要已选境内探针被删除就关闭严格模式，不关闭仍有受检服务器的监测总开关；即使尚有其它探针，也不静默改成较少探针的严格模式。正常模式继续使用五个主动目标。所有受检服务器删除时自动关闭监测；原本暂停的监测不会被自动开启，新服务器也不自动加入。此配置变更重新开始连续确认、保留现存服务器的告警标记，并取消旧待发通知；删除本身不产生恢复事件。已处理历史仍按既有期限保留。

协调器更新共享主动任务的服务器集合；已删除目标或已关闭严格模式的专属正向任务在暂停时也可回收，原始任务 ID 的隐藏证据仍保留。用户任务与其它实例不修改。读取设置时会立即修复选择，原生任务最迟在下一轮定时协调（10 秒）同步；保存设置会立即协调。服务器在列表读取之后才删除的竞态由下一轮重新获取列表修复。

## 名称与存储兼容

界面名称为“被墙检测”，功能入口为“被墙检测总览”；方向以大陆出发为正向、回大陆为反向。为兼容已有安装，技术标识 `komari-gfw`、请求头和任务所有权前缀 `[Komari GFW:` 不随显示名称修改。

早期实现中的内部方向键沿用原值，不代表当前界面的方向含义：`forward:<槽位>` 指服务器主动探测的 5 个目标；`reverse:<服务器 UUID>` 任务、`reverse:<探针 UUID>` 样本及配置/事件中的 `reverse`、`reverseTotal` 字段均指大陆到受检服务器的正向探测。保留这些键、任务 ID 和 schema 1，避免因修正文案而重建任务、丢失样本游标或重发历史通知。

## 任务所有权

任务拥有随机实例标识和固定槽位标识，持久化 ID 映射。只协调确认归属于本插件的任务；同名但标识不一致的任务不接管。创建后立即持久化 ID；重启可按拥有标识找回未记账任务。

监测关闭时清空本插件任务的 clients，并设 `default_on: false`，保留待恢复的任务。活跃配置不再需要的专属任务自动删除；独立清理操作删除全部专属任务及它们的探测历史。删除前校验拥有标识。宿主异常退出或直接强制删除插件可能跳过清理。

## 数据保留

不复制原始延迟历史，只存每个目标的最新值与去重游标。已处理事件最多 100 条、7 天；有效待发通知最多保留 24 小时，不受已处理事件数量限制。暂停时也裁剪历史，告警标志和起始时间独立保留。

1.6.1 原始样本仅在宿主内存保留十分钟，磁盘是规范化聚合表。每小时使用 `admin:dbTables` / `admin:dbQuery` / `admin:dbExec` 定向清理，依次核对任务 ID 与完整所有权名称、表前缀、驱动、必需表/列及返回形状。参数绑定使用对应驱动的占位符。

仅处理 `ping.latency_ms` / `ping.loss`，按 task_id 的标准 SHA-256 标签指纹筛选，再校验标签。删除条件为指定序列、指定粒度且 `bucket_milli + resolution_milli <= now - 1 小时`；每次最多 10000 行，优先删除最旧记录。仍在聚合的桶及近一个小时的桶不清理，不影响 8 分钟检测窗口。

只删除聚合行，不删共享字典、指标定义或内存原始样本，不改变全局设置，不自动执行 VACUUM。清理错误独立展示并限频重试，不进入检测失败分支、不重置告警或确认计数。SQL 以 1.6.1 表结构为边界；结构不符时拒绝清理。

## 页面与权限

manifest 的 `pages` 只声明“被墙检测总览”（`visibility: admin`），不把配置注册成插件功能。配置声明采用 `configuration.type: managed` 的官方 `textbox` HTML 扩展点，在 `/admin/plugins/config?short=komari-gfw` 嵌入同源、管理员鉴权的 `pages/settings.html` 表单。仅有 textbox 时，Komari 1.6.1 隐藏托管字段的“保存并重载”按钮，用户使用内嵌表单的“保存配置”。

这种方式保留动态服务器选择和逐服务器测试端口编辑，沿用原有 API 与双槽状态，不引入第二套配置或要求手动迁移。并非将各个字段改成 `server.getConfig()` 托管值。配置面板需要插件处于启用状态。

页面不再提供右上角“总览/配置”导航，日常切换使用后台原有的“插件配置”和“插件功能 / 被墙检测总览”菜单。总览空状态仍保留“配置监测”引导；因 iframe 沙箱没有顶层导航权限，此链接在新标签页打开统一配置，不将完整后台嵌套进 iframe。不修改父页面 DOM 或绕过宿主沙箱。

HTTP API 显式检查 `req.context.principal.roles` 包含 `admin`，不把 `/api/admin` 前缀当作鉴权保证。写操作还要求 JSON 和专用请求头，拒绝跨站简单表单调用。

权限仅申请 Node 兼容模块、系统 RPC、插件 HTTP 路由和指定路径的 HTTP/WS hooks。不申请远程命令、本地子进程、任意文件、HTML 注入或监听额外端口。

## 输出过滤与边界

最低版本 `>=1.6.1`，实际源码与宿主验证基线为 1.6.1（`96cf0f79d8cfdf6cc8be54fd1976bbc026d58f7f`）。所用 HTTP/WS hook 能力在该版本已存在，无需提高最低版本，也不对更高版本设置拒绝运行的条件。未来 API/数据库变化按响应结构检测，不宣称所有未来版本已经验证。

### 覆盖范围

- `GET /api/task/ping`：标准 REST 包装的任务列表。
- `GET /api/records/ping`：任务摘要、记录、`count` 和跨任务 `basic_info`。
- `POST /api/rpc2`：精确识别 `public:getPublicPingTasks`、`public:getPingRecords`、`public:queryMetrics` 的 `ping.*` 查询、`public:getPingMetricStats`、`common:getRecords` 的 `type: ping` 及 `common:getNodesLatestStatus` 的 `ping` 字典。
- `GET /api/rpc2` 的 WebSocket：独立 `wsMessage` / `wsSend` / `wsClose`，覆盖文本和二进制 JSON 帧。HTTP hook 不拦截升级请求。
- 源码核查 `/api/clients` WS、`public:getNodesInformation`、`public:getClientRecentRecords`、`public:getRecordsByUUID`、`common:getNodes`、`common:getNodeRecentStatus` 和指标定义列表：不输出逐任务 Ping 数据，无需全局扫描这些响应。
- 不拦截 Agent v2 的调度/上报，不拦截 `admin:getAllPingTasks`、管理员数据库/备份及本插件配置/总览。其它插件若以公开自有路由转发 `server.call()` 原始数据，无法由这组限定路径钩子保证隐藏。

HTTP 响应 hook 中 `req.body` 恒为空，不能据响应形状猜 RPC 方法。请求 hook 只对上述方法生成唯一临时 wire ID，保留原 ID 与过滤种类；响应精确关联后恢复 ID。批量请求混合方法、相同原始 ID、乱序回复、单元素批量返回对象、数字/字符串/null/无 ID 均有测试。保留宿主错误，不改变其它方法结果；无关 HTTP RPC 不解析其响应。HTTP 临时关联用被覆盖的内部请求头定位，不信任客户端提供的该头；不保存 Cookie、正文或凭据。

字段名按 Go 的大小写/Unicode 折叠和标量 null 规则识别；精确重复 JSON 键（含转义后同名）存在 Go/JS 解析差异，RPC 请求明确拒绝，不按最后一个值猜方法。这项格式检查也适用于同入口其它方法的歧义请求，不影响正常 JSON 请求。

临时 HTTP 上下文最多 256 个、120 秒淘汰，最多 1000 项批量、每次关联原 ID 文本最多 64 KiB；满载/关联丢失返回明确错误。WS 依赖 1.6.1 每连接串行读写的原生实现，每连接只保留一份关联、最多 256 个待回复连接，发送/关闭即释放。帧钩子异常会被宿主透传，因此本插件遇到本地失败会产生协议错误而不主动抛出透传异常。宿主自身超时仍不可控制。

`POST /api/rpc2` 的请求 hook 会让该入口适用 manifest 的 8 MiB 请求体读取上限，包括混合批量中的其它方法；超过时宿主返回 413。普通 API 无新增全局读取限制，上传附件等独立路由不受影响。

### 归属、汇总与采样

`hiddenTaskIds` 是 schema 1 的可选兼容扩展，仅保存已确认本实例任务的整数 ID。0.1.2 升级从现有 `state.tasks` 引导，随后由完整实例前缀和合法槽位识别现存及同实例遗留任务。创建后立即登记，任务重建/配置变化/删除/暂停不丢弃退休 ID，以覆盖缓存或遗留记录；遇到已改名或被用户任务复用的活跃 ID 撤销隐藏。不会接管其它随机实例或仅带相似前缀的用户任务；完整私有实例标记属于保留标记，不能区分人工逐字伪造的同实例任务。

无 ID 对应关系、任务已经消失且旧版从未记账、或整个实例目录丢失的孤儿记录无法可靠归属，不按猜测过滤。活跃任务改名的无名称指标响应在下一次协调前存在最多一个轮询周期的缓存延迟；任务列表/带名称的摘要可立即撤销旧归属。这些属于输出过滤的限制。

1.6.1 没有这些接口的 offset/cursor 分页；`max_count` / `maxCount` 是按任务比例分配的采样上限。直接过滤采样后数据会让插件消耗用户点数预算，且不能精确修复跨任务汇总。请求 hook 仅对历史读取取消宿主的最终显示采样（不改变底层 rollup 查询窗口），响应先移除插件记录、从保留记录重算 `basic_info`，再应用调用方原上限。采用宿主的比例分配与含首尾均匀采样规则，同权余数按任务 ID 稳定排序；原宿主 Go map 的同权顺序本来不稳定。

每任务统计保留宿主计算值，`count` 对应实际返回数组长度；指标移除整条内部系列（含空/填充系列）及逐点任务标签，不修改非 Ping 指标。无上限查询完整保留用户返回记录；有上限查询保留对应用户采样预算。出现未知分页、截断 count 或无法安全理解的结构，不从单页伪造总数，返回明确错误并显示 `visibilityError`，该警告在本次插件运行期间保留。

过滤本身不删除任何有效探测记录。现有任务协调删除和定向历史清理逻辑保持不变；`server.call()` 直接走 RPC，不经过 HTTP/WS 钩子，内部原始采样、告警和恢复不受输出过滤影响。

### 性能与无法保证的情况

只为上述三个路径注册 HTTP hooks，不全局缓冲 HTTP；只为 `/api/rpc2` 注册 WS hooks，不触碰 Agent 通道。普通过滤为 O(任务数 + 记录数)，归属查找用 Set；需要下采样时排序为 O(n log n)。历史查询需完整的宿主返回结果才能修复汇总，因此临时内存和返回给钩子的记录数可能高于原本的限点查询；建议缩短大量节点的历史查询时间范围。插件不在 hook 中查询数据库/调用异步 RPC，也不把延迟数据另行存盘。

**原生钩子是尽力输出改写，不是授权隔离：**

- HTTP 缓冲固定 32 MiB；超限直接透传。`Flush()` 进入流式透传。宿主仅凭 `Connection: Upgrade` 与非空 `Upgrade` 头就跳过 HTTP hooks；**普通 REST 端点带升级头也能旁路，不要求实际建立 WebSocket**。隔离宿主测试对此保留反例断言，不能把它作为严格隔离已修复。`maxHTTPBodyBytes` 只约束请求读取等，不提高响应上限。
- HTTP response hook 超时/异常继续原响应；WS 单帧超过 8 MiB 或处理超过 1 秒原样通过。由于这些是宿主主动绕过，插件不能保证拒绝或可靠上报每次旁路。超大 RPC 透传还可能携带临时 wire ID，而非原 ID。
- 插件禁用、审批失效、卸载、启动/停止窗口、其它插件后置改写以及未来新增端点可能暴露原生数据。已缓存的旧响应不能追溯撤回；修改后的 HTTP 响应使用 `no-store` 并移除旧 ETag。
- 管理员数据库、备份、原生任务管理与其它插件直接 RPC 仍能读取原数据，符合其特权用途，不承诺对管理员隔离。

因此 0.1.3 能在已验证普通 API 场景隐藏内部数据，但**未达到无条件、所有传输/体积/运行状态下绝不暴露的目标**。不能把“前端不显示”描述为安全边界已修复。

### 仅改插件的替代路线

若必须让内部结果根本不进入公共 Ping 存储，可另做“已有 Agent 远程命令探测”后端：使用 1.6.1 `admin:exec` 投递固定、安全编码的 TCP 检测命令，经 `admin:getSpecificTaskResult` 读取结果，只在插件状态保存必要样本，不创建原生 Ping 任务。普通/严格模式仍由所选现有 Agent 执行，不修改核心、主题或 Agent，也不安装额外 Agent。

这条路线在源码上有接口，但需要 Agent 开启远程执行、按 OS 检查可用 TCP 工具、超时/并发/任务结果清理，以及完整的跨平台验证；与现有“无需远程命令”安全和部署约定不同。0.1.3 **没有启用或实现此替代后端**，不能未经用户批准静默替换。若同时禁止远程命令且坚持原生 Ping 任务，在 1.6.1 仅改插件无法提供严格隔离；屏蔽全部公共 Ping API 会损害用户任务，也不是本项目采用的方案。

## 依赖与运行环境

开发环境使用 Node.js 24+，宿主运行时为 MoeJS，不是完整 Node.js。避免使用 ESM 入口、浏览器 API、Node 原生扩展以及未经验证的兼容模块。入口由构建工具生成全局 `load()` 和 `unload()`。

## 官方依据

核验日期：2026-11-03；以下源码固定到 1.6.1，不以滚动主分支保证兼容性。

- [插件指南](https://komari-monitor.github.io/komari-document/dev/plugin/index)
- [Ping RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.ping.go)
- [完整服务器列表与删除 RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.client.go)
- [指标查询](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/public.metric.go)
- [旧查询的 rollup 路径](https://github.com/komari-monitor/komari/blob/1.6.1/internal/metricstore/ping_records.go)
- [通知 RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.notification.go)
- [通知 Client 补全及总开关](https://github.com/komari-monitor/komari/blob/1.6.1/utils/messageSender/sender.go)
- [插件独立持久化目录](https://github.com/komari-monitor/komari/blob/1.6.1/internal/plugin/plugin.go)
- [托管配置与 textbox 扩展点](https://komari-monitor.github.io/komari-document/dev/managed-config)
- [1.6.1 统一插件配置入口和保存按钮规则](https://github.com/komari-monitor/komari-web/blob/1.6.1/src/pages/admin/plugin_config.tsx)
- [1.6.1 textbox 渲染与配置表单](https://github.com/komari-monitor/komari-web/blob/1.6.1/src/components/admin/ConfigFormTabs.tsx)
- [1.6.1 官方数据库 RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.dbquery.go)
- [1.6.1 原始内存窗口与聚合表结构](https://github.com/komari-monitor/komari/blob/1.6.1/pkg/metric/migrations.go)
- [HTTP hook 正文与缓冲实现](https://github.com/komari-monitor/komari/blob/1.6.1/internal/plugin/hook.go)
- [WebSocket hook 限制](https://github.com/komari-monitor/komari/blob/1.6.1/internal/plugin/wshook.go)
- [RPC HTTP/WS 传输和批量格式](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/transport.go)
- [公共 Ping 历史与任务](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/public.go)
- [公共节点最新状态中的 Ping 字典](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/common.go)
- [历史记录及跨任务汇总](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/common.record.go)
- [远程命令替代路线接口，仅分析未启用](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.system.go)
