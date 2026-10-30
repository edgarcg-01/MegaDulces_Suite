import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
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
import { MetricCardComponent, type MetricTone as TonoTarjeta } from '../../../../shared/components/metric-card/metric-card.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import {
  veredictoConcluyente, leerCorte, type LecturaCorte,
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
import type { PosicionCajaDto, ArqueoCajaDto, ArqueoGuardadoDto, DocumentosEnCajaDto, NuevoArqueoCajaInput, ResumenApartado, SalidaDocumento, TipoArqueoCaja } from '@megadulces/contracts';
import { SALIDA_TEXTO } from '@megadulces/contracts';
import { ArqueoDocumentosComponent } from '../../components/arqueo-documentos.component';
import { CajaSocketService } from '../../caja-socket.service';
import { desgloseRubro, etiquetaPosicion, plural } from './posicion-caja.util';
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
/** `[CGS.54]` Una tarjeta de lo que hay en caja: el total o un rubro. */
interface TarjetaCaja {
  clave: string; label: string; valor: string;
  /** Con qué se midió, en palabras, y para un rubro su parte del total. */
  estado: string; pct: number | null; tone: TonoTarjeta;
  /** De qué conteo parte y qué entró y salió después, renglón por renglón. */
  desglose: Array<{ monto: string | null; texto: string }>;
  nota: string | null;
}

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
    LoadStateComponent, SidePeekComponent, MetricCardComponent, FreshnessPillComponent,
    ContextHelpComponent, CajaTabsComponent, SegmentedComponent, ArqueoDocumentosComponent],
  template: `
    <app-caja-tabs />
    <div class="surf-page in">
      <!-- [CGS.53] Edgar, 2026-10-27: «el texto carga visual». La pantalla medía 2,717 px (3.3 pantallas)
           con cinco bloques apilados que repetían el mismo corte tres veces (lista de revisión, «Último
           arqueo» y el primer renglón de la tabla) y 57 etiquetas de color. Ahora: lo que hay en caja en
           una tira, y UNA tabla de cortes con su filtro. Contar la caja va en el encabezado. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueos de Caja General</h1>
          <p class="surf-page-sub">Lo contado contra lo que el libro dice que debería haber, día por día.</p>
        </div>
        <div class="cq-actions">
          <app-context-help topic="caja-arqueos" />
          <!-- [CGS.48] Control se jubilo el 22-oct: la edad es la del ultimo arqueo completo, venga
               de la Suite o del historico de Control. 30 h, como el umbral que tenia Control. -->
          <app-freshness-pill measures="data" [since]="arqRecientes()[0]?.at ?? null" [staleAfterSec]="108000" label="Último arqueo" />
          <!-- [CGS.46] El arqueo completo. Control se jubilo el 22-oct (Edgar): aqui se cuentan los
               cinco rubros. El recuento de la manana lo hace otra persona, a ciegas. -->
          @if (corteARecontar(); as c) {
            <p-button size="small" icon="pi pi-replay" [label]="'Recontar el corte del ' + dmy(c.fecha)"
                      (onClick)="abrirArqueo('recuento', c)" />
          }
          <p-button size="small" icon="pi pi-calculator" severity="secondary" [outlined]="true"
                    label="Arqueo a media jornada" (onClick)="abrirArqueo('intermedio', null)" />
          <p-button size="small" icon="pi pi-refresh" severity="secondary" [text]="true" label="Actualizar"
                    [loading]="cargando()" (onClick)="recargar()" />
        </div>
      </header>

      <!-- [CGA-A.43] La pregunta de quien abre esto a medio dia no es «cuanto se conto ayer» sino
           «cuanto hay AHORA». [CGS.54] Edgar, 2026-10-27: «cards dinámicas de lo que hay de dinero en
           cada tipo de apartado». Una tarjeta por rubro que publique el servidor (si mañana trae otro,
           sale otra tarjeta), cada una con su cifra, con qué se midió, su parte del total y de dónde
           sale. Lo que no se puede afirmar se dice; no entra al total como cero. -->
      <section class="cq-ahora" aria-labelledby="cq-h-ahora">
        <div class="cq-ahora-cab">
          <h2 id="cq-h-ahora" class="cq-h2">¿Qué hay en caja ahora?</h2>
          <app-freshness-pill measures="fetch" [since]="cajonAl()" [staleAfterSec]="180" label="calculado" />
        </div>
        <app-load-state [loading]="cajonCargando() && !cajonSaldo()" [error]="cajonError()" [isEmpty]="false"
                        [skeletonRows]="1" errorTitle="No se pudo calcular el cajón" (retry)="cargarCajon()">
          <ul class="cq-cards" aria-label="Lo que hay en caja, por rubro">
            @for (t of tarjetasCaja(); track t.clave) {
              <li>
                <app-metric-card [label]="t.label" format="text" [valueText]="t.valor" [tone]="t.tone" [compact]="true">
                  <span class="cq-card-est" [class.cq-est-mal]="t.tone === 'bad'" [class.cq-card-aviso]="t.tone === 'warn'">
                    @if (t.tone !== 'default') { <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> }
                    {{ t.estado }}
                  </span>
                  @if (t.pct !== null) {
                    <span class="cq-card-bar" role="img" [attr.aria-label]="t.pct + ' por ciento de lo que hay en caja'">
                      <span class="cq-card-fill" [style.width.%]="t.pct"></span>
                    </span>
                  }
                  @if (t.desglose.length) {
                    <ul class="cq-card-des" [attr.aria-label]="'De dónde sale: ' + t.label">
                      @for (d of t.desglose; track $index) {
                        <li><span>{{ d.texto }}</span>@if (d.monto) { <span class="comm-num" [class.fin-entra]="d.monto.startsWith('+')" [class.fin-sale]="d.monto.startsWith('−')">{{ d.monto }}</span> }</li>
                      }
                    </ul>
                  }
                  @if (t.nota) { <span class="cq-card-de" [class.cq-est-mal]="t.tone === 'bad'">{{ t.nota }}</span> }
                </app-metric-card>
              </li>
            }
          </ul>
          @if (posicionError()) { <p class="cq-nota cq-mal" role="alert">{{ posicionError() }}</p> }
          @if (sinMovimientos(); as nota) { <p class="cq-nota">{{ nota }}</p> }
          @if (cajonNota(); as nota) { <p class="cq-nota">{{ nota }}</p> }
          @if (arqRecientes().length || controlUltimo()?.diferencia) {
            <p class="cq-nota">
              <button type="button" class="cq-link" [attr.aria-expanded]="verDesglose()" aria-controls="cq-desglose"
                      (click)="verDesglose.set(!verDesglose())">
                <i class="pi" [class.pi-chevron-down]="!verDesglose()" [class.pi-chevron-up]="verDesglose()" aria-hidden="true"></i>
                {{ verDesglose() ? 'Ocultar los últimos arqueos completos' : 'Ver los últimos arqueos completos' }}
              </button>
            </p>
          }
          @if (verDesglose()) {
            <div id="cq-desglose" class="cq-desglose">
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
          }
        </app-load-state>
      </section>

      <!-- ⭐ [CGS.53] UNA tabla de cortes. La revisión de la supervisora (CGS.24) es su filtro
           «Por revisar», del más viejo al más nuevo; el último arqueo es su primer renglón. -->
      <section class="cq-block dt-scope" aria-labelledby="cq-h-dias">
        <div class="cq-bh">
          <h2 id="cq-h-dias" class="cq-h2">Cortes</h2>
          <span class="cq-hint">{{ resumen() }}</span>
          <span class="cq-sp"></span>
          @if (filas().length) {
            <app-segmented [options]="opcionesFiltro()" [value]="filtro()" (valueChange)="filtroElegido.set($any($event))"
                           ariaLabel="Qué cortes ver" />
          }
        </div>
        @for (nota of notas(); track nota) { <p class="cq-nota">{{ nota }}</p> }
        <!-- [CGS.53] Los límites de la cuenta (lo que el método NO puede ver) son de siempre, no de hoy:
             se nombran en una línea y se abren a pedido, no ocupan cuatro renglones sobre la tabla. -->
        @if (limites().length) {
          <p class="cq-nota">
            <button type="button" class="cq-link" [attr.aria-expanded]="verLimites()" (click)="verLimites.set(!verLimites())">
              {{ verLimites() ? 'Ocultar' : 'Ver' }} {{ plural(limites().length, 'cosa que esta cuenta no puede detectar', 'cosas que esta cuenta no puede detectar') }}
            </button>
          </p>
          @if (verLimites()) {
            <ul class="cq-limites">
              @for (l of limites(); track l) { <li>{{ l }}</li> }
            </ul>
          }
        }

        <!-- [CGS.15] La llave de emergencia: la caja no captura mientras una jornada anterior siga
             sin corte. Si hace falta pagar antes de cerrarla, se le da a OTRA persona, con motivo,
             hasta que termine el dia. -->
        @if (esRevisora()) {
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
        }

        <app-load-state [loading]="cargando() && !filas().length" [error]="error()"
                        [isEmpty]="!cargando() && !error() && !filas().length"
                        [skeletonRows]="6"
                        emptyTitle="Sin arqueos ni movimientos en el periodo"
                        emptyHint="Si está vacío, el carril que alimenta la lista dejó de llegar."
                        errorTitle="No se pudo traer el historial"
                        (retry)="recargar()" />

        @if (filas().length && !filasVista().length) {
          <p class="cq-nota">{{ filtro() === 'revisar' ? 'No hay cortes que esperen tu revisión.' : 'No hay cortes en el periodo.' }}</p>
        }
        @if (filasVista().length) {
          <!-- [totalRecords] explícito: el total del paginador sale de la MISMA lista que se pinta
               (decía «de 90 días» con 93 en la lista). -->
          <p-table [value]="filasVista()" size="small" dataKey="fecha" [rowHover]="true"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack cq-cortes"
                   [paginator]="filasVista().length > 30" [rows]="30" [totalRecords]="filasVista().length"
                   [rowsPerPageOptions]="[30, 60, 90]"
                   [showCurrentPageReport]="true"
                   currentPageReportTemplate="{first}–{last} de {totalRecords} días"
                   selectionMode="single" [selection]="sel()" (selectionChange)="abrir($event)">
            <ng-template #header>
              <tr>
                <th scope="col">Día</th>
                <th scope="col">Quedó en caja</th>
                <th scope="col">Debería haber</th>
                <th scope="col">Diferencia</th>
                <th scope="col">Estado</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr [pSelectableRow]="f">
                <td role="cell" data-label="Día" class="cq-nowrap">
                  <b>{{ dmy(f.fecha) }}</b>
                  @if (f.arqueo) { <span class="cq-dim"> {{ f.arqueo.folio }}</span> }
                </td>
                <!-- [CGS.52] Primero el HECHO (el conteo fisico: lo que quedo en el cajon), despues la
                     cuenta del libro y la diferencia. Las tres salen de lectura(). Un debería haber
                     negativo no se pinta como cifra. Sólo la cifra va en letra de cifras. -->
                @if (f.arqueo) {
                  @let l = lectura(f.arqueo);
                  <td role="cell" data-label="Quedó en caja">
                    @if (l.quedo.medido) { <b class="comm-num">{{ l.quedo.texto }}</b> } @else { <span class="cq-dim">{{ l.quedo.texto }}</span> }
                  </td>
                  <td role="cell" data-label="Debería haber">
                    @if (l.deberia.medido) { <span class="comm-num">{{ l.deberia.texto }}</span> } @else { <span class="cq-dim">{{ l.deberia.texto }}</span> }
                    @if (l.deberia.sub) { <span class="cq-pos-sub">{{ l.deberia.sub }}</span> }
                  </td>
                  <td role="cell" data-label="Diferencia">
                    <!-- [CGS.36] La que se publica es la VERDADERA cuando un testigo la corrige. -->
                    <span [class.comm-num]="l.dif.tono !== 'dim'" [class.cq-strong]="l.dif.tono === 'bad'" [class.cq-dim]="l.dif.tono === 'dim'">{{ l.dif.texto }}</span>
                    @if (l.dif.sub) { <span class="cq-pos-sub">{{ l.dif.sub }}</span> }
                  </td>
                  <td role="cell" data-label="Estado">
                    @let e = estadoCorte(f);
                    <span class="cq-est" [class.cq-est-mal]="e.mal">{{ e.texto }}</span>
                    <span class="cq-pos-sub" [class.cq-est-mal]="e.revMal">{{ e.revision }}</span>
                  </td>
                } @else {
                  <td role="cell" colspan="4" class="cq-dim">
                    Sin corte en el libro de la Suite{{ f.control ? ' · ' + plural(f.control.movimientos, 'movimiento', 'movimientos') + ' en Control' : '' }}
                  </td>
                }
              </tr>
            </ng-template>
          </p-table>
        }
        @if (filtro() !== 'todo' && diasSinCorte()) {
          <p class="cq-nota">
            {{ plural(diasSinCorte(), 'día más no tiene', 'días más no tienen') }} corte en el libro de la Suite (sólo movimientos de Control):
            <button type="button" class="cq-link" (click)="filtroElegido.set('todo')">ver todos los días</button>.
          </p>
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
              <!-- 0. [CGS.53] El orden del cajón es el de la decisión: qué no cumple → la diferencia
                   contra sus testigos → la cuenta → AUTORIZAR u OBSERVAR → el detalle (piezas, libro,
                   Control). Antes la decisión iba arriba y la evidencia debajo: había que bajar a leer y
                   volver a subir a firmar. -->
              <section class="cq-rev" aria-labelledby="cq-h-rev-dia">
                <h3 id="cq-h-rev-dia" class="cq-h3">La revisión</h3>
                <!-- [CGS.12] Lo que se revisa, calculado por el servidor. Cada renglon dice su estado EN
                     PALABRAS. [CGS.53] Los que cumplen se cuentan en una línea y se abren a pedido: nueve
                     «Cumple» en verde escondían los dos renglones que importan. -->
                @let vf = verifPartida(a);
                @if (vf.cumplen) {
                  <p class="cq-hint">
                    {{ vf.cumplen }} de {{ vf.total }} cumplen.
                    <button type="button" class="cq-link" (click)="verVerifTodas.set(!verVerifTodas())">{{ verVerifTodas() ? 'Ocultar los que cumplen' : 'Verlos' }}</button>
                  </p>
                }
                <ul class="cq-verif" aria-label="Lo que se revisa de este corte">
                  @for (x of (verVerifTodas() ? a.verificacion : vf.importan); track x.id) {
                    <li>
                      <span class="cq-verif-e" [class.cq-est-mal]="x.estado === 'no_cumple'">{{ etiquetaVerif(x.estado) }}</span>
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
                    @let lc = lectura(a);
                    <tr class="cq-t-total">
                      <td>Quedó en caja <span class="cq-dim">(conteo físico)</span></td>
                      <td class="comm-num">{{ lc.quedo.texto }}</td>
                    </tr>
                    <tr class="cq-t-total">
                      <td>Diferencia</td>
                      <td class="comm-num">
                        <span [class.cq-mal]="lc.dif.tono === 'bad'" [class.cq-dim]="lc.dif.tono === 'dim'">{{ lc.dif.texto }}</span>
                        @if (lc.dif.sub) { <span class="cq-pos-sub">{{ lc.dif.sub }}</span> }
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

              <!-- 1b. [CGS.53] LA DECISION, después de la evidencia que la sostiene. -->
              <section class="cq-rev cq-decision" aria-labelledby="cq-h-decide">
                <h3 id="cq-h-decide" class="cq-h3">La decisión</h3>
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
              <!-- [CGS.53] Es el apéndice: plegado, con cuántos movimientos trae en el botón. -->
              <h3 id="cq-h-libro" class="cq-h3">
                <button type="button" class="cq-plegable" [attr.aria-expanded]="verLibro()" aria-controls="cq-libro" (click)="verLibro.set(!verLibro())">
                  <i class="pi" [class.pi-chevron-right]="!verLibro()" [class.pi-chevron-down]="verLibro()" aria-hidden="true"></i>
                  Lo que el libro registró esa jornada
                  @if (libroDia(); as movs) { <span class="cq-hint">{{ plural(movs.length, 'movimiento', 'movimientos') }}</span> }
                </button>
              </h3>
              <div id="cq-libro">
              @if (!verLibro()) {
              } @else if (cargandoLibro()) {
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
              </div>
            </section>

            <!-- 5. EL SEGUNDO TESTIGO: lo que registro Control ese dia. Subordinado a proposito. -->
            <section aria-labelledby="cq-h-movs">
              <h3 id="cq-h-movs" class="cq-h3">
                <button type="button" class="cq-plegable" [attr.aria-expanded]="verMovsCtl()" aria-controls="cq-movs-ctl" (click)="verMovsCtl.set(!verMovsCtl())">
                  <i class="pi" [class.pi-chevron-right]="!verMovsCtl()" [class.pi-chevron-down]="verMovsCtl()" aria-hidden="true"></i>
                  Segundo testigo: los movimientos de Control
                  @if (exp(); as e) { <span class="cq-hint">{{ plural(e.rows.length, 'movimiento', 'movimientos') }}</span> }
                </button>
              </h3>
              <div id="cq-movs-ctl">
              @if (!verMovsCtl()) {
              } @else if (cargandoExp()) {
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
              </div>
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
          <legend>Caja fuerte</legend>
          <div class="cq-arq-reja">
            <label for="cq-arq-cf">Lo que tiene</label>
            <p-inputnumber inputId="cq-arq-cf" mode="currency" currency="MXN" locale="es-MX" [min]="0"
                           [ngModel]="arqCF()" (ngModelChange)="arqCF.set($event)" />
            <label for="cq-arq-cff">De dónde sale esa cifra</label>
            <p-select inputId="cq-arq-cff" [options]="FUENTES_CF" optionLabel="label" optionValue="value"
                      [ngModel]="arqCFFuente()" (ngModelChange)="arqCFFuente.set($event)" />
          </div>
        </fieldset>
        <!-- [CGS.59] Cheques y papeles uno por uno: lo que habia se marca, lo nuevo se agrega, el importe se suma. -->
        <app-arqueo-documentos #arqCh tipo="cheque" [apartado]="arqDocs()?.cheques ?? null" [bloqueo]="arqDocsBloqueo()" />
        <app-arqueo-documentos #arqPa tipo="papel" [apartado]="arqDocs()?.papeles ?? null" [bloqueo]="arqDocsBloqueo()" />
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
          @for (a of resumenDocumentos(g); track a.titulo) {
            <p>{{ a.titulo }}: <b>{{ mx(a.r.total) }}</b> · {{ a.linea }}</p>
            @for (s of a.r.salieron; track $index) {
              <p class="cq-dim">Salió {{ s.texto }} ({{ mx(s.monto) }}): {{ salidaTexto(s.salida) }}{{ s.nota ? ' · ' + s.nota : '' }}</p>
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

    .cq-rev { display:flex; flex-direction:column; gap:var(--sp-2); padding-bottom:var(--sp-3); border-bottom:1px solid var(--border-color); }
    .cq-rev-label { font-size:var(--fs-sm); color:var(--text-main); font-weight:600; }
    .cq-rev-texto { width:100%; max-width:60ch; }
    .cq-rev-acciones { display:flex; gap:var(--sp-2); flex-wrap:wrap; }
    .cq-verif { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--sp-1); }
    .cq-verif li { display:grid; grid-template-columns:7rem minmax(10rem, 16rem) 1fr; gap:var(--sp-2); align-items:baseline; }
    .cq-verif-q { font-weight:600; color:var(--text-main); }
    .cq-verif-e { font-size:var(--fs-sm); color:var(--text-muted); }
    .cq-verif-d { color:var(--text-muted); font-size:var(--fs-sm); }
    .cq-verdad-cab { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); margin:0; }
    .cq-verdad-cifra { font-size:var(--fs-lg); font-variant-numeric:tabular-nums; }
    .cq-pistas { margin:0; padding-left:var(--sp-4); font-size:var(--fs-sm); color:var(--text-main); display:flex; flex-direction:column; gap:var(--sp-1); }
    @container (max-width: 40rem) { .cq-verif li { grid-template-columns:1fr; } }
    .cq-llave { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); padding-top:var(--sp-3); border-top:1px solid var(--border-color); }
    .cq-rev-ayuda { margin:0; padding-left:var(--sp-4); font-size:var(--fs-sm); color:var(--text-muted); }

    .cq-ahora { margin-block:var(--sp-4) var(--sp-2); }
    /* [CGS.54] Las tarjetas de lo que hay en caja: tantas columnas como quepan, sin scroll de lado. */
    .cq-cards { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(13rem, 1fr)); gap:var(--sp-3); }
    .cq-cards > li { min-width:0; display:flex; }
    .cq-cards app-metric-card { flex:1 1 auto; }
    :host ::ng-deep .cq-cards .mc { height:100%; }
    .cq-card-bar { display:block; height:4px; margin-top:var(--sp-1); border-radius:var(--r-pill); background:var(--border-color); overflow:hidden; }
    .cq-card-fill { display:block; height:100%; background:var(--text-muted); border-radius:inherit; }
    /* En pantalla ancha: el total a la izquierda y los rubros en UNA fila, cuantos publique el servidor. */
    @media (min-width: 80rem) { .cq-cards { grid-template-columns:minmax(15rem, 1.2fr); grid-auto-flow:column; grid-auto-columns:minmax(0, 1fr); } }
    .cq-card-est { font-size:var(--fs-xs); color:var(--text-muted); display:flex; gap:var(--sp-1); align-items:baseline; }
    .cq-card-aviso { color:var(--warn-fg); font-weight:600; }
    .cq-card-des { list-style:none; margin:var(--sp-1) 0 0; padding:var(--sp-2) 0 0; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:2px; font-size:var(--fs-xs); color:var(--text-muted); line-height:1.35; }
    .cq-card-des li { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:var(--sp-2); align-items:baseline; }
    .cq-card-des .comm-num { text-align:right; }
    .cq-card-des .comm-num { color:var(--text-main); white-space:nowrap; }
    /* [CGS.56] La dirección del dinero en el texto del monto: verde entra, rojo sale. */
    .cq-card-des .comm-num.fin-entra { color:var(--ok-soft-fg); }
    .cq-card-des .comm-num.fin-sale { color:var(--bad-soft-fg); }
    .cq-card-de { font-size:var(--fs-xs); color:var(--text-muted); line-height:1.35; }
    .cq-pos-sub { display:block; color:var(--text-muted); font-size:var(--fs-sm); font-weight:400; }
    .cq-ahora-cab { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-3); margin:0 0 var(--sp-2); }
    /* [CGS.53] Un enlace de texto, no un botón con caja: abre un desglose, no hace una acción. */
    .cq-link { all:unset; cursor:pointer; display:inline-flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-sm); color:var(--text-main); text-decoration:underline; text-underline-offset:2px; }
    .cq-link:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cq-desglose { display:flex; flex-direction:column; gap:var(--sp-2); }
    .cq-plegable { all:unset; cursor:pointer; display:inline-flex; align-items:baseline; gap:var(--sp-2); }
    .cq-plegable:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cq-limites { margin:var(--sp-1) 0 0; padding-left:var(--sp-4); font-size:var(--fs-sm); color:var(--text-muted); max-width:64rem; display:flex; flex-direction:column; gap:var(--sp-1); }
    .cq-nowrap { white-space:nowrap; }
    .cq-sp { flex:1 1 auto; }
    /* El estado en palabras; rojo SOLO lo que está mal (y en peso, por Alto Contraste). */
    .cq-est { color:var(--text-main); }
    .cq-est-mal { color:var(--bad-fg); font-weight:600; }
    .cq-decision { border-top:2px solid var(--border-color); padding-top:var(--sp-3); }

    .cq-h2 { margin:0; font-size:var(--fs-h3); font-weight:600; }
    .cq-h3 { margin:0 0 var(--sp-2); font-size:var(--fs-lg); font-weight:600; }
    .cq-nota { margin:var(--sp-2) 0 0; font-size:var(--fs-sm); color:var(--text-muted); max-width:64rem; }

    .cq-block { margin-top:var(--sp-4); }
    .cq-bh { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2) var(--sp-3); margin-bottom:var(--sp-2); }
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
    // `[CGS.52]` Un corte que declara qué no se midió lo dice con sus palabras, no como «sin veredicto».
    if (a.sin_medir_motivo) {
      return { texto: a.contado === null ? 'Sin conteo físico' : 'Sin fondo conocido', sev: 'warn' };
    }
    return VEREDICTO[a.veredicto];
  }

  /**
   * ⭐⭐ `[CGS.52]` Quedó en caja · debería haber · diferencia, dichas por separado. La regla vive en
   * `leerCorte()` de `@megadulces/contracts` porque la lista de cortes de Caja General la lee igual;
   * acá sólo se le pasa la diferencia que corrigieron los testigos (`[CGS.36]`).
   */
  protected lectura(a: ArqueoDia): LecturaCorte {
    const d = this.difDe(a);
    const atestiguada = a.verdad?.estado === 'confirmada' || a.verdad?.estado === 'corregida';
    return leerCorte(
      { contado: a.contado, esperado: a.esperado, diferencia: a.diferencia, fondo_inicial: a.fondo.monto, sin_medir_motivo: a.sin_medir_motivo },
      (n) => this.mx(n),
      { valor: d.valor, nota: d.nota, atestiguada },
    );
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

  /** `3 cortes`, `1 corte`: el número con su palabra, sin «(s)». */
  protected readonly plural = plural;

  // ── `[CGS.53]` Una sola tabla de cortes, con la revisión como filtro ─────────────────────
  readonly filtroElegido = signal<'revisar' | 'cortes' | 'todo' | null>(null);
  /** Quien autoriza y tiene pendientes entra a «Por revisar»; los demás, a los cortes. */
  readonly filtro = computed<'revisar' | 'cortes' | 'todo'>(() =>
    this.filtroElegido() ?? (this.esRevisora() && this.porRevisar().length ? 'revisar' : 'cortes'));
  readonly opcionesFiltro = computed<SegOption[]>(() => [
    ...(this.esRevisora() ? [{ label: 'Por revisar', value: 'revisar', count: this.porRevisar().length }] : []),
    { label: 'Cortes', value: 'cortes', count: this.filas().filter((f) => f.arqueo).length },
    { label: 'Todos los días', value: 'todo', count: this.filas().length },
  ]);
  readonly filasVista = computed<DiaFila[]>(() => {
    const f = this.filtro();
    if (f === 'todo') return this.filas();
    if (f === 'cortes') return this.filas().filter((x) => x.arqueo);
    // Del más viejo al más nuevo: cada corte arranca con lo que contó el anterior.
    const ids = new Set(this.porRevisar().map((a) => a.corte_id));
    return this.filas().filter((x) => x.arqueo && ids.has(x.arqueo.corte_id)).reverse();
  });
  /** Días que sólo conoce Control: no van en la tabla de cortes, pero se dicen con su número. */
  readonly diasSinCorte = computed<number>(() => this.filas().filter((x) => !x.arqueo).length);

  /**
   * El estado del corte en PALABRAS: el veredicto y la segunda llave. Rojo sólo lo que está mal
   * (falta, no se puede arquear, observado, el ticket de Control no cuadra); lo demás, sin tono.
   */
  estadoCorte(f: DiaFila): { texto: string; mal: boolean; revision: string; revMal: boolean } {
    const a = f.arqueo!;
    const v = this.tagVeredicto(a);
    const extra = [
      a.verdad?.estado === 'corregida' ? 'diferencia corregida' : '',
      f.control?.corte_cuadra_ticket === false ? 'el ticket de Control no cuadra solo' : '',
    ].filter(Boolean);
    const fallas = this.fallas(a);
    let revision: string;
    let revMal = false;
    if (a.autorizado) revision = `autorizó ${a.autorizo || '—'}`;
    else if (a.estado === 'observado') { revision = `observado${a.observo ? ' por ' + a.observo : ''}`; revMal = true; }
    else if (a.respuesta) revision = 'respondido: por revisar otra vez';
    else revision = 'sin revisar';
    if (fallas && !a.autorizado) revision += ` · ${this.plural(fallas, 'punto no cumple', 'puntos no cumplen')}`;
    return {
      texto: [v.texto, ...extra].join(' · '),
      mal: v.sev === 'danger' || extra.length > 0,
      revision, revMal,
    };
  }

  readonly notas = computed<string[]>(() => {
    const out: string[] = [];
    const imposibles = this.arqueos().filter((a) => a.veredicto === 'esperado_imposible').length;
    if (imposibles) {
      out.push(`${this.plural(imposibles, 'corte tiene', 'cortes tienen')} el «debería haber» en negativo: un cajón no debe dinero, `
        + 'así que la cuenta cruzó mal una pierna. Abre el día para ver cuál.');
    }
    const ajenos = this.ajenosPorRevisar();
    if (ajenos && this.esRevisora()) {
      out.push(`${this.plural(ajenos, 'corte más espera', 'cortes más esperan')} revisión, pero abriste, cerraste o capturaste en ellos: los revisa otra persona.`);
    }
    const obs = this.observados().length;
    if (obs) out.push(`${this.plural(obs, 'observado espera', 'observados esperan')} la respuesta de la caja.`);
    return out;
  });

  readonly resumen = computed<string>(() => {
    const a = this.arqueos();
    if (!a.length) return '';
    const cuadran = a.filter((x) => x.veredicto === 'cuadra').length;
    const sinResp = a.filter((x) => !veredictoConcluyente(x.veredicto)).length;
    const sinAut = a.filter((x) => !x.autorizado).length;
    return [
      this.plural(a.length, 'corte', 'cortes'),
      `${cuadran} ${cuadran === 1 ? 'cuadra' : 'cuadran'} al centavo`,
      sinResp ? `${sinResp} sin veredicto` : '',
      sinAut ? `${sinAut} sin la segunda llave` : '',
    ].filter(Boolean).join(' · ');
  });

  readonly subtitulo = computed<string | null>(() => {
    const f = this.sel();
    if (!f) return null;
    const p: string[] = [];
    if (f.arqueo) p.push(VEREDICTO[f.arqueo.veredicto].texto);
    if (f.control) p.push(this.plural(f.control.movimientos, 'movimiento en Control', 'movimientos en Control'));
    return p.join(' · ') || null;
  });

  /** Lo que ESTE arqueo no puede afirmar, con su número. */
  notasArqueo(a: ArqueoDia): string[] {
    const out: string[] = [];
    // `[CGS.52]` Lo que no se midió va PRIMERO: es lo que explica por qué faltan cifras arriba.
    if (a.sin_medir_motivo) out.push(a.sin_medir_motivo);
    if (a.recalculo_motivo) {
      out.push(`Las cifras se recalcularon después de firmar${a.recalculado_at ? ` (${dmy(a.recalculado_at.slice(0, 10))})` : ''}. `
        + `Motivo: «${a.recalculo_motivo}». Las anteriores quedan guardadas.`);
    }
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
  // ── `[CGS.59]` Cheques y papeles, uno por uno ──────────────────────────────────────────────
  /** Lo que había en el último arqueo de cada apartado. `null` mientras se lee. */
  readonly arqDocs = signal<DocumentosEnCajaDto | null>(null);
  readonly arqDocsError = signal<string | null>(null);
  private readonly arqCh = viewChild<ArqueoDocumentosComponent>('arqCh');
  private readonly arqPa = viewChild<ArqueoDocumentosComponent>('arqPa');
  /** Por qué no se pueden contar ahora los cheques y papeles. `null` = se puede. */
  readonly arqDocsBloqueo = computed<string | null>(() => {
    if (this.arqDocsError()) return this.arqDocsError();
    const d = this.arqDocs();
    if (!d) return 'Leyendo qué cheques y papeles había…';
    return d.instalado ? null : 'Esta base todavía no guarda los cheques y papeles uno por uno: quedan sin contar.';
  });
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
    return this.arqCh()?.falta() ?? this.arqPa()?.falta() ?? null;
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
    this.arqUsd.set(null); this.arqTC.set(null); this.arqTCFuente.set('');
    this.arqNota.set(''); this.arqErr.set(null); this.arqGuardado.set(null);
    this.arqDlg.set({ tipo, corte });
    // `[CGS.59]` Lo que había, para marcarlo. Sin esa lectura no se cuentan (la llave contra dos conteos la trae).
    this.arqDocs.set(null); this.arqDocsError.set(null);
    this.cajas.documentosEnCaja().subscribe({
      next: (d) => this.arqDocs.set(d),
      error: () => this.arqDocsError.set('No se pudo leer qué cheques y papeles había: esta vez quedan sin contar.'),
    });
  }

  /** `[CGS.59]` Lo que cambió en cada apartado, en una línea. */
  resumenDocumentos(g: ArqueoGuardadoDto): Array<{ titulo: string; r: ResumenApartado; linea: string }> {
    const out: Array<{ titulo: string; r: ResumenApartado; linea: string }> = [];
    for (const [titulo, r] of [['Cheques', g.documentos?.cheques], ['Vales y papeles', g.documentos?.papeles]] as const) {
      if (!r) continue;
      out.push({ titulo, r, linea: `${plural(r.siguen, 'sigue', 'siguen')} · ${plural(r.entraron, 'entró', 'entraron')} · ${plural(r.salieron.length, 'salió', 'salieron')}` });
    }
    return out;
  }

  salidaTexto(s: SalidaDocumento): string {
    return SALIDA_TEXTO[s];
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
      // `[CGS.59]` Cheques y papeles uno por uno; el servidor suma sus renglones. Sin la lectura de lo que
      // había (o sin la tabla), no se cuentan: quedan «no se contó».
      documentos: this.arqDocsBloqueo() ? null
        : { base: this.arqDocs()?.base ?? null, cheques: this.arqCh()?.valor() ?? null, papeles: this.arqPa()?.valor() ?? null },
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

  /**
   * ⭐ `[CGS.54]` Las tarjetas de lo que hay en caja: el total y una por rubro, en el orden en que
   * el servidor los publica. El estado va en palabras en un chip («Contado», «Calculado,
   * incompleto»); la barra dice qué parte del total es; la última línea, de dónde sale la cifra.
   * Sin conteo animado: un monto que cuenta desde cero publica cifras que no existen.
   */
  readonly tarjetasCaja = computed<TarjetaCaja[]>(() => {
    const p = this.posicion();
    if (!p) return [{ clave: 'total', label: 'Lo que hay en caja', valor: 'sin medir', estado: 'todavía no se calcula', pct: null, tone: 'default', desglose: [], nota: null }];
    const fuera = p.rubros.filter((r) => p.total.fuera.includes(r.rubro)).map((r) => r.etiqueta.toLowerCase());
    // Un total que suma un rubro «incompleto» lo dice en el total, no sólo en su tarjeta.
    const parciales = p.rubros.filter((r) => r.ahora.estado === 'parcial').map((r) => r.etiqueta.charAt(0).toLowerCase() + r.etiqueta.slice(1));
    const avisos = [fuera.length ? `sin ${fuera.join(', ')}` : '', parciales.length ? `incluye ${parciales.join(', ')} incompleta` : ''].filter(Boolean);
    const total: TarjetaCaja = {
      clave: 'total',
      label: p.total.completo ? 'Lo que hay en caja' : 'Lo que se puede afirmar',
      valor: money(p.total.monto),
      estado: `suma de los rubros · ${avisos.length ? avisos.join(' · ') : 'todos medidos'}`,
      pct: null, desglose: [], nota: null,
      tone: avisos.length ? 'warn' : 'default',
    };
    const base = p.total.monto > 0 ? p.total.monto : null;
    return [total, ...p.rubros.map((r): TarjetaCaja => {
      const e = r.ahora.estado;
      const pct = base !== null && r.ahora.monto !== null ? Math.round((r.ahora.monto / base) * 1000) / 10 : null;
      return {
        clave: r.rubro,
        label: r.etiqueta,
        valor: r.ahora.monto === null ? 'sin medir' : r.ahora.usd != null ? `USD ${this.usd(r.ahora.usd)}` : money(r.ahora.monto),
        pct,
        estado: [
          this.etiquetaPosicion(e),
          r.ahora.usd != null && r.ahora.monto !== null ? `${this.mx(r.ahora.monto)} en pesos` : '',
          pct !== null ? `${pct} % del total` : '',
        ].filter(Boolean).join(' · '),
        desglose: desgloseRubro(r, this.mx, (iso) => this.cuando(iso)),
        nota: e === 'parcial' || e === 'imposible' || e === 'no_medido' ? r.ahora.nota : null,
        tone: e === 'parcial' ? 'warn' : e === 'imposible' ? 'bad' : 'default',
      };
    })];
  });

  /** `[CGS.53]` El historial de arqueos completos y la nota de Control, a pedido. */
  readonly verDesglose = signal(false);
  readonly verLimites = signal(false);
  /** `[CGS.53]` El apéndice del cajón del día: plegado al abrir cada día. */
  readonly verLibro = signal(false);
  readonly verMovsCtl = signal(false);

  /** Los rubros que la Suite no mueve, dichos UNA vez y no en cada renglón. */
  readonly sinMovimientos = computed<string | null>(() => {
    const r = (this.posicion()?.rubros ?? []).filter((x) => x.ultimo && !x.desde).map((x) => x.etiqueta.toLowerCase());
    if (!r.length) return null;
    const lista = r.length > 1 ? `${r.slice(0, -1).join(', ')} ni ${r[r.length - 1]}` : r[0];
    return `La Suite no lleva movimientos de ${lista}: vale lo del último arqueo.`;
  });

  readonly etiquetaPosicion = etiquetaPosicion;
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
      partes.push('El efectivo es calculado hasta que se cuente un corte (Captura → «Abrir corte»).');
      const ant = s.sueltos_fuera?.anteriores;
      if (ant?.movimientos) partes.push(`No incluye ${ant.movimientos === 1 ? '1 movimiento suelto' : `${ant.movimientos} movimientos sueltos`} de días anteriores (neto ${money(ant.neto)}).`);
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
  /** `[CGS.53]` Los que cumplen se cuentan; los que no cumplen o no se midieron se ven siempre. */
  readonly verVerifTodas = signal(false);
  verifPartida(a: ArqueoDia): { total: number; cumplen: number; importan: ArqueoDia['verificacion'] } {
    const v = a.verificacion ?? [];
    const importan = v.filter((x) => x.estado !== 'cumple');
    return { total: v.length, cumplen: v.length - importan.length, importan };
  }

  /** `[CGS.12]` El estado de una verificación, en palabras: el color nunca va solo. */
  etiquetaVerif(e: string): string { return e === 'cumple' ? 'Cumple' : e === 'no_cumple' ? 'No cumple' : 'Sin medir'; }
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
      this.verLibro.set(false); this.verMovsCtl.set(false); this.verVerifTodas.set(false);
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
