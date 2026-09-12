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
    <div class="ps">
      <div class="ps-head">
        <span class="ps-ico"><i [class]="ciclo().icono" aria-hidden="true"></i></span>
        <span class="ps-txt">
          <span class="ps-l">{{ ciclo().label }}</span>
          <span class="ps-d">{{ resumen() }}</span>
        </span>
      </div>

      <!--
        Los 12 meses SIEMPRE están, del más viejo al más nuevo. Un mes sin datos viene declarado
        y se dibuja apagado — nunca se omite, porque un hueco en la tira se leería como que ese
        mes no existe en vez de como que no hay con qué trabajarlo.
      -->
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
              <span class="ps-mes is-vacio" [title]="titulo(p)">
                <span class="ps-mes-n">{{ mes(p.periodo) }}</span>
                <span class="ps-dot" aria-hidden="true"></span>
                <span class="ps-sr">{{ titulo(p) }}</span>
              </span>
            }
          </li>
        }
      </ul>
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

  /** Día 15 a mediodía UTC: ningún corrimiento de zona mueve el mes. */
  private fecha(periodo: string): Date | null {
    const m = /^(\d{4})-(\d{2})$/.exec(periodo);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15, 12));
  }
}
