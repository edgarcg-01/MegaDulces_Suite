import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { rxResource } from '@angular/core/rxjs-interop';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { AuthService } from '../../../core/services/auth.service';
import { EtiquetasService, PriceChange } from '../etiquetas.service';
import { ETIQUETAS_TABS } from '../etiquetas-tabs';

/**
 * `[ETQ-CAMBIOS.2]` **Cambios de precio** — qué etiquetas quedaron viejas en el anaquel.
 *
 * Es la otra mitad de la etiquetera: `/tienda/etiquetas` es el acto deliberado (buscar, escanear,
 * armar la cola) y ésta es el disparador. El ERP mueve un precio y hasta hoy nadie se enteraba
 * hasta que un cliente reclamaba en la caja.
 *
 * ── De dónde sale, y por qué cambió de fuente ───────────────────────────────────────────────
 * Lee `analytics.v_label_price_changes`, derivada de la bitácora NATIVA de Kepler — la única
 * fuente del sistema que guarda el precio ANTERIOR. La primera versión usaba
 * `product_label_prices.updated_at` y **no podía dar lo que se pedía**: esa columna guarda el
 * ÚLTIMO toque, no un registro, así que un selector de fechas sólo acierta por casualidad (si el
 * producto cambió el 15 y otra vez el 20, sólo queda el 20), y el precio anterior no existe en
 * ninguna tabla propia.
 *
 * El día por defecto es **ayer**: es el que la encargada revisa al abrir la tienda.
 *
 * ── Por qué no imprime ella misma ───────────────────────────────────────────────────────────
 * Manda los códigos a `/tienda/etiquetas` por **estado del router** y deja que la cola de allá
 * haga su trabajo: mismo `resolve`, mismo tope, mismo aviso de precio en vivo, misma hoja.
 * Duplicar la maquinaria de impresión acá sería un segundo lugar donde arreglar el mismo bug.
 *
 * ── `[ETQ-CAMBIOS.5]` Lo que la revisión contra DESIGN.md encontró ──────────────────────────
 * La primera versión pasaba el ojo pero **tres de sus defectos eran reales, no de estilo**: usaba
 * tres tokens que NO EXISTEN en `libs/design-tokens/tokens.css` (medido: `--surface-0`,
 * `--surface-50`, `--text-color-secondary`; cero definiciones). Un `var()` sin fallback que no
 * resuelve deja la declaración inválida en tiempo de cómputo, y eso NO es "se ve un poco
 * distinto":
 *
 *   `background: var(--surface-0)` en el `th` pegajoso  → transparente, las filas se leían
 *                                                         ENCIMA del encabezado al hacer scroll
 *   `background: var(--surface-50)` en el hover de fila → transparente: cero respuesta al puntero
 *   `color: var(--text-color-secondary)`                → hereda, o sea el texto secundario salía
 *                                                         idéntico al primario: la jerarquía que
 *                                                         el código creía tener no existía
 *
 * Más 6 hex crudos (pre-vuelo §2) que además rompían en oscuro (pre-vuelo §12b): un chip
 * rosa claro sobre zinc `#111`. Y faltaban tres cosas que el doc marca BINDING: el veredicto
 * arriba (§Q.1 — abría directo en el grid crudo, que es su antipatrón textual), la frescura
 * —que el servicio YA mandaba y la pantalla tiraba, justo en la pantalla del incidente de los
 * seis días— y las filas esqueleto en vez de un "Buscando…" suelto (§datos densos 4).
 */
@Component({
  selector: 'app-tienda-cambios-precio',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cpr-screen{ padding:1rem 1.25rem 2rem; display:flex; flex-direction:column; gap:.9rem; }
    .cpr-head h1{ font-size:var(--fs-lg); font-weight:var(--fw-bold); margin:0; letter-spacing:-.01em; }
    .cpr-head p{ margin:.2rem 0 0; color:var(--fg-2); font-size:var(--fs-xs); max-width:60ch; }

    .cpr-bar{ display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
    .cpr-bar .spacer{ flex:1 1 auto; }
    .cpr-bar label{ font-size:var(--fs-xs); color:var(--fg-2); }
    .cpr-bar input[type=date]{ padding:.3rem .5rem; border:1px solid var(--border-color);
      border-radius:var(--radius-sm); background:var(--card-bg); color:var(--fg-1);
      font-size:var(--fs-sm); font-variant-numeric:tabular-nums; min-height:var(--row-h-sm); }
    .cpr-bar input[type=date]:focus-visible{ outline:2px solid var(--action-ring); outline-offset:1px; }

    /* Avisos. Elevación = borde hairline SIN sombra (datos densos 1); el tono lo lleva el
       borde izquierdo con token semantico, nunca un hex. */
    .cpr-nota{ display:flex; gap:.55rem; align-items:flex-start;
      border:1px solid var(--border-color); border-left:3px solid var(--warn-fg);
      background:var(--card-bg); padding:.55rem .75rem; border-radius:var(--radius-sm);
      font-size:var(--fs-xs); line-height:1.45; color:var(--fg-1); }
    .cpr-nota.is-bad{ border-left-color:var(--bad-fg); }
    .cpr-nota.is-info{ border-left-color:var(--info-fg); }
    .cpr-nota i{ color:var(--fg-3); margin-top:.1rem; }
    .cpr-nota b{ font-weight:var(--fw-bold); }
    .cpr-nota span{ display:block; color:var(--fg-2); }

    .cpr-empty{ text-align:center; padding:2.5rem 1rem; color:var(--fg-2); }
    .cpr-empty h2{ font-size:var(--fs-body); font-weight:var(--fw-medium); color:var(--fg-1); margin:0 0 .3rem; }
    .cpr-empty p{ margin:0; font-size:var(--fs-xs); max-width:52ch; margin-inline:auto; }

    .cpr-wrap{ position:relative; max-height:58vh; overflow:auto;
      border:1px solid var(--border-color); border-radius:var(--radius-md); background:var(--card-bg); }
    .cpr-tabla{ width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .cpr-tabla th, .cpr-tabla td{ padding:0 .55rem; height:var(--row-h-md);
      border-bottom:1px solid var(--border-color); text-align:left; }
    .cpr-tabla th{ font-weight:var(--fw-medium); font-size:var(--fs-micro); color:var(--fg-2);
      text-transform:uppercase; letter-spacing:.04em; height:var(--row-h-sm);
      position:sticky; top:0; z-index:1; background:var(--card-bg); }
    .cpr-tabla tbody tr:hover{ background:var(--table-hover); }
    .cpr-tabla tbody tr.is-sel{ background:var(--table-hover); }
    .cpr-num{ font-variant-numeric:tabular-nums; color:var(--fg-2); }
    .cpr-money{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }

    /* El precio viejo se APAGA y el nuevo manda: el ojo tiene que caer en lo que hay que imprimir. */
    .cpr-antes{ color:var(--fg-3); text-decoration:line-through; }
    .cpr-ahora{ font-weight:var(--fw-bold); color:var(--fg-1); }
    .cpr-sube{ color:var(--bad-fg); }
    .cpr-baja{ color:var(--ok-fg); }
    .cpr-pct{ display:block; font-size:var(--fs-micro); color:var(--fg-3); }

    .cpr-badge{ font-size:var(--fs-micro); font-weight:var(--fw-bold); padding:.05rem .35rem;
      border-radius:var(--radius-sm); background:var(--bad-soft-bg); color:var(--bad-soft-fg);
      white-space:nowrap; margin-left:.35rem; }

    /* Blanco de toque: el nativo mide ~13px y esta pantalla se usa con el dedo en el mostrador.
       El area clicable la da el label, no el input (a11y AA + datos densos 13). */
    .cpr-check{ display:inline-flex; align-items:center; justify-content:center;
      inline-size:1.75rem; block-size:1.75rem; cursor:pointer; }
    .cpr-check input{ inline-size:1rem; block-size:1rem; accent-color:var(--action); cursor:pointer; }
    @media (pointer: coarse){ .cpr-check{ inline-size:2.75rem; block-size:2.75rem; } }

    /* Filas esqueleto dimensionadas: el alto es el mismo que el de una fila real, asi el salto
       de layout al llegar el dato es cero. */
    .cpr-skel-row{ height:var(--row-h-md); border-bottom:1px solid var(--border-color);
      display:flex; align-items:center; padding:0 .55rem; gap:.75rem; }
    .cpr-skel{ height:.6rem; border-radius:var(--radius-sm); background:var(--skeleton-bg); }
    @media (prefers-reduced-motion: no-preference){
      .cpr-skel{ animation:cprPulse 1.2s ease-in-out infinite; }
    }
    @keyframes cprPulse{ 0%,100%{ opacity:.55; } 50%{ opacity:1; } }

    /* Barra de lote: sube al marcar la primera fila y reemplaza a los botones de arriba. */
    .cpr-lote{ position:sticky; bottom:0; display:flex; align-items:center; gap:.6rem;
      padding:.5rem .75rem; border:1px solid var(--border-color); border-radius:var(--radius-md);
      background:var(--card-bg); box-shadow:var(--shadow-float); font-size:var(--fs-sm); }
    .cpr-lote .spacer{ flex:1 1 auto; }
    .cpr-lote b{ font-variant-numeric:tabular-nums; }
    @media (prefers-reduced-motion: no-preference){
      .cpr-lote{ animation:cprSube 200ms var(--ease-out, ease-out); }
    }
    @keyframes cprSube{ from{ transform:translateY(8px); opacity:0; } to{ transform:none; opacity:1; } }
  `],
  template: `
    <div class="cpr-screen">
      <app-page-tabs [tabs]="tabs" />

      <div class="cpr-head">
        <h1>Cambios de precio</h1>
        <p>Lo que el ERP movió ese día en tu tienda. Marca lo que quieras y mándalo a la cola de impresión.</p>
      </div>

      @if (!sucursal) {
        <div class="cpr-nota is-info">
          <i class="pi pi-info-circle"></i>
          <div>
            <b>Tu usuario no tiene tienda asignada</b>
            <span>No hay de dónde leer los cambios: la bitácora es por producto y sucursal. Mezclar
              plazas diría que cambió algo que en tu tienda no cambió.</span>
          </div>
        </div>
      } @else {
        <div class="cpr-bar">
          <label for="cpr-fecha">Día</label>
          <input id="cpr-fecha" type="date" [ngModel]="fecha()" (ngModelChange)="verDia($event)" [max]="hoy" />
          <p-button label="Ayer" size="small" [text]="true" (onClick)="verDia(ayer)" />
          <span class="spacer"></span>
          <p-button label="Actualizar" icon="pi pi-refresh" size="small" [text]="true" (onClick)="datos.reload()" />
        </div>

        <!-- Q.1 answer-first: el veredicto del día ANTES del grid. Sin esto la pantalla abría en
             una tabla de cientos de filas, que es el antipatrón textual de esa seccion. -->
        @if (!datos.isLoading() && items().length) {
          <app-metric-strip [items]="resumen()" mode="strip" ariaLabel="Resumen del día" />
        }

        <!-- [OBS.6] La frescura la manda el servicio y esta pantalla la TIRABA. Es la misma
             etiquetera que imprimió seis días de precios viejos, uno 54% bajo costo. -->
        @if (datos.value()?.freshness; as f) {
          @if (f.status === 'stale') {
            <div class="cpr-nota" role="status">
              <i class="pi pi-clock"></i>
              <div>
                <b>Estos precios pueden estar viejos — {{ f.age_human }} de rezago.</b>
                <span>El carril que trae los precios del ERP viene atrasado. La lista es real, la
                  comparación contra el precio de hoy puede no serlo.</span>
              </div>
            </div>
          } @else if (f.status === 'unknown') {
            <div class="cpr-nota" role="status">
              <i class="pi pi-question-circle"></i>
              <div>
                <b>No se pudo verificar qué tan actual es este dato.</b>
                <span>No es que esté viejo: es que no se pudo medir.</span>
              </div>
            </div>
          }
        }

        <!-- Hasta donde llego la bitacora. Sin esto, "ese dia no cambio nada" y "ese dia todavia
             no llego" se ven identicos, y son lo contrario. -->
        @if (sinDato()) {
          <div class="cpr-nota" role="status">
            <i class="pi pi-calendar-times"></i>
            <div>
              <b>Ese día todavía no llegó.</b>
              <span>La bitácora de precios tiene datos hasta <b>{{ fuenteAl() || '—' }}</b>.
                No es que no haya habido cambios: es que el dato no está.</span>
            </div>
          </div>
        }

        @if (datos.error()) {
          <div class="cpr-nota is-bad" role="alert">
            <i class="pi pi-exclamation-triangle"></i>
            <div>
              <b>No se pudo leer la lista de cambios.</b>
              <span>Es un fallo de conexión, no un día sin movimientos. Intenta de nuevo con Actualizar.</span>
            </div>
          </div>
        }

        @if (truncado()) {
          <div class="cpr-nota" role="status">
            <i class="pi pi-filter"></i>
            <div>
              <b>Ese día tuvo más cambios de los que caben en la lista.</b>
              <span>Se muestran los {{ items().length }} de mayor diferencia.</span>
            </div>
          </div>
        }

        @if (datos.isLoading()) {
          <div class="cpr-wrap" aria-busy="true" aria-label="Cargando cambios">
            @for (i of esqueleto; track i) {
              <div class="cpr-skel-row">
                <div class="cpr-skel" style="width:1rem"></div>
                <div class="cpr-skel" style="width:5rem"></div>
                <div class="cpr-skel" style="flex:1 1 auto; max-width:22rem"></div>
                <div class="cpr-skel" style="width:4rem"></div>
                <div class="cpr-skel" style="width:4rem"></div>
              </div>
            }
          </div>
        } @else if (!items().length && !sinDato() && !datos.error()) {
          <div class="cpr-empty">
            <h2>Ningún precio cambió lo suficiente el {{ fecha() }}</h2>
            <p>Sólo se listan los cambios que valen una etiqueta nueva. Kepler registra cada
              recálculo: los de menos de un centavo no mueven el papel, y los de exactamente un
              centavo no justifican ir al anaquel.</p>
            @if (ocultosCentavo() > 0) {
              <p><b>{{ ocultosCentavo() }}</b> movimientos de un centavo quedaron fuera ese día.</p>
            }
          </div>
        } @else if (items().length) {
          <div class="cpr-wrap">
            <table class="cpr-tabla">
              <thead>
                <tr>
                  <th style="width:3rem">
                    <label class="cpr-check">
                      <input type="checkbox" [checked]="todosMarcados()"
                             (change)="marcarTodos($any($event.target).checked)" aria-label="Marcar todos" />
                    </label>
                  </th>
                  <th style="width:7rem">Código</th>
                  <th>Producto</th>
                  <th style="width:4.5rem">Unidad</th>
                  <th style="width:6.5rem" class="cpr-money">Antes</th>
                  <th style="width:6.5rem" class="cpr-money">Ahora</th>
                  <th style="width:7.5rem" class="cpr-money">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                @for (r of items(); track clave(r)) {
                  <tr [class.is-sel]="marcado(r)">
                    <td>
                      <label class="cpr-check">
                        <input type="checkbox" [checked]="marcado(r)" (change)="alternar(r)"
                               [attr.aria-label]="'Marcar ' + r.sku" />
                      </label>
                    </td>
                    <td class="cpr-num">{{ r.sku }}</td>
                    <td>
                      {{ r.name || '—' }}
                      @if (r.es_baja) {
                        <span class="cpr-badge" title="El ERP le quitó el precio: esa etiqueta saldría SIN PRECIO.">sin precio</span>
                      }
                    </td>
                    <td class="cpr-num">{{ r.unidad || '—' }}</td>
                    <td class="cpr-money cpr-antes">{{ r.precio_anterior != null ? ('$' + (r.precio_anterior | number:'1.2-2')) : '—' }}</td>
                    <td class="cpr-money cpr-ahora">{{ r.precio_nuevo != null ? ('$' + (r.precio_nuevo | number:'1.2-2')) : '—' }}</td>
                    <td class="cpr-money" [class.cpr-sube]="(r.delta || 0) > 0" [class.cpr-baja]="(r.delta || 0) < 0">
                      {{ (r.delta || 0) > 0 ? '+' : '' }}{{ r.delta != null ? ('$' + (r.delta | number:'1.2-2')) : '—' }}
                      <!-- Q.2: el peso solo no dice si importa. +$0.50 sobre $3 es 17%; sobre $500,
                           0.1%. El porcentaje es lo que decide si vale caminar al anaquel. -->
                      @if (pct(r) !== null) {
                        <span class="cpr-pct">{{ (r.delta || 0) > 0 ? '+' : '' }}{{ pct(r) | number:'1.1-1' }}%</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          @if (marcados().length) {
            <div class="cpr-lote" role="status">
              <b>{{ marcados().length }}</b> de {{ items().length }} marcados
              <span class="spacer"></span>
              <p-button label="Quitar selección" size="small" [text]="true" (onClick)="marcarTodos(false)" />
              <p-button [label]="'Imprimir ' + codigosDe(marcados()).length + ' etiquetas'" icon="pi pi-print"
                        size="small" (onClick)="imprimir(marcados())" />
            </div>
          } @else {
            <div class="cpr-lote">
              <span>Marca los que quieras, o manda todos a la cola.</span>
              <span class="spacer"></span>
              <p-button [label]="'Imprimir todas (' + codigosDe(items()).length + ')'" icon="pi pi-print"
                        size="small" [outlined]="true" (onClick)="imprimir(items())" />
            </div>
          }

          @if (ocultosCentavo() > 0) {
            <p class="cpr-head"><span style="font-size:var(--fs-xs); color:var(--fg-3)">
              Además hubo <b>{{ ocultosCentavo() }}</b> movimientos de un centavo, que no se listan:
              no cambian lo que el cliente paga.
            </span></p>
          }
        }
      }
    </div>
  `,
})
export class TiendaCambiosPrecioComponent {
  private readonly svc = inject(EtiquetasService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly tabs = ETIQUETAS_TABS;
  /** Misma fuente de plaza que la etiquetera: la tienda del propio usuario. */
  readonly sucursal = this.auth.user()?.warehouse_code || null;

  /** Altos de fila del esqueleto. Dimensionado = cero salto de layout al llegar el dato. */
  readonly esqueleto = [0, 1, 2, 3, 4, 5, 6, 7];

  /** Hoy y ayer en hora de México — el día que se revisa al abrir la tienda es AYER, no el UTC. */
  readonly hoy = TiendaCambiosPrecioComponent.diaMx(0);
  readonly ayer = TiendaCambiosPrecioComponent.diaMx(-1);
  readonly fecha = signal(this.ayer);

  private static diaMx(offset: number): string {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  readonly datos = rxResource({
    params: () => ({ suc: this.sucursal, f: this.fecha() }),
    stream: ({ params }) => this.svc.priceChanges(params.suc, params.f),
  });

  readonly items = computed<PriceChange[]>(() => this.datos.value()?.items ?? []);
  readonly truncado = computed(() => this.datos.value()?.truncado === true);
  readonly fuenteAl = computed(() => this.datos.value()?.fuente_al ?? null);
  readonly ocultosCentavo = computed(() => this.datos.value()?.ocultos_centavo ?? 0);

  /** El día pedido está más allá de lo que la bitácora alcanzó: la lista vacía NO significa "sin cambios". */
  readonly sinDato = computed(() => {
    const al = this.fuenteAl();
    return !this.datos.isLoading() && !this.items().length && (!al || this.fecha() > al);
  });

  /**
   * `[ETQ-CAMBIOS.5]` §Q.1 — el veredicto del día, antes del grid.
   *
   * Los tres números particionan la lista (suben + bajan + sin precio = total), así que el operador
   * puede cuadrar de un vistazo en vez de confiar. "Sin precio" va aparte porque NO es una rebaja:
   * es que el ERP le quitó el precio y esa etiqueta saldría en blanco.
   */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const xs = this.items();
    const bajas = xs.filter((r) => r.es_baja).length;
    const suben = xs.filter((r) => !r.es_baja && (r.delta ?? 0) > 0).length;
    const bajan = xs.filter((r) => !r.es_baja && (r.delta ?? 0) < 0).length;
    return [
      { label: 'Para reimprimir', value: xs.length, format: 'number', sub: 'etiquetas' },
      { label: 'Subieron', value: suben, format: 'number', tone: suben ? 'bad' : 'default' },
      { label: 'Bajaron', value: bajan, format: 'number', tone: bajan ? 'ok' : 'default' },
      {
        label: 'Sin precio', value: bajas, format: 'number', tone: bajas ? 'warn' : 'default',
        sub: bajas ? 'el ERP se lo quitó' : undefined,
      },
    ];
  });

  /**
   * Identidad de la FILA, no del SKU. La bitácora registra por presentación: el mismo código puede
   * venir 3 veces (pieza / paquete / caja). Con la selección por SKU, marcar una casilla marcaba
   * las tres — parecía un bug de render y era el modelo.
   */
  readonly clave = (r: PriceChange): string => `${r.sku}|${r.unidad || ''}|${r.hora || ''}`;

  private readonly sel = signal<ReadonlySet<string>>(new Set<string>());
  readonly marcado = (r: PriceChange): boolean => this.sel().has(this.clave(r));
  readonly marcados = computed<PriceChange[]>(() => {
    const s = this.sel();
    return this.items().filter((r) => s.has(this.clave(r)));
  });
  readonly todosMarcados = computed(() => {
    const n = this.items().length;
    return n > 0 && this.marcados().length === n;
  });

  /** Cambiar de día LIMPIA la selección: lo marcado el lunes no es lo que se imprime del martes. */
  verDia(dia: string): void {
    this.sel.set(new Set<string>());
    this.fecha.set(dia);
  }

  alternar(r: PriceChange): void {
    const k = this.clave(r);
    this.sel.update((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }

  marcarTodos(on: boolean): void {
    this.sel.set(on ? new Set(this.items().map((r) => this.clave(r))) : new Set<string>());
  }

  /** Cuánto cambió en PROPORCIÓN. Sin precio anterior no hay porcentaje — se declara con null. */
  pct(r: PriceChange): number | null {
    const antes = r.precio_anterior;
    if (antes == null || antes <= 0 || r.delta == null) return null;
    return (r.delta / antes) * 100;
  }

  /** Códigos únicos de un conjunto de filas: N presentaciones del mismo SKU son UNA etiqueta. */
  codigosDe(filas: PriceChange[]): string[] {
    return Array.from(new Set(filas.map((f) => f.sku).filter(Boolean)));
  }

  /**
   * Manda los códigos a la etiquetera por estado del router. Allá `addBulk()` los resuelve con el
   * mismo camino de siempre — incluido el tope de cola, que deja el sobrante en el textarea.
   */
  imprimir(filas: PriceChange[]): void {
    const codes = this.codigosDe(filas);
    if (!codes.length) return;
    this.router.navigate(['/tienda/etiquetas'], { state: { codes } });
  }
}
