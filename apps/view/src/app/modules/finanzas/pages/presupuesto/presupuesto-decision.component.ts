import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { PRESUPUESTO_STYLES } from './presupuesto.styles';
import {
  bandas, costoDeNoFirmar, fraseConcentracion, leyendaUniverso, llegada, sumaBanda,
  type FilaConcentracion, type VistaConcentracion,
} from './presupuesto-decision';

/**
 * `[PVI.19]`/`[PVI.20]` — **La superficie de DECIDIR.** Answer-first, sin tabla.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────────────────────
 *
 * La vista Ventas abre con 9 renglones x 8 columnas, 4 de ellas vacias. Para quien ARMA el
 * presupuesto esta bien. Para quien lo FIRMA es el antipatron que `DESIGN.md Q.1` manda marcar en
 * review. Esto no reemplaza la tabla: es la otra mitad, para el otro rol.
 *
 * Contesta TRES preguntas y DECLARA la cuarta:
 *
 *   1. Vamos a llegar?            -> `llegada()`
 *   2. Que espera mi firma, y que cuesta no firmar hoy?
 *   3. Donde esta concentrado el riesgo?   -> entra como dato, no se calcula aca
 *   4. Que cambio desde que mire?          -> NO SE PUEDE: no hay foto anterior de la meta.
 *
 * ── ⛔ `[PVI.20]` Las tres correcciones que trajo la auditoria de los carriles hermanos ──────
 *
 * **(1) La concentracion ya NO se calcula aca.** El primitivo unico es
 * `budget-concentration.ts` del carril de Gastos (`[PU.VG.10]`); el mio era el sexto artefacto
 * duplicado del dia y se borro. Este componente la recibe por `input`.
 *
 * **(2) El universo es OBLIGATORIO.** La version anterior decia «4 de 8 entidades cargan el
 * 81.6 % del plan» y ese 81.6 % era de **Mostrador**; del plan cargan el **47.72 %**. Dos
 * denominadores en tres renglones, leidos como el mismo. Ahora `VistaConcentracion` exige
 * `universo` y `parte_de`, y la pantalla no puede renderizar un recorte sin decir de que es
 * recorte.
 *
 * **(3) Ninguna fila se cae.** Antes se pintaban las de cabeza y se contaban las de cola, y las
 * del medio desaparecian: medido, **$45,514,824 en ningun grupo** — y encima eran 2.3x mas
 * grandes que las que la pantalla llamaba chicas. Ahora son TRES bandas que suman el total, y hay
 * un candado que lo verifica.
 *
 * ⚠️ Y el error de encuadre, que no era de codigo: sobre el ejercicio completo el ingreso NO esta
 * concentrado (mayor 20.32 %, 9 de 33 cruzan el 80 %) y el gasto SI (55.50 %, 4 de 14). La
 * version anterior mostraba el unico recorte donde se veia alta. Por eso el universo se declara.
 *
 * ── Decisiones de diseno, cada una contra su regla de DESIGN.md ─────────────────────────────
 *
 *  · **Q.1 answer-first** — el veredicto domina y es una FRASE, no una cifra.
 *  · **Q.5 jerarquia por tipo y contraste, nunca por color** — el tono semantico nunca va solo.
 *  · **ADR-033** — la barra es `MetricStrip` en modo `composition`, del repertorio.
 *  · **Q.6** — TRES segmentos que son las tres bandas: no es una paleta categorica, es la lectura.
 *  · **Q.3 / Q.4** — nombra la partida exacta y cada renglon navega a su arreglo.
 *  · **G.1** — ningun eje recortado: reparte 100 % de un total real.
 *
 * Presentacional puro (`input.required` + `@Output`), cero HTTP: el estado vive en el shell.
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

        <p class="dec-verdict" [class]="'tone-' + veredicto().tono">
          <i class="pi" [class]="iconoVeredicto()" aria-hidden="true"></i>
          <span>{{ veredicto().frase }}</span>
        </p>
        @if (veredicto().falta.length) {
          <p class="dec-falta">
            Para poder contestarlo falta: <strong>{{ veredicto().falta.join(' y ') }}</strong>.
          </p>
        }

        @if (costoFirmas(); as costo) {
          <div class="dec-block dec-block--act">
            <p class="dec-lead">{{ costo }}</p>
            <p-button label="Ver lo que espera tu firma" icon="pi pi-verified" severity="warn"
                      size="small" (onClick)="irAFirmas.emit()" />
          </div>
        }

        @if (conc(); as c) {
          <div class="dec-block">
            <!-- El universo PRIMERO: sin el, el porcentaje de abajo no tiene denominador. -->
            <p class="dec-universo">{{ leyenda() }}</p>
            <p class="dec-lead">{{ frase() }}</p>

            <app-metric-strip mode="composition" [items]="reparto()" [total]="c.total"
                              ariaLabel="Reparto del universo entre las partidas que cruzan el 80 por ciento, las del medio y la cola" />

            <ul class="dec-top">
              @for (e of banda().cabeza; track e.id || e.concepto) {
                <li>
                  <button type="button" class="dec-top-row" (click)="verPartida.emit(e.id)"
                          [attr.aria-label]="'Ver ' + e.concepto + ' en la tabla del plan'">
                    <span class="dec-top-name">{{ e.concepto }}</span>
                    <span class="dec-top-pct pres-mono">{{ cifraPct(e.pct) }}</span>
                    <span class="dec-top-amt pres-mono">{{ dinero(e.monto) }}</span>
                    <i class="pi pi-angle-right" aria-hidden="true"></i>
                  </button>
                </li>
              }
            </ul>

            <!-- ⛔ Las otras dos bandas EXISTEN en pantalla. Antes el medio se caia en silencio. -->
            <dl class="dec-bandas">
              @if (banda().medio.length) {
                <div>
                  <dt>{{ banda().medio.length }} partidas intermedias</dt>
                  <dd class="pres-mono">{{ dinero(sumaMedio()) }}</dd>
                </div>
              }
              @if (banda().cola.length) {
                <div>
                  <dt>{{ banda().cola.length }} bajo el 5 % cada una</dt>
                  <dd class="pres-mono">{{ dinero(sumaCola()) }}</dd>
                </div>
              }
              @if (c.sin_monto) {
                <div>
                  <dt>{{ c.sin_monto }} sin monto legible</dt>
                  <dd class="dec-nd">no medible</dd>
                </div>
              }
            </dl>

            @if (banda().cola.length) {
              <p class="dec-note">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>Las {{ banda().cola.length }} de la cola aportan menos del 5 % cada una: su
                  desempeno no mueve el total. Las intermedias si.</span>
              </p>
            }
          </div>
        } @else {
          <div class="dec-block">
            <p class="dec-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <span>No hay partidas con las que medir la concentracion del plan.</span>
            </p>
          </div>
        }

        <p class="dec-gap">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>No se puede decir <strong>que cambio desde la ultima vez que miraste</strong>: no se
            guarda una foto anterior de la meta por partida.</span>
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
    .dec-universo { margin:0; font-size:var(--fs-xs); color:var(--fg-3);
      letter-spacing:.03em; text-transform:uppercase; }

    .dec-top { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
    .dec-top-row { width:100%; display:grid; align-items:center; gap:.6rem;
      grid-template-columns: minmax(0,1fr) 4.5rem 8rem 1rem;
      padding:.4rem .35rem; background:none; border:0; border-radius:var(--radius-sm);
      color:inherit; font:inherit; text-align:left; cursor:pointer;
      transition:background-color 150ms ease-out; }
    .dec-top-row:hover { background:var(--surface-hover); }
    .dec-top-row:focus-visible { outline:2px solid var(--action); outline-offset:-2px; }
    .dec-top-name { font-size:var(--fs-sm); color:var(--fg-1); overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    .dec-top-pct { font-size:var(--fs-sm); color:var(--fg-1); text-align:right; }
    .dec-top-amt { font-size:var(--fs-sm); color:var(--fg-2); text-align:right; }
    .dec-top-row .pi { font-size:.8rem; color:var(--fg-3); }

    .dec-bandas { margin:0; padding:.35rem 0 0; display:flex; flex-direction:column; gap:.3rem;
      border-top:1px dashed var(--surface-border); }
    .dec-bandas > div { display:grid; grid-template-columns: minmax(0,1fr) 8rem;
      gap:.6rem; align-items:baseline; padding:0 .35rem; }
    .dec-bandas dt { font-size:var(--fs-sm); color:var(--fg-2); }
    .dec-bandas dd { margin:0; font-size:var(--fs-sm); color:var(--fg-2); text-align:right; }
    .dec-nd { color:var(--fg-3); font-size:var(--fs-xs); }

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
      .dec-top-amt { display:none; }
      .dec-bandas > div { grid-template-columns: minmax(0,1fr) 6rem; }
      .dec-verdict { font-size:var(--fs-h3); }
    }

    @media (prefers-reduced-motion: reduce) {
      .dec-top-row { transition:none; }
    }
  `],
})
export class PresupuestoDecisionComponent {
  /**
   * La concentración YA CALCULADA por el primitivo único. `null` = todavía no se midió.
   *
   * ⛔ Este componente no la computa: ver la nota de `[PVI.20]` arriba.
   */
  readonly concentracion = input<VistaConcentracion | null>(null);
  readonly meta = input<number | null>(null);
  readonly real = input<number | null>(null);
  readonly realDisponible = input<boolean>(true);
  readonly periodosSinMeta = input<number>(0);
  /** Lo que espera una firma. `null` = todavía no se midió (distinto de cero). */
  readonly firmas = input<{ total: number; monto: number | null } | null>(null);
  readonly cargando = input<boolean>(false);

  /** Q.4: el número lleva a su lugar de arreglo, con el filtro puesto. */
  @Output() readonly verPartida = new EventEmitter<string | null>();
  @Output() readonly irAFirmas = new EventEmitter<void>();

  protected readonly conc = computed(() => {
    const c = this.concentracion();
    return c && c.filas.length ? c : null;
  });

  protected readonly banda = computed(() => bandas(this.conc()));
  protected readonly frase = computed(() => fraseConcentracion(this.conc()));
  protected readonly leyenda = computed(() => leyendaUniverso(this.conc()));
  protected readonly sumaMedio = computed(() => sumaBanda(this.banda().medio));
  protected readonly sumaCola = computed(() => sumaBanda(this.banda().cola));

  protected readonly veredicto = computed(() =>
    llegada(this.meta(), this.real(), {
      realDisponible: this.realDisponible(),
      periodosSinMeta: this.periodosSinMeta(),
    }));

  protected readonly costoFirmas = computed(() => {
    const f = this.firmas();
    return f ? costoDeNoFirmar(f.total, f.monto) : null;
  });

  /**
   * Los TRES segmentos de la barra, que son las tres bandas. Juntos dan el total: ninguna fila
   * queda fuera del dibujo, que es el defecto que `[PVI.20]` vino a cerrar.
   */
  protected readonly reparto = computed<MetricStripItem[]>(() => {
    const b = this.banda();
    const items: MetricStripItem[] = [];
    const cab = sumaBanda(b.cabeza);
    const med = this.sumaMedio();
    const col = this.sumaCola();
    if (cab !== null) items.push({ label: `${b.cabeza.length} cruzan el 80 %`, value: cab, format: 'currency-short', tone: 'brand' });
    if (med !== null) items.push({ label: `${b.medio.length} intermedias`, value: med, format: 'currency-short', tone: 'warn' });
    if (col !== null) items.push({ label: `${b.cola.length} bajo el 5 %`, value: col, format: 'currency-short', tone: 'muted' });
    return items;
  });

  protected iconoVeredicto(): string {
    const t = this.veredicto().tono;
    return t === 'ok' ? 'pi-check-circle' : t === 'bad' ? 'pi-times-circle'
      : t === 'warn' ? 'pi-exclamation-circle' : 'pi-minus-circle';
  }

  /** `null` se declara con un guion: «no medible» no es 0 %. */
  protected cifraPct(p: number | null): string {
    return p === null ? '—' : `${Math.round(p * 10) / 10} %`;
  }

  protected dinero(n: number | null): string {
    return n === null ? '—'
      : n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
