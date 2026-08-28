import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { StoreSocketService, OpenCajasResponse, OpenCaja } from '../store-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { branchName } from '../../../core/constants/store-branches';

/**
 * SM.10 — Cajas abiertas AHORA (/tienda/cajas). Muestra qué caja está abierta y
 * QUIÉN está cobrando, cruzando la sesión de caja (kdpv abierta) con la actividad
 * en vivo por cajero (tickets kdm1.c67). `cobrando` = ticket en los últimos 15 min.
 * Superficie Operations, PrimeNG denso, dark-safe. Auto-refresh cada 30s.
 */
@Component({
  selector: 'app-tienda-cajas',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cj-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cajas abiertas</h1>
          <p class="surf-page-sub">Qué caja está abierta ahora y <strong>quién está cobrando</strong>, <strong>ordenadas por venta del día</strong> (ranking). Se cruza la sesión de caja con los tickets en vivo por cajera.</p>
        </div>
        <div class="cj-head-right">
          @if (scoped) { <span class="cj-scope"><i class="pi pi-map-marker"></i> {{ branchLabel() }}</span> }
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="loading()" (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      @if (data(); as d) {
        @if (d.feed?.sospechoso) {
          <!-- Un cero mudo es peor que un error: en ago-2026 el CDC estuvo 2 días
               congelado y esta pantalla habría dicho "no hay cajas abiertas". -->
          <div class="cj-alerta">
            <i class="pi pi-exclamation-triangle"></i>
            <div>
              <strong>Estos números pueden no ser de ahora.</strong>
              <p>
                @if (d.feed?.atrasado) {
                  Lo último que sabemos de Kepler es del <strong>{{ d.feed?.ultimo_dia | date:'dd/MM/yy' }}</strong>, no de hoy.
                } @else if (d.feed?.minutos != null) {
                  El feed de cajas no se actualiza desde hace <strong>{{ d.feed?.minutos }} min</strong>.
                } @else {
                  Todavía no hay ninguna lectura del feed de cajas.
                }
                Si abajo dice que no hay cajas abiertas, puede ser que la tienda esté cerrada <em>o</em> que dejamos de recibir datos.
              </p>
            </div>
          </div>
        }
        <div class="cj-kpis">
          <div class="cj-kpi"><span class="cj-kpi-v">{{ d.cajas_abiertas }}</span><span class="cj-kpi-l">Cajas abiertas</span></div>
          <div class="cj-kpi"><span class="cj-kpi-v ok">{{ d.cobrando_ahora }}</span><span class="cj-kpi-l">Cobrando ahora</span></div>
          <div class="cj-kpi"><span class="cj-kpi-v">{{ money(totalVenta(d)) }}</span><span class="cj-kpi-l">Venta en cajas abiertas (hoy)</span></div>
          @if (d.arrastradas) {
            <!-- Cajas que nadie cerró al terminar el día: pendiente operativo, no actividad. -->
            <div class="cj-kpi"><span class="cj-kpi-v bad">{{ d.arrastradas }}</span><span class="cj-kpi-l">Sin cerrar de días previos</span></div>
          }
        </div>

        <div class="card-premium card-flat">
          <p-table [value]="d.open_cajas" styleClass="p-datatable-sm cj-table" [rowHover]="true">
            <ng-template #header>
              <tr><th class="ta-c">#</th><th>Estado</th><th>Sucursal</th><th>Caja</th><th>Cajera</th><th>Abrió</th><th class="ta-r">Tickets hoy</th><th class="ta-r">Venta hoy</th><th>Último ticket</th></tr>
            </ng-template>
            <ng-template #body let-c>
              <tr [class.cj-idle]="!c.cobrando">
                <td class="ta-c"><span class="cj-rank" [class.top]="c.rank <= 3">{{ c.rank }}</span></td>
                <td>
                  @if (c.cobrando) { <span class="cj-dot ok"></span><span class="cj-st ok">Cobrando</span> }
                  @else if (c.idle_min != null) { <span class="cj-dot warn"></span><span class="cj-st warn">Inactiva {{ c.idle_min }}m</span> }
                  @else { <span class="cj-dot off"></span><span class="cj-st muted">Sin ventas</span> }
                </td>
                <td>{{ c.warehouse_name || branchLabelOf(c.warehouse_code) }}</td>
                <td class="strong">{{ c.caja }}</td>
                <td>{{ c.cajero_nombre || c.cajero || '—' }}<span class="cj-code muted"> {{ c.cajero }}</span></td>
                <td class="mono">{{ c.abrio }}@if (c.arrastrada) { <span class="cj-arrastrada" [title]="'Abrió el ' + c.desde_dia + ' y nadie la cerró'">{{ c.dias_abierta }}d sin cerrar</span> }</td>
                <td class="ta-r">{{ c.tickets | number }}</td>
                <td class="ta-r strong">{{ money(c.venta) }}</td>
                <td class="mono">{{ c.last_ticket || '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="9" class="cj-empty">{{ loading() ? 'Cargando…' : (data()?.feed?.sospechoso ? 'Sin cajas abiertas — pero el feed está atrasado, así que puede ser falta de datos y no que estén cerradas.' : 'No hay ninguna caja abierta ahora mismo.') }}</td></tr></ng-template>
          </p-table>
        </div>

        @if (d.cajeros_sin_sesion.length) {
          <div class="card-premium card-flat cj-panel">
            <h3 class="cj-card-title">Cobrando sin caja abierta ligada <span class="muted">(handoff o caja no reportada)</span></h3>
            <p-table [value]="d.cajeros_sin_sesion" styleClass="p-datatable-sm cj-table" [rowHover]="true">
              <ng-template #header><tr><th>Sucursal</th><th>Cajera</th><th class="ta-r">Tickets</th><th class="ta-r">Venta</th><th>Último</th></tr></ng-template>
              <ng-template #body let-x>
                <tr><td>{{ branchLabelOf(x.warehouse_code) }}</td><td>{{ x.cajero }}</td><td class="ta-r">{{ x.tickets | number }}</td><td class="ta-r strong">{{ money(x.venta) }}</td><td class="mono">{{ x.last_ticket }}</td></tr>
              </ng-template>
            </p-table>
          </div>
        }
        <p class="cj-foot muted">Actualizado {{ hora(d.generated_at) }} · auto-refresh 30s</p>
      } @else {
        <p class="cj-empty">{{ loading() ? 'Cargando…' : (error() ? 'No se pudo cargar.' : 'Sin datos.') }}</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cj-head-right { display: inline-flex; align-items: center; gap: .5rem; margin-left: auto; }
    .cj-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action); }
    .cj-alerta { display: flex; gap: .7rem; align-items: flex-start; padding: .8rem .9rem; margin-bottom: 1rem;
                 border: 1px solid color-mix(in srgb, var(--warn-fg, #b45309) 40%, transparent);
                 background: color-mix(in srgb, var(--warn-fg, #b45309) 8%, transparent); border-radius: var(--r-md); }
    .cj-alerta i { color: var(--warn-fg, #b45309); margin-top: .15rem; }
    .cj-alerta p { margin: .2rem 0 0; font-size: .8rem; }
    .cj-arrastrada { display: block; font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--bad-fg); }
    .cj-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
    .cj-kpi { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: 1rem; }
    .cj-kpi-v { display: block; font-size: 1.6rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .cj-kpi-l { display: block; font-size: .72rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); margin-top: .2rem; }
    .cj-table { font-variant-numeric: tabular-nums; }
    .cj-idle td { opacity: .72; }
    .cj-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: .4rem; vertical-align: middle; }
    .cj-dot.ok { background: var(--ok-fg, #16a34a); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok-fg, #16a34a) 20%, transparent); }
    .cj-dot.warn { background: #d97706; } .cj-dot.off { background: var(--text-muted); }
    .cj-st { font-size: .78rem; font-weight: 600; } .cj-st.ok { color: var(--ok-fg, #16a34a); } .cj-st.warn { color: #b45309; }
    .cj-code { font-size: .7rem; font-family: var(--font-mono, ui-monospace, monospace); }
    .cj-panel { padding: 1rem; margin-top: 1rem; }
    .cj-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    .cj-foot { font-size: .72rem; margin-top: .8rem; }
    .cj-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .cj-rank { display: inline-flex; align-items: center; justify-content: center; min-width: 1.4rem; height: 1.4rem; padding: 0 .35rem; border-radius: var(--r-sm, 6px); font-size: .78rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .cj-rank.top { color: var(--action); background: color-mix(in srgb, var(--action) 12%, transparent); }
    .ta-c { text-align: center; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); } .ok { color: var(--ok-fg, #16a34a); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
  `],
})
export class TiendaCajasComponent implements OnInit, OnDestroy {
  private readonly svc = inject(StoreSocketService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly scoped = this.auth.user()?.warehouse_code || '';
  readonly branchLabel = computed(() => branchName(this.scoped));
  readonly data = signal<OpenCajasResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit() { this.load(); this.timer = setInterval(() => this.load(), 30000); }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }

  load() {
    this.loading.set(true);
    this.svc.openCajas(this.scoped || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); this.error.set(false); },
      error: () => { this.loading.set(false); this.error.set(true); },
    });
  }

  totalVenta(d: OpenCajasResponse): number { return d.open_cajas.reduce((s, c) => s + (c.venta || 0), 0); }
  branchLabelOf(code: string): string { return branchName(code) || code; }
  money(v: number | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  hora(ts: string): string { try { return new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
}
