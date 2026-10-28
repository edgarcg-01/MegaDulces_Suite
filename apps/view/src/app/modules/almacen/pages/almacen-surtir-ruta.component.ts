import {
  ChangeDetectionStrategy, Component, OnInit, computed, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type { RouteBatchBag, RouteBatchBagLine, RouteBatchDetail, RouteBatchProduct, RouteBatchRow } from '@megadulces/contracts';
import { irConservandoPanel } from '../../../core/panel/ir-conservando-panel';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PresalePickingService } from '../presale-picking.service';
import {
  BolsasGuardadas, PREF_RUTA_BOLSAS, PREF_RUTA_RECOLECTA, acotarCantidad, admiteDecimales, agruparPorMarca,
  cuerpoTerminar, fmtCantidad, guardarLocal, horaMx, leerJson, nombreRuta, productosUnicos, textoOtrasSucursales, textoParte,
} from '../surtir-ruta/ruta-surtido.util';

type Fase = 'cargando' | 'bloqueada' | 'recolectar' | 'repartir';

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * `[MCP.3.6]` **Surtir la ruta de un vendedor como UN pedido global: Recolectar y Repartir.**
 *
 * Se llega desde Surtir › Sucursal › tarjeta de la ruta («Empezar a recolectar» / «Seguir
 * recolectando»), por `/almacen/surtir/ruta/:id`. Ruta propia y no sub-vista de Surtir para que
 * una recarga del celular regrese aquí mismo.
 *
 *  1. **Recolectar**: el total de cada producto de todos los pedidos, agrupado por marca. Un
 *     producto a la vez en tarjeta grande («Lo tomé» / «Hay menos»); los recolectados se encogen a
 *     una línea en su lugar (la lista no se mueve bajo el dedo) y se tocan para corregir. NO se
 *     muestra a quién le toca cada producto: en esta etapa estorba. Lo marcado vive en el celular
 *     hasta «Ya junté todo».
 *  2. **Repartir**: el servidor reparte con la regla fija de `allocation.ts` y devuelve una bolsa
 *     por pedido. Las bolsas listas también se guardan en el celular.
 *
 * ⚠️ «Hay menos» cuenta en la unidad del producto (la que viaja en `picked`), de 0 a `qty`, entero
 * salvo peso o volumen.
 */
@Component({
  selector: 'app-almacen-surtir-ruta',
  standalone: true,
  imports: [FormsModule, ButtonModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in rr-page" [class.rr-page-ancha]="fase() === 'repartir'">
      <p class="rr-oculto" role="status" aria-live="polite">{{ anuncio() }}</p>

      <header class="rr-top">
        <button pButton type="button" [text]="true" severity="secondary" class="rr-tap" (click)="salir()">
          <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Surtir
        </button>
        <div class="rr-top-mid">
          <h1 class="rr-h1">{{ titulo() }}</h1>
          @if (cargadoAl()) { <app-freshness-pill measures="fetch" [since]="cargadoAl()"></app-freshness-pill> }
        </div>
      </header>

      <app-load-state [loading]="fase() === 'cargando'" [error]="error()" [isEmpty]="fase() === 'recolectar' && !productos().length"
                      errorTitle="No se pudo abrir la ruta" emptyTitle="Esta ruta no trae productos"
                      emptyHint="Revisa con la vendedora: la ruta se finalizó sin pedidos que surtir." (retry)="cargarDetalle()">

        <!-- ─────────── NO SE PUEDE RECOLECTAR AQUÍ ─────────── -->
        @if (fase() === 'bloqueada' && bloqueo(); as b) {
          <section class="rr-card rr-bloqueo">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <h2>{{ b.titulo }}</h2>
            <p>{{ b.texto }}</p>
            <button type="button" class="rr-btn rr-btn-go" (click)="salir()">
              <i class="pi pi-arrow-left" aria-hidden="true"></i><span>Volver a Surtir</span>
            </button>
          </section>
        }

        <!-- ─────────── RECOLECTAR ─────────── -->
        @if (fase() === 'recolectar') {
          <!-- [MCP.3.13] Pedidos agrupados: otra sucursal surte su parte de esta misma ruta. -->
          @if (otrasSucursales(); as o) { <p class="rr-parte"><i class="pi pi-sitemap" aria-hidden="true"></i> {{ o }}</p> }
          <app-metric-strip mode="bullet" density="compact" ariaLabel="Avance de la recolección" [items]="avanceRecolecta()"></app-metric-strip>

          @for (g of grupos(); track g.marca) {
            <h2 class="rr-marca">{{ g.marca }}</h2>
            @for (p of g.productos; track p.product_id) {
              @if (actual()?.product_id === p.product_id) {
                <article class="rr-actual" [attr.aria-label]="'Ahora: ' + p.product_name">
                  <div class="rr-prod">
                    <strong>{{ p.product_name }}</strong>
                    @if (p.sku) { <span class="rr-sku">{{ p.sku }}</span> }
                  </div>
                  <div class="rr-cant" [attr.aria-label]="'Tomar ' + cantidadTexto(p.qty, p.unit)">
                    <span class="rr-cant-n">{{ fmt(p.qty) }}</span>
                    <span class="rr-cant-u">{{ p.unit }}</span>
                    @if (p.factor > 1) { <span class="rr-cant-b">= {{ fmt(p.base_qty) }} piezas</span> }
                  </div>

                  @if (menosDe() === p.product_id) {
                    <div class="rr-menos">
                      <label class="rr-l" [for]="'rr-q-' + p.product_id">Encontré</label>
                      <div class="rr-contador">
                        <button type="button" class="rr-paso" [disabled]="borrador() <= 0" (click)="paso(p, -1)" aria-label="Uno menos">
                          <i class="pi pi-minus" aria-hidden="true"></i>
                        </button>
                        <input [id]="'rr-q-' + p.product_id" class="rr-q" type="number" min="0" [attr.max]="p.qty"
                               [attr.step]="decimales(p) ? 'any' : 1" [attr.inputmode]="decimales(p) ? 'decimal' : 'numeric'"
                               [ngModel]="borrador()" (ngModelChange)="teclear(p, $event)"
                               (keydown.enter)="guardarMenos(p)" (keydown.escape)="cerrarMenos()"
                               (wheel)="$any($event.target).blur()" autocomplete="off" />
                        <button type="button" class="rr-paso" [disabled]="borrador() >= p.qty" (click)="paso(p, 1)" aria-label="Uno más">
                          <i class="pi pi-plus" aria-hidden="true"></i>
                        </button>
                      </div>
                      <p class="rr-de">de {{ cantidadTexto(p.qty, p.unit) }}</p>
                      <div class="rr-menos-acc">
                        <button pButton type="button" severity="secondary" [outlined]="true" class="rr-tap" (click)="cerrarMenos()">Cancelar</button>
                        <button pButton type="button" class="rr-tap" (click)="guardarMenos(p)">Guardar {{ cantidadTexto(borrador(), p.unit) }}</button>
                      </div>
                    </div>
                  } @else {
                    <div class="rr-acc">
                      <button type="button" class="rr-btn rr-btn-ok" [id]="'rr-tome-' + p.product_id" (click)="tome(p)">
                        <i class="pi pi-check" aria-hidden="true"></i><span>Lo tomé</span>
                      </button>
                      <button type="button" class="rr-btn rr-btn-menos" (click)="abrirMenos(p)">
                        <i class="pi pi-minus-circle" aria-hidden="true"></i><span>Hay menos</span>
                      </button>
                    </div>
                  }
                </article>
              } @else if (tomado(p) != null) {
                <button type="button" class="rr-linea rr-hecho" [class.rr-hecho-menos]="tomado(p)! < p.qty"
                        [attr.aria-label]="'Corregir ' + p.product_name" (click)="elegir(p)">
                  <i class="pi pi-check" aria-hidden="true"></i>
                  <span class="rr-linea-n">{{ p.product_name }}</span>
                  <span class="rr-linea-q">{{ tomadoTexto(p) }}</span>
                </button>
              } @else {
                <button type="button" class="rr-linea" (click)="elegir(p)">
                  <span class="rr-linea-n">{{ p.product_name }}</span>
                  <span class="rr-linea-q">{{ cantidadTexto(p.qty, p.unit) }}</span>
                </button>
              }
            }
          }

          <footer class="rr-pie">
            @if (errorTerminar()) {
              <p class="rr-pie-err" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                {{ errorTerminar() }} Lo que marcaste sigue guardado; vuelve a intentar.
              </p>
            }
            <p class="rr-pie-n">
              @if (faltan()) { <span class="rr-pend">{{ plural(faltan(), 'producto sin marcar', 'productos sin marcar') }}</span> }
              @else { <span class="rr-pend rr-pend-cero">Todo marcado</span> }
            </p>
            <button type="button" class="rr-btn rr-btn-go rr-btn-fin" [disabled]="faltan() > 0 || terminando()" (click)="terminar()">
              <i class="pi" [class.pi-box]="!terminando()" [class.pi-spin]="terminando()" [class.pi-spinner]="terminando()" aria-hidden="true"></i>
              <span>Ya junté todo</span>
            </button>
          </footer>
        }

        <!-- ─────────── REPARTIR ─────────── -->
        @if (fase() === 'repartir') {
          <app-metric-strip mode="bullet" density="compact" ariaLabel="Avance del reparto" [items]="avanceReparto()"></app-metric-strip>

          <!-- [MCP.3.6] En pantalla ancha los pedidos van en rejilla; en el celular, uno debajo de otro. -->
          <div class="rr-pedidos">
          @for (b of conMercancia(); track b.order_id; let i = $index) {
            @if (lista(b)) {
              <button type="button" class="rr-linea rr-hecho" [attr.aria-label]="'Reabrir pedido ' + (i + 1)" (click)="reabrir(b)">
                <i class="pi pi-check" aria-hidden="true"></i>
                <span class="rr-linea-n">Pedido {{ i + 1 }} · {{ b.customer_name || 'Cliente sin nombre' }}</span>
                <span class="rr-linea-q">Listo</span>
              </button>
            } @else {
              <article class="rr-bolsa" [attr.data-pedido]="b.order_id">
                <div class="rr-bolsa-top">
                  <h2 class="rr-bolsa-h">Pedido {{ i + 1 }} · {{ b.customer_name || 'Cliente sin nombre' }}</h2>
                  <span class="rr-sku">{{ b.code }}</span>
                </div>
                @if (textoParte(b); as tp) { <span class="rr-parte">{{ tp }}</span> }
                @for (l of b.lines; track $index) {
                  <div class="rr-bl" [class.rr-bl-falta]="falto(l)">
                    <span class="rr-bl-n">{{ l.product_name }}</span>
                    <span class="rr-bl-q"><b>{{ fmt(l.picked) }}</b> {{ l.unit }}</span>
                    @if (falto(l)) {
                      <span class="rr-bl-aviso">
                        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                        Pidió {{ cantidadTexto(l.ordered, l.unit) }}; no alcanzó. {{ vendedora() }} ya tiene el aviso.
                      </span>
                    }
                  </div>
                }
                <button type="button" class="rr-btn rr-btn-ok rr-btn-bolsa" (click)="bolsaLista(b)">
                  <i class="pi pi-check" aria-hidden="true"></i><span>Pedido listo</span>
                </button>
              </article>
            }
          }

          @for (b of sinMercancia(); track b.order_id) {
            <article class="rr-bolsa rr-bolsa-vacia" [attr.data-pedido]="b.order_id">
              <div class="rr-bolsa-top">
                <h2 class="rr-bolsa-h">{{ b.customer_name || 'Cliente sin nombre' }}</h2>
                <span class="rr-sku">{{ b.code }}</span>
              </div>
              @if (textoParte(b); as tp) { <span class="rr-parte">{{ tp }}</span> }
              <p class="rr-bl-aviso">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                No hubo nada de este pedido: avísale a {{ vendedora() }} para cancelarlo.
              </p>
            </article>
          }
          </div>

          <footer class="rr-pie">
            <p class="rr-pie-n">
              @if (bolsasPendientes()) { <span class="rr-pend">{{ plural(bolsasPendientes(), 'pedido por armar', 'pedidos por armar') }}</span> }
              @else { <span class="rr-pend rr-pend-cero">Todos los pedidos listos</span> }
            </p>
            <button type="button" class="rr-btn rr-btn-go rr-btn-fin" [disabled]="bolsasPendientes() > 0" (click)="terminarReparto()">
              <i class="pi pi-check-circle" aria-hidden="true"></i><span>Terminé · lista para la caja</span>
            </button>
          </footer>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    /* Centrada: en escritorio no se queda pegada a la izquierda con media pantalla vacía. */
    .rr-page { max-width: 46rem; margin-inline: auto; }
    .rr-page-ancha { max-width: 80rem; }
    .rr-pedidos { display: grid; gap: var(--sp-3); align-items: start;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); }
    .rr-pedidos > .rr-bolsa, .rr-pedidos > .rr-linea { margin: 0; }
    /* Embebida a la mitad (pantalla partida) o en un teléfono angosto: los dos botones se apilan. */
    .rr-page { container-type: inline-size; }
    @container (max-width: 22rem) {
      .rr-acc { grid-template-columns: 1fr; }
      .rr-contador { grid-template-columns: 3.25rem 1fr 3.25rem; }
    }
    .rr-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .rr-tap { min-height: var(--tap-min); }

    .rr-top { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-2); }
    .rr-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .rr-h1 { margin: 0; font-size: var(--fs-h3); font-weight: 800; line-height: 1.2; }

    .rr-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg);
      padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
    .rr-bloqueo { text-align: center; align-items: center; }
    .rr-bloqueo > i { font-size: var(--fs-display); color: var(--text-muted); }
    .rr-bloqueo h2 { margin: 0; font-size: var(--fs-h2); }
    .rr-bloqueo p { margin: 0; color: var(--text-muted); font-size: var(--fs-body); }
    .rr-bloqueo .rr-btn { align-self: stretch; }

    .rr-marca { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .04em; }

    /* El producto de ahora: lo único grande en la pantalla. */
    .rr-actual { background: var(--card-bg); border: 2px solid var(--action); border-radius: var(--r-lg);
      padding: var(--sp-3); margin-bottom: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-2); }
    .rr-prod { display: flex; flex-direction: column; }
    .rr-prod strong { font-size: var(--fs-lg); line-height: 1.15; }
    .rr-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-cant { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--sp-2); }
    .rr-cant-n { font-size: var(--fs-display); font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
    .rr-cant-u { font-size: var(--fs-h2); font-weight: 800; }
    .rr-cant-b { font-size: var(--fs-body); color: var(--text-muted); font-variant-numeric: tabular-nums; }

    .rr-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-1);
      min-height: 4.25rem; border-radius: var(--r-lg); border: 2px solid transparent; cursor: pointer;
      font-size: var(--fs-lg); font-weight: 800; transition: transform var(--dur-micro) ease; }
    .rr-btn i { font-size: var(--fs-h2); }
    .rr-btn:not(:disabled):active { transform: scale(.98); }
    .rr-btn:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    .rr-btn:disabled { cursor: not-allowed; }
    .rr-btn-go { background: var(--action); color: var(--action-ink); font-size: var(--fs-h2); }
    .rr-btn-go:not(:disabled):hover { background: var(--action-hover); }
    /* Apagado se ve gris, no naranja tenue: el naranja al 55% se leía como "listo para tocar". */
    .rr-btn-go:disabled { background: var(--border-color); color: var(--text-muted); }
    .rr-btn-ok { background: var(--ok-soft-bg); color: var(--ok-fg); border-color: var(--ok-fg); }
    .rr-btn-menos { background: var(--card-bg); color: var(--text-main); border-color: var(--border-color); }
    .rr-acc { display: grid; grid-template-columns: 2fr 1fr; gap: var(--sp-2); }

    .rr-menos { display: flex; flex-direction: column; align-items: stretch; gap: var(--sp-2); }
    .rr-l { font-size: var(--fs-body); font-weight: 700; text-align: center; }
    .rr-contador { display: grid; grid-template-columns: 4rem 1fr 4rem; gap: var(--sp-2); align-items: stretch; }
    .rr-paso { min-height: 4rem; border-radius: var(--r-md); border: 2px solid var(--border-color); background: var(--card-bg);
      color: var(--text-main); font-size: var(--fs-h2); cursor: pointer; }
    .rr-paso:disabled { color: var(--text-faint); cursor: not-allowed; }
    .rr-paso:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    .rr-q { min-width: 0; text-align: center; font-size: var(--fs-display); font-weight: 900; font-variant-numeric: tabular-nums;
      border: 2px solid var(--action); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); }
    .rr-q:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .rr-de { margin: 0; text-align: center; font-size: var(--fs-body); color: var(--text-muted); }
    .rr-menos-acc { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }

    /* Pendientes y recolectados: una línea en su lugar (la lista no se mueve bajo el dedo). */
    .rr-linea { width: 100%; display: flex; align-items: center; gap: var(--sp-2); min-height: var(--tap-min);
      padding: var(--sp-1) var(--sp-3); margin-bottom: var(--sp-1); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main); border: 1px solid var(--border-color); border-radius: var(--r-sm);
      font-size: var(--fs-body); }
    .rr-linea:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
    /* [MCP.3.6] El surtidor identifica el producto por el nombre: se lee completo (hasta 2 renglones), no «…». */
    .rr-linea-n { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.25;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .rr-linea-q { font-variant-numeric: tabular-nums; font-weight: 700; white-space: nowrap; }
    .rr-hecho { border-left: 4px solid var(--ok-fg); color: var(--text-muted); }
    .rr-hecho > i { color: var(--ok-fg); }
    .rr-hecho-menos { border-left-color: var(--warn-fg); }
    .rr-hecho-menos .rr-linea-q { color: var(--warn-fg); }

    .rr-bolsa { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg);
      padding: var(--sp-3); margin: var(--sp-2) 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .rr-bolsa-vacia { border-left: 4px solid var(--bad-fg); }
    .rr-bolsa-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .rr-bolsa-h { margin: 0; font-size: var(--fs-lg); line-height: 1.2; }
    .rr-bl { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 0 var(--sp-2);
      padding: var(--sp-1) 0; border-top: 1px solid var(--border-color); }
    .rr-bl-n { font-size: var(--fs-body); }
    .rr-bl-q { font-size: var(--fs-body); white-space: nowrap; }
    .rr-bl-q b { font-size: var(--fs-h2); font-weight: 900; font-variant-numeric: tabular-nums; }
    .rr-bl-falta .rr-bl-n, .rr-bl-falta .rr-bl-q { color: var(--bad-fg); }
    .rr-bl-aviso { grid-column: 1 / -1; display: flex; gap: var(--sp-1); align-items: flex-start; margin: 0;
      color: var(--bad-fg); font-size: var(--fs-body); font-weight: 600; }
    .rr-btn-bolsa { min-height: 3.5rem; flex-direction: row; gap: var(--sp-2); }
    /* [MCP.3.13] Pedido agrupado: discreto, informa que otra sucursal surte el resto. */
    .rr-parte { margin: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }

    .rr-pie { position: sticky; bottom: 0; z-index: 5; display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-4);
      padding: var(--sp-2) 0 calc(var(--sp-2) + env(safe-area-inset-bottom));
      background: var(--surface-ground, var(--card-bg)); border-top: 1px solid var(--border-color); }
    .rr-pie-n { margin: 0; font-size: var(--fs-body); color: var(--text-muted); text-align: center; }
    .rr-pie-err { margin: 0; display: flex; gap: var(--sp-1); color: var(--bad-fg); font-size: var(--fs-body); font-weight: 600; }
    .rr-pend { font-weight: 800; color: var(--warn-fg); font-variant-numeric: tabular-nums; }
    .rr-pend-cero { color: var(--ok-fg); }
    .rr-btn-fin { min-height: 3.5rem; flex-direction: row; gap: var(--sp-2); white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) {
      .rr-btn { transition: none; }
      .rr-btn:not(:disabled):active { transform: none; }
    }
  `],
})
export class AlmacenSurtirRutaComponent implements OnInit {
  private readonly api = inject(PresalePickingService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly ruta = inject(ActivatedRoute);

  readonly plural = plural;
  readonly fmt = fmtCantidad;
  /** [MCP.3.13] «Parte de P-10482 · también surte PH» en cada bolsa; suelto → null. */
  readonly textoParte = textoParte;

  private id = '';
  readonly fase = signal<Fase>('cargando');
  readonly error = signal<string | null>(null);
  readonly bloqueo = signal<{ titulo: string; texto: string } | null>(null);
  readonly route = signal<RouteBatchRow | null>(null);
  readonly cargadoAl = signal<number | null>(null);
  readonly anuncio = signal('');

  // ── Recolectar ──
  readonly productos = signal<RouteBatchProduct[]>([]);
  /** product_id → cantidad encontrada, en la unidad del producto. */
  readonly recolectado = signal<Record<string, number>>({});
  /** Producto elegido a mano (para corregir o adelantarlo); null = el primero sin marcar. */
  readonly elegido = signal<string | null>(null);
  /** Producto con el contador «Hay menos» abierto. */
  readonly menosDe = signal<string | null>(null);
  readonly borrador = signal(0);
  readonly terminando = signal(false);
  readonly errorTerminar = signal<string | null>(null);

  // ── Repartir ──
  readonly bags = signal<RouteBatchBag[]>([]);
  readonly listas = signal<ReadonlySet<string>>(new Set());

  readonly titulo = computed(() => {
    const r = this.route();
    const n = r ? nombreRuta(r) : 'Ruta';
    if (this.fase() === 'repartir') return `Repartir · ${n}`;
    if (this.fase() === 'recolectar') return `Recolectar · ${n}`;
    return n;
  });
  readonly vendedora = computed(() => this.route()?.seller_name || 'La vendedora');
  /** [MCP.3.13] Otras sucursales que surten partes de esta ruta; null si ninguna. */
  readonly otrasSucursales = computed(() => {
    const r = this.route();
    return r ? textoOtrasSucursales(r) : null;
  });
  readonly grupos = computed(() => agruparPorMarca(this.productos()));
  readonly hechos = computed(() => {
    const m = this.recolectado();
    return this.productos().filter((p) => m[p.product_id] != null).length;
  });
  readonly faltan = computed(() => this.productos().length - this.hechos());
  readonly actual = computed<RouteBatchProduct | null>(() => {
    const ps = this.productos();
    const m = this.recolectado();
    const e = this.elegido();
    return (e ? ps.find((p) => p.product_id === e) : undefined) ?? ps.find((p) => m[p.product_id] == null) ?? null;
  });
  readonly avanceRecolecta = computed<MetricStripItem[]>(() => {
    const total = this.productos().length;
    const h = this.hechos();
    return [{ label: 'Recolectado', value: `${h}/${total}`, format: 'text', pct: total ? (h / total) * 100 : 0, tone: h === total ? 'ok' : 'brand' }];
  });

  readonly conMercancia = computed(() => this.bags().filter((b) => b.outcome !== 'sin_mercancia'));
  readonly sinMercancia = computed(() => this.bags().filter((b) => b.outcome === 'sin_mercancia'));
  readonly bolsasListas = computed(() => this.conMercancia().filter((b) => this.listas().has(b.order_id)).length);
  readonly bolsasPendientes = computed(() => this.conMercancia().length - this.bolsasListas());
  readonly avanceReparto = computed<MetricStripItem[]>(() => {
    const total = this.conMercancia().length;
    const h = this.bolsasListas();
    return [{ label: 'Pedidos listos', value: `${h}/${total}`, format: 'text', pct: total ? (h / total) * 100 : 0, tone: h === total ? 'ok' : 'brand' }];
  });

  ngOnInit(): void {
    this.id = this.ruta.snapshot.paramMap.get('id') ?? '';
    // Ya recolectada en este celular (se recargó a media repartición): directo a Repartir.
    const g = leerJson<BolsasGuardadas>(PREF_RUTA_BOLSAS + this.id);
    if (g && Array.isArray(g.bags) && g.route) {
      this.route.set(g.route);
      this.bags.set(g.bags);
      this.listas.set(new Set(Array.isArray(g.listas) ? g.listas : []));
      this.fase.set('repartir');
      return;
    }
    this.cargarDetalle();
  }

  cargarDetalle(): void {
    this.error.set(null);
    this.fase.set('cargando');
    this.api.routeDetail(this.id).subscribe({
      next: (d) => this.decidir(d),
      error: (e) => {
        this.error.set(this.mensaje(e, 'Revisa la señal y vuelve a intentar.'));
        this.fase.set('bloqueada');
      },
    });
  }

  /** Qué hacer según en qué va la ruta: sólo quien la empezó la recolecta y la cierra. */
  private decidir(d: RouteBatchDetail): void {
    const r = d.route;
    this.route.set(r);
    this.cargadoAl.set(Date.now());
    switch (r.state) {
      case 'lista':
        // Llegó directo (sin pasar por «Empezar»): se arranca aquí para que quede a su nombre.
        this.api.routeStart(this.id).subscribe({
          next: () => this.abrir(d),
          error: (e) => this.bloquear('No se pudo empezar la ruta', this.mensaje(e, 'Vuelve a Surtir e inténtalo otra vez.')),
        });
        return;
      case 'surtiendo':
        if (this.esMia(r)) this.abrir(d);
        else this.bloquear(
          'Esta ruta la está recolectando otra persona',
          `${r.pick_started?.name || 'Alguien más'} la empezó${r.pick_started?.at ? ' a las ' + horaMx(r.pick_started.at) : ''}. Sólo esa persona la puede cerrar.`,
        );
        return;
      case 'en_ruta':
        this.bloquear('El vendedor sigue en ruta', 'Te llega la lista cuando finalice.');
        return;
      case 'surtida':
        this.bloquear(
          'Esta ruta ya se surtió',
          `La surtió ${r.pick_finished?.name || 'alguien sin nombre'}${r.pick_finished?.at ? ' a las ' + horaMx(r.pick_finished.at) : ''}.`,
        );
        return;
    }
  }

  private bloquear(titulo: string, texto: string): void {
    this.bloqueo.set({ titulo, texto });
    this.fase.set('bloqueada');
  }

  private abrir(d: RouteBatchDetail): void {
    const ps = productosUnicos(d.products ?? []);
    // Lo marcado antes de recargar, sólo de productos que siguen en la ruta y dentro de su rango.
    const guardado = leerJson<Record<string, number>>(PREF_RUTA_RECOLECTA + this.id) ?? {};
    const m: Record<string, number> = {};
    for (const p of ps) {
      if (guardado[p.product_id] != null) m[p.product_id] = acotarCantidad(guardado[p.product_id], p.qty, p.unit);
    }
    this.productos.set(ps);
    this.recolectado.set(m);
    this.elegido.set(null);
    this.menosDe.set(null);
    this.fase.set('recolectar');
    this.anuncio.set(`${plural(ps.length, 'producto', 'productos')} por recolectar.`);
  }

  esMia(r: RouteBatchRow): boolean {
    const yo = this.auth.user()?.sub;
    return !!yo && r.pick_started?.user_id === yo;
  }

  // ── Recolectar ──────────────────────────────────────────────────────────────────────────

  tomado(p: RouteBatchProduct): number | null {
    const v = this.recolectado()[p.product_id];
    return v == null ? null : v;
  }

  tomadoTexto(p: RouteBatchProduct): string {
    const v = this.tomado(p) ?? 0;
    return v < p.qty ? `${this.fmt(v)} de ${this.cantidadTexto(p.qty, p.unit)}` : this.cantidadTexto(p.qty, p.unit);
  }

  cantidadTexto(n: number, unit: string): string {
    return `${this.fmt(n)} ${unit ?? ''}`.trim();
  }

  decimales(p: RouteBatchProduct): boolean {
    return admiteDecimales(p.unit);
  }

  tome(p: RouteBatchProduct): void {
    this.marcar(p, p.qty);
  }

  elegir(p: RouteBatchProduct): void {
    this.menosDe.set(null);
    this.elegido.set(p.product_id);
    this.enfocar('rr-tome-' + p.product_id);
  }

  abrirMenos(p: RouteBatchProduct): void {
    this.borrador.set(acotarCantidad(this.tomado(p) ?? p.qty, p.qty, p.unit));
    this.menosDe.set(p.product_id);
    this.enfocar('rr-q-' + p.product_id);
  }

  cerrarMenos(): void {
    this.menosDe.set(null);
  }

  paso(p: RouteBatchProduct, d: number): void {
    this.borrador.set(acotarCantidad(this.borrador() + d, p.qty, p.unit));
  }

  /** Lo tecleado se acota al momento: no puede pasar de lo pedido ni bajar de cero. */
  teclear(p: RouteBatchProduct, v: unknown): void {
    this.borrador.set(acotarCantidad(v, p.qty, p.unit));
  }

  guardarMenos(p: RouteBatchProduct): void {
    this.marcar(p, acotarCantidad(this.borrador(), p.qty, p.unit));
  }

  private marcar(p: RouteBatchProduct, qty: number): void {
    const m = { ...this.recolectado(), [p.product_id]: qty };
    this.recolectado.set(m);
    guardarLocal(PREF_RUTA_RECOLECTA + this.id, JSON.stringify(m));
    this.menosDe.set(null);
    this.elegido.set(null);
    this.errorTerminar.set(null);
    this.anuncio.set(qty >= p.qty ? `${p.product_name}: completo.` : `${p.product_name}: ${this.fmt(qty)} de ${this.cantidadTexto(p.qty, p.unit)}.`);
    const sig = this.actual();
    if (sig) this.enfocar('rr-tome-' + sig.product_id);
  }

  /** «Ya junté todo»: manda cada producto una vez; si falla, lo marcado se queda y no se avanza. */
  terminar(): void {
    if (this.faltan() > 0 || this.terminando()) return;
    this.terminando.set(true);
    this.errorTerminar.set(null);
    this.api.routeFinish(this.id, cuerpoTerminar(this.productos(), this.recolectado())).subscribe({
      next: (r) => {
        this.terminando.set(false);
        const route = this.route();
        this.bags.set(r.bags ?? []);
        this.listas.set(new Set());
        if (route) this.guardarBolsas();
        guardarLocal(PREF_RUTA_RECOLECTA + this.id, '');
        this.fase.set('repartir');
        this.anuncio.set(`${plural(this.conMercancia().length, 'pedido', 'pedidos')} por armar.`);
        if (typeof window !== 'undefined') window.scrollTo?.({ top: 0 });
      },
      error: (e) => {
        this.terminando.set(false);
        this.errorTerminar.set(this.mensaje(e, 'No se pudo mandar lo recolectado.'));
      },
    });
  }

  // ── Repartir ────────────────────────────────────────────────────────────────────────────

  falto(l: RouteBatchBagLine): boolean {
    return Number(l.picked) < Number(l.ordered);
  }

  lista(b: RouteBatchBag): boolean {
    return this.listas().has(b.order_id);
  }

  bolsaLista(b: RouteBatchBag): void {
    this.listas.set(new Set([...this.listas(), b.order_id]));
    this.guardarBolsas();
    this.anuncio.set(`Pedido de ${b.customer_name || b.code} listo.`);
  }

  reabrir(b: RouteBatchBag): void {
    const s = new Set(this.listas());
    s.delete(b.order_id);
    this.listas.set(s);
    this.guardarBolsas();
  }

  terminarReparto(): void {
    if (this.bolsasPendientes() > 0) return;
    guardarLocal(PREF_RUTA_BOLSAS + this.id, '');
    guardarLocal(PREF_RUTA_RECOLECTA + this.id, '');
    this.salir();
  }

  private guardarBolsas(): void {
    const route = this.route();
    if (!route) return;
    const g: BolsasGuardadas = { route, bags: this.bags(), listas: [...this.listas()] };
    guardarLocal(PREF_RUTA_BOLSAS + this.id, JSON.stringify(g));
  }

  salir(): void {
    irConservandoPanel(this.router, '/almacen/surtir');
  }

  private enfocar(id: string): void {
    setTimeout(() => (document.getElementById(id) as HTMLElement | null)?.focus());
  }

  private mensaje(e: unknown, def: string): string {
    const m = (e as { error?: { message?: unknown } })?.error?.message;
    return typeof m === 'string' && m ? m : def;
  }
}
