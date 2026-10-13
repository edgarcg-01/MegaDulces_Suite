import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { PresupuestoDireccion } from '@megadulces/contracts';
import { MetricStripComponent } from '../../../../shared/components/metric-strip/metric-strip.component';
import { environment } from '../../../../../environments/environment';
import { PRESUPUESTO_STYLES } from './presupuesto.styles';
import {
  avisoCorridasConError, huecosOrdenados, leyendaCadencia, metricasDireccion,
  montoODeclarado, pesoTexto, respuestaDireccion,
} from './presupuesto-direccion';
import type { HuecoDeclarado } from '@megadulces/contracts';

/**
 * `[PU.DIR.1]` — **La vista «Dirección» de `/presupuesto`.**
 *
 * Primera vista del módulo: **contesta y manda a las otras siete**, no las reemplaza. Por eso no
 * agrega ninguna cifra propia — re-publica las del contrato `GET budgets/direccion` con su
 * universo pegado, y cada fila que lleva a algún lado emite la vista destino.
 *
 * ── ⛔ POR QUÉ NO RENDERIZA LA BANDEJA DE FIRMAS ──────────────────────────────
 *
 * Porque ya está en pantalla. El shell la pinta arriba de todas las vistas desde `[TES.17]`, con
 * su conteo por cola y su propio estado de error. Repetirla acá sería un segundo lugar donde leer
 * el mismo número, que es exactamente como se duplican las cifras en este dominio.
 *
 * ── ⚠️ POR QUÉ ESTA ENTREGA NO TRAE LAS TRES PESTAÑAS DEL PROTOTIPO ──────────
 *
 * Porque el contrato cubre **cuatro bloques y los huecos**, y el prototipo tiene nueve tarjetas.
 * De las cinco que faltan —lo pagado por fuera, el ciclo de efectivo, las seis derivaciones del
 * DPO, la concentración y el plan contra la venta real— **ninguna tiene campo en
 * `PresupuestoDireccion`**. Dibujarlas exigiría escribir sus cifras en la plantilla, que es
 * justo lo que la regla de este carril prohíbe.
 *
 * ⇒ Van los bloques que el contrato sostiene, en una columna. Las pestañas son un envoltorio y
 * se agregan cuando los bloques que faltan tengan de dónde salir: hoy dos de las tres quedarían
 * con una tarjeta cada una, y sus contadores (`6 derivaciones`, `0 metas`) tampoco tienen campo.
 */
@Component({
  selector: 'app-presupuesto-direccion',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, MetricStripComponent],
  template: `
    @if (cargando()) {
      <p class="pres-empty">Midiendo…</p>
    } @else if (errorGeneral(); as e) {
      <!-- La respuesta entera falló. Se dice; no se deja la vista en blanco, que se lee como
           "no hay nada que decir" en vez de "no se pudo medir". -->
      <div class="pres-alert"><i class="pi pi-exclamation-triangle"></i> {{ e }}</div>
    } @else if (datos(); as d) {

      @if (respuesta(); as r) {
        <section class="pres-dir-answer">
          <span class="pres-dir-answer-k">La respuesta</span>
          <p class="pres-dir-answer-v">{{ r.titular }}</p>
          @if (r.detalle) { <p class="pres-dir-answer-w">{{ r.detalle }}</p> }
          @if (r.sinMedir.length) {
            <p class="pres-dir-answer-gap">
              <i class="pi pi-info-circle"></i>
              Esta respuesta no cubre {{ r.sinMedir.join(' ni ') }}: no se pudo medir.
            </p>
          }
        </section>
      }

      <app-metric-strip [items]="metricas()" ariaLabel="Estado del presupuesto" />

      @if (aviso(); as a) {
        <div class="pres-alert"><i class="pi pi-exclamation-triangle"></i> {{ a }}</div>
      }

      <!-- ══ LOS EJERCICIOS ══ -->
      <section class="pres-section">
        <div class="pres-section-head">
          <h2>Los ejercicios</h2>
        </div>
        @if (d.ejercicios_error; as e) {
          <div class="pres-alert"><i class="pi pi-exclamation-triangle"></i> {{ e }}</div>
        } @else if (!d.ejercicios) {
          <p class="pres-empty">El bloque llegó vacío y sin motivo, que es un defecto del servidor.</p>
        } @else if (!d.ejercicios.filas.length) {
          <p class="pres-empty">No hay ningún ejercicio dado de alta.</p>
        } @else {
          <p class="pres-dir-universo">
            <i class="pi pi-info-circle"></i> Universo: {{ d.ejercicios.universo }} · fuente {{ d.ejercicios.fuente }} · medido {{ d.ejercicios.as_of }} · cadencia del motor: {{ cadencia() }}
          </p>
          <div class="pres-table-wrap">
            <table class="surf-table surf-table--plain">
              <thead>
                <tr>
                  <th>Folio</th><th>Ejercicio</th><th>Estado</th><th>Lo creó</th>
                  <th class="num">Sin firmar</th><th>Firma</th>
                </tr>
              </thead>
              <tbody>
                @for (e of d.ejercicios.filas; track e.id) {
                  <tr class="pres-dir-row" (click)="irA.emit('ejercicios')"
                      tabindex="0" (keydown.enter)="irA.emit('ejercicios')">
                    <td class="mono">{{ e.folio ?? 'sin folio' }}</td>
                    <td>{{ e.fiscal_year ?? 'sin ejercicio' }}</td>
                    <td>
                      @if (e.is_test) { <span class="pres-dir-chip">de prueba</span> }
                      @else { <span class="pres-dir-chip pres-dir-chip--warn">{{ e.status }}</span> }
                    </td>
                    <td>{{ e.creado_por ?? 'sin autor' }}</td>
                    <td class="num">
                      @if (e.is_test) { <span class="pres-dir-na">no aplica</span> }
                      @else if (e.dias_sin_firmar === null) { <span class="pres-dir-na">sin medir</span> }
                      @else { {{ e.dias_sin_firmar }} d }
                    </td>
                    <td>
                      @if (e.is_test) { <span class="pres-dir-na">no aplica</span> }
                      @else if (e.autorizado_en) { {{ e.autorizado_por ?? 'firmado' }} }
                      @else { <span class="pres-dir-na">sin firmar</span> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <!-- ══ LAS OBLIGACIONES, EN DOS UNIVERSOS ══ -->
      <section class="pres-section">
        <div class="pres-section-head">
          <h2>Las obligaciones, en dos universos</h2>
        </div>
        @if (d.obligaciones_error; as e) {
          <div class="pres-alert"><i class="pi pi-exclamation-triangle"></i> {{ e }}</div>
        } @else if (d.obligaciones; as o) {
          <p class="pres-dir-universo">
            <i class="pi pi-info-circle"></i> Universo: {{ o.universo }} · fuente {{ o.fuente }} · medido {{ o.as_of }}
          </p>
          <div class="pres-table-wrap">
            <table class="surf-table surf-table--plain">
              <thead><tr><th>Universo</th><th class="num">Obligaciones</th><th class="num">Monto</th></tr></thead>
              <tbody>
                <tr class="pres-dir-row" (click)="irA.emit('gastos')" tabindex="0" (keydown.enter)="irA.emit('gastos')">
                  <td>Ejercicios reales</td>
                  <td class="num">{{ o.reales.n }}</td>
                  <td class="num">{{ montoTexto(o.reales.monto) }}</td>
                </tr>
                <tr>
                  <td>Ejercicio de prueba</td>
                  <td class="num">{{ o.prueba.n }}</td>
                  <td class="num">{{ montoTexto(o.prueba.monto) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="pres-dir-foot">
            No hay fila de total, a propósito: los dos universos son copia casi exacta uno del otro,
            así que sumarlos se ve normal y publica el doble. Y la separación se hace saltando hasta
            el ejercicio, nunca por «la obligación no tiene renglón»: todas tienen renglón.
          </p>
        } @else {
          <p class="pres-empty">El bloque llegó vacío y sin motivo, que es un defecto del servidor.</p>
        }
      </section>

      <!-- ══ EL LEDGER, UNA COLUMNA POR EJERCICIO ══ -->
      <section class="pres-section">
        <div class="pres-section-head">
          <h2>Las cinco etapas del dinero</h2>
        </div>
        @if (d.ledger_error; as e) {
          <div class="pres-alert"><i class="pi pi-exclamation-triangle"></i> {{ e }}</div>
        } @else if (d.ledger; as l) {
          <p class="pres-dir-universo">
            <i class="pi pi-info-circle"></i> Universo: {{ l.universo }} · fuente {{ l.fuente }} · medido {{ l.as_of }}
          </p>
          <div class="pres-table-wrap">
            <table class="surf-table surf-table--plain">
              <thead>
                <tr>
                  <th>Etapa</th>
                  @for (y of ejerciciosDelLedger(); track y) { <th class="num">FY{{ y }}</th> }
                  <th>Quién la mueve</th>
                </tr>
              </thead>
              <tbody>
                @for (et of l.etapas; track et.etapa) {
                  <tr>
                    <td>{{ et.etapa }}</td>
                    @for (y of ejerciciosDelLedger(); track y) {
                      <td class="num">{{ montoDelAnio(et.por_ejercicio, y) }}</td>
                    }
                    <td>{{ et.quien_la_mueve }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pres-dir-foot">
            Una columna por ejercicio y ninguna de total: sumarlos fabrica una cifra que no existe
            en ningún lado.
          </p>
        } @else {
          <p class="pres-empty">El bloque llegó vacío y sin motivo, que es un defecto del servidor.</p>
        }
      </section>

      <!-- ══ LO QUE NO SE PUEDE MEDIR ══ -->
      <section class="pres-section">
        <div class="pres-section-head">
          <h2>Lo que no se puede medir hoy</h2>
        </div>
        @if (!d.huecos.length) {
          <p class="pres-empty">No hay ningún hueco declarado.</p>
        } @else {
          <div class="pres-table-wrap">
            <table class="surf-table surf-table--plain">
              <thead><tr><th>Hueco</th><th>Por qué no se puede</th><th class="num">Peso</th></tr></thead>
              <tbody>
                @for (h of huecos(); track h.nombre) {
                  <tr>
                    <td>{{ h.nombre }}</td>
                    <td>{{ h.porque }}</td>
                    <td class="num" [class.pres-dir-na]="!h.peso.medido">{{ peso(h) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pres-dir-foot">
            Un hueco se declara con nombre y peso. No se aproxima, no se dibuja en cero y no se
            pinta verde: «sin meta» la cierra Dirección, «sin medir» la cierra Sistemas.
          </p>
        }
      </section>

      <p class="pres-dir-foot pres-dir-foot--pagina">
        Esta vista no fija periodo a propósito: conviven ejercicios y ventanas distintas, así que
        cada bloque declara el suyo. La respuesta se armó {{ d.as_of }}.
      </p>
    }
  `,
  styles: [PRESUPUESTO_STYLES, `
    :host { display:block; }
    .pres-dir-answer { display:flex; flex-direction:column; gap:.4rem; padding:1.125rem 1.25rem;
      border:1px solid var(--border-color); border-radius:var(--r-lg); background:var(--card-bg);
      box-shadow:var(--shadow-light); margin-bottom:1rem; }
    .pres-dir-answer-k { font-size:var(--fs-micro); font-weight:700; text-transform:uppercase;
      letter-spacing:.08em; color:var(--text-faint); }
    .pres-dir-answer-v { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.02em;
      line-height:1.3; text-wrap:balance; }
    .pres-dir-answer-w { margin:0; font-size:var(--fs-sm); color:var(--text-muted); line-height:1.55; max-width:86ch; }
    .pres-dir-answer-gap { margin:.2rem 0 0; display:flex; align-items:flex-start; gap:.4rem;
      font-size:var(--fs-xs); color:var(--warn-soft-fg); line-height:1.5; }
    /* El universo viaja CON su tabla, no en el copete de la pagina: los bloques no comparten
       ventana ni fuente, asi que un encabezado unico los taparia a todos. */
    .pres-dir-universo { display:flex; align-items:center; gap:.4rem; margin:.2rem 0 .5rem;
      font-size:var(--fs-micro); font-weight:600; color:var(--text-muted); letter-spacing:.02em; }
    .pres-dir-foot { margin:.5rem 0 0; font-size:var(--fs-xs); color:var(--text-muted);
      line-height:1.5; max-width:86ch; }
    .pres-dir-foot--pagina { margin-top:1.4rem; padding-top:.75rem; border-top:1px solid var(--border-color); }
    .pres-dir-row { cursor:pointer; }
    .pres-dir-row:hover > td { background:var(--overlay-hover); }
    .pres-dir-row:hover > td:first-child { box-shadow:inset 2px 0 0 var(--action); }
    .pres-dir-chip { display:inline-flex; align-items:center; padding:.2rem .5rem;
      border:1px solid var(--border-color); border-radius:var(--r-pill); background:var(--c-surface-2);
      font-size:var(--fs-micro); font-weight:700; color:var(--text-muted); }
    .pres-dir-chip--warn { background:var(--warn-soft-bg); border-color:var(--warn-border); color:var(--warn-soft-fg); }
    /* Una ausencia no se pinta como dato: ni en cero ni con el mismo color que una cifra. */
    .pres-dir-na { color:var(--text-faint); }
  `],
})
export class PresupuestoDireccionComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  /** La vista a la que hay que ir. El shell la aplica con `setView`, que la deja en la URL. */
  readonly irA = output<string>();

  readonly datos = signal<PresupuestoDireccion | null>(null);
  readonly errorGeneral = signal<string | null>(null);
  readonly cargando = signal(true);

  readonly respuesta = computed(() => respuestaDireccion(this.datos()));
  readonly metricas = computed(() => metricasDireccion(this.datos()));
  readonly aviso = computed(() => avisoCorridasConError(this.datos()?.motor ?? null));
  readonly cadencia = computed(() => leyendaCadencia(this.datos()?.motor ?? null));
  readonly huecos = computed(() => huecosOrdenados(this.datos()?.huecos ?? []));

  /** Los ejercicios que el ledger trae, en orden. Salen del dato, no de una lista escrita a mano. */
  readonly ejerciciosDelLedger = computed(() => {
    const etapas = this.datos()?.ledger?.etapas ?? [];
    const anios = new Set<number>();
    for (const e of etapas) for (const p of e.por_ejercicio) anios.add(p.fiscal_year);
    return [...anios].sort((a, b) => a - b);
  });

  constructor() {
    this.http.get<PresupuestoDireccion>(`${environment.apiUrl}/finance/budget/budgets/direccion`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.datos.set(d); this.cargando.set(false); },
        error: (e) => {
          this.errorGeneral.set(e?.error?.message || 'No se pudo cargar la vista de Dirección.');
          this.cargando.set(false);
        },
      });
  }

  /** Un monto que puede faltar. Nunca llega a `money()` sin guarda: `null` saldría como $0.00. */
  montoTexto(v: number | null): string {
    return montoODeclarado(v);
  }

  /** El peso de un hueco. Lo no medible sale con su motivo, nunca con una cifra inventada. */
  peso(h: HuecoDeclarado): string {
    return pesoTexto(h);
  }

  montoDelAnio(por: Array<{ fiscal_year: number; monto: number | null }>, anio: number): string {
    const f = por.find((p) => p.fiscal_year === anio);
    return f ? montoODeclarado(f.monto) : 'sin medir';
  }
}
