# Premium CSS效果库

## Glass Morphism（玻璃拟态）

### 基础玻璃效果
```css
.glass {
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}

/* 深色变体 */
.glass-dark {
    background: rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.1);
}
```

### 高级玻璃效果
```css
.advanced-glass {
    background: linear-gradient(
        135deg,
        rgba(255, 255, 255, 0.15) 0%,
        rgba(255, 255, 255, 0.05) 100%
    );
    backdrop-filter: blur(30px) saturate(200%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 24px;
    box-shadow: 
        0 8px 32px rgba(0, 0, 0, 0.12),
        inset 0 0 0 1px rgba(255, 255, 255, 0.05);
}
```

### 降级处理
```css
@supports not (backdrop-filter: blur(1px)) {
    .glass {
        background: rgba(255, 255, 255, 0.95);
    }
}
```

---

## 主题切换系统

### CSS变量定义
```css
:root {
    /* 浅色主题 */
    --bg-primary: #ffffff;
    --bg-secondary: #f8fafc;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --accent: #3b82f6;
    --border: rgba(0, 0, 0, 0.1);
}

[data-theme="dark"] {
    --bg-primary: #0f172a;
    --bg-secondary: #1e293b;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --accent: #60a5fa;
    --border: rgba(255, 255, 255, 0.1);
}
```

### 平滑过渡
```css
* {
    transition: 
        background-color 0.3s ease,
        color 0.3s ease,
        border-color 0.3s ease;
}

/* 排除不需要过渡的元素 */
.no-transition,
.no-transition * {
    transition: none !important;
}
```

### JavaScript切换
```javascript
function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
}

function initTheme() {
    const saved = localStorage.getItem('theme');
    const system = window.matchMedia('(prefers-color-scheme: dark)').matches 
        ? 'dark' : 'light';
    setTheme(saved || system);
}

// 监听系统主题变化
window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            setTheme(e.matches ? 'dark' : 'light');
        }
    });
```

---

## 高级动画

### 弹性缩放（Magnetic Effect）
```css
.magnetic {
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.magnetic:hover {
    transform: scale(1.05) translateY(-2px);
}

.magnetic:active {
    transform: scale(0.98);
}
```

### 视差滚动
```css
.parallax-container {
    perspective: 10px;
    overflow-x: hidden;
    overflow-y: scroll;
}

.parallax-layer {
    position: absolute;
    transform: translateZ(-10px) scale(2);
}
```

### 渐入动画
```css
.fade-in-up {
    opacity: 0;
    transform: translateY(30px);
    animation: fadeInUp 0.8s ease forwards;
}

@keyframes fadeInUp {
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* 交错延迟 */
.fade-in-up:nth-child(2) { animation-delay: 0.1s; }
.fade-in-up:nth-child(3) { animation-delay: 0.2s; }
```

### 脉冲发光
```css
.pulse-glow {
    animation: pulseGlow 2s ease-in-out infinite;
}

@keyframes pulseGlow {
    0%, 100% {
        box-shadow: 0 0 20px rgba(59, 130, 246, 0.3);
    }
    50% {
        box-shadow: 0 0 40px rgba(59, 130, 246, 0.6);
    }
}
```

---

## 渐变背景

### 主题渐变
```css
.gradient-theme {
    background: linear-gradient(
        135deg,
        #667eea 0%,
        #764ba2 50%,
        #f093fb 100%
    );
    background-size: 200% 200%;
    animation: gradientShift 10s ease infinite;
}

@keyframes gradientShift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
}
```

### 动态光晕
```css
.orb {
    position: absolute;
    border-radius: 50%;
    filter: blur(60px);
    opacity: 0.5;
    animation: float 6s ease-in-out infinite;
}

.orb-1 {
    width: 300px;
    height: 300px;
    background: #6366f1;
    top: 20%;
    left: 30%;
}

.orb-2 {
    width: 200px;
    height: 200px;
    background: #ec4899;
    top: 60%;
    right: 20%;
    animation-delay: -3s;
}

@keyframes float {
    0%, 100% { transform: translate(0, 0); }
    50% { transform: translate(30px, -30px); }
}
```

---

## 有机形状

### Blob动画
```css
.blob {
    border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%;
    animation: morphBlob 8s ease-in-out infinite;
}

@keyframes morphBlob {
    0%, 100% { 
        border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; 
    }
    50% { 
        border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%; 
    }
}
```

### 边框动画
```css
.animated-border {
    position: relative;
    background: #1a1a2e;
    border-radius: 12px;
}

.animated-border::before {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    background: linear-gradient(
        45deg,
        #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00
    );
    background-size: 400%;
    animation: borderGlow 6s linear infinite;
    z-index: -1;
}

@keyframes borderGlow {
    to { background-position: 400% 0; }
}
```

---

## 文字效果

### 渐变文字
```css
.gradient-text {
    background: linear-gradient(
        135deg,
        #667eea 0%,
        #764ba2 100%
    );
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}
```

### 发光文字
```css
.glow-text {
    text-shadow: 
        0 0 10px rgba(102, 126, 234, 0.8),
        0 0 20px rgba(102, 126, 234, 0.6),
        0 0 30px rgba(102, 126, 234, 0.4);
}
```

### 打字效果
```css
.typing {
    overflow: hidden;
    border-right: 2px solid;
    white-space: nowrap;
    animation: typing 3s steps(30) forwards, blink 0.8s step-end infinite;
}

@keyframes typing {
    from { width: 0; }
    to { width: 100%; }
}

@keyframes blink {
    50% { border-color: transparent; }
}
```

---

## 交互反馈

### 涟漪效果
```css
.ripple-container {
    position: relative;
    overflow: hidden;
}

.ripple {
    position: absolute;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.4);
    transform: scale(0);
    animation: rippleEffect 0.6s ease-out;
    pointer-events: none;
}

@keyframes rippleEffect {
    to {
        transform: scale(4);
        opacity: 0;
    }
}
```

### 悬停光效
```css
.hover-glow {
    position: relative;
    overflow: hidden;
}

.hover-glow::after {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: radial-gradient(
        circle,
        rgba(255, 255, 255, 0.3) 0%,
        transparent 70%
    );
    transform: scale(0);
    transition: transform 0.5s ease;
}

.hover-glow:hover::after {
    transform: scale(1);
}
```

---

## 加载动画

### 骨架屏
```css
.skeleton {
    background: linear-gradient(
        90deg,
        #f0f0f0 25%,
        #e0e0e0 50%,
        #f0f0f0 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

/* 深色模式 */
[data-theme="dark"] .skeleton {
    background: linear-gradient(
        90deg,
        #1e1e2e 25%,
        #2a2a3e 50%,
        #1e1e2e 75%
    );
}
```

### 旋转加载
```css
.spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255, 255, 255, 0.1);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}
```

---

## 滚动效果

### 滚动进度条
```css
.scroll-progress {
    position: fixed;
    top: 0;
    left: 0;
    height: 3px;
    background: linear-gradient(90deg, #667eea, #764ba2);
    z-index: 9999;
    transform-origin: left;
    transform: scaleX(0);
    transition: transform 0.1s linear;
}
```

```javascript
window.addEventListener('scroll', () => {
    const scrolled = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrolled / max;
    document.querySelector('.scroll-progress').style.transform = `scaleX(${progress})`;
});
```

### 滚动淡入
```javascript
const observer = new IntersectionObserver(
    (entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    },
    { threshold: 0.1 }
);

// CSS
.fade-element {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease, transform 0.6s ease;
}

.fade-element.visible {
    opacity: 1;
    transform: translateY(0);
}
```

---

## 响应式断点

### 断点定义
```css
/* 移动端优先 */
:root {
    --spacing-sm: 0.5rem;
    --spacing-md: 1rem;
    --spacing-lg: 2rem;
}

/* 平板 */
@media (min-width: 768px) {
    :root {
        --spacing-sm: 1rem;
        --spacing-md: 2rem;
        --spacing-lg: 4rem;
    }
}

/* 桌面 */
@media (min-width: 1024px) {
    :root {
        --spacing-sm: 1.5rem;
        --spacing-md: 3rem;
        --spacing-lg: 6rem;
    }
}
```

---

## 性能技巧

### GPU加速
```css
.gpu-accelerated {
    transform: translateZ(0);
    will-change: transform;
}
```

### 减少重绘
```css
/* 避免 */
.element {
    width: calc(100% - 20px);
}

/* 使用 transform */
.element {
    transform: translateX(-10px); /* 替代 width 变化 */
}
```

### 动画优化
```css
.optimized-animation {
    /* 只动画 transform 和 opacity */
    transform: translateX(0);
    opacity: 1;
    transition: transform 0.3s, opacity 0.3s;
}
```
