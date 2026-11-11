import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { PresaleSellerOrder, PresaleSellerStatusResponse, SellerDayRecap } from '@megadulces/contracts';
import { MOTIVOS_CAJA, MOTIVOS_CANCELAR, MOTIVOS_CORREGIR, MOTIVOS_SURTIDO, MOTIVO_SURTIDO_POR_OMISION, textoDeJustificante, textoDeMotivo, type MotivoElegido } from '@megadulces/contracts';
import { ConfirmationService, MessageService } from 'primeng/api';
import { VendorMotivoSheetComponent } from '../components/vendor-motivo-sheet.component';
import { RouteDayService } from '../route-day.service';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { PresaleStatusService } from '../presale-status.service';
import { VendorService } from '../vendor.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { articulosDelPedido, enOrdenDeCaptura, filtrarPedidos, type Articulo, type FiltroMisPedidos, type LineaDelPedido } from '../articulos-pedido';
import { ajustar, cambiosDe, cuentaDe, deshacer, motivoSugerido, quitar, renglonEditable, type Edicion, type RenglonEditable } from '../editar-pedido';
import { diasALaMano, esDia, hoyMx, nombreCorto as diaCorto, nombreLargo, sinVerFuera } from '../mis-pedidos-dia';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { VendorMisCotizacionesComponent } from './vendor-mis-cotizaciones.component';
import { VendorRecuentoDiaComponent } from '../components/recuento-dia.component';
import { OfflineOrderService, type PendingOrderSummary } from '../../../core/services/offline-order.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/** `[MCP.16]` Qué pestaña se ve; la dice la URL (`?ver=cotizaciones`). Cualquier otra cosa = pedidos. */
type VistaPedidos = 'pedidos' | 'cotizaciones';
const vistaDe = (v: string | null | undefined): VistaPedidos => (v === 'cotizaciones' ? 'cotizaciones' : 'pedidos');

/** Cada cuánto se vuelve a pedir mientras la pantalla se está viendo. */
const REFRESCO_MS = 30_000;
/** `[MCP.19]` El recuento lee también visitas y GPS: cada 4 vueltas de la lista (2 min), no cada una. */
const VUELTAS_POR_RECUENTO = 4;

type Paso = { titulo: string; detalle: string; estado: 'hecho' | 'aviso' | 'ahora' | 'pendiente' };

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[MCP.8]` **Mis pedidos**: la vendedora ve por pedido si ya lo tomó el surtidor (con su nombre
 * y la hora en que empezó), si se surtió completo o con faltantes (y el reporte: lo que se quitó
 * y el nuevo total), si Kepler ya lo cobró y si se entregó.
 *
 * «Cobrado» viene de la liga confirmada o de una DETECCIÓN (un solo ticket del cliente, posterior
 * al surtido, con los mismos productos). Las dos se distinguen en pantalla: la detección no es la
 * liga (D2/D6 de la Fase MCP), así que no se presenta como hecho confirmado.
 */
@Component({
  selector: 'app-vendor-mis-pedidos',
  standalone: true,
  imports: [CommonModule, RouterLink, ConfirmDialogModule, VendorMisCotizacionesComponent, VendorRecuentoDiaComponent, VendorMotivoSheetComponent],
  providers: [ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-confirmdialog></p-confirmdialog>
    <!-- [MCP.21] Los motivos de corregir y cancelar (MCP.18: obligatorios), sin salir de «Pedidos». -->
    @if (guardando(); as g) {
      <app-vendor-motivo-sheet [titulo]="g.agregar ? '¿Por qué lo modificas?' : '¿Por qué cambian los productos?'"
        [sub]="g.p.code + ' · ' + (g.p.customer_name || 'Cliente') + (g.agregar
          ? ' · se abre «Tomar pedido» con este pedido para que agregues y lo vuelvas a agendar'
          : ' · se guarda todo junto y sigue agendado')"
        [opciones]="motivosCorregir" [inicial]="g.sugerido" [confirmarTexto]="g.agregar ? 'Seguir y agregar' : 'Guardar cambios'"
        [busy]="guardandoMotivo()" (confirm)="confirmarGuardar(g.p, g.agregar, $event)" (cancel)="guardando.set(null)"></app-vendor-motivo-sheet>
    }
    @if (cancelando(); as c) {
      <app-vendor-motivo-sheet titulo="¿Por qué lo cancelas?"
        [sub]="c.code + ' · ' + (c.customer_name || 'Cliente') + ' · ' + dinero(c.total) + ' · no se surte ni se cobra'"
        [opciones]="motivosCancelar" confirmarTexto="Cancelar el pedido" [busy]="guardandoMotivo()"
        (confirm)="confirmarCancelar(c, $event)" (cancel)="cancelando.set(null)"></app-vendor-motivo-sheet>
    }
    <section class="mp">
      <!-- [MCP.16] Pedidos | Cotizaciones: la cotización tiene su lugar a la vista (antes, sólo un chip dentro de «Tomar pedido»). -->
      <div class="mp-seg" role="group" aria-label="Ver pedidos o cotizaciones">
        <button type="button" [class.on]="ver() === 'pedidos'" [attr.aria-pressed]="ver() === 'pedidos'" (click)="verVista('pedidos')">Pedidos</button>
        <button type="button" [class.on]="ver() === 'cotizaciones'" [attr.aria-pressed]="ver() === 'cotizaciones'" (click)="verVista('cotizaciones')">Cotizaciones</button>
      </div>
      @if (ver() === 'cotizaciones') {
        <app-vendor-mis-cotizaciones />
      } @else {
      <header class="mp-head">
        <div>
          <h1>Mis pedidos</h1>
          <span class="mp-sub">Se actualiza solo{{ cargadoEn() ? ' · ' + horaDe(cargadoEn()!) : '' }}</span>
        </div>
        <button type="button" class="mp-ref" (click)="actualizar()" [disabled]="cargando()" aria-label="Actualizar">
          <i class="pi pi-refresh" [class.pi-spin]="cargando()" aria-hidden="true"></i>
        </button>
      </header>

      <!-- [MCP.19] Lo que se quedó en el celular va primero: el surtidor no lo ve hasta que se envía. (Antes vivía en «Mi día».) -->
      @if (pendingOffline().length) {
        <div class="mp-cola" role="status">
          <b><i class="pi pi-cloud-upload" aria-hidden="true"></i> Sin enviar · {{ pendingOffline().length }}</b>
          <small>Están en tu celular: el surtidor no los ve hasta que se envíen.</small>
          @for (q of pendingOffline(); track q.id) {
            <div class="mp-cola-f">
              <span>{{ q.customerName }}<small>{{ q.units }} u · {{ dinero(q.total) }} · {{ q.dead ? 'no se pudo enviar' : 'en cola, se envía solo con señal' }}</small></span>
              @if (q.dead) {
                <button type="button" (click)="reintentarPendiente(q)">Reintentar</button>
                <button type="button" class="mp-cola-x" (click)="descartarPendiente(q)" [attr.aria-label]="'Descartar el pedido de ' + q.customerName"><i class="pi pi-trash" aria-hidden="true"></i></button>
              }
            </div>
          }
        </div>
      }

      <!-- [MCP.20] Un día a la vez: hoy por omisión, la semana a un toque y cualquier otro en el calendario.
           El recuento y la lista de abajo son del día elegido (antes la lista juntaba todo lo agendado de cualquier fecha). -->
      <div class="mp-dias" role="group" aria-label="Qué día ver">
        @for (d of dias(); track d.fecha) {
          <button type="button" class="mp-f mp-dia" [class.on]="dia() === d.fecha" [attr.aria-pressed]="dia() === d.fecha"
                  [attr.aria-label]="d.texto + (d.nuevo ? ', con un reporte de surtido nuevo' : '')" (click)="elegirDia(d.fecha)">
            {{ d.texto }}@if (d.nuevo) {<span class="mp-dia-nuevo" aria-hidden="true"></span>}
          </button>
        }
        <button type="button" class="mp-f mp-dia" (click)="abrirCalendario(cal)">
          <i class="pi pi-calendar" aria-hidden="true"></i> Otro día
        </button>
        <input #cal type="date" class="mp-cal-in" [class.ver]="calVisible()" [max]="hoy()" [value]="dia()"
               [attr.tabindex]="calVisible() ? null : -1" aria-label="Elegir otro día" (change)="elegirDia($any($event.target).value)" />
      </div>
      @if (sinVerViejos().length) {
        <p class="mp-nota mp-aviso" role="status">
          Tienes reportes de surtido nuevos de
          @for (f of sinVerViejos(); track f; let ult = $last) {
            <button type="button" class="mp-art-re" (click)="elegirDia(f)">{{ diaCorto(f, hoy()) }}</button>{{ ult ? '.' : ',' }}
          }
        </p>
      }

      <!-- [MCP.19] El recuento del día: cómo te fue, qué pasó con lo que levantaste y qué te quedó pendiente. -->
      <app-vendor-recuento-dia
        [recuento]="recuento()" [estado]="recuentoEstado()" [error]="recuentoError()" [cargadoEn]="recuentoEn()"
        [pedidosAbribles]="true" [compacto]="true" (reintentar)="cargarRecuento()" (abrirPedido)="verPedido($event)" (abrirBorrador)="irABorrador($event)" />
      @if (avisoLista()) { <p class="mp-nota mp-aviso" role="status">{{ avisoLista() }}</p> }

      <!-- [MCP.21] Las dos acciones del día en una fila (antes, dos tarjetas con subtítulo).
           Terminar el día donde ya lo está revisando (en 30 días se finalizaron 22 de 79 rutas iniciadas).
           [MCP.5] Llevar pedidos de preventa para la guía de carga. (Antes vivía en «Mi día».) -->
      @if ((dia() === hoy() && enRuta()) || puedeLlevar) {
        <div class="mp-acciones">
          @if (dia() === hoy() && enRuta()) {
            <a routerLink="/vendor/route-finish" class="mp-llevar mp-fin"><i class="pi pi-flag" aria-hidden="true"></i><b>Terminar mi día</b></a>
          }
          @if (puedeLlevar) {
            <a routerLink="/vendor/llevar" class="mp-llevar"><i class="pi pi-truck" aria-hidden="true"></i><b>Llevar pedidos</b></a>
          }
        </div>
      }

      <h2 class="mp-h2">Pedidos que levantaste {{ tituloDia() }}</h2>

      @if (error()) {
        <div class="mp-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button type="button" (click)="cargar()">Reintentar</button>
        </div>
      } @else if (cargando() && !datos()) {
        <p class="mp-vacio">Cargando…</p>
      } @else if (!pedidos().length) {
        <div class="mp-vacio">
          <i class="pi pi-inbox" aria-hidden="true"></i>
          <p>{{ dia() === hoy() ? 'Todavía no levantas pedidos de preventa hoy.' : 'No levantaste pedidos de preventa ' + tituloDia() + '.' }}</p>
        </div>
      } @else {
        <!-- [MCP.15] En el orden en que se capturaron (folio), con un filtro rápido de lo surtido. -->
        <div class="mp-filtro" role="group" aria-label="Qué pedidos ver">
          @for (f of filtros(); track f.valor) {
            <button type="button" class="mp-f" [class.on]="filtro() === f.valor" [attr.aria-pressed]="filtro() === f.valor" (click)="filtro.set(f.valor)">{{ f.texto }}</button>
          }
        </div>
        @if (!visibles().length) {
          <p class="mp-nota">{{ filtro() === 'surtidos' ? 'Todavía no te surten ninguno.' : 'No tienes pedidos por surtir.' }}</p>
        }
        <ul class="mp-lista">
          @for (p of visibles(); track p.order_id) {
            <li class="mp-card" [class.mp-card-nuevo]="p.report_unseen" [attr.id]="'mp-' + p.order_id">
              <button type="button" class="mp-card-h" (click)="alternar(p.order_id)" [attr.aria-expanded]="abierto() === p.order_id">
                <span class="mp-r1">
                  <strong>{{ p.customer_name || p.code }}</strong>
                  <span class="chip" [class]="'chip ' + estado(p).clase">{{ estado(p).texto }}</span>
                </span>
                <span class="mp-r2">
                  <span class="mp-folio">{{ p.code }}</span>
                  <span>entrega {{ fechaCorta(p.requested_delivery_date) }}</span>
                  <span class="mp-total">{{ dinero(p.total) }}</span>
                </span>
              </button>
              <!-- [MCP.21] Modificar y cancelar en la misma tarjeta (antes: Mi ruta → cliente → «Ver pedido pendiente» →
                   Por entregar → Corregir, ~10 toques; y cancelar pedía reabrir primero, con dos motivos). Sólo mientras
                   el surtidor no lo toma: después ya no se puede, y el botón no promete lo que no hay. Abierta, la
                   tarjeta trae sus propios botones abajo. -->
              @if (cambiable(p) && abierto() !== p.order_id) {
                <div class="mp-acc">
                  <button type="button" class="mp-acc-b" (click)="alternar(p.order_id)">
                    <i class="pi pi-pencil" aria-hidden="true"></i> Modificar
                  </button>
                  <button type="button" class="mp-acc-b mp-acc-x" [disabled]="ocupado() === p.order_id" (click)="cancelando.set(p)">
                    <i class="pi pi-times" aria-hidden="true"></i> Cancelar
                  </button>
                </div>
              }
              @if (abierto() === p.order_id) {
                <!-- [MCP.21] Dónde va, en UNA línea (David: los seis pasos «me son innecesarios»); el estado ya está arriba. -->
                @if (lineaDeEstado(p); as le) {
                  <p class="mp-linea"><b>{{ le.titulo }}</b>@if (le.detalle) { · {{ le.detalle }} }</p>
                }
                <!-- [MCP.18] Por qué cambió: lo que se corrigió, quitó o dejó, quién, cuándo y el motivo. -->
                @if (porQue(p); as js) {
                  @if (js.length) {
                    <div class="mp-just">
                      <b>Por qué cambió</b>
                      <ul>
                        @for (j of js; track $index) {
                          <li><span class="mp-just-q">{{ j.quien }}{{ j.hora ? ' · ' + j.hora : '' }}</span> {{ j.que }}. <span [class.mp-just-sin]="j.sinMotivo">Motivo: {{ j.motivo }}</span></li>
                        }
                      </ul>
                    </div>
                  }
                }
                @if (cambiable(p)) {
                  <!-- [MCP.21] Mientras nadie lo surte, sus productos se modifican aquí: − / + en su unidad, quitar, y UN
                       «Guardar cambios» (una transacción en el servidor). Un producto nuevo se elige en la captura. -->
                  <div class="mp-ed">
                    <b>Tus productos</b>
                    @if (editables(p); as rs) {
                      <ul class="mp-ed-l">
                        @for (r of rs; track r.id) {
                          <li class="mp-ed-r" [class.mp-ed-fuera]="cuenta(p, r) === 0">
                            <span class="mp-ed-n">{{ r.producto }}@if (!r.editable) {<small class="mp-ed-sub">Se cambia en «Agregar otro producto»</small>}</span>
                            @if (cuenta(p, r) === 0) {
                              <span class="mp-ed-q">Se quita</span>
                              <button type="button" class="mp-ed-b mp-ed-txt" (click)="deshacerR(p, r)" [attr.aria-label]="'Deshacer: dejar ' + r.producto">Deshacer</button>
                            } @else if (r.editable) {
                              <button type="button" class="mp-ed-b" (click)="ajustarR(p, r, -1)" [disabled]="cuenta(p, r) <= 1" [attr.aria-label]="'Uno menos de ' + r.producto"><i class="pi pi-minus" aria-hidden="true"></i></button>
                              <span class="mp-ed-q" [class.mp-ed-cambio]="cuenta(p, r) !== r.original">{{ cuenta(p, r) }} {{ r.unidad }}</span>
                              <button type="button" class="mp-ed-b" (click)="ajustarR(p, r, 1)" [attr.aria-label]="'Uno más de ' + r.producto"><i class="pi pi-plus" aria-hidden="true"></i></button>
                              <button type="button" class="mp-ed-b mp-ed-x" (click)="quitarR(p, r)" [attr.aria-label]="'Quitar ' + r.producto"><i class="pi pi-trash" aria-hidden="true"></i></button>
                            } @else {
                              <span class="mp-ed-q">{{ r.original }} {{ r.unidad }}</span>
                            }
                          </li>
                        }
                      </ul>
                      @if (nCambios(p) > 0) {
                        <p class="mp-nota" role="status">{{ nCambios(p) === 1 ? '1 cambio sin guardar' : nCambios(p) + ' cambios sin guardar' }}. El total nuevo lo calcula el sistema al guardar.</p>
                      }
                      <div class="mp-ed-acc">
                        <button type="button" class="mp-ed-guardar" [disabled]="!nCambios(p) || ocupado() === p.order_id" (click)="pedirGuardar(p)">Guardar cambios</button>
                        <button type="button" class="mp-acc-b" [disabled]="ocupado() === p.order_id" (click)="pedirAgregar(p)"><i class="pi pi-plus" aria-hidden="true"></i> Agregar otro producto</button>
                        @if (nCambios(p) > 0) {
                          <button type="button" class="mp-acc-b" (click)="descartar(p)">Descartar cambios</button>
                        }
                        <button type="button" class="mp-acc-b mp-acc-x" [disabled]="ocupado() === p.order_id" (click)="cancelando.set(p)"><i class="pi pi-times" aria-hidden="true"></i> Cancelar pedido</button>
                      </div>
                    } @else if (lineasDe()[p.order_id] === 'error') {
                      <span class="mp-nota">No se pudieron cargar los productos. <button type="button" class="mp-art-re" (click)="cargarLineas(p.order_id)">Reintentar</button></span>
                    } @else {
                      <span class="mp-nota">Cargando productos…</span>
                    }
                  </div>
                } @else {
                <!-- [MCP.15] Todos los artículos: lo que pidió y lo que le surtieron (antes sólo se veía lo que cambió). -->
                <div class="mp-art">
                  <b>Lo que pediste y lo que surtieron</b>
                  @if (articulos(p); as arts) {
                    <table class="mp-art-t">
                      <thead><tr><th scope="col">Producto</th><th scope="col" class="num">Pediste</th><th scope="col" class="num">Surtieron</th></tr></thead>
                      <tbody>
                        @for (a of arts; track a.clave) {
                          <tr [class.mp-art-cambio]="a.cambio">
                            <td>{{ a.producto }}@if (a.enLugarDe) {<span class="mp-art-n"> · en lugar de {{ a.enLugarDe }}</span>}@if (a.quedo !== null) {<span class="mp-art-n"> · la caja dejó {{ a.quedo }}</span>}</td>
                            <td class="num">{{ a.pidio === null ? '—' : a.pidio + ' ' + a.unidad }}</td>
                            <td class="num">{{ a.surtio === null ? 'pendiente' : a.surtio + ' ' + a.unidad }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else if (lineasDe()[p.order_id] === 'error') {
                    <span class="mp-nota">No se pudieron cargar los artículos. <button type="button" class="mp-art-re" (click)="cargarLineas(p.order_id)">Reintentar</button></span>
                  } @else {
                    <span class="mp-nota">Cargando artículos…</span>
                  }
                </div>
                }
                @if (p.review && (cambios(p).length || sustituciones(p).length)) {
                  <!-- [MCP.10.1] La caja revisó el pedido: se cuenta cómo QUEDÓ, no sólo lo que pasó al surtir. -->
                  <div class="mp-rep">
                    <b>Cómo quedó el pedido</b>
                    @if (cambios(p).length) { <ul>@for (c of cambios(p); track c.clave) { <li>{{ c.texto }}</li> }</ul> }
                    @if (sustituciones(p).length) {
                      <span>Se cambió por otro producto (lo eligió el surtidor):</span>
                      <ul>@for (c of sustituciones(p); track c.clave) { <li>{{ c.texto }}</li> }</ul>
                    }
                    <span>Total del pedido: <s>{{ dinero(totalOriginal(p)) }}</s> → <b>{{ dinero(p.review.total_after) }}</b></span>
                  </div>
                } @else if (p.report; as r) {
                  <div class="mp-rep">
                    <b>Reporte de surtido</b>
                    @if (r.removed.length) {
                      <!-- [MCP.18] «(no hubo)» sólo si ése fue el motivo de todos: con otro motivo, mentiría. -->
                      <span>{{ todosSinExistencia(r.removed) ? 'Se quitó del pedido (no hubo):' : 'Se quitó del pedido:' }}</span>
                      <ul>@for (l of r.removed; track l.product_name) { <li>{{ l.product_name }} · {{ l.ordered }} {{ l.unit }}{{ motivoSurtido(l) }}</li> }</ul>
                    }
                    @if (r.adjusted.length) {
                      <span>Se ajustó a lo que hubo:</span>
                      <ul>@for (l of r.adjusted; track l.product_name) { <li>{{ l.product_name }} · {{ l.ordered }} → {{ l.picked }} {{ l.unit }}{{ motivoSurtido(l) }}</li> }</ul>
                    }
                    <!-- [MCP.13] Lo que el surtidor cambió por otro producto con existencia. -->
                    @if (sustituciones(p).length) {
                      <span>Se cambió por otro producto (lo eligió el surtidor):</span>
                      <ul>@for (c of sustituciones(p); track c.clave) { <li>{{ c.texto }}</li> }</ul>
                    }
                    <span>Total del pedido: <s>{{ dinero(r.total_before) }}</s> → <b>{{ dinero(r.total_after) }}</b></span>
                  </div>
                }
                @if (p.charge; as c) {
                  <div class="mp-cobro" [class.mp-cobro-det]="c.source === 'detectado'">
                    <b>{{ c.source === 'liga' ? 'Kepler cobró este pedido' : 'Parece que Kepler ya lo cobró' }}</b>
                    <span>Ticket {{ c.folio_digital }}{{ c.total !== null ? ' · ' + dinero(c.total) : '' }}</span>
                    <span>{{ c.shared_products }} de {{ c.order_products }} productos coinciden.</span>
                    @if (c.source === 'detectado') {
                      <span class="mp-nota">Lo confirma quien entrega al elegir el ticket.</span>
                    }
                  </div>
                }
              }
            </li>
          }
        </ul>
      }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .mp { padding: var(--sp-4) var(--sp-4) var(--sp-8); }
    .mp-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .mp-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; }
    .mp-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-ref { width: var(--tap-min); height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); cursor: pointer; }
    .mp-ref:focus-visible, .mp-card-h:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-err { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); color: var(--bad-fg); }
    .mp-err button { margin-left: auto; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); cursor: pointer; }
    .mp-vacio { text-align: center; color: var(--text-muted); padding: var(--sp-8) var(--sp-4); }
    .mp-vacio i { font-size: var(--fs-display); color: var(--text-faint); }
    .mp-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    /* [MCP.15] Filtro rápido y la tabla de lo pedido contra lo surtido. */
    .mp-filtro { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .mp-f { min-height: var(--tap-min); padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-pill);
      background: var(--card-bg); color: var(--text-main); font-family: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
    .mp-f.on { border-color: var(--action); color: var(--brand-700); }
    .mp-f:focus-visible, .mp-art-re:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-art { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); font-size: var(--fs-sm); }
    .mp-art-t { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .mp-art-t th { text-align: left; font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); padding: var(--sp-1) var(--sp-1); border-bottom: 1px solid var(--border-color); }
    .mp-art-t td { padding: var(--sp-1) var(--sp-1); border-bottom: 1px solid var(--border-color); vertical-align: top; color: var(--text-main); }
    .mp-art-t .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .mp-art-cambio td { color: var(--warn-fg); font-weight: 600; }
    .mp-art-n { font-weight: 400; color: var(--text-muted); }
    .mp-art-re { border: 0; background: none; color: var(--brand-700); font-family: inherit; font-size: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
    .mp-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); overflow: hidden; }
    .mp-card-nuevo { border-left: 4px solid var(--warn-fg); }
    .mp-card-h { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; text-align: left; padding: var(--sp-3);
      border: 0; background: transparent; color: var(--text-main); cursor: pointer; min-height: var(--tap-min); }
    .mp-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .mp-r1 strong { font-size: var(--fs-body); }
    .mp-r2 { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-folio { font-family: var(--font-mono); }
    .mp-total { margin-left: auto; font-family: var(--font-mono); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .chip { font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); white-space: nowrap; }
    .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .chip.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .chip.bad { background: var(--bad-soft-bg); color: var(--bad-fg); }
    /* [MCP.21] Dónde va el pedido, en una línea (antes, seis pasos con círculos). */
    .mp-linea { margin: 0; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .mp-linea b { color: var(--text-main); font-weight: 600; }
    /* [MCP.21] El editor de la tarjeta: producto a la izquierda; − cuenta + y quitar a la derecha, 44 px en el celular. */
    .mp-ed { display: flex; flex-direction: column; gap: var(--sp-2); padding: 0 var(--sp-3) var(--sp-3); font-size: var(--fs-sm); }
    .mp-ed-l { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .mp-ed-r { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .mp-ed-n { flex: 1; min-width: 0; display: flex; flex-direction: column; color: var(--text-main); }
    .mp-ed-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .mp-ed-q { min-width: 4.5rem; text-align: center; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .mp-ed-cambio { font-weight: 700; color: var(--brand-700); }
    .mp-ed-b { min-width: var(--tap-min); min-height: var(--tap-min); display: inline-grid; place-items: center; padding: 0 var(--sp-2);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); cursor: pointer; font-family: inherit; }
    .mp-ed-b:disabled { opacity: 0.4; cursor: default; }
    .mp-ed-b:focus-visible, .mp-ed-guardar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-ed-x { color: var(--bad-fg); }
    .mp-ed-txt { font-size: var(--fs-sm); font-weight: 600; }
    .mp-ed-fuera .mp-ed-n { text-decoration: line-through; color: var(--text-muted); }
    .mp-ed-acc { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .mp-ed-acc > * { flex: 1 1 10rem; }
    .mp-ed-guardar { min-height: var(--tap-min); padding: 0 var(--sp-3); border: 0; border-radius: var(--r-md); background: var(--action);
      color: var(--action-ink); font-family: inherit; font-size: var(--fs-sm); font-weight: 700; cursor: pointer; }
    .mp-ed-guardar:disabled { opacity: 0.45; cursor: default; }
    .mp-rep, .mp-cobro { margin: 0 var(--sp-3) var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); display: flex;
      flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .mp-rep { background: var(--warn-soft-bg); border: 1px solid var(--warn-border); }
    .mp-rep ul { margin: 0; padding-left: 1.1rem; }
    /* [MCP.18] Por qué cambió: texto, sin color de alarma (no es un error, es un registro). */
    .mp-just { margin: 0 var(--sp-3) var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); border: 1px solid var(--border-color);
      display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .mp-just ul { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: var(--sp-1); }
    .mp-just-q { font-weight: 700; }
    .mp-just-sin { color: var(--text-muted); font-style: italic; }
    .mp-cobro { background: var(--ok-soft-bg); border: 1px solid var(--ok-border); }
    .mp-cobro-det { background: var(--info-soft-bg); border-color: var(--info-border); }
    .mp-nota { color: var(--text-muted); font-size: var(--fs-xs); }
    /* [MCP.16] Pedidos | Cotizaciones: un control de dos mitades, distinto de los filtros (pastillas sueltas). */
    .mp-seg { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-1); padding: var(--sp-1); margin-bottom: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .mp-seg button { min-height: var(--tap-min); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-muted);
      font-family: inherit; font-size: var(--fs-body); font-weight: 600; cursor: pointer; }
    .mp-seg button.on { background: var(--overlay-selected); color: var(--text-main); font-weight: 800; box-shadow: 0 0 0 1px var(--border-color); }
    .mp-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* [MCP.19] El recuento del día, lo que se quedó en el celular y «Llevar pedidos» (antes en «Mi día»). */
    app-vendor-recuento-dia { margin-bottom: var(--sp-3); }
    .mp-h2 { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-body); font-weight: 800; }
    .mp-aviso { margin: 0 0 var(--sp-3); }
    /* [MCP.21] Corregir y cancelar en la tarjeta: texto + icono (no sólo color), 44 px de alto. */
    .mp-acc { display: flex; gap: var(--sp-2); padding: 0 var(--sp-3) var(--sp-3); }
    .mp-acc-b { flex: 1; min-height: var(--tap-min); display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main);
      font-family: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; }
    .mp-acc-b:disabled { opacity: 0.5; cursor: default; }
    .mp-acc-b:focus-visible, .mp-fin:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-acc-x { color: var(--bad-fg); }
    /* [MCP.20] Los días: una fila que se desliza de lado en el celular (no se parte en tres renglones). */
    .mp-dias { position: relative; display: flex; gap: var(--sp-2); overflow-x: auto; margin-bottom: var(--sp-3); padding-bottom: var(--sp-1);
      scrollbar-width: none; }
    .mp-dias > * { flex: 0 0 auto; }
    .mp-dia { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .mp-dia-nuevo { width: var(--sp-2); height: var(--sp-2); border-radius: 50%; background: var(--warn-fg); }
    /* El calendario del celular: el campo se abre con «Otro día»; sólo se ve si el navegador no sabe abrirlo solo. */
    .mp-cal-in { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .mp-cal-in.ver { position: static; width: auto; height: var(--tap-min); opacity: 1; pointer-events: auto; padding: 0 var(--sp-2);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); font-family: inherit; }
    .mp-cal-in.ver:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-cola { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-3); padding: var(--sp-3);
      border: 1px solid var(--warn-border); border-radius: var(--r-lg); background: var(--warn-soft-bg); font-size: var(--fs-sm); }
    .mp-cola > small { color: var(--text-muted); font-size: var(--fs-xs); }
    .mp-cola-f { display: flex; align-items: center; gap: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--warn-border); }
    .mp-cola-f > span { flex: 1; display: flex; flex-direction: column; min-width: 0; font-weight: 700; }
    .mp-cola-f small { font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }
    .mp-cola-f button { min-height: var(--tap-min); min-width: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); font-family: inherit; font-weight: 600; cursor: pointer; }
    .mp-cola-f button:focus-visible, .mp-llevar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mp-cola-f .mp-cola-x { color: var(--bad-fg); }
    .mp-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .mp-llevar { flex: 1 1 9rem; display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
      padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--card-bg);
      color: var(--text-main); text-decoration: none; min-height: 2.75rem; font-size: var(--fs-sm); }
    .mp-llevar > .pi:first-child { color: var(--action); }
  `],
})
export class VendorMisPedidosComponent implements OnInit {
  private readonly api = inject(PresaleStatusService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<PresaleSellerStatusResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<string | null>(null);
  readonly abierto = signal<string | null>(null);
  readonly pedidos = computed<PresaleSellerOrder[]>(() => this.datos()?.data ?? []);
  /** `[MCP.15]` Qué pedidos ver; por omisión todos. */
  readonly filtro = signal<FiltroMisPedidos>('todos');
  /** `[MCP.15]` Todos en el orden en que se capturaron (día de entrega y folio), filtrados. */
  readonly visibles = computed<PresaleSellerOrder[]>(() => filtrarPedidos(enOrdenDeCaptura(this.pedidos()), this.filtro()));
  readonly filtros = computed<Array<{ valor: FiltroMisPedidos; texto: string }>>(() => {
    const ps = this.pedidos();
    return [
      { valor: 'todos', texto: `Todos · ${ps.length}` },
      { valor: 'por_surtir', texto: `Por surtir · ${filtrarPedidos(ps, 'por_surtir').length}` },
      { valor: 'surtidos', texto: `Surtidos · ${filtrarPedidos(ps, 'surtidos').length}` },
    ];
  });
  /** `[MCP.15]` Las líneas de cada pedido abierto (se piden al abrirlo; la revisión ya las trae). */
  readonly lineasDe = signal<Record<string, LineaDelPedido[] | 'cargando' | 'error'>>({});
  private readonly vendor = inject(VendorService);
  // ─── [MCP.16] Pedidos | Cotizaciones ───
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  /** `[MCP.16]` La pestaña la dice la URL: «Pedidos» del menú de abajo sigue marcado y el regreso cae en la misma pestaña. */
  readonly ver = signal<VistaPedidos>(vistaDe(this.route.snapshot.queryParamMap.get('ver')));

  // ─── [MCP.19] Recuento del día (y lo que antes vivía en «Mi día») ───
  private readonly recuentoApi = inject(RecuentoDiaService);
  private readonly offlineApi = inject(OfflineOrderService);
  private readonly confirmSvc = inject(ConfirmationService);
  readonly recuento = signal<SellerDayRecap | null>(null);
  readonly recuentoEstado = signal<'cargando' | 'listo' | 'error'>('cargando');
  readonly recuentoError = signal<string | null>(null);
  readonly recuentoEn = signal<string | null>(null);
  /** Pedidos confirmados sin señal que siguen en el celular (en cola o que ya no se pudieron enviar). */
  readonly pendingOffline = signal<PendingOrderSummary[]>([]);
  /** Un pedido del recuento que no está en la lista de abajo: se dice, no se queda el toque sin respuesta. */
  readonly avisoLista = signal<string | null>(null);
  /** `[MCP.5]` Llevar pedidos: lo usa quien reparte o entrega (mismas claves que exige el servidor). */
  readonly puedeLlevar = inject(PermissionsService).hasAny(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL);

  // ─── [MCP.21] Corregir y cancelar desde la tarjeta ───
  private readonly toast = inject(MessageService);
  private readonly rutaDia = inject(RouteDayService);
  readonly motivosCorregir = MOTIVOS_CORREGIR;
  readonly motivosCancelar = MOTIVOS_CANCELAR;
  /** Lo que la vendedora va cambiando de cada pedido: se conserva si cierra la tarjeta o se refresca la lista. */
  readonly ediciones = signal<Readonly<Record<string, Edicion>>>({});
  /** La hoja del motivo de «Guardar cambios» / «Agregar otro producto»; `null` = cerrada. */
  readonly guardando = signal<{ p: PresaleSellerOrder; agregar: boolean; sugerido: string | null } | null>(null);
  readonly cancelando = signal<PresaleSellerOrder | null>(null);
  readonly guardandoMotivo = signal(false);
  /** El pedido con una petición en vuelo: sus botones se apagan (no se manda dos veces). */
  readonly ocupado = signal<string | null>(null);
  /** ¿La ruta de hoy está iniciada y sin finalizar? Sólo entonces se ofrece «Terminar mi día». */
  readonly enRuta = signal(false);
  /** `?cliente=` desde la hoja del cliente en «Ruta»: se abre su pedido una sola vez. */
  private clienteAAbrir: string | null = this.route.snapshot.queryParamMap.get('cliente');

  // ─── [MCP.20] Un día a la vez ───
  /** Hoy en México; el servidor lo corrige con su `today` en cada respuesta. */
  readonly hoy = signal(hoyMx());
  /** El día que se ve: por omisión hoy. La lista y el recuento son de este día. */
  readonly dia = signal(this.hoy());
  /** Días con un reporte de surtido sin ver (se guardan aparte: no se borran mientras carga otro día). */
  readonly sinVer = signal<string[]>([]);
  readonly dias = computed(() => diasALaMano(this.hoy(), this.dia(), this.sinVer()));
  /** Reportes nuevos de días más viejos que la semana: se avisan con su liga (máx. 3). */
  readonly sinVerViejos = computed(() => sinVerFuera(this.hoy(), this.sinVer()).filter((f) => f !== this.dia()).slice(0, 3));
  readonly tituloDia = computed(() => nombreLargo(this.dia(), this.hoy()));
  /** El navegador no sabe abrir el calendario solo: se muestra el campo. */
  readonly calVisible = signal(false);
  readonly diaCorto = diaCorto;
  /** La persona ya eligió un día: el «hoy» del servidor ya no la mueve. */
  private diaElegido = false;

  ngOnInit(): void {
    // [MCP.16] Al cambiar de pestaña cambia la URL; al volver a «Pedidos» se piden de nuevo.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => {
      const v = vistaDe(m.get('ver'));
      if (v === this.ver()) return;
      this.ver.set(v);
      if (v === 'pedidos') this.actualizar();
    });
    this.actualizar();
    // Sólo mientras la pantalla se ve: en un celular con la pantalla apagada no se gasta red.
    let vuelta = 0;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      this.cargar(true);
      if (++vuelta % VUELTAS_POR_RECUENTO === 0) this.cargarRecuento();
    }, REFRESCO_MS);
    const alVolver = () => { if (document.visibilityState === 'visible') { this.cargar(true); this.cargarRecuento(); } };
    document.addEventListener('visibilitychange', alVolver);
    this.destroyRef.onDestroy(() => { clearInterval(t); document.removeEventListener('visibilitychange', alVolver); });
  }

  cargar(silencioso = false): void {
    // [MCP.16] Viendo las cotizaciones no se piden los pedidos: la respuesta marcaría el reporte del surtido como visto sin que nadie lo viera.
    if (this.ver() !== 'pedidos') return;
    if (!silencioso) this.cargando.set(true);
    const dia = this.dia();
    this.api.status(dia).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        // [MCP.20] Si mientras tanto eligió otro día, esta respuesta ya no es la que está viendo.
        if (dia !== this.dia()) return;
        // [MCP.20] El «hoy» lo dice el servidor (el reloj del celular puede ir mal). Si nadie eligió otro
        // día, la pantalla se mueve a ese hoy y se pide de nuevo.
        if (d.today && d.today !== this.hoy()) {
          this.hoy.set(d.today);
          if (!this.diaElegido && dia !== d.today) {
            this.dia.set(d.today);
            this.actualizar();
            return;
          }
        }
        this.sinVer.set(d.unseen_days ?? []);
        this.datos.set(d);
        this.cargando.set(false);
        this.error.set(null);
        this.cargadoEn.set(new Date().toISOString());
        // Abrir el primero con reporte nuevo: es lo que vino a ver si llegó por el aviso.
        const nuevo = d.data.find((p) => p.report_unseen);
        if (nuevo && !this.abierto()) this.abierto.set(nuevo.order_id);
        this.abrirDeCliente(d);
        // [MCP.20] Sólo se marcan vistos los reportes de ESTE día: los de otro día siguen nuevos hasta que los vea.
        const vistos = d.data.filter((p) => p.report_unseen).map((p) => p.order_id);
        if (vistos.length) {
          this.api.markSeen(vistos).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: () => this.sinVer.update((s) => s.filter((f) => f !== dia)),
            error: () => void 0,
          });
        }
      },
      error: (e) => {
        if (dia !== this.dia()) return;
        this.cargando.set(false);
        this.error.set((e as { error?: { message?: string } })?.error?.message || 'No se pudieron cargar tus pedidos.');
      },
    });
  }

  /** El botón de actualizar y la entrada: la lista y el recuento. */
  actualizar(): void {
    this.cargar();
    this.cargarRecuento();
  }

  /** `[MCP.19]` El recuento del día y lo que quedó en el celular. Un fallo con un recuento ya visto lo deja (con su hora). */
  cargarRecuento(): void {
    if (this.ver() !== 'pedidos') return;
    this.cargarCola();
    // [MCP.21] ¿Ruta iniciada y sin finalizar? Un fallo no ofrece «Terminar mi día» (no se adivina).
    this.rutaDia.today().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.enRuta.set(r?.state === 'en_ruta'),
      error: () => this.enRuta.set(false),
    });
    const dia = this.dia();
    this.recuentoApi.dia(dia).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (dia !== this.dia()) return;
        this.recuento.set(r);
        this.recuentoEstado.set('listo');
        this.recuentoError.set(null);
        this.recuentoEn.set(new Date().toISOString());
      },
      error: (e) => {
        if (dia !== this.dia() || this.recuento()) return;
        this.recuentoEstado.set('error');
        this.recuentoError.set((e as { error?: { message?: string } })?.error?.message || 'No se pudo cargar el recuento del día.');
      },
    });
  }

  /** `[MCP.21]` Se puede corregir o cancelar desde la app mientras está agendado y el surtidor no lo ha tomado. */
  cambiable(p: PresaleSellerOrder): boolean {
    return (p.status === 'confirmed' || p.status === 'pending_approval') && !p.started && !p.finished && !p.delivered_at;
  }

  // ─── [MCP.21] Modificar en la tarjeta ───

  /** Los productos del pedido, listos para editar; `null` = todavía no se cargan (o fallaron). */
  editables(p: PresaleSellerOrder): RenglonEditable[] | null {
    const ls = this.lineasDe()[p.order_id];
    return Array.isArray(ls) ? ls.map(renglonEditable) : null;
  }

  private edicionDe(p: PresaleSellerOrder): Edicion {
    return this.ediciones()[p.order_id] ?? {};
  }

  cuenta(p: PresaleSellerOrder, r: RenglonEditable): number {
    return cuentaDe(r, this.edicionDe(p));
  }

  nCambios(p: PresaleSellerOrder): number {
    const rs = this.editables(p);
    return rs ? cambiosDe(rs, this.edicionDe(p)).length : 0;
  }

  private editar(p: PresaleSellerOrder, f: (e: Edicion) => Edicion): void {
    this.ediciones.update((m) => ({ ...m, [p.order_id]: f(m[p.order_id] ?? {}) }));
  }

  ajustarR(p: PresaleSellerOrder, r: RenglonEditable, d: 1 | -1): void { this.editar(p, (e) => ajustar(e, r, d)); }
  quitarR(p: PresaleSellerOrder, r: RenglonEditable): void { this.editar(p, (e) => quitar(e, r)); }
  deshacerR(p: PresaleSellerOrder, r: RenglonEditable): void { this.editar(p, (e) => deshacer(e, r)); }

  descartar(p: PresaleSellerOrder): void {
    this.ediciones.update((m) => {
      const { [p.order_id]: _fuera, ...resto } = m;
      return resto;
    });
  }

  /** «Guardar cambios»: el motivo, ya sugerido por lo que cambió. */
  pedirGuardar(p: PresaleSellerOrder): void {
    const rs = this.editables(p);
    if (!rs || !this.nCambios(p)) return;
    this.guardando.set({ p, agregar: false, sugerido: motivoSugerido(rs, this.edicionDe(p)) });
  }

  /** «Agregar otro producto»: guarda lo que ya cambió y abre la captura de ESTE pedido (ahí se elige la presentación). */
  pedirAgregar(p: PresaleSellerOrder): void {
    if (!p.customer_id) {
      this.toast.add({ severity: 'warn', summary: 'No se puede abrir', detail: 'Abre al cliente desde «Mi ruta» para agregarle productos.' });
      return;
    }
    this.guardando.set({ p, agregar: true, sugerido: 'agregar' });
  }

  confirmarGuardar(p: PresaleSellerOrder, agregar: boolean, motivo: MotivoElegido): void {
    if (this.guardandoMotivo()) return;
    const cambios = cambiosDe(this.editables(p) ?? [], this.edicionDe(p));
    this.guardandoMotivo.set(true);
    this.ocupado.set(p.order_id);
    this.vendor.modificarPedido(p.order_id, motivo, cambios, agregar).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => {
        this.guardandoMotivo.set(false);
        this.guardando.set(null);
        this.ocupado.set(null);
        this.descartar(p);
        this.lineasDe.update((m) => {
          const { [p.order_id]: _viejas, ...resto } = m;
          return resto;
        });
        if (agregar) {
          this.router.navigate(['/vendor/take-order', p.customer_id], { queryParams: { order: p.order_id } });
          return;
        }
        this.toast.add({ severity: 'success', summary: 'Pedido modificado', detail: `${p.code} · nuevo total ${this.dinero(Number(o?.total))}` });
        this.actualizar();
        if (this.abierto() === p.order_id) this.cargarLineas(p.order_id);
      },
      error: (e) => {
        // Lo que cambió se queda en pantalla: no se pierde lo capturado si el servidor dijo que no.
        this.guardandoMotivo.set(false);
        this.guardando.set(null);
        this.ocupado.set(null);
        this.toast.add({ severity: 'error', summary: 'No se guardó', detail: e?.error?.message || 'Intenta de nuevo.', life: 12000 });
        this.actualizar();
      },
    });
  }

  /** `[MCP.21]` Dónde va el pedido, en una línea: lo que falta («Esperando a que el surtidor empiece») o lo último que pasó. */
  lineaDeEstado(p: PresaleSellerOrder): { titulo: string; detalle: string } | null {
    const ps = this.pasos(p);
    const ahora = ps.find((s) => s.estado === 'ahora') ?? null;
    const hechos = ps.filter((s) => s.estado === 'hecho' || s.estado === 'aviso');
    const ultimo = hechos[hechos.length - 1] ?? null;
    // Recién agendado: lo único que importa es lo que sigue.
    if (!ultimo || (ultimo === ps[0] && ahora)) return ahora ? { titulo: ahora.detalle || ahora.titulo, detalle: '' } : null;
    // Lo último que pasó (con quién y a qué hora) y, si falta algo, qué sigue.
    const sigue = ahora?.detalle ? `sigue: ${ahora.detalle.charAt(0).toLowerCase()}${ahora.detalle.slice(1)}` : '';
    return { titulo: ultimo.titulo, detalle: [ultimo.detalle, sigue].filter(Boolean).join(' · ') };
  }

  /** `[MCP.21]` Cancelar directo, con UN motivo (antes: reabrir con un motivo y cancelar con otro). */
  confirmarCancelar(p: PresaleSellerOrder, motivo: MotivoElegido): void {
    if (this.guardandoMotivo()) return;
    this.guardandoMotivo.set(true);
    this.vendor.cancelarConMotivo(p.order_id, motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardandoMotivo.set(false);
        this.cancelando.set(null);
        this.toast.add({ severity: 'info', summary: 'Pedido cancelado', detail: `${p.code} · ${p.customer_name || ''}`.trim() });
        this.actualizar();
      },
      error: (e) => {
        this.guardandoMotivo.set(false);
        this.cancelando.set(null);
        this.toast.add({ severity: 'error', summary: 'No se canceló', detail: e?.error?.message || 'Intenta de nuevo.', life: 12000 });
        this.actualizar();
      },
    });
  }

  /** `[MCP.21]` Llegó desde la hoja del cliente: abre su pedido del día (el más reciente). */
  private abrirDeCliente(d: PresaleSellerStatusResponse): void {
    const id = this.clienteAAbrir;
    if (!id) return;
    this.clienteAAbrir = null;
    const p = d.data.find((x) => x.customer_id === id);
    if (!p) {
      this.avisoLista.set('Ese cliente no tiene pedidos levantados hoy: búscalo en los días de arriba.');
      return;
    }
    this.verPedido(p.order_id);
  }

  /** `[MCP.20]` Cambia el día que se ve: la lista y el recuento se piden de nuevo para ese día. */
  elegirDia(f: string): void {
    if (!esDia(f) || f > this.hoy() || f === this.dia()) return;
    this.diaElegido = true;
    this.dia.set(f);
    this.calVisible.set(false);
    this.abierto.set(null);
    this.filtro.set('todos');
    this.avisoLista.set(null);
    this.datos.set(null);
    this.error.set(null);
    this.recuento.set(null);
    this.recuentoEstado.set('cargando');
    this.recuentoError.set(null);
    this.actualizar();
  }

  /** `[MCP.20]` «Otro día»: abre el calendario del celular; si el navegador no sabe, muestra el campo. */
  abrirCalendario(el: HTMLInputElement): void {
    const abrir = (el as HTMLInputElement & { showPicker?: () => void }).showPicker;
    if (typeof abrir === 'function') {
      try {
        abrir.call(el);
        return;
      } catch {
        /* sin permiso del navegador: se muestra el campo */
      }
    }
    this.calVisible.set(true);
    setTimeout(() => el.focus());
  }

  /** Lo que está en el celular (Dexie): no depende de la red. */
  private cargarCola(): void {
    void this.offlineApi.pendingSummaries().then((s) => this.pendingOffline.set(s)).catch(() => void 0);
  }

  reintentarPendiente(q: PendingOrderSummary): void {
    void this.offlineApi.retry(q.id).then(() => this.cargarCola());
  }

  /** Descartar no se deshace: se confirma. */
  descartarPendiente(q: PendingOrderSummary): void {
    this.confirmSvc.confirm({
      header: 'Descartar pedido',
      message: `¿Descartar el pedido de ${q.customerName} (${this.dinero(q.total)})? No se enviará.`,
      icon: 'pi pi-trash',
      acceptLabel: 'Descartar',
      rejectLabel: 'No',
      accept: () => { void this.offlineApi.cancel(q.id).then(() => this.cargarCola()); },
    });
  }

  /** `[MCP.19]` Del recuento a su tarjeta en la lista: se abre y se lleva a la vista. */
  verPedido(id: string): void {
    if (!this.pedidos().some((x) => x.order_id === id)) {
      this.avisoLista.set('Ese pedido ya no está en la lista de abajo (ya se cerró).');
      return;
    }
    this.avisoLista.set(null);
    this.filtro.set('todos');
    if (this.abierto() !== id) this.alternar(id);
    const suave = typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => document.getElementById(`mp-${id}`)?.scrollIntoView({ block: 'start', behavior: suave ? 'smooth' : 'auto' }));
  }

  /** `[MCP.19]` Un borrador se manda desde «Tomar pedido» de ese cliente (como en «Mi día»). */
  irABorrador(customerId: string): void {
    this.router.navigate(['/vendor/take-order', customerId]);
  }

  alternar(id: string): void {
    const abre = this.abierto() !== id;
    this.abierto.set(abre ? id : null);
    if (!abre) return;
    // [MCP.15] La revisión en caja ya trae todos los renglones; si no, se piden las líneas del pedido.
    const p = this.pedidos().find((x) => x.order_id === id);
    const yaEstan = this.lineasDe()[id];
    if (p && !p.review?.lines?.length && (!yaEstan || yaEstan === 'error')) this.cargarLineas(id);
  }

  /** `[MCP.16]` Cambia de pestaña por la URL (sin apilar historial: «atrás» sale de «Pedidos», no de la pestaña). */
  verVista(v: VistaPedidos): void {
    if (v === this.ver()) return;
    this.router.navigate(['/vendor/mis-pedidos'], { queryParams: v === 'cotizaciones' ? { ver: 'cotizaciones' } : {}, replaceUrl: true });
  }

  /** `[MCP.15]` Las líneas vivas del pedido (para «lo que pediste y lo que surtieron»). */
  cargarLineas(id: string): void {
    this.lineasDe.update((m) => ({ ...m, [id]: 'cargando' }));
    this.vendor.orderById(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => this.lineasDe.update((m) => ({ ...m, [id]: ((o?.lines ?? []) as LineaDelPedido[]) })),
      error: () => this.lineasDe.update((m) => ({ ...m, [id]: 'error' })),
    });
  }

  /** `[MCP.15]` `null` mientras no hay de dónde sacarlos (cargando o falló): la pantalla lo dice. */
  articulos(p: PresaleSellerOrder): Articulo[] | null {
    const l = this.lineasDe()[p.order_id];
    return articulosDelPedido(p, Array.isArray(l) ? l : null);
  }

  estado(p: PresaleSellerOrder): { texto: string; clase: string } {
    // [MCP.13.1] Al surtir no hubo nada: el pedido se canceló (no va a llegar).
    if (p.report?.order_cancelled || p.status === 'cancelled') return { texto: p.report?.order_cancelled ? 'Cancelado · no hubo nada' : 'Cancelado', clase: 'bad' };
    if (p.delivered_at) return { texto: 'Entregado', clase: 'ok' };
    if (p.charge?.source === 'liga') return { texto: 'Cobrado', clase: 'ok' };
    if (p.charge) return { texto: 'Cobrado (por confirmar)', clase: 'info' };
    if (p.reviewed) return { texto: 'Revisado en caja', clase: 'ok' };
    if (p.finished) return p.finished.outcome === 'con_faltantes' ? { texto: 'Surtido con faltantes', clase: 'warn' } : { texto: 'Surtido completo', clase: 'ok' };
    if (p.started) return { texto: 'Surtiendo', clase: 'warn' };
    return { texto: 'Agendado', clase: 'info' };
  }

  pasos(p: PresaleSellerOrder): Paso[] {
    const tomado = !!p.started;
    const surtido = !!p.finished;
    const cobrado = !!p.charge;
    if (p.report?.order_cancelled) {
      // [MCP.13.1] Ahí termina: no hay caja, cobro ni entrega que esperar.
      return [
        { titulo: 'Agendado', detalle: p.scheduled_at ? `${this.horaDe(p.scheduled_at)} · llegó a ${p.warehouse_name || 'la sucursal'}` : '', estado: 'hecho' },
        { titulo: 'Lo tomó el surtidor', detalle: p.started ? `${p.started.name} · empezó ${this.horaDe(p.started.at)}` : '', estado: 'hecho' },
        { titulo: 'Cancelado: no hubo nada', detalle: p.finished ? `${p.finished.name} · ${this.horaDe(p.finished.at)} · no hubo existencia de ningún producto` : 'no hubo existencia de ningún producto', estado: 'aviso' },
      ];
    }
    return [
      { titulo: 'Agendado', detalle: p.scheduled_at ? `${this.horaDe(p.scheduled_at)} · llegó a ${p.warehouse_name || 'la sucursal'}` : '', estado: 'hecho' },
      {
        titulo: 'Lo tomó el surtidor',
        detalle: p.started ? `${p.started.name} · empezó ${this.horaDe(p.started.at)}` : 'Esperando a que el surtidor empiece',
        estado: tomado ? 'hecho' : 'ahora',
      },
      {
        titulo: p.finished?.outcome === 'con_faltantes' ? 'Surtido con faltantes' : 'Surtido',
        detalle: p.finished ? `${p.finished.name} · terminó ${this.horaDe(p.finished.at)}${p.finished.outcome === 'con_faltantes' ? ' · lo que faltó se quitó del pedido' : ' · hubo todo'}` : '',
        estado: surtido ? (p.finished?.outcome === 'con_faltantes' ? 'aviso' : 'hecho') : tomado ? 'ahora' : 'pendiente',
      },
      // [MCP.10.1] La caja revisa antes de cobrar; si cambió algo, se dice qué.
      {
        titulo: 'Revisado en caja',
        detalle: p.reviewed ? `${p.reviewed.name} · ${this.horaDe(p.reviewed.at)}${this.resumenRevision(p)}` : surtido ? 'Esperando a que la caja lo revise' : '',
        estado: p.reviewed ? 'hecho' : surtido ? 'ahora' : 'pendiente',
      },
      {
        titulo: 'Cobrado en Kepler',
        detalle: p.charge ? `Ticket ${p.charge.folio_digital}${p.charge.source === 'detectado' ? ' · por confirmar' : ''}` : 'Se detecta cuando la caja cierre el ticket',
        estado: cobrado ? 'hecho' : p.reviewed ? 'ahora' : 'pendiente',
      },
      { titulo: 'Entregado', detalle: p.delivered_at ? this.horaDe(p.delivered_at) : '', estado: p.delivered_at ? 'hecho' : 'pendiente' },
    ];
  }

  /**
   * [MCP.10.1] Los productos que cambiaron entre lo pedido y cómo quedó, con quién los cambió:
   * «SALSA · pediste 2 → surtió 1 → quedó 2 CJA (lo completó la caja)». Lo que llegó igual no se lista.
   */
  cambios(p: PresaleSellerOrder): Array<{ clave: string; texto: string }> {
    // [MCP.13] Los sustitutos se cuentan aparte (sustituciones): no son algo que «pediste».
    const sustitutos = new Set((p.report?.substituted ?? []).map((x) => x.line_id));
    return (p.review?.lines ?? [])
      .filter((l) => !sustitutos.has(l.key))
      .filter((l) => l.picked !== l.ordered || l.final !== l.ordered)
      .map((l) => {
        // [MCP.18] Con motivo registrado se dice el motivo, no «no hubo» (que mentiría si fue otro).
        const quien = l.resolution === 'completo' ? ' (lo completó la caja)' : l.resolution === 'no_hubo' ? this.porQueNoHubo(p, l) : '';
        const surtio = l.picked !== l.final ? ` → surtió ${l.picked}` : '';
        return { clave: l.key, texto: `${l.product_name} · pediste ${l.ordered}${surtio} → quedó ${l.final} ${l.unit}${quien}` };
      });
  }

  /**
   * `[MCP.13]` Lo que el surtidor cambió por otro producto: «BANDERILLA · faltó 1 → TAMARINDO · 1 PZA».
   * Si la caja después lo quitó, se dice.
   */
  sustituciones(p: PresaleSellerOrder): Array<{ clave: string; texto: string }> {
    const rep = p.report;
    if (!rep?.substituted?.length) return [];
    const revisados = new Map((p.review?.lines ?? []).map((l) => [l.key, l]));
    const faltante = new Map([...rep.removed, ...rep.adjusted].filter((l) => !!l.line_id).map((l) => [l.line_id as string, l]));
    return rep.substituted.map((x) => {
      const f = faltante.get(x.for_line_id);
      const falto = f ? ` · faltó ${+(f.ordered - f.picked).toFixed(3)} ${f.unit}` : '';
      const r = revisados.get(x.line_id);
      const quito = r && r.final < r.ordered ? (r.final > 0 ? ` (la caja dejó ${r.final})` : ' (la caja lo quitó)') : '';
      return { clave: x.line_id, texto: `${x.for_product_name}${falto} → ${x.product_name} · ${x.quantity} ${x.unit}${quito}` };
    });
  }

  /** El total antes de cualquier ajuste: el del reporte del surtido si hubo; si no, el de la revisión. */
  totalOriginal(p: PresaleSellerOrder): number {
    return p.report?.total_before ?? p.review?.total_before ?? p.total;
  }

  /** « · la caja completó 1 y quitó 1» · « · todo bien». */
  private resumenRevision(p: PresaleSellerOrder): string {
    const ls = p.review?.lines ?? [];
    const comp = ls.filter((l) => l.resolution === 'completo').length;
    const quito = ls.filter((l) => l.resolution === 'no_hubo').length;
    if (!comp && !quito) return ' · todo bien';
    const partes = [comp ? `completó ${comp}` : '', quito ? `quitó ${quito}` : ''].filter(Boolean);
    return ` · la caja ${partes.join(' y ')}`;
  }

  /** `[MCP.18]` Los justificantes del pedido en palabras; `[]` = no cambió (o el servidor no los manda todavía). */
  porQue(p: PresaleSellerOrder): Array<{ quien: string; hora: string; que: string; motivo: string; sinMotivo: boolean }> {
    return (p.justifications ?? []).map((j) => {
      const t = textoDeJustificante(j);
      return { ...t, hora: j.at ? this.horaDe(j.at) : '', sinMotivo: j.reason === null };
    });
  }

  /** `[MCP.18]` « · Dañado o caducado» si el surtidor registró el motivo; vacío en reportes de antes. */
  motivoSurtido(l: { reason?: string; reason_note?: string }): string {
    return l.reason ? ` · ${textoDeMotivo(MOTIVOS_SURTIDO, l.reason, l.reason_note)}` : '';
  }

  /** `[MCP.18]` ¿Todos los quitados fueron porque no había? (Los reportes de antes no tienen otro motivo posible.) */
  todosSinExistencia(ls: ReadonlyArray<{ reason?: string }>): boolean {
    return ls.every((l) => !l.reason || l.reason === MOTIVO_SURTIDO_POR_OMISION);
  }

  /** `[MCP.18]` El porqué de un «no hubo» en caja: el motivo de la caja, si no el del surtidor, si no «no hubo». */
  private porQueNoHubo(p: PresaleSellerOrder, l: { key: string; reason?: string; reason_note?: string }): string {
    if (l.reason) return ` (${textoDeMotivo(MOTIVOS_CAJA, l.reason, l.reason_note)})`;
    const rep = p.report;
    const delSurtido = l.key.startsWith('borrado:')
      ? rep?.removed[Number(l.key.slice('borrado:'.length))]
      : [...(rep?.removed ?? []), ...(rep?.adjusted ?? [])].find((x) => x.line_id === l.key);
    return delSurtido?.reason ? ` (${textoDeMotivo(MOTIVOS_SURTIDO, delSurtido.reason, delSurtido.reason_note)})` : ' (no hubo)';
  }

  dinero(n: number | string | null | undefined): string { return pesos.format(Number(n) || 0); }
  horaDe(iso: string): string { return hora.format(new Date(iso)); }
  fechaCorta(f: string): string {
    const [y, m, d] = f.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  }
}
