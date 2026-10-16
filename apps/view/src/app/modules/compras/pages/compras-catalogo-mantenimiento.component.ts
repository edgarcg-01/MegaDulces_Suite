import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { ComprasMantenimientoDiferenciasComponent } from './compras-mantenimiento-diferencias.component';
import { ComprasMantenimientoSinClasificarComponent } from './compras-mantenimiento-sin-clasificar.component';

type VistaMantenimiento = 'diferencias' | 'sin-clasificar';
const VISTAS: VistaMantenimiento[] = ['diferencias', 'sin-clasificar'];

const SUBTITULO: Record<VistaMantenimiento, string> = {
  diferencias: 'La ficha de venta de cada producto tiene que ser la misma en todas las sucursales. Aquí se ve qué sucursal se sale; se corrige en Kepler.',
  'sin-clasificar': 'Productos sin línea, tipo o grupo en ninguna sucursal. Sin clasificación no se pueden filtrar ni agrupar en la lista de precios; se asigna en Kepler.',
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
  imports: [PageTabsComponent, SegmentedComponent, ComprasMantenimientoDiferenciasComponent, ComprasMantenimientoSinClasificarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cm">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mantenimiento</h1>
          <p class="surf-page-sub">{{ subtitulo() }}</p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <app-segmented [options]="vistas" [value]="vista()" ariaLabel="Vistas de mantenimiento" (valueChange)="irA($any($event))" />

      @switch (vista()) {
        @case ('sin-clasificar') { <app-compras-mantenimiento-sin-clasificar /> }
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
  readonly tabs = CATALOGO_TABS;
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
  ];

  irA(vista: VistaMantenimiento): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: { vista: vista === 'diferencias' ? null : vista }, queryParamsHandling: 'merge' });
  }
}
