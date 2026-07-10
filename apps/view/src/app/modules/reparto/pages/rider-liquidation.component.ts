import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import {
  Rider,
  HomeDeliveryKpis,
  PendingPayment,
  RiderLiquidation,
  RiderLiquidationService,
} from '../rider-liquidation.service';

const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

/**
 * LM.7 — Encargado: corte de caja del repartidor con ARQUEO por denominación.
 * Abre/ve el corte del día, muestra lo esperado (computado de los cobros) y al
 * capturar el arqueo calcula la diferencia; cierra el corte.
 */
@Component({
  selector: 'app-rider-liquidation',
  standalone: true,
  imports: [
    CommonModule, FormsModule, SelectModule, DatePickerModule, InputNumberModule,
    TableModule, TagModule, ButtonModule,
  ],
  template: `
    <div class="surf-page in liq">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Corte de caja del repartidor</h1>
          <p class="surf-page-sub">Arqueo por denominación, diferencia de efectivo y verificación de pagos</p>
        </div>
      </header>

      @if (kpis(); as k) {
        <div class="liq-kpis">
          <div class="liq-kpi"><span>Entregas</span><b>{{ k.delivered }}/{{ k.deliveries_total }}</b></div>
          <div class="liq-kpi"><span>Éxito</span><b [class.bad]="k.success_rate_pct < 98 && k.deliveries_total > 0">{{ k.success_rate_pct }}%</b></div>
          <div class="liq-kpi"><span>Incidencias</span><b [class.bad]="k.incident_rate_pct > 2">{{ k.incident_rate_pct }}%</b></div>
          <div class="liq-kpi"><span>Tiempo prom.</span><b [class.bad]="(k.avg_delivery_min || 0) > 60">{{ k.avg_delivery_min ?? '—' }} min</b></div>
          <div class="liq-kpi"><span>Dif. efectivo</span><b [class.bad]="k.cash_difference_abs !== 0">{{ money(k.cash_difference_abs) }}</b></div>
        </div>
      }

      <!-- Selección de corte -->
      <div class="card-premium liq-card">
        <div class="liq-form">
          <div class="liq-field">
            <label for="bd">Fecha</label>
            <p-datePicker inputId="bd" [(ngModel)]="businessDate" dateFormat="dd/mm/yy" [showIcon]="true"
                          [maxDate]="today" appendTo="body" styleClass="liq-full" (onSelect)="refreshList()" (onClose)="refreshList()" />
          </div>
          <div class="liq-field">
            <label for="rider">Repartidor</label>
            <p-select inputId="rider" [options]="riders()" [(ngModel)]="riderUserId" optionLabel="full_name" optionValue="rider_user_id"
                      appendTo="body" styleClass="liq-full" placeholder="Elegí repartidor"
                      [filter]="riders().length > 8" filterBy="full_name" [emptyMessage]="'Sin repartidores'" />
          </div>
          <div class="liq-field liq-action">
            <button pButton label="Abrir / ver corte" icon="pi pi-folder-open"
                    [disabled]="!riderUserId" [loading]="busy()" (click)="openCorte()"></button>
          </div>
        </div>
        @if (error()) { <p class="liq-err"><i class="pi pi-exclamation-circle"></i> {{ error() }}</p> }
      </div>

      <!-- Corte activo -->
      @if (corte(); as c) {
        <div class="card-premium liq-card">
          <div class="liq-corte-head">
            <strong>{{ c.folio || 'Corte del día' }}</strong>
            <p-tag [value]="statusLabel(c.status)" [severity]="statusSeverity(c.status)" />
          </div>

          <div class="liq-kpis liq-kpis--inset">
            <div class="liq-kpi"><span>Entregas</span><b>{{ c.deliveries_count }}</b></div>
            <div class="liq-kpi"><span>Efectivo esperado</span><b>{{ money(c.cash_expected) }}</b></div>
            <div class="liq-kpi"><span>Tarjeta</span><b>{{ money(c.card_total) }}</b></div>
            <div class="liq-kpi"><span>Transferencia</span><b>{{ money(c.transfer_total) }}</b></div>
            <div class="liq-kpi"><span>Incidencias</span><b>{{ c.incidents_count }}</b></div>
          </div>

          @if (c.status === 'open') {
            <h2 class="liq-sectitle">Arqueo (billetes y monedas)</h2>
            <div class="liq-arqueo">
              @for (d of denoms; track d) {
                <div class="liq-denom">
                  <label [for]="'d' + d">{{ money(d) }}</label>
                  <p-inputNumber [inputId]="'d' + d" [ngModel]="counts[d] || 0" (ngModelChange)="setCount(d, $event)"
                                 [min]="0" [useGrouping]="false" styleClass="liq-full" inputStyleClass="liq-in" />
                </div>
              }
            </div>
            <div class="liq-arqueo-total">
              <span>Contado <b>{{ money(counted()) }}</b></span>
              <span class="liq-diff" [class.bad]="difference() !== 0">Diferencia <b>{{ money(difference()) }}</b></span>
            </div>
            @if (closeError()) { <p class="liq-err"><i class="pi pi-exclamation-circle"></i> {{ closeError() }}</p> }
            <div class="liq-actions">
              <button pButton label="Cerrar corte" icon="pi pi-check" [loading]="busy()" (click)="closeCorte()"></button>
            </div>
          } @else {
            <div class="liq-kpis liq-kpis--inset">
              <div class="liq-kpi"><span>Efectivo contado</span><b>{{ money(c.cash_counted) }}</b></div>
              <div class="liq-kpi"><span>Diferencia</span><b [class.bad]="num(c.cash_difference) !== 0">{{ money(c.cash_difference) }}</b></div>
            </div>
          }
        </div>
      }

      <!-- Pagos por verificar -->
      <div class="card-premium liq-card">
        <h2 class="liq-sectitle">Transferencias / tarjetas por verificar</h2>
        @if (pending().length === 0) {
          <p class="liq-muted">Nada pendiente.</p>
        } @else {
          <p-table [value]="pending()" styleClass="p-datatable-sm surf-table">
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Método</th>
                <th scope="col">Referencia</th>
                <th scope="col" class="comm-num">Monto</th>
                <th scope="col">Origen</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr>
                <td>{{ p.payment_method }}</td>
                <td>{{ p.reference || '—' }}</td>
                <td class="comm-num">{{ money(p.amount) }}</td>
                <td>{{ p.order_id ? 'Pedido' : ('Folio ' + (p.kepler_folio || '')) }}</td>
                <td class="comm-actions">
                  <button pButton label="Verificar" icon="pi pi-check" size="small" severity="secondary" [outlined]="true"
                          [disabled]="busy()" (click)="verify(p.id)"></button>
                </td>
              </tr>
            </ng-template>
          </p-table>
        }
      </div>

      <!-- Cortes del día -->
      <div class="card-premium liq-card">
        <h2 class="liq-sectitle">Cortes del día</h2>
        @if (list().length === 0) {
          <p class="liq-muted">Sin cortes.</p>
        } @else {
          <p-table [value]="list()" styleClass="p-datatable-sm surf-table">
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Folio</th>
                <th scope="col" class="comm-num">Entregas</th>
                <th scope="col" class="comm-num">Efectivo</th>
                <th scope="col">Estado</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-l>
              <tr>
                <td><code class="comm-code">{{ l.folio }}</code></td>
                <td class="comm-num">{{ l.deliveries_count }}</td>
                <td class="comm-num">{{ money(l.cash_counted ?? l.cash_expected) }}</td>
                <td><p-tag [value]="statusLabel(l.status)" [severity]="statusSeverity(l.status)" /></td>
              </tr>
            </ng-template>
          </p-table>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }

    .liq-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:.75rem; margin-bottom:1rem; }
    .liq-kpi { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.7rem .85rem; background:var(--card-bg); }
    .liq-kpi span { display:block; font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .liq-kpi b { display:block; font-size:1.15rem; font-weight:700; margin-top:.15rem; color:var(--text-main); font-variant-numeric:tabular-nums; }
    .liq-kpi b.bad { color:var(--bad-fg); }
    .liq-kpis--inset { margin:0 0 .5rem; }
    .liq-kpis--inset .liq-kpi { background:var(--layout-bg); }

    .liq-card { margin-bottom:1rem; }
    .liq-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; align-items:end; }
    .liq-field { display:flex; flex-direction:column; gap:.4rem; }
    .liq-field > label { font-size:.78rem; font-weight:600; color:var(--text-muted); }
    .liq-action { justify-content:flex-end; }
    :host ::ng-deep .liq-full { width:100%; }
    :host ::ng-deep .liq-full .p-inputnumber-input,
    :host ::ng-deep .liq-full .p-datepicker-input { width:100%; }

    .liq-corte-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .liq-corte-head strong { font-size:1rem; color:var(--text-main); }

    .liq-sectitle { font-size:.95rem; font-weight:700; color:var(--text-main); margin:1.25rem 0 .75rem; }
    .liq-sectitle:first-child { margin-top:0; }

    .liq-arqueo { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:.75rem; }
    .liq-denom { display:flex; flex-direction:column; gap:.3rem; }
    .liq-denom label { font-size:.78rem; font-weight:600; color:var(--text-muted); font-variant-numeric:tabular-nums; }
    :host ::ng-deep .liq-in { text-align:right; font-variant-numeric:tabular-nums; }

    .liq-arqueo-total { display:flex; flex-wrap:wrap; gap:1.5rem; margin:1rem 0; font-size:.95rem; }
    .liq-arqueo-total b { font-variant-numeric:tabular-nums; }
    .liq-diff.bad b { color:var(--bad-fg); }

    .liq-actions { margin-top:1rem; display:flex; gap:.6rem; flex-wrap:wrap; }
    .liq-err { color:var(--bad-fg); font-size:.85rem; margin:.75rem 0 0; display:flex; align-items:center; gap:.4rem; }
    .liq-muted { color:var(--text-muted); font-size:.9rem; margin:0; }

    @media (max-width:640px) {
      .liq-form { grid-template-columns:1fr; }
      .liq-action { justify-content:stretch; }
    }
  `],
})
export class RiderLiquidationComponent implements OnInit {
  private readonly svc = inject(RiderLiquidationService);
  readonly denoms = DENOMS;

  readonly riders = signal<Rider[]>([]);
  readonly corte = signal<RiderLiquidation | null>(null);
  readonly list = signal<RiderLiquidation[]>([]);
  readonly pending = signal<PendingPayment[]>([]);
  readonly kpis = signal<HomeDeliveryKpis | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly closeError = signal<string | null>(null);

  readonly today = new Date();
  businessDate: Date = new Date();
  riderUserId = '';
  counts: Record<number, number> = {};

  readonly counted = computed(() => {
    this.countsVersion();
    return Math.round(DENOMS.reduce((s, d) => s + d * (this.counts[d] || 0), 0) * 100) / 100;
  });
  readonly difference = computed(() => {
    const c = this.corte();
    return Math.round((this.counted() - Number(c?.cash_expected || 0)) * 100) / 100;
  });
  private readonly countsVersion = signal(0);

  ngOnInit(): void {
    this.svc.listRiders().subscribe({
      next: (d) => this.riders.set(d || []),
      error: () => {},
    });
    this.refreshList();
    this.refreshPending();
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  num(v: number | string | null | undefined): number { return Number(v ?? 0); }

  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  statusLabel(s: string): string {
    const k = (s || '').toLowerCase();
    if (k === 'open') return 'Abierto';
    if (k === 'closed') return 'Cerrado';
    if (k === 'verified') return 'Verificado';
    return s || '—';
  }

  statusSeverity(s: string): 'success' | 'info' | 'warn' | 'secondary' {
    const k = (s || '').toLowerCase();
    if (k === 'closed') return 'success';
    if (k === 'open') return 'warn';
    if (k === 'verified') return 'info';
    return 'secondary';
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

  setCount(denom: number, value: number): void {
    this.counts[denom] = Math.max(0, Math.floor(Number(value) || 0));
    this.countsVersion.update((v) => v + 1);
  }

  refreshList(): void {
    const d = this.iso(this.businessDate);
    this.svc.list(d).subscribe({ next: (r) => this.list.set(r || []), error: () => {} });
    this.svc.kpis(d, d).subscribe({ next: (k) => this.kpis.set(k), error: () => {} });
  }

  openCorte(): void {
    this.error.set(null);
    this.busy.set(true);
    this.svc.open({ rider_user_id: this.riderUserId, business_date: this.iso(this.businessDate) }).subscribe({
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
