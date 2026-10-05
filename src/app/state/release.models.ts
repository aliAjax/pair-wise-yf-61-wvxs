export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/** 固件版本性质：稳定版可作为落脚点；过渡版只用于跨大版本；引导程序用于换主板网关补引导 */
export type FirmwareKind = 'stable' | 'transitional' | 'bootloader';

export type RouteStatus =
  | 'planned'   // 草稿中已规划，尚未下发
  | 'ready'     // 随批次审批，待下发
  | 'running'   // 下发中
  | 'paused'    // 随批次暂停
  | 'failed'    // 某一步失败，停在 reachedVersion，等待重试替代路线
  | 'blocked'   // 谱系缺环节，批次退回草稿
  | 'done'      // 已刷到目标版本，结果冻结保留
  | 'rescued'   // 失败后经替代路线回到稳定版本，结果冻结保留
  | 'rolled_back';

export type StepStatus = 'pending' | 'flashing' | 'done' | 'failed';

export interface FirmwareNode {
  modelId: string;
  version: string;
  kind: FirmwareKind;
  /** 允许从哪些版本直接刷到本版本（谱系边的源头）；解析不到的引用即为仓库缺失环节 */
  prerequisites: string[];
  /** 该版本依赖关系（prerequisites）的修订号，用于两名值班员并发编辑时的乐观锁 */
  prereqRevision: number;
  /** 最近一次修改依赖关系的值班员，冲突时指名先到者 */
  lastEditor?: string;
}

export interface DeviceModel {
  id: string;
  name: string;
  category: 'gateway' | 'terminal';
  /** 网关机型换过主板后必须先补引导程序 */
  needsBootloader: boolean;
}

export interface ModelFleet {
  modelId: string;
  /** 该分组内此机型当前所处版本（路线起点） */
  currentVersion: string;
  count: number;
  /** 这批设备是否换过主板 */
  boardReplaced: boolean;
}

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  compatible: boolean;
  fleet: ModelFleet[];
}

export interface RouteStep {
  id: string;
  toVersion: string;
  kind: FirmwareKind;
  status: StepStatus;
}

export interface UpgradeRoute {
  /** 分组内唯一：${groupId}::${modelId} */
  id: string;
  modelId: string;
  modelName: string;
  deviceCount: number;
  boardReplaced: boolean;

  fromVersion: string;
  /** 已经刷到的固件版本（不含引导步骤），失败重试从这里另找路 */
  reachedVersion: string;
  targetVersion: string;
  rollbackVersion: string;

  steps: RouteStep[];
  status: RouteStatus;
  /** 走不通时指名道姓的缺失环节（"机型@版本（被 X 引用但仓库缺失）"） */
  blockingGaps: string[];
  /** 失败过的边 "from->to"，重试找替代路线时避开 */
  failedEdges: string[];
  rescue: boolean;

  /** 规划时依据的依赖谱系修订号，依赖一改即失效 */
  planRevision: number;
  updatedAt: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  routes: UpgradeRoute[];
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface EditConflict {
  nodeKey: string;
  /** 后到的提交者 */
  actor: string;
  /** 先到的提交者 */
  winner: string;
  baseRevision: number;
  currentRevision: number;
  message: string;
}

export interface RevisionNote {
  nodeKey: string;
  actor: string;
  at: string;
  revision: number;
}

export interface ReleaseState {
  models: DeviceModel[];
  groups: DeviceGroup[];
  firmware: FirmwareNode[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
  /** 依赖谱系整体修订号，每次成功编辑递增 */
  graphRevision: number;
  conflict: EditConflict | null;
  lastRevisionNote: RevisionNote | null;
}
