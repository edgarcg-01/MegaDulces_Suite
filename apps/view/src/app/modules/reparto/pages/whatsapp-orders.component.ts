import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { WhatsAppOrdersService, WhatsAppPendingOrder } from '../whatsapp-orders.service';

/**
 * F.3 — Bandeja de pedidos WhatsApp. El bot dejó estos hilos en "review" (carrito
 * + domicilio armados por el cliente). El operador revisa y CONFIRMA (crea el
 * pedido a domicilio → aparece en /reparto/asignar) o RECHAZA (avisa al cliente).
 * Master-detail: lista a la izquierda, detalle del pedido seleccionado a la derecha.
 */
@Component({
  selector: 'app-whatsapp-orders',
  standalone: true,
  imports: [
    FormsModule,
    TableModule,
    ButtonModule,
    TagModule,
    DialogModule,
    InputTextModule,
    ConfirmDialogModule,
    ToastModule
],
  providers: [ConfirmationService, MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast position="top-center"></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pedidos por WhatsApp</h1>
          <p class="surf-page-sub">Pedidos armados por el asistente, listos para tu revisión. Al confirmar, pasan a "Asignar pedido".</p>
        </div>
        <button pButton icon="pi pi-refresh" [label]="'Actualizar'" severity="secondary" [outlined]="true"
                size="small" [loading]="loading()" (click)="load()"></button>
      </header>

      @if (!loading() && orders().length === 0) {
        <div class="wo-empty">
          <i class="pi pi-inbox" aria-hidden="true"></i>
          <p>No hay pedidos de WhatsApp por revisar.</p>
        </div>
      }

      @if (orders().length > 0) {
        <div class="wo-grid">
          <!-- Lista -->
          <div class="card-premium wo-list">
            <p-table [value]="orders()" [(selection)]="selected" selectionMode="single" dataKey="thread_id"
                     styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="60vh">
              <ng-template pTemplate="header">
                <tr>
                  <th scope="col">Cliente</th>
                  <th scope="col" class="comm-num">Art.</th>
                  <th scope="col" class="comm-num">Total</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-o>
                <tr [pSelectableRow]="o">
                  <td>
                    <div class="wo-cust">{{ o.customer_name || 'Cliente' }}</div>
                    <div class="wo-phone">{{ o.phone }}</div>
                  </td>
                  <td class="comm-num">{{ o.items.length }}</td>
                  <td class="comm-num">{{ money(o.total) }}</td>
                </tr>
              </ng-template>
            </p-table>
          </div>

          <!-- Detalle -->
          <div class="card-premium wo-detail">
            @if (selected; as o) {
              <div class="wo-detail-head">
                <div>
                  <div class="wo-detail-title">{{ o.customer_name || 'Cliente' }}</div>
                  <div class="wo-detail-phone"><i class="pi pi-whatsapp"></i> {{ o.phone }}</div>
                </div>
                <p-tag severity="warn" value="Por revisar" icon="pi pi-clock" />
              </div>

              <h2 class="wo-sectitle">Productos</h2>
              <p-table [value]="o.items" styleClass="p-datatable-sm surf-table">
                <ng-template pTemplate="header">
                  <tr>
                    <th scope="col">Producto</th>
                    <th scope="col">Cantidad</th>
                    <th scope="col" class="comm-num">P. pieza</th>
                    <th scope="col" class="comm-num">Subtotal</th>
                  </tr>
                </ng-template>
                <ng-template pTemplate="body" let-it>
                  <tr>
                    <td>{{ it.name || '—' }}</td>
                    <td>{{ it.presentation || (it.qty + ' pzas') }}</td>
                    <td class="comm-num">{{ money(it.unit_price) }}</td>
                    <td class="comm-num">{{ money(it.qty * (it.unit_price || 0)) }}</td>
                  </tr>
                </ng-template>
                <ng-template pTemplate="footer">
                  <tr>
                    <td colspan="3" class="comm-num">Total</td>
                    <td class="comm-num"><b>{{ money(o.total) }}</b></td>
                  </tr>
                </ng-template>
              </p-table>

              <h2 class="wo-sectitle">Domicilio</h2>
              @if (o.delivery_address?.street) {
                <div class="wo-addr">
                  <div><i class="pi pi-map-marker"></i> {{ o.delivery_address?.street }}</div>
                  @if (o.delivery_address?.references) { <div class="wo-addr-ref">{{ o.delivery_address?.references }}</div> }
                  @if (o.delivery_address?.recipient_name) { <div class="wo-addr-ref">Recibe: {{ o.delivery_address?.recipient_name }}</div> }
                </div>
              } @else {
                <p class="wo-addr-missing"><i class="pi pi-exclamation-triangle"></i> Sin domicilio capturado.</p>
              }

              <div class="wo-advisory">
                <i class="pi pi-wallet"></i>
                <span>Contra-entrega — el repartidor cobra <b>{{ money(o.total) }}</b> al entregar.</span>
              </div>

              <div class="wo-actions">
                <button pButton icon="pi pi-check" [label]="acting() ? 'Confirmando…' : 'Confirmar pedido'"
                        [loading]="acting()" [disabled]="!o.delivery_address?.street || o.items.length === 0"
                        (click)="confirm(o)"></button>
                <button pButton icon="pi pi-times" label="Rechazar" severity="danger" [outlined]="true"
                        [disabled]="acting()" (click)="openReject(o)"></button>
              </div>
            } @else {
              <div class="wo-pick"><i class="pi pi-arrow-left"></i> Elegí un pedido de la lista para revisarlo.</div>
            }
          </div>
        </div>
      }

      <!-- Diálogo de rechazo -->
      <p-dialog header="Rechazar pedido" [(visible)]="rejectOpen" [modal]="true" [style]="{ width: '28rem' }">
        <p class="wo-reject-hint">Se avisa al cliente por WhatsApp. Motivo (opcional):</p>
        <input pInputText class="wo-reject-in" [(ngModel)]="rejectReason" placeholder="ej. sin stock, fuera de zona…" />
        <ng-template pTemplate="footer">
          <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="rejectOpen = false"></button>
          <button pButton label="Rechazar" severity="danger" [loading]="acting()" (click)="doReject()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .wo-grid { display:grid; grid-template-columns: minmax(280px, 360px) 1fr; gap:1rem; align-items:start; }
    .wo-list, .wo-detail { padding:0; overflow:hidden; }
    .wo-detail { padding:1.25rem; }
    .wo-cust { font-weight:600; color:var(--text-main); }
    .wo-phone { font-size:.8rem; color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .wo-detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .wo-detail-title { font-weight:700; font-size:1.05rem; color:var(--text-main); }
    .wo-detail-phone { font-size:.85rem; color:var(--text-muted); margin-top:.15rem; }
    .wo-sectitle { font-size:.9rem; font-weight:700; color:var(--text-main); margin:1.25rem 0 .6rem; }
    .wo-addr { font-size:.9rem; color:var(--text-main); line-height:1.5; }
    .wo-addr-ref { color:var(--text-muted); font-size:.85rem; }
    .wo-addr-missing { color:var(--warn-soft-fg); font-size:.85rem; display:flex; align-items:center; gap:.4rem; }
    .wo-advisory { display:flex; gap:.5rem; align-items:center; padding:.65rem .85rem; border-radius:var(--r-sm);
      background:var(--layout-bg); color:var(--text-muted); border:1px solid var(--border-color); font-size:.85rem; margin-top:1rem; }
    .wo-actions { margin-top:1.25rem; display:flex; gap:.6rem; flex-wrap:wrap; }
    .wo-pick { color:var(--text-faint); display:flex; align-items:center; gap:.5rem; padding:2rem 0; justify-content:center; }
    .wo-empty { text-align:center; color:var(--text-faint); padding:3rem 0; }
    .wo-empty i { font-size:2rem; display:block; margin-bottom:.5rem; }
    .wo-reject-hint { font-size:.85rem; color:var(--text-muted); margin:0 0 .6rem; }
    .wo-reject-in { width:100%; }
    @media (max-width: 820px) { .wo-grid { grid-template-columns:1fr; } }
  `],
})
export class WhatsAppOrdersComponent implements OnInit {
  private readonly svc = inject(WhatsAppOrdersService);
  private readonly toast = inject(MessageService);

  readonly orders = signal<WhatsAppPendingOrder[]>([]);
  readonly loading = signal(false);
  readonly acting = signal(false);
  selected: WhatsAppPendingOrder | null = null;
  rejectOpen = false;
  rejectReason = '';

  ngOnInit(): void { this.load(); }

  money(v: number | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  load(): void {
    this.loading.set(true);
    this.svc.listPending().subscribe({
      next: (d) => {
        this.orders.set(d || []);
        // Mantener selección si sigue existiendo; si no, primera.
        const keep = this.selected && (d || []).find((o) => o.thread_id === this.selected!.thread_id);
        this.selected = keep || (d?.length ? d[0] : null);
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar la bandeja' }); },
    });
  }

  confirm(o: WhatsAppPendingOrder): void {
    this.acting.set(true);
    this.svc.confirm(o.thread_id).subscribe({
      next: (r) => {
        this.acting.set(false);
        this.toast.add({ severity: 'success', summary: `Pedido ${r.code} confirmado`, detail: 'Ya podés asignarlo a un repartidor.' });
        this.removeAndReselect(o.thread_id);
      },
      error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo confirmar', detail: e?.error?.message }); },
    });
  }

  openReject(o: WhatsAppPendingOrder): void {
    this.selected = o;
    this.rejectReason = '';
    this.rejectOpen = true;
  }

  doReject(): void {
    if (!this.selected) return;
    const id = this.selected.thread_id;
    this.acting.set(true);
    this.svc.reject(id, this.rejectReason.trim() || undefined).subscribe({
      next: () => {
        this.acting.set(false);
        this.rejectOpen = false;
        this.toast.add({ severity: 'info', summary: 'Pedido rechazado', detail: 'Se avisó al cliente.' });
        this.removeAndReselect(id);
      },
      error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo rechazar', detail: e?.error?.message }); },
    });
  }

  private removeAndReselect(threadId: string): void {
    const rest = this.orders().filter((o) => o.thread_id !== threadId);
    this.orders.set(rest);
    this.selected = rest.length ? rest[0] : null;
  }
}
