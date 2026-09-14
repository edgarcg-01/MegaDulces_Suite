import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * **Análisis BI** — el espacio de indicadores del proyecto Almacén.
 *
 * Este primer PR entrega la **puerta**: el item de sidebar, la ruta, el permiso
 * propio (`ALMACEN_BI_VER`) y su reparto en prod. Todavía **no publica ningún
 * indicador**, y eso se dice en pantalla en vez de pintar tarjetas en cero.
 *
 * **Por qué la pantalla arranca vacía y no con KPIs de relleno** (ADR-056): un
 * cero dibujado se lee igual que un cero medido, y acá no hay nada medido aún.
 * Cada indicador entra en su propio PR con su fuente declarada (de qué tabla
 * del ODS sale, con qué se cuadra y cuándo se midió), no al revés. La regla
 * principal del proyecto aplica igual acá: el dato sale del ODS, de una tabla
 * principal normalizada, verificada — nunca de un importer nuevo.
 *
 * Las superficies de análisis que **ya existen** y no hay que duplicar acá:
 * *Salud inv.* (`/almacen/inventory-health`), *Stock muerto*
 * (`/almacen/dead-stock`), *Exactitud IRA* (`/almacen/inventory/ira`) y el
 * *Diario de movimientos* (`/almacen/movimientos`). Lo que este módulo agrega
 * es la lectura **cruzada** de todas ellas; cuando un indicador de acá empiece
 * a repetir una de esas pantallas, gana la pantalla que ya está viva.
 */
@Component({
  selector: 'app-almacen-analisis-bi',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis BI</h1>
          <p class="surf-page-sub">
            Indicadores cruzados del almacén — el módulo está creado y todavía sin indicadores publicados
          </p>
        </div>
      </header>

      <div class="comm-empty abi-empty">
        <div class="comm-empty-icon"><i class="pi pi-chart-line" aria-hidden="true"></i></div>
        <h3>Sin indicadores publicados</h3>
        <p>
          El módulo ya existe y es accesible, pero no muestra cifras porque todavía no hay ninguna
          verificada. Un indicador se publica acá cuando declara de dónde sale y contra qué cuadra:
          una tarjeta en cero se leería como un cero real.
        </p>
        <p class="abi-next">
          Mientras tanto, el análisis del almacén vive en las pantallas que ya operan:
          <strong>Salud inv.</strong>, <strong>Stock muerto</strong>, <strong>Exactitud (IRA)</strong>
          y el <strong>Diario de movimientos</strong>.
        </p>
      </div>
    </div>
  `,
  styles: [
    `
      .abi-empty {
        max-width: 46rem;
        margin: 2rem auto 0;
        text-align: center;
      }
      .abi-empty p {
        color: var(--text-color-secondary);
        line-height: 1.55;
      }
      .abi-next {
        margin-top: 0.85rem;
        font-size: 0.86rem;
      }
    `,
  ],
})
export class AlmacenAnalisisBiComponent {}
