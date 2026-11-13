# capability-manifest.yaml 契约

> 消费端：`tools/port-capabilities/index.ts`（生成与 `--verify`）、`server/src/tenant-package.ts`
> （skills.yaml 的 `_porting` 块读取）。本文说明字段契约，改动任何一处都要同时改生成器、校验器与本文。

## 形态约束

1. **根节点必须是 YAML 序列**（一个 `- kind: …` 条目的列表）。顶层加 mapping 字段会让
   `parseYaml` 后的 `Array.isArray` 校验直接拒绝整个文件——版本标识因此写成首行注释，不新增伴生文件。
2. **首行注释携带审计规则指纹**：
   ```yaml
   # audit_rules_sha256: <64hex>
   # audit_rules_count: <int>
   ```
   `--verify` 要求它与 `tool-ref-audit.md` 头部的同一指纹**两处都存在且相等**（读原始文本、先剥
   BOM）。指纹一致 = 生成这些 `runnable` 的规则集与审计报告同源；规则表一变，指纹就变，旧报告
   与新包立即互指为假。配套变异测试：删任一处 → 必须 exit 1。

## 每条 9+1 个必填字段

```yaml
- kind: skill            # agent|skill|connector|team
  slug: dev-expert
  source: "workbuddy skill-marketplace:dev-expert@2.0.3"
  source_url: https://download.codebuddy.cn/...
  source_version: 2.0.3
  fetched_at: 2026-10-18T00:00:00Z
  checksum_sha256: <64hex>
  license: "proprietary-workbuddy-marketplace"
  redistributable: false
  attribution: "© WorkBuddy"
  runnable: degraded       # full|degraded|blocked
  dropped: ["scripts/", "references/large/**"]
```

9 个许可字段（source 至 attribution）缺一个，条目不进包——转换器硬校验，不靠人记。
`runnable` 与 `dropped` 是审计产物：`runnable` 三档（`full` 可执行 / `degraded` 需改写后才能跑 /
`blocked` 本环境不可执行），判定规则见 `tool-ref-audit.md` 头部说明。

## 与 skills.yaml `_porting` 块的对应

装配器把 manifest 行的审计字段以 `_porting:` 块写进 `skills.yaml` 每条技能（source、checksum、
license、runnable、dropped 等），**装载器读的就是这个块**（`parseTenantSkills`：`_porting.runnable`
为准，显式顶层 `runnable` 可覆盖，两者都缺省为 `full`——缺省只对手写的旧包成立，移植管道有义务
写全档位，校验器盯着）。

**历史缺口（P5 端到端链发现）**：装载器一度只读顶层 `runnable`，真实包 35 条 blocked 全部被静默
升级成 full——manifest 与 UI 徽章都成了谎。修法是把 `_porting` 纳入读取；这条缺口之所以能存在
三轮评审，是因为单测全部用顶层字段的合成 fixture。"有代码"和"有覆盖"之间差一条能红的断言。

## 校验入口

| 场景 | 命令 | 期望 |
| --- | --- | --- |
| 交付前 | `bun run port:capabilities -- --verify ./examples/xiongbao` | exit 0 |
| 指纹漂移 | 手改任一处的 sha256 | exit 1 |
| 字段缺失 | 删任一许可字段 | exit 1 |
| 幂等 | 转换器跑两次 `diff -r` | 无差异 |
