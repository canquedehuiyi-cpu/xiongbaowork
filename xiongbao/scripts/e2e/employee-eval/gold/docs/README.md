# tiny-text

一组没有依赖的小文本工具：生成网址别名、截断、大小写转换、数词数。

## 安装

```sh
bun add tiny-text
```

## API

### slugify(input, separator?)

把标题变成网址别名。`separator` 默认 `-`，返回字符串。

```ts
import { slugify } from "tiny-text";

const slug: string = slugify("Hello World");
```

### truncate(text, max, options?)

把文本截到最多 `max` 个字符（含省略号）。`options` 的类型是 `TruncateOptions`。

```ts
import { DEFAULT_ELLIPSIS, type TruncateOptions, truncate } from "tiny-text";

const options: TruncateOptions = { ellipsis: DEFAULT_ELLIPSIS, wordBoundary: true };
const short: string = truncate("a fairly long sentence", 10, options);
```

### DEFAULT_ELLIPSIS

截断时默认补的省略号 `…`。

### TruncateOptions

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| ellipsis | string | 末尾补的字符串 |
| wordBoundary | boolean | 不在单词中间截断 |

### toCamelCase(input) / toKebabCase(input)

大小写转换，返回字符串。

```ts
import { toCamelCase, toKebabCase } from "tiny-text";

const camel = toCamelCase("hello world");
const kebab = toKebabCase("helloWorld");
```

### wordCount(text)

数词：英文按空白分词，每个汉字算一个词，返回数字。

```ts
import { wordCount } from "tiny-text";

const count: number = wordCount("hello 世界");
```
