import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PRECIOS_TABS } from '../precios-tabs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { DialogModule } from 'primeng/dialog';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import {
  ExperimentosPrecioService, type EstratoDef, type ExperimentoRow,
  type CapturaRow, type ResultadoRow,
} from '../experimentos-precio.service';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

/**
 * `[PR.D2]` — **Experimentos de precio.** Operations: tabla densa + detalle maestro-detalle.
 *
 * ── Answer-first (§Q.1) ────────────────────────────────────────────────────────────────────
 * La pantalla abre con **el estado de la captura**, no con el grid. Porque la pregunta que
 * alguien trae al entrar no es "cuántas filas hay": es *"¿ya se puede medir esto?"* — y la
 * respuesta es el avance de captura, no el tamaño de la tabla.
 *
 * ── ⛔ Lo que esta pantalla NO hace, y se ve ───────────────────────────────────────────────
 * Kepler es read-only (ADR-040): acá **no se cambia ningún precio**. Se entrega la lista y se
 * marca lo que ya se capturó. Esa distinción está escrita en la pantalla, no sólo en el código:
 * quien la usa tiene que saber que el botón registra, no aplica.
 *
 * ── El contrato de diseño, medido ──────────────────────────────────────────────────────────
 * Sin `font-size` literal (la escala `--fs-*` es estricta) · sin hex crudo · `tabular-nums` en
 * toda cifra · números a la derecha **y su `<th>` también** con la clase canónica `comm-num`
 * (no una inventada) · elevación por **hairline, nunca sombra** dentro de la página · fila de
 * `--row-h-md` · cero zebra · jerarquía por **tipo y contraste**, no por cajas ni color ·
 * `--action` en **un solo rol**: la acción que escribe.
 */
@Component({
  selector: 'app-comercial-experimentos-precio',
  standalone: true,
  imports: [CommonModule, FormsModule, PageTabsComponent, TableModule, ButtonModule, SkeletonModule, ToastModule, DialogModule, MetricStripComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div class="surf-page xp">
  <p-toast />

  <div class="pr-tabs"><app-page-tabs [tabs]="tabs" variant="liquid" /></div>

  <header class="surf-page-head">
    <div class="surf-page-head-text">
      <h1>Experimentos de precio</h1>
      <p class="surf-page-sub">
        Prueba de <strong>no-inferioridad</strong>: si aterrizar el precio hace caer el volumen
        más que el margen que el negocio tolera. El experimento
        <strong>no cambia precios</strong> &mdash; entrega la lista y registra lo capturado.
      </p>
    </div>
    <div class="xp-head-acc">
      <button type="button" pButton class="p-button-text p-button-sm"
              icon="pi pi-refresh" label="Actualizar"
              [loading]="cargando()" (click)="recargar()"></button>
      @if (puedeDisenar()) {
        <button type="button" pButton class="p-button-sm"
                icon="pi pi-plus" label="Diseñar experimento"
                (click)="abrirDiseno()"></button>
      }
    </div>
  </header>

  @if (error(); as e) {
    <div class="xp-err" role="alert">
      <span>{{ e }}</span>
      <button type="button" pButton class="p-button-sm p-button-text" label="Reintentar"
              (click)="recargar()"></button>
    </div>
  }

  @if (cargando()) {
    <div class="xp-skel">
      @for (i of [1,2,3,4,5,6]; track i) { <p-skeleton height="2rem" /> }
    </div>
  } @else {

    <!-- ══ ANSWER-FIRST: ¿se puede medir ya? ══ -->
    @if (sel(); as x) {
      <app-metric-strip [items]="kpis()" ariaLabel="Estado del experimento" />
      <p class="xp-proc">
        Semilla <code>{{ x.semilla }}</code> &middot; modo <code>.{{ x.modo_aterrizaje }}</code>
        &middot; asignación reproducible.
        @if (x.dias_dispersion !== null && x.dias_dispersion > 7) {
          <span class="xp-warn">
            &nbsp;⚠️ la captura se extendió {{ x.dias_dispersion }} días: las dos ramas dejan de
            compartir calendario y la estacionalidad entra como sesgo.
          </span>
        }
      </p>
    }

    <div class="xp-split" [class.has-det]="!!sel()">
      <!-- ══ LOS EXPERIMENTOS ══ -->
      <section class="xp-main">
        <h2 class="xp-h2">Experimentos</h2>
        <p-table [value]="experimentos()" styleClass="p-datatable-sm surf-table surf-table--sticky"
                 [rowHover]="true" selectionMode="single"
                 [(selection)]="seleccion" (selectionChange)="elegir($event)" dataKey="id">
          <ng-template #header>
            <tr>
              <th scope="col">Nombre</th>
              <th scope="col">Estado</th>
              <th scope="col" class="comm-num">Tratamiento</th>
              <th scope="col" class="comm-num">Capturadas</th>
              <th scope="col" class="comm-num">Avance</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr [pSelectableRow]="r">
              <td>
                <div class="xp-nom">{{ r.nombre }}</div>
                <div class="xp-sub">δ por estrato &middot; modo .{{ r.modo_aterrizaje }}</div>
              </td>
              <td><span class="xp-tag" [class.is-run]="r.estado === 'en_curso'">{{ r.estado }}</span></td>
              <td class="comm-num">{{ r.tratamiento | number }}</td>
              <td class="comm-num">{{ r.capturadas | number }}</td>
              <td class="comm-num">{{ avance(r) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="5">
              <div class="comm-empty">
                <i class="pi pi-flag" aria-hidden="true"></i>
                <h3>Todavía no hay ningún experimento</h3>
                <p>
                  El primero está dimensionado y listo: el estrato de menos de $10 tiene
                  <strong>924 celdas elegibles</strong> y el diseño pide 582.
                </p>
                @if (puedeDisenar()) {
                  <button type="button" pButton class="p-button-sm" icon="pi pi-plus"
                          label="Diseñar el primero" (click)="abrirDiseno()"></button>
                } @else {
                  <p class="xp-empty-nota">Lo diseña quien tenga el permiso de gestión.</p>
                }
              </div>
            </td></tr>
          </ng-template>
        </p-table>

        <!-- ══ LOS ESTRATOS: lo que se puede probar y lo que NO ══ -->
        <h2 class="xp-h2">Estratos &mdash; qué se puede probar</h2>
        <p class="xp-nota">
          El margen que el negocio tolera sale de su propia aritmética:
          <code>(1&minus;q) ≥ (P&minus;C)/(P(1+a)&minus;C)</code>. Cambia por orden de magnitud
          entre rangos, y con él el tamaño que el experimento necesita.
        </p>
        <p-table [value]="estratos()" styleClass="p-datatable-sm surf-table">
          <ng-template #header>
            <tr>
              <th scope="col">Rango</th>
              <th scope="col" class="comm-num">δ tolerable</th>
              <th scope="col" class="comm-num">Necesita</th>
              <th scope="col" class="comm-num">Elegibles</th>
              <th scope="col">&nbsp;</th>
            </tr>
          </ng-template>
          <ng-template #body let-e>
            <tr [class.is-no]="!e.viable">
              <td class="xp-rango">{{ rango(e) }}</td>
              <td class="comm-num">{{ e.deltaPct }}%</td>
              <td class="comm-num">{{ e.nPorRama * 2 | number }}</td>
              <td class="comm-num">{{ e.elegibles | number }}</td>
              <td>
                @if (e.viable) {
                  <span class="xp-ok">alcanza</span>
                } @else {
                  <span class="xp-no">no alcanza &mdash; se declara, no se corre sin potencia</span>
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </section>

      <!-- ══ DETALLE ══ -->
      @if (sel(); as x) {
        <aside class="xp-det">
          <header class="xp-det-head">
            <div>
              <h2>{{ x.nombre }}</h2>
              <p class="xp-sub">{{ pendientes().length | number }} precios por capturar en Kepler</p>
            </div>
            <button type="button" pButton class="p-button-text p-button-sm" icon="pi pi-times"
                    aria-label="Cerrar" (click)="cerrar()"></button>
          </header>

          @if (resultados().length) {
            <h3 class="xp-det-h3">Veredicto</h3>
            @for (r of resultados(); track r.estrato) {
              <div class="xp-ver">
                <div class="xp-ver-t">{{ r.veredicto }}</div>
                <div class="xp-ver-n comm-num">
                  {{ r.efecto_pct }}% &middot; IC [{{ r.ic_inferior_pct }}, {{ r.ic_superior_pct }}]
                </div>
                <p class="xp-ver-m">{{ r.veredicto_motivo }}</p>
              </div>
            }
          } @else {
            <p class="xp-nota">
              Todavía no hay veredicto: se calcula cuando la ventana posterior se cumpla sobre
              las unidades capturadas.
            </p>
          }

          <h3 class="xp-det-h3">Lista de captura</h3>
          <p class="xp-nota">
            ⛔ Sólo el <strong>tratamiento</strong>. El control no se toca &mdash; ése es su trabajo.
          </p>
          <table class="xp-cap">
            <thead>
              <tr>
                <th scope="col">Plaza</th>
                <th scope="col">SKU</th>
                <th scope="col" class="comm-num">Hoy</th>
                <th scope="col" class="comm-num">Capturar</th>
                <th scope="col">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              @for (c of pendientes().slice(0, 40); track c.id) {
                <tr>
                  <td class="comm-code">{{ c.sucursal }}</td>
                  <td class="comm-code">{{ c.sku }}</td>
                  <td class="comm-num xp-old">{{ c.precio_antes | number: '1.2-2' }}</td>
                  <td class="comm-num xp-new">{{ c.precio_propuesto | number: '1.2-2' }}</td>
                  <td>
                    <button type="button" pButton class="p-button-sm p-button-text"
                            label="Ya lo capturé" [loading]="marcando() === c.id"
                            (click)="marcar(c)"></button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="xp-nota">
                  Todo capturado. El veredicto sale cuando se cumpla la ventana posterior.
                </td></tr>
              }
            </tbody>
          </table>
          @if (pendientes().length > 40) {
            <p class="xp-nota">y {{ pendientes().length - 40 | number }} más.</p>
          }
        </aside>
      }
    </div>
  }

<!-- [PR.V6] Disenar el experimento. El backend ya tenia POST /commercial/price-experiments y
     los tres endpoints del flujo de captura; la pantalla solo llamaba a los dos de lectura, asi
     que quien SI tenia el permiso veia un texto diciendole que lo hace otra persona. -->
<p-dialog [(visible)]="dialogoAbierto" [modal]="true" [draggable]="false"
          [style]="{ width: '34rem', maxWidth: '94vw' }"
          header="Diseñar experimento de precio">
  <div class="xp-form">
    <label class="xp-f">
      <span class="xp-f-l">Nombre</span>
      <input pInputText type="text" [(ngModel)]="nombre" name="nombre"
             placeholder="Aterrizaje .99 — menores de $10" />
    </label>

    <div class="xp-f">
      <span class="xp-f-l">Terminación a probar</span>
      <div class="xp-seg" role="group" aria-label="Terminación">
        @for (m of MODOS; track m.v) {
          <button type="button" [class.is-on]="modo() === m.v" (click)="modo.set(m.v)">
            .{{ m.v }}
          </button>
        }
      </div>
      <span class="xp-f-h">{{ glosaModo() }}</span>
    </div>

    <label class="xp-f">
      <span class="xp-f-l">Semilla</span>
      <input type="number" [(ngModel)]="semillaN" name="semilla" class="xp-num" />
      <span class="xp-f-h">
        Se guarda con el experimento. Sin ella la asignación no se puede reproducir, y un
        resultado que no se puede reproducir no es un resultado.
      </span>
    </label>

    <div class="xp-f">
      <span class="xp-f-l">Estratos</span>
      @for (e of estratos(); track e.clave) {
        <label class="xp-chk" [class.is-off]="!e.viable">
          <input type="checkbox" [checked]="estratosSel().has(e.clave)" (change)="alternar(e.clave)" />
          <span class="xp-chk-t">{{ e.clave }}</span>
          <span class="xp-chk-n">pide {{ e.nPorRama | number }} · hay {{ e.elegibles | number }}</span>
          @if (!e.viable) { <span class="xp-chk-w">no alcanza</span> }
        </label>
      }
      <span class="xp-f-h">
        Los que no alcanzan se pueden marcar igual, y entran declarados sin potencia: ocultarlos
        haría creer que el experimento cubre el catálogo entero.
      </span>
    </div>
  </div>

  <ng-template #footer>
    <button type="button" pButton class="p-button-text p-button-sm" label="Cancelar"
            (click)="dialogoAbierto = false"></button>
    <button type="button" pButton class="p-button-sm" label="Diseñar"
            [disabled]="!nombre().trim() || !estratosSel().size || guardando()"
            [loading]="guardando()" (click)="disenar()"></button>
  </ng-template>
</p-dialog>
</div>
  `,
  styles: [`
    /* [PR.V6] El formulario de diseno. */
    .xp-head-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .xp-empty-nota { font-size: var(--fs-xs); color: var(--fg-3); margin-top: var(--sp-2); }
    .xp-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .xp-f { display: flex; flex-direction: column; gap: 4px; }
    .xp-f-l { font-size: var(--fs-xs); font-weight: 600; color: var(--fg-1); }
    .xp-f-h { font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.45; }
    .xp-num { width: 10rem; padding: .4rem .55rem; font-family: var(--font-mono);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--surface-card);
      color: var(--fg-1); }
    .xp-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--r-md);
      background: var(--surface-2); width: fit-content; }
    .xp-seg button { border: none; background: none; cursor: pointer; font: inherit;
      font-size: var(--fs-sm); font-family: var(--font-mono); color: var(--fg-2);
      padding: .3rem .7rem; border-radius: calc(var(--r-md) - 2px); }
    .xp-seg button.is-on { background: var(--surface-card); color: var(--fg-1); font-weight: 600;
      box-shadow: 0 1px 2px rgba(9,9,11,.08); }
    .xp-chk { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm);
      padding: .25rem 0; cursor: pointer; }
    .xp-chk.is-off .xp-chk-t { color: var(--fg-2); }
    .xp-chk-t { font-family: var(--font-mono); }
    .xp-chk-n { font-size: var(--fs-xs); color: var(--fg-2); font-variant-numeric: tabular-nums; }
    .xp-chk-w { font-size: var(--fs-nano); font-weight: 700; text-transform: uppercase;
      letter-spacing: .04em; color: var(--warn-soft-fg); background: var(--warn-soft-bg);
      padding: 1px 5px; border-radius: 3px; }
    /* [PR.V2] El selector segmentado va ARRIBA del encabezado de la pagina, como en
       Almacen y Contabilidad. El padding horizontal ya lo pone .surf-page: aca solo
       hace falta separarlo del borde superior y del titulo.
       Y SIN acentos graves: adentro de un template literal lo TERMINAN. Van diez. */
    .pr-tabs { padding-top: var(--sp-3); margin-bottom: var(--sp-3); }
    /* Escala estricta: sólo var(--fs-*). Elevación por hairline, nunca sombra in-page. */
    .xp { display: flex; flex-direction: column; gap: var(--sp-4); }

    .xp-err {
      display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      padding: var(--sp-3) var(--sp-4);
      border: 1px solid var(--bad-border); border-radius: var(--r-md);
      background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm);
    }
    .xp-skel { display: flex; flex-direction: column; gap: var(--sp-2); }

    .xp-proc { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.6; }
    .xp-warn { color: var(--warn-soft-fg); }

    /* Master-detail por CSS, sin drawer: el panel convive con la tabla. */
    .xp-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); }
    .xp-split.has-det { grid-template-columns: minmax(0, 1fr) 27rem; }
    @media (max-width: 1100px) { .xp-split.has-det { grid-template-columns: minmax(0, 1fr); } }

    .xp-main { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }

    /* Jerarquía por tamaño + peso + contraste. Nunca por caja ni por color. */
    .xp-h2 {
      margin: var(--sp-2) 0 0; font-size: var(--fs-micro); font-weight: var(--fw-bold);
      letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3);
    }
    .xp-nom { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); }
    .xp-sub { font-size: var(--fs-micro); color: var(--fg-3); }
    .xp-nota { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.55; }
    .xp-rango { font-family: var(--font-mono); font-size: var(--fs-xs); }

    .xp-tag {
      font-size: var(--fs-nano); font-weight: var(--fw-bold); text-transform: uppercase;
      letter-spacing: .03em; padding: 1px var(--sp-2); border-radius: var(--r-pill);
      border: 1px solid var(--border-color); color: var(--fg-2);
    }
    .xp-tag.is-run {
      border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); color: var(--ok-soft-fg);
    }

    .xp-ok { font-size: var(--fs-xs); color: var(--ok-soft-fg); }
    /* El "no alcanza" no es un error: es una declaración. Warn, no bad. */
    .xp-no { font-size: var(--fs-xs); color: var(--warn-soft-fg); }
    tr.is-no td { opacity: .62; }

    .xp-det {
      position: sticky; top: var(--sp-4); align-self: start;
      max-height: calc(100vh - var(--sp-8)); overflow: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-lg);
      background: var(--surface-card); padding: var(--sp-4);
      display: flex; flex-direction: column; gap: var(--sp-3);
    }
    .xp-det-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-2); }
    .xp-det-head h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .xp-det-h3 {
      margin: var(--sp-2) 0 0; font-size: var(--fs-micro); font-weight: var(--fw-bold);
      letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3);
    }

    .xp-ver { border-top: 1px solid var(--border-color); padding-top: var(--sp-2); }
    .xp-ver-t { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    .xp-ver-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2); }
    .xp-ver-m { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.5; }

    .xp-cap { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    .xp-cap th {
      text-align: left; font-size: var(--fs-nano); font-weight: var(--fw-bold);
      letter-spacing: .04em; text-transform: uppercase; color: var(--fg-3);
      padding-bottom: var(--sp-1);
    }
    .xp-cap td { padding: var(--sp-1) 0; border-bottom: 1px solid var(--border-color); }
    .xp-cap tr:last-child td { border-bottom: none; }
    /* El precio viejo recede; el nuevo es el dato. Contraste, no color. */
    .xp-old { color: var(--fg-3); text-decoration: line-through; }
    .xp-new { color: var(--fg-1); font-weight: var(--fw-bold); }
  `],
})
export class ComercialExperimentosPrecioComponent {
  private readonly permisos = inject(PermissionsService);

  /**
   * [PR.V6] Quien puede disenar. El backend exige COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR en el
   * POST; aca se usa la MISMA clave para no mostrar un boton que el servidor va a rechazar.
   */
  readonly puedeDisenar = this.permisos.has$(Permission.COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR);

  dialogoAbierto = false;
  readonly nombre = signal('');
  readonly modo = signal<'00' | '50' | '90' | '99'>('99');
  semillaN = 1;
  /** Los estratos marcados en el dialogo. (El otro `sel` es el experimento abierto.) */
  readonly estratosSel = signal<Set<string>>(new Set());
  readonly guardando = signal(false);

  readonly MODOS: ReadonlyArray<{ v: '00' | '50' | '90' | '99'; g: string }> = [
    { v: '99', g: 'La mas comun y la que el motor propone por default.' },
    { v: '90', g: 'Alza menor que .99: util cuando el salto a .99 se pasa del umbral.' },
    { v: '50', g: 'Media unidad. Rara en dulceria.' },
    { v: '00', g: 'Precio cerrado. Sube menos, pero se lee como mas caro.' },
  ];

  glosaModo(): string {
    return this.MODOS.find((m) => m.v === this.modo())?.g ?? '';
  }

  alternar(clave: string): void {
    const s = new Set(this.estratosSel());
    if (s.has(clave)) s.delete(clave); else s.add(clave);
    this.estratosSel.set(s);
  }

  abrirDiseno(): void {
    // Los viables vienen marcados; los que no alcanzan hay que pedirlos a proposito.
    this.estratosSel.set(new Set(this.estratos().filter((e) => e.viable).map((e) => e.clave)));
    this.nombre.set('Aterrizaje .' + this.modo());
    this.semillaN = Math.floor(Math.random() * 1e6);
    this.dialogoAbierto = true;
  }
  /** `[PR.V2]` El selector segmentado: el motor y sus experimentos, bajo una sola
   *  entrada del sidebar. `PageTabs` esconde la barra si el rol sólo alcanza una. */
  readonly tabs = PRECIOS_TABS;

  private readonly api = inject(ExperimentosPrecioService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly experimentos = signal<ExperimentoRow[]>([]);
  readonly estratos = signal<EstratoDef[]>([]);
  readonly captura = signal<CapturaRow[]>([]);
  readonly resultados = signal<ResultadoRow[]>([]);
  readonly sel = signal<ExperimentoRow | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly marcando = signal<string | null>(null);
  seleccion: ExperimentoRow | null = null;

  /** Sólo lo que falta capturar: lo ya hecho no es trabajo pendiente. */
  readonly pendientes = computed(() => this.captura().filter((c) => !c.aplicado_at));

  /**
   * ⭐ Cada KPI lleva la forma que su dato pide, no cuatro cajas iguales con un número adentro:
   * el avance es una razón (barra), las unidades un conteo, la dispersión un dato con umbral.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const x = this.sel();
    if (!x) return [];
    const pct = x.tratamiento ? Math.round((100 * x.capturadas) / x.tratamiento) : 0;
    const disp = x.dias_dispersion;
    return [
      {
        label: 'Avance de captura', value: `${pct}%`, format: 'text', pct,
        sub: `${x.capturadas} de ${x.tratamiento}`,
        tone: pct === 100 ? 'ok' : pct > 0 ? 'warn' : 'default',
      },
      { label: 'Tratamiento', value: x.tratamiento, format: 'number', sub: 'precios a mover' },
      { label: 'Control', value: x.control, format: 'number', sub: 'no se tocan' },
      {
        // ⛔ Sin capturas no hay dispersión: va texto con motivo, nunca un cero que engañe.
        label: 'Dispersión de captura',
        value: disp === null ? 'sin medir' : `${disp} d`,
        format: disp === null ? 'text' : 'text',
        sub: disp === null ? 'nada capturado aún' : disp > 7 ? 'sesga el calendario' : 'dentro de rango',
        tone: disp !== null && disp > 7 ? 'bad' : 'default',
      },
    ];
  });

  constructor() { this.recargar(); }

  recargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.listar().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.experimentos.set(r); this.cargando.set(false); },
      error: (e) => { this.error.set(e?.error?.message ?? 'No se pudo cargar'); this.cargando.set(false); },
    });
    this.api.estratos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.estratos.set(r.estratos),
      error: () => { /* los estratos son contexto: su falla no tumba la pantalla */ },
    });
  }

  elegir(x: ExperimentoRow | null): void {
    this.sel.set(x);
    this.captura.set([]);
    this.resultados.set([]);
    if (!x) return;
    this.api.captura(x.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.captura.set(r), error: () => this.captura.set([]) });
    this.api.resultados(x.id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.resultados.set(r), error: () => this.resultados.set([]) });
  }

  cerrar(): void { this.seleccion = null; this.sel.set(null); }

  /** Registra que el precio YA se capturó en Kepler. ⛔ No lo aplica: el ERP es de sólo lectura. */
  marcar(c: CapturaRow): void {
    if (this.marcando()) return;
    this.marcando.set(c.id);
    const previo = this.captura();
    // Optimista: sale de la lista ya. Si falla, vuelve — y se dice.
    this.captura.update((arr) => arr.map((x) =>
      x.id === c.id ? { ...x, aplicado_at: new Date().toISOString() } : x));
    this.api.marcarAplicada(c.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.marcando.set(null);
        this.toast.add({ severity: 'success', summary: 'Registrado',
          detail: `${c.sku} en plaza ${c.sucursal}` });
      },
      error: (e) => {
        this.marcando.set(null);
        this.captura.set(previo);
        this.toast.add({ severity: 'error', summary: 'No se registró',
          detail: e?.error?.message ?? 'Intentá de nuevo' });
      },
    });
  }

  avance(r: ExperimentoRow): string {
    if (!r.tratamiento) return '—';
    return `${Math.round((100 * r.capturadas) / r.tratamiento)}%`;
  }

  rango(e: EstratoDef): string {
    if (e.max > 1e8) return `> $${e.min}`;
    return `$${e.min} – $${e.max}`;
  }

  disenar(): void {
    this.guardando.set(true);
    this.api.disenar(this.nombre().trim(), this.modo(), this.semillaN, [...this.estratosSel()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardando.set(false);
          this.dialogoAbierto = false;
          this.toast.add({ severity: 'success', summary: 'Experimento diseñado',
            detail: 'Ningun precio cambio: la lista para capturar en Kepler ya esta.' });
          this.recargar();
        },
        error: (e) => {
          this.guardando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo disenar',
            detail: e?.error?.message ?? 'Error inesperado' });
        },
      });
  }
}
