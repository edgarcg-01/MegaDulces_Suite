import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { MessageService } from 'primeng/api';
import { isoLocalDate } from '../../../shared/util/date-presets.util';
import { Subject, debounceTime, distinctUntilChanged, switchMap, catchError, of, map } from 'rxjs';
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
  parseCantidad,
  vendedorDelCliente,
  descuentoDerivado,
  existenciaEnUnidad,
  type OpcionUnidad,
  type PasoDesglose,
  type QuoteBranches,
} from '../quotes.service';

/** [E.20] Un renglón de la bandeja admite fracción sólo si se pesa y va en su unidad base. */
function esPesable(it: { base_unit: string | null; rung: Rung }): boolean {
  return it.base_unit === 'KG' && it.rung === 'base';
}
import { totalesCotizacion } from '@megadulces/contracts';
import { QuoteLinesTableComponent, type RenglonTabla, type CambioCantidad } from '../components/quote-lines-table.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { pasosDelPrecio } from '../quote-discount-breakdown';

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
  /** `[E.25]` IVA e IEPS del producto (del motor). null = sin ficha o sin precio. */
  iva_rate?: number | null;
  ieps_rate?: number | null;
  /** `[E.29]` Precio de lista de la presentación y los pasos del precio («lista $26.94 → volumen $24.79»). */
  list_price?: number | null;
  pasos?: string;
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
    SelectModule,
    SelectButtonModule,
    AutoCompleteModule,
    DatePickerModule,
    InputTextModule,
    TextareaModule,
    IconFieldModule,
    InputIconModule,
    InputGroupModule,
    InputGroupAddonModule,
    QuoteLinesTableComponent,
    FreshnessPillComponent,
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
            <p-selectbutton
              [options]="modos"
              [ngModel]="modo()"
              (ngModelChange)="setModo($event)"
              optionLabel="label"
              optionValue="value"
              [allowEmpty]="false"
              [disabled]="guardando()"
              styleClass="sb-liquid sb-liquid-sm"
              ariaLabel="Tipo de destinatario"
            />
          </div>

          <!-- COT.19: SÓLO las sucursales del usuario (ADR-050). Una → fija; varias → selector;
               ninguna → se declara, no se abren las 8. -->
          <div class="sucursal-dropdown-box">
            @if (misRamas() === null) {
              <span class="suc-label"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Cargando sucursales…</span>
            } @else if (sucursalesPermitidas().length === 0) {
              <span class="suc-sin" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Sin sucursal asignada: pide a un administrador que te asigne tu sucursal para poder cotizar.
              </span>
            } @else if (sucursalesPermitidas().length === 1) {
              <span class="suc-label"><i class="pi pi-building" aria-hidden="true"></i> Sucursal:</span>
              <span class="suc-fija">{{ sucursalesPermitidas()[0].name }}</span>
            } @else {
              <label for="sucursalSelect" class="suc-label">
                <i class="pi pi-building" aria-hidden="true"></i> Sucursal:
              </label>
              <!-- La sucursal por NOMBRE, nunca por su código. Las plazas donde el cliente ya tiene
                   condiciones se dicen en el renglón (antes era un «*» sin leyenda). -->
              <p-select
                inputId="sucursalSelect"
                class="suc-select"
                [options]="sucursalesPermitidas()"
                optionLabel="name"
                optionValue="code"
                [ngModel]="sucursal() || null"
                (ngModelChange)="onSucursalChange($event)"
                placeholder="Elige la sucursal…"
                [invalid]="!sucursal()"
                [disabled]="guardando()"
                appendTo="body"
              >
                <ng-template #item let-s>
                  <span class="suc-opt">
                    {{ s.name }}
                    @if (clienteTieneSucursal(s.code)) {
                      <span class="suc-opt-hint">condiciones del cliente</span>
                    }
                  </span>
                </ng-template>
              </p-select>
            }
          </div>
        </div>

        <div class="card-body">
          <div class="dest-row">
          <div class="dest-main">
          @if (modo() === 'mayoreo') {
            @if (!cliente()) {
              <!-- La lista se abre al teclear y se cierra al elegir, con Esc o al salir del campo.
                   Antes era una lista propia que quedaba ABIERTA con los primeros 20 del padrón
                   aunque no se hubiera tecleado nada, tapando el artículo y la bandeja. Enter
                   elige el primero (autoOptionFocus), como antes. -->
              <p-iconfield class="cli-buscar">
                <p-inputicon class="pi pi-search" />
                <p-autocomplete
                  inputId="clienteBuscar"
                  [ngModel]="terminoCliente"
                  (ngModelChange)="onTerminoClienteModel($event)"
                  [suggestions]="resultadosClientes()"
                  (completeMethod)="onBuscarCliente($event.query)"
                  (onSelect)="elegirCliente($event.value)"
                  optionLabel="name"
                  [delay]="250"
                  [minQueryLength]="1"
                  [autoOptionFocus]="true"
                  [showEmptyMessage]="true"
                  [fluid]="true"
                  appendTo="body"
                  placeholder="Buscar cliente de mayoreo: código, nombre o RFC, palabras en cualquier orden…"
                  ariaLabel="Buscar cliente de mayoreo"
                >
                  <ng-template #item let-c>
                    <span class="r-row">
                      <span class="r-code">{{ c.customer_code }}</span>
                      <span class="r-name">{{ c.name }}</span>
                      <span class="r-state">{{ c.state || c.phone || '' }}</span>
                      @if (c.terms_vary_by_branch) {
                        <p-tag severity="warn" value="condiciones cambian por sucursal" />
                      }
                    </span>
                  </ng-template>
                  <ng-template #empty>Ningún cliente de mayoreo coincide con «{{ terminoCliente }}».</ng-template>
                </p-autocomplete>
              </p-iconfield>
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
                <p-button
                  label="Cambiar"
                  icon="pi pi-pencil"
                  size="small"
                  [text]="true"
                  (onClick)="limpiarCliente()"
                  [disabled]="guardando()"
                  ariaLabel="Cambiar cliente"
                />
              </div>
            }
          } @else {
            <!-- Modo contacto provisional -->
            <div class="contact-fields">
              <label class="field-item field-name">
                <span>Nombre o razón social <b>*</b></span>
                <input
                  pInputText
                  type="text"
                  [fluid]="true"
                  [ngModel]="contactoNombre()" (ngModelChange)="contactoNombre.set($event)"
                  placeholder="Quién solicita la cotización"
                  [disabled]="guardando()"
                />
              </label>
              <label class="field-item">
                <span>Teléfono / WhatsApp</span>
                <input
                  pInputText
                  type="tel"
                  [fluid]="true"
                  [(ngModel)]="contactoTel"
                  inputmode="tel"
                  placeholder="Ej. 352 123 4567"
                  [disabled]="guardando()"
                />
              </label>
              <label class="field-item">
                <span>Correo electrónico</span>
                <input
                  pInputText
                  type="email"
                  [fluid]="true"
                  [(ngModel)]="contactoMail"
                  inputmode="email"
                  placeholder="cliente@dominio.com"
                  [disabled]="guardando()"
                />
              </label>
            </div>
          }
          </div>

          <!-- VENDEDOR: lo pone el CLIENTE, no se pregunta. En los pedidos de telemarketing de
               Kepler (90 d) el vendedor del pedido (kdm1.c12) es el del cliente (kdud.c12) en
               3,257 de 3,336. Se ofrece cambiarlo para el resto; sin cliente no hay de dónde
               sacarlo, y en «Todavía no es cliente» se elige. -->
          @if (modo() === 'contacto' || cliente()) {
            <div class="vendedor-inner">
              @if (vendedorFijo(); as vc) {
                <span class="vendedor-label"><i class="pi pi-user" aria-hidden="true"></i> Vendedor</span>
                <span class="vendedor-fijo">{{ vc.name }}</span>
                <span class="vendedor-origen">del cliente en Kepler</span>
                <p-button
                  label="Cambiar"
                  size="small"
                  [text]="true"
                  (onClick)="cambiandoVendedor.set(true)"
                  [disabled]="guardando()"
                  ariaLabel="Cambiar el vendedor"
                />
              } @else {
                <label for="vendedorSelect" class="vendedor-label">
                  <i class="pi pi-user" aria-hidden="true"></i> Vendedor
                </label>
                <p-select
                  inputId="vendedorSelect"
                  class="vendedor-select"
                  [options]="opcionesVendedor()"
                  optionLabel="label"
                  optionValue="value"
                  [ngModel]="vendedorSeleccionado()"
                  (ngModelChange)="onVendedorChange($event)"
                  [placeholder]="modo() === 'mayoreo' && !vendedorCliente() ? 'El cliente no trae vendedor en Kepler: elige uno' : 'Vendedor que da seguimiento'"
                  [filter]="true"
                  filterBy="label"
                  [showClear]="true"
                  [loading]="cargandoVendedores()"
                  [disabled]="guardando() || cargandoVendedores()"
                  emptyMessage="Sin vendedores que mostrar"
                  appendTo="body"
                />
              }
            </div>
          }
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
            <span class="t-muted">Condiciones base del ERP en {{ branchName(sucursal()) }} (sin descuento de mayoreo registrado en esta plaza).</span>
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
            <!-- La lista de abajo NO es p-autocomplete a propósito: Enter antes de que llegue la
                 respuesta elige el primer renglón de ESA respuesta y el escaneo exacto se elige
                 solo (COT.16); p-autocomplete atiende Enter sobre la lista que tiene a la vista. -->
            <p-iconfield class="search-input-wrap" [attr.title]="sucursal() ? 'Sucursal activa: ' + branchName(sucursal()) : null">
              <p-inputicon class="pi pi-search" />
              <input
                pInputText
                [fluid]="true"
                id="prodSearchInput"
                #buscadorArticulo
                type="search"
                [(ngModel)]="terminoArticulo"
                (ngModelChange)="onTerminoArticulo($event)"
                (focus)="onFocoArticulo()"
                (keydown.arrowdown)="$event.preventDefault(); moverResaltado(1)"
                (keydown.arrowup)="$event.preventDefault(); moverResaltado(-1)"
                (keydown.enter)="$event.preventDefault(); elegirResaltado()"
                [placeholder]="sucursal() ? 'Escanea el código de barras o escribe SKU / nombre (palabras en cualquier orden) · ↑↓ y Enter para elegir' : 'Primero elige la sucursal'"
                autocorrect="off"
                spellcheck="false"
                [disabled]="guardando() || !sucursal()"
              />
              @if (buscandoArticulo()) {
                <p-inputicon class="pi pi-spin pi-spinner" />
              }
            </p-iconfield>

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
                <span>Ningún artículo en {{ branchName(sucursal()) }} coincide con <strong>«{{ terminoArticulo }}»</strong>.</span>
                <p-button
                  label="Anotar como no manejado"
                  icon="pi pi-plus"
                  size="small"
                  severity="secondary"
                  [outlined]="true"
                  (onClick)="agregarNoManejado()"
                  [disabled]="guardando()"
                />
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
                <p-button
                  class="btn-change-prod"
                  label="Cambiar artículo"
                  icon="pi pi-pencil"
                  size="small"
                  [text]="true"
                  (onClick)="limpiarArticulo()"
                  [disabled]="guardando()"
                />
              </div>

              <!-- Fila 2: unidad · cantidad · presets · precio · agregar (una sola franja). Sin
                   rótulo de pregunta: los botones se explican solos y sólo están los que el ERP
                   declara (COT.16). -->
              <div class="config-row">
                <!-- Unidades de MENOR a MAYOR (izq → der): KINDER DELICE = Pieza 1 · Paquete 10 ·
                     Caja 140. Sólo las que el ERP declara; el nombre de la base es el real
                     (Paquete, Kilo, Pieza…), no "Pieza" fijo (COT.16). -->
                <p-selectbutton
                  class="unit-toggle-group"
                  [options]="opcionesUnidadElegido()"
                  [ngModel]="rung()"
                  (ngModelChange)="setRung($event)"
                  optionLabel="titulo"
                  optionValue="rung"
                  [allowEmpty]="false"
                  [disabled]="guardando()"
                  ariaLabel="Unidad de venta del artículo"
                >
                  <ng-template #item let-o>
                    <i class="pi {{ o.icono }}" aria-hidden="true"></i>
                    <span class="unit-title">{{ o.titulo }}</span>
                    <span class="unit-sub">· {{ o.detalle }}</span>
                  </ng-template>
                </p-selectbutton>

                <!-- CANTIDAD: se TECLEA (dictado: "48 cajas" = 2 teclas, antes 8 clics) y Enter
                     agrega; los botones + / − / presets siguen para captura táctil (COT.16). -->
                <!-- El campo es texto con pInputText, NO p-inputnumber: p-inputnumber lee la coma como
                     separador de miles y «2,5» kg entraría como 25. parseCantidad la rechaza por
                     ambigua (E.20), y eso no se negocia por cambiar de componente. -->
                <p-inputgroup class="touch-stepper">
                  <p-button
                    icon="pi pi-minus"
                    severity="secondary"
                    [outlined]="true"
                    (onClick)="ajustarCantidad(-1)"
                    [disabled]="cantidadArticulo() <= 1 || guardando()"
                    ariaLabel="Restar una unidad"
                  />
                  <input
                    pInputText
                    #cantidadInput
                    type="text"
                    [attr.inputmode]="admiteFraccion() ? 'decimal' : 'numeric'"
                    class="qty-num"
                    [value]="cantidadArticulo()"
                    (input)="onCantidadTecleada($any($event.target).value)"
                    (keydown.enter)="$event.preventDefault(); agregarABandeja()"
                    (focus)="$any($event.target).select()"
                    [disabled]="guardando()"
                    [attr.aria-label]="'Cantidad en ' + labelUnidadActiva()"
                  />
                  <p-inputgroup-addon class="qty-lbl">{{ labelUnidadActiva() }}</p-inputgroup-addon>
                  <p-button
                    icon="pi pi-plus"
                    severity="secondary"
                    [outlined]="true"
                    (onClick)="ajustarCantidad(1)"
                    [disabled]="guardando()"
                    ariaLabel="Sumar una unidad"
                  />
                </p-inputgroup>

                <!-- Presets táctiles para no desplegar teclado en pantalla -->
                <div class="touch-presets" role="group" aria-label="Incrementos rápidos de cantidad">
                  <p-button label="1" size="small" severity="secondary" [outlined]="cantidadArticulo() !== 1" (onClick)="setCantidad(1)" [disabled]="guardando()" ariaLabel="Cantidad 1" />
                  @for (n of incrementos; track n) {
                    <p-button [label]="'+' + n" size="small" severity="secondary" [outlined]="true" (onClick)="ajustarCantidad(n)" [disabled]="guardando()" [ariaLabel]="'Sumar ' + n" />
                  }
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
                        <span class="previa-none">Sin precio en {{ branchName(sucursal()) }}</span>
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
                      <p-button
                        [label]="'Aplicar ' + vt.min_qty"
                        icon="pi pi-check"
                        size="small"
                        (onClick)="setCantidad(vt.min_qty)"
                        [disabled]="guardando()"
                      />
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

      <!-- ── BLOQUE 3: Los renglones, tal cual se verán en la cotización ─────────────────
           [E.29] Misma tabla que el detalle (app-quote-lines-table): existencia de hoy, lista,
           precio, de dónde sale el descuento e importe. Lo que se ve antes de crear es lo que
           queda guardado. -->
      <div class="card mt-card bandeja-card">
        <div class="card-head">
          <div class="card-head-left">
            <span class="step-num">3</span>
            <h2>Renglones</h2>
            <p-tag severity="secondary" [rounded]="true" [value]="bandeja().length + (bandeja().length === 1 ? ' artículo' : ' artículos')" />
            @if (existenciaAl(); as al) {
              <app-freshness-pill measures="data" [since]="al" label="Existencia"></app-freshness-pill>
            } @else if (existenciaError()) {
              <span class="exist-error" role="status">No se pudo leer la existencia</span>
            }
          </div>
        </div>

        <div class="card-body p-0">
          @if (bandeja().length === 0) {
            <div class="empty-bandeja">
              <i class="pi pi-shopping-cart empty-icon" aria-hidden="true"></i>
              <p class="empty-title">Todavía no hay renglones</p>
              <p class="empty-hint">Busca productos en el paso 2 y agrégalos uno a uno.</p>
            </div>
          } @else {
            <app-quote-lines-table
              [renglones]="renglonesBandeja()"
              [bloqueado]="guardando()"
              (cantidad)="onCantidadBandeja($event)"
              (quitar)="quitarDeBandeja($event)"
            />
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
              <span>Importe de los artículos ({{ bandeja().length }})</span>
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
            <!-- [E.25] Incluidos en el total, con la tasa de cada producto (como el documento de Kepler). -->
            <div class="tot-row"><span>IVA incluido</span><b>{{ totalesBandeja().iva | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
            <div class="tot-row"><span>IEPS incluido</span><b>{{ totalesBandeja().ieps | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
          </div>

          <div class="rail-cierre">
            <div class="detail-row">
              <div class="field-item">
                <label for="origenSelect">Origen</label>
                <!-- El «¿de dónde salió?» vivía en un title; ahora cada opción lo dice. -->
                <p-select
                  inputId="origenSelect"
                  [options]="origenes"
                  optionLabel="label"
                  optionValue="value"
                  [(ngModel)]="origen"
                  [disabled]="guardando()"
                  [fluid]="true"
                  appendTo="body"
                >
                  <ng-template #item let-o>
                    <span class="origen-opt">
                      <span>{{ o.label }}</span>
                      <span class="origen-hint">{{ o.hint }}</span>
                    </span>
                  </ng-template>
                </p-select>
              </div>
              <div class="field-item">
                <label for="vigenciaFecha">Vigencia hasta</label>
                <p-datepicker
                  inputId="vigenciaFecha"
                  [(ngModel)]="vigencia"
                  [minDate]="hoy"
                  dateFormat="dd/mm/yy"
                  [showIcon]="true"
                  [disabled]="guardando()"
                  [fluid]="true"
                  appendTo="body"
                />
              </div>
            </div>

            <!-- Opcional y de varias líneas: plegado, se abre solo si ya trae texto. <details> es
                 nativo a propósito (DESIGN regla 3: plataforma antes que JS). -->
            <details class="mensaje-details" [attr.open]="listaCruda ? '' : null">
              <summary>Mensaje original o lista del cliente <em>(opcional)</em></summary>
              <textarea
                pTextarea
                [fluid]="true"
                [autoResize]="true"
                rows="3"
                [(ngModel)]="listaCruda"
                placeholder="Pega acá el correo o WhatsApp recibido. Se guarda como evidencia..."
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
            <!-- [E.29] Excel y PDF CREAN la cotización y descargan el papel desde el detalle, con
                 folio y con el total que guardó el servidor. Antes generaban el archivo sin
                 guardar nada: un papel «Folio: SIN ASIGNAR» en manos del cliente, sin registro
                 detrás, aunque el botón decía «Crear y descargar». -->
            <div class="rail-export">
              <p-button
                class="btn-export"
                label="Excel"
                icon="pi pi-file-excel"
                severity="success"
                [outlined]="true"
                [fluid]="true"
                [disabled]="!puedeCrear() || guardando()"
                (onClick)="crear('xlsx')"
                ariaLabel="Crear la cotización y descargar el Excel"
              />
              <p-button
                class="btn-export"
                label="PDF"
                icon="pi pi-file-pdf"
                severity="danger"
                [outlined]="true"
                [fluid]="true"
                [disabled]="!puedeCrear() || guardando()"
                (onClick)="crear('pdf')"
                ariaLabel="Crear la cotización y descargar el PDF"
              />
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

      <!-- [E.29] Con poco ancho el riel baja debajo de la bandeja y, con una bandeja larga, el total
           y «Crear» quedaban fuera de vista (lo que COT.16 arregló en pantalla ancha). Esta barra
           sólo existe en angosto (CSS por contenedor) y se queda pegada abajo mientras se baja. -->
      @if (bandeja().length > 0) {
        <div class="barra-cierre" role="region" aria-label="Total y crear cotización">
          <span class="barra-total">
            <span class="barra-n">{{ bandeja().length }} {{ bandeja().length === 1 ? 'artículo' : 'artículos' }}</span>
            <b>{{ totalBandeja() | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
          </span>
          <p-button
            label="Crear cotización"
            icon="pi pi-check"
            [loading]="guardando()"
            [disabled]="!puedeCrear() || guardando()"
            (onClick)="crear()"
          />
        </div>
      }
    </section>
  `,
  styles: [
    `
      /* COT.16: pantalla apaisada. Zona de trabajo + riel fijo a la derecha; cada línea vertical
         cuenta (maqueta aprobada 2026-10-01). Con poco ancho el riel baja debajo de la bandeja.
         [E.29] El ancho se mide contra ESTA pantalla (contenedor cot), no contra la ventana: en
         pantalla partida la ventana dice escritorio y la cotizacion tiene la mitad. Los cortes
         son los mismos que con la ventana completa (68.75rem y 40rem de ventana = 62.75rem y
         38rem de contenedor). El contenedor va aqui y no en :host para que el p-toast, que va
         fuera de .section, siga fijo a la ventana. */
      .section { padding: 0.6rem 1rem 1rem; max-width: 1600px; margin: 0 auto; container: cot / inline-size; }
      .page-head { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.5rem; }
      .page-head h1 { font-size: 1.05rem; font-weight: 700; margin: 0; }
      .crumb-sep { color: var(--text-faint); }
      .back { display: inline-flex; gap: 0.3rem; align-items: center; font-size: var(--fs-xs); color: var(--text-muted); text-decoration: none; }
      .back:hover { color: var(--text-main); }

      .layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 0.75rem; align-items: start; }
      .work { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
      .rail { position: sticky; top: 0.6rem; display: flex; flex-direction: column; gap: 0.6rem; }
      .barra-cierre { display: none; }
      @container cot (max-width: 62.75rem) {
        .barra-cierre {
          display: flex; position: sticky; bottom: 0; z-index: 5; margin-top: 0.6rem;
          align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.75rem;
          background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px;
        }
        .barra-total { display: flex; align-items: baseline; gap: 0.6rem; font-variant-numeric: tabular-nums; }
        .barra-n { font-size: var(--fs-xs); color: var(--text-muted); }
        .barra-total b { font-size: var(--fs-body); font-weight: 800; }
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
        background: var(--action); color: var(--action-ink);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: var(--fs-xs); font-weight: 700;
      }
      /* Sucursal desplegable pegada arriba a la derecha */
      .sucursal-dropdown-box { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; }
      .suc-label { font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; }
      /* COT.19: una sola sucursal = dato, no control (no se ofrece elegir lo que no se puede). */
      .suc-fija { font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); white-space: nowrap; }
      .suc-sin { font-size: var(--fs-xs); font-weight: 600; color: var(--bad-fg); display: inline-flex; align-items: center; gap: 0.3rem; }
      .suc-select { min-width: 14rem; }
      .suc-opt { display: flex; align-items: baseline; gap: 0.5rem; }
      .suc-opt-hint { font-size: var(--fs-xs); color: var(--text-muted); }

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
      /* Cifras en --text-main: --action como texto sobre blanco da 3.39:1 (AA pide 4.5) y el color de
         marca es para acción, no para datos. El peso marca la jerarquía. */
      .t-accent { color: var(--text-main); font-weight: 800; }
      .t-muted { font-style: italic; color: var(--text-muted); font-weight: 400; }
      .term-sep { width: 1px; height: 12px; background: var(--border-color); }
      .term-warn { margin-left: auto; color: var(--warn-soft-fg); font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; }

      .card-body { padding: 0.5rem 0.65rem; }
      .dest-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
      .dest-main { flex: 1 1 360px; min-width: 0; }
      .p-0 { padding: 0; }

      .cli-buscar { display: block; width: 100%; }
      /* Renglón del autocompletado de clientes (va en el overlay, dentro de la plantilla #item). */
      .r-row { display: flex; align-items: baseline; gap: 0.6rem; width: 100%; font-size: var(--fs-sm); }
      .r-code { font-family: var(--font-mono, monospace); font-weight: 700; width: 4.5rem; flex: none; }
      .r-name { flex: 1; font-weight: 600; min-width: 0; }
      .r-state { font-size: var(--fs-xs); color: var(--text-muted); flex: none; }

      .chosen-row {
        display: flex; align-items: center; gap: 0.75rem;
      }
      .chosen-details { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
      .chosen-code { font-family: var(--font-mono, monospace); font-weight: 700; color: var(--text-main); }
      .chosen-name { font-size: var(--fs-body); font-weight: 600; }
      .chosen-meta { font-size: var(--fs-xs); color: var(--text-muted); }

      .contact-fields { display: grid; grid-template-columns: 2fr 1.2fr 1.2fr; gap: 0.6rem; }
      @container cot (max-width: 38rem) { .contact-fields { grid-template-columns: 1fr; } }
      .field-item { display: flex; flex-direction: column; gap: 0.2rem; font-size: var(--fs-xs); }
      .field-item > span, .field-item > label { color: var(--text-muted); font-weight: 500; }
      .field-item span b { color: var(--bad-fg); }

      .vendedor-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; flex: 1 1 300px; min-width: 0; }
      .vendedor-label {
        font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted);
        display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap;
      }
      .vendedor-label i { color: var(--action); }
      .vendedor-select { flex: 1; min-width: 0; }
      .vendedor-fijo { font-size: var(--fs-sm); font-weight: 600; white-space: nowrap; }
      .vendedor-origen { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
      .origen-opt { display: flex; flex-direction: column; }
      .origen-hint { font-size: var(--fs-xs); color: var(--text-muted); }

      /* Una columna: el riel mide 340px y a dos columnas «El cliente mandó su lista» salía cortado. */
      .detail-row { display: grid; grid-template-columns: 1fr; gap: 0.6rem; }

      /* Captura manual de artículos */
      .search-step { position: relative; margin-bottom: 0.5rem; }
      .search-input-wrap { display: block; width: 100%; }

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
      .cat-row:hover, .cat-row-active { background: var(--hover-bg); }
      .cat-col-nom { flex: 1 1 auto; min-width: 0; }
      .cat-nom { font-size: var(--fs-body); display: inline-block; font-weight: 600; }
      .cat-cont { color: var(--text-muted); font-size: var(--fs-xs); margin-left: 0.35rem; }
      .cat-col-meta { display: flex; gap: 0.5rem; font-size: var(--fs-xs); color: var(--text-muted); flex: 0 0 auto; }
      .cat-sku { font-family: var(--font-mono, monospace); font-weight: 600; }
      .cat-bc { font-variant-numeric: tabular-nums; }
      .cat-un { font-weight: 600; background: var(--surface-ground); padding: 1px 4px; border-radius: 4px; }
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

      /* Tarjeta de producto descargado */
      .descargado-box {
        display: flex; flex-direction: column; gap: 0.45rem;
      }
      .btn-change-prod { margin-left: auto; }

      .descargado-info { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
      .descargado-name { font-size: 0.9375rem; font-weight: 700; color: var(--text-main); }
      .pill-meta { font-size: var(--fs-xs); color: var(--text-muted); background: var(--card-bg); padding: 0.15rem 0.45rem; border-radius: 4px; border: 1px solid var(--border-color); }
      .pill-meta b { color: var(--text-main); }

      /* Pregunta: Caja o Pieza */
      /* Fila de configuración: unidad · cantidad · presets · precio + agregar */
      .config-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
      /* Unidad (p-selectbutton con plantilla): ícono · nombre · contenido */
      .unit-toggle-group { flex: none; }
      .unit-title { font-weight: 700; font-size: var(--fs-sm); }
      .unit-sub { font-size: var(--fs-xs); color: var(--text-muted); }

      /* Cantidad: − [campo][unidad] + — se teclea (dictado) y Enter agrega */
      .touch-stepper { width: auto; flex: none; }
      .qty-num { width: 4.5rem; text-align: center; font-size: var(--fs-body); font-weight: 800; font-variant-numeric: tabular-nums; }
      .qty-lbl { font-size: var(--fs-xs); text-transform: uppercase; font-weight: 600; }

      .touch-presets { display: flex; gap: 0.25rem; }

      /* Previa del precio y volumen */
      .previa-loading { font-size: var(--fs-xs); color: var(--text-muted); }
      .previa-top { display: flex; align-items: center; gap: 0.9rem; margin-left: auto; }
      .previa-unit-box { flex: 0 1 auto; }
      .previa-total-box { flex: 0 1 auto; }
      .btn-agregar-inline {
        min-height: 36px; font-size: var(--fs-sm); font-weight: 700; border-radius: 6px;
        padding: 0.4rem 1.1rem; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }
      @container cot (max-width: 38rem) {
        .previa-top { width: 100%; margin-left: 0; }
        .btn-agregar-inline { width: 100%; justify-content: center; }
      }
      .previa-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; display: block; }
      .previa-price-row { display: flex; align-items: baseline; gap: 0.35rem; }
      .previa-amount { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .previa-unit-sub { font-size: var(--fs-xs); color: var(--text-muted); }
      .previa-menor-sub { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 600; display: block; }
      .previa-total-amount { font-size: 1.05rem; font-weight: 800; color: var(--text-main); font-variant-numeric: tabular-nums; }
      .previa-none { font-size: var(--fs-body); font-style: italic; color: var(--bad-fg); }

      .banner-oportunidad-volumen {
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.3rem 0.4rem 0.3rem 0.6rem; background: var(--ember-soft, rgba(248, 180, 0, 0.12));
        border: 1px solid var(--ember-border, rgba(240, 90, 40, 0.3));
        border-radius: 6px; font-size: var(--fs-xs); color: var(--text-main);
      }
      .b-vol-icon { font-size: var(--fs-body); color: var(--action); flex-shrink: 0; }
      .b-vol-icon-ok { font-size: var(--fs-body); color: var(--ok-fg); flex-shrink: 0; }
      .b-vol-desc { font-size: var(--fs-xs); flex: 1; }
      .strikethrough { text-decoration: line-through; opacity: 0.65; margin: 0 0.2rem; }

      .banner-volumen-exito {
        display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.6rem;
        background: var(--ok-soft-bg); border: 1px solid var(--ok-border); border-radius: 6px;
        font-size: var(--fs-xs); color: var(--ok-soft-fg);
      }

      .banner-volumen {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: var(--ok-soft-bg); border: 1px solid var(--ok-border);
        border-radius: 6px; font-size: var(--fs-xs); color: var(--ok-soft-fg);
      }
      .banner-regalo {
        display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.6rem;
        background: var(--info-soft-bg); border: 1px solid var(--info-border);
        border-radius: 6px; font-size: var(--fs-xs); color: var(--info-soft-fg);
      }
      .p-step-row { display: flex; align-items: center; gap: 0.5rem; font-size: var(--fs-xs); margin-top: 0.2rem; flex-wrap: wrap; }
      .step-tag { font-weight: 700; color: var(--text-main); }
      .step-detail { color: var(--text-muted); }
      .step-delta { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ok-soft-fg); }
      .p-why-bad { color: var(--bad-fg); font-size: var(--fs-xs); margin: 0; }
      .calc-details { font-size: var(--fs-xs); }
      .calc-details summary { cursor: pointer; color: var(--text-muted); font-weight: 600; width: fit-content; }
      .calc-details summary:hover { color: var(--text-main); }

      .p-unit-main { font-weight: 700; }
      .p-unit-sub-breakdown { font-size: var(--fs-micro); color: var(--text-muted); font-weight: 500; margin-left: 0.35rem; }

      /* Bandeja de productos agregados */
      .empty-bandeja { padding: 1rem; text-align: center; color: var(--text-muted); }
      .empty-icon { font-size: 1.4rem; margin-bottom: 0.25rem; opacity: 0.5; }
      .empty-title { font-weight: 600; font-size: 0.95rem; margin: 0 0 0.2rem; color: var(--text-main); }
      .empty-hint { font-size: var(--fs-sm); margin: 0; }

      .exist-error { font-size: var(--fs-xs); color: var(--bad-fg); }

      /* Resumen totales bandeja */
      .rail-card { display: flex; flex-direction: column; }
      .rail-totales { padding: 0.65rem 0.75rem 0.5rem; display: flex; flex-direction: column; gap: 0.15rem; }
      .tot-row { display: flex; justify-content: space-between; gap: 1rem; font-size: var(--fs-sm); color: var(--text-muted); }
      .tot-row b { color: var(--text-main); font-variant-numeric: tabular-nums; text-align: right; }
      .tot-dto { color: var(--ok-soft-fg); }
      .tot-dto b { color: var(--ok-soft-fg); }
      .tot-final { font-size: var(--fs-body); font-weight: 700; color: var(--text-main); border-top: 1px solid var(--border-color); padding-top: 0.35rem; margin-top: 0.2rem; align-items: baseline; }
      .tot-final b { font-weight: 800; font-size: 1.3rem; color: var(--action); }
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


      .btn-export { font-weight: 600; }
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
  /** Hoy en la hora LOCAL: el ISO en UTC ya era mañana después de las 18:00 en México. */
  readonly hoy = new Date(new Date().setHours(0, 0, 0, 0));
  readonly modos: Array<{ label: string; value: 'mayoreo' | 'contacto' }> = [
    { label: 'Mayoreo ERP', value: 'mayoreo' },
    { label: 'Todavía no es cliente', value: 'contacto' },
  ];
  readonly incrementos = [5, 10, 25, 50, 100];
  readonly sucursales8: StoreBranch[] = SUCURSALES_8;

  // Estado del Destinatario
  modo = signal<'mayoreo' | 'contacto'>('mayoreo');
  terminoCliente = '';
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

  // Vendedor que da seguimiento a la cotización
  vendedores = signal<Array<{ code: string; name: string }>>([]);
  cargandoVendedores = signal(false);
  vendedorSeleccionado = signal<string | null>(null);
  /** El operador pidió elegir otro vendedor que el del cliente. */
  readonly cambiandoVendedor = signal(false);

  readonly vendedorSeleccionadoObj = computed(() => {
    const code = this.vendedorSeleccionado();
    if (!code) return null;
    return this.vendedores().find((v) => v.code === code) ?? null;
  });
  /** El vendedor del cliente en la sucursal (kdud.c12), si está en el padrón de vendedores de esa sucursal. */
  readonly vendedorCliente = computed(() => vendedorDelCliente(this.sucursalTerms()?.salesperson_code, this.vendedores()));
  /** El vendedor se muestra como DATO (no como pregunta) mientras sea el del cliente. */
  readonly vendedorFijo = computed(() => {
    const vc = this.vendedorCliente();
    return this.modo() === 'mayoreo' && vc && this.vendedorSeleccionado() === vc.code && !this.cambiandoVendedor() ? vc : null;
  });
  readonly opcionesVendedor = computed(() => this.vendedores().map((v) => ({ value: v.code, label: `${v.code} — ${v.name}` })));

  /**
   * [E.20] Señal, no campo plano: `puedeCrear` (un computed) lo lee, y un campo que sólo cambia
   * por `[(ngModel)]` no le avisa. Antes, en «Todavía no es cliente», teclear el nombre no
   * habilitaba «Crear» (auditoría A1; la compuerta `reactividad` ahora lo caza).
   */
  contactoNombre = signal('');
  contactoTel = '';
  contactoMail = '';
  origen: QuoteOrigin = 'telemarketing';
  vigencia: Date | null = new Date(Date.now() + 15 * 86400000);
  listaCruda = '';

  // ── Estado de Captura Manual de Artículos ───────────────────────────────────
  terminoArticulo = '';
  buscandoArticulo = signal(false);
  catalogoAbierto = signal(false);
  resultadosArticulos = signal<QuoteCatalogRow[]>([]);
  articuloElegido = signal<QuoteCatalogRow | null>(null);
  rung = signal<Rung>('base');
  cantidadArticulo = signal<number>(1);
  /** [E.20] La cantidad admite fracción sólo si el artículo se pesa y se cotiza en su unidad base. */
  readonly admiteFraccion = computed(() => !!this.articuloElegido()?.sold_by_kg && this.rung() === 'base');
  /** Unidades del artículo elegido, de MENOR a MAYOR (Pieza 1 · Paquete 10 · Caja 140). */
  readonly opcionesUnidadElegido = computed<OpcionUnidad[]>(() => {
    const e = this.articuloElegido();
    return e ? opcionesUnidad(e) : [];
  });
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
  /** [E.29] Existencia de la sucursal por SKU (unidad base). null = la consulta falló (no es «sin existencia»). */
  readonly existencias = signal<Map<string, number | null> | null>(new Map());
  readonly existenciaAl = signal<string | null>(null);
  readonly cargandoExistencia = signal(false);
  readonly existenciaError = signal(false);

  /**
   * [E.29] La bandeja como RENGLONES, igual que el detalle de una cotización guardada (misma tabla,
   * mismas columnas: existencia, lista, precio, de dónde sale e importe).
   */
  readonly renglonesBandeja = computed<RenglonTabla[]>(() => {
    const ex = this.existencias();
    const cargando = this.cargandoExistencia();
    return this.bandeja().map((it, i) => {
      const base = it.sku && ex ? ex.get(it.sku) : undefined;
      const existencia: RenglonTabla['existencia'] = !it.sku ? null
        : base === undefined ? (cargando ? 'cargando' : null)
        : base === null ? 'sin-dato'
        : { ...existenciaEnUnidad(base, it.factor, it.quantity), unidad: it.unit_label };
      return {
        id: it.id,
        numero: i + 1,
        nombre: it.sku ? it.name : it.requested_text || it.name,
        sinCasar: !it.sku,
        regaloDe: null,
        notaRegalo: it.free_goods ? `Regalo del ERP: ${it.free_goods.quantity} de ${it.free_goods.sku}` : null,
        unidad: it.sku ? it.unit_label : null,
        factor: it.factor && it.factor > 1 ? it.factor : null,
        cantidad: it.quantity,
        editable: true,
        admiteFraccion: esPesable(it),
        existencia,
        lista: it.list_price ?? null,
        precio: it.unit_price,
        desglose: this.desgloseDe(it),
        fuente: it.sku ? it.price_source : 'unknown',
        dtoPct: descuentoDerivado(it.list_price, it.unit_price),
        pasos: it.pasos ?? '',
        importe: it.sku ? it.line_total : null,
      };
    });
  });

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

  /** [E.19] La cuenta de la bandeja con la MISMA función que el papel y que el servidor. */
  readonly totalesBandeja = computed(() =>
    totalesCotizacion(
      this.bandeja().map((it) => (it.unit_price === null ? null : it.line_total || 0)),
      this.descuentoClientePct() || null,
      this.bandeja().map((it) => ({ iva: it.iva_rate ?? null, ieps: it.ieps_rate ?? null })),
    ),
  );

  readonly descuentoClienteMonto = computed(() => this.totalesBandeja().descuento);

  readonly totalBandeja = computed(() => this.totalesBandeja().total);

  /** Habilitación de guardado */
  readonly puedeCrear = computed(() => {
    if (this.guardando()) return false;
    if (!this.sucursal()) return false;
    if (this.modo() === 'contacto') {
      return this.contactoNombre().trim().length > 0;
    }
    return !!this.cliente();
  });

  readonly puedeAgregarArticulo = computed(() => {
    const p = this.previaArticulo();
    return !!this.articuloElegido() && !!p && p.unit_price !== null && this.cantidadArticulo() > 0;
  });

  ngOnInit(): void {
    // 1. Búsqueda reactiva de clientes. La espera entre teclas la pone p-autocomplete ([delay]);
    //    sin distinctUntilChanged: repetir el mismo término tiene que volver a traer la lista.
    this.busquedaCliente$
      .pipe(
        switchMap((t) => {
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
      });

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

  /** p-autocomplete pone en el modelo el texto tecleado o, al elegir, el cliente: sólo se guarda el texto. */
  onTerminoClienteModel(v: unknown): void {
    this.terminoCliente = typeof v === 'string' ? v : '';
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
    this.vendedorSeleccionado.set(null);
    this.cambiandoVendedor.set(false);
    this.resultadosClientes.set([]);
    this.terminoCliente = '';
  }

  clienteTieneSucursal(code: string): boolean {
    return !!this.cliente()?.branches.some((b) => b.sucursal === code);
  }

  onSucursalChange(val: string | null): void {
    const s = val || '';
    this.sucursal.set(s);
    this.cargarVendedores(s);
    this.revisarExistencia();
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
    // [E.29] Con cliente, el vendedor es EL DEL CLIENTE en esa sucursal o ninguno: antes, si el
    // cliente nuevo no traía vendedor, se quedaba el del cliente anterior.
    if (this.cliente()) {
      this.vendedorSeleccionado.set(this.vendedorCliente()?.code ?? null);
      this.cambiandoVendedor.set(false);
      return;
    }
    const sel = this.vendedorSeleccionado();
    if (sel && !this.vendedores().some((v) => v.code === sel)) this.vendedorSeleccionado.set(null);
  }

  onVendedorChange(val: string | null): void {
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
    // [E.20] Sin Math.floor en lo que se pesa: «aplicar volumen» con un mínimo de 2.5 kg dejaba 2,
    // abajo del umbral del precio por volumen.
    this.cantidadArticulo.set(this.admiteFraccion() ? Math.max(0.001, Math.round(val * 1000) / 1000) : Math.max(1, Math.floor(val)));
    this.previa$.next();
  }

  /** Cantidad tecleada en la franja. Vacío o no numérico = se conserva la anterior. */
  onCantidadTecleada(valor: string): void {
    // [E.20] Antes `replace(/\D/g,'')`: «2.5» kg se volvía 25 (se borraba el punto).
    const n = parseCantidad(valor, this.admiteFraccion());
    if (n === null) return;
    if (n === this.cantidadArticulo()) return;
    this.cantidadArticulo.set(n);
    this.previa$.next();
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
        iva_rate: prev!.iva_rate ?? null,
        ieps_rate: prev!.ieps_rate ?? null,
        price_source: prev!.price_source,
        free_goods: prev!.free_goods ? { sku: prev!.free_goods.sku, quantity: prev!.free_goods.quantity } : null,
        list_price: prev!.list_price ?? null,
        pasos: this.pasosDe(prev!),
      };
      this.bandeja.update((items) => [...items, item]);
      this.revisarExistencia();
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
      list_price: null,
      pasos: '',
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

  /** Cantidad tecleada en la tabla de renglones ("mejor que sean 12"), al confirmar. */
  onCantidadBandeja(e: CambioCantidad): void {
    const item = this.bandeja().find((it) => it.id === e.id);
    if (!item) return;
    // [E.20] Fracción sólo si el renglón se pesa (KG en su unidad base); «2.5» ya no es 25.
    const n = parseCantidad(e.valor, esPesable(item));
    if (n === null) {
      // Lo que no se entiende no se cambia: el campo vuelve a la cantidad que sí tiene el renglón.
      e.input.value = String(item.quantity);
      return;
    }
    this.cambiarCantidadBandeja(item.id, n);
  }

  /** `[E.29]` Los pasos del precio como los escribe el detalle: «lista $26.94 → volumen $24.79». */
  private pasosDe(p: PricedLine): string {
    return pasosDelPrecio(p.applied, (n) => this.dinero(n));
  }

  /**
   * `[E.29]` La existencia de la sucursal para los SKUs de la bandeja, ANTES de guardar: la misma
   * lectura que el detalle (`/stock` comparte la consulta con `:id/check`). Se pide al agregar un
   * artículo y al cambiar de sucursal; lo que falta se recalcula solo con la cantidad.
   */
  revisarExistencia(): void {
    const suc = this.sucursal();
    const skus = [...new Set(this.bandeja().map((it) => it.sku).filter(Boolean))];
    if (!suc || !skus.length) {
      this.existencias.set(new Map());
      return;
    }
    this.cargandoExistencia.set(true);
    this.existenciaError.set(false);
    this.svc.stock(suc, skus).subscribe({
      next: (r) => {
        this.existencias.set(new Map(r.items.map((x) => [x.sku, x.base_qty])));
        this.existenciaAl.set(r.stock_as_of);
        this.cargandoExistencia.set(false);
      },
      error: () => {
        // Error ≠ «sin existencia»: los renglones no pintan nada y la cabecera lo dice.
        this.existencias.set(null);
        this.existenciaError.set(true);
        this.cargandoExistencia.set(false);
      },
    });
  }

  /**
   * Cambia la cantidad de un renglón y lo vuelve a preciar (el volumen puede cambiar el precio).
   * La cantidad se aplica AL MOMENTO; la respuesta del precio sólo se aplica si el renglón
   * sigue con esa cantidad — si llegan fuera de orden, la de un clic anterior no pisa la última.
   */
  private cambiarCantidadBandeja(id: string, cantidad: number): void {
    const item = this.bandeja().find((it) => it.id === id);
    // [E.20] El Math.floor también cortaba los kilos: 2.5 kg tecleados bien terminaban en 2.
    const nuevaQty = item && esPesable(item)
      ? Math.max(0.001, Math.round(cantidad * 1000) / 1000)
      : Math.max(1, Math.floor(cantidad));
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
                iva_rate: p.iva_rate ?? null,
                ieps_rate: p.ieps_rate ?? null,
                price_source: p.price_source,
                free_goods: p.free_goods ? { sku: p.free_goods.sku, quantity: p.free_goods.quantity } : null,
                list_price: p.list_price ?? null,
                pasos: this.pasosDe(p),
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
  crear(descargar?: 'pdf' | 'xlsx'): void {
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
            detail: 'Por favor busca y selecciona un cliente de Kepler o cambia a la pestaña "Todavía no es cliente".',
          });
          return;
        }
      }
    } else {
      if (!this.contactoNombre().trim()) {
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
      valid_until: this.vigencia ? isoLocalDate(this.vigencia) : undefined,
      customer_request: this.listaCruda.trim() || undefined,
      source_branch: this.sucursal(),
      salesperson_code: this.vendedorSeleccionado() || undefined,
      salesperson_name: this.vendedorSeleccionadoObj()?.name || undefined,
    };
    if (esMayoreo) {
      payload.erp_customer_code = this.cliente()!.customer_code;
    } else {
      payload.contact_name = this.contactoNombre().trim();
      payload.contact_phone = this.contactoTel.trim() || undefined;
      payload.contact_email = this.contactoMail.trim() || undefined;
    }

    // [E.21] Cabecera y renglones en UNA llamada y una transacción. Antes se creaba la cabecera y
    // los renglones iban de a uno: si fallaba el k-ésimo quedaba un folio a medias, el aviso decía
    // «No se pudo crear» y el reintento creaba OTRO folio (auditoría C3). Ahora, si algo falla, no
    // se crea nada: la bandeja queda intacta y reintentar es seguro.
    payload.lines = this.bandeja().map((item) =>
      item.sku
        ? { sku: item.sku, quantity: item.quantity, rung: item.rung }
        : // Renglón NO manejado: viaja como demanda (requested_text), sin SKU ni precio.
          { requested_text: item.requested_text || item.name, quantity: item.quantity },
    );
    this.svc
      .create(payload)
      .subscribe({
        next: (quote) => {
          const linesAdded = quote.lines ?? 0;
          this.guardando.set(false);
          this.toast.add({
            severity: 'success',
            summary: `Cotización ${quote.code} generada`,
            detail:
              linesAdded > 0
                ? `Folio asignado exitosamente con ${linesAdded} renglón(es) de la bandeja en estatus Borrador.`
                : `Folio asignado en borrador (abierta), vigente hasta ${quote.valid_until}.`,
          });
          // [E.21] Al detalle de lo GUARDADO, con los precios que puso el servidor (antes iba a la
          // lista y nadie veía si diferían de los de la bandeja).
          this.router.navigate(['/telemarketing/cotizaciones', quote.id], descargar ? { queryParams: { descargar } } : {});
        },
        error: (err) => {
          this.guardando.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'No se creó la cotización',
            // El servidor dice qué renglón falló; la bandeja sigue intacta y no quedó ningún folio.
            detail: (err?.error?.message || err?.message || 'Error de red.')
              + ' La bandeja sigue aquí: puedes corregir y volver a intentar.',
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

}

