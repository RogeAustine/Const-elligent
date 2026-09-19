/**
 * 见仁建智 · 工程知识底座（GraphRAG 的可检索层）
 * ---------------------------------------------------------------------------
 * 三张表构成一张轻量图：
 *   NODES  —— 规范条文 / 构件 / 传感器 / 故障模式 / 处置经验
 *   EDGES  —— 节点间关系（governs / measures / causes / mitigates / cites）
 *   CHUNKS —— 可被检索的文本单元，带出处与版本
 *
 * Agent 不直接读这张图，而是通过 kb.js 的接口检索；
 * 每条检索结果必须带 cite（规范号 + 条款 + 版本），这是抑制幻觉的结构性手段。
 */
(function (root) {
  'use strict';

  var NODES = [
    { id: 'std:GB50015-3.6.1', kind: '规范条文', title: 'GB 50015-2019 3.6.1', text: '建筑给水排水设计标准对排水立管管径与通气的要求。', version: '2019' },
    { id: 'std:GB50242-3.3.13', kind: '规范条文', title: 'GB 50242-2002 3.3.13', text: '管道穿过楼板处应设置套管，套管高出地面不小于 50mm。', version: '2002' },
    { id: 'std:GB50242-4.2.2', kind: '规范条文', title: 'GB 50242-2002 4.2.2', text: '隐蔽或埋地的排水管道在隐蔽前必须做灌水试验。', version: '2002' },
    { id: 'std:JGJ1-5.4.3', kind: '规范条文', title: 'JGJ 1-2014 5.4.3', text: '装配式混凝土结构预制构件吊装应进行吊具与吊点验算。', version: '2014' },
    { id: 'std:GB50666-4.4.6', kind: '规范条文', title: 'GB 50666-2011 4.4.6', text: '起重吊装作业应设置警戒区，非作业人员不得进入吊装半径。', version: '2011' },
    { id: 'std:GB50797-6.3.2', kind: '规范条文', title: 'GB 50797-2012 6.3.2', text: '光伏组件存在遮挡或积灰时应及时清洗，避免热斑效应。', version: '2012' },
    { id: 'std:GB51368-4.2.5', kind: '规范条文', title: 'GB 51368-2019 4.2.5', text: '建筑光伏系统应监测各组串电流电压，偏差超限应报警。', version: '2019' },
    { id: 'std:JGJ59-3.13.3', kind: '规范条文', title: 'JGJ 59-2011 3.13.3', text: '临边作业应设置防护栏杆，防护高度不低于 1.2m。', version: '2011' },

    { id: 'fm:hotspot', kind: '故障模式', title: '热斑效应', text: '局部遮挡或积灰导致单板温升，组串电流下降，严重时烧毁旁路二极管。', signals: ['组串电流下降', '组件温升', '发电量低于期望'] },
    { id: 'fm:soiling', kind: '故障模式', title: '积灰损失', text: '周边土方或塔吊作业扬尘在组件表面积灰，透过率下降，典型损失 5%~15%。', signals: ['整串均匀下降', '清洗后恢复'] },
    { id: 'fm:inverterOvertemp', kind: '故障模式', title: '逆变器过温', text: '散热通道堵塞或环境温度过高触发降额或停机。', signals: ['逆变器温度 > 55°C', '效率下降'] },
    { id: 'fm:penetrationOffset', kind: '故障模式', title: '预埋套管偏位', text: '工厂预埋偏差导致现场立管无法对齐，需扩孔或返厂。', signals: ['实测坐标超出公差', '管道碰撞'] },
    { id: 'fm:seamLeak', kind: '故障模式', title: '模块拼缝渗漏', text: 'MiC 模块间接缝密封失效，雨水渗入室内。', signals: ['拼缝密封胶缺损', '雨后渗水记录'] },

    { id: 'case:mic-transport', kind: '处置经验', title: '超宽模块运输返工', text: '宽度超过 3.5m 的模块需办理超限运输许可，平均延误 3 天，建议设计阶段收敛宽度。' },
    { id: 'case:crane-conflict', kind: '处置经验', title: '双塔吊交叉作业冲突', text: '两塔吊回转半径重叠时须设置防碰撞区域，调度应错峰占用。' },
    { id: 'case:night-clean', kind: '处置经验', title: '夜间清洗光伏组件', text: '夜间清洗可避免发电损失，但需配置临时照明并做高处作业防护。' }
  ];

  var EDGES = [
    { from: 'std:GB50242-3.3.13', rel: 'governs', to: 'fm:penetrationOffset' },
    { from: 'std:GB50242-4.2.2', rel: 'governs', to: 'fm:seamLeak' },
    { from: 'std:JGJ1-5.4.3', rel: 'governs', to: 'fm:seamLeak' },
    { from: 'std:GB50666-4.4.6', rel: 'governs', to: 'case:crane-conflict' },
    { from: 'std:GB50797-6.3.2', rel: 'governs', to: 'fm:hotspot' },
    { from: 'std:GB51368-4.2.5', rel: 'governs', to: 'fm:soiling' },
    { from: 'std:JGJ59-3.13.3', rel: 'governs', to: 'fm:seamLeak' },
    { from: 'fm:soiling', rel: 'mitigates', to: 'case:night-clean' },
    { from: 'fm:inverterOvertemp', rel: 'mitigates', to: 'case:night-clean' },
    { from: 'fm:hotspot', rel: 'causes', to: 'fm:soiling' },
    { from: 'case:mic-transport', rel: 'cites', to: 'std:JGJ1-5.4.3' }
  ];

  /* 可检索文本块：每个 chunk 必须能回答"你凭什么这么说" */
  var CHUNKS = [
    { id: 'ck-01', node: 'std:GB50242-3.3.13', keywords: ['套管', '楼板', '高出', '预埋', '偏位'], text: '管道穿过楼板处应设置套管，套管高出地面不小于 50mm；套管内不得有接头。' },
    { id: 'ck-02', node: 'std:GB50242-4.2.2', keywords: ['灌水', '闭水', '隐蔽', '排水', '试验'], text: '隐蔽或埋地的排水管道在隐蔽前必须做灌水试验，灌水高度不低于底层卫生器具上边缘。' },
    { id: 'ck-03', node: 'std:JGJ1-5.4.3', keywords: ['吊装', '吊点', '吊具', '验算', '模块'], text: '预制构件吊装前应进行吊具与吊点验算，吊点位置应符合设计要求，必要时增设临时支撑。' },
    { id: 'ck-04', node: 'std:GB50666-4.4.6', keywords: ['吊装半径', '警戒', '警戒区', '塔吊', '交叉'], text: '起重吊装作业应设置警戒区并设专人监护，非作业人员不得进入吊装半径范围。' },
    { id: 'ck-05', node: 'std:GB50797-6.3.2', keywords: ['光伏', '积灰', '遮挡', '热斑', '清洗'], text: '光伏组件存在遮挡或积灰时应及时清洗，避免形成热斑；清洗宜在辐照度低的时段进行。' },
    { id: 'ck-06', node: 'std:GB51368-4.2.5', keywords: ['组串', '电流', '偏差', '报警', '监测'], text: '建筑光伏系统应监测各组串电流电压，同一 MPPT 下组串电流偏差超过 10% 应报警并排查。' },
    { id: 'ck-07', node: 'std:JGJ59-3.13.3', keywords: ['临边', '防护栏杆', '坠落', '高处'], text: '临边作业应设置防护栏杆，防护高度不低于 1.2m，并挂设安全网。' },
    { id: 'ck-08', node: 'std:GB50015-3.6.1', keywords: ['排水立管', '通气', '管径', 'DN110'], text: '排水立管管径应根据卫生器具数量与排水当量计算确定，并设置专用通气立管。' },
    { id: 'ck-09', node: 'fm:soiling', keywords: ['积灰', '扬尘', '损失', '清洗', '恢复'], text: '周边土方或塔吊作业扬尘导致组件表面积灰，透过率下降，典型发电损失 5%~15%，清洗后可恢复。' },
    { id: 'ck-10', node: 'fm:hotspot', keywords: ['热斑', '温升', '二极管', '遮挡'], text: '局部遮挡导致单板温升，组串电流下降，严重时烧毁旁路二极管，需立即排查遮挡源。' },
    { id: 'ck-11', node: 'fm:inverterOvertemp', keywords: ['逆变器', '过温', '滤网', '降额'], text: '逆变器温度超过 55°C 触发降额，应先检查通风滤网与逆变器室环境温度。' },
    { id: 'ck-12', node: 'case:mic-transport', keywords: ['超宽', '运输', '许可', '延误'], text: '模块宽度超过 3.5m 需办理超限运输许可，历史平均延误 3 天。' },
    { id: 'ck-13', node: 'case:crane-conflict', keywords: ['塔吊', '防碰撞', '错峰', '回转'], text: '双塔吊回转半径重叠时须设置防碰撞区域，调度上应错峰占用，避免交叉作业。' },
    { id: 'ck-14', node: 'case:night-clean', keywords: ['夜间', '清洗', '照明', '防护'], text: '夜间清洗可避免发电损失，需配置临时照明并落实高处作业防护与监护人。' }
  ];

  var DOCS = [
    { id: 'doc-bim', name: 'BIM 模型 R7 · MiC 拆分方案', version: 'R7', updated: '2026-09-12', owner: '设计院' },
    { id: 'doc-spec', name: '施工组织设计 · 吊装专项', version: 'V3', updated: '2026-09-08', owner: '总包技术部' },
    { id: 'doc-bipv', name: 'BIPV 运维手册 · 海之韵项目', version: 'V2', updated: '2026-08-30', owner: '绿能运维组' },
    { id: 'doc-csmart', name: 'C-SMART 数据字典', version: 'V1.4', updated: '2026-09-01', owner: '数字化中心' }
  ];

  root.JR_KB = { NODES: NODES, EDGES: EDGES, CHUNKS: CHUNKS, DOCS: DOCS };
})(typeof window !== 'undefined' ? window : globalThis);
