# 变更日志

## 0.1.3 - 2026-11-03

- 新增 `allowHooks`，仅在指定 Ping HTTP/RPC/WS 入口过滤当前实例内部任务、记录、指标系列和统计，保留普通用户任务。
- 修复历史显示限点之前的过滤顺序、跨任务汇总和数组计数；准确关联单个/批量 RPC、重复 ID、错误和文本/二进制 WS。
- 保留 `komari-gfw`、稳定所有权标记、现有配置及 schema 1；增加可选任务 ID 归属集合以覆盖升级、重建和历史残留。不改变检测/通知/恢复/清理逻辑。
- 宿主版本要求改为 `>=1.6.1`；最低支持版本和实际验证版本分别说明。构建校验版本一致性和必要权限。
- 增加自动化与真实宿主接口验证，公开审计也检查尚未追踪但未忽略的文件。
- 明确披露钩子原生透传上限、超时、禁用和其它公开转发入口的限制；该改动不是严格访问隔离。升级需要重新批准权限。

涉及文件：

- 运行逻辑：新增 `src/visibility.ts`；修改 `src/plugin.ts`、`src/service.ts`、`src/types.ts`。
- 权限与版本：`komari-plugin.json`、`package.json`、`package-lock.json`。
- 管理页提示与版本：`pages/app.js`、`pages/overview.html`、`pages/settings.html`。
- 构建、审计与测试：`scripts/build.mjs`、`scripts/audit-public.mjs`、`scripts/host-test.mjs`、`test/navigation.test.ts`、`test/service.test.ts`；新增 `test/visibility.test.ts`。
- 文档：`README.md`、`docs/ARCHITECTURE.md`、`docs/TESTING.md`；新增本日志。

## 0.1.2 - 2026-11-02

- 统一插件、总览、通知及方向文案，使用后台统一插件配置入口。
- 境内探针搜索、精确的专属过期聚合清理、精简数据保留。
- MIT 许可证和标准七文件安装包。
