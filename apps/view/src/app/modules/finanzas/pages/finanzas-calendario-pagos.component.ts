import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, ViewChild, inject, signal, computed, effect, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import type {
  PaymentCalendarAllocation, PaymentCalendarAllocationItem, PaymentCalendarDaySummary, PaymentCalendarWeek, PaymentCalendarWeekDay,
  PagoSugerido, PagosAtrasadosDia, PayableEvidenceRow, PaymentObligationSource, PaymentOriginAccount,
  DiscountReason, PaymentCalendarItemDiscountBody, PaymentCalendarItemDiscountResult,
} from '@megadulces/contracts';
import { warehouseName, DISCOUNT_REASONS, DISCOUNT_REASON_LABEL } from '@megadulces/contracts';
import { cierreCompleto, esPagoConDinero, nombreTipoPagoKepler, textoCierre, type CierreKeplerPago, type PagoKeplerDelCierre } from '@megadulces/contracts';
import { PagosComprobantesService } from '../pagos-comprobantes.service';
import type { SupplierCreditRow, SupplierPaymentHabit, SupplierUnappliedCreditRow } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { agruparObligaciones, allocationKey, fechaCorta, obligationKey, moverEnOrden, sugerirArmado, vencimiento, type ArmadoGrupo, type ObligationGroup } from './calendario-pagos-grupos';
import { cuenta, cubiertoDe, faltaDescuento, leerPesos, pctDeTasa, round2, type ModoDescuento, type MotivoDescuento } from './calendario-pagos-descuento';
import { firstValueFrom } from 'rxjs';
import { PagosTabsComponent } from '../pagos-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PagosCapturaLoteComponent } from '../components/pagos-captura-lote.component';

type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';

/**
 * `[PGP.11]` La única acción que el veredicto ofrece: la que destraba el paso en el que el día
 * está parado. Es una unión cerrada a propósito — `runVerdict()` tiene que seguir siendo
 * exhaustiva, y agregar un paso sin su acción tiene que romper la compilación, no pasar de largo.
 */
type VerdictActionKind = 'armar' | 'proponer' | 'ordenar' | 'autorizar' | 'pagar' | 'cerrar' | 'rebote' | 'mover' | 'exceso' | 'saldadas';
interface VerdictAction { kind: VerdictActionKind; label: string; icon: string }
/** `[PGP.15]` El veredicto: «bien» y «falta» no llevan tono (lo dice la frase); sólo lo que está mal. */
interface Verdict { tone: 'ok' | 'bad' | 'muted'; say: string; why: string | null; action: VerdictAction | null }
/** `[PGP.15]` Una etapa del día en la línea de avance: siempre visible, sin clic. */
interface Etapa { n: number; nombre: string; quien: string | null; dice: string; estado: 'hecho' | 'ahora' | 'pendiente' }
/**
 * `[PGP.73]`/`[PGP.91]` El pronto pago que se juega al mover un pago. `monto` incluye lo `capturado`
 * (que viaja con el pago); lo estimado es `monto − capturado`. Cada parte con su propio cierre.
 */
interface ProntoAlMover { monto: number; cierra: string; deja: boolean; capturado: number; cierraEst: string; cierraCap: string }
/** `[PGP.15]` Lo último que esta persona eligió en «Para los N pagos» (sólo una comodidad por navegador). */
const PREF_PREPARAR = 'pgp.preparar.ultimo';

/**
 * `[TBL.1]` Por debajo de esto, el alto de los paneles NO se re-escribe. Ver `fijarAlto()`:
 * tapa la oscilación medida de 16 px y el ancho de una barra de Windows (~15 px).
 */
const ALTO_HISTERESIS_PX = 24;
/** El MISMO formato que antes daba `toLocaleString('es-MX', { currency: 'MXN', maximumFractionDigits: 2 })`, armado una vez. */
const PESOS = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });

interface Obligation {
  obligation_source: PaymentObligationSource; obligation_id: string; beneficiary: string; concept: string;
  classification: string; subtype: string | null; area_code: string | null;
  original_due_date: string | null; negotiated_date: string | null;
  original_amount: number; reserved_amount: number; paid_amount: number; available_amount: number;
  is_critical: boolean; critical_reason: string | null; status: string;
  /** `[TP.16.3]` Sucursal (almacén = centro de costo); null en gastos, compromisos y captura manual. */
  branch_code: string | null;
  /** `[TP.16.4]` Id del proveedor (sólo facturas de proveedor): la llave del pago es el id, no el nombre. */
  payee_id: string | null;
  /**
   * `[TP.20.4]` La ventana de pronto pago de esta factura: hasta cuándo conviene pagarla y cuánto
   * se gana si se paga antes. ⚠️ La fecha es **observada, no pactada** — sale de los pagos que de
   * hecho obtuvieron descuento. `sin_medir` significa que no hay observaciones suficientes, que
   * **no es lo mismo** que «este proveedor no da descuento».
   */
  pronto_fecha_limite?: string | null;
  pronto_beneficio?: number | null;
  /**
   * `[PGP.7]` La tasa observada. Era la última columna por la que había que ir a Pronto pago:
   * el beneficio en pesos dice cuánto se gana, pero no si conviene adelantar el dinero — para
   * eso hace falta el %. `null` = sin observaciones suficientes, que **no** es 0 %.
   */
  pronto_tasa?: number | null;
  pronto_estado?: 'capturable' | 'por_vencer' | 'fuera_de_ventana' | 'sin_medir';
  /**
   * `[TP.20.5]` **El ref de la ficha de esta factura.** Lo arma el backend, que es el único que
   * conoce la clave natural del documento de Kepler. Viene `null` en los orígenes que no tienen
   * documento detrás (un gasto presupuestado, un compromiso financiero) y en una obligación
   * capturada a la que nadie le anotó el folio del ERP: ahí no hay ficha que abrir y el nombre
   * **no se pinta como enlace**, que es la única forma honesta de decirlo.
   */
  entity_ref?: string | null;
  /**
   * `[PGP.12]` **La referencia del proveedor** — lo que `/compras/obligaciones` ya muestra en su
   * columna «Referencia» (`0-F-2525`, `30-1402`). Verificada contra las 38 obligaciones que
   * Compras capturó a mano: **38 de 38 exactas**, control placebo **0 de 38**.
   *
   * ⚠️ Es captura LIBRE en el ERP: 92.6 % de los documentos traen algo, y entre ese algo hay
   * `LPA`, `DAMASO`, `S/R`, `jmea`. Por eso la columna se rotula **«Referencia»** y nunca
   * «Factura del proveedor»: en 2,705 documentos no es una factura. `null` = el ERP no trae nada,
   * que se pinta como raya y no como vacío ambiguo.
   */
  doc_ref?: string | null;
  /** `[PGP.12]` El código del acreedor en Kepler (`CNFR001`, `AE002`). Buscable; no se pinta solo. */
  payee_code?: string | null;
}
interface PaymentAccount { id: string; bank_name: string; account_number: string | null; clabe: string | null; alias: string | null; payment_reference: string | null; es_favorita: boolean }
/**
 * `[PGP.46]` Una solicitud de alta de cuenta **esperando aprobación**: lo que alguien capturó al
 * preparar un pago y todavía nadie revisó. ⛔ No es una cuenta del catálogo — el catálogo está
 * aprobado y éste no —, y por eso se pinta distinto y con quién la capturó.
 */
interface SolicitudCuenta {
  id: string; supplier_id: string; status: string;
  proposed_bank_name: string | null; proposed_clabe: string | null;
  requested_by: string | null; requested_at: string | null;
}

/**
 * `[TP.17.2]` La lista de obligaciones viaja con su TOTAL. El endpoint tiene un techo (1,000 por
 * omisión) y sin este dato la pantalla no puede distinguir «hay mil» de «te muestro mil de tres mil»
 * — que es la diferencia entre informar y mentir (ADR-056).
 */
interface ObligationPage { rows: Obligation[]; total: number; limit: number; offset: number }

const CLASSIFICATION_LABEL: Record<string, string> = {
  compromiso_financiero: 'Compromiso financiero', gasto: 'Gasto', proveedor_mercancia: 'Proveedor',
};
// [PGP.14] UN nombre por estado. El mismo hecho se llamaba «Ejecutado» (etiqueta), «Marcado como
// pagado» (tarjeta) y «Marcar pagado» (boton). Es lo que Caja General MARCA, no lo que el banco
// confirma: por eso «Marcado pagado» y no «Pagado».
// [PGP.15] Sin tono por estado: el estado lo dicen la palabra y el icono (estadoTexto/estadoIcono).
const LOT_LABEL: Record<string, string> = {
  draft: 'En armado', scheduled: 'En armado', in_prep: 'En preparación', released: 'Autorizado',
  executing: 'En dispersión', closed: 'Cerrado',
};
const METHOD_LABEL: Record<string, string> = {
  transferencia: 'Transferencia', cheque: 'Cheque', efectivo: 'Efectivo', cargo_automatico: 'Cargo automático',
};
const REPROGRAM_REASON_OPTS: { label: string; value: ReprogramReason }[] = [
  { label: 'Cuenta bancaria errónea', value: 'cuenta_erronea' },
  { label: 'Falla del sistema del banco', value: 'falla_sistema_banco' },
  { label: 'El pago se devolvió', value: 'pago_devuelto' },
  { label: 'Presupuesto recortado', value: 'presupuesto_recortado' },
  { label: 'Otro', value: 'otro' },
];
/**
 * Misma regla que `isPrepared()` del backend (`payment-calendar.service.ts`), que es quien la hace
 * cumplir al autorizar: método, origen (salvo efectivo) y destino (transferencia).
 */
function isPrepared(a: PaymentCalendarAllocation): boolean {
  if (!a.payment_method) return false;
  if (a.payment_method !== 'efectivo' && !a.bank_account_id) return false;
  if (a.payment_method === 'transferencia' && !(a.destination_account_text ?? '').trim()) return false;
  return true;
}

/**
 * Fase TP.3 — Calendario de Pagos (ADR-064). Consumidor: asigna obligaciones YA autorizadas
 * (Compras/Presupuestos/Finanzas) a un día, dentro de la capacidad que Presupuestos fija.
 * Vive en /finanzas (NO subordinado a Tesorería — Tesorería es una de las responsables).
 *
 * `[TP.16]` (Francisco, 2026-10-16): se ve la SEMANA completa (lunes a domingo) con presupuesto,
 * comprometido y disponible de cada día y sus documentos; cada día abre «Ordenar y pagar»: orden,
 * método, cuenta de ORIGEN y DESTINO (lo que pide el layout del banco). Dos firmas: Tesorería
 * prepara, Gerencia/Dirección autoriza, y dispersa quien corresponda a la cuenta de origen de
 * cada pago: Tesorería lo que sale de banco o factoraje, Caja General lo que sale de la caja
 * (`[PGP.33]`; medido, el 87.3 % del dinero sale de banco).
 */
@Component({
  selector: 'app-finanzas-calendario-pagos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PagosTabsComponent, CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, CheckboxModule, ToastModule, TooltipModule, LoadStateComponent, EntityInspectorComponent, ContextHelpComponent, SidePeekComponent, MetricStripComponent, PagosCapturaLoteComponent],
  providers: [MessageService],
  template: `
    <!-- [TP.20.3] Las cuatro pantallas de Pagos son un ciclo, no cuatro reportes sueltos. -->
    <app-pagos-tabs />
    <div class="surf-page in cal-page">
      <app-entity-inspector [(ref)]="inspect" />
      <p-toast></p-toast>
      <!-- ⛔ [PGP.52] REDISEÑO: una columna y un paso a la vez. Edgar (2026-11-03), tras tres rondas de
           parches: «sigue siendo un asco, necesito un rediseño a una más simple». Medido en su captura:
           ~70 controles y ~60 cifras en la primera pantalla, CINCO preguntas contestadas a la vez (la
           semana, el día, qué agregar, qué conviene pagar, cómo sale cada pago) en dos paneles que se
           peleaban el ancho, y cada pago en hasta 4 líneas. La causa: enseñaba TODO el proceso cuando
           la persona está en UN paso, y una lista de 1,000 facturas que nadie recorre («el 80% es el
           buscador», Edgar).
           Ahora, en este orden: la semana · el veredicto del día con su UN botón · el buscador (la
           lista aparece al buscar o con «Ver todas») · los pagos del día, UN renglón por pago. Lo que
           no decide nada en el renglón (factura, RFC, pronto pago, notas) vive en su desglose. -->
      <h1 class="sr-only">Pagos</h1>

      <!-- ── LA SEMANA ─────────────────────────────────────────────────── -->
      <nav class="pg-top" aria-label="Días por pagar">
        <div class="pg-week">
          <span class="pg-week-nav">
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-ico" (click)="shiftWeek(-1)" aria-label="Semana anterior"><span class="pi pi-angle-left" aria-hidden="true"></span></button>
            <span class="pg-queue-wk comm-num" aria-live="polite">{{ weekLabel() }}</span>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-ico" (click)="shiftWeek(1)" aria-label="Semana siguiente"><span class="pi pi-angle-right" aria-hidden="true"></span></button>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-hoy" [disabled]="selectedDate() === todayIso" (click)="goToday()">Hoy</button>
            <app-context-help topic="calendario-de-pagos" />
          </span>
          <!-- [PGP.14] Sin semana cargada no hay resumen: un cero dibujado donde no hubo medición (ADR-056).
               [PGP.52] Sólo lo libre: «sin preparar» y «sin tope» ya los dice cada día de la tira. -->
          <!-- [PGP.62] Sin «$X libres de $Y esta semana»: es la suma de lo libre que ya dice cada día de la tira. -->

          <!-- [PGP.48] Los pagos que se quedaron en un día que ya pasó apartan el saldo de sus facturas. -->
          @if (atrasadosError()) {
            <span class="pg-atr is-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>No se pudo revisar si quedaron pagos en días pasados.</span>
          } @else if (atrasados().length) {
            <button type="button" class="pg-atr" (click)="irAlDia(atrasados()[0].date)">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span><b>{{ pagos(atrasadosPagos()) }}</b> por <b class="comm-num">{{ moneyShort(atrasadosMonto()) }}</b> siguen en {{ atrasados().length === 1 ? 'un día que ya pasó' : dias(atrasados().length) + ' que ya pasaron' }} ({{ atrasadosRango() }})</span>
              <i class="pi pi-angle-right" aria-hidden="true"></i>
            </button>
          }
        </div>
        <app-load-state class="pg-days-ls" [loading]="loadingWeek() && !week()" [error]="weekError()" [skeletonRows]="1" (retry)="loadWeek()">
          <div class="pg-days">
            @for (d of week()?.days ?? []; track d.date) {
              <button type="button" class="pg-day"
                      [class.is-sel]="d.date === selectedDate()" [class.is-nocap]="!d.summary.capacity_defined"
                      [class.is-vacio]="!d.summary.capacity_defined && !d.allocations.length"
                      [attr.aria-current]="d.date === selectedDate() ? 'true' : null"
                      [attr.aria-label]="dayAria(d)" (click)="openDay(d.date)">
                <span class="pg-day-t">
                  <span class="pg-day-n">{{ dayShort(d.date) }}@if (d.date === todayIso) { <span class="pg-t"> · hoy</span> }</span>
                  <span class="pg-day-amt" [class.cal-neg]="(d.summary.remaining_amount ?? 0) < 0">
                    @if (!d.summary.capacity_defined) { @if (d.allocations.length) { <span class="pg-day-l">sin tope fijado</span> } }
                    @else if ((d.summary.remaining_amount ?? 0) < 0) { <span class="pg-day-l">excede </span><span class="comm-num">{{ moneyShort(-(d.summary.remaining_amount ?? 0)) }}</span> }
                    @else { <span class="comm-num">{{ moneyShort(d.summary.remaining_amount) }}</span><span class="pg-day-l"> libre</span> }
                  </span>
                </span>
                <span class="pg-day-b">
                  @if (d.allocations.length) {
                    {{ pagos(d.allocations.length) }}
                    <!-- [PGP.19] Un resumen por día: ámbar = falta algo, rojo = algo está mal, siempre con su palabra. -->
                    @if (dayFailed(d) > 0) { · <b class="cal-bad-txt">{{ dayFailed(d) === 1 ? '1 rebotó' : dayFailed(d) + ' rebotaron' }}</b> }
                    @else if (dayUnprepared(d) > 0) { · <b class="cal-warn-txt">faltan {{ dayUnprepared(d) }}</b> }
                    @else if (d.summary.lot_status === 'closed') { · cerrado }
                    @else if (d.summary.lot_status === 'released' || d.summary.lot_status === 'executing') { · autorizado }
                    @else { · listos }
                  } @else if (d.summary.capacity_defined) { sin pagos } @else { <!-- [PGP.74] En el día vacío va aquí: al lado del nombre no cabía en 8rem («fijad» cortado, la tira se desplazaba). -->sin tope fijado }
                </span>
              </button>
            }
          </div>
        </app-load-state>
      </nav>

      <main class="pg-lot" #payPanel>
        @if (selectedDay(); as day) {

          <!-- ── EL VEREDICTO: qué pasa, el UN botón que lo resuelve, y en qué paso va el día ── -->
          <div class="pg-vd" [class.is-bad]="verdict().tone === 'bad'">
            <h2 class="sr-only">{{ dayLong(day.date) }}@if (day.date === todayIso) { · hoy }</h2>
            <div class="pg-vd-main" role="status" aria-live="polite">
              <div class="pg-vd-txt">
                <p class="pg-vd-say">@if (verdict().tone === 'bad') { <i class="pi pi-times-circle pg-vd-ico" aria-hidden="true"></i> }{{ verdict().say }}</p>
                @if (verdict().why) { <p class="pg-vd-why">{{ verdict().why }}</p> }
              </div>
              @if (verdict().action; as act) {
                <!-- [PGP.77] Chico, y en lo que está mal sin relleno: el aviso ya dice qué pasa; el botón no tiene que gritarlo otra vez. -->
                <button pButton type="button" class="pg-vd-cta p-button-sm" [class.p-button-outlined]="verdict().tone === 'bad'" [class.p-button-secondary]="verdict().tone === 'bad'"
                        [disabled]="saving()" [loading]="saving()" (click)="runVerdict(act.kind)">
                  <span class="pi" [ngClass]="act.icon" aria-hidden="true"></span>&nbsp;{{ act.label }}
                </button>
              }
            </div>
            <!-- [PGP.63] Con pagos, el tope y el paso viajan al encabezado de «Pagos del día» (su contexto, y
                 ese renglón estaba casi vacío): el veredicto queda en dos renglones. Al ARMAR se quedan aquí,
                 porque ahí el tope decide qué cabe. -->
            @if (!pagosPrimero()) { <ng-container *ngTemplateOutlet="topeYPaso; context: { $implicit: day }" /> }
            <ng-template #topeYPaso let-day>
              <div class="pg-vd-row2">
                @if (day.summary.capacity_defined) {
                  <!-- [PGP.15] La tira de métricas compartida (Q.1), compacta y sin conteo animado. -->
                  <app-metric-strip class="pg-cap-ms" [items]="capKpis(day)" ariaLabel="El tope del día" density="compact" [instant]="true" />
                } @else {
                  <span class="pg-cap-say">Sin tope fijado</span>
                }
                <!-- [PGP.52] El avance, en UNA línea: eran cinco pasos con su número y su texto. -->
                <span class="pg-paso">{{ pasoTexto() }}@if (day.lot_folio) { · folio <span class="comm-num">{{ day.lot_folio }}</span> }</span>
              </div>
            </ng-template>
            @if (pasoActivo() === 3) {
              <!-- [PGP.13] Lo que la pantalla NO puede afirmar todavía: D2 y la separación de funciones. -->
              <p class="pg-note"><i class="pi pi-shield" aria-hidden="true"></i><span>Se autoriza <b>el día completo</b>. Debe hacerlo alguien distinto de quien lo preparó, y <b>la Suite todavía no lo impide</b>.</span></p>
            }
            @if (isReleased()) {
              <p class="pg-note"><i class="pi pi-info-circle" aria-hidden="true"></i><span><b>Kepler: cada pago (X-D-26) se sigue capturando a mano.</b> La escritura automática está apagada.</span></p>
            }
          </div>

          <!-- ⛔ [PGP.60] Con el día ya armado, LOS PAGOS DEL DÍA van aquí, pegados al veredicto que los
               nombra: medido el 2026-11-04, 104 de 109 pagos armados esperaban PREPARAR y, en una captura
               de 1,250 px, el primero aparecía cortado en el borde de abajo, debajo de 8 grupos de pronto
               pago y del buscador. El pronto pago sigue siendo lo primero que se AGREGA (PGP.53). -->
          <!-- ⭐ [PGP.66] Opción B de Edgar (2026-11-04: «todo está muy compactado y junto… ¿cómo se vería con
               ventanas o paneles laterales?»): la pantalla es SÓLO el día. El pronto pago y agregar facturas son
               botones en la barra de los pagos que abren su panel lateral (su regla del 29-oct: lo secundario =
               botón + ventana; el 95-100 % de la pantalla es la tarea). -->
          <ng-container *ngTemplateOutlet="bloquePagos; context: { $implicit: day }" />

          <!-- ── [PGP.53] PRONTO PAGO: lo primero que se paga, con su porqué, por el día en que cierra ──
               Era una línea plegada bajo el buscador («Conviene pagar: 37 acreedores…»). Edgar: es la
               prioridad, se recomienda firme y se dice por qué. Grupo = día en que cierra el descuento;
               renglón = a quién, cuánto, cuánto gana y qué %; el porqué, en su desglose.
               [PGP.66] Vive en su panel lateral; sólo se pinta abierto. -->
          <app-side-peek [open]="panelPronto()" (openChange)="panelPronto.set($event)" [width]="760" title="Pronto pago"
                         [subtitle]="'Si se paga a tiempo, en los próximos 7 días se ganan ' + money(quePagarGana())">
          @if (panelPronto() && verDeuda() && (quePagar().length || quePagarError())) {
            <!-- [PGP.70] Sin el título «Paga primero el pronto pago»: repetía el del panel. El panel ya se llama
                 «Pronto pago» y su subtítulo dice cuánto se gana en los 7 días que siguen a HOY (PGP.41). -->
            <section class="pg-pp" aria-label="Pronto pago">
              @if (quePagarError()) {
                <p class="pg-add-nm">No se pudo calcular el pronto pago. No es que no haya descuentos por ganar.</p>
              } @else {
                <!-- [PGP.62] En UNA línea. El origen del % («lo que pasó, no un acuerdo») ya lo dice el porqué de cada acreedor al abrirlo. -->
                <p class="pg-pp-why">
                  @if (prontoUrgente().acreedores) {
                    {{ acreedores(prontoUrgente().acreedores) }} cierran hoy o mañana: se pierden <b class="comm-num">{{ money(prontoUrgente().gana) }}</b> si no se pagan.
                  } @else {
                    El siguiente descuento cierra el {{ dayShort(prontoGrupos()[0].cierra) }}.
                  }
                  @if (prontoNoCabe()) { Si no cabe todo, primero el de mayor %. }
                </p>
                @for (g of prontoVisibles(); track g.cierra) {
                  <div class="pg-pp-gr">
                    <button type="button" class="pg-pp-gh" [class.is-urge]="g.dias <= 1" [attr.aria-expanded]="prontoAbierto(g)" (click)="togglePronto(g)">
                      <i class="pi" [class.pi-angle-down]="prontoAbierto(g)" [class.pi-angle-right]="!prontoAbierto(g)" aria-hidden="true"></i>
                      <!-- [PGP.65] Cerrado dice lo que hace («ver los 7 acreedores»): Edgar no encontró a los acreedores
                           cuando el grupo nació cerrado (PGP.64); la flecha sola no avisaba que el renglón se abre. -->
                      <span class="pg-pp-n">{{ prontoCierraDice(g.dias, g.cierra) }} <span class="pg-pp-d">·
                        @if (prontoAbierto(g)) { {{ acreedores(g.filas.length) }} }
                        @else { <span class="pg-pp-ver">ver {{ g.filas.length === 1 ? 'el acreedor' : 'los ' + g.filas.length + ' acreedores' }}</span> }</span></span>
                      <span class="comm-num pg-pp-i">{{ money(g.importe) }}</span>
                      <span class="comm-num pg-pp-g">+{{ money(g.gana) }}</span>
                      <span class="pg-pp-p"></span>
                      <span class="pg-pp-a"></span>
                    </button>
                    @if (prontoAbierto(g)) {
                      <ul class="pg-pp-l">
                        @for (r of g.filas; track r.proveedor_code) {
                          <li>
                            <div class="pg-pp-r">
                              <button type="button" class="pg-pp-go" [attr.aria-expanded]="prontoPorQue() === r.proveedor_code"
                                      (click)="prontoPorQue.set(prontoPorQue() === r.proveedor_code ? null : r.proveedor_code)"
                                      [attr.aria-label]="'Por qué conviene pagarle a ' + r.proveedor_nombre">
                                <span class="pg-pp-n">{{ r.proveedor_nombre }}</span>
                                <span class="comm-num pg-pp-i">{{ money(r.importe) }}</span>
                                <span class="comm-num pg-pp-g">+{{ money(r.gana) }}</span>
                                <span class="comm-num pg-pp-p">{{ pct(r.tasa) }}</span>
                              </button>
                              <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-pp-a" (click)="tomarSugerido(r)"
                                      [attr.aria-label]="'Ver las facturas de ' + r.proveedor_nombre + ' para agregarlas al ' + dayShort(day.date)">Agregar</button>
                            </div>
                            @if (prontoPorQue() === r.proveedor_code) {
                              <div class="pg-pp-x">
                                <p>Si le pagas a más tardar el <b>{{ dayLong(r.cierra) }}</b>, ganas <b class="comm-num">{{ money(r.gana) }}</b>: el {{ pct(r.tasa) }} de sus {{ facturas(r.facturas) }}.@if (day.date > r.cierra) { <b>Pagado el {{ dayShort(day.date) }} ya no gana: cierra antes.</b> }</p>
                                @if (r.pagos_con_descuento) {
                                  <p>Lo sabemos porque en el último año le pagamos {{ r.pagos_con_descuento }} veces con ese descuento, normalmente a {{ dias(r.dias_tipicos ?? 0) }} de la factura.</p>
                                }
                                @if (r.vence_la_mas_vieja && r.vence_la_mas_vieja < todayIso) {
                                  <p>Además ya está vencida: su factura más vieja venció el {{ shortDate(r.vence_la_mas_vieja) }}.</p>
                                }
                                <p>@if (r.se_puede_preparar_hoy) { Tiene cuenta para transferir. } @else { No tiene cuenta para transferir: la CLABE se captura al prepararlo. }</p>
                              </div>
                            }
                          </li>
                        }
                      </ul>
                    }
                  </div>
                }
                <!-- [PGP.61] Los demás días, en UNA línea que dice qué hay adentro (plegar no es esconder). -->
                @if (prontoResto().dias) {
                  <button type="button" class="pg-pp-mas" [attr.aria-expanded]="prontoVerTodos()" (click)="prontoVerTodos.set(!prontoVerTodos())">
                    <i class="pi" [class.pi-angle-down]="prontoVerTodos()" [class.pi-angle-right]="!prontoVerTodos()" aria-hidden="true"></i>
                    @if (prontoVerTodos()) { Ver sólo los 3 días que cierran primero }
                    @else { {{ prontoResto().dias === 1 ? '1 día más' : prontoResto().dias + ' días más' }} · {{ acreedores(prontoResto().acreedores) }} · <span class="comm-num">{{ money(prontoResto().importe) }}</span> · ganas <span class="comm-num">{{ money(prontoResto().gana) }}</span> }
                  </button>
                }
              }
            </section>
          }
          </app-side-peek>

          <!-- ── AGREGAR: el buscador; la lista, sólo cuando se pide ──
               [PGP.66] En su panel lateral (botón «Agregar facturas» o la tecla /); sólo se pinta abierto. -->
          <app-side-peek [open]="panelAgregar()" (openChange)="panelAgregar.set($event)" [width]="720"
                         [title]="'Agregar facturas al ' + dayShort(day.date)">
          @if (panelAgregar() && verDeuda()) {
            <section class="pg-add" aria-label="Agregar facturas">
              <div class="pg-add-bar">
                <span class="pg-buscar">
                  <span class="pi pi-search" aria-hidden="true"></span>
                  <input id="pg-buscar" pInputText type="search" autocomplete="off" class="pg-buscar-in"
                         [ngModel]="busqueda()" (ngModelChange)="alEscribir($event)" (keydown.enter)="buscarYa()" (keydown.escape)="limpiarBusqueda($event)"
                         placeholder="Proveedor, folio o monto — ej. delicias 396 248"
                         aria-label="Buscar facturas por proveedor, folio, monto o referencia. Varias palabras, en cualquier orden." aria-describedby="pg-buscar-dice" />
                  <kbd class="pg-kbd" aria-hidden="true">/</kbd>
                </span>
                <span id="pg-buscar-dice" class="pg-add-n" aria-live="polite">
                  @if (buscando()) { Buscando… }
                  @else if (obligationsError()) { No se pudo leer la deuda }
                  @else if (busquedaAplicada()) { @if (obligationsTruncated()) { {{ obligations().length | number }} de {{ obligationsTotal() | number }} facturas } @else { {{ facturas(obligacionesProgramables().length) }} } con «{{ busquedaAplicada() }}» }
                </span>
              </div>
              @if (avisoAlta(); as av) {
                <p class="pg-alta" role="status"><i class="pi pi-check" aria-hidden="true"></i>{{ av }}</p>
              }
              @if (creditosError()) {
                <p class="pg-qp-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No se pudo leer el crédito a favor de los acreedores: los avisos de «a favor sin aplicar» no aparecen. No es que no haya.</p>
              }

              @if (!listaAbierta()) {
                <!-- [PGP.52] Sin búsqueda, en lugar de 1,000 renglones: tres caminos, cada uno con su cuenta. -->
                <p class="pg-add-links">
                  @if (obligationsError()) {
                    <span class="pg-add-nm">No se pudo leer la deuda. <button type="button" class="pg-link" (click)="loadObligations()">Reintentar</button></span>
                  } @else {
                    <button type="button" class="pg-link" (click)="verLista.set(true)"><i class="pi pi-list" aria-hidden="true"></i>Ver todas las facturas por pagar (<span class="comm-num">{{ obligationsTotal() | number }}</span>)</button>
                  }
                  @if (obligacionesEnRevision().length) {
                    <button type="button" class="pg-link" (click)="verLista.set(true); verRevision.set(true)"><i class="pi pi-lock" aria-hidden="true"></i>{{ obligacionesEnRevision().length }} por confirmar</button>
                  }
                </p>
              } @else {
                <!-- ── LA LISTA: con búsqueda o con «Ver todas». Tiene su propio alto y su propio scroll. ── -->
                <div class="pg-lista" id="pg-add-b">
                  <div class="pg-drawer-h">
                    <p-select appendTo="body" [options]="classificationOpts" [(ngModel)]="classificationFilter" (onChange)="loadObligations()" optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true" size="small" class="cal-sel" ariaLabel="Tipo de obligación" />
                    <p-select appendTo="body" [options]="ordenOpts" [(ngModel)]="ordenSel" (onChange)="onOrden()" optionLabel="label" optionValue="value" size="small" class="cal-sel" ariaLabel="Orden de la lista" />
                    <label class="cal-check"><p-checkbox [(ngModel)]="onlyCritical" [binary]="true" (onChange)="loadObligations()" />Críticos</label>
                    @if (!busquedaAplicada()) {
                      <span class="pg-add-n">@if (obligationsTruncated()) { {{ obligations().length | number }} de {{ obligationsTotal() | number }}, {{ ordenDice() }} } @else { {{ obligationsTotal() | number }} por pagar }</span>
                    }
                    <span class="pg-lista-acts">
                      <a pButton class="p-button-sm p-button-text p-button-secondary" routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">
                        <span class="p-button-icon p-button-icon-left pi pi-inbox" aria-hidden="true"></span><span class="p-button-label">Entregas de Compras</span>
                      </a>
                      <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="cerrarLista()"><span class="pi pi-times" aria-hidden="true"></span>&nbsp;Cerrar la lista</button>
                    </span>
                  </div>
                  <!-- [PGP.15] Con una búsqueda, cada proveedor y sucursal es UN pago: se agrega entero de un clic. -->
                  @if (gruposBusqueda().length) {
                    <div class="pg-grupos" role="group" aria-label="Proveedores encontrados">
                      @for (g of gruposBusqueda().slice(0, 5); track g.key) {
                        <div class="pg-grupo">
                          <span class="pg-dr-main">
                            <span class="cal-benef">{{ g.beneficiary }}</span>
                            <span class="pg-sub"><span class="cal-suc">{{ branchLabel(g.branch) }}</span> {{ facturas(g.count) }} · van en un solo pago
                              @if (excedeTope(g.total); as exceso) { · <b class="cal-bad-txt">no cabe: excede lo libre del día por {{ money(exceso) }}</b> }</span>
                          </span>
                          <span class="pg-dr-amt comm-num">{{ money(g.total) }}</span>
                          <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="saving() || grupoAgregado(g)"
                                  [attr.aria-label]="'Agregar al ' + dayLong(selectedDate()) + ' las ' + g.count + ' facturas de ' + g.beneficiary + ' ' + branchLabel(g.branch)" (click)="agregarGrupo(g)">
                            @if (grupoAgregado(g)) { <span class="pi pi-check" aria-hidden="true"></span>&nbsp;En el día } @else { {{ g.count === 1 ? 'Agregar la factura' : 'Agregar las ' + g.count }} }
                          </button>
                        </div>
                      }
                      @if (gruposBusqueda().length > 5) {
                        <p class="pg-drawer-n">Y {{ gruposBusqueda().length - 5 }} proveedores más: afina la búsqueda, o agrega sus facturas abajo una por una.</p>
                      }
                    </div>
                  }
                  @if (evidenciaPendientes() > 0) {
                    @if (evidenciaFallo()) {
                      <p class="pg-ev-est is-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>No se pudo buscar el archivo de {{ evidenciaPendientes() | number }} {{ evidenciaPendientes() === 1 ? 'renglón' : 'renglones' }}: ahí no se sabe si hay factura.
                        <button type="button" class="pg-ev-retry" (click)="reintentarEvidencias()">Reintentar</button></p>
                    } @else {
                      <p class="pg-ev-est">Buscando el archivo de {{ evidenciaPendientes() | number }} {{ evidenciaPendientes() === 1 ? 'renglón' : 'renglones' }}…</p>
                    }
                  }
                  <div class="pg-dr-hd" aria-hidden="true"><span>Proveedor y documento</span><span>Vencimiento</span><span class="r">Importe</span><span></span></div>
                  <div class="pg-drawer-b">
                    <app-load-state [loading]="loadingObligations()" [error]="obligationsError()" errorTitle="No se pudo leer la deuda" (retry)="loadObligations()" [skeletonRows]="4">
                      <!-- ⛔ [PGP.15] Textos precalculados (filasDeuda) y pintado por tandas (deudaVisible): abrir
                           la lista congelaba la pantalla 15.9 s con 954 renglones. -->
                      @for (f of filasDeuda().slice(0, deudaVisible()); track f.o.obligation_id) {
                        <div class="pg-dr-row">
                          <span class="pg-dr-main">
                            <span class="cal-benef">{{ f.o.beneficiary }}@if (f.o.is_critical) { <span class="pg-crit"><i class="pi pi-flag" aria-hidden="true"></i>crítico</span> }</span>
                            <span class="pg-sub"><span class="cal-suc">{{ f.sucursal }}</span>
                              @if (f.o.entity_ref) {
                                <button type="button" class="cal-reflink" (click)="inspect.set(f.o.entity_ref!)" [attr.aria-label]="f.tituloFicha">{{ f.o.concept }}</button>
                              } @else { {{ f.o.concept }} }
                              @if (f.o.doc_ref) { <span class="cal-ref">{{ f.o.doc_ref }}</span> }
                              @if (evidenciaDe(f.o); as e) {
                                <!-- [PGP.21] La factura, para no ir a buscarla. [PGP.52] Sin el «RFC deducido»: es la
                                     procedencia de cómo se encontró, y la ficha y el PDF la dicen; el renglón no. -->
                                @if (e.evidencia === 'pdf') {
                                  <button type="button" class="pg-ev pg-ev-pdf" [attr.aria-label]="'Ver la factura de ' + f.o.beneficiary + ' ' + f.o.concept" (click)="abrirFactura(e)">
                                    <i class="pi pi-file-pdf" aria-hidden="true"></i>Ver la factura
                                  </button>
                                } @else if (e.evidencia === 'uuid') {
                                  <span class="pg-ev pg-ev-uuid"><i class="pi pi-id-card" aria-hidden="true"></i>sin archivo; hay UUID</span>
                                } @else {
                                  <span class="pg-ev pg-ev-no"><i class="pi pi-info-circle" aria-hidden="true"></i>sin factura: {{ e.motivo }}</span>
                                }
                                @if (rfcDeducido(e) && e.rfc_discrepa) {
                                  <span class="pg-ev pg-ev-dis"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>RFC en disputa: Kepler dice {{ e.rfc_discrepa }}, sus comprobantes {{ rfcDeducido(e) }}</span>
                                }
                              }
                            </span>
                            @if (f.pronto || f.credito || f.adelanto) {
                              <span class="pg-sub pg-sub-2">
                                @if (f.pronto; as p) { <span class="cal-pp" [class.cal-pp-urge]="p.urge"><i class="pi" [class.pi-bolt]="p.urge" [class.pi-tag]="!p.urge" aria-hidden="true"></i>{{ p.texto }}</span> }
                                <!-- [PGP.14][PGP.17] El crédito a favor que nadie aplicó: abre su desglose. -->
                                @if (f.credito; as c) {
                                  <button type="button" class="pg-favor pg-favor-btn" [attr.aria-label]="'Ver los descuentos de ' + f.o.beneficiary" (click)="abrirCreditos(f.o.payee_code, f.o.beneficiary)">
                                    <i class="pi pi-replay" aria-hidden="true"></i>{{ c }}<i class="pi pi-angle-right" aria-hidden="true"></i>
                                  </button>
                                }
                                <!-- [PGP.16] Lo que cuesta pagarla antes de su vencimiento. -->
                                @if (f.adelanto; as a) { <span class="pg-pronto-no"><i class="pi pi-clock" aria-hidden="true"></i>{{ a }}</span> }
                              </span>
                            }
                          </span>
                          <span class="pg-dr-due">{{ f.vence }}</span>
                          <span class="pg-dr-amt comm-num">{{ f.importe }}</span>
                          <span class="pg-dr-acts">
                            <button type="button" class="pg-icobtn" [disabled]="saving() || agregando().has(f.o.obligation_id)" [attr.aria-label]="f.ariaAgregar" (click)="quickAdd(f.o)"><span class="pi" [class.pi-plus]="!agregando().has(f.o.obligation_id)" [class.pi-check]="agregando().has(f.o.obligation_id)" aria-hidden="true"></span></button>
                            <button type="button" class="pg-icobtn" [disabled]="saving()" [attr.aria-label]="f.ariaOtro" (click)="quickAddDialog(f.o)"><span class="pi pi-sliders-h" aria-hidden="true"></span></button>
                          </span>
                        </div>
                      } @empty {
                        <p class="cal-empty">Sin facturas con estos filtros. Las de proveedor llegan aquí cuando Finanzas acepta una entrega en <a routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">Entregas de Compras</a>.</p>
                      }
                      @if (deudaVisible() < filasDeuda().length) {
                        <p class="pg-drawer-n">Mostrando {{ deudaVisible() | number }} de {{ filasDeuda().length | number }}…</p>
                      }
                    </app-load-state>
                  </div>
                  <!-- [PGP.13] ⛔ Lo que NO se puede programar: de sucursal, antes del 1-oct. Plegado con su cuenta y total. -->
                  @if (obligacionesEnRevision().length) {
                    <button type="button" class="pg-rev-h" [attr.aria-expanded]="verRevision()" (click)="verRevision.set(!verRevision())">
                      <span class="pi pi-lock" aria-hidden="true"></span>
                      <span class="pg-rev-t"><b>{{ facturas(obligacionesEnRevision().length) }} por confirmar · <span class="comm-num">{{ money(revisionTotal()) }}</span>@if (obligationsTruncated()) { <span class="pg-rev-u"> · entre las {{ obligations().length | number }} listadas</span> }</b>
                        <span>De sucursal, antes del 1-oct: pueden estar pagadas desde Oficinas; se revisan con Finanzas.</span></span>
                      <span class="pi pg-chev" [class.pi-angle-down]="verRevision()" [class.pi-angle-right]="!verRevision()" aria-hidden="true"></span>
                    </button>
                    @if (verRevision()) {
                      <div class="pg-rev-list">
                        @for (o of obligacionesEnRevision(); track o.obligation_id) {
                          <div class="pg-dr-row is-locked">
                            <span class="pg-dr-main">
                              <span class="cal-benef">{{ o.beneficiary }}</span>
                              <span class="pg-sub"><span class="cal-suc">{{ branchLabel(o.branch_code) }}</span> {{ o.concept }}@if (o.doc_ref) { <span class="cal-ref">{{ o.doc_ref }}</span> } · {{ classLabel(o.classification) }}</span>
                            </span>
                            <span class="pg-dr-due">{{ venceTxt(o) }}</span>
                            <span class="pg-dr-amt comm-num">{{ money(o.available_amount) }}</span>
                            <span class="pg-dr-acts"><i class="pi pi-lock" aria-label="No se puede programar"></i></span>
                          </div>
                        }
                      </div>
                    }
                  }
                </div>
              }
            </section>
          }
          </app-side-peek>

          <!-- ── LOS PAGOS DEL DÍA: un renglón por pago ──
               [PGP.60] Se escribe UNA vez y se pinta en uno de dos lugares según el paso del día (no con
               CSS order: el teclado seguiría el orden viejo del DOM). -->
          <ng-template #bloquePagos let-day>
          <section class="pg-sec pg-pagos" aria-labelledby="pg-pagos-h">
            <div class="pg-sec-h">
              <h3 class="pg-sec-t" id="pg-pagos-h">Pagos del día
                @if (allocations().length) { <span class="pg-sec-n">{{ pagos(allocations().length) }}@if (!day.summary.capacity_defined) { · <span class="comm-num">{{ money(dayTotal(day)) }}</span> }</span> }
                <!-- [PGP.62] Sin «pronto pago: gana $X · deja pasar $Y» aquí: «Por qué hoy» lo dice en cada renglón. -->
                <!-- [PGP.35] Lo que el ERP ya no debe. Con el día excedido ya lo dice el veredicto. -->
                @if (saldadasDelDia().length && !day.summary.exceeded) {
                  <span class="pg-sec-saldada"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="comm-num">{{ money(saldadasDelDiaTotal()) }}</span> ya no se deben</span>
                }
                <!-- [PGP.96] Lo que Kepler ya pagó de este día: no es un aviso, es el cierre. -->
                @if (conciliadosDelDia().length) {
                  <span class="pg-sec-cierre"><i class="pi pi-check-circle" aria-hidden="true"></i>{{ pagos(conciliadosDelDia().length) }} por <span class="comm-num">{{ money(conciliadosTotal()) }}</span> pagados en Kepler</span>
                }
              </h3>
              @if (pagosPrimero()) { <span class="pg-sec-tope"><ng-container *ngTemplateOutlet="topeYPaso; context: { $implicit: day }" /></span> }
              <span class="pg-sec-acts">
                <!-- [PGP.66] Lo secundario, como botón con su cifra: abre su panel lateral. -->
                @if (verDeuda() && (quePagar().length || quePagarError())) {
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [attr.aria-expanded]="panelPronto()" (click)="abrirPronto()">
                    <span class="pi pi-bolt" aria-hidden="true"></span>&nbsp;Pronto pago@if (prontoUrgente().acreedores) { · {{ prontoUrgente().acreedores }} cierran hoy o mañana }
                  </button>
                }
                @if (verDeuda()) {
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [attr.aria-expanded]="panelAgregar()" aria-keyshortcuts="/" (click)="abrirAgregar()">
                    <span class="pi pi-plus" aria-hidden="true"></span>&nbsp;Agregar facturas <kbd class="pg-kbd" aria-hidden="true">/</kbd>
                  </button>
                }
                @if (allocations().length) {
                  <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [loading]="printing()" (click)="printPreliminar()"><span class="pi pi-file-pdf" aria-hidden="true"></span>&nbsp;Preliminar para autorizar</button>
                }
                @if (day.lot_folio) {
                  <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [loading]="printing()" (click)="printEjecucion()"><span class="pi pi-print" aria-hidden="true"></span>&nbsp;Instrucción de ejecución</button>
                }
                @if (isReleased() && porPagar().length > 1 && verdict().action?.kind !== 'pagar') {
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="saving()" (click)="abrirPagar(null)"><span class="pi pi-check" aria-hidden="true"></span>&nbsp;Marcar los {{ porPagar().length }} pagados</button>
                }
              </span>
              <!-- [PGP.72] Comprobantes de pago, sin ir a «Pagos a proveedor» (Edgar, 2026-11-04: «sólo replicar ese
                   botón en un apartado pequeño»). Es el componente compartido en modo compacto: un botón al que
                   se le suelta el PDF; lee cada uno, busca su pago en Kepler y deja pre-marcado el que coincide.
                   Guardar sigue siendo UN clic (PC.3: la IA propone, la persona confirma). -->
              <app-pagos-captura-lote [compacto]="true" (verDiferencias)="verComprobantesConDiferencias()" />
            </div>

            @if (!isReleased() && !diaPasado() && unpreparedCount() > 0) {
              <!-- [PGP.13][PGP.15][PGP.49] Método y origen a los que faltan, de una vez; el destino sale de la
                   cuenta favorita de cada proveedor. Sólo en el paso de preparar. -->
              <div class="pg-applyall">
                <span class="pg-aa-lb">{{ unpreparedCount() === 1 ? 'El pago sin preparar' : 'Los ' + unpreparedCount() + ' sin preparar' }}:</span>
                <!-- [PGP.75] El método y la CLABE vienen del historial de cada proveedor (se ven en su renglón);
                     lo único que se decide aquí es de qué cuenta sale el día: la cuenta de origen NO se propone
                     por proveedor (decisión medida, FASE_PGP «Lo que NO se va a autorrellenar»). -->
                <span class="pg-aa-f"><label for="pg-bulk-method">Método</label>
                  <p-select appendTo="body" inputId="pg-bulk-method" [options]="methodOpts" [(ngModel)]="bulkMethod" optionLabel="label" optionValue="value" placeholder="El de su historial" [showClear]="true" size="small" class="cal-sel" /></span>
                @if (bulkMethod !== 'efectivo') {
                  <span class="pg-aa-f"><label for="pg-bulk-origin">Sale de</label>
                    <p-select appendTo="body" inputId="pg-bulk-origin" [options]="originOpts()" [(ngModel)]="bulkOriginId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [filter]="true" filterBy="label" size="small" class="cal-sel" /></span>
                }
                <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="!puedeAplicar() || saving()" [loading]="saving()" (click)="aplicarATodos()">{{ unpreparedCount() === 1 ? 'Aplicar' : 'Aplicar a los ' + unpreparedCount() }}</button>
                @if (!bulkMethod) {
                  <span class="pg-aa-n">{{ resumenSugerencias() }}</span>
                }
                <!-- [PGP.62] Sin el renglón «El destino sale de la cuenta favorita…»: al aplicar, el aviso nombra a los que no tienen. -->
              </div>
            }

            @if (!allocations().length) {
              @if (armadoCargando()) {
                <p class="cal-empty">Calculando la propuesta con toda la deuda…</p>
              } @else if (armado(); as arm) {
                @if (arm.length) {
                  <!-- [PGP.15] La propuesta ya está hecha al entrar. [PGP.42] Sin tope, nada viene marcado. -->
                  <div class="pg-prop" role="group" aria-label="Propuesta para este día">
                    @if (armadoSinTope()) {
                      <p class="pg-prop-why">Propuesta: lo vencido o que vence este día y lo que pierde descuento, <b>un pago por proveedor y sucursal</b>. Presupuestos no fijó el tope, así que no se marca nada solo: marca lo que entra y guárdalo arriba.</p>
                    } @else {
                      <p class="pg-prop-why">Propuesta: lo vencido o que vence este día y lo que pierde descuento, <b>un pago por proveedor y sucursal</b>, hasta donde alcance el tope. Quita lo que no quieras pagar hoy.</p>
                    }
                    @for (g of armadoCaben(); track g.key) {
                      <label class="pg-prop-row">
                        <p-checkbox [binary]="true" [ngModel]="armadoOn().has(g.key)" (onChange)="toggleArmado(g.key)" [ariaLabel]="'Incluir ' + g.beneficiary + ' ' + branchLabel(g.branch)" />
                        <span class="pg-prop-main">
                          <span class="cal-benef">{{ g.beneficiary }}</span>
                          <!-- [PGP.38] Lo que entra por descuento todavía no vence: no se dice «venció». -->
                          <span class="pg-sub"><span class="cal-suc">{{ branchLabel(g.branch) }}</span> {{ facturas(g.items.length) }} ·
                            @if (g.motivo === 'pronto_pago') { <b>no vence todavía</b> · se adelanta para ganar <span class="comm-num">{{ money(g.gana) }}</span> antes del {{ shortDate(g.oldest) }} }
                            @else { la más vieja venció el {{ shortDate(g.oldest) }}@if (g.gana > 0) { · además gana <span class="comm-num">{{ money(g.gana) }}</span> si sale hoy } }
                            @if (creditoDeGrupo(g); as c) { · <span class="pg-favor"><i class="pi pi-replay" aria-hidden="true"></i>trae {{ money(c.a_favor) }} a favor sin aplicar: revisa si se descuenta de este pago</span> }
                          </span>
                        </span>
                        <span class="pg-prop-amt comm-num">{{ money(g.total) }}</span>
                      </label>
                    }
                    <!-- [PGP.15] Lo que NO cabe, en UNA línea con su cuenta y su total, desglosable. -->
                    @if (armadoFuera().length) {
                      <button type="button" class="pg-rev-h pg-fuera-h" [attr.aria-expanded]="verFuera()" (click)="verFuera.set(!verFuera())">
                        <span class="pi" [class.pi-angle-down]="verFuera()" [class.pi-angle-right]="!verFuera()" aria-hidden="true"></span>
                        <span class="pg-rev-t"><b>{{ pagos(armadoFuera().length) }} más, vencidos, no caben en el tope · <span class="comm-num">{{ money(armadoFueraTotal()) }}</span></b>
                          <span>El primero que no cabe es el de {{ armadoFuera()[0].beneficiary }} por {{ money(armadoFuera()[0].total) }}.</span></span>
                      </button>
                      @if (verFuera()) {
                        @for (g of armadoFuera(); track g.key) {
                          <div class="pg-prop-row is-off">
                            <span class="pi pi-minus pg-fuera-i" aria-hidden="true"></span>
                            <span class="pg-prop-main">
                              <span class="cal-benef">{{ g.beneficiary }}</span>
                              <span class="pg-sub"><span class="cal-suc">{{ branchLabel(g.branch) }}</span> {{ facturas(g.items.length) }} ·
                                @if (g.motivo === 'pronto_pago') { <b>no vence todavía</b> } @else { la más vieja venció el {{ shortDate(g.oldest) }} }</span>
                            </span>
                            <span class="pg-prop-amt comm-num">{{ money(g.total) }}</span>
                          </div>
                        }
                      }
                    }
                  </div>
                } @else {
                  <p class="cal-empty">No hay facturas vencidas ni por vencer para este día. Si hay que pagar algo, agrégalo con «Agregar facturas».</p>
                }
              } @else {
                <p class="cal-empty">Sin pagos este día.</p>
              }
            } @else {
              <!-- [PGP.52] UN renglón por pago: quién, cómo sale, cuánto y su acción. El resto vive en el desglose (›).
                   [PGP.76] El orden se cambia arrastrando la fila por su asa (≡) o, con el foco en el asa, ↑ ↓ Inicio Fin. -->
              <span class="sr-only" aria-live="polite">{{ ordenAviso() }}</span>
              <p-table [value]="allocations()" size="small" dataKey="id" [expandedRowKeys]="abiertos()" (onRowReorder)="alSoltar($event)" class="surf-table surf-table--plain surf-table--sticky pg-prep">
                <ng-template #header>
                  <tr>
                    <th class="pg-c-tg"><span class="sr-only">Desglose</span></th>
                    <th class="pg-c-ord" [class.is-folio]="isReleased()">@if (isReleased()) { Folio } @else { Orden }</th>
                    <th class="pg-c-ben">A quién</th>
                    <th class="pg-c-amt">Importe</th>
                    <th class="pg-c-why">Por qué hoy</th>
                    <th class="pg-c-how">Cómo sale</th>
                    <th class="pg-c-act"><span class="sr-only">Acciones</span></th>
                  </tr>
                </ng-template>
                <ng-template #body let-a let-i="rowIndex" let-expanded="expanded">
                  <tr [class.is-bad]="a.status === 'failed'" [class.is-corte]="a.id === corteDelTope()" [pReorderableRow]="i" [pReorderableRowDisabled]="a.status !== 'pending' || isReleased()">
                    <td class="pg-c-tg">
                      <button type="button" class="pg-tg" [attr.aria-expanded]="expanded" [attr.aria-label]="(expanded ? 'Ocultar el detalle de ' : 'Ver el detalle de ') + allocationTitle(a)" (click)="toggleAbierto(a.id)">
                        <span class="pi" [class.pi-angle-down]="expanded" [class.pi-angle-right]="!expanded" aria-hidden="true"></span>
                      </button>
                    </td>
                    <td class="pg-c-ord">
                      @if (a.status === 'pending' && !isReleased()) {
                        <!-- [PGP.76] El asa: se arrastra con el mouse, o con el foco ↑ ↓ Inicio Fin. El orden decide el turno en que se dispersa. -->
                        <span class="pg-ord" pReorderableRowHandle tabindex="0" role="button" [attr.data-ord]="a.id"
                              aria-keyshortcuts="ArrowUp ArrowDown Home End" (keydown)="teclaOrden($event, a)"
                              [attr.aria-label]="'Turno ' + turno(a) + ' de ' + pendingCount() + ', ' + allocationTitle(a) + '. Arrastra la fila, o usa flecha arriba y abajo; Inicio y Fin lo llevan al principio o al final'"
                              title="Arrastra para cambiar el orden (o ↑ ↓ con el teclado)">
                          <span class="pi pi-bars pg-ord-h" aria-hidden="true"></span>
                          <b class="comm-num pg-ordn">{{ turno(a) }}</b>
                        </span>
                      } @else {
                        <span class="comm-num pg-ordn">{{ a.folio || a.priority_rank || '—' }}</span>
                      }
                    </td>
                    <td class="pg-c-ben">
                      <!-- [PGP.60] La línea de corte: desde este pago, lo acumulado ya no cabe en el tope. -->
                      @if (a.id === corteDelTope()) { <span class="pg-corte"><i class="pi pi-arrow-down" aria-hidden="true"></i>Desde aquí ya no cabe en el tope del día</span> }
                      <span class="pg-ben"><span class="cal-benef">{{ allocationTitle(a) }}</span><span class="pg-ben-d"> · {{ itemsBranches(a) }} · {{ itemsResumen(a) }}</span></span>
                    </td>
                    <!-- [PGP.74] El importe va al lado de a quién: a 2,135 px quedaba a ~1,700 px del nombre y el ojo
                         cruzaba la pantalla para leer cada pago (auditoría externa, 2026-11-04). -->
                    <td class="pg-c-amt comm-num" data-l="Importe">{{ money(a.amount_assigned) }}</td>
                    <td class="pg-c-why" data-l="Por qué hoy">
                      @if (porQueHoy(a); as q) { <span [class.pg-why-f]="q.fuerte">{{ q.texto }}</span> } @else { <span class="pg-why-n">—</span> }
                    </td>
                    <td class="pg-c-how" data-l="Cómo sale">
                      @if (pagadoEnKepler(a); as c) {
                        <!-- [PGP.96] Kepler ya lo pagó: se dice con qué documento, y su PDF a un clic. Antes decía
                             «Ya no se debe: quítalo del día», que en un día pasado era la instrucción equivocada. -->
                        <span class="pg-cierre">
                          <i class="pi pi-check-circle" aria-hidden="true"></i>
                          <span>{{ textoCierre(c) }}</span>
                          @if (c.pagos[0]; as p) {
                            <span class="pg-cierre-d">· {{ nombreTipo(p.tipo) }} <span class="comm-num">{{ p.doc_prefix }}-{{ p.folio }}</span>@if (p.cuenta_nombre || p.cuenta) { · {{ p.cuenta_nombre || p.cuenta }} }@if (c.pagos.length > 1) { · y {{ c.pagos.length - 1 }} más }</span>
                          }
                          @if (pdfDelCierre(c); as p) {
                            <button type="button" class="pg-saldada-btn" (click)="abrirComprobante(p)"
                                    [attr.aria-label]="'Ver el comprobante PDF del pago ' + p.doc_prefix + '-' + p.folio + ' de ' + allocationTitle(a)"><i class="pi pi-file-pdf" aria-hidden="true"></i> PDF</button>
                          }
                        </span>
                      } @else if (a.kepler_saldadas > 0) {
                        <!-- [PGP.35][PGP.48] Lo que el ERP ya no debe, dicho corto; el porqué está en el desglose. -->
                        <span class="pg-saldada">
                          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                          @if (noSePuedePagar(a)) { Ya no se debe: quítalo del día }
                          @else if (a.status === 'pending' && !isReleased()) {
                            <span>{{ a.kepler_saldadas }} de {{ a.items.length }} facturas ya no se deben</span>
                            <button type="button" class="pg-saldada-btn" [disabled]="saving()" (click)="quitarSaldadas(a)"
                                    [attr.aria-label]="'Quitar del pago de ' + allocationTitle(a) + ' las ' + a.kepler_saldadas + ' facturas que el ERP ya no debe'">Quitar {{ a.kepler_saldadas === 1 ? 'ésa' : 'esas ' + a.kepler_saldadas }}</button>
                          } @else { {{ a.kepler_saldadas }} de {{ a.items.length }} ya no se deben: marcarlo va a fallar }
                        </span>
                      } @else if (comoSale(a); as cs) {
                        <span class="pg-how">
                          @if (cs.texto) { <span class="pg-how-t">{{ cs.texto }}</span> }
                          @else if (sugerencias().get(a.id); as sg) {
                            <!-- [PGP.75] Lo que el historial propone, con su procedencia: todavía no está guardado. -->
                            <span class="pg-how-t pg-sug" [title]="sg.porque"><i class="pi pi-history" aria-hidden="true"></i>{{ sg.texto }}</span>
                          }
                          <span class="pg-st" [class.is-bad]="a.status === 'failed'" [class.is-todo]="a.status === 'pending' && !!cs.falta">
                            <i class="pi" [ngClass]="estadoIcono(a)" aria-hidden="true"></i>{{ estadoTexto(a) }}
                          </span>
                        </span>
                      }
                    </td>
                    <td class="pg-c-act">
                      <!-- [PGP.96] Lo que Kepler ya pagó no se mueve ni se quita: ya está hecho. -->
                      @if (pagadoEnKepler(a)) {
                      } @else if (a.status === 'pending' && !isReleased()) {
                        @if (diaPasado()) {
                          <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="saving()" [attr.aria-label]="'Mover a otro día el pago de ' + allocationTitle(a)" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span>&nbsp;Mover</button>
                        } @else if (!noSePuedePagar(a)) {
                          <button pButton type="button" class="p-button-sm p-button-secondary" [class.p-button-outlined]="!prepared(a)" [class.p-button-text]="prepared(a)"
                                  (click)="openPrepare(a)" [attr.aria-label]="(prepared(a) ? 'Cambiar cómo sale el pago de ' : 'Preparar el pago de ') + allocationTitle(a)">{{ prepared(a) ? 'Cambiar' : 'Preparar' }}</button>
                        }
                        <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-x" [disabled]="saving()" [attr.aria-label]="'Quitar del día a ' + allocationTitle(a)" (click)="quitarObjetivo.set(a)"><span class="pi pi-times" aria-hidden="true"></span></button>
                      } @else if (a.status === 'pending') {
                        <!-- [PGP.70] Abre el MISMO diálogo que el lote, con este pago solo: marcar no se deshace aquí. -->
                        <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="!prepared(a) || saving()" (click)="abrirPagar(a)" [attr.aria-label]="'Marcar pagado el pago de ' + allocationTitle(a)">Pagado</button>
                        <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'El pago de ' + allocationTitle(a) + ' rebotó'" (click)="openRebote(a)">Rebotó…</button>
                      } @else if (a.status === 'failed') {
                        <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [attr.aria-label]="'Mover a otro día el pago de ' + allocationTitle(a)" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span>&nbsp;Mover</button>
                      }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #expandedrow let-a>
                  <tr class="pg-xrow">
                    <td colspan="7">
                      <!-- [PGP.52] El desglose junta lo que antes llenaba el renglón: por qué se paga hoy, las
                           notas, lo que el ERP ya no debe y cada factura con lo que se le aplica. -->
                      <div class="pg-x-info">
                        @if (razonDePago(a); as r) {
                          <p class="pg-razon" [class.is-gana]="r.tono === 'gana'" [class.is-urge]="r.tono === 'urge'" [class.is-tarde]="r.tono === 'tarde'" [class.is-mudo]="r.tono === 'mudo'">
                            <i class="pi" [class.pi-arrow-up-right]="r.tono === 'gana'" [class.pi-clock]="r.tono === 'urge'" [class.pi-hourglass]="r.tono === 'tarde'" [class.pi-question-circle]="r.tono === 'mudo'" aria-hidden="true"></i>{{ r.texto }}.
                            <span class="pg-x-d">{{ r.detalle }}</span>
                          </p>
                        }
                        @if (a.kepler_cierre?.pagos?.length) {
                          <!-- [PGP.96] Qué hizo Kepler con este pago, documento por documento (kdxf: el pago aplicado a la factura). -->
                          <div class="pg-cierre-x">
                            <p class="pg-x-d">{{ textoCierre(a.kepler_cierre!) }}. Lo registró Kepler; la Suite no lo marcó, lo lee.</p>
                            <ul class="pg-cierre-l" [attr.aria-label]="'Documentos de Kepler del pago de ' + allocationTitle(a)">
                              @for (p of a.kepler_cierre!.pagos; track p.sucursal + p.doc_prefix + p.folio) {
                                <li>
                                  <span>{{ nombreTipo(p.tipo) }} <span class="comm-num">{{ p.doc_prefix }}-{{ p.folio }}</span></span>
                                  <span>{{ branchLabel(p.sucursal) }}</span>
                                  <span class="comm-num">{{ p.fecha ? shortDate(p.fecha) : 'sin fecha' }}</span>
                                  <span>{{ p.cuenta_nombre || p.cuenta || 'sin cuenta' }}</span>
                                  <span class="comm-num">{{ money(p.aplicado) }}</span>
                                  @if (p.comprobante_id) {
                                    <button type="button" class="pg-saldada-btn" (click)="abrirComprobante(p)"
                                            [attr.aria-label]="'Ver el comprobante PDF del pago ' + p.doc_prefix + '-' + p.folio"><i class="pi pi-file-pdf" aria-hidden="true"></i> PDF</button>
                                  } @else if (sinPdfPorque(p); as porque) {
                                    <span class="pg-x-d">{{ porque }}</span>
                                  }
                                </li>
                              }
                            </ul>
                          </div>
                        } @else if (a.kepler_saldadas > 0) {
                          <p class="pg-x-d">Al armar el día el ERP debía estas facturas. Hoy ya no: se pagaron por fuera o tienen nota de crédito, y marcarlas como pagadas fallaría.</p>
                        }
                        @if (numero(a.discount_total) > 0) {
                          <!-- [PGP.91] Lo que significa el neto: sin esto, una factura «cubierta» con menos dinero se lee como pago parcial. -->
                          <p class="pg-x-d">Se transfiere el neto. El descuento lo formaliza el proveedor después con una nota de crédito en Kepler; mientras llega, lo que este pago cubre de cada factura con descuento (neto + descuento) queda cubierto y no se vuelve a ofrecer.</p>
                        }
                        @if (a.notes) { <p class="cal-notes">{{ a.notes }}</p> }
                      </div>
                      <table class="pg-items-t">
                        <caption class="sr-only">Facturas del pago de {{ allocationTitle(a) }}</caption>
                        <!-- [PGP.58] Cada factura se UBICA (folio de Kepler, que abre su ficha, y la referencia
                             del proveedor) y se VE (su archivo, PDF o foto del comprobante) sin salir del pago. -->
                        <thead><tr><th>Sucursal</th><th>Folio Kepler</th><th>Referencia</th><th>Factura</th><th class="r">Se aplica</th>@if (a.status === 'pending' && !isReleased()) { <th class="pg-it-acc"><span class="sr-only">Acciones</span></th> }</tr></thead>
                        <tbody>
                          @for (it of a.items; track it.id) {
                            <tr>
                              <td>{{ branchLabel(it.branch_code) }}</td>
                              <td>
                                @if (it.entity_ref) {
                                  <button type="button" class="cal-reflink comm-num" (click)="inspect.set(it.entity_ref!)" [attr.aria-label]="'Abrir la ficha del documento ' + it.concept + ' de ' + it.beneficiary">{{ it.concept }}</button>
                                } @else { <span class="comm-num">{{ it.concept }}</span> }
                                @if (it.beneficiary !== a.items[0].beneficiary) { · {{ it.beneficiary }} }@if (it.kepler_saldada) { · <span class="pg-it-sald">el ERP ya no la debe</span> }
                              </td>
                              <td class="comm-num">{{ it.doc_ref || '—' }}</td>
                              <td>
                                <!-- Ausente = el backend todavía no la manda: NO MEDIDO, no «sin documento» (ADR-056). -->
                                @if (it.entity_ref === undefined) {
                                  <span class="pg-ev">—</span>
                                } @else if (!it.entity_ref) {
                                  <span class="pg-ev pg-ev-no"><i class="pi pi-info-circle" aria-hidden="true"></i>sin documento de Kepler</span>
                                } @else if (evidenciaDeItem(it); as e) {
                                  @if (e.evidencia === 'pdf') {
                                    <button type="button" class="pg-ev pg-ev-pdf" [attr.aria-label]="'Ver la factura de ' + it.beneficiary + ' ' + it.concept" (click)="abrirFactura(e)"><i class="pi pi-file-pdf" aria-hidden="true"></i>Ver la factura</button>
                                  } @else if (e.evidencia === 'uuid') {
                                    <span class="pg-ev pg-ev-uuid"><i class="pi pi-id-card" aria-hidden="true"></i>sin archivo; hay UUID</span>
                                  } @else {
                                    <span class="pg-ev pg-ev-no"><i class="pi pi-info-circle" aria-hidden="true"></i>sin factura: {{ e.motivo }}</span>
                                  }
                                } @else if (evidenciaBuscada(it)) {
                                  <span class="pg-ev pg-ev-no"><i class="pi pi-info-circle" aria-hidden="true"></i>sin registro de su papel</span>
                                } @else if (evidenciaFallo()) {
                                  <span class="pg-ev pg-ev-no"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>no se pudo buscar</span>
                                } @else {
                                  <span class="pg-ev">buscando…</span>
                                }
                              </td>
                              <td class="r comm-num">{{ money(it.applied_amount) }}
                                <!-- [PGP.91] Lo que sale es el neto; sólo si hay descuento se dice de cuánto era la factura,
                                     cuánto se descontó y por qué. Sin columna aparte: «Factura» ya es el archivo (PGP.58). -->
                                @if (numero(it.discount_amount) > 0) {
                                  <span class="pg-dsc">de {{ money(cubiertoDe(it)) }} − descuento {{ money(it.discount_amount) }} · {{ motivoDescuento(it.discount_reason, it.discount_rate, it.discount_note) }}</span>
                                }
                              </td>
                              @if (a.status === 'pending' && !isReleased()) {
                                <td class="pg-it-acc">
                                  @if (admiteDescuento(a, it)) {
                                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary"
                                            [disabled]="saving() || loadingWeek()"
                                            [attr.aria-label]="(numero(it.discount_amount) > 0 ? 'Cambiar el descuento al pagar de ' : 'Capturar un descuento al pagar en ') + nombreFactura(it)"
                                            (click)="abrirDescuento(a, it)">Descuento</button>
                                  }
                                  <!-- [PGP.92] Quitar SÓLO esta factura. Con una sola no sale: el servidor no deja vaciar un
                                       pago, y para quitarlo entero está la ✕ del renglón (PGP.70). -->
                                  @if (a.items.length > 1) {
                                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-x"
                                            [disabled]="saving() || loadingWeek()"
                                            [attr.aria-label]="'Quitar sólo ' + nombreFactura(it) + ' del pago de ' + allocationTitle(a)"
                                            (click)="quitarFacturaObjetivo.set({ a: a, it: it })"><span class="pi pi-times" aria-hidden="true"></span></button>
                                  }
                                </td>
                              }
                            </tr>
                          }
                        </tbody>
                        <tfoot><tr><td colspan="4">{{ facturas(a.items.length) }}@if (numero(a.discount_total) > 0) {<span class="pg-dsc-pie"> · cubren {{ money(numero(a.amount_assigned) + numero(a.discount_total)) }} con {{ money(a.discount_total) }} de descuento</span>}</td><td class="r comm-num">{{ money(a.amount_assigned) }}</td>@if (a.status === 'pending' && !isReleased()) { <td></td> }</tr></tfoot>
                      </table>
                    </td>
                  </tr>
                </ng-template>
              </p-table>

              @if (isReleased()) {
                <!-- [PGP.13] El testigo del ERP: OTRO universo (suma por fecha, no casa renglones). -->
                <p class="pg-erp">
                  <span class="pg-erp-l">El ERP registra ese día</span>
                  @if (day.libro; as lb) {
                    @if (lb.n > 0 || lb.data_as_of || !isPast(day.date)) {
                      <b class="comm-num">{{ money(lb.monto) }}</b> en {{ pagos(lb.n) }} · suma por fecha, no casa renglón por renglón: es otro universo.
                    } @else { <b>sin medir</b> · el espejo del ERP no trae fecha de corte para este día. }
                  } @else { <b>sin medir</b> · el espejo del ERP no trae fecha de corte para este día. }
                </p>
              }
            }
          </section>
          </ng-template>
        }
      </main>
    </div>

    <!-- ── [PGP.17] Los descuentos de un acreedor: LOS DOS CASOS ──────────────────────────
         Pedido de Edgar: «especificando todo tipo de descuento para que sepan que aplicar
         desde Suite». Se muestra lo YA APLICADO a proposito: sin eso, un proceso que funciona
         -las notas de credito se netean casi al 100%- se lee como que el sistema no hace nada. -->
    <app-side-peek [open]="!!creditoAbierto()" (openChange)="$event || creditoAbierto.set(null)"
                   [width]="640"
                   [title]="'Descuentos de ' + (creditoAbierto()?.nombre || '')"
                   [subtitle]="creditoAbierto()?.code || null">
      <app-load-state [loading]="creditoCargando()" [error]="creditoError()" [skeletonRows]="4">
        <div class="pg-cr">
          <p class="pg-cr-why">
            Lo que Kepler casa contra las facturas de este acreedor. <b>Cheques y transferencias no
            están aquí</b>: son pagos, no descuentos.
          </p>

          <div class="pg-cr-tot">
            <span><b class="comm-num">{{ money(creditoTotalPendiente()) }}</b> sin aplicar · {{ creditoPendientes().length }} {{ creditoPendientes().length === 1 ? 'documento' : 'documentos' }}</span>
            <span class="cal-muted"><b class="comm-num">{{ money(creditoTotalAplicado()) }}</b> ya aplicado por Kepler</span>
          </div>

          @if (creditoPendientes().length) {
            <h3 class="pg-cr-h">Sin aplicar — esto es lo que se puede descontar del pago</h3>
            @for (d of creditoPendientes(); track d.clase + d.folio + d.sucursal) {
              <div class="pg-cr-row is-pend">
                <span class="pg-cr-main">
                  <span class="cal-benef">{{ d.clase }}<span class="pg-dr-amt comm-num">{{ money(d.a_favor) }}</span></span>
                  <span class="pg-sub"><span class="cal-suc">{{ branchLabel(d.sucursal) }}</span>folio {{ d.folio }}@if (d.referencia) { <span class="cal-ref">{{ d.referencia }}</span> }@if (d.fecha) { · {{ shortDate(d.fecha) }} }</span>
                  @if (d.aplicado > 0) {
                    <!-- El caso mas comun: se aplico un pedazo y sobró el resto. -->
                    <span class="pg-cr-part">de {{ money(d.importe) }} se aplicaron {{ money(d.aplicado) }} y sobró el resto</span>
                  }
                </span>
              </div>
            }
          } @else {
            <p class="pg-cr-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> No queda nada por aplicar de este acreedor.</p>
          }

          @if (creditoAplicados().length) {
            <h3 class="pg-cr-h">Ya aplicado por Kepler — no hay que hacer nada</h3>
            <p class="pg-cr-why">Estos ya redujeron la deuda: por eso esas facturas no aparecen, o aparecen con menos saldo, en la lista.</p>
            @for (d of creditoAplicados(); track d.clase + d.folio + d.sucursal) {
              <div class="pg-cr-row">
                <span class="pg-cr-main">
                  <span class="pg-sub"><b>{{ d.clase }}</b> <span class="cal-suc">{{ branchLabel(d.sucursal) }}</span>folio {{ d.folio }}@if (d.referencia) { <span class="cal-ref">{{ d.referencia }}</span> }@if (d.fecha) { · {{ shortDate(d.fecha) }} }</span>
                </span>
                <span class="comm-num cal-muted">{{ money(d.aplicado) }}</span>
              </div>
            }
          }

          <p class="pg-cr-decl">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            Aplicar una nota de crédito o un anticipo <b>que ya existe</b> contra una factura se hace
            <b>en Kepler</b>: la Suite todavía no escribe ese movimiento. Esta pantalla dice <b>qué
            hay</b> y <b>cuánto</b>, para que no se pague de más. El descuento que el proveedor
            concede <b>al pagar</b> se captura en el desglose del pago. Las cifras son un <b>piso</b>: el casamiento del ERP sobre-cuenta lo
            aplicado, así que lo pendiente real puede ser mayor.
          </p>
        </div>
      </app-load-state>
    </app-side-peek>

    <!-- Dialog: agregar con otro importe u otro dia -->
    <!-- [PGP.15] CUALQUIER fecha, con lo que cabe ESE dia a la vista. Era un desplegable con los 7 dias
         de la semana cargada -no se podia programar la siguiente- que ademas se abria DENTRO del
         dialogo: lo recortaba, le metia una barra de desplazamiento y tapaba el importe. -->
    <p-dialog [(visible)]="quickAddVisible" [modal]="true" header="Agregar con otro importe u otro día" [style]="{ width: '28rem' }">
      @if (quickAddTarget(); as o) {
        <p class="cal-dlg-p"><strong>{{ o.beneficiary }}</strong> — {{ o.concept }}</p>
        <p class="cal-dlg-hint">Por pagar de esta factura: <b class="comm-num">{{ money(o.available_amount) }}</b></p>
        <label class="cal-dlg-label" for="cal-quick-day">Día de pago</label>
        <input id="cal-quick-day" type="date" [min]="todayIso" [ngModel]="targetDate" (ngModelChange)="elegirDiaDestino($event)" class="cal-date-input cal-dlg-full" />
        <label class="cal-dlg-label" for="cal-quick-amt">Importe</label>
        <!-- [PGP.48] Texto con teclado decimal: type=number rechazaba «1,250.00» por la coma (Postel). -->
        <input id="cal-quick-amt" pInputText type="text" inputmode="decimal" autocomplete="off" [(ngModel)]="quickAddAmount" class="cal-dlg-full comm-num" />
        <p class="pg-dlg-cap" aria-live="polite">
          @if (!targetDate) {
            Elige el día.
          } @else if (destinoCargando()) {
            Leyendo el tope del {{ dayLong(targetDate) }}…
          } @else if (destinoError(); as err) {
            <b>No se pudo leer el tope de ese día</b> ({{ err }}). Se puede agregar igual; el día dirá si cabe.
          } @else if (destino(); as s) {
            @if (diaCerrado(s.lot_status)) {
              <b class="cal-bad-txt">El {{ dayLong(targetDate) }} ya está autorizado: no se le pueden agregar pagos.</b>
            } @else if (!s.capacity_defined) {
              El {{ dayLong(targetDate) }} <b>no tiene tope fijado</b>: se puede agregar, pero el día no se autoriza hasta que Presupuestos lo fije.
            } @else {
              Libre ese día: <b class="comm-num">{{ money(s.remaining_amount) }}</b> de {{ money(s.authorized_amount) }}.
              @if (quedaDestino() < -0.005) {
                <b class="cal-bad-txt">Con este importe el día se excede por {{ money(-quedaDestino()) }}.</b>
              } @else if (importeQuick() > 0) {
                Quedarían <b class="comm-num">{{ money(quedaDestino()) }}</b>.
              }
            }
          }
          @if (importeQuick() > numero(o.available_amount) + 0.005) { <b class="cal-bad-txt">El importe pasa de lo que se debe de esta factura.</b> }
        </p>
        <div class="cal-dlg-actions">
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="quickAddVisible = false">Cancelar</button>
          <button pButton type="button" (click)="confirmQuickAdd()" [loading]="saving()" [disabled]="!quickAddValido()">@if (targetDate) { Agregar al {{ dayLong(targetDate) }} } @else { Agregar }</button>
        </div>
      }
    </p-dialog>

    <!-- Dialog: preparar UN pago (lo que pide el layout del banco) -->
    <p-dialog [(visible)]="prepareVisible" [modal]="true" header="Preparar pago" [style]="{ width: '32rem' }">
      @if (prepAllocation; as a) {
        <p class="cal-dlg-p"><strong>{{ allocationTitle(a) }}</strong> · {{ money(a.amount_assigned) }}</p>
      }
      <label class="cal-dlg-label" for="cal-prep-method">Método de pago</label>
      <p-select appendTo="body" inputId="cal-prep-method" [options]="methodOpts" [(ngModel)]="prepMethod" optionLabel="label" optionValue="value" placeholder="Método" [fluid]="true" class="cal-dlg-sel" />
      <!-- [PGP.30] De dónde salió lo precargado. Un valor puesto solo, sin decir con qué, es una
           orden disfrazada: acá va su evidencia para poder contradecirla de un vistazo. -->
      @if (habitoUsado(); as h) {
        <p class="cal-dlg-hint cal-habito">
          <i class="pi pi-history" aria-hidden="true"></i>
          Precargado de su historial: así se le pagó <b>{{ h.metodo_veces }} de {{ h.metodo_de }}</b> veces@if (h.metodo_ultima_vez) {, la última el {{ h.metodo_ultima_vez }}}@if (h.cuenta_origen_nombre) {, desde <b>{{ h.cuenta_origen_nombre }}</b> ({{ h.cuenta_veces }} de {{ h.cuenta_de }})}. Cámbialo si hoy va distinto.
        </p>
      } @else if (habitosError()) {
        <p class="cal-dlg-hint cal-habito-nm">No se pudo leer con qué se le suele pagar. Elige a mano.</p>
      } @else if (prepHabito(); as h) {
        @if (h.cuenta_estado === 'caja_general') {
          <!-- [PGP.33] Decia «…, que no es cuenta de origen de una transferencia». Medido contra
               prod: 2,771 pagos ($54,897,784) salieron de Caja General y Kepler mismo los clasifica
               como caja. La vista ya no emite este estado -- la rama queda por si una pestana abierta
               desde antes del despliegue todavia lo recibe, y ahora dice la verdad. -->
          <p class="cal-dlg-hint cal-habito">A este proveedor se le suele pagar <b>desde Caja General</b> ({{ h.cuenta_veces }} de {{ h.cuenta_de }}). Elígela en el desplegable si hoy va igual.</p>
        } @else if (h.metodo_estado === 'variable') {
          <p class="cal-dlg-hint cal-habito">No se precargó: a este proveedor se le ha pagado de varias formas ({{ h.metodo_veces }} de {{ h.metodo_de }} con la más usada).</p>
        }
      }
      @if (prepMethod === 'transferencia' || prepMethod === 'cargo_automatico' || prepMethod === 'cheque') {
        <label class="cal-dlg-label" for="cal-prep-origin">Cuenta de origen (de dónde sale el dinero)</label>
        <p-select appendTo="body" inputId="cal-prep-origin" [options]="originOpts()" [(ngModel)]="prepOriginId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta de Mega Dulces…" [filter]="true" filterBy="label" [fluid]="true" class="cal-dlg-sel" />
      }
      @if (prepMethod === 'transferencia' || prepMethod === 'cargo_automatico') {
        @if (prepAccounts().length) {
          <label class="cal-dlg-label" for="cal-prep-dest">Cuenta destino del catálogo del proveedor</label>
          <p-select appendTo="body" inputId="cal-prep-dest" [options]="prepAccounts()" [(ngModel)]="prepAccountId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [showClear]="true" [fluid]="true" class="cal-dlg-sel" />
        } @else if (prepAccountsError()) {
          <p class="cal-dlg-hint"><b>No se pudo leer el catálogo de cuentas del proveedor ({{ prepAccountsError() }}).</b> Captura la CLABE abajo.</p>
        } @else if (prepPedida(); as p) {
          <!-- [PGP.46] La CLABE ya se capturó antes y está esperando aprobación. Se propone con
               su procedencia: un valor puesto solo, sin decir con qué, es una orden disfrazada. -->
          <p class="cal-dlg-hint cal-habito">
            <i class="pi pi-clock" aria-hidden="true"></i>
            Precargada de una captura anterior: <b>{{ p.banco && !p.banco.startsWith('(') ? p.banco + ' · ' : '' }}{{ p.clabe }}</b>@if (p.quien) {, la capturó <b>{{ p.quien }}</b>}@if (p.cuando) { el {{ p.cuando }}}. <b>Todavía no la aprueba Compras</b>, así que revísala antes de pagar; si no es ésta, bórrala y escribe la correcta.
          </p>
        } @else if (prepSupplierId) {
          <p class="cal-dlg-hint">Este proveedor no tiene cuentas en el catálogo. Captura la CLABE abajo; queda <b>pedida de alta sola</b> para que no haya que teclearla otra vez. La aprueba Dirección desde «Cuentas de pago»; mientras tanto, el pago sale igual.</p>
        }
        <label class="cal-dlg-label" for="cal-prep-clabe">Cuenta destino — banco y CLABE (si no está en el catálogo)</label>
        <input id="cal-prep-clabe" pInputText type="text" [(ngModel)]="prepDestination" [disabled]="!!prepAccountId" placeholder="Ej. BBVA · CLABE 012180001234567891" class="cal-dlg-full" />
        @if (prepDestHistorial && prepDestination === prepDestHistorial && prepAllocation) {
          <!-- [PGP.75] Un valor puesto solo, sin decir con qué, es una orden disfrazada (PGP.30): se dice de dónde salió. -->
          <p class="cal-dlg-hint cal-habito"><i class="pi pi-history" aria-hidden="true"></i> Precargada de sus comprobantes de pago: {{ sugerencias().get(prepAllocation.id)?.porque }}. Revísala antes de pagar; al guardar queda pedida de alta en el catálogo.</p>
        }
        <p class="cal-dlg-hint">Si escribes una CLABE de 18 dígitos se valida su dígito de control.</p>
      }
      @if (prepMethod === 'cheque') {
        <label class="cal-dlg-label" for="cal-prep-ref">Folio del cheque</label>
        <input id="cal-prep-ref" pInputText type="text" [(ngModel)]="prepReference" placeholder="Folio" class="cal-dlg-full" />
      }
      @if (prepMethod === 'efectivo') {
        <label class="cal-dlg-label" for="cal-prep-cash">Caja de salida</label>
        <input id="cal-prep-cash" pInputText type="text" [(ngModel)]="prepCash" placeholder="Caja" class="cal-dlg-full" />
        <!-- [PGP.33] Se dice ANTES de elegirlo. Kepler (kdm1.c31) sólo distingue transferencia,
             cheque y anticipo: medido el 2026-10-29, de 4,898 pagos a proveedor hay CERO
             registrados como efectivo. Quien concilie después contra el ERP no va a encontrar
             este pago rotulado así, y sin este aviso lo leería como un error de captura. -->
        <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-info-circle" aria-hidden="true"></i> Kepler no distingue «efectivo»: el <b>X-D-26</b> va a quedar rotulado <b>transferencia</b> aunque el dinero salga de la caja. Acá queda bien; al conciliar contra el ERP, cuenta con eso.</p>
      }
      <div class="cal-dlg-actions"><button pButton type="button" class="p-button-text p-button-secondary" (click)="prepareVisible = false">Cancelar</button><button pButton type="button" (click)="confirmPrepare()" [loading]="saving()">Guardar</button></div>
    </p-dialog>

    <!-- Dialog: marcar pagados (Caja General). Irreversible aqui: friccion proporcional, un solo paso. -->
    <p-dialog [(visible)]="pagarVisible" [modal]="true" [header]="pagarSolo() ? 'Marcar como pagado' : 'Marcar como pagados'" [style]="{ width: '32rem' }">
      <p class="cal-dlg-p">{{ pagarLista().length === 1 ? 'Se marca' : 'Se marcan' }} <b>{{ pagos(pagarLista().length) }}</b> por <b class="comm-num">{{ money(pagarListaTotal()) }}</b>. Marca sólo lo que el banco ya confirmó: <b>un pago marcado no se deshace aquí</b>. {{ pagarLista().length === 1 ? 'Si rebotó, cancela y márcalo' : 'Si alguno rebotó, cancela y márcalo' }} «Rebotó…» en su fila.</p>
      <ul class="pg-dlg-list">
        @for (a of pagarLista(); track a.id) {
          <li [class.is-saldada]="a.kepler_saldadas > 0">
            <span><span class="comm-num pg-dlg-fol">{{ a.folio || a.priority_rank }}</span> {{ allocationTitle(a) }}
              @if (a.kepler_saldadas > 0) {
                <span class="pg-dlg-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>va a fallar: el ERP ya no debe {{ a.kepler_saldadas === 1 ? 'su factura' : a.kepler_saldadas + ' de sus facturas' }}</span>
              }
            </span><b class="comm-num">{{ money(a.amount_assigned) }}</b></li>
        }
      </ul>
      <!-- [PGP.35] Se dice ANTES de apretar (DESIGN §10 poka-yoke): el servidor revalida el saldo
           y rechaza esos pagos, pero enterarse por N errores seguidos es el ultimo recurso. -->
      @if (pagarListaSaldadas(); as n) {
        @if (n > 0) {
          <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ pagarLista().length === 1 ? 'Este pago va a fallar' : n === 1 ? '1 de estos pagos va a fallar' : n + ' de estos pagos van a fallar' }}: el ERP ya no debe sus facturas (se pagaron por fuera o tienen nota de crédito).{{ pagarLista().length === 1 ? '' : ' Los demás sí se marcan.' }}</p>
        }
      }
      <div class="cal-dlg-actions">
        <button pButton type="button" class="p-button-text p-button-secondary" (click)="pagarVisible = false">Cancelar</button>
        <button pButton type="button" [disabled]="!pagarLista().length || saving()" [loading]="saving()" (click)="confirmPagar()">{{ pagarLista().length === 1 ? 'Marcar pagado' : 'Marcar ' + pagos(pagarLista().length) }}</button>
      </div>
    </p-dialog>

    <!-- [PGP.70] Quitar un pago del día. Era la ✕ de la fila con UN clic, sin deshacer: se perdía la
         preparación (método y cuentas) y, para volver a pagarlo, había que buscar y agregar sus facturas
         otra vez. Si lo que cambia es la fecha, «Mover a otro día» conserva la preparación. -->
    <p-dialog [visible]="!!quitarObjetivo()" (visibleChange)="$event || quitarObjetivo.set(null)" [modal]="true" header="Quitar del día" [style]="{ width: '30rem' }">
      @if (quitarObjetivo(); as a) {
        <p class="cal-dlg-p"><strong>{{ allocationTitle(a) }}</strong> · <span class="comm-num">{{ money(a.amount_assigned) }}</span></p>
        <p class="cal-dlg-hint">{{ a.items.length === 1 ? 'Su factura regresa' : 'Sus ' + a.items.length + ' facturas regresan' }} a lo que se debe. Para pagarlo otro día habría que volver a agregar{{ a.items.length === 1 ? 'la' : 'las' }} con «Agregar facturas».</p>
        @if (prepared(a)) {
          <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Se pierde su preparación: {{ comoSale(a).texto }}. Si sólo cambia la fecha, muévelo: conserva método y cuentas.</p>
        }
        @if (numero(a.discount_total) > 0) {
          <!-- [PGP.91] El descuento al pagar vive en la factura del pago: quitar el pago lo borra; moverlo, no. -->
          <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Se pierde su descuento al pagar (−{{ money(a.discount_total) }}): si lo vuelves a armar hay que capturarlo otra vez. Moverlo a otro día lo conserva.</p>
        }
        <div class="cal-dlg-actions">
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="quitarObjetivo.set(null)">Cancelar</button>
          <button pButton type="button" class="p-button-outlined p-button-secondary" [disabled]="saving()" (click)="quitarObjetivo.set(null); openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span>&nbsp;Mover a otro día</button>
          <button pButton type="button" class="p-button-danger" [disabled]="saving()" [loading]="saving()" (click)="confirmarQuitar()">Quitar del día</button>
        </div>
      }
    </p-dialog>

    <!-- [PGP.92] Quitar UNA factura del pago. El pago, su orden y su preparación se quedan; la factura
         regresa a lo que se debe. Se confirma como la ✕ del renglón (PGP.70): las ✕ del desglose quedan
         cerca una de otra y no hay deshacer. -->
    <p-dialog [visible]="!!quitarFacturaObjetivo()" (visibleChange)="$event || quitarFacturaObjetivo.set(null)" [modal]="true" header="Quitar una factura del pago" [style]="{ width: '30rem' }">
      @if (quitarFacturaObjetivo(); as q) {
        <p class="cal-dlg-p"><strong>{{ nombreFactura(q.it) }}</strong> · {{ branchLabel(q.it.branch_code) }} · <span class="comm-num">{{ money(q.it.applied_amount) }}</span></p>
        <!-- Una factura que el ERP ya no debe NO regresa a la deuda: la deuda sólo trae lo pendiente. -->
        <p class="cal-dlg-hint">@if (q.it.kepler_saldada) {<span>El ERP ya no la debe: sale del pago y no regresa a la deuda.</span>} @else {<span>Regresa a lo que se debe.</span>} El pago de {{ allocationTitle(q.a) }} sigue en el día con {{ facturas(q.a.items.length - 1) }} por <b class="comm-num">{{ money(restaDelPago(q.a, q.it)) }}</b>@if (prepared(q.a)) {<span>, y conserva su preparación</span>}.</p>
        @if (numero(q.it.discount_amount) > 0) {
          <!-- [PGP.91] Quitar la factura borra su descuento al pagar: volver a agregarla la trae completa. -->
          <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Se pierde su descuento al pagar (−{{ money(q.it.discount_amount) }}, {{ motivoDescuento(q.it.discount_reason, q.it.discount_rate, q.it.discount_note) }}): si la vuelves a agregar hay que capturarlo otra vez.</p>
        }
        <div class="cal-dlg-actions">
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="quitarFacturaObjetivo.set(null)">Cancelar</button>
          <button pButton type="button" class="p-button-danger" [disabled]="saving()" [loading]="saving()" (click)="confirmarQuitarFactura()">Quitar la factura</button>
        </div>
      }
    </p-dialog>

    <!-- [PGP.91] Descuento al pagar de UNA factura del pago. El proveedor lo concede al pagar: se transfiere
         el NETO, lo que este pago cubre de la factura queda CUBIERTO (neto + descuento; con «Agregar con otro
         importe» es sólo una parte) y no se vuelve a ofrecer; la nota de crédito
         la emite el proveedor después en Kepler. Lo cubierto no cambia aquí: baja lo que sale del banco. -->
    <p-dialog [visible]="!!descObjetivo()" (visibleChange)="$event || cerrarDescuento()" [modal]="true" header="Descuento al pagar" [style]="{ width: '32rem' }">
      @if (descObjetivo(); as t) {
        <p class="cal-dlg-p"><strong>{{ nombreFactura(t.it) }}</strong> · {{ branchLabel(t.it.branch_code) }} · {{ allocationTitle(t.a) }}</p>
        <p class="cal-dlg-hint">Se transfiere el neto y lo que este pago cubre de la factura queda cubierto (neto + descuento): no se vuelve a ofrecer. La nota de crédito del descuento la emite el proveedor después en Kepler. El % va sobre lo que este pago cubre de la factura, con IVA.</p>
        <!-- R4: los datos no detectan una nota de crédito ya aplicada a ESTE descuento; se dice antes de capturar. -->
        <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Si Kepler ya trae la nota de crédito de este descuento, no lo captures aquí: se descontaría dos veces.</p>
        <label class="cal-dlg-label" for="cal-dsc-mot">Motivo</label>
        <p-select appendTo="body" inputId="cal-dsc-mot" [options]="descuentoOpts" [ngModel]="descMotivo() === 'ninguno' ? null : descMotivo()" (ngModelChange)="elegirMotivoDescuento($event)"
                  optionLabel="label" optionValue="value" placeholder="Elige el motivo" [fluid]="true" class="cal-dlg-sel" />
        @if (descMotivo() === 'pronto_pago') {
          <!-- [PGP.30] De dónde salió lo precargado: la tasa OBSERVADA, nunca la pactada (D2). -->
          @if (t.it.pronto_tasa == null) {
            <p class="cal-dlg-hint cal-habito">Sin descuento medido para esta factura: captura el que te dio.</p>
          } @else {
            <p class="cal-dlg-hint cal-habito"><i class="pi pi-history" aria-hidden="true"></i>
              @if (descSugerida()) {<span>Sugerido: </span>} @else {<span>Lo observado: </span>}<b>{{ pct(t.it.pronto_tasa) }}</b> es lo que este proveedor de hecho nos descontó en los últimos 12 meses (observado, no pactado). Confírmalo con el proveedor.</p>
            @if (t.it.pronto_estado === 'fuera_de_ventana') {
              <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Ya se pasó la ventana observada@if (t.it.pronto_fecha_limite) {<span> (cerraba el {{ shortDate(t.it.pronto_fecha_limite) }})</span>}. No está perdido, pero confirma que todavía lo da.</p>
            }
          }
        }
        <div class="pg-dsc-campos">
          <div>
            <label class="cal-dlg-label" for="cal-dsc-pct">Porcentaje (%)</label>
            <input id="cal-dsc-pct" pInputText type="text" inputmode="decimal" autocomplete="off" class="cal-dlg-full comm-num"
                   [ngModel]="descModo() === 'tasa' ? descPct() : (descCuenta().tasa ? (descCuenta().tasa! * 100).toFixed(2) : '')"
                   (ngModelChange)="descModo.set('tasa'); descPct.set($event); descPesos.set(''); descSugerida.set(false)" />
          </div>
          <div>
            <label class="cal-dlg-label" for="cal-dsc-mxn">o en pesos</label>
            <input id="cal-dsc-mxn" pInputText type="text" inputmode="decimal" autocomplete="off" class="cal-dlg-full comm-num"
                   [ngModel]="descModo() === 'pesos' ? descPesos() : (descCuenta().descuento > 0 ? descCuenta().descuento.toFixed(2) : '')"
                   (ngModelChange)="descModo.set('pesos'); descPesos.set($event); descPct.set(''); descSugerida.set(false)" />
          </div>
        </div>
        @if (descMotivo() === 'otro') {
          <label class="cal-dlg-label" for="cal-dsc-nota">Detalle (obligatorio con «Otro»)</label>
          <input id="cal-dsc-nota" pInputText type="text" autocomplete="off" class="cal-dlg-full" [ngModel]="descNota()" (ngModelChange)="descNota.set($event)" />
        }
        <p class="pg-dlg-cap" aria-live="polite">Este pago cubre <b class="comm-num">{{ money(descCubierto()) }}</b> − descuento <b class="comm-num">{{ money(descCuenta().descuento) }}</b> = se transfieren <b class="comm-num">{{ money(descCuenta().neto) }}</b>.@if (descFalta(); as f) {<span> {{ f }}</span>}</p>
        <div class="cal-dlg-actions">
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="cerrarDescuento()">Cancelar</button>
          @if (numero(t.it.discount_amount) > 0) {
            <button pButton type="button" class="p-button-outlined p-button-secondary" [disabled]="saving()" (click)="guardarDescuento(true)"
                    [attr.aria-label]="'Quitar el descuento al pagar de ' + nombreFactura(t.it)">Quitar el descuento</button>
          }
          <button pButton type="button" [disabled]="descMotivo() === 'ninguno' || !!descFalta() || saving()" [loading]="saving()" (click)="guardarDescuento(false)">Guardar</button>
        </div>
      }
    </p-dialog>

    <!-- [PGP.51] Quitar lo que el ERP ya no debe: qué sale, completo o en parte, antes de apretar. -->
    <p-dialog [visible]="saldadasVisible()" (visibleChange)="saldadasVisible.set($event)" [modal]="true" header="Quitar lo que el ERP ya no debe" [style]="{ width: '34rem' }">
      <p class="cal-dlg-p">De lo comprometido hoy, el ERP ya no debe <b class="comm-num">{{ money(saldadasDelDiaTotal()) }}</b>: se pagó por fuera o tiene nota de crédito, y marcarlo pagado fallaría.</p>
      <ul class="pg-dlg-list">
        @for (a of saldadasDelDia(); track a.id) {
          <li><span>{{ allocationTitle(a) }} <span class="pg-dlg-a">{{ noSePuedePagar(a) ? 'sale del día' : 'pierde ' + a.kepler_saldadas + ' de sus ' + a.items.length + ' facturas' }}</span></span><b class="comm-num">{{ money(a.kepler_saldadas_importe) }}</b></li>
        }
      </ul>
      <p class="cal-dlg-hint">Es la misma ✕ de cada fila, para todos a la vez. Lo que sí se debe se queda en el día.</p>
      <div class="cal-dlg-actions">
        <button pButton type="button" class="p-button-text p-button-secondary" (click)="saldadasVisible.set(false)">Cancelar</button>
        <button pButton type="button" [loading]="saving()" [disabled]="saving() || !saldadasDelDia().length" (click)="quitarTodoLoSaldado()">Quitar {{ money(saldadasDelDiaTotal()) }}</button>
      </div>
    </p-dialog>

    <!-- Dialog: el pago rebotó. Marca y mueve en UN paso: eran dos acciones en dos lugares. -->
    <p-dialog [(visible)]="reboteVisible" [modal]="true" header="El pago rebotó" [style]="{ width: '26rem' }">
      @if (reboteAllocation; as a) {
        <p class="cal-dlg-p"><strong>{{ allocationTitle(a) }}</strong> · {{ money(a.amount_assigned) }}</p>
      }
      <label class="cal-dlg-label" for="cal-reb-reason">Por qué rebotó</label>
      <p-select appendTo="body" inputId="cal-reb-reason" [options]="reboteReasonOpts" [(ngModel)]="reboteReason" optionLabel="label" optionValue="value" placeholder="Motivo" [fluid]="true" class="cal-dlg-sel" />
      @if (reboteReason === 'otro') {
        <input pInputText type="text" [(ngModel)]="reboteDetail" placeholder="Detalle (obligatorio)" class="cal-dlg-full" aria-label="Detalle del motivo" />
      }
      <label class="cal-dlg-label" for="cal-reb-date">Pagarlo el</label>
      <input id="cal-reb-date" type="date" [(ngModel)]="reboteDate" [min]="todayIso" class="cal-date-input cal-dlg-full" />
      <p class="cal-dlg-hint">Se marca como rebotado y se mueve a ese día con la misma preparación. Si todavía no sabes cuándo, borra la fecha: queda rebotado en este día.</p>
      <div class="cal-dlg-actions">
        <button pButton type="button" class="p-button-text p-button-secondary" (click)="reboteVisible = false">Cancelar</button>
        <button pButton type="button" [disabled]="!reboteReason || (reboteReason === 'otro' && !reboteDetail.trim())" [loading]="saving()" (click)="confirmRebote()">{{ reboteDate ? 'Mover al ' + dayLong(reboteDate) : 'Marcar que rebotó' }}</button>
      </div>
    </p-dialog>

    <!-- Dialog: reprogramar -->
    <p-dialog [(visible)]="reprogramVisible" [modal]="true" header="Mover a otro día" [style]="{ width: '26rem' }">
      <!-- [PGP.48] Uno o varios: los pagos de un día que ya pasó se mueven juntos. -->
      @if (reprogramTodos.length > 1) {
        <p class="cal-dlg-p">Se mueven <b>{{ pagos(reprogramTodos.length) }}</b> por <b class="comm-num">{{ money(reprogramTotal()) }}</b>, con su misma preparación.</p>
        <!-- [PGP.50] Cuáles: mover N pagos sin decir cuáles es firmar a ciegas. -->
        <ul class="pg-dlg-list">
          @for (a of reprogramTodos; track a.id) {
            <li><span><span class="comm-num pg-dlg-fol">{{ a.priority_rank ?? '—' }}</span> {{ allocationTitle(a) }}@if (reprogramDestinos) { <span class="pg-dlg-a">→ {{ dayShort(fechaDeMover(a)) }}</span> }@if (prontoAlMover(a); as p) { <span class="pg-dlg-pronto">{{ textoPronto(p) }}</span> }</span><b class="comm-num">{{ money(a.amount_assigned) }}</b></li>
          }
        </ul>
      } @else if (reprogramTodos[0]; as a) {
        <p class="cal-dlg-p"><strong>{{ allocationTitle(a) }}</strong> · {{ money(a.amount_assigned) }}@if (reprogramDestinos) { → {{ dayLong(fechaDeMover(a)) }} }@if (prontoAlMover(a); as p) { <span class="pg-dlg-pronto">{{ textoPronto(p) }}</span> }</p>
      }
      <!-- [PGP.73] Lo que cuesta mover: mover N pagos sin decir qué descuento se deja pasar es firmar a ciegas.
           La ventana es OBSERVADA, no pactada (contrato PGP.36): por eso «deja pasar», como en la fila. -->
      @if (prontoAlMoverTotal(); as s) {
        <p class="cal-dlg-hint cal-habito-nm"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <!-- [PGP.91] D3: lo CAPTURADO no se deja pasar (viaja con el pago); sólo lo estimado. Se nombran aparte. -->
          @if (s.deja) {
            @if (s.estimado > 0) { {{ s.nEst === 1 ? 'Uno deja' : s.nEst + ' dejan' }} pasar <b class="comm-num">{{ money(s.estimado) }}</b> de pronto pago ({{ s.nombresEst }}): su ventana cierra antes del día al que van. }
            @if (s.capturado > 0) { <b class="comm-num">{{ money(s.capturado) }}</b> de descuento ya capturado viaja con {{ s.nCap === 1 ? 'el pago' : 'sus pagos' }} ({{ s.nombresCap }}): confirma con el proveedor que lo respeta. }
          } @else {
            @if (s.estimado > 0) { {{ s.nEst === 1 ? 'Uno trae' : s.nEst + ' traen' }} <b class="comm-num">{{ money(s.estimado) }}</b> de pronto pago ({{ s.nombresEst }}), que se deja pasar si salen después de la fecha que dice cada uno. }
            @if (s.capturado > 0) { <b class="comm-num">{{ money(s.capturado) }}</b> de descuento ya capturado viaja con {{ s.nCap === 1 ? 'el pago' : 'sus pagos' }} ({{ s.nombresCap }}): si sale después de la fecha que dice, confirma con el proveedor que lo respeta. }
          }
        </p>
      }
      @if (reprogramDestinos) {
        <!-- [PGP.50] Repartidos por la propuesta del exceso: cada uno al primer día que le cabe. -->
        <p class="cal-dlg-hint">Cada pago va al primer día siguiente que todavía tiene espacio en su tope. Para elegir otra fecha, muévelo desde su fila.</p>
      } @else {
        <label class="cal-dlg-label" for="cal-rep-date">Nueva fecha</label>
        <input id="cal-rep-date" type="date" [min]="todayIso" [(ngModel)]="reprogramDate" class="cal-date-input cal-dlg-full" />
        <!-- [PGP.73] Con una sola fecha para todos, el día destino puede quedar excedido: se dice antes de mover. -->
        @if (destinoTope(); as dt) { <p class="cal-dlg-hint pg-dlg-destino" [class.cal-habito-nm]="dt.mal" role="status">{{ dt.texto }}</p> }
      }
      <label class="cal-dlg-label" for="cal-rep-reason">Motivo</label>
      <p-select appendTo="body" inputId="cal-rep-reason" [options]="reprogramReasonOpts" [(ngModel)]="reprogramReason" optionLabel="label" optionValue="value" placeholder="Motivo" [fluid]="true" class="cal-dlg-sel" />
      @if (reprogramReason === 'otro') {
        <input pInputText type="text" [(ngModel)]="reprogramReasonDetail" placeholder="Detalle (obligatorio)" class="cal-dlg-full" aria-label="Detalle del motivo" />
      }
      <div class="cal-dlg-actions"><button pButton type="button" class="p-button-text p-button-secondary" (click)="reprogramVisible = false">Cancelar</button><button pButton type="button" (click)="confirmReprogram()" [loading]="saving()" [disabled]="!reprogramValido()">@if (reprogramDestinos) { Mover {{ reprogramTodos.length === 1 ? 'el pago' : 'los ' + reprogramTodos.length }} } @else if (reprogramDate) { Mover al {{ dayLong(reprogramDate) }} } @else { Mover }</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    /* ══ [PGP.15] PRESUPUESTO DE COLOR (regla del PM, 2026-10-26: «la menor cantidad de colores
       innecesarios»). Medido antes: 44 elementos con color en TRES tonos -naranja, ambar y verde-
       cumpliendo 16 papeles distintos (dia elegido, punto de hoy, paso activo, paso hecho, barra,
       «falta», avisos, pie de la cola...). Cuando todo pide atencion, nada la tiene.
       Ahora:  neutro por default · naranja (--action) SOLO en el boton principal ·
               rojo (--bad) SOLO para lo que esta mal (rebote, tope excedido).
       El estado lo dicen la palabra y el icono, no el tono (regla #5 y forced-colors). ══ */
    /* [PGP.61] sp-3 → sp-2: el marco (migas, pestañas, semana) se llevaba ~24 % del alto antes del veredicto. */
    /* [PGP.66] Con lo secundario en paneles, la pantalla recupera aire (Edgar: «todo está muy compactado y junto»). */
    .cal-page { gap:var(--sp-4); padding-bottom:var(--sp-3); }
    .cal-date-input { padding:var(--sp-1) var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:var(--fs-sm); }
    .cal-muted { color:var(--text-faint); }
    .cal-neg, .cal-bad-txt { color:var(--bad-soft-fg); }
    /* [PGP.19] Tres tonos con UN significado cada uno (y siempre con su palabra al lado): ámbar = falta
       algo que destraba el día · verde = listo o hecho · rojo = algo está mal. El naranja es sólo del
       botón principal. Tonos «soft»: pasan AA en texto chico en los dos modos. */
    /* El ámbar va en PASTILLA (fondo + texto): en claro el texto ámbar solo (#92400E) se lee naranja y se
       confunde con el botón principal; con su fondo se lee amarillo y pasa AA. */
    .cal-warn-txt { color:var(--warn-soft-fg); background:var(--warn-soft-bg); border-radius:var(--r-pill); padding:0 6px; }
    .cal-ok-txt { color:var(--ok-soft-fg); }
    .cal-check { display:flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-sm); color:var(--text-muted); white-space:nowrap; }
    :host ::ng-deep .cal-sel { width:9rem; }
    .cal-benef { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:var(--sp-1); color:var(--text-main); }
    /* Sucursal = centro de costo: texto, no chip. */
    .cal-suc { display:inline; font-size:var(--fs-sm); font-weight:600; color:var(--text-main); margin-right:var(--sp-1); }
    /* [PGP.12] La referencia del proveedor: monoespaciada porque se coteja contra un papel. */
    .cal-ref { font-family:var(--font-mono); font-size:var(--fs-sm); color:var(--text-muted); margin-left:var(--sp-1); }
    .cal-ref::before { content:'· '; }
    .cal-empty { text-align:center; color:var(--text-muted); padding:var(--sp-4); white-space:normal; margin:0; }
    .cal-notes { display:block; font-size:var(--fs-sm); color:var(--text-faint); margin-top:var(--sp-1); }
    /* [TP.20.5] La factura es un enlace a su ficha: sin color en reposo; subrayado al pasar y al foco. */
    .cal-reflink { border:0; background:transparent; color:inherit; cursor:pointer; padding:0; font:inherit; text-align:left; }
    .cal-reflink:hover { text-decoration:underline; }
    .cal-reflink:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; border-radius:var(--r-sm); }
    /* [TP.20.4] Pronto pago: lo urgente se marca con PESO e icono (rayo), no con ambar. */
    .cal-pp { display:inline-flex; align-items:center; gap:.25rem; margin-left:var(--sp-1); font-size:var(--fs-sm); color:var(--text-muted); }
    .cal-pp-urge { color:var(--text-main); font-weight:700; }
    /* [PGP.14] El credito a favor sin aplicar. Toma color de aviso porque es dinero NUESTRO que
       se puede perder pagando de mas, y lleva icono Y palabra: el color nunca es unico portador
       (regla #5 de DESIGN.md, y lo unico que sobrevive a forced-colors). */
    .pg-favor { display:inline-flex; align-items:center; gap:4px; margin-left:var(--sp-1);
      font-size:var(--fs-sm); font-weight:700; color:var(--warn-soft-fg); }
    /* [PGP.17] El aviso es un BOTON: dice cuanto, y abre de que tipo y de que documento. */
    .pg-favor-btn { border:0; background:transparent; cursor:pointer; font:inherit; font-size:var(--fs-sm);
      font-weight:700; color:var(--warn-soft-fg); padding:0 2px; border-radius:var(--r-sm); }
    .pg-favor-btn:hover { text-decoration:underline; }
    .pg-favor-btn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    /* [PGP.21] La evidencia de la factura. Tres estados y NINGUNO depende solo del color:
       cada uno lleva su icono y su texto, que es lo que exige el modo de alto contraste. */
    /* [PGP.49] margin-left: el aviso salia pegado a la referencia del proveedor («2034ⓘ sin factura»). */
    .pg-ev { display:inline-flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-sm); margin-left:var(--sp-2); }
    /* [PGP.51] Era --action: el naranja es SOLO del boton principal, y este enlace salia en cada renglon
       con PDF (5 en la primera pantalla del 3-nov, compitiendo con «Mover 6 pagos»). */
    .pg-ev-pdf { border:0; background:transparent; cursor:pointer; font:inherit; font-size:var(--fs-sm);
      color:var(--text-main); font-weight:600; padding:0; text-align:left; }
    .pg-ev-pdf:hover { text-decoration:underline; }
    .pg-ev-pdf:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-ev-uuid { color:var(--fg-2); }
    .pg-ev-no { color:var(--fg-3); }
    .pg-ev-src { color:var(--fg-3); }
    /* [PGP.32] La disputa NO se atenúa como la deducción: una contradicción entre el ERP y el
       SAT es trabajo de alguien, no una nota al pie. Sin fondo ni borde: pesa por color y peso,
       que es lo que §Q.5 pide, y no agrega una caja más al renglón. */
    .pg-ev-dis { color:var(--warn-soft-fg); font-weight:600; }
    /* El cajon del desglose. Lo PENDIENTE lleva el peso; lo ya aplicado es contexto. */
    .pg-cr { display:grid; gap:var(--sp-2); }
    .pg-cr-tot { display:flex; flex-wrap:wrap; gap:var(--sp-1) var(--sp-3); padding:var(--sp-2) var(--sp-3);
      border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--surface-2); font-size:var(--fs-sm); }
    .pg-cr-tot b { color:var(--text-main); font-weight:700; }
    .pg-cr-h { font-size:var(--fs-xs); font-weight:700; text-transform:uppercase; letter-spacing:.04em;
      color:var(--text-muted); margin:var(--sp-2) 0 0; }
    .pg-cr-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:var(--sp-2); align-items:center;
      padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .pg-cr-row.is-pend { border-left:3px solid var(--warn-fg); }
    .pg-cr-main { display:flex; flex-direction:column; min-width:0; }
    .pg-cr-part { font-size:var(--fs-sm); color:var(--warn-soft-fg); }
    .pg-cr-ok { display:flex; align-items:center; gap:6px; font-size:var(--fs-sm); color:var(--ok-soft-fg); margin:0; }
    .pg-cr-decl { display:flex; gap:var(--sp-2); font-size:var(--fs-sm); color:var(--text-muted);
      border-top:1px solid var(--border-color); padding-top:var(--sp-2); margin:var(--sp-2) 0 0; }
    .pg-cr-decl b { color:var(--text-main); }
    /* [PGP.16] El costo de adelantar: terciario a proposito. Es un dato para decidir, no una
       alarma -la propuesta ya no adelanta nada por su cuenta-. */
    .pg-pronto-no { display:inline-flex; align-items:center; gap:4px; margin-left:var(--sp-1);
      font-size:var(--fs-sm); color:var(--text-muted); }

    /* ══ [PGP.15] UNA PANTALLA: tira de dias arriba, veredicto compacto y dos paneles que llenan lo
       que queda (izquierda: agregar facturas; derecha: los pagos del dia). Medido antes a 1442×902: la
       pagina media 1,914 px en un panel de 814. ⛔ [PGP.14] @media y no @container: ningun ancestro
       declara container-type. ══ */

    /* ── Los dias por pagar: una tira ──────────────────────────────── */
    .pg-top { display:grid; grid-template-columns:minmax(0, 1fr); gap:4px; align-items:center;
      padding:0; }
    /* La semana y su resumen en UN renglon; las fichas abajo, a todo lo ancho (medido: lado a lado las fichas se enciman). */
    .pg-week { display:flex; align-items:center; gap:var(--sp-1) var(--sp-3); flex-wrap:wrap; min-width:0; }
    .pg-week-nav { display:flex; align-items:center; gap:2px; }
    .pg-queue-wk { font-size:var(--fs-sm); font-weight:600; color:var(--text-main); white-space:nowrap; padding:0 2px; }
    .pg-week-f { font-size:var(--fs-sm); color:var(--text-muted); white-space:nowrap; padding-left:var(--sp-1); }
    .pg-week-f b { color:var(--text-main); font-weight:700; }
    :host ::ng-deep .pg-ico.p-button { padding:var(--sp-1); min-width:auto; }
    :host ::ng-deep .pg-hoy.p-button { padding:var(--sp-1) var(--sp-2); font-size:var(--fs-xs); }
    .pg-days-ls { display:block; min-width:0; }
    /* Los 7 dias en una fila; si no caben, la FILA se desplaza de lado: la pantalla no crece. */
    .pg-days { display:flex; gap:var(--sp-1); overflow-x:auto; scroll-snap-type:x proximity; }
    .pg-day { all:unset; box-sizing:border-box; cursor:pointer; flex:1 1 0; min-width:10.5rem; display:grid; gap:1px;
      padding:3px var(--sp-2); border:1px solid transparent; border-radius:var(--r-sm); scroll-snap-align:start; }
    .pg-day:hover { background:var(--overlay-hover); }
    .pg-day:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    /* El dia elegido: fondo y borde del color del TEXTO, no naranja. El naranja es del boton principal. */
    .pg-day.is-sel { background:var(--overlay-selected); border-color:var(--text-main); box-shadow:inset 0 -2px 0 var(--text-main); }
    /* [PGP.60] Era opacity:.7, y eso aclaraba también el texto: «sin tope» quedaba en 3.62:1 (claro) y
       4.04:1 (oscuro), debajo del 4.5:1 de AA. Un día sin tope y sin pagos no se atenúa: se ANGOSTA
       (decía «sin tope · —» ocupando lo mismo que un día con 30 pagos). */
    .pg-day.is-vacio { flex:0 1 8rem; min-width:8rem; }
    .pg-day-t { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); }
    .pg-day-n { font-size:var(--fs-sm); font-weight:700; text-transform:capitalize; color:var(--text-main); white-space:nowrap; }
    .pg-t { font-weight:400; color:var(--text-muted); font-size:var(--fs-sm); }
    .pg-day-amt { font-size:var(--fs-sm); font-weight:700; color:var(--text-main); white-space:nowrap; }
    .pg-day-l { font-weight:400; color:var(--text-muted); }
    .pg-day-b { display:flex; align-items:center; gap:4px; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.3; white-space:nowrap; }
    .pg-day-b b { color:var(--text-main); font-weight:700; }
    .pg-day-b b.cal-bad-txt { color:var(--bad-soft-fg); }
    /* [PGP.60] «faltan N» con PESO, sin pastilla ámbar: el estándar §3.10 deja el color sólo para la
       acción principal y para lo que está mal. Eran 4 pastillas ámbar en la tira de la semana. */
    .pg-day-b b.cal-warn-txt { color:var(--text-main); background:none; padding:0; }
    .pg-day-b b.cal-ok-txt { color:var(--ok-soft-fg); }
    /* El estado del dia viaja en FORMA (punto lleno / hueco), nunca solo en color. */
    .pg-dot { width:6px; height:6px; border-radius:var(--r-pill); background:var(--text-faint); flex-shrink:0; }
    .pg-dot.is-work { background:var(--text-main); }
    .pg-dot.is-free { background:transparent; border:1px solid var(--text-muted); }
    .pg-rev-u { font-weight:400; color:var(--text-muted); }

    /* ── El veredicto, compacto: frase y boton; tope y avance lado a lado ── */
    .pg-lot { display:grid; gap:var(--sp-2); min-width:0; }
    .pg-vd { display:grid; gap:var(--sp-1); padding:var(--sp-1) 0; border-block:1px solid var(--border-color); }
    /* Rojo SOLO cuando algo esta mal. «Bien» y «falta» no llevan tono: lo dice la frase. */
    /* [PGP.77] Lo que está mal lo marca SÓLO el icono rojo junto a la frase: la barra lateral roja más
       el botón de color eran dos llamadas de atención para un mismo aviso («me desconcentra»). */
    .pg-vd-ico { color:var(--bad-soft-fg); margin-right:var(--sp-1); font-size:var(--fs-body); }
    .pg-vd-id { display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; }
    .pg-vd-id h2 { margin:0; font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); }
    .pg-vd-sub { font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-pill { display:inline-flex; align-items:center; font-size:var(--fs-micro); font-weight:700; text-transform:uppercase; letter-spacing:.03em; padding:0 7px; border-radius:var(--r-pill); color:var(--text-muted); background:var(--surface-2); }
    .pg-vd-main { display:flex; align-items:center; gap:var(--sp-4); flex-wrap:wrap; }
    /* [PGP.77] Frase y explicacion en UN renglon cuando caben (Edgar, 2026-11-05: «necesita demasiado
       espacio»); si no caben, la explicacion baja sola. */
    .pg-vd-txt { flex:1; min-width:15rem; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px var(--sp-3); }
    /* [PGP.14] La respuesta de la pantalla es lo primero que se lee: la frase mas grande. */
    .pg-vd-say { margin:0; font-size:var(--fs-h3); font-weight:600; line-height:1.3; color:var(--text-main); }
    .pg-vd-why { margin:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px var(--sp-2); font-size:var(--fs-sm); color:var(--text-muted); }
    :host ::ng-deep .pg-vd-cta.p-button { flex-shrink:0; }
    .pg-vd-row2 { display:grid; grid-template-columns:minmax(0, auto) minmax(26rem, 1fr); gap:var(--sp-2) var(--sp-5); align-items:center;
      margin-top:6px; padding-top:6px; border-top:1px solid var(--border-color); }
    @media (max-width: 90rem) { .pg-vd-row2 { grid-template-columns:minmax(0, 1fr); } }
    .pg-cap { display:grid; gap:4px; min-width:0; }
    /* El tope en UNA linea de texto (era una tira de cifras de 20 px que ocupaba dos renglones). */
    .pg-cap-line { display:flex; flex-wrap:wrap; gap:2px var(--sp-4); font-size:var(--fs-sm); color:var(--text-muted); white-space:nowrap; }
    .pg-cap-line b { color:var(--text-main); font-weight:700; }
    .pg-cap-line b.cal-neg { color:var(--bad-soft-fg); }
    .pg-cap-pct { font-size:var(--fs-sm); }
    .pg-cap-say { font-size:var(--fs-sm); font-weight:600; color:var(--text-main); }
    .pg-cap-bar { display:block; height:4px; border-radius:var(--r-pill); background:var(--border-color); overflow:hidden; }
    .pg-cap-fill { display:block; height:100%; background:var(--text-muted); border-radius:inherit; }
    .pg-cap-fill.is-over { background:var(--bad-fg); }

    /* [PGP.15] El avance: cinco etapas en una linea, sin clic. Hecho = palomita; ahora = numero
       invertido y nombre en negro; pendiente = apagado. Ningun tono. */
    .pg-prog { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:var(--sp-2); }
    .pg-pe { display:flex; align-items:flex-start; gap:6px; min-width:0; color:var(--text-muted); }
    .pg-pe-n { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:var(--r-pill); border:1.5px solid var(--border-color);
      font-family:var(--font-mono); font-size:var(--fs-micro); font-weight:700; flex-shrink:0; }
    .pg-pe.is-done .pg-pe-n { border-color:var(--ok-soft-fg); color:var(--ok-soft-fg); }
    .pg-pe.is-now .pg-pe-n { border-color:var(--text-main); background:var(--text-main); color:var(--card-bg); }
    /* Cada paso en UNA linea: nombre y lo que dice. */
    .pg-pe { align-items:center; }
    .pg-pe-t { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 6px; min-width:0; font-size:var(--fs-sm); line-height:1.3; }
    .pg-pe-t b { font-size:var(--fs-sm); color:var(--text-main); font-weight:600; }
    .pg-pe.is-now .pg-pe-t b { font-weight:700; }
    .pg-pe:not(.is-done):not(.is-now) .pg-pe-t b { color:var(--text-muted); font-weight:600; }
    .pg-pe-who { font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-pe-say { color:var(--text-muted); overflow-wrap:anywhere; }
    .pg-pe.is-now .pg-pe-say { color:var(--text-main); }
    .pg-note { display:flex; gap:var(--sp-2); align-items:flex-start; margin:var(--sp-1) 0 0; padding:6px var(--sp-3);
      border-radius:var(--r-md); background:var(--surface-2); font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-note b { color:var(--text-main); }
    .pg-note > .pi { margin-top:2px; }

    /* ── [PGP.52] Una columna: veredicto · agregar · pagos del dia. Sin paneles que se peleen el ancho. ── */
    .pg-paso { font-size:var(--fs-sm); color:var(--text-muted); }
    /* Agregar: el buscador en una linea; sin busqueda, tres enlaces con su cuenta en vez de 1,000 renglones. */
    /* [PGP.62] El buscador y «Ver todas (N)» en UN renglón: eran dos. Lo demás (avisos, la lista) va a todo lo ancho. */
    .pg-add { display:grid; grid-template-columns:minmax(0, auto) auto; align-items:center; gap:var(--sp-1) var(--sp-4); padding:var(--sp-1) 0; }
    .pg-add > :not(.pg-add-bar):not(.pg-add-links) { grid-column:1 / -1; }
    @media (max-width: 47.5rem) { .pg-add { grid-template-columns:minmax(0, 1fr); } }
    .pg-add-bar { display:flex; align-items:center; gap:var(--sp-2) var(--sp-3); flex-wrap:wrap; }
    .pg-add-t { margin:0; font-size:var(--fs-h3); font-weight:600; color:var(--text-main); white-space:nowrap; }
    .pg-add-n { font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-add-links { display:flex; align-items:center; gap:var(--sp-1) var(--sp-4); flex-wrap:wrap; margin:0; font-size:var(--fs-sm); }
    .pg-add-nm { color:var(--warn-soft-fg); }
    .pg-link { all:unset; box-sizing:border-box; cursor:pointer; display:inline-flex; align-items:center; gap:var(--sp-1);
               padding:2px var(--sp-1); border-radius:var(--r-sm); color:var(--text-main); }
    .pg-link:hover { text-decoration:underline; }
    .pg-link:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-link .pi { color:var(--text-muted); }
    /* La lista: su propio alto y su propio scroll, para no empujar los pagos del dia fuera de la pantalla. */
    .pg-lista { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); overflow:hidden; }
    .pg-lista .pg-drawer-b { max-height:min(26rem, 50vh); }
    .pg-lista-acts { display:flex; gap:var(--sp-1); margin-left:auto; }
    .pg-sub-2 { margin-top:1px; }
    /* Los pagos del dia: un renglon por pago. */
    .pg-ben { display:block; min-width:0; }
    .pg-ben .cal-benef { display:inline; }
    .pg-ben-d { color:var(--text-muted); font-size:var(--fs-sm); }
    .pg-c-how { min-width:0; font-size:var(--fs-sm); }
    td.pg-c-how .pg-how { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px var(--sp-2); }
    td.pg-c-how .pg-how-t { color:var(--text-main); }
    td.pg-c-how .pg-st { margin-top:0; }
    /* Las flechas de orden: al pasar el cursor o con el foco del teclado (el numero se ve siempre). */
    /* [PGP.76] El asa se ve siempre (atenuada); se enciende al pasar el cursor o con el foco. */
    .pg-ord-h { font-size:var(--fs-xs); color:var(--text-muted); }
    :host ::ng-deep .pg-prep tr:hover .pg-ord-h, .pg-ord:focus-visible .pg-ord-h { color:var(--text-main); }
    /* El desglose junta lo que antes llenaba el renglon. */
    .pg-x-info { display:grid; gap:4px; margin:0 0 var(--sp-2); }
    .pg-x-info p { margin:0; }
    .pg-x-d { font-weight:400; color:var(--text-muted); font-size:var(--fs-sm); }
    /* ── Secciones del dia ───────────────────────────────────────────── */
    .pg-sec { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); overflow:hidden; }
    /* [PGP.74] La cabecera de los pagos se queda arriba al bajar (23 pagos a 48 px no caben). surf-table--sticky
       sola NO alcanzaba, medido: PrimeNG le pone overflow:auto EN LÍNEA al contenedor de la tabla
       (primeng-table.mjs, inlineStyles.tableContainer) y esta tarjeta recortaba con overflow:hidden. Los dos
       crean un contenedor de desplazamiento que no se desplaza, y el sticky se pegaba a él. clip recorta
       igual sin crearlo. Sólo en escritorio: abajo de 64rem la tabla necesita su scroll horizontal
       (styles.css) y en teléfono la cabecera no existe. */
    .pg-sec.pg-pagos { overflow:clip; }
    @media (min-width: 64.0625rem) { :host ::ng-deep .pg-prep .p-datatable-table-container { overflow:visible !important; } }
    .pg-sec-h { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border-color); }
    .pg-sec-t { margin:0; display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; font-size:var(--fs-sm); font-weight:700; color:var(--text-main); }
    .pg-sec-n { font-size:var(--fs-sm); font-weight:400; color:var(--text-muted); }
    .pg-sec-acts { display:flex; gap:var(--sp-1); flex-wrap:wrap; margin-left:auto; }
    .pg-sec-tg { all:unset; box-sizing:border-box; cursor:pointer; display:inline-flex; align-items:center; gap:var(--sp-2); font-weight:700; color:var(--text-main); border-radius:var(--r-sm); }
    .pg-sec-tg:hover { text-decoration:underline; }
    .pg-sec-tg:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
    .pg-sub { display:block; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.35; }

    /* ── [PGP.15] El buscador: siempre a la vista, el control mas grande de su seccion ── */
    .pg-add-h { gap:var(--sp-2) var(--sp-3); }
    .pg-buscar { position:relative; display:flex; align-items:center; flex:1 1 22rem; min-width:14rem; max-width:36rem; }
    .pg-buscar > .pi-search { position:absolute; left:var(--sp-3); color:var(--text-muted); pointer-events:none; }
    :host ::ng-deep .pg-buscar-in.p-inputtext { width:100%; padding-left:2.25rem; padding-right:2.25rem; font-size:var(--fs-body); }
    .pg-kbd { position:absolute; right:var(--sp-2); font-family:var(--font-mono); font-size:var(--fs-micro); color:var(--text-muted);
      border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 5px; line-height:1.5; pointer-events:none; }
    .pg-buscar:focus-within .pg-kbd { display:none; }
    /* [PGP.66] En el botón el atajo va EN LÍNEA: con el absolute del buscador se encimaba sobre «facturas». */
    .pg-sec-acts .pg-kbd { position:static; margin-left:var(--sp-1); }
    .pg-lista-tg { margin-left:auto; font-size:var(--fs-sm); font-weight:600; color:var(--text-muted); gap:var(--sp-1); }
    .pg-alta { display:flex; align-items:center; gap:var(--sp-2); margin:0; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border-color);
      font-size:var(--fs-sm); font-weight:600; color:var(--text-main); background:var(--surface-2); }
    /* Los proveedores encontrados: cada uno es un pago y se agrega entero. */
    .pg-grupos { display:grid; gap:4px; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border-color); }
    .pg-grupo { display:grid; grid-template-columns:minmax(0, 1fr) 8.5rem auto; gap:var(--sp-3); align-items:center;
      padding:6px var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-sm); font-size:var(--fs-sm); }
    .pg-grupo .pg-dr-amt { text-align:right; }

    /* La propuesta: una caja punteada NEUTRA -es una propuesta, no una alarma-. */
    .pg-prop { display:grid; gap:4px; margin:var(--sp-3); padding:var(--sp-2); border:1px dashed var(--text-faint); border-radius:var(--r-md); }
    .pg-prop-why { margin:0 0 var(--sp-1); font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-prop-why b { color:var(--text-main); }
    .pg-prop-row { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:var(--sp-2); align-items:center; padding:5px var(--sp-2);
      border:1px solid var(--border-color); border-radius:var(--r-sm); cursor:pointer; background:var(--card-bg); }
    .pg-prop-row:hover { background:var(--overlay-hover); }
    .pg-prop-row.is-off { opacity:.7; cursor:default; }
    .pg-prop-main { display:flex; flex-direction:column; min-width:0; }
    .pg-prop-amt { font-weight:700; font-size:var(--fs-sm); white-space:nowrap; color:var(--text-main); }
    /* [PGP.15] Una casilla marcada no es la accion principal: con 30 marcadas, el naranja de PrimeNG
       pintaba 30 cuadros de «hazme clic» (medido: rgb(242,116,78) en cada uno). Marcada = color del
       texto; la palomita lleva la forma. */
    :host ::ng-deep .pg-prop .p-checkbox-checked .p-checkbox-box { background:var(--text-main); border-color:var(--text-main); }
    :host ::ng-deep .pg-prop .p-checkbox-checked .p-checkbox-icon { color:var(--card-bg); }
    .pg-fuera-h { border-radius:var(--r-sm); border:1px solid var(--border-color); margin-top:var(--sp-1); }
    .pg-fuera-i { color:var(--text-faint); width:1.25rem; text-align:center; }

    /* Metodo y origen para todos: agrupado con FONDO, no con otra caja. */
    .pg-applyall { display:flex; align-items:center; gap:var(--sp-2) var(--sp-3); flex-wrap:wrap; padding:var(--sp-2) var(--sp-3); background:var(--surface-2); border-bottom:1px solid var(--border-color); }
    .pg-aa-lb { font-size:var(--fs-sm); font-weight:700; color:var(--text-main); white-space:nowrap; }
    .pg-aa-f { display:flex; align-items:center; gap:6px; }
    .pg-aa-f > label { font-size:var(--fs-sm); color:var(--text-muted); white-space:nowrap; }
    .pg-aa-note { flex-basis:100%; font-size:var(--fs-sm); color:var(--text-muted); }
    /* [PGP.15] En el encabezado del panel: sin fondo propio ni renglon aparte. */
    .pg-sec-h > .pg-applyall { flex:1 1 auto; padding:0; background:none; border-bottom:0; gap:var(--sp-1) var(--sp-2); }
    :host ::ng-deep .pg-sec-h > .pg-applyall .cal-sel { width:8.5rem; }
    /* Anclado en .pg-vd: con el encapsulamiento, la regla de MetricStrip empataba (0,4,0) y ganaba por orden de carga. */
    :host ::ng-deep .pg-vd .pg-cap-ms .ms--compact .ms-v,
    :host ::ng-deep .pg-sec-tope .pg-cap-ms .ms--compact .ms-v { font-size:var(--fs-sm); font-weight:700; }
    :host ::ng-deep .pg-vd .pg-cap-ms .ms--compact .ms-item,
    :host ::ng-deep .pg-sec-tope .pg-cap-ms .ms--compact .ms-item { padding-top:0; padding-bottom:0; }
    /* [PGP.63] El tope y el paso, en línea dentro del encabezado de «Pagos del día» (ocupa el hueco entre el título y «Preliminar»). */
    /* [PGP.74] Base 0: al faltar ancho se doblan las cifras, no se va un botón solo al renglón de abajo. */
    .pg-sec-tope { flex:1 1 0; min-width:12rem; }
    .pg-sec-tope .pg-vd-row2 { display:flex; align-items:center; gap:var(--sp-1) var(--sp-4); flex-wrap:wrap; }

    /* La tabla del dia */
    :host ::ng-deep .pg-prep .p-datatable-table { table-layout:fixed; width:100%; }
    :host ::ng-deep .pg-prep .p-datatable-thead > tr > th { font-size:var(--fs-micro); font-weight:600; text-transform:uppercase; letter-spacing:.04em;
      color:var(--text-muted); padding-top:var(--sp-1); padding-bottom:var(--sp-1); }
    :host ::ng-deep .pg-prep .p-datatable-tbody > tr > td { font-size:var(--fs-sm); vertical-align:middle; }
    /* [PGP.66] Densidad cómoda que eligió Edgar: 48 px por pago (--row-h-lg), una decisión por renglón. */
    :host ::ng-deep .pg-prep .p-datatable-tbody > tr:not(.pg-xrow) > td { height:var(--row-h-lg); }
    /* El folio autorizado («261026-01-01») partia en dos renglones a 4.5rem; «Como sale» en tres a 19rem. */
    .pg-c-tg { width:2.5rem; } .pg-c-ord { width:4.5rem; } .pg-c-ord.is-folio { width:7.5rem; } .pg-c-amt { width:8.5rem; text-align:right; }
    .pg-c-act { width:9.5rem; text-align:right; white-space:nowrap; }
    /* Como sale va DEBAJO del beneficiario: una linea de texto y su estado. */
    .pg-how { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px var(--sp-2); margin-top:2px; font-size:var(--fs-sm); }
    td.pg-c-ord .pg-ordn { white-space:nowrap; }
    /* El nombre del beneficiario parte renglon antes que cortarse con «…»: medido, a 25rem de «Como
       sale» se leia «DISTRIBUIDORA DE LA ROSA» sin su razon social. Visible en todo momento. */
    .pg-prep .cal-benef { white-space:normal; overflow:visible; }
    td.pg-c-amt { font-weight:700; color:var(--text-main); white-space:nowrap; }
    .pg-c-ben { min-width:0; }
    /* [PGP.52] «Cómo sale» con su propia columna: en el panel angosto iba debajo del nombre; a todo lo ancho, al lado. */
    .pg-c-how { width:28%; }
    /* [PGP.60] «Por qué hoy» decide el orden; [PGP.74] va después del importe. Fuerte = vencida, vence hoy o cierra pronto (peso, no color). */
    .pg-c-why { width:16%; font-size:var(--fs-sm); color:var(--text-muted); }
    /* [PGP.74] Con el importe a su izquierda, dos cifras quedaban a 12 px y se leían como una frase. */
    @media (min-width: 47.5625rem) { :host ::ng-deep .pg-prep .p-datatable-thead > tr > th.pg-c-why, :host ::ng-deep .pg-prep .p-datatable-tbody > tr > td.pg-c-why { padding-left:var(--sp-6); } }
    .pg-c-why .pg-why-f { color:var(--text-main); font-weight:700; }
    /* [PGP.60] La línea de corte del tope: lo que está de aquí para abajo excede lo autorizado. */
    :host ::ng-deep .pg-prep .p-datatable-tbody > tr.is-corte > td { border-top:2px dashed var(--bad-fg); }
    .pg-corte { display:flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-xs); font-weight:700; color:var(--bad-soft-fg); margin-bottom:2px; }
    .pg-tg { all:unset; box-sizing:border-box; cursor:pointer; display:inline-grid; place-items:center; width:28px; height:28px; border-radius:var(--r-sm); color:var(--text-muted); }
    .pg-tg:hover { background:var(--overlay-hover); color:var(--text-main); }
    .pg-tg:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-how-t { color:var(--text-main); overflow-wrap:anywhere; }
    .pg-how-t.pg-sug { color:var(--text-muted); }
    .pg-sug .pi { margin-right:var(--sp-1); font-size:var(--fs-xs); }
    .pg-aa-n { font-size:var(--fs-sm); color:var(--text-muted); }
    /* El estado del pago: palabra + icono. Solo el rebote lleva color. */
    .pg-st { display:inline-flex; align-items:center; gap:4px; margin-top:2px; font-size:var(--fs-sm); color:var(--text-muted); }
    /* [PGP.49] «Falta el método» era pastilla ambar en CADA renglon: 26 de 31 el 3-nov, repitiendo lo que
       ya dicen la barra «Para los N sin preparar» y el avance. La regla del PM (2026-10-26): «falta» sin
       tono, con palabra + icono + peso. El ambar queda para el resumen del dia en la tira. */
    .pg-st.is-todo { color:var(--text-main); font-weight:600; }
    /* [PGP.49] La factura que todavia se busca, en UNA linea arriba de la lista (no en cada renglon). */
    .pg-ev-est { margin:0; padding:4px var(--sp-3); font-size:var(--fs-sm); color:var(--text-muted);
                 display:flex; align-items:center; gap:var(--sp-1); flex-wrap:wrap; }
    .pg-ev-est.is-nm { color:var(--warn-soft-fg); }
    .pg-ev-retry { border:1px solid var(--border-color); background:transparent; cursor:pointer; font:inherit;
                   font-size:var(--fs-xs); font-weight:600; color:var(--text-main); padding:1px var(--sp-2); border-radius:var(--r-sm); }
    .pg-ev-retry:hover { background:var(--overlay-hover); }
    .pg-ev-retry:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-st.is-bad { color:var(--bad-soft-fg); font-weight:700; }
    .pg-ord { display:inline-flex; align-items:center; gap:var(--sp-2); padding:var(--sp-1) var(--sp-2); border-radius:var(--radius-sm); cursor:grab; user-select:none; }
    .pg-ord:active { cursor:grabbing; }
    .pg-ord:focus-visible { outline:2px solid var(--action); outline-offset:1px; }
    .pg-ordn { min-width:1.2rem; text-align:center; font-weight:700; color:var(--text-main); }
    :host ::ng-deep .pg-x.p-button:hover { color:var(--text-main); }
    :host ::ng-deep .pg-x.p-button { color:var(--text-muted); }
    /* El desglose: las facturas del pago, a la escala de la tabla y sin otra caja. */
    :host ::ng-deep .pg-prep .p-datatable-tbody > tr.pg-xrow > td { background:var(--surface-2); padding:var(--sp-2) var(--sp-3) var(--sp-2) 3rem; }
    .pg-items-t { width:100%; border-collapse:collapse; font-size:var(--fs-sm); color:var(--text-main); }
    .pg-items-t th { text-align:left; font-size:var(--fs-micro); font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); padding:2px var(--sp-2); }
    .pg-items-t td { padding:3px var(--sp-2); border-top:1px solid var(--border-color); }
    .pg-items-t .r { text-align:right; white-space:nowrap; }
    .pg-items-t tfoot td { font-weight:700; color:var(--text-main); }
    /* [PGP.92] La columna de la X por factura: angosta y al final, donde el renglón del pago tiene la suya. */
    .pg-items-t .pg-it-acc { width:1%; white-space:nowrap; text-align:right; padding:0 0 0 var(--sp-2); }
    /* [PGP.91] El descuento al pagar, debajo del neto y un nivel abajo (terciario): sólo existe si lo hay. */
    .pg-items-t .pg-dsc { display:block; white-space:normal; font-size:var(--fs-xs); font-weight:400; color:var(--text-muted); }
    .pg-items-t tfoot .pg-dsc-pie { font-weight:400; color:var(--text-muted); }
    .pg-dsc-campos { display:grid; grid-template-columns:1fr 1fr; gap:0 var(--sp-3); }
    .pg-erp { margin:0; padding:var(--sp-2) var(--sp-3); border-top:1px solid var(--border-color); font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-erp-l { font-weight:600; color:var(--text-main); margin-right:var(--sp-1); }
    .pg-erp b { color:var(--text-main); }

    /* La deuda */
    .pg-drawer { overflow:hidden; }
    .pg-drawer-h { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; padding:6px var(--sp-3); background:var(--surface-2); border-bottom:1px solid var(--border-color); }
    .pg-grow { flex:1; min-width:11rem; }
    .pg-drawer-n { margin:0; padding:4px var(--sp-3); font-size:var(--fs-sm); color:var(--text-muted); background:var(--surface-2); border-bottom:1px solid var(--border-color); }
    .pg-drawer-n b { color:var(--text-main); }
    .pg-drawer-b { max-height:22rem; overflow:auto; }
    .pg-dr-row, .pg-dr-hd { display:grid; grid-template-columns:minmax(0, 1fr) 10rem 8.5rem 4.5rem; gap:var(--sp-3);
      align-items:center; padding:6px var(--sp-3); border-bottom:1px solid var(--border-color); font-size:var(--fs-sm); }
    .pg-dr-hd { padding-top:var(--sp-1); padding-bottom:var(--sp-1); font-size:var(--fs-micro); font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .pg-dr-hd .r { text-align:right; }
    .pg-dr-main { display:flex; flex-direction:column; min-width:0; }
    .pg-dr-amt { text-align:right; font-weight:700; white-space:nowrap; color:var(--text-main); }
    .pg-dr-due { font-size:var(--fs-sm); white-space:nowrap; color:var(--text-muted); }
    .pg-dr-acts { display:flex; justify-content:flex-end; gap:2px; color:var(--text-muted); }
    /* [PGP.15] Boton nativo del cajon (ver la plantilla: 1,908 pButton congelaban 15.9 s). */
    .pg-icobtn { all:unset; box-sizing:border-box; cursor:pointer; display:inline-grid; place-items:center; width:28px; height:28px;
      border-radius:var(--r-sm); color:var(--text-muted); }
    .pg-icobtn:hover:not(:disabled) { background:var(--overlay-hover); color:var(--text-main); }
    .pg-icobtn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-icobtn:disabled { opacity:.4; cursor:default; }
    /* Los renglones fuera de vista no se maquetan ni se pintan hasta que se desplazan a la vista. */
    .pg-drawer-b .pg-dr-row { content-visibility:auto; contain-intrinsic-size:auto 3.25rem; }
    .pg-dr-row.is-locked { background:var(--surface-2); color:var(--text-muted); }
    /* Critico: bandera y palabra, en el color del texto. Era rojo: un critico no es un error. */
    .pg-crit { display:inline-flex; align-items:center; gap:3px; font-size:var(--fs-micro); font-weight:700; text-transform:uppercase; letter-spacing:.03em;
      color:var(--text-main); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 4px; }
    .pg-rev-h { all:unset; box-sizing:border-box; cursor:pointer; width:100%; display:flex; align-items:flex-start; gap:var(--sp-2);
      padding:var(--sp-2) var(--sp-3); background:var(--surface-2); border-top:1px solid var(--border-color); font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-rev-h:hover { background:var(--overlay-hover); }
    .pg-rev-h:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
    .pg-rev-h > .pi { margin-top:2px; }
    .pg-rev-t { flex:1; display:grid; gap:2px; }
    .pg-rev-t b { color:var(--text-main); font-weight:700; }
    .pg-chev { color:var(--text-muted); }

    /* Dialogos */
    .cal-dlg-p { font-size:var(--fs-sm); margin:0 0 var(--sp-2); }
    .cal-dlg-hint { font-size:var(--fs-sm); color:var(--text-muted); margin:0 0 var(--sp-2); }
    /* [PGP.30] La procedencia de lo precargado. Borde y no relleno: es contexto, no un estado. */
    .cal-habito { border-left:2px solid var(--border); padding-left:var(--sp-2); }
    .cal-habito .pi { margin-right:.3rem; }
    .cal-habito-nm { border-left:2px solid var(--warn-fg); padding-left:var(--sp-2); font-style:italic; }
    /* [PGP.35] Lo que no se puede pagar se ve distinto de lo que falta preparar: esto no es
       trabajo pendiente, es un renglon que hay que sacar del dia. */
    .pg-saldada { display:flex; align-items:center; gap:var(--sp-1); color:var(--bad-fg); font-weight:600; font-size:var(--fs-xs); flex-wrap:wrap; }
    /* [PGP.48] La accion que hace verdad «se puede pagar el resto». */
    .pg-saldada-btn { border:1px solid var(--border-color); background:transparent; cursor:pointer; font:inherit; font-size:var(--fs-xs);
                      font-weight:600; color:var(--text-main); padding:1px var(--sp-2); border-radius:var(--r-sm); }
    .pg-saldada-btn:hover:not(:disabled) { background:var(--overlay-hover); }
    .pg-saldada-btn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-saldada-btn:disabled { opacity:.5; cursor:default; }
    /* [PGP.96] El cierre que leyo de Kepler: hecho, no trabajo. Icono + texto; el color acompaña. */
    .pg-cierre { display:flex; align-items:center; gap:var(--sp-1); flex-wrap:wrap; font-size:var(--fs-xs); color:var(--text-main); font-weight:600; }
    .pg-cierre > .pi { color:var(--ok-fg); }
    .pg-cierre-d { font-weight:400; color:var(--text-muted); }
    .pg-sec-cierre { display:inline-flex; align-items:center; gap:var(--sp-1); margin-left:var(--sp-2); font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); }
    .pg-sec-cierre > .pi { color:var(--ok-fg); }
    .pg-cierre-x { display:flex; flex-direction:column; gap:var(--sp-1); }
    .pg-cierre-l { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--sp-1); }
    .pg-cierre-l li { display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--sp-1) var(--sp-3); font-size:var(--fs-xs); }
    .pg-it-sald { color:var(--bad-fg); font-weight:600; }
    /* [PGP.48] Pagos que se quedaron en dias ya pasados: esta mal, por eso rojo (y con su icono y su palabra). */
    .pg-atr { display:inline-flex; align-items:center; gap:var(--sp-1); border:0; background:transparent; cursor:pointer; font:inherit;
              font-size:var(--fs-sm); color:var(--bad-soft-fg); padding:2px var(--sp-1); border-radius:var(--r-sm); text-align:left; }
    .pg-atr b { font-weight:700; }
    .pg-atr:hover { text-decoration:underline; }
    .pg-atr:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-atr.is-nm { cursor:default; color:var(--warn-soft-fg); }
    .pg-atr.is-nm:hover { text-decoration:none; }
    .pg-sec-saldada { display:inline-flex; align-items:center; gap:var(--sp-1); color:var(--bad-fg); font-weight:600; font-size:var(--fs-xs); }
    .pg-dlg-list li.is-saldada { color:var(--bad-fg); }
    .pg-dlg-warn { display:inline-flex; align-items:center; gap:var(--sp-1); margin-left:var(--sp-2); color:var(--bad-fg); font-weight:600; font-size:var(--fs-xs); }
    /* [PGP.50] El dia al que va cada pago en la propuesta del exceso. */
    .pg-dlg-a { margin-left:var(--sp-2); color:var(--text-muted); font-weight:600; white-space:nowrap; }
    /* [PGP.73] El pronto pago que se deja pasar al mover: ámbar de TEXTO (--warn-soft-fg, 7:1), no el de relleno. */
    .pg-dlg-pronto { display:block; font-size:var(--fs-xs); font-weight:600; color:var(--warn-soft-fg); }
    .pg-dlg-destino { margin-top:var(--sp-1); }
    /* [PGP.36] La razon de pago. Cuatro tonos y NINGUNO depende solo del color: cada uno lleva
       su icono y su texto (DESIGN - el color nunca es el unico portador). */
    .pg-razon { display:flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-xs); font-weight:600; color:var(--fg-2); }
    .pg-razon.is-gana  { color:var(--ok-soft-fg); }
    /* [PGP.48] Era --action: el naranja es SOLO del boton principal (estandar 2.5). La urgencia la
       dicen el icono de reloj, la palabra y el peso. */
    .pg-razon.is-urge  { color:var(--text-main); font-weight:700; }
    .pg-razon.is-tarde { color:var(--warn-soft-fg); }
    .pg-razon.is-mudo  { color:var(--fg-3); font-weight:500; font-style:italic; }
    .pg-sec-pronto { display:inline-flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-xs); }
    /* [PGP.53] Pronto pago: su propia seccion, sin caja ni color. Grupo = dia en que cierra; las
       cifras en columnas fijas para que el grupo y sus renglones se lean en la misma vertical. */
    .pg-pp { margin:0 0 var(--sp-4); }
    .pg-pp-tot { font-size:var(--fs-sm); color:var(--fg-2); }
    .pg-pp-why { margin:var(--sp-1) 0 var(--sp-2); font-size:var(--fs-sm); max-width:72ch; }
    .pg-pp-src { display:block; margin-top:2px; font-size:var(--fs-xs); color:var(--fg-3); }
    .pg-pp-gr { border-top:1px solid var(--border-color); }
    /* [PGP.61] La línea de «N días más»: neutra, con su cuenta, del ancho de un grupo. */
    .pg-pp-mas { all:unset; box-sizing:border-box; cursor:pointer; display:flex; align-items:center; gap:var(--sp-2); width:100%;
      padding:6px var(--sp-1); border-top:1px solid var(--border-color); font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-pp-mas:hover { background:var(--overlay-hover); }
    .pg-pp-mas:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .pg-pp-mas .comm-num { color:var(--text-main); font-weight:600; }
    .pg-pp-gh, .pg-pp-go { all:unset; box-sizing:border-box; cursor:pointer; width:100%; display:grid; align-items:baseline;
                           gap:var(--sp-2); padding:4px var(--sp-1); font-size:var(--fs-sm); border-radius:var(--r-sm); }
    .pg-pp-gh { grid-template-columns:1rem minmax(0,1fr) 9rem 7rem 4rem 5.5rem; font-weight:600; }
    .pg-pp-gh.is-urge { font-weight:700; }
    .pg-pp-gh .pi { color:var(--text-muted); align-self:center; }
    .pg-pp-gh:hover, .pg-pp-go:hover { background:var(--overlay-hover); }
    .pg-pp-gh:focus-visible, .pg-pp-go:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
    .pg-pp-l { list-style:none; margin:0 0 var(--sp-1); padding:0; }
    .pg-pp-r { display:grid; grid-template-columns:minmax(0,1fr) 5.5rem; align-items:center; gap:var(--sp-2); }
    .pg-pp-go { grid-template-columns:minmax(0,1fr) 9rem 7rem 4rem; padding-left:calc(var(--sp-1) + 1rem + var(--sp-2)); }
    .pg-pp-n { min-width:0; overflow-wrap:anywhere; }
    .pg-pp-d { color:var(--fg-3); font-weight:400; }
    /* [PGP.65] Afordancia de enlace con subrayado y el color del texto (sin tono: el color es del botón principal). */
    .pg-pp-ver { color:var(--text-main); text-decoration:underline; text-underline-offset:2px; }
    .pg-pp-i, .pg-pp-g, .pg-pp-p { text-align:right; }
    .pg-pp-i { color:var(--fg-2); }
    .pg-pp-p { color:var(--fg-3); }
    .pg-pp-a { justify-self:end; }
    .pg-pp-x { margin:0 0 var(--sp-2); padding:var(--sp-1) var(--sp-2) var(--sp-1) calc(var(--sp-1) + 1rem + var(--sp-2));
               font-size:var(--fs-sm); color:var(--fg-2); }
    .pg-pp-x p { margin:0 0 2px; max-width:72ch; }
    @media (max-width: 47.5rem) {
      .pg-pp-gh { grid-template-columns:1rem minmax(0,1fr) auto; }
      .pg-pp-gh .pg-pp-i, .pg-pp-gh .pg-pp-p, .pg-pp-gh .pg-pp-a { display:none; }
      .pg-pp-go { grid-template-columns:minmax(0,1fr) auto auto; padding-left:var(--sp-1); }
      .pg-pp-go .pg-pp-i { display:none; }
      .pg-pp-x { padding-left:var(--sp-2); }
    }
    .pg-prop-not { color:var(--warn-soft-fg); }
    .pg-qp-nm { margin:0 0 var(--sp-3); font-size:var(--fs-xs); color:var(--warn-soft-fg);
                border-left:2px solid var(--warn-fg); padding-left:var(--sp-2); }
    .pg-sec-pronto-k { color:var(--fg-3); }
    .pg-gana { color:var(--ok-soft-fg); } .pg-tarde { color:var(--warn-soft-fg); } .pg-sep { color:var(--fg-3); }
    .cal-dlg-full { width:100%; margin-bottom:var(--sp-2); }
    .cal-dlg-actions { display:flex; gap:var(--sp-2); align-items:center; justify-content:flex-end; margin-top:var(--sp-3); }
    .cal-dlg-label { display:block; font-size:var(--fs-sm); color:var(--text-muted); margin:var(--sp-2) 0 var(--sp-1); }
    :host ::ng-deep .cal-dlg-sel { width:100%; margin-bottom:var(--sp-2); }
    /* Lo que cabe el dia destino, a la escala del dialogo; solo el exceso lleva color. */
    .pg-dlg-cap { margin:0; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.45; }
    .pg-dlg-cap b { color:var(--text-main); }
    .pg-dlg-cap b.cal-bad-txt { color:var(--bad-soft-fg); }
    .pg-dlg-list { list-style:none; margin:0; padding:0; max-height:16rem; overflow:auto; border-top:1px solid var(--border-color); }
    .pg-dlg-list li { display:flex; justify-content:space-between; gap:var(--sp-3); padding:4px 0; border-bottom:1px solid var(--border-color); font-size:var(--fs-sm); }
    .pg-dlg-fol { color:var(--text-muted); font-size:var(--fs-sm); margin-right:var(--sp-1); }

    /* ⛔ Angosto: la cola es UNA tira horizontal, para que el veredicto quede arriba. */
    @media (max-width: 56rem) { .pg-prog { grid-template-columns:repeat(auto-fit, minmax(9rem, 1fr)); } }
    /* Telefono: cada pago es un bloque con sus campos rotulados (data-l). */
    @media (max-width: 47.5rem) {
      :host ::ng-deep .pg-prep .p-datatable-table { table-layout:auto; }
      :host ::ng-deep .pg-prep .p-datatable-thead { display:none; }
      :host ::ng-deep .pg-prep .p-datatable-tbody > tr { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:var(--sp-1) var(--sp-2);
        padding:var(--sp-2) var(--sp-2); border-bottom:1px solid var(--border-color); }
      :host ::ng-deep .pg-prep .p-datatable-tbody > tr > td { display:block; width:auto; border:0; padding:2px 0; }
      :host ::ng-deep .pg-prep .p-datatable-tbody > tr > td[data-l]::before { content:attr(data-l); display:block; font-size:var(--fs-micro);
        font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
      :host ::ng-deep .pg-prep td.pg-c-tg { grid-column:1; grid-row:1; }
      :host ::ng-deep .pg-prep td.pg-c-ben { grid-column:2 / -1; grid-row:1; }
      /* [PGP.52] La columna nueva, «Cómo sale», va a todo lo ancho debajo del nombre. */
      :host ::ng-deep .pg-prep td.pg-c-how { grid-column:1 / -1; }
      :host ::ng-deep .pg-prep td.pg-c-why { grid-column:1 / -1; width:auto; }
      .pg-add-t { white-space:normal; }
      .pg-lista-acts { margin-left:0; }
      /* Folio u orden a la izquierda e importe a la derecha, en el mismo renglon. */
      :host ::ng-deep .pg-prep td.pg-c-ord { grid-column:1 / 3; grid-row:2; align-self:end; }
      :host ::ng-deep .pg-prep td.pg-c-amt { grid-column:3; grid-row:2; text-align:right; }
      :host ::ng-deep .pg-prep td.pg-c-act { grid-column:1 / -1; text-align:left; }
      :host ::ng-deep .pg-prep .p-datatable-tbody > tr.pg-xrow { display:block; }
      :host ::ng-deep .pg-prep .p-datatable-tbody > tr.pg-xrow > td { padding:var(--sp-2); }
      /* ⛔ styles.css trae dos reglas GLOBALES con !important para todo p-datatable en movil (a ≤30rem
         esconde las columnas 4+, a ≤48rem vuelve sticky la ultima). Aqui la 4 y 5 son Importe y Como
         sale: se anulan SOLO para esta tabla, con mas especificidad. */
      :host ::ng-deep .pg-prep.p-datatable .p-datatable-tbody > tr > td { display:block !important; position:static !important; min-width:0 !important; background:transparent !important; box-shadow:none !important; }
      .pg-dr-hd { display:none; }
      .pg-dr-row { grid-template-columns:minmax(0, 1fr) auto; }
      .pg-dr-row .pg-dr-due { grid-column:1; grid-row:2; }
      .pg-dr-row .pg-dr-amt { grid-column:2; grid-row:1; }
      .pg-dr-row .pg-dr-acts { grid-column:2; grid-row:2; }
      .pg-grupo { grid-template-columns:minmax(0, 1fr) auto; }
      :host ::ng-deep .pg-grupo .p-button { grid-column:1 / -1; justify-self:start; }
      .pg-buscar { flex-basis:100%; max-width:none; }
      .pg-kbd { display:none; }
    }
    @media (pointer: coarse) {
      :host ::ng-deep .pg-ico.p-button { min-height:44px; min-width:44px; }
      /* [PGP.92] La X por factura también llega a 44 px con el dedo. */
      :host ::ng-deep .pg-items-t .pg-it-acc .p-button { min-height:44px; min-width:44px; }
      .pg-tg, .pg-icobtn { width:44px; height:44px; }
      .pg-day { padding-top:var(--sp-2); padding-bottom:var(--sp-2); }
    }
  `],
})
export class FinanzasCalendarioPagosComponent implements OnInit {
  /**
   * `[TP.20.5]` El ref abierto en la ficha. El propio panel lo publica en la URL (`?ref=`), así
   * que una factura se puede pegar en un chat y el otro abre exactamente el mismo documento.
   */
  readonly inspect = signal<string | null>(null);

  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly base = `${environment.apiUrl}/finance/payment-calendar`;
  private readonly accountsBase = `${environment.apiUrl}/finance/supplier-payment-accounts`;

  @ViewChild('payPanel') private payPanel?: ElementRef<HTMLElement>;

  readonly canAuthorize = computed(() => this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR] === true);
  readonly todayIso = this.today();
  printing = signal(false);
  reprogramReasonOpts = REPROGRAM_REASON_OPTS;

  // ── La semana y el día elegido ──────────────────────────────────────────
  readonly selectedDate = signal(this.todayIso);
  readonly week = signal<PaymentCalendarWeek | null>(null);
  readonly loadingWeek = signal(false);
  readonly weekError = signal<string | null>(null);
  readonly selectedDay = computed<PaymentCalendarWeekDay | null>(() => {
    const sel = this.selectedDate();
    return this.week()?.days.find((d) => d.date === sel) ?? null;
  });
  /**
   * `[PGP.76]` El orden que Tesorería acaba de dar (arrastrando o con el teclado) y que todavía no
   * vuelve del servidor. La lista se pinta así AL INSTANTE; se guarda completa, de una vez.
   */
  private readonly ordenLocal = signal<{ date: string; ids: readonly string[] } | null>(null);
  readonly allocations = computed<PaymentCalendarAllocation[]>(() => {
    const base = this.selectedDay()?.allocations ?? [];
    const o = this.ordenLocal();
    if (!o || o.date !== this.selectedDate()) return base;
    const pos = new Map(o.ids.map((id, i) => [id, i]));
    return [...base].sort((x, y) => (pos.get(x.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(y.id) ?? Number.MAX_SAFE_INTEGER));
  });
  private readonly pendientesEnOrden = computed(() => this.allocations().filter((a) => a.status === 'pending').map((a) => a.id));
  readonly pendingCount = computed(() => this.allocations().filter((a) => a.status === 'pending').length);
  readonly unrankedCount = computed(() => this.allocations().filter((a) => a.status === 'pending' && a.priority_rank == null).length);
  readonly unpreparedCount = computed(() => this.allocations().filter((a) => a.status === 'pending' && !isPrepared(a)).length);
  readonly isReleased = computed(() => {
    const s = this.selectedDay()?.summary.lot_status;
    return s === 'released' || s === 'executing' || s === 'closed';
  });
  /**
   * Totales de la SEMANA (la tarjeta de cada día ya dice lo suyo; aquí no se repite el día).
   * El presupuesto sólo suma días con capacidad fijada, y cuántos faltan se dice en la nota.
   */
  // ── La semana, como CONTEXTO: las mismas cifras que traía la franja, ahora en un renglón.
  private readonly weekDays = computed(() => this.week()?.days ?? []);
  private readonly weekWithCap = computed(() => this.weekDays().filter((d) => d.summary.capacity_defined));
  readonly weekBudget = computed(() => this.weekWithCap().reduce((s, d) => s + Number(d.summary.authorized_amount ?? 0), 0));
  readonly weekAvailable = computed(() => this.weekWithCap().reduce((s, d) => s + Number(d.summary.remaining_amount ?? 0), 0));
  readonly weekNoCapDays = computed(() => this.weekDays().length - this.weekWithCap().length);
  private readonly weekPending = computed(() => this.weekDays().flatMap((d) => d.allocations).filter((a) => a.status === 'pending'));
  readonly weekUnprepared = computed(() => this.weekPending().filter((a) => !isPrepared(a)).length);

  /**
   * El paso del circuito en el que está parado el día: 1 armar · 2 preparar · 3 autorizar ·
   * 4 pagar · 5 cerrar · 6 cerrado. `[PGP.15]` Suma «cerrar»: el backend ya tenía `cerrar` y
   * `fallo`, y la pantalla no los ofrecía — el proceso no se podía terminar desde la interfaz.
   */
  /**
   * `[PGP.60]` **Con el día ya armado, los pagos van arriba** (pegados al veredicto que los nombra).
   * Sin pagos, el día está en ARMAR y arriba va lo que se agrega: el pronto pago primero (`[PGP.53]`).
   */
  readonly pagosPrimero = computed(() => this.allocations().length > 0);

  /**
   * `[PGP.60]` **Por qué se paga HOY**, en el renglón (decide el orden; antes sólo vivía en el
   * desglose). Lo que gana pronto pago va primero; si no, cómo está su factura más vieja contra el
   * día. Sin dato, null — la celda dice «—», no inventa un motivo (ADR-056).
   */
  porQueHoy(a: PaymentCalendarAllocation): { texto: string; fuerte: boolean } | null {
    // `[PGP.91]` El pronto pago YA capturado también es razón de pagar hoy: el servidor lo saca de
    // `pronto_captura` (no se cuenta dos veces), así que sin esta suma el renglón lo callaba.
    const desc = round2((a.items ?? []).filter((it) => it.discount_reason === 'pronto_pago').reduce((s, it) => s + this.numero(it.discount_amount), 0));
    const gana = this.numero(a.pronto_captura);
    if (desc > 0 || gana > 0) {
      const urge = (a.items ?? []).some((it) => it.pronto_estado === 'por_vencer');
      const partes = [desc > 0 ? `descuento ${this.money(desc)}` : '', gana > 0 ? `gana ${this.money(gana)}` : ''].filter(Boolean).join(' · ');
      return { texto: `${partes}${urge ? ' · cierra pronto' : ''}`, fuerte: urge };
    }
    const dia = this.selectedDate();
    const vence = (a.items ?? []).map((it) => it.vence).filter((v): v is string => !!v).sort()[0];
    if (vence) {
      const d = Math.round((Date.parse(dia) - Date.parse(vence.slice(0, 10))) / 86_400_000);
      if (d > 0) return { texto: d === 1 ? 'vencida hace 1 día' : `vencida hace ${d} días`, fuerte: true };
      if (d === 0) return { texto: 'vence hoy', fuerte: true };
      return { texto: `vence el ${this.shortDate(vence)} (se adelanta)`, fuerte: false };
    }
    if ((a.pronto_deja_pasar ?? 0) > 0) return { texto: `deja pasar ${this.money(a.pronto_deja_pasar)}`, fuerte: false };
    return null;
  }

  /**
   * `[PGP.60]` **Dónde se acaba el tope**, en el orden de dispersión: el primer pago con el que lo
   * acumulado pasa lo autorizado. Así «excede $X» se ve en la tabla (qué queda arriba y qué abajo),
   * no sólo como cifra. Sin tope fijado no hay corte que dibujar (null).
   */
  readonly corteDelTope = computed<string | null>(() => {
    const s = this.selectedDay()?.summary;
    if (!s?.capacity_defined || s.authorized_amount == null) return null;
    let acum = 0;
    for (const a of this.allocations()) {
      acum += Number(a.amount_assigned || 0);
      if (acum > Number(s.authorized_amount) + 0.005) return a.id;
    }
    return null;
  });

  readonly pasoActivo = computed<1 | 2 | 3 | 4 | 5 | 6>(() => {
    if (this.selectedDay()?.summary.lot_status === 'closed') return 6;
    if (this.isReleased()) return this.pendingCount() > 0 || this.failedCount() > 0 ? 4 : 5;
    if (this.pendingCount() === 0) return 1;
    if (this.unrankedCount() > 0 || this.unpreparedCount() > 0) return 2;
    return 3;
  });

  /**
   * `[PGP.15]` **El avance del día, en una línea y sin clic.** Reemplaza cuatro acordeones: medido
   * al entrar, 3 de 4 estaban cerrados —uno con TODA la deuda adentro— y al autorizar, la tabla de
   * pagos se plegaba y su contenido volvía a medias en otro paso. Lo que define el estado del día
   * se ve siempre (regla del PM: visibilidad en todo momento).
   */
  /**
   * `[PGP.33]` **Quién dispersa el día.** La etapa 4 decía `quien: 'Caja General'` fijo. Medido
   * contra prod el 2026-10-29 sobre los 4,898 pagos a proveedor del ERP: el **87.3 % del dinero**
   * ($404,105,108) sale de una cuenta de **banco** y lo dispersa **Tesorería**; Caja General son el
   * 56.7 % de los pagos por conteo pero el **12.7 % del dinero**. Nombrar sólo a una le decía a
   * quien mira el tablero que el otro no existe.
   *
   * Se deriva de la cuenta de origen de los pagos del día, no del método: una cuenta `cash` la
   * dispersa Caja General, una de banco o factoraje la dispersa Tesorería. Si no hay nada
   * preparado todavía no hay a quién nombrar, y se devuelve null en vez de inventarlo (ADR-056).
   */
  readonly ejecutoresDelDia = computed<string | null>(() => {
    const quien = new Set<string>();
    for (const a of this.allocations()) {
      if (!a.payment_method) continue;
      if (a.bank_account_kind === 'cash' || a.payment_method === 'efectivo') quien.add('Caja General');
      else if (a.bank_account_kind === 'bank' || a.bank_account_kind === 'factoraje') quien.add('Tesorería');
    }
    const orden = ['Tesorería', 'Caja General'].filter((e) => quien.has(e));
    return orden.length ? orden.join(' y ') : null;
  });

  readonly etapas = computed<Etapa[]>(() => {
    const day = this.selectedDay();
    if (!day) return [];
    const paso = this.pasoActivo();
    const n = this.allocations().length;
    const pend = this.pendingCount();
    const rel = this.isReleased();
    const est = (k: number): Etapa['estado'] => (k < paso ? 'hecho' : k === paso ? 'ahora' : 'pendiente');
    const reb = this.failedCount();
    return [
      // [PGP.49] Hecho, no repite «31 pagos · $7.13M»: ya lo publican el tope y «Pagos del día» (la
      // misma cifra salía 3 veces y el conteo 6). Sólo habla mientras es el paso en curso.
      { n: 1, nombre: 'Armar', quien: 'Tesorería', estado: est(1),
        dice: est(1) === 'hecho' ? '' : n ? `${this.pagos(n)} · ${this.moneyShort(this.dayTotal(day))}` : this.armadoChosen().length ? 'propuesta lista' : 'sin pagos' },
      { n: 2, nombre: 'Preparar', quien: 'Tesorería', estado: est(2),
        dice: rel ? 'listos' : pend ? `${pend - this.unpreparedCount()} de ${pend} listos` : '' },
      { n: 3, nombre: 'Autorizar', quien: 'Gerencia o Dirección', estado: est(3),
        dice: rel ? (day.lot_folio ? `folio ${day.lot_folio}` : 'autorizado') : paso === 3 ? (this.canAuthorize() ? 'listo para tu firma' : 'listo, espera la firma') : '' },
      { n: 4, nombre: 'Pagar', quien: this.ejecutoresDelDia() ?? 'Tesorería o Caja General', estado: est(4),
        dice: rel ? `${this.executedCount()} de ${n} pagados${reb ? ` · ${reb === 1 ? '1 rebotó' : reb + ' rebotaron'}` : ''}` : '' },
      { n: 5, nombre: 'Cerrar', quien: null, estado: est(5),
        dice: paso === 6 ? 'cerrado' : paso === 5 ? 'falta cerrar' : '' },
    ];
  });

  /**
   * `[PGP.15]` La lista de la deuda está SIEMPRE con el día abierto: en el acomodo de una pantalla
   * es el panel izquierdo, y plegarla dejaba el panel vacío. Sólo un día autorizado no la tiene
   * (ya no recibe pagos).
   */
  /**
   * `[PGP.48]` Un día que ya pasó tampoco recibe facturas: lo que se le agregara quedaría apartando
   * saldo en una fecha que nadie va a pagar (el diálogo de otro día ya exigía `>= hoy`; el «+» no).
   */
  readonly diaPasado = computed(() => this.selectedDate() < this.todayIso);
  readonly verDeuda = computed(() => {
    const liberado = this.isReleased();
    const pasado = this.diaPasado();
    return !liberado && !pasado;
  });
  /**
   * ⛔ `[PGP.52]` **La lista de deuda se abre al BUSCAR o con «Ver todas», no siempre.** Estaba
   * siempre abierta con ~1,000 renglones que nadie recorre (Edgar: «el 80 % es el buscador»), y
   * pedía su factura a la vista de evidencia en tandas de ~2.3 s aunque nadie la mirara. Cerrada,
   * no se pinta ni se piden evidencias; el total sigue a la vista en «Ver todas (N)».
   */
  readonly verLista = signal(false);
  /**
   * `[PGP.66]` Los paneles laterales de lo secundario. ⛔ La lista de deuda sólo existe con su panel
   * ABIERTO: el panel pinta su contenido aunque esté cerrado, y la lista pide evidencia en tandas de
   * ~2.3 s. Las cuatro señales se leen siempre (un `&&` que corta deja al computed sin dependencias).
   */
  readonly panelPronto = signal(false);
  readonly panelAgregar = signal(false);
  readonly listaAbierta = computed(() => {
    const puede = this.verDeuda();
    const panel = this.panelAgregar();
    const busca = !!this.busquedaAplicada();
    const pidio = this.verLista();
    return puede && panel && (busca || pidio);
  });
  abrirPronto(): void { this.panelAgregar.set(false); this.panelPronto.set(true); }

  /**
   * `[PGP.72]` «Ver con diferencias» de la franja del comprobante: esa lista vive en «Pagos a
   * proveedor», y se abre ya filtrada (`?estado=con_diferencias`) — no se repite aquí.
   */
  private readonly router = inject(Router);
  verComprobantesConDiferencias(): void { void this.router.navigate(['/finanzas/pagos-comprobantes'], { queryParams: { estado: 'con_diferencias' } }); }

  /** Abre el panel de agregar y lleva el foco al buscador (botón o tecla /). */
  abrirAgregar(): void { this.panelPronto.set(false); this.panelAgregar.set(true); this.enfocarBuscador(); }
  cerrarLista(): void {
    this.verLista.set(false);
    this.verRevision.set(false);
    if (this.busqueda()) { this.busqueda.set(''); this.buscarYa(); }
  }
  /**
   * `[PGP.52]` **El avance del día, en una línea** («Paso 2 de 5 · Preparar · Tesorería · 5 de 31
   * listos»). Eran cinco pasos con número, nombre y texto, siempre a la vista: ~60 px y 10 piezas
   * para decir en qué paso va el día, que es lo único que cambia.
   */
  readonly pasoTexto = computed(() => {
    const e = this.etapas().find((x) => x.estado === 'ahora');
    if (!e) return this.selectedDay()?.summary.lot_status === 'closed' ? 'Día cerrado' : '';
    // [PGP.62] Al preparar, «N de M listos» ya lo dicen el veredicto («Faltan N de M») y la barra («Los N sin preparar»).
    return [`Paso ${e.n} de 5: ${e.nombre}`, e.quien, e.n === 2 ? '' : e.dice].filter(Boolean).join(' · ');
  });

  /**
   * `[PGP.15]` **Los dos paneles llenan lo que queda de pantalla.** El desplazamiento de la página
   * lo hace el marco de la app (`section.pane`), no la ventana: se mide cuánto queda visible de ese
   * contenedor debajo del área de trabajo y se fija como alto. Se re-mide al cambiar el tamaño de la
   * ventana o de lo que está ARRIBA (la tira de días, el veredicto). Piso de 26rem: en una pantalla
   * baja la página se desplaza un poco en vez de dejar paneles inútiles. Angosto: sin alto fijo.
   */
  private altoObs?: ResizeObserver;
  private trabajoEl?: HTMLElement;
  @ViewChild('pgWork') set pgWorkRef(r: ElementRef<HTMLElement> | undefined) {
    this.altoObs?.disconnect();
    this.trabajoEl = r?.nativeElement;
    if (!this.trabajoEl || typeof ResizeObserver === 'undefined') return;
    const el = this.trabajoEl;
    this.altoObs = new ResizeObserver(() => this.ajustarAlto());
    for (const arriba of [el.previousElementSibling, document.querySelector('.pg-top')]) if (arriba) this.altoObs.observe(arriba);
    this.ajustarAlto();
  }
  /**
   * `[TBL.1]` **La pantalla temblaba, y éste era el lazo.** Medido en `0finanzasb` el 2026-11-02
   * con `PerformanceObserver('layout-shift')`, cinco elementos saltando a la vez:
   *
   * ```
   * section.pg-sec   844,366 1042x608 -> 838,366 1033x624   x-6  w-9  h+16
   * button.pg-rev-h   88,916  738x58  ->  88,932  738x58          y+16
   * span.pg-buscar   241,372  582x41  -> 235,372  582x41   x-6
   * button.pg-day   1375,207  253x49  -> 1364,207 251x49   x-11 w-2
   * ```
   *
   * Todo corre a la izquierda y se angosta mientras algo crece **+16 px de alto**. Ese 16 es
   * el margen que esta misma función reserva. El ciclo: el panel crece 16 px → el contenido
   * desborda → **aparece la barra de scroll del `.pane`** → la barra se come 9–11 px de ancho →
   * todo reflowea → el alto vuelve a cambiar → la barra se va → y de nuevo.
   *
   * Se corta por los dos lados:
   *   1. `scrollbar-gutter: stable` en `.pane` (`layout.component.css`): aparecer o irse la
   *      barra **deja de cambiar el ancho**, que es la mitad del lazo, y vale para toda la app.
   *   2. Acá, **histéresis de 24 px**: por debajo de eso no se re-escribe. 24 porque hay que
   *      tapar la oscilación medida (16 px) y el ancho de una barra de Windows (~15 px). El
   *      costo es que un cambio de ventana menor a 24 px no se refleja — 4 % de un panel de
   *      600 px, invisible al lado de un temblor permanente.
   *   3. Y la medición se difiere a `requestAnimationFrame`: escribir estilos **dentro** del
   *      callback de un `ResizeObserver` es lo que fuerza el reflow sincrónico de cada vuelta.
   *
   * ⚠️ Ocho hipótesis cayeron antes de ésta (el riel de pestañas, el DPI fraccional, VNC, la
   * GPU, el sidebar). Ninguna se pudo reproducir en banco: las barras de scroll de Chromium
   * headless son *overlay* y no se comen el ancho, así que **el lazo no cierra fuera de
   * Windows**. Si alguien vuelve a tocar esto, el instrumento que sí lo vio es
   * `PerformanceObserver` sobre `layout-shift` corriendo en la máquina que falla.
   */
  private altoPrev = 0;
  private altoRaf = 0;
  @HostListener('window:resize') ajustarAlto(): void {
    if (this.altoRaf) return; // ya hay una pasada pedida para este frame
    this.altoRaf = requestAnimationFrame(() => { this.altoRaf = 0; this.fijarAlto(); });
  }
  private fijarAlto(): void {
    const el = this.trabajoEl;
    if (!el) return;
    if (window.matchMedia('(max-width: 75rem)').matches) {
      el.style.removeProperty('--pg-alto');
      this.altoPrev = 0;
      return;
    }
    let pane: HTMLElement | null = el.parentElement;
    while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    const caja = pane ? pane.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const desplazado = pane ? pane.scrollTop : window.scrollY;
    const arriba = el.getBoundingClientRect().top - caja.top + desplazado;
    const visible = (pane ? pane.clientHeight : window.innerHeight) - arriba - 16;
    const piso = 26 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    let alto = Math.max(piso, Math.floor(visible));
    el.style.setProperty('--pg-alto', `${alto}px`);
    // Lo que todavía sobresale (el relleno inferior de la página) se descuenta: medido, quedaban 16 px de desplazamiento.
    const sobra = pane ? pane.scrollHeight - pane.clientHeight : 0;
    if (sobra > 0 && sobra < 120 && alto - sobra >= piso) alto -= sobra;
    // La histéresis: si el valor nuevo está dentro del ruido, se conserva el anterior. Sin
    // esto, el par (alto, alto-16) se persigue para siempre y eso es exactamente el temblor.
    if (this.altoPrev && Math.abs(alto - this.altoPrev) < ALTO_HISTERESIS_PX) alto = this.altoPrev;
    this.altoPrev = alto;
    el.style.setProperty('--pg-alto', `${alto}px`);
  }

  /** `[PGP.15]` Los pagos desglosados (abiertos a sus facturas). */
  readonly abiertos = signal<Record<string, boolean>>({});
  toggleAbierto(id: string): void {
    this.abiertos.update((m) => { const n = { ...m }; if (n[id]) delete n[id]; else n[id] = true; return n; });
    // `[PGP.58]` Al abrir un pago se busca el papel de sus facturas (si ya se buscó, no se repite).
    if (this.abiertos()[id]) void this.cargarEvidencias();
  }
  /**
   * `[PGP.58]` **Desde el pago se abre la factura** (Edgar, 2026-11-04: «¿puedo ver la factura en PDF
   * o imagen? ¿el folio interno para ubicarla?»). Las llaves de las facturas de los pagos abiertos;
   * la evidencia sale del MISMO lote que la lista de deuda (`cargarEvidencias`), no de otro camino.
   */
  private refsDePagosAbiertos(): string[] {
    const ab = this.abiertos();
    return this.allocations().filter((a) => ab[a.id])
      .flatMap((a) => (a.items ?? []).map((it) => (it.entity_ref ?? '').trim()));
  }
  evidenciaDeItem(it: { entity_ref?: string | null }): PayableEvidenceRow | null {
    const ref = (it.entity_ref ?? '').trim();
    return ref ? this.evidencias().get(ref) ?? null : null;
  }
  /** Ya respondió la búsqueda de ese documento (con o sin archivo): deja de decir «buscando…». */
  evidenciaBuscada(it: { entity_ref?: string | null }): boolean {
    return this.evidenciaRespondidas().has((it.entity_ref ?? '').trim());
  }

  readonly executedCount = computed(() => this.allocations().filter((a) => a.status === 'executed').length);
  readonly failedCount = computed(() => this.allocations().filter((a) => a.status === 'failed').length);
  readonly weekDaysWithWork = computed(() => this.weekDays().filter((d) => d.allocations.some((a) => a.status === 'pending' && !isPrepared(a))).length);
  /**
   * ⛔ `[PGP.49]` El porcentaje REAL, sin tope. Usaba `usedPct()`, que se topa en 100 para que la
   * barra no se salga de su caja, y el rótulo publicaba «100 % del tope» un día al 115.4 %
   * ($7,129,178.35 de $6,178,338, medido el 2026-11-03). La barra sigue topada; el número no.
   */
  usedPctRound(d: PaymentCalendarWeekDay): number {
    const cap = Number(d.summary.authorized_amount ?? 0);
    return cap > 0 ? Math.round((Number(d.summary.assigned_amount ?? 0) / cap) * 100) : 0;
  }

  /**
   * `[PGP.13]` **Lo que NO se puede programar todavía, separado de lo que sí.**
   *
   * Las facturas de sucursal anteriores al corte del 1-oct pueden estar pagadas desde Oficinas sin
   * haberse aplicado en la sucursal: programarlas las paga **dos veces**. Y esta pantalla las
   * ordenaba **primero**, porque ordena por antigüedad — el peor lugar posible para algo que no se
   * debe tocar. Se muestran (nunca se esconden, ADR-056) pero sin botón de agregar.
   *
   * ⚠️ El criterio sale de `anterior_al_corte`, que la vista ya calcula; acá se deriva del origen
   * y de la sucursal porque la lista no trae esa columna todavía. **Declarado**: es una
   * aproximación por fecha, no la columna del ERP — ver el aviso del cajón.
   */
  private readonly CORTE = '2026-10-01';
  readonly obligacionesEnRevision = computed(() => this.obligations().filter((o) => this.enRevision(o)));
  readonly obligacionesProgramables = computed(() => this.obligations().filter((o) => !this.enRevision(o)));
  /**
   * `[PGP.15]` **Cada renglón del cajón, con sus textos ya calculados.** El cajón tiene ~1,000
   * renglones y antes cada uno formateaba fecha, importe, sucursal y dos `aria-label` en CADA
   * ciclo de detección. Abrirlo congelaba la pantalla 15.9 s (medido). Se recalcula sólo cuando
   * cambia la lista o el día abierto (que entra en el `aria-label`).
   */
  readonly filasDeuda = computed(() => {
    const dia = this.dayLong(this.selectedDate());
    return this.obligacionesProgramables().map((o) => {
      const urge = o.pronto_estado === 'por_vencer';
      const pronto = o.pronto_beneficio && (urge || o.pronto_estado === 'capturable')
        ? { urge, texto: ` pierde ${this.money(o.pronto_beneficio)}${o.pronto_tasa ? ` (${this.pct(o.pronto_tasa)})` : ''}${o.pronto_fecha_limite ? ` si no se paga antes del ${this.shortDate(o.pronto_fecha_limite)}` : ''}` }
        : null;
      // [PGP.14] El credito a favor se precalcula aca, como todo lo demas de este renglon: son
      // ~1,000 filas y formatear en cada ciclo es lo que congelaba la pantalla 15.9 s.
      const cr = this.creditoDe(o);
      return {
        o, pronto,
        credito: cr ? `trae ${this.money(cr.a_favor)} a favor sin aplicar (${cr.clases.toLowerCase()})` : null,
        // [PGP.16] El costo de adelantar el pago. Pedido de Edgar: «hay que hacer los pagos lo
        // mas cercano a la fecha de vencimiento».
        adelanto: this.adelantoDe(o),
        // [PGP.48] Sólo los documentos con ficha (`oblig:`) tienen factura que buscar.
        buscaEvidencia: (o.entity_ref ?? '').trim().startsWith('oblig:'),
        sucursal: this.branchLabel(o.branch_code),
        vence: this.venceTxt(o),
        importe: this.money(o.available_amount),
        tituloFicha: 'Ver la ficha completa de ' + this.docLabel(o),
        ariaAgregar: `Agregar completa al ${dia}: ${o.beneficiary} ${o.concept}`,
        ariaOtro: `Agregar con otro importe o a otro día: ${o.beneficiary} ${o.concept}`,
      };
    });
  });
  /**
   * `[PGP.15]` Cuántos renglones del cajón están pintados. Primero 50 —lo que se ve sin desplazar—
   * y el resto en tandas de 50, una por cuadro (medido: ~1 ms por renglon en desarrollo), sin bloquear la pantalla. Al terminar están todos
   * (se pueden buscar con Ctrl+F); mientras tanto el cajón dice «Mostrando N de M…».
   */
  readonly deudaVisible = signal(50);
  private rampaId = 0;
  /** Si la lista ya estaba abierta cuando cambian sus datos (buscar, agregar), no vuelve a 50: saltaría el desplazamiento. */
  private rampaAbierta = false;
  private readonly rampaDeuda = effect(() => {
    // Cerrado no se calcula nada; al abrirse, `listaAbierta` cambia y el efecto vuelve a correr.
    // [PGP.52] Era `verDeuda`: con la lista siempre abierta, siempre se pintaba y se pedía evidencia.
    if (!this.listaAbierta()) { this.rampaAbierta = false; return; }
    const total = this.filasDeuda().length;
    untracked(() => {
      cancelAnimationFrame(this.rampaId);
      let n = Math.min(this.rampaAbierta ? Math.max(this.deudaVisible(), 50) : 50, total);
      this.rampaAbierta = true;
      this.deudaVisible.set(n);
      const paso = (): void => {
        n = Math.min(n + 50, total);
        this.deudaVisible.set(n);
        if (n < total) this.rampaId = requestAnimationFrame(paso);
      };
      if (n < total) this.rampaId = requestAnimationFrame(paso);
      // [PGP.21] La evidencia se pide sin bloquear. [PGP.48] De toda la lista, no sólo de los primeros 50.
      void this.cargarEvidencias();
    });
  });
  private enRevision(o: Obligation): boolean {
    if (o.obligation_source !== 'kepler_payable') return false;
    const suc = (o.branch_code ?? '').trim();
    if (!suc || suc === '00') return false; // Oficinas no tiene el problema: es desde donde se pagó
    const f = (o.original_due_date ?? '').slice(0, 10);
    return !!f && f < this.CORTE;
  }

  /**
   * `[PGP.14]` **El crédito a favor que nadie aplicó, en el renglón donde se decide pagar.**
   *
   * Medido contra prod el 2026-10-26: **$8,264,176 sin aplicar en 201 documentos**, de los cuales
   * **$4,484,249 son de 54 acreedores a los que además les debemos** — ésos son los neteables.
   * Casos reales: PRODUCTOS FRUTI FRESK debe $149,640 y trae **$2,000,820** a favor; SALSA MAGA
   * debe $294,687 y trae exactamente $294,687.
   *
   * ⛔ Sin esto, la pantalla deja programar la factura completa y el crédito se queda ahí. No se
   * BLOQUEA el pago —netear es una decisión de Finanzas con el proveedor, no una regla automática—
   * pero **no se puede decidir lo que no se ve**.
   *
   * ⚠️ Es un PISO, no un dictamen: `kdxf` sobre-cuenta lo aplicado (el control de cheques da
   * 105 %), y sobre-contar lo aplicado sub-cuenta lo pendiente.
   */
  readonly creditos = signal<ReadonlyMap<string, { a_favor: number; docs: number; clases: string }>>(new Map());
  creditoDe(o: Obligation | { payee_code?: string | null }): { a_favor: number; docs: number; clases: string } | null {
    const code = (o.payee_code ?? '').trim();
    return code ? this.creditos().get(code) ?? null : null;
  }
  /**
   * El crédito del grupo que la propuesta armó. ⚠️ Se busca por el código del acreedor de sus
   * facturas, **no por el nombre**: dos proveedores pueden llamarse igual y netear contra el
   * equivocado es peor que no avisar nada.
   */
  /**
   * `[PGP.38]` El vencimiento REAL del grupo. Hace falta porque `oldest` de un grupo que entró
   * sólo por descuento es el límite de su VENTANA, no un vencimiento: usarlo en el texto de
   * «venció el…» diría que una factura venció cuando todavía no.
   */
  vencimientoDelGrupo(g: ArmadoGrupo<Obligation>): string | null {
    const fechas = g.items.map((o) => vencimiento(o)).filter((d): d is string => !!d).sort();
    return fechas[0] ?? null;
  }

  creditoDeGrupo(g: ArmadoGrupo<Obligation>): { a_favor: number; docs: number; clases: string } | null {
    for (const it of g.items) { const c = this.creditoDe(it); if (c) return c; }
    return null;
  }
  /**
   * `[PGP.21]` **La factura del proveedor, en el renglón donde se decide pagar.**
   *
   * Lo pedido era no ir a buscarla a mano. Lo que hay detrás no es un carril sino un motor:
   * `analytics.v_payable_evidence` junta TODO lo que podría probar el documento —el PDF que
   * Compras adjunta y el CFDI recibido— y puntúa cada candidato por cuántas de 5 señales
   * coinciden (importe, fecha, folio, referencia, RFC), exigiendo siempre un ancla de importe
   * o RFC y un puntaje mínimo de 3.
   *
   * Medido contra prod el 2026-10-27 sobre 2,917 documentos exigibles: **774 traen el PDF del
   * proveedor**, 369 sólo el UUID fiscal, 1,809 nada. Placebo del umbral: **0** (precisión
   * 100 %). Bajar a puntaje 2 subiría la cobertura a 59.7 % con **45 % de precisión**, o sea
   * más de la mitad de las facturas pegadas al pago equivocado: por eso no se baja.
   *
   * ⛔ Los que no tienen evidencia **dicen por qué** (ADR-056) y nunca quedan en blanco.
   *
   * ⭐ `[PGP.27]`, re-medido el 2026-10-28: el RFC del acreedor dejó de salir sólo de
   * `kdxd.c10`. Si ahí no hay nada **o lo que hay no tiene forma de RFC** (188 acreedores, 368
   * documentos por $20,232,802 — `BALO20930EL9` por `BAL020930EL9`, guiones, dígitos de menos),
   * lo resuelve el nombre normalizado contra ContPAQi y los CFDI recibidos. **1,125 → 1,291
   * documentos con evidencia (+166) y +$10,415,534**, con 0 que pierdan lo que ya tenían y
   * control negativo 0. Cuando el RFC salió de ahí, el renglón lo dice: `rfcDeducido()`.
   */
  readonly evidencias = signal<ReadonlyMap<string, PayableEvidenceRow>>(new Map());
  evidenciaDe(o: Obligation): PayableEvidenceRow | null {
    const ref = (o.entity_ref ?? '').trim();
    return ref ? this.evidencias().get(ref) ?? null : null;
  }
  /**
   * `[PGP.27]` El RFC con el que se encontró la factura, **sólo cuando no vino de Kepler**.
   *
   * Devuelve `null` —y la pantalla no dice nada— cuando el RFC salió del ERP, que es el caso
   * normal, o cuando no hay evidencia (ahí el motivo ya lo explica). Así el aviso aparece en
   * los 166 renglones donde la procedencia cambia la lectura y no en los 1,123 donde no.
   *
   * ⛔ `[PGP.32]` **Que esto devuelva un RFC ya no quiere decir que Kepler no tenga ninguno.**
   * Desde `[PGP.31]` el nombre también gana cuando Kepler tiene uno bien formado pero distinto
   * (ADR-108): 18 acreedores, 91 documentos. Cuál de los dos casos es lo dice `rfc_discrepa`, y
   * la plantilla ramifica ahí — un rótulo que afirme «Kepler no tiene RFC» sobre esos 91 miente.
   */
  rfcDeducido(e: PayableEvidenceRow): string | null {
    return e.evidencia !== 'ninguna' && e.rfc_fuente === 'nombre' && e.rfc ? e.rfc : null;
  }

  /** Qué se puede decir del documento en una línea, sin prometer lo que no hay. */
  evidenciaTexto(e: PayableEvidenceRow): string {
    if (e.evidencia === 'pdf') return 'Ver la factura del proveedor';
    if (e.evidencia === 'uuid') return 'Sin archivo; hay UUID fiscal del CFDI';
    return e.motivo ?? 'sin evidencia';
  }

  /**
   * Pide la evidencia de los documentos QUE SE VEN, en una sola llamada.
   *
   * ⛔ Una llamada por acreedor sería lo natural y está mal: la vista tiene un piso MEDIDO de ~2.2-2.5 s
   *    que no baja al filtrar, así que ese piso se multiplicaría por cada acreedor en pantalla.
   * ⛔ COSTO MEDIDO 2026-10-27, y pasa el tope: ~2.2-2.5 s. NINGUN filtro empuja a la vista
   *    (concatenada 2,886-3,722 ms · por columnas 2,135-2,599 ms · por acreedor 2,419-2,506 ms),
   *    probablemente por el DISTINCT ON, que es barrera de optimizacion. Un 371 ms que medi
   *    antes era CACHE CALIENTE y lo cite como costo: estaba mal.
   *    Por eso esta llamada es DIFERIDA y NO bloquea: la tabla se pinta completa y la marca de
   *    la factura aparece despues. Mientras no se materialice la vista, es la unica forma
   *    honesta de ofrecerla sin romper la regla de >500 ms.
   * ⚠️ No bloquea nada. Si falla, los renglones se quedan sin la marca y el resto de la pantalla
   *    sigue funcionando — la factura es una ayuda, no un requisito para programar el pago.
   */
  /**
   * ⛔ `[PGP.48]` **Antes sólo pedía los primeros 50.** El efecto que la llama corre cuando la rampa
   * acaba de pintar 50 renglones, y nadie la volvía a llamar: del 51 al ~1,000 no salía ni «Ver la
   * factura» ni el motivo — el hueco mudo que esta función existe para evitar. Ahora pide TODA la
   * lista, en tandas de 200 (el tope del endpoint) y **una tras otra**: cada consulta cuesta su piso
   * de ~2.3 s aunque se filtre, y en paralelo serían cinco a la vez contra la misma vista.
   * Mientras llega, el renglón dice «buscando la factura…»; si una tanda falla, lo dice también.
   */
  readonly evidenciaFallo = signal(false);
  private readonly evidenciaPedida = new Set<string>();
  /**
   * `[PGP.49]` Los documentos cuya búsqueda YA respondió (con o sin factura). Se cuenta por respuesta,
   * no por si llegó fila: un documento que el endpoint no devolviera dejaría «buscando…» para siempre.
   */
  private readonly evidenciaRespondidas = signal<ReadonlySet<string>>(new Set());
  /** Cuántos renglones de la lista todavía no saben si tienen factura. Lo dice una línea, no cada renglón. */
  readonly evidenciaPendientes = computed(() => {
    const listos = this.evidenciaRespondidas();
    return this.filasDeuda().filter((f) => f.buscaEvidencia && !listos.has((f.o.entity_ref ?? '').trim())).length;
  });
  private evidenciaCorriendo = false;
  private async cargarEvidencias(): Promise<void> {
    if (this.evidenciaCorriendo) return;
    this.evidenciaCorriendo = true;
    let refs: string[] = [];
    try {
      for (;;) {
        // `[PGP.58]` Primero las facturas de los pagos ABIERTOS: es donde alguien está revisando.
        refs = [...this.refsDePagosAbiertos(), ...this.filasDeuda().map((f) => (f.o.entity_ref ?? '').trim())]
          .filter((r, i, all) => r.startsWith('oblig:') && all.indexOf(r) === i
            && !this.evidenciaRespondidas().has(r) && !this.evidenciaPedida.has(r))
          .slice(0, 200);
        if (!refs.length) return;
        refs.forEach((r) => this.evidenciaPedida.add(r));
        const rows = await firstValueFrom(this.http.get<PayableEvidenceRow[]>(
          `${this.base}/evidencia`, { params: { refs: refs.join(',') } },
        ));
        const m = new Map(this.evidencias());
        for (const r of rows ?? []) if (r?.entity_ref) m.set(r.entity_ref, r);
        this.evidencias.set(m);
        this.evidenciaRespondidas.set(new Set([...this.evidenciaRespondidas(), ...refs]));
        this.evidenciaFallo.set(false);
      }
    } catch {
      // Sin marca; la pantalla sigue y la línea de arriba lo dice. La tanda que falló se puede volver a pedir.
      refs.forEach((r) => this.evidenciaPedida.delete(r));
      this.evidenciaFallo.set(true);
    } finally {
      this.evidenciaCorriendo = false;
    }
  }
  reintentarEvidencias(): void {
    this.evidenciaFallo.set(false);
    void this.cargarEvidencias();
  }

  /**
   * Abre el PDF en una pestaña nueva, con URL prefirmada de 600 s.
   *
   * ⛔ Lo sirve el endpoint de PAGOS, no el de Compras: medido el 2026-10-27, de los 32 roles con
   *    `FINANCE_PAYMENTS_VER` hay **3 sin `COMPRAS_ENTRADAS_VER`** —`finanzas_operativo`
   *    (Tesorería), `contabilidad` y `auditor_externo`—, así que enlazar allá le habría dado 403
   *    justo a quien hace el pago.
   */
  abrirFactura(e: PayableEvidenceRow): void {
    if (e.evidencia !== 'pdf' || !e.ref_evidencia) return;
    firstValueFrom(this.http.get<Array<{ url: string; role: string | null }>>(
      `${this.base}/evidencia/archivo/${encodeURIComponent(e.ref_evidencia)}`,
    )).then((files) => {
      // La factura primero; si no viene rotulada, el primer archivo que haya.
      // ⛔ [PGP.59] Sólo se abre una URL http(s): una LLAVE del bucket (el servidor no pudo
      // firmarla) abría «Cannot GET …» en una pestaña nueva. Misma regla que doc-viewer `servible()`.
      const abribles = (files ?? []).filter((x) => /^https?:\/\//i.test(x?.url ?? ''));
      const f = abribles.find((x) => x.role === 'factura') ?? abribles[0];
      if (f) window.open(f.url, '_blank', 'noopener');
      else if ((files ?? []).length) this.toast.add({ severity: 'error', summary: 'No se pudo preparar la factura', detail: 'Está guardada, pero el servidor no pudo generar su enlace de lectura. Avisa a Sistemas.', life: 10000 });
      else this.toast.add({ severity: 'warn', summary: 'Sin archivo', detail: 'El comprobante existe pero no trae un archivo que pueda abrir.' });
    }).catch((e) => this.toast.add({
      severity: 'error', summary: 'No pude abrir la factura',
      // El servidor dice la causa (almacén sin configurar, comprobante inexistente); si no la dice, el caso conocido.
      detail: e?.error?.message || 'El enlace se firma al momento y expira en 10 minutos. Intenta de nuevo.',
      life: 10000,
    }));
  }

  // ── [PGP.17] El desglose: qué aplicar, de qué tipo, y qué ya se aplicó ──────────────────────
  readonly creditoAbierto = signal<{ code: string; nombre: string } | null>(null);
  readonly creditoDetalle = signal<Array<{ sucursal: string; clase: string; folio: string; referencia: string | null; fecha: string | null; importe: number; aplicado: number; a_favor: number; pendiente: boolean }>>([]);
  readonly creditoCargando = signal(false);
  readonly creditoError = signal<string | null>(null);
  /** Lo pendiente primero: es lo único sobre lo que se puede actuar. */
  readonly creditoPendientes = computed(() => this.creditoDetalle().filter((d) => d.pendiente));
  readonly creditoAplicados = computed(() => this.creditoDetalle().filter((d) => !d.pendiente));
  readonly creditoTotalPendiente = computed(() => this.creditoPendientes().reduce((s, d) => s + Number(d.a_favor), 0));
  readonly creditoTotalAplicado = computed(() => this.creditoAplicados().reduce((s, d) => s + Number(d.aplicado), 0));

  /**
   * `[PGP.17]` Abre el desglose de un acreedor. Pedido de Edgar: *«especificando todo tipo de
   * descuento para que sepan qué aplicar desde Suite»* — el aviso dice CUÁNTO, esto dice **de qué
   * tipo, de qué documento y si ya se aplicó**, que es lo único con lo que alguien puede actuar.
   */
  abrirCreditos(code: string | null | undefined, nombre: string): void {
    const c = (code ?? '').trim();
    if (!c) return;
    this.creditoAbierto.set({ code: c, nombre });
    this.creditoDetalle.set([]);
    this.creditoError.set(null);
    this.creditoCargando.set(true);
    this.http.get<SupplierCreditRow[]>(
      `${this.base}/creditos-a-favor/${encodeURIComponent(c)}`,
    ).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.creditoDetalle.set(rows ?? []); this.creditoCargando.set(false); },
      // ⛔ Error ≠ vacío: «no se pudo leer» no se puede pintar como «no tiene descuentos».
      error: (e) => { this.creditoError.set(e?.error?.message || 'No se pudo leer el desglose.'); this.creditoCargando.set(false); },
    });
  }

  /** `[PGP.48]` Un mapa vacío por falla no es un mapa vacío por dato: se dice junto al buscador. */
  readonly creditosError = signal(false);
  private loadCreditos(): void {
    this.http.get<SupplierUnappliedCreditRow[]>(`${this.base}/creditos-a-favor`)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => {
          this.creditos.set(new Map((rows ?? []).filter((r) => r.con_deuda_viva)
            .map((r) => [r.proveedor, { a_favor: Number(r.a_favor), docs: r.docs, clases: r.clases }])));
          this.creditosError.set(false);
        },
        // ⛔ Que falle esto NO puede tumbar la pantalla: es un aviso, no el dato con el que se paga.
        // [PGP.48] Pero tampoco se calla: decía «se declara en consola» y no se declaraba en ningún lado,
        // así que $4.5M de crédito a favor desaparecían de los renglones sin que nadie lo supiera.
        error: () => { this.creditos.set(new Map()); this.creditosError.set(true); },
      });
  }

  /** El orden de la lista de deuda, como una sola decisión en vez de dos casillas sueltas. */
  /**
   * ⛔ `[PGP.50]` **Por omisión, lo más cercano a hoy.** Era «Vence primero» (vencimiento
   * ascendente) y la lista se topa en 1,000: entregaba las 1,000 MÁS VIEJAS. Medido el 2026-11-03,
   * el corte caía en el 1-jun-2026 y **0 de las 160 facturas que vencen esta semana
   * ($9,022,851.47) estaban en la lista**, mientras el rótulo decía «las más próximas a vencer».
   * Con `cercania`: 160 de 160. El orden viejo sigue, con el nombre que dice lo que hace.
   */
  readonly ordenOpts = [
    // [PGP.51] Cortos: el selector mide 8.5rem y «Más cercanas a hoy» salía cortado con «…».
    { label: 'Cerca de hoy', value: 'cercania' },
    { label: 'Más vencidas', value: 'vencimiento' },
    { label: 'Pierde descuento', value: 'descuento' },
  ];
  ordenSel: 'cercania' | 'vencimiento' | 'descuento' = 'cercania';
  /** Lo que dice el resumen de la lista sobre QUÉ parte trae cuando viene topada. */
  ordenDice(): string {
    return this.ordenSel === 'descuento' ? 'las que pierden descuento primero'
      : this.ordenSel === 'vencimiento' ? 'las más vencidas primero'
      : 'las más cercanas a hoy, vencidas o por vencer';
  }
  onOrden(): void { this.loadObligations(); }

  /** El primer pago al que le falta algo: el que el veredicto nombra y al que lleva su botón. */
  primerIncompleto(): PaymentCalendarAllocation | null {
    return this.allocations().find((a) => a.status === 'pending' && !isPrepared(a)) ?? null;
  }
  /** Qué le falta, dicho con el nombre del campo que hay que llenar. */
  faltaDe(a: PaymentCalendarAllocation): string {
    if (!a.payment_method) return 'el método';
    if (a.payment_method !== 'efectivo' && !a.bank_account_id) return 'la cuenta de origen';
    if (a.payment_method === 'transferencia' && !(a.destination_account_text ?? '').trim()) return 'la cuenta destino';
    return 'un dato';
  }

  /**
   * `[PGP.11]` **El veredicto: qué falta, dicho en una frase, con el botón que lo destraba.**
   *
   * `[PGP.15]` Cubre el proceso ENTERO —de la propuesta al cierre— y su botón hace lo que dice:
   * guardar la propuesta, preparar, autorizar, marcar los pagados, mover el que rebotó y cerrar el
   * día. Antes el veredicto terminaba en «Autorizado» y el proceso no tenía salida en la pantalla.
   * Y ya no lleva tono salvo cuando algo está MAL: «bien» y «falta» eran verde y ámbar, dos
   * colores para decir lo que la frase ya dice.
   */
  readonly verdict = computed<Verdict>(() => {
    const day = this.selectedDay();
    if (!day) return { tone: 'muted', say: 'Elige un día en la tira de arriba.', why: null, action: null };
    const s = day.summary;

    /*
     * `[PGP.48]` **Un día que ya pasó con pagos pendientes está MAL, no «faltan por preparar».**
     * Antes este día caía en las ramas de abajo como si todavía se fuera a pagar. Medido el
     * 2026-11-03: 23 pagos, $5,696,319.13, en 5 días del 19 al 29-oct, ninguno preparado — y cada
     * uno aparta el saldo de sus facturas, que por eso no salían en la lista ni en la propuesta.
     */
    if (!this.isReleased() && this.diaPasado() && this.pendingCount() > 0) {
      /*
       * `[PGP.96]` **Lo que Kepler ya pagó no «no se pagó».** Medido el 2026-11-06: el 3-nov decía
       * «sus 17 pagos no se pagaron ($4,442,169.62)» y Kepler tenía pagados 30 de los 71 pendientes
       * de días pasados. Ahora el veredicto cuenta sólo lo que falta y dice aparte lo que se pagó.
       */
      const pend = this.pendientesSinPagar();
      const conc = this.conciliadosDelDia();
      const totalConc = this.conciliadosTotal();
      if (!pend.length) {
        return { tone: 'ok',
          say: `Este día ya pasó y Kepler registra ${conc.length === 1 ? 'su pago' : `sus ${conc.length} pagos`} (${this.money(totalConc)}).`,
          why: 'En «Cómo sale» de cada pago está el documento de Kepler que lo saldó: folio, día y cuenta. No hay nada que mover.',
          action: null };
      }
      const total = pend.reduce((t, a) => t + Number(a.amount_assigned || 0), 0);
      const yaPagados = conc.length ? `${conc.length === 1 ? 'Otro ya lo pagó' : `Otros ${conc.length} ya los pagó`} Kepler (${this.money(totalConc)}). ` : '';
      return { tone: 'bad',
        say: `Este día ya pasó y ${pend.length === 1 ? (conc.length ? 'un pago no se pagó' : 'su pago no se pagó') : `${conc.length ? '' : 'sus '}${pend.length} pagos no se pagaron`} (${this.money(total)}).`,
        why: `${yaPagados}Mientras sigan aquí apartan el saldo de sus facturas: no salen en «Agregar facturas» ni en la propuesta. Muévelos a otro día, o quita con la X los que ya no van.`,
        action: { kind: 'mover', label: pend.length === 1 ? 'Moverlo a otro día' : `Mover los ${pend.length} a otro día`, icon: 'pi-calendar' } };
    }

    if (this.isReleased()) {
      const n = this.allocations().length;
      const ex = this.executedCount();
      // [PGP.14] Un pago rebotado es lo primero: lo urgente no puede quedar debajo de «Autorizado».
      const fallidos = this.allocations().filter((a) => a.status === 'failed');
      if (fallidos.length) {
        const f = fallidos[0];
        return { tone: 'bad',
          say: fallidos.length === 1 ? 'Un pago rebotó y hay que moverlo a otro día.' : `${fallidos.length} pagos rebotaron y hay que moverlos a otro día.`,
          why: `${this.allocationTitle(f)} · ${this.money(f.amount_assigned)} — ${f.failure_reason || 'sin motivo registrado'}.`,
          action: { kind: 'rebote', label: 'Mover a otro día', icon: 'pi-calendar' } };
      }
      if (s.lot_status === 'closed') {
        return { tone: 'ok', say: 'El día está cerrado.', why: `${ex} de ${this.pagos(n)} marcados como pagados.`, action: null };
      }
      const pend = this.pendingCount();
      if (pend > 0) {
        const listos = this.porPagar().length;
        return { tone: 'ok',
          say: `Autorizado: ${this.pagos(pend)} por pagar, ${this.money(this.porPagarTotal())}.`,
          why: `${this.ejecutoresDelDia() ?? 'Quien dispersa'} ejecuta con la instrucción impresa, que dice pago por pago a quién le toca. Cuando el banco confirme, márcalos pagados de una vez; si uno rebota, márcalo en su fila.`,
          action: listos ? { kind: 'pagar', label: listos === 1 ? 'Marcar pagado' : `Marcar los ${listos} pagados`, icon: 'pi-check' } : null };
      }
      return { tone: 'ok', say: 'Todos los pagos se marcaron: falta cerrar el día.',
        why: `${ex} de ${this.pagos(n)} marcados como pagados. Cerrar deja el día como terminado.`,
        action: { kind: 'cerrar', label: 'Cerrar el día', icon: 'pi-lock' } };
    }
    /*
     * ⛔ `[PGP.48]` Este «sin tope» iba ANTES de la rama del día vacío, así que la propuesta que
     * `[PGP.42]` arma para un día sin tope salía con casillas y SIN botón para guardarla: marcar no
     * llevaba a ningún lado. Ahora sólo responde aquí el día sin tope que ya tiene pagos; el vacío
     * sigue abajo, donde está la propuesta, y lo dice ahí.
     */
    const sinTope = !s.capacity_defined;
    if (sinTope && this.allocations().length) {
      return { tone: 'muted', say: 'Presupuestos no fijó el tope de este día.',
        why: 'Se pueden armar pagos, pero el día no se autoriza hasta que lo fije.', action: null };
    }
    if (s.exceeded) {
      const say = `Excede el tope del día por ${this.money(Math.abs(Number(s.remaining_amount ?? 0)))}.`;
      // [PGP.51] PRIMERO lo que el ERP ya no debe: quitarlo no cuesta nada y baja el exceso. Mover
      // pagos que sí se deben mientras eso sigue adentro es mover dinero de más.
      const exceso = Math.abs(Number(s.remaining_amount ?? 0));
      const saldado = this.saldadasDelDiaTotal();
      if (saldado > 0.005) {
        const resta = exceso - saldado;
        return { tone: 'bad', say,
          why: resta > 0.005
            ? `De lo comprometido, ${this.money(saldado)} el ERP ya no lo debe: quitarlo es lo primero y deja el exceso en ${this.money(resta)}. Después se propone qué mover.`
            : `De lo comprometido, ${this.money(saldado)} el ERP ya no lo debe: quitarlo deja el día dentro del tope.`,
          action: { kind: 'saldadas', label: `Quitar lo que el ERP ya no debe (${this.moneyShort(saldado)})`, icon: 'pi-times' } };
      }
      // [PGP.50] Decía «Mueve o quita pagos» sin botón, y el sistema ya sabe qué mover y a dónde.
      const p = this.propuestaExceso();
      if (p) {
        const cuantos = p.pagos.length === 1 ? 'el último pago' : `los últimos ${p.pagos.length}`;
        const n = p.pagos.length === 1 ? '1 pago' : `${p.pagos.length} pagos`;
        // [PGP.73] Lo que se juega antes del clic: los que se mueven y traen pronto pago abierto.
        const conPronto = p.pagos.filter((a) => (a.pronto_captura ?? 0) > 0);
        const pronto = conPronto.length
          ? ` Ojo: ${conPronto.length === 1 ? 'uno trae' : `${conPronto.length} traen`} pronto pago (${this.money(conPronto.reduce((s, a) => s + (a.pronto_captura ?? 0), 0))}).`
          : '';
        // [PGP.77] Sólo lo que el botón no dice: cuánto se mueve. A dónde va lo dice el botón, y
        // cuál va a qué día, la ventana que abre.
        return { tone: 'bad', say,
          why: p.destinos
            ? `Mover ${cuantos} del orden (${this.money(p.total)}) lo resuelve.${pronto}`
            : `Mover ${cuantos} del orden (${this.money(p.total)}) lo resuelve, pero lo libre de la semana no alcanza: elige la fecha.${pronto}`,
          action: { kind: 'exceso', label: p.destinos ? `Mover ${n} al ${this.diasDestino(p.destinos)}` : `Mover ${n} a otro día`, icon: 'pi-calendar' } };
      }
      return { tone: 'bad', say, why: 'Mueve o quita pagos, o pide a Presupuestos ampliarlo.', action: null };
    }
    if (!this.allocations().length) {
      /*
       * `[PGP.15]` **La propuesta ya está hecha al entrar.** Antes había que encontrar y apretar
       * «Sugerir armado» para ver algo que el sistema ya sabía calcular; ahora el botón principal
       * es guardarla, y el orden de pago se propone solo al guardar.
       */
      if (day.date < this.todayIso) return { tone: 'muted', say: 'Este día ya pasó y no tuvo pagos.', why: null, action: null };
      if (this.armadoCargando()) return { tone: 'muted', say: 'Calculando la propuesta para este día…', why: 'Se lee toda la deuda una sola vez.', action: null };
      const err = this.armadoError();
      if (err) return { tone: 'muted', say: 'No se pudo calcular la propuesta.', why: err, action: { kind: 'proponer', label: 'Reintentar', icon: 'pi-refresh' } };
      const arm = this.armado();
      const n = this.armadoChosen().length;
      if (arm && n) {
        const parcial = this.armadoUniverso();
        return { tone: 'ok',
          say: sinTope ? `Propuesta: ${this.pagos(n)} marcados por ${this.money(this.armadoTotal())}.`
                       : `Propuesta: ${this.pagos(n)} por ${this.money(this.armadoTotal())}, caben en el tope.`,
          why: (sinTope
            ? 'Presupuestos no fijó el tope de este día: se puede guardar, pero el día no se autoriza hasta que lo fije. Al guardarla, el orden de pago se propone solo.'
            : 'Abajo está cada pago: quita lo que no quieras pagar hoy. Al guardarla, el orden de pago se propone solo.') + (parcial ? ' ' + parcial : ''),
          action: { kind: 'armar', label: 'Guardar la propuesta', icon: 'pi-check' } };
      }
      if (arm) {
        if (sinTope && arm.length) {
          return { tone: 'muted', say: 'Marca en la propuesta lo que entra este día.',
            why: 'Presupuestos no fijó el tope, así que nada viene marcado solo. Al marcar, aquí aparece el botón para guardarla.', action: null };
        }
        return { tone: 'muted', say: arm.length ? 'Nada de lo vencido cabe en el tope de este día.' : 'No hay facturas vencidas ni por vencer para este día.',
          why: 'Si hay que pagar algo, agrégalo desde «Agregar facturas».' + (sinTope ? ' Presupuestos no fijó el tope de este día.' : ''), action: null };
      }
      return { tone: 'muted', say: 'Este día no tiene pagos.',
        why: 'Agrégalos desde «Agregar facturas».' + (sinTope ? ' Presupuestos no fijó el tope de este día.' : ''), action: null };
    }
    if (this.pendingCount() === 0) return { tone: 'muted', say: 'Este día no tiene pagos pendientes.', why: null, action: null };
    if (this.unpreparedCount() > 0) {
      // [PGP.13] El veredicto NOMBRA el renglón y su botón lleva a arreglarlo (DESIGN §Q.3 y §Q.4).
      const a = this.primerIncompleto()!;
      const n = this.unpreparedCount();
      // [PGP.15] SIN botón aquí: repetía lo que ya hace «Para los N pagos» (Edgar: «estás repitiendo dos
      // veces el botón de elegir método»). La frase dice dónde se resuelve; el botón principal del paso es
      // «Aplicar a los N», en la barra de los pagos, y lo de un solo pago es «Preparar» en su fila.
      const sinMetodo = this.allocations().filter((x) => x.status === 'pending' && !x.payment_method).length;
      // [PGP.44] El rótulo se cita TEXTUAL: si el botón dice «Para 1 pago» y esto manda a
      // «Para los 1 pagos», el aviso apunta a algo que no existe en pantalla.
      // [PGP.49] El rótulo de la barra cambió a «Para los N sin preparar»: se cita igual.
      // [PGP.60] Y volvió a cambiar a «Los N sin preparar:» (PGP.52) sin que esto lo siguiera: el
      // veredicto citaba un rótulo que no existía en pantalla (visto en captura el 2026-11-04).
      // [PGP.75] Con el historial cubriendo a alguno, lo único que se decide es de qué cuenta sale el día.
      const conHistorial = [...this.sugerencias().values()].filter((x) => x.metodo).length;
      const donde = conHistorial > 1
        ? `El historial trae el método de ${conHistorial}: elige abajo de qué cuenta sale el día y aplica, en «Los ${this.unpreparedCount()} sin preparar»`
        : sinMetodo > 1 ? `Elige método y cuenta de origen abajo, en «Los ${this.unpreparedCount()} sin preparar»` : `Usa «Preparar» en su fila`;
      return { tone: 'ok',
        say: n === 1 ? `Falta ${this.faltaDe(a)} de 1 pago para poder autorizar el día.`
                     : `Faltan ${n} de ${this.pendingCount()} pagos por preparar.`,
        why: `${donde}. ${this.allocationTitle(a)} · ${this.money(a.amount_assigned)} — le falta ${this.faltaDe(a)}.`,
        action: null };
    }
    if (this.unrankedCount() > 0) {
      // [PGP.15] Ya no deberia pasar: armar y agregar ordenan solos. Si una escritura de orden fallo, se ofrece aqui.
      return { tone: 'ok',
        say: `Faltan ${this.unrankedCount()} de ${this.pendingCount()} pagos por ordenar.`,
        why: 'Quien dispersa paga en ese turno, así que sin orden el día no se autoriza.',
        action: { kind: 'ordenar', label: 'Proponer orden', icon: 'pi-sort-amount-down' } };
    }
    if (this.canAuthorize()) {
      return { tone: 'ok',
        say: `Listo para autorizar: ${this.pagos(this.pendingCount())} por ${this.money(s.assigned_amount)}.`,
        why: 'Autorizas el día completo. Después se dispersa con la instrucción impresa, que nombra a quién le toca cada pago.',
        action: { kind: 'autorizar', label: 'Autorizar el día', icon: 'pi-lock' } };
    }
    return { tone: 'ok',
      say: `Los ${this.pendingCount()} pagos están ordenados y preparados.`,
      why: 'Falta que Gerencia o Dirección autorice el día.', action: null };
  });
  readonly weekLabel = computed(() => {
    const w = this.week();
    if (!w) return '—';
    return `${this.fmt(w.from, { day: 'numeric', month: 'short' })} – ${this.fmt(w.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  });

  classificationFilter: string | null = null;
  /** `[PGP.15]` Lo que se escribe en el buscador (señal: la lee `gruposBusqueda` y el resumen). */
  readonly busqueda = signal('');
  /** El término con el que se pidió la lista que está a la vista (no lo que se va tecleando). */
  readonly busquedaAplicada = signal('');
  readonly buscando = signal(false);
  private busquedaTimer: ReturnType<typeof setTimeout> | null = null;
  private obligSeq = 0;
  onlyCritical = false;

  obligations = signal<Obligation[]>([]);
  loadingObligations = signal(false);
  /** `[PGP.48]` La lectura falló: la lista dice el error y su reintento, no «Sin obligaciones» ni «0 por pagar». */
  readonly obligationsError = signal<string | null>(null);
  /** `[TP.17.2]` Cuántas obligaciones hay de verdad, más allá del techo que devolvió el servidor. */
  readonly obligationsTotal = signal(0);
  /**
   * ⚠️ Lee los DOS signals siempre: nada de `&&` que corte antes del segundo. Un `computed()` que
   * no alcanza a leer una señal se queda sin esa dependencia y **no vuelve a recalcular**
   * (la compuerta `reactividad` existe por eso).
   */
  readonly obligationsTruncated = computed(() => {
    const total = this.obligationsTotal();
    const mostradas = this.obligations().length;
    return total > mostradas;
  });
  saving = signal(false);

  classificationOpts = [
    { label: 'Compromiso financiero', value: 'compromiso_financiero' },
    { label: 'Gasto', value: 'gasto' },
    { label: 'Proveedor de mercancía', value: 'proveedor_mercancia' },
  ];
  methodOpts = [
    { label: 'Transferencia', value: 'transferencia' },
    { label: 'Cheque', value: 'cheque' },
    { label: 'Efectivo', value: 'efectivo' },
    { label: 'Cargo automático', value: 'cargo_automatico' },
  ];
  /** Día al que va un pago nuevo desde «Otro importe u otro día». */
  targetDate = this.todayIso;

  quickAddVisible = false;
  quickAddTarget = signal<Obligation | null>(null);
  /** Lo tecleado, tal cual (puede traer coma de miles): se lee con `importeQuick()`. */
  quickAddAmount: number | string = 0;

  prepareVisible = false;
  prepAllocation: PaymentCalendarAllocation | null = null;
  /**
   * `[PGP.30]` Hábito de pago por `supplier_id`. Se carga una vez (316 filas, 292 ms medidos) en
   * vez de una consulta por pago: el día más cargado trae 16 pagos.
   */
  habitos = signal<ReadonlyMap<string, SupplierPaymentHabit>>(new Map());
  /** ⛔ No se funde con «no tiene hábito»: un mapa vacío por falla no es un mapa vacío por dato (ADR-056). */
  habitosError = signal(false);
  /** El hábito con el que se precargó el diálogo abierto. `null` si se eligió todo a mano. */
  habitoUsado = signal<SupplierPaymentHabit | null>(null);

  prepMethod: string | null = null;
  prepDestination = '';
  /** `[PGP.75]` La CLABE que el diálogo precargó de los comprobantes del proveedor (para decirlo y para cederle el lugar al catálogo). */
  prepDestHistorial: string | null = null;
  prepReference = '';
  prepCash = '';
  prepAccountId: string | null = null;
  prepOriginId: string | null = null;
  prepSupplierId: string | null = null;
  prepAccounts = signal<{ id: string; label: string }[]>([]);
  /** Un 403/500 del catálogo NO es «el proveedor no tiene cuentas»: se dice distinto. */
  readonly prepAccountsError = signal<string | null>(null);
  /**
   * `[PGP.46]` **La CLABE que alguien ya capturó para este proveedor, esperando aprobación.**
   *
   * Medido en prod el 2026-11-03: el catálogo tiene **0 cuentas**, así que hasta hoy el diálogo
   * pedía teclear los 18 dígitos **cada vez** — el mismo proveedor, la misma CLABE, otra semana.
   * Ahora la primera captura queda pedida de alta y las siguientes la encuentran acá.
   *
   * ⛔ Se propone, **no se da por buena**: es una captura de alguien, todavía sin aprobar, y el
   * renglón lo dice con quién y cuándo. Es el patrón de `[PGP.30]` — un valor puesto solo, sin
   * decir con qué, es una orden disfrazada.
   */
  readonly prepPedida = signal<{ clabe: string; banco: string | null; quien: string | null; cuando: string | null } | null>(null);
  /**
   * `[PGP.41]` **Qué hay que pagar, sin que nadie lo pida.** Se carga al abrir la pantalla, no
   * al apretar un botón: el pedido de Edgar (2026-10-31) fue *«ya el mismo sistema me debe
   * decir qué pago»*, y una respuesta que hay que ir a buscar no es esa respuesta.
   *
   * ⛔ No arma nada solo: PROPONE. El dinero sigue saliendo con una firma.
   */
  readonly quePagar = signal<PagoSugerido[]>([]);
  readonly quePagarError = signal<string | null>(null);
  readonly quePagarGana = computed(() => this.quePagar().reduce((s, r) => s + Number(r.gana || 0), 0));

  /**
   * `[PGP.53]` **El pronto pago es la prioridad, y la pantalla lo dice con su porqué.** Edgar,
   * 2026-11-04: *«esa es la prioridad: recomendar firmemente que paguemos eso y por qué, y darle
   * prioridad en base a su vencimiento»*. Era una línea plegada debajo del buscador.
   *
   * Grupos por el día en que CIERRA el descuento (la vista ya ordena por días restantes y, dentro,
   * por lo que gana). Hoy y mañana nacen abiertos; los demás días, una línea con su cuenta.
   */
  readonly prontoGrupos = computed(() => {
    const out: { cierra: string; dias: number; filas: PagoSugerido[]; importe: number; gana: number }[] = [];
    for (const r of this.quePagar()) {
      let g = out.find((x) => x.cierra === r.cierra);
      if (!g) { g = { cierra: r.cierra, dias: Number(r.dias_restantes), filas: [], importe: 0, gana: 0 }; out.push(g); }
      g.filas.push(r);
      g.importe += Number(r.importe || 0);
      g.gana += Number(r.gana || 0);
    }
    return out;
  });
  /**
   * `[PGP.61]` **Los 3 días que cierran primero; el resto, en una línea con su cuenta** (Edgar,
   * 2026-11-04: *«no debemos mostrar tantos, 2 o 3 en pronto pago está más que perfecto»*). Eran 8
   * grupos, ~370 px. Plegar no es esconder: la línea dice cuántos días, acreedores, importe y cuánto
   * se gana adentro, y el total de arriba («en los próximos 7 días ganas») sigue contándolos.
   */
  readonly prontoVerTodos = signal(false);
  readonly prontoVisibles = computed(() => {
    const gs = this.prontoGrupos();
    return this.prontoVerTodos() ? gs : gs.slice(0, 3);
  });
  readonly prontoResto = computed(() => {
    const resto = this.prontoGrupos().slice(3);
    return {
      dias: resto.length,
      acreedores: resto.reduce((s, g) => s + g.filas.length, 0),
      importe: resto.reduce((s, g) => s + g.importe, 0),
      gana: resto.reduce((s, g) => s + g.gana, 0),
    };
  });
  /** Lo que cierra hoy o mañana: lo único que no puede esperar. */
  readonly prontoUrgente = computed(() => {
    const gs = this.prontoGrupos().filter((g) => g.dias <= 1);
    return {
      acreedores: gs.reduce((s, g) => s + g.filas.length, 0),
      importe: gs.reduce((s, g) => s + g.importe, 0),
      gana: gs.reduce((s, g) => s + g.gana, 0),
    };
  });
  /** Lo urgente pasa de lo libre del día abierto: hay que escoger, y se dice con qué criterio. */
  readonly prontoNoCabe = computed(() => {
    const s = this.selectedDay()?.summary;
    return !!s?.capacity_defined && this.prontoUrgente().importe > Number(s.remaining_amount ?? 0);
  });
  private readonly prontoAbiertos = signal<Record<string, boolean>>({});
  /**
   * `[PGP.64]` → `[PGP.66]` En la pantalla principal, «Cierra hoy» (7) y «Cierra mañana» (2) abiertos hacían
   * medir al pronto pago 449 px (medido el 2026-11-04 a 2135×1232) y por eso nacieron cerrados. Desde
   * `[PGP.66]` el pronto pago vive en su panel lateral, con lugar de sobra: lo urgente vuelve a nacer abierto.
   */
  // [PGP.66] En su panel lateral hay lugar: lo que cierra hoy o mañana vuelve a nacer abierto (PGP.53).
  prontoAbierto(g: { cierra: string; dias: number }): boolean { return this.prontoAbiertos()[g.cierra] ?? g.dias <= 1; }
  togglePronto(g: { cierra: string; dias: number }): void {
    this.prontoAbiertos.update((m) => ({ ...m, [g.cierra]: !this.prontoAbierto(g) }));
  }
  /** El acreedor con su «por qué» abierto (uno a la vez: es un desglose, no un reporte). */
  readonly prontoPorQue = signal<string | null>(null);
  prontoCierraDice(dias: number, cierra: string): string {
    return dias === 0 ? 'Cierra hoy' : dias === 1 ? 'Cierra mañana' : `Cierra el ${this.dayShort(cierra)}`;
  }
  acreedores(n: number): string { return `${n} ${n === 1 ? 'acreedor' : 'acreedores'}`; }

  /**
   * `[PGP.48]` Los días ya pasados que todavía tienen pagos pendientes (ver `pendientesAtrasados`
   * en el servicio). Se releen con la semana, porque cada escritura puede vaciar uno.
   */
  readonly atrasados = signal<PagosAtrasadosDia[]>([]);
  readonly atrasadosError = signal(false);
  readonly atrasadosPagos = computed(() => this.atrasados().reduce((s, d) => s + Number(d.pagos || 0), 0));
  readonly atrasadosMonto = computed(() => this.atrasados().reduce((s, d) => s + Number(d.monto || 0), 0));
  readonly atrasadosRango = computed(() => {
    const d = this.atrasados();
    if (!d.length) return '';
    const a = this.shortDate(d[0].date);
    const b = this.shortDate(d[d.length - 1].date);
    return a === b ? a : `${a} – ${b}`;
  });
  private loadAtrasados(): void {
    this.http.get<PagosAtrasadosDia[]>(`${this.base}/pendientes-atrasados`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // `[PGP.95]` Un día cuyos pendientes ya pagó Kepler no está atrasado: el aviso cuenta sólo lo que falta.
      next: (rows) => { this.atrasados.set((rows ?? []).filter((d) => Number(d.pagos) > 0)); this.atrasadosError.set(false); },
      error: () => { this.atrasados.set([]); this.atrasadosError.set(true); },
    });
  }
  /** Abre un día de cualquier semana (la tira se mueve a la suya). */
  irAlDia(fecha: string): void {
    this.armado.set(null);
    this.selectedDate.set(fecha);
    this.targetDate = fecha;
    this.reload();
  }

  readonly originOpts = signal<{ id: string; label: string }[]>([]);

  reprogramVisible = false;
  /** `[PGP.48]` Lo que mueve el diálogo «Mover a otro día»: uno, o todos los pendientes de un día ya pasado. */
  reprogramTodos: PaymentCalendarAllocation[] = [];
  reprogramDate = this.todayIso;
  reprogramReason: ReprogramReason | null = null;
  reprogramReasonDetail = '';

  // ── [PGP.15] Caja General: marcar pagados de una vez, y el pago que rebota ──────────────────
  pagarVisible = false;
  /** Lo que «Marcar los N pagados» marca: pendiente y preparado (el backend exige método). */
  /**
   * `[PGP.35]` **Cuánto del total del día ya NO lo debe el ERP.** El encabezado publicaba
   * «27 pagos · $6,683,082.26» como deuda viva, y medido contra prod el 2026-10-29
   * **$2,506,811.31 de esos (11 pagos) ya estaban saldados en Kepler** — pagados por fuera o con
   * nota de crédito. `execute()` los rechaza, pero eso se descubre al final del día, después de
   * preparar, autorizar y firmar.
   *
   * ⛔ El total NO se recorta por cuenta propia: cambiar una cifra publicada sin que nadie lo pida
   * es peor que declararla. Se publica al lado, y quien decide saca el renglón si corresponde.
   */
  readonly saldadasDelDia = computed(() => {
    // `[PGP.96]` Lo que Kepler ya pagó en un día que corrió no es «hay que sacarlo»: es el cierre.
    const pasado = this.diaPasado();
    return this.allocations().filter((a) => a.status === 'pending' && (a.kepler_saldadas ?? 0) > 0
      && !(pasado && cierreCompleto(a.kepler_cierre)));
  });

  /**
   * `[PGP.96]` **Los pagos pendientes que Kepler ya saldó por completo**, en un día que ya pasó.
   * Están pagados aunque nadie los marcó en la Suite: el dinero salió por Kepler y el banco. Medido
   * el 2026-11-06: ningún día del Calendario se había marcado pagado; de 71 pendientes en días
   * pasados, 30 ($6.05 M) ya los había pagado Kepler. Sólo en días pasados: en uno por venir, lo que
   * Kepler ya pagó sigue siendo «quítalo del día» (ocupa el tope de un día que todavía se arma).
   */
  readonly conciliadosDelDia = computed(() => {
    const pasado = this.diaPasado();
    return pasado ? this.allocations().filter((a) => a.status === 'pending' && cierreCompleto(a.kepler_cierre)) : [];
  });
  readonly conciliadosTotal = computed(() => this.conciliadosDelDia().reduce((s, a) => s + Number(a.amount_assigned || 0), 0));
  /** `[PGP.96]` Los pendientes que de verdad faltan: lo que un día pasado tiene que mover. */
  readonly pendientesSinPagar = computed(() => {
    const ya = new Set(this.conciliadosDelDia().map((a) => a.id));
    return this.allocations().filter((a) => a.status === 'pending' && !ya.has(a.id));
  });
  /** `[PGP.96]` El cierre de Kepler del pago, si Kepler ya lo saldó en un día pasado; null si no. */
  pagadoEnKepler(a: PaymentCalendarAllocation): CierreKeplerPago | null {
    return this.conciliadosDelDia().some((x) => x.id === a.id) ? a.kepler_cierre : null;
  }
  readonly textoCierre = textoCierre;
  nombreTipo(t: PagoKeplerDelCierre['tipo']): string { return nombreTipoPagoKepler(t); }
  /** El documento con PDF que se abre desde el renglón: el primero con comprobante. */
  pdfDelCierre(c: CierreKeplerPago): PagoKeplerDelCierre | null { return c.pagos.find((p) => !!p.comprobante_id) ?? null; }
  /**
   * `[PGP.96]` Por qué un documento no trae PDF, dicho (ADR-056). Medido el 2026-11-06: el último
   * comprobante de transferencia entró el 5-oct, y los pagos de sucursal no están en el espejo de
   * pagos (`analytics.erp_supplier_payments` sólo lee oficinas), así que no se les puede subir uno.
   */
  sinPdfPorque(p: PagoKeplerDelCierre): string | null {
    if (!esPagoConDinero(p.tipo)) return null; // una nota de crédito no tiene comprobante bancario
    if (p.sucursal !== '00') return 'pago de sucursal: todavía no se le puede subir comprobante';
    return 'sin comprobante subido';
  }
  private readonly comprobantes = inject(PagosComprobantesService);
  /** Abre el PDF del comprobante con la URL firmada que da el detalle del pago (mismo permiso que esta pantalla). */
  abrirComprobante(p: PagoKeplerDelCierre): void {
    firstValueFrom(this.comprobantes.detail(p.sucursal, p.folio, p.doc_prefix)).then((d) => {
      const dep = d.deposits.find((x) => x.id === p.comprobante_id) ?? d.deposits[0];
      // ⛔ [PGP.59] Sólo una URL http(s): una llave del bucket abre «Cannot GET …».
      const abribles = (dep?.files ?? []).filter((f) => /^https?:\/\//i.test(f?.url ?? ''));
      const f = abribles.find((x) => x.role === 'comprobante') ?? abribles[0];
      if (f) window.open(f.url, '_blank', 'noopener');
      else if ((dep?.files ?? []).length) this.toast.add({ severity: 'error', summary: 'No se pudo preparar el comprobante', detail: 'Está guardado, pero el servidor no pudo generar su enlace de lectura. Avisa a Sistemas.', life: 10000 });
      else this.toast.add({ severity: 'warn', summary: 'Sin archivo', detail: 'El comprobante existe pero no trae un archivo que pueda abrir.' });
    }).catch((e) => this.toast.add({
      severity: 'error', summary: 'No pude abrir el comprobante',
      detail: e?.error?.message || 'El enlace se firma al momento y expira en 10 minutos. Intenta de nuevo.', life: 10000,
    }));
  }
  /*
   * ⛔ `[PGP.51]` Sumaba `amount_assigned` —el pago COMPLETO— de todo pago con AL MENOS una factura
   * saldada: un pago de 4 facturas con 1 saldada contaba las 4. El rótulo dice «de los cuales $X el
   * ERP ya no los debe», así que la cifra es sólo lo saldado (`kepler_saldadas_importe`).
   */
  readonly saldadasDelDiaTotal = computed(() =>
    this.saldadasDelDia().reduce((s, a) => s + Number(a.kepler_saldadas_importe || 0), 0));
  readonly saldadasVisible = signal(false);
  /**
   * `[PGP.51]` **Quita del día lo que el ERP ya no debe, todo de una vez.** Es lo primero que hay que
   * hacer con un día excedido: no cuesta nada (marcarlo pagado fallaría igual) y baja lo
   * comprometido. El 3-nov la propuesta de mover proponía 6 pagos ($1,015,591.37) con ese dinero
   * todavía adentro. Un pago con TODAS sus facturas saldadas sale del día (la ✕ de su fila); uno con
   * algunas, pierde sólo ésas (`[PGP.48]`). Fallos parciales reportados (DESIGN §10).
   */
  async quitarTodoLoSaldado(): Promise<void> {
    const pagos = this.saldadasDelDia();
    if (!pagos.length || this.saving()) return;
    this.saving.set(true);
    let ok = 0;
    const fallas: string[] = [];
    for (const a of pagos) {
      try {
        if (this.noSePuedePagar(a)) {
          await firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/cancelar`, { reason: 'El ERP ya no debe sus facturas' }));
        } else {
          for (const it of a.items.filter((x) => x.kepler_saldada)) {
            await firstValueFrom(this.http.delete(`${this.base}/allocations/${a.id}/items/${it.id}`));
          }
        }
        ok++;
      } catch (e) {
        fallas.push(`${this.allocationTitle(a)}: ${this.errMsg(e, 'error')}`);
      }
    }
    this.saving.set(false);
    this.saldadasVisible.set(false);
    this.invalidarDeuda();
    this.reload();
    if (ok) this.toast.add({ severity: 'success', summary: 'Quitado lo que ya no se debe', detail: `${ok} de ${this.pagos(pagos.length)}.` });
    if (fallas.length) this.toast.add({ severity: 'error', summary: `${fallas.length} no se quitaron`, detail: fallas.join(' · '), life: 10000 });
  }

  /**
   * `[PGP.36]` **La cuenta de resultados del día.** El encabezado publicaba «27 pagos ·
   * $6,683,082.26» y con eso nadie podia juzgar si el día estaba bien armado. Ahora dice qué
   * descuento captura y cuál deja pasar, que es la pregunta que el Calendario existe para
   * contestar.
   */
  readonly diaCaptura = computed(() =>
    this.allocations().filter((a) => a.status === 'pending').reduce((s, a) => s + Number(a.pronto_captura || 0), 0));
  readonly diaDejaPasar = computed(() =>
    this.allocations().filter((a) => a.status === 'pending').reduce((s, a) => s + Number(a.pronto_deja_pasar || 0), 0));

  /**
   * `[PGP.36]` **Por qué este pago está hoy en el día.** Una frase por renglón, con su evidencia.
   *
   * ⭐ Las CUATRO hablan, y ésa es la diferencia con lo de antes: el renglón sólo decía algo
   * cuando convenía pagar («gana $X si pagás antes del…»). Medido contra prod el 2026-10-29
   * sobre $139.6M de deuda viva, eso dejaba **mudos $97.4M**: $23.9M fuera de ventana y
   * $73.5M sin medir. Y un silencio se lee como «acá no hay nada que ganar».
   *
   * ⛔ Las tres negativas dicen cosas distintas y no se mezclan:
   *   · `fuera_de_ventana` → se pasó la mediana de lo que funcionó. **Todavía se puede intentar.**
   *   · `sin_medir` → nunca observamos un descuento de este proveedor. **No sabemos**, que no es
   *     lo mismo que saber que no da.
   *   · `null` → no aplica: este renglón no es una factura del ERP.
   */
  razonDePago(a: PaymentCalendarAllocation): { tono: 'gana' | 'urge' | 'tarde' | 'mudo'; texto: string; detalle: string } | null {
    if (a.pronto_captura > 0) {
      // `[PGP.91]` El MISMO universo que el servidor suma en `pronto_captura`: capturable o por vencer y sin
      // pronto pago ya capturado. Sobre todas las facturas, la fecha, la urgencia y la tasa podían ser de
      // una ya capturada, que no está en el importe que se publica.
      const est = (a.items ?? []).filter((it) => it.discount_reason !== 'pronto_pago'
        && (it.pronto_estado === 'capturable' || it.pronto_estado === 'por_vencer'));
      const urge = est.some((it) => it.pronto_estado === 'por_vencer');
      const lim = est.map((it) => it.pronto_fecha_limite).filter(Boolean).sort()[0];
      const tasa = est.map((it) => it.pronto_tasa).find((t) => t != null);
      return {
        tono: urge ? 'urge' : 'gana',
        texto: `Gana ${this.money(a.pronto_captura)}${tasa ? ' (' + this.pct(tasa) + ')' : ''}${lim ? ' si se paga antes del ' + this.shortDate(lim) : ''}`,
        detalle: 'El descuento sale de los pagos de este proveedor que de hecho lo obtuvieron, no de una condición pactada: es una guía medida, no una promesa.',
      };
    }
    if (a.pronto_deja_pasar > 0) {
      return {
        tono: 'tarde',
        texto: `Deja pasar ${this.money(a.pronto_deja_pasar)}: se pasó la ventana de pronto pago`,
        detalle: 'Se pasó la mediana de lo que históricamente funcionó con este proveedor. NO está perdido: todavía se puede pedir.',
      };
    }
    // `[PGP.91]` Una factura con descuento ya capturado no es «sin descuento medido»: tiene uno, dicho.
    const kp = (a.items ?? []).filter((it) => it.pronto_estado != null && !(this.numero(it.discount_amount) > 0));
    if (kp.length && kp.every((it) => it.pronto_estado === 'sin_medir')) {
      return {
        tono: 'mudo',
        texto: 'Sin descuento medido en este proveedor',
        detalle: 'Nunca observamos un pago con descuento suyo (hacen falta 3). NO significa que no dé: significa que no lo sabemos. Si pactó condiciones, captúralas en su ficha.',
      };
    }
    return null;
  }

  readonly porPagar = computed(() => this.allocations().filter((a) => a.status === 'pending' && isPrepared(a)));
  readonly porPagarTotal = computed(() => this.porPagar().reduce((s, a) => s + Number(a.amount_assigned || 0), 0));
  /** `[PGP.35]` De los que se van a marcar, cuántos el servidor va a rechazar por saldo. */
  /**
   * `[PGP.70]` **Lo que marca el diálogo «Marcar como pagados»**: el lote del día, o UN pago cuando se
   * abre desde «Pagado» en su fila. Esa fila marcaba con un clic, sin confirmar, algo que aquí no se
   * deshace — mientras el lote pedía confirmación para el mismo acto.
   */
  readonly pagarSolo = signal<PaymentCalendarAllocation | null>(null);
  readonly pagarLista = computed(() => { const a = this.pagarSolo(); return a ? [a] : this.porPagar(); });
  readonly pagarListaTotal = computed(() => this.pagarLista().reduce((s, a) => s + Number(a.amount_assigned || 0), 0));
  readonly pagarListaSaldadas = computed(() => this.pagarLista().filter((a) => (a.kepler_saldadas ?? 0) > 0).length);
  abrirPagar(a: PaymentCalendarAllocation | null): void {
    this.pagarSolo.set(a);
    this.pagarVisible = true;
  }
  /** `[PGP.70]` El pago que la ✕ de su fila quiere quitar del día; abre su confirmación. */
  readonly quitarObjetivo = signal<PaymentCalendarAllocation | null>(null);
  /** `[PGP.92]` La factura que su ✕ en el desglose quiere quitar del pago; abre su confirmación. */
  readonly quitarFacturaObjetivo = signal<{ a: PaymentCalendarAllocation; it: PaymentCalendarAllocationItem } | null>(null);

  /**
   * `[PGP.92]` Cómo se nombra una factura en un aviso. ⛔ En una saldada `concept` puede venir «—»:
   * eso no se publica como nombre; se cae a la referencia del proveedor o al importe.
   */
  nombreFactura(it: PaymentCalendarAllocationItem): string {
    const c = (it.concept ?? '').trim();
    if (c && c !== '—') return c;
    const ref = (it.doc_ref ?? '').trim();
    return ref ? `la factura ${ref}` : `la factura de ${this.money(it.applied_amount)}`;
  }

  /** `[PGP.92]` Lo que le queda al pago sin esa factura. `Number()`: los numeric de Postgres llegan como texto. */
  restaDelPago(a: PaymentCalendarAllocation, it: PaymentCalendarAllocationItem): number {
    return Math.round((Number(a.amount_assigned) - Number(it.applied_amount)) * 100) / 100;
  }

  /**
   * `[PGP.92]` Ya confirmado. No muta `a.items`: la vista se rehace con `reload()`, y mientras tanto
   * las ✕ siguen apagadas por `loadingWeek()` (un segundo clic no manda un segundo DELETE).
   */
  confirmarQuitarFactura(): void {
    const q = this.quitarFacturaObjetivo();
    if (!q || this.saving()) return;
    const { a, it } = q;
    this.saving.set(true);
    this.http.delete(`${this.base}/allocations/${a.id}/items/${it.id}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false); this.quitarFacturaObjetivo.set(null); this.invalidarDeuda(); this.reload();
        this.toast.add({ severity: 'success', summary: 'Factura quitada',
          detail: `Se quitó ${this.nombreFactura(it)} (${this.money(it.applied_amount)}) del pago de ${this.allocationTitle(a)}. ${it.kepler_saldada ? 'El ERP ya no la debía: no regresa a la deuda' : 'Regresa a lo que se debe'}; el pago sigue con ${this.facturas(a.items.length - 1)}.` });
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'No se quitó la factura', detail: `${this.nombreFactura(it)}: ${this.errMsg(e, 'No se pudo quitar.')}`, life: 10000 });
      },
    });
  }

  // ── [PGP.91] Descuento al pagar, factura por factura ──────────────────────
  /** La cuenta pura, expuesta a la plantilla (lo cubierto = neto + descuento, con `Number()`). */
  readonly cubiertoDe = cubiertoDe;
  /**
   * `[PGP.91]` Sólo factura de mercancía (la que después recibe la nota de crédito) y que el ERP
   * todavía debe. El servidor exige lo mismo (`assertDescuentoPermitido`); aquí sólo no se ofrece
   * lo que va a rechazar.
   */
  admiteDescuento(a: PaymentCalendarAllocation, it: PaymentCalendarAllocationItem): boolean {
    return a.classification === 'proveedor_mercancia' && !it.kepler_saldada
      && (it.obligation_source === 'kepler_payable' || it.obligation_source === 'supplier_payable');
  }
  /** `[PGP.91]` El motivo dicho en llano: «Pronto pago 3 %», «Volumen», «Otro · apoyo de aniversario». */
  motivoDescuento(reason: MotivoDescuento | null | undefined, rate: number | string | null | undefined, note: string | null | undefined): string {
    if (!reason || reason === 'ninguno') return '';
    const t = this.numero(rate);
    return `${DISCOUNT_REASON_LABEL[reason] ?? reason}${t > 0 ? ' ' + this.pct(t) : ''}${reason === 'otro' && note ? ' · ' + note : ''}`;
  }

  /** `[PGP.91]` La factura cuyo descuento se está capturando; abre el diálogo. Estado en signals (OnPush). */
  readonly descObjetivo = signal<{ a: PaymentCalendarAllocation; it: PaymentCalendarAllocationItem } | null>(null);
  readonly descMotivo = signal<MotivoDescuento>('ninguno');
  readonly descModo = signal<ModoDescuento>('tasa');
  /**
   * Lo tecleado, tal cual: el % se lee con `tasaDePct` («3,5» = 3.5 %), los pesos con `leerPesos`
   * (⛔ no con `numero()`: quitaba las comas y «1166,40» pasaba como $116,640).
   */
  readonly descPct = signal('');
  readonly descPesos = signal('');
  readonly descNota = signal('');
  /** El % vino de la tasa OBSERVADA de pronto pago (D2): se dice en el diálogo, no se afirma pactado. */
  readonly descSugerida = signal(false);
  /** Sin «Sin descuento»: para quitarlo está su botón; un motivo vacío es el placeholder. */
  readonly descuentoOpts = DISCOUNT_REASONS.map((k) => ({ label: DISCOUNT_REASON_LABEL[k], value: k }));
  readonly descCubierto = computed(() => { const t = this.descObjetivo(); return t ? cubiertoDe(t.it) : 0; });
  /** Los pesos tecleados, entendidos o con el porqué de no entenderlos (ambiguo ≠ ilegible ≠ vacío). */
  readonly descPesosLeidos = computed(() => leerPesos(this.descPesos()));
  readonly descCuenta = computed(() => cuenta(this.descCubierto(), this.descModo(), this.descPct(), this.descPesosLeidos().pesos ?? 0));
  readonly descFalta = computed<string | null>(() => {
    // Todas las señales se leen siempre (sin cortocircuito), para que el computed no se quede sin dependencias.
    const motivo = this.descMotivo(), modo = this.descModo(), leidos = this.descPesosLeidos(), c = this.descCuenta(), cub = this.descCubierto(), nota = this.descNota();
    return faltaDescuento(motivo, c, cub, nota, modo === 'pesos' ? leidos.error : null);
  });

  /** Abre con lo guardado tal cual: con tasa queda en %, capturado en pesos queda en pesos. */
  abrirDescuento(a: PaymentCalendarAllocation, it: PaymentCalendarAllocationItem): void {
    const d = this.numero(it.discount_amount);
    const pct = pctDeTasa(it.discount_rate);
    this.descMotivo.set(d > 0 && it.discount_reason ? it.discount_reason : 'ninguno');
    this.descModo.set(d > 0 && !pct ? 'pesos' : 'tasa');
    this.descPct.set(d > 0 ? pct : '');
    this.descPesos.set(d > 0 && !pct ? d.toFixed(2) : '');
    this.descNota.set(it.discount_note ?? '');
    this.descSugerida.set(false);
    this.descObjetivo.set({ a, it });
  }
  cerrarDescuento(): void { this.descObjetivo.set(null); }
  /**
   * `[PGP.91]` D2: al elegir «Pronto pago» con el campo activo vacío se precarga la tasa OBSERVADA del
   * proveedor (y se dice que lo es). Si se cambia a otro motivo, la sugerencia se va con él: el % de
   * pronto pago no es el de un descuento por volumen.
   */
  elegirMotivoDescuento(m: DiscountReason | null): void {
    const motivo: MotivoDescuento = m ?? 'ninguno';
    const t = this.descObjetivo();
    if (this.descSugerida() && motivo !== 'pronto_pago') { this.descPct.set(''); this.descSugerida.set(false); }
    this.descMotivo.set(motivo);
    // «Vacío» se mide en el campo ACTIVO: el inactivo muestra lo derivado, no lo que guarda su señal.
    const vacio = this.descModo() === 'tasa' ? !this.descPct().trim() : !this.descPesos().trim();
    if (motivo === 'pronto_pago' && vacio && t && t.it.pronto_tasa != null && Number(t.it.pronto_tasa) > 0) {
      this.descModo.set('tasa');
      this.descPct.set(String(round2(Number(t.it.pronto_tasa) * 100)));
      this.descSugerida.set(true);
    }
  }
  /** `[PGP.91]` Guarda (o quita, con 0) el descuento de UNA factura. El botón se apaga en el primer clic. */
  guardarDescuento(quitar: boolean): void {
    const t = this.descObjetivo();
    if (!t || this.saving()) return;
    const motivo = this.descMotivo();
    const c = this.descCuenta();
    if (!quitar && (motivo === 'ninguno' || this.descFalta())) return;
    const { a, it } = t;
    const body: PaymentCalendarItemDiscountBody = quitar || motivo === 'ninguno'
      ? { discount_amount: 0 }
      : {
          discount_amount: c.descuento, discount_reason: motivo,
          discount_rate: this.descModo() === 'tasa' ? c.tasa : null,
          discount_note: motivo === 'otro' ? this.descNota().trim() : null,
        };
    this.saving.set(true);
    this.http.post<PaymentCalendarItemDiscountResult>(`${this.base}/allocations/${a.id}/items/${it.id}/descuento`, body)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.saving.set(false); this.descObjetivo.set(null); this.invalidarDeuda(); this.reload();
          this.toast.add(this.numero(r.discount_amount) > 0
            ? { severity: 'success', summary: 'Descuento guardado',
                detail: `${this.nombreFactura(it)}: se transfieren ${this.money(r.applied_amount)} (descuento ${this.money(r.discount_amount)}). El pago de ${this.allocationTitle(a)} queda en ${this.money(r.amount_assigned)}.` }
            : { severity: 'success', summary: 'Descuento quitado',
                detail: `${this.nombreFactura(it)} vuelve a pagarse sin descuento: ${this.money(r.applied_amount)}. El pago de ${this.allocationTitle(a)} queda en ${this.money(r.amount_assigned)}.` });
        },
        error: (e) => {
          this.saving.set(false);
          this.toast.add({ severity: 'error', summary: quitar ? 'No se quitó el descuento' : 'No se guardó el descuento',
            detail: `${this.nombreFactura(it)}: ${this.errMsg(e, 'No se pudo guardar.')}`, life: 10000 });
        },
      });
  }
  reboteVisible = false;
  reboteAllocation: PaymentCalendarAllocation | null = null;
  reboteReason: ReprogramReason | null = null;
  reboteDetail = '';
  reboteDate = '';
  /** Los motivos de reprogramar que describen un rebote («presupuesto recortado» no lo es). */
  readonly reboteReasonOpts = REPROGRAM_REASON_OPTS.filter((o) => o.value !== 'presupuesto_recortado');

  ngOnInit(): void {
    // `[TBL.1]` También el frame del ajuste de alto: si el componente se va con uno pendiente,
    // `fijarAlto()` corre sobre un elemento ya desconectado y mide ceros.
    this.destroyRef.onDestroy(() => {
      cancelAnimationFrame(this.rampaId);
      if (this.altoRaf) cancelAnimationFrame(this.altoRaf);
      this.altoObs?.disconnect();
    });
    this.recuperarPreparacion();
    this.reload();
    // [PGP.14] El credito a favor sin aplicar: se pide UNA vez y se guarda por acreedor.
    this.loadCreditos();
    // [PGP.30] El habito de pago de cada acreedor. Sin toast y sin bloquear: si no llega, el
    // diálogo pide todo a mano como hasta ahora — pero lo DICE, no lo calla.
    this.http.get<SupplierPaymentHabit[]>(`${this.base}/payment-habits`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => this.habitos.set(new Map((rows ?? []).map((r) => [String(r.supplier_id), r]))),
      error: () => this.habitosError.set(true),
    });
    // `[PGP.41]` Qué hay que pagar, al abrir. Si falla, se DECLARA: una lista vacía por error
    // se leería como «no hay nada que ganar», que es lo contrario de lo que pasa.
    this.http.get<PagoSugerido[]>(`${this.base}/que-pagar`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.quePagar.set(rows ?? []); this.quePagarError.set(null); },
      error: (e) => { this.quePagar.set([]); this.quePagarError.set(e?.error?.message || 'No se pudo calcular qué conviene pagar.'); },
    });
    this.http.get<PaymentOriginAccount[]>(`${this.base}/origin-accounts`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        this.originOpts.set(rows.map((r) => ({ id: r.id, label: r.alias ? `${r.alias} (${r.bank})` : `${r.bank} ${r.account_label}` })));
        // Una cuenta recordada que ya no está en el catálogo no se propone: se pide de nuevo.
        if (this.bulkOriginId && !rows.some((r) => r.id === this.bulkOriginId)) this.bulkOriginId = null;
      },
      error: () => this.originOpts.set([]),
    });
  }

  /** Fecha civil local (no UTC): a las 19:00 en CDMX el UTC ya es mañana. */
  private today(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  private addDays(iso: string, n: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const x = new Date(Date.UTC(y, m - 1, d + n));
    return x.toISOString().slice(0, 10);
  }
  private fmt(iso: string, opts: Intl.DateTimeFormatOptions): string {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('es-MX', { ...opts, timeZone: 'UTC' });
  }
  /**
   * `[PGP.15]` **Con memoria.** Las fechas se pintan en cada ciclo de detección y en cada renglón
   * (el cajón de la deuda tiene ~1,000): `toLocaleDateString` arma un formateador nuevo por llamada.
   * Una fecha da siempre el mismo texto, así que se calcula una vez.
   */
  private readonly fechasCache = new Map<string, string>();
  private fmtMemo(clave: string, iso: string, opts: Intl.DateTimeFormatOptions): string {
    const k = clave + iso;
    let v = this.fechasCache.get(k);
    if (v === undefined) { v = this.fmt(iso, opts); this.fechasCache.set(k, v); }
    return v;
  }
  dayShort(iso: string): string { return this.fmtMemo('c', iso, { weekday: 'short', day: 'numeric' }); }
  dayLong(iso: string): string { return this.fmtMemo('l', iso, { weekday: 'long', day: 'numeric', month: 'short' }); }
  /**
   * `[PGP.10]` **La fecha lleva año cuando NO es de este año.**
   *
   * ⛔ Antes formateaba siempre `{ día, mes }`, y en una lista de deuda eso borra la diferencia
   * entre una factura que vence el mes que viene y una de hace dos años. Medido el 2026-10-24
   * contra prod: los **dos renglones que la pantalla pone primero** —los de más monto y más
   * vencidos— son «Nota cargo a proveedor» del **01/01/2025** por **$8 M y $6 M**, y se leían
   * «1 ene», igual que un vencimiento próximo. Son $14.0 M con forma de saldo de apertura o
   * préstamo a los socios, y Contabilidad todavía no dictaminó qué son.
   *
   * El año va en dos dígitos para no ensanchar la columna, que vive en un panel angosto.
   */
  shortDate(iso: string | null): string { return fechaCorta(iso, this.todayIso); }

  /** `[TP.21.2]` Un dia ya pasado. Solo ahi un libro vacio dice algo: hacia adelante no hay nada que registrar. */
  isPast(iso: string): boolean { return iso < this.todayIso; }

  shiftWeek(delta: number): void {
    this.armado.set(null);
    this.selectedDate.set(this.addDays(this.selectedDate(), delta * 7));
    this.reload();
  }
  goToday(): void { this.armado.set(null); this.selectedDate.set(this.todayIso); this.reload(); }

  openDay(date: string): void {
    if (date !== this.selectedDate()) this.armado.set(null);
    this.selectedDate.set(date);
    this.targetDate = date;
    void this.proponer();
    // El panel queda al lado de la lista; sólo en angosto (una columna) cae abajo y hace falta llevar
    // la vista hasta él. Sin animación: respeta movimiento reducido.
    setTimeout(() => {
      const el = this.payPanel?.nativeElement;
      if (el && el.getBoundingClientRect().top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start' });
    });
  }

  reload(): void {
    this.loadWeek();
    this.loadObligations();
    this.loadAtrasados();
  }

  /** Cada petición de semana lleva su número: dos clics rápidos no deben pintar la semana vieja. */
  private weekSeq = 0;
  loadWeek(): void {
    const seq = ++this.weekSeq;
    this.loadingWeek.set(true);
    this.weekError.set(null);
    this.http.get<PaymentCalendarWeek>(`${this.base}/weeks/${this.selectedDate()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (w) => {
        if (seq !== this.weekSeq) return;
        this.week.set(w);
        this.loadingWeek.set(false);
        if (!w.days.some((d) => d.date === this.selectedDate())) this.selectedDate.set(w.from);
        void this.proponer();
      },
      error: (e) => { if (seq !== this.weekSeq) return; this.loadingWeek.set(false); this.weekError.set(e?.error?.message || 'No se pudo cargar la semana de pagos.'); },
    });
  }

  /**
   * `[PGP.15]` **Silenciosa** = la lista que ya está a la vista se queda (atenuada por «Buscando…»)
   * mientras llega la nueva: buscar o agregar ya no vacía la lista ni la cambia por un esqueleto.
   * Cada petición lleva su número: escribir rápido no pinta un resultado viejo encima del nuevo.
   */
  loadObligations(opts: { silencioso?: boolean } = {}): void {
    const seq = ++this.obligSeq;
    if (!opts.silencioso || !this.obligations().length) this.loadingObligations.set(true);
    this.buscando.set(true);
    const termino = this.busqueda().trim();
    const p = new URLSearchParams();
    if (this.classificationFilter) p.set('classification', this.classificationFilter);
    if (termino) p.set('search', termino);
    if (this.onlyCritical) p.set('onlyCritical', 'true');
    // [PGP.50] El orden viaja siempre: el default del backend es `vencimiento` y aquí es `cercania`.
    p.set('orden', this.ordenSel);
    this.http.get<ObligationPage>(`${this.base}/obligations?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (seq !== this.obligSeq) return;
        this.obligations.set(r.rows); this.obligationsTotal.set(r.total);
        this.obligationsError.set(null);
        this.busquedaAplicada.set(termino);
        this.agregando.set(new Set());
        this.loadingObligations.set(false); this.buscando.set(false);
      },
      error: (e) => {
        if (seq !== this.obligSeq) return;
        this.loadingObligations.set(false); this.buscando.set(false);
        // [PGP.48] Era sólo un aviso que se iba solo; la lista quedaba vacía diciendo «Sin obligaciones con estos filtros».
        this.obligationsError.set(this.errMsg(e, 'No se pudieron leer las facturas por pagar.'));
      },
    });
  }
  /** `[PGP.15]` Busca mientras se escribe (300 ms después de la última tecla) y abre la lista. */
  alEscribir(v: string): void {
    this.busqueda.set(v ?? '');
    this.avisoAlta.set(null);
    if (this.busquedaTimer) clearTimeout(this.busquedaTimer);
    this.busquedaTimer = setTimeout(() => this.loadObligations({ silencioso: true }), 300);
  }
  /** Enter busca ya, sin esperar. */
  buscarYa(): void {
    if (this.busquedaTimer) clearTimeout(this.busquedaTimer);
    this.loadObligations({ silencioso: true });
  }

  /**
   * `[PGP.44]` **Tomar lo que el panel dice que conviene pagar.**
   *
   * ⛔ Visto en la pantalla viva el 2026-11-02: el panel afirmaba *«se ganan $479,287.84»* y
   * *«cierra hoy»* en cinco renglones, y **no había un solo camino para tomarlo**. Medido ese
   * día: cerraban 8 acreedores por $3,989,252.17 con $244,990.48 en juego, y el día tenía
   * armado **un** pago de $47,472 a un proveedor que no gana descuento. La pantalla decía qué
   * hacer y no dejaba hacerlo — es la ley 0 del estándar: *nada afirma lo que no es, y todo lo
   * que importa se puede alcanzar*.
   *
   * No se arma solo: **se lleva a donde se arma.** El buscador ya resuelve el resto —
   * `[PGP.15]` agrupa por proveedor y sucursal y agrega el grupo entero de un clic—, así que
   * esto es la regla Q.4 (del dato a su lugar de arreglo, con el filtro ya puesto) y no una
   * segunda forma de armar pagos, que sería otra interfaz para el mismo flujo.
   *
   * Se busca por CÓDIGO y no por nombre: el nombre de Kepler trae razones sociales que no
   * coinciden con el catálogo, y el código es el que agrupa.
   */
  tomarSugerido(r: PagoSugerido): void {
    const termino = (r.proveedor_code || r.proveedor_nombre || '').trim();
    if (!termino) return;
    // [PGP.66] Del panel de pronto pago al de agregar, ya filtrado por ese acreedor.
    this.panelPronto.set(false);
    this.panelAgregar.set(true);
    this.busqueda.set(termino);
    this.buscarYa();
    // El foco va al buscador: queda a la vista qué se filtró y se puede corregir de una tecla.
    // (La lista de la deuda ya está siempre abierta con el día — ver `verDeuda`.)
    setTimeout(() => document.getElementById('pg-buscar')?.focus(), 0);
  }
  /** Esc limpia la búsqueda (y si ya estaba vacía, no hace nada: no cierra nada por sorpresa). */
  limpiarBusqueda(ev: Event): void {
    if (!this.busqueda()) return;
    ev.preventDefault();
    this.busqueda.set('');
    this.buscarYa();
  }
  /** `[PGP.15]` Atajo `/`: lleva al buscador desde cualquier parte, salvo que se esté escribiendo en otro campo. */
  @HostListener('document:keydown', ['$event'])
  atajoBuscador(ev: KeyboardEvent): void {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || this.isReleased()) return;
    const t = ev.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, [contenteditable="true"], .p-dialog')) return;
    ev.preventDefault();
    this.abrirAgregar();
  }
  private enfocarBuscador(): void {
    setTimeout(() => {
      const el = document.getElementById('pg-buscar') as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  }
  /**
   * `[PGP.15]` Los proveedores (y sucursal: un pago cada uno) de la búsqueda a la vista. Sólo con
   * búsqueda: sin ella, la lista es la deuda entera por vencimiento y agrupar 1,000 renglones no
   * ayuda a decidir.
   */
  readonly gruposBusqueda = computed<ObligationGroup<Obligation>[]>(() => {
    const termino = this.busquedaAplicada();
    const filas = this.obligacionesProgramables();
    return termino ? agruparObligaciones(filas) : [];
  });

  // ── Ayudantes de la franja de la semana ────────────────────────────────
  usedPct(d: PaymentCalendarWeekDay): number {
    const cap = Number(d.summary.authorized_amount ?? 0);
    return cap > 0 ? Math.min(100, (Number(d.summary.assigned_amount) / cap) * 100) : 0;
  }
  dayUnprepared(d: PaymentCalendarWeekDay): number { return d.allocations.filter((a) => a.status === 'pending' && !isPrepared(a)).length; }
  /** `[PGP.14]` Un pago rebotado se ve desde la cola: el día decía «autorizado» y nada más. */
  dayFailed(d: PaymentCalendarWeekDay): number { return d.allocations.filter((a) => a.status === 'failed').length; }
  /**
   * `[PGP.15]` El importe de los pagos QUE SE CUENTAN, sumado de las mismas filas: «7 pagos ·
   * $X» tiene que ser un solo universo (el resumen del backend no suma los rebotados).
   */
  dayTotal(d: PaymentCalendarWeekDay): number { return d.allocations.reduce((s, a) => s + Number(a.amount_assigned || 0), 0); }
  dayAria(d: PaymentCalendarWeekDay): string {
    const s = d.summary;
    const libre = Number(s.remaining_amount ?? 0);
    const cap = !s.capacity_defined ? 'sin tope fijado'
      : libre < 0 ? `excede por ${this.money(-libre)} el tope de ${this.money(s.authorized_amount)}`
      : `libres ${this.money(libre)} del tope de ${this.money(s.authorized_amount)}`;
    return `${this.dayLong(d.date)}: ${cap}, ${this.pagos(d.allocations.length)}`;
  }
  /** `[PGP.14]` Plural real: «1 pago», «5 pagos». El «pago(s)» obliga a leer dos veces un número que ya se sabe. */
  pagos(n: number): string { return `${n} ${n === 1 ? 'pago' : 'pagos'}`; }
  dias(n: number): string { return `${n} ${n === 1 ? 'día' : 'días'}`; }
  facturas(n: number): string { return `${n} ${n === 1 ? 'factura' : 'facturas'}`; }
  /**
   * El tope del día en la tira de métricas compartida (`DESIGN.md` Q.1): comprometido, libre y tope.
   * El libre en negativo se pinta `bad`; lo demás no juzga.
   */
  capKpis(d: PaymentCalendarWeekDay): MetricStripItem[] {
    const s = d.summary;
    const libre = Number(s.remaining_amount ?? 0);
    // [PGP.49] «Libre -$950,840.35» se lee como algo que sobra: excedido, la cifra se nombraba «Excede».
    // [PGP.60] Y excedido ya NO va en la tira: el veredicto lo dice en su título y la semana en su día
    // (visto en captura el 2026-11-04: «$364,289.83» tres veces). Queda lo que el veredicto no dice: el %.
    const items: MetricStripItem[] = [
      { label: 'Comprometido', value: Number(s.assigned_amount ?? 0), format: 'currency2', sub: `${this.usedPctRound(d)} % del tope` },
    ];
    if (libre >= 0) items.push({ label: 'Libre', value: libre, format: 'currency2', tone: 'default' });
    items.push({ label: 'Tope del día', value: Number(s.authorized_amount ?? 0), format: 'currency2' });
    return items;
  }
  prepared(a: PaymentCalendarAllocation): boolean { return isPrepared(a); }
  /** $1.95M · $197K · $3,465 — la franja necesita cifras cortas; el detalle va completo. */
  moneyShort(n: number | string | null | undefined): string {
    const v = Number(n || 0), abs = Math.abs(v);
    if (abs >= 1e6) return `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })}M`;
    if (abs >= 1e4) return `$${(v / 1e3).toLocaleString('es-MX', { maximumFractionDigits: 1 })}K`;
    return this.money(v);
  }

  classLabel(c: string): string { return CLASSIFICATION_LABEL[c] || c; }
  /**
   * `[PGP.11]` La sucursal se NOMBRA. Decía `Suc. 00` / `Suc. 08`, y «08» no le dice a nadie que
   * es Morelia Abastos (regla del PM, 2026-10-22). Resuelve con `warehouseName()` de
   * `libs/contracts` —el MISMO resolvedor que usan Compras, Almacén y Comercial— para que las
   * cuatro pantallas digan lo mismo; un código que no conoce lo devuelve tal cual, nunca en blanco
   * ni adivinado.
   *
   * ⚠️ **Declarado, no corregido acá:** para `00` el resolvedor contesta «CEDIS» y el CEDIS real
   * vive en Wincaja (`BPIRAPUATO`) — `sucursal='00'` de Kepler es **Oficinas**
   * (`docs/ERP_KEPLER.md` §2.3). Arreglarlo es partir la entrada de `WAREHOUSE_DISPLAY_ORDER`, y
   * eso le cambia el comportamiento a `/compras/pedido`, que busca ese grupo por su `label`.
   * Va aparte: un rediseño de pantalla no renombra centros de costo de toda la suite.
   */
  branchLabel(b: string | null | undefined): string { return b ? (warehouseName(b) || b) : 'Sin sucursal'; }
  /**
   * `[PGP.12]` **Cómo se nombra un documento cuando hace falta decirlo entero** (títulos, aria).
   *
   * ⛔ El folio solo **no identifica**: medido contra prod el 2026-10-26, **769 de los 2,897**
   * documentos que esta pantalla muestra (26.5 %) comparten folio con otro, y hay hasta **cinco**
   * con el mismo número. Buscar `0000304` devuelve la nota de $8,000,000 de ACREEDOR ARTURO LOPEZ
   * OROZCO **y** una de $45,343.77 de MEGA ALIMENTOS. Ni sucursal + folio alcanza (214 docs).
   *
   * Por eso acá se dice todo lo que se tiene: sucursal, folio, referencia y código del acreedor.
   * Lo que falte **se omite**, no se rellena.
   */
  docLabel(o: Obligation): string {
    return [this.branchLabel(o.branch_code), o.concept, o.doc_ref, o.payee_code].filter(Boolean).join(' · ');
  }
  lotLabel(s: string): string { return LOT_LABEL[s] || s; }
  /**
   * `[PGP.15]` **El estado del pago, en palabra.** Era una etiqueta de color por estado (azul
   * pendiente, verde pagado, rojo falló, gris cancelado): cuatro tonos para lo que la palabra ya
   * dice. Sólo el rebote conserva el rojo, porque es lo único que pide hacer algo.
   * [PGP.14] Un nombre por estado: «Marcado pagado» es lo que Caja General MARCA, no lo que el banco confirma.
   */
  estadoTexto(a: PaymentCalendarAllocation): string {
    if (a.status === 'failed') return `Rebotó: ${a.failure_reason || 'sin motivo registrado'}`;
    if (a.status === 'executed') return 'Marcado pagado';
    if (a.status === 'cancelled') return 'Cancelado';
    const falta = this.comoSale(a).falta;
    // `[PGP.75]` Con el método en su historial, lo que falta es aplicarlo (y elegir de qué cuenta sale el día).
    if (falta === 'el método' && this.sugerencias().get(a.id)?.metodo) return 'Por aplicar';
    if (falta) return `Falta ${falta}`;
    return this.isReleased() ? 'Por pagar' : 'Listo';
  }
  estadoIcono(a: PaymentCalendarAllocation): string {
    if (a.status === 'failed') return 'pi-times-circle';
    if (a.status === 'executed') return 'pi-check-circle';
    if (a.status === 'cancelled') return 'pi-ban';
    if (this.comoSale(a).falta) return 'pi-exclamation-circle';
    return this.isReleased() ? 'pi-clock' : 'pi-check';
  }
  methodLabel(m: string): string { return METHOD_LABEL[m] || m; }
  /** `[PGP.15]` Un solo formateador: `toLocaleString` con opciones crea uno nuevo en cada llamada, y esto se llama por renglón y por ciclo. */
  money(n: number | string | null | undefined): string { return PESOS.format(Number(n || 0)); }
  /**
   * `[PGP.7]` La tasa observada, en %. Llega como fracción (`0.0741` = 7.41 %) y los `numeric`
   * de Postgres viajan como **string** por JSON, así que `Number()` antes de formatear.
   */
  pct(n: number | string | null | undefined): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'percent', maximumFractionDigits: 2 });
  }
  /**
   * `[PGP.14]` El nombre del pago, sin sufijos que no se explican. Era «GAMAHUBIN SA DE CV +3»:
   * el «+3» eran 3 FACTURAS más del mismo proveedor, y se leía como «3 proveedores más». Las
   * facturas se cuentan en la línea de documentos; aquí sólo se suma si el pago junta a otro
   * beneficiario, y entonces se dice con palabras.
   */
  allocationTitle(a: PaymentCalendarAllocation): string {
    const first = a.items[0]?.beneficiary ?? '—';
    const otros = new Set(a.items.map((i) => i.beneficiary)).size - 1;
    return otros > 0 ? `${first} y ${otros} más` : first;
  }
  /**
   * `[PGP.14]` **Cómo sale el pago, en una línea, y qué le falta** — con la MISMA regla que
   * `isPrepared()`: método; cuenta de origen si no es efectivo; destino sólo si es transferencia.
   * Reemplaza tres controles de formulario por fila que no cabían (se encimaban al tener datos) y que,
   * si el guardado fallaba, se quedaban mostrando un valor que no se guardó.
   */
  /**
   * `[PGP.40]` **Este pago no se puede pagar: TODAS sus facturas están saldadas en el ERP.**
   *
   * Visto en la pantalla viva el 2026-10-31: un renglón decía a la vez *«El ERP ya no debe esta
   * factura ($43,120.83): no se puede pagar»* y *«Falta el método»*, con su botón «Preparar».
   * Se le pedía a Tesorería que preparara un pago que el servidor va a rechazar — trabajo
   * inútil pedido por la propia pantalla (DESIGN §10 poka-yoke: prevenir, no reportar).
   *
   * ⛔ Parcial NO es lo mismo: si 3 de 4 facturas están saldadas, el pago **sí se puede hacer**
   * por el resto. Ahí el aviso sigue, y el método también se pide.
   */
  noSePuedePagar(a: PaymentCalendarAllocation): boolean {
    const n = a.items?.length ?? 0;
    return n > 0 && (a.kepler_saldadas ?? 0) >= n;
  }

  comoSale(a: PaymentCalendarAllocation): { texto: string; falta: string | null } {
    // `[PGP.40]` Si no se puede pagar, no se pide nada: lo que falta es sacarlo del día.
    if (this.noSePuedePagar(a)) return { texto: '', falta: null };
    if (!a.payment_method) return { texto: '', falta: 'el método' };
    const m = this.methodLabel(a.payment_method);
    if (a.payment_method === 'efectivo') return { texto: `${m} · ${a.cash_register_text || 'Caja'}`, falta: null };
    const origen = a.bank_account_label || null;
    const destino = a.payment_method === 'cheque'
      ? (a.reference_text ? `cheque ${a.reference_text}` : 'cheque sin folio')
      : (a.destination_account_text || null);
    const texto = [m, origen].filter(Boolean).join(' · ') + (destino ? ` → ${destino}` : '');
    if (!a.bank_account_id) return { texto, falta: 'la cuenta de origen' };
    if (a.payment_method === 'transferencia' && !(a.destination_account_text ?? '').trim()) return { texto, falta: 'la cuenta destino' };
    return { texto, falta: null };
  }
  /**
   * `[PGP.14]` Lo que decide en la deuda no es la fecha suelta sino **cuánto lleva vencida**. Antes:
   * «14 ene» sin año junto a «1 ene 25» con un año de dos dígitos que se leía como día, todo en rojo.
   */
  /**
   * `[PGP.16]` **Lo que cuesta pagar antes de tiempo** — pedido de Edgar el 2026-10-26: *«hay que
   * hacer los pagos lo más cercano a la fecha de vencimiento»*.
   *
   * El dinero que sale antes de su vencimiento es dinero que deja de estar en la cuenta sin que
   * nadie lo haya decidido. Medido contra prod ese día (Oficinas, 90 días, 8,835 aplicaciones
   * casadas por `kdxf` contra el vencimiento de su factura):
   *
   * | cuándo sale | del monto |
   * |---|---|
   * | antes del vencimiento | **17.9 %** · $29,714,126 · 6 días antes en promedio |
   * | el día del vencimiento | 10.3 % |
   * | después | 71.8 % (la mediana es **1 día después**) |
   *
   * Adelantar esos $29.7 M cuesta ≈ **$73,704 por trimestre** al 12 % anual.
   *
   * ⛔ **No bloquea nada.** La propuesta ya toma sólo lo vencido o que vence ese día; esto es para
   * lo que alguien agrega **a mano** desde el cajón. Y tiene una excepción medida: si la factura
   * pierde su descuento por pronto pago antes del vencimiento, **adelantarla conviene** — por eso
   * el aviso se calla cuando el descuento supera el costo de adelantar.
   *
   * ⚠️ **La tasa es un SUPUESTO declarado, no una medición.** 12 % anual es el costo de oportunidad
   * que se usa para comparar, no el costo real del dinero de Mega Dulces: ése lo fija Dirección y
   * cuando exista como dato, esta constante se reemplaza.
   */
  private readonly TASA_ANUAL = 0.12;
  adelantoDe(o: Obligation): string | null {
    const v = vencimiento(o);
    if (!v) return null;
    const dias = Math.round((Date.parse(v.slice(0, 10) + 'T12:00:00Z') - Date.parse(this.todayIso + 'T12:00:00Z')) / 86400000);
    if (dias <= 0) return null; // ya venció o vence hoy: pagarla no adelanta nada
    const costo = Number(o.available_amount || 0) * this.TASA_ANUAL * (dias / 365);
    // ⛔ Si el pronto pago gana más de lo que cuesta adelantar, adelantar es lo correcto y este
    // aviso sobra: dos consejos opuestos en el mismo renglón no informan, paralizan.
    const gana = Number(o.pronto_beneficio || 0);
    if (gana > costo && (o.pronto_estado === 'por_vencer' || o.pronto_estado === 'capturable')) return null;
    return `se adelanta ${dias} día(s): cuesta ${this.money(costo)} de financiamiento`;
  }

  venceTxt(o: Obligation): string {
    const v = (this.vence(o) ?? '').slice(0, 10);
    if (!v) return 'sin vencimiento';
    const dias = Math.round((Date.parse(this.todayIso) - Date.parse(v)) / 86400000);
    if (dias > 0) return dias >= 60 ? `vencida hace ${Math.round(dias / 30)} meses` : `vencida hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
    if (dias === 0) return 'vence hoy';
    return `vence en ${-dias} ${dias === -1 ? 'día' : 'días'}`;
  }
  /** `[PGP.14]` Lo que no se puede programar, plegado y con su total: visible, pero sin ocupar lo primero que se ve. */
  readonly verRevision = signal(false);
  readonly revisionTotal = computed(() => this.obligacionesEnRevision().reduce((s, o) => s + Number(o.available_amount ?? 0), 0));
  /** Las sucursales de un pago, UNA vez cada una y por nombre (no un chip por factura). */
  itemsBranches(a: PaymentCalendarAllocation): string {
    return [...new Set(a.items.map((i) => this.branchLabel(i.branch_code)))].join(', ');
  }
  /**
   * `[PGP.15]` El resumen de los documentos de un pago: el folio si es uno, «N facturas» si son
   * varios. Era «4 facturas · 0009700 · 0009794 · …» cortado con «…»: medido, 2 de 7 pagos de un
   * día escondían folios. Ahora el detalle completo está en el desglose del pago (la flecha).
   */
  itemsResumen(a: PaymentCalendarAllocation): string {
    return a.items.length > 1 ? this.facturas(a.items.length) : (a.items[0]?.concept ?? '');
  }

  /**
   * `[TP.16.4]` El único camino para poner facturas en un día. Regla de Francisco: mismo proveedor
   * + misma sucursal = UN pago (una transferencia, un centro de costo). Si ese día ya hay un pago
   * pendiente y sin autorizar de ese proveedor y sucursal, las facturas SE SUMAN a ese pago; si no,
   * nace uno nuevo. Todas las facturas de una llamada comparten llave (un grupo de la lista).
   * El backend vuelve a validar beneficiario y sucursal (`paymentGroupKey`).
   */
  /**
   * `[PGP.15]` Devuelve también el id del pago que CREÓ (null si sumó a uno existente): el orden
   * automático toca sólo ése. Medido: agregar una factura reordenó 5 pagos que otra persona había
   * dejado sin orden en el mismo día.
   */
  private async assign(date: string, pick: { o: Obligation; amount: number }[], notes?: string): Promise<{ how: string; nuevo: string | null }> {
    if (!pick.length) return { how: 'nada que agregar', nuevo: null };
    const k = obligationKey(pick[0].o);
    // [PGP.15] Un día fuera de la semana a la vista se lee del servidor: sin eso, agregar al martes de la
    // semana que viene creaba un pago nuevo aunque ese día ya tuviera uno de este proveedor y sucursal.
    const day = this.week()?.days.find((d) => d.date === date);
    let pagosDelDia = day?.allocations ?? [];
    let estado = day?.summary.lot_status ?? null;
    if (!day) {
      const [rows, s] = await Promise.all([
        firstValueFrom(this.http.get<PaymentCalendarAllocation[]>(`${this.base}/days/${date}/allocations`)),
        firstValueFrom(this.http.get<PaymentCalendarDaySummary>(`${this.base}/days/${date}/summary`)),
      ]);
      pagosDelDia = rows;
      estado = s.lot_status;
    }
    const open = !this.diaCerrado(estado)
      ? pagosDelDia.find((a) => a.status === 'pending' && a.folio == null && allocationKey(a) === k)
      : undefined;
    if (open) {
      // Una por una (no hay endpoint de varias en una transacción): si falla una a la mitad, se
      // dice cuántas SÍ entraron, en vez de un «Error» que hace creer que no entró ninguna.
      let done = 0;
      for (const p of pick) {
        try {
          await firstValueFrom(this.http.post(`${this.base}/allocations/${open.id}/items`, { obligation_source: p.o.obligation_source, obligation_id: p.o.obligation_id, applied_amount: p.amount }));
          done++;
        } catch (e) {
          throw new Error(`${done} de ${pick.length} factura(s) se sumaron al pago de ${pick[0].o.beneficiary}; la de ${p.o.concept} no: ${this.errMsg(e, 'error')}`);
        }
      }
      return { how: `se ${pick.length === 1 ? 'sumó 1 factura' : `sumaron ${pick.length} facturas`} al pago de ${pick[0].o.beneficiary} · ${this.branchLabel(pick[0].o.branch_code)}`, nuevo: null };
    }
    const creado = await firstValueFrom(this.http.post<{ id?: string } | null>(`${this.base}/allocations`, {
      date, notes, items: pick.map((p) => ({ obligation_source: p.o.obligation_source, obligation_id: p.o.obligation_id, applied_amount: p.amount })),
    }));
    const n = pick.length;
    return { how: `pago nuevo de ${pick[0].o.beneficiary} · ${this.branchLabel(pick[0].o.branch_code)}${n > 1 ? ` con ${n} facturas` : ''}`, nuevo: creado?.id ?? null };
  }

  /**
   * `[PGP.15]` **El orden de pago se pone solo.** Era un paso con su botón («Proponer orden») que
   * había que apretar cada vez que entraba un pago, aunque el sistema ya sabía proponerlo. Ahora:
   * si en el día ningún pendiente tiene orden, se propone el orden completo (compromisos → críticos
   * → lo más vencido); si ya hay un orden —que Tesorería pudo ajustar a mano—, lo nuevo se forma
   * AL FINAL y no se reordena nada. Si falla, el veredicto ofrece «Proponer orden»: declarado, no
   * escondido.
   */
  private async ordenarNuevos(date: string, ids: readonly string[]): Promise<void> {
    // ⛔ [PGP.15] SÓLO los pagos que esta acción creó. La primera versión ordenaba todo lo que estuviera
    // sin orden en el día, y eso incluía pagos que otra persona acababa de agregar.
    if (!ids.length) return;
    try {
      const rows = await firstValueFrom(this.http.get<PaymentCalendarAllocation[]>(`${this.base}/days/${date}/allocations`));
      const pend = rows.filter((a) => a.status === 'pending');
      const mios = pend.filter((a) => a.priority_rank == null && ids.includes(a.id));
      if (!mios.length) return;
      const ordenados = pend.filter((a) => a.priority_rank != null);
      const ajenosSinOrden = pend.filter((a) => a.priority_rank == null && !ids.includes(a.id));
      // Día recién armado (nada ordenado y nada ajeno pendiente): la propuesta completa del backend.
      if (!ordenados.length && !ajenosSinOrden.length) {
        await firstValueFrom(this.http.post(`${this.base}/days/${date}/proponer-orden`, {}));
        return;
      }
      let max = Math.max(0, ...ordenados.map((a) => a.priority_rank ?? 0));
      for (const a of mios) await firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/orden`, { priority_rank: ++max }));
    } catch {
      /* el veredicto dirá «faltan N por ordenar» con su botón */
    }
  }

  // ── La propuesta del día (TP.16.4 · [PGP.15] automática) ─────────────────────
  readonly armado = signal<ArmadoGrupo<Obligation>[] | null>(null);
  readonly armadoOn = signal<ReadonlySet<string>>(new Set());
  readonly armadoChosen = computed(() => (this.armado() ?? []).filter((g) => this.armadoOn().has(g.key)));
  readonly armadoTotal = computed(() => this.armadoChosen().reduce((s, g) => s + g.total, 0));
  readonly armadoCaben = computed(() => (this.armado() ?? []).filter((g) => g.fits));
  readonly armadoFuera = computed(() => (this.armado() ?? []).filter((g) => !g.fits));
  readonly armadoFueraTotal = computed(() => this.armadoFuera().reduce((s, g) => s + g.total, 0));
  /** `[PGP.42]` El día no tiene tope: se propone, pero «cabe» no se puede afirmar. */
  readonly armadoSinTope = signal(false);
  readonly verFuera = signal(false);
  readonly armadoCargando = signal(false);
  readonly armadoError = signal<string | null>(null);
  /** Si la deuda leída para proponer vino topada, se DICE sobre cuántas se propuso (ADR-056). */
  readonly armadoUniverso = signal<string | null>(null);
  /**
   * Toda la deuda, leída UNA vez por visita y reusada para cada día. Medido el 2026-10-26: 2,858
   * facturas, 2.3 MB y 931 ms. ⚠️ Deuda declarada: el backend debería proponer el día (o mandar sólo
   * las columnas que el armado usa); mientras tanto, se lee una vez y se invalida tras cada escritura.
   */
  private deudaCompleta: Obligation[] | null = null;
  private invalidarDeuda(): void { this.deudaCompleta = null; }
  /**
   * `[PGP.15]` **La propuesta ya está hecha al entrar a un día vacío.** Antes había que apretar
   * «Sugerir armado» para ver algo que el sistema ya sabía calcular.
   *
   * ⛔ Y ahora EXCLUYE lo que no se puede programar (`enRevision`): la propuesta anterior no lo
   * hacía y, como ordena por antigüedad, metía primero justo las facturas de sucursal anteriores al
   * corte del 1-oct — las que pueden estar pagadas desde Oficinas. Medido el 2026-10-26 sobre el
   * día de hoy: **55 facturas «por confirmar» en 2 de los 46 pagos propuestos**.
   *
   * Arma con la lista COMPLETA, no con la filtrada en pantalla: con un filtro o una búsqueda puesta,
   * el armado dejaba fuera facturas vencidas sin avisar (revisión independiente).
   */
  async proponer(): Promise<void> {
    const day = this.selectedDay();
    this.armadoError.set(null);
    // `[PGP.42]` ⛔ Antes acá había `!day.summary.capacity_defined`, y era una CONTRADICCIÓN con
    // lo que la propia pantalla dice: «Presupuestos no fijó el tope de este día. **Se pueden
    // armar pagos**, pero el día no se autoriza». Se podían armar a mano; el sistema no
    // proponía nada. Medido el 2026-10-31: **2 de los 7 días de la semana** estaban sin tope, y
    // en esos el panel salía vacío aunque hubiera descuento venciendo ese mismo día.
    if (!day || this.allocations().length || this.isReleased() || day.date < this.todayIso) {
      this.armado.set(null);
      return;
    }
    const fecha = day.date;
    try {
      if (!this.deudaCompleta) {
        this.armadoCargando.set(true);
        // [TP.17.2] Techo alto a proposito: con la primera pagina propondria sobre las 1,000 mas viejas.
        const page = await firstValueFrom(this.http.get<ObligationPage>(`${this.base}/obligations?limit=5000`));
        this.deudaCompleta = page.rows;
        this.armadoUniverso.set(page.total > page.rows.length
          ? `Ojo: se propuso sobre ${page.rows.length.toLocaleString('es-MX')} de ${page.total.toLocaleString('es-MX')} facturas.` : null);
      }
      if (this.selectedDate() !== fecha) return; // se cambió de día mientras se leía
      const programables = this.deudaCompleta.filter((o) => !this.enRevision(o));
      /**
       * `[PGP.42]` Sin tope no se puede decir qué CABE, así que no se dibuja un «cabe» que
       * nadie midió (ADR-056). Se propone igual —que es lo que faltaba— y se declara.
       *
       * ⛔ Y no se auto-marca nada: marcar por omisión contra un presupuesto que Presupuestos
       * todavía no fijó sería elegir cuánto gastar en su lugar. La propuesta se ve; tildarla
       * es de quien paga.
       */
      const conTope = !!day.summary.capacity_defined;
      const room = conTope ? Number(day.summary.remaining_amount ?? 0) : Number.POSITIVE_INFINITY;
      const groups = sugerirArmado(programables, fecha, room);
      this.armado.set(groups);
      this.armadoSinTope.set(!conTope);
      this.armadoOn.set(conTope ? new Set(groups.filter((g) => g.fits).map((g) => g.key)) : new Set());
    } catch (e) {
      this.armado.set(null);
      this.armadoError.set(this.errMsg(e, 'No se pudo leer la deuda para proponer el día.'));
    } finally {
      this.armadoCargando.set(false);
    }
  }
  vence(o: Obligation): string | null { return vencimiento(o); }
  toggleArmado(key: string): void {
    const next = new Set(this.armadoOn());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.armadoOn.set(next);
  }
  async applyArmado(): Promise<void> {
    const day = this.selectedDay();
    const chosen = this.armadoChosen();
    if (!day || !chosen.length) return;
    this.saving.set(true);
    let ok = 0;
    const fails: string[] = [];
    const creados: string[] = [];
    // Uno por uno y releyendo la semana entre grupos: si el día ya tenía un pago de ese proveedor y
    // sucursal, `assign` lo encuentra y SUMA; el siguiente grupo ve el estado nuevo.
    for (const g of chosen) {
      try {
        const r = await this.assign(day.date, g.items.map((o) => ({ o, amount: Number(o.available_amount) })));
        if (r.nuevo) creados.push(r.nuevo);
        ok++;
      } catch (e) { fails.push(`${g.beneficiary} · ${this.branchLabel(g.branch)}: ${this.errMsg(e, 'error')}`); }
      await this.refreshWeek();
    }
    if (ok) await this.ordenarNuevos(day.date, creados);
    this.saving.set(false);
    this.armado.set(null);
    this.invalidarDeuda();
    this.reload();
    if (ok) this.toast.add({ severity: 'success', summary: 'Propuesta guardada', detail: `${this.pagos(ok)} en el ${this.dayLong(day.date)}, ya en orden de pago.` });
    if (fails.length) this.toast.add({ severity: 'error', summary: `${fails.length} no se guardaron`, detail: fails.join(' · '), life: 10000 });
  }
  /** Relee la semana y espera la respuesta (para encadenar asignaciones con el estado real). */
  private async refreshWeek(): Promise<void> {
    try { this.week.set(await firstValueFrom(this.http.get<PaymentCalendarWeek>(`${this.base}/weeks/${this.selectedDate()}`))); } catch { /* la recarga normal lo declara */ }
  }

  // ── Preparar ───────────────────────────────────────────────────────────
  bulkMethod: string | null = null;
  bulkOriginId: string | null = null;
  /**
   * `[PGP.11]` **La acción del veredicto.** Cada rama reusa el camino que ya existía —no hay un
   * segundo modo de ordenar ni de preparar—; lo que agrega es que la acción esté donde se lee el
   * bloqueo, y no al final de cada fila de la tabla.
   */
  runVerdict(kind: VerdictActionKind): void {
    switch (kind) {
      case 'armar': void this.applyArmado(); break;
      case 'proponer': this.invalidarDeuda(); void this.proponer(); break;
      case 'ordenar': this.suggestOrder(); break;
      case 'autorizar': this.releaseLot(); break;
      case 'pagar': this.abrirPagar(null); break;
      case 'cerrar': this.closeLot(); break;
      case 'rebote': { const f = this.allocations().find((a) => a.status === 'failed'); if (f) this.openReprogram(f); break; }
      case 'mover': this.openMoverTodos(); break;
      case 'saldadas': this.saldadasVisible.set(true); break;
      case 'exceso': { const p = this.propuestaExceso(); if (p) this.abrirMover(p.pagos, { destinos: p.destinos ?? undefined, motivo: 'presupuesto_recortado' }); break; }
    }
  }

  /**
   * `[PGP.13]` **Ordenar con TECLADO, no sólo arrastrando.** Era un campo numérico suelto: quien
   * no usa mouse no podía ordenar, y el orden decide el turno en que Caja General dispersa.
   * Mueve el pago una posición y reescribe los turnos de los dos que se cruzan.
   */
  /**
   * `[PGP.76]` **Reordenar sin pasos.** Antes eran flechas ↑↓ escondidas que movían de a un lugar,
   * y cada clic eran tres escrituras y una recarga de la semana: llevar el pago 20 al turno 1 eran
   * 19 clics y ~19 recargas (234 `POST …/orden` en 30 días, 71 con error, medido el 2026-11-05).
   * Ahora se ARRASTRA la fila por su asa, o con el foco en el asa: ↑ ↓ de a uno, Inicio y Fin al
   * principio o al final. La lista cambia al instante y se guarda completa en una sola escritura
   * (`POST days/:date/orden`), 0.6 s después del último movimiento: diez flechazos son un guardado.
   */
  readonly ordenAviso = signal('');
  private ordenTimer: ReturnType<typeof setTimeout> | null = null;
  private ordenCola: Promise<unknown> = Promise.resolve();

  turno(a: PaymentCalendarAllocation): number { return this.pendientesEnOrden().indexOf(a.id) + 1; }

  /** PrimeNG ya reacomodó el arreglo que pinta: de ahí sale el orden nuevo. */
  alSoltar(e: { dropIndex?: number }): void {
    const lista = this.allocations();
    const movido = e.dropIndex != null ? lista[e.dropIndex]?.id ?? null : null;
    this.fijarOrden(lista.filter((a) => a.status === 'pending').map((a) => a.id), movido, false);
  }

  teclaOrden(ev: KeyboardEvent, a: PaymentCalendarAllocation): void {
    const ids = this.pendientesEnOrden();
    const i = ids.indexOf(a.id);
    const j = ev.key === 'ArrowUp' ? i - 1 : ev.key === 'ArrowDown' ? i + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? ids.length - 1 : null;
    if (i < 0 || j == null) return;
    ev.preventDefault();
    if (j < 0 || j >= ids.length || j === i) return;
    this.fijarOrden(moverEnOrden(ids, i, j), a.id, true);
  }

  private fijarOrden(ids: string[], movido: string | null, enfocar: boolean): void {
    const date = this.selectedDate();
    this.ordenLocal.set({ date, ids });
    const a = movido ? this.allocations().find((x) => x.id === movido) : null;
    if (a) this.ordenAviso.set(`${this.allocationTitle(a)}: turno ${ids.indexOf(a.id) + 1} de ${ids.length}`);
    // La fila se vuelve a pintar en su lugar nuevo: el foco la sigue para la siguiente flecha.
    if (enfocar && movido) setTimeout(() => (document.querySelector(`[data-ord="${movido}"]`) as HTMLElement | null)?.focus());
    if (this.ordenTimer) clearTimeout(this.ordenTimer);
    this.ordenTimer = setTimeout(() => this.guardarOrden(date), 600);
  }

  private guardarOrden(date: string): void {
    this.ordenTimer = null;
    const o = this.ordenLocal();
    if (!o || o.date !== date) return;
    const ids = [...o.ids];
    this.ordenCola = this.ordenCola.then(async () => {
      try {
        await firstValueFrom(this.http.post(`${this.base}/days/${date}/orden`, { ids }));
        const pos = new Map(ids.map((id, i) => [id, i + 1]));
        const llave = (x: PaymentCalendarAllocation, k: number) => pos.get(x.id) ?? ids.length + 1 + k;
        this.week.update((w) => w && ({ ...w, days: w.days.map((d) => d.date !== date ? d : {
          ...d,
          allocations: d.allocations.map((x, k) => ({ x, k })).sort((p, q) => llave(p.x, p.k) - llave(q.x, q.k))
            .map(({ x }) => (pos.has(x.id) ? { ...x, priority_rank: pos.get(x.id) ?? x.priority_rank } : x)),
        }) }));
        // Si mientras tanto se movió otra vez, ese orden más nuevo se queda y se guarda en su turno.
        if (this.ordenLocal() === o) this.ordenLocal.set(null);
      } catch (e) {
        this.ordenLocal.set(null);
        this.toast.add({ severity: 'error', summary: 'No se guardó el orden', detail: this.errMsg(e, 'No se pudo guardar el orden.'), life: 8000 });
        this.loadWeek();
      }
    });
  }

  /** El proveedor del catálogo detrás de un pago (sólo facturas de mercancía lo traen). */
  private proveedorDe(a: PaymentCalendarAllocation): string | null {
    return a.classification === 'proveedor_mercancia' ? a.items.find((i) => i.supplier_id)?.supplier_id ?? null : null;
  }

  /**
   * `[PGP.30]` El hábito de pago de este acreedor, si se conoce.
   *
   * ⛔ Devuelve `null` en silencio cuando la carga falló: lo que NO se hace es tratar «no pudimos
   * leer el hábito» como «no tiene hábito». La diferencia la cuenta `habitosError`, y la pantalla
   * la dice en vez de precargar nada.
   */
  habitoDe(a: PaymentCalendarAllocation): SupplierPaymentHabit | null {
    const id = this.proveedorDe(a);
    return id ? this.habitos().get(id) ?? null : null;
  }

  /**
   * `[PGP.75]` **Lo que el historial propone para cada pago sin preparar**: el método de su hábito
   * (`metodo_estado = estable`, PGP.30) y la CLABE de sus propios comprobantes (sólo si es UNA, con
   * dígito de control válido). La cuenta de ORIGEN no: es la decisión del día de Tesorería y se elige
   * una vez en la barra. Medido el 2026-11-04 sobre 76 pagos pendientes: método en 55, CLABE en 48.
   */
  readonly sugerencias = computed<ReadonlyMap<string, { metodo: string | null; destino: string | null; texto: string; porque: string }>>(() => {
    const out = new Map<string, { metodo: string | null; destino: string | null; texto: string; porque: string }>();
    const habitos = this.habitos();
    for (const a of this.allocations()) {
      if (a.status !== 'pending' || isPrepared(a)) continue;
      const sid = this.proveedorDe(a);
      const h = sid ? habitos.get(sid) : undefined;
      if (!h) continue;
      const metodo = h.metodo_estado === 'estable' ? h.metodo_sugerido : null;
      const usaDestino = (metodo ?? 'transferencia') === 'transferencia' || metodo === 'cargo_automatico';
      const destino = usaDestino && h.clabe_estado === 'unica' && h.clabe_sugerida
        ? `${(h.clabe_banco ?? '').trim() ? (h.clabe_banco ?? '').trim() + ' · ' : ''}CLABE ${h.clabe_sugerida}` : null;
      if (!metodo && !destino) continue;
      const partes = [metodo ? this.methodLabel(metodo) : null, destino && h.clabe_sugerida ? `→ ${(h.clabe_banco ?? '').trim() || 'CLABE'} ··${h.clabe_sugerida.slice(-4)}` : null].filter(Boolean);
      const porque = [
        metodo ? `Método: así se le pagó ${h.metodo_veces} de ${h.metodo_de} veces` : null,
        destino ? `CLABE: la de sus ${h.clabe_comprobantes} comprobantes de pago${h.clabe_ultima_vez ? `, el último del ${h.clabe_ultima_vez}` : ''}` : null,
        h.clabe_estado === 'varias' ? `Sus comprobantes traen ${h.clabes_distintas} CLABEs distintas: elígela en «Preparar»` : null,
      ].filter(Boolean).join('. ');
      out.set(a.id, { metodo, destino, texto: `Sugerido: ${partes.join(' ')}`, porque });
    }
    return out;
  });
  /** `[PGP.75]` En una línea, cuánto trae el historial y qué queda por decidir. */
  readonly resumenSugerencias = computed(() => {
    const pend = this.allocations().filter((a) => a.status === 'pending' && !isPrepared(a)).length;
    const s = [...this.sugerencias().values()];
    const conMetodo = s.filter((x) => x.metodo).length;
    const conClabe = s.filter((x) => x.destino).length;
    if (!pend) return '';
    if (!conMetodo) return 'Ningún proveedor trae método en su historial: elige el método.';
    const sin = pend - conMetodo;
    return `El historial trae el método de ${conMetodo} de ${pend} y la CLABE de ${conClabe}.` + (sin ? ` Los otros ${sin} se quedan sin preparar: elige un método para ellos o usa «Preparar».` : '');
  });
  /** `[PGP.75]` Con método elegido, como antes; sin él, basta que el historial cubra a alguno. Siempre con origen (salvo efectivo). */
  puedeAplicar(): boolean {
    const m = this.bulkMethod;
    if (m === 'efectivo') return true;
    if (!this.bulkOriginId) return false;
    return !!m || [...this.sugerencias().values()].some((x) => x.metodo);
  }

  /** El hábito del pago que tiene abierto el diálogo — para explicar por qué NO se precargó nada. */
  prepHabito(): SupplierPaymentHabit | null {
    return this.prepAllocation ? this.habitoDe(this.prepAllocation) : null;
  }
  /** La cuenta favorita del catálogo del proveedor; `'error'` si no se pudo leer (no es lo mismo que «no tiene»). */
  private async favoritaDe(supplierId: string): Promise<string | null | 'error'> {
    try {
      const rows = await firstValueFrom(this.http.get<PaymentAccount[]>(`${this.accountsBase}/by-supplier/${supplierId}`));
      return rows.find((r) => r.es_favorita)?.id ?? null;
    } catch {
      return 'error';
    }
  }
  /**
   * `[PGP.13]` Método y cuenta de origen a TODOS los pendientes de una sola vez.
   *
   * `[PGP.15]` **Y el destino lo pone el sistema**: la cuenta favorita del catálogo de cada
   * proveedor, que pasa por aprobación de Gerencia y que el diálogo de un pago ya proponía sola.
   * Antes, para 7 transferencias había que abrir 7 diálogos sólo para aceptar una cuenta que el
   * sistema ya conocía. Lo que no tiene favorita se dice por nombre, no se adivina: aplicar un
   * destino en lote sin catálogo es justo como se paga a la cuenta equivocada.
   */
  /*
   * ⛔ `[PGP.49]` Sólo a los que NO están preparados. Tomaba todos los pendientes, así que «Aplicar a
   * los 31» pisaba también los 5 que alguien ya había preparado uno por uno (un cheque se volvía
   * transferencia). Lo ya preparado se cambia en su fila, con «Cambiar».
   */
  async aplicarATodos(): Promise<void> {
    if (!this.puedeAplicar() || this.saving()) return;
    const elegido = this.bulkMethod;
    const sugerencias = this.sugerencias();
    // `[PGP.75]` Sin método elegido, cada pago lleva el de su historial; el que no tiene historial se queda.
    const todas = this.allocations().filter((a) => a.status === 'pending' && !isPrepared(a));
    const filas = elegido ? todas : todas.filter((a) => sugerencias.get(a.id)?.metodo);
    const sinHistorial = todas.length - filas.length;
    if (!filas.length) return;
    this.saving.set(true);
    const favs = new Map<string, string | null | 'error'>();
    let ok = 0, conFavorita = 0, conHistorial = 0;
    const sinDestino: string[] = [], sinCatalogo: string[] = [], fallas: string[] = [];
    for (const a of filas) {
      const sg = sugerencias.get(a.id);
      const m = elegido ?? sg!.metodo!;
      const usaDestino = m === 'transferencia' || m === 'cargo_automatico';
      const cambio: Record<string, unknown> = { payment_method: m, bank_account_id: m === 'efectivo' ? null : this.bulkOriginId };
      const tieneDestino = !!a.supplier_payment_account_id || !!(a.destination_account_text ?? '').trim();
      let puso = false, catalogoCaido = false, pusoHistorial = false;
      if (usaDestino && !tieneDestino) {
        const sid = this.proveedorDe(a);
        if (sid) {
          if (!favs.has(sid)) favs.set(sid, await this.favoritaDe(sid));
          const fav = favs.get(sid);
          if (fav === 'error') catalogoCaido = true;
          else if (fav) { cambio['supplier_payment_account_id'] = fav; puso = true; }
        }
        // `[PGP.75]` Sin favorita aprobada, la CLABE de sus comprobantes. Al guardarse queda pedida de
        // alta en el catálogo (PGP.46), para que la apruebe Compras/Dirección.
        if (!puso && sg?.destino) { cambio['destination_account_text'] = sg.destino; pusoHistorial = true; }
      }
      try {
        await firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/preparar`, this.cuerpoPreparar(a, cambio)));
        ok++;
        if (puso) conFavorita++;
        if (pusoHistorial) conHistorial++;
        if (usaDestino && !tieneDestino && !puso && !pusoHistorial) (catalogoCaido ? sinCatalogo : sinDestino).push(this.allocationTitle(a));
      } catch (e) {
        fallas.push(`${this.allocationTitle(a)}: ${this.errMsg(e, 'error')}`);
      }
    }
    this.saving.set(false);
    this.recordarPreparacion();
    this.loadWeek();
    const detalle = [conFavorita ? `${conFavorita} con la cuenta favorita de su proveedor` : null,
      conHistorial ? `${conHistorial} con la CLABE de sus comprobantes (queda pedida de alta)` : null,
      sinHistorial ? `${sinHistorial} sin historial se quedaron sin preparar` : null].filter(Boolean).join(' · ');
    if (ok) this.toast.add({ severity: 'success', summary: `${ok} de ${this.pagos(filas.length)} preparados`, detail: detalle || undefined });
    if (sinDestino.length) this.toast.add({ severity: 'warn', summary: `${sinDestino.length} sin cuenta destino`, detail: `${sinDestino.join(', ')}: su proveedor no tiene cuenta favorita en el catálogo ni CLABE en sus comprobantes. Captúrala con «Preparar».`, life: 10000 });
    if (sinCatalogo.length) this.toast.add({ severity: 'warn', summary: 'No se pudo leer el catálogo de cuentas', detail: `${sinCatalogo.join(', ')}: elige su destino con «Preparar».`, life: 10000 });
    if (fallas.length) this.toast.add({ severity: 'error', summary: `${fallas.length} no se prepararon`, detail: fallas.join(' · '), life: 10000 });
  }
  /** `[PGP.15]` Recuerda el último método y origen elegidos (por navegador; si no hay almacenamiento, sólo no se recuerda). */
  private recordarPreparacion(): void {
    try { localStorage.setItem(PREF_PREPARAR, JSON.stringify({ m: this.bulkMethod, o: this.bulkOriginId })); } catch { /* sin almacenamiento */ }
  }
  private recuperarPreparacion(): void {
    try {
      const v = JSON.parse(localStorage.getItem(PREF_PREPARAR) || 'null') as { m?: string | null; o?: string | null } | null;
      // `[PGP.75]` Sólo el ORIGEN se recuerda: un método recordado le ganaría al historial de cada
      // proveedor sin que nadie lo eligiera hoy.
      if (v && !this.bulkOriginId) { this.bulkOriginId = v.o ?? null; }
    } catch { /* sin almacenamiento o valor viejo: se elige de nuevo */ }
  }
  /**
   * El cuerpo que espera `/preparar`, con la MISMA regla que `confirmPrepare()`: el destino sólo
   * viaja en transferencia o cargo automático. Si no, la cuenta favorita del proveedor —que se
   * propone sola— acabaría impresa como destino de un pago en efectivo.
   */
  private cuerpoPreparar(a: PaymentCalendarAllocation, cambio: Partial<Record<string, unknown>>): Record<string, unknown> {
    const base = {
      payment_method: a.payment_method, bank_account_id: a.bank_account_id,
      destination_account_text: a.destination_account_text,
      supplier_payment_account_id: a.supplier_payment_account_id,
      reference_text: a.reference_text, cash_register_text: a.cash_register_text,
      ...cambio,
    } as Record<string, unknown>;
    const m = base['payment_method'];
    const usaOrigen = m !== 'efectivo';
    const usaDestino = m === 'transferencia' || m === 'cargo_automatico';
    return {
      payment_method: m,
      bank_account_id: usaOrigen ? base['bank_account_id'] || undefined : undefined,
      destination_account_text: usaDestino && !base['supplier_payment_account_id'] ? base['destination_account_text'] || undefined : undefined,
      supplier_payment_account_id: usaDestino ? base['supplier_payment_account_id'] || undefined : undefined,
      reference_text: m === 'cheque' ? base['reference_text'] || undefined : undefined,
      cash_register_text: m === 'efectivo' ? base['cash_register_text'] || undefined : undefined,
    };
  }
  private errMsg(e: unknown, fallback: string): string {
    const m = (e as { error?: { message?: string | string[] } })?.error?.message;
    return (Array.isArray(m) ? m.join(' ') : m) || (e instanceof Error && !('error' in e) ? e.message : '') || fallback;
  }

  // ── Agregar ─────────────────────────────────────────────────────────────
  /**
   * `[PGP.15]` **Un clic agrega la factura completa al día abierto.** Era un diálogo que repetía
   * el día (el que ya estaba abierto) y el importe (el disponible completo). Lo raro —otro importe,
   * otro día— va en el segundo botón de la fila (`quickAddDialog`).
   */
  quickAdd(o: Obligation): Promise<void> { return this.agregarFacturas([o]); }
  /** `[PGP.15]` Las N facturas de un proveedor y sucursal, en un clic (un solo pago). */
  agregarGrupo(g: ObligationGroup<Obligation>): Promise<void> { return this.agregarFacturas(g.items); }
  /** Cuánto se pasaría de lo libre del día abierto con este importe; null si cabe o si el día no tiene tope. */
  excedeTope(importe: number): number | null {
    const s = this.selectedDay()?.summary;
    if (!s?.capacity_defined) return null;
    const exceso = this.numero(importe) - this.numero(s.remaining_amount);
    return exceso > 0.005 ? exceso : null;
  }
  grupoAgregado(g: ObligationGroup<Obligation>): boolean { const s = this.agregando(); return g.items.every((o) => s.has(o.obligation_id)); }

  /** Lo que se está agregando o ya se agregó y la lista todavía no refresca: no se agrega dos veces. */
  readonly agregando = signal<ReadonlySet<string>>(new Set());
  /** La confirmación EN EL LUGAR donde se agregó (antes: un aviso arriba a la derecha que se llevaba el foco). */
  readonly avisoAlta = signal<string | null>(null);
  /**
   * `[PGP.15]` **El carril que más se usa**: agregar facturas completas al día abierto. Lo que
   * cambió, medido en la pantalla viva: la factura se marca ✓ en el momento (el «+» quedaba activo
   * mientras recargaba y se podía agregar dos veces); la lista NO se vacía (se refresca en silencio);
   * la confirmación aparece junto al buscador; y el foco regresa al buscador con su texto
   * seleccionado, listo para el siguiente proveedor (antes se iba al botón de cerrar del aviso).
   */
  private async agregarFacturas(items: Obligation[]): Promise<void> {
    if (!items.length || this.saving()) return;
    const fecha = this.selectedDate();
    const ids = items.map((o) => o.obligation_id);
    this.saving.set(true);
    this.avisoAlta.set(null);
    this.agregando.set(new Set([...this.agregando(), ...ids]));
    try {
      const r = await this.assign(fecha, items.map((o) => ({ o, amount: Number(o.available_amount) })));
      await this.ordenarNuevos(fecha, r.nuevo ? [r.nuevo] : []);
      this.avisoAlta.set(`${this.dayLong(fecha)}: ${r.how}.`);
    } catch (e) {
      const sin = new Set(this.agregando());
      ids.forEach((id) => sin.delete(id));
      this.agregando.set(sin);
      this.toast.add({ severity: 'error', summary: 'No se agregó', detail: this.errMsg(e, 'No se pudo asignar.') });
    } finally {
      this.saving.set(false);
      this.invalidarDeuda();
      this.loadWeek();
      this.loadObligations({ silencioso: true });
      this.enfocarBuscador();
    }
  }
  quickAddDialog(o: Obligation): void {
    this.quickAddTarget.set(o);
    this.quickAddAmount = Number(o.available_amount);
    this.quickAddVisible = true;
    this.elegirDiaDestino(this.selectedDate() < this.todayIso ? this.todayIso : this.selectedDate());
  }
  /**
   * `[PGP.15]` **El día destino puede ser cualquiera**, y su tope se lee de `days/:date/summary` (sólo
   * lectura): lo que cabe se dice ANTES de agregar, no después en el veredicto de otro día.
   */
  readonly destino = signal<PaymentCalendarDaySummary | null>(null);
  readonly destinoCargando = signal(false);
  readonly destinoError = signal<string | null>(null);
  private destinoSeq = 0;
  elegirDiaDestino(fecha: string): void {
    this.targetDate = fecha;
    this.destino.set(null);
    this.destinoError.set(null);
    if (!fecha) return;
    const seq = ++this.destinoSeq;
    this.destinoCargando.set(true);
    this.http.get<PaymentCalendarDaySummary>(`${this.base}/days/${fecha}/summary`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { if (seq !== this.destinoSeq) return; this.destino.set(s); this.destinoCargando.set(false); },
      error: (e) => { if (seq !== this.destinoSeq) return; this.destinoCargando.set(false); this.destinoError.set(this.errMsg(e, 'error del servidor')); },
    });
  }
  /** Un día autorizado, en dispersión o cerrado ya no recibe pagos. */
  diaCerrado(estado: string | null | undefined): boolean { return ['released', 'executing', 'closed'].includes(estado ?? ''); }
  /** Los `numeric` de Postgres viajan como texto: se convierten antes de comparar o restar. */
  /** `[PGP.48]` Y lo tecleado puede traer separador de miles o signo de pesos («1,250.00», «$1250»): se normaliza la forma. */
  numero(v: number | string | null | undefined): number { return Number(typeof v === 'string' ? v.replace(/[\s,$]/g, '') : v) || 0; }
  importeQuick(): number { return this.numero(this.quickAddAmount); }
  /** Lo que quedaría libre del tope del día destino con este importe (negativo = se excede). */
  quedaDestino(): number { return this.numero(this.destino()?.remaining_amount) - this.importeQuick(); }
  /** Prevenir antes que reportar (ESTANDAR §4.5): sin día, sin importe válido o con el día ya autorizado, no se agrega. */
  quickAddValido(): boolean {
    const o = this.quickAddTarget();
    const imp = this.importeQuick();
    return !!o && !!this.targetDate && this.targetDate >= this.todayIso && imp > 0
      && imp <= this.numero(o.available_amount) + 0.005 && !this.destinoCargando() && !this.diaCerrado(this.destino()?.lot_status) && !this.saving();
  }
  async confirmQuickAdd(): Promise<void> {
    const o = this.quickAddTarget();
    if (!o || !this.quickAddValido()) return;
    const fecha = this.targetDate;
    this.saving.set(true);
    try {
      const r = await this.assign(fecha, [{ o, amount: this.importeQuick() }]);
      await this.ordenarNuevos(fecha, r.nuevo ? [r.nuevo] : []);
      this.quickAddVisible = false;
      this.toast.add({ severity: 'success', summary: 'Agregada', detail: `${this.dayLong(fecha)}: ${r.how}.` });
    } catch (e) {
      this.toast.add({ severity: 'error', summary: 'No se agregó', detail: this.errMsg(e, 'No se pudo asignar.') });
    } finally { this.saving.set(false); this.invalidarDeuda(); this.reload(); }
  }

  // ── Preparar UN pago (origen + destino: lo que pide el layout) ─────────────
  openPrepare(a: PaymentCalendarAllocation): void {
    this.prepAllocation = a; this.prepMethod = a.payment_method; this.prepDestination = a.supplier_payment_account_id ? '' : (a.destination_account_text || '');
    this.prepReference = a.reference_text || ''; this.prepCash = a.cash_register_text || ''; this.prepAccountId = a.supplier_payment_account_id;
    // [PGP.30] Sin método todavía, manda el HÁBITO de este acreedor — gana al de «Para los N
    // pagos», que es genérico. Medido: J&F ENTERPRISE se paga con cheque 16 de 16 veces, así que
    // arrastrar el «transferencia» del lote le habría errado justo a él.
    this.habitoUsado.set(null);
    const h = this.habitoDe(a);
    if (!this.prepMethod && h?.metodo_sugerido) { this.prepMethod = h.metodo_sugerido; this.habitoUsado.set(h); }
    // [PGP.15] Y si ni el hábito sabe, el del lote (el último que se eligió a mano).
    if (!this.prepMethod && this.bulkMethod) this.prepMethod = this.bulkMethod;
    this.prepOriginId = a.bank_account_id ?? (this.prepMethod !== 'efectivo' ? this.bulkOriginId : null);
    if (!this.prepOriginId && this.prepMethod !== 'efectivo' && h?.cuenta_origen_id) {
      this.prepOriginId = h.cuenta_origen_id; this.habitoUsado.set(h);
    }
    this.prepAccounts.set([]);
    this.prepAccountsError.set(null);
    this.prepPedida.set(null);
    this.prepSupplierId = this.proveedorDe(a);
    // `[PGP.75]` La CLABE de sus comprobantes, si no hay nada puesto. Es lo ÚLTIMO en precedencia: la
    // cuenta aprobada del catálogo y la captura pendiente la reemplazan si llegan y nadie la tocó.
    const histDest = this.sugerencias().get(a.id)?.destino ?? null;
    this.prepDestHistorial = !this.prepDestination.trim() && !a.supplier_payment_account_id ? histDest : null;
    if (this.prepDestHistorial) this.prepDestination = this.prepDestHistorial;
    const intacto = () => !!this.prepDestHistorial && this.prepDestination === this.prepDestHistorial;
    if (this.prepSupplierId) {
      this.http.get<PaymentAccount[]>(`${this.accountsBase}/by-supplier/${this.prepSupplierId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => {
          // [PGP.90] La referencia fija se ve AL ELEGIR la cuenta: quien prepara sabe que va incluida.
          this.prepAccounts.set(rows.map((r) => ({ id: r.id, label: `${r.bank_name}${r.clabe ? ' · ' + r.clabe : ''}${r.payment_reference ? ' · Ref ' + r.payment_reference : ''}${r.alias ? ' (' + r.alias + ')' : ''}${r.es_favorita ? ' ★' : ''}` })));
          // La favorita se propone sola; el usuario puede cambiarla. [PGP.75] Gana sobre la CLABE del historial.
          const fav = rows.find((r) => r.es_favorita)?.id ?? null;
          if (!this.prepAccountId && fav && (!this.prepDestination || intacto())) { this.prepAccountId = fav; if (intacto()) { this.prepDestination = ''; this.prepDestHistorial = null; } }
        },
        error: (e) => { this.prepAccounts.set([]); this.prepAccountsError.set(e?.status === 403 ? 'sin permiso de Compras' : 'error del servidor'); },
      });
      /**
       * `[PGP.46]` Y la CLABE que alguien ya capturó para este proveedor y está esperando
       * aprobación. Va en paralelo al catálogo porque responde otra pregunta: el catálogo dice
       * «qué cuentas están aprobadas», esto dice «qué se capturó y todavía no».
       *
       * ⛔ Si falla, se calla y el diálogo queda como estaba (hay que teclearla). NO se muestra
       * un error: no poder proponer un atajo no es un problema del pago.
       */
      this.http.get<SolicitudCuenta[]>(`${this.accountsBase}/solicitudes`, {
        params: { supplier_id: this.prepSupplierId },
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => {
          const r = rows.find((x) => !!x.proposed_clabe);
          if (!r?.proposed_clabe) return;
          this.prepPedida.set({
            clabe: r.proposed_clabe, banco: r.proposed_bank_name ?? null,
            quien: r.requested_by ?? null, cuando: r.requested_at ? r.requested_at.slice(0, 10) : null,
          });
          // Se precarga SOLO si no hay nada elegido: nunca pisa lo que la persona ya puso ni una
          // cuenta del catálogo, que está aprobada y gana sobre una captura pendiente.
          if (!this.prepAccountId && (!this.prepDestination.trim() || intacto())) {
            this.prepDestination = `${r.proposed_bank_name && !r.proposed_bank_name.startsWith('(') ? r.proposed_bank_name + ' · CLABE ' : ''}${r.proposed_clabe}`;
            this.prepDestHistorial = null;
          }
        },
        error: () => this.prepPedida.set(null),
      });
    }
    this.prepareVisible = true;
  }
  confirmPrepare(): void {
    if (!this.prepAllocation || !this.prepMethod) { this.toast.add({ severity: 'warn', summary: 'Falta el método', detail: 'Elige cómo se paga.' }); return; }
    const usesOrigin = this.prepMethod !== 'efectivo';
    // El destino sólo viaja en transferencia / cargo: en efectivo o cheque la favorita del
    // proveedor (que se propone sola) no debe acabar impresa como destino para Caja General.
    const usesDest = this.prepMethod === 'transferencia' || this.prepMethod === 'cargo_automatico';
    this.saving.set(true);
    this.http.post(`${this.base}/allocations/${this.prepAllocation.id}/preparar`, {
      payment_method: this.prepMethod,
      bank_account_id: usesOrigin ? this.prepOriginId || undefined : undefined,
      destination_account_text: usesDest && !this.prepAccountId ? (this.prepDestination || undefined) : undefined,
      reference_text: this.prepMethod === 'cheque' ? this.prepReference || undefined : undefined,
      cash_register_text: this.prepMethod === 'efectivo' ? this.prepCash || undefined : undefined,
      supplier_payment_account_id: usesDest ? this.prepAccountId || undefined : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.prepareVisible = false; this.loadWeek(); this.toast.add({ severity: 'success', summary: 'Preparado', detail: 'Método y cuentas guardados.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo preparar.' }); },
    });
  }

  // ── Orden de pago ─────────────────────────────────────────────────────
  suggestOrder(): void {
    this.http.post(`${this.base}/days/${this.selectedDate()}/proponer-orden`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadWeek(); this.toast.add({ severity: 'success', summary: 'Orden propuesto', detail: 'Ajusta manualmente si hace falta antes de autorizar.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo proponer el orden.' }),
    });
  }

  // ── Reprogramar (con motivo — TP.10) ───────────────────────────────────
  openReprogram(a: PaymentCalendarAllocation): void {
    this.abrirMover([a]);
  }
  /**
   * `[PGP.50]` **Qué mover para que el día quepa en su tope, y a dónde.** El veredicto decía
   * «Mueve o quita pagos» sin botón; el 3-nov el día excedía por $950,840.35 con el miércoles en
   * $912.4K libres y el jueves en $671.6K. Regla, la misma que ya decide el turno de dispersión:
   * se mueven los ÚLTIMOS del orden de pago (el orden propuesto pone primero compromisos,
   * críticos y lo más vencido) hasta cubrir el exceso, y CADA UNO va al primer día siguiente de
   * la semana cargada que tenga tope y todavía le quepa. Repartir no es un adorno: medido el
   * 3-nov, el exceso ($950,840.35) era mayor que lo libre de CUALQUIER día (máx. $912,434.29 el
   * miércoles), así que mandarlos todos a un solo día lo dejaba excedido a él. Lo que el ERP ya no
   * debe NO se mueve: se quita.
   * ⛔ Sólo PROPONE: el diálogo enseña cuáles, a qué fecha cada uno, y nada sale sin el clic.
   */
  readonly propuestaExceso = computed<{ pagos: PaymentCalendarAllocation[]; total: number; destinos: ReadonlyMap<string, string> | null } | null>(() => {
    const day = this.selectedDay();
    const liberado = this.isReleased();
    if (!day || !day.summary.exceeded || liberado) return null;
    const exceso = -Number(day.summary.remaining_amount ?? 0);
    if (!(exceso > 0.005)) return null;
    const rango = (a: PaymentCalendarAllocation) => a.priority_rank ?? Number.MAX_SAFE_INTEGER;
    const candidatos = this.allocations()
      .filter((a) => a.status === 'pending' && !this.noSePuedePagar(a))
      .sort((a, b) => rango(b) - rango(a));
    const pagos: PaymentCalendarAllocation[] = [];
    let total = 0;
    for (const a of candidatos) {
      if (total >= exceso - 0.005) break;
      pagos.push(a);
      total += Number(a.amount_assigned || 0);
    }
    if (!pagos.length || total < exceso - 0.005) return null;
    // Lo libre de cada día siguiente, y se va gastando conforme se asigna.
    const dias = (this.week()?.days ?? [])
      .filter((d) => d.date > day.date && d.summary.capacity_defined && !this.diaCerrado(d.summary.lot_status))
      .map((d) => ({ date: d.date, libre: Number(d.summary.remaining_amount ?? 0) }));
    const destinos = new Map<string, string>();
    for (const a of pagos) {
      const imp = Number(a.amount_assigned || 0);
      const d = dias.find((x) => x.libre >= imp - 0.005);
      if (!d) return { pagos, total, destinos: null }; // no cabe todo en la semana: se elige la fecha a mano
      d.libre -= imp;
      destinos.set(a.id, d.date);
    }
    return { pagos, total, destinos };
  });
  /** Los días a los que va la propuesta, en orden y sin repetir («mié 4 y jue 5»). */
  diasDestino(destinos: ReadonlyMap<string, string>): string {
    const ds = [...new Set(destinos.values())].sort().map((d) => this.dayShort(d));
    return ds.length > 1 ? `${ds.slice(0, -1).join(', ')} y ${ds[ds.length - 1]}` : ds[0] ?? '';
  }
  /** `[PGP.48]` Los pendientes de un día que ya pasó, juntos: un diálogo, no uno por pago. */
  openMoverTodos(): void {
    // `[PGP.96]` Sólo lo que falta: mover un pago que Kepler ya pagó lo volvería a programar.
    this.abrirMover(this.pendientesSinPagar());
  }
  private abrirMover(pagos: PaymentCalendarAllocation[], opts: { destinos?: ReadonlyMap<string, string>; motivo?: ReprogramReason } = {}): void {
    if (!pagos.length) return;
    this.reprogramTodos = pagos;
    this.reprogramDestinos = opts.destinos ?? null;
    this.reprogramDate = this.siguienteHabil();
    // En un día que ya pasó el motivo ya se sabe; se propone y se puede cambiar.
    const pasado = this.diaPasado() && pagos.every((a) => a.status === 'pending');
    this.reprogramReason = opts.motivo ?? (pasado ? 'otro' : null);
    this.reprogramReasonDetail = !opts.motivo && pasado ? 'El día pasó sin pagarse' : '';
    this.reprogramVisible = true;
  }
  reprogramTotal(): number { return this.reprogramTodos.reduce((s, a) => s + Number(a.amount_assigned || 0), 0); }
  /** Prevenir antes que reportar: sin fecha (o en el pasado) o sin motivo, el botón no se ofrece. */
  /** `[PGP.50]` La fecha de cada pago cuando la propuesta los reparte en varios días; si es null, todos van a `reprogramDate`. */
  reprogramDestinos: ReadonlyMap<string, string> | null = null;
  fechaDeMover(a: PaymentCalendarAllocation): string { return this.reprogramDestinos?.get(a.id) ?? this.reprogramDate; }
  /**
   * `[PGP.73]` **Lo que cuesta mover un pago: el pronto pago que se deja pasar.** El diálogo decía
   * cuáles y a qué fecha, no esto. Medido en vivo el 2026-11-04: de los 18 que el veredicto proponía
   * mover, 3 traían «gana · cierra pronto» por $23,387.58 y nada lo avisaba. Con fecha: lo de las
   * facturas cuya ventana cierra ANTES de ese día. Sin fecha todavía: lo que está en juego y hasta
   * cuándo. Misma suma que `pronto_captura` del backend (capturable + por_vencer).
   */
  prontoAlMover(a: PaymentCalendarAllocation): ProntoAlMover | null {
    const fecha = this.fechaDeMover(a) || null;
    let monto = 0, cierra = '', capturado = 0, cierraEst = '', cierraCap = '';
    for (const it of a.items ?? []) {
      if (it.pronto_estado !== 'capturable' && it.pronto_estado !== 'por_vencer') continue;
      const lim = (it.pronto_fecha_limite ?? '').slice(0, 10);
      // `[PGP.91]` D3: el descuento CAPTURADO viaja con el pago (el servidor lo copia al mover), así que lo
      // que está en juego es ése, no el estimado — y se avisa, porque su ventana observada puede cerrarse.
      const cap = it.discount_reason === 'pronto_pago' ? this.numero(it.discount_amount) : 0;
      const b = cap > 0 ? cap : Number(it.pronto_beneficio || 0);
      if (!lim || !(b > 0)) continue;
      if (fecha && lim >= fecha) continue; // ese día la ventana sigue abierta
      monto += b;
      if (cap > 0) { capturado += cap; if (!cierraCap || lim < cierraCap) cierraCap = lim; }
      else if (!cierraEst || lim < cierraEst) cierraEst = lim;
      if (!cierra || lim < cierra) cierra = lim;
    }
    return monto > 0.005
      ? { monto: Math.round(monto * 100) / 100, cierra, deja: !!fecha, capturado: Math.round(capturado * 100) / 100, cierraEst, cierraCap }
      : null;
  }
  textoPronto(p: ProntoAlMover): string {
    // `[PGP.91]` Lo capturado no «se deja pasar» ni «se gana»: ya está en el pago y sale con él aunque la
    // ventana observada cierre. Se dice qué parte es cuál, para no afirmar una pérdida ni una ganancia.
    const estimado = round2(p.monto - p.capturado);
    if (!p.deja) {
      return [
        estimado > 0 ? `gana ${this.money(estimado)} si sale a más tardar el ${this.shortDate(p.cierraEst)}` : '',
        p.capturado > 0 ? `su descuento capturado de ${this.money(p.capturado)} viaja con el pago; si sale después del ${this.shortDate(p.cierraCap)}, confirma con el proveedor que lo respeta` : '',
      ].filter(Boolean).join('; ');
    }
    const partes = [
      estimado > 0 ? `deja pasar ${this.money(estimado)} de pronto pago` : '',
      p.capturado > 0 ? `su descuento capturado de ${this.money(p.capturado)} viaja con el pago` : '',
    ].filter(Boolean).join('; ');
    return `${partes} (su ventana cierra el ${this.shortDate(p.cierra)})${p.capturado > 0 ? ': confirma con el proveedor que lo respeta' : ''}`;
  }
  /**
   * `[PGP.91]` D3: lo ESTIMADO (lo que se deja pasar) y lo CAPTURADO (lo que viaja con el pago) van por
   * separado, cada uno con sus pagos: sumarlos decía «deja pasar» de un descuento que no se pierde.
   */
  prontoAlMoverTotal(): { estimado: number; capturado: number; nEst: number; nCap: number; nombresEst: string; nombresCap: string; deja: boolean } | null {
    // Con sus nombres: la lista va del último del orden al primero, y los que traen pronto pago pueden
    // quedar abajo del desplazamiento.
    const con = this.reprogramTodos.flatMap((a) => { const p = this.prontoAlMover(a); return p ? [{ a, p }] : []; });
    if (!con.length) return null;
    const nombres = (xs: typeof con) => xs.slice(0, 3).map((x) => this.allocationTitle(x.a)).join(', ') + (xs.length > 3 ? ` y ${xs.length - 3} más` : '');
    const est = con.filter((x) => round2(x.p.monto - x.p.capturado) > 0);
    const cap = con.filter((x) => x.p.capturado > 0);
    return {
      estimado: round2(est.reduce((s, x) => s + x.p.monto - x.p.capturado, 0)),
      capturado: round2(cap.reduce((s, x) => s + x.p.capturado, 0)),
      nEst: est.length, nCap: cap.length, nombresEst: nombres(est), nombresCap: nombres(cap),
      deja: con.every((x) => x.p.deja),
    };
  }
  /** `[PGP.73]` Con una sola fecha para todos: cómo queda ese día contra su tope (lo que no se ve, se dice). */
  destinoTope(): { texto: string; mal: boolean } | null {
    if (this.reprogramDestinos || !this.reprogramDate) return null;
    const d = this.week()?.days.find((x) => x.date === this.reprogramDate);
    if (!d) return { texto: 'Ese día no está en la semana a la vista: su tope no se mide aquí.', mal: false };
    if (!d.summary.capacity_defined) return { texto: 'Ese día no tiene tope fijado: no se podrá autorizar hasta que Presupuestos lo fije.', mal: true };
    const queda = Number(d.summary.remaining_amount ?? 0) - this.reprogramTotal();
    return queda >= -0.005
      ? { texto: `Caben: a ese día le quedan ${this.money(queda)} libres.`, mal: false }
      : { texto: `No caben: ese día queda excedido por ${this.money(-queda)}.`, mal: true };
  }
  reprogramValido(): boolean {
    const fechaOk = this.reprogramDestinos ? true : !!this.reprogramDate && this.reprogramDate >= this.todayIso;
    return this.reprogramTodos.length > 0 && fechaOk && !!this.reprogramReason
      && (this.reprogramReason !== 'otro' || !!this.reprogramReasonDetail.trim()) && !this.saving();
  }
  /**
   * Mueve uno o varios, uno por uno: si uno falla, los demás siguen y se dice cuáles sí y cuáles
   * no (DESIGN §10, fallos parciales). Lo movido se forma al final del orden del día destino.
   */
  async confirmReprogram(): Promise<void> {
    const pagos = this.reprogramTodos;
    if (!this.reprogramValido()) return;
    const motivo = this.reprogramReason;
    const detalle = this.reprogramReasonDetail.trim();
    this.saving.set(true);
    // [PGP.50] Cada pago a SU fecha (la propuesta del exceso los reparte); los nuevos se forman al
    // final del orden de cada día destino, día por día.
    const nuevosPorDia = new Map<string, string[]>();
    const fallas: string[] = [];
    for (const a of pagos) {
      const fecha = this.fechaDeMover(a);
      try {
        const movido = await firstValueFrom(this.http.post<{ id?: string } | null>(`${this.base}/allocations/${a.id}/reprogramar`, {
          date: fecha, reason: motivo, reason_detail: detalle || undefined,
        }));
        if (movido?.id) nuevosPorDia.set(fecha, [...(nuevosPorDia.get(fecha) ?? []), movido.id]);
      } catch (e) {
        fallas.push(`${this.allocationTitle(a)}: ${this.errMsg(e, 'error')}`);
      }
    }
    for (const [fecha, ids] of nuevosPorDia) await this.ordenarNuevos(fecha, ids);
    this.saving.set(false);
    this.invalidarDeuda();
    this.reload();
    const ok = pagos.length - fallas.length;
    const dondeTxt = this.diasDestino(new Map(pagos.map((a) => [a.id, this.fechaDeMover(a)])));
    if (!fallas.length) this.reprogramVisible = false;
    if (ok) this.toast.add({ severity: 'success', summary: 'Movido', detail: pagos.length === 1 ? `${this.allocationTitle(pagos[0])} pasó al ${this.dayLong(this.fechaDeMover(pagos[0]))}.` : `${ok} de ${this.pagos(pagos.length)} pasaron al ${dondeTxt}.` });
    if (fallas.length) this.toast.add({ severity: 'error', summary: `${fallas.length} no se movieron`, detail: fallas.join(' · '), life: 10000 });
  }

  /**
   * `[PGP.48]` **Quita del pago las facturas que el ERP ya no debe**, para poder pagar el resto.
   * El renglón decía «se puede pagar el resto» y no era cierto: `execute()` rechaza el pago entero
   * si una sola de sus facturas está saldada, y quitar una factura no tenía botón aunque el
   * endpoint (`DELETE allocations/:id/items/:itemId`) existía. Sólo en un día sin autorizar: en uno
   * autorizado cambiaría un importe que ya se firmó.
   */
  async quitarSaldadas(a: PaymentCalendarAllocation): Promise<void> {
    const saldadas = a.items.filter((it) => it.kepler_saldada);
    if (!saldadas.length || this.saving()) return;
    this.saving.set(true);
    let ok = 0;
    const fallas: string[] = [];
    for (const it of saldadas) {
      try { await firstValueFrom(this.http.delete(`${this.base}/allocations/${a.id}/items/${it.id}`)); ok++; }
      catch (e) { fallas.push(`${it.concept}: ${this.errMsg(e, 'error')}`); }
    }
    this.saving.set(false);
    this.invalidarDeuda();
    this.reload();
    if (ok) this.toast.add({ severity: 'success', summary: 'Facturas quitadas', detail: `${ok === 1 ? 'Se quitó 1 factura' : `Se quitaron ${ok} facturas`} del pago de ${this.allocationTitle(a)}. El resto ya se puede pagar.` });
    if (fallas.length) this.toast.add({ severity: 'error', summary: `${fallas.length} no se quitaron`, detail: fallas.join(' · '), life: 10000 });
  }
  /** El siguiente día hábil después del día abierto (o de hoy, si el abierto ya pasó). */
  private siguienteHabil(): string {
    let d = this.addDays(this.selectedDate() < this.todayIso ? this.todayIso : this.selectedDate(), 1);
    while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = this.addDays(d, 1);
    return d;
  }

  // ── Documentos imprimibles (TP.8) ───────────────────────────────────────
  private openPdf(url: string): void {
    this.printing.set(true);
    this.http.get(url, { responseType: 'blob' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.printing.set(false);
        const objUrl = URL.createObjectURL(blob);
        const win = window.open(objUrl, '_blank');
        if (!win) this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la ventana', detail: 'Permite las ventanas emergentes para ver el PDF.' });
        setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      },
      error: (e) => { this.printing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo generar el documento.' }); },
    });
  }
  printPreliminar(): void { this.openPdf(`${this.base}/days/${this.selectedDate()}/preliminar.pdf`); }
  /**
   * `[PGP.33]` La instrucción de ejecución. Se llamaba `printCajaGeneral` y el PDF se titulaba
   * «— Caja General» para TODO el lote; medido, el 87.3 % del dinero sale de banco y lo dispersa
   * Tesorería. Ahora cada renglón dice quién ejecuta y el papel firma a los que de verdad participan.
   */
  printEjecucion(): void { this.openPdf(`${this.base}/days/${this.selectedDate()}/ejecucion.pdf`); }

  // ── Caja General: pagar, rebote y cierre ([PGP.15]) ─────────────────────
  /**
   * `[PGP.15]` **Marcar los N pagados de una vez.** Eran N botones, uno por fila. Se marca uno por
   * uno contra el backend —que vuelve a validar que Kepler todavía deba cada factura— y un fallo
   * no detiene a los demás: se dice cuáles sí y cuáles no (DESIGN §10, fallos parciales).
   * `[PGP.70]` También marca UN pago, cuando el diálogo se abrió desde su fila (`pagarLista`).
   */
  async confirmPagar(): Promise<void> {
    const filas = this.pagarLista();
    if (!filas.length || this.saving()) return;
    this.saving.set(true);
    let ok = 0;
    const fallas: string[] = [];
    for (const a of filas) {
      try { await firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/ejecutar`, {})); ok++; }
      catch (e) { fallas.push(`${this.allocationTitle(a)}: ${this.errMsg(e, 'error')}`); }
    }
    this.saving.set(false);
    this.pagarVisible = false;
    this.reload();
    if (ok && filas.length === 1) this.toast.add({ severity: 'success', summary: 'Marcado pagado', detail: `${this.allocationTitle(filas[0])} · ${this.money(filas[0].amount_assigned)}.` });
    else if (ok) this.toast.add({ severity: 'success', summary: `${ok} de ${this.pagos(filas.length)} marcados pagados` });
    if (fallas.length) this.toast.add({ severity: 'error', summary: `${fallas.length} no se marcaron`, detail: fallas.join(' · '), life: 10000 });
  }
  openRebote(a: PaymentCalendarAllocation): void {
    this.reboteAllocation = a; this.reboteReason = null; this.reboteDetail = ''; this.reboteDate = this.siguienteHabil();
    this.reboteVisible = true;
  }
  /**
   * `[PGP.15]` **El rebote, en un paso: se marca y se mueve.** El backend ya tenía `fallo`, y la
   * pantalla no lo ofrecía: un pago que rebotaba no tenía cómo decirse. Ahora se marca (su saldo
   * regresa) y, si hay fecha, se mueve con su misma preparación y se forma al final del orden de
   * ese día. Si moverlo falla, queda marcado y se dice.
   */
  async confirmRebote(): Promise<void> {
    const a = this.reboteAllocation;
    const r = this.reboteReason;
    if (!a || !r) return;
    const detalle = this.reboteDetail.trim();
    const motivo = r === 'otro' ? detalle : (REPROGRAM_REASON_OPTS.find((o) => o.value === r)?.label ?? r);
    const fecha = this.reboteDate;
    this.saving.set(true);
    try {
      await firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/fallo`, { reason: motivo }));
    } catch (e) {
      this.saving.set(false);
      this.toast.add({ severity: 'error', summary: 'No se marcó el rebote', detail: this.errMsg(e, 'No se pudo marcar.') });
      return;
    }
    let movido = false;
    if (fecha) {
      try {
        const nuevo = await firstValueFrom(this.http.post<{ id?: string } | null>(`${this.base}/allocations/${a.id}/reprogramar`, { date: fecha, reason: r, reason_detail: r === 'otro' ? detalle : undefined }));
        await this.ordenarNuevos(fecha, nuevo?.id ? [nuevo.id] : []);
        movido = true;
      } catch (e) {
        this.toast.add({ severity: 'warn', summary: 'Quedó marcado que rebotó, pero no se movió', detail: this.errMsg(e, 'No se pudo mover.'), life: 10000 });
      }
    }
    this.saving.set(false);
    this.reboteVisible = false;
    this.invalidarDeuda();
    this.reload();
    if (movido) this.toast.add({ severity: 'success', summary: 'Rebotó y se movió', detail: `${this.allocationTitle(a)} pasó al ${this.dayLong(fecha)}.` });
    else if (!fecha) this.toast.add({ severity: 'info', summary: 'Marcado que rebotó', detail: `${this.allocationTitle(a)} queda en este día hasta que lo muevas.` });
  }
  /** `[PGP.70]` Quitar del día, ya confirmado; `saving` apaga la ✕ y el botón desde el primer clic. */
  confirmarQuitar(): void {
    const a = this.quitarObjetivo();
    if (!a || this.saving()) return;
    this.saving.set(true);
    this.http.post(`${this.base}/allocations/${a.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.quitarObjetivo.set(null); this.invalidarDeuda(); this.reload(); this.toast.add({ severity: 'info', summary: 'Quitado del día', detail: `${this.allocationTitle(a)} regresa a lo que se debe.` }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'No se quitó', detail: e?.error?.message || 'No se pudo quitar.' }); },
    });
  }

  releaseLot(): void {
    this.saving.set(true);
    this.http.post(`${this.base}/days/${this.selectedDate()}/liberar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.reload(); this.toast.add({ severity: 'success', summary: 'Autorizado', detail: 'El día quedó autorizado: ya se puede imprimir la instrucción de ejecución y dispersar.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo autorizar.' }); },
    });
  }
  /** `[PGP.15]` El último paso, que el backend tenía y la pantalla no: el día queda terminado. */
  closeLot(): void {
    this.saving.set(true);
    this.http.post(`${this.base}/days/${this.selectedDate()}/cerrar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.reload(); this.toast.add({ severity: 'success', summary: 'Día cerrado', detail: `${this.dayLong(this.selectedDate())} quedó terminado.` }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'No se cerró', detail: e?.error?.message || 'No se pudo cerrar el día.' }); },
    });
  }
}
