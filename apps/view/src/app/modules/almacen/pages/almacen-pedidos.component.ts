import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, type ParamMap, RouterLink } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { DrawerModule } from 'primeng/drawer';
import { ETAPAS_PEDIDO, WAREHOUSE_ORDER_CANCELADO, type EtapaPedido, type WarehouseOrderDetail, type WarehouseOrderRow, type WarehouseOrdersAtorados, type WarehouseOrdersResponse } from '@megadulces/contracts';
import { money } from '../../../shared/util/money.util';
import { AlmacenPedidosService, type AlmacenPedidosFiltro } from '../almacen-pedidos.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { AlmacenSurtidoConsolaComponent } from './almacen-surtido-consola.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';
type Preset = 'hoy' | 'semana' | 'mes' | 'mes_anterior' | 'rango';

/** Color de cada estatus de Kepler. Lo que Kepler traiga nuevo cae en gris, no se pierde. */
const ESTATUS: Record<string, { label: string; sev: Sev }> = {
  CREADO: { label: 'Creado', sev: 'secondary' },
  AUTORIZADO: { label: 'Autorizado', sev: 'info' },
  SURTIDO: { label: 'Surtido', sev: 'warn' },
  CHECADO: { label: 'Checado', sev: 'warn' },
  EMBARCADO: { label: 'Embarcado', sev: 'success' },
  // [GP.10.0] Kepler cancela con c43 = 'C' y conserva el c11 viejo: el servidor lo devuelve como
  // CANCELADO. Gris y no rojo: no es una alarma ni trabajo pendiente; el texto lo distingue de Creado.
  [WAREHOUSE_ORDER_CANCELADO]: { label: 'Cancelado', sev: 'secondary' },
};
/**
 * `[GP.10.4a]` La etapa de ALMACÉN del pedido (Kepler + lo registrado en la Suite), la de los botones
 * y la columna. Tres colores y el texto siempre: el color no es el único portador.
 */
const ETAPA: Record<EtapaPedido, { label: string; sev: Sev }> = {
  creado: { label: 'Creado', sev: 'secondary' },
  autorizado: { label: 'Autorizado', sev: 'info' },
  en_cola: { label: 'En cola', sev: 'info' },
  surtiendo: { label: 'Surtiendo', sev: 'warn' },
  surtido: { label: 'Surtido', sev: 'warn' },
  checando: { label: 'Checando', sev: 'warn' },
  checado: { label: 'Checado', sev: 'warn' },
  embarcado: { label: 'Embarcado', sev: 'success' },
  cancelado: { label: 'Cancelado', sev: 'secondary' },
  sin_dato: { label: 'Sin dato', sev: 'secondary' },
};
const ORIGEN: Record<string, string> = { TELEMARK: 'Telemarketing', SUCURSAL: 'Sucursal', PREVENTA: 'Preventa' };
const ORIGEN_PREVENTA = 'PREVENTA';
/**
 * `[GP.RF.22]` «Por hacer»: lo que sigue en el almacén, de autorizado a checado. Sin Creado (aún no
 * autorizado), Embarcado (ya salió) ni Cancelado. Es lo que abre el Tablero (decisión de Edgar,
 * 2026-11-17): de 2,389 pedidos del mes, 1,396 ya estaban embarcados y abrían la lista.
 */
const ETAPAS_POR_HACER: string[] = ETAPAS_PEDIDO.filter((e) => e !== 'creado' && e !== 'embarcado');
type EtapaElegida = EtapaPedido | 'por_hacer' | null;
/** Orden de las unidades en el volumen: de la más grande a la más chica; las demás al final. */
const ORDEN_UNIDADES = ['CJA', 'BULTO', 'BTO', 'CUB', 'PAQ', 'PZA', 'KG', '500', '400', '250'];
/** Kepler a veces guarda el GRAMAJE en la unidad (`500`, `250`): no es un nombre de unidad (UNIDADES_DE_MEDIDA §3). */
const ES_GRAMAJE = /^[\d.]+$/;
const ordenUnidad = (u: string): number => { const i = ORDEN_UNIDADES.indexOf(u); return i < 0 ? 99 : i; };

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `YYYY-MM-DD` → fecha local (la que usa el selector de rango), sin pasar por UTC. */
const fechaLocal = (v: string): Date => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); };
/** `[GP.RF.15]` Los estatus de Kepler que una liga puede traer en `kepler_status`: sólo los que alguien manda. */
const ESTATUS_KEPLER_LIGA: readonly string[] = ['AUTORIZADO'];
/**
 * `[GP.10.5]` Pedidos por página. El servidor manda sólo la página que se ve (antes mandaba hasta
 * 2,000, 1.40 MB, y aun así dejaba fuera 348 del mes); los conteos y totales siguen siendo de todo.
 */
export const PAGINA_PEDIDOS = 200;
const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/**
 * `[GP.1]` Tablero de pedidos del almacén.
 *
 * Los pedidos Kepler `U-D-40` (telemarketing y sucursal) del periodo, filtrables por estatus,
 * origen, sucursal y texto, con el detalle por renglón: cantidad pedida/surtida/checada/
 * embarcada y la ubicación de cada etapa. Sólo lectura (ADR-086): el pedido se sigue
 * avanzando en Kepler. El periodo arranca en el **mes en curso** (decisión de Francisco).
 *
 * Lo que Kepler no guarda se declara, no se dibuja: no hay hora por etapa, así que la columna
 * "Abierto" mide desde que se CREÓ el pedido, no cuánto lleva en su estatus.
 */
@Component({
  selector: 'app-almacen-pedidos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, SelectModule, DatePickerModule, InputTextModule, TagModule, ContextHelpComponent, DrawerModule, SucursalPipe, AlmacenSurtidoConsolaComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head gp-head">
        <div class="gp-head-text">
          <h1>{{ soloSurtidor() && !enFila() ? 'Pedidos por surtir' : 'Pedidos' }}</h1>
          @if (data(); as d) {
            @if (!soloSurtidor() && !enFila()) {
              <!-- [GP.RF.22] Lo que se leía como párrafo (sólo lectura, qué es cada etapa, unidades, importe) va al «?». -->
              <span class="gp-meta">{{ dm(d.periodo.from) }} – {{ dm(d.periodo.to) }} · Kepler leído {{ hora(d.generado_en) }}</span>
              <app-context-help topic="almacen-pedidos" />
            }
          }
        </div>
        <!-- [GP.RF.20] La cabecera también se pinta para quien surte y coordina sin ver el Tablero: antes
             veía el cambio de vista en su propio renglón y no debe perderlo al subirlo aquí. -->
        @if (!soloSurtidor() || (coordina() && hayPedidos())) {
        <div class="gp-actions">
          <!-- [GP.RF.22] Puertas a pantallas de foco, no la acción de este Tablero (que es de lectura): de
               contorno. Antes eran dos rellenos naranjas compitiendo por ser «lo principal». -->
          @if (puedeSurtir() && !soloSurtidor()) {
            <a pButton routerLink="/almacen/surtir" class="p-button-sm p-button-outlined gp-surtir"><span class="p-button-icon p-button-icon-left pi pi-shopping-bag" aria-hidden="true"></span><span class="p-button-label">Surtir</span></a>
          }
          @if (puedeChecar() && !soloSurtidor()) {
            <a pButton routerLink="/almacen/checar" class="p-button-sm p-button-outlined gp-surtir"><span class="p-button-icon p-button-icon-left pi pi-check-square" aria-hidden="true"></span><span class="p-button-label">Checar</span></a>
          }
          <!-- [GP.10.4b] D2: la consola de surtido es una vista del Tablero, sólo para quien coordina. Ligas y no
               botones: la vista queda en la dirección (?vista=fila) y «Atrás» del navegador regresa.
               [GP.RF.20] Va en la cabecera, junto al periodo: en su propio renglón le quitaba ~45 px a la lista. -->
          @if (coordina() && hayPedidos()) {
            <nav class="gp-seg gp-vistas" aria-label="Vista">
              <a routerLink="/almacen/pedidos" class="gp-seg-b gp-vista" [class.on]="!enFila()" [attr.aria-current]="enFila() ? null : 'page'">Pedidos</a>
              <a routerLink="/almacen/pedidos" [queryParams]="{ vista: 'fila' }" class="gp-seg-b gp-vista" [class.on]="enFila()" [attr.aria-current]="enFila() ? 'page' : null">Fila de surtido</a>
            </nav>
          }
          @if (!enFila() && !soloSurtidor()) {
          <p-select [options]="periodoOpts" optionLabel="label" optionValue="value" [ngModel]="periodoSel()" (onChange)="pickPeriodo($event.value)" ariaLabel="Periodo" appendTo="body" class="gp-sel gp-periodo" />
          @if (periodoSel() === 'rango') {
            <p-datepicker inputId="gp-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Del … al …" (onClose)="onRange()" ariaLabel="Rango de fechas" />
          }
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="refrescar()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
          }
        </div>
        }
      </header>

      @if (enFila()) {
        @defer (on immediate) {
          <app-almacen-surtido-consola [embebida]="true" />
        } @placeholder {
          <div class="gp-skeleton" aria-busy="true">@for (i of skel; track $index) { <div class="gp-skel-row"></div> }</div>
        }
      } @else {

      @if (err(); as e) { <div class="gp-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="gp-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="refrescar()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="gp-skeleton" aria-busy="true">@for (i of skel; track $index) { <div class="gp-skel-row"></div> }</div> }
      @else if (data(); as d) {
        @if (!d.alcance.todas) {
          @if (d.alcance.sucursales.length && !soloSurtidor()) {
            <div class="gp-note" role="note"><i class="pi pi-shop" aria-hidden="true"></i><span>Viendo sólo {{ d.alcance.sucursales.length === 1 ? 'tu sucursal' : 'tus sucursales' }}: <b>{{ sucursalesTexto(d) }}</b>.</span></div>
          } @else if (!d.alcance.sucursales.length) {
            <div class="gp-note gp-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay pedidos que mostrarte. Pide que te la asignen en <b>Administración › Personas</b>.</span></div>
          }
        }
        <!-- [GP.RF.16] Lo que nadie va a surtir, en la primera pantalla: antes el Tablero no decía nada (396
             pedidos en 8 sucursales, el más viejo de nov-2025). La cifra se recorre: «Velos» pone el filtro. -->
        @if (!estatusKepler() && !soloSurtidor()) {
          @if (atorados(); as a) {
            @if (a === 'error') {
              <div class="gp-note" role="note"><i class="pi pi-exclamation-circle" aria-hidden="true"></i><span>No se pudo contar los pedidos que siguen autorizados en Kepler fuera de la fila de surtido.</span></div>
            } @else if (a.pedidos > 0) {
              <div class="gp-note gp-note-warn" role="note"><i class="pi pi-history" aria-hidden="true"></i><span><b>{{ a.pedidos.toLocaleString('es-MX') }} {{ a.pedidos === 1 ? 'pedido sigue autorizado' : 'pedidos siguen autorizados' }} en Kepler</b>@if (a.desde) { desde el {{ dmy(a.desde) }} }y no {{ a.pedidos === 1 ? 'entra' : 'entran' }} a la fila de surtido{{ atoradosDonde(a) }}. Nadie {{ a.pedidos === 1 ? 'lo' : 'los' }} va a surtir: ciérralos en Kepler.</span>@if (ligaAtorados(); as q) { <a class="gp-link" routerLink="/almacen/pedidos" [queryParams]="q">Velos</a> }</div>
            }
          }
        }
        <!-- [GP.RF.15] Llegó de «velos en el Tablero» de la fila: se dice qué filtro trae y se quita con un clic. -->
        @if (estatusKepler() && !soloSurtidor()) {
          <div class="gp-note" role="note"><i class="pi pi-filter" aria-hidden="true"></i><span>Pedidos que Kepler sigue teniendo como <b>autorizados</b>, del {{ dmy(d.periodo.from) }} al {{ dmy(d.periodo.to) }}@if (sucursal()) {, sucursal <b>{{ sucursalNombre(d, sucursal()!) }}</b>}: <b>{{ d.totales.pedidos.toLocaleString('es-MX') }}</b>. Ninguno entra a la fila de surtido: ciérralos en Kepler.</span><button type="button" class="gp-link" (click)="quitarKepler()">Quitar este filtro</button></div>
        }

        <div class="gp-list">
          <section class="gp-block dt-scope" aria-labelledby="gp-h-lista">
            <h2 id="gp-h-lista" class="sr-only">Lista de pedidos</h2>
            <!-- [MCP.3.2] El surtidor ve sólo la lista: sin estatus, filtros ni totales. -->
            @if (!soloSurtidor()) {
            <div class="gp-bh">
              <div class="gp-chips" role="group" aria-label="Etapa en el almacén">
                <!-- [GP.RF.22] Entra en «Por hacer» (lo que sigue en el almacén); «Todos» y cada etapa, a un clic. -->
                <button type="button" class="gp-chip gp-chip-main" [class.on]="etapa() === 'por_hacer'" [attr.aria-pressed]="etapa() === 'por_hacer'" (click)="pickEtapa('por_hacer')">Por hacer <span class="num">{{ totalPorHacer(d).toLocaleString('es-MX') }}</span></button>
                <button type="button" class="gp-chip" [class.on]="etapa() === null" [attr.aria-pressed]="etapa() === null" (click)="pickEtapa(null)">Todos <span class="num">{{ totalConteos(d).toLocaleString('es-MX') }}</span></button>
                @for (c of chipsEtapa(d); track c.etapa) {
                  <button type="button" class="gp-chip" [class.on]="etapa() === c.etapa" [attr.aria-pressed]="etapa() === c.etapa" (click)="pickEtapa(c.etapa)">{{ etapaLabel(c.etapa) }} <span class="num">{{ c.pedidos.toLocaleString('es-MX') }}</span></button>
                }
              </div>
              <div class="gp-filters">
                <!-- [GP.RF.21] La preventa a UN toque y con su número (antes: abrir el desplegable y elegirla, en
                     una lista de 2,224 por fecha). Toca otra vez para quitarlo; el desplegable sigue para los demás. -->
                @if (cuentaOrigen(d, 'PREVENTA'); as n) {
                  <button type="button" class="gp-chip" [class.on]="origen() === 'PREVENTA'" [attr.aria-pressed]="origen() === 'PREVENTA'" (click)="pickOrigen(origen() === 'PREVENTA' ? null : 'PREVENTA')">Preventa <span class="num">{{ n.toLocaleString('es-MX') }}</span></button>
                }
                <p-select [options]="origenOpts" optionLabel="label" optionValue="value" [ngModel]="origen()" (onChange)="pickOrigen($event.value)" ariaLabel="Origen" appendTo="body" class="gp-sel" />
                @if (sucursalOpts().length > 2) {
                  <p-select [options]="sucursalOpts()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (onChange)="pickSucursal($event.value)" ariaLabel="Sucursal" appendTo="body" class="gp-sel" />
                }
                <input pInputText type="search" class="gp-q" [ngModel]="q()" (ngModelChange)="onQ($event)" placeholder="Folio, cliente, vendedor o ciudad" aria-label="Buscar por folio, cliente, vendedor, ciudad o guía" />
              </div>
            </div>
            }
            <!-- Sólo con una API anterior a GP.10.5 (sin página): con página ningún pedido queda fuera. -->
            @if (d.truncado && !soloSurtidor()) { <p class="gp-hint gp-pad">Se muestran los primeros {{ d.items.length }}; los conteos y totales sí incluyen todos. Acota el periodo o filtra por etapa u origen.</p> }
            @if (soloSurtidor()) {
              <!-- [MCP.3.2] Vista del surtidor: sólo el pedido y para quién es. Sin detalle (es del tablero). -->
              <p-table [value]="d.items" size="small" class="surf-table dt-stack" [scrollable]="true" scrollHeight="calc(100vh - 14rem)" dataKey="clave"
                [lazy]="true" (onLazyLoad)="onPagina($event)" [paginator]="totalLista(d) > pagina" [rows]="pagina" [totalRecords]="totalLista(d)" [first]="offset()" [loading]="loading()">
                <ng-template #header>
                  <tr><th>Pedido</th><th>Cliente / destino</th></tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td role="cell" data-label="Pedido"><span class="mono">{{ r.documento }}</span><span class="muted gp-sub">{{ origenLabel(r.origen) }}</span></td>
                    <td role="cell" data-label="Cliente / destino"><span class="gp-trunc">{{ r.destino_nombre || r.cliente_code || '—' }}</span>@if (r.destino_ciudad) { <span class="muted gp-sub">{{ r.destino_ciudad }}</span> }</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td colspan="2"><div class="gp-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>No hay pedidos autorizados por surtir.</span></div></td></tr>
                </ng-template>
              </p-table>
            } @else {
            <p-table [value]="d.items" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="calc(100vh - 25rem)" selectionMode="single" [selection]="sel()" (selectionChange)="pick($event)" dataKey="clave"
              [lazy]="true" (onLazyLoad)="onPagina($event)" [paginator]="totalLista(d) > pagina" [rows]="pagina" [totalRecords]="totalLista(d)" [first]="offset()" [loading]="loading()"
              [showCurrentPageReport]="true" currentPageReportTemplate="{first}–{last} de {totalRecords}">
              <ng-template #header>
                <tr>
                  <th>Pedido</th><th>Fecha</th>@if (multiSucursal(d)) { <th>Suc</th> }<th>Cliente / destino</th>
                  <th class="ta-r">Reng. · volumen</th><th>Etapa</th><th class="ta-r">Importe</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [pSelectableRow]="r">
                  <td role="cell" data-label="Pedido"><span class="mono">{{ r.documento }}</span><span class="muted gp-sub">{{ origenLabel(r.origen) }}</span></td>
                  <!-- [GP.RF.22] «Abierto» deja su columna (casi siempre «—»): va debajo de la fecha, y sólo si sigue abierto. -->
                  <td class="mono" role="cell" data-label="Fecha">{{ dm(r.fecha) }} <span class="muted">{{ r.hora || '' }}</span>@if (esPreventa(r)) { <span class="muted gp-sub">entrega</span> } @else if (r.horas_abierto !== null) { <span class="muted gp-sub">hace {{ horas(r.horas_abierto) }}</span> }</td>
                  @if (multiSucursal(d)) { <td class="mono muted" role="cell" data-label="Suc">{{ r.sucursal | sucursal }}</td> }
                  <td role="cell" data-label="Cliente / destino"><span class="gp-trunc">{{ r.destino_nombre || r.cliente_code || '—' }}</span>@if (r.destino_ciudad) { <span class="muted gp-sub">{{ r.destino_ciudad }}</span> }</td>
                  <td class="ta-r" role="cell" data-label="Reng. · volumen"><span class="num">{{ r.renglones }}</span><span class="muted gp-sub gp-vol">{{ volumenTexto(r.volumen) }}</span></td>
                  <!-- [GP.RF.22] La guía deja su columna (casi siempre «—»): va debajo de la etapa cuando existe. -->
                  <td role="cell" data-label="Etapa"><p-tag [value]="etapaLabel(r.etapa)" [severity]="etapaSev(r.etapa)" />@if (desfaseTexto(r); as t) { <span class="gp-sub" [class.gp-warn]="r.desfase === 'piso_adelante'" [class.muted]="r.desfase !== 'piso_adelante'">{{ t }}</span> }@if (r.guia) { <span class="muted gp-sub mono">guía {{ r.guia }}</span> }</td>
                  <td class="ta-r num" role="cell" data-label="Importe">{{ r.importe === null ? '—' : money(r.importe) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td [attr.colspan]="multiSucursal(d) ? 7 : 6"><div class="gp-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>@if (etapa() === 'por_hacer' && !hayFiltros()) { Nada pendiente en el almacén entre {{ dmy(d.periodo.from) }} y {{ dmy(d.periodo.to) }}. } @else { Ningún pedido con estos filtros entre {{ dmy(d.periodo.from) }} y {{ dmy(d.periodo.to) }}. }</span>@if (hayFiltros()) { <button type="button" class="gp-link" (click)="limpiar()">Quitar filtros</button> }</div></td></tr>
              </ng-template>
            </p-table>
            <div class="gp-foot" aria-label="Totales de lo filtrado">
              <span><b class="num">{{ d.totales.pedidos.toLocaleString('es-MX') }}</b> pedidos</span>
              <span><b class="num">{{ d.totales.renglones.toLocaleString('es-MX') }}</b> renglones</span>
              <!-- [GP.10.5] D4: el traspaso a sucursal y la carga a ruta no son venta; van aparte. -->
              @if (d.totales.importe_por_destino; as p) {
                @for (x of partesImporte(p); track x.k) { <span><b class="num">{{ money(x.v) }}</b> {{ x.label }}</span> }
              } @else {
                <span><b class="num">{{ d.totales.importe === null ? '—' : money(d.totales.importe) }}</b></span>
              }
              @if (masAntiguo(); as h) { <span class="gp-foot-warn">sin embarcar más antiguo: <b class="num">{{ horas(h) }}</b></span> }
            </div>
            }
          </section>
        </div>

        <!-- Detalle como panel lateral (DESIGN.md: side-peek): la bandeja usa todo el ancho y el
             detalle sólo ocupa pantalla cuando hay un pedido elegido. -->
        <p-drawer [visible]="!!sel()" (visibleChange)="!$event && pick(null)" position="right" styleClass="gp-drawer"
                  [style]="{ width: 'min(560px, 100vw)' }" [header]="sel()?.documento || 'Pedido'">
          <section class="gp-detail" aria-labelledby="gp-h-det" aria-live="polite">
            @if (preventaSel(); as p) {
              <!-- [GP.10.4a] Un PD- no vive en Kepler: su resumen sale de la fila, y lo que es de cobro
                   (documento de Kepler, comparación, ligar, recorrido) se abre en la Mesa de Control, sin copiarlo. -->
              <div class="gp-det-head">
                <h2 id="gp-h-det" class="sr-only">Pedido de preventa {{ p.documento }}</h2>
                <p-tag [value]="etapaLabel(p.etapa)" [severity]="etapaSev(p.etapa)" />
                <span class="muted">{{ p.renglones }} renglones · {{ p.importe === null ? '—' : money(p.importe) }}</span>
              </div>
              <div class="gp-step">
                <div class="gp-row"><span>Cliente</span><span>{{ p.destino_nombre || '—' }}@if (p.cliente_code) { <span class="muted mono"> · {{ p.cliente_code }}</span> }</span></div>
                <div class="gp-row"><span>Origen</span><span>Preventa · {{ p.sucursal_nombre || '—' }}</span></div>
                <div class="gp-row"><span>Vendedor</span><span>{{ p.vendedor_nombre || '—' }}</span></div>
                <div class="gp-row"><span>Entrega prometida</span><span class="mono">{{ dmy(p.fecha) }}</span></div>
              </div>
              @if (p.order_id) {
                <div class="gp-step">
                  <a pButton routerLink="/almacen/pedidos/preventa" [queryParams]="{ pedido: p.order_id }" class="p-button-sm p-button-outlined gp-surtir"><span class="p-button-label">Documento, cobro y recorrido</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span></a>
                  <p class="gp-hint">Abre el pedido en la Mesa de Control de Preventa: con qué documento de Kepler se cobró, el pedido contra lo cobrado y cada cambio que tuvo.</p>
                </div>
              }
            } @else if (detLoading()) {
              <div class="gp-skeleton gp-pad" aria-busy="true">@for (i of skelDet; track $index) { <div class="gp-skel-row"></div> }</div>
            } @else if (det(); as x) {
              <div class="gp-det-head">
                <h2 id="gp-h-det" class="sr-only">Detalle del pedido {{ x.pedido.documento }}</h2>
                <p-tag [value]="etapaLabel(x.pedido.etapa)" [severity]="etapaSev(x.pedido.etapa)" />
                @if (x.pedido.estatus === cancelado) {
                  <span class="muted">Cancelado en Kepler · su último estatus fue {{ estatusLabel(x.pedido.estatus_kepler).toLowerCase() }}</span>
                } @else {
                  <span class="muted">{{ x.pedido.renglones }} renglones · {{ x.pedido.importe === null ? '—' : money(x.pedido.importe) }}</span>
                }
              </div>
              <div class="gp-step">
                <div class="gp-row"><span>Cliente</span><span>{{ x.pedido.destino_nombre || x.pedido.cliente_code || '—' }}@if (x.pedido.destino_ciudad) { <span class="muted"> · {{ x.pedido.destino_ciudad }}</span> }</span></div>
                <div class="gp-row"><span>Origen</span><span>{{ origenLabel(x.pedido.origen) }} · {{ x.pedido.sucursal_nombre }}</span></div>
                @if (x.pedido.estatus !== cancelado) {
                  <!-- [GP.10.4a] La etapa de arriba junta Kepler y la Suite; aquí, lo que dice Kepler solo. -->
                  <div class="gp-row"><span>Estatus en Kepler</span><span>{{ estatusLabel(x.pedido.estatus) }}@if (desfaseDetalle(x.pedido); as t) { <span class="muted gp-sub">{{ t }}</span> }</span></div>
                }
                <div class="gp-row"><span>Vendedor</span><span>{{ x.pedido.vendedor_nombre || x.pedido.vendedor_code || '—' }}</span></div>
                <div class="gp-row"><span>Creado</span><span class="mono">{{ dmy(x.pedido.fecha) }} {{ x.pedido.hora || '' }}</span></div>
                <div class="gp-row"><span>Responsables (surtido · checado · embarque)</span><span class="mono">{{ x.pedido.resp_surtido || '—' }} · {{ x.pedido.resp_checado || '—' }} · {{ x.pedido.resp_embarque || '—' }}</span></div>
                <div class="gp-row"><span>Transporte · chofer · guía</span><span class="mono">{{ x.pedido.transporte || '—' }} · {{ x.pedido.chofer || '—' }} · {{ x.pedido.guia || '—' }}</span></div>
                @for (e of x.embarques; track e.documento) {
                  <div class="gp-row"><span>Embarque</span><span class="mono">{{ e.documento }} · {{ dmy(e.fecha) }}@if (e.guia) { · guía {{ e.guia }} }</span></div>
                } @empty {
                  <div class="gp-row"><span>Embarque</span><span class="muted">Sin embarque todavía</span></div>
                }
              </div>
              <div class="gp-step">
                <h3>Renglones · {{ x.lineas.length }}</h3>
                <p-table [value]="x.lineas" size="small" class="surf-table gp-lines" [scrollable]="true" scrollHeight="calc(100vh - 22rem)" dataKey="renglon">
                  <ng-template #header>
                    <tr><th>Producto</th><th class="ta-r">Ped</th><th class="ta-r" title="Cantidad surtida y, abajo, su ubicación">Surt</th><th class="ta-r" title="Cantidad checada y, abajo, su ubicación">Chec</th><th class="ta-r" title="Cantidad embarcada y, abajo, su ubicación">Emb</th></tr>
                  </ng-template>
                  <ng-template #body let-l>
                    <tr>
                      <td role="cell" data-label="Producto">
                        <span class="gp-trunc">{{ l.descripcion || l.sku }}</span>
                        <span class="muted gp-sub mono">{{ l.sku }} · {{ l.unidad_presentacion || l.unidad || '' }}@if (agregado(l.etapa_alta)) { · <span class="gp-warn">agregado en {{ estatusLabel(l.etapa_alta).toLowerCase() }}</span> }</span>
                      </td>
                      <td class="ta-r num" role="cell" data-label="Ped">{{ cant(l.cant_pedida) }}</td>
                      <td class="ta-r num" role="cell" data-label="Surt" [class.gp-warn]="difiere(l.cant_pedida, l.cant_surtida)">{{ cant(l.cant_surtida) }}<span class="gp-sub gp-ubic" title="Ubicación de surtido">{{ l.ubic_surtido || '—' }}</span></td>
                      <td class="ta-r num" role="cell" data-label="Chec" [class.gp-warn]="difiere(l.cant_surtida, l.cant_checada)">{{ cant(l.cant_checada) }}<span class="gp-sub gp-ubic" title="Ubicación de checado">{{ l.ubic_checado || '—' }}</span></td>
                      <td class="ta-r num" role="cell" data-label="Emb" [class.gp-warn]="difiere(l.cant_checada, l.cant_embarcada)">{{ cant(l.cant_embarcada) }}<span class="gp-sub gp-ubic" title="Ubicación de embarque">{{ l.ubic_embarque || '—' }}</span></td>
                    </tr>
                  </ng-template>
                </p-table>
                <p class="gp-hint">Cantidades en la unidad del pedido; abajo de cada una, su ubicación. La ubicación por etapa casi nunca se captura en Kepler; se llenará al llevar el piso en la Suite.</p>
              </div>
            } @else if (detErr(); as e) {
              <div class="gp-empty gp-pad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ e }}</span></div>
            }
          </section>
        </p-drawer>
      }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .gp-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .gp-surtir { min-height:var(--tap-min); text-decoration:none; }
    .gp-head { align-items:center; margin-bottom:.5rem; }
    .gp-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .gp-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .gp-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .gp-foot { display:flex; flex-wrap:wrap; gap:.25rem 1.1rem; padding:.45rem .85rem; border-top:1px solid var(--border-color); font-size:var(--fs-xs); color:var(--text-muted); }
    .gp-foot b { color:var(--text-main); font-weight:600; }
    .gp-foot-warn b { color:var(--warn-soft-fg); }
    .gp-seg { display:inline-flex; border:1px solid var(--border-color); border-radius:var(--r-sm); overflow:hidden; background:var(--card-bg); }
    .gp-seg-b { height:2.25rem; padding:0 .75rem; border:0; border-left:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .gp-seg-b:first-child { border-left:0; }
    .gp-seg-b.on { background:var(--text-main); color:var(--card-bg); }
    .gp-seg-b:focus-visible, .gp-chip:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    /* [GP.RF.20] El cambio de vista es un segmentado más de la cabecera (ligas, no botones). */
    a.gp-vista { display:inline-flex; align-items:center; text-decoration:none; font-weight:600; }
    .gp-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .gp-note .pi { color:var(--text-muted); margin-top:.15rem; }
    .gp-note-bad { border-left:3px solid var(--bad-fg); }
    .gp-note-bad .pi { color:var(--bad-fg); }
    /* [GP.RF.16] El ámbar sólo en el borde y el icono de texto legible (--warn-fg como texto da 2.15:1). */
    .gp-note-warn { border-left:3px solid var(--warn-fg); }
    .gp-note-warn .pi { color:var(--warn-soft-fg); }
    .gp-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .gp-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .gp-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .gp-chips { display:flex; flex-wrap:wrap; gap:.3rem; }
    .gp-chip { height:2rem; padding:0 .65rem; border:1px solid var(--border-color); border-radius:999px; background:var(--card-bg); color:var(--text-main); font:inherit; font-size:var(--fs-xs); display:inline-flex; align-items:center; gap:.35rem; cursor:pointer; }
    .gp-chip.on { background:var(--text-main); border-color:var(--text-main); color:var(--card-bg); }
    .gp-filters { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
    .gp-chip-main { font-weight:600; }
    :host ::ng-deep .gp-sel { min-width:9.5rem; }
    .gp-q { min-width:14rem; height:2.25rem; }
    :host ::ng-deep .gp-lines .p-datatable-tbody > tr > td, :host ::ng-deep .gp-lines .p-datatable-thead > tr > th { padding:.3rem .4rem; font-size:var(--fs-xs); }
    :host ::ng-deep .gp-lines .gp-trunc { max-width:15rem; font-size:var(--fs-sm); }
    .gp-det-head { display:flex; align-items:center; gap:.6rem; padding:0 0 .5rem; font-size:var(--fs-sm); }
    .gp-detail .gp-step { padding-left:0; padding-right:0; }
    .gp-step { padding:.7rem .85rem; border-top:1px solid var(--border-color); }
    .gp-bh + .gp-step { border-top:0; }
    .gp-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .gp-row { display:flex; justify-content:space-between; gap:.8rem; font-size:var(--fs-sm); padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .gp-row > span:first-child { color:var(--text-muted); flex:none; }
    .gp-row > span:last-child { text-align:right; min-width:0; }
    .gp-trunc { display:block; max-width:22rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gp-sub { display:block; font-size:var(--fs-xs); }
    .gp-ubic { color:var(--text-muted); font-weight:400; }
    /* [GP.RF.22] Sin la clase .num: su nowrap ganaba (va después) y el texto se salía de los 11rem hasta
       encimarse sobre la etapa. Aquí se parte en renglones dentro de su celda, con números tabulares. */
    .gp-vol { white-space:normal; max-width:11rem; margin-left:auto; line-height:1.25; text-align:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .gp-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:.5rem 0 0; }
    .gp-pad { padding:.5rem .85rem; }
    .gp-warn { color:var(--warn-soft-fg); font-weight:600; }
    .gp-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    /* [GP.RF.12] Aqui habia ":host ::ng-deep .gp-tag { font-size }": regla MUERTA (p-tag en PrimeNG 22 no recibe styleClass); la etiqueta mide 12 px por el tema. Se quitó junto con sus styleClass. */
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .gp-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .gp-errbox .pi { color:var(--bad-fg); } .gp-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .gp-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .gp-empty .pi { font-size:var(--fs-lg); }
    .gp-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .gp-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:gp-pulse 1.4s ease-in-out infinite; }
    @keyframes gp-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .gp-skel-row { animation:none; } }
  `],
})
export class AlmacenPedidosComponent implements OnInit {
  private readonly api = inject(AlmacenPedidosService);
  private readonly perms = inject(PermissionsService);
  /**
   * [GP.3] La pantalla del surtidor es de FOCO (sin barra de pestañas), así que desde el tablero no
   * había cómo llegar: la entrada de foco sólo decide a dónde cae quien abre el área. Este botón es
   * la puerta para quien ve el tablero y también surte.
   */
  readonly puedeSurtir = this.perms.has$(Permission.COMMERCIAL_PICKING_GESTIONAR);
  /** [GP.4] Misma razón que Surtir: Checar es pantalla de foco y su entrada no pinta botón. */
  readonly puedeChecar = this.perms.has$(Permission.ALMACEN_CHECADO_GESTIONAR);
  /**
   * `[MCP.3.2]` Entra por el permiso de surtir, no por el del tablero (decisión de David,
   * 2026-10-19): ve sólo los pedidos autorizados por surtir de su sucursal, con folio y cliente.
   * Sin estatus, periodos, filtros, totales, importes ni detalle; el servidor tampoco le manda dinero.
   */
  private readonly veTablero = this.perms.has$(Permission.ALMACEN_PEDIDOS_VER);
  readonly soloSurtidor = computed(() => !this.veTablero());
  /** `[GP.10.4b]` D2: quien coordina el surtido tiene aquí la fila de surtido como segunda vista. */
  readonly coordina = this.perms.has$(Permission.ALMACEN_SURTIDO_COORDINAR);
  /** La vista que pide la dirección (`?vista=fila`); sin la clave de coordinar, siempre «Pedidos». */
  private readonly vista = signal<'pedidos' | 'fila'>('pedidos');
  /** `[GP.10.4c]` Hay vista «Pedidos» si ve el tablero o si surte (su lista reducida). */
  readonly hayPedidos = computed(() => this.veTablero() || this.puedeSurtir());
  /** Quien sólo coordina (sin tablero ni surtido; hoy nadie) cae directo en la fila: no tiene otra vista. */
  readonly enFila = computed(() => this.coordina() && (this.vista() === 'fila' || !this.hayPedidos()));
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly q$ = new Subject<string>();

  readonly skel = Array.from({ length: 8 });
  readonly skelDet = Array.from({ length: 6 });
  readonly money = money;
  readonly dmy = dmy;
  /** Fecha corta para la tabla: el año ya está en el periodo de arriba. */
  dm(v: string | null): string { return v ? dmy(v).slice(0, 5) : '—'; }

  /** `[GP.RF.22]` El periodo es UN desplegable (antes, 4 botones y un calendario siempre a la vista). */
  readonly periodoOpts: { value: Preset; label: string }[] = [
    { value: 'hoy', label: 'Hoy' },
    { value: 'semana', label: 'Semana' },
    { value: 'mes', label: 'Mes en curso' },
    { value: 'mes_anterior', label: 'Mes anterior' },
    { value: 'rango', label: 'Otro rango…' },
  ];
  readonly origenOpts = [
    { label: 'Todos los orígenes', value: null },
    { label: 'Telemarketing', value: 'TELEMARK' },
    { label: 'Sucursal', value: 'SUCURSAL' },
    // [GP.10.4a] D1: la preventa del vendedor entra al tablero como un origen más.
    { label: 'Preventa', value: ORIGEN_PREVENTA },
  ];

  readonly preset = signal<Preset>('mes');
  rangeDates: Date[] | null = null;
  /**
   * `[GP.10.4a]` Botón de etapa elegido (antes era el estatus de Kepler: la preventa no tiene).
   * `[GP.RF.22]` Arranca en «Por hacer»; `null` es «Todos». Sustituye a la casilla «Sólo autorizados en
   * adelante», que con «Por hacer» ya no decía nada nuevo.
   */
  readonly etapa = signal<EtapaElegida>('por_hacer');
  readonly origen = signal<string | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly q = signal('');
  /**
   * `[GP.RF.15]` Filtro por el estatus de KEPLER (no por etapa): llega de la liga de los atorados de
   * la fila (`?kepler_status=AUTORIZADO&branch=..&date_from=..&date_to=..`). Con él la lista cuadra
   * con la cuenta de la fila; por etapa no cuadraría.
   */
  readonly estatusKepler = signal<string | null>(null);
  /** `[GP.RF.16]` Los atorados del alcance (null = aún no se sabe; 'error' = no se pudo contar: se dice, no se calla). */
  readonly atorados = signal<WarehouseOrdersAtorados | 'error' | null>(null);
  /** La liga a la lista con la MISMA frontera que la cuenta (por estatus de Kepler, como GP.RF.15). */
  readonly ligaAtorados = computed<Record<string, string> | null>(() => {
    const a = this.atorados();
    if (!a || a === 'error' || !a.pedidos || !a.desde) return null;
    const q: Record<string, string> = { kepler_status: 'AUTORIZADO', date_from: a.desde, date_to: a.hasta };
    if (a.sucursales.length === 1) q['branch'] = a.sucursales[0].codigo;
    return q;
  });
  private ligaAplicada = '';

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<WarehouseOrdersResponse | null>(null);
  /** `[GP.10.5]` Página de la lista: el primer pedido que se ve (0, 200, 400…). */
  readonly pagina = PAGINA_PEDIDOS;
  readonly offset = signal(0);
  /** La respuesta de una consulta vieja (filtro o página anterior) no pisa la de la nueva. */
  private folioLista = 0;
  readonly sel = signal<WarehouseOrderRow | null>(null);
  readonly det = signal<WarehouseOrderDetail | null>(null);
  readonly detLoading = signal(false);
  readonly detErr = signal<string | null>(null);

  /**
   * Antigüedad del pedido sin embarcar más viejo DE LO QUE SE VE (respeta todos los filtros).
   * Antes eran tarjetas grandes y "Sin embarcar" ignoraba el filtro de estatus mientras "Pedidos"
   * lo respetaba: se leían como contradictorias (47 pedidos, 137 sin embarcar).
   */
  readonly masAntiguo = computed<number | null>(() => {
    const d = this.data();
    if (!d) return null;
    // [GP.10.5] Con página, el servidor lo calcula sobre TODO lo filtrado; la página no alcanza.
    if (d.totales.mas_antiguo_horas !== undefined) return d.totales.mas_antiguo_horas;
    return d.items.reduce<number | null>((m, r) => (r.horas_abierto != null && (m == null || r.horas_abierto > m) ? r.horas_abierto : m), null);
  });

  /** Sucursales para el filtro: las del alcance, o las que aparecen en el periodo si se ven todas. */
  readonly sucursalOpts = computed(() => {
    const d = this.data();
    const out: { label: string; value: string | null }[] = [{ label: 'Todas las sucursales', value: null }];
    if (!d) return out;
    const vistas = new Map<string, string>();
    // [GP.10.5] Las del periodo antes de filtrar (las de la página no son todas).
    if (d.alcance.todas && d.sucursales_periodo) for (const s of d.sucursales_periodo) vistas.set(s.codigo, s.nombre);
    else if (d.alcance.todas) for (const r of d.items) vistas.set(r.sucursal, r.sucursal_nombre);
    else for (const s of d.alcance.sucursales) vistas.set(s.codigo, s.nombre);
    const sel = this.sucursal();
    if (sel && !vistas.has(sel)) vistas.set(sel, sel);
    for (const [codigo, nombre] of [...vistas.entries()].sort()) out.push({ label: `${codigo} ${nombre}`, value: codigo });
    return out;
  });

  ngOnInit(): void {
    // [GP.RF.16] Una vez al abrir: no depende del periodo ni de los filtros (es lo que quedó FUERA).
    if (this.veTablero()) {
      this.api.atorados().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (a) => this.atorados.set(a),
        error: () => this.atorados.set('error'),
      });
    }
    this.q$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe((v) => {
      this.q.set(v);
      this.reload();
    });
    // [GP.10.4b] La lista se pide sólo en la vista «Pedidos» (en la fila no se ve: serían 1.3 MB de
    // balde), y una sola vez al volver a ella; después la refresca el botón o un filtro.
    // [GP.10.4c] `?origen=PREVENTA` llega de la ruta vieja de la Mesa de Control: el filtro ya puesto.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.vista.set(p.get('vista') === 'fila' ? 'fila' : 'pedidos');
      const o = p.get('origen');
      // Sólo un origen conocido (Object.hasOwn: «toString» también está «in» un objeto).
      const cambia = !!o && Object.hasOwn(ORIGEN, o) && o !== this.origen();
      if (cambia) this.origen.set(o);
      const liga = this.aplicarLiga(p);
      if (!this.enFila() && (cambia || liga || (!this.data() && !this.loading()))) this.reload();
    });
  }

  /**
   * `[GP.RF.22]` Lo que muestra el desplegable del periodo. «Otro rango…» abre el calendario y NO consulta
   * hasta que haya las dos fechas: mientras, la lista sigue siendo la del periodo anterior.
   */
  readonly eligiendoRango = signal(false);
  readonly periodoSel = computed<Preset>(() => (this.eligiendoRango() ? 'rango' : this.preset()));
  pickPeriodo(p: Preset): void {
    if (p === 'rango') { this.eligiendoRango.set(true); return; }
    this.eligiendoRango.set(false);
    this.preset.set(p);
    this.rangeDates = null;
    this.reload();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: no se consulta todavía
    this.eligiendoRango.set(false);
    this.preset.set('rango');
    this.reload();
  }

  /** Los botones de etapa son excluyentes: tocar el elegido no cambia nada. */
  pickEtapa(e: EtapaElegida): void {
    if (this.etapa() === e) return;
    this.etapa.set(e);
    this.reload();
  }
  pickOrigen(o: string | null): void { this.origen.set(o); this.reload(); }
  pickSucursal(s: string | null): void { this.sucursal.set(s); this.reload(); }
  onQ(v: string): void { this.q$.next(v); }

  /** «Por hacer» es la entrada, no un filtro: «Quitar filtros» regresa a ella. */
  hayFiltros(): boolean { return !!(this.etapa() !== 'por_hacer' || this.origen() || this.sucursal() || this.q() || this.estatusKepler()); }
  limpiar(): void {
    this.etapa.set('por_hacer'); this.origen.set(null); this.sucursal.set(null); this.q.set(''); this.estatusKepler.set(null);
    this.reload();
  }
  quitarKepler(): void { this.estatusKepler.set(null); this.reload(); }

  /**
   * `[GP.RF.15]` Aplica la liga de los atorados (una vez por liga distinta). Todo o nada: con un
   * estatus fuera de la lista, fechas inválidas o una sucursal mal escrita no se aplica NADA —un
   * filtro a medias mostraría otra cosa que la cifra de la que se vino—. Devuelve si cambió algo.
   */
  private aplicarLiga(p: ParamMap): boolean {
    const st = p.get('kepler_status');
    const desde = p.get('date_from') ?? '';
    const hasta = p.get('date_to') ?? '';
    const suc = p.get('branch');
    if (!st || !ESTATUS_KEPLER_LIGA.includes(st)) return false;
    if (!ISO_RE.test(desde) || !ISO_RE.test(hasta) || desde > hasta) return false;
    if (suc != null && !/^\d{2}$/.test(suc)) return false;
    const llave = [st, desde, hasta, suc ?? ''].join('|');
    if (llave === this.ligaAplicada) return false;
    this.ligaAplicada = llave;
    this.estatusKepler.set(st);
    this.sucursal.set(suc);
    // «Todos» y no «Por hacer»: la cifra de la fila es por estatus de Kepler, y por etapa no cuadraría.
    this.etapa.set(null); this.origen.set(null); this.q.set('');
    this.rangeDates = [fechaLocal(desde), fechaLocal(hasta)];
    this.eligiendoRango.set(false);
    this.preset.set('rango');
    return true;
  }

  private filtro(): AlmacenPedidosFiltro {
    const f: AlmacenPedidosFiltro = {
      // [GP.RF.22] «Por hacer» pide las etapas de autorizado a checado; «Todos» (null), ninguna.
      etapa: this.etapa() === 'por_hacer' ? [...ETAPAS_POR_HACER] : this.etapa() ? [this.etapa() as string] : [],
      // [GP.10.4a] D1: el tablero trae también la preventa (`PD-`) del periodo, por su fecha de entrega.
      preventa: true,
      origen: this.origen(),
      sucursal: this.sucursal(),
      q: this.q() || null,
    };
    const st = this.estatusKepler();
    if (st) f.estatus = [st];
    const hoy = new Date();
    const pagina = { limit: PAGINA_PEDIDOS, offset: this.offset() };
    if (this.soloSurtidor()) {
      // [MCP.3.2] Lo que le toca: AUTORIZADO (ya se puede surtir y nadie lo ha surtido). Ventana de
      // 30 días y no "el mes": el día 1 no deben desaparecer los autorizados del mes anterior.
      const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 30);
      return { estatus: ['AUTORIZADO'], origen: null, sucursal: null, q: null, from: iso(desde), to: iso(hoy), ...pagina };
    }
    Object.assign(f, pagina);
    switch (this.preset()) {
      case 'hoy': f.from = f.to = iso(hoy); break;
      case 'semana': {
        const lunes = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - ((hoy.getDay() + 6) % 7));
        f.from = iso(lunes); f.to = iso(hoy); break;
      }
      case 'mes': f.month = `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}`; break;
      case 'mes_anterior': {
        const x = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
        f.month = `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; break;
      }
      case 'rango': {
        const [a, b] = this.rangeDates || [];
        if (a && b) { f.from = iso(a); f.to = iso(b); }
        break;
      }
    }
    return f;
  }

  /** Cambió un filtro o el periodo: vuelve a la primera página. */
  reload(): void {
    this.offset.set(0);
    this.cargar(true);
  }
  /** «Actualizar» y «Reintentar»: la misma página, con los datos de ahora. */
  refrescar(): void { this.cargar(true); }
  /** `[GP.10.5]` Otra página: el pedido abierto en el panel se queda abierto aunque no esté en ella. */
  onPagina(ev: TableLazyLoadEvent): void {
    const o = ev.first ?? 0;
    if (o === this.offset()) return; // la tabla lo dispara también al nacer, con la página que ya está
    this.offset.set(o);
    this.cargar(false);
  }

  /** `soltarAjeno`: si el pedido abierto ya no está en lo que llegó, se cierra (un filtro lo sacó). */
  private cargar(soltarAjeno: boolean): void {
    const folio = ++this.folioLista;
    this.loading.set(true);
    this.err.set(null);
    this.api.list(this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        if (folio !== this.folioLista) return;
        this.data.set(d);
        const s = this.sel();
        if (soltarAjeno && s && !d.items.some((x) => x.clave === s.clave)) { this.sel.set(null); this.det.set(null); }
        this.loading.set(false);
      },
      error: () => {
        if (folio !== this.folioLista) return;
        this.loading.set(false);
        this.err.set('No se pudieron cargar los pedidos.');
      },
    });
  }

  pick(r: WarehouseOrderRow | null): void {
    if (this.soloSurtidor()) return; // el detalle es del tablero; el surtidor no tiene esa clave
    this.sel.set(r);
    this.det.set(null);
    this.detErr.set(null);
    this.detLoading.set(false);
    // [GP.10.4a] Un PD- no tiene detalle de Kepler: su resumen sale de la fila (preventaSel).
    if (!r || this.esPreventa(r)) return;
    this.detLoading.set(true);
    this.api.detail(r.sucursal, r.serie, r.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => { if (this.sel()?.clave === r.clave) this.det.set(x); this.detLoading.set(false); },
      error: () => { this.detLoading.set(false); this.detErr.set('No se pudo cargar el detalle del pedido.'); },
    });
  }

  multiSucursal(d: WarehouseOrdersResponse): boolean { return !this.sucursal() && (d.alcance.todas || d.alcance.sucursales.length > 1); }
  /** `[GP.10.5]` Cuántos pedidos tiene la lista con los filtros (todas las páginas). */
  totalLista(d: WarehouseOrdersResponse): number { return d.pagina?.total ?? d.items.length; }
  /**
   * El número de «Todos»: los mismos que lista sin filtro, o sea SIN cancelados (`[GP.10.0]`). Se suma
   * por ETAPA (`[GP.10.4a]`): por estatus de Kepler dejaría fuera la preventa, que sí está en la lista.
   */
  totalConteos(d: WarehouseOrdersResponse): number {
    return d.conteos_etapa.reduce((t, c) => (c.etapa === 'cancelado' ? t : t + c.pedidos), 0);
  }
  /** `[GP.RF.22]` El número de «Por hacer»: la suma de sus etapas, igual que lo que lista. */
  totalPorHacer(d: WarehouseOrdersResponse): number {
    return d.conteos_etapa.reduce((t, c) => (ETAPAS_POR_HACER.includes(c.etapa) ? t + c.pedidos : t), 0);
  }
  /** Botones de etapa: las que tienen pedidos, en el orden del flujo, y la elegida aunque quede en cero. */
  chipsEtapa(d: WarehouseOrdersResponse): WarehouseOrdersResponse['conteos_etapa'] {
    return d.conteos_etapa.filter((c) => c.pedidos > 0 || c.etapa === this.etapa());
  }
  readonly cancelado = WAREHOUSE_ORDER_CANCELADO;
  /** `[GP.10.4a]` El `PD-` elegido, cuyo resumen va en el panel en lugar del detalle de Kepler. */
  readonly preventaSel = computed<WarehouseOrderRow | null>(() => {
    const s = this.sel();
    return s && this.esPreventa(s) ? s : null;
  });
  esPreventa(r: WarehouseOrderRow): boolean { return r.origen === ORIGEN_PREVENTA; }
  etapaLabel(e: EtapaPedido | null | undefined): string { return e ? ETAPA[e]?.label ?? e : 'Sin dato'; }
  etapaSev(e: EtapaPedido | null | undefined): Sev { return (e && ETAPA[e]?.sev) || 'secondary'; }
  /**
   * `[GP.10.4a]` Kepler y la Suite no coinciden en un hito (surtido, checado, embarcado). En la fila se
   * dice cuál va atrás; si Kepler va atrás es trabajo pendiente de captura (por eso el tono de aviso).
   */
  desfaseTexto(r: Pick<WarehouseOrderRow, 'desfase' | 'estatus_kepler' | 'estatus'>): string | null {
    if (r.desfase === 'piso_adelante') return `Kepler aún dice ${this.estatusLabel(r.estatus_kepler ?? r.estatus).toLowerCase()}`;
    if (r.desfase === 'kepler_adelante') return 'En la Suite sigue abierto';
    return null;
  }
  /** Lo mismo, junto al estatus de Kepler en el detalle (ahí ya se lee qué dice Kepler). */
  desfaseDetalle(r: Pick<WarehouseOrderRow, 'desfase'>): string | null {
    if (r.desfase === 'piso_adelante') return 'atrás de lo registrado en la Suite';
    if (r.desfase === 'kepler_adelante') return 'adelante de lo registrado en la Suite';
    return null;
  }
  /** La sucursal por su NOMBRE (nunca sólo «06»): del alcance o de las filas que llegaron. */
  /** `[GP.RF.21]` Cuántos de un origen verá al elegirlo (`null` con una API anterior o en cero: no se pinta). */
  cuentaOrigen(d: WarehouseOrdersResponse, origen: string): number | null {
    return d.conteos_origen?.find((c) => c.origen === origen)?.pedidos || null;
  }

  /** `[GP.RF.16]` Dónde se concentran: con varias sucursales, la que más tiene (Q.3: señalar dónde está). */
  atoradosDonde(a: WarehouseOrdersAtorados): string {
    if (a.sucursales.length < 2) return a.sucursales.length === 1 ? ` en ${a.sucursales[0].nombre}` : '';
    const top = [...a.sucursales].sort((x, y) => y.pedidos - x.pedidos)[0];
    return `, en ${a.sucursales.length} sucursales (${top.pedidos.toLocaleString('es-MX')} en ${top.nombre})`;
  }

  sucursalNombre(d: WarehouseOrdersResponse, codigo: string): string {
    const n =
      d.alcance.sucursales.find((x) => x.codigo === codigo)?.nombre ??
      d.sucursales_periodo?.find((x) => x.codigo === codigo)?.nombre ??
      d.items.find((x) => x.sucursal === codigo)?.sucursal_nombre;
    return n ? `${codigo} ${n}` : codigo;
  }
  sucursalesTexto(d: WarehouseOrdersResponse): string { return d.alcance.sucursales.map((x) => `${x.codigo} ${x.nombre}`).join(', '); }
  estatusLabel(e: string | null): string { return e ? ESTATUS[e]?.label ?? e : 'Sin estatus'; }
  estatusSev(e: string | null): Sev { return (e && ESTATUS[e]?.sev) || 'secondary'; }
  origenLabel(o: string | null): string { return o ? ORIGEN[o] ?? o : '—'; }
  /** El renglón se agregó después de que el pedido se creó (en surtido, checado o embarque). */
  agregado(etapa: string | null): boolean { return !!etapa && etapa !== 'CREADO' && etapa !== 'AUTORIZADO'; }
  difiere(a: number | null, b: number | null): boolean { return a != null && b != null && Math.abs(a - b) > 0.0001; }
  volumenTexto(v: { unidad: string; cantidad: number }[] | null | undefined): string {
    if (!v?.length) return '';
    return [...v]
      .sort((a, b) => ordenUnidad(a.unidad) - ordenUnidad(b.unidad) || b.cantidad - a.cantidad)
      // [GP.10.5] «6 500» se leía como un número; con el gramaje como unidad va «6 de 500».
      // [GP.RF.22] Espacios que no se parten: al bajar de renglón, «20 PZA» no queda cortado en dos.
      .map((x) => `${x.cantidad.toLocaleString('es-MX', { maximumFractionDigits: 2 })} ${ES_GRAMAJE.test(x.unidad) ? `de ${x.unidad}` : x.unidad}`)
      .join(' · ');
  }

  /** `[GP.10.5]` D4: las partes del total que no están en cero, en orden fijo. Sin ninguna, «a clientes» en cero. */
  partesImporte(p: { clientes: number; traspaso_sucursal: number; carga_ruta: number }): { k: string; v: number; label: string }[] {
    const todas = [
      { k: 'clientes', v: p.clientes, label: 'a clientes' },
      { k: 'traspaso', v: p.traspaso_sucursal, label: 'traspaso a sucursales' },
      { k: 'ruta', v: p.carga_ruta, label: 'carga a ruta' },
    ];
    const con = todas.filter((x) => x.v !== 0);
    return con.length ? con : [todas[0]];
  }
  cant(v: number | null): string { return v == null ? '—' : v.toLocaleString('es-MX', { maximumFractionDigits: 3 }); }
  horas(h: number | null): string {
    if (h == null) return '—';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toLocaleString('es-MX', { maximumFractionDigits: 1 })} h`;
    return `${Math.floor(h / 24)} d`;
  }
  hora(isoTs: string): string {
    return new Date(isoTs).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}
