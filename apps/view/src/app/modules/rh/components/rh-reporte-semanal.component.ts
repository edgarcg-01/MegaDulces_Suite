import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import {
  type ColumnaDia, type GrupoDepartamento, type Irregularidad, celdaDe, cuentaIrregular, departamentoDe, diasPorFecha, difHorario,
  firmaHoras, horarioPartes, horasTexto, saldoHorasTexto,
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
            <th class="num rs-c-gano" scope="col" title="Horas extra GANADAS en el periodo: lo que se quedó después de su hora de salida, en bloques de 30 min.">Extra ganó</th>
            <th class="num rs-c-uso" scope="col" title="Horas extra USADAS en el periodo («Uso de horas extra» en Incidencias): se suman a sus horas.">Extra usó</th>
            <th class="num rs-c-saldo" scope="col" [title]="saldos() ? 'Saldo de horas extra al último día del periodo: todo lo ganado menos lo usado, más los ajustes. El detalle está en la pestaña Horas extra.' : 'No se pudo leer el saldo de horas extra.'">Extra saldo</th>
            <th class="num" scope="col" [title]="mideRetardo() ? 'Minutos tarde en la entrada contra su hora. La tolerancia semanal se aplica en la pestaña Tolerancia.' : 'Esta plaza no tiene hora límite de entrada: no se mide retardo.'">{{ mideRetardo() ? 'Retardo (min)' : 'Retardo' }}</th>
            @if (hayAsignados()) { <th class="num rs-c-vs" scope="col" title="Horas trabajadas menos las que pide su horario asignado">vs. horario</th> }
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
                  <div class="rs-nom-in">
                    <span class="rs-nom-txt">
                      <span class="rs-n" [class.reloj]="!f.p.registrado">{{ f.p.nombreCompleto || f.p.nombre }}</span>
                      @if (f.alta) { <span class="rs-pill alta" [title]="f.alta + ' irregularidad' + (f.alta === 1 ? '' : 'es') + ': abre su ficha para ver cuáles'">{{ f.alta }}</span> }
                      @else if (f.baja) { <span class="rs-pill baja" [title]="f.baja + ' aviso' + (f.baja === 1 ? '' : 's')">{{ f.baja }}</span> }
                      @for (i of f.incs; track i.codigo) { <span class="rs-inc" [title]="i.etiqueta">{{ i.codigo }}</span> }
                      <!-- Cuando la columna Horario no cabe, su dato baja aquí, debajo del nombre. -->
                      <small class="rs-hor-movil">{{ f.horario.hora }}@if (f.horario.nota) { · {{ f.horario.nota }} }</small>
                    </span>
                    <button type="button" class="rs-acc-btn" (click)="$event.stopPropagation(); menu.emit({ persona: f.p, evento: $event })"
                            (keydown.enter)="$event.stopPropagation()" [attr.aria-label]="'Acciones para ' + (f.p.nombreCompleto || f.p.nombre)">
                      <i class="pi pi-ellipsis-h" aria-hidden="true"></i>
                    </button>
                  </div>
                </td>
                <td class="rs-hor" [class.ded]="!f.horario.asignado">{{ f.horario.hora }}@if (f.horario.nota) { <small>{{ f.horario.nota }}</small> }</td>
                @for (c of f.celdas; track $index) {
                  <td class="rs-celda" [attr.data-t]="c.tipo" [class.tarde]="c.tarde" [title]="c.titulo">
                    <span class="j">@if (c.partes; as pt) { {{ pt[0] }}–<span class="antes">{{ pt[1] }}</span> } @else { {{ rango(c) }} }</span>
                    @if (c.tramos.length) { <span class="t">@for (t of c.tramos; track $index) { <span>{{ t }}</span> }</span> }
                    <!-- [RH.13.5] D y C sólo cuando se pasó: «C 60» en 37 de 49 celdas era ruido que tapaba las 2 que importaban.
                         El PDF y el Excel siguen trayendo los minutos de todos los días (es el papel de RH). -->
                    @if (c.desExcedido || c.comExcedida) {
                      <span class="pz">
                        @if (c.desExcedido) { <span class="exc">D {{ c.desMin }}</span> }
                        @if (c.comExcedida) { <span class="exc">C {{ c.comMin }}</span> }
                      </span>
                    }
                    @if (c.extraMin) { <span class="rs-extra" [title]="'Horas extra: debía salir a las ' + (c.salidaEsperada || '—')">+{{ horas(c.extraMin) }} extra</span> }
                    @if (c.usadasMin) { <span class="rs-usada">−{{ horas(c.usadasMin) }} usadas</span> }
                  </td>
                }
                <td class="num">{{ horas(f.p.minutosTrabajados) }}</td>
                <td class="num rs-extra-tot rs-c-gano">{{ f.p.horasExtraGanadasMin ? horas(f.p.horasExtraGanadasMin) : '' }}</td>
                <td class="num rs-usada-tot rs-c-uso">{{ f.p.horasExtraUsadasMin ? horas(f.p.horasExtraUsadasMin) : '' }}</td>
                <td class="num rs-c-saldo" [class.rs-neg]="(f.saldo ?? 0) < 0">@if (saldos()) { {{ saldoTexto(f.saldo) }} } @else { <span class="na">—</span> }</td>
                <td class="num" [class.rs-ret]="mideRetardo() && f.p.atrasoBrutoMin > 0">@if (mideRetardo()) { {{ f.p.atrasoBrutoMin || '' }} } @else { <span class="na">—</span> }</td>
                @if (hayAsignados()) { <td class="num rs-c-vs" [class.menos]="(f.dif ?? 0) < 0" [class.mas]="(f.dif ?? 0) > 0">{{ firma(f.dif) }}</td> }
              </tr>
            }
            @if (subtotales()) {
              <tr class="rs-sub">
                <td class="rs-clv"></td>
                <td class="rs-nom rs-sub-et">Subtotal {{ g.departamento }}</td>
                <td class="rs-hor"></td>
                <td class="rs-sub-dias" [attr.colspan]="columnas().length"></td>
                <td class="num">{{ horas(g.subMin) }}</td>
                <td class="num rs-extra-tot rs-c-gano">{{ g.subExtra ? horas(g.subExtra) : '' }}</td>
                <td class="num rs-usada-tot rs-c-uso">{{ g.subUsadas ? horas(g.subUsadas) : '' }}</td>
                <td class="num rs-c-saldo">{{ saldos() ? saldoTexto(g.subSaldo) : '' }}</td>
                <td class="num">{{ mideRetardo() ? g.subRet : '' }}</td>
                @if (hayAsignados()) { <td class="rs-c-vs"></td> }
              </tr>
            }
          }
        </tbody>
        <tfoot>
          <tr>
            <td class="rs-clv"></td>
            <td class="rs-nom rs-sub-et">{{ parcial() ? 'Totales de lo que se ve' : 'Totales' }}</td>
            <td class="rs-hor"></td>
            <td class="rs-sub-dias" [attr.colspan]="columnas().length"></td>
            <td class="num">{{ horas(totales().min) }}</td>
            <td class="num rs-extra-tot rs-c-gano">{{ totales().extra ? horas(totales().extra) : '' }}</td>
            <td class="num rs-usada-tot rs-c-uso">{{ totales().usadas ? horas(totales().usadas) : '' }}</td>
            <td class="num rs-c-saldo">{{ saldos() ? saldoTexto(totales().saldo) : '' }}</td>
            <td class="num">{{ mideRetardo() ? totales().ret : '—' }}</td>
            @if (hayAsignados()) { <td class="rs-c-vs"></td> }
          </tr>
        </tfoot>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; container: rs / inline-size;
      /* [RH.13.5] «Con cuadros» (David, 13-nov): la rejilla se tiene que VER, como en el papel de RH. El hairline del sistema
         (--border-color, 1.27:1 sobre blanco) casi desaparece en una matriz de 7 días; éste sale del texto atenuado, así que
         se ajusta solo al modo oscuro. La línea fuerte separa encabezado, nombre fijo y subtotales. */
      --rs-linea: color-mix(in srgb, var(--text-muted) 30%, var(--card-bg));
      --rs-linea-fuerte: color-mix(in srgb, var(--text-muted) 55%, var(--card-bg)); }
    .rs-scroll { overflow: auto; max-height: calc(100vh - 300px); border: 1px solid var(--rs-linea); border-radius: var(--r-md); }
    .rs-tabla { border-collapse: separate; border-spacing: 0; width: 100%; font-size: var(--fs-xs); }
    /* [RH.13.5] «Hazla tabla» (David, 12-nov): cada día y cada total en SU celda. Sin líneas verticales los números flotaban y
       no se sabía a qué columna pertenecían (HE saldo y Min. retardo se leían corridos). */
    .rs-tabla th { position: sticky; top: 0; z-index: 2; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-micro); font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em; text-align: left; padding: 6px 5px; border-bottom: 2px solid var(--rs-linea-fuerte);
      border-right: 1px solid var(--rs-linea); white-space: nowrap; vertical-align: bottom; }
    .rs-tabla td { padding: 5px 6px; border-bottom: 1px solid var(--rs-linea); border-right: 1px solid var(--rs-linea); vertical-align: top;
      background: var(--card-bg); color: var(--text-main); }
    .rs-tabla th:last-child, .rs-tabla td:last-child { border-right: 0; }
    /* Los totales en dos renglones de encabezado («HE / saldo»): columnas angostas, la tabla cabe sin irse a la derecha. */
    .rs-tabla th.num { white-space: normal; line-height: 1.25; width: 3.6rem; min-width: 3.6rem; }
    .rs-hor-movil { display: none; margin-top: 1px; font: 400 var(--fs-micro)/1.25 var(--font-body); color: var(--text-muted); }
    .rs-sub-et { text-align: left; color: var(--text-muted); font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .rs-tabla td.num { padding-inline: 4px; }
    th.num { text-align: right; }
    .rs-clv { position: sticky; left: 0; z-index: 1; width: 2.6rem; min-width: 2.6rem; font-family: var(--font-mono); color: var(--text-muted); }
    .rs-nom-in { display: flex; align-items: flex-start; gap: 2px; }
    .rs-nom-txt { flex: 1 1 auto; min-width: 0; }
    .rs-nom { position: sticky; left: 2.6rem; z-index: 1; min-width: 9rem; max-width: 13rem; }
    /* La columna fija lleva su borde más marcado: es la que se queda cuando la semana se desplaza. */
    .rs-tabla td.rs-nom, .rs-tabla th.rs-nom { border-right: 2px solid var(--rs-linea-fuerte); }
    th.rs-clv, th.rs-nom { z-index: 3; }
    .rs-n { font-weight: 600; overflow-wrap: anywhere; }
    .rs-n.reloj { font-style: italic; }
    .rs-pill { display: inline-block; margin-left: 4px; font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 5px; border-radius: var(--r-pill); vertical-align: 1px; }
    .rs-pill.alta { background: var(--bad-fg); color: var(--card-bg); }
    .rs-pill.baja { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rs-inc { display: inline-block; margin-left: 4px; font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 4px; border-radius: var(--r-sm);
      background: var(--info-soft-bg); color: var(--info-soft-fg); vertical-align: 1px; }
    .rs-hor { font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 3.8rem; max-width: 6rem; line-height: 1.3; }
    .rs-hor.ded { color: var(--text-muted); }
    .rs-hor small { display: block; font: 400 var(--fs-micro)/1.2 var(--font-body); color: var(--text-faint); }
    th.rs-dia { text-align: center; }
    th.rs-dia span { display: block; font: 700 var(--fs-sm)/1.2 var(--font-mono); color: var(--text-main); letter-spacing: 0; }
    th.rs-dia.hoy span { color: var(--action); }
    .rs-tabla td.rs-celda { min-width: 4.6rem; padding-inline: 3px; text-align: center; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rs-celda .j { display: block; font-weight: 500; white-space: nowrap; }
    .rs-celda .t { display: block; color: var(--text-muted); font-size: var(--fs-micro); line-height: 1.35; }
    .rs-celda .t span { display: inline-block; white-space: nowrap; margin: 0 2px; }
    .rs-celda .pz { display: flex; justify-content: center; gap: 6px; font-size: var(--fs-micro); color: var(--text-muted); margin-top: 1px; }
    .rs-extra { display: block; text-align: center; font-size: var(--fs-micro); font-weight: 700; color: var(--ok-soft-fg); margin-top: 1px; }
    .rs-extra-tot { color: var(--ok-soft-fg); font-weight: 700; }
    .rs-usada { display: block; text-align: center; font-size: var(--fs-micro); font-weight: 700; color: var(--info-soft-fg); margin-top: 1px; }
    .rs-usada-tot { color: var(--info-soft-fg); font-weight: 700; }
    .rs-neg { color: var(--bad-fg); font-weight: 700; }
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
    tr.rs-depto td { border-right: 0; background: var(--surface-2); font-size: var(--fs-micro); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-muted); padding-block: 5px; }
    tr.rs-depto td span { position: sticky; left: var(--sp-2); }
    tr.rs-depto small { font-weight: 500; letter-spacing: 0; }
    tr.rs-sub td { color: var(--text-muted); font-weight: 600; border-bottom: 2px solid var(--rs-linea-fuerte); }
    tfoot td { background: var(--surface-2); font-weight: 700; position: sticky; bottom: 0; border-top: 2px solid var(--rs-linea-fuerte); }
    tfoot tr:last-child td { border-bottom: 0; }
    .rs-acc-btn { border: 0; background: none; border-radius: var(--r-sm); padding: 2px 6px; color: var(--text-muted); cursor: pointer;
      min-width: var(--tap-min); min-height: var(--tap-min); }
    .rs-acc-btn:hover { background: var(--surface-hover-bg); color: var(--text-main); }
    .rs-acc-btn:focus-visible { outline: 2px solid var(--focus-ring); }
    .rs-estrecha { display: none; }
    /* [RH.13.5] «Que se ajuste a cualquier dispositivo» (David, 13-nov). Se mide el ANCHO DE LA TABLA, no la ventana (el menú
       lateral cambia lo que queda). Medido con 7 personas: a 1024 px la tabla pedía 1,137 px en 884; a 768, en 707.
       1) Angosta: la jornada en dos renglones («07:52–» / «17:00»), sin las pausas (se ven al tocar a la persona; lo que se
          PASÓ sigue saliendo) y sin «Extra ganó / usó» (su detalle vive en Horas extra; queda el saldo). */
    @container rs (max-width: 72rem) {
      .rs-tabla td.rs-celda { min-width: 0; }
      .rs-celda .j { white-space: normal; }
      .rs-celda .t { display: none; }
      .rs-c-gano, .rs-c-uso { display: none; }
    }
    /* 2) Más angosta: la columna Horario baja debajo del nombre. */
    @container rs (max-width: 52rem) {
      .rs-hor, .rs-hor-h { display: none; }
      .rs-hor-movil { display: block; }
      .rs-nom { min-width: 7.5rem; }
    }
    /* Es un PIVOTE (persona x día): en un teléfono pierde el eje de los días (DESIGN_TABLES §6, caso B). Quedan
       quién es y sus totales; la semana día por día está en la ficha, en vertical. Se anuncia arriba. */
    @media (max-width: 34rem) {
      .rs-estrecha { display: block; margin: 0; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
      th.rs-dia, td.rs-celda, .rs-sub-dias, .rs-hor, .rs-hor-h, .rs-c-saldo { display: none; }
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
  /** `[RH.6.4]` Saldo de horas extra por código al último día del periodo; null = no se pudo leer (no se pinta un cero). */
  readonly saldos = input<Map<string, number> | null>(null);

  readonly abrir = output<HrPersonaAsistencia>();
  readonly menu = output<{ persona: HrPersonaAsistencia; evento: Event }>();

  readonly horas = horasTexto;
  readonly firma = firmaHoras;
  readonly saldoTexto = saldoHorasTexto;

  readonly hayAsignados = computed(() => this.todas().some((p) => !!p.horarioAsignado));

  /**
   * `[RH.13.5]` En pantalla la jornada es un rango, «07:52–17:00», como las comidas («13:00-14:00»): sin los espacios
   * cabe la semana a 1280 px. La falta sigue «0 - 0» (es la marca del papel de RH, no un rango), y el PDF no cambia.
   */
  rango(c: { tipo: string; jornada: string }): string {
    return c.tipo === 'dia' || c.tipo === 'marca' || c.tipo === 'curso' ? c.jornada.replace(' - ', '–') : c.jornada;
  }

  // Clv, Nombre, Horario + los días + Horas, Extra ganó, Extra usó, Extra saldo y Retardo (+ vs. horario). Antes contaba una
  // de menos y la barra del departamento no llegaba a la última columna.
  readonly ncol = computed(() => this.columnas().length + 8 + (this.hayAsignados() ? 1 : 0));

  readonly modelo = computed(() => {
    const o = { hoy: this.hoy(), mideRetardo: this.mideRetardo() };
    const cols = this.columnas();
    const irr = this.irregularidades();
    const todas = this.todas();
    const saldos = this.saldos();
    const saldoDe = (p: HrPersonaAsistencia): number | null => saldos?.get(p.codigo) ?? null;
    return this.grupos().map((g) => {
      const completo = todas.filter((p) => departamentoDe(p) === g.departamento);
      return {
        ...g,
        subMin: completo.reduce((t, p) => t + p.minutosTrabajados, 0),
        subRet: completo.reduce((t, p) => t + p.atrasoBrutoMin, 0),
        subExtra: completo.reduce((t, p) => t + (p.horasExtraGanadasMin || 0), 0),
        subUsadas: completo.reduce((t, p) => t + (p.horasExtraUsadasMin || 0), 0),
        subSaldo: completo.reduce((t, p) => t + (saldoDe(p) ?? 0), 0),
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
            horario: horarioPartes(p),
            alta: cuentaIrregular(lista, 'alta'),
            baja: cuentaIrregular(lista, 'baja'),
            incs: [...incs.entries()].map(([codigo, etiqueta]) => ({ codigo, etiqueta })),
            dif: difHorario(p),
            saldo: saldoDe(p),
          };
        }),
      };
    });
  });

  readonly totales = computed(() => {
    const vis = this.grupos().flatMap((g) => g.personas);
    const saldos = this.saldos();
    return {
      min: vis.reduce((t, p) => t + p.minutosTrabajados, 0), ret: vis.reduce((t, p) => t + p.atrasoBrutoMin, 0),
      extra: vis.reduce((t, p) => t + (p.horasExtraGanadasMin || 0), 0),
      usadas: vis.reduce((t, p) => t + (p.horasExtraUsadasMin || 0), 0),
      saldo: vis.reduce((t, p) => t + (saldos?.get(p.codigo) ?? 0), 0),
    };
  });
}
