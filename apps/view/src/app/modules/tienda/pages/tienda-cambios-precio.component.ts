import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { rxResource } from '@angular/core/rxjs-interop';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
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
 * ⚠️ La lista sólo trae los cambios que mueven el precio IMPRESO. Kepler escribe una fila cada
 * vez que RECALCULA: medido, de ~54,500 filas de un día en las 9 plazas, ~102 cambian el número
 * que sale en el papel. El resto son deltas de menos de un centavo.
 *
 * ── Por qué no imprime ella misma ───────────────────────────────────────────────────────────
 * Manda los códigos a `/tienda/etiquetas` por **estado del router** y deja que la cola de allá
 * haga su trabajo: mismo `resolve`, mismo tope, mismo aviso de precio en vivo, misma hoja.
 * Duplicar la maquinaria de impresión acá sería un segundo lugar donde arreglar el mismo bug.
 */
@Component({
  selector: 'app-tienda-cambios-precio',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cpr-screen{ padding:1rem 1.25rem 2rem; display:flex; flex-direction:column; gap:1rem; }
    .cpr-head h1{ font-size:1.35rem; font-weight:700; margin:0; }
    .cpr-head p{ margin:.25rem 0 0; color:var(--text-color-secondary); font-size:.85rem; }
    .cpr-bar{ display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
    .cpr-bar .spacer{ flex:1 1 auto; }
    .cpr-bar input[type=date]{ padding:.35rem .5rem; border:1px solid var(--surface-border);
      border-radius:.35rem; background:var(--surface-0); color:inherit; font-size:.85rem; }
    /* Aviso de lo que la pantalla NO sabe. Va arriba y siempre visible: escondido detras de un
       icono, el operador asume que no hubo cambios en vez de que el dato no llego. */
    .cpr-nota{ border-left:3px solid #d4a015; background:var(--surface-100);
      padding:.6rem .8rem; border-radius:.35rem; font-size:.8rem; line-height:1.45; }
    .cpr-nota b{ font-weight:700; }
    .cpr-empty{ text-align:center; padding:3rem 1rem; color:var(--text-color-secondary); }
    .cpr-empty h2{ font-size:1rem; font-weight:600; margin:0 0 .35rem; }
    .cpr-tabla{ width:100%; border-collapse:collapse; font-size:.85rem; }
    .cpr-tabla th, .cpr-tabla td{ padding:.4rem .55rem; border-bottom:1px solid var(--surface-border); text-align:left; }
    .cpr-tabla th{ font-weight:600; font-size:.78rem; color:var(--text-color-secondary);
      position:sticky; top:0; background:var(--surface-0); z-index:1; }
    .cpr-tabla tbody tr:hover{ background:var(--surface-50); }
    .cpr-wrap{ max-height:60vh; overflow:auto; border:1px solid var(--surface-border); border-radius:.4rem; }
    .cpr-num{ font-variant-numeric:tabular-nums; }
    .cpr-money{ text-align:right; font-variant-numeric:tabular-nums; }
    /* El precio viejo se APAGA y el nuevo manda: el ojo tiene que caer en lo que hay que imprimir. */
    .cpr-antes{ color:var(--text-color-secondary); text-decoration:line-through; }
    .cpr-ahora{ font-weight:700; }
    .cpr-sube{ color:#b3261e; }
    .cpr-baja{ color:#1b6b3a; }
    .cpr-badge{ font-size:.7rem; font-weight:700; padding:.05rem .35rem; border-radius:.25rem;
      background:#fde7e7; color:#8c1d18; white-space:nowrap; }
    .cpr-trunc{ color:#c1620a; font-size:.8rem; margin:0; }
  `],
  template: `
    <div class="cpr-screen">
      <app-page-tabs [tabs]="tabs" />

      <div class="cpr-head">
        <h1>Cambios de precio</h1>
        <p>Lo que el ERP movió ese día en tu tienda. Marca lo que quieras y mándalo a la cola de impresión.</p>
      </div>

      @if (!sucursal) {
        <div class="cpr-nota">
          Tu usuario no tiene tienda asignada, así que no hay de dónde leer los cambios: la bitácora
          es por <b>producto y sucursal</b>. Mezclar plazas diría que cambió algo que en tu tienda no cambió.
        </div>
      } @else {
        <div class="cpr-bar">
          <label for="cpr-fecha">Día</label>
          <input id="cpr-fecha" type="date" [ngModel]="fecha()" (ngModelChange)="fecha.set($event)" [max]="hoy" />
          <p-button label="Ayer" size="small" [text]="true" (onClick)="fecha.set(ayer)" />
          <span class="spacer"></span>
          <p-button label="Actualizar" icon="pi pi-refresh" size="small" [text]="true" (onClick)="datos.reload()" />
          <p-button [label]="'Imprimir selección (' + marcados().length + ')'" icon="pi pi-print" size="small"
                    [disabled]="!marcados().length" (onClick)="imprimir(marcados())" />
          <p-button [label]="'Imprimir todas (' + items().length + ')'" icon="pi pi-print" size="small"
                    [outlined]="true" [disabled]="!items().length" (onClick)="imprimir(items())" />
        </div>

        <!-- Hasta donde llego la bitacora. Sin esto, "ese dia no cambio nada" y "ese dia todavia
             no llego" se ven identicos, y son lo contrario. -->
        @if (sinDato()) {
          <div class="cpr-nota">
            <b>Ese día todavía no llegó.</b> La bitácora de precios tiene datos hasta
            <b>{{ fuenteAl() || '—' }}</b>. No es que no haya habido cambios: es que el dato no está.
          </div>
        }

        @if (datos.error()) {
          <div class="cpr-nota">No se pudo leer la lista de cambios. Intenta de nuevo con Actualizar.</div>
        }
        @if (truncado()) {
          <p class="cpr-trunc">Ese día tuvo más cambios de los que caben en la lista: se muestran los
            {{ items().length }} de mayor diferencia.</p>
        }

        @if (datos.isLoading()) {
          <p>Buscando cambios…</p>
        } @else if (!items().length && !sinDato()) {
          <div class="cpr-empty">
            <h2>Ningún precio cambió el {{ fecha() }}</h2>
            <p>Sólo se listan los cambios que mueven el precio impreso: Kepler registra cada recálculo,
              y los de menos de un centavo no cambian la etiqueta.</p>
          </div>
        } @else if (items().length) {
          <div class="cpr-wrap">
            <table class="cpr-tabla">
              <thead>
                <tr>
                  <th style="width:2.5rem">
                    <input type="checkbox" [checked]="todosMarcados()" (change)="marcarTodos($any($event.target).checked)"
                           aria-label="Marcar todos" />
                  </th>
                  <th style="width:6.5rem">Código</th>
                  <th>Producto</th>
                  <th style="width:4rem">Unidad</th>
                  <th style="width:7rem" class="cpr-money">Antes</th>
                  <th style="width:7rem" class="cpr-money">Ahora</th>
                  <th style="width:7rem" class="cpr-money">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                @for (r of items(); track r.sku + '|' + (r.unidad || '') + '|' + (r.hora || '')) {
                  <tr>
                    <td><input type="checkbox" [checked]="marcado(r.sku)" (change)="alternar(r.sku)"
                               [attr.aria-label]="'Marcar ' + r.sku" /></td>
                    <td class="cpr-num">{{ r.sku }}</td>
                    <td>
                      {{ r.name || '—' }}
                      @if (r.es_baja) { <span class="cpr-badge" title="El ERP le quitó el precio: esa etiqueta saldría SIN PRECIO.">sin precio</span> }
                    </td>
                    <td>{{ r.unidad || '—' }}</td>
                    <td class="cpr-money cpr-antes">{{ r.precio_anterior != null ? ('$' + (r.precio_anterior | number:'1.2-2')) : '—' }}</td>
                    <td class="cpr-money cpr-ahora">{{ r.precio_nuevo != null ? ('$' + (r.precio_nuevo | number:'1.2-2')) : '—' }}</td>
                    <td class="cpr-money" [class.cpr-sube]="(r.delta || 0) > 0" [class.cpr-baja]="(r.delta || 0) < 0">
                      {{ (r.delta || 0) > 0 ? '+' : '' }}{{ r.delta != null ? ('$' + (r.delta | number:'1.2-2')) : '—' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
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
  /** El día pedido está más allá de lo que la bitácora alcanzó: la lista vacía NO significa "sin cambios". */
  readonly sinDato = computed(() => {
    const al = this.fuenteAl();
    return !this.datos.isLoading() && !this.items().length && (!al || this.fecha() > al);
  });

  /** Marcados por SKU: la cola de impresión trabaja con códigos, no con renglones de bitácora. */
  private readonly sel = signal<ReadonlySet<string>>(new Set<string>());
  readonly marcado = (sku: string): boolean => this.sel().has(sku);
  readonly marcados = computed<PriceChange[]>(() => {
    const s = this.sel();
    return this.items().filter((r) => s.has(r.sku));
  });
  readonly todosMarcados = computed(() => {
    const n = this.items().length;
    return n > 0 && this.marcados().length === n;
  });

  alternar(sku: string): void {
    this.sel.update((prev) => {
      const next = new Set(prev);
      if (!next.delete(sku)) next.add(sku);
      return next;
    });
  }

  marcarTodos(on: boolean): void {
    this.sel.set(on ? new Set(this.items().map((r) => r.sku)) : new Set<string>());
  }

  /**
   * Manda los códigos a la etiquetera por estado del router. Allá `addBulk()` los resuelve con el
   * mismo camino de siempre — incluido el tope de cola, que deja el sobrante en el textarea.
   * Se deduplica: la bitácora trae una fila por presentación y el mismo SKU puede venir 3 veces.
   */
  imprimir(filas: PriceChange[]): void {
    const codes = Array.from(new Set(filas.map((f) => f.sku).filter(Boolean)));
    if (!codes.length) return;
    this.router.navigate(['/tienda/etiquetas'], { state: { codes } });
  }
}
