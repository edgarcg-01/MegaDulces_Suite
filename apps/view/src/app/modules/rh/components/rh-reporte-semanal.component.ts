import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import {
  type ColumnaDia, type GrupoDepartamento, type Irregularidad, celdaDe, cuentaIrregular, departamentoDe, diasPorFecha, difHorario,
  firmaHoras, horarioDe, horasTexto,
} from '../reporte-formato';

/**
 * Fase RH · `[RH.1.7c]` — el reporte semanal «calcado» de Mega Talento: una fila por persona y una columna por día,
 * agrupado por departamento, con subtotales y totales. Debajo de cada día, D (desayuno) y C (comida), en ámbar si se
 * pasó; en rojo la entrada tarde y la falta. La fila entera abre la ficha.
 *
 * Sólo pinta: los grupos llegan ya filtrados y las irregularidades ya calculadas (las mismas que cuentan la línea de
 * arriba y la ficha). El subtotal es del departamento COMPLETO y sólo sale sin búsqueda: con una búsqueda puesta se
 * leería como la suma de los renglones visibles.
 */
@Component({
  selector: 'app-rh-reporte-semanal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="rs-estrecha">En pantalla chica se ven los totales de cada quien: toca a una persona para ver su semana día por día.</p>
    <div class="rs-scroll">
      <table class="rs-tabla dt-matrix-ok">
        <thead>
          <tr>
            <th class="rs-clv" scope="col">Clv</th>
            <th class="rs-nom" scope="col">Nombre</th>
            <th class="rs-hor-h" scope="col" title="Asignado por RH, o el que se deduce de sus checadas">Horario</th>
            @for (c of columnas(); track c.fecha) {
              <th class="rs-dia" [class.hoy]="c.hoy" scope="col">{{ c.dow }}<span>{{ c.dia }}</span></th>
            }
            <th class="num" scope="col" title="Horas netas del periodo: jornada menos comida. En Oficinas el desayuno no se descuenta.">Horas</th>
            <th class="num" scope="col" [title]="mideRetardo() ? 'Minutos tarde en la entrada contra su hora. La tolerancia semanal se aplica en la pestaña Tolerancia.' : 'Esta plaza no tiene hora límite de entrada: no se mide retardo.'">{{ mideRetardo() ? 'Min. retardo' : 'Retardo' }}</th>
            @if (hayAsignados()) { <th class="num" scope="col" title="Horas trabajadas menos las que pide su horario asignado">vs. horario</th> }
            <th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          @for (g of modelo(); track g.departamento) {
            <tr class="rs-depto"><td [attr.colspan]="ncol()"><span>{{ g.departamento }} <small>({{ g.personas.length === g.total ? g.total : g.personas.length + ' de ' + g.total }})</small></span></td></tr>
            @for (f of g.filas; track f.p.codigo) {
              <tr class="rs-fila" [class.irr]="f.alta > 0" tabindex="0" (click)="abrir.emit(f.p)" (keydown.enter)="abrir.emit(f.p)"
                  [attr.aria-label]="'Abrir la ficha de ' + (f.p.nombreCompleto || f.p.nombre)">
                <td class="rs-clv">{{ f.p.codigo }}</td>
                <td class="rs-nom" [title]="f.p.nombreCompleto || f.p.nombre">
                  <span class="rs-n" [class.reloj]="!f.p.registrado">{{ f.p.nombreCompleto || f.p.nombre }}</span>
                  @if (f.alta) { <span class="rs-pill alta" [title]="f.alta + ' irregularidad' + (f.alta === 1 ? '' : 'es') + ': abre su ficha para ver cuáles'">{{ f.alta }}</span> }
                  @else if (f.baja) { <span class="rs-pill baja" [title]="f.baja + ' aviso' + (f.baja === 1 ? '' : 's')">{{ f.baja }}</span> }
                  @for (i of f.incs; track i.codigo) { <span class="rs-inc" [title]="i.etiqueta">{{ i.codigo }}</span> }
                </td>
                <td class="rs-hor" [class.ded]="!f.horario.asignado">{{ f.horario.texto }}</td>
                @for (c of f.celdas; track $index) {
                  <td class="rs-celda" [attr.data-t]="c.tipo" [class.tarde]="c.tarde" [title]="c.titulo">
                    <span class="j">@if (c.partes; as pt) { {{ pt[0] }} - <span class="antes">{{ pt[1] }}</span> } @else { {{ c.jornada }} }</span>
                    @if (c.tramos.length) { <span class="t">@for (t of c.tramos; track $index) { <span>{{ t }}</span> }</span> }
                    @if (c.desMin !== null || c.comMin !== null) {
                      <span class="pz">
                        @if (c.desMin !== null) { <span [class.exc]="c.desExcedido">D {{ c.desMin }}</span> }
                        @if (c.comMin !== null) { <span [class.exc]="c.comExcedida">C {{ c.comMin }}</span> }
                      </span>
                    }
                  </td>
                }
                <td class="num">{{ horas(f.p.minutosTrabajados) }}</td>
                <td class="num" [class.rs-ret]="mideRetardo() && f.p.atrasoBrutoMin > 0">@if (mideRetardo()) { {{ f.p.atrasoBrutoMin || '' }} } @else { <span class="na">—</span> }</td>
                @if (hayAsignados()) { <td class="num" [class.menos]="(f.dif ?? 0) < 0" [class.mas]="(f.dif ?? 0) > 0">{{ firma(f.dif) }}</td> }
                <td class="rs-acc">
                  <button type="button" class="rs-acc-btn" (click)="$event.stopPropagation(); menu.emit({ persona: f.p, evento: $event })"
                          (keydown.enter)="$event.stopPropagation()" [attr.aria-label]="'Acciones para ' + (f.p.nombreCompleto || f.p.nombre)">
                    <i class="pi pi-ellipsis-h" aria-hidden="true"></i>
                  </button>
                </td>
              </tr>
            }
            @if (subtotales()) {
              <tr class="rs-sub">
                <td [attr.colspan]="columnas().length + 3"><span class="sr-only">Subtotal de {{ g.departamento }}</span></td>
                <td class="num">{{ horas(g.subMin) }}</td>
                <td class="num">{{ mideRetardo() ? g.subRet : '' }}</td>
                @if (hayAsignados()) { <td></td> }
                <td></td>
              </tr>
            }
          }
        </tbody>
        <tfoot>
          <tr>
            <td [attr.colspan]="columnas().length + 3">{{ parcial() ? 'Totales de lo que se ve' : 'Totales' }}</td>
            <td class="num">{{ horas(totales().min) }}</td>
            <td class="num">{{ mideRetardo() ? totales().ret : '—' }}</td>
            @if (hayAsignados()) { <td></td> }
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .rs-scroll { overflow: auto; max-height: calc(100vh - 300px); border-top: 1px solid var(--border-color); }
    .rs-tabla { border-collapse: separate; border-spacing: 0; width: 100%; font-size: var(--fs-xs); }
    .rs-tabla th { position: sticky; top: 0; z-index: 2; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-micro); font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em; text-align: left; padding: var(--sp-2); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    .rs-tabla td { padding: 6px var(--sp-2); border-bottom: 1px solid var(--border-color); vertical-align: top; background: var(--card-bg); color: var(--text-main); }
    .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    th.num { text-align: right; }
    .rs-clv { position: sticky; left: 0; z-index: 1; width: 3.4rem; min-width: 3.4rem; font-family: var(--font-mono); color: var(--text-muted); }
    .rs-nom { position: sticky; left: 3.4rem; z-index: 1; min-width: 13rem; max-width: 16rem; border-right: 1px solid var(--border-color); }
    th.rs-clv, th.rs-nom { z-index: 3; }
    .rs-n { font-weight: 600; overflow-wrap: anywhere; }
    .rs-n.reloj { font-style: italic; }
    .rs-pill { display: inline-block; margin-left: 4px; font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 5px; border-radius: var(--r-pill); vertical-align: 1px; }
    .rs-pill.alta { background: var(--bad-fg); color: var(--card-bg); }
    .rs-pill.baja { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rs-inc { display: inline-block; margin-left: 4px; font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 4px; border-radius: var(--r-sm);
      background: var(--info-soft-bg); color: var(--info-soft-fg); vertical-align: 1px; }
    .rs-hor { white-space: nowrap; font-family: var(--font-mono); }
    .rs-hor.ded { font-family: var(--font-body); color: var(--text-muted); }
    th.rs-dia { text-align: center; }
    th.rs-dia span { display: block; font: 700 var(--fs-sm)/1.2 var(--font-mono); color: var(--text-main); letter-spacing: 0; }
    th.rs-dia.hoy span { color: var(--action); }
    td.rs-celda { min-width: 6.6rem; text-align: center; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rs-celda .j { display: block; font-weight: 500; white-space: nowrap; }
    .rs-celda .t { display: block; color: var(--text-muted); font-size: var(--fs-micro); line-height: 1.35; }
    .rs-celda .t span { display: inline-block; white-space: nowrap; margin: 0 2px; }
    .rs-celda .pz { display: flex; justify-content: center; gap: 6px; font-size: var(--fs-micro); color: var(--text-muted); margin-top: 1px; }
    .rs-celda .exc, .rs-celda .antes { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-radius: 3px; padding: 0 3px; font-weight: 700; }
    .rs-celda.tarde .j { color: var(--bad-fg); font-weight: 700; }
    .rs-celda[data-t='falta'] .j, .rs-celda[data-t='marca'] .j { color: var(--bad-fg); font-weight: 700; }
    .rs-celda[data-t='falta'], .rs-celda[data-t='marca'] { box-shadow: inset 0 0 0 1px var(--bad-border); }
    .rs-celda[data-t='inc'] .j, .rs-celda[data-t='just'] .j { color: var(--info-soft-fg); font-weight: 700; }
    .rs-celda[data-t='descanso'] .j, .rs-celda[data-t='desc_aus'] .j, .rs-celda[data-t='vacio'] .j, .rs-celda[data-t='sin_checar_hoy'] .j { color: var(--text-faint); }
    .rs-ret { color: var(--bad-fg); font-weight: 700; }
    .na { color: var(--text-faint); }
    .menos { color: var(--warn-soft-fg); }
    .mas { color: var(--ok-soft-fg); }
    tr.rs-fila { cursor: pointer; }
    tr.rs-fila:hover td { background: var(--surface-hover-bg); }
    tr.rs-fila.irr td { background: var(--bad-soft-bg); }
    tr.rs-fila:focus-visible td { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    tr.rs-depto td { background: var(--surface-2); font-size: var(--fs-micro); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-muted); padding-block: 5px; }
    tr.rs-depto td span { position: sticky; left: var(--sp-2); }
    tr.rs-depto small { font-weight: 500; letter-spacing: 0; }
    tr.rs-sub td { color: var(--text-muted); font-weight: 600; border-bottom-width: 2px; }
    tfoot td { background: var(--surface-2); font-weight: 700; position: sticky; bottom: 0; }
    .rs-acc { width: 2.2rem; }
    .rs-acc-btn { border: 0; background: none; border-radius: var(--r-sm); padding: 2px 6px; color: var(--text-muted); cursor: pointer; }
    .rs-acc-btn:hover { background: var(--surface-hover-bg); color: var(--text-main); }
    .rs-acc-btn:focus-visible { outline: 2px solid var(--focus-ring); }
    .rs-estrecha { display: none; }
    /* Es un PIVOTE (persona x día): en un teléfono pierde el eje de los días (DESIGN_TABLES §6, caso B). Quedan
       quién es y sus totales; la semana día por día está en la ficha, en vertical. Se anuncia arriba. */
    @media (max-width: 34rem) {
      .rs-estrecha { display: block; margin: 0; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
      th.rs-dia, td.rs-celda, .rs-hor, .rs-hor-h, tr.rs-sub { display: none; }
      .rs-nom { min-width: 9.5rem; position: static; border-right: 0; }
      .rs-clv { position: static; }
      .rs-scroll { max-height: none; }
    }
  `],
})
export class RhReporteSemanalComponent {
  readonly grupos = input.required<GrupoDepartamento[]>();
  /** Todas las personas de la plaza (para el subtotal del departamento completo). */
  readonly todas = input.required<HrPersonaAsistencia[]>();
  readonly columnas = input.required<ColumnaDia[]>();
  readonly irregularidades = input.required<Map<string, Irregularidad[]>>();
  readonly hoy = input.required<string>();
  readonly mideRetardo = input(true);
  /** Hay un filtro puesto: los totales son «de lo que se ve» y no hay subtotales. */
  readonly parcial = input(false);
  readonly subtotales = input(true);

  readonly abrir = output<HrPersonaAsistencia>();
  readonly menu = output<{ persona: HrPersonaAsistencia; evento: Event }>();

  readonly horas = horasTexto;
  readonly firma = firmaHoras;

  readonly hayAsignados = computed(() => this.todas().some((p) => !!p.horarioAsignado));
  readonly ncol = computed(() => this.columnas().length + 5 + (this.hayAsignados() ? 1 : 0));

  readonly modelo = computed(() => {
    const o = { hoy: this.hoy(), mideRetardo: this.mideRetardo() };
    const cols = this.columnas();
    const irr = this.irregularidades();
    const todas = this.todas();
    return this.grupos().map((g) => {
      const completo = todas.filter((p) => departamentoDe(p) === g.departamento);
      return {
        ...g,
        subMin: completo.reduce((t, p) => t + p.minutosTrabajados, 0),
        subRet: completo.reduce((t, p) => t + p.atrasoBrutoMin, 0),
        filas: g.personas.map((p) => {
          const dias = diasPorFecha(p);
          const lista = irr.get(p.codigo) ?? [];
          const incs = new Map<string, string>();
          for (const i of p.incidencias) if (!incs.has(i.codigo)) incs.set(i.codigo, i.etiqueta);
          return {
            p,
            celdas: cols.map((c) => {
              const x = celdaDe(p, dias, c.fecha, o);
              // La salida antes de hora va en ámbar: se parte aquí, no en la plantilla.
              return { ...x, partes: x.salioAntes ? x.jornada.split(' - ') : null };
            }),
            horario: horarioDe(p),
            alta: cuentaIrregular(lista, 'alta'),
            baja: cuentaIrregular(lista, 'baja'),
            incs: [...incs.entries()].map(([codigo, etiqueta]) => ({ codigo, etiqueta })),
            dif: difHorario(p),
          };
        }),
      };
    });
  });

  readonly totales = computed(() => {
    const vis = this.grupos().flatMap((g) => g.personas);
    return { min: vis.reduce((t, p) => t + p.minutosTrabajados, 0), ret: vis.reduce((t, p) => t + p.atrasoBrutoMin, 0) };
  });
}
