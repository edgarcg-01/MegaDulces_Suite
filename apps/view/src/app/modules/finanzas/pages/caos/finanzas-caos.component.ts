import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TableModule } from 'primeng/table';
import { RouterLink } from '@angular/router';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { DENOMINACIONES_CAOS, type CaosConteoFisicoDto, type PosicionCajaDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { MetricCardComponent, type MetricTone } from '../../../../shared/components/metric-card/metric-card.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { money, dmy } from '../finanzas-format';
import { MX_TZ, todayMx, toMxDateKey } from '../../../../core/utils/mx-date';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import { CaosService, type CaosMovimiento, type CaosKpi, type CaosDenominacion, type CaosPorRuta, type CaosPorOperador, type CaosConciliacion, type CaosIngresosEstado, type CaosTipo, type CaosSaldo, type CaosTipoEfecto, type CaosVinculos } from '../../caos.service';
import { CaosSocketService } from '../../caos-socket.service';
import { CajaSocketService } from '../../caja-socket.service';
import { CashLedgerService } from '../../cash-ledger.service';
import { desgloseRubro, etiquetaPosicion, plural, type RenglonDesglose } from '../caja-general/posicion-caja.util';

/**
 * CS.2 — Reporte de movimientos de la caja fuerte CAOS (sistema externo, ADR Fase CS).
 *
 * Sólo lectura del espejo `analytics.caos_cash_movements`. Depósitos (entra efectivo) y
 * dispensaciones (sale), por denominación, por usuario, con su referencia. Se pone al día solo por
 * WS (`/caos`) + un repaso lento de red de seguridad, igual que Caja General (CG.23.2).
 *
 * ── `[CG.163]` Lo que la auditoría del 2026-10-15 cambió acá ────────────────────────────────
 *
 *  · ⛔ **Los paneles plegados ya no consultan al entrar.** `cargar()` disparaba las TRES
 *    consultas —movimientos, resumen y cuadre— en cada carga, en cada aviso del WS y en cada
 *    repaso de 60 s, con los `<details>` cerrados. El cuadre tarda **800–950 ms** y toca ~535 MB
 *    de buffers (`analytics.kepler_bank_movements` es una vista sin índices sobre el ODS). Ahora
 *    cada panel carga **al abrirse**, como ya hacía el de atribución (`[CG.58.2]`), y el repaso
 *    sólo refresca lo que está a la vista. La pantalla abre en los **8 ms** de `/movimientos`.
 *
 *  · ⛔ **Un 500 ya no se pinta como «no hubo nada».** Los dos paneles hacían
 *    `error: () => this.resumen.set(null)` y quedaban con los encabezados y cero filas —
 *    indistinguible de un rango sin movimientos. Así estuvo **oculto en producción** el 500 de
 *    `[CG.161]`. Cada panel declara ahora su propio fallo con un reintento (ADR-056).
 */
interface FilaUI extends CaosMovimiento {
  denom?: CaosDenominacion[]; denomTotal?: number | null;
  /** `[CGS.55]` El detalle no se pudo leer: se dice y se reintenta — no se pinta «sin desglose». */
  denomError?: string | null;
  /** `[CGA-A.57]` Supervisión: a qué movimientos de Caja General se vinculó. Se pide al expandir. */
  vinc?: CaosVinculos | null; vincError?: string | null;
}

/** `[CGS.55]` Una tarjeta de la respuesta: la cifra, con qué se midió y de dónde sale. */
interface TarjetaCaos {
  clave: 'saldo' | 'pendientes' | 'conteo'; label: string; valor: string; estado: string;
  desglose: RenglonDesglose[]; nota: string | null; tone: MetricTone;
}

@Component({
  selector: 'app-finanzas-caos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ButtonModule, InputTextModule, SelectModule, DatePickerModule, TableModule,
    DialogModule, InputNumberModule, TextareaModule,
    MetricCardComponent, SegmentedComponent, LoadStateComponent, FreshnessPillComponent, ContextHelpComponent,
    CajaTabsComponent],
  template: `
    <!-- [CG.121] Captura / Expediente / Caja Fuerte son UN area, no tres reportes sueltos. -->
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja Fuerte (CAOS)</h1>
          <p class="surf-page-sub">Cuánto efectivo hay en la caja fuerte y qué de lo que entra y sale falta registrar en Caja General.</p>
        </div>
        <!-- DESIGN §P — la jerga de esta pantalla va al diccionario versionado, no redactada
             acá: «sin respaldo», «grano» y «cobertura» se leyeron al revés en la auditoría. -->
        <app-context-help topic="caja-fuerte" />
        <!-- DESIGN §9 — la edad del DATO, no la de la carga. [CGA-A.33] Mide el LATIDO del carril
             (la ultima vez que se pregunto a la maquina), no el ultimo movimiento: a las 10:00 la
             maquina llevaba 16 h sin moverse con el carril sano cada 30 s, y la pildora en ambar
             afirmaba un dato viejo que no lo era. Sin latido, cae al ultimo movimiento. -->
        <app-freshness-pill measures="data" [since]="frescura()" [staleAfterSec]="600"
                            label="caja fuerte"></app-freshness-pill>
      </header>

      <!-- [CGA-A.41] DESIGN Q.1 answer-first. Quien abre esta pantalla trae DOS preguntas: cuanto
           hay en la caja fuerte, y que falta registrar en Caja General. Medido en vivo el
           2026-10-20 (nivel A): la version anterior abria con filtros, cinco cifras de flujo de un
           rango arbitrario y tres acordeones cerrados; la tabla empezaba a 830 px y no respondia
           ninguna de las dos. -->
      <section class="cs-respuesta" aria-label="Estado de la caja fuerte">
        <app-load-state [loading]="saldoCargando() && !saldoResp()" [error]="saldoError()" [isEmpty]="false"
                        [skeletonRows]="1" errorTitle="No se pudo leer el estado de la caja fuerte"
                        (retry)="cargarSaldo()">
          <!-- [CGS.55] Tres tarjetas, como las de Arqueos: cuánto hay, qué falta registrar y quién lo
               contó. Cada una con su cifra, con qué se midió y de dónde sale. Antes «En la caja fuerte»
               decía «sin medir» mientras Arqueos, a un clic, decía $83,650.00 del mismo dato: cuando la
               máquina no reporta, aquí se publica el MISMO cálculo de /posicion, con su estado. -->
          <ul class="cs-cards" aria-label="Estado de la caja fuerte">
            @for (t of tarjetas(); track t.clave) {
              <li>
                <app-metric-card [label]="t.label" format="text" [valueText]="t.valor" [tone]="t.tone" [compact]="true">
                  <span class="cs-card-est" [class.cs-mal]="t.tone === 'bad'" [class.cs-card-aviso]="t.tone === 'warn'">
                    @if (t.tone !== 'default') { <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> }
                    {{ t.estado }}
                  </span>
                  @if (t.desglose.length) {
                    <ul class="cs-card-des" [attr.aria-label]="'De dónde sale: ' + t.label">
                      @for (d of t.desglose; track $index) {
                        <li><span>{{ d.texto }}</span>@if (d.monto) { <span class="comm-num" [class.fin-entra]="d.monto.startsWith('+')" [class.fin-sale]="d.monto.startsWith('−')">{{ d.monto }}</span> }</li>
                      }
                    </ul>
                  }
                  @if (t.nota) { <span class="cs-card-nota">{{ t.nota }}</span> }
                  <!-- [CGS.22] El testigo que faltaba: una persona cuenta la maquina, a ciegas. Lo cuenta
                       quien supervisa, no la caja. -->
                  @if (t.clave === 'conteo' && puedeContar()) {
                    <span class="cs-conteo-acc">
                      <p-button label="Contar la caja fuerte" icon="pi pi-calculator" size="small" severity="secondary" [outlined]="true"
                                (onClick)="abrirConteo()"></p-button>
                      <small class="cs-conteo-hint">A ciegas: lo que dice la máquina aparece hasta guardar.</small>
                    </span>
                  }
                </app-metric-card>
              </li>
            }
          </ul>
          @if (saldoResp(); as s) {
            <!-- Estandar 2.1 — una falla se ve sin abrir nada. Solo aparece si hay algo que decir. -->
            @for (a of avisos(); track a) {
              <p class="cs-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a }}</p>
            }
            @if (s.cuadre?.descuadres?.length) {
              <div class="cs-err cs-hallazgos" role="status">
                <strong>La máquina cambió sin un movimiento que lo explique:</strong>
                <ul>
                  @for (p of s.cuadre!.descuadres; track p.desde_id + '-' + p.hasta_id) {
                    <li>
                      entre el movimiento #{{ p.desde_id }} y el #{{ p.hasta_id }}
                      ({{ horaMx(p.desde_at) }} → {{ horaMx(p.hasta_at) }}):
                      <span class="mono">{{ money(p.diferencia) }}</span> —
                      @for (x of p.por_denominacion; track x.denom) {
                        <span class="mono">{{ x.diferencia > 0 ? '+' : '' }}{{ x.diferencia }} × {{ money(x.denom) }}</span>{{ $last ? '' : ', ' }}
                      }
                      <!-- DESIGN Q.3/Q.4 — el descuadre lleva a sus movimientos con el rango puesto. -->
                      <p-button label="Ver esos movimientos" icon="pi pi-arrow-down" size="small" [text]="true"
                                (onClick)="verTramo(p.desde_at, p.hasta_at)"></p-button>
                    </li>
                  }
                </ul>
              </div>
            }
          }
        </app-load-state>
      </section>

      <!-- [CGA-A.41] La tabla es el TRABAJO: abre en lo que falta registrar. El rango solo aplica a
           «Todos» — «Sin registrar» tiene su propio universo, desde el primer movimiento registrado. -->
      <section class="cs-trabajo" aria-labelledby="cs-movimientos">
        <div class="cs-barra">
          <h2 id="cs-movimientos" class="cs-h2">Movimientos</h2>
          <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="cambiarVista($event)"
                         ariaLabel="Qué movimientos ver"></app-segmented>
          @if (vista() === 'todos') {
            <!-- DESIGN §3 punto 1 — el rango con el control de la libreria, como el resto de Finanzas. -->
            <p-datepicker inputId="cs-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy"
                          [showIcon]="true" appendTo="body" placeholder="Elegir fechas" (onClose)="alElegirRango()"
                          ariaLabel="Rango de fechas" />
            <!-- [CG.163] Las opciones salen de lo que la ventana TIENE, no de una lista a mano. -->
            <p-select inputId="cs-tipo" [options]="tiposOpc()" [(ngModel)]="tipo" optionLabel="label" optionValue="value"
                      (ngModelChange)="cargar()" [ariaLabel]="'Tipo de movimiento'"></p-select>
          }
          <input pInputText id="cs-buscar" class="cs-buscar" [(ngModel)]="buscar" (keyup.enter)="cargar()"
                 placeholder="Buscar referencia u operador" aria-label="Buscar referencia u operador" />
        </div>
        <!-- Estandar 1.6 — una linea que dice de que universo son las cifras de abajo. -->
        <p class="cs-universo fin-dim">{{ universo() }}</p>

      <!-- Tabla -->
      <app-load-state [loading]="cargando()" [error]="err()" [isEmpty]="!cargando() && !err() && rows().length === 0"
                      [emptyIcon]="vista() === 'sin_registrar' ? 'pi-check-circle' : 'pi-lock'"
                      [emptyTitle]="vista() === 'sin_registrar' ? 'Todo está registrado en Caja General' : 'Sin movimientos en el rango'"
                      [emptyHint]="vista() === 'sin_registrar' ? 'No hay depósitos ni dispensaciones de la caja fuerte sin folio.' : 'La caja fuerte no registró movimientos en estas fechas.'"
                      (retry)="cargar()">
        <!-- DESIGN O.4/D.7 — rejilla en p-table: sin ella no hay recorrido con teclado ni
             encabezado fijo, y el detalle por denominación se abría con un botón suelto. -->
        <!-- [CG.127] Paginada: son los movimientos del dispositivo, y el rango lo elige quien
             consulta. Sin paginador la unica forma de llegar al final es la rueda. -->
        <p-table [value]="rows()" dataKey="id" [expandedRowKeys]="expandidas"
                 (onRowExpand)="alExpandir($event.data)"
                 size="small" class="cs-grid surf-table surf-table--sticky"
                 [scrollable]="true" scrollHeight="flex"
                 [paginator]="rows().length > 25" [rows]="porPagina()" (onPage)="porPagina.set($event.rows)"
                 [rowsPerPageOptions]="[25, 50, 100]"
                 [showCurrentPageReport]="true"
                 currentPageReportTemplate="{first}–{last} de {totalRecords}">
          <ng-template #caption>
            <span class="sr-only">Movimientos de la caja fuerte CAOS</span>
          </ng-template>
          <ng-template #header>
            <tr>
              <!-- [CGA-A.41] Fuera «#» (un id interno que nadie busca) y «Dia contable» (medido: igual
                   a la fecha en el 100 % de 30 dias, e imprimia el ISO crudo en dos lineas). Entra
                   la columna que responde la pregunta de trabajo: si ya esta en Caja General. -->
              <th scope="col" style="width:2.5rem"><span class="sr-only">Denominaciones</span></th>
              <th scope="col" style="width:9rem">Fecha y hora</th>
              <th scope="col" style="width:9rem">Tipo</th>
              <th scope="col" class="cs-th-num" style="width:10rem">Monto</th>
              <th scope="col">Referencia</th>
              <th scope="col">Operador</th>
              <th scope="col" style="width:10rem">Caja General</th>
            </tr>
          </ng-template>
          <!-- [CGS.55] Sin etiquetas de color: eran dos por renglón (110 en 55 renglones). La DIRECCION
               va en el signo del monto (+ entra / − sale), el tipo en texto, y «Caja General» dice el
               folio o lleva a registrarlo — no repite «Sin registrar» en una vista que ya es eso. -->
          <ng-template #body let-r let-expanded="expanded" let-i="rowIndex">
            <!-- Sin pSelectableRow: sin selectionMode no hace nada, y el recorrido con
                 teclado lo da el botón de cada fila (mismo criterio que almacen-movimientos). -->
            <tr>
              <td>
                <!-- DESIGN D.7 — botón NATIVO: recibe foco, responde a Enter y Espacio sin
                     cablear nada, y el lector de pantalla anuncia si la fila está abierta. -->
                <button type="button" class="cs-toggle" [pRowToggler]="r"
                        [attr.aria-expanded]="expanded"
                        [attr.aria-label]="'Ver denominaciones del movimiento ' + r.external_id">
                  <i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i>
                </button>
              </td>
              <!-- [CGA-A.33] el instante viaja en UTC: dmy() le cortaba la fecha en UTC y lo de despues de
                   las 18:00 salia con el dia SIGUIENTE (10 movimientos, $307,860 en 30 dias). Hora de Mexico. -->
              <td class="cs-nowrap">{{ fechaHoraMx(r.occurred_at) }}</td>
              <!-- [CGA-A.33] La dirección sale del mismo mapa que suma el neto; un tipo sin decodificar
                   se dice con un aviso, no con un color. -->
              <td>
                {{ tipoTexto(r.type_label) }}
                @if (efectoDe(r.type_id)?.efecto === 'indeterminado') {
                  <span class="cs-card-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> sin decodificar</span>
                }
              </td>
              <!-- [CGS.56] Edgar: «rojo si es egreso, verde si es ingreso». El color va en el TEXTO del monto y
                   acompaña al signo: sin el color, el + / − sigue diciendo la dirección. -->
              <td class="comm-num cs-monto" [class.fin-entra]="signo(r.type_id) === '+ '" [class.fin-sale]="signo(r.type_id) === '− '">{{ signo(r.type_id) }}{{ money(r.total) }}</td>
              <td>{{ r.ref || '—' }}</td>
              <!-- El operador se dice cuando cambia: 24 de 25 renglones repetían el mismo nombre. -->
              <td class="fin-dim">
                @if (i % porPagina() === 0 || operador(rows()[i - 1]?.user_external) !== operador(r.user_external)) {
                  {{ operador(r.user_external) }}
                } @else {
                  <span aria-hidden="true">″</span><span class="sr-only">{{ operador(r.user_external) }}</span>
                }
              </td>
              <td>
                @if (r.folio_caja_general) {
                  <!-- [CGA-A.57] El folio es UNO de los que lo explican: si hay más, se dice cuántos. -->
                  <span><i class="pi pi-check" aria-hidden="true"></i> {{ r.folio_caja_general }}</span>
                  @if ((r.vinculos_n ?? 0) > 1) {
                    <span class="fin-dim"> +{{ (r.vinculos_n ?? 0) - 1 }}</span>
                  }
                } @else if (r.type_id === 0 || r.type_id === 4) {
                  <!-- [CGS.55] La pantalla dice qué falta registrar: también lleva a registrarlo, con el
                       movimiento ya puesto en la captura (Captura lo busca por su identidad). -->
                  <a class="cs-registrar" routerLink="/finanzas/caja-general"
                     [queryParams]="{ caos: r.device + '|' + r.external_id, caos_dia: diaMx(r.occurred_at) }"
                     [attr.aria-label]="'Registrar en Caja General el movimiento ' + r.external_id">
                    Registrar <i class="pi pi-arrow-right" aria-hidden="true"></i>
                  </a>
                } @else {
                  <span class="fin-dim">no aplica</span>
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #expandedrow let-r>
            <tr class="cs-det">
              <td colspan="7">
                @if (r.denom && r.denom.length) {
                  <table class="cs-denom">
                    <thead><tr><th scope="col">Denominación</th><th scope="col">Pieza</th><th scope="col" class="comm-num">Piezas</th><th scope="col" class="comm-num">Importe</th></tr></thead>
                    <tbody>
                      @for (d of r.denom; track d.denom + '|' + d.pieza_tipo) {
                        <tr>
                          <td class="mono">{{ money(d.denom) }}</td>
                          <td class="fin-dim">{{ d.pieza_tipo === 'B' ? 'billete' : d.pieza_tipo }}</td>
                          <td class="comm-num">{{ d.quantity }}</td>
                          <td class="comm-num">{{ money(d.denom * d.quantity) }}</td>
                        </tr>
                      }
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colspan="3">Suma del desglose</td>
                        <td class="comm-num">{{ money(r.denomTotal) }}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <!-- ADR-056: la diferencia se DECLARA. Los dos números vienen del dispositivo y
                       no sabemos cuál miente, así que no se corrige ninguno — se muestra. -->
                  @if (descuadre(r); as dif) {
                    <p class="cs-err cs-descuadre">
                      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                      El desglose <strong>no suma el total</strong> del movimiento: declara
                      {{ money(r.total) }} y las denominaciones suman {{ money(r.denomTotal) }}
                      ({{ money(dif) }} de diferencia). Los dos datos vienen del dispositivo; no se
                      corrige ninguno.
                    </p>
                  }
                } @else if (r.denomError) {
                  <!-- [CGS.55] Un fallo NO es «sin desglose»: se dice y se reintenta. -->
                  <span class="cs-mal">{{ r.denomError }}</span>
                  <p-button label="Reintentar" size="small" [text]="true" (onClick)="alExpandir(r)"></p-button>
                } @else if (r.denom) {
                  <span class="fin-dim">Sin desglose por denominación en este movimiento.</span>
                } @else {
                  <span class="fin-dim">Cargando denominaciones…</span>
                }
                <!-- [CGA-A.57] Supervisión: a qué movimientos de Caja General se vinculó y cuánto queda. -->
                @if (verVinculos() && (r.type_id === 0 || r.type_id === 4)) {
                  <div class="cs-vinc">
                    @if (r.vinc; as v) {
                      <div class="cs-vinc-head">
                        <strong>Vinculado a Caja General</strong>
                        <span class="mono">{{ money(v.vinculado) }} de {{ money(v.total) }}</span>
                        <span class="fin-dim">· libre <span class="mono">{{ money(v.libre) }}</span></span>
                      </div>
                      @if (v.filas.length) {
                        <table class="cs-denom">
                          <thead><tr><th scope="col">Folio</th><th scope="col">Fecha</th><th scope="col" class="comm-num">Movimiento</th><th scope="col" class="comm-num">Tomó de CAOS</th><th scope="col">Estado</th></tr></thead>
                          <tbody>
                            @for (f of v.filas; track f.cash_ledger_id) {
                              <tr [class.fin-dim]="f.estado === 'cancelado'">
                                <td>
                                  <a routerLink="/finanzas/caja-general" [queryParams]="{ q: f.folio, from: diaMx(f.fecha), to: diaMx(f.fecha) }"
                                     [attr.aria-label]="'Abrir ' + f.folio + ' en Caja General'">{{ f.folio }}</a>
                                </td>
                                <td class="mono">{{ dmy(f.fecha) }}</td>
                                <td class="comm-num">{{ money(f.monto) }}</td>
                                <td class="comm-num">{{ money(f.monto_enlazado) }}</td>
                                <td class="fin-dim">{{ f.via === 'nacio_en_la_maquina' ? 'registrado desde CAOS' : f.estado }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      } @else {
                        <span class="fin-dim">Sin movimientos de Caja General vinculados.</span>
                      }
                    } @else if (r.vincError) {
                      <span class="cs-mal">{{ r.vincError }}</span>
                      <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarVinculos(r)"></p-button>
                    } @else {
                      <span class="fin-dim">Cargando vínculos…</span>
                    }
                  </div>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
        @if (hasMore()) {
          <p class="fin-dim cs-rezago">La lista viene topada en {{ limite }} filas. Acota el rango para ver el resto.</p>
        }
      </app-load-state>
      </section>

      <!-- [CGA-A.41] Lo SECUNDARIO va debajo del trabajo, y cada panel dice su estado cerrado
           (estandar 2.1). Antes estos tres acordeones ocupaban ~280 px ENCIMA de la tabla. -->
      <section class="cs-analisis" aria-labelledby="cs-analisis-h">
        <h2 id="cs-analisis-h" class="cs-h2">Análisis</h2>

        <details class="cs-resumen">
          <summary>
            Billetes en la caja fuerte por denominación
            @if (saldoResp()?.saldo; as sd) { <span class="fin-dim">· {{ money(sd.total) }}</span> }
            @else { <span class="fin-dim">· sin medir: la máquina todavía no reporta su contenido a la suite</span> }
          </summary>
          @if (saldoResp()?.saldo; as sd) {
            <!-- DESIGN 5.4 — la base de tabla del sistema, no una re-estilada a mano. -->
            <table class="surf-table surf-table--plain is-dense cs-denoms">
              <caption class="sr-only">Billetes en la caja fuerte por denominación</caption>
              <thead><tr>
                <th scope="col" class="comm-num">Denominación</th>
                <th scope="col" class="comm-num">Billetes</th>
                <th scope="col" class="comm-num">Importe</th>
                <th scope="col">Casetes</th>
              </tr></thead>
              <tbody>
                @for (d of sd.por_denominacion; track d.denom) {
                  <tr>
                    <td class="comm-num">{{ money(d.denom) }}</td>
                    <td class="comm-num">{{ d.billetes }}</td>
                    <td class="comm-num">{{ money(d.importe) }}</td>
                    <td class="fin-dim">{{ casetesDe(d.denom) }}</td>
                  </tr>
                }
              </tbody>
              <tfoot><tr>
                <td>Total</td><td></td>
                <td class="comm-num is-strong">{{ money(sd.total) }}</td><td></td>
              </tr></tfoot>
            </table>
            @if (saldoResp()?.cuadre?.no_verificables?.length) {
              <p class="fin-dim cs-nota">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                {{ saldoResp()!.cuadre!.no_verificables.length }} tramo(s) no se pueden verificar porque llevan un
                movimiento sin decodificar: {{ saldoResp()!.cuadre!.no_verificables[0].motivo }}
              </p>
            }
          }
          <p class="cs-latido" [class.cs-latido-mal]="saldoResp()?.latido?.status === 'error' || !saldoResp()?.latido">
            <i class="pi pi-sync" aria-hidden="true"></i>
            @if (saldoResp()?.latido; as l) {
              Lectura de «Contenidos» de la máquina: última <span class="mono">{{ l.cuando }}</span>
              @if (l.error) { — <strong class="cs-err-inline">falla: {{ l.error }}</strong> }
            } @else {
              <span class="cs-err-inline">la suite todavía no lee el contenido de la máquina.</span>
            }
          </p>
        </details>

        <!-- CS.4 — total de control contra la Caja General de Kepler. [CGA-A.33] Estandar 1.4: se
             titulaba con una pregunta de cuadre y su contenido dice que NO es un cuadre. -->
        <details class="cs-resumen" (toggle)="alAbrirCuadre($event)">
          <summary>CAOS frente a la Caja General de Kepler <span class="fin-dim">· informativo, no es un cuadre</span></summary>
          <p class="fin-dim cs-nota">
            <i class="pi pi-clock" aria-hidden="true"></i>
            Este cuadre recorre el contable de Kepler y tarda cerca de <strong>1 s</strong>: por eso
            se pide al abrir el panel y no al entrar a la pantalla.
          </p>
          @if (concError(); as msg) {
            <p class="cs-err">
              {{ msg }}
              <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarCuadre()"></p-button>
            </p>
          } @else if (conc(); as k) {
            <p class="fin-dim cs-nota">
              Por CAOS pasa <strong>{{ pct(k.cobertura.depositos) }}</strong>
              del efectivo que entra a la Caja General y <strong>{{ pct(k.cobertura.dispensado) }}</strong>
              del que sale. NO es un cuadre 1:1 — CAOS es el efectivo que pasa por la máquina; el resto
              de la caja se maneja fuera. Es informativo, no un veredicto (el feed de CAOS es más fresco
              que el contable, así que el último día puede verse descuadrado por rezago, no por error).
            </p>
            <table class="surf-table surf-table--plain is-dense">
              <thead><tr>
                <th scope="col">Día</th>
                <th scope="col" class="comm-num">CAOS depósitos</th><th scope="col" class="comm-num">Kepler ingresos</th>
                <th scope="col" class="comm-num">CAOS dispensado</th><th scope="col" class="comm-num">Kepler egresos</th>
              </tr></thead>
              <tbody>
                @for (d of k.dias; track d.dia) {
                  <tr>
                    <td class="mono">{{ d.dia }}</td>
                    <td class="comm-num">{{ money(d.caos_dep) }}</td>
                    <td class="comm-num fin-dim">{{ money(d.kepler_ing) }}</td>
                    <td class="comm-num">{{ money(d.caos_dis) }}</td>
                    <td class="comm-num fin-dim">{{ money(d.kepler_egr) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="fin-dim">Cargando el cuadre…</p>
          }
        </details>

        <!-- [CG.58.2] — el conciliador de ingresos existía, estaba desplegado y NO tenía invocador:
             ni botón, ni cron, ni enganche al arqueo. Por eso la atribución estaba en cero. -->
        <details class="cs-resumen" (toggle)="alAbrirIngresos($event)">
          <!-- [CGA-A.33] Estandar 2.1 — plegar no es esconder: si el carril esta fallando, el
               resumen lo dice CERRADO. El 2026-10-20 estaba en error y la tabla de atribucion
               tenia 0 filas en toda su vida; sólo se veia abriendo el panel. -->
          <summary>
            ¿De qué cobros es este efectivo? (atribución)
            @if (latidoAtribucion()?.status === 'error') {
              <span class="cs-err-inline"> · <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                el carril está fallando desde {{ latidoAtribucion()!.cuando }}: las cifras no describen un reparto</span>
            } @else if (saldoResp() && !latidoAtribucion()) {
              <span class="cs-err-inline"> · nunca ha corrido</span>
            }
          </summary>
          <p class="fin-dim cs-nota">
            Ata cada depósito de la caja fuerte a los cobros de Kepler que lo explican, consumiendo
            del más viejo al más nuevo y sin reusar ninguno. Los tres montos van <strong>separados a
            propósito</strong>: «sin respaldo» es un depósito que ningún cobro anterior explica, y
            «sin depositar» es efectivo cobrado que todavía no entró al equipo. No son lo mismo y los
            arregla gente distinta.
          </p>
          @if (ingEstado(); as e) {
            <!-- ⛔ [CG.162] El latido va ARRIBA de las cifras, no debajo: cuando el carril está en
                 error estas cuatro filas describen un reparto que no ocurrió, y leerlas primero fue
                 exactamente cómo $18.5 M se publicaron como «sin respaldo» durante horas. -->
            <p class="cs-latido" [class.cs-latido-mal]="latido()?.status === 'error' || !latido()">
              <i class="pi pi-sync" aria-hidden="true"></i>
              Se actualiza <strong>sola, cada hora</strong> desde {{ e.desde }}.
              @if (latido(); as l) {
                Última corrida <span class="mono">{{ l.cuando }}</span>
                @if (l.error) {
                  — <strong class="cs-err-inline">el carril está fallando: {{ l.error }}</strong>
                  Mientras esto siga en rojo, las cifras de abajo <strong>no describen un reparto</strong>.
                } @else { · {{ l.nota }} }
              } @else {
                <span class="cs-err-inline">todavía no hay ninguna corrida registrada.</span>
              }
            </p>
            <table class="surf-table surf-table--plain is-dense">
              <tbody>
                <tr><td>Depositado en la caja fuerte</td>
                    <td class="comm-num">{{ money(e.monto_depositado) }}</td>
                    <td class="comm-num fin-dim">{{ e.depositos }} depósitos</td></tr>
                <tr><td>Ya atribuido a cobros</td>
                    <td class="comm-num">{{ money(e.monto_conciliado) }}</td>
                    <td class="comm-num fin-dim">{{ e.conciliados }} depósitos</td></tr>
                <tr><td>Sin respaldo (ningún cobro lo explica)</td>
                    <td class="comm-num">{{ money(e.monto_pendiente) }}</td>
                    <td class="comm-num fin-dim">{{ e.pendientes }} depósitos</td></tr>
                <tr><td>Cobrado en efectivo y <strong>no</strong> depositado</td>
                    <td class="comm-num">{{ money(e.monto_sin_depositar) }}</td>
                    <td class="comm-num fin-dim">no entró al equipo</td></tr>
              </tbody>
            </table>
            @if (ingError(); as msg) { <p class="cs-err">{{ msg }}</p> }
          } @else if (ingError(); as msg) {
            <p class="cs-err">
              {{ msg }}
              <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarIngEstado()"></p-button>
            </p>
          } @else {
            <p class="fin-dim">Cargando la atribución…</p>
          }
        </details>

        <!-- CS.6/CS.7 — resumen interno de CAOS (no cruza contra nada) -->
        <details class="cs-resumen" (toggle)="alAbrirResumen($event)">
          <summary>Resumen por operador y ruta</summary>
          @if (resumenError(); as msg) {
            <p class="cs-err">
              {{ msg }}
              <p-button label="Reintentar" size="small" [text]="true" (onClick)="cargarResumen()"></p-button>
            </p>
          } @else if (resumen(); as r) {
            <div class="cs-resumen-grid">
              <div>
                <h3 class="cs-h3">Por operador</h3>
                <table class="surf-table surf-table--plain is-dense">
                  <thead><tr><th scope="col">Operador</th><th scope="col" class="comm-num">Depósitos</th><th scope="col" class="comm-num">Dispensado</th></tr></thead>
                  <tbody>
                    @for (o of r.porOperador; track o.user_external) {
                      <tr>
                        <td>{{ o.user_external || '—' }}</td>
                        <td class="comm-num">{{ money(o.depositos_total) }} <span class="fin-dim">({{ o.depositos_n }})</span></td>
                        <td class="comm-num">{{ money(o.dispensado_total) }} <span class="fin-dim">({{ o.dispensado_n }})</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <div>
                <h3 class="cs-h3">Por ruta <span class="fin-dim">(grano declarado del depósito)</span></h3>
                <p class="fin-dim cs-nota">
                  El operador escribe la referencia a mano. Cada depósito se atribuye al
                  <strong>grano que su texto aguanta</strong> — ruta y día, sólo ruta, o sólo plaza —
                  y lo que no declara nada se dice. No se inventa una ruta: una ruta inventada le
                  cobra el depósito a un camión que no fue.
                </p>
                <table class="surf-table surf-table--plain is-dense">
                  <thead><tr><th scope="col">Atribuido a</th><th scope="col">Grano</th><th scope="col" class="comm-num">Depósitos</th><th scope="col" class="comm-num">Total</th></tr></thead>
                  <tbody>
                    @for (g of r.porRuta; track g.grano + '|' + (g.ruta ?? '') + '|' + (g.plaza ?? '') + '|' + g.motivo) {
                      <tr>
                        <td [attr.title]="g.motivo">{{ etiquetaGrano(g) }}</td>
                        <td><span class="cs-grano" [class.cs-grano-flojo]="g.grano !== 'ruta_dia' && g.grano !== 'ruta'">{{ g.grano }}</span></td>
                        <td class="comm-num">{{ g.movimientos }}</td>
                        <td class="comm-num">{{ money(g.total) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          } @else {
            <p class="fin-dim">Cargando el resumen…</p>
          }
        </details>

      </section>
    </div>
    <!-- [CGS.22] El conteo fisico. Ciego: la referencia y la diferencia se ven al guardar. -->
    <p-dialog [visible]="conteoAbierto()" (visibleChange)="$event ? null : cerrarConteo()" [modal]="true"
              [style]="{ width: '30rem', maxWidth: '96vw' }" [draggable]="false" header="Contar la caja fuerte">
      @if (!conteoGuardado()) {
        <p class="cs-conteo-hint">Anota cuántos billetes hay de cada denominación. El total se calcula solo.</p>
        <div class="cs-conteo-reja">
          @for (d of denominaciones; track d) {
            <label [for]="'cs-den-' + d">{{ mx(d) }}</label>
            <p-inputnumber [inputId]="'cs-den-' + d" [min]="0" [useGrouping]="false" [showButtons]="false"
                           [ngModel]="piezasDe(d)" (ngModelChange)="ponerPiezas(d, $event)" />
          }
        </div>
        <p class="cs-conteo-total">Contaste <b>{{ mx(totalConteo()) }}</b></p>
        <label class="cs-conteo-hint" for="cs-conteo-nota">Nota (opcional)</label>
        <textarea pTextarea id="cs-conteo-nota" rows="2" class="cs-conteo-nota"
                  [ngModel]="notaConteo()" (ngModelChange)="notaConteo.set($event)"></textarea>
      } @else {
        @if (conteoGuardado(); as g) {
          <p>Contaste <b>{{ mx(g.total) }}</b>.</p>
          @if (g.referencia_total === null) {
            <p class="cs-conteo-hint">La máquina no publicaba su saldo en ese momento: el conteo quedó guardado, pero no hay contra qué compararlo.</p>
          } @else {
            <p>La máquina decía <b>{{ mx(g.referencia_total) }}</b>{{ g.referencia_parcial ? ' (lectura parcial)' : '' }}.</p>
            <p [class.cs-mal]="g.diferencia !== 0"><b>{{ g.diferencia === 0 ? 'Cuadra al peso.' : 'Diferencia: ' + firmado(g.diferencia ?? 0) }}</b></p>
          }
        }
      }
      @if (errConteo()) { <p class="cs-mal" role="alert">{{ errConteo() }}</p> }
      <ng-template #footer>
        @if (!conteoGuardado()) {
          <p-button label="Cancelar" size="small" severity="secondary" [text]="true" (onClick)="cerrarConteo()"></p-button>
          <p-button label="Guardar conteo" icon="pi pi-lock" size="small" [disabled]="guardandoConteo() || !hayPiezas()"
                    [loading]="guardandoConteo()" (onClick)="guardarConteo()"></p-button>
        } @else {
          <p-button label="Listo" size="small" (onClick)="cerrarConteo()"></p-button>
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .cs-conteo-acc { display:flex; gap:var(--sp-2); align-items:center; flex-wrap:wrap; margin-top:var(--sp-2); }
    .cs-conteo-hint { color:var(--text-muted); font-size:var(--fs-sm); }
    .cs-conteo-reja { display:grid; grid-template-columns:6rem 1fr; gap:var(--sp-2) var(--sp-3); align-items:center; margin-block:var(--sp-3); }
    .cs-conteo-total { font-size:var(--fs-lg); }
    .cs-conteo-nota { width:100%; }
    .cs-mal { color:var(--bad-fg); }
    /* #9 — la consulta por contenedor necesita un contenedor declarado, o es inerte. */
    :host { display:block; min-width:0; container-type:inline-size; }
    .cs-det td { background:color-mix(in srgb, var(--text-muted) 6%, var(--card-bg)); }
    .cs-denom { width:auto; border-collapse:collapse; font-size:var(--fs-xs); }
    .cs-vinc { margin-top:var(--sp-3); display:flex; flex-direction:column; gap:var(--sp-2); }
    .cs-vinc-head { display:flex; gap:var(--sp-2); align-items:baseline; flex-wrap:wrap; }
    .cs-denom th, .cs-denom td { padding:.15rem .75rem .15rem 0; text-align:left; }
    .cs-denom .comm-num { text-align:right; }
    .cs-denom tfoot td { border-top:1px solid var(--border-color); font-weight:600; }
    .cs-rezago { margin-top:.5rem; }
    .cs-toggle { display:inline-flex; align-items:center; justify-content:center; width:1.75rem;
                 height:1.75rem; padding:0; border:0; border-radius:var(--r-sm,6px);
                 background:transparent; color:var(--text-muted); cursor:pointer; }
    .cs-toggle:hover { background:color-mix(in srgb, var(--text-muted) 12%, transparent); }
    .cs-toggle:focus-visible { outline:2px solid var(--action); outline-offset:1px; }
    .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    .cs-resumen { margin:.75rem 0; border:1px solid var(--border-color); border-radius:var(--r-md,8px); padding:.5rem .75rem; }
    .cs-resumen > summary { cursor:pointer; font-size:var(--fs-sm); font-weight:600; }
    .cs-resumen-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(20rem, 1fr)); gap:1rem; margin-top:.6rem; }
    .cs-h3 { font-size:var(--fs-sm); margin:0 0 .3rem; }
    .cs-nota { font-size:var(--fs-xs); margin:0 0 .35rem; }
    .cs-mini { font-size:var(--fs-xs); }
    .cs-err { font-size:var(--fs-xs); color:var(--bad-fg); margin:.5rem 0 0; }
    .cs-err-inline { color:var(--bad-fg); }
    .cs-descuadre { max-width:46rem; }
    .cs-latido { font-size:var(--fs-xs); color:var(--text-muted); margin:.2rem 0 .5rem; }
    .cs-latido-mal { color:var(--bad-fg); border-left:2px solid var(--bad-fg); padding-left:.5rem; }
    .cs-grano { font-size:var(--fs-xs); color:var(--text-muted); font-variant-numeric:tabular-nums; }
    .cs-grano-flojo { color:var(--warn-fg); }
    .cs-respuesta { margin:0 0 var(--sp-4); }
    /* [CGS.55] Las tarjetas: las mismas piezas que Arqueos. */
    .cs-cards { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(16rem, 1fr)); gap:var(--sp-3); }
    .cs-cards > li { min-width:0; display:flex; }
    .cs-cards app-metric-card { flex:1 1 auto; }
    :host ::ng-deep .cs-cards .mc { height:100%; }
    .cs-card-est { font-size:var(--fs-xs); color:var(--text-muted); display:flex; gap:var(--sp-1); align-items:baseline; }
    .cs-card-aviso { color:var(--warn-fg); font-weight:600; }
    .cs-card-des { list-style:none; margin:var(--sp-1) 0 0; padding:var(--sp-2) 0 0; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:2px; font-size:var(--fs-xs); color:var(--text-muted); line-height:1.35; }
    .cs-card-des li { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:var(--sp-2); align-items:baseline; }
    .cs-card-des .comm-num { color:var(--text-main); white-space:nowrap; text-align:right; }
    /* [CGS.56] La dirección del dinero en el texto del monto: verde entra, rojo sale. */
    .fin-entra, .cs-card-des .comm-num.fin-entra { color:var(--ok-soft-fg); }
    .fin-sale, .cs-card-des .comm-num.fin-sale { color:var(--bad-soft-fg); }
    .cs-card-nota { font-size:var(--fs-xs); color:var(--text-muted); line-height:1.35; }
    .cs-nowrap { white-space:nowrap; }
    .cs-th-num { text-align:right; }
    .cs-monto { white-space:nowrap; text-align:right; }
    .cs-registrar { display:inline-flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-sm); font-weight:600; color:var(--text-main); text-decoration:underline; text-underline-offset:2px; }
    .cs-registrar:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cs-aviso { font-size:var(--fs-sm); color:var(--warn-fg); margin:.4rem 0 0; }
    .cs-trabajo { margin-top:var(--sp-2); }
    .cs-barra { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-3); margin-bottom:var(--sp-2); }
    .cs-barra .cs-h2 { margin:0 var(--sp-2) 0 0; scroll-margin-top:1rem; }
    .cs-buscar { min-width:16rem; margin-left:auto; }
    .cs-universo { font-size:var(--fs-sm); margin:0 0 var(--sp-2); }
    .cs-analisis { margin-top:var(--sp-6); }
    .cs-h2 { font-size:var(--fs-h3); font-weight:600; margin:0 0 .5rem; }
    .cs-denoms { max-width:34rem; margin-top:.6rem; }
    .cs-denoms tfoot td { border-top:1px solid var(--border-color); border-bottom:0; font-weight:600; }
    .cs-hallazgos { border-left:2px solid var(--bad-fg); padding-left:.5rem; }
    .cs-hallazgos ul { margin:.25rem 0 0; padding-left:1.1rem; }
    /* #9 — la pantalla se embebe a anchos distintos según el sidebar: en angosto las dos mitades
       del resumen se apilan y la rejilla deja de competir por el ancho. */
    @container (max-width: 44rem) {
      .cs-resumen-grid { grid-template-columns:1fr; }
      .cs-buscar { margin-left:0; min-width:0; flex:1 1 100%; }
    }
  `],
})
export class FinanzasCaosComponent implements OnInit, OnDestroy {
  private svc = inject(CaosService);
  private sock = inject(CaosSocketService);
  private sockCaja = inject(CajaSocketService);
  private destroyRef = inject(DestroyRef);
  private zone = inject(NgZone);

  readonly money = money;
  readonly dmy = dmy;
  readonly limite = 500;

  from = todayMx();
  to = todayMx();
  tipo = '';

  rows = signal<FilaUI[]>([]);
  kpi = signal<CaosKpi | null>(null);
  tipos = signal<CaosTipo[]>([]);

  /** `[CG.163]` El combo sale de los tipos que la ventana TIENE. Antes eran 4 a mano, y hay 7. */
  readonly tiposOpc = computed(() => [
    { label: 'Todos', value: '' },
    ...this.tipos().map((t) => ({ label: `${t.type_label} (${t.n})`, value: String(t.type_id) })),
  ]);

  // ── Paneles plegados: cada uno con su estado y su error propio ───────────────────────────
  //
  // ⛔ `[CG.163]` Los tres se cargan AL ABRIRSE. `resumen` y `conciliacion` se pedían en cada
  // `cargar()` con el panel cerrado: el cuadre tarda ~1 s y se repetía cada 60 s por el repaso.
  resumen = signal<{ porRuta: CaosPorRuta[]; porOperador: CaosPorOperador[] } | null>(null);
  readonly resumenError = signal<string | null>(null);
  private resumenAbierto = false;

  conc = signal<CaosConciliacion | null>(null);
  readonly concError = signal<string | null>(null);
  private cuadreAbierto = false;

  readonly ingEstado = signal<CaosIngresosEstado | null>(null);
  readonly ingError = signal<string | null>(null);
  private ingAbierto = false;

  /** Filas abiertas de la rejilla. `p-table` la lee y la escribe por `dataKey`. */
  expandidas: Record<string, boolean> = {};

  /**
   * `[CG.58.5]` El latido del carril que hace esto solo. Se lee del mismo estado, no de un
   * endpoint aparte: las cifras sin saber cuándo se calcularon no responden «¿está al día?».
   *
   * ⚠️ Lee `ingEstado()` **incondicionalmente** (lo asigna antes de cualquier corte): un
   * `computed` detrás de un `&&` que corta antes de leer el signal queda sin dependencias y no
   * recalcula nunca — hay compuerta `reactividad` por eso.
   */
  readonly latido = computed(() => this.ingEstado()?.latido ?? null);
  cargando = signal(false);
  err = signal<string | null>(null);
  hasMore = signal(false);
  private firmaVista: string | null = null;

  // ── `[CGA-A.41]` Qué se ve en la tabla ───────────────────────────────────────────────────
  /** La tabla abre en el TRABAJO: lo que falta registrar en Caja General. */
  readonly vista = signal<'sin_registrar' | 'todos'>('sin_registrar');
  /** Una sola caja de búsqueda: referencia u operador (antes eran dos campos y un botón). */
  buscar = '';

  readonly vistas = computed<SegOption[]>(() => {
    const p = this.saldoResp()?.pendientes;
    return [
      { label: 'Sin registrar', value: 'sin_registrar', count: p?.medido ? p.movimientos : undefined },
      { label: 'Todos', value: 'todos' },
    ];
  });

  cambiarVista(v: string): void {
    this.vista.set(v === 'todos' ? 'todos' : 'sin_registrar');
    this.cargar();
  }

  /**
   * Estándar 1.6 — de qué universo son las filas de abajo, en una línea. Reemplaza la tira de
   * cinco cifras de flujo («Depósitos − dispensado», «Otros movimientos»…) que competía con la
   * respuesta de arriba y describía un rango que nadie eligió.
   */
  readonly universo = computed(() => {
    const k = this.kpi();
    const n = k ? Number(k.movimientos) || 0 : this.rows().length;
    if (this.vista() === 'sin_registrar') {
      // `[CGS.55]` Con la carga caída esta línea afirmaba «todavía no se ha registrado ninguno» (había 55).
      if (this.saldoError() || this.err()) return 'No se pudo leer lo que falta registrar.';
      const p = this.saldoResp()?.pendientes;
      if (!this.saldoResp()) return '';
      if (!p?.medido) return 'Sin medir: todavía no se ha registrado ningún movimiento de CAOS en Caja General.';
      return `${plural(n, 'movimiento', 'movimientos')} de la caja fuerte sin folio en Caja General desde el ${dmy(p.desde)} — `
        + 'el día en que se registró el primero; antes de esa fecha la práctica no existía.';
    }
    if (!k) return `Del ${dmy(this.from)} al ${dmy(this.to)}.`;
    return `Del ${dmy(this.from)} al ${dmy(this.to)}: ${plural(n, 'movimiento', 'movimientos')} · entró ${money(Number(k.depositos) + Number(k.dotado))}`
      + ` · salió ${money(Number(k.dispensado) + Number(k.vaciado))}`
      + (Number(k.indeterminados_n) ? ` · ${k.indeterminados_n} sin decodificar` : '');
  });

  // ── `[CGA-A.33]` El saldo de la caja fuerte ───────────────────────────────────────────────
  readonly saldoResp = signal<CaosSaldo | null>(null);
  readonly saldoError = signal<string | null>(null);
  readonly saldoCargando = signal(false);
  /** El mapa tipo → efecto llega del backend con los movimientos (una sola fuente). */
  readonly efectos = signal<Record<string, CaosTipoEfecto>>({});

  /**
   * ⭐ `[CGA-A.41]` `[CGS.55]` La respuesta, en tres tarjetas: cuánto hay, qué falta registrar y
   * si alguien lo contó. El cuadre contra los movimientos va DENTRO de la primera (es su
   * verificación, no una cuarta pregunta).
   */
  readonly tarjetas = computed<TarjetaCaos[]>(() => [this.tarjetaSaldo(), this.tarjetaPendientes(), this.tarjetaConteo()]);

  /**
   * Cuánto hay. Primero lo que dice la máquina; si todavía no reporta su contenido, el MISMO cálculo
   * que Arqueos (`/posicion`: último arqueo + depositado − dispensado) con su estado. Sólo si no hay
   * ninguno de los dos se declara «sin medir».
   */
  private tarjetaSaldo(): TarjetaCaos {
    const s = this.saldoResp();
    if (s && s.estado === 'medido' && s.saldo && s.maquina && s.cuadre && s.posteriores) {
      const { maquina: m, saldo, cuadre: c, posteriores: p } = s;
      const notas: string[] = [];
      if (m.con_miscount) notas.push('La máquina marca conteo dudoso en algún casete.');
      if (saldo.parcial) notas.push(`Después de la lectura hay movimientos sin decodificar: ${p.ambiguos.join(' · ')}`);
      const cuadre = !c.pares ? 'sin segunda lectura para cuadrar'
        : c.descuadres.length ? plural(c.descuadres.length, 'descuadre con sus movimientos', 'descuadres con sus movimientos')
        : `cuadra con sus movimientos (${c.cuadran} de ${c.pares})`;
      return {
        clave: 'saldo', label: 'En la caja fuerte', valor: money(saldo.total),
        estado: `según la máquina · ${this.horaMx(saldo.origen === 'maquina' ? m.confirmada_at : m.tomada_at)}`,
        desglose: [
          ...(saldo.origen === 'maquina' ? [] : [{ monto: null, texto: `lectura + ${plural(p.movimientos, 'movimiento', 'movimientos')} después` }]),
          { monto: null, texto: cuadre },
        ],
        nota: notas.length ? notas.join(' ') : null,
        tone: c.descuadres.length ? 'bad' : (m.con_miscount || saldo.parcial) ? 'warn' : 'default',
      };
    }
    const r = this.posicion()?.rubros.find((x) => x.rubro === 'caja_fuerte');
    if (r && r.ahora.monto !== null) {
      const e = r.ahora.estado;
      return {
        clave: 'saldo', label: 'En la caja fuerte', valor: money(r.ahora.monto),
        estado: `${etiquetaPosicion(e)} · la máquina no reporta su contenido`,
        desglose: desgloseRubro(r, (n) => money(n), (iso) => this.fechaHoraMx(iso)),
        nota: e === 'parcial' || e === 'imposible' ? r.ahora.nota : null,
        tone: e === 'parcial' ? 'warn' : e === 'imposible' ? 'bad' : 'default',
      };
    }
    return {
      clave: 'saldo', label: 'En la caja fuerte', valor: 'sin medir', estado: 'sin medir', desglose: [], tone: 'default',
      nota: s?.estado === 'sin_tabla'
        ? 'La suite todavía no guarda las lecturas de «Contenidos» de la máquina: falta aplicar su migración.'
        : this.posicionError() ?? 'La máquina no reporta su contenido y no hay un arqueo del que partir.',
    };
  }

  /**
   * Qué falta registrar. La cifra es CUÁNTOS movimientos: sumar depósitos y dispensaciones daba
   * $2,487,010.00, que se leía como dinero faltante y era volumen en los dos sentidos (el neto,
   * +$25,630.00). Cada sentido va en su renglón, y el neto al final.
   */
  private tarjetaPendientes(): TarjetaCaos {
    const pe = this.saldoResp()?.pendientes;
    if (!pe?.medido) {
      return {
        clave: 'pendientes', label: 'Sin registrar en Caja General', valor: 'sin medir', estado: 'sin medir', desglose: [], tone: 'default',
        nota: this.saldoResp()
          ? 'Todavía no se registró ningún movimiento de CAOS en Caja General: no hay desde cuándo contar.'
          : 'No se pudo leer el estado de la caja fuerte.',
      };
    }
    const neto = Number(pe.depositos.monto) - Number(pe.dispensaciones.monto);
    return {
      clave: 'pendientes', label: 'Sin registrar en Caja General',
      valor: plural(pe.movimientos, 'movimiento', 'movimientos'),
      estado: `desde el ${dmy(pe.desde)}`,
      desglose: [
        { monto: `+ ${money(pe.depositos.monto)}`, texto: plural(pe.depositos.n, 'depósito', 'depósitos') },
        { monto: `− ${money(pe.dispensaciones.monto)}`, texto: plural(pe.dispensaciones.n, 'dispensación', 'dispensaciones') },
        { monto: this.firmado(neto), texto: 'neto' },
      ],
      nota: null,
      tone: pe.movimientos ? 'warn' : 'default',
    };
  }

  /** `[CGS.22]` El último conteo físico, si existe. Sin él se declara, no se pinta en cero. */
  private tarjetaConteo(): TarjetaCaos {
    const cf = this.conteoUltimo();
    if (!cf && this.conteoError()) {
      return {
        clave: 'conteo', label: 'Conteo físico', valor: 'sin medir', estado: 'no se pudo leer el último conteo', desglose: [], tone: 'default',
        nota: null,
      };
    }
    if (!cf) {
      return {
        clave: 'conteo', label: 'Conteo físico', valor: 'sin medir', estado: 'nunca se ha contado a mano', desglose: [], tone: 'default',
        nota: 'El saldo de la caja fuerte sólo lo afirma la máquina.',
      };
    }
    return {
      clave: 'conteo', label: 'Conteo físico', valor: money(cf.total),
      estado: `${dmy(cf.contado_at)} · ${cf.contado_por ?? '—'}`,
      desglose: [{
        monto: cf.diferencia === null || cf.diferencia === 0 ? null : this.firmado(cf.diferencia),
        texto: cf.diferencia === null ? 'sin lectura de la máquina contra qué compararlo'
          : cf.diferencia === 0 ? 'cuadró con la máquina' : 'contra la máquina',
      }],
      nota: null,
      tone: cf.diferencia === null || cf.diferencia === 0 ? 'default' : 'bad',
    };
  }

  // ── `[CGS.55]` Lo que hay en la caja fuerte según /posicion (el mismo cálculo que Arqueos) ──
  private ledger = inject(CashLedgerService);
  readonly posicion = signal<PosicionCajaDto | null>(null);
  readonly posicionError = signal<string | null>(null);
  cargarPosicion(): void {
    this.ledger.posicion().subscribe({
      next: (p) => { this.posicion.set(p); this.posicionError.set(null); },
      error: () => this.posicionError.set('No se pudo calcular la caja fuerte a partir del último arqueo.'),
    });
  }

  /** La dirección del movimiento en el signo del monto, con el mapa del backend. */
  signo(typeId: number): string {
    const e = this.efectoDe(typeId)?.efecto;
    return e === 'suma' ? '+ ' : e === 'resta' ? '− ' : '';
  }
  /** La máquina escribe «Deposito»: se dice con su acento. */
  tipoTexto(t: string | null | undefined): string { return (t ?? '—').replace(/^Deposito\b/, 'Depósito'); }
  /** El día de México del movimiento, para la liga a Captura. */
  diaMx(v: string | null | undefined): string { return v ? toMxDateKey(new Date(v)) : ''; }
  readonly porPagina = signal(25);

  /**
   * Estándar 2.1 — las fallas de los carriles se dicen ARRIBA y sin abrir nada. Sólo aparecen
   * cuando hay algo que decir: un aviso fijo «todo bien» sería ruido.
   */
  readonly avisos = computed<string[]>(() => {
    const l = this.saldoResp()?.latidos;
    if (!l) return [];
    const out: string[] = [];
    if (l.movimientos?.status === 'error') out.push(`El carril que trae los movimientos de la máquina está fallando desde ${l.movimientos.cuando}: lo de abajo puede estar incompleto.`);
    if (l.conteo?.status === 'error') out.push(`La lectura de «Contenidos» de la máquina está fallando desde ${l.conteo.cuando}: el saldo puede ser viejo.`);
    if (l.atribucion?.status === 'error') out.push(`La atribución de depósitos a cobros está fallando desde ${l.atribucion.cuando} (panel «¿De qué cobros es este efectivo?»).`);
    return out;
  });

  /** «Maria del Carmen Rdriguez Vera (003)» → tal cual; «Vendedor (006) - VENTAS» → «Vendedor (006)». */
  operador(u: string | null | undefined): string {
    if (!u) return '—';
    return u.replace(/\s+-\s+VENTAS$/i, '');
  }

  /** Qué casetes guardan una denominación, según la última lectura de «Contenidos» («#6, #7, #8»). */
  casetesDe(denom: number): string {
    const cs = this.saldoResp()?.maquina?.contenedores ?? [];
    const lst = cs.filter((x) => Number(x.denom) === Number(denom) && x.billetes > 0)
      .map((x) => `${x.tipo === 'bag' ? 'bolsa ' : ''}#${x.indice}${x.miscount ? ' (dudoso)' : ''}`);
    return lst.length ? lst.join(', ') : '—';
  }

  private readonly fmtHora = new Intl.DateTimeFormat('es-MX', {
    timeZone: MX_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  /** Instante → «20/10 10:04», en hora de México. */
  horaMx(v: string | null | undefined): string {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : this.fmtHora.format(d);
  }

  private readonly fmtFechaHora = new Intl.DateTimeFormat('es-MX', {
    timeZone: MX_TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  /** `[CGA-A.33]` Instante → «19/10/26 18:03» en hora de México (no el día UTC). */
  fechaHoraMx(v: string | null | undefined): string {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : this.fmtFechaHora.format(d);
  }

  /**
   * `[CGA-A.33]` La edad que declara la píldora: el latido del carril (cuándo se le preguntó a la
   * máquina por última vez) y, si no hay latido, el último movimiento sincronizado.
   */
  readonly frescura = computed(() => this.saldoResp()?.latidos?.movimientos?.al ?? this.kpi()?.datos_al ?? null);
  readonly latidoAtribucion = computed(() => this.saldoResp()?.latidos?.atribucion ?? null);

  /** El rango del selector (`p-datepicker` en modo rango). Se sincroniza con `from`/`to`. */
  rangeDates: Date[] | null = null;

  alElegirRango(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: no se consulta todavía
    this.from = toMxDateKey(a);
    this.to = toMxDateKey(b);
    this.cargar();
  }

  /** DESIGN Q.3/Q.4 — de un descuadre a sus movimientos, con el rango ya puesto. */
  verTramo(desde: string, hasta: string): void {
    const a = toMxDateKey(desde);
    const b = toMxDateKey(hasta);
    if (!a || !b) return;
    this.from = a;
    this.to = b;
    this.rangeDates = [new Date(`${a}T12:00:00`), new Date(`${b}T12:00:00`)];
    this.tipo = '';
    this.buscar = '';
    this.vista.set('todos');
    this.cargar();
    document.getElementById('cs-movimientos')?.scrollIntoView({ block: 'start' });
  }

  efectoDe(typeId: number): CaosTipoEfecto | null {
    return this.efectos()[String(typeId)] ?? null;
  }

  /**
   * @param silencioso El aviso y el repaso no borran lo que se ve si fallan: un tropiezo de 5 s no
   *   convierte las tarjetas en «sin medir». El fallo se declara sólo si no había nada.
   */
  cargarSaldo(silencioso = false): void {
    this.cargarPosicion();
    this.saldoCargando.set(true);
    this.svc.saldo().subscribe({
      next: (s) => { this.saldoResp.set(s); this.saldoError.set(null); this.saldoCargando.set(false); },
      error: (e) => {
        this.saldoCargando.set(false);
        if (silencioso && this.saldoResp()) return;
        this.saldoResp.set(null); this.saldoError.set(this.textoError(e));
      },
    });
  }

  // ── `[CGS.22]` El conteo físico ─────────────────────────────────────────────────────────
  private perms = inject(PermissionsService);
  readonly denominaciones = DENOMINACIONES_CAOS;
  readonly conteoUltimo = signal<CaosConteoFisicoDto | null>(null);
  readonly conteoAbierto = signal(false);
  readonly conteoPiezas = signal<Record<number, number>>({});
  readonly notaConteo = signal('');
  readonly guardandoConteo = signal(false);
  readonly conteoGuardado = signal<CaosConteoFisicoDto | null>(null);
  readonly errConteo = signal<string | null>(null);
  /** Lo cuenta quien supervisa (AUTORIZAR), no la caja. ⚠️ Sin permisos cargados no se ofrece. */
  readonly puedeContar = computed(() => this.perms.cargado() && this.perms.has(Permission.FINANCE_CAJA_AUTORIZAR));
  /** `[CGA-A.57]` Los vínculos son de supervisión (dirección, finanzas, tesorería). El servidor lo vuelve a exigir. */
  readonly verVinculos = computed(() => this.perms.cargado() && this.perms.has(Permission.FINANCE_CAOS_VINCULOS_VER));
  readonly totalConteo = computed(() => {
    const p = this.conteoPiezas();
    return Object.entries(p).reduce((a, [d, n]) => a + Number(d) * (Number(n) || 0), 0);
  });
  readonly hayPiezas = computed(() => Object.values(this.conteoPiezas()).some((n) => n != null && Number(n) >= 0));
  protected readonly mx = (v: unknown): string => money(Number(v ?? 0) || 0);
  protected firmado(v: number): string { return `${v < 0 ? '−' : '+'}${money(Math.abs(Number(v) || 0))}`; }
  piezasDe(d: number): number | null { return this.conteoPiezas()[d] ?? null; }
  ponerPiezas(d: number, n: number | null): void {
    const p = { ...this.conteoPiezas() };
    if (n == null) delete p[d]; else p[d] = n;
    this.conteoPiezas.set(p);
  }
  /** `[CGS.55]` Si la lectura falla no se dice «nunca se ha contado»: se dice que no se pudo leer. */
  readonly conteoError = signal(false);
  cargarConteoUltimo(): void {
    this.svc.conteoFisicoUltimo().subscribe({
      next: (c) => { this.conteoUltimo.set(c); this.conteoError.set(false); },
      error: () => this.conteoError.set(true),
    });
  }
  abrirConteo(): void {
    this.conteoPiezas.set({}); this.notaConteo.set(''); this.conteoGuardado.set(null); this.errConteo.set(null);
    this.conteoAbierto.set(true);
  }
  cerrarConteo(): void { if (!this.guardandoConteo()) this.conteoAbierto.set(false); }
  guardarConteo(): void {
    if (this.guardandoConteo() || !this.hayPiezas()) return;
    this.guardandoConteo.set(true); this.errConteo.set(null);
    const piezas = this.denominaciones.map((d) => ({ denominacion: d, piezas: Number(this.conteoPiezas()[d] ?? 0) }));
    this.svc.registrarConteoFisico(piezas, this.notaConteo().trim()).subscribe({
      next: (g) => { this.guardandoConteo.set(false); this.conteoGuardado.set(g); this.conteoUltimo.set(g); },
      error: (e) => {
        this.guardandoConteo.set(false);
        const m = e?.error?.message;
        this.errConteo.set(Array.isArray(m) ? m.join(' ') : (m || 'No se pudo guardar el conteo.'));
      },
    });
  }

  ngOnInit(): void {
    this.cargarConteoUltimo();
    // `[CG.163]` El día de negocio es México. `toISOString()` daba el día en UTC mientras `to`
    // usaba `todayMx()`, así que después de las 18:00 la ventana por omisión se corría un día.
    this.from = toMxDateKey(new Date(Date.now() - 7 * 86400000));
    this.rangeDates = [new Date(`${this.from}T12:00:00`), new Date(`${this.to}T12:00:00`)];
    this.cargar();
    this.cargarSaldo();
    this.enVivo();
  }

  ngOnDestroy(): void { this.sock.disconnect(); this.sockCaja.disconnect(); }

  /**
   * La consulta barata: es la única que corre al entrar y en cada repaso.
   *
   * @param silencioso `[CGS.55]` El aviso y el repaso NO repintan el esqueleto ni cierran lo abierto.
   *   Medido el 2026-10-27: la tabla se recargaba 3 veces en 10 s (los avisos del feed de Kepler) y
   *   cada vez cambiaba la tabla por el esqueleto: un renglón abierto se cerraba solo a los segundos.
   *   Las filas que siguen conservan su desglose ya leído, y un fallo no borra lo que se ve.
   */
  cargar(silencioso = false): void {
    const conDatos = this.rows().length > 0;
    if (!(silencioso && conDatos)) this.cargando.set(true);
    this.svc.movimientos({
      from: this.from, to: this.to, limit: this.limite,
      estado: this.vista() === 'sin_registrar' ? 'sin_registrar' : undefined,
      tipo: this.vista() === 'todos' ? this.tipo || undefined : undefined,
      buscar: this.buscar.trim() || undefined,
    })
      .subscribe({
        next: (r) => {
          const previas = new Map(this.rows().map((x) => [x.id, x]));
          const nuevas = ((r.rows || []) as FilaUI[]).map((x) => {
            const p = previas.get(x.id);
            return p?.denom ? { ...x, denom: p.denom, denomTotal: p.denomTotal } : x;
          });
          this.rows.set(nuevas);
          this.kpi.set(r.kpi ?? null);
          this.tipos.set(r.tipos || []);
          this.efectos.set(r.efectos ?? {});
          this.hasMore.set(!!r.has_more);
          // Lo abierto sigue abierto si la fila sigue en la lista.
          const ids = new Set(nuevas.map((x) => x.id));
          this.expandidas = silencioso ? Object.fromEntries(Object.entries(this.expandidas).filter(([k]) => ids.has(k))) : {};
          this.err.set(null);
          this.cargando.set(false);
        },
        error: (e) => {
          this.cargando.set(false);
          if (silencioso && conDatos) return;
          this.rows.set([]); this.kpi.set(null);
          this.err.set(this.textoError(e));
        },
      });
    // Los paneles sólo se re-piden si están ABIERTOS: cerrados no cuestan nada.
    if (this.resumenAbierto) this.cargarResumen();
    if (this.cuadreAbierto) this.cargarCuadre();
    if (this.ingAbierto) this.cargarIngEstado();
  }

  /** Porcentaje de cobertura; `null` se declara "sin medir", nunca 0% (ADR-056). */
  pct(x: number | null): string { return x == null ? 'sin medir' : Math.round(x * 100) + '%'; }

  /**
   * `[CG.163]` Cómo se nombra una fila del panel por ruta. El grano manda: `plaza` NO se
   * convierte en una ruta, y `sin_declarar` se separa de «el carril todavía no lo vio».
   */
  etiquetaGrano(g: CaosPorRuta): string {
    if (g.ruta) return `Ruta ${g.ruta}`;
    if (g.plaza) return `Plaza ${g.plaza}`;
    if (g.grano === 'sin_clasificar') return 'sin clasificar todavía';
    return g.motivo.startsWith('es ruta vecinal') ? 'Vecinal (otro circuito)' : 'sin ruta declarada';
  }

  /** La diferencia entre el total declarado y lo que suman sus denominaciones. 0 = cuadra. */
  descuadre(r: FilaUI): number | null {
    if (r.denomTotal == null) return null;
    const dif = Number(r.denomTotal) - Number(r.total);
    return Math.abs(dif) > 0.005 ? dif : null;
  }

  /**
   * `[CG.58.2]` La primera apertura del panel dispara la carga. ⚠️ `toggle` también se emite al
   * CERRAR, así que se mira `open` — si no, cerrarlo volvería a pedir la consulta cara.
   */
  alAbrirIngresos(ev: Event): void {
    if (!(ev.target as HTMLDetailsElement)?.open || this.ingAbierto) return;
    this.ingAbierto = true;
    this.cargarIngEstado();
  }

  alAbrirResumen(ev: Event): void {
    if (!(ev.target as HTMLDetailsElement)?.open || this.resumenAbierto) return;
    this.resumenAbierto = true;
    this.cargarResumen();
  }

  alAbrirCuadre(ev: Event): void {
    if (!(ev.target as HTMLDetailsElement)?.open || this.cuadreAbierto) return;
    this.cuadreAbierto = true;
    this.cargarCuadre();
  }

  cargarIngEstado(): void {
    this.svc.ingresosEstado().subscribe({
      next: (e) => { this.ingEstado.set(e); this.ingError.set(null); },
      error: (e) => { this.ingEstado.set(null); this.ingError.set(this.textoError(e)); },
    });
  }

  /**
   * ⛔ `[CG.163]` Antes era `error: () => this.resumen.set(null)` y el panel quedaba con los
   * encabezados y cero filas: un 500 se leía igual que «no hubo movimientos». Así vivió oculto
   * el 500 de `[CG.161]`. El fallo se DECLARA, con su reintento.
   */
  cargarResumen(): void {
    this.svc.resumen({ from: this.from, to: this.to }).subscribe({
      next: (r) => {
        this.resumen.set({ porRuta: r.porRuta || [], porOperador: r.porOperador || [] });
        this.resumenError.set(null);
      },
      error: (e) => { this.resumen.set(null); this.resumenError.set(this.textoError(e)); },
    });
  }

  cargarCuadre(): void {
    this.svc.conciliacion({ from: this.from, to: this.to }).subscribe({
      next: (r) => { this.conc.set(r); this.concError.set(null); },
      error: (e) => { this.conc.set(null); this.concError.set(this.textoError(e)); },
    });
  }

  /** El detalle por denominación se pide una sola vez por fila, al expandirla. */
  alExpandir(r: FilaUI): void {
    if (this.verVinculos() && (r.type_id === 0 || r.type_id === 4) && !r.vinc) this.cargarVinculos(r);
    if (r.denom) return;
    r.denomError = null;
    this.svc.detalle(r.id).subscribe({
      next: (d) => {
        r.denom = d.denominaciones || [];
        r.denomTotal = d.denominaciones_total ?? null;
        this.rows.set([...this.rows()]);
      },
      // `[CGS.55]` Antes `r.denom = []`: un 500 se leía «Sin desglose por denominación» y, como la
      // fila ya tenía `denom`, no se volvía a pedir nunca. Se vio en vivo el 2026-10-27.
      error: (e) => { r.denomError = this.textoError(e); this.rows.set([...this.rows()]); },
    });
  }

  /** `[CGA-A.57]` Un fallo se dice y se reintenta: no se pinta «sin vínculos». */
  cargarVinculos(r: FilaUI): void {
    r.vincError = null;
    this.svc.vinculos(r.id).subscribe({
      next: (v) => { r.vinc = v; this.rows.set([...this.rows()]); },
      error: (e) => { r.vincError = this.textoError(e); this.rows.set([...this.rows()]); },
    });
  }

  private enVivo(): void {
    // El canal en vivo es un EXTRA: si no abre, queda el repaso. No puede tumbar la pantalla.
    try {
      this.sock.connect();
      this.sock.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
        const firma = e.firma ?? `${e.filas}|${e.max_id}`;
        if (firma === this.firmaVista) return;
        this.firmaVista = firma;
        this.cargar(true);
        // Un movimiento o una foto nueva cambian el saldo; el rango de abajo no lo filtra.
        this.cargarSaldo(true);
      });
      /**
       * [CGA-A.43] «Sin registrar en Caja General» baja cuando alguien registra el movimiento EN
       * CAPTURA, y eso avisa por el canal del libro, no por el de CAOS. Sin esto la cifra tardaba
       * hasta 60 s (el repaso) en reflejar un registro hecho en la otra pestaña.
       */
      this.sockCaja.connect();
      this.sockCaja.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
        // `[CGS.55]` Sólo un registro en el LIBRO cambia lo que falta registrar. Los avisos del feed
        // de Kepler llegan cada ~5 s y no mueven nada de esta pantalla.
        if (e.origen !== 'libro') return;
        this.cargarSaldo(true);
        if (this.vista() === 'sin_registrar') this.cargar(true);
      });
    } catch (e) {
      console.warn('[caos] sin avisos en vivo; queda el repaso:', e);
    }
    // Red de seguridad: NOTIFY no se persiste, un socket caído no deja rastro.
    encuestarVisible(60000, () => { this.cargar(true); this.cargarSaldo(true); }, { destroyRef: this.destroyRef, zone: this.zone });
  }

  private textoError(e: unknown): string {
    const err = e as { status?: number; error?: { message?: string } };
    if (err?.status === 0) return 'No hay conexión con el servidor.';
    return err?.error?.message || 'No se pudo cargar el reporte de la caja fuerte.';
  }
}
