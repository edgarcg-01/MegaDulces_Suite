import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { branchLabel } from '../../../core/constants/store-branches';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  CLASIFICACION_LABEL, ComprobacionesService,
  type ExpenseClasificacion, type ExpenseProof, type ExpenseProofsReport, type ValeGasto,
} from '../comprobaciones.service';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { REFRESCO_VALES_MS } from '../vales-refresco';
import { ValeGastoPeekComponent, type AccionVale } from '../components/vale-gasto-peek.component';
import { resumenDeLaRuta, rutaDelVale, segmentosDeLaRuta, type EstadoDelSegmento } from '../components/ruta-del-vale';
import { EvidenciaAdicionalDialogComponent, type EvidenciaAgregada } from '../components/evidencia-adicional-dialog.component';
import { BuscadorGastosEstado } from '../components/buscador-gastos.estado';
import { BuscadorGastosComponent } from '../components/buscador-gastos.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { lineaDelGasto, pideComparar, pideGenerarOtraVez, polizaCorta, puedeEscribirseYa } from './esperan-kepler.ayudas';
import { diaMxDe, parseLocalDate } from '../../../core/utils/mx-date';
// `[GX.39]` La etapa la decide el SERVIDOR con `etapaDeEjercicio()`; acá sólo se lee el tipo.
import type { EtapaEjercicio, ValeAsignado, TransferenciaGasto } from '@megadulces/contracts';
import { aceptaEvidenciaAdicional } from '@megadulces/contracts';
import {
  DIAS_ATORADO, diasDesde, notaDePago, situacionDe, textoAntiguedad,
  type AQuien, type NotaDePago, type Situacion,
} from '../mis-gastos-columnas';

/**
 * `[GX.46]` `asignado` es una etapa **de esta pantalla**, no del contrato: el contrato decide
 * el ciclo de un expediente NUESTRO, y un vale asignado todavía no lo es.
 */
type EtapaLista = EtapaEjercicio | 'asignado';

/** Una fila de la lista, venga de Kepler o de un expediente nuestro. */
interface FilaLista {
  key: string;
  folio: string;
  sucursal: string | null;
  fecha: string | null;
  importe: number;
  titulo: string | null;
  detalle: string | null;
  etapa: EtapaLista | null;
  status: string | null;
  motivo_rechazo: string | null;
  /** `[GX.54]` Aprobado pero debiendo el comprobante (entró con cotización o prefactura). */
  debeFactura: boolean;
  /** `[GX.55]` Si esta fila ofrece el camino para subir un archivo. */
  puedeSubir: boolean;
  proveedor_clave: string | null;
  gasto_folios: string[];
  /** `[GX.75]` Lo que la fila dice del pago; `null` = nada que decir. */
  notaPago: NotaDePago | null;
  /** `null` = viene de Kepler y no tiene expediente: no se puede abrir. */
  proof: ExpenseProof | null;
  /** `[GX.97]` A quién le toca y qué falta. `null` = estado que la regla no conoce. */
  situacion: Situacion | null;
  /**
   * `[GX.106]` El día (de México, `YYYY-MM-DD`) en que se mandó: el vale, cuando se subió a la Suite;
   * la solicitud de Kepler sin vale, su fecha. `null` si no se puede leer. Va como campo para ordenar.
   */
  enviado: string | null;
  /**
   * `[GX.108]` La fecha del DOCUMENTO de una solicitud de Kepler cuando no es la de «Se mandó» (se capturó
   * otro día: una póliza vieja). Sólo se muestra. `null` = es la misma, o es un vale nuestro.
   */
  fechaDocumentoDistinta: string | null;
  /** `[GX.106]` Días desde que se mandó (antes: desde la fecha del gasto); `null` si no se puede leer. */
  dias: number | null;
  /**
   * `[PGP.123]` G-RED.2 — La barrita de la ruta (la misma `rutaDelVale` del panel) y lo que dice en palabras. Vacía en la
   * solicitud de Kepler sin vale: no tiene ruta en la Suite, y no se le inventa una.
   */
  segmentos: EstadoDelSegmento[];
  resumenRuta: string;
}

/** El orden del filtro y su rótulo. Es también el orden en que se elige el filtro inicial. */
const FILTROS: readonly { value: AQuien; label: string; vacio: string }[] = [
  { value: 'tu', label: 'Te toca', vacio: 'Nada te toca: no tienes vales por subir ni devueltos.' },
  { value: 'finanzas', label: 'Esperan a Finanzas', vacio: 'Ningún vale tuyo espera revisión de Finanzas.' },
  { value: 'kepler', label: 'Esperan a Kepler', vacio: 'Ningún vale revisado espera a Kepler.' },
  { value: 'cerrado', label: 'Cerrados', vacio: 'Todavía no tienes vales cerrados.' },
];

/**
 * `[GX.33]` — **Mis gastos.** Lo que YO levanté, en qué quedó cada uno, y su expediente.
 *
 * ## `[GX.97]` v2: «¿qué me toca?», y lo demás por a quién espera
 * La auditoría en prod del 2026-11-05 (ver `docs/MODULOS/finanzas-mis-gastos-v2.md`) midió que el
 * tablero de tres columnas (`[GX.65.5]`) escondía lo atorado: 32 revisados con la solicitud
 * cancelada nunca cerraban, 62 esperaban a Kepler sin que nadie que pudiera moverlos los viera, y
 * con 30 vales una columna medía 3,285 px contra 955 y 839. Ahora es UNA lista con un filtro por
 * **a quién le toca** (con su conteo dentro), y las etapas conservan sus nombres (Solicitud ·
 * Pendiente de comprobación · Expediente) como etiqueta de la fila.
 *
 * ## ⛔ No filtra del lado del cliente lo que es de otro
 * Pide `GET /mine`, que el servidor acota por el token. Si el recorte viviera acá, un error de
 * esta pantalla mostraría el gasto ajeno — y nadie se enteraría.
 *
 * ## `[GX.94]` Un rechazo se queda hasta que deja de pedir algo
 * El servidor lo devuelve hasta que se recaptura o Kepler cancela la solicitud (antes: 24 h).
 */
@Component({
  selector: 'app-finanzas-mis-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TableModule, RouterLink, BuscadorGastosComponent,
    ValeGastoPeekComponent, EvidenciaAdicionalDialogComponent, LoadStateComponent, FreshnessPillComponent, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in mg dt-scope">
      <!-- [GX.101] El buscador va junto al título (pedido del usuario: «a uno más visible»). Mientras hay
           búsqueda, lo de abajo del encabezado se cambia por los resultados; el encabezado se queda
           (si no, la caja se iría mientras se escribe). El visor y el diálogo del final NO se
           esconden: son los que abren el vale elegido. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mis gastos</h1>
          <p class="surf-page-sub">Tus vales, desde que los levantas hasta que Kepler los cierra.</p>
        </div>
        <div class="mg-head-acc">
          <app-buscador-gastos parte="caja" />
                    <app-freshness-pill measures="fetch" [since]="ultimaCarga()" />
          <button pButton type="button" class="p-button-text p-button-sm" (click)="cargar()" [loading]="cargando()"
                  aria-label="Actualizar"><i class="pi pi-refresh" aria-hidden="true"></i></button>
          <!-- [GX.97] La única acción primaria. Antes «Mis gastos» no tenía entrada a la captura. -->
          <!-- [PGP.122.10] Decía «Capturar gasto»: no se sabía que ahí también se PIDE. Mismo nombre que su pestaña. -->
          <a pButton class="mg-capturar" routerLink="/finanzas/gastos"><i class="pi pi-plus" aria-hidden="true"></i>&nbsp;Pedir un gasto</a>
        </div>
      </header>
      @if (buscandoArriba()) {
        <app-buscador-gastos parte="resultados" />
      } @else {

      @if (refrescoFallo(); as hora) {
        <!-- [GX.97] Un refresco que falla no pisa la lista buena, pero se DICE: la lista ya no es de ahora. -->
        <p class="mg-aviso" role="status">No se pudo actualizar a las {{ hora }}. Lo que ves es de la última carga.</p>
      }

      <app-load-state [loading]="cargando() && !cargadaUnaVez()" [error]="error() || null" [isEmpty]="false"
                      errorTitle="No se pudieron cargar tus gastos" (retry)="cargar()">
        <p class="mg-respuesta">
          @if (teTocan() > 0) {
            <strong>{{ teTocan() === 1 ? 'Te toca 1 vale.' : 'Te tocan ' + teTocan() + ' vales.' }}</strong>
          } @else {
            <strong>Nada te toca.</strong>
          }
          @if (sinCerrar() > 0) {
            <span class="mg-respuesta-sub">{{ money(sinCerrar()) }} de tus gastos siguen sin cerrar.</span>
          }
        </p>

        <div class="mg-barra">
          <app-segmented [options]="opciones()" [value]="filtro()" (valueChange)="elegir($event)" ariaLabel="A quién le toca" />
          <!-- [GX.88] Quien aprueba ya tiene el buscador de arriba: una sola caja por pestaña. -->
          @if (!hayBuscadorArriba()) {
            <span class="p-input-icon-left mg-buscar">
              <i class="pi pi-search" aria-hidden="true"></i>
              <input pInputText type="search" [ngModel]="q()" (ngModelChange)="escribir($event)" (keydown.enter)="buscarYa()"
                     aria-label="Buscar en mis gastos" placeholder="Folio, proveedor o concepto…" />
            </span>
          }
        </div>

        <!-- [PGP.123] G.14: lo que contestó Kepler al generar un gasto; siempre presente para que el lector de pantalla lo anuncie. -->
        <div class="mg-sub" role="status" aria-live="polite">@if (avisoGasto(); as a) { <span [class.mg-mal]="a.mal">{{ a.texto }}</span> }</div>
        @if (fueraDeColumnas() > 0) {
          <!-- Un estado que la regla no conoce se DICE, no se mete callado en una lista. -->
          <p class="mg-err">{{ fueraDeColumnas() }} vale(s) con un estado que esta pantalla no sabe ubicar. Avisa a Sistemas.</p>
        }

        @if (!visibles().length) {
          <div class="mg-vacio">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <div>
              @if (q()) {
                <strong>Ninguno de tus gastos coincide con «{{ q() }}».</strong>
              } @else {
                <strong>{{ textoVacio() }}</strong>
              }
            </div>
          </div>
        } @else {
          <!-- [PGP.122.9] La tabla dice QUÉ lista es (caption) y cada encabezado es de su columna (scope); modern-web-guidance: responsive-table. -->
          <p-table [value]="visibles()" dataKey="key" size="small" class="surf-table surf-table--plain surf-table--sticky mg-tabla dt-stack">
            <ng-template #caption><span class="mg-sr">Tus vales: {{ nombreDelFiltro() }}</span></ng-template>
            <ng-template #header>
              <tr>
                <!-- [PGP.123] G.15 (observación de usuario, 2026-11-21): «Folio» era el de la SOLICITUD y el de la
                     comprobación vivía como «XA1001-…» debajo de «Cómo cerró»; costaba encontrarlo. Cada uno con su
                     nombre, uno junto al otro: de dónde viene el gasto y con qué se comprobó. -->
                <th scope="col">Folio de solicitud</th>
                @if (mostrarComprobacion()) { <th scope="col" class="mg-c-comp">Folio de comprobación</th> }
                <th scope="col" pSortableColumn="titulo">Proveedor <p-sorticon field="titulo" /></th>
                <th scope="col" class="mg-c-etapa">Etapa</th>
                <th scope="col">{{ encabezadoSituacion() }}</th>
                <!-- [GX.106] La fecha en que se mandó, no «hace N días» (pedido del usuario, 2026-11-09). -->
                <th scope="col" class="mg-c-env" pSortableColumn="enviado">Se mandó <p-sorticon field="enviado" /></th>
                <th scope="col" class="comm-num" pSortableColumn="importe">Importe <p-sorticon field="importe" /></th>
                <th scope="col"><span class="mg-sr">Acción</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <!-- [PGP.123] G.15: con «Folio de comprobación» la tabla llega a 8 columnas; en estrecho se APILA (DESIGN_TABLES §6,
                   caso A: las columnas son campos del vale). El folio es la identidad (dt-id, sin rótulo) y la acción no lleva
                   rótulo (sólo el botón, con sus 44 px). -->
              <tr>
                <td class="dt-id" role="cell"><div class="mg-celda">
                  @if (f.proof) {
                    <button type="button" class="mg-folio" (click)="abrir(f.proof)" [attr.aria-label]="'Ver el vale ' + (f.folio || 'sin folio')">{{ f.folio || 'sin folio' }}</button>
                  } @else {
                    <span class="mg-folio-txt">{{ f.folio || 'sin folio' }}</span>
                  }
                  @if (f.sucursal) { <div class="mg-sub">{{ branchLabel(f.sucursal) }}</div> }
                  <!-- En angosto la columna de la comprobación se quita y su folio baja aquí, rotulado. -->
                  @if (mostrarComprobacion()) {
                    @for (g of comprobacionDe(f); track g) { <div class="mg-sub mg-comp-angosto">comprobación <span class="mg-clave">{{ g }}</span></div> }
                  }
                </div></td>
                @if (mostrarComprobacion()) {
                  <td class="mg-c-comp" data-label="Folio de comprobación" role="cell">
                    @for (g of comprobacionDe(f); track g) { <div class="mg-folio-txt">{{ g }}</div> }
                    @empty { <span class="mg-sub" aria-hidden="true">—</span><span class="mg-sr">sin comprobación todavía</span> }
                  </td>
                }
                <td data-label="Proveedor" role="cell"><div class="mg-celda">
                  <div class="mg-prov">{{ f.titulo || '—' }}</div>
                  <div class="mg-sub">
                    @if (f.proveedor_clave) { <span class="mg-clave">{{ f.proveedor_clave }}</span> }
                    @if (f.detalle) { <span>{{ f.detalle }}</span> }
                    <!-- [GX.106] Rotulada: hay dos fechas en el renglón (cuándo se gastó y cuándo se mandó).
                         La solicitud de Kepler sin vale no la repite: su fecha ya es la de «Se mandó». -->
                    @if (f.proof && diaLocal(f.fecha); as d) { <span>gastado el {{ d | date: 'dd/MM/yy' }}</span> }
                    @if (diaLocal(f.fechaDocumentoDistinta); as d) { <span>documento del {{ d | date: 'dd/MM/yy' }}</span> }
                  </div>
                </div></td>
                <!-- [PGP.123] G-RED.2: la ruta del vale en cinco segmentos (los del panel), sobre el nombre de etapa que la gente
                     ya usa (GX.65.5). La barrita es para el ojo; el lector de pantalla oye el paso en palabras. -->
                <td class="mg-c-etapa" data-label="Etapa" role="cell"><div class="mg-celda">
                  @if (f.segmentos.length) {
                    <span class="mg-mini" aria-hidden="true">@for (s of f.segmentos; track $index) {<span class="mg-seg" [attr.data-estado]="s"></span>}</span>
                    <span class="mg-sr">{{ f.resumenRuta }}. </span>
                  }
                  <div class="mg-etapa">{{ f.situacion?.etapaNombre ?? '—' }}</div>
                </div></td>
                <td [attr.data-label]="encabezadoSituacion()" role="cell"><div class="mg-celda">
                  <div [class.mg-mal]="f.situacion?.mal">{{ f.situacion?.texto ?? '—' }}</div>
                  @if (f.notaPago; as n) { <div class="mg-sub" [class.mg-mal]="n.clase === 'bad'">{{ n.texto }}</div> }
                  <!-- [PGP.123] G.14: lo que falta para su gasto en Kepler, o el folio y la póliza que ya generó. -->
                  @if (f.situacion?.aQuien === 'kepler' && f.proof?.gasto_kepler; as g) {
                    <div class="mg-sub" [class.mg-mal]="lineaDelGasto(g).tono === 'bad'">{{ lineaDelGasto(g).texto }}</div>
                  }
                </div></td>
                <td class="mg-c-env" data-label="Se mandó" role="cell"><div class="mg-celda">
                  @if (diaLocal(f.enviado); as d) {
                    <span class="mg-fecha">{{ d | date: 'dd/MM/yy' }}</span>
                    <!-- Los días, sólo cuando urge: lo abierto que lleva más de un mes. En palabras, no sólo en ámbar. -->
                    @if (atorado(f)) { <div class="mg-atorado">{{ hace(f) }}</div> }
                  } @else {
                    <span class="mg-sub">—</span>
                  }
                </div></td>
                <td class="comm-num dt-num" data-label="Importe" role="cell">{{ money(f.importe) }}</td>
                <td class="mg-acc dt-actions" role="cell">
                  @if (f.proof && f.situacion?.aQuien === 'kepler' && puedeEscribirseYa(f.proof.gasto_kepler)) {
                    <!-- [PGP.123] G.14 (D1/D2 de Edgar, 2026-11-21): quien pidió el gasto lo genera en Kepler con un clic.
                         Lleva la cifra; se apaga mientras escribe; dos clics no escriben dos gastos. -->
                    <button pButton type="button" class="p-button-sm" [loading]="generando() === f.proof.id" [disabled]="!!generando()"
                            (click)="generarGasto(f.proof)">Generar gasto · {{ money(f.importe) }}<span class="mg-sr"> del vale {{ f.folio || 'sin folio' }}</span></button>
                  } @else if (f.proof && f.situacion?.aQuien === 'kepler' && pideComparar(f.proof.gasto_kepler)) {
                    <!-- [PGP.123] G.16 (DG12): el comprobante dice otro monto; el acto dice que se comparó antes de generar. -->
                    <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="generando() === f.proof.id" [disabled]="!!generando()"
                            (click)="generarGasto(f.proof, true)">Ya lo comparé · Generar {{ money(f.importe) }}<span class="mg-sr"> el gasto del vale {{ f.folio || 'sin folio' }}</span></button>
                  } @else if (f.proof && f.situacion?.aQuien === 'kepler' && pideGenerarOtraVez(f.proof.gasto_kepler)) {
                    <!-- [PGP.123] G-AUD.14 (2026-11-23): Kepler canceló el gasto; quizá a propósito. Gris, y el segundo clic
                         confirma que se escribe OTRO gasto. -->
                    @if (confirmarOtraVez() === f.proof.id) {
                      <!-- «No» va donde estaba «Generar otra vez»: un doble clic cae en lo seguro (modern-web-guidance, dialog). -->
                      <span class="mg-conf">
                        <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [disabled]="!!generando()"
                                (click)="confirmarOtraVez.set(null)">No</button>
                        <button pButton type="button" class="p-button-sm p-button-danger" [loading]="generando() === f.proof.id" [disabled]="!!generando()"
                                (click)="generarOtraVez(f.proof)">Sí, escribir otro · {{ money(f.importe) }}<span class="mg-sr"> gasto del vale {{ f.folio || 'sin folio' }}</span></button>
                      </span>
                    } @else {
                      <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="!!generando()"
                              (click)="confirmarOtraVez.set(f.proof.id)">Generar otra vez · {{ money(f.importe) }}<span class="mg-sr"> el gasto del vale {{ f.folio || 'sin folio' }}</span></button>
                    }
                  } @else if (f.puedeSubir) {
                    <a pButton class="p-button-sm p-button-outlined" [routerLink]="['/finanzas/gastos']"
                       [queryParams]="{ folio: f.folio, sucursal: f.sucursal }">
                      <i class="pi pi-camera" aria-hidden="true"></i>&nbsp;{{ f.debeFactura ? 'Subir la factura' : 'Subir evidencia' }}<span class="mg-sr"> del vale {{ f.folio || 'sin folio' }}</span>
                    </a>
                  } @else if (f.status === 'rechazada') {
                    <!-- [PGP.122.9] Varios «Capturar de nuevo» con distinto destino: el nombre lleva su folio. -->
                    <a pButton class="p-button-sm p-button-outlined" [routerLink]="['/finanzas/gastos']"
                       [queryParams]="{ folio: f.folio, sucursal: f.sucursal }">Capturar de nuevo<span class="mg-sr"> el vale {{ f.folio || 'sin folio' }}</span></a>
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        }

        <!-- [GX.95] Los cortes, DECLARADOS. Sin el campo (servidor viejo) no se afirma nada. -->
        @if (cortes().length) {
          <ul class="mg-cortes">
            @for (t of cortes(); track t) { <li>{{ t }}</li> }
          </ul>
        }
      </app-load-state>
      }

      <!-- El mismo visor que usan Aprobación y el Historial. Acá no se DECIDE nada: es lo tuyo,
           pero quien decide sobre el dinero es otra persona. Lo único que se ofrece es sumar
           evidencia con su porqué ([GX.87]), que no mueve el estado. -->
      <app-vale-gasto-peek [open]="abierto() !== null" (openChange)="cerrar($event)" [vale]="abierto()"
                           [acciones]="accionesDelVale()" [subirComprobante]="subirDelAbierto()"
                           [gastoKepler]="gastoDelAbierto()" [puedeReintentarGasto]="true" [ocupado]="!!generando()"
                           (reintentarGasto)="generarDesdePanel($event)"
                           (agregarEvidencia)="paraEvidencia.set($any($event))" />
      <app-evidencia-adicional-dialog [open]="paraEvidencia() !== null" (openChange)="cerrarEvidencia($event)"
                                      [vale]="paraEvidencia()" (agregado)="alAgregarEvidencia($event)" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }
    .mg { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    /* [PGP.123] G.15: en la tabla apilada la celda es una fila flex (rótulo | valor); su contenido va en un solo bloque. */
    .mg-celda { min-width: 0; }
    /* Apilada, la celda de acción vacía (Cerrados no tiene acción) no deja un hueco al final de cada vale. Sólo apilada:
       en la rejilla quitar un td desalinea las columnas. */
    @container densetable (max-width: 34rem) { .mg-acc:empty { display: none; } }
    /* En angosto (teléfono, o el panel con el menú abierto) se quita la Etapa: lo que decide es el
       folio, qué falta, cuándo se mandó (ahí vive la marca de atorado), el importe y la acción. */
    /* [PGP.123] G.15: dos clases, para ganarle a «.mg-sub { display: flex }» que va más abajo; y la base ANTES del
       @container (con la misma especificidad gana la última regla). */
    .mg-sub.mg-comp-angosto { display: none; }
    @container (max-width: 40rem) { .mg-c-etapa { display: none; } .mg-buscar input { width: 100%; }
      /* La comprobación baja al folio de la solicitud, rotulada, en vez de apretar otra columna. */
      .mg-c-comp { display: none; } .mg-sub.mg-comp-angosto { display: flex; } }
    .mg-head-acc { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .mg-aviso { margin: 0; font-size: var(--fs-sm); color: var(--warn-soft-fg); }
    .mg-err { margin: 0; font-size: var(--fs-sm); color: var(--bad-fg); }

    /* Q.1: la respuesta primero. Primario = cuántos te tocan; secundario = lo que sigue sin cerrar. */
    .mg-respuesta { margin: 0 0 var(--sp-2); display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); }
    .mg-respuesta strong { font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .mg-respuesta-sub { font-size: var(--fs-sm); color: var(--fg-2); }

    .mg-barra { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-2); }
    .mg-buscar input { width: 18rem; max-width: 100%; }

    .mg-vacio { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-5);
      border: 1px solid var(--border-color); border-radius: var(--r-md); color: var(--fg-2); }
    .mg-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    /* Terciario: sucursal, clave, fecha. */
    .mg-sub { font-size: var(--fs-xs); color: var(--fg-3); display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
    .mg-prov { font-size: var(--fs-sm); color: var(--fg-1); }
    .mg-clave { font-family: var(--font-mono); }
    .mg-folio, .mg-folio-txt { font-family: var(--font-mono); font-weight: var(--fw-bold); font-size: var(--fs-sm); }
    .mg-folio { border: 0; background: transparent; padding: 0; color: var(--action); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .mg-folio:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* El rojo sólo para lo que salió mal (te lo devolvieron); atorado, en el ámbar que se lee. */
    .mg-mal { color: var(--bad-fg); }
    /* [GX.106] La fecha en que se mandó; debajo, sólo si urge, cuántos días lleva. */
    .mg-fecha { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--fg-1); }
    .mg-atorado { font-size: var(--fs-xs); color: var(--warn-soft-fg); font-weight: var(--fw-bold); margin-top: 2px; white-space: nowrap; }
    .mg-acc { white-space: nowrap; text-align: right; }
    .mg-conf { display: inline-flex; align-items: baseline; gap: var(--sp-1); }
    .mg-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    /* [PGP.123] G-RED.2 — La barrita de la ruta. Mismo código que los marcadores del panel: lleno = hecho, naranja = toca
       ahora, rojo = con problema, contorno = después, punteado = no aplica / sin leer, tenue = cortado por un rechazo.
       El estado nunca va sólo en el color: la columna «Qué te falta» lo dice en palabras y el lector oye el paso. */
    .mg-mini { display: flex; gap: 2px; width: 5.5rem; margin-bottom: 4px; }
    .mg-seg { flex: 1; height: 6px; border-radius: 2px; box-sizing: border-box; border: 1px solid var(--fg-3); background: transparent; }
    .mg-seg[data-estado='hecho'] { background: var(--fg-1); border-color: var(--fg-1); }
    .mg-seg[data-estado='actual'] { background: var(--action); border-color: var(--action); }
    .mg-seg[data-estado='mal'] { background: var(--bad-fg); border-color: var(--bad-fg); }
    .mg-seg[data-estado='no_aplica'], .mg-seg[data-estado='sin_medir'] { border-style: dashed; }
    .mg-seg[data-estado='cortado'] { border-color: var(--border-color); }
    .mg-etapa { font-size: var(--fs-xs); color: var(--fg-2); }
    @media (forced-colors: active) {
      .mg-seg { forced-color-adjust: none; border-color: CanvasText; }
      .mg-seg[data-estado='hecho'], .mg-seg[data-estado='actual'], .mg-seg[data-estado='mal'] { background: CanvasText; }
      .mg-seg[data-estado='cortado'] { border-color: GrayText; }
    }

    .mg-cortes { margin: var(--sp-2) 0 0; padding-left: var(--sp-4); font-size: var(--fs-xs); color: var(--warn-soft-fg); }
  `],
})
export class FinanzasMisGastosComponent {
  /** `[GX.68]` La sucursal del vale se nombra con clave + nombre (`02 La Piedad Abastos`). */
  readonly branchLabel = branchLabel;
  private readonly svc = inject(ComprobacionesService);
  /** `[PGP.123]` G.14 — El vale cuyo gasto se está generando (uno a la vez) y lo que contestó Kepler. */
  readonly generando = signal<string | null>(null);
  readonly avisoGasto = signal<{ texto: string; mal: boolean } | null>(null);
  readonly puedeEscribirseYa = puedeEscribirseYa;
  readonly pideComparar = pideComparar;
  readonly pideGenerarOtraVez = pideGenerarOtraVez;
  /** `[PGP.123]` G-AUD.14 — El vale cuyo «Generar otra vez» espera el segundo clic. */
  readonly confirmarOtraVez = signal<string | null>(null);
  readonly lineaDelGasto = lineaDelGasto;
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute, { optional: true });

  readonly filas = signal<ExpenseProof[]>([]);
  readonly cargando = signal(true);
  readonly cargadaUnaVez = signal(false);
  readonly error = signal('');
  /** `[GX.97]` Cuándo llegó la lista que se ve (hora del navegador: dice «cargado hace N»). */
  readonly ultimaCarga = signal<Date | null>(null);
  /** `[GX.97]` Hora del refresco en segundo plano que falló; `null` = el último salió bien. */
  readonly refrescoFallo = signal<string | null>(null);
  readonly abierto = signal<ValeGasto | null>(null);
  /** `[GX.87]` El vale al que se le está sumando evidencia (abre el diálogo). */
  readonly paraEvidencia = signal<ValeGasto | null>(null);
  /**
   * `[GX.88]` El buscador de gastos vive ARRIBA de las pestañas (en el shell). Sólo lo tiene quien
   * aprueba. Esta pantalla esconde lo suyo mientras hay búsqueda y abre el vale elegido con lo que
   * ya ofrece: verlo y sumarle evidencia (quien aprueba puede sumarla a cualquier vale).
   */
  private readonly busqueda = inject(BuscadorGastosEstado, { optional: true });
  readonly buscandoArriba = computed(() => this.busqueda?.buscando() ?? false);
  /** `[GX.97]` Si arriba hay buscador, la caja local sobra: una sola caja por pestaña. */
  readonly hayBuscadorArriba = computed(() => this.busqueda?.puedeBuscar() ?? false);
  readonly q = signal('');
  private espera: ReturnType<typeof setTimeout> | null = null;

  /** Los cortes que mandó el servidor (`undefined` = servidor viejo: no se afirma nada). */
  private readonly reporte = signal<ExpenseProofsReport | null>(null);
  readonly asignados = signal<ValeAsignado[]>([]);

  /** `[GX.97]` El filtro que eligió la persona; `null` = todavía no eligió. */
  private readonly elegido = signal<AQuien | null>(null);

  /**
   * `[GX.46]` **UNA sola lista** de entrada: el vale que Kepler asignó y el expediente nuestro.
   * ⚠️ `proof` en `null` marca al que **no tiene expediente**: no se puede abrir y en su lugar
   * ofrece subir la evidencia.
   */
  readonly unificadas = computed<FilaLista[]>(() => [
    ...this.asignados().map((v): FilaLista => {
      const base = {
        key: `k:${v.sucursal}:${v.folio}`, folio: v.folio, sucursal: v.sucursal, fecha: v.fecha, importe: v.importe,
        titulo: v.destinatario, detalle: v.concepto, etapa: 'asignado' as const, status: null, motivo_rechazo: null,
        debeFactura: false, puedeSubir: true, proveedor_clave: null, gasto_folios: [] as string[],
        notaPago: null, proof: null,
      };
      // `[GX.108]` Se mandó el día que se CAPTURÓ en Kepler; la fecha del documento sólo se muestra.
      const enviado = diaMxDe(v.capturado ?? v.fecha) || null;
      const documento = diaMxDe(v.fecha) || null;
      return { ...base, situacion: situacionDe(base), enviado, dias: diasDesde(enviado),
        fechaDocumentoDistinta: documento && documento !== enviado ? documento : null, segmentos: [], resumenRuta: '' };
    }),
    ...this.filas().map((p): FilaLista => {
      const base = {
        key: `p:${p.id}`, folio: p.folio_solicitud, sucursal: p.sucursal, fecha: p.fecha_gasto, importe: Number(p.importe) || 0,
        titulo: p.proveedor, detalle: p.clasificacion ? this.tipoGasto(p.clasificacion) : null,
        etapa: (p.etapa ?? null) as EtapaLista | null, status: p.status, motivo_rechazo: p.motivo_rechazo,
        debeFactura: p.provisional === true,
        // `[GX.55]` Aprobado = le falta algo por subir. Es el estado que la captura abre en modo
        // evidencia; ofrecer el botón en cualquier otro llevaría a una pantalla cerrada.
        puedeSubir: p.status === 'aprobada',
        proveedor_clave: p.proveedor_clave ?? null, gasto_folios: p.gasto_folios ?? [],
        // `[GX.75]` Ausente (servidor viejo) = no medido: ni «pagado» ni «sin pago».
        notaPago: notaDePago((p.transferencias ?? null) as TransferenciaGasto[] | null, Number(p.importe) || 0),
        proof: p,
        fechaDocumentoDistinta: null,
        // G.16b: la misma regla que ofrece «Ya lo comparé · Generar»: el texto nunca promete un botón que no está.
        lecturaDistinta: pideComparar(p.gasto_kepler),
      };
      const enviado = diaMxDe(p.created_at) || null;
      // G-RED.2: el gasto que trajo la fila (`undefined` = el servidor no lo mandó → «sin leer», nunca «hecho»).
      const ruta = rutaDelVale(p as unknown as ValeGasto, null, p.gasto_kepler);
      return { ...base, situacion: situacionDe(base), enviado, dias: diasDesde(enviado),
        segmentos: segmentosDeLaRuta(ruta), resumenRuta: resumenDeLaRuta(ruta) };
    }),
  ]);

  /** Cuántos hay de cada lado. Un estado desconocido no cae en ninguno (se cuenta aparte). */
  readonly conteos = computed<Record<AQuien, number>>(() => {
    const c: Record<AQuien, number> = { tu: 0, finanzas: 0, kepler: 0, cerrado: 0 };
    for (const f of this.unificadas()) if (f.situacion) c[f.situacion.aQuien]++;
    return c;
  });
  readonly fueraDeColumnas = computed(() => this.unificadas().filter((f) => !f.situacion).length);
  readonly teTocan = computed(() => this.conteos().tu);

  /** Dinero de lo que todavía no cerró: te toca + espera a Finanzas + espera a Kepler. */
  readonly sinCerrar = computed(() => this.unificadas()
    .filter((f) => f.situacion && f.situacion.aQuien !== 'cerrado')
    .reduce((s, f) => s + (Number(f.importe) || 0), 0));

  /**
   * `[GX.97]` El filtro que se ve: el elegido, o el primero con algo (un clic que la persona da
   * SIEMPRE es un defecto del default — diseno §0b-3).
   */
  readonly filtro = computed<AQuien>(() => {
    const e = this.elegido();
    if (e) return e;
    const c = this.conteos();
    return FILTROS.find((x) => c[x.value] > 0)?.value ?? 'tu';
  });

  readonly opciones = computed<SegOption[]>(() => {
    const c = this.conteos();
    return FILTROS.map((x) => ({ label: x.label, value: x.value, count: c[x.value] }));
  });

  readonly textoVacio = computed(() => FILTROS.find((x) => x.value === this.filtro())?.vacio ?? '');
  /** `[PGP.122.9]` El nombre del filtro elegido, para el caption de la tabla («Tus vales: Te toca»). */
  readonly nombreDelFiltro = computed(() => FILTROS.find((x) => x.value === this.filtro())?.label ?? '');
  /** El encabezado de la columna de la situación: el mismo texto es el rótulo de la celda cuando la tabla se apila. */
  readonly encabezadoSituacion = computed(() => (this.filtro() === 'cerrado' ? 'Cómo cerró' : this.filtro() === 'tu' ? 'Qué te falta' : 'A qué espera'));

  /**
   * Las filas del filtro. Lo abierto, del más viejo al más nuevo: lo que más urge arriba. Lo
   * cerrado, al revés: lo último que cerró es lo que se viene a confirmar. `[GX.106]` Por la fecha
   * en que se mandó, que es la que se ve: ordenar por otra la haría parecer revuelta.
   */
  readonly visibles = computed<FilaLista[]>(() => {
    const f = this.filtro();
    const filas = this.unificadas().filter((x) => x.situacion?.aQuien === f);
    const porFecha = (a: FilaLista, b: FilaLista) => String(a.enviado ?? '').localeCompare(String(b.enviado ?? ''));
    return f === 'cerrado' ? [...filas].sort((a, b) => porFecha(b, a)) : [...filas].sort(porFecha);
  });

  /** `[GX.95]` Lo que el servidor recortó, dicho en palabras. */
  readonly cortes = computed<string[]>(() => {
    const r = this.reporte();
    if (!r) return [];
    const t: string[] = [];
    if (r.abiertos_truncados) t.push('Tienes más vales abiertos de los que caben en la lista. Avisa a Sistemas.');
    if (r.cerrados_truncados) {
      const total = r.kpis?.validadas;
      t.push(`Se muestran tus vales revisados más recientes${total ? ` (hay ${total} en total)` : ''}. Para uno más viejo, búscalo por su folio.`);
    }
    if (r.asignados_truncados) t.push('Kepler te asignó más solicitudes de las que caben: se muestran las más nuevas.');
    return t;
  });

  constructor() {
    this.cargar();
    // `[GX.88]` El vale elegido en el buscador de arriba se abre AQUÍ.
    this.busqueda?.aperturas$.pipe(takeUntilDestroyed()).subscribe((v) => this.abierto.set(v));
    // `[GX.73]` Se refresca sola mientras la pestaña se ve: el estado del vale cambia afuera de
    // esta pantalla (lo aprueban en la Suite, lo autoriza Kepler) y antes sólo se veía al recargar.
    encuestarVisible(REFRESCO_VALES_MS, () => this.refrescar());
    this.destroyRef.onDestroy(() => { if (this.espera) clearTimeout(this.espera); });
  }

  elegir(v: string): void {
    if (FILTROS.some((x) => x.value === v)) this.elegido.set(v as AQuien);
  }

  /** `[GX.97]` Busca solo al dejar de escribir; Enter busca ya. */
  escribir(texto: string): void {
    this.q.set(texto);
    if (this.espera) clearTimeout(this.espera);
    this.espera = setTimeout(() => { this.espera = null; this.cargar(); }, 400);
  }
  buscarYa(): void {
    if (this.espera) { clearTimeout(this.espera); this.espera = null; }
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.svc.mine(200, this.q() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.aplicar(r); this.cargando.set(false); this.cargadaUnaVez.set(true); this.abrirDelEnlace(); },
      // Un error NO se pinta como «no levantaste nada»: es otra afirmación, y la equivocada
      // manda a alguien a capturar de nuevo un gasto que ya mandó.
      error: () => { this.error.set('Revisa tu conexión y vuelve a intentar.'); this.cargando.set(false); },
    });
  }

  /** Hay un refresco en vuelo: el siguiente no se encima. */
  private refrescando = false;

  /**
   * `[GX.73]` **El refresco en segundo plano.** No es `cargar()`: no muestra el aviso de carga
   * y un fallo NO pisa la lista buena con un error — la que está en pantalla sigue siendo la
   * última cierta. `[GX.97]` Pero el fallo se DICE: la lista ya no es de ahora.
   *
   * ⛔ No corre con un vale abierto: cambiarle la fila debajo a quien la está leyendo la movería
   * de lista sin aviso. Se pone al día en la vuelta siguiente, ya cerrado.
   */
  refrescar(): void {
    if (this.abierto() || this.cargando() || this.refrescando) return;
    this.refrescando = true;
    this.svc.mine(200, this.q() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.aplicar(r); this.refrescando = false; },
      error: () => {
        this.refrescando = false;
        this.refrescoFallo.set(new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }));
      },
    });
  }

  private aplicar(r: ExpenseProofsReport): void {
    this.filas.set(r.rows ?? []);
    // G-RED.1b: el vale abierto se re-apunta a su fila nueva, para que el panel diga lo que acaba de pasar (p. ej. el gasto
    // recién generado). El refresco de fondo no corre con un vale abierto (GX.73); esto sólo lo alcanza `cargar()`.
    const a = this.abierto();
    if (a) { const n = (r.rows ?? []).find((x) => x.id === a.id); if (n) this.abierto.set(n as ValeGasto); }
    this.asignados.set(r.asignados ?? []);
    this.reporte.set(r);
    this.ultimaCarga.set(new Date());
    this.refrescoFallo.set(null);
  }

  /**
   * `[GX.91]` La captura manda aquí con `?vale=<id>` cuando el folio ya tenía un vale tuyo. Se abre
   * una vez, y sólo si está en la lista (es tuyo: lo trajo `/mine`).
   */
  private enlaceAbierto = false;
  private abrirDelEnlace(): void {
    if (this.enlaceAbierto) return;
    const id = this.route?.snapshot?.queryParamMap?.get('vale');
    if (!id) return;
    this.enlaceAbierto = true;
    const p = this.filas().find((x) => x.id === id);
    if (p) this.abrir(p);
  }

  abrir(p: ExpenseProof): void { this.abierto.set(p as ValeGasto); }

  /**
   * `[PGP.123]` G.14 — «Generar gasto»: escribe en Kepler el gasto (X-A-10) del vale que pidió esta persona (D1) y dice
   * cómo quedó; nada lo escribe solo (D2). Un clic, sin confirmación: el botón lleva la cifra y se apaga mientras escribe.
   */
  /** G-AUD.14 — Confirmado: escribe OTRO gasto. Si lo único que frena es la lectura del comprobante, cuenta como comparado. */
  generarOtraVez(p: ExpenseProof): void {
    this.confirmarOtraVez.set(null);
    const c = p.gasto_kepler?.comprobacion;
    this.generarGasto(p, !!c && !c.listo && c.motivo === 'lectura_distinta');
  }

  /**
   * G-RED.1b (H2 de la auditoría) — El panel ya ofrecía «Generar gasto» / «Generar otra vez» (con su segundo clic), pero
   * Mis gastos no se lo encendía: el texto decía «si fue un error, “Generar otra vez”» y el botón sólo estaba en la fila.
   * Se le pasa el gasto que ya trae la fila (no se vuelve a pedir) y el mismo camino que la fila.
   */
  readonly gastoDelAbierto = computed(() => (this.abierto() as ExpenseProof | null)?.gasto_kepler);

  generarDesdePanel(id: string): void {
    const p = this.filas().find((x) => x.id === id);
    if (!p) return;
    if (pideGenerarOtraVez(p.gasto_kepler)) this.generarOtraVez(p); else this.generarGasto(p);
  }

  generarGasto(p: ExpenseProof, lecturaComparada = false): void {
    if (this.generando()) return;
    this.generando.set(p.id);
    this.avisoGasto.set(null);
    this.svc.reintentarGasto(p.id, lecturaComparada).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (e) => {
        this.generando.set(null);
        const ok = !!e?.folio && (e.status === 'written' || e.status === 'seen_in_ods');
        this.avisoGasto.set(ok
          ? { texto: `Gasto generado en Kepler: X-A-10 ${e!.folio}${e!.poliza ? ' · póliza ' + polizaCorta(e!.poliza) : ''}.`, mal: false }
          : { texto: `Todavía no se genera: ${e?.nota ?? 'la Suite no pudo escribirlo'}.`, mal: true });
        this.cargar();
      },
      error: (err) => {
        this.generando.set(null);
        this.avisoGasto.set({ texto: `No se pudo generar el gasto: ${err?.error?.message ?? 'revisa tu conexión y vuelve a intentar'}.`, mal: true });
      },
    });
  }
  cerrar(abierto: boolean): void { if (!abierto) this.abierto.set(null); }

  /** `[GX.87]` Todo lo de esta lista es tuyo: se ofrece sumar evidencia, salvo en un rechazado. */
  /** `[PGP.123]` G-RED.1 — La ruta del panel ofrece subir el comprobante donde lo ofrece la fila (vale firmado). */
  subirDelAbierto(): { folio: string | null; sucursal: string | null } | null {
    const v = this.abierto();
    return v?.status === 'aprobada' ? { folio: v.folio_solicitud, sucursal: v.sucursal } : null;
  }
  accionesDelVale(): readonly AccionVale[] {
    return aceptaEvidenciaAdicional(this.abierto()?.status) ? ['agregar_evidencia'] : [];
  }
  cerrarEvidencia(abierto: boolean): void { if (!abierto) this.paraEvidencia.set(null); }

  /**
   * `[GX.87]` Lo agregado se ve YA: el servidor devuelve el expediente completo y firmado, y se
   * pone en el visor y en la fila.
   */
  alAgregarEvidencia(e: EvidenciaAgregada): void {
    this.abierto.update((v) => (v && v.id === e.id ? { ...v, files: e.files } : v));
    this.filas.update((l) => l.map((p) => (p.id === e.id ? { ...p, files: e.files } : p)));
    this.busqueda?.conArchivos(e.id, e.files);
  }

  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  /** `[GX.106]` «hace N días», sólo para lo atorado: lo demás se lee en la fecha. */
  hace(f: FilaLista): string { return textoAntiguedad(f.dias); }
  /** Lo cerrado no está atorado (ya no espera nada); lo abierto, desde que se mandó. */
  atorado(f: FilaLista): boolean {
    return f.situacion?.aQuien !== 'cerrado' && f.dias !== null && f.dias > DIAS_ATORADO;
  }

  /**
   * `[PGP.123]` G.15 — El folio de la COMPROBACIÓN de la fila (el gasto X-A-10): los que ya ve Kepler (`gasto_folios`)
   * y, mientras el ODS todavía no lo ve, el que acaba de generar la Suite (G.14). Antes era «XA1001-…» debajo de «Cómo
   * cerró» y sólo en Cerrados (`[GX.65.3]`): la observación de usuario del 2026-11-21 fue que costaba encontrarlo.
   */
  comprobacionDe(f: FilaLista): string[] {
    const g = f.proof?.gasto_kepler?.gasto;
    const recien = g?.folio && g.status !== 'cancelled' ? [g.folio] : [];
    return [...new Set([...f.gasto_folios, ...recien])];
  }

  /**
   * `[PGP.123]` G.15 — La columna va donde la comprobación existe o es lo que falta (Esperan a Kepler, Cerrados) y en
   * cualquier pestaña que traiga alguna. En «Te toca» y «Esperan a Finanzas» todavía no puede haberla: sería una
   * columna entera de rayas.
   */
  readonly mostrarComprobacion = computed(() => this.filtro() === 'kepler' || this.filtro() === 'cerrado'
    || this.visibles().some((f) => this.comprobacionDe(f).length > 0));

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }
}
