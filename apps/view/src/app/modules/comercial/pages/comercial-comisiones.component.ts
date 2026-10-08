import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import {
  ComercialService, CommissionBoardRow, CommissionRunDetail, CommissionLine,
  CommissionGate, CommissionRecalcResult,
} from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * RD.6 / RD.17-RD.21 — Comisiones de Ruta Directa. **Pantalla de verificacion, sin acciones.**
 *
 * ── Por que no tiene botones ─────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-07, con el liston en 500 ms:
 *
 *     tablero del año (27 quincenas + su corrida) ....     2.7 ms
 *     detalle de una corrida .........................    23.8 ms
 *     calcular UNA quincena (lo que hacia el boton) .. 5,762.0 ms
 *
 * ⭐ **El unico camino lento del modulo eran las acciones.** `Vista previa` y `Crear corrida`
 * tocan `v_rd_route_daily`, que se materializa entera en cada consulta; leer una corrida ya
 * persistida es leer una tabla de 26 filas. Quitarlas no es una concesion: es lo que vuelve
 * rapida la pantalla — y de paso honesta, porque lo que se ve es lo que de verdad quedo
 * calculado, no un numero que aparecio porque alguien apreto algo.
 *
 * ⛔ **Y no hay cron detras.** Una quincena cerrada es un valor ESTATICO: se calcula una vez,
 * con el periodo ya cerrado, y no cambia. Lo escribe un acto deliberado -- recalcular desde una
 * quincena hacia adelante -- que es el mismo tramite cuando cierra un periodo y cuando cambia
 * la escala. La quincena que todavia corre **no se guarda**: guardarla obligaba a reescribirla
 * cada media hora, o sea una cifra de nomina moviendose sola.
 *
 * Esta pantalla **solo lee**. Lo que no esta calculado lo DECLARA (`sin_calcular`), que no es
 * lo mismo que `en_curso`: al primero le falta que alguien lo calcule, al segundo que termine
 * el periodo, y pintarlos igual hacia que una quincena olvidada se viera normal.
 *
 * ── Lo que esta pantalla no esconde ──────────────────────────────────────────────────────
 *  · El **neto**, no el bruto. La deduccion del supervisor es por persona y agregada sobre sus
 *    rutas, y el motor no la restaba en ningun lado.
 *  · Las **compuertas** con su motivo, y la distincion entre `en_curso` (le falta terminar) y
 *    `bloqueada` (le falla algo): son dos cosas que se arreglan distinto.
 *  · El **markup** con su nombre y la procedencia del costo que lo respalda — el bono del
 *    supervisor cuelga de ahi y antes no se veia.
 *  · Las rutas que **venden y no comisionan**, con su veredicto.
 *  · Hasta cuando llega el dato y cuando se calculo la corrida.
 *
 * ⚠️ Las fechas llegan del servidor como texto `YYYY-MM-DD` y se formatean CORTANDO LA CADENA,
 * nunca con `new Date(...)`: un `date` de pg llega a medianoche UTC y en hora de Mexico eso es
 * el dia ANTERIOR. Es el defecto que `[LC.16]` ya pago una vez.
 */
@Component({
  selector: 'app-comercial-comisiones',
  standalone: true,
  imports: [FormsModule, TagModule, LoadStateComponent, MetricStripComponent, SegmentedComponent],
  template: `
    <div class="cm-page">
      <header class="cm-head">
        <div>
          <h1>Comisiones de Ruta Directa</h1>
          <p class="cm-sub">
            Quincena de 14 días · la comisión va sobre el <strong>subtotal</strong>
            y la compuerta la abre la <strong>venta total</strong>
          </p>
        </div>
        <label class="cm-year">Año
          <select [ngModel]="anio()" (ngModelChange)="anio.set(+$event); cargar()">
            @for (y of anios; track y) { <option [value]="y">{{ y }}</option> }
          </select>
        </label>
      </header>

      @if (destacada(); as d) {
        <section class="cm-answer" [class.abierta]="d.status === 'en_curso'">
          <div class="cm-answer-que">
            <p class="cm-eyebrow">{{ d.status === 'en_curso' ? 'Quincena en curso' : 'Lo que toca pagar' }}</p>
            <p class="cm-answer-q">
              Quincena {{ d.period_no }} <span class="cm-muted">· {{ rango(d) }}</span>
            </p>
            <p class="cm-answer-pie">
              @if (d.pay_date) { Se paga el <span class="cm-mono">{{ dia(d.pay_date) }}</span> · }
              calculada {{ cuando(d.updated_at) }}
              @if (d.origen === 'cron') { <span class="cm-muted">(sola)</span> }
            </p>
          </div>
          <div>
            <p class="cm-eyebrow">{{ d.status === 'en_curso' ? 'Neto acumulado' : 'Neto a pagar' }}</p>
            <p class="cm-answer-monto">{{ money(d.total_neto) }}</p>
            <p class="cm-answer-pie cm-mono">
              bruto {{ money(d.total_a_pagar) }} − deducciones {{ money(d.total_deduccion) }}
            </p>
          </div>
          <p-tag [severity]="sev(d)" [value]="etiquetaEstado(d)" />
        </section>
      }

      @if (err()) { <p class="cm-err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ err() }}</p> }

      <div class="cm-split">
        <aside class="cm-rail">
          <app-load-state
            [loading]="cargando()" [isEmpty]="!board().length" [skeletonRows]="6"
            emptyIcon="pi-calendar" emptyTitle="Sin quincenas"
            [emptyHint]="'El calendario de ' + anio() + ' no tiene periodos cargados.'">
            @for (g of porMes(); track g.mes) {
              <p class="cm-mes">{{ g.mes }}</p>
              @for (p of g.filas; track p.period_id) {
                <button type="button" class="cm-per" [class.sel]="sel()?.period_id === p.period_id"
                        [class.hoy]="esHoy(p)" (click)="elegir(p)">
                  <span class="cm-per-top">
                    <span class="cm-per-no">Q{{ p.period_no }}</span>
                    <span class="cm-per-fechas">{{ rango(p) }}</span>
                    @if (esHoy(p)) { <span class="cm-hoy">hoy</span> }
                  </span>
                  <span class="cm-per-bot">
                    <p-tag [severity]="sev(p)" [value]="etiquetaEstado(p)" />
                    <span class="cm-per-monto">{{ p.run_id ? money(p.total_neto) : '—' }}</span>
                  </span>
                </button>
              }
            }
            @if (futuras().length) {
              <p class="cm-futuras">
                Q{{ futuras()[0].period_no }}–Q{{ futuras()[futuras().length - 1].period_no }} ·
                {{ futuras().length }} quincena(s) que aún no empiezan
              </p>
            }
          </app-load-state>
        </aside>

        <section class="cm-detail">
          @if (!sel()) {
            <p class="cm-empty">Elegí una quincena.</p>
          } @else if (!sel()!.run_id) {
            <div class="cm-card">
              <h2>Quincena {{ sel()!.period_no }} · {{ rango(sel()!) }}</h2>
              <p class="cm-muted cm-card-pie">
                @switch (sel()!.estado_calculo) {
                  @case ('futura') { Empieza el {{ dia(sel()!.date_from) }}: todavía no existe. }
                  @case ('en_curso') {
                    Está corriendo: cierra el {{ dia(sel()!.date_to) }}.
                    No se calcula hasta que cierre — una quincena a medias no se paga.
                  }
                  @default {
                    Cerró el {{ dia(sel()!.date_to) }} y <strong>todavía no se ha calculado</strong>.
                  }
                }
              </p>

              <ol class="cm-ciclo">
                <li [class.act]="sel()!.estado_calculo === 'sin_calcular'">
                  <span class="cm-paso">1</span> Calcular
                  <span>Se hace una vez, con el periodo ya cerrado. Nace en borrador.</span>
                </li>
                <li>
                  <span class="cm-paso">2</span> Revisar
                  <span>Compuertas, cobertura y la procedencia de cada cifra.</span>
                </li>
                <li>
                  <span class="cm-paso">3</span> Aprobar
                  <span>Lo hace una persona. El motor nunca aprueba solo.</span>
                </li>
                <li>
                  <span class="cm-paso">4</span> Pagar
                  <span>Se marca pagada y queda congelada: lo pagado no se recalcula.</span>
                </li>
              </ol>

              @if (sinCalcular().length) {
                <p class="cm-warn bad">
                  <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                  <span>
                    <strong>
                      {{ sinCalcular().length === 1 ? 'Una quincena ya cerró' : sinCalcular().length + ' quincenas ya cerraron' }}
                      y no {{ sinCalcular().length === 1 ? 'tiene' : 'tienen' }} número:
                    </strong>
                    {{ listaSinCalcular() }}.
                    Se producen recalculando desde la primera — el mismo trámite que cuando
                    cambia el tabulador. No hay nada que esperar: no corre solo a propósito.
                  </span>
                </p>

                @if (puedeGestionar()) {
                  <div class="cm-tramite">
                    <p class="cm-tramite-txt">
                      Calcular desde <strong>Q{{ sinCalcular()[0].period_no }}</strong> produce ésa y
                      las {{ sinCalcular().length - 1 }} que le siguen.
                      <span class="cm-muted">
                        Nace en borrador: no aprueba ni paga. Lo ya pagado se salta.
                      </span>
                    </p>
                    <button type="button" class="cm-btn" [disabled]="recalculando()"
                            (click)="recalcularDesde(sinCalcular()[0].period_id)">
                      {{ recalculando() ? 'Calculando…' : 'Calcular desde Q' + sinCalcular()[0].period_no }}
                    </button>
                  </div>
                  @if (recalculando()) {
                    <p class="cm-muted cm-micro">
                      Cada quincena cuesta unos segundos — se leen tres fuentes de venta día por día.
                    </p>
                  }
                  @if (recalc(); as rr) {
                    <div class="cm-recalc">
                      <p><strong>{{ rr.calculadas.length }}</strong> calculada(s)
                        @if (rr.saltadas.length) { · <strong>{{ rr.saltadas.length }}</strong> saltada(s) }
                        @if (rr.fallas.length) { · <strong class="cm-neg">{{ rr.fallas.length }}</strong> con falla }
                      </p>
                      @for (s of rr.saltadas; track s.period_no) {
                        <p class="cm-micro cm-muted">Q{{ s.period_no }} no se tocó — {{ s.motivo }}</p>
                      }
                      @for (f of rr.fallas; track f) {
                        <p class="cm-micro cm-neg">{{ f }}</p>
                      }
                    </div>
                  }
                }
              }
            </div>
          } @else if (run(); as r) {
            @if (bloqueantes(r).length) {
              <div class="cm-gate bad">
                <strong><i class="pi pi-ban" aria-hidden="true"></i> No se puede aprobar</strong>
                <ul>@for (g of bloqueantes(r); track g.gate) { <li><b>{{ etiquetaGate(g.gate) }}</b>: {{ g.detalle }}</li> }</ul>
              </div>
            }
            @if (avisos(r).length) {
              <div class="cm-gate warn">
                <strong><i class="pi pi-exclamation-circle" aria-hidden="true"></i> Pasa, con reservas</strong>
                <ul>@for (g of avisos(r); track g.gate) { <li><b>{{ etiquetaGate(g.gate) }}</b>: {{ g.detalle }}</li> }</ul>
              </div>
            }

            <app-metric-strip [items]="kpis(r)" ariaLabel="Totales de la quincena" />

            <p class="cm-proc">
              dato hasta <b>{{ r.data_as_of ? dia(r.data_as_of) : 'sin medir' }}</b>
              · corrida {{ cuando(r.updated_at) }}
              @if (r.origen) { · origen {{ r.origen === 'cron' ? 'automático' : 'manual' }} }
            </p>

            <app-segmented [options]="pestanas()" [value]="tab()" (valueChange)="tab.set($event)"
                           ariaLabel="Qué se está viendo" />

            @if (tab() === 'supervisor') {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky">
                  <thead><tr>
                    <th>Supervisor</th><th>Zona</th><th>Rutas</th>
                    <th class="comm-num">Comisión</th><th class="comm-num">Bonos</th><th class="comm-num">Contribución</th>
                  </tr></thead>
                  <tbody>
                    @for (s of supervisores(); track s.clave) {
                      <tr>
                        <td class="cm-name">{{ s.nombre }}</td>
                        <td class="cm-muted">{{ s.zona || '—' }}</td>
                        <td class="cm-mono cm-micro">{{ s.rutas.join(' · ') }}</td>
                        <td class="comm-num">{{ money(s.comision) }}</td>
                        <td class="comm-num">{{ s.bonos ? money(s.bonos) : '—' }}</td>
                        <td class="comm-num is-strong">{{ money(s.bruto) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="cm-warn">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                La deducción del supervisor es por <strong>persona</strong> y agregada sobre sus rutas, no por
                ruta: por eso estas filas traen su <em>contribución</em> y el neto del periodo ya la resta
                arriba. El total descontado de la quincena es {{ money(run()?.total_deduccion) }}.
              </p>
            } @else if (tab() === 'fuera') {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky">
                  <thead><tr><th>Ruta</th><th>Por qué no comisiona</th><th class="comm-num">Subtotal</th></tr></thead>
                  <tbody>
                    @for (l of fuera(); track l.route_code) {
                      <tr>
                        <td class="comm-num">{{ l.route_code }}</td>
                        <td><p-tag severity="secondary" [value]="etiquetaVeredicto(l.motivo_no_pago)" /></td>
                        <td class="comm-num">{{ l.subtotal != null ? money(l.subtotal) : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="cm-warn">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Estas rutas <strong>venden y no pagan comisión de Ruta Directa</strong>. Salen con su motivo
                para que la ausencia sea una decisión y no un descuido.
              </p>
            } @else {
              <div class="cm-table-wrap">
                <table class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first">
                  <thead><tr>
                    <th>Ruta</th><th>Chofer</th><th class="comm-num">Días</th>
                    <th class="comm-num">Subtotal</th><th class="comm-num">Venta</th><th class="comm-num">%</th>
                    <th class="comm-num">Markup</th><th class="comm-num">Comisión</th><th class="comm-num">Bonos</th>
                    <th class="comm-num">Nómina</th><th class="comm-num">A pagar</th><th>Procedencia</th>
                  </tr></thead>
                  <tbody>
                    @for (l of choferes(); track l.route_code) {
                      <tr [class.muted]="!!l.motivo_no_pago">
                        <td class="comm-num">{{ l.route_code }}</td>
                        <td class="cm-name">{{ l.beneficiario_nombre || '—' }}</td>
                        <td class="comm-num" [class.cm-corta]="diasCortos(l)" [title]="tipDias(l)">
                          {{ l.dias_con_venta != null ? (l.dias_con_venta + ' / ' + (l.dias_esperados ?? '?')) : '—' }}
                        </td>
                        <td class="comm-num">{{ l.subtotal != null ? money(l.subtotal) : '—' }}</td>
                        <td class="comm-num cm-muted">{{ l.venta != null ? money(l.venta) : '—' }}</td>
                        <td class="comm-num">{{ l.pct_aplicado != null ? (pct(l.pct_aplicado) + '%') : '—' }}</td>
                        <td class="comm-num cm-muted" [title]="tipMarkup(l)">
                          {{ l.markup_sobre_costo_pct != null ? (pct(l.markup_sobre_costo_pct) + '%') : '—' }}
                        </td>
                        <td class="comm-num">{{ money(l.comision) }}</td>
                        <td class="comm-num" [title]="bonosTip(l)">{{ l.bonos ? money(l.bonos) : '—' }}</td>
                        <td class="comm-num cm-neg">{{ l.nomina_banco ? ('−' + money(l.nomina_banco)) : '—' }}</td>
                        <td class="comm-num is-strong">{{ l.motivo_no_pago ? '—' : money(l.a_pagar) }}</td>
                        <td class="cm-nota">
                          @if (l.motivo_no_pago) { <p-tag severity="warn" [value]="etiquetaVeredicto(l.motivo_no_pago)" /> }
                          @if (l.dias_multifuente) {
                            <span title="La quincena cruza un cambio de sistema: la venta de esos días viene de dos capturas. Medido: no comparten folio.">
                              <p-tag severity="secondary" value="corte" />
                            </span>
                          }
                          @if (l.costo_veredicto && l.costo_veredicto !== 'dos_fuentes') {
                            <span [title]="tipCosto(l.costo_veredicto)">
                              <p-tag [severity]="l.costo_veredicto === 'sin_costo' ? 'warn' : 'secondary'"
                                     [value]="etiquetaCosto(l.costo_veredicto)" />
                            </span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                  <tfoot><tr>
                    <td colspan="3">{{ pagan() }} de {{ choferes().length }} pagan</td>
                    <td class="comm-num">{{ money(sumCh('subtotal')) }}</td>
                    <td class="comm-num">{{ money(sumCh('venta')) }}</td>
                    <td></td><td></td>
                    <td class="comm-num">{{ money(sumCh('comision')) }}</td>
                    <td class="comm-num">{{ money(sumCh('bonos')) }}</td>
                    <td class="comm-num cm-neg">−{{ money(sumCh('nomina_banco')) }}</td>
                    <td class="comm-num is-strong">{{ money(sumCh('a_pagar')) }}</td>
                    <td></td>
                  </tr></tfoot>
                </table>
              </div>
            }
          } @else {
            <p class="cm-empty">Cargando la corrida…</p>
          }
        </section>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; }
    .cm-page { padding:1rem 1.1rem 2rem; }
    .cm-head { display:flex; align-items:flex-start; gap:1rem; margin-bottom:1rem; }
    .cm-head h1 { margin:0; font-size:var(--fs-h2); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-sub { margin:.15rem 0 0; font-size:var(--fs-sm); color:var(--c-text-3); }
    .cm-sub strong { color:var(--c-text-2); font-weight:var(--fw-medium); }
    .cm-year { margin-left:auto; display:inline-flex; gap:.4rem; align-items:center; font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-year select { padding:.3rem .45rem; border:1px solid var(--border-color); border-radius:var(--r-sm,6px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }

    .cm-answer { display:flex; flex-wrap:wrap; align-items:center; gap:1rem 1.75rem; margin-bottom:1rem;
      padding:.9rem 1.1rem; border:1px solid var(--border-color); border-left:3px solid var(--action);
      border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-answer.abierta { border-left-color:var(--c-text-3); }
    .cm-answer-que { flex:1 1 16rem; min-width:0; }
    .cm-eyebrow { margin:0; font-size:var(--fs-micro); letter-spacing:.07em; text-transform:uppercase; color:var(--c-text-3); }
    .cm-answer-q { margin:.2rem 0 0; font-size:var(--fs-h3); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-answer-pie { margin:.1rem 0 0; font-size:var(--fs-micro); color:var(--c-text-3); }
    .cm-answer-monto { margin:.1rem 0 0; font-family:var(--font-mono,'Geist Mono',monospace);
      font-size:1.5rem; font-weight:var(--fw-bold); font-variant-numeric:tabular-nums; color:var(--c-text-1); }

    .cm-split { display:grid; grid-template-columns:minmax(240px,300px) 1fr; gap:1rem; align-items:start; }
    @media (max-width:56.25rem) { .cm-split { grid-template-columns:1fr; } }

    .cm-rail { display:flex; flex-direction:column; max-height:78vh; overflow-y:auto; }
    .cm-mes { margin:.9rem 0 .35rem; font-size:var(--fs-micro); letter-spacing:.07em; text-transform:uppercase;
      color:var(--c-text-3); font-weight:var(--fw-medium); }
    .cm-mes:first-child { margin-top:0; }
    .cm-colapso { border:1px dashed var(--border-color); border-radius:var(--r-md,8px); margin-bottom:.4rem; }
    .cm-colapso summary { padding:.5rem .7rem; font-size:var(--fs-sm); color:var(--c-text-3); cursor:pointer; }
    .cm-colapso p { margin:0; padding:0 .7rem .55rem; font-size:var(--fs-micro); color:var(--c-text-3); }
    .cm-per { display:flex; flex-direction:column; gap:.3rem; text-align:left; margin-bottom:.3rem;
      padding:.45rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md,8px);
      background:var(--card-bg); font:inherit; cursor:pointer; }
    .cm-per:hover { background:var(--overlay-hover); }
    .cm-per.sel { border-color:var(--action); background:color-mix(in srgb, var(--action) 8%, transparent); }
    .cm-per-top { display:flex; align-items:baseline; gap:.45rem; }
    .cm-per-bot { display:flex; align-items:center; justify-content:space-between; gap:.4rem; }
    .cm-per-no { font-weight:var(--fw-bold); font-size:var(--fs-sm); color:var(--c-text-1); font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-per-fechas { font-size:var(--fs-micro); color:var(--c-text-3); }
    .cm-per-monto { font-size:var(--fs-micro); color:var(--c-text-2); font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }

    .cm-per.hoy { border-color:color-mix(in srgb, var(--action) 45%, var(--border-color)); }
    .cm-hoy { margin-left:auto; font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase;
      color:var(--action); font-weight:var(--fw-bold); }
    .cm-futuras { margin:.7rem 0 0; padding:.5rem .6rem; border:1px dashed var(--border-color);
      border-radius:var(--r-md,8px); font-size:var(--fs-micro); color:var(--c-text-3); text-align:center; }

    .cm-detail { min-width:0; }
    .cm-card { border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); padding:1rem 1.1rem; }
    .cm-card h2 { margin:0 0 .3rem; font-size:var(--fs-h3); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .cm-card p { margin:0; font-size:var(--fs-sm); }
    .cm-card-pie { margin-bottom:1rem !important; }

    /* El ciclo: lo que va a pasar solo, para que el vacío explique en vez de quedarse callado. */
    .cm-ciclo { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; margin:0;
      padding:0; list-style:none; background:var(--border-color); border:1px solid var(--border-color);
      border-radius:var(--r-md,8px); overflow:hidden; }
    @media (max-width:46rem) { .cm-ciclo { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    .cm-ciclo li { display:flex; flex-direction:column; gap:.3rem; padding:.7rem .8rem;
      background:var(--card-bg); font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--c-text-3); }
    .cm-ciclo li.act { background:color-mix(in srgb, var(--action) 7%, var(--card-bg)); color:var(--action); }
    .cm-ciclo li span:last-child { font-size:var(--fs-micro); font-weight:400; color:var(--c-text-3); }
    .cm-paso { display:inline-flex; align-items:center; justify-content:center; width:1.15rem; height:1.15rem;
      border:1px solid currentColor; border-radius:50%; font-family:var(--font-mono,'Geist Mono',monospace);
      font-size:var(--fs-micro); }

    .cm-table-wrap { overflow-x:auto; border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); margin-top:.6rem; }
    .cm-table-wrap tbody tr.muted td { color:var(--c-text-3); }
    .cm-neg { color:var(--bad-fg); }
    /* Ambar y no rojo a proposito: 8 de cada 22 marcadas son legitimas (el camion no salio). */
    .cm-corta { color:var(--warn-fg); font-weight:var(--fw-medium); }
    .cm-tramite { display:flex; gap:.9rem; align-items:center; justify-content:space-between;
      flex-wrap:wrap; margin-top:.8rem; padding:.7rem .9rem;
      border:1px solid var(--border-color); border-radius:var(--r-md,8px); background:var(--card-bg); }
    .cm-tramite-txt { margin:0; font-size:var(--fs-sm); }
    .cm-btn { border:1px solid var(--action); background:var(--action); color:#fff;
      border-radius:var(--r-sm,6px); padding:.4rem .9rem;
      font-size:var(--fs-sm); font-weight:var(--fw-medium); cursor:pointer; white-space:nowrap; }
    .cm-btn:disabled { opacity:.55; cursor:default; }
    .cm-recalc { margin-top:.6rem; font-size:var(--fs-sm); }
    .cm-recalc p { margin:.15rem 0; }
    .cm-name { max-width:14rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cm-nota { display:flex; gap:.25rem; align-items:center; flex-wrap:wrap; }
    .cm-mono { font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-micro { font-size:var(--fs-micro); }

    .cm-gate { display:block; margin:0 0 .6rem; padding:.55rem .7rem; border-radius:var(--r-md,8px); font-size:var(--fs-sm); }
    .cm-gate strong { display:flex; gap:.4rem; align-items:center; }
    .cm-gate ul { margin:.35rem 0 0; padding-left:1.4rem; color:var(--c-text-2); }
    .cm-gate.bad { border:1px solid color-mix(in srgb, var(--bad-fg) 45%, transparent);
      background:color-mix(in srgb, var(--bad-fg) 9%, transparent); color:var(--bad-fg); }
    .cm-gate.warn { border:1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent);
      background:color-mix(in srgb, var(--warn-fg) 8%, transparent); color:var(--c-text-2); }

    .cm-proc { margin:.5rem 0 .6rem; font-size:var(--fs-micro); color:var(--c-text-3);
      font-family:var(--font-mono,'Geist Mono',monospace); }
    .cm-warn.bad { border-color:color-mix(in srgb, var(--bad-fg) 45%, transparent);
      background:color-mix(in srgb, var(--bad-fg) 9%, transparent); }
    .cm-warn { display:flex; gap:.4rem; align-items:flex-start; margin:.7rem 0 0; padding:.5rem .65rem;
      border:1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent); border-radius:var(--r-md,8px);
      background:color-mix(in srgb, var(--warn-fg) 8%, transparent); font-size:var(--fs-sm); color:var(--c-text-2); }
    .cm-err { display:flex; gap:.4rem; align-items:center; color:var(--bad-fg); font-size:var(--fs-sm); margin:.4rem 0; }
    .cm-empty { color:var(--c-text-3); font-size:var(--fs-sm); }
    .cm-muted { color:var(--c-text-3); }
  `],
})
export class ComercialComisionesComponent {
  private readonly api = inject(ComercialService);
  private readonly perms = inject(PermissionsService);

  /**
   * ⭐ El ÚNICO control de esta pantalla, y aparece sólo cuando hay un hueco que llenar.
   *
   * No contradice el "sin botones": lo que no debe depender de que alguien apriete algo es
   * **leer**, y leer sigue costando 2.7 ms sin tocar nada. Esto es el trámite manual que se
   * pidió explícitamente — producir el número de una quincena cerrada, y reconvertir desde el
   * periodo en que aplica una escala nueva. Es el mismo acto las dos veces.
   */
  readonly puedeGestionar = computed(() => this.perms.has(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR));
  readonly recalculando = signal(false);
  readonly recalc = signal<CommissionRecalcResult | null>(null);

  readonly anios = [2026, 2027];
  readonly anio = signal(new Date().getFullYear() >= 2027 ? 2027 : 2026);
  readonly board = signal<CommissionBoardRow[]>([]);
  /**
   * ⭐ Las quincenas que YA CERRARON y no tienen número, resueltas en el servidor con su
   * `current_date` — no con el reloj del navegador, que es de quien mira y no del negocio.
   * Es el único hueco que hay que ver al abrir: vacío significa que no falta nada.
   */
  readonly sinCalcular = signal<{ period_id: string; period_no: number; date_to: string }[]>([]);
  readonly sel = signal<CommissionBoardRow | null>(null);
  readonly run = signal<CommissionRunDetail | null>(null);
  readonly tab = signal<string>('chofer');
  readonly cargando = signal(false);
  readonly err = signal<string | null>(null);

  /** Hoy en texto `YYYY-MM-DD`, para comparar con las fechas del servidor SIN construir `Date`. */
  private readonly hoy = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  /** La quincena que corre hoy. Existe aunque nadie la haya calculado todavia. */
  readonly enCurso = computed<CommissionBoardRow | null>(() =>
    this.board().find((p) => p.date_from <= this.hoy && this.hoy <= p.date_to) ?? null);

  /**
   * La quincena que importa. ⚠️ El ultimo recurso es **la que corre hoy, tenga corrida o no**:
   * la primera version caia a `null` cuando no habia ninguna corrida, y entonces la pantalla
   * abria sin nada que mirar y sin nada que elegir. Un tablero vacio tiene que seguir diciendo
   * en que dia vive.
   */
  readonly destacada = computed<CommissionBoardRow | null>(() => {
    const b = this.board();
    const pagable = [...b].reverse().find((r) => r.status === 'borrador' || r.status === 'aprobado');
    return pagable ?? b.find((r) => r.status === 'en_curso') ?? this.enCurso() ?? null;
  });

  readonly sinCorrida = computed(() => this.board().filter((r) => r.estado_calculo === 'sin_calcular'));

  /** "Q18, Q19 y Q20" — la lista que la pantalla nombra, sin obligar a contarlas en el rail. */
  readonly listaSinCalcular = computed(() => {
    const q = this.sinCalcular().map((p) => `Q${p.period_no}`);
    if (q.length <= 1) return q[0] ?? '';
    return `${q.slice(0, -1).join(', ')} y ${q[q.length - 1]}`;
  });

  /**
   * El rail, agrupado por mes. ⛔ La primera version filtraba `if (!p.run_id) continue` y con
   * cero corridas dejaba el rail VACIO — 27 quincenas reales escondidas y un "Elegí una
   * quincena" sin nada que elegir. Las quincenas existen aunque no esten calculadas: el chip
   * dice cual es cual, que es distinto de no mostrarlas.
   */
  readonly porMes = computed(() => {
    const out: { mes: string; filas: CommissionBoardRow[] }[] = [];
    for (const p of this.board()) {
      if (p.date_from > this.hoy) continue;   // las que no empezaron van al pie
      const m = this.MESES[Number(p.date_to.slice(5, 7)) - 1] ?? '';
      const nombre = m.charAt(0).toUpperCase() + m.slice(1) + ' ' + p.date_to.slice(0, 4);
      const ult = out[out.length - 1];
      if (ult && ult.mes === nombre) ult.filas.push(p);
      else out.push({ mes: nombre, filas: [p] });
    }
    return out;
  });

  /** Lo que todavia no empieza no es "sin corrida": es futuro, y ocupa una linea. */
  readonly futuras = computed(() => this.board().filter((p) => p.date_from > this.hoy));

  esHoy(p: CommissionBoardRow): boolean {
    return p.date_from <= this.hoy && this.hoy <= p.date_to;
  }

  readonly choferes = computed(() =>
    (this.run()?.lines ?? []).filter((l) => l.beneficiario === 'chofer' && !this.esFuera(l)));

  readonly fuera = computed(() =>
    (this.run()?.lines ?? []).filter((l) => l.beneficiario === 'chofer' && this.esFuera(l)));

  readonly supervisores = computed(() => {
    const acc = new Map<string, {
      clave: string; nombre: string; zona: string | null; rutas: string[];
      comision: number; bonos: number; bruto: number;
    }>();
    for (const l of this.run()?.lines ?? []) {
      if (l.beneficiario !== 'supervisor' || l.motivo_no_pago) continue;
      const nombre = l.beneficiario_nombre || '—';
      const cur = acc.get(nombre) ?? {
        clave: nombre, nombre, zona: l.zona ?? null, rutas: [], comision: 0, bonos: 0, bruto: 0,
      };
      cur.rutas.push(l.route_code);
      cur.comision += Number(l.comision) || 0;
      cur.bonos += Number(l.bonos) || 0;
      cur.bruto += Number(l.a_pagar) || 0;
      acc.set(nombre, cur);
    }
    return [...acc.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  });

  constructor() { this.cargar(); }

  cargar() {
    this.cargando.set(true);
    this.err.set(null);
    this.api.commissionBoard(this.anio()).subscribe({
      next: (b) => {
        this.board.set(b.periodos);
        this.sinCalcular.set(b.sin_calcular ?? []);
        this.cargando.set(false);
        const d = this.destacada();
        if (d) this.elegir(d);
        else { this.sel.set(null); this.run.set(null); }
      },
      error: () => { this.cargando.set(false); this.err.set('No se pudo cargar el tablero.'); },
    });
  }

  elegir(p: CommissionBoardRow) {
    this.sel.set(p);
    this.run.set(null);
    if (!p.run_id) return;
    this.api.commissionRun(p.run_id).subscribe({
      next: (d) => this.run.set(d),
      error: () => this.err.set('No se pudo cargar la corrida.'),
    });
  }

  // ── Lectura ────────────────────────────────────────────────────────────────────────────

  private esFuera(l: CommissionLine): boolean {
    const DENTRO = new Set(['sin_dato_en_la_fuente', 'bajo_umbral']);
    return !!l.motivo_no_pago && !DENTRO.has(l.motivo_no_pago);
  }

  pagan(): number { return this.choferes().filter((l) => !l.motivo_no_pago).length; }

  sumCh(campo: keyof CommissionLine): number {
    return this.choferes().reduce((s, l) => s + (Number(l[campo]) || 0), 0);
  }

  bloqueantes(r: CommissionRunDetail): CommissionGate[] {
    return (r.gates ?? []).filter((g) => g.estado === 'bloquea');
  }

  avisos(r: CommissionRunDetail): CommissionGate[] {
    return (r.gates ?? []).filter((g) => g.estado === 'advierte' || g.estado === 'no_medido');
  }

  pestanas(): SegOption[] {
    return [
      { label: `Choferes · ${this.pagan()}`, value: 'chofer' },
      { label: `Supervisores · ${this.supervisores().length}`, value: 'supervisor' },
      ...(this.fuera().length ? [{ label: `No comisionan · ${this.fuera().length}`, value: 'fuera' }] : []),
    ];
  }

  kpis(r: CommissionRunDetail): MetricStripItem[] {
    const conDato = r.rutas_con_dato ?? 0;
    const sinDato = r.rutas_sin_dato ?? 0;
    return [
      { label: 'Subtotal', value: Number(r.total_subtotal), format: 'currency' },
      { label: 'Comisión', value: Number(r.total_comision), format: 'currency' },
      { label: 'Bruto', value: Number(r.total_a_pagar), format: 'currency' },
      {
        label: 'Neto', value: Number(r.total_neto), format: 'currency', tone: 'brand',
        sub: `menos ${this.money(r.total_deduccion)} de deducciones`,
      },
      {
        label: 'Cobertura', value: conDato, format: 'number',
        tone: sinDato ? 'warn' : 'ok',
        sub: `de ${conDato + sinDato} que comisionan${r.rutas_fuera ? ` · ${r.rutas_fuera} fuera` : ''}`,
      },
    ];
  }

  // ── Formato ────────────────────────────────────────────────────────────────────────────

  private readonly MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  /**
   * ⚠️ Corta la cadena, NO construye un `Date`: un `date` de pg llega a medianoche UTC y en
   * hora de Mexico eso es el dia ANTERIOR (`[LC.16]`).
   */
  dia(iso: string | null): string {
    if (!iso) return '—';
    const d = Number(iso.slice(8, 10));
    const m = this.MESES[Number(iso.slice(5, 7)) - 1] ?? '';
    return `${d} ${m}`;
  }

  rango(p: { date_from: string; date_to: string }): string {
    const mf = Number(p.date_from.slice(5, 7));
    const mt = Number(p.date_to.slice(5, 7));
    const df = Number(p.date_from.slice(8, 10));
    return mf === mt ? `${df} – ${this.dia(p.date_to)}`
      : `${df} ${this.MESES[mf - 1]} – ${this.dia(p.date_to)}`;
  }

  /** Para un timestamp si vale `Date`: es un instante, no una fecha de negocio. */
  cuando(ts: string | null): string {
    if (!ts) return 'sin fecha';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'sin fecha';
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.round(min / 60)} h`;
    return `hace ${Math.round(min / 1440)} d`;
  }

  /**
   * ⛔ Antes todo lo que no tenía corrida decía **"sin corrida"**, y eso tapaba la distinción
   * que más importa: la quincena que está corriendo todavía no puede tener número, y la que
   * cerró hace diez días y no lo tiene es trabajo pendiente. El mismo chip gris para las dos
   * hacía que una quincena olvidada se viera normal.
   */
  /**
   * ⭐ La ruta tiene menos días con venta que sus hermanas de plaza. Medido contra el libro
   * (Q10–Q20): de 22 marcadas, **14 descuadran de verdad y 8 no** — ésas cuadran al 0.0% porque
   * el camión en serio no salió. Por eso se señala y no se tacha nada.
   */
  /**
   * ⚠️ `fallas` y `saltadas` NO se tragan ni se resumen en "listo": una quincena que el motor se
   * negó a tocar es trabajo que sigue pendiente, y esconderla haría leer como terminado lo que
   * no lo está. Se recarga el tablero igual, porque lo que SÍ se calculó ya está escrito.
   */
  recalcularDesde(periodId: string): void {
    if (this.recalculando()) return;
    this.recalculando.set(true);
    this.recalc.set(null);
    this.err.set(null);
    this.api.commissionRecalculateFrom(periodId).subscribe({
      next: (r) => {
        this.recalc.set(r);
        this.recalculando.set(false);
        this.cargar();
      },
      error: (e) => {
        this.recalculando.set(false);
        this.err.set(e?.error?.message ?? 'No se pudo calcular.');
      },
    });
  }

  diasCortos(l: CommissionLine): boolean {
    return l.dias_con_venta != null && l.dias_esperados != null && l.dias_con_venta < l.dias_esperados;
  }

  tipDias(l: CommissionLine): string {
    if (l.dias_con_venta == null) return 'Esta ruta no tuvo fuente en el periodo.';
    const esp = l.dias_esperados;
    if (esp == null) return `${l.dias_con_venta} día(s) con venta.`;
    if (l.dias_con_venta >= esp) return `${l.dias_con_venta} días, los mismos que sus hermanas de plaza.`;
    return `${l.dias_con_venta} días contra los ${esp} que trabajaron sus hermanas de plaza. `
      + 'Puede ser que el camión no salió, o que la fuente perdió el día: el motor no los distingue, '
      + 'porque la fuente es el único testigo de las dos cosas.';
  }

  etiquetaEstado(p: CommissionBoardRow): string {
    if (p.estado_calculo === 'futura') return 'no empieza';
    if (p.estado_calculo === 'en_curso') return 'en curso';
    if (p.estado_calculo === 'sin_calcular') return 'sin calcular';
    const M: Record<string, string> = {
      en_curso: 'en curso', borrador: 'borrador', bloqueada: 'bloqueada',
      aprobado: 'aprobada', pagado: 'pagada',
    };
    return p.status ? (M[p.status] ?? p.status) : 'sin corrida';
  }

  sev(p: CommissionBoardRow): 'success' | 'warn' | 'danger' | 'secondary' | 'info' {
    // Ámbar, no gris: cerró y nadie la calculó. Es lo único de este tablero que pide acción.
    if (p.estado_calculo === 'sin_calcular') return 'warn';
    if (p.status === 'pagado') return 'success';
    if (p.status === 'aprobado') return 'info';
    if (p.status === 'bloqueada') return 'danger';
    return 'secondary';
  }

  etiquetaGate(g: string): string {
    const M: Record<string, string> = {
      periodo_cerrado: 'La quincena no cerró',
      corte_de_sistema: 'Cruza un cambio de sistema',
      cobertura: 'Cobertura',
      frescura: 'El dato no llegó completo',
      bono_arbitrado: 'Bono sobre costo no arbitrado',
      deduccion_configurada: 'Deducción sin cargar',
    };
    return M[g] ?? g;
  }

  etiquetaVeredicto(v: string | null): string {
    const M: Record<string, string> = {
      bajo_umbral: 'bajo umbral',
      sin_dato_en_la_fuente: 'sin dato en la fuente',
      fuera_no_es_camion: 'no es ruta de camión',
      camion_sin_config: 'camión sin configurar',
      camion_sin_identidad: 'sin embarque documentado',
      config_inactiva: 'configuración inactiva',
      tipo_sin_declarar: 'tipo de ruta sin declarar',
    };
    return v ? (M[v] ?? v) : '';
  }

  etiquetaCosto(v: string): string {
    const M: Record<string, string> = {
      sin_costo: 'sin costo',
      solo_wincaja_reexpresado: 'costo inestable',
      una_fuente_embarque: 'costo de una fuente',
      una_fuente_erp: 'costo de una fuente',
      una_fuente: 'costo de una fuente',
    };
    return M[v] ?? v;
  }

  tipCosto(v: string): string {
    if (v === 'sin_costo') return 'No hay costo en la fuente para estos días: el markup no se puede medir y el bono del supervisor no paga.';
    if (v === 'solo_wincaja_reexpresado') return 'El único costo disponible es el que Wincaja re-expresa cada noche: el markup de un mes cerrado cambia solo.';
    return 'El markup descansa en una sola fuente de costo, sin un segundo testigo que lo arbitre.';
  }

  tipMarkup(l: CommissionLine): string {
    const p: string[] = ['Markup sobre costo = (subtotal / costo − 1) × 100. NO es margen sobre venta.'];
    if (l.margen_sobre_venta_pct != null) p.push(`Margen sobre venta: ${this.pct(l.margen_sobre_venta_pct)}%`);
    if (l.cogs_ruta != null) p.push(`Costo del embarque: ${this.money(l.cogs_ruta)}`);
    if (l.cogs_erp != null) p.push(`Costo del ERP (c62): ${this.money(l.cogs_erp)}`);
    return p.join(' · ');
  }

  bonosTip(l: CommissionLine): string {
    if (!l.bonos_detalle?.length) return '';
    return l.bonos_detalle.map((b) => `${b.nombre}: ${this.money(b.monto)} (${b.metrica} > ${b.umbral})`).join(' · ');
  }

  pct(n: number | null | undefined): string {
    if (n == null) return '—';
    return String(Math.round(Number(n) * 1000) / 1000);
  }

  money(n: number | string | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(Number(n));
  }
}
