import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import {
  MiCierreService, type MiCierreResp, type FilaBandeja, type EstadoBandeja,
} from '../mi-cierre.service';
import { CierreContableService, type CierreResp } from '../cierre-contable.service';

/**
 * `[CPA.10]` — **La bandeja «Mi cierre»**, la portada nueva de `/contabilidad`.
 *
 * ── Por qué esta pantalla existe, medido contra prod el 2026-10-12 ──────────────────────────
 * El rol `contabilidad` hizo **3,604 llamadas en 10 días activos** y **cero** a `/api/fiscal/*`
 * y a `/api/contabilidad/*`. De esas, **1,806 (50.1 %)** fueron al módulo de comprobación de
 * gastos — que no es suyo. Tienen los **19 permisos `FISCAL_*` en `true`** y entran a diario.
 * No es acceso, ni permiso, ni capacitación: las 16 pestañas del proyecto son **visores**
 * (6 de 16 servicios son sólo GET) y su trabajo es **teclear** ~12,357 renglones al mes.
 *
 * El módulo que sí adoptaron tiene cuatro cosas que éste no tenía: una cola personal
 * (`GET /mine`), el OCR tecleando por ellos, un cierre de tres salidas, y empuje. Esta pantalla
 * copia la forma: *«esto es lo que ContPAQi espera de ti este mes»*.
 *
 * ── Las decisiones de lectura, y qué defecto evita cada una ─────────────────────────────────
 *  1. ⭐ **Answer-first.** Lo primero es cuánto tecleo se ahorra y qué mes está roto, no una
 *     tabla que haya que leer. `[LC.16]` midió que la primera fila útil aparecía al 63 % del alto.
 *  2. ⛔ **`aplicada_sin_verificar` tiene su propio color y su propio renglón.** No es un matiz
 *     de «aplicada»: es «nadie comprobó». Pintarlos igual convierte *no sé* en *listo* (ADR-056).
 *  3. ⛔ **El rojo se reserva para lo accionable.** `falta_mapa` es ámbar (lo destraba Sistemas),
 *     `rechazada` es rojo (lo destraba contabilidad). Un rojo que significa cuatro cosas deja de
 *     leerse — 258 de 446 filas en rojo, y 159 decían «ya está en el libro».
 *  4. ⭐ **Lo que no tiene fuente se DECLARA con dueño**, no se esconde ni se cuenta como cero.
 *  5. ⚠️ **No re-juzga si el mes está completo**: eso lo contesta el semáforo de `[CPA.0]`, que
 *     ya lo hace contra un testigo independiente. Acá se compone su veredicto, no se recalcula.
 *
 * Operations: denso, tokens, hairline sin sombra, dark-safe, cifras en mono tabular.
 */
@Component({
  selector: 'app-contabilidad-mi-cierre',
  standalone: true,
  imports: [CommonModule, RouterLink, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in mc-page">

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mi cierre</h1>
          <p class="surf-page-sub">
            Esto es lo que ContPAQi espera de ti este mes. Lo que tiene fuente de este lado se arma
            solo; lo que no, se dice con su motivo y con qui&eacute;n lo destraba.
          </p>
        </div>
        <div class="mc-head-right">
          @if (resp(); as r) {
            <app-freshness-pill measures="data" [freshness]="r.freshness" label="Pólizas" />
          }
          <label class="mc-mes-l" for="mc-mes">Periodo</label>
          <select id="mc-mes" class="mc-mes mono" [value]="mes()" (change)="cambiarMes($event)">
            @for (m of mesesDisponibles(); track m) {
              <option [value]="m">{{ m }}{{ m === mesActual ? ' · en curso' : '' }}</option>
            }
          </select>
        </div>
      </header>

      @if (error(); as e) {
        <div class="mc-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <div>
            <strong>No se pudo leer la bandeja.</strong>
            <div class="mc-error-d">{{ e }}</div>
          </div>
          <button type="button" class="mc-btn" (click)="cargar()">Reintentar</button>
        </div>
      }

      @if (loading()) {
        <div class="mc-skel" aria-busy="true">@for (i of [1,2,3,4,5,6]; track i) { <div class="mc-skel-row"></div> }</div>
      } @else if (resp(); as r) {

        <!-- EL VEREDICTO, antes que cualquier tabla -->
        <section class="mc-verdict">
          <div class="mc-eyebrow">Renglones que ya no tecleas en {{ r.bandeja.anio_mes }}</div>
          @if (r.bandeja.cobertura_pct === null) {
            <h2>Este mes todav&iacute;a no tiene renglones capturados.</h2>
            <p class="mc-lede">
              Sin renglones no hay cobertura que medir &mdash; no es 0&nbsp;%, es
              <strong>sin medir</strong>.
            </p>
          } @else {
            <h2>
              <span class="mono">{{ r.bandeja.automatizables | number }}</span>
              de <span class="mono">{{ r.bandeja.total_renglones | number }}</span>
              salen armados de la Suite.
            </h2>
            <div class="mc-bar" role="img"
                 [attr.aria-label]="'Cobertura ' + r.bandeja.cobertura_pct + ' por ciento'">
              <span [style.width.%]="r.bandeja.cobertura_pct"></span>
            </div>
            <p class="mc-lede">
              <strong class="mono">{{ r.bandeja.cobertura_pct }}&nbsp;%</strong> de cobertura.
              {{ r.coverage.note }}
            </p>
          }
        </section>

        <!-- LO QUE EST&Aacute; ROTO, compuesto del sem&aacute;foro de CPA.0 -->
        @if (mesesRotos().length > 0) {
          <section class="mc-alert" role="alert">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <div class="mc-alert-b">
              <div class="mc-alert-t">
                @if (mesesRotos().length === 1) {
                  Un mes cerrado tiene familias sin asentar.
                } @else {
                  <span class="mono">{{ mesesRotos().length }}</span> meses cerrados tienen familias sin asentar.
                }
              </div>
              <div class="mc-alert-d">
                @for (m of mesesRotos(); track m.mes) {
                  <span class="mc-roto"><strong class="mono">{{ m.mes }}</strong> &mdash; {{ m.que }}</span>
                }
              </div>
            </div>
            <a class="mc-btn" routerLink="/contabilidad/cierre">Ver el sem&aacute;foro</a>
          </section>
        }

        <!-- LA TABLA -->
        <section class="mc-card">
          <div class="mc-card-h">
            <h3>{{ r.bandeja.anio_mes }}</h3>
            <span class="mc-tag mono">{{ r.bandeja.filas.length }} familias · {{ r.bandeja.total_renglones | number }} renglones</span>
            @if (r.bandeja.en_curso) {
              <span class="mc-curso">mes en curso &mdash; va a crecer</span>
            }
            <span class="mc-grow"></span>
            <span class="mc-ms mono" [class.lento]="r.query_ms > 500">{{ r.query_ms }} ms</span>
          </div>

          <div class="mc-scroll">
            <table class="mc-tbl">
              <caption class="sr-only">Familias de captura del mes, su estado y la acci&oacute;n pendiente</caption>
              <thead>
                <tr>
                  <th scope="col" class="c-est">Estado</th>
                  <th scope="col">Qu&eacute; se asienta</th>
                  <th scope="col" class="num">Renglones</th>
                  <th scope="col" class="num">Cargos</th>
                  <th scope="col" class="c-src">De d&oacute;nde sale</th>
                  <th scope="col" class="c-act">Acci&oacute;n</th>
                </tr>
              </thead>
              <tbody>
                @for (g of grupos(); track g.clave) {
                  <tr class="mc-grp">
                    <td colspan="6">
                      {{ g.titulo }} · <span class="mono">{{ g.renglones | number }}</span> renglones
                    </td>
                  </tr>
                  @for (f of g.filas; track f.familia) {
                    <tr>
                      <td class="c-est">
                        <span class="mc-pill" [attr.data-estado]="f.estado">
                          <span class="mc-dot"></span>{{ texto(f.estado) }}
                        </span>
                      </td>
                      <td>
                        <span class="mc-fam">{{ f.etiqueta }}</span>
                        @if (f.motivo) { <span class="mc-motivo">{{ f.motivo }}</span> }
                      </td>
                      <td class="num mono">{{ f.renglones | number }}</td>
                      <td class="num mono">
                        @if (f.cargos > 0) { {{ f.cargos | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                        @else { <span class="mc-na">&mdash;</span> }
                      </td>
                      <td class="c-src">
                        @if (f.fuente) { <span class="mc-src">{{ f.fuente }}</span> }
                        @else { <span class="mc-na">sin fuente &mdash; {{ f.dueno }}</span> }
                      </td>
                      <td class="c-act">
                        @switch (f.estado) {
                          @case ('lista') {
                            <a class="mc-btn pri" [routerLink]="['/contabilidad/contpaqi-puente']">Armar</a>
                          }
                          @case ('entregada') {
                            <a class="mc-btn warn" [routerLink]="['/contabilidad/contpaqi-puente']">&iquest;La acept&oacute;?</a>
                          }
                          @case ('rechazada') {
                            <a class="mc-btn bad" [routerLink]="['/contabilidad/contpaqi-puente']">Corregir</a>
                          }
                          @case ('aplicada_sin_verificar') {
                            <a class="mc-btn warn" [routerLink]="['/contabilidad/contpaqi-puente']">Subir bit&aacute;cora</a>
                          }
                          @case ('falta_mapa') {
                            <a class="mc-btn" [routerLink]="['/contabilidad/contpaqi-puente']">Resolver mapa</a>
                          }
                          @case ('aplicada') {
                            <span class="mc-when mono">{{ f.actualizada_en | date:'dd/MM HH:mm' }}</span>
                          }
                          @default { <span class="mc-na">&mdash;</span> }
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </section>

        <!-- Las 16 pesta&ntilde;as, demotadas a detalle -->
        <section class="mc-card mc-chips">
          <div class="mc-eyebrow">Detalle y herramientas</div>
          <div class="mc-chip-row">
            @for (d of DETALLE; track d.ruta) {
              <a class="mc-chip" [routerLink]="d.ruta">{{ d.label }}</a>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .mc-page { display: flex; flex-direction: column; gap: 1rem; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

    .mc-head-right { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .mc-mes-l { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em;
      color: var(--text-muted); font-weight: var(--fw-medium); }
    .mc-mes { height: 32px; border: 1px solid var(--border-color); background: var(--card-bg);
      border-radius: var(--r-sm); padding: 0 .6rem; font-size: var(--fs-sm); color: var(--text-main); }

    .mc-error { display: flex; gap: .75rem; align-items: center; padding: .85rem 1rem;
      border: 1px solid var(--bad-border); background: var(--card-bg);
      border-left: 3px solid var(--bad-fg); border-radius: var(--r-md); }
    .mc-error i { color: var(--bad-fg); }
    .mc-error-d { font-size: var(--fs-xs); color: var(--text-muted); }

    .mc-skel { display: flex; flex-direction: column; gap: .5rem; }
    .mc-skel-row { height: 44px; border-radius: var(--r-md); background: var(--skeleton-bg); opacity: .55; }

    .mc-verdict { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: 1rem 1.15rem; }
    .mc-eyebrow { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em;
      color: var(--text-muted); font-weight: var(--fw-medium); margin-bottom: .5rem; }
    .mc-verdict h2 { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold);
      letter-spacing: -.015em; line-height: 1.25; }
    .mc-verdict h2 .mono { font-size: 1.45rem; }
    .mc-bar { height: 5px; border-radius: 3px; background: var(--neutral-200);
      overflow: hidden; margin: .7rem 0 .55rem; }
    .mc-bar > span { display: block; height: 100%; background: var(--action); border-radius: 3px; }
    .mc-lede { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }

    .mc-alert { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap;
      background: var(--card-bg); border: 1px solid var(--bad-border);
      border-left: 3px solid var(--bad-fg); border-radius: var(--r-md); padding: .85rem 1.1rem; }
    .mc-alert > i { color: var(--bad-fg); font-size: 1.05rem; }
    .mc-alert-b { flex: 999 1 24rem; min-width: 0; }
    .mc-alert-t { font-size: var(--fs-body); font-weight: var(--fw-bold); margin-bottom: .15rem; }
    .mc-alert-d { font-size: var(--fs-xs); color: var(--text-muted); display: flex;
      flex-wrap: wrap; gap: .15rem 1rem; }

    .mc-card { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); overflow: hidden; }
    .mc-card-h { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
      padding: .6rem .9rem; border-bottom: 1px solid var(--border-color); }
    .mc-card-h h3 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .mc-tag { font-size: var(--fs-micro); color: var(--text-muted);
      background: var(--surface-ground); border-radius: 999px; padding: .15rem .5rem; }
    .mc-curso { font-size: var(--fs-micro); color: var(--text-muted); font-style: italic; }
    .mc-grow { flex-grow: 1; }
    .mc-ms { font-size: var(--fs-micro); color: var(--text-faint); }
    .mc-ms.lento { color: var(--warn-fg); font-weight: var(--fw-medium); }

    .mc-scroll { overflow-x: auto; }
    .mc-tbl { width: 100%; border-collapse: collapse; min-width: 62rem; }
    .mc-tbl th { text-align: left; font-size: var(--fs-micro); text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-muted); font-weight: var(--fw-medium);
      padding: .55rem .75rem; background: var(--surface-ground); white-space: nowrap; }
    .mc-tbl td { padding: 0 .75rem; height: var(--row-h-lg, 48px);
      border-top: 1px solid var(--table-border); font-size: var(--fs-sm); vertical-align: middle; }
    .mc-tbl tbody tr:hover td { background: var(--table-hover); }
    .mc-tbl .num { text-align: right; }
    .c-est { width: 11rem; } .c-src { width: 17rem; } .c-act { width: 9.5rem; text-align: right; }

    .mc-grp td { background: var(--surface-ground); height: auto; padding: .4rem .9rem;
      font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .06em;
      color: var(--text-muted); font-weight: var(--fw-bold);
      border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); }
    .mc-grp:hover td { background: var(--surface-ground); }

    .mc-fam { font-weight: var(--fw-medium); display: block; }
    .mc-motivo { display: block; font-size: var(--fs-xs); color: var(--text-muted);
      line-height: 1.3; margin-top: .1rem; }
    .mc-src { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.3;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .mc-na { color: var(--text-faint); font-size: var(--fs-xs); }
    .mc-when { font-size: var(--fs-xs); color: var(--text-muted); }

    .mc-pill { display: inline-flex; align-items: center; gap: .35rem; height: 21px;
      padding: 0 .55rem; border-radius: 999px; font-size: var(--fs-micro);
      font-weight: var(--fw-bold); white-space: nowrap; }
    .mc-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
    .mc-pill[data-estado="lista"] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .mc-pill[data-estado="entregada"] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .mc-pill[data-estado="aplicada"] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .mc-pill[data-estado="aplicada_sin_verificar"] { background: var(--warn-soft-bg);
      color: var(--warn-soft-fg); box-shadow: inset 0 0 0 1px var(--warn-border); }
    .mc-pill[data-estado="rechazada"] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .mc-pill[data-estado="falta_mapa"] { background: var(--surface-ground); color: var(--text-muted);
      box-shadow: inset 0 0 0 1px var(--border-color); }
    .mc-pill[data-estado="no_automatizable"] { background: transparent; color: var(--text-muted);
      box-shadow: inset 0 0 0 1px var(--border-color); }
    .mc-pill[data-estado="no_automatizable"] .mc-dot { background: transparent;
      box-shadow: inset 0 0 0 1px currentColor; }

    .mc-btn { display: inline-flex; align-items: center; height: 28px; padding: 0 .7rem;
      border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main);
      border-radius: var(--r-sm); font-size: var(--fs-xs); font-weight: var(--fw-bold);
      cursor: pointer; text-decoration: none; white-space: nowrap; }
    .mc-btn:hover { background: var(--hover-bg); }
    .mc-btn.pri { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .mc-btn.pri:hover { background: var(--action-hover); border-color: var(--action-hover); }
    .mc-btn.warn { border-color: var(--warn-border); color: var(--warn-soft-fg); }
    .mc-btn.bad { border-color: var(--bad-border); color: var(--bad-soft-fg); }

    .mc-chips { padding: .8rem .9rem; }
    .mc-chip-row { display: flex; flex-wrap: wrap; gap: .4rem; }
    .mc-chip { display: inline-flex; align-items: center; height: 28px; padding: 0 .65rem;
      border: 1px solid var(--border-color); border-radius: 999px; background: var(--surface-ground);
      font-size: var(--fs-xs); color: var(--text-main); text-decoration: none; }
    .mc-chip:hover { background: var(--hover-bg); }

    @media (max-width: 48rem) {
      .mc-tbl { min-width: 48rem; }
      .c-src { display: none; }
    }
  `],
})
export class ContabilidadMiCierreComponent implements OnInit {
  private readonly svc = inject(MiCierreService);
  private readonly semaforo = inject(CierreContableService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly resp = signal<MiCierreResp | null>(null);
  readonly cierre = signal<CierreResp | null>(null);

  readonly mesActual = mesDeHoy();
  readonly mes = signal<string>(this.mesActual);

  /** Los 13 meses de siempre: doce para comparar y el que corre. */
  readonly mesesDisponibles = computed(() => {
    const out: string[] = [];
    for (let i = 0; i < 13; i++) out.push(mesMenos(this.mesActual, i));
    return out;
  });

  /** Las pestañas que antes eran la portada. No se borran: pasan a ser el detalle. */
  readonly DETALLE: ReadonlyArray<{ label: string; ruta: string }> = [
    { label: 'Semáforo de cierre', ruta: '/contabilidad/cierre' },
    { label: 'Puente ContPAQi', ruta: '/contabilidad/contpaqi-puente' },
    { label: 'Libro de Compras', ruta: '/contabilidad/libro-de-compras' },
    { label: 'No asociados', ruta: '/contabilidad/movimientos-no-asociados' },
    { label: 'CFDI', ruta: '/contabilidad/cfdi' },
    { label: 'Balanza ContPAQi', ruta: '/contabilidad/contpaqi' },
    { label: 'Pólizas', ruta: '/contabilidad/polizas' },
    { label: 'Conciliación', ruta: '/contabilidad/conciliacion' },
    { label: 'DIOT / IVA', ruta: '/contabilidad/diot' },
    { label: 'Listas SAT', ruta: '/contabilidad/listas-sat' },
    { label: 'Materialidad', ruta: '/contabilidad/materialidad' },
    { label: 'Descarga CFDI', ruta: '/contabilidad/descarga' },
    { label: 'Provisionales', ruta: '/contabilidad/impuestos' },
  ];

  /**
   * Dos grupos, y el orden importa: primero lo que la Suite arma, después lo que sigue a mano.
   * ⛔ Lo segundo NO se esconde ni se cuenta como cero — se declara con su motivo y su dueño.
   */
  readonly grupos = computed(() => {
    const r = this.resp();
    if (!r) return [];
    const suite = r.bandeja.filas.filter((f) => f.automatizable);
    const mano = r.bandeja.filas.filter((f) => !f.automatizable);
    const sum = (xs: FilaBandeja[]) => xs.reduce((a, f) => a + f.renglones, 0);
    return [
      { clave: 'suite', titulo: 'Sale armado de la Suite', filas: suite, renglones: sum(suite) },
      { clave: 'mano', titulo: 'Todavía a mano — y decimos por qué', filas: mano, renglones: sum(mano) },
    ].filter((g) => g.filas.length > 0);
  });

  /**
   * Los meses cerrados con algo sin asentar, tomados del semáforo de `[CPA.0]`.
   * ⭐ Se COMPONE su veredicto en vez de recalcularlo: dos tableros que emiten el mismo juicio por
   * caminos distintos terminan contradiciéndose, y el que pierde credibilidad es el nuevo.
   */
  readonly mesesRotos = computed(() => {
    const c = this.cierre();
    if (!c) return [];
    return c.meses
      .filter((m) => m.periodo_estado === 'cerrado' && m.estado === 'bad')
      .map((m) => ({
        mes: m.anio_mes,
        que: m.familias.filter((f) => f.estado === 'bad').map((f) => f.etiqueta).join(', ')
          || 'sin detalle',
      }))
      .slice(0, 4);
  });

  ngOnInit(): void { this.cargar(); }

  cambiarMes(ev: Event): void {
    this.mes.set((ev.target as HTMLSelectElement).value);
    this.cargar();
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc.bandeja(this.mes())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.resp.set(r); this.loading.set(false); },
        error: (e) => {
          this.error.set(e?.error?.message ?? e?.message ?? 'Error desconocido');
          this.loading.set(false);
        },
      });
    // El semáforo alimenta la alerta de arriba. Si falla, la bandeja igual sirve: la alerta
    // simplemente no aparece. Un tablero que se cae entero porque su nota al pie falló es peor.
    this.semaforo.cierre()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (c) => this.cierre.set(c), error: () => this.cierre.set(null) });
  }

  texto(e: EstadoBandeja): string {
    switch (e) {
      case 'lista': return 'Lista para armar';
      case 'entregada': return 'Entregada, sin confirmar';
      case 'aplicada': return 'Aplicada';
      case 'aplicada_sin_verificar': return 'Aplicada sin verificar';
      case 'rechazada': return 'Rechazada';
      case 'falta_mapa': return 'Falta el mapa';
      case 'no_automatizable': return 'A mano';
    }
  }
}

function mesDeHoy(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mesMenos(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
