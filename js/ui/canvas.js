/**
 * 见仁建智 · 多智能体编排画布
 * ---------------------------------------------------------------------------
 * 把 orchestrator 的"分层并行 + 依赖门控"直接画出来：
 *   - 每个任务是一张卡，卡片位置由拓扑层级决定；
 *   - 卡片之间的连线表示 dependsOn，只有前置任务完成后下游才开始；
 *   - 任务运行时，连线会出现流动脉冲，卡片上实时累加工具调用次数。
 *
 * 这是本项目区别于"单个大模型套壳"最直观的证据：观众能看见工作在被
 * 拆开、被并行、被汇总。
 */
(function (root) {
  'use strict';

  var h = root.JR_UI.h, clear = root.JR_UI.clear;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function Canvas(container, bus) {
    this.el = container;
    this.bus = bus;
    this.cards = {};   // taskId -> { el, node, task }
    this.layers = [];
    this.edges = [];
    this.coordinatorEl = null;
    this._render();
  }

  Canvas.prototype._render = function () {
    clear(this.el);
    this.el.appendChild(h('div', { class: 'cv-head' }, [
      h('span', { class: 'cv-title', text: '多智能体编排视图' }),
      h('span', { class: 'cv-sub', id: 'cvSub', text: '待接收现场目标' })
    ]));

    this.flow = h('div', { class: 'cv-flow' });
    this.svg = svgEl('svg', { class: 'cv-svg' });
    this.hub = h('div', { class: 'cv-hub' }, [
      h('div', { class: 'cv-hub-dot' }),
      h('div', { class: 'cv-hub-text' }, [
        h('b', { text: '调度中枢' }),
        h('span', { text: 'Coordinator Agent' })
      ])
    ]);
    this.stage = h('div', { class: 'cv-stage' }, [this.svg, this.hub, h('div', { class: 'cv-hub-line' })]);
    this.flow.appendChild(this.stage);
    this.el.appendChild(this.flow);

    this.detail = h('div', { class: 'cv-detail', id: 'cvDetail' });
    this.el.appendChild(this.detail);

    var self = this;
    root.addEventListener('resize', function () { self._drawEdges(); });
  };

  /** 依据编排计划布局任务卡 */
  Canvas.prototype.setPlan = function (plan) {
    var self = this;
    this.cards = {}; this.edges = [];
    Array.prototype.slice.call(this.stage.querySelectorAll('.cv-layer')).forEach(function (n) { n.remove(); });

    var layers = root.JR_ORCHESTRATOR.topoLayers(plan.tasks);
    this.layers = layers;

    var sub = this.el.querySelector('#cvSub');
    if (sub) sub.textContent = plan.source === 'model' ? '模型规划 · ' + plan.tasks.length + ' 个任务' : '模板规划 · ' + plan.tasks.length + ' 个任务';

    layers.forEach(function (layer, li) {
      var row = h('div', { class: 'cv-layer', 'data-layer': li });
      layer.forEach(function (task) {
        var role = root.JR_PROMPTS.ROLES[task.agent];
        var card = h('div', { class: 'cv-card', 'data-task': task.id, style: { '--accent': role.accent } }, [
          h('div', { class: 'cv-card-top' }, [
            h('span', { class: 'cv-card-agent', text: role.short }),
            h('span', { class: 'cv-card-state', text: '待分派' })
          ]),
          h('p', { class: 'cv-card-brief', text: task.brief }),
          h('div', { class: 'cv-card-stat' }, [
            h('span', { class: 'cv-stat-tools', text: '工具 0' }),
            h('span', { class: 'cv-stat-time', text: '—' })
          ])
        ]);
        row.appendChild(card);
        self.cards[task.id] = { el: card, task: task, layer: li, role: role };
      });
      self.stage.appendChild(row);
    });

    // 依赖边
    plan.tasks.forEach(function (t) {
      (t.dependsOn || []).forEach(function (dep) {
        if (self.cards[dep] && self.cards[t.id]) self.edges.push({ from: dep, to: t.id });
      });
    });

    requestAnimationFrame(function () { self._drawEdges(); });
  };

  Canvas.prototype._drawEdges = function () {
    if (!this.svg) return;
    clear(this.svg);
    var stageRect = this.stage.getBoundingClientRect();
    var self = this;

    function centerOf(node) {
      var r = node.getBoundingClientRect();
      return { x: r.left - stageRect.left + r.width / 2, y: r.top - stageRect.top + r.height / 2, w: r.width, h: r.height, r: r };
    }

    // 中枢 -> 第一层任务
    var hubC = centerOf(this.hub);
    this.layers[0] && this.layers[0].forEach(function (t) {
      var c = self.cards[t.id];
      if (!c) return;
      var p = centerOf(c.el);
      var path = svgEl('path', {
        class: 'cv-edge cv-edge-hub', 'data-to': t.id,
        d: 'M' + hubC.x + ',' + (hubC.y + hubC.h / 2) + ' C' + hubC.x + ',' + (p.y - 40) + ' ' + p.x + ',' + (hubC.y + hubC.h / 2) + ' ' + p.x + ',' + (p.y - p.h / 2)
      });
      self.svg.appendChild(path);
    });

    // 任务之间依赖
    this.edges.forEach(function (e) {
      var a = self.cards[e.from], b = self.cards[e.to];
      if (!a || !b) return;
      var pa = centerOf(a.el), pb = centerOf(b.el);
      var d;
      if (a.layer === b.layer) {
        var right = pa.x < pb.x ? pa : pb, left = pa.x < pb.x ? pb : pa;
        d = 'M' + (right.x + right.w / 2) + ',' + right.y + ' C' + (right.x + right.w / 2 + 50) + ',' + right.y + ' ' + (left.x - left.w / 2 - 50) + ',' + left.y + ' ' + (left.x - left.w / 2) + ',' + left.y;
      } else {
        d = 'M' + pa.x + ',' + (pa.y + pa.h / 2) + ' C' + pa.x + ',' + (pa.y + pa.h / 2 + 30) + ' ' + pb.x + ',' + (pb.y - pb.h / 2 - 30) + ' ' + pb.x + ',' + (pb.y - pb.h / 2);
      }
      self.svg.appendChild(svgEl('path', { class: 'cv-edge', 'data-from': e.from, 'data-to': e.to, d: d }));
    });

    // 已就绪/运行中的边加脉冲
    Object.keys(this.cards).forEach(function (id) {
      var c = self.cards[id];
      if (c.el.classList.contains('is-running')) {
        Array.prototype.slice.call(self.svg.querySelectorAll('[data-to="' + id + '"]')).forEach(function (p) { p.classList.add('is-live'); });
      }
    });
    this.svg.setAttribute('viewBox', '0 0 ' + stageRect.width + ' ' + stageRect.height);
  };

  Canvas.prototype.setState = function (taskId, state, text) {
    var c = this.cards[taskId];
    if (!c) return;
    c.el.classList.remove('is-wait', 'is-running', 'is-done', 'is-failed');
    c.el.classList.add('is-' + state);
    var badge = c.el.querySelector('.cv-card-state');
    if (badge) badge.textContent = text || { wait: '待分派', running: '执行中', done: '已完成', failed: '失败' }[state];
    if (state === 'running') {
      var self = this;
      Array.prototype.slice.call(this.svg.querySelectorAll('[data-to="' + taskId + '"]')).forEach(function (p) { p.classList.add('is-live'); });
      this._drawEdges();
    }
    if (state === 'done' || state === 'failed') this._drawEdges();
  };

  /** 每次工具调用后刷新卡片统计 */
  Canvas.prototype.bumpTask = function (taskId, toolCount, ms) {
    var c = this.cards[taskId];
    if (!c) return;
    var t = c.el.querySelector('.cv-stat-tools');
    if (t) t.textContent = '工具 ' + toolCount;
    var tm = c.el.querySelector('.cv-stat-time');
    if (tm && ms != null) tm.textContent = ms + ' ms';
  };

  Canvas.prototype.highlightAgent = function (agentId, on) {
    var self = this;
    Object.keys(this.cards).forEach(function (id) {
      var c = self.cards[id];
      if (c.task.agent === agentId) c.el.classList.toggle('is-thinking', !!on);
    });
  };

  Canvas.prototype.showDetail = function (artifact) {
    var role = root.JR_PROMPTS.ROLES[artifact.agent];
    clear(this.detail);
    this.detail.appendChild(h('div', { class: 'cv-detail-head', style: { '--accent': role.accent } }, [
      h('b', { text: role.name }),
      h('span', { text: '任务 ' + artifact.id + ' · ' + artifact.toolCalls.length + ' 次工具调用 · ' + artifact.ms + ' ms · ' + artifact.stopReason })
    ]));
    this.detail.appendChild(h('p', { class: 'cv-detail-brief', text: '分派指令：' + artifact.brief }));
    if (artifact.toolCalls.length) {
      this.detail.appendChild(h('div', { class: 'cv-detail-tools' }, artifact.toolCalls.map(function (c) {
        return h('div', { class: 'cv-detail-tool' }, [
          h('code', { text: c.name }),
          h('span', { text: c.summary || '' })
        ]);
      })));
    } else {
      this.detail.appendChild(h('p', { class: 'cv-detail-empty', text: '本轮未调用工具（结论来自其他域的共享结论）。' }));
    }
    this.detail.appendChild(h('div', { class: 'cv-detail-answer', html: root.JR_UI.mdToHtml(artifact.answer) }));
  };

  Canvas.prototype.clearDetail = function () { clear(this.detail); };

  Canvas.prototype.reset = function () {
    clear(this.el);
    this._render();
  };

  root.JR_CANVAS = { Canvas: Canvas };
})(window);
