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
 * `[ETQ-CAMBIOS.1]` **Cambios de precio** — qué etiquetas quedaron viejas en el anaquel.
 *
 * Es la otra mitad de la etiquetera: `/tienda/etiquetas` es el acto deliberado (buscar, escanear,
 * armar la cola) y ésta es el disparador. El ERP mueve un precio y hasta hoy nadie se enteraba
 * hasta que un cliente reclamaba en la caja.
 *
 * ── ⛔ Lo que esta pantalla NO puede decir, y por qué se declara en vez de disimularse ─────────
 * **No muestra el precio anterior.** Ninguna tabla del sistema lo guarda — medido, y es la deuda
 * `VP.3` del roadmap. La fuente que sí lo tiene es `kepler_ods.kdpv_bitacora_precios` (bitácora
 * nativa de Kepler, con anterior/nuevo/delta por plaza), y **no está llegando**: su último push
 * al ODS fue el 2026-09-02 y la última fila de cada sucursal es del 2026-09-01, con los dos
 * carriles del ODS en verde. Mientras eso siga así, inventar un "antes" desde otra fuente sería
 * dibujar un número que nadie puede comprobar.
 *
 * **Y la ventana es corta a propósito.** El reloj es `product_label_prices.updated_at`, cuyo
 * UPSERT es churn-free (toca la fila sólo cuando cambia). A 24 h da 6–10 productos por plaza, que
 * es creíble; a 7 días salta a ~4,750 —medio catálogo— porque hubo una reescritura masiva que
 * `updated_at` no distingue de un cambio real. Por eso el selector llega a 72 h y no a semanas.
 *
 * ── Por qué no imprime ella misma ───────────────────────────────────────────────────────────
 * Manda los códigos a `/tienda/etiquetas` por **estado del router** y deja que la cola de allá
 * haga su trabajo: mismo `resolve`, mismo tope, mismo aviso de precio en vivo, misma hoja.
 * Duplicar la maquinaria de impresión acá sería un segundo lugar donde arreglar el mismo bug. Va
 * por estado y no por query param porque "imprimir todas" puede ser cientos de códigos.
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
    .cpr-bar select{ padding:.35rem .5rem; border:1px solid var(--surface-border); border-radius:.35rem;
      background:var(--surface-0); color:inherit; font-size:.85rem; }
    /* El aviso de lo que la pantalla NO sabe. Va arriba y siempre visible: si se esconde detras de
       un icono, el operador asume que el precio anterior no existia, no que no lo tenemos. */
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
    .cpr-precio{ text-align:right; font-weight:700; font-variant-numeric:tabular-nums; }
    .cpr-cuando{ color:var(--text-color-secondary); white-space:nowrap; }
    .cpr-trunc{ color:#c1620a; font-size:.8rem; margin:0; }
  `],
  template: `
    <div class="cpr-screen">
      <app-page-tabs [tabs]="tabs" />

      <div class="cpr-head">
        <h1>Cambios de precio</h1>
        <p>Productos cuyo precio cambió en tu tienda. Marca los que quieras y mándalos a la cola de impresión.</p>
      </div>

      @if (!sucursal) {
        <div class="cpr-nota">
          Tu usuario no tiene tienda asignada, así que no hay de dónde leer los cambios: el reloj es
          por <b>producto y sucursal</b>. Mezclar plazas diría que cambió algo que en tu tienda no cambió.
        </div>
      } @else {
        <div class="cpr-bar">
          <label for="cpr-ventana">Últimas</label>
          <select id="cpr-ventana" [ngModel]="horas()" (ngModelChange)="horas.set(+$event)">
            @for (v of ventanas; track v.value) { <option [value]="v.value">{{ v.label }}</option> }
          </select>
          <span class="spacer"></span>
          <p-button label="Actualizar" icon="pi pi-refresh" size="small" [text]="true" (onClick)="datos.reload()" />
          <p-button [label]="'Imprimir selección (' + marcados().length + ')'" icon="pi pi-print" size="small"
                    [disabled]="!marcados().length" (onClick)="imprimir(marcados())" />
          <p-button [label]="'Imprimir todas (' + items().length + ')'" icon="pi pi-print" size="small"
                    [outlined]="true" [disabled]="!items().length" (onClick)="imprimir(items())" />
        </div>

        <div class="cpr-nota">
          <b>No se muestra el precio anterior:</b> el sistema todavía no lo guarda. La bitácora de
          Kepler —la única fuente que lo tiene— dejó de llegar el 1-sep-2026, y está reportado.
          Lo que ves es el precio <b>nuevo</b> y cuándo cambió, que es lo que decide si hay que reimprimir.
        </div>

        @if (datos.error()) {
          <div class="cpr-nota">No se pudo leer la lista de cambios. Intenta de nuevo con Actualizar.</div>
        }
        @if (truncado()) {
          <p class="cpr-trunc">Hay más cambios de los que caben en la lista: se muestran los
            {{ items().length }} más recientes. Acorta la ventana para verlos todos.</p>
        }

        @if (datos.isLoading()) {
          <p>Buscando cambios…</p>
        } @else if (!items().length) {
          <div class="cpr-empty">
            <h2>Ningún precio cambió en las últimas {{ horas() }} horas</h2>
            <p>Si esperabas un cambio y no aparece, puede que el ERP todavía no lo haya publicado.</p>
          </div>
        } @else {
          <div class="cpr-wrap">
            <table class="cpr-tabla">
              <thead>
                <tr>
                  <th style="width:2.5rem">
                    <input type="checkbox" [checked]="todosMarcados()" (change)="marcarTodos($any($event.target).checked)"
                           aria-label="Marcar todos" />
                  </th>
                  <th style="width:7rem">Código</th>
                  <th>Producto</th>
                  <th style="width:8rem" class="cpr-precio">Precio nuevo</th>
                  <th style="width:5rem">Unidad</th>
                  <th style="width:9rem">Cambió</th>
                </tr>
              </thead>
              <tbody>
                @for (r of items(); track r.sku) {
                  <tr>
                    <td><input type="checkbox" [checked]="marcado(r.sku)" (change)="alternar(r.sku)"
                               [attr.aria-label]="'Marcar ' + r.sku" /></td>
                    <td class="cpr-num">{{ r.sku }}</td>
                    <td>{{ r.name }}</td>
                    <td class="cpr-precio">{{ r.piece_price != null ? ('$' + (r.piece_price | number:'1.2-2')) : 'sin precio' }}</td>
                    <td>{{ r.unit_base || '—' }}</td>
                    <td class="cpr-cuando">{{ r.changed_at | date:'dd/MM HH:mm' }}</td>
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

  readonly horas = signal(24);
  /**
   * Tope en 72 h MEDIDO, no elegido: a 7 días `updated_at` toca ~4,750 filas por plaza (medio
   * catálogo) por una reescritura masiva que no se distingue de un cambio real. Ofrecer "7 días"
   * sería ofrecer una lista que no significa nada.
   */
  readonly ventanas = [
    { label: '24 horas', value: 24 },
    { label: '48 horas', value: 48 },
    { label: '72 horas', value: 72 },
  ];

  readonly datos = rxResource({
    params: () => ({ suc: this.sucursal, h: this.horas() }),
    stream: ({ params }) => this.svc.priceChanges(params.suc, params.h),
  });

  readonly items = computed<PriceChange[]>(() => this.datos.value()?.items ?? []);
  readonly truncado = computed(() => this.datos.value()?.truncado === true);

  /** Marcados por SKU. Se limpia solo cuando cambia la lista: un sku que ya no está no se imprime. */
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
   */
  imprimir(filas: PriceChange[]): void {
    const codes = Array.from(new Set(filas.map((f) => f.sku).filter(Boolean)));
    if (!codes.length) return;
    this.router.navigate(['/tienda/etiquetas'], { state: { codes } });
  }
}
