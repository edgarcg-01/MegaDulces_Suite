import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MeCiclo, MePeriodo } from '@megadulces/contracts';

/**
 * `[SN.16]` — La tira de meses de un trabajo CÍCLICO.
 *
 * ── Por qué así y no una gráfica ────────────────────────────────────────────────────────────
 * Edgar pidió *"una gráfica o tabla"*. Es una tira de celdas dibujada con CSS, por dos razones
 * independientes y las dos medidas:
 *
 *  · `DESIGN.md:471` (BINDING): *"Micro-charts = SVG crudo (0 KB). Nada de Chart.js/Apex"*.
 *  · Chart.js son **+205 KB** en la ruta crítica de `/projects`, que hoy pesa 77 KB y es el
 *    destino por defecto de todos al entrar. Triplicar la primera pantalla por doce puntos de
 *    color no se paga.
 *
 * ── El patrón es prestado, no inventado ─────────────────────────────────────────────────────
 * Calca el riel de meses del Libro de Compras (`libro-compras.styles.ts`), incluida su lección:
 *
 *   > *"Punto + texto, NO pastilla llena: son 105 meses en el rail y 105 pastillas de color le
 *   > compiten a la única acción naranja de la pantalla. El estado del mes es orientación, no
 *   > alarma."*
 *
 * Por eso el color va en un punto de 6 px y nunca en el fondo de la celda.
 *
 * ── Lo que la tira NO hace ──────────────────────────────────────────────────────────────────
 * ⛔ No dice si el mes **cuadra**. Ese veredicto vive en la pestaña Cierre (`diagnostico`) y
 * cuesta ~8 consultas por mes. Acá van los hechos del avance; el veredicto está a un clic.
 * ⛔ Un mes `sin_datos` **no es un enlace**: no hay con qué trabajarlo, y mandar a alguien a una
 * pantalla que no le puede contestar nada es peor que no ofrecerle el camino.
 */
@Component({
  selector: 'app-periodo-strip',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ps" [class.is-mine]="ciclo().es_mio">
      <div class="ps-head">
        <span class="ps-ico"><i [class]="ciclo().icono" aria-hidden="true"></i></span>
        <span class="ps-txt">
          <span class="ps-l">{{ ciclo().label }}</span>
          <span class="ps-d">{{ resumen() }}</span>
        </span>
      </div>

      <!--
        [SN.29] Un ciclo SIN UN SOLO MES trabajable no dibuja la tira: dibuja una linea.

        Medido en la captura que disparo esta correccion: tres de los cuatro ciclos venian con los
        12 meses sin datos, o sea 36 de 48 celdas diciendo "no hay con que trabajar esto".
        Ocupaban ~40% de la columna de trabajo para declarar una ausencia. Es la misma regla que
        [SN.7] ya aplica a las bandejas -- "una bandeja en 0 no se pinta" -- y un ciclo sin meses
        trabajables tiene exactamente esa forma.

        ⛔ Se COLAPSA, no se esconde: quien responde de esta conciliacion necesita saber que no hay
        estado de cuenta cargado en ningun mes. Lo que se retira son los 12 objetos vacios, no el
        hecho. La tira completa vuelve sola en cuanto un mes tenga datos.
      -->
      @if (sinNadaQueHacer()) {
        <p class="ps-nada">{{ motivoVacio() }}</p>
      } @else {
      <ul class="ps-tira" [attr.aria-label]="'Avance por mes de ' + ciclo().label">
        @for (p of ciclo().periodos; track p.periodo) {
          <li>
            @if (p.ruta) {
              <a
                class="ps-mes"
                [class]="'e-' + p.estado"
                [routerLink]="p.ruta"
                [queryParams]="p.queryParams"
                [title]="titulo(p)"
                (click)="abrio.emit(p)">
                <span class="ps-mes-n">{{ mes(p.periodo) }}</span>
                <span class="ps-dot" aria-hidden="true"></span>
                <span class="ps-sr">{{ titulo(p) }}</span>
              </a>
            } @else {
              <!--
                [SN.24] Sin ruta hay DOS motivos distintos y no se pueden dibujar igual:
                  sin_datos  -> no hay con que trabajar ese mes: apagado y punteado.
                  el resto   -> el mes SI tiene trabajo, pero tu permiso no abre la pantalla.
                Pintar el segundo como vacio diria que no hay nada, que es falso (ADR-056).
              -->
              <span
                class="ps-mes"
                [class]="'e-' + p.estado"
                [class.is-vacio]="p.estado === 'sin_datos'"
                [class.is-cerrado]="p.estado !== 'sin_datos'"
                [title]="titulo(p)">
                <span class="ps-mes-n">{{ mes(p.periodo) }}</span>
                <span class="ps-dot" aria-hidden="true"></span>
                <span class="ps-sr">{{ titulo(p) }}</span>
              </span>
            }
          </li>
        }
      </ul>
      }
    </div>
  `,
  styles: [
    `
      .ps { margin-bottom: var(--sp-3); }
      .ps-head { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-2); }
      .ps-ico {
        display: inline-flex; align-items: center; justify-content: center;
        width: 1.75rem; height: 1.75rem; flex: none;
        border-radius: var(--r-sm); background: var(--layout-bg); color: var(--text-muted);
        font-size: var(--fs-xs);
      }
      /* [SN.17] Mismo lenguaje que una fila .mt-task.is-mine: el chip en sunset dice "esto es
         tuyo". Lo decide la responsabilidad declarada, no el permiso.
         ⚠️ SIN backticks en este bloque: es un template literal y los cierra (ver GOTCHAS). */
      .ps.is-mine .ps-ico { background: var(--action); color: var(--action-ink); }
      .ps-txt { min-width: 0; display: flex; flex-direction: column; }
      .ps-l { font-size: var(--fs-sm); font-weight: var(--fw-semibold); }
      .ps-d { font-size: var(--fs-micro); color: var(--text-faint); }

      .ps-tira {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: var(--sp-1, 4px);
        margin: 0; padding: 0; list-style: none;
      }
      /* La celda es un objeto chico con el mismo lenguaje que una fila de bandeja:
         hairline, radio, sin sombra (DESIGN.md: la profundidad in-page la lleva el borde). */
      .ps-mes {
        display: flex; flex-direction: column; align-items: center; gap: 3px;
        padding: var(--sp-1, 4px) 2px;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-sm);
        color: inherit; text-decoration: none;
        transition: border-color var(--dur-short) var(--ease-out), transform var(--dur-short) var(--ease-out);
      }
      a.ps-mes:hover { border-color: var(--text-muted); transform: translateY(-1px); }
      a.ps-mes:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
      .ps-mes-n {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: var(--fs-nano); letter-spacing: .02em; color: var(--text-muted);
      }
      /* El color codifica el dato — la excepción data-viz que DESIGN.md declara. Va en 6 px de
         punto, no en el fondo: el estado del mes es orientación, no alarma. */
      .ps-dot { width: 6px; height: 6px; border-radius: var(--r-pill); background: var(--text-faint); }
      .e-al_dia .ps-dot { background: var(--ok-fg); }
      .e-en_proceso .ps-dot { background: var(--warn-fg); }
      .e-sin_empezar .ps-dot { background: var(--bad-fg); }

      /* Sin datos: apagado y sin cursor. No es un pendiente ni un enlace. */
      .ps-mes.is-vacio { background: transparent; border-style: dashed; opacity: .55; cursor: default; }
      .ps-mes.is-vacio .ps-dot { background: var(--border-color); }
      /* [SN.24] Hay trabajo y no se puede abrir: conserva su punto de estado, pierde el clic. */
      .ps-mes.is-cerrado { cursor: not-allowed; opacity: .8; }

      /* [SN.29] El ciclo sin un solo mes trabajable: una linea en lugar de 12 celdas vacias.
         Tono neutro y sin borde -- es una declaracion de ausencia, no un objeto que se abre. */
      .ps-nada {
        margin: 0;
        padding-left: calc(1.75rem + var(--sp-3));
        font-size: var(--fs-micro);
        color: var(--text-faint);
        line-height: 1.4;
      }

      /* Etiqueta para lector de pantalla: el punto no dice nada por sí solo (DESIGN.md: el color
         nunca es el único portador de significado). */
      .ps-sr {
        position: absolute; width: 1px; height: 1px; overflow: hidden;
        clip-path: inset(50%); white-space: nowrap;
      }

      @media (max-width: 80rem) {
        /* En columna angosta 12 celdas quedan por debajo de lo legible: se muestran 6 meses. */
        .ps-tira { grid-template-columns: repeat(6, minmax(0, 1fr)); }
        .ps-tira > li:nth-child(-n + 6) { display: none; }
      }
    `,
  ],
})
export class PeriodoStripComponent {
  readonly ciclo = input.required<MeCiclo>();
  /** Para el registro de uso: qué mes de qué ciclo abrió esta persona. */
  readonly abrio = output<MePeriodo>();

  private readonly fmtMes = new Intl.DateTimeFormat('es-MX', { month: 'short' });
  private readonly fmtLargo = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });

  /** `'2026-02'` → `'FEB'`. Se construye en UTC a mediodía: la cadena ya es el mes de México. */
  mes(periodo: string): string {
    const d = this.fecha(periodo);
    if (!d) return periodo.slice(5);
    return this.fmtMes.format(d).replace('.', '').toUpperCase();
  }

  titulo(p: MePeriodo): string {
    const d = this.fecha(p.periodo);
    const nombre = d ? this.fmtLargo.format(d) : p.periodo;
    return `${nombre} · ${p.motivo}`;
  }

  /**
   * Resumen honesto del ciclo. `sin_datos` se nombra aparte: no es trabajo pendiente, y sumarlo
   * a los otros diría que hay más por hacer de lo que de verdad se puede hacer.
   */
  readonly resumen = computed(() => {
    const ps = this.ciclo().periodos;
    const n = (e: string) => ps.filter((p) => p.estado === e).length;
    const partes: string[] = [];
    if (n('sin_empezar')) partes.push(`${n('sin_empezar')} sin empezar`);
    if (n('en_proceso')) partes.push(`${n('en_proceso')} a medias`);
    if (n('al_dia')) partes.push(`${n('al_dia')} al día`);
    if (n('sin_datos')) partes.push(`${n('sin_datos')} sin datos`);
    return partes.join(' · ') || 'sin periodos que mostrar';
  });

  /**
   * `[SN.29]` ¿Este ciclo tiene ALGÚN mes con el que se pueda trabajar?
   *
   * ⚠️ Se pregunta por `sin_datos`, no por `pendientes === 0`: son cosas distintas y confundirlas
   * es el error que `[SN.16]` peleó para no cometer. Un ciclo **al día** (todos los meses cerrados)
   * también tiene `pendientes === 0` y SÍ merece su tira — esa tira es justamente la prueba de que
   * el trabajo se hizo. Lo que se colapsa es la ausencia de materia prima, no el éxito.
   */
  readonly sinNadaQueHacer = computed(() => {
    const ps = this.ciclo().periodos;
    return ps.length > 0 && ps.every((p) => p.estado === 'sin_datos');
  });

  /** El motivo, tomado del primer periodo: lo declara el backend y no se reescribe acá. */
  readonly motivoVacio = computed(() => {
    const ps = this.ciclo().periodos;
    const motivo = ps[0]?.motivo?.trim();
    const meses = ps.length;
    const base = `Sin datos en los ${meses} meses`;
    return motivo ? `${base} · ${motivo}` : base;
  });

  /** Día 15 a mediodía UTC: ningún corrimiento de zona mueve el mes. */
  private fecha(periodo: string): Date | null {
    const m = /^(\d{4})-(\d{2})$/.exec(periodo);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15, 12));
  }
}
