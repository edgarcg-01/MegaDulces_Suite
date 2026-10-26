import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, ViewChild, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import type {
  PaymentCalendarAllocation, PaymentCalendarWeek, PaymentCalendarWeekDay,
  PaymentObligationSource, PaymentOriginAccount,
} from '@megadulces/contracts';
import { warehouseName } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { agruparObligaciones, allocationKey, fechaCorta, filasAgrupadas, obligationKey, sugerirArmado, vencimiento, type ArmadoGrupo } from './calendario-pagos-grupos';
import { firstValueFrom } from 'rxjs';
import { PagosTabsComponent } from '../pagos-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';

/**
 * `[PGP.11]` La única acción que el veredicto ofrece: la que destraba el paso en el que el día
 * está parado. Es una unión cerrada a propósito — `runVerdict()` tiene que seguir siendo
 * exhaustiva, y agregar un paso sin su acción tiene que romper la compilación, no pasar de largo.
 */
type VerdictActionKind = 'armar' | 'ordenar' | 'preparar' | 'autorizar' | 'caja';
interface VerdictAction { kind: VerdictActionKind; label: string; icon: string }

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
interface PaymentAccount { id: string; bank_name: string; account_number: string | null; clabe: string | null; alias: string | null; es_favorita: boolean }
/**
 * `[TP.17.2]` La lista de obligaciones viaja con su TOTAL. El endpoint tiene un techo (1,000 por
 * omisión) y sin este dato la pantalla no puede distinguir «hay mil» de «te muestro mil de tres mil»
 * — que es la diferencia entre informar y mentir (ADR-056).
 */
interface ObligationPage { rows: Obligation[]; total: number; limit: number; offset: number }

const CLASSIFICATION_LABEL: Record<string, string> = {
  compromiso_financiero: 'Compromiso financiero', gasto: 'Gasto', proveedor_mercancia: 'Proveedor',
};
const STATUS_LABEL: Record<string, string> = { pending: 'Pendiente', executed: 'Ejecutado', failed: 'Falló', cancelled: 'Cancelado' };
const STATUS_SEVERITY: Record<string, 'success' | 'warn' | 'danger' | 'secondary' | 'info'> = {
  pending: 'info', executed: 'success', failed: 'danger', cancelled: 'secondary',
};
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
 * prepara, Gerencia/Dirección autoriza, Caja General dispersa.
 */
@Component({
  selector: 'app-finanzas-calendario-pagos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PagosTabsComponent, CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, TagModule, MessageModule, CheckboxModule, ToastModule, TooltipModule, LoadStateComponent, EntityInspectorComponent, ContextHelpComponent],
  providers: [MessageService],
  template: `
    <!-- [TP.20.3] Las cuatro pantallas de Pagos son un ciclo, no cuatro reportes sueltos. -->
    <app-pagos-tabs />
    <div class="surf-page in cal-page">
      <app-entity-inspector [(ref)]="inspect" />
      <p-toast></p-toast>
      <header class="surf-page-head cal-head">
        <div class="surf-page-head-text">
          <!-- [PGP.7] El «about» de que esta pantalla ya incluye todo el ciclo: desde que absorbio
               a Pronto pago es el unico lugar donde se hace un pago, y lo absorbido llegaba sin
               explicacion. La jerga va al diccionario versionado, no a un title (regla P). -->
          <!-- [PGP.13] La jerga sigue saliendo del DICCIONARIO VERSIONADO, no de texto a mano en
               la plantilla (regla P). El componente de ayuda abre un panel EN la pantalla -no es
               un title- que es justo lo que pedia la maqueta: la definicion alcanzable con teclado
               y con el dedo, y la misma en todas las pantallas que la citen. -->
          <h1>Pagos <app-context-help topic="calendario-de-pagos" /></h1>
          <p class="surf-page-sub">Elige el día en el riel, agrégale facturas desde la izquierda, y a la derecha ordénalo, prepáralo y autorízalo. Incluye el descuento por pronto pago de cada factura.</p>
        </div>
        <div class="cal-nav">
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="shiftWeek(-1)" aria-label="Semana anterior"><span class="pi pi-angle-left" aria-hidden="true"></span></button>
          <span class="cal-week-label" aria-live="polite">{{ weekLabel() }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="shiftWeek(1)" aria-label="Semana siguiente"><span class="pi pi-angle-right" aria-hidden="true"></span></button>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="goToday()">Esta semana</button>
          <!-- [RE.32] Lo que Compras entrega a Finanzas se confirma allá; Finanzas no ve el menú de Compras. -->
          <a pButton class="p-button-sm p-button-outlined" routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">
            <span class="p-button-icon p-button-icon-left pi pi-inbox" aria-hidden="true"></span><span class="p-button-label">Entregas de Compras</span>
          </a>
        </div>
      </header>

      <!-- [PGP.11] La franja contesta las CUATRO preguntas del DIA ELEGIDO, no las de la semana.
           Antes traia presupuesto/comprometido/disponible de la semana... y esas mismas tres
           cifras volvian a salir en la tarjeta del dia y otra vez en el panel derecho: once
           numeros para una sola idea (cuanto puedo pagar hoy). Cuando todo pesa igual, nada es
           primario (DESIGN.md Q.5). La semana baja a UNA linea bajo el riel: no se pierde, deja
           de competir. -->
      <div class="pg-shell">

        <!-- ── LA COLA: los dias por pagar ──────────────────────────────── -->
        <aside class="pg-queue" aria-label="Dias por pagar">
          <div class="pg-queue-h">
            <h2>Dias por pagar</h2>
            <span class="pg-queue-nav">
              <button pButton type="button" class="p-button-sm p-button-text pg-ico" (click)="shiftWeek(-1)" aria-label="Semana anterior"><span class="pi pi-angle-left" aria-hidden="true"></span></button>
              <button pButton type="button" class="p-button-sm p-button-text pg-ico" (click)="goToday()" aria-label="Esta semana"><span class="pi pi-circle-fill pg-today-dot" aria-hidden="true"></span></button>
              <button pButton type="button" class="p-button-sm p-button-text pg-ico" (click)="shiftWeek(1)" aria-label="Semana siguiente"><span class="pi pi-angle-right" aria-hidden="true"></span></button>
            </span>
          </div>
          <!-- [PGP.13] La leyenda de la columna. La cifra de la derecha SIEMPRE es lo libre del
               tope: antes era lo comprometido cuando habia pagos y lo libre cuando no, asi que el
               lunes ($496.0K comprometido) se leia como el dia mas apretado de la semana cuando en
               realidad era el que mas espacio tenia ($3.48M libres). Una columna, un significado. -->
          <div class="pg-queue-leg"><span>dia</span><span>libre del tope</span></div>

          <app-load-state [loading]="loadingWeek() && !week()" [error]="weekError()" [skeletonRows]="3" (retry)="loadWeek()">
            <div class="pg-days">
              @for (d of week()?.days ?? []; track d.date) {
                <button type="button" class="pg-day"
                        [class.is-sel]="d.date === selectedDate()" [class.is-nocap]="!d.summary.capacity_defined"
                        [attr.aria-current]="d.date === selectedDate() ? 'true' : null"
                        [attr.aria-label]="dayAria(d)" (click)="openDay(d.date)">
                  <span class="pg-day-t">
                    <span class="pg-day-n">{{ dayShort(d.date) }}@if (d.date === todayIso) { <span class="pg-t"> · hoy</span> }</span>
                    <span class="pg-day-amt comm-num" [class.cal-neg]="(d.summary.remaining_amount ?? 0) < 0">
                      @if (d.summary.capacity_defined) { {{ moneyShort(d.summary.remaining_amount) }} } @else { — }
                    </span>
                  </span>
                  <span class="pg-day-b">
                    @if (d.allocations.length) {
                      <i class="pg-dot is-work" aria-hidden="true"></i>
                      {{ d.allocations.length }} pago(s) · <span class="comm-num">{{ moneyShort(d.summary.assigned_amount) }}</span>
                      @if (dayUnprepared(d) > 0) { · <b class="cal-warn-txt">falta preparar {{ dayUnprepared(d) }}</b> }
                      @else if (d.summary.lot_status === 'released' || d.summary.lot_status === 'executing') { · <b class="cal-ok-txt">autorizado</b> }
                    } @else if (!d.summary.capacity_defined) {
                      <i class="pg-dot" aria-hidden="true"></i> sin tope fijado
                    } @else {
                      <i class="pg-dot is-free" aria-hidden="true"></i> sin pagos
                    }
                  </span>
                  <!-- [PGP.9] El testigo del ERP: el mismo hecho -que dinero salio ese dia- medido
                       por otro lado. Un cero SIN fecha de corte no se puede leer, asi que se
                       declara en vez de dibujarse (ADR-056). -->
                  @if (d.libro; as lb) {
                    @if (lb.n > 0) {
                      <span class="pg-day-erp">el ERP ya registra <span class="comm-num">{{ moneyShort(lb.monto) }}</span> · {{ lb.n }}</span>
                    } @else if (isPast(d.date) && !lb.data_as_of) {
                      <span class="pg-day-erp is-gap">el espejo del ERP no trae corte: sin medir</span>
                    }
                  }
                </button>
              }
            </div>
          </app-load-state>

          <div class="pg-queue-f">
            <span><b class="comm-num">{{ moneyShort(weekAvailable()) }}</b> libres del tope de <b class="comm-num">{{ moneyShort(weekBudget()) }}</b> esta semana</span>
            @if (weekNoCapDays() > 0) { <span class="cal-warn-txt">{{ weekNoCapDays() }} dia(s) sin tope fijado</span> }
            @if (weekUnprepared() > 0) { <span class="cal-warn-txt"><b>{{ weekUnprepared() }}</b> pagos sin preparar en {{ weekDaysWithWork() }} dia(s)</span> }
          </div>
        </aside>

        <!-- ── EL LOTE ABIERTO ─────────────────────────────────────────── -->
        <main class="pg-lot">
          @if (selectedDay(); as day) {

            <!-- EL VEREDICTO: identidad, estado, que falta, la accion y el tope. UN bloque. -->
            <div class="pg-vd" role="status" aria-live="polite"
                 [class.is-ok]="verdict().tone === 'ok'" [class.is-warn]="verdict().tone === 'warn'" [class.is-bad]="verdict().tone === 'bad'">
              <div class="pg-vd-id">
                <h2>{{ dayLong(day.date) }}@if (day.date === todayIso) { · hoy }</h2>
                @if (day.summary.lot_status) { <span class="pg-pill">{{ lotLabel(day.summary.lot_status) }}</span> }
                <span class="cal-muted pg-vd-sub">@if (day.lot_folio) { folio {{ day.lot_folio }} } @else { sin folio }</span>
              </div>
              <div class="pg-vd-main">
                <div class="pg-vd-txt">
                  <p class="pg-vd-say">{{ verdict().say }}</p>
                  <!-- [PGP.13] El veredicto NOMBRA el renglon y dice que pasa despues. Antes decia
                       «falta 1 por preparar» sin decir cual, y su boton abria un paso ya abierto:
                       el numero denunciaba y no llevaba a arreglarlo (DESIGN Q.3 y Q.4). -->
                  @if (verdict().why) { <p class="pg-vd-why" [innerText]="verdict().why!"></p> }
                </div>
                @if (verdict().action; as act) {
                  <button pButton type="button" class="p-button-sm pg-vd-cta" [disabled]="saving()" (click)="runVerdict(act.kind)">
                    <span class="pi" [ngClass]="act.icon" aria-hidden="true"></span>&nbsp;{{ act.label }}
                  </button>
                }
              </div>
              <div class="pg-cap">
                @if (day.summary.capacity_defined) {
                  <span class="pg-cap-say"><b class="comm-num">{{ money(day.summary.assigned_amount) }}</b> comprometido</span>
                  <span class="pg-cap-bar" role="img" [attr.aria-label]="usedPctRound(day) + ' por ciento del tope del dia comprometido'">
                    <span class="pg-cap-fill" [class.is-over]="day.summary.exceeded" [style.width.%]="usedPct(day)"></span>
                  </span>
                  <span class="pg-cap-say"><b class="comm-num" [class.cal-neg]="(day.summary.remaining_amount ?? 0) < 0">{{ money(day.summary.remaining_amount) }}</b> libres del tope de <b class="comm-num">{{ money(day.summary.authorized_amount) }}</b></span>
                } @else {
                  <span class="pg-cap-say cal-warn-txt">Presupuestos no fijo el tope de este dia: se pueden armar pagos, pero el dia no se autoriza.</span>
                }
              </div>
            </div>

            <div class="pg-steps">

              <!-- ① ARMAR ─────────────────────────────────────────────── -->
              <section class="pg-step" [class.is-done]="pendingCount() > 0" [class.is-open]="stepOpen(1)">
                <button type="button" class="pg-step-h" [attr.aria-expanded]="stepOpen(1)" aria-controls="pg-b1" (click)="toggleStep(1)">
                  <span class="pg-sn" aria-hidden="true">@if (pendingCount() > 0) { <i class="pi pi-check"></i> } @else { 1 }</span>
                  <span class="pg-step-t">
                    <span class="pg-step-name">Armar el dia</span><span class="pg-step-who">Tesoreria</span>
                    <span class="pg-step-say">{{ saysPaso1() }}</span>
                  </span>
                  <span class="pi pi-angle-right pg-chev" aria-hidden="true"></span>
                </button>
                <div class="pg-step-body" id="pg-b1">
                  <p class="pg-why">La propuesta toma lo vencido o que vence este dia, <b>un pago por proveedor y sucursal</b>, lo mas viejo primero, hasta donde alcance el tope. Lo que vence despues se queda en la lista.</p>

                  @if (armado(); as arm) {
                    <div class="pg-prop" role="region" aria-label="Armado sugerido">
                      @for (g of arm; track g.key; let i = $index) {
                        <label class="pg-prop-row" [class.is-off]="!g.fits">
                          <p-checkbox [binary]="true" [ngModel]="armadoOn().has(g.key)" (onChange)="toggleArmado(g.key)" [disabled]="!g.fits" [ariaLabel]="'Incluir ' + g.beneficiary + ' ' + branchLabel(g.branch)" />
                          <span class="pg-prop-main">
                            <span class="cal-benef">{{ g.beneficiary }}</span>
                            <span class="pg-sub"><span class="cal-suc">{{ branchLabel(g.branch) }}</span> {{ g.items.length }} factura(s) · la mas vieja vencio el {{ shortDate(g.oldest) }}@if (!g.fits) { · <span class="cal-neg">no cabe en el tope</span> }</span>
                          </span>
                          <span class="pg-prop-amt comm-num">{{ money(g.total) }}</span>
                        </label>
                      } @empty {
                        <p class="cal-muted">No hay facturas vencidas ni que venzan este dia.</p>
                      }
                      <div class="pg-stepacts">
                        <button pButton type="button" class="p-button-sm p-button-text" [disabled]="saving()" (click)="armado.set(null)">Descartar la propuesta</button>
                        <button pButton type="button" class="p-button-sm" [disabled]="!armadoChosen().length" [loading]="saving()" (click)="applyArmado()">Guardar el armado · {{ armadoChosen().length }} pago(s) · {{ money(armadoTotal()) }}</button>
                      </div>
                    </div>
                  } @else if (!isReleased()) {
                    <div class="pg-stepacts pg-stepacts-start">
                      <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="!day.summary.capacity_defined || saving()" (click)="openArmado()"><span class="pi pi-sparkles" aria-hidden="true"></span>&nbsp;Sugerir armado</button>
                    </div>
                  }

                  <!-- EL CAJON DE LA DEUDA: vive aca, que es donde se arma. -->
                  <div class="pg-drawer">
                    <div class="pg-drawer-h">
                      <input pInputText type="search" [(ngModel)]="search" (keyup.enter)="loadObligations()"
                             placeholder="Buscar en las {{ obligationsTotal() | number }} facturas: nombre, folio, referencia o codigo…"
                             class="p-inputtext-sm pg-grow" aria-label="Buscar en lo que debo por nombre del beneficiario, folio interno, referencia del proveedor o codigo del acreedor" />
                      <p-select [options]="classificationOpts" [(ngModel)]="classificationFilter" (onChange)="loadObligations()" optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true" styleClass="cal-sel p-inputtext-sm" />
                      <p-select [options]="ordenOpts" [(ngModel)]="ordenSel" (onChange)="onOrden()" optionLabel="label" optionValue="value" styleClass="cal-sel p-inputtext-sm" />
                      <label class="cal-check"><p-checkbox [(ngModel)]="onlyCritical" [binary]="true" (onChange)="loadObligations()" />Criticos</label>
                    </div>
                    @if (obligationsTruncated()) {
                      <p class="pg-drawer-n">La busqueda llega a <b>las {{ obligationsTotal() | number }}</b> facturas; la lista muestra las <b>{{ obligations().length | number }}</b> mas proximas a vencer. Las demas no faltan por error.</p>
                    }

                    <!-- [PGP.13] ⛔ LO QUE NO SE PUEDE PROGRAMAR, APARTE Y SIN BOTON DE AGREGAR.
                         Las facturas de sucursal anteriores al corte del 1-oct pueden estar pagadas
                         desde Oficinas sin aplicarse en la sucursal: programarlas las paga dos
                         veces. La vista ya marca cuales son (la columna anterior_al_corte), y esta pantalla
                         las ordenaba PRIMERO -por antiguedad-, que es el peor lugar posible. -->
                    @if (obligacionesEnRevision().length) {
                      <div class="pg-drawer-g">
                        Por confirmar antes de programar
                        <span>Facturas de sucursal anteriores al corte del 1-oct: varias se pagaron desde Oficinas sin aplicarse en la sucursal. Se revisan con Finanzas; se ven, no se agregan.</span>
                      </div>
                      <div class="pg-drawer-b is-locked">
                        @for (o of obligacionesEnRevision(); track o.obligation_id) {
                          <div class="pg-dr-row">
                            <span class="pg-dr-main">
                              <span class="cal-benef">{{ o.beneficiary }}<span class="pg-dr-amt comm-num">{{ money(o.available_amount) }}</span></span>
                              <span class="pg-sub"><span class="cal-suc">{{ branchLabel(o.branch_code) }}</span> {{ o.concept }}@if (o.doc_ref) { <span class="cal-ref">{{ o.doc_ref }}</span> } · {{ classLabel(o.classification) }}</span>
                            </span>
                            <span class="pg-dr-due cal-mono" [class.cal-overdue]="isOverdue(vence(o))">{{ shortDate(vence(o)) }}</span>
                            <span class="pg-dr-no">por confirmar</span>
                          </div>
                        }
                      </div>
                      <p class="pg-drawer-n">Programables</p>
                    }

                    <div class="pg-drawer-b">
                      <app-load-state [loading]="loadingObligations()" [skeletonRows]="4">
                        @for (o of obligacionesProgramables(); track o.obligation_id) {
                          <div class="pg-dr-row" [class.cal-row-critical]="o.is_critical">
                            <span class="pg-dr-main">
                              <span class="cal-benef">@if (o.is_critical) { <i class="pi pi-flag cal-crit-flag" aria-label="Critico"></i> }{{ o.beneficiary }}<span class="pg-dr-amt comm-num">{{ money(o.available_amount) }}</span></span>
                              <span class="pg-sub"><span class="cal-suc">{{ branchLabel(o.branch_code) }}</span>
                                @if (o.entity_ref) {
                                  <button type="button" class="cal-reflink" [title]="'Ver la ficha completa de ' + docLabel(o)" (click)="inspect.set(o.entity_ref!)">{{ o.concept }}</button>
                                } @else { {{ o.concept }} }
                                @if (o.doc_ref) { <span class="cal-ref">{{ o.doc_ref }}</span> }
                                @if (o.pronto_beneficio && (o.pronto_estado === 'por_vencer' || o.pronto_estado === 'capturable')) {
                                  <span class="cal-pp" [class.cal-pp-urge]="o.pronto_estado === 'por_vencer'">
                                    <i class="pi" [class.pi-bolt]="o.pronto_estado === 'por_vencer'" [class.pi-tag]="o.pronto_estado === 'capturable'" aria-hidden="true"></i>
                                    pierde {{ money(o.pronto_beneficio) }}@if (o.pronto_tasa) { ({{ pct(o.pronto_tasa) }}) }@if (o.pronto_fecha_limite) { si no se paga antes del {{ shortDate(o.pronto_fecha_limite) }} }
                                  </span>
                                }
                              </span>
                            </span>
                            <span class="pg-dr-due cal-mono" [class.cal-overdue]="isOverdue(vence(o))">{{ shortDate(vence(o)) }}</span>
                            <button pButton type="button" class="p-button-sm p-button-text pg-dr-add" [attr.aria-label]="'Agregar ' + o.beneficiary + ' al ' + dayLong(day.date)" (click)="quickAdd(o)"><span class="pi pi-plus" aria-hidden="true"></span></button>
                          </div>
                        } @empty {
                          <p class="cal-empty">Sin obligaciones con estos filtros. Las facturas de proveedor llegan aqui cuando Finanzas acepta una entrega en <a routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">Entregas de Compras</a>.</p>
                        }
                      </app-load-state>
                    </div>
                  </div>
                </div>
              </section>

              <!-- ② ORDENAR Y PREPARAR ───────────────────────────────── -->
              <section class="pg-step" [class.is-now]="pasoActivo() <= 2 && pendingCount() > 0" [class.is-open]="stepOpen(2)"
                       [class.is-done]="pendingCount() > 0 && unpreparedCount() === 0 && unrankedCount() === 0">
                <button type="button" class="pg-step-h" [attr.aria-expanded]="stepOpen(2)" aria-controls="pg-b2" (click)="toggleStep(2)">
                  <span class="pg-sn" aria-hidden="true">@if (pendingCount() > 0 && unpreparedCount() === 0 && unrankedCount() === 0) { <i class="pi pi-check"></i> } @else { 2 }</span>
                  <span class="pg-step-t">
                    <span class="pg-step-name">Ordenar y preparar</span><span class="pg-step-who">Tesoreria</span>
                    <span class="pg-step-say">{{ saysPaso2() }}</span>
                  </span>
                  <span class="pi pi-angle-right pg-chev" aria-hidden="true"></span>
                </button>
                <div class="pg-step-body" id="pg-b2">
                  @if (!allocations().length) {
                    <p class="cal-empty">Sin pagos este dia. Usa «Sugerir armado» o agrega facturas desde el paso 1.</p>
                  } @else {
                    <!-- [PGP.13] Lo que mata el dialogo por pago: metodo y cuenta de origen casi
                         siempre son los mismos. El destino es de cada proveedor y queda por fila. -->
                    @if (!isReleased()) {
                      <div class="pg-applyall">
                        <span class="pg-aa-lb">Para los {{ pendingCount() }} pagos</span>
                        <span class="pg-aa-f"><span>Metodo</span>
                          <p-select [options]="methodOpts" [(ngModel)]="bulkMethod" optionLabel="label" optionValue="value" placeholder="Elegir…" styleClass="cal-sel p-inputtext-sm" [attr.aria-label]="'Metodo para todos'" /></span>
                        <span class="pg-aa-f"><span>Sale de</span>
                          <p-select [options]="originOpts()" [(ngModel)]="bulkOriginId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [filter]="true" filterBy="label" styleClass="cal-sel p-inputtext-sm" /></span>
                        <button pButton type="button" class="p-button-sm" [disabled]="!bulkMethod || saving()" [loading]="saving()" (click)="aplicarATodos()">Aplicar a los {{ pendingCount() }}</button>
                      </div>
                    }

                    <p-table [value]="allocations()" styleClass="p-datatable-sm surf-table surf-table--plain pg-prep">
                      <ng-template #header>
                        <tr>
                          <th class="pg-c-ord">Orden</th>
                          <th>Beneficiario e importe</th>
                          <th class="pg-c-met">Metodo</th>
                          <th class="pg-c-ori">Sale de</th>
                          <th class="pg-c-des">Llega a</th>
                          <th class="pg-c-x"><span class="sr-only">Quitar</span></th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-a let-i="rowIndex">
                        <tr [class.pg-row-wait]="a.status === 'pending' && !prepared(a)">
                          <td class="pg-c-ord">
                            @if (a.status === 'pending' && !isReleased()) {
                              <!-- [PGP.13] Ordenar CON TECLADO. Era un campo numerico suelto: quien
                                   no usa mouse no podia ordenar, y el orden decide el turno en que
                                   Caja General dispersa. El atajo se escribe en pantalla. -->
                              <span class="pg-ord">
                                <button pButton type="button" class="p-button-sm p-button-text pg-ico" [disabled]="i === 0 || saving()" (click)="moverPago(a, -1)" [attr.aria-label]="'Subir ' + allocationTitle(a)"><span class="pi pi-chevron-up" aria-hidden="true"></span></button>
                                <b class="comm-num pg-ordn">{{ a.priority_rank ?? '—' }}</b>
                                <button pButton type="button" class="p-button-sm p-button-text pg-ico" [disabled]="i === allocations().length - 1 || saving()" (click)="moverPago(a, 1)" [attr.aria-label]="'Bajar ' + allocationTitle(a)"><span class="pi pi-chevron-down" aria-hidden="true"></span></button>
                              </span>
                            } @else {
                              <span class="comm-num pg-ordn">{{ a.folio || a.priority_rank || '—' }}</span>
                            }
                          </td>
                          <td class="pg-c-ben">
                            <span class="cal-benef">{{ allocationTitle(a) }}<span class="pg-dr-amt comm-num">{{ money(a.amount_assigned) }}</span></span>
                            <span class="pg-sub">
                              @for (it of a.items; track it.id) {
                                <span class="cal-suc">{{ branchLabel(it.branch_code) }}</span>{{ it.concept }}@if (!$last) { · }
                              }
                            </span>
                            @if (a.status === 'failed' && a.failure_reason) { <span class="cal-fail">Fallo: {{ a.failure_reason }}</span> }
                            @if (a.notes) { <span class="cal-notes">{{ a.notes }}</span> }
                          </td>
                          @if (a.status === 'pending' && !isReleased()) {
                            <td class="pg-c-met" data-l="Metodo">
                              <p-select [options]="methodOpts" [ngModel]="a.payment_method" (onChange)="setMetodo(a, $event.value)" optionLabel="label" optionValue="value" placeholder="Elegir…" styleClass="cal-sel p-inputtext-sm" [attr.aria-label]="'Metodo del pago de ' + allocationTitle(a)" />
                            </td>
                            <td class="pg-c-ori" data-l="Sale de">
                              @if (a.payment_method && a.payment_method !== 'efectivo') {
                                <p-select [options]="originOpts()" [ngModel]="a.bank_account_id" (onChange)="setOrigen(a, $event.value)" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [filter]="true" filterBy="label" styleClass="cal-sel p-inputtext-sm" [attr.aria-label]="'Cuenta de origen del pago de ' + allocationTitle(a)" />
                              } @else if (a.payment_method === 'efectivo') {
                                <span class="pg-fieldnote">Caja</span>
                              } @else { <span class="pg-fieldnote">elegi el metodo</span> }
                            </td>
                            <td class="pg-c-des" data-l="Llega a">
                              @if (a.payment_method === 'transferencia' || a.payment_method === 'cargo_automatico') {
                                <button pButton type="button" class="p-button-sm p-button-outlined pg-dest" (click)="openPrepare(a)">
                                  @if (a.destination_account_text) { {{ destinationOf(a) }} } @else { Capturar la cuenta destino }
                                </button>
                                @if (!a.destination_account_text) { <span class="pg-fieldnote is-bad">sin cuenta destino</span> }
                              } @else if (a.payment_method === 'cheque') {
                                <button pButton type="button" class="p-button-sm p-button-outlined pg-dest" (click)="openPrepare(a)">@if (a.reference_text) { Cheque {{ a.reference_text }} } @else { Folio del cheque }</button>
                              } @else if (a.payment_method === 'efectivo') {
                                <button pButton type="button" class="p-button-sm p-button-outlined pg-dest" (click)="openPrepare(a)">@if (a.cash_register_text) { {{ a.cash_register_text }} } @else { Caja de salida }</button>
                              } @else { <span class="pg-fieldnote">—</span> }
                            </td>
                            <td class="pg-c-x">
                              <button pButton type="button" class="p-button-sm p-button-text p-button-danger" [attr.aria-label]="'Quitar del dia a ' + allocationTitle(a)" pTooltip="Quitar del dia" tooltipPosition="top" (click)="cancelAllocation(a)"><span class="pi pi-times" aria-hidden="true"></span></button>
                            </td>
                          } @else {
                            <td class="pg-c-met">{{ a.payment_method ? methodLabel(a.payment_method) : '—' }}</td>
                            <td class="pg-c-ori">{{ a.bank_account_label || (a.payment_method === 'efectivo' ? 'Caja' : '—') }}</td>
                            <td class="pg-c-des">{{ destinationOf(a) }}</td>
                            <td class="pg-c-x"><p-tag [value]="statusLabel(a.status)" [severity]="statusSeverity(a.status)" styleClass="cal-tag" /></td>
                          }
                        </tr>
                      </ng-template>
                    </p-table>

                    <div class="pg-stepacts">
                      <span class="pg-stepacts-l">
                        @if (!isReleased()) {
                          <button pButton type="button" class="p-button-sm p-button-text" [loading]="saving()" (click)="suggestOrder()"><span class="pi pi-sort-amount-down" aria-hidden="true"></span>&nbsp;Proponer orden</button>
                        }
                        <button pButton type="button" class="p-button-sm p-button-text" [loading]="printing()" (click)="printPreliminar()"><span class="pi pi-file-pdf" aria-hidden="true"></span>&nbsp;Preliminar</button>
                      </span>
                      <span class="pg-stepacts-r">
                        @if (authorizeBlocker(); as why) { <span class="pg-why-off">{{ why }}</span> }
                      </span>
                    </div>
                  }
                </div>
              </section>

              <!-- ③ AUTORIZAR ────────────────────────────────────────── -->
              <section class="pg-step" [class.is-now]="pasoActivo() === 3" [class.is-done]="isReleased()" [class.is-open]="stepOpen(3)">
                <button type="button" class="pg-step-h" [attr.aria-expanded]="stepOpen(3)" aria-controls="pg-b3" (click)="toggleStep(3)">
                  <span class="pg-sn" aria-hidden="true">@if (isReleased()) { <i class="pi pi-check"></i> } @else { 3 }</span>
                  <span class="pg-step-t">
                    <span class="pg-step-name">Autorizar el dia</span><span class="pg-step-who">Gerencia / Direccion</span>
                    <span class="pg-step-say">{{ saysPaso3() }}</span>
                  </span>
                  <span class="pi pi-angle-right pg-chev" aria-hidden="true"></span>
                </button>
                <div class="pg-step-body" id="pg-b3">
                  <!-- [PGP.13] ⛔ Lo que esta pantalla NO puede afirmar todavia. La decision D2
                       -una firma por pago segun su monto, hasta $100,000 Tesoreria y arriba
                       Direccion- esta firmada pero NO construida: hoy releaseLot() autoriza el
                       DIA COMPLETO con un solo permiso. Dibujar dos firmantes aqui seria mostrar
                       una regla que el codigo no aplica, que es justo lo que ADR-056 prohibe. -->
                  <div class="pg-signrule">
                    <i class="pi pi-shield" aria-hidden="true"></i>
                    <span>Hoy se autoriza <b>el dia completo</b>, no pago por pago, y lo hace quien tiene el permiso de autorizar — <b>nunca quien lo preparo</b>. El dia sale cuando sus {{ pendingCount() }} pago(s) estan ordenados y preparados.</span>
                  </div>
                  <div class="pg-decl">
                    <i class="pi pi-info-circle" aria-hidden="true"></i>
                    <span><b>Falta construir:</b> la firma por pago segun su monto (decision D2). Mientras no exista, un pago de {{ money(50000) }} y uno de {{ money(900000) }} los autoriza la misma persona en el mismo clic.</span>
                  </div>
                  <div class="pg-stepacts">
                    <span class="pg-stepacts-l">
                      <button pButton type="button" class="p-button-sm p-button-text" [loading]="printing()" (click)="printPreliminar()">Ver el preliminar</button>
                    </span>
                    <span class="pg-stepacts-r">
                      @if (!canAuthorize()) {
                        <span class="pg-why-off">No tenes el permiso de autorizar: lo hace Gerencia o Direccion.</span>
                      } @else if (authorizeBlocker(); as why) {
                        <span class="pg-why-off">{{ why }}</span>
                      }
                      @if (canAuthorize() && !isReleased()) {
                        <button pButton type="button" class="p-button-sm" [disabled]="!!authorizeBlocker() || saving()" [loading]="saving()" (click)="releaseLot()"><span class="pi pi-lock" aria-hidden="true"></span>&nbsp;Autorizar el dia</button>
                      }
                    </span>
                  </div>
                </div>
              </section>

              <!-- ④ DISPERSAR Y CERRAR ───────────────────────────────── -->
              <section class="pg-step" [class.is-now]="pasoActivo() === 4" [class.is-open]="stepOpen(4)">
                <button type="button" class="pg-step-h" [attr.aria-expanded]="stepOpen(4)" aria-controls="pg-b4" (click)="toggleStep(4)">
                  <span class="pg-sn" aria-hidden="true">4</span>
                  <span class="pg-step-t">
                    <span class="pg-step-name">Dispersar y cerrar</span><span class="pg-step-who">Caja General</span>
                    <span class="pg-step-say">{{ saysPaso4() }}</span>
                  </span>
                  <span class="pi pi-angle-right pg-chev" aria-hidden="true"></span>
                </button>
                <div class="pg-step-body" id="pg-b4">
                  <!-- [PGP.13] «Autorizado» decia el monto del dia AUNQUE el dia no estuviera
                       autorizado. Ahora dice lo que de verdad se autorizo y de cuanto, y se marca
                       pago por pago: uno puede rebotar y los demas no (DESIGN §10 fallos parciales). -->
                  <div class="pg-recon">
                    <div class="pg-rc"><span class="pg-rc-l">Autorizado</span><span class="pg-rc-v comm-num">{{ money(isReleased() ? day.summary.assigned_amount : 0) }}</span><span class="pg-rc-s">@if (isReleased()) { {{ pendingCount() + executedCount() }} pago(s) } @else { 0 de {{ allocations().length }} · de {{ money(day.summary.assigned_amount) }} }</span></div>
                    <div class="pg-rc"><span class="pg-rc-l">Marcado como pagado</span><span class="pg-rc-v comm-num">{{ money(day.summary.executed_amount) }}</span><span class="pg-rc-s">{{ executedCount() }} de {{ allocations().length }} · lo marca Caja General</span></div>
                    <div class="pg-rc is-other">
                      <span class="pg-rc-l">El ERP registra ese dia</span>
                      @if (day.libro; as lb) {
                        <span class="pg-rc-v comm-num">{{ money(lb.monto) }}</span>
                        <span class="pg-rc-s">{{ lb.n }} pago(s) · suma por fecha, no casa renglones: es otro universo</span>
                      } @else {
                        <span class="pg-rc-v cal-muted">sin medir</span>
                        <span class="pg-rc-s">el espejo del ERP no trae fecha de corte para este dia</span>
                      }
                    </div>
                  </div>
                  <!-- [PGP.13] Si no se dice, quien captura deja de hacerlo creyendo que la Suite
                       lo escribe. Medido el 2026-10-26: los pods de prod no traen KEPLER_PUSH_URL_NN. -->
                  <div class="pg-decl">
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    <span><b>Kepler: el pago (X-D-26) se sigue capturando a mano.</b> La escritura automatica esta apagada; cuando se encienda, cada pago dira aqui si la Suite lo escribio completo.</span>
                  </div>
                  <div class="pg-stepacts">
                    <span class="pg-stepacts-l">
                      @if (day.lot_folio) { <button pButton type="button" class="p-button-sm" [loading]="printing()" (click)="printCajaGeneral()"><span class="pi pi-print" aria-hidden="true"></span>&nbsp;Instruccion a Caja General</button> }
                      @else { <span class="pg-why-off">La instruccion se imprime cuando el dia esta autorizado.</span> }
                    </span>
                    <span class="pg-stepacts-r"><span class="pg-why-off">Se marca pago por pago: uno puede rebotar y los demas no.</span></span>
                  </div>
                  @if (isReleased()) {
                    <div class="pg-exec">
                      @for (a of allocations(); track a.id) {
                        <div class="pg-exec-row">
                          <span class="pg-dr-main">
                            <span class="cal-benef">{{ allocationTitle(a) }}<span class="pg-dr-amt comm-num">{{ money(a.amount_assigned) }}</span></span>
                            <span class="pg-sub">{{ a.payment_method ? methodLabel(a.payment_method) : '—' }} · {{ destinationOf(a) }}</span>
                          </span>
                          <p-tag [value]="statusLabel(a.status)" [severity]="statusSeverity(a.status)" styleClass="cal-tag" />
                          @if (a.status === 'pending') {
                            <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="!prepared(a) || saving()" (click)="execute(a)" [attr.aria-label]="'Marcar como pagado ' + allocationTitle(a)">Marcar pagado</button>
                            <button pButton type="button" class="p-button-sm p-button-text" [attr.aria-label]="'Mover a otro dia ' + allocationTitle(a)" pTooltip="Mover a otro dia" tooltipPosition="top" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span></button>
                          } @else if (a.status === 'failed') {
                            <button pButton type="button" class="p-button-sm p-button-text" [attr.aria-label]="'Reprogramar ' + allocationTitle(a)" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span></button>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              </section>

            </div>
          }
        </main>
      </div>
    </div>

    <!-- Dialog: agrupar seleccionadas -->
    <p-dialog [(visible)]="groupDialogVisible" [modal]="true" header="Agrupar en un pago" [style]="{ width: '34rem' }">
      <p class="cal-dlg-p">Va <strong>un solo pago</strong> con {{ selected().length }} factura(s); si ese día ya hay un pago pendiente de este proveedor y sucursal, se suman a ese (y las observaciones no se cambian). Ajusta el importe si es una parcialidad.</p>
      <label class="cal-dlg-label" for="cal-group-day">Día de pago</label>
      <p-select inputId="cal-group-day" [options]="dayOpts()" [(ngModel)]="targetDate" optionLabel="label" optionValue="value" styleClass="cal-dlg-sel" />
      @for (o of selected(); track o.obligation_id) {
        <div class="cal-dlg-row">
          <span class="cal-dlg-name">{{ o.beneficiary }} <span class="cal-muted">— {{ o.concept }}</span></span>
          <input pInputText type="number" [(ngModel)]="groupAmounts[o.obligation_id]" [max]="o.available_amount" min="0.01" class="cal-dlg-amt" [attr.aria-label]="'Importe para ' + o.beneficiary" />
        </div>
      }
      <div class="cal-dlg-actions">
        <input pInputText type="text" [(ngModel)]="newNotes" placeholder="Observaciones (opcional)" class="cal-dlg-notes" aria-label="Observaciones" />
        <button pButton type="button" (click)="confirmGroupAdd()" [loading]="saving()">Agregar</button>
      </div>
    </p-dialog>

    <!-- Dialog: agregar sola -->
    <p-dialog [(visible)]="quickAddVisible" [modal]="true" header="Agregar a un día" [style]="{ width: '28rem' }">
      @if (quickAddTarget(); as o) {
        <p class="cal-dlg-p">{{ o.beneficiary }} — {{ o.concept }}</p>
        <label class="cal-dlg-label" for="cal-quick-day">Día de pago</label>
        <p-select inputId="cal-quick-day" [options]="dayOpts()" [(ngModel)]="targetDate" optionLabel="label" optionValue="value" styleClass="cal-dlg-sel" />
        <label class="cal-dlg-label" for="cal-quick-amt">Importe a asignar (disponible {{ money(o.available_amount) }})</label>
        <input id="cal-quick-amt" pInputText type="number" [(ngModel)]="quickAddAmount" [max]="o.available_amount" min="0.01" class="cal-dlg-full" />
        <div class="cal-dlg-actions">
          <button pButton type="button" (click)="confirmQuickAdd()" [loading]="saving()">Agregar</button>
        </div>
      }
    </p-dialog>

    <!-- Dialog: preparar (lo que pide el layout del banco) -->
    <p-dialog [(visible)]="prepareVisible" [modal]="true" header="Preparar pago" [style]="{ width: '32rem' }">
      @if (prepAllocation; as a) {
        <p class="cal-dlg-p"><strong>{{ allocationTitle(a) }}</strong> · {{ money(a.amount_assigned) }}</p>
      }
      <label class="cal-dlg-label" for="cal-prep-method">Método de pago</label>
      <p-select inputId="cal-prep-method" [options]="methodOpts" [(ngModel)]="prepMethod" optionLabel="label" optionValue="value" placeholder="Método" styleClass="cal-dlg-sel" />
      @if (prepMethod === 'transferencia' || prepMethod === 'cargo_automatico' || prepMethod === 'cheque') {
        <label class="cal-dlg-label" for="cal-prep-origin">Cuenta de origen (de dónde sale el dinero)</label>
        <p-select inputId="cal-prep-origin" [options]="originOpts()" [(ngModel)]="prepOriginId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta de Mega Dulces…" [filter]="true" filterBy="label" styleClass="cal-dlg-sel" />
      }
      @if (prepMethod === 'transferencia' || prepMethod === 'cargo_automatico') {
        @if (prepAccounts().length) {
          <label class="cal-dlg-label" for="cal-prep-dest">Cuenta destino del catálogo del proveedor</label>
          <p-select inputId="cal-prep-dest" [options]="prepAccounts()" [(ngModel)]="prepAccountId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [showClear]="true" styleClass="cal-dlg-sel" />
        } @else if (prepAccountsError()) {
          <p class="cal-dlg-hint cal-warn-txt">No se pudo leer el catálogo de cuentas del proveedor ({{ prepAccountsError() }}). Captura la CLABE abajo.</p>
        } @else if (prepSupplierId) {
          <p class="cal-dlg-hint">Este proveedor no tiene cuentas en el catálogo. Captura la CLABE abajo; para no volver a teclearla, pide a Compras que la dé de alta en Cuentas de pago (pasa por aprobación de Gerencia).</p>
        }
        <label class="cal-dlg-label" for="cal-prep-clabe">Cuenta destino — banco y CLABE (si no está en el catálogo)</label>
        <input id="cal-prep-clabe" pInputText type="text" [(ngModel)]="prepDestination" [disabled]="!!prepAccountId" placeholder="Ej. BBVA · CLABE 012180001234567891" class="cal-dlg-full" />
        <p class="cal-dlg-hint">Si escribes una CLABE de 18 dígitos se valida su dígito de control.</p>
      }
      @if (prepMethod === 'cheque') {
        <label class="cal-dlg-label" for="cal-prep-ref">Folio del cheque</label>
        <input id="cal-prep-ref" pInputText type="text" [(ngModel)]="prepReference" placeholder="Folio" class="cal-dlg-full" />
      }
      @if (prepMethod === 'efectivo') {
        <label class="cal-dlg-label" for="cal-prep-cash">Caja de salida</label>
        <input id="cal-prep-cash" pInputText type="text" [(ngModel)]="prepCash" placeholder="Caja" class="cal-dlg-full" />
      }
      <div class="cal-dlg-actions"><button pButton type="button" (click)="confirmPrepare()" [loading]="saving()">Guardar</button></div>
    </p-dialog>

    <!-- Dialog: preparar varios a la vez (mismo método y origen; destino por pago) -->
    <p-dialog [(visible)]="bulkVisible" [modal]="true" header="Preparar seleccionados" [style]="{ width: '40rem' }">
      <p class="cal-dlg-p">Se aplica el mismo método y la misma cuenta de origen a los {{ bulkRows().length }} pago(s). El destino es de cada proveedor.</p>
      <label class="cal-dlg-label" for="cal-bulk-method">Método de pago</label>
      <p-select inputId="cal-bulk-method" [options]="methodOpts" [(ngModel)]="bulkMethod" (onChange)="fillBulkDest()" optionLabel="label" optionValue="value" placeholder="Método" styleClass="cal-dlg-sel" />
      @if (bulkMethod && bulkMethod !== 'efectivo') {
        <label class="cal-dlg-label" for="cal-bulk-origin">Cuenta de origen (de dónde sale el dinero)</label>
        <p-select inputId="cal-bulk-origin" [options]="originOpts()" [(ngModel)]="bulkOriginId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta de Mega Dulces…" [filter]="true" filterBy="label" styleClass="cal-dlg-sel" />
      }
      @if (bulkMethod === 'efectivo') {
        <label class="cal-dlg-label" for="cal-bulk-cash">Caja de salida</label>
        <input id="cal-bulk-cash" pInputText type="text" [(ngModel)]="bulkCash" placeholder="Caja" class="cal-dlg-full" />
      }
      @if (bulkMethod === 'transferencia' || bulkMethod === 'cargo_automatico' || bulkMethod === 'cheque') {
        <div class="cal-bulk-list">
          @for (r of bulkRows(); track r.id) {
            <div class="cal-bulk-row">
              <span class="cal-bulk-name"><span class="cal-benef">{{ allocationTitle(r) }}</span><span class="cal-concept comm-num">{{ money(r.amount_assigned) }}</span></span>
              @if (bulkMethod === 'cheque') {
                <input pInputText type="text" [(ngModel)]="bulkDest[r.id]" placeholder="Folio del cheque" class="p-inputtext-sm" [attr.aria-label]="'Folio del cheque para ' + allocationTitle(r)" />
              } @else {
                <input pInputText type="text" [(ngModel)]="bulkDest[r.id]" placeholder="Banco · CLABE de 18 dígitos" class="p-inputtext-sm" [attr.aria-label]="'Cuenta destino para ' + allocationTitle(r)" />
              }
            </div>
          }
        </div>
        <p class="cal-dlg-hint">Si escribes una CLABE de 18 dígitos se valida su dígito de control. Un pago que falle no detiene a los demás.</p>
      }
      <div class="cal-dlg-actions"><button pButton type="button" (click)="confirmBulkPrepare()" [loading]="saving()" [disabled]="!bulkMethod">Guardar</button></div>
    </p-dialog>

    <!-- Dialog: reprogramar -->
    <p-dialog [(visible)]="reprogramVisible" [modal]="true" header="Mover a otro día" [style]="{ width: '24rem' }">
      <label class="cal-dlg-label" for="cal-rep-date">Nueva fecha</label>
      <input id="cal-rep-date" type="date" [(ngModel)]="reprogramDate" class="cal-date-input cal-dlg-full" />
      <label class="cal-dlg-label" for="cal-rep-reason">Motivo</label>
      <p-select inputId="cal-rep-reason" [options]="reprogramReasonOpts" [(ngModel)]="reprogramReason" optionLabel="label" optionValue="value" placeholder="Motivo" styleClass="cal-dlg-sel" />
      @if (reprogramReason === 'otro') {
        <input pInputText type="text" [(ngModel)]="reprogramReasonDetail" placeholder="Detalle (obligatorio)" class="cal-dlg-full" aria-label="Detalle del motivo" />
      }
      <div class="cal-dlg-actions"><button pButton type="button" (click)="confirmReprogram()" [loading]="saving()">Mover</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .cal-page { gap:var(--sp-3); }
    .cal-head { align-items:flex-end; }
    .cal-nav { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .cal-week-label { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); font-weight:600; color:var(--text-main); min-width:10.5rem; text-align:center; }
    .cal-date-input { padding:var(--sp-1) var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:var(--fs-sm); }
    /* [TP.20.4] El ahorro por pronto pago en la fila: discreto, y urgente cuando caduca.
       El estado no viaja solo en el color -lleva icono y la palabra "antes del"-. */
    .cal-pp { display:inline-flex; align-items:center; gap:.25rem; margin-top:.15rem;
      font-size: var(--fs-xs); color: var(--text-muted); }
    .cal-pp-urge { color: var(--warn-fg); font-weight: 600; }
    /* [TP.20.5] La factura es un enlace a su ficha. No se pinta de color en reposo: en una
       lista densa, 2,900 enlaces azules son ruido; el afordance aparece al pasar y al foco. */
    /* [TP.21.2] La costura con el libro de Tesoreria. Discreta a proposito: es CONTEXTO del dia
       (lo que ya salio segun el Excel), no la cifra con la que se arma el pago. El hueco -un mes
       sin cargar- si toma color, porque es lo unico de aqui que pide accion. */
    .cal-day-libro { display:inline-flex; align-items:center; gap:.25rem; margin-top:.15rem;
      font-size: var(--fs-micro, .72rem); color: var(--text-faint); }
    .cal-day-libro.is-gap { color: var(--warn-fg); }
    .cal-reflink { border:0; background:transparent; color:inherit; cursor:pointer; padding:0;
      font:inherit; text-align:left; }
    .cal-reflink:hover { color: var(--action); text-decoration: underline; }
    .cal-reflink:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cal-muted { color:var(--text-faint); }
    .cal-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cal-neg { color:var(--bad-fg); }
    .cal-warn-txt { color:var(--warn-fg); }
    .cal-cap { text-transform:capitalize; font-weight:400; color:var(--text-muted); }

    /* ── Riel de la semana: los 7 días caben en una fila; fin de semana sin presupuesto se atenúa.
       [PGP.11] La tarjeta pasó de cinco renglones a tres y de ~120px a ~68px, SIN perder ningún
       dato: la cifra grande y su "disponible de $X" se juntaron en un renglón que se dice entero
       ("$3.48M libres de $3.98M"), y la barra se corrió a la izquierda de esa misma línea. Lo que
       se recupera de alto es lo que antes empujaba el trabajo abajo del pliegue. */
    .cal-week { display:grid; grid-template-columns:repeat(7, minmax(8.5rem, 1fr)); gap:var(--sp-2); overflow-x:auto; padding:2px; }
    .cal-day { all:unset; box-sizing:border-box; cursor:pointer; display:flex; flex-direction:column; gap:var(--sp-1); padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .cal-day-line { display:flex; align-items:baseline; gap:var(--sp-1); min-width:0; flex-wrap:wrap; }
    .cal-day-line .cal-bar { flex:0 0 100%; margin-bottom:.15rem; }
    /* La semana entera en un renglón: contexto, no trabajo. Terciario por tamaño Y por contraste
       (DESIGN.md Q.5), nunca sólo por color. */
    .cal-weekline { display:flex; flex-wrap:wrap; gap:var(--sp-1) var(--sp-3); margin:var(--sp-2) 0 0; font-size:var(--fs-xs); color:var(--text-muted); }
    .cal-weekline b { font-weight:600; color:var(--text-main); }
    .cal-day:hover { background:var(--overlay-hover); }
    .cal-day:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .cal-day.is-selected { border-color:var(--action); box-shadow:inset 0 0 0 1px var(--action); }
    .cal-day.is-empty:not(.is-selected) { opacity:.6; }
    .cal-day-head { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-1); }
    .cal-day-name { font-weight:700; font-size:var(--fs-sm); text-transform:capitalize; color:var(--text-main); }
    .cal-today { font-weight:400; color:var(--action); }
    .cal-day-lot { font-size:var(--fs-nano); font-weight:600; color:var(--text-muted); white-space:nowrap; }
    .cal-day-lot.is-ok { color:var(--ok-fg); }
    .cal-day-lot.is-info { color:var(--info-fg); }
    .cal-day-avail { font-size:var(--fs-body); font-weight:700; color:var(--text-main); line-height:1.2; }
    .cal-day-cap, .cal-day-foot { font-size:var(--fs-xs); color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cal-day-nocap { font-size:var(--fs-sm); color:var(--text-faint); line-height:1.2; padding:var(--sp-1) 0; }
    .cal-bar { display:block; height:4px; border-radius:var(--r-pill); background:var(--border-color); overflow:hidden; }
    .cal-bar-fill { display:block; height:100%; background:var(--action); border-radius:inherit; }
    .cal-bar-fill.is-over { background:var(--bad-fg); }

    /* ── Área de trabajo: obligaciones | ordenar y pagar */
    /* La lista de obligaciones gana ancho (2 de 5): nombre completo sin desplazamiento lateral. */
    .cal-work { display:grid; grid-template-columns:minmax(26rem, 2fr) minmax(0, 3fr); gap:var(--sp-4); align-items:start; }
    @container (max-width: 70rem) { .cal-work { grid-template-columns:minmax(0, 1fr); } }
    .cal-panel { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:var(--sp-3); min-width:0; }
    .cal-oblig { display:flex; flex-direction:column; height:clamp(24rem, calc(100vh - 22rem), 40rem); }
    .cal-panel-head { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; margin-bottom:var(--sp-2); }
    .cal-panel-head h2 { font-size:var(--fs-body); margin:0; }
    .cal-count { color:var(--text-faint); font-size:var(--fs-xs); font-weight:400; margin-left:var(--sp-1); }
    .cal-filters { display:flex; gap:var(--sp-2); align-items:center; margin-bottom:var(--sp-2); }
    .cal-search { flex:1; min-width:0; }
    :host ::ng-deep .cal-sel { width:7.5rem; }
    .cal-check { display:flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-xs); color:var(--text-muted); white-space:nowrap; }
    .cal-table { font-size:var(--fs-sm); }
    :host ::ng-deep .cal-oblig-table { flex:1; min-height:0; }
    /* Ancho fijo de columnas sobre la tabla INTERNA de PrimeNG (antes apuntaba a otro nodo y no
       aplicaba: de ahí el desplazamiento lateral). El nombre absorbe el resto y se corta con «…». */
    :host ::ng-deep .cal-oblig-table .p-datatable-table,
    :host ::ng-deep .cal-pay-table .p-datatable-table { table-layout:fixed; width:100%; min-width:0; }
    :host ::ng-deep .cal-oblig-table .p-datatable-table-container { overflow-x:hidden; }
    :host ::ng-deep .cal-table th { font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); }
    .cal-c-due { width:4.75rem; }
    .cal-c-amt { width:7.5rem; }
    .cal-c-add { width:2.75rem; }
    .cal-c-ord { width:4rem; }
    .cal-c-chk { width:2.25rem; }
    /* Armado sugerido (TP.16.4): se distingue con borde de acción punteado, es una PROPUESTA. */
    .cal-armado { border:1px dashed var(--action); border-radius:var(--r-md); padding:var(--sp-3); margin:0 0 var(--sp-3); display:grid; gap:var(--sp-2); }
    .cal-armado-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; font-size:var(--fs-sm); }
    .cal-armado-why { margin:0; font-size:var(--fs-xs); color:var(--text-muted); }
    .cal-armado-row { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:var(--sp-2); align-items:center; padding:var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-sm); cursor:pointer; }
    .cal-armado-row:hover { background:var(--overlay-hover); }
    .cal-armado-row.is-off { opacity:.6; cursor:default; }
    .cal-armado-main { display:flex; flex-direction:column; min-width:0; }
    .cal-armado-actions { display:flex; justify-content:flex-end; gap:var(--sp-2); }
    .cal-bulkbar { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; padding:var(--sp-2) var(--sp-3); margin:0 0 var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--overlay-selected); font-size:var(--fs-sm); }
    .cal-bulkbar-actions { display:flex; gap:var(--sp-1); }
    .cal-bulk-list { display:grid; gap:var(--sp-2); margin:var(--sp-2) 0; max-height:20rem; overflow-y:auto; }
    .cal-bulk-row { display:grid; grid-template-columns:minmax(0, 1fr) minmax(12rem, 1.2fr); gap:var(--sp-2); align-items:center; }
    .cal-bulk-name { display:flex; flex-direction:column; min-width:0; }
    .cal-c-st { width:6.5rem; }
    .cal-c-act { width:7.5rem; }
    .cal-c-name, .cal-c-how { min-width:0; }
    .cal-benef { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:var(--sp-1); }
    .cal-concept { font-size:var(--fs-xs); color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cal-item-amt { margin-left:auto; font-weight:400; }
    .cal-overdue { color:var(--bad-fg); }
    .cal-crit-flag { color:var(--bad-fg); }
    .cal-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    /* Agrupado por proveedor: el encabezado lleva el peso; la factura va sangrada y sin repetir el nombre. */
    :host ::ng-deep .cal-oblig-table tr.cal-grp > td { background:var(--surface-2); border-top:1px solid var(--border-color); }
    :host ::ng-deep .cal-oblig-table tr.cal-grp-item > td { padding-top:var(--sp-1); padding-bottom:var(--sp-1); }
    .cal-grp-toggle { all:unset; box-sizing:border-box; cursor:pointer; display:flex; align-items:center; gap:var(--sp-2); width:100%; min-width:0; }
    .cal-grp-toggle:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cal-grp-toggle > .pi { font-size:var(--fs-xs); color:var(--text-muted); flex-shrink:0; }
    .cal-grp-text { display:flex; flex-direction:column; min-width:0; }
    /* Sucursal = centro de costo: va visible en cada grupo y factura suelta (texto, no sólo color). */
    .cal-suc { display:inline-block; font-family:var(--font-mono); font-size:var(--fs-nano); font-weight:600; color:var(--text-main); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 var(--sp-1); margin-right:var(--sp-1); }
    .cal-item-concept { padding-left:calc(var(--sp-2) + var(--fs-xs) + var(--sp-2)); font-size:var(--fs-xs); color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    /* [PGP.12] La referencia del proveedor: monoespaciada porque es un identificador que se coteja
       caracter por caracter contra un papel, y atenuada porque es el SEGUNDO dato del renglon
       -manda el folio-. Mismo tratamiento que la columna «Referencia» de /compras/obligaciones. */
    .cal-ref { font-family:var(--font-mono); font-size:var(--fs-nano); color:var(--text-muted); margin-left:var(--sp-1); }
    .cal-ref::before { content:'· '; }
    .cal-empty { text-align:center; color:var(--text-faint); padding:var(--sp-4); white-space:normal; }

    /* ── Ordenar y pagar */
    .cal-pay-state { display:flex; align-items:center; gap:var(--sp-2); }
    .cal-folio { font-family:var(--font-mono); font-size:var(--fs-xs); color:var(--text-main); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 var(--sp-1); }
    /* ── [PGP.11] El veredicto: lo PRIMERO del panel, y lo único enfatizado.
       Toma el lugar de cal-sum (4 celdas de cifras que ya subieron a la franja) y de los dos
       banners. El tono viaja en el borde izquierdo Y en el icono Y en la palabra: nunca sólo en
       color (regla #5 de DESIGN.md, y lo único que sobrevive a forced-colors). */
    .cal-verdict { border:1px solid var(--border-color); border-left:3px solid var(--border-color); border-radius:var(--r-md);
      padding:var(--sp-3); margin:0 0 var(--sp-3); display:grid; gap:var(--sp-2); background:var(--surface-2); }
    .cal-verdict.is-ok { border-left-color:var(--ok-fg); }
    .cal-verdict.is-warn { border-left-color:var(--warn-fg); }
    .cal-verdict.is-bad { border-left-color:var(--bad-fg); }
    .cal-verdict-top { display:flex; align-items:flex-start; gap:var(--sp-2); }
    .cal-verdict-top > .pi { font-size:var(--fs-body); line-height:1.5; color:var(--text-muted); flex-shrink:0; }
    .cal-verdict.is-ok .cal-verdict-top > .pi { color:var(--ok-fg); }
    .cal-verdict.is-warn .cal-verdict-top > .pi { color:var(--warn-fg); }
    .cal-verdict.is-bad .cal-verdict-top > .pi { color:var(--bad-fg); }
    .cal-verdict-say { margin:0; flex:1; min-width:0; font-size:var(--fs-sm); color:var(--text-main); }
    :host ::ng-deep .cal-verdict-btn { flex-shrink:0; }
    @container (max-width: 34rem) { .cal-verdict-top { flex-wrap:wrap; } }
    /* Los 4 pasos: la espina del circuito. El paso ACTIVO se marca con peso, no con otro color
       -el color ya lo usa el tono del veredicto y dos codificaciones encima colapsan (Q.6). */
    .cal-steps { display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-4); list-style:none; padding:0; margin:0; font-size:var(--fs-sm); color:var(--text-muted); }
    .cal-steps li { display:flex; align-items:center; gap:var(--sp-1); }
    .cal-step-n { display:inline-grid; place-items:center; width:1.25rem; height:1.25rem; border-radius:var(--r-pill); border:1px solid var(--border-color); font-size:var(--fs-nano); font-weight:700; color:var(--text-muted); }
    .cal-steps li.is-ok { color:var(--ok-fg); }
    .cal-steps li.is-ok .cal-step-n { border-color:var(--ok-fg); color:var(--ok-fg); }
    .cal-steps li.is-now { color:var(--text-main); font-weight:700; }
    .cal-steps li.is-now .cal-step-n { border-color:var(--text-main); color:var(--text-main); border-width:2px; }
    .cal-step-miss { font-size:var(--fs-xs); color:var(--warn-fg); font-weight:600; }
    .cal-order-input { width:3rem; text-align:center; }
    .cal-how-method { font-size:var(--fs-sm); }
    .cal-how-route { display:flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-xs); color:var(--text-muted); min-width:0; }
    .cal-how-route span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cal-how-route .pi { font-size:var(--fs-nano); flex-shrink:0; }
    :host ::ng-deep .cal-prep-btn { margin-top:var(--sp-1); }
    .cal-notes { font-size:var(--fs-xs); color:var(--text-faint); margin-top:var(--sp-1); }
    .cal-fail { font-size:var(--fs-xs); color:var(--bad-fg); margin-top:var(--sp-1); }
    :host ::ng-deep .cal-tag { font-size:var(--fs-nano); }
    .cal-c-act { white-space:nowrap; }
    .cal-pay-actions { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; margin-top:var(--sp-2); }
    .cal-pay-actions-l { display:flex; gap:var(--sp-1); flex-wrap:wrap; }
    .cal-auth-why { font-size:var(--fs-xs); color:var(--text-muted); }
    .cal-foot { font-size:var(--fs-xs); color:var(--text-faint); margin:var(--sp-2) 0 0; }

    .cal-dlg-p { font-size:var(--fs-sm); margin:0 0 var(--sp-2); }
    .cal-dlg-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0 0 var(--sp-2); }
    .cal-dlg-row { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); margin-bottom:var(--sp-2); font-size:var(--fs-sm); }
    .cal-dlg-name { flex:1; }
    .cal-dlg-amt { width:8rem; text-align:right; }
    .cal-dlg-full { width:100%; margin-bottom:var(--sp-2); }
    .cal-dlg-notes { width:100%; margin-right:var(--sp-2); }
    .cal-dlg-actions { display:flex; gap:var(--sp-2); align-items:center; margin-top:var(--sp-2); }
    .cal-dlg-label { display:block; font-size:var(--fs-xs); color:var(--text-muted); margin:var(--sp-2) 0 var(--sp-1); }
    :host ::ng-deep .cal-dlg-sel { width:100%; margin-bottom:var(--sp-2); }
    /* ══ [PGP.13] El lienzo: cola de dias a la izquierda, el dia abierto como hoja de trabajo ══ */
    .pg-shell { display:grid; grid-template-columns:15rem minmax(0, 1fr); gap:var(--sp-3); align-items:start; }
    @container (max-width: 68rem) { .pg-shell { grid-template-columns:minmax(0, 1fr); } }

    /* ── La cola ─────────────────────────────────────────────────────── */
    .pg-queue { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); overflow:hidden; }
    @container (min-width: 68rem) { .pg-queue { position:sticky; top:var(--sp-2); } }
    .pg-queue-h { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-1);
      padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border-color); }
    .pg-queue-h h2 { margin:0; font-size:var(--fs-xs); font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); }
    .pg-queue-nav { display:flex; gap:1px; }
    :host ::ng-deep .pg-ico.p-button { padding:var(--sp-1); min-width:auto; }
    .pg-today-dot { font-size:.5rem; color:var(--action); }
    /* [PGP.13] La leyenda: la cifra de la derecha SIEMPRE es lo libre del tope. Antes cambiaba de
       significado segun si el dia tenia pagos, y eso hacia leer el dia mas holgado como el mas
       apretado. Una columna, un significado. */
    .pg-queue-leg { display:flex; justify-content:space-between; padding:2px var(--sp-3);
      font-size:var(--fs-nano); color:var(--text-faint); border-bottom:1px solid var(--border-color); }
    .pg-day { all:unset; box-sizing:border-box; cursor:pointer; display:block; width:100%;
      padding:6px var(--sp-3); border-bottom:1px solid var(--border-color); border-left:3px solid transparent; }
    .pg-day:hover { background:var(--overlay-hover); }
    .pg-day:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    .pg-day.is-sel { background:var(--overlay-selected); border-left-color:var(--action); }
    .pg-day.is-nocap { opacity:.6; }
    .pg-day-t { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); }
    .pg-day-n { font-size:var(--fs-sm); font-weight:700; text-transform:capitalize; color:var(--text-main); }
    .pg-day.is-sel .pg-day-n { color:var(--action); }
    .pg-t { font-weight:400; color:var(--text-muted); font-size:var(--fs-xs); }
    .pg-day-amt { font-size:var(--fs-xs); font-weight:600; color:var(--text-main); }
    .pg-day-b { display:flex; align-items:center; gap:5px; font-size:var(--fs-micro, .73rem); color:var(--text-muted); line-height:1.3; flex-wrap:wrap; }
    /* El estado viaja en FORMA (punto) Y en palabra: nunca solo en color (regla #5 y forced-colors). */
    .pg-dot { width:6px; height:6px; border-radius:var(--r-pill); background:var(--text-faint); flex-shrink:0; }
    .pg-dot.is-work { background:var(--warn-fg); }
    .pg-dot.is-free { background:transparent; border:1px solid var(--border-color); }
    .pg-day-erp { display:block; font-size:var(--fs-nano); color:var(--text-faint); line-height:1.3; }
    .pg-day-erp.is-gap { color:var(--warn-fg); }
    .pg-queue-f { display:grid; gap:2px; padding:var(--sp-2) var(--sp-3); background:var(--surface-2);
      border-top:1px solid var(--border-color); font-size:var(--fs-micro, .73rem); color:var(--text-muted); }
    .pg-queue-f b { color:var(--text-main); font-weight:700; }
    .cal-ok-txt { color:var(--ok-fg); }

    /* ── El veredicto: identidad, estado, que falta, la accion y el tope, en UN bloque ── */
    .pg-lot { display:grid; gap:var(--sp-2); min-width:0; }
    .pg-vd { border:1px solid var(--border-color); border-left:4px solid var(--border-color);
      border-radius:var(--r-md); background:var(--card-bg); padding:var(--sp-3) var(--sp-4); }
    .pg-vd.is-ok { border-left-color:var(--ok-fg); }
    .pg-vd.is-warn { border-left-color:var(--warn-fg); }
    .pg-vd.is-bad { border-left-color:var(--bad-fg); }
    .pg-vd-id { display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; margin-bottom:2px; }
    .pg-vd-id h2 { margin:0; font-size:var(--fs-sm); font-weight:700; color:var(--text-muted); }
    .pg-vd-sub { font-size:var(--fs-nano); }
    .pg-pill { display:inline-flex; align-items:center; font-size:var(--fs-nano); font-weight:700;
      text-transform:uppercase; letter-spacing:.03em; padding:1px 7px; border-radius:var(--r-pill);
      border:1px solid var(--border-color); color:var(--text-muted); background:var(--surface-2); }
    .pg-vd-main { display:flex; align-items:center; gap:var(--sp-4); flex-wrap:wrap; }
    .pg-vd-txt { flex:1; min-width:15rem; }
    .pg-vd-say { margin:0; font-size:var(--fs-body); font-weight:700; line-height:1.3; color:var(--text-main); }
    .pg-vd-why { margin:1px 0 0; font-size:var(--fs-xs); color:var(--text-muted); }
    :host ::ng-deep .pg-vd-cta.p-button { flex-shrink:0; }
    .pg-cap { display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap; margin-top:var(--sp-2);
      padding-top:var(--sp-2); border-top:1px solid var(--border-color); }
    .pg-cap-say { font-size:var(--fs-xs); color:var(--text-muted); }
    .pg-cap-say b { color:var(--text-main); font-weight:700; }
    .pg-cap-bar { flex:1; min-width:8rem; display:block; height:6px; border-radius:var(--r-pill);
      background:var(--border-color); overflow:hidden; }
    .pg-cap-fill { display:block; height:100%; background:var(--action); border-radius:inherit; }
    .pg-cap-fill.is-over { background:var(--bad-fg); }

    /* ── Los pasos: la columna vertebral ─────────────────────────────── */
    .pg-steps { display:grid; gap:6px; }
    .pg-step { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); overflow:hidden; }
    .pg-step.is-now { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pg-step-h { all:unset; box-sizing:border-box; cursor:pointer; width:100%; display:flex;
      align-items:center; gap:var(--sp-3); padding:var(--sp-2) var(--sp-3); }
    .pg-step-h:hover { background:var(--overlay-hover); }
    .pg-step-h:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    .pg-sn { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:var(--r-pill);
      border:1.5px solid var(--border-color); font-family:var(--font-mono); font-size:var(--fs-xs);
      font-weight:700; color:var(--text-muted); flex-shrink:0; }
    .pg-step.is-done .pg-sn { border-color:var(--ok-fg); background:var(--ok-fg); color:var(--on-accent, #fff); }
    .pg-step.is-now .pg-sn { border-color:var(--action); background:var(--action); color:var(--on-accent, #fff); }
    .pg-step-t { flex:1; min-width:0; display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; }
    .pg-step-name { font-size:var(--fs-sm); font-weight:700; white-space:nowrap; color:var(--text-main); }
    .pg-step-who { font-size:var(--fs-nano); font-weight:600; text-transform:uppercase; letter-spacing:.04em;
      color:var(--text-muted); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 4px; }
    .pg-step-say { font-size:var(--fs-xs); color:var(--text-muted); min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .pg-step.is-done .pg-step-say { color:var(--ok-fg); }
    .pg-step.is-now .pg-step-say { color:var(--warn-fg); font-weight:600; }
    .pg-chev { color:var(--text-muted); transition:transform .15s; }
    .pg-step.is-open .pg-chev { transform:rotate(90deg); }
    .pg-step-body { padding:var(--sp-3); border-top:1px solid var(--border-color); }
    .pg-step:not(.is-open) .pg-step-body { display:none; }
    @media (prefers-reduced-motion: reduce) { .pg-chev { transition:none; } }

    .pg-why { margin:0 0 var(--sp-2); font-size:var(--fs-xs); color:var(--text-muted); }
    .pg-sub { display:block; font-size:var(--fs-xs); color:var(--text-muted); line-height:1.35; }
    .pg-stepacts { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2);
      flex-wrap:wrap; margin-top:var(--sp-2); }
    .pg-stepacts-start { justify-content:flex-start; }
    .pg-stepacts-l, .pg-stepacts-r { display:flex; gap:var(--sp-2); flex-wrap:wrap; align-items:center; }
    .pg-why-off { font-size:var(--fs-xs); color:var(--text-muted); }

    /* Paso 1: la propuesta y el cajon de la deuda */
    .pg-prop { display:grid; gap:4px; margin-bottom:var(--sp-3); padding:var(--sp-2);
      border:1px dashed var(--action); border-radius:var(--r-md); }
    .pg-prop-row { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:var(--sp-2);
      align-items:center; padding:5px var(--sp-2); border:1px solid var(--border-color);
      border-radius:var(--r-sm); cursor:pointer; background:var(--card-bg); }
    .pg-prop-row:hover { background:var(--overlay-hover); }
    .pg-prop-row.is-off { opacity:.6; cursor:default; }
    .pg-prop-main { display:flex; flex-direction:column; min-width:0; }
    .pg-prop-amt { font-weight:700; font-size:var(--fs-sm); white-space:nowrap; }
    .pg-drawer { border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; }
    .pg-drawer-h { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; padding:6px var(--sp-3);
      background:var(--surface-2); border-bottom:1px solid var(--border-color); }
    .pg-grow { flex:1; min-width:11rem; }
    .pg-drawer-n { margin:0; padding:4px var(--sp-3); font-size:var(--fs-nano); color:var(--text-muted);
      background:var(--surface-2); border-bottom:1px solid var(--border-color); }
    .pg-drawer-n b { color:var(--text-main); }
    /* [PGP.13] El grupo que NO se puede programar: se VE y no tiene boton de agregar. Un clic no
       debe poder meter al dia una factura que puede estar pagada desde Oficinas. */
    .pg-drawer-g { display:grid; gap:2px; padding:var(--sp-2) var(--sp-3); background:var(--warn-soft-bg, var(--surface-2));
      border-top:1px solid var(--border-color); border-bottom:1px solid var(--border-color);
      font-size:var(--fs-xs); font-weight:700; color:var(--warn-fg); }
    .pg-drawer-g span { font-weight:400; color:var(--text-muted); font-size:var(--fs-nano); }
    .pg-drawer-b { max-height:17rem; overflow:auto; }
    .pg-drawer-b.is-locked { max-height:9rem; background:var(--surface-2); }
    .pg-dr-row { display:grid; grid-template-columns:minmax(0, 1fr) auto auto; gap:var(--sp-2);
      align-items:center; padding:5px var(--sp-3); border-bottom:1px solid var(--border-color); }
    .pg-dr-main { display:flex; flex-direction:column; min-width:0; }
    .pg-dr-amt { margin-left:auto; font-weight:700; white-space:nowrap; }
    .pg-dr-due { font-size:var(--fs-xs); white-space:nowrap; }
    .pg-dr-no { font-size:var(--fs-nano); color:var(--text-muted); white-space:nowrap;
      border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 5px; }
    :host ::ng-deep .pg-dr-add.p-button { padding:var(--sp-1); min-width:auto; }

    /* Paso 2: preparar EN LINEA. El dialogo por pago era el cuello: 0 de 10 preparados, 6 dias. */
    .pg-applyall { display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap; padding:6px var(--sp-3);
      margin-bottom:var(--sp-2); border:1px dashed var(--action); border-radius:var(--r-md); }
    .pg-aa-lb { font-size:var(--fs-xs); font-weight:700; color:var(--action); white-space:nowrap; }
    .pg-aa-f { display:flex; align-items:center; gap:6px; min-width:10rem; flex:1; }
    .pg-aa-f > span { font-size:var(--fs-nano); color:var(--text-muted); white-space:nowrap; }
    :host ::ng-deep .pg-prep .p-datatable-table { table-layout:fixed; width:100%; }
    .pg-c-ord { width:5rem; } .pg-c-met { width:8rem; } .pg-c-ori { width:10.5rem; }
    .pg-c-des { width:12rem; } .pg-c-x { width:2.6rem; }
    .pg-c-ben { min-width:0; }
    .pg-ord { display:inline-flex; align-items:center; gap:1px; }
    .pg-ordn { min-width:1.2rem; text-align:center; font-weight:700; }
    .pg-row-wait > td { background:color-mix(in srgb, var(--warn-fg) 6%, transparent); }
    .pg-fieldnote { font-size:var(--fs-nano); color:var(--text-muted); }
    .pg-fieldnote.is-bad { color:var(--bad-fg); font-weight:600; }
    :host ::ng-deep .pg-dest.p-button { width:100%; justify-content:flex-start; font-size:var(--fs-xs); padding:4px var(--sp-2); }

    /* Pasos 3 y 4 */
    .pg-signrule, .pg-decl { display:flex; gap:var(--sp-2); padding:var(--sp-2) var(--sp-3);
      border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--surface-2);
      font-size:var(--fs-xs); color:var(--text-muted); margin-bottom:var(--sp-2); }
    .pg-signrule b, .pg-decl b { color:var(--text-main); }
    .pg-decl { border-left:3px solid var(--warn-fg); }
    .pg-signrule > .pi, .pg-decl > .pi { margin-top:2px; color:var(--text-muted); }
    .pg-decl > .pi { color:var(--warn-fg); }
    .pg-recon { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
      gap:var(--sp-2); margin-bottom:var(--sp-2); }
    .pg-rc { display:grid; gap:1px; border:1px solid var(--border-color); border-radius:var(--r-md); padding:var(--sp-2) var(--sp-3); }
    .pg-rc.is-other { border-style:dashed; }
    .pg-rc-l { font-size:var(--fs-nano); text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); font-weight:700; }
    .pg-rc-v { font-size:var(--fs-body); font-weight:700; color:var(--text-main); }
    .pg-rc-s { font-size:var(--fs-nano); color:var(--text-muted); }
    .pg-exec { display:grid; gap:4px; margin-top:var(--sp-2); }
    .pg-exec-row { display:grid; grid-template-columns:minmax(0, 1fr) auto auto auto; gap:var(--sp-2);
      align-items:center; padding:5px var(--sp-2); border:1px solid var(--border-color); border-radius:var(--r-sm); }

    /* ⛔ Angosto y telefono: el dedo pide 44px y Direccion puede autorizar desde el telefono. */
    @container (max-width: 44rem) {
      .pg-c-met, .pg-c-ori, .pg-c-des { width:auto; }
      :host ::ng-deep .pg-prep .p-datatable-table { table-layout:auto; }
      .pg-dr-row { grid-template-columns:minmax(0, 1fr) auto; }
      .pg-dr-due { grid-column:1; font-size:var(--fs-nano); }
    }
    @media (pointer: coarse) {
      :host ::ng-deep .pg-ico.p-button, :host ::ng-deep .pg-dr-add.p-button { min-height:44px; min-width:44px; }
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
  private readonly accountsBase = `${environment.apiUrl}/commercial/supplier-payment-accounts`;

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
  readonly allocations = computed<PaymentCalendarAllocation[]>(() => this.selectedDay()?.allocations ?? []);
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
  readonly weekAssigned = computed(() => this.weekDays().reduce((s, d) => s + Number(d.summary.assigned_amount), 0));
  readonly weekAvailable = computed(() => this.weekWithCap().reduce((s, d) => s + Number(d.summary.remaining_amount ?? 0), 0));
  readonly weekNoCapDays = computed(() => this.weekDays().length - this.weekWithCap().length);
  private readonly weekPending = computed(() => this.weekDays().flatMap((d) => d.allocations).filter((a) => a.status === 'pending'));
  readonly weekUnprepared = computed(() => this.weekPending().filter((a) => !isPrepared(a)).length);

  /** El paso del circuito en el que está parado el día (1 armar · 2 preparar · 3 autorizar · 4 dispersa). */
  readonly pasoActivo = computed<1 | 2 | 3 | 4>(() => {
    if (this.isReleased()) return 4;
    if (this.pendingCount() === 0) return 1;
    if (this.unrankedCount() > 0 || this.unpreparedCount() > 0) return 2;
    return 3;
  });

  // ── [PGP.13] El estado de la hoja de trabajo ────────────────────────────────────────────────
  /** Qué paso se abrió a mano. `null` = manda el paso activo, que es lo que se quiere al entrar. */
  private readonly stepManual = signal<number | null>(null);
  stepOpen(n: number): boolean {
    const m = this.stepManual();
    return m === null ? this.pasoActivo() === n : m === n;
  }
  toggleStep(n: number): void { this.stepManual.set(this.stepOpen(n) ? -1 : n); }

  readonly executedCount = computed(() => this.allocations().filter((a) => a.status === 'executed').length);
  readonly weekDaysWithWork = computed(() => this.weekDays().filter((d) => d.allocations.some((a) => a.status === 'pending' && !isPrepared(a))).length);
  usedPctRound(d: PaymentCalendarWeekDay): number { return Math.round(this.usedPct(d)); }

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
  private enRevision(o: Obligation): boolean {
    if (o.obligation_source !== 'kepler_payable') return false;
    const suc = (o.branch_code ?? '').trim();
    if (!suc || suc === '00') return false; // Oficinas no tiene el problema: es desde donde se pagó
    const f = (o.original_due_date ?? '').slice(0, 10);
    return !!f && f < this.CORTE;
  }

  /** El orden de la lista de deuda, como una sola decisión en vez de dos casillas sueltas. */
  readonly ordenOpts = [
    { label: 'Vence primero', value: 'vencimiento' },
    { label: 'Pierde descuento primero', value: 'descuento' },
  ];
  ordenSel: 'vencimiento' | 'descuento' = 'vencimiento';
  onOrden(): void { this.ordenDescuento = this.ordenSel === 'descuento'; this.loadObligations(); }

  // ── Los renglones de cada paso: lo que dice la cabecera cuando está cerrado ──────────────────
  saysPaso1(): string {
    const n = this.allocations().length;
    if (!n) return 'sin pagos armados todavia';
    const day = this.selectedDay();
    const cabe = day?.summary.capacity_defined && !day.summary.exceeded;
    return `${n} pago(s) · ${this.money(day?.summary.assigned_amount)}${cabe ? ' · cabe en el tope' : ''}`;
  }
  saysPaso2(): string {
    const pend = this.pendingCount();
    if (!pend) return 'sin pagos que preparar';
    const falta = this.unpreparedCount();
    if (falta === 0 && this.unrankedCount() === 0) return `los ${pend} listos`;
    const primero = this.primerIncompleto();
    const quien = primero ? ` · al de ${this.allocationTitle(primero)} le falta ${this.faltaDe(primero)}` : '';
    return `${pend - falta} de ${pend} listos${quien}`;
  }
  saysPaso3(): string {
    if (this.isReleased()) {
      const f = this.selectedDay()?.lot_folio;
      return f ? `autorizado · folio ${f}` : 'autorizado';
    }
    const why = this.authorizeBlocker();
    return why ? `${why} · espera el paso 2` : `${this.pendingCount()} pago(s) listos para autorizar`;
  }
  saysPaso4(): string {
    if (!this.isReleased()) return 'nada autorizado todavia · despues cuadra contra el ERP';
    const ex = this.executedCount();
    return `${ex} de ${this.allocations().length} marcados como pagados`;
  }

  /** El primer pago al que le falta algo: el que el veredicto nombra y al que lleva su botón. */
  primerIncompleto(): PaymentCalendarAllocation | null {
    return this.allocations().find((a) => a.status === 'pending' && !isPrepared(a)) ?? null;
  }
  /** Qué le falta, dicho con el nombre del campo que hay que llenar. */
  faltaDe(a: PaymentCalendarAllocation): string {
    if (!a.payment_method) return 'el metodo';
    if (a.payment_method !== 'efectivo' && !a.bank_account_id) return 'la cuenta de origen';
    if (a.payment_method === 'transferencia' && !(a.destination_account_text ?? '').trim()) return 'la cuenta destino';
    return 'un dato';
  }

  /**
   * `[PGP.11]` **El veredicto: qué falta, dicho en una frase, con el botón que lo destraba.**
   *
   * Antes el bloqueo se decía en cuatro lugares —la franja, la tarjeta del día, los pasos y el
   * texto junto a «Autorizar día»— y el botón que lo resolvía («Preparar») estaba al final de cada
   * fila de la tabla, lo último del recorrido. Cuatro avisos y ninguna salida es el defecto que
   * `§Q.4` nombra: *el número denuncia y no lleva a arreglarlo*.
   */
  readonly verdict = computed<{ tone: 'ok' | 'warn' | 'bad' | 'muted'; icon: string; say: string; why: string | null; action: VerdictAction | null }>(() => {
    const day = this.selectedDay();
    if (!day) return { tone: 'muted', icon: 'pi-calendar', say: 'Elegí un día en la cola de la izquierda.', why: null, action: null };
    const s = day.summary;

    if (this.isReleased()) {
      const ex = this.executedCount(); const n = this.allocations().length;
      return { tone: 'ok', icon: 'pi-lock',
        say: ex === n ? 'El día está cerrado: todos sus pagos se marcaron.' : `Autorizado. Caja General dispersa y marca cada pago.`,
        why: `${ex} de ${n} marcados como pagados. Se marca pago por pago: uno puede rebotar y los demás no.`,
        action: day.lot_folio ? { kind: 'caja', label: 'Instrucción a Caja General', icon: 'pi-print' } : null };
    }
    if (!s.capacity_defined) {
      return { tone: 'warn', icon: 'pi-exclamation-triangle',
        say: 'Presupuestos no fijó el tope de este día.',
        why: 'Se pueden armar pagos, pero el día no se autoriza hasta que lo fije.', action: null };
    }
    if (s.exceeded) {
      return { tone: 'bad', icon: 'pi-ban',
        say: `Lo comprometido excede el tope del día por ${this.money(Math.abs(Number(s.remaining_amount ?? 0)))}.`,
        why: 'Reprogramá o cancelá pagos, o pedí a Presupuestos ampliarlo.', action: null };
    }
    if (this.pendingCount() === 0) {
      return { tone: 'muted', icon: 'pi-inbox',
        say: 'Este día no tiene pagos armados.',
        why: 'La propuesta toma lo vencido hasta donde alcance el tope; también podés agregar facturas desde el paso 1.',
        action: { kind: 'armar', label: 'Sugerir armado', icon: 'pi-sparkles' } };
    }
    if (this.unpreparedCount() > 0) {
      /*
       * `[PGP.13]` **El veredicto NOMBRA el renglón.** Decía «falta 1 por preparar» sin decir
       * cuál, y su botón abría un paso que ya estaba abierto: el número denunciaba y no llevaba
       * a arreglarlo (`DESIGN.md` §Q.3 se señala la fila · §Q.4 el dato lleva al arreglo).
       */
      const a = this.primerIncompleto()!;
      const n = this.unpreparedCount();
      return { tone: 'warn', icon: 'pi-credit-card',
        say: n === 1 ? `Falta ${this.faltaDe(a)} de 1 pago para poder autorizar el día.`
                     : `Faltan ${n} de ${this.pendingCount()} pagos por preparar.`,
        why: `${this.allocationTitle(a)} · ${this.money(a.amount_assigned)} — le falta ${this.faltaDe(a)}.`,
        action: { kind: 'preparar', label: n === 1 ? 'Completar ese pago' : `Preparar los ${n}`, icon: 'pi-credit-card' } };
    }
    if (this.unrankedCount() > 0) {
      return { tone: 'warn', icon: 'pi-sort-amount-down',
        say: `Faltan ${this.unrankedCount()} de ${this.pendingCount()} pagos por ordenar.`,
        why: 'Caja General dispersa en ese turno, así que sin orden el día no se autoriza.',
        action: { kind: 'ordenar', label: 'Proponer orden', icon: 'pi-sort-amount-down' } };
    }
    if (this.canAuthorize()) {
      return { tone: 'ok', icon: 'pi-check-circle',
        say: `Listo para autorizar: ${this.pendingCount()} pago(s) por ${this.money(s.assigned_amount)}.`,
        why: 'Autorizás el día completo. Después Caja General dispersa con la instrucción impresa.',
        action: { kind: 'autorizar', label: 'Autorizar el día', icon: 'pi-lock' } };
    }
    return { tone: 'ok', icon: 'pi-check-circle',
      say: `Los ${this.pendingCount()} pagos están ordenados y preparados.`,
      why: 'Falta que Gerencia o Dirección autorice el día.', action: null };
  });
  /** Lo que impide autorizar, dicho en una frase; null si se puede. */
  readonly authorizeBlocker = computed<string | null>(() => {
    const day = this.selectedDay();
    if (!day) return null;
    if (!day.summary.capacity_defined) return 'Falta el presupuesto del día';
    if (day.summary.exceeded) return 'Excede el presupuesto del día';
    if (this.pendingCount() === 0) return 'No hay pagos pendientes';
    if (this.unrankedCount() > 0) return `Faltan ${this.unrankedCount()} por ordenar`;
    if (this.unpreparedCount() > 0) return `Faltan ${this.unpreparedCount()} por preparar`;
    return null;
  });
  readonly weekLabel = computed(() => {
    const w = this.week();
    if (!w) return '—';
    return `${this.fmt(w.from, { day: 'numeric', month: 'short' })} – ${this.fmt(w.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  });
  /** Días de la semana visible como destino de un pago nuevo (con su disponible, para decidir ahí). */
  readonly dayOpts = computed(() => (this.week()?.days ?? []).map((d) => ({
    value: d.date,
    label: `${this.dayLong(d.date)} · ${d.summary.capacity_defined ? 'disponible ' + this.money(d.summary.remaining_amount) : 'sin capacidad'}`,
  })));

  classificationFilter: string | null = null;
  search = '';
  onlyCritical = false;
  /** `[TP.20.4]` Filtra a lo que pierde descuento en 5 días o menos. */
  soloPorVencer = false;
  /** [PGP.7] Lee la misma lista por urgencia de descuento en vez de por fecha de pago. */
  ordenDescuento = false;

  obligations = signal<Obligation[]>([]);
  /** Proveedores plegados (por clave de grupo). */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** `[TP.16.2]` Agrupadas por proveedor (regla y orden en `calendario-pagos-grupos.ts`). */
  readonly obligationGroups = computed(() => agruparObligaciones(this.obligations()));
  readonly obligationRows = computed(() => {
    const plegados = this.collapsed();
    return filasAgrupadas(this.obligationGroups(), plegados);
  });
  loadingObligations = signal(false);
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
  selected = signal<Obligation[]>([]);

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
  paymentMethodHint = 'Tesorería ordena y prepara (método, cuenta de origen y destino); Gerencia o Dirección autoriza el día; Caja General dispersa con la instrucción impresa. Ejecutar no vuelve a liberar capacidad; un pago fallido regresa su saldo (reprograma o cancela).';

  /** Día al que va un pago nuevo (agregar sola / agrupar). */
  targetDate = this.todayIso;

  groupDialogVisible = false;
  groupAmounts: Record<string, number> = {};
  newNotes = '';

  quickAddVisible = false;
  quickAddTarget = signal<Obligation | null>(null);
  quickAddAmount = 0;

  prepareVisible = false;
  prepAllocation: PaymentCalendarAllocation | null = null;
  prepMethod: string | null = null;
  prepDestination = '';
  prepReference = '';
  prepCash = '';
  prepAccountId: string | null = null;
  prepOriginId: string | null = null;
  prepSupplierId: string | null = null;
  prepAccounts = signal<{ id: string; label: string }[]>([]);
  /** Un 403/500 del catálogo NO es «el proveedor no tiene cuentas»: se dice distinto. */
  readonly prepAccountsError = signal<string | null>(null);
  readonly originOpts = signal<{ id: string; label: string }[]>([]);

  reprogramVisible = false;
  reprogramAllocation: PaymentCalendarAllocation | null = null;
  reprogramDate = this.todayIso;
  reprogramReason: ReprogramReason | null = null;
  reprogramReasonDetail = '';

  ngOnInit(): void {
    this.reload();
    this.http.get<PaymentOriginAccount[]>(`${this.base}/origin-accounts`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => this.originOpts.set(rows.map((r) => ({ id: r.id, label: r.alias ? `${r.alias} (${r.bank})` : `${r.bank} ${r.account_label}` }))),
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
  dayShort(iso: string): string { return this.fmt(iso, { weekday: 'short', day: 'numeric' }); }
  dayLong(iso: string): string { return this.fmt(iso, { weekday: 'long', day: 'numeric', month: 'short' }); }
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
  isOverdue(iso: string | null): boolean { return !!iso && iso.slice(0, 10) < this.todayIso; }

  /** `[TP.21.2]` Un dia ya pasado. Solo ahi un libro vacio dice algo: hacia adelante no hay nada que registrar. */
  isPast(iso: string): boolean { return iso < this.todayIso; }

  shiftWeek(delta: number): void {
    this.armado.set(null); this.bulkSel.set(new Set());
    this.selectedDate.set(this.addDays(this.selectedDate(), delta * 7));
    this.reload();
  }
  goToday(): void { this.armado.set(null); this.bulkSel.set(new Set()); this.selectedDate.set(this.todayIso); this.reload(); }

  openDay(date: string): void {
    if (date !== this.selectedDate()) { this.armado.set(null); this.bulkSel.set(new Set()); }
    this.selectedDate.set(date);
    this.targetDate = date;
    // El panel queda al lado de la lista; sólo en angosto (una columna) cae abajo y hace falta llevar
    // la vista hasta él. Sin animación: respeta movimiento reducido.
    setTimeout(() => {
      const el = this.payPanel?.nativeElement;
      if (el && el.getBoundingClientRect().top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start' });
    });
  }

  reload(): void {
    this.clearSelection();
    this.loadWeek();
    this.loadObligations();
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
        if (!w.days.some((d) => d.date === this.targetDate)) this.targetDate = this.selectedDate();
      },
      error: (e) => { if (seq !== this.weekSeq) return; this.loadingWeek.set(false); this.weekError.set(e?.error?.message || 'No se pudo cargar la semana de pagos.'); },
    });
  }

  loadObligations(): void {
    this.loadingObligations.set(true);
    const p = new URLSearchParams();
    if (this.classificationFilter) p.set('classification', this.classificationFilter);
    if (this.search.trim()) p.set('search', this.search.trim());
    if (this.onlyCritical) p.set('onlyCritical', 'true');
    if (this.soloPorVencer) p.set('prontoPago', 'por_vencer');
    if (this.ordenDescuento) p.set('orden', 'descuento');
    this.http.get<ObligationPage>(`${this.base}/obligations?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.obligations.set(r.rows); this.obligationsTotal.set(r.total); this.loadingObligations.set(false); },
      error: () => { this.loadingObligations.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las obligaciones.' }); },
    });
  }

  // ── Ayudantes de la franja de la semana ────────────────────────────────
  usedPct(d: PaymentCalendarWeekDay): number {
    const cap = Number(d.summary.authorized_amount ?? 0);
    return cap > 0 ? Math.min(100, (Number(d.summary.assigned_amount) / cap) * 100) : 0;
  }
  dayUnprepared(d: PaymentCalendarWeekDay): number { return d.allocations.filter((a) => a.status === 'pending' && !isPrepared(a)).length; }
  dayAria(d: PaymentCalendarWeekDay): string {
    const s = d.summary;
    const cap = s.capacity_defined ? `disponible ${this.money(s.remaining_amount)} de ${this.money(s.authorized_amount)}` : 'sin presupuesto';
    return `${this.dayLong(d.date)}: ${cap}, ${d.allocations.length} pago(s)`;
  }
  lotTone(s: string): 'ok' | 'info' | 'muted' { return s === 'released' || s === 'executing' ? 'ok' : s === 'closed' ? 'muted' : 'info'; }
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
  statusLabel(s: string): string { return STATUS_LABEL[s] || s; }
  statusSeverity(s: string) { return STATUS_SEVERITY[s] || 'secondary'; }
  lotLabel(s: string): string { return LOT_LABEL[s] || s; }
  lotSeverity(s: string): 'success' | 'info' | 'secondary' | 'warn' { return s === 'released' || s === 'executing' ? 'success' : s === 'closed' ? 'secondary' : 'info'; }
  methodLabel(m: string): string { return METHOD_LABEL[m] || m; }
  money(n: number | string | null | undefined): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }); }
  /**
   * `[PGP.7]` La tasa observada, en %. Llega como fracción (`0.0741` = 7.41 %) y los `numeric`
   * de Postgres viajan como **string** por JSON, así que `Number()` antes de formatear.
   */
  pct(n: number | string | null | undefined): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'percent', maximumFractionDigits: 2 });
  }
  allocationTitle(a: PaymentCalendarAllocation): string {
    const first = a.items[0]?.beneficiary ?? '—';
    return a.items.length > 1 ? `${first} +${a.items.length - 1}` : first;
  }
  destinationOf(a: PaymentCalendarAllocation): string {
    if (a.payment_method === 'efectivo') return a.cash_register_text || '—';
    if (a.payment_method === 'cheque') return a.reference_text ? `Cheque ${a.reference_text}` : '—';
    return a.destination_account_text || '—';
  }

  // ── Pago agrupado: lo arma «Pagar juntas» de un proveedor (sin selección a mano, TP.16.3) ──
  clearSelection(): void { this.selected.set([]); }

  // ── Agrupado por proveedor ────────────────────────────────────────────
  isCollapsed(key: string): boolean { return this.collapsed().has(key); }
  toggleGroup(key: string): void {
    const next = new Set(this.collapsed());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.collapsed.set(next);
  }
  /** «Pagar juntas»: selecciona TODAS las facturas del proveedor y abre el diálogo de un solo pago. */
  payGroup(key: string): void {
    const g = this.obligationGroups().find((x) => x.key === key);
    if (!g) return;
    this.selected.set([...g.items]);
    this.openGroupDialog();
  }

  openGroupDialog(): void {
    this.groupAmounts = {};
    for (const o of this.selected()) this.groupAmounts[o.obligation_id] = Number(o.available_amount);
    this.newNotes = '';
    this.targetDate = this.selectedDate();
    this.groupDialogVisible = true;
  }
  async confirmGroupAdd(): Promise<void> {
    const pick = this.selected().map((o) => ({ o, amount: Number(this.groupAmounts[o.obligation_id]) }));
    this.saving.set(true);
    try {
      const how = await this.assign(this.targetDate, pick, this.newNotes || undefined);
      this.groupDialogVisible = false; this.clearSelection();
      this.toast.add({ severity: 'success', summary: 'Agregado', detail: `${this.dayLong(this.targetDate)}: ${how}.` });
    } catch (e) {
      this.toast.add({ severity: 'error', summary: 'Error', detail: this.errMsg(e, 'No se pudo asignar.') });
    } finally { this.saving.set(false); this.reload(); }
  }

  /**
   * `[TP.16.4]` El único camino para poner facturas en un día. Regla de Francisco: mismo proveedor
   * + misma sucursal = UN pago (una transferencia, un centro de costo). Si ese día ya hay un pago
   * pendiente y sin autorizar de ese proveedor y sucursal, las facturas SE SUMAN a ese pago; si no,
   * nace uno nuevo. Todas las facturas de una llamada comparten llave (un grupo de la lista).
   * El backend vuelve a validar beneficiario y sucursal (`paymentGroupKey`).
   */
  private async assign(date: string, pick: { o: Obligation; amount: number }[], notes?: string): Promise<string> {
    if (!pick.length) return 'nada que agregar';
    const k = obligationKey(pick[0].o);
    const day = this.week()?.days.find((d) => d.date === date);
    const open = day && !['released', 'executing', 'closed'].includes(day.summary.lot_status ?? '')
      ? day.allocations.find((a) => a.status === 'pending' && a.folio == null && allocationKey(a) === k)
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
      return `se ${pick.length === 1 ? 'sumó 1 factura' : `sumaron ${pick.length} facturas`} al pago de ${pick[0].o.beneficiary} · ${this.branchLabel(pick[0].o.branch_code)}`;
    }
    await firstValueFrom(this.http.post(`${this.base}/allocations`, {
      date, notes, items: pick.map((p) => ({ obligation_source: p.o.obligation_source, obligation_id: p.o.obligation_id, applied_amount: p.amount })),
    }));
    return `pago nuevo de ${pick[0].o.beneficiary} · ${this.branchLabel(pick[0].o.branch_code)}`;
  }
  // ── Sugerir armado (TP.16.4) ───────────────────────────────────────────
  readonly armado = signal<ArmadoGrupo<Obligation>[] | null>(null);
  readonly armadoOn = signal<ReadonlySet<string>>(new Set());
  readonly armadoChosen = computed(() => (this.armado() ?? []).filter((g) => this.armadoOn().has(g.key)));
  readonly armadoTotal = computed(() => this.armadoChosen().reduce((s, g) => s + g.total, 0));
  /**
   * Arma con la lista COMPLETA de obligaciones, no con la filtrada en pantalla: con el filtro «Gasto»
   * o una búsqueda puesta, el armado dejaba fuera facturas vencidas sin avisar (revisión independiente).
   */
  async openArmado(): Promise<void> {
    const day = this.selectedDay();
    if (!day) return;
    try {
      // [TP.17.2] Techo alto a proposito: el armado PROPONE que pagar, y con la primera pagina
      // propondria sobre las 1,000 mas viejas en vez de sobre toda la deuda.
      const page = await firstValueFrom(this.http.get<ObligationPage>(`${this.base}/obligations?limit=5000`));
      const all = page.rows;
      const groups = sugerirArmado(all, day.date, Number(day.summary.remaining_amount ?? 0));
      this.armado.set(groups);
      this.armadoOn.set(new Set(groups.filter((g) => g.fits).map((g) => g.key)));
    } catch (e) {
      this.toast.add({ severity: 'error', summary: 'Error', detail: this.errMsg(e, 'No se pudieron leer las obligaciones para armar el día.') });
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
    // Uno por uno y releyendo la semana entre grupos: si el día ya tenía un pago de ese proveedor y
    // sucursal, `assign` lo encuentra y SUMA; el siguiente grupo ve el estado nuevo.
    for (const g of chosen) {
      try { await this.assign(day.date, g.items.map((o) => ({ o, amount: Number(o.available_amount) }))); ok++; }
      catch (e) { fails.push(`${g.beneficiary} · ${this.branchLabel(g.branch)}: ${this.errMsg(e, 'error')}`); }
      await this.refreshWeek();
    }
    this.saving.set(false);
    this.armado.set(null);
    this.loadObligations();
    if (ok) this.toast.add({ severity: 'success', summary: 'Armado aplicado', detail: `${ok} pago(s) en el ${this.dayLong(day.date)}.` });
    if (fails.length) this.toast.add({ severity: 'error', summary: `${fails.length} no se aplicaron`, detail: fails.join(' · '), life: 10000 });
  }
  /** Relee la semana y espera la respuesta (para encadenar asignaciones con el estado real). */
  private async refreshWeek(): Promise<void> {
    try { this.week.set(await firstValueFrom(this.http.get<PaymentCalendarWeek>(`${this.base}/weeks/${this.selectedDate()}`))); } catch { /* la recarga normal lo declara */ }
  }

  // ── Preparar varios a la vez (TP.16.4: «el check queda en Preparar») ────────
  readonly emptySet: ReadonlySet<string> = new Set();
  readonly bulkSel = signal<ReadonlySet<string>>(new Set());
  readonly bulkRows = computed(() => this.allocations().filter((a) => this.bulkSel().has(a.id)));
  bulkVisible = false;
  bulkMethod: string | null = null;
  bulkOriginId: string | null = null;
  bulkCash = '';
  bulkDest: Record<string, string> = {};
  toggleBulk(id: string): void {
    const next = new Set(this.bulkSel());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.bulkSel.set(next);
  }
  /**
   * `[PGP.11]` **La acción del veredicto.** Cada rama reusa el camino que ya existía —no hay un
   * segundo modo de ordenar ni de preparar—; lo que agrega es que la acción esté donde se lee el
   * bloqueo, y no al final de cada fila de la tabla.
   */
  runVerdict(kind: VerdictActionKind): void {
    switch (kind) {
      case 'armar': this.stepManual.set(1); this.openArmado(); break;
      case 'ordenar': this.stepManual.set(2); this.suggestOrder(); break;
      case 'preparar': this.prepararFaltantes(); break;
      case 'autorizar': this.releaseLot(); break;
      case 'caja': this.printCajaGeneral(); break;
    }
  }

  /**
   * `[PGP.13]` **Ordenar con TECLADO, no sólo arrastrando.** Era un campo numérico suelto: quien
   * no usa mouse no podía ordenar, y el orden decide el turno en que Caja General dispersa.
   * Mueve el pago una posición y reescribe los turnos de los dos que se cruzan.
   */
  moverPago(a: PaymentCalendarAllocation, delta: 1 | -1): void {
    const lista = this.allocations();
    const i = lista.findIndex((x) => x.id === a.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= lista.length) return;
    const otro = lista[j];
    const mio = a.priority_rank ?? i + 1;
    const suyo = otro.priority_rank ?? j + 1;
    this.saving.set(true);
    Promise.all([
      firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/orden`, { priority_rank: suyo })),
      firstValueFrom(this.http.post(`${this.base}/allocations/${otro.id}/orden`, { priority_rank: mio })),
    ]).then(() => this.loadWeek())
      .catch((e) => this.toast.add({ severity: 'error', summary: 'No se pudo reordenar', detail: String(e?.error?.message ?? e?.message ?? e) }))
      .finally(() => this.saving.set(false));
  }

  /** `[PGP.13]` Preparar EN LÍNEA: el método se guarda al elegirlo, sin abrir un diálogo. */
  setMetodo(a: PaymentCalendarAllocation, metodo: string | null): void {
    if (!metodo || metodo === a.payment_method) return;
    this.guardarPreparacion(a, { payment_method: metodo });
  }
  /** `[PGP.13]` La cuenta de ORIGEN, igual: un clic y queda. */
  setOrigen(a: PaymentCalendarAllocation, id: string | null): void {
    if (!id || id === a.bank_account_id) return;
    this.guardarPreparacion(a, { payment_method: a.payment_method, bank_account_id: id });
  }
  /**
   * `[PGP.13]` Método y cuenta de origen a TODOS los pendientes de una sola vez. El destino no:
   * es de cada proveedor, y aplicarlo en lote es justo como se paga a la cuenta equivocada.
   */
  aplicarATodos(): void {
    const filas = this.allocations().filter((a) => a.status === 'pending');
    if (!filas.length || !this.bulkMethod) return;
    this.saving.set(true);
    Promise.all(filas.map((a) => firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/preparar`,
      this.cuerpoPreparar(a, { payment_method: this.bulkMethod, bank_account_id: this.bulkMethod === 'efectivo' ? null : this.bulkOriginId })))))
      .then(() => { this.toast.add({ severity: 'success', summary: `Se aplicó a ${filas.length} pago(s)` }); this.loadWeek(); })
      .catch((e) => this.toast.add({ severity: 'error', summary: 'No se pudo aplicar', detail: e?.error?.message || 'Revisa el método y la cuenta de origen.' }))
      .finally(() => this.saving.set(false));
  }
  private guardarPreparacion(a: PaymentCalendarAllocation, cambio: Partial<Record<string, unknown>>): void {
    this.saving.set(true);
    firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/preparar`, this.cuerpoPreparar(a, cambio)))
      .then(() => this.loadWeek())
      .catch((e) => this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'No se pudo preparar.' }))
      .finally(() => this.saving.set(false));
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
  /**
   * Selecciona los pagos SIN preparar del día y abre el diálogo de a varios. Es el atajo que
   * faltaba: preparar de a uno obligaba a abrir, llenar y cerrar un diálogo por pago, y el método
   * y la cuenta de origen casi siempre son los mismos (el destino sigue siendo de cada proveedor).
   */
  prepararFaltantes(): void {
    const a = this.primerIncompleto();
    if (!a) return;
    // [PGP.13] Lleva al paso donde se arregla y abre el campo que falta. Antes seleccionaba todo y
    // abria un dialogo de lote: el boton del veredicto apuntaba a un paso que ya estaba abierto.
    this.stepManual.set(2);
    if (!a.payment_method || (a.payment_method !== 'efectivo' && !a.bank_account_id)) {
      this.payPanel?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    this.openPrepare(a);
  }
  /** Desde una tarjeta de la franja al panel donde se trabaja (regla Q.4: el número lleva a su arreglo). */
  irAlTrabajo(_key: string): void {
    this.payPanel?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  openBulkPrepare(): void {
    const rows = this.bulkRows();
    this.bulkMethod = rows[0]?.payment_method ?? null;
    this.bulkOriginId = rows[0]?.bank_account_id ?? null;
    this.bulkCash = '';
    this.fillBulkDest();
    this.bulkVisible = true;
  }
  /**
   * El campo de cada pago se llena según el método ELEGIDO AHORA, no el que el pago tenía: si no,
   * un folio de cheque viajaba como cuenta destino de una transferencia (y pasaba, porque no tiene
   * 17-19 dígitos). Se rellena de nuevo cada vez que cambia el método.
   */
  fillBulkDest(): void {
    const m = this.bulkMethod;
    this.bulkDest = {};
    for (const r of this.bulkRows()) {
      const same = r.payment_method === m;
      this.bulkDest[r.id] = !same ? ''
        : m === 'cheque' ? r.reference_text ?? ''
        : r.supplier_payment_account_id ? '' : r.destination_account_text ?? '';
    }
  }
  async confirmBulkPrepare(): Promise<void> {
    if (!this.bulkMethod) return;
    const m = this.bulkMethod;
    this.saving.set(true);
    let ok = 0;
    const fails: string[] = [];
    for (const r of this.bulkRows()) {
      const dest = (this.bulkDest[r.id] ?? '').trim();
      // Una cuenta del catálogo ya elegida se conserva si el usuario no tecleó otro destino.
      const keepCatalog = !dest && !!r.supplier_payment_account_id && (m === 'transferencia' || m === 'cargo_automatico');
      try {
        await firstValueFrom(this.http.post(`${this.base}/allocations/${r.id}/preparar`, {
          payment_method: m,
          bank_account_id: m !== 'efectivo' ? this.bulkOriginId || undefined : undefined,
          destination_account_text: (m === 'transferencia' || m === 'cargo_automatico') && !keepCatalog ? dest || undefined : undefined,
          supplier_payment_account_id: keepCatalog ? r.supplier_payment_account_id : undefined,
          reference_text: m === 'cheque' ? dest || undefined : undefined,
          cash_register_text: m === 'efectivo' ? this.bulkCash || undefined : undefined,
        }));
        ok++;
      } catch (e) { fails.push(`${this.allocationTitle(r)}: ${this.errMsg(e, 'error')}`); }
    }
    this.saving.set(false);
    this.bulkVisible = false;
    this.bulkSel.set(new Set());
    this.loadWeek();
    if (ok) this.toast.add({ severity: 'success', summary: 'Preparados', detail: `${ok} pago(s) con método y cuentas.` });
    if (fails.length) this.toast.add({ severity: 'error', summary: `${fails.length} sin preparar`, detail: fails.join(' · '), life: 10000 });
  }

  private errMsg(e: unknown, fallback: string): string {
    const m = (e as { error?: { message?: string | string[] } })?.error?.message;
    return (Array.isArray(m) ? m.join(' ') : m) || (e instanceof Error && !('error' in e) ? e.message : '') || fallback;
  }

  // ── Agregar sola ──────────────────────────────────────────────────────
  quickAdd(o: Obligation): void {
    this.quickAddTarget.set(o);
    this.quickAddAmount = Number(o.available_amount);
    this.targetDate = this.selectedDate();
    this.quickAddVisible = true;
  }
  async confirmQuickAdd(): Promise<void> {
    const o = this.quickAddTarget();
    if (!o) return;
    this.saving.set(true);
    try {
      const how = await this.assign(this.targetDate, [{ o, amount: Number(this.quickAddAmount) }]);
      this.quickAddVisible = false;
      this.toast.add({ severity: 'success', summary: 'Agregado', detail: `${this.dayLong(this.targetDate)}: ${how}.` });
    } catch (e) {
      this.toast.add({ severity: 'error', summary: 'Error', detail: this.errMsg(e, 'No se pudo asignar.') });
    } finally { this.saving.set(false); this.reload(); }
  }

  // ── Preparar (origen + destino: lo que pide el layout) ─────────────────
  openPrepare(a: PaymentCalendarAllocation): void {
    this.prepAllocation = a; this.prepMethod = a.payment_method; this.prepDestination = a.supplier_payment_account_id ? '' : (a.destination_account_text || '');
    this.prepReference = a.reference_text || ''; this.prepCash = a.cash_register_text || ''; this.prepAccountId = a.supplier_payment_account_id;
    this.prepOriginId = a.bank_account_id;
    this.prepAccounts.set([]);
    this.prepAccountsError.set(null);
    this.prepSupplierId = a.classification === 'proveedor_mercancia' ? a.items.find((i) => i.supplier_id)?.supplier_id ?? null : null;
    if (this.prepSupplierId) {
      this.http.get<PaymentAccount[]>(`${this.accountsBase}/by-supplier/${this.prepSupplierId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => {
          this.prepAccounts.set(rows.map((r) => ({ id: r.id, label: `${r.bank_name}${r.clabe ? ' · ' + r.clabe : ''}${r.alias ? ' (' + r.alias + ')' : ''}${r.es_favorita ? ' ★' : ''}` })));
          // La favorita se propone sola; el usuario puede cambiarla.
          if (!this.prepAccountId && !this.prepDestination) this.prepAccountId = rows.find((r) => r.es_favorita)?.id ?? null;
        },
        error: (e) => { this.prepAccounts.set([]); this.prepAccountsError.set(e?.status === 403 ? 'sin permiso de Compras' : 'error del servidor'); },
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
  setPriorityRank(a: PaymentCalendarAllocation, ev: Event): void {
    const value = Number((ev.target as HTMLInputElement).value);
    if (!(value > 0)) return;
    this.http.post(`${this.base}/allocations/${a.id}/orden`, { priority_rank: value }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.loadWeek(),
      error: (e) => { this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cambiar el orden.' }); this.loadWeek(); },
    });
  }

  // ── Reprogramar (con motivo — TP.10) ───────────────────────────────────
  openReprogram(a: PaymentCalendarAllocation): void {
    this.reprogramAllocation = a; this.reprogramDate = this.selectedDate(); this.reprogramReason = null; this.reprogramReasonDetail = '';
    this.reprogramVisible = true;
  }
  confirmReprogram(): void {
    if (!this.reprogramAllocation || !this.reprogramReason) { this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'Selecciona por qué se reprograma.' }); return; }
    if (this.reprogramReason === 'otro' && !this.reprogramReasonDetail.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el detalle', detail: 'Describe el motivo "otro".' }); return; }
    this.saving.set(true);
    this.http.post(`${this.base}/allocations/${this.reprogramAllocation.id}/reprogramar`, {
      date: this.reprogramDate, reason: this.reprogramReason, reason_detail: this.reprogramReasonDetail || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.reprogramVisible = false; this.reload(); this.toast.add({ severity: 'success', summary: 'Reprogramado', detail: 'El pago se movió de fecha.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo reprogramar.' }); },
    });
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
  printCajaGeneral(): void { this.openPdf(`${this.base}/days/${this.selectedDate()}/caja-general.pdf`); }

  // ── Ejecutar / cancelar ───────────────────────────────────────────────
  execute(a: PaymentCalendarAllocation): void {
    this.http.post(`${this.base}/allocations/${a.id}/ejecutar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reload(); this.toast.add({ severity: 'success', summary: 'Ejecutado', detail: 'Pago marcado como ejecutado.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo ejecutar.' }),
    });
  }
  cancelAllocation(a: PaymentCalendarAllocation): void {
    this.http.post(`${this.base}/allocations/${a.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reload(); this.toast.add({ severity: 'info', summary: 'Cancelado', detail: 'El pago se canceló.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cancelar.' }),
    });
  }

  releaseLot(): void {
    this.http.post(`${this.base}/days/${this.selectedDate()}/liberar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.reload(); this.toast.add({ severity: 'success', summary: 'Autorizado', detail: 'El día quedó autorizado: Caja General ya puede imprimir su instrucción y dispersar.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo autorizar.' }),
    });
  }
}
