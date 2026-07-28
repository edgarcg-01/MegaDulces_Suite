import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { LogisticaService, FleetAdherenceRow } from '../logistica.service';

/**
 * LTV.1 — Auditoría de ruta. Único lugar del análisis de ruta: cruza el plan
 * (clientes de la ruta que la unidad debía servir ese día) contra lo real
 * (paradas GPS matcheadas a cliente). Tabla de flota completa por fecha con
 * cobertura %, visitados/saltados/fuera-de-ruta; drill a la lista de clientes
 * del plan (visitado vs saltado) por unidad.
 */
@Component({
  selector: 'app-logistica-auditoria-ruta',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, TooltipModule],
  template: `
    <div class="surf-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <span class="rk-eyebrow"><i class="pi pi-check-circle" aria-hidden="true"></i> Auditoría en Ruta</span>
          <h1>Cumplimiento de ruta</h1>
          <p class="surf-page-sub">
            {{ evaluables().length }} de {{ rows().length }} unidad{{ rows().length === 1 ? '' : 'es' }} evaluable{{ evaluables().length === 1 ? '' : 's' }}
            <span class="rk-muted">· plan vs. recorrido real del día</span>
          </p>
        </div>
        <div class="rk-actions">
          <input type="date" class="rk-date" [ngModel]="date()" (ngModelChange)="setDate($event)"
                 [max]="today" aria-label="Fecha de auditoría" />
          <button pButton icon="pi pi-refresh" label="Actualizar" [text]="true" size="small"
                  [loading]="loading()" (click)="refresh()" aria-label="Refrescar"></button>
        </div>
      </header>

      <!-- KPIs del día -->
      <div class="sheet cols-12 rk-kpis">
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" [style.color]="coverageColor(fleetCoverage())">{{ fleetCoverage() != null ? fleetCoverage() + '%' : '—' }}</span>
          <span class="rk-kpi-l">Cumplimiento de flota</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" style="color:var(--ok-fg)">{{ totals().visited }}</span>
          <span class="rk-kpi-l">Clientes visitados</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n" style="color:var(--warn-fg)">{{ totals().skipped }}</span>
          <span class="rk-kpi-l">Clientes saltados</span>
        </article>
        <article class="cell cell-span-3 rk-kpi">
          <span class="rk-kpi-n rk-dim">{{ totals().offRoute }}</span>
          <span class="rk-kpi-l">Paradas fuera de ruta</span>
        </article>
      </div>

      <!-- Master-detail -->
      <div class="sheet cols-12" *ngIf="rows().length; else empty">
        <article class="cell cell-span-7 is-flush">
          <div class="rk-table-wrap">
            <table class="rk-table">
              <thead>
                <tr>
                  <th>Unidad</th>
                  <th style="width:34%">Cumplimiento</th>
                  <th class="num" pTooltip="Visitados / plan con coordenadas">Visitados</th>
                  <th class="num" pTooltip="Clientes del plan que no visitó">Saltados</th>
                  <th class="num" pTooltip="Paradas que no corresponden a un cliente del plan">Fuera</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let r of rows(); trackBy: trackById"
                    class="rk-tr" [class.sel]="r.vehicle_id === selectedId()" (click)="select(r)">
                  <td class="rk-unit">{{ r.vehicle_plate || shortId(r.vehicle_id) }}</td>
                  <td>
                    <ng-container *ngIf="r.evaluable; else naCell">
                      <div class="rk-bar" [attr.aria-label]="r.coverage_pct + '% de cumplimiento'">
                        <span [style.width.%]="r.coverage_pct ?? 0" [style.background]="coverageColor(r.coverage_pct)"></span>
                      </div>
                      <span class="rk-bar-lbl">{{ r.coverage_pct }}%</span>
                    </ng-container>
                    <ng-template #naCell><span class="rk-na">sin plan evaluable</span></ng-template>
                  </td>
                  <td class="num">{{ r.evaluable ? r.visited_count + '/' + r.planned_with_coords : '—' }}</td>
                  <td class="num" [class.rk-warn]="r.skipped_count > 0">{{ r.evaluable ? r.skipped_count : '—' }}</td>
                  <td class="num rk-dim">{{ r.off_route_count }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article class="cell cell-span-5" *ngIf="selected() as s; else pickHint">
          <div class="rk-detail-head">
            <h3>{{ s.vehicle_plate || shortId(s.vehicle_id) }}</h3>
            <span class="rk-muted">Plan de ruta · {{ date() }}</span>
          </div>

          <div *ngIf="!s.evaluable" class="rk-na-box">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            Sin plan evaluable: falta el embarque con ruta del día o los clientes de la ruta no tienen coordenadas
            <span *ngIf="s.planned_count"> ({{ s.planned_count }} clientes en el plan, {{ s.planned_with_coords }} con coordenadas)</span>.
          </div>

          <ng-container *ngIf="s.evaluable">
            <div class="rk-adh-summary">
              <div class="rk-bar rk-bar-lg"><span [style.width.%]="s.coverage_pct ?? 0" [style.background]="coverageColor(s.coverage_pct)"></span></div>
              <p><b>{{ s.coverage_pct }}%</b> · {{ s.visited_count }}/{{ s.planned_with_coords }} visitados
                <span *ngIf="s.off_route_count"> · {{ s.off_route_count }} fuera de ruta</span></p>
            </div>

            <h4 class="rk-sub-h">Clientes del plan</h4>
            <ol class="rk-plan">
              <li *ngFor="let p of s.planned; trackBy: trackPlan" class="rk-plan-row"
                  [class.visited]="p.visited" [class.nocoord]="!p.has_coords">
                <span class="rk-plan-seq">{{ p.visit_sequence ?? '·' }}</span>
                <i class="pi" [class.pi-check-circle]="p.visited" [class.pi-times-circle]="!p.visited && p.has_coords"
                   [class.pi-minus-circle]="!p.has_coords" aria-hidden="true"></i>
                <span class="rk-plan-name">{{ p.name || p.code || 'Cliente' }}</span>
                <span class="rk-plan-tag" *ngIf="!p.has_coords">sin coords</span>
                <span class="rk-plan-tag skip" *ngIf="p.has_coords && !p.visited">saltado</span>
              </li>
            </ol>
          </ng-container>
        </article>

        <ng-template #pickHint>
          <article class="cell cell-span-5">
            <div class="rk-pick"><i class="pi pi-list" aria-hidden="true"></i>
              <p>Seleccioná una unidad para ver su plan de ruta y qué clientes visitó o saltó.</p>
            </div>
          </article>
        </ng-template>
      </div>

      <ng-template #empty>
        <div class="sheet cols-12">
          <article class="cell cell-span-12">
            <div class="rk-empty" *ngIf="!errored(); else errBox">
              <div class="rk-empty-icon"><i class="pi pi-check-circle" aria-hidden="true"></i></div>
              <h3>Sin rutas para auditar</h3>
              <p>No hay embarques con ruta ni actividad GPS para <b>{{ date() }}</b>. La auditoría cruza los embarques del día con el recorrido real.</p>
            </div>
            <ng-template #errBox>
              <div class="rk-empty">
                <div class="rk-empty-icon"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i></div>
                <h3>No se pudo cargar la auditoría</h3>
                <p>Revisá tu conexión y reintentá.</p>
                <button pButton size="small" label="Reintentar" (click)="refresh()"></button>
              </div>
            </ng-template>
          </article>
        </div>
      </ng-template>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .rk-eyebrow { display:inline-flex; align-items:center; gap:.35rem; font-size:var(--fs-micro); font-weight:var(--fw-bold); text-transform:uppercase; letter-spacing:.08em; color:var(--c-text-2); margin-bottom:.35rem; }
    .rk-muted { color:var(--c-text-3); }
    .rk-actions { display:flex; gap:.4rem; align-items:center; }
    .rk-date { padding:.4rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }
    .rk-date:focus-visible { outline:2px solid var(--action); outline-offset:1px; }

    .rk-kpi { display:flex; flex-direction:column; gap:.1rem; }
    .rk-kpi-n { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; font-size:var(--fs-h2,1.5rem); font-weight:var(--fw-bold); line-height:1.1; }
    .rk-kpi-n.rk-dim { color:var(--c-text-3); }
    .rk-kpi-l { font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); }

    .rk-table-wrap { overflow-x:auto; }
    .rk-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .rk-table thead th { text-align:left; padding:.5rem .7rem; font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-3); font-weight:var(--fw-bold); border-bottom:1px solid var(--c-divider); white-space:nowrap; }
    .rk-table th.num, .rk-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .rk-table td.num { font-family:var(--font-mono,'Geist Mono',monospace); }
    .rk-tr { cursor:pointer; }
    .rk-tr > td { padding:.5rem .7rem; border-top:1px solid var(--c-divider); white-space:nowrap; vertical-align:middle; }
    .rk-tr:hover { background:var(--overlay-hover); }
    .rk-tr.sel { background:var(--overlay-selected); box-shadow:inset 3px 0 0 var(--action); }
    .rk-unit { font-weight:var(--fw-medium); }
    .rk-warn { color:var(--warn-fg); }
    .rk-dim { color:var(--c-text-3); }
    .rk-na { color:var(--c-text-3); font-size:var(--fs-micro); font-style:italic; }

    .rk-bar { display:inline-block; width:calc(100% - 3rem); height:6px; border-radius:99px; background:var(--c-surface-2); overflow:hidden; vertical-align:middle; }
    .rk-bar span { display:block; height:100%; background:var(--ok-fg); transition:width .3s ease-out; }
    .rk-bar-lbl { display:inline-block; width:2.6rem; text-align:right; font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; font-size:var(--fs-micro); color:var(--c-text-2); }
    .rk-bar-lg { width:100%; height:8px; margin-bottom:.4rem; }

    .rk-detail-head { display:flex; flex-direction:column; gap:.15rem; margin-bottom:.75rem; }
    .rk-detail-head h3 { margin:0; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-na-box { display:flex; gap:.5rem; align-items:flex-start; color:var(--c-text-3); font-size:var(--fs-sm); background:var(--c-surface-2); padding:.6rem .75rem; border-radius:var(--r-md,8px); }
    .rk-adh-summary p { margin:.15rem 0 .75rem; font-size:var(--fs-sm); color:var(--c-text-2); }
    .rk-adh-summary b { color:var(--c-text-1); font-variant-numeric:tabular-nums; }

    .rk-sub-h { margin:.25rem 0 .5rem; font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-3); font-weight:var(--fw-bold); }
    .rk-plan { list-style:none; margin:0; padding:0; }
    .rk-plan-row { display:flex; align-items:center; gap:.55rem; padding:.35rem 0; border-top:1px solid var(--c-divider); font-size:var(--fs-sm); }
    .rk-plan-row:first-child { border-top:none; }
    .rk-plan-seq { width:1.4rem; text-align:center; font-family:var(--font-mono,'Geist Mono',monospace); font-size:var(--fs-micro); color:var(--c-text-3); flex:0 0 auto; }
    .rk-plan-row .pi { flex:0 0 auto; }
    .rk-plan-row.visited .pi { color:var(--ok-fg); }
    .rk-plan-row .pi-times-circle { color:var(--warn-fg); }
    .rk-plan-row .pi-minus-circle { color:var(--c-text-3); }
    .rk-plan-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--c-text-1); }
    .rk-plan-row.nocoord .rk-plan-name { color:var(--c-text-3); }
    .rk-plan-tag { font-size:var(--fs-micro); color:var(--c-text-3); text-transform:uppercase; letter-spacing:.04em; flex:0 0 auto; }
    .rk-plan-tag.skip { color:var(--warn-fg); }

    .rk-pick { text-align:center; color:var(--c-text-3); padding:2rem 1rem; font-size:var(--fs-sm); }
    .rk-pick i { font-size:1.4rem; display:block; margin-bottom:.5rem; }
    .rk-empty { text-align:center; padding:2.5rem 1.5rem; max-width:460px; margin:0 auto; }
    .rk-empty-icon { width:56px; height:56px; margin:0 auto 1rem; border-radius:14px; background:var(--c-surface-2); color:var(--c-text-2); display:grid; place-items:center; font-size:1.5rem; }
    .rk-empty h3 { margin:0 0 .375rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); }
    .rk-empty p { margin:0 0 .75rem; color:var(--c-text-2); font-size:var(--fs-sm); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaAuditoriaRutaComponent {
  private readonly api = inject(LogisticaService);

  readonly today = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  readonly date = signal<string>(this.today);
  readonly rows = signal<FleetAdherenceRow[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);

  readonly selected = computed(() => this.rows().find((r) => r.vehicle_id === this.selectedId()) ?? null);
  readonly evaluables = computed(() => this.rows().filter((r) => r.evaluable));

  readonly totals = computed(() => {
    const r = this.evaluables();
    return {
      visited: r.reduce((a, x) => a + (x.visited_count || 0), 0),
      skipped: r.reduce((a, x) => a + (x.skipped_count || 0), 0),
      plannedWithCoords: r.reduce((a, x) => a + (x.planned_with_coords || 0), 0),
      offRoute: this.rows().reduce((a, x) => a + (x.off_route_count || 0), 0),
    };
  });

  readonly fleetCoverage = computed(() => {
    const t = this.totals();
    if (t.plannedWithCoords === 0) return null;
    return Math.round((t.visited / t.plannedWithCoords) * 100);
  });

  constructor() {
    this.refresh();
  }

  setDate(d: string) {
    if (!d) return;
    this.date.set(d);
    this.selectedId.set(null);
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.api.fleetAdherence(this.date()).subscribe({
      next: (r) => { this.rows.set(r || []); this.errored.set(false); this.loading.set(false); },
      error: () => { this.errored.set(true); this.loading.set(false); },
    });
  }

  select(r: FleetAdherenceRow) {
    this.selectedId.set(this.selectedId() === r.vehicle_id ? null : r.vehicle_id);
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  trackById = (_: number, r: FleetAdherenceRow) => r.vehicle_id;
  trackPlan = (_: number, p: { customer_id: string }) => p.customer_id;
  shortId(id: string) { return id ? id.slice(0, 8) : '—'; }
  coverageColor(pct: number | null): string {
    if (pct == null) return 'var(--c-text-3)';
    if (pct >= 85) return 'var(--ok-fg)';
    if (pct >= 60) return 'var(--warn-fg)';
    return 'var(--bad-fg)';
  }
}
