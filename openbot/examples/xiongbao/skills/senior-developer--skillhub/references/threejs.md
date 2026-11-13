# Three.js集成指南

## 应用场景

| 场景 | 效果 | 性能考量 |
|------|------|---------|
| 粒子背景 | 星空/光点漂浮 | 粒子数控制<1000 |
| 3D产品展示 | 旋转查看/缩放 | 模型优化<500KB |
| 滚动视差 | 深度层次感 | 使用CSS替代 |
| 动画过渡 | 页面切换效果 | GPU加速 |

---

## 基础设置

### CDN引入
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
```

### 基础场景
```javascript
// 创建场景
const scene = new THREE.Scene();

// 创建相机
const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);

// 创建渲染器
const renderer = new THREE.WebGLRenderer({ 
    alpha: true,
    antialias: true 
});
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// 渲染循环
function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}
animate();
```

---

## 粒子系统

### 基础粒子
```javascript
// 粒子几何体
const geometry = new THREE.BufferGeometry();
const vertices = [];

for (let i = 0; i < 500; i++) {
    vertices.push(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
    );
}

geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

// 粒子材质
const material = new THREE.PointsMaterial({
    size: 0.05,
    color: 0x88ccff,
    transparent: true,
    opacity: 0.8,
});

// 创建粒子
const particles = new THREE.Points(geometry, material);
scene.add(particles);

// 动画
function animate() {
    particles.rotation.y += 0.001;
    renderer.render(scene, camera);
}
```

### 交互粒子
```javascript
// 鼠标跟随效果
let mouseX = 0, mouseY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX - window.innerWidth / 2);
    mouseY = (e.clientY - window.innerHeight / 2);
});

function animate() {
    particles.rotation.x += (mouseY * 0.0001 - particles.rotation.x) * 0.1;
    particles.rotation.y += (mouseX * 0.0001 - particles.rotation.y) * 0.1;
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}
```

---

## 3D对象

### 基础几何体
```javascript
// 球体
const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 32),
    new THREE.MeshStandardMaterial({ 
        color: 0x3498db,
        metalness: 0.3,
        roughness: 0.7
    })
);
scene.add(sphere);

// 光照
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const pointLight = new THREE.PointLight(0xffffff, 1);
pointLight.position.set(5, 5, 5);
scene.add(pointLight);

// 交互
let isHovered = false;

renderer.domElement.addEventListener('mousemove', (e) => {
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(sphere);
    
    isHovered = intersects.length > 0;
    sphere.scale.setScalar(isHovered ? 1.2 : 1);
});
```

---

## 性能优化

### 性能检查
```javascript
// 启用性能监控
import { Performance } from 'three/examples/jsm/misc/PerformanceMonitor.js';

const performance = new Performance(scene, renderer);
document.body.appendChild(performance.dom);
```

### 优化策略

#### 1. 减少Draw Calls
```javascript
// 使用 InstancedMesh 代替多个单独对象
const instancedMesh = new THREE.InstancedMesh(geometry, material, 100);

// 更新实例矩阵
const matrix = new THREE.Matrix4();
for (let i = 0; i < 100; i++) {
    matrix.setPosition(Math.random(), Math.random(), Math.random());
    instancedMesh.setMatrixAt(i, matrix);
}
```

#### 2. LOD (Level of Detail)
```javascript
// 不同距离使用不同细节
const lod = new THREE.LOD();
lod.addLevel(highDetailMesh, 0);
lod.addLevel(mediumDetailMesh, 50);
lod.addLevel(lowDetailMesh, 100);
scene.add(lod);
```

#### 3. 视锥剔除
```javascript
// 渲染器启用视锥剔除
renderer.localClippingEnabled = true;
```

---

## 与Alpine.js集成

### 组件封装
```html
<div x-data="{
    init() {
        this.initThree();
    },
    
    initThree() {
        // Three.js 初始化代码
        const scene = new THREE.Scene();
        // ...
    }
}">
    <canvas id='three-canvas'></canvas>
</div>
```

### 响应式处理
```javascript
// 窗口调整
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// 暂停/恢复
x-data="{
    paused: false,
    toggle() {
        this.paused = !this.paused;
        this.paused ? renderer.setAnimationLoop(null) : animate();
    }
}"
```

---

## 移动端适配

### 触摸支持
```javascript
// 触摸拖拽
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enableZoom = true;
controls.enablePan = false;

// 移动端优化
if ('ontouchstart' in window) {
    controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN
    };
}
```

---

## 替代方案

### CSS替代（简单效果）
```css
/* 粒子效果替代 */
.particles {
    background: 
        radial-gradient(1px 1px at 20% 30%, white, transparent),
        radial-gradient(1px 1px at 40% 70%, white, transparent),
        radial-gradient(1px 1px at 60% 20%, white, transparent);
    animation: particles 60s linear infinite;
}

@keyframes particles {
    from { background-position: 0 0; }
    to { background-position: 100% 100%; }
}
```

### Canvas替代（中等复杂度）
```javascript
// 使用原生Canvas代替Three.js
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
```

---

## 加载优化

### 懒加载
```javascript
// 按需加载
async function loadThree() {
    const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js');
    // 初始化代码
}
```

### 进度指示
```javascript
const manager = new THREE.LoadingManager();
manager.onProgress = (url, loaded, total) => {
    const progress = (loaded / total) * 100;
    document.getElementById('progress').style.width = progress + '%';
};
```
