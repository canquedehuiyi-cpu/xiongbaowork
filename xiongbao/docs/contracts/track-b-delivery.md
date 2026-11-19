# B 线交付契约：A/C 配合项

B 线分支：`feat/b-delivery-form`。所有断言保留在根 CI 的 `image` job；
镜像已在 app-build 阶段注入 `TENANT_PACKAGE_DIR=../examples/qoderwake`，
运行期默认 banner=false、RLS enforce=refuse。

## C：浏览器品牌入口

在 `app/index.html` 的首帧 title 包含 `熊宝数字员工`；
在 `app/src/main.tsx` 读取生成的 `appConfig.brand.productName` 设置 `document.title`。
主入口引用品牌配置后，实际主 JS bundle 也必须包含 `熊宝数字员工`。
HTML 与主 JS 均不得包含 `Self-host OpenBot`；可见推广文案需要 C 在入口代码中处理。

当前观测：生成的 app-config 已含正确品牌，实际 HTML 的 title 仍是 `OpenBot`，
主入口 JS 未引入品牌名。远端 image job 的其余启动、数据库与 RLS 断言已经通过，
这两条品牌断言失败。B 不改 app/index.html 或 app/src，也不在构建后替换 bundle。

## A/C：默认包与模型语义

`server/src/config.ts` 和 `scripts/generate-app-config.ts` 在未设置 TENANT_PACKAGE_DIR 时
默认 qoderwake。按启动分工，这两处回落逻辑由 A/C 实现；B 保留构建期显式注入。
默认模型占位、未配置模型引导、员工模型绑定与错误透传属于 WP-1.3，交由 A/C。
文档按目前真实语义说明 BOT_MODEL：兼容 OpenAI 路径还需要 OPENAI_BASE_URL，员工绑定优先。

## A/C：阶段 3 测试收口

冻结基线为 `03df9efa29cc51b64bd4a7b695dcb977ac0869f6`。
server 六分片与 app 同时重跑基线和 head，比较失败名称多重集；
不是用超级用户连库，也不以进程退出码代替 Bun 的 `0 fail`。

远端运行 `37904039582`：app 基线/head 各 16 fail；server 1/2/3/5/6 分片的差集为空。
第 4 片基线/head 都出现 5 个未处理的 `BuiltInAgent` 导出错误，完整运行未验证。
这些记录是观测，不表示已确认根因。源码或测试修复由对应路径主人完成。

阶段 0–2 保留测试 job 的 continue-on-error；WP-3.4 收口时 B 移除宽松设置，
再次要求完整日志为 0 fail / 0 error。DoD-1 还需要改动合入 main 后的一次绿色运行。
三线合并顺序保持 A → B → C，B PR 不替其他线合入源码。
