import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import type { DialogPassThrough } from 'primeng/types/dialog';
import { TextareaModule } from 'primeng/textarea';
import {
  partirCaptura, RECHAZO_KEPLER_MSG, TOPE_COBERTURA_DIAS, warehouseName,
  type AlcanceRenglon, type AutoabastoManoEnviarResponse, type AutoabastoManoProducto, type AutoabastoManoRenglon,
  type DestinoCaptura, type GrupoCaptura, type RechazoKepler,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch } from '../../../shared/util/debounced-search.util';
import { moverEntreCampos, pasoPorTecla } from '../../../shared/util/captura-teclado.util';
import { AutoabastoService } from '../autoabasto.service';
import { qty } from '../porques.util';

/**
 * `[AB.PM.4]` **El pedido a mano** — `/almacen/autoabasto` → «Pedir a mano».
 *
 * Lo que la sucursal necesita y el sugerido no pidió, a la sucursal que ella elige (anexo PM del
 * 2026-11-26, maqueta aprobada por Francisco). Se abre EN LUGAR de la mesa, como el detalle de órdenes
 * de Edgar (`[AB.NI.5]`), sin rehacer su pantalla. La pregunta: **«¿qué le pido a mano a cada sucursal?»**.
 *
 * Jerarquía (DESIGN §Q.5): primario = cuántos renglones salen y a cuántas sucursales; secundario = lo
 * que llevas, por destino, con su alcance; terciario = existencias y lo que ya viene.
 *
 * ⛔ Nada se calcula aquí: el alcance, la propuesta, lo que Kepler rechazaría y el factor de cada unidad
 * los pone el servidor (`GET/PUT pedido/mano`). Lo único que se arma en la pantalla es la partición por
 * destino, con la MISMA función pura que usa el servidor al mandar (`partirCaptura`, ADR-056).
 */

/** El valor de «Compras» en los selectores de destino (R7: ruta por confirmar). */
const COMPRAS = '__compras__';
/** Tiempo sin cambios antes de guardar un renglón: deja terminar de mover con − / +. */
const ESPERA_GUARDADO_MS = 700;

/** Lo que la persona está cambiando en un renglón, mientras se guarda. */
interface Edicion {
  cantidad: number;
  unidad: string;
  destino: string;
  guardando: boolean;
  error: string | null;
}

/** Una fila de la tabla, aplanada con su grupo (banda por destino, como `rowGroupMode`). */
interface Fila {
  r: AutoabastoManoRenglon;
  grupo: string;
  banda: string;
  bandaSub: string;
}

@Component({
  selector: 'app-autoabasto-a-mano',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, InputTextModule, TooltipModule, DialogModule,
    TextareaModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .am { display: flex; flex-direction: column; gap: var(--sp-4); }
    .am-head { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-start; justify-content: space-between; }
    .am-back { background: none; border: 0; padding: 0; color: var(--action); font: inherit; font-size: var(--fs-sm);
               font-weight: 600; cursor: pointer; display: inline-flex; gap: var(--sp-1); align-items: center; min-height: 2rem; }
    .am-h { margin: 0; font-size: var(--fs-h2); font-weight: 700; letter-spacing: -0.01em; }
    .am-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); display: flex;
              flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .am-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .am-n { display: inline-block; min-width: 1.5rem; padding: 0 .375rem; margin-left: .25rem; border-radius: var(--r-pill);
            background: rgba(255, 255, 255, .25); font-variant-numeric: tabular-nums; }
    .am-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); }
    .am-sec { padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .am-sec-t { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
    .am-txt { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 72ch; }
    .am-quien { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .am-search { width: 100%; font-size: var(--fs-body); }
    .am-keys { font-size: var(--fs-xs); color: var(--text-faint); }
    .am-res { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border-color); }
    .am-ri { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); align-items: center;
             padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border-color); }
    .am-ri-on { background: var(--surface-selected-bg); box-shadow: inset 3px 0 0 var(--action); }
    .am-ri-main { flex: 1 1 22rem; min-width: 0; }
    .am-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); margin-right: var(--sp-2); }
    .am-name { font-weight: 600; font-size: var(--fs-sm); }
    .am-dato { font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .am-dato strong { color: var(--text-main); }
    .am-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: var(--sp-1); }
    .am-chip { display: inline-flex; align-items: center; gap: .25rem; padding: .0625rem .5rem; border-radius: var(--r-pill);
               font-size: var(--fs-xs); font-weight: 600; border: 1px solid var(--border-color); color: var(--text-muted); }
    .am-chip-info { background: var(--info-soft-bg); color: var(--info-soft-fg); border-color: var(--info-border); }
    .am-chip-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); border-color: var(--warn-border); }
    .am-kepler { display: flex; gap: .375rem; align-items: baseline; margin-top: var(--sp-1); font-size: var(--fs-xs);
                 font-weight: 600; color: var(--bad-fg); line-height: 1.4; }
    .am-c-prod { min-width: 16rem; }
    .am-band { font-weight: 700; font-size: var(--fs-sm); }
    .am-band-sub { font-weight: 500; color: var(--text-muted); }
    .am-al { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .am-al-hoy { color: var(--text-faint); }
    .am-al-top { color: var(--warn-soft-fg); }
    .am-nomide { font-size: var(--fs-xs); color: var(--text-faint); }
    .am-step { display: inline-flex; align-items: center; gap: .25rem; }
    .am-stepbtn { width: 2rem; height: 2rem; border: 1px solid var(--border-color); border-radius: var(--r-sm);
                  background: var(--card-bg); color: var(--text-main); cursor: pointer; font-size: var(--fs-body); }
    .am-qty { width: 4.5rem; height: 2rem; text-align: right; font-variant-numeric: tabular-nums; }
    .am-u { min-width: 6rem; }
    .am-dest { min-width: 11rem; }
    .am-x { background: none; border: 0; color: var(--text-faint); width: 2rem; height: 2rem; border-radius: var(--r-sm); cursor: pointer; }
    .am-x:hover { color: var(--bad-fg); background: var(--surface-hover-bg); }
    .am-save { display: block; font-size: var(--fs-xs); color: var(--text-faint); }
    .am-err { color: var(--bad-fg); }
    .am-note { display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-3);
               border-radius: var(--r-md); font-size: var(--fs-sm); border: 1px solid var(--border-color); }
    .am-note-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border-color: var(--ok-soft-bg); }
    .am-note-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); border-color: var(--warn-border); }
    .am-note ul { margin: var(--sp-1) 0 0; padding-left: 1.25rem; }
    .am-link { background: none; border: 0; padding: 0; color: var(--action); font: inherit; font-weight: 600; cursor: pointer; }
    .am-cols { display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start; }
    .am-main { flex: 999 1 40rem; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-4); }
    .am-side { flex: 1 1 20rem; min-width: 0; }
    .am-dest-l { display: flex; flex-direction: column; gap: var(--sp-1); padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .am-dest-h { display: flex; justify-content: space-between; gap: var(--sp-2); font-weight: 700; font-size: var(--fs-sm); }
    .am-num { font-variant-numeric: tabular-nums; }
    .am-ln { display: flex; gap: var(--sp-3); align-items: baseline; padding: var(--sp-1) 0; font-size: var(--fs-sm);
             border-bottom: 1px solid var(--border-color); }
    .am-ln > span:nth-child(2) { flex: 1; }
    /*
     * Con el dedo, todo lo que se toca llega a --tap-min (44 px). La prueba visual del 2026-11-26 midió en el
     * Fold 7 y en el celular los botones «sm» de PrimeNG en 28 px, los selectores en 35 y el buscador en 38.
     */
    @media (pointer: coarse) {
      .am-stepbtn, .am-qty, .am-x { min-width: var(--tap-min); min-height: var(--tap-min); }
      .am-back, button.p-button, .am-search { min-height: var(--tap-min); }
      p-select.am-dest, p-select.am-u { min-height: var(--tap-min); align-items: center; }
    }
  `],
  template: `
    <section class="am" aria-labelledby="am-h">
      <div class="am-head">
        <div>
          <button type="button" class="am-back" (click)="salir()" [disabled]="saliendo()">
            <i class="pi" [class.pi-chevron-left]="!saliendo()" [class.pi-spinner]="saliendo()" [class.pi-spin]="saliendo()" aria-hidden="true"></i>
            {{ saliendo() ? 'Guardando tus cambios…' : 'Volver a tu mesa' }}
          </button>
          <h2 id="am-h" class="am-h">Pedir a mano</h2>
          <p class="am-sub">
            <span>Lo que necesitas y el sugerido no pidió. Cada renglón sale a quien se lo pidas.</span>
            <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
          </p>
        </div>
        <div class="am-actions">
          <app-context-help topic="almacen-autoabasto-a-mano" />
          @if (puedeAjustar()) {
            <button pButton type="button" class="p-button-sm" (click)="confirmar.set(true)"
                    [disabled]="!sale().renglones || enviando() || sinGuardar() > 0"
                    [pTooltip]="porQueNoSale()" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span>
              <span class="p-button-label">{{ etiquetaPedir() }}</span>
              @if (sale().renglones) { <span class="am-n">{{ sale().renglones }}</span> }
            </button>
          }
        </div>
      </div>

      @if (!puedeAjustar()) {
        <p class="am-note am-note-warn" role="note">
          <i class="pi pi-lock" aria-hidden="true"></i>
          Puedes ver lo pedido a mano, pero no capturar ni mandar: te falta el permiso de pedir de Autoabasto.
        </p>
      }

      @if (sinGuardarAlSalir(); as n) {
        <p class="am-note am-note-warn" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ n === 1 ? 'Un cambio no se pudo guardar' : n + ' cambios no se pudieron guardar' }}: {{ n === 1 ? 'está marcado' : 'están marcados' }}
            abajo. Corrígelo o toca «Volver a tu mesa» otra vez para descartar{{ n === 1 ? 'lo' : 'los' }}.</span>
        </p>
      }

      @if (!vieneMedido()) {
        <p class="am-note am-note-warn" role="note">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          «Ya viene» no se pudo medir para tu sucursal: el alcance cuenta como si no viniera nada.
        </p>
      }

      @if (errorEnvio(); as ee) {
        <p class="am-note am-note-warn" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ ee }} <button type="button" class="am-link" (click)="errorEnvio.set(null)">cerrar</button></span>
        </p>
      }

      @if (resultado(); as res) {
        <!-- Verde sólo si TODO quedó en Kepler: un pedido guardado que no salió no es un pedido hecho (regla 11). -->
        <div class="am-note" [class.am-note-ok]="todoEnKepler(res)" [class.am-note-warn]="!todoEnKepler(res)" role="status">
          <i class="pi" [class.pi-check-circle]="todoEnKepler(res)" [class.pi-exclamation-triangle]="!todoEnKepler(res)" aria-hidden="true"></i>
          <div>
            @for (q of res.requisiciones; track q.id) {
              <div>
                <strong>{{ nombreDe(q.surte.clave) }}</strong> · {{ q.renglones }} {{ q.renglones === 1 ? 'renglón' : 'renglones' }} ·
                @if (q.kepler?.estado === 'entregada' || q.kepler?.estado === 'ya_estaba') {
                  quedó en su Kepler como pedido {{ folioKepler(q) }}, ya autorizado.
                } @else if (q.kepler?.estado === 'no_salio') {
                  se guardó ({{ q.folio }}) pero <strong>no salió a Kepler</strong>: {{ motivoKepler(q) }}
                } @else {
                  se guardó como {{ q.folio }}.
                }
              </div>
            }
            @if (res.pendientes.length) {
              <div>{{ res.pendientes.length }} {{ res.pendientes.length === 1 ? 'renglón se quedó' : 'renglones se quedaron' }} en tu pedido a mano:</div>
              <ul>
                @for (p of res.pendientes; track p.product_id) { <li>{{ nombreProducto(p.product_id) }} — {{ p.motivo }}</li> }
              </ul>
            }
            <button type="button" class="am-link" (click)="resultado.set(null)">cerrar</button>
          </div>
        </div>
      }

      <app-metric-strip [items]="kpis()" ariaLabel="Lo que llevas pedido a mano" />

      <div class="am-cols">
        <div class="am-main">

          @if (puedeAjustar()) {
            <section class="am-card am-sec" aria-labelledby="am-quien">
              <h3 id="am-quien" class="am-sec-t">¿A quién se lo pides?</h3>
              <div class="am-quien">
                <p-select [options]="destinoOpts()" optionLabel="label" optionValue="value" [ngModel]="origen()"
                          (ngModelChange)="elegirOrigen($event)" [filter]="destinoOpts().length > 8" class="am-dest"
                          placeholder="Elige la sucursal" ariaLabel="A quién se lo pides" />
                @if (origenesError()) {
                  <span class="am-err">No se pudo leer a quién se le puede pedir.
                    <button type="button" class="am-link" (click)="cargarOrigenes()">Reintentar</button></span>
                }
              </div>
              <p class="am-txt">Es a quién va lo que agregues; cada renglón se puede mover después. Las camionetas no aparecen.
                Lo que ninguna sucursal tiene va a Compras, que confirma a quién se le pide.</p>
            </section>

            <section class="am-card" aria-labelledby="am-busca">
              <div class="am-sec">
                <h3 id="am-busca" class="am-sec-t">Agrega productos</h3>
                <input #buscador pInputText type="search" class="am-search" enterkeyhint="search" autocomplete="off"
                       placeholder="Código, nombre o código de barras, en cualquier orden"
                       [ngModel]="term()" (ngModelChange)="teclearBusqueda($event)" (keydown)="teclaBusqueda($event)"
                       aria-label="Buscar producto por código, nombre o código de barras" aria-controls="am-res"
                       aria-keyshortcuts="ArrowUp ArrowDown Enter Escape" />
                <span class="am-keys">Enter agrega el marcado · ↑ ↓ eligen · Esc limpia. Sin escribir, salen los que más vende tu sucursal.</span>
              </div>
              <app-load-state [loading]="buscando()" [error]="errorBusqueda()" [isEmpty]="buscado() && !resultados().length"
                              [skeletonRows]="3" emptyTitle="Nada con eso" emptyHint="Prueba con otra palabra o con el código."
                              (retry)="buscar(term())">
                <ul id="am-res" class="am-res" role="listbox" aria-label="Productos encontrados">
                  @for (p of resultados(); track p.product_id; let i = $index) {
                    @let ya = enEstePedido(p.product_id);
                    <li class="am-ri" role="option" [attr.aria-selected]="i === activo()" [class.am-ri-on]="i === activo()">
                      <div class="am-ri-main">
                        <div><span class="am-sku">{{ p.sku }}</span><span class="am-name">{{ p.nombre }}</span></div>
                        <div class="am-dato">
                          @if (origenSel(); as o) {
                            {{ o.name }} tiene <strong>{{ cifra(p.existencia_origen, p.unidad_base) }}</strong> ·
                          }
                          tú tienes {{ cifra(p.existencia, p.unidad_base) }} ·
                          {{ textoAlcance(p.alcance) }}
                          @if (cajaDe(p); as c) { · {{ c }} }
                        </div>
                        <div class="am-chips">
                          @if (p.kepler) { <span class="am-kepler"><i class="pi pi-ban" aria-hidden="true"></i> {{ textoKepler(p.kepler) }}</span> }
                          @if (enSugerido()[p.product_id]; as s) {
                            <span class="am-chip am-chip-info">ya va en tu pedido sugerido · {{ qty(s.cantidad) }} {{ s.unidad }}</span>
                            <span class="am-dato">Si lo pides aquí, sale del sugerido para que no te llegue dos veces.</span>
                          }
                          @if (ya) { <span class="am-chip">ya está en este pedido · {{ qty(ya.cantidad) }} {{ ya.unidad }} a {{ nombreDestino(ya.destino) }}</span> }
                          @if (!p.unidades.length) { <span class="am-chip am-chip-warn">Kepler no trae su escalera de unidades: no se puede pedir</span> }
                          @if (p.viene) { <span class="am-chip">ya viene {{ cifra(p.viene, p.unidad_base) }}</span> }
                        </div>
                      </div>
                      @if (ya) {
                        <button pButton type="button" class="p-button-sm p-button-outlined" (click)="irARenglon(p.product_id)">Cambiar cantidad</button>
                      } @else {
                        <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="!!enSugerido()[p.product_id]"
                                (click)="agregar(p)" [disabled]="!p.unidades.length || !origen() || agregando()[p.product_id]">
                          {{ enSugerido()[p.product_id] ? 'Pedirlo aquí' : 'Agregar' }}
                          @if (cantidadAlAgregar(p); as ca) { · {{ qty(ca.cantidad) }} {{ ca.unidad }} }
                        </button>
                      }
                    </li>
                  }
                </ul>
              </app-load-state>
            </section>
          }

          <section class="am-card" aria-labelledby="am-llevas">
            <div class="am-sec">
              <h3 id="am-llevas" class="am-sec-t">Lo que llevas · {{ renglones().length }} {{ renglones().length === 1 ? 'renglón' : 'renglones' }}</h3>
              <p class="am-txt"><strong>Alcance</strong> = cuántos días te dura lo que tienes, más lo que ya viene, más lo que pides,
                al ritmo de venta de los últimos 30 días: la misma cuenta de Pedido de Compras. Tu sucursal pide para
                <strong>{{ objetivo() }} días</strong>; ningún renglón debería pasar de <strong>{{ tope }}</strong>. La existencia de
                la otra sucursal es un dato, no un candado.</p>
            </div>
            <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!!cargadoEn() && !renglones().length"
                            emptyTitle="Todavía no pides nada a mano" emptyHint="Busca arriba un producto y agrégalo." (retry)="cargar()">
              <!-- dt-scope: sin el contenedor la regla de apilado es INERTE (dense-table.css); la prueba visual
                   del 2026-11-26 lo encontró en el celular: la columna congelada tapaba la cantidad. -->
              <div class="dt-scope">
              <p-table [value]="filas()" dataKey="r.product_id" rowGroupMode="subheader" groupRowsBy="grupo" [scrollable]="true"
                       size="small" class="dt-stack surf-table surf-table--plain surf-table--frozen-first">
                <ng-template #header>
                  <tr>
                    <th class="am-c-prod">Producto</th>
                    <th class="comm-num">Tienes</th>
                    <th class="comm-num">Hay allá</th>
                    <th>Alcance <span class="am-band-sub">hoy → con lo que pides</span></th>
                    <th>Pides</th>
                    <th>Se lo pides a</th>
                    <th><span class="sr-only">Quitar</span></th>
                  </tr>
                </ng-template>
                <ng-template #groupheader let-f>
                  <tr>
                    <td colspan="7" role="cell"><span class="am-band">{{ f.banda }}</span><span class="am-band-sub">&nbsp;· {{ f.bandaSub }}</span></td>
                  </tr>
                </ng-template>
                <ng-template #body let-f>
                  @let r = f.r;
                  @let st = edicion()[r.product_id];
                  <tr [attr.id]="'am-r-' + r.product_id">
                    <!-- La identidad sube al tope y va SIN rótulo al apilarse (dense-table.css: sin data-label).
                         Un solo bloque adentro: la celda apilada es flex y repartiría código, nombre y aviso. -->
                    <td class="dt-id" role="cell">
                      <div>
                        <span class="am-sku">{{ r.sku }}</span><span class="am-name">{{ r.nombre ?? 'No está en el catálogo' }}</span>
                        @if (r.kepler) {
                          <span class="am-kepler"><i class="pi pi-ban" aria-hidden="true"></i> {{ textoKepler(r.kepler) }}. Se queda fuera del envío.</span>
                        }
                        @if (r.viene) { <div class="am-chips"><span class="am-chip am-chip-info">ya viene {{ cifra(r.viene, r.unidad_base) }}</span></div> }
                      </div>
                    </td>
                    <td class="comm-num dt-num" data-label="Tienes" role="cell" [attr.aria-label]="'Tienes ' + (r.existencia == null ? 'sin dato' : qty(r.existencia))">{{ r.existencia == null ? '—' : qty(r.existencia) }}</td>
                    <td class="comm-num dt-num" data-label="Hay allá" role="cell">{{ r.destino.tipo === 'compras' || r.existencia_origen == null ? '—' : qty(r.existencia_origen) }}</td>
                    <td class="am-al" data-label="Alcance" role="cell" [pTooltip]="cuentaAlcance(r)" tooltipPosition="top">
                      <div>
                      @if (r.alcance_con_pedido.estado === 'medible') {
                        <span class="am-al-hoy">{{ dias(r.alcance.hoy) }}</span><span aria-hidden="true">&nbsp;→&nbsp;</span><span class="sr-only">con lo que pides,</span><strong [class.am-al-top]="r.alcance_con_pedido.pasa_tope">{{ dias(r.alcance_con_pedido.con_pedido) }}</strong>
                        @if (r.alcance_con_pedido.pasa_tope) { <div><span class="am-chip am-chip-warn">pasa el tope de {{ tope }} días</span></div> }
                      } @else {
                        <span class="am-nomide">{{ textoNoMide(r.alcance_con_pedido) }}</span>
                      }
                      </div>
                    </td>
                    <td data-label="Pides" role="cell">
                      @if (puedeAjustar()) {
                        <span class="am-step">
                          <button type="button" class="am-stepbtn" tabindex="-1" (click)="mover(r, -1)" [disabled]="cantidadDe(r) <= 1"
                                  [attr.aria-label]="'Bajar ' + (r.nombre ?? r.sku)">−</button>
                          <input pInputText type="number" min="1" step="1" inputmode="numeric" class="am-qty" [value]="cantidadDe(r)"
                                 (focus)="seleccionar($event)" (keydown)="teclaCantidad($event, r)" (input)="teclear(r, $event)"
                                 aria-keyshortcuts="ArrowUp ArrowDown Enter ArrowLeft ArrowRight"
                                 [attr.aria-label]="'Cantidad de ' + (r.nombre ?? r.sku)" />
                          <button type="button" class="am-stepbtn" tabindex="-1" (click)="mover(r, 1)"
                                  [attr.aria-label]="'Subir ' + (r.nombre ?? r.sku)">+</button>
                          <p-select [options]="r.unidades" optionLabel="unidad" optionValue="unidad" [ngModel]="unidadDe(r)"
                                    (ngModelChange)="cambiar(r, { unidad: $event })" class="am-u" appendTo="body"
                                    [ariaLabel]="'Unidad de ' + (r.nombre ?? r.sku)" />
                        </span>
                      } @else {
                        <strong>{{ qty(r.cantidad) }}</strong> {{ r.unidad }}
                      }
                      @if (st?.guardando) { <span class="am-save">guardando…</span> }
                      @else if (st?.error) { <span class="am-save am-err">no se guardó: {{ st.error }}</span> }
                    </td>
                    <td data-label="Se lo pides a" role="cell">
                      @if (puedeAjustar()) {
                        <p-select [options]="destinoOpts()" optionLabel="label" optionValue="value" [ngModel]="destinoDe(r)"
                                  (ngModelChange)="cambiar(r, { destino: $event })" class="am-dest" appendTo="body"
                                  [filter]="destinoOpts().length > 8" [ariaLabel]="'A quién le pides ' + (r.nombre ?? r.sku)" />
                      } @else {
                        {{ nombreDestino(r.destino) }}
                      }
                    </td>
                    <td class="dt-actions" data-label="Quitar" role="cell">
                      @if (puedeAjustar()) {
                        <button type="button" class="am-x" (click)="quitar(r)" [attr.aria-label]="'Quitar ' + (r.nombre ?? r.sku)"
                                pTooltip="Quitar del pedido a mano" tooltipPosition="left">
                          <i class="pi pi-times" aria-hidden="true"></i>
                        </button>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              </div>
            </app-load-state>
            @if (puedeAjustar() && renglones().length) {
              <div class="am-sec">
                <label for="am-nota" class="am-name">Nota para quien surte <span class="am-band-sub">(opcional)</span></label>
                <textarea pTextarea id="am-nota" rows="2" maxlength="500" [ngModel]="nota()" (ngModelChange)="nota.set($event)"
                          placeholder="Ej.: es para el pedido de la escuela del viernes"></textarea>
              </div>
            }
          </section>
        </div>

        <aside class="am-card am-sec am-side" aria-labelledby="am-sale">
          <h3 id="am-sale" class="am-sec-t">Lo que sale</h3>
          @for (g of grupos(); track llaveGrupo(g.destino)) {
            <div class="am-dest-l">
              <div class="am-dest-h">
                <span>{{ nombreDestino(g.destino) }}</span>
                @if (g.enviable) {
                  <span class="am-num">{{ salenDe(g) }} de {{ g.renglones.length }}</span>
                } @else {
                  <span class="am-chip am-chip-warn">ruta por confirmar</span>
                }
              </div>
              <span class="am-txt">
                @if (g.enviable) {
                  Queda hecho en su almacén al mandarlo, ya autorizado. No pasa por Compras.
                  @if (g.renglones.length - salenDe(g); as n) { {{ n }} se {{ n === 1 ? 'queda' : 'quedan' }}: Kepler {{ n === 1 ? 'lo' : 'los' }} rechazaría. }
                } @else {
                  {{ g.renglones.length }} {{ g.renglones.length === 1 ? 'renglón' : 'renglones' }}. {{ g.motivo }}
                }
              </span>
            </div>
          } @empty {
            <span class="am-txt">Todavía nada.</span>
          }
          <span class="am-txt">En Kepler sale como <strong>pedido de sucursal, ya autorizado</strong>, y entra a Surtido → Checado →
            Embarque, igual que el que hoy tecleas allá. Lo sigues en «Lo que te va a llegar».</span>
          <span class="am-txt">Si te equivocas, por ahora se cancela en Kepler: la Suite todavía no cancela un pedido de sucursal.</span>
        </aside>
      </div>

      <p-dialog [visible]="confirmar()" (visibleChange)="$event || confirmar.set(false)" [modal]="true" [draggable]="false"
                [style]="{ width: '40rem' }" [header]="etiquetaPedir()" [pt]="ptDialogo">
        <p class="am-txt">Al confirmar, cada sucursal recibe su pedido en Kepler <strong>ya autorizado</strong> y lo ve en Surtir. No pasa por Compras.</p>
        @for (g of gruposQueSalen(); track g.code) {
          <div class="am-sec">
            <div class="am-dest-h"><span>{{ nombreDe(g.code) }}</span><span class="am-num">{{ g.renglones.length }} {{ g.renglones.length === 1 ? 'renglón' : 'renglones' }}</span></div>
            @for (r of g.renglones; track r.product_id) {
              <div class="am-ln"><span class="am-sku">{{ r.sku }}</span><span>{{ r.nombre }}</span><span class="am-num">{{ qty(r.cantidad) }} {{ r.unidad }}</span></div>
            }
          </div>
        }
        @if (pasanTope().length || seQuedan().length) {
          <div class="am-note am-note-warn">
            <div>
              @if (pasanTope().length) {
                <div><strong>{{ pasanTope().length }} {{ pasanTope().length === 1 ? 'renglón queda' : 'renglones quedan' }} por encima del tope de {{ tope }} días</strong>
                  ({{ listaSku(pasanTope()) }}). Puedes mandarlo así o bajarlo.</div>
              }
              @if (seQuedan().length) {
                <div><strong>{{ seQuedan().length }} no {{ seQuedan().length === 1 ? 'sale' : 'salen' }} con esto</strong> ({{ listaSku(seQuedan()) }}):
                  Compras por confirmar o Kepler los rechazaría. Se quedan en tu pedido a mano.</div>
              }
            </div>
          </div>
        }
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="confirmar.set(false)" [disabled]="enviando()">Volver</button>
          <button pButton type="button" (click)="enviar()" [disabled]="enviando()">
            <span class="p-button-icon p-button-icon-left pi" [class.pi-send]="!enviando()" [class.pi-spinner]="enviando()" [class.pi-spin]="enviando()" aria-hidden="true"></span>
            <span class="p-button-label">Sí, mandar {{ sale().renglones }} {{ sale().renglones === 1 ? 'renglón' : 'renglones' }}</span>
          </button>
        </ng-template>
      </p-dialog>
    </section>
  `,
})
export class AutoabastoAManoComponent implements OnInit {
  private readonly svc = inject(AutoabastoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** El almacén que pide (ya validado en la mesa: está en el alcance de la persona). */
  readonly almacen = input.required<{ id: string; code: string; name: string }>();
  /** La sucursal que el motor propone para este almacén (su matriz): el origen por default. */
  readonly matriz = input<string | null>(null);
  /** Lo que ya va en el sugerido de la mesa: producto → cantidad y unidad. Sale de lo que la mesa ya cargó. */
  readonly enSugerido = input<Readonly<Record<string, { cantidad: number; unidad: string | null }>>>({});
  /** `AUTOABASTO_SOLICITAR`: sin él se ve lo pedido a mano, pero no se captura ni se manda. */
  readonly puedeAjustar = input(false);
  /** Al volver: `true` si algo cambió (la mesa recarga: lo pedido a mano sale del sugerido, R1). */
  readonly cerrar = output<boolean>();

  readonly qty = qty;
  readonly tope = TOPE_COBERTURA_DIAS;
  private cambio = false;

  // ── A quién ────────────────────────────────────────────────────────────────────────────────
  readonly origenes = signal<Array<{ code: string; name: string }>>([]);
  readonly origenesError = signal(false);
  /** Código de la sucursal a la que va lo que se agrega, o `COMPRAS`. */
  readonly origen = signal<string | null>(null);
  readonly origenSel = computed(() => this.origenes().find((o) => o.code === this.origen()) ?? null);
  readonly destinoOpts = computed(() => [
    ...this.origenes().map((o) => ({ label: o.code === this.matriz() ? `${o.name} · tu matriz` : o.name, value: o.code })),
    { label: 'Compras · ruta por confirmar', value: COMPRAS },
  ]);

  // ── El buscador ────────────────────────────────────────────────────────────────────────────
  readonly term = signal('');
  readonly resultados = signal<AutoabastoManoProducto[]>([]);
  readonly buscando = signal(false);
  readonly buscado = signal(false);
  readonly errorBusqueda = signal<string | null>(null);
  readonly activo = signal(0);
  readonly agregando = signal<Record<string, boolean>>({});
  private busquedaN = 0;
  readonly onBuscar = makeDebouncedSearch((t) => this.buscar(t), 300);

  // ── Lo que llevas ──────────────────────────────────────────────────────────────────────────
  readonly renglones = signal<AutoabastoManoRenglon[]>([]);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly edicion = signal<Record<string, Edicion>>({});
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Un guardado (o un quitar) a la vez por renglón. Si llega otro mientras el primero viaja, espera a que
   * vuelva: dos en camino podían volver al revés y dejar en pantalla una cantidad que el servidor no guardó,
   * o un guardado tardío volvía a meter un renglón ya quitado (revisión del PR, 2026-11-27).
   */
  private readonly enVuelo = new Set<string>();
  private readonly trasVuelo = new Map<string, () => void>();
  /** «Volver» guarda primero lo pendiente: nada de lo tecleado se tira al salir. */
  readonly saliendo = signal(false);
  /** Lo que no se pudo guardar al salir: un segundo «Volver» lo descarta (lo decide la persona). */
  readonly sinGuardarAlSalir = signal(0);
  /** `false` si «ya viene» no se pudo medir para esta sucursal: el alcance lo cuenta como cero y se dice. */
  readonly vieneMedido = signal(true);
  readonly nota = signal('');
  /** Con el dedo, la ✕ del diálogo llega a 44 px por la vía del propio PrimeNG (pt), sin `::ng-deep`. */
  readonly ptDialogo: DialogPassThrough = {
    pcCloseButton: { root: { style: { minWidth: 'var(--tap-min)', minHeight: 'var(--tap-min)' } } },
  };

  // ── Mandar ─────────────────────────────────────────────────────────────────────────────────
  readonly confirmar = signal(false);
  readonly enviando = signal(false);
  readonly resultado = signal<AutoabastoManoEnviarResponse | null>(null);
  readonly errorEnvio = signal<string | null>(null);

  ngOnInit(): void {
    this.cargar();
    this.cargarOrigenes();
  }

  // ── Carga ──────────────────────────────────────────────────────────────────────────────────

  cargarOrigenes(): void {
    this.origenesError.set(false);
    this.svc.manoOrigenes(this.almacen().id).subscribe({
      next: (r) => {
        this.origenes.set(r.origenes);
        // El default no se teclea: la matriz que propone el motor; si no está en la lista, ninguna.
        const m = this.matriz();
        if (!this.origen()) this.origen.set(m && r.origenes.some((o) => o.code === m) ? m : null);
        this.buscar(this.term());
      },
      error: () => this.origenesError.set(true),
    });
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.mano(this.almacen().id).subscribe({
      next: (d) => {
        this.renglones.set(d.renglones);
        this.vieneMedido.set(d.viene_medido);
        this.cargadoEn.set(new Date());
        this.cargando.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo leer tu pedido a mano.');
        this.cargando.set(false);
      },
    });
  }

  /**
   * Volver a la mesa sin tirar lo tecleado: lo que espera su pausa se guarda ya, lo que falló se reintenta y
   * se sale cuando todo volvió. Si algo sigue sin guardarse, se dice y un segundo «Volver» lo descarta.
   */
  salir(): void {
    if (this.sinGuardarAlSalir() > 0) { this.cerrarYa(); return; }
    this.saliendo.set(true);
    for (const id of Object.keys(this.edicion())) {
      const t = this.timers.get(id);
      if (t) clearTimeout(t);
      this.timers.delete(id);
      this.guardar(id);
    }
    this.intentarSalir();
  }

  private intentarSalir(): void {
    if (!this.saliendo() || this.enVuelo.size || this.timers.size || Object.keys(this.agregando()).length) return;
    const n = Object.keys(this.edicion()).length;
    if (n) { this.saliendo.set(false); this.sinGuardarAlSalir.set(n); return; }
    this.cerrarYa();
  }

  private cerrarYa(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.saliendo.set(false);
    this.cerrar.emit(this.cambio);
  }

  // ── A quién ────────────────────────────────────────────────────────────────────────────────

  elegirOrigen(code: string | null): void {
    this.origen.set(code);
    // La existencia del origen y lo que Kepler rechazaría dependen de a quién se le pide.
    this.buscar(this.term());
  }

  // ── El buscador ────────────────────────────────────────────────────────────────────────────

  teclearBusqueda(v: string): void {
    this.term.set(v ?? '');
    this.onBuscar(v ?? '');
  }

  buscar(t: string): void {
    const n = ++this.busquedaN;
    const origen = this.origen() && this.origen() !== COMPRAS ? this.origen() : null;
    this.buscando.set(true);
    this.errorBusqueda.set(null);
    this.svc.manoBuscar(this.almacen().id, (t ?? '').trim(), origen).subscribe({
      next: (r) => {
        if (n !== this.busquedaN) return;   // llegó tarde: ya se escribió otra cosa
        this.resultados.set(r.productos);
        this.activo.set(0);
        this.buscado.set(true);
        this.buscando.set(false);
      },
      error: (e) => {
        if (n !== this.busquedaN) return;
        this.errorBusqueda.set(e?.error?.message ?? 'No se pudo buscar.');
        this.buscando.set(false);
      },
    });
  }

  teclaBusqueda(ev: KeyboardEvent): void {
    const n = this.resultados().length;
    if (ev.key === 'ArrowDown' && n) { ev.preventDefault(); this.activo.set(Math.min(n - 1, this.activo() + 1)); }
    else if (ev.key === 'ArrowUp' && n) { ev.preventDefault(); this.activo.set(Math.max(0, this.activo() - 1)); }
    else if (ev.key === 'Escape') { ev.preventDefault(); this.teclearBusqueda(''); }
    else if (ev.key === 'Enter' && n) {
      ev.preventDefault();
      const p = this.resultados()[this.activo()];
      if (!p) return;
      if (this.enEstePedido(p.product_id)) this.irARenglon(p.product_id); else this.agregar(p);
    }
  }

  /**
   * Con qué cantidad entra un producto: si ya va en el sugerido, CON LA SUYA (R1: se mueve, no se
   * recalcula); si no, con la propuesta de media caja; sin propuesta, uno de la unidad más chica.
   */
  cantidadAlAgregar(p: AutoabastoManoProducto): { cantidad: number; unidad: string } | null {
    if (!p.unidades.length) return null;
    const s = this.enSugerido()[p.product_id];
    const enSuUnidad = s && p.unidades.find((u) => u.unidad === String(s.unidad ?? '').trim().toUpperCase());
    if (s && enSuUnidad && Number.isInteger(s.cantidad) && s.cantidad >= 1) return { cantidad: s.cantidad, unidad: enSuUnidad.unidad };
    if (p.propuesta) return { cantidad: p.propuesta.cantidad, unidad: p.propuesta.unidad };
    return { cantidad: 1, unidad: p.unidades[p.unidades.length - 1].unidad };
  }

  agregar(p: AutoabastoManoProducto): void {
    const origen = this.origen();
    const c = this.cantidadAlAgregar(p);
    if (!this.puedeAjustar() || !origen || !c || this.agregando()[p.product_id]) return;
    const { cantidad, unidad } = c;
    this.agregando.update((a) => ({ ...a, [p.product_id]: true }));
    this.svc.manoGuardar({
      warehouse_id: this.almacen().id, product_id: p.product_id, origen_code: origen === COMPRAS ? null : origen,
      cantidad, unidad, ms_en_renglon: null,
    }).subscribe({
      next: (r) => {
        this.cambio = true;
        this.ponerRenglon(r.renglon);
        this.agregando.update((a) => { const c = { ...a }; delete c[p.product_id]; return c; });
        // Se queda en el buscador para seguir agregando; el renglón nuevo se ve abajo.
        queueMicrotask(() => this.host.nativeElement.querySelector<HTMLInputElement>('input[type=search]')?.focus());
        this.intentarSalir();
      },
      error: (e) => {
        this.agregando.update((a) => { const c = { ...a }; delete c[p.product_id]; return c; });
        this.errorBusqueda.set(e?.error?.message ?? 'No se pudo agregar.');
        this.intentarSalir();
      },
    });
  }

  enEstePedido(productId: string): AutoabastoManoRenglon | null {
    return this.renglones().find((r) => r.product_id === productId) ?? null;
  }

  irARenglon(productId: string): void {
    const tr = this.host.nativeElement.querySelector<HTMLElement>(`#am-r-${productId}`);
    tr?.scrollIntoView({ block: 'center' });
    const inp = tr?.querySelector<HTMLInputElement>('input.am-qty');
    inp?.focus();
    inp?.select();
  }

  // ── Lo que llevas ──────────────────────────────────────────────────────────────────────────

  /** Las filas de la tabla, por destino: un grupo por sucursal y Compras al final (`partirCaptura`). */
  readonly grupos = computed<GrupoCaptura[]>(() =>
    partirCaptura(this.renglones().map((r) => ({ product_id: r.product_id, destino: r.destino, cantidad_base: r.cantidad_base })),
      this.almacen().code).grupos);

  readonly filas = computed<Fila[]>(() => {
    const porId = new Map(this.renglones().map((r) => [r.product_id, r]));
    return this.grupos().flatMap((g, i) => {
      // La llave lleva el orden de `partirCaptura` (sucursales primero, Compras al final): la tabla agrupa
      // por ella y, sin el número, «compras» quedaba antes que «s:00» (prueba visual del 2026-11-26).
      const grupo = `${String(i).padStart(2, '0')}|${this.llaveGrupo(g.destino)}`;
      const banda = this.nombreDestino(g.destino) + (g.destino.tipo === 'sucursal' && g.destino.code === this.matriz() ? ' · tu matriz' : '');
      const bandaSub = g.enviable
        ? `${g.renglones.length} ${g.renglones.length === 1 ? 'renglón' : 'renglones'}`
        : `${g.renglones.length} ${g.renglones.length === 1 ? 'renglón' : 'renglones'} · ruta por confirmar`;
      return g.renglones.map((x) => ({ r: porId.get(x.product_id)!, grupo, banda, bandaSub })).filter((f) => !!f.r);
    });
  });

  cantidadDe(r: AutoabastoManoRenglon): number {
    return this.edicion()[r.product_id]?.cantidad ?? r.cantidad;
  }

  unidadDe(r: AutoabastoManoRenglon): string | null {
    return this.edicion()[r.product_id]?.unidad ?? r.unidad;
  }

  destinoDe(r: AutoabastoManoRenglon): string {
    return this.edicion()[r.product_id]?.destino ?? (r.destino.tipo === 'sucursal' ? r.destino.code : COMPRAS);
  }

  seleccionar(ev: FocusEvent): void {
    (ev.target as HTMLInputElement)?.select();
  }

  teclaCantidad(ev: KeyboardEvent, r: AutoabastoManoRenglon): void {
    const paso = pasoPorTecla(ev);
    if (paso) { ev.preventDefault(); this.mover(r, paso); return; }
    moverEntreCampos(ev, this.host.nativeElement, 'input.am-qty');
  }

  teclear(r: AutoabastoManoRenglon, ev: Event): void {
    const v = Math.trunc(Number((ev.target as HTMLInputElement).value));
    if (Number.isFinite(v) && v >= 1) this.cambiar(r, { cantidad: v });
  }

  mover(r: AutoabastoManoRenglon, paso: 1 | -1): void {
    this.cambiar(r, { cantidad: Math.max(1, this.cantidadDe(r) + paso) });
  }

  /** Cambia cantidad, unidad o destino y guarda al dejar de moverlo. */
  cambiar(r: AutoabastoManoRenglon, cambio: Partial<Pick<Edicion, 'cantidad' | 'unidad' | 'destino'>>): void {
    if (!this.puedeAjustar()) return;
    const actual: Edicion = this.edicion()[r.product_id] ?? {
      cantidad: r.cantidad, unidad: r.unidad ?? '', destino: this.destinoDe(r), guardando: false, error: null,
    };
    const nuevo: Edicion = { ...actual, ...cambio, guardando: false, error: null };
    this.edicion.update((e) => ({ ...e, [r.product_id]: nuevo }));
    this.sinGuardarAlSalir.set(0);
    const t = this.timers.get(r.product_id);
    if (t) clearTimeout(t);
    this.timers.set(r.product_id, setTimeout(() => this.guardar(r.product_id), ESPERA_GUARDADO_MS));
  }

  private guardar(productId: string): void {
    this.timers.delete(productId);
    // Con otro guardado del renglón en camino, éste espera a que vuelva y entonces manda lo MÁS NUEVO.
    if (this.enVuelo.has(productId)) { this.trasVuelo.set(productId, () => this.guardar(productId)); return; }
    const e = this.edicion()[productId];
    if (!e) { this.intentarSalir(); return; }
    this.enVuelo.add(productId);
    this.edicion.update((x) => ({ ...x, [productId]: { ...e, guardando: true } }));
    this.svc.manoGuardar({
      warehouse_id: this.almacen().id, product_id: productId, origen_code: e.destino === COMPRAS ? null : e.destino,
      cantidad: e.cantidad, unidad: e.unidad, ms_en_renglon: null,
    }).subscribe({
      next: (res) => {
        this.cambio = true;
        this.ponerRenglon(res.renglon);
        // Si la persona siguió moviendo mientras se guardaba, se queda su último valor (y su guardado pendiente).
        this.edicion.update((x) => {
          const c = { ...x };
          const ahora = c[productId];
          if (ahora && ahora.cantidad === e.cantidad && ahora.unidad === e.unidad && ahora.destino === e.destino) delete c[productId];
          else if (ahora) c[productId] = { ...ahora, guardando: false };
          return c;
        });
        this.alVolver(productId);
      },
      error: (err) => {
        // Sólo se marca el error: lo que la persona tecleó DESPUÉS de mandar este guardado no se pisa con
        // la foto vieja (antes volvía a la cantidad anterior y el guardado pendiente mandaba esa).
        this.edicion.update((x) => ({ ...x,
          [productId]: { ...(x[productId] ?? e), guardando: false, error: err?.error?.message ?? 'intenta de nuevo' } }));
        this.alVolver(productId);
      },
    });
  }

  /** Volvió lo que viajaba de ese renglón: sigue lo que esperaba (guardar lo nuevo o quitar), o se intenta salir. */
  private alVolver(productId: string): void {
    this.enVuelo.delete(productId);
    const sigue = this.trasVuelo.get(productId);
    this.trasVuelo.delete(productId);
    if (sigue) sigue(); else this.intentarSalir();
  }

  private ponerRenglon(r: AutoabastoManoRenglon): void {
    this.renglones.update((rs) => {
      const i = rs.findIndex((x) => x.product_id === r.product_id);
      if (i < 0) return [r, ...rs];
      const c = [...rs];
      c[i] = r;
      return c;
    });
  }

  quitar(r: AutoabastoManoRenglon): void {
    const t = this.timers.get(r.product_id);
    if (t) { clearTimeout(t); this.timers.delete(r.product_id); }
    // Con un guardado en camino, quitar espera a que vuelva: si no, ese guardado podía volver a meter el renglón.
    if (this.enVuelo.has(r.product_id)) { this.trasVuelo.set(r.product_id, () => this.quitar(r)); return; }
    this.enVuelo.add(r.product_id);
    this.svc.manoQuitar({ warehouse_id: this.almacen().id, product_id: r.product_id, ms_en_renglon: null }).subscribe({
      next: () => {
        this.cambio = true;
        this.renglones.update((rs) => rs.filter((x) => x.product_id !== r.product_id));
        this.edicion.update((x) => { const c = { ...x }; delete c[r.product_id]; return c; });
        this.alVolver(r.product_id);
      },
      error: (err) => {
        this.edicion.update((x) => ({ ...x, [r.product_id]: {
          cantidad: this.cantidadDe(r), unidad: this.unidadDe(r) ?? '', destino: this.destinoDe(r),
          guardando: false, error: err?.error?.message ?? 'no se pudo quitar' } }));
        this.alVolver(r.product_id);
      },
    });
  }

  /**
   * Renglones que la persona movió y todavía no se guardan (esperando, guardándose o con error): un
   * guardado bueno borra su entrada. Con uno pendiente, lo que se mandaría no sería lo que se ve.
   */
  readonly sinGuardar = computed(() => Object.keys(this.edicion()).length);

  // ── Lo que sale ────────────────────────────────────────────────────────────────────────────

  /** Por sucursal: lo que sí sale (sin lo que Kepler rechazaría). Compras no sale (R7). */
  readonly gruposQueSalen = computed(() => {
    const porId = new Map(this.renglones().map((r) => [r.product_id, r]));
    return this.grupos()
      .filter((g): g is GrupoCaptura & { destino: { tipo: 'sucursal'; code: string } } => g.enviable && g.destino.tipo === 'sucursal')
      .map((g) => ({
        code: g.destino.code,
        renglones: g.renglones.map((x) => porId.get(x.product_id)).filter((r): r is AutoabastoManoRenglon => !!r && !r.kepler),
      }))
      .filter((g) => g.renglones.length > 0);
  });

  readonly sale = computed(() => {
    const gs = this.gruposQueSalen();
    return { sucursales: gs.length, renglones: gs.reduce((s, g) => s + g.renglones.length, 0) };
  });

  readonly seQuedan = computed(() => this.renglones().filter((r) => r.destino.tipo === 'compras' || !!r.kepler));
  readonly pasanTope = computed(() => this.gruposQueSalen().flatMap((g) => g.renglones).filter((r) => r.alcance_con_pedido.pasa_tope));

  salenDe(g: GrupoCaptura): number {
    const porId = new Map(this.renglones().map((r) => [r.product_id, r]));
    return g.renglones.filter((x) => !porId.get(x.product_id)?.kepler).length;
  }

  etiquetaPedir(): string {
    const s = this.sale();
    if (s.sucursales === 1) return `Pedir a ${this.nombreDe(this.gruposQueSalen()[0].code)}`;
    if (s.sucursales > 1) return `Pedir a ${s.sucursales} sucursales`;
    return 'Pedir';
  }

  porQueNoSale(): string {
    if (this.sinGuardar() > 0) return 'Espera a que se guarden tus cambios.';
    if (!this.renglones().length) return 'Agrega al menos un producto.';
    if (!this.sale().renglones) return 'Nada de lo que llevas puede salir todavía: mira «Lo que sale».';
    return 'Cada sucursal recibe su pedido en Kepler, ya autorizado.';
  }

  readonly kpis = computed<MetricStripItem[]>(() => {
    const rs = this.renglones();
    const s = this.sale();
    const quedan = this.seQuedan().length;
    return [
      { label: 'Sale al mandarlo', value: s.renglones, tone: s.renglones ? 'ok' : 'default',
        sub: s.sucursales ? `a ${s.sucursales} ${s.sucursales === 1 ? 'sucursal' : 'sucursales'}` : 'nada todavía' },
      { label: 'Pedido a mano', value: rs.length, sub: `${rs.length === 1 ? 'renglón' : 'renglones'} en tu borrador` },
      { label: 'Se queda', value: quedan, tone: quedan ? 'warn' : 'ok', sub: 'Compras por confirmar o Kepler lo rechazaría' },
      { label: 'Pasan el tope', value: rs.filter((r) => r.alcance_con_pedido.pasa_tope).length, tone: 'warn', sub: `más de ${this.tope} días` },
    ];
  });

  enviar(): void {
    if (this.enviando() || !this.sale().renglones) return;
    this.enviando.set(true);
    this.errorEnvio.set(null);
    this.svc.manoEnviar({ warehouse_id: this.almacen().id, nota: this.nota().trim() || null }).subscribe({
      next: (res) => {
        this.cambio = true;
        this.resultado.set(res);
        this.confirmar.set(false);
        this.enviando.set(false);
        this.nota.set('');
        this.cargar();
      },
      error: (e) => {
        this.enviando.set(false);
        this.confirmar.set(false);
        this.errorEnvio.set(e?.error?.message ?? 'No se pudo mandar. Tu pedido a mano sigue guardado.');
      },
    });
  }

  // ── Cómo se dice ───────────────────────────────────────────────────────────────────────────

  /** El objetivo de días de esta sucursal (21 en las que no surten a otras): lo trae el alcance. */
  objetivo(): number {
    return this.renglones()[0]?.alcance.objetivo ?? this.resultados()[0]?.alcance.objetivo ?? 21;
  }

  llaveGrupo(d: DestinoCaptura): string {
    return d.tipo === 'sucursal' ? `s:${d.code}` : 'compras';
  }

  /** ⛔ Una sucursal se NOMBRA, jamás se numera. */
  nombreDe(code: string | null | undefined): string {
    return this.origenes().find((o) => o.code === code)?.name ?? (warehouseName(code) || String(code ?? ''));
  }

  nombreDestino(d: DestinoCaptura): string {
    return d.tipo === 'sucursal' ? this.nombreDe(d.code) : 'Compras';
  }

  nombreProducto(productId: string): string {
    const r = this.renglones().find((x) => x.product_id === productId);
    return r ? `${r.sku ?? ''} ${r.nombre ?? ''}`.trim() : 'Un producto';
  }

  cifra(n: number | null | undefined, unidad: string | null): string {
    return n == null ? 'sin dato' : `${qty(n)}${unidad ? ' ' + unidad : ''}`;
  }

  dias(n: number | null): string {
    return n == null ? '—' : `${Math.round(n)} d`;
  }

  textoAlcance(a: AlcanceRenglon): string {
    if (a.estado === 'sin_venta') return 'sin venta en 30 días: el alcance no se mide';
    if (a.estado === 'no_confiable') return 'unidad en duda: el alcance no se mide';
    const d = Math.round(a.hoy ?? 0);
    return d < 1 ? 'no te alcanza ni un día' : `te alcanza para ${d} ${d === 1 ? 'día' : 'días'}`;
  }

  textoNoMide(a: AlcanceRenglon): string {
    return a.estado === 'no_confiable' ? 'unidad en duda: no se mide' : 'sin venta en 30 días: no se mide';
  }

  /** La cuenta del alcance de ESE renglón (evidencia, no definición: va en el globo del renglón). */
  cuentaAlcance(r: AutoabastoManoRenglon): string {
    const a = r.alcance_con_pedido;
    if (a.estado !== 'medible') return 'Sin venta en los últimos 30 días, o con la unidad en duda: no hay alcance que calcular. No es cero.';
    const viene = r.viene == null ? 'lo que ya viene (sin medir: cuenta 0)' : `${qty(r.viene)} que ya viene`;
    return `(${qty(r.existencia)} que tienes + ${viene} + ${qty(r.cantidad_base)} que pides) ÷ `
      + `(${qty(r.venta_30d)} de venta en 30 días ÷ 30.4) = ${Math.round(a.con_pedido ?? 0)} días`
      + (a.pasa_tope ? `: pasa el tope de ${a.tope}.` : '.');
  }

  cajaDe(p: AutoabastoManoProducto): string | null {
    const mayor = p.unidades[0];
    return mayor && mayor.factor > 1 ? `${mayor.unidad} de ${mayor.factor}` : null;
  }

  textoKepler(k: RechazoKepler): string {
    return RECHAZO_KEPLER_MSG[k];
  }

  /** El envío quedó entero en Kepler: hay pedidos y todos llegaron (o ya estaban). */
  todoEnKepler(res: AutoabastoManoEnviarResponse): boolean {
    return res.requisiciones.length > 0
      && res.requisiciones.every((q) => q.kepler?.estado === 'entregada' || q.kepler?.estado === 'ya_estaba');
  }

  folioKepler(q: AutoabastoManoEnviarResponse['requisiciones'][number]): string {
    return q.kepler && 'folio' in q.kepler ? q.kepler.folio : q.folio;
  }

  motivoKepler(q: AutoabastoManoEnviarResponse['requisiciones'][number]): string {
    return q.kepler && 'motivo' in q.kepler ? q.kepler.motivo : '';
  }

  listaSku(rs: AutoabastoManoRenglon[]): string {
    const s = rs.slice(0, 4).map((r) => r.sku).join(', ');
    return rs.length > 4 ? `${s} y ${rs.length - 4} más` : s;
  }
}
