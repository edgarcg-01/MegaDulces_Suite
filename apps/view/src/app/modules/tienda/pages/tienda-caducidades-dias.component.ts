import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';

import { ComercialService, ExpedienteDia, ExpedienteUltima } from '../../comercial/comercial.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { SucursalPickerComponent, unCodigo } from '../../../shared/components/sucursal-picker/sucursal-picker.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { formatExpiryEcho } from '../../almacen/shared/expiry-short';

/**
 * Sucursales que NO capturan a diario. El CEDIS `00` captura caducidades «al menos cada mes»
 * (dato del negocio, 2026-10-16): para él un día sin hojas es lo normal, y contarlo como hueco
 * diario marcaría rojo los 30 días del mes. Se evalúa por **antigüedad de su última captura**.
 *
 * Es una constante de ESTA pantalla a propósito: la cadencia es una regla de negocio, no un dato
 * del almacén (`commercial.warehouses` no la trae). Si otra sucursal pasa a capturar por periodos,
 * se agrega aquí; si la regla crece, tendría que vivir en una tabla.
 */
export const CAPTURA_MENSUAL: ReadonlySet<string> = new Set(['00']);
/** «Al menos cada mes» = una captura cada 31 días como máximo, contando hacia atrás desde hoy. */
export const LIMITE_MENSUAL_DIAS = 31;

/** Estado de una sucursal que captura por periodos (no a diario). */
export interface MensualFila {
  sucursal: string;
  nombre: string;
  /** `YYYY-MM-DD`, o `null` si en el sistema nunca ha subido una hoja. */
  ultima: string | null;
  /** Días desde la última captura hasta hoy (reloj del server); `null` si nunca. */
  dias: number | null;
  /** `sinregistro` = nunca ha capturado: se DECLARA, no se llama «atrasada» ni «al corriente». */
  estado: 'alcorriente' | 'atrasada' | 'sinregistro';
}

/** Un día del rango, con lo que se subió (o no) ese día. */
interface DiaFila {
  fecha: string;
  /** Día de la semana, abreviado. Va aparte de la fecha para que se lea de un vistazo. */
  dia: string;
  hojas: number;
  /** Códigos de las sucursales que subieron algo ese día. */
  sucursales: string[];
  /** De las que subieron, cuántas SÍ capturan a diario (las que se cuentan en «n de N»). */
  subieronDiarias: number;
  /**
   * Sucursales del alcance que capturan a diario y NO subieron nada ese día. `null` = no se puede saber
   * (el alcance todavía no contestó): se declara, no se dibuja como «ninguna falta».
   */
  faltan: string[] | null;
  capturistas: string[];
  vencidos: number;
  riesgosos: number;
}

type Vista = 'todos' | 'completos' | 'huecos';

/**
 * **Capturas por día** — qué días cada sucursal subió caducidades.
 *
 * Es una vista del expediente, no un dato nuevo: sale de las mismas hojas
 * (`GET /expediente/dias`, agrupadas por la fecha con la que se archivaron), así
 * que el día que se ve acá es el que muestra la columna «Fecha» del expediente, y
 * al abrir un día el expediente trae exactamente esas hojas.
 *
 * **Qué es un hueco.** Las sucursales cierran un solo día al año (dato del negocio,
 * 2026-10-16), así que un día sin hojas de una sucursal es una falta de captura, no
 * un descanso. Lo que NO se hace es hardcodear cuál es ese día de cierre: el sistema
 * no lo conoce, y por eso la nota de la pantalla lo dice en vez de esconderlo.
 * El hueco se cuenta contra las sucursales del ALCANCE de quien mira (`faltan`), no
 * contra una lista fija: una persona con una sola sucursal ve sólo la suya.
 *
 * **El CEDIS no cuenta como hueco diario.** Captura «al menos cada mes», así que sale del cálculo
 * de huecos y tiene su propio panel: cuántos días lleva sin capturar contra el límite de
 * 31 días (ver `CAPTURA_MENSUAL`).
 *
 * El filtro de sucursal usa el selector compartido (`app-sucursal-picker`): ofrece
 * sólo lo que el alcance de la persona le deja ver, y el server recorta igual.
 */
@Component({
  selector: 'app-tienda-caducidades-dias',
  standalone: true,
  imports: [
    CommonModule, RouterLink, ButtonModule, TagModule, TableModule,
    SucursalPickerComponent, SegmentedComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cdd">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Capturas por día</h1>
          <p class="surf-page-sub">Qué días cada sucursal subió caducidades</p>
        </div>
        <div class="cdd-head-actions">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" label="Consultado" />
          <button pButton [text]="true" severity="secondary" size="small" (click)="irAlExpediente()">
            <span class="p-button-icon p-button-icon-left pi pi-folder-open" aria-hidden="true"></span> Expediente
          </button>
        </div>
      </header>

      @if (kpis().length) {
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen de capturas del periodo"></app-metric-strip>
      }

      <section class="cdd-filtros surf-card">
        <div class="cdd-f">
          <span class="cdd-f-lbl">Sucursal</span>
          <app-sucursal-picker [valor]="sucursal()" (valorChange)="cambiarSucursal(unCodigo($event))"></app-sucursal-picker>
        </div>
        <div class="cdd-f">
          <span class="cdd-f-lbl">Periodo</span>
          <app-segmented [options]="ventanas" [value]="ventana()" (valueChange)="cambiarVentana($event)" ariaLabel="Periodo" />
        </div>
        @if (hayDiarias()) {
          <div class="cdd-f">
            <span class="cdd-f-lbl">Mostrar</span>
            <app-segmented [options]="vistas" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Qué días mostrar" />
          </div>
        }
      </section>

      @if (mensuales().length && !cargando() && !error()) {
        <section class="cdd-mensual surf-card" aria-label="Sucursales que capturan por periodos">
          <h2 class="cdd-mensual-h">Captura mensual</h2>
          <p class="cdd-mensual-sub">Capturan al menos cada mes, así que no cuentan como hueco diario. Límite: {{ limiteDias }} días.</p>
          <ul class="cdd-mensual-lista">
            @for (m of mensuales(); track m.sucursal) {
              <li class="cdd-mensual-item" [attr.data-e]="m.estado">
                <code class="cdd-chip">{{ m.sucursal }}</code>
                <strong>{{ m.nombre }}</strong>
                <span class="cdd-mensual-txt">
                  @if (m.ultima) { Última captura: {{ eco(m.ultima) }} · hace {{ m.dias }} {{ m.dias === 1 ? 'día' : 'días' }} }
                  @else { Todavía no hay una sola captura registrada en el sistema }
                </span>
                @switch (m.estado) {
                  @case ('alcorriente') { <p-tag value="Al corriente" severity="success"></p-tag> }
                  @case ('atrasada') { <p-tag value="Atrasada" severity="warn" icon="pi pi-exclamation-triangle"></p-tag> }
                  @default { <p-tag value="Sin registro" severity="secondary"></p-tag> }
                }
              </li>
            }
          </ul>
        </section>
      }

      <section>
        <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!filas().length"
          errorTitle="No se pudieron cargar las capturas" [skeletonRows]="8"
          emptyIcon="pi-calendar" emptyTitle="Nada que mostrar con ese filtro"
          [emptyHint]="vacioHint()" (retry)="cargar()">
          <div class="dt-scope">
          <p-table [value]="filas()" styleClass="surf-table surf-table--plain surf-table--sticky dt-stack" [scrollable]="true"
            [paginator]="filas().length > 31" [rows]="31" dataKey="fecha">
            <ng-template #header>
              <tr>
                <th scope="col">Día</th>
                <th scope="col">Estado</th>
                <th scope="col" class="comm-num">Hojas</th>
                @if (mostrarSucursales()) { <th scope="col">Subieron</th> }
                @if (mostrarFaltan()) { <th scope="col">Sin captura</th> }
                <th scope="col">Quién subió</th>
                <th scope="col" class="comm-num">Por vencer</th>
                <th scope="col" class="comm-num">Vencidos</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td class="dt-id" data-label="Día" role="cell">
                  <!-- Enlace de verdad (Ctrl+clic, pestaña nueva): lleva al expediente de ESE día. -->
                  @if (f.hojas) {
                    <a class="cdd-fecha" [routerLink]="['/tienda/caducidades/expediente']" [queryParams]="paramsDe(f)"
                      [attr.aria-label]="'Ver las hojas del ' + eco(f.fecha)">
                      <span class="cdd-dia">{{ f.dia }}</span> {{ eco(f.fecha) }}
                    </a>
                  } @else {
                    <span class="cdd-fecha cdd-fecha--off"><span class="cdd-dia">{{ f.dia }}</span> {{ eco(f.fecha) }}</span>
                  }
                </td>
                <td data-label="Estado" role="cell">
                  @switch (estadoDe(f)) {
                    @case ('completo') { <p-tag value="Completo" severity="success"></p-tag> }
                    @case ('parcial') { <p-tag value="Con huecos" severity="warn" icon="pi pi-exclamation-triangle"></p-tag> }
                    @case ('encurso') { <p-tag value="En curso" severity="secondary" icon="pi pi-clock"></p-tag> }
                    @case ('vacio') { <p-tag value="Sin captura" severity="danger" icon="pi pi-times-circle"></p-tag> }
                    @case ('nodiaria') { <span class="cdd-fecha--off">—</span> }
                    @default { <p-tag value="Con capturas" severity="info"></p-tag> }
                  }
                </td>
                <td class="comm-num dt-num" data-label="Hojas" role="cell">{{ f.hojas || '—' }}</td>
                @if (mostrarSucursales()) {
                  <td data-label="Subieron" role="cell">
                    <div class="cdd-suc">
                      @for (c of f.sucursales; track c) { <code class="cdd-chip">{{ c }}</code> }
                      @if (!f.sucursales.length) { — }
                      @if (f.sucursales.length && totalSucursales()) {
                        <span class="cdd-de">{{ f.subieronDiarias }} de {{ totalSucursales() }}</span>
                      }
                    </div>
                  </td>
                }
                @if (mostrarFaltan()) {
                  <td data-label="Sin captura" role="cell">
                    <div class="cdd-suc">
                      @for (c of f.faltan; track c) { <code class="cdd-chip cdd-chip--falta">{{ c }}</code> }
                      @if (!f.faltan?.length) { — }
                    </div>
                  </td>
                }
                <td class="cdd-quien" data-label="Quién subió" role="cell">{{ f.capturistas.length ? f.capturistas.join(', ') : '—' }}</td>
                <td class="comm-num dt-num" data-label="Por vencer" role="cell">{{ f.riesgosos || '—' }}</td>
                <td class="comm-num dt-num" data-label="Vencidos" role="cell">{{ f.vencidos || '—' }}</td>
              </tr>
            </ng-template>
          </p-table>
          </div>
        </app-load-state>
      </section>

      <p class="cdd-nota">
        «Sin captura» es una sucursal de tu alcance que ese día no subió ninguna hoja. Las sucursales cierran un solo día al
        año; el sistema no sabe cuál, así que ese día aparecerá como hueco en todas. El CEDIS captura al menos cada mes y
        se evalúa aparte. «Por vencer» y «Vencidos» se miden contra hoy, no contra ese día.
      </p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cdd { display: grid; gap: 1rem; container-type: inline-size; }
    .cdd-head-actions { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }

    .cdd-filtros { display: flex; gap: 1rem 1.5rem; flex-wrap: wrap; align-items: end; padding: .9rem; }
    .cdd-f { display: grid; gap: .3rem; min-width: 0; }
    .cdd-f-lbl { font-size: var(--fs-xs, .72rem); color: var(--text-muted); }

    .cdd-fecha { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--text-main); text-decoration: none; font-weight: 600; }
    a.cdd-fecha:hover { color: var(--action); text-decoration: underline; }
    a.cdd-fecha:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: var(--r-sm); }
    .cdd-fecha--off { color: var(--text-muted); font-weight: 400; }
    .cdd-dia { display: inline-block; min-width: 2.2rem; color: var(--text-muted); font-weight: 400; text-transform: capitalize; }

    /* El flex va en un div DENTRO del td: un td con display:flex deja de ser celda y desalinea las columnas. */
    .cdd-suc { display: flex; flex-wrap: wrap; gap: .25rem; align-items: center; min-width: 9rem; }
    .cdd-chip {
      font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-xs, .72rem);
      padding: .05rem .35rem; border: 1px solid var(--border-color); border-radius: var(--r-sm); color: var(--text-main);
    }
    .cdd-chip--falta { border-color: var(--warn-fg); color: var(--warn-fg); }
    .cdd-de { font-size: var(--fs-xs, .72rem); color: var(--text-muted); margin-left: .25rem; }
    .cdd-quien { min-width: 0; overflow-wrap: anywhere; }

    .cdd-mensual { padding: .9rem; display: grid; gap: .5rem; }
    .cdd-mensual-h { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 700; }
    .cdd-mensual-sub { margin: 0; font-size: var(--fs-xs, .72rem); color: var(--text-muted); }
    .cdd-mensual-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
    .cdd-mensual-item { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; }
    .cdd-mensual-txt { color: var(--text-muted); font-size: var(--fs-sm, .85rem); flex: 1 1 14rem; min-width: 0; }

    .cdd-nota { margin: 0; font-size: var(--fs-xs, .72rem); color: var(--text-muted); max-width: 60rem; }

    /* En estrecho la rejilla se queda en un solo bloque que se desliza: no se apila. */
    @container (max-width: 40rem) {
      /* El botón del encabezado se cortaba en el borde: que ocupe su propio renglón. */
      .cdd-head-actions { flex: 1 1 100%; justify-content: space-between; }
      .cdd-filtros { gap: .75rem; }
      .cdd-dia { min-width: 0; margin-right: .25rem; }
    }
  `],
})
export class TiendaCaducidadesDiasComponent {
  private readonly svc = inject(ComercialService);
  private readonly router = inject(Router);
  private readonly scope = inject(DataScopeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly unCodigo = unCodigo;

  readonly ventanas: SegOption[] = [
    { label: '7 días', value: '7' },
    { label: '30 días', value: '30' },
    { label: '90 días', value: '90' },
  ];
  readonly vistas: SegOption[] = [
    { label: 'Todos', value: 'todos' },
    { label: 'Completos', value: 'completos' },
    { label: 'Con huecos', value: 'huecos' },
  ];

  /** Código de 2 dígitos, o `null` = todas las del alcance. */
  readonly sucursal = signal<string | null>(null);
  readonly ventana = signal('30');
  readonly vista = signal<Vista>('todos');

  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  private readonly dias = signal<ExpedienteDia[]>([]);
  private readonly ultimas = signal<ExpedienteUltima[]>([]);
  /** El «hoy» del server: contra él se mide cuánto lleva una sucursal sin capturar. */
  private readonly hoy = signal<string | null>(null);
  readonly limiteDias = LIMITE_MENSUAL_DIAS;
  /** Ventana que realmente usó el server (su `hoy`, no el del navegador). */
  private readonly rango = signal<{ from: string; to: string } | null>(null);

  /** Sucursales del alcance: el denominador de «5 de 9». `null` = el alcance no contestó. */
  private readonly alcance = this.scope.misSucursales();
  /** El denominador de «n de N»: sólo las sucursales que capturan A DIARIO. */
  readonly totalSucursales = computed(() => this.diarias()?.length ?? 0);
  /** Con una sola sucursal la columna «Subieron» no dice nada. */
  readonly mostrarSucursales = computed(() => !this.sucursal() && (this.alcance()?.length ?? 0) !== 1);
  /** «Sin captura» por sucursal sólo cuando el alcance contestó y hay más de una que comparar. */
  readonly mostrarFaltan = computed(() => !this.sucursal() && (this.diarias()?.length ?? 0) > 1);

  /** Qué sucursales se esperan cada día: la elegida, o todo el alcance. `null` = no se sabe. */
  private readonly esperadas = computed<string[] | null>(() => {
    const cod = this.sucursal();
    if (cod) return [cod];
    return this.alcance()?.map((o) => o.value) ?? null;
  });

  /** De las esperadas, las que capturan A DIARIO. `null` = no se sabe (el alcance no contestó). */
  private readonly diarias = computed<string[] | null>(() => this.esperadas()?.filter((c) => !CAPTURA_MENSUAL.has(c)) ?? null);
  /** ¿Hay algo que comparar día por día? Con sólo el CEDIS a la vista, «completos / con huecos» no significa nada. */
  readonly hayDiarias = computed(() => (this.diarias()?.length ?? 1) > 0);

  /** Las sucursales a la vista que capturan por periodos, con qué tan al corriente van. */
  readonly mensuales = computed<MensualFila[]>(() => {
    const esperadas = this.esperadas();
    const hoy = this.hoy();
    if (!esperadas || !hoy) return [];
    const nombres = new Map((this.alcance() ?? []).map((o) => [o.value, o.label]));
    return esperadas.filter((c) => CAPTURA_MENSUAL.has(c)).map((c) => {
      const u = this.ultimas().find((x) => x.sucursal === c);
      const ultima = u?.ultima ?? null;
      const dias = ultima ? Math.round((this.utc(hoy) - this.utc(ultima)) / 86_400_000) : null;
      const estado: MensualFila['estado'] = dias === null ? 'sinregistro' : dias <= LIMITE_MENSUAL_DIAS ? 'alcorriente' : 'atrasada';
      return { sucursal: c, nombre: nombres.get(c) ?? u?.warehouse_name ?? c, ultima, dias, estado };
    });
  });

  /** Todos los días del rango (también los sin captura), del más reciente al más viejo. */
  private readonly todos = computed<DiaFila[]>(() => {
    const r = this.rango();
    if (!r) return [];
    const diarias = this.diarias();
    const porDia = new Map<string, ExpedienteDia[]>();
    for (const d of this.dias()) {
      const l = porDia.get(d.fecha);
      if (l) l.push(d); else porDia.set(d.fecha, [d]);
    }
    const out: DiaFila[] = [];
    for (let t = this.utc(r.to); t >= this.utc(r.from); t -= 86_400_000) {
      const fecha = new Date(t).toISOString().slice(0, 10);
      const filas = porDia.get(fecha) ?? [];
      out.push({
        fecha,
        dia: this.nombreDia(t),
        hojas: filas.reduce((a, x) => a + x.hojas, 0),
        sucursales: filas.map((x) => x.sucursal),
        subieronDiarias: filas.filter((x) => !CAPTURA_MENSUAL.has(x.sucursal)).length,
        faltan: diarias ? diarias.filter((c) => !filas.some((x) => x.sucursal === c)) : null,
        capturistas: [...new Set(filas.flatMap((x) => x.capturistas))],
        vencidos: filas.reduce((a, x) => a + x.vencidos, 0),
        riesgosos: filas.reduce((a, x) => a + x.riesgosos, 0),
      });
    }
    return out;
  });

  /**
   * Veredicto de un día. El ÚLTIMO día del rango (hoy, en el reloj del server) está
   * «en curso» mientras le falte alguien: todavía no terminó, así que no cuenta como
   * hueco. Con `faltan === null` (el alcance no contestó) no se afirma ni «completo»
   * ni «con huecos»: sólo lo que se ve, que es si se subió algo.
   */
  estadoDe(f: DiaFila): 'completo' | 'parcial' | 'vacio' | 'encurso' | 'capturas' | 'nodiaria' {
    // Sólo se ve una sucursal que no captura a diario (el CEDIS): un día sin hojas es lo normal,
    // no un hueco ni un «completo». Se muestra «—» y lo que cuenta es el panel mensual.
    if (f.faltan !== null && !this.hayDiarias()) return f.hojas ? 'capturas' : 'nodiaria';
    if (f.faltan === null) return f.hojas ? 'capturas' : 'vacio';
    if (!f.faltan.length) return 'completo';
    if (f.fecha === this.rango()?.to) return 'encurso';
    return f.hojas ? 'parcial' : 'vacio';
  }

  readonly filas = computed(() => {
    const v = this.vista();
    const t = this.todos();
    if (v === 'completos') return t.filter((f) => this.estadoDe(f) === 'completo');
    if (v === 'huecos') return t.filter((f) => ['parcial', 'vacio'].includes(this.estadoDe(f)));
    return t;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    if (this.cargando() || this.error() || !this.rango()) return [];
    const t = this.todos();
    const cerrados = t.filter((f) => this.estadoDe(f) !== 'encurso');
    const medido = t.every((f) => f.faltan !== null);
    const completos = cerrados.filter((f) => this.estadoDe(f) === 'completo').length;
    const ultima = t.find((f) => f.hojas)?.fecha ?? null;
    const hojas: MetricStripItem = { label: 'Hojas subidas', value: t.reduce((a, f) => a + f.hojas, 0), format: 'number' };
    const ult: MetricStripItem = { label: 'Última captura', value: ultima ? this.eco(ultima) : 'ninguna en el periodo' };

    // Sin alcance resuelto no se sabe quién debía subir (y con sólo el CEDIS no hay nada diario que
    // comparar): se dice, y no se inventa un «0 huecos».
    if (!medido || !this.hayDiarias()) {
      return [
        { label: 'Días con capturas', value: t.filter((f) => f.hojas).length, format: 'number', sub: `de ${t.length} días` },
        hojas, ult,
      ];
    }
    const huecos = cerrados.length - completos;
    const unaSola = this.diarias()?.length === 1;
    const enCurso = t.length - cerrados.length;
    return [
      {
        label: 'Días completos', value: completos, format: 'number',
        sub: `de ${cerrados.length} días${enCurso ? ' · hoy sigue en curso' : ''}`,
      },
      {
        label: 'Días con huecos', value: huecos, format: 'number', tone: huecos ? 'warn' : 'default',
        sub: huecos
          ? (unaSola ? 'días sin hojas' : 'con alguna sucursal sin hojas')
          : (unaSola ? 'ningún día sin hojas' : 'ninguna sucursal faltó'),
      },
      hojas, ult,
    ];
  });

  readonly vacioHint = computed(() =>
    this.vista() === 'huecos' ? 'En este periodo todas las sucursales subieron hojas todos los días.'
      : this.vista() === 'completos' ? 'En este periodo no hubo un solo día con todas las sucursales.'
      : 'Prueba con otro periodo u otra sucursal.');

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.expedienteDias({ sucursal: this.sucursal() || undefined, dias: Number(this.ventana()) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.dias.set(r.data || []);
          this.ultimas.set(r.ultimas || []);
          this.hoy.set(r.hoy || null);
          this.rango.set({ from: r.from, to: r.to });
          this.cargadoEn.set(new Date());
          this.cargando.set(false);
        },
        error: (e) => {
          this.cargando.set(false);
          this.error.set(e?.error?.message || 'Revisa la conexión y vuelve a intentar.');
        },
      });
  }

  cambiarSucursal(code: string | null): void {
    this.sucursal.set(code);
    // Con sólo el CEDIS no hay «completos / con huecos»: volver a «Todos» para no dejar un filtro invisible.
    if (code && CAPTURA_MENSUAL.has(code)) this.vista.set('todos');
    this.cargar();
  }
  cambiarVentana(v: string): void { this.ventana.set(v); this.cargar(); }

  irAlExpediente(): void { this.router.navigate(['/tienda/caducidades/expediente']); }

  /** Lo que el expediente lee para abrirse en ese día (y esa sucursal, si hay una sola). */
  paramsDe(f: DiaFila): Record<string, string> {
    const p: Record<string, string> = { fecha: f.fecha };
    const cod = this.sucursal() ?? (f.sucursales.length === 1 ? f.sucursales[0] : null);
    if (cod) p['sucursal'] = cod;
    return p;
  }

  eco(iso: string): string { return formatExpiryEcho(iso) || iso; }

  /** `YYYY-MM-DD` → ms UTC. Aritmética en UTC para que el cambio de horario no mueva un día. */
  private utc(iso: string): number { return Date.parse(`${iso}T00:00:00Z`); }

  private nombreDia(ms: number): string {
    return new Intl.DateTimeFormat('es-MX', { weekday: 'short', timeZone: 'UTC' }).format(new Date(ms)).replace('.', '');
  }
}
