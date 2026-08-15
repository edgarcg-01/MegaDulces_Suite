import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { ProductSearchComponent, ProductHit } from '../../comercial/components/product-search.component';
import { ReceivingAuditorService, ReceivingCapture, SupplierScore } from '../receiving-auditor.service';

type Verdict = 'green' | 'yellow' | 'red';

/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 *
 * El operador, en la recepción: elige almacén + producto, fotografía la impresión
 * de lote/caducidad, el OCR propone lote+fecha, confirma, y el sistema le da el
 * semáforo 🟢🟡🔴 comparando contra el inventario existente + la política. El rojo
 * queda como No Conformidad pendiente de autorización de un supervisor.
 */
@Component({
  selector: 'app-almacen-recepcion-auditor',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, ToastModule, ProductSearchComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Recepción · Auditor de caducidad</h1>
          <p class="surf-page-sub">Captura lote y caducidad con foto + OCR; el sistema audita contra el inventario existente</p>
        </div>
      </header>

      <div class="rec-layout">
        <!-- Panel de captura -->
        <section class="rec-capture surf-card">
          <h2 class="rec-h2">Nueva captura</h2>

          <label class="rec-field">
            <span>Almacén</span>
            <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value"
              placeholder="Elegí un almacén" styleClass="rec-w"></p-select>
          </label>

          <label class="rec-field">
            <span>Producto</span>
            <app-product-search (productSelected)="onProduct($event)"></app-product-search>
            @if (product()) { <small class="rec-hint">{{ product()!.sku || '—' }} · {{ product()!.label }}</small> }
          </label>

          <div class="rec-row">
            <label class="rec-field">
              <span>Proveedor (código)</span>
              <input pInputText [(ngModel)]="supplierCode" placeholder="ej. C001" />
            </label>
            <label class="rec-field">
              <span>Cantidad recibida</span>
              <input pInputText type="number" min="1" [(ngModel)]="quantity" />
            </label>
          </div>

          <label class="rec-field">
            <span>Foto del lote/caducidad</span>
            <input type="file" accept="image/*" capture="environment" (change)="onFile($event)" />
          </label>

          @if (photoDataUri()) {
            <div class="rec-photo">
              <img [src]="photoDataUri()!" alt="Evidencia de caducidad" />
              <button pButton size="small" [text]="true" severity="secondary" (click)="runOcr()" [loading]="ocrRunning()">
                <span class="p-button-icon p-button-icon-left pi pi-sparkles" aria-hidden="true"></span> Leer con OCR
              </button>
            </div>
          }

          <div class="rec-row">
            <label class="rec-field">
              <span>Lote</span>
              <input pInputText [(ngModel)]="confirmedLot" placeholder="NA" />
            </label>
            <label class="rec-field">
              <span>Caducidad</span>
              <input pInputText type="date" [(ngModel)]="confirmedExpiry" />
            </label>
          </div>
          @if (ocrConfidence() != null) {
            <small class="rec-hint" [class.rec-lowconf]="ocrConfidence()! < 0.6">
              OCR confianza {{ (ocrConfidence()! * 100) | number:'1.0-0' }}%{{ ocrConfidence()! < 0.6 ? ' — verificá a mano' : '' }}
            </small>
          }

          <button pButton class="rec-eval" (click)="evaluate()" [disabled]="!canEvaluate()" [loading]="evaluating()">
            <span class="p-button-icon p-button-icon-left pi pi-check-circle" aria-hidden="true"></span> Evaluar y recibir
          </button>

          @if (lastResult(); as r) {
            <div class="rec-verdict" [class]="'rec-verdict--' + r.verdict">
              <p-tag [value]="verdictLabel(r.verdict)" [severity]="verdictSeverity(r.verdict)"></p-tag>
              <div class="rec-verdict-body">
                @if (r.verdict === 'green') { <p>Recepción normal. Stock actualizado.</p> }
                @if (r.verdict === 'yellow') { <p>Aceptada con advertencia ({{ ruleLabel(r.rule_broken) }}). Stock actualizado.</p> }
                @if (r.verdict === 'red') { <p><strong>No conformidad:</strong> {{ ruleLabel(r.rule_broken) }}. No se recibió: requiere autorización de un supervisor.</p> }
                @if (r.existing_min_expiry) { <small>Caducidad más próxima en stock: {{ r.existing_min_expiry }}</small> }
              </div>
            </div>
          }
        </section>

        <!-- Bandeja + scorecard -->
        <section class="rec-side">
          <div class="surf-card">
            <div class="rec-side-head"><h2 class="rec-h2">No conformidades pendientes</h2>
              <button pButton [text]="true" size="small" severity="secondary" (click)="reload()" [loading]="loading()"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
            </div>
            <p-table [value]="pendingReds()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="320px">
              <ng-template #header>
                <tr><th scope="col">Producto</th><th scope="col">Prov</th><th scope="col">Caduca</th><th scope="col">Motivo</th><th scope="col"></th></tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="rec-name">{{ r.product_name || r.product_id }}</td>
                  <td class="rec-mono">{{ r.supplier_code || '—' }}</td>
                  <td class="rec-mono">{{ r.confirmed_expiry || '—' }}</td>
                  <td><small>{{ ruleLabel(r.rule_broken) }}</small></td>
                  <td class="rec-actions">
                    <button pButton size="small" severity="success" [text]="true" (click)="authorize(r)" title="Autorizar"><span class="pi pi-check" aria-hidden="true"></span></button>
                    <button pButton size="small" severity="danger" [text]="true" (click)="reject(r)" title="Rechazar"><span class="pi pi-times" aria-hidden="true"></span></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="5" class="comm-empty-cell"><div class="comm-empty"><h3>Sin pendientes</h3><p>Ninguna recepción bloqueada por caducidad.</p></div></td></tr>
              </ng-template>
            </p-table>
          </div>

          <div class="surf-card">
            <h2 class="rec-h2">Scorecard de proveedor</h2>
            <p-table [value]="scorecard()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="240px">
              <ng-template #header>
                <tr><th scope="col">Proveedor</th><th scope="col" class="num">Recep.</th><th scope="col" class="num">NC</th><th scope="col" class="num">% NC</th></tr>
              </ng-template>
              <ng-template #body let-s>
                <tr>
                  <td class="rec-mono">{{ s.supplier_code }}</td>
                  <td class="num">{{ s.receptions }}</td>
                  <td class="num">{{ s.nonconformities }}</td>
                  <td class="num"><p-tag [value]="s.nc_rate_pct + '%'" [severity]="+s.nc_rate_pct > 20 ? 'danger' : (+s.nc_rate_pct > 0 ? 'warn' : 'success')"></p-tag></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="4" class="comm-empty-cell"><div class="comm-empty"><p>Sin recepciones registradas todavía.</p></div></td></tr>
              </ng-template>
            </p-table>
          </div>
        </section>
      </div>
    </div>
  `,
  styles: [`
    .rec-layout { display: grid; grid-template-columns: minmax(340px, 460px) 1fr; gap: 1rem; align-items: start; }
    @media (max-width: 900px) { .rec-layout { grid-template-columns: 1fr; } }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; }
    .rec-side { display: flex; flex-direction: column; gap: 1rem; }
    .rec-h2 { font-size: .95rem; font-weight: 700; margin: 0 0 .75rem; }
    .rec-side-head { display: flex; justify-content: space-between; align-items: center; }
    .rec-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .rec-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .rec-field input[pInputText], .rec-field input[type=number], .rec-field input[type=date] { width: 100%; }
    .rec-row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .rec-hint { font-size: .78rem; color: var(--text-color-secondary); }
    .rec-lowconf { color: var(--bad-fg, #b91c1c); font-weight: 600; }
    :host ::ng-deep .rec-w { width: 100%; }
    .rec-photo { display: flex; flex-direction: column; gap: .5rem; margin-bottom: .75rem; }
    .rec-photo img { max-width: 100%; max-height: 180px; object-fit: contain; border: 1px solid var(--surface-border); border-radius: 8px; }
    .rec-eval { width: 100%; margin-top: .25rem; }
    .rec-verdict { display: flex; gap: .6rem; margin-top: 1rem; padding: .75rem; border-radius: 8px; align-items: flex-start; }
    .rec-verdict--green { background: var(--good-soft-bg, #ecfdf5); }
    .rec-verdict--yellow { background: var(--warn-soft-bg, #fffbeb); }
    .rec-verdict--red { background: var(--bad-soft-bg, #fef2f2); }
    .rec-verdict-body p { margin: 0 0 .25rem; font-size: .85rem; }
    .rec-verdict-body small { color: var(--text-color-secondary); }
    .rec-mono { font-family: var(--font-mono, monospace); }
    .rec-name { max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rec-actions { display: flex; gap: .25rem; }
  `],
})
export class AlmacenRecepcionAuditorComponent implements OnInit {
  private readonly svc = inject(ReceivingAuditorService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() =>
    this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })),
  );
  warehouseId = '';
  readonly product = signal<ProductHit | null>(null);
  supplierCode = '';
  quantity: number | null = null;
  confirmedLot = '';
  confirmedExpiry = '';

  readonly photoDataUri = signal<string | null>(null);
  readonly ocrConfidence = signal<number | null>(null);
  readonly ocrRunning = signal(false);
  readonly evaluating = signal(false);
  readonly loading = signal(false);
  readonly lastResult = signal<ReceivingCapture | null>(null);
  readonly captures = signal<ReceivingCapture[]>([]);
  readonly scorecard = signal<SupplierScore[]>([]);

  readonly pendingReds = computed(() =>
    this.captures().filter((c) => c.verdict === 'red' && c.status === 'pending_authorization'),
  );

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
    this.reload();
  }

  onProduct(hit: ProductHit | null): void {
    this.product.set(hit);
  }

  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.photoDataUri.set(String(reader.result));
      this.ocrConfidence.set(null);
    };
    reader.readAsDataURL(file);
  }

  runOcr(): void {
    const uri = this.photoDataUri();
    if (!uri) return;
    this.ocrRunning.set(true);
    this.svc.ocr(uri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocrRunning.set(false);
        if (r.lot_code) this.confirmedLot = r.lot_code;
        if (r.expiry_date) this.confirmedExpiry = r.expiry_date;
        this.ocrConfidence.set(r.confidence);
        if (!r.lot_code && !r.expiry_date) {
          this.toast.add({ severity: 'warn', summary: 'OCR', detail: 'No se distinguió lote/caducidad. Capturá a mano.' });
        }
      },
      error: () => {
        this.ocrRunning.set(false);
        this.toast.add({ severity: 'warn', summary: 'OCR', detail: 'No se pudo leer la foto. Capturá a mano.' });
      },
    });
  }

  canEvaluate(): boolean {
    return !!this.warehouseId && !!this.product() && !!this.quantity && this.quantity > 0;
  }

  evaluate(): void {
    if (!this.canEvaluate()) return;
    this.evaluating.set(true);
    this.svc.evaluate({
      warehouse_id: this.warehouseId,
      product_id: this.product()!.id,
      supplier_code: this.supplierCode?.trim() || undefined,
      quantity: Number(this.quantity),
      confirmed_lot: this.confirmedLot?.trim() || undefined,
      confirmed_expiry: this.confirmedExpiry || undefined,
      ocr_confidence: this.ocrConfidence() ?? undefined,
      photo_data_uri: this.photoDataUri() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.evaluating.set(false);
        this.lastResult.set(r);
        const sev = r.verdict === 'green' ? 'success' : r.verdict === 'yellow' ? 'warn' : 'error';
        this.toast.add({ severity: sev, summary: this.verdictLabel(r.verdict), detail: this.ruleLabel(r.rule_broken) || 'Recepción evaluada' });
        this.resetCapture();
        this.reload();
      },
      error: (e) => {
        this.evaluating.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo evaluar' });
      },
    });
  }

  authorize(row: ReceivingCapture): void {
    this.svc.authorize(row.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Autorizada', detail: 'Stock recibido' }); this.reload(); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo autorizar' }),
    });
  }

  reject(row: ReceivingCapture): void {
    this.svc.reject(row.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'info', summary: 'Rechazada', detail: 'Mercancía no recibida' }); this.reload(); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo rechazar' }),
    });
  }

  reload(): void {
    this.loading.set(true);
    this.svc.listCaptures({ limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.captures.set(rows || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.svc.scorecard().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => this.scorecard.set(rows || []),
      error: () => this.scorecard.set([]),
    });
  }

  private resetCapture(): void {
    this.product.set(null);
    this.supplierCode = '';
    this.quantity = null;
    this.confirmedLot = '';
    this.confirmedExpiry = '';
    this.photoDataUri.set(null);
    this.ocrConfidence.set(null);
  }

  verdictLabel(v: Verdict): string {
    return v === 'green' ? 'Aceptada' : v === 'yellow' ? 'Advertencia' : 'No conformidad';
  }
  verdictSeverity(v: Verdict): 'success' | 'warn' | 'danger' {
    return v === 'green' ? 'success' : v === 'yellow' ? 'warn' : 'danger';
  }
  ruleLabel(rule: string | null): string {
    switch (rule) {
      case 'min_shelf_life': return 'Vida útil por debajo del mínimo';
      case 'older_than_existing': return 'Más viejo que el inventario existente';
      case 'older_than_existing_allowed': return 'Más viejo que lo existente (permitido)';
      case 'near_min_shelf_life': return 'Cerca del mínimo de vida útil';
      default: return '';
    }
  }
}
