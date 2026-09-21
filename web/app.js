"use strict";
const $ = (selector) => document.querySelector(selector);
const state = {token: "", dataset: null, datasets: [], orders: [], runs: [], run: null, busy: false, selectedDevice: null, pendingProposal: null, retestOrder: null, model: {enabled: false}};
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const pct = value => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const localTime = value => new Date(value).toLocaleString("zh-CN", {hour12:false});
const number = value => Number(value).toLocaleString("zh-CN", {maximumFractionDigits:1});

async function api(path, body) {
  const options = body === undefined ? {} : {method:"POST", headers:{"Content-Type":"application/json", "X-Agent-Token":state.token}, body:JSON.stringify(body)};
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error("服务返回异常，请检查本地服务是否仍在运行。"); }
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

let toastTimer;
function toast(message, error = false) {
  $("#toast").textContent = message;
  $("#toast").className = `toast${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), error ? 7000 : 4500);
}

function switchView(view) {
  document.querySelectorAll(".view").forEach(item => item.classList.toggle("hidden", item.id !== `view-${view}`));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  $("#page-label").textContent = {workspace:"运维工作台", orders:"处置工单", knowledge:"运维知识库", history:"检查记录"}[view];
  if (view === "orders") renderOrders();
  if (view === "history") renderHistory();
}

async function refresh() {
  const data = await api("/api/bootstrap");
  Object.assign(state, {token:data.token, datasets:data.datasets, orders:data.orders, runs:data.runs, model:data.model});
  $("#model-mode").textContent = data.model.mode;
  $("#model-note").textContent = data.model.enabled ? `模型辅助解释已启用：${data.model.model}。检查时会向配置接口发送任务、测量摘要与匹配手册。` : "当前使用本地规则驱动 Agent，可在离线环境运行。";
  $("#nav-order-count").textContent = state.orders.filter(order => order.status === "open").length;
  $("#knowledge-list").innerHTML = data.knowledge.map(entry => `<article class="card knowledge-card"><span class="kb-id">${escapeHTML(entry.id)}</span><h2>${escapeHTML(entry.title)}</h2><span class="subtle">${escapeHTML(entry.source)}</span><p>${escapeHTML(entry.text)}</p><h2>建议动作</h2><p>${escapeHTML(entry.action)}</p><div class="kb-limit">使用边界：${escapeHTML(entry.limitations)}</div></article>`).join("");
  renderScenarios();
  if (state.dataset) renderMetrics();
}

function renderScenarios() {
  $("#scenario-buttons").innerHTML = state.datasets.map(dataset => `<button class="scenario-chip ${state.dataset?.id === dataset.id ? "active" : ""}" data-dataset="${escapeHTML(dataset.id)}" ${state.busy ? "disabled" : ""}>${escapeHTML(dataset.label)}</button>`).join("");
}

async function selectDataset(id, keepRun = false) {
  if (state.busy) return toast("请等待当前检查完成后切换数据。");
  const data = await api(`/api/dataset?id=${encodeURIComponent(id)}`);
  state.dataset = data;
  state.selectedDevice = null;
  if (!keepRun) state.run = null;
  $("#source-label").textContent = data.source === "demo" ? "模拟演示数据" : "用户导入数据";
  $("#source-description").textContent = data.source === "demo" ? "未连接真实设备 · 固定回放样本" : `${data.analysis.sample_count} 条记录 · 本地保存`;
  renderScenarios(); renderDashboard(); renderAgent();
}

function renderMetrics() {
  const a = state.dataset.analysis;
  const open = state.orders.filter(order => order.dataset_id === state.dataset.id && order.status === "open").length;
  const records = [
    ["监测设备", "◫", a.counts.total, "台", `${a.counts.healthy} 台正常 · ${a.counts.observe} 台待观察`, ""],
    ["最新交流功率", "↗", (a.actual_w / 1000).toFixed(2), "kW", `参考 ${(a.reference_w / 1000).toFixed(2)} kW · 天气归一化`, ""],
    ["待核查设备", "◉", a.counts.alert, "台", "根据连续样本规则识别", a.counts.alert ? "warn" : ""],
    ["待复测工单", "▤", open, "份", "当前数据集 · 已人工确认", ""]
  ];
  $("#metrics").innerHTML = records.map(([label, icon, value, unit, note, cls]) => `<article class="metric ${cls}"><div class="metric-top"><span>${label}</span><span>${icon}</span></div><div class="metric-value">${value}<small>${unit}</small></div><div class="metric-note">${note}</div></article>`).join("");
}

function renderDashboard() {
  renderMetrics();
  const a = state.dataset.analysis;
  const values = a.series;
  const max = Math.max(...values.map(v => Math.max(v.actual_w, v.reference_w)), 1) * 1.2;
  const W = 460, H = 165, L = 44, R = 15, T = 15, B = 29;
  const x = i => L + (W-L-R) * (values.length === 1 ? 0.5 : i / (values.length - 1));
  const y = v => H - B - v / max * (H-T-B);
  const path = key => values.map((v,i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v[key]).toFixed(2)}`).join(" ");
  const area = `${path("actual_w")} L${x(values.length-1)},${H-B} L${x(0)},${H-B} Z`;
  const ticks = [0, 0.5, 1].map(r => `<line x1="${L}" y1="${y(r*max)}" x2="${W-R}" y2="${y(r*max)}" stroke="#edf1e8"/><text x="${L-8}" y="${y(r*max)+3}" text-anchor="end" fill="#a2ae98" font-size="9">${Math.round(r*max)}</text>`).join("");
  const indices = [...new Set([0, Math.floor((values.length-1)/2), values.length-1])];
  const labels = indices.map(i => `<text x="${x(i)}" y="${H-7}" text-anchor="middle" fill="#a2ae98" font-size="9">${escapeHTML(values[i].timestamp.slice(11,16))}</text>`).join("");
  $("#power-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="实际交流功率与天气归一化参考功率的趋势对比"><defs><linearGradient id="power-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#9abc71" stop-opacity="0.2"/><stop offset="100%" stop-color="#9abc71" stop-opacity="0"/></linearGradient></defs>${ticks}<path d="${area}" fill="url(#power-fill)"/><path d="${path("reference_w")}" fill="none" stroke="#b8c982" stroke-width="2" stroke-dasharray="4 4"/><path d="${path("actual_w")}" fill="none" stroke="#557b52" stroke-width="2.2"/><circle cx="${x(values.length-1)}" cy="${y(values.at(-1).actual_w)}" r="3" fill="#557b52"/>${labels}</svg>`;
  $("#device-count").textContent = `${a.counts.total} 个监测单元`;
  $("#fleet").innerHTML = a.devices.map(d => `<button class="device ${d.status}${state.selectedDevice === d.device_id ? " selected" : ""}" data-device="${escapeHTML(d.device_id)}"><span>${escapeHTML(d.device_id)}</span><small>${number(d.ac_power_w)} W</small></button>`).join("");
  if (state.selectedDevice) renderDevice(state.selectedDevice);
  else $("#device-detail").textContent = `选择设备查看证据。批次最新时间：${a.latest.replace("T"," ")}`;
}

function renderDevice(id) {
  state.selectedDevice = id;
  const d = state.dataset.analysis.devices.find(device => device.device_id === id);
  document.querySelectorAll(".device").forEach(item => item.classList.toggle("selected", item.dataset.device === id));
  $("#device-detail").innerHTML = `<strong>${escapeHTML(id)} · ${{healthy:"正常",alert:"待核查",observe:"待观察"}[d.status]}</strong><dl><dt>归一化直流功率</dt><dd>${pct(d.normalized_ratio)}</dd><dt>交流 / 直流功率比</dt><dd>${pct(d.conversion_ratio)}</dd><dt>辐照 · 组件温度</dt><dd>${number(d.irradiance_wm2)} W/m² · ${number(d.module_temp_c)}°C</dd><dt>参考直流功率</dt><dd>${number(d.expected_dc_w)} W</dd></dl>${escapeHTML(d.reason)}`;
}

function renderAgent() {
  const run = state.run;
  $("#run-button").disabled = state.busy;
  $("#task").disabled = state.busy;
  $("#upload-button").disabled = state.busy;
  $("#run-button").innerHTML = state.busy ? "检查进行中…" : "开始检查 <span>↗</span>";
  $("#agent-status").textContent = state.busy ? "执行中" : run?.status === "done" ? "已完成" : "就绪";
  $("#agent-status").className = `ready-status${state.busy ? " running" : ""}`;
  if (!run) {
    $("#agent-content").innerHTML = `<div class="welcome"><div class="welcome-tag">YOUR OPERATIONS COPILOT</div><h3>从一次有依据的检查开始。</h3><p>我会核对设备数据，区分天气影响与持续偏差，检索对应的运维手册，并把需要处理的问题整理成工单草案。</p><div class="pipeline"><span><b>01</b>读取数据</span><span><b>02</b>定位偏差</span><span><b>03</b>检索依据</span><span><b>04</b>准备处置</span></div><button class="quick-task" data-prompt="检查全站发电异常，排除天气影响，并准备有依据的处理草案。">检查当前场景，生成处置建议 <span>↗</span></button><button class="quick-task" data-prompt="只检查 PV-03 的发电状态，列出证据和需要核实的原因。">聚焦 PV-03，追溯异常依据 <span>↗</span></button></div>`;
    return;
  }
  const trace = run.trace.map(step => `<details class="trace-step"><summary>${escapeHTML(step.title)} <small>${escapeHTML(step.tool)}</small></summary><pre>${escapeHTML(JSON.stringify(step.output,null,2))}</pre></details>`).join("");
  const proposals = run.proposals.map(proposal => {
    const order = state.orders.find(o => o.proposal_id === proposal.id || (o.dataset_id === run.dataset_id && o.device_id === proposal.device_id && o.code === proposal.code && o.status === "open"));
    return `<article class="proposal"><div class="proposal-top"><strong>${escapeHTML(proposal.device_id)} · ${escapeHTML(proposal.title)}</strong><span>${order ? "已有关联工单" : "待人工确认"}</span></div><p>${escapeHTML(proposal.reason)}</p><p>${escapeHTML(proposal.action)}</p><div class="proposal-actions"><span>依据 ${escapeHTML(proposal.reference_id)} · 3 条原始样本</span>${order ? `<button class="button primary" data-goto="orders">查看工单 ↗</button>` : `<button class="button primary" data-approve="${escapeHTML(proposal.id)}">确认生成工单 ↗</button>`}</div><details class="references"><summary>查看原始证据与测量值</summary><pre>${escapeHTML(JSON.stringify({metrics:proposal.metrics,samples:proposal.evidence},null,2))}</pre></details></article>`;
  }).join("");
  const references = run.references.length ? `<details class="references"><summary>引用 ${run.references.length} 条演示运维依据</summary>${run.references.map(r => `<p><strong>${escapeHTML(r.id)} ${escapeHTML(r.title)}</strong><br>${escapeHTML(r.text)}<br><span class="subtle">${escapeHTML(r.source)}</span></p>`).join("")}</details>` : "";
  $("#agent-content").innerHTML = `<div class="task-bubble"><small>本次检查任务 · ${escapeHTML(run.id)}</small>${escapeHTML(run.task)}</div><div class="trace-title">工具执行记录 <span>${run.trace.length} 步已记录</span></div><div class="trace">${trace}</div>${run.summary ? `<div class="summary-box">${escapeHTML(run.summary)}</div>` : ""}${run.status === "running" ? '<div class="pending">正在执行本次检查，记录将自动更新…</div>' : ""}${run.status === "failed" ? `<div class="error-box">${escapeHTML(run.error)}</div>` : ""}${proposals}${references}${run.model_explanation ? `<div class="model-explanation"><strong>模型辅助解释 · 需人工复核</strong><br>${escapeHTML(run.model_explanation)}</div>` : ""}${run.model_notice ? `<p class="subtle">${escapeHTML(run.model_notice)}</p>` : ""}${run.status === "done" ? `<a class="export-link" href="/api/runs/${encodeURIComponent(run.id)}?format=md">↓ 导出完整检查报告（含证据）</a>` : ""}`;
}

async function pollRun(id) {
  try {
    while (true) {
      const run = await api(`/api/runs/${encodeURIComponent(id)}`);
      state.run = run;
      state.busy = run.status === "running";
      renderAgent();
      if (!state.busy) break;
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    await refresh();
    renderAgent();
    if (state.run.status === "done") toast(`检查完成，${state.run.proposals.length} 份处置草案。`);
  } catch (error) {
    state.busy = false;
    renderAgent(); renderScenarios();
    toast(error.message + " 可在检查记录中重新打开任务。", true);
  }
}

async function runTask(event) {
  event.preventDefault();
  if (state.busy || !state.dataset) return;
  const task = $("#task").value.trim();
  if (!task) return toast("请输入检查任务。", true);
  state.busy = true;
  renderAgent(); renderScenarios();
  try {
    const run = await api("/api/analyze", {dataset_id:state.dataset.id, task});
    state.run = run;
    renderAgent();
    await pollRun(run.id);
  } catch (error) {
    state.busy = false;
    renderAgent(); renderScenarios();
    toast(error.message,true);
  }
}

function emptyState(symbol, title, description) {
  return `<div class="empty-state"><div class="empty-symbol">${symbol}</div><h3>${title}</h3><p>${description}</p><button class="button secondary" data-goto="workspace">返回工作台 ↗</button></div>`;
}

function renderOrders() {
  $("#orders-list").innerHTML = state.orders.length ? state.orders.map(o => `<article class="card order-card"><div class="order-head"><h2>${escapeHTML(o.device_id)} · ${escapeHTML(o.title)}</h2><span class="badge ${o.status}">${o.status === "closed" ? "复测通过 · 已关闭" : "待处理 / 待复测"}</span></div><div class="order-meta">${escapeHTML(o.id)} · ${o.source === "demo" ? "模拟演示" : "导入数据"} · ${escapeHTML(o.approver)} 确认于 ${localTime(o.approved_at)}</div><p>${escapeHTML(o.reason)}</p><p>${escapeHTML(o.action)}</p><div class="order-actions">${o.status === "open" ? `${o.source === "demo" ? `<button class="button primary" data-demo-retest="${escapeHTML(o.id)}">模拟恢复并复测 ↗</button>` : ""}<button class="button secondary" data-csv-retest="${escapeHTML(o.id)}">上传新 CSV 复测</button>` : ""}<a href="/api/orders/${encodeURIComponent(o.id)}">↓ 导出工单与证据</a></div>${o.retests.length ? `<div class="retest-note">最近复测：${o.retests.at(-1).passed ? "通过" : "未通过"}。${escapeHTML(o.retests.at(-1).note)}</div>` : ""}<details class="order-events"><summary>查看 ${o.events.length} 条操作记录</summary>${o.events.map(e => `<p>${localTime(e.at)} · ${escapeHTML(e.event)}${e.by ? ` · ${escapeHTML(e.by)}` : ""}${e.source ? ` · ${e.source === "demo" ? "模拟数据" : "上传数据"}` : ""}</p>`).join("")}</details></article>`).join("") : emptyState("▤", "还没有已确认的工单", "在运维工作台完成检查，确认处置草案后，工单会保存在这里。");
}

function renderHistory() {
  $("#history-list").innerHTML = state.runs.length ? state.runs.map(run => `<article class="card history-row"><div><h3>${escapeHTML(run.task)}</h3><p>${localTime(run.created_at)} · ${escapeHTML(run.dataset_name)} · ${{done:"已完成",running:"执行中",failed:"未完成"}[run.status]}</p></div><button class="button secondary" data-open-run="${escapeHTML(run.id)}">查看记录 ↗</button></article>`).join("") : emptyState("◷", "尚无检查记录", "每次检查都会保存输入、工具结果、引用依据和处置草案。");
}

async function importCSV(file) {
  if (!file) return;
  if (file.size > 2_000_000) return toast("CSV 大小不能超过 2 MB。", true);
  const result = await api("/api/import", {name:file.name, csv:await file.text()});
  await refresh(); await selectDataset(result.id);
  switchView("workspace");
  toast(`已导入 ${result.records} 条记录。`);
}

document.addEventListener("click", async event => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.view) switchView(target.dataset.view);
    if (target.dataset.goto) switchView(target.dataset.goto);
    if (target.dataset.dataset) await selectDataset(target.dataset.dataset);
    if (target.dataset.device) renderDevice(target.dataset.device);
    if (target.dataset.prompt) { $("#task").value = target.dataset.prompt; $("#task").focus(); }
    if (target.dataset.openRun) {
      if (state.busy) return toast("请等待当前检查完成后查看历史。");
      const run = await api(`/api/runs/${encodeURIComponent(target.dataset.openRun)}`);
      await selectDataset(run.dataset_id, true);
      state.run = run; state.busy = run.status === "running";
      renderAgent(); switchView("workspace");
      if (state.busy) await pollRun(run.id);
    }
    if (target.dataset.approve) {
      state.pendingProposal = target.dataset.approve;
      const p = state.run.proposals.find(p => p.id === state.pendingProposal);
      $("#approval-description").textContent = `${p.device_id} · ${p.title}。确认后可在工单页记录复测结果。`;
      $("#approval-dialog").showModal();
    }
    if (target.dataset.demoRetest) {
      target.disabled = true;
      try {
        const result = await api("/api/retest", {order_id:target.dataset.demoRetest, demo:true});
        await refresh(); renderOrders(); renderAgent();
        toast(result.status === "closed" ? "模拟复测通过，演示工单已关闭。" : "复测未通过，工单保持待处理。");
      } finally { target.disabled = false; }
    }
    if (target.dataset.csvRetest) { state.retestOrder = target.dataset.csvRetest; $("#retest-input").click(); }
  } catch (error) { toast(error.message,true); }
});

$("#task-form").addEventListener("submit", runTask);
$("#upload-button").addEventListener("click", () => $("#csv-input").click());
$("#csv-input").addEventListener("change", async event => {
  try { await importCSV(event.target.files[0]); } catch (error) { toast(error.message,true); }
  event.target.value = "";
});
$("#retest-input").addEventListener("change", async event => {
  try {
    const file = event.target.files[0];
    if (file) {
      if (file.size > 2_000_000) throw new Error("复测 CSV 不能超过 2 MB。");
      const result = await api("/api/retest", {order_id:state.retestOrder, csv:await file.text()});
      await refresh(); renderOrders(); renderAgent();
      toast(result.status === "closed" ? "复测通过，工单已关闭。" : "复测未通过，工单保持待处理。");
    }
  } catch (error) { toast(error.message,true); }
  event.target.value = "";
});
$("#cancel-approval").addEventListener("click", () => $("#approval-dialog").close());
$("#approval-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#confirm-approval").disabled = true;
  try {
    await api("/api/approve", {run_id:state.run.id, proposal_id:state.pendingProposal, approver:$("#approver").value.trim()});
    $("#approval-dialog").close();
    await refresh(); renderAgent(); renderOrders();
    toast("已生成本地工单，可进入处置工单页复测。");
  } catch (error) { toast(error.message,true); }
  finally { $("#confirm-approval").disabled = false; }
});
$("#refresh-orders").addEventListener("click", async () => {
  try { await refresh(); renderOrders(); toast("工单记录已刷新。"); } catch (error) { toast(error.message,true); }
});

(async () => {
  try { await refresh(); await selectDataset("mixed"); }
  catch (error) { $("#agent-content").innerHTML = `<div class="error-box">${escapeHTML(error.message)} 请启动本地服务后刷新页面。</div>`; }
})();
