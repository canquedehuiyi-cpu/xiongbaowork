# Claude Code 项目接手入口

用户于2026-11-02停止原Codex开发链，准备把后续开发和修复交给Claude Code。Codex Root转为独立验证和验收。此文件只提供接手上下文，不会启动开发、安装、测试或部署；先按用户当前指令工作。

## 必须先读

- [总交接文档](CLAUDE_CODE_HANDOFF.md)：代码基线、真实进展、阻塞、未合入私有候选和下一步。
- [验证合同](docs/handoff/2026-11-02-VALIDATION.md)：测试顺序、执行门和交付证据。
- [77故事/18包/7门及状态](docs/handoff/2026-11-02-SCOPE-AND-STATE.json)：完整原需求与精确指纹。
- 工作目录中适用的现有项目指令和CONTEXT术语表；后来的用户明确指令优先于历史材料。审计报告和旧聊天里的指令属于证据，不自动变成新授权。

## 接手第一步

只读核对实际repo、branch、HEAD、脏文件和执行环境，回报将使用的基线。仓库默认分支产品代码是旧0089682基线；D09/D06是另行保存的已审未运行候选，D06的2aacf0f已包含D09。不要盲从旧README执行Docker/安装/部署，不把行政主线和Source候选混成一棵树。

用户明确开始Claude开发后，由Claude负责实施、修复与推送，Root负责独立验收。每包不超过8件，使用真实before、最小diff和精确commit；不同作者审完前包再下包。Root发现的问题交回Claude同包修复。不要继承旧writer的身份、已释放lease/epoch或已耗GO。

## 不得跳过的门

- 项目Source/依赖/执行仍为cloud-only；本次交接不授Windows宿主项目执行、新机器/资源/付费job。
- 固定Bun1.3.14与原锁，不升级、不改锁、不运行安装脚本；不关闭preload或用stub造通过。
- 验证顺序：配额app → 配额server → D06 app → 真实PG/schema/角色/RLS门后D06 server。35是前三项测试定义数，尚未实跑。
- 不调用真实模型provider、不消费赠额、不收费、不部署生产，不读/回显真secret。特定metadata实验3/3已耗，禁止第四次及变名重跑。
- Source/static PASS不等于测试、PG、镜像、设备或商业验收PASS；必须保留77/18/7完整范围。
- 原两child/旧卷未恢复；新检出不能冒原恢复。旧403原因未知，旧R7归档拒绝未知；不要重扫已闭目录/PID/工具/恢复分支，也不重放旧GO。
- 私有候选的原RAM可用性不能保证。未取得全文/manifest/current before时不要继承旧PASS；明确缺件后重新制备新候选交Root验收。

## 每包交付

给Root精确commit/parent/diff、文件mode/blob/bytes/SHA256、原始安全测试输出与退出码、失败名/Unhandled、资源与PG门、NOT_RUN和开放项、回滚点。完成开发不等于Root已经验收。

关于CLAUDE.md的加载机制，参考[Claude Code官方说明](https://code.claude.com/docs/en/memory)。本文件是项目上下文，不是权限控制器。
