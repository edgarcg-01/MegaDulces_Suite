import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, ArqueoResult, ArqueoRow } from '../arqueo.service';

/**
 * Proyecto Tienda — Arqueo ciego de caja para CAJERAS (/tienda/arqueo).
 *
 * La cajera cuenta el efectivo por denominación SIN ver el esperado; al guardar, el
 * sistema revela SU diferencia real. Scopeada a su sucursal (del login). No muestra la
 * inteligencia de enmascaramiento de Kepler — eso vive en /almacen/cuadre (supervisor).
 * Superficie Operations, PrimeNG denso, dark-safe.
 */
@Component({
  selector: 'app-tienda-arqueo',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule],
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
        @if (scopedWarehouse) { <span class="arq-scope"><i class="pi pi-map-marker"></i> {{ branchLabel() }}</span> }
      </header>

      <div class="arq-2col">
        <!-- Captura -->
        <div class="card-premium card-flat arq-panel">
          <h3 class="arq-card-title">Nuevo arqueo</h3>
          <div class="arq-seg">
            <button [class.active]="aTipo() === 'cierre'" (click)="aTipo.set('cierre')">Cierre de día</button>
            <button [class.active]="aTipo() === 'relevo'" (click)="aTipo.set('relevo')">Relevo (cambio de turno)</button>
          </div>
          <div class="arq-head">
            @if (!scopedWarehouse) { <label class="arq-lbl">Sucursal <input class="arq-input arq-input-sm" [(ngModel)]="aSuc" placeholder="03"></label> }
            <label class="arq-lbl">Caja <input class="arq-input arq-input-sm" [(ngModel)]="aCaja" placeholder="2"></label>
            <label class="arq-lbl">Fecha <input class="arq-input arq-input-date" type="date" [(ngModel)]="aDate"></label>
            <label class="arq-lbl">{{ aTipo() === 'relevo' ? 'Cajero saliente' : 'Cajero' }} <input class="arq-input arq-input-sm" [(ngModel)]="aCajero" placeholder="opcional"></label>
            @if (aTipo() === 'relevo') { <label class="arq-lbl">Cajero entrante <input class="arq-input arq-input-sm" [(ngModel)]="aEntrante" placeholder="opcional"></label> }
          </div>
          <table class="arq-denoms">
            <tr><th>Denominación</th><th class="ta-r">Cantidad</th><th class="ta-r">Subtotal</th></tr>
            @for (d of denoms; track d) {
              <tr>
                <td>{{ d >= 1 ? '$' + d : (d*100) + '¢' }}</td>
                <td class="ta-r"><input class="arq-input arq-input-xs" type="number" min="0" inputmode="numeric" [(ngModel)]="denomCount[d]" (ngModelChange)="recalc()"></td>
                <td class="ta-r muted">{{ money((denomCount[d] || 0) * d) }}</td>
              </tr>
            }
            <tr class="arq-total-row"><td>Total contado</td><td></td><td class="ta-r strong">{{ money(arqTotal()) }}</td></tr>
          </table>
          <label class="arq-lbl arq-block">Nota <input class="arq-input" [(ngModel)]="aNota" placeholder="opcional"></label>
          <button pButton type="button" [label]="aTipo() === 'relevo' ? 'Sellar relevo' : 'Guardar y revelar diferencia'" icon="pi pi-lock-open" class="p-button-sm"
                  [disabled]="!canSubmit()" [loading]="saving()" (click)="submit()"></button>

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
                <td><span class="arq-tag">{{ b.tipo === 'relevo' ? 'Relevo' : 'Cierre' }}</span></td>
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
    .arq-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action, #F05A28); margin-left: auto; }
    .arq-scope i { font-size: .72rem; }
    .arq-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 900px) { .arq-2col { grid-template-columns: 1fr; } }
    .arq-panel { padding: 1rem; }
    .arq-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    .arq-seg { display: inline-flex; border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-pill, 999px); overflow: hidden; margin-bottom: .7rem; }
    .arq-seg button { border: none; background: var(--card-bg, #fff); padding: .3rem .8rem; font-size: .78rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .arq-seg button.active { background: var(--action, #F05A28); color: var(--action-ink, #fff); font-weight: 600; }
    .arq-head { display: flex; gap: .8rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .arq-lbl { display: inline-flex; align-items: center; gap: .3rem; font-size: .76rem; color: var(--text-muted, #57534e); }
    .arq-input { border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-sm, 8px); padding: .35rem .6rem; font-size: .82rem; background: var(--card-bg, #fff); color: var(--text-main, inherit); }
    .arq-input-sm { width: 5.5rem; } .arq-input-date { padding: .28rem .45rem; }
    .arq-input-xs { width: 5rem; padding: .25rem .4rem; text-align: right; font-variant-numeric: tabular-nums; }
    .arq-block { display: block; margin: .8rem 0; }
    .arq-denoms { width: 100%; border-collapse: collapse; font-size: .84rem; font-variant-numeric: tabular-nums; }
    .arq-denoms th { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); font-weight: 600; padding: .25rem .4rem; text-align: left; }
    .arq-denoms td { padding: .2rem .4rem; border-top: 1px solid var(--border-color, #eee); }
    .arq-total-row td { border-top: 2px solid var(--border-color, #ddd); font-weight: 700; }
    .arq-result { margin-top: 1rem; padding: .9rem; border-radius: var(--r-md, 10px); border: 1px solid var(--border-color, #e7e5e4); background: var(--surface-hover-bg, #fafaf9); }
    .arq-result.bad { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 40%, transparent); background: color-mix(in srgb, var(--bad-fg, #dc2626) 6%, transparent); }
    .arq-result.ok { border-color: color-mix(in srgb, var(--ok-fg, #16a34a) 40%, transparent); background: color-mix(in srgb, var(--ok-fg, #16a34a) 6%, transparent); }
    .arq-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: .6rem 1rem; }
    .arq-ev-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); display: block; }
    .arq-ev-v { font-size: .95rem; font-variant-numeric: tabular-nums; }
    .arq-table { font-variant-numeric: tabular-nums; }
    .arq-tag { display: inline-block; padding: .08rem .5rem; border-radius: 999px; font-size: .68rem; font-weight: 600; background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #57534e); }
    .arq-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted, #78716c); }
    .bad { color: var(--bad-fg, #dc2626); } .ok { color: var(--ok-fg, #16a34a); }
  `],
})
export class TiendaArqueoComponent implements OnInit {
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal fija por login ('' = rol global que puede elegir sucursal). */
  readonly scopedWarehouse = this.auth.user()?.warehouse_code || '';
  readonly branchLabel = computed(() => branchName(this.scopedWarehouse));

  readonly denoms = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
  denomCount: Record<number, number> = {};
  readonly aTipo = signal<'cierre' | 'relevo'>('cierre');
  aSuc = ''; aCaja = ''; aDate = ''; aCajero = ''; aEntrante = ''; aNota = '';
  readonly arqTotal = signal(0);
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly result = signal<ArqueoResult | null>(null);
  readonly rows = signal<ArqueoRow[]>([]);

  ngOnInit() {
    this.aDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    this.load();
  }

  canSubmit(): boolean {
    const suc = this.scopedWarehouse || this.aSuc.trim();
    return !!suc && !!this.aCaja.trim() && !!this.aDate && this.arqTotal() > 0;
  }

  recalc() { this.arqTotal.set(this.denoms.reduce((s, d) => s + (Number(this.denomCount[d]) || 0) * d, 0)); }

  submit() {
    this.saving.set(true);
    const denominations: Record<string, number> = {};
    for (const d of this.denoms) { const n = Number(this.denomCount[d]) || 0; if (n > 0) denominations[String(d)] = n; }
    const relevo = this.aTipo() === 'relevo';
    this.svc.submit({
      warehouse_code: this.scopedWarehouse || this.aSuc.trim() || undefined,
      caja: this.aCaja.trim(), business_date: this.aDate, tipo: this.aTipo(),
      cajero_code: this.aCajero.trim() || undefined,
      cajero_entrante: relevo ? (this.aEntrante.trim() || undefined) : undefined,
      denominations, nota: this.aNota.trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false); this.result.set(r);
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

  diffLabel(diff: number | null): string {
    if (diff == null) return 'Diferencia';
    if (diff > 0) return 'Faltante';
    if (diff < 0) return 'Sobrante';
    return 'Cuadrado';
  }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  signed(v: number): string { return (v > 0 ? '+' : '') + this.money(v); }
}
