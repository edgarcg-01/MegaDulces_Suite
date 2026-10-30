import {
  ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type {
  PresaleReviewDetail,
  PresaleReviewInboxResponse,
  PresaleReviewInboxRow,
  PresaleReviewLine,
} from '@megadulces/contracts';
import { PresaleReviewService } from '../presale-review.service';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import {
  type Accion,
  type ProgresoPedido,
  aplicar,
  cantidadTexto,
  cuerpoDeCierre,
  deshacer,
  diasSinRevisar,
  noHubo,
  pasoDe,
  progresoInicial,
  renglonActual,
  resuelto,
  resueltos,
  textoAtraso,
} from '../revision-caja';

/** Cada cuánto se vuelve a pedir la bandeja mientras se ve: así llegan solos los pedidos que el surtidor termina. */
const REFRESCO_MS = 20_000;
/** Lo que lleva revisado cada pedido se guarda en el navegador: si se recarga la página no se pierde. */
const LLAVE = 'mcp10:revision:';

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[MCP.10]` **Revisión de pedidos** en caja: antes de cobrar, la cajera revisa cada pedido de
 * preventa surtido, producto por producto, contra lo que le entregó el surtidor.
 *
 * Decisiones (David, 2026-10-29, sobre la maqueta v7):
 *  · un producto a la vez, resaltado y en grande (las cajeras son personas mayores);
 *  · lo normal es un toque, «Está bien»; si faltó y Kepler dice que hay, ella se lo pide al surtidor
 *    y confirma «Ya se completó» (no hay pantalla del surtidor: todo pasa aquí);
 *  · «No coincide» / «Trajo otra cantidad» con − y + grandes; «Seguir con otro» mientras espera;
 *    «← Anterior» para deshacer; los otros pedidos se pueden tocar para cambiar;
 *  · al terminar, el pedido de la Suite queda con lo que se va a cobrar y la vendedora recibe aviso.
 */
@Component({
  selector: 'app-almacen-revision-preventa',
  standalone: true,
  imports: [CommonModule, ToastModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in rv-page">
      <p-toast position="top-center"></p-toast>
      <p class="rv-oculto" role="status" aria-live="polite">{{ anuncio() }}</p>

      @if (!abierto()) {
        <header class="rv-top">
          <div class="rv-top-mid">
            <h1 class="rv-h1">Revisión de pedidos</h1>
            <span class="rv-sub">Antes de cobrar, revisa cada pedido que terminó el surtidor.</span>
          </div>
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="60"></app-freshness-pill>
        </header>

        @if (bandeja()) {
          <app-metric-strip [items]="metricas()" [instant]="true" ariaLabel="Pedidos de preventa en caja"></app-metric-strip>
        }

        @if (bandeja()?.truncated) {
          <div class="rv-banda" role="status">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>Hay {{ bandeja()!.pending }} pedidos sin revisar y aquí se ven los primeros {{ porRevisar().length }}. Revisa los de arriba y la lista se recorre.</span>
          </div>
        }

        @if (bandeja()?.scope === 'ninguno') {
          <div class="rv-banda" role="status">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span>Tu usuario no tiene una sucursal asignada. Pide que te la asignen en Administración › Personas.</span>
          </div>
        }

        <app-load-state [loading]="cargando() && !bandeja()" [error]="error()" [isEmpty]="!!bandeja() && !bandeja()!.data.length"
                        emptyIcon="pi-check-circle" emptyTitle="No hay pedidos por revisar"
                        emptyHint="Cuando el surtidor termine un pedido de preventa, va a aparecer aquí solo."
                        (retry)="cargar()">
          <div class="rv-lista">
            @for (p of porRevisar(); track p.order_id) {
              <button type="button" class="rv-card" [class.rv-card-atrasado]="!!atraso(p)" (click)="abrir(p.order_id)">
                @if (atraso(p); as a) { <span class="rv-atraso"><i class="pi pi-clock" aria-hidden="true"></i> {{ a }}</span> }
                <span class="rv-card-r1">
                  <strong class="rv-cliente">{{ p.customer_name || p.code }}</strong>
                  @if (p.pick_outcome === 'con_faltantes') { <span class="rv-chip rv-chip-warn">Faltó algo</span> }
                </span>
                <span class="rv-card-r2">
                  <span class="rv-folio">{{ p.code }}</span>
                  <span>{{ p.lines === 1 ? '1 producto' : p.lines + ' productos' }}</span>
                  <span>surtió {{ p.finished.name }} · {{ horaDe(p.finished.at) }}</span>
                </span>
                <span class="rv-card-go">Revisar <i class="pi pi-arrow-right" aria-hidden="true"></i></span>
              </button>
            }
          </div>
          @if (revisados().length) {
            <h2 class="rv-h2">Revisados</h2>
            <ul class="rv-hechos">
              @for (p of revisados(); track p.order_id) {
                <li class="rv-hecho"><span>{{ p.customer_name || p.code }} · {{ p.code }}</span>
                  <span>{{ p.reviewed?.name }} · {{ horaDe(p.reviewed?.at) }}</span></li>
              }
            </ul>
          }
        </app-load-state>
      } @else {
        <!-- ─────────── UN PEDIDO ─────────── -->
        <header class="rv-top">
          <button type="button" class="rv-volver" (click)="cerrarDetalle()" aria-label="Volver a la lista de pedidos">
            <i class="pi pi-arrow-left" aria-hidden="true"></i>
          </button>
          <div class="rv-top-mid">
            <h1 class="rv-h1">{{ detalle()?.order?.customer_name || detalle()?.order?.code || 'Pedido' }}</h1>
            @if (detalle(); as d) { <span class="rv-sub rv-folio">{{ d.order.code }} · surtió {{ d.order.finished.name }}</span> }
          </div>
        </header>

        <app-load-state [loading]="cargandoDetalle()" [error]="errorDetalle()" [isEmpty]="false" (retry)="abrir(abierto()!, false)">
          @if (detalle(); as d) {
            @if (d.order.state === 'revisado') {
              <div class="rv-fin">
                <b>Este pedido ya se revisó</b>
                <span>{{ d.order.reviewed?.name }} · {{ horaDe(d.order.reviewed?.at) }}</span>
              </div>
            } @else {
              <div class="rv-prog">
                <div class="rv-barra" aria-hidden="true"><span [style.width.%]="pct()"></span></div>
                <b>Producto {{ numeroActual() }} de {{ d.lines.length }}</b>
              </div>
              @if (d.order.instructions) {
                <p class="rv-indic"><i class="pi pi-comment" aria-hidden="true"></i> {{ d.order.instructions }}</p>
              }
              @if (progreso().hist.length && !editando()) {
                <button type="button" class="rv-btn rv-btn-atras" (click)="anterior()"><i class="pi pi-arrow-left" aria-hidden="true"></i> Anterior</button>
              }

              @if (actual(); as l) {
                @if (editando()) {
                  <section class="rv-actual" aria-live="polite">
                    <span class="rv-flecha">▶ REVISANDO · CONTAR</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    <span class="rv-pregunta">¿Cuántos vienen?</span>
                    <div class="rv-paso">
                      <button type="button" (click)="mover(-1)" aria-label="Uno menos"><i class="pi pi-minus" aria-hidden="true"></i></button>
                      <span class="rv-num">{{ editando()!.n }}<small>{{ unidadTexto(editando()!.n, l.unit) }} · deben ser {{ l.ordered }}</small></span>
                      <button type="button" (click)="mover(1)" aria-label="Uno más"><i class="pi pi-plus" aria-hidden="true"></i></button>
                    </div>
                    <button type="button" class="rv-btn rv-btn-ok" (click)="guardarConteo(l)">Guardar</button>
                    <button type="button" class="rv-btn" (click)="editando.set(null)">Cancelar</button>
                  </section>
                } @else if (estadoDe(l) === 'por_revisar') {
                  <section class="rv-actual">
                    <span class="rv-flecha">▶ REVISANDO</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    <span class="rv-cant">Deben ser <span class="rv-mono">{{ cantidadTexto(l.ordered, l.unit) }}</span></span>
                    <button type="button" class="rv-btn rv-btn-ok" (click)="hacer(l, { tipo: 'bien' })">Está bien <i class="pi pi-check" aria-hidden="true"></i></button>
                    <button type="button" class="rv-btn" (click)="contar(l)">No coincide</button>
                  </section>
                } @else if (estadoDe(l) === 'falta') {
                  <section class="rv-actual rv-actual-falta">
                    <span class="rv-flecha">▶ REVISANDO · FALTÓ{{ marca(l)?.despues ? ' · SIGUE ESPERANDO' : '' }}</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    <span class="rv-falta">Se pidieron {{ l.ordered }} y vienen {{ marca(l)!.vienen }}: faltan {{ cantidadTexto(faltan(l), l.unit) }}</span>
                    <span class="rv-hay" [class.rv-hay-no]="l.stock?.state !== 'con_existencia'">{{ textoExistencia(l) }}</span>
                    @if (l.restorable) {
                      <span class="rv-espera">Pídele al surtidor {{ cantidadTexto(faltan(l), l.unit) }}. Cuando te lo traiga, toca «Ya se completó».</span>
                      <button type="button" class="rv-btn rv-btn-ok" (click)="hacer(l, { tipo: 'completar' })">Ya se completó <i class="pi pi-check" aria-hidden="true"></i></button>
                    } @else {
                      <span class="rv-espera">Este producto se quitó del pedido al surtir y ya no se puede agregar desde aquí. Avísale a la vendedora.</span>
                    }
                    <div class="rv-btns3">
                      @if (l.restorable) { <button type="button" class="rv-btn rv-btn-sm" (click)="contar(l)">Trajo otra cantidad</button> }
                      <button type="button" class="rv-btn rv-btn-sm" (click)="hacer(l, { tipo: 'despues' })">Seguir con otro</button>
                      <button type="button" class="rv-btn rv-btn-sm rv-btn-mal" (click)="hacer(l, { tipo: 'nohay' })">No hay</button>
                    </div>
                  </section>
                } @else if (estadoDe(l) === 'sobra') {
                  <section class="rv-actual rv-actual-sobra">
                    <span class="rv-flecha">▶ REVISANDO · VINO DE MÁS</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    <span class="rv-sobra">Se pidieron {{ l.ordered }} y vienen {{ marca(l)!.vienen }}: sobran {{ cantidadTexto(sobran(l), l.unit) }}</span>
                    <span class="rv-espera">Devuélvele {{ cantidadTexto(sobran(l), l.unit) }} al surtidor.</span>
                    <button type="button" class="rv-btn rv-btn-ok" (click)="hacer(l, { tipo: 'devuelto' })">Ya los devolví <i class="pi pi-check" aria-hidden="true"></i></button>
                    <button type="button" class="rv-btn rv-btn-sm" (click)="contar(l)">Contar otra vez</button>
                  </section>
                }
              } @else {
                <div class="rv-fin">
                  <b>Pedido revisado <i class="pi pi-check" aria-hidden="true"></i></b>
                  @if (faltantes().length) {
                    <span class="rv-aviso">No se cobra lo que no hubo:
                      @for (x of faltantes(); track x.line.key; let ult = $last) { {{ cantidadTexto(x.faltan, x.line.unit) }} de {{ x.line.product_name }}{{ ult ? '.' : ', ' }} }
                    </span>
                  } @else {
                    <span>Todos los productos están bien.</span>
                  }
                  <button type="button" class="rv-btn rv-btn-ok" [disabled]="trabajando()" (click)="terminar(d)">
                    @if (trabajando()) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> }
                    Terminar y seguir con el siguiente
                  </button>
                </div>
              }

              <ul class="rv-items">
                @for (x of d.lines; track x.key) {
                  @if (x.key !== actual()?.key) {
                    <li class="rv-item" [class.rv-item-ok]="resuelto(marca(x)) && estadoDe(x) !== 'nohay'" [class.rv-item-no]="estadoDe(x) === 'nohay'">
                      <span class="rv-item-n">
                        @if (estadoDe(x) === 'nohay') { <i class="pi pi-times" aria-hidden="true"></i> }
                        @else if (resuelto(marca(x))) { <i class="pi pi-check" aria-hidden="true"></i> }
                        {{ x.product_name }}{{ marca(x)?.despues && !resuelto(marca(x)) ? ' · esperando al surtidor' : '' }}
                      </span>
                      <span class="rv-mono">{{ textoRenglon(x) }}</span>
                    </li>
                  }
                }
              </ul>
            }
          }
        </app-load-state>

        @if (otros().length) {
          <div class="rv-otros">
            <span>Otros pedidos por revisar (toca uno para cambiar):</span>
            <div class="rv-otros-fila">
              @for (p of otros(); track p.order_id) {
                <button type="button" class="rv-pill" (click)="abrir(p.order_id)">{{ p.customer_name || p.code }}</button>
              }
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .rv-page { max-width: 46rem; }
    .rv-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .rv-top { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .rv-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .rv-h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; line-height: 1.2; }
    .rv-h2 { margin: var(--sp-5) 0 var(--sp-2); font-size: var(--fs-lg); font-weight: 800; }
    .rv-sub { font-size: var(--fs-body); color: var(--text-muted); }
    .rv-folio, .rv-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rv-banda { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3);
      border-radius: var(--r-md); border: 1px solid currentColor; color: var(--warn-fg); font-size: var(--fs-body); }
    .rv-volver { min-width: var(--tap-min); min-height: var(--tap-min); border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--text-main); cursor: pointer; font-size: var(--fs-lg); }
    .rv-lista { display: flex; flex-direction: column; gap: var(--sp-2); }
    .rv-card { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; text-align: left; cursor: pointer;
      padding: var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); color: var(--text-main); }
    .rv-card:hover { background: var(--surface-hover); }
    .rv-card-atrasado { border-left: 4px solid var(--warn-fg); }
    .rv-atraso { display: inline-flex; align-items: center; gap: var(--sp-1); align-self: flex-start; font-size: var(--fs-body); font-weight: 800; color: var(--warn-fg); }
    .rv-card-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .rv-cliente { font-size: var(--fs-h3); line-height: 1.2; }
    .rv-card-r2 { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-body); color: var(--text-muted); }
    .rv-card-go { align-self: flex-end; font-weight: 800; font-size: var(--fs-lg); color: var(--action); }
    .rv-chip { border-radius: var(--r-pill); padding: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); font-weight: 800; white-space: nowrap; }
    .rv-chip-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rv-hechos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .rv-hecho { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-md); background: var(--ok-soft-bg); color: var(--ok-soft-fg); font-size: var(--fs-body); }
    .rv-prog { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); }
    .rv-barra { flex: 1; min-width: 7rem; height: 0.75rem; background: var(--surface-border); border-radius: var(--r-pill); overflow: hidden; }
    .rv-barra span { display: block; height: 100%; background: var(--ok-fg); transition: width 250ms ease; }
    .rv-prog b { font-size: var(--fs-lg); white-space: nowrap; }
    .rv-indic { margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--info-soft-bg);
      color: var(--info-soft-fg); font-size: var(--fs-body); }
    .rv-actual { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); border: 4px solid var(--info-fg);
      border-radius: var(--r-xl); background: var(--info-soft-bg); margin-bottom: var(--sp-3); }
    .rv-actual-falta { border-color: var(--warn-fg); background: var(--warn-soft-bg); }
    .rv-actual-sobra { border-color: var(--action); background: var(--card-bg); }
    .rv-flecha { font-size: var(--fs-body); font-weight: 800; letter-spacing: .02em; color: var(--info-fg); }
    .rv-actual-falta .rv-flecha { color: var(--warn-fg); }
    .rv-actual-sobra .rv-flecha { color: var(--action); }
    .rv-nombre { font-size: var(--fs-h2); font-weight: 800; line-height: 1.2; }
    .rv-cant, .rv-pregunta { font-size: var(--fs-h3); font-weight: 700; }
    .rv-falta { font-size: var(--fs-lg); font-weight: 800; color: var(--warn-fg); }
    .rv-sobra { font-size: var(--fs-lg); font-weight: 800; color: var(--action); }
    .rv-hay { font-size: var(--fs-body); font-weight: 700; color: var(--ok-fg); }
    .rv-hay-no { color: var(--text-muted); }
    .rv-espera { font-size: var(--fs-lg); font-weight: 800; color: var(--text-main); }
    .rv-btn { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: 3.5rem; width: 100%;
      padding: 0 var(--sp-4); border-radius: var(--r-lg); border: 2px solid var(--border-color); background: var(--card-bg);
      color: var(--text-main); font-size: var(--fs-lg); font-weight: 800; cursor: pointer; }
    .rv-btn:focus-visible, .rv-card:focus-visible, .rv-pill:focus-visible, .rv-volver:focus-visible, .rv-paso button:focus-visible {
      outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    .rv-btn:disabled { cursor: not-allowed; opacity: .6; }
    .rv-btn-ok { background: var(--ok-fg); border-color: var(--ok-fg); color: var(--card-bg); }
    .rv-btn-sm { min-height: 3.25rem; font-size: var(--fs-body); }
    .rv-btn-mal { color: var(--bad-fg); border-color: var(--bad-border); }
    .rv-btn-atras { width: auto; align-self: flex-start; min-height: 3.25rem; font-size: var(--fs-body); margin-bottom: var(--sp-3); }
    .rv-btns3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--sp-2); }
    .rv-paso { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) 4.5rem; gap: var(--sp-3); align-items: center; }
    .rv-paso button { min-height: 4.5rem; border-radius: var(--r-lg); border: 2px solid var(--border-color); background: var(--card-bg);
      color: var(--text-main); font-size: var(--fs-h2); cursor: pointer; }
    .rv-num { text-align: center; font-family: var(--font-mono); font-size: var(--fs-display); font-weight: 700; line-height: 1; }
    .rv-num small { display: block; margin-top: var(--sp-1); font-family: inherit; font-size: var(--fs-body); font-weight: 700; color: var(--text-muted); }
    .rv-fin { display: flex; flex-direction: column; gap: var(--sp-2); align-items: stretch; text-align: center; padding: var(--sp-4);
      border-radius: var(--r-xl); background: var(--ok-soft-bg); color: var(--ok-soft-fg); margin-bottom: var(--sp-3); font-size: var(--fs-body); }
    .rv-fin b { font-size: var(--fs-h3); }
    .rv-aviso { color: var(--bad-fg); font-weight: 800; font-size: var(--fs-lg); }
    .rv-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .rv-item { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-md); border: 1px solid var(--border-color); color: var(--text-muted); font-size: var(--fs-body); }
    .rv-item-n { flex: 1; min-width: 0; }
    .rv-item-ok { border-color: transparent; background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .rv-item-no { border-color: transparent; background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .rv-otros { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); font-size: var(--fs-body); color: var(--text-muted); }
    .rv-otros-fila { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .rv-pill { min-height: var(--tap-min); padding: 0 var(--sp-4); border-radius: var(--r-pill); border: 2px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); font-size: var(--fs-body); font-weight: 700; cursor: pointer; }
    /* Angosto (teléfono o panel con el menú abierto): el nombre baja un escalón y los tres botones se apilan. */
    @container (max-width: 30rem) {
      .rv-nombre { font-size: var(--fs-h3); }
      .rv-btns3 { grid-template-columns: minmax(0, 1fr); }
      .rv-actual { padding: var(--sp-3); }
    }
    @media (prefers-reduced-motion: reduce) { .rv-barra span { transition: none; } }
  `],
})
export class AlmacenRevisionPreventaComponent implements OnInit {
  private readonly api = inject(PresaleReviewService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly bandeja = signal<PresaleReviewInboxResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly anuncio = signal('');

  readonly abierto = signal<string | null>(null);
  readonly detalle = signal<PresaleReviewDetail | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly trabajando = signal(false);
  readonly progreso = signal<ProgresoPedido>({ marcas: {}, hist: [] });
  /** El − / + abierto sobre el producto actual. */
  readonly editando = signal<{ key: string; n: number } | null>(null);

  readonly porRevisar = computed<PresaleReviewInboxRow[]>(() => (this.bandeja()?.data ?? []).filter((p) => p.state === 'por_revisar'));
  readonly revisados = computed<PresaleReviewInboxRow[]>(() => (this.bandeja()?.data ?? []).filter((p) => p.state === 'revisado'));
  readonly metricas = computed<MetricStripItem[]>(() => {
    const pend = this.porRevisar();
    const conFalta = pend.filter((p) => p.pick_outcome === 'con_faltantes').length;
    const atrasados = pend.filter((p) => !!this.atraso(p)).length;
    return [
      { label: 'Por revisar', value: this.bandeja()?.pending ?? pend.length, format: 'number', tone: pend.length ? 'warn' : 'ok', sub: atrasados ? (atrasados === 1 ? '1 de días anteriores' : atrasados + ' de días anteriores') : pend.length ? 'antes de cobrar' : 'todo al día' },
      { label: 'Con faltantes', value: conFalta, format: 'number', tone: conFalta ? 'warn' : 'default', sub: 'el surtidor no tuvo todo' },
      { label: 'Revisados', value: this.revisados().length, format: 'number', sub: 'último día' },
    ];
  });
  readonly otros = computed(() => {
    const id = this.abierto();
    return this.porRevisar().filter((p) => p.order_id !== id);
  });
  readonly actual = computed<PresaleReviewLine | null>(() => {
    const d = this.detalle();
    const p = this.progreso();
    return d ? renglonActual(d.lines, p) : null;
  });
  readonly pct = computed(() => {
    const d = this.detalle();
    const p = this.progreso();
    return d && d.lines.length ? Math.round((resueltos(d.lines, p) / d.lines.length) * 100) : 0;
  });
  readonly numeroActual = computed(() => {
    const d = this.detalle();
    const p = this.progreso();
    return d ? Math.min(resueltos(d.lines, p) + 1, d.lines.length) : 0;
  });
  readonly faltantes = computed(() => {
    const d = this.detalle();
    const p = this.progreso();
    return d ? noHubo(d.lines, p) : [];
  });

  readonly resuelto = resuelto;
  readonly cantidadTexto = cantidadTexto;
  /** Sólo la unidad ("paquetes") para debajo del número grande del − / +. */
  unidadTexto(n: number, u: string): string { return cantidadTexto(n, u).split(" ").slice(1).join(" "); }

  ngOnInit(): void {
    this.cargar();
    encuestarVisible(REFRESCO_MS, () => this.cargar(true), { destroyRef: this.destroyRef, zone: this.zone });
    // `?pedido=<id>` abre el pedido; volver atrás en el navegador regresa a la lista.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const id = q.get('pedido');
      if (id && id !== this.abierto()) this.abrir(id, false);
      if (!id && this.abierto()) this.limpiarDetalle();
    });
  }

  cargar(silencioso = false): void {
    if (!silencioso) this.cargando.set(true);
    this.api.inbox().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        const antes = new Set((this.bandeja()?.data ?? []).map((r) => r.order_id));
        const nuevos = this.bandeja() ? b.data.filter((r) => r.state === 'por_revisar' && !antes.has(r.order_id)) : [];
        this.bandeja.set(b);
        this.cargadoEn.set(new Date());
        this.cargando.set(false);
        this.error.set(null);
        if (nuevos.length) {
          const t = nuevos.length === 1 ? `Llegó un pedido para revisar: ${nuevos[0].customer_name || nuevos[0].code}` : `Llegaron ${nuevos.length} pedidos para revisar`;
          this.toast.add({ severity: 'info', summary: t, life: 6000 });
          this.anuncio.set(t);
        }
      },
      error: (e) => { this.cargando.set(false); this.error.set(mensaje(e, 'No se pudo cargar la lista de pedidos.')); },
    });
  }

  abrir(orderId: string, navegar = true): void {
    if (navegar) { this.router.navigate([], { relativeTo: this.route, queryParams: { pedido: orderId } }); return; }
    this.abierto.set(orderId);
    this.detalle.set(null);
    this.editando.set(null);
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    this.api.detail(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.progreso.set(this.leerGuardado(d) ?? progresoInicial(d.lines));
        this.detalle.set(d);
        this.cargandoDetalle.set(false);
      },
      error: (e) => { this.cargandoDetalle.set(false); this.errorDetalle.set(mensaje(e, 'No se pudo abrir el pedido.')); },
    });
  }

  cerrarDetalle(): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: {} });
  }

  marca(l: PresaleReviewLine) { return this.progreso().marcas[l.key]; }
  estadoDe(l: PresaleReviewLine) { return this.progreso().marcas[l.key]?.estado ?? 'por_revisar'; }
  faltan(l: PresaleReviewLine): number { return +(l.ordered - (this.marca(l)?.vienen ?? l.picked)).toFixed(3); }
  sobran(l: PresaleReviewLine): number { return +((this.marca(l)?.vienen ?? l.picked) - l.ordered).toFixed(3); }

  hacer(l: PresaleReviewLine, a: Accion): void {
    this.cambiar(aplicar(this.progreso(), l, a));
    this.anunciarSiguiente();
  }

  contar(l: PresaleReviewLine): void {
    this.editando.set({ key: l.key, n: this.marca(l)?.vienen ?? l.picked });
  }

  mover(d: number): void {
    const e = this.editando();
    const l = this.actual();
    if (!e || !l) return;
    this.editando.set({ ...e, n: Math.max(0, +(e.n + d * pasoDe(l.unit)).toFixed(3)) });
  }

  guardarConteo(l: PresaleReviewLine): void {
    const e = this.editando();
    if (!e) return;
    this.editando.set(null);
    this.hacer(l, { tipo: 'contar', vienen: e.n });
  }

  anterior(): void {
    this.cambiar(deshacer(this.progreso()));
    this.anuncio.set('Regresaste al producto anterior.');
  }

  textoExistencia(l: PresaleReviewLine): string {
    const s = l.stock;
    if (!s || s.state === 'sin_dato') return 'No se pudo saber si hay en el sistema.';
    if (s.state === 'agotado') return 'El sistema dice que no hay.';
    if (s.state === 'no_se_maneja') return 'El sistema dice que esta sucursal no lo maneja.';
    return s.qty == null ? 'El sistema dice que sí hay.' : `El sistema dice que sí hay (${cantidadTexto(s.qty, l.unit)}).`;
  }

  textoRenglon(x: PresaleReviewLine): string {
    const m = this.marca(x);
    if (m?.estado === 'nohay') return `${m.vienen} de ${x.ordered} · no hubo`;
    return cantidadTexto(x.ordered, x.unit);
  }

  terminar(d: PresaleReviewDetail): void {
    let cuerpo;
    try {
      cuerpo = cuerpoDeCierre(d.lines, this.progreso());
    } catch (e) {
      this.toast.add({ severity: 'warn', summary: (e as Error).message, life: 6000 });
      return;
    }
    this.trabajando.set(true);
    this.api.finish(d.order.order_id, cuerpo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.trabajando.set(false);
        this.borrarGuardado(d.order.order_id);
        const cambio = r.review.total_after !== r.review.total_before;
        const t = cambio
          ? `${d.order.code} revisado. Total a cobrar: ${this.dinero(r.review.total_after)}`
          : `${d.order.code} revisado. Total a cobrar: ${this.dinero(r.review.total_after)} (sin cambios)`;
        this.toast.add({ severity: 'success', summary: t, life: 7000 });
        this.anuncio.set(t);
        const sig = this.otros()[0];
        this.cargar(true);
        if (sig) this.abrir(sig.order_id);
        else this.cerrarDetalle();
      },
      error: (e) => { this.trabajando.set(false); this.toast.add({ severity: 'error', summary: mensaje(e, 'No se pudo terminar la revisión.'), life: 8000 }); },
    });
  }

  /** «Sin revisar · hace N días» si el surtidor lo terminó antes de hoy; si es de hoy, nada. */
  atraso(p: PresaleReviewInboxRow): string | null {
    const hoy = this.bandeja()?.today;
    return hoy ? textoAtraso(diasSinRevisar(p.finished.at, hoy)) : null;
  }

  dinero(n: number | string | null | undefined): string { return pesos.format(Number(n) || 0); }
  horaDe(iso: string | null | undefined): string { return iso ? hora.format(new Date(iso)) : ''; }

  private cambiar(p: ProgresoPedido): void {
    this.progreso.set(p);
    const id = this.abierto();
    if (!id) return;
    try { localStorage.setItem(LLAVE + id, JSON.stringify(p)); } catch { /* sin almacenamiento: sólo se pierde al recargar */ }
  }

  private anunciarSiguiente(): void {
    const l = this.actual();
    this.anuncio.set(l ? `Ahora revisa: ${l.product_name}` : 'Pedido revisado. Ya puedes terminar.');
  }

  /** Lo guardado sólo vale si es del mismo pedido tal como está hoy (mismos renglones). */
  private leerGuardado(d: PresaleReviewDetail): ProgresoPedido | null {
    try {
      const raw = localStorage.getItem(LLAVE + d.order.order_id);
      if (!raw) return null;
      const p = JSON.parse(raw) as ProgresoPedido;
      const keys = d.lines.map((l) => l.key);
      return p?.marcas && keys.every((k) => p.marcas[k]) && Object.keys(p.marcas).length === keys.length ? p : null;
    } catch {
      return null;
    }
  }

  private borrarGuardado(orderId: string): void {
    try { localStorage.removeItem(LLAVE + orderId); } catch { /* nada que borrar */ }
  }

  private limpiarDetalle(): void {
    this.abierto.set(null);
    this.detalle.set(null);
    this.editando.set(null);
    this.progreso.set({ marcas: {}, hist: [] });
  }
}

function mensaje(e: unknown, def: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : m || def;
}
