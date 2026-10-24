import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageTabsComponent } from '../../shared/components/page-tabs/page-tabs.component';
import { PAGOS_VIAJE_TABS } from './pagos-viaje-tabs';

/**
 * `[EMB.43]` — **Shell de Logística › Pagos de viaje.** Pinta el encabezado del módulo y la barra
 * de pestañas UNA vez para las tres pantallas (Operaciones · Por persona · Tarifas). Es el
 * patrón de Gastos y Almacén: un padre con hijos, y cada hijo conserva su permiso.
 */
@Component({
  selector: 'app-pagos-viaje-area-shell',
  standalone: true,
  imports: [RouterOutlet, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pv-shell">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pagos de viaje</h1>
          <p class="surf-page-sub">Cuánto le toca a cada quien de cada operación —comisión, viático y carga por caja— y el reporte para pedir el gasto en Kepler. La operación y sus cajas salen de Kepler; aquí sólo se agrega quién fue.</p>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de pagos de viaje" />
    </div>
    <router-outlet />
  `,
  styles: [
    `
      /* El host es un elemento extra entre el <main> del layout y la página: sin display:block
         quedaría inline y arruinaría el ancho. */
      :host { display: block; width: 100%; }
      .pv-shell { padding-bottom: 0; }
    `,
  ],
})
export class PagosViajeAreaShellComponent {
  readonly tabs = [...PAGOS_VIAJE_TABS];
}
