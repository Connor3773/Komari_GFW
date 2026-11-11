# 0.1.8 独立排查与 0.1.7 复核

## 基线与证据

2026-11-11，先读取并测试 `a5ded6a` 的父提交 `fea0b39dc326d9e31aa1535de06145fc6245a8c3`（0.1.6），之后才读取 0.1.7 diff。上游固定为 `62af91037924057b961dff7b93beacd3f76a81e8`，使用官方 `Snapshot-2611090908` Windows 二进制，版本接口确认相同提交。

0.1.6 真实宿主测试中，REST 任务/历史、POST 与文本/二进制 WS 的任务、Ping 历史、metrics、统计、`common:getRecords` Ping 分支及 `common:getNodesLatestStatus` 单节点/map 均正常过滤；内部原始样本和告警正常。后段移动导航鼠标遮挡是独立测试问题，0.1.8 改用聚焦同一原生菜单链接后按 Enter。

**没有复现用户现场的首次失败请求，不能把某项格式猜测当作现场根因。** 0.1.6 通用警告没有入口、方法、检查项或时间，无法从它追溯证明是 REST、POST、WS、count、关联或容量失败。已确认的“为什么不会消失”原因是 `TaskVisibility.warn()` 永久锁存字符串，后续成功没有恢复路径。

独立基线 hook 复现还发现：Ping 请求待回复时注入非 JSON 的 WS 控制发送帧，会解析失败并消费关联，随后真实回复不再过滤。这是防御故障注入，不是已经证明的现场触发；上游 RPC WS 没有主动应用层周期心跳，不能将 `rpc.ping/pong` 测试称为真实根因。

## 上游语义

- [public.metric.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/web/rpc/jsonrpc/public.metric.go)：信封 count 为 series 数；`splitPublicMetricSeries` 与 `publicMetricSeriesFromCore` 都把 series.count 设为点数。单个聚合点的 point.count 才为桶内样本数，可大于点数。空系列为 count=0、points=null 或空数组。长度校验无需放宽。
- [common.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/web/rpc/jsonrpc/common.go)：常规 map 为 `map[string]recordLike`，跳过 nil report；ping 没有 omitempty。缺失 ping/null map 项的容错不是该提交正常返回格式变化的证据。
- [common.record.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/web/rpc/jsonrpc/common.record.go) 与 [public.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/web/rpc/jsonrpc/public.go)：Ping 历史 value 为 int，接受有限小数的兼容扩展不等于根因修复。
- [transport.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/web/rpc/jsonrpc/transport.go) 串行读取 WS 请求并写回复；[safe_conn.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/web/connection/safe_conn.go) 和 [wshook.go](https://github.com/komari-monitor/komari/blob/62af91037924057b961dff7b93beacd3f76a81e8/internal/plugin/wshook.go) 提供帧 type，控制帧不应消费 JSON-RPC 关联。

## a5ded6a Review

- 正确：增加入口、方法、检查项；保留未知分页/归属的 fail-closed；区分 series 与 point 的 count；尝试保留无关 WS 消息交错时的关联。
- 不充分：全局 clear 使其它接口成功掩盖持续失败，未保留最近失败时间/恢复历史，也没有证明现场首次触发。
- 数据结构回归：null 节点直接删除整个 key，应原样保留 null。
- WS 漏洞与误报：未按 type 跳过控制帧；未知 ID 成功回复被无条件放行；孤儿 wire ID 文本快筛可用 JSON 转义绕过；重叠 Ping 请求会覆盖旧关联。0.1.8 对这些场景分别补测并失败关闭。

另从 Git 归档 a5ded6a 的原始 `visibility.ts` 单独运行红色复现：确认无关成功清警告、null 项删除、未知 ID 透传、非 JSON 控制帧消费关联以及转义孤儿 ID 透传均真实存在，不仅是对 diff 的推测。归档验证副本仅为临时测试，不进入安装包。

## 0.1.8 修正

故障按传输入口和方法分别记录；请求准备失败单独记录。同一入口/方法成功才恢复该项；其它接口成功、原生错误和控制帧不能清除。同批次同方法有任一失败则失败优先。未知信封、重复、缺失关联不返回未过滤数据。

配置和总览提供“最近过滤诊断（本次运行）”，API 包含首次/最近失败时间、累计次数、恢复时间及检查项，恢复后保留最近记录。配置页每 10 秒刷新诊断但不覆盖表单。诊断按固定入口/方法聚合，仅内存保存，不存正文、目标、IP、Cookie、wire ID 或原始解析异常摘录，不改变存储 schema。

WS 控制帧原样通过且保留关联；无关请求必须确实记录过才能旁通对应成功回复。未知、畸形、歧义、过期、重放和转义内部 ID 显式拒绝；新 Ping 请求不能覆盖旧保护。容量和 TTL 仍有上限，关闭回收，晚到内部帧仍失败关闭。

真实宿主测试故意发送重复 JSON key，确认 POST 请求被拒绝、无关方法不清警告、成功恢复后仍保留可见诊断。这证明新诊断能定位下一次触发，不声称重复 JSON key 就是现场原因。

宿主超大响应、超时、Upgrade 头、禁用插件等绕过 hooks 的既有限制不变；本次 fail-closed 是针对进入插件 hooks 的相关响应，不是核心授权隔离。见 [架构边界](ARCHITECTURE.md#输出过滤与边界)。
