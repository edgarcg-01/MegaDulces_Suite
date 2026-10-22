import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import {
  CierreContableService, type CierreResp, type EstadoCierre, type FamiliaCierre, type MesCierre,
  type RenglonesCierre,
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
  imports: [CommonModule, TableModule, SidePeekComponent],
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
                      <!-- LC.21: el asentado abre sus renglones de póliza; con 0 no hay nada que abrir. -->
                      @if (f.senal_renglones > 0) {
                        <button type="button" class="cci-drill" (click)="abrir(m.anio_mes, f, false)"
                                [attr.aria-label]="'Ver los ' + f.senal_renglones + ' renglones de ' + f.etiqueta + ' en ' + m.anio_mes">
                          <span class="mono">{{ f.senal | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                          <span class="cci-sub">{{ f.senal_renglones | number }} {{ f.senal_renglones === 1 ? 'renglón' : 'renglones' }}</span>
                        </button>
                      } @else {
                        <span class="mono muted">{{ f.senal | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                        <!-- ⛔ Sin esto, "$0" y "nadie capturó nada" se leen igual. -->
                        <!-- ⚠️ El plural va con el carácter real: una entidad HTML dentro de una
                             interpolación se imprime tal cual ("rengl&oacute;n"), no se resuelve. -->
                        <div class="cci-sub cci-cero">0 renglones</div>
                      }
                      @if (f.provisional) {
                        <button type="button" class="cci-drill cci-prov" (click)="abrir(m.anio_mes, f, true)"
                                [attr.aria-label]="'Ver lo fechado adelante de ' + f.etiqueta + ' en ' + m.anio_mes">
                          + {{ f.provisional | currency:'MXN':'symbol-narrow':'1.0-0' }} fechado adelante
                          &mdash; no cuenta
                        </button>
                      }
                    </td>
                    <td class="ta-r">
                      @if (f.cobertura_base === 'testigo') {
                        <span class="mono">{{ f.testigo | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                        <div class="cci-sub">{{ f.testigo_fuente }}</div>
                      } @else {
                        <span class="mono">{{ f.mediana_6m | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                        <!-- ⭐ Se declara que este testigo es más débil, no se disfraza. Y sobre
                             CUÁNTOS meses descansa: uno sobre n=1 se veía igual que uno sobre n=6. -->
                        <div class="cci-sub cci-debil">
                          mediana de {{ f.mediana_meses }} mes{{ f.mediana_meses === 1 ? '' : 'es' }}
                          &mdash; sin testigo propio
                        </div>
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
                      <!-- ⭐ «Falta» y «sobra» pintan igual de rojo pero se arreglan al revés:
                           uno lo asienta la contadora, el otro hay que DESHACERLO. -->
                      <span class="cci-pill" [attr.data-estado]="f.estado">
                        {{ f.por_exceso ? 'De m&aacute;s' : texto(f.estado) }}
                      </span>
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

      <!-- LC.21: los renglones de póliza detrás de una celda del semáforo. -->
      <app-side-peek [open]="!!panel()" (openChange)="cerrarPanel($event)" [width]="760"
                     [title]="tituloPanel()" [subtitle]="subtituloPanel()">
        @if (cargandoPanel() && !renglones()) { <p class="cci-note muted">Cargando…</p> }
        @if (errorPanel(); as e) { <p class="cci-note cci-bad" role="alert">No se pudo cargar el detalle: {{ e }}</p> }
        @if (renglones(); as r) {
          <p class="cci-note">
            <strong class="mono">{{ r.renglones | number }}</strong> {{ r.renglones === 1 ? 'renglón' : 'renglones' }}
            por <strong class="mono">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>
            &mdash; {{ r.filtro }}{{ r.provisional ? ', en pólizas con fecha posterior a hoy (no cuentan para el mes)' : ', sin las pólizas fechadas adelante' }}.
          </p>
          @if (difiere(r); as d) { <p class="cci-note cci-warn-t">{{ d }}</p> }
          <p-table [value]="r.filas" size="small" class="surf-table" [scrollable]="true" scrollHeight="60vh">
            <ng-template #header>
              <tr><th>Póliza</th><th>Cuenta</th><th class="ta-r">Cargo</th><th class="ta-r">Abono</th><th>Concepto / referencia</th></tr>
            </ng-template>
            <ng-template #body let-x>
              <tr>
                <td class="mono">{{ tipoPoliza(x.tipo_pol) }} {{ x.folio }} &middot; {{ x.num_movto }}</td>
                <td><span class="mono">{{ x.cuenta }}</span>@if (x.cuenta_nombre) { <div class="cci-sub">{{ x.cuenta_nombre }}</div> }</td>
                <td class="ta-r mono">{{ x.cargo_abono === 'C' ? (x.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                <td class="ta-r mono">{{ x.cargo_abono === 'A' ? (x.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                <td class="muted">{{ x.concepto || x.referencia || '—' }}</td>
              </tr>
            </ng-template>
          </p-table>
          @if (r.filas.length < r.renglones) {
            <p class="cci-note muted">
              Mostrando {{ r.filas.length | number }} de {{ r.renglones | number }}
              <button type="button" class="cci-link" [disabled]="cargandoPanel()" (click)="masPanel()">Cargar más</button>
            </p>
          }
        }
      </app-side-peek>
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

    .cci-drill { display: inline-flex; flex-direction: column; align-items: flex-end; gap: .05rem;
      font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: right; }
    .cci-drill > .mono { text-decoration: underline dotted; text-underline-offset: 3px; }
    .cci-drill:hover > .mono, .cci-drill.cci-prov:hover { text-decoration: underline; }
    .cci-drill.cci-prov { text-decoration: underline dotted; text-underline-offset: 3px; }
    .cci-drill:focus-visible, .cci-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cci-link { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer;
      text-decoration: underline dotted; text-underline-offset: 3px; }
    .cci-note { margin: 0 0 .6rem; font-size: .82rem; line-height: 1.45; }
    .cci-bad { color: var(--bad); }
    .cci-warn-t { color: var(--warn); }

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
  difiere = difiereDelSemaforo;

  // ── LC.21: el desglose de una celda ──
  readonly panel = signal<{ mes: string; familia: string; etiqueta: string; provisional: boolean } | null>(null);
  readonly renglones = signal<RenglonesCierre | null>(null);
  readonly cargandoPanel = signal(false);
  readonly errorPanel = signal<string | null>(null);
  readonly tituloPanel = computed(() => {
    const p = this.panel();
    return p ? `${p.etiqueta} · ${p.mes}` : '';
  });
  readonly subtituloPanel = computed(() =>
    this.panel()?.provisional ? 'Fechado adelante: no cuenta para el mes' : 'Lo asentado en ContPAQi');
  private pagina = 1;

  abrir(mes: string, f: FamiliaCierre, provisional: boolean): void {
    this.panel.set({ mes, familia: f.familia, etiqueta: f.etiqueta, provisional });
    this.renglones.set(null);
    this.pagina = 1;
    this.traerPanel();
  }

  masPanel(): void { this.pagina += 1; this.traerPanel(); }

  cerrarPanel(abierto: boolean): void { if (!abierto) { this.panel.set(null); this.renglones.set(null); } }

  private traerPanel(): void {
    const p = this.panel();
    if (!p) return;
    this.cargandoPanel.set(true);
    this.errorPanel.set(null);
    this.api.renglones(p.mes, p.familia, p.provisional, this.pagina).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        // Una respuesta que llega después de cambiar de celda no se mezcla con la nueva.
        const actual = this.panel();
        if (!actual || actual.mes !== r.mes || actual.familia !== r.familia || actual.provisional !== r.provisional) return;
        const prev = this.renglones();
        this.renglones.set(r.page > 1 && prev ? { ...r, filas: [...prev.filas, ...r.filas] } : r);
        this.cargandoPanel.set(false);
      },
      error: (e) => {
        this.errorPanel.set(e?.error?.message || e?.message || 'Error desconocido');
        this.cargandoPanel.set(false);
      },
    });
  }

  tipoPoliza(t: string): string { return ({ '1': 'Ingreso', '2': 'Egreso', '3': 'Diario' } as Record<string, string>)[t] ?? `Tipo ${t}`; }
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

/**
 * `[LC.21]` Si el desglose (al momento) y el semáforo (matvista, recalculada @15 min) no dicen lo
 * mismo, se dice cuál es cuál — no se elige uno en silencio. `null` = coinciden, o no hay con qué.
 */
export function difiereDelSemaforo(r: RenglonesCierre): string | null {
  const s = r.semaforo;
  if (!s || s.importe === null) return null;
  const mismoImporte = Math.abs(s.importe - r.importe) < 0.01;
  const mismosRenglones = s.renglones === null || s.renglones === r.renglones;
  if (mismoImporte && mismosRenglones) return null;
  const fmt = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  return `El semáforo dice ${fmt(s.importe)}${s.renglones !== null ? ` en ${s.renglones} renglones` : ''}; `
    + `aquí, leído al momento, ${fmt(r.importe)}${s.renglones !== null ? ` en ${r.renglones}` : ''}. `
    + 'ContPAQi cambió después del último recálculo del semáforo (cada 15 min).';
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
