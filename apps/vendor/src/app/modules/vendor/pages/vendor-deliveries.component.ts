import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DeliveryOutcome,
  RecordDeliveryOutcome,
  RiderDelivery,
  VendorService,
} from '../vendor.service';

type Mode = 'deliver' | 'incident';

/**
 * Fase LM.6 — app del repartidor: paradas a domicilio + cierre de parada.
 * Online-first (offline Dexie diferido a LM.6.2). Entrega exige evidencia
 * (firma/foto/WhatsApp) + cobro; incidencias tipificadas (§10 SOP).
 */
@Component({
  selector: 'app-vendor-deliveries',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="deliveries">
      <header class="head">
        <h1>Mis entregas</h1>
        <button class="ghost" (click)="load()" [disabled]="loading()">↻</button>
      </header>

      @if (loading()) {
        <p class="muted">Cargando…</p>
      } @else if (items().length === 0) {
        <p class="muted">No tienes entregas pendientes.</p>
      } @else {
        <ul class="list">
          @for (d of items(); track d.recipient_id) {
            <li class="card" [class.done]="d.status === 'entregado'">
              <div class="row1">
                <strong>{{ d.customer_name }}</strong>
                <span class="folio">{{ d.order_code || d.shipment_folio }}</span>
              </div>
              <div class="addr">{{ d.delivery_address?.street || 's/dirección' }}</div>
              @if (d.delivery_address?.references) {
                <div class="ref">Ref: {{ d.delivery_address?.references }}</div>
              }
              <div class="row2">
                <span class="total">Cobrar: {{ money(d.balance_due ?? d.total) }}</span>
                <span class="status" [attr.data-s]="d.status">{{ statusLabel(d.status) }}</span>
              </div>
              @if (d.shipment_notes) {
                <div class="warn">⚠ {{ d.shipment_notes }}</div>
              }
              @if (d.status === 'pendiente' || d.status === 'no_entregado') {
                <div class="actions">
                  <button class="ok" (click)="openDeliver(d)">Entregar</button>
                  <button class="bad" (click)="openIncident(d)">Incidencia</button>
                </div>
              }
            </li>
          }
        </ul>
      }

      @if (active(); as d) {
        <div class="modal-bg" (click)="close()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h2>{{ mode() === 'deliver' ? 'Entregar' : 'Incidencia' }} — {{ d.customer_name }}</h2>

            @if (mode() === 'deliver') {
              <label>Método de pago</label>
              <select [(ngModel)]="method">
                <option value="cash">Efectivo</option>
                <option value="transfer">Transferencia</option>
                <option value="card">Tarjeta (voucher)</option>
                <option value="prepaid">Ya pagado (prepago)</option>
              </select>

              @if (method !== 'prepaid') {
                <label>Monto a cobrar</label>
                <input type="number" [(ngModel)]="amount" min="0" step="0.01" />
                @if (method === 'cash') {
                  <label>Efectivo recibido (para el cambio)</label>
                  <input type="number" [(ngModel)]="cashReceived" min="0" step="0.01" />
                }
                @if (method === 'transfer' || method === 'card') {
                  <label>Referencia / autorización</label>
                  <input type="text" [(ngModel)]="reference" />
                }
              }

              <label class="chk">
                <input type="checkbox" [(ngModel)]="evidence" />
                Evidencia obtenida (firma / foto / WhatsApp) — obligatoria
              </label>
            } @else {
              <label>Tipo de incidencia</label>
              <select [(ngModel)]="incidentType">
                <option value="not_located">Cliente no localizado</option>
                <option value="wrong_address">Dirección incorrecta</option>
                <option value="customer_rejected">Cliente rechaza pedido</option>
                <option value="missing_product">Producto faltante</option>
                <option value="other">Otro</option>
              </select>
              <label>Motivo / notas {{ incidentType === 'customer_rejected' ? '(obligatorio)' : '' }}</label>
              <textarea [(ngModel)]="incidentNotes" rows="3"></textarea>
            }

            @if (error()) { <p class="err">{{ error() }}</p> }

            <div class="modal-actions">
              <button class="ghost" (click)="close()" [disabled]="saving()">Cancelar</button>
              <button class="primary" (click)="submit()" [disabled]="saving()">
                {{ saving() ? 'Guardando…' : 'Confirmar' }}
              </button>
            </div>
          </div>
        </div>
      }
    </section>
  `,
  styles: [`
    .deliveries { padding: 1rem; max-width: 640px; margin: 0 auto; }
    .head { display: flex; justify-content: space-between; align-items: center; }
    h1 { font-size: 1.25rem; margin: 0; }
    .muted { color: var(--text-muted, #888); }
    .list { list-style: none; padding: 0; margin: .75rem 0 0; display: grid; gap: .6rem; }
    .card { border: 1px solid var(--border, #e5e5e5); border-radius: 12px; padding: .8rem; background: var(--card-bg, #fff); }
    .card.done { opacity: .55; }
    .row1 { display: flex; justify-content: space-between; gap: .5rem; }
    .folio { font-variant-numeric: tabular-nums; color: var(--text-muted, #888); font-size: .85rem; }
    .addr { font-size: .92rem; margin-top: .2rem; }
    .ref { font-size: .8rem; color: var(--text-muted, #888); }
    .row2 { display: flex; justify-content: space-between; margin-top: .4rem; align-items: center; }
    .total { font-weight: 600; }
    .status { font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; }
    .warn { margin-top: .4rem; font-size: .8rem; color: #b45309; background: #fff7ed; border-radius: 8px; padding: .3rem .5rem; }
    .actions { display: flex; gap: .5rem; margin-top: .6rem; }
    button { border: 1px solid var(--border, #ddd); border-radius: 9px; padding: .5rem .8rem; background: #fff; cursor: pointer; font: inherit; }
    button.ok { border-color: #16a34a; color: #16a34a; }
    button.bad { border-color: #dc2626; color: #dc2626; }
    button.primary { background: var(--action, #ea580c); color: #fff; border-color: transparent; }
    button.ghost { background: transparent; }
    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
    .modal { background: var(--card-bg, #fff); border-radius: 16px 16px 0 0; padding: 1rem; width: 100%; max-width: 640px; max-height: 90vh; overflow: auto; }
    .modal h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
    .modal label { display: block; font-size: .82rem; margin: .6rem 0 .2rem; color: var(--text-muted, #666); }
    .modal label.chk { display: flex; gap: .5rem; align-items: center; margin-top: .8rem; color: inherit; }
    .modal input, .modal select, .modal textarea { width: 100%; padding: .5rem; border: 1px solid var(--border, #ddd); border-radius: 8px; font: inherit; box-sizing: border-box; }
    .modal input[type=checkbox] { width: auto; }
    .modal-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem; }
    .err { color: #dc2626; font-size: .85rem; }
  `],
})
export class VendorDeliveriesComponent implements OnInit {
  private readonly vendor = inject(VendorService);

  readonly items = signal<RiderDelivery[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = signal<RiderDelivery | null>(null);
  readonly mode = signal<Mode>('deliver');

  // form state (plain fields — two-way with ngModel)
  method: 'cash' | 'transfer' | 'card' | 'prepaid' = 'cash';
  amount = 0;
  cashReceived: number | null = null;
  reference = '';
  evidence = false;
  incidentType: DeliveryOutcome = 'not_located';
  incidentNotes = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.vendor.myDeliveries().subscribe({
      next: (rows) => { this.items.set(rows || []); this.loading.set(false); },
      error: () => { this.items.set([]); this.loading.set(false); },
    });
  }

  money(v: number | string | null | undefined): string {
    const n = Number(v ?? 0);
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  statusLabel(s: string): string {
    return { pendiente: 'Pendiente', no_entregado: 'No entregado', rechazado: 'Rechazado', entregado: 'Entregado' }[s] || s;
  }

  openDeliver(d: RiderDelivery): void {
    this.error.set(null);
    this.mode.set('deliver');
    this.method = 'cash';
    this.amount = Number(d.balance_due ?? d.total ?? 0);
    this.cashReceived = null;
    this.reference = '';
    this.evidence = false;
    this.active.set(d);
  }

  openIncident(d: RiderDelivery): void {
    this.error.set(null);
    this.mode.set('incident');
    this.incidentType = 'not_located';
    this.incidentNotes = '';
    this.active.set(d);
  }

  close(): void {
    this.active.set(null);
    this.error.set(null);
  }

  submit(): void {
    const d = this.active();
    if (!d) return;
    this.error.set(null);

    let dto: RecordDeliveryOutcome;
    if (this.mode() === 'deliver') {
      if (!this.evidence) { this.error.set('La entrega requiere evidencia (firma/foto/WhatsApp).'); return; }
      dto = { outcome: 'delivered', whatsapp_confirmed: true, delivered_to: d.customer_name };
      if (this.method !== 'prepaid' && d.order_id) {
        if (!(this.amount > 0)) { this.error.set('Ingresa el monto a cobrar.'); return; }
        dto.payment = { order_id: d.order_id, method: this.method, amount: Number(this.amount) };
        if (this.method === 'cash' && this.cashReceived != null) dto.payment.cash_received = Number(this.cashReceived);
        if ((this.method === 'transfer' || this.method === 'card') && this.reference) dto.payment.reference = this.reference;
      }
    } else {
      if (this.incidentType === 'customer_rejected' && !this.incidentNotes.trim()) {
        this.error.set('El rechazo requiere motivo.'); return;
      }
      dto = { outcome: this.incidentType, incident_notes: this.incidentNotes.trim() || undefined };
    }

    this.saving.set(true);
    this.vendor.recordDeliveryOutcome(d.recipient_id, dto).subscribe({
      next: () => { this.saving.set(false); this.close(); this.load(); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.message || 'No se pudo guardar.'); },
    });
  }
}
