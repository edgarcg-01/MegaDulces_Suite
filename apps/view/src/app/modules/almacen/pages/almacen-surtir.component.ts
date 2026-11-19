import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { skip } from 'rxjs';
import { irConservandoPanel } from '../../../core/panel/ir-conservando-panel';
import { PermissionsService } from '../../../core/services/permissions.service';
import { destinoDeSalida, puedeAbrirTablero, urlPrevia } from '../salida-de-foco';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';
import type {
  KeplerWavesAutoResponse, PickerWave, PickerWaveLine, PresalePickBucket, PresalePickDetail,
  PresalePickInboxResponse, PresalePickInboxRow, PresalePickReport, PresaleOtherUnitsResponse, PresaleReviewStock,
  PresaleSubstituteCandidate, PresaleSubstituteResponse,
} from '@megadulces/contracts';
import { topeEnUnidad } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { PickingService } from '../../reparto/picking.service';
import { PresalePickingService } from '../presale-picking.service';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { AlmacenRutasHoyComponent } from '../surtir-ruta/almacen-rutas-hoy.component';
import { ClientesNuevosAvisoComponent } from '../clientes-nuevos-aviso.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { textoParte } from '../surtir-ruta/ruta-surtido.util';
import { leerEscaneo, ordenarPorRecorrido } from '../escaneo-surtido';
import { agruparPorVendedor } from '../pedidos-por-vendedor';
import { deVendedor, etiquetaDia, pendientesDeOtrosDias, vendedoresDe } from '../pedidos-por-dia';
import { avisoBuscarEnBodega, sistemaSinProducto, textoSistema } from '../existencia-surtido';
import { todayMx } from '../../../core/utils/mx-date';
import { MOTIVOS_SURTIDO, MOTIVO_SURTIDO_POR_OMISION, textoDeMotivo, type OrderJustification } from '@megadulces/contracts';
import { MotivoChipsComponent } from '../shared/motivo-chips.component';
import { JustificantesComponent } from '../shared/justificantes.component';
import { camposDeMotivo, motivoDe, motivosIncompletos, type MotivoLinea } from '../shared/motivos-preventa';

/**
 * Preferencias guardadas en el dispositivo (almacén y origen elegidos): el surtidor no tiene por
 * qué elegirlos cada vez. ⚠️ El nombre no termina en "key": gitleaks tomaba la constante por una
 * clave de API y bloqueaba el PR (falso positivo en #316).
 */
const PREF_ALMACEN = 'gp.surtir.almacen.v1';

/**
 * `[MCP.3.1]` Dos orígenes y no se mezclan (decisión de David, 2026-10-19):
 *  · **Telemarketing**: llega de Kepler (`U-D-40`) y se toma con "Tomar siguiente".
 *  · **Sucursal**: lo que levantan vendedoras y preventa en la app. NO pasa por Kepler antes de
 *    surtirse (se cobra después), así que "Tomar siguiente" no lo ve. Aquí se lista por día
 *    (Hoy / Mañana / Próximos) y el surtidor ELIGE cuál; se surte con estos mismos renglones.
 *
 * Antes había "Todos" y un "Sucursal" que leía Kepler: el surtidor de la 02 elegía "Sucursal" y
 * veía "No hay pedidos por surtir" mientras los pedidos de la vendedora esperaban en otra pantalla
 * (`/almacen/surtir-preventa`) a la que nada lo llevaba. Medido en prod el 2026-10-19: 12 avisos
 * de pedido, cero vistos, cero surtidos de preventa empezados.
 */
type Origen = 'TELEMARK' | 'SUCURSAL';

/** Lo marcado en un pedido de Sucursal vive en el celular hasta "Terminé de surtir". */
const PREF_MARCAS = 'gp.surtir.preventa.v1.';
/** `[MCP.17]` Lo que se surte en otra unidad del mismo producto, también en el celular hasta cerrar. */
const PREF_OTRA = 'gp.surtir.preventa.otra.v1.';
/** `[MCP.18]` El motivo de cada faltante, también en el celular hasta cerrar. */
const PREF_MOTIVO = 'gp.surtir.preventa.motivo.v1.';

/**
 * Lo que va en lugar de lo que faltó de un renglón. `[MCP.17]` el MISMO producto en otra unidad, o
 * `[GP.RF.31]` OTRO producto (`otro: true`, con su nombre para decirlo en pantalla). Al servidor viajan
 * sólo `product_id`, `unit` y `quantity` (`sustitutoParaEnviar`).
 */
type OtraUnidad = { product_id: string; unit: string; quantity: number; otro?: boolean; product_name?: string };
const sustitutoParaEnviar = (x: OtraUnidad): { product_id: string; unit: string; quantity: number } =>
  ({ product_id: x.product_id, unit: x.unit, quantity: x.quantity });

/** Cada cuánto se vuelve a pedir la lista de Sucursal mientras se está viendo. */
const SUCURSAL_CADA_MS = 30_000;

/** "1 pedido" / "3 pedidos": nada de "pedido(s)" en una pantalla que se lee de reojo. */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * `[GP.3b]` **Surtir desde el celular: "Tomar siguiente", marcar renglón por renglón y cerrar.**
 *
 * Reemplaza el ticket impreso `Referencia SURTIDO` y el círculo de pluma sobre la hoja. Modelo
 * decidido por Francisco (2026-10-07, `FASE_GP` §8): el surtidor **jala** su trabajo —el sistema le
 * da la ola libre más vieja de su almacén, no elige cuál— y la consola queda para excepciones.
 *
 * ── Decisiones de uso (revisión de usabilidad, 2026-10-08) ─────────────────────────────────
 *  · **La lista no se mueve bajo el dedo.** Los renglones quedan en su orden; uno marcado se
 *    ENCOGE a una línea con "Corregir" (que sirve de deshacer). Si se fuera a otra sección, el
 *    siguiente subiría justo debajo del pulgar y un segundo toque —o uno con guante— marcaría el
 *    renglón equivocado. Encogidos, 85 renglones caben en una lista que se puede recorrer.
 *  · **La cantidad es lo que se lee de lejos**: va en `--fs-display`, el nombre más chico.
 *  · **Escáner**: busca por código de barras, código y nombre; Enter con un solo resultado manda
 *    el foco a su "Completo" (no lo marca solo: escanear no es haber contado).
 *  · **"No había nada" está separado** del Guardar y a lo ancho: es el toque que más cuesta.
 *  · Cada toque se guarda en el servidor al momento y la pantalla lo dice; sin señal, lo avisa.
 *  · Un faltante NO detiene el surtido (P7: el pedido sale incompleto). Se marca y se sigue.
 *  · No se puede cerrar con renglones sin tocar: "nadie pasó" no es lo mismo que "no había".
 *
 * ⚠️ El orden es el del servidor (pendientes primero, después por ubicación y nombre). La ubicación
 * de cada producto todavía no está dada de alta (`FASE_WMS` §12.5): hoy, en la práctica, por nombre.
 */
@Component({
  selector: 'app-almacen-surtir',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, ToastModule, SelectModule, AlmacenRutasHoyComponent, ClientesNuevosAvisoComponent, FreshnessPillComponent, MotivoChipsComponent, JustificantesComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in sr-page">
      <p-toast position="top-center"></p-toast>
      <!-- Lo que acaba de pasar, para lectores de pantalla (el renglón no se mueve, pero cambia). -->
      <p class="sr-oculto" role="status" aria-live="polite">{{ anuncio() }}</p>

      <header class="sr-top">
        <!-- [GP.RF.35] Con un pedido de preventa abierto, el encabezado ES el pedido: «← Pedidos» regresa a la
             lista (lo marcado sigue en el celular y el pedido queda en «Los que estás surtiendo»). -->
        @if (fase() === 'surtiendo' && pedidoSucursal(); as p) {
          <button pButton type="button" [text]="true" severity="secondary" class="sr-tap" (click)="irAPedidos()">
            <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Pedidos
          </button>
          <div class="sr-top-mid">
            <!-- [GP.RF.38] El encabezado de la vista (h1): recibe el foco al abrir el pedido. -->
            <h1 class="sr-top-cli" id="sr-titulo" tabindex="-1">{{ p.customer_name || 'Cliente sin nombre' }}</h1>
            <span class="sr-top-sub">{{ p.code }} · {{ p.seller_name || 'Sin vendedor' }}</span>
            <!-- [MCP.3.13] Parte de un pedido agrupado. -->
            @if (textoParte(p); as tp) { <span class="sr-top-sub">{{ tp }}</span> }
          </div>
        } @else {
          <button pButton type="button" [text]="true" severity="secondary" class="sr-tap" (click)="salir()">
            <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Salir
          </button>
          <div class="sr-top-mid">
            <h1 id="sr-titulo-lista" tabindex="-1">Surtir</h1>
            @if (almacenNombre()) { <span class="sr-top-sub">{{ almacenNombre() }}</span> }
          </div>
        }
        @if (ola(); as o) {
          <div class="sr-top-prog" aria-hidden="true">{{ hechos() }} / {{ o.lines.length }}</div>
        }
      </header>

      @if (!enLinea()) {
        <div class="sr-banda sr-banda-bad" role="alert">
          <i class="pi pi-wifi" aria-hidden="true"></i>
          <span>Sin conexión. Lo que marques no se va a guardar hasta que vuelva la señal.</span>
        </div>
      }

      @if (atoradas().length) {
        <div class="sr-banda sr-banda-warn" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>Avísale a tu supervisor: {{ plural(atoradas().length, 'surtido armado a mano no se pudo abrir', 'surtidos armados a mano no se pudieron abrir') }}
            ({{ atoradasTexto() }}).</span>
        </div>
      }

      @if (fase() === 'cargando') {
        <div class="sr-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando…</div>
      }

      @if (error()) {
        <div class="sr-banda sr-banda-bad" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="sr-banda-txt">{{ error() }}</span>
          <button pButton type="button" severity="secondary" class="sr-tap" (click)="reintentar()">Reintentar</button>
        </div>
      }

      <!-- ─────────── LA LISTA · [GP.RF.35] rehecha (Edgar, 2026-11-17) ───────────
           Antes: una tarjeta de almacén y origen de ~240 px, el aviso de clientes nuevos arriba de todo y un
           botón naranja enorme por pedido. Ahora: almacén y origen en un renglón, los días en otro, lo que ya
           estás surtiendo primero, cada pedido es una tarjeta que se toca entera, y el aviso de clientes abajo. -->
      @if (fase() === 'listo') {
        <!-- [GP.RF.27] Lo de Telemarketing que quedó a medias se AVISA; antes se retomaba solo al abrir. -->
        @if (olaAMedias(); as o) {
          <!-- [GP.RF.35] Un renglón: el folio y cuántos pedidos (medido: la lista de 12 folios ocupaba ~240 px
               y empujaba los pedidos abajo del pliegue). Los folios se ven al continuar. -->
          <section class="sr-medias" role="status">
            <i class="pi pi-history" aria-hidden="true"></i>
            <span class="sr-banda-txt">Telemarketing a medias: <b class="sr-ola-code">{{ o.code }}</b>@if (o.pedidos.length) { · {{ plural(o.pedidos.length, 'pedido', 'pedidos') }} }</span>
            <button pButton type="button" class="sr-tap" (click)="continuarOla(o)">Continuar</button>
          </section>
        }
        <!-- [GP.RF.28][GP.RF.35] Almacén (por nombre) y origen en UN renglón. Con un solo almacén, su nombre va arriba.
             [GP.RF.41] Cada control lleva su rótulo VISIBLE encima (antes sólo aria-label: con el almacén ya
             elegido, el selector mostraba un nombre sin decir qué era). Los controles siguen en un renglón. -->
        <section class="sr-cab">
          @if (almacenes().length > 1) {
            <div class="sr-campo sr-campo-alm">
              <span class="sr-l" id="sr-alm-l">Almacén</span>
              <p-select inputId="sr-alm" [options]="almacenes()" optionLabel="name" optionValue="id" [ngModel]="almacenId() || null"
                        (ngModelChange)="elegirAlmacen($event ?? '')" placeholder="Elige tu almacén" appendTo="body"
                        styleClass="sr-select" ariaLabelledBy="sr-alm-l" />
            </div>
          }
          <div class="sr-campo">
            <span class="sr-l" id="sr-origen-l">Pedidos de</span>
            <div class="sr-chips sr-origen" role="radiogroup" aria-labelledby="sr-origen-l">
              @for (op of origenes; track op.v) {
                <button type="button" class="sr-chip" role="radio" [attr.aria-checked]="origen() === op.v"
                        [class.sr-chip-on]="origen() === op.v" (click)="elegirOrigen(op.v)">{{ op.l }}</button>
              }
            </div>
          </div>
        </section>
        @if (!almacenId()) { <p class="sr-tip">Elige primero tu almacén.</p> }

        @if (origen() === 'TELEMARK') {
          <section class="sr-tm">
            <button type="button" class="sr-btn sr-btn-go" [disabled]="!almacenId() || tomando()" (click)="tomar()">
              @if (tomando()) {
                <i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Buscando trabajo…</span>
              } @else {
                <i class="pi pi-play" aria-hidden="true"></i><span>Tomar siguiente</span>
              }
            </button>
            @if (almacenId()) { <p class="sr-tip">Te toca el pedido que más urge. No se elige cuál.</p> }
            <!-- [MCP.3.2] La lista de pedidos autorizados (folio y cliente): Surtir no tiene pestañas. -->
            <button pButton type="button" [text]="true" severity="secondary" class="sr-tap sr-ver-lista" (click)="verLista()">
              <span class="p-button-icon p-button-icon-left pi pi-list" aria-hidden="true"></span> Ver la lista de pedidos
            </button>
          </section>
        }

        <!-- [MCP.3.1] Preventa: por día de entrega, el surtidor elige cuál. -->
        @if (origen() === 'SUCURSAL' && almacenId()) {
          <!-- [MCP.3.6] Las rutas de hoy van arriba; los pedidos sueltos de siempre, debajo. -->
          <app-almacen-rutas-hoy (hayRutas)="rutasHoy.set($event)"></app-almacen-rutas-hoy>
          <!-- [GP.RF.38] h1 Surtir › h2 «Rutas de hoy» / «Pedidos sueltos» › h3 por vendedor; sin rutas, h2 por vendedor. -->
          @if (rutasHoy() > 0) { <h2 class="sr-h3">Pedidos sueltos</h2> }
          @if (sucursalError()) {
            <div class="sr-banda sr-banda-bad" role="alert">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span class="sr-banda-txt">{{ sucursalError() }}</span>
              <button pButton type="button" severity="secondary" class="sr-tap" (click)="cargarSucursal()">Reintentar</button>
            </div>
          }
          @if (sucursal()?.scope === 'ninguno') {
            <div class="sr-banda sr-banda-warn" role="status">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <span>Tu usuario no tiene una sucursal asignada. Pide que te la asignen en Administración › Personas.</span>
            </div>
          }
          @if (sucursal()) {
            <div class="sr-dias">
              <div class="sr-chips" role="radiogroup" aria-label="Día de entrega">
                @for (d of dias; track d.v) {
                  <button type="button" class="sr-chip" role="radio" [attr.aria-checked]="dia() === d.v && !diaAtrasado()"
                          [class.sr-chip-on]="dia() === d.v && !diaAtrasado()" (click)="elegirDia(d.v)">{{ d.l }} · {{ porDia()[d.v] }}</button>
                }
                <!-- [MCP.24] El día atrasado abierto desde el aviso queda elegido hasta volver a una pestaña. -->
                @if (diaAtrasado(); as f) {
                  <button type="button" class="sr-chip sr-chip-on" role="radio" aria-checked="true">{{ etiqueta(f) }} · {{ pedidosDelDia().length }}</button>
                }
              </div>
              <!-- §9 La lista se vuelve a pedir cada 30 s: su edad se ve. -->
              <app-freshness-pill measures="fetch" [since]="sucursalAl()" [staleAfterSec]="90"></app-freshness-pill>
            </div>
            <!-- [MCP.24] Lo pendiente de días anteriores no se mezcla con hoy, pero tampoco se esconde: por día.
                 [GP.RF.35] En un renglón que se desliza, no en una caja de varios renglones. -->
            @if (dia() === 'hoy' && !diaAtrasado() && atrasados().length) {
              <section class="sr-atras" aria-label="Pendientes de días anteriores">
                <p class="sr-atras-t"><i class="pi pi-history" aria-hidden="true"></i>
                  {{ plural(totalAtrasados(), 'pedido pendiente', 'pedidos pendientes') }} de días anteriores</p>
                <div class="sr-chips sr-desliza">
                  @for (a of atrasados(); track a.fecha) {
                    <button type="button" class="sr-chip" (click)="verAtrasado(a.fecha)">{{ etiqueta(a.fecha) }} · {{ a.n }}</button>
                  }
                </div>
              </section>
            }
            <!-- [MCP.24] Por vendedor: «Todos» conserva los encabezados; uno deja sólo los suyos. -->
            @if (opcionesVendedor().length > 2) {
              <div class="sr-chips sr-desliza" role="radiogroup" aria-label="Vendedor">
                @for (o of opcionesVendedor(); track o.v) {
                  <button type="button" class="sr-chip" role="radio" [attr.aria-checked]="(vendedorEfectivo() ?? '') === o.v"
                          [class.sr-chip-on]="(vendedorEfectivo() ?? '') === o.v" (click)="vendedor.set(o.v || null)">{{ o.l }}</button>
                }
              </div>
            }
            @if (!pedidosDelDia().length) {
              <p class="sr-tip sr-sec-vacia">No hay pedidos de preventa {{ diaTexto() }}.</p>
            }
            <!-- [MCP.14] Lo que ya empezó esta persona, primero; lo demás separado por vendedor y en orden de
                 folio (la pantalla del PDF de rutas vecinales: «separar los pedidos x vendedor»). -->
            @if (misEnCurso().length) {
              <h2 class="sr-grupo" [attr.aria-level]="rutasHoy() > 0 ? 3 : null"><i class="pi pi-play" aria-hidden="true"></i> Los que estás surtiendo
                <span class="sr-grupo-n">· {{ plural(misEnCurso().length, 'pedido', 'pedidos') }}</span></h2>
              @for (p of misEnCurso(); track p.order_id) {
                <ng-container *ngTemplateOutlet="tarjetaPedido; context: { $implicit: p, conVendedor: true }"></ng-container>
              }
            }
            @for (g of gruposDelDia(); track g.vendedor) {
              <h2 class="sr-grupo" [attr.aria-level]="rutasHoy() > 0 ? 3 : null"><i class="pi pi-user" aria-hidden="true"></i> {{ g.vendedor }}
                <span class="sr-grupo-n">· {{ plural(g.pedidos.length, 'pedido', 'pedidos') }}</span></h2>
              @for (p of g.pedidos; track p.order_id) {
                <ng-container *ngTemplateOutlet="tarjetaPedido; context: { $implicit: p, conVendedor: false }"></ng-container>
              }
            }
            <!-- [GP.RF.35] La tarjeta entera se toca (antes: un botón naranja enorme por pedido, que en una lista de 30
                 eran 30 llamados a la vez). El naranja queda sólo en «Continuar» de lo que ya estás surtiendo. -->
            <ng-template #tarjetaPedido let-p let-conVendedor="conVendedor">
              @if (p.state === 'surtiendo' && !esMio(p)) {
                <article class="sr-ped sr-ped-otro" [class.sr-ped-tarde]="p.days_late > 0" [attr.data-pedido]="p.order_id">
                  <span class="sr-ped-r1"><strong class="sr-ped-cli">{{ p.customer_name || 'Cliente sin nombre' }}</strong>
                    <span class="sr-ped-n">{{ plural(p.lines, 'producto', 'productos') }}</span></span>
                  <span class="sr-ped-r2"><span class="sr-ola-code">{{ p.code }}</span></span>
                  <span class="sr-ped-go">Lo está surtiendo {{ p.started?.name }}.</span>
                </article>
              } @else {
                <button type="button" class="sr-ped" [class.sr-ped-tarde]="p.days_late > 0" [class.sr-ped-mio]="p.state === 'surtiendo'" [attr.data-pedido]="p.order_id"
                        [disabled]="tomando()" (click)="surtirPedido(p.order_id)">
                  <span class="sr-ped-r1"><strong class="sr-ped-cli">{{ p.customer_name || 'Cliente sin nombre' }}</strong>
                    <span class="sr-ped-n">{{ plural(p.lines, 'producto', 'productos') }}</span></span>
                  <span class="sr-ped-r2">
                    <span class="sr-ola-code">{{ p.code }}</span><span>{{ dinero(p.total) }}</span>
                    @if (conVendedor) { <span>{{ p.seller_name || 'Sin vendedor' }}</span> }
                    @if (p.days_late > 0) { <span class="sr-tag-tarde">{{ p.days_late === 1 ? 'Atrasado 1 día' : 'Atrasado ' + p.days_late + ' días' }}</span> }
                    @else if (dia() === 'proximos') { <span>Entrega {{ fechaCorta(p.requested_delivery_date) }}</span> }
                  </span>
                  @if (sinClave().has(p.order_id) || textoParte(p) || p.instructions) {
                    <span class="sr-ped-tags">
                      @if (sinClave().has(p.order_id)) { <span class="sr-tag-nuevo">Cliente nuevo · sin clave de Kepler</span> }
                      <!-- [MCP.3.13] Parte de un pedido agrupado: el resto se surte en otra sucursal. -->
                      @if (textoParte(p); as tp) { <span class="sr-tag-parte">{{ tp }}</span> }
                      <!-- [MCP.3.15] Trae indicaciones del vendedor: se ven completas al abrirlo. -->
                      @if (p.instructions) { <span class="sr-tag-ind"><i class="pi pi-megaphone" aria-hidden="true"></i> Con indicaciones del vendedor</span> }
                    </span>
                  }
                  <span class="sr-ped-go">
                    @if (tomandoId() === p.order_id) {
                      <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Abriendo…
                    } @else if (p.state === 'surtiendo') {
                      Continuar <i class="pi pi-angle-right" aria-hidden="true"></i>
                    } @else {
                      Surtir este <i class="pi pi-angle-right" aria-hidden="true"></i>
                    }
                  </span>
                </button>
              }
            </ng-template>
          } @else if (cargandoSucursal()) {
            <div class="sr-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando pedidos…</div>
          }
        }
        <!-- [MCP.3.8][GP.RF.35] Clientes nuevos sin clave de Kepler: abajo, no es la tarea del surtidor; lleva a ligarlos. -->
        <app-clientes-nuevos-aviso class="sr-nuevos" (sinClave)="sinClave.set($event)"></app-clientes-nuevos-aviso>

        @if (sinTrabajo(); as s) {
          <section class="sr-card sr-vacio">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <h2>No hay pedidos por surtir</h2>
            <p>{{ s.motivo }}</p>
            @if (s.armado; as a) {
              @if (a.bloqueados.length) {
                <p class="sr-aviso">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  {{ plural(a.bloqueados.length, 'pedido no se puede surtir', 'pedidos no se pueden surtir') }}. Avísale a tu supervisor:
                </p>
                <ul class="sr-lista-min">
                  @for (b of a.bloqueados; track b.code) { <li><strong>{{ b.code }}</strong> — {{ b.motivo }}</li> }
                </ul>
              }
              @if (a.atorados.count) {
                <p class="sr-tip">
                  {{ plural(a.atorados.count, 'pedido sigue autorizado', 'pedidos siguen autorizados') }} en Kepler desde el
                  {{ a.atorados.desde }} y no entran a la fila. Hay que cerrarlos en Kepler.
                </p>
              }
            }
          </section>
        }
      }

      <!-- ─────────── SURTIENDO · [GP.RF.35] el escáner fijo arriba, cada producto empieza por DÓNDE está ─────────── -->
      @if (fase() === 'surtiendo' && ola(); as o) {
        <!-- [MCP.23] En preventa no van notas de explicación arriba del pedido (las quitó David el 2026-11-13):
             el cliente y el vendedor ya están en el encabezado. Telemarketing conserva su ola. -->
        @if (!pedidoSucursal()) {
          <section class="sr-ola">
            <span class="sr-ola-code">{{ o.code }}</span>
            <span class="sr-ola-ped">{{ plural(o.pedidos.length, 'pedido', 'pedidos') }}: {{ o.pedidos.join(', ') }}</span>
            <span class="sr-ola-ped"><i class="pi pi-cloud" aria-hidden="true"></i> Cada toque se guarda al momento.</span>
            <span class="sr-ola-ped"><i class="pi pi-clock" aria-hidden="true"></i> {{ existenciaAlTexto(o.existencia_al) }}</span>
          </section>
        }

        <!-- [MCP.3.15] Indicaciones del vendedor: un solo recuadro por pedido, en grande, arriba de la lista. -->
        @if (pedidoSucursal()?.instructions; as ind) {
          <section class="sr-ind" role="note" aria-labelledby="sr-ind-t">
            <span class="sr-ind-eye" id="sr-ind-t"><i class="pi pi-megaphone" aria-hidden="true"></i> Indicaciones del vendedor</span>
            <p class="sr-ind-txt">{{ ind }}</p>
            <label class="sr-ind-chk">
              <input type="checkbox" id="sr-ind-ok" [checked]="indicacionesOk()" (change)="indicacionesOk.set($any($event.target).checked)" />
              Cumplí las indicaciones
            </label>
          </section>
        }
        <!-- [MCP.18] Por qué cambió el pedido antes de que lo tomaras (D5: los tres roles ven todo). -->
        @if (pedidoSucursal()) {
          <app-justificantes [items]="justificantesPedido()" idBase="sr-jf"></app-justificantes>
        }

        <!-- [GP.RF.35] Fijo arriba al desplazar: escanear el siguiente no obliga a volver a subir. El avance va pegado. -->
        <div class="sr-fijo">
          <section class="sr-buscar">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input id="sr-buscar" class="sr-buscar-input" type="text" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event); avisoEscaneo.set(null)"
                   (keydown.enter)="enterBuscar()" autocomplete="off" aria-label="Buscar producto"
                   placeholder="Escanea la etiqueta o escribe el nombre" />
            @if (busqueda()) {
              <button pButton type="button" [text]="true" severity="secondary" class="sr-tap" (click)="limpiarBusqueda()">Limpiar</button>
            }
          </section>
          <div class="sr-barra" role="progressbar" aria-label="Avance del surtido" [attr.aria-valuenow]="hechos()"
               [attr.aria-valuemin]="0" [attr.aria-valuemax]="o.lines.length"
               [attr.aria-valuetext]="hechos() + ' de ' + o.lines.length + ' renglones'">
            <span [style.--fill]="o.lines.length ? hechos() / o.lines.length : 0"></span>
          </div>
          <!-- [GP.RF.33] Lo escaneado no se pudo marcar solo: por qué. -->
          @if (avisoEscaneo(); as a) { <p class="sr-tip sr-tip-bad sr-aviso-esc" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a }}</p> }
        </div>

        <div class="sr-filtro">
          <h2 class="sr-h3">
            @if (busqueda()) { {{ plural(visibles().length, 'coincidencia', 'coincidencias') }} }
            @else { Por surtir <span class="sr-n">{{ pendientesTotal() }} de {{ o.lines.length }}</span> }
          </h2>
          @if (hechos() && !busqueda()) {
            <button type="button" class="sr-chip" [attr.aria-pressed]="ocultarHechos()" [class.sr-chip-on]="ocultarHechos()"
                    (click)="ocultarHechos.set(!ocultarHechos())">Ocultar los ya surtidos</button>
          }
        </div>

        @if (busqueda() && !visibles().length) {
          <p class="sr-sinhit">Ningún renglón de este surtido coincide con «{{ busqueda() }}». Revisa que el producto sea de este pedido.</p>
        } @else if (!pendientesTotal()) {
          <p class="sr-tip sr-tip-ok"><i class="pi pi-check" aria-hidden="true"></i> Ya pasaste por todos los renglones. Revisa y termina.</p>
        }

        @for (l of visibles(); track l.id) {
          @if (l.status === 'pendiente' || editando() === l.id) {
            <!-- Renglón por surtir (o abierto para corregir): grande, con los botones del pulgar. -->
            <article class="sr-ren">
              <!-- [GP.RF.34][GP.RF.35] Lo primero es DÓNDE está: a eso camina el surtidor. En preventa, sólo si el
                   servidor mandó el dato (sin él no se afirma «sin ubicación»). -->
              @if (lugarDe(l); as lg) {
                <p class="sr-lugar" [class.sr-lugar-no]="!lg.code">
                  <i class="pi pi-map-marker" aria-hidden="true"></i>
                  @if (lg.code) { Ubicación <span class="sr-lugar-code">{{ lg.code }}</span> } @else { Sin ubicación dada de alta }
                </p>
              }
              <div class="sr-ren-cab">
                <div class="sr-ren-prod">
                  <strong>{{ l.product_name || l.sku }}</strong>
                  <span class="sr-sku">{{ l.sku }}</span>
                </div>
                <div class="sr-cant" [attr.aria-label]="'Surtir ' + cantidadPrincipal(l)">
                  <span class="sr-cant-n">{{ cantidadNumero(l) }}</span>
                  <span class="sr-cant-u">{{ unidadConteo(l) }}</span>
                </div>
              </div>
              @if (cantidadBase(l); as b) { <span class="sr-cant-b">{{ b }}</span> }
              <!-- [GP.3c] Certeza antes de caminar: cuánto dice el sistema que hay. -->
              @if (!pedidoSucursal()) {
                <div class="sr-datos">
                  <span class="sr-dato" [ngClass]="'sr-exist-' + existenciaEstado(l)">
                    <i class="pi" [class.pi-box]="existenciaEstado(l) !== 'cero' && existenciaEstado(l) !== 'poca'"
                       [class.pi-exclamation-triangle]="existenciaEstado(l) === 'cero' || existenciaEstado(l) === 'poca'" aria-hidden="true"></i>
                    {{ existenciaTexto(l) }}
                  </span>
                </div>
              } @else {
                <!-- [MCP.23] En un pedido de Sucursal, la existencia que trae el servidor por renglón. Sin ella
                     (servidor anterior) no se pinta nada; si no se pudo leer, dice «sin dato», nunca cero. -->
                @if (sistemaDe(l); as h) {
                  <div class="sr-datos">
                    <span class="sr-dato sr-sistema" [class.sr-sistema-no]="sinProductoDe(l)"><i class="pi pi-box" aria-hidden="true"></i>{{ h }}</span>
                  </div>
                }
              }
              @if (l.unidad_mixta) {
                <p class="sr-tip"><i class="pi pi-info-circle" aria-hidden="true"></i> Los pedidos lo piden en unidades distintas: cuenta en {{ unidadConteo(l) }}.</p>
              }
              <!-- [GP.9.2] La caja que tiene enfrente puede no ser la de la hoja (caso Canindo). -->
              @if (l.aviso_caja; as a) {
                <p class="sr-tip sr-tip-caja" [class.sr-tip-bad]="a.tipo === 'capturada_con_otra'" role="note">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a.texto }}
                </p>
              }

              @if (editando() === l.id) {
                <div class="sr-falta">
                  <label class="sr-l" [for]="'sr-q-' + l.id">¿Cuánto levantaste? ({{ unidadConteo(l) }})</label>
                  <input [id]="'sr-q-' + l.id" class="sr-falta-input" type="number" [attr.inputmode]="modoTeclado(l)"
                         step="any" min="0" [attr.aria-describedby]="'sr-qh-' + l.id"
                         [ngModel]="borrador()" (ngModelChange)="borrador.set($event)"
                         (keydown.enter)="!guardando().has(l.id) && guardarFaltante(l)" (keydown.escape)="cerrarEditor()"
                         (wheel)="$any($event.target).blur()" autocomplete="off" />
                  <p class="sr-tip" [id]="'sr-qh-' + l.id" [class.sr-tip-bad]="borradorFueraDeRango(l)">
                    @if (borradorFueraDeRango(l)) { No puede ser más de {{ cantidadPrincipal(l) }}. }
                    @else { Entre 0 y {{ cantidadPrincipal(l) }}. }
                  </p>
                  <!-- [MCP.23] Va a quitar algo que el sistema dice que hay: que lo busque antes. No bloquea. -->
                  @if (buscarEnBodega(l, borrador()); as a) {
                    <p class="sr-bodega" role="note"><i class="pi pi-search" aria-hidden="true"></i> {{ a }}</p>
                  }
                  <div class="sr-falta-acc">
                    <button pButton type="button" severity="secondary" [outlined]="true" class="sr-tap" (click)="cerrarEditor()">Cancelar</button>
                    <button pButton type="button" class="sr-tap" [disabled]="!borradorValido(l) || guardando().has(l.id)"
                            [loading]="guardando().has(l.id)" (click)="guardarFaltante(l)">Guardar</button>
                  </div>
                  <!-- Separado y a lo ancho: es la afirmación más fuerte ("no había NADA") y no se
                       debe tocar por error al buscar Guardar. -->
                  <button type="button" class="sr-nada" [disabled]="guardando().has(l.id)" (click)="noHabia(l)">
                    <i class="pi pi-times-circle" aria-hidden="true"></i> No había nada
                  </button>
                </div>
              } @else {
                <div class="sr-acc">
                  <button type="button" class="sr-btn sr-btn-ok" [id]="'sr-ok-' + l.id"
                          [disabled]="guardando().has(l.id)" (click)="completo(l)">
                    <i class="pi" [class.pi-check]="!guardando().has(l.id)" [class.pi-spin]="guardando().has(l.id)"
                       [class.pi-spinner]="guardando().has(l.id)" aria-hidden="true"></i>
                    <span>Completo</span>
                  </button>
                  <button type="button" class="sr-btn sr-btn-falta" [disabled]="guardando().has(l.id)" (click)="abrirFaltante(l)">
                    <i class="pi pi-minus-circle" aria-hidden="true"></i><span>Faltó</span>
                  </button>
                </div>
              }
            </article>
          } @else {
            <!-- Ya surtido: una línea. Queda EN SU LUGAR para que la lista no se mueva bajo el dedo. -->
            <article class="sr-hecho" [class.sr-hecho-falta]="l.status !== 'surtido'">
              <span class="sr-hecho-n">{{ l.product_name || l.sku }}</span>
              @switch (l.status) {
                @case ('surtido') { <p-tag severity="success" value="Completo"></p-tag> }
                @case ('agotado') { <p-tag severity="danger" value="No había"></p-tag> }
                @default { <p-tag severity="warn" [value]="faltaronTexto(l)"></p-tag> }
              }
              <button pButton type="button" [text]="true" class="sr-tap" (click)="abrirFaltante(l)"
                      [attr.aria-label]="'Corregir ' + (l.product_name || l.sku)">Corregir</button>
            </article>
            <!-- [MCP.23] Ya lo marcó con faltante y el sistema dice que hay: el aviso sigue a la vista para corregir. -->
            @if (l.status !== 'surtido' && buscarEnBodega(l, l.qty_picked); as a) {
              <p class="sr-bodega" role="note"><i class="pi pi-search" aria-hidden="true"></i> {{ a }}</p>
            }
            <!-- [MCP.18] Por qué faltó: ya viene «No había en la sucursal» (lo que dice el botón); se cambia con un toque. -->
            @if (pedidoSucursal() && l.status !== 'surtido') {
              <app-motivo-chips class="sr-motivo" [opciones]="motivosSurtido" [valor]="motivoDeLinea(l.id)" [idBase]="'sr-mot-' + l.id"
                                [etiqueta]="'Por qué faltó ' + (l.product_name || l.sku)" (cambio)="ponerMotivo(l.id, $event)"></app-motivo-chips>
            }
            <!-- [MCP.17] Pidieron 1 CJA y no hubo caja completa: lo que faltó se surte en una presentación más
                 chica del MISMO producto. Sólo en pedidos de Sucursal (los cierra el servidor de preventa). -->
            @if (pedidoSucursal() && l.status !== 'surtido') {
              <div class="sr-otra-fila">
                @if (otraUnidad()[l.id]; as ou) {
                  @if (ou.otro) {
                    <span class="sr-otra-tag"><i class="pi pi-sync" aria-hidden="true"></i> En su lugar: {{ fmtNum(ou.quantity) }} {{ ou.unit }} de {{ ou.product_name }}</span>
                  } @else {
                    <span class="sr-otra-tag"><i class="pi pi-box" aria-hidden="true"></i> Van {{ fmtNum(ou.quantity) }} {{ ou.unit }} en otra unidad</span>
                  }
                  <button pButton type="button" [text]="true" class="sr-tap" (click)="quitarOtraUnidad(l)"
                          [attr.aria-label]="'Quitar lo que va en lugar de ' + (l.product_name || l.sku)">Quitar</button>
                } @else if (otraAbierta() !== l.id && cambioAbierto() !== l.id) {
                  <button pButton type="button" [text]="true" class="sr-tap" (click)="abrirOtraUnidad(l)"
                          [attr.aria-label]="'Surtir en otra unidad ' + (l.product_name || l.sku)">
                    <i class="pi pi-box" aria-hidden="true"></i>&nbsp;Surtir en otra unidad</button>
                  <!-- [GP.RF.31] Otro producto en lugar de lo que faltó: antes sólo existía en la pantalla que el surtidor no usa. -->
                  <button pButton type="button" [text]="true" class="sr-tap" (click)="abrirCambio(l)"
                          [attr.aria-label]="'Cambiar por otro producto ' + (l.product_name || l.sku)">
                    <i class="pi pi-sync" aria-hidden="true"></i>&nbsp;Cambiar por otro producto</button>
                }
              </div>
              @if (cambioAbierto() === l.id) {
                <div class="sr-falta sr-otra" role="group" [attr.aria-label]="'Cambiar ' + (l.product_name || l.sku) + ' por otro producto'">
                  <label class="sr-l" for="sr-cambio-q">Faltan {{ fmtNum(faltanDe(l)) }} {{ unidadConteo(l) }}. ¿Con qué lo cambias?</label>
                  <input id="sr-cambio-q" class="sr-falta-input" type="search" enterkeyhint="search" autocomplete="off"
                         placeholder="Nombre, SKU o código" [ngModel]="cambioBusca()" (ngModelChange)="buscarCambio(l, $event)" />
                  @switch (cambioCarga().estado) {
                    @case ('cargando') { <p class="sr-tip"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando productos con existencia…</p> }
                    @case ('error') {
                      <p class="sr-tip sr-tip-bad">{{ cambioCarga().msg }}</p>
                      <button pButton type="button" severity="secondary" [outlined]="true" class="sr-tap" (click)="cargarCambios(l)">Reintentar</button>
                    }
                    @default {
                      @if (!cambioElegido()) {
                        @if (!cambioBusca().trim()) { <p class="sr-tip">Con existencia en tu sucursal y palabras del nombre o del proveedor en común. Tú decides si se parece.</p> }
                        @if (!cambioCarga().data?.data?.length) {
                          <p class="sr-tip">{{ cambioBusca().trim() ? 'Nada con existencia con esa búsqueda.' : 'Sin sugerencias: búscalo por nombre, SKU o código.' }}</p>
                        }
                        <ul class="sr-cambio-lista">
                          @for (x of cambioCarga().data?.data ?? []; track x.product_id) {
                            <li>
                              <button type="button" class="sr-cambio-item" [disabled]="usadoEnOtroRenglon(x.product_id, l.id)" (click)="elegirCambio(l, x)">
                                <strong>{{ x.product_name }}</strong>
                                <span class="sr-tip">{{ x.sku }} · {{ precioCambio(x) }} · {{ existenciaCambio(x) }}@if (usadoEnOtroRenglon(x.product_id, l.id)) { · ya va en otro renglón }</span>
                              </button>
                            </li>
                          }
                        </ul>
                      } @else {
                        @if (cambioElegido(); as x) {
                          <p class="sr-l">{{ x.product_name }}</p>
                          @if (x.units.length > 1) {
                            <div class="sr-chips" role="radiogroup" aria-label="Unidad">
                              @for (u of x.units; track u.unit) {
                                <button type="button" class="sr-chip" role="radio" [attr.aria-checked]="cambioUnidad() === u.unit"
                                        [class.sr-chip-on]="cambioUnidad() === u.unit" (click)="cambioUnidad.set(u.unit)">{{ u.unit }}</button>
                              }
                            </div>
                          }
                          <label class="sr-l" for="sr-cambio-n">¿Cuántos {{ cambioUnidad() }}?</label>
                          <input id="sr-cambio-n" class="sr-falta-input" type="number" inputmode="numeric" min="1"
                                 [ngModel]="cambioCant()" (ngModelChange)="cambioCant.set($event)" (keydown.enter)="ponerCambio(l)"
                                 (wheel)="$any($event.target).blur()" autocomplete="off" />
                          <button pButton type="button" [text]="true" class="sr-tap" (click)="cambioElegido.set(null)">Elegir otro</button>
                        }
                      }
                    }
                  }
                  <div class="sr-falta-acc">
                    <button pButton type="button" severity="secondary" [outlined]="true" class="sr-tap" (click)="cerrarCambio()">Cancelar</button>
                    <button pButton type="button" class="sr-tap" [disabled]="!cambioValido()" (click)="ponerCambio(l)">Poner</button>
                  </div>
                </div>
              }
              @if (otraAbierta() === l.id) {
                <div class="sr-falta sr-otra" role="group" [attr.aria-label]="'Surtir ' + (l.product_name || l.sku) + ' en otra unidad'">
                  @switch (otraCarga().estado) {
                    @case ('cargando') { <p class="sr-tip"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando sus presentaciones…</p> }
                    @case ('error') {
                      <p class="sr-tip sr-tip-bad">{{ otraCarga().msg }}</p>
                      <button pButton type="button" severity="secondary" [outlined]="true" class="sr-tap" (click)="abrirOtraUnidad(l)">Reintentar</button>
                    }
                    @default {
                      @if (otraCarga().data; as d) {
                        @if (!d.units.length) {
                          <p class="sr-tip">Kepler no tiene una presentación más chica que {{ d.unit }} para este producto.</p>
                        } @else {
                          <p class="sr-l">No hubo {{ d.unit }} completa: ¿en qué lo surtes?</p>
                          <div class="sr-chips" role="radiogroup" aria-label="Unidad">
                            @for (u of d.units; track u.unit) {
                              <button type="button" class="sr-chip" role="radio" [attr.aria-checked]="otraElegida() === u.unit"
                                      [class.sr-chip-on]="otraElegida() === u.unit" (click)="otraElegida.set(u.unit)">{{ u.unit }} de {{ fmtNum(u.factor) }}</button>
                            }
                          </div>
                          <label class="sr-l" for="sr-otra-q">¿Cuántos {{ otraElegida() }}? Caben hasta {{ fmtNum(otraTope(l)) }}</label>
                          <input id="sr-otra-q" class="sr-falta-input" type="number" inputmode="numeric" min="1" [attr.max]="otraTope(l)"
                                 [ngModel]="otraCant()" (ngModelChange)="otraCant.set($event)"
                                 (keydown.enter)="ponerOtraUnidad(l)" (keydown.escape)="otraAbierta.set(null)"
                                 (wheel)="$any($event.target).blur()" autocomplete="off" />
                          @if (otraCant() != null && !otraValida(l)) {
                            <p class="sr-tip sr-tip-bad">Entre 1 y {{ fmtNum(otraTope(l)) }} {{ otraElegida() }}: no se surte más de lo que faltó.</p>
                          }
                        }
                      }
                    }
                  }
                  <div class="sr-falta-acc">
                    <button pButton type="button" severity="secondary" [outlined]="true" class="sr-tap" (click)="otraAbierta.set(null)">Cancelar</button>
                    <button pButton type="button" class="sr-tap" [disabled]="!otraValida(l)" (click)="ponerOtraUnidad(l)">Poner</button>
                  </div>
                </div>
              }
            }
          }
        }

        <footer class="sr-pie">
          <div class="sr-pie-n">
            @if (pendientesTotal()) {
              <span class="sr-pend">{{ plural(pendientesTotal(), 'renglón sin tocar', 'renglones sin tocar') }}</span>
            } @else {
              <span class="sr-pend sr-pend-cero">Todos tocados</span>
            }
            @if (conFaltante()) { · <span class="sr-falt">{{ plural(conFaltante(), 'con faltante', 'con faltante') }}</span> }
            @if (faltaMarcarIndicaciones()) { · <span class="sr-falt">Falta marcar «Cumplí las indicaciones»</span> }
            @if (motivosSinCompletar().length) { · <span class="sr-falt">Escribe cuál fue el «Otro motivo»</span> }
          </div>
          <button type="button" class="sr-btn sr-btn-go sr-btn-fin" [disabled]="pendientesTotal() > 0 || faltaMarcarIndicaciones() || motivosSinCompletar().length > 0 || cerrando()" (click)="cerrar()">
            <i class="pi" [class.pi-check]="!cerrando()" [class.pi-spin]="cerrando()" [class.pi-spinner]="cerrando()" aria-hidden="true"></i>
            <span>Terminé de surtir</span>
          </button>
        </footer>
      }

      <!-- ─────────── CERRADA ─────────── -->
      @if (fase() === 'cerrada') {
        <section class="sr-card sr-listo">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <h2>Surtido terminado</h2>
          <p>
            {{ plural(resumen().completos, 'renglón completo', 'renglones completos') }}
            · {{ plural(resumen().faltantes, 'con faltante', 'con faltante') }}
          </p>
          @if (resumen().cambios.length) {
            <p class="sr-aviso">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              El pedido cambió en Kepler mientras surtías. Se repartió contra lo que surtiste; avísale a quien cheque:
            </p>
            <ul class="sr-lista-min">
              @for (c of resumen().cambios; track c) { <li>{{ c }}</li> }
            </ul>
          }
          @if (reporte(); as r) {
            <!-- [MCP.3.1] Pedido de Sucursal: lo que se quitó del pedido y el total nuevo. -->
            @if (r.removed.length || r.adjusted.length) {
              <p class="sr-aviso">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Se ajustó el pedido y ya se le avisó a la vendedora:
              </p>
              <ul class="sr-lista-min">
                @for (x of r.removed; track x.product_name) { <li>Se quitó <strong>{{ x.product_name }}</strong> ({{ fmtNum(x.ordered) }} {{ x.unit }}){{ motivoReporte(x) }}</li> }
                @for (x of r.adjusted; track x.product_name) { <li><strong>{{ x.product_name }}</strong>: hubo {{ fmtNum(x.picked) }} de {{ fmtNum(x.ordered) }} {{ x.unit }}{{ motivoReporte(x) }}</li> }
                <!-- [MCP.17] Lo surtido en otra unidad del mismo producto (y [MCP.13] por otro producto). -->
                @for (x of r.substituted ?? []; track x.line_id) {
                  @if (x.same_product) { <li><strong>{{ x.product_name }}</strong>: van {{ fmtNum(x.quantity) }} {{ x.unit }} en otra unidad</li> }
                  @else { <li><strong>{{ x.product_name }}</strong> en lugar de {{ x.for_product_name }} ({{ fmtNum(x.quantity) }} {{ x.unit }})</li> }
                }
              </ul>
              <p class="sr-tip">Total: {{ dinero(r.total_before) }} → <strong>{{ dinero(r.total_after) }}</strong></p>
            }
          }
          @if (origen() === 'SUCURSAL') {
            <button type="button" class="sr-btn sr-btn-go" (click)="volverALista()">
              <i class="pi pi-list" aria-hidden="true"></i><span>Ver pedidos</span>
            </button>
          } @else {
            <button type="button" class="sr-btn sr-btn-go" [disabled]="tomando()" (click)="tomar()">
              <i class="pi pi-play" aria-hidden="true"></i><span>Tomar siguiente</span>
            </button>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    /* [GP.RF.35] Sin el gap de .surf-page (1rem): los hijos ya traen su margen y cada componente VACÍO (rutas de
       hoy, justificantes) sumaba otro hueco. Medido a 390 px: ~48 px entre el origen y los días. */
    .sr-page { max-width: 46rem; gap: 0; }
    .sr-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .sr-msg { display: flex; align-items: center; gap: .6rem; padding: 1.25rem; color: var(--text-muted); }
    /* Botones de texto de la pantalla: también del pulgar (pre-vuelo 11). */
    .sr-tap { min-height: var(--tap-min); }

    .sr-top { display: flex; align-items: center; gap: .75rem; margin-bottom: .5rem; }
    .sr-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .sr-top-mid strong { font-size: var(--fs-h3); }
    /* [GP.RF.38] El título de la vista es un h1 (antes un <strong>: la pantalla no tenía encabezado principal).
       Se ve igual que antes; el nombre del cliente ya no se corta con «…»: un encabezado se lee entero. */
    .sr-top-mid h1 { margin: 0; font-size: var(--fs-h3); font-weight: 700; line-height: 1.25; text-wrap: balance; overflow-wrap: break-word; }
    .sr-top-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    /* [GP.RF.35] Almacén y origen en un renglón. */
    /* Un solo renglón a 390 px (medido: con wrap, almacén y origen ocupaban dos). El nombre del almacén ya
       está en el encabezado: el selector puede cortarse con «…». */
    .sr-cab { display: flex; align-items: flex-end; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    /* [GP.RF.41] Rótulo pegado a SU control (proximidad: 4 px contra los 8 px entre controles). */
    .sr-campo { display: flex; flex-direction: column; gap: var(--sp-1); flex: none; min-width: 0; }
    .sr-campo-alm { flex: 1 1 0; }
    .sr-cab .sr-origen { flex: none; flex-wrap: nowrap; }
    /* ::ng-deep sólo para el tamaño del p-select de PrimeNG (vendor): ancho flexible y objetivo táctil. */
    :host ::ng-deep .sr-cab .p-select { width: 100%; min-width: 0; min-height: var(--tap-min); align-items: center; }
    :host ::ng-deep .sr-cab .p-select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sr-dias { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); margin: var(--sp-2) 0; }
    .sr-tm { display: flex; flex-direction: column; gap: var(--sp-2); }
    /* El aviso de lo de Telemarketing a medias: texto legible (no --warn-fg, que da 2.15:1), borde ámbar. */
    .sr-medias { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3);
      border: 1px solid var(--warn-fg); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); font-size: var(--fs-body); }
    .sr-medias > i { color: var(--warn-soft-fg); }
    .sr-nuevos { display: block; margin-top: var(--sp-6); }
    .sr-top-prog { font-variant-numeric: tabular-nums; font-weight: 800; font-size: var(--fs-lg); }

    .sr-banda { display: flex; align-items: center; gap: .6rem; padding: .6rem .8rem; margin-bottom: .75rem;
      border-radius: var(--r-md); border: 1px solid currentColor; font-size: var(--fs-body); }
    .sr-banda-txt { flex: 1; }
    .sr-banda-bad { color: var(--bad-fg); }
    .sr-banda-warn { color: var(--warn-soft-fg); }

    .sr-barra { height: 6px; border-radius: var(--r-pill); background: var(--surface-border); overflow: hidden; margin-bottom: .75rem; }
    /* transform y no width: no dispara layout (check-motion). */
    .sr-barra > span { display: block; width: 100%; height: 100%; background: var(--action);
      transform: scaleX(var(--fill, 0)); transform-origin: left center; transition: transform var(--dur-short) ease; }

    .sr-card { background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: var(--radius-lg); padding: 1.25rem; display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1rem; }
    .sr-l { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    :host ::ng-deep .sr-select { width: 100%; min-height: var(--tap-min); }

    .sr-chips { display: flex; flex-wrap: wrap; gap: .4rem; }
    .sr-chip { min-height: var(--tap-min); padding: .35rem .9rem; border-radius: var(--r-pill); cursor: pointer;
      border: 1px solid var(--surface-border); background: var(--surface-card); color: var(--text-main); font-size: var(--fs-body); }
    .sr-chip-on { border-color: var(--action); background: var(--surface-hover); font-weight: 700; }
    .sr-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* [GP.RF.38] En alto contraste (forced-colors) el sistema pone fondo y borde: la elegida sólo se distinguía
       por la negrita (medido). Contorno Highlight hacia adentro, como app-segmented: no mueve nada. */
    @media (forced-colors: active) { .sr-chip-on { outline: 2px solid Highlight; outline-offset: -2px; } }
    /* [GP.RF.35] Renglón que se desliza (días atrasados, vendedores): con .sr-chips para ganarle a su wrap.
       [GP.RF.38] (Modern Web Guidance, «scrollability-affordance-hints» y «natural-interactions»). Medido antes:
       barra oculta y ninguna pista —3 de 6 vendedores fuera de la vista sin que nada lo dijera— y el anillo de
       foco cortado 4 px (el desplazamiento recorta lo que sale de su caja). Ahora: 4 px de aire para el anillo
       (compensados con margen), se detiene en cada chip, y el borde que tiene más se desvanece. Sin soporte de
       animaciones por desplazamiento, la barra se queda visible: es la pista. */
    .sr-chips.sr-desliza { flex-wrap: nowrap; overflow-x: auto; padding: 4px; margin: -4px; scrollbar-width: thin;
      scroll-snap-type: x mandatory; scroll-padding-inline: 1.5rem; }
    .sr-chips.sr-desliza > * { flex: none; scroll-snap-align: start; }
    @supports (animation-timeline: scroll()) and (mask: linear-gradient(black, black)) {
      .sr-chips.sr-desliza {
        scrollbar-width: none;
        mask:
          linear-gradient(black, black) no-clip subtract,
          linear-gradient(to right, black, transparent) 0 0 / var(--sr-fade-ini) 100% no-repeat no-clip,
          linear-gradient(to right, transparent, black) 100% 0 / var(--sr-fade-fin) 100% no-repeat no-clip;
        animation: sr-fade-ini linear both, sr-fade-fin linear both;
        animation-timeline: scroll(self inline);
        animation-range: 0 1.5rem, calc(100% - 1.5rem) 100%;
      }
    }
    @property --sr-fade-ini { syntax: "<length>"; inherits: false; initial-value: 0px; }
    @property --sr-fade-fin { syntax: "<length>"; inherits: false; initial-value: 0px; }
    @keyframes sr-fade-ini { to { --sr-fade-ini: 1.5rem; } }
    @keyframes sr-fade-fin { from { --sr-fade-fin: 1.5rem; } }

    /* Botones del pulgar: igual que la pantalla hermana (contar camión) — ícono arriba, texto abajo. */
    /* [GP.4] Más bajos (5.5 → 4.25rem) para que la tarjeta completa quepa sobre el pie fijo. */
    .sr-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .1rem;
      min-height: 4.25rem; border-radius: var(--r-lg); border: 2px solid transparent;
      font-size: var(--fs-lg); font-weight: 800; cursor: pointer; transition: transform var(--dur-micro) ease; }
    .sr-btn i { font-size: var(--fs-h2); }
    .sr-btn:disabled { opacity: .55; cursor: not-allowed; }
    .sr-btn:not(:disabled):active { transform: scale(.98); }
    .sr-btn:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    /* --fs-h2 (20px, negrita) cuenta como texto grande: el blanco sobre --action pasa 3:1. */
    .sr-btn-go { background: var(--action); color: var(--action-ink); margin-top: .4rem; font-size: var(--fs-h2); }
    .sr-btn-go:not(:disabled):hover { background: var(--action-hover); }
    .sr-btn-go:not(:disabled):active { background: var(--action-press); }
    /* [GP.3c] Apagado se ve GRIS, no naranja tenue: medido en prod (captura de Francisco,
       2026-10-08), el naranja al 55% se leía como "listo para tocar". */
    .sr-btn-go:disabled { opacity: 1; background: var(--surface-border); color: var(--text-muted); }
    .sr-btn-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border-color: var(--ok-fg); }
    .sr-btn-falta { background: var(--surface-card); color: var(--text-main); border-color: var(--surface-border); }
    .sr-btn-ok:not(:disabled):hover, .sr-btn-falta:not(:disabled):hover { filter: brightness(.97); }
    .sr-tip { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .sr-tip-ok { color: var(--ok-soft-fg); font-size: var(--fs-body); font-weight: 600; margin: .25rem 0 .6rem; }
    .sr-tip-bad { color: var(--bad-fg); font-weight: 600; }
    .sr-sinhit { margin: .25rem 0 .6rem; font-size: var(--fs-body); color: var(--warn-soft-fg); }

    .sr-vacio, .sr-listo { text-align: center; align-items: center; }
    .sr-vacio i, .sr-listo i { font-size: var(--fs-display); color: var(--text-muted); }
    .sr-listo i { color: var(--ok-fg); }
    .sr-listo .sr-btn i, .sr-vacio .sr-btn i { font-size: var(--fs-h2); color: inherit; }
    .sr-listo .sr-btn { align-self: stretch; }
    .sr-vacio h2, .sr-listo h2 { margin: .25rem 0; font-size: var(--fs-h2); }
    .sr-aviso { display: flex; gap: .4rem; align-items: flex-start; margin: .25rem 0 0; color: var(--warn-soft-fg);
      font-size: var(--fs-body); text-align: left; }
    .sr-lista-min { margin: 0; padding-left: 1.2rem; text-align: left; font-size: var(--fs-body); }

    .sr-ola { display: flex; flex-direction: column; gap: .15rem; margin-bottom: .6rem; }
    .sr-ola-code { font-family: var(--font-mono); font-weight: 700; }
    .sr-ola-ped { font-size: var(--fs-xs); color: var(--text-muted); }

    .sr-fijo { position: sticky; top: 0; z-index: 5; padding: var(--sp-2) 0 var(--sp-1); background: var(--surface-ground, var(--card-bg)); }
    .sr-fijo .sr-barra { margin: var(--sp-2) 0 0; }
    .sr-aviso-esc { margin-top: var(--sp-2); }
    .sr-buscar { display: flex; align-items: center; gap: .5rem; padding: .25rem .75rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .sr-buscar i { color: var(--text-muted); }
    .sr-buscar-input { flex: 1; min-width: 0; min-height: var(--tap-min); border: 0; background: transparent;
      color: var(--text-main); font-size: var(--fs-body); }
    /* El campo vive dentro de una caja con borde; el anillo vuelve en :focus-visible. */
    .sr-buscar-input:focus { outline: none; }
    .sr-buscar-input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }

    .sr-filtro { display: flex; align-items: center; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
    .sr-h3 { margin: .75rem 0 .5rem; font-size: var(--fs-h3); display: flex; align-items: center; gap: .5rem; }
    .sr-n { font-size: var(--fs-body); color: var(--text-muted); font-variant-numeric: tabular-nums; }

    .sr-ren { background: var(--surface-card); border: 1px solid var(--surface-border); border-radius: var(--r-lg);
      padding: .6rem .85rem; margin-bottom: .5rem; display: flex; flex-direction: column; gap: .4rem; }
    .sr-ren-cab { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); }
    .sr-ren-prod { display: flex; flex-direction: column; gap: 0; min-width: 0; }
    /* [GP.RF.35] La ubicación arriba y grande: es a donde camina. Sin ubicación, en gris y chica: no grita. */
    .sr-lugar { margin: 0; display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .sr-lugar i { color: var(--text-muted); }
    .sr-lugar-code { font-family: var(--font-mono); font-size: var(--fs-h2); font-weight: 800; letter-spacing: .02em; }
    .sr-lugar-no { font-size: var(--fs-body); font-weight: 500; color: var(--text-muted); }
    .sr-ren-prod strong { font-size: var(--fs-lg); line-height: 1.15; }
    .sr-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    /* La cantidad es lo que se lee a un brazo de distancia: número grande, unidad un escalón abajo. */
    .sr-cant { display: flex; align-items: baseline; gap: .3rem; white-space: nowrap; }
    .sr-cant-n { font-size: var(--fs-display); font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
    .sr-cant-u { font-size: var(--fs-h2); font-weight: 800; }
    .sr-cant-b { font-size: var(--fs-body); color: var(--text-muted); text-align: right; }
    .sr-datos { display: flex; flex-wrap: wrap; gap: .15rem .9rem; }
    .sr-dato { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-body); color: var(--text-muted); }
    .sr-exist-ok, .sr-exist-neutral { color: var(--text-main); }
    .sr-exist-poca { color: var(--warn-soft-fg); font-weight: 700; }
    .sr-exist-cero { color: var(--bad-fg); font-weight: 700; }

    .sr-acc { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
    .sr-falta { display: flex; flex-direction: column; align-items: stretch; gap: .5rem; }
    .sr-falta-input { align-self: center; width: 100%; max-width: 16rem; text-align: center; font-size: var(--fs-display);
      font-weight: 900; font-variant-numeric: tabular-nums; padding: .3rem .6rem; border: 2px solid var(--action);
      border-radius: var(--r-md); background: var(--surface-card); color: var(--text-main); }
    .sr-falta-input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sr-falta .sr-tip { text-align: center; }
    .sr-falta-acc { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
    .sr-nada { margin-top: .4rem; min-height: max(2.75rem, var(--tap-min)); width: 100%; display: flex;
      align-items: center; justify-content: center; gap: .5rem; border-radius: var(--r-md); cursor: pointer;
      border: 2px solid var(--bad-fg); background: var(--surface-card); color: var(--bad-fg);
      font-size: var(--fs-body); font-weight: 700; }
    .sr-nada:disabled { opacity: .55; cursor: not-allowed; }
    .sr-nada:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }

    /* Ya surtido: una línea, en su lugar. */
    .sr-hecho { display: flex; align-items: center; gap: .6rem; padding: .25rem .25rem .25rem .75rem; margin-bottom: .4rem;
      border-left: 4px solid var(--ok-fg); border-radius: var(--r-sm); background: var(--surface-card); }
    .sr-hecho-falta { border-left-color: var(--warn-fg); }
    /* [MCP.17] Surtir en otra unidad: debajo del renglón con faltante, sin apretar su fila. */
    .sr-otra-fila { display: flex; align-items: center; justify-content: flex-end; gap: .5rem; flex-wrap: wrap; margin: -.2rem 0 .5rem; }
    /* [MCP.18] El «¿Por qué?» del faltante, pegado a su renglón (proximidad: el motivo es de ESE producto). */
    .sr-motivo { margin: -.2rem 0 .4rem .75rem; }
    .sr-otra-tag { display: inline-flex; align-items: center; gap: .35rem; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .sr-cambio-lista { list-style: none; margin: .4rem 0; padding: 0; display: grid; gap: .35rem; max-height: 50vh; overflow-y: auto; }
    .sr-cambio-item { display: grid; gap: .15rem; width: 100%; min-height: var(--tap-min); padding: .5rem .6rem; text-align: left; border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); font: inherit; cursor: pointer; }
    .sr-cambio-item:disabled { opacity: .55; cursor: not-allowed; }
    .sr-cambio-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sr-otra { padding: .75rem; margin-bottom: .6rem; border: 1px solid var(--surface-border); border-radius: var(--r-md); background: var(--surface-card); }
    .sr-otra .sr-chips { justify-content: center; }
    .sr-hecho-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: var(--fs-body); color: var(--text-muted); }

    .sr-pie { position: sticky; bottom: 0; z-index: 5; display: flex; flex-direction: column; gap: .25rem; margin-top: 1rem;
      padding: .4rem 0 calc(.4rem + env(safe-area-inset-bottom));
      background: var(--surface-ground, var(--surface-card)); border-top: 1px solid var(--surface-border); }
    .sr-pie-n { font-size: var(--fs-body); color: var(--text-muted); text-align: center; }
    .sr-pend { font-weight: 800; color: var(--warn-soft-fg); font-variant-numeric: tabular-nums; }
    .sr-pend-cero { color: var(--ok-soft-fg); }
    .sr-falt { font-weight: 800; color: var(--warn-soft-fg); }
    .sr-btn-fin { min-height: 3.25rem; margin-top: 0; }

    /* [MCP.3.1] Pedidos de Sucursal. */
    .sr-sec-vacia { margin: .5rem 0 1rem; }
    /* [MCP.14] Encabezado de cada vendedor (y de «Los que estás surtiendo»). */
    .sr-grupo { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-4) 0 0; font-size: var(--fs-body); font-weight: 800; color: var(--text-main); }
    .sr-grupo-n { font-weight: 500; color: var(--text-muted); white-space: nowrap; }
    /* [GP.RF.35] La tarjeta entera es el botón: sin un naranja por pedido. El naranja queda en «Continuar». */
    .sr-ped { width: 100%; text-align: left; font: inherit; color: var(--text-main); cursor: pointer;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg);
      padding: var(--sp-3) var(--sp-4); margin: var(--sp-2) 0; display: flex; flex-direction: column; gap: var(--sp-1); min-height: var(--tap-min); }
    button.sr-ped:not(:disabled):hover { background: var(--surface-hover); }
    button.sr-ped:not(:disabled):active { transform: scale(.99); }
    button.sr-ped:disabled { opacity: .6; cursor: not-allowed; }
    .sr-ped:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    .sr-ped-otro { cursor: default; color: var(--text-muted); }
    .sr-ped-r1 { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
    .sr-ped-n { flex: none; font-size: var(--fs-body); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sr-ped-r2 { display: flex; flex-wrap: wrap; gap: .1rem var(--sp-3); font-size: var(--fs-body); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sr-ped-tags { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); }
    .sr-ped-go { align-self: flex-end; display: inline-flex; align-items: center; gap: var(--sp-1); font-weight: 700; color: var(--text-main); }
    .sr-ped-mio { border-color: var(--action); }
    .sr-ped-mio .sr-ped-go { color: var(--action-ink); background: var(--action); border-radius: var(--r-pill); padding: .3rem .9rem; }
    .sr-ped-tarde { border-left: 4px solid var(--warn-fg); }
    /* [MCP.24] Lo atrasado, aparte y por día: borde ámbar (no texto ámbar, que no pasa contraste). */
    .sr-atras { display: flex; flex-direction: column; gap: var(--sp-1); margin: var(--sp-2) 0; padding-left: var(--sp-3);
      border-left: 3px solid var(--warn-fg); }
    .sr-atras-t { margin: 0; display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-body); font-weight: 700; color: var(--text-main); }
    .sr-atras-t i { color: var(--text-muted); }
    .sr-chips + .sr-chips { margin-top: .6rem; }
    /* [MCP.23] Lo que dice el sistema: en palabras; «no hay» en negritas (el estado no depende del color). */
    .sr-sistema { color: var(--text-muted); }
    .sr-sistema-no { color: var(--text-main); font-weight: 700; }
    /* [MCP.23] «Búscalo en bodega». [GP.RF.35] Antes compartía la clase .sr-buscar con el escáner y le ponía su borde ámbar. */
    .sr-bodega { margin: 0; display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
      border: 1px solid var(--warn-fg); background: var(--card-bg); color: var(--text-main); font-size: var(--fs-body); font-weight: 600; }
    .sr-bodega i { margin-top: .2rem; color: var(--text-muted); }
    .sr-ped-cli { font-size: var(--fs-lg); line-height: 1.2; }
    .sr-tag-tarde { font-size: var(--fs-xs); font-weight: 700; color: var(--warn-soft-fg); }
    .sr-tag-nuevo { font-size: var(--fs-xs); font-weight: 700; color: var(--info-fg); }
    /* [MCP.3.13] Discreto: informa, no pide acción. */
    .sr-tag-parte { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
    /* [MCP.3.15] Indicaciones del vendedor: el surtidor las tiene que ver sin buscarlas. */
    .sr-tag-ind { display: inline-flex; align-items: center; gap: .35rem; width: fit-content; font-size: var(--fs-xs); font-weight: 700;
      color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-radius: 999px; padding: .15rem .6rem; }
    .sr-ind { display: grid; gap: .5rem; margin-bottom: .75rem; padding: var(--sp-4) var(--sp-5); border: 2px solid var(--warn-fg);
      border-radius: var(--r-lg); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .sr-ind-eye { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .sr-ind-txt { margin: 0; font-size: var(--fs-h3); font-weight: 700; line-height: 1.4; white-space: pre-line; color: var(--text-main); }
    .sr-ind-chk { display: inline-flex; align-items: center; gap: .5rem; padding-top: .5rem; border-top: 1px solid var(--warn-fg);
      font-weight: 700; cursor: pointer; min-height: 2.75rem; }
    .sr-ind-chk input { width: 1.25rem; height: 1.25rem; accent-color: var(--ok-fg); }
    .sr-ver-lista { align-self: flex-start; }

    @media (prefers-reduced-motion: reduce) {
      .sr-barra > span, .sr-btn { transition: none; }
      button.sr-ped:not(:disabled):active { transform: none; }
      .sr-btn:not(:disabled):active { transform: none; }
    }
  `],
})
export class AlmacenSurtirComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  /** `[GP.RF.30]` De dónde se llegó, leído al crear la pantalla (después ya no se sabe). */
  private readonly previa = urlPrevia(this.router);
  private readonly perms = inject(PermissionsService);
  private readonly ruta = inject(ActivatedRoute);
  private readonly preventa = inject(PresalePickingService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly location = inject(Location);
  private readonly uso = inject(UsoService);
  /**
   * `[GP.RF.38]` true = el pedido abierto dejó su propia entrada en el historial (se abrió desde la lista).
   * Con eso «atrás» —el gesto del celular o «← Pedidos»— regresa a la lista en vez de salir de Surtir.
   */
  private pedidoEnHistorial = false;

  readonly plural = plural;
  /** [MCP.3.13] «Parte de P-10482 · también surte PH»; suelto → null. */
  readonly textoParte = textoParte;
  readonly origenes: ReadonlyArray<{ v: Origen; l: string }> = [
    // [MCP.3.2] Sucursal primero (decisión de David, 2026-10-19): es lo que surte la sucursal.
    // [GP.RF.35] Se rotula «Preventa»: lo levantan vendedoras y preventa (la sucursal surte los dos orígenes).
    { v: 'SUCURSAL', l: 'Preventa' },
    { v: 'TELEMARK', l: 'Telemarketing' },
  ];
  readonly dias: ReadonlyArray<{ v: PresalePickBucket; l: string }> = [
    { v: 'hoy', l: 'Hoy' },
    { v: 'manana', l: 'Mañana' },
    { v: 'proximos', l: 'Próximos' },
  ];

  readonly fase = signal<'cargando' | 'listo' | 'surtiendo' | 'cerrada'>('cargando');
  readonly error = signal<string | null>(null);
  readonly enLinea = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  readonly almacenes = signal<Array<{ id: string; code: string; name: string }>>([]);
  readonly almacenId = signal<string>('');
  readonly origen = signal<Origen>('SUCURSAL');

  // ── [MCP.3.1] Sucursal ──
  readonly sucursal = signal<PresalePickInboxResponse | null>(null);
  readonly cargandoSucursal = signal(false);
  /** §9 Cuándo llegó la lista (hora del navegador): la píldora dice «cargado hace N», no la edad del dato. */
  readonly sucursalAl = signal<number | null>(null);
  readonly sucursalError = signal<string | null>(null);
  readonly dia = signal<PresalePickBucket>('hoy');
  /** El pedido de Sucursal que se está tomando (spinner en SU botón). */
  readonly tomandoId = signal<string | null>(null);
  /** El pedido de Sucursal que se está surtiendo; null = se surte una ola de Telemarketing. */
  readonly pedidoSucursal = signal<PresalePickInboxRow | null>(null);
  /** [MCP.3.15] El surtidor marcó que cumplió las indicaciones del vendedor (sólo en pantalla, decisión de David). */
  readonly indicacionesOk = signal(false);
  /** [MCP.3.15] Hay indicaciones y todavía no se marcan: «Terminé de surtir» espera. */
  readonly faltaMarcarIndicaciones = computed(() => {
    const ind = this.pedidoSucursal()?.instructions;
    const ok = this.indicacionesOk();
    return !!ind && !ok;
  });
  /** Lo que el cierre de un pedido de Sucursal quitó o ajustó. */
  readonly reporte = signal<PresalePickReport | null>(null);
  /** [MCP.3.6] Cuántas rutas hay hoy (las pinta su propia pieza): rotula «Pedidos sueltos». */
  readonly rutasHoy = signal(0);
  /** [MCP.3.8] Pedidos de clientes nuevos sin clave de Kepler (los avisa su propia pieza). */
  readonly sinClave = signal<Set<string>>(new Set());

  /** Pendientes de surtir del almacén elegido (el alcance ya lo recortó el servidor). */
  private readonly pendientesSucursal = computed(() =>
    (this.sucursal()?.data ?? []).filter(
      (p) => (p.state === 'nuevo' || p.state === 'surtiendo') && (!this.almacenId() || p.warehouse_id === this.almacenId()),
    ),
  );
  /**
   * `[MCP.24]` «Hoy» es sólo lo de hoy: lo atrasado va en su aviso, por día. Lo atrasado que YO ya empecé
   * se queda en Hoy («Los que estás surtiendo»): es lo que tengo que terminar.
   */
  private enHoy(p: PresalePickInboxRow): boolean {
    return p.bucket === 'hoy' && (p.days_late === 0 || this.esMio(p));
  }
  /** `[MCP.24]` Hoy en México según el servidor; antes de la primera carga, el del navegador. */
  readonly hoy = computed(() => this.sucursal()?.today ?? todayMx());
  /** `[MCP.24]` El día atrasado abierto desde el aviso (`YYYY-MM-DD`); `null` = el día de las pestañas. */
  readonly diaAtrasado = signal<string | null>(null);
  /** `[MCP.24]` El vendedor elegido; `null` = todos (con sus encabezados de MCP.14). */
  readonly vendedor = signal<string | null>(null);
  readonly porDia = computed(() => {
    const c: Record<PresalePickBucket, number> = { hoy: 0, manana: 0, proximos: 0 };
    for (const p of this.pendientesSucursal()) if (p.bucket !== 'hoy' || this.enHoy(p)) c[p.bucket]++;
    return c;
  });
  /** `[MCP.24]` Lo pendiente de días anteriores, por día (el más reciente primero). Lo que yo empecé ya está en Hoy. */
  readonly atrasados = computed(() => pendientesDeOtrosDias(
    this.pendientesSucursal(), (p) => p.requested_delivery_date, (p) => p.days_late > 0 && !this.esMio(p), this.hoy()));
  readonly totalAtrasados = computed(() => this.atrasados().reduce((s, a) => s + a.n, 0));
  /** Los del día que se ve, antes de elegir vendedor. Lo que ya empezó esta persona va primero. */
  readonly pedidosDelDia = computed(() => {
    const atr = this.diaAtrasado();
    return this.pendientesSucursal()
      .filter((p) => (atr
        ? p.days_late > 0 && p.requested_delivery_date === atr && !this.esMio(p)
        : p.bucket === this.dia() && (p.bucket !== 'hoy' || this.enHoy(p))))
      .sort((a, b) => Number(this.esMio(b)) - Number(this.esMio(a)));
  });
  /** `[MCP.24]` «Todos · 6 · Vendedor Uno · 3…», en orden de llegada (el mismo de los encabezados). */
  readonly opcionesVendedor = computed<ReadonlyArray<{ v: string; l: string }>>(() => [
    { v: '', l: `Todos · ${this.pedidosDelDia().length}` },
    ...vendedoresDe(this.pedidosDelDia(), (p) => p.arrived_at).map((o) => ({ v: o.vendedor, l: `${o.vendedor} · ${o.n}` })),
  ]);
  /** El vendedor elegido, si tiene pedidos en el día que se ve; si no, todos. */
  readonly vendedorEfectivo = computed(() => {
    const v = this.vendedor();
    return v && this.opcionesVendedor().some((o) => o.v === v) ? v : null;
  });
  /** `[MCP.24]` Lo que se pinta: el día y, si se eligió, el vendedor (los números de los chips cuentan esto mismo). */
  private readonly pedidosVisibles = computed(() => deVendedor(this.pedidosDelDia(), this.vendedorEfectivo()));
  /** [MCP.14] Los que ya empezó esta persona: arriba y aparte, en orden de folio. */
  readonly misEnCurso = computed(() =>
    this.pedidosVisibles().filter((p) => this.esMio(p)).sort((a, b) => a.code.localeCompare(b.code)),
  );
  /** [MCP.14] El resto, separado por vendedor y en orden de folio; los grupos, por orden de llegada (D5). */
  readonly gruposDelDia = computed(() =>
    agruparPorVendedor(this.pedidosVisibles().filter((p) => !this.esMio(p)), (p) => p.arrived_at),
  );
  readonly diaTexto = computed(() => {
    const atr = this.diaAtrasado();
    if (atr) return this.etiqueta(atr) === 'Ayer' ? 'pendientes de ayer' : `pendientes del ${this.etiqueta(atr)}`;
    return ({ hoy: 'para hoy', manana: 'para mañana', proximos: 'para los próximos días' })[this.dia()];
  });
  /** `[MCP.23]` La existencia del sistema de cada renglón del pedido de Sucursal abierto (`PresalePickLine.stock`). */
  readonly stockPedido = signal<Record<string, PresaleReviewStock | null | undefined>>({});
  readonly ola = signal<PickerWave | null>(null);
  /** `[GP.RF.27]` El surtido de Telemarketing que quedó a medias: se avisa, no se retoma solo. */
  readonly olaAMedias = signal<PickerWave | null>(null);
  readonly sinTrabajo = signal<{ motivo: string; armado: KeplerWavesAutoResponse | null } | null>(null);
  /** Surtidos armados a mano que no se pudieron abrir (se liberaron): hay que avisar al supervisor. */
  readonly atoradas = signal<ReadonlyArray<{ code: string; motivo: string }>>([]);
  readonly tomando = signal(false);
  readonly cerrando = signal(false);
  readonly busqueda = signal('');
  readonly ocultarHechos = signal(false);
  /** Renglón con el teclado de faltante abierto. */
  readonly editando = signal<string | null>(null);
  readonly borrador = signal<number | null>(null);
  /** `[MCP.17]` Por renglón: lo que faltó y se surte en una presentación más chica del mismo producto. */
  readonly otraUnidad = signal<Record<string, OtraUnidad>>({});
  /** `[MCP.18]` El motivo elegido por renglón con faltante; sin tocar = «No había en la sucursal». */
  readonly motivosLinea = signal<Record<string, MotivoLinea>>({});
  readonly motivosSurtido = MOTIVOS_SURTIDO;
  /** `[MCP.18]` Lo que cambió del pedido (quién y por qué) antes de que lo tomaran. D5: todo, no sólo la vendedora. */
  readonly justificantesPedido = signal<OrderJustification[]>([]);
  /** `[MCP.18]` Renglones con «Otro motivo» sin escribir: «Terminé de surtir» espera. */
  readonly motivosSinCompletar = computed(() => {
    const m = this.motivosLinea();
    const ids = (this.ola()?.lines ?? []).filter((l) => l.status !== 'pendiente' && l.status !== 'surtido').map((l) => l.id);
    return this.pedidoSucursal() ? motivosIncompletos(m, ids, MOTIVOS_SURTIDO, MOTIVO_SURTIDO_POR_OMISION) : [];
  });
  /** El renglón cuyo panel «Surtir en otra unidad» está abierto. */
  readonly otraAbierta = signal<string | null>(null);
  readonly otraCarga = signal<{ estado: 'cargando' | 'error' | 'listo'; data?: PresaleOtherUnitsResponse; msg?: string }>({ estado: 'cargando' });
  readonly otraElegida = signal<string | null>(null);
  readonly otraCant = signal<number | null>(null);
  /**
   * `[GP.RF.31]` Cambiar lo que faltó por OTRO producto (decisión de Edgar, 2026-11-17). El servidor ya lo
   * hacía (`[MCP.13]`), pero sólo lo ofrecía `/almacen/surtir-preventa`, que el surtidor no usa: en esta
   * pantalla no había cómo. Un renglón lleva a lo más un cambio: otra unidad u otro producto.
   */
  readonly cambioAbierto = signal<string | null>(null);
  readonly cambioBusca = signal('');
  readonly cambioCarga = signal<{ estado: 'cargando' | 'error' | 'listo'; data?: PresaleSubstituteResponse; msg?: string }>({ estado: 'cargando' });
  readonly cambioElegido = signal<PresaleSubstituteCandidate | null>(null);
  readonly cambioUnidad = signal<string | null>(null);
  readonly cambioCant = signal<number | null>(null);
  private cambioReloj: ReturnType<typeof setTimeout> | null = null;
  /** Renglones con un guardado en vuelo: sus botones se apagan para no mandar dos veces. */
  readonly guardando = signal<ReadonlySet<string>>(new Set());
  /** Lo último que pasó, para lectores de pantalla. */
  readonly anuncio = signal('');
  readonly resumen = signal<{ completos: number; faltantes: number; cambios: string[] }>({
    completos: 0, faltantes: 0, cambios: [],
  });

  readonly atoradasTexto = computed(() => this.atoradas().map((a) => `${a.code}: ${a.motivo}`).join(' · '));
  readonly almacenNombre = computed(() => this.almacenes().find((a) => a.id === this.almacenId())?.name ?? '');
  private readonly filtradas = computed(() => {
    const o = this.ola();
    if (!o) return [];
    const q = this.busqueda().trim();
    // ⚠️ `coincideBusqueda(consulta, ...campos)`: la consulta va PRIMERO. Al revés el buscador no
    // encontraba nada al escanear (lo atrapó la prueba de la pantalla).
    return q ? o.lines.filter((l) => coincideBusqueda(q, l.barcode, l.sku, l.product_name)) : o.lines;
  });
  /** Lo que se pinta, en el orden del servidor (estable: no se reacomoda al marcar). */
  readonly visibles = computed(() =>
    this.ocultarHechos() && !this.busqueda()
      ? this.filtradas().filter((l) => l.status === 'pendiente' || this.editando() === l.id)
      : this.filtradas(),
  );
  readonly pendientes = computed(() => this.filtradas().filter((l) => l.status === 'pendiente'));
  readonly hechas = computed(() => this.filtradas().filter((l) => l.status !== 'pendiente'));
  readonly hechos = computed(() => (this.ola()?.lines ?? []).filter((l) => l.status !== 'pendiente').length);
  readonly pendientesTotal = computed(() => (this.ola()?.lines ?? []).filter((l) => l.status === 'pendiente').length);
  readonly conFaltante = computed(
    () => (this.ola()?.lines ?? []).filter((l) => ['faltante', 'agotado', 'danado'].includes(l.status)).length,
  );

  ngOnInit(): void {
    if (typeof window !== 'undefined') {
      const on = (): void => this.enLinea.set(true);
      const off = (): void => this.enLinea.set(false);
      window.addEventListener('online', on);
      window.addEventListener('offline', off);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('online', on);
        window.removeEventListener('offline', off);
      });
    }
    // [MCP.3.1] La lista de Sucursal se refresca sola SÓLO mientras se ve (no surtiendo).
    const reloj = setInterval(() => {
      if (this.fase() === 'listo' && this.origen() === 'SUCURSAL' && this.enLinea() && !this.cargandoSucursal()) {
        this.cargarSucursal(true);
      }
    }, SUCURSAL_CADA_MS);
    this.destroyRef.onDestroy(() => clearInterval(reloj));
    // [GP.RF.38] El gesto «atrás» del celular con un pedido abierto (Modern Web Guidance, «stack-drill-down»):
    // el historial quita `?pedido=` y aquí se regresa a la lista. Medido antes: «atrás» sacaba de Surtir
    // (a /projects) con el pedido a medias. `skip(1)`: la primera emisión es la del arranque (la atiende `iniciar`).
    this.ruta.queryParamMap?.pipe(skip(1), takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      if (!q.get('pedido') && this.pedidoSucursal() && this.fase() === 'surtiendo') {
        this.pedidoEnHistorial = false;
        this.volverAPedidos();
      }
    });
    this.iniciar();
  }

  // ── [MCP.3.1] Sucursal ────────────────────────────────────────────────────────────────

  /** Pide los pedidos de Sucursal por surtir (los recorta el servidor por el alcance). */
  cargarSucursal(silencioso = false): void {
    if (!silencioso) this.cargandoSucursal.set(true);
    this.preventa.inbox().subscribe({
      next: (b) => {
        this.cargandoSucursal.set(false);
        this.sucursal.set(b);
        this.sucursalAl.set(Date.now());
        this.sucursalError.set(null);
      },
      error: (e) => {
        this.cargandoSucursal.set(false);
        this.sucursalError.set(this.mensaje(e, 'No se pudieron leer los pedidos de sucursal.'));
      },
    });
  }

  esMio(p: PresalePickInboxRow): boolean {
    const yo = this.auth.user()?.sub;
    return !!yo && p.started?.user_id === yo;
  }

  /** `[MCP.24]` Una pestaña de día (Hoy / Mañana / Próximos) cierra el día atrasado que estuviera abierto. */
  elegirDia(d: PresalePickBucket): void {
    this.diaAtrasado.set(null);
    this.dia.set(d);
  }
  /** `[MCP.24]` Abre lo pendiente de un día anterior (tocado en el aviso). */
  verAtrasado(fecha: string): void {
    this.dia.set('hoy');
    this.diaAtrasado.set(fecha);
  }
  /** «Ayer» o «mié 11 nov». */
  etiqueta(fecha: string): string {
    return etiquetaDia(fecha, this.hoy());
  }

  /** `[MCP.23]` «Sistema: hay 15 CJA / no hay / sin dato» del renglón del pedido de Sucursal; `null` = no se pinta. */
  sistemaDe(l: PickerWaveLine): string | null {
    // La unidad con que se cuenta (la que sale junto a la cantidad): el servidor manda `stock` en esa misma unidad.
    return this.pedidoSucursal() ? textoSistema(this.stockPedido()[l.id], this.unidadConteo(l)) : null;
  }
  sinProductoDe(l: PickerWaveLine): boolean {
    return sistemaSinProducto(this.stockPedido()[l.id]);
  }
  /**
   * `[MCP.23]` Va a quitar algo que el sistema dice que hay: que lo busque en bodega. En el teclado de faltante
   * cuenta lo que lleva escrito (vacío = nada); ya marcado, lo que se guardó. No bloquea: manda el anaquel.
   */
  buscarEnBodega(l: PickerWaveLine, marcado: number | null): string | null {
    if (!this.pedidoSucursal()) return null;
    const m = marcado == null || (marcado as unknown) === '' || !Number.isFinite(Number(marcado)) ? 0 : Number(marcado);
    return avisoBuscarEnBodega(this.stockPedido()[l.id], this.unidadConteo(l), m, l.qty_requested);
  }

  /**
   * Abre un pedido de Sucursal para surtirlo con los mismos renglones de siempre. «Empezar» deja
   * registrado quién y a qué hora (y le avisa a la vendedora); es idempotente para la misma persona,
   * así que "Continuar" usa el mismo camino.
   */
  surtirPedido(orderId: string): void {
    if (this.tomando()) return;
    this.tomando.set(true);
    this.tomandoId.set(orderId);
    this.sinTrabajo.set(null);
    this.preventa.start(orderId).subscribe({
      next: () => {
        this.preventa.detail(orderId).subscribe({
          next: (d) => this.abrirPedido(d),
          error: (e) => this.falloAlAbrir(e),
        });
      },
      error: (e) => {
        this.falloAlAbrir(e);
        this.cargarSucursal(true);
      },
    });
  }

  private falloAlAbrir(e: unknown): void {
    this.tomando.set(false);
    this.tomandoId.set(null);
    this.avisar('error', this.mensaje(e, 'No se pudo abrir el pedido.'));
    if (this.fase() === 'cargando') this.fase.set('listo');
  }

  /** El pedido como "ola" de un solo pedido: la pantalla de surtir no cambia. */
  private abrirPedido(d: PresalePickDetail): void {
    const guardadas = this.marcasGuardadas(d.order.order_id);
    const ola: PickerWave = {
      id: d.order.order_id,
      code: d.order.code,
      warehouse_id: d.order.warehouse_id,
      status: 'en_surtido',
      notes: null,
      started_at: d.order.started?.at ?? null,
      pedidos: [d.order.code],
      existencia_al: null,
      lines: d.lines.map((l): PickerWaveLine => {
        const marcada = guardadas[l.line_id];
        return {
          id: l.line_id,
          product_id: l.product_id,
          product_name: l.product_name,
          sku: l.sku,
          barcode: l.barcode ?? null,
          // La cantidad del pedido tal como la ve la vendedora (3 CJA); se cuenta en esa unidad.
          qty_requested: l.qty,
          qty_unit: l.unit,
          unidad_mixta: false,
          qty_presentacion: null,
          unidad_presentacion: null,
          qty_picked: marcada ?? null,
          status: marcada == null ? 'pendiente' : this.estadoDe(marcada, l.qty),
          // [GP.RF.34] El lugar del producto (Ubicaciones) y su orden de recorrido; antes iba siempre vacío.
          bin_code: l.ubicacion?.code ?? null,
          orden_recorrido: l.ubicacion?.orden ?? null,
          // [GP.RF.33] Los códigos de cada presentación: con ellos escanear marca Completo.
          ...(l.presentaciones ? { presentaciones: l.presentaciones } : {}),
          note: null,
          existencia: null,
          existencia_unidad: null,
          // [GP.9.2] Preventa no es un pedido de Kepler: no hay factor capturado contra el cual comparar.
          aviso_caja: null,
        };
      }),
    };
    this.tomando.set(false);
    this.tomandoId.set(null);
    this.error.set(null);
    this.reporte.set(null);
    // [MCP.23] La existencia viaja por renglón mientras el pedido no se cierra (ausente = servidor anterior).
    this.stockPedido.set(Object.fromEntries(d.lines.map((l) => [l.line_id, l.stock])));
    this.pedidoSucursal.set(d.order);
    this.indicacionesOk.set(false);
    // [GP.RF.34] En el orden del recorrido del almacén (lo que no tiene ubicación, al final, como venía).
    this.ola.set({ ...ola, lines: ordenarPorRecorrido(ola.lines) });
    this.busqueda.set('');
    this.editando.set(null);
    // [MCP.17] Lo que ya se había puesto en otra unidad, si se cerró la app a medio surtir.
    this.otraUnidad.set(this.otraGuardada(d.order.order_id, new Set(ola.lines.map((l) => l.id))));
    // [MCP.18] Los motivos ya elegidos (si se cerró la app a medio surtir) y por qué cambió el pedido.
    this.motivosLinea.set(this.motivosGuardados(d.order.order_id, new Set(ola.lines.map((l) => l.id))));
    this.justificantesPedido.set(d.justifications ?? []);
    this.otraAbierta.set(null);
    this.ocultarHechos.set(false);
    this.fase.set('surtiendo');
    this.alInicio();
    this.anuncio.set(`Pedido ${d.order.code}: ${plural(ola.lines.length, 'renglón', 'renglones')}.`);
    // [GP.RF.38] Abierto desde la lista, el pedido deja su entrada en el historial (`?pedido=`, la misma que
    // abre el aviso de la campana): «atrás» regresa a la lista y una recarga lo vuelve a abrir. Abierto desde
    // la URL, la entrada ya existe.
    if (this.ruta.snapshot.queryParamMap.get('pedido') !== d.order.order_id) {
      this.pedidoEnHistorial = true;
      this.router.navigate([], { relativeTo: this.ruta, queryParams: { pedido: d.order.order_id }, queryParamsHandling: 'merge' })
        .catch(() => false);
    }
    // [GP.RF.38] El foco va al pedido (su encabezado), no se queda en <body>. No al buscador: en el celular
    // eso abre el teclado en pantalla encima de la lista.
    this.enfocarLuego(() => this.host.nativeElement.querySelector<HTMLElement>('#sr-titulo'));
  }

  /** `[GP.RF.38]` Mueve el foco en cuanto la vista nueva está pintada, sin desplazar la página. */
  private enfocarLuego(cual: () => HTMLElement | null): void {
    setTimeout(() => cual()?.focus({ preventScroll: true }));
  }

  /** `[GP.RF.38]` Quita `?pedido=` de la URL sin dejar otra entrada en el historial. */
  private quitarPedidoDeLaUrl(): void {
    if (!this.ruta.snapshot.queryParamMap.get('pedido')) return;
    this.router.navigate([], { relativeTo: this.ruta, queryParams: { pedido: null }, queryParamsHandling: 'merge', replaceUrl: true })
      .catch(() => false);
  }

  // ── [MCP.17] Surtir en otra unidad del mismo producto ──────────────────────────────────────

  private otraGuardada(orderId: string, renglones: Set<string>): Record<string, OtraUnidad> {
    try {
      const v = JSON.parse(this.leer(PREF_OTRA + orderId) || '{}') as Record<string, OtraUnidad>;
      const out: Record<string, OtraUnidad> = {};
      for (const [k, x] of Object.entries(v && typeof v === 'object' ? v : {})) {
        // Sólo lo que sigue siendo de este pedido y tiene forma: lo demás se descarta, no se adivina.
        if (renglones.has(k) && x && typeof x.product_id === 'string' && typeof x.unit === 'string' && Number(x.quantity) > 0) out[k] = x;
      }
      return out;
    } catch {
      return {};
    }
  }

  private guardarOtra(orderId: string): void {
    const m = this.otraUnidad();
    this.guardar(PREF_OTRA + orderId, Object.keys(m).length ? JSON.stringify(m) : '');
  }

  abrirOtraUnidad(l: PickerWaveLine): void {
    const o = this.ola();
    if (!o || !this.pedidoSucursal()) return;
    this.otraAbierta.set(l.id);
    this.otraCarga.set({ estado: 'cargando' });
    this.otraElegida.set(null);
    this.otraCant.set(null);
    this.preventa.otherUnits(o.id, l.id).subscribe({
      next: (d) => {
        if (this.otraAbierta() !== l.id) return;
        this.otraCarga.set({ estado: 'listo', data: d });
        // La más grande de las chicas: de una caja incompleta salen primero paquetes.
        this.otraElegida.set(d.units.length ? d.units[d.units.length - 1].unit : null);
      },
      error: (e) => {
        if (this.otraAbierta() !== l.id) return;
        this.otraCarga.set({ estado: 'error', msg: this.mensaje(e, 'No se pudieron leer sus presentaciones.') });
      },
    });
  }

  /** Cuántas de la unidad elegida caben en lo que faltó (la misma regla que aplica el servidor). */
  otraTope(l: PickerWaveLine): number {
    const d = this.otraCarga().data;
    const u = d?.units.find((x) => x.unit === this.otraElegida());
    if (!d || !u) return 0;
    const falto = (l.qty_requested - Number(l.qty_picked ?? 0)) * d.factor;
    return topeEnUnidad(falto, u);
  }

  otraValida(l: PickerWaveLine): boolean {
    const raw = this.otraCant();
    if (raw == null || (raw as unknown) === '') return false;
    const q = Number(raw);
    const u = this.otraElegida() ?? '';
    const pesable = /^(KG|GR|LT|LTS|L|ML)$/i.test(u);
    return Number.isFinite(q) && q > 0 && q <= this.otraTope(l) + 1e-9 && (pesable || Number.isInteger(q));
  }

  ponerOtraUnidad(l: PickerWaveLine): void {
    const o = this.ola();
    const d = this.otraCarga().data;
    const u = this.otraElegida();
    if (!o || !d || !u || !this.otraValida(l)) return;
    const quantity = Number(this.otraCant());
    this.otraUnidad.update((m) => ({ ...m, [l.id]: { product_id: d.product_id, unit: u, quantity } }));
    this.guardarOtra(o.id);
    this.otraAbierta.set(null);
    this.anuncio.set(`${l.product_name || l.sku}: van ${this.fmtNum(quantity)} ${u} en otra unidad.`);
  }

  quitarOtraUnidad(l: PickerWaveLine): void {
    const o = this.ola();
    if (!o) return;
    const era = this.otraUnidad()[l.id];
    this.otraUnidad.update((m) => {
      const { [l.id]: _fuera, ...resto } = m;
      return resto;
    });
    this.guardarOtra(o.id);
    this.anuncio.set(era?.otro ? `${l.product_name || l.sku}: ya no se cambia por otro producto.` : `${l.product_name || l.sku}: ya no va nada en otra unidad.`);
  }

  // ── [GP.RF.31] Cambiar lo que faltó por otro producto ─────────────────────────────────────────

  /** Lo que faltó del renglón, en su unidad. */
  faltanDe(l: PickerWaveLine): number {
    return +(l.qty_requested - Number(l.qty_picked ?? 0)).toFixed(3);
  }

  abrirCambio(l: PickerWaveLine): void {
    if (!this.ola() || !this.pedidoSucursal()) return;
    this.otraAbierta.set(null);
    this.cambioAbierto.set(l.id);
    this.cambioBusca.set('');
    this.cambioElegido.set(null);
    this.cargarCambios(l);
  }

  cerrarCambio(): void {
    this.cambioAbierto.set(null);
    this.cambioElegido.set(null);
    if (this.cambioReloj) clearTimeout(this.cambioReloj);
  }

  buscarCambio(l: PickerWaveLine, q: string): void {
    this.cambioBusca.set(q);
    this.cambioElegido.set(null);
    if (this.cambioReloj) clearTimeout(this.cambioReloj);
    this.cambioReloj = setTimeout(() => this.cargarCambios(l), 300);
  }

  cargarCambios(l: PickerWaveLine): void {
    const o = this.ola();
    if (!o) return;
    const q = this.cambioBusca().trim();
    this.cambioCarga.set({ estado: 'cargando' });
    this.preventa.substitutes(o.id, l.id, q).subscribe({
      next: (r) => {
        // Si mientras tanto se cerró el panel o se tecleó otra cosa, esta respuesta ya no aplica.
        if (this.cambioAbierto() !== l.id || this.cambioBusca().trim() !== q) return;
        this.cambioCarga.set({ estado: 'listo', data: r });
      },
      error: (e) => {
        if (this.cambioAbierto() !== l.id) return;
        this.cambioCarga.set({ estado: 'error', msg: this.mensaje(e, 'No se pudieron cargar los productos.') });
      },
    });
  }

  /**
   * Ya va en lugar de lo que faltó de OTRO renglón: el servidor rechaza el cierre si un producto se pone
   * en dos renglones («elige uno distinto para cada uno»). Se avisa aquí, antes de marcarlo.
   */
  usadoEnOtroRenglon(productId: string, lineId: string): boolean {
    return Object.entries(this.otraUnidad()).some(([id, x]) => id !== lineId && x.product_id === productId);
  }

  elegirCambio(l: PickerWaveLine, x: PresaleSubstituteCandidate): void {
    const u = x.units[0];
    if (!u || this.usadoEnOtroRenglon(x.product_id, l.id)) return;
    this.cambioElegido.set(x);
    this.cambioUnidad.set(u.unit);
    // Misma unidad que el renglón: lo que faltó. Otra unidad: una, y el surtidor ajusta.
    this.cambioCant.set(u.unit === l.qty_unit ? Math.max(1, Math.ceil(this.faltanDe(l))) : 1);
  }

  cambioValido(): boolean {
    const raw = this.cambioCant();
    if (!this.cambioElegido() || raw == null || (raw as unknown) === '') return false;
    const q = Number(raw);
    const pesable = /^(KG|GR|LT|LTS|L|ML)$/i.test(this.cambioUnidad() ?? '');
    return Number.isFinite(q) && q > 0 && (pesable || Number.isInteger(q));
  }

  ponerCambio(l: PickerWaveLine): void {
    const o = this.ola();
    const x = this.cambioElegido();
    const u = this.cambioUnidad();
    if (!o || !x || !u || !this.cambioValido()) return;
    const quantity = Number(this.cambioCant());
    this.otraUnidad.update((m) => ({ ...m, [l.id]: { product_id: x.product_id, unit: u, quantity, otro: true, product_name: x.product_name } }));
    this.guardarOtra(o.id);
    this.cerrarCambio();
    this.anuncio.set(`${l.product_name || l.sku}: se cambia por ${x.product_name}, ${this.fmtNum(quantity)} ${u}.`);
  }

  precioCambio(x: PresaleSubstituteCandidate): string {
    const u = x.units[0];
    return u?.price != null ? `${this.dinero(u.price)} / ${u.unit}` : 'sin precio';
  }

  existenciaCambio(x: PresaleSubstituteCandidate): string {
    if (x.stock_qty === null) return 'existencia sin dato';
    const u = x.units[0];
    const q = u && u.factor > 1 ? Math.floor((x.stock_qty + 1e-9) / u.factor) : x.stock_qty;
    return `hay ${this.fmtNum(q)} ${u?.unit ?? 'PZA'}`;
  }

  // ── [MCP.18] El justificante de cada faltante ──────────────────────────────────────────────

  motivoDeLinea(id: string): MotivoLinea {
    return motivoDe(this.motivosLinea(), id, MOTIVO_SURTIDO_POR_OMISION);
  }

  ponerMotivo(id: string, m: MotivoLinea): void {
    const o = this.ola();
    this.motivosLinea.update((x) => ({ ...x, [id]: m }));
    if (o) this.guardar(PREF_MOTIVO + o.id, JSON.stringify(this.motivosLinea()));
  }

  /** « · Dañado o caducado» en el resumen al cerrar; vacío si el reporte no trae motivo. */
  motivoReporte(x: { reason?: string; reason_note?: string }): string {
    return x.reason ? ` · ${textoDeMotivo(MOTIVOS_SURTIDO, x.reason, x.reason_note)}` : '';
  }

  private motivosGuardados(orderId: string, renglones: Set<string>): Record<string, MotivoLinea> {
    try {
      const v = JSON.parse(this.leer(PREF_MOTIVO + orderId) || '{}') as Record<string, MotivoLinea>;
      const out: Record<string, MotivoLinea> = {};
      for (const [k, x] of Object.entries(v && typeof v === 'object' ? v : {})) {
        // Sólo lo que sigue siendo de este pedido y tiene forma: lo demás se descarta, no se adivina.
        if (renglones.has(k) && x && typeof x.reason === 'string') out[k] = { reason: x.reason, note: typeof x.note === 'string' ? x.note : '' };
      }
      return out;
    } catch {
      return {};
    }
  }

  private estadoDe(levantado: number, pedido: number): PickerWaveLine['status'] {
    if (levantado <= 0) return 'agotado';
    return levantado >= pedido ? 'surtido' : 'faltante';
  }

  /** Lo marcado en un pedido de Sucursal: en el celular hasta cerrar (si se cierra la app, no se pierde). */
  private marcasGuardadas(orderId: string): Record<string, number> {
    try {
      const v = JSON.parse(this.leer(PREF_MARCAS + orderId) || '{}');
      return v && typeof v === 'object' ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private marcarSucursal(l: PickerWaveLine, qty: number): void {
    const o = this.ola();
    if (!o) return;
    const status = this.estadoDe(qty, l.qty_requested);
    this.editando.set(null);
    this.ola.set({ ...o, lines: o.lines.map((x) => (x.id === l.id ? { ...x, qty_picked: qty, status } : x)) });
    const marcas = this.marcasGuardadas(o.id);
    marcas[l.id] = qty;
    this.guardar(PREF_MARCAS + o.id, JSON.stringify(marcas));
    const nombre = l.product_name || l.sku || 'Renglón';
    // [MCP.17] Lo de otra unidad se calculó contra lo que faltaba: si cambia lo surtido, se vuelve a poner.
    const habiaOtra = !!this.otraUnidad()[l.id];
    if (habiaOtra) {
      this.otraUnidad.update((m) => {
        const { [l.id]: _fuera, ...resto } = m;
        return resto;
      });
      this.guardarOtra(o.id);
    }
    this.anuncio.set((status === 'surtido' ? `${nombre}: completo.` : status === 'agotado' ? `${nombre}: no había.` : `${nombre}: con faltante.`)
      + (habiaOtra ? ' Lo de otra unidad se quitó: vuelve a ponerlo si hace falta.' : ''));
    if (this.busqueda()) {
      this.limpiarBusqueda();
    } else {
      const siguiente = this.pendientes()[0];
      if (siguiente) setTimeout(() => (document.getElementById('sr-ok-' + siguiente.id) as HTMLButtonElement | null)?.focus());
    }
  }

  /** Cierra el pedido de Sucursal: lo que no hubo se quita y se recalcula (MCP.8), y se avisa a la vendedora. */
  private cerrarSucursal(o: PickerWave): void {
    this.cerrando.set(true);
    const otra = this.otraUnidad();
    const lines = o.lines.map((l) => ({
      line_id: l.id,
      picked: Number(l.qty_picked ?? 0),
      // [MCP.17] El mismo producto en otra unidad viaja como un cambio con su mismo product_id;
      // [GP.RF.31] otro producto, con el suyo. Sólo los tres campos que el servidor espera.
      ...(otra[l.id] && l.status !== 'surtido' ? { substitute: sustitutoParaEnviar(otra[l.id]) } : {}),
      // [MCP.18] El justificante de cada faltante (sin tocar = el de por omisión, lo que dice el botón).
      ...(l.status !== 'surtido' ? camposDeMotivo(motivoDe(this.motivosLinea(), l.id, MOTIVO_SURTIDO_POR_OMISION)) : {}),
    }));
    this.preventa.finish(o.id, { lines }).subscribe({
      next: (r) => {
        this.cerrando.set(false);
        this.guardar(PREF_MARCAS + o.id, '');
        this.guardar(PREF_OTRA + o.id, '');
        this.guardar(PREF_MOTIVO + o.id, '');
        this.motivosLinea.set({});
        this.otraUnidad.set({});
        this.resumen.set({
          completos: o.lines.filter((l) => l.status === 'surtido').length,
          faltantes: this.conFaltante(),
          cambios: [],
        });
        this.reporte.set(r.report);
        this.ola.set(null);
        this.pedidoSucursal.set(null);
        this.fase.set('cerrada');
        this.anuncio.set('Pedido surtido.');
        // [GP.RF.38] Cerrado, la URL ya no lo nombra: una recarga no intenta abrir un pedido terminado.
        this.pedidoEnHistorial = false;
        this.quitarPedidoDeLaUrl();
      },
      error: (e) => {
        this.cerrando.set(false);
        this.reportarRechazo('cerrar_preventa', o, e, lines.filter((x) => 'substitute' in x).length);
        this.avisar('error', this.mensaje(e, 'No se pudo terminar el surtido.'));
      },
    });
  }

  /**
   * `[GP.RF.23]` Un cierre rechazado deja su MOTIVO. Medido en prod (30 días): 84 de 925 cierres se
   * rechazaron (todos 4xx) y el motivo no quedaba en ningún lado: el servidor no lo guarda y el aviso
   * dura 8 s en pantalla. Va por el canal de incidentes (`kind: 'error'`, [RA-PERF.6]): el código, el
   * mensaje del servidor y lo que traía el cierre (renglones, faltantes, cambios), para separar las
   * causas candidatas —cambiar un producto por otro, dos personas sobre el mismo pedido—. Nada de lo
   * que la persona escribe. «Dispara y olvida»: no cambia lo que pasa en pantalla.
   */
  private reportarRechazo(accion: 'cerrar_preventa' | 'cerrar_kepler', o: PickerWave, e: unknown, cambios = 0): void {
    const status = Number((e as { status?: unknown })?.status ?? 0) || 0;
    this.uso.reportarIncidente('surtir_cierre_rechazado', {
      accion,
      status,
      motivo: this.mensaje(e, '').slice(0, 300),
      ola_id: o.id,
      renglones: o.lines.length,
      faltantes: this.conFaltante(),
      cambios,
    });
  }

  /** `[MCP.3.2]` La lista de pedidos de Kepler por surtir (folio y cliente). */
  verLista(): void {
    irConservandoPanel(this.router, '/almacen/pedidos');
  }

  volverALista(): void {
    this.reporte.set(null);
    this.fase.set('listo');
    this.cargarSucursal();
  }

  /**
   * `[GP.RF.35]` «← Pedidos» con un pedido de preventa a medias: regresa a la lista sin cerrarlo. Lo marcado
   * vive en el celular hasta «Terminé de surtir» (PREF_MARCAS), y el pedido sigue a nombre de quien lo empezó:
   * reaparece en «Los que estás surtiendo» con «Continuar».
   */
  volverAPedidos(): void {
    const id = this.pedidoSucursal()?.order_id ?? null;
    this.editando.set(null);
    this.otraAbierta.set(null);
    this.cerrarCambio();
    this.busqueda.set('');
    this.avisoEscaneo.set(null);
    this.ola.set(null);
    this.pedidoSucursal.set(null);
    this.volverALista();
    this.alInicio();
    // [GP.RF.38] El foco regresa a la tarjeta del pedido que se dejó (queda en «Los que estás surtiendo»),
    // sin mover la vista: la lista sigue empezando arriba.
    this.enfocarLuego(() =>
      (id ? this.host.nativeElement.querySelector<HTMLElement>(`[data-pedido="${id}"]`) : null)
      ?? this.host.nativeElement.querySelector<HTMLElement>('#sr-titulo-lista'));
  }

  /**
   * `[GP.RF.38]` «← Pedidos». La vista cambia al instante; si el pedido dejó su entrada en el historial,
   * además se saca (`back`), para que el siguiente «atrás» no vuelva a abrir el pedido que se acaba de dejar.
   */
  irAPedidos(): void {
    const enHistorial = this.pedidoEnHistorial;
    this.pedidoEnHistorial = false;
    this.volverAPedidos();
    if (enHistorial) this.location.back();
    else this.quitarPedidoDeLaUrl();
  }

  /**
   * `[GP.RF.35]` Abrir un pedido (o volver a la lista) empieza ARRIBA. Medido en el celular: al abrir un pedido
   * de abajo de la lista, la vista quedaba en −1,381 px, a media lista de productos. Quien se desplaza no es
   * `window` sino el contenedor del layout: se busca el ancestro que de verdad se desplaza.
   */
  private alInicio(): void {
    if (typeof getComputedStyle === 'undefined') return;
    let p: HTMLElement | null = this.host.nativeElement.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    const caja = p ?? (document.scrollingElement as HTMLElement | null);
    if (caja) caja.scrollTop = 0;
  }

  /**
   * `[GP.RF.34][GP.RF.35]` El lugar del renglón, lo primero de su tarjeta. Telemarketing siempre lo dice (con
   * o sin ubicación dada de alta). En preventa, sólo si el servidor mandó el apoyo de surtido (`presentaciones`):
   * con un servidor anterior no se sabe, y no se afirma «sin ubicación».
   */
  lugarDe(l: PickerWaveLine): { code: string | null } | null {
    if (this.pedidoSucursal() && !l.presentaciones) return null;
    return { code: l.bin_code || null };
  }

  fechaCorta(dia: string): string {
    const [y, m, d] = dia.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  dinero(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  fmtNum(n: number): string {
    return this.fmt(Number(n));
  }

  /** Almacenes + la ola que la persona ya traía (si cerró la app a medias, la retoma). */
  iniciar(): void {
    this.error.set(null);
    this.fase.set('cargando');
    // Lo guardado puede ser '' (el viejo "Todos"): cae en Telemarketing, que era lo que le daba.
    // El aviso de la campana trae ?pedido=<id>: es de Sucursal y se abre directo.
    // [MCP.3.6] Siempre abre en SUCURSAL (David, 2026-10-21): ahí llegan las rutas de los vendedores.
    // Antes abría en Telemarketing salvo que el celular recordara Sucursal, y con eso el surtidor no
    // veía la ruta que el vendedor acababa de cerrar. Telemarketing se elige a mano cada vez.
    // El aviso de la campana trae ?pedido=<id>: es de Sucursal y se abre directo.
    const pedido = this.ruta.snapshot.queryParamMap.get('pedido');
    this.origen.set('SUCURSAL');
    // Sólo sucursales Kepler (código de 2 dígitos, ya filtradas por el servidor según el alcance):
    // los pedidos U-D-40 salen de ahí. Con el permiso de SURTIR, no el de almacenes.
    this.api.almacenesSurtido().subscribe({
      next: (ws) => {
        const suc = (ws || []).map((w) => ({ id: w.id, code: w.code, name: w.nombre }));
        this.almacenes.set(suc);
        const guardado = this.leer(PREF_ALMACEN);
        const delUsuario = this.auth.user()?.warehouse_code;
        const def =
          suc.find((w) => w.id === guardado) ?? (delUsuario ? suc.find((w) => w.code === delUsuario) : undefined);
        this.almacenId.set(def?.id ?? '');
        // [GP.RF.27] Abrir NO escribe ni espera a Telemarketing (decisión de Edgar, 2026-11-17). Antes se
        // pedía «mis surtidos» y, si había uno a medias, se retomaba SOLO con «tomar siguiente» (una
        // escritura de hasta 21 s); la lista de preventa, que es lo que el surtidor vino a ver, esperaba
        // detrás. Ahora la lista sale de inmediato y lo de Telemarketing a medias es un aviso con
        // «Continuar» (un toque, `continuarOla`).
        if (pedido) {
          this.surtirPedido(pedido);
          this.cargarSucursal(true);
        } else {
          this.fase.set('listo');
          if (this.origen() === 'SUCURSAL') this.cargarSucursal();
        }
        this.api.misOlas().subscribe({
          next: (olas) => this.olaAMedias.set(olas[0] ?? null),
          // Sin poder revisarlo no se inventa un «no traes nada»: se dice, sin frenar la pantalla.
          error: () => this.error.set('No se pudo revisar si traías un surtido de Telemarketing a medias.'),
        });
      },
      error: () => {
        this.error.set('No se pudo leer la lista de almacenes.');
        this.fase.set('listo');
      },
    });
  }

  /** Reintentar: si falta la lista de almacenes, se recarga todo; si no, se vuelve a pedir trabajo. */
  reintentar(): void {
    if (!this.almacenes().length) {
      this.iniciar();
      return;
    }
    this.error.set(null);
    // [MCP.3.1] En Sucursal reintentar es volver a pedir la lista: "Tomar siguiente" sin origen
    // armaría trabajo desde Kepler, que es justo lo que no se mezcla.
    if (this.origen() === 'SUCURSAL' && this.fase() === 'listo') {
      this.cargarSucursal();
      return;
    }
    this.tomar();
  }

  elegirAlmacen(id: string): void {
    this.almacenId.set(id);
    this.guardar(PREF_ALMACEN, id);
    this.sinTrabajo.set(null);
  }

  /**
   * `[GP.RF.27]` Retoma el surtido de Telemarketing que quedó a medias (el aviso de arriba). Se retoma
   * con «tomar siguiente» y NO pintando la ola tal cual: una ola asignada por la consola puede venir
   * sin arrancar (sin renglones) y «0 pendientes» habilitaba cerrarla sin surtir nada.
   */
  continuarOla(o: PickerWave): void {
    this.almacenId.set(o.warehouse_id);
    this.origen.set('TELEMARK');
    this.olaAMedias.set(null);
    this.tomar();
  }

  elegirOrigen(v: Origen): void {
    this.origen.set(v);
    this.sinTrabajo.set(null);
    if (v === 'SUCURSAL') this.cargarSucursal();
  }

  tomar(): void {
    const almacen = this.almacenId();
    if (!almacen) {
      this.fase.set('listo');
      return;
    }
    this.tomando.set(true);
    this.sinTrabajo.set(null);
    // [MCP.3.1] Siempre Telemarketing: "Tomar siguiente" arma desde Kepler y Sucursal no se mezcla.
    // Si ya trae una ola (de cualquier origen) el servidor le devuelve ésa primero.
    this.api.tomarSiguiente({ warehouse_id: almacen, origen: 'TELEMARK' }).subscribe({
      next: (r) => {
        this.tomando.set(false);
        this.error.set(null);
        this.atoradas.set(r.atoradas ?? []);
        if (r.estado === 'asignada') {
          this.ola.set(r.ola);
          this.busqueda.set('');
          this.editando.set(null);
          this.ocultarHechos.set(false);
          this.fase.set('surtiendo');
          this.alInicio();
          this.anuncio.set(`Surtido ${r.ola.code}: ${plural(r.ola.lines.length, 'renglón', 'renglones')}.`);
          if (r.ya_era_tuya) this.avisar('info', 'Sigues con el surtido que ya traías.');
        } else {
          this.sinTrabajo.set({ motivo: r.motivo, armado: r.armado });
          this.fase.set('listo');
        }
      },
      error: (e) => {
        this.tomando.set(false);
        // En la pantalla y no sólo en un aviso de 4 segundos: con guantes, el aviso se pierde.
        this.error.set(this.mensaje(e, 'No se pudo tomar trabajo.'));
        // Al RETOMAR (desde iniciar) la fase todavía es 'cargando': sin esto el spinner quedaba
        // para siempre.
        if (this.fase() === 'cargando') this.fase.set('listo');
      },
    });
  }

  completo(l: PickerWaveLine): void {
    this.marcar(l, l.qty_requested);
  }

  noHabia(l: PickerWaveLine): void {
    this.marcar(l, 0, 'agotado');
  }

  abrirFaltante(l: PickerWaveLine): void {
    this.borrador.set(null);
    this.editando.set(l.id);
    // El cursor ya en el número: se teclea mirando el producto, no la pantalla.
    setTimeout(() => (document.getElementById('sr-q-' + l.id) as HTMLInputElement | null)?.focus());
  }

  cerrarEditor(): void {
    this.editando.set(null);
  }

  /** Lo capturado viene en la unidad que ve el surtidor; se convierte a la base para guardar. */
  guardarFaltante(l: PickerWaveLine): void {
    if (!this.borradorValido(l)) return;
    const base = this.aBase(l, Number(this.borrador()));
    this.marcar(l, base, base === 0 ? 'agotado' : undefined);
  }

  borradorValido(l: PickerWaveLine): boolean {
    const v = this.borrador();
    if (v == null || (v as unknown) === '' || !Number.isFinite(Number(v)) || Number(v) < 0) return false;
    return this.aBase(l, Number(v)) <= l.qty_requested;
  }

  /** Para decir POR QUÉ "Guardar" está apagado, no sólo apagarlo. */
  borradorFueraDeRango(l: PickerWaveLine): boolean {
    const v = this.borrador();
    if (v == null || (v as unknown) === '' || !Number.isFinite(Number(v))) return false;
    return Number(v) < 0 || this.aBase(l, Number(v)) > l.qty_requested;
  }

  /**
   * Enter en el buscador (el escáner manda el código y un Enter): con UNA coincidencia pendiente,
   * el foco va a su "Completo". No lo marca solo: escanear la etiqueta no es haber contado.
   */
  /** `[GP.RF.33]` Lo que dijo el último escaneo que no se pudo marcar solo (otra presentación, ya marcado). */
  readonly avisoEscaneo = signal<string | null>(null);

  /**
   * Enter en el campo de búsqueda (el lector de código de barras manda Enter). `[GP.RF.33]` Si lo
   * escaneado es la presentación pedida de UN renglón pendiente, se marca Completo y el campo queda listo
   * para el siguiente. Si es otra presentación, se avisa y no se marca. Sin saberlo, lo de antes: deja el
   * foco en «Completo» del único renglón que coincide.
   */
  enterBuscar(): void {
    this.avisoEscaneo.set(null);
    const r = leerEscaneo(this.busqueda(), this.ola()?.lines ?? []);
    if (r?.tipo === 'completo') {
      const nombre = r.linea.product_name || r.linea.sku;
      this.completo(r.linea);
      this.busqueda.set('');
      this.anuncio.set(`${nombre}: completo.`);
      setTimeout(() => (document.getElementById('sr-buscar') as HTMLInputElement | null)?.focus());
      return;
    }
    if (r?.tipo === 'otra_presentacion') {
      this.avisoEscaneo.set(`Escaneaste ${r.escaneada}; el pedido pide ${r.pedida}. Cuenta en ${r.pedida} y marca a mano.`);
      return;
    }
    if (r?.tipo === 'ya_marcado') {
      this.avisoEscaneo.set(`${r.linea.product_name || r.linea.sku} ya está marcado. Para cambiarlo, toca «Corregir».`);
      return;
    }
    const p = this.pendientes();
    if (p.length === 1) {
      (document.getElementById('sr-ok-' + p[0].id) as HTMLButtonElement | null)?.focus();
    }
  }

  limpiarBusqueda(): void {
    this.busqueda.set('');
    setTimeout(() => (document.getElementById('sr-buscar') as HTMLInputElement | null)?.focus());
  }

  cerrar(): void {
    const o = this.ola();
    if (!o || this.pendientesTotal() > 0) return;
    if (this.pedidoSucursal()) {
      this.cerrarSucursal(o);
      return;
    }
    this.reporte.set(null);
    this.cerrando.set(true);
    this.api.finish(o.id).subscribe({
      next: (r) => {
        this.cerrando.set(false);
        this.resumen.set({
          completos: o.lines.filter((l) => l.status === 'surtido').length,
          faltantes: this.conFaltante(),
          cambios: r.cambios_en_kepler ?? [],
        });
        this.ola.set(null);
        this.fase.set('cerrada');
        this.anuncio.set('Surtido terminado.');
      },
      error: (e) => {
        this.cerrando.set(false);
        this.reportarRechazo('cerrar_kepler', o, e);
        this.avisar('error', this.mensaje(e, 'No se pudo terminar el surtido.'));
      },
    });
  }

  /**
   * `[GP.RF.30]` Regresa a la pantalla de donde se llegó (el Tablero, el Andén…). Antes iba a
   * `/almacen`, que brinca a la primera pantalla del área: Inventario para superadmin, y para el
   * surtidor Surtir misma, o sea que «Salir» no hacía nada. Sin pantalla anterior, va al Tablero:
   * su ruta también la abre quien surte (`COMMERCIAL_PICKING_GESTIONAR`), que es quien entra aquí.
   */
  salir(): void {
    irConservandoPanel(this.router, destinoDeSalida(this.previa, puedeAbrirTablero(this.perms)));
  }

  // ── Cantidades ──────────────────────────────────────────────────────────────────────────

  /** La cantidad completa en texto: en la presentación de la hoja si existe; si no, en la base. */
  cantidadPrincipal(l: PickerWaveLine): string {
    return `${this.cantidadNumero(l)} ${this.unidadConteo(l)}`.trim();
  }

  cantidadNumero(l: PickerWaveLine): string {
    return this.tienePresentacion(l) ? this.fmt(Number(l.qty_presentacion)) : this.fmt(l.qty_requested);
  }

  /** La unidad base, debajo, sólo cuando la principal es la presentación y difieren. */
  cantidadBase(l: PickerWaveLine): string | null {
    if (!this.tienePresentacion(l)) return null;
    if (l.unidad_presentacion === l.qty_unit) return null;
    return `= ${this.fmt(l.qty_requested)} ${l.qty_unit ?? ''}`.trim();
  }

  unidadConteo(l: PickerWaveLine): string {
    return this.tienePresentacion(l) ? (l.unidad_presentacion ?? '') : (l.qty_unit ?? 'la unidad del pedido');
  }

  /**
   * `[GP.3c]` Cómo pintar la existencia contra lo pedido:
   *  · `sin_dato`: el sistema no la trae (null), que NO es "no hay".
   *  · `neutral`: la unidad de la existencia no es la del pedido (0.35% medido): no se compara.
   *  · `cero` / `poca` / `ok`: comparadas en la misma unidad base.
   */
  existenciaEstado(l: PickerWaveLine): 'sin_dato' | 'neutral' | 'cero' | 'poca' | 'ok' {
    if (l.existencia == null) return 'sin_dato';
    const misma = !!l.existencia_unidad && !!l.qty_unit && l.existencia_unidad === l.qty_unit.toUpperCase();
    if (!misma) return 'neutral';
    if (l.existencia <= 0) return 'cero';
    return l.existencia < l.qty_requested ? 'poca' : 'ok';
  }

  existenciaTexto(l: PickerWaveLine): string {
    const e = this.existenciaEstado(l);
    if (e === 'sin_dato') return 'Existencia: sin dato en el sistema';
    // Negativa = un ajuste pendiente en Kepler: no se lee igual que "no hay".
    if (Number(l.existencia) < 0) return 'Kepler marca existencia negativa';
    if (e === 'cero') return 'Sin existencia en el sistema';
    const n = `${this.fmt(Number(l.existencia))} ${l.existencia_unidad ?? ''}`.trim();
    if (e === 'neutral') return `Hay ${n} en el sistema (otra unidad, no se compara)`;
    return e === 'poca' ? `Hay sólo ${n} en el sistema` : `Hay ${n} en el sistema`;
  }

  /** "Existencia de Kepler de hace 42 min": el dato llega con atraso y hay que decirlo. */
  existenciaAlTexto(al: string | null): string {
    if (!al) return 'Existencia de Kepler: no se sabe de qué hora es';
    const min = Math.max(0, Math.round((Date.now() - new Date(al).getTime()) / 60000));
    if (min < 1) return 'Existencia de Kepler al momento';
    if (min < 60) return `Existencia de Kepler de hace ${min} min`;
    const h = Math.floor(min / 60);
    return `Existencia de Kepler de hace ${plural(h, 'hora', 'horas')}`;
  }

  /** Teclado entero para cajas y bultos; con punto decimal sólo cuando se cuenta por peso. */
  modoTeclado(l: PickerWaveLine): 'numeric' | 'decimal' {
    return ['KG', 'GR', 'LT', 'L', 'G'].includes(this.unidadConteo(l).toUpperCase()) ? 'decimal' : 'numeric';
  }

  /** "Faltaron 1 de 3 BTO": dice cuánto FALTÓ, que es lo que importa al checar. */
  faltaronTexto(l: PickerWaveLine): string {
    if (l.qty_picked == null) return 'Faltante';
    const f = this.factor(l);
    const pedido = f ? Number(l.qty_presentacion) : l.qty_requested;
    const levantado = f ? l.qty_picked / f : l.qty_picked;
    const falta = Math.round((pedido - levantado) * 1000) / 1000;
    return `Faltaron ${this.fmt(falta)} de ${this.fmt(pedido)} ${this.unidadConteo(l)}`;
  }

  /**
   * Hay presentación usable: con unidad y cantidad > 0 (una presentación en 0 se ignora).
   * `[GP.9.2]` Si el pedido se capturó con OTRA caja que la de hoy (10 CJA de 40, y hoy la CJA es de
   * 25), la presentación miente: se cuenta en la unidad base (400 PAQ), y el faltante no se convierte
   * con el factor viejo.
   */
  private tienePresentacion(l: PickerWaveLine): boolean {
    if (l.aviso_caja?.tipo === 'capturada_con_otra') return false;
    return l.qty_presentacion != null && l.qty_presentacion > 0 && !!l.unidad_presentacion;
  }

  /**
   * Base por unidad de presentación (75 KG / 3 BTO = 25), o null si se cuenta en la base.
   * ⚠️ Es un PROMEDIO del renglón: con bultos de peso variable entre pedidos, un faltante
   * capturado en bultos se convierte con el peso medio, no con el de cada bulto.
   */
  private factor(l: PickerWaveLine): number | null {
    if (!this.tienePresentacion(l)) return null;
    return l.qty_requested / Number(l.qty_presentacion);
  }

  private aBase(l: PickerWaveLine, capturado: number): number {
    const f = this.factor(l);
    const base = f ? capturado * f : capturado;
    // Milésimas: la precisión de la base. Si capturó la presentación completa, es lo pedido exacto.
    if (f && Math.round(capturado * 1000) === Math.round(Number(l.qty_presentacion) * 1000)) return l.qty_requested;
    return Math.round(base * 1000) / 1000;
  }

  private fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toLocaleString('es-MX', { maximumFractionDigits: 3 });
  }

  // ── Guardado ────────────────────────────────────────────────────────────────────────────

  private marcar(l: PickerWaveLine, qty: number, status?: string): void {
    const o = this.ola();
    if (!o) return;
    if (this.pedidoSucursal()) {
      this.marcarSucursal(l, qty);
      return;
    }
    this.guardando.update((s) => new Set([...s, l.id]));
    this.api.pick(o.id, l.id, { qty_picked: qty, status }).subscribe({
      next: (upd) => {
        this.quitarGuardando(l.id);
        this.editando.set(null);
        const venia = this.busqueda();
        this.ola.update((w) =>
          w
            ? {
                ...w,
                lines: w.lines.map((x) =>
                  x.id === l.id
                    ? { ...x, qty_picked: Number(upd.qty_picked), status: upd.status as PickerWaveLine['status'] }
                    : x,
                ),
              }
            : w,
        );
        const nombre = l.product_name || l.sku || 'Renglón';
        this.anuncio.set(
          upd.status === 'surtido' ? `${nombre}: completo.` : upd.status === 'agotado' ? `${nombre}: no había.` : `${nombre}: con faltante.`,
        );
        // Si llegó por el buscador (escaneó la etiqueta), se limpia y el foco vuelve ahí para
        // escanear el siguiente. Si no, el foco va al "Completo" del siguiente pendiente: el botón
        // que se tocó desaparece y, sin esto, el foco quedaría perdido en la página.
        if (venia) {
          this.limpiarBusqueda();
        } else {
          const siguiente = this.pendientes()[0];
          if (siguiente) {
            setTimeout(() => (document.getElementById('sr-ok-' + siguiente.id) as HTMLButtonElement | null)?.focus());
          }
        }
      },
      error: (e) => {
        this.quitarGuardando(l.id);
        this.avisar('error', this.mensaje(e, 'No se guardó. Vuelve a intentar.'));
        // 409 = el surtido ya no está abierto (lo cancelaron o ya se cerró): seguir en él dejaría
        // la pantalla sin salida. Se vuelve a "Tomar siguiente".
        if ((e as { status?: number })?.status === 409) {
          this.ola.set(null);
          this.fase.set('listo');
          this.error.set('Este surtido ya no está abierto. Toma el siguiente.');
        }
      },
    });
  }

  private quitarGuardando(id: string): void {
    this.guardando.update((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }

  private avisar(severity: 'info' | 'error', detail: string): void {
    this.toast.add({ severity, summary: severity === 'error' ? 'Error' : 'Aviso', detail, life: 5000 });
  }

  private mensaje(e: unknown, def: string): string {
    const m = (e as { error?: { message?: unknown } })?.error?.message;
    return typeof m === 'string' && m ? m : def;
  }

  private leer(k: string): string {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  }

  private guardar(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* sin almacenamiento local: sólo se pierde la preferencia, no el trabajo */
    }
  }
}
