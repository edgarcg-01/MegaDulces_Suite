import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { Subject, debounceTime, distinctUntilChanged, switchMap, catchError, of, from, concatMap, toArray, map } from 'rxjs';
import { STORE_BRANCHES, type StoreBranch } from '../../../core/constants/store-branches';
import {
  QuotesService,
  WholesaleCustomer,
  WholesaleBranchTerms,
  QuoteOrigin,
  QuoteCatalogRow,
  PricedLine,
  Rung,
} from '../quotes.service';
import {
  exportQuotePdf,
  exportQuoteXlsx,
  type QuoteDeliverableData,
} from '../quote-deliverable-export';

/**
 * Las 8 sucursales de la red de sucursales Kepler (01..08).
 * Siempre presentes en el despliegue del menú.
 */
export const SUCURSALES_8: StoreBranch[] = [
  { code: '01', name: 'Padre Hidalgo' },
  { code: '02', name: 'La Piedad Abastos' },
  { code: '03', name: '8 Esquinas' },
  { code: '04', name: 'Yurécuaro' },
  { code: '05', name: 'Zamora Centro' },
  { code: '06', name: 'Canindo' },
  { code: '07', name: 'Morelia Madero' },
  { code: '08', name: 'Morelia Abastos' },
];

export interface ItemBandeja {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  content: string | null;
  rung: Rung;
  unit_label: string;
  factor: number | null;
  quantity: number;
  unit_price: number | null;
  line_total: number;
  price_source: string;
  free_goods?: { sku: string; quantity: number } | null;
}

const ORIGENES: Array<{ value: QuoteOrigin; label: string; hint: string }> = [
  { value: 'telemarketing', label: 'El cliente mandó su lista', hint: 'Llegó por correo o WhatsApp pidiendo precio' },
  { value: 'route_visit', label: 'Visita de ruta', hint: 'Se levantó en el punto de venta' },
  { value: 'counter', label: 'Mostrador', hint: 'Preguntó en la sucursal' },
];

@Component({
  selector: 'app-televenta-quote-new',
  standalone: true,
  imports: [
    ToastModule,
    CommonModule,
    FormsModule,
    RouterModule,
    ButtonModule,
    ProgressSpinnerModule,
    TagModule,
    TableModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast position="top-center"></p-toast>
    <section class="section">
      <div class="top-bar">
        <a routerLink="/telemarketing/cotizaciones" class="back">
          <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a cotizaciones
        </a>
      </div>

      <header class="section-header">
        <div class="header-content">
          <h1>Nueva cotización</h1>
          <p>Cotizador de mayoreo: seleccioná destinatario, sucursal y agregá artículos a la bandeja con precio en vivo.</p>
        </div>
      </header>

      <!-- ── BLOQUE 1: Destinatario & Selector de las 8 Sucursales ────────────────────── -->
      <div class="card card-destinatario">
        <div class="card-head">
          <div class="card-head-left">
            <span class="step-num">1</span>
            <h2>Destinatario</h2>
            <div class="pills" role="group" aria-label="Tipo de destinatario">
              <button
                type="button"
                class="pill"
                [class.pill-active]="modo() === 'mayoreo'"
                (click)="setModo('mayoreo')"
              >
                Mayoreo ERP
              </button>
              <button
                type="button"
                class="pill"
                [class.pill-active]="modo() === 'contacto'"
                (click)="setModo('contacto')"
              >
                Todavía no es cliente
              </button>
            </div>
          </div>

          <!-- MENÚ DESPLEGABLE CON LAS 8 SUCURSALES (SIEMPRE DISPONIBLES) -->
          <div class="sucursal-dropdown-box">
            <label for="sucursalSelect" class="suc-label">
              <i class="pi pi-building" aria-hidden="true"></i> Sucursal:
            </label>
            <select
              id="sucursalSelect"
              class="input-select"
              [ngModel]="sucursal()"
              (ngModelChange)="onSucursalChange($event)"
              [disabled]="guardando()"
            >
              @for (s of sucursales8; track s.code) {
                <option [value]="s.code">
                  Sucursal {{ s.code }} — {{ s.name }}
                  @if (cliente() && clienteTieneSucursal(s.code)) {
                    *
                  }
                </option>
              }
            </select>
          </div>
        </div>

        <!-- Condiciones comerciales compactas de la sucursal elegida -->
        @if (cliente() && sucursalTerms(); as t) {
          <div class="terms-bar">
            <div class="term-item">
              <span class="t-k">Descuento cliente:</span>
              @if (t.discount_1_pct !== null) {
                <span class="t-v t-accent">{{ +t.discount_1_pct }}%</span>
              } @else {
                <span class="t-v t-muted">sin descuento especial</span>
              }
            </div>
            <div class="term-sep" aria-hidden="true"></div>
            <div class="term-item">
              <span class="t-k">Límite crédito:</span>
              <span class="t-v">
                {{ t.credit_limit !== null ? (+t.credit_limit | currency:'MXN':'symbol-narrow':'1.0-0') : '—' }}
              </span>
            </div>
            <div class="term-sep" aria-hidden="true"></div>
            <div class="term-item">
              <span class="t-k">Plazo:</span>
              <span class="t-v">{{ t.payment_days !== null ? t.payment_days + ' días' : '—' }}</span>
            </div>
            @if (cliente()!.terms_vary_by_branch) {
              <div class="term-warn" title="Las condiciones de este cliente varían entre sucursales">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Condiciones cambian por sucursal
              </div>
            }
          </div>
        } @else if (cliente()) {
          <div class="terms-bar terms-bar-generic">
            <span class="t-muted">Condiciones base del ERP para la sucursal {{ sucursal() }} (sin descuento de mayoreo registrado en esta plaza).</span>
          </div>
        }

        <div class="card-body">
          @if (modo() === 'mayoreo') {
            @if (!cliente()) {
              <div class="search-container">
                <div class="search-box">
                  <i class="pi pi-search search-icon" aria-hidden="true"></i>
                  <input
                    type="search"
                    class="input search-input"
                    [(ngModel)]="terminoCliente"
                    (ngModelChange)="onBuscarCliente($event)"
                    (keyup.enter)="onEnterCliente()"
                    placeholder="Buscar código (ej. C1086) o nombre de cliente de mayoreo..."
                    aria-label="Buscar cliente de mayoreo"
                    autocapitalize="characters"
                    autocorrect="off"
                    spellcheck="false"
                  />
                  @if (buscandoCliente()) {
                    <i class="pi pi-spin pi-spinner search-spinner" aria-hidden="true"></i>
                  }
                </div>

                @if (resultadosClientes().length > 0) {
                  <ul class="results-dropdown" role="listbox" aria-label="Clientes de mayoreo">
                    @for (c of resultadosClientes(); track c.customer_code) {
                      <li>
                        <button type="button" class="result-row" (click)="elegirCliente(c)">
                          <span class="r-code">{{ c.customer_code }}</span>
                          <span class="r-name">{{ c.name }}</span>
                          <span class="r-state">{{ c.state || c.phone || '' }}</span>
                          @if (c.terms_vary_by_branch) {
                            <span class="r-badge-warn">multi-plaza</span>
                          }
                        </button>
                      </li>
                    }
                  </ul>
                } @else if (terminoCliente.trim().length > 0 && !buscandoCliente()) {
                  <p class="search-empty">Ningún cliente de mayoreo coincide con "{{ terminoCliente }}".</p>
                }
              </div>
            } @else {
              <!-- Cliente seleccionado: tarjeta compacta de 1 sola fila -->
              <div class="chosen-row">
                <div class="chosen-details">
                  <span class="chosen-code">{{ cliente()!.customer_code }}</span>
                  <strong class="chosen-name">{{ cliente()!.name }}</strong>
                  @if (cliente()!.state || cliente()!.phone) {
                    <span class="chosen-meta">({{ cliente()!.state || '' }} {{ cliente()!.phone || '' }})</span>
                  }
                </div>
                <button
                  type="button"
                  class="btn-change"
                  (click)="limpiarCliente()"
                  [disabled]="guardando()"
                  aria-label="Cambiar cliente"
                >
                  <i class="pi pi-pencil" aria-hidden="true"></i> Cambiar cliente
                </button>
              </div>
            }
          } @else {
            <!-- Modo contacto provisional -->
            <div class="contact-fields">
              <label class="field-item field-name">
                <span>Nombre o razón social <b>*</b></span>
                <input
                  type="text"
                  class="input"
                  [(ngModel)]="contactoNombre"
                  placeholder="Quién solicita la cotización"
                  [disabled]="guardando()"
                />
              </label>
              <label class="field-item">
                <span>Teléfono / WhatsApp</span>
                <input
                  type="tel"
                  class="input"
                  [(ngModel)]="contactoTel"
                  inputmode="tel"
                  placeholder="Ej. 352 123 4567"
                  [disabled]="guardando()"
                />
              </label>
              <label class="field-item">
                <span>Correo electrónico</span>
                <input
                  type="email"
                  class="input"
                  [(ngModel)]="contactoMail"
                  inputmode="email"
                  placeholder="cliente@dominio.com"
                  [disabled]="guardando()"
                />
              </label>
            </div>
          }

          <!-- VENDEDOR QUE DA SEGUIMIENTO: Justo debajo del nombre del cliente / datos -->
          <div class="vendedor-box">
            <div class="vendedor-inner">
              <label for="vendedorSelect" class="vendedor-label">
                <i class="pi pi-user" aria-hidden="true"></i> Vendedor de seguimiento:
              </label>
              <div class="vendedor-control">
                <select
                  id="vendedorSelect"
                  class="input-select vendedor-select"
                  [ngModel]="vendedorSeleccionado() || ''"
                  (ngModelChange)="onVendedorChange($event)"
                  [disabled]="guardando() || cargandoVendedores()"
                >
                  <option value="">-- Seleccionar vendedor que da seguimiento --</option>
                  @for (v of vendedores(); track v.code) {
                    <option [value]="v.code">
                      {{ v.code }} — {{ v.name }}
                    </option>
                  }
                </select>
                @if (cargandoVendedores()) {
                  <i class="pi pi-spin pi-spinner v-spinner" aria-hidden="true"></i>
                }
              </div>
              @if (vendedorSeleccionadoObj(); as vSel) {
                <span class="vendedor-hint">
                  Asignado: <strong>{{ vSel.name }}</strong> (Sucursal {{ sucursal() }})
                </span>
              }
            </div>
          </div>
        </div>
      </div>

      <!-- ── BLOQUE 2: Captura Manual de Artículos (Táctil, 16:9) ─────────────────────── -->
      <div class="card mt-card captura-manual-card">
        <div class="card-head">
          <div class="card-head-left">
            <span class="step-num">2</span>
            <h2>Captura manual de artículos</h2>
            <span class="captura-sub">Sucursal activa: <b>{{ sucursal() }} — {{ branchName(sucursal()) }}</b></span>
          </div>
        </div>

        <div class="card-body">
          <!-- Buscador de artículos por código de barras, código interno (SKU) o nombre -->
          <div class="search-step">
            <label class="f-lbl" for="prodSearchInput">
              <span>Buscar artículo (Código de barras, código interno SKU o nombre)</span>
            </label>
            <div class="search-input-wrap">
              <i class="pi pi-search search-ico" aria-hidden="true"></i>
              <input
                id="prodSearchInput"
                type="search"
                class="input search-prod-input"
                [(ngModel)]="terminoArticulo"
                (ngModelChange)="onTerminoArticulo($event)"
                (focus)="onFocoArticulo()"
                placeholder="Escaneá código de barras o escribí SKU / nombre del producto..."
                autocorrect="off"
                spellcheck="false"
                [disabled]="guardando()"
              />
              @if (buscandoArticulo()) {
                <i class="pi pi-spin pi-spinner search-spinner" aria-hidden="true"></i>
              }
            </div>

            <!-- Desplegable ordenado por orden alfabético del nombre del producto -->
            @if (catalogoAbierto() && resultadosArticulos().length > 0) {
              <ul class="cat-dropdown" role="listbox" aria-label="Catálogo ordenado alfabéticamente">
                @for (p of resultadosArticulos(); track p.sku) {
                  <li>
                    <button
                      type="button"
                      class="cat-row"
                      role="option"
                      [class.cat-row-active]="articuloElegido()?.sku === p.sku"
                      (click)="elegirArticulo(p)"
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
            } @else if (catalogoAbierto() && terminoArticulo.trim().length > 0 && !buscandoArticulo()) {
              <p class="search-hint">
                Ningún artículo en Sucursal {{ sucursal() }} coincide con <strong>"{{ terminoArticulo }}"</strong>.
              </p>
            }
          </div>

          <!-- Artículo elegido ("descargado") para configurar precio y cantidad -->
          @if (articuloElegido(); as e) {
            <div class="descargado-box">
              <div class="descargado-header">
                <div class="descargado-tag">
                  <i class="pi pi-check-circle" aria-hidden="true"></i>
                  <span>Artículo seleccionado</span>
                </div>
                <button type="button" class="btn-change-prod" (click)="limpiarArticulo()" [disabled]="guardando()">
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

              <!-- PREGUNTA: ¿El precio es por caja o por pieza? -->
              <div class="pregunta-seccion">
                <span class="pregunta-lbl">¿El precio es por caja o por pieza?</span>
                <div class="unit-toggle-group" role="group" aria-label="Seleccionar si el precio es por caja o pieza">
                  <!-- Opción Pieza (o KG) -->
                  <button
                    type="button"
                    class="unit-toggle-btn"
                    [class.unit-toggle-active]="rung() === 'base'"
                    (click)="setRung('base')"
                    [disabled]="guardando()"
                  >
                    <i class="pi pi-tag" aria-hidden="true"></i>
                    <span class="unit-title">{{ e.sold_by_kg ? 'Kilo (KG)' : 'Pieza' }}</span>
                    <span class="unit-sub">Unidad individual</span>
                  </button>

                  <!-- Opción Caja -->
                  <button
                    type="button"
                    class="unit-toggle-btn"
                    [class.unit-toggle-active]="rung() === 'box'"
                    (click)="setRung('box')"
                    [disabled]="guardando()"
                  >
                    <i class="pi pi-box" aria-hidden="true"></i>
                    <span class="unit-title">Caja</span>
                    <span class="unit-sub">
                      @if (e.box_size) {
                        {{ e.box_size }} {{ e.sold_by_kg ? 'kg' : (e.unit_base || 'pzas') }} / caja
                      } @else {
                        Empaque mayor
                      }
                    </span>
                    @if (rung() === 'box' && previaArticulo()?.volume_tier; as vt) {
                      <span class="unit-badge-mayoreo">
                        Mayoreo: {{ dinero(vt.price) }} ({{ vt.min_qty }}+ cjas)
                      </span>
                    }
                  </button>

                  <!-- Opción Paquete si aplica -->
                  @if (e.pack_size && e.pack_size > 1) {
                    <button
                      type="button"
                      class="unit-toggle-btn"
                      [class.unit-toggle-active]="rung() === 'pack'"
                      (click)="setRung('pack')"
                      [disabled]="guardando()"
                    >
                      <i class="pi pi-clone" aria-hidden="true"></i>
                      <span class="unit-title">Paquete</span>
                      <span class="unit-sub">{{ e.pack_size }} {{ e.unit_base || 'pzas' }}</span>
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
                    [disabled]="cantidadArticulo() <= 1 || guardando()"
                    aria-label="Restar una unidad"
                  >
                    <i class="pi pi-minus" aria-hidden="true"></i>
                  </button>

                  <div class="touch-qty-readout" aria-live="polite">
                    <span class="qty-num">{{ cantidadArticulo() }}</span>
                    <span class="qty-lbl">{{ labelUnidadActiva() }}{{ cantidadArticulo() > 1 ? (rung() === 'box' ? 's' : (rung() === 'base' && e.sold_by_kg ? '' : 's')) : '' }}</span>
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
                  <button type="button" class="preset-btn" (click)="setCantidad(1)" [class.preset-active]="cantidadArticulo() === 1" [disabled]="guardando()">1</button>
                  <button type="button" class="preset-btn" (click)="ajustarCantidad(5)" [disabled]="guardando()">+5</button>
                  <button type="button" class="preset-btn" (click)="ajustarCantidad(10)" [disabled]="guardando()">+10</button>
                  <button type="button" class="preset-btn" (click)="ajustarCantidad(25)" [disabled]="guardando()">+25</button>
                  <button type="button" class="preset-btn" (click)="ajustarCantidad(50)" [disabled]="guardando()">+50</button>
                  <button type="button" class="preset-btn" (click)="ajustarCantidad(100)" [disabled]="guardando()">+100</button>
                </div>
              </div>

              <!-- PREVIA DEL PRECIO Y DESCUENTOS POR VOLUMEN EN VIVO -->
              @if (cotizandoArticulo()) {
                <div class="previa-loading">
                  <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Consultando precios y descuentos en ERP...
                </div>
              } @else if (previaArticulo(); as p) {
                <div class="previa-card" [class.previa-card-bad]="p.unit_price === null">
                  <div class="previa-top">
                    <div class="previa-unit-box">
                      <span class="previa-label">Precio unitario calculado</span>
                      @if (p.unit_price !== null) {
                        <div class="previa-price-row">
                          <span class="previa-amount">{{ p.unit_price | currency:'MXN':'symbol-narrow':'1.2-4' }}</span>
                          <span class="previa-unit-sub">/ {{ p.unit_label || labelUnidadActiva() }}</span>
                          @if (p.unit_factor && p.unit_factor > 1) {
                            <span class="previa-menor-sub">({{ p.unit_factor }}PZS {{ (p.unit_price / p.unit_factor) | currency:'MXN':'symbol-narrow':'1.2-2' }})</span>
                          }
                        </div>
                      } @else {
                        <span class="previa-none">Sin precio en Sucursal {{ sucursal() }}</span>
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
                        [disabled]="!puedeAgregarArticulo() || guardando()"
                        (click)="agregarABandeja()"
                      >
                        <span class="p-button-icon p-button-icon-left pi pi-plus-circle" aria-hidden="true"></span>
                        <span class="p-button-label">Agregar a la bandeja</span>
                      </button>
                    </div>
                  </div>

                  <!-- AVISO DESTACADO DE ESCALÓN DE VOLUMEN (ERP kdpv_prod_util) -->
                  @if (p.volume_tier; as vt) {
                    @if (cantidadArticulo() < vt.min_qty) {
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
                                ({{ p.unit_factor }}PZS {{ (p.unit_price! / p.unit_factor) | currency:'MXN':'symbol-narrow':'1.2-2' }})
                              }
                              · Ahorro total: <b>{{ dinero(((p.list_price || 0) - (p.unit_price || 0)) * cantidadArticulo()) }}</b>
                            </span>
                          </div>
                        </div>
                      </div>
                    }
                  } @else if (esDescuentoVolumen(p)) {
                    <div class="banner-volumen">
                      <i class="pi pi-bolt" aria-hidden="true"></i>
                      <span><strong>Descuento por volumen activo</strong> para {{ cantidadArticulo() }} {{ labelUnidadActiva() }}s</span>
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
          }
        </div>
      </div>

      <!-- ── BLOQUE 3: La Bandeja donde se van agregando los productos ────────────────── -->
      <div class="card mt-card bandeja-card">
        <div class="card-head">
          <div class="card-head-left">
            <span class="step-num">3</span>
            <h2>Bandeja de cotización</h2>
            <span class="badge-count">{{ bandeja().length }} artículo(s)</span>
          </div>
        </div>

        <div class="card-body p-0">
          @if (bandeja().length === 0) {
            <div class="empty-bandeja">
              <i class="pi pi-shopping-cart empty-icon" aria-hidden="true"></i>
              <p class="empty-title">La bandeja está vacía</p>
              <p class="empty-hint">Buscá productos en el Paso 2 arriba y agregalos uno a uno a esta cotización.</p>
            </div>
          } @else {
            <div class="table-wrap">
              <table class="bandeja-table">
                <thead>
                  <tr>
                    <th class="num">#</th>
                    <th>Artículo</th>
                    <th>Presentación</th>
                    <th class="num">Cantidad</th>
                    <th class="num">P. Unitario</th>
                    <th>Fuente precio</th>
                    <th class="num">Importe</th>
                    <th><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (item of bandeja(); track item.id; let idx = $index) {
                    <tr>
                      <td class="num mono">{{ idx + 1 }}</td>
                      <td>
                        <strong class="item-name">{{ item.name }}</strong>
                        <div class="item-sub">
                          <span class="item-sku">{{ item.sku }}</span>
                          @if (item.barcode) { <span>EAN: {{ item.barcode }}</span> }
                        </div>
                        @if (item.free_goods) {
                          <span class="gift-tag"><i class="pi pi-gift"></i> Regalo: {{ item.free_goods.quantity }} de {{ item.free_goods.sku }}</span>
                        }
                      </td>
                      <td>
                        <span class="pres-badge">{{ item.unit_label }}</span>
                        @if (item.factor && item.factor > 1) {
                          <span class="pres-factor">x{{ item.factor }}</span>
                        }
                      </td>
                      <td class="num">
                        <div class="table-qty-control">
                          <button type="button" class="btn-table-step" (click)="ajustarCantidadBandeja(item, -1)" [disabled]="item.quantity <= 1 || guardando()">−</button>
                          <span class="table-qty-val">{{ item.quantity }}</span>
                          <button type="button" class="btn-table-step" (click)="ajustarCantidadBandeja(item, 1)" [disabled]="guardando()">+</button>
                        </div>
                      </td>
                      <td class="num font-num">
                        <div class="p-unit-cell">
                          <span class="p-unit-main">{{ item.unit_price !== null ? (item.unit_price | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</span>
                          @if (item.factor && item.factor > 1 && item.unit_price !== null) {
                            <span class="p-unit-sub-breakdown">({{ item.factor }}PZS {{ (item.unit_price / item.factor) | currency:'MXN':'symbol-narrow':'1.2-2' }})</span>
                          }
                        </div>
                      </td>
                      <td>
                        <span class="source-tag" [class.source-tag-volumen]="item.price_source === 'volume_qty'">
                          @if (item.price_source === 'volume_qty') {
                            <i class="pi pi-bolt" aria-hidden="true"></i>
                          }
                          {{ fuenteLabel(item.price_source) }}
                        </span>
                      </td>
                      <td class="num font-num bold-num">
                        {{ item.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}
                      </td>
                      <td class="num">
                        <button
                          type="button"
                          class="btn-quitar"
                          (click)="quitarDeBandeja(item.id)"
                          [disabled]="guardando()"
                          title="Eliminar de la bandeja"
                          aria-label="Eliminar producto"
                        >
                          <i class="pi pi-trash" aria-hidden="true"></i>
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <!-- Resumen financiero de la cotización -->
            <div class="bandeja-totales">
              <div class="tot-row">
                <span>Subtotal lista</span>
                <b>{{ subtotalBandeja() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
              @if (descuentoClienteMonto() > 0) {
                <div class="tot-row tot-dto">
                  <span>Descuento del cliente ({{ descuentoClientePct() }}%)</span>
                  <b>− {{ descuentoClienteMonto() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
                </div>
              }
              <div class="tot-row tot-final">
                <span>Total cotización</span>
                <b>{{ totalBandeja() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
            </div>
          }
        </div>
      </div>

      <!-- ── BLOQUE 4: Cierre & Guardar Cotización ────────────────────────────────────── -->
      <div class="card mt-card">
        <div class="card-head">
          <div class="card-head-left">
            <span class="step-num">4</span>
            <h2>Datos de cierre</h2>
          </div>
        </div>
        <div class="card-body">
          <div class="detail-row">
            <label class="field-item">
              <span>¿De dónde salió la cotización?</span>
              <select class="input" [(ngModel)]="origen" [disabled]="guardando()">
                @for (o of origenes; track o.value) {
                  <option [value]="o.value">{{ o.label }}</option>
                }
              </select>
            </label>
            <label class="field-item">
              <span>Vigencia hasta</span>
              <input type="date" class="input" [(ngModel)]="vigencia" [min]="hoy" [disabled]="guardando()" />
            </label>
          </div>

          <label class="field-item full-width mt-field">
            <span>Mensaje original o lista del cliente <em>(opcional)</em></span>
            <textarea
              class="input textarea"
              rows="2"
              [(ngModel)]="listaCruda"
              placeholder="Pegá acá el correo o WhatsApp recibido. Se guarda como evidencia..."
              [disabled]="guardando()"
            ></textarea>
          </label>
        </div>

        <div class="card-actions">
          <button pButton severity="secondary" [outlined]="true" routerLink="/telemarketing/cotizaciones" [disabled]="guardando()">
            <span class="p-button-label">Cancelar</span>
          </button>
          <button
            pButton
            severity="success"
            [outlined]="true"
            type="button"
            class="btn-export btn-export-xlsx"
            [disabled]="bandeja().length === 0 || exportando() || guardando()"
            (click)="descargarXlsx()"
            title="Crear y descargar entregable en archivo Excel (.xlsx)"
          >
            <span
              class="p-button-icon p-button-icon-left pi"
              [class.pi-file-excel]="exportandoTipo() !== 'xlsx'"
              [class.pi-spin]="exportandoTipo() === 'xlsx'"
              [class.pi-spinner]="exportandoTipo() === 'xlsx'"
              aria-hidden="true"
            ></span>
            <span class="p-button-label">{{ exportandoTipo() === 'xlsx' ? 'Generando Excel...' : 'Descargar Excel (.xlsx)' }}</span>
          </button>
          <button
            pButton
            severity="danger"
            [outlined]="true"
            type="button"
            class="btn-export btn-export-pdf"
            [disabled]="bandeja().length === 0 || exportando() || guardando()"
            (click)="descargarPdf()"
            title="Crear y descargar entregable formal en archivo PDF"
          >
            <span
              class="p-button-icon p-button-icon-left pi"
              [class.pi-file-pdf]="exportandoTipo() !== 'pdf'"
              [class.pi-spin]="exportandoTipo() === 'pdf'"
              [class.pi-spinner]="exportandoTipo() === 'pdf'"
              aria-hidden="true"
            ></span>
            <span class="p-button-label">{{ exportandoTipo() === 'pdf' ? 'Generando PDF...' : 'Descargar PDF' }}</span>
          </button>
          <button pButton [disabled]="!puedeCrear() || guardando()" (click)="crear()">
            <span
              class="p-button-icon p-button-icon-left pi"
              [class.pi-check]="!guardando()"
              [class.pi-spin]="guardando()"
              [class.pi-spinner]="guardando()"
              aria-hidden="true"
            ></span>
            <span class="p-button-label">
              {{ guardando() ? 'Guardando cotización...' : (bandeja().length > 0 ? 'Crear cotización (' + bandeja().length + ' artículos)' : 'Crear cotización en borrador') }}
            </span>
          </button>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .section { padding: 1rem 1.25rem; max-width: 950px; margin: 0 auto; }
      .top-bar { margin-bottom: 0.5rem; }
      .back { display: inline-flex; gap: 0.35rem; align-items: center; font-size: 0.8125rem; color: var(--text-muted); text-decoration: none; }
      .back:hover { color: var(--text-main); }
      .section-header h1 { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.15rem; }
      .section-header p { color: var(--text-muted); font-size: 0.8125rem; margin: 0 0 0.85rem; }

      .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow: visible; box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
      .mt-card { margin-top: 1rem; }
      .card-head {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.65rem 0.9rem; border-bottom: 1px solid var(--border-color); flex-wrap: wrap;
        background: var(--surface-ground, #fafafa);
      }
      .card-head-left { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      .card-head-left h2 { font-size: 0.95rem; font-weight: 700; margin: 0; }
      .step-num {
        width: 22px; height: 22px; flex: none; border-radius: 50%;
        background: var(--primary-color, var(--action)); color: #fff;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 0.75rem; font-weight: 700;
      }
      .captura-sub { font-size: 0.75rem; color: var(--text-muted); }
      .badge-count { font-size: 0.75rem; background: var(--neutral-100, #f1f5f9); padding: 2px 6px; border-radius: 9999px; font-weight: 600; color: var(--text-muted); }

      .pills { display: inline-flex; gap: 0.25rem; background: var(--neutral-100, #f1f5f9); padding: 2px; border-radius: 9999px; }
      .pill {
        border: 0; background: none; border-radius: 9999px; padding: 0.2rem 0.65rem;
        font-size: 0.75rem; cursor: pointer; color: var(--text-muted); font-weight: 500;
      }
      .pill-active { background: #fff; color: var(--text-main); font-weight: 700; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }

      /* Sucursal desplegable pegada arriba a la derecha */
      .sucursal-dropdown-box { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; }
      .suc-label { font-size: 0.75rem; font-weight: 700; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; }
      .input-select {
        padding: 0.3rem 0.6rem; font-size: 0.8125rem; border: 1px solid var(--border-color);
        border-radius: 6px; background: var(--card-bg); color: var(--text-main); font-weight: 700; min-height: 32px;
      }
      .input-select:focus-visible { outline: 2px solid var(--primary-color, var(--action)); outline-offset: 1px; }

      /* Tira compacta de condiciones comerciales */
      .terms-bar {
        display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0.9rem;
        background: var(--neutral-50, #f8fafc); border-bottom: 1px solid var(--border-color);
        font-size: 0.75rem; flex-wrap: wrap;
      }
      .terms-bar-generic { color: var(--text-muted); font-style: italic; }
      .term-item { display: inline-flex; align-items: baseline; gap: 0.35rem; }
      .t-k { color: var(--text-muted); }
      .t-v { font-weight: 700; font-variant-numeric: tabular-nums; }
      .t-accent { color: var(--primary-color, var(--action)); font-weight: 800; }
      .t-muted { font-style: italic; color: var(--text-muted); font-weight: 400; }
      .term-sep { width: 1px; height: 12px; background: var(--border-color); }
      .term-warn { margin-left: auto; color: var(--yellow-700, #a16207); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; }

      .card-body { padding: 0.75rem 0.9rem; }
      .p-0 { padding: 0; }

      .search-container { position: relative; width: 100%; max-width: 600px; }
      .search-box { position: relative; display: flex; align-items: center; }
      .search-icon { position: absolute; left: 0.65rem; color: var(--text-muted); font-size: 0.8125rem; pointer-events: none; }
      .search-spinner { position: absolute; right: 0.65rem; color: var(--text-muted); font-size: 0.8125rem; }
      .search-input { padding-left: 2rem; width: 100%; }

      .results-dropdown {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.12); list-style: none; margin: 0; padding: 0;
        max-height: 200px; overflow-y: auto;
      }
      .results-dropdown li + li { border-top: 1px solid var(--border-color); }
      .result-row {
        width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
        padding: 0.45rem 0.7rem; display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.8125rem;
      }
      .result-row:hover { background: var(--neutral-100, #f1f5f9); }
      .r-code { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--text-main); width: 60px; flex: none; }
      .r-name { flex: 1; font-weight: 600; }
      .r-state { font-size: 0.7rem; color: var(--text-muted); flex: none; }
      .r-badge-warn { font-size: 0.65rem; background: var(--yellow-100, #fef08a); color: var(--yellow-800, #854d0e); padding: 1px 4px; border-radius: 4px; }
      .search-empty { font-size: 0.75rem; color: var(--text-muted); margin: 0.35rem 0 0; }

      .chosen-row {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        background: var(--neutral-50, #f8fafc); border: 1px dashed var(--border-color);
        border-radius: 6px; padding: 0.45rem 0.75rem;
      }
      .chosen-details { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
      .chosen-code { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--primary-color, var(--action)); }
      .chosen-name { font-size: 0.875rem; font-weight: 600; }
      .chosen-meta { font-size: 0.75rem; color: var(--text-muted); }
      .btn-change {
        background: none; border: 0; color: var(--primary-color, var(--action));
        cursor: pointer; font-size: 0.75rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;
      }
      .btn-change:hover { text-decoration: underline; }

      .contact-fields { display: grid; grid-template-columns: 2fr 1.2fr 1.2fr; gap: 0.6rem; }
      @media (max-width: 640px) { .contact-fields { grid-template-columns: 1fr; } }
      .field-item { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.75rem; }
      .field-item span { color: var(--text-muted); font-weight: 500; }
      .field-item span b { color: var(--red-600, #dc2626); }
      .full-width { width: 100%; }
      .mt-field { margin-top: 0.6rem; }

      .vendedor-box {
        margin-top: 0.65rem; padding: 0.5rem 0.75rem; background: var(--neutral-50, #f8fafc);
        border: 1px solid var(--border-color); border-radius: 6px;
      }
      .vendedor-inner { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
      .vendedor-label {
        font-size: 0.75rem; font-weight: 700; color: var(--text-muted);
        display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap;
      }
      .vendedor-label i { color: var(--primary-color, var(--action)); }
      .vendedor-control { position: relative; display: inline-flex; align-items: center; flex: 1 1 240px; max-width: 420px; }
      .vendedor-select { width: 100%; cursor: pointer; font-weight: 600; min-height: 32px; }
      .v-spinner { position: absolute; right: 0.65rem; font-size: 0.75rem; color: var(--primary-color, var(--action)); }
      .vendedor-hint { font-size: 0.75rem; color: var(--text-muted); }
      .vendedor-hint strong { color: var(--text-main); }

      .detail-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
      @media (max-width: 640px) { .detail-row { grid-template-columns: 1fr; } }

      /* Captura manual de artículos */
      .f-lbl { display: block; font-size: 0.8125rem; font-weight: 600; margin-bottom: 0.35rem; color: var(--text-main); }
      .search-step { position: relative; margin-bottom: 0.5rem; }
      .search-input-wrap { position: relative; display: flex; align-items: center; }
      .search-ico { position: absolute; left: 0.75rem; color: var(--text-muted); font-size: 0.875rem; pointer-events: none; }
      .search-prod-input { padding-left: 2.25rem; font-size: 0.875rem; min-height: 40px; border-radius: 6px; width: 100%; }

      /* Desplegable ordenado alfabéticamente */
      .cat-dropdown {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 50;
        list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow-y: auto;
        border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg);
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      }
      .cat-dropdown li + li { border-top: 1px solid var(--border-color); }
      .cat-row {
        width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.55rem 0.8rem; background: none; border: 0; cursor: pointer; text-align: left;
        color: var(--text-main); font-size: 0.8125rem;
      }
      .cat-row:hover, .cat-row-active { background: var(--neutral-100, #f1f5f9); }
      .cat-col-nom { flex: 1 1 auto; min-width: 0; }
      .cat-nom { font-size: 0.875rem; display: inline-block; font-weight: 600; }
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
        background: var(--neutral-50, #f8fafc); border: 1px solid var(--border-color);
        border-radius: 8px; padding: 0.85rem; margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.75rem;
      }
      .descargado-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
      .descargado-tag {
        display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem;
        font-weight: 700; color: var(--green-700, #15803d); text-transform: uppercase; letter-spacing: 0.03em;
      }
      .btn-change-prod {
        background: none; border: 0; color: var(--primary-color, var(--action)); cursor: pointer; font-size: 0.75rem;
        font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem;
      }
      .btn-change-prod:hover { text-decoration: underline; }

      .descargado-info { display: flex; flex-direction: column; gap: 0.35rem; }
      .descargado-name { font-size: 1rem; font-weight: 700; color: var(--text-main); }
      .descargado-pills { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .pill-meta { font-size: 0.75rem; color: var(--text-muted); background: var(--card-bg); padding: 0.15rem 0.45rem; border-radius: 4px; border: 1px solid var(--border-color); }
      .pill-meta b { color: var(--text-main); }

      /* Pregunta: Caja o Pieza */
      .pregunta-seccion { display: flex; flex-direction: column; gap: 0.35rem; }
      .pregunta-lbl { font-size: 0.8125rem; font-weight: 700; color: var(--text-main); }
      .unit-toggle-group { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .unit-toggle-btn {
        flex: 1 1 120px; display: flex; flex-direction: column; align-items: center; justify-content: center;
        padding: 0.55rem 0.7rem; border-radius: 8px; border: 2px solid var(--border-color);
        background: var(--card-bg); cursor: pointer; min-height: 48px; text-align: center; gap: 0.1rem;
        transition: border-color 0.15s, background-color 0.15s;
      }
      .unit-toggle-btn i { font-size: 0.95rem; color: var(--text-muted); }
      .unit-toggle-btn:hover { border-color: var(--primary-color, var(--action)); }
      .unit-toggle-active { border-color: var(--primary-color, var(--action)); background: rgba(14, 116, 144, 0.06); }
      .unit-toggle-active i { color: var(--primary-color, var(--action)); }
      .unit-title { font-weight: 700; font-size: 0.875rem; color: var(--text-main); }
      .unit-sub { font-size: 0.7rem; color: var(--text-muted); }

      /* Stepper táctil para móvil 16:9 */
      .touch-qty-seccion { display: flex; flex-direction: column; gap: 0.35rem; }
      .touch-stepper { display: flex; align-items: center; gap: 0.5rem; max-width: 300px; }
      .btn-touch-step {
        width: 44px; height: 44px; flex: none; border-radius: 8px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: 1.15rem; font-weight: 700; color: var(--text-main);
        cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        user-select: none;
      }
      .btn-touch-step:active { background: var(--neutral-100, #f1f5f9); transform: scale(0.96); }
      .btn-touch-step:disabled { opacity: 0.4; cursor: not-allowed; }
      .touch-qty-readout {
        flex: 1; height: 44px; border-radius: 8px; border: 1px solid var(--border-color);
        background: var(--card-bg); display: flex; flex-direction: column; align-items: center;
        justify-content: center; font-variant-numeric: tabular-nums;
      }
      .qty-num { font-size: 1.25rem; font-weight: 800; line-height: 1.1; color: var(--text-main); }
      .qty-lbl { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }

      .touch-presets { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.2rem; }
      .preset-btn {
        min-height: 34px; padding: 0.25rem 0.6rem; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: 0.8125rem; font-weight: 600; cursor: pointer; color: var(--text-muted);
      }
      .preset-btn:hover, .preset-btn:active { background: var(--neutral-100, #f1f5f9); color: var(--text-main); }
      .preset-active { background: var(--primary-color, var(--action)); color: #fff; border-color: var(--primary-color, var(--action)); }

      /* Previa del precio y volumen */
      .previa-loading { font-size: 0.8125rem; color: var(--text-muted); padding: 0.4rem 0; }
      .previa-card {
        border-radius: 8px; padding: 0.75rem 0.9rem; border: 1px solid var(--border-color);
        border-left: 4px solid var(--green-600, #16a34a); background: var(--card-bg);
      }
      .previa-card-bad { border-left-color: var(--red-600, #dc2626); }
      .previa-top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.3rem; }
      .previa-unit-box { flex: 0 1 auto; }
      .previa-total-box { flex: 0 1 auto; }
      .previa-action-box { margin-left: auto; display: flex; align-items: center; }
      .btn-agregar-inline {
        min-height: 38px; font-size: 0.8125rem; font-weight: 700; border-radius: 6px;
        padding: 0.4rem 1.1rem; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }
      @media (max-width: 640px) {
        .previa-action-box { width: 100%; margin-left: 0; margin-top: 0.35rem; }
        .btn-agregar-inline { width: 100%; justify-content: center; }
      }
      .previa-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; display: block; }
      .previa-price-row { display: flex; align-items: baseline; gap: 0.35rem; }
      .previa-amount { font-size: 1.15rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .previa-unit-sub { font-size: 0.75rem; color: var(--text-muted); }
      .previa-menor-sub { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; margin-left: 0.25rem; }
      .previa-total-amount { font-size: 1.2rem; font-weight: 800; color: var(--primary-color, var(--action)); font-variant-numeric: tabular-nums; }
      .previa-none { font-size: 0.875rem; font-style: italic; color: var(--red-600, #dc2626); }

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
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3);
        border-radius: 6px; font-size: 0.75rem; color: var(--green-700, #15803d); margin: 0.4rem 0;
      }
      .banner-regalo {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 6px; font-size: 0.75rem; color: #1d4ed8; margin: 0.4rem 0;
      }
      .p-step-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; margin-top: 0.2rem; flex-wrap: wrap; }
      .step-tag { font-weight: 700; color: var(--text-main); }
      .step-detail { color: var(--text-muted); }
      .step-delta { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--green-700, #15803d); }
      .p-why-bad { color: var(--red-600, #dc2626); font-size: 0.75rem; margin: 0.3rem 0 0; }

      .p-unit-cell { display: flex; flex-direction: column; align-items: flex-end; }
      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: 0.6875rem; color: var(--text-muted); font-weight: 500; }
      .source-tag-volumen { background: #dcfce7 !important; color: #15803d !important; font-weight: 700; }

      /* Bandeja de productos agregados */
      .empty-bandeja { padding: 2rem 1rem; text-align: center; color: var(--text-muted); }
      .empty-icon { font-size: 2rem; margin-bottom: 0.4rem; opacity: 0.5; }
      .empty-title { font-weight: 600; font-size: 0.95rem; margin: 0 0 0.2rem; color: var(--text-main); }
      .empty-hint { font-size: 0.8125rem; margin: 0; }

      .table-wrap { overflow-x: auto; width: 100%; }
      .bandeja-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
      .bandeja-table th {
        background: var(--neutral-50, #f8fafc); padding: 0.5rem 0.65rem; text-align: left;
        border-bottom: 1px solid var(--border-color); font-size: 0.75rem; color: var(--text-muted);
        font-weight: 600; white-space: nowrap;
      }
      .bandeja-table td { padding: 0.55rem 0.65rem; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); font-size: 0.75rem; color: var(--text-muted); }
      .font-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .bold-num { font-weight: 700; color: var(--primary-color, var(--action)); }

      .item-name { font-size: 0.875rem; display: block; }
      .item-sub { font-size: 0.7rem; color: var(--text-muted); display: flex; gap: 0.4rem; margin-top: 0.1rem; }
      .item-sku { font-family: var(--font-mono, monospace); font-weight: 600; }
      .gift-tag { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; color: #1d4ed8; margin-top: 0.2rem; font-weight: 600; }

      .pres-badge { font-weight: 700; background: var(--neutral-100, #f1f5f9); padding: 1px 5px; border-radius: 4px; font-size: 0.75rem; }
      .pres-factor { font-size: 0.7rem; color: var(--text-muted); margin-left: 0.25rem; }

      .table-qty-control { display: inline-flex; align-items: center; gap: 0.25rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 1px 3px; }
      .btn-table-step {
        border: 0; background: none; width: 22px; height: 22px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.875rem;
      }
      .btn-table-step:hover { background: var(--neutral-100, #f1f5f9); border-radius: 4px; }
      .table-qty-val { min-width: 24px; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }

      .source-tag { font-size: 0.7rem; background: var(--neutral-100, #f1f5f9); padding: 2px 6px; border-radius: 4px; color: var(--text-muted); white-space: nowrap; }
      .btn-quitar {
        border: 0; background: none; color: var(--red-600, #dc2626); cursor: pointer;
        padding: 0.3rem; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center;
      }
      .btn-quitar:hover { background: rgba(220, 38, 38, 0.1); }

      /* Resumen totales bandeja */
      .bandeja-totales {
        border-top: 2px solid var(--border-color); padding: 0.75rem 1rem; display: flex;
        flex-direction: column; gap: 0.25rem; align-items: flex-end; background: var(--neutral-50, #f8fafc);
      }
      .tot-row { display: flex; gap: 1.5rem; font-size: 0.8125rem; color: var(--text-muted); }
      .tot-row b { color: var(--text-main); font-variant-numeric: tabular-nums; min-width: 7rem; text-align: right; }
      .tot-dto { color: var(--green-700, #15803d); }
      .tot-dto b { color: var(--green-700, #15803d); }
      .tot-final { font-size: 1rem; border-top: 1px solid var(--border-color); padding-top: 0.35rem; margin-top: 0.15rem; }
      .tot-final b { font-weight: 800; font-size: 1.15rem; color: var(--primary-color, var(--action)); }

      .input {
        width: 100%; padding: 0.35rem 0.6rem; box-sizing: border-box; border: 1px solid var(--border-color);
        border-radius: 6px; font-size: 0.8125rem; background: var(--card-bg); color: var(--text-main); min-height: 32px;
      }
      .input:focus-visible { outline: 2px solid var(--primary-color, var(--action)); outline-offset: 1px; }
      .textarea { min-height: 52px; resize: vertical; font-family: inherit; }

      .card-actions {
        display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 0.6rem; padding: 0.75rem 1rem;
        border-top: 1px solid var(--border-color);
      }
      .btn-export { font-weight: 600; }
      .btn-export-xlsx { border-color: #16a34a !important; color: #16a34a !important; }
      .btn-export-xlsx:hover:not(:disabled) { background: rgba(22, 163, 74, 0.08) !important; }
      .btn-export-pdf { border-color: #dc2626 !important; color: #dc2626 !important; }
      .btn-export-pdf:hover:not(:disabled) { background: rgba(220, 38, 38, 0.08) !important; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
    `,
  ],
})
export class TeleventaQuoteNewComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);

  readonly TOTAL_MAYOREO = 207;
  readonly origenes = ORIGENES;
  readonly hoy = new Date().toISOString().slice(0, 10);
  readonly sucursales8: StoreBranch[] = SUCURSALES_8;

  // Estado del Destinatario
  modo = signal<'mayoreo' | 'contacto'>('mayoreo');
  terminoCliente = '';
  buscandoCliente = signal(false);
  resultadosClientes = signal<WholesaleCustomer[]>([]);
  cliente = signal<WholesaleCustomer | null>(null);

  // Sucursal: inicializada por defecto en '01' (Padre Hidalgo)
  sucursal = signal<string>('01');
  guardando = signal(false);
  exportando = signal(false);
  exportandoTipo = signal<'xlsx' | 'pdf' | null>(null);

  // Vendedor que da seguimiento a la cotización
  vendedores = signal<Array<{ code: string; name: string }>>([]);
  cargandoVendedores = signal(false);
  vendedorSeleccionado = signal<string | null>(null);

  readonly vendedorSeleccionadoObj = computed(() => {
    const code = this.vendedorSeleccionado();
    if (!code) return null;
    return this.vendedores().find((v) => v.code === code) ?? null;
  });

  contactoNombre = '';
  contactoTel = '';
  contactoMail = '';
  origen: QuoteOrigin = 'telemarketing';
  vigencia = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
  listaCruda = '';

  // ── Estado de Captura Manual de Artículos ───────────────────────────────────
  terminoArticulo = '';
  buscandoArticulo = signal(false);
  catalogoAbierto = signal(false);
  resultadosArticulos = signal<QuoteCatalogRow[]>([]);
  articuloElegido = signal<QuoteCatalogRow | null>(null);
  rung = signal<Rung>('base');
  cantidadArticulo = signal<number>(1);
  cotizandoArticulo = signal(false);
  previaArticulo = signal<PricedLine | null>(null);

  // ── La Bandeja de productos de la cotización ───────────────────────────────
  bandeja = signal<ItemBandeja[]>([]);

  private readonly busquedaCliente$ = new Subject<string>();
  private readonly busquedaArticulo$ = new Subject<void>();
  private readonly previa$ = new Subject<void>();

  /** Términos comerciales de la sucursal activa para el cliente elegido */
  readonly sucursalTerms = computed<WholesaleBranchTerms | null>(() => {
    const c = this.cliente();
    const s = this.sucursal();
    if (!c || !s) return null;
    return c.branches.find((b) => b.sucursal === s) ?? null;
  });

  readonly descuentoClientePct = computed(() => {
    return this.num(this.sucursalTerms()?.discount_1_pct) || 0;
  });

  /** Totales de la bandeja calculados en tiempo real */
  readonly subtotalBandeja = computed(() => {
    return this.bandeja().reduce((acc, it) => acc + (it.line_total || 0), 0);
  });

  readonly descuentoClienteMonto = computed(() => {
    const pct = this.descuentoClientePct();
    if (pct <= 0) return 0;
    return (this.subtotalBandeja() * pct) / 100;
  });

  readonly totalBandeja = computed(() => {
    return Math.max(0, this.subtotalBandeja() - this.descuentoClienteMonto());
  });

  /** Habilitación de guardado */
  readonly puedeCrear = computed(() => {
    if (this.guardando()) return false;
    if (!this.sucursal()) return false;
    if (this.modo() === 'contacto') {
      return this.contactoNombre.trim().length > 0;
    }
    return !!this.cliente() || this.terminoCliente.trim().length > 0;
  });

  readonly puedeAgregarArticulo = computed(() => {
    const p = this.previaArticulo();
    return !!this.articuloElegido() && !!p && p.unit_price !== null && this.cantidadArticulo() > 0;
  });

  ngOnInit(): void {
    // 1. Búsqueda reactiva de clientes
    this.busquedaCliente$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((t) => {
          this.buscandoCliente.set(true);
          return this.svc.searchWholesaleCustomers(t, 20).pipe(
            catchError((err) => {
              this.toast.add({
                severity: err?.status === 403 ? 'warn' : 'error',
                summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo buscar cliente',
                detail: err?.error?.message || 'El padrón de mayoreo no respondió.',
              });
              return of([] as WholesaleCustomer[]);
            }),
          );
        }),
      )
      .subscribe((rows) => {
        this.resultadosClientes.set(rows);
        this.buscandoCliente.set(false);
      });

    this.busquedaCliente$.next('');

    // 2. Búsqueda de artículos en catálogo de la sucursal (ordenados alfabéticamente)
    this.busquedaArticulo$
      .pipe(
        debounceTime(250),
        switchMap(() => {
          const suc = this.sucursal() || '01';
          this.buscandoArticulo.set(true);
          return this.svc.searchCatalog(suc, this.terminoArticulo.trim(), 50).pipe(
            catchError((err) => {
              this.toast.add({
                severity: err?.status === 403 ? 'warn' : 'error',
                summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo buscar en catálogo',
                detail: err?.error?.message || 'El catálogo de la sucursal no respondió.',
              });
              return of([] as QuoteCatalogRow[]);
            }),
          );
        }),
      )
      .subscribe((rows) => {
        // Orden alfabético por nombre del producto tal como solicita el PM
        const ordenados = [...rows].sort((a, b) => {
          const nomA = (a.name || a.sku).trim();
          const nomB = (b.name || b.sku).trim();
          return nomA.localeCompare(nomB, 'es', { sensitivity: 'base' });
        });
        this.resultadosArticulos.set(ordenados);
        this.buscandoArticulo.set(false);
        this.catalogoAbierto.set(true);

        // Si es escaneo exacto de código de barras o SKU
        const t = this.terminoArticulo.trim();
        if (ordenados.length === 1 && t && (ordenados[0].sku.toUpperCase() === t.toUpperCase() || ordenados[0].barcode === t)) {
          this.elegirArticulo(ordenados[0]);
        }
      });

    // 3. Consulta de precio unitario y descuentos por volumen
    this.previa$
      .pipe(
        debounceTime(250),
        switchMap(() => {
          const suc = this.sucursal() || '01';
          const art = this.articuloElegido();
          const qty = this.cantidadArticulo();
          if (!art || !Number.isFinite(qty) || qty <= 0) {
            this.cotizandoArticulo.set(false);
            return of(null);
          }
          this.cotizandoArticulo.set(true);
          return this.svc
            .pricePreview({ branch: suc, sku: art.sku, quantity: qty, rung: this.rung() })
            .pipe(
              catchError((err) => {
                this.toast.add({
                  severity: err?.status === 403 ? 'warn' : 'error',
                  summary: 'Error al cotizar',
                  detail: err?.error?.message || 'El motor de precios no respondió.',
                });
                return of(null);
              }),
            );
        }),
        distinctUntilChanged(),
      )
      .subscribe((p) => {
        this.previaArticulo.set(p);
        this.cotizandoArticulo.set(false);
      });

    // 4. Carga reactiva de vendedores de la sucursal activa
    this.cargarVendedores(this.sucursal());
  }

  // ── Acciones de Destinatario ─────────────────────────────────────────────────
  setModo(m: 'mayoreo' | 'contacto'): void {
    this.modo.set(m);
    if (m === 'contacto') {
      this.limpiarCliente();
    }
  }

  onBuscarCliente(t: string): void {
    this.busquedaCliente$.next((t || '').trim());
  }

  onEnterCliente(): void {
    const r = this.resultadosClientes();
    if (r.length > 0) {
      this.elegirCliente(r[0]);
    }
  }

  elegirCliente(c: WholesaleCustomer): void {
    this.cliente.set(c);
    this.resultadosClientes.set([]);
    this.terminoCliente = '';
    // Si el cliente tiene la sucursal actual en sus ramas, se conserva; si no, si tiene ramas se sugiere la primera
    if (c.branches && c.branches.length > 0) {
      const match = c.branches.find((b) => b.sucursal === this.sucursal());
      if (!match) {
        const nuevaSuc = c.branches[0].sucursal;
        this.sucursal.set(nuevaSuc);
        this.cargarVendedores(nuevaSuc);
        return;
      }
    }
    this.asignarVendedorSugerido();
  }

  limpiarCliente(): void {
    this.cliente.set(null);
    this.resultadosClientes.set([]);
    this.terminoCliente = '';
  }

  clienteTieneSucursal(code: string): boolean {
    return !!this.cliente()?.branches.some((b) => b.sucursal === code);
  }

  onSucursalChange(val: string): void {
    const s = val || '01';
    this.sucursal.set(s);
    this.cargarVendedores(s);
    // Al cambiar de sucursal, refrescar precio previo del artículo si hay uno seleccionado
    if (this.articuloElegido()) {
      this.previa$.next();
    }
  }

  cargarVendedores(suc: string): void {
    if (!suc) return;
    this.cargandoVendedores.set(true);
    this.svc
      .listSalespersons(suc)
      .pipe(catchError(() => of([] as Array<{ code: string; name: string }>)))
      .subscribe((list) => {
        this.vendedores.set(list);
        this.cargandoVendedores.set(false);
        this.asignarVendedorSugerido();
      });
  }

  asignarVendedorSugerido(): void {
    const terms = this.sucursalTerms();
    const list = this.vendedores();
    if (!terms?.salesperson_code) return;

    const rawTarget = terms.salesperson_code.trim();
    const cleanTarget = rawTarget.replace(/^0+/, '');

    const found = list.find(
      (v) => v.code === rawTarget || v.code.replace(/^0+/, '') === cleanTarget,
    );
    if (found) {
      this.vendedorSeleccionado.set(found.code);
    } else if (this.vendedorSeleccionado() && !list.some((v) => v.code === this.vendedorSeleccionado())) {
      this.vendedorSeleccionado.set(null);
    }
  }

  onVendedorChange(val: string): void {
    this.vendedorSeleccionado.set(val ? val.trim() : null);
  }

  branchName(code: string): string {
    const b = SUCURSALES_8.find((item) => item.code === code);
    return b ? b.name : `Sucursal ${code}`;
  }

  // ── Acciones de Captura Manual ──────────────────────────────────────────────
  onTerminoArticulo(_v: string): void {
    this.articuloElegido.set(null);
    this.previaArticulo.set(null);
    this.busquedaArticulo$.next();
  }

  onFocoArticulo(): void {
    this.catalogoAbierto.set(true);
    if (this.resultadosArticulos().length === 0) {
      this.busquedaArticulo$.next();
    }
  }

  elegirArticulo(p: QuoteCatalogRow): void {
    this.articuloElegido.set(p);
    this.catalogoAbierto.set(false);
    this.cantidadArticulo.set(1);
    this.rung.set('base');
    this.previa$.next();
  }

  limpiarArticulo(): void {
    this.articuloElegido.set(null);
    this.previaArticulo.set(null);
    this.catalogoAbierto.set(true);
  }

  setRung(r: Rung): void {
    this.rung.set(r);
    this.previa$.next();
  }

  ajustarCantidad(delta: number): void {
    const actual = this.cantidadArticulo();
    this.cantidadArticulo.set(Math.max(1, actual + delta));
    this.previa$.next();
  }

  setCantidad(val: number): void {
    this.cantidadArticulo.set(Math.max(1, Math.floor(val)));
    this.previa$.next();
  }

  labelUnidadActiva(): string {
    const r = this.rung();
    const e = this.articuloElegido();
    if (r === 'box') return 'Caja';
    if (r === 'pack') return 'Paquete';
    return e?.sold_by_kg ? 'KG' : 'Pieza';
  }

  esDescuentoVolumen(p: PricedLine): boolean {
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

  // ── Bandeja de Cotización ───────────────────────────────────────────────────
  agregarABandeja(): void {
    const art = this.articuloElegido();
    const prev = this.previaArticulo();
    if (!art || !prev || prev.unit_price === null) return;

    const qty = this.cantidadArticulo();
    const factorNum = this.rung() === 'box' ? (art.box_size || null) : (this.rung() === 'pack' ? (art.pack_size || null) : null);

    const item: ItemBandeja = {
      id: `${art.sku}_${this.rung()}_${Date.now()}`,
      sku: art.sku,
      name: art.name || art.sku,
      barcode: art.barcode,
      content: art.content,
      rung: this.rung(),
      unit_label: prev.unit_label || this.labelUnidadActiva(),
      factor: factorNum,
      quantity: qty,
      unit_price: prev.unit_price,
      line_total: prev.line_total ?? (prev.unit_price * qty),
      price_source: prev.price_source,
      free_goods: prev.free_goods ? { sku: prev.free_goods.sku, quantity: prev.free_goods.quantity } : null,
    };

    this.bandeja.update((items) => [...items, item]);

    this.toast.add({
      severity: 'success',
      summary: 'Agregado a la bandeja',
      detail: `${qty} ${item.unit_label}${qty > 1 ? 's' : ''} de ${item.name}`,
    });

    // Limpia para agregar el siguiente artículo fluidamente
    this.articuloElegido.set(null);
    this.previaArticulo.set(null);
    this.terminoArticulo = '';
    this.resultadosArticulos.set([]);
    this.catalogoAbierto.set(false);
    this.cantidadArticulo.set(1);
    this.rung.set('base');
  }

  ajustarCantidadBandeja(item: ItemBandeja, delta: number): void {
    const nuevaQty = Math.max(1, item.quantity + delta);
    if (nuevaQty === item.quantity) return;

    // Recalcula precio preview para la nueva cantidad y actualiza la bandeja
    this.svc
      .pricePreview({ branch: this.sucursal() || '01', sku: item.sku, quantity: nuevaQty, rung: item.rung })
      .subscribe({
        next: (p) => {
          this.bandeja.update((items) =>
            items.map((it) => {
              if (it.id !== item.id) return it;
              return {
                ...it,
                quantity: nuevaQty,
                unit_price: p.unit_price,
                line_total: p.line_total ?? ((p.unit_price || 0) * nuevaQty),
                price_source: p.price_source,
                free_goods: p.free_goods ? { sku: p.free_goods.sku, quantity: p.free_goods.quantity } : null,
              };
            }),
          );
        },
        error: () => {
          // Si falla preview de red, al menos ajusta la cantidad con el unit price actual
          this.bandeja.update((items) =>
            items.map((it) => (it.id === item.id ? { ...it, quantity: nuevaQty, line_total: (it.unit_price || 0) * nuevaQty } : it)),
          );
        },
      });
  }

  quitarDeBandeja(id: string): void {
    this.bandeja.update((items) => items.filter((it) => it.id !== id));
  }

  // ── Guardado Final ──────────────────────────────────────────────────────────
  crear(): void {
    if (this.guardando()) return;

    if (!this.sucursal()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Falta sucursal',
        detail: 'Por favor selecciona la sucursal Kepler con cuyas condiciones se cotiza.',
      });
      return;
    }

    if (this.modo() === 'mayoreo') {
      if (!this.cliente()) {
        const matches = this.resultadosClientes();
        if (matches.length > 0) {
          this.elegirCliente(matches[0]);
        } else if (this.terminoCliente.trim().length > 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Falta seleccionar cliente',
            detail: `Selecciona un cliente de la lista de resultados o usa "Todavía no es cliente" si "${this.terminoCliente.trim()}" es un contacto nuevo.`,
          });
          return;
        } else {
          this.toast.add({
            severity: 'warn',
            summary: 'Falta cliente de mayoreo',
            detail: 'Por favor busca y selecciona un cliente de mayoreo (C####) o cambia a la pestaña "Todavía no es cliente".',
          });
          return;
        }
      }
    } else {
      if (!this.contactoNombre.trim()) {
        this.toast.add({
          severity: 'warn',
          summary: 'Falta destinatario',
          detail: 'Por favor escribe el nombre de la persona o negocio que solicita la cotización.',
        });
        return;
      }
    }

    this.guardando.set(true);

    const esMayoreo = this.modo() === 'mayoreo';
    const payload: Parameters<QuotesService['create']>[0] = {
      origin: this.origen,
      valid_until: this.vigencia || undefined,
      customer_request: this.listaCruda.trim() || undefined,
      source_branch: this.sucursal() || '01',
      salesperson_code: this.vendedorSeleccionado() || undefined,
      salesperson_name: this.vendedorSeleccionadoObj()?.name || undefined,
    };
    if (esMayoreo) {
      payload.erp_customer_code = this.cliente()!.customer_code;
    } else {
      payload.contact_name = this.contactoNombre.trim();
      payload.contact_phone = this.contactoTel.trim() || undefined;
      payload.contact_email = this.contactoMail.trim() || undefined;
    }

    // 1. Crea la cotización en draft
    this.svc
      .create(payload)
      .pipe(
        switchMap((q) => {
          const items = this.bandeja();
          if (items.length === 0) {
            return of({ quote: q, linesAdded: 0 });
          }
          // 2. Agrega secuencialmente los renglones de la bandeja
          return from(items).pipe(
            concatMap((item) =>
              this.svc.addLine(q.id, {
                sku: item.sku,
                quantity: item.quantity,
                rung: item.rung,
              }),
            ),
            toArray(),
            map((results) => ({ quote: q, linesAdded: results.length })),
          );
        }),
      )
      .subscribe({
        next: ({ quote, linesAdded }) => {
          this.guardando.set(false);
          this.toast.add({
            severity: 'success',
            summary: `Cotización ${quote.code} generada`,
            detail:
              linesAdded > 0
                ? `Folio asignado exitosamente con ${linesAdded} renglón(es) de la bandeja en estatus Borrador.`
                : `Folio asignado en borrador (abierta), vigente hasta ${quote.valid_until}.`,
          });
          this.router.navigate(['/telemarketing/cotizaciones'], {
            queryParams: { created: quote.code },
          });
        },
        error: (err) => {
          this.guardando.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo crear la cotización',
            detail: err?.error?.message || err?.message || 'Error de red.',
          });
        },
      });
  }

  // ── Helpers de formato ──────────────────────────────────────────────────────
  num(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  dinero(v: number | string | null | undefined): string {
    const n = this.num(v);
    return n === null ? '—' : n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  fuenteLabel(s: string): string {
    const m: Record<string, string> = {
      list: 'Lista',
      customer_terms: 'Cliente',
      volume_qty: 'Volumen',
      volume_amount: 'Volumen $',
      promo_qty: 'Promo',
      promo_amount: 'Promo $',
      free_goods: 'Regalo',
    };
    return m[s] ?? s;
  }

  // ── Generación de Entregables (XLSX / PDF) ───────────────────────────────────
  obtenerDatosEntregable(): QuoteDeliverableData {
    const esMayoreo = this.modo() === 'mayoreo';
    const cli = this.cliente();
    const customerCode = esMayoreo ? (cli?.customer_code || null) : null;
    const customerName = esMayoreo
      ? (cli?.name || 'CLIENTE')
      : (this.contactoNombre.trim() || 'PROSPECTO');

    const customerPhone = esMayoreo
      ? (cli?.phone || null)
      : (this.contactoTel.trim() || null);

    const customerEmail = esMayoreo
      ? null
      : (this.contactoMail.trim() || null);

    const sucursalCod = this.sucursal() || '01';
    const sucursalObj = this.sucursales8.find((s) => s.code === sucursalCod);
    const branchName = sucursalObj?.name || `Sucursal ${sucursalCod}`;

    const items = this.bandeja().map((it) => ({
      sku: it.sku,
      name: it.name,
      barcode: it.barcode,
      content: it.content,
      unit_label: it.unit_label,
      rung: it.rung,
      factor: it.factor,
      quantity: it.quantity,
      unit_price: it.unit_price,
      line_total: it.line_total,
      price_source: this.fuenteLabel(it.price_source),
      free_goods: it.free_goods,
      discount_pct: this.descuentoClientePct() || null,
    }));

    return {
      customerCode,
      customerName,
      customerPhone,
      customerEmail,
      branchCode: sucursalCod,
      branchName,
      salespersonCode: this.vendedorSeleccionado() || null,
      salespersonName: this.vendedorSeleccionadoObj()?.name || null,
      quoteDate: new Date(),
      validUntil: this.vigencia,
      items,
      subtotal: this.subtotalBandeja(),
      discountPct: this.descuentoClientePct(),
      discountAmount: this.descuentoClienteMonto(),
      total: this.totalBandeja(),
      notes: this.listaCruda.trim() || null,
    };
  }

  async descargarXlsx(): Promise<void> {
    if (this.exportando()) return;
    if (this.bandeja().length === 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Bandeja vacía',
        detail: 'Agregá al menos un artículo a la bandeja para exportar el entregable en Excel.',
      });
      return;
    }

    this.exportando.set(true);
    this.exportandoTipo.set('xlsx');
    try {
      const data = this.obtenerDatosEntregable();
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
    if (this.exportando()) return;
    if (this.bandeja().length === 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Bandeja vacía',
        detail: 'Agregá al menos un artículo a la bandeja para exportar el entregable en PDF.',
      });
      return;
    }

    this.exportando.set(true);
    this.exportandoTipo.set('pdf');
    try {
      const data = this.obtenerDatosEntregable();
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

