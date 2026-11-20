# ledger-import

把商户对账单导入并按商户汇总。

```
bun run import
```

读 `import.config.json` 里指定的对账单，把每一行的金额折成欧元分，按商户加总，写到配置里的 `output`。

## 汇总格式

```json
{
  "currency": "GBP",
  "base": "EUR",
  "rows": 30,
  "skipped": 0,
  "merchants": [{ "merchant": "Kestrel Foods", "total": 123456 }]
}
```

- `rows`：对账单里的数据行数；`skipped`：读不出金额、没有计入的行数；
- `merchants` 按商户名排序，`total` 是折成欧元分的整数。

## 测试

```
bun test
```
