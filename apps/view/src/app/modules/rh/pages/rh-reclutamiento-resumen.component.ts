import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { HR_TALENT_SIN_CIUDAD, type HrResumenReclutamientoDto, type HrTalentEtapa, type HrTiempoPorEtapaDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { ETAPAS, ETAPAS_DEL_FLUJO, contraMeta, duracion } from '../reclutamiento-formato';
import { rhError } from '../rh.service';

/** Un paso del embudo: cuántos hay hoy y cómo se reparten (dentro de la meta · fuera de meta · sin moverse). */
export interface PasoResumen {
  id: HrTalentEtapa;
  corto: string;
  label: string;
  meta: string | null;
  total: number;
  fuera: number;
  rezago: number;
  dentro: number;
}

/**
 * `[RH.13.6]` Los cuatro pasos del flujo, con su reparto. `dentro + fuera + rezago = total` siempre: `fuera_de_meta`
 * cuenta sólo entre los que se mueven (`total - rezago`), así que lo que queda está dentro de su meta.
 */
export function pasosDe(d: HrResumenReclutamientoDto | null): PasoResumen[] {
  if (!d) return [];
  return ETAPAS_DEL_FLUJO.map((e) => {
    const x = d.etapas.find((y) => y.etapa === e.id);
    const total = x?.total ?? 0;
    const rezago = Math.min(total, x?.rezago ?? 0);
    const fuera = Math.min(total - rezago, x?.fuera_de_meta ?? 0);
    return { id: e.id, corto: e.corto, label: e.label, meta: e.slaHoras != null ? duracion(e.slaHoras) : null, total, fuera, rezago, dentro: total - rezago - fuera };
  });
}

/** Una fila de «¿Cuánto tarda cada paso?»: el promedio y la meta como porcentaje de la misma escala, para dibujarlos. */
export interface TiempoFila {
  etapa: string;
  nombre: string;
  n: number;
  promedio: string;
  rango: string;
  meta: string | null;
  pasa: boolean | null;
  pctPromedio: number;
  pctMeta: number | null;
}

export function tiemposDe(fases: readonly HrTiempoPorEtapaDto[]): TiempoFila[] {
  const orden = (id: string) => { const i = ETAPAS.findIndex((e) => e.id === id); return i < 0 ? 99 : i; };
  const filas = [...fases].sort((a, b) => orden(a.etapa) - orden(b.etapa));
  // La escala es la MISMA para todas las barras: el mayor entre promedios y metas, con aire. El máximo de cada paso no
  // entra: un caso de 10 días aplastaría todas las barras contra la izquierda.
  const tope = Math.max(1, ...filas.map((f) => Math.max(f.avg_horas, contraMeta(f).meta ?? 0))) * 1.15;
  const pct = (h: number) => Math.max(0, Math.min(100, Math.round((h / tope) * 1000) / 10));
  return filas.map((f) => {
    const m = contraMeta(f);
    const i = orden(f.etapa);
    const v = ETAPAS[i];
    return {
      etapa: f.etapa,
      nombre: v ? (i < ETAPAS_DEL_FLUJO.length ? `${i + 1} · ${v.corto}` : v.corto) : f.etapa,
      n: f.n,
      promedio: duracion(f.avg_horas),
      rango: `de ${duracion(f.min_horas)} a ${duracion(f.max_horas)}`,
      meta: m.meta == null ? null : duracion(m.meta),
      pasa: m.pasa,
      pctPromedio: pct(f.avg_horas),
      pctMeta: m.meta == null ? null : pct(m.meta),
    };
  });
}

/**
 * Fase RH · `[RH.8.1]` — Resumen del reclutamiento (`/rh/reclutamiento/resumen`): el «concentrado» de Mega Talento.
 *
 * `[RH.13.6]` Contesta UNA pregunta: «¿dónde se está atorando el proceso?». Por eso abre con el veredicto (el paso con más
 * gente fuera de su meta) y el embudo de los cuatro pasos con su reparto; debajo, de qué ciudad son, y al final cuánto
 * tarda cada paso (antes vivía en Revisiones, que ahora sólo trae registros por corregir).
 *
 * Cada número lleva a Candidatos ya filtrado por esa etapa y esa ciudad, y la lista cuenta lo mismo que la celda (lo
 * prueba `talent-resumen.db.spec`). La ciudad es la que reconoce el bot en lo que escribió la persona; lo que no se
 * reconoce va a «sin ciudad reconocida» y se dice cuántos y por qué.
 */
@Component({
  selector: 'app-rh-reclutamiento-resumen',
  standalone: true,
  imports: [RouterLink, ButtonModule, TableModule, LoadStateComponent, FreshnessPillComponent, RhReclutamientoMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rr-page">
      <app-rh-reclutamiento-marco subtitulo="Cuántos hay en cada paso, cuántos van fuera de su meta y de qué ciudad son.">
        <div acciones class="rr-acc">
          <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        </div>
      </app-rh-reclutamiento-marco>

      <app-load-state [loading]="loading() && !datos()" [error]="error()" (retry)="cargar()">
        @if (datos(); as d) {
          <section class="rr-sec" aria-labelledby="rr-t-pasos">
            <h2 id="rr-t-pasos" class="rr-veredicto">
              @if (peor(); as p) {
                Donde más se atora: <b>{{ p.corto }}</b>, con {{ p.fuera }} fuera de su meta de {{ p.meta }}.
              } @else {
                Todos los pasos van dentro de su meta.
              }
            </h2>
            <nav class="rr-embudo" aria-label="Candidatos por paso">
              <div class="rr-grupo rr-flujo" role="group" aria-label="Pasos del proceso, en orden">
                @for (p of pasos(); track p.id) {
                  <a class="rr-paso" [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', stage: p.id }"
                     [attr.aria-label]="avisoPaso(p, d.rezago_dias)">
                    <span class="rr-paso-l">{{ p.corto }}@if (p.meta) { <small>meta {{ p.meta }}</small> }</span>
                    <span class="rr-paso-n">{{ p.total }}</span>
                    <span class="rr-barra" aria-hidden="true">
                      @if (p.dentro) { <i class="dentro" [style.flex-grow]="p.dentro"></i> }
                      @if (p.fuera) { <i class="fuera" [style.flex-grow]="p.fuera"></i> }
                      @if (p.rezago) { <i class="rezago" [style.flex-grow]="p.rezago"></i> }
                    </span>
                    <span class="rr-paso-d">
                      @if (!p.total) {
                        <span>Nadie en este paso</span>
                      } @else if (!p.fuera && !p.rezago) {
                        <span class="rr-d dentro">Todos dentro de la meta</span>
                      } @else {
                        @if (p.fuera) { <span class="rr-d fuera"><b>{{ p.fuera }}</b> fuera de meta</span> }
                        @if (p.rezago) { <span class="rr-d rezago"><b>{{ p.rezago }}</b> sin moverse +{{ d.rezago_dias }} días</span> }
                      }
                    </span>
                  </a>
                }
              </div>
              <div class="rr-grupo rr-fin" role="group" aria-label="Ya terminaron">
                @for (e of fin(); track e.id) {
                  <a class="rr-paso" [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', stage: e.id }"
                     [attr.aria-label]="'Ver los ' + e.total + ' ' + e.label.toLowerCase()">
                    <span class="rr-paso-l">{{ e.corto }}</span>
                    <span class="rr-paso-n">{{ e.total }}</span>
                    <span class="rr-paso-d"><span>ya terminaron</span></span>
                  </a>
                }
              </div>
            </nav>
          </section>

          <section class="rr-card" aria-labelledby="rr-t-ciudad">
            <header class="rr-sec-h">
              <h2 id="rr-t-ciudad">Por ciudad</h2>
              <small>Toca un número para ver quiénes son; Enter sobre una fila abre toda la ciudad.</small>
            </header>
            <div class="rr-matriz">
              <p-table [value]="filas()" dataKey="ciudad" class="surf-table surf-table--plain" size="small"
                       [tableStyle]="{ 'min-width': '34rem', 'table-layout': 'fixed' }" selectionMode="single" (onRowSelect)="abrirCiudad($any($event).data?.ciudad)">
                <ng-template #header>
                  <tr>
                    <th scope="col" class="rr-c-ciudad">Ciudad</th>
                    @for (col of columnas; track col.id) {
                      <th scope="col" class="rr-num" [class.rr-tenue]="col.fin" [class.rr-sep]="col.primeraFin">
                        <span class="rr-h-largo">{{ col.encabezado }}</span><span class="rr-h-corto" aria-hidden="true">{{ col.abrev }}</span>
                      </th>
                    }
                    <th scope="col" class="rr-num rr-sep">Total</th>
                  </tr>
                </ng-template>
                <ng-template #body let-c>
                  <tr [pSelectableRow]="c" [class.rr-sin]="c.ciudad === sinCiudad">
                    <td role="cell" class="rr-c-ciudad">
                      <b>{{ nombre(c.ciudad) }}</b>
                      @if (c.ciudad === sinCiudad) {
                        <small>{{ d.sin_ciudad.vacia }} no la escribieron · {{ d.sin_ciudad.no_reconocida }} no se reconoce</small>
                      }
                    </td>
                    @for (col of columnas; track col.id) {
                      <td class="rr-num" role="cell" [class.rr-tenue]="col.fin" [class.rr-sep]="col.primeraFin" [style.background]="col.fin ? null : calor(c.por_etapa[col.id])">
                        @if (c.por_etapa[col.id]) {
                          <a [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', stage: col.id, city: c.ciudad }"
                             (click)="$event.stopPropagation()" [attr.aria-label]="c.por_etapa[col.id] + ' en ' + col.label + ', ' + nombre(c.ciudad)">{{ c.por_etapa[col.id] }}</a>
                        } @else { <span class="rr-cero">0</span> }
                      </td>
                    }
                    <td class="rr-num rr-sep rr-tot" role="cell">{{ c.total }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
            @if (d.sin_ciudad.no_reconocida) {
              <p class="rr-nota">«No se reconoce»: escribieron algo que no es una de nuestras ciudades, o nombran dos («La Piedad o Santa Ana»). No se adivina.</p>
            }
          </section>

          <section class="rr-card" aria-labelledby="rr-t-tiempo">
            <header class="rr-sec-h">
              <h2 id="rr-t-tiempo">¿Cuánto tarda cada paso?</h2>
              <small>Promedio de quienes ya salieron del paso. La raya vertical es la meta de RH.</small>
            </header>
            @if (errorTiempos(); as e) {
              <p class="rr-err" role="alert">{{ e }} <p-button label="Reintentar" [text]="true" size="small" (onClick)="cargarTiempos()" /></p>
            } @else if (!tiempos().length) {
              <p class="rr-nota">{{ cargandoTiempos() ? 'Leyendo…' : 'Todavía no hay cambios de etapa registrados para medirlo.' }}</p>
            } @else {
              <ul class="rr-tiempos">
                @for (t of tiempos(); track t.etapa) {
                  <li>
                    <span class="rr-t-et"><b>{{ t.nombre }}</b><small>{{ t.n }} medidos · {{ t.rango }}</small></span>
                    <span class="rr-t-barra" aria-hidden="true">
                      <i [class.pasa]="t.pasa" [style.width.%]="t.pctPromedio"></i>
                      @if (t.pctMeta != null) { <b [style.left.%]="t.pctMeta"></b> }
                    </span>
                    <span class="rr-t-v"><b>{{ t.promedio }}</b>@if (t.meta) { <small>meta {{ t.meta }}</small> }</span>
                    @if (t.pasa == null) { <span class="pill">Sin meta</span> }
                    @else { <span class="pill" [attr.data-t]="t.pasa ? 'aviso' : 'ok'">{{ t.pasa ? 'Pasa la meta' : 'Dentro' }}</span> }
                  </li>
                }
              </ul>
              <p class="rr-nota">{{ totalTiempos() }} cambios de etapa medidos. Mide desde que entró al paso hasta que salió; quien sigue ahí no cuenta todavía.</p>
            }
          </section>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rr-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .rr-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .rr-sec { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    /* El veredicto: la respuesta a la pregunta de la pantalla, en una frase, antes que cualquier cifra suelta. */
    .rr-veredicto { margin: 0; font: 500 var(--fs-h3)/1.4 var(--font-body); color: var(--text-main); }
    .rr-veredicto b { font-weight: 700; }

    /* EL EMBUDO: el mismo de Candidatos (cifra grande, pasos numerados con flecha, el resultado aparte), más el reparto. */
    .rr-embudo { display: flex; align-items: stretch; gap: var(--sp-3); flex-wrap: wrap; }
    .rr-grupo { display: flex; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); overflow: hidden; min-width: 0; }
    .rr-flujo { flex: 1 1 36rem; counter-reset: paso; }
    .rr-fin { flex: 0 1 auto; }
    .rr-paso { position: relative; flex: 1 1 0; min-width: 8.5rem; display: flex; flex-direction: column; gap: var(--sp-1);
      padding: var(--sp-2) var(--sp-5) var(--sp-3) var(--sp-3); color: inherit; text-decoration: none; min-height: var(--tap-min); }
    .rr-fin .rr-paso { min-width: 7rem; padding-right: var(--sp-3); }
    .rr-paso + .rr-paso { border-left: 1px solid var(--border-color); }
    .rr-paso:hover { background: var(--surface-hover-bg); }
    .rr-paso:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rr-paso-l { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .rr-paso-l small { margin-left: var(--sp-2); font-size: var(--fs-xs); color: var(--text-faint); }
    .rr-flujo .rr-paso-l::before { counter-increment: paso; content: counter(paso) ' · '; font-weight: 700; }
    .rr-flujo .rr-paso:not(:last-child)::after { content: '→'; position: absolute; right: var(--sp-2); top: calc(var(--sp-2) + 1.25rem);
      color: var(--text-faint); font-size: var(--fs-sm); }
    .rr-paso-n { font: 700 var(--fs-h2)/1.1 var(--font-body); font-variant-numeric: tabular-nums; color: var(--text-main); }
    .rr-fin .rr-paso-n { color: var(--text-muted); }
    /* El reparto en una barra: el color nunca va solo — debajo lo dicen las palabras, con el mismo cuadrito de color. */
    .rr-barra { display: flex; height: 6px; border-radius: var(--r-pill); overflow: hidden; background: var(--surface-2); }
    .rr-barra i { display: block; min-width: 3px; }
    .rr-barra .dentro { background: color-mix(in srgb, var(--text-main) 28%, transparent); }
    .rr-barra .fuera, .rr-d.fuera::before { background: var(--warn-fg); }
    .rr-barra .rezago, .rr-d.rezago::before { background: var(--bad-fg); }
    .rr-d.dentro::before { background: color-mix(in srgb, var(--text-main) 28%, transparent); }
    .rr-paso-d { display: flex; flex-direction: column; gap: 1px; font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-d { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .rr-d::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 2px; }
    .rr-d b { color: var(--text-main); font-weight: 700; }

    .rr-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rr-sec-h { display: flex; align-items: baseline; gap: var(--sp-1) var(--sp-3); flex-wrap: wrap; padding: var(--sp-3) var(--sp-3) var(--sp-2); }
    .rr-sec-h h2 { margin: 0; font: 700 var(--fs-h3)/1.3 var(--font-body); color: var(--text-main); }
    .rr-sec-h small { font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-nota { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
    .rr-err { margin: 0 var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg);
      display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

    /* LA MATRIZ ciudad × paso. Es un pivote, no una lista: en el teléfono no se apila (daría 8 renglones por ciudad);
       se desliza de lado con la ciudad fija y los pasos con su número, que el embudo de arriba ya nombra. */
    .rr-matriz { overflow-x: auto; container: rrm / inline-size; }
    .rr-c-ciudad { width: 13rem; text-align: left; }
    .rr-c-ciudad b { font-weight: 600; color: var(--text-main); }
    .rr-c-ciudad small { display: block; margin-top: 2px; font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); line-height: 1.35; white-space: normal; }
    th.rr-num, td.rr-num { text-align: center; font-variant-numeric: tabular-nums; }
    th.rr-num { font-family: var(--font-body); white-space: nowrap; }
    .rr-sep { border-left: 1px solid var(--border-color); }
    th.rr-tenue { color: var(--text-muted); font-weight: 500; }
    td.rr-num a { display: flex; align-items: center; justify-content: center; min-height: var(--tap-min); font-weight: 700; color: var(--text-main);
      text-decoration: none; border-radius: var(--r-sm); }
    td.rr-num a:hover { text-decoration: underline; text-underline-offset: 2px; }
    td.rr-num a:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    td.rr-tenue a { color: var(--text-muted); font-weight: 600; }
    .rr-cero { color: var(--text-faint); }
    .rr-tot { font-weight: 700; color: var(--text-main); }
    tr.rr-sin td.rr-c-ciudad b { color: var(--text-muted); }
    .rr-h-corto { display: none; }
    /* ⛔ El CSS global de móvil (styles.css, «Mobile table optimizations») esconde de la 6ª columna en adelante, fija la
       última y pide 120 px por celda, todo con !important: sirve a una lista, pero en un pivote cada columna es un paso y
       esconderla miente («Total» quedaba junto a «Filtro»). Aquí se deshace, sólo para esta matriz. */
    @media (max-width: 48rem) {
      :host ::ng-deep .rr-matriz .p-datatable .p-datatable-thead > tr > th,
      :host ::ng-deep .rr-matriz .p-datatable .p-datatable-tbody > tr > td {
        display: table-cell !important; min-width: 0 !important; position: static !important; box-shadow: none !important;
        font-size: var(--fs-sm) !important; padding: var(--sp-1) var(--sp-2) !important; overflow: visible !important; text-overflow: clip !important;
      }
      :host ::ng-deep .rr-matriz .p-datatable .p-datatable-thead > tr > th.rr-c-ciudad,
      :host ::ng-deep .rr-matriz .p-datatable .p-datatable-tbody > tr > td.rr-c-ciudad {
        position: sticky !important; left: 0; z-index: 1; background: var(--card-bg) !important; white-space: normal !important;
        box-shadow: 1px 0 0 var(--border-color) !important;
      }
      :host ::ng-deep .rr-matriz table { min-width: 28rem !important; }
    }
    @container rrm (max-width: 40rem) {
      .rr-c-ciudad { width: 7.5rem; }
      /* El rótulo largo se esconde a la vista, no al lector de pantalla. */
      .rr-h-largo { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .rr-h-corto { display: inline; }
    }

    /* ¿CUÁNTO TARDA CADA PASO? Una barra por paso en la MISMA escala; la raya es la meta. */
    .rr-tiempos { list-style: none; margin: 0; padding: 0 var(--sp-3); display: flex; flex-direction: column; }
    .rr-tiempos li { display: grid; grid-template-columns: minmax(9rem, 13rem) minmax(6rem, 1fr) 8.5rem 7.5rem; align-items: center; gap: var(--sp-2) var(--sp-4);
      padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); }
    .rr-tiempos li:first-child { border-top: 0; }
    .rr-t-et { display: flex; flex-direction: column; min-width: 0; }
    .rr-t-et b { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .rr-t-et small, .rr-t-v small { font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-t-barra { position: relative; height: 10px; border-radius: var(--r-pill); background: var(--surface-2); }
    .rr-t-barra i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: var(--r-pill); background: color-mix(in srgb, var(--text-main) 35%, transparent); }
    .rr-t-barra i.pasa { background: var(--warn-fg); }
    .rr-t-barra b { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--text-main); border-radius: 1px; }
    .rr-t-v { display: flex; flex-direction: column; font-variant-numeric: tabular-nums; }
    .rr-t-v b { font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .pill { justify-self: start; display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap;
      background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='ok'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pill[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }

    :host ::ng-deep .p-button { min-height: var(--tap-min); }
    @media (max-width: 40rem) {
      .rr-page { padding: var(--sp-3); }
      /* En el teléfono el embudo se desliza de lado en su renglón, sin partir los grupos (como en Candidatos). */
      .rr-embudo { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
      .rr-grupo { flex: 0 0 auto; }
      .rr-paso { min-width: 8rem; }
      /* Paso y veredicto arriba, el promedio debajo y la barra a todo lo ancho. */
      .rr-tiempos li { grid-template-columns: 1fr auto; row-gap: var(--sp-1); }
      .rr-tiempos .pill { grid-column: 2; grid-row: 1; justify-self: end; }
      .rr-t-v { grid-column: 1 / -1; grid-row: 2; flex-direction: row; gap: var(--sp-2); align-items: baseline; }
      .rr-t-barra { grid-column: 1 / -1; grid-row: 3; }
    }
  `],
})
export class RhReclutamientoResumenComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);
  private readonly router = inject(Router);

  readonly sinCiudad = HR_TALENT_SIN_CIUDAD;
  /** Las columnas de la matriz: los cuatro pasos (con número) y, separados, los dos desenlaces. */
  readonly columnas = ETAPAS.map((e, i) => {
    const fin = i >= ETAPAS_DEL_FLUJO.length;
    return { id: e.id, label: e.label, fin, primeraFin: i === ETAPAS_DEL_FLUJO.length,
      encabezado: fin ? e.corto : `${i + 1} · ${e.corto}`, abrev: fin ? e.corto.slice(0, 5) + '.' : String(i + 1) };
  });

  readonly datos = signal<HrResumenReclutamientoDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly leidoEn = signal<Date | null>(null);

  readonly tiempos = signal<TiempoFila[]>([]);
  readonly totalTiempos = signal(0);
  readonly cargandoTiempos = signal(false);
  readonly errorTiempos = signal<string | null>(null);

  readonly filas = computed(() => this.datos()?.ciudades ?? []);
  readonly pasos = computed(() => pasosDe(this.datos()));
  readonly fin = computed(() => ETAPAS.slice(ETAPAS_DEL_FLUJO.length).map((e) => ({
    id: e.id, corto: e.corto, label: e.label, total: this.datos()?.etapas.find((x) => x.etapa === e.id)?.total ?? 0,
  })));
  /** El veredicto: el paso con más gente fuera de su meta. Ninguno → todos van dentro. */
  readonly peor = computed<PasoResumen | null>(() =>
    this.pasos().filter((p) => p.fuera > 0).reduce<PasoResumen | null>((a, p) => (!a || p.fuera > a.fuera ? p : a), null));
  /** La celda más llena de los pasos, para la intensidad del fondo (el número sigue ahí: el color sólo ayuda a ver dónde se junta). */
  private readonly maxCelda = computed(() => Math.max(1, ...this.filas().flatMap((c) => ETAPAS_DEL_FLUJO.map((e) => c.por_etapa[e.id] ?? 0))));

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.resumen().subscribe({
      next: (d) => { this.datos.set(d); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { this.error.set(rhError(e, 'No se pudo leer el resumen del reclutamiento.')); this.loading.set(false); },
    });
    this.cargarTiempos();
  }

  /** Aparte del resumen: si falla, se dice en su sección y el resto de la pantalla sigue sirviendo. */
  cargarTiempos(): void {
    this.cargandoTiempos.set(true);
    this.errorTiempos.set(null);
    this.api.tiempoPorEtapa().subscribe({
      next: (t) => { this.tiempos.set(tiemposDe(t.fases)); this.totalTiempos.set(t.total); this.cargandoTiempos.set(false); },
      error: (e) => { this.errorTiempos.set(rhError(e, 'No se pudo leer el tiempo por paso.')); this.cargandoTiempos.set(false); },
    });
  }

  calor(n: number | undefined): string | null {
    if (!n) return null;
    return `color-mix(in srgb, var(--text-main) ${Math.round(3 + 11 * (n / this.maxCelda()))}%, transparent)`;
  }

  avisoPaso(p: PasoResumen, dias: number): string {
    const detalle = [p.fuera ? `${p.fuera} fuera de meta` : '', p.rezago ? `${p.rezago} sin moverse hace más de ${dias} días` : '']
      .filter(Boolean).join(', ');
    return `Ver los ${p.total} en ${p.label}` + (detalle ? `. ${detalle}` : '');
  }

  nombre(c: string): string { return c === HR_TALENT_SIN_CIUDAD ? 'Sin ciudad reconocida' : c; }

  abrirCiudad(ciudad: string | null | undefined): void {
    if (!ciudad) return;
    void this.router.navigate(['/rh/reclutamiento'], { queryParams: { view: 'en_proceso', city: ciudad } });
  }
}
