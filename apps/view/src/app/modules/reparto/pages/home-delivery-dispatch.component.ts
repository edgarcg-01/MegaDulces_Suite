import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import {
  DispatchFromKeplerPayload,
  FleetDriver,
  FleetVehicle,
  HomeDeliveryService,
  KeplerTicket,
} from '../home-delivery.service';

/**
 * LM-K.4 — Persona de tienda: captura folio Kepler → ve el pedido → captura
 * domicilio → asigna repartidor+moto. Superficie de campo (tablet): un paso a la
 * vez, targets grandes, decisión de asignación asistida (estado + capacidad).
 */
@Component({
  selector: 'app-home-delivery-dispatch',
  standalone: true,
  imports: [
    CommonModule, FormsModule, SelectModule, InputTextModule, InputNumberModule,
    DatePickerModule, ToggleSwitchModule, TableModule, TagModule, ButtonModule,
  ],
  template: `
    <div class="surf-page in rd">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Asignar entrega a domicilio</h1>
          <p class="surf-page-sub">Buscá el folio Kepler, capturá el domicilio y asigná repartidor + moto</p>
        </div>
      </header>

      <ol class="rd-steps" aria-label="Progreso">
        <li [class.on]="step() === 0" [class.done]="step() > 0"><span class="rd-num">1</span> Buscar folio</li>
        <li [class.on]="step() === 1" [class.done]="step() > 1"><span class="rd-num">2</span> Domicilio y repartidor</li>
        <li [class.on]="step() === 2"><span class="rd-num">3</span> Confirmado</li>
      </ol>

      <!-- Paso 1: buscar folio -->
      @if (!result()) {
        <div class="card-premium rd-card">
          <div class="rd-grid">
            <div class="rd-field">
              <label for="wh">Sucursal</label>
              <p-select inputId="wh" [options]="warehouseOpts" [(ngModel)]="warehouse"
                        optionLabel="label" optionValue="value" appendTo="body" styleClass="rd-full" />
            </div>
            <div class="rd-field">
              <label for="folio">Folio Kepler</label>
              <input id="folio" pInputText class="rd-in" [(ngModel)]="folio" placeholder="ej. 12345"
                     (keyup.enter)="lookup()" inputmode="numeric" />
            </div>
            <div class="rd-field">
              <label for="serie">Serie <span class="rd-hint">(opcional)</span></label>
              <input id="serie" pInputText class="rd-in" [(ngModel)]="serie" placeholder="ej. UD0101" />
            </div>
          </div>
          <div class="rd-actions">
            <button pButton [label]="loading() ? 'Buscando…' : 'Buscar ticket'" icon="pi pi-search"
                    [loading]="loading()" [disabled]="!folio.trim()" (click)="lookup()"></button>
          </div>
          @if (error()) { <p class="rd-err"><i class="pi pi-exclamation-circle"></i> {{ error() }}</p> }
        </div>
      }

      <!-- Paso 2: ticket + domicilio + asignación -->
      @if (ticket(); as t) {
        <div class="card-premium rd-card">
          <div class="rd-ticket-head">
            <div>
              <div class="rd-ticket-title">{{ t.warehouse_name }} · Folio {{ t.folio }}</div>
              <div class="rd-ticket-total">{{ money(t.total) }}</div>
            </div>
            @if (t.already_paid) {
              <p-tag severity="success" value="Pagado en tienda" icon="pi pi-check" />
            } @else {
              <p-tag severity="warn" [value]="'Cobrar · ' + t.forma_pago" icon="pi pi-wallet" />
            }
          </div>

          <p-table [value]="t.items" styleClass="p-datatable-sm surf-table rd-lines">
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Producto</th>
                <th scope="col" class="comm-num">Cant</th>
                <th scope="col" class="comm-num">Importe</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-it>
              <tr>
                <td><code class="comm-code">{{ it.sku }}</code></td>
                <td>{{ it.nombre }}</td>
                <td class="comm-num">{{ it.cant }}</td>
                <td class="comm-num">{{ money(it.importe) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="footer">
              <tr>
                <td colspan="3" class="comm-num">Total</td>
                <td class="comm-num"><b>{{ money(t.total) }}</b></td>
              </tr>
            </ng-template>
          </p-table>
        </div>

        <div class="card-premium rd-card">
          <h2 class="rd-sectitle">Domicilio de entrega</h2>
          <div class="rd-grid">
            <div class="rd-field">
              <label for="rn">Nombre de quien recibe</label>
              <input id="rn" pInputText class="rd-in" [(ngModel)]="recipientName" />
            </div>
            <div class="rd-field">
              <label for="ph">Teléfono <span class="req">*</span></label>
              <input id="ph" pInputText class="rd-in" [(ngModel)]="phone" inputmode="tel" placeholder="10 dígitos" />
            </div>
          </div>
          <div class="rd-field rd-mt">
            <label for="st">Calle y número <span class="req">*</span></label>
            <input id="st" pInputText class="rd-in" [(ngModel)]="street" />
          </div>
          <div class="rd-field rd-mt">
            <label for="rf">Referencias</label>
            <input id="rf" pInputText class="rd-in" [(ngModel)]="references" placeholder="entre calles, color de casa…" />
          </div>

          <h2 class="rd-sectitle">Asignación</h2>
          <div class="rd-grid">
            <div class="rd-field">
              <label for="drv">Repartidor <span class="req">*</span></label>
              <p-select inputId="drv" [options]="drivers()" [(ngModel)]="driverId" optionValue="id"
                        appendTo="body" styleClass="rd-full" placeholder="Elegí repartidor"
                        [filter]="drivers().length > 8" filterBy="full_name" [emptyMessage]="'Sin repartidores activos'">
                <ng-template let-d pTemplate="item">
                  <div class="rd-opt">
                    <span class="rd-dot" [class]="driverDotClass(d)" aria-hidden="true"></span>
                    <span class="rd-opt-main">{{ d.full_name }}</span>
                    <span class="rd-opt-sub">{{ driverStatusLabel(d) }}</span>
                  </div>
                </ng-template>
                <ng-template let-d pTemplate="selectedItem">
                  <span *ngIf="d">{{ d.full_name }}</span>
                </ng-template>
              </p-select>
            </div>
            <div class="rd-field">
              <label for="veh">Moto <span class="req">*</span></label>
              <p-select inputId="veh" [options]="vehicles()" [(ngModel)]="vehicleId" optionValue="id"
                        appendTo="body" styleClass="rd-full" placeholder="Elegí moto"
                        [emptyMessage]="'Sin motos activas'">
                <ng-template let-v pTemplate="item">
                  <div class="rd-opt">
                    <span class="rd-opt-main">{{ v.plate }}</span>
                    <span class="rd-opt-sub">{{ v.model || v.brand || 'moto' }}</span>
                    <span class="rd-cap" *ngIf="v.capacity_boxes != null">{{ v.capacity_boxes }} cajas</span>
                  </div>
                </ng-template>
                <ng-template let-v pTemplate="selectedItem">
                  <span *ngIf="v">{{ v.plate }}<span class="rd-opt-sub"> · {{ v.model || v.brand }}</span></span>
                </ng-template>
              </p-select>
            </div>
          </div>

          @if (capacityInfo(); as ci) {
            @if (ci.over) {
              <div class="rd-advisory warn">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>El pedido son ~{{ ci.units }} u y esta moto rinde {{ ci.cap }} cajas. Podría no caber — se valida al asignar (o considerá CEDIS).</span>
              </div>
            } @else if (ci.cap != null) {
              <div class="rd-advisory info">
                <i class="pi pi-box" aria-hidden="true"></i>
                <span>{{ ci.units }} u en el pedido · capacidad de la moto {{ ci.cap }} cajas.</span>
              </div>
            }
          }

          <div class="rd-grid rd-mt">
            <div class="rd-field">
              <label for="sd">Fecha de entrega</label>
              <p-datePicker inputId="sd" [(ngModel)]="shipmentDate" dateFormat="dd/mm/yy"
                            [minDate]="today" [showIcon]="true" appendTo="body" styleClass="rd-full" />
            </div>
          </div>

          @if (!t.already_paid) {
            <div class="rd-cod">
              <p-toggleSwitch inputId="cod" [(ngModel)]="collect" />
              <label for="cod" class="rd-cod-label">El repartidor cobra al entregar (COD)</label>
            </div>
            @if (collect) {
              <div class="rd-field rd-cod-amount">
                <label for="amt">Monto a cobrar <span class="rd-hint">· total del ticket {{ money(t.total) }}</span></label>
                <p-inputNumber inputId="amt" [(ngModel)]="amount" mode="currency" currency="MXN" locale="es-MX"
                               [min]="0" styleClass="rd-full" />
              </div>
            }
          } @else {
            <div class="rd-advisory info">
              <i class="pi pi-check-circle" aria-hidden="true"></i>
              <span>Ya pagado en tienda — el repartidor no cobra.</span>
            </div>
          }

          @if (dispatchError()) { <p class="rd-err"><i class="pi pi-exclamation-circle"></i> {{ dispatchError() }}</p> }
          <div class="rd-actions">
            <button pButton [label]="saving() ? 'Asignando…' : 'Asignar a repartidor'" icon="pi pi-send"
                    [loading]="saving()" (click)="dispatch()"></button>
          </div>
        </div>
      }

      <!-- Resultado -->
      @if (result(); as r) {
        <div class="card-premium rd-card rd-ok">
          <div class="rd-ok-head"><i class="pi pi-check-circle" aria-hidden="true"></i> Entrega asignada</div>
          <div class="rd-ok-meta">Embarque {{ r.folio }} · Guía {{ r.guide_number }}</div>
          @if (r.requires_cedis) {
            <div class="rd-advisory warn rd-mt">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span>Excede la capacidad de la moto ({{ r.total_units }} u). Considerá surtir desde CEDIS.</span>
            </div>
          }
          <div class="rd-actions">
            <button pButton label="Despachar otro" icon="pi pi-plus" severity="secondary" [outlined]="true" (click)="reset()"></button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .rd { max-width: 860px; }

    .rd-steps { display:flex; gap:.5rem; list-style:none; padding:0; margin:0 0 1.25rem; flex-wrap:wrap; }
    .rd-steps li { display:inline-flex; align-items:center; gap:.45rem; font-size:.82rem; font-weight:600;
      color:var(--text-faint); padding:.4rem .8rem; border:1px solid var(--border); border-radius:var(--r-pill); }
    .rd-steps .rd-num { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%;
      background:var(--layout-bg); color:var(--text-muted); font-size:.72rem; }
    .rd-steps li.on { color:var(--text-main); border-color:var(--text-muted); }
    .rd-steps li.on .rd-num { background:var(--action); color:var(--action-ink); }
    .rd-steps li.done { color:var(--action); border-color:var(--action); }
    .rd-steps li.done .rd-num { background:var(--action); color:var(--action-ink); }

    .rd-card { margin-bottom:1rem; }
    .rd-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1rem; }
    .rd-field { display:flex; flex-direction:column; gap:.4rem; }
    .rd-field > label { font-size:.78rem; font-weight:600; color:var(--text-muted); }
    .rd-field .req { color:var(--bad-fg); }
    .rd-hint { color:var(--text-faint); font-weight:400; }
    .rd-mt { margin-top:1rem; }

    .rd-sectitle { font-size:.95rem; font-weight:700; color:var(--text-main); margin:1.25rem 0 .75rem; }
    .rd-sectitle:first-child { margin-top:0; }

    /* Controles a ancho de campo (tablet). */
    .rd-in { width:100%; }
    :host ::ng-deep .rd-full { width:100%; }
    :host ::ng-deep .rd-full .p-inputnumber-input { width:100%; }
    :host ::ng-deep .rd-full .p-datepicker-input { width:100%; }

    .rd-ticket-head { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
    .rd-ticket-title { font-weight:700; color:var(--text-main); }
    .rd-ticket-total { font-size:1.25rem; font-weight:800; font-variant-numeric:tabular-nums; color:var(--text-main); margin-top:.15rem; }

    /* Opciones enriquecidas de repartidor / moto */
    .rd-opt { display:flex; align-items:center; gap:.5rem; width:100%; }
    .rd-opt-main { font-weight:600; }
    .rd-opt-sub { color:var(--text-muted); font-size:.85em; }
    .rd-cap { margin-left:auto; font-size:.75rem; color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .rd-dot { width:9px; height:9px; border-radius:50%; background:var(--text-faint); flex-shrink:0; }
    .rd-dot.ok { background:var(--ok-fg); }
    .rd-dot.busy { background:var(--warn-fg); }
    .rd-dot.off { background:var(--text-faint); }

    .rd-advisory { display:flex; gap:.5rem; align-items:flex-start; padding:.65rem .85rem; border-radius:var(--r-sm);
      font-size:.85rem; margin-top:.75rem; line-height:1.4; }
    .rd-advisory i { margin-top:.1rem; }
    .rd-advisory.warn { background:var(--warn-soft-bg); color:var(--warn-soft-fg); border:1px solid var(--warn-border); }
    .rd-advisory.info { background:var(--layout-bg); color:var(--text-muted); border:1px solid var(--border); }

    .rd-cod { display:flex; align-items:center; gap:.65rem; margin:1rem 0 .25rem; }
    .rd-cod-label { font-size:.9rem; color:var(--text-main); }
    .rd-cod-amount { margin-top:.6rem; max-width:280px; }

    .rd-actions { margin-top:1.25rem; display:flex; gap:.6rem; flex-wrap:wrap; }
    .rd-err { color:var(--bad-fg); font-size:.85rem; margin:.75rem 0 0; display:flex; align-items:center; gap:.4rem; }

    .rd-ok { border-color:var(--ok-border); }
    .rd-ok-head { display:flex; align-items:center; gap:.5rem; font-weight:700; font-size:1.05rem; color:var(--ok-fg); }
    .rd-ok-meta { margin-top:.35rem; color:var(--text-muted); font-variant-numeric:tabular-nums; }

    @media (max-width:640px) {
      .rd-grid { grid-template-columns:1fr; }
      .rd-cod-amount { max-width:none; }
    }
  `],
})
export class HomeDeliveryDispatchComponent implements OnInit {
  private readonly svc = inject(HomeDeliveryService);

  readonly ticket = signal<KeplerTicket | null>(null);
  readonly drivers = signal<FleetDriver[]>([]);
  readonly vehicles = signal<FleetVehicle[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly dispatchError = signal<string | null>(null);
  readonly result = signal<any | null>(null);

  readonly step = computed(() => (this.result() ? 2 : this.ticket() ? 1 : 0));

  readonly warehouseOpts = [
    { label: 'Padre Hidalgo', value: '01' },
    { label: 'La Piedad Abastos', value: '02' },
    { label: '8 Esquinas', value: '03' },
  ];

  readonly today = new Date();
  warehouse = '01';
  folio = '';
  serie = '';
  recipientName = '';
  phone = '';
  street = '';
  references = '';
  driverId = '';
  vehicleId = '';
  shipmentDate: Date = new Date();
  collect = false;
  amount = 0;

  ngOnInit(): void {
    this.svc.listDrivers().subscribe({ next: (d) => this.drivers.set(d || []), error: () => {} });
    this.svc.listVehicles().subscribe({ next: (v) => this.vehicles.set(v || []), error: () => {} });
  }

  money(v: number | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  driverStatusLabel(d: FleetDriver): string {
    const s = (d.status || '').toLowerCase();
    if (!s || s === 'available' || s === 'active') return 'Disponible';
    if (s === 'busy' || s === 'on_route' || s === 'on-route') return 'Ocupado';
    if (s === 'offline' || s === 'inactive') return 'Offline';
    return d.status || '';
  }

  driverDotClass(d: FleetDriver): string {
    const s = (d.status || '').toLowerCase();
    if (!s || s === 'available' || s === 'active') return 'ok';
    if (s === 'busy' || s === 'on_route' || s === 'on-route') return 'busy';
    return 'off';
  }

  /** Aviso proactivo de capacidad: unidades del pedido vs capacidad de la moto elegida. */
  capacityInfo(): { units: number; cap: number | null; over: boolean } | null {
    const t = this.ticket();
    if (!t) return null;
    const v = this.vehicles().find((x) => x.id === this.vehicleId);
    if (!v) return null;
    const units = (t.items || []).reduce((s, i) => s + (Number(i.cant) || 0), 0);
    const cap = v.capacity_boxes ?? null;
    return { units, cap, over: cap != null && units > cap };
  }

  lookup(): void {
    this.error.set(null);
    this.result.set(null);
    this.loading.set(true);
    this.svc.ticketLookup(this.folio.trim(), this.warehouse, this.serie.trim() || undefined).subscribe({
      next: (t) => {
        this.ticket.set(t);
        this.collect = t.collect_on_delivery_suggested && !t.already_paid;
        this.amount = t.total;
        this.loading.set(false);
      },
      error: (e) => { this.ticket.set(null); this.error.set(e?.error?.message || 'Ticket no encontrado.'); this.loading.set(false); },
    });
  }

  dispatch(): void {
    const t = this.ticket();
    if (!t) return;
    this.dispatchError.set(null);
    if (!this.phone.trim()) { this.dispatchError.set('Captura el teléfono de quien recibe (el repartidor lo necesita).'); return; }
    if (!this.street.trim()) { this.dispatchError.set('Captura la calle del domicilio.'); return; }
    if (!this.driverId) { this.dispatchError.set('Elige un repartidor.'); return; }
    if (!this.vehicleId) { this.dispatchError.set('Elige una moto.'); return; }

    const payload: DispatchFromKeplerPayload = {
      folio: t.folio,
      serie: t.serie,
      warehouse_code: t.warehouse_code,
      driver_id: this.driverId,
      vehicle_id: this.vehicleId,
      shipment_date: this.iso(this.shipmentDate),
      delivery_address: {
        recipient_name: this.recipientName.trim() || undefined,
        phone: this.phone.trim() || undefined,
        street: this.street.trim(),
        references: this.references.trim() || undefined,
      },
      collect_on_delivery: this.collect,
      amount_to_collect: this.collect ? Number(this.amount) : undefined,
    };
    this.saving.set(true);
    this.svc.dispatchFromKepler(payload).subscribe({
      next: (r) => { this.saving.set(false); this.result.set(r); this.ticket.set(null); },
      error: (e) => { this.saving.set(false); this.dispatchError.set(e?.error?.message || 'No se pudo asignar.'); },
    });
  }

  reset(): void {
    this.result.set(null);
    this.ticket.set(null);
    this.folio = '';
    this.serie = '';
    this.recipientName = '';
    this.phone = '';
    this.street = '';
    this.references = '';
    this.driverId = '';
    this.vehicleId = '';
    this.collect = false;
    this.amount = 0;
    this.shipmentDate = new Date();
  }
}
