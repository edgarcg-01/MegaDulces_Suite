import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { TooltipModule } from 'primeng/tooltip';
import type { UnidadEscalera } from '@megadulces/contracts';
import {
  EstadoLote, EstadoPlaza, FlujoDetalle, LoteCaducidad, Margen, Margenes, MargenesProducto, PlazaFlujo,
  ProductosFlujoService, VeredictoCompra,
} from '../productos-flujo.service';
import { existenciaPartes, listaUnidades, textoUnidades } from './compras-catalogo-nuevos.component';

/** Cada minuto, sólo con la pestaña a la vista (como Productos nuevos). */
const REFRESCO_MS = 60_000;

export const ESTADO_TEXTO: Record<EstadoPlaza, string> = {
  agotado: 'Agotado', estancado: 'Estancado', se_freno: 'Se frenó', le_sobra: 'Le sobra', se_mueve: 'Se mueve', sin_movimiento: 'Sin movimiento',
};
export const LOTE_TEXTO: Record<EstadoLote, string> = {
  caducado: 'Caducado', no_alcanza: 'No alcanza a venderse', justo: 'Caduca pronto', a_tiempo: 'Se vende a tiempo',
};
/** "en 25 días" / "hoy" / "hace 8 días". */
export const diasTexto = (d: number) => d === 0 ? 'hoy' : d === 1 ? 'mañana' : d > 0 ? `en ${d} días` : d === -1 ? 'ayer' : `hace ${-d} días`;
/** "Líder · #3 en venta de la red (1.2%)". */
export const liderTexto = (l: { rank: number; participacion: number }) =>
  `Líder · #${l.rank} en venta de la red (${(l.participacion * 100).toFixed(1)}%)`;

/** `[PF.5]` "13.6%" / guion si no se pudo medir. */
export const margenTexto = (m: Margen | null | undefined) => (m?.pct === null || m?.pct === undefined ? '—' : `${m.pct.toFixed(1)}%`);

/** `[PF.5]` Los tres márgenes en el orden y con las preguntas de Productos nuevos. */
export const margenKpis = (t: Margenes) => [
  { titulo: 'De lista', ayuda: '¿Con qué margen lo pusimos a la venta? (la ficha de Kepler)', m: t.lista },
  { titulo: 'Real', ayuda: 'Lo que dejó, con el costo que Kepler registró en cada venta', m: t.real },
  { titulo: 'Sobre lo pagado', ayuda: 'Contra lo que costó en sus compras', m: t.pagado },
];

export const VEREDICTO_CLASE: Record<VeredictoCompra, string> = {
  comprar: 'is-comprar', traspasar: 'is-traspasar', esperar: 'is-esperar', sobra: 'is-sobra',
  no_comprar: 'is-no', sin_movimiento: 'is-neutro',
};

const dineroFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
export const dinero = (v: number | null | undefined) => (v === null || v === undefined ? '—' : dineroFmt.format(v));
/** "+12%" / "−40%" / guion si no hay base. */
export const variacionTexto = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}%`;
export const fechaCorta = (iso: string | null | undefined) => iso
  ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`))
  : '—';
/** "Octubre" (con mayúscula sólo la primera: el capitalize de CSS ponía mayúscula a cada palabra). */
const mesNombre = (iso: string) => {
  const m = new Intl.DateTimeFormat('es-MX', { month: 'long', timeZone: 'UTC' }).format(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`));
  return m.charAt(0).toUpperCase() + m.slice(1);
};

/** La existencia de una sucursal del flujo, en la forma que entienden las funciones de Productos nuevos. */
export const existenciaDe = (p: Pick<PlazaFlujo, 'existencia' | 'existencia_duda' | 'escalera'>) => existenciaPartes({
  existencia: p.existencia, existencia_unidad: p.escalera?.[0]?.rotulo ?? null, existencia_fuente: 'kepler',
  escalera: p.escalera, existencia_duda: p.existencia_duda,
});

/** Una cantidad en unidad base escrita en cajas y lo que sobra (para los traspasos sugeridos). */
export const cantidadEnCajas = (q: number, esc: UnidadEscalera[] | null) =>
  textoUnidades({ [esc?.[0]?.rotulo ?? 'PZA']: q }, esc);

/** La gráfica: dos líneas acumuladas (mes en curso y mes anterior) en un SVG de 100 × 40. */
export function trazos(serie: FlujoDetalle['serie']): { actual: string; anterior: string; max: number } {
  const n = serie.dias.length;
  const max = Math.max(1, ...serie.anterior, ...serie.actual.filter((x): x is number => x !== null));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const y = (v: number) => 40 - (v / max) * 38 - 1;
  const pts = (vs: Array<number | null>) => vs.map((v, i) => (v === null ? null : `${x(i).toFixed(2)},${y(v).toFixed(2)}`))
    .filter((s): s is string => s !== null).join(' ');
  return { actual: pts(serie.actual), anterior: pts(serie.anterior), max };
}

/**
 * `[PF.1]` El comportamiento de UN producto: flujo de venta contra el mes anterior en tiempo real,
 * cada sucursal (se mueve / se frenó / estancado / agotado), y si de verdad hace falta comprarlo.
 */
@Component({
  selector: 'app-producto-flujo-panel',
  standalone: true,
  imports: [CommonModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (det(); as d) {
      <div class="pf">
        <!-- El veredicto primero: es la pregunta que trae al usuario. -->
        <section class="pf-veredicto" [ngClass]="claseVeredicto(d.resumen.compra.veredicto)" aria-labelledby="pf-v">
          @if (d.resumen.lider; as l) {
            <span class="pf-lider" pTooltip="Está entre los productos que juntos hacen la mitad de la venta de la red en 90 días. A un líder se le compra antes: no debe faltar.">{{ liderTexto(l) }}</span>
          }
          <h3 id="pf-v" class="pf-v-t">{{ d.resumen.compra.titulo }}</h3>
          @if (d.resumen.compra.motivos.length) {
            <ul class="pf-lista">
              @for (m of d.resumen.compra.motivos; track $index) { <li>{{ m }}</li> }
            </ul>
          }
          @if (d.resumen.compra.impacto.length) {
            <p class="pf-sub">En qué afecta</p>
            <ul class="pf-lista">
              @for (m of d.resumen.compra.impacto; track $index) { <li>{{ m }}</li> }
            </ul>
          }
          @if (d.resumen.compra.traspasos.length) {
            <p class="pf-sub">Mover antes de comprar</p>
            <ul class="pf-lista pf-traspasos">
              @for (t of d.resumen.compra.traspasos; track $index) {
                <li><b>{{ cajas(t.cantidad, escaleraDe(d, t.hacia)) }}</b> de {{ t.desde_nombre || ('Sucursal ' + t.desde) }}
                  a {{ t.hacia_nombre || ('Sucursal ' + t.hacia) }}</li>
              }
            </ul>
          }
        </section>

        <!-- [PF.3] Lo que caduca antes de venderse va arriba: hay que actuar antes de la fecha. -->
        @if (d.lotes.length) {
          <section class="pf-bloque" aria-labelledby="pf-cad">
            <h3 id="pf-cad" class="pf-h">Caducidad</h3>
            <div class="dt-scope">
              <table class="pf-tabla dt-stack">
                <thead><tr>
                  <th scope="col">Sucursal</th><th scope="col">Caduca</th><th scope="col">Hay hoy</th>
                  <th scope="col">Alcanza a venderse</th><th scope="col">Caducaría</th><th scope="col">Qué hacer</th>
                </tr></thead>
                <tbody>
                  @for (l of d.lotes; track $index) {
                    <tr>
                      <td class="dt-id" role="cell">{{ l.nombre || ('Sucursal ' + l.plaza) }}
                        @if (l.lote) { <small class="pf-lote">Lote {{ l.lote }}</small> }</td>
                      <td role="cell" data-label="Caduca">
                        <span class="pf-estado" [ngClass]="'is-lote-' + l.estado">{{ loteEstado(l.estado) }}</span>
                        <span class="pf-fecha">{{ fecha(l.caduca) }} · {{ dias(l.dias) }}</span>
                      </td>
                      <td role="cell" data-label="Hay hoy">{{ hayHoy(l) }}</td>
                      <td role="cell" data-label="Alcanza a venderse">{{ l.dias < 0 ? '—' : cajas(l.se_vende_antes, l.escalera) }}</td>
                      <td role="cell" data-label="Caducaría">
                        @if (l.queda > 0) { <b class="pf-down">{{ cajas(l.queda, l.escalera) }}</b> } @else { — }
                      </td>
                      <td role="cell" data-label="Qué hacer">{{ l.accion }}
                        @for (m of l.mover_a; track m.plaza) {
                          <b class="pf-mover">Mover {{ cajas(m.cantidad, l.escalera) }} a {{ m.nombre || ('Sucursal ' + m.plaza) }}</b>
                        }
                        @if (l.sin_destino > 0 && l.mover_a.length) {
                          <b class="pf-mover pf-down">Promover o devolver {{ cajas(l.sin_destino, l.escalera) }}</b>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="pf-meta">Fechas registradas en el andén y en la revisión de caducidades. Kepler no descuenta por lote al vender: lo registrado
              se topa con la existencia de hoy y se da por vendido primero lo que caduca primero, al ritmo de los últimos
              {{ d.criterio.ventanaRitmo }} días. En el CEDIS el ritmo es el de toda la red. Un producto sin fecha registrada no es uno que no caduque.</p>
          </section>
        }

        <section class="pf-bloque" aria-labelledby="pf-flujo">
          <h3 id="pf-flujo" class="pf-h">Flujo de venta</h3>
          <div class="pf-kpis">
            <div><span>{{ mes(d.periodos.mesIni) }} (1 al {{ d.periodos.dias }})</span><b>{{ dinero(d.resumen.mes) }}</b></div>
            <div><span>{{ mes(d.periodos.prevIni) }}, mismos días</span><b>{{ dinero(d.resumen.mes_anterior_mismo) }}</b></div>
            <div><span>Cambio</span>
              <b [class.pf-up]="(d.resumen.variacion ?? 0) > 0" [class.pf-down]="(d.resumen.variacion ?? 0) < 0">{{ variacion(d.resumen.variacion) }}</b></div>
            <div><span>{{ mes(d.periodos.prevIni) }} completo</span><b>{{ dinero(d.resumen.mes_anterior_total) }}</b></div>
          </div>
          @let tz = trazos(d.serie);
          <figure class="pf-graf">
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img"
                 [attr.aria-label]="'Venta acumulada: ' + dinero(d.resumen.mes) + ' contra ' + dinero(d.resumen.mes_anterior_mismo) + ' los mismos días del mes anterior'">
              <polyline class="pf-l-ant" [attr.points]="tz.anterior" />
              <polyline class="pf-l-act" [attr.points]="tz.actual" />
            </svg>
            <figcaption class="pf-leyenda">
              <span class="pf-ley-act">{{ mes(d.periodos.mesIni) }}</span>
              <span class="pf-ley-ant">{{ mes(d.periodos.prevIni) }}</span>
              <span class="pf-meta">Venta acumulada día por día, con impuestos. En vivo al {{ hora(d.en_vivo_al) }}.</span>
            </figcaption>
          </figure>
        </section>

        <!-- [PF.5] Los tres margenes, como en Productos nuevos. Carga aparte (tarda ~1 s) y solo con permiso de costo. -->
        @if (d.costo_visible) {
          <section class="pf-bloque" aria-labelledby="pf-margen">
            <h3 id="pf-margen" class="pf-h">Márgenes (últimos {{ d.criterio.ventanaMargen }} días cerrados)</h3>
            @if (margenes(); as m) {
              @if (m.total; as t) {
                <div class="pf-kpis">
                  @for (k of kpisMargen(t); track k.titulo) {
                    <div><span>{{ k.titulo }}</span>
                      <b [class.pf-down]="(k.m.pct ?? 0) < 0">{{ margen(k.m) }}</b>
                      <small>{{ k.ayuda }}</small>
                      @if (k.m.nota) { <small class="pf-nota">{{ k.m.nota }}</small> }</div>
                  }
                </div>
                <div class="dt-scope">
                  <table class="pf-tabla dt-stack">
                    <thead><tr>
                      <th scope="col">Sucursal</th><th scope="col" class="pf-num">Venta sin impuestos</th>
                      <th scope="col" class="pf-num">De lista</th><th scope="col" class="pf-num">Real</th>
                      <th scope="col" class="pf-num">Sobre lo pagado</th>
                    </tr></thead>
                    <tbody>
                      @for (pl of m.plazas; track pl.plaza) {
                        <tr>
                          <td class="dt-id" role="cell">{{ pl.nombre || ('Sucursal ' + pl.plaza) }}</td>
                          <td class="pf-num dt-num" role="cell" data-label="Venta sin impuestos">{{ dinero(pl.margenes.venta_neta) }}</td>
                          <td class="pf-num dt-num" role="cell" data-label="De lista" [pTooltip]="pl.margenes.lista.nota || ''">{{ margen(pl.margenes.lista) }}</td>
                          <td class="pf-num dt-num" role="cell" data-label="Real" [pTooltip]="pl.margenes.real.nota || ''"
                              [class.pf-down]="(pl.margenes.real.pct ?? 0) < 0">{{ margen(pl.margenes.real) }}</td>
                          <td class="pf-num dt-num" role="cell" data-label="Sobre lo pagado" [pTooltip]="pl.margenes.pagado.nota || ''"
                              [class.pf-down]="(pl.margenes.pagado.pct ?? 0) < 0">{{ margen(pl.margenes.pagado) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <p class="pf-meta">Del {{ fecha(m.desde) }} al {{ fecha(m.hasta) }}, venta de tienda sin IVA ni IEPS. Cada margen se mide sólo sobre la
                  venta que puede juzgar: lo que no trae costo o meta queda fuera y se dice, no se cuenta como cero.
                  @if (t.costo_pagado; as cp) { Lo pagado: {{ dinero2(cp.por_unidad) }} por {{ cp.unidad }}. }</p>
              } @else {
                <p class="pf-meta">Sin venta en los últimos {{ d.criterio.ventanaMargen }} días cerrados: no hay margen que medir.</p>
              }
            } @else if (margenesError()) {
              <p class="pf-meta" role="alert">No se pudieron calcular los márgenes.</p>
            } @else {
              <p class="pf-meta">Calculando márgenes…</p>
            }
          </section>
        }

        <section class="pf-bloque" aria-labelledby="pf-plazas">
          <h3 id="pf-plazas" class="pf-h">¿Dónde se mueve y dónde se estancó?</h3>
          <div class="dt-scope">
            <table class="pf-tabla dt-stack">
              <thead><tr>
                <th scope="col">Sucursal</th><th scope="col">Estado</th>
                <th scope="col" class="pf-num">Este mes</th><th scope="col" class="pf-num">vs mes ant.</th>
                <th scope="col" class="pf-num">Venta por día</th><th scope="col" class="pf-num">Sin vender</th>
                <th scope="col">Existencia</th><th scope="col" class="pf-num">Alcanza para</th>
              </tr></thead>
              <tbody>
                @for (p of d.plazas; track p.plaza) {
                  <tr>
                    <td class="dt-id" role="cell">{{ p.nombre || ('Sucursal ' + p.plaza) }}</td>
                    <td role="cell" data-label="Estado"><span class="pf-estado" [ngClass]="'is-' + p.estado" [pTooltip]="p.motivo">{{ estado(p.estado) }}</span></td>
                    <td class="pf-num dt-num" role="cell" data-label="Este mes">{{ dinero(p.mes) }}</td>
                    <td class="pf-num dt-num" role="cell" data-label="vs mes ant."
                        [class.pf-up]="(p.variacion ?? 0) > 0" [class.pf-down]="(p.variacion ?? 0) < 0">{{ variacion(p.variacion) }}</td>
                    <td class="pf-num dt-num" role="cell" data-label="Venta por día">{{ dinero(p.venta_dia) }}</td>
                    <td class="pf-num dt-num" role="cell" data-label="Sin vender">{{ sinVender(p, d.criterio.ventanaHistoria) }}</td>
                    <td role="cell" data-label="Existencia">
                      @let e = existencia(p);
                      @switch (e.estado) {
                        @case ('agotado') { <span class="pf-tag-agotado">Agotado</span> }
                        @case ('sin_registro') { <span class="pf-vacio">Sin registro</span> }
                        @case ('en_duda') {
                          <span class="pf-cants"><span class="pf-tag-duda" [pTooltip]="e.motivo || ''">En duda</span>
                            @for (c of e.partes; track $index) { <span class="pf-cant"><b>{{ c.cifra }}</b> {{ c.rotulo }}</span> }</span>
                        }
                        @default {
                          <span class="pf-cants">@for (c of e.partes; track $index) { <span class="pf-cant"><b>{{ c.cifra }}</b> {{ c.rotulo }}</span> }</span>
                        }
                      }
                    </td>
                    <td class="pf-num dt-num" role="cell" data-label="Alcanza para">{{ alcanza(p.cobertura_dias) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pf-meta">Estancado = hay existencia y lleva {{ d.criterio.diasEstancado }} días o más sin venderse. Se frenó = en lo que va
            del mes vende menos de la mitad que los mismos días del mes anterior. «Alcanza para» es la existencia entre la venta
            por día de los últimos {{ d.criterio.ventanaRitmo }} días. Umbrales propuestos, a calibrar con Compras.</p>
        </section>

        <section class="pf-bloque" aria-labelledby="pf-llegada">
          <h3 id="pf-llegada" class="pf-h">Compras y reparto (últimos {{ d.criterio.ventanaReparto }} días)</h3>
          <div class="pf-kpis">
            <div><span>Primera compra en Kepler</span><b>{{ fecha(d.llegada.primera_compra) }}</b>
              <small>{{ sucursales(d.llegada.primera_compra_plazas) }}</small></div>
            <div><span>Última compra</span><b>{{ fecha(d.llegada.ultima_compra) }}</b>
              <small>{{ sucursales(d.llegada.ultima_compra_plazas) }}</small></div>
          </div>
          @if (d.reparto.length) {
            <div class="dt-scope">
              <table class="pf-tabla dt-stack">
                <thead><tr>
                  <th scope="col">Sucursal</th><th scope="col">Compró</th><th scope="col">Le llegó de otra</th>
                  <th scope="col">Mandó a otras</th><th scope="col">Mandó a rutas</th>
                </tr></thead>
                <tbody>
                  @for (r of d.reparto; track r.plaza) {
                    <tr>
                      <td class="dt-id" role="cell">{{ r.nombre || ('Sucursal ' + r.plaza) }}</td>
                      <td role="cell" data-label="Compró">{{ unidades(r.comprado, r.escalera) || '—' }}</td>
                      <td role="cell" data-label="Le llegó de otra">{{ unidades(r.recibido, r.escalera) || '—' }}</td>
                      <td role="cell" data-label="Mandó a otras">{{ unidades(r.mandado_sucursales, r.escalera) || '—' }}</td>
                      <td role="cell" data-label="Mandó a rutas">{{ unidades(r.mandado_rutas, r.escalera) || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="pf-meta">Sin compras ni traspasos en la ventana.</p>
          }
        </section>
        @if (!d.lotes.length) {
          <p class="pf-meta">Caducidad: este producto no tiene fechas registradas (se registran en el andén y en la revisión de caducidades).
            Sin fecha registrada no quiere decir que no caduque.</p>
        }
      </div>
    } @else if (error()) {
      <p class="pf-meta" role="alert">No se pudo cargar el comportamiento del producto.</p>
    } @else {
      <p class="pf-meta">Cargando comportamiento…</p>
    }
  `,
  styles: [`
    :host { display: block; }
    .pf { display: flex; flex-direction: column; gap: 1rem; }
    .pf-h { margin: 0 0 .5rem; font-size: var(--fs-md); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pf-bloque { display: flex; flex-direction: column; gap: .5rem; }
    .pf-meta { margin: 0; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pf-sub { margin: .35rem 0 0; font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-2); }
    .pf-lista { margin: 0; padding-left: 1.1rem; font-size: var(--fs-sm); color: var(--c-text-1); display: flex; flex-direction: column; gap: .15rem; }
    .pf-veredicto { border: 1px solid var(--c-divider); border-left-width: 4px; border-radius: 10px; padding: .75rem .9rem; background: var(--c-surface-1); }
    .pf-v-t { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pf-veredicto.is-comprar { border-left-color: var(--bad-fg); }
    .pf-veredicto.is-traspasar { border-left-color: var(--warn-fg); }
    .pf-veredicto.is-esperar { border-left-color: var(--c-text-3); }
    .pf-veredicto.is-sobra, .pf-veredicto.is-no { border-left-color: var(--ok-fg); }
    .pf-veredicto.is-neutro { border-left-color: var(--c-divider); }
    .pf-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .5rem; }
    .pf-kpis > div { display: flex; flex-direction: column; gap: .1rem; border: 1px solid var(--c-divider); border-radius: 8px; padding: .5rem .6rem; }
    .pf-kpis span { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pf-kpis b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-md); color: var(--c-text-1); }
    .pf-kpis small { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pf-up { color: var(--ok-fg); }
    .pf-down { color: var(--bad-fg); }
    .pf-graf { margin: 0; display: flex; flex-direction: column; gap: .3rem; }
    .pf-graf svg { width: 100%; height: 7rem; border: 1px solid var(--c-divider); border-radius: 8px; background: var(--c-surface-1); }
    .pf-l-act, .pf-l-ant { fill: none; vector-effect: non-scaling-stroke; stroke-width: 2; }
    .pf-l-act { stroke: var(--action); }
    .pf-l-ant { stroke: var(--c-text-3); stroke-dasharray: 4 3; }
    .pf-leyenda { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pf-ley-act::before, .pf-ley-ant::before { content: ''; display: inline-block; width: 1rem; height: 0; margin-right: .3rem; vertical-align: middle; border-top: 2px solid var(--action); }
    .pf-ley-ant::before { border-top: 2px dashed var(--c-text-3); }
    .pf-tabla { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .pf-tabla th, .pf-tabla td { padding: .35rem .5rem; border-bottom: 1px solid var(--c-divider); text-align: left; vertical-align: top; }
    .pf-tabla th { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pf-num { text-align: right !important; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .pf-estado { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      border: 1px solid var(--c-divider); color: var(--c-text-2); white-space: nowrap; }
    .pf-estado.is-agotado, .pf-estado.is-se_freno { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .pf-estado.is-estancado { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .pf-estado.is-se_mueve { color: var(--ok-fg); background: var(--ok-soft-bg); }
    .pf-estado.is-le_sobra { color: var(--c-text-1); background: var(--c-surface-2); }
    .pf-cants { display: inline-flex; flex-direction: column; gap: .1rem; }
    .pf-cant { white-space: nowrap; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pf-cant b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pf-vacio { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pf-tag-agotado, .pf-tag-duda { display: inline-block; align-self: flex-start; padding: .05rem .45rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-bold); }
    .pf-nota { color: var(--warn-soft-fg); }
    .pf-lider { display: inline-block; margin-bottom: .3rem; padding: .05rem .5rem; border-radius: 999px; font-size: var(--fs-xs);
      font-weight: var(--fw-bold); color: var(--action); border: 1px solid currentColor; }
    .pf-lote, .pf-fecha { display: block; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pf-fecha { margin-top: .15rem; white-space: nowrap; }
    .pf-mover { display: block; margin-top: .15rem; }
    .pf-estado.is-lote-caducado, .pf-estado.is-lote-no_alcanza { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .pf-estado.is-lote-justo { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .pf-estado.is-lote-a_tiempo { color: var(--ok-fg); background: var(--ok-soft-bg); }
    .pf-tag-agotado { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border: 1px solid var(--bad-border); }
    .pf-tag-duda { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border: 1px solid var(--warn-border); }
  `],
})
export class ProductoFlujoPanelComponent {
  readonly productId = input.required<string>();

  private readonly api = inject(ProductosFlujoService);
  private readonly recarga = signal(0);
  private readonly res = rxResource({
    params: () => ({ id: this.productId(), v: this.recarga() }),
    stream: ({ params }) => this.api.detalle(params.id),
  });
  /** Lo último del MISMO producto se queda mientras se recarga: sin pantallazo (como NP.17). */
  readonly det = linkedSignal<FlujoDetalle | null, FlujoDetalle | null>({
    source: () => (this.res.error() ? null : this.res.value() ?? null),
    computation: (nuevo, previo) => {
      const id = this.productId();
      if (nuevo && nuevo.product_id === id) return nuevo;
      const ant = previo?.value;
      return ant && ant.product_id === id ? ant : null;
    },
  });
  readonly error = computed(() => !!this.res.error() && !this.det());

  // [PF.5] Los margenes de los dias cerrados: no cambian en el minuto, se piden una vez por producto.
  private readonly margenesRes = rxResource({
    params: () => (this.det()?.costo_visible ? this.productId() : undefined),
    stream: ({ params }) => this.api.margenes(params),
  });
  readonly margenes = linkedSignal<MargenesProducto | undefined, MargenesProducto | null>({
    source: () => (this.margenesRes.error() ? undefined : this.margenesRes.value()),
    computation: (nuevo, previo) => {
      const id = this.productId();
      if (nuevo && nuevo.product_id === id) return nuevo;
      const ant = previo?.value;
      return ant && ant.product_id === id ? ant : null;
    },
  });
  readonly margenesError = computed(() => !!this.margenesRes.error() && !this.margenes());

  readonly dinero = dinero;
  readonly variacion = variacionTexto;
  readonly fecha = fechaCorta;
  readonly mes = mesNombre;
  readonly trazos = trazos;
  readonly existencia = existenciaDe;
  readonly cajas = cantidadEnCajas;
  readonly listaUnidades = listaUnidades;
  readonly liderTexto = liderTexto;
  readonly margen = margenTexto;
  readonly kpisMargen = margenKpis;
  dinero2(v: number): string { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(v); }
  readonly dias = diasTexto;

  constructor() {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.recarga.update((n) => n + 1);
    }, REFRESCO_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  estado(e: EstadoPlaza): string { return ESTADO_TEXTO[e]; }
  loteEstado(e: EstadoLote): string { return LOTE_TEXTO[e]; }
  /** Lo presente hoy; si la existencia no se pudo medir, lo registrado (y se dice). */
  hayHoy(l: LoteCaducidad): string {
    if (l.en_existencia === null) return `${cantidadEnCajas(l.registrado, l.escalera)} (registrado; existencia sin medir)`;
    if (l.en_existencia <= 0) return 'Ya no hay';
    return cantidadEnCajas(l.en_existencia, l.escalera);
  }
  claseVeredicto(v: VeredictoCompra): string { return VEREDICTO_CLASE[v]; }
  unidades(u: Record<string, number>, esc: UnidadEscalera[] | null): string { return textoUnidades(u, esc); }
  escaleraDe(d: FlujoDetalle, plaza: string): UnidadEscalera[] | null {
    return d.plazas.find((x) => x.plaza === plaza)?.escalera ?? d.escalera;
  }
  sinVender(p: PlazaFlujo, ventana: number): string {
    if (p.dias_sin_venta === null) return `más de ${ventana} días`;
    if (p.dias_sin_venta === 0) return 'hoy vendió';
    return p.dias_sin_venta === 1 ? '1 día' : `${p.dias_sin_venta} días`;
  }
  alcanza(d: number | null): string {
    if (d === null) return '—';
    if (d < 1) return 'menos de 1 día';
    const n = Math.round(d);
    return n === 1 ? '1 día' : `${n} días`;
  }
  sucursales(xs: Array<{ plaza: string; nombre: string | null }>): string {
    return xs.map((x) => x.nombre || `Sucursal ${x.plaza}`).join(', ');
  }
  hora(iso: string): string {
    return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  }
}
