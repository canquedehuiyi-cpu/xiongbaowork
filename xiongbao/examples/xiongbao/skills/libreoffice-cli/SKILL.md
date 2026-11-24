---
name: libreoffice-cli
description: 用电脑里的 xb-office-cli（LibreOffice 命令行工具）从零生成 Word、Excel、PPT、PDF。用在用户要一份 docx、xlsx、pptx 或 pdf，而且内容可以先写成文档结构再导出时。读取或转换已有的 Office 文件不用它。
---

# 用 xb-office-cli 生成 Word、Excel、PPT、PDF

xb-office-cli 是电脑里的命令行工具，只能通过 computer_run_command 运行，照常过审批。它先检查命令里的所有文件路径，
再交给 LibreOffice 生成文件。只在这台电脑装了它的时候才有；`xb-office-cli: command not found` 就是没装，
告诉用户这台电脑没有这个工具，改用别的办法，不要自己去装。

## 先看这几条限制（电脑里装的是 1.0.0 版，实测出来的）

- 路径只能在你自己的工作区里：不能写 `..`，不能写工作区外的绝对路径，不能经过指向工作区外的符号链接。
  被拒绝时命令会以退出码 2 结束并说明原因；照原因改成工作区里的路径，不要换个写法绕。
- 它只能把"文档项目文件"（一份 JSON）导出成成品，不能打开、转换、修改已有的 docx、xlsx、pptx、pdf。
  读已有文件、改已有文件，用文档类的技能。
- 单条命令的修改不会保存：`writer add-paragraph` 这类命令跑完，改动就丢了。要么直接写项目 JSON（做法一），
  要么把命令从标准输入送进 `repl`、在里面保存（做法二）。
- 项目 JSON 里不要放图片引用（`image_ref`），也不要有名为 path、href、src、url、file 的字段：有就整份项目被拒绝，
  不支持插入图片和链接。
- 单元格里的公式导出后是 `#VALUE!`，不要用公式：在项目里直接填算好的值。

## 做法一：写项目 JSON，再导出（文字里有空格、内容较多时用这个）

1. `xb-office-cli document new --type writer -o report.json`（type 可选 writer、calc、impress），生成一份空项目。
2. 用 computer_write_file 或 python3 改这份 JSON，把内容填进去：
   - writer：`content` 数组，每项是 `{"type":"heading","level":1,"text":"标题"}`、`{"type":"paragraph","text":"正文"}`、
     `{"type":"list","list_style":"bullet","items":["甲","乙"]}`（list_style 还有 number）、
     `{"type":"table","rows":2,"cols":2,"data":[["a","b"],["c","d"]]}`。
   - calc：`sheets` 数组，每项 `{"name":"Sheet1","cells":{"A1":{"value":"名称","type":"string"},"B1":{"value":12.5,"type":"float"}}}`。
   - impress：`slides` 数组，每项 `{"title":"标题","content":"要点","elements":[]}`。
3. 导出：`xb-office-cli --project report.json export render report.docx --preset docx --overwrite`。

## 做法二：从标准输入送命令给 repl（几步小改动时用这个）

```
printf 'writer add-heading -t 标题\nwriter add-paragraph -t 正文\ndocument save\nexport render report.docx --preset docx --overwrite\nexit\n' | xb-office-cli repl --project report.json
```

每行一条命令，行里的文字按空白切开：`-t` 后面的文字不能有空格（有空格就改用做法一）。
标准输入里只能是普通文本行，不要带制表符、回车符或其他控制字符（带了整次调用被拒绝）。

## 导出格式

格式要和项目类型对得上：writer 项目导 odt、html、text、pdf、docx；calc 项目导 ods、csv、xlsx、pdf；impress 项目导 odp、pptx、pdf。
对不上（例如 writer 项目导 xlsx）会报 `LibreOffice conversion produced no output file`，换成对的格式或对的项目类型。`export presets` 列出全部格式。
中文字体已装，中文可以直接写。

## 做完要核对

导出命令打印了文件大小就只说明写出了文件，不说明内容对。用 `ls -l` 看文件在、不是 0 字节；
再读回来核对内容：用 `markitdown 文件名`（docx、pptx、xlsx、pdf 都能读）。
读回来和要求对不上，就改项目再导出，不要把没核对的文件交给用户。
