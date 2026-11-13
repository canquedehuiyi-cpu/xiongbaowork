# 智能排版引擎与布局验证细则（layout_engine）

> 用途：PPT 生成环节的"不出错"硬约束与"更好看"的自由层细则。主文件工作流走到「第六步 PPT 生成」时按需引用本文件；生成代码一律以本文件定义为准。
> 原则：**生成前动态计算布局（禁止硬编码坐标），生成后自动排检，排检失败不交付。**

---

## 1. 两层结构

- **基础层（代码级硬约束）**：只负责防崩溃、不出错，不替智能体做排版决策。
- **发展层（提示词引导自由布局）**：智能体在基础层安全区内自由发挥，不写死逻辑。

---

## 2. 基础层 — 页面常量与间距规则

```python
SW_IN = 13.333          # 页面宽（英寸）
SH_IN = 7.5             # 页面高
MARGIN = 0.8            # 水平安全区
CONTENT_TOP = 1.75      # 内容起始（标题栏下方）
CONTENT_BOTTOM = 7.25   # 内容结束
AVAIL_H = CONTENT_BOTTOM - CONTENT_TOP   # 可用高度 = 5.5"
GAP = 0.25              # 通用最小间距

GAP_RULES = {           # 上下文感知间距（替代单一 GAP）
    "标题→正文":   0.4,
    "正文段落间":    0.25,
    "图表→标注":    0.15,
    "KPI卡片间":    "calc_grid",   # 等分网格，非固定值
    "通用最小间距":   0.25,
}
```

**对齐基线：**
- 水平：左对齐优先，避免大段居中对齐（设计四原则）
- 垂直：网格基线 = 1.0" 增量
- 数字：表格内右对齐

**落笔校验工具（生成代码必须调用）：**

```python
def safe_place(y, h):
    """元素 bottom 超出安全区即报错"""
    if y + h > CONTENT_BOTTOM:
        raise ValueError(f"溢出：bottom={y + h:.2f}\" > {CONTENT_BOTTOM}\"")
    return y

def calc_grid(n, total_w, gap=GAP):
    """返回等分网格坐标列表（KPI 卡片等分用）"""
    cell_w = (total_w - (n - 1) * gap) / n
    return [(i * (cell_w + gap), cell_w) for i in range(n)]

def gap_rule(transition):
    """根据元素关系查间距（查不到用通用最小间距）"""
    return GAP_RULES.get(transition, GAP)
```

---

## 3. 发展层 — 自由布局引导

**① 内容自适应**
- 根据标题/正文长度估算所需高度 → 决定页面 slot 布局
- 文字超过 3 行 → 自动缩小字号（最小不低于 10pt）
- 塞不下的内容 → 提示用户拆页，不硬塞

**② 非标页面处理**
- 全图型：封面/高潮页除外，必须含半透明文字覆盖层
- 双栏：栏宽比不超过 6:4（左文右图或左图右文）
- 流程图/时间轴：智能体自判，但须遵循间距规则表

**③ 视觉平衡检查**（不强制；不平衡时提示但不阻塞交付）
- 左右：半页文字量比例 < 6:4
- 上下：上半页与下半页元素面积差 < 2:1
- 仅适用于非图表页与对称设计

**④ 特殊元素（安全区外，不参与排检）**
- 公司 logo：右上角 `(11.5", 0.2")`
- 页脚：底部 0.3" 以内
- 水印：页面中心 45° 倾斜

---

## 4. 最小落地示例（生成代码起点模板）

> 场景：一页 KPI 卡片页（4 个 KPI + 底部趋势图）。拿到布局计划后，生成代码只遍历 slots 填内容，不再写硬编码坐标。

```python
def plan_layout():
    plan = {"slots": [], "gaps_expected": []}

    # 标题栏（固定）
    plan["slots"].append({
        "id": "title", "x": MARGIN, "y": 0.4,
        "w": SW_IN - 2*MARGIN, "h": 0.7,
        "content": "Q2 核心指标全面超预期"
    })

    # 4 个 KPI 卡片（calc_grid 等分）
    kpi_grid = calc_grid(4, SW_IN - 2*MARGIN, GAP)
    kpi_y = CONTENT_TOP + gap_rule("标题→正文")
    kpi_h = 1.2
    for i, (x, w) in enumerate(kpi_grid):
        safe_place(kpi_y, kpi_h)
        plan["slots"].append({"id": f"kpi_{i}", "x": MARGIN + x,
                              "y": kpi_y, "w": w, "h": kpi_h})

    # 记录间距期望值（供排检 ④ 使用）
    plan["gaps_expected"].append({
        "label": "标题→KPI卡片", "a": "title", "b": "kpi_0",
        "expected": gap_rule("标题→正文")
    })

    # 趋势图（下方）
    chart_y = plan["slots"][-1]["y"] + plan["slots"][-1]["h"] + gap_rule("正文段落间")
    plan["slots"].append({
        "id": "trend_chart", "x": MARGIN, "y": safe_place(chart_y, 2.5),
        "w": SW_IN - 2*MARGIN, "h": 2.5, "content": "趋势图"
    })
    return plan
```

**生成代码写法对照：**
```python
# ❌ 旧写法（v3.2 及以前）— 硬编码坐标
x, y = Inches(1.85), Inches(2.5)

# ✅ 新写法（v3.3+）— 从布局计划取值
x, y = slot["x"], slot["y"]
spacing = gap_rule("标题→正文")
safe_place(slot["y"], slot["h"])
```

---

## 5. 生成后五项自动排检（不可跳过）

> 生成 .pptx 后立即运行。**排检不通过不交付。**

| # | 检查项 | 规则 | 报错条件 |
|---|--------|------|---------|
| ① | 边界溢出 | 元素不超出安全区 | right > 13.4" / bottom > 7.6" / left < -0.1" |
| ② | 非预期重叠 | 跳过标题栏/卡片内文字等正常层叠 | 其余交集 > 0.3″ × 0.2″ |
| ③ | KPI卡片完整性 | 卡片内所有子元素不越界 | 圆点 bottom > 卡片 bottom / 文字 right > 卡片 right |
| ④ | 元素间距 | 使用 gap_rule() 查 GAP_RULES 表 | 实际间距与期望值偏差 > 0.05" |
| ⑤ | 内容完整性 | 无空内容页 | 页面无正文/图表/图片内容 |

**排检报告格式（错误提示统一中文，含页/元素定位）：**
```
❌ 排检未通过（第 3 页，共 2 处问题）：
  ① 边界溢出：元素「趋势图」bottom=7.82" > 安全区 7.25"
     （位置：第 3 页 / 元素 trend_chart）
     修法：把 trend_chart 高度从 2.5" 收到 2.0"，或上移 KPI 行。
  ② 间距偏差：标题→KPI卡片 实际=0.10" 期望=0.40"（偏差>0.05"）
     （位置：第 3 页 / 元素 title 与 kpi_0）
     修法：检查 KPI 卡片起始 y 是否漏加了 gap_rule("标题→正文")。
```

---

## 6. 排检脚本模板

```python
class PPTValidator:
    """排检器：边界溢出/非预期重叠/KPI完整性/间距/内容完整性"""
    def __init__(self, pptx_path, gaps_expected=None):
        self.pptx_path = pptx_path
        self.gaps_expected = gaps_expected or []
        self.errors = []      # 每个错误含「页码+元素名+现象+期望」
        self.warnings = []

    def check_overflow(self, slide) -> list:
        """① 边界溢出"""
        errors = []
        for shape in slide.shapes:
            right = shape.left + shape.width
            bottom = shape.top + shape.height
            if right > Inches(13.4):
                errors.append(f"右溢出：{shape.name} right={right/914400:.2f}\"")
            if bottom > Inches(7.6):
                errors.append(f"下溢出：{shape.name} bottom={bottom/914400:.2f}\"")
            if shape.left < Inches(-0.1):
                errors.append(f"左越界：{shape.name} left={shape.left/914400:.2f}\"")
        return errors

    def check_overlap(self, slide) -> list:
        """② 非预期重叠"""
        errors = []
        shapes = [s for s in slide.shapes if s.has_text_frame or s.has_table]
        for i, a in enumerate(shapes):
            for b in shapes[i+1:]:
                overlap_w = max(0, min(a.left+a.width, b.left+b.width) - max(a.left, b.left))
                overlap_h = max(0, min(a.top+a.height, b.top+b.height) - max(a.top, b.top))
                if overlap_w/914400 > 0.3 and overlap_h/914400 > 0.2:
                    errors.append(f"重叠：{a.name} 与 {b.name}")
        return errors

    def _measure_gap(self, slide, a_name, b_name):
        """测量两个形状最近边沿间距（英寸）；找不到返回 0 不阻断"""
        a = b = None
        for s in slide.shapes:
            if s.name == a_name: a = s
            if s.name == b_name: b = s
        if not a or not b:
            return 0
        a_l, a_r = a.left/914400, (a.left+a.width)/914400
        a_t, a_b = a.top/914400, (a.top+a.height)/914400
        b_l, b_r = b.left/914400, (b.left+b.width)/914400
        b_t, b_b = b.top/914400, (b.top+b.height)/914400
        h_gap = min(abs(a_r-b_l), abs(b_r-a_l))
        v_gap = min(abs(a_b-b_t), abs(b_b-a_t))
        return min(h_gap, v_gap)

    def check_kpi_card_integrity(self, slide) -> list:
        """③ KPI 卡片完整性"""
        errors = []
        for shape in slide.shapes:
            if "kpi" not in shape.name.lower() and "card" not in shape.name.lower():
                continue
            if not hasattr(shape, 'left'):
                continue
            card = {'l': shape.left, 'r': shape.left+shape.width,
                    't': shape.top, 'b': shape.top+shape.height}
            for child in slide.shapes:
                if child == shape:
                    continue
                cx = child.left + child.width/2
                cy = child.top + child.height/2
                if not (card['l'] <= cx <= card['r'] and card['t'] <= cy <= card['b']):
                    continue
                if child.left < card['l'] or child.left+child.width > card['r']:
                    errors.append(f"KPI卡片 {shape.name} 内元素 {child.name} 水平越界")
                if child.top < card['t'] or child.top+child.height > card['b']:
                    errors.append(f"KPI卡片 {shape.name} 内元素 {child.name} 垂直越界")
        return errors

    def check_spacing(self, slide, gaps_expected) -> list:
        """④ 元素间距（对照 GAP_RULES 期望值）"""
        errors = []
        for item in gaps_expected:
            actual = self._measure_gap(slide, item["a"], item["b"])
            if abs(actual - item["expected"]) > 0.05:
                errors.append(f"间距：{item['label']} 实际={actual:.2f}\" 期望={item['expected']:.2f}\"")
        return errors

    def check_content_completeness(self) -> list:
        """⑤ 内容完整性（空页检测；图表数据/页码受库能力限制暂跳过）"""
        errors = []
        for idx, slide in enumerate(self.pptx_path.slides):
            has_content = False
            for shape in slide.shapes:
                if hasattr(shape, 'has_text_frame') and shape.has_text_frame and shape.text_frame.text.strip():
                    has_content = True; break
                if hasattr(shape, 'has_table') and shape.has_table:
                    has_content = True; break
                if hasattr(shape, 'has_chart') and shape.has_chart:
                    has_content = True; break
                if shape.shape_type == 13:  # Picture
                    has_content = True; break
            if not has_content:
                errors.append(f"第{idx+1}页：无内容（仅背景/标题）")
        return errors

    def run_all(self) -> bool:
        """运行全部排检，返回 True=通过"""
        for slide in self.pptx_path.slides:
            self.errors.extend(self.check_overflow(slide))
            self.errors.extend(self.check_overlap(slide))
            self.errors.extend(self.check_kpi_card_integrity(slide))
            if self.gaps_expected:
                self.errors.extend(self.check_spacing(slide, self.gaps_expected))
        self.errors.extend(self.check_content_completeness())
        return len(self.errors) == 0
```

---

## 7. 排检失败处理闭环

1. **排检失败** → 不交付 PPT，按第 5 节格式给「页码+元素+现象+修法」
2. **可自动修复** → 调整布局参数重新生成 → 再次排检（最多重试 3 次）
3. **不可自动修复** → 如实向用户报告："第 X 页 {元素名} {问题}，需要手动调整。继续生成其他页还是等你调完？"
4. **排检通过** → 正常交付

---

## 8. 生成精度说明（理想态 vs 实际）

设计规范（design_rules.md）为理想态约束。实际渲染允许以下正常偏差：
- 字号精度：标题/正文比例优先，绝对字号可能有 ±2pt 偏差
- 标点规范：中文标点规则已写入，但引擎可能少数页混入英文标点（生成后自查）
- 对齐精度：左右/上下对齐优先，像素级对齐依赖渲染能力
- 配色精确值：搭配关系优先，具体色值可能有轻微偏移

**建议**：关键场合（融资路演/对外发布）交付前按 design_rules.md 版式禁忌表人工过一遍再定稿。
