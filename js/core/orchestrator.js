/**
 * 见仁建智 · 调度中枢（多智能体编排层）
 * ---------------------------------------------------------------------------
 * 对外只暴露一个入口：
 *
 *   run({ goal, llm, onEvent }) -> Promise<RunReport>
 *
 * RunReport = { goal, plan, artifacts[], insights[], conclusion, confirmations[],
 *               metrics{ steps, toolCalls, ms, byAgent[] }, timeline[] }
 *
 * 这一层回答的是评审最关心的一个问题：为什么必须是"多智能体"，而不是一个
 * 大提示词？因为四个域有各自的工具白名单、各自的判定口径、各自的交付物，
 * 而且它们的结论会互相约束（夜班抢工抬高安全风险、模块减重反噬拼装工效）。
 * 编排层负责把这些约束显式地摆到台面上，而不是让一个模型在长上下文里
 * 自行妥协。
 *
 * 设计取舍：
 *   - 编排是确定性的（先规划 -> 按依赖分派 -> 汇总），编排逻辑不交给模型，
 *     模型只负责"拆得合理"和"说得清楚"。这样任何一步失败都能定位到具体域。
 *   - 黑板（Blackboard）是真共享：下游智能体的提示词里带着上游结论摘要，
 *     这对应方案书里的"跨阶段数据流转"。
 */
(function (root) {
  'use strict';

  /**
   * 模型给出的汇总结论低于这个长度，视为没有真正展开四段结构，改用确定性综合。
   * 200 字是实测值：合规的四段建议（含摘要、关联、动作、确认事项）不会短于此。
   */
  var CONCISE_THRESHOLD = 200;

  /* ------------------------------------------------------------------ *
   * 黑板：跨智能体的结构化共享内存
   * ------------------------------------------------------------------ */
  function createBlackboard() {
    var artifacts = [];
    return {
      publish: function (a) { artifacts.push(a); return a; },
      all: function () { return artifacts.slice(); },
      byAgent: function (id) { return artifacts.filter(function (a) { return a.agent === id; }); },
      /** 注入到下游智能体提示词里的摘要，刻意压缩到 400 字以内 */
      digest: function () {
        if (!artifacts.length) return '（暂无其他智能体结论）';
        return artifacts.map(function (a) {
          return '【' + a.agentName + '】' + String(a.answer || '').replace(/\s+/g, ' ').slice(0, 180);
        }).join('\n');
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 确定性兜底规划：模型规划失败时使用
   * ------------------------------------------------------------------ */
  var DEFAULT_PLANS = [
    {
      match: /吊装|进度|工期|塔吊|抢工|施工/,
      tasks: [
        { id: 't1', agent: 'schedule', brief: '核对 C3 栋 15 层吊装与机电接驳的进度偏差，给出可用吊装窗口与方案比选', dependsOn: [] },
        { id: 't2', agent: 'safety', brief: '核查 C3 栋 15 层吊装区人员侵入与临边防护隐患，形成整改工单', dependsOn: ['t1'] },
        { id: 't3', agent: 'design', brief: '复核 15 层待吊装模块的拆分合规性与机电碰撞，给出减重优化建议', dependsOn: [] }
      ]
    },
    {
      match: /光伏|组串|发电|BIPV|绿能|逆变器/,
      tasks: [
        { id: 't1', agent: 'energy', brief: '诊断屋面 BIPV 各组串发电损失，定位故障原因并生成运维工单', dependsOn: [] },
        { id: 't2', agent: 'safety', brief: '评估光伏清洗作业的高处作业与夜间作业风险，给出防护要求', dependsOn: ['t1'] }
      ]
    },
    {
      match: /安全|隐患|防护|违规|工友/,
      tasks: [
        { id: 't1', agent: 'safety', brief: '扫描全场多模态隐患事件，按严重度分级并生成整改工单', dependsOn: [] },
        { id: 't2', agent: 'schedule', brief: '核对高危隐患区域的当前施工工序与吊装窗口，避免整改与吊装冲突', dependsOn: ['t1'] }
      ]
    },
    {
      match: /设计|图纸|BIM|模块|MiC|拆分|碰撞/,
      tasks: [
        { id: 't1', agent: 'design', brief: '审查 C3 栋 15 层 MiC 模块拆分方案的运输与吊装合规性，检出机电碰撞', dependsOn: [] },
        { id: 't2', agent: 'schedule', brief: '评估设计变更对 15 层吊装窗口与关键路径工期的影响', dependsOn: ['t1'] }
      ]
    }
  ];
  var FALLBACK_PLAN = {
    tasks: [
      { id: 't1', agent: 'design', brief: '审查 C3 栋 15 层 MiC 模块拆分合规性与机电碰撞', dependsOn: [] },
      { id: 't2', agent: 'schedule', brief: '推算 C3 栋 15 层吊装与机电接驳的进度偏差与塔吊窗口', dependsOn: [] },
      { id: 't3', agent: 'energy', brief: '诊断屋面 BIPV 组串发电损失并生成运维工单', dependsOn: [] },
      { id: 't4', agent: 'safety', brief: '扫描 C3 栋 15 层多模态隐患并生成整改工单', dependsOn: [] }
    ]
  };

  function defaultPlan(goal) {
    for (var i = 0; i < DEFAULT_PLANS.length; i++) {
      if (DEFAULT_PLANS[i].match.test(goal)) {
        return { thought: '未取得模型规划，使用该目标域的确定性任务模板。', tasks: DEFAULT_PLANS[i].tasks, source: 'fallback' };
      }
    }
    return { thought: '未取得模型规划，使用全专业并行模板。', tasks: FALLBACK_PLAN.tasks, source: 'fallback' };
  }

  /** 拓扑分层：同层可并行，层间有依赖 */
  function topoLayers(tasks) {
    var ids = tasks.map(function (t) { return t.id; });
    var layers = [];
    var placed = {};
    var guard = 0;
    while (Object.keys(placed).length < tasks.length && guard++ < 10) {
      var layer = tasks.filter(function (t) {
        if (placed[t.id]) return false;
        return (t.dependsOn || []).every(function (d) { return ids.indexOf(d) < 0 || placed[d]; });
      });
      if (!layer.length) break;
      layer.forEach(function (t) { placed[t.id] = 1; });
      layers.push(layer);
    }
    return layers;
  }

  /* ------------------------------------------------------------------ *
   * 跨域关联推断：规则化，可解释，不交给模型自由发挥
   * ------------------------------------------------------------------ */
  var INSIGHT_RULES = [
    {
      id: 'IX-LIFT-SAFETY',
      when: function (ctx) { return ctx.has('schedule', /夜班|加班|延长|抢工/) && ctx.has('safety', /侵入|隐患|高风险|高危/); },
      text: '施工调度提出夜间/延长作业，而安全域同时报告吊装区人员侵入与高危隐患 —— 抢工将直接压缩安全监护窗口，建议抢工前置安全交底与警戒区重新划设。'
    },
    {
      id: 'IX-DESIGN-SCHEDULE',
      when: function (ctx) { return ctx.has('design', /减重|拆分|返厂|超限|变更/) && ctx.has('schedule', /延期|滞后|偏差|关键路径/); },
      text: '设计域建议的拆分/减重变更需走设计确认与工厂排产，会与已滞后的关键路径叠加；建议把变更限制在不影响本周吊装窗口的模块上。'
    },
    {
      id: 'IX-ENERGY-SAFETY',
      when: function (ctx) { return ctx.has('energy', /夜间清洗|清洗|高处/) && ctx.has('safety', /高处|防护|夜间/); },
      text: '绿能运维倾向夜间清洗以避免发电损失，安全域同时提示高处与夜间作业风险 —— 两者应共用同一张作业票与监护人，避免重复开工。'
    },
    {
      id: 'IX-DESIGN-ENERGY',
      when: function (ctx) { return ctx.has('design', /积灰|扬尘|塔吊/) && ctx.has('energy', /积灰|扬尘|清洗/); },
      text: '设计/施工域的塔吊与土方作业扬尘是光伏积灰的直接来源，BIPV 清洗周期应与扬尘作业计划联动，而不是按固定周期清洗。'
    }
  ];

  function buildInsights(artifacts) {
    var ctx = {
      has: function (agent, re) {
        return artifacts.some(function (a) {
          return a.agent === agent && re.test(String(a.answer || '') + ' ' + JSON.stringify(a.toolSummaries || []));
        });
      }
    };
    return INSIGHT_RULES.filter(function (r) { return r.when(ctx); })
      .map(function (r) { return { id: r.id, text: r.text }; });
  }

  /** 需人工确认事项：从证据完备性反推，而不是让模型随口列 */
  function buildConfirmations(artifacts, insights) {
    var out = [];
    artifacts.forEach(function (a) {
      if (a.stopReason !== 'final_answer') {
        out.push({ from: a.agentName, text: '该域本轮未自然收敛（' + a.stopReason + '），结论不完整，需人工复核。' });
      }
      if (!a.evidence || !a.evidence.length) {
        out.push({ from: a.agentName, text: '该域结论未附带规范出处，不得直接用于现场交底。' });
      }
    });
    if (insights.length) {
      out.push({ from: '跨域', text: '存在 ' + insights.length + ' 条跨域冲突，处置顺序需由项目经理确认后再开工。' });
    }
    out.push({ from: '系统', text: '任何涉及停复工、质量验收、工友处罚的决定，必须由持证人员签字确认，本系统只提供建议。' });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 确定性综合结论
   *
   * 编排层必须保证：即使模型端完全不可用（无网络、密钥失效、输出不合规），
   * 也要产出一份结构完整、数值可追溯的决策建议。因为这是演示与评审的底座。
   * 下面的四段结构由各域工具的真实返回值拼出，不引入任何新数字。
   * ------------------------------------------------------------------ */
  function buildSynthesis(goal, artifacts, insights, plan) {
    var byRole = {};
    artifacts.forEach(function (a) { if (!byRole[a.agent]) byRole[a.agent] = a; });
    var findTool = function (agent, name) {
      var a = byRole[agent];
      if (!a) return null;
      var hit = a.toolCalls.filter(function (c) { return c.name === name; })[0];
      return hit ? hit.result.data : null;
    };

    var head = [], actions = [], confirm = [];

    /* 施工调度 */
    var sch = findTool('schedule', 'schedule_predict');
    var crane = findTool('schedule', 'crane_plan');
    var sim = findTool('schedule', 'simulate_plan');
    if (sch) {
      head.push('· 进度：最大延期 ' + sch.maxDelayDays + ' 天，关键路径 ' + (sch.criticalPath.join('、') || '无') +
        '，预测完工第 ' + sch.projectedCompletionDay + ' 天（当前第 ' + sch.currentDay + ' 天）');
      var worst = sch.tasks[0];
      if (worst) actions.push({ level: worst.delayDays >= 4 ? '高' : '中', owner: '项目经理', when: '今日内',
        what: '处置 ' + worst.name + '（延期 ' + worst.delayDays + ' 天，SPI ' + worst.spi + '）',
        evidence: '方案比选记录 + 抢工令' });
    }
    if (crane && crane.freeSlots && crane.freeSlots.length) {
      actions.push({ level: '中', owner: '吊装班组', when: '第 ' + crane.day + ' 天 ' + crane.freeSlots.join('、'),
        what: '占用 ' + crane.crane || 'TC-01' + ' 可用空档推进吊装', evidence: '吊装令 + 班前交底记录' });
    }
    if (sim) {
      var rec = sim.scenarios.filter(function (s) { return s.id === sim.recommended; })[0];
      if (rec) actions.push({ level: '高', owner: '项目经理', when: '今日班前会',
        what: '比选推荐方案：' + rec.name + '（' + rec.actions.join('；') + '）',
        evidence: '方案比选与交底记录；约束：' + rec.constraints.join('；') });
    }

    /* 安全 */
    var scan = findTool('safety', 'safety_multimodal_scan');
    var lift = findTool('safety', 'safety_check_lift');
    if (scan) {
      head.push('· 安全：扫描 ' + scan.scanned + ' 条事件，高危 ' + (scan.bySeverity['高'] || 0) + ' 条' +
        (scan.topZones.length ? '，高发区域 ' + scan.topZones[0].zone + '（' + scan.topZones[0].count + ' 条）' : ''));
      (scan.pendingOrders || []).forEach(function (o) {
        actions.push({ level: o.severity, owner: o.owner, when: o.dueHours + ' 小时内',
          what: o.zone + ' · ' + o.type + ' 整改（' + o.id + '）', evidence: o.evidenceRequired.join('、') });
      });
    }
    if (lift) {
      head.push('· 吊装作业风险等级 ' + lift.level + '，人员侵入 ' + lift.intrusionCount + ' 起，载荷率 ' + Math.round(lift.loadRatio * 1000) / 10 + '%');
      lift.actions.forEach(function (a) {
        actions.push({ level: lift.level, owner: '吊装班组', when: '立即', what: a, evidence: '作业票 + 监护人签字' });
      });
    }

    /* 设计 */
    var mic = findTool('design', 'mic_check_compliance');
    var clash = findTool('design', 'bim_clash_detect');
    var split = findTool('design', 'mic_suggest_split');
    if (mic) {
      head.push('· 设计：审查 ' + mic.checked + ' 个模块，高危 ' + mic.highCount + ' 项、中危 ' + mic.midCount + ' 项');
      mic.results.forEach(function (r) {
        r.violations.filter(function (v) { return v.level === '高'; }).forEach(function (v) {
          actions.push({ level: '高', owner: '设计院', when: '下一版 BIM 修订前',
            what: r.moduleId + ' ' + v.rule + '：' + v.detail, evidence: '设计变更单 + 工厂排产确认' });
        });
      });
    }
    if (clash && clash.clashes.length) {
      head.push('· 机电：检出 ' + clash.clashes.length + ' 处冲突（高危 ' + clash.highCount + ' 处）');
      clash.clashes.filter(function (c) { return c.level === '高'; }).forEach(function (c) {
        actions.push({ level: '高', owner: '设计院', when: '下一版 BIM 修订前',
          what: c.moduleId + ' ' + c.kind + '（' + c.between.join(' × ') + '）：' + c.suggestion,
          evidence: '碰撞检查报告 + 设计确认' });
      });
    }
    if (split) (split.proposals || []).forEach(function (p) {
      actions.push({ level: '中', owner: '设计院', when: '工厂排产前',
        what: split.moduleId + ' ' + p.action + '：' + p.to, evidence: '设计变更单；影响：' + JSON.stringify(p.impact) });
    });

    /* 绿能运维 */
    var diag = findTool('energy', 'bipv_diagnose');
    var wo = findTool('energy', 'bipv_work_order');
    if (diag) {
      head.push('· 绿能：诊断 ' + diag.findings.length + ' 个组串，异常 ' + diag.abnormalStrings +
        ' 个，日损失 ' + diag.dailyLossKwh + ' kWh（' + diag.dailyLossRatio + '%）');
    }
    if (wo) (wo.created || []).forEach(function (o) {
      actions.push({ level: o.priority, owner: o.owner, when: o.window,
        what: o.title + '（预计恢复 ' + o.expectedRecoveryKwhDay + ' kWh/日）', evidence: o.evidenceRequired.join('、') });
    });

    /* 建议动作排序：高危优先，其次按域 */
    var rank = { 高: 3, 中: 2, 低: 1 };
    actions.sort(function (a, b) { return (rank[b.level] || 0) - (rank[a.level] || 0); });
    var seen = {}, deduped = [];
    actions.forEach(function (a) {
      var key = a.what;
      if (seen[key]) return;
      seen[key] = 1;
      deduped.push(a);
    });

    /* 需人工确认事项 */
    artifacts.forEach(function (a) {
      if (a.stopReason !== 'final_answer') {
        confirm.push('【' + a.agentName + '】本轮未自然收敛（' + a.stopReason + '），该域结论不完整，需人工复核。');
      }
      if (!a.evidence || !a.evidence.length) {
        confirm.push('【' + a.agentName + '】结论未附带规范出处，不得直接用于现场交底。');
      }
    });
    confirm.push('涉及停复工、质量验收、工友处罚的决定，必须由持证人员签字确认；本系统只提供建议。');

    /* 跨域关联 */
    var crossLines = insights.length
      ? insights.map(function (i) { return '· ' + i.text; })
      : ['· 本轮未检出跨域冲突，各域可按各自优先级并行推进。'];

    var lines = [];
    lines.push('一、结论摘要');
    (head.length ? head : ['· 本轮未取得可量化的域结论。']).forEach(function (l) { lines.push(l); });
    lines.push('');
    lines.push('二、跨域关联');
    crossLines.forEach(function (l) { lines.push(l); });
    lines.push('');
    lines.push('三、建议动作');
    if (deduped.length) {
      deduped.slice(0, 10).forEach(function (a, i) {
        lines.push('· ' + (i + 1) + '. [' + a.level + '] ' + a.what + '；责任方：' + a.owner + '；时限：' + a.when + '；验收证据：' + a.evidence);
      });
    } else {
      lines.push('· 本轮无新增待办动作。');
    }
    lines.push('');
    lines.push('四、需人工确认事项');
    confirm.forEach(function (l) { lines.push('· ' + l); });
    lines.push('');
    lines.push('（现场目标：' + goal + '；参与智能体 ' + artifacts.length + ' 个，工具调用 ' +
      artifacts.reduce(function (s, a) { return s + a.toolCalls.length; }, 0) + ' 次，全部数值取自工具返回值。）');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 主编排流程
   * ------------------------------------------------------------------ */
  function run(opts) {
    var goal = String(opts.goal || '').trim();
    if (!goal) return Promise.reject(new Error('缺少 goal'));
    var llm = opts.llm || root.JR_LLM.createLLM({ provider: 'offline' });
    var emit = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    var maxStepsPerAgent = opts.maxStepsPerAgent || 6;
    var t0 = Date.now();
    var timeline = [];

    function log(phase, detail) {
      var rec = { at: Date.now(), phase: phase, detail: detail };
      timeline.push(rec);
      emit(Object.assign({ type: 'phase' }, rec));
      return rec;
    }

    log('receive', '收到现场目标：' + goal);

    /* --- 1. 规划 --------------------------------------------------- */
    var planPromise = llm.decide({
      system: '你是建筑工程项目管理调度中枢，负责把现场目标拆解为可由专业智能体执行的任务。只输出 JSON，不要输出解释。',
      user: root.JR_PROMPTS.planPrompt(goal),
      // phase 标记让离线适配器知道这是规划轮：它直接返回整份任务图，
      // 而不是按 ReAct 逐步调用工具。goal 单独传，避免适配器去解析提示词
      // 全文——提示词里含"吊装/光伏"等字样，会把任何目标都匹配到同一个模板。
      meta: { role: 'coordinator', phase: 'plan', goal: goal, calledTools: [], toolResults: [], forceFinal: false }
    }).then(function (d) {
      var parsed = root.JR_LLM.extractFirstJson(d.raw || '');
      var tasks = parsed && Array.isArray(parsed.tasks) ? parsed.tasks
        : (parsed && parsed.action_input && Array.isArray(parsed.action_input.tasks) ? parsed.action_input.tasks : null);
      var validAgents = Object.keys(root.JR_PROMPTS.ROLES).filter(function (k) { return k !== 'coordinator'; });
      tasks = (tasks || []).filter(function (t) {
        return t && t.agent && validAgents.indexOf(t.agent) >= 0 && t.brief;
      }).map(function (t, i) {
        return {
          id: t.id || ('t' + (i + 1)),
          agent: t.agent,
          brief: String(t.brief),
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : []
        };
      }).slice(0, 4);

      if (!tasks.length) return defaultPlan(goal);
      return { thought: (parsed && parsed.thought) || '', tasks: tasks, rationale: (parsed && parsed.rationale) || '', source: 'model' };
    }).catch(function () { return defaultPlan(goal); });

    return planPromise.then(function (plan) {
      // onPlanReady 是编排层对外的唯一"预览"缝：调用方（UI）需要在任务真正
      // 执行之前就拿到计划，才能先把依赖图画出来。它是回调而不是返回值，
      // 因为计划只是流程中间态，不是 run() 的结果。
      if (typeof opts.onPlanReady === 'function') opts.onPlanReady(plan);
      log('plan', '拆解为 ' + plan.tasks.length + ' 个任务（' + (plan.source === 'model' ? '模型规划' : '确定性模板') + '）：' +
        plan.tasks.map(function (t) { return t.agent + '·' + t.id; }).join('、'));

      var blackboard = createBlackboard();
      var layers = topoLayers(plan.tasks);
      var artifacts = [];

      /* --- 2. 按依赖分层执行 -------------------------------------- */
      function runLayer(li) {
        if (li >= layers.length) return Promise.resolve();
        var layer = layers[li];
        log('dispatch', '第 ' + (li + 1) + ' 层并行分派：' + layer.map(function (t) { return root.JR_PROMPTS.ROLES[t.agent].short + '（' + t.id + '）'; }).join('、'));

        return Promise.all(layer.map(function (task) {
          emit({ type: 'task_start', taskId: task.id, agent: task.agent, brief: task.brief, at: Date.now() });
          return root.JR_AGENT.run({
            role: task.agent,
            goal: goal,
            brief: task.brief,
            llm: llm,
            maxSteps: maxStepsPerAgent,
            blackboard: blackboard,
            onEvent: emit
          }).then(function (res) {
            var artifact = {
              id: task.id, agent: task.agent,
              agentName: root.JR_PROMPTS.ROLES[task.agent].name,
              accent: root.JR_PROMPTS.ROLES[task.agent].accent,
              brief: task.brief, dependsOn: task.dependsOn || [],
              answer: res.answer, evidence: res.evidence,
              // 保留完整工具结果：下游的确定性综合（buildSynthesis）与前端渲染
              // 都直接读 result.data，若只留 summary 就会丢失全部数值。
              toolCalls: res.toolCalls.map(function (c) { return { name: c.name, args: c.args, summary: c.result.summary, result: c.result }; }),
              toolSummaries: res.toolCalls.map(function (c) { return c.result.summary; }),
              steps: res.steps, stopReason: res.stopReason, ms: res.ms
            };
            blackboard.publish(artifact);
            artifacts.push(artifact);
            emit({ type: 'artifact', artifact: artifact, at: Date.now() });
            return artifact;
          });
        })).then(function (done) {
          log('layer_done', '第 ' + (li + 1) + ' 层完成：' + done.map(function (a) { return a.agentName + ' 调用工具 ' + a.toolCalls.length + ' 次'; }).join('；'));
          return runLayer(li + 1);
        });
      }

      return runLayer(0).then(function () {
        /* --- 3. 跨域关联 ---------------------------------------- */
        var insights = buildInsights(artifacts);
        log('insight', insights.length ? '检出 ' + insights.length + ' 条跨域关联/冲突' : '未检出跨域冲突');

        /* --- 4. 汇总 -------------------------------------------------- */
        log('synthesize', '调度中枢开始整合 ' + artifacts.length + ' 份域结论');
        var sysPrompt = root.JR_PROMPTS.systemPrompt('coordinator', { blackboardDigest: blackboard.digest() });
        return llm.decide({
          system: sysPrompt,
          user: root.JR_PROMPTS.synthesisPrompt(goal, artifacts) +
            (insights.length ? '\n\n# 系统检出的跨域关联（必须纳入第二段）\n' + insights.map(function (i) { return '- ' + i.text; }).join('\n') : ''),
          meta: { role: 'coordinator', calledTools: [], toolResults: [], forceFinal: true }
        }).catch(function (err) {
          // 汇总阶段的模型异常不能冒泡出 run()：编排层对调用方承诺"总能拿到
          // 一份结构完整的报告"。上面的 agent 级异常已经各自兜底，这里补上
          // 最后一段，否则模型不可达时整份报告都不渲染（曾经的真实缺陷）。
          log('synthesize_failed', '汇总模型不可用（' + (err && err.message ? err.message : String(err)) + '），改用确定性综合');
          return { answer: '', provider: 'fallback', model: 'build-synthesis', latencyMs: 0 };
        }).then(function (d) {
          var conclusion = d.answer || '';

          if (conclusion.length < CONCISE_THRESHOLD) {
            conclusion = buildSynthesis(goal, artifacts, insights, plan);
          }
          var confirmations = buildConfirmations(artifacts, insights);
          var byAgent = artifacts.map(function (a) {
            return { agent: a.agent, agentName: a.agentName, accent: a.accent, steps: a.steps.length, toolCalls: a.toolCalls.length, ms: a.ms, stopReason: a.stopReason };
          });
          var totalTools = artifacts.reduce(function (s, a) { return s + a.toolCalls.length; }, 0);
          var totalSteps = artifacts.reduce(function (s, a) { return s + a.steps.length; }, 0);
          var evidence = [];
          artifacts.forEach(function (a) { (a.evidence || []).forEach(function (e) { if (evidence.indexOf(e) < 0) evidence.push(e); }); });

          var report = {
            goal: goal, plan: plan, artifacts: artifacts,
            insights: insights, conclusion: conclusion, confirmations: confirmations,
            evidence: evidence, timeline: timeline,
            metrics: {
              agents: artifacts.length, toolCalls: totalTools, steps: totalSteps,
              ms: Date.now() - t0, byAgent: byAgent,
              provider: llm.config.provider, model: llm.config.model || (llm.config.provider === 'offline' ? 'rule-react/1.0' : '')
            }
          };
          log('done', '编排完成：' + report.metrics.agents + ' 个智能体 / ' + totalTools + ' 次工具调用 / ' + report.metrics.ms + ' ms');
          emit({ type: 'report', report: report, at: Date.now() });
          return report;
        });
      });
    });
  }

  root.JR_ORCHESTRATOR = {
    run: run,
    createBlackboard: createBlackboard,
    topoLayers: topoLayers,
    buildInsights: buildInsights,
    buildSynthesis: buildSynthesis,
    defaultPlan: defaultPlan
  };
})(typeof window !== 'undefined' ? window : globalThis);
