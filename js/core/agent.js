/**
 * 见仁建智 · Agent 运行引擎（ReAct 循环）
 * ---------------------------------------------------------------------------
 * 这是整个系统唯一的"思考-行动-观察"闭环实现。四个专业智能体与调度中枢
 * 共用它，差异全部来自 prompts.js 的角色配置与工具白名单。
 *
 *   run({ role, goal, brief, llm, maxSteps, onEvent, blackboard })
 *     -> Promise<{ roleId, answer, steps, toolCalls, evidence, stopReason, ms }>
 *
 * 关键契约：
 *   - steps 是完整可回放的轨迹（thought / action / observation），前端轨迹面板
 *     与 Node 测试读的是同一份数据，不存在"UI 专用数据"。
 *   - 工具白名单在引擎层强制，模型即使杜撰工具名也无法越权。
 *   - 证据（evidence）从工具 cites 自动汇聚，Agent 无法绕过出处给结论。
 *   - 引擎对模型输出零信任：解析失败、未知工具、重复调用都会走确定性兜底，
 *     保证任何模型（包括离线规则器）都能收敛，而不是死循环。
 */
(function (root) {
  'use strict';

  var DEFAULT_MAX_STEPS = 7;
  var REPEAT_GUARD = 2; // 同一工具+同一参数连续重复此数即强制收尾

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function sig(name, args) {
    var keys = Object.keys(args || {}).sort();
    return name + '(' + keys.map(function (k) { return k + '=' + JSON.stringify(args[k]); }).join(',') + ')';
  }

  function runAgent(opts) {
    var roleId = opts.role;
    var role = root.JR_PROMPTS.ROLES[roleId];
    if (!role) return Promise.reject(new Error('未知角色：' + roleId));

    var llm = opts.llm || root.JR_LLM.createLLM({ provider: 'offline' });
    var maxSteps = Math.max(1, Math.min(opts.maxSteps || DEFAULT_MAX_STEPS, 12));
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    var allow = role.tools.slice();
    var goal = opts.goal || '';
    var brief = opts.brief || goal;
    var t0 = nowMs();

    // 共享黑板：其他智能体已产出的结论，只读注入提示词
    var digest = opts.blackboard ? opts.blackboard.digest() : '（暂无其他智能体结论）';
    var system = root.JR_PROMPTS.systemPrompt(roleId, { blackboardDigest: digest });

    var steps = [];
    var toolCalls = [];
    var evidence = [];
    var calledSignatures = [];
    var stopReason = 'max_steps';
    var answer = '';
    var stepNo = 0;

    onEvent({ type: 'agent_start', roleId: roleId, roleName: role.name, goal: goal, brief: brief, at: Date.now() });

    function buildUserPrompt() {
      var history = steps.map(function (s, i) {
        var line = '第 ' + (i + 1) + ' 步：thought=' + (s.thought || '(空)') + '\n';
        if (s.action === 'final_answer') return line + '  -> final_answer';
        line += '  -> action=' + s.action + ' action_input=' + JSON.stringify(s.actionInput) + '\n';
        line += '  <- observation: ' + (s.observation ? s.observation.summary : '(失败)') +
          '\n     明细: ' + JSON.stringify(s.observation ? s.observation.data : null).slice(0, 900);
        return line;
      }).join('\n');

      var calledList = toolCalls.map(function (c) { return c.name; });
      var nextHint = role.tools.filter(function (t) { return calledList.indexOf(t) < 0; });
      return [
        '# 你的任务',
        brief,
        '',
        '# 当前目标',
        goal,
        '',
        '# 已完成步骤',
        history || '（尚未调用任何工具）',
        '',
        '# 你若还未使用过这些工具，通常需要先补齐：',
        nextHint.length ? nextHint.join('、') : '（工具已全部用过，若无新证据请直接给 final_answer）',
        '',
        '现在输出你的下一步 JSON。'
      ].join('\n');
    }

    function finish(reason, text) {
      stopReason = reason;
      answer = text || '';
      var out = {
        roleId: roleId, roleName: role.name, goal: goal, brief: brief,
        answer: answer, steps: steps, toolCalls: toolCalls,
        evidence: unique(evidence), stopReason: stopReason,
        ms: Math.round(nowMs() - t0)
      };
      onEvent({ type: 'agent_end', roleId: roleId, stopReason: stopReason, answer: answer, ms: out.ms, at: Date.now() });
      return out;
    }

    function unique(arr) {
      var seen = {}, out = [];
      arr.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
      return out;
    }

    function step() {
      stepNo++;
      if (stepNo > maxSteps) {
        // 兜底收尾：让模型带着已有观察直接给结论
        return llm.decide({
          system: system, user: buildUserPrompt() + '\n# 注意\n已达最大步数，本轮必须输出 final_answer。',
          meta: { role: roleId, calledTools: toolCalls.map(function (c) { return c.name; }), toolResults: toolCalls.map(function (c) { return c.result; }), forceFinal: true }
        }).then(function (d) {
          return finish('max_steps_forced', d.answer || '(未产出结论)');
        });
      }

      return llm.decide({
        system: system,
        user: buildUserPrompt(),
        meta: { role: roleId, calledTools: toolCalls.map(function (c) { return c.name; }), toolResults: toolCalls.map(function (c) { return c.result; }) }
      }).then(function (d) {
        var rec = {
          index: stepNo, thought: d.thought, action: d.action, actionInput: d.actionInput,
          observation: null, parseError: d.parseError || null,
          provider: d.provider, model: d.model, latencyMs: d.latencyMs
        };

        if (d.action === 'final_answer') {
          rec.observation = { summary: '（收尾）', data: null };
          steps.push(rec);
          onEvent({ type: 'step', roleId: roleId, step: rec, at: Date.now() });
          return finish('final_answer', d.answer || '');
        }

        if (allow.indexOf(d.action) < 0) {
          rec.observation = { ok: false, summary: '越权调用被拒绝：' + d.action, data: null };
          steps.push(rec);
          onEvent({ type: 'step', roleId: roleId, step: rec, at: Date.now() });
          return step();
        }

        var s = sig(d.action, d.actionInput);
        calledSignatures.push(s);
        var repeats = calledSignatures.filter(function (x) { return x === s; }).length;

        var result = root.JR_TOOLS.invoke(d.action, d.actionInput);
        rec.observation = { ok: result.ok, summary: result.summary, data: result.data, cites: result.cites, error: result.error };
        steps.push(rec);
        toolCalls.push({ name: d.action, args: d.actionInput, result: result, at: Date.now() });
        (result.cites || []).forEach(function (c) { evidence.push(c.doc + ' ' + c.clause); });
        onEvent({ type: 'step', roleId: roleId, step: rec, at: Date.now() });

        if (repeats >= REPEAT_GUARD) return finish('repeat_guard', rec.observation.summary);
        return step();
      }).catch(function (err) {
        // 模型层异常不吞掉：记录后走确定性收尾，保证演示不中断
        var rec = {
          index: stepNo, thought: '(模型调用失败)', action: 'error', actionInput: {},
          observation: { ok: false, summary: '模型调用失败：' + (err && err.message ? err.message : String(err)), data: null },
          parseError: 'llm_error'
        };
        steps.push(rec);
        onEvent({ type: 'step', roleId: roleId, step: rec, at: Date.now() });
        return finish('llm_error', '模型调用失败：' + (err && err.message ? err.message : String(err)) +
          '\n已保留本步之前的全部工具证据，可切换离线推理器继续。');
      });
    }

    return step();
  }

  root.JR_AGENT = { run: runAgent, DEFAULT_MAX_STEPS: DEFAULT_MAX_STEPS };
})(typeof window !== 'undefined' ? window : globalThis);
