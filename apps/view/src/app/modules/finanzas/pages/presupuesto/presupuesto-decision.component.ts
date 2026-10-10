import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { PRESUPUESTO_STYLES } from './presupuesto.styles';
import { concentracion, costoDeNoFirmar, llegada, type FilaVenta } from './presupuesto-decision';

/**
 * `[PVI.19]` — **La superficie de DECIDIR.** Answer-first, sin tabla.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────────────────────
 *
 * La vista Ventas abre con 9 renglones x 8 columnas, 4 de ellas vacías. Para quien ARMA el
 * presupuesto está bien. Para quien lo FIRMA es el antipatrón que `DESIGN.md Q.1` manda marcar en
 * review: *«si lo primero que ve el usuario es una tabla en vez de la lectura del periodo, falló»*.
 *
 * Este componente contesta **tres** preguntas en orden de decisión y **declara la cuarta**:
 *
 *   1. Vamos a llegar?            -> `llegada()`
 *   2. Que espera mi firma, y que cuesta no firmar hoy?
 *   3. Donde esta concentrado el riesgo?   -> `concentracion()`
 *   4. Que cambio desde que mire?          -> NO SE PUEDE: no hay foto anterior de la meta.
 *
 * ⛔ La cuarta se declara con su motivo en vez de inventar un delta contra el arranque del año,
 * que se leeria como movimiento sin serlo (ADR-056). Una pantalla ejecutiva que miente una vez
 * deja de usarse.
 *
 * ── Decisiones de diseno, cada una contra su regla ──────────────────────────────────────────
 *
 *  · **Q.1 answer-first** — el veredicto es el elemento dominante y es una FRASE, no un numero.
 *  · **Q.5 tres niveles por tipo y contraste, nunca por color** — primario `--fs-h2`/`--fw-bold`/
 *    `--fg-1`, secundario `--fs-sm`/`--fg-2`, terciario `--fs-xs`/`--fg-3`. El color queda solo
 *    para el tono semantico de la cifra, y nunca es portador unico: siempre va con texto.
 *  · **ADR-033** — la concentracion se pinta con `MetricStrip` en modo `composition`, el arquetipo
 *    del repertorio. No se construye una quinta barra a mano.
 *  · **Q.6** — y por eso son DOS segmentos, no ocho: `composition` colorea por TONO, no por una
 *    paleta categorica, y un color por entidad no podria ser determinista entre pantallas. Los dos
 *    segmentos son «las que cargan el plan» y «la cola», que es la lectura, no la decoracion.
 *  · **Q.3 / Q.4** — la concentracion nombra la entidad exacta y cada renglon es navegable a la
 *    tabla con el filtro puesto. Un numero que evidencia algo y no lleva a arreglarlo viola Q.4.
 *  · **G.1** — ninguna barra con eje recortado: `composition` reparte 100 % de un total real.
 *  · **Matriz de estados** — `cargando` (esqueleto dimensionado, sin salto de layout), vacio con
 *    motivo, y el caso «no se puede contestar» que NO es ninguno de los dos.
 *
 * ── Patron de la casa ───────────────────────────────────────────────────────────────────────
 *
 * Presentacional puro, igual que `presupuesto-ventas.component.ts`: `input.required` + `@Output`,
 * cero HTTP y cero estado propio. Lo que se carga vive en el shell, porque las vistas se montan
 * con `@if` y un hijo con estado lo perderia al cambiar de pestana.
 */
@Component({
  selector: 'app-presupuesto-decision',
  standalone: true,
  imports: [CommonModule, ButtonModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dec" aria-labelledby="dec-h">
      <h2 id="dec-h" class="sr-only">Resumen para decidir</h2>

      @if (cargando()) {
        <div class="dec-skel" aria-busy="true" aria-live="polite">
          <span class="dec-skel-line dec-skel-line--xl"></span>
          <span class="dec-skel-line"></span>
          <span class="dec-skel-line dec-skel-line--sm"></span>
          <span class="sr-only">Cargando el resumen del ejercicio</span>
        </div>
      } @else {

        <!-- 1. El veredicto. Elemento dominante: una frase, no una cifra. -->
        <p class="dec-verdict" [class]="'tone-' + veredicto().tono">
          <i class="pi" [class]="iconoVeredicto()" aria-hidden="true"></i>
          <span>{{ veredicto().frase }}</span>
        </p>
        @if (veredicto().falta.length) {
          <p class="dec-falta">
            Para poder contestarlo falta: <strong>{{ veredicto().falta.join(' y ') }}</strong>.
          </p>
        }

        <!-- 2. Lo que espera la firma, con su consecuencia. -->
        @if (costoFirmas(); as costo) {
          <div class="dec-block dec-block--act">
            <p class="dec-lead">{{ costo }}</p>
            <p-button label="Ver lo que espera tu firma" icon="pi pi-verified" severity="warn"
                      size="small" (onClick)="irAFirmas.emit()" />
          </div>
        }

        <!-- 3. Donde esta concentrado el riesgo. -->
        @if (conc().lectura; as lectura) {
          <div class="dec-block">
            <p class="dec-lead">{{ lectura }}</p>
            <app-metric-strip mode="composition" [items]="reparto()"
                              [total]="conc().total"
                              ariaLabel="Reparto del plan entre las entidades que lo cargan y la cola" />
            <ul class="dec-top">
              @for (e of top(); track e.entity_key || e.label) {
                <li>
                  <button type="button" class="dec-top-row" (click)="verEntidad.emit(e.entity_key)"
                          [attr.aria-label]="'Ver ' + e.label + ' en la tabla del plan'">
                    <span class="dec-top-name">{{ e.label }}</span>
                    <span class="dec-top-ch">{{ e.channel_label }}</span>
                    <span class="dec-top-pct pres-mono">{{ porciento(e.share) }}</span>
                    <span class="dec-top-amt pres-mono">{{ dinero(e.meta) }}</span>
                    <i class="pi pi-angle-right" aria-hidden="true"></i>
                  </button>
                </li>
              }
            </ul>
            @if (conc().cola.length) {
              <p class="dec-note">
                {{ conc().cola.length }} entidades aportan menos del 5 % cada una: su desempeno no
                mueve el total del ejercicio.
              </p>
            }
          </div>
        } @else {
          <div class="dec-block">
            <p class="dec-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              No hay metas por entidad con las que medir la concentracion del plan.
            </p>
          </div>
        }

        <!-- 4. Lo que esta pantalla NO puede contestar, con nombre. -->
        <p class="dec-gap">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>No se puede decir <strong>que cambio desde la ultima vez que miraste</strong>: no se
            guarda una foto anterior de la meta por entidad.</span>
        </p>
      }
    </section>
  `,
  styles: [PRESUPUESTO_STYLES, `
    :host { display:block; container-type:inline-size; }
    .dec { display:flex; flex-direction:column; gap:1rem; }

    .dec-verdict { display:flex; align-items:flex-start; gap:.55rem; margin:0;
      font-size:var(--fs-h2); font-weight:var(--fw-bold); line-height:1.25; color:var(--fg-1); }
    .dec-verdict .pi { font-size:1.1rem; margin-top:.22rem; flex:0 0 auto; }
    .dec-verdict.tone-ok .pi { color:var(--ok-fg); }
    .dec-verdict.tone-warn .pi { color:var(--warn-fg); }
    .dec-verdict.tone-bad .pi { color:var(--bad-fg); }
    .dec-verdict.tone-muted .pi { color:var(--fg-3); }

    .dec-falta { margin:0; font-size:var(--fs-sm); color:var(--fg-2); }
    .dec-falta strong { font-weight:var(--fw-medium); color:var(--fg-1); }

    .dec-block { display:flex; flex-direction:column; gap:.6rem;
      padding:.9rem 0 0; border-top:1px solid var(--surface-border); }
    .dec-block--act { flex-direction:row; align-items:center; justify-content:space-between;
      gap:1rem; flex-wrap:wrap; }
    .dec-lead { margin:0; font-size:var(--fs-sm); color:var(--fg-2); max-width:62ch; }

    .dec-top { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
    .dec-top-row { width:100%; display:grid; align-items:center; gap:.6rem;
      grid-template-columns: minmax(0,1fr) auto 4.5rem 8rem 1rem;
      padding:.4rem .35rem; background:none; border:0; border-radius:var(--radius-sm);
      color:inherit; font:inherit; text-align:left; cursor:pointer;
      transition:background-color 150ms ease-out; }
    .dec-top-row:hover { background:var(--surface-hover); }
    .dec-top-row:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .dec-top-name { font-size:var(--fs-sm); color:var(--fg-1); overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    .dec-top-ch { font-size:var(--fs-xs); color:var(--fg-3); }
    .dec-top-pct { font-size:var(--fs-sm); color:var(--fg-1); text-align:right; }
    .dec-top-amt { font-size:var(--fs-sm); color:var(--fg-2); text-align:right; }
    .dec-top-row .pi { font-size:.8rem; color:var(--fg-3); }

    .dec-note, .dec-gap { margin:0; font-size:var(--fs-xs); color:var(--fg-3);
      display:flex; align-items:flex-start; gap:.4rem; }
    .dec-gap { padding-top:.9rem; border-top:1px solid var(--surface-border); }
    .dec-gap .pi, .dec-note .pi { margin-top:.15rem; flex:0 0 auto; }
    .dec-gap strong { font-weight:var(--fw-medium); color:var(--fg-2); }

    .dec-skel { display:flex; flex-direction:column; gap:.7rem; }
    .dec-skel-line { display:block; height:1rem; border-radius:var(--radius-sm);
      background:rgb(var(--ink-rgb) / .07); }
    .dec-skel-line--xl { height:1.9rem; width:70%; }
    .dec-skel-line--sm { width:40%; }

    @container (max-width: 34rem) {
      .dec-top-row { grid-template-columns: minmax(0,1fr) 4.5rem 1rem; }
      .dec-top-ch, .dec-top-amt { display:none; }
      .dec-verdict { font-size:var(--fs-h3); }
    }

    @media (prefers-reduced-motion: reduce) {
      .dec-top-row { transition:none; }
    }
  `],
})
export class PresupuestoDecisionComponent {
  /** Los renglones del plan, con sus subtotales incluidos: el engine los descarta. */
  readonly filas = input.required<FilaVenta[]>();
  readonly meta = input<number | null>(null);
  readonly real = input<number | null>(null);
  readonly realDisponible = input<boolean>(true);
  readonly periodosSinMeta = input<number>(0);
  /** Lo que espera una firma. `null` = todavia no se midio (distinto de cero). */
  readonly firmas = input<{ total: number; monto: number | null } | null>(null);
  readonly cargando = input<boolean>(false);

  /** Q.4: el numero lleva a su lugar de arreglo, con el filtro puesto. */
  @Output() readonly verEntidad = new EventEmitter<string | null>();
  @Output() readonly irAFirmas = new EventEmitter<void>();

  protected readonly conc = computed(() => concentracion(this.filas()));

  protected readonly veredicto = computed(() =>
    llegada(this.meta(), this.real(), {
      realDisponible: this.realDisponible(),
      periodosSinMeta: this.periodosSinMeta(),
    }));

  protected readonly costoFirmas = computed(() => {
    const f = this.firmas();
    return f ? costoDeNoFirmar(f.total, f.monto) : null;
  });

  /** Las que cargan el plan, nombradas una por una. El resto es cola y no se enumera. */
  protected readonly top = computed(() => this.conc().entidades.slice(0, this.conc().cuantas));

  /**
   * Los DOS segmentos de la barra. Ver la nota de Q.6 arriba: `composition` colorea por tono, no
   * por categoria, asi que ocho segmentos serian ocho colores sin significado estable.
   */
  protected readonly reparto = computed<MetricStripItem[]>(() => {
    const c = this.conc();
    if (!c.entidades.length) return [];
    const cargan = c.entidades.slice(0, c.cuantas).reduce((s, e) => s + e.meta, 0);
    const resto = c.total - cargan;
    const items: MetricStripItem[] = [
      { label: `${c.cuantas} entidades cargan el plan`, value: cargan, format: 'currency-short', tone: 'brand' },
    ];
    if (resto > 0) {
      items.push({ label: `Las otras ${c.de_cuantas - c.cuantas}`, value: resto, format: 'currency-short', tone: 'muted' });
    }
    return items;
  });

  protected iconoVeredicto(): string {
    const t = this.veredicto().tono;
    return t === 'ok' ? 'pi-check-circle' : t === 'bad' ? 'pi-times-circle'
      : t === 'warn' ? 'pi-exclamation-circle' : 'pi-minus-circle';
  }

  protected porciento(x: number): string {
    return `${Math.round(x * 1000) / 10} %`;
  }

  protected dinero(n: number): string {
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
