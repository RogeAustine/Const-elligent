/**
 * 见仁建智 · 应用装配（唯一把各层接起来的地方）
 * ---------------------------------------------------------------------------
 * 数据平台(project/knowledge) -> 工具层(tools) -> 提示词(prompts)
 *   -> 运行引擎(agent) -> 编排层(orchestrator) -> 视图(twin/canvas/trace/report)
 *
 * 这一层不做判定、不做渲染细节，只做三件事：
 *   1) 装配依赖（含 LLM provider 切换）
 *   2) 把 orchestrator 的事件流分发给各面板
 *   3) 演示节奏控制（离线模式下逐条播放，让评审看清编排过程）
 */
(function (root) {
  'use strict';

  var h = root.JR_UI.h, $ = root.JR_UI.$, clear = root.JR_UI.clear, sleep = root.JR_UI.sleep;
  var D = root.JR_DATA;

  var SCENARIOS = [
    {
      id: 'lift', label: '吊装进度滞后',
      goal: 'C3 栋 15 层 MiC 模块吊装进度滞后，请判断偏差来源、给出可执行的抢工或顺延方案，并确认吊装窗口内的安全条件。'
    },
    {
      id: 'bipv', label: 'BIPV 发电异常',
      goal: '屋面 BIPV 阵列近日发电量低于期望，请诊断损失来源、定位故障组串并生成运维工单。'
    },
    {
      id: 'design', label: 'MiC 拆分审查',
      goal: '请审查 C3 栋 15 层 MiC 模块的拆分方案，找出运输与吊装超限项和机电碰撞，并给出拆分优化建议。'
    },
    {
      id: 'safety', label: '多模态隐患巡检',
      goal: '请对 C3 栋 15 层作业面做一次多模态安全巡检，按严重度分级隐患并形成可派单的整改任务。'
    },
    {
      id: 'all', label: '全场综合复盘',
      goal: '请对海之韵项目做一次全场综合复盘：设计、施工、绿能、安全四个维度各出一份结论，并指出跨域冲突。'
    }
  ];

  var state = {
    busy: false,
    cfg: null,
    llm: null,
    modelLabel: '',
    paceMs: 420,
    canvas: null,
    trace: null,
    report: null,
    currentRun: 0
  };

  /* ================================================================== *
   * 启动
   * ================================================================== */
  function boot() {
    state.cfg = root.JR_CONFIG.load();
    rebuildLLM();

    // 视图装配
    root.JR_TWIN.render($('#twinPanel'));
    state.canvas = new root.JR_CANVAS.Canvas($('#canvasPanel'), null);
    state.trace = new root.JR_TRACE.TracePanel($('#tracePanel'));
    state.report = new root.JR_REPORT.Renderer($('#reportPanel'));

    renderScenarioChips();
    renderProviderBadge();
    renderSystemInfo();
    wireInput();
    wireSettings();

    state.trace.phase({ phase: 'receive', detail: '系统就绪 · 数据快照 ' + D.PROJECT.snapshotAt + ' · 可用工具 ' + root.JR_TOOLS.list().length + ' 个' });
  }

  function rebuildLLM() {
    state.llm = root.JR_LLM.createLLM({
      provider: state.cfg.provider,
      apiKey: state.cfg.apiKey,
      baseUrl: state.cfg.baseUrl,
      model: state.cfg.model,
      maxRetries: state.cfg.maxRetries
    });
    state.modelLabel = state.cfg.provider === 'offline' ? '离线 rule-react/1.0' : (state.cfg.model || state.cfg.provider);
  }

  /* ================================================================== *
   * 顶栏与侧栏
   * ================================================================== */
  function renderProviderBadge() {
    var el = $('#providerBadge');
    clear(el);
    var offline = state.cfg.provider === 'offline';
    el.appendChild(h('i', { class: 'dot' + (offline ? ' is-offline' : ' is-live') }));
    el.appendChild(h('span', { text: offline ? '离线确定性推理（无网络可运行）' : '在线模型 · ' + (state.cfg.model || state.cfg.provider) }));
    el.appendChild(h('button', { class: 'mini-btn', text: '设置', onclick: openSettings }));
  }

  function renderSystemInfo() {
    var box = $('#sysInfo');
    clear(box);
    var tools = root.JR_TOOLS.list();
    var byDomain = {};
    tools.forEach(function (t) { byDomain[t.domain] = (byDomain[t.domain] || 0) + 1; });
    box.appendChild(h('div', { class: 'sys-row' }, [
      h('span', { text: '项目' }), h('b', { text: D.PROJECT.name })
    ]));
    box.appendChild(h('div', { class: 'sys-row' }, [h('span', { text: '单体' }), h('b', { text: D.PROJECT.building })]));
    box.appendChild(h('div', { class: 'sys-row' }, [h('span', { text: '当前' }), h('b', { text: '第 ' + D.PROJECT.day + ' 天 · ' + D.PROJECT.phase })]));
    box.appendChild(h('div', { class: 'sys-row' }, [h('span', { text: '知识底座' }), h('b', { text: root.JR_KB.CHUNKS.length + ' 文本块 / ' + root.JR_KB.EDGES.length + ' 关系边' })]));
    box.appendChild(h('div', { class: 'sys-row' }, [h('span', { text: '工具' }), h('b', { text: tools.length + ' 个 · ' + Object.keys(byDomain).map(function (k) { return k + byDomain[k]; }).join(' / ') })]));
    box.appendChild(h('div', { class: 'sys-row' }, [h('span', { text: '智能体' }), h('b', { text: Object.keys(root.JR_PROMPTS.ROLES).length + ' 个（含调度中枢）' })]));
  }

  function renderScenarioChips() {
    var box = $('#scenarioChips');
    clear(box);
    SCENARIOS.forEach(function (s) {
      box.appendChild(h('button', {
        class: 'chip', 'data-scenario': s.id, text: s.label,
        onclick: function () {
          $('#goalInput').value = s.goal;
          $('#goalInput').focus();
        }
      }));
    });
  }

  /* ================================================================== *
   * 输入与运行
   * ================================================================== */
  function wireInput() {
    $('#runBtn').addEventListener('click', function () { startRun($('#goalInput').value); });
    $('#goalInput').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') startRun($('#goalInput').value);
    });
    $('#paceInput').addEventListener('change', function (e) {
      state.paceMs = parseInt(e.target.value, 10);
    });
    $('#resetBtn').addEventListener('click', function () {
      state.trace.reset();
      state.canvas.reset();
      state.report.clear();
      state.trace.phase({ phase: 'receive', detail: '已重置，可重新提交目标。' });
    });
  }

  function setBusy(b) {
    state.busy = b;
    var btn = $('#runBtn');
    btn.disabled = b;
    btn.textContent = b ? '编排中…' : '启动多智能体编排';
    document.body.classList.toggle('is-busy', b);
  }

  function startRun(goal) {
    goal = String(goal || '').trim();
    if (state.busy) return;
    if (!goal) { $('#goalInput').focus(); return; }

    state.currentRun++;
    var runId = state.currentRun;
    setBusy(true);
    state.trace.reset();
    state.canvas.reset();
    state.report.clear();
    state.llm = root.JR_LLM.createLLM({
      provider: state.cfg.provider, apiKey: state.cfg.apiKey,
      baseUrl: state.cfg.baseUrl, model: state.cfg.model, maxRetries: state.cfg.maxRetries
    });

    /* ------------------------------------------------------------------ *
     * 事件 → 视图的映射。这里刻意引入一个队列：模型推理可能在几十毫秒内
     * 全部完成，但评审需要看见过程，所以把事件按固定节奏逐条播放。
     * 队列与"编排是否结束"解耦：编排先算完，播放慢慢进行。
     * ------------------------------------------------------------------ */
    var queue = [];
    var playing = false;
    var runFinished = false;
    var agentNodes = {};
    var taskIdByAgent = {};   // 本轮每个 agent 只跑一个任务，直接映射即可

    function enqueue(fn) { queue.push(fn); }

    function pump() {
      if (playing) return;
      if (!queue.length) {
        if (runFinished) setBusy(false);
        return;
      }
      playing = true;
      var fn = queue.shift();
      try { fn(); } catch (e) { console.error('[ui]', e); }
      setTimeout(function () { playing = false; pump(); }, state.paceMs);
    }

    var emit = function (ev) {
      if (runId !== state.currentRun) return;
      switch (ev.type) {
        case 'phase':
          enqueue(function () { state.trace.phase(ev); });
          break;

        case 'task_start':
          enqueue(function () {
            taskIdByAgent[ev.agent] = ev.taskId;
            state.canvas.setState(ev.taskId, 'running', '执行中');
          });
          break;

        case 'agent_start':
          enqueue(function () {
            agentNodes[ev.roleId] = state.trace.agentStart(ev);
            state.canvas.highlightAgent(ev.roleId, true);
          });
          break;

        case 'step':
          enqueue(function () {
            state.trace.step(ev, agentNodes[ev.roleId]);
            var taskId = taskIdByAgent[ev.roleId];
            if (ev.step.action === 'final_answer' || !taskId) return;
            var card = state.canvas.cards[taskId];
            if (!card) return;
            card.toolCount = (card.toolCount || 0) + 1;
            state.canvas.bumpTask(taskId, card.toolCount, ev.step.latencyMs);
            if (ev.step.observation && ev.step.observation.ok) {
              root.JR_TWIN.reflectTool(ev.step.action, ev.step.observation.data);
            }
          });
          break;

        case 'agent_end':
          enqueue(function () {
            state.trace.agentEnd(ev);
            state.canvas.highlightAgent(ev.roleId, false);
          });
          break;

        case 'artifact':
          enqueue(function () {
            var taskId = taskIdByAgent[ev.artifact.agent];
            if (taskId) state.canvas.setState(taskId, 'done', '已完成');
          });
          break;

        default: break;
      }
    };

    root.JR_ORCHESTRATOR.run({
      goal: goal,
      llm: state.llm,
      onEvent: emit,
      onPlanReady: function (plan) {
        // 计划先于执行到达：先把依赖图画出来，任务卡等 task_start 再点亮
        state.canvas.setPlan(plan);
        Object.keys(plan.tasks).forEach(function (k) {
          state.canvas.setState(plan.tasks[k].id, 'wait', '待分派');
        });
      },
      maxStepsPerAgent: state.cfg.maxStepsPerAgent
    }).then(function (report) {
      runFinished = true;
      state.trace.setMetrics(report, { model: state.modelLabel });
      state.report.render(report, { model: state.modelLabel });
      pump();
    }).catch(function (err) {
      runFinished = true;
      state.trace.error('编排失败：' + (err && err.message ? err.message : String(err)));
      pump();
    });

    pump();
  }

  /* ================================================================== *
   * 设置弹窗
   * ================================================================== */
  function wireSettings() {
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsMask').addEventListener('click', function (e) { if (e.target.id === 'settingsMask') closeSettings(); });
    $('#presetSelect').addEventListener('change', function (e) {
      var p = root.JR_CONFIG.PRESETS.filter(function (x) { return x.id === e.target.value; })[0];
      if (!p) return;
      $('#providerSelect').value = p.provider;
      $('#baseUrlInput').value = p.baseUrl;
      $('#modelInput').value = p.model;
    });
    $('#saveSettings').addEventListener('click', function () {
      state.cfg.provider = $('#providerSelect').value;
      state.cfg.baseUrl = $('#baseUrlInput').value.trim();
      state.cfg.model = $('#modelInput').value.trim();
      state.cfg.apiKey = $('#apiKeyInput').value.trim();
      state.cfg.maxStepsPerAgent = parseInt($('#maxStepsInput').value, 10) || 6;
      root.JR_CONFIG.save(state.cfg);
      rebuildLLM();
      renderProviderBadge();
      closeSettings();
      state.trace.phase({ phase: 'receive', detail: '已切换决策模型：' + state.modelLabel });
    });
    $('#testSettings').addEventListener('click', function () {
      var box = $('#testResult');
      box.textContent = '测试中…';
      var probe = root.JR_LLM.createLLM({
        provider: $('#providerSelect').value,
        baseUrl: $('#baseUrlInput').value.trim(),
        model: $('#modelInput').value.trim(),
        apiKey: $('#apiKeyInput').value.trim(),
        maxRetries: 0
      });
      probe.decide({
        system: '你是测试探针，只输出 JSON。',
        user: '请输出 {"thought":"探针正常","action":"final_answer","answer":"pong"}',
        meta: { role: 'coordinator', calledTools: [], toolResults: [], forceFinal: true }
      }).then(function (d) {
        box.textContent = '成功 · ' + d.provider + ' / ' + d.model + ' · ' + d.latencyMs + ' ms · 解析结果：' + d.action;
        box.className = 'test-result is-ok';
      }).catch(function (e) {
        box.textContent = '失败：' + (e && e.message ? e.message : String(e));
        box.className = 'test-result is-bad';
      });
    });
  }

  function openSettings() {
    $('#settingsMask').classList.add('is-open');
    var preset = root.JR_CONFIG.PRESETS.filter(function (p) {
      return p.provider === state.cfg.provider && (p.baseUrl === state.cfg.baseUrl || !state.cfg.baseUrl);
    })[0];
    $('#presetSelect').value = preset ? preset.id : 'offline';
    $('#providerSelect').value = state.cfg.provider;
    $('#baseUrlInput').value = state.cfg.baseUrl;
    $('#modelInput').value = state.cfg.model;
    $('#apiKeyInput').value = state.cfg.apiKey;
    $('#maxStepsInput').value = state.cfg.maxStepsPerAgent;
    $('#testResult').textContent = '';
    $('#testResult').className = 'test-result';
  }
  function closeSettings() { $('#settingsMask').classList.remove('is-open'); }

  document.addEventListener('DOMContentLoaded', boot);
})(window);
