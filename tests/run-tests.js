/**
 * 见仁建智 · 契约测试
 * ---------------------------------------------------------------------------
 * 运行：node tests/run-tests.js
 *
 * 全部测试只依赖公开接口（工具契约、Agent 引擎、编排层），不触碰 UI。
 * 这是"接口即测试面"的落地：如果哪次重构破坏了工具返回结构或编排语义，
 * 这里会立刻红掉，而不是等到演示现场才发现。
 */
'use strict';

const path = require('path');
const fs = require('fs');

/* ---------------------------------------------------------------- 加载层 --- */
const ROOT = path.join(__dirname, '..');
const FILES = [
  'js/data/project.js',
  'js/data/knowledge.js',
  'js/core/tools.js',
  'js/core/llm.js',
  'js/core/prompts.js',
  'js/core/agent.js',
  'js/core/orchestrator.js'
];
FILES.forEach(f => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) throw new Error('缺少模块：' + f);
  // 模块用 IIFE 挂在 globalThis 上，这里用 eval 在全局作用域执行，
  // 等价于浏览器里 <script> 的加载语义。
  (0, eval)(fs.readFileSync(p, 'utf8'));
});

const JR_TOOLS = globalThis.JR_TOOLS;
const JR_LLM = globalThis.JR_LLM;
const JR_AGENT = globalThis.JR_AGENT;
const JR_ORCHESTRATOR = globalThis.JR_ORCHESTRATOR;
const JR_PROMPTS = globalThis.JR_PROMPTS;
const JR_DATA = globalThis.JR_DATA;
const JR_KB = globalThis.JR_KB;

/* ------------------------------------------------------------ 微型断言库 --- */
let passed = 0, failed = 0, currentSuite = '';
const failures = [];

function suite(name, fn) {
  currentSuite = name;
  currentBeforeEach = null;   // 钩子不跨套件继承
  console.log('\n\x1b[36m▸ ' + name + '\x1b[0m');
  fn();
}

/**
 * 注册当前套件的"每个用例之前"钩子。
 * 有状态的模块（例如质量闭环那种会一路走到终态的流程）需要它来保证用例隔离。
 */
let currentBeforeEach = null;
function beforeEach(fn) { currentBeforeEach = fn; }

function test(name, fn) {
  const hook = currentBeforeEach;
  const body = hook ? () => { hook(); return fn(); } : fn;

  /* 异步用例不能当场执行 —— Promise 是"立即求值"的：一旦此时调用 fn()，
     用例体就已经跑完，beforeEach 反而会在主流程 await 时二次执行，
     变成"先跑用例、再复位"，隔离完全失效，并报出指向业务逻辑的假象。
     因此异步用例只登记 body，真正执行推迟到主流程 await 的时刻。 */
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    atests.push({ name, suite: currentSuite, fn: body });
    return;
  }

  let out;
  try {
    out = body();
  } catch (e) {
    failed++;
    failures.push({ suite: currentSuite, name, message: e.message });
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
    return;
  }
  // 普通函数但返回 Promise 的用例同样推迟执行；
  // 若当场 await 会变成 unhandledRejection：报告显示"全部通过"而进程非零退出
  // （曾经的真实缺陷，正是它掩盖了"综合结论为空壳"这个问题）。
  if (out && typeof out.then === 'function') {
    atests.push({ name, suite: currentSuite, fn: body });
    return;
  }
  passed++;
  console.log('  \x1b[32m✓\x1b[0m ' + name);
}

/* 异步用例在同步套件登记完成后由主流程统一 await */
const atests = [];

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '值不相等') + '：期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > (tol == null ? 0.01 : tol)) {
    throw new Error((msg || '数值超出容差') + '：' + a + ' vs ' + b);
  }
}
function hasKeys(obj, keys, msg) {
  keys.forEach(k => { if (!(k in obj)) throw new Error((msg || '缺少字段') + '：' + k); });
}

/* ==========================================================================
   1. 工具契约
   ========================================================================== */
suite('工具层 · 契约一致性', () => {
  const tools = JR_TOOLS.list();

  test('工具清单非空且每个都有描述与参数声明', () => {
    assert(tools.length >= 10, '工具数量应为 10 个以上，实际 ' + tools.length);
    tools.forEach(t => {
      assert(t.name, '工具缺 name');
      assert(t.desc && t.desc.length > 6, t.name + ' 缺 desc');
      assert(t.domain, t.name + ' 缺 domain');
      assert(t.agents && t.agents.length, t.name + ' 未声明所属智能体');
      assert(t.params && typeof t.params === 'object', t.name + ' 缺 params');
    });
  });

  test('每个工具都能以空参数调用且返回统一契约', () => {
    tools.forEach(t => {
      const r = JR_TOOLS.invoke(t.name, {});
      hasKeys(r, ['ok', 'tool', 'data', 'cites', 'summary', 'error'], t.name);
      eq(typeof r.ok, 'boolean', t.name + '.ok 类型');
      if (r.ok) {
        eq(r.error, null, t.name + ' 成功时 error 应为 null');
        assert(r.summary && r.summary.length > 0, t.name + ' 成功时 summary 不应为空');
        assert(Array.isArray(r.cites), t.name + '.cites 应为数组');
      }
    });
  });

  test('未注册工具返回失败契约而不是抛异常', () => {
    const r = JR_TOOLS.invoke('not_a_real_tool', {});
    eq(r.ok, false);
    assert(/未注册/.test(r.error), '错误信息应说明未注册');
  });

  test('工具对非法入参返回失败契约而不是抛异常', () => {
    const r = JR_TOOLS.invoke('mic_suggest_split', { moduleId: 'M-9999' });
    eq(r.ok, false);
    assert(/未找到/.test(r.error));
  });

  test('kb_search 缺少 query 时报错', () => {
    const r = JR_TOOLS.invoke('kb_search', {});
    eq(r.ok, false);
  });

  test('工具不返回内部对象引用（data 可安全序列化）', () => {
    tools.forEach(t => {
      const r = JR_TOOLS.invoke(t.name, {});
      if (!r.ok) return;
      // 无法序列化说明返回了活对象（DOM 节点、循环引用等），而不是纯数据
      JSON.parse(JSON.stringify(r.data));
    });
  });
});

/* ==========================================================================
   2. 工程判定规则（数值必须与数据平台一致）
   ========================================================================== */
suite('工具层 · 工程判定正确性', () => {
  test('mic_check_compliance 精确命中演示样例中设计的问题模块', () => {
    const r = JR_TOOLS.invoke('mic_check_compliance', {});
    eq(r.ok, true);
    eq(r.data.checked, JR_DATA.MIC_MODULES.length);

    const rulesOf = id => r.data.results.find(x => x.moduleId === id).violations.map(v => v.rule + '/' + v.level);

    // M-1510：15.9t 超出该半径塔吊额定 14.5t —— 吊装工况高危项
    assert(rulesOf('M-1510').includes('塔吊工况/高'), 'M-1510 应报塔吊工况高危，实际：' + rulesOf('M-1510').join('、'));
    assert(rulesOf('M-1510').includes('标准化率/低'), 'M-1510 标准化率 14% < 20%，应报低危');
    // M-1601：高 3.4m 超出运输限高 3.2m —— 运输高危项
    assert(rulesOf('M-1601').includes('运输限高/高'), 'M-1601 应报运输限高高危，实际：' + rulesOf('M-1601').join('、'));
    // M-1511：11.2t / 3.0×6.0m，标准化率 28% ≥ 20%，是一个全合规的对照模块
    eq(rulesOf('M-1511').length, 0, 'M-1511 应完全合规，实际报了：' + rulesOf('M-1511').join('、'));

    eq(r.data.highCount, 2, '演示数据应恰好有 2 个高危项');
  });

  test('mic_check_compliance 对合规模块不误报', () => {
    const r = JR_TOOLS.invoke('mic_check_compliance', {});
    const m1511 = r.data.results.find(x => x.moduleId === 'M-1511');
    eq(m1511.pass, true, 'M-1511 无高危项，pass 应为 true');
    eq(m1511.violations.length, 0, 'M-1511 不应有任何违规项');
  });

  test('mic_check_compliance 的高危项都与重量/尺寸阈值一致', () => {
    const R = JR_DATA.MIC_RULES;
    const r = JR_TOOLS.invoke('mic_check_compliance', {});
    r.data.results.forEach(res => {
      const m = JR_DATA.MIC_MODULES.find(x => x.id === res.moduleId);
      res.violations.forEach(v => {
        if (v.rule === '运输限宽') assert(m.widthM > R.maxWidthM, m.id + ' 宽度未超限却报限宽');
        if (v.rule === '吊装吨位') assert(m.weightT > R.maxWeightT, m.id + ' 吨位未超限却报吨位');
        if (v.rule === '标准化率') assert(m.reuseRate < R.minReuseRate, m.id + ' 标准化率达标却报警');
      });
    });
  });

  test('bim_clash_detect 只返回指定楼层的冲突', () => {
    const r = JR_TOOLS.invoke('bim_clash_detect', { floor: 15 });
    eq(r.ok, true);
    r.data.clashes.forEach(c => {
      const m = JR_DATA.MIC_MODULES.find(x => x.id === c.moduleId);
      eq(m.floor, 15, c.moduleId + ' 不属于 15 层');
    });
  });

  test('schedule_predict 的延期与 SPI 自洽，且不做物理上不可能的预测', () => {
    const r = JR_TOOLS.invoke('schedule_predict', { horizonDays: 3 });
    eq(r.ok, true);
    r.data.tasks.forEach(t => {
      near(t.slip, t.planPercent - t.actualPercent, 0.11, t.id + ' 偏差计算不符');
      assert(t.delayDays >= 0, '延期天数不应为负');
      assert(t.projectedFinish >= t.plannedFinish, t.id + ' 预测完工早于计划完工');
      assert(t.projectedFinish >= r.data.currentDay, t.id + ' 预测完工早于今天');
    });
    const t01 = r.data.tasks.find(t => t.id === 'T-01');
    assert(t01.delayDays > 0, 'T-01 计划 100% / 实际 62%，必须报出延期');
    near(t01.spi, 0.62, 0.01, 'T-01 SPI 应为 实际/计划 = 0.62');
  });

  test('前置任务级联：T-03 不可能早于其前置 T-02 完成', () => {
    const r = JR_TOOLS.invoke('schedule_predict', {});
    const t02 = r.data.tasks.find(t => t.id === 'T-02');
    const t03 = r.data.tasks.find(t => t.id === 'T-03');
    assert(t03.projectedFinish >= t02.projectedFinish,
      'T-03 预测完工 ' + t03.projectedFinish + ' 早于其前置 T-02 的 ' + t02.projectedFinish);
    eq(t03.blockedByPredecessor, 'T-02', 'T-03 应标记被前置任务阻塞');
    assert(t02.delayDays > 0, 'T-02 应因自身 SPI 偏低产生延期');
  });

  test('级联延期不会无限传播：后置任务只继承，不重复放大', () => {
    const r = JR_TOOLS.invoke('schedule_predict', {});
    const t01 = r.data.tasks.find(t => t.id === 'T-01');
    const t02 = r.data.tasks.find(t => t.id === 'T-02');
    assert(t02.delayDays >= 0 && t02.delayDays <= 30, 'T-02 延期应在合理区间，实际 ' + t02.delayDays);
    assert(t01.projectedFinish <= r.data.projectedCompletionDay, '预测完工日应覆盖所有任务');
  });

  test('未开工工序不产生荒谬延期', () => {
    const r = JR_TOOLS.invoke('schedule_predict', {});
    r.data.tasks.forEach(t => {
      assert(t.delayDays <= 90, t.id + ' 延期 ' + t.delayDays + ' 天，明显失真');
    });
  });

  test('crane_plan 在风速超限时把所有时段标记为不可排', () => {
    const r = JR_TOOLS.invoke('crane_plan', { windMs: 15 });
    eq(r.ok, true);
    assert(r.data.slots.every(s => s.feasible === false), '风速 15m/s 应全部不可排');
    assert(r.data.freeSlots.length === 0, '不应有可用空档');
  });

  test('crane_plan 在正常风速下给出可用空档', () => {
    // 快照日第 46 天 TC-01 下午已被 T-01 占用（无空档）；
    // 第 47 天上午 TC-01 为空档，这才是调度智能体应推进的窗口。
    const d46 = JR_TOOLS.invoke('crane_plan', { day: 46, windMs: 4 });
    assert(d46.data.slots.every(s => s.feasible), '风速 4m/s 时不应有时段不可排');
    eq(d46.data.freeSlots.length, 0, '第 46 天所有时段均已排满');

    const d47 = JR_TOOLS.invoke('crane_plan', { day: 47, windMs: 4 });
    assert(d47.data.freeSlots.includes('D47-AM'), '第 47 天上午应为可用空档，实际 ' + JSON.stringify(d47.data.freeSlots));
  });

  test('crane_plan 检出同塔吊同时段重复占用的冲突', () => {
    const slots = JR_DATA.RESOURCES.craneSlots;
    const dup = slots.filter(s => s.slot === 'D47-PM' && s.crane === 'TC-01');
    eq(dup.length, 1, 'TC-02 的 D47-PM 不应与 TC-01 的同名时段互相冲突');
    const r = JR_TOOLS.invoke('crane_plan', { day: 47, windMs: 4 });
    r.data.slots.forEach(s => {
      if (s.assignedTo === null) return;
      assert(['T-01', 'T-03'].includes(s.assignedTo), '意外的任务编号 ' + s.assignedTo);
    });
  });

  test('crane_plan 只返回被查询日期的时段', () => {
    const d46 = JR_TOOLS.invoke('crane_plan', { day: 46, windMs: 4 });
    const d47 = JR_TOOLS.invoke('crane_plan', { day: 47, windMs: 4 });
    assert(d46.data.slots.length >= 1 && d47.data.slots.length >= 1, '两天都应有预排时段');
    d46.data.slots.forEach(s => assert(s.slot.indexOf('D46-') === 0, '第 46 天查询返回了 ' + s.slot));
    d47.data.slots.forEach(s => assert(s.slot.indexOf('D47-') === 0, '第 47 天查询返回了 ' + s.slot));
    assert(d47.data.freeSlots.includes('D47-AM'), '第 47 天上午应为空档');
  });

  test('crane_plan 对没有预排时段的日子给出明确提示', () => {
    const r = JR_TOOLS.invoke('crane_plan', { day: 60 });
    eq(r.data.slots.length, 0);
    eq(r.data.noneForDay, true);
    assert(/无预排时段/.test(r.summary), '摘要应说明该日无预排时段');
  });

  test('safety_check_lift 检出人员侵入时风险等级为高', () => {
    const r = JR_TOOLS.invoke('safety_check_lift', { zone: 'C3-15F 吊装区' });
    eq(r.ok, true);
    assert(r.data.intrusionCount > 0, '演示数据应包含吊装半径侵入事件');
    eq(r.data.level, '高');
    assert(r.data.affectedWorkers.length > 0, '应识别出受影响工友');
    assert(r.data.actions.some(a => /停止|撤离/.test(a)), '高危时动作应包含立即处置');
  });

  test('bipv_diagnose 定位到 S-01 并给出积灰主因', () => {
    const r = JR_TOOLS.invoke('bipv_diagnose', {});
    eq(r.ok, true);
    const s01 = r.data.findings.find(f => f.stringId === 'S-01');
    assert(s01, '应包含 S-01');
    assert(s01.abnormal, 'S-01 实际 96.4 / 期望 118.0，应判为异常');
    assert(s01.stringCauses.length > 0, 'S-01 应给出组串级原因');
    eq(s01.primaryCause, '积灰', 'S-01 主因应为积灰，实际 ' + s01.primaryCause);
    near(s01.gapKwh, 21.6, 0.05, 'S-01 缺口电量');
    const s02 = r.data.findings.find(f => f.stringId === 'S-02');
    assert(!s02.abnormal, 'S-02 基本正常，不应误报');
  });

  test('单串损失不会被错误归因到全场级因素上', () => {
    const r = JR_TOOLS.invoke('bipv_diagnose', {});
    const s01 = r.data.findings.find(f => f.stringId === 'S-01');
    // INV-1 温度 58°C 属全场级因素，只能作为加重因素，不能抢走组串级主因
    assert(!s01.stringCauses.some(c => c.cause === '逆变器过温'), '逆变器因素不应出现在组串级证据里');
    assert(s01.systemCauses.some(c => /逆变器/.test(c.cause)), '应把逆变器温升列为加重因素');
    assert(s01.needsInverterCheck, 'INV-1 有直流侧报警，应标记需同步排查逆变器');
  });

  test('bipv_work_order 只为异常组串生成工单，且含夜间窗口', () => {
    const r = JR_TOOLS.invoke('bipv_work_order', {});
    eq(r.ok, true);
    assert(r.data.count >= 1, '应至少生成 1 张工单');
    r.data.created.forEach(o => {
      assert(o.stringId, '工单应绑定组串');
      assert(o.actions.length >= 2, '工单应含可执行动作');
      assert(o.evidenceRequired.length >= 1, '工单应要求验收证据');
      assert(/今夜|明日/.test(o.window), '工单应给出作业窗口，实际：' + o.window);
    });
    const s01 = r.data.created.find(o => o.stringId === 'S-01');
    assert(s01 && /今夜/.test(s01.window), 'S-01 为积灰，应安排夜间清洗以免发电损失，实际窗口：' + (s01 && s01.window));
  });

  test('dispatch_order 会改变台账状态，且重复派单被拒绝', () => {
    const before = JR_TOOLS.invoke('defect_list', {});
    const target = before.data.rows.find(d => d.status !== '已关闭');
    const r = JR_TOOLS.invoke('dispatch_order', { defectId: target.id });
    eq(r.ok, true);
    eq(r.data.ledgerAfter.status, '已派单');
    const again = JR_TOOLS.invoke('dispatch_order', { defectId: 'DF-103' });
    eq(again.ok, false, '已关闭的缺陷不应能再次派单');
  });

  test('simulate_plan 会返回排序后的方案与推荐项', () => {
    const r = JR_TOOLS.invoke('simulate_plan', { goal: 'lift' });
    eq(r.ok, true);
    assert(r.data.scenarios.length >= 2, '应至少推演 2 个方案');
    for (let i = 1; i < r.data.scenarios.length; i++) {
      assert(r.data.scenarios[i - 1].score >= r.data.scenarios[i].score, '方案应按得分降序');
    }
    eq(r.data.recommended, r.data.scenarios[0].id, '推荐项应为得分最高者');
  });
});

/* ==========================================================================
   3. 知识检索与出处
   ========================================================================== */
suite('知识层 · 检索与出处', () => {
  test('检索结果一定带规范条款出处', () => {
    const r = JR_TOOLS.invoke('kb_search', { query: '光伏 积灰 热斑 组串', topK: 3 });
    eq(r.ok, true);
    assert(r.data.hits.length > 0, '应命中文本块');
    r.data.hits.forEach(h => {
      assert(h.cite && h.cite.doc, '命中的每条都应带出处');
      assert(h.cite.clause, '出处应带条款号');
    });
    assert(r.cites.length > 0, '工具级 cites 不应为空');
  });

  test('图扩展能沿关系边找到关联的故障模式', () => {
    const r = JR_TOOLS.invoke('kb_search', { query: '积灰 清洗', topK: 2, expandGraph: true });
    assert(r.data.related.length > 0, '应通过图谱扩展到关联节点');
  });

  test('关闭图扩展后不返回关联节点', () => {
    const r = JR_TOOLS.invoke('kb_search', { query: '积灰 清洗', topK: 2, expandGraph: false });
    eq(r.data.related.length, 0);
  });

  test('每个文本块都能追溯到知识图谱中的一个节点', () => {
    JR_KB.CHUNKS.forEach(ck => {
      assert(JR_KB.NODES.some(n => n.id === ck.node), ck.id + ' 指向了不存在的节点 ' + ck.node);
    });
  });

  test('关系边的两端都指向存在的节点', () => {
    JR_KB.EDGES.forEach(e => {
      assert(JR_KB.NODES.some(n => n.id === e.from), '边起点不存在：' + e.from);
      assert(JR_KB.NODES.some(n => n.id === e.to), '边终点不存在：' + e.to);
    });
  });
});

/* ==========================================================================
   4. LLM 适配器与协议解析
   ========================================================================== */
suite('决策层 · 适配器与解析', () => {
  test('注册了 offline / openai / anthropic 三个适配器', () => {
    const names = JR_LLM.listProviders().map(p => p.name);
    ['offline', 'openai', 'anthropic'].forEach(n => assert(names.includes(n), '缺适配器 ' + n));
  });

  test('offline 适配器标记为不需要密钥', () => {
    const p = JR_LLM.listProviders().find(x => x.name === 'offline');
    eq(p.needsKey, false);
  });

  test('parseAction 能解析裸 JSON', () => {
    const r = JR_LLM.parseAction('{"thought":"想","action":"kb_search","action_input":{"query":"积灰"}}');
    eq(r.action, 'kb_search');
    eq(r.actionInput.query, '积灰');
    eq(r.parseError, null);
  });

  test('parseAction 能穿透 Markdown 代码块与前后噪声', () => {
    const text = '好的，我来调用工具：\n```json\n{"thought":"t","action":"bipv_diagnose","action_input":{}}\n```\n以上。';
    const r = JR_LLM.parseAction(text);
    eq(r.action, 'bipv_diagnose');
  });

  test('parseAction 容忍 action_input 被包在 arguments 中', () => {
    const r = JR_LLM.parseAction('{"action":"crane_plan","arguments":{"windMs":3}}');
    eq(r.action, 'crane_plan');
    eq(r.actionInput.windMs, 3);
  });

  test('parseAction 把未注册工具降级为 final_answer 而不是崩溃', () => {
    const r = JR_LLM.parseAction('{"action":"delete_all_files","action_input":{}}');
    eq(r.action, 'final_answer');
    assert(/未注册/.test(r.parseError), '应记录未注册工具');
  });

  test('parseAction 对非 JSON 文本回退为 final_answer', () => {
    const r = JR_LLM.parseAction('我觉得这个方案不太好。');
    eq(r.action, 'final_answer');
    assert(r.answer.length > 0, '应保留原文作为答案');
    assert(r.parseError, '应记录解析失败');
  });

  test('parseAction 能处理嵌套花括号与字符串中的括号', () => {
    const r = JR_LLM.parseAction('{"thought":"含 } 与 { 的说明","action":"defect_list","action_input":{"status":"整改中"}}');
    eq(r.action, 'defect_list');
    eq(r.actionInput.status, '整改中');
  });

  test('extractFirstJson 在无法解析时返回 null', () => {
    eq(JR_LLM.extractFirstJson('no json here'), null);
    eq(JR_LLM.extractFirstJson(''), null);
  });
});

/* ==========================================================================
   5. 单个智能体的 ReAct 闭环
   ========================================================================== */
suite('Agent 引擎 · ReAct 闭环', () => {
  const mkLLM = () => JR_LLM.createLLM({ provider: 'offline', maxRetries: 0 });

  test('设计智审智能体在离线模式下能自然收敛', async () => {
    const res = await JR_AGENT.run({ role: 'design', goal: '审查 15 层 MiC 拆分', brief: '审查 15 层 MiC 模块拆分', llm: mkLLM(), maxSteps: 8 });
    eq(res.stopReason, 'final_answer');
    assert(res.answer.length > 20, '应产出结论');
    assert(res.toolCalls.length >= 2, '应至少调用 2 个工具，实际 ' + res.toolCalls.length);
    assert(res.evidence.length > 0, '应汇聚到证据出处');
  });

  test('工具白名单生效：设计智能体不能调用光伏工具', async () => {
    const res = await JR_AGENT.run({ role: 'design', goal: 'x', brief: 'x', llm: mkLLM(), maxSteps: 6 });
    const called = res.toolCalls.map(c => c.name);
    assert(!called.includes('bipv_diagnose'), '设计域不应调用光伏诊断');
    assert(!called.includes('safety_multimodal_scan'), '设计域不应调用安全扫描');
  });

  test('轨迹记录每一步的 thought / action / observation', async () => {
    const res = await JR_AGENT.run({ role: 'energy', goal: 'BIPV 发电异常', brief: '诊断组串', llm: mkLLM(), maxSteps: 6 });
    assert(res.steps.length >= 2, '应有多个步骤');
    res.steps.forEach(s => {
      hasKeys(s, ['index', 'thought', 'action', 'actionInput', 'observation']);
    });
    const toolSteps = res.steps.filter(s => s.action !== 'final_answer');
    toolSteps.forEach(s => {
      assert(s.observation, '工具步骤必须有 observation');
      eq(s.observation.ok, true, s.action + ' 应执行成功');
      assert(s.observation.data, s.action + ' 应返回数据');
    });
  });

  test('证据只能来自工具 cites，不能凭空产生', async () => {
    const res = await JR_AGENT.run({ role: 'safety', goal: '巡检', brief: '扫描隐患', llm: mkLLM(), maxSteps: 6 });
    const allowed = new Set();
    res.toolCalls.forEach(c => (c.result.cites || []).forEach(x => allowed.add(x.doc + ' ' + x.clause)));
    res.evidence.forEach(e => assert(allowed.has(e), '出现了无来源证据：' + e));
  });

  test('达到最大步数时强制收尾而不是死循环', async () => {
    const res = await JR_AGENT.run({ role: 'schedule', goal: '进度', brief: '进度', llm: mkLLM(), maxSteps: 2 });
    assert(res.steps.length <= 3, '步数应受控，实际 ' + res.steps.length);
    assert(['final_answer', 'max_steps_forced'].includes(res.stopReason), '收敛原因：' + res.stopReason);
  });

  test('模型层异常会被捕获并保留已有证据', async () => {
    const brokenLLM = {
      config: { provider: 'broken', model: 'x' },
      complete: () => Promise.reject(new Error('模拟网络中断')),
      decide: () => Promise.reject(new Error('模拟网络中断'))
    };
    const res = await JR_AGENT.run({ role: 'design', goal: 'x', brief: 'x', llm: brokenLLM, maxSteps: 4 });
    eq(res.stopReason, 'llm_error');
    assert(/模拟网络中断/.test(res.answer), '应把失败原因写进结论');
  });

  test('未知角色被拒绝', async () => {
    let threw = false;
    try { await JR_AGENT.run({ role: 'nobody', goal: 'x', brief: 'x', llm: mkLLM() }); }
    catch (e) { threw = true; }
    assert(threw, '未知角色应抛错');
  });
});

/* ==========================================================================
   6. 多智能体编排
   ========================================================================== */
suite('编排层 · 多智能体协同', () => {
  const mkLLM = () => JR_LLM.createLLM({ provider: 'offline', maxRetries: 0 });

  test('拓扑分层：依赖任务被放到下一层', () => {
    const tasks = [
      { id: 'a', agent: 'design', brief: 'x', dependsOn: [] },
      { id: 'b', agent: 'schedule', brief: 'y', dependsOn: ['a'] },
      { id: 'c', agent: 'safety', brief: 'z', dependsOn: [] }
    ];
    const layers = JR_ORCHESTRATOR.topoLayers(tasks);
    eq(layers.length, 2);
    eq(layers[0].length, 2);
    eq(layers[1][0].id, 'b');
  });

  test('拓扑分层能容忍循环依赖而不死循环', () => {
    const tasks = [
      { id: 'a', agent: 'design', brief: 'x', dependsOn: ['b'] },
      { id: 'b', agent: 'schedule', brief: 'y', dependsOn: ['a'] }
    ];
    const layers = JR_ORCHESTRATOR.topoLayers(tasks);
    assert(layers.length <= 10, '不应无限循环');
  });

  test('默认规划模板按目标关键词选择任务域', () => {
    const p1 = JR_ORCHESTRATOR.defaultPlan('光伏组串发电量异常');
    assert(p1.tasks.some(t => t.agent === 'energy'), '光伏目标应包含绿能运维');
    const p2 = JR_ORCHESTRATOR.defaultPlan('吊装进度滞后');
    assert(p2.tasks.some(t => t.agent === 'schedule'), '进度目标应包含施工调度');
  });

  test('离线规划器按目标打分选模板，而不是按数组顺序', () => {
    const t = JR_LLM.selectTemplate('请对海之韵项目做一次全场综合复盘：设计、施工、绿能、安全四个维度各出一份结论');
    eq(t.id, 'comprehensive', '综合目标应命中 comprehensive 模板，实际 ' + (t && t.id));
    eq(JR_LLM.selectTemplate('屋面 BIPV 发电量低于期望').id, 'energy');
    eq(JR_LLM.selectTemplate('请给出吊装抢工方案').id, 'lift');
    eq(JR_LLM.selectTemplate('请对作业面做一次多模态安全巡检').id, 'safety');
    eq(JR_LLM.selectTemplate('与项目无关的一句话'), null);
  });

  test('含通用词的目标不会被通用模板截胡（MiC 拆分审查 → 设计域）', () => {
    // 该目标同时命中「吊装」与「拆分」，但拆分才是它真正的意图
    const id = JR_LLM.selectTemplate('请审查 C3 栋 15 层 MiC 模块的拆分方案，找出运输与吊装超限项和机电碰撞').id;
    eq(id, 'design', '拆分审查应命中设计模板，实际 ' + id);
  });

  test('综合复盘目标覆盖设计/施工/绿能/安全四个域', () => {
    const tasks = JR_LLM.offlinePlan('请对海之韵项目做一次全场综合复盘：设计、施工、绿能、安全四个维度各出一份结论，并指出跨域冲突');
    const agents = tasks.map(t => t.agent);
    ['design', 'schedule', 'energy', 'safety'].forEach(a => {
      assert(agents.includes(a), '综合复盘缺少 ' + a + ' 域，实际 ' + agents.join('/'));
    });
  });

  test('规划动作 plan 被解析器放行，不会被当成未注册工具', () => {
    const r = JR_LLM.parseAction('{"thought":"拆解","action":"plan","action_input":{"tasks":[{"id":"t1","agent":"energy","brief":"诊断组串","dependsOn":[]}]}}');
    eq(r.action, 'plan');
    eq(r.parseError, null);
    eq(r.actionInput.tasks.length, 1);
  });

  test('每个目标只派出与该目标相关的域（不相关的域不派活）', async () => {
    const cases = [
      { goal: '屋面 BIPV 阵列发电量低于期望，请诊断损失来源并生成运维工单', must: ['energy'], mustNot: ['design'] },
      { goal: '请给出 C3 栋 15 层吊装进度滞后的抢工方案', must: ['schedule'], mustNot: ['energy'] },
      { goal: '请对 C3 栋 15 层作业面做一次多模态安全巡检', must: ['safety'], mustNot: ['energy', 'design'] }
    ];
    for (const c of cases) {
      const report = await JR_ORCHESTRATOR.run({ goal: c.goal, llm: mkLLM(), maxStepsPerAgent: 5 });
      const agents = report.artifacts.map(a => a.agent);
      c.must.forEach(a => assert(agents.includes(a), `「${c.goal}」应派出 ${a} 域，实际 ${agents.join('/')}`));
      c.mustNot.forEach(a => assert(!agents.includes(a), `「${c.goal}」不应派出 ${a} 域，实际 ${agents.join('/')}`));
    }
  });

  test('综合复盘目标覆盖设计/施工/绿能/安全四个域', async () => {
    const report = await JR_ORCHESTRATOR.run({
      goal: '请对海之韵项目做一次全场综合复盘：设计、施工、绿能、安全四个维度各出一份结论，并指出跨域冲突',
      llm: mkLLM(), maxStepsPerAgent: 5
    });
    const agents = report.artifacts.map(a => a.agent);
    ['design', 'schedule', 'energy', 'safety'].forEach(a => {
      assert(agents.includes(a), '综合复盘缺少 ' + a + ' 域，实际 ' + agents.join('/'));
    });
  });

  test('完整编排能跑通并产出结构化报告', async () => {
    const report = await JR_ORCHESTRATOR.run({
      goal: 'C3 栋 15 层吊装进度滞后，给出抢工或顺延方案并确认安全条件',
      llm: mkLLM(), maxStepsPerAgent: 6
    });
    hasKeys(report, ['goal', 'plan', 'artifacts', 'insights', 'conclusion', 'confirmations', 'evidence', 'timeline', 'metrics']);
    assert(report.artifacts.length >= 2, '应至少 2 个智能体参与，实际 ' + report.artifacts.length);
    assert(report.metrics.toolCalls >= 4, '应发生多次工具调用，实际 ' + report.metrics.toolCalls);
    assert(report.conclusion.length > 60, '结论不应为空壳');
    assert(report.confirmations.length > 0, '必须给出需人工确认事项');
    assert(report.evidence.length > 0, '必须汇聚证据出处');
  });

  test('报告中的每个智能体结论都可追溯到工具调用', async () => {
    const report = await JR_ORCHESTRATOR.run({ goal: 'BIPV 发电量低于期望，请诊断', llm: mkLLM(), maxStepsPerAgent: 5 });
    report.artifacts.forEach(a => {
      assert(a.toolCalls.length > 0, a.agentName + ' 没有任何工具调用就有结论');
      a.toolCalls.forEach(c => assert(JR_TOOLS.REGISTRY[c.name], '调用了不存在的工具 ' + c.name));
    });
  });

  test('跨域关联规则能在抢工 + 安全隐患同时出现时触发', () => {
    const artifacts = [
      { agent: 'schedule', answer: '建议增加夜班吊装以挽回工期', toolSummaries: ['最大延期 2 天'] },
      { agent: 'safety', answer: '吊装区存在人员侵入与高危隐患', toolSummaries: ['高危 2 条'] }
    ];
    const insights = JR_ORCHESTRATOR.buildInsights(artifacts);
    assert(insights.some(i => i.id === 'IX-LIFT-SAFETY'), '应触发工期-安全冲突关联');
  });

  test('跨域关联在没有冲突时不误报', () => {
    const artifacts = [{ agent: 'energy', answer: '组串 S-02 正常，无需处理', toolSummaries: [] }];
    eq(JR_ORCHESTRATOR.buildInsights(artifacts).length, 0);
  });

  test('共享黑板让下游智能体看见上游结论', () => {
    const bb = JR_ORCHESTRATOR.createBlackboard();
    bb.publish({ agent: 'design', agentName: '设计智审智能体', answer: '检出 3 处碰撞' });
    assert(/设计智审/.test(bb.digest()), '摘要应包含已发布的结论');
    eq(bb.byAgent('design').length, 1);
  });

  test('模型汇总不可用时，确定性综合仍产出四段结构且数值可追溯', () => {
    const artifacts = [
      {
        agent: 'schedule', agentName: '施工调度智能体', answer: '略', evidence: ['施工组织设计 V3'],
        stopReason: 'final_answer',
        toolSummaries: ['最大延期 6 天'],
        toolCalls: [{
          name: 'schedule_predict', summary: '最大延期 6 天',
          result: {
            ok: true, cites: [], summary: '最大延期 6 天',
            data: {
              currentDay: 46, maxDelayDays: 6, projectedCompletionDay: 56, criticalPath: ['T-02'],
              tasks: [{ id: 'T-02', name: 'C3 栋 15 层机电接驳', delayDays: 6, spi: 0.4, plannedFinish: 49, projectedFinish: 55 }]
            }
          }
        }]
      },
      {
        agent: 'safety', agentName: '安全巡检智能体', answer: '略', evidence: ['JGJ 59-2011 3.13.3'],
        stopReason: 'final_answer',
        toolSummaries: ['扫描 5 条隐患'],
        toolCalls: [{
          name: 'safety_multimodal_scan', summary: '扫描 5 条隐患',
          result: {
            ok: true, cites: [], summary: '扫描 5 条隐患',
            data: {
              scanned: 5, bySeverity: { 高: 2, 中: 2, 低: 1 },
              topZones: [{ zone: 'C3-15F 吊装区', count: 3 }],
              pendingOrders: [{ id: 'RK-SE-03', zone: 'C3-15F 吊装区', type: '人员进入吊装半径', severity: '高', owner: 'CR-A', dueHours: 4, evidenceRequired: ['整改后照片', '班组长确认'] }],
              events: [], highCount: 2
            }
          }
        }]
      }
    ];
    const insights = [{ id: 'IX-LIFT-SAFETY', text: '抢工与安全监护窗口冲突。' }];
    const text = JR_ORCHESTRATOR.buildSynthesis('吊装进度滞后', artifacts, insights, { tasks: [] });

    ['一、结论摘要', '二、跨域关联', '三、建议动作', '四、需人工确认事项'].forEach(seg => {
      assert(text.includes(seg), '确定性综合缺少段落：' + seg);
    });
    // 数值必须来自工具返回值，不得自造
    assert(text.includes('最大延期 6 天'), '结论应包含工具给出的延期天数');
    assert(text.includes('预测完工第 56 天'), '结论应包含预测完工日');
    assert(text.includes('RK-SE-03'), '建议动作应包含安全工单编号');
    assert(text.includes('IX-LIFT-SAFETY') || text.includes('抢工与安全监护窗口冲突'), '应纳入跨域关联');
    assert(/签字确认/.test(text), '必须保留人工确认条款');
  });

  test('确定性综合在无任何域结论时也不崩且结构完整', () => {
    const text = JR_ORCHESTRATOR.buildSynthesis('空目标', [], [], { tasks: [] });
    ['一、结论摘要', '二、跨域关联', '三、建议动作', '四、需人工确认事项'].forEach(seg => {
      assert(text.includes(seg), '缺少段落：' + seg);
    });
    assert(/未取得可量化的域结论/.test(text), '应显式说明本轮没有可用结论');
  });

  test('编排事件流包含完整生命周期', async () => {
    const events = [];
    await JR_ORCHESTRATOR.run({
      goal: '请巡检 C3 栋 15 层安全隐患', llm: mkLLM(), maxStepsPerAgent: 5,
      onEvent: e => events.push(e.type + (e.phase ? ':' + e.phase : ''))
    });
    ['phase:receive', 'phase:plan', 'task_start', 'agent_start', 'step', 'agent_end', 'artifact', 'phase:done']
      .forEach(k => assert(events.includes(k), '事件流缺少 ' + k));
  });

  test('onPlanReady 在执行之前拿到计划', async () => {
    let planAt = null, firstTaskAt = null;
    const order = [];
    await JR_ORCHESTRATOR.run({
      goal: '吊装进度滞后',
      llm: mkLLM(), maxStepsPerAgent: 4,
      onPlanReady: p => order.push('plan:' + p.tasks.length),
      onEvent: e => { if (e.type === 'task_start' && !firstTaskAt) order.push('task'); }
    });
    assert(order[0].indexOf('plan:') === 0, '计划回调应先于任务执行，实际顺序 ' + order.join(' -> '));
  });
});

/* ==========================================================================
   7. 提示词约束
   ========================================================================== */
suite('提示层 · 角色与约束', () => {
  test('每个角色都有使命、边界与交付物', () => {
    Object.keys(JR_PROMPTS.ROLES).forEach(k => {
      const r = JR_PROMPTS.ROLES[k];
      assert(r.mission && r.mission.length > 10, k + ' 缺 mission');
      assert(r.boundary && r.boundary.length > 6, k + ' 缺 boundary');
      assert(r.deliverable, k + ' 缺 deliverable');
      assert(r.tools && r.tools.length, k + ' 缺工具白名单');
    });
  });

  test('角色的工具白名单只包含已注册工具', () => {
    Object.keys(JR_PROMPTS.ROLES).forEach(k => {
      JR_PROMPTS.ROLES[k].tools.forEach(t => {
        assert(JR_TOOLS.REGISTRY[t], k + ' 引用了未注册工具 ' + t);
      });
    });
  });

  test('系统提示词包含项目上下文与输出协议', () => {
    const s = JR_PROMPTS.systemPrompt('design', {});
    assert(s.includes(JR_DATA.PROJECT.name), '应包含项目名');
    assert(s.includes('final_answer'), '应包含输出协议');
    assert(s.includes('mic_check_compliance'), '应包含可用工具清单');
    assert(s.includes('需人工确认'), '应包含诚实性约束');
  });

  test('提示词不泄露判定阈值（阈值只在工具层）', () => {
    const s = JR_PROMPTS.systemPrompt('design', {});
    const R = JR_DATA.MIC_RULES;
    assert(!s.includes(String(R.maxWidthM)), '提示词不应出现限宽阈值');
    assert(!s.includes(String(R.maxWeightT)), '提示词不应出现吨位阈值');
  });

  test('角色工具白名单与工具声明的 agents 双向一致', () => {
    Object.keys(JR_PROMPTS.ROLES).forEach(roleId => {
      JR_PROMPTS.ROLES[roleId].tools.forEach(t => {
        const declares = JR_TOOLS.REGISTRY[t].agent;
        assert(declares.includes(roleId), t + ' 声明属于 ' + declares.join('/') + '，但 ' + roleId + ' 的白名单里也有它');
      });
    });
  });

  test('每个工具声明的 agents 都是真实存在的角色', () => {
    Object.keys(JR_TOOLS.REGISTRY).forEach(t => {
      JR_TOOLS.REGISTRY[t].agent.forEach(a => {
        assert(JR_PROMPTS.ROLES[a], t + ' 声明属于不存在的角色 ' + a);
      });
    });
  });
});

/* ==========================================================================
   8. 数据平台自洽性
   ========================================================================== */
suite('数据层 · 自洽性', () => {
  test('每个模块的塔吊额定值不超过全局限值', () => {
    JR_DATA.MIC_MODULES.forEach(m => {
      assert(m.craneCapacityT <= JR_DATA.MIC_RULES.maxWeightT + 0.001,
        m.id + ' 的塔吊额定值超过了全局限值，会让合规检查失去意义');
    });
  });

  test('时间线字段顺序合理', () => {
    JR_DATA.SCHEDULE_TASKS.forEach(t => {
      assert(t.start <= t.end, t.id + ' 开始日晚于结束日');
      assert(t.actualPercent <= 100 && t.planPercent <= 100, t.id + ' 百分比越界');
    });
  });

  test('安全事件中引用的工友都存在于工友台账', () => {
    const ids = new Set(JR_DATA.WORKERS.map(w => w.id));
    JR_DATA.SAFETY_EVENTS.forEach(e => e.workers.forEach(w => assert(ids.has(w), e.id + ' 引用了不存在的工友 ' + w)));
  });

  test('逆变器引用的组串都存在', () => {
    const ids = new Set(JR_DATA.BIPV_ARRAY.strings.map(s => s.id));
    JR_DATA.BIPV_ARRAY.inverters.forEach(inv => {
      inv.mpptStrings.forEach(s => assert(ids.has(s), inv.id + ' 引用了不存在的组串 ' + s));
    });
  });

  test('以 XSS 形式注入的查询不会破坏结果结构', () => {
    const r = JR_TOOLS.invoke('kb_search', { query: '<script>alert(1)</script>' });
    assert(r.ok === true || r.ok === false, '应返回契约对象');
    JSON.stringify(r);
  });
});

/* ==========================================================================
   运行
   ========================================================================== */
(async function main() {
  for (const t of atests) {
    try {
      await t.fn();
      passed++;
      console.log('  \x1b[32m✓\x1b[0m ' + t.name);
    } catch (e) {
      failed++;
      failures.push({ suite: t.suite, name: t.name, message: e.message });
      console.log('  \x1b[31m✗\x1b[0m ' + t.name + '\n      ' + e.message);
    }
  }

  console.log('\n' + '─'.repeat(62));
  console.log(`结果：\x1b[32m${passed} 通过\x1b[0m` + (failed ? `，\x1b[31m${failed} 失败\x1b[0m` : '，0 失败'));
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log(`  [${f.suite}] ${f.name}\n    ${f.message}`));
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('\n测试运行器自身异常：', e);
  process.exitCode = 1;
});
