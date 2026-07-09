import { Component, ElementRef, computed, inject, signal, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  DeliveryOutcome,
  RecordDeliveryOutcome,
  RiderDelivery,
  RiderService,
} from '../rider.service';

type Mode = 'deliver' | 'incident';

/**
 * REPARTIDOR — paradas a domicilio + cierre de parada (Fase LM.6).
 * Dominio propio (RiderService): el repartidor entrega y cobra, NO vende.
 * Online-first (offline Dexie diferido a LM.6.2).
 */
@Component({
  selector: 'app-rider-deliveries',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="deliveries">
      <header class="head">
        <h1>Mis entregas</h1>
        <button class="ghost" (click)="load()" [disabled]="loading()">↻</button>
      </header>

      @if (pendingCount() > 0) {
        <button class="carry" (click)="goRun()">
          🛵 Llevar pedidos ({{ pendingCount() }})
        </button>
      }

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
                @if (mustCollect(d)) {
                  <span class="total">Cobrar: {{ money(collectAmount(d)) }}</span>
                } @else {
                  <span class="total paid">Ya pagado</span>
                }
                <span class="status" [attr.data-s]="d.status">{{ statusLabel(d.status) }}</span>
              </div>
              @if (d.items_snapshot?.length) {
                <div class="load">📦 {{ d.items_snapshot?.length }} SKUs a cargar</div>
              }
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
              @if (mustCollect(d)) {
                <div class="collect-fixed">
                  <span>Cobrar (fijo del ticket)</span>
                  <strong>{{ money(collectAmount(d)) }}</strong>
                </div>
                <label>Método de pago</label>
                <select [(ngModel)]="method">
                  <option value="cash">Efectivo</option>
                  <option value="transfer">Transferencia</option>
                  <option value="card">Tarjeta (voucher)</option>
                </select>
                @if (method === 'cash') {
                  <label>Efectivo recibido (para el cambio)</label>
                  <input type="number" [(ngModel)]="cashReceived" min="0" step="0.01" />
                  @if (change(d) != null) { <p class="change">Cambio: {{ money(change(d)) }}</p> }
                }
                @if (method === 'transfer' || method === 'card') {
                  <label>Referencia / autorización</label>
                  <input type="text" [(ngModel)]="reference" />
                }
              } @else {
                <div class="collect-fixed paid"><span>Ya pagado en tienda</span><strong>No se cobra</strong></div>
              }

              <label>Firma del cliente <span class="req">(obligatoria)</span></label>
              <canvas #sig class="sigpad"
                      (pointerdown)="sigStart($event)" (pointermove)="sigMove($event)"
                      (pointerup)="sigEnd()" (pointerleave)="sigEnd()"></canvas>
              <button type="button" class="ghost sig-clear" (click)="clearSig()">Limpiar firma</button>
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
    .carry { width: 100%; margin: .6rem 0 .2rem; padding: .9rem; border: none; border-radius: 12px; background: var(--action, #ea580c); color: #fff; font: inherit; font-weight: 700; font-size: 1.05rem; cursor: pointer; }
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
    .total.paid { color: #16a34a; font-weight: 500; }
    .load { font-size: .8rem; color: var(--text-muted, #666); margin-top: .3rem; }
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
    .req { color: #dc2626; }
    .collect-fixed { display: flex; justify-content: space-between; align-items: center; background: var(--layout-bg, #f5f5f4); border: 1px solid var(--border, #e5e5e5); border-radius: 10px; padding: .6rem .8rem; margin-top: .4rem; }
    .collect-fixed strong { font-size: 1.1rem; }
    .collect-fixed.paid strong { color: #16a34a; font-size: .95rem; }
    .change { margin: .3rem 0 0; font-size: .85rem; color: #16a34a; font-weight: 600; }
    .sigpad { width: 100%; height: 160px; border: 1px dashed var(--border, #bbb); border-radius: 10px; background: #fff; touch-action: none; cursor: crosshair; }
    .sig-clear { margin-top: .4rem; font-size: .8rem; padding: .3rem .7rem; }
  `],
})
export class RiderDeliveriesComponent implements OnInit {
  private readonly rider = inject(RiderService);
  private readonly router = inject(Router);

  readonly pendingCount = computed(
    () => this.items().filter((d) => d.status === 'pendiente' || d.status === 'no_entregado').length,
  );

  goRun(): void { this.router.navigateByUrl('/rider/run'); }

  readonly items = signal<RiderDelivery[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = signal<RiderDelivery | null>(null);
  readonly mode = signal<Mode>('deliver');

  @ViewChild('sig') sigRef?: ElementRef<HTMLCanvasElement>;

  method: 'cash' | 'transfer' | 'card' = 'cash';
  cashReceived: number | null = null;
  reference = '';
  incidentType: DeliveryOutcome = 'not_located';
  incidentNotes = '';

  private drawing = false;
  private signed = false;
  private lastX = 0;
  private lastY = 0;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.rider.myDeliveries().subscribe({
      next: (rows) => { this.items.set(rows || []); this.loading.set(false); },
      error: () => { this.items.set([]); this.loading.set(false); },
    });
  }

  money(v: number | string | null | undefined): string {
    const n = Number(v ?? 0);
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  /** ¿El repartidor cobra en esta parada? (Kepler CONTADO ⇒ ya pagado.) */
  mustCollect(d: RiderDelivery): boolean {
    // Parada Kepler: manda collect_on_delivery. Intake propio: hay saldo por cobrar.
    if (d.collect_on_delivery != null) return !!d.collect_on_delivery;
    return Number(d.balance_due ?? d.total ?? 0) > 0;
  }

  collectAmount(d: RiderDelivery): number {
    return Number(d.amount_to_collect ?? d.balance_due ?? d.total ?? 0);
  }

  /** Cambio a devolver (solo efectivo): recibido − monto fijo del ticket. */
  change(d: RiderDelivery): number | null {
    if (this.method !== 'cash' || this.cashReceived == null) return null;
    const diff = Number(this.cashReceived) - this.collectAmount(d);
    return diff >= 0 ? diff : null;
  }

  statusLabel(s: string): string {
    return { pendiente: 'Pendiente', no_entregado: 'No entregado', rechazado: 'Rechazado', entregado: 'Entregado' }[s] || s;
  }

  openDeliver(d: RiderDelivery): void {
    this.error.set(null);
    this.mode.set('deliver');
    this.method = 'cash';
    this.cashReceived = null;
    this.reference = '';
    this.signed = false;
    this.active.set(d);
  }

  // ── Firma canvas (obligatoria) ──
  private ctx(): CanvasRenderingContext2D | null {
    const c = this.sigRef?.nativeElement;
    if (!c) return null;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
      c.width = c.clientWidth; c.height = c.clientHeight; // fija resolución = tamaño en pantalla
    }
    return c.getContext('2d');
  }

  sigStart(ev: PointerEvent): void {
    const g = this.ctx();
    if (!g) return;
    this.drawing = true;
    this.signed = true;
    this.lastX = ev.offsetX; this.lastY = ev.offsetY;
    g.lineWidth = 2; g.lineCap = 'round'; g.strokeStyle = '#111';
  }

  sigMove(ev: PointerEvent): void {
    if (!this.drawing) return;
    const g = this.ctx();
    if (!g) return;
    g.beginPath(); g.moveTo(this.lastX, this.lastY); g.lineTo(ev.offsetX, ev.offsetY); g.stroke();
    this.lastX = ev.offsetX; this.lastY = ev.offsetY;
  }

  sigEnd(): void { this.drawing = false; }

  clearSig(): void {
    const c = this.sigRef?.nativeElement;
    const g = this.ctx();
    if (c && g) g.clearRect(0, 0, c.width, c.height);
    this.signed = false;
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
      // Firma del cliente OBLIGATORIA (no opcional). El backend también la exige.
      if (!this.signed) { this.error.set('Falta la firma del cliente.'); return; }
      const signature_url = this.sigRef?.nativeElement.toDataURL('image/png');
      dto = { outcome: 'delivered', delivered_to: d.customer_name, signature_url };
      // El MONTO lo fija el ticket (backend lo bloquea). El repartidor NO lo decide:
      // solo elige método y, en efectivo, cuánto recibió (para el cambio).
      if (this.mustCollect(d)) {
        dto.payment = { method: this.method, amount: this.collectAmount(d) };
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
    this.rider.recordDeliveryOutcome(d.recipient_id, dto).subscribe({
      next: () => { this.saving.set(false); this.close(); this.load(); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.message || 'No se pudo guardar.'); },
    });
  }
}
