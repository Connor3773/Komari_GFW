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

权限仅申请 Node 兼容模块、系统 RPC、插件 HTTP 路由。不申请远程命令、本地子进程、任意文件、HTML 注入或监听额外端口。

## 依赖与运行环境

开发环境使用 Node.js 24+，宿主运行时为 MoeJS，不是完整 Node.js。避免使用 ESM 入口、浏览器 API、Node 原生扩展以及未经验证的兼容模块。入口由构建工具生成全局 `load()` 和 `unload()`。

## 官方依据

核验日期：2026-11-02；以下源码固定到 1.6.1，不以滚动主分支保证兼容性。

- [插件指南](https://komari-monitor.github.io/komari-document/dev/plugin/index)
- [Ping RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.ping.go)
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
