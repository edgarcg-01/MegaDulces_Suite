import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ProductSearchComponent, ProductHit } from '../../comercial/components/product-search.component';
import { ReceivingSessionService, ReceivingSession, ReceivingLine, DiscrepancyKind } from '../receiving-session.service';

/**
 * Fase WMS-REC (Pieza 1, ADR-044) — Estación de recepción (handheld). Escaneo
 * caja→pieza contra lo esperado, con "qué falta validar" en vivo + faltantes/sobrantes.
 */
@Component({
  selector: 'app-almacen-recepcion-sesion',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, ToastModule, ConfirmDialogModule, ProductSearchComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <button pButton [text]="true" size="small" severity="secondary" (click)="back()"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Vales</button>
          <h1>{{ session()?.folio || 'Sesión' }}
            @if (session(); as s) { <p-tag [value]="statusLabel(s.status)" [severity]="statusSeverity(s.status)"></p-tag> }
          </h1>
          <p class="surf-page-sub">
            {{ session()?.warehouse_code }} · {{ session()?.warehouse_name }}
            @if (session()?.supplier_code) { · Prov {{ session()?.supplier_code }} }
            @if (session()?.source_ref) { · ERP {{ session()?.source_ref }} }
          </p>
        </div>
        @if (isOpen()) {
          <div class="rsd-head-actions">
            <button pButton size="small" severity="secondary" [outlined]="true" (click)="confirmCancel()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span> Cancelar</button>
            <button pButton size="small" (click)="confirmClose()" [loading]="closing()"><span class="p-button-icon p-button-icon-left pi pi-check-circle" aria-hidden="true"></span> Cerrar sesión</button>
          </div>
        }
      </header>

      @if (session()?.progress; as pr) {
        <div class="rsd-kpis">
          <div class="rsd-kpi"><span class="rsd-kpi-n">{{ pr.lines }}</span><span class="rsd-kpi-l">líneas</span></div>
          <div class="rsd-kpi" [class.rsd-warn]="pr.pending > 0"><span class="rsd-kpi-n">{{ pr.pending }}</span><span class="rsd-kpi-l">por validar</span></div>
          <div class="rsd-kpi" [class.rsd-bad]="pr.discrepancies > 0"><span class="rsd-kpi-n">{{ pr.discrepancies }}</span><span class="rsd-kpi-l">discrepancias</span></div>
          <div class="rsd-kpi"><span class="rsd-kpi-n">{{ pr.received_units }}/{{ pr.expected_units }}</span><span class="rsd-kpi-l">unidades</span></div>
        </div>
      }

      @if (isOpen()) {
        <div class="rsd-scan surf-card">
          <label class="rsd-scan-field">
            <span>Escanear código de barras / SKU</span>
            <div class="rsd-scan-row">
              <input pInputText [(ngModel)]="scanCode" (keyup.enter)="onScan()" placeholder="Escaneá o tecleá y Enter" autofocus [disabled]="scanning()" />
              <input pInputText type="number" min="1" [(ngModel)]="scanQty" class="rsd-qty" title="Cantidad" />
              <button pButton (click)="onScan()" [loading]="scanning()"><span class="p-button-icon pi pi-barcode" aria-hidden="true"></span></button>
            </div>
          </label>
          <div class="rsd-add">
            <app-product-search (productSelected)="addProduct = $event"></app-product-search>
            <input pInputText type="number" min="0" [(ngModel)]="addExpected" class="rsd-qty" placeholder="Esperado" title="Cantidad esperada" />
            <button pButton [text]="true" severity="secondary" size="small" (click)="onAddLine()" [disabled]="!addProduct"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Agregar línea</button>
          </div>
        </div>
      }

      <p-table [value]="lines()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th scope="col">SKU</th><th scope="col">Producto</th><th scope="col" class="num">Esperado</th>
            <th scope="col" class="num">Recibido</th><th scope="col">Estado</th><th scope="col"></th>
          </tr>
        </ng-template>
        <ng-template #body let-l>
          <tr [class.rsd-row-disc]="isDiscrepancy(l.discrepancy_kind)">
            <td class="rsd-mono">{{ l.sku || l.expected_sku || '—' }}</td>
            <td class="rsd-name">{{ l.product_name || l.expected_name || l.product_id || '—' }}</td>
            <td class="num">{{ l.expected_qty }}</td>
            <td class="num rsd-rec">{{ l.received_qty }}</td>
            <td><p-tag [value]="discLabel(l.discrepancy_kind)" [severity]="discSeverity(l.discrepancy_kind)"></p-tag></td>
            <td class="rsd-actions">
              @if (isOpen()) {
                <button pButton size="small" [text]="true" severity="secondary" (click)="adjust(l, -1)" title="-1"><span class="pi pi-minus" aria-hidden="true"></span></button>
                <button pButton size="small" [text]="true" severity="secondary" (click)="adjust(l, 1)" title="+1"><span class="pi pi-plus" aria-hidden="true"></span></button>
                <p-select [options]="markOptions" [ngModel]="null" (onChange)="mark(l, $event.value)" placeholder="⚑" styleClass="rsd-mark" [showClear]="false"></p-select>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="6" class="comm-empty-cell"><div class="comm-empty"><h3>Sin líneas</h3><p>Escaneá productos o agregá líneas esperadas.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .surf-page-head-text h1 { display: flex; align-items: center; gap: .6rem; }
    .rsd-head-actions { display: flex; gap: .5rem; align-items: center; }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .rsd-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 0 0 1rem; }
    .rsd-kpi { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; }
    .rsd-kpi-n { font-size: 1.4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .rsd-kpi-l { font-size: .74rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .04em; }
    .rsd-kpi.rsd-warn .rsd-kpi-n { color: var(--warn-fg, #b45309); }
    .rsd-kpi.rsd-bad .rsd-kpi-n { color: var(--bad-fg, #b91c1c); }
    .rsd-scan-field { display: flex; flex-direction: column; gap: .25rem; }
    .rsd-scan-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .rsd-scan-row { display: flex; gap: .5rem; }
    .rsd-scan-row > input[pInputText]:first-child { flex: 1; font-size: 1.05rem; }
    .rsd-qty { max-width: 90px; }
    .rsd-add { display: flex; gap: .5rem; align-items: center; margin-top: .75rem; flex-wrap: wrap; }
    .rsd-mono { font-family: var(--font-mono, monospace); }
    .rsd-name { max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rsd-rec { font-weight: 700; }
    .rsd-actions { display: flex; gap: .25rem; align-items: center; }
    :host ::ng-deep .rsd-mark { min-width: 64px; }
    .rsd-row-disc { background: var(--warn-soft-bg, #fffbeb); }
  `],
})
export class AlmacenRecepcionSesionComponent implements OnInit {
  private readonly svc = inject(ReceivingSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly session = signal<ReceivingSession | null>(null);
  readonly lines = computed<ReceivingLine[]>(() => this.session()?.lines || []);
  readonly scanning = signal(false);
  readonly closing = signal(false);
  scanCode = '';
  scanQty = 1;
  addProduct: ProductHit | null = null;
  addExpected: number | null = null;

  readonly markOptions = [
    { label: 'Dañado', value: 'dañado' },
    { label: 'Producto incorrecto', value: 'producto_incorrecto' },
  ];

  private sessionId = '';

  ngOnInit(): void {
    this.sessionId = this.route.snapshot.paramMap.get('id') || '';
    if (this.sessionId) this.refresh();
  }

  isOpen(): boolean { return this.session()?.status === 'open'; }

  private refresh(): void {
    this.svc.detail(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.session.set(s),
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar' }),
    });
  }

  onScan(): void {
    const code = this.scanCode.trim();
    if (!code) return;
    const qty = Number(this.scanQty) > 0 ? Number(this.scanQty) : 1;
    this.scanning.set(true);
    this.svc.scan(this.sessionId, { barcode: code, qty }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.session.set(s); this.scanCode = ''; this.scanQty = 1; this.scanning.set(false); },
      error: (e) => { this.scanning.set(false); this.toast.add({ severity: 'warn', summary: 'Escaneo', detail: e?.error?.message || `Sin producto para '${code}'` }); },
    });
  }

  onAddLine(): void {
    if (!this.addProduct) return;
    this.svc.addLine(this.sessionId, { product_id: this.addProduct.id, expected_qty: this.addExpected ? Number(this.addExpected) : 0 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (s) => { this.session.set(s); this.addProduct = null; this.addExpected = null; },
        error: (e) => this.toast.add({ severity: 'warn', summary: 'Agregar', detail: e?.error?.message || 'No se pudo agregar' }),
      });
  }

  adjust(line: ReceivingLine, delta: number): void {
    const received = Math.max(0, Number(line.received_qty) + delta);
    this.svc.setLine(this.sessionId, line.id, { received_qty: received }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.session.set(s),
      error: (e) => this.toast.add({ severity: 'warn', summary: 'Ajuste', detail: e?.error?.message || 'No se pudo ajustar' }),
    });
  }

  mark(line: ReceivingLine, kind: DiscrepancyKind): void {
    if (!kind) return;
    this.svc.setLine(this.sessionId, line.id, { discrepancy_kind: kind }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.session.set(s),
      error: (e) => this.toast.add({ severity: 'warn', summary: 'Marca', detail: e?.error?.message || 'No se pudo marcar' }),
    });
  }

  confirmClose(): void {
    this.confirm.confirm({
      message: '¿Cerrar la sesión? Las líneas esperadas sin recibir quedarán como faltante.',
      header: 'Cerrar sesión', icon: 'pi pi-check-circle',
      accept: () => this.doClose(),
    });
  }
  private doClose(): void {
    this.closing.set(true);
    this.svc.close(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.session.set(s); this.closing.set(false); this.toast.add({ severity: 'success', summary: 'Sesión cerrada' }); },
      error: (e) => { this.closing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cerrar' }); },
    });
  }

  confirmCancel(): void {
    this.confirm.confirm({
      message: '¿Cancelar la sesión? No se registrará como recepción.',
      header: 'Cancelar sesión', icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.svc.cancel(this.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (s) => { this.session.set(s); this.toast.add({ severity: 'info', summary: 'Sesión cancelada' }); },
          error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cancelar' }),
        });
      },
    });
  }

  back(): void { this.router.navigate(['/almacen/inventory/recepcion-sesiones']); }

  isDiscrepancy(k: string): boolean { return ['faltante', 'sobrante', 'producto_incorrecto', 'dañado'].includes(k); }
  discLabel(k: string): string {
    switch (k) {
      case 'ok': return 'OK';
      case 'pending': return 'Pendiente';
      case 'faltante': return 'Faltante';
      case 'sobrante': return 'Sobrante';
      case 'dañado': return 'Dañado';
      case 'producto_incorrecto': return 'Prod. incorrecto';
      default: return k;
    }
  }
  discSeverity(k: string): 'success' | 'secondary' | 'warn' | 'danger' {
    if (k === 'ok') return 'success';
    if (k === 'pending') return 'secondary';
    if (k === 'sobrante') return 'warn';
    return 'danger';
  }
  statusLabel(s: string): string {
    return s === 'open' ? 'Abierta' : s === 'closed' ? 'Cerrada' : s === 'validating' ? 'Validando' : 'Cancelada';
  }
  statusSeverity(s: string): 'success' | 'secondary' | 'warn' | 'danger' {
    return s === 'open' ? 'success' : s === 'closed' ? 'secondary' : s === 'validating' ? 'warn' : 'danger';
  }
}
