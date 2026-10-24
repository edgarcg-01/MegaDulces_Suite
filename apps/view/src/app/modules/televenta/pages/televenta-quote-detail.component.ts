import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ConfirmationService, MessageService } from 'primeng/api';
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
  parseCantidad,
  etiquetaFuentePrecio,
  type OpcionUnidad,
  type PasoDesglose,
  type QuoteCheck,
  type QuoteCheckLine,
} from '../quotes.service';
import {
  exportQuotePdf,
  exportQuoteXlsx,
  fechaVigencia,
  type QuoteDeliverableData,
} from '../quote-deliverable-export';
import { totalesCotizacion } from '@megadulces/contracts';
import { desgloseDescuento, pasosDelPrecio, explicacionDelPrecio } from '../quote-discount-breakdown';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { QuoteLinesTableComponent, type RenglonTabla, type CambioCantidad } from '../components/quote-lines-table.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
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
    FreshnessPillComponent,
    QuoteLinesTableComponent,
    ContextHelpComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast position="top-center"></p-toast>

    <section class="section">
      @if (cargando()) {
        <a routerLink="/telemarketing/cotizaciones" class="back">
          <i class="pi pi-arrow-left" aria-hidden="true"></i> Cotizaciones
        </a>
        <div class="loading" aria-live="polite"><p-progressspinner styleClass="w-12 h-12"></p-progressspinner></div>
      } @else if (error()) {
        <a routerLink="/telemarketing/cotizaciones" class="back">
          <i class="pi pi-arrow-left" aria-hidden="true"></i> Cotizaciones
        </a>
        <div class="aviso aviso-bad" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ error() }}</span>
        </div>
      } @else if (cot(); as q) {
        <!-- COT.18: cabecera de UNA línea, como el alta (COT.16). Excel/PDF viven en el riel. -->
        <header class="page-head">
          <a routerLink="/telemarketing/cotizaciones" class="back">
            <i class="pi pi-arrow-left" aria-hidden="true"></i> Cotizaciones
          </a>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <h1>{{ q.code }}</h1>
          <span class="head-cliente">{{ q.recipient_name }}</span>
          <p-tag [value]="estadoLabel(q.status)" [severity]="estadoTono(q.status)"></p-tag>
        </header>

        <!-- Zona de trabajo (izquierda) + riel fijo (derecha: totales, entregables, asistente IA) -->
        <div class="layout">
        <div class="work">

        <!-- [E.27] La cotización contra Kepler HOY: si un precio cambió desde que se cotizó, se dice
             con el total de hoy; un borrador vigente se puede re-cotizar, lo demás es de su fecha. -->
        @if (revision(); as r) {
          @if (r.price_changed || (r.repriceable && r.tax_missing)) {
            <div class="aviso" [class.aviso-bad]="r.repriceable && r.price_changed > 0" role="status">
              <i class="pi pi-sync" aria-hidden="true"></i>
              <span>
                @if (r.price_changed) {
                  <b>{{ r.price_changed }} renglón(es) cambiaron de precio en Kepler</b> desde que se cotizó:
                  hoy el total sería {{ r.total_now | currency:'MXN':'symbol-narrow':'1.2-2' }} (guardado {{ r.total_saved | currency:'MXN':'symbol-narrow':'1.2-2' }}).
                }
                @if (r.tax_missing) {
                  {{ r.tax_missing }} renglón(es) con impuesto estimado: se cotizaron antes de guardar el IVA/IEPS de cada producto.
                }
                @if (r.historical) { Es un documento de su fecha: sus precios no se cambian. }
              </span>
              @if (r.repriceable && editable()) {
                <button pButton size="small" class="aviso-accion" [disabled]="guardando()" (click)="pedirRecotizar(r)">
                  <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
                  <span class="p-button-label">Re-cotizar a precios de hoy</span>
                </button>
              }
            </div>
          }
        } @else if (revisionError(); as e) {
          <div class="aviso aviso-bad" role="alert">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>No se pudo comparar con Kepler: {{ e }} Se muestra lo guardado.</span>
          </div>
        }

        <!-- Las condiciones CONGELADAS, en una tira. Un precio tiene que ser explicable, y estas
             son la mitad de la explicacion: el descuento del cliente entra sobre el subtotal. -->
        <div class="card terms-line">
          <span class="tl"><span class="tl-lbl">Sucursal:</span> <b>{{ q.source_branch ? nombreSucursal(q.source_branch) : '—' }}</b></span>
          <span class="tl-sep" aria-hidden="true"></span>
          <span class="tl"><span class="tl-lbl">Descuento cliente:</span>
            @if (num(q.terms_discount_pct) !== null) {
              <b class="t-strong">{{ num(q.terms_discount_pct) }}%</b>
            } @else {
              <!-- NULL no es 0%: el ERP no lo tiene configurado, que no es haber decidido no darlo. -->
              <span class="t-none">sin configurar</span>
            }
          </span>
          <span class="tl-sep" aria-hidden="true"></span>
          <span class="tl"><span class="tl-lbl">Plazo:</span> <b>{{ q.terms_payment_days !== null ? q.terms_payment_days + ' días' : '—' }}</b></span>
          <span class="tl-sep" aria-hidden="true"></span>
          <span class="tl"><span class="tl-lbl">Vigencia:</span> <b [class.vencida]="q.days_to_expiry < 0">{{ fechaCorta(q.valid_until) }}</b> <span class="t-sub">{{ vigenciaHint(q) }}</span></span>
          <span class="tl-sep" aria-hidden="true"></span>
          <span class="tl"><span class="tl-lbl">Condiciones:</span> {{ fuenteTerms(q.terms_source) }}</span>
          @if (vendedorAsignado(q); as vend) {
            <span class="tl-sep" aria-hidden="true"></span>
            <span class="tl"><i class="pi pi-user tl-ico" aria-hidden="true"></i><span class="tl-lbl">Vendedor:</span> <b>{{ vend }}</b></span>
          }
        </div>

        @if (q.status !== 'draft') {
          <div class="aviso" role="note">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <span>
              Esta cotizacion esta <strong>{{ estadoLabel(q.status).toLowerCase() }}</strong>, asi que
              sus renglones ya no se tocan. Una cotizacion enviada que cambia es otra version, no la misma.
            </span>
          </div>
        } @else if (!editable()) {
          <!-- COT.19: borrador, pero de una sucursal en la que este usuario no puede escribir. -->
          <div class="aviso" role="note">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <span>
              Puedes ver esta cotización, pero es de <strong>{{ nombreSucursal(q.source_branch) }}</strong> y tu
              alcance no incluye editar ahí.
            </span>
          </div>
        }

        <!-- ── MÓDULO: Captura manual ─────────────────────────────────────────────── -->
        @if (editable()) {
          <div class="card captura-card">
            <div class="captura-body">
              <!-- COT.18: el título comparte fila con el buscador (antes: encabezado + subtítulo +
                   etiqueta = 3 renglones antes de poder escribir). -->
              <!-- [E.29] Como el alta: la lista se abre al teclear, se cierra con Esc o al salir. -->
              <div class="search-step" (focusout)="alSalirDelBuscador($event)">
                <label class="captura-lbl" for="prodSearchInput">
                  <i class="pi pi-plus-circle" aria-hidden="true"></i> Agregar artículo
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
                    (keydown.escape)="catalogoAbierto.set(false)"
                    placeholder="Escribe código SKU, código de barras o nombre del producto..."
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
                    Ningún producto de {{ nombreSucursal(cot()?.source_branch ?? null) }} coincide con <strong>«{{ termino }}»</strong>.
                    Puedes guardarlo como no casado para registrar la demanda rechazada.
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
        <div class="card table-card dt-scope">
          <div class="card-head">
            <h2>Renglones</h2>
            <app-context-help topic="cotizacion-descuentos" />
            <span class="badge-count">{{ q.lines.length }}</span>
            @if (revision()?.stock_as_of; as al) {
              <app-freshness-pill measures="data" [since]="al" label="Existencia"></app-freshness-pill>
            }
          </div>
          @if (!q.lines.length) {
            <div class="empty">
              <p class="empty-title">Esta cotización todavía no tiene renglones.</p>
              <p class="empty-hint">Busca artículos arriba, en "Agregar artículo", y agrégalos uno a uno.</p>
            </div>
          } @else {
            <!-- [E.29] La misma tabla que la bandeja del alta: se ve igual antes y después de crear. -->
            <app-quote-lines-table
              [renglones]="renglonesVista()"
              [bloqueado]="guardando()"
              (cantidad)="onCantidadTabla($event)"
              (quitar)="onQuitarTabla($event)"
            />
          }
        </div>
        </div>

        <!-- ── Riel fijo: totales del SERVIDOR, entregables y asistente IA ──────────────────── -->
        <aside class="rail" aria-label="Resumen de la cotización">
          <div class="card rail-card">
            <div class="rail-totales">
              @if (impuestos(); as t) {
                <div class="tot-row"><span>Subtotal sin impuestos ({{ q.lines.length }} renglones)</span><b>{{ t.subtotal | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                <div class="tot-row"><span>IVA</span><b>{{ t.iva | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                <div class="tot-row"><span>IEPS</span><b>{{ t.ieps | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              }
              <div class="tot-row tot-final"><span>Total</span><b>{{ num(q.total) | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
              @if (num(q.terms_discount_pct)) {
                <p class="tot-nota">
                  Incluye el {{ num(q.terms_discount_pct) }}% del cliente, aplicado sobre el subtotal —
                  no sobre el precio de cada renglón.
                </p>
              }
              @if (impuestos()?.impuesto_asumido) {
                <p class="tot-nota">
                  Impuesto estimado en {{ impuestos()?.impuesto_asumido }} renglón(es): IVA 16 % asumido,
                  porque se cotizaron antes de que se guardara la tasa de cada producto.
                </p>
              }
            </div>
            <!-- [E.27] De dónde sale el descuento, mecanismo por mecanismo. Cierra exacto contra el importe.
                 [E.28] Sin «unidad mayor»: Kepler cobra la presentación capturada, no prorratea solo. -->
            @if (desglose(); as d) {
              <div class="rail-totales rail-desglose" aria-label="Desglose del descuento">
                <div class="tot-row"><span><b>Desglose del descuento</b></span></div>
                <div class="tot-row"><span>Precio de lista</span><b>{{ d.lista | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                @if (d.volumen > 0) {
                  <div class="tot-row"><span>Por volumen</span><b>− {{ d.volumen | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                } @else if (d.volumen < 0) {
                  <div class="tot-row"><span>Tramo de volumen más caro que la lista</span><b>+ {{ -d.volumen | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                }
                @if (d.promocion) {
                  <div class="tot-row"><span>Por promoción</span><b>− {{ d.promocion | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                }
                @if (d.sin_desglose) {
                  <div class="tot-row"><span>Sin desglose ({{ d.renglones_sin_desglose }} renglón(es))</span><b>− {{ d.sin_desglose | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                }
                @if (d.redondeo) {
                  <div class="tot-row"><span>Redondeo a centavos</span><b>{{ d.redondeo | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                }
                <div class="tot-row"><span>Importe de los artículos</span><b>{{ d.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                @if (impuestos(); as t) {
                  @if (t.descuento) {
                    <div class="tot-row"><span>Descuento del cliente ({{ t.descuento_pct }}%)</span><b>− {{ t.descuento | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                  }
                }
                @if (d.renglones_sin_desglose) {
                  <p class="tot-nota">Los renglones sin desglose cambiaron de precio en Kepler desde que se cotizaron: re-cotiza para ver de dónde sale cada descuento.</p>
                }
              </div>
            }
            <div class="rail-actions">
              <div class="rail-export">
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
                  <span class="p-button-label">Excel</span>
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
            @if (q.customer_request) {
              <details class="cruda">
                <summary>La lista del cliente, como llegó</summary>
                <pre>{{ q.customer_request }}</pre>
              </details>
            }
          </div>

          <div class="ia-placeholder" role="note">
            <h3><i class="pi pi-sparkles" aria-hidden="true"></i> Asistente de ventas IA</h3>
            <p>Aquí aparecerán sugerencias para esta cotización: productos que el cliente suele llevar, oportunidades de volumen y qué le falta a su canasta.</p>
            <span class="ia-tag">Próximamente</span>
          </div>
        </aside>
        </div>
      }
    </section>
  `,
  styles: [
    `
      /* COT.18: mismo esqueleto que el alta (COT.16) — pantalla apaisada, zona de trabajo + riel
         fijo a la derecha, cada línea vertical cuenta. Bajo 1100px el riel baja debajo. */
      .section { padding: 0.6rem 1rem 1rem; max-width: 1600px; margin: 0 auto; }
      .page-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
      .page-head h1 { font-size: 1.05rem; font-weight: 700; margin: 0; font-family: var(--font-mono, monospace); }
      .head-cliente { font-size: var(--fs-body); font-weight: 600; color: var(--text-main); }
      .crumb-sep { color: var(--text-faint); }
      .back { display: inline-flex; gap: 0.3rem; align-items: center; font-size: var(--fs-xs); color: var(--text-muted); text-decoration: none; }
      .back:hover { color: var(--text-main); }
      .back:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 4px; }

      .layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 0.75rem; align-items: start; }
      .work { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
      .rail { position: sticky; top: 0.6rem; display: flex; flex-direction: column; gap: 0.6rem; }
      @media (max-width: 68.75rem) {
        .layout { grid-template-columns: 1fr; }
        .rail { position: static; }
      }
      .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
      .card-head {
        display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.65rem; min-height: 38px;
        border-bottom: 1px solid var(--border-color); background: var(--surface-ground, #fafafa);
      }
      .card-head h2 { font-size: var(--fs-body); font-weight: 700; margin: 0; }
      .badge-count { font-size: var(--fs-xs); background: var(--surface-ground); padding: 2px 6px; border-radius: 9999px; font-weight: 600; color: var(--text-muted); }

      /* Excel/PDF son p-button severity success/danger: el tema de PrimeNG los colorea en claro y oscuro. */
      .btn-export-xlsx, .btn-export-pdf { font-weight: 600; justify-content: center; }

      /* Riel: totales (del servidor), entregables, lista del cliente y asistente IA */
      .rail-card { display: flex; flex-direction: column; }
      .rail-totales { padding: 0.65rem 0.75rem 0.5rem; display: flex; flex-direction: column; gap: 0.15rem; }
      .tot-row { display: flex; justify-content: space-between; gap: 1rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .tot-row b { color: var(--text-main); font-variant-numeric: tabular-nums; text-align: right; }
      .tot-final { font-size: var(--fs-body); font-weight: 700; color: var(--text-main); border-top: 1px solid var(--border-color); padding-top: 0.35rem; margin-top: 0.2rem; align-items: baseline; }
      .tot-final b { font-weight: 800; font-size: 1.3rem; color: var(--action); }
      .tot-nota { margin: 0.35rem 0 0; font-size: 0.7rem; color: var(--text-muted); }
      .rail-actions { padding: 0.5rem 0.75rem 0.65rem; border-top: 1px solid var(--border-color); }
      .rail-export { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
      .ia-placeholder {
        border: 1px dashed var(--ember-border, rgba(240, 90, 40, 0.3)); border-radius: 8px; padding: 0.7rem 0.75rem;
        background: var(--ember-soft, rgba(248, 180, 0, 0.12));
      }
      .ia-placeholder h3 { margin: 0 0 0.25rem; font-size: var(--fs-sm); font-weight: 700; display: flex; align-items: center; gap: 0.35rem; }
      .ia-placeholder h3 i { color: var(--action); }
      .ia-placeholder p { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
      .ia-tag {
        display: inline-block; margin-top: 0.45rem; font-size: var(--fs-nano); font-weight: 700; letter-spacing: 0.05em;
        text-transform: uppercase; color: var(--action); background: var(--card-bg); border-radius: 9999px; padding: 1px 8px;
      }

      .loading { display: flex; justify-content: center; padding: 3rem 0; }
      .aviso { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0; padding: 0.5rem 0.75rem;
               border: 1px solid var(--border-color); border-left-width: 3px; border-radius: 8px;
               background: var(--card-bg); font-size: var(--fs-sm); color: var(--text-muted); }
      .aviso i { color: var(--action); margin-top: 0.1rem; }
      .aviso-bad { border-left-color: var(--bad-fg); }
      .aviso-bad i { color: var(--bad-fg); }
      .aviso-accion { margin-left: auto; flex-shrink: 0; }
      /* [E.27] existencia que no alcanza, y los pasos del precio bajo la etiqueta */
      .rail-desglose { margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color); }

      /* Condiciones congeladas en UNA tira (antes 5–6 tarjetas de ~75 px de alto) */
      .terms-line {
        display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem 0.6rem;
        padding: 0.4rem 0.75rem; font-size: var(--fs-xs); color: var(--text-main);
      }
      .tl { display: inline-flex; align-items: baseline; gap: 0.25rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .tl-lbl { color: var(--text-muted); }
      .tl-ico { color: var(--text-muted); font-size: 0.7rem; align-self: center; }
      .tl-sep { width: 1px; height: 0.85rem; background: var(--border-color); }
      .t-strong { font-weight: 700; color: var(--text-main); }
      .t-none { font-style: italic; color: var(--text-muted); }
      .t-sub { font-size: 0.7rem; color: var(--text-muted); }
      .vencida { color: var(--bad-fg); font-weight: 600; }

      /* ── Agregar artículo: etiqueta y buscador en la misma fila ────────────── */
      .captura-card { overflow: visible; }
      .captura-body { padding: 0.5rem 0.65rem; }
      .search-step {
        position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr);
        align-items: center; column-gap: 0.6rem;
      }
      .captura-lbl {
        font-size: var(--fs-body); font-weight: 700; color: var(--text-main); white-space: nowrap;
        display: inline-flex; align-items: center; gap: 0.35rem;
      }
      .captura-lbl i { color: var(--action); }
      .search-input-wrap { position: relative; display: flex; align-items: center; }
      .search-ico { position: absolute; left: 0.65rem; color: var(--text-muted); font-size: var(--fs-sm); pointer-events: none; }
      .search-spinner { position: absolute; right: 0.65rem; color: var(--action); font-size: var(--fs-sm); }
      .input.search-prod-input { padding-left: 2rem; font-size: var(--fs-sm); min-height: 34px; border-radius: 6px; width: 100%; }
      .search-hint { grid-column: 2; }

      /* Desplegable: debajo del buscador (columna 2), no debajo de la etiqueta */
      .cat-dropdown {
        grid-column: 2; grid-row: 1;
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
        list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow-y: auto;
        border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg);
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      }
      .cat-dropdown li + li { border-top: 1px solid var(--border-color); }
      .cat-row {
        width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.6rem 0.85rem; background: none; border: 0; cursor: pointer; text-align: left;
        color: var(--text-main); font-size: var(--fs-sm);
      }
      .cat-row:hover, .cat-row-active { background: var(--hover-bg); }
      .cat-col-nom { flex: 1 1 auto; min-width: 0; }
      .cat-nom { font-size: var(--fs-body); display: inline-block; }
      .cat-cont { color: var(--text-muted); font-size: var(--fs-xs); margin-left: 0.35rem; }
      .cat-col-meta { display: flex; gap: 0.5rem; font-size: var(--fs-xs); color: var(--text-muted); flex: 0 0 auto; }
      .cat-sku { font-family: var(--font-mono, monospace); font-weight: 600; }
      .cat-bc { font-variant-numeric: tabular-nums; }
      .cat-un { font-weight: 600; background: var(--surface-ground); padding: 1px 4px; border-radius: 4px; }
      .cat-col-precio { text-align: right; flex: 0 0 5.5rem; display: flex; flex-direction: column; }
      .cat-precio-val { font-weight: 700; font-size: var(--fs-body); font-variant-numeric: tabular-nums; }
      .cat-precio-lbl { font-size: 0.65rem; color: var(--text-muted); }
      .search-hint { font-size: var(--fs-sm); color: var(--text-muted); margin: 0.5rem 0 0; }

      /* Tarjeta de producto descargado */
      /* COT.18: la tarjeta pasa de una columna alta a filas que se acomodan (unidad · cantidad ·
         precio + Agregar en una fila cuando hay ancho). */
      .descargado-box {
        background: var(--surface-ground); border: 1px solid var(--border-color);
        border-radius: 8px; padding: 0.55rem 0.7rem; margin-top: 0.5rem;
        display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.5rem 0.9rem;
      }
      /* Fila 1: nombre + datos + "Cambiar artículo". Fila 2: unidad · cantidad. Fila 3: precio. */
      .descargado-info { order: 0; flex: 1 1 60%; }
      .descargado-box > .descargado-header { order: 1; flex: 0 0 auto; margin-left: auto; }
      .descargado-box > .pregunta-seccion, .descargado-box > .touch-qty-seccion { order: 2; }
      .descargado-box > .previa-card, .descargado-box > .previa-loading { order: 3; flex: 1 1 100%; }
      .descargado-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
      .descargado-tag {
        display: inline-flex; align-items: center; gap: 0.35rem; font-size: var(--fs-xs);
        font-weight: 700; color: var(--ok-fg, #15803d); text-transform: uppercase; letter-spacing: 0.03em;
      }
      .btn-change-prod {
        background: none; border: 0; color: var(--action); cursor: pointer; font-size: var(--fs-sm);
        font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.2rem 0.4rem;
      }
      .btn-change-prod:hover { text-decoration: underline; }

      /* Nombre + datos en un renglón: la primera fila de la tarjeta */
      /* El nombre ya dice cuál está elegido: la etiqueta "Artículo seleccionado" sobra. */
      .descargado-header .descargado-tag { display: none; }
      .descargado-info { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; }
      .descargado-name { font-size: var(--fs-body); font-weight: 700; color: var(--text-main); }
      .descargado-pills { display: flex; gap: 0.35rem; flex-wrap: wrap; }
      .pill-meta { font-size: var(--fs-micro); color: var(--text-muted); background: var(--card-bg); padding: 0.1rem 0.4rem; border-radius: 4px; border: 1px solid var(--border-color); }
      .pill-meta b { color: var(--text-main); }

      /* Unidad de venta: botones en línea, de menor a mayor */
      .pregunta-seccion { display: flex; flex-direction: column; gap: 0.2rem; }
      .pregunta-lbl { font-size: var(--fs-micro); font-weight: 600; color: var(--text-muted); }
      .unit-toggle-group { display: flex; gap: 0.35rem; flex-wrap: wrap; }
      .unit-toggle-btn {
        display: inline-flex; align-items: center; gap: 0.3rem;
        padding: 0.3rem 0.6rem; border-radius: 6px; border: 1.5px solid var(--border-color);
        background: var(--card-bg); cursor: pointer; min-height: 34px; text-align: left;
        transition: border-color 0.15s, background-color 0.15s;
      }
      .unit-toggle-btn i { font-size: var(--fs-sm); color: var(--text-muted); }
      .unit-toggle-btn:hover { border-color: var(--action); }
      .unit-toggle-active { border-color: var(--action); background: color-mix(in srgb, var(--action) 8%, transparent); }
      .unit-toggle-active i { color: var(--action); }
      .unit-title { font-weight: 700; font-size: var(--fs-sm); color: var(--text-main); }
      .unit-sub { font-size: var(--fs-micro); color: var(--text-muted); }

      /* Cantidad: stepper + incrementos en una fila */
      .touch-qty-seccion { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem 0.5rem; }
      .touch-qty-seccion .pregunta-lbl { flex: 1 1 100%; }
      .touch-stepper { display: flex; align-items: center; gap: 0.3rem; }
      .btn-touch-step {
        width: 34px; height: 34px; flex: none; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: 1.15rem; font-weight: 700; color: var(--text-main);
        cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        user-select: none; -webkit-tap-highlight-color: transparent;
      }
      .btn-touch-step:active { background: var(--hover-bg); transform: scale(0.96); }
      .btn-touch-step:disabled { opacity: 0.4; cursor: not-allowed; }
      .touch-qty-readout {
        min-width: 5.5rem; height: 34px; padding: 0 0.5rem; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); display: flex; align-items: baseline; justify-content: center; gap: 0.3rem;
        font-variant-numeric: tabular-nums; line-height: 32px;
      }
      .qty-num { font-size: 1rem; font-weight: 800; color: var(--text-main); }
      .qty-lbl { font-size: var(--fs-micro); color: var(--text-muted); text-transform: uppercase; font-weight: 600; }

      .touch-presets { display: flex; gap: 0.25rem; flex-wrap: wrap; }
      .preset-btn {
        min-height: 30px; padding: 0.2rem 0.5rem; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; color: var(--text-muted);
      }
      .preset-btn:hover, .preset-btn:active { background: var(--hover-bg); color: var(--text-main); }
      .preset-active { background: var(--action); color: var(--action-ink, #fff); border-color: var(--action); }

      /* Previa del precio y volumen */
      .previa-loading { font-size: var(--fs-sm); color: var(--text-muted); padding: 0.5rem 0; }
      .previa-card {
        border-radius: 6px; padding: 0.45rem 0.7rem; border: 1px solid var(--border-color);
        border-left: 3px solid var(--ok-fg, #15803d); background: var(--card-bg);
      }
      .previa-card-bad { border-left-color: var(--bad-fg, #dc2626); }
      .previa-top { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem 1.25rem; flex-wrap: wrap; }
      .previa-unit-box { flex: 0 1 auto; }
      .previa-total-box { flex: 0 1 auto; }
      .previa-action-box { margin-left: auto; display: flex; align-items: center; }
      .btn-agregar-inline {
        min-height: 34px; font-size: var(--fs-sm); font-weight: 700; border-radius: 6px;
        padding: 0.35rem 1rem; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }
      @media (max-width: 40rem) {
        .previa-action-box { width: 100%; margin-left: 0; margin-top: 0.4rem; }
        .btn-agregar-inline { width: 100%; justify-content: center; }
      }
      .previa-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; display: block; }
      .previa-price-row { display: flex; align-items: baseline; gap: 0.35rem; }
      .previa-amount { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .previa-unit-sub { font-size: var(--fs-xs); color: var(--text-muted); }
      .previa-menor-sub { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 600; margin-left: 0.25rem; }
      .previa-total-amount { font-size: 1.05rem; font-weight: 800; color: var(--text-main); font-variant-numeric: tabular-nums; }
      .previa-none { font-size: var(--fs-body); font-style: italic; color: var(--bad-fg); }

      /* Oportunidad de volumen. Sin azul (DESIGN.md): tokens de acción, como el alta (COT.16). */
      .banner-oportunidad-volumen {
        display: flex; justify-content: space-between; align-items: center; gap: 0.5rem 0.75rem;
        padding: 0.35rem 0.6rem; background: var(--ember-soft, rgba(248, 180, 0, 0.12));
        border: 1px dashed var(--ember-border, rgba(240, 90, 40, 0.35));
        border-radius: 6px; font-size: var(--fs-xs); color: var(--text-main); margin: 0.4rem 0 0; flex-wrap: wrap;
      }
      .b-vol-left { display: flex; align-items: center; gap: 0.4rem; flex: 1 1 280px; }
      .b-vol-icon { font-size: var(--fs-body); color: var(--action); flex-shrink: 0; }
      .b-vol-icon-ok { font-size: var(--fs-body); color: var(--ok-fg, #15803d); flex-shrink: 0; }
      .b-vol-text { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.1rem 0.4rem; }
      .b-vol-title { font-weight: 700; color: var(--text-main); }
      .b-vol-desc { font-size: var(--fs-xs); color: var(--text-muted); }
      .strikethrough { text-decoration: line-through; opacity: 0.65; margin: 0 0.2rem; }
      .btn-aplicar-volumen {
        background: var(--action); color: var(--action-ink, #fff); border: 0; border-radius: 6px;
        padding: 0.3rem 0.7rem; font-size: var(--fs-xs); font-weight: 700;
        cursor: pointer; display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap;
      }
      .btn-aplicar-volumen:hover { filter: brightness(0.95); }

      .banner-volumen-exito {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: var(--ok-soft-bg); border: 1px solid var(--ok-border); border-radius: 6px;
        font-size: var(--fs-xs); color: var(--ok-soft-fg); margin: 0.4rem 0 0;
      }

      .unit-badge-mayoreo {
        font-size: var(--fs-micro); font-weight: 700; color: var(--ok-soft-fg); background: var(--ok-soft-bg);
        padding: 2px 6px; border-radius: 4px; display: inline-block; margin-top: 0.2rem;
      }

      .banner-volumen {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.65rem;
        background: var(--ok-soft-bg); border: 1px solid var(--ok-border);
        border-radius: 6px; font-size: var(--fs-sm); color: var(--ok-soft-fg); margin: 0.5rem 0;
      }
      .banner-regalo {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.65rem;
        background: var(--info-soft-bg); border: 1px solid var(--info-border);
        border-radius: 6px; font-size: var(--fs-sm); color: var(--info-soft-fg); margin: 0.5rem 0;
      }
      .p-step-row { display: flex; align-items: center; gap: 0.5rem; font-size: var(--fs-xs); margin-top: 0.25rem; flex-wrap: wrap; }
      .step-tag { font-weight: 700; color: var(--text-main); }
      .step-detail { color: var(--text-muted); }
      .step-delta { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ok-fg, #15803d); }
      .p-why-bad { color: var(--bad-fg, #dc2626); font-size: var(--fs-xs); margin: 0.3rem 0 0; }

      /* Precio + desglose en UNA línea (antes 3: precio, "(12 PAQ", "$78.56)") */
      .p-unit-cell { display: flex; align-items: baseline; justify-content: flex-end; gap: 0.35rem; white-space: nowrap; }
      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 500; }

      .sin-casar-box { margin-top: 0.5rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem; }
      .sin-casar-hint { font-size: var(--fs-xs); color: var(--text-muted); }

      /* Tabla de renglones */
      /* [E.29] La tabla de renglones es app-quote-lines-table (compartida con el alta): su CSS vive allá. */
      .table-card { overflow-x: auto; }
      .p-name { display: inline-block; max-width: 22rem; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }

      .empty { padding: 1.5rem 1rem; text-align: center; }
      .empty-title { margin: 0 0 0.35rem; font-weight: 600; }
      .empty-hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }

      /* La lista del cliente, plegada en el riel */
      .cruda { padding: 0.45rem 0.75rem 0.55rem; border-top: 1px solid var(--border-color); font-size: var(--fs-xs); }
      .cruda summary { cursor: pointer; color: var(--text-muted); }
      .cruda pre { margin: 0.35rem 0 0; max-height: 14rem; overflow: auto; white-space: pre-wrap; font-family: var(--font-mono, monospace); font-size: var(--fs-xs); color: var(--text-muted); }

      .input { width: 100%; padding: 0.45rem 0.7rem; box-sizing: border-box; border: 1px solid var(--border-color);
               border-radius: 6px; font-size: var(--fs-body); background: var(--card-bg); color: var(--text-main); min-height: 36px; }
      .input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }

    `,
  ],
})
export class TeleventaQuoteDetailComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly injector = inject(Injector);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  /** [E.29] El alta pide el papel al crear (?descargar=pdf|xlsx): se descarga UNA vez, ya con folio. */
  private descargarAlCargar: 'pdf' | 'xlsx' | null = null;

  readonly peldanos = PELDANOS;

  readonly cot = signal<QuoteDetail | null>(null);

  /**
   * `[E.25]` Subtotal, IVA e IEPS con la tasa de CADA renglón: la misma función del servidor
   * (`recalcTotals`) y del papel. Antes el riel mostraba «Impuestos» calculados al 16 % sobre todo.
   */
  readonly impuestos = computed(() => {
    const q = this.cot();
    if (!q) return null;
    return totalesCotizacion(
      q.lines.map((l) => (this.num(l.unit_price) === null ? null : Number(l.line_total) || 0)),
      this.num(q.terms_discount_pct),
      q.lines.map((l) => ({ iva: this.num(l.iva_rate), ieps: this.num(l.ieps_rate) })),
    );
  });
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
  /** [E.29] El foco está en el buscador: sólo entonces una respuesta puede abrir la lista. */
  private buscadorEnFoco = false;

  termino = '';
  cantidad = 1;

  private id = '';
  private readonly previa$ = new Subject<void>();
  private readonly buscar$ = new Subject<void>();

  // COT.19: editable = borrador Y el usuario puede escribir en su sucursal. `branch_writable`
  // ausente (API vieja) se trata como `true`: el servidor valida igual y responde 403.
  readonly editable = computed(() => this.cot()?.status === 'draft' && this.cot()?.branch_writable !== false);

  /** [E.29] Los renglones como los pinta la tabla compartida con el alta (app-quote-lines-table). */
  readonly renglonesVista = computed<RenglonTabla[]>(() => {
    const q = this.cot();
    if (!q) return [];
    const editable = this.editable();
    const revisando = this.revisando();
    this.revisionPorRenglon(); // dependencia explícita: la existencia llega después de la cotización
    return q.lines.map((l) => {
      const rv = this.revisionDe(l);
      const existencia: RenglonTabla['existencia'] = l.parent_line_number !== null ? null
        : rv ? (rv.stock && rv.stock.in_line_unit !== null
          ? { cantidad: rv.stock.in_line_unit, unidad: rv.stock.line_unit || rv.stock.base_unit || '', faltan: this.faltante(rv) }
          : 'sin-dato')
        : revisando ? 'cargando' : null;
      return {
        id: l.id,
        numero: l.line_number,
        nombre: l.product_name || l.requested_text || '—',
        sinCasar: !l.product_id,
        regaloDe: l.parent_line_number,
        notaRegalo: null,
        unidad: l.qty_unit,
        factor: this.num(l.qty_factor),
        cantidad: this.num(l.quantity) ?? 0,
        editable,
        admiteFraccion: this.admiteFraccionLinea(l),
        existencia,
        lista: this.num(l.list_price),
        precio: this.num(l.unit_price),
        desglose: this.desgloseDeLinea(l),
        fuente: l.price_source,
        dtoPct: this.num(l.discount_pct),
        pasos: this.pasosDe(l),
        explicacion: this.explicacionDe(l),
        importe: this.num(l.line_total),
      };
    });
  });

  onCantidadTabla(e: CambioCantidad): void {
    const l = this.cot()?.lines.find((x) => x.id === e.id);
    if (l) this.pedirCambio(l, e.input);
  }

  onQuitarTabla(id: string): void {
    const l = this.cot()?.lines.find((x) => x.id === id);
    if (l) this.quitar(l);
  }

  /** [E.27] La cotización contra Kepler HOY (precio, pasos del descuento, existencia). No escribe. */
  readonly revision = signal<QuoteCheck | null>(null);
  readonly revisando = signal(false);
  readonly revisionError = signal<string | null>(null);
  readonly revisionPorRenglon = computed(() => new Map((this.revision()?.lines ?? []).map((x) => [x.line_id, x])));

  /**
   * [E.27] El descuento por mecanismo. Los pasos de un renglón sólo cuentan si el motor de hoy
   * reproduce su precio guardado; si Kepler lo movió, va a «sin desglose» con lo guardado.
   */
  readonly desglose = computed(() => {
    const q = this.cot();
    const rev = this.revision();
    const porRenglon = this.revisionPorRenglon();
    if (!q || !rev) return null;
    return desgloseDescuento(
      q.lines.filter((l) => l.parent_line_number === null).map((l) => {
        const rv = porRenglon.get(l.id);
        return {
          quantity: Number(l.quantity) || 0,
          unit_price: this.num(l.unit_price),
          list_price: this.num(l.list_price),
          line_total: this.num(l.unit_price) === null ? null : Number(l.line_total) || 0,
          pasos: rv?.now && !rv.price_changed ? rv.now.applied : null,
        };
      }),
    );
  });
  readonly puedeAgregar = computed(() => !!this.previa() && this.previa()!.unit_price !== null);

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') || '';
    const pedido = this.route.snapshot.queryParamMap.get('descargar');
    this.descargarAlCargar = pedido === 'pdf' || pedido === 'xlsx' ? pedido : null;
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
        // [E.29] Sólo si la persona sigue en el buscador: una respuesta tardía no la reabre encima.
        this.catalogoAbierto.set(this.buscadorEnFoco);

        const t = this.termino.trim();
        if (ordenados.length === 1 && t && (ordenados[0].sku.toUpperCase() === t.toUpperCase() || ordenados[0].barcode === t)) {
          this.elegir(ordenados[0]);
        }
      });

    this.recargar();
  }

  /**
   * @param silencioso [E.20] true = refresca los datos SIN el estado de carga global. Después de
   * editar un renglón, el spinner desmontaba la página entera (y con ella el buscador al que
   * `volverAlBuscador` quería regresar).
   */
  recargar(silencioso = false): void {
    if (!silencioso) this.cargando.set(true);
    this.svc.getOne(this.id).subscribe({
      next: (q) => {
        this.cot.set(q);
        this.error.set(null);
        this.revisar();
        this.cargando.set(false);
        const pedido = this.descargarAlCargar;
        if (pedido) {
          this.descargarAlCargar = null;
          // Fuera de la URL: recargar la página no vuelve a descargar.
          this.router.navigate([], { relativeTo: this.route, queryParams: { descargar: null }, queryParamsHandling: 'merge', replaceUrl: true });
          void (pedido === 'pdf' ? this.descargarPdf() : this.descargarXlsx());
        }
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

  /** Entrar al campo NO abre la lista (E.29): se abre al teclear. */
  onFoco(): void {
    this.buscadorEnFoco = true;
  }

  /** Salir del buscador cierra la lista; moverse a una opción de la lista, no. */
  alSalirDelBuscador(e: FocusEvent): void {
    const destino = e.relatedTarget as Node | null;
    if (destino && (e.currentTarget as HTMLElement).contains(destino)) return;
    this.buscadorEnFoco = false;
    this.catalogoAbierto.set(false);
  }

  elegir(p: QuoteCatalogRow): void {
    this.elegido.set(p);
    this.catalogoAbierto.set(false);
    this.previa$.next();
  }

  limpiarEleccion(): void {
    this.elegido.set(null);
    this.previa.set(null);
    // [E.29] Vuelve al buscador; la lista se abre cuando se teclee, no sola.
    this.volverAlBuscador();
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

  /** "Padre Hidalgo" para la tira de condiciones (mismo catálogo que rotula el entregable). */
  nombreSucursal(code: string | null): string {
    return branchName(code);
  }

  /** [E.29] dd/mm/aaaa, como el papel (antes la vigencia salía en AAAA-MM-DD). */
  fechaCorta(iso: string | null | undefined): string {
    return fechaVigencia(iso).texto;
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
          this.recargar(true);
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
          this.recargar(true);
          this.guardando.set(false);
          this.volverAlBuscador();
        },
        error: (err) => this.falla(err, 'No se pudo guardar el renglón'),
      });
  }

  /** [E.20] Fracción sólo en lo que se pesa y en su unidad base (antes Math.floor: 2.5 kg → 2). */
  admiteFraccionLinea(l: QuoteLine): boolean {
    return !!l.product_sold_by_kg && this.rungDeLinea(l) === 'base';
  }

  pedirCambio(l: QuoteLine, input: HTMLInputElement): void {
    const actual = this.numOr0(l.quantity);
    const qty = parseCantidad(input.value, this.admiteFraccionLinea(l));
    if (qty === null) {
      // Lo que no se entiende no se guarda: el campo vuelve a la cantidad que sí tiene el renglón.
      input.value = String(actual);
      this.toast.add({
        severity: 'warn',
        summary: 'Cantidad no válida',
        detail: this.admiteFraccionLinea(l)
          ? 'Escribe una cantidad mayor que cero, por ejemplo 2.5.'
          : 'Escribe una cantidad entera mayor que cero.',
      });
      return;
    }
    if (qty === actual) return;
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
        this.recargar(true);
      },
      error: (err) => {
        this.falla(err, 'No se pudo cambiar la cantidad');
        this.recargar(true);
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
        this.recargar(true);
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
    afterNextRender(() => this.buscadorArticulo()?.nativeElement.focus(), { injector: this.injector });
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

  /** [E.27] Compara la cotización contra Kepler HOY. Si falla, la pantalla lo dice y muestra lo guardado. */
  revisar(): void {
    this.revisando.set(true);
    this.svc.check(this.id).subscribe({
      next: (r) => {
        this.revision.set(r);
        this.revisionError.set(null);
        this.revisando.set(false);
      },
      error: (err) => {
        this.revision.set(null);
        this.revisionError.set(err?.error?.message || 'el servidor no respondió.');
        this.revisando.set(false);
      },
    });
  }

  revisionDe(l: QuoteLine): QuoteCheckLine | null {
    return this.revisionPorRenglon().get(l.id) ?? null;
  }

  /** [E.27] Cuánto falta de existencia para surtir el renglón (en su unidad); 0 = alcanza o no se sabe. */
  faltante(rv: QuoteCheckLine): number {
    const hay = rv.stock?.in_line_unit;
    return hay === null || hay === undefined ? 0 : Math.max(0, Math.round((rv.quantity - hay) * 100) / 100);
  }

  /** [E.27] Los pasos del precio de hoy, sólo si reproducen el precio guardado (si no, no lo explican). */
  pasosDe(l: QuoteLine): string {
    const rv = this.revisionDe(l);
    if (!rv?.now || rv.price_changed) return '';
    return pasosDelPrecio(rv.now.applied, (n) => this.dinero(n));
  }

  /** [E.29] Qué descuento es, concreto; como los pasos, sólo si el precio de hoy es el guardado. */
  explicacionDe(l: QuoteLine): string {
    const rv = this.revisionDe(l);
    if (!rv?.now || rv.price_changed) return '';
    return explicacionDelPrecio(rv.now.applied);
  }

  pedirRecotizar(r: QuoteCheck): void {
    this.confirm.confirm({
      header: 'Re-cotizar a precios de hoy',
      message:
        'Los ' + r.lines.length + ' renglones se vuelven a cotizar con los precios, volúmenes y promociones de Kepler de hoy, '
        + 'y se guarda el IVA/IEPS de cada producto. El total pasa de ' + this.dinero(r.total_saved) + ' a '
        + this.dinero(r.total_now) + '.',
      icon: 'pi pi-refresh',
      acceptLabel: 'Sí, re-cotizar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-sm',
      rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => this.recotizar(),
    });
  }

  private recotizar(): void {
    this.guardando.set(true);
    this.svc.reprice(this.id).subscribe({
      next: (res) => {
        this.guardando.set(false);
        this.toast.add({
          severity: 'success',
          summary: 'Re-cotizada a precios de hoy',
          detail: res.changed + ' de ' + res.lines + ' renglones cambiaron de precio.',
        });
        this.recargar(true);
      },
      error: (err) => {
        this.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se re-cotizó', detail: err?.error?.message || 'El servidor no respondió.' });
      },
    });
  }

  dinero(v: number | string | null | undefined): string {
    const n = this.num(v);
    return n === null ? '—' : n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  fuenteLabel(s: string): string { return etiquetaFuentePrecio(s); }

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
    const sucursalCod = q.source_branch || ''; // COT.19: sin sucursal no se inventa la 01
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
      iva_rate: this.num(l.iva_rate),
      ieps_rate: this.num(l.ieps_rate),
      price_source: this.fuenteLabel(l.price_source),
      // [E.29] La lista: con ella el papel desglosa el descuento del producto, como la pantalla.
      list_price: this.num(l.list_price),
      free_goods: null,
      // [E.19] El regalo del ERP se imprime «Regalo», no $0.00. Y ya no viaja un descuento por
      // renglón: el de volumen/promo YA está en `unit_price`, y pasarlo lo aplicaba dos veces
      // (auditoría C2: 123 renglones de 18 cotizaciones impresos $8,539.97 por debajo).
      regalo: l.price_source === 'free_goods',
    }));

    // [E.19] El papel hace la MISMA cuenta que el servidor y se niega a salir si no reproduce el
    // total guardado. Antes restaba el descuento a un subtotal que ya lo traía y no traía IVA (C1).
    const estado: QuoteDeliverableData['estado'] =
      q.status === 'cancelled' ? 'cancelada'
      : (q.status === 'draft' || q.status === 'sent') && q.days_to_expiry < 0 ? 'vencida'
      : 'vigente';

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
      // [E.19] El vendedor viaja en su columna; la regex sobre `notes` nunca lo encontraba.
      salespersonName: q.salesperson_name || this.vendedorAsignado(q) || null,
      quoteDate: q.quote_date || new Date(),
      validUntil: q.valid_until,
      items,
      discountPct: this.num(q.terms_discount_pct),
      paymentDays: this.num(q.terms_payment_days),
      totalGuardado: this.num(q.total),
      estado,
      // Notas PARA EL CLIENTE. ⛔ No `customer_request`: es el mensaje crudo que pegó el operador.
      notes: q.notes || null,
      // [E.29] Control: versión (última modificación), quién la elaboró (el nombre; el usuario si el
      // API todavía no lo manda) y el pedido en que se convirtió.
      actualizada: q.updated_at ?? null,
      elaboro: q.created_by_name || q.created_by_username || null,
      orderCode: q.order_code || null,
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

