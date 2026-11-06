import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, linkedSignal, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { TagModule } from 'primeng/tag';
import { unidadLegible, warehouseName } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import type { VeredictoCompra } from '../productos-flujo.service';
import {
  DetalleNuevo, EstadoSemaforo, HitoNuevo, HitoValores, PlazaNueva, ProductosNuevosService, VeredictoNuevo,
} from '../productos-nuevos.service';
import {
  SEMAFORO, TIPOS_MARGEN, VEREDICTOS, cruceCompra, estadoHitoTexto, existenciaPartes, existenciaTexto, fechaCorta,
  hitoVisible, listaUnidades, margenTexto, ordenSucursales, PLAZA_CEDIS, sucursalesQueVenden,
  textoUnidades, tresMargenes, veredictoVista,
} from '../productos-nuevos-vista';

/**
 * `[PF.23]` La venta de una sucursal en el PERIODO de la ficha (el calendario de arriba), ya dicha por la ficha Sencillo:
 * con ella, «Por sucursal» reemplaza a la tabla «Venta y existencia por sucursal» en un producto nuevo (opción A de David,
 * 2026-11-04: la tabla y las tarjetas repetían venta y existencia por sucursal).
 */
export interface VentaPeriodoSucursal {
  codigo: string;
  /** El monto, ya con formato; null = no se puede medir (`sinVentaPor` dice por qué). */
  monto: string | null;
  /** «7 CJA 2 PAQ»; vacío = sin unidades. */
  unidades: string;
  sinVentaPor: string;
}

/** Severidad de `p-tag` para cada tono del resultado. */
const SEVERIDAD: Record<string, 'success' | 'warn' | 'danger' | 'info' | 'secondary'> = {
  ok: 'success', warn: 'warn', bad: 'danger', info: 'info', muted: 'secondary',
};

/** `true` si el error es «este producto no está en seguimiento» (404 del servidor): no es una falla, no es nuevo. */
export function noEsNuevo(e: unknown): boolean {
  const c = (e as { cause?: unknown })?.cause ?? e;
  return c instanceof HttpErrorResponse ? c.status === 404 : (c as { status?: number })?.status === 404;
}

/** Cada cuánto se vuelve a pedir lo de hoy mientras la ficha está a la vista (como la pantalla de antes). */
const REFRESCO_MS = 60_000;

/**
 * `[NP.22]` La sección «Lanzamiento» de la ficha de un producto NUEVO (Sencillo y Detallado): lo que mostraba el panel
 * de la pantalla Productos nuevos, que se unió a Compras › Catálogo › Productos (decisión de David, 2026-11-04).
 * Mismo endpoint (`GET commercial/products/new-products/:id`) y mismas funciones (`productos-nuevos-vista.ts`).
 *
 * Jerarquía: primario = los cortes 30 · 60 · 90 (tres tarjetas); secundario = márgenes y dónde se mueve mejor;
 * terciario = el reparto por sucursal. Por pedido de David (2026-11-04) ya NO trae la tarjeta del resultado (está en la
 * columna «¿Funcionó?» de la lista) ni «Comportamiento global» (cifras, avisos, tendencia y gráfica semanal).
 *
 * ⛔ «¿Hay que comprar?» NO va aquí: lo dice la ficha Detallada («Qué hacer», el único motor de compra). Si los dos
 * tiran en contra (aquí «Sacar», allá «Comprar»), la ficha pasa su veredicto y aquí se EXPLICA (`cruceCompra`).
 *
 * Un producto que no está en seguimiento (el servidor responde 404) no pinta nada: no es una falla.
 */
@Component({
  selector: 'app-producto-lanzamiento',
  standalone: true,
  imports: [NgTemplateOutlet, TagModule, LoadStateComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <section class="lz" aria-labelledby="lz-t" aria-live="polite">
        <div class="lz-cab">
          <h3 class="lz-titulo" id="lz-t">Lanzamiento</h3>
          <app-context-help topic="productos-nuevos" />
        </div>
        <app-load-state [loading]="cargando()" [error]="errorTexto()" [isEmpty]="false" [skeletonRows]="4"
                        errorTitle="No se pudo leer el lanzamiento" (retry)="recargar()">
          @if (det(); as dt) {
            <div class="lz-cuerpo">
              <!-- [NP.22] La tarjeta del resultado (funciono? + motivos) se retiro a pedido de David (2026-11-04): el resultado
                   ya se ve en la columna de la lista. Solo si contradice a Que hacer queda UNA linea que lo explica. -->
              @if (cruce(); as c) { <p class="lz-aviso lz-cruce" role="note">{{ c }}</p> }

              <!-- Los cortes 30 60 90: tres tarjetas que se leen de un vistazo y se apilan en angosto (sin tabla ni scroll). -->
              <div class="lz-bloque">
                <h4 class="lz-h">Cortes de 30, 60 y 90 días
                  @if (dt.costo_visible) { <small class="lz-h-nota">Por $1: venta sin impuestos ÷ compra sin impuestos</small> }
                </h4>
                <ol class="lz-cortes">
                  @for (h of hitos; track h) {
                    @let x = hitoDe(dt, h);
                    @let ve = hitoVisible(dt.producto.dia, h);
                    <li class="lz-corte" [class.is-curso]="!x.cerrado && ve" [class.is-futuro]="!ve">
                      <p class="lz-corte-cab"><b>A {{ h }} días</b> <span class="lz-estado">{{ estadoHito(x, dt.producto.dia, h) }}</span></p>
                      <dl class="lz-corte-datos">
                        <div><dt>Vendido</dt><dd class="comm-num">{{ !ve ? '—' : (x.venta === null ? 'Sin venta' : dinero(x.venta)) }}</dd></div>
                        @if (dt.costo_visible) {
                          <div><dt>Invertido</dt><dd class="comm-num">{{ !ve ? '—' : (x.inversion === null ? 'No medido' : dinero(x.inversion)) }}</dd></div>
                          <div><dt>Por $1</dt><dd class="comm-num">{{ x.venta_por_peso === null || x.venta_por_peso === undefined || !x.cerrado ? '—' : veces(x.venta_por_peso) }}</dd></div>
                        }
                      </dl>
                      @if (ve && textoUnidades(x.unidades, dt.producto.escalera); as u) { <p class="lz-corte-u">{{ u }}</p> }
                    </li>
                  }
                </ol>
                @if (dt.costo_visible && dt.compra_info && !dt.compra_info.medida) {
                  <p class="lz-aviso">No se pudieron leer los renglones de compra: lo invertido puede traer impuestos.</p>
                }
              </div>

              <!-- Terciario: margenes (solo con permiso de costo) -->
              @if (dt.costo_visible && dt.producto.margenes; as mg) {
                <div class="lz-bloque">
                  <h4 class="lz-h">Márgenes</h4>
                  <dl class="lz-kpis lz-margenes">
                    @for (t of tiposMargen; track t.id) {
                      <!-- [NP.22] Sin las leyendas (pedido de David): la pregunta, al pasar el cursor; si el costo no cubre toda
                           la venta, un «*» con el porqué (el número no se presenta como completo cuando no lo es). -->
                      <div [title]="t.pregunta">
                        <dt>{{ t.titulo }}</dt>
                        <dd><b class="lz-mono" [class.lz-faint]="mg[t.id].pct === null">{{ margenTexto(mg[t.id].pct) }}</b>@if (mg[t.id].nota; as nota) {<span class="lz-aviso lz-ast" [title]="nota" aria-hidden="true">*</span><span class="sr-only">&ngsp;{{ nota }}</span>}</dd>
                      </div>
                    }
                  </dl>
                </div>
              }

              <!-- [NP.22] Una sola lista por sucursal: donde se mueve mejor + su reparto y su resultado (antes eran dos bloques
                   que repetian Le llego, Vendido y Existencia). De la que mas vende por dia a la que menos; las que aun no
                   compiten, al final. -->
              <div class="lz-bloque">
                <h4 class="lz-h">Por sucursal</h4>
                @if (!dt.plazas.length) {
                  <p class="lz-nota">Todavía no llega a ninguna sucursal.</p>
                } @else {
                  <p class="lz-texto">Nos llegaron <b>{{ textoUnidades(dt.producto.unidades_recibidas, dt.producto.escalera) || 'sin compras en Kepler' }}</b>
                    en compras@if (dt.producto.llegada?.fecha) {, la primera el {{ fecha(dt.producto.llegada!.fecha) }}}@if (compraCedis(dt.plazas); as cc) {; de ellas, {{ cc }} por el CEDIS}. De la sucursal que más vende por día a la que menos:</p>
                }
                <ol class="lz-rank lz-sucs">
                  @for (p of ordenSucursales(sucursalesQueVenden(dt.plazas)); track p.plaza) {
                    <li class="lz-rk lz-plaza" [class.is-mejor]="p.movimiento?.lugar === 1">
                      <div class="lz-rk-cab">
                        @if (p.movimiento?.lugar; as lugar) { <span class="lz-rk-lugar" data-label="Lugar">{{ lugar }}</span> }
                        <span class="lz-rk-suc"><b>{{ nombrePlaza(p) }}</b>
                          @if (p.dia !== null) { <small class="lz-chico">día {{ p.dia }}</small> }</span>
                        <!-- [NP.22] Sin «Agotado: no se juzga»: «Hoy · Agotado» ya lo dice en la tarjeta (se quito a pedido de David). -->
                        @if (veredictoVista(p.recomendacion.veredicto) !== 'agotado') {
                          <p-tag [value]="verd(p.recomendacion.veredicto).label" [icon]="verd(p.recomendacion.veredicto).icon"
                                 [severity]="sev(verd(p.recomendacion.veredicto).tono)" />
                        }
                        @if (p.movimiento?.venta_neta_dia !== null && p.movimiento?.venta_neta_dia !== undefined) {
                          <span class="lz-rk-dia" data-label="Venta por día"><b class="lz-mono">{{ dinero(p.movimiento.venta_neta_dia) }}</b> <small class="lz-chico">por día</small></span>
                        } @else {
                          <span class="lz-rk-dia lz-chico">Aún no compite</span>
                        }
                      </div>
                        <dl class="lz-rk-datos">
                          @if (ventaPeriodo()) {
                            <div data-label="Vendido en el periodo" [title]="periodoTexto() ? 'Vendido ' + periodoTexto() : ''"><dt>En el periodo</dt><dd>
                              @if (ventaDe(p.plaza); as vp) {
                                @if (vp.monto) { <span class="lz-mono">{{ vp.monto }}</span>@if (vp.unidades) { <small class="lz-chico lz-bloque-n">{{ vp.unidades }}</small> } }
                                @else { <span class="lz-faint">{{ vp.sinVentaPor }}</span> }
                              } @else { <span class="lz-faint">Sin dato</span> }
                            </dd></div>
                          }
                          <div data-label="Vendido"><dt>{{ ventaPeriodo() ? 'Desde que llegó' : 'Vendido' }}</dt><dd><span class="lz-mono">{{ dinero(p.venta_total) }}</span>
                            @if (textoUnidades(p.unidades_vendidas, p.escalera); as u) { <small class="lz-chico lz-bloque-n">{{ u }}</small> }
                            @else if (p.venta_sin_unidad > 0) { <small class="lz-chico lz-bloque-n">sólo en pesos</small> }</dd></div>
                          <div data-label="Compró"><dt>Compró</dt><dd><ng-container *ngTemplateOutlet="cantidadesTpl; context: { $implicit: p.unidades_recibidas, vacio: 'Sin compras', esc: p.escalera }" /></dd></div>
                          @if (textoUnidades(p.recibido_traspaso, p.escalera)) {
                            <div data-label="Le llegó de otra"><dt>Le llegó de otra</dt><dd><ng-container *ngTemplateOutlet="cantidadesTpl; context: { $implicit: p.recibido_traspaso, vacio: '—', esc: p.escalera }" /></dd></div>
                          }
                          @if (textoUnidades(p.enviado_sucursales, p.escalera)) {
                            <div data-label="Mandó a otras"><dt>Mandó a otras</dt><dd><ng-container *ngTemplateOutlet="cantidadesTpl; context: { $implicit: p.enviado_sucursales, vacio: '—', esc: p.escalera }" /></dd></div>
                          }
                          @if (textoUnidades(p.enviado_rutas, p.escalera)) {
                            <div data-label="Mandó a rutas"><dt>Mandó a rutas</dt><dd><ng-container *ngTemplateOutlet="cantidadesTpl; context: { $implicit: p.enviado_rutas, vacio: '—', esc: p.escalera }" /></dd></div>
                          }
                          <div data-label="Existencia hoy"><dt>Hoy</dt><dd><ng-container *ngTemplateOutlet="existenciaTpl; context: { $implicit: p }" /></dd></div>
                          @if (p.movimiento?.desplazado !== null && p.movimiento?.desplazado !== undefined) {
                            <div data-label="Vendido de lo que llegó"><dt>Vendió de lo que llegó</dt><dd class="lz-mono">{{ pct(p.movimiento.desplazado) }}</dd></div>
                          }
                          @if (p.venta_hoy > 0) {
                            <div><dt>Vendido hoy</dt><dd><span class="lz-mono">{{ dinero(p.venta_hoy) }}</span>
                              @if (textoUnidades(p.unidades_hoy, p.escalera); as u) { <small class="lz-chico lz-bloque-n">{{ u }}</small> }</dd></div>
                          }
                          <div><dt>Últimas 4 semanas</dt><dd class="lz-mono">{{ dinero(p.venta_28) }}</dd></div>
                          <div><dt>Última venta</dt><dd>{{ fecha(p.ultima_venta) }}</dd></div>
                          <div><dt>Recompra</dt><dd>{{ p.primera_recompra ? fecha(p.primera_recompra) : 'Todavía no' }}</dd></div>
                          @if (dt.costo_visible) {
                            <div><dt>Invertido</dt><dd class="lz-mono">{{ p.inversion_total === null ? 'No medido' : dinero(p.inversion_total) }}</dd></div>
                            <div data-label="Margen real"><dt>Margen lista · real · pagado</dt><dd><span class="lz-mono">{{ tresMargenes(p.margenes) }}</span>
                              @if (p.margenes?.real?.nota; as nt) { <small class="lz-chico lz-bloque-n">{{ nt }}</small> }</dd></div>
                          }
                        </dl>
                    </li>
                  }
                </ol>
              </div>

              <!-- La edad del dato se queda (regla de frescura), en una linea junto al boton; el resto de la nota se quito a pedido de David. -->
              <div class="lz-pie">
                <button type="button" class="lz-act" (click)="recargar()" [disabled]="res.isLoading()">
                  <i class="pi pi-refresh" aria-hidden="true"></i> {{ res.isLoading() ? 'Actualizando…' : 'Actualizar ahora' }}
                </button>
                <small class="lz-chico">En vivo al {{ hora(dt.frescura.en_vivo_al) }}</small>
              </div>
            </div>
          }
        </app-load-state>
      </section>
    }

    <!-- Una cantidad por renglon: la cifra en mono y negrita, la unidad de Kepler al lado. -->
    <ng-template #cantidadesTpl let-u let-vacio="vacio" let-esc="esc">
      @let lista = listaUnidades(u, esc);
      @if (lista.length) {
        <span class="lz-cants">@for (c of lista; track $index) { <span class="lz-cant"><b>{{ c.cifra }}</b> {{ c.rotulo }}</span> }</span>
      } @else { <span class="lz-faint">{{ vacio }}</span> }
    </ng-template>
    <!-- Existencia en la escalera de la ficha. En duda: la estimada del kardex y el porque, a la vista. -->
    <ng-template #existenciaTpl let-p>
      @let e = existenciaPartes(p);
      @switch (e.estado) {
        @case ('agotado') { <p-tag value="Agotado" severity="danger" /> }
        @case ('sin_registro') { <span class="lz-faint">Sin registro</span> }
        @case ('en_duda') {
          <span class="lz-cants">
            <p-tag value="En duda" severity="warn" />
            @for (c of e.partes; track $index) { <span class="lz-cant"><b>{{ c.cifra }}</b> {{ c.rotulo }}</span> }
          </span>
        }
        @default {
          <span class="lz-cants">@for (c of e.partes; track $index) { <span class="lz-cant"><b>{{ c.cifra }}</b> {{ c.rotulo }}</span> }</span>
        }
      }
    </ng-template>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; container-name: lanz; }
    .lz { display: flex; flex-direction: column; min-width: 0; }
    .lz-cab { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2); }
    .lz-act { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 2rem; padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); font: inherit;
      font-size: var(--fs-sm); cursor: pointer; }
    .lz-act:hover { background: var(--overlay-hover); }
    .lz-act:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .lz-pie { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); }
    .lz-act[disabled] { color: var(--text-faint); cursor: progress; }
    @media (pointer: coarse) { .lz-act { min-height: 44px; } }
    .lz-titulo { margin: 0; font-size: var(--fs-micro); letter-spacing: .07em; text-transform: uppercase;
      color: var(--text-faint); font-weight: var(--fw-bold); }
    .lz-cuerpo { display: flex; flex-direction: column; gap: var(--sp-5); }
    .lz-bloque { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    .lz-h { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--text-main); }
    .lz-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .lz-chico { font-size: var(--fs-xs); color: var(--text-muted); }
    .lz-bloque-n { display: block; }
    .lz-faint { color: var(--text-faint); font-size: var(--fs-sm); }
    .lz-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
    .lz-texto { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .lz-aviso { margin: 0; font-size: var(--fs-xs); color: var(--warn-soft-fg); line-height: 1.45; }
    .lz-malo { color: var(--bad-fg); }

    /* Datos en rejilla */
    .lz-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: var(--sp-2) var(--sp-3); margin: 0; }
    .lz-kpis > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .lz-kpis dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .lz-kpis dd { margin: 0; display: flex; flex-direction: column; gap: 2px; }
    .lz-kpis b { font-size: var(--fs-sm); color: var(--text-main); }
    .lz-kpis small { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.35; }
    .lz-margenes { grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); }
    .lz-margenes b { font-size: var(--fs-h3); }

    /* [NP.22] ¿Donde se mueve mejor?: un renglon por sucursal, sin tabla. */
    .lz-ast { margin-left: 2px; cursor: help; }
    .lz-rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .lz-rk { border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-2) var(--sp-3); min-width: 0; }
    .lz-rk.is-mejor { background: var(--ok-soft-bg); }
    .lz-rk-cab { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); }
    .lz-rk-lugar { min-width: 1.5rem; font-weight: var(--fw-bold); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .lz-rk-suc { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: var(--sp-1); flex-wrap: wrap; }
    .lz-rk-dia { margin-left: auto; white-space: nowrap; }
    .lz-rk-datos { margin: var(--sp-1) 0 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: var(--sp-1) var(--sp-3); }
    .lz-rk-datos > div { min-width: 0; }
    .lz-rk-datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .lz-rk-datos dd { margin: 0; font-size: var(--fs-sm); }
    .lz-cants { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; }
    .lz-cant { white-space: nowrap; font-size: var(--fs-xs); color: var(--text-muted); }
    .lz-cant b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--text-main); }

    /* Los cortes: tres tarjetas en fila; en angosto, una debajo de otra (sin scroll horizontal) */
    .lz-h-nota { display: block; margin-top: 2px; font-size: var(--fs-xs); font-weight: normal; color: var(--text-muted); }
    .lz-cruce { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--warn-border); border-radius: var(--r-md); background: var(--warn-soft-bg); }
    .lz-cortes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
    .lz-corte { border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-2) var(--sp-3); min-width: 0;
      display: flex; flex-direction: column; gap: var(--sp-1); }
    .lz-corte.is-curso { border-style: dashed; border-color: var(--warn-border); }
    .lz-corte.is-futuro { color: var(--text-faint); }
    .lz-corte-cab { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--sp-1); font-size: var(--fs-sm); }
    .lz-estado { font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-muted); white-space: nowrap; }
    .lz-corte.is-curso .lz-estado { color: var(--warn-soft-fg); }
    .lz-corte-datos { margin: 0; display: flex; flex-direction: column; gap: 2px; }
    .lz-corte-datos > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); min-height: 1.5rem; }
    .lz-corte-datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .lz-corte-datos dd { margin: 0; font-size: var(--fs-sm); text-align: right; }
    .lz-corte-datos dd.comm-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); color: var(--text-main); }
    .lz-corte.is-futuro dd.comm-num { color: var(--text-faint); font-weight: normal; }
    .lz-corte-u { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }

    /* Angosto: las tablas apiladas con su etiqueta por celda */
    @container lanz (max-width: 34rem) {
      .lz-cortes { grid-template-columns: 1fr; }
    }
  `],
})
export class ProductoLanzamientoComponent {
  readonly productId = input.required<string>();
  /**
   * ¿El renglón ya dice si es nuevo? `true` = sí (se muestra la sección mientras carga); `false` = no (ni se pide);
   * `null` = no se sabe (Sencillo sin el filtro): se pide y la sección aparece sólo si el producto está en seguimiento.
   */
  readonly esNuevo = input<boolean | null>(null);
  /** El veredicto de compra de la ficha («Qué hacer»), para explicar si tira en contra. null = la ficha no lo tiene. */
  readonly veredictoCompra = input<VeredictoCompra | null>(null);
  /** `[PF.23]` La venta del periodo por sucursal (sólo Sencillo); null = no se pinta ese dato. */
  readonly ventaPeriodo = input<VentaPeriodoSucursal[] | null>(null);
  /** `[PF.23]` «del 1 nov 2026 al 4 nov 2026»: el periodo de `ventaPeriodo`. */
  readonly periodoTexto = input<string | null>(null);
  /** `[PF.23]` true cuando la sección tiene detalle (el producto es nuevo): la ficha quita entonces su tabla repetida. */
  readonly conDetalle = output<boolean>();
  private readonly avisarDetalle = effect(() => this.conDetalle.emit(!!this.det()));
  /** La venta del periodo de UNA sucursal (por su código). */
  ventaDe(codigo: string): VentaPeriodoSucursal | null {
    return this.ventaPeriodo()?.find((v) => v.codigo === codigo) ?? null;
  }

  private readonly api = inject(ProductosNuevosService);
  private readonly recarga = signal(0);

  readonly hitos: HitoNuevo[] = [30, 60, 90];
  readonly tiposMargen = TIPOS_MARGEN;
  readonly hitoVisible = hitoVisible;
  readonly textoUnidades = textoUnidades;
  readonly listaUnidades = listaUnidades;
  readonly existenciaPartes = existenciaPartes;
  readonly existenciaTexto = existenciaTexto;
  readonly margenTexto = margenTexto;
  readonly tresMargenes = tresMargenes;
  readonly ordenSucursales = ordenSucursales;
  readonly sucursalesQueVenden = sucursalesQueVenden;
  /** Lo que compró el CEDIS (su tarjeta no se muestra: se dice aquí para que «Nos llegaron» siga cuadrando). */
  compraCedis(plazas: PlazaNueva[]): string {
    const c = plazas.find((p) => p.plaza === PLAZA_CEDIS);
    return c ? textoUnidades(c.unidades_recibidas, c.escalera) : '';
  }

  readonly res = rxResource({
    params: () => {
      const id = this.productId();
      const nuevo = this.esNuevo();
      return nuevo === false ? undefined : { id, v: this.recarga() };
    },
    stream: ({ params }) => (params ? this.api.detalle(params.id) : of(null)),
  });

  /**
   * Sólo el detalle del producto abierto; mientras se recarga (cada minuto) se queda el último del MISMO producto
   * (`[NP.17]`: antes el panel se vaciaba y se volvía a pintar desde arriba).
   */
  readonly det = linkedSignal<DetalleNuevo | null, DetalleNuevo | null>({
    source: () => (this.res.error() ? null : (this.res.hasValue() ? this.res.value() : null)),
    computation: (nuevo, previo) => {
      const id = this.productId();
      if (nuevo && nuevo.producto.product_id === id) return nuevo;
      const ant = previo?.value;
      return ant && ant.producto.product_id === id ? ant : null;
    },
  });

  /** 404 = no está en seguimiento: no es una falla y la sección no se pinta. */
  readonly noNuevo = computed(() => noEsNuevo(this.res.error()));
  readonly errorTexto = computed(() => {
    const e = this.res.error();
    const hay = this.det();
    return e && !noEsNuevo(e) && !hay ? 'Revisa la conexión y vuelve a intentar.' : null;
  });
  readonly cargando = computed(() => this.res.isLoading() && !this.det());
  /** Se pinta si ya hay detalle, si falló de verdad, o si el renglón dijo que es nuevo (mientras carga). */
  readonly visible = computed(() => {
    const nuevo = this.esNuevo();
    const hay = !!this.det();
    const no = this.noNuevo();
    const err = !!this.errorTexto();
    if (nuevo === false || no) return false;
    return hay || err || nuevo === true;
  });

  /**
   * `[NP.UI.3]` Si el lanzamiento y «Qué hacer» de la ficha tiran en sentido contrario, la frase que lo explica: queda como
   * UNA línea arriba de los cortes (la tarjeta del resultado se retiró; sin esta línea, «Sacar» en la lista y «Comprar» en
   * Qué hacer quedarían como contradicción). Sólo en Detallado: Sencillo no tiene Qué hacer.
   */
  readonly cruce = computed(() => {
    const pf = this.veredictoCompra();
    const rec = this.det()?.producto.recomendacion ?? null;
    return cruceCompra(rec ? veredictoVista(rec.veredicto) : null, pf);
  });

  constructor() {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.recargar();
    }, REFRESCO_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  recargar(): void { this.recarga.update((n) => n + 1); }

  verd(v: VeredictoNuevo | string) { return VEREDICTOS[veredictoVista(v)]; }
  sev(tono: string) { return SEVERIDAD[tono] ?? 'secondary'; }
  semaforo(e: EstadoSemaforo) { return SEMAFORO[e]; }
  estadoHito(h: HitoValores, dia: number | null, n: HitoNuevo): string { return estadoHitoTexto(h, dia, n); }
  /** El corte de un producto, con su tipo. */
  hitoDe(dt: DetalleNuevo, h: HitoNuevo): HitoValores { return dt.producto.hitos[h]; }
  /** `[NP.22]` El resultado como se ve (para no pintar «Agotado: no se juzga» junto a «Hoy · Agotado»). */
  readonly veredictoVista = veredictoVista;
  /** Una sucursal se NOMBRA: el nombre del servidor y, si no viene, el resolvedor único (`warehouseName`). */
  nombrePlaza(p: { nombre: string | null; plaza: string }): string { return p.nombre || warehouseName(p.plaza); }

  fecha(iso: string | null): string { return fechaCorta(iso); }
  /** El día anterior a `iso` (`YYYY-MM-DD`): el último día que entra en la historia. */
  vispera(iso: string | null): string | null {
    if (!iso) return null;
    const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : null;
  }
  unidadUna(u: string): string {
    const leg = unidadLegible(u);
    return leg.conocida ? leg.singular : u;
  }
  hora(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
  }
  dinero(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(v));
  }
  veces(v: number): string {
    return `$${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v))}`;
  }
  pct(v: number): string { return `${Math.round(v * 100)}%`; }
}
