import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  addDependency,
  approveBatch,
  clearConflict,
  createBatch,
  pauseBatch,
  removeDependency,
  resumeBatch,
  retryBatch,
  rollbackBatch,
  simulateConcurrentEdit,
  telemetryTick,
  updateDependency
} from './state/release.actions';
import { selectAudits, selectBatches, selectConflict, selectDependencies, selectGroups } from './state/release.selectors';
import type { DeviceGroup, DeviceModelId, FirmwareDependency, ReleaseBatch } from './state/release.models';
import { computeRoute } from './state/firmware.route';

const MODEL_LABELS: Record<DeviceModelId, string> = {
  'edge-gateway': '边缘网关',
  'plant-terminal': '工业采集终端',
  'clinic-terminal': '远程诊疗终端'
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, MatCheckboxModule, MatIconModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>路线按版本谱系计算</mat-chip><mat-chip>缺环节退回草稿</mat-chip><mat-chip>失败可重试</mat-chip><mat-chip>依赖冲突可见</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ (groups$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停 / 失败</span><strong>{{ pausedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>谱系依赖</span><strong>{{ (dependencies$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field class="span-2"><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>当前版本</mat-label><input matInput [(ngModel)]="draft.currentVersion"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label>
              <mat-select [(ngModel)]="draft.groupId">
                <mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">
                  {{ group.name }} · {{ group.region }} · {{ modelLabel(group.model) }}
                </mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <div class="route-preview span-2" [class.missing]="!preview.valid">
              <ng-container *ngIf="preview.valid; else missingPreview">
                <span class="route-title">升级路线（{{ modelLabel(previewModel) }}）：</span>
                <span class="route-chain">
                  <ng-container *ngFor="let step of preview.steps; let last = last">
                    <mat-chip [class.bootloader]="step.kind === 'bootloader'" highlighted>{{ step.kind === 'bootloader' ? '引导 ' + step.version : step.version }}</mat-chip>
                    <span *ngIf="!last" class="arrow">→</span>
                  </ng-container>
                  <span *ngIf="preview.steps.length === 0" class="arrow">已是目标版本</span>
                </span>
                <small *ngIf="previewBootloader">该分组有 {{ previewReplacedBoards }} 台换过主板的网关，路线含引导程序步骤</small>
              </ng-container>
              <ng-template #missingPreview>
                <strong>缺少过渡版本 {{ preview.missing }}，创建后将退回草稿</strong>
                <small>请先在下方固件仓库补全 {{ preview.missing }} 的前置依赖，或改选目标版本</small>
              </ng-template>
            </div>
            <button mat-flat-button color="primary" class="span-2" (click)="create()">创建批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="176" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row">
                  <div><b>{{ batch.name }}</b><small>{{ batch.currentVersion }} → {{ batch.firmware }} · 回滚 {{ batch.rollbackVersion }} · {{ modelLabel(batch.model) }}</small></div>
                  <mat-chip [highlighted]="batch.status !== 'draft'" [color]="statusColor(batch.status)">{{ statusLabel(batch.status) }}</mat-chip>
                </div>
                <div class="route-line" *ngIf="batch.routeValid">
                  <mat-chip-set>
                    <ng-container *ngFor="let step of batch.route; let last = last">
                      <mat-chip [class.bootloader]="step.kind === 'bootloader'">{{ step.kind === 'bootloader' ? '引导 ' + step.version : step.version }}</mat-chip>
                      <span *ngIf="!last" class="arrow">→</span>
                    </ng-container>
                  </mat-chip-set>
                </div>
                <div class="route-line missing" *ngIf="!batch.routeValid">
                  <mat-chip color="warn" highlighted>缺少过渡版本 {{ batch.routeMissing }}</mat-chip>
                  <small>路线不完整，批次保持草稿；补全依赖后重新审批</small>
                </div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.downloaded }} 台已更新 · 失败 {{ batch.failed }}<ng-container *ngIf="batch.reachedVersion"> · 已到达 {{ batch.reachedVersion }}</ng-container></span><span>{{ batch.progress }}%</span></div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button color="accent" *ngIf="batch.status === 'paused' || batch.status === 'failed'" (click)="retry(batch.id)">重试（从 {{ batch.reachedVersion ?? batch.currentVersion }}）</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back' || batch.status === 'stabilized'" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>固件仓库 · 版本依赖谱系</mat-card-title></mat-card-header>
        <mat-card-content>
          <div class="dep-form">
            <mat-form-field><mat-label>机型</mat-label>
              <mat-select [(ngModel)]="depDraft.model"><mat-option *ngFor="let model of modelIds" [value]="model">{{ modelLabel(model) }}</mat-option></mat-select>
            </mat-form-field>
            <mat-form-field><mat-label>版本</mat-label><input matInput [(ngModel)]="depDraft.version" placeholder="如 3.0.0"></mat-form-field>
            <mat-form-field><mat-label>前置版本</mat-label><input matInput [(ngModel)]="depDraft.requires" placeholder="如 2.8.1，出厂基线留空"></mat-form-field>
            <mat-form-field><mat-label>类型</mat-label>
              <mat-select [(ngModel)]="depDraft.kind"><mat-option value="firmware">过渡固件</mat-option><mat-option value="bootloader">引导程序</mat-option></mat-select>
            </mat-form-field>
            <mat-checkbox [(ngModel)]="depDraft.stable">稳定版本</mat-checkbox>
            <button mat-flat-button color="primary" (click)="addDep()">新增依赖</button>
          </div>

          <div class="conflict-banner" *ngIf="conflict$ | async as conflict">
            <mat-icon>warning</mat-icon>
            <span>冲突：{{ modelLabel(conflict.model) }} {{ conflict.version }} 的依赖基于修订 {{ conflict.expectedRevision }} 修改，但当前已是修订 {{ conflict.actualRevision }}，后保存的修改未生效。</span>
            <button mat-stroked-button (click)="reloadConflict()">重新加载</button>
          </div>

          <table mat-table [dataSource]="(dependencies$ | async) ?? []" class="dep-table">
            <ng-container matColumnDef="model">
              <th mat-header-cell *matHeaderCellDef>机型</th>
              <td mat-cell *matCellDef="let dep">{{ modelLabel(dep.model) }}</td>
            </ng-container>
            <ng-container matColumnDef="version">
              <th mat-header-cell *matHeaderCellDef>版本</th>
              <td mat-cell *matCellDef="let dep">
                <ng-container *ngIf="editingId !== dep.id">{{ dep.version }} <mat-chip *ngIf="dep.stable" class="stable-chip">稳定</mat-chip></ng-container>
                <input *ngIf="editingId === dep.id" matInput [(ngModel)]="editDraft.version" class="edit-input">
              </td>
            </ng-container>
            <ng-container matColumnDef="requires">
              <th mat-header-cell *matHeaderCellDef>前置依赖</th>
              <td mat-cell *matCellDef="let dep">
                <ng-container *ngIf="editingId !== dep.id">{{ dep.kind === 'bootloader' ? '引导 ' : '' }}{{ dep.requires || '出厂基线' }}</ng-container>
                <input *ngIf="editingId === dep.id" matInput [(ngModel)]="editDraft.requires" class="edit-input">
              </td>
            </ng-container>
            <ng-container matColumnDef="kind">
              <th mat-header-cell *matHeaderCellDef>类型</th>
              <td mat-cell *matCellDef="let dep">
                <ng-container *ngIf="editingId !== dep.id"><mat-chip [class.bootloader]="dep.kind === 'bootloader'" highlighted>{{ dep.kind === 'bootloader' ? '引导程序' : '过渡固件' }}</mat-chip></ng-container>
                <mat-select *ngIf="editingId === dep.id" [(ngModel)]="editDraft.kind" class="edit-select"><mat-option value="firmware">过渡固件</mat-option><mat-option value="bootloader">引导程序</mat-option></mat-select>
              </td>
            </ng-container>
            <ng-container matColumnDef="revision">
              <th mat-header-cell *matHeaderCellDef>修订</th>
              <td mat-cell *matCellDef="let dep">r{{ dep.revision }}<small *ngIf="editingId === dep.id" class="base-rev">基线 r{{ editBaseRevision }}</small></td>
            </ng-container>
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef class="actions-col">操作</th>
              <td mat-cell *matCellDef="let dep" class="actions-col">
                <ng-container *ngIf="editingId !== dep.id">
                  <button mat-stroked-button (click)="startEdit(dep)">编辑</button>
                  <button mat-stroked-button color="warn" (click)="removeDep(dep)">删除</button>
                  <button mat-button (click)="simulateOther(dep)">模拟他人并发修改</button>
                </ng-container>
                <ng-container *ngIf="editingId === dep.id">
                  <button mat-flat-button color="primary" (click)="saveEdit(dep)">保存</button>
                  <button mat-button (click)="cancelEdit()">取消</button>
                </ng-container>
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="depColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: depColumns;"></tr>
          </table>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; flex-wrap:wrap; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(320px,.8fr) minmax(460px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .span-2 { grid-column:1 / -1; }
    .route-preview { border:1px dashed #2a9d8f; border-radius:8px; padding:10px 12px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; } .route-preview.missing { border-color:#c62828; background:#fff5f5; flex-direction:column; align-items:flex-start; }
    .route-title { color:#607d86; font-size:13px; } .route-chain { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; } .arrow { color:#607d86; } .route-preview small { color:#71858c; }
    .viewport { height:560px; } .batch { min-height:168px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:8px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .route-line { display:flex; align-items:center; flex-wrap:wrap; gap:4px; } .route-line.missing { flex-direction:column; align-items:flex-start; }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    .dep-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; align-items:center; margin-bottom:16px; }
    .dep-table { width:100%; } .actions-col { white-space:nowrap; } .edit-input { width:100%; padding:4px 6px; } .edit-select { width:100%; } .base-rev { margin-left:6px; color:#c62828; }
    .stable-chip { margin-left:6px; } .bootloader { --mdc-chip-elevated-container-color:#fff3e0; --mdc-chip-label-text-color:#e65100; }
    .conflict-banner { display:flex; align-items:center; gap:10px; background:#fff5f5; border:1px solid #c62828; border-radius:8px; padding:10px 12px; margin-bottom:12px; color:#b71c1c; }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly dependencies$ = this.store.select(selectDependencies);
  readonly conflict$ = this.store.select(selectConflict);
  private timer?: number;

  readonly modelIds: DeviceModelId[] = ['edge-gateway', 'plant-terminal', 'clinic-terminal'];
  draft = { name: '', firmware: '3.0.0', currentVersion: '2.7.9', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };
  depDraft: { model: DeviceModelId; version: string; requires: string; kind: 'firmware' | 'bootloader'; stable: boolean } = {
    model: 'edge-gateway', version: '', requires: '', kind: 'firmware', stable: false
  };

  editingId: string | null = null;
  editDraft: { version: string; requires: string; kind: 'firmware' | 'bootloader' } = { version: '', requires: '', kind: 'firmware' };
  editBaseRevision = 0;
  readonly depColumns = ['model', 'version', 'requires', 'kind', 'revision', 'actions'];

  private groupsCache: DeviceGroup[] = [];
  private depsCache: FirmwareDependency[] = [];

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectGroups).subscribe((groups) => this.groupsCache = groups);
    this.store.select(selectDependencies).subscribe((deps) => this.depsCache = deps);
    this.store.select(selectBatches).subscribe((batches) =>
      localStorage.setItem('firmware-release-v2', JSON.stringify({
        groups: this.groupsCache, batches, dependencies: this.depsCache,
        conflict: this.snapshotConflict(), audits: this.snapshotAudits()
      }))
    );
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  modelLabel(model: DeviceModelId): string { return MODEL_LABELS[model]; }

  get previewModel(): DeviceModelId {
    return this.groupsCache.find((group) => group.id === this.draft.groupId)?.model ?? 'edge-gateway';
  }
  get previewBootloader(): boolean {
    return (this.groupsCache.find((group) => group.id === this.draft.groupId)?.replacedBoards ?? 0) > 0;
  }
  get previewReplacedBoards(): number {
    return this.groupsCache.find((group) => group.id === this.draft.groupId)?.replacedBoards ?? 0;
  }
  get preview() {
    return computeRoute(this.depsCache, this.previewModel, this.draft.currentVersion, this.draft.firmware, this.previewBootloader);
  }

  pausedCount() {
    let count = 0;
    this.batches$.subscribe((items) => count = items.filter((item) => item.status === 'paused' || item.status === 'failed').length);
    return count;
  }

  statusColor(status: ReleaseBatch['status']): string {
    if (status === 'running' || status === 'completed') return 'primary';
    if (status === 'paused' || status === 'failed' || status === 'rolled_back') return 'warn';
    return 'accent';
  }
  statusLabel(status: ReleaseBatch['status']): string {
    return { draft: '草稿', approved: '已审批', running: '发布中', paused: '已暂停', failed: '已失败', stabilized: '已回稳', completed: '已完成', rolled_back: '已回滚' }[status];
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const group = this.groupsCache.find((item) => item.id === this.draft.groupId);
    const batch: ReleaseBatch = {
      ...this.draft,
      id: crypto.randomUUID(),
      model: group?.model ?? 'edge-gateway',
      status: 'draft', progress: 0, downloaded: 0, failed: 0,
      route: [], routeValid: false,
      updatedAt: new Date().toISOString()
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }

  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  retry(id: string) { this.store.dispatch(retryBatch({ id, actor: '值班人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }

  addDep() {
    if (!this.depDraft.version) return;
    const dependency: FirmwareDependency = {
      id: crypto.randomUUID(),
      model: this.depDraft.model,
      version: this.depDraft.version.trim(),
      requires: this.depDraft.requires.trim(),
      kind: this.depDraft.kind,
      stable: this.depDraft.stable,
      revision: 1,
      updatedAt: new Date().toISOString()
    };
    this.store.dispatch(addDependency({ dependency, actor: '运维值班' }));
    this.depDraft = { ...this.depDraft, version: '', requires: '', stable: false };
  }

  startEdit(dep: FirmwareDependency) {
    this.editingId = dep.id;
    this.editBaseRevision = dep.revision;
    this.editDraft = { version: dep.version, requires: dep.requires, kind: dep.kind };
  }
  cancelEdit() { this.editingId = null; }
  saveEdit(dep: FirmwareDependency) {
    this.store.dispatch(updateDependency({
      id: dep.id,
      changes: { version: this.editDraft.version.trim(), requires: this.editDraft.requires.trim(), kind: this.editDraft.kind },
      baseRevision: this.editBaseRevision,
      actor: '值班员甲'
    }));
    this.editingId = null;
  }
  removeDep(dep: FirmwareDependency) { this.store.dispatch(removeDependency({ id: dep.id, actor: '运维值班' })); }
  simulateOther(dep: FirmwareDependency) { this.store.dispatch(simulateConcurrentEdit({ id: dep.id, actor: '值班员乙' })); }
  reloadConflict() { this.store.dispatch(clearConflict()); this.editingId = null; }

  private snapshotGroups() { let value: unknown; this.groups$.subscribe((items) => value = items); return value; }
  private snapshotAudits() { let value: unknown; this.audits$.subscribe((items) => value = items); return value; }
  private snapshotConflict() { let value: unknown; this.conflict$.subscribe((items) => value = items); return value; }
}
