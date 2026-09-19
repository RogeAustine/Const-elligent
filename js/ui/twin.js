/**
 * 见仁建智 · 数字孪生面板
 * ---------------------------------------------------------------------------
 * 把数据平台的三条实时流（MiC 模块状态、C-SMART 传感器、BIPV 组串健康度）
 * 映射成一张可读的现场态势图。它不是装饰：Agent 每次工具调用完成后会
 * 触发高亮，评审能直接看到"智能体的判断落在现场哪个位置"。
 */
(function (root) {
  'use strict';

  var h = root.JR_UI.h, clear = root.JR_UI.clear, esc = root.JR_UI.esc, pct = root.JR_UI.pct;
  var D = root.JR_DATA;

  var STATUS_COLOR = { '已就位': '#10b981', '待吊装': '#f59e0b', '生产中': '#64748b', '运输中': '#38bdf8' };

  function section(title, body, extra) {
    return h('section', { class: 'dt-section' + (extra ? ' ' + extra : '') }, [
      h('div', { class: 'dt-section-head' }, [h('span', { class: 'dt-section-title', text: title })]),
      body
    ]);
  }

  /* ---------- 1. 塔楼剖面 + 模块状态 ---------- */
  function buildingView() {
    var floors = [];
    for (var f = D.PROJECT.floors; f >= 13; f--) {
      var mods = D.MIC_MODULES.filter(function (m) { return m.floor === f; });
      var cells = mods.map(function (m) {
        return h('div', {
          class: 'dt-module' + (m.status === '待吊装' ? ' is-pending' : ''),
          style: { borderColor: STATUS_COLOR[m.status] || '#475569', background: (STATUS_COLOR[m.status] || '#475569') + '22' },
          title: m.id + ' · ' + m.type + ' · ' + m.weightT + 't · ' + m.status,
          'data-module': m.id
        }, [
          h('b', { text: m.id.replace('M-', '') }),
          h('i', { text: m.weightT + 't' })
        ]);
      });
      if (!cells.length) cells = [h('div', { class: 'dt-module is-empty', text: '—' })];
      floors.push(h('div', { class: 'dt-floor' + (f === 15 ? ' is-current' : '') }, [
        h('span', { class: 'dt-floor-no', text: f + 'F' }),
        h('div', { class: 'dt-floor-cells' }, cells)
      ]));
    }
    return h('div', { class: 'dt-building' }, [
      h('div', { class: 'dt-building-cap', text: 'C3 栋 · 第 13–18 层（下为示意，仅展开作业面）' }),
      h('div', { class: 'dt-floors', id: 'dtFloors' }, floors),
      h('div', { class: 'dt-legend' }, Object.keys(STATUS_COLOR).map(function (k) {
        return h('span', { class: 'dt-legend-item' }, [h('i', { style: { background: STATUS_COLOR[k] } }), k]);
      }))
    ]);
  }

  /* ---------- 2. 塔吊工况 ---------- */
  function craneView() {
    var cranes = D.IOT_SENSORS.filter(function (s) { return s.kind === '塔吊'; });
    return h('div', { class: 'dt-cranes' }, cranes.map(function (c) {
      var ratio = c.metrics.loadT / c.metrics.capacityT;
      var danger = ratio > 0.85;
      return h('div', { class: 'dt-crane', 'data-crane': c.id }, [
        h('div', { class: 'dt-crane-top' }, [
          h('b', { text: c.label }),
          h('span', { class: 'dt-chip' + (danger ? ' is-warn' : ''), text: pct(ratio, 0) })
        ]),
        h('div', { class: 'dt-bar' }, [h('i', { style: { width: Math.min(100, ratio * 100) + '%', background: danger ? '#ef4444' : '#38bdf8' } })]),
        h('div', { class: 'dt-crane-meta' }, [
          h('span', { text: '载荷 ' + c.metrics.loadT + '/' + c.metrics.capacityT + 't' }),
          h('span', { text: '半径 ' + c.metrics.radiusM + 'm' }),
          h('span', { text: '风速 ' + c.metrics.windMs + 'm/s' })
        ])
      ]);
    }));
  }

  /* ---------- 3. 环境与安全 ---------- */
  function envView() {
    var env = D.IOT_SENSORS.filter(function (s) { return s.kind === '环境' || s.kind === '人员定位' || s.kind === '结构监测'; });
    var rows = [];
    env.forEach(function (s) {
      Object.keys(s.metrics).forEach(function (k) {
        rows.push({ sensor: s.label, key: k, value: s.metrics[k] });
      });
    });
    var LABEL = {
      pm10: 'PM10 μg/m³', noiseDb: '噪声 dB', tempC: '气温 ℃', humidity: '湿度 %',
      waterLevelM: '基坑水位 m', total: '在场人数', inDangerZone: '危险区人数',
      towerCraneZone: '塔吊区人数', highWork: '高处作业', settlementMm: '沉降 mm', tiltPermille: '倾斜 ‰'
    };
    return h('div', { class: 'dt-env' }, rows.map(function (r) {
      var warn = (r.key === 'inDangerZone' && r.value > 0) || (r.key === 'pm10' && r.value > 100);
      return h('div', { class: 'dt-env-cell' + (warn ? ' is-warn' : ''), 'data-env': r.key }, [
        h('span', { text: LABEL[r.key] || r.key }),
        h('b', { text: String(r.value) })
      ]);
    }));
  }

  /* ---------- 4. BIPV 组串健康度 ---------- */
  function bipvView() {
    return h('div', { class: 'dt-bipv' }, D.BIPV_ARRAY.strings.map(function (s) {
      var health = s.actualKwhDay / s.expectedKwhDay;
      var bad = health < 0.95;
      return h('div', { class: 'dt-string' + (bad ? ' is-warn' : ''), 'data-string': s.id }, [
        h('div', { class: 'dt-string-head' }, [
          h('b', { text: s.id }),
          h('span', { text: pct(health, 0) })
        ]),
        h('div', { class: 'dt-bar' }, [h('i', { style: { width: (health * 100).toFixed(1) + '%', background: bad ? '#f59e0b' : '#10b981' } })]),
        h('div', { class: 'dt-string-meta', text: s.actualKwhDay + ' / ' + s.expectedKwhDay + ' kWh · ' + s.tempC + '°C' })
      ]);
    }));
  }

  /* ---------- 5. 缺陷台账 ---------- */
  function ledgerView() {
    return h('div', { class: 'dt-ledger' }, D.DEFECT_LEDGER.map(function (d) {
      var cls = d.status === '已关闭' ? 'ok' : (d.severity === '高' ? 'bad' : 'warn');
      return h('div', { class: 'dt-ledger-row is-' + cls, 'data-defect': d.id }, [
        h('b', { text: d.id }),
        h('span', { class: 'dt-ledger-kind', text: d.kind }),
        h('span', { class: 'dt-ledger-mod', text: d.module }),
        h('span', { class: 'dt-ledger-status', text: d.status })
      ]);
    }));
  }

  function render(container) {
    clear(container);
    container.appendChild(h('div', { class: 'dt-grid' }, [
      section('数字孪生 · 作业面态势', buildingView(), 'span-2'),
      section('C-SMART · 塔吊工况', craneView()),
      section('C-SMART · 环境与人员', envView()),
      section('BIPV · 组串健康度', bipvView()),
      section('质量缺陷台账', ledgerView())
    ]));
  }

  /* ---------- 高亮：被工具影响的现场位置 ---------- */
  function flash(selector, ms) {
    var el = document.querySelector(selector);
    if (!el) return;
    el.classList.add('is-flash');
    setTimeout(function () { el.classList.remove('is-flash'); }, ms || 1600);
  }

  /**
   * 把工具调用映射到现场位置。这是"数字孪生"名副其实的关键：
   * 每条工具证据都能落到一张图上的具体构件。
   */
  function reflectTool(toolName, data) {
    if (!data) return [];
    var flashed = [];
    try {
      if (toolName === 'mic_check_compliance') {
        (data.results || []).forEach(function (r) {
          if (!r.pass) { flash('[data-module="' + r.moduleId + '"]'); flashed.push(r.moduleId); }
        });
      } else if (toolName === 'bim_clash_detect') {
        (data.clashes || []).forEach(function (c) { flash('[data-module="' + c.moduleId + '"]'); flashed.push(c.moduleId); });
      } else if (toolName === 'crane_plan' || toolName === 'safety_check_lift') {
        (data.slots || []).forEach(function (s) { flash('[data-crane="' + s.crane + '"]'); flashed.push(s.crane); });
        if (data.zone) { flash('[data-env="inDangerZone"]'); flashed.push('人员'); }
      } else if (toolName === 'safety_multimodal_scan') {
        flash('[data-env="inDangerZone"]'); flashed.push('危险区');
      } else if (toolName === 'bipv_diagnose' || toolName === 'bipv_work_order') {
        var targets = (data.findings || data.created || []);
        targets.forEach(function (t) { if (t.stringId) { flash('[data-string="' + t.stringId + '"]'); flashed.push(t.stringId); } });
      } else if (toolName === 'dispatch_order') {
        flash('[data-defect="' + data.defectId + '"]'); flashed.push(data.defectId);
      } else if (toolName === 'schedule_predict') {
        (data.tasks || []).filter(function (t) { return t.delayDays > 0; }).forEach(function (t) { flash('[data-env="total"]'); });
        flashed.push('进度');
      }
    } catch (e) { /* 高亮失败不应影响主流程 */ }
    return flashed;
  }

  root.JR_TWIN = { render: render, reflectTool: reflectTool, flash: flash };
})(window);
