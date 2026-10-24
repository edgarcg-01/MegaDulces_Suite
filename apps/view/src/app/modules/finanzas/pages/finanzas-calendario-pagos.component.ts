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
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { agruparObligaciones, allocationKey, filasAgrupadas, obligationKey, sugerirArmado, vencimiento, type ArmadoGrupo } from './calendario-pagos-grupos';
import { firstValueFrom } from 'rxjs';
import { PagosTabsComponent } from '../pagos-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';

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
  imports: [PagosTabsComponent, CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, TagModule, MessageModule, CheckboxModule, ToastModule, TooltipModule, MetricStripComponent, LoadStateComponent, EntityInspectorComponent, ContextHelpComponent],
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
          <h1>Calendario de pagos <app-context-help topic="calendario-de-pagos" /></h1>
          <p class="surf-page-sub">Elige el día arriba, agrégale obligaciones desde la izquierda y ordénalo y prepáralo a la derecha. Incluye el descuento por pronto pago de cada factura.</p>
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

      @if (week()) { <app-metric-strip [items]="weekKpis()" density="compact" ariaLabel="Resumen de la semana" /> }

      <!-- ── La semana: una franja compacta; el día se elige aquí ─────────── -->
      <app-load-state [loading]="loadingWeek() && !week()" [error]="weekError()" [skeletonRows]="2" (retry)="loadWeek()">
        <div class="cal-week" role="group" aria-label="Días de la semana">
          @for (d of week()?.days ?? []; track d.date) {
            <button type="button" class="cal-day" [class.is-selected]="d.date === selectedDate()" [class.is-today]="d.date === todayIso"
                    [class.is-empty]="!d.summary.capacity_defined && !d.allocations.length"
                    [attr.aria-pressed]="d.date === selectedDate()" [attr.aria-label]="dayAria(d)" (click)="openDay(d.date)">
              <span class="cal-day-head">
                <span class="cal-day-name">{{ dayShort(d.date) }}@if (d.date === todayIso) { <span class="cal-today"> · hoy</span> }</span>
                @if (d.summary.lot_status) { <span [class]="'cal-day-lot is-' + lotTone(d.summary.lot_status)">{{ lotLabel(d.summary.lot_status) }}</span> }
              </span>
              @if (d.summary.capacity_defined) {
                <span class="cal-day-avail comm-num" [class.cal-neg]="(d.summary.remaining_amount ?? 0) < 0">{{ moneyShort(d.summary.remaining_amount) }}</span>
                <span class="cal-day-cap">disponible de {{ moneyShort(d.summary.authorized_amount) }}</span>
                <span class="cal-bar" aria-hidden="true"><span class="cal-bar-fill" [class.is-over]="d.summary.exceeded" [style.width.%]="usedPct(d)"></span></span>
              } @else {
                <span class="cal-day-nocap">Sin presupuesto</span>
              }
              <span class="cal-day-foot">
                @if (d.allocations.length) {
                  {{ d.allocations.length }} pago(s) · <span class="comm-num">{{ moneyShort(d.summary.assigned_amount) }}</span>
                  @if (dayUnprepared(d) > 0) { <span class="cal-warn-txt"> · {{ dayUnprepared(d) }} sin preparar</span> }
                } @else { <span class="cal-muted">Sin pagos</span> }
              </span>
              <!-- [PGP.9] LA COSTURA, ahora contra el ERP. Antes la traia el Excel de Tesoreria y
                   eso obligaba a que alguien lo cargara: llevaba 77 dias sin hacerlo, asi que la
                   pantalla decia "libro sin cargar" todos los dias. El ERP es el mismo hecho -que
                   dinero salio ese dia- y llega solo. Sigue siendo OTRO universo: suma por fecha,
                   no casa renglones (casar por monto+mes es lo de PP.4). -->
              @if (d.libro; as lb) {
                @if (lb.n > 0) {
                  <span class="cal-day-libro" [title]="'Segun el ERP salieron ' + money(lb.monto) + ' en ' + lb.n + ' pago(s) — ver el about'">
                    <i class="pi pi-building-columns" aria-hidden="true"></i> salió: <span class="comm-num">{{ moneyShort(lb.monto) }}</span> · {{ lb.n }}
                  </span>
                } @else if (isPast(d.date) && !lb.data_as_of) {
                  <!-- ⛔ Un cero SIN fecha de corte no se puede leer: no se sabe si no se pago o si
                       el espejo no se recalculo. Se declara en vez de pintar el cero (ADR-056). -->
                  <span class="cal-day-libro is-gap" title="El espejo del ERP no trae fecha de corte: no se puede saber si ese dia no hubo pagos — ver el about">
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> sin medir
                  </span>
                }
              }
            </button>
          }
        </div>
      </app-load-state>

      <div class="cal-work">
        <!-- ── Obligaciones disponibles ─────────────────────────────────── -->
        <section class="cal-panel cal-oblig" aria-label="Obligaciones disponibles">
          <div class="cal-panel-head">
            <!-- [TP.17.2] Cuando el techo recorta, el contador dice "N de M": un "1,000 facturas"
                 a secas sobre 2,931 es el numero que miente, no el que falta. -->
            <h2>Obligaciones disponibles <span class="cal-count">@if (obligationsTruncated()) { {{ obligations().length | number }} de {{ obligationsTotal() | number }} } @else { {{ obligations().length | number }} }{{ obligations().length === 1 && !obligationsTruncated() ? ' factura' : ' facturas' }} · {{ obligationGroups().length | number }} {{ obligationGroups().length === 1 ? 'proveedor' : 'proveedores' }}</span></h2>
          </div>
          <!-- [TP.17.2] El techo se DECLARA (ADR-056). Medido el 2026-10-16: con la deuda derivada
               el corte de 1,000 dejaba fuera 1,895 documentos por $105,683,725 -el 79% del dinero-
               y, como la lista va por vencimiento, lo oculto era lo MAS RECIENTE. -->
          @if (obligationsTruncated()) {
            <p-message severity="info" class="cal-techo">
              <span>
                Se muestran las <b>{{ obligations().length | number }}</b> más próximas a vencer, de
                <b>{{ obligationsTotal() | number }}</b>. Las demás no faltan por error: usá la búsqueda
                o el filtro de tipo para llegar a cualquiera.
              </span>
            </p-message>
          }
          <div class="cal-filters">
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadObligations()" placeholder="Buscar beneficiario o factura…" class="p-inputtext-sm cal-search" aria-label="Buscar beneficiario o factura" />
            <p-select [options]="classificationOpts" [(ngModel)]="classificationFilter" (onChange)="loadObligations()" optionLabel="label" optionValue="value" placeholder="Tipo" [showClear]="true" styleClass="cal-sel p-inputtext-sm" />
            <label class="cal-check"><p-checkbox [(ngModel)]="onlyCritical" [binary]="true" (onChange)="loadObligations()" />Críticos</label>
            <!-- [TP.20.4] Armar el dia mirando lo que CADUCA, sin salir a otra pantalla. -->
            <label class="cal-check" title="Solo facturas cuyo descuento por pronto pago vence en 5 dias o menos"><p-checkbox [(ngModel)]="soloPorVencer" [binary]="true" (onChange)="loadObligations()" />Descuento por vencer</label>
            <!-- [PGP.7] El orden de Pronto pago, aqui. El inventario de TP §23 midio que las dos
                 listas ordenan al reves y concluyo que fusionarlas rompia una; lo que rompia era
                 imponer UN orden. Ofrecer los dos no rompe ninguno: por omision manda la fecha de
                 pago, y quien persigue el descuento lee por fecha limite del privilegio. -->
            <label class="cal-check" title="Ordena por la fecha limite del descuento y, a igualdad, por lo que se gana"><p-checkbox [(ngModel)]="ordenDescuento" [binary]="true" (onChange)="loadObligations()" />Ordenar por descuento</label>
          </div>
          <p-table [value]="obligationRows()" [loading]="loadingObligations()" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm surf-table cal-table cal-oblig-table">
            <ng-template #header>
              <tr>
                <th class="cal-c-name">Proveedor / factura</th>
                <th class="cal-c-due">Vence</th>
                <th class="comm-num cal-c-amt">Disponible</th>
                <th class="cal-c-add"><span class="sr-only">Agregar</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              @if (r.kind === 'group') {
                <!-- Proveedor con varias facturas: plegar, total y pagar todas juntas en un solo pago. -->
                <tr class="cal-grp" [class.cal-row-critical]="r.critical">
                  <td class="cal-c-name">
                    <button type="button" class="cal-grp-toggle" [attr.aria-expanded]="!isCollapsed(r.key)" (click)="toggleGroup(r.key)">
                      <span class="pi" [class.pi-chevron-right]="isCollapsed(r.key)" [class.pi-chevron-down]="!isCollapsed(r.key)" aria-hidden="true"></span>
                      <span class="cal-grp-text">
                        <span class="cal-benef" [title]="r.beneficiary">@if (r.critical) { <i class="pi pi-flag cal-crit-flag" aria-label="Crítico"></i> }{{ r.beneficiary }}</span>
                        <span class="cal-concept"><span class="cal-suc">{{ branchLabel(r.branch) }}</span> {{ r.count }} facturas · {{ classLabel(r.classification) }}</span>
                      </span>
                    </button>
                  </td>
                  <td class="cal-c-due cal-mono" [class.cal-overdue]="isOverdue(r.firstDue)">{{ shortDate(r.firstDue) }}</td>
                  <td class="comm-num cal-c-amt is-strong">{{ money(r.total) }}</td>
                  <td class="cal-c-add">
                    <button pButton type="button" class="p-button-sm p-button-text" [attr.aria-label]="'Pagar juntas las ' + r.count + ' facturas de ' + r.beneficiary" pTooltip="Pagar juntas en un solo pago" tooltipPosition="left" (click)="payGroup(r.key)"><span class="pi pi-clone" aria-hidden="true"></span></button>
                  </td>
                </tr>
              } @else if (r.kind === 'item') {
                <tr class="cal-grp-item" [class.cal-row-critical]="r.o.is_critical">
                  <td class="cal-c-name">
                    <!-- [TP.20.5] La factura abre su FICHA: deuda + ventana + lo programado +
                         el pago que la liquido + su comprobante, sin salir de aqui. -->
                    @if (r.o.entity_ref) {
                      <button type="button" class="cal-item-concept cal-reflink" [title]="'Ver la ficha completa de ' + r.o.concept"
                              (click)="inspect.set(r.o.entity_ref!)">{{ r.o.concept }}</button>
                    } @else {
                      <div class="cal-item-concept" [title]="r.o.concept">{{ r.o.concept }}</div>
                    }
                    <!-- [TP.20.4] La urgencia del DESCUENTO, aqui y no en una columna nueva: esta
                         tabla es un panel estrecho de cuatro columnas y tres mas la romperian.
                         Solo aparece cuando hay algo que ganar; lo demas no dice nada. -->
                    @if (r.o.pronto_beneficio && (r.o.pronto_estado === 'por_vencer' || r.o.pronto_estado === 'capturable')) {
                      <!-- [PGP.7] La definicion ya NO vive en este title: un title solo existe
                           para quien tiene mouse. Esta en el diccionario, abierta desde el about
                           del encabezado. Lo que queda aqui es una pista, no la definicion. -->
                      <span class="cal-pp" [class.cal-pp-urge]="r.o.pronto_estado === 'por_vencer'"
                            [title]="'Descuento estimado — ver el about de la pantalla'">
                        <i class="pi" [class.pi-bolt]="r.o.pronto_estado === 'por_vencer'" [class.pi-tag]="r.o.pronto_estado === 'capturable'" aria-hidden="true"></i>
                        ahorra {{ money(r.o.pronto_beneficio) }}@if (r.o.pronto_tasa) { <span class="cal-muted"> ({{ pct(r.o.pronto_tasa) }})</span> }
                        @if (r.o.pronto_fecha_limite) { <span class="cal-muted">· antes del {{ shortDate(r.o.pronto_fecha_limite) }}</span> }
                      </span>
                    }
                  </td>
                  <td class="cal-c-due cal-mono" [class.cal-overdue]="isOverdue(vence(r.o))">{{ shortDate(vence(r.o)) }}@if (r.o.negotiated_date) { <span class="cal-muted" aria-label="fecha renegociada">*</span> }</td>
                  <td class="comm-num cal-c-amt">{{ money(r.o.available_amount) }}</td>
                  <td class="cal-c-add"><button pButton type="button" class="p-button-sm p-button-text" [attr.aria-label]="'Agregar ' + r.o.concept + ' a un día'" (click)="quickAdd(r.o)"><span class="pi pi-plus" aria-hidden="true"></span></button></td>
                </tr>
              } @else {
                <!-- Proveedor con una sola factura: un renglón. -->
                <tr [class.cal-row-critical]="r.critical">
                  <td class="cal-c-name">
                    <div class="cal-benef" [title]="r.o.beneficiary">@if (r.critical) { <i class="pi pi-flag cal-crit-flag" aria-label="Crítico"></i> }{{ r.o.beneficiary }}</div>
                    <div class="cal-concept" [title]="r.o.concept"><span class="cal-suc">{{ branchLabel(r.o.branch_code) }}</span>
                      @if (r.o.entity_ref) {
                        <button type="button" class="cal-reflink" [title]="'Ver la ficha completa de ' + r.o.concept"
                                (click)="inspect.set(r.o.entity_ref!)">{{ r.o.concept }}</button>
                      } @else { {{ r.o.concept }} }
                    </div>
                  </td>
                  <td class="cal-c-due cal-mono" [class.cal-overdue]="isOverdue(vence(r.o))">{{ shortDate(vence(r.o)) }}@if (r.o.negotiated_date) { <span class="cal-muted" aria-label="fecha renegociada">*</span> }</td>
                  <td class="comm-num cal-c-amt">{{ money(r.o.available_amount) }}</td>
                  <td class="cal-c-add"><button pButton type="button" class="p-button-sm p-button-text" [attr.aria-label]="'Agregar ' + r.o.beneficiary + ' a un día'" (click)="quickAdd(r.o)"><span class="pi pi-plus" aria-hidden="true"></span></button></td>
                </tr>
              }
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="4" class="cal-empty">Sin obligaciones disponibles con estos filtros. Las facturas de proveedor llegan aquí cuando Finanzas acepta una entrega en <a routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">Entregas de Compras</a>, por el saldo que tienen pendiente en Kepler.</td></tr></ng-template>
          </p-table>
        </section>

        <!-- ── Ordenar y pagar: el día elegido ──────────────────────────────── -->
        <section class="cal-panel cal-pay" #payPanel aria-label="Ordenar y pagar">
          @if (selectedDay(); as day) {
            <div class="cal-panel-head">
              <h2>Ordenar y pagar · <span class="cal-cap">{{ dayLong(day.date) }}</span></h2>
              <span class="cal-pay-state">
                @if (!isReleased() && day.summary.capacity_defined) {
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="openArmado()" [disabled]="saving()"><span class="pi pi-sparkles" aria-hidden="true"></span>&nbsp;Sugerir armado</button>
                }
                @if (day.summary.lot_status) { <p-tag [value]="lotLabel(day.summary.lot_status)" [severity]="lotSeverity(day.summary.lot_status)" styleClass="cal-tag" /> }
                @if (day.lot_folio) { <span class="cal-folio">Folio {{ day.lot_folio }}</span> }
              </span>
            </div>
            <dl class="cal-sum">
              <div><dt>Presupuesto</dt><dd class="comm-num">@if (day.summary.capacity_defined) { {{ money(day.summary.authorized_amount) }} } @else { <span class="cal-warn-txt">sin definir</span> }</dd></div>
              <div><dt>Comprometido</dt><dd class="comm-num">{{ money(day.summary.assigned_amount) }}</dd></div>
              <div><dt>Disponible</dt><dd class="comm-num is-strong" [class.cal-neg]="(day.summary.remaining_amount ?? 0) < 0">@if (day.summary.capacity_defined) { {{ money(day.summary.remaining_amount) }} } @else { — }</dd></div>
              <div><dt>Ejecutado</dt><dd class="comm-num">{{ money(day.summary.executed_amount) }}</dd></div>
            </dl>
            @if (!day.summary.capacity_defined) {
              <div class="cal-banner cal-banner-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Presupuestos no fijó capacidad para este día: no se puede autorizar hasta que la fije.</div>
            } @else if (day.summary.exceeded) {
              <div class="cal-banner cal-banner-danger"><i class="pi pi-ban" aria-hidden="true"></i> Lo comprometido excede el presupuesto del día. Reprograma o cancela pagos, o pide a Presupuestos ampliarlo.</div>
            }

            @if (pendingCount() > 0 || isReleased()) {
              <ol class="cal-steps" aria-label="Pasos para que Caja General disperse">
                <li [class.is-ok]="unrankedCount() === 0"><span class="cal-step-n">1</span>Ordenar @if (unrankedCount() > 0) { <span class="cal-step-miss">faltan {{ unrankedCount() }}</span> } @else { <i class="pi pi-check" aria-label="listo"></i> }</li>
                <li [class.is-ok]="unpreparedCount() === 0"><span class="cal-step-n">2</span>Preparar @if (unpreparedCount() > 0) { <span class="cal-step-miss">faltan {{ unpreparedCount() }}</span> } @else { <i class="pi pi-check" aria-label="listo"></i> }</li>
                <li [class.is-ok]="isReleased()"><span class="cal-step-n">3</span>Autorizar <span class="cal-muted">(Gerencia/Dirección)</span> @if (isReleased()) { <i class="pi pi-check" aria-label="listo"></i> }</li>
                <li><span class="cal-step-n">4</span>Caja General dispersa</li>
              </ol>
            }

            <!-- [TP.16.4] Armado sugerido: lo vencido, un pago por proveedor y sucursal, hasta el disponible. -->
            @if (armado(); as arm) {
              <div class="cal-armado" role="region" aria-label="Armado sugerido">
                <div class="cal-armado-head">
                  <strong>Armado sugerido · {{ armadoChosen().length }} pago(s) · <span class="comm-num">{{ money(armadoTotal()) }}</span></strong>
                  <span class="cal-muted">de {{ money(day.summary.remaining_amount) }} disponibles</span>
                </div>
                <p class="cal-armado-why">Toma lo vencido o que vence este día, un pago por proveedor y sucursal, primero lo más viejo, hasta el disponible. Lo que vence después se queda en la lista.</p>
                @for (g of arm; track g.key; let i = $index) {
                  <label class="cal-armado-row" [class.is-off]="!g.fits">
                    <p-checkbox [binary]="true" [ngModel]="armadoOn().has(g.key)" (onChange)="toggleArmado(g.key)" [disabled]="!g.fits" [ariaLabel]="'Incluir ' + g.beneficiary + ' ' + branchLabel(g.branch)" />
                    <span class="cal-armado-main">
                      <span class="cal-benef">{{ i + 1 }}. {{ g.beneficiary }} <span class="cal-suc">{{ branchLabel(g.branch) }}</span></span>
                      <span class="cal-concept">{{ g.items.length }} factura(s) · la más vieja venció el {{ shortDate(g.oldest) }}@if (!g.fits) { · <span class="cal-neg">no cabe en el disponible</span> }</span>
                    </span>
                    <span class="comm-num is-strong">{{ money(g.total) }}</span>
                  </label>
                } @empty {
                  <p class="cal-muted">No hay facturas vencidas ni que venzan este día.</p>
                }
                <div class="cal-armado-actions">
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="saving()" (click)="armado.set(null)">Descartar</button>
                  <button pButton type="button" class="p-button-sm" [disabled]="!armadoChosen().length" [loading]="saving()" (click)="applyArmado()">Aplicar armado</button>
                </div>
              </div>
            }

            @if (bulkRows().length > 0) {
              <div class="cal-bulkbar">
                <span>{{ bulkRows().length }} pago(s) seleccionado(s)</span>
                <span class="cal-bulkbar-actions">
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="bulkSel.set(emptySet)">Limpiar</button>
                  <button pButton type="button" class="p-button-sm" (click)="openBulkPrepare()"><span class="pi pi-credit-card" aria-hidden="true"></span>&nbsp;Preparar seleccionados</button>
                </span>
              </div>
            }

            <p-table [value]="allocations()" [scrollable]="true" styleClass="p-datatable-sm surf-table surf-table--plain cal-table cal-pay-table">
              <ng-template #header>
                <tr>
                  <th class="cal-c-chk"><span class="sr-only">Seleccionar para preparar</span></th>
                  <th class="cal-c-ord">Orden</th><th>Beneficiario</th><th>Cómo se paga</th>
                  <th class="comm-num">Importe</th><th class="cal-c-st">Estado</th><th class="cal-c-act"><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-a>
                <tr>
                  <td class="cal-c-chk">
                    @if (a.status === 'pending' && !isReleased()) {
                      <p-checkbox [binary]="true" [ngModel]="bulkSel().has(a.id)" (onChange)="toggleBulk(a.id)" [ariaLabel]="'Seleccionar para preparar el pago de ' + allocationTitle(a)" />
                    }
                  </td>
                  <td class="cal-c-ord">
                    @if (a.status === 'pending' && a.folio == null) {
                      <input pInputText type="number" min="1" [ngModel]="a.priority_rank" (change)="setPriorityRank(a, $event)" class="p-inputtext-sm cal-order-input" placeholder="#" aria-label="Orden de pago" />
                    } @else {
                      <span class="cal-mono">{{ a.folio || a.priority_rank || '—' }}</span>
                    }
                  </td>
                  <td class="cal-c-name">
                    @for (it of a.items; track it.id) {
                      <div class="cal-benef" [title]="it.beneficiary">{{ it.beneficiary }}@if (a.items.length > 1) { <span class="comm-num cal-item-amt">{{ money(it.applied_amount) }}</span> }</div>
                      <div class="cal-concept" [title]="it.concept">{{ it.concept }}</div>
                    }
                    @if (a.notes) { <div class="cal-notes">{{ a.notes }}</div> }
                    @if (a.status === 'failed' && a.failure_reason) { <div class="cal-fail">Falló: {{ a.failure_reason }}</div> }
                  </td>
                  <td class="cal-c-how">
                    @if (a.payment_method) {
                      <div class="cal-how-method">{{ methodLabel(a.payment_method) }}@if (a.status === 'pending' && !prepared(a)) { <span class="cal-warn-txt"> · incompleto</span> }</div>
                      <div class="cal-how-route">
                        <span>{{ a.bank_account_label || (a.payment_method === 'efectivo' ? 'Caja' : 'sin origen') }}</span>
                        <i class="pi pi-arrow-right" aria-label="a"></i>
                        <span>{{ destinationOf(a) }}</span>
                      </div>
                    }
                    @if (a.status === 'pending') {
                      <button pButton type="button" class="p-button-sm cal-prep-btn" [class.p-button-outlined]="prepared(a)" [class.p-button-text]="prepared(a)" (click)="openPrepare(a)">
                        <span class="pi pi-credit-card" aria-hidden="true"></span>&nbsp;{{ prepared(a) ? 'Cambiar' : 'Preparar' }}
                      </button>
                    }
                  </td>
                  <td class="comm-num is-strong">{{ money(a.amount_assigned) }}</td>
                  <td class="cal-c-st"><p-tag [value]="statusLabel(a.status)" [severity]="statusSeverity(a.status)" styleClass="cal-tag" /></td>
                  <td class="cal-c-act">
                    @if (a.status === 'pending') {
                      <button pButton type="button" class="p-button-sm p-button-text" aria-label="Mover a otro día" pTooltip="Mover a otro día" tooltipPosition="top" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span></button>
                      <button pButton type="button" class="p-button-sm p-button-text" [disabled]="!prepared(a) || !isReleased()" aria-label="Marcar como pagado" pTooltip="Marcar como pagado" tooltipPosition="top" (click)="execute(a)"><span class="pi pi-check" aria-hidden="true"></span></button>
                      <button pButton type="button" class="p-button-sm p-button-text p-button-danger" aria-label="Quitar del día" pTooltip="Quitar del día" tooltipPosition="top" (click)="cancelAllocation(a)"><span class="pi pi-times" aria-hidden="true"></span></button>
                    }
                    @if (a.status === 'failed') {
                      <button pButton type="button" class="p-button-sm p-button-text" aria-label="Reprogramar con motivo" pTooltip="Reprogramar con motivo" tooltipPosition="top" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span></button>
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7" class="cal-empty">Sin pagos este día. Usa «Sugerir armado» o agrega obligaciones desde la izquierda con <i class="pi pi-plus" aria-label="el botón más"></i>.</td></tr></ng-template>
            </p-table>

            @if (allocations().length > 0) {
              <div class="cal-pay-actions">
                <span class="cal-pay-actions-l">
                  @if (!isReleased()) { <button pButton type="button" class="p-button-sm p-button-text" (click)="suggestOrder()"><span class="pi pi-sort-amount-down" aria-hidden="true"></span>&nbsp;Proponer orden</button> }
                  <button pButton type="button" class="p-button-sm p-button-text" [loading]="printing()" (click)="printPreliminar()"><span class="pi pi-file-pdf" aria-hidden="true"></span>&nbsp;Preliminar</button>
                  @if (day.lot_folio) { <button pButton type="button" class="p-button-sm p-button-text" [loading]="printing()" (click)="printCajaGeneral()"><span class="pi pi-print" aria-hidden="true"></span>&nbsp;Instrucción a Caja General</button> }
                </span>
                @if (canAuthorize() && !isReleased()) {
                  <span class="cal-auth">
                    @if (authorizeBlocker(); as why) { <span class="cal-auth-why">{{ why }}</span> }
                    <button pButton type="button" class="p-button-sm" [disabled]="!!authorizeBlocker()" (click)="releaseLot()"><span class="pi pi-lock" aria-hidden="true"></span>&nbsp;Autorizar día</button>
                  </span>
                }
              </div>
            }
            <p class="cal-foot">{{ paymentMethodHint }}</p>
          }
        </section>
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

    /* ── Franja de la semana: los 7 días caben en una fila; fin de semana sin presupuesto se atenúa. */
    .cal-week { display:grid; grid-template-columns:repeat(7, minmax(7.5rem, 1fr)); gap:var(--sp-2); overflow-x:auto; padding:2px; }
    .cal-day { all:unset; box-sizing:border-box; cursor:pointer; display:flex; flex-direction:column; gap:var(--sp-1); padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
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
    .cal-day-avail { font-size:var(--fs-lg); font-weight:600; color:var(--text-main); line-height:1.2; }
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
    .cal-empty { text-align:center; color:var(--text-faint); padding:var(--sp-4); white-space:normal; }

    /* ── Ordenar y pagar */
    .cal-pay-state { display:flex; align-items:center; gap:var(--sp-2); }
    .cal-folio { font-family:var(--font-mono); font-size:var(--fs-xs); color:var(--text-main); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 var(--sp-1); }
    .cal-sum { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:var(--sp-3); margin:0 0 var(--sp-2); padding:var(--sp-2) 0; border-top:1px solid var(--border-color); border-bottom:1px solid var(--border-color); }
    .cal-sum dt { font-size:var(--fs-xs); color:var(--text-muted); }
    .cal-sum dd { margin:0; font-size:var(--fs-body); text-align:left; }
    .cal-banner { display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-2) var(--sp-3); margin:0 0 var(--sp-2); border-radius:var(--r-md); font-size:var(--fs-sm); }
    .cal-banner-warn { background:var(--warn-soft-bg); color:var(--warn-soft-fg); border:1px solid var(--warn-border); }
    .cal-banner-danger { background:var(--bad-soft-bg); color:var(--bad-soft-fg); border:1px solid var(--bad-border); }
    .cal-steps { display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-4); list-style:none; padding:0; margin:0 0 var(--sp-2); font-size:var(--fs-sm); color:var(--text-muted); }
    .cal-steps li { display:flex; align-items:center; gap:var(--sp-1); }
    .cal-step-n { display:inline-grid; place-items:center; width:1.25rem; height:1.25rem; border-radius:var(--r-pill); border:1px solid var(--border-color); font-size:var(--fs-nano); font-weight:700; color:var(--text-muted); }
    .cal-steps li.is-ok { color:var(--ok-fg); }
    .cal-steps li.is-ok .cal-step-n { border-color:var(--ok-fg); color:var(--ok-fg); }
    .cal-step-miss { font-size:var(--fs-xs); color:var(--warn-fg); }
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
    .cal-auth { display:flex; align-items:center; gap:var(--sp-2); }
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
  readonly weekKpis = computed<MetricStripItem[]>(() => {
    const days = this.week()?.days ?? [];
    const withCap = days.filter((d) => d.summary.capacity_defined);
    const budget = withCap.reduce((s, d) => s + Number(d.summary.authorized_amount ?? 0), 0);
    const assigned = days.reduce((s, d) => s + Number(d.summary.assigned_amount), 0);
    const available = withCap.reduce((s, d) => s + Number(d.summary.remaining_amount ?? 0), 0);
    const pending = days.flatMap((d) => d.allocations).filter((a) => a.status === 'pending');
    const unprepared = pending.filter((a) => !isPrepared(a)).length;
    const missing = days.length - withCap.length;
    return [
      { label: 'Presupuesto de la semana', value: budget, format: 'currency-short', tone: 'default', sub: missing ? `${missing} día(s) sin presupuesto` : undefined },
      { label: 'Comprometido', value: assigned, format: 'currency-short', tone: 'default' },
      { label: 'Disponible', value: available, format: 'currency-short', tone: available < 0 ? 'bad' : 'default' },
      { label: 'Pagos por preparar', value: unprepared, format: 'number', tone: unprepared > 0 ? 'warn' : 'default', sub: pending.length ? `de ${pending.length} pendiente(s)` : 'sin pagos pendientes' },
    ];
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
  shortDate(iso: string | null): string { return iso ? this.fmt(iso.slice(0, 10), { day: 'numeric', month: 'short' }) : '—'; }
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
  branchLabel(b: string | null | undefined): string { return b ? `Suc. ${b}` : 'Sin sucursal'; }
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
