/**
 * 见仁建智 · 综合决策报告
 * ---------------------------------------------------------------------------
 * 把一轮编排的全部产出收口成一份"能拿给项目经理看"的东西：
 *   结论摘要 / 跨域关联 / 建议动作 / 需人工确认事项
 * 外加任务拆解依据、各域结论、证据台账与可下载的完整运行记录。
 *
 * 刻意保留"需人工确认事项"这一段并且不可关闭：系统的定位是决策支持，
 * 不是替代签字的人。
 *
 * 建议动作清单是"从工具证据反推"出来的，不是让模型自由发挥：每条动作都能
 * 对应到某个工具的某个字段，因此它天然与页面上的数值一致，评审可以逐条核对。
 */
(function (root) {
  'use strict';

  var h = root.JR_UI.h, clear = root.JR_UI.clear;

  /* ------------------------------------------------------------------ *
   * 建议动作：遍历各域工具的真实返回，抽出可执行条目
   * ------------------------------------------------------------------ */
  function collectActions(report) {
    var actions = [];
    report.artifacts.forEach(function (a) {
      a.toolCalls.forEach(function (c) {
        var d = c.result && c.result.data;
        if (!d) return;

        if (c.name === 'safety_multimodal_scan') (d.pendingOrders || []).forEach(function (o) {
          actions.push({
            owner: o.owner, when: o.dueHours + ' 小时内',
            what: o.zone + ' · ' + o.type + ' 整改（' + o.id + '）',
            evidence: o.evidenceRequired.join('、'), level: o.severity
          });
        });

        if (c.name === 'bipv_work_order') (d.created || []).forEach(function (o) {
          actions.push({
            owner: o.owner, when: o.window, what: o.title + '（预计恢复 ' + o.expectedRecoveryKwhDay + ' kWh/日）',
            evidence: o.evidenceRequired.join('、'), level: o.priority
          });
        });

        if (c.name === 'dispatch_order') actions.push({
          owner: d.crew, when: '第 ' + d.dueDay + ' 天前',
          what: '整改 ' + d.defectId + '（' + d.kind + '）',
          evidence: d.evidenceRequired.join('、'), level: d.severity
        });

        if (c.name === 'mic_suggest_split') (d.proposals || []).forEach(function (p) {
          actions.push({
            owner: '设计院', when: '下一版 BIM 修订', what: p.action + '：' + p.to,
            evidence: '设计变更单 + 工厂排产确认', level: '中'
          });
        });

        if (c.name === 'mic_check_compliance') (d.results || []).forEach(function (r) {
          r.violations.filter(function (v) { return v.level === '高'; }).forEach(function (v) {
            actions.push({
              owner: '设计院', when: '下一版 BIM 修订前', what: r.moduleId + ' ' + v.rule + '：' + v.detail,
              evidence: '设计变更单 + 工厂排产确认', level: '高'
            });
          });
        });

        if (c.name === 'bim_clash_detect') (d.clashes || []).filter(function (x) { return x.level === '高'; }).forEach(function (x) {
          actions.push({
            owner: '设计院', when: '下一版 BIM 修订前',
            what: x.moduleId + ' ' + x.kind + '（' + x.between.join(' × ') + '）：' + x.suggestion,
            evidence: '碰撞检查报告 + 设计确认', level: '高'
          });
        });

        if (c.name === 'schedule_predict' && d.maxDelayDays > 0) {
          var worst = (d.tasks || [])[0];
          if (worst) actions.push({
            owner: '项目经理', when: '今日内',
            what: '处置 ' + worst.name + '（延期 ' + worst.delayDays + ' 天，SPI ' + worst.spi + '）',
            evidence: '方案比选记录 + 抢工令', level: worst.delayDays >= 4 ? '高' : '中'
          });
        }

        if (c.name === 'crane_plan') (d.slots || []).filter(function (s) { return s.feasible && !s.assignedTo; }).forEach(function (s) {
          actions.push({
            owner: '吊装班组', when: '第 ' + d.day + ' 天 ' + s.window,
            what: '占用 ' + s.crane + ' ' + s.slot + ' 空档推进吊装',
            evidence: '吊装令 + 班前交底记录', level: '中'
          });
        });

        if (c.name === 'simulate_plan') {
          var rec = (d.scenarios || []).filter(function (s) { return s.id === d.recommended; })[0];
          if (rec) actions.push({
            owner: '项目经理', when: '今日班前会',
            what: '比选推荐方案：' + rec.name + '（' + rec.actions.join('；') + '）',
            evidence: '方案比选与交底记录；约束：' + rec.constraints.join('；'), level: '高'
          });
        }

        if (c.name === 'safety_check_lift' && d.level === '高') d.actions.forEach(function (act) {
          actions.push({ owner: '吊装班组', when: '立即', what: act, evidence: '作业票 + 监护人签字', level: '高' });
        });
      });
    });

    var rank = { 高: 3, 中: 2, 低: 1 };
    actions.sort(function (a, b) { return (rank[b.level] || 0) - (rank[a.level] || 0); });
    var seen = {}, out = [];
    actions.forEach(function (a) {
      if (seen[a.what]) return;
      seen[a.what] = 1;
      out.push(a);
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 渲染器
   * ------------------------------------------------------------------ */
  function Renderer(container) {
    this.el = container;
    this.report = null;
  }

  Renderer.prototype.clear = function () { clear(this.el); this.report = null; };

  Renderer.prototype.render = function (report, llmMeta) {
    this.report = report;
    var self = this;
    clear(this.el);

    /* ---- 顶部结论卡 ---- */
    this.el.appendChild(h('section', { class: 'rp-hero' }, [
      h('div', { class: 'rp-hero-left' }, [
        h('span', { class: 'rp-kicker', text: '综合决策建议' }),
        h('h2', { text: report.goal }),
        h('div', { class: 'rp-hero-meta' }, [
          chip('智能体 ' + report.metrics.agents + ' 个'),
          chip('工具调用 ' + report.metrics.toolCalls + ' 次'),
          chip('推理步数 ' + report.metrics.steps),
          chip('耗时 ' + (report.metrics.ms / 1000).toFixed(1) + ' s'),
          chip('模型 ' + ((llmMeta && llmMeta.model) || report.metrics.provider), 'accent')
        ])
      ]),
      h('div', { class: 'rp-hero-actions' }, [
        h('button', { class: 'rp-btn', text: '导出运行记录 JSON', onclick: function () { self.exportJson(); } }),
        h('button', { class: 'rp-btn ghost', text: '复制结论', onclick: function () { self.copyConclusion(); } })
      ])
    ]));

    /* ---- 决策建议正文 ---- */
    this.el.appendChild(sectionCard('决策建议',
      h('div', { class: 'rp-conclusion', html: root.JR_UI.mdToHtml(report.conclusion) }), 'primary'));

    /* ---- 跨域关联 ---- */
    if (report.insights.length) {
      this.el.appendChild(sectionCard('跨域关联（系统检出）',
        h('div', { class: 'rp-insights' }, report.insights.map(function (i) {
          return h('div', { class: 'rp-insight' }, [h('code', { text: i.id }), h('p', { text: i.text })]);
        })), 'accent'));
    }

    /* ---- 各域结论 ---- */
    this.el.appendChild(sectionCard('各专业智能体结论',
      h('div', { class: 'rp-artifacts' }, report.artifacts.map(function (a) {
        return h('article', { class: 'rp-artifact', style: { '--accent': a.accent } }, [
          h('header', {}, [
            h('b', { text: a.agentName }),
            h('span', { text: '任务 ' + a.id + ' · ' + a.toolCalls.length + ' 次工具 · ' + a.ms + ' ms' }),
            a.stopReason === 'final_answer' ? root.JR_RENDER.badge('正常收敛', 'ok') : root.JR_RENDER.badge(a.stopReason, 'warn')
          ]),
          h('p', { class: 'rp-artifact-brief', text: '分派指令：' + a.brief }),
          h('div', { class: 'rp-artifact-answer', html: root.JR_UI.mdToHtml(a.answer) }),
          a.toolCalls.length ? h('div', { class: 'rp-artifact-tools' }, a.toolCalls.map(function (c) {
            return h('div', { class: 'rp-artifact-tool' }, [h('code', { text: c.name }), h('span', { text: c.summary })]);
          })) : null
        ]);
      }))));

    /* ---- 建议动作 ---- */
    var actions = collectActions(report);
    this.el.appendChild(sectionCard('建议动作清单（按优先级）', actions.length
      ? root.JR_RENDER.table(['优先级', '责任方', '时限', '动作', '验收证据'], actions.map(function (a) {
        return [root.JR_RENDER.badge(a.level, a.level === '高' ? 'bad' : (a.level === '中' ? 'warn' : 'info')),
          a.owner, a.when, a.what, a.evidence];
      }))
      : h('p', { class: 'rp-empty', text: '本轮无新增待办动作。' })));

    /* ---- 需人工确认 ---- */
    this.el.appendChild(sectionCard('需人工确认事项',
      h('div', { class: 'rp-confirm' }, report.confirmations.map(function (c) {
        return h('div', { class: 'rp-confirm-item' }, [h('b', { text: c.from }), h('span', { text: c.text })]);
      })), 'warn'));

    /* ---- 编排时间线 ---- */
    var PHASE = {
      receive: '接收目标', plan: '目标拆解', dispatch: '任务分派', layer_done: '层级完成',
      insight: '跨域关联', synthesize: '结论整合', done: '编排完成'
    };
    var t0 = report.timeline.length ? report.timeline[0].at : 0;
    this.el.appendChild(sectionCard('编排时间线',
      h('div', { class: 'rp-timeline' }, report.timeline.map(function (t) {
        return h('div', { class: 'rp-tl-item' }, [
          h('i', {}),
          h('b', { text: PHASE[t.phase] || t.phase }),
          h('span', { text: t.detail }),
          h('em', { text: '+' + (t.at - t0) + ' ms' })
        ]);
      }))));

    /* ---- 任务拆解依据 ---- */
    this.el.appendChild(sectionCard('任务拆解依据', h('div', { class: 'rp-plan' }, [
      h('p', { class: 'rp-plan-thought', text: '规划思路：' + (report.plan.thought || '（模型未给出显式思路）') }),
      h('p', { class: 'rp-plan-source', text: '规划来源：' + (report.plan.source === 'model'
        ? '模型自主拆解' : '确定性任务模板（模型规划未通过校验时的保守回退）') }),
      root.JR_RENDER.table(['任务', '执行者', '依赖', '指令'], report.plan.tasks.map(function (t) {
        return [t.id, root.JR_PROMPTS.ROLES[t.agent].name, (t.dependsOn || []).join('、') || '无', t.brief];
      }))
    ])));

    /* ---- 证据台账 ---- */
    this.el.appendChild(sectionCard('证据台账（全部引用出处）', report.evidence.length
      ? h('div', { class: 'rp-evidence' }, report.evidence.map(function (e) {
        return h('span', { class: 'rp-evidence-chip', text: e });
      }))
      : h('p', { class: 'rp-empty', text: '本轮无引用。' })));
  };

  function chip(text, kind) {
    return h('span', { class: 'rp-chip' + (kind ? ' is-' + kind : ''), text: text });
  }

  function sectionCard(title, body, kind) {
    return h('section', { class: 'rp-card' + (kind ? ' is-' + kind : '') }, [
      h('header', { class: 'rp-card-head' }, [h('h3', { text: title })]),
      h('div', { class: 'rp-card-body' }, [body])
    ]);
  }

  Renderer.prototype.exportJson = function () {
    if (!this.report) return;
    var payload = {
      exportedAt: new Date().toISOString(),
      system: '见仁建智 · 多智能体协同工程管理系统',
      project: root.JR_DATA.PROJECT,
      report: this.report
    };
    var name = 'jianrenjianzhi-run-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    root.JR_UI.download(name, JSON.stringify(payload, null, 2));
  };

  Renderer.prototype.copyConclusion = function () {
    if (!this.report) return;
    var text = this.report.conclusion;
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      root.navigator.clipboard.writeText(text).then(function () { /* 静默成功 */ }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  };

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* 复制失败不应影响主流程 */ }
  }

  root.JR_REPORT = { Renderer: Renderer, collectActions: collectActions };
})(window);
