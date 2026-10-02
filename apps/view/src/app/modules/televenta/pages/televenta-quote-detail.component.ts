import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
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
  nombreUnidadBase,
  abrevUnidadBase,
  opcionesUnidad,
  paqueteDeCaja,
  desglose,
  type OpcionUnidad,
  type PasoDesglose,
} from '../quotes.service';
import {
  exportQuotePdf,
  exportQuoteXlsx,
  type QuoteDeliverableData,
} from '../quote-deliverable-export';
import { branchName } from '../../../core/constants/store-branches';

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
            <div class="head-right-actions">
              <p-tag [value]="estadoLabel(q.status)" [severity]="estadoTono(q.status)"></p-tag>
              <button
                pButton
                severity="success"
                [outlined]="true"
                type="button"
                class="btn-export-xlsx"
                [disabled]="!q.lines.length || exportando()"
                (click)="descargarXlsx()"
                title="Descargar entregable en Excel (.xlsx)"
              >
                <span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span>
                <span class="p-button-label">Excel (.xlsx)</span>
              </button>
              <button
                pButton
                severity="danger"
                [outlined]="true"
                type="button"
                class="btn-export-pdf"
                [disabled]="!q.lines.length || exportando()"
                (click)="descargarPdf()"
                title="Descargar entregable formal en PDF"
              >
                <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>
                <span class="p-button-label">PDF</span>
              </button>
            </div>
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
          @if (vendedorAsignado(q); as vend) {
            <div class="t">
              <span class="t-lbl">Vendedor seguimiento</span>
              <span class="t-val t-strong">{{ vend }}</span>
            </div>
          }
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

        <!-- ── MÓDULO: Captura manual ─────────────────────────────────────────────── -->
        @if (editable()) {
          <div class="captura-card">
            <div class="captura-head">
              <div class="captura-title-box">
                <span class="captura-badge"><i class="pi pi-pencil" aria-hidden="true"></i></span>
                <div>
                  <h2 class="captura-title">Captura manual</h2>
                  <p class="captura-sub">
                    Buscá artículos por código, código de barras o nombre y agregalos uno a uno con precio del ERP.
                  </p>
                </div>
              </div>
            </div>

            <div class="captura-body">
              <!-- Buscador de artículos por código, código de barras o nombre -->
              <div class="search-step">
                <label class="f-lbl" for="prodSearchInput">
                  <span>Artículo a cotizar (Código, código de barras o nombre)</span>
                </label>
                <div class="search-input-wrap">
                  <i class="pi pi-search search-ico" aria-hidden="true"></i>
                  <input
                    id="prodSearchInput"
                    #buscadorArticulo
                    type="search"
                    class="input search-prod-input"
                    [(ngModel)]="termino"
                    (ngModelChange)="onTermino($event)"
                    (focus)="onFoco()"
                    placeholder="Escribí código SKU, código de barras o nombre del producto..."
                    autocorrect="off"
                    spellcheck="false"
                    [disabled]="guardando()"
                  />
                  @if (buscando()) {
                    <i class="pi pi-spin pi-spinner search-spinner" aria-hidden="true"></i>
                  }
                </div>

                <!-- Desplegable ordenado por orden alfabético del nombre del producto -->
                @if (catalogoAbierto() && resultados().length > 0) {
                  <ul class="cat-dropdown" role="listbox" aria-label="Productos de la sucursal en orden alfabético">
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
                          <div class="cat-col-nom">
                            <strong class="cat-nom">{{ p.name || p.sku }}</strong>
                            @if (p.content) { <span class="cat-cont">({{ p.content }})</span> }
                          </div>
                          <div class="cat-col-meta">
                            <span class="cat-sku">{{ p.sku }}</span>
                            @if (p.barcode) { <span class="cat-bc">EAN: {{ p.barcode }}</span> }
                            <span class="cat-un">{{ p.sold_by_kg ? 'KG' : (p.unit_base || 'PZA') }}</span>
                          </div>
                          <div class="cat-col-precio">
                            <span class="cat-precio-val">{{ dinero(p.piece_price) }}</span>
                            <span class="cat-precio-lbl">base</span>
                          </div>
                        </button>
                      </li>
                    }
                  </ul>
                } @else if (catalogoAbierto() && termino.trim().length > 0 && !buscando()) {
                  <p class="search-hint">
                    Ningún producto de la sucursal {{ cot()?.source_branch }} coincide con <strong>"{{ termino }}"</strong>.
                    Podés guardarlo como no casado para registrar la demanda rechazada.
                  </p>
                }
              </div>

              <!-- Producto seleccionado ("descargado") -->
              @if (elegido(); as e) {
                <div class="descargado-box">
                  <div class="descargado-header">
                    <div class="descargado-tag">
                      <i class="pi pi-check-circle" aria-hidden="true"></i>
                      <span>Artículo seleccionado</span>
                    </div>
                    <button type="button" class="btn-change-prod" (click)="limpiarEleccion()" [disabled]="guardando()">
                      <i class="pi pi-pencil" aria-hidden="true"></i> Cambiar artículo
                    </button>
                  </div>

                  <div class="descargado-info">
                    <strong class="descargado-name">{{ e.name || e.sku }}</strong>
                    <div class="descargado-pills">
                      <span class="pill-meta">SKU: <b>{{ e.sku }}</b></span>
                      @if (e.barcode) { <span class="pill-meta">EAN: {{ e.barcode }}</span> }
                      @if (e.content) { <span class="pill-meta">Contenido: {{ e.content }}</span> }
                      <span class="pill-meta">Unidad base: <b>{{ e.sold_by_kg ? 'Kilogramo' : (e.unit_base || 'Pieza') }}</b></span>
                    </div>
                  </div>

                  <!-- Unidades de MENOR a MAYOR (izq → der), sólo las que el ERP declara, con el
                       nombre real de la base (Paquete, Kilo, Pieza…) — mismo criterio que el alta. -->
                  <div class="pregunta-seccion">
                    @if (opcionesUnidad(e).length > 1) {
                      <span class="pregunta-lbl">¿En qué unidad lo pide?</span>
                    } @else {
                      <span class="pregunta-lbl">Unidad de venta</span>
                    }
                    <div class="unit-toggle-group" role="group" aria-label="Unidad de venta del artículo">
                      @for (o of opcionesUnidad(e); track o.rung) {
                        <button
                          type="button"
                          class="unit-toggle-btn"
                          [class.unit-toggle-active]="rung() === o.rung"
                          (click)="setRung(o.rung)"
                          [disabled]="guardando()"
                        >
                          <i class="pi {{ o.icono }}" aria-hidden="true"></i>
                          <span class="unit-title">{{ o.titulo }}</span>
                          <span class="unit-sub">{{ o.detalle }}</span>
                          @if (o.rung === rung() && previa()?.volume_tier; as vt) {
                            <span class="unit-badge-mayoreo">
                              Mayoreo: {{ dinero(vt.price) }} (desde {{ vt.min_qty }})
                            </span>
                          }
                        </button>
                      }
                    </div>
                  </div>

                  <!-- CONTROL TÁCTIL DE CANTIDAD (MOBILE 16:9 - Sin teclado en pantalla) -->
                  <div class="touch-qty-seccion">
                    <span class="pregunta-lbl">Cantidad de {{ labelUnidadActiva() }}s:</span>

                    <div class="touch-stepper">
                      <button
                        type="button"
                        class="btn-touch-step btn-minus"
                        (click)="ajustarCantidad(-1)"
                        [disabled]="cantidad <= 1 || guardando()"
                        aria-label="Restar una unidad"
                      >
                        <i class="pi pi-minus" aria-hidden="true"></i>
                      </button>

                      <div class="touch-qty-readout" aria-live="polite">
                        <span class="qty-num">{{ cantidad }}</span>
                        <span class="qty-lbl">{{ labelUnidadActiva() }}{{ cantidad > 1 ? (rung() === 'box' ? 's' : (rung() === 'base' && e.sold_by_kg ? '' : 's')) : '' }}</span>
                      </div>

                      <button
                        type="button"
                        class="btn-touch-step btn-plus"
                        (click)="ajustarCantidad(1)"
                        [disabled]="guardando()"
                        aria-label="Sumar una unidad"
                      >
                        <i class="pi pi-plus" aria-hidden="true"></i>
                      </button>
                    </div>

                    <!-- Presets táctiles para no desplegar teclado en pantalla -->
                    <div class="touch-presets" role="group" aria-label="Incrementos rápidos de cantidad">
                      <button type="button" class="preset-btn" (click)="setCantidad(1)" [class.preset-active]="cantidad === 1" [disabled]="guardando()">1</button>
                      <button type="button" class="preset-btn" (click)="ajustarCantidad(5)" [disabled]="guardando()">+5</button>
                      <button type="button" class="preset-btn" (click)="ajustarCantidad(10)" [disabled]="guardando()">+10</button>
                      <button type="button" class="preset-btn" (click)="ajustarCantidad(25)" [disabled]="guardando()">+25</button>
                      <button type="button" class="preset-btn" (click)="ajustarCantidad(50)" [disabled]="guardando()">+50</button>
                      <button type="button" class="preset-btn" (click)="ajustarCantidad(100)" [disabled]="guardando()">+100</button>
                    </div>
                  </div>

                  <!-- PREVIA DEL PRECIO Y DESCUENTOS POR VOLUMEN -->
                  @if (cotizando()) {
                    <div class="previa-loading">
                      <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Consultando precio y escaleras de volumen en ERP...
                    </div>
                  } @else if (previa(); as p) {
                    <div class="previa-card" [class.previa-card-bad]="p.unit_price === null">
                      <div class="previa-top">
                        <div class="previa-unit-box">
                          <span class="previa-label">Precio unitario calculado</span>
                          @if (p.unit_price !== null) {
                            <div class="previa-price-row">
                              <span class="previa-amount">{{ p.unit_price | currency:'MXN':'symbol-narrow':'1.2-4' }}</span>
                              <span class="previa-unit-sub">/ {{ p.unit_label || labelUnidadActiva() }}</span>
                              @if (p.unit_factor && p.unit_factor > 1) {
                                <span class="previa-menor-sub">({{ p.unit_factor }} {{ abrevBase(elegido()) }} {{ (p.unit_price / p.unit_factor) | currency:'MXN':'symbol-narrow':'1.2-2' }})</span>
                              }
                            </div>
                          } @else {
                            <span class="previa-none">Sin precio en esta sucursal</span>
                          }
                        </div>

                        <div class="previa-total-box">
                          <span class="previa-label">Importe del renglón</span>
                          @if (p.line_total !== null) {
                            <span class="previa-total-amount">{{ p.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                          } @else {
                            <span class="previa-none">—</span>
                          }
                        </div>

                        <div class="previa-action-box">
                          <button
                            pButton
                            class="btn-agregar-inline"
                            [disabled]="!puedeAgregar() || guardando()"
                            (click)="agregar()"
                          >
                            <span class="p-button-icon p-button-icon-left pi pi-plus-circle" aria-hidden="true"></span>
                            <span class="p-button-label">Agregar a la cotización</span>
                          </button>
                        </div>
                      </div>

                      <!-- AVISO DESTACADO DE ESCALÓN DE VOLUMEN (ERP kdpv_prod_util) -->
                      @if (p.volume_tier; as vt) {
                        @if (cantidad < vt.min_qty) {
                          <div class="banner-oportunidad-volumen">
                            <div class="b-vol-left">
                              <i class="pi pi-sparkles b-vol-icon" aria-hidden="true"></i>
                              <div class="b-vol-text">
                                <strong class="b-vol-title">¡Descuento por volumen disponible en {{ labelUnidadActiva() }}!</strong>
                                <span class="b-vol-desc">
                                  A partir de <b>{{ vt.min_qty }} {{ labelUnidadActiva() }}s</b> el precio baja de
                                  <span class="strikethrough">{{ dinero(p.list_price) }}</span> a <b>{{ dinero(vt.price) }}</b>
                                  (Ahorro de <b>{{ dinero((p.list_price || 0) - vt.price) }}</b> por {{ labelUnidadActiva() }}).
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              class="btn-aplicar-volumen"
                              (click)="setCantidad(vt.min_qty)"
                              [disabled]="guardando()"
                            >
                              <i class="pi pi-check" aria-hidden="true"></i>
                              Aplicar {{ vt.min_qty }} {{ labelUnidadActiva() }}s con mayoreo
                            </button>
                          </div>
                        } @else {
                          <div class="banner-volumen-exito">
                            <div class="b-vol-left">
                              <i class="pi pi-check-circle b-vol-icon-ok" aria-hidden="true"></i>
                              <div class="b-vol-text">
                                <strong class="b-vol-title">✅ PRECIO DE MAYOREO POR VOLUMEN APLICADO</strong>
                                <span class="b-vol-desc">
                                  Precio lista: <span class="strikethrough">{{ dinero(p.list_price) }}</span> →
                                  Con descuento por volumen: <b>{{ dinero(p.unit_price) }}</b> / {{ p.unit_label || labelUnidadActiva() }}
                                  @if (p.unit_factor && p.unit_factor > 1) {
                                    ({{ p.unit_factor }} {{ abrevBase(elegido()) }} {{ (p.unit_price! / p.unit_factor) | currency:'MXN':'symbol-narrow':'1.2-2' }})
                                  }
                                  · Ahorro total: <b>{{ dinero(((p.list_price || 0) - (p.unit_price || 0)) * cantidad) }}</b>
                                </span>
                              </div>
                            </div>
                          </div>
                        }
                      } @else if (esDescuentoVolumen()) {
                        <div class="banner-volumen">
                          <i class="pi pi-bolt" aria-hidden="true"></i>
                          <span><strong>Descuento por volumen activo</strong> para {{ cantidad }} {{ labelUnidadActiva() }}s</span>
                        </div>
                      }

                      @for (s of p.applied; track s.step) {
                        <div class="p-step-row">
                          <span class="step-tag">{{ s.step }}</span>
                          <span class="step-detail">{{ s.detail }}</span>
                          @if (s.before !== null && s.after !== null && s.before !== s.after) {
                            <span class="step-delta">{{ s.before | currency:'MXN':'symbol-narrow':'1.2-2' }} → {{ s.after | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                          }
                        </div>
                      }

                      @if (p.free_goods) {
                        <div class="banner-regalo">
                          <i class="pi pi-gift" aria-hidden="true"></i>
                          <span>Regalo del ERP: <strong>{{ p.free_goods.quantity }} de {{ p.free_goods.sku }}</strong></span>
                        </div>
                      }

                      @for (na of p.not_applied; track na.mechanism) {
                        @if (na.mechanism !== 'volumen' || !p.volume_tier) {
                          <div class="p-step-row p-step-hint">
                            <span class="step-tag step-tag-hint">Escalón</span>
                            <span class="step-detail">{{ na.reason }}</span>
                          </div>
                        }
                      }

                      @if (p.unpriced_reason) {
                        <p class="p-why-bad">{{ p.unpriced_reason }}</p>
                      }
                    </div>
                  }
                </div>
              } @else {
                <!-- Botón secundario para guardar sin casar si buscó y no encontró -->
                @if (termino.trim().length > 0) {
                  <div class="sin-casar-box">
                    <button
                      pButton
                      severity="secondary"
                      [outlined]="true"
                      [disabled]="guardando()"
                      (click)="agregarSinCasar()"
                    >
                      <span class="p-button-label">Guardar "{{ termino }}" como no casado (demanda)</span>
                    </button>
                    <span class="sin-casar-hint">
                      Si el cliente lo pidió y no existe en catálogo, queda registrado como demanda rechazada.
                    </span>
                  </div>
                }
              }
            </div>
          </div>
        }

        <!-- ── Los renglones agregados ─────────────────────────────────────────────────── -->
        <!-- [UIM.2] Apilado por campos: las 9 columnas son campos de UN renglon. -->
        <div class="table-card dt-scope">
          @if (!q.lines.length) {
            <div class="empty">
              <p class="empty-title">Esta cotización todavía no tiene renglones.</p>
              <p class="empty-hint">Usá la Captura manual arriba para buscar artículos y agregarlos uno a uno.</p>
            </div>
          } @else {
            <p-table [value]="q.lines" styleClass="p-datatable-sm dt-stack" [tableStyle]="{ 'min-width': '64rem' }">
              <ng-template #header>
                <tr>
                  <th class="num">#</th>
                  <th>Producto</th>
                  <th>Presentación</th>
                  <th class="num">Cantidad</th>
                  <th class="num">Lista</th>
                  <th class="num">Precio</th>
                  <th>De dónde sale</th>
                  <th class="num">Importe</th>
                  <th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-l>
                <tr [class.row-gift]="l.parent_line_number !== null">
                  <td class="num mono dt-num" role="cell" data-label="Renglón">{{ l.line_number }}</td>
                  <td class="dt-id" role="cell">
                    @if (l.parent_line_number !== null) {
                      <span class="gift"><i class="pi pi-gift" aria-hidden="true"></i> regalo del {{ l.parent_line_number }}</span>
                    }
                    <span class="p-name">{{ l.product_name || l.requested_text || '—' }}</span>
                    @if (!l.product_id) {
                      <span class="sin-casar">sin casar con el catálogo</span>
                    }
                  </td>
                  <td role="cell" data-label="Presentación">
                    @if (l.qty_unit) {
                      {{ l.qty_unit }}
                      @if (num(l.qty_factor)) { <span class="factor">x{{ num(l.qty_factor) }}</span> }
                    } @else {
                      <span class="t-none">sin registrar</span>
                    }
                  </td>
                  <td class="num dt-num" role="cell" data-label="Cantidad">
                    @if (editable() && l.parent_line_number === null) {
                      <div class="inline-qty-box">
                        <input
                          type="number"
                          class="input num qty-inline"
                          [ngModel]="num(l.quantity)"
                          (ngModelChange)="pedirCambio(l, $event)"
                          min="1"
                          step="1"
                          inputmode="numeric"
                          [disabled]="guardando()"
                          [attr.aria-label]="'Cantidad del renglón ' + l.line_number"
                        />
                      </div>
                    } @else {
                      {{ num(l.quantity) }}
                    }
                  </td>
                  <td class="num muted dt-num" role="cell" data-label="Lista">{{ dinero(l.list_price) }}</td>
                  <td class="num dt-num" role="cell" data-label="Precio">
                    @if (num(l.unit_price) !== null) {
                      <div class="p-unit-cell">
                        <span class="p-unit-main">{{ num(l.unit_price) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                        @if (desgloseDeLinea(l); as pasos) {
                          @if (pasos.length) {
                            <span class="p-unit-sub-breakdown">(@for (p of pasos; track p.unidad; let ultimo = $last) {<span>{{ p.cantidad }} {{ p.unidad }} {{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>@if (!ultimo) { · }})</span>
                          }
                        }
                      </div>
                    } @else {
                      <span class="t-none">sin precio</span>
                    }
                  </td>
                  <td role="cell" data-label="De dónde sale">
                    <p-tag [value]="fuenteLabel(l.price_source)" [severity]="fuenteTono(l.price_source)"></p-tag>
                    @if (num(l.discount_pct)) { <span class="dto">−{{ num(l.discount_pct) }}%</span> }
                  </td>
                  <td class="num dt-num" role="cell" data-label="Importe">{{ num(l.line_total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="num dt-actions" role="cell">
                    @if (editable() && l.parent_line_number === null) {
                      <button
                        pButton
                        severity="danger"
                        [text]="true"
                        size="small"
                        [disabled]="guardando()"
                        (click)="quitar(l)"
                        [attr.aria-label]="'Quitar el renglón ' + l.line_number"
                      ><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button>
                    }
                  </td>
                </tr>
              </ng-template>
            </p-table>

            <!-- Los totales salen del SERVIDOR -->
            <div class="totales">
              <div class="tot"><span>Subtotal</span><b>{{ num(q.subtotal) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              <div class="tot"><span>Impuestos</span><b>{{ num(q.tax_total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              <div class="tot tot-big"><span>Total</span><b>{{ num(q.total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              @if (num(q.terms_discount_pct)) {
                <p class="tot-nota">
                  Incluye el {{ num(q.terms_discount_pct) }}% del cliente, aplicado sobre el subtotal —
                  no sobre el precio de cada renglón.
                </p>
              }
            </div>
          }
        </div>

        @if (q.customer_request) {
          <div class="cruda">
            <p class="cruda-lbl">La lista del cliente, como llegó</p>
            <pre>{{ q.customer_request }}</pre>
          </div>
        }
      }
    </section>
  `,
  styles: [
    `
      .section { padding: 1rem 1.25rem; max-width: 1100px; margin: 0 auto; }
      .back { display: inline-flex; gap: 0.35rem; align-items: center; font-size: 0.8125rem; color: var(--text-muted); text-decoration: none; margin-bottom: 0.75rem; }
      .back:hover { color: var(--text-main); }
      .back:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 4px; }
      .head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
      .head-right-actions { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      .btn-export-xlsx { border-color: #16a34a !important; color: #16a34a !important; font-weight: 600; }
      .btn-export-xlsx:hover:not(:disabled) { background: rgba(22, 163, 74, 0.08) !important; }
      .btn-export-pdf { border-color: #dc2626 !important; color: #dc2626 !important; font-weight: 600; }
      .btn-export-pdf:hover:not(:disabled) { background: rgba(220, 38, 38, 0.08) !important; }
      .section-header h1 { font-size: 1.35rem; font-weight: 700; margin: 0; font-family: var(--font-mono, monospace); }
      .sub { color: var(--text-muted); font-size: 0.9375rem; margin: 0.15rem 0 0; }

      .loading { display: flex; justify-content: center; padding: 3rem 0; }
      .aviso { display: flex; gap: 0.5rem; align-items: flex-start; margin: 1rem 0; padding: 0.7rem 0.9rem;
               border: 1px solid var(--border-color); border-left-width: 3px; border-radius: 8px;
               background: var(--card-bg); font-size: 0.8125rem; color: var(--text-muted); }
      .aviso i { color: var(--action); margin-top: 0.1rem; }
      .aviso-bad { border-left-color: var(--bad-fg); }
      .aviso-bad i { color: var(--bad-fg); }

      .terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.6rem; margin: 0.85rem 0; }
      .t { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.55rem 0.75rem;
           display: flex; flex-direction: column; gap: 0.1rem; }
      .t-lbl { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
      .t-val { font-size: 0.875rem; font-variant-numeric: tabular-nums; }
      .t-val.t-sm { font-size: 0.8125rem; }
      .t-strong { font-weight: 700; color: var(--action); }
      .t-none { font-style: italic; color: var(--text-muted); font-size: 0.8125rem; }
      .t-sub { font-size: 0.7rem; color: var(--text-muted); }
      .vencida { color: var(--bad-fg); font-weight: 600; }

      /* ── MÓDULO: Captura manual ─────────────────────────────────────────── */
      .captura-card {
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px;
        margin-bottom: 1.25rem; overflow: visible; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      }
      .captura-head {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color); background: var(--surface-ground);
      }
      .captura-title-box { display: flex; align-items: center; gap: 0.6rem; }
      .captura-badge {
        width: 28px; height: 28px; border-radius: 6px; background: var(--action);
        color: var(--action-ink, #fff); display: inline-flex; align-items: center; justify-content: center;
        font-size: 0.875rem;
      }
      .captura-title { font-size: 1rem; font-weight: 700; margin: 0; }
      .captura-sub { font-size: 0.75rem; color: var(--text-muted); margin: 0.1rem 0 0; }
      .captura-body { padding: 1rem; }

      .f-lbl { display: block; font-size: 0.8125rem; font-weight: 600; margin-bottom: 0.35rem; color: var(--text-main); }
      .search-step { position: relative; margin-bottom: 0.75rem; }
      .search-input-wrap { position: relative; display: flex; align-items: center; }
      .search-ico { position: absolute; left: 0.75rem; color: var(--text-muted); font-size: 0.875rem; pointer-events: none; }
      .search-spinner { position: absolute; right: 0.75rem; color: var(--action); font-size: 0.875rem; }
      .input.search-prod-input { padding-left: 2.25rem; font-size: 0.9375rem; min-height: 42px; border-radius: 8px; width: 100%; }

      /* Desplegable ordenado alfabéticamente */
      .cat-dropdown {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
        list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow-y: auto;
        border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg);
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      }
      .cat-dropdown li + li { border-top: 1px solid var(--border-color); }
      .cat-row {
        width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.6rem 0.85rem; background: none; border: 0; cursor: pointer; text-align: left;
        color: var(--text-main); font-size: 0.8125rem;
      }
      .cat-row:hover, .cat-row-active { background: var(--hover-bg); }
      .cat-col-nom { flex: 1 1 auto; min-width: 0; }
      .cat-nom { font-size: 0.875rem; display: inline-block; }
      .cat-cont { color: var(--text-muted); font-size: 0.75rem; margin-left: 0.35rem; }
      .cat-col-meta { display: flex; gap: 0.5rem; font-size: 0.75rem; color: var(--text-muted); flex: 0 0 auto; }
      .cat-sku { font-family: var(--font-mono, monospace); font-weight: 600; }
      .cat-bc { font-variant-numeric: tabular-nums; }
      .cat-un { font-weight: 600; background: var(--neutral-100, #f1f5f9); padding: 1px 4px; border-radius: 4px; }
      .cat-col-precio { text-align: right; flex: 0 0 5.5rem; display: flex; flex-direction: column; }
      .cat-precio-val { font-weight: 700; font-size: 0.875rem; font-variant-numeric: tabular-nums; }
      .cat-precio-lbl { font-size: 0.65rem; color: var(--text-muted); }
      .search-hint { font-size: 0.8125rem; color: var(--text-muted); margin: 0.5rem 0 0; }

      /* Tarjeta de producto descargado */
      .descargado-box {
        background: var(--surface-ground); border: 1px solid var(--border-color);
        border-radius: 8px; padding: 1rem; margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.85rem;
      }
      .descargado-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
      .descargado-tag {
        display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem;
        font-weight: 700; color: var(--ok-fg, #15803d); text-transform: uppercase; letter-spacing: 0.03em;
      }
      .btn-change-prod {
        background: none; border: 0; color: var(--action); cursor: pointer; font-size: 0.8125rem;
        font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.4rem;
      }
      .btn-change-prod:hover { text-decoration: underline; }

      .descargado-info { display: flex; flex-direction: column; gap: 0.35rem; }
      .descargado-name { font-size: 1.05rem; font-weight: 700; color: var(--text-main); }
      .descargado-pills { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .pill-meta { font-size: 0.75rem; color: var(--text-muted); background: var(--card-bg); padding: 0.2rem 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); }
      .pill-meta b { color: var(--text-main); }

      /* Pregunta: Caja o Pieza */
      .pregunta-seccion { display: flex; flex-direction: column; gap: 0.4rem; }
      .pregunta-lbl { font-size: 0.8125rem; font-weight: 700; color: var(--text-main); }
      .unit-toggle-group { display: flex; gap: 0.6rem; flex-wrap: wrap; }
      .unit-toggle-btn {
        flex: 1 1 130px; display: flex; flex-direction: column; align-items: center; justify-content: center;
        padding: 0.65rem 0.8rem; border-radius: 8px; border: 2px solid var(--border-color);
        background: var(--card-bg); cursor: pointer; min-height: 52px; text-align: center; gap: 0.15rem;
        transition: border-color 0.15s, background-color 0.15s;
      }
      .unit-toggle-btn i { font-size: 1rem; color: var(--text-muted); }
      .unit-toggle-btn:hover { border-color: var(--action); }
      .unit-toggle-active { border-color: var(--action); background: rgba(var(--action-rgb, 14, 116, 144), 0.06); }
      .unit-toggle-active i { color: var(--action); }
      .unit-title { font-weight: 700; font-size: 0.9375rem; color: var(--text-main); }
      .unit-sub { font-size: 0.7rem; color: var(--text-muted); }

      /* Stepper táctil para móvil 16:9 */
      .touch-qty-seccion { display: flex; flex-direction: column; gap: 0.4rem; }
      .touch-stepper { display: flex; align-items: center; gap: 0.5rem; max-width: 320px; }
      .btn-touch-step {
        width: 48px; height: 48px; flex: none; border-radius: 8px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: 1.15rem; font-weight: 700; color: var(--text-main);
        cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        user-select: none; -webkit-tap-highlight-color: transparent;
      }
      .btn-touch-step:active { background: var(--hover-bg); transform: scale(0.96); }
      .btn-touch-step:disabled { opacity: 0.4; cursor: not-allowed; }
      .touch-qty-readout {
        flex: 1; height: 48px; border-radius: 8px; border: 1px solid var(--border-color);
        background: var(--card-bg); display: flex; flex-direction: column; align-items: center;
        justify-content: center; font-variant-numeric: tabular-nums;
      }
      .qty-num { font-size: 1.35rem; font-weight: 800; line-height: 1.1; color: var(--text-main); }
      .qty-lbl { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }

      .touch-presets { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.25rem; }
      .preset-btn {
        min-height: 36px; padding: 0.3rem 0.65rem; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: 0.8125rem; font-weight: 600; cursor: pointer; color: var(--text-muted);
      }
      .preset-btn:hover, .preset-btn:active { background: var(--hover-bg); color: var(--text-main); }
      .preset-active { background: var(--action); color: var(--action-ink, #fff); border-color: var(--action); }

      /* Previa del precio y volumen */
      .previa-loading { font-size: 0.8125rem; color: var(--text-muted); padding: 0.5rem 0; }
      .previa-card {
        border-radius: 8px; padding: 0.85rem 1rem; border: 1px solid var(--border-color);
        border-left: 4px solid var(--ok-fg, #15803d); background: var(--card-bg);
      }
      .previa-card-bad { border-left-color: var(--bad-fg, #dc2626); }
      .previa-top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
      .previa-unit-box { flex: 0 1 auto; }
      .previa-total-box { flex: 0 1 auto; }
      .previa-action-box { margin-left: auto; display: flex; align-items: center; }
      .btn-agregar-inline {
        min-height: 40px; font-size: 0.875rem; font-weight: 700; border-radius: 6px;
        padding: 0.45rem 1.15rem; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }
      @media (max-width: 640px) {
        .previa-action-box { width: 100%; margin-left: 0; margin-top: 0.4rem; }
        .btn-agregar-inline { width: 100%; justify-content: center; }
      }
      .previa-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; display: block; }
      .previa-price-row { display: flex; align-items: baseline; gap: 0.35rem; }
      .previa-amount { font-size: 1.2rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .previa-unit-sub { font-size: 0.75rem; color: var(--text-muted); }
      .previa-menor-sub { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; margin-left: 0.25rem; }
      .previa-total-amount { font-size: 1.25rem; font-weight: 800; color: var(--action); font-variant-numeric: tabular-nums; }
      .previa-none { font-size: 0.875rem; font-style: italic; color: var(--bad-fg); }

      .banner-oportunidad-volumen {
        display: flex; justify-content: space-between; align-items: center; gap: 0.75rem;
        padding: 0.6rem 0.85rem; background: #eff6ff; border: 1.5px dashed #3b82f6;
        border-radius: 8px; font-size: 0.8125rem; color: #1e40af; margin: 0.5rem 0; flex-wrap: wrap;
      }
      .b-vol-left { display: flex; align-items: center; gap: 0.5rem; flex: 1 1 280px; }
      .b-vol-icon { font-size: 1.15rem; color: #2563eb; flex-shrink: 0; }
      .b-vol-icon-ok { font-size: 1.25rem; color: #059669; flex-shrink: 0; }
      .b-vol-text { display: flex; flex-direction: column; gap: 0.15rem; }
      .b-vol-title { font-weight: 700; color: #1e3a8a; }
      .b-vol-desc { font-size: 0.75rem; color: #1e40af; }
      .strikethrough { text-decoration: line-through; opacity: 0.65; margin: 0 0.2rem; }
      .btn-aplicar-volumen {
        background: #2563eb; color: #fff; border: 0; border-radius: 6px;
        padding: 0.4rem 0.85rem; font-size: 0.75rem; font-weight: 700;
        cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap;
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      }
      .btn-aplicar-volumen:hover { background: #1d4ed8; }

      .banner-volumen-exito {
        display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.85rem;
        background: #ecfdf5; border: 1.5px solid #10b981; border-radius: 8px;
        font-size: 0.8125rem; color: #065f46; margin: 0.5rem 0;
      }
      .banner-volumen-exito .b-vol-title { color: #065f46; }
      .banner-volumen-exito .b-vol-desc { color: #047857; }

      .unit-badge-mayoreo {
        font-size: 0.6875rem; font-weight: 700; color: #047857; background: #d1fae5;
        padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 0.2rem;
      }

      .banner-volumen {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.65rem;
        background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3);
        border-radius: 6px; font-size: 0.8125rem; color: var(--ok-fg, #15803d); margin: 0.5rem 0;
      }
      .banner-regalo {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.65rem;
        background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 6px; font-size: 0.8125rem; color: #1d4ed8; margin: 0.5rem 0;
      }
      .p-step-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; margin-top: 0.25rem; flex-wrap: wrap; }
      .step-tag { font-weight: 700; color: var(--text-main); }
      .step-detail { color: var(--text-muted); }
      .step-delta { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ok-fg, #15803d); }
      .p-why-bad { color: var(--bad-fg, #dc2626); font-size: 0.75rem; margin: 0.3rem 0 0; }

      .p-unit-cell { display: flex; flex-direction: column; align-items: flex-end; }
      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: 0.6875rem; color: var(--text-muted); font-weight: 500; }

      .sin-casar-box { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.3rem; }
      .sin-casar-hint { font-size: 0.75rem; color: var(--text-muted); }

      /* Tabla de renglones */
      .table-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow-x: auto; }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); }
      .muted { color: var(--text-muted); }
      .row-gift { background: var(--surface-ground); }
      .gift { display: block; font-size: 0.7rem; color: var(--ok-fg); }
      .sin-casar { display: block; font-size: 0.7rem; color: var(--warn-fg); }
      .factor { margin-left: 0.25rem; font-size: 0.7rem; color: var(--text-muted); }
      .dto { display: block; font-size: 0.7rem; color: var(--ok-fg); }
      .inline-qty-box { display: flex; justify-content: flex-end; }
      .qty-inline { width: 5.5rem; min-height: 32px; padding: 0.2rem 0.4rem; }

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

      .input { width: 100%; padding: 0.45rem 0.7rem; box-sizing: border-box; border: 1px solid var(--border-color);
               border-radius: 6px; font-size: 0.875rem; background: var(--card-bg); color: var(--text-main); min-height: 36px; }
      .input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
      .input.num { text-align: right; font-variant-numeric: tabular-nums; }

      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
                 clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    `,
  ],
})
export class TeleventaQuoteDetailComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly injector = inject(Injector);
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

  /** El catálogo de la sucursal, ordenado alfabéticamente por nombre de producto. */
  readonly resultados = signal<QuoteCatalogRow[]>([]);
  readonly buscando = signal(false);
  readonly catalogoAbierto = signal(false);
  readonly elegido = signal<QuoteCatalogRow | null>(null);
  /** El buscador de artículo: al agregar un renglón el cursor vuelve acá para el siguiente. */
  private readonly buscadorArticulo = viewChild<ElementRef<HTMLInputElement>>('buscadorArticulo');
  private focoSinAbrirCatalogo = false;

  termino = '';
  cantidad = 1;

  private id = '';
  private readonly previa$ = new Subject<void>();
  private readonly buscar$ = new Subject<void>();

  readonly editable = computed(() => this.cot()?.status === 'draft');
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
                this.toast.add({
                  severity: err?.status === 403 ? 'warn' : 'error',
                  summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo cotizar',
                  detail: err?.error?.message || 'El motor de precio no respondió.',
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
          return this.svc.searchCatalog(branch, this.termino.trim(), 50).pipe(
            catchError((err) => {
              this.toast.add({
                severity: err?.status === 403 ? 'warn' : 'error',
                summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo buscar',
                detail: err?.error?.message || 'El catálogo de la sucursal no respondió.',
              });
              return of([] as QuoteCatalogRow[]);
            }),
          );
        }),
      )
      .subscribe((rows) => {
        // Orden alfabético estricto por nombre del producto (solicitud PM)
        const ordenados = [...rows].sort((a, b) => {
          const nomA = (a.name || a.sku).trim();
          const nomB = (b.name || b.sku).trim();
          return nomA.localeCompare(nomB, 'es', { sensitivity: 'base' });
        });
        this.resultados.set(ordenados);
        this.buscando.set(false);
        this.catalogoAbierto.set(true);

        const t = this.termino.trim();
        if (ordenados.length === 1 && t && (ordenados[0].sku.toUpperCase() === t.toUpperCase() || ordenados[0].barcode === t)) {
          this.elegir(ordenados[0]);
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
            ? 'Esa cotización no existe o fue borrada.'
            : err?.error?.message || 'No se pudo abrir la cotización.',
        );
      },
    });
  }

  onTermino(_v: string): void {
    this.elegido.set(null);
    this.previa.set(null);
    this.buscar$.next();
  }

  onFoco(): void {
    if (this.focoSinAbrirCatalogo) return;
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

  setRung(r: Rung): void {
    this.rung.set(r);
    this.previa$.next();
  }

  ajustarCantidad(delta: number): void {
    const actual = Number(this.cantidad) || 1;
    this.cantidad = Math.max(1, actual + delta);
    this.previa$.next();
  }

  setCantidad(val: number): void {
    this.cantidad = Math.max(1, Math.floor(val));
    this.previa$.next();
  }

  /** Unidades del artículo de MENOR a MAYOR (Pieza 1 · Paquete 10 · Caja 140). */
  opcionesUnidad(e: QuoteCatalogRow): OpcionUnidad[] {
    return opcionesUnidad(e);
  }

  /** Abreviatura de la unidad base para el desglose ("12 PAQ $41.82"), nunca "PZS" fijo. */
  abrevBase(e: QuoteCatalogRow | null): string {
    return abrevUnidadBase(e?.unit_base, !!e?.sold_by_kg);
  }

  /** Lo mismo, para un renglón ya guardado (la unidad base viene del JOIN del detalle). */
  baseDeLinea(l: QuoteLine): string {
    return abrevUnidadBase(l.product_unit_base, !!l.product_sold_by_kg);
  }

  /**
   * El peldaño en que quedó guardado el renglón. BTO/CUB son unidad mayor SÓLO con factor > 1:
   * 13 SKUs los tienen como unidad BASE (15143 nace BTO a $89.39 sin caja) — mismo criterio que
   * `isUnidadMayor` del entregable.
   */
  rungDeLinea(l: QuoteLine): Rung {
    const u = (l.qty_unit || '').toUpperCase();
    if (['CJA', 'CAJA'].includes(u)) return 'box';
    if (['BTO', 'BULTO', 'CUB', 'CUBETA'].includes(u) && (this.num(l.qty_factor) ?? 0) > 1) return 'box';
    return l.qty_unit === 'PAQ' || l.qty_unit === 'Paquete' ? 'pack' : 'base';
  }

  /** Paquete dentro de la caja del renglón, si cabe exacto (la unidad del medio, COT.17). */
  paqueteDeLinea(l: QuoteLine): number | null {
    return this.rungDeLinea(l) === 'box' ? paqueteDeCaja(this.num(l.qty_factor), this.num(l.product_pack_size)) : null;
  }

  /** "$121.86/PAQ · $12.19/PZA" de un renglón guardado, con su precio congelado. */
  desgloseDeLinea(l: QuoteLine): PasoDesglose[] {
    const precio = this.num(l.unit_price);
    return precio === null ? [] : desglose(precio, this.num(l.qty_factor), this.baseDeLinea(l), this.paqueteDeLinea(l));
  }

  labelUnidadActiva(): string {
    const e = this.elegido();
    if (!e) return 'Pieza';
    return opcionesUnidad(e).find((o) => o.rung === this.rung())?.titulo ?? nombreUnidadBase(e.unit_base, e.sold_by_kg);
  }

  esDescuentoVolumen(): boolean {
    const p = this.previa();
    if (!p) return false;
    if (p.price_source === 'volume_qty' || p.price_source === 'volume_amount' || p.price_source === 'promo_qty') return true;
    return p.applied.some(
      (s) =>
        s.step.toLowerCase().includes('volumen') ||
        s.step.toLowerCase().includes('promo') ||
        s.source.toLowerCase().includes('volume') ||
        (s.before !== null && s.after !== null && s.after < s.before),
    );
  }

  agregar(): void {
    if (this.guardando() || !this.elegido()) return;
    this.guardando.set(true);
    const itemNom = this.elegido()?.name || this.elegido()?.sku || 'Artículo';
    const unidadNom = this.labelUnidadActiva();
    const qty = Number(this.cantidad);

    this.svc
      .addLine(this.id, { sku: this.elegido()!.sku, quantity: qty, rung: this.rung() })
      .subscribe({
        next: () => {
          this.toast.add({
            severity: 'success',
            summary: 'Renglón agregado',
            detail: `${qty} ${unidadNom}${qty > 1 ? 's' : ''} de ${itemNom}`,
          });
          this.limpiarAlta();
          this.recargar();
          this.guardando.set(false);
          this.volverAlBuscador();
        },
        error: (err) => this.falla(err, 'No se pudo agregar el renglón'),
      });
  }

  agregarSinCasar(): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.svc
      .addLine(this.id, { requested_text: this.termino.trim(), quantity: Number(this.cantidad) })
      .subscribe({
        next: () => {
          this.toast.add({
            severity: 'info',
            summary: 'Demanda registrada',
            detail: `${this.termino.trim()} guardado como no casado.`,
          });
          this.limpiarAlta();
          this.recargar();
          this.guardando.set(false);
          this.volverAlBuscador();
        },
        error: (err) => this.falla(err, 'No se pudo guardar el renglón'),
      });
  }

  pedirCambio(l: QuoteLine, valor: number): void {
    const qty = Math.floor(Number(valor));
    if (!Number.isFinite(qty) || qty <= 0 || qty === this.numOr0(l.quantity)) return;
    this.guardando.set(true);
    this.svc.updateLine(this.id, l.id, { quantity: qty }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        const p = r.priced;
        if (p && p.unit_price !== null && this.numOr0(l.unit_price) !== p.unit_price) {
          this.toast.add({
            severity: 'info',
            summary: 'El precio se movió',
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
      next: () => {
        this.guardando.set(false);
        this.toast.add({
          severity: 'info',
          summary: 'Renglón quitado',
          detail: `Se eliminó el renglón ${l.line_number}.`,
        });
        this.recargar();
      },
      error: (err) => this.falla(err, 'No se pudo quitar el renglón'),
    });
  }

  /**
   * El cursor vuelve al buscador para escanear/escribir el siguiente sin tocar el mouse. Sin
   * abrir la lista: taparía los renglones recién recargados; al teclear se abre sola.
   * `afterNextRender` porque el input está `[disabled]` mientras se guarda: hay que esperar a que
   * la pantalla lo vuelva a habilitar, si no el `focus()` cae sobre un control deshabilitado.
   */
  private volverAlBuscador(): void {
    this.focoSinAbrirCatalogo = true;
    afterNextRender(
      () => {
        this.buscadorArticulo()?.nativeElement.focus();
        this.focoSinAbrirCatalogo = false;
      },
      { injector: this.injector },
    );
  }

  private limpiarAlta(): void {
    this.termino = '';
    this.cantidad = 1;
    this.previa.set(null);
    this.elegido.set(null);
    this.resultados.set([]);
    this.catalogoAbierto.set(false);
    this.rung.set('base');
  }

  private falla(err: { status?: number; error?: { message?: string } }, summary: string): void {
    this.guardando.set(false);
    this.toast.add({
      severity: err?.status === 403 ? 'warn' : 'error',
      summary: err?.status === 403 ? 'Sin permiso' : summary,
      detail: err?.error?.message || 'Error de red.',
    });
  }

  num(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  private numOr0(v: number | string | null | undefined): number { return this.num(v) ?? 0; }

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
    if (q.days_to_expiry < 0) return `venció hace ${Math.abs(q.days_to_expiry)} d`;
    if (q.days_to_expiry === 0) return 'vence hoy';
    return `en ${q.days_to_expiry} d`;
  }

  vendedorAsignado(q: QuoteDetail): string | null {
    if (!q.notes) return null;
    const m = q.notes.match(/Vendedor(?: asignado| de seguimiento)?:?\s*([^\n;]+)/i);
    return m ? m[1].trim() : null;
  }

  protected escaleraDe(units: readonly Presentacion[] | null): Presentacion[] { return escalera(units); }
  protected factor(p: Presentacion | null): number { return factorDe(p); }

  // ── Generación de Entregables (XLSX / PDF) ───────────────────────────────────
  exportando = signal(false);
  exportandoTipo = signal<'xlsx' | 'pdf' | null>(null);

  obtenerDatosEntregable(q: QuoteDetail): QuoteDeliverableData {
    const sucursalCod = q.source_branch || '01';
    const items = q.lines.map((l) => ({
      // El SKU real primero; `requested_text` sólo cuando el renglón NO casó con el catálogo
      // (que es el único caso en que esa columna tiene algo).
      sku: l.product_sku || l.requested_text || 'ART',
      name: l.product_name || l.requested_text || 'Artículo',
      barcode: l.product_barcode ?? null,
      content: l.product_content ?? null,
      unit_label: l.qty_unit || 'PZA',
      rung: this.rungDeLinea(l),
      factor: this.num(l.qty_factor),
      base_unit: this.baseDeLinea(l),
      pack_size: this.paqueteDeLinea(l),
      quantity: Number(l.quantity) || 1,
      unit_price: this.num(l.unit_price),
      line_total: Number(l.line_total) || 0,
      price_source: this.fuenteLabel(l.price_source),
      free_goods: null,
      discount_pct: this.num(l.discount_pct) ?? (Number(q.terms_discount_pct) || null),
    }));

    const subtotal = Number(q.subtotal) || 0;
    const discountPct = Number(q.terms_discount_pct) || 0;
    const discountAmount = discountPct > 0 ? (subtotal * discountPct) / 100 : 0;
    const total = Number(q.total) || subtotal - discountAmount;

    return {
      // Esta cotización YA existe: su folio es lo primero que va al papel.
      quoteCode: q.code,
      customerCode: q.customer_code || q.erp_customer_code || null,
      customerName: q.recipient_name || q.erp_customer_name || 'CLIENTE',
      customerPhone: q.contact_phone || null,
      customerEmail: q.contact_email || null,
      branchCode: sucursalCod,
      branchName: branchName(sucursalCod),
      salespersonCode: q.salesperson_code || null,
      salespersonName: this.vendedorAsignado(q) || null,
      quoteDate: q.quote_date || new Date(),
      validUntil: q.valid_until,
      items,
      subtotal,
      discountPct,
      discountAmount,
      total,
      notes: q.customer_request || q.notes || null,
    };
  }

  async descargarXlsx(): Promise<void> {
    const q = this.cot();
    if (!q || !q.lines.length || this.exportando()) return;

    this.exportando.set(true);
    this.exportandoTipo.set('xlsx');
    try {
      const data = this.obtenerDatosEntregable(q);
      await exportQuoteXlsx(data);
      this.toast.add({
        severity: 'success',
        summary: 'Excel generado',
        detail: 'El archivo .xlsx de la cotización se descargó correctamente.',
      });
    } catch (err: any) {
      this.toast.add({
        severity: 'error',
        summary: 'Error al exportar Excel',
        detail: err?.message || 'Ocurrió un error al generar la hoja de cálculo.',
      });
    } finally {
      this.exportando.set(false);
      this.exportandoTipo.set(null);
    }
  }

  async descargarPdf(): Promise<void> {
    const q = this.cot();
    if (!q || !q.lines.length || this.exportando()) return;

    this.exportando.set(true);
    this.exportandoTipo.set('pdf');
    try {
      const data = this.obtenerDatosEntregable(q);
      await exportQuotePdf(data);
      this.toast.add({
        severity: 'success',
        summary: 'PDF generado',
        detail: 'El archivo PDF formal de la cotización se descargó correctamente.',
      });
    } catch (err: any) {
      this.toast.add({
        severity: 'error',
        summary: 'Error al exportar PDF',
        detail: err?.message || 'Ocurrió un error al generar el archivo PDF.',
      });
    } finally {
      this.exportando.set(false);
      this.exportandoTipo.set(null);
    }
  }
}

