import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
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
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  approveBatch, createBatch, dismissConflict, pauseBatch, replanRoute,
  resumeBatch, retryRoute, rollbackBatch, simulateConcurrentEdit, telemetryTick, updatePrerequisites
} from './state/release.actions';
import {
  blockedRoutes, firmwareForModel, routeStatusLabel,
  selectAudits, selectBatches, selectConflict, selectFirmware,
  selectGraphRevision, selectGroups, selectModels
} from './state/release.selectors';
import type { FirmwareNode, ReleaseState, RouteStep, UpgradeRoute } from './state/release.models';

type RootState = { release: ReleaseState };

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule,
    MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule,
    MatIconModule, MatTooltipModule, TranslocoPipe
  ],
  template: `
    <header class="hero">
      <div>
        <span class="eyebrow">OTA CONTROL · 版本谱系规划</span>
        <h1>{{ 'title' | transloco }}</h1>
        <p>按固件仓库谱系为每种机型计算过渡路线；缺环节退回草稿；失败可从已到版本另找回稳路线</p>
      </div>
      <mat-chip-set>
        <mat-chip highlighted>谱系修订 r{{ graphRevision() }}</mat-chip>
        <mat-chip>缺环节 {{ blockedCount() }}</mat-chip>
        <mat-chip>失败待重试 {{ failedCount() }}</mat-chip>
      </mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>机型路线</span><strong>{{ routeCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>缺环节/失败</span><strong>{{ blockedCount() }} / {{ failedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      @if (conflict(); as conflict) {
        <section class="conflict-banner" role="alert">
          <div class="conflict-text">
            <b>⚠ 依赖关系并发冲突</b>
            <p>{{ conflict.message }}</p>
            <small>节点 {{ conflict.nodeKey }}：你基于第 {{ conflict.baseRevision }} 版，仓库当前为第 {{ conflict.currentRevision }} 版</small>
          </div>
          <button mat-flat-button color="primary" (click)="refreshEditorBaseline(); store.dispatch(dismissConflict())">
            刷新为最新依赖后再改
          </button>
        </section>
      }

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label>
              <mat-select [(ngModel)]="draft.groupId" (ngModelChange)="onGroupChange($event)">
                @for (group of groups$ | async; track group.id) {
                  <mat-option [value]="group.id" [disabled]="!group.compatible">
                    {{ group.name }} · {{ group.region }}（{{ group.fleet.length }} 种机型{{ group.compatible ? '' : '·不兼容' }}）
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label>
              <input matInput [(ngModel)]="draft.firmware" placeholder="例如 3.1.2">
            </mat-form-field>
            <mat-form-field><mat-label>回滚稳定版</mat-label>
              <input matInput [(ngModel)]="draft.rollbackVersion" placeholder="例如 2.8.1">
            </mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <p class="hint">系统会按分组内每种机型各自的当前版本和谱系分别算路；任一机型缺环节，整个批次留在草稿。</p>
            <button mat-flat-button color="primary" (click)="create()">规划路线并创建批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="repo-panel">
          <mat-card-header>
            <mat-card-title>固件仓库 · 依赖关系</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <div class="repo-form">
              <mat-form-field class="actor-field">
                <mat-label>当前值班员</mat-label>
                <mat-select [(ngModel)]="actor">
                  <mat-option value="值班员-甲">值班员-甲（夜班 A 角）</mat-option>
                  <mat-option value="值班员-乙">值班员-乙（夜班 B 角）</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>机型</mat-label>
                <mat-select [ngModel]="editorModel()" (ngModelChange)="onModelChange($event)">
                  @for (model of models$ | async; track model.id) {
                    <mat-option [value]="model.id">{{ model.name }}{{ model.needsBootloader ? '（需引导程序）' : '' }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>版本节点</mat-label>
                <mat-select [ngModel]="editorVersion()" (ngModelChange)="onNodeChange($event)">
                  @for (node of editorNodes(); track node.version) {
                    <mat-option [value]="node.version">
                      {{ node.version }} · {{ kindLabel(node.kind) }} · r{{ node.prereqRevision }}
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field class="full">
                <mat-label>可直接刷入的前置版本（逗号分隔，即本节点的入边）</mat-label>
                <input matInput [ngModel]="editorPrereqText()" (ngModelChange)="editorPrereqText.set($event)"
                       [disabled]="!editorNode()" placeholder="例如：2.9.0, 2.9.1">
              </mat-form-field>
              <div class="repo-meta" *ngIf="editorNode() as node">
                <span>当前修订 r{{ node.prereqRevision }}</span>
                <span *ngIf="node.lastEditor">最近修改：{{ node.lastEditor }}</span>
                <span class="baseline">提交基线 r{{ editorBaseRevision() }}（他人先提交即冲突）</span>
              </div>
              <button mat-flat-button color="primary" [disabled]="!editorNode()" (click)="savePrerequisites()">
                修改依赖并重算未下发路线
              </button>
              <button mat-stroked-button color="accent" [disabled]="!editorNode()" class="full"
                      (click)="simulateOtherEditor()">
                🕑 模拟对班值班员（{{ actor === '值班员-甲' ? '值班员-乙' : '值班员-甲' }}）先一步提交此节点
              </button>
            </div>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined" class="batch-panel">
        <mat-card-header><mat-card-title>{{ 'batches' | transloco }}（每机型一条路线）</mat-card-title></mat-card-header>
        <mat-card-content>
          <cdk-virtual-scroll-viewport itemSize="286" class="viewport">
            <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
              <header class="batch-head">
                <div>
                  <b>{{ batch.name }}</b>
                  <small>目标 {{ batch.firmware }} · 回滚 {{ batch.rollbackVersion }} · 灰度 {{ batch.rolloutPercent }}% · 阈值 {{ batch.failureThreshold }}%</small>
                </div>
                <mat-chip [color]="batchStatusColor(batch.status)" highlighted>{{ batchStatusLabel(batch.status) }}</mat-chip>
              </header>

              <div class="routes">
                @for (route of batch.routes; track route.id) {
                  <section class="route" [class.blocked]="route.status === 'blocked'" [class.failed]="route.status === 'failed'">
                    <div class="route-head">
                      <b>{{ route.modelName }}</b>
                      <small>{{ route.deviceCount }} 台 · 起点 {{ route.fromVersion }}
                        · 已到 <b class="reached">{{ route.reachedVersion }}</b>{{ route.boardReplaced ? ' · 换过主板' : '' }}</small>
                      <span class="spacer"></span>
                      <mat-chip [color]="routeStatusColor(route.status)" highlighted>{{ routeStatusLabel(route.status) }}</mat-chip>
                    </div>

                    <div class="chain">
                      <span class="chain-node start">{{ route.fromVersion }}</span>
                      @for (step of route.steps; track step.id) {
                        <span class="arrow" [class.boot]="step.kind === 'bootloader'">→</span>
                        <span class="chain-node" [class]="stepClass(step)" [matTooltip]="stepKindLabel(step)">
                          {{ step.toVersion }}
                          <i class="step-mark">{{ stepMark(step) }}</i>
                        </span>
                      }
                    </div>

                    @if (route.status === 'blocked') {
                      <div class="gaps">
                        <b>缺环节，批次退回草稿：</b>
                        <ul><li *ngFor="let gap of route.blockingGaps">{{ gap }}</li></ul>
                      </div>
                    } @else if (route.failedEdges.length) {
                      <div class="failed-edges">失败边：<code *ngFor="let edge of route.failedEdges">{{ edge }} </code>（重试时避开）</div>
                    } @else if (route.rescue && (route.status === 'rescued' || route.status === 'running')) {
                      <div class="rescue-note">已切换替代路线，回到稳定版本</div>
                    }

                    <div class="route-actions">
                      <button mat-stroked-button *ngIf="route.status === 'failed'" color="primary"
                              (click)="store.dispatch(retryRoute({ batchId: batch.id, routeId: route.id, actor: '值班人员' }))">
                        从 {{ route.reachedVersion }} 重试替代路线
                      </button>
                      <button mat-stroked-button *ngIf="route.status === 'blocked'"
                              (click)="store.dispatch(replanRoute({ batchId: batch.id, routeId: route.id, actor: '值班人员' }))">
                        补齐环节后重新规划
                      </button>
                    </div>
                  </section>
                }
              </div>

              <div class="actions">
                <button mat-stroked-button *ngIf="batch.status === 'draft'" color="primary"
                        [disabled]="hasBlocked(batch)"
                        (click)="store.dispatch(approveBatch({ id: batch.id, actor: '发布负责人' }))">审批</button>
                <button mat-stroked-button *ngIf="batch.status === 'approved'" color="primary"
                        (click)="store.dispatch(resumeBatch({ id: batch.id, actor: '发布负责人' }))">开始发布</button>
                <button mat-stroked-button *ngIf="batch.status === 'running'"
                        (click)="store.dispatch(pauseBatch({ id: batch.id, actor: '值班人员' }))">暂停</button>
                <button mat-stroked-button *ngIf="batch.status === 'paused' && hasRunnable(batch)"
                        (click)="store.dispatch(resumeBatch({ id: batch.id, actor: '运维人员' }))">继续</button>
                <button mat-flat-button color="warn"
                        [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'"
                        (click)="store.dispatch(rollbackBatch({ id: batch.id, actor: '发布负责人' }))">紧急回滚</button>
              </div>
            </article>
          </cdk-virtual-scroll-viewport>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list">
          <div class="audit" *ngFor="let item of audits$ | async">
            <span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p>
          </div>
        </mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(28px,3.6vw,46px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.85 }
    .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
    .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(320px,.9fr) minmax(440px,1.1fr); gap:20px; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding-top:16px }
    .hint { grid-column:1/-1; color:#607d86; font-size:12px; margin:4px 0 }
    .repo-form { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding-top:14px }
    .repo-form .full { grid-column:1/-1 } .repo-form button { grid-column:1/-1 }
    .repo-meta { grid-column:1/-1; display:flex; gap:16px; flex-wrap:wrap; color:#607d86; font-size:12px }
    .repo-meta .baseline { color:#b26a00 }
    .conflict-banner { display:flex; justify-content:space-between; align-items:center; gap:20px;
      background:#fff4e5; border:1px solid #ffb74d; border-left:6px solid #ef6c00; border-radius:10px; padding:14px 18px }
    .conflict-banner p { margin:6px 0 } .conflict-banner small { color:#8d6e63 }
    .viewport { height:620px }
    .batch { border-bottom:1px solid #dde7e8; padding:14px 4px; display:grid; gap:12px }
    .batch-head { display:flex; justify-content:space-between; gap:12px; align-items:center }
    small { color:#71858c } .reached { color:#0f6f6c }
    .routes { display:grid; gap:10px }
    .route { border:1px solid #d7e3e4; border-radius:10px; padding:10px 12px; display:grid; gap:8px; background:#fafdfd }
    .route.blocked { border-color:#e57373; background:#fff7f6 }
    .route.failed { border-color:#ffb74d; background:#fffaf2 }
    .route-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap }
    .spacer { flex:1 }
    .chain { display:flex; align-items:center; flex-wrap:wrap; gap:4px; font-size:13px }
    .chain-node { padding:3px 9px; border-radius:20px; background:#e3eeef; color:#355b60; white-space:nowrap }
    .chain-node.start { background:#cfe0e2; font-weight:600 }
    .chain-node.boot { background:#e8defc; color:#5e35b1 }
    .chain-node.transitional { background:#fff2d6; color:#9a6700 }
    .chain-node.done { background:#c8e6c9; color:#1b5e20 }
    .chain-node.flashing { background:#bbdefb; color:#0d47a1; animation:pulse 1.1s infinite }
    .chain-node.failed { background:#ffcdd2; color:#b71c1c }
    .arrow { color:#90a4ae } .arrow.boot { color:#7e57c2 }
    .step-mark { font-style:normal; margin-left:4px; font-size:11px }
    @keyframes pulse { 50% { opacity:.55 } }
    .gaps { color:#b71c1c; font-size:13px } .gaps ul { margin:4px 0 0; padding-left:18px }
    .failed-edges { font-size:12px; color:#b26a00 } code { background:#fdeecd; padding:1px 5px; border-radius:4px }
    .rescue-note { font-size:12px; color:#1b5e20 }
    .route-actions { display:flex; gap:8px }
    .actions { display:flex;gap:8px;flex-wrap:wrap }
    .audit-list { max-height:320px; overflow:auto }
    .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px }
    .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}
      .grid{grid-template-columns:1fr}.form-grid,.repo-form{grid-template-columns:1fr}
      .repo-form .full,.repo-form button{grid-column:auto}.audit{grid-template-columns:1fr}.viewport{height:520px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly models$ = this.store.select(selectModels);
  readonly firmware$ = this.store.select(selectFirmware);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly graphRevision = this.store.selectSignal(selectGraphRevision);
  readonly conflict = this.store.selectSignal(selectConflict);

  private timer?: number;

  draft = { name: '', firmware: '3.1.2', rollbackVersion: '2.8.1', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5 };
  actor = '值班员-甲';

  readonly editorModel = signal<string>('gw-e300');
  readonly editorVersion = signal<string>('3.0.0');
  readonly editorPrereqText = signal<string>('');
  readonly editorBaseRevision = signal<number>(1);
  readonly firmwareSignal = this.store.selectSignal(selectFirmware);

  readonly editorNodes = computed<FirmwareNode[]>(() =>
    firmwareForModel(this.firmwareSignal(), this.editorModel())
  );
  readonly editorNode = computed<FirmwareNode | undefined>(() =>
    this.editorNodes().find((node) => node.version === this.editorVersion())
  );

  readonly approveBatch = approveBatch;
  readonly pauseBatch = pauseBatch;
  readonly resumeBatch = resumeBatch;
  readonly rollbackBatch = rollbackBatch;
  readonly retryRoute = retryRoute;
  readonly replanRoute = replanRoute;
  readonly dismissConflict = dismissConflict;

  readonly blockedList = this.store.selectSignal((state: RootState) => blockedRoutes(state.release.batches));
  readonly allBatches = this.store.selectSignal(selectBatches);

  readonly blockedCount = computed(() => this.blockedList().length);
  readonly routeCount = computed(() => this.allBatches().reduce((sum, batch) => sum + batch.routes.length, 0));
  readonly failedCount = computed(() =>
    this.allBatches().reduce((sum, batch) => sum + batch.routes.filter((route) => route.status === 'failed').length, 0)
  );

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1500);
    // 全量持久化（含仓库谱系与修订号），刷好的设备结果跨刷新保留
    this.store.select((state: RootState) => state.release)
      .subscribe((release) => localStorage.setItem('firmware-release-v2', JSON.stringify(release)));
    this.onModelChange(this.editorModel());
  }

  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  onGroupChange(groupId: string) {
    this.draft.groupId = groupId;
  }

  onModelChange(modelId: string) {
    this.editorModel.set(modelId);
    const nodes = firmwareForModel(this.firmwareSignal(), modelId);
    const firstStable = nodes.find((node) => node.kind === 'stable') ?? nodes[0];
    if (firstStable) this.onNodeChange(firstStable.version);
  }

  onNodeChange(version: string) {
    this.editorVersion.set(version);
    const node = firmwareForModel(this.firmwareSignal(), this.editorModel()).find((item) => item.version === version);
    if (node) {
      this.editorPrereqText.set(node.prerequisites.join(', '));
      this.editorBaseRevision.set(node.prereqRevision);
    }
  }

  /** 冲突后放弃自己的旧基线，以仓库最新依赖为准重新编辑 */
  refreshEditorBaseline() {
    const node = this.editorNode();
    if (node) {
      this.editorPrereqText.set(node.prerequisites.join(', '));
      this.editorBaseRevision.set(node.prereqRevision);
    }
  }

  savePrerequisites() {
    const node = this.editorNode();
    if (!node) return;
    const prerequisites = this.editorPrereqText()
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    this.store.dispatch(updatePrerequisites({
      modelId: this.editorModel(),
      version: this.editorVersion(),
      prerequisites,
      baseRevision: this.editorBaseRevision(),
      actor: this.actor
    }));
    // 提交成功后基线推进到下一版；若冲突，store 里的 conflict 会提示，基线保持不变以便看出差异
    const fresh = firmwareForModel(this.firmwareSignal(), this.editorModel())
      .find((item) => item.version === this.editorVersion());
    if (fresh && fresh.lastEditor === this.actor) this.editorBaseRevision.set(fresh.prereqRevision);
  }

  /** 模拟对班在你打开编辑器后先提交：本编辑器基线保持旧值，再点保存即看到冲突 */
  simulateOtherEditor() {
    if (!this.editorNode()) return;
    const other = this.actor === '值班员-甲' ? '值班员-乙' : '值班员-甲';
    this.store.dispatch(simulateConcurrentEdit({
      modelId: this.editorModel(), version: this.editorVersion(), actor: other
    }));
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    this.store.dispatch(createBatch({ input: { ...this.draft }, actor: '发布负责人' }));
    this.draft = { ...this.draft, name: '' };
  }

  hasBlocked(batch: { routes: UpgradeRoute[] }): boolean {
    return batch.routes.some((route) => route.status === 'blocked');
  }

  hasRunnable(batch: { routes: UpgradeRoute[] }): boolean {
    return batch.routes.some((route) =>
      ['ready', 'paused', 'planned', 'running'].includes(route.status) &&
      route.steps.some((step) => step.status !== 'done')
    );
  }

  batchStatusLabel(status: string): string {
    return ({ draft: '草稿（含缺环节）', approved: '已审批', running: '发布中', paused: '已暂停', completed: '已完成', rolled_back: '已回滚' } as Record<string, string>)[status] ?? status;
  }
  batchStatusColor(status: string): string {
    if (status === 'paused') return 'warn';
    if (status === 'completed') return 'primary';
    return 'primary';
  }
  routeStatusLabel(status: string): string {
    return routeStatusLabel[status as keyof typeof routeStatusLabel] ?? status;
  }
  routeStatusColor(status: string): string {
    if (status === 'blocked' || status === 'failed' || status === 'rolled_back') return 'warn';
    return 'primary';
  }
  kindLabel(kind: string): string {
    return ({ stable: '稳定版', transitional: '过渡版', bootloader: '引导程序' } as Record<string, string>)[kind] ?? kind;
  }
  stepKindLabel(step: RouteStep): string {
    return this.kindLabel(step.kind);
  }
  stepClass(step: RouteStep): string {
    return `chain-node ${step.kind === 'bootloader' ? 'boot' : step.kind === 'transitional' ? 'transitional' : ''} ${step.status}`;
  }
  stepMark(step: RouteStep): string {
    return step.status === 'done' ? '✓' : step.status === 'flashing' ? '⟳' : step.status === 'failed' ? '✕' : '';
  }
}
