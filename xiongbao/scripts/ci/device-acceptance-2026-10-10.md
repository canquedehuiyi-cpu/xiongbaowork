# 设备撤销与动作去重候选记录

2026-10-10，本记录用于固定可复验候选，不是完整产品交付签署。

## 问题与改动

独立审计在原候选发现：设备删除后原 socket 仍能心跳；在线同 idempotencyKey 两次
真实文件追加会写两次；离线执行后丢回执会释放队列并在重连时再写一次。

当前改动在升级、socket 打开、每条入站帧、派发动作及连接巡检读取持久注册、令牌版本、
账户存在与封禁状态。删除/重配提交后立即断开本实例连接，其他实例以持久校验拒绝旧连接。
旧连接上的等待动作失败并说明结果可能不明；新派发不会向失效凭据发送帧。

在线和离线共用 work_items 持久动作编号，原子写入领取后才发送。相同编号不同内容拒绝；
已完成编号返回保存的结果。重启、租约过期、超时、断线或丢回执不自动重放已领取动作。
结果不明写入 outcome_unknown 并暂停该设备后续离线队列；设备列表展示不明数量和核查提示。
编号透传到 runner，本地 SQLite 在动作前提交领取，完成后保存结果；未完成领取在重启后
只返回结果不明。治理工具调用编号经过已有策略/审批/审计通道传到设备，Stop 信号透传。
没有提交真实模型请求，没有连接真实客户设备，没有修改审计方测试容器。

## 本地证据

测试使用普通 openbot_app 角色、新建独立库 openbot_flow_quota。
设备/真实文件/跨队列实例/独立 runner OS 进程崩溃/真实 WebSocket 撤销/治理/HTTP 配额
共 8 文件两轮均 **54 pass / 0 fail / 0 error / exit 0**，279 断言。
server/app/runner typecheck 均 exit 0。原始日志在
`C:/Users/canqu/.codex/tmp/wp35-022d/device-gates.log`、`device-final-focused.log`、
`device-types3.log`、`device-app-types.log`、`runner-types.log`。

最初新增测试暴露持久结果被 Bun 二次 JSON 编码；修正为对象参数后，真实结果重放通过。
早期红日志 device-focused.log/device-safety-debug.log 保留。没有放宽原测试超时。

## 配额与全量边界

913c8a2 全量两轮各有 handoff 夹具复用运行编号 1 fail、quota 默认分片超时 6 fail。
保留 quota-full-round-* 原始红日志。bdf79f1 为独立交接任务使用不同运行编号；
18fe511 顺序读取事务内配额，默认第 5 分片两轮均 543 pass / 11 skip / 0 fail。
新增 max10、真实 Bun HTTP 并发内建员工回归通过，未调宽门限。

独立审计从 18fe511 构建正式 Dockerfile 镜像，manifestlist
`sha256:d2ccc11b5d882fbbfcfc884347f2dec590e65e2455bfc9addfe9d61a0530573c`，
镜像脚本 exit 0、30 租户断言 0 失败，HTTP 员工 2×201+6×402，设备 1×201+7×402，
满额重配 201/旧 token 401/设备仍 1，被拒配对码仍可使用，providerCalls=0。
证据在独立审计工作树 `.audit/round7-18fe511/`。因此该已复现配额 P0 已关闭。

当前设备候选的固定 SHA 全量两轮、正式镜像及独立扩展验收尚待执行。
完整 WakerFlow、浏览器动作、触发器、原版逐工具权限与最终部署/模型验收仍未完成。
