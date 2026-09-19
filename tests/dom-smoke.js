/**
 * 见仁建智 · 无头 UI 冒烟测试
 * ---------------------------------------------------------------------------
 * 运行：node tests/dom-smoke.js
 *
 * 为什么需要它：核心逻辑有 75 个契约测试兜底，但"页面能不能跑起来"始终没有
 * 自动化覆盖——而演示当天第一个死掉的往往正是 UI 层（少了个 id、选择器拼错、
 * 事件字段改名）。这里用一个极小的 DOM 垫片把这层也纳入回归。
 *
 * 刻意不引入 jsdom：这是一份要能双击打开、断网可用的交付物，测试依赖也应
 * 保持零安装。垫片只实现代码实际用到的那部分 DOM 语义。
 */
'use strict';

const fs = require('fs');

/* ==========================================================================
   一、极简 DOM 垫片
   ========================================================================== */
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...cs) { cs.forEach(c => c && this.set.add(c)); this._sync(); }
  remove(...cs) { cs.forEach(c => this.set.delete(c)); this._sync(); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    this._sync();
    return on;
  }
  _sync() { this.el._className = Array.from(this.set).join(' '); }
  toString() { return Array.from(this.set).join(' '); }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._className = '';
    this._text = '';
    this._listeners = {};
    this.value = '';
    this.disabled = false;
    this.classList = new ClassList(this);
    this.nodeType = 1;
  }

  get className() { return this._className; }
  set className(v) {
    this._className = String(v || '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  // id 必须同步进 attributes，否则选择器 '#foo' 匹配不到（真实 DOM 也是同一份状态）
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }

  get firstChild() { return this.children[0] || null; }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children.length = 0; }

  get innerHTML() { return this._html || this.textContent; }
  set innerHTML(v) {
    const html = String(v == null ? '' : v);
    this._html = html;
    this._text = '';
    this.children.length = 0;
    parseHTML(html).forEach(n => { this.children.push(n); if (n.parentNode == null) n.parentNode = this; });
  }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) { this.children.splice(i, 1); node.parentNode = null; }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = v;
    if (k === 'id') this.id = String(v);
    if (k.indexOf('data-') === 0) {
      const key = k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  hasAttribute(k) { return this.attributes[k] !== undefined; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
  }
  dispatch(type, ev) { (this._listeners[type] || []).forEach(fn => fn(ev || { type, target: this })); }

  /** 仅供布局类代码使用；垫片里所有元素尺寸为零 */
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  scrollIntoView() { /* no-op */ }
  focus() { /* no-op */ }
  select() { /* no-op */ }
  click() { this.dispatch('click'); }

  /* ---------- 选择器 ---------- */
  matches(sel) {
    sel = sel.trim();
    if (!sel) return false;
    return sel.split(',').some(part => this._matchesSimple(part.trim()));
  }
  _matchesSimple(sel) {
    if (!sel) return false;
    // 支持 tag / .class / #id / [attr="v"] / 以及它们的组合
    const tokens = sel.match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/g);
    if (!tokens) return false;
    return tokens.every(tok => {
      if (tok[0] === '.') return this.classList.contains(tok.slice(1));
      if (tok[0] === '#') return this.id === tok.slice(1);
      if (tok[0] === '[') {
        const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(tok);
        if (!m) return false;
        return m[2] === undefined ? this.hasAttribute(m[1]) : this.getAttribute(m[1]) === m[2];
      }
      return this.tagName === tok.toUpperCase();
    });
  }
  _walk(out) {
    this.children.forEach(c => { if (c.nodeType === 1) { out.push(c); c._walk(out); } });
    return out;
  }
  querySelectorAll(sel) { return this._walk([]).filter(n => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class TextNode extends Node {
  constructor(text) { super('#text'); this.nodeType = 3; this._text = String(text); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

/**
 * 极简 HTML 解析：只处理 mdToHtml 产出的那几类标签（h4/h5/p/ul/li/b）。
 * 目的是让"报告里到底有没有这段文字"可被断言，不追求完整 HTML 语义。
 */
function parseHTML(html) {
  const nodes = [];
  const stack = [{ node: null, children: nodes }];
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
  let last = 0, m;
  while ((m = re.exec(html)) !== null) {
    const text = html.slice(last, m.index);
    if (text.trim()) {
      const top = stack[stack.length - 1];
      const tn = new TextNode(decodeEntities(text));
      top.children.push(tn);
      if (top.node) tn.parentNode = top.node;
    }
    last = re.lastIndex;
    const isClose = m[0][1] === '/';
    const tag = m[1].toLowerCase();
    if (isClose) {
      if (stack.length > 1) stack.pop();
    } else {
      const el = new Node(tag);
      const top = stack[stack.length - 1];
      top.children.push(el);
      if (top.node) el.parentNode = top.node;
      stack.push({ node: el, children: el.children });
    }
  }
  const tail = html.slice(last);
  if (tail.trim()) {
    const top = stack[stack.length - 1];
    const tn = new TextNode(decodeEntities(tail));
    top.children.push(tn);
    if (top.node) tn.parentNode = top.node;
  }
  return nodes;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ==========================================================================
   二、装配全局环境（必须在加载 UI 脚本之前）
   ========================================================================== */
const document = new Node('#document');
document.documentElement = new Node('html');
document.body = new Node('body');
document.createElement = tag => new Node(tag);
document.createElementNS = (ns, tag) => new Node(tag);
document.createTextNode = t => new TextNode(t);
document.addEventListener = (t, fn) => Node.prototype.addEventListener.call(document, t, fn);
// document 自身的 _walk 只看子节点，会把 <html> 里的内容全漏掉，
// 因此 document 级查询必须从 documentElement 起遍历（真实 DOM 也是这个语义）
document.querySelectorAll = sel => Node.prototype.querySelectorAll.call(document.documentElement, sel);
document.querySelector = sel => Node.prototype.querySelectorAll.call(document.documentElement, sel)[0] || null;
document.execCommand = () => true;
// 注意：必须在 parseHTML 定义之后再挂 body，否则 innerHTML 的解析路径会命中 TDZ
document.documentElement.appendChild(document.body);

const registry = {};   // id -> element
const ORIGINAL_APPEND = Node.prototype.appendChild;
Node.prototype.appendChild = function (node) {
  const r = ORIGINAL_APPEND.call(this, node);
  registerIds(node);
  return r;
};
function registerIds(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.id) registry[node.id] = node;
  node.children.forEach(registerIds);
}

const localStorageStore = {};
const listeners = {};

globalThis.window = globalThis;
globalThis.document = document;
globalThis.Node = Node;
// Node 21+ 自带只读的 navigator，必须用 defineProperty 覆盖
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: null, userAgent: 'node-dom-shim' },
    configurable: true, writable: true
  });
} catch (e) {
  globalThis.navigator.clipboard = null;
}
globalThis.localStorage = {
  getItem: k => (k in localStorageStore ? localStorageStore[k] : null),
  setItem: (k, v) => { localStorageStore[k] = String(v); },
  removeItem: k => { delete localStorageStore[k]; }
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = () => 'blob:shim';
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = globalThis.Blob || function () {};
globalThis.setTimeout = globalThis.setTimeout;

/* ==========================================================================
   三、加载全部前端脚本（顺序与 index.html 一致）
   ========================================================================== */
const SCRIPTS = [
  'js/data/project.js',
  'js/data/knowledge.js',
  'js/core/tools.js',
  'js/core/llm.js',
  'js/core/prompts.js',
  'js/core/agent.js',
  'js/core/orchestrator.js',
  'js/config.js',
  'js/ui/util.js',
  'js/ui/render.js',
  'js/ui/twin.js',
  'js/ui/canvas.js',
  'js/ui/trace.js',
  'js/ui/report.js',
  'js/app.js'
];

/* 按 index.html 的静态结构把关键挂载点建出来 */
const MOUNT_IDS = [
  'twinPanel', 'canvasPanel', 'tracePanel', 'reportPanel',
  'goalInput', 'runBtn', 'resetBtn', 'paceInput', 'scenarioChips', 'sysInfo',
  'providerBadge', 'settingsMask', 'settingsClose', 'presetSelect', 'providerSelect',
  'baseUrlInput', 'modelInput', 'apiKeyInput', 'maxStepsInput',
  'saveSettings', 'testSettings', 'testResult'
];

/* ==========================================================================
   四、断言
   ========================================================================== */
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { failed++; failures.push({ name, message: e.message }); console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

(async function main() {
  console.log('\n\x1b[36m▸ DOM 垫片 · 加载前端脚本\x1b[0m');

  // index.html 里 id 必须真实存在，否则 app.js 的 $('#x') 会在启动时炸掉
  const html = fs.readFileSync('index.html', 'utf8');
  const htmlIds = new Set(Array.from(html.matchAll(/id="([^"]+)"/g)).map(m => m[1]));

  test('index.html 引用的脚本文件全部存在且顺序与测试一致', () => {
    const srcs = Array.from(html.matchAll(/<script src="([^"]+)"><\/script>/g)).map(m => m[1]);
    assert(srcs.length > 0, 'index.html 未引用任何脚本');
    srcs.forEach(s => assert(fs.existsSync(s), 'index.html 引用了不存在的文件：' + s));
    assert(JSON.stringify(srcs) === JSON.stringify(SCRIPTS),
      'index.html 的脚本顺序与 dom-smoke 不一致：\n  html: ' + srcs.join(', ') + '\n  test: ' + SCRIPTS.join(', '));
  });

  test('app.js 需要的挂载点都在 index.html 中存在', () => {
    const css = fs.readFileSync('styles.css', 'utf8');
    MOUNT_IDS.forEach(id => {
      assert(htmlIds.has(id), 'index.html 缺少 id="' + id + '"（app.js 会取不到）');
    });
    assert(/\.topbar/.test(css) || html.includes('class="topbar"'), 'index.html 缺少 topbar 结构');
  });

  test('所有样式类名都在 styles.css 中有定义或属于状态类', () => {
    const css = fs.readFileSync('styles.css', 'utf8');
    const classNames = new Set();
    SCRIPTS.forEach(f => {
      const src = fs.readFileSync(f, 'utf8');
      Array.from(src.matchAll(/class:\s*'([^']+)'/g)).forEach(m => {
        m[1].split(/\s+/).filter(Boolean).forEach(c => classNames.add(c));
      });
      Array.from(src.matchAll(/h\('[a-z]+',\s*\{\s*class:\s*'([^']+)'/g)).forEach(m => {
        m[1].split(/\s+/).filter(Boolean).forEach(c => classNames.add(c));
      });
    });
    const missing = Array.from(classNames).filter(c => {
      if (/^is-|^cv-|^tp-|^tr-|^rp-|^dt-/.test(c)) return false;   // 状态/前缀类允许动态拼接
      return !new RegExp('\\.' + c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '(?![\\w-])').test(css);
    });
    assert(missing.length === 0, 'styles.css 缺少这些类：' + missing.join('、'));
  });

  for (const f of SCRIPTS) {
    test('加载并执行 ' + f, () => {
      const code = fs.readFileSync(f, 'utf8');
      (0, eval)(code);
    });
  }

  test('全局命名空间按约定挂载', () => {
    ['JR_DATA', 'JR_KB', 'JR_TOOLS', 'JR_LLM', 'JR_PROMPTS', 'JR_AGENT', 'JR_ORCHESTRATOR',
      'JR_CONFIG', 'JR_UI', 'JR_RENDER', 'JR_TWIN', 'JR_CANVAS', 'JR_TRACE', 'JR_REPORT'].forEach(ns => {
      assert(globalThis[ns], '缺少全局命名空间 ' + ns);
    });
  });

  console.log('\n\x1b[36m▸ 应用启动（DOMContentLoaded）\x1b[0m');

  // 建立挂载点并派发 DOMContentLoaded
  MOUNT_IDS.forEach(id => { const el = new Node('div'); el.id = id; document.body.appendChild(el); });
  const goalInput = registry['goalInput'];
  goalInput.value = 'C3 栋 15 层吊装进度滞后，请给出抢工方案并确认安全条件';

  await atest('boot() 执行不抛异常', async () => {
    try {
      document.dispatch('DOMContentLoaded');
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      throw new Error(e.message + '\n      ' + String(e.stack || '').split('\n').slice(1, 5).join('\n      '));
    }
    assert(registry['twinPanel'], '挂载点 twinPanel 未注册（垫片问题）');
  });

  test('数字孪生面板已渲染出作业面与组串', () => {
    const twin = registry['twinPanel'];
    assert(twin.textContent.length > 0, 'twinPanel 为空');
    const modules = twin.querySelectorAll('[data-module]');
    assert(modules.length >= 4, '应渲染出 MiC 模块卡片，实际 ' + modules.length);
    const strings = twin.querySelectorAll('[data-string]');
    assert(strings.length === 4, '应渲染出 4 个 BIPV 组串，实际 ' + strings.length);
    assert(twin.querySelectorAll('[data-defect]').length === 3, '应渲染出 3 条缺陷台账');
  });

  test('场景快捷按钮与系统构成已渲染', () => {
    assert(registry['scenarioChips'].children.length >= 5, '应有至少 5 个场景按钮');
    assert(registry['sysInfo'].textContent.includes('工具'), '系统构成应显示工具数量');
    assert(registry['providerBadge'].textContent.includes('离线'), '默认应显示离线推理');
  });

  console.log('\n\x1b[36m▸ 点击「启动多智能体编排」全链路\x1b[0m');

  /**
   * 等待一次运行真正播放完。
   * 不能用"报告出现某段文字"当条件：报告是编排一结束就渲染的，而轨迹面板
   * 还在按演示节奏逐条播放事件。唯一可靠的完成信号是运行按钮重新变为可用。
   */
  async function waitIdle(maxMs) {
    const limit = maxMs || 20000;
    const t0 = Date.now();
    while (registry['runBtn'].disabled && Date.now() - t0 < limit) {
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 30));
    return !registry['runBtn'].disabled;
  }

  await atest('一次完整运行能渲染出编排画布、推理轨迹与综合报告', async () => {
    registry['paceInput'].value = '0';
    registry['paceInput'].dispatch('change');
    goalInput.value = 'C3 栋 15 层吊装进度滞后，请给出抢工方案并确认安全条件';
    registry['runBtn'].dispatch('click');
    assert(registry['runBtn'].disabled === true, '点击后按钮应进入编排中状态');

    const idle = await waitIdle();
    assert(idle, '运行未在超时内结束（事件泵未排空）');

    const canvas = registry['canvasPanel'];
    const trace = registry['tracePanel'];
    const report = registry['reportPanel'];

    const cards = canvas.querySelectorAll('[data-task]');
    assert(cards.length >= 2, '编排画布应渲染出任务卡，实际 ' + cards.length);
    assert(canvas.textContent.includes('调度中枢'), '画布应包含中枢节点');
    assert(canvas.textContent.includes('已完成'), '任务完成后卡片应标记已完成');

    assert(/thought/.test(trace.textContent), '推理轨迹应包含 thought 标签');
    assert(/observation/.test(trace.textContent), '推理轨迹应包含 observation 标签');
    assert(/action/.test(trace.textContent), '推理轨迹应包含 action 标签');

    assert(report.textContent.includes('一、结论摘要'), '报告应包含结论摘要');
    assert(report.textContent.includes('二、跨域关联'), '报告应包含跨域关联');
    assert(report.textContent.includes('三、建议动作'), '报告应包含建议动作');
    assert(report.textContent.includes('四、需人工确认事项'), '报告应包含需人工确认事项');
    assert(report.textContent.includes('建议动作清单'), '报告应包含建议动作清单卡片');
    assert(report.textContent.includes('证据台账'), '报告应包含证据台账');
    assert(report.textContent.includes('任务拆解依据'), '报告应包含任务拆解依据');
  });

  await atest('推理轨迹确实累积到多步并显示工具标签', async () => {
    const trace = registry['tracePanel'];
    const counter = registry['tpCounter'];
    const steps = parseInt((counter.textContent || '0').replace(/\D/g, ''), 10);
    assert(steps >= 8, '轨迹步数应累积到 8 步以上，实际 ' + steps);
    // schedule_predict 的表格应带出数据平台里的真实工序名
    assert(/MiC 吊装/.test(trace.textContent), '轨迹应出现数据平台里的工序名');
    assert(/最大延期/.test(trace.textContent), '轨迹应出现进度预测摘要');
  });

  await atest('数字孪生高亮：工具调用后对应构件被打上 is-flash', async () => {
    const twin = registry['twinPanel'];
    const flashed = twin.querySelectorAll('.is-flash');
    assert(flashed.length > 0, '至少有一个构件/组串被高亮（工具调用映射到现场位置）');
  });

  console.log('\n\x1b[36m▸ 交互与容错\x1b[0m');

  await atest('空目标不触发运行、不抛异常', async () => {
    await waitIdle();
    registry['resetBtn'].dispatch('click');
    goalInput.value = '   ';
    registry['runBtn'].dispatch('click');
    await new Promise(r => setTimeout(r, 30));
    assert(registry['runBtn'].disabled === false, '空目标应立即返回，按钮保持可用');
  });

  await atest('运行中重复点击不会并发启动第二轮', async () => {
    await waitIdle();
    registry['resetBtn'].dispatch('click');
    goalInput.value = '请对 C3 栋 15 层作业面做一次多模态安全巡检';
    registry['paceInput'].value = '180';
    registry['paceInput'].dispatch('change');
    registry['runBtn'].dispatch('click');
    assert(registry['runBtn'].disabled === true, '第一轮应处于编排中');
    registry['runBtn'].dispatch('click');   // 第二次点击必须被忽略
    const idle = await waitIdle();
    assert(idle, '不应卡在编排中');
    // 只有一轮的事件被消费：轨迹里每类阶段日志只出现一次「接收目标」
    const trace = registry['tracePanel'].textContent;
    const receiveCount = (trace.match(/收到现场目标/g) || []).length;
    assert(receiveCount === 1, '并发保护失效，轨迹里出现了 ' + receiveCount + ' 次接收目标');
    registry['paceInput'].value = '0';
    registry['paceInput'].dispatch('change');
  });

  await atest('重置按钮清空三个面板', async () => {
    await waitIdle();
    registry['resetBtn'].dispatch('click');
    await new Promise(r => setTimeout(r, 20));
    assert(registry['canvasPanel'].querySelectorAll('[data-task]').length === 0, '重置后画布应清空');
    assert(registry['reportPanel'].children.length === 0, '重置后报告应清空');
  });

  await atest('设置弹窗能打开、按预设填充、并持久化到 localStorage', async () => {
    const badgeBtn = registry['providerBadge'].querySelector('button');
    assert(badgeBtn, '顶栏应有设置按钮');
    badgeBtn.dispatch('click');
    assert(registry['settingsMask'].classList.contains('is-open'), '弹窗应打开');

    registry['presetSelect'].value = 'deepseek';
    registry['presetSelect'].dispatch('change');
    assert(registry['baseUrlInput'].value.includes('deepseek'), '预设应填充 Base URL');
    assert(registry['modelInput'].value === 'deepseek-chat', '预设应填充模型名');

    registry['apiKeyInput'].value = 'sk-test-only';
    registry['saveSettings'].dispatch('click');
    assert(!registry['settingsMask'].classList.contains('is-open'), '保存后弹窗应关闭');

    const saved = JSON.parse(localStorage.getItem('jr-config-v1') || '{}');
    assert(saved.provider === 'openai', 'provider 应持久化为 openai，实际 ' + saved.provider);
    assert(saved.model === 'deepseek-chat', 'model 应持久化');

    // 切回离线，避免后续用例走网络
    registry['presetSelect'].value = 'offline';
    registry['presetSelect'].dispatch('change');
    registry['apiKeyInput'].value = '';
    registry['saveSettings'].dispatch('click');
    assert(registry['providerBadge'].textContent.includes('离线'), '应能切回离线模式');
  });

  await atest('在线模型不可达时，运行失败被捕获且界面不崩', async () => {
    // 指向一个必然失败的地址，验证错误路径
    globalThis.fetch = () => Promise.reject(new Error('模拟网络不可达'));
    registry['providerSelect'].value = 'openai';
    registry['baseUrlInput'].value = 'http://127.0.0.1:1/v1';
    registry['modelInput'].value = 'nope';
    registry['apiKeyInput'].value = 'x';
    registry['saveSettings'].dispatch('click');

    registry['resetBtn'].dispatch('click');
    goalInput.value = '请诊断屋面 BIPV 发电异常';
    registry['runBtn'].dispatch('click');
    const idle = await waitIdle();
    assert(idle, '模型不可达时运行也应结束，而不是卡在编排中');

    // 关键：模型全挂时依然要产出结构完整的报告，而不是白屏
    assert(registry['reportPanel'].textContent.includes('四、需人工确认事项'),
      '模型不可用时仍应产出兜底报告');
    assert(registry['reportPanel'].textContent.includes('一、结论摘要'), '兜底报告应含结论摘要');

    // 恢复离线
    registry['presetSelect'].value = 'offline';
    registry['presetSelect'].dispatch('change');
    registry['saveSettings'].dispatch('click');
  });

  console.log('\n' + '─'.repeat(62));
  console.log(`结果：\x1b[32m${passed} 通过\x1b[0m` + (failed ? `，\x1b[31m${failed} 失败\x1b[0m` : '，0 失败'));
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log(`  ${f.name}\n    ${f.message}`));
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('\n冒烟测试自身异常：', e);
  process.exitCode = 1;
});
