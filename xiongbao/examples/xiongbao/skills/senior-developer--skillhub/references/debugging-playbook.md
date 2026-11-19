# 开发调试实战手册

> 当系统起火时，教科书没教你的实战经验。
> 每个场景都来自真实踩坑。

---

## 一、快速定位问题的「分而治之」法

### 前端问题定位（3分钟原则）

```
问题现象：页面白屏 / 样式错乱 / 交互无响应

第一步：打开DevTools（F12）
  → Console标签页：看红色错误（JS报错）
  → Network标签页：看红色请求（API失败）

第二步：锁定范围
  → 只有某个页面有问题？→ 该页面代码
  → 所有页面都有问题？→ 公共文件（app.js / CSS）
  → 只有某个浏览器有问题？→ 兼容性问题

第三步：二分法注释代码
  → 注释掉一半代码 → 问题还在吗？
  → 还在 → 问题在另一半
  → 不在 → 问题在被注释的一半
  → 重复直到定位到具体代码行
```

### 后端问题定位（Laravel专属）

```php
// Step 1: 看日志
tail -f storage/logs/laravel.log

// Step 2: 在疑似位置加日志
\Log::info('调试点1', ['data' => $data]);
\Log::error('出错啦', ['exception' => $e->getMessage()]);

// Step 3: 用 Telescope（如果装了）
// /telescope 界面可以看到所有请求/查询/异常

// Step 4: dd() 大法（临时调试）
dd($variable); // 打印并终止执行
dump($variable); // 打印但不终止
```

---

## 二、经典「大火」场景应对

### 场景1：生产环境突然500错误

**立即行动（前5分钟）**：

```bash
# 1. 看错误日志（最优先）
tail -100 /path/to/laravel/storage/logs/laravel.log

# 2. 确认是否是代码部署导致
git log --oneline -10  # 看最近10次提交

# 3. 如果是刚部署导致的 → 立即回滚
git revert HEAD
# 或
git reset --hard HEAD~1
```

**排查清单**：
- [ ] `.env` 文件是否正确？（常见问题：数据库密码改了但`.env`没更新）
- [ ] `storage/` 目录权限是否正确？
- [ ] Composer依赖是否安装？`composer install`
- [ ] 缓存是否要清理？`php artisan cache:clear`

**与团队沟通模板**：
> 「生产环境出现500错误，正在排查。初步判断是[原因]，预计[时间]恢复。有进展立即同步。」

### 场景2：数据库被慢查询拖垮

**立即行动**：

```sql
-- 找出慢查询（MySQL）
SHOW FULL PROCESSLIST;

-- 找出执行时间最长的查询
SELECT * FROM information_schema.PROCESSLIST 
WHERE COMMAND != 'Sleep' 
ORDER BY TIME DESC;
```

**常见原因 + 解法**：

| 原因 | 识别方法 | 紧急解法 |
|------|---------|---------|
| 缺少索引 | `EXPLAIN SELECT...` 看type=ALL | 加索引（ALTER TABLE ADD INDEX）|
| N+1问题 | 日志里大量相似查询 | 紧急加`->with()`预加载 |
| 没分页的大量查询 | 一次性取几万条 | 紧急加`->limit(100)`止血 |
| 死锁 | 错误日志有`Deadlock found` | 重试机制 / 缩短事务 |

### 场景3：前端页面完全白屏

**排查步骤**：

```
1. 打开DevTools → Console
   → 有红色错误？→ 根据错误信息修复
   → 没错误？→ 第二步

2. 注释掉所有JS，看页面能否渲染
   → 能渲染 → JS有问题
   → 不能渲染 → HTML/CSS有问题

3. 用二分法定位具体哪段JS/CSS导致问题
```

**常见原因**：
- Vue/Alpine组件初始化失败（模板语法错误）
- 引入的JS库版本冲突
- CSS `display: none !important` 被错误使用

---

## 三、Three.js 专属调试

### 场景：3D场景不显示 / 黑屏

**调试清单**：

```javascript
// 1. 检查WebGL是否支持
if (!WebGLRenderingContext) {
    console.error('浏览器不支持WebGL');
}

// 2. 检查相机位置（最常见错误）
console.log(camera.position); // 相机在场景里面吗？
console.log(camera.lookAt); // 相机在看哪里？

// 3. 检查对象是否真的加进了场景
console.log(scene.children); // 场景里有东西吗？

// 4. 开启Three.js官方调试助手
const axesHelper = new THREE.AxesHelper(5);
scene.add(axesHelper); // 显示坐标轴（帮助判断方向）

const gridHelper = new THREE.GridHelper(10, 10);
scene.add(gridHelper); // 显示网格（帮助判断位置）
```

### 性能问题的快速诊断

```javascript
// 用这个代码片段快速诊断性能瓶颈
function diagnosePerformance() {
    const stats = new Stats();
    stats.showPanel(0); // 0 = fps, 1 = ms, 2 = mb
    document.body.appendChild(stats.dom);
    
    function animate() {
        stats.begin();
        // 你的渲染代码
        stats.end();
        requestAnimationFrame(animate);
    }
    animate();
}
```

---

## 四、Livewire 专属调试

### 常见问题速查

| 现象 | 原因 | 解法 |
|------|------|------|
| 组件不更新 | 属性没加`$this->dispatch()` | 检查属性绑定 |
| 点击无反应 | Alpine.js和Livewire冲突 | 检查`@click` vs `wire:click` |
| 表单提交后白屏 | 验证失败没显示错误 | 加`<flux:callout variant="danger">`显示错误 |
| 轮询导致性能问题 | `wire:poll`间隔太短 | 改成`wire:poll.5s` |

### Livewire 调试模式

```php
// 在组件里加这个，可以看到每次更新的详细信息
protected $updatesQueryString = ['search'];

public function updated()
{
    \Log::info('Livewire updated', [
        'property' => $this->updates,
        'data' => $this->getPublicPropertiesDefinedBySubClass(),
    ]);
}
```

---

## 五、「在我机器上能跑」问题

### 环境差异排查表

| 差异类型 | 检查什么 | 工具 |
|---------|---------|------|
| PHP版本 | `php -v` | 确保开发/生产版本一致 |
| 扩展缺失 | `php -m` | 对比开发/生产扩展列表 |
| 配置文件 | `.env` / `config/` | `config:cache` 是否过期 |
| 数据库结构 | `php artisan migrate:status` | 是否有未运行的迁移 |
| 文件权限 | `ls -la storage/` | `chmod -R 755 storage/` |

### Docker 环境的一致性保证

```dockerfile
# 用Dockerfile锁定版本，避免「版本不一致」问题
FROM php:8.2-fpm
RUN docker-php-ext-install pdo pdo_mysql  # 明确安装扩展
COPY --from=composer:2.6 /usr/bin/composer /usr/bin/composer
```

---

## 六、紧急情况下的「止损」操作

### 数据库被误删/污染

```bash
# 1. 立即切断写入（防止污染扩大）
# 在数据库层面加只读锁，或停掉应用

# 2. 从最新备份恢复
# 如果有binlog，可以恢复到误删前的状态

# 3. 事后复盘
# 为什么能误删？有没有`DROP`权限控制？
```

### 代码被误删（git救援）

```bash
# 找出删除操作
git log --diff-filter=D --summary

# 恢复被删文件
git checkout <commit>^ -- <file_path>

# 如果是最近一次提交导致的
git revert HEAD  # 创建一个「反向提交」
```

---

## 七、调试的「元认知」

### 高效调试的5个习惯

1. **复现第一**：不能稳定复现的Bug = 基本修不好。先花时间找到复现路径。
2. **二分法优于猜测**：与其猜「可能是XX导致的」，不如注释掉一半代码验证。
3. **日志优于dd()**：`dd()`只能看一次，`Log::info()`能留下历史记录。
4. **修Bug时写测试**：防止「修好A，搞坏B」。
5. **复现环境优于直接修生产**：本地复现 → 修 → 测试 → 部署，不要直接改生产。

### 什么时候该寻求帮助

| 你卡了多久 | 该做什么 |
|-----------|---------|
| < 30分钟 | 继续自己查 |
| 30分钟-2小时 | Google/StackOverflow/官方文档 |
| 2-4小时 | 问团队同事 |
| > 4小时 | 发到技术社区/提GitHub Issue/升级到老板 |

**核心原则**：卡住超过半天不求助 = 耽误项目进度 = 你的责任。

---

*调试能力 = 开发者的核心价值之一。写代码人人会，快速定位问题才是真本事。*
