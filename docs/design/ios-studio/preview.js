const paths = {
  grid: '<rect x="3" y="4" width="8" height="7" rx="2"/><rect x="14" y="4" width="7" height="11" rx="2"/><rect x="3" y="14" width="8" height="6" rx="2"/><path d="M15 20h5"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  bolt: '<path d="M13 2 4.5 13h6l-.5 9 9.5-12h-6L13 2Z"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M16 4a3 3 0 0 1 0 6m3 10v-2a5 5 0 0 0-2-4"/>',
  box: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5m-9 5L3 7m9 5v10M7.5 4.5l9 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-.6 2.5-2 1.2L4 6l-2 3.5L4 11v2l-2 1.5L4 18l2.4-.7 2 1.2L9 21h4l.6-2.5 2-1.2 2.4.7 2-3.5-2-1.5v-2l2-1.5L18 6l-2.4.7-2-1.2L13 3Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  flag: '<path d="M5 21V4m0 1c5-5 8 4 14 0v11c-6 4-9-5-14 0"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4m-4 0h8"/>',
  chat: '<path d="M20 11a7 7 0 0 1-7 7H8l-4 3v-6a7 7 0 0 1-1-4 7 7 0 0 1 7-7h3a7 7 0 0 1 7 7Z"/><path d="M8 11h8"/>',
  hash: '<path d="m10 3-4 18M18 3l-4 18M4 9h17M3 15h17"/>',
  robot: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 4v3M9 13v1m6-1v1M2 12v4m20-4v4"/>',
  link: '<path d="m10 8 3-3a4 4 0 0 1 6 6l-3 3m-2 2-3 3a4 4 0 0 1-6-6l3-3m1 5 6-6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10m0-2c0-4 12-1 12-5"/>',
  orbit: '<circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="11" ry="5" transform="rotate(-35 12 12)"/>',
  spark: '<path d="M12 2c1 6 4 9 10 10-6 1-9 4-10 10-1-6-4-9-10-10 6-1 9-4 10-10Z"/>',
  pulse: '<path d="M2 12h4l3-7 4 14 3-7h6"/>',
  puzzle: '<path d="M4 4h6a3 3 0 1 1 5 0h5v5a3 3 0 1 0 0 5v6h-6a3 3 0 1 0-5 0H4v-6a3 3 0 1 0 0-5Z"/>',
  book: '<path d="M5 3h13a1 1 0 0 1 1 1v16H7a3 3 0 0 1-3-3V5a2 2 0 0 1 1-2Zm2 13h12M8 7h7"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11H3V7Z"/>',
  report: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
  shield: '<path d="M12 3 3 7v5c0 5 5 8 9 10 4-2 9-5 9-10V7l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  cloud: '<path d="M7 18h11a4 4 0 0 0 1-8 6 6 0 0 0-11-1 5 5 0 0 0-1 9Z"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
};

const tones = { silver: '#bfbfbf', white: '#ebebeb', graphite: '#969696', red: '#db343b' };
const logo = '熊宝-logo.png';
const bear = '熊宝-头像.png';
const icon = (name, className = '') => `<svg class="icon ${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
const symbol = (name, tone = 'silver') => `<span class="symbol" style="--tone:${tones[tone]}">${icon(name)}</span>`;
const badge = (name, tone = '', dot = false) => `<span class="badge ${tone}">${dot ? '<i class="dot"></i>' : ''}${name}</span>`;
const button = (label, glyph, primary = false) => `<span class="button${primary ? ' primary' : ''}">${glyph ? icon(glyph) : ''}${label}</span>`;
const filter = (label, value) => `<span class="field"><span>${label}&nbsp; <strong>${value}</strong></span>${icon('down')}</span>`;
const search = (label) => `<span class="field search">${icon('search')}${label}</span>`;
const segment = (labels, selected = 0) => `<div class="segment">${labels.map((label, index) => `<span${index === selected ? ' class="on"' : ''}>${label}</span>`).join('')}</div>`;

const staff = [
  { name: '通用助手', role: 'General Assistant', desc: '协助整理信息、撰写内容和处理日常问题', glyph: 'spark', tone: 'silver', tasks: 7, last: '3 天前' },
  { name: '后端工程师', role: 'Backend Engineer', desc: '按需求实现功能、运行测试并提交改动', glyph: 'code', tone: 'white', tasks: 0, last: '—' },
  { name: '代码审核员', role: 'Code Reviewer', desc: '审查差异、边界条件和测试覆盖', glyph: 'shield', tone: 'white', tasks: 0, last: '—' },
  { name: '测试工程师', role: 'QA Engineer', desc: '验证验收条件并记录可复现的问题', glyph: 'check', tone: 'graphite', tasks: 0, last: '—' },
  { name: '运营助手', role: 'Operations', desc: '整理运营数据、跟进进度并汇总结论', glyph: 'pulse', tone: 'red', tasks: 0, last: '—' },
  { name: '我的分身', role: '个人分身', desc: '收集、整理和跟进与你有关的工作', glyph: 'robot', tone: 'red', tasks: 68, last: '46 分钟前', online: true },
];

const pages = {
  tasks: ['任务看板', 'grid', 'WORK RECORD', '查看员工的任务进度，处理待办并查收结果。', '派给群组'],
  waker: ['@Waker', 'at', 'IM WORKSPACE', '将员工接入群聊或私聊，在 IM 中持续承接团队工作。'],
  autonomous: ['自主工作', 'bolt', 'AUTOMATION', '通过定时、事件或 API 自动开工，由员工或 WakerFlow 响应。', '新建自动任务'],
  staff: ['员工管理', 'users', 'DIGITAL TEAM', '选择合适的员工开始任务，或为团队新建一位数字员工。', '新建员工'],
  resources: ['能力与资源', 'box', 'RESOURCE CENTER', '为数字员工接入插件、知识库和自动化流程。'],
};

function avatar(person) {
  return `<span class="avatar" style="--tone:${tones[person.tone]}">${person.online ? `<img src="${bear}" alt="">` : icon(person.glyph)}</span>`;
}

function sidebar(active) {
  const link = (id) => `<a class="nav-link" href="#${id}" ${id === active ? 'aria-current="page"' : ''}>${icon(pages[id][1])}${pages[id][0]}</a>`;
  return `<aside class="sidebar glass">
    <a class="brand" href="#tasks"><img src="${logo}" alt=""><span><strong>熊宝数字员工</strong><small>XIONGBAO WORK</small></span></a>
    <nav aria-label="页面切换"><div class="nav-label">工作管理</div>${link('tasks')}${link('waker')}${link('autonomous')}
      <div class="nav-label second">员工资源</div>${link('staff')}${link('resources')}</nav>
    <div class="rule"></div><div class="side-switch"><span class="on">员工 6</span><span>群组 0</span></div>
    <span class="side-create">${icon('plus')} 新建员工</span>
    <div class="roster">${staff.map((person) => `<div class="person">${avatar(person)}<span><strong>${person.name}</strong><small>${person.role}</small></span>${person.online ? '<i class="dot"></i>' : ''}</div>`).join('')}</div>
    <div class="sidebar-foot"><span class="avatar">F</span><span><strong>我的工作空间</strong><small>熊宝数字员工</small></span>${icon('settings')}</div>
  </aside>`;
}

function chatArt() {
  return `<div class="feature-art chat-stage" aria-hidden="true">
    <div class="chat-shadow"></div>
    <div class="chat-art"><div class="chat-head"><i></i><i></i><i></i><strong>团队群聊</strong><span>IM</span></div>
      <div class="bubble"><b>@员工</b> 把本周客户反馈按优先级整理。</div>
      <div class="reply"><img src="${bear}" alt=""><div><b>熊宝助手</b><p>收到。我会整理成一份带优先级的清单。</p></div></div>
    </div><span class="chat-float">${icon('at')}</span>
    <span class="stage-caption"><i class="dot"></i> 群聊接入演示</span>
  </div>`;
}

function signalArt() {
  return `<div class="feature-art signal-stage" aria-hidden="true">
    <svg viewBox="0 0 520 260" fill="none">
      <defs>
        <linearGradient id="trace"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".52" stop-color="#fff" stop-opacity=".26"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
        <linearGradient id="beam"><stop stop-color="#ed373a" stop-opacity="0"/><stop offset=".45" stop-color="#fa565b"/><stop offset=".66" stop-color="#ffc5c5"/><stop offset="1" stop-color="#ed373a" stop-opacity="0"/></linearGradient>
        <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#3e3f42"/><stop offset=".38" stop-color="#242426"/><stop offset=".74" stop-color="#151517"/><stop offset="1" stop-color="#272729"/></linearGradient>
        <linearGradient id="rim"><stop stop-color="#e3e3e3" stop-opacity=".74"/><stop offset=".44" stop-color="#b0b0b0" stop-opacity=".2"/><stop offset="1" stop-color="#797979" stop-opacity=".5"/></linearGradient>
        <radialGradient id="signal-halo"><stop stop-color="#ea343a" stop-opacity=".26"/><stop offset="1" stop-color="#ea343a" stop-opacity="0"/></radialGradient>
        <filter id="bloom" x="-50%" width="200%" y="-50%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
      </defs>
      <ellipse cx="284" cy="137" rx="190" ry="97" fill="url(#signal-halo)"/>
      <g stroke="url(#trace)">
        <path d="M14 184h96l47-34h169l47-33h131M20 196h94l48-34h168l47-33h135M8 208h110l47-34h169l47-33h123M29 220h93l47-34h168l47-33h119M50 232h76l47-34h169l46-33h116"/>
        <path d="M52 107h66l47 34h164l46 35h120M70 95h52l47 34h164l46 35h125M28 83h98l47 34h164l46 35h106"/>
      </g>
      <path d="M10 196h104l48-34h168l47-33h135" stroke="url(#beam)" stroke-width="7" filter="url(#bloom)"/>
      <path d="M10 196h104l48-34h168l47-33h135" stroke="url(#beam)" stroke-width="1.5"/>
      <g transform="translate(275 128) rotate(-18)">
        <rect x="-59" y="-36" width="118" height="101" rx="24" fill="#121214" stroke="#ffffff" stroke-opacity=".15"/>
        <rect x="-59" y="-51" width="118" height="101" rx="24" fill="url(#metal)" stroke="url(#rim)"/>
        <rect x="-51" y="-43" width="102" height="85" rx="18" stroke="#ffffff" stroke-opacity=".11"/>
        <path d="M-37 47h70" stroke="#fe5257" stroke-width="2"/>
        <path d="m4-24-18 26h14l-4 23 18-28H1l3-21Z" fill="#f7f7f7"/>
      </g>
      <g fill="#fa565b"><circle cx="114" cy="196" r="3"/><circle cx="377" cy="129" r="3"/></g>
      <g fill="#d3d3d3"><circle cx="118" cy="107" r="2"/><circle cx="421" cy="164" r="2"/></g>
      <path d="M411 72h55m-27-11v22M99 151h19m-9-9v18" stroke="#ffffff" stroke-opacity=".24" stroke-dasharray="2 3"/>
    </svg>
    <span class="stage-caption"><i class="dot"></i> TRIGGER → EXECUTE</span>
  </div>`;
}

function hero(id) {
  const [title, , eyebrow, description, action] = pages[id];
  const index = String(Object.keys(pages).indexOf(id) + 1).padStart(2, '0');
  const headline = id === 'waker' ? '在聊天里，<br>让数字员工接手工作' : title;
  return `<section class="hero ${id}">
    <div class="hero-text"><div class="eyebrow"><i></i><span>${index}</span><span>${id === 'waker' ? '@WAKER / ' : ''}${eyebrow}</span></div>
    <h1>${headline}</h1><p>${description}</p>
    ${id === 'waker' ? `<div class="hero-actions below">${button('接入 IM 聊天', 'plus', true)}${button('机器人与账号', 'robot')}${button('自动接入', 'link')}${button('接入申请', 'list')}</div>` : ''}</div>
    ${action ? `<div class="hero-actions">${id === 'staff' ? button('角色模板', 'layers') : ''}${button(action, id === 'tasks' ? 'users' : 'plus', true)}</div>` : ''}
    ${id === 'waker' ? chatArt() : ''}${id === 'autonomous' ? signalArt() : ''}
  </section>`;
}

function stats(items, selected = -1) {
  return `<div class="stat-grid">${items.map(([value, title, glyph, tone, desc], index) => `<article class="stat ${selected === index ? 'selected' : ''}" style="--tone:${tones[tone]}">
    ${symbol(glyph, tone)}<strong>${value}</strong><span>${title}</span>${desc ? `<small>${desc}</small>` : ''}</article>`).join('')}</div>`;
}

function taskRows(items) {
  return `<div class="row-stack glass">${items.map(([title, info, status, glyph, tone, statusTone]) => `<div class="task-row">${symbol(glyph, tone)}<div><strong>${title}</strong><small>${info}</small></div>${badge(status, statusTone)}${icon('chevron')}</div>`).join('')}</div>`;
}

function tasks() {
  return `<section class="section panel telemetry glass">
    <div class="section-head"><h2>${icon('pulse')}工作记录</h2><div class="controls">${filter('设备', '全部')}${filter('数据周期', '一个月')}</div></div>
    ${stats([[75, '任务总数', 'grid', 'silver'], [6, '进行中任务', 'pulse', 'white'], [0, '需要操作', 'flag', 'red'], [69, '已结束任务', 'check', 'white']], 0)}
    <div class="telemetry-footer"><div class="distribution"><div class="distribution-label"><span>任务状态分布</span><strong>92% 已结束</strong></div><div class="distribution-bar" aria-label="6 个进行中，69 个已结束"><i></i><i></i></div></div>
      <div class="summary"><span class="dot"></span><span><b>2</b> 位员工参与</span><span>设备 <b>1/1</b> 在线</span></div></div>
  </section>
  <section class="section"><div class="section-head"><h2>待关注</h2>${segment(['需要操作  5', '查收结果  64'])}</div>
    ${taskRows([
      ['核对本周客户反馈的归类结果', '运营助手 · 对话触发 · 10 分钟前', '已结束 · 失败', 'report', 'graphite', 'alert'],
      ['检查服务接口回归测试结果', '测试工程师 · 对话触发 · 28 分钟前', '已结束 · 失败', 'shield', 'red', 'alert'],
      ['整理工作区文件索引', '我的分身 · 对话触发 · 46 分钟前', '已结束 · 失败', 'folder', 'silver', 'alert'],
    ])}
  </section>
  <section class="section"><div class="section-head"><h2>全部任务</h2>${segment([`${icon('list')}列表`, `${icon('layers')}泳道`])}</div>
    <div class="controls">${search('搜索任务、员工或群组')}${filter('员工 / 群组', '全部')}${filter('触发方式', '全部')}${filter('任务状态', '全部')}${filter('周期', '一个月')}</div>
    <div style="margin-top:9px">${taskRows([['同步设备可用应用列表', '我的分身 · 对话触发 · 刚刚', '进行中', 'monitor', 'white', 'accent']])}</div>
  </section>`;
}

function empty(glyph, title, desc, action) {
  return `<div class="empty glass"><div><span class="signal">${glyph === 'bear' ? `<img src="${bear}" alt="熊宝">` : icon(glyph)}</span><h3>${title}</h3><p>${desc}</p>${action ? button(action, 'plus') : ''}</div></div>`;
}

function waker() {
  return `<section class="section"><div class="section-head"><h2>${icon('link')}已接入的聊天</h2>${segment([`${icon('list')}列表`, `${icon('grid')}卡片`])}</div>
    <div class="controls">${search('搜索聊天、员工或 WakerFlow')}${filter('聊天类型', '全部')}${filter('模型', '全部')}${filter('状态', '全部')}</div>
    <div class="chat-table glass" style="margin-top:10px"><div class="table-head">${['聊天','IM 连接','执行目标','工作目录','模型','聊天状态','操作'].map((title) => `<span>${title}</span>`).join('')}</div>
    ${empty('bear', '还没有接入 IM 聊天', '选择机器人或账号、群聊或私聊，以及负责响应的数字员工。', '接入 IM 聊天')}</div>
  </section>
  <section class="section"><div class="section-head"><h2>${icon('pulse')}最近送达</h2></div><div class="delivery glass">${symbol('chat', 'white')} 暂无投递记录</div></section>`;
}

function autonomous() {
  const triggers = [['定时触发', '按设定时间执行例行工作', 'clock', 'white'], ['事件触发', '收到指定事件后启动任务', 'bolt', 'graphite'], ['API 触发', '由外部系统请求启动任务', 'code', 'silver']];
  return `<section class="section panel automation-stats glass"><div class="section-head"><h2>${icon('pulse')}自动任务概览</h2></div>
    ${stats([[0,'自动任务总数','grid','silver','全部自动任务'], [0,'已启用','check','white','正在生效的自动任务'], [0,'员工执行','robot','graphite','交由数字员工执行'], [0,'WakerFlow 执行','branch','white','交由流程执行']])}</section>
  <section class="section"><div class="section-head"><h2>自动任务</h2>${button('按员工查看', 'users')}</div>
    <div class="controls">${search('搜索任务名称')}${filter('执行者','全部')}${filter('触发类型','全部')}${filter('状态','全部')}${filter('排序','最近创建')}</div>
    <div style="margin-top:10px">${empty('bolt', '还没有自动任务', '新建任务后，系统会在触发条件满足时自动执行。', '新建自动任务')}</div>
  </section>
  <section class="section"><div class="section-head"><h2>触发方式</h2></div><div class="trigger-grid glass">${triggers.map(([title, desc, glyph, tone], index) => `<div class="trigger">${symbol(glyph, tone)}<div><b>${title}</b><p>${desc}</p></div><span class="index">0${index + 1}</span></div>`).join('')}</div></section>`;
}

function employees() {
  return `<section class="section"><div class="section-head">${segment(['员工  6','群组  0'])}${badge('6 名员工', 'accent')}</div>
    <div class="controls">${search('搜索名称或角色')}${filter('运行状态','全部')}${filter('角色','全部角色')}${filter('环境','全部环境')}${filter('排序','默认排序')}</div>
    <div class="staff-grid">
      ${staff.map((person, index) => `<article class="staff-card glass${person.online ? ' personal' : ''}">
        <div class="status-row"><span class="index">PROFILE / 0${index + 1}</span>${badge(person.online ? '在线 · 本地' : '休息', person.online ? 'status' : '', person.online)}</div>
        <div class="identity">${avatar(person)}<div><h3>${person.name}</h3><span class="role">${person.role}</span></div></div><p>${person.desc}</p>
        <div class="staff-foot"><span>任务数 <b>${person.tasks}</b></span><span>最近运行 <b>${person.last}</b></span></div>
      </article>`).join('')}
    </div>
  </section>`;
}

function resources() {
  const sections = [['插件', 'puzzle', 'silver'], ['技能', 'spark', 'graphite'], ['连接器', 'link', 'white'], ['知识库', 'book', 'white'], ['WakerFlow', 'branch', 'red'], ['公开项目', 'folder', 'red']];
  const plugins = [
    ['Parallel Search', '公开网络搜索与来源提取。', 'Parallel', 'globe', 'graphite'],
    ['Parallel Search（API 密钥）', '使用已配置的 API 密钥搜索公开网络。', 'Parallel', 'globe', 'silver'],
    ['Google Drive', '读取已授权的 Google Drive 文件。', 'Google', 'folder', 'white'],
    ['百度网盘', '读取提问者已授权的网盘文件。', '百度', 'cloud', 'white', true],
    ['Notion', '查询页面与数据库。', 'Notion', 'book', 'graphite'],
    ['例行任务', '按计划运行预先设定的指令。', 'OpenBot', 'clock', 'red'],
  ];
  return `<section class="section"><div class="section-head"><h2>资源入口</h2><span class="summary" style="margin:0">模型库 · 组件 · 信息源与记忆</span></div>
    <div class="resource-tabs glass">${sections.map(([label, glyph, tone], index) => `<div class="resource-tab ${index === 0 ? 'selected' : ''}">${symbol(glyph, tone)}<strong>${label}</strong>${icon('arrow')}</div>`).join('')}</div>
  </section>
  <section class="section"><div class="section-head">${segment(['插件市场  6','我的插件  1'])}${button('管理插件', 'settings')}</div>
    <div class="market"><aside class="categories glass">${search('搜索插件')}${[['全部', 6], ['个人账号', 3], ['团队凭据', 1], ['内置能力', 1], ['免凭据', 1]].map(([label,count], index) => `<div class="category ${index === 0 ? 'on' : ''}"><span>${label}</span><span>${count}</span></div>`).join('')}</aside>
      <div><div class="section-head"><h2>全部分类</h2>${badge('6 个插件')}</div><div class="plugin-grid">${plugins.map(([label,desc,author,glyph,tone,authorized]) => `<article class="plugin-card glass">
        <div class="plugin-name">${symbol(glyph,tone)}<strong>${label}</strong></div><p>${desc}</p><div class="plugin-foot"><span>@${author}</span>${badge(authorized ? '已授权' : '未安装', authorized ? 'status' : '')}</div></article>`).join('')}</div></div>
    </div>
  </section>`;
}

const content = { tasks, waker, autonomous, staff: employees, resources };

function render() {
  const requested = location.hash.slice(1);
  const active = Object.hasOwn(pages, requested) ? requested : 'tasks';
  document.title = `${pages[active][0]} · 熊宝数字员工 · 效果预览`;
  document.getElementById('app').innerHTML = `${sidebar(active)}<main class="main ${active}-page">
    <header class="toolbar"><div class="crumb">${icon('orbit')} 工作台 ${icon('chevron')} <strong>${pages[active][0]}</strong></div>
    <div class="toolbar-right"><span class="preview-mark"><i></i> 设计预览</span><div class="dock"><img src="${logo}" alt=""><span>熊宝小管家</span></div></div></header>
    ${hero(active)}${content[active]()}</main>`;
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
