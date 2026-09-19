/**
 * 见仁建智 · 数据平台层
 * ---------------------------------------------------------------------------
 * 模拟一座 MiC + BIPV 示范项目在 C-SMART 智慧工地体系下的实时数据快照。
 *
 * 设计约束：
 *   - 纯数据，无行为。任何取值都能被工具层（tools.js）复用。
 *   - 确定性：给定同一 snapshot 输入，所有派生指标必须可复现。
 *   - 所有实体带 source 字段，指向"数据从哪来"，供 Agent 引用出处。
 */
(function (root) {
  'use strict';

  var PROJECT = {
    code: 'SDU-MIC-2026',
    name: '海之韵 · 装配式示范社区',
    phase: '主体施工',
    building: 'C3 栋（MiC 高层住宅）',
    floors: 18,
    day: 46,
    weather: { condition: '多云', tempC: 24, windMs: 6.2, rainMm: 0 },
    shift: '白班 07:00–18:00',
    snapshotAt: '2026-09-19T14:20:00+08:00'
  };

  /* ------------------------------------------------------------------ *
   * 1) MiC 模块：设计态（BIM/拆分方案）
   * ------------------------------------------------------------------ */
  var MIC_MODULES = [
    {
      id: 'M-1508', type: '卫生间模块', floor: 15, zone: 'A',
      weightT: 12.6, lengthM: 5.8, widthM: 3.0, heightM: 2.9,
      diagM: 6.53, reuseRate: 0.14, corridorClearM: 2.45,
      hoistRadiusM: 30, craneCapacityT: 16.0,
      services: ['给水', '排水', '电气', '通风'],
      penetrations: ['DN110 排水立管', 'DN25 给水支管', 'JDG20 电气套管'],
      status: '待吊装', designRevision: 'BIM-R7'
    },
    {
      id: 'M-1509', type: '卫生间模块', floor: 15, zone: 'A',
      weightT: 12.4, lengthM: 5.8, widthM: 3.0, heightM: 2.9,
      diagM: 6.53, reuseRate: 0.14, corridorClearM: 2.45,
      hoistRadiusM: 30, craneCapacityT: 16.0,
      services: ['给水', '排水', '电气', '通风'],
      penetrations: ['DN110 排水立管', 'DN25 给水支管'],
      status: '已就位', designRevision: 'BIM-R7'
    },
    {
      id: 'M-1510', type: '厨房模块', floor: 15, zone: 'B',
      weightT: 15.9, lengthM: 6.4, widthM: 3.2, heightM: 2.9,
      diagM: 7.16, reuseRate: 0.14, corridorClearM: 2.45,
      hoistRadiusM: 34, craneCapacityT: 14.5,
      services: ['给水', '排水', '电气', '燃气', '通风'],
      penetrations: ['DN160 排水立管', 'DN25 给水支管', '燃气立管 DN50'],
      status: '待吊装', designRevision: 'BIM-R7'
    },
    {
      id: 'M-1511', type: '标准居室模块', floor: 15, zone: 'B',
      weightT: 11.2, lengthM: 6.0, widthM: 3.0, heightM: 2.9,
      diagM: 6.71, reuseRate: 0.28, corridorClearM: 2.45,
      hoistRadiusM: 26, craneCapacityT: 16.0,
      services: ['电气', '通风'],
      penetrations: ['JDG20 电气套管'],
      status: '待吊装', designRevision: 'BIM-R7'
    },
    {
      id: 'M-1601', type: '卫生间模块', floor: 16, zone: 'A',
      weightT: 12.5, lengthM: 5.8, widthM: 3.0, heightM: 3.4,
      diagM: 6.53, reuseRate: 0.14, corridorClearM: 2.45,
      hoistRadiusM: 30, craneCapacityT: 16.0,
      services: ['给水', '排水', '电气', '通风'],
      penetrations: ['DN110 排水立管'],
      status: '生产中', designRevision: 'BIM-R7'
    }
  ];

  /* MiC 拆分与运输规范约束（工具层据此判定，不硬编码在 Agent 提示里） */
  var MIC_RULES = {
    maxWidthM: 3.5,          // 公路运输限宽
    maxHeightM: 3.2,         // 含吊具净高
    maxLengthM: 12.0,
    maxWeightT: 16.0,        // 塔吊额定工况
    minCorridorClearM: 2.2,  // 模块运输通道净宽
    minReuseRate: 0.20,      // 标准化率下限
    maxDiagRatio: 1.30       // 对角线/长边 比，超限提示拼装刚度风险
  };

  /* ------------------------------------------------------------------ *
   * 2) C-SMART IoT：施工侧感知流
   * ------------------------------------------------------------------ */
  var IOT_SENSORS = [
    { id: 'TC-01', kind: '塔吊', label: '1# 塔吊', metrics: { loadT: 13.2, capacityT: 16.0, windMs: 6.2, radiusM: 34, swingDeg: 128 }, status: '运行' },
    { id: 'TC-02', kind: '塔吊', label: '2# 塔吊', metrics: { loadT: 10.4, capacityT: 12.0, windMs: 6.4, radiusM: 22, swingDeg: 64 }, status: '运行' },
    { id: 'ENV-01', kind: '环境', label: 'TSP 扬尘监测', metrics: { pm10: 118, pm25: 62, noiseDb: 71, tempC: 24, humidity: 58 }, status: '运行' },
    { id: 'ENV-02', kind: '环境', label: '基坑水位', metrics: { waterLevelM: 1.32, alarmM: 1.60 }, status: '运行' },
    { id: 'POS-01', kind: '人员定位', label: 'UWB 人员分布', metrics: { total: 86, inDangerZone: 3, towerCraneZone: 5, highWork: 7 }, status: '运行' },
    { id: 'STR-01', kind: '结构监测', label: 'C3 栋沉降', metrics: { settlementMm: 6.8, alarmMm: 12.0, tiltPermille: 0.9 }, status: '运行' },
    { id: 'CV-01', kind: '视频AI', label: '临边防护识别', metrics: { cameras: 12, openEdgeAlarms: 2, helmetViolations: 4 }, status: '运行' }
  ];

  /* 施工工序计划：实际进度 vs 计划进度
     时间轴口径：start/end 均为项目开工日算起的第 N 天，当前为第 46 天。
     predecessors 是真实业务约束（T-03 不可能早于 T-01 完成）。
     leadDays 表示工序"实际投入天数"与日历跨度的差值：MiC 吊装只有工作日
     可作业，5 天日历跨度实际只投入 3 天，所以计划完成率不能按日历天摊。
     schedule_predict 用 SPI 计算自身延期，再沿 predecessors 做级联。 */
  var SCHEDULE_TASKS = [
    { id: 'T-01', name: 'C3 栋 15 层 MiC 吊装', zone: 'C3-15F', start: 42, end: 47, leadDays: 3, planPercent: 100, actualPercent: 62, crew: 14, critical: true, predecessors: [] },
    { id: 'T-02', name: 'C3 栋 15 层机电接驳', zone: 'C3-15F', start: 47, end: 49, leadDays: 3, planPercent: 45, actualPercent: 18, crew: 8, critical: true, predecessors: ['T-01'] },
    { id: 'T-03', name: 'C3 栋 16 层模块进场', zone: 'C3-16F', start: 47, end: 50, leadDays: 3, planPercent: 10, actualPercent: 0, crew: 6, critical: false, predecessors: ['T-02'] },
    { id: 'T-04', name: 'B2 区幕墙龙骨安装', zone: 'B2', start: 42, end: 50, leadDays: 8, planPercent: 80, actualPercent: 74, crew: 10, critical: false, predecessors: [] },
    { id: 'T-05', name: '地下室防水验收', zone: 'B1', start: 40, end: 48, leadDays: 6, planPercent: 90, actualPercent: 90, crew: 4, critical: false, predecessors: [] }
  ];

  /* 资源与供应链 */
  var RESOURCES = {
    crews: [
      { id: 'CR-A', name: '吊装班组', trade: '起重', onSite: 14, needed: 16, certified: 12 },
      { id: 'CR-B', name: '机电班组', trade: '机电', onSite: 8, needed: 12, certified: 8 },
      { id: 'CR-C', name: '测量班组', trade: '测量', onSite: 4, needed: 4, certified: 4 }
    ],
    materials: [
      { id: 'MT-01', name: 'M-1508 模块', needBy: 46, eta: 46, status: '已到场' },
      { id: 'MT-02', name: 'M-1510 模块', needBy: 47, eta: 48, status: '运输中 · 延迟 1 天' },
      { id: 'MT-03', name: 'M-1511 模块', needBy: 48, eta: 48, status: '工厂待运' },
      { id: 'MT-04', name: 'DN110 HDPE 管件', needBy: 46, eta: 49, status: '延迟 3 天' }
    ],
    /* 吊装时段按 D<天>-<AM|PM> 命名，crane_plan 依此按日检索 */
    craneSlots: [
      { slot: 'D46-PM', crane: 'TC-01', from: 13, to: 18, assignedTo: 'T-01', status: '已占用' },
      { slot: 'D47-AM', crane: 'TC-01', from: 7, to: 12, assignedTo: null, status: '可用' },
      { slot: 'D47-PM', crane: 'TC-01', from: 13, to: 18, assignedTo: 'T-03', status: '已占用' },
      { slot: 'D47-PM', crane: 'TC-02', from: 13, to: 18, assignedTo: null, status: '可用' },
      { slot: 'D48-AM', crane: 'TC-01', from: 7, to: 12, assignedTo: null, status: '可用' }
    ]
  };

  /* ------------------------------------------------------------------ *
   * 3) BIPV：屋面光伏阵列
   * ------------------------------------------------------------------ */
  var BIPV_ARRAY = {
    capacityKwp: 420,
    strings: [
      { id: 'S-01', modules: 26, vocV: 612, iscA: 9.4, pmppW: 284, tempC: 51.2, irradiance: 742, expectedKwhDay: 118.0, actualKwhDay: 96.4, soilingLoss: 0.11, mismatchLoss: 0.03 },
      { id: 'S-02', modules: 26, vocV: 608, iscA: 9.2, pmppW: 276, tempC: 47.8, irradiance: 751, expectedKwhDay: 119.5, actualKwhDay: 118.1, soilingLoss: 0.03, mismatchLoss: 0.01 },
      { id: 'S-03', modules: 24, vocV: 566, iscA: 8.6, pmppW: 254, tempC: 49.1, irradiance: 748, expectedKwhDay: 110.2, actualKwhDay: 108.9, soilingLoss: 0.02, mismatchLoss: 0.01 },
      { id: 'S-04', modules: 26, vocV: 610, iscA: 9.3, pmppW: 281, tempC: 48.4, irradiance: 745, expectedKwhDay: 118.8, actualKwhDay: 116.2, soilingLoss: 0.03, mismatchLoss: 0.02 }
    ],
    inverters: [
      { id: 'INV-1', ratedKw: 110, loadKw: 71.6, efficiency: 0.975, tempC: 58, mpptStrings: ['S-01', 'S-02'], alarm: '直流侧组串 S-01 电流偏低 12%' },
      { id: 'INV-2', ratedKw: 110, loadKw: 74.3, efficiency: 0.981, tempC: 52, mpptStrings: ['S-03', 'S-04'], alarm: null }
    ],
    // 清洁与维修的历史工单，供 RAG 检索故障先例
    history: [
      { date: '2026-08-28', event: 'S-01 组串电流偏低，清洗后恢复 6%', cause: '积灰(周边塔吊作业扬尘)' },
      { date: '2026-07-15', event: 'INV-2 报过温停机', cause: '逆变器室通风滤网堵塞' }
    ]
  };

  /* ------------------------------------------------------------------ *
   * 4) 安全：多模态巡检事件流
   * ------------------------------------------------------------------ */
  var SAFETY_EVENTS = [
    { id: 'SE-01', at: '2026-09-19T09:12', zone: 'C3-15F 东侧临边', type: '临边防护缺失', severity: '高', source: 'CV-01', confidence: 0.91, workers: ['W-1042'] },
    { id: 'SE-02', at: '2026-09-19T10:04', zone: 'C3-15F 吊装区', type: '未佩戴安全帽', severity: '中', source: 'CV-01', confidence: 0.87, workers: ['W-2210'] },
    { id: 'SE-03', at: '2026-09-19T11:35', zone: 'C3-15F 吊装区', type: '人员进入吊装半径', severity: '高', source: 'POS-01', confidence: 0.99, workers: ['W-2210', 'W-3301', 'W-3312'] },
    { id: 'SE-04', at: '2026-09-18T15:20', zone: 'C3-15F 东侧临边', type: '临边防护缺失', severity: '高', source: 'CV-01', confidence: 0.89, workers: [] },
    { id: 'SE-05', at: '2026-09-19T08:40', zone: 'B1 地下室', type: '临时用电箱未关门', severity: '低', source: 'CV-01', confidence: 0.76, workers: [] }
  ];

  var WORKERS = [
    { id: 'W-1042', name: '张海', trade: '钢筋工', crew: 'CR-A', certs: ['高处作业'], trainingHours: 12, daysOnSite: 46, riskScore: 62 },
    { id: 'W-2210', name: '李建军', trade: '起重信号工', crew: 'CR-A', certs: ['起重指挥'], trainingHours: 24, daysOnSite: 88, riskScore: 44 },
    { id: 'W-3301', name: '王秀兰', trade: '机电安装', crew: 'CR-B', certs: [], trainingHours: 6, daysOnSite: 12, riskScore: 71 },
    { id: 'W-3312', name: '陈志远', trade: '机电安装', crew: 'CR-B', certs: ['低压电工'], trainingHours: 18, daysOnSite: 30, riskScore: 38 }
  ];

  /* ------------------------------------------------------------------ *
   * 5) 缺陷与整改闭环台账
   * ------------------------------------------------------------------ */
  var DEFECT_LEDGER = [
    { id: 'DF-101', module: 'M-1509', kind: '预埋套管偏位', severity: '中', openedDay: 45, status: '整改中', owner: 'CR-B', evidence: ['照片 2 张'], slaDays: 2 },
    { id: 'DF-102', module: 'M-1508', kind: '模块拼缝密封不到位', severity: '高', openedDay: 46, status: '待派单', owner: null, evidence: [], slaDays: 1 },
    { id: 'DF-103', module: 'M-1510', kind: '吊点标识缺失', severity: '低', openedDay: 45, status: '已关闭', owner: 'CR-A', evidence: ['照片 4 张', '复验签字'], slaDays: 3 }
  ];

  root.JR_DATA = {
    PROJECT: PROJECT,
    MIC_MODULES: MIC_MODULES,
    MIC_RULES: MIC_RULES,
    IOT_SENSORS: IOT_SENSORS,
    SCHEDULE_TASKS: SCHEDULE_TASKS,
    RESOURCES: RESOURCES,
    BIPV_ARRAY: BIPV_ARRAY,
    SAFETY_EVENTS: SAFETY_EVENTS,
    WORKERS: WORKERS,
    DEFECT_LEDGER: DEFECT_LEDGER
  };
})(typeof window !== 'undefined' ? window : globalThis);
