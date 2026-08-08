import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SalesBlockComponent } from '../ventas-generales/sales-block.component';
import { DashboardSpec, SalesBlock } from '../ventas-generales/dashboard-spec';
import { VentasGeneralesService, VgMetric, VgDimension, METRIC_LABEL, DIMENSION_LABEL } from '../ventas-generales.service';

/**
 * Fase VG.0/1 — "Ventas Generales": tablero de venta global dirigido por `spec`. El usuario
 * arma la pregunta (métrica × dimensión × rango) o elige un preset (ej. "Centro de control")
 * → se produce un `DashboardSpec` que el renderer rellena con datos DETERMINISTAS. Mismo `spec`
 * que Thot emitirá en VG.2. Operations, revenue-first, sin inventar números (ADR-016/042).
 */
@Component({
  selector: 'app-ventas-generales',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, SelectModule, ButtonModule, InputTextModule, ContextHelpComponent, SalesBlockComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 style="display:inline-flex;align-items:center;gap:.4rem">Ventas generales <app-context-help topic="ventas-generales" /></h1>
          <p class="surf-page-sub">Consultá la venta global de la red y desglosala como quieras — por canal, marca, categoría, sucursal, producto, cliente o su histórico. Venta real (no pedidos B2B), últimos 30 días.</p>
        </div>
        <div class="vg-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="rebuild()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <!-- Preguntá lo que sea (Thot compone el tablero) -->
      <form class="vg-ask" (ngSubmit)="askAi()">
        <i class="pi pi-sparkles vg-ask-ic" aria-hidden="true"></i>
        <input pInputText [ngModel]="question()" (ngModelChange)="question.set($event)" name="q" [disabled]="asking()"
               placeholder="Preguntá lo que sea de ventas… ej: «márgenes por marca» o «centro de control de ventas»" aria-label="Preguntar a Thot" />
        <button pButton type="submit" class="p-button-sm" [loading]="asking()" [disabled]="!question().trim()"><span class="p-button-label">Preguntar</span></button>
      </form>
      @if (aiError()) { <p class="vg-ai-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ aiError() }}</p> }
      @if (mode() === 'ai' && aiNarrative()) { <p class="vg-ai-note"><i class="pi pi-sparkles" aria-hidden="true"></i> {{ aiNarrative() }}</p> }

      <div class="vg-quick" role="group" aria-label="Preguntas rápidas">
        <button type="button" class="vg-chip vg-chip-star" [class.on]="mode() === 'cc'" (click)="controlCenter()"><i class="pi pi-compass" aria-hidden="true"></i> Centro de control</button>
        @for (q of quickAsks; track q.label) {
          <button type="button" class="vg-chip" [class.on]="mode() === 'focus' && dim() === q.dim && metric() === q.metric" (click)="ask(q.dim, q.metric)">{{ q.label }}</button>
        }
      </div>

      <div class="vg-builder">
        <span class="vg-lead">Muéstrame</span>
        <p-select [options]="metricOpts()" [ngModel]="metric()" (onChange)="onMetric($event.value)" optionLabel="label" optionValue="value" styleClass="vg-sel" ariaLabel="Métrica" />
        <span class="vg-lead">por</span>
        <p-select [options]="dimOpts" [ngModel]="dim()" (onChange)="onDim($event.value)" optionLabel="label" optionValue="value" styleClass="vg-sel" ariaLabel="Dimensión" />
        @if (dim() !== 'tiempo') {
          <p-select [options]="topOpts" [ngModel]="topN()" (onChange)="onTop($event.value)" optionLabel="label" optionValue="value" styleClass="vg-sel-sm" ariaLabel="Top N" />
        } @else {
          <p-select [options]="rangeOpts" [ngModel]="range()" (onChange)="onRange($event.value)" optionLabel="label" optionValue="value" styleClass="vg-sel-sm" ariaLabel="Rango" />
        }
      </div>

      <!-- Tablero: renderiza el spec (bloques auto-consultan datos deterministas) -->
      <div class="vg-dash">
        @for (b of spec().blocks; track $index) {
          <div class="vg-cell" [style.grid-column]="'span ' + (b.span || 12)">
            <app-sales-block [block]="b" />
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .vg-head-actions { display:flex; gap:.5rem; }
    .vg-ask { display:flex; align-items:center; gap:.5rem; margin:1rem 0 .5rem; padding:.35rem .35rem .35rem .7rem; border:1px solid var(--border-color); border-radius:var(--r-pill,999px); background:var(--card-bg); }
    .vg-ask:focus-within { border-color:var(--action); box-shadow:0 0 0 3px var(--action-ring); }
    .vg-ask-ic { color:var(--action); }
    .vg-ask input { flex:1; border:0; background:transparent; outline:none; font-size:.9rem; color:var(--text-main); }
    .vg-ask input::placeholder { color:var(--text-faint); }
    .vg-ai-err { display:flex; align-items:center; gap:.4rem; font-size:.82rem; color:var(--bad-fg); margin:.2rem 0 .4rem; }
    .vg-ai-note { display:flex; align-items:center; gap:.4rem; font-size:.84rem; color:var(--text-muted); margin:.2rem 0 .6rem; }
    .vg-ai-note .pi { color:var(--action); }
    .vg-quick { display:flex; flex-wrap:wrap; gap:.4rem; margin:.4rem 0 .6rem; }
    .vg-chip { display:inline-flex; align-items:center; gap:.3rem; border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-muted); border-radius:var(--r-pill,999px); padding:.3rem .7rem; font-size:.78rem; cursor:pointer; transition:color 120ms, border-color 120ms, background 120ms; }
    .vg-chip:hover { color:var(--text-main); border-color:var(--action); }
    .vg-chip.on { background:var(--action); border-color:var(--action); color:var(--action-ink,#fff); font-weight:600; }
    .vg-chip:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .vg-chip-star { font-weight:600; color:var(--text-main); }
    .vg-builder { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin:.2rem 0 1rem; }
    .vg-lead { color:var(--text-muted); font-size:.86rem; }
    :host ::ng-deep .vg-sel { min-width:12rem; } :host ::ng-deep .vg-sel-sm { min-width:9rem; }
    .vg-dash { display:grid; grid-template-columns:repeat(12, 1fr); gap:1rem; align-items:stretch; }
    @media (max-width:900px) { .vg-cell { grid-column:span 12 !important; } }
  `],
})
export class VentasGeneralesComponent implements OnInit {
  private readonly svc = inject(VentasGeneralesService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly metric = signal<VgMetric>('ventas');
  readonly dim = signal<VgDimension>('canal');
  readonly topN = signal(20);
  readonly range = signal<'30d' | '90d' | '12m'>('30d');
  readonly mode = signal<'focus' | 'cc' | 'ai'>('focus');
  readonly spec = signal<DashboardSpec>({ blocks: [] });

  // Caja de pregunta en lenguaje natural (VG.2 — Thot compone el `spec`).
  readonly question = signal('');
  readonly asking = signal(false);
  readonly aiNarrative = signal('');
  readonly aiError = signal<string | null>(null);

  readonly dimOpts = (['canal', 'marca', 'categoria', 'sucursal', 'producto', 'cliente', 'tiempo'] as VgDimension[])
    .map((v) => ({ label: DIMENSION_LABEL[v], value: v }));
  readonly topOpts = [10, 20, 50, 100].map((n) => ({ label: `Top ${n}`, value: n }));
  readonly rangeOpts = [
    { label: 'Últimos 30 días', value: '30d' },
    { label: 'Últimos 90 días', value: '90d' },
    { label: 'Últimos 12 meses', value: '12m' },
  ];
  readonly metricOpts = computed(() => this.svc.metricsFor(this.dim()).map((m) => ({ label: METRIC_LABEL[m], value: m })));

  readonly quickAsks: { label: string; dim: VgDimension; metric: VgMetric }[] = [
    { label: 'Ventas por canal', dim: 'canal', metric: 'ventas' },
    { label: 'Histórico de ventas', dim: 'tiempo', metric: 'ventas' },
    { label: 'Mix por marca', dim: 'marca', metric: 'ventas' },
    { label: 'Margen por categoría', dim: 'categoria', metric: 'margen' },
    { label: 'Top productos', dim: 'producto', metric: 'ventas' },
    { label: 'Ventas por sucursal', dim: 'sucursal', metric: 'ventas' },
    { label: 'Mejores clientes', dim: 'cliente', metric: 'ventas' },
    { label: 'Margen por marca', dim: 'marca', metric: 'margen' },
  ];

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('view') === 'cc') { this.controlCenter(); return; }
    const d = q.get('dim') as VgDimension | null;
    const m = q.get('metric') as VgMetric | null;
    if (d && this.dimOpts.some((o) => o.value === d)) this.dim.set(d);
    if (m && this.svc.metricsFor(this.dim()).includes(m)) this.metric.set(m);
    this.buildFocus();
  }

  /** VG.2 — Thot compone el tablero desde la pregunta en lenguaje natural. */
  askAi(): void {
    const q = this.question().trim();
    if (!q || this.asking()) return;
    this.asking.set(true); this.aiError.set(null);
    this.svc.composeSalesView(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.asking.set(false);
        this.mode.set('ai');
        this.aiNarrative.set(r.spec?.narrative || '');
        this.spec.set({ title: r.spec?.title, blocks: r.spec?.blocks || [] });
        if (r.source === 'no_api_key') this.aiError.set('El asistente no está configurado (falta ANTHROPIC_API_KEY); te muestro un tablero por default.');
      },
      error: () => { this.asking.set(false); this.aiError.set('No se pudo componer el tablero. Probá de nuevo.'); },
    });
  }

  /** Tablero "Centro de control": varios bloques en un solo spec (demuestra el multi-bloque). */
  controlCenter(): void {
    this.mode.set('cc');
    this.spec.set({
      title: 'Centro de control',
      blocks: [
        { type: 'kpi', span: 12 },
        { type: 'breakdown', metric: 'ventas', dimension: 'canal', viz: 'bars', span: 6, title: 'Ventas por canal' },
        { type: 'series', metric: 'ventas', range: '12m', span: 6, title: 'Histórico de ventas (12 m)' },
        { type: 'breakdown', metric: 'ventas', dimension: 'producto', limit: 10, viz: 'table', span: 6, title: 'Top productos' },
        { type: 'breakdown', metric: 'ventas', dimension: 'marca', limit: 10, viz: 'table', span: 6, title: 'Mix por marca' },
      ],
    });
    this.syncUrl();
  }

  /** Pregunta enfocada: KPIs + un bloque (desglose o serie). */
  private buildFocus(): void {
    this.mode.set('focus');
    const blocks: SalesBlock[] = [{ type: 'kpi', span: 12 }];
    if (this.dim() === 'tiempo') {
      blocks.push({ type: 'series', metric: this.metric(), range: this.range(), span: 12,
        title: `Histórico de ${METRIC_LABEL[this.metric()].toLowerCase()}` });
    } else {
      blocks.push({ type: 'breakdown', metric: this.metric(), dimension: this.dim(), limit: this.topN(), viz: 'bars-table', span: 12 });
    }
    this.spec.set({ blocks });
    this.syncUrl();
  }

  ask(d: VgDimension, m: VgMetric): void {
    this.dim.set(d);
    this.metric.set(this.svc.metricsFor(d).includes(m) ? m : this.svc.metricsFor(d)[0]);
    this.buildFocus();
  }

  onDim(d: VgDimension): void {
    this.dim.set(d);
    if (!this.svc.metricsFor(d).includes(this.metric())) this.metric.set(this.svc.metricsFor(d)[0]);
    this.buildFocus();
  }
  onMetric(m: VgMetric): void { this.metric.set(m); this.buildFocus(); }
  onTop(n: number): void { this.topN.set(n); this.buildFocus(); }
  onRange(r: '30d' | '90d' | '12m'): void { this.range.set(r); this.buildFocus(); }

  /** Reconstruye el spec (fuerza recarga de bloques con instancias nuevas). */
  rebuild(): void { if (this.mode() === 'cc') this.controlCenter(); else this.buildFocus(); }

  private syncUrl(): void {
    const qp = this.mode() === 'cc' ? { view: 'cc', dim: null, metric: null } : { view: null, dim: this.dim(), metric: this.metric() };
    this.router.navigate([], { relativeTo: this.route, queryParams: qp, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
