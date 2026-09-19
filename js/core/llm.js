/**
 * 见仁建智 · 决策核心层（LLM 适配器）
 * ---------------------------------------------------------------------------
 * 这一层把"模型"抽象成一个可替换的适配器，接口只有一个方法：
 *
 *     complete({ system, user, toolSchemas, temperature, maxTokens })
 *       -> Promise<{ text, provider, model, latencyMs, usage, raw }>
 *
 * 适配器实现（adapters）：
 *   - offline  ：本地确定性推理器。无网络、无密钥即可完整跑通全部闭环，
 *                保证评审现场演示不依赖外部服务。它不是"假回答"：
 *                它按同一套 ReAct 协议产出工具调用，只是决策由规则打分完成。
 *   - openai   ：OpenAI 兼容 /chat/completions（DeepSeek、Qwen、GLM、vLLM 均可）
 *   - anthropic：Anthropic Messages API
 *
 * 模型层只负责"说什么、调哪个工具"；数值判定全部由 tools.js 完成，
 * 因此离线与在线两条路径的结论一致，演示可复现。
 *
 * 安全：浏览器直连第三方 API 会暴露密钥且受 CORS 限制，正式部署应经
 *       gateway/（本地 Node 网关）转发。见 README「三种运行模式」。
 */
(function (root) {
  'use strict';

  var registry = {};

  function register(name, adapterFn, meta) {
    registry[name] = { call: adapterFn, meta: meta || {} };
  }
  function listProviders() {
    return Object.keys(registry).map(function (k) {
      return { name: k, label: registry[k].meta.label || k, needsKey: !!registry[k].meta.needsKey, note: registry[k].meta.note || '' };
    });
  }

  /* ================================================================== *
   * 适配器 1：离线确定性推理器
   * ================================================================== */
  /**
   * 不是随机伪造：它读取 system 中的策略与 user 中的目标，沿着
   * 「已调工具 -> 尚未覆盖的域 -> 该域优先级最高的工具」这条链决策，
   * 因此与在线模型走的是同一套 ReAct 轨迹，可被测试断言。
   */
  var PLAN = {
    design: ['kb_search', 'mic_check_compliance', 'bim_clash_detect', 'mic_suggest_split'],
    schedule: ['kb_search', 'schedule_predict', 'crane_plan', 'safety_check_lift', 'simulate_plan'],
    energy: ['kb_search', 'bipv_diagnose', 'bipv_work_order'],
    safety: ['kb_search', 'safety_multimodal_scan', 'safety_check_lift', 'dispatch_order'],
    coordinator: ['kb_search', 'defect_list']
  };

  /**
   * 规划用的任务模板。放在适配器内部而不是编排层，是因为它属于"这个模型
   * 怎么规划"的知识，而不是"编排流程怎么走"的知识；编排层只认最终的任务数组。
   *
   * 选择逻辑 = 关键词命中次数 × weight，取最高分。weight 反映"这个词有多
   * 专属"：全场/综合是强信号，设计域与绿能域的术语（拆分、碰撞、组串）
   * 指向明确的执行者，而吊装/施工是行业通用词，任何建筑目标里都可能出现，
   * 因此权重最低。按数组顺序取第一个模板会让"MiC 拆分审查"被吊装模板截胡。
   */
  var PLAN_TEMPLATES = [
    {
      id: 'comprehensive', weight: 3,
      match: /全场|综合|复盘|四个维度|全部维度|整体/g,
      tasks: [
        { id: 't1', agent: 'design', brief: '审查 C3 栋 15 层 MiC 模块拆分方案的运输与吊装合规性，检出机电碰撞与拆分优化点', dependsOn: [] },
        { id: 't2', agent: 'schedule', brief: '推算 C3 栋 15 层吊装与机电接驳的进度偏差，给出塔吊可用窗口与方案比选', dependsOn: [] },
        { id: 't3', agent: 'energy', brief: '诊断屋面 BIPV 各组串发电损失，定位故障原因并生成运维工单', dependsOn: [] },
        { id: 't4', agent: 'safety', brief: '扫描 C3 栋 15 层多模态隐患事件，按严重度分级并形成整改任务', dependsOn: ['t2'] }
      ]
    },
    {
      id: 'design', weight: 2,
      match: /设计|图纸|BIM|拆分|碰撞|合规|MiC\s*模块|模块化/g,
      tasks: [
        { id: 't1', agent: 'design', brief: '审查 C3 栋 15 层 MiC 模块拆分方案的运输与吊装合规性，检出机电碰撞', dependsOn: [] },
        { id: 't2', agent: 'schedule', brief: '评估设计变更对 15 层吊装窗口与关键路径工期的影响', dependsOn: ['t1'] }
      ]
    },
    {
      id: 'energy', weight: 2,
      match: /光伏|组串|BIPV|绿能|逆变器|发电/g,
      tasks: [
        { id: 't1', agent: 'energy', brief: '诊断屋面 BIPV 各组串发电损失，定位故障原因并生成运维工单', dependsOn: [] },
        { id: 't2', agent: 'safety', brief: '评估光伏清洗作业的高处作业与夜间作业风险，给出防护要求', dependsOn: ['t1'] }
      ]
    },
    {
      id: 'lift', weight: 1,
      match: /吊装|进度|工期|塔吊|抢工|施工/g,
      tasks: [
        { id: 't1', agent: 'schedule', brief: '核对 C3 栋 15 层吊装与机电接驳的进度偏差，给出可用吊装窗口与方案比选', dependsOn: [] },
        { id: 't2', agent: 'safety', brief: '核查 C3 栋 15 层吊装区人员侵入与临边防护隐患，形成整改工单', dependsOn: ['t1'] },
        { id: 't3', agent: 'design', brief: '复核 15 层待吊装模块的拆分合规性与机电碰撞，给出减重优化建议', dependsOn: [] }
      ]
    },
    {
      id: 'safety', weight: 1,
      match: /安全|隐患|防护|违规|工友/g,
      tasks: [
        { id: 't1', agent: 'safety', brief: '扫描全场多模态隐患事件，按严重度分级并生成整改工单', dependsOn: [] },
        { id: 't2', agent: 'schedule', brief: '核对高危隐患区域的当前施工工序与吊装窗口，避免整改与吊装冲突', dependsOn: ['t1'] }
      ]
    }
  ];

  function selectTemplate(goalText) {
    var t = goalText || '';
    var best = null, bestScore = 0;
    PLAN_TEMPLATES.forEach(function (tpl) {
      if (!tpl.match.test(t)) return;
      var hits = (t.match(tpl.match) || []).length;
      var score = hits * tpl.weight;
      if (score > bestScore) { bestScore = score; best = tpl; }
    });
    return best;
  }

  /**
   * 规划提示里带了"可用执行者"，但离线适配器不需要解析它——它直接用模板。
   * 返回 { tasks } 的形状与在线模型的规划输出保持一致，编排层无需分支。
   */
  function offlinePlan(goalText) {
    var tpl = selectTemplate(goalText);
    if (!tpl) return null;
    return tpl.tasks.map(function (t) {
      return { id: t.id, agent: t.agent, brief: t.brief, dependsOn: (t.dependsOn || []).slice() };
    });
  }

  function makeOfflineAdapter() {
    /** 规划轮：orchestrator 在 meta.phase 上打标，据此切换到"整份任务图"模式 */
    function isPlanPhase(req) {
      return !!(req && req.meta && req.meta.phase === 'plan');
    }

    function pick(role, called, goalText) {
      var plan = PLAN[role] || PLAN.coordinator;
      for (var i = 0; i < plan.length; i++) {
        if (called.indexOf(plan[i]) < 0) return plan[i];
      }
      return null;
    }

    function argsFor(toolName, goalText) {
      var t = goalText || '';
      switch (toolName) {
        case 'kb_search':
          if (/积灰|热斑|光伏|组串|发电/.test(t)) return { query: '光伏 积灰 热斑 组串 电流', topK: 3 };
          if (/吊装|塔吊|起重|半径/.test(t)) return { query: '吊装 警戒区 吊装半径 塔吊 交叉', topK: 3 };
          if (/套管|防水|渗漏|拼缝/.test(t)) return { query: '套管 楼板 预埋 偏位 灌水试验', topK: 3 };
          return { query: '装配式 吊装 运输 限宽', topK: 3 };
        case 'mic_check_compliance': return {};
        case 'bim_clash_detect': return { floor: 15 };
        case 'mic_suggest_split': return { moduleId: /M-15\d\d/.test(t) ? (t.match(/M-15\d\d/) || ['M-1510'])[0] : 'M-1510' };
        case 'schedule_predict': return { horizonDays: 3 };
        case 'crane_plan': return {};   // 不传 day：工具默认用当前快照日
        case 'safety_check_lift': return { zone: 'C3-15F 吊装区' };
        case 'safety_multimodal_scan': return { floor: 15 };
        case 'bipv_diagnose': return {};
        case 'bipv_work_order': return {};
        case 'defect_list': return { minSeverity: '中' };
        case 'dispatch_order': return { defectId: 'DF-102' };
        case 'simulate_plan': return { goal: /光伏|组串|清洗/.test(t) ? 'clean' : 'lift' };
        default: return {};
      }
    }

    function summarise(role, results) {
      var lines = results.map(function (r) {
        return '· ' + r.tool + ' → ' + r.summary;
      });
      var cites = {};
      results.forEach(function (r) { (r.cites || []).forEach(function (c) { cites[c.doc + ' ' + c.clause] = 1; }); });
      var citeList = Object.keys(cites);
      var head = {
        design: '设计智审：本轮完成模块合规、碰撞与拆分优化校核。',
        schedule: '施工调度：本轮完成进度推演、塔吊排程与吊装风险评估。',
        energy: '绿能运维：本轮完成组串诊断与工单生成。',
        safety: '安全巡检：本轮完成多模态隐患扫描与派单建议。',
        coordinator: '调度中枢：本轮完成跨域信息汇总。'
      }[role] || '本轮完成。';
      return head + '\n' + lines.join('\n') +
        (citeList.length ? '\n依据：' + citeList.slice(0, 6).join('；') : '') +
        '\n（结论中的数值全部来自工具返回值，未作外推。）';
    }

    return function offlineComplete(req) {
      var started = Date.now();
      var role = (req.meta && req.meta.role) || 'coordinator';
      var called = (req.meta && req.meta.calledTools) || [];
      var results = (req.meta && req.meta.toolResults) || [];
      var forceFinal = !!(req.meta && req.meta.forceFinal);

      var next = forceFinal ? null : pick(role, called, req.user);

      // 规划阶段：离线适配器不产出 ReAct 动作，而是直接给出整份任务图。
      // orchestrator 会对 action='plan' 直接采纳 action_input.tasks，
      // 这样"模型自主拆解"与"模板兜底"共用同一条代码路径。
      if (isPlanPhase(req) && !forceFinal) {
        // 优先用 meta.goal（权威目标），只有拿不到时才退回解析提示词全文
        var goalText = (req.meta && req.meta.goal) || req.user;
        var tasks = offlinePlan(goalText);
        if (tasks) {
          return Promise.resolve({
            text: JSON.stringify({
              thought: '按目标关键词匹配到「' + selectTemplate(goalText).id + '」任务模板，覆盖该目标真正相关的专业域。',
              action: 'plan',
              action_input: { tasks: tasks }
            }, null, 2),
            provider: 'offline', model: 'rule-react/1.0',
            latencyMs: Date.now() - started, usage: null
          });
        }
      }

      if (next) {
        var payload = {
          thought: thoughtFor(role, next, req.user),
          action: next,
          action_input: argsFor(next, req.user)
        };
        return Promise.resolve({
          text: JSON.stringify(payload, null, 2),
          provider: 'offline', model: 'rule-react/1.0',
          latencyMs: Date.now() - started, usage: null
        });
      }
      return Promise.resolve({
        text: JSON.stringify({ thought: '信息已足够', action: 'final_answer', answer: summarise(role, results) }, null, 2),
        provider: 'offline', model: 'rule-react/1.0',
        latencyMs: Date.now() - started, usage: null
      });
    };

    function thoughtFor(role, tool, goal) {
      var map = {
        kb_search: '先检索规范与历史处置经验，确保后续判定的依据可追溯。',
        mic_check_compliance: '拿到依据后逐条校核模块几何与吨位是否满足运输和吊装约束。',
        bim_clash_detect: '合规性之外还需检查机电与结构的空间冲突。',
        mic_suggest_split: '对不满足约束的模块给出可执行的拆分方案与代价。',
        schedule_predict: '先量化进度偏差，再决定是否需要抢工方案。',
        crane_plan: '进度受吊装能力约束，需核对塔吊时段与风速限制。',
        safety_check_lift: '吊装窗口内必须确认无人员侵入与载荷超限。',
        safety_multimodal_scan: '并行扫描视频 AI 与人员定位事件，识别高危隐患。',
        bipv_diagnose: '按组串比对期望与实际发电量，定位损失来源。',
        bipv_work_order: '对确认异常的组串自动生成带验收要求的工单。',
        defect_list: '汇总各域产生的缺陷，确认未闭环项。',
        dispatch_order: '把高危且未闭环的缺陷派到对应班组并明确验收证据。',
        simulate_plan: '在多个可行动作之间做一次确定性比选，避免拍脑袋决策。'
      };
      return (map[tool] || '继续收集信息。') + '（目标：' + String(goal || '').slice(0, 40) + '）';
    }
  }

  register('offline', makeOfflineAdapter(), {
    label: '离线确定性推理', needsKey: false,
    note: '无网络即可运行，按 ReAct 协议产出工具调用，数值仍由工具层计算'
  });

  /* ================================================================== *
   * 适配器 2：OpenAI 兼容接口
   * ================================================================== */
  function openaiComplete(req) {
    var cfg = req.config || {};
    var base = (cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, '');
    var started = Date.now();
    var body = {
      model: cfg.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      temperature: req.temperature == null ? 0.2 : req.temperature,
      max_tokens: req.maxTokens || 1200,
      response_format: { type: 'json_object' }
    };
    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.apiKey || '') },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('LLM ' + r.status + ': ' + t.slice(0, 300)); });
      return r.json();
    }).then(function (j) {
      var choice = (j.choices && j.choices[0]) || {};
      return {
        text: (choice.message && choice.message.content) || '',
        provider: 'openai', model: j.model || body.model,
        latencyMs: Date.now() - started, usage: j.usage || null
      };
    });
  }

  register('openai', openaiComplete, {
    label: 'OpenAI 兼容', needsKey: true,
    note: 'DeepSeek / Qwen(DashScope 兼容模式) / GLM / vLLM 均可；浏览器直连受 CORS 限制，建议经 gateway 转发'
  });

  /* ================================================================== *
   * 适配器 3：Anthropic Messages
   * ================================================================== */
  function anthropicComplete(req) {
    var cfg = req.config || {};
    var base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    var started = Date.now();
    var body = {
      model: cfg.model || 'claude-sonnet-4-5',
      max_tokens: req.maxTokens || 1200,
      temperature: req.temperature == null ? 0.2 : req.temperature,
      system: req.system,
      messages: [{ role: 'user', content: req.user }]
    };
    return fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('LLM ' + r.status + ': ' + t.slice(0, 300)); });
      return r.json();
    }).then(function (j) {
      var text = (j.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      return { text: text, provider: 'anthropic', model: j.model || body.model, latencyMs: Date.now() - started, usage: j.usage || null };
    });
  }

  register('anthropic', anthropicComplete, {
    label: 'Anthropic', needsKey: true, note: '需允许浏览器直连标头'
  });

  /* ================================================================== *
   * 输出解析：把模型自由文本收敛成 ReAct 结构
   * ================================================================== */
  function extractFirstJson(text) {
    if (!text) return null;
    var fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    var candidates = [];
    if (fenced) candidates.push(fenced[1]);
    candidates.push(text);
    // 括号配平扫描，容忍模型在 JSON 前后加了说明文字
    for (var c = 0; c < candidates.length; c++) {
      var s = candidates[c];
      var start = s.indexOf('{');
      while (start >= 0) {
        var depth = 0, inStr = false, esc = false;
        for (var i = start; i < s.length; i++) {
          var ch = s[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              var slice = s.slice(start, i + 1);
              try { return JSON.parse(slice); } catch (e) { /* 继续找下一个起点 */ }
              break;
            }
          }
        }
        start = s.indexOf('{', start + 1);
      }
    }
    return null;
  }

  var KNOWN_ACTIONS = null;
  function knownActions() {
    if (!KNOWN_ACTIONS && root.JR_TOOLS) {
      // 注意：'plan' 不是工具，是规划阶段的保留动作，只有 orchestrator 会消费它。
      // 它必须被 parseAction 放行，否则模型（含离线适配器）的规划结果会被
      // 当成"未注册工具"降级为 final_answer，理由被整段丢弃。
      KNOWN_ACTIONS = Object.keys(root.JR_TOOLS.REGISTRY).concat(['final_answer', 'plan']);
    }
    return KNOWN_ACTIONS || ['final_answer'];
  }

  /**
   * 取出动作的参数对象。
   *
   * 不同模型把参数放在不同键下（action_input / arguments / parameters / input），
   * 也有模型直接把参数平铺在动作对象上。历史上的真实缺陷是写成
   * `normalizeArgKeys(obj.action_input || obj.args || {})`：形参收到 undefined 后
   * 函数内部又回退到"整个对象"，于是 {"action":"crane_plan"} 本身被当成了参数，
   * 工具拿到空参数。现在只接受一个实参（整个动作对象），不存在链式回退。
   */
  function normalizeArgKeys(actionObj) {
    if (!actionObj || typeof actionObj !== 'object') return {};
    var keys = ['action_input', 'arguments', 'parameters', 'input'];
    for (var i = 0; i < keys.length; i++) {
      var v = actionObj[keys[i]];
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    }
    // 平铺写法：剔除协议保留字后的剩余字段就是参数
    var RESERVED = ['thought', 'action', 'tool', 'tool_name', 'name', 'answer', 'final_answer', 'response', 'args'];
    var flat = {};
    var hasFlat = false;
    Object.keys(actionObj).forEach(function (k) {
      if (RESERVED.indexOf(k) >= 0) return;
      flat[k] = actionObj[k];
      hasFlat = true;
    });
    return hasFlat ? flat : {};
  }

  /**
   * parseAction(text) -> { thought, action, actionInput, answer, parseError }
   * 解析失败不抛异常：返回 final_answer 兜底，使 Agent 循环仍能收敛。
   */
  function parseAction(text) {
    var obj = extractFirstJson(text);
    if (!obj) {
      return { thought: '', action: 'final_answer', actionInput: {}, answer: String(text || '').trim(), parseError: '未找到 JSON 结构' };
    }
    var rawAction = obj.action || obj.tool || obj.tool_name || obj.name || '';
    var action = String(rawAction).trim();
    var answer = obj.answer || obj.final_answer || obj.response || '';
    var isFinal = !action || action === 'final_answer' || /^(final|done|finish)$/i.test(action);

    if (isFinal) {
      return { thought: obj.thought || '', action: 'final_answer', actionInput: {}, answer: String(answer || text).trim(), parseError: null };
    }
    if (knownActions().indexOf(action) < 0) {
      return {
        thought: obj.thought || '',
        action: 'final_answer',
        actionInput: {},
        answer: String(answer || ('模型请求了未注册的工具 ' + action + '，已忽略。')).trim(),
        parseError: '未注册工具：' + action
      };
    }
    return { thought: obj.thought || '', action: action, actionInput: normalizeArgKeys(obj), answer: '', parseError: null };
  }

  /* ================================================================== *
   * 对外接口
   * ================================================================== */
  function createLLM(config) {
    var cfg = Object.assign({ provider: 'offline', apiKey: '', baseUrl: '', model: '', maxRetries: 1 }, config || {});
    var log = [];

    function complete(req) {
      var adapter = registry[cfg.provider];
      if (!adapter) return Promise.reject(new Error('未知 provider：' + cfg.provider));
      var attempt = 0;

      function run() {
        attempt++;
        var full = Object.assign({}, req, { config: cfg });
        // 关键：必须把首次调用的 Promise 直接返回，不能在它前面套一层
        // `return Promise.resolve().then(...)`。那样一旦适配器同步 reject，
        // 失败会落在一条无人接管的 Promise 链上，变成 unhandledRejection，
        // 调用方的 .catch 反而收不到（曾经的真实缺陷：模型不可达时整份报告不渲染）。
        var p;
        try {
          p = adapter.call(full);
        } catch (e) {
          p = Promise.reject(e);
        }
        return p.catch(function (err) {
          if (attempt <= cfg.maxRetries) return run();
          throw err;
        }).then(function (res) {
          log.push({ provider: res.provider, model: res.model, latencyMs: res.latencyMs, at: Date.now() });
          return res;
        });
      }
      return run();
    }

    return {
      config: cfg,
      complete: complete,
      /** 一次调用并解析成 ReAct 动作 */
      decide: function (req) {
        return complete(req).then(function (res) {
          var parsed = parseAction(res.text);
          parsed.raw = res.text;
          parsed.provider = res.provider;
          parsed.model = res.model;
          parsed.latencyMs = res.latencyMs;
          parsed.usage = res.usage;
          return parsed;
        });
      },
      get callLog() { return log.slice(); },
      setProvider: function (p, patch) {
        cfg.provider = p;
        if (patch) Object.assign(cfg, patch);
      }
    };
  }

  root.JR_LLM = {
    createLLM: createLLM,
    parseAction: parseAction,
    extractFirstJson: extractFirstJson,
    listProviders: listProviders,
    PLAN_TEMPLATES: PLAN_TEMPLATES,
    selectTemplate: selectTemplate,
    offlinePlan: offlinePlan,
    _registry: registry
  };
})(typeof window !== 'undefined' ? window : globalThis);
