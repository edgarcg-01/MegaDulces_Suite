import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
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
  nombreUnidadBase,
  abrevUnidadBase,
  opcionesUnidad,
  paqueteDeCaja,
  desglose,
  type OpcionUnidad,
  type PasoDesglose,
  type QuoteBranches,
} from '../quotes.service';
import {
  exportQuotePdf,
  exportQuoteXlsx,
  type QuoteDeliverableData,
} from '../quote-deliverable-export';

/**
 * Las plazas Kepler donde se puede cotizar: el catálogo compartido `STORE_BRANCHES` menos el
 * CEDIS, que no vende al público.
 *
 * Antes era una copia literal de esa lista, declarada acá. El costo no fue la duplicación en sí
 * sino que la pantalla de detalle no la tenía: rotulaba el entregable "Sucursal 01" mientras
 * ésta escribía "Padre Hidalgo" — dos versiones del mismo documento. El core ya traía el
 * catálogo Y su helper `branchName()`.
 */
export const SUCURSALES_8: StoreBranch[] = STORE_BRANCHES.filter((b) => b.code !== '00');

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
  /** Abreviatura de la unidad base (PAQ, KG, PZA…) para el desglose "12 PAQ $41.82". */
  base_unit: string | null;
  /** Unidades base del paquete dentro de la caja (sólo renglones de caja): la unidad del medio. */
  pack_size: number | null;
  /** Lo que el cliente pidió y no se encontró (renglón sin casar, sin SKU ni precio). */
  requested_text?: string | null;
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
      <!-- Encabezado de UNA línea (COT.16): la pantalla es un rectángulo apaisado y cada línea
           vertical cuenta. La migaja reemplaza al link "Volver" + el párrafo de ayuda. -->
      <header class="page-head">
        <a routerLink="/telemarketing/cotizaciones" class="back">
          <i class="pi pi-arrow-left" aria-hidden="true"></i> Cotizaciones
        </a>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <h1>Nueva cotización</h1>
      </header>

      <!-- Zona de trabajo (izquierda) + riel fijo (derecha: totales, cierre y asistente IA) -->
      <div class="layout">
      <div class="work">

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

          <!-- COT.19: SÓLO las sucursales del usuario (ADR-050). Una → fija; varias → selector;
               ninguna → se declara, no se abren las 8. -->
          <div class="sucursal-dropdown-box">
            @if (misRamas() === null) {
              <span class="suc-label"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando sucursales…</span>
            } @else if (sucursalesPermitidas().length === 0) {
              <span class="suc-sin" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Sin sucursal asignada: pedí a un administrador que te asigne tu sucursal para poder cotizar.
              </span>
            } @else if (sucursalesPermitidas().length === 1) {
              <span class="suc-label"><i class="pi pi-building" aria-hidden="true"></i> Sucursal:</span>
              <span class="suc-fija">Sucursal {{ sucursalesPermitidas()[0].code }} — {{ sucursalesPermitidas()[0].name }}</span>
            } @else {
              <label for="sucursalSelect" class="suc-label">
                <i class="pi pi-building" aria-hidden="true"></i> Sucursal:
              </label>
              <select
                id="sucursalSelect"
                class="input-select"
                [class.input-select-falta]="!sucursal()"
                [ngModel]="sucursal()"
                (ngModelChange)="onSucursalChange($event)"
                [disabled]="guardando()"
              >
                @if (!sucursal()) {
                  <option value="" disabled>Elegí la sucursal…</option>
                }
                @for (s of sucursalesPermitidas(); track s.code) {
                  <option [value]="s.code">
                    Sucursal {{ s.code }} — {{ s.name }}
                    @if (cliente() && clienteTieneSucursal(s.code)) {
                      *
                    }
                  </option>
                }
              </select>
            }
          </div>
        </div>

        <div class="card-body">
          <div class="dest-row">
          <div class="dest-main">
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
                    placeholder="Buscar cliente de mayoreo: código (C1086), nombre o RFC, palabras en cualquier orden..."
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
              <!-- Cliente seleccionado: una sola fila, junto al vendedor -->
              <div class="chosen-row">
                <div class="chosen-details">
                  <span class="chosen-code">{{ cliente()!.customer_code }}</span>
                  <strong class="chosen-name">{{ cliente()!.name }}</strong>
                  @if (cliente()!.state || cliente()!.phone) {
                    <span class="chosen-meta">{{ cliente()!.state || '' }}{{ cliente()!.state && cliente()!.phone ? ' · ' : '' }}{{ cliente()!.phone || '' }}</span>
                  }
                </div>
                <button
                  type="button"
                  class="btn-change"
                  (click)="limpiarCliente()"
                  [disabled]="guardando()"
                  aria-label="Cambiar cliente"
                >
                  <i class="pi pi-pencil" aria-hidden="true"></i> Cambiar
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
          </div>

          <!-- VENDEDOR QUE DA SEGUIMIENTO: en la misma fila que el cliente -->
          <div class="vendedor-inner">
            <label for="vendedorSelect" class="vendedor-label">
              <i class="pi pi-user" aria-hidden="true"></i> Vendedor
            </label>
            <div class="vendedor-control">
              <select
                id="vendedorSelect"
                class="input-select vendedor-select"
                [ngModel]="vendedorSeleccionado() || ''"
                (ngModelChange)="onVendedorChange($event)"
                [disabled]="guardando() || cargandoVendedores()"
                [attr.title]="vendedorSeleccionadoObj() ? 'Asignado: ' + vendedorSeleccionadoObj()!.name + ' (Sucursal ' + sucursal() + ')' : null"
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
          </div>
          </div>
        </div>

        <!-- Condiciones comerciales compactas de la sucursal elegida: franja al pie -->
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
      </div>

      <!-- ── BLOQUE 2: Captura Manual de Artículos (Táctil, 16:9) ─────────────────────── -->
      <div class="card mt-card captura-manual-card">
        <!-- El buscador vive en el encabezado de la tarjeta: ahorra la fila de la etiqueta.
             La sucursal activa ya se ve en el bloque 1; acá queda en el título del campo. -->
        <div class="card-head card-head-search">
          <div class="card-head-left">
            <span class="step-num">2</span>
            <h2>Artículo</h2>
          </div>
          <div class="search-step">
            <label class="sr-only" for="prodSearchInput">Buscar artículo por código de barras, SKU o nombre</label>
            <div class="search-input-wrap" [attr.title]="'Sucursal activa: ' + sucursal() + ' — ' + branchName(sucursal())">
              <i class="pi pi-search search-ico" aria-hidden="true"></i>
              <input
                id="prodSearchInput"
                #buscadorArticulo
                type="search"
                class="input search-prod-input"
                [(ngModel)]="terminoArticulo"
                (ngModelChange)="onTerminoArticulo($event)"
                (focus)="onFocoArticulo()"
                (keydown.arrowdown)="$event.preventDefault(); moverResaltado(1)"
                (keydown.arrowup)="$event.preventDefault(); moverResaltado(-1)"
                (keydown.enter)="$event.preventDefault(); elegirResaltado()"
                [placeholder]="sucursal() ? 'Escaneá el código de barras o escribí SKU / nombre (palabras en cualquier orden) · ↑↓ y Enter para elegir' : 'Primero elegí la sucursal'"
                autocorrect="off"
                spellcheck="false"
                [disabled]="guardando() || !sucursal()"
              />
              @if (buscandoArticulo()) {
                <i class="pi pi-spin pi-spinner search-spinner" aria-hidden="true"></i>
              }
            </div>

            <!-- Desplegable: primero los aciertos exactos y después lo MÁS VENDIDO en la sucursal
                 (el servidor ordena). ↑↓ mueven el resaltado y Enter elige, sin mouse. -->
            @if (catalogoAbierto() && resultadosArticulos().length > 0) {
              <ul class="cat-dropdown" role="listbox" aria-label="Artículos encontrados, los más vendidos primero">
                @for (p of resultadosArticulos(); track p.sku; let i = $index) {
                  <li>
                    <button
                      type="button"
                      class="cat-row"
                      role="option"
                      [attr.aria-selected]="i === resaltado()"
                      [class.cat-row-active]="i === resaltado()"
                      (mouseenter)="resaltado.set(i)"
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
              <!-- Lo que no manejamos NO se pierde: queda en la bandeja como renglón sin casar
                   (requested_text) y viaja con la cotización como demanda (COT.16). -->
              <div class="search-hint">
                <span>Ningún artículo en Sucursal {{ sucursal() }} coincide con <strong>"{{ terminoArticulo }}"</strong>.</span>
                <button type="button" class="btn-no-casado" (click)="agregarNoManejado()" [disabled]="guardando()">
                  <i class="pi pi-plus" aria-hidden="true"></i> Anotar como no manejado
                </button>
              </div>
            }
          </div>
        </div>

          <!-- Artículo elegido ("descargado") para configurar precio y cantidad. Sin artículo no
               se pinta el cuerpo: la tarjeta queda en una sola fila (el buscador). -->
          @if (articuloElegido(); as e) {
            <div class="card-body descargado-box">
              <!-- Fila 1: nombre + datos + cambiar -->
              <div class="descargado-info">
                <strong class="descargado-name">{{ e.name || e.sku }}</strong>
                <span class="pill-meta">SKU <b>{{ e.sku }}</b></span>
                @if (e.barcode) { <span class="pill-meta">EAN {{ e.barcode }}</span> }
                @if (e.content) { <span class="pill-meta">Contenido {{ e.content }}</span> }
                <span class="pill-meta">Base <b>{{ e.sold_by_kg ? 'Kilogramo' : (e.unit_base || 'Pieza') }}</b></span>
                <button type="button" class="btn-change-prod" (click)="limpiarArticulo()" [disabled]="guardando()">
                  <i class="pi pi-pencil" aria-hidden="true"></i> Cambiar artículo
                </button>
              </div>

              <!-- Fila 2: unidad · cantidad · presets · precio · agregar (una sola franja). Sin
                   rótulo de pregunta: los botones se explican solos y sólo están los que el ERP
                   declara (COT.16). -->
              <div class="config-row">
                <!-- Unidades de MENOR a MAYOR (izq → der): KINDER DELICE = Pieza 1 · Paquete 10 ·
                     Caja 140. Sólo las que el ERP declara; el nombre de la base es el real
                     (Paquete, Kilo, Pieza…), no "Pieza" fijo (COT.16). -->
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
                      <span class="unit-sub">· {{ o.detalle }}</span>
                    </button>
                  }
                </div>

                <!-- CANTIDAD: se TECLEA (dictado: "48 cajas" = 2 teclas, antes 8 clics) y Enter
                     agrega; los botones + / − / presets siguen para captura táctil (COT.16). -->
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

                  <label class="touch-qty-readout">
                    <input
                      #cantidadInput
                      type="text"
                      inputmode="numeric"
                      class="qty-num"
                      [value]="cantidadArticulo()"
                      (input)="onCantidadTecleada($any($event.target).value)"
                      (keydown.enter)="$event.preventDefault(); agregarABandeja()"
                      (focus)="$any($event.target).select()"
                      [disabled]="guardando()"
                      [attr.aria-label]="'Cantidad en ' + labelUnidadActiva()"
                    />
                    <span class="qty-lbl">{{ labelUnidadActiva() }}</span>
                  </label>

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

                <!-- PREVIA DEL PRECIO EN VIVO: al final de la franja, junto al botón de agregar -->
                <div class="previa-top">
                  @if (cotizandoArticulo()) {
                    <span class="previa-loading"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Consultando precio en ERP...</span>
                  } @else if (previaArticulo(); as p) {
                    <div class="previa-unit-box">
                      <span class="previa-label">Precio unitario</span>
                      @if (p.unit_price !== null) {
                        <div class="previa-price-row">
                          <span class="previa-amount">{{ p.unit_price | currency:'MXN':'symbol-narrow':'1.2-4' }}</span>
                          <span class="previa-unit-sub">/ {{ p.unit_label || labelUnidadActiva() }}</span>
                        </div>
                        @if (p.unit_factor && p.unit_factor > 1) {
                          <span class="previa-menor-sub">{{ p.unit_factor }} {{ abrevBase(e) }} {{ (p.unit_price / p.unit_factor) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                        }
                      } @else {
                        <span class="previa-none">Sin precio en Sucursal {{ sucursal() }}</span>
                      }
                    </div>

                    <div class="previa-total-box">
                      <span class="previa-label">Importe</span>
                      @if (p.line_total !== null) {
                        <span class="previa-total-amount">{{ p.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                      } @else {
                        <span class="previa-none">—</span>
                      }
                    </div>
                  }

                  <button
                    pButton
                    class="btn-agregar-inline"
                    [disabled]="!puedeAgregarArticulo() || guardando() || cotizandoArticulo()"
                    (click)="agregarABandeja()"
                  >
                    <span class="p-button-icon p-button-icon-left pi pi-plus-circle" aria-hidden="true"></span>
                    <span class="p-button-label">Agregar</span>
                  </button>
                </div>
              </div>

              @if (!cotizandoArticulo() && previaArticulo(); as p) {
                <!-- AVISO DE ESCALÓN DE VOLUMEN (ERP kdpv_prod_util): UNA línea -->
                @if (p.volume_tier; as vt) {
                  @if (cantidadArticulo() < vt.min_qty) {
                    <div class="banner-oportunidad-volumen">
                      <i class="pi pi-sparkles b-vol-icon" aria-hidden="true"></i>
                      <span class="b-vol-desc">
                        Desde <b>{{ vt.min_qty }} {{ labelUnidadActiva() }}s</b> baja de
                        <span class="strikethrough">{{ dinero(p.list_price) }}</span> a <b>{{ dinero(vt.price) }}</b>
                        (ahorro {{ dinero((p.list_price || 0) - vt.price) }} c/u)
                      </span>
                      <button
                        type="button"
                        class="btn-aplicar-volumen"
                        (click)="setCantidad(vt.min_qty)"
                        [disabled]="guardando()"
                      >
                        <i class="pi pi-check" aria-hidden="true"></i> Aplicar {{ vt.min_qty }}
                      </button>
                    </div>
                  } @else {
                    <div class="banner-volumen-exito">
                      <i class="pi pi-check-circle b-vol-icon-ok" aria-hidden="true"></i>
                      <span class="b-vol-desc">
                        <b>Precio de mayoreo aplicado:</b>
                        <span class="strikethrough">{{ dinero(p.list_price) }}</span> → <b>{{ dinero(p.unit_price) }}</b> / {{ p.unit_label || labelUnidadActiva() }}
                        · ahorro total <b>{{ dinero(((p.list_price || 0) - (p.unit_price || 0)) * cantidadArticulo()) }}</b>
                      </span>
                    </div>
                  }
                } @else if (esDescuentoVolumen(p)) {
                  <div class="banner-volumen">
                    <i class="pi pi-bolt" aria-hidden="true"></i>
                    <span><strong>Descuento por volumen activo</strong> para {{ cantidadArticulo() }} {{ labelUnidadActiva() }}s</span>
                  </div>
                }

                @if (p.free_goods) {
                  <div class="banner-regalo">
                    <i class="pi pi-gift" aria-hidden="true"></i>
                    <span>Regalo del ERP: <strong>{{ p.free_goods.quantity }} de {{ p.free_goods.sku }}</strong></span>
                  </div>
                }

                @if (p.unpriced_reason) {
                  <p class="p-why-bad">{{ p.unpriced_reason }}</p>
                }

                <!-- El desglose ocupa varias líneas: se pliega. Sigue a un clic, no se quitó. -->
                @if (p.applied.length > 0 || p.not_applied.length > 0) {
                  <details class="calc-details">
                    <summary>¿Cómo se calculó?</summary>
                    @for (s of p.applied; track s.step) {
                      <div class="p-step-row">
                        <span class="step-tag">{{ s.step }}</span>
                        <span class="step-detail">{{ s.detail }}</span>
                        @if (s.before !== null && s.after !== null && s.before !== s.after) {
                          <span class="step-delta">{{ s.before | currency:'MXN':'symbol-narrow':'1.2-2' }} → {{ s.after | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                        }
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
                  </details>
                }
              }
            </div>
          }
      </div>

      <!-- ── BLOQUE 3: La Bandeja donde se van agregando los productos ────────────────── -->
      <div class="card mt-card bandeja-card">
        <div class="card-head">
          <div class="card-head-left">
            <span class="step-num">3</span>
            <h2>Bandeja</h2>
            <span class="badge-count">{{ bandeja().length }} artículo(s)</span>
          </div>
        </div>

        <div class="card-body p-0">
          @if (bandeja().length === 0) {
            <div class="empty-bandeja">
              <i class="pi pi-shopping-cart empty-icon" aria-hidden="true"></i>
              <p class="empty-title">La bandeja está vacía</p>
              <p class="empty-hint">Buscá productos en el paso 2 y agregalos uno a uno.</p>
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
                  <!-- UNA línea por renglón (COT.16): con 15 partidas cabían 7 sin scroll porque
                       cada renglón ocupaba dos (SKU abajo y el desglose abajo del precio). -->
                  @for (item of bandeja(); track item.id; let idx = $index) {
                    <tr [class.row-no-casado]="!item.sku">
                      <td class="num mono">{{ idx + 1 }}</td>
                      <td class="item-cell" [attr.title]="item.barcode ? 'EAN ' + item.barcode : null">
                        @if (item.sku) {
                          <strong class="item-name">{{ item.name }}</strong>
                          <span class="item-sku">{{ item.sku }}</span>
                        } @else {
                          <span class="tag-no-casado">No manejado</span>
                          <strong class="item-name">{{ item.requested_text }}</strong>
                        }
                        @if (item.free_goods) {
                          <span class="gift-tag"><i class="pi pi-gift"></i> Regalo: {{ item.free_goods.quantity }} de {{ item.free_goods.sku }}</span>
                        }
                      </td>
                      <td>
                        @if (item.sku) {
                          <span class="pres-badge">{{ item.unit_label }}</span>
                          @if (item.factor && item.factor > 1) {
                            <span class="pres-factor">x{{ item.factor }}</span>
                          }
                        } @else {
                          <span class="pres-factor">—</span>
                        }
                      </td>
                      <td class="num">
                        <div class="table-qty-control">
                          <button type="button" class="btn-table-step" (click)="ajustarCantidadBandeja(item, -1)" [disabled]="item.quantity <= 1 || guardando()" aria-label="Restar uno">−</button>
                          <input
                            type="text"
                            inputmode="numeric"
                            class="table-qty-val"
                            [value]="item.quantity"
                            (change)="fijarCantidadBandeja(item, $any($event.target).value)"
                            (keydown.enter)="$any($event.target).blur()"
                            (focus)="$any($event.target).select()"
                            [disabled]="guardando()"
                            aria-label="Cantidad del renglón"
                          />
                          <button type="button" class="btn-table-step" (click)="ajustarCantidadBandeja(item, 1)" [disabled]="guardando()" aria-label="Sumar uno">+</button>
                        </div>
                      </td>
                      <td class="num font-num">
                        <span class="p-unit-main">{{ item.unit_price !== null ? (item.unit_price | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</span>
                        @if (item.unit_price !== null) {
                          @for (p of desgloseDe(item); track p.unidad; let ultimo = $last) {
                            <span class="p-unit-sub-breakdown">{{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2' }}/{{ p.unidad }}@if (!ultimo) { ·}</span>
                          }
                        }
                      </td>
                      <td>
                        @if (item.sku) {
                          <span class="source-tag" [class.source-tag-volumen]="item.price_source === 'volume_qty'">
                            @if (item.price_source === 'volume_qty') {
                              <i class="pi pi-bolt" aria-hidden="true"></i>
                            }
                            {{ fuenteLabel(item.price_source) }}
                          </span>
                        } @else {
                          <span class="source-tag">Sin precio</span>
                        }
                      </td>
                      <td class="num font-num bold-num">
                        {{ item.sku ? (item.line_total | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}
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

          }
        </div>
      </div>
      </div>
      <!-- /work -->

      <!-- ── RIEL DERECHO (fijo al hacer scroll): totales + cierre + acciones + asistente IA ──
           Antes los totales vivían al pie de la bandeja y el cierre al fondo de la página: con
           una bandeja larga, el total y el botón Crear quedaban fuera de vista (COT.16). -->
      <aside class="rail" aria-label="Resumen y cierre de la cotización">
        <div class="card rail-card">
          <div class="rail-totales">
            <div class="tot-row">
              <span>Subtotal lista ({{ bandeja().length }} artículo{{ bandeja().length === 1 ? '' : 's' }})</span>
              <b>{{ subtotalBandeja() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>
            @if (descuentoClienteMonto() > 0) {
              <div class="tot-row tot-dto">
                <span>Descuento del cliente ({{ descuentoClientePct() }}%)</span>
                <b>− {{ descuentoClienteMonto() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
            }
            <div class="tot-row tot-final">
              <span>Total</span>
              <b>{{ totalBandeja() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>
          </div>

          <div class="rail-cierre">
            <div class="detail-row">
              <label class="field-item">
                <span>Origen</span>
                <select class="input" [(ngModel)]="origen" [disabled]="guardando()" title="¿De dónde salió la cotización?">
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

            <!-- Opcional y de varias líneas: plegado, se abre solo si ya trae texto -->
            <details class="mensaje-details" [attr.open]="listaCruda ? '' : null">
              <summary>Mensaje original o lista del cliente <em>(opcional)</em></summary>
              <textarea
                class="input textarea"
                rows="3"
                [(ngModel)]="listaCruda"
                placeholder="Pegá acá el correo o WhatsApp recibido. Se guarda como evidencia..."
                [disabled]="guardando()"
                aria-label="Mensaje original o lista del cliente"
              ></textarea>
            </details>
          </div>

          <div class="rail-actions">
            <button pButton class="btn-crear" [disabled]="!puedeCrear() || guardando()" (click)="crear()">
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
            <div class="rail-export">
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
                <span class="p-button-label">{{ exportandoTipo() === 'xlsx' ? 'Generando...' : 'Excel' }}</span>
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
                <span class="p-button-label">{{ exportandoTipo() === 'pdf' ? 'Generando...' : 'PDF' }}</span>
              </button>
            </div>
            <a routerLink="/telemarketing/cotizaciones" class="rail-cancel" [class.is-disabled]="guardando()">Cancelar</a>
          </div>
        </div>

        <!-- Lugar reservado para el asistente de ventas IA. Declara que todavía no existe: no
             pinta sugerencias inventadas (ADR-056). -->
        <div class="ia-placeholder" role="note">
          <h3><i class="pi pi-sparkles" aria-hidden="true"></i> Asistente de ventas IA</h3>
          <p>Aquí aparecerán sugerencias para esta cotización: productos que el cliente suele llevar, oportunidades de volumen y qué le falta a su canasta.</p>
          <span class="ia-tag">Próximamente</span>
        </div>
      </aside>
      </div>
      <!-- /layout -->
    </section>
  `,
  styles: [
    `
      /* COT.16: pantalla apaisada. Zona de trabajo + riel fijo a la derecha; cada línea vertical
         cuenta (maqueta aprobada 2026-10-01). Bajo 1100px el riel baja debajo de la bandeja. */
      .section { padding: 0.6rem 1rem 1rem; max-width: 1600px; margin: 0 auto; }
      .page-head { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.5rem; }
      .page-head h1 { font-size: 1.05rem; font-weight: 700; margin: 0; }
      .crumb-sep { color: var(--text-faint); }
      .back { display: inline-flex; gap: 0.3rem; align-items: center; font-size: var(--fs-xs); color: var(--text-muted); text-decoration: none; }
      .back:hover { color: var(--text-main); }

      .layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 0.75rem; align-items: start; }
      .work { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
      .rail { position: sticky; top: 0.6rem; display: flex; flex-direction: column; gap: 0.6rem; }
      @media (max-width: 68.75rem) {
        .layout { grid-template-columns: 1fr; }
        .rail { position: static; }
      }

      .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow: visible; box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
      .card-head {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        padding: 0.4rem 0.65rem; border-bottom: 1px solid var(--border-color); flex-wrap: wrap; min-height: 38px;
        background: var(--surface-ground, #fafafa);
      }
      .card-head-left { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      .card-head-left h2 { font-size: var(--fs-body); font-weight: 700; margin: 0; white-space: nowrap; }
      /* El buscador de artículo comparte la fila con el título de la tarjeta */
      .card-head-search { flex-wrap: nowrap; }
      .card-head-search .search-step { flex: 1; margin: 0; min-width: 0; }
      .step-num {
        width: 20px; height: 20px; flex: none; border-radius: 50%;
        background: var(--primary-color, var(--action)); color: #fff;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: var(--fs-xs); font-weight: 700;
      }
      .badge-count { font-size: var(--fs-xs); background: var(--neutral-100, #f1f5f9); padding: 2px 6px; border-radius: 9999px; font-weight: 600; color: var(--text-muted); }

      .pills { display: inline-flex; gap: 0.25rem; background: var(--neutral-100, #f1f5f9); padding: 2px; border-radius: 9999px; }
      .pill {
        border: 0; background: none; border-radius: 9999px; padding: 0.2rem 0.65rem;
        font-size: var(--fs-xs); cursor: pointer; color: var(--text-muted); font-weight: 500;
      }
      .pill-active { background: #fff; color: var(--text-main); font-weight: 700; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }

      /* Sucursal desplegable pegada arriba a la derecha */
      .sucursal-dropdown-box { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; }
      .suc-label { font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; }
      /* COT.19: una sola sucursal = dato, no control (no se ofrece elegir lo que no se puede). */
      .suc-fija { font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); white-space: nowrap; }
      .suc-sin { font-size: var(--fs-xs); font-weight: 600; color: var(--bad-fg); display: inline-flex; align-items: center; gap: 0.3rem; }
      .input-select-falta { border-color: var(--action) !important; }
      .input-select {
        padding: 0.3rem 0.6rem; font-size: var(--fs-sm); border: 1px solid var(--border-color);
        border-radius: 6px; background: var(--card-bg); color: var(--text-main); font-weight: 700; min-height: 32px;
      }
      .input-select:focus-visible { outline: 2px solid var(--primary-color, var(--action)); outline-offset: 1px; }

      /* Tira compacta de condiciones comerciales */
      .terms-bar {
        display: flex; align-items: center; gap: 0.75rem; padding: 0.3rem 0.65rem;
        border-top: 1px dashed var(--border-color);
        font-size: var(--fs-xs); flex-wrap: wrap;
      }
      .terms-bar-generic { color: var(--text-muted); font-style: italic; }
      .term-item { display: inline-flex; align-items: baseline; gap: 0.35rem; }
      .t-k { color: var(--text-muted); }
      .t-v { font-weight: 700; font-variant-numeric: tabular-nums; }
      .t-accent { color: var(--primary-color, var(--action)); font-weight: 800; }
      .t-muted { font-style: italic; color: var(--text-muted); font-weight: 400; }
      .term-sep { width: 1px; height: 12px; background: var(--border-color); }
      .term-warn { margin-left: auto; color: var(--yellow-700, #a16207); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; }

      .card-body { padding: 0.5rem 0.65rem; }
      .dest-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
      .dest-main { flex: 1 1 360px; min-width: 0; }
      .p-0 { padding: 0; }

      .search-container { position: relative; width: 100%; }
      .search-box { position: relative; display: flex; align-items: center; }
      .search-icon { position: absolute; left: 0.65rem; color: var(--text-muted); font-size: var(--fs-sm); pointer-events: none; }
      .search-spinner { position: absolute; right: 0.65rem; color: var(--text-muted); font-size: var(--fs-sm); }
      /* .input. sube la especificidad: la regla .input { padding } va DESPUÉS y le borraba
         el padding-left, así la lupa quedaba encima del primer carácter. */
      .input.search-input { padding-left: 2rem; width: 100%; }

      .results-dropdown {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.12); list-style: none; margin: 0; padding: 0;
        max-height: 200px; overflow-y: auto;
      }
      .results-dropdown li + li { border-top: 1px solid var(--border-color); }
      .result-row {
        width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
        padding: 0.45rem 0.7rem; display: flex; align-items: baseline; gap: 0.6rem; font-size: var(--fs-sm);
      }
      .result-row:hover { background: var(--neutral-100, #f1f5f9); }
      .r-code { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--text-main); width: 60px; flex: none; }
      .r-name { flex: 1; font-weight: 600; }
      .r-state { font-size: 0.7rem; color: var(--text-muted); flex: none; }
      .r-badge-warn { font-size: 0.65rem; background: var(--yellow-100, #fef08a); color: var(--yellow-800, #854d0e); padding: 1px 4px; border-radius: 4px; }
      .search-empty { font-size: var(--fs-xs); color: var(--text-muted); margin: 0.35rem 0 0; }

      .chosen-row {
        display: flex; align-items: center; gap: 0.75rem;
      }
      .chosen-details { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
      .chosen-code { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--primary-color, var(--action)); }
      .chosen-name { font-size: var(--fs-body); font-weight: 600; }
      .chosen-meta { font-size: var(--fs-xs); color: var(--text-muted); }
      .btn-change {
        background: none; border: 0; color: var(--primary-color, var(--action));
        cursor: pointer; font-size: var(--fs-xs); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;
      }
      .btn-change:hover { text-decoration: underline; }

      .contact-fields { display: grid; grid-template-columns: 2fr 1.2fr 1.2fr; gap: 0.6rem; }
      @media (max-width: 40rem) { .contact-fields { grid-template-columns: 1fr; } }
      .field-item { display: flex; flex-direction: column; gap: 0.2rem; font-size: var(--fs-xs); }
      .field-item span { color: var(--text-muted); font-weight: 500; }
      .field-item span b { color: var(--red-600, #dc2626); }
      .full-width { width: 100%; }
      .mt-field { margin-top: 0.6rem; }

      .vendedor-inner { display: flex; align-items: center; gap: 0.5rem; flex: 1 1 300px; }
      .vendedor-label {
        font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted);
        display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap;
      }
      .vendedor-label i { color: var(--primary-color, var(--action)); }
      .vendedor-control { position: relative; display: inline-flex; align-items: center; flex: 1; min-width: 0; }
      .vendedor-select { width: 100%; cursor: pointer; font-weight: 600; min-height: 32px; }
      .v-spinner { position: absolute; right: 0.65rem; font-size: var(--fs-xs); color: var(--primary-color, var(--action)); }

      .detail-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
      @media (max-width: 40rem) { .detail-row { grid-template-columns: 1fr; } }

      /* Captura manual de artículos */
      .search-step { position: relative; margin-bottom: 0.5rem; }
      .search-input-wrap { position: relative; display: flex; align-items: center; }
      .search-ico { position: absolute; left: 0.65rem; color: var(--text-muted); font-size: var(--fs-sm); pointer-events: none; }
      .input.search-prod-input { padding-left: 2rem; font-size: var(--fs-sm); min-height: 32px; border-radius: 6px; width: 100%; }

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
        color: var(--text-main); font-size: var(--fs-sm);
      }
      .cat-row:hover, .cat-row-active { background: var(--neutral-100, #f1f5f9); }
      .cat-col-nom { flex: 1 1 auto; min-width: 0; }
      .cat-nom { font-size: var(--fs-body); display: inline-block; font-weight: 600; }
      .cat-cont { color: var(--text-muted); font-size: var(--fs-xs); margin-left: 0.35rem; }
      .cat-col-meta { display: flex; gap: 0.5rem; font-size: var(--fs-xs); color: var(--text-muted); flex: 0 0 auto; }
      .cat-sku { font-family: var(--font-mono, monospace); font-weight: 600; }
      .cat-bc { font-variant-numeric: tabular-nums; }
      .cat-un { font-weight: 600; background: var(--neutral-100, #f1f5f9); padding: 1px 4px; border-radius: 4px; }
      .cat-col-precio { text-align: right; flex: 0 0 5.5rem; display: flex; flex-direction: column; }
      .cat-precio-val { font-weight: 700; font-size: var(--fs-body); font-variant-numeric: tabular-nums; }
      .cat-precio-lbl { font-size: 0.65rem; color: var(--text-muted); }
      .search-hint {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 50;
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        font-size: var(--fs-sm); color: var(--text-muted); background: var(--card-bg);
        border: 1px solid var(--border-color); border-radius: 8px; padding: 0.5rem 0.75rem;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      }
      .btn-no-casado {
        border: 1px dashed var(--border-color); background: var(--card-bg); color: var(--text-main);
        border-radius: 6px; padding: 0.25rem 0.6rem; font-size: var(--fs-xs); font-weight: 600; cursor: pointer;
        display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap;
      }
      .btn-no-casado:hover { border-color: var(--action); color: var(--action); }

      /* Tarjeta de producto descargado */
      .descargado-box {
        display: flex; flex-direction: column; gap: 0.45rem;
      }
      .btn-change-prod {
        background: none; border: 0; color: var(--primary-color, var(--action)); cursor: pointer; font-size: var(--fs-xs);
        font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem; margin-left: auto; white-space: nowrap;
      }
      .btn-change-prod:hover { text-decoration: underline; }

      .descargado-info { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
      .descargado-name { font-size: 0.9375rem; font-weight: 700; color: var(--text-main); }
      .pill-meta { font-size: var(--fs-xs); color: var(--text-muted); background: var(--card-bg); padding: 0.15rem 0.45rem; border-radius: 4px; border: 1px solid var(--border-color); }
      .pill-meta b { color: var(--text-main); }

      /* Pregunta: Caja o Pieza */
      /* Fila de configuración: unidad · cantidad · presets · precio + agregar */
      .config-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      .unit-toggle-group { display: flex; gap: 0.35rem; }
      .unit-toggle-btn {
        flex: none; display: inline-flex; align-items: center; gap: 0.35rem;
        padding: 0 0.65rem; border-radius: 7px; border: 2px solid var(--border-color);
        background: var(--card-bg); cursor: pointer; height: 40px; white-space: nowrap;
        transition: border-color 0.15s, background-color 0.15s;
      }
      .unit-toggle-btn i { font-size: 0.95rem; color: var(--text-muted); }
      .unit-toggle-btn:hover { border-color: var(--primary-color, var(--action)); }
      .unit-toggle-active { border-color: var(--primary-color, var(--action)); background: var(--action-soft, rgba(240, 90, 40, 0.06)); }
      .unit-toggle-active i { color: var(--primary-color, var(--action)); }
      .unit-title { font-weight: 700; font-size: var(--fs-sm); color: var(--text-main); }
      .unit-sub { font-size: 0.7rem; color: var(--text-muted); }

      /* Stepper táctil para móvil 16:9 */
      .touch-stepper { display: flex; align-items: center; gap: 0.25rem; }
      .btn-touch-step {
        width: 34px; height: 40px; flex: none; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: 1.15rem; font-weight: 700; color: var(--text-main);
        cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        user-select: none;
      }
      .btn-touch-step:active { background: var(--neutral-100, #f1f5f9); transform: scale(0.96); }
      .btn-touch-step:disabled { opacity: 0.4; cursor: not-allowed; }
      .touch-qty-readout {
        width: 68px; height: 40px; border-radius: 6px; border: 1px solid var(--border-color);
        background: var(--card-bg); display: flex; flex-direction: column; align-items: center;
        justify-content: center; font-variant-numeric: tabular-nums;
      }
      /* La cantidad es un campo: se teclea (dictado) y Enter agrega */
      .qty-num {
        width: 100%; border: 0; background: transparent; text-align: center; padding: 0;
        font: inherit; font-size: 1.05rem; font-weight: 800; line-height: 1.05; color: var(--text-main);
        font-variant-numeric: tabular-nums;
      }
      .qty-num:focus { outline: none; }
      .qty-num:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
      .touch-qty-readout:focus-within { border-color: var(--action); box-shadow: 0 0 0 2px var(--action-ring, rgba(240, 90, 40, 0.3)); }
      .qty-lbl { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }

      .touch-presets { display: flex; gap: 0.25rem; }
      .preset-btn {
        height: 30px; min-width: 34px; padding: 0 0.45rem; border-radius: 5px; border: 1px solid var(--border-color);
        background: var(--card-bg); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; color: var(--text-muted);
      }
      .preset-btn:hover, .preset-btn:active { background: var(--neutral-100, #f1f5f9); color: var(--text-main); }
      .preset-active { background: var(--primary-color, var(--action)); color: #fff; border-color: var(--primary-color, var(--action)); }

      /* Previa del precio y volumen */
      .previa-loading { font-size: var(--fs-xs); color: var(--text-muted); }
      .previa-top { display: flex; align-items: center; gap: 0.9rem; margin-left: auto; }
      .previa-unit-box { flex: 0 1 auto; }
      .previa-total-box { flex: 0 1 auto; }
      .btn-agregar-inline {
        min-height: 36px; font-size: var(--fs-sm); font-weight: 700; border-radius: 6px;
        padding: 0.4rem 1.1rem; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }
      @media (max-width: 40rem) {
        .previa-top { width: 100%; margin-left: 0; }
        .btn-agregar-inline { width: 100%; justify-content: center; }
      }
      .previa-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; display: block; }
      .previa-price-row { display: flex; align-items: baseline; gap: 0.35rem; }
      .previa-amount { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .previa-unit-sub { font-size: var(--fs-xs); color: var(--text-muted); }
      .previa-menor-sub { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 600; display: block; }
      .previa-total-amount { font-size: 1.05rem; font-weight: 800; color: var(--primary-color, var(--action)); font-variant-numeric: tabular-nums; }
      .previa-none { font-size: var(--fs-body); font-style: italic; color: var(--red-600, #dc2626); }

      .banner-oportunidad-volumen {
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.3rem 0.4rem 0.3rem 0.6rem; background: var(--ember-soft, rgba(248, 180, 0, 0.12));
        border: 1px solid var(--ember-border, rgba(240, 90, 40, 0.3));
        border-radius: 6px; font-size: var(--fs-xs); color: var(--text-main);
      }
      .b-vol-left { display: flex; align-items: center; gap: 0.5rem; flex: 1 1 280px; }
      .b-vol-icon { font-size: var(--fs-body); color: var(--action); flex-shrink: 0; }
      .b-vol-icon-ok { font-size: var(--fs-body); color: #059669; flex-shrink: 0; }
      .b-vol-text { display: flex; flex-direction: column; gap: 0.15rem; }
      .b-vol-title { font-weight: 700; color: #1e3a8a; }
      .b-vol-desc { font-size: var(--fs-xs); flex: 1; }
      .strikethrough { text-decoration: line-through; opacity: 0.65; margin: 0 0.2rem; }
      .btn-aplicar-volumen {
        background: var(--action); color: #fff; border: 0; border-radius: 5px;
        padding: 0.25rem 0.7rem; font-size: var(--fs-xs); font-weight: 700;
        cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap;
        box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      }
      .btn-aplicar-volumen:hover { background: var(--action-hover); }

      .banner-volumen-exito {
        display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.6rem;
        background: #ecfdf5; border: 1px solid #10b981; border-radius: 6px;
        font-size: var(--fs-xs); color: #065f46;
      }
      .banner-volumen-exito .b-vol-title { color: #065f46; }
      .banner-volumen-exito .b-vol-desc { color: #047857; }


      .banner-volumen {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3);
        border-radius: 6px; font-size: var(--fs-xs); color: var(--green-700, #15803d);
      }
      .banner-regalo {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 6px; font-size: var(--fs-xs); color: #1d4ed8;
      }
      .p-step-row { display: flex; align-items: center; gap: 0.5rem; font-size: var(--fs-xs); margin-top: 0.2rem; flex-wrap: wrap; }
      .step-tag { font-weight: 700; color: var(--text-main); }
      .step-detail { color: var(--text-muted); }
      .step-delta { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--green-700, #15803d); }
      .p-why-bad { color: var(--red-600, #dc2626); font-size: var(--fs-xs); margin: 0; }
      .calc-details { font-size: var(--fs-xs); }
      .calc-details summary { cursor: pointer; color: var(--text-muted); font-weight: 600; width: fit-content; }
      .calc-details summary:hover { color: var(--text-main); }

      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 500; margin-left: 0.35rem; }
      .source-tag-volumen { background: #dcfce7 !important; color: #15803d !important; font-weight: 700; }

      /* Bandeja de productos agregados */
      .empty-bandeja { padding: 1rem; text-align: center; color: var(--text-muted); }
      .empty-icon { font-size: 1.4rem; margin-bottom: 0.25rem; opacity: 0.5; }
      .empty-title { font-weight: 600; font-size: 0.95rem; margin: 0 0 0.2rem; color: var(--text-main); }
      .empty-hint { font-size: var(--fs-sm); margin: 0; }

      .table-wrap { overflow-x: auto; width: 100%; }
      .bandeja-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
      .bandeja-table th {
        background: var(--neutral-50, #f8fafc); padding: 0.35rem 0.6rem; text-align: left;
        border-bottom: 1px solid var(--border-color); font-size: var(--fs-xs); color: var(--text-muted);
        font-weight: 600; white-space: nowrap;
      }
      .bandeja-table td { padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
      .num { text-align: right; }
      .mono { font-family: var(--font-mono, monospace); font-size: var(--fs-xs); color: var(--text-muted); }
      .font-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .bold-num { font-weight: 700; color: var(--primary-color, var(--action)); }

      /* Bandeja de UNA línea por renglón: nombre y SKU juntos; el EAN va en el title */
      .item-cell { white-space: nowrap; max-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; }
      .item-name { font-size: var(--fs-sm); }
      .item-sku { font-family: var(--font-mono, monospace); font-weight: 600; font-size: 0.7rem; color: var(--text-muted); margin-left: 0.4rem; }
      .tag-no-casado {
        font-size: var(--fs-nano); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        color: #a16207; background: #fef3c7; border-radius: 4px; padding: 1px 5px; margin-right: 0.4rem;
      }
      .row-no-casado td { background: #fffbeb; }
      .gift-tag { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; color: #1d4ed8; margin-left: 0.4rem; font-weight: 600; }

      .pres-badge { font-weight: 700; background: var(--neutral-100, #f1f5f9); padding: 1px 5px; border-radius: 4px; font-size: var(--fs-xs); }
      .pres-factor { font-size: 0.7rem; color: var(--text-muted); margin-left: 0.25rem; }

      .table-qty-control { display: inline-flex; align-items: center; gap: 0.25rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 1px 3px; }
      .btn-table-step {
        border: 0; background: none; width: 22px; height: 22px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: var(--fs-body);
      }
      .btn-table-step:hover { background: var(--neutral-100, #f1f5f9); border-radius: 4px; }
      .table-qty-val {
        width: 3rem; border: 0; background: transparent; text-align: center; padding: 0;
        font: inherit; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main);
      }
      .table-qty-val:focus { outline: 2px solid var(--action-ring, rgba(240, 90, 40, 0.3)); border-radius: 3px; }

      .source-tag { font-size: 0.7rem; background: var(--neutral-100, #f1f5f9); padding: 2px 6px; border-radius: 4px; color: var(--text-muted); white-space: nowrap; }
      .btn-quitar {
        border: 0; background: none; color: var(--red-600, #dc2626); cursor: pointer;
        padding: 0.3rem; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center;
      }
      .btn-quitar:hover { background: rgba(220, 38, 38, 0.1); }

      /* Resumen totales bandeja */
      .rail-card { display: flex; flex-direction: column; }
      .rail-totales { padding: 0.65rem 0.75rem 0.5rem; display: flex; flex-direction: column; gap: 0.15rem; }
      .tot-row { display: flex; justify-content: space-between; gap: 1rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .tot-row b { color: var(--text-main); font-variant-numeric: tabular-nums; text-align: right; }
      .tot-dto { color: var(--green-700, #15803d); }
      .tot-dto b { color: var(--green-700, #15803d); }
      .tot-final { font-size: var(--fs-body); font-weight: 700; color: var(--text-main); border-top: 1px solid var(--border-color); padding-top: 0.35rem; margin-top: 0.2rem; align-items: baseline; }
      .tot-final b { font-weight: 800; font-size: 1.3rem; color: var(--primary-color, var(--action)); }
      .rail-cierre { padding: 0 0.75rem 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
      .mensaje-details { font-size: var(--fs-xs); }
      .mensaje-details summary { cursor: pointer; color: var(--text-muted); }
      .mensaje-details textarea { margin-top: 0.35rem; }
      .rail-actions { padding: 0.5rem 0.75rem 0.65rem; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 0.4rem; }
      .btn-crear { width: 100%; justify-content: center; font-weight: 700; }
      .rail-export { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
      .rail-export .btn-export { justify-content: center; }
      .rail-cancel { text-align: center; font-size: var(--fs-xs); color: var(--text-muted); }
      .rail-cancel:hover { color: var(--text-main); }
      .rail-cancel.is-disabled { pointer-events: none; opacity: 0.5; }

      /* Asistente IA: lugar reservado. Ember = IA (DESIGN.md), borde punteado = "todavía no". */
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

      .input {
        width: 100%; padding: 0.35rem 0.6rem; box-sizing: border-box; border: 1px solid var(--border-color);
        border-radius: 6px; font-size: var(--fs-sm); background: var(--card-bg); color: var(--text-main); min-height: 32px;
      }
      .input:focus-visible { outline: 2px solid var(--primary-color, var(--action)); outline-offset: 1px; }
      .textarea { min-height: 52px; resize: vertical; font-family: inherit; }

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
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
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

  // COT.19: la sucursal sale del ALCANCE del usuario (ADR-050), no de un '01' fijo. Antes un
  // vendedor de Morelia Abastos abría el cotizador en Padre Hidalgo. Vacía = todavía no se eligió.
  sucursal = signal<string>('');
  /** Respuesta de `GET /commercial/quotes/branches`; `null` = todavía cargando. */
  readonly misRamas = signal<QuoteBranches | null>(null);
  /** Las sucursales en las que puede COTIZAR (escribir), con su nombre, en el orden de la red. */
  readonly sucursalesPermitidas = computed<StoreBranch[]>(() => {
    const r = this.misRamas();
    if (!r) return [];
    const w = r.writable;
    return SUCURSALES_8.filter((s) => w === null || w.includes(s.code));
  });
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
  /** El buscador de artículo: al agregar a la bandeja el cursor vuelve acá para el siguiente. */
  private readonly buscadorArticulo = viewChild<ElementRef<HTMLInputElement>>('buscadorArticulo');
  private focoSinAbrirCatalogo = false;
  /** El campo de cantidad de la franja: recibe el cursor al elegir artículo (dictado sin mouse). */
  private readonly cantidadInput = viewChild<ElementRef<HTMLInputElement>>('cantidadInput');
  /** Renglón resaltado de la lista de artículos (↑/↓ + Enter). */
  readonly resaltado = signal(0);
  /** Término con el que se pidió la lista que hoy se ve: Enter no elige de una lista vieja. */
  private terminoDeResultados = '';
  /** Enter se presionó antes de que llegara la lista del término actual: elegir al llegar. */
  private elegirAlLlegarResultados = false;
  /** Agregar se pidió antes de que llegara el precio de la cantidad/unidad actual. */
  private agregarAlLlegarPrecio = false;

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
    return !!this.cliente();
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
          const suc = this.sucursal();
          const termino = this.terminoArticulo.trim();
          if (!suc) return of({ termino, rows: [] as QuoteCatalogRow[] }); // sin sucursal no hay catálogo (COT.19)
          this.buscandoArticulo.set(true);
          return this.svc.searchCatalog(suc, termino, 50).pipe(
            catchError((err) => {
              this.toast.add({
                severity: err?.status === 403 ? 'warn' : 'error',
                summary: err?.status === 403 ? 'Sin permiso' : 'No se pudo buscar en catálogo',
                detail: err?.error?.message || 'El catálogo de la sucursal no respondió.',
              });
              return of([] as QuoteCatalogRow[]);
            }),
            map((rows) => ({ termino, rows })),
          );
        }),
      )
      .subscribe(({ termino, rows }) => {
        // El ORDEN lo pone el servidor: aciertos exactos y después lo más vendido en la sucursal
        // (COT.16, aprobado 2026-10-01). Antes aquí se re-ordenaba alfabético (pedido del PM) y
        // el producto buscado quedaba en el lugar 4–8, o 23 de 50 con "cimarron".
        const ordenados = rows;
        this.terminoDeResultados = termino;
        this.resultadosArticulos.set(ordenados);
        this.resaltado.set(0);
        this.buscandoArticulo.set(false);
        // Con un artículo ya elegido la lista NO se reabre: una respuesta que llega tarde la
        // abría encima de la franja de cantidad y tapaba el campo donde se está tecleando.
        this.catalogoAbierto.set(!this.articuloElegido());

        // Si es escaneo exacto de código de barras o SKU
        const t = this.terminoArticulo.trim();
        if (ordenados.length === 1 && t && (ordenados[0].sku.toUpperCase() === t.toUpperCase() || ordenados[0].barcode === t)) {
          this.elegirAlLlegarResultados = false;
          this.elegirArticulo(ordenados[0]);
          return;
        }
        // Enter se presionó antes de que llegara esta lista: se elige ahora su primer renglón,
        // sólo si la lista es la del término que está escrito (si siguió tecleando, se espera).
        if (this.elegirAlLlegarResultados && termino === t) {
          this.elegirAlLlegarResultados = false;
          if (ordenados.length) this.elegirArticulo(ordenados[0]);
        }
      });

    // 3. Consulta de precio unitario y descuentos por volumen
    this.previa$
      .pipe(
        debounceTime(250),
        switchMap(() => {
          const suc = this.sucursal();
          const art = this.articuloElegido();
          const qty = this.cantidadArticulo();
          if (!suc || !art || !Number.isFinite(qty) || qty <= 0) {
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
        // Se presionó Enter / Agregar antes de que llegara el precio de la cantidad tecleada.
        // Sólo se agrega cuando llega la previa de lo que HOY está en la franja: si llega una
        // vieja (la de la cantidad anterior) se sigue esperando — antes se apagaba la espera con
        // esa previa vieja y el artículo nunca entraba (COT.16, visto en la prueba de dictado).
        if (this.agregarAlLlegarPrecio) {
          if (!p) {
            this.agregarAlLlegarPrecio = false; // el motor no respondió: no se agrega a ciegas
          } else if (this.previaCorresponde()) {
            this.agregarAlLlegarPrecio = false;
            this.agregarABandeja();
          }
        }
      });

    // 4. COT.19: las sucursales del usuario y la de arranque (la de su perfil si le toca).
    this.svc
      .branches()
      .pipe(
        // Si no contesta se declara «ninguna»: abrir las 8 sería el fail-open que esto cierra.
        catchError(() => of<QuoteBranches>({ mode: 'none', branches: [], writable: [], default_branch: null, resolvable: false })),
      )
      .subscribe((r) => {
        this.misRamas.set(r);
        const permitidas = this.sucursalesPermitidas();
        const inicial = r.default_branch ?? (permitidas.length === 1 ? permitidas[0].code : '');
        if (inicial) {
          this.sucursal.set(inicial);
          this.cargarVendedores(inicial);
        }
      });
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
    // Elegido el cliente, el cursor pasa al buscador de artículo: en los 3 pedidos dictados de
    // la simulación había que dar un clic extra antes de la primera partida (COT.16).
    this.volverAlBuscador();
    this.cliente.set(c);
    this.resultadosClientes.set([]);
    this.terminoCliente = '';
    // Si el cliente tiene la sucursal actual en sus ramas, se conserva; si no, si tiene ramas se sugiere la primera
    if (c.branches && c.branches.length > 0) {
      const match = c.branches.find((b) => b.sucursal === this.sucursal());
      // COT.19: sólo se sugiere una sucursal en la que el usuario pueda cotizar.
      const sugerida = c.branches.find((b) => this.sucursalesPermitidas().some((s) => s.code === b.sucursal));
      if (!match && sugerida) {
        const nuevaSuc = sugerida.sucursal;
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
    const s = val || '';
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
    // Una búsqueda nueva cancela lo que estaba pendiente del artículo anterior: si quedara
    // vivo, se aplicaría al SIGUIENTE artículo (se vio: un gansito de 1 que nadie pidió).
    this.agregarAlLlegarPrecio = false;
    this.elegirAlLlegarResultados = false;
    // Lo que se ve ya no es la lista de lo tecleado: Enter espera la nueva. Sin esto, repetir la
    // MISMA búsqueda ("gansito mini" dos veces) dejaba a Enter frente a una lista vacía.
    this.terminoDeResultados = '';
    this.articuloElegido.set(null);
    this.previaArticulo.set(null);
    this.busquedaArticulo$.next();
  }

  onFocoArticulo(): void {
    if (this.focoSinAbrirCatalogo) return;
    this.catalogoAbierto.set(true);
    if (this.resultadosArticulos().length === 0) {
      this.busquedaArticulo$.next();
    }
  }

  elegirArticulo(p: QuoteCatalogRow): void {
    this.agregarAlLlegarPrecio = false; // lo pendiente era del artículo anterior
    this.articuloElegido.set(p);
    this.catalogoAbierto.set(false);
    this.cantidadArticulo.set(1);
    this.rung.set('base');
    this.previa$.next();
    // Dictado sin mouse (COT.16): elegido el artículo, el cursor pasa a la CANTIDAD (con el 1
    // seleccionado para sobrescribirlo). Enter ahí agrega y regresa al buscador.
    afterNextRender(() => this.cantidadInput()?.nativeElement.focus(), { injector: this.injector });
  }

  limpiarArticulo(): void {
    this.agregarAlLlegarPrecio = false;
    this.articuloElegido.set(null);
    this.previaArticulo.set(null);
    this.catalogoAbierto.set(true);
  }

  /** ↑/↓ en el buscador: mueve el resaltado de la lista sin soltar el teclado. */
  moverResaltado(delta: number): void {
    const n = this.resultadosArticulos().length;
    if (!n) return;
    this.catalogoAbierto.set(true);
    this.resaltado.set(Math.min(n - 1, Math.max(0, this.resaltado() + delta)));
    afterNextRender(
      () => this.host.nativeElement.querySelector('.cat-row-active')?.scrollIntoView({ block: 'nearest' }),
      { injector: this.injector },
    );
  }

  /**
   * Enter en el buscador: elige el resaltado. Si la lista todavía es la de una búsqueda ANTERIOR
   * (se tecleó y se presionó Enter antes de que respondiera el servidor), espera la nueva y
   * elige su primer renglón — elegir de la lista vieja metería otro producto en el pedido.
   */
  elegirResaltado(): void {
    const t = this.terminoArticulo.trim();
    if (!t) return;
    if (this.buscandoArticulo() || this.terminoDeResultados !== t) {
      this.elegirAlLlegarResultados = true;
      return;
    }
    const r = this.resultadosArticulos();
    if (!r.length) return;
    this.elegirArticulo(r[this.resaltado()] ?? r[0]);
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

  /** Cantidad tecleada en la franja. Vacío o no numérico = se conserva la anterior. */
  onCantidadTecleada(valor: string): void {
    const n = parseInt(String(valor).replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 1) return;
    if (n === this.cantidadArticulo()) return;
    this.cantidadArticulo.set(n);
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

  labelUnidadActiva(): string {
    const e = this.articuloElegido();
    if (!e) return 'Pieza';
    return opcionesUnidad(e).find((o) => o.rung === this.rung())?.titulo ?? nombreUnidadBase(e.unit_base, e.sold_by_kg);
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
  /**
   * Agrega el artículo con la cantidad y unidad de la franja.
   *
   * ⚠️ Sólo con un precio que CORRESPONDA a esa cantidad y unidad: con Enter se puede agregar
   * antes de que llegue la previa de la cantidad recién tecleada, y entonces se guardaría el
   * precio (o la cantidad) anterior. En ese caso se espera la previa y se agrega al llegar.
   *
   * Si el mismo artículo en la misma unidad YA está en la bandeja, se SUMA a ese renglón en vez
   * de crear otro: "2 cajas de gansito" + "otras 2" eran dos renglones a $501.80 cuando 4 cajas
   * ya tienen precio de mayoreo de $494.99 — el cliente pagaba de más sin que nadie lo viera.
   */
  /** La previa que se ve corresponde al artículo, la cantidad y la unidad que HOY están en la franja. */
  private previaCorresponde(): boolean {
    const art = this.articuloElegido();
    const prev = this.previaArticulo();
    return (
      !!art && !!prev && !this.cotizandoArticulo() &&
      prev.sku === art.sku && Number(prev.quantity) === this.cantidadArticulo() && prev.rung === this.rung()
    );
  }

  agregarABandeja(): void {
    const art = this.articuloElegido();
    if (!art) return;
    const qty = this.cantidadArticulo();
    const rung = this.rung();
    if (!this.previaCorresponde()) {
      // Se agrega en cuanto llegue la previa de ESTA cantidad/unidad (ver la suscripción).
      this.agregarAlLlegarPrecio = true;
      this.previa$.next();
      return;
    }
    const prev = this.previaArticulo();
    if (prev!.unit_price === null) return;

    const existente = this.bandeja().find((it) => it.sku === art.sku && it.rung === rung);
    if (existente) {
      const total = existente.quantity + qty;
      this.cambiarCantidadBandeja(existente.id, total);
      const n = this.bandeja().indexOf(existente) + 1;
      this.toast.add({
        severity: 'info',
        summary: 'Sumado a una partida que ya estaba',
        detail: `${art.name || art.sku}: renglón ${n} ahora con ${total} ${prev!.unit_label || this.labelUnidadActiva()} (se recalcula el precio).`,
      });
    } else {
      const factorNum = rung === 'box' ? (art.box_size || null) : (rung === 'pack' ? (art.pack_size || null) : null);
      const item: ItemBandeja = {
        id: `${art.sku}_${rung}_${Date.now()}`,
        sku: art.sku,
        name: art.name || art.sku,
        barcode: art.barcode,
        content: art.content,
        rung,
        unit_label: prev!.unit_label || this.labelUnidadActiva(),
        base_unit: abrevUnidadBase(art.unit_base, art.sold_by_kg),
        // La unidad del MEDIO sólo existe dentro de una unidad mayor (COT.17).
        pack_size: rung === 'box' ? paqueteDeCaja(factorNum, art.pack_size) : null,
        factor: factorNum,
        quantity: qty,
        unit_price: prev!.unit_price,
        line_total: prev!.line_total ?? (prev!.unit_price! * qty),
        price_source: prev!.price_source,
        free_goods: prev!.free_goods ? { sku: prev!.free_goods.sku, quantity: prev!.free_goods.quantity } : null,
      };
      this.bandeja.update((items) => [...items, item]);
      this.toast.add({
        severity: 'success',
        summary: 'Agregado a la bandeja',
        detail: `${qty} ${item.unit_label} de ${item.name}`,
      });
    }

    // Limpia para agregar el siguiente artículo fluidamente
    this.articuloElegido.set(null);
    this.previaArticulo.set(null);
    this.terminoArticulo = '';
    this.resultadosArticulos.set([]);
    this.catalogoAbierto.set(false);
    this.cantidadArticulo.set(1);
    this.rung.set('base');
    this.volverAlBuscador();
  }

  /**
   * Lo que el cliente pide y no manejamos (o no se encontró): renglón SIN casar, sin precio. Viaja
   * con la cotización como demanda (`requested_text`) en vez de perderse (COT.16).
   */
  agregarNoManejado(): void {
    const texto = this.terminoArticulo.trim();
    if (!texto) return;
    const item: ItemBandeja = {
      id: `nc_${Date.now()}`,
      sku: '',
      name: texto,
      requested_text: texto,
      barcode: null,
      content: null,
      rung: 'base',
      unit_label: '',
      base_unit: null,
      pack_size: null,
      factor: null,
      quantity: 1,
      unit_price: null,
      line_total: 0,
      price_source: 'unknown',
      free_goods: null,
    };
    this.bandeja.update((items) => [...items, item]);
    this.toast.add({ severity: 'info', summary: 'Anotado como no manejado', detail: `"${texto}" queda en la cotización sin precio.` });
    this.terminoArticulo = '';
    this.resultadosArticulos.set([]);
    this.catalogoAbierto.set(false);
    this.volverAlBuscador();
  }

  /**
   * El cursor vuelve al buscador para escanear/escribir el siguiente sin tocar el mouse. Sin
   * abrir la lista: el foco programático no es "quiero ver el catálogo", y la lista taparía la
   * bandeja recién actualizada. Al teclear se abre sola (búsqueda).
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

  ajustarCantidadBandeja(item: ItemBandeja, delta: number): void {
    // Se parte de la cantidad ACTUAL del renglón, no de la que tenía cuando se pintó el botón:
    // con clics rápidos, 4 × "+" sobre 8 dejaban 9 (cada clic veía el 8) — COT.16.
    const actual = this.bandeja().find((it) => it.id === item.id);
    if (!actual) return;
    this.cambiarCantidadBandeja(item.id, actual.quantity + delta);
  }

  /** Cantidad tecleada en la bandeja ("mejor que sean 12"). */
  fijarCantidadBandeja(item: ItemBandeja, valor: string): void {
    const n = parseInt(String(valor).replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 1) {
      // Vacío o inválido: se vuelve a pintar la cantidad que sí tiene el renglón.
      this.bandeja.update((items) => items.map((it) => (it.id === item.id ? { ...it } : it)));
      return;
    }
    this.cambiarCantidadBandeja(item.id, n);
  }

  /**
   * Cambia la cantidad de un renglón y lo vuelve a preciar (el volumen puede cambiar el precio).
   * La cantidad se aplica AL MOMENTO; la respuesta del precio sólo se aplica si el renglón
   * sigue con esa cantidad — si llegan fuera de orden, la de un clic anterior no pisa la última.
   */
  private cambiarCantidadBandeja(id: string, cantidad: number): void {
    const nuevaQty = Math.max(1, Math.floor(cantidad));
    const actual = this.bandeja().find((it) => it.id === id);
    if (!actual || nuevaQty === actual.quantity) return;

    this.bandeja.update((items) =>
      items.map((it) =>
        it.id === id ? { ...it, quantity: nuevaQty, line_total: it.unit_price !== null ? it.unit_price * nuevaQty : 0 } : it,
      ),
    );
    if (!actual.sku) return; // renglón no manejado: no hay precio que recalcular

    this.svc
      .pricePreview({ branch: this.sucursal(), sku: actual.sku, quantity: nuevaQty, rung: actual.rung })
      .subscribe({
        next: (p) => {
          this.bandeja.update((items) =>
            items.map((it) => {
              if (it.id !== id || it.quantity !== nuevaQty) return it;
              return {
                ...it,
                unit_price: p.unit_price,
                line_total: p.line_total ?? ((p.unit_price || 0) * nuevaQty),
                price_source: p.price_source,
                free_goods: p.free_goods ? { sku: p.free_goods.sku, quantity: p.free_goods.quantity } : null,
              };
            }),
          );
        },
        error: () => {
          // Sin respuesta del motor: la cantidad ya quedó; el precio unitario es el anterior.
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
      source_branch: this.sucursal(),
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
              item.sku
                ? this.svc.addLine(q.id, { sku: item.sku, quantity: item.quantity, rung: item.rung })
                : // Renglón NO manejado: viaja como demanda (requested_text), sin SKU ni precio.
                  this.svc.addLine(q.id, { requested_text: item.requested_text || item.name, quantity: item.quantity }),
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

  /** Precio de cada unidad menor dentro de la mayor: "$121.86/PAQ · $12.19/PZA" (COT.17). */
  desgloseDe(item: ItemBandeja): PasoDesglose[] {
    return item.unit_price === null ? [] : desglose(item.unit_price, item.factor, item.base_unit, item.pack_size);
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

    const sucursalCod = this.sucursal();
    const sucursalObj = this.sucursales8.find((s) => s.code === sucursalCod);
    const branchName = sucursalObj?.name || `Sucursal ${sucursalCod}`;

    const items = this.bandeja().map((it) => ({
      sku: it.sku || '—',
      name: it.sku ? it.name : `NO MANEJADO: ${it.requested_text || it.name}`,
      barcode: it.barcode,
      content: it.content,
      unit_label: it.unit_label || '—',
      rung: it.rung,
      factor: it.factor,
      base_unit: it.base_unit,
      pack_size: it.pack_size,
      quantity: it.quantity,
      unit_price: it.unit_price,
      line_total: it.line_total,
      price_source: this.fuenteLabel(it.price_source),
      free_goods: it.free_goods,
      discount_pct: this.descuentoClientePct() || null,
    }));

    return {
      // Todavía no hay folio: esta cotización no se ha guardado, así que no existe fila que la
      // respalde. El documento lo IMPRIME ("SIN ASIGNAR") en vez de callarlo — un papel sin
      // folio y sin aviso no se puede volver a encontrar cuando el cliente lo cita por teléfono.
      quoteCode: null,
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

