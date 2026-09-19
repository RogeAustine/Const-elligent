/**
 * 见仁建智 · 工具结果渲染器
 * ---------------------------------------------------------------------------
 * 每个工具一个渲染器：把工具的 data 变成工程人员一眼能读的证据卡片。
 * 这样 "Agent 说了什么" 与 "数据实际是什么" 在同一个界面里并置，
 * 评审可以当场核对结论有没有被夸大。
 *
 * 新增工具时无需改这里 —— 没有专属渲染器的工具会走通用 JSON 回退。
 */
(function (root) {
  'use strict';

  var h = root.JR_UI.h, esc = root.JR_UI.esc, pct = root.JR_UI.pct;

  function row(label, value) {
    return h('div', { class: 'tr-row' }, [h('span', { text: label }), h('b', { text: String(value) })]);
  }
  function badge(text, kind) { return h('span', { class: 'tr-badge is-' + (kind || 'info'), text: text }); }
  function table(headers, rows) {
    return h('table', { class: 'tr-table' }, [
      h('thead', {}, [h('tr', {}, headers.map(function (x) { return h('th', { text: x }); }))]),
      h('tbody', {}, rows.map(function (r) {
        return h('tr', {}, r.map(function (c) {
          if (c && c.nodeType) return h('td', {}, [c]);
          return h('td', { text: String(c) });
        }));
      }))
    ]);
  }

  var RENDERERS = {
    kb_search: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('命中', d.hitCount + ' 条'), row('关联节点', d.related.length + ' 个')]),
        h('div', { class: 'tr-cites' }, d.hits.map(function (x) {
          return h('div', { class: 'tr-cite' }, [
            badge(x.kind, x.kind === '规范条文' ? 'std' : 'note'),
            h('b', { text: x.title }),
            h('p', { text: x.text }),
            h('small', { text: '出处：' + x.cite.doc + ' ' + x.cite.clause + '（' + x.cite.version + '）· 匹配分 ' + x.score })
          ]);
        })),
        d.related.length ? h('div', { class: 'tr-related' }, [
          h('span', { class: 'tr-sub', text: '图扩展关联：' }),
          d.related.map(function (r) { return badge(r.title + '（' + r.rel + '）', 'rel'); })
        ]) : null
      ]);
    },

    mic_check_compliance: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('受检模块', d.checked), row('高危项', d.highCount), row('中危项', d.midCount)]),
        table(['模块', '类型', '层', '对角线比', '结论', '问题'], d.results.map(function (r) {
          return [
            r.moduleId, r.type, r.floor + 'F', r.diagRatio,
            r.pass ? badge('通过', 'ok') : badge('不通过', 'bad'),
            r.violations.length ? r.violations.map(function (v) { return '[' + v.level + ']' + v.rule; }).join('；') : '—'
          ];
        }))
      ]);
    },

    bim_clash_detect: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('扫描模块', d.scanned), row('冲突', d.clashes.length), row('高危', d.highCount)]),
        d.clashes.length ? table(['编号', '模块', '类型', '涉及构件', '净距', '建议'], d.clashes.map(function (c) {
          return [c.id, c.moduleId, c.kind, c.between.join(' × '), (c.clearancesMm == null ? '—' : c.clearancesMm + ' mm'),
            badge(c.level, c.level === '高' ? 'bad' : 'warn')];
        })) : h('p', { class: 'tr-empty', text: '未检出冲突。' }),
        d.clashes.length ? h('div', { class: 'tr-suggests' }, d.clashes.map(function (c) {
          return h('p', { text: '· ' + c.moduleId + '：' + c.suggestion });
        })) : null
      ]);
    },

    mic_suggest_split: function (d) {
      return h('div', { class: 'tr-block' }, d.proposals.length ? d.proposals.map(function (p) {
        return h('div', { class: 'tr-proposal' }, [
          h('div', { class: 'tr-proposal-head' }, [badge(p.action, 'plan'), h('b', { text: p.id })]),
          h('p', { text: p.from + '  →  ' + p.to }),
          h('div', { class: 'tr-kv' }, [
            row('单模块重量', p.impact.weightPerModuleT + ' t'),
            row('新增拼缝', p.impact.extraJoints),
            row('新增吊次', p.impact.extraHoists),
            row('工期影响', (p.impact.addedDays > 0 ? '+' : '') + p.impact.addedDays + ' 天')
          ]),
          h('small', { text: p.reason })
        ]);
      }) : h('p', { class: 'tr-empty', text: '该模块无需拆分优化。' }));
    },

    schedule_predict: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [
          row('当前第', d.currentDay + ' 天'),
          row('最大延期', d.maxDelayDays + ' 天'),
          row('预测完工日', '第 ' + d.projectedCompletionDay + ' 天'),
          row('关键路径', d.criticalPath.join('、') || '无')
        ]),
        table(['工序', '区域', '关键', '计划%', '实际%', '偏差', '日产能', '预计延期'], d.tasks.map(function (t) {
          return [t.name, t.zone, t.critical ? '是' : '否', t.planPercent, t.actualPercent,
            badge(t.slip + '%', t.slip > 0 ? 'bad' : 'ok'), t.dailyRate + '%/d',
            t.delayDays > 0 ? badge('+' + t.delayDays + ' 天', t.delayDays >= 2 ? 'bad' : 'warn') : '0'];
        }))
      ]);
    },

    crane_plan: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('风速', d.windMs + ' m/s'), row('风速限值', d.limits.windMs + ' m/s'), row('可用空档', d.freeSlots.join('、') || '无')]),
        table(['时段', '塔吊', '窗口', '任务', '载荷率', '可用'], d.slots.map(function (s) {
          return [s.slot, s.crane, s.window, s.assignedTo || '空闲', pct(s.loadRatio, 1),
            s.feasible ? badge('可排', 'ok') : badge(s.blockedBy.join('；'), 'bad')];
        })),
        d.overlaps.length ? h('div', { class: 'tr-warn' }, d.overlaps.map(function (o) {
          return h('p', { text: '⚠ ' + o.between.join(' 与 ') + ' 回转半径重叠 ' + o.overlapM + ' m：' + o.note });
        })) : null
      ]);
    },

    safety_check_lift: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [
          row('作业区', d.zone),
          row('风险等级', d.level),
          row('人员侵入', d.intrusionCount + ' 起'),
          row('涉及工友', d.affectedWorkers.join('、') || '无'),
          row('载荷率', pct(d.loadRatio, 1))
        ]),
        h('div', { class: 'tr-actions' }, d.actions.map(function (a) { return h('p', { text: '→ ' + a }); }))
      ]);
    },

    safety_multimodal_scan: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [
          row('事件总数', d.scanned),
          row('高危', d.bySeverity['高'] || 0),
          row('中危', d.bySeverity['中'] || 0),
          row('低危', d.bySeverity['低'] || 0)
        ]),
        h('div', { class: 'tr-hotzones' }, d.topZones.map(function (z) { return badge(z.zone + ' × ' + z.count, 'warn'); })),
        table(['事件', '时间', '区域', '类型', '等级', '来源', '置信度'], d.events.map(function (e) {
          return [e.id, e.at.slice(11), e.zone, e.type, badge(e.severity, e.severity === '高' ? 'bad' : (e.severity === '中' ? 'warn' : 'info')), e.source, e.confidence];
        })),
        d.pendingOrders.length ? h('div', { class: 'tr-orders' }, d.pendingOrders.map(function (o) {
          return h('div', { class: 'tr-order' }, [
            h('b', { text: o.id }), h('span', { text: o.zone + ' · ' + o.type }),
            h('span', { text: '责任班组 ' + o.owner }),
            h('span', { text: o.dueHours + ' 小时内闭环' }),
            h('span', { text: '验收证据：' + o.evidenceRequired.join('、') })
          ]);
        })) : null
      ]);
    },

    bipv_diagnose: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [
          row('装机容量', d.capacityKwp + ' kWp'),
          row('异常组串', d.abnormalStrings),
          row('日损失', d.dailyLossKwh + ' kWh'),
          row('损失率', pct(d.dailyLossRatio, 1))
        ]),
        table(['组串', '组件', '期望kWh', '实际kWh', '缺口', '缺口率', '温度', '积灰损失', '判定'], d.findings.map(function (f) {
          return [f.stringId, f.modules, f.expectedKwhDay, f.actualKwhDay, f.gapKwh, pct(f.gapRate, 1), f.tempC + '°C',
            pct(f.soilingLoss, 1), f.abnormal ? badge(f.severity, f.severity === '高' ? 'bad' : 'warn') : badge('正常', 'ok')];
        })),
        h('div', { class: 'tr-causes' }, d.findings.filter(function (f) { return f.causes.length; }).map(function (f) {
          return h('div', { class: 'tr-cause' }, [
            h('b', { text: f.stringId }),
            f.causes.map(function (c) { return badge(c.cause + '（' + c.weight + '）', 'rel'); }),
            h('small', { text: '置信度 ' + f.confidence + '：' + f.causes[0].note })
          ]);
        })),
        d.history.length ? h('div', { class: 'tr-history' }, [
          h('span', { class: 'tr-sub', text: '历史工单：' }),
          d.history.map(function (x) { return badge(x.date + ' ' + x.cause, 'note'); })
        ]) : null
      ]);
    },

    bipv_work_order: function (d) {
      if (!d.created.length) return h('p', { class: 'tr-empty', text: d.note || '无异常组串，未生成工单。' });
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('工单数', d.count), row('预计恢复', d.totalExpectedRecoveryKwhDay + ' kWh/日')]),
        d.created.map(function (o) {
          return h('div', { class: 'tr-order is-card' }, [
            h('div', { class: 'tr-order-head' }, [h('b', { text: o.id }), badge(o.priority, o.priority === '高' ? 'bad' : 'warn'), h('span', { text: o.title })]),
            h('p', { text: '作业窗口：' + o.window + ' · 责任方：' + o.owner }),
            h('ul', {}, o.actions.map(function (a) { return h('li', { text: a }); })),
            h('small', { text: '判定依据：' + o.reason + '；验收证据：' + o.evidenceRequired.join('、') })
          ]);
        })
      ]);
    },

    defect_list: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('台账', d.total), row('未闭环', d.open), row('超期', d.overdue.join('、') || '无')]),
        table(['编号', '模块', '缺陷', '等级', '状态', '责任', 'SLA'], d.rows.map(function (r) {
          return [r.id, r.module, r.kind, badge(r.severity, r.severity === '高' ? 'bad' : (r.severity === '中' ? 'warn' : 'info')), r.status, r.owner || '未派', r.slaDays + ' 天'];
        }))
      ]);
    },

    dispatch_order: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [
          row('缺陷', d.defectId), row('派发班组', d.crew), row('班组负荷', pct(d.crewLoad, 0)),
          row('截止日', '第 ' + d.dueDay + ' 天'), row('台账状态', d.ledgerAfter.status)
        ]),
        d.warning ? h('div', { class: 'tr-warn' }, [h('p', { text: '⚠ ' + d.warning })]) : null,
        h('div', { class: 'tr-actions' }, [h('p', { text: '验收证据：' + d.evidenceRequired.join('、') })])
      ]);
    },

    simulate_plan: function (d) {
      return h('div', { class: 'tr-block' }, [
        h('div', { class: 'tr-kv' }, [row('比选目标', d.goal), row('基准工序', d.baselineTask), row('推荐方案', badge(d.recommended, 'ok'))]),
        table(['方案', '名称', '动作', '工期挽回/发电恢复', '成本增量', '安全风险', '得分'], d.scenarios.map(function (s) {
          return [badge(s.id, s.id === d.recommended ? 'ok' : 'info'), s.name, s.actions.join('；'),
            (s.effects.recoveredDays != null ? s.effects.recoveredDays + ' 天' : '—') + (s.effects.recoveredKwhDay != null ? ' / ' + s.effects.recoveredKwhDay + ' kWh' : ''),
            s.effects.costDelta + ' 元',
            (s.effects.safetyRiskDelta > 0 ? '+' : '') + s.effects.safetyRiskDelta,
            badge(String(s.score), s.id === d.recommended ? 'ok' : 'info')];
        })),
        h('div', { class: 'tr-suggests' }, d.scenarios.map(function (s) {
          return h('p', { text: '· ' + s.id + ' 约束：' + s.constraints.join('；') });
        }))
      ]);
    }
  };

  /** 通用回退：任何新工具都能被看见，不需要改渲染层 */
  function generic(name, data) {
    var text = JSON.stringify(data, null, 2);
    return h('pre', { class: 'tr-json', text: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text });
  }

  function render(name, data) {
    if (data == null) return h('p', { class: 'tr-empty', text: '无返回数据。' });
    var fn = RENDERERS[name];
    try {
      return fn ? fn(data) : generic(name, data);
    } catch (e) {
      return h('div', {}, [h('p', { class: 'tr-empty', text: '渲染器异常：' + e.message }), generic(name, data)]);
    }
  }

  root.JR_RENDER = { render: render, RENDERERS: RENDERERS, badge: badge, row: row, table: table };
})(window);
