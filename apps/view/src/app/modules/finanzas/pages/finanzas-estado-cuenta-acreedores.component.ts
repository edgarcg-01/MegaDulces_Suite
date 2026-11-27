import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TagModule } from 'primeng/tag';
import { EVIDENCIA_REFS_POR_CONSULTA, warehouseName } from '@megadulces/contracts';
import type {
  AcreedorDocEstado, AcreedorDocumento, AcreedorEstadoCuentaResponse, AcreedorPagoSinAplicar, AcreedorResumen, AcreedorTipo, AcreedorTipoTotal,
  AcreedoresResponse, PayableEvidenceFile, PayableEvidenceQuery, PayableEvidenceRow,
} from '@megadulces/contracts';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarUrl } from '../../../shared/util/abrir-pdf';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { DEUDA_PROVEEDORES_TABS } from '../deuda-proveedores-tabs';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

/** Los tipos que se eligen en la pantalla. `interno` (traspasos TI) no se lista: no es deuda. */
const TIPOS: { tipo: AcreedorTipo; label: string }[] = [
  { tipo: 'mercancia', label: 'Mercancía' },
  { tipo: 'servicios', label: 'Servicios' },
  { tipo: 'financiero', label: 'Financieros' },
  { tipo: 'sin_clasificar', label: 'Sin clasificar' },
];

const ESTADO: Record<AcreedorDocEstado, { label: string; sev: Sev }> = {
  pendiente: { label: 'Pendiente', sev: 'warn' },
  parcial: { label: 'Parcial', sev: 'info' },
  pagado: { label: 'Pagado', sev: 'success' },
  sobreaplicado: { label: 'Pagado de más', sev: 'danger' },
  cancelado: { label: 'Cancelado', sev: 'secondary' },
};

/** Lo que tiene que quedar abajo de esto para contar como saldo (centavos de redondeo de Kepler). */
const TOL = 0.005;

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * `[ECA.9]` Un importe se busca como se escriba: «1,000.00», «1000.00» o «1000». `String(1000)` da «1000» y
 * `String(2500.5)` da «2500.5»: sin la forma con dos decimales, «1000.00» y «2500.50» no encontraban nada.
 */
const importesBuscables = (n: number | null | undefined): (string | number)[] =>
  typeof n === 'number' && Number.isFinite(n) ? [n, n.toFixed(2), money(n)] : [];
/** `[ECA.9]` Una fecha se busca como «27/12/25», «27/12/2025» o «2025-12-27». */
const fechasBuscables = (f: string | null | undefined): string[] => {
  const m = String(f ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? [dmy(f), `${m[3]}/${m[2]}/${m[1]}`, `${m[1]}-${m[2]}-${m[3]}`] : f ? [String(f)] : [];
};

/**
 * `[ECA.2]` Estado de cuenta de acreedores — el reporte "Estado de cuenta del proveedor" de Kepler,
 * para todos los acreedores y separado por tipo (mercancía, servicios, financieros).
 *
 * Cada documento que sube la deuda (p. ej. "Aplica Orden Entrada") sale con los pagos y notas de
 * crédito que Kepler le aplicó, y su saldo. El casamiento es el de Kepler (`kdxf`), no una
 * estimación. Sólo lectura: los pagos se siguen capturando y aplicando en Kepler.
 *
 * `[ECA.9]` (Francisco, 2026-11-20) **Del acreedor a la factura, y de la factura al pago.** Medido en
 * prod ese día: 35 acreedores con 20+ documentos con saldo, 12 con 50+ y 4 con 100+ (CL005: 179); con
 * los pagados de 3 meses, hasta 497. Los documentos empezaban al 89 % del alto de la pantalla (lo de
 * arriba era marco). Ahora: el marco se compacta, los documentos se BUSCAN, la factura del proveedor
 * se abre en un clic (la misma evidencia de Pagos, `[PGP.21]`) y «Agendar» lleva al Calendario en la
 * fecha que toca con la factura ya buscada.
 */
@Component({
  selector: 'app-finanzas-estado-cuenta-acreedores',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, FormsModule, ButtonModule, TableModule, InputTextModule, DatePickerModule, ToggleSwitchModule, TagModule, MetricStripComponent, SucursalPipe, PageTabsComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Estado de cuenta de acreedores</h1>
          <p class="surf-page-sub">Lo que se le debe a cada acreedor según Kepler, factura por factura. Sólo lectura: los pagos se aplican en Kepler.</p>
        </div>
        <div class="ec-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <app-page-tabs [tabs]="apartadoTabs" />

      @if (err(); as e) { <div class="ec-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="ec-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track $index) { <div class="fb-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <!-- [ECA.9] El tipo y sus cuatro cifras en UN renglón: eran tres bandas (selector, nota TI y tira grande). -->
        <div class="ec-top">
          <div class="ec-seg" role="group" aria-label="Tipo de acreedor">
            @for (t of tiposVisibles(); track t.tipo) {
              <button type="button" class="ec-seg-btn" [class.on]="tipo() === t.tipo" [attr.aria-pressed]="tipo() === t.tipo" (click)="pickTipo(t.tipo)">
                {{ t.label }} <span class="ec-seg-n">{{ total(t.tipo)?.acreedores ?? 0 }}</span>
              </button>
            }
          </div>
          <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del tipo de acreedor" density="compact" [instant]="true" />
        </div>

        @if (totalSel(); as t) { @if (t.pendiente_sucursal_antes_corte > 0.005) {
          <p class="ec-note" role="note"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span><b>{{ money(t.pendiente_sucursal_antes_corte) }}</b> de lo pendiente son facturas en el Kepler de una <b>sucursal</b> con fecha anterior al <b>01/10/2026</b>. Hasta esa fecha {{ '00' | sucursal }} concentraba los pagos: muchas pudieron pagarse desde ahí sin aplicarse en la sucursal. Revísalas antes de tratarlas como deuda.</span></p>
        } }

        <div class="ec-split">
          <section class="ec-block dt-scope" aria-labelledby="ec-h-list">
            <div class="ec-bh">
              <h2 id="ec-h-list">Acreedores</h2>
              <input pInputText type="search" class="ec-search" placeholder="Buscar clave, nombre o RFC" aria-label="Buscar acreedor" [ngModel]="q()" (ngModelChange)="q.set($event)" />
            </div>
            <p-table [value]="lista()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="62vh" selectionMode="single" [selection]="sel()" (selectionChange)="pick($event)" dataKey="codigo">
              <ng-template #header><tr><th>Acreedor</th><th class="ta-r">Pendiente</th><th class="ta-r">Vencido</th><th class="ta-r">Saldo</th></tr></ng-template>
              <ng-template #body let-a>
                <tr [pSelectableRow]="a">
                  <td role="cell" data-label="Acreedor"><div class="ec-name">{{ a.nombre }}</div><div class="ec-hint"><span class="ec-mono">{{ a.codigo }}</span>@if (a.grupo_nombre) { · {{ a.grupo_nombre }} }@if (a.documentos_pendientes) { · {{ a.documentos_pendientes }} doc. pendiente(s) }</div></td>
                  <td class="ta-r num" role="cell" data-label="Pendiente" [class.muted]="!a.pendiente">{{ a.pendiente ? money(a.pendiente) : '—' }}</td>
                  <td class="ta-r num" role="cell" data-label="Vencido" [class.ec-bad]="a.vencido > 0.005" [class.muted]="!a.vencido">{{ a.vencido ? money(a.vencido) : '—' }}</td>
                  <td class="ta-r num ec-strong" role="cell" data-label="Saldo">{{ money(a.saldo) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="ec-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>{{ q() ? 'Ningún acreedor coincide con la búsqueda.' : 'Sin acreedores de este tipo.' }}</span></div></td></tr></ng-template>
            </p-table>
            <p class="ec-hint ec-pad">{{ lista().length }} acreedor(es), de mayor a menor saldo.
              @if (total('interno'); as ti) { @if (ti.acreedores) { Los traspasos entre sucursales ({{ ti.acreedores }} claves <span class="ec-mono">TI</span>) no se listan: no son deuda con un tercero. } }</p>
          </section>

          <section class="ec-block ec-detail" aria-labelledby="ec-h-det">
            @if (sel(); as a) {
              <div class="ec-bh"><h2 id="ec-h-det">{{ a.nombre }}</h2><span class="ec-mono muted">{{ a.codigo }}</span></div>
              @if (det(); as e) {
                <!-- [ECA.9] La ficha en una línea: eran cinco campos en dos renglones (~110 px) que no deciden el pago. -->
                <dl class="ec-ficha">
                  @if (e.acreedor.rfc) { <div><dt>RFC</dt><dd class="ec-mono">{{ e.acreedor.rfc }}</dd></div> }
                  @if (e.acreedor.grupo) { <div><dt>Grupo</dt><dd>{{ e.acreedor.grupo_nombre }} <span class="muted ec-mono">{{ e.acreedor.grupo }}</span></dd></div> }
                  @else { <div><dt>Grupo</dt><dd class="muted">sin grupo en Kepler; el tipo sale de la clave</dd></div> }
                  @if (e.acreedor.dias_credito) { <div><dt>Crédito</dt><dd>{{ e.acreedor.dias_credito }} días</dd></div> }
                  @if (e.acreedor.telefono) { <div><dt>Tel.</dt><dd class="ec-mono">{{ e.acreedor.telefono }}</dd></div> }
                  @if (e.acreedor.direccion) { <div><dt>Dirección</dt><dd>{{ e.acreedor.direccion }}</dd></div> }
                </dl>
              }

              <!-- [ECA.9] Buscar, filtrar y lo que se está viendo, en un solo renglón. -->
              <div class="ec-tools">
                <span class="ec-buscar">
                  <i class="pi pi-search" aria-hidden="true"></i>
                  <input id="ec-qdoc" pInputText type="search" autocomplete="off" enterkeyhint="search" class="ec-buscar-in"
                         placeholder="Buscar folio, referencia, importe o fecha" aria-label="Buscar en los documentos del acreedor"
                         aria-describedby="ec-doc-dice" [ngModel]="qDocTxt()" (ngModelChange)="alEscribirDoc($event)" (keydown.escape)="limpiarQDoc($event)" />
                </span>
                <span class="ec-toggle"><p-toggleswitch inputId="ec-pend" [ngModel]="soloPendientes()" (ngModelChange)="setSoloPendientes($event)" /><label for="ec-pend">Sólo con saldo</label></span>
                @if (!soloPendientes()) {
                  <span class="ec-rango"><label for="ec-rango">Fecha del documento</label>
                    <p-datepicker inputId="ec-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Elegir fechas" (onClose)="onRange()" /></span>
                }
                <span id="ec-doc-dice" class="ec-dice" aria-live="polite">
                  @if (det()) {
                    {{ docsDice() }}
                    @if (evidEstado() === 'fallo') {
                      · <span class="ec-bad">No se pudieron buscar las facturas</span> <button type="button" class="ec-link" (click)="reintentarEvid()">Reintentar</button>
                    } @else if (evidDice(); as ev) { · {{ ev }} }
                  }
                </span>
              </div>
              <!-- La región viva existe SIEMPRE; sólo cambia lo de adentro: una región que nace ya llena no siempre se anuncia. -->
              <div role="status">
                @if (aviso(); as av) {
                  <p class="ec-aviso" [class.is-bad]="av.mal"><i class="pi" [class.pi-exclamation-triangle]="av.mal" [class.pi-check]="!av.mal" aria-hidden="true"></i>{{ av.txt }}
                    <button type="button" class="ec-link" (click)="aviso.set(null)" aria-label="Cerrar el aviso">Cerrar</button></p>
                }
              </div>

              @if (detErr(); as e) { <p class="ec-hint ec-pad ec-bad">{{ e }} <button type="button" class="ec-link" (click)="loadDet()">Reintentar</button></p> }
              @if (detLoading()) { <div class="fb-skeleton ec-pad" aria-busy="true">@for (i of skel.slice(0, 4); track i) { <div class="fb-skel-row"></div> }</div> }
              @else if (det(); as e) {
                <div class="ec-tots">
                  <span>Pendiente <b class="num">{{ money(e.totales.pendiente) }}</b></span>
                  <span>Vencido <b class="num" [class.ec-bad]="e.totales.vencido > 0.005">{{ money(e.totales.vencido) }}</b></span>
                  <span>Pagos sin aplicar <b class="num">{{ money(e.totales.pagos_sin_aplicar) }}</b></span>
                  <span>Saldo <b class="num">{{ money(e.totales.saldo) }}</b></span>
                  <!-- [ECA.8] Lo que el Calendario ya aparta de este acreedor, y lo que falta programar. -->
                  <!-- Un API anterior a ECA.8 no manda «calendario»: se DECLARA no leído, no se rompe la tabla. -->
                  @if (e.calendario?.medido) {
                    <span class="ec-tot-cal">En el Calendario <b class="num">{{ money(e.calendario.programado) }}</b>
                      ({{ e.calendario.documentos }} {{ e.calendario.documentos === 1 ? 'factura' : 'facturas' }}) · sin programar <b class="num">{{ money(e.calendario.sin_programar) }}</b></span>
                  } @else {
                    <span class="ec-tot-cal">En el Calendario <b class="ec-bad">no se pudo leer</b>: no se sabe qué está programado, no se dibuja como «nada» ni se ofrece «Agendar».</span>
                  }
                </div>

                <!-- [ECA.9] dt-scope + dt-stack (libs/ui-web/dense-table.css): en un teléfono cada documento se apila con sus
                     rótulos. Medido: una columna de acciones FIJADA a la derecha tapaba «Vence» y «Saldo» en 750 y 390 px. -->
                <div class="ec-scroll dt-scope">
                  <table class="ec-st dt-stack" aria-label="Documentos del acreedor">
                    <!-- [ECA.9] «Cargo» y «Abono» (los del reporte de Kepler, casi siempre media columna vacía) son UNA: «Importe»;
                         lo aplicado va con signo menos. Medido a 1440 px: con las dos, las acciones quedaban fuera de la vista. -->
                    <thead><tr><th scope="col">Suc</th><th scope="col">Documento</th><th scope="col">Folio</th><th scope="col">Fecha</th><th scope="col">Referencia</th><th scope="col" class="ta-r">Importe</th><th scope="col">Vence</th><th scope="col" class="ta-r">Saldo</th><th scope="col" class="ec-acts-th"><span class="sr-only">Factura y agendar</span></th></tr></thead>
                    @for (doc of docsVisibles(); track doc.sucursal + doc.tipo_doc + doc.sub + doc.folio) {
                      <tbody class="ec-doc">
                        <!-- [ECA.9] El saldo del documento va EN su renglón, bajo «Saldo»: antes esa columna mostraba el estado y el saldo vivía en un renglón aparte. -->
                        <tr class="ec-doc-row">
                          <td role="cell" data-label="Sucursal" class="muted">{{ doc.sucursal | sucursal }}</td>
                          <td role="cell" class="dt-id">{{ doc.documento }} <p-tag [value]="estadoLabel(doc.estado)" [severity]="estadoSev(doc.estado)" styleClass="ec-tag" /></td>
                          <td role="cell" data-label="Folio" class="ec-mono">{{ doc.folio }}</td>
                          <td role="cell" data-label="Fecha" class="ec-mono">{{ dmy(doc.fecha) }}</td>
                          <td role="cell" data-label="Referencia" class="ec-mono ec-ref" [class.dt-omit]="!doc.referencia">{{ doc.referencia || '' }}</td>
                          <td role="cell" data-label="Importe" class="ta-r num dt-num">{{ money(doc.importe) }}</td>
                          <!-- [ECA.9] «Vencida» no va sólo en rojo: con alto contraste de Windows el color se pierde (medido). -->
                          <td role="cell" data-label="Vence" class="ec-mono" [class.ec-bad]="doc.vencido"><span>@if (doc.vencido) { <i class="pi pi-exclamation-circle ec-venc-i" aria-hidden="true"></i><span class="sr-only">vencida el </span> }{{ doc.vence ? dmy(doc.vence) : 'sin fecha' }}</span></td>
                          <td role="cell" data-label="Saldo" class="ta-r num dt-num ec-strong" [class.ec-bad]="doc.saldo > 0.005 && doc.vencido">{{ money(doc.saldo) }}</td>
                          <td role="cell" class="ec-acts-td dt-actions" [class.dt-omit]="!conSaldo(doc)">
                            @if (conSaldo(doc)) {
                              <span class="ec-acts">
                                <!-- [ECA.9] La factura del proveedor: la MISMA evidencia que Pagos (PGP.21), pedida en diferido. -->
                                @if (evid().get(llaveDoc(doc)); as ev) {
                                  @if (ev.evidencia === 'pdf') {
                                    <button type="button" class="ec-act" (click)="abrirFactura(doc, ev)" [attr.aria-label]="'Abrir el PDF de la factura ' + doc.folio"><i class="pi pi-file-pdf" aria-hidden="true"></i>PDF</button>
                                  } @else if (ev.evidencia === 'uuid') {
                                    <button type="button" class="ec-act ec-act-q" (click)="copiarUuid(doc, ev)" [attr.aria-label]="'No hay PDF de la factura ' + doc.folio + '. Copiar el UUID de su CFDI'"><i class="pi pi-copy" aria-hidden="true"></i>UUID</button>
                                  } @else {
                                    <span class="ec-ev-nm" [title]="ev.motivo || ''">Sin PDF</span>
                                  }
                                } @else if (evidEstado() === 'listo') {
                                  <span class="ec-ev-nm">—</span>
                                }
                                @if (puedeAgendar(doc)) {
                                  <a class="ec-act" routerLink="/finanzas/calendario-pagos" [queryParams]="agendarQp(a, doc, e.al)" [attr.aria-label]="agendarAria(doc, e.al)"><i class="pi pi-calendar-plus" aria-hidden="true"></i>{{ agendarTxt(doc, e.al) }}</a>
                                }
                              </span>
                            }
                          </td>
                        </tr>
                        @for (ap of doc.aplicaciones; track ap.tipo_doc + ap.folio) {
                          <tr class="ec-ap-row" [class.ec-cancel]="ap.cancelado">
                            <td role="cell" class="dt-omit"></td>
                            <td role="cell" data-label="Aplicado" class="ec-ap-name">{{ ap.documento }}@if (ap.cancelado) { <p-tag value="Cancelada" severity="secondary" styleClass="ec-tag" /> }</td>
                            <td role="cell" data-label="Folio" class="ec-mono">{{ ap.folio }}</td>
                            <td role="cell" data-label="Fecha" class="ec-mono">{{ dmy(ap.fecha) }}</td>
                            <td role="cell" data-label="Referencia" class="ec-mono ec-ref" [class.dt-omit]="!ap.referencia">{{ ap.referencia || '' }}</td>
                            <td role="cell" data-label="Importe" class="ta-r num dt-num"><span class="ec-cancel-amt">−{{ money(ap.importe) }}</span></td>
                            <td role="cell" class="dt-omit"></td><td role="cell" class="dt-omit"></td><td role="cell" class="dt-omit"></td>
                          </tr>
                        }
                        <!-- [ECA.8] En qué pago del Calendario está: programada, en un día que ya pasó, o ya cubierta. -->
                        @for (p of doc.programado ?? []; track $index) {
                          <tr class="ec-prog-row"><td role="cell" colspan="9">
                            <div class="ec-prog" [class.is-late]="p.dia_pasado" [class.is-paid]="p.estado === 'ejecutado'">
                              <i class="pi" [class.pi-calendar]="p.estado === 'pendiente' && !p.dia_pasado" [class.pi-exclamation-triangle]="p.dia_pasado" [class.pi-check]="p.estado === 'ejecutado'" aria-hidden="true"></i>
                              <span class="ec-prog-txt">
                                @if (p.estado === 'ejecutado') {
                                  <b>Cubierta el {{ diaLargo(p.pagado_el || p.fecha) }}{{ p.metodo ? ' por ' + p.metodo : '' }}</b> · <span class="num">{{ money(p.cubierto) }}</span>@if (p.banco) { · desde {{ p.banco }} }@if (p.referencia) { · ref. <span class="ec-mono">{{ p.referencia }}</span> }
                                  @if (p.aplicado_en_kepler) {
                                    <!-- [PGP.206] Sin ligar no hay folio que nombrar: Kepler la tiene (su documento está en las aplicaciones de arriba). -->
                                    <span class="ec-prog-sub">· Kepler ya la aplicó@if (p.kepler_folio) { (pago <span class="ec-mono">{{ p.kepler_folio }}</span>)}.</span>
                                  } @else {
                                    <span class="ec-prog-sub">· Kepler aún no la aplica: no la vuelvas a programar.</span>
                                  }
                                } @else if (p.dia_pasado) {
                                  <!-- Revisión independiente: un pendiente en un día pasado sólo prueba que nadie lo marcó pagado, no que no salió del banco. -->
                                  <b>Se programó para el {{ diaLargo(p.fecha) }} y no se marcó como pagado.</b> El pago sigue apartando <span class="num">{{ money(p.cubierto) }}</span>: si ya salió del banco, márcalo pagado; si no, muévelo a otro día.
                                } @else {
                                  Programada en el Calendario para el <b>{{ diaLargo(p.fecha) }}</b> · <span class="num">{{ money(p.cubierto) }}</span>
                                  @if (p.facturas_en_pago > 1) { · en un pago de {{ p.facturas_en_pago }} facturas por <span class="num">{{ money(p.total_pago) }}</span> }
                                  @if (p.creado_por) { <span class="ec-prog-sub">· la agregó {{ p.creado_por }}</span> }
                                }
                                @if ($last && sinProgramar(doc) > 0.005) {
                                  <span class="ec-prog-sub">· quedan <b class="num">{{ money(sinProgramar(doc)) }}</b> sin programar</span>
                                }
                                @if (doc.cancelado) {
                                  <b class="ec-bad"> · La factura está cancelada en Kepler: revisa este pago.</b>
                                }
                              </span>
                              <a class="ec-prog-go" routerLink="/finanzas/calendario-pagos" [queryParams]="{ fecha: p.fecha }"
                                 [attr.aria-label]="'Abrir el Calendario en el ' + diaLargo(p.fecha) + ', folio ' + doc.folio">{{ p.dia_pasado ? 'Ir al ' + dm(p.fecha) : 'Ver el ' + dm(p.fecha) }} <i class="pi pi-arrow-right" aria-hidden="true"></i></a>
                            </div>
                          </td></tr>
                        }
                      </tbody>
                    } @empty {
                      <tbody><tr><td colspan="9"><div class="ec-empty">
                        @if (qDoc()) {
                          <i class="pi pi-search" aria-hidden="true"></i>
                          <span>Ningún documento {{ e.solo_pendientes ? 'con saldo' : 'del ' + dmy(e.periodo?.from) + ' al ' + dmy(e.periodo?.to) }} coincide con «{{ qDoc() }}».</span>
                          <span class="ec-empty-acts">
                            <button type="button" class="ec-link" (click)="limpiarQDoc()">Limpiar la búsqueda</button>
                            @if (e.solo_pendientes) { <button type="button" class="ec-link" (click)="buscarEnPagados()">Buscar también en los pagados (12 meses)</button> }
                            @else if (puedeAmpliar(e)) { <button type="button" class="ec-link" (click)="buscarEnPagados()">Ampliar a los últimos 12 meses</button> }
                          </span>
                        } @else {
                          <i class="pi pi-check-circle" aria-hidden="true"></i>
                          <span>{{ e.solo_pendientes ? 'Ningún documento con saldo: todo lo facturado tiene su pago aplicado.' : 'Sin documentos en el periodo.' }}</span>
                        }
                      </div></td></tr></tbody>
                    }
                  </table>
                </div>

                @if (pagosVisibles().length) {
                  <div class="ec-sub dt-scope">
                    <h3>Pagos y notas sin aplicar</h3>
                    <p class="ec-hint">Registrados en Kepler pero todavía no aplicados a ninguna factura: son saldo a favor (anticipos, pagos por aplicar).@if (qDoc()) { Con «{{ qDoc() }}»: {{ pagosVisibles().length }} de {{ e.pagos_sin_aplicar.length }}. }</p>
                    <table class="ec-st dt-stack" aria-label="Pagos y notas sin aplicar">
                      <thead><tr><th scope="col">Suc</th><th scope="col">Documento</th><th scope="col">Folio</th><th scope="col">Fecha</th><th scope="col">Referencia</th><th scope="col" class="ta-r">Importe</th><th scope="col" class="ta-r">Sin aplicar</th></tr></thead>
                      <tbody>
                        @for (p of pagosVisibles(); track p.sucursal + p.tipo_doc + p.folio) {
                          <tr><td role="cell" data-label="Sucursal" class="muted">{{ p.sucursal | sucursal }}</td><td role="cell" class="dt-id">{{ p.documento }}</td><td role="cell" data-label="Folio" class="ec-mono">{{ p.folio }}</td><td role="cell" data-label="Fecha" class="ec-mono">{{ dmy(p.fecha) }}</td><td role="cell" data-label="Referencia" class="ec-mono ec-ref" [class.dt-omit]="!p.referencia">{{ p.referencia || '' }}</td><td role="cell" data-label="Importe" class="ta-r num dt-num">{{ money(p.importe) }}</td><td role="cell" data-label="Sin aplicar" class="ta-r num dt-num ec-strong">{{ money(p.remanente) }}</td></tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
                <p class="ec-hint ec-pad">Saldo al {{ dmy(e.al) }}. Importe = lo que sube la deuda; con signo menos, los pagos y notas que Kepler le aplicó. Vencido = factura con saldo cuya fecha de vencimiento ya pasó; las que Kepler no trae con vencimiento no cuentan como vencidas. Lo cancelado en Kepler se muestra tachado y no rebaja el saldo.
                  La factura del proveedor se busca sólo en los documentos con saldo; «Agendar» abre el Calendario en su vencimiento, o en hoy si ya venció.</p>
              }
            } @else {
              <div class="ec-empty ec-pad"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Elige un acreedor para ver su estado de cuenta.</span></div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .ec-actions { display:flex; gap:.5rem; align-items:center; }
    /* [ECA.9] Selector y cifras del tipo en un renglón; en estrecho, se apilan. */
    .ec-top { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-2) var(--sp-6); margin:var(--sp-2) 0; }
    /* Base de 52rem: si no cabe junto al selector, la tira baja ENTERA a su renglón en vez de partirse por dentro (medido a 1440). */
    .ec-top app-metric-strip { display:block; flex:1 1 52rem; min-width:0; }
    .ec-seg { display:inline-flex; flex-wrap:wrap; gap:0; border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; background:var(--card-bg); }
    .ec-seg-btn { border:0; border-right:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); padding:.45rem .9rem; cursor:pointer; display:inline-flex; align-items:center; gap:.4rem; }
    .ec-seg-btn:last-child { border-right:0; }
    .ec-seg-btn:hover { background:var(--hover-bg); }
    .ec-seg-btn.on { background:var(--action); color:var(--action-ink); font-weight:600; }
    .ec-seg-btn:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
    .ec-seg-n { font-family:var(--font-mono); font-size:var(--fs-micro); opacity:.8; }
    /* [ECA.9] El aviso del corte sin caja: el monto y su porqué siguen a la vista, el marco no. */
    .ec-note { display:flex; gap:.5rem; align-items:flex-start; margin:0 0 var(--sp-3); font-size:var(--fs-xs); color:var(--text-main); }
    .ec-note .pi { color:var(--warn-soft-fg); margin-top:.1rem; }
    /* [ECA.9] 1 : 2 — el trabajo es el estado de cuenta; la lista sólo elige (antes 1 : 1.7, y a 1440 la tabla se desbordaba). */
    .ec-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,2fr); gap:1rem; align-items:start; }
    /* Medido a 1440: con 1 : 2 la tabla no cabía (saldo y acciones fuera). Hasta 100rem la lista cede: 1 : 2.6. */
    @media (max-width:100rem) { .ec-split { grid-template-columns:minmax(17rem,1fr) minmax(0,2.6fr); } }
    @media (max-width:75rem) { .ec-split { grid-template-columns:minmax(0,1fr); } }
    .ec-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; margin-bottom:1rem; }
    .ec-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .ec-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .ec-detail .ec-bh { border-bottom:0; padding-bottom:0; }
    .ec-search { min-width:14rem; }
    .ec-name { font-weight:600; }
    .ec-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .ec-pad { padding:.5rem .85rem; }
    /* [ECA.9] La ficha del acreedor en una línea que se parte sola. */
    .ec-ficha { display:flex; flex-wrap:wrap; gap:var(--sp-1) var(--sp-4); margin:0; padding:var(--sp-1) .85rem 0; font-size:var(--fs-xs); }
    .ec-ficha div { display:inline-flex; gap:.3rem; align-items:baseline; min-width:0; }
    .ec-ficha dt { color:var(--text-muted); }
    .ec-ficha dd { margin:0; color:var(--text-main); }
    .ec-tools { display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-4); align-items:center; padding:var(--sp-2) .85rem; }
    .ec-buscar { position:relative; display:inline-flex; align-items:center; flex:0 1 22rem; min-width:14rem; }
    .ec-buscar .pi { position:absolute; left:.65rem; color:var(--text-muted); font-size:var(--fs-sm); pointer-events:none; }
    .ec-buscar-in { width:100%; padding-left:2rem; }
    .ec-toggle { display:inline-flex; align-items:center; gap:.45rem; font-size:var(--fs-sm); }
    .ec-rango { display:inline-flex; align-items:center; gap:.45rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ec-dice { flex:1 1 16rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .ec-link { border:0; background:transparent; padding:.1rem .2rem; color:var(--action); font:inherit; font-weight:600; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
    .ec-link:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .ec-aviso { display:flex; align-items:center; gap:.45rem; margin:0 .85rem var(--sp-2); padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-sm); font-size:var(--fs-xs); }
    .ec-aviso.is-bad { border-color:var(--bad-border); background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .ec-aviso .ec-link { margin-left:auto; }
    .ec-tots { display:flex; flex-wrap:wrap; gap:var(--sp-1) var(--sp-5); padding:0 .85rem var(--sp-2); font-size:var(--fs-xs); color:var(--text-muted); }
    .ec-tots b { font-size:var(--fs-sm); color:var(--text-main); margin-left:.2rem; }
    .ec-tots .ec-tot-cal { color:var(--text-main); }
    /* [ECA.8] La franja del Calendario debajo de la factura: programada, roja si el día pasó, verde si ya se cubrió. */
    .ec-prog-row td { padding:.15rem .5rem .3rem; }
    .ec-prog { display:flex; flex-wrap:wrap; align-items:center; gap:.25rem .6rem; margin-left:1.4rem; padding:.4rem .6rem; border:1px solid var(--action-ring); border-radius:var(--r-sm); background:color-mix(in srgb, var(--action) 7%, transparent); color:var(--text-main); font-size:var(--fs-sm); }
    .ec-prog > .pi { color:var(--action); }
    /* [ECA.9] Texto sobre los fondos suaves con su -soft-fg: --bad-fg daba 3.95:1 y --ok-fg 3.00:1 en claro (AA pide 4.5). */
    .ec-prog.is-late { border-color:var(--bad-border); background:var(--bad-soft-bg); }
    .ec-prog.is-late > .pi, .ec-prog.is-late b { color:var(--bad-soft-fg); }
    .ec-prog.is-paid { border-color:var(--ok-border); background:var(--ok-soft-bg); }
    .ec-prog.is-paid > .pi, .ec-prog.is-paid > .ec-prog-txt > b { color:var(--ok-soft-fg); }
    .ec-prog-txt { flex:1 1 20rem; min-width:0; }
    .ec-prog-sub { color:var(--text-muted); }
    .ec-prog-go { display:inline-flex; align-items:center; gap:.3rem; margin-left:auto; padding:.2rem .4rem; border-radius:var(--r-sm); color:var(--action); font-weight:600; text-decoration:none; white-space:nowrap; }
    .ec-prog.is-late .ec-prog-go { color:var(--bad-soft-fg); }
    .ec-prog.is-paid .ec-prog-go { color:var(--ok-soft-fg); }
    .ec-prog-go:hover { background:var(--overlay-hover); }
    .ec-prog-go:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .ec-scroll { overflow:auto; max-height:62vh; border-top:1px solid var(--border-color); }
    .ec-st { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .ec-st thead th { position:sticky; top:0; z-index:1; background:var(--card-bg); font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .ec-st td { padding:.2rem .5rem; vertical-align:top; }
    .ec-doc + .ec-doc .ec-doc-row td { border-top:1px solid var(--border-color); }
    .ec-doc-row td { padding-top:.45rem; padding-bottom:.35rem; }
    .ec-ap-row td { color:var(--text-muted); }
    .ec-ap-name { padding-left:1.4rem !important; }
    .ec-cancel td { opacity:.7; }
    .ec-cancel .ec-cancel-amt { text-decoration:line-through; }
    /* [ECA.9] La factura y «Agendar»: botones fantasma a la derecha del renglón (≤ 2 por renglón). */
    .ec-venc-i { font-size:var(--fs-micro); margin-right:.2rem; }
    .ec-acts-td { text-align:right; }
    /* Apilado (teléfono): la línea entre documentos va en el renglón, no en cada dato. */
    @container densetable (max-width: 34rem) {
      .ec-doc + .ec-doc .ec-doc-row td { border-top:0; }
      .ec-doc + .ec-doc .ec-doc-row { border-top:1px solid var(--border-color); }
      .ec-ap-row { padding-left:var(--sp-4) !important; }
      .ec-ap-name { padding-left:0 !important; }
      .ec-prog { margin-left:0; }
    }
    .ec-acts { display:inline-flex; gap:var(--sp-1); justify-content:flex-end; align-items:center; white-space:nowrap; }
    .ec-act { display:inline-flex; align-items:center; gap:.3rem; min-height:1.75rem; padding:.15rem .5rem; border:1px solid var(--border-color); border-radius:var(--r-sm); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-xs); font-weight:500; text-decoration:none; cursor:pointer; }
    .ec-act .pi { font-size:var(--fs-xs); }
    .ec-act:hover { background:var(--overlay-hover); }
    .ec-act:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .ec-act-q { color:var(--text-muted); }
    @media (pointer: coarse) { .ec-act { min-height:var(--tap-min); } }
    .ec-ev-nm { font-size:var(--fs-xs); color:var(--text-muted); padding:0 .3rem; }
    .ec-sub { padding:.6rem .85rem; border-top:1px solid var(--border-color); }
    .ec-sub h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .2rem; }
    .ec-sub .ec-st { margin-top:.4rem; }
    .ta-r { text-align:right !important; }
    .num, .ec-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    /* La referencia es texto libre («COMPRA 1287-1286-130»): se parte en sus espacios para no empujar las acciones. */
    .ec-st td.ec-ref { white-space:normal; overflow-wrap:anywhere; min-width:5rem; }
    .ec-strong { font-weight:600; }
    .ec-bad { color:var(--bad-fg); }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .ec-tag { font-size:var(--fs-nano); margin-left:.3rem; }
    .ec-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .ec-errbox .pi { color:var(--bad-fg); } .ec-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .ec-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .ec-empty .pi { font-size:var(--fs-lg); }
    .ec-empty-acts { display:inline-flex; flex-wrap:wrap; gap:var(--sp-3); justify-content:center; }
  `],
})
export class FinanzasEstadoCuentaAcreedoresComponent implements OnInit {
  /** [NAV.7] La barra del apartado «Deuda con proveedores» del sidebar de Finanzas: la pintan todas sus páginas. */
  readonly apartadoTabs = DEUDA_PROVEEDORES_TABS;
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * `[ECA.9]` Agregar facturas al Calendario pide `FINANCE_PAYMENTS_GESTIONAR`; esta pantalla, sólo `_VER`.
   * Quien sólo ve no recibe un «Agendar» que el servidor le negaría con 403.
   */
  readonly puedeGestionar = inject(PermissionsService).has$(Permission.FINANCE_PAYMENTS_GESTIONAR);
  private readonly base = `${environment.apiUrl}/finance/creditor-statements`;
  /**
   * `[ECA.9]` La factura se pide al endpoint de PAGOS (`[PGP.21]`), con el mismo permiso que esta
   * pantalla (`FINANCE_PAYMENTS_VER`): no hay un segundo motor de evidencia ni un permiso nuevo.
   */
  private readonly pagosBase = `${environment.apiUrl}/finance/payment-calendar`;

  readonly skel = Array.from({ length: 8 });
  readonly money = money;
  readonly dmy = dmy;

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<AcreedoresResponse | null>(null);
  readonly tipo = signal<AcreedorTipo>('mercancia');
  readonly q = signal('');
  readonly sel = signal<AcreedorResumen | null>(null);

  readonly soloPendientes = signal(true);
  rangeDates: Date[] | null = null;
  readonly det = signal<AcreedorEstadoCuentaResponse | null>(null);
  readonly detLoading = signal(false);
  readonly detErr = signal<string | null>(null);

  /** "Sin clasificar" sólo aparece si hay alguno: un botón vacío no informa nada. */
  readonly tiposVisibles = computed(() => TIPOS.filter((t) => t.tipo !== 'sin_clasificar' || (this.total('sin_clasificar')?.acreedores ?? 0) > 0));
  readonly totalSel = computed<AcreedorTipoTotal | null>(() => this.total(this.tipo()));

  readonly lista = computed<AcreedorResumen[]>(() => {
    const d = this.data();
    if (!d) return [];
    const delTipo = d.acreedores.filter((a) => a.tipo === this.tipo());
    return filtrarPorBusqueda(delTipo, this.q(), (a) => [a.codigo, a.nombre, a.rfc, a.grupo_nombre]);
  });

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const t = this.totalSel();
    if (!t) return [];
    // [ECA.9] Sin los subtítulos que repetían («340 acreedores» ya está en el selector) o definían lo que el
    // rótulo dice: medido en pantalla viva, partían la tira en 2–3 renglones. Queda el que agrega un dato.
    return [
      { label: 'Saldo en Kepler', value: t.saldo, format: 'currency2', tone: 'default' },
      { label: 'Pendiente de pago', value: t.pendiente, format: 'currency2', tone: t.pendiente > 0.005 ? 'warn' : 'ok' },
      { label: 'Vencido', value: t.vencido, format: 'currency2', tone: t.vencido > 0.005 ? 'bad' : 'ok', sub: t.pendiente > 0 ? `${((t.vencido / t.pendiente) * 100).toFixed(1)}% de lo pendiente` : 'nada pendiente' },
      { label: 'Pagos sin aplicar', value: t.pagos_sin_aplicar, format: 'currency2', tone: 'default' },
    ];
  });

  // ── [ECA.9] Buscar en los documentos del acreedor ─────────────────────────────────────────────
  /** Lo que se va tecleando. */
  readonly qDocTxt = signal('');
  /** Lo que se aplica, 250 ms después de la última tecla: la cuenta (que se anuncia) cambia una vez por pausa. */
  readonly qDoc = signal('');
  private qDocTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * El texto buscable de cada documento, armado UNA vez por estado de cuenta (hasta 1,314 documentos,
   * medido): lo que se ve en el renglón —folio, referencia, sucursal por nombre, fechas, importe con y
   * sin formato, estado— y los folios y referencias de lo que se le aplicó, para encontrar la factura
   * que pagó una transferencia.
   */
  private readonly pajares = computed(() => {
    const e = this.det();
    const m = new Map<AcreedorDocumento, string>();
    for (const d of e?.documentos ?? []) m.set(d, this.pajarDoc(d));
    return m;
  });
  readonly docsVisibles = computed<AcreedorDocumento[]>(() => {
    const e = this.det();
    const q = this.qDoc();
    const pj = this.pajares();
    if (!e) return [];
    return filtrarPorBusqueda(e.documentos, q, (d) => [pj.get(d)]);
  });
  readonly pagosVisibles = computed<AcreedorPagoSinAplicar[]>(() => {
    const e = this.det();
    const q = this.qDoc();
    if (!e) return [];
    return filtrarPorBusqueda(e.pagos_sin_aplicar, q, (p) => [
      p.folio, p.referencia, p.documento, warehouseName(p.sucursal), ...fechasBuscables(p.fecha), ...importesBuscables(p.importe), money(p.remanente),
    ]);
  });
  /** Qué universo se está viendo: «12 de 160 documentos con saldo con «0003»». Cruce 1: la cuenta se recorre. */
  readonly docsDice = computed(() => {
    const e = this.det();
    const n = this.docsVisibles().length;
    const q = this.qDoc();
    if (!e) return '';
    const total = e.documentos.length;
    const universo = e.solo_pendientes || !e.periodo ? 'con saldo' : `del ${dmy(e.periodo.from)} al ${dmy(e.periodo.to)}`;
    const docs = (k: number): string => (k === 1 ? '1 documento' : `${k.toLocaleString('es-MX')} documentos`);
    return q ? `${n.toLocaleString('es-MX')} de ${docs(total)} ${universo} con «${q}»` : `${docs(total)} ${universo}`;
  });

  // ── [ECA.9] La factura del proveedor (evidencia de PGP.21) ────────────────────────────────────
  readonly evid = signal<ReadonlyMap<string, PayableEvidenceRow>>(new Map());
  readonly evidEstado = signal<'nada' | 'buscando' | 'listo' | 'fallo'>('nada');
  private evidSeq = 0;
  private detSeq = 0;
  private evidDe = '';
  private evidRespondidas = new Set<string>();
  /** «93 de 160 con factura en PDF»: se dice en UNA línea, no en cada renglón (`[PGP.49]`). */
  readonly evidDice = computed<string | null>(() => {
    const est = this.evidEstado();
    const m = this.evid();
    const e = this.det();
    if (!e || est === 'nada' || est === 'fallo') return null;
    if (est === 'buscando') return 'buscando las facturas…';
    const conSaldo = e.documentos.filter((d) => this.conSaldo(d));
    const pdf = conSaldo.filter((d) => m.get(this.llaveDoc(d))?.evidencia === 'pdf').length;
    return e.solo_pendientes ? `${pdf} de ${conSaldo.length} con factura en PDF` : `${pdf} de los ${conSaldo.length} con saldo traen factura en PDF`;
  });
  /** Lo que pasó al abrir una factura o copiar un UUID. Se queda hasta que se cierra: no se va solo. */
  readonly aviso = signal<{ txt: string; mal: boolean } | null>(null);

  ngOnInit(): void {
    // Al salir (p. ej. por «Agendar») la tanda de facturas en vuelo ya no dispara la siguiente.
    this.destroyRef.onDestroy(() => { if (this.qDocTimer) clearTimeout(this.qDocTimer); this.evidSeq++; });
    this.reload();
  }

  total(tipo: AcreedorTipo): AcreedorTipoTotal | null {
    return this.data()?.totales.find((t) => t.tipo === tipo) ?? null;
  }

  pickTipo(t: AcreedorTipo): void {
    if (t === this.tipo()) return;
    this.tipo.set(t);
    const s = this.sel();
    if (s && s.tipo !== t) { this.sel.set(null); this.det.set(null); }
  }

  pick(a: AcreedorResumen | null): void {
    this.sel.set(a);
    this.det.set(null);
    // Otro acreedor, otros folios: la búsqueda y los avisos del anterior no aplican.
    this.limpiarQDoc();
    this.aviso.set(null);
    this.evidSeq++;
    if (a) this.loadDet();
  }

  setSoloPendientes(v: boolean): void {
    this.soloPendientes.set(v);
    if (!v && !this.rangeDates) {
      // Sin rango elegido: los últimos 3 meses, como el filtro de fechas del reporte de Kepler.
      const hoy = new Date();
      this.rangeDates = [new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1), hoy];
    }
    this.loadDet();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: todavía no se consulta
    this.loadDet();
  }

  reload(): void {
    // [ECA.9] «Actualizar» vuelve a preguntar por las facturas: la que se subió mientras tanto tiene que salir.
    this.evidDe = '';
    this.loading.set(true);
    this.err.set(null);
    this.http.get<AcreedoresResponse>(this.base).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        const s = this.sel();
        this.sel.set(s ? d.acreedores.find((x) => x.codigo === s.codigo) ?? null : null);
        this.loading.set(false);
        if (this.sel()) this.loadDet(); else this.det.set(null);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los acreedores.'); },
    });
  }

  loadDet(): void {
    const a = this.sel();
    if (!a) return;
    // [ECA.9] Sólo la ÚLTIMA lectura se pinta: alternar «Sólo con saldo» o «buscar en los pagados» dejaba que la
    // respuesta lenta (12 meses) llegara después y pisara a la nueva, con el interruptor diciendo otra cosa.
    const seq = ++this.detSeq;
    const p = new URLSearchParams();
    if (!this.soloPendientes()) {
      const [f, t] = this.rangeDates || [];
      if (!f || !t) { this.detLoading.set(false); return; }
      p.set('pendientes', 'false'); p.set('from', iso(f)); p.set('to', iso(t));
    }
    this.detLoading.set(true);
    this.detErr.set(null);
    const codigo = a.codigo;
    this.http.get<AcreedorEstadoCuentaResponse>(`${this.base}/${encodeURIComponent(codigo)}?${p.toString()}`)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => {
          if (seq !== this.detSeq || this.sel()?.codigo !== codigo) return; // ya se pidió otra cosa
          this.det.set(d);
          this.detLoading.set(false);
          // [ECA.9] La tabla se pinta completa YA; la factura de cada renglón llega después (~2.7 s por tanda, medido).
          void this.cargarEvidencias(d);
        },
        error: () => {
          if (seq !== this.detSeq || this.sel()?.codigo !== codigo) return;
          this.detLoading.set(false);
          this.detErr.set('No se pudo cargar el estado de cuenta.');
        },
      });
  }

  // ── [ECA.9] Buscar ────────────────────────────────────────────────────────────────────────────
  alEscribirDoc(v: string): void {
    this.qDocTxt.set(v ?? '');
    if (this.qDocTimer) clearTimeout(this.qDocTimer);
    this.qDocTimer = setTimeout(() => this.qDoc.set(this.qDocTxt().trim()), 250);
  }
  /** `Esc` limpia la búsqueda; si ya estaba vacía no hace nada (no cierra nada por sorpresa). */
  limpiarQDoc(ev?: Event): void {
    if (this.qDocTimer) clearTimeout(this.qDocTimer);
    if (!this.qDocTxt() && !this.qDoc()) return;
    ev?.preventDefault();
    this.qDocTxt.set('');
    this.qDoc.set('');
  }
  /**
   * Sin resultados: la misma búsqueda, ahora con los pagados de los últimos 12 meses. ⛔ Medido en la pantalla
   * viva: con el periodo por defecto (3 meses) el folio de un pago de diciembre DESAPARECÍA al pasar a «pagados»,
   * aunque con «Sólo con saldo» sí se encontraba — quien busca algo concreto no busca sólo en lo reciente.
   */
  buscarEnPagados(): void {
    const hoy = new Date();
    this.rangeDates = [new Date(hoy.getFullYear() - 1, hoy.getMonth(), 1), hoy];
    this.setSoloPendientes(false);
  }
  /** El periodo a la vista es más corto que 12 meses: se ofrece ampliarlo. */
  puedeAmpliar(e: AcreedorEstadoCuentaResponse): boolean {
    if (!e.periodo) return false;
    const hoy = new Date();
    return e.periodo.from > iso(new Date(hoy.getFullYear() - 1, hoy.getMonth(), 1));
  }

  private pajarDoc(d: AcreedorDocumento): string {
    const p: (string | number | null | undefined)[] = [
      d.folio, d.referencia, d.documento, warehouseName(d.sucursal), ...fechasBuscables(d.fecha), ...(d.vence ? fechasBuscables(d.vence) : ['sin fecha']),
      ...importesBuscables(d.importe), money(d.saldo), ESTADO[d.estado]?.label,
    ];
    for (const ap of d.aplicaciones ?? []) p.push(ap.folio, ap.referencia, ap.documento, ...fechasBuscables(ap.fecha), ...importesBuscables(ap.importe));
    for (const pr of d.programado ?? []) p.push(pr.referencia, pr.kepler_folio);
    return p.filter((x) => x !== null && x !== undefined && x !== '').join(' ');
  }

  // ── [ECA.9] La factura ────────────────────────────────────────────────────────────────────────
  /** Lo que todavía se debe: sólo de esos se busca la factura y sólo esos se agendan. */
  conSaldo(d: AcreedorDocumento): boolean { return !d.cancelado && d.saldo > TOL; }
  /** `oblig:sucursal|tipo|sub|folio` — la llave de la factura en Pagos. Medido: casa 160 de 160 en CB005. */
  llaveDoc(d: AcreedorDocumento): string { return `oblig:${d.sucursal}|${d.tipo_doc}|${d.sub}|${d.folio}`; }

  /**
   * Pide la evidencia de los documentos con saldo, en tandas de 200 (el tope del endpoint) y una tras
   * otra. Del mismo acreedor sólo pide lo que falta (cambiar el filtro no repite los 2.7 s).
   * ⛔ Si falla, la línea de estado lo dice con «Reintentar»: un renglón sin botón no es «sin factura».
   */
  private async cargarEvidencias(e: AcreedorEstadoCuentaResponse): Promise<void> {
    const codigo = e.acreedor.codigo;
    if (codigo !== this.evidDe) { this.evidDe = codigo; this.evidRespondidas = new Set(); this.evid.set(new Map()); }
    const seq = ++this.evidSeq;
    const faltan = [...new Set(e.documentos.filter((d) => this.conSaldo(d)).map((d) => this.llaveDoc(d)))]
      .filter((r) => !this.evidRespondidas.has(r));
    if (!faltan.length) { this.evidEstado.set(this.evidRespondidas.size ? 'listo' : 'nada'); return; }
    this.evidEstado.set('buscando');
    try {
      for (let i = 0; i < faltan.length; i += EVIDENCIA_REFS_POR_CONSULTA) {
        const tanda = faltan.slice(i, i + EVIDENCIA_REFS_POR_CONSULTA);
        // `[PGP.231]` Las llaves van en el CUERPO: en la URL, 200 llaves + el token de un superadmin daban 431.
        const consulta: PayableEvidenceQuery = { refs: tanda };
        const rows = await firstValueFrom(this.http.post<PayableEvidenceRow[]>(`${this.pagosBase}/evidencia/consulta`, consulta));
        if (seq !== this.evidSeq) return; // otro acreedor u otra lectura: esta respuesta ya no es de lo que se ve
        const m = new Map(this.evid());
        for (const r of rows ?? []) if (r?.entity_ref) m.set(r.entity_ref, r);
        this.evid.set(m);
        tanda.forEach((r) => this.evidRespondidas.add(r));
      }
      this.evidEstado.set('listo');
    } catch {
      if (seq === this.evidSeq) this.evidEstado.set('fallo');
    }
  }
  reintentarEvid(): void {
    const e = this.det();
    if (e) void this.cargarEvidencias(e);
  }

  /**
   * Abre el PDF en un clic. La pestaña se abre DENTRO del clic (`abrirPestanaParaPdf`): abrirla cuando
   * contesta el servidor la bloquea el navegador (medido en `/comercial/documentos`). La URL la firma
   * el servidor por 600 s, así que se pide en cada clic y no se guarda.
   */
  abrirFactura(doc: AcreedorDocumento, ev: PayableEvidenceRow): void {
    if (ev.evidencia !== 'pdf' || !ev.ref_evidencia) return;
    this.aviso.set(null);
    const win = abrirPestanaParaPdf('Abriendo la factura…');
    firstValueFrom(this.http.get<PayableEvidenceFile[]>(`${this.pagosBase}/evidencia/archivo/${encodeURIComponent(ev.ref_evidencia)}`))
      .then((files) => {
        // [PGP.59] Sólo una URL http(s): una LLAVE del bucket (el servidor no pudo firmarla) abría «Cannot GET».
        const abribles = (files ?? []).filter((x) => /^https?:\/\//i.test(x?.url ?? ''));
        const f = abribles.find((x) => x.role === 'factura') ?? abribles[0];
        if (f) { entregarUrl(win, f.url); return; }
        cerrarPestanaDePdf(win);
        this.aviso.set({ mal: true, txt: (files ?? []).length
          ? `La factura ${doc.folio} está guardada, pero el servidor no pudo generar su enlace de lectura. Avisa a Sistemas.`
          : `El comprobante de la factura ${doc.folio} no trae un archivo que se pueda abrir.` });
      })
      .catch((err) => {
        cerrarPestanaDePdf(win);
        this.aviso.set({ mal: true, txt: `No se pudo abrir la factura ${doc.folio}: ${err?.error?.message || 'el enlace se firma al momento; intenta de nuevo.'}` });
      });
  }

  /** Sin PDF pero con CFDI: el UUID se copia para buscarlo en el SAT o en ContPAQi. */
  copiarUuid(doc: AcreedorDocumento, ev: PayableEvidenceRow): void {
    const uuid = ev.ref_evidencia ?? '';
    if (!uuid) return;
    const ok = (): void => this.aviso.set({ mal: false, txt: `No hay PDF de la factura ${doc.folio}; se copió el UUID de su CFDI: ${uuid}` });
    const mal = (): void => this.aviso.set({ mal: true, txt: `No hay PDF de la factura ${doc.folio}. El navegador no dejó copiar; su UUID es ${uuid}` });
    try { navigator.clipboard.writeText(uuid).then(ok, mal); } catch { mal(); }
  }

  // ── [ECA.9] Agendar ───────────────────────────────────────────────────────────────────────────
  /** Hay algo que programar: con saldo y con una parte que ningún pago del Calendario cubre todavía. */
  puedeAgendar(d: AcreedorDocumento): boolean {
    // ⛔ Sin el Calendario leído (`medido: false`) cada `programado` llega vacío: ofrecer «Agendar» afirmaría
    // «sin programar» de lo que no se midió (regla 11). Arriba ya se dice que no se pudo leer.
    return this.puedeGestionar() && this.det()?.calendario?.medido === true && this.conSaldo(d) && this.sinProgramar(d) > TOL;
  }
  /** El día que toca: su vencimiento; si ya venció o no trae fecha, hoy (`al` = hoy en hora de México). */
  fechaAgendar(d: AcreedorDocumento, hoy: string): string { return d.vence && d.vence >= hoy ? d.vence : hoy; }
  agendarTxt(d: AcreedorDocumento, hoy: string): string {
    const f = this.fechaAgendar(d, hoy);
    return f === hoy ? 'Agendar hoy' : `Agendar ${this.dm(f)}`;
  }
  agendarAria(d: AcreedorDocumento, hoy: string): string {
    const f = this.fechaAgendar(d, hoy);
    const porque = !d.vence ? 'no trae vencimiento' : d.vence < hoy ? `venció el ${dmy(d.vence)}` : d.vence === hoy ? 'vence hoy' : 'es su vencimiento';
    return `Agendar la factura ${d.folio} en el Calendario de Pagos el ${this.diaLargo(f)} (${porque})`;
  }
  /**
   * El Calendario abre ese día con «Agregar facturas» ya buscando esta factura: clave del acreedor +
   * folio, que en el Calendario son `payee_code` y `concept` de la factura de Kepler.
   */
  agendarQp(a: AcreedorResumen, d: AcreedorDocumento, hoy: string): { fecha: string; buscar: string } {
    return { fecha: this.fechaAgendar(d, hoy), buscar: `${a.codigo} ${d.folio}` };
  }

  /** `[ECA.8]` «viernes 13/11»: el día de la semana evita confundir el 13/11 con otro mes al leer rápido. */
  diaLargo(f: string): string {
    const d = new Date(`${f}T12:00:00`);
    return Number.isNaN(d.getTime()) ? f : `${d.toLocaleDateString('es-MX', { weekday: 'long' })} ${this.dm(f)}`;
  }
  /** `[ECA.8]` «13/11». */
  dm(f: string): string { return `${f.slice(8, 10)}/${f.slice(5, 7)}`; }
  /**
   * `[ECA.8]` Lo que ningún pago cubre todavía de esta factura. Lo ejecutado que Kepler ya aplicó no se
   * resta: ya está dentro del saldo (mismo criterio que `calendarioDe` en el backend).
   */
  sinProgramar(doc: AcreedorDocumento): number {
    if (doc.cancelado) return 0;
    const cubierto = (doc.programado ?? []).filter((p) => !p.aplicado_en_kepler).reduce((t, p) => t + p.cubierto, 0);
    return Math.max(doc.saldo - cubierto, 0);
  }

  estadoLabel(e: AcreedorDocEstado): string { return ESTADO[e].label; }
  estadoSev(e: AcreedorDocEstado): Sev { return ESTADO[e].sev; }
}
