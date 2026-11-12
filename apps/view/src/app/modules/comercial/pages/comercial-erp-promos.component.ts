import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, ErpPromoRow } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PROMOS_TABS } from '../promos-tabs';

const fmt = (n: number) => n.toLocaleString('es-MX', { maximumFractionDigits: 2 });

/**
 * KV.6 — Promos vigentes del ERP Kepler (descuento/gratis por cantidad o monto), de TODAS las tiendas.
 *
 * `[MKT.7]` (2026-11-11): salía vacía con 328 reglas vigentes (leía sólo 8 Esquinas), pintaba el
 * porcentaje como pesos («$50 desc.» era 50 %) y el umbral sin su presentación. Ver
 * `libs/commercial/.../erp-promotions.ts`.
 *
 * ⚠️ Estas son las reglas de `kdpv_*` (descuento o regalo POR PRODUCTO). Las promociones que
 * Mercadotecnia lleva en su ranking semanal son otra cosa: códigos simbólicos «= GRATIS» de `kdii`
 * (ERP_KEPLER §2.9), que esta pestaña no muestra todavía.
 */
@Component({
  selector: 'app-comercial-erp-promos',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, TagModule, ToastModule, PageTabsComponent, SucursalPipe],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="promoTabs" variant="menu" ariaLabel="Secciones de Mercadotecnia" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Promos del ERP</h1>
          <p class="surf-page-sub">
            @if (failed()) {
              No se pudo leer Kepler: el conteo no está medido
            } @else if (loading()) {
              Leyendo Kepler…
            } @else {
              <b>{{ rows().length }}</b> regla{{ rows().length === 1 ? '' : 's' }} de descuento o regalo por producto, vigentes hoy en Kepler, todas las tiendas
            }
          </p>
        </div>
        <button pButton [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()" aria-label="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
      </header>

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50">
        <ng-template #header>
          <tr>
            <th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Tipo</th>
            <th scope="col" class="ep-num">Umbral</th><th scope="col">Beneficio</th>
            <th scope="col">Vigencia</th><th scope="col">Tienda</th>
          </tr>
        </ng-template>
        <ng-template #body let-p>
          <tr>
            <td class="ep-mono">{{ p.sku }}</td>
            <td class="ep-name">{{ p.product_name }}</td>
            <td><p-tag [value]="typeLabel(p.promo_type)" [severity]="p.promo_type.startsWith('gratis') ? 'success' : 'info'"></p-tag></td>
            <td class="ep-num">{{ thresholdLabel(p) }}</td>
            <td>{{ benefitLabel(p) }}</td>
            <td>{{ (p.valid_from | date:'dd/MM/yy') }} → {{ validToLabel(p) }}</td>
            <td>{{ (p.warehouse_code | sucursal) || '—' }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="7" class="comm-empty-cell">
            <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-percentage" aria-hidden="true"></i></div>
              @if (failed()) {
                <h3>No se pudo leer Kepler</h3><p>La consulta falló, así que no se sabe si hay o no. Intenta con el botón de refrescar.</p>
              } @else {
                <h3>Sin reglas vigentes</h3><p>Hoy ninguna tienda tiene en Kepler un descuento o regalo por producto vigente.</p>
              }</div>
          </td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .ep-mono { font-family: var(--font-mono,monospace); }
    .ep-name { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ep-num { text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialErpPromosComponent {
  readonly promoTabs = PROMOS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);

  // Resource API: carga declarativa (auto-cancela, loading/error derivados). reload() = refrescar.
  private readonly promosRes = rxResource({ stream: () => this.svc.erpPromotions() });
  // [MKT.7] `value()` LANZA si el recurso está en error (Angular 22): leerlo sin `hasValue()` tumbaba
  // la plantilla justo cuando había que decir «no se pudo leer». Lo cazó mkt-promos-vacio.spec.
  readonly rows = computed<ErpPromoRow[]>(() => (this.promosRes.hasValue() ? this.promosRes.value() : []));
  readonly loading = computed(() => this.promosRes.isLoading());
  /** Un error NO es una lista vacía: se dice distinto (ADR-056). */
  readonly failed = computed(() => !!this.promosRes.error());

  constructor() {
    effect(() => { if (this.promosRes.error()) this.toast.add({ severity: 'error', summary: 'Error al cargar promos' }); });
  }

  typeLabel(t: string): string {
    return ({
      descuento_qty: 'Descuento x cantidad',
      gratis_qty: 'Gratis x cantidad',
      descuento_monto: 'Descuento x monto',
      gratis_monto: 'Gratis x monto',
    } as Record<string, string>)[t] || t;
  }

  /** El beneficio con su unidad. Un descuento de Kepler es PORCENTAJE (c6, verificado 113 vs 2). */
  benefitLabel(p: ErpPromoRow): string {
    if (p.benefit === null || p.benefit === undefined) return 'Sin dato';
    if (p.benefit_kind === 'free_qty') {
      const unidad = p.free_unit ? ` ${p.free_unit}` : '';
      return `Gratis ${fmt(p.benefit)}${unidad} de ${p.free_product_name || 'producto sin nombre'}`;
    }
    return `${fmt(p.benefit)} % de descuento`;
  }

  /** El umbral en SU presentación («1 PAQ»). El de monto no tiene unidad verificada: se dice. */
  thresholdLabel(p: ErpPromoRow): string {
    if (p.threshold === null || p.threshold === undefined) return 'Sin dato';
    if (p.promo_type.endsWith('monto')) return `${fmt(p.threshold)} (unidad sin verificar)`;
    return `${fmt(p.threshold)} ${p.unit || 'u'}`;
  }

  /** Kepler usa años como 2106 para «sin fecha de fin». */
  validToLabel(p: ErpPromoRow): string {
    if (!p.valid_to) return 'Sin fecha';
    if (p.valid_to >= '2100') return 'Sin fin';
    const [y, m, d] = p.valid_to.slice(0, 10).split('-');
    return `${d}/${m}/${y.slice(2)}`;
  }

  load() { this.promosRes.reload(); }
}
