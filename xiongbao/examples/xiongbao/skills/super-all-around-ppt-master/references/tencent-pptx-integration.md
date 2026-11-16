# tencent-pptx 生成引擎调用契约（Integration Guide）

本文档为「超级全能PPT大师」阶段七与阶段八提供与 `tencent-pptx` 渲染引擎的对接说明。核心原则：**本技能负责"内容叙事+视觉设计"（STORY.md + DESIGN.md），tencent-pptx 负责"渲染生成"（.pptx文件）**。两者通过 STORY.md、DESIGN.md、slides/ 目录实现解耦对接。

---

## 一、职责边界

| 环节 | 超级全能PPT大师（本技能） | tencent-pptx（生成引擎） |
|------|--------------------------|--------------------------|
| 内容叙事 | ✅ 阶段三产出 STORY.md | — |
| 视觉设计 | ✅ 阶段四产出 DESIGN.md | — |
| 逐页脚本 | ✅ 阶段六产出逐页要点 | — |
| 渲染生成 | — | ✅ 逐页 .slide → .pptx |
| 语法校验 | — | ✅ slidep-validate |
| 品质审核 | ✅ 阶段九五维自检 | — |

---

## 二、调用时机与方式

### 2.1 加载方式

在阶段七开始时，通过 `Skill` 工具加载 `tencent-pptx` 技能：

```
Skill(skill="tencent-pptx")
```

加载后，严格遵循其 `create-from-scratch` 工作流（信息收集→需求对齐→STORY.md→DESIGN.md→启动服务→逐页生成→校验）。

### 2.2 对接关系

本技能的阶段产出与 tencent-pptx 的步骤天然对应：

| 本技能阶段 | 产出 | tencent-pptx 步骤 |
|-----------|------|-------------------|
| 阶段一至三 | 叙事架构 | Step3 构建 STORY.md |
| 阶段四 | 视觉风格系统 | Step4 构建 DESIGN.md |
| 阶段五 | 数据支撑 | Step1 信息收集（协同） |
| 阶段七 | 启动生成 | Step5 slidep-start + present_files |
| 阶段七 | 逐页制作 | Step6 逐页生成 |
| 阶段八 | 校验修复 | Step7 slidep-validate |

### 2.3 关键衔接点

1. **STORY.md 复用**：本技能阶段三+六产出的叙事架构与逐页要点，直接作为 tencent-pptx 的 STORY.md 输入
2. **DESIGN.md 复用**：本技能阶段四产出的视觉设计文档，直接作为 tencent-pptx 的 DESIGN.md 输入
3. **风格匹配**：本技能的八大视觉风格基调，与 tencent-pptx 的预设风格（学术风/商务咨询/红金政务风）互补——命中预设风格时用其设计文件，不命中时走通用设计原则
4. **逐页硬约束**：tencent-pptx 的10条逐页自检硬约束（母版三区/标题块一致/主视觉占比/颜色字体限制/版式节奏/留白/锚点/视觉重量/色彩分配/角色一致），与本技能的视觉设计原则一致，须严格遵守

---

## 三、生成流程对接

### 3.1 启动渲染服务

```bash
slidep-start --project "项目目录" --filename "文件名.pptx"
```

**硬约束**：创建 .pptx 后必须立即调用 `present_files` 在预览面板打开，让用户实时看到渲染效果。

**文件名命名约束**：默认使用中文文件名（如"季度汇报.pptx"），除非用户明确要求英文。

### 3.2 逐页生成

每页是一个 `.slide` 文件，写入 `slides/{NN}.slide`。动笔前必读：
- `STORY.md` — 叙事逻辑
- `DESIGN.md` — 设计稿（画布、配色、字号、布局、元素、密度）
- 相关组件规范 — 用到哪个组件读哪个（component-text/slide/chart/table/diagram/image等）

**注意**：`.slide` 是受限 DSL（编译为 OOXML），按 HTML + 内联 CSS 的思维来写，禁止引入 React 概念（import/export/module/hooks/state）。

### 3.3 逐页自检硬约束（10条）

每页提交前逐项确认，任意不通过则当页返工：
1. 母版三区齐全：A标题块（0-120px）/B内容区（120-660px）/C页脚条（660-720px含页码NN/TOTAL）
2. 标题块右侧不塞装饰小图，全篇位置严格一致
3. 本页L1主视觉占B区面积≥DESIGN.md规定（默认30%），不用L3角标顶替L1
4. 仅用DESIGN.md列出的≤4种hex与≤2套字体家族
5. 与上一页版式不重复；本页留白比例≤DESIGN.md上限（常规页≤35%）
6. 本页有≥1个视觉锚点（≥44px元素或≥40% B区面积的图）
7. 本页与上一页视觉重量有显著差异（最大元素面积比>1.5:1或版式明显不同）
8. 连续≥2页等宽卡片横排需返工
9. 本页色彩分配符合DESIGN.md页面映射表（强调色只出现在焦点元素）
10. 本页role与STORY.md一致（hero页有≥40%主视觉或≥48px锚点数字；supporting页不用hero级视觉投入）

### 3.4 配图前置

若涉及生图，在写内容前完成生图流程，并对生成的图片做视觉检查（清晰、无水印、符合上下文）后方可使用。

---

## 四、校验流程对接

### 4.1 全量校验

所有页面写完后，一次性跑全量校验：

```bash
slidep-validate --all --project $(pwd)
```

### 4.2 修复策略

- 若返回 `success: false`，根据返回结果定位并修复问题页面
- 重复校验直至全部页面语法正确
- 修复时只改问题页，不动已通过的页面

---

## 五、术语映射（面向用户）

在向用户汇报进度或创建任务时，使用面向用户的术语，避免暴露内部实现：

| 内部实现 | 面向用户术语 |
|---------|-------------|
| STORY.md | 内容大纲 |
| DESIGN.md | 风格设计 |
| slidep-start | 创建演示文稿 |
| 逐页生成 .slide | 逐页制作 |
| slidep-validate | 检查页面 |
| present_files | 预览 |

---

## 六、常见问题与对策

| 问题 | 对策 |
|------|------|
| 渲染服务启动失败 | 重新运行 slidep-start 重新创建/启动目标文件与编译服务 |
| 页面语法校验失败 | 根据返回错误定位页面，对照组件规范修复 |
| 视觉一致性偏差 | 回到 DESIGN.md 核对颜色/字体/版式规范，纠正偏离页面 |
| 用户要求修改内容 | 完全生成后通过 tencent-local-office-edit 修改，禁止回退到源码修改 |

---

## 七、协同技能

| 协同技能 | 调用场景 |
|---------|---------|
| `super-all-around-info-miner` | 需要深度信息采集与价值提炼时 |
| `super-all-around-data-analyst` | 需要深度数据分析支撑论点时 |
| `super-beautiful-data-visualizer` | 需要精美数据可视化图表时 |
| `tencent-local-office-edit` | PPT生成后需要本地编辑修改时 |
