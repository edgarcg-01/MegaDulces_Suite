import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { Balances, CoberturaCategoria, CoberturaPorArea, CoberturaPorDireccion, Diagnostico } from '../../bank.service';
import { motivoPorLigar } from './bancos-shared';
import { exportXlsx } from '../../../../shared/export/xlsx-export';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { BANCOS_STYLES } from './bancos.styles';

/** Una sucursal de la venta de tienda (la sucursal del corte, con su nombre). */
type Sucursal = { sucursal: string; nombre?: string; n: number; monto: number };
/**
 * Un renglón de las tablas: el encabezado de un grupo, un origen o área, o una sucursal de la venta de tienda.
 * `falta` = por qué falta explicar, sólo cuando el grupo no lo dice ya (en «sin documento» y «todavía de nadie» sí lo dice).
 */
export type RenglonDeDireccion =
  | { tipo: 'grupo'; clave: string; nombre: string; n: number; monto: number }
  | { tipo: 'fila'; clave: string; g: CoberturaPorArea; sub: string; falta: string; desplegable: boolean }
  | { tipo: 'suc'; clave: string; g: CoberturaPorArea; s: Sucursal };

/** `[BFU.4.5.14]` El total de una dirección SIN lo que se movió entre tus cuentas, y ese grupo aparte. */
export type TotalDeFuera = { n: number; monto: number; por_ligar: number | null; entre: CoberturaPorArea | null };

/** El grupo de lo que se movió entre tus cuentas, en las dos direcciones (lo decide el servidor). */
const ENTRE = 'traspaso';
/** El orden de lectura de lo que entró con documento: lo que es ingreso primero. */
const ORDEN_CON_DOC = ['venta_tienda', 'cobranza', 'devolucion', 'otro_documento'];
/** Las salidas que todavía no son de nadie (estados, no áreas), en este orden. */
const DE_NADIE = ['en_plazo', 'por_asignar', 'quien_captura', 'sin_motivo'];

/** La línea bajo cada origen: de qué documento sale, o qué dice el banco cuando no hay documento. */
const QUE_ES: Readonly<Record<string, string>> = {
  cobranza: 'cobro de una factura a un cliente',
  devolucion: 'el banco regresó un SPEI que enviaste',
  otro_documento: 'casado con otro documento de Kepler',
  'sin_documento:prestamo': '«depósito de préstamo»: no es venta',
  'sin_documento:efectivo': 'venta o cobranza sin su cobro en Kepler',
  'sin_documento:terminal': '«terminales punto de venta»: falta su corte',
  'sin_documento:transferencia': 'SPEI o transferencia sin documento',
  'sin_documento:devolucion': 'el banco dice «devolución»: falta saber de qué',
  'sin_documento:otro': 'el banco no dice qué es',
  en_plazo: 'Kepler todavía puede capturarlo',
  por_asignar: 'Kepler no lo tiene · lo asigna Tesorería',
  quien_captura: 'va a quien captura los depósitos de la cuenta',
  sin_motivo: 'el motor no lo decidió',
};

/**
 * [BFU.4.5.13] Bancos › Ingresos y egresos: de dónde viene y a dónde va cada peso de la descarga del banco.
 *
 * Nace de partir Cuentas en dos (Edgar, 2026-11-25: «para no hacer tanto scroll, separar ingresos y egresos de las
 * cuentas de banco»). Aquí se contesta UNA pregunta: «¿qué dinero del banco de este mes falta explicar?»; ingresos y
 * egresos son su desglose, lado a lado.
 *
 * [BFU.4.5.14] Lo que la captura de la pantalla viva encontró (Edgar, 2026-11-25): el subtotal del grupo caía bajo «Falta
 * explicar»; «Total ingresos» sumaba lo que la misma pantalla decía que no es ingreso (y en Egresos ese dinero se
 * escondía dentro de un área); «falta explicar» era pesos arriba y movimientos abajo; el rojo caía sobre lo que cierra.
 * Ahora lo que va entre tus cuentas es un renglón propio en LAS DOS tablas, debajo de su total y fuera de él.
 *
 * [BFU.4.5.15] «Un poco de color» (2026-11-25), con significado y nunca solo: verde = explicado (palomita), ámbar = falta
 * explicar a tiempo (su número), rojo = tarde (la palabra). Cada tabla abre con una barra de esos tres estados.
 *
 * Primario = lo que falta explicar (la cifra de --fs-display, la única) y su botón, el único de acción · secundario =
 * ingresos, egresos y saldos (tira sin animación) y las dos tablas · terciario = qué dice el banco, por qué falta y
 * cuántos van tarde. Cada renglón abre sus movimientos con la MISMA regla del servidor que su cifra (grupoDeLaFila).
 */
@Component({
  selector: 'bancos-ingresos',
  standalone: true,
  imports: [CommonModule, RouterLink, ButtonModule, TableModule, MetricStripComponent, LoadStateComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card-premium card-flat fb-ie" aria-labelledby="fb-ie-t">
      <div class="fb-ie-head">
        <h3 id="fb-ie-t" class="fb-ie-t">Ingresos y egresos <span class="fb-ie-t-sub">· de dónde viene y a dónde va cada peso de la descarga del banco</span>
          <app-context-help topic="bancos_ingresos_egresos" /></h3>
        <button type="button" class="fb-btn" (click)="verTodos.emit()">Ver todos los movimientos</button>
        @if (sinClasificar(); as n) { <button type="button" class="fb-btn" (click)="verSinClasificar.emit()">{{ n | number }} sin clasificar</button> }
        <button type="button" class="fb-btn" [disabled]="exporting() || !cobertura()" (click)="exportXls()">Excel</button>
      </div>

      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!cargando() && !error() && !hayDirecciones()"
                      emptyTitle="Sin movimientos del banco para separar" [emptyHint]="vacio()" (retry)="reintentar.emit()">
        @if (cobertura(); as cob) {
          <div class="fb-ie-band">
            <div class="fb-ie-falta">
              <span class="fb-cap">Falta explicar</span>
              @if (cob.explicado; as e) {
                <span class="fb-ie-cifra">{{ millones(e.por_ligar.monto) }}</span>
                <span class="fb-ie-falta-sub"><span class="mono">{{ e.por_ligar.n | number }}</span> movimientos ·
                  <span class="fb-tarde"><span class="mono">{{ e.atrasados | number }}</span> con más de 5 días hábiles</span></span>
                @if (e.por_ligar.n > 0) {
                  <div><button pButton type="button" class="p-button-sm" (click)="abrirPorLigar()"><span class="p-button-label">Ver lo que falta explicar</span></button></div>
                }
              } @else {
                <span class="fb-ie-nm" role="status">No se pudo medir en este periodo: faltan los hechos de algún renglón.</span>
              }
            </div>
            <app-metric-strip class="fb-ie-tira" [items]="cifras()" density="compact" [instant]="true"
                              ariaLabel="Ingresos, egresos y saldos" (drill)="onDrill($event)" />
          </div>

          <div class="fb-ie-dos">
            @if (cob.entradas) {
              <section class="fb-ie-panel" aria-labelledby="fb-ie-ent">
                <div class="fb-ie-ph">
                  <i class="pi pi-arrow-down-left" aria-hidden="true"></i>
                  <h4 id="fb-ie-ent">Ingresos <span class="fb-ie-t-sub">· de dónde vino</span></h4>
                </div>
                @if (barraIngresos(); as b) {
                  <app-metric-strip class="fb-ie-comp" mode="composition" [items]="b.items" [instant]="true" [ariaLabel]="b.aria" />
                }
                <div class="fb-ie-caja" role="region" aria-labelledby="fb-ie-ent" tabindex="0">
                  <ng-container *ngTemplateOutlet="tabla; context: { $implicit: ingresos(), tot: totIngresos(), col: 'De dónde vino',
                    totLabel: 'Total ingresos', entreSub: 'vino de otra cuenta tuya: no es ingreso' }"></ng-container>
                </div>
              </section>
            }
            @if (cob.salidas) {
              <section class="fb-ie-panel" aria-labelledby="fb-ie-sal">
                <div class="fb-ie-ph">
                  <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
                  <h4 id="fb-ie-sal">Egresos <span class="fb-ie-t-sub">· quién lo explica</span></h4>
                </div>
                @if (barraEgresos(); as b) {
                  <app-metric-strip class="fb-ie-comp" mode="composition" [items]="b.items" [instant]="true" [ariaLabel]="b.aria" />
                }
                <div class="fb-ie-caja" role="region" aria-labelledby="fb-ie-sal" tabindex="0">
                  <ng-container *ngTemplateOutlet="tabla; context: { $implicit: egresos(), tot: totEgresos(), col: 'Quién lo explica',
                    totLabel: 'Total egresos', entreSub: 'fue a otra cuenta tuya: no es egreso' }"></ng-container>
                </div>
              </section>
            }
          </div>
        }
      </app-load-state>
    </section>

    <!-- La celda «Movs. por explicar» de un grupo: no medido, «todos», el número (ámbar; lo tarde, rojo) o la palomita
         verde de «explicado». [BFU.4.5.15] El color dice el estado y nunca va solo: lo acompaña la palabra o el icono. -->
    <ng-template #falta let-g>
      @if (g.por_ligar === null) { <span class="muted">no medido</span> }
      @else if (g.por_ligar.n > 0) {
        <button type="button" class="fb-ligar" (click)="$event.stopPropagation(); abrir(g, true)"
                [attr.aria-label]="'Ver los ' + g.por_ligar.n + ' movimientos por explicar de ' + (g.nombre || g.area)">
          @if (g.n > 1 && g.por_ligar.n === g.n) { <b class="fb-pend">todos</b> } @else { <b class="mono fb-pend">{{ g.por_ligar.n | number }}</b> }
          @if (g.atrasados) { <span class="fb-tarde">&nbsp;· <span class="mono">{{ g.atrasados | number }}</span> tarde</span> }</button>
      } @else { <i class="pi pi-check fb-ok" aria-hidden="true"></i><span class="sr-only">explicado</span> }
    </ng-template>

    <ng-template #tabla let-filas let-tot="tot" let-col="col" let-totLabel="totLabel" let-entreSub="entreSub">
      <p-table [value]="filas" dataKey="clave" size="small" class="surf-table surf-table--plain fb-ie-tbl">
        <ng-template #header>
          <tr>
            <th scope="col">{{ col }}</th>
            <th scope="col" class="ta-r fb-c-num">Pesos</th>
            <th scope="col" class="ta-r fb-c-num fb-opt">Movs.</th>
            <th scope="col" class="ta-r fb-c-num">Movs. por explicar</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          @switch (r.tipo) {
            @case ('grupo') {
              <tr class="fb-ie-grupo">
                <th scope="rowgroup">{{ r.nombre }}</th>
                <td class="ta-r mono fb-c-num">{{ r.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono fb-c-num fb-opt">{{ r.n | number }}</td>
                <td class="fb-c-num"></td>
              </tr>
            }
            @case ('fila') {
              <tr class="fb-row-click" tabindex="0" (click)="abrir(r.g, false)" (keydown.enter)="abrir(r.g, false)"
                  (keydown.space)="$event.preventDefault(); abrir(r.g, false)">
                <th scope="row" class="fb-ie-n">{{ r.g.nombre || r.g.area }}<span class="sr-only">, abre sus movimientos</span>
                  @if (r.sub || r.desplegable) {
                    <span class="fb-ie-sub">{{ r.sub }}
                      @if (r.desplegable) {
                        · <button type="button" class="fb-tog" (click)="$event.stopPropagation(); toggleVenta()" (keydown.enter)="$event.stopPropagation()"
                                (keydown.space)="$event.stopPropagation()" [attr.aria-expanded]="ventaAbierta()"
                                [attr.aria-label]="(ventaAbierta() ? 'Plegar las ' : 'Ver las ') + sucursales(r.g) + ' de la venta de tienda'">{{ sucursales(r.g) }}
                          <i class="pi" [class.pi-chevron-up]="ventaAbierta()" [class.pi-chevron-down]="!ventaAbierta()" aria-hidden="true"></i></button>
                      }
                    </span>
                  }
                  @if (r.falta) { <span class="fb-ie-sub">por explicar: {{ r.falta }}</span> }
                </th>
                <td class="ta-r mono fb-c-num">{{ r.g.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono fb-c-num fb-opt">{{ r.g.n | number }}</td>
                <td class="ta-r fb-c-num"><ng-container *ngTemplateOutlet="falta; context: { $implicit: r.g }"></ng-container></td>
              </tr>
            }
            @case ('suc') {
              <tr class="fb-row-click fb-ie-suc" tabindex="0" (click)="abrirSucursal(r.g, r.s)" (keydown.enter)="abrirSucursal(r.g, r.s)"
                  (keydown.space)="$event.preventDefault(); abrirSucursal(r.g, r.s)">
                <th scope="row">{{ r.s.nombre || r.s.sucursal }}<span class="sr-only">, abre sus depósitos</span>
                  <a class="fb-cortes" [routerLink]="['/finanzas/cortes-sucursales']" [queryParams]="{ month: period(), sucursal: r.s.sucursal }"
                     (click)="$event.stopPropagation()" (keydown.enter)="$event.stopPropagation()">cortes de caja</a></th>
                <td class="ta-r mono fb-c-num">{{ r.s.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono fb-c-num fb-opt">{{ r.s.n | number }}</td>
                <td class="fb-c-num"></td>
              </tr>
            }
          }
        </ng-template>
        <ng-template #footer>
          @if (tot) {
            <tr class="fb-ie-tot">
              <th scope="row">{{ totLabel }}</th>
              <td class="ta-r mono fb-c-num">{{ tot.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono fb-c-num fb-opt">{{ tot.n | number }}</td>
              <td class="ta-r mono fb-c-num">@if (tot.por_ligar === null) { <span class="muted">no medido</span> }
                @else if (tot.por_ligar > 0) { <span class="fb-pend">{{ tot.por_ligar | number }}</span> }
                @else { <i class="pi pi-check fb-ok" aria-hidden="true"></i><span class="sr-only">todo explicado</span> }</td>
            </tr>
            <!-- [BFU.4.5.14] Debajo del total y fuera de él: no es ingreso ni egreso. -->
            @if (tot.entre; as g) {
              <tr class="fb-row-click fb-ie-entre" tabindex="0" (click)="abrir(g, false)" (keydown.enter)="abrir(g, false)"
                  (keydown.space)="$event.preventDefault(); abrir(g, false)">
                <th scope="row" class="fb-ie-n">{{ g.nombre || 'Entre tus cuentas' }}<span class="sr-only">, abre sus movimientos</span>
                  <span class="fb-ie-sub">{{ entreSub }}</span></th>
                <td class="ta-r mono fb-c-num">{{ g.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono fb-c-num fb-opt">{{ g.n | number }}</td>
                <td class="ta-r fb-c-num"><ng-container *ngTemplateOutlet="falta; context: { $implicit: g }"></ng-container></td>
              </tr>
            }
          }
        </ng-template>
      </p-table>
    </ng-template>
  `,
  styles: [BANCOS_STYLES, `
    .fb-ie { padding: var(--sp-4) var(--sp-5) var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-4); margin-bottom: var(--sp-3);
      container: fb-ie / inline-size; }
    .fb-ie-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
    .fb-ie-t { flex: 1 1 18rem; margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--text-main); }
    .fb-ie-t-sub { font-weight: var(--fw-regular, 400); color: var(--text-muted); font-size: var(--fs-sm); }
    .fb-btn { display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main); font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium); cursor: pointer; }
    .fb-btn:hover:not(:disabled) { background: var(--hover-bg); }
    .fb-btn:disabled { opacity: .6; cursor: default; }
    .fb-btn:focus-visible, .fb-tog:focus-visible, .fb-ligar:focus-visible, .fb-cortes:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    .fb-ie-band { display: flex; flex-wrap: wrap; gap: var(--sp-4) var(--sp-8); align-items: center; }
    .fb-ie-falta { flex: 0 1 auto; display: flex; flex-direction: column; gap: var(--sp-1); }
    .fb-cap { font-size: var(--fs-micro); font-weight: var(--fw-medium); letter-spacing: .05em; text-transform: uppercase; color: var(--text-muted); }
    /* La cifra grande en la letra del texto con números tabulares: en la de ancho fijo, «$39.5 M» dejaba un hueco antes de la M. */
    .fb-ie-cifra { font-family: var(--font-body); font-variant-numeric: tabular-nums; font-size: var(--fs-display); font-weight: var(--fw-black); line-height: 1; letter-spacing: -.02em; color: var(--text-main); }
    .fb-ie-falta-sub { font-size: var(--fs-sm); color: var(--text-main); }
    .fb-ie-falta .p-button { margin-top: var(--sp-2); }
    .fb-ie-nm { font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-ie-tira { flex: 1 1 28rem; min-width: 0; border-left: 1px solid var(--border-color); padding-left: var(--sp-6); }
    /* [BFU.4.5.15] Tres estados, tres tonos, y ninguno solo: explicado (verde, con palomita), falta explicar a tiempo
       (ámbar, con su número) y tarde (rojo, con la palabra «tarde»). Los -soft-fg son los que pasan como texto. */
    .fb-ok { color: var(--ok-soft-fg); font-size: var(--fs-xs); }
    .fb-pend { color: var(--warn-soft-fg); font-weight: var(--fw-bold); }
    .fb-tarde { color: var(--bad-soft-fg); font-weight: var(--fw-bold); }
    .fb-ie-comp { display: block; padding: 0 var(--sp-4) var(--sp-3); }

    .fb-ie-dos { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 34rem), 1fr)); gap: var(--sp-4); align-items: start; }
    .fb-ie-panel { min-width: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); container-type: inline-size; }
    .fb-ie-ph { display: flex; align-items: baseline; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4) var(--sp-2); }
    .fb-ie-ph .pi { font-size: var(--fs-xs); color: var(--text-muted); align-self: center; }
    .fb-ie-ph h4 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); }
    .fb-ie-caja { overflow-x: auto; }
    .fb-ie-caja:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    /* Todo renglón se lee en una línea: el número a la altura del nombre, no flotando entre el nombre y su explicación. */
    .fb-ie-caja th, .fb-ie-caja td { vertical-align: baseline; }
    /* Los encabezados, en la letra del texto: el número va en la celda, no en el rótulo. */
    .fb-ie-caja th[scope="col"] { font-family: var(--font-body); }
    /* El nombre del renglón es <th>: PrimeNG sólo le da relleno y divisor a las <td>, y la línea se cortaba en el nombre. */
    .fb-ie-caja tr > th:not([scope="col"]) { padding: var(--p-datatable-body-cell-sm-padding, .375rem .5rem);
      border-style: solid; border-color: var(--border-color); border-width: 0 0 1px 0; }
    /* Las columnas de números se ciñen a su contenido; el nombre se queda con el resto. */
    .fb-c-num { width: 1%; white-space: nowrap; }
    .fb-ie-grupo > th, .fb-ie-grupo > td { background: var(--surface-ground); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-main); }
    .fb-ie-grupo > th, .fb-ie-tot > th, .fb-ie-entre > th { text-align: left; }
    .fb-ie-grupo > td { font-weight: var(--fw-medium); color: var(--text-muted); }
    .fb-ie-n { text-align: left; font-weight: var(--fw-medium); color: var(--text-main); }
    .fb-ie-sub { display: block; font-family: var(--font-body); font-size: var(--fs-xs); font-weight: var(--fw-regular, 400); color: var(--text-muted); }
    .fb-ie-suc > th, .fb-ie-suc > td { background: var(--surface-ground); }
    tr.fb-ie-suc > th { text-align: left; font-weight: var(--fw-regular, 400); padding-left: var(--sp-6); }
    .fb-ie-tot > th, .fb-ie-tot > td { font-weight: var(--fw-bold); }
    .fb-ie-entre > th, .fb-ie-entre > td { color: var(--text-muted); font-weight: var(--fw-regular, 400); }
    .muted { color: var(--text-muted); }
    tr.fb-row-click:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .fb-tog { display: inline-flex; align-items: center; gap: var(--sp-1); border: 0; border-radius: var(--r-sm); background: none; padding: 0 var(--sp-1);
      font: inherit; color: var(--text-main); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
    .fb-tog .pi { font-size: .7em; }
    .fb-tog:hover { background: var(--hover-bg); }
    .fb-ligar { display: inline-flex; align-items: baseline; font: inherit; font-family: var(--font-body); background: none; border: 0; cursor: pointer;
      padding: 2px var(--sp-1); border-radius: var(--r-sm); color: var(--text-main); white-space: nowrap; }
    .fb-ligar:hover { background: var(--hover-bg); }
    .fb-cortes { margin-left: var(--sp-2); font-size: var(--fs-xs); color: var(--text-main); text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
    @container (width < 30rem) { .fb-opt { display: none; } }
    /* Angosta, la tira baja debajo de la cifra: el filete de la izquierda ya no separa nada. */
    @container fb-ie (width < 52rem) { .fb-ie-tira { border-left: 0; padding-left: 0; } }
  `],
})
export class BancosIngresosComponent {
  readonly diagnostico = input.required<Diagnostico | null>();
  readonly balances = input<Balances | null>(null);
  readonly period = input<string>('');
  readonly cargando = input(false);
  readonly error = input<string | null>(null);

  /** El shell abre Movimientos con ese grupo (la misma forma que usaba Cuentas). `deFuera` = sin lo de entre tus cuentas. */
  @Output() openGrupo = new EventEmitter<{ direccion?: '' | 'entra' | 'sale'; area?: string; origen?: string; sucursal?: string; porLigar?: boolean; deFuera?: boolean }>();
  @Output() verTodos = new EventEmitter<void>();
  @Output() verSinClasificar = new EventEmitter<void>();
  /** La cifra de saldos lleva a la vista Cuentas. */
  @Output() irACuentas = new EventEmitter<void>();
  @Output() reintentar = new EventEmitter<void>();

  readonly cobertura = computed<CoberturaCategoria | null>(() => this.diagnostico()?.cobertura_categoria ?? null);
  readonly hayDirecciones = computed(() => !!(this.cobertura()?.entradas && this.cobertura()?.salidas));
  readonly sinClasificar = computed(() => this.diagnostico()?.sin_clasificar_n ?? 0);
  readonly vacio = computed(() => (this.cobertura()
    ? 'La API no separó lo que entró de lo que salió: algún renglón no trae la dirección del dinero.'
    : 'Todavía no hay descarga del banco para este periodo.'));

  /** La venta de tienda nace plegada (dice cuántas sucursales tiene): así cada tabla cabe sin desplazarse. */
  readonly ventaAbierta = signal(false);
  toggleVenta(): void { this.ventaAbierta.update((v) => !v); }
  sucursales(g: CoberturaPorArea): string {
    const n = g.sucursales?.length ?? 0;
    return `${n} ${n === 1 ? 'sucursal' : 'sucursales'}`;
  }

  readonly ingresos = computed<RenglonDeDireccion[]>(() => renglonesDeIngresos(this.cobertura(), this.ventaAbierta()));
  readonly egresos = computed<RenglonDeDireccion[]>(() => renglonesDeEgresos(this.cobertura(), (c) => this.nombreDe(c)));
  readonly totIngresos = computed(() => totalDeFuera(this.cobertura()?.entradas ?? null));
  readonly totEgresos = computed(() => totalDeFuera(this.cobertura()?.salidas ?? null));
  /** [BFU.4.5.15] La barra de cada tabla: cuántos de sus movimientos (sin lo de entre tus cuentas) están en cada estado. */
  readonly barraIngresos = computed(() => barraDeEstado('Ingresos', this.cobertura()?.entradas ?? null, this.totIngresos()));
  readonly barraEgresos = computed(() => barraDeEstado('Egresos', this.cobertura()?.salidas ?? null, this.totEgresos()));

  readonly cifras = computed<MetricStripItem[]>(() => {
    const ti = this.totIngresos(), te = this.totEgresos();
    if (!ti || !te) return [];
    // [BFU.4.5.14] Los mismos números que el total de cada tabla (sin lo de entre tus cuentas), y abren esa misma lista.
    const items: MetricStripItem[] = [
      { label: 'Ingresos', value: millones(ti.monto), format: 'text', drill: 'entra', drillLabel: 'Ver los ingresos, sin lo de entre tus cuentas',
        sub: `${num(ti.n)} depósitos de fuera` },
      { label: 'Egresos', value: millones(te.monto), format: 'text', drill: 'sale', drillLabel: 'Ver los egresos, sin lo de entre tus cuentas',
        sub: `${num(te.n)} retiros a fuera` },
    ];
    const b = this.balances();
    if (b) {
      const con = b.accounts.filter((a) => !a.sin_saldo);
      const cierran = con.filter((a) => a.cuadra).length, no = con.length - cierran;
      // El rojo va sobre lo que no cierra, no sobre lo que sí.
      items.push(no
        ? { label: 'Saldos', value: `${no} no ${no === 1 ? 'cierra' : 'cierran'}`, format: 'text', tone: 'bad',
            sub: `${cierran} de ${con.length} cierran · ver en Cuentas`, drill: 'saldos', drillLabel: 'Ver los saldos en Cuentas' }
        : { label: 'Saldos', value: `${cierran} de ${con.length} cierran`, format: 'text',
            sub: 'ver en Cuentas', drill: 'saldos', drillLabel: 'Ver los saldos en Cuentas' });
    } else {
      items.push({ label: 'Saldos', value: '—', format: 'text', sub: 'sin leer todavía', drill: 'saldos', drillLabel: 'Ver los saldos en Cuentas' });
    }
    return items;
  });

  millones = millones;
  /** El nombre de un departamento por su código (el de la tabla de áreas), para «lo atiende …». */
  nombreDe(code: string): string {
    return this.cobertura()?.por_area.find((x) => x.area === code)?.nombre ?? (code === 'tesoreria' ? 'Tesorería' : code);
  }

  abrir(g: CoberturaPorArea, porLigar: boolean): void {
    const ent = this.cobertura()?.entradas?.grupos.includes(g);
    this.openGrupo.emit(ent ? { direccion: 'entra', origen: g.area, porLigar } : { direccion: 'sale', area: g.area, porLigar });
  }
  abrirSucursal(g: CoberturaPorArea, s: { sucursal: string }): void {
    this.openGrupo.emit({ direccion: 'entra', origen: g.area, sucursal: s.sucursal });
  }
  abrirPorLigar(): void { this.openGrupo.emit({ porLigar: true }); }
  onDrill(k: string): void {
    if (k === 'entra' || k === 'sale') this.openGrupo.emit({ direccion: k, deFuera: true });
    else if (k === 'saldos') this.irACuentas.emit();
  }

  readonly exporting = signal(false);
  async exportXls(): Promise<void> {
    const cob = this.cobertura();
    if (!cob) return;
    this.exporting.set(true);
    try {
      type Hoja = Record<string, unknown>;
      const fila = (g: CoberturaPorArea, nombre: string, que: string): Hoja => ({ ...g, nombre, que });
      const plano = (rs: RenglonDeDireccion[]): Hoja[] => rs.flatMap((r): Hoja[] => (r.tipo === 'fila'
        ? [fila(r.g, r.g.nombre || r.g.area, [r.sub, r.falta && `por explicar: ${r.falta}`].filter(Boolean).join(' · '))]
        : r.tipo === 'suc' ? [{ ...r.s, nombre: `   ${r.g.nombre || r.g.area} · ${r.s.nombre || r.s.sucursal}`, que: 'sucursal del corte', _suc: true }] : []));
      const cols = (primera: string) => [
        { header: primera, get: (r: any) => r.nombre, width: 34 },
        { header: 'Que es', get: (r: any) => r.que ?? '', width: 38 },
        { header: 'Movimientos', get: (r: any) => (r._suc ? null : r.n), type: 'int' as const, total: true },
        { header: 'Pesos', get: (r: any) => (r._suc ? null : r.monto), type: 'money' as const, total: true },
        { header: 'Movimientos de la sucursal', get: (r: any) => (r._suc ? r.n : null), type: 'int' as const },
        { header: 'Pesos de la sucursal', get: (r: any) => (r._suc ? r.monto : null), type: 'money' as const },
        { header: 'Pesos explicados', get: (r: any) => (r._suc ? null : r.explicado?.monto ?? null), type: 'money' as const, total: true },
        { header: 'Movimientos por explicar', get: (r: any) => (r._suc ? null : r.por_ligar?.n ?? null), type: 'int' as const, total: true },
        { header: 'Pesos por explicar', get: (r: any) => (r._suc ? null : r.por_ligar?.monto ?? null), type: 'money' as const, total: true },
        { header: 'Mas de 5 dias habiles', get: (r: any) => (r._suc ? null : r.atrasados), type: 'int' as const, total: true },
      ];
      // [BFU.4.5.14] Lo de entre tus cuentas va en su hoja: dentro de Ingresos o Egresos, su total lo sumaría.
      const entre = [[this.totIngresos()?.entre, 'Entro de otra cuenta tuya'], [this.totEgresos()?.entre, 'Salio a otra cuenta tuya']]
        .filter((x): x is [CoberturaPorArea, string] => !!x[0]).map(([g, que]) => fila(g, 'Entre tus cuentas', que));
      await exportXlsx('Ingresos y egresos ' + this.period(), [
        { name: 'Ingresos', subtitle: this.period(), rows: plano(renglonesDeIngresos(cob, true)), cols: cols('De donde vino') },
        { name: 'Egresos', subtitle: this.period(), rows: plano(this.egresos()), cols: cols('Quien lo explica') },
        ...(entre.length ? [{ name: 'Entre tus cuentas', subtitle: this.period(), rows: entre, cols: cols('Movimiento') }] : []),
      ]);
    } finally { this.exporting.set(false); }
  }
}

/** Por qué falta explicar un grupo (su motivo principal), si falta algo. */
function faltaDe(g: CoberturaPorArea): string {
  const m = g.por_ligar?.n ? g.motivos[0] : null;
  return m ? motivoPorLigar(m.motivo) + (g.motivos.length > 1 ? ' y otros' : '') : '';
}
const sumaGrupo = (gs: CoberturaPorArea[]) => ({ n: gs.reduce((t, g) => t + g.n, 0), monto: gs.reduce((t, g) => t + Number(g.monto || 0), 0) });

/**
 * [BFU.4.5.13] Los renglones de Ingresos: «con documento de Kepler» (lo que es ingreso primero) y «sin documento: lo que
 * dice el banco» (lo de más pesos primero). La venta de tienda se despliega por sucursal. [BFU.4.5.14] Lo de entre tus
 * cuentas NO va aquí: va debajo del total (`totalDeFuera`). Exportada para probarla sin montar la pantalla.
 */
export function renglonesDeIngresos(cob: CoberturaCategoria | null, ventaAbierta: boolean): RenglonDeDireccion[] {
  const e = cob?.entradas;
  if (!e) return [];
  const orden = (k: string) => { const i = ORDEN_CON_DOC.indexOf(k); return i < 0 ? ORDEN_CON_DOC.length : i; };
  const con = e.grupos.filter((g) => g.area !== ENTRE && !g.area.startsWith('sin_documento:')).sort((a, b) => orden(a.area) - orden(b.area) || b.monto - a.monto);
  const sin = e.grupos.filter((g) => g.area.startsWith('sin_documento:')).sort((a, b) => b.monto - a.monto);
  const out: RenglonDeDireccion[] = [];
  if (con.length) out.push({ tipo: 'grupo', clave: 'g:con', nombre: 'Con documento de Kepler', ...sumaGrupo(con) });
  for (const g of con) {
    const sucs = g.sucursales ?? [];
    const sub = g.area === 'venta_tienda' ? 'cobro de un corte de caja' : QUE_ES[g.area] ?? '';
    out.push({ tipo: 'fila', clave: g.area, g, sub, falta: faltaDe(g), desplegable: sucs.length > 0 });
    if (sucs.length && ventaAbierta) for (const s of sucs) out.push({ tipo: 'suc', clave: `${g.area}|${s.sucursal}`, g, s });
  }
  // Sin documento: el motivo es siempre «sin documento de Kepler», y ya lo dice el grupo.
  if (sin.length) out.push({ tipo: 'grupo', clave: 'g:sin', nombre: 'Sin documento · lo que dice el banco', ...sumaGrupo(sin) });
  for (const g of sin) out.push({ tipo: 'fila', clave: g.area, g, sub: QUE_ES[g.area] ?? '', falta: '', desplegable: false });
  return out;
}

/**
 * [BFU.4.5.13] Los renglones de Egresos: «de un área» (lo de más pesos primero) y «todavía de nadie» (estados, no áreas).
 * [BFU.4.5.14] Lo que fue a otra cuenta tuya tampoco va aquí: va debajo del total, como en Ingresos.
 */
export function renglonesDeEgresos(cob: CoberturaCategoria | null, nombreDe: (code: string) => string): RenglonDeDireccion[] {
  const s = cob?.salidas;
  if (!s) return [];
  const area = s.grupos.filter((g) => g.area !== ENTRE && !DE_NADIE.includes(g.area)).sort((a, b) => b.monto - a.monto || b.n - a.n);
  const nadie = s.grupos.filter((g) => DE_NADIE.includes(g.area)).sort((a, b) => DE_NADIE.indexOf(a.area) - DE_NADIE.indexOf(b.area));
  const out: RenglonDeDireccion[] = [];
  const sub = (g: CoberturaPorArea) => QUE_ES[g.area] ?? (g.atiende && g.atiende !== g.area ? `lo atiende ${nombreDe(g.atiende)}` : '');
  if (area.length) out.push({ tipo: 'grupo', clave: 'g:area', nombre: 'De un área', ...sumaGrupo(area) });
  for (const g of area) out.push({ tipo: 'fila', clave: g.area, g, sub: sub(g), falta: faltaDe(g), desplegable: false });
  // Todavía de nadie: su línea ya dice por qué falta («Kepler todavía no lo tiene»…).
  if (nadie.length) out.push({ tipo: 'grupo', clave: 'g:nadie', nombre: 'Todavía de nadie', ...sumaGrupo(nadie) });
  for (const g of nadie) out.push({ tipo: 'fila', clave: g.area, g, sub: sub(g), falta: '', desplegable: false });
  return out;
}

/**
 * [BFU.4.5.14] El total de una dirección sin lo que se movió entre tus cuentas, y ese grupo aparte. Se resta de la
 * dirección que manda el servidor (no se vuelve a sumar de los renglones), así total + entre tus cuentas = dirección.
 */
export function totalDeFuera(dir: CoberturaPorDireccion | null): TotalDeFuera | null {
  if (!dir) return null;
  const entre = dir.grupos.find((g) => g.area === ENTRE) ?? null;
  const porLigar = dir.por_ligar === null ? null : dir.por_ligar.n - (entre?.por_ligar?.n ?? 0);
  return { n: dir.n - (entre?.n ?? 0), monto: Math.round((Number(dir.monto) - Number(entre?.monto ?? 0)) * 100) / 100, por_ligar: porLigar, entre };
}

/**
 * [BFU.4.5.15] Los movimientos de una tabla (sin lo de entre tus cuentas) por estado: explicados (verde), por explicar a
 * tiempo (ámbar) y tarde (rojo). Las tres partes suman el total de la tabla. `null` si no se midió: la barra no se pinta
 * (un estado no medido no se dibuja como «todo explicado»). Exportada para probarla sin montar la pantalla.
 */
export function barraDeEstado(titulo: string, dir: CoberturaPorDireccion | null, tot: TotalDeFuera | null):
  { items: MetricStripItem[]; aria: string } | null {
  if (!dir || !tot || tot.por_ligar === null || dir.atrasados === null || !tot.n) return null;
  const tarde = dir.atrasados - (tot.entre?.atrasados ?? 0);
  const aTiempo = tot.por_ligar - tarde, explicados = tot.n - tot.por_ligar;
  const items: MetricStripItem[] = [
    { label: 'Explicados', value: explicados, format: 'number', tone: 'ok' },
    { label: 'Por explicar, a tiempo', value: aTiempo, format: 'number', tone: 'warn' },
    { label: 'Tarde', value: tarde, format: 'number', tone: 'bad' },
  ];
  return { items, aria: `${titulo}, ${num(tot.n)} movimientos: ${num(explicados)} explicados, ${num(aTiempo)} por explicar a tiempo y ${num(tarde)} tarde` };
}

const num = (v: number) => new Intl.NumberFormat('es-MX').format(Number(v || 0));

/** Pesos en millones para una cifra («$35.4 M»); debajo del millón, completo. */
function millones(v: number): string {
  const n = Number(v || 0);
  return Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)} M`
    : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
}
