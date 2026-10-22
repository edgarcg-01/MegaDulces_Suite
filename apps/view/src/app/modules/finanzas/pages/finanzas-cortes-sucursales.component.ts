import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type {
  CorteArqueo, CorteCobro, CorteCuadre, CorteEstadoCobro, CorteRow, CorteSucursalResumen, CortesSucursalesResponse,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

const COBRO: Record<CorteEstadoCobro, { label: string; sev: Sev }> = {
  sin_cobro: { label: 'Sin cobro', sev: 'secondary' },
  parcial: { label: 'Cobro parcial', sev: 'warn' },
  cobrado: { label: 'Cobrado', sev: 'success' },
  sobrecobrado: { label: 'Cobrado de más', sev: 'danger' },
};
const CUADRE: Record<CorteCuadre, { label: string; sev: Sev }> = {
  cuadra: { label: 'Cuadra', sev: 'success' },
  faltante_arqueo: { label: 'Faltante en arqueo', sev: 'danger' },
  sobrante_arqueo: { label: 'Sobrante en arqueo', sev: 'warn' },
  corte_distinto: { label: 'Corte distinto', sev: 'warn' },
  sin_arqueo: { label: 'Sin arqueo', sev: 'info' },
};

/** La etiqueta del cuadre como se pinta (con la diferencia cuando la hay). La usan la tabla y el buscador. */
export function etiquetaCuadre(c: CorteRow): string {
  const base = CUADRE[c.cuadre].label;
  return c.cuadre === 'cuadra' || c.cuadre === 'sin_arqueo' || c.diferencia === null ? base : `${base} ${money(c.diferencia)}`;
}

/**
 * `[CSU.13]` Todo lo que una persona puede traer en la mano para encontrar un corte: el folio (con y sin
 * ceros: «12» encuentra UD2301-0000012), la caja-turno, la sucursal, la fecha como se ve, los montos como
 * se ven («1,203» encuentra $1,203.36), los estados, el cajero, y los cobros y devoluciones del corte.
 */
export function camposBuscablesDeCorte(c: CorteRow): (string | number | null | undefined)[] {
  const sinCeros = (f: string | null | undefined): string => (f && /^\d+$/.test(f) ? String(Number(f)) : '');
  return [
    c.documento, c.folio, sinCeros(c.folio), c.referencia, c.caja && c.turno ? `${c.caja}-${c.turno}` : null,
    ...variantesDeFolio('UD2301', c.folio),
    c.sucursal, c.sucursal_nombre, dmy(c.fecha), c.fecha,
    money(c.monto), money(c.cobrado), money(c.saldo),
    COBRO[c.estado_cobro].label, etiquetaCuadre(c), c.arqueo?.cajero,
    ...c.cobros.flatMap((x) => [`${x.doc_prefix}-${x.folio}`, ...variantesDeFolio(x.doc_prefix, x.folio), x.folio, sinCeros(x.folio),
      money(x.monto), x.forma_pago, x.concepto, x.cuenta_tesoreria]),
    ...c.devoluciones.flatMap((x) => [`${x.doc_prefix}-${x.folio}`, ...variantesDeFolio(x.doc_prefix, x.folio), sinCeros(x.folio),
      money(x.monto), x.cliente, x.motivo, x.cajero]),
    // [CSU.13] Los cancelados también se encuentran (por folio, monto o concepto), y «cancelado» lista
    // todos los cortes que tienen alguno.
    ...(c.cobros_cancelados ?? []).flatMap((x) => [`${x.doc_prefix}-${x.folio}`, ...variantesDeFolio(x.doc_prefix, x.folio), sinCeros(x.folio),
      money(x.monto), x.concepto, 'cancelado en kepler']),
  ];
}

/**
 * `[CSU.13]` Cómo se ESCRIBE un folio de Kepler a mano, medido en lo que reportó el PM: «au501-00076» para
 * el cobro `UA0501-0000076`. Tres diferencias contra el folio real, las tres comunes:
 *   · las letras al revés (`AU` por `UA`: el documento es U-A-5-1),
 *   · el tipo sin su cero (`501` por `0501`, o hasta `51`),
 *   · el folio con otra cantidad de ceros (`00076` por `0000076`).
 * Como la búsqueda compara FRAGMENTOS de texto, ninguna de esas formas encontraba nada. La regla: un folio
 * se compara por NÚMERO, no por texto. El documento publica sus variantes cortas (folio sin ceros) y la
 * consulta se lleva a esa misma forma corta con `consultaDeCortes`.
 */
export function variantesDeFolio(prefijo: string | null | undefined, folio: string | null | undefined): string[] {
  const m = (prefijo ?? '').toUpperCase().match(/^([A-Z])([A-Z])(\d{2})(\d{2})$/);
  if (!m || !folio || !/^\d+$/.test(folio)) return [];
  const [, a, b, tipo, serie] = m;
  const n = String(Number(folio));
  const tipos = [...new Set([`${tipo}${serie}`, `${Number(tipo)}${serie}`, `${Number(tipo)}${Number(serie)}`])];
  // `#` cierra el número: sin él, `ua0501-76` sería fragmento de `ua0501-761` y el folio 76 traería el 761.
  return [`${a}${b}`, `${b}${a}`].flatMap((letras) => tipos.map((t) => `${letras}${t}-${n}#`));
}

/** Lleva cada palabra con forma de folio (`au501-00076`, `UA0501-0000076`) a su forma corta (`au501-76#`). */
export function consultaDeCortes(q: string | null | undefined): string {
  return (q ?? '').split(/\s+/).map((t) => t.replace(/^([a-z]{2}\d{1,4})-0*(\d+)$/i, '$1-$2#')).join(' ');
}

/**
 * `[CSU.15]` Un día de una sucursal, con sus cortes adentro. Es la fila de la lista principal.
 *
 * El grano es **(fecha, sucursal)** y no sólo la fecha: el total que hoy se suma a mano es el de
 * una plaza en un día, y un renglón que mezclara ocho sucursales no se podría cuadrar contra nada.
 */
export interface DiaDeCortes {
  /** Llave de la fila para `dataKey`/expansión: `<fecha>|<sucursal>`. */
  clave: string;
  fecha: string;
  sucursal: string;
  sucursal_nombre: string;
  cortes: CorteRow[];
  monto: number;
  cobrado: number;
  saldo: number;
  /** Cortes del día que todavía no se cobraron completos. */
  pendientes: number;
  /** Cortes del día cuyo arqueo no cuadra (faltante, sobrante o corte distinto). */
  descuadrados: number;
}

const CUADRE_MALO: readonly CorteCuadre[] = ['faltante_arqueo', 'sobrante_arqueo', 'corte_distinto'];

/**
 * `[CSU.15]` Englobar los cortes por día de sucursal — **el único cambio al proceso de hoy**.
 *
 * ⭐ Agrupa lo que ya se está viendo, no lo que trajo el servidor: recibe la lista **ya filtrada**
 * (sucursal elegida, «sólo con saldo», búsqueda). Si agrupara el universo completo, el total del
 * renglón no sería el de los cortes que se despliegan debajo — un número que no cuadra con su
 * propio detalle, que es peor que no tenerlo.
 *
 * Orden: el día más reciente primero y, dentro del día, por nombre de sucursal. Los cortes de cada
 * día conservan el orden en que venían.
 */
export function agruparCortesPorDia(cortes: readonly CorteRow[]): DiaDeCortes[] {
  const grupos = new Map<string, DiaDeCortes>();
  for (const c of cortes) {
    const clave = `${c.fecha}|${c.sucursal}`;
    let g = grupos.get(clave);
    if (!g) {
      g = {
        clave, fecha: c.fecha, sucursal: c.sucursal, sucursal_nombre: c.sucursal_nombre,
        cortes: [], monto: 0, cobrado: 0, saldo: 0, pendientes: 0, descuadrados: 0,
      };
      grupos.set(clave, g);
    }
    g.cortes.push(c);
    g.monto += c.monto;
    g.cobrado += c.cobrado;
    g.saldo += c.saldo;
    if (c.saldo > 0.005) g.pendientes++;
    if (CUADRE_MALO.includes(c.cuadre)) g.descuadrados++;
  }
  return [...grupos.values()].sort((a, b) =>
    a.fecha === b.fecha ? a.sucursal_nombre.localeCompare(b.sucursal_nombre, 'es') : b.fecha.localeCompare(a.fecha));
}

/** El corte de caja POS (U-D-23) arrancó en Kepler con el cambio del 1-oct-2026. */
const INICIO_CORTES = '2026-10-01';

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * `[CSU.2]` Cortes/Sucursales — el dinero de mostrador por turno de caja.
 *
 * Corte de caja POS (Kepler `U-D-23`, cliente CONTADO) → cobros aplicados (`U-A-5`) → arqueo del
 * turno. Responde "¿cuánto vendió cada caja, cuánto ya se cobró y qué falta?". Sólo lectura: el
 * cobro se captura en Kepler. El paso al banco (y el tramo del efectivo por Caja Fuerte) es la
 * entrega 2 y se DECLARA en el detalle, no se dibuja como pendiente.
 */
@Component({
  selector: 'app-finanzas-cortes-sucursales',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, DatePickerModule, ToggleSwitchModule, TagModule,
    InputTextModule, IconFieldModule, InputIconModule, MetricStripComponent, SucursalPipe],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cortes / Sucursales</h1>
          <p class="surf-page-sub">Lo que vendió cada caja (corte de caja POS, cliente <b>CONTADO</b>), cuánto ya se cobró en Kepler y cuánto sigue pendiente. Se cuadra contra el arqueo del mismo turno.</p>
        </div>
        <div class="cs-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cs-filters">
        <!-- [CSU.13] Buscador sobre la lista COMPLETA del periodo (no paginada en el servidor): token por
             token, sin acentos y en todos los campos del corte, sus cobros y sus devoluciones. -->
        <div class="cs-field cs-buscar"><label for="cs-q">Buscar corte <kbd class="cs-kbd" aria-hidden="true">/</kbd></label>
          <p-iconfield>
            <!-- El ícono va ADENTRO. Medido en el navegador: PrimeNG 22 pisa el class del host de p-inputicon
                 (host [class] = cx root) y su plantilla es sólo ng-content, así que styleClass y class se pierden y
                 la lupa queda en 0 px. Las otras 3 pantallas que usan styleClass tienen la lupa invisible igual. -->
            <p-inputicon><i class="pi pi-search" aria-hidden="true"></i></p-inputicon>
            <input #buscador pInputText id="cs-q" type="search" class="cs-q" autocomplete="off" [ngModel]="q()" (ngModelChange)="q.set($event)"
                   (keydown.escape)="limpiarBusqueda()" placeholder="Folio, caja-turno, cobro, monto, cajero…"
                   aria-describedby="cs-q-ayuda" />
          </p-iconfield>
          <span id="cs-q-ayuda" class="sr-only">Busca en todas las sucursales del periodo. Varias palabras en cualquier orden. Escape limpia.</span>
        </div>
        <div class="cs-field"><label for="cs-mes">Mes</label>
          <p-select inputId="cs-mes" [options]="mesOpts" optionLabel="label" optionValue="value" [ngModel]="mes()" (onChange)="pickMes($event.value)" placeholder="Rango" appendTo="body" class="cs-sel" /></div>
        <div class="cs-field"><label for="cs-rango">Rango específico</label>
          <p-datepicker inputId="cs-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Elegir fechas" (onClose)="onRange()" /></div>
        <div class="cs-field cs-toggle"><label for="cs-saldo">Sólo con saldo</label>
          <p-toggleswitch inputId="cs-saldo" [ngModel]="soloSaldo()" (ngModelChange)="soloSaldo.set($event)" /></div>
      </div>

      @if (err(); as e) { <div class="cs-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="cs-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track $index) { <div class="fb-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <p class="cs-periodo">Periodo {{ dmy(d.periodo.from) }} – {{ dmy(d.periodo.to) }}@if (d.ultimo_corte) { · último corte {{ dmy(d.ultimo_corte) }} }@if (d.cortes_en_blanco) { · {{ d.cortes_en_blanco }} corte(s) en blanco (menos de $1) no se listan }</p>
        @if (!d.alcance.todas) {
          @if (d.alcance.sucursales.length) {
            <div class="cs-note" role="note"><i class="pi pi-shop" aria-hidden="true"></i><span>Viendo sólo {{ d.alcance.sucursales.length === 1 ? 'tu sucursal' : 'tus sucursales' }}: <b>{{ sucursalesTexto(d) }}</b>.</span></div>
          } @else {
            <div class="cs-note cs-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay cortes que mostrarte. Pide que te la asignen en <b>Administración › Personas</b>.</span></div>
          }
        }
        @if (antesDeCortes(d)) {
          <div class="cs-note" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i><span>El corte de caja POS en Kepler arrancó el <b>01/10/2026</b>. Antes de esa fecha casi no hay cortes; un periodo anterior se ve vacío por eso, no porque no haya habido venta.</span></div>
        }

        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de cortes del periodo" />

        <section class="cs-block dt-scope" aria-labelledby="cs-h-suc">
          <div class="cs-bh"><h2 id="cs-h-suc">Por sucursal</h2>
            <span class="cs-hint" aria-live="polite">@if (selSuc(); as s) { Viendo {{ s.sucursal }} {{ s.sucursal_nombre }}@if (sucursalesOcultas()) { · {{ sucursalesOcultas() }} oculta{{ sucursalesOcultas() > 1 ? 's' : '' }} } · <button type="button" class="cs-link" (click)="pickSuc(null)">ver todas</button> } @else { Elige una sucursal para ver sus cortes }</span></div>
          <!-- [CSU.14] Con una sucursal elegida sólo queda su fila: las demás se ocultan para dar el espacio a sus
               cortes. Vuelven con «ver todas» o con otro clic sobre la misma fila. -->
          <p-table [value]="sucursalesVisibles()" size="small" class="surf-table dt-stack" [rowHover]="true" selectionMode="single" [selection]="selSuc()" (selectionChange)="pickSuc($event)" dataKey="sucursal">
            <ng-template #header><tr><th>Sucursal</th><th class="ta-r">Cortes</th><th class="ta-r">Vendido</th><th class="ta-r">Cobrado</th><th class="ta-r">Pendiente</th><th class="ta-r">% cobrado</th><th>Abierto desde</th><th>Revisar</th></tr></ng-template>
            <ng-template #body let-s>
              <tr [pSelectableRow]="s">
                <td role="cell" data-label="Sucursal"><span class="cs-mono muted">{{ s.sucursal }}</span> {{ s.sucursal_nombre }}</td>
                <td class="ta-r num" role="cell" data-label="Cortes">{{ s.cortes }}</td>
                <td class="ta-r num" role="cell" data-label="Vendido">{{ money(s.vendido) }}</td>
                <td class="ta-r num" role="cell" data-label="Cobrado" [class.muted]="!s.cobrado">{{ s.cobrado ? money(s.cobrado) : '—' }}</td>
                <td class="ta-r num cs-strong" role="cell" data-label="Pendiente">{{ money(s.pendiente) }}</td>
                <td class="ta-r num" role="cell" data-label="% cobrado">{{ pct(s.cobrado, s.vendido) }}</td>
                <td role="cell" data-label="Abierto desde">@if (s.abierto_desde) { {{ dmy(s.abierto_desde) }} <span class="muted">· {{ dias(s.abierto_desde) }} d</span> } @else { <span class="muted">—</span> }</td>
                <td role="cell" data-label="Revisar">
                  @if (s.con_diferencia) { <p-tag [value]="s.con_diferencia + ' con diferencia'" severity="warn" styleClass="cs-tag" /> }
                  @if (s.sin_arqueo) { <p-tag [value]="s.sin_arqueo + ' sin arqueo'" severity="info" styleClass="cs-tag" /> }
                  @if (!s.con_diferencia && !s.sin_arqueo) { <span class="muted">—</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="cs-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin cortes de caja en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        </section>

        <div class="cs-split">
          <section class="cs-block dt-scope" aria-labelledby="cs-h-cortes">
            <div class="cs-bh"><h2 id="cs-h-cortes">Cortes @if (selSuc(); as s) { · {{ s.sucursal_nombre }} }</h2>
              <span class="cs-hint" aria-live="polite">@if (q().trim()) { {{ cortes().length }} de {{ cortesBase().length }} corte(s) con «{{ q().trim() }}» · <button type="button" class="cs-link" (click)="limpiarBusqueda()">limpiar</button> · } @else { {{ diasDeCortes().length }} día(s) · {{ cortes().length }} corte(s) · } pendiente {{ money(pendienteVisible()) }}
                @if (!plegadoBloqueado() && diasDeCortes().length > 1) { · <button type="button" class="cs-link" (click)="todosLosDias(!algunDiaAbierto())">{{ algunDiaAbierto() ? 'plegar todos' : 'desplegar todos' }}</button> }</span></div>
            <p-table [value]="diasDeCortes()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" dataKey="clave" [expandedRowKeys]="diasAbiertos()" [paginator]="diasDeCortes().length > 100" [rows]="100">
              <ng-template #header><tr><th class="cs-togcol"><span class="sr-only">Desplegar</span></th><th>Día</th>@if (!selSuc()) { <th>Sucursal</th> }<th class="ta-r">Cortes</th><th class="ta-r">Monto</th><th class="ta-r">Cobrado</th><th class="ta-r">Saldo</th><th>Estado</th></tr></ng-template>
              <ng-template #body let-d let-expanded="expanded">
                <tr class="cs-dia" [class.cs-dia-abierta]="expanded">
                  <td role="cell" data-label="Desplegar"><button type="button" class="cs-tog" (click)="toggleDia(d)" [disabled]="plegadoBloqueado()"
                      [attr.aria-expanded]="expanded" [attr.aria-label]="(expanded ? 'Plegar ' : 'Desplegar ') + d.cortes.length + ' cortes de ' + (d.sucursal | sucursal) + ' del ' + dmy(d.fecha)">
                      <i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i></button></td>
                  <td class="cs-mono cs-strong" role="cell" data-label="Día">{{ dmy(d.fecha) }}</td>
                  @if (!selSuc()) { <td role="cell" data-label="Sucursal">{{ d.sucursal | sucursal }}</td> }
                  <td class="ta-r num muted" role="cell" data-label="Cortes">{{ d.cortes.length }}</td>
                  <td class="ta-r num cs-strong" role="cell" data-label="Monto">{{ money(d.monto) }}</td>
                  <td class="ta-r num" role="cell" data-label="Cobrado" [class.muted]="!d.cobrado">{{ d.cobrado ? money(d.cobrado) : '—' }}</td>
                  <td class="ta-r num cs-strong" role="cell" data-label="Saldo" [class.cs-bad]="d.saldo > 0.005">{{ money(d.saldo) }}</td>
                  <td role="cell" data-label="Estado">
                    @if (d.pendientes) { <p-tag [value]="d.pendientes + ' por cobrar'" severity="warn" styleClass="cs-tag" /> } @else { <p-tag value="Todo cobrado" severity="success" styleClass="cs-tag" /> }
                    @if (d.descuadrados) { <p-tag [value]="d.descuadrados + ' sin cuadrar'" severity="danger" styleClass="cs-tag" /> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-d>
                <tr class="cs-dia-det"><td [attr.colspan]="selSuc() ? 7 : 8">
                  <table class="cs-cortes">
                    <thead><tr><th>Corte</th><th>Caja</th><th class="ta-r">Monto</th><th class="ta-r">Cobrado</th><th class="ta-r">Saldo</th><th>Cobro</th><th>Cuadre</th></tr></thead>
                    <tbody>
                      @for (c of d.cortes; track c.clave) {
                        <tr class="cs-corte" [class.cs-corte-sel]="selCorte()?.clave === c.clave" (click)="selCorte.set(c)" tabindex="0"
                            (keydown.enter)="selCorte.set(c)" (keydown.space)="selCorte.set(c); $event.preventDefault()"
                            [attr.aria-label]="'Ver el corte ' + c.documento">
                          <td class="cs-mono">{{ c.documento }}</td>
                          <td class="cs-mono">{{ c.caja && c.turno ? c.caja + '-' + c.turno : c.referencia }}</td>
                          <td class="ta-r num">{{ money(c.monto) }}</td>
                          <td class="ta-r num" [class.muted]="!c.cobrado">{{ c.cobrado ? money(c.cobrado) : '—' }}</td>
                          <td class="ta-r num cs-strong">{{ money(c.saldo) }}</td>
                          <td><p-tag [value]="cobroLabel(c.estado_cobro)" [severity]="cobroSev(c.estado_cobro)" styleClass="cs-tag" />
                            @if (c.cobros_cancelados.length) { <p-tag [value]="c.cobros_cancelados.length + ' cancelado' + (c.cobros_cancelados.length > 1 ? 's' : '')" severity="secondary" styleClass="cs-tag" [attr.title]="'Cobros cancelados en Kepler: no suman'" /> }</td>
                          <td><p-tag [value]="cuadreLabel(c)" [severity]="cuadreSev(c.cuadre)" styleClass="cs-tag" /></td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </td></tr>
              </ng-template>
              <ng-template #emptymessage><tr><td [attr.colspan]="selSuc() ? 7 : 8">
                @if (q().trim()) {
                  <div class="cs-empty"><i class="pi pi-search" aria-hidden="true"></i><span>Ningún corte coincide con «{{ q().trim() }}»{{ soloSaldo() ? ' entre los que tienen saldo' : '' }}.</span>
                    @if (enOtrasSucursales()) { <span>Hay {{ enOtrasSucursales() }} en otras sucursales · <button type="button" class="cs-link" (click)="pickSuc(null)">ver todas</button></span> }
                    <button type="button" class="cs-link" (click)="limpiarBusqueda()">Limpiar búsqueda</button></div>
                } @else {
                  <div class="cs-empty"><i class="pi pi-check-circle" aria-hidden="true"></i><span>{{ soloSaldo() ? 'Ningún corte con saldo pendiente.' : 'Sin cortes en el periodo.' }}</span></div>
                }
              </td></tr></ng-template>
            </p-table>
          </section>

          <section class="cs-block cs-detail" aria-labelledby="cs-h-det" aria-live="polite">
            @if (selCorte(); as c) {
              <div class="cs-bh"><h2 id="cs-h-det">{{ c.documento }} · {{ c.referencia }}</h2><p-tag [value]="cobroLabel(c.estado_cobro)" [severity]="cobroSev(c.estado_cobro)" styleClass="cs-tag" /></div>
              <p class="cs-hint cs-pad">{{ c.sucursal | sucursal }} · {{ dmy(c.fecha) }}@if (c.arqueo?.cajero) { · cerró {{ c.arqueo?.cajero }} }</p>

              <div class="cs-step">
                <h3><span class="cs-n">1</span> Corte contra el arqueo del turno</h3>
                @if (c.arqueo; as a) {
                  <table class="cs-mini">
                    <!-- [CSU.9] Tres columnas, no dos. La de en medio decia "Contado" y NO lo es:
                         es lo que el cajero DECLARA al cerrar, identico al esperado en el 81.2% de
                         los cortes. El contado de verdad es el de la derecha, por denominacion. -->
                    <thead><tr><th></th><th class="ta-r">Esperado</th><th class="ta-r">Declarado</th><th class="ta-r">Contado</th></tr></thead>
                    <tbody>
                      <tr><td>Efectivo</td><td class="ta-r num">{{ money(a.efectivo_esperado) }}</td><td class="ta-r num" [class.cs-bad]="a.efectivo_contado < a.efectivo_esperado - 1">{{ money(a.efectivo_contado) }}</td><td class="ta-r num cs-strong">{{ a.conteo_fisico === null ? '—' : money(a.conteo_fisico) }}</td></tr>
                      <tr><td>Tarjeta</td><td class="ta-r num">{{ money(a.tarjeta_esperado) }}</td><td class="ta-r num">{{ money(a.tarjeta_contado) }}</td><td class="ta-r num muted">—</td></tr>
                      <tr><td>Transferencia</td><td class="ta-r num">{{ money(a.transfer_esperado) }}</td><td class="ta-r num">{{ money(a.transfer_contado) }}</td><td class="ta-r num muted">—</td></tr>
                      <tr class="cs-tot"><td>Total</td><td class="ta-r num">{{ money(a.esperado_total) }}</td><td class="ta-r num">{{ money(a.contado_total) }}</td><td class="ta-r num cs-strong">{{ a.conteo_fisico === null ? '—' : money(a.conteo_fisico) }}</td></tr>
                    </tbody>
                  </table>
                  @if (c.devoluciones.length) {
                    <p class="cs-sub">Devoluciones pagadas en esta caja</p>
                    @for (v of c.devoluciones; track v.doc_prefix + v.folio) {
                      <div class="cs-row cs-dev">
                        <span>{{ v.doc_prefix }}-{{ v.folio }}@if (v.cliente) { · {{ v.cliente }} }@if (v.motivo) { <span class="muted cs-motivo"> · {{ v.motivo }}</span> }</span>
                        <span class="num">-{{ money(v.monto) }}</span>
                      </div>
                    }
                    <div class="cs-row cs-tot"><span>Esperado neto de devoluciones</span><span class="num">{{ money(a.esperado_neto) }}</span></div>
                  }
                  <div class="cs-row"><span>Monto del corte en Kepler</span><span class="num cs-strong">{{ money(c.monto) }}</span></div>
                  <div class="cs-row"><span>{{ cuadreLabel(c) }}</span><span class="num" [class.cs-bad]="c.cuadre !== 'cuadra'">{{ c.diferencia === null ? '—' : money(c.diferencia) }}</span></div>
                  <!-- [CSU.9] El testigo independiente. Va DESPUES del veredicto a proposito: lo
                       corrige, no lo reemplaza. -->
                  @if (a.conteo_fisico !== null) {
                    <div class="cs-row cs-fis">
                      <span>Contado menos declarado <span class="muted">(billetes + monedas + retirado)</span></span>
                      <span class="num" [class.cs-bad]="a.fisico_diferencia !== null && abs(a.fisico_diferencia) > 1">{{ money(a.fisico_diferencia || 0) }}</span>
                    </div>
                  } @else {
                    <p class="cs-hint">Este corte <b>no trae el desglose por denominación</b>: el efectivo declarado no se puede verificar contra nada.</p>
                  }
                  @if (a.arqueo_declarado) {
                    <p class="cs-hint cs-nota"><b>El arqueo declaró lo esperado, no lo contó</b>: la columna Declarado ({{ money(a.efectivo_contado) }}) es idéntica a la de Esperado, así que «{{ cuadreLabel(c) }}» compara una cifra contra sí misma. Pasa en el <b>81.2%</b> de los cortes. Lo único medido es la columna Contado.</p>
                  }
                  @if (cuadraPorBruto(c, a)) {
                    <p class="cs-hint cs-nota">El corte salió por lo esperado <b>sin restar</b> la devolución: Kepler no la descontó en este corte. Cuadra contra el esperado bruto ({{ money(a.esperado_total) }}).</p>
                  }
                } @else {
                  <p class="cs-hint">No se encontró el arqueo del turno {{ c.referencia }}. El cuadre queda <b>sin medir</b>; no es lo mismo que cuadrar.</p>
                }
              </div>

              <div class="cs-step">
                <h3><span class="cs-n">2</span> Cobros aplicados en Kepler</h3>
                @for (b of c.cobros; track b.doc_prefix + b.folio) {
                  <div class="cs-row"><span>{{ b.doc_prefix }}-{{ b.folio }} · {{ b.forma_pago || 'sin forma' }}@if (b.fecha) { · {{ dmy(b.fecha) }} }@if (b.concepto) { <span class="muted"> · {{ b.concepto }}</span> }
                    <span class="cs-dep" [class.muted]="b.medio_cobro !== 'banco'"><i class="pi {{ depositoIcon(b) }}" aria-hidden="true"></i>{{ depositoLabel(b) }}</span></span><span class="num">{{ money(b.monto) }}</span></div>
                } @empty {
                  <p class="cs-hint">Ningún cobro aplicado a este corte.</p>
                }
                <div class="cs-row cs-tot"><span>Saldo del corte</span><span class="num" [class.cs-bad]="c.saldo > 0.005">{{ money(c.saldo) }}</span></div>
                <!-- [CSU.13] Cancelados en Kepler: se VEN, marcados, y no entran a la cuenta de arriba. -->
                @if (c.cobros_cancelados.length) {
                  <div class="cs-cancelados" role="group" aria-label="Cobros cancelados en Kepler, no suman">
                    @for (x of c.cobros_cancelados; track x.doc_prefix + x.folio) {
                      <div class="cs-row cs-cancelado"><span>{{ x.doc_prefix }}-{{ x.folio }}@if (x.fecha) { · {{ dmy(x.fecha) }} }@if (x.concepto) { <span class="muted"> · {{ x.concepto }}</span> }
                        <p-tag value="Cancelado en Kepler — no suma" severity="secondary" styleClass="cs-tag" /></span><span class="num cs-tachado">{{ money(x.monto) }}</span></div>
                    }
                  </div>
                }
              </div>

              <div class="cs-step">
                <h3><span class="cs-n">3</span> Llegó a la empresa</h3>
                <p class="cs-hint">Entrega 2: aquí se verá el abono en el estado de cuenta (tarjeta y transferencia) y el paso del efectivo por Caja Fuerte y Caja General hasta su depósito. Hoy <b>no se mide</b>.</p>
              </div>
            } @else {
              <div class="cs-empty cs-pad"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Elige un corte para ver su arqueo y sus cobros.</span></div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cs-actions { display:flex; gap:.5rem; align-items:center; }
    .cs-filters { display:flex; flex-wrap:wrap; gap:.8rem; align-items:flex-end; margin:.4rem 0 .6rem; }
    .cs-field { display:flex; flex-direction:column; gap:.25rem; }
    .cs-field label { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); }
    /* [CSU.13] El buscador es el primer filtro y el más ancho: es por donde se entra a un corte. */
    .cs-buscar { flex:1 1 20rem; max-width:28rem; }
    .cs-buscar p-iconfield, .cs-q { width:100%; }
    /* [CSU.13] Cobro cancelado: se lee como «ya no cuenta» por el texto de la etiqueta y por el tachado,
       nunca sólo por el color (Alto Contraste de Windows). */
    .cs-cancelados { margin-top:var(--sp-2); padding-top:var(--sp-2); border-top:1px dashed var(--border-color); }
    .cs-cancelado { color:var(--text-muted); }
    .cs-tachado { text-decoration:line-through; }
    .cs-kbd { font:inherit; font-family:var(--font-mono); font-size:var(--fs-micro); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 var(--sp-1); margin-left:var(--sp-1); color:var(--text-muted); }
    :host ::ng-deep .cs-sel { min-width:11rem; }
    .cs-toggle { align-items:flex-start; }
    .cs-periodo { margin:.2rem 0 .4rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .cs-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .cs-note .pi { color:var(--text-muted); margin-top:.15rem; }
    .cs-note-bad { border-left:3px solid var(--bad-fg); }
    .cs-note-bad .pi { color:var(--bad-fg); }
    app-metric-strip { display:block; margin:.6rem 0; }
    .cs-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; margin-bottom:1rem; }
    .cs-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .cs-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .cs-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .cs-pad { padding:.5rem .85rem 0; }
    .cs-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .cs-split { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:1rem; align-items:start; }
    @media (max-width:68.75rem) { .cs-split { grid-template-columns:minmax(0,1fr); } }
    .cs-detail { position:sticky; top:.5rem; }
    .cs-step { padding:.7rem .85rem; border-top:1px solid var(--border-color); }
    .cs-step:first-of-type { border-top:0; }
    .cs-step h3 { display:flex; align-items:center; gap:.45rem; font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .cs-n { display:inline-grid; place-items:center; width:1.3rem; height:1.3rem; border-radius:50%; background:var(--hover-bg); font-size:var(--fs-micro); }
    .cs-row { display:flex; justify-content:space-between; gap:.8rem; font-size:var(--fs-sm); padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .cs-row span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    /* [CSU.8] La cuenta del deposito, en su propio renglon: es el dato que cierra el recorrido
       del dinero y enterrado en la linea del folio no se encuentra. */
    .cs-dep { display:flex; align-items:center; gap:.3rem; font-size:var(--fs-xs); margin-top:.1rem; }
    .cs-dep i { font-size:var(--fs-nano); }
    .cs-tot { font-weight:600; border-bottom:0; }
    .cs-mini { width:100%; border-collapse:collapse; font-size:var(--fs-sm); margin-bottom:.4rem; }
    .cs-mini th { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; padding:.2rem 0; text-align:left; }
    .cs-mini td { padding:.2rem 0; border-bottom:1px dashed var(--border-color); }
    .cs-mini tr.cs-tot td { border-bottom:0; }
    .cs-sub { margin:.5rem 0 .15rem; font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; }
    .cs-dev span:first-child { white-space:normal; }
    .cs-motivo { font-size:var(--fs-xs); }
    .cs-nota { margin-top:.35rem; }
    /* [CSU.9] El conteo por denominacion: el unico efectivo que alguien conto de verdad. */
    .cs-fis { font-weight:600; }
    /* [CSU.15] La fila de día: el renglón que antes se sumaba a mano. El grupo se forma con
       espaciado y con el peso del total, no con cajas ni con zebra. */
    .cs-togcol { width:2.25rem; }
    .cs-tog { display:inline-grid; place-items:center; width:1.75rem; height:1.75rem; padding:0; border:0; border-radius:var(--r-sm); background:none; color:var(--text-muted); cursor:pointer; }
    .cs-tog:hover:not(:disabled) { background:var(--overlay-hover); color:var(--text-main); }
    .cs-tog:disabled { cursor:default; opacity:.45; }
    .cs-tog .pi { font-size:var(--fs-xs); }
    .cs-dia-abierta > td { font-weight:600; }
    /* El detalle cuelga del día: sin borde propio, sangrado y con un filete a la izquierda que
       dice de quién es. El borde de 1px es lo que lleva la profundidad en dark. */
    .cs-dia-det > td { padding:0 0 var(--sp-2) 2.25rem; background:var(--hover-bg); }
    .cs-cortes { width:100%; border-collapse:collapse; font-size:var(--fs-sm); border-left:2px solid var(--border-color); }
    .cs-cortes th { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; text-align:left; padding:var(--sp-2) var(--sp-2) var(--sp-1); }
    .cs-cortes th.ta-r { text-align:right; }
    .cs-cortes td { padding:var(--sp-1) var(--sp-2); border-top:1px solid var(--border-color); }
    .cs-corte { cursor:pointer; }
    .cs-corte:hover { background:var(--overlay-hover); }
    .cs-corte:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .cs-corte-sel { background:var(--overlay-selected); }
    .ta-r { text-align:right !important; }
    .num, .cs-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cs-strong { font-weight:600; }
    .cs-bad { color:var(--bad-fg); }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .cs-tag { font-size:var(--fs-nano); margin-right:.25rem; }
    .cs-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cs-errbox .pi { color:var(--bad-fg); } .cs-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .cs-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .cs-empty .pi { font-size:var(--fs-lg); }
  `],
})
export class FinanzasCortesSucursalesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/cortes-sucursales`;

  readonly skel = Array.from({ length: 8 });
  readonly money = money;
  readonly dmy = dmy;

  /** Los 12 meses hasta el actual; el default es el mes en curso. */
  readonly mesOpts: { label: string; value: string }[] = (() => {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ label: `${MESES[x.getMonth()]} ${x.getFullYear()}`, value: `${x.getFullYear()}-${pad(x.getMonth() + 1)}` });
    }
    return out;
  })();

  readonly mes = signal<string | null>(this.mesOpts[0].value);
  rangeDates: Date[] | null = null;
  readonly soloSaldo = signal(false);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<CortesSucursalesResponse | null>(null);
  readonly selSuc = signal<CorteSucursalResumen | null>(null);

  /** `[CSU.14]` La tabla «Por sucursal»: todas, o sólo la elegida (las demás se ocultan para dar espacio). */
  readonly sucursalesVisibles = computed<CorteSucursalResumen[]>(() => {
    const d = this.data();
    const s = this.selSuc();
    if (!d) return [];
    return s ? d.sucursales.filter((x) => x.sucursal === s.sucursal) : d.sucursales;
  });
  readonly sucursalesOcultas = computed<number>(() => (this.data()?.sucursales.length ?? 0) - this.sucursalesVisibles().length);
  readonly selCorte = signal<CorteRow | null>(null);

  /** `[CSU.13]` Lo que escribió la persona en el buscador. */
  readonly q = signal('');
  private readonly buscador = viewChild<ElementRef<HTMLInputElement>>('buscador');

  /** Los cortes antes de buscar: sucursal elegida + «sólo con saldo». */
  readonly cortesBase = computed<CorteRow[]>(() => {
    const d = this.data();
    const s = this.selSuc();
    const soloSaldo = this.soloSaldo();
    if (!d) return [];
    return d.cortes.filter((c) => (!s || c.sucursal === s.sucursal) && (!soloSaldo || c.saldo > 0.005));
  });

  /**
   * `[CSU.13]` La lista que se ve. Se filtra en el cliente porque llega COMPLETA (el periodo entero, sin
   * paginar en el servidor): `filtrarPorBusqueda` exige cada palabra, en cualquier orden y en cualquier
   * campo, sin acentos — la misma semántica que `applySmartSearch` del servidor.
   */
  readonly cortes = computed<CorteRow[]>(() => filtrarPorBusqueda(this.cortesBase(), consultaDeCortes(this.q()), (c) => this.camposBuscables(c)));

  /**
   * `[CSU.15]` La lista principal: **un renglón por día de sucursal**, con el total que antes se
   * sumaba a mano. Se deriva de `cortes()` —la lista ya filtrada— para que el total del renglón
   * sea exactamente la suma de lo que se despliega debajo.
   */
  readonly diasDeCortes = computed<DiaDeCortes[]>(() => agruparCortesPorDia(this.cortes()));

  /** Qué días abrió la persona. La llave es `<fecha>|<sucursal>`. */
  private readonly abiertosManual = signal<Record<string, boolean>>({});

  /**
   * Lo que de verdad se ve abierto.
   *
   * ⛔ Con una búsqueda activa se abren **todos**: plegar lo que alguien acaba de buscar lo
   * obligaría a un clic por día para encontrar el folio que ya escribió, y esconder lo vital
   * detrás de un acordeón es justo lo que la ley de Tesler prohíbe. Igual cuando hay un solo día:
   * no hay nada que elegir.
   */
  readonly diasAbiertos = computed<Record<string, boolean>>(() => {
    const dias = this.diasDeCortes();
    if (this.q().trim() || dias.length === 1) return Object.fromEntries(dias.map((d) => [d.clave, true]));
    return this.abiertosManual();
  });

  /** ¿La persona puede plegar/desplegar, o están abiertos por la búsqueda? */
  readonly plegadoBloqueado = computed<boolean>(() => !!this.q().trim() || this.diasDeCortes().length === 1);

  /** Para que el botón diga lo que va a hacer, no un rótulo fijo. */
  readonly algunDiaAbierto = computed<boolean>(() => Object.keys(this.abiertosManual()).length > 0);

  toggleDia(d: DiaDeCortes): void {
    if (this.plegadoBloqueado()) return;
    this.abiertosManual.update((e) => {
      const n = { ...e };
      if (n[d.clave]) delete n[d.clave]; else n[d.clave] = true;
      return n;
    });
  }

  todosLosDias(abrir: boolean): void {
    this.abiertosManual.set(abrir ? Object.fromEntries(this.diasDeCortes().map((d) => [d.clave, true])) : {});
  }

  /** Con una sucursal elegida y la búsqueda sin resultados ahí: cuántos casan en las demás. */
  readonly enOtrasSucursales = computed<number>(() => {
    const d = this.data();
    const s = this.selSuc();
    const q = this.q();
    const soloSaldo = this.soloSaldo();
    if (!d || !s || !q.trim()) return 0;
    const otras = d.cortes.filter((c) => c.sucursal !== s.sucursal && (!soloSaldo || c.saldo > 0.005));
    return filtrarPorBusqueda(otras, consultaDeCortes(q), (c) => this.camposBuscables(c)).length;
  });

  camposBuscables(c: CorteRow): (string | number | null | undefined)[] { return camposBuscablesDeCorte(c); }

  limpiarBusqueda(): void {
    this.q.set('');
    this.buscador()?.nativeElement.focus();
  }

  /** `/` lleva al buscador desde cualquier parte de la pantalla (si no se está escribiendo en otro campo). */
  @HostListener('document:keydown', ['$event'])
  atajoBuscar(e: KeyboardEvent): void {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    e.preventDefault();
    this.buscador()?.nativeElement.focus();
  }
  readonly kpiItems = computed<MetricStripItem[]>(() => { const d = this.data(); return d ? this.kpis(d) : []; });
  readonly pendienteVisible = computed(() => this.cortes().reduce((t, c) => t + Math.max(c.saldo, 0), 0));

  ngOnInit(): void { this.reload(); }

  pickMes(v: string | null): void {
    if (!v) return;
    this.mes.set(v);
    this.rangeDates = null;
    this.reload();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: no se consulta todavía
    this.mes.set(null);
    this.reload();
  }

  pickSuc(s: CorteSucursalResumen | null): void {
    this.selSuc.set(s);
    const c = this.selCorte();
    if (s && c && c.sucursal !== s.sucursal) this.selCorte.set(null);
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    const p = new URLSearchParams();
    const [a, b] = this.rangeDates || [];
    if (!this.mes() && a && b) { p.set('from', iso(a)); p.set('to', iso(b)); }
    else if (this.mes()) p.set('month', this.mes() as string);
    this.http.get<CortesSucursalesResponse>(`${this.base}?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        const s = this.selSuc();
        this.selSuc.set(s ? d.sucursales.find((x) => x.sucursal === s.sucursal) ?? null : null);
        // Quien sólo ve UNA sucursal (encargado/auxiliar) la tiene seleccionada de entrada.
        if (!this.selSuc() && !d.alcance.todas && d.sucursales.length === 1) this.selSuc.set(d.sucursales[0]);
        const c = this.selCorte();
        this.selCorte.set(c ? d.cortes.find((x) => x.clave === c.clave) ?? null : null);
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los cortes.'); },
    });
  }

  kpis(d: CortesSucursalesResponse): MetricStripItem[] {
    const t = d.totales;
    return [
      { label: 'Vendido en cortes', value: t.vendido, format: 'currency2', tone: 'default', sub: `${t.cortes} cortes · ${d.sucursales.length} sucursales` },
      { label: 'Cobrado en Kepler', value: t.cobrado, format: 'currency2', tone: 'ok', sub: `${this.pct(t.cobrado, t.vendido)} de lo vendido` },
      { label: 'Pendiente de cobro', value: t.pendiente, format: 'currency2', tone: t.pendiente > 0.005 ? 'bad' : 'ok', sub: `${t.sin_cobro} cortes sin ningún cobro` },
      { label: 'Corte vs arqueo', value: t.con_diferencia, format: 'number', tone: t.con_diferencia ? 'warn' : 'ok', sub: t.sin_arqueo ? `con diferencia · ${t.sin_arqueo} sin arqueo` : 'con diferencia' },
    ];
  }

  /** El periodo empieza antes de que existieran los cortes POS en Kepler. */
  antesDeCortes(d: CortesSucursalesResponse): boolean { return d.periodo.from < INICIO_CORTES; }
  sucursalesTexto(d: CortesSucursalesResponse): string { return d.alcance.sucursales.map((x) => x.codigo + ' ' + x.nombre).join(', '); }
  pct(a: number, b: number): string { return b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—'; }
  dias(desde: string): number {
    const hoy = new Date();
    const [y, m, d] = desde.split('-').map(Number);
    return Math.max(0, Math.floor((Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - Date.UTC(y, m - 1, d)) / 86400000));
  }
  cobroLabel(e: CorteEstadoCobro): string { return COBRO[e].label; }
  cobroSev(e: CorteEstadoCobro): Sev { return COBRO[e].sev; }
  cuadreSev(q: CorteCuadre): Sev { return CUADRE[q].sev; }
  /** `[CSU.7]` Hubo devolución pero el corte coincide con el esperado BRUTO, no con el neto. */
  cuadraPorBruto(c: CorteRow, a: CorteArqueo): boolean {
    return c.cuadre === 'cuadra' && c.devoluciones_total > 0 && Math.abs(c.monto - a.esperado_neto) >= 1;
  }
  cuadreLabel(c: CorteRow): string { return etiquetaCuadre(c); }

  /**
   * `[CSU.8]` A qué cuenta entró el cobro.
   *
   * ⛔ **No se dibuja un banco que no se sabe.** Las dos ausencias se declaran con palabras
   * distintas porque las arregla gente distinta (ADR-056): `sin_declarar` lo arregla quien captura
   * en Kepler, `no_resuelve` lo arregla el catálogo de cuentas.
   *
   * ⭐ `caja` **no es un hueco, es la respuesta**: 3,599 cobros por $75M entraron en efectivo a
   * `CAJA GENERAL`. Se pinta apagado para que no se lea como banco, pero se pinta.
   */
  depositoLabel(b: CorteCobro): string {
    if (b.cuenta_tesoreria) return b.cuenta_tesoreria;
    if (b.medio_cobro === 'sin_declarar') return 'sin cuenta en Kepler';
    if (b.medio_cobro === 'no_resuelve') return 'cuenta fuera del catálogo';
    return 'cuenta no medida';
  }
  depositoIcon(b: CorteCobro): string {
    if (b.medio_cobro === 'banco') return 'pi-building';
    if (b.medio_cobro === 'caja') return 'pi-wallet';
    return 'pi-info-circle';
  }
  /** `[CSU.9]` Para pintar en rojo una diferencia de denominación en cualquiera de los dos sentidos. */
  abs(n: number): number { return Math.abs(n); }
}
