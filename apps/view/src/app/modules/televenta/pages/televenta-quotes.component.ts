import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageService } from 'primeng/api';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { QuotesService, QuoteListRow, QuoteStatus, QuotesSummary } from '../quotes.service';

/**
 * `[E.12.0]` — Mesa de cotizaciones de mayoreo.
 *
 * Esta pantalla es el CIMIENTO del submódulo: la lista de lo que se cotizó, con lo que hace
 * falta para decidir a cuál entrar. El editor de renglones, el envío al cliente, el PDF y la
 * conversión a pedido son E.12.1-E.12.4 y todavía NO existen — la pantalla lo DICE en vez de
 * insinuar que están, porque un botón que no hace nada se lee igual que uno roto.
 *
 * Superficie Operations (DESIGN.md): tabla densa, sin Fraunces, sin ilustraciones.
 */

const STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  expired: 'Vencida',
  cancelled: 'Cancelada',
};

const STATUS_SEVERITY: Record<QuoteStatus, 'success' | 'info' | 'warn' | 'danger' | 'secondary'> = {
  draft: 'secondary',
  sent: 'info',
  accepted: 'success',
  rejected: 'danger',
  expired: 'warn',
  cancelled: 'secondary',
};

const ORIGIN_LABEL: Record<string, string> = {
  telemarketing: 'Lista del cliente',
  route_visit: 'Visita de ruta',
  counter: 'Mostrador',
  portal: 'Portal',
};

/** Los filtros de la tira superior. 'abiertas' es el default: es el trabajo vivo. */
const FILTERS: Array<{ key: string; label: string; status: string }> = [
  { key: 'abiertas', label: 'Abiertas', status: 'draft,sent' },
  { key: 'aceptadas', label: 'Aceptadas', status: 'accepted' },
  { key: 'perdidas', label: 'Perdidas', status: 'rejected,expired' },
  { key: 'todas', label: 'Todas', status: '' },
];

@Component({
  selector: 'app-televenta-quotes',
  standalone: true,
  imports: [ToastModule, 
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    TableModule,
    TagModule,
    ProgressSpinnerModule,
  ],
  /**
   * [E.13] Provee su PROPIO MessageService y pinta su PROPIO p-toast. Antes los heredaba del
   * shell de Telemarketing; al montar el layout comun (que no provee ninguno de los dos, medido)
   * la pagina tiraria NullInjectorError al abrirse. Es el patron de las otras 105 paginas.
   */
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast position="top-center"></p-toast>
    <section class="section">
      <header class="section-header">
        <div class="head-row">
          <h1>Cotizaciones de mayoreo</h1>
          <!-- El botón sólo existe con la llave de GESTIONAR: cotizar es ofrecer precio. Quien
               sólo tiene lectura ve la mesa y no un botón que le va a rebotar el guard. -->
          @if (puedeGestionar()) {
            <button pButton routerLink="/telemarketing/cotizaciones/nueva">
              <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
              <span class="p-button-label">Nueva cotización</span>
            </button>
          }
        </div>
        <p>
          La oferta de precio que todavía no es venta. Entra acá la lista que manda el cliente y la
          venta que se levanta en la visita de ruta. Una cotización <strong>no aparta inventario</strong>:
          eso pasa recién cuando se convierte en pedido.
        </p>
      </header>

      <!-- Qué hace este submódulo y qué todavía NO hace. Se declara arriba y una sola vez: un
           módulo a medias que no lo dice se lee como un módulo roto. -->
      <div class="scope-note" role="note">
        <i class="pi pi-info-circle" aria-hidden="true"></i>
        <div>
          <p class="scope-title">Qué hace hoy</p>
          <p>
            Registra la cotización con su folio, su destinatario y su vigencia, y lleva la cuenta de
            en qué quedó. <strong>Todavía no</strong>: cargar renglones, enviar al cliente, imprimir
            el PDF ni convertirla en pedido.
          </p>
        </div>
      </div>

      @if (loading()) {
        <div class="loading" aria-live="polite">
          <p-progressspinner styleClass="w-12 h-12"></p-progressspinner>
        </div>
      }

      @if (!loading()) {
        @if (summary(); as s) {
          <div class="kpis">
            <article class="kpi">
              <span class="kpi-label">Abiertas</span>
              <span class="kpi-value">{{ s.open_count }}</span>
              <span class="kpi-foot">{{ s.open_amount | currency:'MXN':'symbol-narrow':'1.0-0' }} cotizados</span>
            </article>
            <article class="kpi" [class.kpi-warn]="s.expiring_soon_count > 0">
              <span class="kpi-label">Vencen en 3 días</span>
              <span class="kpi-value">{{ s.expiring_soon_count }}</span>
              <span class="kpi-foot">Hay que cerrarlas o renovarlas</span>
            </article>
            <article class="kpi" [class.kpi-danger]="s.overdue_count > 0">
              <span class="kpi-label">Vencidas sin cerrar</span>
              <span class="kpi-value">{{ s.overdue_count }}</span>
              <span class="kpi-foot">Siguen abiertas con la vigencia pasada</span>
            </article>
            <article class="kpi">
              <span class="kpi-label">Aceptadas</span>
              <span class="kpi-value">{{ s.by_status.accepted }}</span>
              <span class="kpi-foot">De {{ totalQuotes(s) }} en total</span>
            </article>
          </div>
        }

        <div class="toolbar">
          <div class="chips" role="group" aria-label="Filtrar cotizaciones">
            @for (f of filters; track f.key) {
              <button
                type="button"
                class="chip"
                [class.chip-active]="activeFilter() === f.key"
                (click)="setFilter(f.key)"
              >{{ f.label }}</button>
            }
          </div>
          <input
            type="search"
            [(ngModel)]="searchTerm"
            (keyup.enter)="reload()"
            placeholder="Folio, cliente o contacto..."
            class="search"
            aria-label="Buscar cotización"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
          />
          <button
            pButton
            severity="secondary"
            [outlined]="true"
            size="small"
            (click)="reload()"
          ><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>

        <div class="table-card">
          @if (rows().length === 0) {
            <div class="empty">
              <p class="empty-title">No hay cotizaciones en este filtro.</p>
              <p class="empty-hint">
                Arranca una con el boton Nueva cotizacion: se elige el cliente de mayoreo y la
                sucursal con cuyas condiciones se cotiza.
              </p>
            </div>
          } @else {
            <!-- ⚠️ SIN scrollHeight="flex": PrimeNG lo resuelve contra un padre flex de altura
                 definida, y dentro de un contenedor de bloque normal el cuerpo colapsa a 0 px.
                 Medido en el navegador: la tabla existía en el DOM, el pie decía "Mostrando 1 de 1"
                 y no se pintaba UNA sola fila. El scroll horizontal lo da el contenedor. -->
            <p-table
              [value]="rows()"
              styleClass="p-datatable-sm"
              [tableStyle]="{ 'min-width': '60rem' }"
            >
              <ng-template #header>
                <tr>
                  <th>Folio</th>
                  <th>Cliente</th>
                  <th>Origen</th>
                  <th>Estado</th>
                  <th>Vigencia</th>
                  <th class="num">Renglones</th>
                  <th class="num">Total</th>
                  <th>Cotizó</th>
                </tr>
              </ng-template>
              <ng-template #body let-q>
                <!-- [COT.1b] La fila abre el detalle. Hasta ahora la mesa era un callejón sin
                     salida: se creaba una cotización y no se podía volver a abrir. -->
                <tr class="fila" [routerLink]="['/telemarketing/cotizaciones', q.id]" tabindex="0"
                    (keydown.enter)="abrir(q.id)" (keydown.space)="abrir(q.id)"
                    [attr.aria-label]="'Abrir la cotización ' + q.code">
                  <td class="mono">
                    {{ q.code }}
                    @if (q.order_code) {
                      <span class="lineage" [title]="'Convertida en el pedido ' + q.order_code">
                        → {{ q.order_code }}
                      </span>
                    }
                  </td>
                  <td>
                    <span class="recipient">{{ q.recipient_name }}</span>
                    @if (q.customer_code) {
                      <span class="cust-code">{{ q.customer_code }}</span>
                    } @else {
                      <!-- Sin cliente registrado: la cotización nació antes que el alta. -->
                      <span class="cust-code prospect">Prospecto</span>
                    }
                  </td>
                  <td>{{ originLabel(q.origin) }}</td>
                  <td>
                    <p-tag [value]="statusLabel(q.status)" [severity]="statusSeverity(q.status)"></p-tag>
                  </td>
                  <td>
                    <span [class.overdue]="isOverdue(q)">{{ q.valid_until }}</span>
                    <span class="days">{{ expiryHint(q) }}</span>
                  </td>
                  <td class="num">
                    {{ q.line_count }}
                    @if (q.unmatched_count > 0) {
                      <!-- Lo que el cliente pidió y no casó con el catálogo. Es demanda que
                           estamos rechazando, no un error de captura. -->
                      <span class="unmatched" [title]="q.unmatched_count + ' renglones sin producto del catálogo'">
                        {{ q.unmatched_count }} sin casar
                      </span>
                    }
                  </td>
                  <td class="num">{{ q.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="muted">{{ q.created_by_username || '—' }}</td>
                </tr>
              </ng-template>
            </p-table>
            <p class="table-foot">
              Mostrando {{ rows().length }} de {{ total() }}.
            </p>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .section { padding: 1.25rem; max-width: 1400px; margin: 0 auto; }
      .head-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
      .section-header h1 { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.25rem; }
      .section-header p { color: var(--text-color-secondary); font-size: 0.875rem; margin: 0; max-width: 72ch; }

      .scope-note {
        display: flex; gap: 0.75rem; align-items: flex-start;
        margin: 1rem 0; padding: 0.75rem 1rem;
        border: 1px solid var(--border-color); border-left-width: 3px;
        border-radius: 8px; background: var(--card-bg);
        font-size: 0.8125rem; color: var(--text-color-secondary);
      }
      .scope-note i { color: var(--primary-color, var(--action)); margin-top: 0.1rem; }
      .scope-note p { margin: 0; }
      .scope-title { font-weight: 600; color: var(--text-color); margin-bottom: 0.15rem; }

      .loading { display: flex; justify-content: center; padding: 3rem 0; }

      .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
      .kpi {
        background: var(--card-bg); border: 1px solid var(--border-color);
        border-radius: 8px; padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.15rem;
      }
      .kpi-label { font-size: 0.75rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
      .kpi-value { font-size: 1.5rem; font-weight: 700; line-height: 1.1; }
      .kpi-foot { font-size: 0.75rem; color: var(--text-color-secondary); }
      .kpi-warn .kpi-value { color: var(--yellow-600, #b45309); }
      .kpi-danger .kpi-value { color: var(--red-600, #b91c1c); }

      .toolbar { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem; }
      .chips { display: flex; gap: 0.35rem; }
      .chip {
        border: 1px solid var(--border-color); background: var(--card-bg);
        border-radius: 9999px; padding: 0.35rem 0.85rem; font-size: 0.8125rem;
        cursor: pointer; color: var(--text-color-secondary); min-height: 32px;
      }
      .chip:hover { background: var(--neutral-100); }
      .chip-active { background: var(--primary-color, var(--action)); border-color: var(--primary-color, var(--action)); color: #fff; font-weight: 600; }
      .search {
        flex: 1; min-width: 220px; padding: 0.4rem 0.75rem;
        border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.875rem;
        background: var(--card-bg); color: var(--text-color); min-height: 34px;
      }

      /* overflow-x aquí (no scroll interno de PrimeNG): la tabla tiene min-width 60rem y en
         pantallas chicas hay que poder correrla, sin que el cuerpo colapse. */
      .table-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow-x: auto; }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); font-size: 0.8125rem; }
      .lineage { display: block; font-size: 0.75rem; color: var(--green-600, #15803d); }
      .recipient { display: block; font-size: 0.875rem; }
      .cust-code { display: block; font-size: 0.75rem; color: var(--text-color-secondary); }
      .prospect { font-style: italic; }
      .days { display: block; font-size: 0.75rem; color: var(--text-color-secondary); }
      .overdue { color: var(--red-600, #b91c1c); font-weight: 600; }
      .unmatched { display: block; font-size: 0.75rem; color: var(--yellow-700, #a16207); }
      .muted { color: var(--text-color-secondary); font-size: 0.8125rem; }
      .table-foot { margin: 0; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: var(--text-color-secondary); border-top: 1px solid var(--border-color); }

      /* [COT.1b] La fila es navegable: cursor, hover y foco visible. Sin el :focus-visible,
         quien navega con teclado tiene una fila clickeable que no puede ver que tiene el foco. */
      .fila { cursor: pointer; }
      .fila:hover { background: var(--hover-bg); }
      .fila:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }

      .empty { padding: 2.5rem 1rem; text-align: center; }
      .empty-title { margin: 0 0 0.35rem; font-weight: 600; }
      .empty-hint { margin: 0; font-size: 0.8125rem; color: var(--text-color-secondary); }
    `,
  ],
})
export class TeleventaQuotesComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);

  readonly filters = FILTERS;

  loading = signal(true);
  rows = signal<QuoteListRow[]>([]);
  total = signal(0);
  summary = signal<QuotesSummary | null>(null);
  activeFilter = signal<string>('abiertas');
  searchTerm = '';

  /** El botón de crear sólo aparece con la llave de gestionar (el god-mode va adentro). */
  readonly puedeGestionar = computed(() => this.perms.has(Permission.COMMERCIAL_QUOTES_GESTIONAR));

  ngOnInit(): void {
    this.reload();
  }

  setFilter(key: string): void {
    this.activeFilter.set(key);
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    const f = FILTERS.find((x) => x.key === this.activeFilter());
    this.svc.list({ status: f?.status || undefined, search: this.searchTerm || undefined }).subscribe({
      next: (page) => {
        this.rows.set(page.rows);
        this.total.set(page.total);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'No se pudieron cargar las cotizaciones',
          detail: err?.error?.message || err?.message || 'Error de red.',
        });
      },
    });
    this.svc.summary().subscribe({
      next: (s) => this.summary.set(s),
      // Un 403 tragado en silencio se lee como "no hay datos" cuando es "no hay permiso"
      // (GOTCHAS §4). Se avisa.
      error: (err) =>
        this.toast.add({
          severity: 'warn',
          summary: 'Resumen no disponible',
          detail: err?.status === 403 ? 'Sin permiso para el resumen.' : 'No se pudo calcular.',
        }),
    });
  }

  /** `[COT.1b]` Enter/Espacio abren la fila: `routerLink` solo responde al clic del ratón. */
  abrir(id: string): void {
    void this.router.navigate(['/telemarketing/cotizaciones', id]);
  }

  statusLabel(s: QuoteStatus): string {
    return STATUS_LABEL[s] ?? s;
  }

  statusSeverity(s: QuoteStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return STATUS_SEVERITY[s] ?? 'secondary';
  }

  originLabel(o: string): string {
    return ORIGIN_LABEL[o] ?? o;
  }

  /** Vencida de verdad = la fecha pasó Y sigue abierta. Una aceptada vencida no es un problema. */
  isOverdue(q: QuoteListRow): boolean {
    return q.days_to_expiry < 0 && (q.status === 'draft' || q.status === 'sent');
  }

  expiryHint(q: QuoteListRow): string {
    if (q.status !== 'draft' && q.status !== 'sent') return '';
    if (q.days_to_expiry < 0) return `venció hace ${Math.abs(q.days_to_expiry)} d`;
    if (q.days_to_expiry === 0) return 'vence hoy';
    return `en ${q.days_to_expiry} d`;
  }

  totalQuotes(s: QuotesSummary): number {
    return Object.values(s.by_status).reduce((a, b) => a + b, 0);
  }
}
