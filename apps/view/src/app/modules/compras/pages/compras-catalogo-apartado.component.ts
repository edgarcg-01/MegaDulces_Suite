import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CATALOGO_TABS } from '../catalogo-tabs';

type CatalogoApartado =
  | 'resumen'
  | 'solicitudes'
  | 'incidencias'
  | 'costos'
  | 'listas-precios';

interface ApartadoConfig {
  title: string;
  description: string;
  icon: string;
  next: string[];
  link?: { label: string; route: string };
}

const APARTADOS: Record<CatalogoApartado, ApartadoConfig> = {
  resumen: {
    title: 'Centro de control del catálogo',
    description:
      'Aquí reuniremos la salud del catálogo y el trabajo pendiente del equipo de Compras.',
    icon: 'pi pi-chart-bar',
    next: [
      'Indicadores de integridad de las fichas',
      'Alertas de precio, código y unidad',
      'Carga de trabajo y vencimientos',
    ],
    link: { label: 'Consultar productos', route: '/compras/catalogo' },
  },
  solicitudes: {
    title: 'Altas y modificaciones',
    description:
      'Este apartado concentrará las solicitudes antes de que un cambio se capture y valide en el ERP.',
    icon: 'pi pi-file-edit',
    next: [
      'Alta de producto y cambios de ficha',
      'Responsable, prioridad y fecha compromiso',
      'Historial de revisión y liberación',
    ],
  },
  incidencias: {
    title: 'Incidencias de catálogo',
    description:
      'Aquí se atenderán los errores que afectan la compra, recepción, exhibición o venta.',
    icon: 'pi pi-exclamation-triangle',
    next: [
      'Bandeja unificada de errores detectados',
      'Prioridad, responsable y tiempo abierto',
      'Resolución con causa y evidencia',
    ],
    link: {
      label: 'Revisar códigos repetidos',
      route: '/compras/catalogo/codigos',
    },
  },
  costos: {
    title: 'Costos',
    description:
      'Este espacio reunirá el costo de cada producto, sus cambios y su historial sin reemplazar a Kepler como fuente de verdad.',
    icon: 'pi pi-wallet',
    next: [
      'Costo anterior, costo propuesto y variación',
      'Impacto en margen y fecha de vigencia',
      'Validación del cambio observado en el ERP',
    ],
    // Sin enlace: Precios ya es su propio tab, y la pantalla de costo estándar
    // (/compras/costo-estandar) pide otro permiso, así que un enlace ahí rebotaría a quien sólo
    // tiene el del catálogo.
  },
  'listas-precios': {
    title: 'Listas de precios de proveedores',
    description:
      'Aquí vivirán las listas recibidas de cada proveedor, con su vigencia, documento fuente y estado de revisión.',
    icon: 'pi pi-list',
    next: [
      'Archivo original, proveedor y fecha de recepción',
      'Vigencia, versión y responsable de revisión',
      'Comparación contra el catálogo y cambios detectados',
    ],
    link: {
      label: 'Consultar proveedores',
      route: '/compras/proveedores',
    },
  },
};

@Component({
  selector: 'app-compras-catalogo-apartado',
  standalone: true,
  imports: [RouterLink, ButtonModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="surf-page ca-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>{{ config.title }}</h1>
          <p class="surf-page-sub">{{ config.description }}</p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <section class="ca-stage" aria-labelledby="catalogo-apartado-title">
        <div class="ca-mark" aria-hidden="true">
          <i [class]="config.icon"></i>
        </div>
        <div class="ca-copy">
          <p class="ca-kicker">Estructura preparada</p>
          <h2 id="catalogo-apartado-title">Contenido por desarrollar</h2>
          <p>
            El apartado ya tiene una ruta propia y forma parte de la navegación
            del Centro de catálogo. En el siguiente paso conectaremos sus datos,
            reglas y acciones.
          </p>

          <div class="ca-scope" aria-label="Alcance previsto">
            <span>Alcance previsto</span>
            <ul>
              @for (item of config.next; track item) {
                <li>
                  <i class="pi pi-check" aria-hidden="true"></i>{{ item }}
                </li>
              }
            </ul>
          </div>

          @if (config.link; as link) {
            <a
              pButton
              [outlined]="true"
              severity="secondary"
              size="small"
              [routerLink]="link.route"
            >
              <span class="p-button-label">{{ link.label }}</span>
              <span
                class="p-button-icon p-button-icon-right pi pi-arrow-right"
                aria-hidden="true"
              ></span>
            </a>
          }
        </div>
      </section>
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .ca-page {
        max-width: 1320px;
      }
      .ca-stage {
        display: grid;
        grid-template-columns: 72px minmax(0, 620px);
        gap: 1.25rem;
        align-items: start;
        padding: 2.25rem 0 3rem;
        border-top: 1px solid var(--c-divider);
      }
      .ca-mark {
        width: 64px;
        height: 64px;
        display: grid;
        place-items: center;
        border-radius: 12px;
        color: var(--action);
        background: var(--c-surface-2);
        font-size: 1.35rem;
      }
      .ca-copy {
        min-width: 0;
      }
      .ca-kicker {
        margin: 0 0 0.3rem;
        color: var(--action);
        font-size: var(--fs-xs);
        font-weight: var(--fw-bold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .ca-copy h2 {
        margin: 0;
        color: var(--c-text-1);
        font-size: clamp(1.3rem, 2vw, 1.7rem);
        letter-spacing: -0.02em;
      }
      .ca-copy > p:not(.ca-kicker) {
        max-width: 60ch;
        margin: 0.55rem 0 1.5rem;
        color: var(--c-text-2);
        line-height: 1.6;
      }
      .ca-scope {
        margin-bottom: 1.5rem;
        padding-left: 1rem;
        border-left: 2px solid var(--c-divider);
      }
      .ca-scope > span {
        color: var(--c-text-3);
        font-size: var(--fs-xs);
        font-weight: var(--fw-medium);
      }
      .ca-scope ul {
        display: grid;
        gap: 0.55rem;
        margin: 0.7rem 0 0;
        padding: 0;
        list-style: none;
      }
      .ca-scope li {
        display: flex;
        gap: 0.55rem;
        align-items: baseline;
        color: var(--c-text-2);
        font-size: var(--fs-sm);
      }
      .ca-scope li i {
        color: var(--c-text-3);
        font-size: 0.7rem;
      }
      @media (max-width: 40rem) {
        .ca-stage {
          grid-template-columns: 1fr;
          padding-top: 1.5rem;
        }
        .ca-mark {
          width: 48px;
          height: 48px;
          border-radius: 10px;
        }
      }
    `,
  ],
})
export class ComprasCatalogoApartadoComponent {
  readonly tabs = CATALOGO_TABS;

  private readonly route = inject(ActivatedRoute);
  private readonly apartado = this.route.snapshot.data[
    'catalogoApartado'
  ] as CatalogoApartado;
  readonly config = APARTADOS[this.apartado] ?? APARTADOS.resumen;
}
