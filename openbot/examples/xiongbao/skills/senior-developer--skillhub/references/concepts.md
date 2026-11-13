# 高级开发工程师 - 核心概念

## 身份与定位

### 谁是高级开发工程师？
- **角色**: Senior Developer（高级开发工程师）
- **性格**: 创意驱动、细节导向、性能优先、创新超越
- **记忆**: 持续学习，记住成功模式和常见陷阱

### 核心专长
1. **Laravel/Livewire/FluxUI** - 全栈应用开发
2. **Three.js** - 3D/粒子/WebGL沉浸式体验
3. **高级CSS** - Glass morphism、有机形状、Premium动画
4. **性能优化** - 60fps、<1.5s加载、优雅降级

---

## 技术栈概览

### Laravel生态
```
Laravel → 后端框架，PHP最佳实践
  └─ Livewire → 交互式组件，类Vue体验
      └─ FluxUI → UI组件库，Premium设计
```

### 前端技术
```
Three.js → 3D渲染，粒子系统
  └─ WebGL → 底层渲染
  └─ GSAP → 高级动画
  └─ IntersectionObserver → 滚动动画
```

### CSS技术
```
CSS Variables → 主题系统
  └─ backdrop-filter → 玻璃效果
  └─ clip-path → 有机形状
  └─ @keyframes → 流畅动画
  └─ cubic-bezier → 高级缓动
```

---

## Premium设计理念

### 什么是Premium？
- 每个像素都经过深思熟虑
- 流畅动画和微交互是必须的
- 性能和美学必须共存
- 创新超越常规但不牺牲可用性

### Premium vs Basic
| 维度 | Basic | Premium |
|------|-------|---------|
| 动画 | 无或生硬 | 流畅60fps |
| 交互 | 点击跳转 | 磁吸+微交互 |
| 主题 | 固定 | Light/Dark/System |
| 加载 | 3s+ | <1.5s |
| 细节 | 忽视 | 像素级打磨 |

---

## 性能优化标准

### 核心指标
- **FCP**: First Contentful Paint < 1.8s
- **LCP**: Largest Contentful Paint < 2.5s
- **CLS**: Cumulative Layout Shift < 0.1
- **FID**: First Input Delay < 100ms

### 优化策略
1. **关键CSS内联** - 首屏样式立即加载
2. **图片优化** - WebP/AVIF，懒加载
3. **代码分割** - 按需加载JS
4. **CDN加速** - 静态资源全球化

---

## 浏览器兼容策略

### 分层支持
1. **现代浏览器** - 全特效，渐进增强
2. **降级方案** - 不支持特性提供替代
3. **优雅降级** - 核心功能保留，美学简化

### 关键降级
```css
/* 现代浏览器 */
.glass-effect {
  backdrop-filter: blur(20px);
  background: rgba(255,255,255,0.1);
}

/* 降级方案 */
@supports not (backdrop-filter: blur(1px)) {
  .glass-effect {
    background: rgba(255,255,255,0.95);
  }
}
```

---

## 无障碍标准

### WCAG 2.1 AA
- **对比度**: 文字与背景 ≥ 4.5:1
- **焦点可见**: 键盘导航焦点清晰
- **语义化**: 正确的HTML语义结构
- **ARIA**: 动态内容正确标注

---

## 文件结构规范

```
高级开发工程师/
├── SKILL.md              # 主文件（≤100行）
└── references/
    ├── concepts.md       # 核心概念（本文件）
    ├── patterns.md       # 技术模式
    ├── threejs.md        # Three.js指南
    └── css-effects.md    # CSS效果库
```
