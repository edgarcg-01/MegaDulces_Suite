import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { AlmacenBiService, BiMovementDetail } from '../almacen-bi.service';
import { money } from '../../../shared/util/money.util';

/**
 * WMS-BI.1 — Detalle de un documento del Diario de Movimientos, abierto en pestaña nueva
 * desde Análisis BI (`openDocument()`). Ruta PROPIA (no `/almacen/movimientos`) a propósito:
 * ver el comentario en `AlmacenAnalisisBiComponent.openDocument()` y en el service backend —
 * mismo permiso `ALMACEN_BI_VER`, con verificación de alcance y redacción de destino ahí,
 * no acá. Pantalla de FOCO: sin barra de tabs, cuelga fuera del shell de áreas.
 */
@Component({
  selector: 'app-almacen-bi-documento',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in abd-page">
      @if (loading()) {
        <div class="abd-state">Cargando documento…</div>
      } @else if (error()) {
        <div class="abd-state abd-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}</div>
      } @else if (doc(); as d) {
        @if (!d.header) {
          <div class="abd-state">No se encontró el documento.</div>
        } @else {
          <header class="abd-head">
            <h1>{{ d.header['movement_label'] }} <span class="abd-folio">#{{ d.header['folio'] }}</span></h1>
            <div class="abd-head-grid">
              <div><span class="abd-l">Almacén</span><span class="abd-v">{{ d.header['warehouse_name'] || d.header['warehouse_code'] }}</span></div>
              <div><span class="abd-l">Fecha</span><span class="abd-v">{{ d.header['doc_date'] }}</span></div>
              <div><span class="abd-l">Tipo</span><span class="abd-v abd-mono">{{ d.header['doc_code'] }}</span></div>
              @if (d.header['dest_label']) {
                <div><span class="abd-l">Destino</span><span class="abd-v">{{ d.header['dest_label'] }}
                  @if (d.dest_redacted) { <i class="pi pi-lock abd-lock" title="Oculto: no tenés permiso para ver clientes" aria-hidden="true"></i> }
                </span></div>
              }
            </div>
          </header>

          <p-table [value]="d.lines" styleClass="p-datatable-sm surf-table">
            <ng-template #header>
              <tr><th scope="col">Código</th><th scope="col">Producto</th><th scope="col" class="num">Cantidad</th>
                <th scope="col" class="num">Costo unitario</th><th scope="col" class="num">Importe</th></tr>
            </ng-template>
            <ng-template #body let-l>
              <tr>
                <td class="abd-mono">{{ l.sku }}</td>
                <td>{{ l.product_name }}</td>
                <td class="num">{{ l.qty | number:'1.0-3' }}</td>
                <td class="num">{{ l.unit_cost != null ? money(l.unit_cost) : 'No disponible' }}</td>
                <td class="num">{{ l.amount != null ? money(l.amount) : 'No disponible' }}</td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr class="abd-totals"><td colspan="2">Total</td><td class="num">{{ d.totals.qty | number:'1.0-3' }}</td><td></td>
                <td class="num">{{ money(d.totals.amount) }}</td></tr>
            </ng-template>
          </p-table>

          @if (counterpart(); as cp) {
            <div class="abd-cp">
              <h3>Contraparte del traspaso</h3>
              <p-tag [value]="cpLabel(cp.status)" [severity]="cpSeverity(cp.status)"></p-tag>
              @for (doc of cp.docs; track doc.folio) {
                <div class="abd-cp-doc">{{ doc.warehouse_name || doc.warehouse_code }} · folio {{ doc.folio }} · {{ doc.qty | number:'1.0-3' }}</div>
              }
            </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    .abd-page { max-width: 52rem; margin: 0 auto; }
    .abd-state { padding: 3rem; text-align: center; color: var(--text-color-secondary); }
    .abd-error { color: var(--bad-fg, #b91c1c); }
    .abd-head h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
    .abd-folio { font-family: var(--font-mono, monospace); font-weight: 400; color: var(--text-color-secondary); }
    .abd-head-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .5rem; margin-bottom: 1rem; }
    .abd-l { display: block; font-size: .7rem; text-transform: uppercase; color: var(--text-color-secondary); }
    .abd-v { font-size: .9rem; }
    .abd-mono { font-family: var(--font-mono, monospace); font-size: .82rem; }
    .abd-lock { margin-left: .3rem; color: var(--text-color-secondary); }
    .abd-totals td { font-weight: 700; }
    .abd-cp { margin-top: 1.25rem; }
    .abd-cp h3 { font-size: .85rem; margin: 0 0 .4rem; }
    .abd-cp-doc { font-size: .82rem; padding: .2rem 0; }
  `],
})
export class AlmacenBiDocumentoComponent {
  private readonly bi = inject(AlmacenBiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  readonly money = money;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly doc = signal<BiMovementDetail | null>(null);
  /**
   * `counterpart` llega como `Record<string, unknown>` (mismo contrato laxo del backend, que
   * sólo tipa fuerte lo que redacta). Acá se le da forma concreta una sola vez para el template.
   */
  readonly counterpart = computed(() => {
    const cp = this.doc()?.counterpart as {
      status: string;
      docs: Array<{ folio: string; warehouse_code: string | null; warehouse_name: string | null; qty: number }>;
    } | null | undefined;
    return cp ?? null;
  });

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    const warehouseId = q.get('warehouse_id');
    const folio = q.get('folio');
    if (!warehouseId || !folio) { this.loading.set(false); this.error.set('Faltan parámetros (warehouse_id, folio).'); return; }
    this.bi.movementDetail(warehouseId, folio, q.get('doc_code') || undefined, q.get('doc_serie') || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.doc.set(d); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.error.set(e?.error?.message || 'No se pudo cargar el documento.'); },
      });
  }

  cpLabel(status: string): string {
    return status === 'ok' ? 'Cuadra' : status === 'diferencia' ? 'Con diferencia' : status === 'sin_recepcion' ? 'Sin recepción' : 'Sin origen';
  }
  cpSeverity(status: string): 'success' | 'warn' | 'danger' | 'info' {
    return status === 'ok' ? 'success' : status === 'diferencia' ? 'warn' : 'danger';
  }
}
