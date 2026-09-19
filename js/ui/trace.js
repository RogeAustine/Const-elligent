/**
 * 见仁建智 · 推理轨迹与证据台账面板
 * ---------------------------------------------------------------------------
 * 这是"AI 协同能力"评审维度的核心佐证：把每一次 thought / action /
 * observation 原样暴露，并即时渲染工具返回的真实数据。
 *
 * 三个页签分别回答三个问题：
 *   轨迹 —— 智能体是怎么一步步想的？
 *   证据 —— 它的结论引用了哪些规范条款？
 *   指标 —— 这套系统跑了多少步、多少次工具调用、耗时多少？
 */
(function (root) {
  'use strict';

  var h = root.JR_UI.h, clear = root.JR_UI.clear, esc = root.JR_UI.esc, pct = root.JR_UI.pct;

  function TracePanel(container) {
    this.el = container;
    this.steps = 0;
    this.evidence = {};
    this.toolCounts = {};
    this.phaseCount = 0;
    this._build();
  }

  TracePanel.prototype._build = function () {
    var self = this;
    clear(this.el);

    this.tabs = h('div', { class: 'tp-tabs' });
    this.panes = {};
    var defs = [
      { id: 'trace', label: '推理轨迹' },
      { id: 'evidence', label: '证据台账' },
      { id: 'metrics', label: '运行指标' }
    ];
    defs.forEach(function (d) {
      var btn = h('button', { class: 'tp-tab' + (d.id === 'trace' ? ' is-active' : ''), text: d.label, 'data-tab': d.id,
        onclick: function () { self.show(d.id); } });
      self.tabs.appendChild(btn);
      self.panes[d.id] = h('div', { class: 'tp-pane' + (d.id === 'trace' ? ' is-active' : ''), 'data-pane': d.id });
    });

    this.el.appendChild(h('div', { class: 'tp-head' }, [
      h('span', { class: 'tp-title', text: '智能体实时轨迹' }),
      h('span', { class: 'tp-counter', id: 'tpCounter', text: '0 步' })
    ]));
    this.el.appendChild(this.tabs);
    this.el.appendChild(h('div', { class: 'tp-body' }, defs.map(function (d) { return self.panes[d.id]; })));

    this.traceList = h('div', { class: 'tp-list' });
    this.panes.trace.appendChild(this.traceList);
    this.emptyHint = h('p', { class: 'tp-empty', text: '提交现场目标后，这里会实时显示每个智能体的思考与工具调用。' });
    this.traceList.appendChild(this.emptyHint);

    this.evidenceList = h('div', { class: 'tp-evidence' }, [h('p', { class: 'tp-empty', text: '暂无引用。' })]);
    this.panes.evidence.appendChild(this.evidenceList);

    this.metricsBox = h('div', { class: 'tp-metrics' }, [h('p', { class: 'tp-empty', text: '运行结束后显示指标。' })]);
    this.panes.metrics.appendChild(this.metricsBox);
  };

  TracePanel.prototype.show = function (id) {
    Array.prototype.slice.call(this.el.querySelectorAll('.tp-tab')).forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === id);
    });
    Array.prototype.slice.call(this.el.querySelectorAll('.tp-pane')).forEach(function (p) {
      p.classList.toggle('is-active', p.getAttribute('data-pane') === id);
    });
  };

  TracePanel.prototype.reset = function () {
    var self = this;
    this.steps = 0; this.evidence = {}; this.toolCounts = {};
    clear(this.traceList);
    this.traceList.appendChild(this.emptyHint);
    clear(this.evidenceList);
    this.evidenceList.appendChild(h('p', { class: 'tp-empty', text: '暂无引用。' }));
    clear(this.metricsBox);
    this.metricsBox.appendChild(h('p', { class: 'tp-empty', text: '运行结束后显示指标。' }));
    var c = this.el.querySelector('#tpCounter'); if (c) c.textContent = '0 步';
    this.show('trace');
  };

  TracePanel.prototype._scroll = function () {
    var body = this.el.querySelector('.tp-body');
    if (body) body.scrollTop = body.scrollHeight;
  };

  TracePanel.prototype.phase = function (ev) {
    var PHASE = {
      receive: '接收目标', plan: '目标拆解', dispatch: '任务分派',
      layer_done: '层级完成', insight: '跨域关联', synthesize: '结论整合', done: '编排完成'
    };
    this.traceList.appendChild(h('div', { class: 'tp-phase', 'data-phase': ev.phase }, [
      h('span', { class: 'tp-phase-dot' }),
      h('b', { text: PHASE[ev.phase] || ev.phase }),
      h('span', { text: ev.detail })
    ]));
    this._scroll();
  };

  TracePanel.prototype.agentStart = function (ev) {
    var role = root.JR_PROMPTS.ROLES[ev.roleId];
    var node = h('div', { class: 'tp-agent', style: { '--accent': role.accent }, 'data-agent': ev.roleId }, [
      h('div', { class: 'tp-agent-head' }, [
        h('i', { class: 'tp-agent-dot' }),
        h('b', { text: role.name }),
        h('span', { class: 'tp-agent-brief', text: ev.brief })
      ]),
      h('div', { class: 'tp-agent-body' })
    ]);
    this.traceList.appendChild(node);
    this._scroll();
    return node;
  };

  TracePanel.prototype.step = function (ev, agentNode) {
    var s = ev.step;
    this.steps++;
    var c = this.el.querySelector('#tpCounter'); if (c) c.textContent = this.steps + ' 步';

    var role = root.JR_PROMPTS.ROLES[ev.roleId];
    var body = agentNode ? agentNode.querySelector('.tp-agent-body') : this.traceList;

    var block = h('div', { class: 'tp-step' + (s.action === 'final_answer' ? ' is-final' : '') });

    if (s.thought) {
      block.appendChild(h('div', { class: 'tp-thought' }, [
        h('span', { class: 'tp-label', text: 'thought' }),
        h('p', { text: s.thought })
      ]));
    }

    if (s.action !== 'final_answer') {
      var obs = s.observation || {};
      this.toolCounts[s.action] = (this.toolCounts[s.action] || 0) + 1;

      var head = h('div', { class: 'tp-action' }, [
        h('span', { class: 'tp-label', text: 'action' }),
        h('code', { text: s.action }),
        h('span', { class: 'tp-args', text: Object.keys(s.actionInput || {}).length ? JSON.stringify(s.actionInput) : '（无参数）' })
      ]);

      if (s.parseError) head.appendChild(h('span', { class: 'tr-badge is-warn', text: s.parseError }));

      var obsBox = h('div', { class: 'tp-obs' });
      obsBox.appendChild(h('div', { class: 'tp-obs-head' }, [
        h('span', { class: 'tp-label', text: 'observation' }),
        obs.ok === false ? h('span', { class: 'tr-badge is-bad', text: '失败：' + (obs.error || '未知') }) : h('span', { class: 'tr-badge is-ok', text: obs.summary || '成功' })
      ]));
      if (obs.ok !== false) {
        obsBox.appendChild(h('div', { class: 'tp-obs-data' }, [root.JR_RENDER.render(s.action, obs.data)]));
      }
      if (obs.cites && obs.cites.length) {
        this._addEvidence(s.action, obs.cites);
        obsBox.appendChild(h('div', { class: 'tp-cites' }, obs.cites.map(function (c) {
          return h('span', { class: 'tp-cite', text: c.doc + ' ' + c.clause + (c.version ? '（' + c.version + '）' : '') });
        })));
      }

      block.appendChild(head);
      block.appendChild(obsBox);
    } else {
      block.appendChild(h('div', { class: 'tp-final' }, [
        h('span', { class: 'tp-label', text: 'final_answer' }),
        h('div', { class: 'tp-answer', html: root.JR_UI.mdToHtml(s.observation && s.observation.summary === '（收尾）' ? (s.thought || '') : '') })
      ]));
    }

    body.appendChild(block);
    this._scroll();
  };

  TracePanel.prototype._addEvidence = function (tool, cites) {
    var self = this;
    cites.forEach(function (c) {
      var key = c.doc + ' ' + c.clause;
      if (!self.evidence[key]) self.evidence[key] = { cite: c, tools: [] };
      if (self.evidence[key].tools.indexOf(tool) < 0) self.evidence[key].tools.push(tool);
    });
    clear(this.evidenceList);
    var keys = Object.keys(this.evidence);
    if (!keys.length) { this.evidenceList.appendChild(h('p', { class: 'tp-empty', text: '暂无引用。' })); return; }
    var count = h('p', { class: 'tp-evidence-count', text: '本轮共引用 ' + keys.length + ' 条依据（规范 / 模型 / 台账）' });
    this.evidenceList.appendChild(count);
    keys.forEach(function (k) {
      var e = self.evidence[k];
      self.evidenceList.appendChild(h('div', { class: 'tp-evidence-item' }, [
        h('b', { text: e.cite.doc }),
        h('span', { text: e.cite.clause + (e.cite.version ? ' · ' + e.cite.version : '') }),
        h('small', { text: '被用于：' + e.tools.join('、') })
      ]));
    });
  };

  TracePanel.prototype.agentEnd = function (ev) {
    var nodes = this.traceList.querySelectorAll('[data-agent="' + ev.roleId + '"]');
    var node = nodes[nodes.length - 1];
    if (node) {
      var head = node.querySelector('.tp-agent-head');
      if (head) head.appendChild(h('span', { class: 'tp-agent-state', text: ev.stopReason === 'final_answer' ? '已收敛' : ev.stopReason + ' · ' + ev.ms + 'ms' }));
    }
    this._scroll();
  };

  TracePanel.prototype.error = function (msg) {
    this.traceList.appendChild(h('div', { class: 'tp-error', text: msg }));
    this._scroll();
  };

  TracePanel.prototype.setMetrics = function (report, extra) {
    var m = report.metrics;
    clear(this.metricsBox);
    this.metricsBox.appendChild(h('div', { class: 'tp-metric-grid' }, [
      metric('智能体', m.agents),
      metric('工具调用', m.toolCalls),
      metric('推理步数', m.steps),
      metric('总耗时', m.ms + ' ms'),
      metric('决策模型', extra && extra.model || m.provider),
      metric('引用依据', report.evidence.length)
    ]));
    this.metricsBox.appendChild(h('div', { class: 'tp-metric-section', text: '各智能体分项' }));
    this.metricsBox.appendChild(root.JR_RENDER.table(['智能体', '步数', '工具', '耗时', '收敛状态'], m.byAgent.map(function (a) {
      return [a.agentName, a.steps, a.toolCalls, a.ms + ' ms',
        a.stopReason === 'final_answer' ? root.JR_RENDER.badge('正常收敛', 'ok') : root.JR_RENDER.badge(a.stopReason, 'warn')];
    })));
    if (Object.keys(this.toolCounts).length) {
      this.metricsBox.appendChild(h('div', { class: 'tp-metric-section', text: '工具调用分布' }));
      var total = Object.keys(this.toolCounts).reduce(function (s, k) { return s + this.toolCounts[k]; }.bind(this), 0);
      this.metricsBox.appendChild(h('div', { class: 'tp-toolbars' }, Object.keys(this.toolCounts).sort(function (a, b) {
        return this.toolCounts[b] - this.toolCounts[a];
      }.bind(this)).map(function (k) {
        var w = (this.toolCounts[k] / total) * 100;
        return h('div', { class: 'tp-toolbar' }, [
          h('code', { text: k }),
          h('div', { class: 'tp-toolbar-track' }, [h('i', { style: { width: w.toFixed(1) + '%' } })]),
          h('span', { text: this.toolCounts[k] + ' 次' })
        ]);
      }.bind(this))));
    }
    this.show('metrics');
  };

  function metric(label, value) {
    return h('div', { class: 'tp-metric' }, [h('span', { text: label }), h('b', { text: String(value) })]);
  }

  root.JR_TRACE = { TracePanel: TracePanel };
})(window);
