# URIError：编码边界

改编自上游同名知识文件；先遵循[证据与来源约定](index.md)。

`DecodeURI: invalid character` 先提示解码输入可能不合法，**不说明地址无法访问**。确认调用的是 `decodeURI`、`decodeURIComponent` 还是平台 URL/URI API；各自契约不可互换。

1. **证据**：取脱敏后的失败输入片段与调用栈，追踪由谁编码、解码过几次，检查百分号序列与字符编码。
2. **候选**：不完整/非法转义、无效 UTF-8、重复解码，或把整个地址与单个参数的编码边界混淆。网络不可达需另查网络证据。
3. **最小修复**：在负责该边界的生产者/消费者统一编码契约；对不可信输入捕获明确解析错误并给出拒绝或恢复状态，不随意删 `%` 或反复尝试解码。
4. **复验**：中文、保留字符、合法百分号编码、孤立 `%`、非法字节与已解码输入；确认内容和跳转目标未被静默改变。

`decodeURI` / `decodeURIComponent` 对非法转义或 UTF-8 的异常规则见 [ECMAScript URI 解码](https://tc39.es/ecma262/multipage/global-object.html#sec-decodeuri-encodeduri)。平台 URI/URL 构造接口失败转看 [BusinessError](businesserror_patterns.md)，按当前 SDK 文档核对。
