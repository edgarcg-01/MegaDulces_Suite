import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { ComprasCostosHistorialComponent } from './compras-costos-historial.component';
import { ComprasCostosUltimoComponent } from './compras-costos-ultimo.component';
import { ComprasCostosMatrizComponent } from './compras-costos-matriz.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';

/**
 * Las vistas de Costos. `estandar` es la de entrada (y la que antes se llamaba «Entre sucursales»:
 * la matriz del costo estándar ES esa comparación, ahora con el CEDIS y con la historia por día).
 */
type VistaCostos = 'estandar' | 'promedio' | 'ultimo' | 'contra' | 'historial';
const VISTAS: VistaCostos[] = ['estandar', 'promedio', 'ultimo', 'contra', 'historial'];

const SUBTITULO: Record<VistaCostos, string> = {
  estandar: 'El costo estándar de la ficha de Kepler en cada almacén, día por día. Tiene que ser el mismo en todos; se corrige en Kepler.',
  promedio: 'El costo promedio que Kepler le puso a las salidas de cada almacén, día por día. Es contra el que Kepler mide la utilidad.',
  ultimo: 'El costo de la última compra (XA2001) que tenía cada almacén, día por día.',
  contra: 'El costo estándar de cada sucursal contra lo que costó su última compra. Se corrige en Kepler.',
  historial: 'Cómo fue cambiando el costo estándar negociado y el costo de entrada de un producto, sucursal por sucursal.',
};

/**
 * `[CAT-COSTO.4]`–`[CAT-COSTO.10]` — **Compras › Catálogo › Costos.**
 *
 * Este componente sólo es el contenedor: encabezado, pestañas del catálogo y el selector de vistas.
 * Cada vista vive en su propio componente con su propia prueba:
 *  · Costo estándar · Costo promedio · Último costo → `app-compras-costos-matriz` (`[CAT-COSTO.10]`)
 *  · Contra último costo → `app-compras-costos-ultimo` (`[CAT-COSTO.7]`)
 *  · Historial por producto → `app-compras-costos-historial` (`[CAT-COSTO.5]`)
 *
 * La vista y el producto viven en la URL (`?vista=…&sku=…`): se pueden compartir y el botón Atrás funciona.
 */
@Component({
  selector: 'app-compras-catalogo-costos',
  standalone: true,
  imports: [CommonModule, PageTabsComponent, SegmentedComponent, ComprasCostosMatrizComponent, ComprasCostosUltimoComponent, ComprasCostosHistorialComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cc">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costos</h1>
          <p class="surf-page-sub">{{ subtitulo() }}</p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <app-segmented [options]="vistas" [value]="vista()" ariaLabel="Vistas de costos" (valueChange)="irA($any($event))" />

      @switch (vista()) {
        @case ('historial') {
          <app-compras-costos-historial [sku]="skuHistorial()" (skuElegido)="abrirHistorial($event)" />
        }
        @case ('contra') {
          <app-compras-costos-ultimo (skuElegido)="abrirHistorial($event)" />
        }
        @case ('promedio') {
          <app-compras-costos-matriz tipo="promedio" (skuElegido)="abrirHistorial($event)" />
        }
        @case ('ultimo') {
          <app-compras-costos-matriz tipo="ultimo" (skuElegido)="abrirHistorial($event)" />
        }
        @default {
          <app-compras-costos-matriz tipo="estandar" (skuElegido)="abrirHistorial($event)" />
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cc { display: flex; flex-direction: column; gap: 1rem; }
  `],
})
export class ComprasCatalogoCostosComponent {
  readonly tabs = CATALOGO_TABS;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly query = toSignal(this.route.queryParamMap);
  readonly vista = computed<VistaCostos>(() => {
    const v = this.query()?.get('vista') as VistaCostos | null;
    return v && VISTAS.includes(v) ? v : 'estandar';
  });
  readonly skuHistorial = computed(() => this.query()?.get('sku') || null);
  readonly subtitulo = computed(() => SUBTITULO[this.vista()]);
  readonly vistas: SegOption[] = [
    { label: 'Costo estándar', value: 'estandar' },
    { label: 'Costo promedio', value: 'promedio' },
    { label: 'Último costo', value: 'ultimo' },
    { label: 'Contra último costo', value: 'contra' },
    { label: 'Historial por producto', value: 'historial' },
  ];

  irA(vista: VistaCostos): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { vista: vista === 'estandar' ? null : vista }, queryParamsHandling: 'merge' });
  }

  abrirHistorial(sku: string): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { vista: 'historial', sku }, queryParamsHandling: 'merge' });
  }
}
