import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { DATE_PRESET_OPTIONS, datePresetRange } from '../../../shared/util';
import { PagosControlService, PagosControl, Conciliacion, ConciliacionRow } from '../pagos-control.service';

/**
 * CXP.2 — Tablero maestro de Cuentas por Pagar / Tesorería. Answer-first: "¿qué
 * necesita mi atención en pagos hoy?" — fuga de descuento, riesgo de doble pago,
 * facturas duplicadas, DPO y acciones HITL por aprobar, en una vista. Lee el resumen
 * que YA computó el motor (finance.findings/proposed_actions). Operations mode.
 */
@Component({
  selector: 'app-finanzas-pagos-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterModule, ButtonModule, SelectModule, DatePickerModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuentas por Pagar</h1>
          <p class="surf-page-sub">Lo que necesita tu atención en pagos: descuento dejado en la mesa, riesgo de doble pago, facturas duplicadas y las acciones que esperan tu aprobación. El motor detecta — tú decides.</p>
        </div>
        <div class="pc-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="pc-filters">
        <span class="pc-filters-label">Periodo del flujo de dinero</span>
        <p-select [options]="presetOpts" [ngModel]="preset()" (onChange)="onPreset($event.value)" optionLabel="label" optionValue="value" placeholder="Rango rápido" [showClear]="true" styleClass="pc-sel" ariaLabel="Rango de fecha rápido" />
        <p-datepicker [ngModel]="dateFrom()" (onSelect)="onDate('from', $event)" (onClear)="onDate('from', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="pc-dp" ariaLabel="Desde" />
        <p-datepicker [ngModel]="dateTo()" (onSelect)="onDate('to', $event)" (onClear)="onDate('to', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="pc-dp" ariaLabel="Hasta" />
        @if (dateFrom() || dateTo()) { <button pButton type="button" class="p-button-sm p-button-text" (click)="clearPeriod()" label="Todo el histórico"></button> }
        <span class="pc-filters-hint">acota el descuento obtenido y la conciliación; los KPIs de arriba son estado actual</span>
      </div>

      @if (error()) {
        <div class="pc-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo cargar el tablero. {{ error() }}</div>
      }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de cuentas por pagar" />

        <div class="pc-grid">
          <!-- Acciones HITL -->
          <section class="card-premium card-flat pc-card">
            <h3 class="pc-card-title"><i class="pi pi-check-square" aria-hidden="true"></i> Acciones por aprobar <span class="muted">({{ d.acciones.pendientes }})</span></h3>
            @if (d.acciones.top.length === 0) {
              <p class="pc-empty">Sin acciones pendientes. Cuando el motor detecte fuga o doble pago materiales, aparecerán aquí para tu visto bueno.</p>
            } @else {
              <ul class="pc-list">
                @for (a of d.acciones.top; track a.titulo) {
                  <li><span class="pc-li-txt">{{ a.titulo }}</span><b class="pc-li-num">{{ money(a.importe) }}</b></li>
                }
              </ul>
              <a routerLink="/finanzas/hallazgos" fragment="acciones" class="pc-link">Ir a aprobar / rechazar <i class="pi pi-arrow-right" aria-hidden="true"></i></a>
            }
          </section>

          <!-- Fuga de descuento -->
          <section class="card-premium card-flat pc-card">
            <h3 class="pc-card-title"><i class="pi pi-percentage" aria-hidden="true"></i> Descuento no capturado <span class="muted">top proveedores</span></h3>
            @if (d.kpis.fuga_descuento.top.length === 0) {
              <p class="pc-empty">Sin fuga detectada (o falta el feed de política de descuentos).</p>
            } @else {
              <ul class="pc-list">
                @for (t of d.kpis.fuga_descuento.top; track t.titulo) {
                  <li><span class="pc-li-txt">{{ t.proveedor || t.titulo }}</span><b class="pc-li-num">{{ money(t.importe) }}</b></li>
                }
              </ul>
            }
          </section>

          <!-- Doble pago -->
          <section class="card-premium card-flat pc-card">
            <h3 class="pc-card-title"><i class="pi pi-clone" aria-hidden="true"></i> Posible doble pago <span class="muted">mayor riesgo</span></h3>
            @if (d.kpis.doble_pago.top.length === 0) {
              <p class="pc-empty">Sin doble pago detectado.</p>
            } @else {
              <ul class="pc-list">
                @for (t of d.kpis.doble_pago.top; track t.titulo) {
                  <li>
                    <span class="pc-li-txt">{{ t.proveedor || t.titulo }} @if (t.severity === 'critical') { <span class="pc-tag-crit">crítico</span> }</span>
                    <b class="pc-li-num">{{ money(t.importe) }}</b>
                  </li>
                }
              </ul>
            }
          </section>

          <!-- Reconciliación de descuentos -->
          <section class="card-premium card-flat pc-card">
            <h3 class="pc-card-title"><i class="pi pi-sliders-h" aria-hidden="true"></i> Descuento obtenido <span class="muted">por canal</span></h3>
            <ul class="pc-list">
              <li><span class="pc-li-txt">Al pagar (pronto pago, c84)</span><b class="pc-li-num">{{ money(d.reconciliacion.desc_pago) }}</b></li>
              <li><span class="pc-li-txt">Vía nota de crédito (comercial)</span><b class="pc-li-num">{{ money(d.reconciliacion.desc_nota) }}</b></li>
              <li class="pc-li-total"><span class="pc-li-txt">Total capturado</span><b class="pc-li-num">{{ money(d.reconciliacion.total) }}</b></li>
            </ul>
          </section>
        </div>

        @if (recon(); as rc) {
          @if (rc.rows.length) {
            <section class="card-premium card-flat pc-card pc-recon">
              <h3 class="pc-card-title"><i class="pi pi-arrow-right-arrow-left" aria-hidden="true"></i> Conciliación de pagos a proveedor <span class="muted">Kepler vs Banco · mes a mes · {{ rc.cuadran }}/{{ rc.meses }} cuadran</span></h3>
              <div class="pc-recon-tablewrap">
                <table class="pc-recon-table">
                  <thead><tr><th>Mes</th><th class="ta-r">Kepler pagó</th><th class="ta-r">Salió del banco</th><th class="ta-r">Δ</th><th>Estado</th></tr></thead>
                  <tbody>
                    @for (r of rc.rows; track r.mes) {
                      <tr>
                        <td class="pc-mono">{{ r.mes }}</td>
                        <td class="ta-r pc-mono">{{ r.kepler ? money(r.kepler) : '—' }}</td>
                        <td class="ta-r pc-mono">{{ r.banco ? money(r.banco) : '—' }}</td>
                        <td class="ta-r pc-mono" [class.pc-neg]="r.delta < 0">{{ (r.estado === 'cuadra' || r.estado === 'revisar') ? money(r.delta) : '—' }}</td>
                        <td><span class="pc-est" [class]="'est-' + r.estado">{{ estadoLabel(r.estado) }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="pc-dt-note">Cuadre <b>agregado por mes</b> (no por proveedor: el banco no guarda el proveedor en el movimiento — atribuirlo sería un join débil). "Salió del banco" = egresos de compra/factoraje (CB). El cuadre banco↔libros a nivel cuenta vive en <a routerLink="/finanzas/bancos" class="pc-link">Bancos</a>.</p>
            </section>
          }
        }

        <p class="pc-foot">Tablero para <b>Cuentas por Pagar / Tesorería</b>. {{ d.hallazgos_abiertos }} hallazgo(s) abierto(s) en el dominio pagos/compras. El motor detecta y propone; la acción real la ejecuta un humano en el ERP (co-piloto, ADR-013).</p>
      } @else if (!error()) {
        <p class="pc-empty" style="margin-top:1.2rem">Cargando tablero…</p>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .pc-head-actions { display:flex; gap:.5rem; align-items:center; }
    .pc-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1.1rem 0 .2rem; }
    .pc-filters-label { font-size:.78rem; font-weight:600; color:var(--text-muted); }
    .pc-filters-hint { font-size:.72rem; color:var(--text-faint); }
    :host ::ng-deep .pc-sel { min-width:11rem; }
    .pc-error { margin:1rem 0; padding:.7rem 1rem; border:1px solid var(--bad-border,var(--border-color)); background:var(--bad-soft-bg); color:var(--bad-fg); border-radius:var(--radius-md,8px); font-size:.85rem; }
    .pc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1rem; margin-top:1.4rem; }
    .pc-card { padding:1rem 1.15rem; }
    .pc-card-title { display:flex; align-items:center; gap:.5rem; font-size:.9rem; font-weight:700; color:var(--text-main); margin:0 0 .7rem; }
    .pc-card-title .muted { font-weight:500; color:var(--text-faint); font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; margin-left:auto; }
    .pc-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
    .pc-list li { display:flex; align-items:baseline; justify-content:space-between; gap:1rem; padding:.42rem 0; border-top:1px solid var(--border-color); }
    .pc-list li:first-child { border-top:none; }
    .pc-li-txt { font-size:.83rem; color:var(--text-main); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pc-li-num { font-family:var(--font-mono); font-size:.86rem; font-weight:600; color:var(--text-main); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .pc-li-total { border-top:1px solid var(--border-color); margin-top:.2rem; }
    .pc-li-total .pc-li-txt, .pc-li-total .pc-li-num { font-weight:700; }
    .pc-tag-crit { display:inline-block; font-size:.62rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--bad-fg); background:var(--bad-soft-bg); padding:.05rem .35rem; border-radius:4px; margin-left:.35rem; }
    .pc-empty { font-size:.82rem; color:var(--text-faint); padding:.3rem 0; }
    .pc-link { display:inline-flex; align-items:center; gap:.35rem; margin-top:.7rem; font-size:.8rem; font-weight:600; color:var(--action); text-decoration:none; }
    .pc-link:hover { text-decoration:underline; }
    .pc-foot { margin-top:1.4rem; font-size:.76rem; color:var(--text-faint); line-height:1.5; }
    /* conciliación mes a mes */
    .pc-recon { margin-top:1rem; }
    .pc-recon-tablewrap { overflow-x:auto; }
    .pc-recon-table { width:100%; border-collapse:collapse; font-size:.82rem; }
    .pc-recon-table thead th { text-align:left; font-size:.66rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); padding:.45rem .6rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .pc-recon-table tbody td { padding:.45rem .6rem; border-bottom:1px solid var(--border-color); color:var(--text-main); }
    .pc-recon-table tbody tr:last-child td { border-bottom:none; }
    .pc-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .pc-neg { color:var(--bad-fg); }
    .pc-est { font-size:.66rem; font-weight:700; padding:.1rem .45rem; border-radius:4px; }
    .est-cuadra { background:var(--ok-soft-bg,var(--bad-soft-bg)); color:var(--ok-fg); }
    .est-revisar { background:var(--warn-soft-bg); color:var(--warn-fg); }
    .est-sin_banco, .est-sin_kepler { background:var(--surface-hover-bg,transparent); color:var(--text-faint); border:1px solid var(--border-color); }
  `],
})
export class FinanzasPagosControlComponent implements OnInit {
  private readonly svc = inject(PagosControlService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly data = signal<PagosControl | null>(null);
  readonly recon = signal<Conciliacion | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly dateFrom = signal<Date | null>(null);
  readonly dateTo = signal<Date | null>(null);
  readonly preset = signal<string>('');
  readonly presetOpts = DATE_PRESET_OPTIONS;

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    this.dateFrom.set(this.fromIso(q.get('from')));
    this.dateTo.set(this.fromIso(q.get('to')));
    this.load();
  }

  load(): void {
    this.loading.set(true); this.error.set(null);
    const range = { date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()) };
    this.svc.overview(range).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'error'); this.loading.set(false); },
    });
    this.svc.conciliacion(range).subscribe({ next: (r) => this.recon.set(r), error: () => this.recon.set(null) });
  }

  /** Date → 'YYYY-MM-DD' (local, sin correr por TZ). */
  private toIso(d: Date | null): string | undefined {
    if (!d) return undefined;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  /** 'YYYY-MM-DD' → Date (local). */
  private fromIso(s: string | null): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { from: this.toIso(this.dateFrom()) || null, to: this.toIso(this.dateTo()) || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onDate(which: 'from' | 'to', v: Date | null): void {
    (which === 'from' ? this.dateFrom : this.dateTo).set(v);
    this.preset.set(''); this.syncUrl(); this.load();
  }

  /** Rango rápido: fija Desde/Hasta según el preset. */
  onPreset(key: string | null): void {
    this.preset.set(key || '');
    const r = key ? datePresetRange(key) : null;
    if (!r) return;
    this.dateFrom.set(r.from); this.dateTo.set(r.to);
    this.syncUrl(); this.load();
  }

  clearPeriod(): void {
    this.dateFrom.set(null); this.dateTo.set(null); this.preset.set('');
    this.syncUrl(); this.load();
  }

  estadoLabel(e: string): string {
    return e === 'cuadra' ? 'Cuadra' : e === 'revisar' ? 'Revisar' : e === 'sin_banco' ? 'Falta banco' : 'Falta Kepler';
  }

  kpiItems(d: PagosControl): MetricStripItem[] {
    return [
      { label: 'Fuga de descuento', value: d.kpis.fuga_descuento.total, format: 'currency-short', tone: 'warn', sub: `${d.kpis.fuga_descuento.count} proveedor(es)` },
      { label: 'Riesgo doble pago', value: d.kpis.doble_pago.total, format: 'currency-short', tone: 'bad', sub: `${d.kpis.doble_pago.count} caso(s) · ${d.kpis.doble_pago.criticos} crítico(s)` },
      { label: 'Facturas duplicadas', value: d.kpis.factura_duplicada.total, format: 'currency-short', tone: 'warn', sub: `${d.kpis.factura_duplicada.count} caso(s)` },
      { label: 'Acciones por aprobar', value: d.acciones.pendientes, format: 'number', tone: 'brand', sub: this.money(d.acciones.total_importe) },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
