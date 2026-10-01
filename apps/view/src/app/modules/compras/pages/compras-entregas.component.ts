import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { PurchaseDeliveryDetail, PurchaseDeliveryStatus, PurchaseDeliverySummary } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { money } from '../../../shared/util/money.util';
import { ESTADO_ENTREGA_LABEL, agruparPorSucursal, dia, evidenciaLabel } from '../compras-entrega';

/**
 * `[RE.32]` — **Entregas a Finanzas.** Los folios `ENT-YYYY-NNNNN`: quién entregó, quién recibe y en
 * qué quedó cada renglón. La persona de Finanzas a quien se le entregó la CONFIRMA aquí y puede
 * regresar renglones con motivo (vuelven a "Por entregar"); Compras puede cancelarla mientras nadie
 * la confirme. El PDF se reimprime del snapshot guardado.
 */
@Component({
  selector: 'app-compras-entregas',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, CheckboxModule, DialogModule, TagModule, ToastModule,
    SegmentedComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <p-toast></p-toast>
    <div class="en-bar">
      <app-segmented [options]="filterOpts()" [value]="filter()" (valueChange)="setFilter($event)" ariaLabel="Filtrar entregas" />
      <button pButton type="button" class="p-button-sm p-button-text" (click)="load()" [disabled]="loading()">
        <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span>
      </button>
    </div>

    <app-load-state class="dt-scope" [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && !rows().length"
                    emptyTitle="Sin entregas" emptyHint="Las entregas se generan en la pestaña Por entregar." (retry)="load()">
      <p-table [value]="rows()" size="small" class="surf-table en-table dt-stack">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Entregada</th><th>Entregó</th><th>Recibe</th><th class="ta-r">Entradas</th><th class="ta-r">Importe</th><th>Estado</th>
            <th style="width:6rem"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-d>
          <tr>
            <td class="mono dt-id" role="cell" data-label="Folio"><b>{{ d.code }}</b></td>
            <td class="mono" role="cell" data-label="Entregada">{{ d.delivered_at | date: 'dd/MM/yy HH:mm' }}</td>
            <td role="cell" data-label="Entregó">{{ d.delivered_by_name || d.delivered_by }}</td>
            <td role="cell" data-label="Recibe">{{ d.recipient_name || d.recipient_username }} @if (d.recipient_username === me()) { <span class="en-me">(tú)</span> }</td>
            <td class="ta-r mono dt-num" role="cell" data-label="Entradas">{{ d.line_count }}</td>
            <td class="ta-r mono dt-num" role="cell" data-label="Importe">{{ money(d.total_amount) }}</td>
            <td role="cell" data-label="Estado"><p-tag [value]="estado(d.status)" [severity]="sev(d.status)" styleClass="en-tag" /></td>
            <td class="en-actions dt-actions" role="cell">
              <button pButton type="button" class="p-button-sm p-button-text" (click)="open(d)" [attr.aria-label]="'Ver ' + d.code"><span class="pi pi-eye" aria-hidden="true"></span></button>
              <button pButton type="button" class="p-button-sm p-button-text" (click)="pdf(d)" [attr.aria-label]="'PDF de ' + d.code"><span class="pi pi-file-pdf" aria-hidden="true"></span></button>
            </td>
          </tr>
        </ng-template>
      </p-table>
    </app-load-state>

    <p-dialog [visible]="dlg()" (visibleChange)="dlg.set($event)" [modal]="true" [style]="{ width: '64rem' }" [maximizable]="true"
              [header]="det() ? det()!.code + ' · ' + estado(det()!.status) : 'Entrega'">
      @if (det(); as d) {
        <p class="en-meta">Entregó <b>{{ d.delivered_by_name || d.delivered_by }}</b> el {{ d.delivered_at | date: 'dd/MM/yy HH:mm' }} ·
          recibe <b>{{ d.recipient_name || d.recipient_username }}</b>
          @if (d.received_at) { · confirmó {{ d.received_by }} el {{ d.received_at | date: 'dd/MM/yy HH:mm' }} }
          @if (d.notes) { · <i>{{ d.notes }}</i> }</p>

        @if (canReceive(d)) {
          <div class="en-gap" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i>
            <p>Revisa contra el papel. Lo que no llegó o no cuadra, márcalo como <b>rechazado</b> con su motivo: regresa a Compras. Lo demás queda aceptado al confirmar.</p>
          </div>
        }

        <div class="dt-scope">
        <p-table [value]="d.lines" size="small" class="surf-table en-table dt-stack" rowGroupMode="subheader" groupRowsBy="sucursal" dataKey="id">
          <ng-template #header>
            <tr>
              @if (canReceive(d)) { <th style="width:5.5rem">Rechazar</th> }
              <th>Recepción</th><th>Factura</th><th>Proveedor</th><th>Folio Kepler</th><th>Evidencia</th><th>Estado</th><th class="ta-r">Importe</th>
            </tr>
          </ng-template>
          <ng-template #groupheader let-l>
            <tr class="en-group"><td [attr.colspan]="canReceive(d) ? 7 : 6" role="cell"><b>{{ grupoDe(l.sucursal)?.nombre }}</b> · {{ grupoDe(l.sucursal)?.rows?.length }}</td>
              <td class="ta-r mono dt-num" role="cell" data-label="Total sucursal"><b>{{ money(subtotal(l.sucursal)) }}</b></td></tr>
          </ng-template>
          <ng-template #body let-l>
            <tr [class.en-rej]="rej().has(l.id) || l.status === 'rechazado'">
              @if (canReceive(d)) {
                <td class="dt-actions" role="cell" data-label="Rechazar"><p-checkbox [binary]="true" [ngModel]="rej().has(l.id)" (onChange)="toggleRej(l.id)" [ariaLabel]="'Rechazar ' + l.folio" /></td>
              }
              <td class="mono" role="cell" data-label="Recepción">{{ dia(l.reception_date) }}</td>
              <td class="mono en-muted" role="cell" data-label="Factura">{{ dia(l.invoice_date) }}</td>
              <td class="dt-id" role="cell" data-label="Proveedor">{{ l.supplier_name || l.supplier_code || '—' }}</td>
              <td class="mono" role="cell" data-label="Folio Kepler">{{ l.folio }}</td>
              <td role="cell" data-label="Evidencia">{{ evidencia(l.evidence_status) }}</td>
              <td role="cell" data-label="Estado">
                @if (canReceive(d) && rej().has(l.id)) {
                  <input pInputText type="text" class="en-reason" placeholder="Motivo (obligatorio)" [ngModel]="rej().get(l.id)"
                         (ngModelChange)="setReason(l.id, $event)" [attr.aria-label]="'Motivo de rechazo de ' + l.folio" />
                } @else {
                  {{ lineaLabel(l.status) }} @if (l.rejection_reason) { <span class="en-muted">· {{ l.rejection_reason }}</span> }
                }
              </td>
              <td class="ta-r mono dt-num" role="cell" data-label="Importe">{{ money(l.amount) }}</td>
            </tr>
          </ng-template>
        </p-table>
        </div>

        @if (canCancel(d)) {
          <div class="en-cancel">
            <label class="en-lbl" for="en-cancel">Motivo para cancelar la entrega</label>
            <input pInputText id="en-cancel" type="text" class="en-full" [ngModel]="cancelReason()" (ngModelChange)="cancelReason.set($event)" />
          </div>
        }
      }
      <ng-template #footer>
        @if (det(); as d) {
          @if (receiveBlock(); as why) { <span class="en-block">{{ why }}</span> }
          <button pButton type="button" class="p-button-text" (click)="pdf(d)"><span class="pi pi-file-pdf" aria-hidden="true"></span>&nbsp;PDF</button>
          @if (canCancel(d)) {
            <button pButton type="button" class="p-button-text p-button-danger" (click)="cancel(d)" [disabled]="!cancelReason().trim() || saving()">Cancelar entrega</button>
          }
          @if (canReceive(d)) {
            <button pButton type="button" (click)="receive(d)" [disabled]="!!receiveBlock() || saving()" [loading]="saving()">
              Confirmar recepción ({{ d.lines.length - rej().size }} aceptadas{{ rej().size ? ', ' + rej().size + ' rechazadas' : '' }})
            </button>
          }
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .en-bar { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin: .8rem 0 .6rem; }
    .en-table { font-size:.84rem; }
    .ta-r { text-align:right; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .en-muted { color: var(--text-muted); }
    .en-me { font-size:.72rem; color: var(--action); }
    .en-actions { white-space:nowrap; }
    :host ::ng-deep .en-tag { font-size:.64rem; }
    .en-meta { margin: 0 0 .6rem; font-size:.82rem; color: var(--text-muted); }
    .en-gap { display:flex; gap: var(--sp-2); align-items:flex-start; padding: var(--sp-2) var(--sp-3); margin: 0 0 .6rem;
      border-left: 3px solid var(--info-fg); background: var(--info-soft-bg); font-size:.8rem; }
    .en-gap p { margin:0; }
    .en-group td { background: var(--card-bg); }
    .en-rej td { background: color-mix(in srgb, var(--bad-fg) 7%, transparent); }
    .en-reason { width: 100%; min-width: 12rem; }
    .en-cancel { margin-top: .8rem; }
    .en-lbl { display:block; font-size:.76rem; color: var(--text-muted); margin-bottom:.25rem; }
    .en-full { width:100%; }
    .en-block { font-size:.75rem; color: var(--text-muted); margin-right:auto; }
  `],
})
export class ComprasEntregasComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly api = `${environment.apiUrl}/commercial/purchase-deliveries`;

  readonly money = money;
  readonly dia = dia;
  readonly evidencia = evidenciaLabel;

  readonly me = computed(() => this.auth.user()?.username ?? null);
  private readonly esFinanzas = computed(() => this.perms.has(Permission.FINANCE_PAYMENTS_GESTIONAR));
  private readonly esCompras = computed(() => this.perms.has(Permission.COMPRAS_OBLIGACIONES_VER));

  readonly filterOpts = computed<SegOption[]>(() => [
    ...(this.esFinanzas() ? [{ label: 'Para mí', value: 'mine' }] : []),
    { label: 'Por confirmar', value: 'entregada' },
    { label: 'Todas', value: 'todas' },
  ]);
  readonly filter = signal<string>('entregada');

  readonly rows = signal<PurchaseDeliverySummary[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly dlg = signal(false);
  readonly det = signal<PurchaseDeliveryDetail | null>(null);
  /** line_id → motivo de rechazo (se captura en el renglón). */
  readonly rej = signal<Map<string, string>>(new Map());
  readonly cancelReason = signal('');
  readonly saving = signal(false);
  private readonly grupos = computed(() => agruparPorSucursal(this.det()?.lines ?? []));
  /** Subtotal sin cancelados: cuadra con el total del PDF (los cancelados se listan pero no suman). */
  private readonly subtotales = computed(() => new Map(agruparPorSucursal((this.det()?.lines ?? []).filter((l) => l.status !== 'cancelado')).map((g) => [g.sucursal, g.total])));

  readonly receiveBlock = computed<string | null>(() => {
    const d = this.det();
    if (!d || !this.canReceive(d)) return null;
    for (const [, reason] of this.rej()) if (!reason?.trim()) return 'Escribe el motivo de cada renglón rechazado.';
    return null;
  });

  ngOnInit(): void {
    // Quien es de Finanzas y no de Compras entra directo a su bandeja.
    if (this.esFinanzas() && !this.esCompras()) this.filter.set('mine');
    this.load();
  }

  setFilter(v: string): void { this.filter.set(v); this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const f = this.filter();
    const params: Record<string, string> = {};
    if (f === 'mine') { params['mine'] = '1'; params['status'] = 'entregada'; } else if (f !== 'todas') params['status'] = f;
    this.http.get<PurchaseDeliverySummary[]>(this.api, { params }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.error.set(e?.error?.message || 'No se pudieron cargar las entregas.'); },
    });
  }

  estado(s: PurchaseDeliveryStatus): string { return ESTADO_ENTREGA_LABEL[s] ?? s; }
  sev(s: PurchaseDeliveryStatus): 'info' | 'success' | 'warn' | 'secondary' {
    return s === 'entregada' ? 'info' : s === 'recibida' ? 'success' : s === 'recibida_parcial' ? 'warn' : 'secondary';
  }
  lineaLabel(s: string): string {
    return s === 'entregado' ? 'Por confirmar' : s === 'aceptado' ? 'Aceptado' : s === 'rechazado' ? 'Rechazado' : 'Cancelado';
  }
  grupoDe(suc: string) { return this.grupos().find((g) => g.sucursal === suc); }
  subtotal(suc: string): number { return this.subtotales().get(suc) ?? 0; }

  /** Sólo la persona a quien se le entregó, con el permiso de pagos, y mientras siga por confirmar. */
  canReceive(d: PurchaseDeliveryDetail): boolean {
    return d.status === 'entregada' && d.recipient_username === this.me() && this.esFinanzas();
  }
  canCancel(d: PurchaseDeliveryDetail): boolean {
    return d.status === 'entregada' && this.perms.has(Permission.COMPRAS_OBLIGACIONES_GESTIONAR);
  }

  open(s: PurchaseDeliverySummary): void {
    this.rej.set(new Map());
    this.cancelReason.set('');
    this.det.set(null);
    this.dlg.set(true);
    this.fetch(s.id, (d) => this.det.set(d));
  }

  pdf(s: PurchaseDeliverySummary): void {
    this.fetch(s.id, async (d) => {
      try {
        const { generarEntregaPdf } = await import('../compras-entrega-pdf');
        await generarEntregaPdf(d, new Date());
      } catch {
        this.toast.add({ severity: 'error', summary: 'PDF', detail: `No se pudo generar el PDF de ${d.code}.` });
      }
    });
  }

  toggleRej(id: string): void {
    const m = new Map(this.rej());
    if (m.has(id)) m.delete(id); else m.set(id, '');
    this.rej.set(m);
  }
  setReason(id: string, v: string): void { const m = new Map(this.rej()); m.set(id, v); this.rej.set(m); }

  receive(d: PurchaseDeliveryDetail): void {
    if (this.receiveBlock()) return;
    const rejections = [...this.rej()].map(([line_id, reason]) => ({ line_id, reason: reason.trim() }));
    this.saving.set(true);
    this.http.post<PurchaseDeliveryDetail>(`${this.api}/${d.id}/recibir`, { rejections }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.det.set(r);
        this.rej.set(new Map());
        this.toast.add({ severity: 'success', summary: `${r.code} confirmada`, detail: rejections.length ? `${rejections.length} renglón(es) regresan a Compras.` : 'Todo aceptado.' });
        this.load();
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'No se confirmó', detail: e?.error?.message || 'Error al confirmar.' }); },
    });
  }

  cancel(d: PurchaseDeliveryDetail): void {
    const reason = this.cancelReason().trim();
    if (!reason) return;
    this.saving.set(true);
    this.http.post<PurchaseDeliveryDetail>(`${this.api}/${d.id}/cancelar`, { reason }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.det.set(r);
        this.toast.add({ severity: 'info', summary: `${r.code} cancelada`, detail: 'Sus entradas regresan a Por entregar.' });
        this.load();
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'No se canceló', detail: e?.error?.message || 'Error al cancelar.' }); },
    });
  }

  private fetch(id: string, then: (d: PurchaseDeliveryDetail) => void): void {
    this.http.get<PurchaseDeliveryDetail>(`${this.api}/${id}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: then,
      error: (e) => this.toast.add({ severity: 'error', summary: 'Entrega', detail: e?.error?.message || 'No se pudo abrir la entrega.' }),
    });
  }
}
