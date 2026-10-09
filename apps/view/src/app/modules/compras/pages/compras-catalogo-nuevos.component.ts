import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SparklineComponent } from '../../../shared/components/charts/sparkline.component';
import { unidadLegible } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { CATALOGO_TABS } from '../catalogo-tabs';
import {
  HitoNuevo,
  MargenesNuevo,
  PlazaNueva,
  ProductoNuevo,
  ProductosNuevosService,
  RespuestaNuevos,
  UnidadesKepler,
  VeredictoNuevo,
} from '../productos-nuevos.service';

/** `[NP.15]` Los tres márgenes, cada uno con la pregunta que contesta. */
export const TIPOS_MARGEN: ReadonlyArray<{ id: 'lista' | 'real' | 'pagado'; titulo: string; pregunta: string }> = [
  { id: 'lista', titulo: 'De lista', pregunta: '¿Con qué margen lo pusimos a la venta? (ficha de Kepler)' },
  { id: 'real', titulo: 'Real', pregunta: '¿Cuánto dejó? (costo que Kepler registró en cada venta)' },
  { id: 'pagado', titulo: 'Sobre lo pagado', pregunta: '¿La ficha tiene el costo correcto? (lo que se pagó al comprarlo)' },
];

/** Un margen en porcentaje, con un decimal; sin medir = guion, nunca 0%. */
export function margenTexto(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** Los tres márgenes en una línea: "17.0% · 10.1% · 10.0%" (lista · real · pagado). */
export function tresMargenes(m: MargenesNuevo | null): string {
  if (!m) return '—';
  return TIPOS_MARGEN.map((t) => margenTexto(m[t.id].pct)).join(' · ');
}

/**
 * `[NP.15]` Las sucursales en el orden de "dónde se mueve mejor": primero las que compiten (por su
 * lugar) y después las que todavía no (por venta por día). Las que no tienen venta en la historia
 * no aparecen: no hay nada que comparar.
 */
/** `[NP.16]` "Padre Hidalgo y Canindo": las sucursales donde entró la primera compra. */
export function sucursalesTexto(s: ReadonlyArray<{ plaza: string; nombre: string | null }>): string {
  const n = s.map((x) => x.nombre || `Sucursal ${x.plaza}`);
  if (n.length <= 1) return n[0] ?? '';
  return `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
}

/**
 * `[NP.16]` Las sucursales del reparto: primero las que compraron (las que reparten), luego las que
 * recibieron de otra, y al final las demás con existencia. Una sin compra, sin traspaso, sin envío y
 * sin existencia no tiene nada que decir en el reparto.
 */
export function ordenReparto(plazas: PlazaNueva[]): PlazaNueva[] {
  const hay = (u: UnidadesKepler | undefined) => Object.keys(u ?? {}).length > 0;
  const grupo = (p: PlazaNueva) => (hay(p.unidades_recibidas) ? 0 : hay(p.recibido_traspaso) ? 1 : 2);
  return plazas
    .filter((p) => hay(p.unidades_recibidas) || hay(p.recibido_traspaso) || hay(p.enviado_sucursales)
      || hay(p.enviado_rutas) || (p.existencia ?? 0) > 0)
    .slice()
    .sort((a, b) => grupo(a) - grupo(b) || a.plaza.localeCompare(b.plaza));
}

export function ordenMovimiento(plazas: PlazaNueva[]): PlazaNueva[] {
  return plazas
    .filter((p) => p.movimiento?.venta_neta_dia !== null && p.movimiento?.venta_neta_dia !== undefined)
    .slice()
    .sort((a, b) => (a.movimiento.lugar ?? 999) - (b.movimiento.lugar ?? 999)
      || (b.movimiento.venta_neta_dia ?? 0) - (a.movimiento.venta_neta_dia ?? 0));
}

/** Qué se está mirando: todo lo que se sigue, un veredicto, o lo que queda fuera del seguimiento. */
export type FiltroNuevos =
  | 'seguimiento' | VeredictoNuevo
  | 'sin_venta_30' | 'sin_movimiento' | 'no_medible' | 'excluido';

/** Cada veredicto, como se ve. El orden es el de "qué pide acción primero". */
export const VEREDICTOS: Record<VeredictoNuevo, { label: string; tono: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; icon: string }> = {
  recomprar: { label: 'Recomprar', tono: 'ok', icon: 'pi pi-check-circle' },
  revisar: { label: 'Revisar', tono: 'warn', icon: 'pi pi-exclamation-circle' },
  no_recomprar: { label: 'No recomprar', tono: 'bad', icon: 'pi pi-times-circle' },
  esperar: { label: 'Esperar', tono: 'info', icon: 'pi pi-clock' },
  pronto: { label: 'Aún es pronto', tono: 'muted', icon: 'pi pi-hourglass' },
};
const ORDEN_VEREDICTOS: VeredictoNuevo[] = ['recomprar', 'revisar', 'no_recomprar', 'esperar', 'pronto'];

const OTROS: { id: FiltroNuevos; label: string }[] = [
  { id: 'sin_venta_30', label: 'Sin venta en su primer mes' },
  { id: 'sin_movimiento', label: 'Dados de alta, sin movimiento' },
  { id: 'no_medible', label: 'No medibles' },
  { id: 'excluido', label: 'Excluidos' },
];

/** Cada cuánto se vuelve a pedir lo de hoy mientras la pantalla está a la vista. */
const REFRESCO_MS = 60_000;

/** ¿La fila entra en este filtro? Pura: la prueba la ejerce sin montar el componente. */
export function pasaFiltro(f: ProductoNuevo, filtro: FiltroNuevos): boolean {
  switch (filtro) {
    case 'seguimiento': return f.estado === 'seguimiento';
    case 'sin_venta_30': return f.estado === 'seguimiento' && f.sin_venta_30;
    case 'sin_movimiento': case 'no_medible': case 'excluido': return f.estado === filtro;
    default: return f.estado === 'seguimiento' && f.recomendacion?.veredicto === filtro;
  }
}

export function pasaBusqueda(f: ProductoNuevo, q: string): boolean {
  // Cada palabra en cualquier campo y en cualquier orden, sin importar acentos ni mayúsculas.
  return coincideBusqueda(q, f.sku, f.nombre, f.marca, f.proveedor);
}

/**
 * El hito se muestra si ya cerró o si es el tramo EN CURSO. Los de más adelante van con guion:
 * a los 23 días, el valor "a 60 días" sería el mismo que el de 30 y se leería como un dato.
 */
export function hitoVisible(dia: number | null, n: HitoNuevo): boolean {
  return dia !== null && dia >= n - 30;
}

/** Fecha `YYYY-MM-DD` en corto, SIN corrimiento de zona (se lee como UTC y se pinta como UTC). */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(t);
}

/** La escalera de Kepler, de lo grande a lo chico: así se lee "3 cajas · 40 piezas". */
const ORDEN_UNIDAD: Record<string, number> = { CJA: 0, BTO: 1, CUB: 2, PAQ: 3, KG: 4, PZA: 5 };
const rangoUnidad = (u: string) => ORDEN_UNIDAD[u] ?? (/^[0-9]+$/.test(u) ? 6 : u === '?' ? 8 : 7);
const cifra = (q: number) => q.toLocaleString('es-MX', { maximumFractionDigits: 2 });

/**
 * Una cantidad con su rótulo de Kepler, en palabras: "3 cajas", "1 paquete", "6 de 500 g".
 * El rótulo se traduce con `unidadLegible` (el censo medido del repo); uno que no se conoce se
 * imprime TAL CUAL (`SER`), y sin rótulo se dice "sin unidad" — nunca se le llama pieza.
 */
export function cantidadTexto(q: number, unidad: string | null | undefined): string {
  const u = (unidad ?? '').trim().toUpperCase();
  if (!u || u === '?') return `${cifra(q)} sin unidad`;
  // Gramaje de la bolsa (500, 250): no es un nombre de unidad.
  if (/^[0-9]+$/.test(u)) return `${cifra(q)} de ${u} g`;
  const leg = unidadLegible(u);
  if (!leg.conocida) return `${cifra(q)} ${u}`;
  return `${cifra(q)} ${Math.abs(q) === 1 ? leg.singular : leg.plural}`;
}

/** Todas las unidades de un producto, cada rótulo por su lado: "3 cajas · 40 piezas". */
export function textoUnidades(u: UnidadesKepler | null | undefined): string {
  return Object.entries(u ?? {})
    .filter(([, q]) => Math.abs(q) >= 0.0005)
    .sort(([a], [b]) => rangoUnidad(a) - rangoUnidad(b) || a.localeCompare(b))
    .map(([k, q]) => cantidadTexto(q, k))
    .join(' · ');
}

/**
 * La existencia de una plaza, en palabras y en la unidad de SU ficha de Kepler: "Hay 24 piezas
 * (2 cajas)". La caja sólo aparece si la ficha la declara con su factor; nunca se inventa.
 */
export function existenciaTexto(
  p: Pick<PlazaNueva, 'existencia' | 'existencia_unidad' | 'existencia_fuente' | 'existencia_mayor'>,
): string {
  if (p.existencia === null) return 'Sin existencia registrada';
  if (p.existencia <= 0) return 'Agotado';
  const base = p.existencia_unidad
    ? cantidadTexto(p.existencia, p.existencia_unidad)
    : `${cifra(p.existencia)} ${p.existencia_fuente === 'wincaja' ? 'unidades de Wincaja' : '(unidad sin declarar en Kepler)'}`;
  const m = p.existencia_mayor;
  if (!m) return `Hay ${base}`;
  return `Hay ${base} (${Number.isInteger(m.cantidad) ? '' : '≈ '}${cantidadTexto(m.cantidad, m.unidad)})`;
}

/**
 * Sólo las semanas COMPLETAS van a la gráfica. La semana en curso trae únicamente los días que
 * ya pasaron, y pintarla hacía que la línea "se desplomara" al final — se leía como una caída que
 * no existe. Lo de esta semana se dice en texto ("Hoy $…").
 */
export function semanasCerradas(semanas: number[], dia: number | null): number[] {
  if (dia === null || !semanas.length) return [];
  return (dia + 1) % 7 === 0 ? semanas : semanas.slice(0, -1);
}

/** La tendencia de 4 semanas contra las 4 anteriores, en palabras. */
export function tendenciaTexto(t: number | null): string {
  if (t === null) return 'Sin 8 semanas para comparar';
  const pct = Math.round((t - 1) * 100);
  if (pct === 0) return 'Igual que las 4 semanas anteriores';
  return `${pct > 0 ? '+' : ''}${pct}% contra las 4 semanas anteriores`;
}

/**
 * `[NP.5]` — **Productos nuevos.** Cada código que entra al catálogo se sigue 90 días desde su
 * primera entrada o venta, y el sistema dice si conviene volver a comprarlo: global en la lista y,
 * al abrirlo, sucursal por sucursal.
 *
 * La pantalla no decide nada: la recomendación, la etapa y lo que cuenta para la cohorte vienen
 * del servidor (`libs/commercial/.../new-products.ts`). Aquí se pinta y se DECLARA lo que no se
 * mide (inversión sin entrada en Kepler, historia corta) en vez de dibujarlo como cero.
 *
 * EN VIVO: lo de hoy (venta, entradas, existencia) se vuelve a pedir cada minuto mientras la
 * pestaña está a la vista; la historia cierra cada noche. La pantalla dice las dos horas.
 */
@Component({
  selector: 'app-compras-catalogo-nuevos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ButtonModule, TooltipModule,
    PageTabsComponent, SidePeekComponent, SparklineComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pn">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Productos nuevos</h1>
          <p class="surf-page-sub">
            Cómo le va a cada código nuevo y si conviene volver a comprarlo. Se sigue 90 días desde su primera entrada o venta.
          </p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      @if (datos(); as d) {
        @if (!d.calculado) {
          <section class="pn-aviso" role="status">
            <strong>Las cifras se están calculando por primera vez.</strong>
            <span>Aparecen solas en unos minutos y después se recalculan cada 30 minutos.</span>
          </section>
        } @else {
          <div class="pn-vivo" role="status">
            <span class="pn-punto" [class.is-off]="error()" aria-hidden="true"></span>
            <span class="pn-vivo-t">{{ error() ? 'Sin conexión' : 'En vivo' }}</span>
            <span class="pn-vivo-d">
              Venta, entradas y existencia de hoy al {{ hora(d.frescura?.en_vivo_al) }} · días anteriores al {{ hora(d.frescura?.historia_al) }}.
              Se actualiza solo cada minuto.
            </span>
            <button pButton type="button" class="p-button-sm p-button-text" [loading]="cargando()" (click)="recargar()"
                    aria-label="Actualizar ahora">
              <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
            </button>
          </div>

          @if (d.resumen; as r) {
            <section class="pn-respuesta" aria-live="polite">
              <p class="pn-titular">
                @if (r.seguimiento === 0) {
                  Ningún producto nuevo en seguimiento.
                } @else if (r.por_veredicto.recomprar > 0) {
                  De {{ n(r.seguimiento) }} productos nuevos, conviene volver a comprar {{ n(r.por_veredicto.recomprar) }}.
                } @else {
                  De {{ n(r.seguimiento) }} productos nuevos, ninguno pide recompra todavía.
                }
              </p>
              <div class="pn-veredictos" role="group" aria-label="Filtrar por recomendación">
                @for (v of ordenVeredictos; track v) {
                  <button type="button" [class]="'pn-ver pn-tono-' + verd(v).tono" [class.is-sel]="filtro() === v"
                          [attr.aria-pressed]="filtro() === v" (click)="alternar(v)">
                    <i [class]="verd(v).icon" aria-hidden="true"></i>
                    <span>{{ verd(v).label }}</span>
                    <strong>{{ n(r.por_veredicto[v]) }}</strong>
                  </button>
                }
              </div>
              <p class="pn-sub">
                @if (d.costo_visible && r.inversion !== null) {
                  Se invirtieron {{ dinero(r.inversion) }} y han vendido {{ dinero(r.venta) }}.
                } @else {
                  Han vendido {{ dinero(r.venta) }}.
                }
                @if (r.venta_hoy > 0) { Hoy van {{ dinero(r.venta_hoy) }}. }
              </p>
            </section>
          }

          <div class="pn-filtros">
            <div class="pn-otros" role="group" aria-label="Otras vistas">
              <button type="button" class="pn-chip" [class.is-sel]="filtro() === 'seguimiento'"
                      [attr.aria-pressed]="filtro() === 'seguimiento'" (click)="filtro.set('seguimiento')">
                Todos en seguimiento <span class="pn-chip-n">{{ n(conteo('seguimiento')) }}</span>
              </button>
              @for (o of otros; track o.id) {
                <button type="button" class="pn-chip" [class.is-sel]="filtro() === o.id"
                        [attr.aria-pressed]="filtro() === o.id" (click)="filtro.set(o.id)">
                  {{ o.label }} <span class="pn-chip-n">{{ n(conteo(o.id)) }}</span>
                </button>
              }
            </div>
            <label class="pn-buscar">
              <span class="pn-sr">Buscar producto</span>
              <i class="pi pi-search" aria-hidden="true"></i>
              <input type="search" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                     placeholder="Buscar SKU, nombre, marca o proveedor" autocomplete="off" spellcheck="false" />
            </label>
          </div>

          <div class="pn-tabla dt-scope">
            <p-table [value]="filas()" dataKey="product_id" [paginator]="filas().length > 50" [rows]="50"
                     size="small" class="surf-table surf-table--sticky" styleClass="dt-stack">
              <ng-template #header>
                <tr>
                  <th scope="col">Producto</th>
                  <th scope="col">¿Volver a comprar?</th>
                  <th scope="col">Venta por semana</th>
                  <th scope="col" class="pn-num">Vendido</th>
                  @if (d.costo_visible) {
                    <th scope="col" class="pn-num" pTooltip="Real, sobre la venta sin impuestos. Debajo: de lista y sobre lo pagado.">Margen</th>
                  }
                  <th scope="col">30 · 60 · 90 días</th>
                  <th scope="col">Sucursales</th>
                  <th scope="col"><span class="pn-sr">Abrir</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr class="pn-fila" tabindex="0" role="button" [attr.aria-label]="'Ver ' + (f.nombre || f.sku) + ' por sucursal'"
                    (click)="abrir(f)" (keydown.enter)="abrir(f)" (keydown.space)="$event.preventDefault(); abrir(f)">
                  <td class="pn-c-prod dt-id" role="cell">
                    <div class="pn-prod">{{ f.nombre || 'Sin nombre en catálogo' }}</div>
                    <div class="pn-meta"><span class="pn-mono">{{ f.sku }}</span>@if (f.marca) { · {{ f.marca }} }</div>
                    <div class="pn-tags">
                      <span class="pn-tag pn-tag-nuevo">{{ etapa(f) }}</span>
                      @if (f.posible_recodificacion && !f.clasificacion) {
                        <span class="pn-tag pn-tag-warn" pTooltip="Otro producto dado de alta antes tiene el mismo código de barras">Posible recodificación</span>
                      }
                    </div>
                  </td>
                  <td class="pn-c-rec" role="cell" data-label="¿Volver a comprar?">
                    @if (f.recomendacion; as rec) {
                      <span [class]="'pn-pill pn-tono-' + verd(rec.veredicto).tono">
                        <i [class]="verd(rec.veredicto).icon" aria-hidden="true"></i>{{ verd(rec.veredicto).label }}
                      </span>
                      <div class="pn-motivo">{{ rec.motivos[0] }}</div>
                    } @else {
                      <span class="pn-pill pn-tono-muted">{{ f.motivo }}</span>
                    }
                  </td>
                  <td class="pn-c-spk" role="cell" data-label="Venta por semana">
                    @if (cerradas(f.semanas, f.dia); as sem) {
                      @if (sem.length > 1) {
                        <app-sparkline [data]="sem" [labels]="etiquetasSemanas(sem.length)" format="currency"
                                       [color]="colorVer(f)" class="pn-spk" />
                      } @else if (f.dia !== null) {
                        <span class="pn-meta">{{ sem.length ? 'Una semana completa' : 'Primera semana en curso' }}</span>
                      } @else {
                        <span class="pn-muted">—</span>
                      }
                    }
                    @if (f.venta_hoy > 0) {
                      <div class="pn-hoy"><span class="pn-punto" aria-hidden="true"></span>Hoy {{ dinero(f.venta_hoy) }}</div>
                      @if (textoUnidades(f.unidades_hoy); as u) { <div class="pn-meta pn-hoy-u">{{ u }}</div> }
                    }
                  </td>
                  <td class="pn-num dt-num" role="cell" data-label="Vendido">
                    @if (f.venta_total !== null) {
                      <div class="pn-mono pn-fuerte">{{ dinero(f.venta_total) }}</div>
                      @if (textoUnidades(f.unidades_vendidas); as u) {
                        <div class="pn-unid" [pTooltip]="tipUnidades(f)">{{ u }}</div>
                      } @else if (f.venta_total > 0) {
                        <div class="pn-meta" [pTooltip]="tipUnidades(f)">sólo en pesos</div>
                      }
                      @if (d.costo_visible) {
                        @if (f.venta_por_peso !== null) {
                          <div class="pn-barra" [attr.aria-label]="'Vendió ' + veces(f.venta_por_peso) + ' por cada peso invertido'">
                            <span [style.width.%]="barra(f.venta_por_peso)" [class.is-ok]="f.venta_por_peso >= 1"></span>
                          </div>
                          <div class="pn-meta">{{ veces(f.venta_por_peso) }} por $1 invertido</div>
                        } @else {
                          <div class="pn-meta">inversión no medida</div>
                        }
                      }
                    } @else {
                      <span class="pn-muted">—</span>
                    }
                  </td>
                  @if (d.costo_visible) {
                    <td class="pn-num pn-c-margen dt-num" role="cell" data-label="Margen">
                      @if (f.margenes; as mg) {
                        <div class="pn-mono pn-fuerte" [pTooltip]="mg.real.nota || ''">{{ margenTexto(mg.real.pct) }}</div>
                        <div class="pn-meta">lista {{ margenTexto(mg.lista.pct) }} · pagado {{ margenTexto(mg.pagado.pct) }}</div>
                      } @else {
                        <span class="pn-muted">—</span>
                      }
                    </td>
                  }
                  <td role="cell" data-label="30 · 60 · 90 días">
                    <div class="pn-hitos">
                      @for (h of hitos; track h) {
                        <span class="pn-hito" [class.is-curso]="!f.hitos[h].cerrado && hitoVisible(f.dia, h)"
                              [pTooltip]="tipHito(f, h)">
                          <small>{{ h }}d</small>
                          @if (!hitoVisible(f.dia, h) || f.estado === 'sin_movimiento') {
                            <b class="pn-muted">—</b>
                          } @else {
                            <b>{{ f.hitos[h].venta === null ? 'sin venta' : dineroCorto(f.hitos[h].venta) }}</b>
                          }
                        </span>
                      }
                    </div>
                  </td>
                  <td class="pn-c-plazas" role="cell" data-label="Sucursales">
                    @if (f.plazas_venta > 0 || f.plazas_con_existencia > 0) {
                      <div>Vende en {{ f.plazas_venta }}</div>
                      @if (f.agotado_en > 0) {
                        <div class="pn-agotado">Agotado en {{ f.agotado_en }}</div>
                      } @else {
                        <div class="pn-meta">Hay existencia en {{ f.plazas_con_existencia }}</div>
                      }
                      @if (f.mejor_plaza; as mp) {
                        <div class="pn-meta" pTooltip="La que más vende por día desde que le llegó">Mejor: {{ mp.nombre || mp.plaza }}</div>
                      }
                    } @else {
                      <span class="pn-muted">—</span>
                    }
                  </td>
                  <td class="pn-c-abrir dt-actions" role="cell"><i class="pi pi-chevron-right" aria-hidden="true"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td [attr.colspan]="d.costo_visible ? 8 : 7" class="pn-vacio">Ningún producto en esta vista.</td></tr>
              </ng-template>
            </p-table>
          </div>

          @if (d.cohortes.length) {
            <details class="pn-plegable">
              <summary>Inversión y venta por mes de lanzamiento</summary>
              <table class="pn-cohortes">
                <thead>
                  <tr>
                    <th scope="col">Mes</th>
                    <th scope="col" class="pn-num">Productos</th>
                    @if (d.costo_visible) { <th scope="col" class="pn-num">Inversión</th> }
                    <th scope="col" class="pn-num">Venta</th>
                    @if (d.costo_visible) { <th scope="col" class="pn-num">Venta por $1</th> }
                    <th scope="col" class="pn-num">Se volvieron a comprar</th>
                    <th scope="col" class="pn-num">Sin venta en su primer mes</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of d.cohortes; track c.mes) {
                    <tr>
                      <td>{{ mes(c.mes) }}</td>
                      <td class="pn-num pn-mono">{{ n(c.productos) }}</td>
                      @if (d.costo_visible) {
                        <td class="pn-num pn-mono">{{ c.inversion === null ? 'No medida' : dinero(c.inversion) }}</td>
                      }
                      <td class="pn-num pn-mono">{{ dinero(c.venta) }}</td>
                      @if (d.costo_visible) {
                        <td class="pn-num pn-mono">{{ c.venta_por_peso === null ? '—' : veces(c.venta_por_peso) }}</td>
                      }
                      <td class="pn-num pn-mono">{{ n(c.recomprados) }}</td>
                      <td class="pn-num pn-mono">{{ c.con_30_dias ? n(c.sin_venta_30) + ' de ' + n(c.con_30_dias) : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </details>
          }

          <details class="pn-plegable">
            <summary>Cómo se decide la recomendación</summary>
            <ul class="pn-criterio">
              <li><b>Aún es pronto</b> — antes del día {{ d.criterio.diasMinimos }}: hay muy poca venta para juzgar.</li>
              <li><b>No recomprar</b> — nunca se vendió, o lleva {{ d.criterio.sinVentaDias }} días o más sin venderse.</li>
              <li><b>Revisar</b> — la venta de las últimas 4 semanas cayó a menos del {{ pct(d.criterio.caidaMaxima) }} de las 4 anteriores,
                o se vendió menos de {{ d.criterio.diasConVentaSano }} de los últimos {{ d.criterio.ventana }} días.</li>
              <li><b>Recomprar</b> — se vende de forma sostenida y además se agotó en alguna sucursal que lo vende,
                ya no hay existencia, o ya vendió {{ veces(d.criterio.recuperadoAlto) }} por cada $1 invertido.</li>
              <li><b>Esperar</b> — se vende bien, pero todavía hay existencia y no ha recuperado lo invertido.</li>
            </ul>
            <p class="pn-meta">Es una propuesta del sistema; la decisión es de Compras. Mide rotación y recuperación de lo invertido
              (a precio de venta); no usa el margen. Los márgenes se muestran aparte, sin impuestos, al abrir cada producto.
              Cuenta sólo lo que registra Kepler: la venta de las tiendas y las entradas de mercancía. No incluye Wincaja.
              Un producto que sólo se ha movido en sucursales con menos de 90 días en Kepler no se puede medir todavía.</p>
          </details>
        }
      } @else if (cargando()) {
        <p class="pn-meta">Cargando…</p>
      } @else if (error()) {
        <p class="pn-error" role="alert">No se pudieron cargar los productos nuevos. Intenta de nuevo en un momento.</p>
      }

      <app-side-peek [open]="abierto() !== null" (openChange)="$event ? null : cerrar()" [width]="640"
                     [title]="abierto()?.nombre || abierto()?.sku || ''"
                     [subtitle]="subtitulo()">
        @if (abierto(); as f) {
          @if (det(); as dt) {
            <div class="pk">
              @if (dt.producto.recomendacion; as rec) {
                <section [class]="'pk-ver pn-tono-' + verd(rec.veredicto).tono">
                  <div class="pk-ver-t"><i [class]="verd(rec.veredicto).icon" aria-hidden="true"></i>{{ verd(rec.veredicto).label }}</div>
                  <ul>@for (m of rec.motivos; track m) { <li>{{ m }}</li> }</ul>
                </section>
              } @else {
                <section class="pk-ver pn-tono-muted"><div class="pk-ver-t">{{ dt.producto.motivo }}</div></section>
              }

              <section class="pk-bloque" aria-labelledby="pk-global">
                <h3 id="pk-global" class="pk-h">Comportamiento global</h3>
                <div class="pk-kpis">
                  @if (dt.producto.llegada; as ll) {
                    <div><span>Llegó a la empresa</span><b>{{ ll.fecha ? fecha(ll.fecha) : 'Sin compra' }}</b>
                      @if (sucursalesTexto(ll.sucursales); as s) { <small>a {{ s }}</small> }</div>
                  }
                  <div><span>Vendido</span><b>{{ dt.producto.venta_total === null ? '—' : dinero(dt.producto.venta_total) }}</b>
                    @if (textoUnidades(dt.producto.unidades_vendidas); as u) { <small>{{ u }}</small> }</div>
                  <div><span>Llegó en compras</span><b class="pk-txt">{{ textoUnidades(dt.producto.unidades_recibidas) || 'Sin compras en Kepler' }}</b></div>
                  @if (dt.costo_visible) {
                    <div><span>Invertido</span><b>{{ dt.producto.inversion_total === null ? 'No medido' : dinero(dt.producto.inversion_total) }}</b></div>
                    <div><span>Por $1 invertido</span><b>{{ dt.producto.venta_por_peso === null ? '—' : veces(dt.producto.venta_por_peso) }}</b></div>
                  }
                  <div><span>Días con venta (28)</span><b>{{ dt.producto.dias_con_venta_28 }} de 28</b></div>
                  <div><span>Última venta</span><b>{{ fecha(dt.producto.ultima_venta) }}</b></div>
                  <div><span>Hoy</span><b>{{ dinero(dt.producto.venta_hoy) }}</b>
                    @if (textoUnidades(dt.producto.unidades_hoy); as u) { <small>{{ u }}</small> }</div>
                </div>
                @if (dt.producto.llegada; as ll) {
                  @if (ll.antes; as an) {
                    <p class="pn-meta pk-aviso">{{ ll.fecha ? 'Antes de la compra ya había entrado' : 'No hay compra en Kepler: entró' }}
                      por {{ an.tipo }} el {{ fechaLarga(an.fecha) }}.</p>
                  }
                  @if (ll.fuente === 'compra_aplicada') {
                    <p class="pn-meta">La fecha de llegada es la de la compra aplicada: el kardex de Kepler no trae su entrada.</p>
                  }
                }
                @if (dt.producto.venta_sin_unidad > 0) {
                  <p class="pn-meta">{{ dinero(dt.producto.venta_sin_unidad) }} de la venta no traen la unidad de Kepler y van sólo en pesos.</p>
                }
                <p class="pn-meta">{{ tendenciaTexto(dt.producto.tendencia) }} · {{ recompraTexto(dt.producto) }}</p>
                @if (cerradas(dt.producto.semanas, dt.producto.dia); as sem) {
                  @if (sem.length > 1) {
                    <app-sparkline [data]="sem" [labels]="etiquetasSemanas(sem.length)"
                                   format="currency" [color]="colorVer(dt.producto)" class="pk-spk" />
                    <p class="pn-meta">Venta por semana completa desde el lanzamiento ({{ fecha(dt.producto.lanzamiento) }}).
                      La semana en curso no se grafica: todavía no termina.</p>
                  }
                }
                <table class="pk-hitos">
                  <thead><tr><th scope="col">Corte</th><th scope="col" class="pn-num">Vendido</th>
                    <th scope="col">Unidades vendidas</th>
                    @if (dt.costo_visible) { <th scope="col" class="pn-num">Invertido</th> }<th scope="col">Estado</th></tr></thead>
                  <tbody>
                    @for (h of hitos; track h) {
                      <tr>
                        <td>A {{ h }} días</td>
                        <td class="pn-num pn-mono">{{ !hitoVisible(dt.producto.dia, h) ? '—' : (dt.producto.hitos[h].venta === null ? 'sin venta' : dinero(dt.producto.hitos[h].venta)) }}</td>
                        <td class="pk-unid">{{ !hitoVisible(dt.producto.dia, h) ? '—' : (textoUnidades(dt.producto.hitos[h].unidades) || '—') }}</td>
                        @if (dt.costo_visible) {
                          <td class="pn-num pn-mono">{{ !hitoVisible(dt.producto.dia, h) ? '—' : (dt.producto.hitos[h].inversion === null ? 'no medida' : dinero(dt.producto.hitos[h].inversion)) }}</td>
                        }
                        <td>{{ dt.producto.hitos[h].cerrado ? 'Cerrado' : (hitoVisible(dt.producto.dia, h) ? 'En curso' : 'Todavía no llega') }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>

              @if (dt.costo_visible && dt.producto.margenes; as mg) {
                <section class="pk-bloque" aria-labelledby="pk-margenes">
                  <h3 id="pk-margenes" class="pk-h">Márgenes</h3>
                  <div class="pk-margenes">
                    @for (t of tiposMargen; track t.id) {
                      <div class="pk-margen">
                        <span class="pk-margen-t">{{ t.titulo }}</span>
                        <b class="pn-mono" [class.pn-muted]="mg[t.id].pct === null">{{ margenTexto(mg[t.id].pct) }}</b>
                        <small>{{ t.pregunta }}</small>
                        @if (mg[t.id].utilidad !== null) {
                          <small class="pk-margen-u">{{ dinero(mg[t.id].utilidad) }} de margen</small>
                        }
                        @if (mg[t.id].nota) { <small class="pk-nota">{{ mg[t.id].nota }}</small> }
                      </div>
                    }
                  </div>
                  <p class="pn-meta">Sobre la venta sin IVA ni IEPS ({{ dinero(mg.venta_neta) }}) hasta el {{ fecha(vispera(dt.frescura.corte)) }}; lo de hoy no entra.
                    @if (mg.costo_pagado; as cp) { En sus compras se pagó {{ veces(cp.por_unidad) }} por {{ unidadUna(cp.unidad) }}. }
                    No descuenta las notas de crédito ni los apoyos del proveedor: por producto todavía no se pueden repartir.</p>
                </section>
              }

              @if (ordenMovimiento(dt.plazas); as rk) {
                @if (rk.length) {
                  <section class="pk-bloque" aria-labelledby="pk-donde">
                    <h3 id="pk-donde" class="pk-h">¿Dónde se mueve mejor?</h3>
                    <div class="dt-scope">
                    <table class="pk-hitos pk-rank dt-stack">
                      <thead><tr>
                        <th scope="col">Lugar</th><th scope="col">Sucursal</th>
                        <th scope="col" class="pn-num">Venta por día</th>
                        <th scope="col">Vendido</th><th scope="col">Existencia hoy</th>
                        <th scope="col" class="pn-num">Vendido de lo que llegó</th>
                        @if (dt.costo_visible) { <th scope="col" class="pn-num">Margen real</th> }
                      </tr></thead>
                      <tbody>
                        @for (p of rk; track p.plaza) {
                          <tr [class.is-mejor]="p.movimiento.lugar === 1">
                            <td role="cell" data-label="Lugar">{{ p.movimiento.lugar === null ? 'Aún no' : p.movimiento.lugar }}</td>
                            <td class="dt-id" role="cell">{{ p.nombre || ('Sucursal ' + p.plaza) }}
                              @if (p.movimiento.dias !== null) { <span class="pn-meta pk-dias">{{ p.movimiento.dias }} días</span> }</td>
                            <td class="pn-num pn-mono dt-num" role="cell" data-label="Venta por día">{{ dinero(p.movimiento.venta_neta_dia) }}</td>
                            <td class="pk-unid" role="cell" data-label="Vendido">{{ textoUnidades(p.unidades_vendidas) || (p.venta_sin_unidad > 0 ? 'sólo en pesos' : '—') }}</td>
                            <td class="pk-unid" role="cell" data-label="Existencia hoy" [class.pn-agotado]="p.existencia !== null && p.existencia <= 0">{{ existenciaTexto(p) }}</td>
                            <td class="pn-num pn-mono dt-num" role="cell" data-label="Vendido de lo que llegó">{{ p.movimiento.desplazado === null ? '—' : pct(p.movimiento.desplazado) }}</td>
                            @if (dt.costo_visible) {
                              <td class="pn-num pn-mono dt-num" role="cell" data-label="Margen real" [pTooltip]="p.margenes?.real?.nota || ''">{{ margenTexto(p.margenes?.real?.pct) }}</td>
                            }
                          </tr>
                        }
                      </tbody>
                    </table>
                    </div>
                    <p class="pn-meta">Venta sin impuestos por día desde que el producto llegó a cada sucursal, hasta el {{ fecha(vispera(dt.frescura.corte)) }}.
                      Una sucursal con menos de {{ diasMinimosSucursal }} días todavía no compite: una sola venta la pondría arriba.
                      "Vendido de lo que llegó" compara lo vendido con lo vendido más la existencia de hoy, en la unidad de la ficha.</p>
                  </section>
                }
              }

              <section class="pk-bloque" aria-labelledby="pk-plazas">
                <h3 id="pk-plazas" class="pk-h">Por sucursal</h3>
                @if (!dt.plazas.length) {
                  <p class="pn-meta">Todavía no llega a ninguna sucursal.</p>
                }
                @if (ordenReparto(dt.plazas); as rp) {
                  @if (rp.length) {
                    <div class="pk-reparto">
                      <p class="pk-reparto-t">Nos llegaron <b>{{ textoUnidades(dt.producto.unidades_recibidas) || 'sin compras en Kepler' }}</b> en compras@if (dt.producto.llegada?.fecha) {, la primera el {{ fecha(dt.producto.llegada!.fecha) }}}. Así se repartió:</p>
                      <div class="dt-scope">
                      <table class="pk-hitos pk-repartot dt-stack">
                        <thead><tr>
                          <th scope="col">Sucursal</th><th scope="col">Compró</th><th scope="col">Le llegó de otra</th>
                          <th scope="col">Mandó a otras</th><th scope="col">Mandó a rutas</th><th scope="col">Existencia hoy</th>
                        </tr></thead>
                        <tbody>
                          @for (p of rp; track p.plaza) {
                            <tr>
                              <td class="dt-id" role="cell">{{ p.nombre || ('Sucursal ' + p.plaza) }}</td>
                              <td class="pk-unid" role="cell" data-label="Compró">{{ textoUnidades(p.unidades_recibidas) || '—' }}</td>
                              <td class="pk-unid" role="cell" data-label="Le llegó de otra">{{ textoUnidades(p.recibido_traspaso) || '—' }}</td>
                              <td class="pk-unid" role="cell" data-label="Mandó a otras">{{ textoUnidades(p.enviado_sucursales) || '—' }}</td>
                              <td class="pk-unid" role="cell" data-label="Mandó a rutas">{{ textoUnidades(p.enviado_rutas) || '—' }}</td>
                              <td class="pk-unid" role="cell" data-label="Existencia hoy" [class.pn-agotado]="p.existencia !== null && p.existencia <= 0">{{ existenciaTexto(p) }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                      </div>
                      <p class="pn-meta">Compró = sus entradas de compra. Le llegó de otra = traspasos recibidos de otra sucursal. Mandó = traspasos
                        a otras sucursales y cargas a camión de ruta. Las remisiones a clientes de telemarketing no están aquí: se facturan y ya
                        cuentan como venta. Cada cantidad, en la unidad en que la registró Kepler.</p>
                    </div>
                  }
                }
                @for (p of dt.plazas; track p.plaza) {
                  <article class="pk-plaza">
                    <header>
                      <div>
                        <b>{{ p.nombre || ('Sucursal ' + p.plaza) }}</b>
                        <span class="pn-meta"> · {{ p.plaza }}{{ p.dia !== null ? ' · día ' + p.dia : '' }}</span>
                      </div>
                      <span [class]="'pn-pill pn-tono-' + verd(p.recomendacion.veredicto).tono">
                        <i [class]="verd(p.recomendacion.veredicto).icon" aria-hidden="true"></i>{{ verd(p.recomendacion.veredicto).label }}
                      </span>
                    </header>
                    <div class="pk-plaza-cuerpo">
                      <div class="pk-plaza-datos">
                        <div><span>Vendido</span><b>{{ dinero(p.venta_total) }}</b>
                          @if (textoUnidades(p.unidades_vendidas); as u) { <small>{{ u }}</small> }
                          @else if (p.venta_sin_unidad > 0) { <small>sólo en pesos</small> }</div>
                        <div><span>Últimas 4 semanas</span><b>{{ dinero(p.venta_28) }}</b></div>
                        <div><span>Existencia hoy</span><b class="pk-txt" [class.pn-agotado]="p.existencia !== null && p.existencia <= 0">{{ existenciaTexto(p) }}</b></div>
                        <div><span>Última venta</span><b>{{ fecha(p.ultima_venta) }}</b></div>
                        @if (dt.costo_visible) {
                          <div><span>Invertido</span><b>{{ p.inversion_total === null ? 'No medido' : dinero(p.inversion_total) }}</b></div>
                          <div><span>Margen lista · real · pagado</span><b>{{ tresMargenes(p.margenes) }}</b></div>
                        }
                        <div><span>Compró</span><b class="pk-txt">{{ textoUnidades(p.unidades_recibidas) || 'Sin compras en Kepler' }}</b></div>
                        @if (textoUnidades(p.recibido_traspaso); as u) {
                          <div><span>Le llegó de otra sucursal</span><b class="pk-txt">{{ u }}</b></div>
                        }
                        @if (textoUnidades(p.enviado_sucursales); as u) {
                          <div><span>Mandó a otras sucursales</span><b class="pk-txt">{{ u }}</b></div>
                        }
                        @if (textoUnidades(p.enviado_rutas); as u) {
                          <div><span>Mandó a rutas</span><b class="pk-txt">{{ u }}</b></div>
                        }
                        <div><span>Recompra</span><b>{{ p.primera_recompra ? fecha(p.primera_recompra) : 'Todavía no' }}</b></div>
                      </div>
                      @if (cerradas(p.semanas, p.dia); as sem) {
                        @if (sem.length > 1) {
                          <app-sparkline [data]="sem" [labels]="etiquetasSemanas(sem.length)" format="currency"
                                         [color]="colorTono(verd(p.recomendacion.veredicto).tono)" class="pk-spk-mini" />
                        }
                      }
                    </div>
                    <p class="pn-meta">{{ p.recomendacion.motivos.join(' · ') }}@if (p.venta_hoy > 0) { · Hoy {{ dinero(p.venta_hoy) }}@if (textoUnidades(p.unidades_hoy); as u) { ({{ u }}) } }</p>
                  </article>
                }
              </section>

              <p class="pn-meta">Hoy en vivo al {{ hora(dt.frescura.en_vivo_al) }} · días anteriores al {{ hora(dt.frescura.historia_al) }}.
                Sólo Kepler: venta de las tiendas y entradas; sin Wincaja. Las unidades son las que registró Kepler en cada
                venta y entrada (caja, paquete, pieza), sin convertir; la existencia, en la unidad de la ficha de cada sucursal.</p>
            </div>
          } @else if (detError()) {
            <p class="pn-error" role="alert">No se pudo cargar el detalle por sucursal.</p>
          } @else {
            <p class="pn-meta">Cargando sucursales…</p>
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pn { display: flex; flex-direction: column; gap: 1rem; }
    .pn-aviso { display: flex; flex-direction: column; gap: .25rem; background: var(--warn-soft-bg); border: 1px solid var(--c-divider);
      border-radius: 10px; padding: .875rem 1.125rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .pn-vivo { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-vivo-t { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-punto { display: inline-block; width: .5rem; height: .5rem; border-radius: 999px; background: var(--ok-fg); flex: none; }
    .pn-punto.is-off { background: var(--c-text-3); }
    .pn-respuesta { display: flex; flex-direction: column; gap: .75rem; background: var(--c-surface-1);
      border: 1px solid var(--c-divider); border-radius: 12px; padding: 1.125rem 1.25rem; }
    .pn-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .pn-sub { margin: 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .pn-veredictos { display: flex; flex-wrap: wrap; gap: .5rem; }
    .pn-ver { display: inline-flex; align-items: center; gap: .45rem; min-height: 2.5rem; padding: 0 .9rem;
      border: 1px solid var(--c-divider); border-radius: 10px; background: var(--c-surface-1); color: var(--c-text-1);
      font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .pn-ver strong { font-family: var(--font-mono); font-size: var(--fs-sm); }
    .pn-ver:hover { background: var(--c-surface-2); }
    .pn-ver.is-sel { border-color: var(--action); background: var(--c-surface-2); }
    .pn-ver:focus-visible, .pn-chip:focus-visible, .pn-fila:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pn-tono-ok i, .pn-tono-ok strong { color: var(--ok-fg); }
    .pn-tono-warn i, .pn-tono-warn strong { color: var(--warn-fg); }
    .pn-tono-bad i, .pn-tono-bad strong { color: var(--bad-fg); }
    .pn-tono-info i, .pn-tono-info strong { color: var(--c-text-2); }
    .pn-tono-muted i, .pn-tono-muted strong { color: var(--c-text-3); }
    .pn-filtros { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; }
    .pn-otros { display: flex; flex-wrap: wrap; gap: .4rem; }
    .pn-chip { display: inline-flex; align-items: center; gap: .4rem; min-height: 2.25rem; padding: 0 .75rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .pn-chip:hover { background: var(--c-surface-2); }
    .pn-chip.is-sel { border-color: var(--action); background: var(--c-surface-2); font-weight: var(--fw-bold); }
    .pn-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-buscar { position: relative; display: inline-flex; align-items: center; }
    .pn-buscar i { position: absolute; left: .65rem; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pn-buscar input { height: 2.25rem; width: 19rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem 0 1.9rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .pn-buscar input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pn-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .pn-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 12px; overflow-x: auto; }
    .pn-fila { cursor: pointer; }
    .pn-fila:hover > td { background: var(--c-surface-2); }
    .pn-fila > td { vertical-align: middle; padding-top: .7rem; padding-bottom: .7rem; }
    .pn-c-prod { min-width: 15rem; }
    .pn-c-rec { min-width: 13rem; max-width: 18rem; }
    .pn-c-spk { width: 9.5rem; }
    .pn-c-plazas { font-size: var(--fs-sm); white-space: nowrap; }
    .pn-c-abrir { width: 2rem; color: var(--c-text-3); }
    .pn-num { text-align: right; white-space: nowrap; }
    .pn-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pn-fuerte { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-muted { color: var(--c-text-3); }
    .pn-prod { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pn-meta { margin: 0; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pn-tags { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .3rem; }
    .pn-tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: var(--fs-xs);
      font-weight: var(--fw-bold); white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-2); }
    .pn-tag-nuevo { background: var(--c-surface-2); color: var(--c-text-1); border: 1px solid var(--action); }
    .pn-tag-warn { background: var(--warn-soft-bg); color: var(--c-text-1); }
    .pn-pill { display: inline-flex; align-items: center; gap: .35rem; padding: .2rem .6rem; border-radius: 999px;
      font-size: var(--fs-xs); font-weight: var(--fw-bold); white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-1); }
    .pn-pill.pn-tono-ok { background: var(--ok-soft-bg); }
    .pn-pill.pn-tono-warn { background: var(--warn-soft-bg); }
    .pn-pill.pn-tono-bad { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .pn-pill.pn-tono-muted { color: var(--c-text-2); }
    .pn-motivo { margin-top: .3rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.35; }
    .pn-spk { --spk-h: 34px; }
    .pn-hoy { display: inline-flex; align-items: center; gap: .3rem; margin-top: .2rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-barra { height: .3rem; border-radius: 999px; background: var(--c-surface-2); margin: .3rem 0 .15rem auto; width: 6rem; overflow: hidden; }
    .pn-barra span { display: block; height: 100%; background: var(--warn-fg); border-radius: 999px; }
    .pn-barra span.is-ok { background: var(--ok-fg); }
    .pn-hitos { display: flex; gap: .35rem; }
    .pn-hito { display: flex; flex-direction: column; align-items: flex-start; min-width: 4.2rem; padding: .25rem .45rem;
      border: 1px solid var(--c-divider); border-radius: 8px; }
    .pn-hito small { font-size: var(--fs-micro); color: var(--c-text-3); }
    .pn-hito b { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-1); white-space: nowrap; }
    .pn-hito.is-curso { border-style: dashed; border-color: var(--warn-fg); }
    .pn-agotado { color: var(--bad-fg); font-weight: var(--fw-bold); }
    .pn-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .pn-plegable { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 12px; padding: .75rem 1rem; }
    .pn-plegable summary { cursor: pointer; font-weight: var(--fw-bold); font-size: var(--fs-sm); color: var(--c-text-1); }
    .pn-plegable summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pn-cohortes { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); margin-top: .75rem; }
    .pn-cohortes th, .pn-cohortes td { padding: .45rem .75rem; border-bottom: 1px solid var(--c-divider); text-align: left; }
    .pn-cohortes th { font-size: var(--fs-xs); color: var(--c-text-2); font-weight: var(--fw-bold); }
    .pn-cohortes th.pn-num, .pn-cohortes td.pn-num { text-align: right; }
    .pn-criterio { margin: .75rem 0 .5rem; padding-left: 1.1rem; font-size: var(--fs-sm); color: var(--c-text-1); line-height: 1.5; }
    .pn-error { color: var(--bad-fg); font-size: var(--fs-sm); }
    .pk { display: flex; flex-direction: column; gap: 1rem; }
    .pk-ver { border: 1px solid var(--c-divider); border-left-width: 4px; border-radius: 10px; padding: .75rem 1rem; background: var(--c-surface-1); }
    .pk-ver.pn-tono-ok { border-left-color: var(--ok-fg); }
    .pk-ver.pn-tono-warn { border-left-color: var(--warn-fg); }
    .pk-ver.pn-tono-bad { border-left-color: var(--bad-fg); }
    .pk-ver.pn-tono-info, .pk-ver.pn-tono-muted { border-left-color: var(--c-text-3); }
    .pk-ver-t { display: flex; align-items: center; gap: .45rem; font-weight: var(--fw-bold); font-size: var(--fs-lg); color: var(--c-text-1); }
    .pk-ver ul { margin: .4rem 0 0; padding-left: 1.1rem; font-size: var(--fs-sm); color: var(--c-text-2); }
    .pk-bloque { display: flex; flex-direction: column; gap: .6rem; }
    .pk-h { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); text-transform: uppercase; letter-spacing: .04em; }
    .pk-kpis, .pk-plaza-datos { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: .5rem .75rem; }
    .pk-kpis div, .pk-plaza-datos div { display: flex; flex-direction: column; gap: .1rem; }
    .pk-kpis span, .pk-plaza-datos span { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pk-kpis b, .pk-plaza-datos b { font-size: var(--fs-sm); color: var(--c-text-1); font-family: var(--font-mono); }
    .pk-kpis b.pk-txt, .pk-plaza-datos b.pk-txt { font-family: inherit; font-weight: 600; }
    .pk-kpis small, .pk-plaza-datos small { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pn-unid { margin-top: .15rem; font-size: var(--fs-xs); color: var(--c-text-2); white-space: normal; }
    .pn-hoy-u { padding-left: .7rem; }
    .pk-spk { --spk-h: 64px; }
    .pk-spk-mini { --spk-h: 40px; }
    .pk-hitos { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .pk-hitos th, .pk-hitos td { padding: .35rem .5rem; border-bottom: 1px solid var(--c-divider); text-align: left; }
    .pk-hitos th { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pk-hitos th.pn-num, .pk-hitos td.pn-num { text-align: right; }
    .pn-c-margen { min-width: 7.5rem; }
    .pk-margenes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem; }
    .pk-margen { display: flex; flex-direction: column; gap: .2rem; border: 1px solid var(--c-divider); border-radius: 10px;
      padding: .65rem .75rem; background: var(--c-surface-1); }
    .pk-margen-t { font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-2); }
    .pk-margen b { font-size: var(--fs-lg); color: var(--c-text-1); }
    .pk-margen small { font-size: var(--fs-xs); color: var(--c-text-3); line-height: 1.35; }
    .pk-margen small.pk-margen-u { color: var(--c-text-2); }
    .pk-margen small.pk-nota { color: var(--warn-fg); }
    .pk-rank tr.is-mejor > td { background: var(--ok-soft-bg); font-weight: var(--fw-bold); }
    .pk-unid { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pk-dias { display: block; }
    .pk-aviso { color: var(--warn-fg); }
    .pk-reparto { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--c-divider); border-radius: 10px;
      padding: .7rem .85rem; background: var(--c-surface-1); }
    .pk-reparto-t { margin: 0; font-size: var(--fs-sm); color: var(--c-text-1); }
    .pk-plaza { border: 1px solid var(--c-divider); border-radius: 10px; padding: .7rem .85rem; display: flex; flex-direction: column; gap: .5rem; }
    .pk-plaza header { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .pk-plaza-cuerpo { display: grid; grid-template-columns: minmax(0, 1fr) 8rem; gap: .75rem; align-items: center; }
    @media (max-width: 48rem) {
      .pn-buscar, .pn-buscar input { width: 100%; }
      .pk-plaza-cuerpo { grid-template-columns: 1fr; }
      .pk-margenes { grid-template-columns: 1fr; }
    }
  `],
})
export class ComprasCatalogoNuevosComponent {
  readonly tabs = CATALOGO_TABS;
  readonly otros = OTROS;
  readonly ordenVeredictos = ORDEN_VEREDICTOS;
  readonly hitos: HitoNuevo[] = [30, 60, 90];
  readonly hitoVisible = hitoVisible;
  readonly existenciaTexto = existenciaTexto;
  readonly textoUnidades = textoUnidades;
  readonly tendenciaTexto = tendenciaTexto;
  readonly tiposMargen = TIPOS_MARGEN;
  readonly margenTexto = margenTexto;
  readonly tresMargenes = tresMargenes;
  readonly ordenMovimiento = ordenMovimiento;
  readonly ordenReparto = ordenReparto;
  readonly sucursalesTexto = sucursalesTexto;
  /** El mismo umbral que usa el servidor para dejar competir a una sucursal (`CRITERIO_SUCURSAL`). */
  readonly diasMinimosSucursal = 7;

  private readonly api = inject(ProductosNuevosService);

  readonly filtro = signal<FiltroNuevos>('seguimiento');
  readonly busqueda = signal('');

  private readonly recarga = signal(0);
  private readonly res = rxResource({
    params: () => this.recarga(),
    stream: () => this.api.listar(),
  });

  /** El producto abierto en el panel lateral. */
  readonly abierto = signal<ProductoNuevo | null>(null);
  private readonly detRes = rxResource({
    params: () => {
      const f = this.abierto();
      return f ? { id: f.product_id, v: this.recarga() } : undefined;
    },
    stream: ({ params }) => (params ? this.api.detalle(params.id) : of(null)),
  });
  /** Sólo el detalle del producto que está abierto: al cambiar de producto no se ve el anterior. */
  readonly det = computed(() => {
    const d = this.detRes.error() ? null : this.detRes.value() ?? null;
    return d && d.producto.product_id === this.abierto()?.product_id ? d : null;
  });
  readonly detError = computed(() => !!this.detRes.error());

  /**
   * El último dato bueno se conserva mientras se recarga o si una recarga falla: refrescar cada
   * minuto no puede dejar la pantalla en blanco ni pintar ceros. El error se DICE en la franja.
   */
  readonly datos = linkedSignal<RespuestaNuevos | undefined, RespuestaNuevos | undefined>({
    // Primero el error: leer el valor de un recurso en error LANZA, y la pantalla reventaría en
    // vez de decir "sin conexión". Mientras recarga o si falla, `nuevo` es undefined y se queda
    // el anterior. linkedSignal y no un campo plano: un computed que lee un campo no se entera
    // de que cambió.
    source: () => (this.res.error() ? undefined : this.res.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value,
  });
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => !!this.res.error());

  readonly filas = computed(() => {
    const d = this.datos();
    if (!d) return [];
    const f = this.filtro();
    const q = this.busqueda();
    return d.filas.filter((x) => pasaFiltro(x, f) && pasaBusqueda(x, q));
  });

  readonly subtitulo = computed(() => {
    const f = this.abierto();
    if (!f) return null;
    return [f.sku, f.marca, f.proveedor, f.lanzamiento ? 'lanzado el ' + fechaCorta(f.lanzamiento) : null]
      .filter(Boolean).join(' · ');
  });

  constructor() {
    // En vivo: se vuelve a pedir cada minuto, sólo con la pestaña a la vista.
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.recargar();
    }, REFRESCO_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  recargar(): void {
    this.recarga.update((n) => n + 1);
  }

  alternar(v: VeredictoNuevo): void {
    this.filtro.set(this.filtro() === v ? 'seguimiento' : v);
  }

  conteo(f: FiltroNuevos): number {
    return (this.datos()?.filas ?? []).filter((x) => pasaFiltro(x, f)).length;
  }

  abrir(f: ProductoNuevo): void {
    this.abierto.set(f);
  }

  cerrar(): void {
    this.abierto.set(null);
  }

  verd(v: VeredictoNuevo) {
    return VEREDICTOS[v];
  }

  colorTono(t: string): string {
    return t === 'ok' ? 'var(--ok-fg)' : t === 'bad' ? 'var(--bad-fg)' : t === 'warn' ? 'var(--warn-fg)' : 'var(--c-text-3)';
  }

  colorVer(f: ProductoNuevo): string {
    return f.recomendacion ? this.colorTono(VEREDICTOS[f.recomendacion.veredicto].tono) : 'var(--c-text-3)';
  }

  etiquetasSemanas(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `Semana ${i + 1}`);
  }

  cerradas(semanas: number[], dia: number | null): number[] {
    return semanasCerradas(semanas, dia);
  }

  etapa(f: ProductoNuevo): string {
    if (f.dia === null) return 'Nuevo · sin movimiento';
    if (f.etapa === 'graduado') return `Cumplió 90 días · día ${f.dia}`;
    return `Nuevo · día ${f.dia}`;
  }

  tipHito(f: ProductoNuevo, h: HitoNuevo): string {
    if (!hitoVisible(f.dia, h)) return 'Todavía no llega';
    const x = f.hitos[h];
    const partes = [x.cerrado ? 'Cerrado' : 'En curso'];
    if (this.datos()?.costo_visible) partes.push(x.inversion === null ? 'inversión no medida' : 'invertido ' + this.dinero(x.inversion));
    return partes.join(' · ');
  }

  /** De dónde salen las unidades, y cuánto de la venta no las trae. */
  tipUnidades(f: ProductoNuevo): string {
    const base = 'Tal como lo registró Kepler en cada venta, sin convertir.';
    return f.venta_sin_unidad > 0
      ? `${base} ${this.dinero(f.venta_sin_unidad)} no traen la unidad de Kepler y van sólo en pesos.`
      : base;
  }

  recompraTexto(f: ProductoNuevo): string {
    if (f.dia_recompra !== null) return `Se volvió a comprar el día ${f.dia_recompra}`;
    if (f.entradas === 0) return 'Sin entradas en Kepler: la recompra no se puede medir';
    return 'Todavía no se vuelve a comprar';
  }

  /** La barra de "vendido por $1": llena en $1.50 para que pasar el $1 se note. */
  barra(v: number): number {
    return Math.max(4, Math.min(100, (v / 1.5) * 100));
  }

  fecha(iso: string | null): string {
    return fechaCorta(iso);
  }

  /** Fecha con año ("29 ene 2026"): para entradas que pueden ser de otro año. */
  fechaLarga(iso: string | null): string {
    if (!iso) return '—';
    const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(t)
      ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(t)
      : '—';
  }

  /** El día anterior a `iso` (`YYYY-MM-DD`): el último día que entra en la historia. */
  vispera(iso: string | null): string | null {
    if (!iso) return null;
    const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : null;
  }

  /** "pieza", "caja"…; un rótulo que no se conoce, tal cual. */
  unidadUna(u: string): string {
    const leg = unidadLegible(u);
    return leg.conocida ? leg.singular : u;
  }

  hora(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
  }

  mes(m: string): string {
    const t = Date.parse(`${m}-01T00:00:00Z`);
    return Number.isFinite(t)
      ? new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(t)
      : m;
  }

  dinero(v: number | null): string {
    if (v === null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(v);
  }

  dineroCorto(v: number): string {
    if (Math.abs(v) >= 10_000) return `$${(v / 1000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} mil`;
    return this.dinero(v);
  }

  veces(v: number): string {
    return `$${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
  }

  pct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  n(v: number): string {
    return new Intl.NumberFormat('es-MX').format(v);
  }
}
