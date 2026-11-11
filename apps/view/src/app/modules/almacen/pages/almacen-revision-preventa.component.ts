import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, NgZone, OnInit, afterNextRender, computed, inject, signal, viewChild,
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
  PresaleReviewSearchHit,
} from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { MOTIVOS_CAJA, MOTIVO_CAJA_POR_OMISION } from '@megadulces/contracts';
import { MotivoChipsComponent } from '../shared/motivo-chips.component';
import { JustificantesComponent } from '../shared/justificantes.component';
import { camposDeMotivo, motivoDe, motivosIncompletos, pidenMotivoEnCaja, type MotivoLinea } from '../shared/motivos-preventa';
import { PresaleReviewService } from '../presale-review.service';
import { agruparPorVendedor } from '../pedidos-por-vendedor';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import {
  type Accion,
  type ProgresoPedido,
  alEscanear,
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
  filtraLaLista,
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
 *
 * `[MCP.10.2]` (David, 2026-11-09): el surtidor acomoda el carrito por cómo es el producto (lo blando
 * arriba, lo duro abajo), no en el orden del pedido. Los demás productos de la lista se pueden TOCAR:
 * el que la cajera tiene en la mano pasa a revisarse. Sigue siendo uno a la vez y en grande.
 *
 * `[MCP.10.3]` (David, 2026-11-09): con lector, se ESCANEA lo que se tiene en la mano: si el renglón es de
 * una unidad, el escaneo ya lo confirma; si no, lo pone en grande; si no es del pedido, lo dice. Sin
 * lector (o un producto sin código) se toca en la lista, que ahora pone lo pendiente arriba.
 */
@Component({
  selector: 'app-almacen-revision-preventa',
  standalone: true,
  imports: [CommonModule, ToastModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, MotivoChipsComponent, JustificantesComponent],
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
          <!-- [MCP.14] Los pedidos a revisar separados por vendedor y, dentro, en orden de folio. -->
          <div class="rv-lista">
            @for (g of grupos(); track g.vendedor) {
              <h2 class="rv-grupo"><i class="pi pi-user" aria-hidden="true"></i> {{ g.vendedor }}
                <span class="rv-grupo-n">· {{ g.pedidos.length === 1 ? '1 pedido' : g.pedidos.length + ' pedidos' }}</span></h2>
            @for (p of g.pedidos; track p.order_id) {
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
            <!-- [MCP.18] Por qué cambió antes de llegar a caja: lo que corrigió la vendedora y lo que quitó el surtidor. -->
            <app-justificantes [items]="d.justifications" idBase="rv-jf"></app-justificantes>
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
              <!-- [MCP.10.3] El lector escribe aquí; también se escribe a mano: código, SKU o nombre. Si el campo
                   pierde el foco se dice: un escaneo perdido no avisa. -->
              <div class="rv-scan">
                <label class="rv-scan-l" for="rv-scan-in"><i class="pi pi-barcode" aria-hidden="true"></i> Escanea o escribe: código, SKU o nombre</label>
                <input #escaner id="rv-scan-in" class="rv-scan-in" type="text" inputmode="search" autocomplete="off" enterkeyhint="search"
                       (input)="alEscribir($event)" (keydown.enter)="alEnter($event)" (keydown.escape)="limpiarBusqueda()" />
                <label class="rv-scan-off" for="rv-scan-in">El lector no está listo: toca aquí antes de escanear.</label>
                @if (!hayCodigos()) {
                  <p class="rv-scan-sin"><i class="pi pi-info-circle" aria-hidden="true"></i> No se pudieron leer los códigos de Kepler de este pedido: busca por SKU o nombre, o tócalo en la lista.</p>
                }
                @if (avisoEscaneo(); as a) {
                  <p class="rv-scan-msg" [class.rv-scan-ok]="a.tono === 'ok'" [class.rv-scan-warn]="a.tono === 'warn'" [class.rv-scan-mal]="a.tono === 'mal'">
                    <i class="pi" [class.pi-check]="a.tono === 'ok'" [class.pi-times]="a.tono === 'mal'" [class.pi-info-circle]="a.tono === 'info' || a.tono === 'warn'" aria-hidden="true"></i>
                    <span>{{ a.texto }}</span>
                  </p>
                }
                <!-- [MCP.10.3] Lo que no es de este pedido se busca en los otros por revisar de la sucursal. -->
                @if (otrosPedidos(); as o) {
                  @if (o.estado === 'buscando') {
                    <p class="rv-scan-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>«{{ o.q }}» no está en este pedido. Buscando en los otros pedidos por revisar…</span></p>
                  } @else if (o.estado === 'error') {
                    <p class="rv-scan-msg rv-scan-warn"><i class="pi pi-info-circle" aria-hidden="true"></i><span>«{{ o.q }}» no está en este pedido y no pude buscar en los otros. Revisa la conexión e inténtalo otra vez.</span></p>
                  } @else if (!o.hits.length) {
                    <p class="rv-scan-msg rv-scan-mal"><i class="pi pi-times" aria-hidden="true"></i><span>«{{ o.q }}» no está en este pedido ni en los otros por revisar{{ o.truncated ? ' (busqué sólo en los primeros)' : '' }}. Apártalo.</span></p>
                  } @else {
                    <p class="rv-scan-msg rv-scan-warn"><i class="pi pi-info-circle" aria-hidden="true"></i><span>«{{ o.q }}» no es de este pedido. Está en {{ o.hits.length === 1 ? 'este otro' : 'estos ' + o.hits.length }}:</span></p>
                    <ul class="rv-hits">
                      @for (h of o.hits; track h.order_id + '|' + h.product_name) {
                        <li>
                          <button type="button" class="rv-hit" (click)="abrirDesdeBusqueda(h)">
                            <span class="rv-hit-n">{{ h.customer_name || h.code }}<small>{{ h.code }}{{ h.seller_name ? ' · ' + h.seller_name : '' }} · {{ h.product_name }}</small></span>
                            <span class="rv-hit-go">Abrir <i class="pi pi-arrow-right" aria-hidden="true"></i></span>
                          </button>
                        </li>
                      }
                    </ul>
                    @if (o.truncated) { <p class="rv-scan-sin">Hay más coincidencias: escribe más del nombre para acotar.</p> }
                  }
                }
              </div>
              @if (progreso().hist.length && !editando()) {
                <button type="button" class="rv-btn rv-btn-atras" (click)="anterior()"><i class="pi pi-arrow-left" aria-hidden="true"></i> Anterior</button>
              }

              @if (actual(); as l) {
                @if (editando()) {
                  <section tabindex="-1" class="rv-actual" aria-live="polite">
                    <span class="rv-flecha">▶ REVISANDO · CONTAR</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    @if (l.sku) { <span class="rv-sku">SKU {{ l.sku }}</span> }
                    @if (l.substitutes_for) { <span class="rv-en-lugar"><i class="pi pi-sync" aria-hidden="true"></i> En lugar de {{ l.substitutes_for }} · lo cambió el surtidor</span> }
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
                  <section tabindex="-1" class="rv-actual">
                    <span class="rv-flecha">▶ REVISANDO</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    @if (l.sku) { <span class="rv-sku">SKU {{ l.sku }}</span> }
                    @if (l.substitutes_for) { <span class="rv-en-lugar"><i class="pi pi-sync" aria-hidden="true"></i> En lugar de {{ l.substitutes_for }} · lo cambió el surtidor</span> }
                    <span class="rv-cant">Deben ser <span class="rv-mono">{{ cantidadTexto(l.ordered, l.unit) }}</span></span>
                    <button type="button" class="rv-btn rv-btn-ok" (click)="hacer(l, { tipo: 'bien' })">Está bien <i class="pi pi-check" aria-hidden="true"></i></button>
                    <button type="button" class="rv-btn" (click)="contar(l)">No coincide</button>
                  </section>
                } @else if (estadoDe(l) === 'falta') {
                  <section tabindex="-1" class="rv-actual rv-actual-falta">
                    <span class="rv-flecha">▶ REVISANDO · FALTÓ{{ marca(l)?.despues ? ' · SIGUE ESPERANDO' : '' }}</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    @if (l.sku) { <span class="rv-sku">SKU {{ l.sku }}</span> }
                    @if (l.substitutes_for) { <span class="rv-en-lugar"><i class="pi pi-sync" aria-hidden="true"></i> En lugar de {{ l.substitutes_for }} · lo cambió el surtidor</span> }
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
                  <section tabindex="-1" class="rv-actual rv-actual-sobra">
                    <span class="rv-flecha">▶ REVISANDO · VINO DE MÁS</span>
                    <span class="rv-nombre">{{ l.product_name }}</span>
                    @if (l.sku) { <span class="rv-sku">SKU {{ l.sku }}</span> }
                    @if (l.substitutes_for) { <span class="rv-en-lugar"><i class="pi pi-sync" aria-hidden="true"></i> En lugar de {{ l.substitutes_for }} · lo cambió el surtidor</span> }
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
                  <!-- [MCP.18] Lo que la CAJA deja por debajo de lo surtido lleva su porqué (ya viene «No venía en el carrito»). -->
                  @for (l of pidenMotivo(); track l.key) {
                    <div class="rv-motivo">
                      <b>{{ l.product_name }}</b>
                      <app-motivo-chips [opciones]="motivosCaja" [valor]="motivoDeLinea(l.key)" [idBase]="'rv-mot-' + $index"
                                        [etiqueta]="'Por qué no se cobra todo de ' + l.product_name" (cambio)="ponerMotivo(l.key, $event)"></app-motivo-chips>
                    </div>
                  }
                  <button type="button" class="rv-btn rv-btn-ok" [disabled]="trabajando() || motivosSinCompletar().length > 0" (click)="terminar(d)">
                    @if (trabajando()) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> }
                    Terminar y seguir con el siguiente
                  </button>
                </div>
              }

              <!-- [MCP.10.2] Lo que falta revisar se toca: el carrito no viene en el orden del pedido. -->
              <!-- [MCP.10.3] Pendientes arriba y lo revisado aparte: menos que leer y menos que bajar. -->
              @if (pendientesTotal() > 0) {
                <h2 class="rv-items-h">Por revisar · {{ filtrando() ? pendientesOtros().length + ' de ' + pendientesTotal() : pendientesTotal() }}</h2>
                @if (filtrando()) {
                  <p class="rv-items-tip">
                    {{ pendientesOtros().length ? 'Coinciden con «' + filtro().trim() + '».' : 'Ninguno de los que faltan coincide con «' + filtro().trim() + '»: presiona Enter para buscarlo en los otros pedidos.' }}
                    <button type="button" class="rv-limpiar" (click)="limpiarBusqueda()">Ver todos</button>
                  </p>
                } @else {
                  <p class="rv-items-tip">¿Tienes otro en la mano? Escanéalo o escríbelo arriba, o tócalo aquí.</p>
                }
                <ul class="rv-items">
                  @for (x of pendientesOtros(); track x.key) {
                    <li>
                      <button type="button" class="rv-item rv-item-tocar" (click)="elegir(x)">
                        <ng-container *ngTemplateOutlet="renglon; context: { $implicit: x }"></ng-container>
                        <i class="pi pi-chevron-right" aria-hidden="true"></i>
                      </button>
                    </li>
                  }
                </ul>
              }
              @if (revisadosLista().length) {
                <h2 class="rv-items-h">Ya revisados · {{ revisadosLista().length }}</h2>
                <ul class="rv-items">
                  @for (x of revisadosLista(); track x.key) {
                    <li class="rv-item" [class.rv-item-ok]="estadoDe(x) !== 'nohay'" [class.rv-item-no]="estadoDe(x) === 'nohay'">
                      <ng-container *ngTemplateOutlet="renglon; context: { $implicit: x }"></ng-container>
                    </li>
                  }
                </ul>
              }
              <ng-template #renglon let-x>
                <span class="rv-item-n">
                  @if (estadoDe(x) === 'nohay') { <i class="pi pi-times" aria-hidden="true"></i> }
                  @else if (resuelto(marca(x))) { <i class="pi pi-check" aria-hidden="true"></i> }
                  {{ x.product_name }}{{ marca(x)?.despues && !resuelto(marca(x)) ? ' · esperando al surtidor' : '' }}
                  @if (x.sku) { <span class="rv-sku">SKU {{ x.sku }}</span> }
                  @if (x.substitutes_for) { <span class="rv-en-lugar"><i class="pi pi-sync" aria-hidden="true"></i> En lugar de {{ x.substitutes_for }}</span> }
                </span>
                <span class="rv-mono">{{ textoRenglon(x) }}</span>
              </ng-template>
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
    /* [MCP.14] El vendedor encabeza su grupo de pedidos. */
    .rv-grupo { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0 0; font-size: var(--fs-lg); font-weight: 800; color: var(--text-main); }
    .rv-grupo:first-child { margin-top: 0; }
    .rv-grupo-n { font-weight: 500; color: var(--text-muted); }
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
    .rv-actual { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); border: 4px solid var(--info-fg);
      border-radius: var(--r-xl); background: var(--info-soft-bg); margin-bottom: var(--sp-3); }
    .rv-actual-falta { border-color: var(--warn-fg); background: var(--warn-soft-bg); }
    .rv-actual-sobra { border-color: var(--action); background: var(--card-bg); }
    .rv-flecha { font-size: var(--fs-body); font-weight: 800; letter-spacing: .02em; color: var(--info-fg); }
    .rv-actual-falta .rv-flecha { color: var(--warn-fg); }
    .rv-actual-sobra .rv-flecha { color: var(--action); }
    .rv-nombre { font-size: var(--fs-h2); font-weight: 800; line-height: 1.2; }
    /* [VTK.15] El SKU siempre a la vista: con él se busca en Kepler al cobrar. */
    .rv-sku { display: block; font-family: var(--font-mono); font-size: var(--fs-body); font-weight: 600; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .rv-item .rv-sku { font-size: var(--fs-sm); font-weight: 500; }
    /* [MCP.13] El surtidor puso este producto en lugar de otro que no hubo. */
    .rv-en-lugar { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 700; color: var(--info-fg); }
    .rv-cant, .rv-pregunta { font-size: var(--fs-h3); font-weight: 700; }
    .rv-falta { font-size: var(--fs-lg); font-weight: 800; color: var(--warn-fg); }
    .rv-sobra { font-size: var(--fs-lg); font-weight: 800; color: var(--action); }
    .rv-hay { font-size: var(--fs-body); font-weight: 700; color: var(--ok-fg); }
    .rv-hay-no { color: var(--text-muted); }
    .rv-espera { font-size: var(--fs-lg); font-weight: 800; color: var(--text-main); }
    .rv-btn { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: 3.5rem; width: 100%;
      padding: 0 var(--sp-4); border-radius: var(--r-lg); border: 2px solid var(--border-color); background: var(--card-bg);
      color: var(--text-main); font-size: var(--fs-lg); font-weight: 800; cursor: pointer; }
    .rv-btn:focus-visible, .rv-card:focus-visible, .rv-pill:focus-visible, .rv-volver:focus-visible, .rv-paso button:focus-visible, .rv-item-tocar:focus-visible {
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
    /* [MCP.18] El porqué de lo que la caja no cobra, uno por producto. */
    .rv-motivo { align-self: stretch; text-align: left; padding-top: var(--sp-2); border-top: 1px solid var(--border-color); }
    .rv-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .rv-item { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-md); border: 1px solid var(--border-color); color: var(--text-muted); font-size: var(--fs-body); }
    .rv-item-n { flex: 1; min-width: 0; }
    .rv-item-ok { border-color: transparent; background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .rv-item-no { border-color: transparent; background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    /* [MCP.10.2] Lo que falta revisar es un botón: se toca el que se tiene en la mano. */
    .rv-items-tip { margin: 0 0 var(--sp-2); font-size: var(--fs-body); font-weight: 700; color: var(--text-main); }
    .rv-item-tocar { width: 100%; min-height: var(--tap-min); text-align: left; cursor: pointer; border-width: 2px;
      background: var(--card-bg); color: var(--text-main); font-family: inherit; }
    .rv-item-tocar:hover { background: var(--surface-hover); }
    .rv-item-tocar .pi-chevron-right { color: var(--text-muted); }
    .rv-actual { scroll-margin-top: var(--sp-6); }
    .rv-items-h { margin: var(--sp-4) 0 var(--sp-1); font-size: var(--fs-lg); font-weight: 800; color: var(--text-main); }
    /* [MCP.10.3] El campo del lector. Sin foco se pone ámbar y lo dice: el escáner escribiría en ningún lado. */
    .rv-scan { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-3); scroll-margin-top: var(--sp-6); }
    .rv-scan-l { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-body); font-weight: 700; color: var(--text-main); }
    .rv-scan-in { min-height: var(--tap-min); padding: 0 var(--sp-3); border: 2px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--text-main); font-family: var(--font-mono); font-size: var(--fs-lg); }
    /* Sin el anillo naranja global de los campos (David, 2026-11-09): el foco del lector se marca con el borde
       oscuro, por dentro. El foco sigue a la vista (pre-vuelo 6), sólo que sin sombra alrededor. */
    .rv-scan-in:focus { outline: none !important; }
    .rv-scan-in:focus-visible { border-color: var(--text-main); box-shadow: inset 0 0 0 1px var(--text-main); }
    .rv-scan-off { display: none; font-size: var(--fs-body); font-weight: 700; color: var(--warn-fg); cursor: pointer; }
    .rv-scan:not(:focus-within) .rv-scan-off { display: block; }
    .rv-scan:not(:focus-within) .rv-scan-in { border-color: var(--warn-fg); }
    .rv-scan-msg { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-lg); font-weight: 800; color: var(--text-main); }
    .rv-scan-ok { color: var(--ok-fg); }
    .rv-scan-warn { color: var(--warn-fg); }
    .rv-scan-mal { color: var(--bad-fg); }
    .rv-scan-sin { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-body); color: var(--text-muted); }
    /* En celular no hay lector que se pierda: ahí el campo es un buscador y no se le exige el foco. */
    @media (pointer: coarse) {
      .rv-scan:not(:focus-within) .rv-scan-off { display: none; }
      .rv-scan:not(:focus-within) .rv-scan-in { border-color: var(--border-color); }
    }
    .rv-hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .rv-hit { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); width: 100%; min-height: var(--tap-min);
      padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer; border: 2px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--text-main); font-family: inherit; font-size: var(--fs-body); }
    .rv-hit:hover { background: var(--surface-hover); }
    .rv-hit:focus-visible, .rv-limpiar:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    .rv-hit-n { flex: 1; min-width: 0; font-weight: 800; }
    .rv-hit-n small { display: block; font-weight: 500; color: var(--text-muted); }
    .rv-hit-go { font-weight: 800; color: var(--action); white-space: nowrap; }
    .rv-limpiar { margin-left: var(--sp-2); min-height: var(--tap-min); padding: 0 var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-pill); background: var(--card-bg); color: var(--text-main); font-family: inherit; font-size: var(--fs-body); font-weight: 700; cursor: pointer; }
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly escanerInput = viewChild<ElementRef<HTMLInputElement>>('escaner');

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
  /** `[MCP.10.2]` El producto que la cajera tocó en la lista; `null` = el que sigue en el pedido. */
  readonly elegido = signal<string | null>(null);
  /** `[MCP.10.3]` Qué pasó con el último escaneo, junto al campo del lector. */
  readonly avisoEscaneo = signal<{ tono: 'ok' | 'info' | 'warn' | 'mal'; texto: string } | null>(null);
  /** `[MCP.10.3]` Lo que se va escribiendo en el buscador (filtra «Por revisar»). */
  readonly filtro = signal('');
  /** `[MCP.10.3]` Lo que no es de este pedido, buscado en los otros por revisar de la sucursal. */
  readonly otrosPedidos = signal<{ estado: 'buscando' | 'listo' | 'error'; q: string; hits: PresaleReviewSearchHit[]; truncated: boolean } | null>(null);
  /** `[MCP.10.3]` Al abrir desde «está en otro pedido», lo que hay que volver a buscar ahí. */
  private buscarAlAbrir: string | null = null;

  readonly porRevisar = computed<PresaleReviewInboxRow[]>(() => (this.bandeja()?.data ?? []).filter((p) => p.state === 'por_revisar'));
  readonly revisados = computed<PresaleReviewInboxRow[]>(() => (this.bandeja()?.data ?? []).filter((p) => p.state === 'revisado'));
  /** `[MCP.14]` Por vendedor (el que el surtidor terminó primero arriba) y en orden de folio. */
  readonly grupos = computed(() => agruparPorVendedor(this.porRevisar(), (p) => p.finished?.at));
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
    const e = this.elegido();
    return d ? renglonActual(d.lines, p, e) : null;
  });
  /** `[MCP.10.2]` Lo que falta revisar además del que está en grande: se puede tocar. */
  readonly pendientesTodos = computed<PresaleReviewLine[]>(() => {
    const d = this.detalle();
    const p = this.progreso();
    const a = this.actual();
    return d ? d.lines.filter((l) => l.key !== a?.key && !resuelto(p.marcas[l.key])) : [];
  });
  readonly pendientesTotal = computed(() => this.pendientesTodos().length);
  /** `[MCP.10.3]` ¿Lo escrito está filtrando la lista? Si sí, la lista lo DICE («2 de 9»), no se ve como si fueran todos. */
  readonly filtrando = computed(() => filtraLaLista(this.filtro()));
  /** `[MCP.10.3]` Lo pendiente que coincide con lo escrito (código, SKU o nombre, con el buscador compartido). */
  readonly pendientesOtros = computed<PresaleReviewLine[]>(() => {
    const todos = this.pendientesTodos();
    const f = this.filtro();
    return filtraLaLista(f) ? todos.filter((l) => coincideBusqueda(f, l.product_name, l.sku)) : todos;
  });
  /** `[MCP.10.3]` Lo ya revisado va aparte, abajo: no estorba al buscar lo que falta. */
  readonly revisadosLista = computed<PresaleReviewLine[]>(() => {
    const d = this.detalle();
    const p = this.progreso();
    return d ? d.lines.filter((l) => resuelto(p.marcas[l.key])) : [];
  });
  /** `[MCP.10.3]` ¿Llegaron los códigos de Kepler? Si no, se DECLARA y se revisa tocando en la lista. */
  readonly hayCodigos = computed(() => (this.detalle()?.lines ?? []).some((l) => l.codes !== undefined));
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
  /** `[MCP.18]` El motivo elegido por renglón que la caja deja con menos; sin tocar = «No venía en el carrito». */
  readonly motivosLinea = signal<Record<string, MotivoLinea>>({});
  readonly motivosCaja = MOTIVOS_CAJA;
  /** `[MCP.18]` Sólo lo que la CAJA deja por debajo de lo surtido pide motivo (lo del surtido ya trae el suyo). */
  readonly pidenMotivo = computed(() => {
    const d = this.detalle();
    const p = this.progreso();
    return d ? pidenMotivoEnCaja(d.lines, p) : [];
  });
  readonly motivosSinCompletar = computed(() => {
    const m = this.motivosLinea();
    return motivosIncompletos(m, this.pidenMotivo().map((l) => l.key), MOTIVOS_CAJA, MOTIVO_CAJA_POR_OMISION);
  });

  motivoDeLinea(key: string): MotivoLinea {
    return motivoDe(this.motivosLinea(), key, MOTIVO_CAJA_POR_OMISION);
  }

  ponerMotivo(key: string, m: MotivoLinea): void {
    this.motivosLinea.update((x) => ({ ...x, [key]: m }));
  }

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
    // [MCP.18] Las llaves «borrado:N» se repiten entre pedidos: los motivos son de UN pedido.
    this.motivosLinea.set({});
    this.editando.set(null);
    this.elegido.set(null);
    this.avisoEscaneo.set(null);
    this.otrosPedidos.set(null);
    this.filtro.set('');
    const campo = this.escanerInput()?.nativeElement;
    if (campo) campo.value = '';
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    this.api.detail(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.progreso.set(this.leerGuardado(d) ?? progresoInicial(d.lines));
        this.detalle.set(d);
        this.cargandoDetalle.set(false);
        this.listoParaEscanear();
        // [MCP.10.3] Se abrió desde «está en otro pedido»: se vuelve a buscar aquí lo mismo.
        const q = this.buscarAlAbrir;
        this.buscarAlAbrir = null;
        if (q) this.escanear(q);
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
    // [MCP.10.2] Lo tocado se suelta al resolverlo o al dejarlo esperando: sigue el primero pendiente.
    if (a.tipo === 'despues' || resuelto(this.progreso().marcas[l.key])) this.elegido.set(null);
    this.anunciarSiguiente();
    // [MCP.10.3] El botón tocado se lleva el foco: se le regresa al lector para el siguiente escaneo.
    this.listoParaEscanear();
  }

  /** `[MCP.10.3]` Lo que se va escribiendo filtra «Por revisar» (salvo la ráfaga de dígitos del lector). */
  alEscribir(ev: Event): void {
    this.filtro.set((ev.target as HTMLInputElement).value);
  }

  /** `[MCP.10.3]` «Ver todos» o Esc: vacía el buscador y quita lo encontrado en otros pedidos. */
  limpiarBusqueda(): void {
    const campo = this.escanerInput()?.nativeElement;
    if (campo) campo.value = '';
    this.filtro.set('');
    this.otrosPedidos.set(null);
    this.listoParaEscanear();
  }

  /**
   * `[MCP.10.3]` Enter (el lector lo manda solo). El campo se limpia al instante para el siguiente escaneo,
   * salvo cuando lo escrito es un nombre con varias coincidencias: ahí se queda para que la lista las muestre.
   */
  alEnter(ev: Event): void {
    ev.preventDefault();
    const campo = ev.target as HTMLInputElement;
    if (this.escanear(campo.value)) {
      campo.value = '';
      this.filtro.set('');
    }
  }

  /**
   * `[MCP.10.3]` Lo escaneado o escrito: confirma, señala, avisa o lo busca en los otros pedidos. Nunca cambia
   * nada que no sea de este pedido. Devuelve si el campo se debe limpiar.
   */
  escanear(texto: string): boolean {
    const d = this.detalle();
    if (!d || d.order.state === 'revisado') return true;
    const q = String(texto ?? '').trim();
    const { escaneo, progreso } = alEscanear(d.lines, this.progreso(), q);
    if (escaneo.tipo === 'vacio') return true;
    this.editando.set(null);
    this.otrosPedidos.set(null);
    let aviso: { tono: 'ok' | 'info' | 'warn' | 'mal'; texto: string };
    let limpiar = true;
    switch (escaneo.tipo) {
      case 'confirmado':
        this.cambiar(progreso);
        this.elegido.set(null);
        aviso = { tono: 'ok', texto: `${escaneo.line.product_name} · bien` };
        break;
      case 'elegido':
        this.elegido.set(escaneo.line.key);
        aviso = { tono: 'info', texto: `${escaneo.line.product_name}: revísalo aquí abajo.` };
        break;
      case 'ya_revisado':
        aviso = { tono: 'warn', texto: `${escaneo.line.product_name} ya lo revisaste.` };
        break;
      case 'varios':
        if (escaneo.match === 'nombre') {
          limpiar = false;
          aviso = { tono: 'warn', texto: `${escaneo.lines.length} productos coinciden con «${q}»: toca el correcto en la lista.` };
        } else {
          aviso = { tono: 'warn', texto: `«${q}» es de ${escaneo.lines.length} productos de este pedido: toca el correcto en la lista.` };
        }
        break;
      case 'no_es':
        this.avisoEscaneo.set(null);
        this.buscarEnOtros(q);
        this.enfocarActual();
        return true;
      default:
        return true;
    }
    this.avisoEscaneo.set(aviso);
    this.anuncio.set(aviso.texto);
    this.enfocarActual();
    return limpiar;
  }

  /** `[MCP.10.3]` Lo abre y vuelve a buscar ahí lo mismo, para que quede señalado sin escanear otra vez. */
  abrirDesdeBusqueda(h: PresaleReviewSearchHit): void {
    this.buscarAlAbrir = this.otrosPedidos()?.q ?? null;
    this.abrir(h.order_id);
  }

  /** `[MCP.10.3]` ¿En qué otro pedido por revisar está? Una respuesta tardía de otro pedido no se pinta. */
  private buscarEnOtros(q: string): void {
    const desde = this.abierto();
    this.otrosPedidos.set({ estado: 'buscando', q, hits: [], truncated: false });
    this.anuncio.set(`«${q}» no está en este pedido. Buscando en los otros pedidos por revisar.`);
    this.api.search(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (this.abierto() !== desde) return;
        const hits = r.data.filter((h) => h.order_id !== desde);
        this.otrosPedidos.set({ estado: 'listo', q, hits, truncated: r.truncated });
        this.anuncio.set(hits.length ? `«${q}» está en otro pedido: ${hits.map((h) => h.customer_name || h.code).join(', ')}.` : `«${q}» no está en ningún pedido por revisar.`);
      },
      error: () => {
        if (this.abierto() !== desde) return;
        this.otrosPedidos.set({ estado: 'error', q, hits: [], truncated: false });
      },
    });
  }

  /** `[MCP.10.2]` La cajera toca en la lista el producto que tiene en la mano: ése se revisa ahora. */
  elegir(x: PresaleReviewLine): void {
    if (resuelto(this.marca(x))) return;
    this.editando.set(null);
    this.elegido.set(x.key);
    this.anuncio.set(`Ahora revisa: ${x.product_name}`);
    this.enfocarActual();
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
    const hist = this.progreso().hist;
    const ultimo = hist[hist.length - 1]?.key ?? null;
    this.cambiar(deshacer(this.progreso()));
    // [MCP.10.2] Regresa a ESE producto, aunque antes en la lista haya otros pendientes.
    this.elegido.set(ultimo);
    this.anuncio.set('Regresaste al producto anterior.');
    this.listoParaEscanear();
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
    // [MCP.18] El justificante va sólo en lo que la caja deja por debajo de lo surtido.
    const conMotivo = new Set(this.pidenMotivo().map((l) => l.key));
    cuerpo = { lines: cuerpo.lines.map((x) => (conMotivo.has(x.key) ? { ...x, ...camposDeMotivo(this.motivoDeLinea(x.key)) } : x)) };
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

  /**
   * `[MCP.10.2]` Tras tocar uno de abajo de la lista, el producto en grande queda arriba, fuera de la
   * vista en un pedido largo: se lleva la vista y el foco ahí (el botón tocado ya no existe).
   */
  private enfocarActual(): void {
    afterNextRender(() => {
      const raiz = this.host.nativeElement;
      // [MCP.10.3] Con lector, arriba queda el campo (con el aviso del escaneo) y debajo el producto en grande.
      (raiz.querySelector<HTMLElement>('.rv-scan') ?? raiz.querySelector<HTMLElement>('.rv-actual'))?.scrollIntoView?.({ block: 'start' });
      this.enfocarLector(raiz);
    }, { injector: this.injector });
  }

  /** `[MCP.10.3]` Deja el foco en el campo del lector, sin mover la vista. */
  private listoParaEscanear(): void {
    afterNextRender(() => this.enfocarLector(this.host.nativeElement), { injector: this.injector });
  }

  private enfocarLector(raiz: HTMLElement): void {
    // En celular (dedo, sin lector) no se le da el foco al campo: abriría el teclado en cada toque.
    const tactil = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const campo = this.escanerInput()?.nativeElement;
    if (campo && !tactil) campo.focus({ preventScroll: true });
    else raiz.querySelector<HTMLElement>('.rv-actual')?.focus({ preventScroll: true });
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
    this.elegido.set(null);
    this.avisoEscaneo.set(null);
    this.otrosPedidos.set(null);
    this.filtro.set('');
    this.buscarAlAbrir = null;
    this.progreso.set({ marcas: {}, hist: [] });
    this.motivosLinea.set({});
  }
}

function mensaje(e: unknown, def: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : m || def;
}
