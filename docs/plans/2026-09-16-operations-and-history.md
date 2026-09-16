# 运维、历史记录与域名升级

观察日期：2026-09-16。范围：补全现有 Cloudflare-only 产品中影响判断、排查和日常操作的缺口；保留现有监测与归档。

## 研究与取舍

| 问题 | 可核实证据 | 本轮决定 |
|---|---|---|
| 恢复任务忽略暂停、配置更新、区域停用 | 审查复现旧任务继续发出请求；入库版本判断无法阻止请求本身 | 恢复前校验当前监测、配置版本和区域；保存取消原因与稳定结果 ID |
| 派发完成容易被理解成结果已保存 | 原 Usage 页显示 dispatched；Queue 消费可能滞后 | 展示实际 stored / missing / cancelled，终止失败仍保留缺失数量 |
| 空分钟没有运行记录 | 没有 due jobs 时 cron 直接返回 | 每五分钟记录调度事件时间；清楚标注心跳不是成功检测证明 |
| 历史只读最近 100 条 | 原 detail API 的 limit 查询 | 增加当前配置隔离、时间/区域/结果过滤、稳定游标与 CSV |
| 区域身份依赖请求内容 | 共享密钥正确但路由指错时，可返回错误区域标识 | Probe 校验 REGION_ID，生产 Control 拒绝执行内部探测 |
| 事件刚关闭即可过期 | 清理原先按 opened_at | 改按 closed_at；保留旧记录兼容回退 |
| 配置没有便携备份 | 设置页无导出 | 明确字段白名单导出；批量导入留待完整预览、幂等与暂停导入设计 |

采用官方 Queue binding 的 `metrics()` 读取结果队列和 DLQ 积压，无需向 Worker 注入 Cloudflare 管理 API token。指标调用超时/失败保留 unknown。SDK 的 Date 和文档中的 epoch milliseconds 均兼容。数据仅管理员可见、按需查询。来源：[Queue JavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/#queuemetrics)、[指标更新说明](https://developers.cloudflare.com/changelog/post/2026-04-28-improved-queues-metrics/)。

Queue 仍保护“结果被收到后可靠入库”的阶段。DLQ 指标不等于恢复能力；本轮没有自动重放。需要先定位失败、限定消息范围并验证幂等，再提供重放操作。DLQ 存储也不应被当作无限期备份。来源：[Dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)。

域名使用 Workers Custom Domain，同账号活动 zone 下由 Cloudflare 管理 DNS 与证书。已保留原 workers.dev 与其他既有域名，并追加 `monstertracker.genedai.me`。来源：[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 交互与统计约定

- `Monitors → 目标 → History`：默认 24 小时；可改 7/30 天、区域、结果类型。每页 50 条，加载更多延续同一快照；刷新开始新快照。配置变化或快照失效须重新加载。
- 历史页统计覆盖选择的时间与区域，不跟随结果类型筛选而改变分母。网站失败与探针不可用分开，只有实际 target 观察进入通过率；没有观察时显示空值而非 100%。此值不是时间加权 uptime/SLA。
- CSV 按钮写明已加载行数；不伪装成全量导出。所有单元格引用并处理公式前缀，防止目标响应内容被表格软件当作公式。
- `Usage → Scheduler & delivery`：调度心跳、两条队列积压、最近 20 次任务的实际入库、缺失、取消、尝试次数和错误。配置存在仅表示绑定存在，不宣称服务健康。
- `Settings → Configuration backup`：导出配置 JSON，记录导出时间和原数据快照时间；不包含管理密钥、基础设施绑定和探测历史。
- 新增页面模块延迟加载；API 不跟随全局 30 秒摘要刷新反复读取。错误保留重试入口，旧请求取消，身份过期回到验证流程。

## 成本与数据边界

- 心跳每五分钟一次，正常一天最多 288 次逻辑写入；不会生成额外探测或 Queue 消息。
- 历史请求最多 4 条 SQL，每页最多 100 条（UI 50）。这不等于最多读取 100 行：每次翻页统计仍扫描选择窗口，长窗口和大量翻页应评估读取成本。新增复合索引避免同时间戳分页排序；代价是原始结果写入增加索引维护，实际计费依 Cloudflare 指标。来源：[D1 read accounting](https://developers.cloudflare.com/d1/platform/pricing/#definitions)。
- 游标固定时间边界及新插入数据可见范围，不阻止保留期清理删除旧行；翻页间统计可能因过期删除而缩小，不是跨 HTTP 请求的持久数据库快照。
- 诊断最多两条 D1 读取与两次队列指标调用，仅打开或手动刷新执行。不增加常驻轮询。
- 恢复执行使用原逻辑预算，可能重复物理请求；HEAD 降级 GET 也可能产生额外目标请求。预算不是严格的全部 HTTP 请求上限。
- 2026-09-16 实读 R2 生命周期，仅有 7 天未完成 multipart 上传清理，没有对象过期。D1 的 30 天策略不覆盖 R2。避免擅自删除既有归档，本轮仅记录该差异；可按业务需要配置独立生命周期。来源：[R2 Object Lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

## 后续能力及进入条件

1. 告警投递：先定义接收渠道、触发/恢复/未知状态、冷却和去重，再接入；不能把网页事件列表称为通知服务。
2. 配置导入：版本验证、差异预览、幂等、防重复、默认暂停，避免导入立即消耗预算。
3. DLQ/R2 恢复：限定范围、只读预览、审计与执行幂等验证后再做重放。
4. 事件时间线：保存机器可读关闭原因和证据关联，区分管理性关闭与真实恢复；本轮先修保留期，不重写旧事件历史。
5. 长周期报表：原始结果当前受保留期限制；要展示长期 uptime 需设计采样语义与汇总层，不能只对近 100 条求均值。
6. 公共状态页/多人权限：需显式选择可公开目标与字段，避免把现有私有 URL 直接公开。

## 验证记录

- 三个 Agent 分别承担生命周期审查/修复、历史实现/交叉审查、诊断实现/交叉审查。审查发现并修复：旧请求误使新会话失效、历史配置版本标注错误、终止失败丢失取消记录。最终交叉审查无发布阻塞项。
- `npm run check`：TypeScript、17 个测试文件共 **186 项测试**、生产构建全部通过；`git diff --check` 通过。SQLite 回归覆盖恢复暂停/变更/区域切换、最后一次 Queue 失败、迟到结果、游标时间戳相同、快照失效、鉴权与 503。
- 无 Queue 边界：五分钟心跳时 9 个任务为 49 条查询；整点保留清理加心跳时 8 个任务正好 50 条，超出容量在派发前拒绝。
- 本地浏览器实际验证筛选空结果、禁用空导出、24 行 CSV 下载和 2 个监测配置 JSON 下载。合成 HTTP 响应验证 503 重试与 50+3 行分页；该 53 行是测试数据，未写入数据库。1440px 桌面和 390px 手机布局无横向溢出。
- 迁移前已生成权限 0600 的远端 D1 备份；本地和远端均已应用 `0009_history_cursor.sql`、`0010_operational_signals.sql`。
- 控制 Worker 发布版本：`e52289ac-47b3-477e-81f5-4f6078534905`；24 个区域 Probe Worker 全部发布成功。保留所有既有域名，新增 `https://monstertracker.genedai.me/`。
- 新域名按正常 DNS/HTTPS 访问首页、health、摘要、诊断、历史及主页资源均为 200；未登录诊断为 401。浏览器完成真实登录、延迟加载页面和历史查看；生产 `limit=1` 连续两页无重复、时间窗口一致。
- 2026-09-16 10:15 UTC 后观察到真实 cron 心跳 `2026-09-16T10:15:13.000Z`；当前结果队列积压为 0。DLQ 观察到 1 条历史消息，经官方只读 [Peek API](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/peek/) 确认来自 `cron_202609040223`（9 月 4 日），包含 3 条结果；未自动重放或删除。实时尾日志所观察的调度事件 outcome 为 ok，但这不替代长期运行验证。
- JS 新增模块按需加载；主入口仍有构建工具的 >500KB chunk 提示。本轮不声称总资源体积缩小：主入口 516.42KB，另有共享和按需模块；CSS 188.59KB。
