# 技术模式库 - Laravel/Livewire/FluxUI

## Laravel开发模式

### 目录结构
```
app/
├── Http/Controllers/     # 控制器
├── Livewire/            # Livewire组件
├── Models/             # Eloquent模型
├── Services/           # 业务逻辑服务
└── View/Components/    # Blade组件
```

### RESTful API设计
```php
// 路由定义
Route::apiResource('posts', PostController::class);

// 控制器方法
public function index() { /* 列表 */ }
public function store(Request $req) { /* 创建 */ }
public function show(Post $post) { /* 详情 */ }
public function update(Request $req, Post $post) { /* 更新 */ }
public function destroy(Post $post) { /* 删除 */ }
```

---

## Livewire组件模式

### 组件创建
```php
// app/Livewire/PremiumNavigation.php
class PremiumNavigation extends Component
{
    public $mobileMenuOpen = false;
    public $theme = 'system';
    
    public function toggleMenu()
    {
        $this->mobileMenuOpen = !$this->mobileMenuOpen;
    }
    
    public function setTheme($theme)
    {
        $this->theme = $theme;
        // 持久化到localStorage
    }
    
    public function render()
    {
        return view('livewire.premium-navigation');
    }
}
```

### 组件使用
```html
<!-- resources/views/livewire/premium-navigation.blade.php -->
<div class="navigation" x-data="{ open: @entangle('mobileMenuOpen') }">
    <button @click="open = !open" class="hamburger">
        <span></span>
    </button>
</div>
```

### 数据绑定
```php
// 文本输入
public $title = '';

// 布尔切换
public $isActive = false;

// 数组选择
public $selected = [];

// 对象/模型
public Post $post;
```

---

## FluxUI组件使用

### 官方文档
```
https://fluxui.dev/docs/components/[component-name]
```

### 常用组件

#### Card
```html
<flux:card class="luxury-glass hover:scale-105 transition-all">
    <flux:heading size="lg">标题</flux:heading>
    <flux:text class="opacity-80">内容</flux:text>
</flux:card>
```

#### Button
```html
<flux:button variant="primary" size="lg">
    主要按钮
</flux:button>

<flux:button variant="secondary" icon="sparkles">
    带图标
</flux:button>
```

#### Input
```html
<flux:input 
    label="邮箱"
    type="email"
    placeholder="请输入邮箱"
    wire:model="email"
/>

<flux:textarea 
    label="留言"
    rows="4"
    wire:model="message"
/>
```

#### Modal
```html
<flux:modal name="confirm-delete">
    <flux:modal.title>确认删除</flux:modal.title>
    <flux:modal.description>此操作无法撤销</flux:modal.description>
    
    <flux:modal.actions>
        <flux:button wire:click="cancel">取消</flux:button>
        <flux:button variant="danger" wire:click="confirm">删除</flux:button>
    </flux:modal.actions>
</flux:modal>
```

#### Theme Toggle
```html
<flux:theme.toggle />
```

---

## Alpine.js集成

### 核心语法
```html
<!-- 数据绑定 -->
<div x-data="{ open: false }">
    <button @click="open = !open">切换</button>
    <div x-show="open">内容</div>
</div>

<!-- 绑定样式 -->
<div :class="{ 'active': isActive }">样式绑定</div>

<!-- 双向绑定 -->
<input x-model="inputValue">

<!-- 过渡动画 -->
<div x-transition:enter="transition ease-out duration-300">
    渐入效果
</div>
```

### 常用指令
| 指令 | 用途 |
|------|------|
| x-data | 组件数据 |
| x-on:* | 事件监听 |
| x-bind:* | 属性绑定 |
| x-show | 条件显示 |
| x-for | 循环渲染 |
| x-transition | 过渡动画 |

---

## 数据库设计

### Eloquent模型
```php
class Post extends Model
{
    protected $fillable = ['title', 'content', 'user_id'];
    
    protected $casts = [
        'published_at' => 'datetime',
        'is_featured' => 'boolean',
    ];
    
    public function author()
    {
        return $this->belongsTo(User::class);
    }
    
    public function tags()
    {
        return $this->belongsToMany(Tag::class);
    }
}
```

### 关系查询
```php
// 一对多
$posts = Post::with('author')->get();

// 多对多
$tags = $post->tags()->pluck('name');

// 排序
$latest = Post::orderBy('created_at', 'desc')->paginate(10);
```

---

## 表单验证

### Form Request
```php
class StorePostRequest extends FormRequest
{
    public function rules()
    {
        return [
            'title' => 'required|max:255',
            'content' => 'required|min:10',
            'tags' => 'array|max:5',
            'tags.*' => 'exists:tags,id',
        ];
    }
    
    public function messages()
    {
        return [
            'title.required' => '标题不能为空',
        ];
    }
}
```

### 前端验证
```html
<flux:input 
    wire:model.live="title"
    :error="$errors->first('title')"
/>
```

---

## 缓存策略

### 缓存层
```php
// 查询缓存
$posts = Cache::remember('posts', 3600, function () {
    return Post::with('author')->get();
});

// 手动清除
Cache::forget('posts');

// 标签缓存
Cache::tags(['posts'])->put('posts', $posts, 3600);
```

---

## 错误处理

### 异常渲染
```php
// app/Exceptions/Handler.php
public function render($request, Throwable $e)
{
    if ($request->expectsJson()) {
        return response()->json([
            'error' => $e->getMessage()
        ], 400);
    }
    
    return parent::render($request, $e);
}
```

### 前端错误展示
```html
<flux:callout variant="danger" icon="exclamation-circle">
    {{ $error }}
</flux:callout>
```
