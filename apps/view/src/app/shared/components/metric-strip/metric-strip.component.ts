import { ChangeDetectionStrategy, Component, computed, input, output, signal, AfterViewInit } from '@angular/core';

import { CountUpDirective } from '../../directives/count-up.directive';
import { SparklineComponent } from '../charts/sparkline.component';
import { RingGaugeComponent } from '../charts/ring-gauge.component';

export type MetricStripMode = 'strip' | 'spark' | 'ring' | 'bullet' | 'composition';
/**
 * `muted` es el tono de **lo que no se pudo medir**, y no es lo mismo que `default`.
 *
 * Nació de un caso real: una métrica de "Mes a la fecha" sin meta capturada, que dice *Sin meta
 * capturada* en vez de rellenar el hueco con un 0 % (ADR-056). Ponerle `default` compila, pero
 * deja el valor con el mismo peso visual que una cifra medida — y la plantilla ya cae a
 * `default` cuando el tono viene vacío, así que escribirlo sería una línea que aparenta hacer
 * algo y no hace nada.
 *
 * ⚠️ Esta unión **no es la misma** que la de `metric-card`, que además tiene `ember`. Son dos
 * tipos con el mismo nombre en dos archivos: agregar un tono acá no lo agrega allá.
 */
export type MetricTone = 'default' | 'ok' | 'warn' | 'bad' | 'brand' | 'muted';

/**
 * `[VP.MS]` **Estado de MEDICIÓN — el eje que faltaba, y es ORTOGONAL al tono.**
 *
 * `tone` dice si el número es bueno o malo (juicio de negocio). `state` dice **con qué se
 * calculó**. Son dos preguntas distintas y hasta hoy sólo había vocabulario para la primera:
 * un KPI sin dato tenía que elegir un color, y `default` se pinta como un número normal.
 *
 * Medido el 2026-10-08 antes de agregar esto: **85 pantallas** usan este organismo y hay
 * **22 sitios con `tone: 'ok'` clavado sin condición** — el `cfg ? classify : 'ok'` que la
 * Fase VP documentó, viviendo adentro del componente compartido.
 *
 * ⛔ **Los chips NO usan la paleta semántica**, a propósito. `--status-*` y `--ok/--warn/--bad`
 * codifican **severidad**, y si el estado toma prestada esa paleta los dos ejes **colapsan
 * visualmente** — que es justo el defecto que esto viene a corregir. El estado se distingue por
 * **forma y texto** sobre neutrales estructurales; el color queda entero para el tono.
 * Además cumple la regla #5 de `DESIGN.md` (el color nunca es único portador) y sobrevive a
 * `forced-colors`, donde los fondos se fuerzan y la forma es lo único que queda.
 *
 * ⚠️ `derivado` **exige `method`**: decir «derivado» sin decir con qué regla no informa nada.
 */
export type MetricState = 'medido' | 'parcial' | 'derivado' | 'no_medido';
/** `currency2` = moneda CON centavos, para precios unitarios ($/unidad, $/partida). */
export type MetricFormat = 'number' | 'decimal1' | 'currency' | 'currency2' | 'currency-short' | 'percent' | 'text';

export interface MetricStripItem {
  label: string;
  value: number | string;
  format?: MetricFormat;
  tone?: MetricTone;
  /**
   * Con qué se calculó la cifra. Ver `MetricState`. Omitirlo deja la métrica como está hoy
   * (sin chip), así que esto es **aditivo**: ninguna de las 85 pantallas cambia sin tocarla.
   */
  state?: MetricState;
  /** Obligatorio cuando `state === 'derivado'`: la regla con la que se rellenó. */
  method?: string;
  /** La ventana si es `parcial`; el motivo si es `no_medido`. Va al `title` del chip. */
  stateNote?: string;
  sub?: string;
  /** delta % vs periodo anterior → ▲/▼ + número (flecha, no solo color). */
  delta?: number | null;
  /**
   * Punto pulsante "en vivo" junto a la etiqueta **y** `aria-live="polite"` en la cifra.
   * ⚠️ Las dos cosas, no una: el punto avisa a quien MIRA, y sin `aria-live` el valor cambia
   * solo y un lector de pantalla no se entera. Era el hueco que J17 declaró y nadie cerró
   * (`MetricCard` sí lo tenía desde el principio). Cerrado 2026-10-03.
   */
  live?: boolean;
  /** serie para el modo spark (nº con sparkline de fondo) y ring/bullet no la usan. */
  series?: number[];
  /** 0..100 para ring / bullet (progreso). Si falta en composition, se usa `value`. */
  pct?: number;
  /** 0..100 marca de objetivo para bullet. */
  target?: number;
  /**
   * [LC.21] La llave del DESGLOSE: si viene, la tarjeta se puede abrir (clic, Enter o Espacio) y
   * emite `(drill)` con esta llave para que la pantalla muestre los renglones que forman la cifra.
   * Aditivo: sin `drill` la tarjeta es exactamente la de siempre (las 131 pantallas no cambian).
   * Pedido de Edgar (2026-10-22): «todo lugar donde diga movimientos, que me permita desglosarlos».
   */
  drill?: string;
  /** Lo que dice el lector de pantalla al enfocarla. Default: «Ver el detalle de <label>». */
  drillLabel?: string;
}

/**
 * MetricStrip — KPIs SIN caja (patrón "KPI Strip" de Operations, quiet-luxury).
 * Reemplaza las cajitas `.kpi`/`rk-card` ad-hoc: nada de bg/borde/radio por métrica,
 * separación por hairline. Cifras en Geist Mono tabular con count-up on-view (una vez),
 * color por token (flipa en dark), delta multimodal, `prefers-reduced-motion` respetado.
 *
 * Modos (por forma del dato):
 *  - strip        valor único en fila (default) — el 80% de los casos.
 *  - spark        número con sparkline de fondo (serie temporal).
 *  - ring         anillo de progreso por métrica (ratio/%).
 *  - bullet       barra medida vs meta.
 *  - composition  una sola barra segmentada (partes que suman a un total) + leyenda.
 */
@Component({
  selector: 'app-metric-strip',
  standalone: true,
  imports: [CountUpDirective, SparklineComponent, RingGaugeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ms" [class]="'ms--' + mode()" [class.ms--compact]="density() === 'compact'" role="group" [attr.aria-label]="ariaLabel() || null">
      @if (mode() === 'composition') {
        <div class="ms-band">
          <div class="ms-bar" role="img" [attr.aria-label]="ariaLabel() || null">
            @for (it of items(); track it.label) {
              <span class="ms-seg" [class]="'tone-' + (it.tone || 'brand')"
              [style.width.%]="mounted() ? segPct(it) : 0" [attr.title]="it.label"></span>
            }
          </div>
          <div class="ms-leg">
            @for (it of items(); track it.label) {
              <span><i [class]="'tone-' + (it.tone || 'brand')"></i>{{ it.label }}
              <b [appCountUp]="num(it)" [countUpFormat]="cu(it)" [countUpOff]="instant()"></b></span>
            }
          </div>
        </div>
      } @else {
        @for (it of items(); track it.label) {
          <div class="ms-item" [class]="'tone-' + effTone(it)" [class.is-drill]="!!it.drill"
               [attr.role]="it.drill ? 'button' : null" [attr.tabindex]="it.drill ? 0 : null"
               [attr.aria-label]="it.drill ? (it.drillLabel || 'Ver el detalle de ' + it.label) : null"
               (click)="abrir(it)" (keydown.enter)="abrir(it)" (keydown.space)="abrir(it, $event)">
            <span class="ms-l">{{ it.label }}@if (it.live) {
              <span class="ms-live" title="En vivo" aria-hidden="true"></span>
            }@if (it.state) {
              <span class="ms-st" [class]="'st-' + it.state" [attr.title]="stateTitle(it)">{{ stateText(it) }}</span>
            }</span>
    
            @if (mode() === 'ring') {
              <div class="ms-ring-row">
                <app-ring-gauge [value]="it.pct ?? num(it)" [max]="100" [size]="46" [color]="toneColor(it)"></app-ring-gauge>
                <b class="ms-v" [appCountUp]="num(it)" [countUpFormat]="cu(it)" [countUpOff]="instant()"
                   [attr.aria-live]="it.live ? 'polite' : null"></b>
              </div>
            } @else {
              <div class="ms-row">
                @if (isText(it)) { <b class="ms-v is-text">{{ it.value }}</b> }
                @else { <b class="ms-v" [appCountUp]="num(it)" [countUpFormat]="cu(it)" [countUpOff]="instant()"
                           [attr.aria-live]="it.live ? 'polite' : null"></b> }
                @if (it.delta !== null && it.delta !== undefined) {
                  <span class="ms-delta" [class.up]="it.delta! > 0" [class.down]="it.delta! < 0">
                    {{ it.delta! > 0 ? '▲' : it.delta! < 0 ? '▼' : '' }} {{ absDelta(it.delta!) }}%
                  </span>
                }
              </div>
            }
    
            @if (mode() === 'bullet') {
              <div class="ms-bullet">
                <span class="ms-bfill" [class]="'tone-' + (it.tone || 'brand')" [style.--fill]="mounted() ? ((it.pct ?? 0) / 100) : 0"></span>
                @if (it.target != null) { <span class="ms-btarget" [style.left.%]="it.target"></span> }
              </div>
            }
            @if (mode() === 'spark' && (it.series?.length ?? 0) > 1) {
              <app-sparkline class="ms-spark" [data]="it.series!" [area]="true" [color]="toneColor(it)"></app-sparkline>
            }
    
            @if (it.sub) {
              <span class="ms-sub">{{ it.sub }}</span>
            }
          </div>
        }
      }
    </div>
    `,
  styles: [`
    :host { display:block; }

    /* ── [VP.MS] chip de ESTADO DE MEDICIÓN ──────────────────────────────────────
       Neutrales estructurales a propósito: el color entero queda para el tono. Se
       distinguen por GLIFO + TEXTO, así que sobreviven a forced-colors (donde los
       fondos se fuerzan y la forma es lo único que queda) y a quien no distingue
       colores. El glifo es decorativo: el texto ya dice el estado. */
    /* [CGA-LEG.3] --fs-nano son 10px y el propio tokens.css lo marca "ultimo recurso". Esta
       pastilla dice la PROCEDENCIA del numero (medido / parcial / derivado / no medido), o sea
       cuanto hay que confiar en el: es lo ultimo que debe costar leer. Sube al mismo 12px que
       el rotulo. */
    .ms-st { display:inline-flex; align-items:center; gap:.25rem; font-size:var(--fs-xs);
             font-weight:var(--fw-bold,700); letter-spacing:.04em; text-transform:uppercase;
             color:var(--text-muted); border:1px solid var(--border-color);
             border-radius:var(--r-sm); padding:0 .3rem; line-height:1.5; white-space:nowrap; }
    .ms-st::before { content:''; width:.42rem; height:.42rem; border:1px solid currentColor; }
    .ms-st.st-medido::before   { border-radius:var(--r-pill,50%); background:currentColor; }
    .ms-st.st-parcial::before  { border-radius:var(--r-pill,50%);
                                 background:linear-gradient(90deg,currentColor 50%,transparent 50%); }
    .ms-st.st-derivado::before { border:none; width:0; height:0; border-left:.26rem solid transparent;
                                 border-right:.26rem solid transparent; border-bottom:.42rem solid currentColor; }
    /* ⛔⛔ [CGA-LEG.5] "NO MEDIDO" ERA LO MENOS LEGIBLE, Y ESO INVIERTE ADR-056.
       Medido el 2026-10-19: --text-faint da contraste 2.33 sobre el fondo vivo, la mitad del
       minimo AA. O sea que la marca cuya unica razon de existir es AVISAR que un numero no se
       pudo medir se publicaba mas tenue que el numero -- y una advertencia que no se lee es
       indistinguible de no haberla puesto, que es exactamente el cero dibujado que el ADR
       prohibe.
       El borde punteado se queda: es la senal que NO depende del color y la que sobrevive en
       Alto Contraste. Lo que cambia es que ahora ademas se lee. */
    .ms-st.st-no_medido        { border-style:dashed; color:var(--text-muted); }
    .ms-st.st-no_medido::before{ border-radius:var(--r-pill,50%); background:transparent; }

    /* ── fila de métricas sin caja ── */
    .ms { display:flex; flex-wrap:wrap; }
    .ms-item { display:flex; flex-direction:column; justify-content:center; gap:.2rem; padding:.15rem 1.4rem; position:relative; }
    .ms-item:first-child { padding-left:.15rem; }
    /* [LC.21] Tarjeta con desglose: se nota que se abre (subrayado al pasar) sin pintarla como botón. */
    .ms-item.is-drill { cursor:pointer; border-radius:var(--r-sm, 4px); }
    .ms-item.is-drill:hover .ms-v { text-decoration:underline; text-underline-offset:3px; }
    .ms-item.is-drill:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
    .ms-item:not(:first-child)::before { content:''; position:absolute; left:0; top:.3rem; bottom:.3rem; width:1px; background:var(--border-color); }
    /* ⛔⛔ [CGA-LEG.1] ACA DECIA ".68rem", Y ESO NO EXISTE EN LA ESCALA. Medido el 2026-10-19
       en Caja General: 10.88px, el rotulo de un KPI de encabezado. Un valor en rem clavado no
       solo es mas chico que el piso -- INVENTA UN PELDANO: la pantalla llego a tener 23
       combinaciones tamano/peso distintas, y con tantas ninguna se lee como mas importante.
       La jerarquia la da el contraste entre POCOS niveles, no la cantidad de niveles.
       --fs-xs es 12px, el peldano que el sistema ya tiene para metadatos.
       ⚠️ Esto lo montan 107 pantallas. Medido el impacto antes de tocarlo: la tira crece 4px
       de alto y NO desborda a lo ancho. */
    .ms-l { display:flex; align-items:center; gap:.4rem; font-size:var(--fs-xs); font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; }
    .ms-row { display:flex; align-items:baseline; gap:.5rem; }
    .ms-v { font-family:var(--font-mono); font-size:1.55rem; font-weight:600; line-height:1.1; font-variant-numeric:tabular-nums; color:var(--text-main); }
    /* valores de texto (nombres/fechas): no mono, más chico, para que no griten. */
    /* [CGA-LEG.8] 1.05rem = 16.8px, otro peldano inventado. --fs-h3 (16px) es el que el sistema
       tiene para un titulo de panel y conserva la intencion del comentario de arriba: el valor de
       TEXTO va mas chico que el numerico (24.8) para que no grite. */
    .ms-v.is-text { font-family:var(--font-body,inherit); font-size:var(--fs-h3); font-weight:700; letter-spacing:-.01em; }
    .ms-item.tone-ok .ms-v { color:var(--ok-fg); }
    .ms-item.tone-warn .ms-v { color:var(--warn-fg); }
    .ms-item.tone-bad .ms-v { color:var(--bad-fg); }
    .ms-item.tone-brand .ms-v { color:var(--action); }
    /* El valor que no se pudo medir baja de peso, no desaparece: sigue leyendose. */
    .ms-item.tone-muted .ms-v { color:var(--text-muted); }
    /* ⛔⛔ [CGA-LEG.2] ESTA LINEA ERA LA MENOS LEGIBLE DE LA PANTALLA, Y ES LA QUE EXPLICA.
       Medido el 2026-10-19 en Caja General: .7rem = 11.2px con --text-faint, contraste
       REAL 2.33 sobre su fondo -- la mitad del minimo AA (4.5). Y lo que lleva es
       justamente la instruccion:

           "el resto necesita su cuenta declarada"
           "se corrigen en Kepler, no aca"

       O sea que quien no sabe que hacer es exactamente quien no puede leer la linea que se
       lo dice. No es un detalle de estilo: es el texto que convierte un numero en una tarea.

       --text-faint falla AA en las 4 superficies x 2 temas y vive en 112 archivos; retirarlo
       del todo es decision de Edgar y queda como deuda. Lo que NO se negocia es que el texto
       que INSTRUYE lo use. */
    .ms-sub { font-size:var(--fs-xs); color:var(--text-muted); font-variant-numeric:tabular-nums; }
    /* delta multimodal */
    .ms-delta { font-family:var(--font-mono); font-size:.72rem; font-weight:600; color:var(--text-faint); }
    .ms-delta.up { color:var(--ok-fg); } .ms-delta.down { color:var(--bad-fg); }
    /* live */
    .ms-live { width:6px; height:6px; border-radius:50%; background:var(--warn-fg); position:relative; }
    .ms-live::after { content:''; position:absolute; inset:0; border-radius:50%; background:var(--warn-fg); animation:ms-pulse 1.8s ease-out infinite; }
    @keyframes ms-pulse { 0%{transform:scale(1);opacity:.6;} 100%{transform:scale(3);opacity:0;} }
    /* ring */
    .ms-ring-row { display:flex; align-items:center; gap:.6rem; }
    /* spark */
    .ms-spark { display:block; margin-top:.35rem; --spk-h:34px; }
    /* bullet */
    .ms-bullet { position:relative; height:8px; margin-top:.5rem; background:var(--track,color-mix(in srgb,var(--border-color) 60%,transparent)); border-radius:999px; }
    /* El relleno ocupa el ancho completo y se recorta con scaleX desde la izquierda: transform
       es compuesto (no dispara layout) y cae dentro del techo de 350ms de DESIGN.md. Antes
       animaba width 900ms -- 2.6x el techo y sobre una propiedad de layout, en 81 pantallas.
       Se CONSERVA el border-radius del propio relleno porque .ms-bullet no puede recortar:
       .ms-btarget se sale a proposito 3px arriba y abajo, y un overflow:hidden lo decapitaria.
       Costo declarado: el casquete derecho se achata a elipse al escalar. A 8px de alto es
       imperceptible, y a porcentajes chicos el relleno es una astilla donde no se ve. */
    .ms-bfill { position:absolute; inset:0 auto 0 0; width:100%; height:100%; border-radius:999px; background:var(--action); transform:scaleX(var(--fill,0)); transform-origin:left center; transition:transform var(--dur-standard,250ms) var(--ease-standard,cubic-bezier(.4,0,.2,1)); }
    .ms-bfill.tone-ok { background:var(--ok-fg); } .ms-bfill.tone-warn { background:var(--warn-fg); } .ms-bfill.tone-bad { background:var(--bad-fg); }
    /* Los otros modos tambien lo entienden: sin esto, un tono muted caeria al color de marca
       y la barra se veria igual de firme que una medida. */
    .ms-bfill.tone-muted { background:var(--text-muted); }
    .ms-btarget { position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--text-main); border-radius:2px; }
    /* ── composición: una barra segmentada + leyenda ── */
    .ms-band { width:100%; }
    .ms-bar { display:flex; height:14px; border-radius:999px; overflow:hidden; background:var(--track,color-mix(in srgb,var(--border-color) 60%,transparent)); }
    /* ⚠️ EXCEPCION DECLARADA a "solo transform+opacity" (DESIGN.md §Motion), con su razon:
       los segmentos son hermanos flex que se reparten UNA fila; escalar uno no mueve a los
       otros, asi que scaleX no aplica sin pasar a posicion absoluta con desplazamiento
       acumulado -- un refactor del TS que no se hace a ciegas. El reflow esta acotado: una
       tira de 14px con 2-5 spans vacios, sin texto adentro. Lo que SI se corrige es la
       duracion: 900ms -> --dur-standard. Deuda con nombre: [DS.1] segmentos a transform. */
    .ms-seg { transition:width var(--dur-standard,250ms) var(--ease-standard,cubic-bezier(.4,0,.2,1)); }
    .ms-seg.tone-ok { background:var(--ok-fg); } .ms-seg.tone-warn { background:var(--warn-fg); } .ms-seg.tone-bad { background:var(--bad-fg); } .ms-seg.tone-brand { background:var(--action); } .ms-seg.tone-muted { background:var(--text-muted); } .ms-seg.tone-default { background:var(--text-faint); }
    .ms-leg { display:flex; flex-wrap:wrap; gap:1.3rem; margin-top:.85rem; }
    .ms-leg span { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text-muted); }
    .ms-leg i { width:9px; height:9px; border-radius:3px; }
    .ms-leg i.tone-ok { background:var(--ok-fg); } .ms-leg i.tone-warn { background:var(--warn-fg); } .ms-leg i.tone-bad { background:var(--bad-fg); } .ms-leg i.tone-brand { background:var(--action); } .ms-leg i.tone-muted { background:var(--text-muted); } .ms-leg i.tone-default { background:var(--text-faint); }
    .ms-leg b { font-family:var(--font-mono); font-weight:600; color:var(--text-main); font-variant-numeric:tabular-nums; }
    /* ── densidad compacta (solo modo strip): cada métrica en UNA línea — cifra, etiqueta y nota —
       en vez de apilarlas. Misma información, ~1/3 del alto. Es ADITIVA: el default 'normal' no
       cambia ninguna de las pantallas que ya usan este organismo. Se ordena con order porque el DOM
       lleva etiqueta antes que cifra (lectores de pantalla) y a la vista la cifra va primero. */
    .ms--compact .ms-item { flex-direction:row; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); padding:.1rem var(--sp-4); }
    .ms--compact .ms-item:first-child { padding-left:.15rem; }
    .ms--compact .ms-item:not(:first-child)::before { top:.15rem; bottom:.15rem; }
    .ms--compact .ms-row { order:1; }
    .ms--compact .ms-l { order:2; font-size:var(--fs-micro); }
    .ms--compact .ms-sub { order:3; font-size:var(--fs-micro); }
    .ms--compact .ms-v { font-size:var(--fs-lg); }
    /* móvil: grid 2 columnas con un divisor central por fila */
    @container (max-width:35rem) {
      .ms:not(.ms--composition) { display:grid; grid-template-columns:1fr 1fr; row-gap:.85rem; }
      .ms-item { padding:.1rem 1rem; }
      .ms-item:not(:first-child)::before { display:none; }
      .ms-item:nth-child(even)::before { display:block; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ms-live::after { animation:none; }
      .ms-seg, .ms-bfill { transition:none; }
    }
  `],
})
export class MetricStripComponent implements AfterViewInit {
  readonly items = input<MetricStripItem[]>([]);
  readonly mode = input<MetricStripMode>('strip');
  readonly ariaLabel = input<string>('');
  /**
   * `normal` (default) apila etiqueta / cifra / nota como siempre. `compact` los pone en una línea:
   * para pantallas donde el alto vale más que el aire (una tabla densa debajo). Sólo aplica al modo
   * `strip`; los demás modos ignoran la densidad.
   */
  readonly density = input<'normal' | 'compact'>('normal');
  /**
   * `[PGP.15]` Las cifras aparecen con su valor final, sin contar desde 0. **Aditivo**: el default
   * (`false`) deja el count-up como siempre en las demás pantallas.
   *
   * Nace de una medición en `/finanzas/calendario-pagos`: durante los ~900 ms del conteo la tira
   * publicaba «Comprometido $84,410.38» de un día con $1,850,235.43 — una captura o un vistazo en
   * ese lapso lee un monto que no existe. Donde la cifra se usa para DECIDIR (cuánto cabe hoy), la
   * regla del PM manda: la información visible en todo momento.
   */
  readonly instant = input(false);
  /** total para composición (default = suma de valores). */
  readonly total = input<number | null>(null);
  /** [LC.21] La llave de la tarjeta que se abrió (sólo las que traen `drill`). */
  readonly drill = output<string>();

  abrir(it: MetricStripItem, ev?: Event) {
    if (!it.drill) return;
    ev?.preventDefault(); // Espacio no debe hacer scroll
    this.drill.emit(it.drill);
  }

  /** dispara la animación de anchos (barra/bullet) tras montar. */
  readonly mounted = signal(false);
  ngAfterViewInit(): void { queueMicrotask(() => this.mounted.set(true)); }

  private readonly sum = computed(() =>
    this.items().reduce((s, it) => s + (Number(it.value) || 0), 0));

  num(it: MetricStripItem): number { return Number(it.value) || 0; }

  /**
   * `[VP.MS]` **`no_medido` INHABILITA el tono — no es que se pinte gris, es que no se puede
   * pedir verde.** Un número que no se pudo medir no puede estar bien ni mal: no hay número.
   * El freno vive acá, en el componente, y no en cada una de las 85 pantallas que lo usan,
   * porque una regla que depende de que 85 llamadores se acuerden no es una regla.
   *
   * ⚠️ `parcial` y `derivado` SÍ conservan su tono: una cifra parcial puede ser buena o mala
   * dentro de lo que cubre, y neutralizarla escondería el juicio en vez de calificarlo.
   */
  effTone(it: MetricStripItem): MetricTone {
    return it.state === 'no_medido' ? 'muted' : (it.tone || 'default');
  }

  /** `derivado` se muestra con su método: decirlo sin la regla no informa nada. */
  stateText(it: MetricStripItem): string {
    const base: Record<MetricState, string> = {
      medido: 'medido', parcial: 'parcial', derivado: 'derivado', no_medido: 'no medido',
    };
    const t = base[it.state as MetricState] ?? '';
    return it.state === 'derivado' && it.method ? `${t} · ${it.method}` : t;
  }

  /**
   * El `title` carga la ventana o el motivo. ⚠️ Si `derivado` llega SIN `method`, el chip lo
   * declara en vez de callarlo: un «derivado» mudo es exactamente lo que la regla prohíbe, y
   * esconderlo lo volvería indistinguible de un derivado bien documentado.
   */
  stateTitle(it: MetricStripItem): string | null {
    if (it.state === 'derivado' && !it.method) {
      return 'Derivado sin método declarado: falta decir con qué regla se calculó.';
    }
    return it.stateNote || null;
  }

  /**
   * ¿Se pinta como TEXTO? Sí cuando lo declara el llamador, y **también** cuando el valor no es un
   * número — aunque el llamador se haya olvidado del `format`.
   *
   * Sin esa segunda condición el strip caía en la rama numérica y `num()` convertía el valor en
   * **0** (`Number('—') || 0`): una ausencia dibujada como cero, que es exactamente lo que
   * ADR-056 prohíbe, y en silencio — el KPI se ve perfecto, sólo que miente. Pasó de verdad en
   * `/compras/pedido` ("Inventario 0" con la bajada "sin demanda medida" al lado).
   *
   * Se resuelve acá y no sólo en el llamador para que el olvido no vuelva a ser posible: son 2
   * llamadores hoy y el tipo `value` admite `string`, así que el próximo tropieza igual.
   */
  isText(it: MetricStripItem): boolean {
    if (it.format === 'text') return true;
    if (typeof it.value !== 'string') return false;
    // La cadena vacía también: `Number('')` es 0 y es finito, así que sin esta guarda un valor
    // ausente se pintaría como un 0 igual de falso que el del guion.
    return it.value.trim() === '' || !Number.isFinite(Number(it.value));
  }

  cu(it: MetricStripItem): 'int' | 'decimal1' | 'percent1' | 'money' | 'money2' | 'money-short' {
    switch (it.format) {
      case 'currency': return 'money';
      case 'currency2': return 'money2';
      case 'currency-short': return 'money-short';
      case 'percent': return 'percent1';
      case 'decimal1': return 'decimal1';
      default: return 'int';
    }
  }

  absDelta(d: number): number { return Math.abs(d); }

  segPct(it: MetricStripItem): number {
    const t = this.total() ?? this.sum();
    if (!t) return 0;
    const v = it.pct != null ? it.pct : Number(it.value) || 0;
    return Math.max(0, Math.min(100, (v / t) * 100));
  }

  toneColor(it: MetricStripItem): string {
    switch (it.tone) {
      case 'ok': return 'var(--ok-fg)';
      case 'warn': return 'var(--warn-fg)';
      case 'bad': return 'var(--bad-fg)';
      case 'brand': return 'var(--action)';
      default: return 'var(--action)';
    }
  }
}
