import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DispatchFromKeplerPayload,
  FleetDriver,
  FleetVehicle,
  HomeDeliveryService,
  KeplerTicket,
} from './home-delivery.service';

/**
 * LM-K.4 — Persona de tienda: captura folio Kepler → ve el pedido → captura
 * domicilio → asigna repartidor+moto. Piloto: sucursales 01/02/03.
 */
@Component({
  selector: 'app-home-delivery-dispatch',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="hd">
      <h1>Entrega a domicilio — despacho por folio</h1>

      <!-- Paso 1: buscar folio -->
      <div class="card">
        <div class="grid3">
          <label>Sucursal
            <select [(ngModel)]="warehouse">
              <option value="01">Padre Hidalgo</option>
              <option value="02">La Piedad Abastos</option>
              <option value="03">8 Esquinas</option>
            </select>
          </label>
          <label>Folio Kepler
            <input type="text" [(ngModel)]="folio" placeholder="ej. 12345" />
          </label>
          <label>Serie (opcional)
            <input type="text" [(ngModel)]="serie" placeholder="ej. UD0101" />
          </label>
        </div>
        <button class="primary" (click)="lookup()" [disabled]="loading() || !folio">
          {{ loading() ? 'Buscando…' : 'Buscar ticket' }}
        </button>
        @if (error()) { <p class="err">{{ error() }}</p> }
      </div>

      <!-- Paso 2: ticket + domicilio + asignación -->
      @if (ticket(); as t) {
        <div class="card">
          <div class="ticket-head">
            <strong>{{ t.warehouse_name }} · Folio {{ t.folio }}</strong>
            <span [class.paid]="t.already_paid">{{ t.already_paid ? 'Pagado en tienda' : t.forma_pago }}</span>
          </div>
          <table class="lines">
            <thead><tr><th>SKU</th><th>Producto</th><th class="r">Cant</th><th class="r">Importe</th></tr></thead>
            <tbody>
              @for (it of t.items; track it.sku) {
                <tr><td>{{ it.sku }}</td><td>{{ it.nombre }}</td><td class="r">{{ it.cant }}</td><td class="r">{{ money(it.importe) }}</td></tr>
              }
            </tbody>
            <tfoot><tr><td colspan="3" class="r">Total</td><td class="r"><b>{{ money(t.total) }}</b></td></tr></tfoot>
          </table>
        </div>

        <div class="card">
          <h2>Domicilio de entrega</h2>
          <div class="grid2">
            <label>Nombre de quien recibe<input type="text" [(ngModel)]="recipientName" /></label>
            <label>Teléfono<input type="text" [(ngModel)]="phone" /></label>
          </div>
          <label>Calle y número<input type="text" [(ngModel)]="street" /></label>
          <label>Referencias<input type="text" [(ngModel)]="references" /></label>

          <h2>Asignación</h2>
          <div class="grid2">
            <label>Repartidor
              <select [(ngModel)]="driverId">
                <option value="">— elegir —</option>
                @for (d of drivers(); track d.id) { <option [value]="d.id">{{ d.full_name }}</option> }
              </select>
            </label>
            <label>Moto
              <select [(ngModel)]="vehicleId">
                <option value="">— elegir —</option>
                @for (v of vehicles(); track v.id) { <option [value]="v.id">{{ v.plate }} · {{ v.model }}</option> }
              </select>
            </label>
          </div>
          <div class="grid2">
            <label>Fecha de entrega<input type="date" [(ngModel)]="shipmentDate" /></label>
            <label class="chk"><input type="checkbox" [(ngModel)]="collect" /> Cobra el repartidor (COD)</label>
          </div>
          @if (collect) {
            <label>Monto a cobrar<input type="number" [(ngModel)]="amount" min="0" step="0.01" /></label>
          }

          @if (dispatchError()) { <p class="err">{{ dispatchError() }}</p> }
          <button class="primary" (click)="dispatch()" [disabled]="saving()">
            {{ saving() ? 'Asignando…' : 'Asignar a repartidor' }}
          </button>
        </div>
      }

      <!-- Resultado -->
      @if (result(); as r) {
        <div class="card ok">
          <strong>✓ Entrega asignada</strong>
          <div>Embarque {{ r.folio }} · Guía {{ r.guide_number }}</div>
          @if (r.requires_cedis) {
            <div class="warn">⚠ Excede capacidad de la moto ({{ r.total_units }} u). Considerar CEDIS.</div>
          }
          <button (click)="reset()">Despachar otro</button>
        </div>
      }
    </section>
  `,
  styles: [`
    .hd { padding: 1.25rem; max-width: 780px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    h2 { font-size: .95rem; margin: 1rem 0 .4rem; }
    .card { border: 1px solid var(--surf-border, #e5e5e5); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; background: var(--surf-card, #fff); }
    .card.ok { border-color: #16a34a; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .75rem; }
    label { display: block; font-size: .82rem; color: var(--text-muted, #666); margin-bottom: .6rem; }
    label.chk { display: flex; align-items: center; gap: .5rem; margin-top: 1.7rem; }
    input, select { width: 100%; padding: .5rem; border: 1px solid var(--surf-border, #ddd); border-radius: 8px; font: inherit; box-sizing: border-box; }
    input[type=checkbox] { width: auto; }
    button { border: 1px solid var(--surf-border, #ddd); border-radius: 9px; padding: .55rem .9rem; background: #fff; cursor: pointer; font: inherit; }
    button.primary { background: var(--action, #ea580c); color: #fff; border-color: transparent; }
    .ticket-head { display: flex; justify-content: space-between; margin-bottom: .6rem; }
    .ticket-head .paid { color: #16a34a; }
    table.lines { width: 100%; border-collapse: collapse; font-size: .85rem; }
    table.lines th, table.lines td { border-bottom: 1px solid var(--surf-border, #eee); padding: .35rem .4rem; text-align: left; }
    .r { text-align: right; }
    .err { color: #dc2626; font-size: .85rem; }
    .warn { color: #b45309; margin-top: .4rem; }
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

  warehouse = '01';
  folio = '';
  serie = '';
  recipientName = '';
  phone = '';
  street = '';
  references = '';
  driverId = '';
  vehicleId = '';
  shipmentDate = new Date().toISOString().slice(0, 10);
  collect = false;
  amount = 0;

  ngOnInit(): void {
    this.svc.listDrivers().subscribe({ next: (d) => this.drivers.set(d || []), error: () => {} });
    this.svc.listVehicles().subscribe({ next: (v) => this.vehicles.set(v || []), error: () => {} });
  }

  money(v: number | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  lookup(): void {
    this.error.set(null);
    this.result.set(null);
    this.loading.set(true);
    this.svc.ticketLookup(this.folio.trim(), this.warehouse, this.serie.trim() || undefined).subscribe({
      next: (t) => {
        this.ticket.set(t);
        this.collect = t.collect_on_delivery_suggested;
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
    if (!this.street.trim()) { this.dispatchError.set('Captura la calle del domicilio.'); return; }
    if (!this.driverId) { this.dispatchError.set('Elige un repartidor.'); return; }
    if (!this.vehicleId) { this.dispatchError.set('Elige una moto.'); return; }

    const payload: DispatchFromKeplerPayload = {
      folio: t.folio,
      serie: t.serie,
      warehouse_code: t.warehouse_code,
      driver_id: this.driverId,
      vehicle_id: this.vehicleId,
      shipment_date: this.shipmentDate,
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
  }
}
