/**
 * 见仁建智 · 工具层（Agent 唯一能对世界产生副作用的地方）
 * ---------------------------------------------------------------------------
 * 契约：
 *   JR_TOOLS.invoke(name, args) -> {
 *     ok: boolean,
 *     tool: string,
 *     data: object|null,          // 机器可读结果
 *     cites: Cite[],              // 依据出处，形如 {doc, clause, version}
 *     summary: string,            // 一行中文摘要，供 Agent 引用与 UI 展示
 *     error: string|null
 *   }
 *
 * 设计取舍：
 *   - 工具是纯函数（除 dispatch_order 写台账外），因此可被 Node 测试直接驱动。
 *   - 判定规则写在工具里，不写在提示词里：模型负责理解与解释，规则负责判定。
 *   - 每个工具的返回值自带 cites，Agent 无法绕过出处直接给结论。
 */
(function (root) {
  'use strict';

  var KB = root.JR_KB;
  var DATA = root.JR_DATA;

  /* ------------------------------------------------------------------ *
   * 0) 内部工具函数
   * ------------------------------------------------------------------ */
  function cite(doc, clause, version) { return { doc: doc, clause: clause, version: version || '' }; }
  function round(n, d) { var p = Math.pow(10, d == null ? 2 : d); return Math.round(n * p) / p; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function wrap(tool, data, cites, summary) {
    return { ok: true, tool: tool, data: data, cites: cites || [], summary: summary, error: null };
  }
  function fail(tool, msg) {
    return { ok: false, tool: tool, data: null, cites: [], summary: '', error: msg };
  }
  function pct(a, b) { return b === 0 ? 0 : round((a / b) * 100, 1); }

  /* ------------------------------------------------------------------ *
   * 1) 知识检索（Agentic RAG：关键词 + 图扩展 + 出处回填）
   * ------------------------------------------------------------------ */
  function kbSearch(args) {
    var query = String(args.query || '').trim();
    if (!query) return fail('kb_search', '缺少 query 参数');
    var topK = clamp(parseInt(args.topK, 10) || 4, 1, 10);
    var expandGraph = args.expandGraph !== false;

    // 中文按 2-gram + 关键词命中打分，避免引入分词依赖
    var terms = [];
    for (var i = 0; i < query.length - 1; i++) terms.push(query.substr(i, 2));
    var scored = KB.CHUNKS.map(function (ck) {
      var score = 0;
      ck.keywords.forEach(function (kw) { if (query.indexOf(kw) >= 0) score += 3; });
      terms.forEach(function (t) {
        if (ck.text.indexOf(t) >= 0) score += 1;
        if (ck.keywords.join(' ').indexOf(t) >= 0) score += 0.5;
      });
      return { chunk: ck, score: round(score, 2) };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, topK);

    var hits = scored.map(function (r) {
      var node = KB.NODES.filter(function (n) { return n.id === r.chunk.node; })[0] || null;
      return {
        chunkId: r.chunk.id,
        nodeId: r.chunk.node,
        title: node ? node.title : r.chunk.node,
        kind: node ? node.kind : '未知',
        text: r.chunk.text,
        score: r.score,
        cite: cite(node ? node.title : r.chunk.node, r.chunk.id, node ? node.version : '')
      };
    });

    // 图扩展：沿 edges 找到关联的故障模式与处置经验
    var related = [];
    if (expandGraph) {
      var nodeIds = hits.map(function (h) { return h.nodeId; });
      KB.EDGES.forEach(function (e) {
        if (nodeIds.indexOf(e.from) >= 0 || nodeIds.indexOf(e.to) >= 0) {
          var otherId = nodeIds.indexOf(e.from) >= 0 ? e.to : e.from;
          var n = KB.NODES.filter(function (x) { return x.id === otherId; })[0];
          if (n && !related.some(function (r) { return r.nodeId === n.id; })) {
            related.push({ nodeId: n.id, title: n.title, kind: n.kind, rel: e.rel, text: n.text });
          }
        }
      });
    }

    return wrap('kb_search', { query: query, hits: hits, related: related, hitCount: hits.length },
      hits.map(function (h) { return h.cite; }),
      '检索到 ' + hits.length + ' 条依据，关联 ' + related.length + ' 个图节点');
  }

  /* ------------------------------------------------------------------ *
   * 2) 设计智审：MiC 模块合规与碰撞检查
   * ------------------------------------------------------------------ */
  function micCheckCompliance(args) {
    var ids = args.moduleIds && args.moduleIds.length ? args.moduleIds
      : DATA.MIC_MODULES.map(function (m) { return m.id; });
    var R = DATA.MIC_RULES;
    var results = [];

    ids.forEach(function (id) {
      var m = DATA.MIC_MODULES.filter(function (x) { return x.id === id; })[0];
      if (!m) return;
      var violations = [];
      var sev = function (level, rule, detail, c) { violations.push({ level: level, rule: rule, detail: detail, cite: c }); };

      if (m.widthM > R.maxWidthM) sev('高', '运输限宽', '宽度 ' + m.widthM + 'm > ' + R.maxWidthM + 'm，需超限运输许可', cite('JGJ 1-2014', '5.4.3', '2014'));
      if (m.heightM > R.maxHeightM) sev('高', '运输限高', '高度 ' + m.heightM + 'm > ' + R.maxHeightM + 'm（含吊具）', cite('JGJ 1-2014', '5.4.3', '2014'));
      if (m.lengthM > R.maxLengthM) sev('高', '运输限长', '长度 ' + m.lengthM + 'm > ' + R.maxLengthM + 'm', cite('JGJ 1-2014', '5.4.3', '2014'));
      if (m.weightT > R.maxWeightT) sev('高', '吊装吨位', '模块 ' + m.weightT + 't > 塔吊额定 ' + R.maxWeightT + 't', cite('JGJ 1-2014', '5.4.3', '2014'));
      if (m.weightT > m.craneCapacityT) sev('高', '塔吊工况', '模块 ' + m.weightT + 't 超出该半径额定 ' + m.craneCapacityT + 't', cite('JGJ 1-2014', '5.4.3', '2014'));
      if (m.corridorClearM < R.minCorridorClearM) sev('中', '运输通道净宽', '净宽 ' + m.corridorClearM + 'm < ' + R.minCorridorClearM + 'm', cite('GB 50666-2011', '4.4.6', '2011'));
      if (m.reuseRate < R.minReuseRate) sev('低', '标准化率', '标准模块占比 ' + pct(m.reuseRate, 1) + '% < ' + pct(R.minReuseRate, 1) + '%，模板周转低', cite('JGJ 1-2014', '5.4.3', '2014'));

      var diagRatio = round(m.diagM / Math.max(m.lengthM, m.widthM), 3);
      if (diagRatio > R.maxDiagRatio) sev('中', '拼装刚度', '对角线/长边 = ' + diagRatio + ' > ' + R.maxDiagRatio, cite('JGJ 1-2014', '5.4.3', '2014'));

      results.push({
        moduleId: m.id, type: m.type, floor: m.floor,
        diagRatio: diagRatio,
        violations: violations,
        pass: violations.filter(function (v) { return v.level === '高'; }).length === 0,
        revision: m.designRevision
      });
    });

    var high = results.reduce(function (a, r) {
      return a + r.violations.filter(function (v) { return v.level === '高'; }).length;
    }, 0);
    var mid = results.reduce(function (a, r) {
      return a + r.violations.filter(function (v) { return v.level === '中'; }).length;
    }, 0);

    return wrap('mic_check_compliance',
      { checked: results.length, results: results, highCount: high, midCount: mid },
      [cite('JGJ 1-2014', '5.4.3', '2014'), cite('GB 50666-2011', '4.4.6', '2011'), cite('BIM 模型 R7', 'MiC 拆分方案', 'R7')],
      '审查 ' + results.length + ' 个模块：高危项 ' + high + '，中危项 ' + mid);
  }

  function bimClashDetect(args) {
    var floor = args.floor;
    var items = DATA.MIC_MODULES.filter(function (m) { return floor == null || m.floor === floor; });
    var clashes = [];

    items.forEach(function (m) {
      // 机电管线与结构构件的最小净距校核（演示用确定性规则）
      var hasGas = m.penetrations.some(function (p) { return p.indexOf('燃气') >= 0; });
      var hasDrain = m.penetrations.some(function (p) { return p.indexOf('DN110') >= 0 || p.indexOf('DN160') >= 0; });
      var serviceCount = m.services.length;

      if (hasGas && serviceCount >= 5) {
        clashes.push({
          id: 'CL-' + m.id + '-1', moduleId: m.id, kind: '硬碰撞',
          between: ['燃气立管 DN50', '排水立管 DN160'],
          clearancesMm: -35,
          level: '高',
          suggestion: '燃气立管外移 120mm 并调整支管标高至 +2.35m',
          cite: cite('BIM 模型 R7', 'C3-15F 机电综合', 'R7')
        });
      }
      if (hasDrain && m.widthM <= 3.0 && serviceCount >= 4) {
        clashes.push({
          id: 'CL-' + m.id + '-2', moduleId: m.id, kind: '净距不足',
          between: ['DN110 排水立管', '模块侧壁龙骨'],
          clearancesMm: -12,
          level: '中',
          suggestion: '侧壁龙骨减薄至 75mm 龙骨或立管偏心安装 40mm',
          cite: cite('GB 50242-2002', '3.3.13', '2002')
        });
      }
      if (m.type === '卫生间模块' && m.penetrations.length < 3) {
        clashes.push({
          id: 'CL-' + m.id + '-3', moduleId: m.id, kind: '预留缺失',
          between: ['预埋套管清单', '排水立管 DN110'],
          clearancesMm: null,
          level: '中',
          suggestion: '补充 DN25 给水支管套管预埋，避免现场后开孔',
          cite: cite('GB 50242-2002', '3.3.13', '2002')
        });
      }
    });

    return wrap('bim_clash_detect',
      { floor: floor == null ? '全部' : floor, scanned: items.length, clashes: clashes, highCount: clashes.filter(function (c) { return c.level === '高'; }).length },
      [cite('BIM 模型 R7', 'C3 栋机电综合', 'R7')],
      '扫描 ' + items.length + ' 个模块，发现 ' + clashes.length + ' 处冲突');
  }

  function micSuggestSplit(args) {
    var moduleId = args.moduleId;
    var m = DATA.MIC_MODULES.filter(function (x) { return x.id === moduleId; })[0];
    if (!m) return fail('mic_suggest_split', '未找到模块 ' + moduleId);
    var R = DATA.MIC_RULES;
    var proposals = [];

    if (m.widthM > R.maxWidthM) {
      var half = round(m.widthM / 2, 2);
      proposals.push({
        id: 'SP-1', action: '一分为二',
        from: '单模块 ' + m.lengthM + '×' + m.widthM + 'm / ' + m.weightT + 't',
        to: '两模块各 ' + m.lengthM + '×' + half + 'm',
        impact: { weightPerModuleT: round(m.weightT / 2, 1), extraJoints: 1, extraHoists: 1, addedDays: 0.5 },
        reason: '宽度收敛至运输限宽 ' + R.maxWidthM + 'm 以内，免办超限许可'
      });
    }
    // 只有"超出该半径塔吊额定吨位"的模块才值得拆机电夹层：
    // 若只是偏重但仍在该工况额定值以内，拆夹层会白白增加拼缝与吊次。
    if (m.weightT > m.craneCapacityT) {
      proposals.push({
        id: 'SP-2', action: '拆分机电夹层',
        from: '模块含全部机电管线，重 ' + m.weightT + 't（该工况额定 ' + m.craneCapacityT + 't）',
        to: '结构模块 + 机电夹层模块（约 ' + round(m.weightT * 0.35, 1) + 't）',
        impact: { weightPerModuleT: round(m.weightT * 0.65, 1), extraJoints: 1, extraHoists: 2, addedDays: 1 },
        reason: '单次吊重降至额定吨位以内，恢复塔吊工况余量'
      });
    }
    if (m.reuseRate < R.minReuseRate) {
      proposals.push({
        id: 'SP-3', action: '标准化收敛',
        from: '标准模块占比 ' + pct(m.reuseRate, 1) + '%',
        to: '对齐 M-1508 卫生间模块族，目标 ' + pct(R.minReuseRate, 1) + '%+',
        impact: { weightPerModuleT: m.weightT, extraJoints: 0, extraHoists: 0, addedDays: -1.5 },
        reason: '提升模板与模具周转率，减少非标生产'
      });
    }

    return wrap('mic_suggest_split',
      { moduleId: m.id, proposals: proposals },
      [cite('JGJ 1-2014', '5.4.3', '2014'), cite('BIM 模型 R7', 'MiC 拆分方案', 'R7')],
      '为 ' + m.id + ' 生成 ' + proposals.length + ' 条拆分优化建议');
  }

  /* ------------------------------------------------------------------ *
   * 3) 施工调度：进度预测、吊装排程、吊装区安全
   * ------------------------------------------------------------------ */
  /**
   * 进度预测：SPI（进度绩效指数）= 实际完成率 / 计划完成率
   *
   * 为什么不用"按当前日均产能线性外推"？因为未开工或刚开工的工序日均产能
   * 趋近于 0，线性外推会给出几百天的荒谬延期。SPI 是工程上通用的挣值指标：
   * 它回答"按目前这个干法，剩余工作还要多久"，天然对未开工工序稳定。
   *
   * 并且必须做前置任务级联：T-03 再快也不能早于 T-01 完成，否则"预测完工"
   * 会给出物理上不可能的日期。级联按拓扑序推进，带环路兜底。
   */
  function schedulePredict(args) {
    var horizon = clamp(parseInt(args.horizonDays, 10) || 3, 1, 14);
    var today = DATA.PROJECT.day;
    var MAX_SPI_SLIP_DAYS = 21;   // 单任务延期上限，避免演示数据出现荒谬数字

    var byId = {};
    DATA.SCHEDULE_TASKS.forEach(function (t) { byId[t.id] = t; });

    var computed = {};
    var visiting = {};

    function project(task) {
      if (computed[task.id]) return computed[task.id];
      if (visiting[task.id]) {
        // 环形依赖：断开，按自身工期计算，避免无限递归
        return { id: task.id, projectedFinish: task.end, delayDays: 0, cyclic: true };
      }
      visiting[task.id] = true;

      var plannedDuration = Math.max(1, task.end - task.start);
      var elapsed = Math.max(0, today - task.start);
      var planPercent = Math.max(0.01, task.planPercent / 100);
      var actualPercent = clamp(task.actualPercent / 100, 0, 1);
      var spi = actualPercent / planPercent;

      // 剩余工期折算必须用"实际投入天数"（leadDays）而不是日历跨度：
      // MiC 吊装受天气与工序穿插限制，5 天日历跨度实际只投入 3 天。
      // 用日历天会把延期放大到失真（曾经的真实缺陷）。
      var lead = clamp(parseFloat(task.leadDays) || (task.end - task.start), 1, 60);
      var slipDays;
      if (task.actualPercent <= 0) {
        slipDays = 0; // 未开工不预设延期，延期由前置任务级联产生
      } else if (spi >= 1) {
        slipDays = 0;
      } else {
        var remainingActualDays = lead / Math.max(0.2, spi);
        slipDays = Math.min(MAX_SPI_SLIP_DAYS, Math.round(remainingActualDays - lead));
      }
      var ownFinish = task.end + slipDays;

      // 前置任务级联：本任务不可能早于任一前置任务完成
      var gate = task.start;
      var blockingPredecessor = null;
      (task.predecessors || []).forEach(function (pid) {
        var p = byId[pid];
        if (!p) return;
        var pc = project(p);
        if (pc.projectedFinish > gate) { gate = pc.projectedFinish; blockingPredecessor = pid; }
      });

      var projectedFinish = Math.max(ownFinish, gate, today);
      var delayDays = Math.max(0, projectedFinish - task.end);

      var result = {
        id: task.id, name: task.name, zone: task.zone, critical: task.critical,
        planPercent: task.planPercent, actualPercent: task.actualPercent,
        slip: round(task.planPercent - task.actualPercent, 1),
        spi: round(spi, 2),
        plannedDurationDays: plannedDuration,
        elapsedDays: elapsed,
        slipDays: slipDays,
        plannedFinish: task.end,
        projectedFinish: projectedFinish,
        delayDays: delayDays,
        blockedByPredecessor: (blockingPredecessor && gate > ownFinish) ? blockingPredecessor : null,
        risk: delayDays >= 4 ? '高' : (delayDays >= 1 ? '中' : '低')
      };
      visiting[task.id] = false;
      computed[task.id] = result;
      return result;
    }

    var tasks = DATA.SCHEDULE_TASKS.map(project)
      .sort(function (a, b) { return b.delayDays - a.delayDays || a.id.localeCompare(b.id); });

    // 关键路径：有延期的关键任务，按计划完工日串起来
    var criticalPath = tasks.filter(function (t) { return t.critical && t.delayDays > 0; })
      .sort(function (a, b) { return a.plannedFinish - b.plannedFinish; })
      .map(function (t) { return t.id; });
    var maxDelay = tasks.reduce(function (a, t) { return Math.max(a, t.delayDays); }, 0);
    var projectedDay = today + maxDelay;

    return wrap('schedule_predict',
      {
        horizonDays: horizon, currentDay: today,
        tasks: tasks, criticalPath: criticalPath,
        maxDelayDays: maxDelay, projectedCompletionDay: projectedDay,
        onSchedule: maxDelay === 0
      },
      [cite('施工组织设计 · 吊装专项', '总进度计划', 'V3'), cite('C-SMART 数据字典', '进度采集口径', 'V1.4')],
      maxDelay === 0 ? '进度与计划一致' : '最大延期 ' + maxDelay + ' 天，关键路径 ' + (criticalPath.join('、') || '无'));
  }

  function cranePlan(args) {
    var day = parseInt(args.day, 10) || DATA.PROJECT.day;
    var windMs = args.windMs == null ? DATA.PROJECT.weather.windMs : args.windMs;
    var crane = DATA.IOT_SENSORS.filter(function (s) { return s.kind === '塔吊'; });
    var LIMIT = { windMs: 12.0, loadRatio: 0.85 };
    var today = DATA.PROJECT.day;

    // 时段键形如 D46-PM；只返回被查询日期的时段，否则"某天的可用窗口"
    // 会把别的日子一起算进来，排程结论直接失真。
    var dayKey = 'D' + day;
    var slotsOfDay = DATA.RESOURCES.craneSlots.filter(function (s) {
      return String(s.slot).indexOf(dayKey + '-') === 0;
    });

    var plan = slotsOfDay.map(function (slot) {
      var unit = crane.filter(function (c) { return c.id === slot.crane; })[0];
      var loadRatio = unit ? round(unit.metrics.loadT / unit.metrics.capacityT, 3) : 0;
      var blocked = [];
      if (windMs > LIMIT.windMs) blocked.push('风速 ' + windMs + 'm/s 超限（>' + LIMIT.windMs + '）');
      if (loadRatio > LIMIT.loadRatio) blocked.push('载荷率 ' + pct(loadRatio, 1) + '% 超警戒（>' + pct(LIMIT.loadRatio, 1) + '%）');
      if (day < today) blocked.push('该时段已过期（当前第 ' + today + ' 天）');
      return {
        slot: slot.slot, crane: slot.crane, window: slot.from + ':00–' + slot.to + ':00',
        assignedTo: slot.assignedTo, status: slot.status,
        loadRatio: loadRatio, blockedBy: blocked,
        feasible: blocked.length === 0
      };
    });

    // 冲突检测：同一塔吊同一时段被占用两次
    var conflicts = [];
    var byCrane = {};
    plan.forEach(function (p) {
      var key = p.crane + '@' + p.window;
      if (byCrane[key]) conflicts.push({ crane: p.crane, window: p.window, between: [byCrane[key].assignedTo, p.assignedTo], level: '高' });
      byCrane[key] = p;
    });

    var overlaps = crane.length > 1 ? [{
      between: ['TC-01', 'TC-02'], overlapM: 6.5,
      note: '回转半径重叠 6.5m，须设防碰撞区并错峰占用',
      cite: cite('GB 50666-2011', '4.4.6', '2011')
    }] : [];

    var freeSlots = plan.filter(function (p) { return p.feasible && !p.assignedTo; }).map(function (p) { return p.slot; });

    return wrap('crane_plan',
      {
        day: day, windMs: windMs, limits: LIMIT,
        slots: plan, conflicts: conflicts, overlaps: overlaps,
        freeSlots: freeSlots,
        noneForDay: plan.length === 0
      },
      [cite('GB 50666-2011', '4.4.6', '2011'), cite('施工组织设计 · 吊装专项', '塔吊调度', 'V3')],
      plan.length === 0
        ? '第 ' + day + ' 天无预排时段，需新建吊装令'
        : '第 ' + day + ' 天排程 ' + plan.length + ' 个时段，可用空档 ' + freeSlots.length + ' 个');
  }

  function safetyCheckLift(args) {
    var zone = args.zone || 'C3-15F 吊装区';
    var craneState = DATA.IOT_SENSORS.filter(function (s) { return s.kind === '塔吊'; })
      .map(function (c) { return { id: c.id, loadT: c.metrics.loadT, capacityT: c.metrics.capacityT, swingDeg: c.metrics.swingDeg }; });
    var persons = DATA.SAFETY_EVENTS.filter(function (e) { return e.zone.indexOf(zone) >= 0 || e.zone.indexOf('吊装') >= 0; });
    var intrusion = persons.filter(function (e) { return e.type.indexOf('吊装半径') >= 0; });
    var workerIds = [];
    intrusion.forEach(function (e) { e.workers.forEach(function (w) { if (workerIds.indexOf(w) < 0) workerIds.push(w); }); });

    var loadRatio = craneState.length ? round(craneState[0].loadT / craneState[0].capacityT, 3) : 0;
    var level = intrusion.length ? '高' : (loadRatio > 0.85 ? '中' : '低');
    var actions = [];
    if (intrusion.length) actions.push('立即停止回转并广播撤离，清场后恢复吊装');
    if (loadRatio > 0.85) actions.push('降低单次吊重或改双机抬吊，复核吊点');
    if (DATA.PROJECT.weather.windMs > 10) actions.push('风速接近限值，缩短吊装窗口并加密监测');
    if (!actions.length) actions.push('维持现行吊装方案，按小时复核风速与载荷率');

    return wrap('safety_check_lift',
      {
        zone: zone, craneState: craneState, loadRatio: loadRatio,
        intrusionCount: intrusion.length, affectedWorkers: workerIds,
        relatedEvents: persons.map(function (e) { return { id: e.id, at: e.at, type: e.type, severity: e.severity }; }),
        level: level, actions: actions
      },
      [cite('GB 50666-2011', '4.4.6', '2011')],
      '吊装作业风险等级 ' + level + '，涉及 ' + workerIds.length + ' 名工友');
  }

  function safetyMultimodalScan(args) {
    var floor = args.floor;
    var events = DATA.SAFETY_EVENTS.filter(function (e) {
      if (floor != null && e.zone.indexOf(String(floor)) < 0) return false;
      return true;
    });
    var bySeverity = { 高: 0, 中: 0, 低: 0 };
    var hotspots = {};
    events.forEach(function (e) {
      bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
      hotspots[e.zone] = (hotspots[e.zone] || 0) + 1;
    });
    var topZones = Object.keys(hotspots).map(function (z) { return { zone: z, count: hotspots[z] }; })
      .sort(function (a, b) { return b.count - a.count; });

    var orders = events.filter(function (e) { return e.severity === '高'; }).map(function (e) {
      var w = DATA.WORKERS.filter(function (x) { return e.workers.indexOf(x.id) >= 0; })[0];
      return {
        id: 'RK-' + e.id, eventId: e.id, zone: e.zone, type: e.type,
        severity: e.severity, confidence: e.confidence,
        owner: w ? w.crew : 'CR-A', dueHours: e.severity === '高' ? 4 : 24,
        evidenceRequired: ['整改后照片', '班组长确认'],
        status: '待派单'
      };
    });

    return wrap('safety_multimodal_scan',
      {
        scanned: events.length, bySeverity: bySeverity, topZones: topZones,
        events: events.map(function (e) { return { id: e.id, at: e.at, zone: e.zone, type: e.type, severity: e.severity, source: e.source, confidence: e.confidence }; }),
        pendingOrders: orders, highCount: bySeverity['高'] || 0
      },
      [cite('JGJ 59-2011', '3.13.3', '2011'), cite('C-SMART 数据字典', '视频AI事件流', 'V1.4')],
      '扫描 ' + events.length + ' 条隐患，高危 ' + (bySeverity['高'] || 0) + ' 条');
  }

  /* ------------------------------------------------------------------ *
   * 4) 绿能运维：BIPV 诊断与工单
   * ------------------------------------------------------------------ */
  function bipvDiagnose(args) {
    var array = DATA.BIPV_ARRAY;
    var strings = args.stringIds && args.stringIds.length
      ? array.strings.filter(function (s) { return args.stringIds.indexOf(s.id) >= 0; })
      : array.strings;

    var findings = strings.map(function (s) {
      var gap = round(s.expectedKwhDay - s.actualKwhDay, 1);
      var gapRate = pct(gap, s.expectedKwhDay);
      var avgPmpp = round(s.pmppW / s.modules, 1);

      // 证据分两层：
      //   scope='string'  —— 只解释这一个组串，可作为主因并驱动工单；
      //   scope='system'  —— 逆变器/全场级因素，同时影响多个组串，
      //                      只能作为"加重因素"列出，不能把单串的损失算到它头上。
      // 不分层就会出现"某串积灰 11%，却把逆变器过温报成主因"这种错误归因。
      var causes = [];
      var conf = 0;

      if (s.soilingLoss >= 0.08) {
        causes.push({ scope: 'string', cause: '积灰', node: 'fm:soiling', weight: round(s.soilingLoss * 3, 2), note: '积灰损失 ' + pct(s.soilingLoss, 1) + '%，与周边扬尘作业吻合' });
        conf = Math.max(conf, 0.78);
      }
      if (s.tempC >= 55) {
        causes.push({ scope: 'string', cause: '热斑/温升', node: 'fm:hotspot', weight: round((s.tempC - 50) / 10, 2), note: '组件温度 ' + s.tempC + '°C 偏高' });
        conf = Math.max(conf, 0.65);
      }
      if (gapRate >= 10 && s.soilingLoss < 0.08) {
        causes.push({ scope: 'string', cause: '组串失配', node: 'fm:hotspot', weight: round(gapRate / 20, 2), note: '组串发电量偏差 ' + gapRate + '% 超过 10% 报警阈值' });
        conf = Math.max(conf, 0.72);
      }
      array.inverters.forEach(function (inv) {
        if (inv.mpptStrings.indexOf(s.id) < 0) return;
        if (inv.tempC >= 60) {
          causes.push({ scope: 'system', cause: '逆变器过温', node: 'fm:inverterOvertemp', weight: 0.6, note: inv.id + ' 温度 ' + inv.tempC + '°C，超过 60°C 降额阈值' });
          conf = Math.max(conf, 0.6);
        } else if (inv.tempC >= 55) {
          causes.push({ scope: 'system', cause: '逆变器温升偏高', node: 'fm:inverterOvertemp', weight: 0.25, note: inv.id + ' 温度 ' + inv.tempC + '°C，尚未触达降额阈值，作加重因素' });
        }
        if (inv.alarm && String(inv.alarm).indexOf(s.id) >= 0) {
          causes.push({ scope: 'system', cause: '直流侧报警', node: 'fm:soiling', weight: 0.4, note: inv.id + ' 报警：' + inv.alarm });
          conf = Math.max(conf, 0.7);
        }
      });

      var stringCauses = causes.filter(function (c) { return c.scope === 'string'; }).sort(function (a, b) { return b.weight - a.weight; });
      var systemCauses = causes.filter(function (c) { return c.scope === 'system'; }).sort(function (a, b) { return b.weight - a.weight; });
      var primary = stringCauses[0] || systemCauses[0] || null;

      return {
        stringId: s.id, modules: s.modules,
        expectedKwhDay: s.expectedKwhDay, actualKwhDay: s.actualKwhDay,
        gapKwh: gap, gapRate: gapRate, tempC: s.tempC, irradiance: s.irradiance,
        soilingLoss: s.soilingLoss, avgPmppW: avgPmpp,
        abnormal: gapRate >= 5,
        severity: gapRate >= 15 ? '高' : (gapRate >= 5 ? '中' : '低'),
        primaryCause: primary ? primary.cause : null,
        primaryNote: primary ? primary.note : null,
        stringCauses: stringCauses,
        systemCauses: systemCauses,
        needsInverterCheck: systemCauses.some(function (c) { return c.cause === '直流侧报警'; }),
        causes: stringCauses.concat(systemCauses),
        confidence: round(conf, 2)
      };
    });

    var lossKwh = round(findings.reduce(function (a, f) { return a + Math.max(0, f.gapKwh); }, 0), 1);
    var abnormal = findings.filter(function (f) { return f.abnormal; }).length;

    return wrap('bipv_diagnose',
      {
        snapshotAt: DATA.PROJECT.snapshotAt, capacityKwp: array.capacityKwp,
        findings: findings, abnormalStrings: abnormal,
        dailyLossKwh: lossKwh,
        dailyLossRatio: pct(lossKwh, findings.reduce(function (a, f) { return a + f.expectedKwhDay; }, 0)),
        history: array.history
      },
      [cite('GB 50797-2012', '6.3.2', '2012'), cite('GB 51368-2019', '4.2.5', '2019'), cite('BIPV 运维手册 · 海之韵项目', '组串诊断阈值', 'V2')],
      '诊断 ' + findings.length + ' 个组串：异常 ' + abnormal + ' 个，日损失 ' + lossKwh + ' kWh');
  }

  function bipvWorkOrder(args) {
    var stringIds = args.stringIds || [];
    var diag = bipvDiagnose({ stringIds: stringIds });
    if (!diag.ok) return diag;
    var targets = diag.data.findings.filter(function (f) { return f.abnormal || args.forceAll; });
    if (!targets.length) {
      return wrap('bipv_work_order', { created: [], note: '无异常组串，不生成工单' },
        diag.cites, '无异常，未生成工单');
    }
    var now = DATA.PROJECT.snapshotAt;
    var orders = targets.map(function (f, i) {
      var cause = f.primaryCause;
      var nightClean = cause === '积灰' || cause === '热斑/温升';
      var actions = nightClean
        ? ['核对组件表面积灰分布', '低压水枪清洗，避免划伤镀膜', '清洗后复测组串电流', '高处作业系挂安全带并设监护人']
        : ['红外测温定位异常组件', '检查旁路二极管与接插件', '核对 MPPT 参数与组串失配'];
      if (f.needsInverterCheck) actions.push('同步排查逆变器直流侧告警（' + f.systemCauses.map(function (c) { return c.cause; }).join('、') + '）');

      return {
        id: 'WO-BIPV-' + (2600 + i),
        stringId: f.stringId,
        title: (nightClean ? '夜间清洗' : '组串排查') + ' · ' + f.stringId,
        priority: f.severity,
        window: nightClean ? '今夜 22:00–02:00（避免发电损失）' : '明日 08:00 前',        actions: actions,
        expectedRecoveryKwhDay: f.gapKwh,
        owner: '绿能运维组',
        evidenceRequired: ['清洗前后组串电流截图', '作业票与监护人签字'],
        reason: f.primaryNote || '发电量低于期望',
        contributingFactors: f.systemCauses.map(function (c) { return c.cause + '（' + c.note + '）'; }),
        createdAt: now,
        status: '待派发'
      };
    });

    return wrap('bipv_work_order',
      { created: orders, count: orders.length, totalExpectedRecoveryKwhDay: round(orders.reduce(function (a, o) { return a + o.expectedRecoveryKwhDay; }, 0), 1) },
      diag.cites,
      '生成 ' + orders.length + ' 张 BIPV 运维工单');
  }

  /* ------------------------------------------------------------------ *
   * 5) 跨域：缺陷派单与台账
   * ------------------------------------------------------------------ */
  var LEDGER = DATA.DEFECT_LEDGER.map(function (d) { return Object.assign({}, d); });

  function defectList(args) {
    var filter = args || {};
    var rows = LEDGER.filter(function (d) {
      if (filter.status && d.status !== filter.status) return false;
      if (filter.module && d.module !== filter.module) return false;
      if (filter.minSeverity) {
        var rank = { 低: 1, 中: 2, 高: 3 };
        if ((rank[d.severity] || 0) < (rank[filter.minSeverity] || 0)) return false;
      }
      return true;
    });
    var open = rows.filter(function (d) { return d.status !== '已关闭'; });
    var overdue = open.filter(function (d) { return DATA.PROJECT.day - d.openedDay >= d.slaDays; });
    return wrap('defect_list',
      { rows: rows, total: rows.length, open: open.length, overdue: overdue.map(function (d) { return d.id; }) },
      [cite('C-SMART 数据字典', '质量缺陷台账', 'V1.4')],
      '台账 ' + rows.length + ' 条，未闭环 ' + open.length + ' 条，超期 ' + overdue.length + ' 条');
  }

  function dispatchOrder(args) {
    var defectId = args.defectId;
    var d = LEDGER.filter(function (x) { return x.id === defectId; })[0];
    if (!d) return fail('dispatch_order', '未找到缺陷 ' + defectId);
    if (d.status === '已关闭') return fail('dispatch_order', '缺陷 ' + defectId + ' 已关闭，无需派单');

    var crew = args.crew;
    if (!crew) {
      var trade = d.kind.indexOf('套管') >= 0 || d.kind.indexOf('预埋') >= 0 ? '机电' : '起重';
      var cand = DATA.RESOURCES.crews.filter(function (c) { return c.trade === trade; })[0];
      crew = cand ? cand.id : 'CR-A';
    }
    var target = DATA.RESOURCES.crews.filter(function (c) { return c.id === crew; })[0];
    var load = target ? round(target.onSite / Math.max(1, target.needed), 2) : 0;
    var overloaded = load >= 1.0;

    d.status = '已派单';
    d.owner = crew;
    d.dispatchedAt = DATA.PROJECT.snapshotAt;

    return wrap('dispatch_order',
      {
        defectId: d.id, kind: d.kind, severity: d.severity, crew: crew,
        crewLoad: load, overloaded: overloaded,
        dueDay: d.openedDay + d.slaDays,
        evidenceRequired: ['整改照片（带时间水印）', '责任人签字', '质检员复验记录'],
        warning: overloaded ? '该班组负荷率已达 ' + pct(load, 1) + '%，建议增派或改派' : null,
        ledgerAfter: { id: d.id, status: d.status, owner: d.owner }
      },
      [cite('C-SMART 数据字典', '整改闭环流程', 'V1.4')],
      d.id + ' 已派发至 ' + crew + (overloaded ? '（班组负荷偏高）' : ''));
  }

  /* ------------------------------------------------------------------ *
   * 6) 决策推演：一次调用比较多个处置方案
   * ------------------------------------------------------------------ */
  function simulatePlan(args) {
    var goal = args.goal || 'subject';
    var scenarios = [];
    var task = DATA.SCHEDULE_TASKS[0];

    if (goal === 'lift' || goal === 'subject') {
      var delay = (function () {
        var p = schedulePredict({ horizonDays: 3 });
        return p.data.maxDelayDays;
      })();

      scenarios.push({
        id: 'SC-A', name: '增加夜班吊装',
        actions: ['吊装班组 14→20 人', 'TC-01 延长至 22:00', '照明与监护同步增加'],
        effects: { recoveredDays: Math.min(2, delay), costDelta: 18000, safetyRiskDelta: 0.15, qualityRiskDelta: 0.05 },
        constraints: ['夜间吊装需专项方案与照明验收', '噪声限制 22:00 后不得作业'],
        cite: cite('施工组织设计 · 吊装专项', '夜间施工措施', 'V3')
      });
      scenarios.push({
        id: 'SC-B', name: '调整吊装顺序错峰',
        actions: ['先吊装 M-1508/M-1511（避开超重模块）', 'M-1510 模块返厂减重后再吊', 'TC-02 承担轻模块转运'],
        effects: { recoveredDays: Math.min(1, delay), costDelta: 4000, safetyRiskDelta: -0.05, qualityRiskDelta: 0 },
        constraints: ['需设计院确认拆分变更', '工厂排产需前置 1 天'],
        cite: cite('GB 50666-2011', '4.4.6', '2011')
      });
      scenarios.push({
        id: 'SC-C', name: '维持计划并顺延后续工序',
        actions: ['接受 ' + delay + ' 天延期', '顺延机电接驳与 16 层进场'],
        effects: { recoveredDays: 0, costDelta: 0, safetyRiskDelta: 0, qualityRiskDelta: 0 },
        constraints: ['关键路径顺延将影响交付节点'],
        cite: cite('施工组织设计 · 吊装专项', '总进度计划', 'V3')
      });
    } else {
      scenarios.push({
        id: 'SC-A', name: '仅清洗高损失组串',
        actions: ['清洗 S-01', '复测电流'],
        effects: { recoveredKwhDay: 21.6, costDelta: 1200, safetyRiskDelta: 0.1, qualityRiskDelta: 0 },
        constraints: ['需夜间作业与高处防护'],
        cite: cite('GB 50797-2012', '6.3.2', '2012')
      });
      scenarios.push({
        id: 'SC-B', name: '全阵列清洗 + 逆变器滤网维护',
        actions: ['清洗 S-01~S-04', '清理 INV-1/2 通风滤网'],
        effects: { recoveredKwhDay: 28.4, costDelta: 3600, safetyRiskDelta: 0.12, qualityRiskDelta: 0 },
        constraints: ['占用两个夜间窗口'],
        cite: cite('BIPV 运维手册 · 海之韵项目', '清洗周期', 'V2')
      });
    }

    // 打分：收益 - 成本/风险惩罚（确定性权重，可被 UI 解释）
    scenarios.forEach(function (s) {
      var benefit = (s.effects.recoveredDays || 0) * 1.0 + (s.effects.recoveredKwhDay || 0) / 10;
      var penalty = s.effects.costDelta / 10000 + Math.max(0, s.effects.safetyRiskDelta) * 2 + Math.max(0, s.effects.qualityRiskDelta) * 2;
      s.score = round(benefit - penalty, 3);
    });
    scenarios.sort(function (a, b) { return b.score - a.score; });

    return wrap('simulate_plan',
      { goal: goal, scenarios: scenarios, recommended: scenarios[0].id, baselineTask: task.name },
      [cite('施工组织设计 · 吊装专项', '方案比选', 'V3')],
      '推演 ' + scenarios.length + ' 个方案，推荐 ' + scenarios[0].name);
  }

  /* ------------------------------------------------------------------ *
   * 注册表：新增工具只需在此登记，Agent 与 UI 自动可见
   * ------------------------------------------------------------------ */
  var REGISTRY = {
    kb_search: {
      fn: kbSearch, domain: '知识', agent: ['design', 'schedule', 'energy', 'safety', 'coordinator'],
      desc: '检索建筑规范、故障模式与处置经验，返回带条款出处的依据',
      params: { query: 'string', topK: 'number?', expandGraph: 'boolean?' }
    },
    mic_check_compliance: {
      fn: micCheckCompliance, domain: '设计', agent: ['design'],
      desc: '按 MiC 运输/吊装/标准化规范逐条校核模块拆分方案',
      params: { moduleIds: 'string[]?' }
    },
    bim_clash_detect: {
      fn: bimClashDetect, domain: '设计', agent: ['design'],
      desc: '检测 BIM 模型中的机电与结构硬碰撞及净距不足',
      params: { floor: 'number?' }
    },
    mic_suggest_split: {
      fn: micSuggestSplit, domain: '设计', agent: ['design'],
      desc: '为单个模块生成拆分与标准化优化建议及代价评估',
      params: { moduleId: 'string' }
    },
    schedule_predict: {
      fn: schedulePredict, domain: '施工', agent: ['schedule'],
      desc: '基于实际完成率推算工序完工日与延期风险',
      params: { horizonDays: 'number?' }
    },
    crane_plan: {
      fn: cranePlan, domain: '施工', agent: ['schedule'],
      desc: '按塔吊工况、风速与吊装半径生成可用时段与冲突',
      params: { day: 'number?', windMs: 'number?' }
    },
    safety_check_lift: {
      fn: safetyCheckLift, domain: '施工', agent: ['schedule', 'safety'],
      desc: '核对吊装区人员侵入、载荷率与风速，给出风险等级',
      params: { zone: 'string?' }
    },
    safety_multimodal_scan: {
      fn: safetyMultimodalScan, domain: '安全', agent: ['safety'],
      desc: '融合视频 AI 与人员定位事件流，生成隐患工单',
      params: { floor: 'number?' }
    },
    bipv_diagnose: {
      fn: bipvDiagnose, domain: '运维', agent: ['energy'],
      desc: '按组串比对期望/实际发电量，识别积灰、热斑与失配',
      params: { stringIds: 'string[]?' }
    },
    bipv_work_order: {
      fn: bipvWorkOrder, domain: '运维', agent: ['energy'],
      desc: '为异常组串生成带作业窗口与验收要求的运维工单',
      params: { stringIds: 'string[]?', forceAll: 'boolean?' }
    },
    defect_list: {
      fn: defectList, domain: '协同', agent: ['design', 'schedule', 'energy', 'safety', 'coordinator'],
      desc: '查询缺陷台账，统计未闭环与超期项',
      params: { status: 'string?', module: 'string?', minSeverity: 'string?' }
    },
    dispatch_order: {
      fn: dispatchOrder, domain: '协同', agent: ['schedule', 'safety', 'energy'],
      desc: '把缺陷派发到班组并给出验收要求，写入台账',
      params: { defectId: 'string', crew: 'string?' }
    },
    simulate_plan: {
      fn: simulatePlan, domain: '决策', agent: ['coordinator', 'schedule', 'energy'],
      desc: '对多个处置方案做确定性推演并按收益-成本-风险打分',
      params: { goal: 'string' }
    }
  };

  function invoke(name, args) {
    var entry = REGISTRY[name];
    if (!entry) return fail(String(name), '未注册的工具：' + name);
    try {
      return entry.fn(args || {});
    } catch (e) {
      return fail(name, '执行异常：' + (e && e.message ? e.message : String(e)));
    }
  }

  function list(filter) {
    return Object.keys(REGISTRY)
      .filter(function (k) { return !filter || !filter.agent || REGISTRY[k].agent.indexOf(filter.agent) >= 0; })
      .map(function (k) {
        var e = REGISTRY[k];
        return { name: k, domain: e.domain, desc: e.desc, params: e.params, agents: e.agent.slice() };
      });
  }

  root.JR_TOOLS = { invoke: invoke, list: list, REGISTRY: REGISTRY };
})(typeof window !== 'undefined' ? window : globalThis);
