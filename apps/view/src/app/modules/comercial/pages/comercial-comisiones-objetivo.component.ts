import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import {
  ComercialService, ObjetivoResultado, ObjetivoCriterio, ObjetivoFila, ObjetivoCriterioFila,
} from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[RD.59]` — **El bono por objetivo mensual.** Configurable, y lo que se puede medir se mide.
 *
 * ── Qué reemplaza ────────────────────────────────────────────────────────────────────────
 * La hoja `OBJETIVO MENSUAL RD`: tres criterios por ruta marcados a mano con
 * `IF(celda="CUMPLIDO", 50%, 0%)`, sin fecha, sin responsable y sin con qué se decidió. Quedó
 * parada en 2021 con todas sus celdas en `NO CUMPLIDO`.
 *
 * ── ⛔⛔ La diferencia que importa: el silencio ya no castiga ──────────────────────────────
 * En el Excel una celda vacía vale `0%`. Acá el cumplimiento es **ternario** y lo que nadie
 * resolvió va a su propia columna. Verificado contra prod en septiembre 2026: las rutas **321 y
 * 322**, que no vendieron ese mes, salen **0% alcanzado y 100% sin resolver** — no reprobadas.
 * La **505**, que sí se quedó corta (165 visitas, $94,608), sale con **75% fallado**.
 *
 * ── Dos criterios se miden, uno se marca ─────────────────────────────────────────────────
 *   `visitas`  los tickets de la ruta en el mes. ⚠️ Son visitas **con venta**.
 *   `volumen`  la venta del mes.
 *   `manual`   *desarrollo de marcas* no es derivable (el sell-out con el código de vendedor de
 *              RD devuelve cero filas), así que se marca — con **motivo obligatorio**.
 *
 * ── Y no paga ────────────────────────────────────────────────────────────────────────────
 * La pantalla lo dice en la cara: el objetivo **no entra a la nómina**. Los criterios nacen
 * apagados con importe 0 y el motor quincenal los filtra. Medir antes de pagar.
 */
@Component({
  selector: 'app-comercial-comisiones-objetivo',
  standalone: true,
  imports: [FormsModule, TagModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ob">
      <header class="ob-head">
        <div>
          <h1>Bono por objetivo mensual</h1>
          <p class="ob-sub">
            Tres criterios por ruta con su peso. Dos se miden solos; el tercero se marca, y la
            marca deja fecha, responsable y motivo.
          </p>
        </div>
        <div class="ob-mes">
          <label for="ob-anio">Mes</label>
          <select id="ob-anio" [value]="anio()" (change)="setAnio($any($event.target).value)">
            @for (a of anios; track a) { <option [value]="a">{{ a }}</option> }
          </select>
          <select id="ob-mes" [value]="mes()" (change)="setMes($any($event.target).value)">
            @for (m of meses; track m.n) { <option [value]="m.n">{{ m.label }}</option> }
          </select>
        </div>
      </header>

      <app-load-state
        [loading]="cargando()" [isEmpty]="!data()" [skeletonRows]="6"
        emptyIcon="pi-flag" emptyTitle="Sin configuración"
        emptyHint="El bono por objetivo todavía no tiene criterios.">

        @if (data(); as d) {
          <!-- El estado va PRIMERO: es la razón de que media tabla diga «sin resolver». -->
          <section class="ob-estado" [class.ob-off]="d.config.estado !== 'encendido'">
            <div>
              <p class="ob-estado-l">Estado</p>
              <p class="ob-estado-v">{{ etiquetaEstado(d.config.estado) }}</p>
            </div>
            <div>
              <p class="ob-estado-l">Importe del bono</p>
              <p class="ob-estado-v mono">{{ d.config.monto_total ? dinero(d.config.monto_total) : 'sin fijar' }}</p>
            </div>
            <div>
              <p class="ob-estado-l">Máximo alcanzable</p>
              <p class="ob-estado-v mono" [class.ob-techo]="d.config.peso_activo !== 100">
                {{ d.config.peso_activo }}%
              </p>
              @if (d.config.peso_activo !== d.config.peso_total) {
                <p class="ob-mini">de {{ d.config.peso_total }}% configurado</p>
              }
            </div>
            <div class="ob-estado-nota">
              @if (!d.config.entra_a_nomina) {
                <p><b>No entra a la nómina.</b> Esto mide y muestra; la corrida quincenal no lo paga.</p>
              }
              @for (p of d.config.pendientes; track p) { <p class="ob-pend">{{ p }}</p> }
            </div>
          </section>

          <h2 class="ob-h2">Los criterios</h2>
          <div class="ob-wrap dt-scope">
            <table class="ob-table dt-stack">
              <caption class="sr-only">Configuración de los criterios del bono</caption>
              <thead>
                <tr>
                  <th scope="col">Criterio</th>
                  <th scope="col">Cómo se resuelve</th>
                  <th scope="col" class="num">Peso</th>
                  <th scope="col" class="num">Umbral</th>
                  <th scope="col" class="num">Importe</th>
                  <th scope="col">Estado</th>
                  @if (puedeGestionar()) { <th scope="col"></th> }
                </tr>
              </thead>
              <tbody>
                @for (c of d.config.criterios; track c.id) {
                  <tr>
                    <td role="cell" data-label="Criterio" class="dt-id">{{ c.nombre }}</td>
                    <td role="cell" data-label="Cómo se resuelve">
                      <span [class]="c.metrica === 'manual' ? 'ob-manual' : 'ob-medido'">
                        {{ comoSeResuelve(c.metrica) }}
                      </span>
                    </td>
                    <td role="cell" data-label="Peso" class="num dt-num mono">{{ num(c.peso_pct) }}%</td>
                    <td role="cell" data-label="Umbral" class="num dt-num mono">
                      @if (c.metrica === 'manual') { <span class="ob-nd">no aplica</span> }
                      @else if (num(c.umbral) === 0) { <span class="ob-nd">sin fijar</span> }
                      @else { {{ c.comparador === 'gt' ? '>' : '≥' }} {{ num(c.umbral) }} }
                    </td>
                    <td role="cell" data-label="Importe" class="num dt-num mono">
                      {{ num(c.monto) ? dinero(num(c.monto)) : '—' }}
                    </td>
                    <td role="cell" data-label="Estado">
                      <p-tag [severity]="c.activo ? 'success' : 'secondary'"
                             [value]="c.activo ? 'encendido' : 'apagado'" />
                    </td>
                    @if (puedeGestionar()) {
                      <td role="cell" data-label="" class="dt-actions">
                        <button type="button" class="ob-btn" (click)="abrirEdicion(c)">Editar</button>
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>

          @if (editando(); as e) {
            <section class="ob-editor" aria-label="Editar criterio">
              <h3>{{ e.nombre }}</h3>
              <div class="ob-form">
                @if (e.metrica !== 'manual') {
                  <label>
                    <span>Umbral</span>
                    <input type="number" step="0.01" [(ngModel)]="formUmbral" name="umbral" />
                  </label>
                  <label>
                    <span>Comparador</span>
                    <select [(ngModel)]="formComparador" name="comparador">
                      <option value="gte">≥ (alcanza o supera)</option>
                      <option value="gt">&gt; (supera)</option>
                    </select>
                  </label>
                }
                <label>
                  <span>Peso</span>
                  <input type="number" step="0.01" [(ngModel)]="formPeso" name="peso" />
                </label>
                <label>
                  <span>Importe</span>
                  <input type="number" step="0.01" [(ngModel)]="formMonto" name="monto" />
                </label>
                <label class="ob-check">
                  <input type="checkbox" [(ngModel)]="formActivo" name="activo" />
                  <span>Encendido</span>
                </label>
              </div>
              <p class="ob-mini">
                ⚠️ Los pesos de los tres criterios tienen que sumar <b>100%</b>. Si no suman, el
                servidor rechaza el cambio en vez de guardarlo a medias.
              </p>
              @if (error()) { <p class="ob-err">{{ error() }}</p> }
              <div class="ob-acciones">
                <button type="button" class="ob-btn ob-btn-primary" [disabled]="guardando()"
                        (click)="guardar(e)">{{ guardando() ? 'Guardando…' : 'Guardar' }}</button>
                <button type="button" class="ob-btn" (click)="editando.set(null)">Cancelar</button>
              </div>
            </section>
          }

          <h2 class="ob-h2">El mes, ruta por ruta</h2>
          @if (d.huecos.length) {
            <ul class="ob-huecos">
              @for (h of d.huecos; track h) { <li>{{ h }}</li> }
            </ul>
          }

          <div class="ob-wrap dt-scope">
            <table class="ob-table dt-stack">
              <caption class="sr-only">Resultado del mes por ruta</caption>
              <thead>
                <tr>
                  <th scope="col">Ruta</th>
                  <th scope="col">Chofer</th>
                  @for (c of criteriosActivos(); track c.id) {
                    <th scope="col">{{ c.nombre }}</th>
                  }
                  <th scope="col" class="num">Alcanzado</th>
                  <th scope="col" class="num">Sin resolver</th>
                </tr>
              </thead>
              <tbody>
                @for (f of d.filas; track f.route_code) {
                  <tr [class.ob-fila-baja]="sinActividad(f)">
                    <td role="cell" data-label="Ruta" class="mono dt-id">
                      {{ f.route_code }}
                      @if (sinActividad(f)) {
                        <span class="ob-baja" [title]="tituloBaja(f)">sin actividad</span>
                      }
                    </td>
                    <td role="cell" data-label="Chofer">{{ f.chofer || '—' }}</td>
                    @for (c of f.criterios; track c.bonus_id) {
                      <td role="cell" [attr.data-label]="c.nombre">
                        <span [class]="claseCriterio(c)">{{ textoCriterio(c) }}</span>
                        @if (c.metrica === 'manual' && puedeGestionar()) {
                          <button type="button" class="ob-link" (click)="abrirMarca(f, c)">
                            {{ c.cumplido === null ? 'marcar' : 'cambiar' }}
                          </button>
                        }
                      </td>
                    }
                    <td role="cell" data-label="Alcanzado" class="num dt-num mono fuerte">{{ f.alcanzado_pct }}%</td>
                    <td role="cell" data-label="Sin resolver" class="num dt-num mono"
                        [class.ob-pendiente]="f.sin_resolver_pct > 0">{{ f.sin_resolver_pct }}%</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="ob-mini">
            Los tres porcentajes de cada ruta suman <b>{{ d.config.peso_activo }}%</b>, que es el
            peso de los criterios encendidos
            @if (d.config.peso_activo !== 100) {
              <b> — el techo bajó porque hay criterios apagados, y por eso ninguna ruta puede
              llegar a 100%</b>
            }.
            Lo que nadie resolvió no cuenta como fallo: en la hoja de Excel una celda vacía valía
            <i>NO CUMPLIDO</i>, y es justo lo que esa columna existe para no repetir.
          </p>

          @if (marcando(); as m) {
            <section class="ob-editor" aria-label="Marcar criterio">
              <h3>{{ m.criterio.nombre }} · ruta {{ m.fila.route_code }}</h3>
              <div class="ob-form">
                <label>
                  <span>¿Se cumplió?</span>
                  <select [(ngModel)]="formCumplido" name="cumplido">
                    <option [ngValue]="true">Sí, se cumplió</option>
                    <option [ngValue]="false">No se cumplió</option>
                  </select>
                </label>
                <label class="ob-ancho">
                  <span>Motivo</span>
                  <input type="text" [(ngModel)]="formMotivo" name="motivo"
                         placeholder="Con qué se decidió" />
                </label>
              </div>
              <p class="ob-mini">
                ⛔ El motivo es <b>obligatorio</b>: una marca que decide dinero y no dice por qué
                es la casilla que cualquiera puede mover después.
              </p>
              @if (error()) { <p class="ob-err">{{ error() }}</p> }
              <div class="ob-acciones">
                <button type="button" class="ob-btn ob-btn-primary" [disabled]="guardando()"
                        (click)="guardarMarca(m)">{{ guardando() ? 'Guardando…' : 'Guardar marca' }}</button>
                <button type="button" class="ob-btn" (click)="marcando.set(null)">Cancelar</button>
              </div>
            </section>
          }
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    .ob { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .ob-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .ob-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ob-sub { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--c-text-3); max-width: 70ch; line-height: 1.5; }
    .ob-mes { display: flex; align-items: center; gap: 8px; }
    .ob-mes label { font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .ob-mes select, .ob-form select, .ob-form input {
      padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px;
      background: var(--card-bg); color: var(--c-text-1); font-size: var(--fs-sm);
    }

    .ob-estado {
      display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start;
      border: 1px solid var(--border-color); border-left: 3px solid var(--c-ok);
      border-radius: 8px; padding: 14px 16px; background: var(--card-bg);
    }
    .ob-off { border-left-color: var(--c-warn); }
    .ob-estado-l { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .ob-estado-v { margin: 4px 0 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ob-estado-nota { flex: 1 1 280px; }
    .ob-estado-nota p { margin: 0 0 5px; font-size: var(--fs-sm); color: var(--c-text-2); line-height: 1.55; }
    .ob-pend { color: var(--warn-fg) !important; }

    .ob-h2 { margin: 6px 0 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ob-wrap { overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px; }
    .ob-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ob-table th {
      text-align: left; padding: 9px 11px; font-weight: var(--fw-medium);
      color: var(--c-text-3); font-size: var(--fs-micro);
      border-bottom: 1px solid var(--border-color); white-space: nowrap;
    }
    .ob-table td { padding: 9px 11px; border-bottom: 1px solid var(--border-color); color: var(--c-text-2); }
    .ob-table .num { text-align: right; }
    .mono { font-variant-numeric: tabular-nums; }
    .fuerte { color: var(--c-text-1); font-weight: var(--fw-medium); }
    .ob-nd { color: var(--c-text-3); font-size: var(--fs-micro); }
    .ob-medido { color: var(--c-ok); }
    .ob-manual { color: var(--warn-fg); }
    .ob-ok { color: var(--c-ok); font-weight: var(--fw-medium); }
    .ob-no { color: var(--bad-fg); }
    .ob-pendiente { color: var(--warn-fg); }
    .ob-techo { color: var(--warn-fg); }
    .ob-fila-baja { opacity: .72; }
    .ob-baja { margin-left: 6px; padding: 1px 6px; border-radius: 10px; cursor: help;
      font-size: var(--fs-micro); color: var(--warn-fg); border: 1px solid var(--warn-fg); }

    .ob-huecos { margin: 0; padding-left: 18px; }
    .ob-huecos li { font-size: var(--fs-sm); color: var(--c-text-2); line-height: 1.6; }
    .ob-mini { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); line-height: 1.6; }
    .ob-err { margin: 6px 0 0; font-size: var(--fs-sm); color: var(--bad-fg); }

    .ob-editor {
      border: 1px solid var(--border-color); border-radius: 8px;
      padding: 14px 16px; background: var(--card-bg);
      display: flex; flex-direction: column; gap: 10px;
    }
    .ob-editor h3 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ob-form { display: flex; gap: 14px; flex-wrap: wrap; }
    .ob-form label { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-micro); color: var(--c-text-3); }
    .ob-ancho { flex: 1 1 320px; }
    .ob-check { flex-direction: row !important; align-items: center; gap: 7px !important; }
    .ob-acciones { display: flex; gap: 8px; }
    .ob-btn {
      padding: 6px 13px; border: 1px solid var(--border-color); border-radius: 6px;
      background: var(--card-bg); color: var(--c-text-1); font-size: var(--fs-sm); cursor: pointer;
    }
    .ob-btn-primary { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .ob-link {
      border: none; background: none; color: var(--action); font-size: var(--fs-micro);
      cursor: pointer; padding: 0 0 0 6px; text-decoration: underline;
    }

    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class ComercialComisionesObjetivoComponent {
  private readonly svc = inject(ComercialService);
  private readonly perms = inject(PermissionsService);

  readonly cargando = signal(true);
  readonly data = signal<ObjetivoResultado | null>(null);
  readonly error = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly editando = signal<ObjetivoCriterio | null>(null);
  readonly marcando = signal<{ fila: ObjetivoFila; criterio: ObjetivoCriterioFila } | null>(null);

  readonly anio = signal(new Date().getFullYear());
  readonly mes = signal(new Date().getMonth() + 1);
  readonly anios = [new Date().getFullYear(), new Date().getFullYear() - 1];
  readonly meses = [
    { n: 1, label: 'Enero' }, { n: 2, label: 'Febrero' }, { n: 3, label: 'Marzo' },
    { n: 4, label: 'Abril' }, { n: 5, label: 'Mayo' }, { n: 6, label: 'Junio' },
    { n: 7, label: 'Julio' }, { n: 8, label: 'Agosto' }, { n: 9, label: 'Septiembre' },
    { n: 10, label: 'Octubre' }, { n: 11, label: 'Noviembre' }, { n: 12, label: 'Diciembre' },
  ];

  formUmbral = 0; formMonto = 0; formPeso = 0; formComparador = 'gte'; formActivo = false;
  formCumplido = true; formMotivo = '';

  /**
   * ⭐ `has()` alcanza: desde ADR-054 el gate es por CLAVE EXACTA y los roles de plataforma
   * pasan solos dentro del propio servicio. No hace falta el `manage:all` de CASL, que se retiró.
   */
  readonly puedeGestionar = computed(() => this.perms.has(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR));

  readonly criteriosActivos = computed(() =>
    (this.data()?.config.criterios ?? []).filter((c) => c.activo));

  constructor() { this.cargar(); }

  setAnio(v: string): void { this.anio.set(Number(v)); this.cargar(); }
  setMes(v: string): void { this.mes.set(Number(v)); this.cargar(); }

  private cargar(): void {
    this.cargando.set(true);
    this.svc.objetivoResultado(this.anio(), this.mes()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: () => { this.data.set(null); this.cargando.set(false); },
    });
  }

  abrirEdicion(c: ObjetivoCriterio): void {
    this.error.set(null);
    this.marcando.set(null);
    this.formUmbral = this.num(c.umbral);
    this.formMonto = this.num(c.monto);
    this.formPeso = this.num(c.peso_pct);
    this.formComparador = c.comparador;
    this.formActivo = c.activo;
    this.editando.set(c);
  }

  guardar(c: ObjetivoCriterio): void {
    this.guardando.set(true);
    this.error.set(null);
    const cambios: Record<string, unknown> = {
      peso_pct: this.formPeso, monto: this.formMonto, activo: this.formActivo,
    };
    if (c.metrica !== 'manual') {
      cambios['umbral'] = this.formUmbral;
      cambios['comparador'] = this.formComparador;
    }
    this.svc.objetivoEditarCriterio(c.id, cambios).subscribe({
      next: () => { this.guardando.set(false); this.editando.set(null); this.cargar(); },
      // El servidor rechaza los pesos que no cierran: se muestra su razón, no una genérica.
      error: (e) => {
        this.guardando.set(false);
        this.error.set(e?.error?.message ?? 'No se pudo guardar.');
      },
    });
  }

  abrirMarca(fila: ObjetivoFila, criterio: ObjetivoCriterioFila): void {
    this.error.set(null);
    this.editando.set(null);
    this.formCumplido = criterio.cumplido ?? true;
    this.formMotivo = criterio.marca_motivo ?? '';
    this.marcando.set({ fila, criterio });
  }

  guardarMarca(m: { fila: ObjetivoFila; criterio: ObjetivoCriterioFila }): void {
    if (!this.formMotivo.trim()) {
      this.error.set('El motivo es obligatorio.');
      return;
    }
    this.guardando.set(true);
    this.error.set(null);
    this.svc.objetivoMarcar({
      bonus_id: m.criterio.bonus_id, route_code: m.fila.route_code,
      anio: this.anio(), mes: this.mes(),
      cumplido: this.formCumplido, motivo: this.formMotivo.trim(),
    }).subscribe({
      next: () => { this.guardando.set(false); this.marcando.set(null); this.cargar(); },
      error: (e) => {
        this.guardando.set(false);
        this.error.set(e?.error?.message ?? 'No se pudo guardar la marca.');
      },
    });
  }

  comoSeResuelve(metrica: string): string {
    const m: Record<string, string> = {
      visitas: 'se mide · tickets de la ruta',
      volumen: 'se mide · venta del mes',
      manual: 'se marca a mano',
      venta: 'se mide · venta',
      markup_pct: 'se mide · margen',
    };
    return m[metrica] ?? metrica;
  }

  textoCriterio(c: ObjetivoCriterioFila): string {
    if (c.cumplido === null) return c.motivo ?? 'sin resolver';
    const v = c.valor !== null ? ` (${this.entero(c.valor)})` : '';
    return (c.cumplido ? 'cumplió' : 'no cumplió') + v;
  }

  claseCriterio(c: ObjetivoCriterioFila): string {
    if (c.cumplido === null) return 'ob-nd';
    return c.cumplido ? 'ob-ok' : 'ob-no';
  }

  /**
   * Una ruta que comisiona pero no registra actividad hace más de dos meses está de baja de
   * hecho, aunque la configuración siga encendida. Sin esta marca sale idéntica a una ruta
   * activa que no alcanzó nada, y son dos cosas distintas: una se corrige en la configuración
   * de rutas, la otra es desempeño.
   */
  sinActividad(f: ObjetivoFila): boolean {
    return f.dias_sin_actividad === null || f.dias_sin_actividad > 60;
  }

  tituloBaja(f: ObjetivoFila): string {
    if (!f.ultima_actividad) return 'Esta ruta no registra actividad en toda la ventana de la fuente.';
    return `Última actividad el ${f.ultima_actividad} (hace ${f.dias_sin_actividad} días). `
      + 'Si se dio de baja hay que apagarla en la configuración de rutas; mientras siga encendida '
      + 'se evalúa y sale en cero.';
  }

  etiquetaEstado(e: string): string {
    const m: Record<string, string> = {
      sin_configurar: 'Sin configurar',
      apagado: 'Apagado',
      encendido_incompleto: 'Encendido, incompleto',
      encendido: 'Encendido',
    };
    return m[e] ?? e;
  }

  num(v: string | number | null): number {
    return v === null || v === undefined || v === '' ? 0 : Number(v);
  }

  dinero(v: number): string {
    return v.toLocaleString('es-MX', {
      style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  entero(v: number): string {
    return v.toLocaleString('es-MX', { maximumFractionDigits: 0 });
  }
}
