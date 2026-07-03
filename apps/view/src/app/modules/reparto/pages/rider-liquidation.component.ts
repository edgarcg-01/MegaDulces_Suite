import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  FleetDriver,
  HomeDeliveryKpis,
  PendingPayment,
  RiderLiquidation,
  RiderLiquidationService,
} from './rider-liquidation.service';

const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

/**
 * LM.7 — Encargado: corte de caja del repartidor con ARQUEO por denominación.
 * Abre/ve el corte del día, muestra lo esperado (computado de los cobros) y al
 * capturar el arqueo calcula la diferencia; cierra el corte.
 */
@Component({
  selector: 'app-rider-liquidation',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="liq">
      <h1>Corte de caja del repartidor</h1>

      @if (kpis(); as k) {
        <div class="card">
          <h2>KPIs del día ({{ businessDate }})</h2>
          <div class="kpis">
            <div><span>Entregas</span><b>{{ k.delivered }}/{{ k.deliveries_total }}</b></div>
            <div><span>Éxito</span><b [class.bad]="k.success_rate_pct < 98 && k.deliveries_total > 0">{{ k.success_rate_pct }}%</b></div>
            <div><span>Incidencias</span><b [class.bad]="k.incident_rate_pct > 2">{{ k.incident_rate_pct }}%</b></div>
            <div><span>Tiempo prom.</span><b [class.bad]="(k.avg_delivery_min || 0) > 60">{{ k.avg_delivery_min ?? '—' }} min</b></div>
            <div><span>Dif. efectivo</span><b [class.bad]="k.cash_difference_abs !== 0">{{ money(k.cash_difference_abs) }}</b></div>
          </div>
        </div>
      }

      <div class="card">
        <div class="grid3">
          <label>Fecha<input type="date" [(ngModel)]="businessDate" (change)="refreshList()" /></label>
          <label>Repartidor
            <select [(ngModel)]="riderUserId">
              <option value="">— elegir —</option>
              @for (d of riders(); track d.id) { <option [value]="d.user_id">{{ d.full_name }}</option> }
            </select>
          </label>
          <label class="btn-wrap">
            <button class="primary" (click)="openCorte()" [disabled]="!riderUserId || busy()">Abrir / ver corte</button>
          </label>
        </div>
        @if (error()) { <p class="err">{{ error() }}</p> }
      </div>

      @if (corte(); as c) {
        <div class="card">
          <div class="corte-head">
            <strong>{{ c.folio || 'Corte' }}</strong>
            <span class="status" [attr.data-s]="c.status">{{ c.status }}</span>
          </div>
          <div class="kpis">
            <div><span>Entregas</span><b>{{ c.deliveries_count }}</b></div>
            <div><span>Efectivo esperado</span><b>{{ money(c.cash_expected) }}</b></div>
            <div><span>Tarjeta</span><b>{{ money(c.card_total) }}</b></div>
            <div><span>Transferencia</span><b>{{ money(c.transfer_total) }}</b></div>
            <div><span>Incidencias</span><b>{{ c.incidents_count }}</b></div>
          </div>

          @if (c.status === 'open') {
            <h2>Arqueo (billetes y monedas)</h2>
            <div class="arqueo">
              @for (d of denoms; track d) {
                <label>{{ money(d) }}<input type="number" min="0" [ngModel]="counts[d] || 0" (ngModelChange)="setCount(d, $event)" /></label>
              }
            </div>
            <div class="arqueo-total">
              <span>Contado: <b>{{ money(counted()) }}</b></span>
              <span [class.bad]="difference() !== 0">Diferencia: <b>{{ money(difference()) }}</b></span>
            </div>
            @if (closeError()) { <p class="err">{{ closeError() }}</p> }
            <button class="primary" (click)="closeCorte()" [disabled]="busy()">Cerrar corte</button>
          } @else {
            <div class="kpis">
              <div><span>Efectivo contado</span><b>{{ money(c.cash_counted) }}</b></div>
              <div><span>Diferencia</span><b [class.bad]="Number(c.cash_difference) !== 0">{{ money(c.cash_difference) }}</b></div>
            </div>
          }
        </div>
      }

      <div class="card">
        <h2>Transferencias / tarjetas por verificar</h2>
        @if (pending().length === 0) { <p class="muted">Nada pendiente.</p> }
        @for (p of pending(); track p.id) {
          <div class="row">
            <span>{{ p.payment_method }} · {{ p.reference || 's/ref' }}</span>
            <span>{{ money(p.amount) }}</span>
            <span>{{ p.order_id ? 'Pedido' : ('Folio ' + (p.kepler_folio || '')) }}</span>
            <button (click)="verify(p.id)" [disabled]="busy()">Verificar</button>
          </div>
        }
      </div>

      <div class="card">
        <h2>Cortes del día</h2>
        @if (list().length === 0) { <p class="muted">Sin cortes.</p> }
        @for (l of list(); track l.id) {
          <div class="row">
            <span>{{ l.folio }}</span>
            <span>{{ l.deliveries_count }} entregas</span>
            <span>{{ money(l.cash_counted ?? l.cash_expected) }}</span>
            <span class="status" [attr.data-s]="l.status">{{ l.status }}</span>
          </div>
        }
      </div>
    </section>
  `,
  styles: [`
    .liq { padding: 1.25rem; max-width: 820px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    h2 { font-size: .95rem; margin: 1rem 0 .5rem; }
    .card { border: 1px solid var(--surf-border, #e5e5e5); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; background: var(--surf-card, #fff); }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr auto; gap: .75rem; align-items: end; }
    label { display: block; font-size: .82rem; color: var(--text-muted, #666); }
    .btn-wrap { align-self: end; }
    input, select { width: 100%; padding: .5rem; border: 1px solid var(--surf-border, #ddd); border-radius: 8px; font: inherit; box-sizing: border-box; }
    button { border: 1px solid var(--surf-border, #ddd); border-radius: 9px; padding: .55rem .9rem; background: #fff; cursor: pointer; font: inherit; }
    button.primary { background: var(--action, #ea580c); color: #fff; border-color: transparent; }
    .corte-head { display: flex; justify-content: space-between; margin-bottom: .6rem; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .5rem; }
    .kpis div { border: 1px solid var(--surf-border, #eee); border-radius: 8px; padding: .5rem; }
    .kpis span { display: block; font-size: .72rem; color: var(--text-muted, #888); }
    .kpis b { font-size: 1.05rem; }
    .arqueo { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: .5rem; }
    .arqueo-total { display: flex; gap: 1.5rem; margin: .75rem 0; }
    .arqueo-total .bad b, .kpis b.bad { color: #dc2626; }
    .row { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: .5rem; padding: .4rem 0; border-bottom: 1px solid var(--surf-border, #eee); font-size: .88rem; }
    .status { font-size: .72rem; text-transform: uppercase; }
    .muted { color: var(--text-muted, #888); }
    .err { color: #dc2626; font-size: .85rem; }
  `],
})
export class RiderLiquidationComponent implements OnInit {
  private readonly svc = inject(RiderLiquidationService);
  readonly Number = Number;
  readonly denoms = DENOMS;

  readonly riders = signal<FleetDriver[]>([]);
  readonly corte = signal<RiderLiquidation | null>(null);
  readonly list = signal<RiderLiquidation[]>([]);
  readonly pending = signal<PendingPayment[]>([]);
  readonly kpis = signal<HomeDeliveryKpis | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly closeError = signal<string | null>(null);

  businessDate = new Date().toISOString().slice(0, 10);
  riderUserId = '';
  counts: Record<number, number> = {};

  readonly counted = computed(() => {
    // trigger recompute via countsVersion signal
    this.countsVersion();
    return Math.round(DENOMS.reduce((s, d) => s + d * (this.counts[d] || 0), 0) * 100) / 100;
  });
  readonly difference = computed(() => {
    const c = this.corte();
    return Math.round((this.counted() - Number(c?.cash_expected || 0)) * 100) / 100;
  });
  private readonly countsVersion = signal(0);

  ngOnInit(): void {
    this.svc.listDrivers().subscribe({
      next: (d) => this.riders.set((d || []).filter((x) => !!x.user_id)),
      error: () => {},
    });
    this.refreshList();
    this.refreshPending();
  }

  refreshPending(): void {
    this.svc.pendingVerification().subscribe({ next: (p) => this.pending.set(p || []), error: () => {} });
  }

  verify(id: string): void {
    this.busy.set(true);
    this.svc.verifyPayment(id).subscribe({
      next: () => { this.busy.set(false); this.refreshPending(); },
      error: () => { this.busy.set(false); },
    });
  }

  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  setCount(denom: number, value: number): void {
    this.counts[denom] = Math.max(0, Math.floor(Number(value) || 0));
    this.countsVersion.update((v) => v + 1);
  }

  refreshList(): void {
    this.svc.list(this.businessDate).subscribe({ next: (r) => this.list.set(r || []), error: () => {} });
    this.svc.kpis(this.businessDate, this.businessDate).subscribe({ next: (k) => this.kpis.set(k), error: () => {} });
  }

  openCorte(): void {
    this.error.set(null);
    this.busy.set(true);
    this.svc.open({ rider_user_id: this.riderUserId, business_date: this.businessDate }).subscribe({
      next: (c) => {
        // Trae totales computados (preview) para mostrar lo esperado.
        this.svc.preview(c.id).subscribe({
          next: (p) => { this.corte.set(p); this.counts = {}; this.countsVersion.update((v) => v + 1); this.busy.set(false); },
          error: () => { this.corte.set(c); this.busy.set(false); },
        });
      },
      error: (e) => { this.error.set(e?.error?.message || 'No se pudo abrir el corte.'); this.busy.set(false); },
    });
  }

  closeCorte(): void {
    const c = this.corte();
    if (!c) return;
    this.closeError.set(null);
    const breakdown: Record<string, number> = {};
    for (const d of DENOMS) if (this.counts[d]) breakdown[String(d)] = this.counts[d];
    this.busy.set(true);
    this.svc.close(c.id, breakdown).subscribe({
      next: (closed) => { this.corte.set(closed); this.busy.set(false); this.refreshList(); },
      error: (e) => { this.closeError.set(e?.error?.message || 'No se pudo cerrar.'); this.busy.set(false); },
    });
  }
}
