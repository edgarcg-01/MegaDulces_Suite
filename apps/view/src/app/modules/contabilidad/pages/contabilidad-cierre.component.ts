import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import {
  CierreContableService, type CierreResp, type EstadoCierre, type MesCierre,
} from '../cierre-contable.service';

/**
 * `[CPA.0]` — **El semáforo de cierre contable.**
 *
 * ── Qué contesta, y por qué está arriba de todo ─────────────────────────────────────────────
 * *¿Qué mes le falta a la contabilidad?* Medido contra prod el 2026-10-10: **septiembre-2026 no
 * tiene póliza de compras** — $30,334,529 pagados a proveedores y $0 de compras registradas. El
 * hueco existía desde el día 1 y se encontró el 10, con una consulta a mano. Por eso lo primero
 * que esta pantalla pone en pantalla es **el mes que falta**, no una tabla que haya que leer.
 *
 * ── Las decisiones de lectura, y qué defecto evita cada una ─────────────────────────────────
 *  1. ⭐ **El rojo se reserva para lo accionable.** `[LC.16]` midió que cuando el rojo significa
 *     cuatro cosas —y una de ellas es «todo bien»— deja de leerse: 258 de 446 filas en rojo y 159
 *     decían *«ya está en el libro»*. Acá `bad` es sólo «este mes está sin asentar».
 *  2. ⛔ **Las dos ausencias se ven distinto.** `sin_meta` (hay cifra, falta umbral → lo arregla
 *     quien registra el umbral) y `sin_medir` (no hay con qué comparar → lo arregla Sistemas) no
 *     comparten color ni texto. Es ADR-056 en la pantalla, no sólo en el JSON.
 *  3. ⭐ **El provisional se declara donde se vería como asentado.** Octubre tiene $36.8 M de
 *     ventas fechadas en el futuro: la fila lo dice en su renglón, no en una nota al pie.
 *  4. ⚠️ **El tiempo de la consulta se publica.** Hoy son ~900 ms, arriba del gate de 500. Hasta
 *     que entre el índice cubriente de `fiscal.cfdis`, la pantalla lo muestra en vez de taparlo.
 *
 * Operations: denso, answer-first, tokens, dark-safe. Lectura pura — mirar no cambia nada.
 */
@Component({
  selector: 'app-contabilidad-cierre',
  standalone: true,
  imports: [CommonModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cci-page">

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cierre contable</h1>
          <p class="surf-page-sub">
            Qu&eacute; mes ya est&aacute; asentado en ContPAQi y cu&aacute;l no, contra un testigo
            independiente. Solo lectura: esta p&aacute;gina se&ntilde;ala, no asienta.
          </p>
        </div>
      </header>

      @if (error(); as e) {
        <div class="cci-error" role="alert">
          <i class="pi pi-exclamation-triangle"></i>
          <div>
            <strong>No se pudo leer el cierre.</strong>
            <div class="cci-error-d">{{ e }}</div>
          </div>
          <button type="button" class="cci-btn" (click)="cargar()">Reintentar</button>
        </div>
      }

      @if (loading()) {
        <div class="cci-skel" aria-busy="true">@for (i of [1,2,3,4,5]; track i) { <div class="cci-skel-row"></div> }</div>
      } @else if (data(); as d) {

        <!-- ── EL VEREDICTO, antes que cualquier tabla ── -->
        <section class="cci-verdict" [attr.data-estado]="peorCerrado()">
          <div class="cci-eyebrow">Meses cerrados con algo sin asentar</div>
          @if (faltantes().length === 0) {
            <h2>Ning&uacute;n mes cerrado tiene familias sin asentar.</h2>
            <p class="cci-lede">
              Los {{ cerrados().length }} meses cerrados de la ventana est&aacute;n completos
              seg&uacute;n su testigo. El mes en curso no se juzga.
            </p>
          } @else {
            <h2>
              <span class="mono">{{ faltantes().length }}</span>
              {{ faltantes().length === 1 ? 'mes cerrado tiene' : 'meses cerrados tienen' }}
              algo sin asentar.
            </h2>
            <ul class="cci-faltan">
              @for (f of faltantes(); track f.mes + f.familia) {
                <li>
                  <strong class="mono">{{ f.mes }}</strong>
                  &mdash; {{ f.etiqueta }}:
                  @if (f.renglones === 0) {
                    <strong>ni un rengl&oacute;n</strong> en la contabilidad,
                  } @else {
                    {{ f.senal | currency:'MXN':'symbol-narrow':'1.0-0' }} asentados,
                  }
                  contra un testigo de
                  <strong>{{ f.testigo | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>
                  ({{ f.testigo_fuente }}).
                  @if (f.escala_a) { <span class="cci-escala">escala a {{ f.escala_a }}</span> }
                </li>
              }
            </ul>
          }
        </section>

        <!-- ── LA TABLA: un renglón por mes × familia ── -->
        <section class="cci-sec">
          <div class="cci-sec-h">
            <h3>Mes por mes</h3>
            <span class="cci-tag">{{ d.meses.length }} meses &middot; {{ familiasPorMes() }} familias</span>
          </div>

          @for (m of d.meses; track m.anio_mes) {
            <div class="card-premium card-flat cci-mes">
              <div class="cci-mes-h">
                <span class="cci-pill" [attr.data-estado]="m.estado">{{ texto(m.estado) }}</span>
                <strong class="mono cci-mes-k">{{ m.anio_mes }}</strong>
                @if (m.periodo_estado === 'en_curso') {
                  <span class="cci-curso">mes en curso &mdash; no se juzga</span>
                }
                <span class="cci-mes-sum">
                  @if (m.conteo.ok) { <span class="mono">{{ m.conteo.ok }}</span> asentadas }
                  @if (m.conteo.bad) { &middot; <strong class="mono">{{ m.conteo.bad }}</strong> sin asentar }
                  @if (m.conteo.warn) { &middot; <span class="mono">{{ m.conteo.warn }}</span> cortas }
                  @if (m.conteo.sin_meta) { &middot; <span class="mono">{{ m.conteo.sin_meta }}</span> sin umbral }
                  @if (m.conteo.sin_medir) { &middot; <span class="mono">{{ m.conteo.sin_medir }}</span> sin medir }
                </span>
              </div>

              <p-table [value]="m.familias" size="small" class="surf-table" [rowHover]="true">
                <ng-template #header>
                  <tr>
                    <th>Familia</th>
                    <th class="ta-r">Asentado</th>
                    <th class="ta-r">Testigo</th>
                    <th class="ta-r">Cobertura</th>
                    <th>Estado</th>
                  </tr>
                </ng-template>
                <ng-template #body let-f>
                  <tr>
                    <td>
                      <div>{{ f.etiqueta }}</div>
                      <div class="cci-code">{{ f.senal_cuentas }}</div>
                    </td>
                    <td class="ta-r">
                      <span class="mono" [class.muted]="f.senal_renglones === 0">
                        {{ f.senal | currency:'MXN':'symbol-narrow':'1.0-0' }}
                      </span>
                      <!-- ⛔ Sin esto, "$0" y "nadie capturó nada" se leen igual. -->
                      <!-- ⚠️ El plural va con el carácter real: una entidad HTML dentro de una
                           interpolación se imprime tal cual ("rengl&oacute;n"), no se resuelve. -->
                      <div class="cci-sub" [class.cci-cero]="f.senal_renglones === 0">
                        {{ f.senal_renglones | number }} {{ f.senal_renglones === 1 ? 'renglón' : 'renglones' }}
                      </div>
                      @if (f.provisional) {
                        <div class="cci-prov">
                          + {{ f.provisional | currency:'MXN':'symbol-narrow':'1.0-0' }} fechado adelante
                          &mdash; no cuenta
                        </div>
                      }
                    </td>
                    <td class="ta-r">
                      @if (f.cobertura_base === 'testigo') {
                        <span class="mono">{{ f.testigo | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                        <div class="cci-sub">{{ f.testigo_fuente }}</div>
                      } @else {
                        <span class="mono">{{ f.mediana_6m | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                        <!-- ⭐ Se declara que este testigo es más débil, no se disfraza. -->
                        <div class="cci-sub cci-debil">mediana de 6 meses &mdash; sin testigo propio</div>
                      }
                    </td>
                    <td class="ta-r">
                      @if (f.cobertura === null) {
                        <span class="muted">&mdash;</span>
                      } @else {
                        <span class="mono">{{ f.cobertura * 100 | number:'1.1-1' }}%</span>
                        @if (f.umbral) {
                          <div class="cci-sub">meta {{ f.umbral.target * 100 | number:'1.0-0' }}%</div>
                        }
                      }
                    </td>
                    <td>
                      <span class="cci-pill" [attr.data-estado]="f.estado">{{ texto(f.estado) }}</span>
                      @if (f.motivo) { <div class="cci-sub">{{ f.motivo }}</div> }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }
        </section>

        <!-- ── PROCEDENCIA: con qué se calculó esto, y qué NO cubre ── -->
        <footer class="cci-proc">
          <div>
            <span class="cci-proc-k">Frescura</span>
            <span class="cci-proc-v" [attr.data-fresh]="d.freshness.status">
              @switch (d.freshness.status) {
                @case ('fresh')   { P&oacute;lizas al d&iacute;a &mdash; {{ d.freshness.age_human }} }
                @case ('stale')   { ⚠️ El carril lleva {{ d.freshness.age_human }} sin traer p&oacute;lizas }
                @default          { ⛔ No se pudo medir la frescura del carril }
              }
            </span>
          </div>
          <div>
            <span class="cci-proc-k">Cobertura</span>
            <span class="cci-proc-v">{{ d.coverage.note }}</span>
          </div>
          <div>
            <span class="cci-proc-k">Consulta</span>
            <span class="cci-proc-v" [class.cci-lento]="d.query_ms > 500">
              {{ d.query_ms | number }} ms
              @if (d.query_ms > 500) { &mdash; arriba del l&iacute;mite de 500 ms; falta el &iacute;ndice de <code>fiscal.cfdis</code> }
            </span>
          </div>
        </footer>
      }
    </div>
  `,
  styles: [`
    .cci-page { display: flex; flex-direction: column; gap: var(--space-5, 1.25rem); }

    .cci-verdict { padding: var(--space-4, 1rem) var(--space-5, 1.25rem);
      border: 1px solid var(--surface-border); border-radius: var(--radius-lg, .75rem);
      background: var(--surface-card); border-left: 3px solid var(--text-muted); }
    .cci-verdict[data-estado="bad"] { border-left-color: var(--bad); }
    .cci-verdict[data-estado="warn"] { border-left-color: var(--warn); }
    .cci-verdict[data-estado="ok"] { border-left-color: var(--ok); }
    .cci-eyebrow { font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
      color: var(--text-muted); margin-bottom: .35rem; }
    .cci-verdict h2 { margin: 0; font-size: 1.15rem; font-weight: 650; line-height: 1.35; }
    .cci-lede { margin: .5rem 0 0; color: var(--text-muted); font-size: .85rem; }
    .cci-faltan { margin: .6rem 0 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: .3rem; }
    .cci-faltan li { font-size: .85rem; line-height: 1.45; }
    .cci-escala { margin-left: .4rem; font-size: .72rem; padding: .05rem .4rem;
      border: 1px solid var(--surface-border); border-radius: var(--radius-sm, .25rem); color: var(--text-muted); }

    .cci-sec { display: flex; flex-direction: column; gap: var(--space-3, .75rem); }
    .cci-sec-h { display: flex; align-items: baseline; gap: .6rem; }
    .cci-sec-h h3 { margin: 0; font-size: .95rem; font-weight: 650; }
    .cci-tag { font-size: .72rem; color: var(--text-muted); }

    .cci-mes { padding: 0; overflow: hidden; }
    .cci-mes-h { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
      padding: .55rem .75rem; border-bottom: 1px solid var(--surface-border); }
    .cci-mes-k { font-size: .95rem; }
    .cci-curso { font-size: .72rem; color: var(--text-muted); font-style: italic; }
    .cci-mes-sum { margin-left: auto; font-size: .78rem; color: var(--text-muted); }

    .cci-pill { display: inline-block; font-size: .7rem; font-weight: 600; padding: .1rem .45rem;
      border-radius: var(--radius-sm, .25rem); border: 1px solid var(--surface-border); color: var(--text-muted); }
    .cci-pill[data-estado="ok"] { color: var(--ok); border-color: currentColor; }
    .cci-pill[data-estado="warn"] { color: var(--warn); border-color: currentColor; }
    .cci-pill[data-estado="bad"] { color: var(--bad); border-color: currentColor; font-weight: 700; }
    .cci-pill[data-estado="sin_meta"] { border-style: dashed; }
    .cci-pill[data-estado="sin_medir"] { border-style: dotted; }

    .cci-code { font-size: .7rem; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
    .cci-sub { font-size: .7rem; color: var(--text-muted); }
    .cci-cero { color: var(--bad); font-weight: 600; }
    .cci-prov { font-size: .7rem; color: var(--warn); }
    .cci-debil { font-style: italic; }

    .cci-proc { display: flex; flex-wrap: wrap; gap: var(--space-4, 1rem);
      padding: .6rem .75rem; border-top: 1px solid var(--surface-border); font-size: .76rem; }
    .cci-proc > div { display: flex; flex-direction: column; gap: .1rem; min-width: 12rem; flex: 1 1 14rem; }
    .cci-proc-k { font-size: .68rem; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
    .cci-proc-v { color: var(--text); }
    .cci-proc-v[data-fresh="stale"], .cci-proc-v[data-fresh="unknown"] { color: var(--warn); }
    .cci-lento { color: var(--warn); }

    .cci-error { display: flex; align-items: flex-start; gap: .6rem; padding: .7rem .85rem;
      border: 1px solid var(--bad); border-radius: var(--radius-md, .5rem); }
    .cci-error-d { font-size: .78rem; color: var(--text-muted); }
    .cci-btn { margin-left: auto; padding: .25rem .7rem; border: 1px solid var(--surface-border);
      border-radius: var(--radius-sm, .25rem); background: transparent; color: inherit; cursor: pointer; }

    .cci-skel { display: flex; flex-direction: column; gap: .5rem; }
    .cci-skel-row { height: 2.6rem; border-radius: var(--radius-md, .5rem);
      background: linear-gradient(90deg, var(--surface-card) 25%, var(--surface-hover) 50%, var(--surface-card) 75%);
      background-size: 200% 100%; animation: cci-sh 1.3s ease-in-out infinite; }
    @keyframes cci-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .cci-skel-row { animation: none; } }
  `],
})
export class ContabilidadCierreComponent implements OnInit {
  private readonly api = inject(CierreContableService);
  private readonly destroyRef = inject(DestroyRef);

  readonly data = signal<CierreResp | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  /** Sólo los meses cerrados: el que corre está incompleto por definición y no se juzga. */
  readonly cerrados = computed(() => soloCerrados(this.data()?.meses ?? []));
  readonly faltantes = computed(() => faltantesDe(this.data()?.meses ?? []));
  readonly peorCerrado = computed<EstadoCierre>(() => peorDeCerrados(this.data()?.meses ?? []));
  readonly familiasPorMes = computed(() => this.data()?.meses[0]?.familias.length ?? 0);

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.cierre().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: (e) => {
        this.error.set(e?.error?.message || e?.message || 'Error desconocido');
        this.loading.set(false);
      },
    });
  }

  texto = textoEstado;
}

/*
 * ── Las reglas de lectura, PURAS y exportadas ───────────────────────────────────────────────
 * Fuera de la clase a propósito, igual que `[CP.8.33]`: así el candado las prueba sin levantar
 * jsdom ni arrastrar PrimeNG y media app en imports transitivos. Lo que acá puede mentir es un
 * número en el encabezado, y eso se prueba con funciones, no con un componente montado.
 */

/** Un mes cerrado es el único que se puede juzgar. El que corre está incompleto por definición. */
export function soloCerrados(meses: readonly MesCierre[]): MesCierre[] {
  return meses.filter((m) => m.periodo_estado === 'cerrado');
}

export interface FaltanteCierre {
  mes: string;
  familia: string;
  etiqueta: string;
  senal: number;
  renglones: number;
  testigo: number | null;
  testigo_fuente: string;
  escala_a: string | null;
}

/**
 * ⭐ Lo accionable, y nada más: familias en `bad` de meses **cerrados**.
 *
 * ⛔ `sin_meta` y `sin_medir` quedan FUERA del titular a propósito. Son trabajo de otra persona
 * —uno lo arregla quien registra el umbral, el otro Sistemas— y mezclarlos vuelve el encabezado
 * un número que no le dice a nadie qué hacer: la lección de `[CP.8.32]` («1,474 pendientes») y la
 * de `[LC.16]`, donde el rojo significaba cuatro cosas y una de ellas era «todo bien».
 */
export function faltantesDe(meses: readonly MesCierre[]): FaltanteCierre[] {
  return soloCerrados(meses).flatMap((m) =>
    m.familias
      .filter((f) => f.estado === 'bad')
      .map((f) => ({
        mes: m.anio_mes,
        familia: f.familia,
        etiqueta: f.etiqueta,
        senal: f.senal,
        renglones: f.senal_renglones,
        testigo: f.cobertura_base === 'testigo' ? f.testigo : f.mediana_6m,
        testigo_fuente: f.testigo_fuente ?? 'mediana de 6 meses',
        escala_a: f.escala_a,
      })),
  );
}

/**
 * El color del encabezado. ⚠️ Sin meses cerrados devuelve `sin_medir`, **no `ok`**: una lista
 * vacía no es un cierre sano, es que no hay nada que juzgar.
 */
export function peorDeCerrados(meses: readonly MesCierre[]): EstadoCierre {
  const ms = soloCerrados(meses);
  if (ms.some((m) => m.estado === 'bad')) return 'bad';
  if (ms.some((m) => m.estado === 'warn')) return 'warn';
  if (ms.length > 0 && ms.every((m) => m.estado === 'ok')) return 'ok';
  return 'sin_medir';
}

/** ⛔ Las dos ausencias NO comparten texto: una la arregla Dirección, la otra Sistemas. */
export function textoEstado(e: EstadoCierre): string {
  switch (e) {
    case 'ok': return 'Asentado';
    case 'warn': return 'Corto';
    case 'bad': return 'Sin asentar';
    case 'sin_meta': return 'Sin umbral';
    default: return 'Sin medir';
  }
}
