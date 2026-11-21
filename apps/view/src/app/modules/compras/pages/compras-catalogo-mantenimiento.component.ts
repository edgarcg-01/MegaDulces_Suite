import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { CatalogoMenuComponent } from './catalogo-menu.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ComprasMantenimientoDiferenciasComponent } from './compras-mantenimiento-diferencias.component';
import { ComprasMantenimientoSinClasificarComponent } from './compras-mantenimiento-sin-clasificar.component';
import { ComprasMantenimientoEnCerosComponent } from './compras-mantenimiento-en-ceros.component';

type VistaMantenimiento = 'diferencias' | 'sin-clasificar' | 'en-ceros';
const VISTAS: VistaMantenimiento[] = ['diferencias', 'sin-clasificar', 'en-ceros'];

const SUBTITULO: Record<VistaMantenimiento, string> = {
  diferencias: 'La ficha de venta de cada producto tiene que ser la misma en todas las sucursales. Aquí se ve qué sucursal se sale; se corrige en Kepler.',
  'sin-clasificar': 'Productos sin línea, tipo o grupo en ninguna sucursal. Sin clasificación no se pueden filtrar ni agrupar en la lista de precios; se asigna en Kepler.',
  // [CAT-PRECIO.6] Edgar, 2026-11-20: «productos que tengan 0 en su costo o precio».
  'en-ceros': 'Productos con costo o precio de venta en cero en la ficha de alguna sucursal. Un precio en cero se vende regalado y un costo en cero rompe el margen; se corrige en Kepler.',
};

/**
 * `[CAT-PRECIO.1]`/`[CAT-PRECIO.5]` — **Compras › Catálogo › Mantenimiento.**
 *
 * Todo lo que le falta o está mal a la ficha de Kepler, en un solo lugar. Contenedor como Costos:
 * encabezado, pestañas del catálogo y el selector de vistas; cada vista con su componente. La vista
 * vive en la URL (`?vista=…`): se comparte y el botón Atrás funciona.
 */
@Component({
  selector: 'app-compras-catalogo-mantenimiento',
  standalone: true,
  imports: [CatalogoMenuComponent, SegmentedComponent, ComprasMantenimientoDiferenciasComponent, ComprasMantenimientoSinClasificarComponent, ComprasMantenimientoEnCerosComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cm">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mantenimiento</h1>
          <p class="surf-page-sub">{{ subtitulo() }}</p>
        </div>
      </header>

      <app-catalogo-menu />

      <app-segmented [options]="vistas" [value]="vista()" ariaLabel="Vistas de mantenimiento" (valueChange)="irA($any($event))" />

      @switch (vista()) {
        @case ('sin-clasificar') { <app-compras-mantenimiento-sin-clasificar /> }
        @case ('en-ceros') { <app-compras-mantenimiento-en-ceros /> }
        @default { <app-compras-mantenimiento-diferencias /> }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cm { display: flex; flex-direction: column; gap: 1rem; }
  `],
})
export class ComprasCatalogoMantenimientoComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly query = toSignal(this.route.queryParamMap);
  readonly vista = computed<VistaMantenimiento>(() => {
    const v = this.query()?.get('vista') as VistaMantenimiento | null;
    return v && VISTAS.includes(v) ? v : 'diferencias';
  });
  readonly subtitulo = computed(() => SUBTITULO[this.vista()]);
  readonly vistas: SegOption[] = [
    { label: 'Diferencias entre sucursales', value: 'diferencias' },
    { label: 'Sin clasificar', value: 'sin-clasificar' },
    { label: 'Costo o precio en cero', value: 'en-ceros' },
  ];

  irA(vista: VistaMantenimiento): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { vista: vista === 'diferencias' ? null : vista }, queryParamsHandling: 'merge' });
  }
}
