import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectButtonModule } from 'primeng/selectbutton';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, ArqueoResult, ArqueoRow } from '../arqueo.service';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';

/**
 * Proyecto Tienda — Arqueo ciego de caja para CAJERAS (/tienda/arqueo).
 *
 * La cajera cuenta el efectivo por denominación SIN ver el esperado; al guardar, el
 * sistema revela SU diferencia real. Scopeada a su sucursal (del login). No muestra la
 * inteligencia de enmascaramiento de Kepler — eso vive en /almacen/cuadre (supervisor).
 * Superficie Operations, PrimeNG denso, dark-safe. §13: captura de dinero → guard de
 * estado sucio + botón que se auto-deshabilita síncrono al 1er clic (anti doble-corte).
 */
@Component({
  selector: 'app-tienda-arqueo',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, ToastModule,
    SelectButtonModule, InputTextModule, InputNumberModule, DatePickerModule, TagModule,
    ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in arq-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueo de caja</h1>
          <p class="surf-page-sub">Contá el efectivo físico por denominación <strong>sin ver el esperado</strong>. Al guardar, el sistema te muestra tu diferencia real.</p>
        </div>
        <div class="arq-head-right">
          @if (scopedWarehouse) { <span class="arq-scope"><i class="pi pi-map-marker"></i> {{ branchLabel() }}</span> }
          <app-context-help topic="arqueo" />
        </div>
      </header>

      <div class="arq-2col">
        <!-- Captura -->
        <div class="card-premium card-flat arq-panel">
          <h3 class="arq-card-title">Nuevo arqueo</h3>
          <p-selectButton [options]="tipoOptions" [ngModel]="aTipo()" (ngModelChange)="aTipo.set($event); dirty.set(true)"
                          optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="sb-liquid arq-seg" />

          <div class="arq-head">
            @if (!scopedWarehouse) {
              <label class="arq-lbl">Sucursal <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aSuc" (ngModelChange)="dirty.set(true)" placeholder="03"></label>
            }
            <label class="arq-lbl">Caja <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCaja" (ngModelChange)="dirty.set(true)" placeholder="2"></label>
            <label class="arq-lbl">Fecha
              <p-datepicker [(ngModel)]="aDate" (ngModelChange)="dirty.set(true)" dateFormat="dd/mm/yy"
                            [showIcon]="true" appendTo="body" styleClass="arq-date" inputStyleClass="arq-fld" />
            </label>
            <label class="arq-lbl">{{ aTipo() === 'relevo' ? 'Cajero saliente' : 'Cajero' }} <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCajero" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label>
            @if (aTipo() === 'relevo') { <label class="arq-lbl">Cajero entrante <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aEntrante" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label> }
          </div>

          <p-table [value]="denoms" styleClass="p-datatable-sm arq-denoms-tbl">
            <ng-template pTemplate="header">
              <tr><th>Denominación</th><th class="ta-r">Cantidad</th><th class="ta-r">Subtotal</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-d>
              <tr>
                <td class="arq-denom-lbl">{{ d >= 1 ? '$' + d : (d*100) + '¢' }}</td>
                <td class="ta-r">
                  <p-inputNumber [(ngModel)]="denomCount[d]" (ngModelChange)="recalc()" [min]="0" [showButtons]="false"
                                 [useGrouping]="false" inputmode="numeric" inputStyleClass="arq-num" [placeholder]="'0'" />
                </td>
                <td class="ta-r muted">{{ money((denomCount[d] || 0) * d) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="footer">
              <tr class="arq-total-row"><td>Total contado</td><td></td><td class="ta-r strong">{{ money(arqTotal()) }}</td></tr>
            </ng-template>
          </p-table>

          <label class="arq-lbl arq-block">Nota <input pInputText class="arq-fld" [(ngModel)]="aNota" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label>
          <button pButton type="button" [label]="aTipo() === 'relevo' ? 'Sellar relevo' : 'Guardar y revelar diferencia'" icon="pi pi-lock-open" class="p-button-sm"
                  [disabled]="!canSubmit() || saving()" [loading]="saving()" (click)="submit()"></button>

          @if (result(); as r) {
            <div class="arq-result" [class.bad]="(r.diff_real || 0) > 0" [class.ok]="(r.diff_real || 0) < 0">
              @if (r.tipo === 'relevo') {
                <p class="muted">Relevo sellado: {{ money(r.total_contado) }} entregados de {{ aCajero || '—' }} → {{ aEntrante || '—' }}.</p>
              } @else if (!r.matched) {
                <p class="muted">Guardado. Todavía no hay corte del sistema para comparar — la diferencia aparecerá cuando se procese.</p>
              } @else {
                <div class="arq-cmp">
                  <div><span class="arq-ev-k">Contado</span><span class="arq-ev-v strong">{{ money(r.total_contado) }}</span></div>
                  <div><span class="arq-ev-k">Esperado</span><span class="arq-ev-v">{{ money(r.esperado || 0) }}</span></div>
                  <div><span class="arq-ev-k">{{ diffLabel(r.diff_real) }}</span><span class="arq-ev-v strong" [class.bad]="(r.diff_real||0)>0" [class.ok]="(r.diff_real||0)<0">{{ signed(r.diff_real || 0) }}</span></div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Historial -->
        <div class="card-premium card-flat arq-panel">
          <h3 class="arq-card-title">Arqueos recientes</h3>
          <p-table [value]="rows()" styleClass="p-datatable-sm arq-table" [rowHover]="true" [loading]="loading()">
            <ng-template pTemplate="header"><tr><th>Fecha</th><th>Tipo</th><th>Caja</th><th>Cajero</th><th class="ta-r">Contado</th><th class="ta-r">Diferencia</th></tr></ng-template>
            <ng-template pTemplate="body" let-b>
              <tr>
                <td>{{ b.business_date | date:'dd/MM/yy' }}</td>
                <td><p-tag [value]="b.tipo === 'relevo' ? 'Relevo' : 'Cierre'" [severity]="b.tipo === 'relevo' ? 'info' : 'secondary'" /></td>
                <td>{{ b.caja }}</td>
                <td>{{ b.cajero_nombre || b.cajero_code || '—' }}@if (b.tipo === 'relevo' && b.cajero_entrante) { <span class="muted"> → {{ b.cajero_entrante }}</span> }</td>
                <td class="ta-r">{{ money(b.total_contado) }}</td>
                <td class="ta-r strong" [class.bad]="(b.diff_real||0)>0" [class.ok]="(b.diff_real||0)<0">{{ b.diff_real != null ? signed(b.diff_real) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="arq-empty">Sin arqueos aún. Capturá el primero a la izquierda.</td></tr></ng-template>
          </p-table>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .arq-head-right { display: inline-flex; align-items: center; gap: .4rem; margin-left: auto; }
    .arq-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action); }
    .arq-scope i { font-size: .72rem; }
    .arq-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 900px) { .arq-2col { grid-template-columns: 1fr; } }
    .arq-panel { padding: 1rem; }
    .arq-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    :host ::ng-deep .arq-seg { margin-bottom: .7rem; }
    .arq-head { display: flex; gap: .8rem; flex-wrap: wrap; margin: .8rem 0; align-items: flex-end; }
    .arq-lbl { display: inline-flex; flex-direction: column; gap: .2rem; font-size: .76rem; color: var(--text-muted); }
    :host ::ng-deep .arq-fld { font-size: .82rem; padding: .35rem .6rem; }
    :host ::ng-deep .arq-fld-sm { width: 5.5rem; }
    :host ::ng-deep .arq-num { width: 5rem; text-align: right; font-variant-numeric: tabular-nums; padding: .25rem .4rem; }
    :host ::ng-deep .arq-date .p-datepicker-input { width: 8.5rem; }
    .arq-block { display: block; margin: .8rem 0; }
    :host ::ng-deep .arq-block .arq-fld { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-denoms-tbl { font-variant-numeric: tabular-nums; margin-bottom: .8rem; }
    :host ::ng-deep .arq-denoms-tbl .p-datatable-tbody > tr > td { padding: .2rem .5rem; }
    .arq-denom-lbl { font-variant-numeric: tabular-nums; }
    :host ::ng-deep .arq-total-row td { border-top: 2px solid var(--border-color); font-weight: 700; }
    .arq-result { margin-top: 1rem; padding: .9rem; border-radius: var(--r-md); border: 1px solid var(--border-color); background: var(--surface-hover-bg); }
    .arq-result.bad { border-color: color-mix(in srgb, var(--bad-fg) 40%, transparent); background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .arq-result.ok { border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); background: color-mix(in srgb, var(--ok-fg) 6%, transparent); }
    .arq-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: .6rem 1rem; }
    .arq-ev-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); display: block; }
    .arq-ev-v { font-size: .95rem; font-variant-numeric: tabular-nums; }
    .arq-table { font-variant-numeric: tabular-nums; }
    .arq-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); } .ok { color: var(--ok-fg); }
  `],
})
export class TiendaArqueoComponent implements OnInit, HasUnsavedChanges {
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal fija por login ('' = rol global que puede elegir sucursal). */
  readonly scopedWarehouse = this.auth.user()?.warehouse_code || '';
  readonly branchLabel = computed(() => branchName(this.scopedWarehouse));

  readonly tipoOptions = [
    { label: 'Cierre de día', value: 'cierre' as const },
    { label: 'Relevo (cambio de turno)', value: 'relevo' as const },
  ];

  readonly denoms = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
  denomCount: Record<number, number> = {};
  readonly aTipo = signal<'cierre' | 'relevo'>('cierre');
  aSuc = ''; aCaja = ''; aDate: Date = new Date(); aCajero = ''; aEntrante = ''; aNota = '';
  readonly arqTotal = signal(0);
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly dirty = signal(false);
  readonly result = signal<ArqueoResult | null>(null);
  readonly rows = signal<ArqueoRow[]>([]);

  /** §13 estado sucio — hay conteo capturado sin guardar. */
  hasUnsavedChanges(): boolean { return this.dirty(); }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent) { if (this.hasUnsavedChanges()) e.preventDefault(); }

  ngOnInit() { this.load(); }

  canSubmit(): boolean {
    const suc = this.scopedWarehouse || this.aSuc.trim();
    return !!suc && !!this.aCaja.trim() && !!this.aDate && this.arqTotal() > 0;
  }

  recalc() {
    this.arqTotal.set(this.denoms.reduce((s, d) => s + (Number(this.denomCount[d]) || 0) * d, 0));
    this.dirty.set(this.arqTotal() > 0);
  }

  submit() {
    if (this.saving()) return; // §13 idempotencia visual: ignora re-clicks
    this.saving.set(true);
    const denominations: Record<string, number> = {};
    for (const d of this.denoms) { const n = Number(this.denomCount[d]) || 0; if (n > 0) denominations[String(d)] = n; }
    const relevo = this.aTipo() === 'relevo';
    this.svc.submit({
      warehouse_code: this.scopedWarehouse || this.aSuc.trim() || undefined,
      caja: this.aCaja.trim(), business_date: this.fmtDate(this.aDate), tipo: this.aTipo(),
      cajero_code: this.aCajero.trim() || undefined,
      cajero_entrante: relevo ? (this.aEntrante.trim() || undefined) : undefined,
      denominations, nota: this.aNota.trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false); this.result.set(r); this.dirty.set(false);
        const detail = r.tipo === 'relevo' ? `Relevo sellado (${this.money(r.total_contado)}).`
          : (r.matched ? `${this.diffLabel(r.diff_real)}: ${this.signed(r.diff_real || 0)}` : 'Guardado (sin corte para comparar aún).');
        this.toast.add({ severity: (r.diff_real || 0) > 0 ? 'warn' : 'success', summary: r.tipo === 'relevo' ? 'Relevo guardado' : 'Arqueo guardado', detail });
        this.load();
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  private load() {
    this.loading.set(true);
    this.svc.list({ limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.rows.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  /** Fecha local → 'YYYY-MM-DD' sin corrimiento de TZ (§10: no re-convertir). */
  private fmtDate(d: Date): string {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  diffLabel(diff: number | null): string {
    if (diff == null) return 'Diferencia';
    if (diff > 0) return 'Faltante';
    if (diff < 0) return 'Sobrante';
    return 'Cuadrado';
  }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  signed(v: number): string { return (v > 0 ? '+' : '') + this.money(v); }
}
