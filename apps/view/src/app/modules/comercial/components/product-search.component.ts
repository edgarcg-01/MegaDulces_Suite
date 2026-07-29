import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';

import { FormsModule } from '@angular/forms';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { ComercialService } from '../comercial.service';

export interface ProductHit { id: string; label: string; sku: string | null; brand: string | null; }

/**
 * Buscador inteligente de producto (typeahead). Filtra mientras se escribe contra
 * catalog.products (nombre o SKU) y muestra un menú de coincidencias. Al elegir una,
 * emite `productSelected` con el hit (o null al limpiar). Reutilizable en cualquier
 * pantalla Operations que quiera "mostrar un producto en específico".
 *
 * Data reactiva vía rxResource (Angular 22): el `query` signal dispara el fetch y la
 * Resource API cancela sola las peticiones viejas (mata las race conditions del typeahead).
 */
@Component({
  selector: 'app-product-search',
  standalone: true,
  imports: [FormsModule, AutoCompleteModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-autocomplete
      [(ngModel)]="selected"
      [suggestions]="suggestions()"
      (completeMethod)="search($event)"
      (onSelect)="onSelect($event)"
      (onClear)="onClear()"
      optionLabel="label"
      [delay]="250"
      [minQueryLength]="2"
      [showClear]="true"
      [placeholder]="placeholder"
      appendTo="body"
    >
      <ng-template let-p pTemplate="item">
        <div class="ps-item">
          <span class="ps-name">{{ p.label }}</span>
          <span class="ps-meta">
            @if (p.sku) { <code class="ps-sku">{{ p.sku }}</code> }
            @if (p.brand) { <span class="ps-brand">{{ p.brand }}</span> }
          </span>
        </div>
      </ng-template>
      <ng-template pTemplate="empty"><div class="ps-empty">Sin coincidencias</div></ng-template>
    </p-autocomplete>
  `,
  styles: [`
    :host { display: inline-block; }
    :host ::ng-deep .ps-ac, :host ::ng-deep .ps-ac .p-autocomplete-input { min-width: 280px; width: 100%; }
    .ps-item { display: flex; flex-direction: column; gap: .1rem; padding: .15rem 0; }
    .ps-name { font-size: var(--fs-sm, .85rem); color: var(--c-text-1); }
    .ps-meta { display: flex; gap: .5rem; align-items: center; }
    .ps-sku { font-family: var(--font-mono, monospace); font-size: var(--fs-xs, .72rem); color: var(--c-text-2); }
    .ps-brand { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .ps-empty { padding: .5rem .75rem; color: var(--c-text-2, var(--text-muted)); font-size: .85rem; }
  `],
})
export class ProductSearchComponent {
  @Input() placeholder = 'Buscar producto por nombre o SKU…';
  @Output() productSelected = new EventEmitter<ProductHit | null>();

  private readonly svc = inject(ComercialService);

  private readonly query = signal<string>('');
  selected: ProductHit | string | null = null;

  private readonly productsRes = rxResource({
    params: () => {
      const q = this.query();
      return q.length >= 2 ? q : undefined; // undefined => resource idle, sin fetch
    },
    stream: ({ params }) =>
      this.svc.listProducts({ search: params, pageSize: 12, active: true }).pipe(
        map((r) => (r.data || []).map((p): ProductHit => ({
          id: p.id, label: p.nombre, sku: p.sku, brand: p.brand_name ?? null,
        }))),
      ),
    defaultValue: [] as ProductHit[],
  });

  readonly suggestions = computed<ProductHit[]>(() => this.productsRes.value() ?? []);

  search(e: AutoCompleteCompleteEvent): void {
    this.query.set(e.query);
  }

  onSelect(e: AutoCompleteSelectEvent): void {
    this.productSelected.emit(e.value as ProductHit);
  }

  onClear(): void {
    this.selected = null;
    this.query.set('');
    this.productSelected.emit(null);
  }
}
