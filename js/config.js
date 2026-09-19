/**
 * 见仁建智 · 运行时配置
 * ---------------------------------------------------------------------------
 * 默认 provider = 'offline'：无网络、无密钥即可完整演示全部闭环，
 * 这是评审现场最可靠的模式（评委断网也能跑）。
 *
 * 切换在线大模型（三种方式，任选其一）：
 *   1) 页面右上角「设置」按钮，填入 API Key / Base URL / 模型名（仅存本机 localStorage）
 *   2) 修改本文件的 DEFAULTS
 *   3) 启动网关：node gateway/server.js --port 8787
 *      然后 Base URL 填 http://127.0.0.1:8787/v1 ，可绕开浏览器 CORS 与密钥暴露问题
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    provider: 'offline',          // offline | openai | anthropic
    baseUrl: '',                  // 例如 https://api.deepseek.com/v1
    apiKey: '',
    model: '',                    // 例如 deepseek-chat / qwen-max / glm-4-plus
    maxStepsPerAgent: 6,
    maxRetries: 1,
    temperature: 0.2
  };

  var PRESETS = [
    { id: 'offline', label: '离线确定性推理（推荐演示）', provider: 'offline', baseUrl: '', model: 'rule-react/1.0', needsKey: false },
    { id: 'deepseek', label: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
    { id: 'qwen', label: '通义千问（DashScope 兼容模式）', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true },
    { id: 'glm', label: '智谱 GLM', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', needsKey: true },
    { id: 'local', label: '本地网关 / vLLM', provider: 'openai', baseUrl: 'http://127.0.0.1:8787/v1', model: 'local-model', needsKey: false },
    { id: 'anthropic', label: 'Anthropic', provider: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5', needsKey: true }
  ];

  var KEY = 'jr-config-v1';

  function load() {
    var saved = {};
    try { saved = JSON.parse(root.localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    return Object.assign({}, DEFAULTS, saved);
  }
  function save(cfg) {
    try { root.localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* 隐私模式下忽略 */ }
  }
  function reset() {
    try { root.localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULTS);
  }

  root.JR_CONFIG = { DEFAULTS: DEFAULTS, PRESETS: PRESETS, load: load, save: save, reset: reset };
})(window);
