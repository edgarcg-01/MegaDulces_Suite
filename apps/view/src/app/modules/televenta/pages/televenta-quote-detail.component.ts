import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageService } from 'primeng/api';
import { Subject, debounceTime, distinctUntilChanged, switchMap, catchError, of } from 'rxjs';
import { escalera, factorDe, type Presentacion } from '@megadulces/ui-web';
import {
  QuotesService,
  QuoteDetail,
  QuoteLine,
  QuoteCatalogRow,
  PricedLine,
  Rung,
} from '../quotes.service';

/**
 * `[COT.1b]` — El renglon de una cotizacion.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────────────────────
 * El motor de precio se entrego en COT.1 (`price-preview`, `POST /:id/lines`, `DELETE`) y
 * NINGUNA pantalla lo llamaba: hasta hoy una cotizacion solo se podia armar por HTTP directo.
 * Y la mesa era un callejon sin salida — `getOne` existia en el servicio y ninguna fila se
 * podia abrir.
 *
 * ── Lo que esta pantalla NO hace, a proposito ───────────────────────────────────────────────
 * ⛔ **No propone precio.** El body dice que y cuanto, nunca a cuanto: el vendedor no puede
 * inventar un descuento (decision de Direccion, 2026-09-22) y el endpoint ni siquiera acepta
 * `unit_price`. Por eso el buscador consulta `price-preview` y muestra el desglose ANTES de
 * agregar: el operador ve el precio, no lo escribe.
 *
 * ── La unidad ───────────────────────────────────────────────────────────────────────────────
 * El peldano (`base` | `pack` | `box`) cambia el precio, asi que se elige explicitamente y se
 * GUARDA con el renglon (sello `qty_unit`/`qty_factor`). La aritmetica es la misma de
 * `/vendor/take-order`, ahora compartida en `libs/ui-web` — no una segunda copia.
 *
 * Superficie Operations (DESIGN.md): tabla densa, sin ilustraciones, sin Fraunces.
 */

/** Los tres peldanos, con el rotulo que entiende una persona. */
const PELDANOS: Array<{ rung: Rung; label: string }> = [
  { rung: 'base', label: 'Pieza' },
  { rung: 'pack', label: 'Paquete' },
  { rung: 'box', label: 'Caja' },
];

/** Como se lee cada `price_source` del motor. El precio tiene que ser explicable. */
const FUENTE_LABEL: Record<string, string> = {
  list: 'Lista',
  customer_terms: 'Condiciones del cliente',
  volume_qty: 'Volumen',
  volume_amount: 'Volumen por monto',
  promo_qty: 'Promo por cantidad',
  promo_amount: 'Promo por monto',
  free_goods: 'Regalo del ERP',
  manual: 'Manual',
  unknown: 'Sin precio',
};

const FUENTE_TONO: Record<string, 'success' | 'info' | 'warn' | 'danger' | 'secondary'> = {
  list: 'secondary',
  volume_qty: 'info',
  volume_amount: 'info',
  promo_qty: 'success',
  promo_amount: 'success',
  free_goods: 'success',
  unknown: 'warn',
};

@Component({
  selector: 'app-televenta-quote-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    TableModule,
    TagModule,
    ToastModule,
    ProgressSpinnerModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast position="top-center"></p-toast>

    <section class="section">
      <a routerLink="/telemarketing/cotizaciones" class="back">
        <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a cotizaciones
      </a>

      @if (cargando()) {
        <div class="loading" aria-live="polite"><p-progressspinner styleClass="w-12 h-12"></p-progressspinner></div>
      } @else if (error()) {
        <div class="aviso aviso-bad" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ error() }}</span>
        </div>
      } @else if (cot(); as q) {
        <header class="section-header">
          <div class="head-row">
            <div>
              <h1>{{ q.code }}</h1>
              <p class="sub">{{ q.recipient_name }}</p>
            </div>
            <p-tag [value]="estadoLabel(q.status)" [severity]="estadoTono(q.status)"></p-tag>
          </div>
        </header>

        <!-- Las condiciones CONGELADAS. Un precio tiene que ser explicable, y estas son la
             mitad de la explicacion: el descuento del cliente entra sobre el subtotal. -->
        <div class="terms">
          <div class="t">
            <span class="t-lbl">Sucursal</span>
            <span class="t-val">{{ q.source_branch || '—' }}</span>
          </div>
          <div class="t">
            <span class="t-lbl">Descuento del cliente</span>
            @if (num(q.terms_discount_pct) !== null) {
              <span class="t-val t-strong">{{ num(q.terms_discount_pct) }}%</span>
            } @else {
              <!-- NULL no es 0%: el ERP no lo tiene configurado, que no es haber decidido no darlo. -->
              <span class="t-val t-none">sin configurar</span>
            }
          </div>
          <div class="t">
            <span class="t-lbl">Plazo</span>
            <span class="t-val">{{ q.terms_payment_days !== null ? q.terms_payment_days + ' dias' : '—' }}</span>
          </div>
          <div class="t">
            <span class="t-lbl">Vigencia</span>
            <span class="t-val" [class.vencida]="q.days_to_expiry < 0">{{ q.valid_until }}</span>
            <span class="t-sub">{{ vigenciaHint(q) }}</span>
          </div>
          <div class="t">
            <span class="t-lbl">Condiciones</span>
            <span class="t-val t-sm">{{ fuenteTerms(q.terms_source) }}</span>
          </div>
        </div>

        @if (!editable()) {
          <div class="aviso" role="note">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <span>
              Esta cotizacion esta <strong>{{ estadoLabel(q.status).toLowerCase() }}</strong>, asi que
              sus renglones ya no se tocan. Una cotizacion enviada que cambia es otra version, no la misma.
            </span>
          </div>
        }

        <!-- ── Agregar renglon ─────────────────────────────────────────────────────────── -->
        @if (editable()) {
          <div class="alta">
            <div class="alta-row">
              <label class="f f-sku">
                <span>Producto</span>
                <input
                  type="search"
                  class="input"
                  [(ngModel)]="termino"
                  (ngModelChange)="onTermino($event)"
                  (focus)="onFoco()"
                  placeholder="Nombre, SKU o codigo de barras..."
                  autocorrect="off"
                  spellcheck="false"
                  [disabled]="guardando()"
                />
              </label>
              <label class="f f-qty">
                <span>Cantidad</span>
                <input
                  type="number"
                  class="input num"
                  [(ngModel)]="cantidad"
                  (ngModelChange)="onCantidad()"
                  min="1"
                  step="1"
                  inputmode="numeric"
                  [disabled]="guardando()"
                />
              </label>
              <div class="f f-rung">
                <span>Presentacion</span>
                <div class="chips" role="group" aria-label="Presentacion">
                  @for (p of peldanos; track p.rung) {
                    <button
                      type="button"
                      class="chip"
                      [class.chip-active]="rung() === p.rung"
                      [attr.aria-pressed]="rung() === p.rung"
                      [disabled]="guardando()"
                      (click)="setRung(p.rung)"
                    >{{ p.label }}</button>
                  }
                </div>
              </div>
            </div>

            <!-- El catalogo de la sucursal. Solo sale lo que ESA plaza puede cotizar: si saliera
                 el catalogo entero, el operador elegiria un producto y recien despues se comeria
                 un "el ERP no publica precio aca". -->
            @if (buscando()) {
              <p class="hint"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando en la sucursal {{ cot()?.source_branch }}...</p>
            } @else if (catalogoAbierto() && resultados().length > 0) {
              <ul class="cat" role="listbox" aria-label="Productos de la sucursal">
                @for (p of resultados(); track p.sku) {
                  <li>
                    <button
                      type="button"
                      class="cat-row"
                      role="option"
                      [attr.aria-selected]="elegido()?.sku === p.sku"
                      [class.cat-row-active]="elegido()?.sku === p.sku"
                      (click)="elegir(p)"
                    >
                      <span class="cat-nom">
                        {{ p.name || p.sku }}
                        @if (p.content) { <span class="cat-cont">{{ p.content }}</span> }
                      </span>
                      <span class="cat-meta">
                        <span class="cat-sku">{{ p.sku }}</span>
                        @if (p.barcode) { <span class="cat-bc">{{ p.barcode }}</span> }
                        @if (p.unit_base) { <span class="cat-un">{{ p.unit_base }}</span> }
                      </span>
                      <!-- Precio de LISTA, para reconocer el producto. El que vale es el de la
                           previa, que ya trae cantidad, peldano y descuentos. -->
                      <span class="cat-precio">{{ dinero(p.piece_price) }}</span>
                    </button>
                  </li>
                }
              </ul>
            } @else if (catalogoAbierto() && termino.trim().length > 0) {
              <p class="hint">
                Ningun producto de la sucursal {{ cot()?.source_branch }} casa con
                <strong>{{ termino }}</strong>. Si el cliente lo pidio igual, guardalo como no casado:
                queda como demanda, no se pierde.
              </p>
            }

            @if (elegido(); as e) {
              <p class="elegido">
                <i class="pi pi-check-circle" aria-hidden="true"></i>
                <strong>{{ e.name || e.sku }}</strong>
                <span class="cat-sku">{{ e.sku }}</span>
                <button type="button" class="linkish" (click)="limpiarEleccion()">cambiar</button>
              </p>
            }

            <!-- El precio ANTES de agregar, con su desglose. Es lo que evita que el operador
                 tenga que confiar en un numero sin origen. -->
            @if (cotizando()) {
              <p class="hint"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Consultando el precio del ERP...</p>
            } @else if (previa(); as p) {
              <div class="previa" [class.previa-bad]="p.unit_price === null">
                <div class="p-head">
                  <span class="p-name">{{ p.name || p.sku }}</span>
                  @if (p.unit_price !== null) {
                    <span class="p-price">{{ p.unit_price | currency:'MXN':'symbol-narrow':'1.2-4' }}
                      <span class="p-unit">/ {{ p.unit_label || 'u' }}</span>
                    </span>
                  } @else {
                    <!-- NULL, nunca $0: un cero se leeria como "no cuesta nada" (ADR-056). -->
                    <span class="p-price p-none">sin precio</span>
                  }
                </div>
                @if (p.unpriced_reason) {
                  <p class="p-why p-why-bad">{{ p.unpriced_reason }}</p>
                }
                @for (s of p.applied; track s.step) {
                  <p class="p-why">
                    <strong>{{ s.step }}</strong> — {{ s.detail }}
                    @if (s.before !== null && s.after !== null && s.before !== s.after) {
                      <span class="p-delta">{{ s.before | currency:'MXN':'symbol-narrow':'1.2-2' }}
                        → {{ s.after | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                    }
                  </p>
                }
                @if (p.free_goods) {
                  <p class="p-why p-why-ok">
                    <i class="pi pi-gift" aria-hidden="true"></i>
                    Se regalan {{ p.free_goods.quantity }} de {{ p.free_goods.sku }} — nace como renglon propio.
                  </p>
                }
                @for (w of p.warnings; track w) { <p class="p-why p-why-warn">{{ w }}</p> }
                @for (na of p.not_applied; track na.mechanism) {
                  <p class="p-why p-why-muted">{{ na.mechanism }}: {{ na.reason }}</p>
                }
              </div>
            } @else if (elegido() && !cotizando()) {
              <p class="hint">Sin previa todavia.</p>
            }

            <div class="alta-acc">
              <button pButton [disabled]="!puedeAgregar() || guardando()" (click)="agregar()">
                <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
                <span class="p-button-label">Agregar renglon</span>
              </button>
              <button
                pButton
                severity="secondary"
                [outlined]="true"
                [disabled]="!termino.trim() || guardando()"
                (click)="agregarSinCasar()"
              >
                <span class="p-button-label">Guardar como no casado</span>
              </button>
              <span class="hint alta-hint">
                Lo que el cliente pidio y no manejamos <strong>no se borra</strong>: se guarda como demanda.
              </span>
            </div>
          </div>
        }

        <!-- ── Los renglones ───────────────────────────────────────────────────────────── -->
        <div class="table-card">
          @if (!q.lines.length) {
            <div class="empty">
              <p class="empty-title">Esta cotizacion todavia no tiene renglones.</p>
              <p class="empty-hint">Agregá el primero con el SKU y la cantidad de arriba.</p>
            </div>
          } @else {
            <p-table [value]="q.lines" styleClass="p-datatable-sm" [tableStyle]="{ 'min-width': '64rem' }">
              <ng-template #header>
                <tr>
                  <th class="num">#</th>
                  <th>Producto</th>
                  <th>Presentacion</th>
                  <th class="num">Cantidad</th>
                  <th class="num">Lista</th>
                  <th class="num">Precio</th>
                  <th>De donde sale</th>
                  <th class="num">Importe</th>
                  <th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-l>
                <tr [class.row-gift]="l.parent_line_number !== null">
                  <td class="num mono">{{ l.line_number }}</td>
                  <td>
                    @if (l.parent_line_number !== null) {
                      <span class="gift"><i class="pi pi-gift" aria-hidden="true"></i> regalo del {{ l.parent_line_number }}</span>
                    }
                    <span class="p-name">{{ l.product_name || l.requested_text || '—' }}</span>
                    @if (!l.product_id) {
                      <!-- No es un error de captura: es demanda que estamos rechazando. -->
                      <span class="sin-casar">sin casar con el catalogo</span>
                    }
                  </td>
                  <td>
                    @if (l.qty_unit) {
                      {{ l.qty_unit }}
                      @if (num(l.qty_factor)) { <span class="factor">x{{ num(l.qty_factor) }}</span> }
                    } @else {
                      <!-- NULL no es pieza: es "no se registro" (VU.0). -->
                      <span class="t-none">sin registrar</span>
                    }
                  </td>
                  <td class="num">
                    @if (editable() && l.parent_line_number === null) {
                      <input
                        type="number"
                        class="input num qty-inline"
                        [ngModel]="num(l.quantity)"
                        (ngModelChange)="pedirCambio(l, $event)"
                        min="1"
                        step="1"
                        inputmode="numeric"
                        [disabled]="guardando()"
                        [attr.aria-label]="'Cantidad del renglon ' + l.line_number"
                      />
                    } @else {
                      {{ num(l.quantity) }}
                    }
                  </td>
                  <td class="num muted">{{ dinero(l.list_price) }}</td>
                  <td class="num">
                    @if (num(l.unit_price) !== null) {
                      {{ num(l.unit_price) | currency:'MXN':'symbol-narrow':'1.2-4' }}
                    } @else {
                      <span class="t-none">sin precio</span>
                    }
                  </td>
                  <td>
                    <p-tag [value]="fuenteLabel(l.price_source)" [severity]="fuenteTono(l.price_source)"></p-tag>
                    @if (num(l.discount_pct)) { <span class="dto">−{{ num(l.discount_pct) }}%</span> }
                  </td>
                  <td class="num">{{ num(l.line_total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="num">
                    @if (editable() && l.parent_line_number === null) {
                      <button
                        pButton
                        severity="danger"
                        [text]="true"
                        size="small"
                        [disabled]="guardando()"
                        (click)="quitar(l)"
                        [attr.aria-label]="'Quitar el renglon ' + l.line_number"
                      ><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button>
                    }
                  </td>
                </tr>
              </ng-template>
            </p-table>

            <!-- Los totales salen del SERVIDOR. Recalcularlos aca seria inventar el numero: el
                 descuento del cliente entra sobre el subtotal, no sobre el precio unitario. -->
            <div class="totales">
              <div class="tot"><span>Subtotal</span><b>{{ num(q.subtotal) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              <div class="tot"><span>Impuestos</span><b>{{ num(q.tax_total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              <div class="tot tot-big"><span>Total</span><b>{{ num(q.total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              @if (num(q.terms_discount_pct)) {
                <p class="tot-nota">
                  Incluye el {{ num(q.terms_discount_pct) }}% del cliente, aplicado sobre el subtotal —
                  no sobre el precio de cada renglon.
                </p>
              }
            </div>
          }
        </div>

        <!-- Lo que el cliente mando, tal cual. Es la evidencia de que se le cotizo lo que pidio. -->
        @if (q.customer_request) {
          <div class="cruda">
            <p class="cruda-lbl">La lista del cliente, como llego</p>
            <pre>{{ q.customer_request }}</pre>
          </div>
        }
      }
    </section>
  `,
  styles: [
    `
      .section { padding: 1.25rem; max-width: 1100px; margin: 0 auto; }
      .back { display: inline-flex; gap: 0.35rem; align-items: center; font-size: 0.8125rem; color: var(--text-muted); text-decoration: none; margin-bottom: 0.75rem; }
      .back:hover { color: var(--text-main); }
      .back:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 4px; }
      .head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
      .section-header h1 { font-size: 1.35rem; font-weight: 700; margin: 0; font-family: var(--font-mono, monospace); }
      .sub { color: var(--text-muted); font-size: 0.9375rem; margin: 0.15rem 0 0; }

      .loading { display: flex; justify-content: center; padding: 3rem 0; }
      .aviso { display: flex; gap: 0.5rem; align-items: flex-start; margin: 1rem 0; padding: 0.7rem 0.9rem;
               border: 1px solid var(--border-color); border-left-width: 3px; border-radius: 8px;
               background: var(--card-bg); font-size: 0.8125rem; color: var(--text-muted); }
      .aviso i { color: var(--action); margin-top: 0.1rem; }
      .aviso-bad { border-left-color: var(--bad-fg); }
      .aviso-bad i { color: var(--bad-fg); }

      .terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.6rem; margin: 1rem 0; }
      .t { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.6rem 0.8rem;
           display: flex; flex-direction: column; gap: 0.1rem; }
      .t-lbl { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
      .t-val { font-size: 0.9375rem; font-variant-numeric: tabular-nums; }
      .t-val.t-sm { font-size: 0.8125rem; }
      .t-strong { font-weight: 700; color: var(--action); }
      .t-none { font-style: italic; color: var(--text-muted); font-size: 0.8125rem; }
      .t-sub { font-size: 0.7rem; color: var(--text-muted); }
      .vencida { color: var(--bad-fg); font-weight: 600; }

      .alta { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
      .alta-row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
      .f { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; }
      .f > span { color: var(--text-muted); }
      .f-sku { flex: 1 1 16rem; }
      .f-qty { flex: 0 0 8rem; }
      .input { width: 100%; padding: 0.45rem 0.7rem; box-sizing: border-box; border: 1px solid var(--border-color);
               border-radius: 6px; font-size: 0.875rem; background: var(--card-bg); color: var(--text-main); min-height: 36px; }
      .input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
      .input.num { text-align: right; font-variant-numeric: tabular-nums; }
      .qty-inline { width: 6rem; min-height: 30px; padding: 0.2rem 0.4rem; }

      /* [COT.1c] El catalogo de la sucursal. Lista densa (superficie Operations): lo que
         importa es barrerla rapido, no que cada renglon sea una tarjeta.
         NO poner acentos graves aca: cierran el template literal y rompen el build. */
      .cat { list-style: none; margin: 0.6rem 0 0; padding: 0; max-height: 17rem; overflow-y: auto;
             border: 1px solid var(--border-color); border-radius: 6px; background: var(--card-bg); }
      .cat li + li { border-top: 1px solid var(--border-color); }
      .cat-row { width: 100%; display: flex; align-items: baseline; gap: 0.75rem; text-align: left;
                 padding: 0.45rem 0.7rem; background: none; border: 0; cursor: pointer;
                 color: var(--text-main); font-size: 0.8125rem; }
      .cat-row:hover { background: var(--hover-bg); }
      .cat-row:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
      .cat-row-active { background: var(--hover-bg); }
      .cat-nom { flex: 1 1 auto; min-width: 0; }
      .cat-cont { margin-left: 0.4rem; color: var(--text-muted); }
      .cat-meta { flex: 0 0 auto; display: flex; gap: 0.5rem; color: var(--text-muted); font-size: 0.75rem; }
      .cat-sku { font-family: var(--font-mono, monospace); }
      .cat-bc { font-variant-numeric: tabular-nums; }
      .cat-un { text-transform: uppercase; letter-spacing: 0.04em; }
      .cat-precio { flex: 0 0 5.5rem; text-align: right; font-variant-numeric: tabular-nums; }

      .elegido { display: flex; align-items: center; gap: 0.5rem; margin: 0.6rem 0 0; font-size: 0.8125rem; }
      .linkish { background: none; border: 0; padding: 0; color: var(--action); cursor: pointer;
                 font-size: 0.8125rem; text-decoration: underline; }
      .linkish:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

      .chips { display: flex; gap: 0.3rem; }
      .chip { border: 1px solid var(--border-color); background: var(--card-bg); border-radius: 9999px;
              padding: 0.35rem 0.8rem; font-size: 0.8125rem; cursor: pointer; color: var(--text-muted); min-height: 36px; }
      .chip:hover { background: var(--hover-bg); }
      .chip:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
      .chip-active { background: var(--action); border-color: var(--action); color: var(--action-ink); font-weight: 600; }

      .previa { margin-top: 0.85rem; padding: 0.7rem 0.9rem; border: 1px solid var(--border-color);
                border-left: 3px solid var(--ok-fg); border-radius: 8px; background: var(--surface-ground); }
      .previa-bad { border-left-color: var(--warn-fg); }
      .p-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
      .p-name { font-weight: 600; font-size: 0.9375rem; }
      .p-price { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; }
      .p-unit { font-size: 0.75rem; font-weight: 400; color: var(--text-muted); }
      .p-none { color: var(--warn-fg); font-style: italic; font-size: 0.875rem; font-weight: 600; }
      .p-why { margin: 0.3rem 0 0; font-size: 0.75rem; color: var(--text-muted); }
      .p-why-ok { color: var(--ok-fg); }
      .p-why-warn { color: var(--warn-fg); }
      .p-why-bad { color: var(--bad-fg); }
      .p-why-muted { opacity: 0.75; }
      .p-delta { margin-left: 0.35rem; font-variant-numeric: tabular-nums; }

      .alta-acc { display: flex; gap: 0.6rem; align-items: center; margin-top: 0.85rem; flex-wrap: wrap; }
      .alta-hint { flex: 1 1 14rem; }
      .hint { font-size: 0.75rem; color: var(--text-muted); margin: 0.4rem 0 0; }

      .table-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow-x: auto; }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); }
      .muted { color: var(--text-muted); }
      .row-gift { background: var(--surface-ground); }
      .gift { display: block; font-size: 0.7rem; color: var(--ok-fg); }
      .sin-casar { display: block; font-size: 0.7rem; color: var(--warn-fg); }
      .factor { margin-left: 0.25rem; font-size: 0.7rem; color: var(--text-muted); }
      .dto { display: block; font-size: 0.7rem; color: var(--ok-fg); }

      .totales { border-top: 1px solid var(--border-color); padding: 0.75rem 1rem; display: flex;
                 flex-direction: column; gap: 0.2rem; align-items: flex-end; }
      .tot { display: flex; gap: 1.5rem; font-size: 0.8125rem; color: var(--text-muted); }
      .tot b { color: var(--text-main); font-variant-numeric: tabular-nums; min-width: 7rem; text-align: right; }
      .tot-big { font-size: 1rem; }
      .tot-big b { font-weight: 700; }
      .tot-nota { margin: 0.4rem 0 0; font-size: 0.7rem; color: var(--text-muted); max-width: 44ch; text-align: right; }

      .empty { padding: 2.5rem 1rem; text-align: center; }
      .empty-title { margin: 0 0 0.35rem; font-weight: 600; }
      .empty-hint { margin: 0; font-size: 0.8125rem; color: var(--text-muted); }

      .cruda { margin-top: 1rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.8rem 1rem; }
      .cruda-lbl { margin: 0 0 0.4rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }
      .cruda pre { margin: 0; white-space: pre-wrap; font-family: var(--font-mono, monospace); font-size: 0.75rem; color: var(--text-muted); }

      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
                 clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    `,
  ],
})
export class TeleventaQuoteDetailComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly toast = inject(MessageService);
  private readonly route = inject(ActivatedRoute);

  readonly peldanos = PELDANOS;

  readonly cot = signal<QuoteDetail | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly cotizando = signal(false);
  readonly previa = signal<PricedLine | null>(null);
  readonly rung = signal<Rung>('base');

  /** `[COT.1c]` El catalogo de la sucursal. */
  readonly resultados = signal<QuoteCatalogRow[]>([]);
  readonly buscando = signal(false);
  readonly catalogoAbierto = signal(false);
  /** El producto ELEGIDO. La previa cuelga de esto, no del texto tecleado. */
  readonly elegido = signal<QuoteCatalogRow | null>(null);

  /** Lo que el operador teclea. Si no casa con nada, es el `requested_text` del renglon suelto. */
  termino = '';
  cantidad = 1;

  private id = '';
  private readonly previa$ = new Subject<void>();
  private readonly buscar$ = new Subject<void>();

  /** Sólo un borrador se edita. Una cotización enviada que cambia es otra versión, no la misma. */
  readonly editable = computed(() => this.cot()?.status === 'draft');

  /** Agregar exige que el motor haya podido cotizar: sin precio va por el otro botón, declarado. */
  readonly puedeAgregar = computed(() => !!this.previa() && this.previa()!.unit_price !== null);

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') || '';
    this.previa$
      .pipe(
        debounceTime(300),
        switchMap(() => {
          const q = this.cot();
          const sku = this.elegido()?.sku ?? '';
          const qty = Number(this.cantidad);
          if (!q?.source_branch || !sku || !Number.isFinite(qty) || qty <= 0) {
            this.cotizando.set(false);
            return of(null);
          }
          this.cotizando.set(true);
          return this.svc
            .pricePreview({ branch: q.source_branch, sku, quantity: qty, rung: this.rung() })
            .pipe(
              catchError((err) => {
                // Un 403 tragado en silencio se lee como "no hay precio" cuando es "no hay
                // permiso" (GOTCHAS §4). Se avisa.
                this.toast.add({
                  severity: err?.status === 403 ? 'warn' : 'error',
                  summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo cotizar',
                  detail: err?.error?.message || 'El motor de precio no respondio.',
                });
                return of(null);
              }),
            );
        }),
        distinctUntilChanged(),
      )
      .subscribe((p) => {
        this.previa.set(p);
        this.cotizando.set(false);
      });

    // `[COT.1c]` El buscador del catalogo. `switchMap` y no `mergeMap`: al teclear rapido, la
    // respuesta de un termino viejo llegando tarde pisaria la lista del termino actual.
    this.buscar$
      .pipe(
        debounceTime(250),
        switchMap(() => {
          const branch = this.cot()?.source_branch;
          if (!branch) {
            this.buscando.set(false);
            return of([] as QuoteCatalogRow[]);
          }
          this.buscando.set(true);
          return this.svc.searchCatalog(branch, this.termino.trim()).pipe(
            catchError((err) => {
              this.toast.add({
                severity: err?.status === 403 ? 'warn' : 'error',
                summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo buscar',
                detail: err?.error?.message || 'El catalogo de la sucursal no respondio.',
              });
              return of([] as QuoteCatalogRow[]);
            }),
          );
        }),
      )
      .subscribe((rows) => {
        this.resultados.set(rows);
        this.buscando.set(false);
        this.catalogoAbierto.set(true);

        // Lector de codigo de barras: manda el EAN completo y espera no tener que clickear.
        // ⛔ Solo auto-elige si la respuesta es UNA sola fila Y el termino es exactamente su SKU
        // o su codigo. Con dos candidatos elige el humano: resolver por "sku O barcode" a ciegas
        // es justo la ambiguedad que ya nos costo antes.
        const t = this.termino.trim();
        if (rows.length === 1 && t && (rows[0].sku.toUpperCase() === t.toUpperCase() || rows[0].barcode === t)) {
          this.elegir(rows[0]);
        }
      });

    this.recargar();
  }

  recargar(): void {
    this.cargando.set(true);
    this.svc.getOne(this.id).subscribe({
      next: (q) => {
        this.cot.set(q);
        this.error.set(null);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.error.set(
          err?.status === 404
            ? 'Esa cotizacion no existe o fue borrada.'
            : err?.error?.message || 'No se pudo abrir la cotizacion.',
        );
      },
    });
  }

  /**
   * Teclear busca en el catalogo; NO cotiza. La previa cuelga del producto elegido, porque
   * cotizar un texto a medio escribir seria pedirle precio a algo que todavia no es un producto.
   */
  onTermino(_v: string): void {
    this.elegido.set(null);
    this.previa.set(null);
    this.buscar$.next();
  }

  /** Entrar al campo sin escribir nada muestra los primeros N: el operador tambien hojea. */
  onFoco(): void {
    this.catalogoAbierto.set(true);
    if (this.resultados().length === 0) this.buscar$.next();
  }

  elegir(p: QuoteCatalogRow): void {
    this.elegido.set(p);
    this.catalogoAbierto.set(false);
    this.previa$.next();
  }

  limpiarEleccion(): void {
    this.elegido.set(null);
    this.previa.set(null);
    this.catalogoAbierto.set(true);
  }

  onCantidad(): void { this.previa$.next(); }
  setRung(r: Rung): void { this.rung.set(r); this.previa$.next(); }

  agregar(): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.svc
      .addLine(this.id, { sku: this.elegido()!.sku, quantity: Number(this.cantidad), rung: this.rung() })
      .subscribe({
        next: () => {
          this.limpiarAlta();
          this.recargar();
          this.guardando.set(false);
        },
        error: (err) => this.falla(err, 'No se pudo agregar el renglon'),
      });
  }

  /**
   * Guarda lo que el cliente pidió y NO manejamos. No es un error de captura: es demanda que
   * estamos rechazando, y desaparece si la tabla exige un producto del catálogo.
   */
  agregarSinCasar(): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.svc
      .addLine(this.id, { requested_text: this.termino.trim(), quantity: Number(this.cantidad) })
      .subscribe({
        next: () => {
          this.limpiarAlta();
          this.recargar();
          this.guardando.set(false);
        },
        error: (err) => this.falla(err, 'No se pudo guardar el renglon'),
      });
  }

  /**
   * Corrige la cantidad de un renglón guardado. Va por `PATCH`, que CONSERVA el
   * `line_number`: borrar y re-agregar mandaría el renglón al final y la cotización dejaría de
   * estar en el orden de la lista que mandó el cliente.
   */
  pedirCambio(l: QuoteLine, valor: number): void {
    const qty = Math.floor(Number(valor));
    if (!Number.isFinite(qty) || qty <= 0 || qty === this.numOr0(l.quantity)) return;
    this.guardando.set(true);
    this.svc.updateLine(this.id, l.id, { quantity: qty }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        // El motor vuelve a correr: si el precio se movio, se dice. Un precio que cambia solo
        // y en silencio es justo lo que hace sospechoso a un descuento.
        const p = r.priced;
        if (p && p.unit_price !== null && this.numOr0(l.unit_price) !== p.unit_price) {
          this.toast.add({
            severity: 'info',
            summary: 'El precio se movio',
            detail: `${p.name || p.sku}: ahora ${p.unit_price} (${this.fuenteLabel(p.price_source)}).`,
          });
        }
        this.recargar();
      },
      error: (err) => {
        this.falla(err, 'No se pudo cambiar la cantidad');
        this.recargar();
      },
    });
  }

  quitar(l: QuoteLine): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.svc.removeLine(this.id, l.id).subscribe({
      next: () => { this.guardando.set(false); this.recargar(); },
      error: (err) => this.falla(err, 'No se pudo quitar el renglon'),
    });
  }

  private limpiarAlta(): void {
    this.termino = '';
    this.cantidad = 1;
    this.previa.set(null);
    this.elegido.set(null);
    this.resultados.set([]);
    this.catalogoAbierto.set(false);
  }

  private falla(err: { status?: number; error?: { message?: string } }, summary: string): void {
    this.guardando.set(false);
    this.toast.add({
      severity: err?.status === 403 ? 'warn' : 'error',
      summary: err?.status === 403 ? 'Sin permiso' : summary,
      detail: err?.error?.message || 'Error de red.',
    });
  }

  // ── Formato ────────────────────────────────────────────────────────────────────────────────

  /**
   * ⚠️ Los `numeric` de Postgres llegan como STRING por JSON (GOTCHAS §6): el tipo de TS miente.
   * Devuelve `null` cuando no hay dato — **no 0**, que es una afirmación distinta.
   */
  num(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  private numOr0(v: number | string | null | undefined): number { return this.num(v) ?? 0; }

  /** El precio de lista se muestra sólo si existe: un guion dice más que un cero. */
  dinero(v: number | string | null | undefined): string {
    const n = this.num(v);
    return n === null ? '—' : n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  fuenteLabel(s: string): string { return FUENTE_LABEL[s] ?? s; }
  fuenteTono(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return FUENTE_TONO[s] ?? 'secondary';
  }

  fuenteTerms(s: string): string {
    if (s === 'kepler_kdud') return 'Congeladas del ERP';
    if (s === 'manual') return 'Capturadas a mano';
    return 'Sin registrar';
  }

  estadoLabel(s: string): string {
    const m: Record<string, string> = {
      draft: 'Borrador', sent: 'Enviada', accepted: 'Aceptada',
      rejected: 'Rechazada', expired: 'Vencida', cancelled: 'Cancelada',
    };
    return m[s] ?? s;
  }
  estadoTono(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    const m: Record<string, 'success' | 'info' | 'warn' | 'danger' | 'secondary'> = {
      draft: 'secondary', sent: 'info', accepted: 'success',
      rejected: 'danger', expired: 'warn', cancelled: 'secondary',
    };
    return m[s] ?? 'secondary';
  }

  vigenciaHint(q: QuoteDetail): string {
    if (q.status !== 'draft' && q.status !== 'sent') return '';
    if (q.days_to_expiry < 0) return `vencio hace ${Math.abs(q.days_to_expiry)} d`;
    if (q.days_to_expiry === 0) return 'vence hoy';
    return `en ${q.days_to_expiry} d`;
  }

  /**
   * ⚠️ Reservado para cuando el detalle publique la escalera del producto: la aritmética de
   * presentación ya está compartida en `libs/ui-web` (misma que usa take-order), así que el
   * selector no se vuelve a implementar. Hoy los tres peldaños son fijos porque es lo que el
   * motor acepta (`base` | `pack` | `box`).
   */
  protected escaleraDe(units: readonly Presentacion[] | null): Presentacion[] { return escalera(units); }
  protected factor(p: Presentacion | null): number { return factorDe(p); }
}
