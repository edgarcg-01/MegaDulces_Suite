import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PickingService, PoolOrder, Wave, WaveDetail, WaveLine } from '../picking.service';

type Paso = 'pool' | 'recorrido';

/**
 * Fase SU — Surtido (ADR-067). **UNA pantalla, UNA persona.**
 *
 * El documento origen repartía esto en tres interfaces (jefe de almacén / surtidor / checadora).
 * Decisión de Edgar (2026-09-17): es la misma persona, así que es la misma pantalla, en dos pasos:
 *
 *   1. **Pendientes** — qué hay por surtir hoy; se eligen y se arma la ola.
 *   2. **Recorrido** — la lista consolidada, un renglón a la vez, marcando lo que se levanta.
 *
 * Mobile-first porque el trabajo es caminando; en tablet/PC la misma pantalla se abre más cómoda
 * (§O de DESIGN.md: Almacén = full-width, totales a la vista, frescura prominente).
 *
 * ⚠️ La existencia NO se aparta (ADR-067): lo que se ve al armar la ola es informativo. Si dos
 * olas piden lo mismo, se resuelve por excepción al recorrer, no se previene.
 */
@Component({
  selector: 'app-almacen-surtido',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    TableModule,
    TagModule,
    SelectModule,
    InputTextModule,
    DialogModule,
    ToastModule,
    SkeletonModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Surtido</h1>
          <p class="surf-page-sub">
            Juntá varios pedidos en un solo recorrido del almacén, en vez de una vuelta por pedido
          </p>
        </div>
        <div class="su-head-actions">
          <p-select
            [options]="warehouseOptions()"
            [(ngModel)]="warehouseId"
            optionLabel="label"
            optionValue="value"
            placeholder="Almacén"
            (onChange)="reload()"
            styleClass="su-w"
          ></p-select>
          <button pButton [text]="true" size="small" severity="secondary" (click)="reload()" [loading]="loading()" aria-label="Actualizar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      @if (!warehouseId) {
        <div class="comm-empty">
          <div class="comm-empty-icon"><i class="pi pi-warehouse" aria-hidden="true"></i></div>
          <h3>Elegí un almacén</h3>
          <p>El surtido se organiza por almacén: una ola es un recorrido, y no se pueden recorrer dos a la vez.</p>
        </div>
      } @else {
        <!-- Pasos: la persona sabe siempre dónde está -->
        <nav class="su-steps" aria-label="Pasos del surtido">
          <button type="button" class="su-step" [class.on]="paso() === 'pool'" (click)="irAPool()">
            <span class="su-step-n">1</span>
            <span class="su-step-t">Pendientes</span>
            @if (pool().length) { <span class="su-step-b">{{ pool().length }}</span> }
          </button>
          <button
            type="button"
            class="su-step"
            [class.on]="paso() === 'recorrido'"
            [disabled]="!olaActiva()"
            (click)="paso.set('recorrido')"
          >
            <span class="su-step-n">2</span>
            <span class="su-step-t">Recorrido</span>
            @if (olaActiva(); as o) { <span class="su-step-b mono">{{ o.code }}</span> }
          </button>
        </nav>

        @if (loading()) {
          <p-skeleton height="18rem" styleClass="su-sk"></p-skeleton>
        } @else if (loadError()) {
          <!-- Error de red ≠ vacío: se distinguen a propósito (DESIGN §6) -->
          <div class="comm-empty su-err">
            <div class="comm-empty-icon"><i class="pi pi-cloud-off" aria-hidden="true"></i></div>
            <h3>No se pudo cargar</h3>
            <p>{{ loadError() }}</p>
            <button pButton size="small" (click)="reload()">
              <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span> Reintentar
            </button>
          </div>
        } @else if (paso() === 'pool') {
          <!-- ── PASO 1 — qué hay por surtir ───────────────────────────────────────────── -->
          <section class="surf-card">
            <div class="su-card-head">
              <h2 class="su-h2">Pedidos por surtir</h2>
              @if (seleccion().size > 0) {
                <span class="su-sel">{{ seleccion().size }} seleccionado{{ seleccion().size === 1 ? '' : 's' }} · {{ unidadesSeleccionadas() }} u</span>
              }
            </div>

            <!-- ⚠️ Lo capturado sin señal todavía no llegó. Se dice, en vez de dejar creer
                 que la lista está completa. -->
            <p class="su-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Los pedidos que el vendedor armó sin señal aparecen recién cuando su teléfono
              sincroniza. Esta lista muestra lo que ya llegó.
            </p>

            <p-table
              [value]="pool()"
              styleClass="p-datatable-sm surf-table"
              [scrollable]="true"
              scrollHeight="flex"
            >
              <ng-template #header>
                <tr>
                  <th scope="col" class="su-check"></th>
                  <th scope="col">Pedido</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Entrega</th>
                  <th scope="col" class="num">Renglones</th>
                  <th scope="col" class="num">Unidades</th>
                </tr>
              </ng-template>
              <ng-template #body let-o>
                <tr class="su-row" [class.sel]="seleccion().has(o.id)" (click)="toggle(o)">
                  <td class="su-check">
                    <i class="pi" [ngClass]="seleccion().has(o.id) ? 'pi-check-square' : 'pi-stop'" aria-hidden="true"></i>
                  </td>
                  <td class="mono strong">{{ o.code }}</td>
                  <td>{{ o.customer_name || '—' }}</td>
                  <td class="mono">{{ o.requested_delivery_date || '—' }}</td>
                  <td class="num">{{ o.lines }}</td>
                  <td class="num strong">{{ o.units }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="6" class="comm-empty-cell">
                  <div class="comm-empty">
                    <h3>No hay pedidos por surtir</h3>
                    <p>Cuando los vendedores confirmen pedidos para este almacén van a aparecer acá.</p>
                  </div>
                </td></tr>
              </ng-template>
            </p-table>
          </section>

          <!-- Olas abiertas: para retomar una a medias -->
          @if (olasVivas().length) {
            <section class="surf-card">
              <h2 class="su-h2">Olas en curso</h2>
              <ul class="su-olas">
                @for (w of olasVivas(); track w.id) {
                  <li>
                    <button type="button" class="su-ola" (click)="abrirOla(w.id)">
                      <span class="mono strong">{{ w.code }}</span>
                      <span class="su-ola-meta">{{ w.orders_count || 0 }} pedido(s)</span>
                      <p-tag [value]="etiquetaEstado(w.status)" [severity]="severidad(w.status)"></p-tag>
                      <i class="pi pi-chevron-right" aria-hidden="true"></i>
                    </button>
                  </li>
                }
              </ul>
            </section>
          }

          <!-- Barra de acción fija (zona del pulgar en móvil) -->
          @if (seleccion().size > 0) {
            <div class="su-bar">
              <button pButton [text]="true" severity="secondary" (click)="limpiarSeleccion()">Limpiar</button>
              <button pButton (click)="armarOla()" [loading]="armando()" [disabled]="!puedeGestionar()">
                <span class="p-button-icon p-button-icon-left pi pi-bolt" aria-hidden="true"></span>
                Armar recorrido ({{ seleccion().size }})
              </button>
            </div>
          }
        } @else if (olaActiva(); as ola) {
          <!-- ── PASO 2 — el recorrido ─────────────────────────────────────────────────── -->
          <section class="surf-card">
            <div class="su-card-head">
              <div>
                <h2 class="su-h2">Recorrido <span class="mono">{{ ola.code }}</span></h2>
                <p class="su-sub">{{ ola.orders_count || detalle()?.orders?.length || 0 }} pedido(s) en un solo paseo</p>
              </div>
              <p-tag [value]="etiquetaEstado(ola.status)" [severity]="severidad(ola.status)"></p-tag>
            </div>

            @if (ola.status === 'abierta') {
              <p class="su-note">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Al arrancar se congela lo que hay que juntar. Si alguien corrige un pedido después,
                tu lista no cambia a media vuelta.
              </p>
              <button pButton size="large" (click)="arrancar(ola.id)" [loading]="arrancando()" [disabled]="!puedeGestionar()">
                <span class="p-button-icon p-button-icon-left pi pi-play" aria-hidden="true"></span> Empezar a surtir
              </button>
            } @else {
              <!-- Avance: answer-first, el veredicto antes del detalle (DESIGN §15) -->
              <div class="su-avance">
                <div class="su-av-item">
                  <span class="su-av-n mono">{{ hechos() }}/{{ lineas().length }}</span>
                  <span class="su-av-l">renglones</span>
                </div>
                <div class="su-av-item" [class.bad]="conProblema() > 0">
                  <span class="su-av-n mono">{{ conProblema() }}</span>
                  <span class="su-av-l">con faltante</span>
                </div>
                <div class="su-av-bar" role="progressbar" [attr.aria-valuenow]="hechos()" [attr.aria-valuemin]="0" [attr.aria-valuemax]="lineas().length">
                  <span [style.width.%]="pct()"></span>
                </div>
              </div>

              <ul class="su-lineas">
                @for (l of lineas(); track l.id) {
                  <li class="su-linea" [class.done]="l.status !== 'pendiente'" [class.warn]="l.status === 'faltante' || l.status === 'agotado' || l.status === 'danado'">
                    <div class="su-li-main">
                      <div class="su-li-nombre">{{ l.product_name || l.product_id }}</div>
                      <div class="su-li-meta">
                        @if (l.sku) { <span class="mono">{{ l.sku }}</span> }
                        @if (l.bin_code) { <span class="mono su-bin"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ l.bin_code }}</span> }
                        @if (l.status !== 'pendiente') {
                          <p-tag [value]="etiquetaLinea(l)" [severity]="severidadLinea(l.status)"></p-tag>
                        }
                      </div>
                    </div>
                    <div class="su-li-qty">
                      <span class="su-li-pide mono">{{ l.qty_requested }}</span>
                      <!-- ⭐ La unidad SIEMPRE visible. Si no se pudo determinar, se dice —
                           nunca se asume pieza (ADR-055/057). -->
                      <span class="su-li-unit">{{ unidadDe(l) }}</span>
                    </div>
                    <button pButton size="small" [text]="l.status !== 'pendiente'" (click)="abrirMarca(l)" [disabled]="ola.status === 'surtida' || !puedeGestionar()">
                      {{ l.status === 'pendiente' ? 'Marcar' : 'Cambiar' }}
                    </button>
                  </li>
                }
              </ul>

              @if (ola.status !== 'surtida') {
                <div class="su-bar">
                  <button pButton [text]="true" severity="danger" (click)="cancelar(ola.id)">Cancelar ola</button>
                  <button pButton (click)="cerrar(ola.id)" [loading]="cerrando()" [disabled]="hechos() < lineas().length">
                    <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                    {{ hechos() < lineas().length ? 'Faltan ' + (lineas().length - hechos()) : 'Terminar surtido' }}
                  </button>
                </div>
              }
            }
          </section>

          <!-- Qué pedido se lleva cuánto: el desglose que hace posible repartir después -->
          @if (detalle()?.consolidated?.length) {
            <section class="surf-card">
              <h2 class="su-h2">A quién va cada cosa</h2>
              <p class="su-sub">Al terminar el recorrido, esto es lo que se separa por cliente.</p>
              <p-table [value]="detalle()!.consolidated" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="320px">
                <ng-template #header>
                  <tr><th scope="col">Producto</th><th scope="col" class="num">Total</th><th scope="col">Reparto</th></tr>
                </ng-template>
                <ng-template #body let-c>
                  <tr>
                    <td>{{ c.product_name || c.product_id }}</td>
                    <td class="num strong mono">
                      {{ c.total_base }}
                      <small class="su-li-unit">{{ c.unidad_mixta ? 'base' : (c.qty_unit || 'base') }}</small>
                    </td>
                    <td class="su-reparto">
                      @for (p of c.por_pedido; track p.order_id) {
                        <span class="su-chip"><span class="mono">{{ p.order_code }}</span> {{ p.quantity }}</span>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </section>
          }
        }
      }

      <!-- Marcar un renglón: una decisión por pantalla (§44 del documento) -->
      <p-dialog
        [visible]="marcaOpen()"
        (visibleChange)="marcaOpen.set($event)"
        [modal]="true"
        [dismissableMask]="true"
        [style]="{ width: '420px' }"
        [header]="lineaEnMarca()?.product_name || 'Marcar renglón'"
      >
        @if (lineaEnMarca(); as l) {
          <div class="su-marca">
            <p class="su-marca-pide">
              Hay que juntar <b class="mono">{{ l.qty_requested }}</b> <span class="su-li-unit">{{ unidadDe(l) }}</span>
            </p>
            <label class="su-field">
              <span>¿Cuánto levantaste?</span>
              <input pInputText type="number" inputmode="numeric" min="0" [max]="+l.qty_requested" [(ngModel)]="marcaQty" />
            </label>
            <div class="su-quick">
              <button pButton size="small" [text]="true" (click)="marcaQty = +l.qty_requested">Todo</button>
              <button pButton size="small" [text]="true" severity="secondary" (click)="marcaQty = 0">Nada</button>
            </div>
            @if (marcaQty === 0) {
              <label class="su-field">
                <span>¿Por qué no había?</span>
                <p-select [options]="motivos" [(ngModel)]="marcaStatus" optionLabel="label" optionValue="value" styleClass="su-w"></p-select>
              </label>
            }
            <label class="su-field">
              <span>Nota (opcional)</span>
              <input pInputText [(ngModel)]="marcaNota" placeholder="Ej. caja mojada" />
            </label>
            <p class="su-note su-note-sm">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              Si falta algo, marcalo y seguí: nadie se detiene. El faltante se resuelve aparte.
            </p>
          </div>
        }
        <ng-template #footer>
          <button pButton [text]="true" severity="secondary" (click)="marcaOpen.set(false)">Cancelar</button>
          <button pButton (click)="guardarMarca()" [loading]="marcando()">Guardar</button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .su-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .su-w { width: 100%; min-width: 180px; }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .su-h2 { font-size: .95rem; font-weight: 700; margin: 0; }
    .su-sub { font-size: .8rem; color: var(--text-color-secondary); margin: .15rem 0 0; }
    .su-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; margin-bottom: .75rem; flex-wrap: wrap; }
    .su-sel { font-size: .8rem; font-weight: 700; color: var(--action, var(--primary-color)); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .strong { font-weight: 700; }

    /* Pasos */
    .su-steps { display: flex; gap: .5rem; margin-bottom: 1rem; }
    .su-step { flex: 1; display: flex; align-items: center; gap: .5rem; min-height: 44px; padding: .5rem .75rem; background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); cursor: pointer; color: var(--text-color-secondary); font-family: inherit; font-size: .85rem; font-weight: 600; }
    .su-step.on { border-color: var(--action, var(--primary-color)); color: var(--text-color); }
    .su-step:disabled { opacity: .5; cursor: not-allowed; }
    .su-step:focus-visible { outline: 2px solid var(--action, var(--primary-color)); outline-offset: 2px; }
    .su-step-n { display: grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--surface-ground); font-family: var(--font-mono); font-size: .75rem; flex-shrink: 0; }
    .su-step.on .su-step-n { background: var(--action, var(--primary-color)); color: #fff; }
    .su-step-t { flex: 1; text-align: left; }
    .su-step-b { font-size: .75rem; font-weight: 700; }

    .su-note { display: flex; align-items: flex-start; gap: .4rem; font-size: .78rem; line-height: 1.4; color: var(--text-color-secondary); margin: 0 0 .75rem; }
    .su-note i { margin-top: .15rem; flex-shrink: 0; }
    .su-note-sm { margin-top: .5rem; margin-bottom: 0; }
    .su-err h3 { margin-bottom: .25rem; }

    /* Tabla del pool */
    .su-check { width: 2.5rem; text-align: center; }
    .su-row { cursor: pointer; }
    .su-row.sel { background: color-mix(in srgb, var(--action, var(--primary-color)) 8%, transparent); }
    .num { text-align: right; }

    /* Olas vivas */
    .su-olas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
    .su-ola { width: 100%; min-height: 44px; display: flex; align-items: center; gap: .6rem; padding: .5rem .75rem; background: var(--surface-ground); border: 1px solid var(--surface-border); border-radius: var(--radius-md, 8px); cursor: pointer; font-family: inherit; font-size: .85rem; color: var(--text-color); }
    .su-ola-meta { flex: 1; text-align: left; color: var(--text-color-secondary); font-size: .8rem; }

    /* Avance */
    .su-avance { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; margin-bottom: .9rem; }
    .su-av-item { display: flex; flex-direction: column; }
    .su-av-n { font-size: 1.35rem; font-weight: 700; line-height: 1; }
    .su-av-item.bad .su-av-n { color: var(--warn-fg, var(--orange-600)); }
    .su-av-l { font-size: .72rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .04em; }
    .su-av-bar { flex: 1; min-width: 8rem; height: 6px; border-radius: 999px; background: var(--surface-ground); overflow: hidden; }
    .su-av-bar > span { display: block; height: 100%; background: var(--action, var(--primary-color)); transition: width 250ms ease-out; }

    /* Renglones del recorrido */
    .su-lineas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
    .su-linea { display: flex; align-items: center; gap: .75rem; padding: .6rem .75rem; border: 1px solid var(--surface-border); border-radius: var(--radius-md, 8px); }
    .su-linea.done { opacity: .62; }
    .su-linea.warn { border-color: var(--warn-fg, var(--orange-500)); opacity: 1; }
    .su-li-main { flex: 1; min-width: 0; }
    .su-li-nombre { font-weight: 600; font-size: .9rem; overflow-wrap: anywhere; }
    .su-li-meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .75rem; color: var(--text-color-secondary); margin-top: .15rem; }
    .su-bin { display: inline-flex; align-items: center; gap: .2rem; }
    .su-li-qty { display: flex; flex-direction: column; align-items: flex-end; flex-shrink: 0; }
    .su-li-pide { font-size: 1.15rem; font-weight: 700; line-height: 1; }
    .su-li-unit { font-size: .7rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .03em; }

    .su-reparto { display: flex; gap: .3rem; flex-wrap: wrap; }
    .su-chip { font-size: .72rem; padding: .1rem .4rem; border-radius: var(--radius-sm, 6px); background: var(--surface-ground); border: 1px solid var(--surface-border); }

    /* Barra de acción (pulgar) */
    .su-bar { position: sticky; bottom: 0; display: flex; gap: .5rem; justify-content: flex-end; padding: .75rem 0 .25rem; background: linear-gradient(to top, var(--surface-ground) 70%, transparent); }
    .su-bar button { min-height: 44px; }

    /* Diálogo de marca */
    .su-marca-pide { font-size: .9rem; margin: 0 0 .75rem; }
    .su-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .su-field > span { font-size: .8rem; font-weight: 600; color: var(--text-color-secondary); }
    .su-field input { width: 100%; min-height: 44px; font-family: var(--font-mono); font-size: 1.1rem; }
    .su-quick { display: flex; gap: .5rem; margin-bottom: .75rem; }

    @media (max-width: 40rem) {
      .su-avance { gap: .9rem; }
      .su-li-nombre { font-size: .85rem; }
      .su-bar { justify-content: stretch; }
      .su-bar button { flex: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .su-av-bar > span { transition: none; }
    }
  `],
})
export class AlmacenSurtidoComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly paso = signal<Paso>('pool');
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly armando = signal(false);
  readonly arrancando = signal(false);
  readonly cerrando = signal(false);
  readonly marcando = signal(false);

  readonly warehouses = signal<Warehouse[]>([]);
  warehouseId = '';
  readonly pool = signal<PoolOrder[]>([]);
  readonly olas = signal<Wave[]>([]);
  readonly olaActiva = signal<Wave | null>(null);
  readonly detalle = signal<WaveDetail | null>(null);
  readonly lineas = signal<WaveLine[]>([]);
  readonly seleccion = signal<Set<string>>(new Set());

  readonly marcaOpen = signal(false);
  readonly lineaEnMarca = signal<WaveLine | null>(null);
  marcaQty = 0;
  marcaStatus = 'agotado';
  marcaNota = '';
  readonly motivos = [
    { label: 'No había nada (agotado)', value: 'agotado' },
    { label: 'Estaba dañado', value: 'danado' },
    { label: 'Había menos de lo pedido', value: 'faltante' },
  ];

  readonly puedeGestionar = computed(() => this.perms.has(Permission.COMMERCIAL_PICKING_GESTIONAR));
  readonly warehouseOptions = computed(() =>
    this.warehouses().map((w) => ({ label: w.name, value: w.id })),
  );
  readonly olasVivas = computed(() =>
    this.olas().filter((w) => w.status === 'abierta' || w.status === 'en_surtido'),
  );
  readonly unidadesSeleccionadas = computed(() =>
    this.pool()
      .filter((o) => this.seleccion().has(o.id))
      .reduce((s, o) => s + Number(o.units || 0), 0),
  );
  readonly hechos = computed(() => this.lineas().filter((l) => l.status !== 'pendiente').length);
  readonly conProblema = computed(
    () => this.lineas().filter((l) => ['faltante', 'agotado', 'danado'].includes(l.status)).length,
  );
  readonly pct = computed(() => {
    const t = this.lineas().length;
    return t ? Math.round((this.hechos() / t) * 100) : 0;
  });

  ngOnInit(): void {
    this.comercial
      .listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ws) => {
          const activos = (ws || []).filter((w: any) => w.kind !== 'truck');
          this.warehouses.set(activos);
          const def = activos.find((w: any) => w.is_default) || activos[0];
          if (def) {
            this.warehouseId = def.id;
            this.reload();
          }
        },
        error: () => this.loadError.set('No se pudo leer el catálogo de almacenes.'),
      });
  }

  reload(): void {
    if (!this.warehouseId) return;
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .pool({ warehouseId: this.warehouseId })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.pool.set(r?.data || []);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.loadError.set(e?.error?.message || e?.message || 'Error de red.');
        },
      });
    this.api
      .waves()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (w) => this.olas.set(w || []), error: () => void 0 });
  }

  irAPool(): void {
    this.paso.set('pool');
    this.reload();
  }

  /** El template de Angular no admite `new Set()` como expresión: va acá. */
  limpiarSeleccion(): void {
    this.seleccion.set(new Set());
  }

  toggle(o: PoolOrder): void {
    this.seleccion.update((s) => {
      const n = new Set(s);
      if (n.has(o.id)) n.delete(o.id);
      else n.add(o.id);
      return n;
    });
  }

  armarOla(): void {
    const ids = Array.from(this.seleccion());
    if (!ids.length) return;
    this.armando.set(true);
    this.api
      .createWave({ warehouse_id: this.warehouseId, order_ids: ids })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (w) => {
          this.armando.set(false);
          this.seleccion.set(new Set());
          this.toast.add({ severity: 'success', summary: `Recorrido ${w.code} armado` });
          this.abrirOla(w.id);
        },
        error: (e) => {
          this.armando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo armar', detail: e?.error?.message || e?.message, life: 7000 });
        },
      });
  }

  abrirOla(id: string): void {
    this.api
      .wave(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.detalle.set(d);
          this.olaActiva.set(d);
          this.paso.set('recorrido');
          if (d.status !== 'abierta') this.cargarLineas(id);
          else this.lineas.set([]);
        },
        error: (e) => this.toast.add({ severity: 'error', summary: 'No se pudo abrir', detail: e?.error?.message }),
      });
  }

  private cargarLineas(id: string): void {
    this.api
      .lines(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ls) => this.lineas.set(ls || []), error: () => void 0 });
  }

  arrancar(id: string): void {
    this.arrancando.set(true);
    this.api
      .start(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ls) => {
          this.arrancando.set(false);
          this.lineas.set(ls || []);
          this.olaActiva.update((o) => (o ? { ...o, status: 'en_surtido' } : o));
        },
        error: (e) => {
          this.arrancando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo empezar', detail: e?.error?.message || e?.message });
        },
      });
  }

  abrirMarca(l: WaveLine): void {
    this.lineaEnMarca.set(l);
    this.marcaQty = l.qty_picked != null ? Number(l.qty_picked) : Number(l.qty_requested);
    this.marcaStatus = 'agotado';
    this.marcaNota = l.note || '';
    this.marcaOpen.set(true);
  }

  guardarMarca(): void {
    const l = this.lineaEnMarca();
    const ola = this.olaActiva();
    if (!l || !ola) return;
    this.marcando.set(true);
    this.api
      .pick(ola.id, l.id, {
        qty_picked: Number(this.marcaQty) || 0,
        status: Number(this.marcaQty) === 0 ? this.marcaStatus : undefined,
        note: this.marcaNota || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (upd) => {
          this.marcando.set(false);
          this.marcaOpen.set(false);
          this.lineas.update((ls) => ls.map((x) => (x.id === upd.id ? { ...x, ...upd } : x)));
        },
        error: (e) => {
          this.marcando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo marcar', detail: e?.error?.message || e?.message, life: 7000 });
        },
      });
  }

  cerrar(id: string): void {
    this.cerrando.set(true);
    this.api
      .finish(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (w) => {
          this.cerrando.set(false);
          this.olaActiva.set(w);
          this.toast.add({ severity: 'success', summary: 'Surtido terminado', detail: `${w.code} listo para separar por cliente.` });
          this.reload();
        },
        error: (e) => {
          this.cerrando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cerrar', detail: e?.error?.message || e?.message, life: 7000 });
        },
      });
  }

  cancelar(id: string): void {
    this.confirm.confirm({
      header: 'Cancelar el recorrido',
      message: 'Los pedidos vuelven a la lista de pendientes y se pierde lo marcado. ¿Seguro?',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Cancelar recorrido',
      rejectLabel: 'No',
      accept: () => {
        this.api
          .cancelWave(id)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => {
              this.olaActiva.set(null);
              this.lineas.set([]);
              this.irAPool();
            },
            error: (e) => this.toast.add({ severity: 'error', summary: 'No se pudo cancelar', detail: e?.error?.message }),
          });
      },
    });
  }

  /**
   * La unidad que se muestra junto a la cantidad. ⭐ Cuando no se pudo determinar se dice
   * "base" — nunca se asume "pieza": la unidad base del catálogo es PAQ en 6,586 SKUs y PZA en
   * sólo 1,906, así que suponerla es exactamente el error que ADR-055 ya cobró.
   */
  unidadDe(l: WaveLine): string {
    if (l.unidad_mixta) return 'base (mixto)';
    return l.qty_unit || 'base';
  }

  etiquetaEstado(s: string): string {
    return { abierta: 'Sin empezar', en_surtido: 'Surtiendo', surtida: 'Terminada', cancelada: 'Cancelada' }[s] || s;
  }
  severidad(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return s === 'surtida' ? 'success' : s === 'en_surtido' ? 'info' : s === 'cancelada' ? 'danger' : 'secondary';
  }
  etiquetaLinea(l: WaveLine): string {
    if (l.status === 'surtido') return 'Completo';
    if (l.status === 'faltante') return `Faltó (${l.qty_picked} de ${l.qty_requested})`;
    if (l.status === 'agotado') return 'No había';
    if (l.status === 'danado') return 'Dañado';
    return l.status;
  }
  severidadLinea(s: string): 'success' | 'warn' | 'danger' | 'secondary' {
    return s === 'surtido' ? 'success' : s === 'danado' ? 'danger' : 'warn';
  }
}
