import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { environment } from '../../../../../environments/environment';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import {
  veredictoConcluyente,
  type Freshness, type ArqueoDia, type ArqueosResponse, type VeredictoCorte, type ArqueoControlUltimo,
  type EstadoVerdad, type EstadoTestigo,
} from '@megadulces/contracts';
import { CaosService, type CaosSaldo } from '../../caos.service';
import { catchError, of } from 'rxjs';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { money, dmy } from '../finanzas-format';
import { forkJoin } from 'rxjs';
import { CashLedgerService, type ArqueoMovimientoDia, type CandadoCaja, type FondoSugerido, type SaldoResponse } from '../../cash-ledger.service';
import type { PosicionCajaDto, EstadoPosicion, ArqueoCajaDto, ArqueoGuardadoDto, NuevoArqueoCajaInput, TipoArqueoCaja } from '@megadulces/contracts';
import { CajaSocketService } from '../../caja-socket.service';
import { CaosSocketService } from '../../caos-socket.service';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { textoDeError, BILLETES_CAJA, MONEDAS_CAJA } from './caja-captura.util';
import { puertasRevision, MINIMO_TEXTO_REVISION, type PuertasRevision } from './caja-revision.util';

/** Un día visto por Control: sus movimientos y el arqueo que capturó. */
export interface CorteDia {
  fecha: string;
  movimientos: number;
  conteos: number;
  tickets_que_no_cuadran: number;
  tiene_corte: boolean;
  corte_folio: string | null;
  corte_hora: string | null;
  corte_observaciones?: string | null;
  corte_cuadra_ticket: boolean | null;
  total_efectivo: number | string | null;
  [k: string]: unknown;
}

/** Un movimiento del día, con su ticket por denominación. */
export interface MovimientoExpediente {
  folio: string;
  hora: string;
  capturo: string | null;
  observaciones: string | null;
  cancelado: boolean;
  naturaleza: 'conteo' | 'movimiento';
  cuadra_ticket: boolean;
  total_efectivo: number | string;
  total_cheques: number | string;
  total_tarjeta: number | string;
  total_papeles: number | string;
  dolares_usd: number | string;
  tipo_cambio: number | string | null;
  total_dolares: number | string;
  total_declarado: number | string;
  [k: string]: unknown;
}

interface Expediente {
  fecha: string;
  rows: MovimientoExpediente[];
  resumen: {
    movimientos: number; cancelados: number; conteos: number;
    efectivo_movido: number; tickets_que_no_cuadran: number;
  };
  corte: MovimientoExpediente | null;
}

/**
 * ⭐ **Una fila por DÍA, con lo que cada fuente sepa de ese día.**
 *
 * La fusión se hace acá y no en el servidor a propósito: son dos carriles con vidas distintas
 * —el arqueo es del libro, los movimientos son del espejo de Control— y unirlos en una consulta
 * obligaría a que uno esperara al otro para pintar nada.
 */
interface DiaFila {
  fecha: string;
  /** El arqueo del libro. `null` = ese día nadie selló un corte en la Suite. */
  arqueo: ArqueoDia | null;
  /** El día según Control. `null` = Control no registró nada ese día. */
  control: CorteDia | null;
}

/** Las piezas del ticket de Control, en el orden en que se cuentan. */
const DENOMINACIONES: ReadonlyArray<{ k: string; etiqueta: string; valor: number; moneda: boolean }> = [
  { k: 'b1000', etiqueta: '$1,000', valor: 1000, moneda: false },
  { k: 'b500', etiqueta: '$500', valor: 500, moneda: false },
  { k: 'b200', etiqueta: '$200', valor: 200, moneda: false },
  { k: 'b100', etiqueta: '$100', valor: 100, moneda: false },
  { k: 'b50', etiqueta: '$50', valor: 50, moneda: false },
  { k: 'b20', etiqueta: '$20', valor: 20, moneda: false },
  { k: 'm100', etiqueta: '$100', valor: 100, moneda: true },
  { k: 'm20', etiqueta: '$20', valor: 20, moneda: true },
  { k: 'm10', etiqueta: '$10', valor: 10, moneda: true },
  { k: 'm5', etiqueta: '$5', valor: 5, moneda: true },
  { k: 'm2', etiqueta: '$2', valor: 2, moneda: true },
  { k: 'm1', etiqueta: '$1', valor: 1, moneda: true },
  { k: 'm50c', etiqueta: '50¢', valor: 0.5, moneda: true },
  { k: 'm20c', etiqueta: '20¢', valor: 0.2, moneda: true },
  { k: 'm10c', etiqueta: '10¢', valor: 0.1, moneda: true },
  { k: 'm5c', etiqueta: '5¢', valor: 0.05, moneda: true },
  { k: 'centavos', etiqueta: '1¢', valor: 0.01, moneda: true },
];

const n = (v: unknown): number => Number(v ?? 0) || 0;

/** Cómo se dice cada veredicto, y con qué severidad. El texto no se inventa en el template. */
const VEREDICTO: Record<VeredictoCorte, { texto: string; sev: 'success' | 'warn' | 'danger' | 'info' }> = {
  cuadra: { texto: 'Cuadra al centavo', sev: 'success' },
  sobra: { texto: 'Sobra efectivo', sev: 'warn' },
  falta: { texto: 'Falta efectivo', sev: 'danger' },
  sin_contar: { texto: 'Nadie contó', sev: 'warn' },
  sin_base: { texto: 'Sin fondo medido', sev: 'warn' },
  sin_medir: { texto: 'Sin veredicto guardado', sev: 'warn' },
  esperado_imposible: { texto: 'No se puede arquear', sev: 'danger' },
};

/**
 * ⭐⭐ `[CGS.2]` — **Arqueos de Caja General: lo contado contra lo que el sistema dice.**
 *
 * ## ⛔ Las DOS correcciones de Edgar que hicieron esta pantalla, el 2026-10-20
 *
 * **1. Contra qué se arquea.** Mi primera versión cruzaba el corte de la Suite contra el arqueo
 * del Access `Control`. *«No se compara contra Control; el arqueo se compara contra lo que dice
 * el sistema, contra la fórmula que arroja lo real»*. Y es de fondo: cruzar dos sistemas es una
 * **conciliación** —*¿los dos contaron lo mismo?*—; el arqueo pregunta *¿está en el cajón lo que
 * el libro dice que debería estar?*, y eso tiene un solo contendiente. Control queda de **segundo
 * testigo**.
 *
 * **2. Expediente y Arqueos son lo mismo.** *«Hay que fusionarlos»*. Eran dos pantallas para una
 * sola revisión: la de la mañana. Acá hay **una fila por día** y un solo cajón que contesta las
 * tres preguntas en orden — ¿cuadró?, ¿con qué cuenta?, ¿qué movimientos hubo?
 *
 * ## Los tres niveles (DESIGN Q.5), dichos en una línea
 *
 *   primario   = el veredicto del último arqueo y cuántos no se pueden responder;
 *   secundario = la fila del día, con esperado · contado · diferencia;
 *   terciario  = la cuenta término por término, el conteo pieza por pieza y los movimientos.
 *
 * ## ⛔ Lo que esta pantalla NO hace
 *
 * **No edita cifras.** El conteo sellado no se cambia: se RECUENTA en Captura, y el reconteo deja
 * rastro. Lo de Control se corrige en Control (mismo criterio que ADR-040 con ContPAQi).
 *
 * ⭐ `[CGS.24]` **Lo único que escribe es la REVISIÓN**: autorizar (con nota si hay diferencia) u
 * observar (con lo que se encontró). Ninguna de las dos mueve un número — la base lo garantiza. Antes
 * el botón vivía en Captura → «Tu jornada» → Historial plegado, y esta pantalla, que es donde se
 * revisa, contaba «sin la segunda llave» sin dejar hacer nada con eso.
 *
 * **No reescribe lo firmado.** `[CGS.36]` Cuando un testigo (Control, la máquina, el libro de hoy)
 * contradice una entrada de la cuenta, la diferencia VERDADERA se publica al lado de la sellada, con
 * el porqué; el conteo que manda es el arqueo físico, como en los reconteos de CC-3 y CC-7.
 */
@Component({
  selector: 'app-finanzas-caja-arqueos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, TextareaModule, SelectModule,
    DialogModule, InputNumberModule, InputTextModule,
    LoadStateComponent, SidePeekComponent, MetricStripComponent, FreshnessPillComponent,
    ContextHelpComponent, CajaTabsComponent],
  template: `
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueos de Caja General</h1>
          <p class="surf-page-sub">
            Lo que se contó en el cajón contra lo que el libro dice que debería haber, día por día.
            Cada día abre su cuenta término por término, su conteo pieza por pieza y sus movimientos.
          </p>
        </div>
        <div class="cq-actions">
          <app-context-help topic="caja-arqueos" />
          <!-- [CGS.48] Control se jubilo el 22-oct: la edad es la del ultimo arqueo completo, venga
               de la Suite o del historico de Control. 30 h, como el umbral que tenia Control. -->
          <app-freshness-pill measures="data" [since]="arqRecientes()[0]?.at ?? null" [staleAfterSec]="108000" label="Último arqueo" />
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  [loading]="cargando()" (click)="recargar()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <!-- [CGA-A.43] La pregunta de quien abre esto a medio dia no es «cuanto se conto ayer» sino
           «cuanto hay AHORA». Se compone el cierre anterior + lo de hoy, DECLARADO como provisional. -->
      <section class="cq-ahora" aria-labelledby="cq-h-ahora">
        <div class="cq-ahora-cab">
          <h2 id="cq-h-ahora" class="cq-h2">¿Qué hay en caja ahora?</h2>
          <app-freshness-pill measures="fetch" [since]="cajonAl()" [staleAfterSec]="180" label="calculado" />
        </div>
        <app-load-state [loading]="cajonCargando() && !cajonSaldo()" [error]="cajonError()" [isEmpty]="false"
                        [skeletonRows]="1" errorTitle="No se pudo calcular el cajón" (retry)="cargarCajon()">
          <!-- [CGS.35] Todo lo que hay en caja, rubro por rubro: cajon, caja fuerte, dolares, cheques y
               papeles. Lo que no se puede afirmar se dice; no entra al total como si fuera cero. -->
          <app-metric-strip [items]="posicionKpis()" ariaLabel="Lo que hay en caja" />
          @if (posicion(); as p) {
            <p-table [value]="p.rubros" size="small" dataKey="rubro" class="surf-table surf-table--plain cq-pos">
              <ng-template #header>
                <tr>
                  <th scope="col">Rubro</th>
                  <th scope="col" class="comm-num">Lo último contado</th>
                  <th scope="col" class="comm-num">Desde entonces</th>
                  <th scope="col" class="comm-num">Debería haber ahora</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td><b>{{ r.etiqueta }}</b></td>
                  <td class="comm-num">
                    @if (r.ultimo) {
                      @if (r.ultimo.usd != null) { <span class="cq-mono">USD {{ usd(r.ultimo.usd) }}</span> · }
                      {{ r.ultimo.monto === null ? 'sin medir' : mx(r.ultimo.monto) }}
                      <span class="cq-pos-sub">{{ r.ultimo.fuente }}{{ r.ultimo.at ? ' · ' + cuando(r.ultimo.at) : '' }}</span>
                    } @else { <span class="cq-dim">—</span> }
                  </td>
                  <td class="comm-num">
                    @if (r.desde) {
                      +{{ mx(r.desde.entra) }} · −{{ mx(r.desde.sale) }}
                      <span class="cq-pos-sub">{{ r.desde.detalle }}</span>
                    } @else { <span class="cq-dim">la Suite no lleva sus movimientos</span> }
                  </td>
                  <td class="comm-num">
                    @if (r.ahora.monto !== null) {
                      <b>@if (r.ahora.usd != null) { USD {{ usd(r.ahora.usd) }} · }{{ mx(r.ahora.monto) }}</b>
                    }
                    <p-tag [value]="etiquetaPosicion(r.ahora.estado)" [severity]="sevPosicion(r.ahora.estado)" styleClass="cq-tag" />
                    <span class="cq-pos-sub">{{ r.ahora.nota }}</span>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          } @else if (posicionError()) {
            <p class="cq-nota cq-mal" role="alert">{{ posicionError() }}</p>
          }
          @if (cajonNota(); as nota) { <p class="cq-nota">{{ nota }}</p> }
          <!-- [CGS.46] El arqueo completo. Control se jubilo el 22-oct (Edgar): aqui se cuentan los
               cinco rubros. El recuento de la manana lo hace otra persona, a ciegas. -->
          <div class="cq-arq">
            <div class="cq-arq-cab">
              <span class="cq-rev-label">Contar la caja</span>
              @if (corteARecontar(); as c) {
                <p-button size="small" icon="pi pi-replay" [label]="'Recontar el corte del ' + dmy(c.fecha)"
                          (onClick)="abrirArqueo('recuento', c)" />
              }
              <p-button size="small" icon="pi pi-calculator" severity="secondary" [outlined]="true"
                        label="Arqueo a media jornada" (onClick)="abrirArqueo('intermedio', null)" />
            </div>
            @if (arqRecientes().length) {
              <div class="cq-scroll">
                <table class="cq-reja">
                  <caption class="cq-reja-cap">Últimos arqueos completos. Control dejó de usarse el 22-oct: lo anterior es su histórico.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Cuándo</th><th scope="col">Quién</th>
                      <th scope="col" class="comm-num">Efectivo</th><th scope="col" class="comm-num">Caja fuerte</th>
                      <th scope="col" class="comm-num">Cheques</th><th scope="col" class="comm-num">Vales y papeles</th>
                      <th scope="col" class="comm-num">Dólares</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (x of arqRecientes(); track x.origen + x.folio) {
                      <tr>
                        <td>{{ cuando(x.at) }} <span class="cq-dim">{{ x.origen === 'control' ? 'Control ' + x.folio : (x.tipo === 'recuento' ? 'recuento' : 'media jornada') }}</span></td>
                        <td>{{ x.quien || '—' }}</td>
                        <td class="comm-num">{{ mx(x.efectivo) }}</td>
                        <td class="comm-num">@if (x.caja_fuerte === null) { <span class="cq-dim">no se contó</span> } @else { {{ mx(x.caja_fuerte) }} }</td>
                        <td class="comm-num">@if (x.cheques === null) { <span class="cq-dim">no se contó</span> } @else { {{ mx(x.cheques) }} }</td>
                        <td class="comm-num">@if (x.papeles === null) { <span class="cq-dim">no se contó</span> } @else { {{ mx(x.papeles) }} }</td>
                        <td class="comm-num">@if (x.usd === null) { <span class="cq-dim">no se contó</span> } @else { USD {{ usd(x.usd) }}@if (x.tipo_cambio !== null) { <span class="cq-pos-sub">a {{ x.tipo_cambio }}</span> } }</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
          <!-- [CGA-A.48] Lo que Control contó y está en la caja fuerte, no en el cajón. -->
          @if (controlUltimo(); as cu) {
            @if (cu.diferencia) {
              <p class="cq-nota">
                Control contó <b>{{ mx(cu.efectivo) }}</b> el {{ dmy(cu.dia) }}{{ cu.hora ? ' a las ' + cu.hora : '' }}
                ({{ cu.folio || 'sin folio' }}): {{ firmado(cu.diferencia) }} sobre el cierre del libro {{ cu.libro_folio }}.
                @if (cu.en_caos.length) {
                  De eso, <b>{{ mx(cu.en_caos_total) }}</b> coincide billete por billete con
                  @for (d of cu.en_caos; track d.id; let ultimo = $last) {
                    el depósito a la caja fuerte #{{ d.id }}{{ d.ref ? ' «' + d.ref + '»' : '' }} ({{ dmy(d.dia) }} {{ d.hora }}){{ ultimo ? '' : ', ' }}
                  }: ese dinero está en CAOS, no en el cajón de Caja General.
                  @if (cu.sin_explicar) { Quedan <b>{{ firmado(cu.sin_explicar) }}</b> que ningún depósito a la caja fuerte explica. }
                } @else {
                  Ningún depósito a la caja fuerte lo explica.
                }
              </p>
            }
          }
        </app-load-state>
      </section>

      <!-- ⭐ [CGS.24] Q.1 para la supervisora: lo PRIMERO es lo que sólo ella puede destrabar.
           Antes la pantalla contaba «sin la segunda llave» y no dejaba hacer nada con eso. -->
      @if (esRevisora()) {
        <section class="cq-revision" aria-labelledby="cq-h-rev">
          <h2 id="cq-h-rev" class="cq-h2">{{ tituloRevision() }}</h2>
          @if (porRevisar().length) {
            <p class="cq-hint">Del más viejo al más nuevo. Cada uno se autoriza, o se observa con lo que encontraste.</p>
            <ul class="cq-rev-lista">
              @for (a of porRevisar(); track a.corte_id) {
                <li>
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="abrirCorte(a)">
                    <span class="p-button-label">{{ dmy(a.fecha) }} · {{ a.folio }}</span>
                  </button>
                  <p-tag [value]="tagVeredicto(a).texto" [severity]="tagVeredicto(a).sev" styleClass="cq-tag" />
                  @if (a.verdad?.estado === 'corregida') {
                    <p-tag value="Diferencia corregida" severity="danger" styleClass="cq-tag" />
                  }
                  @if (fallas(a)) { <span class="cq-dim">{{ fallas(a) }} sin cumplir</span> }
                </li>
              }
            </ul>
          }
          @if (ajenosPorRevisar()) {
            <p class="cq-nota">{{ ajenosPorRevisar() }} corte(s) más esperan revisión, pero abriste, cerraste o capturaste en ellos: los revisa otra persona.</p>
          }
          @if (observados().length) {
            <p class="cq-nota">{{ observados().length }} observado(s) esperan la respuesta de la caja.</p>
          }

          <!-- [CGS.15] La llave de emergencia: la caja no captura mientras una jornada anterior siga
               sin corte. Si hace falta pagar antes de cerrarla, se le da a OTRA persona, con motivo,
               hasta que termine el dia. -->
          @if (candado(); as k) {
            @if (k.jornada) {
              <div class="cq-llave">
                <h3 class="cq-h3">La caja está bloqueada por la jornada del {{ dmy(k.jornada) }}</h3>
                <p class="cq-hint">Lo normal es que se cierre ese corte. Si hace falta capturar antes, da una llave de emergencia: queda escrita con tu nombre y vence al terminar el día.</p>
                <label class="cq-rev-label" for="cq-llave-para">Para quién</label>
                <p-select inputId="cq-llave-para" [options]="k.pueden_recibir_llave" optionLabel="username" optionValue="id"
                          [ngModel]="llavePara()" (ngModelChange)="llavePara.set($event)" placeholder="Elige a la persona"
                          appendTo="body" [style]="{ minWidth: '16rem' }" />
                <label class="cq-rev-label" for="cq-llave-motivo">Por qué hace falta capturar sin cerrar</label>
                <textarea pTextarea id="cq-llave-motivo" rows="2" class="cq-rev-texto"
                          [ngModel]="llaveMotivo()" (ngModelChange)="llaveMotivo.set($event)"></textarea>
                <div class="cq-rev-acciones">
                  <p-button label="Dar llave hasta el fin del día" icon="pi pi-key" size="small" severity="secondary" [outlined]="true"
                            [disabled]="!puedeDarLlave() || dandoLlave()" [loading]="dandoLlave()" (onClick)="darLlave()" />
                </div>
                @if (!puedeDarLlave()) { <small class="cq-hint">{{ motivoSinLlave() }}</small> }
                @if (errLlave()) { <p class="cq-nota cq-mal" role="alert">{{ errLlave() }}</p> }
                @if (okLlave()) { <p class="cq-nota" role="status">{{ okLlave() }}</p> }
              </div>
            }
          }
        </section>
      }

      <!-- ⭐ DESIGN Q.1 — answer-first: el veredicto del ultimo arqueo, no la rejilla. -->
      @if (ultimoArqueo(); as u) {
        <section class="cq-veredicto" aria-labelledby="cq-h-ver">
          <div class="cq-ver-cab">
            <h2 id="cq-h-ver" class="cq-h2">Último arqueo · {{ dmy(u.fecha) }}</h2>
            <p-tag [value]="VEREDICTO[u.veredicto].texto" [severity]="VEREDICTO[u.veredicto].sev" styleClass="cq-tag" />
            <span class="cq-dim">{{ u.folio }}{{ u.cerro ? ' · cerró ' + u.cerro : '' }}</span>
            @if (!u.autorizado) { <p-tag value="Sin autorizar" severity="warn" styleClass="cq-tag" /> }
          </div>
          <app-metric-strip [items]="veredictoKpis()" ariaLabel="El último arqueo" />
          @for (nota of notas(); track nota) { <p class="cq-nota">{{ nota }}</p> }
        </section>
      }

      <section class="cq-block dt-scope" aria-labelledby="cq-h-dias">
        <div class="cq-bh">
          <h2 id="cq-h-dias" class="cq-h2">Día por día</h2>
          <span class="cq-hint">{{ resumen() }}</span>
        </div>

        <app-load-state [loading]="cargando() && !filas().length" [error]="error()"
                        [isEmpty]="!cargando() && !error() && !filas().length"
                        [skeletonRows]="6"
                        emptyTitle="Sin arqueos ni movimientos en el periodo"
                        emptyHint="Si está vacío, el carril que alimenta la lista dejó de llegar."
                        errorTitle="No se pudo traer el historial"
                        (retry)="recargar()" />

        @if (filas().length) {
          <p-table [value]="filas()" size="small" dataKey="fecha" [rowHover]="true"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [paginator]="filas().length > 30" [rows]="30"
                   [rowsPerPageOptions]="[30, 60, 90]"
                   [showCurrentPageReport]="true"
                   currentPageReportTemplate="{first}–{last} de {totalRecords} días"
                   selectionMode="single" [selection]="sel()" (selectionChange)="abrir($event)">
            <ng-template #header>
              <tr>
                <th scope="col">Día</th>
                <th scope="col" class="comm-num">Debería haber</th>
                <th scope="col" class="comm-num">Se contó</th>
                <th scope="col" class="comm-num">Diferencia</th>
                <th scope="col">Veredicto</th>
                <th scope="col" class="comm-num">Movs.</th>
                <th scope="col">Segunda llave</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr [pSelectableRow]="f">
                <td role="cell" data-label="Día">
                  <b>{{ dmy(f.fecha) }}</b>
                  @if (f.arqueo) { <span class="cq-dim cq-mono"> {{ f.arqueo.folio }}</span> }
                </td>
                <td role="cell" data-label="Debería haber" class="comm-num">
                  @if (!f.arqueo) { <span class="cq-dim">sin arqueo</span> }
                  @else if (f.arqueo.esperado === null) { <span class="cq-dim">sin medir</span> }
                  @else { <span [class.cq-mal]="f.arqueo.esperado < 0">{{ mx(f.arqueo.esperado) }}</span> }
                </td>
                <td role="cell" data-label="Se contó" class="comm-num cq-strong">
                  @if (f.arqueo?.contado !== null && f.arqueo?.contado !== undefined) { {{ mx(f.arqueo.contado) }} }
                  @else { <span class="cq-dim">—</span> }
                </td>
                <td role="cell" data-label="Diferencia" class="comm-num">
                  <!-- ⛔ Con el esperado negativo la resta sale positiva SIEMPRE: pintarla como
                       cifra normal afirmaria un sobrante justo donde la cuenta esta mas rota. -->
                  <!-- [CGS.36] La que se publica es la VERDADERA cuando un testigo la corrige, con la
                       sellada al lado: la lista no repite una cifra que Control y la maquina desmienten. -->
                  @if (!f.arqueo) { <span class="cq-dim">—</span> }
                  @else {
                    @let d = difDe(f.arqueo);
                    @if (d.valor === null) { <span class="cq-dim">—</span> }
                    @else if (d.sinSentido) { <span class="cq-dim">no significa nada</span> }
                    @else if (d.valor === 0) { <span class="cq-dim">0.00</span> }
                    @else { <span class="cq-mal">{{ firmado(d.valor) }}</span> }
                    @if (d.nota) { <span class="cq-pos-sub">{{ d.nota }}</span> }
                  }
                </td>
                <td role="cell" data-label="Veredicto">
                  @if (f.arqueo) {
                    <p-tag [value]="tagVeredicto(f.arqueo).texto"
                           [severity]="tagVeredicto(f.arqueo).sev" styleClass="cq-tag" />
                  } @else {
                    <p-tag value="Sin corte en el libro" severity="warn" styleClass="cq-tag" />
                  }
                  @if (f.control?.corte_cuadra_ticket === false) {
                    <p-tag value="El ticket de Control no cuadra solo" severity="danger" styleClass="cq-tag" />
                  }
                </td>
                <td role="cell" data-label="Movs." class="comm-num">
                  @if (f.control) { {{ f.control.movimientos }} } @else { <span class="cq-dim">—</span> }
                </td>
                <td role="cell" data-label="Segunda llave">
                  @if (!f.arqueo) { <span class="cq-dim">—</span> }
                  @else if (f.arqueo.autorizado) {
                    <p-tag [value]="'Autorizó ' + (f.arqueo.autorizo || '—')" severity="success" styleClass="cq-tag" />
                  } @else if (f.arqueo.estado === 'observado') {
                    <p-tag [value]="'Observado' + (f.arqueo.observo ? ' por ' + f.arqueo.observo : '')" severity="danger" styleClass="cq-tag" />
                  } @else if (f.arqueo.respuesta) {
                    <p-tag value="Respondido: por revisar otra vez" severity="warn" styleClass="cq-tag" />
                  } @else { <p-tag value="Sin revisar" severity="warn" styleClass="cq-tag" /> }
                </td>
              </tr>
            </ng-template>
          </p-table>
        }
      </section>

      <!-- ⭐ LA FUSION: un solo cajon contesta las tres preguntas de la revision, en orden.
           Antes eran dos pantallas y habia que acordarse de ir a la otra. -->
      <app-side-peek [(open)]="peek" mode="window" [width]="1040"
                     [title]="'Arqueo del ' + (sel() ? dmy(sel()!.fecha) : '')"
                     [subtitle]="subtitulo()">
        @if (sel(); as f) {
          <div class="cq-peek">

            @if (f.arqueo; as a) {
              <!-- 0. [CGS.24] LA REVISION, primero: es lo que vino a hacer quien abre esto de mañana.
                   El resto del cajon es la evidencia para decidir. -->
              <section class="cq-rev" aria-labelledby="cq-h-rev-dia">
                <h3 id="cq-h-rev-dia" class="cq-h3">La revisión</h3>
                <!-- [CGS.12] Lo que se revisa, calculado por el servidor. Cada renglon dice su estado EN
                     PALABRAS (no solo color) y su detalle con la cifra. -->
                <ul class="cq-verif" aria-label="Lo que se revisa de este corte">
                  @for (x of a.verificacion; track x.id) {
                    <li>
                      <p-tag [value]="etiquetaVerif(x.estado)" [severity]="sevVerif(x.estado)" styleClass="cq-tag" />
                      <span class="cq-verif-q">{{ x.pregunta }}</span>
                      <span class="cq-verif-d">{{ x.detalle }}</span>
                    </li>
                  }
                </ul>
                @if (a.observacion) {
                  <p class="cq-nota">
                    Observado por {{ a.observo || '—' }}{{ a.observed_at ? ' el ' + dmy(a.observed_at) : '' }}: «{{ a.observacion }}».
                    @if (a.respuesta) { Respondió {{ a.respondio || '—' }}: «{{ a.respuesta }}». }
                    @else { La caja todavía no responde. }
                  </p>
                }
                @if (a.autorizado) {
                  <p class="cq-nota">
                    Autorizó {{ a.autorizo || '—' }}{{ a.authorized_at ? ' el ' + dmy(a.authorized_at) : '' }}.
                    @if (a.nota_autorizacion) { Nota: «{{ a.nota_autorizacion }}». }
                  </p>
                } @else if (a.estado === 'cerrado') {
                  @if (revisable(a)) {
                    <label class="cq-rev-label" for="cq-rev-texto">
                      {{ puertas(a).pideNota ? 'Nota de la autorización (obligatoria: hay diferencia) o lo que encontraste' : 'Lo que encontraste, si lo vas a observar' }}
                    </label>
                    <textarea pTextarea id="cq-rev-texto" rows="3" class="cq-rev-texto"
                              [ngModel]="textoRevision()" (ngModelChange)="textoRevision.set($event)"
                              [attr.aria-describedby]="'cq-rev-ayuda'"></textarea>
                    <div class="cq-rev-acciones">
                      <p-button label="Autorizar" icon="pi pi-check" size="small"
                                [disabled]="!puertas(a).autorizar.ok || !!revisando()"
                                [loading]="revisando() === 'autorizar'" (onClick)="autorizar(a)" />
                      <p-button label="Observar" icon="pi pi-replay" size="small" severity="secondary" [outlined]="true"
                                [disabled]="!puertas(a).observar.ok || !!revisando()"
                                [loading]="revisando() === 'observar'" (onClick)="observar(a)" />
                    </div>
                    <ul id="cq-rev-ayuda" class="cq-rev-ayuda">
                      <li>Autorizar: {{ puertas(a).autorizar.texto }}</li>
                      <li>Observar: {{ puertas(a).observar.texto }}</li>
                    </ul>
                  } @else {
                    <p class="cq-nota">{{ puertas(a).autorizar.texto }}</p>
                  }
                }
                @if (errRevision()) { <p class="cq-nota cq-mal" role="alert">{{ errRevision() }}</p> }
                @if (okRevision()) { <p class="cq-nota" role="status">{{ okRevision() }}</p> }
              </section>

              <!-- 0b. [CGS.36] LA VERDAD DE LA DIFERENCIA: antes de firmar, si la cifra es la que es.
                   Cada entrada de la cuenta contra un testigo que no tecleo la misma persona. -->
              @if (a.verdad; as v) {
                <section class="cq-rev" aria-labelledby="cq-h-verdad">
                  <h3 id="cq-h-verdad" class="cq-h3">La diferencia, contra sus testigos</h3>
                  <p class="cq-verdad-cab">
                    <p-tag [value]="etiquetaVerdad(v.estado)" [severity]="sevVerdad(v.estado)" styleClass="cq-tag" />
                    @if (v.estado === 'corregida' && v.publicada !== null && v.verdadera !== null) {
                      <span>Se publicó <s>{{ firmado(v.publicada) }}</s>; la verdadera es
                        <b class="cq-verdad-cifra">{{ firmado(v.verdadera) }}</b></span>
                    } @else if (v.publicada !== null) {
                      <b class="cq-verdad-cifra">{{ firmado(v.publicada) }}</b>
                    }
                  </p>
                  <p class="cq-nota">{{ v.resumen }}</p>
                  <!-- [CGS.51] La caja entera entre dos arqueos completos: separa el dinero que cambio de
                       rubro (vaciado de la caja fuerte, vales) del que aparecio o se fue sin registro. -->
                  @if (v.caja_entera; as ce) {
                    <p class="cq-rev-label">La caja entera: cajón, caja fuerte, cheques y vales, y dólares</p>
                    <p class="cq-verdad-cab">
                      <b class="cq-verdad-cifra" [class.cq-mal]="abs(ce.diferencia) > 0.005">{{ abs(ce.diferencia) <= 0.005 ? 'Cuadra' : firmado(ce.diferencia) }}</b>
                      <span class="cq-dim">{{ ce.desde }} → {{ ce.hasta }}</span>
                    </p>
                    <p class="cq-nota">{{ ce.detalle }}</p>
                  }
                  <ul class="cq-verif" aria-label="Los testigos de la diferencia">
                    @for (t of v.testigos; track t.id) {
                      <li>
                        <p-tag [value]="etiquetaTestigo(t.estado)" [severity]="sevTestigo(t.estado)" styleClass="cq-tag" />
                        <span class="cq-verif-q">{{ t.pregunta }}</span>
                        <span class="cq-verif-d">{{ t.detalle }}</span>
                      </li>
                    }
                  </ul>
                  @if (v.pistas.length) {
                    <p class="cq-rev-label">Pistas: lo que pasó con el dinero ese día y el libro no tiene ({{ v.pistas.length }})</p>
                    <p class="cq-hint">No se suman: Control no dice si cada paquete entró o salió. La caja dice qué fue.</p>
                    <ul class="cq-pistas">
                      @for (p of v.pistas; track $index) { <li>{{ p.detalle }}</li> }
                    </ul>
                  }
                </section>
              }

              <!-- 1. LA CUENTA: de donde sale el «deberia haber». Sin esto el total no se puede
                   investigar; con esto la pregunta pasa a ser que pierna esta mal cruzada. -->
              <section aria-labelledby="cq-h-cuenta">
                <h3 id="cq-h-cuenta" class="cq-h3">La cuenta: de dónde sale lo que debería haber</h3>
                <table class="cq-reja cq-cascada">
                  <tbody>
                    @for (t of terminos(a); track t.etiqueta) {
                      <tr [class.cq-t-cero]="t.monto === 0">
                        <td>{{ t.etiqueta }} @if (t.detalle) { <span class="cq-dim">{{ t.detalle }}</span> }</td>
                        <td class="comm-num">
                          @if (t.monto === null) { <span class="cq-dim">sin medir</span> }
                          @else { {{ t.signo }}{{ mx(abs(t.monto)) }} }
                        </td>
                      </tr>
                    }
                    <tr class="cq-t-total">
                      <td>Debería haber en el cajón</td>
                      <td class="comm-num" [class.cq-mal]="(a.esperado ?? 0) < 0">
                        {{ a.esperado === null ? 'sin medir' : mx(a.esperado) }}
                      </td>
                    </tr>
                    <tr class="cq-t-total">
                      <td>Se contó</td>
                      <td class="comm-num">{{ a.contado === null ? 'sin contar' : mx(a.contado) }}</td>
                    </tr>
                    <tr class="cq-t-total">
                      <td>Diferencia</td>
                      <td class="comm-num">
                        @if (a.diferencia === null) { <span class="cq-dim">—</span> }
                        @else if (a.veredicto === 'esperado_imposible') { <span class="cq-dim">no significa nada</span> }
                        @else { {{ firmado(a.diferencia) }} }
                      </td>
                    </tr>
                    @if (a.verdad; as v) {
                      @if (v.estado === 'corregida' && v.verdadera !== null) {
                        <tr class="cq-t-total">
                          <td>Con los testigos <span class="cq-dim">(ver «La diferencia, contra sus testigos»)</span></td>
                          <td class="comm-num"><b>{{ firmado(v.verdadera) }}</b></td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
                @for (nota of notasArqueo(a); track nota) { <p class="cq-nota">{{ nota }}</p> }
              </section>

              <!-- 2. LO QUE SE CONTO, pieza por pieza. -->
              @if (a.piezas.length) {
                <section aria-labelledby="cq-h-piezas">
                  <h3 id="cq-h-piezas" class="cq-h3">Lo que se contó, pieza por pieza</h3>
                  <table class="cq-reja">
                    <thead>
                      <tr>
                        <th scope="col">Pieza</th>
                        <th scope="col" class="comm-num">Cantidad</th>
                        <th scope="col" class="comm-num">Importe</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (p of a.piezas; track p.clave) {
                        <tr>
                          <td>{{ pieza(p.valor) }} <span class="cq-dim">{{ p.tipo }}</span></td>
                          <td class="comm-num">{{ p.piezas }}</td>
                          <td class="comm-num">{{ mx(p.importe) }}</td>
                        </tr>
                      }
                      @if (a.morralla) {
                        <tr>
                          <td>Morralla <span class="cq-dim">suelto menor a 50¢, no va por pieza</span></td>
                          <td class="comm-num cq-dim">—</td>
                          <td class="comm-num">{{ mx(a.morralla) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </section>
              }

              <!-- 3. EL SEGUNDO TESTIGO. Subordinado a proposito: no es la vara. -->
              @if (a.testigo_control; as t) {
                <section class="cq-testigo" aria-labelledby="cq-h-testigo">
                  <h3 id="cq-h-testigo" class="cq-h3">Segundo testigo: lo que contó Control</h3>
                  <p class="cq-nota">
                    Control arqueó el mismo cajón por su cuenta ({{ t.folio || 'sin folio' }}) y le dio
                    <b>{{ t.efectivo === null ? 'sin medir' : mx(t.efectivo) }}</b>.
                    @if (t.diferencia !== null && abs(t.diferencia) > 0.005) {
                      Difiere {{ firmado(t.diferencia) }} del conteo de la Suite: uno de los dos conteos está mal.
                      La diferencia verdadera de arriba se arbitra con el arqueo físico, como en los reconteos de CC-3 y CC-7.
                    } @else if (t.diferencia !== null) {
                      Coincide al centavo con el conteo de la Suite.
                    }
                  </p>
                </section>
              }
            } @else {
              <p class="cq-dim">Ese día nadie selló un corte en el libro, así que no hay arqueo que mostrar.</p>
            }

            <!-- 4. [CGS.25] LOS MOVIMIENTOS DEL LIBRO DE LA SUITE: los que el corte suma. Antes esta
                 seccion mostraba SOLO los de Control, aun para dias que ya viven en la Suite, y la
                 supervisora revisaba un libro distinto del que firmaba. -->
            <section aria-labelledby="cq-h-libro">
              <h3 id="cq-h-libro" class="cq-h3">Lo que el libro registró esa jornada</h3>
              @if (cargandoLibro()) {
                <app-load-state [loading]="true" [skeletonRows]="4" />
              } @else if (errLibro()) {
                <p class="cq-nota cq-mal" role="alert">{{ errLibro() }}</p>
              } @else if (libroDia(); as movs) {
                @if (!movs.length) {
                  <p class="cq-dim">El libro de la Suite no tiene movimientos de ese día.</p>
                } @else {
                  <table class="cq-reja">
                    <caption class="cq-reja-cap">{{ movs.length }} movimiento(s) · por la hora en que se movió el efectivo</caption>
                    <thead>
                      <tr>
                        <th scope="col">Folio</th><th scope="col">Hora</th><th scope="col">Qué</th>
                        <th scope="col" class="comm-num">Monto</th><th scope="col">Capturó</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (m of movs; track m.id) {
                        <tr [class.cq-mov-cancel]="m.estado === 'cancelado'">
                          <td class="cq-mono">{{ m.folio }}</td>
                          <td>{{ m.hora }}</td>
                          <td>
                            {{ m.tipo === 'ingreso' ? 'Entra' : m.tipo === 'gasto' ? 'Sale' : 'Depósito' }}
                            · {{ m.beneficiario || m.concepto || '—' }}
                            @if (m.documento) { <span class="cq-dim cq-mono">{{ m.documento }}</span> }
                            @if (m.estado === 'cancelado') { <p-tag value="Cancelado" severity="danger" styleClass="cq-tag" /> }
                          </td>
                          <td class="comm-num">{{ m.tipo === 'ingreso' ? '+' : '−' }}{{ mx(m.monto) }}</td>
                          <td>{{ m.quien || '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              }
            </section>

            <!-- 5. EL SEGUNDO TESTIGO: lo que registro Control ese dia. Subordinado a proposito. -->
            <section aria-labelledby="cq-h-movs">
              <h3 id="cq-h-movs" class="cq-h3">Segundo testigo: los movimientos de Control</h3>
              @if (cargandoExp()) {
                <app-load-state [loading]="true" [skeletonRows]="6" />
              } @else if (exp(); as e) {
                @if (!e.rows.length) {
                  <p class="cq-dim">Ese día no tuvo movimientos registrados en Control.</p>
                } @else {
                  <div class="cq-exp">
                    @for (m of e.rows; track m.folio) {
                      <article class="cq-mov" [class.cq-mov-cancel]="m.cancelado"
                               [class.cq-mov-conteo]="m.naturaleza === 'conteo'">
                        <header class="cq-mov-head">
                          <span class="cq-mono">{{ m.folio }}</span>
                          <span class="cq-dim">{{ hhmm(m.hora) }}</span>
                          @if (m.naturaleza === 'conteo') { <p-tag value="Conteo de la caja" severity="info" styleClass="cq-tag" /> }
                          @if (m.cancelado) { <p-tag value="Cancelado" severity="danger" styleClass="cq-tag" /> }
                          @if (!m.cuadra_ticket) { <p-tag value="El ticket no cuadra" severity="danger" styleClass="cq-tag" /> }
                          <span class="cq-mov-sp"></span>
                          <strong class="comm-num">{{ mx(m.total_declarado) }}</strong>
                        </header>
                        @if (m.observaciones) { <p class="cq-mov-obs">{{ m.observaciones }}</p> }
                        @if (piezasControl(m).length) {
                          <table class="cq-reja">
                            <caption class="cq-reja-cap">Ticket · {{ mx(m.total_efectivo) }} en efectivo</caption>
                            <thead>
                              <tr><th scope="col">Pieza</th><th scope="col" class="comm-num">Cantidad</th><th scope="col" class="comm-num">Importe</th></tr>
                            </thead>
                            <tbody>
                              @for (p of piezasControl(m); track p.k) {
                                <tr>
                                  <td>{{ p.etiqueta }} <span class="cq-dim">{{ p.moneda ? 'moneda' : 'billete' }}</span></td>
                                  <td class="comm-num">{{ p.piezas }}</td>
                                  <td class="comm-num">{{ mx(p.importe) }}</td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        }
                      </article>
                    }
                  </div>
                }
              }
            </section>
          </div>
        }
      </app-side-peek>
    </div>
    <!-- [CGS.46] El arqueo completo. Ciego en el recuento: lo que sello el corte se ve al guardar. -->
    <p-dialog [visible]="!!arqDlg()" (visibleChange)="$event ? null : cerrarArqueo()" [modal]="true"
              [style]="{ width: '42rem', maxWidth: '96vw' }" [draggable]="false" [header]="tituloArqueo()">
      @if (!arqGuardado()) {
        <p class="cq-hint">
          {{ arqDlg()?.tipo === 'recuento'
            ? 'Cuenta el cajón a ciegas y antes de mover dinero: lo que selló el corte se ve al guardar.'
            : 'Cuenta todo lo que hay en la caja en este momento.' }}
          Lo que dejes vacío queda como «no se contó»; escribe 0 si lo contaste y no hay.
        </p>
        <fieldset class="cq-arq-grupo">
          <legend>Billetes</legend>
          <div class="cq-arq-reja">
            @for (d of BILLETES; track d.key) {
              <label [for]="'cq-arq-' + d.key">{{ d.label }}</label>
              <p-inputnumber [inputId]="'cq-arq-' + d.key" [min]="0" [useGrouping]="false"
                             [ngModel]="arqPiezas()[d.key] ?? null" (ngModelChange)="ponerPieza(d.key, $event)" />
            }
          </div>
        </fieldset>
        <fieldset class="cq-arq-grupo">
          <legend>Monedas</legend>
          <div class="cq-arq-reja">
            @for (d of MONEDAS; track d.key) {
              <label [for]="'cq-arq-' + d.key">{{ d.label }}</label>
              <p-inputnumber [inputId]="'cq-arq-' + d.key" [min]="0" [useGrouping]="false"
                             [ngModel]="arqPiezas()[d.key] ?? null" (ngModelChange)="ponerPieza(d.key, $event)" />
            }
            <label for="cq-arq-morralla">Morralla (menos de 50¢)</label>
            <p-inputnumber inputId="cq-arq-morralla" mode="currency" currency="MXN" locale="es-MX" [min]="0"
                           [ngModel]="arqMorralla()" (ngModelChange)="arqMorralla.set($event)" />
          </div>
        </fieldset>
        <p class="cq-arq-total">Efectivo: <b>{{ mx(arqEfectivo()) }}</b></p>
        <fieldset class="cq-arq-grupo">
          <legend>Lo demás que hay en la caja</legend>
          <div class="cq-arq-reja">
            <label for="cq-arq-cf">Caja fuerte</label>
            <p-inputnumber inputId="cq-arq-cf" mode="currency" currency="MXN" locale="es-MX" [min]="0"
                           [ngModel]="arqCF()" (ngModelChange)="arqCF.set($event)" />
            <label for="cq-arq-cff">De dónde sale esa cifra</label>
            <p-select inputId="cq-arq-cff" [options]="FUENTES_CF" optionLabel="label" optionValue="value"
                      [ngModel]="arqCFFuente()" (ngModelChange)="arqCFFuente.set($event)" />
            <label for="cq-arq-ch">Cheques</label>
            <p-inputnumber inputId="cq-arq-ch" mode="currency" currency="MXN" locale="es-MX" [min]="0"
                           [ngModel]="arqCheques()" (ngModelChange)="arqCheques.set($event)" />
            <label for="cq-arq-pa">Vales y papeles</label>
            <p-inputnumber inputId="cq-arq-pa" mode="currency" currency="MXN" locale="es-MX" [min]="0"
                           [ngModel]="arqPapeles()" (ngModelChange)="arqPapeles.set($event)" />
          </div>
        </fieldset>
        <fieldset class="cq-arq-grupo">
          <legend>Dólares</legend>
          <div class="cq-arq-reja">
            <label for="cq-arq-usd">Dólares (USD)</label>
            <p-inputnumber inputId="cq-arq-usd" mode="decimal" [minFractionDigits]="0" [maxFractionDigits]="2" [min]="0"
                           [ngModel]="arqUsd()" (ngModelChange)="arqUsd.set($event)" />
            <label for="cq-arq-tc">Tipo de cambio</label>
            <p-inputnumber inputId="cq-arq-tc" mode="decimal" [minFractionDigits]="2" [maxFractionDigits]="4" [min]="0"
                           [ngModel]="arqTC()" (ngModelChange)="arqTC.set($event)" />
            <label for="cq-arq-tcf">De dónde salió el tipo de cambio</label>
            <input pInputText id="cq-arq-tcf" placeholder="banco, DOF, Kepler…"
                   [ngModel]="arqTCFuente()" (ngModelChange)="arqTCFuente.set($event)" />
          </div>
        </fieldset>
        <label class="cq-rev-label" for="cq-arq-nota">Nota (opcional)</label>
        <textarea pTextarea id="cq-arq-nota" rows="2" class="cq-rev-texto"
                  [ngModel]="arqNota()" (ngModelChange)="arqNota.set($event)"></textarea>
        @if (arqFalta(); as falta) { <p class="cq-nota" role="status">{{ falta }}</p> }
      } @else {
        @if (arqGuardado(); as g) {
          <p>Contaste <b>{{ mx(g.arqueo.efectivo) }}</b> en efectivo.
            @if (g.arqueo.total_mxn !== null) { Con lo demás, la caja suma <b>{{ mx(g.arqueo.total_mxn) }}</b>. }
            @else { Algún rubro quedó sin contar: no se suma un total. }
          </p>
          @if (g.contra_corte; as k) {
            <p>El corte {{ k.folio }} selló <b>{{ k.contado === null ? 'sin conteo' : mx(k.contado) }}</b>.</p>
            @if (k.diferencia !== null) {
              <p [class.cq-mal]="k.diferencia !== 0"><b>{{ k.diferencia === 0 ? 'Coincide al peso.' : 'Difiere ' + firmado(k.diferencia) + ' del conteo del corte.' }}</b></p>
            }
          }
        }
      }
      @if (arqErr()) { <p class="cq-nota cq-mal" role="alert">{{ arqErr() }}</p> }
      <ng-template #footer>
        @if (!arqGuardado()) {
          <p-button label="Cancelar" size="small" severity="secondary" [text]="true" (onClick)="cerrarArqueo()" />
          <p-button label="Guardar arqueo" icon="pi pi-lock" size="small" [disabled]="arqGuardando() || !!arqFalta()"
                    [loading]="arqGuardando()" (onClick)="guardarArqueo()" />
        } @else {
          <p-button label="Listo" size="small" (onClick)="cerrarArqueo()" />
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .cq-arq { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-3); }
    .cq-arq-cab { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cq-scroll { overflow-x:auto; min-width:0; }
    .cq-arq-grupo { border:1px solid var(--border-color); border-radius:var(--radius-md, 6px); padding:var(--sp-2) var(--sp-3); margin:0 0 var(--sp-2); }
    .cq-arq-grupo legend { font-size:var(--fs-sm); font-weight:600; padding:0 var(--sp-1); }
    .cq-arq-reja { display:grid; grid-template-columns:minmax(8rem, 14rem) 1fr; gap:var(--sp-2) var(--sp-3); align-items:center; }
    .cq-arq-total { font-size:var(--fs-lg); margin:0 0 var(--sp-2); font-variant-numeric:tabular-nums; }
    @container (max-width: 30rem) { .cq-arq-reja { grid-template-columns:1fr; } }
    :host { display: block; }

    .cq-actions { display:flex; gap:var(--sp-2); align-items:center; flex-wrap:wrap; }

    .cq-revision { margin-block:var(--sp-4); padding-block:var(--sp-3); border-block:1px solid var(--border-color); }
    .cq-rev-lista { list-style:none; margin:var(--sp-2) 0 0; padding:0; display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-4); }
    .cq-rev-lista li { display:flex; align-items:center; gap:var(--sp-2); }
    .cq-rev { display:flex; flex-direction:column; gap:var(--sp-2); padding-bottom:var(--sp-3); border-bottom:1px solid var(--border-color); }
    .cq-rev-label { font-size:var(--fs-sm); color:var(--text-main); font-weight:600; }
    .cq-rev-texto { width:100%; max-width:60ch; }
    .cq-rev-acciones { display:flex; gap:var(--sp-2); flex-wrap:wrap; }
    .cq-verif { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--sp-1); }
    .cq-verif li { display:grid; grid-template-columns:7rem minmax(10rem, 16rem) 1fr; gap:var(--sp-2); align-items:baseline; }
    .cq-verif-q { font-weight:600; color:var(--text-main); }
    .cq-verif-d { color:var(--text-muted); font-size:var(--fs-sm); }
    .cq-verdad-cab { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin:0; }
    .cq-verdad-cifra { font-size:var(--fs-lg); font-variant-numeric:tabular-nums; }
    .cq-pistas { margin:0; padding-left:var(--sp-4); font-size:var(--fs-sm); color:var(--text-main); display:flex; flex-direction:column; gap:var(--sp-1); }
    @container (max-width: 40rem) { .cq-verif li { grid-template-columns:1fr; } }
    .cq-llave { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); padding-top:var(--sp-3); border-top:1px solid var(--border-color); }
    .cq-rev-ayuda { margin:0; padding-left:var(--sp-4); font-size:var(--fs-sm); color:var(--text-muted); }

    .cq-ahora { margin-block:var(--sp-4) var(--sp-2); }
    .cq-pos { margin-top:var(--sp-3); }
    .cq-pos-sub { display:block; color:var(--text-muted); font-size:var(--fs-sm); font-weight:400; }
    .cq-ahora-cab { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-3); margin:0 0 var(--sp-2); }

    .cq-veredicto { margin-block:var(--sp-4); padding-block:var(--sp-3); border-block:1px solid var(--border-color); }
    .cq-ver-cab { display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap; margin-bottom:var(--sp-2); }
    .cq-h2 { margin:0; font-size:var(--fs-h3); font-weight:600; }
    .cq-h3 { margin:0 0 var(--sp-2); font-size:var(--fs-lg); font-weight:600; }
    .cq-nota { margin:var(--sp-2) 0 0; font-size:var(--fs-sm); color:var(--text-muted); max-width:64rem; }

    .cq-block { margin-top:var(--sp-5); }
    .cq-bh { display:flex; align-items:baseline; gap:var(--sp-3); margin-bottom:var(--sp-2); }
    .cq-bh h2 { margin:0; font-size:var(--fs-lg); }
    .cq-hint { color:var(--text-muted); font-size:var(--fs-sm); }
    .cq-dim { color:var(--text-faint); }
    .cq-strong { font-weight:var(--fw-bold, 700); }
    .cq-mono { font-family:var(--font-mono); font-size:var(--fs-sm); }
    /* El descuadre se marca con PESO, no solo con color: en Alto Contraste de Windows el color de
       texto se reemplaza y un estado que solo vive ahi desaparece. El tag de al lado lo dice con
       palabras, que es el portador real. */
    .cq-mal { font-weight:var(--fw-bold, 700); }

    .cq-peek { display:flex; flex-direction:column; gap:var(--sp-5); }
    .cq-reja { width:100%; border-collapse:collapse; }
    .cq-reja-cap { text-align:left; color:var(--text-muted); font-size:var(--fs-sm); padding-bottom:var(--sp-1); }
    .cq-reja th, .cq-reja td {
      padding:var(--sp-1) var(--sp-2); border-bottom:1px solid var(--border-color);
      font-size:var(--fs-sm); text-align:left;
    }
    .cq-reja th { color:var(--text-muted); font-weight:var(--fw-medium, 500); }
    .cq-reja .comm-num { text-align:right; font-variant-numeric:tabular-nums; }
    /* La cascada: un termino en cero sigue visible pero atenuado -- que un termino valga cero es
       informacion (no hubo depositos), y esconderlo dejaria la suma sin explicar. */
    .cq-cascada .cq-t-cero td { color:var(--text-faint); }
    .cq-cascada .cq-t-total td { font-weight:var(--fw-bold, 700); border-top:2px solid var(--border-color); }

    .cq-testigo { padding:var(--sp-3); border:1px dashed var(--border-color); border-radius:var(--r-md); }

    .cq-exp { display:flex; flex-direction:column; gap:var(--sp-4); }
    .cq-mov { border:1px solid var(--border-color); border-radius:var(--r-md); padding:var(--sp-3); }
    .cq-mov-conteo { border-color:var(--action); }
    .cq-mov-cancel { opacity:.55; }
    .cq-mov-head { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cq-mov-sp { flex:1 1 auto; }
    .cq-mov-obs { margin:var(--sp-2) 0 0; color:var(--text-muted); font-size:var(--fs-sm); }
  `],
})
export class FinanzasCajaArqueosComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly baseControl = `${environment.apiUrl}/finance/caja-control`;
  private readonly baseLibro = `${environment.apiUrl}/finance/cash-ledger`;
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly arqueos = signal<ArqueoDia[]>([]);
  readonly dias = signal<CorteDia[]>([]);
  readonly limites = signal<string[]>([]);
  /** `[CGA-A.48]` El último conteo de Control y la parte de él que está en la caja fuerte. */
  readonly controlUltimo = signal<ArqueoControlUltimo | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly frescura = signal<Freshness | null>(null);

  readonly sel = signal<DiaFila | null>(null);
  readonly peek = signal(false);
  readonly exp = signal<Expediente | null>(null);
  readonly cargandoExp = signal(false);

  protected readonly VEREDICTO = VEREDICTO;

  /**
   * El rótulo del veredicto de un arqueo, resuelto en TypeScript y no en la plantilla.
   *
   * ⛔ Antes la plantilla hacía `VEREDICTO[f.arqueo.veredicto]` directo, y eso tiraba el build:
   * el cuerpo de un `p-table` entra por `<ng-template #body let-f>`, donde `let-f` llega **sin
   * tipo** (`any`). Indexar un `Record<VeredictoCorte, …>` con un `any` es `TS7053`, y rompía la
   * compilación de `view` entera. El campo nunca falló: `ArqueoDia` del contrato sí declara
   * `veredicto`. Lo que faltaba era un lugar tipado donde resolverlo.
   */
  protected tagVeredicto(a: ArqueoDia): { texto: string; sev: 'success' | 'warn' | 'danger' | 'info' } {
    return VEREDICTO[a.veredicto];
  }

  /**
   * ⭐ `[CGS.36]` La diferencia que se publica: la VERDADERA cuando un testigo la corrige (con la
   * sellada al lado), y si sus testigos la confirman. Con el esperado negativo y sin testigos sigue
   * sin significar nada; con testigos que la respaldan, la brecha entre el libro y el dinero es real.
   */
  protected difDe(a: ArqueoDia): { valor: number | null; nota: string | null; sinSentido: boolean } {
    const v = a.verdad;
    const atestiguada = v?.estado === 'confirmada' || v?.estado === 'corregida';
    const sinSentido = a.veredicto === 'esperado_imposible' && !atestiguada;
    if (v?.estado === 'corregida' && v.verdadera !== null) {
      return { valor: v.verdadera, nota: v.publicada === null ? 'corregida' : `se publicó ${this.firmado(v.publicada)}`, sinSentido };
    }
    return { valor: a.diferencia, nota: v?.estado === 'confirmada' ? 'confirmada por los testigos' : v ? 'sin confirmar' : null, sinSentido };
  }
  protected etiquetaVerdad(e: EstadoVerdad): string {
    return ({ confirmada: 'Confirmada', corregida: 'Corregida por los testigos', sin_confirmar: 'Sin confirmar' } as const)[e];
  }
  protected sevVerdad(e: EstadoVerdad): 'success' | 'danger' | 'secondary' {
    return ({ confirmada: 'success', corregida: 'danger', sin_confirmar: 'secondary' } as const)[e];
  }
  protected etiquetaTestigo(e: EstadoTestigo): string {
    return ({ confirma: 'Confirma', contradice: 'Contradice', sin_testigo: 'Sin testigo' } as const)[e];
  }
  protected sevTestigo(e: EstadoTestigo): 'success' | 'danger' | 'secondary' {
    return ({ confirma: 'success', contradice: 'danger', sin_testigo: 'secondary' } as const)[e];
  }
  protected readonly mx = (v: unknown): string => money(Number(v ?? 0) || 0);
  protected readonly dmy = dmy;
  protected readonly abs = Math.abs;

  /** Con signo y con el menos TIPOGRÁFICO: un guion corto se confunde con un separador. */
  protected firmado(v: number): string {
    const x = Number(v) || 0;
    return `${x < 0 ? '−' : '+'}${money(Math.abs(x))}`;
  }

  protected pieza(valor: number): string {
    if (valor >= 20) return `$${valor.toLocaleString('es-MX')}`;
    if (valor >= 1) return `$${valor}`;
    return `${Math.round(valor * 100)}¢`;
  }

  /**
   * ⭐ **La fusión, en una sola lista.** Un día existe si lo conoce cualquiera de los dos carriles:
   * el libro (hubo arqueo) o Control (hubo movimientos). Quedarse con la intersección escondería
   * justo los días que importan — uno con arqueo y sin movimientos, o al revés.
   */
  readonly filas = computed<DiaFila[]>(() => {
    const porDia = new Map<string, DiaFila>();
    for (const a of this.arqueos()) {
      porDia.set(a.fecha, { fecha: a.fecha, arqueo: a, control: null });
    }
    for (const d of this.dias()) {
      const f = String(d.fecha).slice(0, 10);
      const ya = porDia.get(f);
      if (ya) ya.control = d;
      else porDia.set(f, { fecha: f, arqueo: null, control: d });
    }
    return [...porDia.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  });

  readonly ultimoArqueo = computed<ArqueoDia | null>(() => this.arqueos()[0] ?? null);

  /**
   * ⭐⭐ Los seis términos de la fórmula, en el orden en que se suman.
   *
   * ⛔ Las dos piernas de CAOS van con su signo EXPLÍCITO y con su explicación al lado: lo que la
   * máquina dispensó quedó en el cajón (suma) y lo que se depositó en ella salió del cajón
   * (resta). Sin eso, un supervisor lee «CAOS $581,830» y no puede saber de qué lado está.
   */
  terminos(a: ArqueoDia): Array<{ etiqueta: string; detalle: string | null; monto: number | null; signo: string }> {
    const sinMedir = a.fondo.origen === 'sin_medir' || a.fondo.monto === null;
    return [
      {
        etiqueta: 'Fondo inicial',
        detalle: sinMedir ? 'nadie midió con cuánto arrancó la caja' : this.origenFondo(a.fondo.origen),
        monto: a.fondo.monto, signo: '+',
      },
      { etiqueta: 'Ingresos capturados', detalle: null, monto: a.ingresos, signo: '+' },
      { etiqueta: 'Gastos', detalle: null, monto: a.gastos, signo: '−' },
      { etiqueta: 'Depósitos', detalle: null, monto: a.depositos, signo: '−' },
      {
        etiqueta: 'La caja fuerte dispensó al cajón',
        detalle: 'salió de la bóveda y quedó aquí', monto: a.caos?.dispensado ?? null, signo: '+',
      },
      {
        etiqueta: 'Se depositó en la caja fuerte',
        detalle: 'salió del cajón y se fue a la bóveda', monto: a.caos?.depositado ?? null, signo: '−',
      },
    ];
  }

  private origenFondo(o: string | null): string | null {
    if (o === 'cierre_anterior') return 'el conteo con que cerró el día anterior';
    if (o === 'contado') return 'se contó al abrir';
    return o;
  }

  readonly veredictoKpis = computed<MetricStripItem[]>(() => {
    const u = this.ultimoArqueo();
    if (!u) return [];
    const items: MetricStripItem[] = [
      {
        label: 'Debería haber', value: u.esperado === null ? 'sin medir' : money(u.esperado),
        state: u.esperado === null ? 'no_medido' : 'derivado',
        method: 'fondo + ingresos − gastos − depósitos ± la caja fuerte; no es un conteo',
        tone: (u.esperado ?? 0) < 0 ? 'bad' : 'default',
        sub: (u.esperado ?? 0) < 0 ? 'negativo: un cajón no debe dinero' : undefined,
      },
      { label: 'Se contó', value: u.contado === null ? 'sin contar' : money(u.contado), state: 'medido' },
    ];
    const d = this.difDe(u);
    if (d.sinSentido) {
      items.push({
        label: 'Diferencia', value: 'no significa nada', state: 'no_medido', tone: 'bad',
        stateNote: 'Con el esperado en negativo la resta sale positiva siempre: diría «sobra» justo donde la cuenta está más rota.',
      });
    } else if (d.valor !== null) {
      // `[CGS.36]` La verdadera cuando un testigo la corrige; `sub` dice si está confirmada.
      items.push({
        label: 'Diferencia', value: d.valor === 0 ? money(0) : this.firmado(d.valor),
        tone: d.valor === 0 ? 'ok' : 'bad', sub: d.nota ?? undefined,
      });
    }
    const sinResp = this.arqueos().filter((a) => !veredictoConcluyente(a.veredicto)).length;
    items.push({
      label: 'Arqueos sin respuesta', value: `${sinResp} de ${this.arqueos().length}`,
      tone: sinResp ? 'bad' : 'ok',
      sub: sinResp ? 'la cuenta no permite decir si cuadra' : 'todos tienen veredicto',
    });
    const sinAut = this.arqueos().filter((a) => !a.autorizado).length;
    items.push({
      label: 'Sin la segunda llave', value: sinAut, tone: sinAut ? 'warn' : 'ok',
      sub: sinAut ? 'cerrados que nadie autorizó' : 'todos autorizados',
    });
    return items;
  });

  readonly notas = computed<string[]>(() => {
    const out: string[] = [];
    const imposibles = this.arqueos().filter((a) => a.veredicto === 'esperado_imposible');
    if (imposibles.length) {
      out.push(`${imposibles.length} de ${this.arqueos().length} arqueos tienen un «debería haber» NEGATIVO, `
        + 'y un cajón no debe dinero. Mientras siga así, su diferencia no mide un sobrante: mide que '
        + 'la cuenta cruzó mal una pierna. Abrí el día para ver cuál.');
    }
    out.push(...this.limites());
    return out;
  });

  readonly resumen = computed<string>(() => {
    const f = this.filas();
    if (!f.length) return '';
    const conArqueo = f.filter((x) => x.arqueo).length;
    const cuadran = f.filter((x) => x.arqueo?.veredicto === 'cuadra').length;
    return `${f.length} días · ${conArqueo} con arqueo sellado · ${cuadran} cuadran al centavo · elige un día para ver su cuenta`;
  });

  readonly subtitulo = computed<string | null>(() => {
    const f = this.sel();
    if (!f) return null;
    const p: string[] = [];
    if (f.arqueo) p.push(VEREDICTO[f.arqueo.veredicto].texto);
    if (f.control) p.push(`${f.control.movimientos} movimiento(s)`);
    return p.join(' · ') || null;
  });

  /** Lo que ESTE arqueo no puede afirmar, con su número. */
  notasArqueo(a: ArqueoDia): string[] {
    const out: string[] = [];
    if (!a.desglose_explica && a.esperado !== null) {
      out.push('⛔ Los términos de arriba NO suman el «debería haber» que se congeló al cerrar '
        + `(${this.mx(a.esperado_recompuesto)} contra ${this.mx(a.esperado)}). `
        + 'Algo cambió después de sellar el corte: el desglose no explica esta cifra.');
    }
    if (a.veredicto === 'esperado_imposible') {
      out.push('El «debería haber» salió negativo. Casi siempre significa que una salida de efectivo '
        + 'se registró sin su entrada, o que el dinero que se fue a la caja fuerte se contó dos veces. '
        + 'No hay que ir a buscar efectivo: hay que arreglar la cuenta.');
    }
    if (a.fondo.origen === 'sin_medir' || a.fondo.monto === null) {
      out.push('Nadie midió con cuánto arrancó la caja ese día, así que el «debería haber» parte de un '
        + 'supuesto. Tampoco es un faltante.');
    }
    if (a.caos?.dotado || a.caos?.vaciado) {
      out.push(`Ese día la caja fuerte también se dotó (${this.mx(a.caos.dotado)}) y se vació `
        + `(${this.mx(a.caos.vaciado)}). Esas dos NO entran en la fórmula: entran y salen por fuera `
        + 'del cajón, y meterlas movería el arqueo por dinero que nunca pasó por aquí.');
    }
    if (a.reconteo_motivo) out.push(`Se recontó. Motivo: «${a.reconteo_motivo}».`);
    if (a.nota) out.push(`Nota del corte: «${a.nota}».`);
    return out;
  }

  // ── El cajón AHORA ────────────────────────────────────────────────────────────────────────
  private readonly cajas = inject(CashLedgerService);
  readonly cajonFondo = signal<FondoSugerido | null>(null);
  readonly cajonSaldo = signal<SaldoResponse | null>(null);
  readonly cajonCargando = signal(false);
  readonly cajonError = signal<string | null>(null);
  readonly cajonAl = signal<string | null>(null);

  /**
   * `[CGA-A.48]` La caja fuerte, leída APARTE del cajón. `null` = no se pudo leer (o el puesto no
   * tiene permiso de CAOS): se declara «sin medir», y el cajón se publica igual.
   */
  private readonly caos = inject(CaosService);
  readonly caosSaldo = signal<CaosSaldo | null>(null);

  cargarCajon(): void {
    this.cargarPosicion();
    this.cajonCargando.set(true);
    forkJoin({
      f: this.cajas.fondoSugerido('00'), s: this.cajas.saldo('00'),
      c: this.caos.saldo().pipe(catchError(() => of(null))),
    }).subscribe({
      next: ({ f, s, c }) => {
        this.cajonFondo.set(f); this.cajonSaldo.set(s); this.caosSaldo.set(c);
        this.cajonError.set(null); this.cajonCargando.set(false);
        this.cajonAl.set(new Date().toISOString());
      },
      error: () => { this.cajonError.set('No se pudo leer el saldo del libro de Caja General.'); this.cajonCargando.set(false); },
    });
  }

  // ── `[CGS.35]` Lo que hay en caja, rubro por rubro ──────────────────────────────────────
  readonly posicion = signal<PosicionCajaDto | null>(null);
  readonly posicionError = signal<string | null>(null);

  // ── `[CGS.46]` El arqueo completo (lo que contaba Control, jubilado el 2026-10-22) ──────────
  readonly BILLETES = BILLETES_CAJA;
  readonly MONEDAS = MONEDAS_CAJA;
  readonly FUENTES_CF = [
    { label: 'La pantalla de la máquina', value: 'pantalla de la máquina' },
    { label: 'Un conteo físico', value: 'conteo físico' },
  ];
  readonly arqDlg = signal<{ tipo: TipoArqueoCaja; corte: ArqueoDia | null } | null>(null);
  readonly arqPiezas = signal<Record<string, number | null>>({});
  readonly arqMorralla = signal<number | null>(null);
  readonly arqCF = signal<number | null>(null);
  readonly arqCFFuente = signal<string>('pantalla de la máquina');
  readonly arqCheques = signal<number | null>(null);
  readonly arqPapeles = signal<number | null>(null);
  readonly arqUsd = signal<number | null>(null);
  readonly arqTC = signal<number | null>(null);
  readonly arqTCFuente = signal('');
  readonly arqNota = signal('');
  readonly arqGuardando = signal(false);
  readonly arqErr = signal<string | null>(null);
  readonly arqGuardado = signal<ArqueoGuardadoDto | null>(null);
  readonly arqRecientes = signal<ArqueoCajaDto[]>([]);

  /** El corte que esta persona puede recontar: el último cerrado que no contó, ni cerró, ni capturó. */
  readonly corteARecontar = computed<ArqueoDia | null>(() => {
    const uid = this.uid() ?? '';
    return this.arqueos().find((a) => a.estado !== 'borrador' && !a.no_revisa.includes(uid)) ?? null;
  });

  readonly arqEfectivo = computed(() => {
    const p = this.arqPiezas();
    let suma = 0;
    for (const d of [...BILLETES_CAJA, ...MONEDAS_CAJA]) suma += (p[d.key] ?? 0) * d.valor;
    return Math.round((suma + (this.arqMorralla() ?? 0)) * 100) / 100;
  });

  /** Poka-yoke: lo que falta para poder guardar, en palabras. `null` = se puede guardar. */
  readonly arqFalta = computed<string | null>(() => {
    const hayPiezas = Object.values(this.arqPiezas()).some((v) => v !== null && v !== undefined) || this.arqMorralla() !== null;
    if (!hayPiezas) return 'Anota cuántas piezas contaste. Si el cajón está vacío, escribe 0 en alguna.';
    if (this.arqCF() !== null && !this.arqCFFuente()) return 'Di de dónde sale la cifra de la caja fuerte.';
    if ((this.arqUsd() ?? 0) > 0 && (!(this.arqTC() ?? 0) || !this.arqTCFuente().trim())) {
      return 'Con dólares hace falta el tipo de cambio y de dónde salió.';
    }
    return null;
  });

  readonly tituloArqueo = computed(() => {
    const d = this.arqDlg();
    if (!d) return '';
    return d.tipo === 'recuento' && d.corte ? `Recontar el corte ${d.corte.folio} (${dmy(d.corte.fecha)})` : 'Arqueo a media jornada';
  });

  ponerPieza(key: string, v: number | null): void {
    this.arqPiezas.update((p) => ({ ...p, [key]: v }));
  }

  abrirArqueo(tipo: TipoArqueoCaja, corte: ArqueoDia | null): void {
    this.arqPiezas.set({}); this.arqMorralla.set(null); this.arqCF.set(null); this.arqCFFuente.set('pantalla de la máquina');
    this.arqCheques.set(null); this.arqPapeles.set(null); this.arqUsd.set(null); this.arqTC.set(null); this.arqTCFuente.set('');
    this.arqNota.set(''); this.arqErr.set(null); this.arqGuardado.set(null);
    this.arqDlg.set({ tipo, corte });
  }

  cerrarArqueo(): void {
    this.arqDlg.set(null);
  }

  guardarArqueo(): void {
    const d = this.arqDlg();
    if (!d || this.arqGuardando() || this.arqFalta()) return;
    // Síncrono en el primer clic: el doble clic no guarda dos arqueos.
    this.arqGuardando.set(true);
    this.arqErr.set(null);
    const p = this.arqPiezas();
    const piezas = [...BILLETES_CAJA, ...MONEDAS_CAJA]
      .filter((x) => p[x.key] !== null && p[x.key] !== undefined)
      .map((x) => ({ denom_key: x.key, piezas: Number(p[x.key]) }));
    const body: NuevoArqueoCajaInput = {
      tipo: d.tipo, corte_id: d.corte?.corte_id ?? null,
      // Sólo morralla: un renglón en 0 dice que sí se contaron las piezas y no había.
      piezas: piezas.length ? piezas : [{ denom_key: BILLETES_CAJA[0].key, piezas: 0 }],
      morralla: this.arqMorralla(),
      caja_fuerte: this.arqCF(), caja_fuerte_fuente: this.arqCF() === null ? null : this.arqCFFuente(),
      cheques: this.arqCheques(), papeles: this.arqPapeles(),
      usd: this.arqUsd(), tipo_cambio: this.arqTC(), tipo_cambio_fuente: this.arqTCFuente().trim() || null,
      nota: this.arqNota().trim() || null,
    };
    this.cajas.registrarArqueoCaja(body).subscribe({
      next: (g) => { this.arqGuardando.set(false); this.arqGuardado.set(g); this.cargarArqueosCaja(); this.cargarPosicion(); },
      error: (e) => { this.arqGuardando.set(false); this.arqErr.set(textoDeError(e) || 'No se pudo guardar el arqueo.'); },
    });
  }

  cargarArqueosCaja(): void {
    this.cajas.arqueosCaja(8).subscribe({
      next: (r) => this.arqRecientes.set(r.rows),
      error: () => this.arqRecientes.set([]),
    });
  }

  cargarPosicion(): void {
    this.cargarArqueosCaja();
    this.cajas.posicion().subscribe({
      next: (p) => { this.posicion.set(p); this.posicionError.set(null); },
      error: () => this.posicionError.set('No se pudo calcular lo que hay en caja.'),
    });
  }

  /** Q.1: la cifra que se puede afirmar, y en la misma línea lo que NO entra. */
  readonly posicionKpis = computed<MetricStripItem[]>(() => {
    const p = this.posicion();
    if (!p) return [{ label: 'Lo que hay en caja', value: 'sin medir', state: 'no_medido', stateNote: 'Todavía no se calculó.' }];
    const fuera = p.rubros.filter((r) => p.total.fuera.includes(r.rubro)).map((r) => r.etiqueta.toLowerCase());
    const usd = p.rubros.find((r) => r.rubro === 'dolares')?.ahora.usd ?? null;
    const items: MetricStripItem[] = [{
      label: p.total.completo ? 'Lo que hay en caja' : 'Lo que se puede afirmar',
      value: money(p.total.monto),
      state: 'derivado',
      method: 'suma de los rubros de abajo; no es un conteo',
      sub: p.total.completo ? 'todos los rubros' : `sin ${fuera.join(', ')}`,
      tone: p.total.completo ? 'default' : 'warn',
    }];
    if (usd != null) items.push({ label: 'Dólares', value: `USD ${this.usd(usd)}`, state: 'medido', sub: 'último arqueo de Control' });
    return items;
  });

  etiquetaPosicion(e: EstadoPosicion): string {
    return ({ medido: 'Contado', derivado: 'Calculado', parcial: 'Calculado, incompleto', imposible: 'No se puede afirmar', no_medido: 'Sin medir' } as const)[e];
  }
  sevPosicion(e: EstadoPosicion): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return ({ medido: 'success', derivado: 'info', parcial: 'warn', imposible: 'danger', no_medido: 'secondary' } as const)[e];
  }
  usd(n: number): string { return Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** Instante ISO → «20/10/26 18:12» en hora de México. */
  cuando(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  readonly cajonNota = computed<string | null>(() => {
    const f = this.cajonFondo();
    const s = this.cajonSaldo();
    const partes: string[] = [];
    if (s && !s.corte_abierto && !s.saldo_oculto) {
      partes.push('Para que deje de ser provisional: Captura → «Abrir corte» y contar.');
      const ant = s.sueltos_fuera?.anteriores;
      if (ant?.movimientos) partes.push(`No incluye ${ant.movimientos} movimiento(s) sueltos de días anteriores (neto ${money(ant.neto)}).`);
    }
    if (f?.monto != null && this.ultimoArqueo()?.contado != null) {
      const dif = Math.round((Number(this.ultimoArqueo()!.contado) - Number(f.monto)) * 100) / 100;
      if (Math.abs(dif) > 0.005) {
        partes.push(`El cierre del que parte (${money(Number(f.monto))}) no coincide con el último conteo sellado `
          + `(${money(Number(this.ultimoArqueo()!.contado))}): difieren ${money(Math.abs(dif))}.`);
      }
    }
    return partes.length ? partes.join(' ') : null;
  });

  // ── `[CGS.24]` La revisión de la supervisora ─────────────────────────────────────────────
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  readonly textoRevision = signal('');
  /** Qué acción está en vuelo. Se pone SÍNCRONO en el primer clic: el doble clic no firma dos veces. */
  readonly revisando = signal<'autorizar' | 'observar' | null>(null);
  readonly errRevision = signal<string | null>(null);
  readonly okRevision = signal<string | null>(null);
  /** El folio que pidió abrir la cola de «Mi trabajo» (`?corte=`), hasta que llegan los arqueos. */
  private corteAPedir: string | null = null;

  /** ⚠️ Sin permisos cargados todavía no se pinta la sección: «no sé» no es «sí puede». */
  readonly esRevisora = computed(() => this.perms.cargado() && this.perms.has(Permission.FINANCE_CAJA_AUTORIZAR));
  private readonly uid = computed<string | null>(() => this.auth.user()?.sub ?? null);

  /** Los que ESTA persona puede revisar, del más viejo al más nuevo. */
  readonly porRevisar = computed<ArqueoDia[]>(() => {
    const uid = this.uid() ?? '';
    return this.arqueos()
      .filter((a) => a.estado === 'cerrado' && !a.no_revisa.includes(uid))
      .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  });
  /** Cerrados que esperan revisión pero en los que esta persona tuvo mano (D3): los firma otra. */
  readonly ajenosPorRevisar = computed<number>(() => {
    const uid = this.uid() ?? '';
    return this.arqueos().filter((a) => a.estado === 'cerrado' && a.no_revisa.includes(uid)).length;
  });
  readonly observados = computed<ArqueoDia[]>(() => this.arqueos().filter((a) => a.estado === 'observado'));
  readonly tituloRevision = computed<string>(() => {
    const k = this.porRevisar().length;
    if (!k) return 'No hay cortes que esperen tu revisión';
    return k === 1 ? '1 corte espera tu revisión' : `${k} cortes esperan tu revisión`;
  });

  /** `[CGS.12]` El estado de una verificación, en palabras: el color nunca va solo. */
  etiquetaVerif(e: string): string { return e === 'cumple' ? 'Cumple' : e === 'no_cumple' ? 'No cumple' : 'Sin medir'; }
  sevVerif(e: string): 'success' | 'danger' | 'secondary' { return e === 'cumple' ? 'success' : e === 'no_cumple' ? 'danger' : 'secondary'; }
  fallas(a: ArqueoDia): number { return (a.verificacion ?? []).filter((v) => v.estado === 'no_cumple').length; }

  puertas(a: ArqueoDia): PuertasRevision {
    return puertasRevision(a, this.uid(), this.esRevisora(), this.textoRevision());
  }

  /** ¿Esta persona puede revisarlo, con cualquier texto? Si no, sólo se dice por qué. */
  revisable(a: ArqueoDia): boolean {
    return puertasRevision(a, this.uid(), this.esRevisora(), 'x'.repeat(MINIMO_TEXTO_REVISION)).observar.ok;
  }

  abrirCorte(a: ArqueoDia): void {
    const f = this.filas().find((x) => x.arqueo?.corte_id === a.corte_id) ?? { fecha: a.fecha, arqueo: a, control: null };
    this.abrir(f);
  }

  autorizar(a: ArqueoDia): void {
    if (!this.puertas(a).autorizar.ok || this.revisando()) return;
    this.revisando.set('autorizar'); this.errRevision.set(null); this.okRevision.set(null);
    const nota = this.textoRevision().trim();
    this.cajas.autorizarCorte(a.corte_id, nota || undefined).subscribe({
      next: () => this.alTerminar(`${a.folio} autorizado.`),
      error: (e) => { this.revisando.set(null); this.errRevision.set(textoDeError(e)); },
    });
  }

  observar(a: ArqueoDia): void {
    if (!this.puertas(a).observar.ok || this.revisando()) return;
    this.revisando.set('observar'); this.errRevision.set(null); this.okRevision.set(null);
    this.cajas.observarCorte(a.corte_id, this.textoRevision().trim()).subscribe({
      next: () => this.alTerminar(`${a.folio} observado: la caja lo ve con tu motivo.`),
      error: (e) => { this.revisando.set(null); this.errRevision.set(textoDeError(e)); },
    });
  }

  // ── `[CGS.15]` La llave de emergencia ─────────────────────────────────────────────────
  readonly candado = signal<CandadoCaja | null>(null);
  readonly llavePara = signal<string | null>(null);
  readonly llaveMotivo = signal('');
  readonly dandoLlave = signal(false);
  readonly errLlave = signal<string | null>(null);
  readonly okLlave = signal<string | null>(null);

  readonly motivoSinLlave = computed<string>(() => {
    const para = this.llavePara();
    const motivo = this.llaveMotivo().trim();
    if (!para) return 'Elige para quién es la llave.';
    if (para === this.uid()) return 'Nadie se abre su propio candado: la llave es para otra persona.';
    if (motivo.length < MINIMO_TEXTO_REVISION) return `Escribe por qué (al menos ${MINIMO_TEXTO_REVISION} caracteres).`;
    return '';
  });
  readonly puedeDarLlave = computed<boolean>(() => this.esRevisora() && this.motivoSinLlave() === '');

  cargarCandado(): void {
    this.cajas.candado().subscribe({
      next: (c) => this.candado.set(c),
      error: () => this.candado.set(null),
    });
  }

  darLlave(): void {
    const para = this.llavePara();
    if (!para || !this.puedeDarLlave() || this.dandoLlave()) return;
    this.dandoLlave.set(true); this.errLlave.set(null); this.okLlave.set(null);
    this.cajas.darLlave(para, this.llaveMotivo().trim()).subscribe({
      next: (r) => {
        this.dandoLlave.set(false); this.llaveMotivo.set(''); this.llavePara.set(null);
        this.okLlave.set(`Llave dada a ${r.para ?? 'la persona'} hasta que termine el día.`);
        this.cargarCandado();
      },
      error: (e) => { this.dandoLlave.set(false); this.errLlave.set(textoDeError(e)); },
    });
  }

  private alTerminar(texto: string): void {
    this.revisando.set(null);
    this.textoRevision.set('');
    this.okRevision.set(texto);
    this.recargar(true);
  }

  private readonly sockCaja = inject(CajaSocketService);
  private readonly sockCaos = inject(CaosSocketService);

  ngOnInit(): void {
    this.corteAPedir = this.route.snapshot.queryParamMap.get('corte');
    this.recargar();
    this.enVivo();
  }

  ngOnDestroy(): void {
    this.sockCaja.disconnect();
    this.sockCaos.disconnect();
  }

  /**
   * Tres disparadores: aviso del LIBRO (alguien capturó), aviso de CAOS (la bóveda se movió aunque
   * nadie capture), y repaso de 60 s con la pestaña visible — un conteo nuevo de Control llega por
   * réplica y NO avisa, y un aviso perdido no deja rastro.
   */
  private enVivo(): void {
    try {
      this.sockCaja.connect();
      this.sockCaja.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarCajon());
      this.sockCaos.connect();
      this.sockCaos.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarCajon());
    } catch (e) {
      console.warn('[arqueos] sin avisos en vivo; queda el repaso:', e);
    }
    encuestarVisible(60000, () => this.recargar(true), { destroyRef: this.destroyRef, zone: this.zone });
  }

  /**
   * ⛔ Los dos carriles se piden en PARALELO y cada uno pinta lo suyo. Encadenarlos haría que el
   * arqueo —que es la respuesta de la mañana— esperara al historial de Control, que es el detalle.
   *
   * @param silencioso El repaso de 60 s no repinta el esqueleto sobre una tabla que ya tiene datos,
   *   y un fallo suyo no borra lo que se ve: se declara sólo si no había nada.
   */
  recargar(silencioso = false): void {
    this.cargarCajon();
    // Se pide siempre (pide VER): la sección que la usa ya sólo se pinta para quien autoriza, y
    // al abrir la pantalla los permisos pueden no haber llegado todavía.
    this.cargarCandado();
    const conDatos = this.filas().length > 0;
    if (!(silencioso && conDatos)) { this.cargando.set(true); this.error.set(null); }

    this.http.get<ArqueosResponse>(`${this.baseLibro}/cortes/arqueos?limit=60`).subscribe({
      next: (r) => {
        this.arqueos.set(r?.rows ?? []);
        this.limites.set(r?.limites ?? []);
        this.controlUltimo.set(r?.control_ultimo ?? null);
        this.cargando.set(false);
        this.error.set(null);
        const s = this.sel();
        if (s) {
          const fresco = (r?.rows ?? []).find((x) => x.fecha === s.fecha);
          if (fresco) this.sel.set({ ...s, arqueo: fresco });
        }
        // `[CGS.26]` La cola de «Mi trabajo» llega con `?corte=<folio>`: se abre ese día.
        if (this.corteAPedir) {
          const pedido = (r?.rows ?? []).find((x) => x.folio === this.corteAPedir);
          this.corteAPedir = null;
          if (pedido) this.abrirCorte(pedido);
        }
      },
      error: () => {
        if (!(silencioso && conDatos)) this.error.set('No se pudieron traer los arqueos.');
        this.cargando.set(false);
      },
    });

    // El historial de Control: los movimientos del día y su arqueo. Un fallo acá NO borra los
    // arqueos ni declara error de pantalla — es el detalle, no la respuesta.
    this.http.get<{ rows: CorteDia[]; frescura?: Freshness }>(`${this.baseControl}/cortes?limit=90`).subscribe({
      next: (r) => { this.dias.set(r?.rows ?? []); this.frescura.set(r?.frescura ?? null); },
      error: () => { /* el carril de Control es secundario acá; su ausencia se ve en la columna Movs. */ },
    });
  }

  abrir(f: DiaFila | null): void {
    if (!f) return;
    // Lo tecleado era para OTRO corte: no viaja al siguiente.
    if (this.sel()?.fecha !== f.fecha) {
      this.textoRevision.set(''); this.errRevision.set(null); this.okRevision.set(null);
    }
    this.sel.set(f);
    this.peek.set(true);
    this.cargarExpediente(f.fecha);
  }

  /**
   * ⚠️ `exp` se limpia ANTES de pedir: si no, mientras carga el día nuevo el cajón sigue mostrando
   * los movimientos del anterior con el título ya cambiado.
   */
  // ── `[CGS.25]` El libro de la Suite del día ──────────────────────────────────────────────
  readonly libroDia = signal<ArqueoMovimientoDia[] | null>(null);
  readonly cargandoLibro = signal(false);
  readonly errLibro = signal<string | null>(null);

  private cargarLibroDia(fecha: string): void {
    this.libroDia.set(null); this.errLibro.set(null); this.cargandoLibro.set(true);
    this.cajas.arqueoDia({ fecha: fecha.slice(0, 10), sucursal: '00' }).subscribe({
      next: (r) => {
        this.cargandoLibro.set(false);
        // `undefined` = el servidor no lo manda: se DECLARA, no se dibuja como «sin movimientos».
        if (r?.movimientos_del_dia === undefined) { this.errLibro.set('El servidor no publicó los movimientos del libro de ese día.'); return; }
        this.libroDia.set(r.movimientos_del_dia);
      },
      error: () => { this.cargandoLibro.set(false); this.errLibro.set('No se pudieron leer los movimientos del libro de ese día.'); },
    });
  }

  private cargarExpediente(fecha: string): void {
    this.cargarLibroDia(fecha);
    this.exp.set(null);
    this.cargandoExp.set(true);
    this.http.get<Expediente>(`${this.baseControl}/expediente/${fecha.slice(0, 10)}`).subscribe({
      next: (e) => { this.exp.set(e); this.cargandoExp.set(false); },
      error: () => { this.cargandoExp.set(false); },
    });
  }

  /** `1899-12-30T14:18:58` o `14:18:58` → `14:18`. Control guarda la hora con fecha centinela. */
  hhmm(v: string | null | undefined): string {
    const s = String(v ?? '');
    const m = s.match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '—';
  }

  /** Las piezas del ticket de Control que de verdad se contaron: las que vienen en cero no se pintan. */
  piezasControl(m: Record<string, unknown>): Array<{ k: string; etiqueta: string; moneda: boolean; piezas: number; importe: number }> {
    const out: Array<{ k: string; etiqueta: string; moneda: boolean; piezas: number; importe: number }> = [];
    for (const d of DENOMINACIONES) {
      const p = n(m[d.k]);
      if (p > 0) out.push({ k: d.k, etiqueta: d.etiqueta, moneda: d.moneda, piezas: p, importe: p * d.valor });
    }
    return out;
  }
}
