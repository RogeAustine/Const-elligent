/**
 * 见仁建智 · 前端基础工具（无框架依赖）
 * ---------------------------------------------------------------------------
 * 刻意不引入 React/Vue：这是一个需要在评审现场"双击即开、断网可用"的
 * 交付物，构建链越短，展示风险越低。所有视图都是纯函数式渲染 + 局部更新。
 */
(function (root) {
  'use strict';

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children == null) return el;
    if (Array.isArray(children)) { children.forEach(function (c) { append(el, c); }); return el; }
    if (children instanceof Node) { el.appendChild(children); return el; }
    el.appendChild(document.createTextNode(String(children)));
    return el;
  }

  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pct(v, d) { d = d == null ? 1 : d; return (Math.round(v * Math.pow(10, d) * 100) / Math.pow(10, d)).toFixed(d) + '%'; }
  function num(v, d) { d = d == null ? 1 : d; return Number(v).toFixed(d); }

  /** 迷你 Markdown：只支持标题、加粗、列表，够用且无 XSS 风险 */
  function mdToHtml(src) {
    var lines = String(src || '').split('\n');
    var out = [];
    var inList = false;
    lines.forEach(function (raw) {
      var line = esc(raw);
      line = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      var isItem = /^\s*[·\-*]\s+/.test(raw) || /^\s*\d+[.)]\s+/.test(raw);
      if (isItem) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + line.replace(/^\s*[·\-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, '') + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (/^#{1,3}\s+/.test(raw)) out.push('<h4>' + line.replace(/^#{1,3}\s+/, '') + '</h4>');
        else if (/^[一二三四五六七八九十]、/.test(raw)) out.push('<h5>' + line + '</h5>');
        else if (line.trim() === '') out.push('');
        else out.push('<p>' + line + '</p>');
      }
    });
    if (inList) out.push('</ul>');
    return out.join('\n');
  }

  /** 事件总线：UI 各面板通过它解耦，便于单独替换某个面板 */
  function createBus() {
    var handlers = {};
    return {
      on: function (evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return function () { handlers[evt] = handlers[evt].filter(function (f) { return f !== fn; }); }; },
      emit: function (evt, payload) { (handlers[evt] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error(e); } }); (handlers['*'] || []).forEach(function (fn) { fn(evt, payload); }); }
    };
  }

  /** 运行记录导出：支撑"可追溯"这一评审点 */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  root.JR_UI = { h: h, clear: clear, $: $, esc: esc, sleep: sleep, pct: pct, num: num, mdToHtml: mdToHtml, createBus: createBus, download: download };
})(window);
