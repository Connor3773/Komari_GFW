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

严格模式为每台受检服务器额外创建一个反向 TCP 任务，目标为该服务器的 `地址:测试端口`，clients 绑定选定的境内探针（排除受检服务器自己）。结果以 `(受检服务器 UUID, 反向任务 ID, 探针 UUID)` 归属，不与探针自身的正向监测混淆。告警状态机将 5 个正向样本与所有反向样本配对处理；任一缺失即不完整。

- `admin:listClients` 获取服务器基本信息，立即投影为必要字段，不返回或存储 token。
- `admin:addPingTask` / `admin:editPingTask` / `admin:getAllPingTasks` / `admin:deletePingTask` 管理专属 TCP 任务；`default_on` 恒为 false。
- 首选 `public:queryMetrics` 查询最近窗口的 `ping.latency_ms`，`fill_empty: false`、`max_points: -1`，以避免将图表空值当失败。检查 `downsampled`，聚合数据不用于连续次数确认。
- `common:getRecords` 在 1.6.1 内部使用 rollup 查询，不把它当作精确原始采样接口。这是深入源码核验后对初步方案的细化。
- `admin:getSettings` 检查通知开关、渠道和模板，只保留需要的检查结果。
- `admin:sendNotification` 发送事件。使用 `clients: []`，在 `message` 中放已经脱敏的名称/IP/状态，防止宿主按 UUID 补入完整 Client。
- 使用 `server.cron` 驱动采集；持久化到 `__storageDir__`，不直接读写 Komari 数据库。

## 状态与一致性

原始采样在 Komari 1.6.1 为短期内存数据，服务重启或时间窗口超出范围后可能不可用。查询保持在最近数分钟，缺失时等待新数据，不用聚合值伪造有效检测轮次。

每个服务器有独立的样本游标、健康状态、连续告警/恢复计数、未解除事件和最后处理时间。5 个目标各取一个未消费的新样本，要求处于允许的时间偏差内；任何结果不得被多次消费。遇到过期、查询失败或配置变化，重置连续确认但不解除既有告警。

定时器、配置保存、任务同步、通知发送通过串行执行锁避免重叠。状态和待发送事件在投递前原子写入；成功后保存投递状态。重试有退避和次数限制，历史记录有容量上限。配置变更会刷新排队消息的脱敏策略。

## 任务所有权

任务拥有随机实例标识和固定槽位标识，持久化 ID 映射。只协调确认归属于本插件的任务；同名但标识不一致的任务不接管。创建后立即持久化 ID；重启可按拥有标识找回未记账任务。

监测关闭时清空本插件任务的 clients，并设 `default_on: false`，保留历史。独立清理操作删除专属任务及它们的探测历史。删除前校验拥有标识。宿主异常退出或直接强制删除插件可能跳过清理，文档提供人工核对方法。

## 页面与权限

manifest 声明两个 `visibility: admin` iframe 页面，分别为“GFW 总览”和“GFW 配置”。HTTP API 显式检查 `req.context.principal.roles` 包含 `admin`，不把 `/api/admin` 前缀当作鉴权保证。写操作还要求 JSON 和专用请求头，拒绝跨站简单表单调用。

权限仅申请 Node 兼容模块、系统 RPC、插件 HTTP 路由。不申请远程命令、本地子进程、任意文件、HTML 注入或监听额外端口。

## 依赖与运行环境

开发环境使用 Node.js 20+，宿主运行时为 MoeJS，不是完整 Node.js。避免使用 ESM 入口、浏览器 API、Node 原生扩展以及未经验证的兼容模块。入口由构建工具生成全局 `load()` 和 `unload()`。

## 官方依据

核验日期：2026-11-02；以下源码固定到 1.6.1，不以滚动主分支保证兼容性。

- [插件指南](https://komari-monitor.github.io/komari-document/dev/plugin/index)
- [Ping RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.ping.go)
- [指标查询](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/public.metric.go)
- [旧查询的 rollup 路径](https://github.com/komari-monitor/komari/blob/1.6.1/internal/metricstore/ping_records.go)
- [通知 RPC](https://github.com/komari-monitor/komari/blob/1.6.1/web/rpc/jsonrpc/admin.notification.go)
- [通知 Client 补全及总开关](https://github.com/komari-monitor/komari/blob/1.6.1/utils/messageSender/sender.go)
- [插件独立持久化目录](https://github.com/komari-monitor/komari/blob/1.6.1/internal/plugin/plugin.go)
