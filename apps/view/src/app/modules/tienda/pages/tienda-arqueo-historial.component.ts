import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, ArqueoRow, ArqueoPorCajera } from '../arqueo.service';

/**
 * Tienda — Historial de arqueos (/tienda/arqueos).
 *
 * Dos preguntas distintas en una pantalla. Arriba, **por cajera**: a quién le
 * pasa seguido, cuánto acumula en faltantes y cuántos le faltan de firmar —
 * faltantes y sobrantes van separados a propósito, porque una cajera con +$500 y
 * −$500 no cuadra en promedio, tiene dos errores. Abajo, el **detalle**: cada
 * arqueo con lo que declaró Kepler, lo que contamos, quién lo capturó y **quién
 * lo validó**.
 *
 * Mismo recorte que el resto del arqueo: la cajera ve solo lo suyo y sin cuadre
 * (el backend no le manda esos campos, ni sueltos ni sumados); la encargada ve su
 * tienda completa y puede firmar desde acá.
 */
@Component({
  selector: 'app-tienda-arqueo-historial',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, TagModule, DatePickerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ah-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Historial de arqueos</h1>
          <p class="surf-page-sub">
            @if (revela) { Quién contó, cuánto, y <strong>quién se lo validó</strong>. Acumulado por cajera y detalle arqueo por arqueo. }
            @else { Tus arqueos, con la fecha en que tu encargada los validó. }
          </p>
        </div>
        <div class="ah-head-right">
          <label class="ah-lbl">Desde
            <p-datepicker [(ngModel)]="desde" (ngModelChange)="load()" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" inputStyleClass="ah-fld" />
          </label>
          <label class="ah-lbl">Hasta
            <p-datepicker [(ngModel)]="hasta" (ngModelChange)="load()" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" inputStyleClass="ah-fld" />
          </label>
          <button pButton type="button" class="p-button-sm p-button-text" [class.ah-on]="soloPendientes()" (click)="togglePendientes()">
            <span class="p-button-icon p-button-icon-left pi pi-flag" aria-hidden="true"></span>
            <span class="p-button-label">Solo sin validar</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="loading()" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <div class="ah-kpis">
        <div class="ah-kpi"><span class="ah-kpi-v">{{ totales().arqueos }}</span><span class="ah-kpi-l">Arqueos</span></div>
        <div class="ah-kpi"><span class="ah-kpi-v" [class.bad]="totales().sin_validar > 0">{{ totales().sin_validar }}</span><span class="ah-kpi-l">Sin validar</span></div>
        @if (revela) {
          <div class="ah-kpi"><span class="ah-kpi-v bad">{{ money(totales().faltante_total) }}</span><span class="ah-kpi-l">Faltantes acumulados</span></div>
          <div class="ah-kpi"><span class="ah-kpi-v ok">{{ money(totales().sobrante_total) }}</span><span class="ah-kpi-l">Sobrantes acumulados</span></div>
        }
      </div>

      @if (revela) {
        <div class="card-premium card-flat ah-panel">
          <h3 class="ah-card-title">Por cajera <span class="muted">— tocá una fila para ver solo sus arqueos</span></h3>
          <p-table [value]="porCajera()" styleClass="p-datatable-sm ah-table" [rowHover]="true" [loading]="loading()">
            <ng-template #header>
              <tr>
                <th>Cajera</th><th>Sucursal</th><th class="ta-r">Arqueos</th><th class="ta-r">Contado</th>
                <th class="ta-r">Con diferencia</th><th class="ta-r">Faltantes</th><th class="ta-r">Sobrantes</th>
                <th class="ta-r">Sin validar</th><th>Último</th>
              </tr>
            </ng-template>
            <ng-template #body let-g>
              <tr class="ah-row" [class.sel]="g.cajero_code === cajeroSel()" (click)="filtrarCajera(g.cajero_code)">
                <td class="strong">{{ g.cajero_nombre || g.cajero_code || '—' }}</td>
                <td>{{ branchLabel(g.warehouse_code) }}</td>
                <td class="ta-r">{{ g.arqueos }}</td>
                <td class="ta-r">{{ money(g.total_contado) }}</td>
                <td class="ta-r">{{ g.con_diferencia }}</td>
                <td class="ta-r strong" [class.bad]="g.faltante_total > 0">{{ g.faltante_total ? money(g.faltante_total) : '—' }}</td>
                <td class="ta-r" [class.ok]="g.sobrante_total > 0">{{ g.sobrante_total ? money(g.sobrante_total) : '—' }}</td>
                <td class="ta-r" [class.bad]="g.sin_validar > 0">{{ g.sin_validar || '—' }}</td>
                <td>{{ g.ultima_fecha | date:'dd/MM/yy' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="9" class="ah-empty">Sin arqueos en el rango.</td></tr></ng-template>
          </p-table>
        </div>
      }

      <div class="card-premium card-flat ah-panel">
        <h3 class="ah-card-title">
          Detalle
          @if (cajeroSel()) { <span class="ah-chip">{{ cajeroSel() }} <button type="button" class="ah-x" (click)="filtrarCajera(null)" aria-label="Quitar filtro">✕</button></span> }
        </h3>
        <p-table [value]="filas()" styleClass="p-datatable-sm ah-table" [rowHover]="true" [loading]="loading()">
          <ng-template #header>
            <tr>
              <th>Fecha</th><th>Sucursal</th><th>Caja</th><th>Cajera</th>
              @if (revela) {
                <th class="ta-r">Esperado</th><th class="ta-r">Arqueo Kepler</th>
              }
              <th class="ta-r">Nuestro arqueo</th>
              @if (revela) { <th class="ta-r">Diferencia</th> }
              <th>Capturó</th><th>Validó</th>
            </tr>
          </ng-template>
          <ng-template #body let-b>
            <tr>
              <td>{{ b.business_date | date:'dd/MM/yy' }}</td>
              <td>{{ branchLabel(b.warehouse_code) }}</td>
              <td>{{ b.caja }}@if (b.tipo === 'relevo') { <p-tag value="Relevo" severity="info" styleClass="ah-tag-mini" /> }</td>
              <td>{{ b.cajero_nombre || b.cajero_code || '—' }}</td>
              @if (revela) {
                <td class="ta-r muted">{{ b.esperado != null ? money(b.esperado) : '—' }}</td>
                <td class="ta-r">{{ b.kepler_contado != null ? money(b.kepler_contado) : '—' }}@if (b.kepler_enmascaro) { <span class="ah-mask">enmascaró</span> }</td>
              }
              <td class="ta-r strong">{{ money(b.total_contado) }}</td>
              @if (revela) {
                <td class="ta-r strong" [class.bad]="(b.diff_real||0)>0" [class.ok]="(b.diff_real||0)<0">
                  {{ b.diff_real != null ? signed(b.diff_real) : '—' }}
                  @if (b.diff_real != null && b.diff_real !== 0) { <span class="ah-dif-l">{{ b.diff_real > 0 ? 'faltan' : 'sobran' }}</span> }
                </td>
              }
              <td class="muted">{{ b.captured_by || '—' }}<span class="ah-hora">{{ b.captured_at | date:'dd/MM HH:mm' }}</span></td>
              <td>
                @if (b.validado_at) {
                  <span class="ah-ok"><i class="pi pi-check-circle"></i> {{ b.validado_por }}</span>
                  <span class="ah-hora">{{ b.validado_at | date:'dd/MM HH:mm' }}</span>
                } @else if (revela) {
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="validando() === b.id" (click)="validar(b)">
                    <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Validar</span>
                  </button>
                } @else { <span class="muted">Pendiente</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td [attr.colspan]="colspan()" class="ah-empty">Sin arqueos en el rango.</td></tr></ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ah-head-right { display: inline-flex; align-items: flex-end; gap: .6rem; margin-left: auto; flex-wrap: wrap; }
    .ah-lbl { display: inline-flex; flex-direction: column; gap: .2rem; font-size: .72rem; color: var(--text-muted); }
    :host ::ng-deep .ah-fld { font-size: .8rem; padding: .3rem .5rem; width: 8.2rem; }
    :host ::ng-deep .ah-on { color: var(--action); font-weight: 700; }
    .ah-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .7rem; margin-bottom: 1rem; }
    .ah-kpi { padding: .8rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .ah-kpi-v { display: block; font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ah-kpi-l { display: block; font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-top: .15rem; }
    .ah-panel { padding: 1rem; margin-bottom: 1rem; }
    .ah-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    .ah-table { font-variant-numeric: tabular-nums; }
    :host ::ng-deep .ah-table .p-datatable-tbody > tr > td { padding: .3rem .55rem; }
    .ah-row { cursor: pointer; }
    .ah-row.sel { background: color-mix(in srgb, var(--action) 8%, transparent); }
    .ah-chip { display: inline-flex; align-items: center; gap: .3rem; margin-left: .4rem; font-size: .7rem; font-weight: 600;
               padding: .1rem .45rem; border-radius: 999px; background: color-mix(in srgb, var(--action) 12%, transparent); color: var(--action); }
    .ah-x { border: 0; background: none; cursor: pointer; color: inherit; font-size: .7rem; padding: 0 0 0 .1rem; }
    .ah-mask { display: inline-block; margin-left: .3rem; font-size: .6rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 700;
               padding: .05rem .28rem; border-radius: 4px; color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .ah-dif-l { display: block; font-size: .6rem; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
    .ah-ok { display: inline-flex; align-items: center; gap: .25rem; font-size: .76rem; color: var(--ok-fg); font-weight: 600; }
    .ah-hora { display: block; font-size: .62rem; color: var(--text-muted); }
    :host ::ng-deep .ah-tag-mini { margin-left: .3rem; transform: scale(.8); }
    .ah-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); } .ok { color: var(--ok-fg); }
  `],
})
export class TiendaArqueoHistorialComponent implements OnInit {
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Espeja la regla del backend: solo quien valida ve el cuadre. */
  readonly revela = this.perms.can('manage', 'all')
    || this.auth.user()?.permissions?.[Permission.RECONCILIATION_VER] === true;

  readonly porCajera = signal<ArqueoPorCajera[]>([]);
  readonly arqueos = signal<ArqueoRow[]>([]);
  readonly totales = signal<{ arqueos: number; sin_validar: number; faltante_total?: number; sobrante_total?: number }>({ arqueos: 0, sin_validar: 0 });
  readonly loading = signal(false);
  readonly validando = signal<string | null>(null);
  readonly cajeroSel = signal<string | null>(null);
  readonly soloPendientes = signal(false);

  /** Por default, el mes en curso: el rango que se mira al cerrar quincena. */
  hasta: Date = new Date();
  desde: Date = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  /** El filtro por cajera es local: la tabla ya vino completa, no hace falta ir al server. */
  readonly filas = computed(() => {
    const c = this.cajeroSel();
    return c ? this.arqueos().filter((a) => a.cajero_code === c) : this.arqueos();
  });
  readonly colspan = computed(() => 6 + (this.revela ? 3 : 0));

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.svc.historial({
      from: this.fmt(this.desde), to: this.fmt(this.hasta),
      sin_validar: this.soloPendientes() || undefined, limit: 500,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.porCajera.set(r.por_cajera || []);
        this.arqueos.set(r.arqueos || []);
        this.totales.set(r.totales || { arqueos: 0, sin_validar: 0 });
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  togglePendientes() { this.soloPendientes.set(!this.soloPendientes()); this.load(); }
  filtrarCajera(code: string | null) { this.cajeroSel.set(this.cajeroSel() === code ? null : code); }

  validar(b: ArqueoRow) {
    if (this.validando()) return;
    this.validando.set(b.id);
    this.svc.validar(b.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.validando.set(null);
        this.toast.add({ severity: 'success', summary: 'Arqueo validado', detail: `Caja ${b.caja} · ${this.money(b.total_contado)}` });
        this.load();
      },
      error: (e) => { this.validando.set(null); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo validar.' }); },
    });
  }

  branchLabel(code?: string | null): string { return branchName(code); }

  /** Fecha local → 'YYYY-MM-DD' sin corrimiento de TZ (§10: no re-convertir). */
  private fmt(d: Date): string {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  signed(v: number): string { return (v > 0 ? '+' : '') + this.money(v); }
}
