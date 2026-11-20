import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { branchLabel } from '../../../core/constants/store-branches';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  CLASIFICACION_LABEL, ComprobacionesService,
  type ExpenseClasificacion, type ExpedienteAtrasado, type ExpedienteDelDia, type GastosDelDia,
  type ReaperturaPendiente, type RespuestaEsperanKepler, type ValeEsperaKepler, type GrupoAprobacion,
} from '../comprobaciones.service';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { ValeGastoPeekComponent, type AccionVale, type AprobacionVale } from '../components/vale-gasto-peek.component';
import { EvidenciaAdicionalDialogComponent, type EvidenciaAgregada } from '../components/evidencia-adicional-dialog.component';
import { BuscadorGastosEstado } from '../components/buscador-gastos.estado';
import { BuscadorGastosComponent } from '../components/buscador-gastos.component';
import { CierreCanceladaDialogComponent, type CierreHecho, type ModoCierre } from '../components/cierre-cancelada-dialog.component';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { REFIRMAR_MS, REFRESCO_VALES_MS } from '../vales-refresco';
import { parseLocalDate } from '../../../core/utils/mx-date';
// `[GX.65.4a]` La MISMA regla que aplica el servidor, desde el contrato: dos copias se separan.
import { aceptaEvidenciaAdicional, esDuenoDelVale, detallesParaMostrar, ETIQUETA_ESPERA_KEPLER, type EsperaKepler } from '@megadulces/contracts';
// `[PGP.79]` Firmar autoriza en Kepler: la solicitud y su estado se leen con la MISMA regla en el renglón y en el detalle.
import { lecturaKepler, solicitudKepler, type DetalleDeLaSolicitud, type KeplerDelVale, type TonoKepler } from '@megadulces/contracts';
// `[PGP.123]` G.9 — La cola de comprobación: qué le falta a cada gasto autorizado, con las reglas puras de la cola.
import type { ComprobacionEnLaCola } from '@megadulces/contracts';
import { ETIQUETA_FALTA_EN_KEPLER, importeDelVale, lecturaDeLaCancelada } from '@megadulces/contracts';
import { colaDeKepler, esCanceladaEnKepler, lecturaSinEscribir, lineaDelGasto, partirCanceladas, polizaCorta, quienTexto, solicitudSinEscribir } from './esperan-kepler.ayudas';
import { SolicitudGastoService } from '../solicitud-gasto.service';
import { forkJoin } from 'rxjs';
import { AuthService, type JwtPayload } from '../../../core/services/auth.service';

/**
 * `[GX.88]` Las pestañas de ESTA pantalla. La bandeja es lo de hoy; «Atrasados», lo de otro día
 * que sigue abierto. (`PestanaGasto` del servicio sigue siendo la partición del servidor.)
 */
export type PestanaAprobacion = 'entrada' | 'atrasados' | 'kepler' | 'canceladas';

const FORMA_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia',
  cheque: 'Cheque', vales: 'Vales', otro: 'Otro',
};

/** Cómo se llama cada estado en voz alta. La clave cruda es cómo se guarda, no cómo se dice. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma',
  aprobada: 'Aprobado · falta ejercer',
  revision: 'Falta revisarla',
  validada: 'Comprobado',
  rechazada: 'Rechazado',
};

/**
 * `[GX.20]` — **Aprobación de gastos.** La cola de lo que espera firma.
 *
 * `[GX.67]` La pantalla de GX.17 era una bandeja: «todo lo que espera firma, de cualquier
 * fecha». GX.20 la acotó **al día**, y eso resultó ser el defecto: volvió a ser la cola.
 *
 * El corte es **la decisión**, no el avance del trámite:
 *
 * | Pestaña | Estados | Qué es |
 * |---|---|---|
 * | **Bandeja de entrada** | `recibida` | Llegó y nadie decidió todavía. |
 * | **Aprobados** | `aprobada`, `revision`, `validada` | Se dijo que sí. |
 * | **Rechazados** | `rechazada` | Se dijo que no, con su motivo. |
 *
 * Las tres **particionan el día**: cada expediente se ve en una y sólo una. El reparto lo
 * hace el servidor (`etapas-del-dia.ts`, función pura con sus pruebas), no esta pantalla.
 *
 * ⚠️ Los tres estados de *Aprobados* son el mismo hecho en tres momentos del cierre: falta
 * ejercerlo, volvió con evidencia que no cuadró, o ya cerró. **El renglón dice en cuál está
 * y qué botón ofrece**; la pestaña dice que la decisión fue que sí. Separarlos en pestañas
 * distintas partiría en tres una sola respuesta.
 *
 * ⛔ `sin_etapa` —un estado que el servidor no reconoce— entra por la **bandeja de entrada**,
 * que es la que significa «alguien tiene que mirar esto», y sale marcado. Sin eso no saldría
 * en ninguna de las tres, o sea que el expediente no existiría en la aplicación.
 *
 * ## ⛔ `[GX.67]` LA BANDEJA NO SE ACOTA POR DÍA
 * Pedido del usuario (2026-10-05): *«sólo se pueden autorizar los que se levanten del día,
 * cambialo a que también se puedan pasado»*.
 *
 * Hasta acá la pantalla mostraba **sólo hoy** y se limitaba a *avisar* cuántos expedientes
 * habían quedado afuera — sin ninguna forma de llegar a ellos, porque la barra de días se
 * había retirado el 2026-09-25 (a pedido del mismo usuario). **Medido en la base local el
 * 2026-10-05: 78 expedientes esperando firma repartidos en ~25 días, el más viejo del 1-jul,
 * y CERO levantados hoy** — o sea la bandeja salía vacía mientras esos 78 esperaban.
 *
 * ⛔ El arreglo **no es devolver la barra que el usuario quitó**. Con pendientes en ~25 días
 * distintos, una barra obliga a adivinar en cuál hay trabajo, que es justo lo que la hacía
 * molesta. Lo correcto es que la bandeja **deje de ser un reporte del día y vuelva a ser una
 * cola**: se ve todo lo que espera decisión, de cualquier fecha, y cada renglón trae su día
 * de captura.
 *
 * ⚠️ El día **no desapareció del endpoint**: `delDia(fecha)` sigue acotando lo ya decidido,
 * que es un registro y no una cola. Lo que dejó de acotar es la bandeja.
 *
 * ⚠️ Autorizar un vale viejo **nunca estuvo prohibido en el servidor**: `approve()` y
 * `reject()` no tienen ninguna guarda de fecha. El candado era de pantalla, y era el único.
 *
 * ## ⚠️ El día es el de CAPTURA
 * «Los levantamientos que se hicieron al día» es cuándo se **levantó** el expediente. El
 * gasto puede ser de la semana pasada: cada renglón muestra las dos fechas, justo porque no
 * siempre coinciden.
 *
 * ## ⛔ Aprobar sigue siendo de a uno
 * No hay «aprobar el grupo entero». Agrupar y filtrar es para **leer**, no para firmar en
 * bloque: un botón que autoriza 40 gastos de un clic convierte la revisión en un trámite.
 *
 * ## ⛔ No se firma desde la lista: se firma mirando el vale
 * El renglón **no trae botones**. Se abre, se ve el expediente completo —sus papeles
 * incluidos— y recién ahí se decide. Un «Aprobar» al pie de una tarjeta deja autorizar
 * dinero sin haber abierto el comprobante, que es justo lo que esta pantalla existe para
 * que no pase.
 *
 * ⚠️ El detalle **no vuelve a pedir el expediente**: usa la fila que la lista ya trajo, con
 * sus archivos ya firmados (30 min). Un segundo viaje agregaría una fuente que puede
 * contradecir a la primera, y `GET /:id` pide `FINANCE_EXPENSES_VER` — que quien firma no
 * necesariamente tiene (esta pantalla se gatea con `_COMPROBAR`).
 */
@Component({
  selector: 'app-finanzas-aprobacion-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TagModule, InputTextModule, ToastModule, ValeGastoPeekComponent, EvidenciaAdicionalDialogComponent, CierreCanceladaDialogComponent, BuscadorGastosComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ap">
      <p-toast />
      <!-- [GX.101] El buscador va junto al título (pedido del usuario: «a uno más visible»). Mientras hay
           búsqueda, lo de abajo del encabezado se cambia por los resultados; el encabezado se queda
           (si no, la caja se iría mientras se escribe). El visor y el diálogo del final NO se
           esconden: son los que abren el vale elegido. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Aprobación de gastos</h1>
          <!-- [GX.105] Sin subtítulo (pedido del usuario, 2026-11-09): decía «en la bandeja, lo de hoy;
               lo de antes, en Atrasados», que es lo que ya dicen los nombres de las listas. -->
        </div>
        <app-buscador-gastos parte="caja" />
                <!-- [GX.100] Actualizar NO quita la lista: la pone al día en su lugar (antes regresaba al inicio). -->
        <button pButton type="button" class="p-button-text" (click)="cargar(true)" [loading]="cargando() || actualizando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>
      @if (buscandoArriba()) {
        <app-buscador-gastos parte="resultados" />
      } @else {

      @if (cargando()) { <div class="ap-muted">Cargando…</div> }
      @else if (error()) { <div class="ap-err">{{ error() }}</div> }
      @else if (datos(); as d) {

        <!-- Un parámetro roto NO se ve igual que un día sin movimiento: se dice. -->
        @if (d.fecha_pedida) {
          <div class="ap-aviso warn">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>«{{ d.fecha_pedida }}» no es una fecha. Se está mostrando hoy.</span>
          </div>
        }

        <!-- [GX.29] **Lo que te piden reabrir.** Va ARRIBA de las pestañas y fuera de
             ellas a propósito: las tres particionan EL DÍA, y esto es de cualquier fecha
             y de una sola persona — la que firmó ese vale. Meterlo de cuarta pestaña
             rompería que los tres contadores sumen el día completo.

             ⚠️ Se pinta sólo si hay algo. Un panel vacío permanente enseña a saltearlo,
             y el día que traiga algo nadie lo va a mirar. -->
        @if (reaperturas().length) {
          <section class="ap-reap">
            <div class="ap-reap-t">
              <i class="pi pi-lock-open" aria-hidden="true"></i>
              <strong>Te piden reabrir {{ reaperturas().length === 1 ? 'un vale' : reaperturas().length + ' vales' }}</strong>
              <span class="ap-faint">tú los aprobaste, así que la decisión es tuya</span>
            </div>
            @for (r of reaperturas(); track r.id) {
              <article class="ap-reap-it">
                <div class="ap-reap-head">
                  <span class="ap-folio">{{ r.folio_solicitud || 'sin folio' }}</span>
                  <span class="ap-faint">lo pide {{ r.solicita || '—' }}</span>
                  <span class="ap-grow"></span>
                  <span class="ap-imp">{{ money(r.importe) }}</span>
                </div>
                <div class="ap-it-nota">“{{ r.motivo || 'sin motivo' }}”</div>
                <div class="ap-reap-act">
                  <button pButton type="button" class="p-button-text" [disabled]="actuando() !== null"
                          (click)="decidirReapertura(r, false)">No reabrir</button>
                  <button pButton type="button" class="p-button-outlined" [loading]="actuando() === r.id"
                          (click)="decidirReapertura(r, true)">Reabrir</button>
                </div>
              </article>
            }
          </section>
        }

        <!-- [GX.60] UNA pestana: lo decidido se va al Expediente, no a la de al lado. -->
        <!-- [GX.105] Las tres listas en una lista desplegable (pedido del usuario, 2026-11-09). Cerrada
             dice cuál se ve, con su número y su monto; abierta, las tres. Al entrar es siempre la
             bandeja de hoy. -->
        <div class="ap-listas">
          <p-select class="ap-cual" [options]="tabs" optionValue="id" optionLabel="label"
                    [ngModel]="pestana()" (ngModelChange)="verPestana($event)"
                    appendTo="body" ariaLabel="Qué lista ver">
            <ng-template #selectedItem let-t>@if (t) {<ng-container *ngTemplateOutlet="opcionLista; context: { $implicit: t }" />}</ng-template>
            <ng-template #item let-t><ng-container *ngTemplateOutlet="opcionLista; context: { $implicit: t }" /></ng-template>
          </p-select>
        </div>
        <!-- [GX.105] Una lista como se ve cerrada y abierta: nombre, número y monto. -->
        <ng-template #opcionLista let-t>
          <span class="ap-op">
            <span class="ap-op-t">{{ t.label }}</span>
            @if ((t.id === 'kepler' || t.id === 'canceladas') && !keplerMedido()) {
              <span class="ap-op-n vacio">—</span>
              <span class="ap-op-m">{{ keplerError() || esperanKepler() ? 'sin medir' : 'cargando' }}</span>
            } @else if (t.id === 'atrasados' && !atrasadosMedidos()) {
              <!-- [GX.88] No se midió ≠ cero: sin datos del servidor, el contador no dice 0. -->
              <span class="ap-op-n vacio">—</span>
              <span class="ap-op-m">sin medir</span>
            } @else if (conteo(t.id).n) {
              <span class="ap-op-n">{{ conteo(t.id).n }}</span>
              <span class="ap-op-m">{{ money(conteo(t.id).monto) }}</span>
            } @else {
              <!-- En cero no se escribe «$0.00»: no dice nada que el 0 no diga. -->
              <span class="ap-op-n vacio">0</span>
            }
          </span>
        </ng-template>

        <!-- [GX.88] Qué es esta lista, dicho: del más viejo al más nuevo, y de quién depende. -->
        <!-- [GX.88] ⛔ Si el servidor no mandó los atrasados (una API sin actualizar), se DICE: pintar
             «no se quedó nada atrasado» sería afirmar lo que no se midió. -->
        @if (pestana() === 'atrasados' && !atrasadosMedidos()) {
          <div class="ap-aviso warn">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>El servidor no mandó los atrasados, así que <strong>no se puede saber si hay</strong>.
              Probablemente falta actualizar la API; avisa a sistemas.</span>
          </div>
        }
        @if (pestana() === 'atrasados' && conteo('atrasados').n) {
          <div class="ap-aviso">
            <i class="pi pi-clock" aria-hidden="true"></i>
            <!-- [GX.109] También lo de hoy que ya se aprobó y espera algo más: no espera firma, así que
                 no va en la bandeja, y antes no salía en ningún lado hasta mañana. -->
            <span>Vales que siguen abiertos, <strong>del más viejo al más nuevo</strong>: los de días anteriores
              y los de hoy que ya se aprobaron.
              Cada uno dice qué le falta y si te toca a ti o a quien lo levantó.</span>
          </div>
        }

        <!-- ⛔ Una lista cortada en silencio se lee igual que una lista completa. -->
        @if (pestana() === 'entrada' && d.entrada_truncada) {
          <div class="ap-aviso warn">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>La lista de hoy llegó al tope y <strong>hay más esperando firma</strong>. Firma los de
              acá y vuelve a actualizar.</span>
          </div>
        }
        @if (pestana() === 'atrasados' && d.atrasados_truncada) {
          <div class="ap-aviso warn">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>Se muestran {{ d.atrasados?.length ?? 0 }} de <strong>{{ conteo('atrasados').n }}</strong> atrasados
              (los más viejos primero). Resuelve éstos y vuelve a actualizar.</span>
          </div>
        }

        <!-- [GX.67] El vacío se mide con la BANDEJA, no con «total» — que incluye lo
             ya decidido del día y haría decir «no hay nada» con la lista llena, o al revés:
             «hay gastos» sobre una bandeja vacía. -->
        <!-- [GX.96] La cola de Kepler: lo raro primero (hallazgos), después lo que más lleva esperando. -->
        @if (pestana() === 'kepler') {
          @if (!keplerMedido()) {
            @if (keplerError() || esperanKepler()) {
              <div class="ap-aviso warn">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>No se pudo leer el estado de Kepler, así que <strong>no se puede saber qué espera</strong>. Vuelve a actualizar.</span>
              </div>
            } @else {
              <div class="ap-muted">Cargando lo que espera a Kepler…</div>
            }
          } @else {
            <!-- [PGP.123] G.UI.3: la cola de comprobación. La pregunta: «¿qué le falta a cada gasto autorizado para quedar
                 comprobado en Kepler?». Primero lo que se comprueba —lo que necesita a una persona, por quién lo mueve, y
                 lo que escribe la Suite—; lo que espera otra cosa, plegado con su conteo. Cada vale cae en UNA sección:
                 las secciones suman lo que dice la pestaña. -->
            @if (!conteo('kepler').n) {
              <div class="ap-muted">{{ vacioDe('kepler') }}</div>
            } @else {
              @let q = cola();
              <!-- [PGP.122] La solicitud nacida en la Suite que Kepler todavía no tiene (la rechazó, se atoró o se escribe):
                   primero y a la vista, cada renglón con lo que dijo Kepler y abrible para «Reintentar en Kepler». -->
              @if (q.sinEscribir.length) {
                <section class="ap-kep-sec" aria-labelledby="kep-sin-escribir">
                  <h3 class="ap-kep-h" id="kep-sin-escribir">Su solicitud todavía no está en Kepler
                    <span class="ap-kep-n">{{ q.sinEscribir.length | number }} · {{ money(montoDe(q.sinEscribir)) }}</span></h3>
                  <div class="ap-kep-lista">
                    @for (v of q.sinEscribir; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v }" /> }
                  </div>
                </section>
              }
              <div class="ap-kep-cab">
                @if (q.porComprobar.length) {
                  <h2 class="ap-kep-tot">{{ q.porComprobar.length | number }} por comprobar · {{ money(montoDe(q.porComprobar)) }}</h2>
                  <span class="ap-kep-rep">la Suite las escribe: {{ q.laSuite.length | number }} · con motivo: {{ conMotivoN() | number }}@if (sinCalcularN()) { · sin calcular: {{ sinCalcularN() | number }}}</span>
                } @else {
                  <h2 class="ap-kep-tot">Ningún gasto autorizado espera su comprobación</h2>
                }
              </div>
              @for (g of q.conMotivo; track g.clave) {
                <section class="ap-kep-sec" [attr.aria-labelledby]="'kep-' + g.clave">
                  <h3 class="ap-kep-h" [id]="'kep-' + g.clave">{{ g.titulo }}
                    <span class="ap-kep-n">{{ g.vales.length | number }} · {{ money(montoDe(g.vales)) }}</span></h3>
                  <div class="ap-kep-lista">
                    @for (v of g.vales; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v }" /> }
                  </div>
                </section>
              }
              @if (q.laSuite.length) {
                <section class="ap-kep-sec" aria-labelledby="kep-la-suite">
                  <h3 class="ap-kep-h" id="kep-la-suite">La Suite las escribe
                    <span class="ap-kep-n">{{ q.laSuite.length | number }} · {{ money(montoDe(q.laSuite)) }}</span></h3>
                  <div class="ap-kep-lista">
                    @for (v of q.laSuite; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v }" /> }
                  </div>
                </section>
              }
              <!-- Lo que espera otra cosa: a un clic, con su conteo, sin empujar la cola. -->
              @if (q.porAutorizar.length) {
                <details class="ap-kep-pleg">
                  <summary>Falta que las autoricen en Kepler
                    <span class="ap-kep-n">{{ q.porAutorizar.length | number }} · {{ money(montoDe(q.porAutorizar)) }}</span></summary>
                  <div class="ap-kep-lista">
                    @for (v of q.porAutorizar; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v }" /> }
                  </div>
                </details>
              }
              <!-- [PGP.123] G.UI.1c: las canceladas ya no se pliegan aquí: no esperan nada de Kepler. Tienen su lista. -->
              @if (q.aplicadaSinLigar.length) {
                <details class="ap-kep-pleg">
                  <summary>Kepler dice aplicada, pero el gasto no aparece
                    <span class="ap-kep-n">{{ q.aplicadaSinLigar.length | number }} · {{ money(montoDe(q.aplicadaSinLigar)) }}</span></summary>
                  <div class="ap-kep-lista">
                    @for (v of q.aplicadaSinLigar; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v }" /> }
                  </div>
                </details>
              }
              @if (q.sinMedir.length) {
                <details class="ap-kep-pleg">
                  <summary>No se pudo leer su estado en Kepler
                    <span class="ap-kep-n">{{ q.sinMedir.length | number }} · {{ money(montoDe(q.sinMedir)) }}</span></summary>
                  <div class="ap-kep-lista">
                    @for (v of q.sinMedir; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v }" /> }
                  </div>
                </details>
              }
            }
            @if (esperanKepler()?.truncado) {
              <div class="ap-aviso warn">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>La lista llegó al tope: <strong>hay más</strong> de los que se muestran.</span>
              </div>
            }
          }
        } @else if (pestana() === 'canceladas') {
          <!-- [PGP.123] G.UI.1c — «Canceladas en Kepler» (pedido de Francisco, 2026-11-16). La pregunta: «¿qué vales
               comprobados se quedaron con su solicitud cancelada en Kepler?». Primero las que ya tenían gasto (¿salió
               dinero?), después las que no (¿dónde quedó el gasto?). Antes las primeras iban plegadas en «Esperan a
               Kepler» y las segundas no salían en ninguna lista. -->
          @if (!keplerMedido()) {
            @if (keplerError() || esperanKepler()) {
              <div class="ap-aviso warn">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>No se pudo leer el estado de Kepler, así que <strong>no se puede saber qué se canceló</strong>. Vuelve a actualizar.</span>
              </div>
            } @else {
              <div class="ap-muted">Cargando lo que Kepler canceló…</div>
            }
          } @else if (!conteo('canceladas').n && !canceladas().revisadas.length) {
            <div class="ap-muted">{{ vacioDe('canceladas') }}</div>
          } @else {
            @let cc = canceladas();
            <div class="ap-kep-cab">
              <h2 class="ap-kep-tot">{{ conteo('canceladas').n | number }} canceladas por revisar · {{ money(conteo('canceladas').monto) }}</h2>
              <span class="ap-kep-rep">con su gasto ya generado: {{ cc.conGasto.length | number }} · sin gasto: {{ cc.sinGasto.length | number }}@if (cc.revisadas.length) { · revisadas: {{ cc.revisadas.length | number }}}</span>
            </div>
            @if (cierreDisponible()) {
              <p class="ap-kep-expl">Se comprobaron aquí, pero Kepler canceló su solicitud. Cada una dice lo que la Suite averiguó: ciérrala
                ligándola a su recaptura, rechazando el vale si está repetido, o con «Ya lo revisé» y lo que se hizo.</p>
            } @else {
              <p class="ap-kep-expl">Se comprobaron aquí, pero Kepler canceló su solicitud. Todavía no hay cómo darlas por revisadas:
                siguen en esta lista hasta que se decida qué cierra cada caso.</p>
            }
            @if (cc.conGasto.length) {
              <section class="ap-kep-sec" aria-labelledby="kep-can-gasto">
                <h3 class="ap-kep-h" id="kep-can-gasto"><span class="ap-kep-punto" aria-hidden="true"></span>Con su gasto ya generado: ¿salió dinero?
                  <span class="ap-kep-n">{{ cc.conGasto.length | number }} · {{ money(montoDe(cc.conGasto)) }}</span></h3>
                <div class="ap-kep-lista">
                  @for (v of cc.conGasto; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v, enCanceladas: true }" /> }
                </div>
              </section>
            }
            @if (cc.sinGasto.length) {
              <section class="ap-kep-sec" aria-labelledby="kep-can-sin">
                <h3 class="ap-kep-h" id="kep-can-sin">Sin gasto: ¿se volvió a capturar con otro folio?
                  <span class="ap-kep-n">{{ cc.sinGasto.length | number }} · {{ money(montoDe(cc.sinGasto)) }}</span></h3>
                <div class="ap-kep-lista">
                  @for (v of cc.sinGasto; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v, enCanceladas: true }" /> }
                </div>
              </section>
            }
            <!-- [PGP.123] G.UI.1e: lo ya revisado, plegado, con quién, cuándo y qué. -->
            @if (cc.revisadas.length) {
              <details class="ap-kep-pleg">
                <summary>Revisadas <span class="ap-kep-n">{{ cc.revisadas.length | number }} · {{ money(montoDe(cc.revisadas)) }}</span></summary>
                <div class="ap-kep-lista">
                  @for (v of cc.revisadas; track v.id) { <ng-container *ngTemplateOutlet="filaKepler; context: { $implicit: v, enCanceladas: true }" /> }
                </div>
              </details>
            }
          }
          @if (keplerMedido() && esperanKepler()?.truncado) {
            <div class="ap-aviso warn">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span>La lista de Kepler llegó al tope: <strong>puede haber más</strong> de las que se muestran.</span>
            </div>
          }
        } @else if (!conteo(pestana()).n && !(pestana() === 'atrasados' && !atrasadosMedidos())) {
          <div class="ap-vacio">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            @if (pestana() === 'atrasados') {
              <div><strong>No se quedó nada atrasado.</strong>
                <div class="ap-muted">Todo lo de días anteriores ya se cerró o se rechazó.</div>
              </div>
            } @else {
              <div><strong>Hoy no hay nada esperando tu firma.</strong>
                <div class="ap-muted">En cuanto alguien levante un gasto, aparece acá.</div>
                <!-- [GX.105] En la lista desplegable cerrada sólo se ve la bandeja: los atrasados se
                     ofrecen aquí, con su número y su monto, o quedarían escondidos detrás de un 0. -->
                @if (atrasadosMedidos() && conteo('atrasados').n) {
                  <button pButton type="button" class="p-button-outlined p-button-sm ap-ver-atr" (click)="verPestana('atrasados')">
                    {{ conteo('atrasados').n === 1 ? 'Ver el atrasado' : 'Ver los ' + conteo('atrasados').n + ' atrasados' }} · {{ money(conteo('atrasados').monto) }}
                  </button>
                }
              </div>
            }
          </div>
        } @else {
          <div class="ap-cols">
            <!-- El rail de departamentos sólo aplica a lo que se firma: quien autoriza no
                 revisa renglones sueltos, revisa «lo de Logística». [GX.98] El departamento es el
                 de Kepler (el capturado decía «Sucursal NN»), y va también en Atrasados. Un vale
                 repartido entra en cada uno de sus departamentos con su parte. -->
            @if (gruposVisibles().length > 1) {
              <aside class="ap-grupos">
                <div class="ap-grupos-t">Por departamento</div>
                <button type="button" class="ap-grupo" [class.on]="!grupo()" (click)="grupo.set(null)">
                  <span class="ap-g-t">Todos</span>
                  <span class="ap-g-n">{{ totalSinGrupo() }}</span>
                </button>
                @for (g of gruposVisibles(); track g.clave) {
                  <button type="button" class="ap-grupo" [class.on]="grupo() === g.clave" (click)="grupo.set(g.clave)">
                    <span class="ap-g-t">
                      {{ g.etiqueta }}
                      @if (g.origen === 'solicitud') { <em class="ap-org" title="La etiqueta sale del área de la solicitud de Kepler, no de lo capturado">área</em> }
                      @if (g.origen === 'sin_clasificar' && g.clave !== 'sin-departamento') { <em class="ap-org warn">sin clasificar</em> }
                    </span>
                    <span class="ap-g-m">{{ money(g.monto) }}</span>
                    <span class="ap-g-n">{{ g.n }}</span>
                  </button>
                }
              </aside>
            }

            <section class="ap-lista">
              @for (p of visibles(); track p.id) {
                <ng-container *ngTemplateOutlet="fila; context: { $implicit: p }" />
              }
              @if (!visibles().length) { <div class="ap-muted">{{ vacioDe(pestana()) }}</div> }
            </section>
          </div>
        }
      }

      <!-- [GX.96] El renglón de la cola de Kepler. [PGP.123] G.UI.4: el folio abre el vale en el panel SIN tocar la
           cola (antes la reemplazaba por una búsqueda y se perdía el lugar); al cerrarlo, el foco vuelve aquí.
           G.UI.6: en un autorizado sin gasto, la línea dice qué le falta. G.UI.7: la cancelada lleva un marcador, no el
           renglón en rojo; el folio es un enlace neutro. G.UI.8: las personas, por su nombre. -->
      <ng-template #filaKepler let-v let-enCanceladas="enCanceladas">
        <div class="ap-kep" [class.hallazgo]="v.hallazgo">
          <!-- [PGP.122] Sin folio también se abre (por su id): es justo el vale que hay que reintentar en Kepler. -->
          <button type="button" class="ap-kep-folio" [class.ap-kep-folio-txt]="!v.folio_solicitud" (click)="abrirDesdeCola(v, $event)"
                  [disabled]="abriendoDeCola() === v.id" [attr.aria-label]="etiquetaDeCola(v)">{{ v.folio_solicitud || 'sin folio' }}</button>
          <span class="ap-suc">{{ v.sucursal ? branchLabel(v.sucursal) : '' }}</span>
          <span class="ap-kep-prov">{{ v.proveedor || '—' }}</span>
          <span class="ap-kep-dias" [class.atorado]="(v.dias ?? 0) > 30">{{ diasTexto(v.dias) }}</span>
          <span class="ap-imp">{{ money(importeEnCola(v)) }}</span>
          <div class="ap-kep-que">
            @if (enCanceladas) {
              <!-- [PGP.123] G.UI.1c–1d: en su lista, el título de la sección ya dice qué pasó; el renglón dice lo que la Suite
                   averiguó sola (el dinero y la recaptura) y, abajo, lo de Kepler y quién. -->
              @let pc = pistaDe(v);
              <span class="ap-kep-gasto" [class.warn]="pc.tono === 'warn'" [class.bad]="pc.tono === 'bad'">{{ pc.dinero }}</span>
              @if (pc.recaptura) { · <span class="ap-kep-recap">{{ pc.recaptura }}</span> }
              <div class="ap-kep-pie">@if (notaImporteKepler(v); as nota) { {{ nota }} · }capturó {{ quienTexto(v.capturo_nombre, v.created_by) }} · revisó {{ quienTexto(v.reviso_nombre, v.validated_by) }}</div>
              @if (v.cancelada_revisada; as r) {
                <!-- [PGP.123] G.UI.1e: el caso ya se cerró: quién, cuándo y qué escribió. -->
                <div class="ap-kep-rev"><i class="pi pi-check" aria-hidden="true"></i> Revisó {{ r.por || '—' }} el {{ r.at | date: 'dd/MM/yy' }}: {{ r.nota }}</div>
              } @else if (v.cancelada_revisada === null) {
                <!-- [PGP.123] G.UI.1e: cerrar el caso. Ligar, sólo a la recaptura que propone la pista; rechazar, sólo si está repetido. -->
                <div class="ap-kep-acc">
                  @if (pc.accion?.tipo === 'ligar') {
                    <button pButton type="button" size="small" [outlined]="true" (click)="abrirCierre(v, 'ligar', pc.accion!.folio)">
                      <span class="p-button-label">Ligar a XA1501-{{ pc.accion!.folio }}</span></button>
                  }
                  @if (pc.accion?.tipo === 'repetido') {
                    <button pButton type="button" size="small" [outlined]="true" severity="danger" (click)="abrirCierre(v, 'repetido', pc.accion!.folio)">
                      <span class="p-button-label">Rechazar por repetido</span></button>
                  }
                  <button pButton type="button" size="small" [text]="true" severity="secondary" (click)="abrirCierre(v, 'revisar', null)">
                    <span class="p-button-label">Ya lo revisé</span></button>
                </div>
              }
            } @else {
            @if (solicitudSinEscribir(v)) {
              @let ls = lecturaSinEscribir(v);
              <span class="ap-kep-gasto" [class.warn]="ls.tono === 'warn'" [class.bad]="ls.tono === 'bad'">{{ ls.texto }}</span>
            } @else if (v.hallazgo) {
              {{ textoHallazgo }}
            } @else if (esCanceladaEnKepler(v)) {
              {{ textoCancelada }}
            } @else if (v.espera === 'falta_generar_gasto') {
              @let l = lineaGasto(v);
              <span class="ap-kep-gasto" [class.ok]="l.tono === 'ok'" [class.warn]="l.tono === 'warn'" [class.bad]="l.tono === 'bad'">{{ l.texto }}</span>
            } @else {
              {{ esperaTexto(v.espera) }}
            }
            @if (notaImporteKepler(v); as nota) { · {{ nota }} }
            <span class="ap-kep-quien"> · capturó {{ quienTexto(v.capturo_nombre, v.created_by) }} · revisó {{ quienTexto(v.reviso_nombre, v.validated_by) }}</span>
            }
          </div>
        </div>
      </ng-template>

      <!-- [GX.88] UN renglón para las tres listas (bandeja, Atrasados y búsqueda): tres copias
           del mismo vale se separan a la primera corrección. -->
      <ng-template #fila let-p>
      <article class="ap-item" [class.cerrado]="sinAcciones(p)" [class.abierto]="abierto()?.id === p.id"
               role="button" tabindex="0" [attr.aria-label]="etiquetaDelVale(p)"
               (click)="abrir(p)" (keydown.enter)="abrir(p)" (keydown.space)="abrir(p); $event.preventDefault()">
        <div class="ap-it-head">
          <!-- [PGP.79] El folio como lo busca quien abre Kepler: XA1501-<folio>. -->
          <span class="ap-folio">{{ solicitudKepler(p.folio_solicitud) || 'sin folio' }}</span>
          @if (p.sucursal) { <span class="ap-suc">{{ branchLabel(p.sucursal) }}</span> }
          <!-- [GX.67] El DÍA de captura cuando no es hoy. Sin esto, un vale de
               julio y uno de hace diez minutos se ven igual en la misma lista. -->
          @if (p.created_at && p.created_at !== hoy()) {
            <span class="ap-dia-chip" [title]="'Se levantó el ' + p.created_at">
              {{ diaLocal(p.created_at) | date: 'dd/MM/yy' }}
            </span>
          }
          <span class="ap-hora">{{ p.created_hora }}</span>
          <span class="ap-grow"></span>
          <!-- [GX.98] Con un departamento elegido, el vale repartido dice SU parte y de cuánto. -->
          @if (parteEnGrupo(p); as parte) {
            <span class="ap-imp">{{ money(parte) }} <span class="ap-imp-de">de {{ money(p.importe) }}</span></span>
          } @else {
            <span class="ap-imp">{{ money(p.importe) }}</span>
          }
        </div>

        <!-- [GX.88] El atrasado dice cuánto lleva, qué le falta y DE QUIÉN depende: un atrasado
             que no dice a quién le toca se queda atrasado. -->
        @if (p.falta) {
          <div class="ap-atraso" [class.toca]="p.falta.toca === 'aprueba'">
            <span class="ap-atraso-d">{{ diasTexto(p.dias_atraso) }}</span>
            <span class="ap-atraso-t">{{ p.falta.texto }}</span>
            <span class="ap-chip" [class.warn]="p.falta.toca === 'aprueba'">
              {{ p.falta.toca === 'aprueba' ? 'te toca' : 'espera a quien lo levantó' }}
            </span>
          </div>
        }

        <div class="ap-it-con">{{ p.concepto || p.proveedor || '—' }}</div>

        <div class="ap-it-meta">
          <!-- [GX.98] El departamento de Kepler. «p.departamento» decía «Sucursal NN» en todos. -->
          <span [attr.title]="departamentosTitulo(p)">{{ departamentosTexto(p) }}</span>
          <span>·</span>
          <span>levantado por {{ p.created_by || '—' }}</span>
          @if (p.fecha_gasto && p.fecha_gasto !== p.created_at) {
            <span>·</span>
            <!-- Las dos fechas, porque no son la misma cosa y a veces no coinciden. -->
            <span class="ap-faint">gasto del {{ diaLocal(p.fecha_gasto) | date: 'dd/MM/yy' }}</span>
          }
        </div>

        <div class="ap-it-chips">
          <span class="ap-chip" [class.ok]="p.status === 'validada'"
                [class.warn]="p.status === 'revision'" [class.bad]="p.status === 'rechazada'">
            {{ estado(p.status) }}
          </span>
          <!-- [PGP.79] Dónde está la solicitud en Kepler. La frase lo dice; el color sólo acompaña. -->
          @if (keplerDe(p); as k) {
            <span class="ap-chip" [class.ok]="k.tono === 'ok'" [class.warn]="k.tono === 'warn'" [class.bad]="k.tono === 'bad'">
              {{ k.texto }}
            </span>
          }
          @if (p.etapa === 'sin_etapa') {
            <!-- Un estado que el servidor no reconoce se DECLARA, no se archiva. -->
            <span class="ap-chip bad" title="El servidor no reconoce este estado">estado desconocido</span>
          }
          @if (p.forma_pago) {
            <span class="ap-chip ok">{{ formaPago(p.forma_pago) }}@if (p.forma_pago_detalle) { · {{ detallePago(p.forma_pago_detalle) }} }</span>
          } @else {
            <span class="ap-chip bad">sin forma de pago</span>
          }
          @if (p.evidencia_en_vivo) { <span class="ap-chip ok">foto en vivo</span> }
          @else { <span class="ap-chip warn">foto sin sello de cámara</span> }
          @if (p.clasificacion) { <span class="ap-chip">{{ tipoGasto(p.clasificacion) }}</span> }
          @if (p.status === 'aprobada' && p.requiere_evidencia && !p.tiene_evidencia) {
            <span class="ap-chip warn">falta la evidencia</span>
          }
        </div>

        @if (p.comentarios) { <div class="ap-it-nota">“{{ p.comentarios }}”</div> }
        @if (p.revision_nota) { <div class="ap-it-nota warn">{{ p.revision_nota }}</div> }
        @if (p.motivo_rechazo) { <div class="ap-it-nota bad">Rechazado: {{ p.motivo_rechazo }}</div> }
        @if (p.validated_by) { <div class="ap-it-nota faint">Cerrado por {{ p.validated_by }}</div> }
        <!-- [GX.65.4a] Sin esto, el vale propio abriria sin botones y pareceria un fallo. -->
        @if (esMio(p)) { <div class="ap-it-nota faint">Es tuyo: lo revisa otra persona.</div> }

        <div class="ap-it-pie">
          @if (p.files.length) {
            <span class="ap-faint">{{ p.files.length }} {{ p.files.length === 1 ? 'archivo' : 'archivos' }}</span>
          } @else {
            <span class="ap-chip bad">sin archivos</span>
          }
          <span class="ap-grow"></span>
          <span class="ap-abrir">{{ accionesDe(p).length ? 'Abrir y decidir' : 'Ver el vale' }}
            <i class="pi pi-angle-right" aria-hidden="true"></i></span>
        </div>
      </article>
      </ng-template>

      }

      <!-- El vale completo vive en un componente compartido: el Historial usa el mismo.
           Dos visores serian dos lugares donde arreglar el mismo error. -->
      <app-vale-gasto-peek [open]="peekAbierto()" (openChange)="cerrarSiHaceFalta($event)"
                           [vale]="abierto()" [kepler]="keplerDelAbierto()" [acciones]="accionesDelVisor(abierto())"
                           [solicitudSuite]="detalleDelAbierto()" [puedeReintentar]="true" [cancelaSucursales]="cancelaSucursales()" (reintentarKepler)="reintentarKepler($event)" (cancelarKepler)="cancelarKepler($event)"
                           [gastoKepler]="gastoDelAbierto()" [puedeReintentarGasto]="true" (reintentarGasto)="reintentarGasto($event)"
                           [ocupado]="actuando() !== null"
                           (aprobar)="aprobar($any($event))" (comprobar)="darPorComprobado($any($event))"
                           (rechazar)="rechazar($any($event))"
                           (agregarEvidencia)="paraEvidencia.set($any($event))" />
      <!-- [PGP.123] G.UI.1e — Cerrar el caso de una cancelada. -->
      <app-cierre-cancelada-dialog [open]="cierre() !== null" (openChange)="$event || cierre.set(null)"
                                   [vale]="cierre()?.vale ?? null" [modo]="cierre()?.modo ?? 'revisar'" [folio]="cierre()?.folio ?? null"
                                   (hecho)="alCerrarCancelada($event)" />
      <app-evidencia-adicional-dialog [open]="paraEvidencia() !== null" (openChange)="cerrarEvidencia($event)"
                                      [vale]="paraEvidencia()" (agregado)="alAgregarEvidencia($event)" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    /* [GX.61] LETRA MAS GRANDE en comprobacion de gastos (pedido del usuario, 2026-10-01).

       Se sube la ESCALA, no 20 declaraciones sueltas: cada token baja un escalon, asi que
       toda la pantalla crece junta y la jerarquia se conserva. Editar los tamanos uno por
       uno habria dejado la mitad chica y la otra grande, y nadie lo habria notado hasta
       verlo impreso.

       Es una desviacion deliberada de la densidad compact++ de Operations (DESIGN.md), y
       alcanza SOLO a esta pantalla: aca se decide si sale dinero, y leer mal un importe
       cuesta mas que un renglon de mas. Revertirlo es borrar este bloque. */
    .ap {
      --fs-nano:  0.6875rem;  /* 10 -> 11 */
      --fs-micro: 0.75rem;    /* 11 -> 12 */
      --fs-xs:    0.8125rem;  /* 12 -> 13 */
      --fs-sm:    0.875rem;   /* 13 -> 14 */
      --fs-body:  0.9375rem;  /* 14 -> 15 */
    }
    .ap { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ap-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-3); }
    .ap-faint { font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-grow { flex-grow: 1; }
    .ap-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }

    .ap-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ap-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    .ap-aviso { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm);
      color: var(--fg-2); background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .ap-aviso.warn { color: var(--warn-soft-fg); border-color: var(--warn-border); }
    .ap-imp-de { font-size: var(--fs-xs); font-weight: var(--fw-normal, 400); color: var(--fg-3); }
    /* [GX.96] La cola de Kepler: un renglón por vale, el folio busca el vale arriba. */
    .ap-kep-lista { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ap-kep { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; align-items: baseline;
      gap: var(--sp-1) var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); }
    /* [PGP.123] G.UI.7: el folio es un enlace NEUTRO (el color de acción tiene un solo papel, el botón principal). */
    .ap-kep-folio { border: 0; background: transparent; padding: 0; font-family: var(--font-mono); font-weight: var(--fw-bold);
      color: var(--fg-1); cursor: pointer; text-decoration: underline; text-decoration-color: var(--fg-3); text-underline-offset: 2px; }
    .ap-kep-folio:hover { text-decoration-color: currentColor; }
    .ap-kep-folio:disabled { cursor: progress; color: var(--fg-2); }
    .ap-kep-folio:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ap-kep-folio-txt { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .ap-kep-prov { font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ap-kep-dias { font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .ap-kep-dias.atorado { color: var(--warn-soft-fg); font-weight: var(--fw-bold); }
    .ap-kep-que { grid-column: 1 / -1; font-size: var(--fs-sm); color: var(--fg-1); }
    /* [PGP.123] G.UI.6: la línea del gasto; el tono va además del texto, nunca solo (los -soft-fg pasan AA como texto). */
    .ap-kep-gasto.ok { color: var(--ok-soft-fg); }
    .ap-kep-gasto.warn { color: var(--warn-soft-fg); }
    .ap-kep-gasto.bad { color: var(--bad-soft-fg); font-weight: var(--fw-bold); }
    /* G.UI.8: quién capturó y quién revisó, el tercer nivel, al final de la línea del motivo. */
    .ap-kep-quien { font-size: var(--fs-xs); color: var(--fg-3); }
    /* [PGP.123] G.UI.1d: en «Canceladas en Kepler», lo de Kepler y quién, debajo de la pista. */
    .ap-kep-pie { font-size: var(--fs-xs); color: var(--fg-3); margin-top: 2px; }
    /* [PGP.123] G.UI.1e: las acciones para cerrar el caso, y lo ya revisado. */
    .ap-kep-acc { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-1); }
    .ap-kep-rev { grid-column: 1 / -1; font-size: var(--fs-sm); color: var(--fg-2); margin-top: var(--sp-1); }
    .ap-kep-rev .pi { color: var(--ok-soft-fg); }
    /* G.UI.7: la cancelada con gasto lleva un marcador rojo; su texto se queda neutro. */
    .ap-kep.hallazgo { box-shadow: inset 3px 0 0 var(--bad-fg); }
    .ap-kep-h { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    /* G.UI.3: el encabezado de la cola (primario), sus secciones y lo plegado. */
    .ap-kep-cab { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-3); margin-top: var(--sp-2); }
    .ap-kep-tot { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .ap-kep-rep { font-size: var(--fs-sm); color: var(--fg-2); font-variant-numeric: tabular-nums; }
    .ap-kep-sec { display: flex; flex-direction: column; }
    .ap-kep-n { margin-left: var(--sp-2); font-weight: var(--fw-normal, 400); color: var(--fg-2); font-variant-numeric: tabular-nums; }
    .ap-kep-pleg { border-top: 1px solid var(--border-color); margin-top: var(--sp-2); padding-top: var(--sp-1); }
    .ap-kep-pleg > summary { cursor: pointer; padding: var(--sp-2) 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .ap-kep-pleg > summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ap-kep-punto { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--bad-fg); margin-right: var(--sp-2); }
    .ap-kep-expl { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--fg-2); }
    @media (pointer: coarse) {
      .ap-kep-pleg > summary { min-height: 44px; }
      .ap-kep-folio { min-height: 44px; min-width: 44px; }
    }
    /* En angosto el proveedor se cortaba a tres letras («GAST…»): baja a su propia línea, completo. */
    @media (max-width: 40rem) {
      .ap-kep { grid-template-columns: auto minmax(0, 1fr) auto auto; }
      .ap-kep-prov { grid-column: 1 / -1; grid-row: 2; white-space: normal; }
    }

    /* [GX.29] Lo que te piden reabrir. Borde de aviso: es dinero ya firmado que
       alguien quiere volver a tocar, no un renglón más de la lista. */
    .ap-reap { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--warn-border); border-radius: var(--r-md); }
    .ap-reap-t { display: flex; align-items: baseline; gap: var(--sp-2); font-size: var(--fs-sm); }
    .ap-reap-t .pi { color: var(--warn-fg); }
    .ap-reap-it { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-2) var(--sp-3);
      background: var(--layout-bg); border-radius: var(--r-sm); }
    .ap-reap-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .ap-reap-act { display: flex; justify-content: flex-end; gap: var(--sp-2); }

    /* ── Pestañas ───────────────────────────────────────────────────────────── */
    /* [GX.105] Las tres listas en una lista desplegable (pedido del usuario, 2026-11-09). Antes eran
       tres tarjetas a todo lo ancho: la elegida con fondo gris (se leía apagada) y los números de las
       otras atenuados. Cerrada dice la lista que se ve con su número y su monto; abierta, las tres. */
    /* ⛔ NO «ap-lista»: ese nombre ya es la lista de vales (display:flex en columna, min-width:0), y
       como se declara más abajo le ganaba a esta regla. Visto en la pantalla viva el 2026-11-09: la
       caja se iba a todo lo ancho, la etiqueta se encogía a «A…» y la flecha caía a otra línea. */
    .ap-cual { min-width: 20rem; max-width: 100%; }
    .ap-op { display: flex; align-items: baseline; gap: var(--sp-2); width: 100%; }
    .ap-op-t { flex: 1; min-width: 0; }
    /* El número toma el color de la opción: en la elegida no se mezclan tres colores. */
    .ap-op-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); color: inherit; }
    .ap-op-n.vacio { color: var(--fg-3); font-weight: var(--fw-medium); }
    .ap-op-m { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-ver-atr { margin-top: var(--sp-2); }

    /* ── Lista ──────────────────────────────────────────────────────────────── */
    .ap-cols { display: flex; gap: var(--sp-3); align-items: flex-start; }
    .ap-grupos { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: var(--sp-2); position: sticky; top: var(--sp-3); }
    .ap-grupos-t { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em;
      color: var(--fg-3); padding: 2px 8px var(--sp-2); }
    .ap-grupo { display: flex; align-items: center; gap: var(--sp-2); width: 100%; border: 0;
      background: transparent; border-radius: var(--r-sm); padding: 6px 8px; font: inherit;
      font-size: var(--fs-sm); color: var(--fg-1); cursor: pointer; text-align: left; }
    .ap-grupo:hover { background: var(--hover-bg); }
    .ap-grupo.on { background: rgba(var(--ink-rgb), .06); box-shadow: inset 2px 0 0 var(--action); }
    /* [GX.98] El nombre del departamento se lee entero (pasa a otra línea): cortado con «…» escondía
       justo el dato que se pidió ver («LOGISTICA GE…», «Sin departament…»). */
    .ap-g-t { flex-grow: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.25; }
    .ap-g-m { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .ap-g-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2);
      background: var(--layout-bg); border-radius: var(--r-sm); padding: 0 6px; }
    .ap-org { font-size: var(--fs-nano); font-style: normal; color: var(--fg-3);
      border: 1px solid var(--border-color); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
    .ap-org.warn { color: var(--warn-fg); border-color: var(--warn-border); }

    .ap-lista { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ap-item { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: 4px; }
    .ap-item.cerrado { opacity: .72; }
    .ap-it-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .ap-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .ap-suc, .ap-hora { font-size: var(--fs-xs); color: var(--fg-3); }
    /* [GX.67] El dia de captura cuando NO es hoy. Lleva fondo porque aparece salteado
       —solo en los vales viejos— y sin el se lee como parte de la hora de al lado. */
    .ap-dia-chip {
      font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-2);
      background: var(--layout-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); padding: 0 .3rem;
    }
    .ap-hora { font-family: var(--font-mono); }
    .ap-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: var(--fw-bold); }
    .ap-it-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .ap-it-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-it-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .ap-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .ap-chip.ok { color: var(--ok-fg); border-color: var(--ok-border); }
    .ap-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .ap-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .ap-it-nota { font-size: var(--fs-xs); color: var(--fg-2); font-style: italic; }
    .ap-it-nota.warn { color: var(--warn-fg); font-style: normal; }
    .ap-it-nota.bad { color: var(--bad-fg); font-style: normal; }
    .ap-it-nota.faint { color: var(--fg-3); font-style: normal; }
    .ap-it-pie { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2);
      padding-top: var(--sp-2); border-top: 1px solid var(--c-divider); }
    .ap-abrir { font-size: var(--fs-xs); color: var(--action); display: inline-flex; align-items: center; gap: 2px; }

    /* El renglón entero es el botón: se firma mirando el vale, no desde la lista. */
    .ap-item[role='button'] { cursor: pointer; transition: border-color .12s ease, background .12s ease; }
    .ap-item[role='button']:hover { border-color: var(--action); background: var(--hover-bg); }
    .ap-item[role='button']:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ap-item.abierto { border-color: var(--action); box-shadow: inset 2px 0 0 var(--action); }

    /* ── [GX.88] El atrasado: cuánto lleva y qué le falta ─────────────────── */
    .ap-atraso { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2);
      font-size: var(--fs-sm); color: var(--fg-2); }
    .ap-atraso-d { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: var(--fw-bold); color: var(--fg-1); }
    .ap-atraso.toca .ap-atraso-t { color: var(--fg-1); }


    @media (max-width: 60rem) {
      .ap-cols { flex-direction: column; }
      .ap-grupos { width: 100%; position: static; }
    }
  `],
})
export class FinanzasAprobacionGastosComponent {
  /** `[GX.68]` La sucursal del vale se nombra con clave + nombre (`02 La Piedad Abastos`). */
  readonly branchLabel = branchLabel;
  private readonly svc = inject(ComprobacionesService);
  private readonly solicitudes = inject(SolicitudGastoService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<GastosDelDia | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');
  readonly pestana = signal<PestanaAprobacion>('entrada');
  readonly grupo = signal<string | null>(null);
  /** `[GX.100]` Una actualización silenciosa en vuelo (la lista sigue a la vista). */
  readonly actualizando = signal(false);
  /**
   * `[GX.100]` La pestaña y el departamento viven también en la URL (`?pestana=&depto=`): al
   * recargar con F5 se vuelve al mismo lugar. Opcionales: fuera del router (una prueba) no hacen nada.
   */
  private readonly router = inject(Router, { optional: true });
  private readonly ruta = inject(ActivatedRoute, { optional: true });
  readonly actuando = signal<string | null>(null);
  /** El vale que se está mirando. `null` = el panel está cerrado. */
  readonly abierto = signal<ExpedienteDelDia | null>(null);
  /** `[GX.29]` Lo que ESTA persona tiene que decidir. El servidor sólo manda lo suyo. */
  readonly reaperturas = signal<ReaperturaPendiente[]>([]);
  /** `[PGP.79]` La solicitud de Kepler de cada vale de la lista, por id. Llega en su propio viaje. */
  readonly kepler = signal<Record<string, KeplerDelVale>>({});
  /** `[PGP.79]` La consulta a Kepler falló: se DICE en el renglón, no se calla. */
  readonly keplerFallo = signal(false);
  readonly solicitudKepler = solicitudKepler;
  /**
   * `[GX.96]` Los revisados que esperan a Kepler, y los hallazgos. `null` = todavía no llega;
   * `keplerError` = no se pudo leer (no es «nada espera»).
   */
  readonly esperanKepler = signal<RespuestaEsperanKepler | null>(null);
  readonly keplerError = signal(false);
  /** `[PGP.123]` G.UI.3 — La cola partida en sus secciones (`colaDeKepler`): cada vale en exactamente una. */
  readonly cola = computed(() => colaDeKepler(this.esperanKepler()?.vales ?? []));
  /** Los que necesitan a una persona, sin contar los que no se pudieron calcular (ésos se dicen aparte). */
  readonly conMotivoN = computed(() => this.cola().conMotivo.filter((g) => g.clave !== 'sin_calcular').reduce((a, g) => a + g.vales.length, 0));
  readonly sinCalcularN = computed(() => this.cola().conMotivo.find((g) => g.clave === 'sin_calcular')?.vales.length ?? 0);
  readonly quienTexto = quienTexto;
  /** El vale que se está abriendo desde la cola (su botón se apaga: un doble clic no abre dos veces). */
  readonly abriendoDeCola = signal<string | null>(null);
  /** G.UI.4 — El botón de la cola que abrió el panel: al cerrarlo, el foco vuelve ahí. */
  private regresoDelPanel: HTMLElement | null = null;
  /** Se midió: hay respuesta y el servidor pudo leer Kepler. */
  readonly keplerMedido = computed(() => !this.keplerError() && this.esperanKepler()?.medido === true);
  /**
   * El día que acota **lo ya decidido**. Vacío = hoy, y quién es hoy lo decide el SERVIDOR
   * (hora de México).
   *
   * ⚠️ `[GX.67]` **No acota la bandeja**: lo que espera firma viene completo, de cualquier
   * fecha. Ver el doc de la clase.
   */
  private readonly fecha = signal<string>('');

  /**
   * `[GX.60]` **Una sola pestana: la bandeja.**
   *
   * Pedido del usuario (2026-10-01): *«los que vayan aprobando con el boton de revisado deben
   * desaparecer, o si les da rechazar tambien, para que siempre este limpia la seccion de
   * aprobacion de gastos»*.
   *
   * Aca vivian «Aprobados» y «Rechazados». El vale ya salia de la bandeja al decidirlo
   * —`aprobar()` y `rechazar()` recargan— pero se quedaba a la vista en la pestana de al lado,
   * y la seccion nunca se veia vacia.
   *
   * ⚠️ **Lo decidido no se perdio: se mudo.** Vive en el Expediente (`[GX.59]`), agrupado por
   * persona y con lo que le falta a cada vale. Si se hubieran borrado las pestanas sin esa
   * pantalla, el gasto aprobado del dia no existiria en ningun lado.
   *
   * ⚠️ `PestanaGasto` conserva los tres valores en el tipo: los usa `particionarDelDia()` del
   * servidor, que sigue contando las tres particiones. Lo que cambio es que esta pantalla
   * muestra una.
   *
   * `[GX.88]` Y una segunda, **Atrasados** (pedido del usuario, 2026-10-30): lo de días
   * anteriores que sigue abierto, del más viejo al más nuevo. La bandeja queda con lo de hoy.
   */
  readonly tabs: { id: PestanaAprobacion; label: string }[] = [
    { id: 'entrada', label: 'Bandeja de hoy' },
    { id: 'atrasados', label: 'Atrasados' },
    // `[GX.96]` Lo revisado que espera a Kepler: antes sólo lo veía quien capturó, que no puede moverlo.
    { id: 'kepler', label: 'Esperan a Kepler' },
    // `[PGP.123]` G.UI.1c — Lo que Kepler canceló de lo ya comprobado (pedido de Francisco, 2026-11-16).
    { id: 'canceladas', label: 'Canceladas en Kepler' },
  ];

  constructor() {
    // `[GX.88]` El vale elegido en el buscador de arriba se abre AQUÍ, con lo que esta pantalla ofrece.
    this.busqueda?.aperturas$.pipe(takeUntilDestroyed()).subscribe((v) => this.abrir(v));
    this.leerDeLaUrl();
    this.cargar();
    this.pedirCancelaSucursales();
    effect(() => this.escribirEnLaUrl(this.pestana(), this.grupo()));
    // `[PGP.122]` Al abrir una solicitud nacida en la Suite se pide lo que su firma escribe en Kepler (una vez por vale).
    effect(() => {
      const a = this.abierto();
      const k = a ? this.kepler()[a.id] : null;
      if (!a || !k?.nace_en_la_suite || this.detalleSuite()?.id === a.id || this.pidiendoDetalle === a.id) return;
      this.pidiendoDetalle = a.id;
      this.solicitudes.detalle(a.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.pidiendoDetalle = null; if (this.abierto()?.id === d.id) this.detalleSuite.set(d); },
        // Si falla, no se vuelve a pedir en cada refresco (queda marcado); el visor sigue con el estado de Kepler.
        error: () => undefined,
      });
    });
    // `[GX.73]` Se refresca sola mientras la pestaña se ve: los vales nuevos llegan sin recargar.
    encuestarVisible(REFRESCO_VALES_MS, () => this.refrescar());
  }

  /** Hay un refresco en vuelo: el siguiente no se encima. */
  private refrescando = false;

  /**
   * `[GX.73]` **El refresco en segundo plano.** No es `cargar()`, en tres cosas:
   *  · no muestra el aviso de carga (la bandeja no parpadea cada minuto);
   *  · NO borra el filtro de departamento (`cargar()` lo limpia porque cambia el día; acá el día
   *    es el mismo y perder el filtro le cambiaría la lista a quien está trabajando sobre ella);
   *  · un fallo NO pisa la bandeja buena con un error.
   *
   * ⛔ No corre con un vale abierto ni con una decisión en vuelo: refrescar debajo de quien está
   * firmando podría quitarle el vale de la lista a mitad de la lectura.
   */
  refrescar(): void {
    // Con un vale abierto la lista no se toca, pero sus archivos sí se vuelven a firmar si ya caducan.
    if (this.abierto()) { this.refirmarSiCaduca(); return; }
    if (this.actuando() || this.cargando() || this.refrescando) return;
    this.refrescando = true;
    this.svc.delDia(this.fecha() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.datos.set(d);
          this.datosAt = Date.now();
          this.cargarKepler(d);
          // Si el departamento elegido ya no tiene nada (otra persona firmó lo último), se suelta
          // el filtro: con un solo departamento la barra se esconde y no habría cómo quitarlo.
          const g = this.grupo();
          if (g && !this.gruposVisibles().some((x) => x.clave === g)) this.grupo.set(null);
          this.refrescando = false;
        },
        error: () => { this.refrescando = false; },
      });
    this.svc.reaperturasPendientes()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (rs) => this.reaperturas.set(rs ?? []), error: () => undefined });
  }

  /** El día que se está mirando. Mientras no haya respuesta, lo que se pidió. */
  readonly fechaActiva = computed(() => this.datos()?.fecha || this.fecha());

  /**
   * `[GX.67]` Hoy, **según el servidor** (hora de México). Lo usa el renglón para decidir si
   * muestra su día de captura.
   *
   * ⚠️ NO se calcula con `new Date()`: el navegador puede estar en otra zona —o con el reloj
   * corrido— y entonces los vales de hoy se marcarían como viejos, o los de ayer no. Es la
   * misma trampa que la Fase VP midió en 21 de 24 píldoras de frescura.
   */
  readonly hoy = computed(() => this.datos()?.hoy ?? '');

  /**
   * Trae el día. `[GX.100]` `silencioso`: con datos ya en pantalla, NO los quita mientras llegan los
   * nuevos — antes la lista se cambiaba por «Cargando…» y al volver la vista saltaba al inicio y se
   * perdía el departamento elegido (reportado por el usuario, 2026-11-06). Se usa al actualizar y
   * después de decidir sobre un vale. Sólo la primera carga muestra «Cargando…».
   */
  cargar(silencioso = false): void {
    const enSilencio = silencioso && this.datos() !== null;
    if (enSilencio) this.actualizando.set(true); else this.cargando.set(true);
    this.error.set('');
    this.svc.delDia(this.fecha() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.datos.set(d);
          this.datosAt = Date.now();
          // El departamento elegido se CONSERVA mientras exista (otra persona pudo firmar lo último).
          const g = this.grupo();
          if (g && !this.gruposVisibles().some((x) => x.clave === g)) this.grupo.set(null);
          this.cargando.set(false);
          this.actualizando.set(false);
          // `[PGP.79]` La solicitud de Kepler de cada vale, en su propio viaje.
          this.cargarKepler(d);
        },
        // Un error NO se pinta como «ese día no se levantó nada»: es otra afirmación, y la
        // equivocada deja dinero esperando sin que nadie lo sepa. `[GX.100]` En silencio, la lista que
        // está en pantalla se queda (es la última cierta) y se dice que no se pudo actualizar.
        error: () => {
          this.cargando.set(false);
          this.actualizando.set(false);
          if (enSilencio) {
            this.toast.add({ severity: 'warn', summary: 'No se pudo actualizar', detail: 'Lo que ves es de la carga anterior. Vuelve a intentar.' });
          } else {
            this.error.set('No se pudo cargar el día. Vuelve a intentar.');
          }
        },
      });

    // `[GX.29]` Las reaperturas van en su propio viaje: son de cualquier fecha, mientras
    // que el día es de este día. ⚠️ Su error NO tumba la pantalla — que falle la consulta
    // de reaperturas no puede impedir firmar los gastos de hoy. Queda la lista vacía, que
    // es exactamente lo que se ve cuando no hay ninguna: acá eso es aceptable porque el
    // panel no afirma «no hay», se esconde.
    this.svc.reaperturasPendientes()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rs) => this.reaperturas.set(rs ?? []),
        error: () => this.reaperturas.set([]),
      });
    // `[GX.96]` La cola de Kepler va en su propio viaje y su error no tumba la pantalla: se DICE
    // en su pestaña. Sólo al cargar (no en el refresco de cada minuto): es la consulta más cara.
    this.pedirCola();
    // `[GX.88]` Si hay una búsqueda abierta, también se pone al día: después de firmar un vale
    // desde la búsqueda, su renglón tiene que decir el estado nuevo, no el de hace un momento.
    this.busqueda?.rebuscar();
  }

  /** `[GX.100]` La pestaña y el departamento de la URL. Lo que no se reconoce se ignora. */
  private leerDeLaUrl(): void {
    const q = this.ruta?.snapshot?.queryParamMap;
    if (!q) return;
    const p = q.get('pestana');
    if (p === 'atrasados' || p === 'kepler' || p === 'canceladas') this.pestana.set(p);
    const g = q.get('depto');
    if (g) this.grupo.set(g);
  }

  /** Reemplaza (no apila) la entrada del historial: «atrás» sigue llevando a la pantalla anterior. */
  private escribirEnLaUrl(p: PestanaAprobacion, g: string | null): void {
    if (!this.router || !this.ruta) return;
    const q = this.ruta.snapshot.queryParamMap;
    const pUrl = p === 'entrada' ? null : p;
    if ((q.get('pestana') ?? null) === pUrl && (q.get('depto') ?? null) === g) return;
    void this.router.navigate([], { relativeTo: this.ruta, queryParams: { pestana: pUrl, depto: g }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  verPestana(p: PestanaAprobacion): void {
    this.pestana.set(p);
    // El filtro por departamento es de cada lista: arrastrarlo a otra pestaña dejaría la lista
    // recortada sin que se vea por qué.
    this.grupo.set(null);
  }

  /**
   * `[GX.98]` Los grupos por departamento de la pestaña que se ve. Hoy: los de la bandeja; Atrasados:
   * los suyos. Un servidor viejo sin los de atrasados no muestra barra (no se inventan grupos).
   */
  readonly gruposVisibles = computed<GrupoAprobacion[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const p = this.pestana();
    if (p === 'entrada') return d.entrada?.por_departamento ?? [];
    if (p === 'atrasados') return d.atrasados_por_departamento ?? [];
    return [];
  });

  /** «Todos» cuenta vales, no la suma de los grupos: un vale repartido está en varios. */
  readonly totalSinGrupo = computed(() => {
    const d = this.datos();
    if (!d) return 0;
    return this.pestana() === 'atrasados' ? (d.atrasados?.length ?? 0) : d.entrada.total;
  });

  /** `[GX.98]` La parte del vale en el departamento elegido, sólo si es menos que el vale entero. */
  parteEnGrupo(p: ExpedienteDelDia): number | null {
    const g = this.grupo();
    if (!g?.startsWith('dep:')) return null;
    const d = p.departamentos?.find((x) => `dep:${x.clave}` === g);
    return d && Math.round(d.importe * 100) < Math.round(p.importe * 100) ? d.importe : null;
  }

  /** `[GX.98]` El departamento en el renglón: el de más importe y «y N más» si está repartido. */
  departamentosTexto(p: ExpedienteDelDia): string {
    const ds = p.departamentos;
    if (ds === undefined) return p.solicitante || 'departamento sin medir';
    if (ds === null) return 'departamento sin leer en Kepler';
    if (!ds.length) return 'sin departamento en Kepler';
    const primero = ds[0].nombre ?? ds[0].clave;
    return ds.length === 1 ? primero : `${primero} y ${ds.length - 1} más`;
  }

  /** La lista completa del vale repartido, con la parte de cada uno. */
  departamentosTitulo(p: ExpedienteDelDia): string | null {
    const ds = p.departamentos;
    if (!ds || ds.length < 2) return null;
    return ds.map((x) => `${x.nombre ?? x.clave}: ${this.money(x.importe)}`).join(' · ');
  }

  /**
   * Lo que se ve, según la pestaña y el grupo elegido.
   *
   * ⚠️ `todos` no filtra **nada**, ni siquiera un estado que el servidor no reconoció: si
   * también lo escondiera, ese expediente no existiría en ninguna pantalla.
   */
  readonly visibles = computed<ExpedienteDelDia[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const p = this.pestana();
    // `[GX.88]` Los atrasados vienen ya ordenados del servidor (del más viejo al más nuevo).
    // ⛔ `sin_etapa` entra por la bandeja de entrada: sin esto, un estado que el servidor no
    // reconoce no saldría en NINGUNA pestaña. Ver `visibleEn()` en `etapas-del-dia.ts`.
    const filas: ExpedienteDelDia[] = p === 'atrasados'
      ? (d.atrasados ?? [])
      : d.filas.filter((f) => f.etapa === 'entrada' || f.etapa === 'sin_etapa');
    const g = this.grupo();
    if (!g) return filas;
    const sel = this.gruposVisibles().find((x) => x.clave === g);
    if (!sel) return filas;
    const ids = new Set(sel.ids);
    return filas.filter((f) => ids.has(f.id));
  });

  /**
   * El contador de cada pestaña. La bandeja de entrada suma **lo que espera decisión más lo
   * que no se reconoce**, y por eso los tres contadores suman el día completo — si no, la
   * pantalla tendría expedientes que no aparecen en ninguna cuenta.
   */
  /**
   * `[PGP.123]` G.UI.2 — El monto de una fila de «Esperan a Kepler». En una cancelada con gasto, `importe` es el saldo
   * de Kepler (0 al cancelarse) y la fila pregunta «¿salió dinero?»: el monto que importa es el que se capturó.
   * Medido el 2026-11-15 en la cola con los vales reales: vales de $712.43, $1,500 y $4,600 salían como «$0.00».
   */
  importeEnCola(v: ValeEsperaKepler): number {
    // `[PGP.123]` G.UI.1b: la MISMA regla que el Expediente (`importeDelVale`, en el contrato).
    return importeDelVale({ importe: v.importe, importe_capturado: v.importe_capturado, kepler_estado: v.hallazgo ? 'C' : v.kepler_estado }).importe;
  }

  /** La frase de la cancelada con gasto: la del contrato, la misma que dice el Expediente. */
  readonly textoHallazgo = ETIQUETA_FALTA_EN_KEPLER.cancelada_con_gasto;
  /** `[PGP.123]` G.UI.1c — La cancelada sin gasto: la frase del contrato, la del Expediente. */
  readonly textoCancelada = ETIQUETA_FALTA_EN_KEPLER.cancelada;
  readonly esCanceladaEnKepler = esCanceladaEnKepler;
  /** `[PGP.123]` G.UI.1d — Lo que la Suite averiguó de una cancelada (el dinero y la recaptura), con la regla del contrato. */
  pistaDe(v: ValeEsperaKepler): ReturnType<typeof lecturaDeLaCancelada> {
    return lecturaDeLaCancelada(v.pista_cancelada);
  }

  /** `[PGP.123]` G.UI.1e — El caso que se está cerrando (`null` = el diálogo está cerrado). */
  readonly cierre = signal<{ vale: ValeEsperaKepler; modo: ModoCierre; folio: string | null } | null>(null);
  /** El servidor puede guardar la revisión (su migración ya está): manda `cancelada_revisada` en las canceladas. */
  readonly cierreDisponible = computed(() => this.cola().canceladas.some((v) => v.cancelada_revisada !== undefined));

  abrirCierre(v: ValeEsperaKepler, modo: ModoCierre, folio: string | null): void {
    this.cierre.set({ vale: v, modo, folio });
  }

  /** Cerró el caso: lo dice, y la cola se vuelve a pedir (el vale cambia de lista o sale). */
  alCerrarCancelada(e: CierreHecho): void {
    this.cierre.set(null);
    const detail = e.modo === 'ligar' ? `El vale ahora es de la solicitud XA1501-${e.folio}.`
      : e.modo === 'repetido' ? 'El vale se rechazó por repetido; se le avisa a quien lo capturó.' : 'El caso quedó cerrado con tu nota.';
    this.toast.add({ severity: 'success', summary: e.modo === 'ligar' ? 'Ligado' : e.modo === 'repetido' ? 'Rechazado' : 'Revisada', detail });
    this.pedirCola();
    if (e.modo === 'repetido') this.cargar(true);
  }

  /** `[PGP.123]` G.UI.1c — «Canceladas en Kepler», partida en con gasto (¿salió dinero?) y sin gasto. */
  readonly canceladas = computed(() => partirCanceladas(this.cola().canceladas));

  /** Lo que dice Kepler cuando no es lo que se muestra (en una cancelada, su cero), para que no se esconda. */
  notaImporteKepler(v: ValeEsperaKepler): string | null {
    const m = importeDelVale({ importe: v.importe, importe_capturado: v.importe_capturado, kepler_estado: v.hallazgo ? 'C' : v.kepler_estado });
    return m.kepler === null ? null : `en Kepler quedó en ${this.money(m.kepler)}`;
  }

  /** `[GX.96]` La cola de Kepler. Su error se DICE en su pestaña (no es «nada espera»). */
  private pedirCola(): void {
    this.keplerError.set(false);
    this.svc.esperanKepler()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.esperanKepler.set(r),
        error: () => { this.esperanKepler.set(null); this.keplerError.set(true); },
      });
  }

  /** La suma de una sección, con la MISMA regla que cada fila (`importeEnCola`): encabezado y filas cuadran. */
  montoDe(vs: readonly ValeEsperaKepler[]): number {
    return Math.round(vs.reduce((a, v) => a + this.importeEnCola(v), 0) * 100) / 100;
  }

  /** G.UI.6 — Lo que le falta al gasto de un autorizado (la misma línea que el panel). */
  lineaGasto(v: ValeEsperaKepler): ReturnType<typeof lineaDelGasto> {
    return lineaDelGasto(v.gasto_kepler);
  }

  conteo(p: PestanaAprobacion): { n: number; monto: number } {
    const d = this.datos();
    if (!d) return { n: 0, monto: 0 };
    // `[GX.88]` El total REAL de atrasados, no sólo los que llegaron: si la lista se cortó, el
    // contador no puede decir menos de lo que hay.
    if (p === 'atrasados') return d.atrasados_total ?? { n: 0, monto: 0 };
    if (p === 'kepler' || p === 'canceladas') {
      // `[PGP.123]` G.UI.1c: las canceladas son su propia lista; las dos suman lo que trae la cola, sin repetir un vale.
      const todos = this.esperanKepler()?.vales ?? [];
      // `[PGP.123]` G.UI.1e: en «Canceladas en Kepler» cuenta lo que falta revisar (lo revisado va plegado, con su número).
      const vs = p === 'canceladas' ? this.cola().canceladas.filter((v) => !v.cancelada_revisada) : todos.filter((v) => !esCanceladaEnKepler(v));
      // El total suma lo mismo que pinta cada fila (`importeEnCola`): si no, encabezado y filas no cuadran.
      return { n: vs.length, monto: this.montoDe(vs) };
    }
    const e = d.etapas.entrada ?? { n: 0, monto: 0 };
    const raro = d.etapas.sin_etapa ?? { n: 0, monto: 0 };
    return { n: e.n + raro.n, monto: Math.round((e.monto + raro.monto) * 100) / 100 };
  }

  /** `[GX.96]` Lo que espera cada vale revisado, con las palabras del contrato. */
  esperaTexto(e: EsperaKepler | null): string { return e ? ETIQUETA_ESPERA_KEPLER[e] : ''; }

  /**
   * `[PGP.123]` G.UI.4 — El folio de la cola abre el vale en el panel SIN tocar la cola. Antes buscaba el folio arriba,
   * la búsqueda reemplazaba la lista y al cerrar se perdía el lugar (con 126 vales, ~2 acciones extra por vale). La
   * cola no trae el vale completo: se pide a la misma búsqueda del servidor, sin pasar por el buscador de la pantalla.
   */
  abrirDesdeCola(v: ValeEsperaKepler, ev?: Event): void {
    const folio = String(v.folio_solicitud ?? '').trim();
    if (this.abriendoDeCola()) return;
    const origen = ev?.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
    this.abriendoDeCola.set(v.id);
    // `[PGP.122]` Sin folio (la solicitud que nació en la Suite y Kepler no tiene) se busca por el id del vale.
    this.svc.buscarGastos(folio || v.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.abriendoDeCola.set(null);
        const vale = (r?.vales ?? []).find((x) => x.id === v.id);
        if (!vale) {
          this.toast.add({ severity: 'warn', summary: 'No se pudo abrir el vale', life: 8000,
            detail: `${folio ? `La búsqueda del folio ${folio}` : 'La búsqueda del vale sin folio'} no lo trajo: búscalo arriba.` });
          return;
        }
        this.abrir(vale);
        this.regresoDelPanel = origen;
      },
      error: (e) => { this.abriendoDeCola.set(null); this.falla('No se pudo abrir el vale', e); },
    });
  }

  /** `[PGP.122]` Cómo se anuncia el folio de la cola: sin folio, de quién y cuánto (dos sin folio no suenan igual). */
  etiquetaDeCola(v: Pick<ValeEsperaKepler, 'folio_solicitud' | 'proveedor' | 'importe'>): string {
    const folio = String(v.folio_solicitud ?? '').trim();
    if (folio) return `Abrir el vale ${folio}`;
    return `Abrir el vale sin folio${v.proveedor ? ` de ${v.proveedor}` : ''} por ${this.money(v.importe)}`;
  }
  readonly solicitudSinEscribir = solicitudSinEscribir;
  readonly lecturaSinEscribir = lecturaSinEscribir;

  /**
   * `[PGP.123]` G.UI.5 — El gasto (X-A-10) del vale abierto, si está en la cola de comprobación. `undefined` = no espera
   * su gasto (el eslabón no se pinta); `null` = espera, pero el servidor no pudo calcular qué le falta (se dice).
   */
  readonly gastoDelAbierto = computed<ComprobacionEnLaCola | null | undefined>(() => {
    const a = this.abierto();
    if (!a) return undefined;
    const v = (this.esperanKepler()?.vales ?? []).find((x) => x.id === a.id);
    return v?.espera === 'falta_generar_gasto' && !v.hallazgo ? (v.gasto_kepler ?? null) : undefined;
  });

  /** `[PGP.123]` G.9 — Escribe (o reintenta) el gasto del vale en Kepler ahora, sin esperar el ciclo; dice cómo quedó. */
  reintentarGasto(id: string): void {
    this.actuando.set(id);
    this.svc.reintentarGasto(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (e) => {
        this.actuando.set(null);
        if (e?.folio && (e.status === 'written' || e.status === 'seen_in_ods')) {
          this.toast.add({ severity: 'success', summary: 'Gasto escrito en Kepler',
            detail: `X-A-10 ${e.folio}${e.poliza ? ' · póliza ' + polizaCorta(e.poliza) : ''}.` });
        } else {
          this.toast.add({ severity: 'warn', summary: 'Todavía no se escribe', life: 8000, detail: e?.nota ?? 'La Suite no pudo escribirlo todavía.' });
        }
        this.pedirCola();
      },
      error: (e) => { this.actuando.set(null); this.falla('No se pudo escribir el gasto', e); },
    });
  }

  vacioDe(p: PestanaAprobacion): string {
    if (p === 'kepler') return 'Ningún vale revisado espera a Kepler.';
    if (p === 'canceladas') return 'Ningún vale comprobado tiene su solicitud cancelada en Kepler.';
    if (p === 'atrasados') {
      // Sin datos del servidor no se afirma que no haya: se dice que no se midió.
      return this.atrasadosMedidos() ? 'No se quedó nada atrasado.' : 'No se puede saber: el servidor no mandó los atrasados.';
    }
    return this.grupo() ? 'Ese departamento ya no tiene nada esperando firma.' : 'Nada espera tu visto bueno.';
  }

  /** `[GX.88]` «hoy», «1 día», «18 días». Sin fecha legible no se inventa un número. */
  diasTexto(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return 'sin fecha';
    if (n <= 0) return 'hoy';
    return n === 1 ? '1 día' : `${n} días`;
  }


  /**
   * `[GX.88]` ¿El servidor mandó los atrasados? Una API sin actualizar responde sin el campo:
   * eso es «no se midió», no «no hay». Sin esta distinción la pantalla diría «no se quedó nada
   * atrasado» —falso— o, peor, tronaría al leer el campo y dejaría de responder a los clics.
   */
  readonly atrasadosMedidos = computed(() => Array.isArray(this.datos()?.atrasados));

  /**
   * `[GX.88]` El buscador de gastos vive ARRIBA de las pestañas (en el shell, que provee su
   * estado). Esta pantalla sólo esconde lo suyo mientras hay búsqueda y abre el vale elegido.
   * `optional`: fuera del shell (una prueba, otra ruta) no hay buscador y nada cambia.
   */
  protected readonly busqueda = inject(BuscadorGastosEstado, { optional: true });
  readonly buscandoArriba = computed(() => this.busqueda?.buscando() ?? false);

  /** `[GX.27]` El helper COMPARTIDO del repo (`core/utils/mx-date`). Yo habia escrito uno
   *  identico acá — un duplicado es un segundo lugar donde se puede corregir mal. */
  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  readonly peekAbierto = computed(() => this.abierto() !== null);

  /** Cuándo llegó la lista (`datos`): sus archivos se firmaron en ese viaje. */
  private datosAt = 0;
  /** Cuándo se firmaron los archivos del vale abierto. `0` = no se sabe (vino del buscador). */
  private firmadoAt = 0;

  /**
   * Abre el vale. Los archivos vienen firmados en la fila, pero la firma dura 30 min
   * (`signFiles(…, 1800)`): un PDF con la firma vencida no avisa nada, el recuadro queda gris.
   * Si la fila ya tiene sus años (o vino del buscador), se piden firmados de nuevo.
   */
  abrir(p: ExpedienteDelDia): void {
    this.regresoDelPanel = null;
    this.abierto.set(p);
    const d = this.datos();
    const deLaLista = !!d && [...d.filas, ...(d.atrasados ?? [])].includes(p);
    this.firmadoAt = deLaLista ? this.datosAt : 0;
    this.refirmarSiCaduca();
    // `[PGP.79]` Un vale abierto desde la búsqueda no venía en la lista: se pide el suyo.
    if (!this.kepler()[p.id]) this.pedirKepler([p.id]);
  }

  /**
   * Vuelve a firmar los archivos del vale abierto si su firma tiene más de `REFIRMAR_MS` (vence a
   * los 30 min). `GET /:id` los devuelve re-firmados. Corre al abrir y en cada refresco de la página.
   */
  private refirmarSiCaduca(): void {
    const v = this.abierto();
    if (!v || Date.now() - this.firmadoAt < REFIRMAR_MS) return;
    this.firmadoAt = Date.now(); // el siguiente refresco no se encima con éste
    this.svc.detail(v.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (det) => this.abierto.update((a) => (a && a.id === v.id && det.files ? { ...a, files: det.files } : a)),
      error: () => { this.firmadoAt = 0; },
    });
  }

  /**
   * `[PGP.79]` **La solicitud de Kepler de los vales de la bandeja y de Atrasados**, en su propio
   * viaje y en tandas de 150 (van en la URL). ⚠️ Su error no tumba la pantalla —firmar no depende
   * de esto—, pero tampoco se calla: el renglón dice «no se pudo consultar».
   */
  private cargarKepler(d: GastosDelDia): void {
    this.pedirKepler([...d.filas, ...(d.atrasados ?? [])].map((f) => f.id));
  }

  private pedirKepler(ids: string[]): void {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (!unicos.length) return;
    const tandas: string[][] = [];
    for (let i = 0; i < unicos.length; i += 150) tandas.push(unicos.slice(i, i + 150));
    forkJoin(tandas.map((t) => this.svc.keplerDeVales(t)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rs) => { this.kepler.update((m) => Object.assign({ ...m }, ...rs)); this.keplerFallo.set(false); },
        error: () => this.keplerFallo.set(true),
      });
  }

  /** `[PGP.79]` Lo que dice la pastilla de Kepler del renglón. `null` = todavía no llega. */
  keplerDe(p: ExpedienteDelDia): { texto: string; tono: TonoKepler } | null {
    const k = this.kepler()[p.id];
    if (k) return lecturaKepler(k, p.status);
    return this.keplerFallo() ? { texto: 'Kepler: no se pudo consultar', tono: 'neutro' } : null;
  }

  /** `[PGP.79]` La solicitud de Kepler del vale abierto, para el detalle. */
  readonly keplerDelAbierto = computed<KeplerDelVale | null>(() => {
    const a = this.abierto();
    return a ? (this.kepler()[a.id] ?? null) : null;
  });

  /** `[PGP.122]` Lo que se escribe en Kepler al firmar la solicitud nacida en la Suite (se pide al abrirla). */
  private readonly detalleSuite = signal<DetalleDeLaSolicitud | null>(null);
  private pidiendoDetalle: string | null = null;
  readonly detalleDelAbierto = computed(() => {
    const a = this.abierto();
    const d = this.detalleSuite();
    return a && d?.id === a.id ? d : null;
  });

  /** `[PGP.122]` Reintenta escribir en Kepler la solicitud que se atoró, espera o Kepler rechazó (ya corregida). */
  reintentarKepler(id: string): void {
    this.actuando.set(id);
    this.solicitudes.reintentarKepler(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        this.actuando.set(null);
        if (s?.status === 'written' || s?.status === 'seen_in_ods') {
          this.toast.add({ severity: 'success', summary: 'Escrita en Kepler', detail: `Nació autorizada: ${solicitudKepler(s.folio) ?? 'folio ' + s.folio}.` });
        } else {
          this.toast.add({ severity: 'warn', summary: 'Todavía no se escribe', life: 8000, detail: s?.nota ?? 'Kepler no la aceptó todavía.' });
        }
        this.pedirKepler([id]);
      },
      error: (e) => { this.actuando.set(null); this.falla('No se pudo reintentar en Kepler', e); },
    });
  }

  /**
   * `[PGP.122]` F3 (DS40): cancela en Kepler la solicitud que escribió la Suite (sin gasto vivo, con motivo) y el vale
   * queda rechazado. Si Kepler no la deja (gasto aplicado, otra la tiene tomada), el aviso dice por qué.
   */
  /** `[PGP.122.6]` Dónde se puede cancelar la solicitud capturada en Kepler (se pide una vez; sin respuesta, en ninguna). */
  readonly cancelaSucursales = signal<readonly string[]>([]);
  private pedirCancelaSucursales(): void {
    this.solicitudes.cancelacionDisponible().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.cancelaSucursales.set(r?.sucursales ?? []),
      error: () => this.cancelaSucursales.set([]),
    });
  }

  cancelarKepler(e: { id: string; motivo: string }): void {
    // `[PGP.122.6]` La capturada en Kepler (no nació en la Suite) se cancela por su sucursal y folio.
    const v = this.abierto();
    if (v && v.id === e.id && !this.kepler()[e.id]?.nace_en_la_suite && v.sucursal && v.folio_solicitud) {
      this.actuando.set(e.id);
      this.solicitudes.cancelarSolicitudKepler(v.sucursal, v.folio_solicitud, e.motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.actuando.set(null);
          const doc = solicitudKepler(r.folio) ?? r.folio;
          if (r.estado === 'rechazada') {
            this.toast.add({ severity: 'error', summary: 'Kepler no la dejó cancelar', sticky: true, detail: `${doc}: ${r.rechazo ?? 'sin motivo'}` });
            return;
          }
          this.abierto.set(null);
          this.toast.add({ severity: 'info', summary: r.estado === 'ya_estaba' ? 'Ya estaba cancelada en Kepler' : 'Cancelada en Kepler', life: 8000,
            detail: `${doc}${r.vales_cerrados ? '; el vale quedó rechazado con el motivo' : ''}.` });
          this.cargar(true);
        },
        error: (err) => { this.actuando.set(null); this.falla('No se pudo cancelar en Kepler', err); },
      });
      return;
    }
    this.actuando.set(e.id);
    this.solicitudes.cancelarEnKepler(e.id, e.motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        this.actuando.set(null);
        this.abierto.set(null);
        this.toast.add({ severity: 'info', summary: 'Cancelada en Kepler', life: 8000, detail: s.nota ?? `Solicitud ${solicitudKepler(s.folio) ?? s.folio ?? ''} cancelada; el vale quedó rechazado.` });
        this.cargar(true);
      },
      error: (err) => this.falla('No se pudo cancelar en Kepler', err),
    });
  }

  /** El `model` del panel avisa cuando se cierra (Escape, backdrop o la X). */
  cerrarSiHaceFalta(v: boolean): void {
    if (v) return;
    this.abierto.set(null);
    // `[PGP.123]` G.UI.4: abierto desde la cola, el foco vuelve a su renglón (la cola sigue donde estaba).
    const r = this.regresoDelPanel;
    this.regresoDelPanel = null;
    if (r?.isConnected) setTimeout(() => r.focus(), 0);
  }

  /**
   * Qué se puede hacer con este vale, **según su estado** — no según la pestaña: dentro de
   * «Aprobados» conviven tres momentos del cierre y cada uno ofrece otra cosa.
   */
  accionesDe(p: ExpedienteDelDia | null): readonly AccionVale[] {
    if (!p) return [];
    // `[GX.65.4a]` En el vale propio no se ofrece decidir. El servidor lo niega igual: esto sólo
    // evita el clic que va a fallar.
    if (this.esMio(p)) return [];
    if (p.status === 'recibida') return ['aprobar', 'rechazar'];
    if (p.status === 'aprobada' || p.status === 'revision') return ['comprobar', 'rechazar'];
    return [];
  }

  /**
   * `[GX.87]` Lo que ofrece el VISOR: las decisiones de `accionesDe` más sumar evidencia.
   *
   * ⛔ Va aparte de `accionesDe` a propósito: ésa decide también si el renglón se atenúa y si
   * dice «Abrir y decidir». Sumar evidencia no es una decisión — metida ahí, todo renglón
   * parecería pendiente. Esta pantalla ya exige `COMPROBAR`, así que se ofrece en cualquier
   * vale, el propio incluido (agregar no es firmar).
   */
  accionesDelVisor(p: ExpedienteDelDia | null): readonly AccionVale[] {
    if (!p) return [];
    const decisiones = this.accionesDe(p);
    return aceptaEvidenciaAdicional(p.status) ? [...decisiones, 'agregar_evidencia'] : decisiones;
  }

  /** `[GX.87]` El vale al que se le está sumando evidencia (abre el diálogo). */
  readonly paraEvidencia = signal<ExpedienteDelDia | null>(null);
  cerrarEvidencia(abierto: boolean): void { if (!abierto) this.paraEvidencia.set(null); }

  /** `[GX.87]` Lo agregado se ve ya, en el visor y en la bandeja: viene firmado del servidor. */
  alAgregarEvidencia(e: EvidenciaAgregada): void {
    this.abierto.update((v) => (v && v.id === e.id ? { ...v, files: e.files } : v));
    this.firmadoAt = Date.now(); // `evidencia-adicional` devuelve los archivos recién firmados
    const conArchivos = <T extends ExpedienteDelDia>(f: T): T => (f.id === e.id ? { ...f, files: e.files } : f);
    this.datos.update((d) => (d ? { ...d, filas: d.filas.map(conArchivos), atrasados: (d.atrasados ?? []).map(conArchivos) } : d));
    // `[GX.88]` Y en los resultados de la búsqueda, si el vale se abrió desde ahí.
    this.busqueda?.conArchivos(e.id, e.files);
    this.toast.add({ severity: 'success', summary: 'Evidencia agregada', life: 5000,
      detail: 'Quedó en el expediente con su porqué. El estado del vale no cambió.' });
  }

  /**
   * `[GX.65.4a]` ¿Lo levantó quien está mirando? Compara contra su username y, si el token lo
   * trae, su nombre completo. Es una AYUDA de pantalla: la guarda de verdad vive en el servidor
   * (que además mira quién subió la evidencia).
   */
  esMio(p: ExpedienteDelDia): boolean {
    const u = this.auth.user() as (JwtPayload & { full_name?: string }) | null;
    if (!u) return false;
    return esDuenoDelVale({ created_by: p.created_by }, { username: u.username, full_name: u.full_name });
  }

  /**
   * ¿Este expediente ya no ofrece nada que hacer? Se atenúa el renglón.
   *
   * Sale del ESTADO, igual que los botones — no de la pestaña: dentro de «Aprobados» hay
   * renglones que sí piden acción (`aprobada`, `revision`) y otros que ya cerraron
   * (`validada`). Atenuar por pestaña los pintaría a todos iguales.
   */
  sinAcciones(p: ExpedienteDelDia): boolean {
    return this.accionesDe(p).length === 0;
  }

  /**
   * `[PGP.122]` Cómo se anuncia el renglón. Su `aria-label` REEMPLAZA a todo lo que trae dentro, así que tiene que decir
   * lo que dice la pantalla: el folio como se ve (`XA1501-…`). La solicitud nacida en la Suite no tiene folio hasta que
   * se firma y se escribe en Kepler: se anunciaba «Ver el vale null» (medido con Playwright, 2026-11-18). Sin folio se
   * dice de quién y cuánto, porque «sin folio» solo no distingue un renglón de otro.
   */
  etiquetaDelVale(p: Pick<ExpedienteDelDia, 'folio_solicitud' | 'proveedor' | 'importe'>): string {
    const doc = solicitudKepler(p.folio_solicitud);
    if (doc) return `Ver el vale ${doc}`;
    return `Ver el vale sin folio${p.proveedor ? ` de ${p.proveedor}` : ''} por ${this.money(p.importe)}`;
  }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  formaPago(id: string): string { return FORMA_PAGO_LABEL[id] ?? id; }
  /** `[GX.74]` Varios renglones de detalle (dos tarjetas, dos referencias) en una línea. */
  readonly detallePago = detallesParaMostrar;
  estado(s: string): string { return ESTADO_LABEL[s] ?? s; }
  /** El tipo de gasto en palabras. Sin la clave cruda: `no_fiscal_comprobable` es cómo
   *  se guarda, no cómo se dice. */
  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }

  /**
   * `[GX.30]` Aprobar. El visor manda **la marca junto con el vale**: quien firma puede
   * decir que lo que vio es una prefactura o una cotización, no el comprobante.
   *
   * ⚠️ El aviso lo dice: aprobado NO es comprobado. Sin eso, el vale sale de la bandeja
   * y la deuda desaparece de la vista de quien la acaba de crear.
   */
  aprobar(a: AprobacionVale): void {
    const p = a.vale;
    this.actuando.set(p.id);
    const body = a.provisional
      ? { provisional: true, ...(a.comprobante_esperado_at ? { comprobante_esperado_at: a.comprobante_esperado_at } : {}) }
      : undefined;
    this.svc.approve(p.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.actuando.set(null);
        this.abierto.set(null);
        // `[PGP.122]` La nacida en la Suite no tiene folio hasta escribirse: no se dice «Solicitud null».
        const nombre = p.folio_solicitud ? `Solicitud ${p.folio_solicitud}` : 'Solicitud nacida en la Suite';
        this.toast.add(a.provisional
          ? { severity: 'warn', summary: 'Aprobado como provisional',
              detail: `${nombre} — queda esperando el comprobante`, life: 6000 }
          : { severity: 'success', summary: 'Aprobado', detail: nombre });
        // `[PGP.79]` El vale sale de la bandeja al aprobarlo: lo que pasó en Kepler se dice AQUÍ,
        // y el «no se pudo» se queda en pantalla hasta que alguien lo cierre.
        const k = r?.kepler;
        const doc = solicitudKepler(p.folio_solicitud) ?? 'la solicitud';
        if (k?.estado === 'escrito') {
          this.toast.add({ severity: 'success', summary: 'Autorizada en Kepler', detail: `${doc} quedó autorizada.` });
        } else if (k?.estado === 'ya_estaba') {
          this.toast.add({ severity: 'info', summary: 'Kepler ya la tenía', detail: `${doc} ya estaba ${k.kepler === 'F' ? 'aplicada' : 'autorizada'}.` });
        } else if (k?.estado === 'no_escrito') {
          this.toast.add({ severity: 'error', summary: 'No se autorizó en Kepler', sticky: true,
            detail: `${doc}: ${k.motivo}. El vale sí quedó aprobado aquí; autorízala en Kepler o avisa a Sistemas.` });
        }
        // `[PGP.122]` La solicitud que nació en la Suite no existía en Kepler: la firma la ESCRIBE, ya autorizada.
        const s = r?.solicitud_kepler;
        if (s?.status === 'written' || s?.status === 'seen_in_ods') {
          this.toast.add({ severity: 'success', summary: 'Escrita en Kepler', detail: `Nació autorizada: ${solicitudKepler(s.folio) ?? 'folio ' + s.folio}.` });
        } else if (s?.status === 'retry' || s?.status === 'pending') {
          this.toast.add({ severity: 'warn', summary: 'Kepler todavía no la recibe', life: 8000,
            detail: `${s.nota ?? 'Se reintenta sola.'} El vale sí quedó aprobado aquí.` });
        } else if (s?.status === 'in_doubt') {
          this.toast.add({ severity: 'warn', summary: 'Kepler no contestó', life: 8000,
            detail: 'No se sabe si llegó: se le pregunta a Kepler antes de reintentar, para no escribirla dos veces.' });
        } else if (s?.status === 'rejected_by_kepler' || s?.status === 'stuck') {
          this.toast.add({ severity: 'error', summary: 'Kepler no la aceptó', sticky: true,
            detail: `${s.nota ?? ''} El vale sí quedó aprobado aquí; cuando se corrija, ábrelo y usa «Reintentar en Kepler».` });
        } else if (!s && this.kepler()[p.id]?.nace_en_la_suite) {
          // La escritura no contestó (la firma sí quedó): el cron la revisa por su marca; no se calla.
          this.toast.add({ severity: 'warn', summary: 'No se supo si llegó a Kepler', life: 8000,
            detail: 'El vale quedó aprobado aquí. La Suite lo revisa sola en unos minutos, sin escribirla dos veces.' });
        }
        this.pedirKepler([p.id]);
        // `[GX.100]` Silenciosa: la lista no se vacía ni regresa al inicio.
        this.cargar(true);
      },
      error: (e) => this.falla('No se pudo aprobar', e),
    });
  }

  /**
   * `[GX.29]` La decisión sobre una reapertura. Al conceder, el vale vuelve a la bandeja
   * del día con `vuelta + 1` — el **mismo** expediente, no uno nuevo: uno nuevo contaría
   * ese dinero dos veces en el total del día y en lo que se reporta.
   */
  decidirReapertura(r: ReaperturaPendiente, aprueba: boolean): void {
    const nota = aprueba ? '' : (globalThis.prompt?.(`¿Por qué no se reabre el vale ${r.folio_solicitud}?`) ?? '').trim();
    // Negar sin decir por qué deja a quien pidió sin nada que corregir: vuelve a pedir lo mismo.
    if (!aprueba && !nota) return;
    this.actuando.set(r.id);
    this.svc.decidirReapertura(r.id, aprueba, nota || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.actuando.set(null);
          this.toast.add({ severity: aprueba ? 'success' : 'info',
            summary: aprueba ? 'Reabierto' : 'No se reabrió',
            detail: aprueba ? `${r.folio_solicitud} vuelve a la bandeja: hay que autorizarlo de nuevo` : `${r.folio_solicitud}` });
          this.cargar(true);
        },
        error: (e) => this.falla('No se pudo decidir', e),
      });
  }

  /**
   * Cerrar un gasto que ya tiene luz verde. Es `validate()`, el mismo que resuelve lo que
   * quedó en revisión porque el cuadre por visión no dio.
   */
  darPorComprobado(p: ExpedienteDelDia): void {
    this.actuando.set(p.id);
    this.svc.validate(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.abierto.set(null);
        this.toast.add({ severity: 'success', summary: 'Comprobado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar(true);
      },
      error: (e) => this.falla('No se pudo cerrar', e),
    });
  }

  /**
   * Rechazar **exige motivo**. Sin él, quien capturó recibe un «no» sin saber qué corregir
   * y vuelve a subir lo mismo — que es como se hace eterna una bandeja.
   */
  rechazar(p: ExpedienteDelDia): void {
    const motivo = (globalThis.prompt?.(`¿Por qué se rechaza la solicitud ${p.folio_solicitud}?`) ?? '').trim();
    if (!motivo) return;
    this.actuando.set(p.id);
    this.svc.reject(p.id, motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.abierto.set(null);
        this.toast.add({ severity: 'info', summary: 'Rechazado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar(true);
      },
      error: (e) => this.falla('No se pudo rechazar', e),
    });
  }

  private falla(summary: string, e: unknown): void {
    this.actuando.set(null);
    const detail = (e as { error?: { message?: string } })?.error?.message || 'Vuelve a intentar';
    this.toast.add({ severity: 'error', summary, detail });
  }
}
