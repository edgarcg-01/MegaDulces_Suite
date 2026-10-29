import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, ViewChild, inject, signal, computed, effect, untracked } from '@angular/core';
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
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import type {
  PaymentCalendarAllocation, PaymentCalendarDaySummary, PaymentCalendarWeek, PaymentCalendarWeekDay,
  PayableEvidenceRow, PaymentObligationSource, PaymentOriginAccount,
} from '@megadulces/contracts';
import { warehouseName } from '@megadulces/contracts';
import type { SupplierCreditRow, SupplierPaymentHabit, SupplierUnappliedCreditRow } from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { agruparObligaciones, allocationKey, fechaCorta, obligationKey, sugerirArmado, vencimiento, type ArmadoGrupo, type ObligationGroup } from './calendario-pagos-grupos';
import { firstValueFrom } from 'rxjs';
import { PagosTabsComponent } from '../pagos-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';

/**
 * `[PGP.11]` La única acción que el veredicto ofrece: la que destraba el paso en el que el día
 * está parado. Es una unión cerrada a propósito — `runVerdict()` tiene que seguir siendo
 * exhaustiva, y agregar un paso sin su acción tiene que romper la compilación, no pasar de largo.
 */
type VerdictActionKind = 'armar' | 'proponer' | 'ordenar' | 'autorizar' | 'pagar' | 'cerrar' | 'rebote';
interface VerdictAction { kind: VerdictActionKind; label: string; icon: string }
/** `[PGP.15]` El veredicto: «bien» y «falta» no llevan tono (lo dice la frase); sólo lo que está mal. */
interface Verdict { tone: 'ok' | 'bad' | 'muted'; say: string; why: string | null; action: VerdictAction | null }
/** `[PGP.15]` Una etapa del día en la línea de avance: siempre visible, sin clic. */
interface Etapa { n: number; nombre: string; quien: string | null; dice: string; estado: 'hecho' | 'ahora' | 'pendiente' }
/** `[PGP.15]` Lo último que esta persona eligió en «Para los N pagos» (sólo una comodidad por navegador). */
const PREF_PREPARAR = 'pgp.preparar.ultimo';
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
 * prepara, Gerencia/Dirección autoriza, Caja General dispersa.
 */
@Component({
  selector: 'app-finanzas-calendario-pagos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PagosTabsComponent, CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, InputTextModule, SelectModule, DialogModule, CheckboxModule, ToastModule, TooltipModule, LoadStateComponent, EntityInspectorComponent, ContextHelpComponent, SidePeekComponent, MetricStripComponent],
  providers: [MessageService],
  template: `
    <!-- [TP.20.3] Las cuatro pantallas de Pagos son un ciclo, no cuatro reportes sueltos. -->
    <app-pagos-tabs />
    <div class="surf-page in cal-page">
      <app-entity-inspector [(ref)]="inspect" />
      <p-toast></p-toast>
      <!-- [PGP.15] Cuatro principios del PM (2026-10-26): la menor interaccion humana, el menor color
           posible, todo visible en todo momento y todo total desglosable.
           [PGP.15] Y UNA PANTALLA (Edgar: «que todo entre en la pantalla con la menor cantidad de
           scroll»). Medido a 1442×902: la pagina media 1,914 px dentro de un panel de 814 -casi 2.5
           pantallas-; la cola de dias ocupaba una columna de 520 px de alto para 7 renglones. Ahora:
           los dias en UNA tira arriba, el veredicto compacto, y dos paneles que llenan lo que queda
           -a la izquierda agregar facturas, a la derecha los pagos del dia-, cada uno con su
           desplazamiento propio. El titulo «Pagos» repetia la pestaña: queda para lectores de pantalla. -->
      <h1 class="sr-only">Pagos</h1>

      <!-- ── LOS DIAS POR PAGAR: una tira, no una columna ─────────────────── -->
      <nav class="pg-top" aria-label="Días por pagar">
        <div class="pg-week">
          <span class="pg-week-nav">
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-ico" (click)="shiftWeek(-1)" aria-label="Semana anterior"><span class="pi pi-angle-left" aria-hidden="true"></span></button>
            <span class="pg-queue-wk comm-num" aria-live="polite">{{ weekLabel() }}</span>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-ico" (click)="shiftWeek(1)" aria-label="Semana siguiente"><span class="pi pi-angle-right" aria-hidden="true"></span></button>
            <!-- [PGP.15] «Hoy» con su palabra: era un punto naranja, el unico color de la cola que no decia nada. -->
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-hoy" [disabled]="selectedDate() === todayIso" (click)="goToday()">Hoy</button>
            <app-context-help topic="calendario-de-pagos" />
          </span>
          <!-- [PGP.14] Sin semana cargada no hay resumen: un cero dibujado donde no hubo medicion (ADR-056). -->
          @if (week()) {
            <span class="pg-week-f"><b class="comm-num">{{ moneyShort(weekAvailable()) }}</b> libres de <b class="comm-num">{{ moneyShort(weekBudget()) }}</b> esta semana@if (weekUnprepared() > 0) { · <b>{{ weekUnprepared() }}</b> sin preparar }@if (weekNoCapDays() > 0) { · {{ dias(weekNoCapDays()) }} sin tope }</span>
          }
        </div>
        <app-load-state class="pg-days-ls" [loading]="loadingWeek() && !week()" [error]="weekError()" [skeletonRows]="1" (retry)="loadWeek()">
          <div class="pg-days">
            @for (d of week()?.days ?? []; track d.date) {
              <!-- [PGP.13] La cifra de cada dia SIEMPRE es lo libre del tope, y lo dice. -->
              <button type="button" class="pg-day"
                      [class.is-sel]="d.date === selectedDate()" [class.is-nocap]="!d.summary.capacity_defined"
                      [attr.aria-current]="d.date === selectedDate() ? 'true' : null"
                      [attr.aria-label]="dayAria(d)" (click)="openDay(d.date)">
                <span class="pg-day-t">
                  <span class="pg-day-n">{{ dayShort(d.date) }}@if (d.date === todayIso) { <span class="pg-t"> · hoy</span> }</span>
                  <span class="pg-day-amt comm-num" [class.cal-neg]="(d.summary.remaining_amount ?? 0) < 0">
                    @if (d.summary.capacity_defined) { {{ moneyShort(d.summary.remaining_amount) }}<span class="pg-day-l"> libre</span> } @else { sin tope }
                  </span>
                </span>
                <span class="pg-day-b">
                  @if (d.allocations.length) {
                    <i class="pg-dot is-work" aria-hidden="true"></i>{{ pagos(d.allocations.length) }}
                    <!-- [PGP.19] El color dice el estado, siempre con su palabra: ámbar = falta algo que
                         destraba el día, verde = listo o hecho, rojo = algo está mal. -->
                    @if (dayFailed(d) > 0) { · <b class="cal-bad-txt">{{ dayFailed(d) === 1 ? '1 rebotó' : dayFailed(d) + ' rebotaron' }}</b> }
                    @else if (dayUnprepared(d) > 0) { · <b class="cal-warn-txt">faltan {{ dayUnprepared(d) }}</b> }
                    @else if (d.summary.lot_status === 'closed') { · <b class="cal-ok-txt">cerrado</b> }
                    @else if (d.summary.lot_status === 'released' || d.summary.lot_status === 'executing') { · <b class="cal-ok-txt">autorizado</b> }
                    @else { · <b class="cal-ok-txt">listos</b> }
                  } @else if (d.summary.capacity_defined) {
                    <i class="pg-dot is-free" aria-hidden="true"></i> sin pagos
                  } @else {
                    <i class="pg-dot" aria-hidden="true"></i> —
                  }
                </span>
              </button>
            }
          </div>
        </app-load-state>
      </nav>

      <!-- ── EL DIA ABIERTO ──────────────────────────────────────────── -->
      <main class="pg-lot" #payPanel>
          @if (selectedDay(); as day) {

            <!-- EL VEREDICTO: que pasa, que sigue, el boton que lo hace, el tope y el avance. UN bloque.
                 [PGP.15] Compacto (Edgar: «me sigue necesitando mucho espacio»): medía ~160 px. El día ya
                 está marcado en la tira de arriba (queda como encabezado para lectores de pantalla); el
                 estado del lote va al final del motivo; el tope es UNA línea de texto con su barra, y el
                 avance va en el mismo renglón, cada paso en una línea («quién» al pasar el mouse). -->
            <div class="pg-vd" [class.is-bad]="verdict().tone === 'bad'">
              <h2 class="sr-only">{{ dayLong(day.date) }}@if (day.date === todayIso) { · hoy }</h2>
              <div class="pg-vd-main" role="status" aria-live="polite">
                <div class="pg-vd-txt">
                  <p class="pg-vd-say">@if (verdict().tone === 'bad') { <i class="pi pi-times-circle pg-vd-ico" aria-hidden="true"></i> }{{ verdict().say }}</p>
                  <p class="pg-vd-why">
                    @if (verdict().why) { <span [innerText]="verdict().why!"></span> }
                    @if (day.summary.lot_status) { <span class="pg-pill">{{ lotLabel(day.summary.lot_status) }}</span> }
                    @if (day.lot_folio) { <span class="pg-vd-sub comm-num">folio {{ day.lot_folio }}</span> }
                  </p>
                </div>
                @if (verdict().action; as act) {
                  <button pButton type="button" class="pg-vd-cta" [disabled]="saving()" [loading]="saving()" (click)="runVerdict(act.kind)">
                    <span class="pi" [ngClass]="act.icon" aria-hidden="true"></span>&nbsp;{{ act.label }}
                  </button>
                }
              </div>
              <div class="pg-vd-row2">
              <div class="pg-cap">
                @if (day.summary.capacity_defined) {
                  <!-- [PGP.15] La tira de métricas compartida (Q.1; no se reimplementa, §5.4), compacta y con
                       las cifras a tamaño de texto: a 20 px ocupaba dos renglones del veredicto. instant: sin
                       el conteo de 0 al monto (publicaba «4,410.38» de un día con ,850,235.43). -->
                  <app-metric-strip class="pg-cap-ms" [items]="capKpis(day)" ariaLabel="El tope del día" density="compact" [instant]="true" />
                  <span class="pg-cap-bar" role="img" [attr.aria-label]="usedPctRound(day) + ' por ciento del tope del día comprometido'">
                    <span class="pg-cap-fill" [class.is-over]="day.summary.exceeded" [style.width.%]="usedPct(day)"></span>
                  </span>
                } @else {
                  <span class="pg-cap-say">Presupuestos no fijó el tope de este día: se pueden armar pagos, pero el día no se autoriza.</span>
                }
              </div>
              <!-- [PGP.15] EL AVANCE DEL DIA, siempre a la vista y sin clic (eran cuatro acordeones). -->
              <ol class="pg-prog" aria-label="Avance del día">
                @for (e of etapas(); track e.n) {
                  <li class="pg-pe" [class.is-done]="e.estado === 'hecho'" [class.is-now]="e.estado === 'ahora'" [attr.aria-current]="e.estado === 'ahora' ? 'step' : null"
                     >
                    <span class="pg-pe-n" aria-hidden="true">@if (e.estado === 'hecho') { <i class="pi pi-check"></i> } @else { {{ e.n }} }</span>
                    <span class="pg-pe-t"><b>{{ e.nombre }}@if (e.quien && e.estado === 'ahora') { <span class="pg-pe-who"> · {{ e.quien }}</span> }</b>@if (e.dice) { <span class="pg-pe-say">{{ e.dice }}</span> }@if (e.quien && e.estado !== 'ahora') { <span class="sr-only">, lo hace {{ e.quien }}</span> }</span>
                  </li>
                }
              </ol>
              </div>
              @if (pasoActivo() === 3) {
                <!-- [PGP.13] Lo que la pantalla NO puede afirmar todavia: D2 (firma por monto) y la
                     separacion de funciones (PGP.1.1) estan decididas pero el codigo no las aplica. -->
                <p class="pg-note"><i class="pi pi-shield" aria-hidden="true"></i><span>Se autoriza <b>el día completo</b>. Debe hacerlo alguien distinto de quien lo preparó, y <b>la Suite todavía no lo impide</b>; tampoco existe aún la firma por pago según su monto (decisión D2).</span></p>
              }
              @if (isReleased()) {
                <!-- [PGP.13] Si no se dice, quien captura deja de hacerlo creyendo que la Suite lo escribe. -->
                <p class="pg-note"><i class="pi pi-info-circle" aria-hidden="true"></i><span><b>Kepler: cada pago (X-D-26) se sigue capturando a mano.</b> La escritura automática está apagada.</span></p>
              }
            </div>

            <div class="pg-work" #pgWork [class.is-solo]="isReleased()">
            <!-- ── AGREGAR FACTURAS: el carril que mas se usa (Edgar: «el 80% es el buscador y agregar
                 facturas de proveedores»). [PGP.15] Medido antes: el buscador vivia DENTRO de un plegable
                 cerrado, 1.3 pantallas abajo; escribir no buscaba (hacia falta Enter, y nada lo decia);
                 6 facturas de un mismo pago eran 6 clics; y tras agregar, la lista se vaciaba, el foco se
                 iba al aviso y el «+» seguia activo mientras recargaba. Ahora el buscador esta siempre
                 a la vista y ARRIBA de los pagos, busca mientras se escribe, agrupa por proveedor y
                 sucursal con «Agregar las N», y tras agregar devuelve el foco al buscador. -->
            @if (!isReleased()) {
              <section class="pg-sec pg-add" aria-labelledby="pg-add-h">
                <div class="pg-sec-h pg-add-h">
                  <h3 class="pg-sec-t" id="pg-add-h">Agregar facturas</h3>
                  <span class="pg-buscar">
                    <span class="pi pi-search" aria-hidden="true"></span>
                    <input id="pg-buscar" pInputText type="search" autocomplete="off" class="pg-buscar-in"
                           [ngModel]="busqueda()" (ngModelChange)="alEscribir($event)" (keydown.enter)="buscarYa()" (keydown.escape)="limpiarBusqueda($event)"
                           placeholder="Proveedor, folio, referencia o código"
                           aria-label="Buscar facturas por proveedor, folio, referencia o código del acreedor" aria-describedby="pg-buscar-dice" />
                    <kbd class="pg-kbd" title="Atajo: la tecla / lleva al buscador desde cualquier parte de la pantalla">/</kbd>
                  </span>
                  <span id="pg-buscar-dice" class="pg-sec-n" aria-live="polite">
                    @if (buscando()) { Buscando… }
                    <!-- [PGP.15] El universo de la lista, en la misma línea (era un renglón aparte): si vino
                         topada se dice cuántas de cuántas, también con búsqueda. -->
                    @else if (busquedaAplicada()) { @if (obligationsTruncated()) { {{ obligations().length | number }} de {{ obligationsTotal() | number }} facturas } @else { {{ facturas(obligacionesProgramables().length) }} } con «{{ busquedaAplicada() }}»@if (gruposBusqueda().length > 1) { · {{ gruposBusqueda().length }} proveedores } }
                    @else { @if (obligationsTruncated()) { {{ obligations().length | number }} de {{ obligationsTotal() | number }} por pagar, las más próximas a vencer } @else { {{ obligationsTotal() | number }} por pagar }@if (obligacionesEnRevision().length) { · {{ obligacionesEnRevision().length }} por confirmar } }
                  </span>
                </div>
                @if (avisoAlta(); as av) {
                  <p class="pg-alta" role="status"><i class="pi pi-check" aria-hidden="true"></i>{{ av }}</p>
                }
                @if (verDeuda()) {
                  <div class="pg-drawer" id="pg-add-b">
                    <div class="pg-drawer-h">
                      <p-select appendTo="body" [options]="classificationOpts" [(ngModel)]="classificationFilter" (onChange)="loadObligations()" optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true" size="small" class="cal-sel" ariaLabel="Tipo de obligación" />
                      <p-select appendTo="body" [options]="ordenOpts" [(ngModel)]="ordenSel" (onChange)="onOrden()" optionLabel="label" optionValue="value" size="small" class="cal-sel" ariaLabel="Orden de la lista" />
                      <label class="cal-check"><p-checkbox [(ngModel)]="onlyCritical" [binary]="true" (onChange)="loadObligations()" />Críticos</label>
                      <!-- [RE.32] Lo que Compras entrega a Finanzas se confirma alla; Finanzas no ve el menu de Compras. -->
                      <a pButton class="p-button-sm p-button-text p-button-secondary pg-entregas" routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">
                        <span class="p-button-icon p-button-icon-left pi pi-inbox" aria-hidden="true"></span><span class="p-button-label">Entregas de Compras</span>
                      </a>
                    </div>
                    <!-- [PGP.15] Con una busqueda, cada proveedor y sucursal es UN pago: se agrega entero
                         de un clic (eran N clics, uno por factura). Sus facturas siguen abajo, una por una. -->
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
                    <!-- [PGP.15] Lo topado de la lista ya lo dice el resumen junto al buscador («1,000 de 2,848…»). -->
                    <div class="pg-dr-hd" aria-hidden="true"><span>Proveedor y documento</span><span>Vencimiento</span><span class="r">Importe</span><span></span></div>
                    <div class="pg-drawer-b">
                      <app-load-state [loading]="loadingObligations()" [skeletonRows]="4">
                        <!-- ⛔ [PGP.15] El cajon congelaba la pantalla 15.9 s al abrirse (medido: 954 renglones,
                             13,300 nodos, 1,908 pButton con su pTooltip, y cada renglon formateando fechas e
                             importes en cada ciclo). Ahora: (1) los textos de cada renglon se calculan UNA vez
                             (filasDeuda); (2) botones nativos; (3) se pintan primero los de arriba y el resto
                             entra por tandas sin bloquear (deudaVisible): al final estan TODOS en la pagina. -->
                        @for (f of filasDeuda().slice(0, deudaVisible()); track f.o.obligation_id) {
                          <div class="pg-dr-row">
                            <span class="pg-dr-main">
                              <span class="cal-benef">{{ f.o.beneficiary }}@if (f.o.is_critical) { <span class="pg-crit"><i class="pi pi-flag" aria-hidden="true"></i>crítico</span> }</span>
                              <span class="pg-sub"><span class="cal-suc">{{ f.sucursal }}</span>
                                @if (f.o.entity_ref) {
                                  <button type="button" class="cal-reflink" [title]="f.tituloFicha" (click)="inspect.set(f.o.entity_ref!)">{{ f.o.concept }}</button>
                                } @else { {{ f.o.concept }} }
                                @if (f.o.doc_ref) { <span class="cal-ref">{{ f.o.doc_ref }}</span> }
                                @if (f.pronto; as p) {
                                  <span class="cal-pp" [class.cal-pp-urge]="p.urge">
                                    <i class="pi" [class.pi-bolt]="p.urge" [class.pi-tag]="!p.urge" aria-hidden="true"></i>{{ p.texto }}
                                  </span>
                                }
                                <!-- [PGP.14] El credito a favor que NADIE aplico. No bloquea el pago -netear
                                     es una decision de Finanzas con el proveedor, no una regla automatica-
                                     pero no se puede decidir lo que no se ve. Medido: 54 acreedores con deuda
                                     viva traen $4,484,249 a favor; varios quedarian en CERO. -->
                                @if (f.credito; as c) {
                                  <!-- [PGP.17] El aviso ABRE el desglose: decir «trae $9,778.59 a
                                       favor» sin decir de que tipo ni de que documento no deja
                                       actuar. Es un boton, no un texto (Q.4). -->
                                  <button type="button" class="pg-favor pg-favor-btn"
                                          [attr.aria-label]="'Ver los descuentos de ' + f.o.beneficiary"
                                          (click)="abrirCreditos(f.o.payee_code, f.o.beneficiary)">
                                    <i class="pi pi-replay" aria-hidden="true"></i>{{ c }}
                                    <i class="pi pi-angle-right" aria-hidden="true"></i>
                                  </button>
                                }
                                <!-- [PGP.16] Lo que cuesta pagarla antes de su vencimiento. Medido:
                                     el 17.9% del dinero sale antes de tiempo, 6 dias en promedio.
                                     Se calla cuando el pronto pago gana mas de lo que cuesta. -->
                                @if (f.adelanto; as a) { <span class="pg-pronto-no"><i class="pi pi-clock" aria-hidden="true"></i>{{ a }}</span> }
                                <!-- [PGP.21] La factura, acá, para no ir a buscarla a mano. Con PDF
                                     es un boton (Q.4: el dato lleva a su accion); con solo UUID o
                                     sin nada es texto que DICE POR QUE, nunca un hueco mudo. -->
                                @if (evidenciaDe(f.o); as e) {
                                  @if (e.evidencia === 'pdf') {
                                    <button type="button" class="pg-ev pg-ev-pdf"
                                            [attr.aria-label]="'Ver la factura de ' + f.o.beneficiary + ' ' + f.o.concept"
                                            (click)="abrirFactura(e)">
                                      <i class="pi pi-file-pdf" aria-hidden="true"></i>Ver la factura
                                    </button>
                                  } @else if (e.evidencia === 'uuid') {
                                    <span class="pg-ev pg-ev-uuid"><i class="pi pi-id-card" aria-hidden="true"></i>sin archivo; hay UUID fiscal</span>
                                  } @else {
                                    <span class="pg-ev pg-ev-no"><i class="pi pi-info-circle" aria-hidden="true"></i>sin factura: {{ e.motivo }}</span>
                                  }
                                  <!-- [PGP.27] Si la factura se encontró con un RFC que no salió de Kepler,
                                       se DICE. ADR-056: el dato declara su procedencia; no se presenta
                                       como del ERP lo que salió de una inferencia.
                                       ⛔ [PGP.32] Son DOS casos, no uno, y hasta hoy el rótulo afirmaba
                                          siempre el primero: Kepler puede no tenerlo, o puede tener OTRO
                                          (ADR-108 — 18 acreedores, 91 documentos, J&F y MONDELEZ). Decirle
                                          «Kepler no tiene RFC» a quien está viendo que Kepler sí lo tiene
                                          es la clase de rótulo que hace desconfiar de toda la pantalla. -->
                                  @if (rfcDeducido(e); as r) {
                                    @if (e.rfc_discrepa) {
                                      <span class="pg-ev pg-ev-dis"
                                            [title]="'Kepler tiene capturado ' + e.rfc_discrepa + ' para este acreedor, y sus comprobantes timbrados ante el SAT dicen ' + r + '. Se usó el del comprobante (ADR-108). La ficha de Kepler sigue sin corregir.'">
                                        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>RFC en disputa: Kepler dice {{ e.rfc_discrepa }}, sus comprobantes {{ r }}
                                      </span>
                                    } @else {
                                      <span class="pg-ev pg-ev-src"
                                            [title]="'Kepler no tiene un RFC utilizable para este acreedor. Se usó ' + r + ', que resolvió el cruce de su nombre normalizado contra ContPAQi.'">
                                        <i class="pi pi-link" aria-hidden="true"></i>RFC deducido: {{ r }}
                                      </span>
                                    }
                                  }
                                }
                              </span>
                            </span>
                            <span class="pg-dr-due">{{ f.vence }}</span>
                            <span class="pg-dr-amt comm-num">{{ f.importe }}</span>
                            <span class="pg-dr-acts">
                              <!-- [PGP.15] Un clic agrega la factura COMPLETA al dia abierto; lo raro -otro importe,
                                   otro dia- va en el segundo boton. Ayuda en title y aria-label. -->
                              <button type="button" class="pg-icobtn" [disabled]="saving() || agregando().has(f.o.obligation_id)" [attr.aria-label]="f.ariaAgregar" title="Agregar completa a este día" (click)="quickAdd(f.o)"><span class="pi" [class.pi-plus]="!agregando().has(f.o.obligation_id)" [class.pi-check]="agregando().has(f.o.obligation_id)" aria-hidden="true"></span></button>
                              <button type="button" class="pg-icobtn" [disabled]="saving()" [attr.aria-label]="f.ariaOtro" title="Otro importe u otro día" (click)="quickAddDialog(f.o)"><span class="pi pi-sliders-h" aria-hidden="true"></span></button>
                            </span>
                          </div>
                        } @empty {
                          <p class="cal-empty">Sin obligaciones con estos filtros. Las facturas de proveedor llegan aquí cuando Finanzas acepta una entrega en <a routerLink="/compras/obligaciones" [queryParams]="{ tab: 'entregas' }">Entregas de Compras</a>.</p>
                        }
                        @if (deudaVisible() < filasDeuda().length) {
                          <p class="pg-drawer-n" aria-live="polite">Mostrando {{ deudaVisible() | number }} de {{ filasDeuda().length | number }}…</p>
                        }
                      </app-load-state>
                    </div>

                    <!-- [PGP.13] ⛔ LO QUE NO SE PUEDE PROGRAMAR, aparte y sin boton de agregar: facturas de
                         sucursal anteriores al corte del 1-oct, que pueden estar pagadas desde Oficinas.
                         Plegado CON su cuenta y su total: plegar no es esconder. -->
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

            <!-- ── LOS PAGOS DEL DIA: una tabla, todos los estados, siempre a la vista ── -->
            <section class="pg-sec" aria-labelledby="pg-pagos-h">
              <div class="pg-sec-h">
                <h3 class="pg-sec-t" id="pg-pagos-h">Pagos del día
                  @if (allocations().length) { <span class="pg-sec-n comm-num">{{ pagos(allocations().length) }} · {{ money(dayTotal(day)) }}</span> }
                </h3>
                @if (!isReleased() && pendingCount() > 0) {
                  <!-- [PGP.15] En el ENCABEZADO del panel (era un renglon propio) y como el boton principal del paso:
                       el veredicto repetia «Elegir el metodo de los N» con otro boton.
                       Metodo y origen para todos, y el DESTINO lo pone el sistema: la cuenta
                       favorita del catalogo del proveedor (aprobada por Gerencia). Antes habia que abrir
                       un dialogo por pago solo para aceptar una cuenta que el sistema ya conocia. -->
                  <div class="pg-applyall">
                    <span class="pg-aa-lb">Para los {{ pendingCount() }} pagos</span>
                    <span class="pg-aa-f"><label for="pg-bulk-method">Método</label>
                      <p-select appendTo="body" inputId="pg-bulk-method" [options]="methodOpts" [(ngModel)]="bulkMethod" optionLabel="label" optionValue="value" placeholder="Elegir…" size="small" class="cal-sel" /></span>
                    @if (bulkMethod !== 'efectivo') {
                      <span class="pg-aa-f"><label for="pg-bulk-origin">Sale de</label>
                        <p-select appendTo="body" inputId="pg-bulk-origin" [options]="originOpts()" [(ngModel)]="bulkOriginId" optionLabel="label" optionValue="id" placeholder="Elegir cuenta…" [filter]="true" filterBy="label" size="small" class="cal-sel" /></span>
                    }
                    <button pButton type="button" class="p-button-sm" [disabled]="!bulkMethod || (bulkMethod !== 'efectivo' && !bulkOriginId) || saving()" [loading]="saving()" (click)="aplicarATodos()">Aplicar a los {{ pendingCount() }}</button>
                    @if (bulkMethod === 'transferencia' || bulkMethod === 'cargo_automatico') {
                      <span class="pg-aa-note">El destino de cada uno sale solo de la cuenta favorita de su proveedor; los que no tengan, quedan marcados.</span>
                    }
                  </div>
                }
                <span class="pg-sec-acts">
                  @if (allocations().length) {
                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [loading]="printing()" (click)="printPreliminar()"><span class="pi pi-file-pdf" aria-hidden="true"></span>&nbsp;Preliminar</button>
                  }
                  @if (day.lot_folio) {
                    <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [loading]="printing()" (click)="printCajaGeneral()"><span class="pi pi-print" aria-hidden="true"></span>&nbsp;Instrucción a Caja General</button>
                  }
                  <!-- [PGP.15] Con un rebote, el boton principal es moverlo; marcar los demas de una vez sigue aqui. -->
                  @if (isReleased() && porPagar().length > 1 && verdict().action?.kind !== 'pagar') {
                    <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="saving()" (click)="pagarVisible = true"><span class="pi pi-check" aria-hidden="true"></span>&nbsp;Marcar los {{ porPagar().length }} pagados</button>
                  }
                </span>
              </div>

              @if (!allocations().length) {
                @if (armadoCargando()) {
                  <p class="cal-empty">Calculando la propuesta con toda la deuda…</p>
                } @else if (armado(); as arm) {
                  @if (arm.length) {
                    <!-- [PGP.15] La propuesta ya esta hecha al entrar: era un boton «Sugerir armado» que
                         habia que encontrar y apretar para ver algo que el sistema ya sabia calcular. -->
                    <div class="pg-prop" role="group" aria-label="Propuesta para este día">
                      <p class="pg-prop-why">Propuesta: lo vencido o que vence este día, <b>un pago por proveedor y sucursal</b>, lo más viejo primero, hasta donde alcance el tope. Quita lo que no quieras pagar hoy.</p>
                      @for (g of armadoCaben(); track g.key) {
                        <label class="pg-prop-row">
                          <p-checkbox [binary]="true" [ngModel]="armadoOn().has(g.key)" (onChange)="toggleArmado(g.key)" [ariaLabel]="'Incluir ' + g.beneficiary + ' ' + branchLabel(g.branch)" />
                          <span class="pg-prop-main">
                            <span class="cal-benef">{{ g.beneficiary }}</span>
                            <span class="pg-sub"><span class="cal-suc">{{ branchLabel(g.branch) }}</span> {{ facturas(g.items.length) }} · la más vieja venció el {{ shortDate(g.oldest) }}</span>
                            <!-- [PGP.14] Acá es donde de verdad se decide: la propuesta ya eligió a
                                 este proveedor. Si trae saldo a favor sin aplicar, se dice ANTES de
                                 marcar la casilla, no después de pagar. -->
                            @if (creditoDeGrupo(g); as c) {
                              <span class="pg-favor"><i class="pi pi-replay" aria-hidden="true"></i>trae {{ money(c.a_favor) }} a favor sin aplicar ({{ c.clases.toLowerCase() }}) — revisa si hay que netear</span>
                            }
                          </span>
                          <span class="pg-prop-amt comm-num">{{ money(g.total) }}</span>
                        </label>
                      }
                      <!-- [PGP.15] Lo que NO cabe, en UNA linea con su cuenta y su total, y desglosable. Medido el
                           2026-10-26 para el vie 30: 489 renglones, 459 deshabilitados con «no cabe en el tope»
                           -ruido que no se podia elegir- y la pantalla congelada ~1.4 s al pintarlos. -->
                      @if (armadoFuera().length) {
                        <button type="button" class="pg-rev-h pg-fuera-h" [attr.aria-expanded]="verFuera()" (click)="verFuera.set(!verFuera())">
                          <span class="pi" [class.pi-angle-down]="verFuera()" [class.pi-angle-right]="!verFuera()" aria-hidden="true"></span>
                          <span class="pg-rev-t"><b>{{ pagos(armadoFuera().length) }} más, vencidos, no caben en el tope · <span class="comm-num">{{ money(armadoFueraTotal()) }}</span></b>
                            <span>Van en orden de antigüedad: el primero que no cabe es el de {{ armadoFuera()[0].beneficiary }} por {{ money(armadoFuera()[0].total) }}.</span></span>
                        </button>
                        @if (verFuera()) {
                          @for (g of armadoFuera(); track g.key) {
                            <div class="pg-prop-row is-off">
                              <span class="pi pi-minus pg-fuera-i" aria-hidden="true"></span>
                              <span class="pg-prop-main">
                                <span class="cal-benef">{{ g.beneficiary }}</span>
                                <span class="pg-sub"><span class="cal-suc">{{ branchLabel(g.branch) }}</span> {{ facturas(g.items.length) }} · la más vieja venció el {{ shortDate(g.oldest) }}</span>
                              </span>
                              <span class="pg-prop-amt comm-num">{{ money(g.total) }}</span>
                            </div>
                          }
                        }
                      }
                    </div>
                  } @else {
                    <p class="cal-empty">No hay facturas vencidas ni por vencer para este día. Si hay que pagar algo, agrégalo desde «Agregar facturas».</p>
                  }
                } @else {
                  <p class="cal-empty">Sin pagos este día.</p>
                }
              } @else {

                <!-- [PGP.14] class=, no styleClass=: en PrimeNG v22 styleClass se descarta en silencio.
                     [PGP.15] UNA tabla para todo el ciclo: preparar, autorizar, pagar y lo que rebota. Antes
                     el mismo dia se veia en dos tablas distintas segun el paso, y una de las dos estaba
                     siempre plegada. Cada pago se DESGLOSA en sus facturas (antes: una linea cortada con
                     «…» que escondia folios). -->
                <p-table [value]="allocations()" size="small" dataKey="id" [expandedRowKeys]="abiertos()" [scrollable]="true" scrollHeight="flex" class="surf-table surf-table--plain pg-prep">
                  <ng-template #header>
                    <tr>
                      <th class="pg-c-tg"><span class="sr-only">Desglose</span></th>
                      <th class="pg-c-ord" [class.is-folio]="isReleased()">@if (isReleased()) { Folio } @else { Orden }</th>
                      <th class="pg-c-ben">Beneficiario y cómo sale</th>
                      <th class="pg-c-amt">Importe</th>
                      <th class="pg-c-act"><span class="sr-only">Acciones</span></th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-a let-i="rowIndex" let-expanded="expanded">
                    <tr [class.is-bad]="a.status === 'failed'">
                      <td class="pg-c-tg">
                        <button type="button" class="pg-tg" [attr.aria-expanded]="expanded" [attr.aria-label]="(expanded ? 'Ocultar las facturas de ' : 'Ver las facturas de ') + allocationTitle(a)" (click)="toggleAbierto(a.id)">
                          <span class="pi" [class.pi-angle-down]="expanded" [class.pi-angle-right]="!expanded" aria-hidden="true"></span>
                        </button>
                      </td>
                      <td class="pg-c-ord">
                        @if (a.status === 'pending' && !isReleased()) {
                          <!-- [PGP.13] Ordenar CON TECLADO. El orden decide el turno en que Caja General dispersa. -->
                          <span class="pg-ord">
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-ico" [disabled]="i === 0 || saving()" (click)="moverPago(a, -1)" [attr.aria-label]="'Subir ' + allocationTitle(a)"><span class="pi pi-chevron-up" aria-hidden="true"></span></button>
                            <b class="comm-num pg-ordn">{{ a.priority_rank ?? '—' }}</b>
                            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-ico" [disabled]="i === allocations().length - 1 || saving()" (click)="moverPago(a, 1)" [attr.aria-label]="'Bajar ' + allocationTitle(a)"><span class="pi pi-chevron-down" aria-hidden="true"></span></button>
                          </span>
                        } @else {
                          <span class="comm-num pg-ordn">{{ a.folio || a.priority_rank || '—' }}</span>
                        }
                      </td>
                      <td class="pg-c-ben">
                        <span class="cal-benef">{{ allocationTitle(a) }}</span>
                        <span class="pg-sub"><span class="cal-suc">{{ itemsBranches(a) }}</span>{{ itemsResumen(a) }}</span>
                        @if (a.notes) { <span class="cal-notes">{{ a.notes }}</span> }
                        <!-- [PGP.15] Cómo sale, DEBAJO del beneficiario: en el panel de la derecha una columna
                             propia de 21rem dejaba al nombre en ~10 px (medido: se partía letra por letra). -->
                        @if (comoSale(a); as cs) {
                          <span class="pg-how">
                            @if (cs.texto) { <span class="pg-how-t">{{ cs.texto }}</span> }
                            <span class="pg-st" [class.is-bad]="a.status === 'failed'" [class.is-todo]="a.status === 'pending' && !!cs.falta">
                              <i class="pi" [ngClass]="estadoIcono(a)" aria-hidden="true"></i>{{ estadoTexto(a) }}
                            </span>
                          </span>
                        }
                      </td>
                      <td class="pg-c-amt comm-num" data-l="Importe">{{ money(a.amount_assigned) }}</td>
                      <td class="pg-c-act">
                        @if (a.status === 'pending' && !isReleased()) {
                          <button pButton type="button" class="p-button-sm p-button-secondary" [class.p-button-outlined]="!prepared(a)" [class.p-button-text]="prepared(a)"
                                  (click)="openPrepare(a)" [attr.aria-label]="(prepared(a) ? 'Cambiar cómo sale el pago de ' : 'Preparar el pago de ') + allocationTitle(a)">{{ prepared(a) ? 'Cambiar' : 'Preparar' }}</button>
                          <button pButton type="button" class="p-button-sm p-button-text p-button-secondary pg-x" [attr.aria-label]="'Quitar del día a ' + allocationTitle(a)" pTooltip="Quitar del día" tooltipPosition="top" (click)="cancelAllocation(a)"><span class="pi pi-times" aria-hidden="true"></span></button>
                        } @else if (a.status === 'pending') {
                          <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="!prepared(a) || saving()" (click)="execute(a)" [attr.aria-label]="'Marcar pagado el pago de ' + allocationTitle(a)">Pagado</button>
                          <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'El pago de ' + allocationTitle(a) + ' rebotó'" (click)="openRebote(a)">Rebotó…</button>
                        } @else if (a.status === 'failed') {
                          <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [attr.aria-label]="'Mover a otro día el pago de ' + allocationTitle(a)" (click)="openReprogram(a)"><span class="pi pi-calendar" aria-hidden="true"></span>&nbsp;Mover</button>
                        }
                      </td>
                    </tr>
                  </ng-template>
                  <ng-template #expandedrow let-a>
                    <tr class="pg-xrow">
                      <td colspan="5">
                        <!-- [PGP.15] El desglose: cada factura que cubre el pago, con su sucursal y lo que se le aplica. -->
                        <table class="pg-items-t">
                          <caption class="sr-only">Facturas del pago de {{ allocationTitle(a) }}</caption>
                          <thead><tr><th>Sucursal</th><th>Documento</th><th class="r">Se aplica</th></tr></thead>
                          <tbody>
                            @for (it of a.items; track it.id) {
                              <tr><td>{{ branchLabel(it.branch_code) }}</td><td>{{ it.concept }}@if (it.beneficiary !== a.items[0].beneficiary) { · {{ it.beneficiary }} }</td><td class="r comm-num">{{ money(it.applied_amount) }}</td></tr>
                            }
                          </tbody>
                          <tfoot><tr><td colspan="2">{{ facturas(a.items.length) }}</td><td class="r comm-num">{{ money(a.amount_assigned) }}</td></tr></tfoot>
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
            </div>
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
            estan aqui</b>: son pagos, no descuentos.
          </p>

          <div class="pg-cr-tot">
            <span><b class="comm-num">{{ money(creditoTotalPendiente()) }}</b> sin aplicar · {{ creditoPendientes().length }} documento(s)</span>
            <span class="cal-muted"><b class="comm-num">{{ money(creditoTotalAplicado()) }}</b> ya aplicado por Kepler</span>
          </div>

          @if (creditoPendientes().length) {
            <h3 class="pg-cr-h">Sin aplicar — esto es lo que se puede netear</h3>
            @for (d of creditoPendientes(); track d.clase + d.folio + d.sucursal) {
              <div class="pg-cr-row is-pend">
                <span class="pg-cr-main">
                  <span class="cal-benef">{{ d.clase }}<span class="pg-dr-amt comm-num">{{ money(d.a_favor) }}</span></span>
                  <span class="pg-sub"><span class="cal-suc">{{ branchLabel(d.sucursal) }}</span>folio {{ d.folio }}@if (d.referencia) { <span class="cal-ref">{{ d.referencia }}</span> }@if (d.fecha) { · {{ shortDate(d.fecha) }} }</span>
                  @if (d.aplicado > 0) {
                    <!-- El caso mas comun: se aplico un pedazo y sobro el resto. -->
                    <span class="pg-cr-part">de {{ money(d.importe) }} se aplicaron {{ money(d.aplicado) }} y sobro el resto</span>
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
            Aplicar un descuento contra una factura se hace <b>en Kepler</b>: la Suite todavia no
            escribe ese movimiento. Esta pantalla dice <b>que hay</b> y <b>cuanto</b>, para que no
            se pague de mas. Las cifras son un <b>piso</b>: el casamiento del ERP sobre-cuenta lo
            aplicado, asi que lo pendiente real puede ser mayor.
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
        <input id="cal-quick-amt" pInputText type="number" [(ngModel)]="quickAddAmount" [max]="o.available_amount" min="0.01" step="0.01" class="cal-dlg-full comm-num" />
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
          <p class="cal-dlg-hint cal-habito">A este proveedor se le suele pagar <b>desde Caja General</b> ({{ h.cuenta_veces }} de {{ h.cuenta_de }}), que no es cuenta de origen de una transferencia.</p>
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
      <div class="cal-dlg-actions"><button pButton type="button" class="p-button-text p-button-secondary" (click)="prepareVisible = false">Cancelar</button><button pButton type="button" (click)="confirmPrepare()" [loading]="saving()">Guardar</button></div>
    </p-dialog>

    <!-- Dialog: marcar pagados (Caja General). Irreversible aqui: friccion proporcional, un solo paso. -->
    <p-dialog [(visible)]="pagarVisible" [modal]="true" header="Marcar como pagados" [style]="{ width: '32rem' }">
      <p class="cal-dlg-p">Se marcan <b>{{ pagos(porPagar().length) }}</b> por <b class="comm-num">{{ money(porPagarTotal()) }}</b>. Marca sólo lo que el banco ya confirmó: <b>un pago marcado no se deshace aquí</b>. Si alguno rebotó, cancela y márcalo «Rebotó…» en su fila.</p>
      <ul class="pg-dlg-list">
        @for (a of porPagar(); track a.id) {
          <li><span><span class="comm-num pg-dlg-fol">{{ a.folio || a.priority_rank }}</span> {{ allocationTitle(a) }}</span><b class="comm-num">{{ money(a.amount_assigned) }}</b></li>
        }
      </ul>
      <div class="cal-dlg-actions">
        <button pButton type="button" class="p-button-text p-button-secondary" (click)="pagarVisible = false">Cancelar</button>
        <button pButton type="button" [disabled]="!porPagar().length" [loading]="saving()" (click)="confirmPagar()">Marcar {{ pagos(porPagar().length) }}</button>
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
    <p-dialog [(visible)]="reprogramVisible" [modal]="true" header="Mover a otro día" [style]="{ width: '24rem' }">
      <label class="cal-dlg-label" for="cal-rep-date">Nueva fecha</label>
      <input id="cal-rep-date" type="date" [(ngModel)]="reprogramDate" class="cal-date-input cal-dlg-full" />
      <label class="cal-dlg-label" for="cal-rep-reason">Motivo</label>
      <p-select appendTo="body" inputId="cal-rep-reason" [options]="reprogramReasonOpts" [(ngModel)]="reprogramReason" optionLabel="label" optionValue="value" placeholder="Motivo" [fluid]="true" class="cal-dlg-sel" />
      @if (reprogramReason === 'otro') {
        <input pInputText type="text" [(ngModel)]="reprogramReasonDetail" placeholder="Detalle (obligatorio)" class="cal-dlg-full" aria-label="Detalle del motivo" />
      }
      <div class="cal-dlg-actions"><button pButton type="button" class="p-button-text p-button-secondary" (click)="reprogramVisible = false">Cancelar</button><button pButton type="button" (click)="confirmReprogram()" [loading]="saving()">Mover</button></div>
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
    .cal-page { gap:var(--sp-3); }
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
      font-size:var(--fs-sm); font-weight:700; color:var(--warn-fg); }
    /* [PGP.17] El aviso es un BOTON: dice cuanto, y abre de que tipo y de que documento. */
    .pg-favor-btn { border:0; background:transparent; cursor:pointer; font:inherit; font-size:var(--fs-sm);
      font-weight:700; color:var(--warn-fg); padding:0 2px; border-radius:var(--r-sm); }
    .pg-favor-btn:hover { text-decoration:underline; }
    .pg-favor-btn:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    /* [PGP.21] La evidencia de la factura. Tres estados y NINGUNO depende solo del color:
       cada uno lleva su icono y su texto, que es lo que exige el modo de alto contraste. */
    .pg-ev { display:inline-flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-sm); }
    .pg-ev-pdf { border:0; background:transparent; cursor:pointer; font:inherit; font-size:var(--fs-sm);
      color:var(--action); padding:0; text-align:left; }
    .pg-ev-pdf:hover { text-decoration:underline; }
    .pg-ev-pdf:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .pg-ev-uuid { color:var(--fg-2); }
    .pg-ev-no { color:var(--fg-3); }
    .pg-ev-src { color:var(--fg-3); }
    /* [PGP.32] La disputa NO se atenúa como la deducción: una contradicción entre el ERP y el
       SAT es trabajo de alguien, no una nota al pie. Sin fondo ni borde: pesa por color y peso,
       que es lo que §Q.5 pide, y no agrega una caja más al renglón. */
    .pg-ev-dis { color:var(--warn-fg); font-weight:600; }
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
    .pg-cr-part { font-size:var(--fs-sm); color:var(--warn-fg); }
    .pg-cr-ok { display:flex; align-items:center; gap:6px; font-size:var(--fs-sm); color:var(--ok-fg); margin:0; }
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
      padding:5px var(--sp-2); border:1px solid transparent; border-radius:var(--r-sm); scroll-snap-align:start; }
    .pg-day:hover { background:var(--overlay-hover); }
    .pg-day:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    /* El dia elegido: fondo y borde del color del TEXTO, no naranja. El naranja es del boton principal. */
    .pg-day.is-sel { background:var(--overlay-selected); border-color:var(--text-main); box-shadow:inset 0 -2px 0 var(--text-main); }
    .pg-day.is-nocap { opacity:.7; }
    .pg-day-t { display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-2); }
    .pg-day-n { font-size:var(--fs-sm); font-weight:700; text-transform:capitalize; color:var(--text-main); white-space:nowrap; }
    .pg-t { font-weight:400; color:var(--text-muted); font-size:var(--fs-sm); }
    .pg-day-amt { font-size:var(--fs-sm); font-weight:700; color:var(--text-main); white-space:nowrap; }
    .pg-day-l { font-weight:400; color:var(--text-muted); }
    .pg-day-b { display:flex; align-items:center; gap:4px; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.3; white-space:nowrap; }
    .pg-day-b b { color:var(--text-main); font-weight:700; }
    .pg-day-b b.cal-bad-txt { color:var(--bad-soft-fg); }
    .pg-day-b b.cal-warn-txt { color:var(--warn-soft-fg); background:var(--warn-soft-bg); }
    .pg-day-b b.cal-ok-txt { color:var(--ok-soft-fg); }
    /* El estado del dia viaja en FORMA (punto lleno / hueco), nunca solo en color. */
    .pg-dot { width:6px; height:6px; border-radius:var(--r-pill); background:var(--text-faint); flex-shrink:0; }
    .pg-dot.is-work { background:var(--text-main); }
    .pg-dot.is-free { background:transparent; border:1px solid var(--text-muted); }
    .pg-rev-u { font-weight:400; color:var(--text-muted); }

    /* ── El veredicto, compacto: frase y boton; tope y avance lado a lado ── */
    .pg-lot { display:grid; gap:var(--sp-2); min-width:0; }
    .pg-vd { display:grid; gap:0; padding:var(--sp-1) 0; border-block:1px solid var(--border-color); }
    /* Rojo SOLO cuando algo esta mal. «Bien» y «falta» no llevan tono: lo dice la frase. */
    .pg-vd.is-bad { border-left:4px solid var(--bad-fg); padding-left:var(--sp-3); }
    .pg-vd-ico { color:var(--bad-soft-fg); margin-right:var(--sp-2); font-size:var(--fs-lg); }
    .pg-vd-id { display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; }
    .pg-vd-id h2 { margin:0; font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); }
    .pg-vd-sub { font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-pill { display:inline-flex; align-items:center; font-size:var(--fs-micro); font-weight:700; text-transform:uppercase; letter-spacing:.03em; padding:0 7px; border-radius:var(--r-pill); color:var(--text-muted); background:var(--surface-2); }
    .pg-vd-main { display:flex; align-items:center; gap:var(--sp-4); flex-wrap:wrap; }
    .pg-vd-txt { flex:1; min-width:15rem; }
    /* [PGP.14] La respuesta de la pantalla es lo primero que se lee: la frase mas grande. */
    .pg-vd-say { margin:0; font-size:var(--fs-h2); font-weight:600; line-height:1.25; letter-spacing:-.01em; color:var(--text-main); }
    .pg-vd-why { margin:2px 0 0; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px var(--sp-2); font-size:var(--fs-sm); color:var(--text-muted); }
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

    /* ── Los dos paneles: llenan la pantalla (--pg-alto lo mide ajustarAlto) y cada uno se desplaza solo ── */
    .pg-work { display:grid; grid-template-columns:minmax(0, 5fr) minmax(0, 7fr); gap:var(--sp-3); height:var(--pg-alto, auto); min-height:0; }
    .pg-work.is-solo { grid-template-columns:minmax(0, 1fr); }
    .pg-work > .pg-sec { display:flex; flex-direction:column; min-height:0; border:0; border-radius:0; background:transparent; }
    /* [PGP.18] Los dos paneles se separan con UNA línea entre ellos, no con dos recuadros. */
    .pg-work > .pg-sec + .pg-sec { border-left:1px solid var(--border-color); padding-left:var(--sp-3); }
    .pg-work .pg-drawer { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
    .pg-work .pg-drawer-b { flex:1 1 auto; min-height:0; max-height:none; }
    .pg-work .pg-grupos { flex:0 1 auto; max-height:40%; overflow:auto; }
    .pg-work .pg-rev-list { flex:0 1 auto; max-height:35%; overflow:auto; }
    .pg-work .pg-prop { flex:1 1 auto; min-height:0; overflow:auto; }
    :host ::ng-deep .pg-work p-table.pg-prep { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
    :host ::ng-deep .pg-work .pg-prep .p-datatable-thead > tr > th { background:var(--card-bg); }
    @media (max-width: 75rem) { .pg-work { grid-template-columns:minmax(0, 1fr); height:auto; } }
    :host ::ng-deep .pg-entregas.p-button { margin-left:auto; }
    .pg-work .pg-dr-hd { display:none; }
    :host ::ng-deep .pg-work .pg-drawer-h .cal-sel { width:8.5rem; }
    .pg-work .pg-dr-row { grid-template-columns:minmax(0, 1fr) auto auto; grid-template-areas:"main amt acts" "main due acts"; gap:0 var(--sp-3); }
    .pg-work .pg-dr-row > .pg-dr-main { grid-area:main; }
    .pg-work .pg-dr-row > .pg-dr-amt { grid-area:amt; }
    .pg-work .pg-dr-row > .pg-dr-due { grid-area:due; text-align:right; }
    .pg-work .pg-dr-row > .pg-dr-acts { grid-area:acts; }
    .pg-work .cal-benef { white-space:normal; overflow:visible; }
    /* ── Secciones del dia ───────────────────────────────────────────── */
    .pg-sec { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); overflow:hidden; }
    .pg-sec-h { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--border-color); }
    .pg-sec-t { margin:0; display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap; font-size:var(--fs-sm); font-weight:700; color:var(--text-main); }
    .pg-sec-n { font-size:var(--fs-sm); font-weight:400; color:var(--text-muted); }
    .pg-sec-acts { display:flex; gap:var(--sp-1); flex-wrap:wrap; }
    .pg-sec-tg { all:unset; box-sizing:border-box; cursor:pointer; display:inline-flex; align-items:center; gap:var(--sp-2); font-weight:700; color:var(--text-main); border-radius:var(--r-sm); }
    .pg-sec-tg:hover { text-decoration:underline; }
    .pg-sec-tg:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .pg-sub { display:block; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.35; }

    /* ── [PGP.15] El buscador: siempre a la vista, el control mas grande de su seccion ── */
    .pg-add-h { gap:var(--sp-2) var(--sp-3); }
    .pg-buscar { position:relative; display:flex; align-items:center; flex:1 1 22rem; min-width:14rem; max-width:36rem; }
    .pg-buscar > .pi-search { position:absolute; left:var(--sp-3); color:var(--text-muted); pointer-events:none; }
    :host ::ng-deep .pg-buscar-in.p-inputtext { width:100%; padding-left:2.25rem; padding-right:2.25rem; font-size:var(--fs-body); }
    .pg-kbd { position:absolute; right:var(--sp-2); font-family:var(--font-mono); font-size:var(--fs-micro); color:var(--text-muted);
      border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 5px; line-height:1.5; pointer-events:none; }
    .pg-buscar:focus-within .pg-kbd { display:none; }
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
    :host ::ng-deep .pg-vd .pg-cap-ms .ms--compact .ms-v { font-size:var(--fs-sm); font-weight:700; }
    :host ::ng-deep .pg-vd .pg-cap-ms .ms--compact .ms-item { padding-top:0; padding-bottom:0; }

    /* La tabla del dia */
    :host ::ng-deep .pg-prep .p-datatable-table { table-layout:fixed; width:100%; }
    :host ::ng-deep .pg-prep .p-datatable-thead > tr > th { font-size:var(--fs-micro); font-weight:600; text-transform:uppercase; letter-spacing:.04em;
      color:var(--text-muted); padding-top:var(--sp-1); padding-bottom:var(--sp-1); }
    :host ::ng-deep .pg-prep .p-datatable-tbody > tr > td { font-size:var(--fs-sm); vertical-align:middle; }
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
    .pg-tg { all:unset; box-sizing:border-box; cursor:pointer; display:inline-grid; place-items:center; width:28px; height:28px; border-radius:var(--r-sm); color:var(--text-muted); }
    .pg-tg:hover { background:var(--overlay-hover); color:var(--text-main); }
    .pg-tg:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .pg-how-t { color:var(--text-main); overflow-wrap:anywhere; }
    /* El estado del pago: palabra + icono. Solo el rebote lleva color. */
    .pg-st { display:inline-flex; align-items:center; gap:4px; margin-top:2px; font-size:var(--fs-sm); color:var(--text-muted); }
    .pg-st.is-todo { color:var(--warn-soft-fg); background:var(--warn-soft-bg); border-radius:var(--r-pill); padding:0 8px 0 6px; font-weight:700; }
    .pg-st.is-bad { color:var(--bad-soft-fg); font-weight:700; }
    .pg-ord { display:inline-flex; align-items:center; gap:1px; }
    .pg-ordn { min-width:1.2rem; text-align:center; font-weight:700; color:var(--text-main); }
    :host ::ng-deep .pg-ord .p-button { color:var(--text-muted); }
    :host ::ng-deep .pg-ord .p-button:not(:disabled):hover, :host ::ng-deep .pg-x.p-button:hover { color:var(--text-main); }
    :host ::ng-deep .pg-x.p-button { color:var(--text-muted); }
    /* El desglose: las facturas del pago, a la escala de la tabla y sin otra caja. */
    :host ::ng-deep .pg-prep .p-datatable-tbody > tr.pg-xrow > td { background:var(--surface-2); padding:var(--sp-2) var(--sp-3) var(--sp-2) 3rem; }
    .pg-items-t { width:100%; border-collapse:collapse; font-size:var(--fs-sm); color:var(--text-main); }
    .pg-items-t th { text-align:left; font-size:var(--fs-micro); font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); padding:2px var(--sp-2); }
    .pg-items-t td { padding:3px var(--sp-2); border-top:1px solid var(--border-color); }
    .pg-items-t .r { text-align:right; white-space:nowrap; }
    .pg-items-t tfoot td { font-weight:700; color:var(--text-main); }
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
    .pg-icobtn:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
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
  readonly weekAvailable = computed(() => this.weekWithCap().reduce((s, d) => s + Number(d.summary.remaining_amount ?? 0), 0));
  readonly weekNoCapDays = computed(() => this.weekDays().length - this.weekWithCap().length);
  private readonly weekPending = computed(() => this.weekDays().flatMap((d) => d.allocations).filter((a) => a.status === 'pending'));
  readonly weekUnprepared = computed(() => this.weekPending().filter((a) => !isPrepared(a)).length);

  /**
   * El paso del circuito en el que está parado el día: 1 armar · 2 preparar · 3 autorizar ·
   * 4 pagar · 5 cerrar · 6 cerrado. `[PGP.15]` Suma «cerrar»: el backend ya tenía `cerrar` y
   * `fallo`, y la pantalla no los ofrecía — el proceso no se podía terminar desde la interfaz.
   */
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
      { n: 1, nombre: 'Armar', quien: 'Tesorería', estado: est(1),
        dice: n ? `${this.pagos(n)} · ${this.moneyShort(this.dayTotal(day))}` : this.armadoChosen().length ? 'propuesta lista' : 'sin pagos' },
      { n: 2, nombre: 'Preparar', quien: 'Tesorería', estado: est(2),
        dice: rel ? 'listos' : pend ? `${pend - this.unpreparedCount()} de ${pend} listos` : '' },
      { n: 3, nombre: 'Autorizar', quien: 'Gerencia o Dirección', estado: est(3),
        dice: rel ? (day.lot_folio ? `folio ${day.lot_folio}` : 'autorizado') : paso === 3 ? (this.canAuthorize() ? 'listo para tu firma' : 'listo, espera la firma') : '' },
      { n: 4, nombre: 'Pagar', quien: 'Caja General', estado: est(4),
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
  readonly verDeuda = computed(() => !this.isReleased());

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
  @HostListener('window:resize') ajustarAlto(): void {
    const el = this.trabajoEl;
    if (!el) return;
    if (window.matchMedia('(max-width: 75rem)').matches) { el.style.removeProperty('--pg-alto'); return; }
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
    if (sobra > 0 && sobra < 120 && alto - sobra >= piso) { alto -= sobra; el.style.setProperty('--pg-alto', `${alto}px`); }
  }

  /** `[PGP.15]` Los pagos desglosados (abiertos a sus facturas). */
  readonly abiertos = signal<Record<string, boolean>>({});
  toggleAbierto(id: string): void {
    this.abiertos.update((m) => { const n = { ...m }; if (n[id]) delete n[id]; else n[id] = true; return n; });
  }

  readonly executedCount = computed(() => this.allocations().filter((a) => a.status === 'executed').length);
  readonly failedCount = computed(() => this.allocations().filter((a) => a.status === 'failed').length);
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
    // Cerrado no se calcula nada; al abrirse, `verDeuda` cambia y el efecto vuelve a correr.
    if (!this.verDeuda()) { this.rampaAbierta = false; return; }
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
      // [PGP.21] La evidencia se pide de lo que YA se ve, en una sola llamada y sin bloquear.
      this.cargarEvidencias();
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
  private cargarEvidencias(): void {
    const refs = this.filasDeuda().slice(0, this.deudaVisible())
      .map((f) => (f.o.entity_ref ?? '').trim())
      .filter((r) => r.startsWith('oblig:') && !this.evidencias().has(r))
      .slice(0, 200);
    if (!refs.length) return;
    firstValueFrom(this.http.get<PayableEvidenceRow[]>(
      `${this.base}/evidencia`, { params: { refs: refs.join(',') } },
    )).then((rows) => {
      const m = new Map(this.evidencias());
      for (const r of rows ?? []) if (r?.entity_ref) m.set(r.entity_ref, r);
      this.evidencias.set(m);
    }).catch(() => { /* sin marca; la pantalla sigue */ });
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
      const f = (files ?? []).find((x) => x.role === 'factura') ?? (files ?? [])[0];
      if (f?.url) window.open(f.url, '_blank', 'noopener');
      else this.toast.add({ severity: 'warn', summary: 'Sin archivo', detail: 'El comprobante existe pero no trae un archivo que pueda abrir.' });
    }).catch(() => this.toast.add({
      severity: 'error', summary: 'No pude abrir la factura',
      detail: 'El enlace se firma al momento y expira en 10 minutos. Probá de nuevo.',
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

  private loadCreditos(): void {
    this.http.get<SupplierUnappliedCreditRow[]>(`${this.base}/creditos-a-favor`)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => this.creditos.set(new Map((rows ?? []).filter((r) => r.con_deuda_viva)
          .map((r) => [r.proveedor, { a_favor: Number(r.a_favor), docs: r.docs, clases: r.clases }]))),
        // ⛔ Que falle esto NO puede tumbar la pantalla: es un aviso, no el dato con el que se paga.
        // Se declara en consola y la lista queda vacía, que se lee como «sin avisos» y no como «sin crédito».
        error: () => this.creditos.set(new Map()),
      });
  }

  /** El orden de la lista de deuda, como una sola decisión en vez de dos casillas sueltas. */
  readonly ordenOpts = [
    { label: 'Vence primero', value: 'vencimiento' },
    { label: 'Pierde descuento primero', value: 'descuento' },
  ];
  ordenSel: 'vencimiento' | 'descuento' = 'vencimiento';
  onOrden(): void { this.ordenDescuento = this.ordenSel === 'descuento'; this.loadObligations(); }

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
    if (!day) return { tone: 'muted', say: 'Elige un día en la cola de la izquierda.', why: null, action: null };
    const s = day.summary;

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
          why: 'Caja General dispersa con la instrucción impresa. Cuando el banco confirme, márcalos pagados de una vez; si uno rebota, márcalo en su fila.',
          action: listos ? { kind: 'pagar', label: listos === 1 ? 'Marcar pagado' : `Marcar los ${listos} pagados`, icon: 'pi-check' } : null };
      }
      return { tone: 'ok', say: 'Todos los pagos se marcaron: falta cerrar el día.',
        why: `${ex} de ${this.pagos(n)} marcados como pagados. Cerrar deja el día como terminado.`,
        action: { kind: 'cerrar', label: 'Cerrar el día', icon: 'pi-lock' } };
    }
    if (!s.capacity_defined) {
      return { tone: 'muted', say: 'Presupuestos no fijó el tope de este día.',
        why: 'Se pueden armar pagos, pero el día no se autoriza hasta que lo fije.', action: null };
    }
    if (s.exceeded) {
      return { tone: 'bad',
        say: `Lo comprometido excede el tope del día por ${this.money(Math.abs(Number(s.remaining_amount ?? 0)))}.`,
        why: 'Mueve o quita pagos, o pide a Presupuestos ampliarlo.', action: null };
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
        return { tone: 'ok', say: `Propuesta: ${this.pagos(n)} por ${this.money(this.armadoTotal())}, caben en el tope.`,
          why: `Abajo está cada pago: quita lo que no quieras pagar hoy. Al guardarla, el orden de pago se propone solo.${parcial ? ' ' + parcial : ''}`,
          action: { kind: 'armar', label: 'Guardar la propuesta', icon: 'pi-check' } };
      }
      if (arm) {
        return { tone: 'muted', say: arm.length ? 'Nada de lo vencido cabe en el tope de este día.' : 'No hay facturas vencidas ni por vencer para este día.',
          why: 'Si hay que pagar algo, agrégalo desde «Agregar facturas».', action: null };
      }
      return { tone: 'muted', say: 'Este día no tiene pagos.', why: 'Agrégalos desde «Agregar facturas».', action: null };
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
      const donde = sinMetodo > 1 ? `Elige método y cuenta de origen en «Para los ${this.pendingCount()} pagos»` : `Usa «Preparar» en su fila`;
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
        why: 'Caja General dispersa en ese turno, así que sin orden el día no se autoriza.',
        action: { kind: 'ordenar', label: 'Proponer orden', icon: 'pi-sort-amount-down' } };
    }
    if (this.canAuthorize()) {
      return { tone: 'ok',
        say: `Listo para autorizar: ${this.pagos(this.pendingCount())} por ${this.money(s.assigned_amount)}.`,
        why: 'Autorizas el día completo. Después Caja General dispersa con la instrucción impresa.',
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
  /** [PGP.7] Lee la misma lista por urgencia de descuento en vez de por fecha de pago. */
  ordenDescuento = false;

  obligations = signal<Obligation[]>([]);
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
  quickAddAmount = 0;

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

  // ── [PGP.15] Caja General: marcar pagados de una vez, y el pago que rebota ──────────────────
  pagarVisible = false;
  /** Lo que «Marcar los N pagados» marca: pendiente y preparado (el backend exige método). */
  readonly porPagar = computed(() => this.allocations().filter((a) => a.status === 'pending' && isPrepared(a)));
  readonly porPagarTotal = computed(() => this.porPagar().reduce((s, a) => s + Number(a.amount_assigned || 0), 0));
  reboteVisible = false;
  reboteAllocation: PaymentCalendarAllocation | null = null;
  reboteReason: ReprogramReason | null = null;
  reboteDetail = '';
  reboteDate = '';
  /** Los motivos de reprogramar que describen un rebote («presupuesto recortado» no lo es). */
  readonly reboteReasonOpts = REPROGRAM_REASON_OPTS.filter((o) => o.value !== 'presupuesto_recortado');

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => { cancelAnimationFrame(this.rampaId); this.altoObs?.disconnect(); });
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
    if (this.ordenDescuento) p.set('orden', 'descuento');
    this.http.get<ObligationPage>(`${this.base}/obligations?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (seq !== this.obligSeq) return;
        this.obligations.set(r.rows); this.obligationsTotal.set(r.total);
        this.busquedaAplicada.set(termino);
        this.agregando.set(new Set());
        this.loadingObligations.set(false); this.buscando.set(false);
      },
      error: () => {
        if (seq !== this.obligSeq) return;
        this.loadingObligations.set(false); this.buscando.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las obligaciones.' });
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
    this.enfocarBuscador();
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
    const cap = s.capacity_defined ? `libres ${this.money(s.remaining_amount)} del tope de ${this.money(s.authorized_amount)}` : 'sin tope fijado';
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
    return [
      { label: 'Comprometido', value: Number(s.assigned_amount ?? 0), format: 'currency2', sub: `${this.usedPctRound(d)} % del tope` },
      { label: 'Libre', value: libre, format: 'currency2', tone: libre < 0 ? 'bad' : 'default' },
      { label: 'Tope del día', value: Number(s.authorized_amount ?? 0), format: 'currency2' },
    ];
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
  comoSale(a: PaymentCalendarAllocation): { texto: string; falta: string | null } {
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
    if (!day || this.allocations().length || this.isReleased() || !day.summary.capacity_defined || day.date < this.todayIso) {
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
      const groups = sugerirArmado(programables, fecha, Number(day.summary.remaining_amount ?? 0));
      this.armado.set(groups);
      this.armadoOn.set(new Set(groups.filter((g) => g.fits).map((g) => g.key)));
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
      case 'pagar': this.pagarVisible = true; break;
      case 'cerrar': this.closeLot(); break;
      case 'rebote': { const f = this.allocations().find((a) => a.status === 'failed'); if (f) this.openReprogram(f); break; }
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
  async aplicarATodos(): Promise<void> {
    const m = this.bulkMethod;
    const filas = this.allocations().filter((a) => a.status === 'pending');
    if (!m || !filas.length || (m !== 'efectivo' && !this.bulkOriginId)) return;
    const usaDestino = m === 'transferencia' || m === 'cargo_automatico';
    this.saving.set(true);
    const favs = new Map<string, string | null | 'error'>();
    let ok = 0, conFavorita = 0;
    const sinDestino: string[] = [], sinCatalogo: string[] = [], fallas: string[] = [];
    for (const a of filas) {
      const cambio: Record<string, unknown> = { payment_method: m, bank_account_id: m === 'efectivo' ? null : this.bulkOriginId };
      const tieneDestino = !!a.supplier_payment_account_id || !!(a.destination_account_text ?? '').trim();
      let puso = false, catalogoCaido = false;
      if (usaDestino && !tieneDestino) {
        const sid = this.proveedorDe(a);
        if (sid) {
          if (!favs.has(sid)) favs.set(sid, await this.favoritaDe(sid));
          const fav = favs.get(sid);
          if (fav === 'error') catalogoCaido = true;
          else if (fav) { cambio['supplier_payment_account_id'] = fav; puso = true; }
        }
      }
      try {
        await firstValueFrom(this.http.post(`${this.base}/allocations/${a.id}/preparar`, this.cuerpoPreparar(a, cambio)));
        ok++;
        if (puso) conFavorita++;
        if (usaDestino && !tieneDestino && !puso) (catalogoCaido ? sinCatalogo : sinDestino).push(this.allocationTitle(a));
      } catch (e) {
        fallas.push(`${this.allocationTitle(a)}: ${this.errMsg(e, 'error')}`);
      }
    }
    this.saving.set(false);
    this.recordarPreparacion();
    this.loadWeek();
    if (ok) this.toast.add({ severity: 'success', summary: `${ok} de ${this.pagos(filas.length)} preparados`, detail: conFavorita ? `${conFavorita} con la cuenta favorita de su proveedor.` : undefined });
    if (sinDestino.length) this.toast.add({ severity: 'warn', summary: `${sinDestino.length} sin cuenta destino`, detail: `${sinDestino.join(', ')}: su proveedor no tiene cuenta favorita en el catálogo. Captúrala con «Preparar».`, life: 10000 });
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
      if (v && !this.bulkMethod) { this.bulkMethod = v.m ?? null; this.bulkOriginId = v.o ?? null; }
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
  numero(v: number | string | null | undefined): number { return Number(v) || 0; }
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
      const r = await this.assign(fecha, [{ o, amount: Number(this.quickAddAmount) }]);
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
    this.prepSupplierId = this.proveedorDe(a);
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

  // ── Reprogramar (con motivo — TP.10) ───────────────────────────────────
  openReprogram(a: PaymentCalendarAllocation): void {
    this.reprogramAllocation = a; this.reprogramDate = this.siguienteHabil(); this.reprogramReason = null; this.reprogramReasonDetail = '';
    this.reprogramVisible = true;
  }
  async confirmReprogram(): Promise<void> {
    const a = this.reprogramAllocation;
    if (!a || !this.reprogramReason) { this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'Selecciona por qué se reprograma.' }); return; }
    if (this.reprogramReason === 'otro' && !this.reprogramReasonDetail.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el detalle', detail: 'Describe el motivo "otro".' }); return; }
    const fecha = this.reprogramDate;
    this.saving.set(true);
    try {
      const movido = await firstValueFrom(this.http.post<{ id?: string } | null>(`${this.base}/allocations/${a.id}/reprogramar`, {
        date: fecha, reason: this.reprogramReason, reason_detail: this.reprogramReasonDetail || undefined,
      }));
      await this.ordenarNuevos(fecha, movido?.id ? [movido.id] : []);
      this.reprogramVisible = false;
      this.toast.add({ severity: 'success', summary: 'Movido', detail: `${this.allocationTitle(a)} pasó al ${this.dayLong(fecha)}.` });
    } catch (e) {
      this.toast.add({ severity: 'error', summary: 'No se movió', detail: this.errMsg(e, 'No se pudo reprogramar.') });
    } finally { this.saving.set(false); this.invalidarDeuda(); this.reload(); }
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
  printCajaGeneral(): void { this.openPdf(`${this.base}/days/${this.selectedDate()}/caja-general.pdf`); }

  // ── Caja General: pagar, rebote y cierre ([PGP.15]) ─────────────────────
  execute(a: PaymentCalendarAllocation): void {
    this.saving.set(true);
    this.http.post(`${this.base}/allocations/${a.id}/ejecutar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.reload(); this.toast.add({ severity: 'success', summary: 'Marcado pagado', detail: `${this.allocationTitle(a)} · ${this.money(a.amount_assigned)}.` }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'No se marcó', detail: e?.error?.message || 'No se pudo marcar como pagado.' }); },
    });
  }
  /**
   * `[PGP.15]` **Marcar los N pagados de una vez.** Eran N botones, uno por fila. Se marca uno por
   * uno contra el backend —que vuelve a validar que Kepler todavía deba cada factura— y un fallo
   * no detiene a los demás: se dice cuáles sí y cuáles no (DESIGN §10, fallos parciales).
   */
  async confirmPagar(): Promise<void> {
    const filas = this.porPagar();
    if (!filas.length) return;
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
    if (ok) this.toast.add({ severity: 'success', summary: `${ok} de ${this.pagos(filas.length)} marcados pagados` });
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
  cancelAllocation(a: PaymentCalendarAllocation): void {
    this.http.post(`${this.base}/allocations/${a.id}/cancelar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.invalidarDeuda(); this.reload(); this.toast.add({ severity: 'info', summary: 'Quitado del día', detail: `${this.allocationTitle(a)} regresa a lo que se debe.` }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo quitar.' }),
    });
  }

  releaseLot(): void {
    this.saving.set(true);
    this.http.post(`${this.base}/days/${this.selectedDate()}/liberar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.reload(); this.toast.add({ severity: 'success', summary: 'Autorizado', detail: 'El día quedó autorizado: Caja General ya puede imprimir su instrucción y dispersar.' }); },
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
