import type { DeviceGroup, DeviceModel, FirmwareNode } from './release.models';

/**
 * 固件仓库：按机型组织的版本谱系（DAG）。
 * prerequisites = 允许"直接从哪些版本刷到本版本"。
 * 跨大版本必须经过过渡版（边不直达）；换主板网关要先补引导程序节点。
 * 缺失环节：prerequisites 引用了仓库里不存在的版本。
 */
export const SEED_MODELS: DeviceModel[] = [
  { id: 'gw-e300', name: '边缘网关 E300', category: 'gateway', needsBootloader: true },
  { id: 'gw-x100', name: '边缘网关 X100（老机型）', category: 'gateway', needsBootloader: true },
  { id: 'term-t20', name: '工业采集终端 T20', category: 'terminal', needsBootloader: false },
  { id: 'term-clinic', name: '远程诊疗终端 C8', category: 'terminal', needsBootloader: false }
];

export const SEED_GROUPS: DeviceGroup[] = [
  {
    id: 'g-edge', name: '华东边缘网关', region: '华东', compatible: true,
    fleet: [
      { modelId: 'gw-e300', currentVersion: '2.8.1', count: 420, boardReplaced: false },
      { modelId: 'gw-x100', currentVersion: '2.4.0', count: 260, boardReplaced: true }
    ]
  },
  {
    id: 'g-plant', name: '工业采集终端', region: '华南', compatible: false,
    fleet: [
      { modelId: 'term-t20', currentVersion: '1.6.0', count: 1240, boardReplaced: false }
    ]
  },
  {
    id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', compatible: true,
    fleet: [
      { modelId: 'term-clinic', currentVersion: '3.2.1', count: 310, boardReplaced: false }
    ]
  }
];

export const SEED_FIRMWARE: FirmwareNode[] = [
  // ---- 边缘网关 E300 ----
  { modelId: 'gw-e300', version: '2.7.0', kind: 'stable', prerequisites: ['2.6.2'], prereqRevision: 1 },
  { modelId: 'gw-e300', version: '2.7.9', kind: 'stable', prerequisites: ['2.7.0', '2.8.1'], prereqRevision: 1 },
  { modelId: 'gw-e300', version: '2.8.1', kind: 'stable', prerequisites: ['2.7.9'], prereqRevision: 1 },
  // 2.x 不能直升 3.x，必须先刷过渡版；2.9.0 与 2.9.1 是两条并行过渡通道，一条失败可改走另一条
  { modelId: 'gw-e300', version: '2.9.0', kind: 'transitional', prerequisites: ['2.8.1'], prereqRevision: 1 },
  { modelId: 'gw-e300', version: '2.9.1', kind: 'transitional', prerequisites: ['2.8.1'], prereqRevision: 1 },
  { modelId: 'gw-e300', version: '3.0.0', kind: 'stable', prerequisites: ['2.9.0', '2.9.1'], prereqRevision: 1 },
  { modelId: 'gw-e300', version: '3.1.2', kind: 'stable', prerequisites: ['3.0.0', '3.1.0'], prereqRevision: 1 },
  { modelId: 'gw-e300', version: 'boot-1.4', kind: 'bootloader', prerequisites: [], prereqRevision: 1 },

  // ---- 边缘网关 X100（老机型，跨度更大）----
  { modelId: 'gw-x100', version: '2.4.0', kind: 'stable', prerequisites: ['2.3.5'], prereqRevision: 1 },
  { modelId: 'gw-x100', version: '2.6.0', kind: 'transitional', prerequisites: ['2.4.0'], prereqRevision: 1 },
  { modelId: 'gw-x100', version: '2.8.2', kind: 'stable', prerequisites: ['2.6.0'], prereqRevision: 1 },
  { modelId: 'gw-x100', version: '2.9.1', kind: 'transitional', prerequisites: ['2.8.2'], prereqRevision: 1 },
  { modelId: 'gw-x100', version: '3.0.0', kind: 'stable', prerequisites: ['2.9.1'], prereqRevision: 1 },
  { modelId: 'gw-x100', version: '3.1.2', kind: 'stable', prerequisites: ['3.0.0'], prereqRevision: 1 },
  // 3.2.0 是目标稳定版，但它的前置过渡版 3.1.9 尚未入库 —— 故意制造"缺环节"
  { modelId: 'gw-x100', version: '3.2.0', kind: 'stable', prerequisites: ['3.1.9'], prereqRevision: 1 },
  { modelId: 'gw-x100', version: 'boot-1.2', kind: 'bootloader', prerequisites: [], prereqRevision: 1 },

  // ---- 工业采集终端 T20 ----
  { modelId: 'term-t20', version: '1.6.0', kind: 'stable', prerequisites: ['1.5.4'], prereqRevision: 1 },
  { modelId: 'term-t20', version: '1.8.0', kind: 'transitional', prerequisites: ['1.6.0'], prereqRevision: 1 },
  { modelId: 'term-t20', version: '2.0.0', kind: 'stable', prerequisites: ['1.8.0'], prereqRevision: 1 },
  { modelId: 'term-t20', version: '2.1.3', kind: 'stable', prerequisites: ['2.0.0'], prereqRevision: 1 },

  // ---- 远程诊疗终端 C8 ----
  { modelId: 'term-clinic', version: '3.2.1', kind: 'stable', prerequisites: ['3.2.0'], prereqRevision: 1 },
  { modelId: 'term-clinic', version: '3.3.0', kind: 'stable', prerequisites: ['3.2.1'], prereqRevision: 1 },
  // 3.4.0 的前置 3.3.5 未入库，是悬空引用；但 3.4.2 还可从 3.3.0 直达，不应误报为阻塞缺口
  { modelId: 'term-clinic', version: '3.4.0', kind: 'stable', prerequisites: ['3.3.5'], prereqRevision: 1 },
  { modelId: 'term-clinic', version: '3.4.2', kind: 'stable', prerequisites: ['3.3.0', '3.4.0'], prereqRevision: 1 }
];
