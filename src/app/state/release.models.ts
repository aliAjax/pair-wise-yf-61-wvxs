export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'failed' | 'stabilized' | 'completed' | 'rolled_back';

export type DeviceModelId = 'edge-gateway' | 'plant-terminal' | 'clinic-terminal';

export type StepKind = 'firmware' | 'bootloader';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
  model: DeviceModelId;
  /** 换过主板、需要先补引导程序的网关数量 */
  replacedBoards: number;
}

export interface RouteStep {
  version: string;
  kind: StepKind;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  currentVersion: string;
  rollbackVersion: string;
  groupId: string;
  model: DeviceModelId;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  progress: number;
  downloaded: number;
  failed: number;
  /** 设备已经刷到的版本（失败/暂停后重试的起点） */
  reachedVersion?: string;
  /** 按版本谱系算出的升级路线 */
  route: RouteStep[];
  /** 路线缺失时指名缺的版本 */
  routeMissing?: string;
  routeValid: boolean;
  updatedAt: string;
}

/** 固件仓库中的版本依赖关系：version 依赖 requires（刷 version 前必须先到 requires） */
export interface FirmwareDependency {
  id: string;
  model: DeviceModelId;
  version: string;
  requires: string;
  kind: StepKind;
  stable: boolean;
  /** 乐观并发控制：后保存的值班员会看到 revision 冲突 */
  revision: number;
  updatedAt: string;
}

export interface DependencyConflict {
  dependencyId: string;
  model: DeviceModelId;
  version: string;
  expectedRevision: number;
  actualRevision: number;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  dependencies: FirmwareDependency[];
  conflict: DependencyConflict | null;
  audits: AuditEntry[];
}
