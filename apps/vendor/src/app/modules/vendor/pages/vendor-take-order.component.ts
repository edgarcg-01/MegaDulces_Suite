import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  DOCUMENT
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, ReplaySubject, forkJoin, from, of, switchMap, catchError, map } from 'rxjs';
import type { OfflinePedidoLine } from '../../../core/services/offline-database.service';
import { VendorService, VendorCustomer, VendorOrder, FrequentProduct, type CatalogoAlAbrir } from '../vendor.service';
import { type OrigenCatalogo, edadCatalogo, hayQueRefrescar } from '../catalogo-al-abrir';
import type { VendorZoneStockResponse } from '@megadulces/contracts';
import { type ChipZona, chipsDeZona, edadZona } from '../zona-existencias';
import { PriceRow, OrderLine } from '../../portal/portal.service';
import { HapticService } from '../../../core/services/haptic.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { fechaEntregaPorOmision, todayIso } from '../../../core/date/biz-days';
import {
  Presentacion,
  ajustarARejilla,
  bajarEscalon,
  conteoExacto,
  escalera,
  factorDe,
  rotuloCrudo,
  subirEscalon,
  contenidoCaja,
  type ContenidoCaja,
  // `[COT.1b]` Se mudó a `libs/ui-web` (con su spec) para que la pantalla de cotizaciones
  // pueda usar la MISMA aritmética: una app Nx no importa de otra app. Acá no cambia nada
  // de comportamiento — es la misma función, en una casa donde dos apps la alcanzan.
} from '@megadulces/ui-web';

/** Normaliza para búsqueda tipo Google: minúsculas + sin acentos/diacríticos. */
const foldText = (s: string | null | undefined): string =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Tomar pedido (rediseño Mercado mobile-first). Catálogo con "+" 44px, carrito con
 * steppers, y cart pill flotante en la zona del pulgar como CTA único.
 *
 * **Es preventa y solo preventa**: el pedido se agenda con fecha de entrega y se
 * surte al repartir, desde la sucursal del vendedor. Nunca consume stock acá
 * (`place()` no reserva cuando hay `requested_delivery_date`).
 *
 * Hasta acá vivía un segundo modo, `instante` (autoventa: "Cobrar y entregar" →
 * `deliverNow`, que sí consume). Estaba documentado y tipado pero **muerto**: la
 * señal nunca se seteaba, el encabezado decía "Preventa" fijo, el único CTA era
 * Agendar y `deliverNow` no se llamaba desde ninguna parte. Se retiró en vez de
 * dejarlo: vender del camión es la Fase VR, que no tiene código y va a necesitar su
 * propio contrato (folio local, conciliación de carga, arqueo), no esta rama.
 */
@Component({
  selector: 'app-vendor-take-order',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    SkeletonModule,
    InputTextModule,
    ConfirmDialogModule,
  ],
  // [MCP.3.5] SIN MessageService propio: esta pantalla no tiene <p-toast>, así que una
  // instancia local se tragaba TODOS sus avisos (el error de agregar incluido) y el vendedor
  // veía la cantidad volver a 0 sin explicación. Cuelga del shell /vendor, que sí pinta el
  // toast: inyectando el suyo, los avisos llegan.
  providers: [ConfirmationService],
  template: `
    <p-confirmdialog></p-confirmdialog>
    
    <!-- Header sticky -->
    @if (customer(); as c) {
      <header class="to-head">
        <button class="bk" (click)="back()" aria-label="Volver"><i class="pi pi-arrow-left"></i></button>
        <span class="av">{{ initials(c.name) }}</span>
        <div class="ci">
          <div class="nm">{{ c.name }}</div>
          <div class="cd">{{ c.code }}</div>
        </div>
        <span class="mode fut"><i class="pi pi-calendar"></i> Preventa</span>
        <button class="more" (click)="actionsOpen.set(true)" aria-label="Más acciones"><i class="pi pi-ellipsis-v"></i></button>
      </header>
    }
    
    @if (loading()) {
      <p-skeleton height="500px" styleClass="mt"></p-skeleton>
    }

    <!-- Estado de error: nunca dejar el cuerpo en blanco si la carga falló. -->
    @if (!loading() && !customer()) {
      <div class="load-err">
        <i class="pi pi-cloud"></i>
        <p>No se pudo cargar el pedido de este cliente.</p>
        <span class="le-sub">Puede ser un permiso o la conexión. Vuelve a intentar.</span>
        <button class="le-retry" (click)="reload()"><i class="pi pi-refresh"></i> Reintentar</button>
        <button class="le-back" (click)="back()">Volver</button>
      </div>
    }

    @if (!loading() && customer()) {
      <div class="scroll">
        <!-- Modo offline: el pedido se arma local y se sincroniza al reconectar -->
        @if (offlineMode()) {
          <div class="offline-banner">
            <i class="pi pi-cloud-upload"></i>
            <div class="ob-body">
              <b>Sin conexión</b>
              <span>El pedido se guarda y se envía solo al recuperar señal. El total puede ajustarse con promos al sincronizar.</span>
            </div>
          </div>
        }
        <!-- [VTK.6] Diseño A: avisos y ajustes del pedido en UNA tira de una línea (antes eran 4
             bloques y en un celular chico el primer producto quedaba a media pantalla). -->
        <div class="chipbar" role="toolbar" aria-label="Avisos y ajustes del pedido">
          <!-- El cliente ya tiene un pedido pendiente (preventa/portal o de campo) -->
          @if (!pendingDismissed() && pendingOrders().length > 0) {
            <span class="chip warn">
              <button type="button" class="chip-main" (click)="goPending()"
                [attr.aria-label]="'Ver ' + pendingOrders().length + ' pendiente' + (pendingOrders().length === 1 ? '' : 's')">
                <i class="pi pi-exclamation-triangle"></i>
                {{ pendingOrders().length === 1 ? (hasPreventa() ? 'Preventa' : 'Pendiente') : pendingOrders().length + ' pendientes' }}
                {{ fmtMoney(pendingTotal()) }} · Ver
              </button>
              <button type="button" class="chip-x" (click)="pendingDismissed.set(true)" aria-label="Ocultar aviso de pendiente">
                <i class="pi pi-times"></i>
              </button>
            </span>
          }
          <!-- Oferta de pedido sugerido (opt-in: no se arma solo) -->
          @if (showPrefillOffer()) {
            <span class="chip sug">
              <button type="button" class="chip-main" (click)="usePrefill()">
                <i class="pi pi-bolt"></i> Sugerido ({{ predictedLines().length }}) · Cargar
              </button>
              <button type="button" class="chip-x" (click)="prefillDismissed.set(true)" aria-label="No cargar el sugerido">
                <i class="pi pi-times"></i>
              </button>
            </span>
          }
          <!-- Fecha de entrega (preventa) -->
          <label class="chip date">
            <i class="pi pi-calendar"></i> Entrega
            <input type="date" [(ngModel)]="requestedDate" [min]="minDate" class="chip-date" aria-label="Fecha de entrega" />
          </label>
          <!-- Fuente de existencia: ver sucursal / ver camioneta -->
          @if (stockSources().sucursal && !offlineMode()) {
            <button type="button" class="chip" [class.on]="stockView() === 'sucursal'"
              [class.unassigned]="stockSources().sucursal?.assigned === false"
              (click)="switchStockView('sucursal')">
              @if (stockSources().sucursal?.assigned === false) {
                <i class="pi pi-exclamation-triangle"></i> Sin sucursal
              } @else {
                <i class="pi pi-box"></i> {{ stockSources().sucursal?.name }}
              }
            </button>
            @if (stockSources().camioneta; as cam) {
              <button type="button" class="chip" [class.on]="stockView() === 'camioneta'" (click)="switchStockView('camioneta')">
                <i class="pi pi-truck"></i> {{ cam.name }}
              </button>
            }
            @if (stockLoading()) { <i class="pi pi-spin pi-spinner ss-spin"></i> }
          }
        </div>
        <!-- Pedido sugerido pre-cargado -->
        @if (prefilling()) {
          <div class="prefill-note loading">
            <i class="pi pi-spin pi-spinner"></i> Armando pedido sugerido…
          </div>
        }
        @if (prefilled() && !prefilling() && cartLines().length) {
          <div class="prefill-note">
            <i class="pi pi-bolt"></i>
            <div class="pn-body">
              <b>Pedido sugerido cargado</b>
              <span>Según lo que suele pedir. Ajusta cantidades y confirma.</span>
            </div>
            <button (click)="clearOrder()">Vaciar</button>
          </div>
        }
        <!-- Corrigiendo un pedido que ya estaba agendado: el folio es el mismo y
             hay que volver a guardarlo, no queda guardado solo. -->
        @if (isEditing()) {
          <div class="edit-banner">
            <i class="pi pi-pencil"></i>
            <span>Estás corrigiendo <b>{{ editingCode() || 'un pedido agendado' }}</b>. Guarda al terminar para volver a agendarlo.</span>
          </div>
        }
        <!-- Search. [VTK.6] Fijo arriba al desplazarse. -->
        <div class="search sticky">
          <i class="pi pi-search"></i>
          <input pInputText type="search" placeholder="Buscar producto o código"
            [ngModel]="searchTerm()" (ngModelChange)="searchTerm.set($event)"
            inputmode="search" enterkeyhint="search"
            autocapitalize="none" autocorrect="off" spellcheck="false" />
          </div>
          <!-- Avisos de la fuente de existencia (el selector vive en la tira de arriba, [VTK.6]) -->
          @if (stockSources().sucursal && !offlineMode()) {
            @if (stockSources().sucursal?.assigned === false) {
              <p class="ss-warn"><i class="pi pi-info-circle"></i> No tienes sucursal de surtido asignada — se muestra el almacén general. Pedile a tu supervisor que te asigne tu ruta.</p>
            }
            <!-- Mirar la camioneta es consulta, no surtido: el pedido es preventa y se
                 reparte desde la sucursal. Si no se dice, el vendedor cree que está
                 pidiendo de lo que trae hoy. -->
            @if (stockView() === 'camioneta') {
              <p class="ss-note"><i class="pi pi-info-circle"></i> Estás viendo lo que traes en la camioneta. El pedido se surte igual desde {{ stockSources().sucursal?.name || 'tu sucursal' }} al repartir.</p>
            }
          }
          <!-- [VTK.11] Se abrió con el catálogo guardado: se dice de cuándo es mientras llega el nuevo. -->
          @if (catalogoAviso(); as av) {
            <p class="cat-age" [class.warn]="av.fallo" role="status"><i class="pi pi-clock" aria-hidden="true"></i> {{ av.texto }}</p>
          }
          <!-- [MCP.3.12] De cuándo es la existencia de las otras sucursales, o por qué no se ve. -->
          @if (zonaAviso(); as za) {
            <p class="cat-age" [class.warn]="za.fallo" role="status"><i class="pi pi-building" aria-hidden="true"></i> {{ za.texto }}</p>
          }
          <!-- Order pad: con búsqueda → resultados; sin búsqueda → Habituales + Catálogo -->
          @if (searchTerm().trim()) {
            <div class="list-head">
              <span class="lh-t">{{ displayed().length }}{{ searchCapped() ? '+' : '' }} resultado{{ displayed().length === 1 ? '' : 's' }}</span>
              <span class="lh-s">de {{ pricedCount() }} productos</span>
            </div>
            <div class="catalog">
              @if (displayed().length === 0) {
                <div class="no-res">
                  <i class="pi pi-search"></i>
                  <p>Sin resultados para "{{ searchTerm() }}".</p>
                </div>
              }
              @for (p of displayed(); track trackProduct($index, p)) {
                <ng-container *ngTemplateOutlet="prodRow; context: { $implicit: p, box: true }"></ng-container>
              }
            </div>
          } @else {
            <!-- Lo que suele pedir (habituales del cliente + lo ya agregado) -->
            @if (habitualRows().length) {
              <div class="list-head">
                <span class="lh-t"><i class="pi pi-history"></i> Lo que suele pedir</span>
                <span class="lh-s">{{ habitualRows().length }} · escribe cantidades</span>
              </div>
              <div class="catalog">
                @for (p of habitualRows(); track trackProduct($index, p)) {
                  <ng-container *ngTemplateOutlet="prodRow; context: { $implicit: p }"></ng-container>
                }
              </div>
            }
            <!-- Catálogo navegable: más vendido → menos vendido (sin tener que buscar) -->
            @if (browseRows().length) {
              <div class="list-head">
                <span class="lh-t"><i class="pi pi-chart-bar"></i> Catálogo · más vendidos</span>
                <span class="lh-s">busca para ver los {{ pricedCount() }}</span>
              </div>
              <div class="catalog">
                @for (p of browseRows(); track trackProduct($index, p)) {
                  <ng-container *ngTemplateOutlet="prodRow; context: { $implicit: p }"></ng-container>
                }
              </div>
            }
            @if (!habitualRows().length && !browseRows().length) {
              <div class="no-res">
                <i class="pi pi-search"></i>
                <p>Busca un producto para empezar el pedido.</p>
              </div>
            }
            @if (unpricedCount() > 0) {
              <p class="unpriced-note">
                <i class="pi pi-info-circle"></i>
                {{ unpricedCount() }} productos existen pero sin precio — avisar a oficina para cargarlos.
              </p>
            }
          }
          <!-- Fila de producto (reusada en búsqueda / habituales / catálogo) -->
          <ng-template #prodRow let-p let-box="box">
            <!-- [VTK.6] Fila compacta: sin el ícono de caja (le gana ancho al nombre) y las
                 unidades en el mismo renglón que el precio. -->
            <div class="prod" [class.in]="cartQty(p.product_id) > 0">
              <div class="pb">
                <div class="pn">{{ p.product_name }}</div>
                <div class="pm">
                  <span class="pr" [class.off]="mayoreoAplicado(p.product_id)">{{ fmtMoney(unitPriceDisplay(p)) }}<span class="pr-u">&nbsp;c/u</span></span>
                  <!-- Selector de medida (de menor a mayor): solo si el SKU ofrece más de una. -->
                  @if (hasUnitChoice(p)) {
                    <span class="unit-sel" role="group" aria-label="Unidad">
                      @for (u of unitsOf(p); track u.unit) {
                        <button type="button" class="us-chip" [class.on]="selectedUnit(p)?.unit === u.unit"
                          [attr.aria-pressed]="selectedUnit(p)?.unit === u.unit"
                          (click)="setUnit(p, u.unit); $event.stopPropagation()">{{ u.unit }}</button>
                      }
                    </span>
                  }
                  @if (p.min_qty > 1) {
                    <span>· min {{ p.min_qty }}</span>
                  }
                  @if (p.stock_available != null) {
                    <span class="stk" [ngClass]="stockClass(p)">{{ stockLabel(p) }}</span>
                  }
                </div>
                <!-- [MCP.3.12] Existencias de las sucursales de la zona, en chico. Sólo se ven: elegir
                     de cuál se surte es la parte 2. -->
                @if (zonaDe(p); as zs) {
                  <!-- [MCP.3.13] Tocar una sucursal = de ahí se surte ESTE producto (se cobra allá). -->
                  <div class="zs" role="radiogroup" [attr.aria-label]="'De qué sucursal se surte ' + p.product_name">
                    <i class="pi pi-building" aria-hidden="true"></i>
                    @for (c of zs; track c.id) {
                      <button type="button" class="zs-c" role="radio" [class.mine]="c.mine" [class.on]="origenEs(p, c)"
                        [class.cero]="c.qty === 0" [class.nd]="c.qty == null" [attr.aria-checked]="origenEs(p, c)"
                        [attr.aria-label]="ariaChip(c, p)" [disabled]="cambiandoOrigen() === p.product_id"
                        (click)="elegirOrigen(p, c); $event.stopPropagation()">{{ c.short }}&nbsp;<b>{{ c.texto }}</b></button>
                    }
                    @if (selectedUnit(p)?.unit; as u) { <span class="zs-u" aria-hidden="true">{{ u }}</span> }
                  </div>
                  @if (avisoOrigen(p); as av) { <div class="zs-warn" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ av }}</div> }
                }
                <!-- [VTK.9] Al buscar: cuánto trae la caja, sin abrir la ficha ni hacer la cuenta. -->
                @if (box && contenidoCajaById().get(p.product_id); as bc) {
                  <div class="box-c">
                    <i class="pi pi-box" aria-hidden="true"></i>
                    <span>1 {{ bc.caja }} trae
                      @for (pt of bc.partes; track pt.unit; let last = $last) {
                        <b>{{ pt.qty }}</b>&nbsp;{{ pt.unit }}@if (!last) {<span class="sep"> · </span>}
                      }
                    </span>
                  </div>
                }
                <!-- [VTK.12] Con la caja elegida en el selector: cuántas piezas trae. En la búsqueda
                     ya lo dice la línea de arriba, así que ahí no se repite. -->
                @if (!(box && contenidoCajaById().get(p.product_id)) && cajaElegida(p); as ce) {
                  <div class="box-sel">
                    <i class="pi pi-box" aria-hidden="true"></i>
                    <span>1 {{ ce.caja }} = <b>{{ ce.piezas }}</b>&nbsp;{{ ce.base }}@if (ce.enPedido) {<span class="sep"> · en el pedido <b>{{ ce.enPedido }}</b>&nbsp;{{ ce.base }}</span>}</span>
                  </div>
                }
                <!-- [MCP.3.6] Los DOS precios siempre a la vista (pedido de David, 2026-10-21):
                     el normal arriba y el de mayoreo aquí, en su propio renglón para no empujar
                     los botones de unidad. Se resalta cuando el SERVIDOR ya lo cobra en el
                     renglón; el celular no lo calcula. Sin mayoreo real, no se pinta. -->
                @if (mayoreoDe(p); as my) {
                  <div class="may" [class.on]="mayoreoAplicado(p.product_id)">
                    @if (mayoreoAplicado(p.product_id)) {
                      <i class="pi pi-check-circle" aria-hidden="true"></i>
                    }
                    <span>Mayoreo ({{ my.from }}+): <b>{{ fmtMoney(my.unit) }}</b>&nbsp;c/u</span>
                    @if (mayoreoAplicado(p.product_id)) {
                      <span class="may-st">· aplicado</span>
                    }
                  </div>
                }
                <!-- Si crear el renglón falló, se dice aquí mismo, pegado a la fila: un toast se
                     va solo y la cantidad ya volvió a 0, así que sin esto no quedaba rastro. -->
                @if (rowError()[p.product_id]; as re) {
                  <div class="row-err" role="alert">
                    <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                    <span>{{ re }}</span>
                  </div>
                }
              </div>
              <div class="row-stepper" [class.empty]="cartQty(p.product_id) === 0">
                <div class="rs-row">
                  <button (click)="decProduct(p)" [disabled]="cartQty(p.product_id) === 0" aria-label="Menos">−</button>
                  <input class="qin" type="number" inputmode="numeric" min="0" step="1"
                    [ngModel]="dispCount(p) || null"
                    (change)="setQtyTyped(p, $any($event.target).value)"
                    (keydown.enter)="$any($event.target).blur()"
                    (focus)="$any($event.target).select()"
                    placeholder="0" [attr.aria-label]="'Cantidad en ' + (rowUnitLabel(p) || 'unidades')" />
                  <!-- [VTK.5] No se bloquea mientras se crea el renglón: los toques se acumulan. -->
                  <button (click)="incProduct(p)" aria-label="Más">+</button>
                </div>
                <!-- En qué se está contando esta fila. Fuera de rejilla cae a unidad base
                     y se dice, en vez de redondear a una presentación que no es. -->
                @if (rowUnitLabel(p)) {
                  <span class="rs-u" [class.warn]="offGrid(p)">{{ rowUnitLabel(p) }}</span>
                }
              </div>
              </div>
            </ng-template>
            @if (cartLines().length === 0) {
              <div class="empty-cart">
                <i class="pi pi-shopping-cart"></i>
                <p>Toca <b>+</b> en un producto para empezar el pedido.</p>
              </div>
            }
          </div>
          <!-- Barra de carrito (zona del pulgar): abrir pedido | cobrar -->
          @if (cartLines().length > 0) {
            <div class="cartbar">
              <button class="cb-open" (click)="cartOpen.set(true)" aria-label="Ver pedido">
                <span class="cb-count">{{ cartLines().length }}</span>
                <span class="cb-info">
                  <!-- El dinero lo calcula el servidor (tiers + promos): mientras hay
                       ajustes sin volcar, el total que tenemos es el de ANTES del
                       ajuste. Se dice, en vez de publicar una cifra vieja como firme. -->
                  <b [class.stale]="totalPendiente()">{{ fmtMoney(cartTotal()) }}</b>
                  <span>
                    @if (totalPendiente()) { actualizando total… } @else { {{ cartUnitsTotal() }} u · {{ cartLines().length }} SKU · ver pedido }
                  </span>
                </span>
                <i class="pi pi-chevron-up"></i>
              </button>
              <button class="cb-go" [disabled]="submitting() || settling()" (click)="submit()">
                {{ settling() ? 'Calculando…' : (isEditing() ? 'Guardar' : 'Agendar') }}
                <i class="pi" [ngClass]="(submitting() || settling()) ? 'pi-spin pi-spinner' : 'pi-arrow-right'"></i>
              </button>
            </div>
          }
          <!-- Sheet de pedido: lo seleccionado, con cantidades editables -->
          @if (cartOpen()) {
            <div class="sheet-backdrop" (click)="cartOpen.set(false)"></div>
          }
          @if (cartOpen()) {
            <section class="cart-sheet" role="dialog" aria-modal="true" aria-labelledby="cart-sheet-title" tabindex="-1">
              <div class="sh-head">
                <div class="sh-title">
                  <h2 id="cart-sheet-title">Tu pedido</h2>
                  <span>{{ cartLines().length }} SKU · {{ cartUnitsTotal() }} u</span>
                </div>
                <button class="sh-x" (click)="cartOpen.set(false)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
              </div>
              <div class="sh-lines">
                @for (l of visibleCartLines(); track trackLine($index, l)) {
                  <div class="cline">
                    <div class="cl-info">
                      <div class="cl-n">{{ productNameById(l.product_id) }}</div>
                      <div class="cl-t">{{ fmtMoney(l.line_total) }}@if (l.source_warehouse_id) {<span class="cl-src"> · se surte en {{ l.source_warehouse_short || l.source_warehouse_name }}</span>}</div>
                      <!-- Mayoreo por cantidad: precio nuevo + cuánto se descuenta vs base. -->
                      @if (mayoreoInfo(l); as m) {
                        <div class="cl-may">
                          <span class="cl-may-tag"><i class="pi pi-tag"></i> Mayoreo</span>
                          <span class="cl-may-new">{{ fmtMoney(m.unit) }} c/u</span>
                          <span class="cl-may-base">antes {{ fmtMoney(m.base) }}</span>
                          <span class="cl-may-save">−{{ m.pct }}% · ahorra {{ fmtMoney(m.savedTotal) }}</span>
                        </div>
                      }
                    </div>
                    <div class="stepper">
                      <button (click)="dec(l)" aria-label="Menos">−</button>
                      <span class="q">{{ dispCountById(l.product_id) }}@if (unitLabelById(l.product_id); as u) {<small class="q-u">{{ u }}</small>}</span>
                      <button (click)="inc(l)" aria-label="Más">+</button>
                    </div>
                    <button class="rm" (click)="removeLine(l)" aria-label="Quitar"><i class="pi pi-trash"></i></button>
                  </div>
                }
              </div>
              <div class="sh-foot">
                @if (surteEn(); as se) {
                  <p class="se" role="note"><i class="pi pi-building" aria-hidden="true"></i> Se surte en
                    @for (g of se; track g.label) { <span class="se-g" [class.ajena]="g.ajena">{{ g.label }} ({{ g.n }})</span> }
                    · un pedido; cada sucursal cobra lo suyo
                  </p>
                }
                <div class="totals">
                  <div class="row"><span>Subtotal</span><b>{{ fmtMoney(cartSubtotal()) }}</b></div>
                  <div class="row"><span>IVA</span><b>{{ fmtMoney(cartTaxTotal()) }}</b></div>
                  @if (cartMarginPct() !== null) {
                    <div class="row mg-row"><span>Margen aprox.</span><b [class.neg]="cartMarginPct()! < 0">{{ cartMarginPct() }}%</b></div>
                  }
                  <div class="row total">
                    <span>Total@if (totalPendiente()) {<small class="t-stale">actualizando…</small>}</span>
                    <b [class.stale]="totalPendiente()">{{ fmtMoney(cartTotal()) }}</b>
                  </div>
                </div>
                <button class="sh-go" [disabled]="submitting() || settling()" (click)="submit()">
                  {{ settling() ? 'Calculando total…' : 'Agendar pedido' }}
                  <i class="pi" [ngClass]="(submitting() || settling()) ? 'pi-spin pi-spinner' : 'pi-arrow-right'"></i>
                </button>
                <button class="cancel" (click)="cancelDraft()"><i class="pi pi-trash"></i> Cancelar borrador</button>
              </div>
            </section>
          }
            <!-- Sheet de acciones de la visita (···) -->
            @if (actionsOpen()) {
              <div class="sheet-backdrop" (click)="actionsOpen.set(false)"></div>
            }
            @if (actionsOpen()) {
              <section class="act-sheet" role="dialog" aria-modal="true" aria-labelledby="act-sheet-title" tabindex="-1">
                <div class="sh-head">
                  <div class="sh-title"><h2 id="act-sheet-title">Acciones de la visita</h2></div>
                  <button class="sh-x" (click)="actionsOpen.set(false)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
                </div>
                <button class="act-row" (click)="goCaptureExhibit()">
                  <i class="pi pi-camera"></i><span class="lbl">Capturar exhibición <small>Foto del punto de venta</small></span><i class="pi pi-chevron-right ch"></i>
                </button>
                <button class="act-row danger" (click)="openFinish()">
                  <i class="pi pi-flag"></i><span class="lbl">Finalizar visita <small>Registrar el resultado</small></span><i class="pi pi-chevron-right ch"></i>
                </button>
              </section>
            }
            <!-- Sheet de resultado de visita (terminar) -->
            @if (finishOpen()) {
              <div class="sheet-backdrop" (click)="finishOpen.set(false)"></div>
            }
            @if (finishOpen()) {
              <section class="finish-sheet" role="dialog" aria-modal="true" aria-labelledby="finish-sheet-title" tabindex="-1">
                <div class="sh-head">
                  <div class="sh-title"><h2 id="finish-sheet-title">¿Cómo finalizó la visita?</h2></div>
                  <button class="sh-x" (click)="finishOpen.set(false)" aria-label="Cerrar"><i class="pi pi-times"></i></button>
                </div>
                <button class="fin-opt" [class.on]="finishOutcome() === 'venta'" (click)="finishOutcome.set('venta')">
                  <i class="pi pi-check-circle"></i>
                  <span class="lbl">Venta directa <small>Capturé o voy a capturar el ticket</small></span>
                </button>
                <button class="fin-opt" [class.on]="finishOutcome() === 'no_venta'" (click)="finishOutcome.set('no_venta')">
                  <i class="pi pi-times-circle"></i>
                  <span class="lbl">No compró <small>Elige el motivo</small></span>
                </button>
                @if (finishOutcome() === 'no_venta') {
                  <div class="reasons">
                    @for (r of noSaleReasons; track r) {
                      <button class="rsn-chip" [class.on]="noSaleReason() === r.key" (click)="noSaleReason.set(r.key)">
                        {{ r.label }}
                      </button>
                    }
                  </div>
                }
                <button class="sh-go" [disabled]="finishing() || !canFinish()" (click)="confirmFinish()">
                  <i class="pi" [ngClass]="finishing() ? 'pi-spin pi-spinner' : 'pi-flag'"></i>
                  Finalizar visita
                </button>
              </section>
            }
          }
    `,
  styles: [
    `
      :host { display: block; }
      .to-head {
        display: flex; align-items: center; gap: 0.7rem;
        margin: -1rem -1rem 0.75rem; padding: 0.7rem 1rem; background: var(--card-bg); border-bottom: 1px solid var(--border-color);
      }
      .to-head .bk { width: 2.25rem; height: 2.25rem; border-radius: 14px; border: none; background: var(--surface-ground); color: var(--text-main); display: grid; place-items: center; font-size: 1.05rem; flex-shrink: 0; }
      .to-head .av { width: 2.35rem; height: 2.35rem; border-radius: 14px; background: var(--brand-400); color: var(--text-main); display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
      .to-head .ci { flex: 1; min-width: 0; }
      .to-head .nm { font-weight: 700; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .to-head .cd { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); }
      .to-head .mode { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; font-weight: 700; color: var(--action); background: var(--ember-soft); border: 1px solid var(--ember-border); padding: 0.25rem 0.55rem; border-radius: var(--r-pill, 999px); flex-shrink: 0; }
      .to-head .mode.fut { color: var(--info-soft-fg); background: var(--info-soft-bg); border-color: var(--info-border); }
      .mt { margin-top: 1rem; }

      .scroll { padding-bottom: 6rem; }
      .load-err { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0.4rem; padding: 3rem 1.5rem; }
      .load-err > i { font-size: 2.25rem; color: var(--text-faint); margin-bottom: 0.3rem; }
      .load-err p { font-weight: 700; font-size: 0.95rem; color: var(--text-main); margin: 0; }
      .load-err .le-sub { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.6rem; }
      .load-err .le-retry { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.6rem 1.3rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 700; font-size: 0.9rem; }
      .load-err .le-back { border: none; background: none; color: var(--text-muted); font-weight: 600; font-size: 0.85rem; padding: 0.4rem; }
      .edit-banner { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--action); border-radius: var(--r-md, 0.5rem); background: var(--ember-soft); color: var(--brand-900); font-size: 0.82rem; line-height: 1.3; }
      .edit-banner i { flex-shrink: 0; }
      .date-row { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.875rem; }
      .date-row label { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); display: flex; align-items: center; gap: 0.4rem; }
      .date-input { width: 100%; height: 2.9rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0 0.875rem; font-family: var(--font-body); font-size: 0.95rem; background: var(--card-bg); color: var(--text-main); }

      .search { display: flex; align-items: center; gap: 0.6rem; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.1rem 0.95rem; margin-bottom: 0.875rem; }
      /* [VTK.6] Buscador fijo al desplazarse: con la lista larga se busca sin volver arriba. */
      .search.sticky { position: sticky; top: 0; z-index: 5; background: var(--card-bg); box-shadow: 0 2px 6px rgba(16,13,9,0.06); }

      /* [VTK.6] Tira de avisos y ajustes: una sola línea con desplazamiento horizontal. */
      .chipbar { display: flex; align-items: center; gap: 0.4rem; overflow-x: auto; margin: 0 -1rem 0.75rem; padding: 0 1rem 0.15rem; scrollbar-width: none; }
      .chipbar::-webkit-scrollbar { display: none; }
      .chipbar .chip { flex-shrink: 0; display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2.1rem; padding: 0 0.7rem; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); background: var(--card-bg); color: var(--text-main); font-family: var(--font-body); font-size: 0.76rem; font-weight: 700; white-space: nowrap; cursor: pointer; }
      .chipbar .chip i { font-size: 0.72rem; }
      .chipbar .chip.on { border-color: var(--action); background: var(--ember-soft); color: var(--brand-900); }
      .chipbar .chip.unassigned { color: var(--warn-fg); border-color: var(--warn-fg); }
      .chipbar .chip.warn, .chipbar .chip.sug { padding: 0; gap: 0; overflow: hidden; }
      .chipbar .chip.warn { background: var(--warn-soft-bg); border-color: var(--warn-fg); }
      .chipbar .chip.sug { background: var(--ember-soft); border-color: var(--ember-border); }
      .chipbar .chip-main { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2.1rem; padding: 0 0.6rem 0 0.7rem; border: none; background: none; color: inherit; font: inherit; cursor: pointer; }
      .chipbar .chip.warn .chip-main i { color: var(--warn-fg); }
      .chipbar .chip.sug .chip-main { color: var(--brand-900); }
      .chipbar .chip.sug .chip-main i { color: var(--action); }
      .chipbar .chip-x { width: 2rem; min-height: 2.1rem; border: none; border-left: 1px solid var(--border-color); background: none; color: var(--text-muted); cursor: pointer; display: grid; place-items: center; }
      .chipbar .chip.date { cursor: default; }
      .chipbar .chip-date { border: none; background: none; color: var(--text-main); font-family: var(--font-mono); font-size: 0.76rem; font-weight: 700; padding: 0; min-height: 2rem; }
      .chipbar .chip:focus-visible, .chipbar .chip-main:focus-visible, .chipbar .chip-x:focus-visible, .chipbar .chip-date:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
      .search i { color: var(--text-muted); }
      .search input { flex: 1; border: none; background: none; outline: none; height: 2.7rem; font-family: var(--font-body); font-size: 0.95rem; color: var(--text-main); }
      .search input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }

      .prefill-note { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.875rem; padding: 0.6rem 0.8rem; border-radius: var(--r-md, 12px); background: var(--ember-soft); border: 1px solid var(--ember-border); }
      .prefill-note > i { color: var(--action); font-size: 1rem; flex-shrink: 0; }
      .prefill-note .pn-body { flex: 1; min-width: 0; }
      .prefill-note .pn-body b { display: block; font-size: 0.86rem; color: var(--text-main); }
      .prefill-note .pn-body span { font-size: 0.76rem; color: var(--text-muted); }
      .prefill-note button { flex-shrink: 0; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill, 999px); font-weight: 700; font-size: 0.78rem; padding: 0.35rem 0.8rem; }
      .prefill-note.loading { color: var(--text-muted); font-size: 0.88rem; }
      .prefill-note .pn-actions { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
      .prefill-note .pn-actions button { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill, 999px); font-weight: 700; font-size: 0.78rem; padding: 0.4rem 0.85rem; }
      .prefill-note .pn-actions .pn-yes { border-color: var(--action); background: var(--action); color: #fff; }

      .list-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; }
      .list-head .lh-t { font-weight: 800; font-size: 0.95rem; color: var(--text-main); display: inline-flex; align-items: center; gap: 0.35rem; }
      .list-head .lh-t i { color: var(--action); font-size: 0.85rem; }
      .list-head .lh-s { font-size: 0.72rem; color: var(--text-muted); text-align: right; }
      .no-res { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .no-res i { font-size: 1.75rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }
      .unpriced-note { display: flex; align-items: center; gap: 0.45rem; margin: 0.9rem 0 0.2rem; padding: 0.55rem 0.7rem; border-radius: var(--r-md, 10px); background: var(--surface-ground, transparent); color: var(--text-muted); font-size: 0.78rem; line-height: 1.35; }
      .unpriced-note i { color: var(--text-faint); flex-shrink: 0; }

      /* [VTK.6] Fila compacta: menos aire entre filas y por dentro. */
      .catalog { display: flex; flex-direction: column; gap: 0.35rem; }
      .prod { display: flex; align-items: center; gap: 0.6rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 0.45rem 0.6rem; }
      .prod .ph { width: 2.5rem; height: 2.5rem; border-radius: 14px; background: var(--neutral-100); display: grid; place-items: center; color: var(--neutral-400); font-size: 1.05rem; flex-shrink: 0; }
      .prod .pb { flex: 1; min-width: 0; }
      .prod .pn { font-weight: 600; font-size: 0.9rem; color: var(--text-main); line-height: 1.2; }
      .prod .pm { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
      .prod .pm .pr { font-family: var(--font-mono); font-weight: 700; color: var(--action); font-variant-numeric: tabular-nums; }
      .prod .pm .stk { font-weight: 600; }
      /* [MCP.3.6] Precio normal + mayoreo. El aplicado se dice con icono y texto, no sólo color. */
      .prod .pm .pr.off { color: var(--text-muted); }
      .prod .may { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.15rem; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .prod .may b { font-family: var(--font-mono); font-weight: 700; color: var(--text-main); }
      .prod .may.on { color: var(--ok-fg); font-weight: 700; }
      .prod .may.on b { color: var(--ok-fg); }
      .prod .may i { font-size: var(--fs-xs); }
      .prod .pm .stk.ok { color: var(--ok-fg); } .prod .pm .stk.warn { color: var(--warn-fg); } .prod .pm .stk.bad { color: var(--bad-fg); }
      /* [MCP.3.5] El renglón que no se pudo crear: el motivo queda pegado a la fila. */
      .prod .row-err { display: flex; align-items: flex-start; gap: 0.3rem; margin-top: 0.25rem; font-size: 0.76rem; line-height: 1.35; font-weight: 600; color: var(--bad-fg); }
      .prod .row-err i { font-size: 0.72rem; margin-top: 0.1rem; flex-shrink: 0; }
      /* [VTK.9] Contenido de la caja en los resultados de búsqueda. */
      .prod .box-c { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.2rem; font-size: 0.76rem; color: var(--text-muted); }
      .prod .box-c i { font-size: 0.7rem; }
      /* [MCP.3.12] Tira de existencias de la zona: discreta pero legible (0.72rem, sin color de acción). */
      .prod .zs { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; margin: 0.25rem 0 0; font-size: 0.72rem; color: var(--text-muted); }
      .prod .zs > i { font-size: 0.66rem; }
      .prod .zs-c { display: inline-flex; align-items: baseline; padding: 0.05rem 0.4rem; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); background: var(--surface-ground); color: var(--text-main); font-weight: 600; white-space: nowrap; }
      .prod .zs-c b { font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; }
      .prod .zs-c.mine { border-color: var(--text-muted); }
      .prod .zs-c.cero, .prod .zs-c.nd { color: var(--text-muted); border-style: dashed; font-weight: 500; }
      .prod .zs-u { font-size: 0.68rem; }
      /* [MCP.3.13] La tira es elegible: botones discretos, la elegida con el color de acción. */
      .prod button.zs-c { min-height: 1.9rem; cursor: pointer; font-family: inherit; font-size: 0.72rem; }
      .prod button.zs-c.on { border-color: var(--action); border-style: solid; background: var(--overlay-selected); color: var(--text-main); font-weight: 700; }
      .prod button.zs-c:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
      .prod button.zs-c:disabled { opacity: 0.6; cursor: progress; }
      .prod .zs-warn { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.2rem; font-size: 0.72rem; font-weight: 600; color: var(--warn-fg); }
      .cl-src { color: var(--text-muted); font-weight: 600; }
      .se { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; margin: 0 0 0.5rem; font-size: 0.76rem; color: var(--text-muted); }
      .se-g { padding: 0.05rem 0.45rem; border-radius: var(--r-pill, 999px); background: var(--surface-ground); color: var(--text-main); font-weight: 700; }
      .se-g.ajena { border: 1px solid var(--action); }
      .prod .box-c b { font-family: var(--font-mono); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
      /* [VTK.12] Caja elegida en el selector. */
      .prod .box-sel { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.2rem; font-size: 0.76rem; color: var(--text-main); }
      .prod .box-sel i { font-size: 0.7rem; color: var(--action); }
      .prod .box-sel b { font-family: var(--font-mono); font-weight: 700; color: var(--action); font-variant-numeric: tabular-nums; }
      .prod .box-sel .sep { color: var(--text-muted); }
      /* Selector de medida (PZA/PAQ/CJA) por línea. */
      .prod .pr .pr-u { font-size: 0.72rem; font-weight: 600; color: var(--text-muted); margin-left: 0.1rem; }
      /* [MCP.3.5] Botones de unidad a la medida del pulgar: 44px de alto aunque el puntero sea
         fino (la app es de celular, pero también se abre en la laptop de oficina), texto del
         cuerpo y aire entre ellos para no pegarle al vecino. Antes eran 0.72rem con 0.25rem
         de separación: se elegía la unidad equivocada. */
      .prod .unit-sel { display: inline-flex; gap: var(--sp-2, 0.5rem); }
      .prod .unit-sel .us-chip { min-height: max(var(--tap-min, 44px), 2.75rem); min-width: 3.25rem; font-size: var(--fs-body, 0.875rem); font-weight: 800; line-height: 1; padding: 0 0.85rem; border-radius: var(--r-pill, 999px); border: 1.5px solid var(--border-color); background: var(--surface-ground); color: var(--text-muted); cursor: pointer; }
      .prod .unit-sel .us-chip.on { border-color: var(--action); background: var(--ember-soft); color: var(--brand-900); }
      /* Unidad junto a la cantidad en el carrito. */
      .stepper .q .q-u { display: block; font-size: 0.6rem; font-weight: 700; color: var(--text-muted); letter-spacing: 0.02em; }
      /* Toggle de fuente de existencia: ver sucursal / ver camioneta. */
      .stock-src { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0 0.15rem; flex-wrap: wrap; }
      .stock-src .ss-lbl { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.76rem; font-weight: 600; color: var(--text-muted); }
      .stock-src .ss-seg { display: inline-flex; gap: 0.25rem; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: 0.15rem; }
      .stock-src .ss-b { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; font-weight: 700; line-height: 1; padding: 0.32rem 0.6rem; border: none; background: transparent; color: var(--text-muted); border-radius: var(--r-pill, 999px); cursor: pointer; }
      .stock-src .ss-b.on { background: var(--action); color: #fff; }
      .stock-src .ss-b.unassigned { color: var(--warn-fg, #b45309); }
      .stock-src .ss-b.unassigned.on { background: var(--warn-fg, #b45309); color: #fff; }
      .ss-warn { display: flex; align-items: flex-start; gap: 0.35rem; margin: 0.15rem 0 0.4rem; font-size: 0.74rem; line-height: 1.35; color: var(--warn-fg, #b45309); }
      .ss-warn i { font-size: 0.72rem; margin-top: 0.1rem; flex-shrink: 0; }
      .ss-note { display: flex; align-items: flex-start; gap: 0.35rem; margin: 0.15rem 0 0.4rem; font-size: 0.74rem; line-height: 1.35; color: var(--text-muted); }
      .ss-note i { font-size: 0.72rem; margin-top: 0.1rem; flex-shrink: 0; }
      /* [VTK.11] Edad del catálogo cuando se abrió con la copia guardada. */
      .cat-age { display: flex; align-items: center; gap: 0.35rem; margin: 0.4rem 0 0; font-size: 0.74rem; color: var(--text-muted); }
      .cat-age i { font-size: 0.7rem; }
      .cat-age.warn { color: var(--warn-fg); }
      .stock-src .ss-b i { font-size: 0.72rem; }
      .stock-src .ss-spin { font-size: 0.85rem; color: var(--action); }
      .add { width: 2.75rem; height: 2.75rem; border-radius: 14px; border: none; background: var(--action); color: #fff; font-size: 1.15rem; display: grid; place-items: center; flex-shrink: 0; transition: transform 0.07s var(--ease, ease); }
      .add:active { transform: scale(0.92); } .add:disabled { opacity: 0.5; }
      /* Stepper en la fila del catálogo (cuando el producto ya está en el carrito) */
      .prod .row-stepper { display: flex; flex-direction: column; align-items: center; gap: 0.15rem; flex-shrink: 0; }
      .prod .row-stepper .rs-row { display: flex; align-items: center; border: 1px solid var(--text-main); border-radius: var(--r-pill, 999px); overflow: hidden; }
      .prod .row-stepper.empty .rs-row { border-color: var(--border-color); }
      .prod .row-stepper .rs-u { font-size: 0.62rem; font-weight: 800; letter-spacing: 0.04em; color: var(--text-muted); text-transform: uppercase; line-height: 1; }
      .prod .row-stepper .rs-u.warn { color: var(--action); }
      .prod .row-stepper button { width: 2.35rem; height: 2.55rem; border: none; background: transparent; color: var(--text-main); font-size: 1.2rem; font-weight: 800; line-height: 1; }
      .prod .row-stepper button:active { background: var(--surface-ground); }
      .prod .row-stepper .q { min-width: 1.9rem; text-align: center; font-family: var(--font-mono); font-weight: 800; font-size: 0.95rem; color: var(--text-main); font-variant-numeric: tabular-nums; }
      /* Order pad: input de cantidad tecleable (sin spinners), borde tenue si está en 0 */
      .prod .row-stepper button:disabled { opacity: 0.3; }
      /* Sin appearance ni spin-button acá: los retira libs/ui-web/src/number-input.css para toda
         la suite (D.5). El stepper +/− de esta fila es el reemplazo que esa regla da por supuesto. */
      .prod .row-stepper .qin { width: 2.7rem; height: 2.55rem; border: none; background: transparent; text-align: center; font-family: var(--font-mono); font-weight: 800; font-size: 0.95rem; color: var(--text-main); font-variant-numeric: tabular-nums; outline: none; padding: 0; }
      .prod .row-stepper .qin:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
      .prod .row-stepper .qin::placeholder { color: var(--text-faint); font-weight: 600; }

      .cline { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); }
      .cl-info { flex: 1; min-width: 0; }
      .cl-n { font-weight: 600; font-size: 0.9rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cl-t { font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .cl-may { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.45rem; margin-top: 0.25rem; }
      .cl-may-tag { display: inline-flex; align-items: center; gap: 0.22rem; font-size: 0.64rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; color: var(--action); background: color-mix(in srgb, var(--action) 13%, transparent); padding: 0.05rem 0.4rem; border-radius: var(--r-pill, 999px); }
      .cl-may-new { font-family: var(--font-mono); font-size: 0.8rem; font-weight: 700; color: var(--action); font-variant-numeric: tabular-nums; }
      .cl-may-base { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); text-decoration: line-through; font-variant-numeric: tabular-nums; }
      .cl-may-save { font-size: 0.7rem; font-weight: 600; color: var(--text-muted); }
      .stepper { display: flex; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); overflow: hidden; flex-shrink: 0; }
      .stepper button { width: 2.5rem; height: 2.5rem; border: none; background: var(--surface-ground); color: var(--action); font-size: 1.15rem; font-weight: 700; }
      .stepper .q { width: 2rem; text-align: center; font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; }
      .rm { width: 2.5rem; height: 2.5rem; border: none; background: none; color: var(--bad-fg); font-size: 1rem; flex-shrink: 0; }
      .totals { margin: 0.875rem 0 0 auto; max-width: 16rem; }
      .totals .row { display: flex; justify-content: space-between; padding: 0.2rem 0; color: var(--text-main); font-size: 0.9rem; }
      .totals .row b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
      /* Total todavía no firme (hay ajustes sin volcar al servidor): se atenúa para
         que no se lea como cifra final. Ver totalPendiente() en la clase. */
      .totals .row b.stale, .cartbar .cb-info b.stale { opacity: 0.45; }
      .totals .row .t-stale { margin-left: 0.35rem; font-size: 0.72rem; font-weight: 600; color: var(--text-muted); }
      .totals .mg-row b { color: var(--ok-fg); } .totals .mg-row b.neg { color: var(--bad-fg); }
      .totals .total { border-top: 2px solid var(--brand-400); padding-top: 0.4rem; margin-top: 0.4rem; font-size: 1.1rem; font-weight: 800; }
      .cancel { margin-top: 0.875rem; background: none; border: none; color: var(--bad-fg); font-weight: 600; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem; }

      .empty-cart { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
      .empty-cart i { font-size: 2.25rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }

      /* Barra de carrito (pulgar): abrir pedido + cobrar */
      .cartbar {
        position: fixed; left: 1rem; right: 1rem; bottom: calc(4.75rem + env(safe-area-inset-bottom));
        height: 3.6rem; border-radius: var(--r-lg, 16px); background: var(--neutral-900); color: #fff;
        display: flex; align-items: stretch; gap: 0.5rem; padding: 0.45rem; z-index: 40;
        box-shadow: 0 14px 32px -6px rgba(0,0,0,0.5);
      }
      .cartbar .cb-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.55rem; border: none; background: none; color: #fff; text-align: left; padding: 0 0.2rem 0 0.4rem; }
      .cartbar .cb-count { width: 1.85rem; height: 1.85rem; flex-shrink: 0; border-radius: 999px; background: var(--action); color: #fff; display: grid; place-items: center; font-weight: 800; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
      .cartbar .cb-info { flex: 1; min-width: 0; }
      .cartbar .cb-info b { display: block; font-family: var(--font-mono); font-size: 1.05rem; font-variant-numeric: tabular-nums; line-height: 1.15; }
      .cartbar .cb-info span { font-size: 0.67rem; color: var(--neutral-400); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
      .cartbar .cb-open > .pi-chevron-up { color: var(--neutral-400); font-size: 0.78rem; flex-shrink: 0; }
      .cartbar .cb-go { flex-shrink: 0; padding: 0 1.15rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 700; font-size: 0.92rem; display: flex; align-items: center; gap: 0.45rem; transition: transform 0.07s var(--ease, ease); }
      .cartbar .cb-go:active { transform: scale(0.96); } .cartbar .cb-go:disabled { opacity: 0.7; }

      /* Sheet de pedido (bottom drawer) */
      .sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 50; animation: shfade 0.15s var(--ease, ease); }
      .cart-sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        max-height: 82vh; display: flex; flex-direction: column;
        background: var(--card-bg); border-radius: 20px 20px 0 0;
        box-shadow: 0 -12px 32px -8px rgba(0,0,0,0.35);
        padding: 0 1rem calc(1rem + env(safe-area-inset-bottom)); animation: shslide 0.2s var(--ease, ease);
      }
      .cart-sheet::before { content: ''; width: 2.5rem; height: 0.28rem; border-radius: 999px; background: var(--border-color); margin: 0.5rem auto 0.5rem; flex-shrink: 0; }
      .cart-sheet .sh-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 0.4rem; flex-shrink: 0; }
      .cart-sheet .sh-title { display: flex; align-items: baseline; gap: 0.5rem; }
      .cart-sheet .sh-title h2 { font-size: 1.1rem; font-weight: 800; color: var(--text-main); }
      .cart-sheet .sh-title span { font-size: 0.74rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .cart-sheet .sh-x { width: 2.25rem; height: 2.25rem; border: none; border-radius: 12px; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; flex-shrink: 0; }
      .cart-sheet .sh-lines { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; min-height: 0; }
      .cart-sheet .sh-foot { border-top: 1px solid var(--border-color); padding-top: 0.6rem; flex-shrink: 0; }
      .cart-sheet .totals { margin: 0 0 0.7rem 0; max-width: 100%; }
      .cart-sheet .sh-go { width: 100%; height: 3.1rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 800; font-size: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; transition: transform 0.07s var(--ease, ease); }
      .cart-sheet .sh-go:active { transform: scale(0.99); } .cart-sheet .sh-go:disabled { opacity: 0.7; }
      .cart-sheet .cancel { margin: 0.5rem auto 0; display: block; }
      @keyframes shfade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes shslide { from { transform: translateY(100%); } to { transform: translateY(0); } }

      /* Input tecleable dentro del stepper (carrito) */
      .stepper .qin { width: 2.1rem; text-align: center; border: none; background: transparent; font-family: var(--font-mono); font-weight: 700; font-size: 0.95rem; color: var(--text-main); font-variant-numeric: tabular-nums; outline: none; padding: 0; }
      .stepper .qin:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }

      /* Botón ··· del header */
      .to-head .more { width: 2.25rem; height: 2.25rem; border-radius: 12px; border: none; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; font-size: 1.05rem; flex-shrink: 0; }

      /* Sheets de acciones + resultado (reusan el chrome del cart-sheet) */
      .act-sheet, .finish-sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        display: flex; flex-direction: column; gap: 0.5rem;
        background: var(--card-bg); border-radius: 20px 20px 0 0;
        box-shadow: 0 -12px 32px -8px rgba(0,0,0,0.35);
        padding: 0 1rem calc(1.1rem + env(safe-area-inset-bottom)); animation: shslide 0.2s var(--ease, ease);
      }
      .act-sheet::before, .finish-sheet::before { content: ''; width: 2.5rem; height: 0.28rem; border-radius: 999px; background: var(--border-color); margin: 0.5rem auto 0.4rem; }
      .act-sheet .sh-head, .finish-sheet .sh-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 0.3rem; }
      .act-sheet .sh-title h2, .finish-sheet .sh-title h2 { font-size: 1.1rem; font-weight: 800; color: var(--text-main); }
      .act-sheet .sh-x, .finish-sheet .sh-x { width: 2.25rem; height: 2.25rem; border: none; border-radius: 12px; background: var(--surface-ground); color: var(--text-muted); display: grid; place-items: center; }

      .act-row { display: flex; align-items: center; gap: 0.75rem; width: 100%; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); padding: 0.7rem 0.8rem; color: var(--text-main); text-align: left; }
      .act-row > .pi:first-child { font-size: 1.1rem; color: var(--action); width: 1.4rem; text-align: center; flex-shrink: 0; }
      .act-row .lbl { flex: 1; font-weight: 700; font-size: 0.92rem; display: flex; flex-direction: column; }
      .act-row .lbl small { font-weight: 500; font-size: 0.74rem; color: var(--text-muted); }
      .act-row .ch { color: var(--text-faint); font-size: 0.8rem; }
      .act-row.danger > .pi:first-child { color: var(--bad-fg); }

      .fin-opt { display: flex; align-items: center; gap: 0.7rem; width: 100%; border: 1.5px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); padding: 0.8rem; color: var(--text-main); text-align: left; transition: border-color 0.12s var(--ease, ease), background 0.12s var(--ease, ease); }
      .fin-opt > .pi { font-size: 1.25rem; color: var(--text-faint); flex-shrink: 0; }
      .fin-opt .lbl { flex: 1; font-weight: 700; font-size: 0.95rem; display: flex; flex-direction: column; }
      .fin-opt .lbl small { font-weight: 500; font-size: 0.76rem; color: var(--text-muted); }
      .fin-opt.on { border-color: var(--action); background: var(--ember-soft); }
      .fin-opt.on > .pi { color: var(--action); }

      .reasons { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.1rem 0 0.2rem; }
      .reasons .rsn-chip { border: 1px solid var(--border-color); background: var(--surface-ground); color: var(--text-main); border-radius: var(--r-pill, 999px); padding: 0.4rem 0.8rem; font-size: 0.82rem; font-weight: 600; }
      .reasons .rsn-chip.on { border-color: var(--action); background: var(--ember-soft); color: var(--brand-900); }

      .finish-sheet .sh-go { width: 100%; height: 3.1rem; margin-top: 0.4rem; border: none; border-radius: var(--r-md, 12px); background: var(--action); color: #fff; font-weight: 800; font-size: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
      .finish-sheet .sh-go:disabled { opacity: 0.5; }

      /* Aviso de pedido pendiente (anti-duplicado) */
      .pending-warn { display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 0.875rem; padding: 0.7rem 0.8rem; border-radius: var(--r-md, 12px); background: var(--warn-soft-bg); border: 1px solid var(--warn-fg); }
      .pending-warn > i { color: var(--warn-fg); font-size: 1rem; margin-top: 1px; flex-shrink: 0; }
      .pending-warn .pw-body { flex: 1; min-width: 0; }
      .pending-warn .pw-body b { display: block; font-size: 0.85rem; color: var(--text-main); }
      .pending-warn .pw-body span { font-size: 0.76rem; color: var(--text-muted); }
      .pending-warn .pw-actions { display: flex; flex-direction: column; gap: 0.35rem; flex-shrink: 0; }
      .pending-warn .pw-see { background: var(--warn-fg); color: #fff; border: none; border-radius: var(--r-sm, 8px); font-weight: 700; font-size: 0.76rem; padding: 0.35rem 0.7rem; }
      .pending-warn .pw-x { background: none; border: none; color: var(--text-muted); font-size: 0.72rem; font-weight: 600; }

      .offline-banner { display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 0.875rem; padding: 0.7rem 0.8rem; border-radius: var(--r-md, 12px); background: var(--info-soft-bg); border: 1px solid var(--info-border); }
      .offline-banner > i { color: var(--info-soft-fg); font-size: 1.1rem; margin-top: 1px; flex-shrink: 0; }
      .offline-banner .ob-body b { display: block; font-size: 0.85rem; color: var(--text-main); }
      .offline-banner .ob-body span { font-size: 0.76rem; color: var(--text-muted); line-height: 1.3; }

      @media (prefers-reduced-motion: reduce) { .add, .cartbar .cb-go, .cart-sheet, .sheet-backdrop, .cart-sheet .sh-go { transition: none; animation: none; } }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorTakeOrderComponent implements OnInit, OnDestroy {
  private readonly api = inject(VendorService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly toast = inject(MessageService);
  private readonly haptic = inject(HapticService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly conn = inject(ConnectivityService);
  private readonly offlineApi = inject(OfflineOrderService);

  /** Cifra reutilizada — no instanciar Intl en cada fila/total (estándar PWA perf). */
  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

  constructor() {
    // Gestión central de los bottom-sheets (estándar PWA §6): mientras haya uno
    // abierto, bloquea el scroll del body y, al cerrar, restaura el foco.
    effect(() => {
      const open = this.anySheetOpen();
      const body = this.doc.body;
      if (open) {
        if (!this.sheetPrevFocus) this.sheetPrevFocus = (this.doc.activeElement as HTMLElement) ?? null;
        body.style.setProperty('overflow', 'hidden');
        setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('[role="dialog"]')?.focus(), 0);
      } else {
        body.style.removeProperty('overflow');
        this.sheetPrevFocus?.focus?.();
        this.sheetPrevFocus = null;
      }
    });
  }

  ngOnDestroy(): void {
    this.doc.body.style.removeProperty('overflow');
    if (this.qtyFlushTimer) clearTimeout(this.qtyFlushTimer);
  }

  /** ¿Hay algún bottom-sheet abierto? (carrito / acciones / finalizar). */
  readonly anySheetOpen = computed(
    () => this.cartOpen() || this.actionsOpen() || this.finishOpen(),
  );
  private sheetPrevFocus: HTMLElement | null = null;

  /** Cierra el sheet superior (no hay "back" del browser en la PWA instalada). */
  private closeTopSheet(): void {
    if (this.finishOpen()) this.finishOpen.set(false);
    else if (this.actionsOpen()) this.actionsOpen.set(false);
    else if (this.cartOpen()) this.cartOpen.set(false);
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.anySheetOpen()) this.closeTopSheet();
      return;
    }
    if (e.key === 'Tab' && this.anySheetOpen()) this.trapTab(e);
  }

  /** Atrapa el Tab dentro del sheet abierto. */
  private trapTab(e: KeyboardEvent): void {
    const dlg = this.host.nativeElement.querySelector<HTMLElement>('[role="dialog"]');
    if (!dlg) return;
    const nodes = dlg.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const f: HTMLElement[] = Array.from(nodes).filter((el: HTMLElement) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    const active = this.doc.activeElement;
    if (e.shiftKey && active === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && active === last) {
      first.focus();
      e.preventDefault();
    }
  }

  readonly loading = signal(true);
  /** La carga falló (ej. 403/red). Sin esto, un fallo dejaba el cuerpo en blanco
   *  (el template exige `customer()`), que el usuario percibe como "congelada". */
  readonly loadError = signal(false);
  readonly customer = signal<VendorCustomer | null>(null);
  readonly prices = signal<PriceRow[]>([]);
  /** `[VTK.11]` De dónde salió el catálogo que se ve y de cuándo es. */
  readonly catalogo = signal<{ origen: OrigenCatalogo; at: number } | null>(null);
  /** `[VTK.11]` Bajando el catálogo nuevo detrás de la copia que se muestra. */
  readonly catalogoRefrescando = signal(false);
  /** `[VTK.11]` La recarga de fondo falló: se sigue con la copia y se dice. */
  readonly catalogoFallo = signal(false);
  /** `[MCP.3.12]` Existencias de las sucursales de la zona (null = aún no llega o no aplica). */
  readonly zona = signal<VendorZoneStockResponse | null>(null);
  /** `[MCP.3.12]` La consulta de la zona falló: se dice, no se pintan ceros. */
  readonly zonaFallo = signal(false);
  /** `[MCP.3.12]` De cuándo es la existencia de la zona, o por qué no se puede ver. */
  readonly zonaAviso = computed(() => {
    const z = this.zona();
    const fallo = this.zonaFallo();
    if (fallo) return { texto: 'No se pudo leer la existencia de las otras sucursales de tu zona', fallo: true };
    if (!z) return null;
    if (z.unmeasured_reason) return { texto: `Otras sucursales: ${z.unmeasured_reason}`, fallo: true };
    if (z.warehouses.length < 2) return null;
    const edad = edadZona(z, Date.now());
    return { texto: `Zona ${z.zone}: existencias de las otras sucursales${edad ? ' de ' + edad : ''}`, fallo: false };
  });
  /**
   * `[VTK.11]` El aviso de la edad del catálogo (ADR-056). Null cuando lo que se ve acaba de
   * bajar del servidor: ahí no hay nada que declarar.
   */
  readonly catalogoAviso = computed(() => {
    const c = this.catalogo();
    const refrescando = this.catalogoRefrescando();
    const fallo = this.catalogoFallo();
    if (!c || c.origen === 'servidor') return null;
    const edad = edadCatalogo(Date.now() - c.at);
    if (refrescando) return { texto: `Precios y existencia de ${edad} · actualizando…`, fallo: false };
    if (fallo) return { texto: `Precios y existencia de ${edad} · no se pudo actualizar`, fallo: true };
    return { texto: `Precios y existencia de ${edad}`, fallo: false };
  });
  readonly cartLines = signal<OrderLine[]>([]);
  readonly cartOrderId = signal<string | null>(null);
  /**
   * Almacén de SURTIDO del pedido: de dónde sale la mercancía cuando se reparte.
   * Lo fija la carga (la sucursal del vendedor) y NO lo mueve el toggle de abajo —
   * ver `stockWarehouseId`. Es el que viaja a `commercial.orders.warehouse_id`, o
   * sea el almacén del que se consume al fulfillar.
   */
  readonly orderWarehouseId = signal<string>('');
  /**
   * Almacén cuya EXISTENCIA se está mirando (toggle sucursal ↔ camioneta). Es capa
   * de consulta: cambia los badges de stock del catálogo, nunca el pedido.
   *
   * Antes esto y el de arriba eran la misma señal, y el toggle terminaba decidiendo
   * el almacén del pedido cuando el carrito estaba vacío (el draft nace en el primer
   * "+", con lo que hubiera en ese momento). El mismo gesto daba dos resultados según
   * si ya habías agregado algo, y el pedido se surtía del camión sin que nadie lo
   * pidiera. Hoy la toma de pedido es preventa pura: se surte al repartir, desde la
   * sucursal. La autoventa desde el camión es Fase VR y no tiene código.
   */
  readonly stockWarehouseId = signal<string>('');
  /** Fuentes de existencia del vendedor (sucursal de surtido + camioneta). */
  readonly stockSources = signal<{
    sucursal: { id: string; code: string; name: string; assigned?: boolean; source?: string } | null;
    camioneta: { id: string; code: string; name: string } | null;
  }>({ sucursal: null, camioneta: null });
  /** Vista de existencia activa: de qué almacén se muestra el stock. */
  readonly stockView = signal<'sucursal' | 'camioneta'>('sucursal');
  /** true mientras se re-consulta el catálogo tras cambiar la fuente de stock. */
  readonly stockLoading = signal(false);
  /** Modo offline: fijado al cargar. true → el pedido se arma/confirma 100% local
   *  (Dexie) y se sincroniza al reconectar. No cambia a mitad de la sesión. */
  readonly offlineMode = signal(false);
  private priceListId = '';
  readonly submitting = signal(false);
  /** Volcando los ajustes pendientes para poder mostrar un total firme (ver submit). */
  readonly settling = signal(false);
  /** Sheet de pedido (drawer) abierto/cerrado. */
  readonly cartOpen = signal(false);
  /** Sheet de acciones de la visita (···). */
  readonly actionsOpen = signal(false);
  /** Sheet "terminar visita" + su estado. */
  readonly finishOpen = signal(false);
  readonly finishing = signal(false);
  readonly finishOutcome = signal<'venta' | 'no_venta' | null>(null);
  readonly noSaleReason = signal<string | null>(null);
  readonly noSaleReasons = [
    { key: 'cerrado', label: 'Cerrado' },
    { key: 'no_atendio', label: 'No atendió' },
    { key: 'con_inventario', label: 'Tiene inventario' },
    { key: 'sin_recursos', label: 'Sin recursos' },
    { key: 'no_interesado', label: 'No le interesó' },
    { key: 'otro', label: 'Otro' },
  ];
  /** Habilita "Terminar visita": venta directa, o no-venta con motivo elegido. */
  canFinish(): boolean {
    const o = this.finishOutcome();
    return o === 'venta' || (o === 'no_venta' && !!this.noSaleReason());
  }

  /** Pedidos ya pendientes del cliente (anti-duplicado: avisar + reusar). */
  readonly pendingOrders = signal<VendorOrder[]>([]);
  readonly pendingDismissed = signal(false);
  readonly pendingTotal = computed(() => this.pendingOrders().reduce((s, o) => s + Number(o.total), 0));
  readonly hasPreventa = computed(() => this.pendingOrders().some((o) => o.is_preventa));

  // Fecha de entrega agendada (preventa). [MCP.3.4] Default: HOY en hora local (decisión de
  // David, 2026-10-20): el pedido le llega al surtidor en "Hoy" y se puede mover a otro día.
  // Domingo no hay reparto: ese día cae al próximo hábil (lunes), como antes.
  // Antes era siempre el próximo día hábil; Carga y la bandeja del surtidor aceptan hoy.
  requestedDate = fechaEntregaPorOmision();
  readonly minDate = todayIso();
  private customerId = '';

  readonly adding = signal<Record<string, boolean>>({});
  /**
   * [MCP.3.5] product_id → motivo (en palabras del vendedor) por el que NO se creó su renglón.
   * Se pinta pegado a la fila y se borra en el siguiente intento que sí entra.
   */
  readonly rowError = signal<Record<string, string>>({});
  /** [MCP.3.5] Secuencia de lecturas del pedido: sólo la más nueva escribe `cartLines`. */
  private cartReadSeq = 0;
  /** Signal (no campo plano): un `computed` que lo lea reacciona al tipear. */
  readonly searchTerm = signal('');

  /**
   * Cantidad objetivo optimista por producto, pendiente de PATCH (debounced). La
   * UI la refleja al instante; el server se sincroniza en una ráfaga (1 update
   * por línea al soltar, no uno por cada tap de +/−). Evita la lluvia de requests
   * del ajuste fino en campo.
   */
  private readonly pendingQty = signal<Map<string, number>>(new Map());
  private qtyFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * [MCP.3.6] Cantidades YA mandadas al servidor y que el carrito todavía no refleja.
   * `done` = el servidor ya contestó que sí; la entrada se borra cuando una lectura del pedido
   * que salió DESPUÉS de esa respuesta la trae. Antes, el volcado borraba lo optimista al
   * mandar el PUT y la fila volvía a la cantidad vieja mientras el PUT viajaba: el número
   * «saltaba para atrás» y los toques de ese rato subían desde ahí y se perdían.
   */
  private readonly sentQty = signal<Map<string, { qty: number; done: boolean }>>(new Map());
  /** [MCP.3.6] Volcado en vuelo: el siguiente espera a que vuelva (nunca dos PUT al mismo renglón a la vez). */
  private flushEnVuelo: Observable<void> | null = null;

  /** `[MCP.3.12]` La tira de la zona de este producto, en la unidad que se está pidiendo. */
  zonaDe(p: PriceRow): ChipZona[] | null {
    return this.offlineMode() ? null : chipsDeZona(this.zona(), p.product_id, this.unitFactor(p));
  }

  // ── [MCP.3.13] De qué sucursal de la zona se surte cada producto ──────────────────────────
  /** Producto → sucursal elegida ANTES de tener renglón (`null` = la mía). Con renglón manda el renglón. */
  readonly origenElegido = signal<Map<string, string | null>>(new Map());
  /** Producto cuyo renglón se está moviendo de sucursal (la tira se bloquea mientras). */
  readonly cambiandoOrigen = signal<string | null>(null);

  private lineaDe(productId: string): OrderLine | undefined {
    return this.cartLines().find((l) => l.product_id === productId);
  }
  /** La sucursal de surtido de este producto: la de su renglón, o la elegida; `null` = la mía. */
  origenDe(p: PriceRow): string | null {
    const l = this.lineaDe(p.product_id);
    if (l) return l.source_warehouse_id ?? null;
    return this.origenElegido().get(p.product_id) ?? null;
  }
  origenEs(p: PriceRow, c: ChipZona): boolean {
    const o = this.origenDe(p);
    return o ? c.id === o : c.mine;
  }
  ariaChip(c: ChipZona, p: PriceRow): string {
    const u = this.selectedUnit(p)?.unit ?? '';
    return `${c.name}${c.mine ? ' (tu sucursal)' : ''}: ${c.qty == null ? 'sin dato' : c.qty + (u ? ' ' + u : '')}`;
  }
  /** Si lo que se pide pasa de lo que hay en la sucursal elegida, se dice en la fila (no bloquea: es preventa). */
  avisoOrigen(p: PriceRow): string | null {
    const zs = this.zonaDe(p);
    const n = this.dispCount(p);
    if (!zs || !(n > 0)) return null;
    const c = zs.find((x) => this.origenEs(p, x));
    if (!c || c.qty == null || n <= c.qty) return null;
    return c.qty === 0 ? `En ${c.short} no hay: elige otra sucursal` : `En ${c.short} sólo hay ${c.qty}: elige otra o pide ${c.qty}`;
  }

  /**
   * Toca una sucursal de la tira. Sin renglón: queda elegida para el siguiente «+». Con renglón: se
   * mueve a esa sucursal (el servidor lo vuelve a tarificar con el precio de allá). No se mueve
   * mientras hay una cantidad sin guardar: se mezclarían dos cambios en el mismo renglón.
   */
  elegirOrigen(p: PriceRow, c: ChipZona): void {
    const origen = c.mine ? null : c.id;
    const linea = this.lineaDe(p.product_id);
    if (!linea) {
      this.origenElegido.update((m) => new Map(m).set(p.product_id, origen));
      this.haptic.selection();
      return;
    }
    if ((linea.source_warehouse_id ?? null) === origen) return;
    const orderId = this.cartOrderId();
    if (!orderId || this.cambiandoOrigen()) return;
    if (this.pendingQty().has(p.product_id) || this.sentQty().has(p.product_id)) {
      this.toast.add({ severity: 'info', summary: 'Un momento', detail: 'Se está guardando la cantidad; vuelve a tocar la sucursal.', life: 3000 });
      return;
    }
    this.cambiandoOrigen.set(p.product_id);
    this.haptic.selection();
    this.api
      .updateLine(orderId, linea.id, Number(linea.quantity), undefined, origen)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.reloadCart(() => this.cambiandoOrigen.set(null)),
        error: (err) => {
          this.cambiandoOrigen.set(null);
          this.haptic.notification('error');
          this.toast.add({ severity: 'error', summary: 'No se cambió la sucursal', detail: this.motivoDeError(err), life: 5000 });
        },
      });
  }

  /** «Se surte en: LPA (3) · PH (1)». `null` cuando todo sale de la sucursal del pedido. */
  readonly surteEn = computed(() => {
    const lines = this.cartLines();
    if (!lines.some((l) => !!l.source_warehouse_id)) return null;
    const mia = this.zona()?.warehouses.find((w) => w.mine);
    const grupos = new Map<string, { label: string; n: number; ajena: boolean }>();
    for (const l of lines) {
      const ajena = !!l.source_warehouse_id;
      const label = ajena
        ? (l.source_warehouse_short || l.source_warehouse_name || 'otra sucursal')
        : (mia?.short || this.stockSources().sucursal?.name || 'tu sucursal');
      const g = grupos.get(label) ?? { label, n: 0, ajena };
      g.n += 1;
      grupos.set(label, g);
    }
    return [...grupos.values()].sort((a, b) => Number(a.ajena) - Number(b.ajena));
  });

  stockClass(p: PriceRow): 'ok' | 'warn' | 'bad' {
    const s = Number(p.stock_available ?? 0);
    if (s <= 0) return 'bad';
    if (s < (p.min_qty || 1)) return 'warn';
    return 'ok';
  }
  stockLabel(p: PriceRow): string {
    const s = Number(p.stock_available ?? 0);
    // [MCP.3.5] «Existencias», no «stock»: es la palabra que usa el vendedor en ruta.
    if (s <= 0) return 'Sin existencias';
    // Existencia en la MISMA unidad que se está pidiendo (paquetes/cajas enteros
    // disponibles). Para la unidad base se muestra el crudo.
    const f = this.unitFactor(p);
    if (f > 1) {
      const u = this.selectedUnit(p)?.unit ?? '';
      return `Existencias: ${Math.floor(s / f)} ${u}`;
    }
    return `Existencias: ${s}`;
  }

  /** Productos del price list con precio real (lo pedible). */
  readonly pricedCount = computed(
    () => this.prices().filter((p) => p.price != null && Number(p.price) > 0).length,
  );
  /** Productos del maestro SIN precio en esta lista (existen pero no se pueden pedir). */
  readonly unpricedCount = signal(0);

  /**
   * Catálogo navegable por default (sin buscar): TODO lo pedible ordenado de más
   * vendido a menos vendido (el backend ya lo ordena por ranking real), quitando lo
   * que ya está en habituales. Cap para no pintar miles de filas — el resto se
   * alcanza por búsqueda.
   */
  private readonly BROWSE_CAP = 120;
  readonly browseRows = computed(() => {
    const skip = new Set<string>(this.habitualRows().map((p) => p.product_id));
    const out: PriceRow[] = [];
    for (const p of this.prices()) {
      if (p.price == null || Number(p.price) <= 0) continue;
      if (skip.has(p.product_id)) continue;
      out.push(p);
      if (out.length >= this.BROWSE_CAP) break;
    }
    return out;
  });

  /** Índice product_id → PriceRow del catálogo cargado (1 vez por cambio de catálogo). */
  private readonly byIdMap = computed(() => new Map(this.prices().map((p) => [p.product_id, p])));

  /** VQ: productos habituales del cliente (order pad — sección "Lo que suele pedir"). */
  readonly frequent = signal<FrequentProduct[]>([]);
  /** product_id → cantidad promedio histórica (sugerida al tocar "+" en un habitual). */
  readonly avgQtyByProduct = computed(
    () => new Map(this.frequent().map((f) => [f.product_id, Math.max(1, Number(f.avg_qty) || 1)] as const)),
  );

  /**
   * Order pad — grupo "Lo que suele pedir": los habituales del cliente con precio,
   * EN SU ORDEN (que se carga una vez y no se mueve), más lo que entró al pedido y
   * no es habitual, pegado al final.
   *
   * Antes esto arrancaba recorriendo cartLines(), así que cada producto agregado
   * SALTABA al tope de la sección ~500 ms después del toque, cuando volvía el
   * reloadCart. Ese salto —con la lista moviéndose bajo el dedo que ya iba al
   * siguiente renglón— era parte del reporte de "poca fluidez".
   */
  readonly habitualRows = computed(() => {
    const byId = this.byIdMap();
    const seen = new Set<string>();
    const out: PriceRow[] = [];
    for (const f of this.frequent()) {
      if (seen.has(f.product_id)) continue;
      const p = byId.get(f.product_id);
      if (p && p.price != null && Number(p.price) > 0) { seen.add(f.product_id); out.push(p); }
    }
    for (const l of this.cartLines()) {
      if (seen.has(l.product_id)) continue;
      const p = byId.get(l.product_id);
      if (p) { seen.add(l.product_id); out.push(p); }
    }
    return out;
  });

  /** ¿el pedido se pre-cargó con la canasta predicha? (para el banner + "Vaciar"). */
  readonly prefilled = signal(false);
  readonly prefilling = signal(false);
  /** El vendedor descartó la oferta de pedido sugerido (banner opt-in). */
  readonly prefillDismissed = signal(false);
  /** ¿Ofrecer cargar la canasta predicha? Pedido nuevo, vacío y con predicción. */
  readonly showPrefillOffer = computed(
    () =>
      !this.loading() &&
      !this.prefilled() &&
      !this.prefilling() &&
      !this.prefillDismissed() &&
      this.cartLines().length === 0 &&
      this.predictedLines().length > 0,
  );

  /**
   * Canasta PREDICHA para pre-cargar el pedido: los productos del núcleo de compra
   * del cliente (comprados en ≥2 pedidos; si solo tiene 1 pedido de historia, ese
   * pedido) con su cantidad promedio histórica. Es el "suggested order" — el
   * vendedor revisa/ajusta/confirma en vez de armar.
   */
  readonly predictedLines = computed(() => {
    const byId = this.byIdMap();
    const freq = this.frequent();
    if (!freq.length) return [] as { product_id: string; quantity: number }[];
    const maxOC = freq.reduce((m, f) => Math.max(m, Number(f.order_count) || 0), 0);
    const threshold = maxOC >= 2 ? 2 : 1;
    const out: { product_id: string; quantity: number }[] = [];
    for (const f of freq) {
      if ((Number(f.order_count) || 0) < threshold) continue;
      const p = byId.get(f.product_id);
      if (!p || p.price == null || Number(p.price) <= 0) continue;
      const qty = Math.max(Math.floor(Number(f.avg_qty) || 1), p.min_qty || 1);
      out.push({ product_id: f.product_id, quantity: qty });
    }
    return out.slice(0, 30);
  });

  /**
   * Lista mostrada en búsqueda: con término → TODO el catálogo filtrado (nombre/SKU).
   * Sin término la plantilla pinta Habituales + Catálogo y esta lista queda vacía.
   */
  /** Tope de resultados renderizados en búsqueda → la lista nunca pinta miles
   *  de filas, así cada tecla responde instantáneo. */
  private readonly SEARCH_CAP = 60;
  /** Índice de búsqueda precomputado (1 vez por cambio de catálogo): texto
   *  normalizado "nombre + código de producto (sku)" por producto → cada tecla
   *  solo hace includes. */
  readonly priceIndex = computed(() =>
    this.prices().map((p) => ({ p, hay: foldText(p.product_name + ' ' + (p.sku || '')) })),
  );
  /** ¿la búsqueda llegó al tope (hay más matches sin mostrar)? → mostrar "N+". */
  readonly searchCapped = computed(
    () => !!this.searchTerm().trim() && this.displayed().length >= this.SEARCH_CAP,
  );

  readonly displayed = computed(() => {
    const raw = this.searchTerm().trim();
    if (raw) {
      // Match por tokens (AND), sin acentos. Corta al llegar al tope.
      const tokens = foldText(raw).split(/\s+/).filter(Boolean);
      const out: PriceRow[] = [];
      for (const it of this.priceIndex()) {
        if (tokens.every((t) => it.hay.includes(t))) {
          out.push(it.p);
          if (out.length >= this.SEARCH_CAP) break;
        }
      }
      return out;
    }
    // Sin búsqueda la plantilla no usa esta lista (pinta Habituales + Catálogo).
    return [] as PriceRow[];
  });

  /**
   * `[VTK.9]` Cuánto trae la caja de cada resultado de búsqueda (pedido de ruta, 2026-10-14: el
   * cliente pregunta «¿cuántas trae?» y la respuesta sólo vivía en el factor del selector).
   * `[VTK.12]` Se calcula una vez por catálogo (no al teclear) porque también lo usa la caja
   * elegida en el selector, en cualquier lista. Son ~9,400 escaleras de 2–3 peldaños: milisegundos.
   */
  readonly contenidoCajaById = computed(() => {
    const m = new Map<string, ContenidoCaja>();
    for (const p of this.prices()) {
      const c = contenidoCaja(this.unitsOf(p), this.cajaDeclarada(p));
      if (c) m.set(p.product_id, c);
    }
    return m;
  });

  /**
   * La caja que declara la escalera de Kepler de la sucursal (peldaño `box`: CJA, BTO o CUB).
   * `null` = vino la escalera y no declara caja; `undefined` = no vino (se reconoce por rótulo).
   */
  /**
   * `[VTK.12]` Con la CAJA elegida en el selector, cuántas unidades base trae (y cuántas lleva ya
   * el pedido). Pedido de ruta, 2026-10-15: «cuando seleccionen caja, que diga cuántas piezas
   * tiene». Null si la unidad elegida no es la caja o el producto no declara caja: no se inventa.
   * La unidad base es la del producto (PZA, KG, PAQ…), no siempre pieza.
   */
  cajaElegida(p: PriceRow): { caja: string; piezas: number; base: string; enPedido: number | null } | null {
    const c = this.contenidoCajaById().get(p.product_id);
    const su = this.selectedUnit(p);
    if (!c || !su || su.unit !== c.caja) return null;
    const base = c.partes[c.partes.length - 1];
    const q = this.cartQty(p.product_id) || 0;
    return { caja: c.caja, piezas: base.qty, base: base.unit, enPedido: q > 0 ? q : null };
  }

  private cajaDeclarada(p: PriceRow): { unit: string; factor: number } | null | undefined {
    if (!p.rungs?.length) return undefined;
    const b = p.rungs.find((r) => r.rung === 'box');
    return b ? { unit: b.unit, factor: b.factor } : null;
  }

  readonly cartUnitsTotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.quantity), 0));
  readonly cartSubtotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.line_subtotal), 0));
  readonly cartTaxTotal = computed(() => this.cartLines().reduce((s, l) => s + Number(l.line_tax), 0));
  readonly cartTotal = computed(() => this.cartSubtotal() + this.cartTaxTotal());
  /**
   * El total en pantalla es más viejo que las cantidades: hay ajustes sin volcar al
   * servidor, que es quien resuelve tiers de volumen y promociones. No se recalcula
   * acá a propósito (sería inventar el número); se declara que todavía no es firme.
   */
  readonly totalPendiente = computed(() => this.pendingQty().size > 0 || this.sentQty().size > 0 || this.settling());

  /** Margen aprox. del pedido: (subtotal − costo) / subtotal. Null si no hay costo. */
  readonly cartMarginPct = computed(() => {
    const lines = this.cartLines();
    let rev = 0;
    let cost = 0;
    let haveCost = false;
    for (const l of lines) {
      rev += Number(l.line_subtotal);
      const c = this.productCostById(l.product_id);
      if (c != null) {
        cost += c * Number(l.quantity);
        haveCost = true;
      }
    }
    if (!haveCost || rev <= 0) return null;
    return Math.round(((rev - cost) / rev) * 100);
  });

  /** product_id → cantidad total en el carrito (suma de líneas), computado 1 vez
   *  por cambio del carrito en vez de filtrar/reducir por cada fila en cada CD. */
  readonly qtyByProduct = computed(() => {
    const m = new Map<string, number>();
    for (const l of this.cartLines()) {
      m.set(l.product_id, (m.get(l.product_id) ?? 0) + Number(l.quantity));
    }
    return m;
  });
  /** Cantidad del producto en el carrito. Prioriza el override optimista
   *  (pendiente de flush); si no, la SUMA de sus líneas reales. */
  cartQty(productId: string): number {
    const pend = this.pendingQty().get(productId);
    if (pend != null) return pend;
    // [MCP.3.6] Lo mandado y aún no releído: es lo que el vendedor tocó, no lo de antes.
    const enviada = this.sentQty().get(productId);
    if (enviada != null) return enviada.qty;
    return this.qtyByProduct().get(productId) ?? 0;
  }

  /** Líneas a mostrar en el sheet: oculta las que el optimista llevó a 0 (en
   *  tránsito a quitarse) para que la vista no muestre una línea con qty 0. */
  readonly visibleCartLines = computed(() =>
    this.cartLines().filter((l) => this.cartQty(l.product_id) > 0),
  );

  /**
   * Pedido que se está CORRIGIENDO. Llega como ?order=<id> desde "Por entregar",
   * que ya lo reabrió a borrador. Con esto la pantalla abre ESE pedido en vez del
   * borrador suelto del cliente — que puede no existir o, peor, ser otro.
   */
  readonly editingOrderId = signal<string | null>(null);
  readonly editingCode = signal<string | null>(null);
  readonly isEditing = computed(() => !!this.editingOrderId());

  ngOnInit(): void {
    const customerId = this.route.snapshot.paramMap.get('id');
    if (!customerId) return;
    this.customerId = customerId;
    this.editingOrderId.set(this.route.snapshot.queryParamMap.get('order'));
    if (this.conn.isOnline()) {
      this.loadOnline(customerId);
      return;
    }
    // Sin señal no se corrige un pedido del servidor: el modo offline trabaja
    // sobre borradores de Dexie y abriría OTRO pedido, no éste. Se dice y se
    // vuelve, en vez de dejar al vendedor editando algo que no es.
    if (this.editingOrderId()) {
      this.loading.set(false);
      this.toast.add({
        severity: 'warn',
        summary: 'Sin conexión',
        detail: 'Para corregir un pedido ya agendado hace falta señal.',
        life: 6000,
      });
      this.router.navigate(['/vendor/pending']);
      return;
    }
    this.loadOffline(customerId);
  }

  /** Carga online: backend + cachea el contexto para poder abrir offline luego. */
  /** `[MCP.3.12]` La zona va por su lado: si tarda o falla, la toma de pedido abre igual. */
  private cargarZona(): void {
    this.zonaFallo.set(false);
    this.api
      .myZoneStock()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (z) => this.zona.set(z ?? null),
        error: () => {
          this.zona.set(null);
          this.zonaFallo.set(true);
        },
      });
  }

  private loadOnline(customerId: string): void {
    this.cargarZona();
    // [VTK.13] Todo lo que no depende de otra respuesta sale A LA VEZ. Antes borrador,
    // pendientes y habituales esperaban a la ronda de fuentes+cliente sin necesitarla, y las
    // listas de precio abrían otro salto después del cliente: 3–4 viajes en serie por apertura.
    // Ahora el único encadenado es catálogo ← (fuentes + cliente), y en el 2º cliente de la ruta
    // fuentes y listas ya están en memoria (VendorService.deSesion).
    this.loadError.set(false);
    // El customer alimenta el catálogo sin re-pedirlo (antes se fetcheaba 2 veces).
    const cabecera$ = forkJoin({
      // warehouse NO es crítico: si falla, seguimos con almacén vacío (sin badges
      // de stock) en vez de tumbar toda la pantalla. El customer SÍ es crítico.
      // Fuentes de stock del vendedor: sucursal de surtido (inicial) + camioneta.
      sources: this.api
        .myStockSources()
        .pipe(catchError(() => of({ sucursal: null, camioneta: null }))),
      customer: this.api.getCustomer(customerId),
      // Sólo calienta la memoria: catalogInstant las lee de ahí sin otro viaje.
      listas: this.api.precalentarListas().pipe(catchError(() => of(null))),
    }).pipe(
      switchMap(({ sources, customer }) => {
        const warehouseId = sources.sucursal?.id || '';
        // catalog con fallback: un 403/red ya no deja la pantalla en blanco;
        // se renderiza el cliente y se avisa/reintenta.
        // [VTK.11] Con la copia que ya tiene el celular si sirve; la nueva se baja detrás.
        return this.api.catalogInstant(customer, warehouseId || undefined).pipe(
          catchError(() =>
            of<CatalogoAlAbrir>({ priceListId: '', prices: [], origen: 'servidor', at: Date.now() }),
          ),
          map((catalog) => ({ sources, customer, warehouseId, catalog })),
        );
      }),
    );
    forkJoin({
      cabecera: cabecera$,
      // Corrigiendo: el pedido viene dado (ya reabierto a borrador). Si no,
      // el borrador suelto del cliente, como siempre.
      existingDraft: this.editingOrderId()
        ? this.api.orderById(this.editingOrderId()!).pipe(catchError(() => of(null)))
        : this.api.draftForCustomer(customerId).pipe(catchError(() => of(null))),
      pending: this.api.pendingForCustomer(customerId).pipe(catchError(() => of([] as VendorOrder[]))),
      frequent: this.api.frequentProducts(customerId).pipe(catchError(() => of([] as FrequentProduct[]))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ cabecera: { sources, customer, warehouseId, catalog }, existingDraft, pending, frequent }) => {
          this.stockSources.set(sources);
          this.stockView.set('sucursal');
          this.customer.set(customer);
          this.prices.set(catalog.prices);
          this.priceListId = catalog.priceListId;
          this.orderWarehouseId.set(warehouseId || '');
          this.stockWarehouseId.set(warehouseId || '');
          // Cobertura de precio: cuántos productos del maestro existen pero no se
          // pueden pedir por falta de precio (para avisar a oficina). Best-effort.
          if (catalog.priceListId) {
            this.api
              .priceCoverage(catalog.priceListId)
              .pipe(takeUntilDestroyed(this.destroyRef))
              .subscribe({ next: (cov) => this.unpricedCount.set(cov?.unpriced || 0), error: () => void 0 });
          }
          this.pendingOrders.set(pending);
          this.frequent.set(frequent);
          this.loading.set(false);
          // Cachear el contexto (best-effort) para poder armar el pedido sin red
          // en una próxima visita a este cliente.
          // [VTK.11] El catálogo sólo se reescribe cuando llegó del servidor; si se abrió con la
          // copia guardada, se guarda sólo el cliente (reescribir ~10 MB iguales es trabajo de más).
          this.catalogo.set({ origen: catalog.origen, at: catalog.at });
          this.catalogoFallo.set(false);
          if (catalog.priceListId) {
            const guardar = catalog.origen === 'servidor'
              ? this.offlineApi.cacheContext(customerId, {
                  customer,
                  priceListId: catalog.priceListId,
                  warehouseId: warehouseId || '',
                  prices: catalog.prices,
                  frequent,
                })
              : this.offlineApi.cacheCustomer(customerId, { customer, priceListId: catalog.priceListId, frequent });
            void guardar.catch(() => void 0);
            if (hayQueRefrescar(catalog.origen, catalog.at, Date.now())) {
              this.refrescarCatalogo(customer, warehouseId || '', customerId, frequent);
            }
          }
          if (existingDraft) {
            // Hay borrador en curso → se respeta tal cual (no se pisa con el predicho).
            this.cartOrderId.set(existingDraft.id);
            if (this.editingOrderId()) {
              this.editingCode.set(existingDraft.code || null);
              // Corrigiendo: se conserva la fecha de entrega que ya tenía, para no
              // re-agendar en otro día sin que nadie lo pidiera.
              const fecha = (existingDraft as VendorOrder).requested_delivery_date;
              if (fecha) this.requestedDate = String(fecha).slice(0, 10);
            }
            // Corrigiendo, `existingDraft` YA vino de `GET /orders/:id`, que trae las
            // líneas: re-pedirlo era un request de más en cada apertura, sobre red de
            // campo. `draftForCustomer` (pedido nuevo) sale de un listado y no las
            // trae, así que ahí sí hay que ir a buscarlas.
            if (existingDraft.lines) {
              this.cartLines.set(existingDraft.lines);
            } else {
              this.api.orderById(existingDraft.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
                next: (full) => this.cartLines.set(full.lines || []),
                error: () => void 0,
              });
            }
          }
          // Pedido nuevo: NO auto-armamos la canasta predicha (evitar agendar de
          // más sin querer). Se ofrece como CTA opt-in (chip "Sugerido · Cargar").
        },
        error: (e) => {
          // El customer (crítico) falló: marcamos error → el template muestra el
          // estado de reintento en vez de quedar en blanco ("congelada").
          this.loading.set(false);
          this.loadError.set(true);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar', detail: e.error?.message || e.message });
        },
      });
  }

  /**
   * Cambia la fuente de existencia mostrada (sucursal ↔ camioneta) y re-consulta el
   * catálogo para traer el stock de ESE almacén.
   *
   * Solo mira: NO toca `orderWarehouseId`, así que el pedido se sigue surtiendo de la
   * sucursal aunque estés viendo la camioneta — y da igual si el carrito está vacío o
   * no (antes no daba igual: con el carrito vacío el toggle elegía el almacén del
   * pedido, porque el draft nace en el primer "+"). Offline no aplica (el catálogo
   * cacheado es de la sucursal). No hace nada si la fuente no existe.
   */
  switchStockView(view: 'sucursal' | 'camioneta'): void {
    if (view === this.stockView() || this.offlineMode()) return;
    const src = view === 'camioneta' ? this.stockSources().camioneta : this.stockSources().sucursal;
    if (!src) return;
    const c = this.customer();
    if (!c) return;
    this.stockView.set(view);
    this.stockWarehouseId.set(src.id);
    this.stockLoading.set(true);
    this.api
      .catalogForCustomer(c, src.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cat) => {
          this.prices.set(cat.prices);
          this.stockLoading.set(false);
        },
        error: () => this.stockLoading.set(false),
      });
  }

  /**
   * `[VTK.11]` Baja el catálogo nuevo detrás de la copia con la que se abrió y la reemplaza.
   * Si mientras tanto el vendedor cambió a ver la camioneta, NO se pisa esa vista: el catálogo
   * nuevo igual queda guardado para la próxima apertura.
   */
  private refrescarCatalogo(
    customer: VendorCustomer,
    warehouseId: string,
    customerId: string,
    frequent: FrequentProduct[],
  ): void {
    this.catalogoRefrescando.set(true);
    this.api
      .catalogForCustomer(customer, warehouseId || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (fresh) => {
          this.catalogoRefrescando.set(false);
          if (!fresh.priceListId || !fresh.prices.length) {
            this.catalogoFallo.set(true);
            return;
          }
          void this.offlineApi
            .cacheContext(customerId, { customer, priceListId: fresh.priceListId, warehouseId, prices: fresh.prices, frequent })
            .catch(() => void 0);
          if (this.stockView() !== 'sucursal' || this.stockWarehouseId() !== warehouseId) return;
          this.prices.set(fresh.prices);
          this.catalogo.set({ origen: 'servidor', at: Date.now() });
        },
        error: () => {
          this.catalogoRefrescando.set(false);
          this.catalogoFallo.set(true);
        },
      });
  }

  /** Reintenta la carga (botón del estado de error). */
  reload(): void {
    if (!this.customerId) { this.back(); return; }
    this.loadError.set(false);
    this.loading.set(true);
    if (this.conn.isOnline()) this.loadOnline(this.customerId);
    else this.loadOffline(this.customerId);
  }

  /** Carga offline: del caché Dexie. Abre/crea el draft local del cliente. */
  private loadOffline(customerId: string): void {
    this.offlineMode.set(true);
    this.offlineApi
      .getContext(customerId)
      .then(async (ctx) => {
        if (!ctx) {
          this.loading.set(false);
          this.toast.add({
            severity: 'warn',
            summary: 'Sin datos offline',
            detail: 'Este cliente no se cargó con conexión antes. Ábrelo una vez con señal.',
            life: 6000,
          });
          return;
        }
        this.customer.set(ctx.customer);
        this.prices.set(ctx.prices);
        this.orderWarehouseId.set(ctx.warehouseId || '');
        this.stockWarehouseId.set(ctx.warehouseId || '');
        this.frequent.set(ctx.frequent);
        // Abrir/crear el draft local y reflejar sus líneas.
        const draft = await this.offlineApi.ensureDraft(ctx.customer, ctx.warehouseId || '');
        this.cartOrderId.set(draft.id);
        this.cartLines.set(this.offlineApi.toOrderLines(draft));
        this.loading.set(false);
      })
      .catch(() => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el cliente sin conexión.' });
      });
  }

  back(): void {
    this.router.navigate(['/vendor/route-home']);
  }

  /** Ir a "Por entregar" para resolver el pendiente en vez de duplicarlo. */
  goPending(): void {
    this.router.navigate(['/vendor/pending']);
  }

  /** "+" en la fila → sube UN escalón de la presentación activa, o crea la línea. */
  incProduct(p: PriceRow): void {
    const cur = this.cartQty(p.product_id);
    if (cur > 0) this.bumpQty(p.product_id, subirEscalon(cur, this.unitFactor(p)));
    else this.createLine(p, this.suggestedQty(p));
  }
  /** "−" en la fila → baja UN escalón (al llegar a 0 el flush quita la línea). */
  decProduct(p: PriceRow): void {
    const cur = this.cartQty(p.product_id);
    if (cur > 0) this.bumpQty(p.product_id, bajarEscalon(cur, this.unitFactor(p)));
  }

  /**
   * Cantidad inicial base al tocar "+": el promedio histórico del cliente (si es
   * habitual) o una presentación completa, SIEMPRE acomodada a la rejilla de la
   * medida activa y al mínimo de compra. Sin esto, un promedio de 5 piezas con
   * paquete de 6 creaba la línea en 5 y la fila mostraba 1; uno de 3 con caja de 8
   * la mostraba en 0 — el vendedor tocaba "+" y veía cero.
   */
  private suggestedQty(p: PriceRow): number {
    const avg = this.avgQtyByProduct().get(p.product_id) || 0;
    return ajustarARejilla(avg, this.unitFactor(p), p.min_qty || 1);
  }

  /**
   * Order pad: cantidad tecleada en la fila, EN LA UNIDAD QUE LA FILA ESTÁ
   * MOSTRANDO. Se convierte a base (×factor). 0/vacío quita la línea.
   *
   * El factor se toma del display, no de la selección: si la fila cayó a unidad
   * base por estar fuera de rejilla, lo tecleado son unidades base. Sin esa
   * distinción, teclear el mismo número que ya se veía cambiaba la cantidad —
   * el reporte de "se me mueve solo el pedido".
   */
  setQtyTyped(p: PriceRow, raw: string | number): void {
    const count = Math.max(0, Math.floor(Number(raw) || 0));
    const base = count * (this.offGrid(p) ? 1 : this.unitFactor(p));
    const cur = this.cartQty(p.product_id);
    if (cur > 0) this.bumpQty(p.product_id, base); // existe → ajustar (0 = quitar en flush)
    else if (base > 0) this.createLine(p, base); // nuevo → crear inmediato
  }

  /** Crea la línea (asegurando draft) con la cantidad dada, en rejilla y sobre el mínimo. */
  private createLine(p: PriceRow, qty: number): void {
    const c = this.customer();
    if (!c || !this.orderWarehouseId()) return;
    const q = ajustarARejilla(qty, this.unitFactor(p), p.min_qty || 1);
    if (q <= 0) return;
    // El aviso solo vale si lo que se está mirando es el almacén que va a surtir. Con
    // la vista en camioneta, `stock_available` es del camión y el pedido sale de la
    // sucursal: avisar ahí sería comparar contra la existencia equivocada.
    if (
      p.stock_available != null &&
      q > Number(p.stock_available) &&
      this.stockWarehouseId() === this.orderWarehouseId()
    ) {
      this.toast.add({ severity: 'warn', summary: 'Pocas existencias hoy', detail: `Hoy hay ${p.stock_available}. Es preventa: se surte al repartir.`, life: 4000 });
    }
    if (this.offlineMode()) {
      this.haptic.selection();
      void this.setLocalQty(p.product_id, q);
      return;
    }
    this.adding.update((m) => ({ ...m, [p.product_id]: true }));
    // [VTK.5] Optimista, como en cotizaciones: la fila muestra la cantidad en cuanto se toca, sin
    // esperar a que el servidor cree el pedido y el renglón. Los toques que lleguen mientras
    // tanto se acumulan en `pendingQty` (el "+" ya no se bloquea) y se mandan en el flush que
    // corre al confirmar la creación.
    this.pendingQty.update((m) => new Map(m).set(p.product_id, q));
    this.haptic.selection();
    // [VU.4] Con sello, la cantidad viaja EN LA UNIDAD CAPTURADA (`q` está en base, así que
    // se divide por el factor) y el servidor la convierte de vuelta. Sin sello va en base.
    // Mandar `q` en base junto con el sello la multiplicaría otra vez.
    const sello = this.selloDe(p);
    const qEnviada = sello ? conteoExacto(q, sello.qty_factor) : null;
    const ensure$ = this.cartOrderId()
      ? of({ id: this.cartOrderId()! } as any)
      : this.api.ensureDraftForCustomer(c.id, this.orderWarehouseId(), 'route');
    ensure$
      .pipe(
        switchMap((draft) => {
          this.cartOrderId.set(draft.id);
          // [MCP.3.13] Con la sucursal elegida en la tira (sin elegir = la del pedido).
          const origen = this.origenDe(p);
          return qEnviada != null && sello
            ? this.api.addLine(draft.id, p.product_id, qEnviada, sello, origen)
            : this.api.addLine(draft.id, p.product_id, q, undefined, origen);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.rowError.update((m) => { const n = { ...m }; delete n[p.product_id]; return n; });
          // reload primero; con el renglón ya en el carrito, el flush manda lo que el vendedor
          // haya tocado mientras se creaba (si quedó igual, no manda nada).
          // [MCP.3.5] `adding` se apaga DESPUÉS de recargar, no antes: entre "el servidor lo
          // creó" y "cartLines ya lo trae" el producto no tiene renglón, y un flush que cayera
          // en ese hueco tiraba la cantidad pendiente por no encontrarle línea.
          this.reloadCart(() => {
            this.adding.update((m) => ({ ...m, [p.product_id]: false }));
            this.scheduleQtyFlush();
          });
        },
        error: (err) => {
          this.adding.update((m) => ({ ...m, [p.product_id]: false }));
          // Se deshace lo optimista: el renglón no existe.
          this.pendingQty.update((m) => { const n = new Map(m); n.delete(p.product_id); return n; });
          this.haptic.notification('error');
          const motivo = this.motivoDeError(err);
          // [MCP.3.5] Además del toast (que se va solo), el motivo queda pegado a la fila.
          this.rowError.update((m) => ({ ...m, [p.product_id]: `No se agregó: ${motivo}` }));
          this.toast.add({ severity: 'error', summary: 'No se agregó el producto', detail: motivo, life: 6000 });
        },
      });
  }

  /**
   * [MCP.3.5] El motivo de un error del servidor, legible para el vendedor. Nest manda
   * `message` como texto o como lista (validación); cualquier otra forma —un HttpErrorResponse
   * sin cuerpo, una caída de red— se dice en palabras, nunca "[object Object]" ni vacío.
   */
  private motivoDeError(err: unknown): string {
    const e = err as { error?: { message?: unknown }; status?: number } | null;
    const m = e?.error?.message;
    if (typeof m === 'string' && m.trim()) return m.trim();
    if (Array.isArray(m)) {
      const partes = m.filter((x): x is string => typeof x === 'string' && !!x.trim());
      if (partes.length) return partes.join('. ');
    }
    if (e?.status === 0) return 'Sin conexión con el servidor. Intenta de nuevo.';
    return 'El servidor no lo aceptó. Intenta de nuevo o avisa a oficina.';
  }

  inc(line: OrderLine): void {
    const f = this.unitFactorById(line.product_id);
    this.bumpQty(line.product_id, subirEscalon(this.cartQty(line.product_id), f));
  }
  dec(line: OrderLine): void {
    const f = this.unitFactorById(line.product_id);
    this.bumpQty(line.product_id, bajarEscalon(this.cartQty(line.product_id), f));
  }
  /** Conteo del carrito en la unidad activa; crudo en base si no cae en la rejilla. */
  dispCountById(productId: string): number {
    const f = this.unitFactorById(productId);
    const base = this.cartQty(productId);
    return conteoExacto(base, f) ?? base;
  }

  /** Ajuste optimista de cantidad por producto + PATCH debounced. No crea líneas
   *  nuevas (eso es createLine, inmediato). 0 → la línea se quita en el flush. */
  private bumpQty(productId: string, qty: number): void {
    const next = Math.max(0, Math.floor(qty));
    this.pendingQty.update((m) => new Map(m).set(productId, next));
    this.haptic.selection();
    this.scheduleQtyFlush();
  }

  private scheduleQtyFlush(): void {
    if (this.qtyFlushTimer) clearTimeout(this.qtyFlushTimer);
    // [MCP.3.6] 400 ms desde el ÚLTIMO toque: una ráfaga de "+" sale como un solo PUT.
    this.qtyFlushTimer = setTimeout(() => {
      this.qtyFlushTimer = null;
      this.flushQty().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        // Offline: applyLocalBatch ya actualizó cartLines → no recargar.
        next: () => { if (!this.offlineMode()) this.reloadCart(); },
        error: (err) => {
          // El motivo ya quedó pegado a la fila (rowError); el toast es el aviso general.
          this.toast.add({ severity: 'error', summary: 'No se guardó un cambio de cantidad', detail: this.motivoDeError(err), life: 6000 });
          if (!this.offlineMode()) this.reloadCart(); // reconciliar con el server tras el fallo
        },
      });
    }, 400);
  }

  /**
   * [MCP.3.6] Un PUT/DELETE de cantidad, con su rastro: al volver bien marca la cantidad como
   * confirmada (se suelta cuando el carrito releído la trae); al volver mal la suelta — la fila
   * regresa al valor del servidor — y deja el motivo pegado a la fila. No relanza el error:
   * así un renglón que falla no cancela a los demás del mismo volcado.
   */
  private rastrear(productId: string, qty: number, op$: Observable<unknown>): Observable<{ ok: boolean; err?: unknown }> {
    const soltarSiEs = (m: Map<string, { qty: number; done: boolean }>, done: boolean | null) => {
      const e = m.get(productId);
      if (!e || e.qty !== qty) return m; // ya hay un envío más nuevo de ese producto
      const n = new Map(m);
      if (done == null) n.delete(productId);
      else n.set(productId, { qty, done });
      return n;
    };
    return op$.pipe(
      map(() => {
        this.sentQty.update((m) => soltarSiEs(m, true));
        this.rowError.update((m) => {
          if (!(productId in m)) return m;
          const n = { ...m };
          delete n[productId];
          return n;
        });
        return { ok: true };
      }),
      catchError((err: unknown) => {
        this.sentQty.update((m) => soltarSiEs(m, null));
        this.rowError.update((m) => ({ ...m, [productId]: `No se cambió la cantidad: ${this.motivoDeError(err)}` }));
        this.haptic.notification('error');
        return of({ ok: false, err });
      }),
    );
  }

  /**
   * Aplica las cantidades pendientes contra las líneas reales: 0 → quitar,
   * distinto → actualizar. Completa cuando el server quedó sincronizado (o de
   * inmediato si no había nada). NO recarga: eso lo decide el caller. Offline →
   * aplica al draft local Dexie en vez de pegar al backend.
   */
  private flushQty(): Observable<void> {
    if (this.qtyFlushTimer) { clearTimeout(this.qtyFlushTimer); this.qtyFlushTimer = null; }
    // [MCP.3.6] Uno a la vez: si hay un volcado en vuelo, se espera a que vuelva (bien o mal) y
    // entonces se manda lo que se juntó mientras tanto. Dos PUT al mismo renglón en paralelo
    // pueden llegar al servidor en cualquier orden y dejar guardada la cantidad vieja.
    if (this.flushEnVuelo) {
      return this.flushEnVuelo.pipe(
        catchError(() => of(void 0)),
        switchMap(() => this.flushQty()),
      );
    }
    const orderId = this.cartOrderId();
    const pend = this.pendingQty();
    // [MCP.3.5] Sin pedido todavía pero con un renglón creándose: el pedido está naciendo en
    // esa misma llamada. Lo pendiente NO se borra — es la cantidad que el vendedor está viendo
    // — y lo manda el flush que agenda createLine al terminar. Borrarlo dejaba la fila en 0.
    if (!orderId && Object.values(this.adding()).some(Boolean)) return of(void 0);
    if (!orderId || pend.size === 0) { this.pendingQty.set(new Map()); return of(void 0); }
    if (this.offlineMode()) {
      const entries = Array.from(pend);
      this.pendingQty.set(new Map());
      return from(this.applyLocalBatch(entries)).pipe(map(() => void 0));
    }
    const lines = this.cartLines();
    const ops: Observable<{ ok: boolean; err?: unknown }>[] = [];
    const enviar = (productId: string, qty: number, op$: Observable<unknown>) => {
      // Lo mandado se sigue mostrando hasta que el carrito releído lo traiga (ver `sentQty`).
      this.sentQty.update((m) => new Map(m).set(productId, { qty, done: false }));
      ops.push(this.rastrear(productId, qty, op$));
    };
    // [VTK.5] Un producto cuyo renglón todavía se está creando no tiene línea a la cual mandarle
    // el cambio: su cantidad pendiente se CONSERVA (no se tira) y se manda en el flush que corre
    // cuando la creación termina.
    const conservar = new Map<string, number>();
    const enCreacion = this.adding();
    for (const [productId, qty] of pend) {
      const line = lines.find((l) => l.product_id === productId);
      if (!line && enCreacion[productId]) { conservar.set(productId, qty); continue; }
      // [MCP.3.6] Contra lo que el servidor YA tiene: si hubo un envío confirmado que el carrito
      // aún no relee, ése es el valor vigente (comparar contra el renglón viejo dejaba sin
      // mandar un regreso al número anterior).
      const vigente = this.sentQty().get(productId)?.qty ?? Number(line?.quantity);
      if (!line || vigente === qty) continue;
      if (qty <= 0) {
        enviar(productId, 0, this.api.removeLine(orderId, line.id));
        continue;
      }
      // [VU.4] Mismo contrato que createLine: con sello se manda el CONTEO en la unidad
      // activa, no la base. Sin esto, cada toque del stepper borraba el sello que puso
      // `addLine` (el backend lo limpia cuando la cantidad cambia sin unidad declarada),
      // así que la procedencia no sobrevivía a la primera interacción.
      const sello = this.selloDeId(productId);
      const enviada = sello ? conteoExacto(qty, sello.qty_factor) : null;
      enviar(
        productId,
        qty,
        enviada != null && sello
          ? this.api.updateLine(orderId, line.id, enviada, sello)
          : this.api.updateLine(orderId, line.id, qty),
      );
    }
    this.pendingQty.set(conservar);
    if (!ops.length) return of(void 0);
    // Se suscribe YA (no cuando alguien se suscriba): el volcado en vuelo es un hecho, y el
    // siguiente lo espera por `flushEnVuelo`. Termina con error si algún renglón falló, para que
    // `submit()` no agende sobre una cantidad que el servidor no aceptó.
    const vuelo$ = new ReplaySubject<void>(1);
    this.flushEnVuelo = vuelo$;
    forkJoin(ops)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        this.flushEnVuelo = null;
        const falla = res.find((r) => !r.ok);
        if (falla) vuelo$.error(falla.err);
        else { vuelo$.next(); vuelo$.complete(); }
      });
    return vuelo$.asObservable();
  }

  /** Offline: fija la cantidad de un producto en el draft local (0 = quitar). */
  private async setLocalQty(productId: string, qty: number): Promise<void> {
    await this.applyLocalBatch([[productId, qty]]);
  }

  /** Offline: aplica un lote de cantidades al draft local Dexie y re-deriva cartLines. */
  private async applyLocalBatch(entries: Array<[string, number]>): Promise<void> {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    const draft = await this.offlineApi.getById(orderId);
    if (!draft) return;
    const byId = this.byIdMap();
    const lines: OfflinePedidoLine[] = [...draft.lines];
    for (const [productId, qty] of entries) {
      const idx = lines.findIndex((l) => l.product_id === productId);
      if (qty <= 0) {
        if (idx >= 0) lines.splice(idx, 1);
      } else if (idx >= 0) {
        lines[idx] = { ...lines[idx], quantity: qty };
      } else {
        const p = byId.get(productId);
        if (p) lines.push(this.offlineApi.buildLine(p, qty));
      }
    }
    await this.offlineApi.setLines(orderId, lines);
    this.cartLines.set(this.offlineApi.toOrderLines({ ...draft, lines }));
  }

  removeLine(line: OrderLine): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.pendingQty.update((m) => { const n = new Map(m); n.delete(line.product_id); return n; });
    this.sentQty.update((m) => { const n = new Map(m); n.delete(line.product_id); return n; });
    if (this.offlineMode()) { void this.setLocalQty(line.product_id, 0); return; }
    this.api.removeLine(orderId, line.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.reloadCart(),
      error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
    });
  }

  // ─── Pedido sugerido (pre-cargado) ───

  /** Opt-in: el vendedor acepta cargar la canasta predicha. */
  usePrefill(): void {
    this.prefillPredicted();
  }

  /** Pre-carga el draft con la canasta predicha en 1 request. Best-effort. */
  private prefillPredicted(): void {
    const lines = this.predictedLines();
    const c = this.customer();
    if (!lines.length || !c || !this.orderWarehouseId()) return;
    if (this.offlineMode()) {
      const orderId = this.cartOrderId();
      if (!orderId) return;
      this.prefilling.set(true);
      const byId = this.byIdMap();
      const offlineLines = lines
        .map((l) => { const p = byId.get(l.product_id); return p ? this.offlineApi.buildLine(p, l.quantity) : null; })
        .filter((x): x is OfflinePedidoLine => !!x);
      void this.offlineApi
        .setLines(orderId, offlineLines)
        .then(() => this.offlineApi.getById(orderId))
        .then((draft) => {
          if (draft) this.cartLines.set(this.offlineApi.toOrderLines(draft));
          this.prefilling.set(false);
          this.prefilled.set(true);
        })
        .catch(() => this.prefilling.set(false));
      return;
    }
    this.prefilling.set(true);
    this.api
      .ensureDraftForCustomer(c.id, this.orderWarehouseId(), 'route')
      .pipe(
        switchMap((draft) => { this.cartOrderId.set(draft.id); return this.api.replaceLines(draft.id, lines); }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.prefilling.set(false);
          this.prefilled.set(true);
          this.reloadCart();
        },
        error: () => {
          // best-effort: si falla, queda el pad vacío (habituales/catálogo) sin romper.
          this.prefilling.set(false);
        },
      });
  }

  /** Vacía el pedido sugerido para armar desde cero. */
  clearOrder(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.confirmSvc.confirm({
      header: 'Vaciar pedido',
      message: '¿Vaciar el pedido sugerido y empezar de cero?',
      icon: 'pi pi-eraser',
      acceptLabel: 'Vaciar', rejectLabel: 'No',
      accept: () => {
        if (this.offlineMode()) {
          void this.offlineApi.setLines(orderId, []).then(() => {
            this.prefilled.set(false); this.cartLines.set([]); this.cartOpen.set(false);
          });
          return;
        }
        this.api.replaceLines(orderId, []).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => { this.prefilled.set(false); this.reloadCart(); },
          error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || err?.message }),
        });
      },
    });
  }

  /**
   * Agendar. Antes de preguntar, VUELCA los ajustes pendientes y recarga el pedido:
   * el mensaje del diálogo es un string que se arma una sola vez, así que si se
   * construía con `cartTotal()` en caliente podía anunciar un monto y agendar otro.
   *
   * Pasaba de verdad: la cantidad del carrito es optimista (se ve al instante) pero
   * el dinero lo calcula el servidor (tiers de volumen, promociones) y solo llega con
   * la recarga, 500 ms después. Tocar "+" y enseguida "Agendar" mostraba la cantidad
   * nueva con el total viejo, y ese total viejo quedaba congelado en el diálogo
   * mientras el `place` se iba con la cantidad nueva.
   *
   * No se recalcula el total en el front a propósito: los tiers y las promos los
   * resuelve el backend, y un número inventado acá sería peor que esperar.
   */
  submit(): void {
    const orderId = this.cartOrderId();
    if (!orderId || this.submitting() || this.settling()) return;
    if (!this.requestedDate) {
      this.toast.add({ severity: 'warn', summary: 'Elige la fecha de entrega' });
      return;
    }
    // Sin ajustes en vuelo, el total ya es el del servidor → se pregunta directo.
    // [MCP.3.6] Un volcado en vuelo o una cantidad mandada y aún no releída también cuentan.
    if (this.pendingQty().size === 0 && this.sentQty().size === 0 && !this.flushEnVuelo) {
      this.askAndPlace(orderId);
      return;
    }
    this.settling.set(true);
    this.flushQty()
      .pipe(
        switchMap(() => this.reloadCart$()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.settling.set(false);
          if (!this.cartLines().length) {
            this.toast.add({ severity: 'warn', summary: 'El pedido quedó vacío' });
            return;
          }
          this.askAndPlace(orderId);
        },
        error: (err) => {
          this.settling.set(false);
          this.onError(err);
        },
      });
  }

  /** Pregunta con el total YA firme y, si aceptan, lo agenda. */
  private askAndPlace(orderId: string): void {
    const pretty = new Date(this.requestedDate + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    const corrigiendo = this.isEditing();
    this.confirmSvc.confirm({
      header: corrigiendo ? 'Guardar cambios' : 'Agendar pedido',
      message: corrigiendo
        ? `¿Guardar ${this.editingCode() || 'el pedido'} en ${this.fmtMoney(this.cartTotal())} para entrega el ${pretty}?`
        : `¿Agendar ${this.fmtMoney(this.cartTotal())} para entrega el ${pretty}?`,
      icon: corrigiendo ? 'pi pi-pencil' : 'pi pi-calendar',
      acceptLabel: corrigiendo ? 'Guardar' : 'Agendar', rejectLabel: 'Cancelar',
      accept: () => {
        this.submitting.set(true);
        // `flushQty` ya corrió en submit() (y el diálogo no se abre hasta que el
        // total quedó firme), pero se vuelve a llamar por si el vendedor movió una
        // cantidad con el diálogo abierto: es no-op cuando no hay nada pendiente.
        if (this.offlineMode()) {
          this.flushQty()
            .pipe(
              switchMap(() => from(this.offlineApi.confirm(orderId, this.requestedDate))),
              takeUntilDestroyed(this.destroyRef),
            )
            .subscribe({ next: () => this.onDoneOffline(), error: (err) => this.onError(err) });
          return;
        }
        // Online: 1 request atómico e idempotente: draft → confirmed con la fecha
        // de entrega (reemplaza updateDraftHeader→confirm→approve, que podía
        // quedar a medias).
        this.flushQty()
          .pipe(
            switchMap(() => this.api.placeOrder(orderId, { requested_delivery_date: this.requestedDate })),
            takeUntilDestroyed(this.destroyRef),
          )
          .subscribe({
            next: (o) => this.onDone(o),
            error: (err) => this.onError(err),
          });
      },
    });
  }

  // ─── Acciones de la visita (···) ───

  /** Capturar exhibición: foto del punto de venta (customer-driven). */
  goCaptureExhibit(): void {
    this.actionsOpen.set(false);
    this.router.navigate(['/vendor/capture'], {
      queryParams: { customerId: this.customerId, customerName: this.customer()?.name },
    });
  }
  /** Abre el sheet de resultado de visita. */
  openFinish(): void {
    this.actionsOpen.set(false);
    this.finishOutcome.set(null);
    this.noSaleReason.set(null);
    this.finishOpen.set(true);
  }
  /** Cierra la visita con el resultado elegido y vuelve a Mi ruta. */
  confirmFinish(): void {
    if (!this.canFinish() || this.finishing()) return;
    const outcome = this.finishOutcome();
    this.finishing.set(true);
    this.api
      .finishVisit(this.customerId, {
        had_ticket: outcome === 'venta',
        no_sale_reason: outcome === 'no_venta' ? this.noSaleReason() || undefined : undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.finishing.set(false);
          this.finishOpen.set(false);
          this.haptic.notification('success');
          this.toast.add({ severity: 'success', summary: 'Visita finalizada' });
          this.router.navigate(['/vendor/route-home']);
        },
        error: (err) => {
          this.finishing.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo terminar', detail: err?.error?.message || err?.message });
        },
      });
  }

  private onDone(o: { code?: string; total?: number | string; group_parts?: number } | null): void {
    this.submitting.set(false);
    const c = this.customer();
    // Corrección: el pedido ya existía y ya se avisó al cliente cuando se agendó.
    // Vuelve a "Por entregar", que es de donde salió, en vez de a la pantalla de
    // "pedido nuevo tomado" con su invitación a mandar WhatsApp otra vez.
    if (this.isEditing()) {
      this.haptic.notification('success');
      this.toast.add({ severity: 'success', summary: 'Pedido corregido', detail: o?.code || this.editingCode() || '' });
      this.router.navigate(['/vendor/pending']);
      return;
    }
    // [MCP.3.13] Con partes, el total que devuelve place() es sólo el de la principal: para el
    // vendedor y el cliente es UN pedido, así que se muestra el del carrito completo.
    const agrupado = !!o?.group_parts && o.group_parts > 1;
    this.router.navigate(['/vendor/order-success'], {
      queryParams: {
        code: o?.code || '',
        total: agrupado ? this.cartTotal() : (o?.total ?? this.cartTotal()),
        units: this.cartUnitsTotal(),
        name: c?.name || '',
        wa: c?.whatsapp || '',
        date: this.requestedDate,
        customer: c?.id || '',
        ...(agrupado ? { surte: (this.surteEn() ?? []).map((g) => g.label).join(',') } : {}),
      },
    });
  }

  /** Confirmación offline: el pedido quedó encolado; se envía al reconectar. */
  private onDoneOffline(): void {
    this.submitting.set(false);
    this.haptic.notification('success');
    const c = this.customer();
    this.router.navigate(['/vendor/order-success'], {
      queryParams: {
        code: '',
        total: this.cartTotal(),
        units: this.cartUnitsTotal(),
        name: c?.name || '',
        wa: c?.whatsapp || '',
        date: this.requestedDate,
        customer: c?.id || '',
        offline: '1',
      },
    });
  }
  private onError(err: any): void {
    this.submitting.set(false);
    this.haptic.notification('error');
    this.toast.add({ severity: 'error', summary: 'No se pudo completar', detail: err?.error?.message || err?.message || 'Intenta de nuevo.' });
  }

  cancelDraft(): void {
    const orderId = this.cartOrderId();
    if (!orderId) return;
    this.confirmSvc.confirm({
      // Corrigiendo, esto NO cancela un borrador suelto: cancela un pedido que el
      // cliente ya tenía agendado. Tiene que decirlo.
      message: this.isEditing()
        ? `¿Cancelar ${this.editingCode() || 'el pedido'}? Ya estaba agendado con el cliente.`
        : '¿Cancelar este borrador?',
      header: 'Cancelar pedido',
      icon: 'pi pi-trash',
      accept: () => {
        if (this.offlineMode()) {
          void this.offlineApi.cancel(orderId).then(() => {
            this.cartLines.set([]);
            this.cartOrderId.set(null);
            this.cartOpen.set(false);
            this.toast.add({ severity: 'info', summary: 'Borrador cancelado' });
          });
          return;
        }
        this.api.cancel(orderId, 'Cancelado por el vendedor').subscribe({
          next: () => {
            this.cartLines.set([]);
            this.cartOrderId.set(null);
            this.cartOpen.set(false);
            this.toast.add({ severity: 'info', summary: 'Borrador cancelado' });
          },
          error: (err) => this.toast.add({ severity: 'error', summary: 'Error', detail: err.error?.message || err.message }),
        });
      },
    });
  }

  productNameById(id: string): string {
    return this.prices().find((p) => p.product_id === id)?.product_name || id.slice(0, 8);
  }
  /**
   * Costo NETO (sin IVA) del producto. `cost_with_tax` (ERP costo_civa) viene
   * CON IVA; el precio es pre-IVA → para comparar en la misma base le quitamos
   * el IVA (`tax_rate`). Null si el ERP no trajo costo.
   */
  private netCost(p: PriceRow): number | null {
    const gross = p.cost_with_tax == null ? null : Number(p.cost_with_tax);
    if (gross == null || gross <= 0) return null;
    return gross / (1 + (Number(p.tax_rate) || 0));
  }
  /** Costo neto del producto por id (del catálogo ya cargado). */
  productCostById(id: string): number | null {
    const p = this.prices().find((x) => x.product_id === id);
    return p ? this.netCost(p) : null;
  }
  /** Precio base (lista del cliente, min 1) del producto según el catálogo cargado. */
  private basePriceById(productId: string): number | null {
    const p = this.byIdMap().get(productId);
    const v = p ? Number(p.price) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * Info de mayoreo de una línea del carrito: null si la línea NO trae descuento
   * por cantidad (unit_price >= precio base). Cuando el resolver aplicó un tier de
   * volumen, `unit_price` viene por debajo del base → mostramos el precio nuevo y
   * cuánto se ahorra (por SKU). Offline el precio es el snapshot base → sin badge.
   */
  mayoreoInfo(
    l: OrderLine,
  ): { unit: number; base: number; savedUnit: number; pct: number; savedTotal: number } | null {
    // [VTK.3] Renglón cobrado con el motor de cotizaciones: se compara contra el precio de LISTA
    // de su misma unidad en Kepler (no contra la pieza: un paquete a precio de lista ya es más
    // barato por pieza y eso no es mayoreo), con el total de Kepler (con impuestos). Comparar
    // `unit_price` (sin impuesto) contra el precio con impuesto marcaba mayoreo en TODO renglón.
    const p = this.byIdMap().get(l.product_id);
    if (l.erp_gross_total != null && p?.rungs?.length) {
      const qtyBase = Number(l.quantity) || 0;
      const f = Number(l.qty_factor) > 0 ? Number(l.qty_factor) : 1;
      const rung = p.rungs.find((r) => r.factor === f) ?? p.rungs.find((r) => r.factor === 1);
      if (!rung || !(qtyBase > 0)) return null;
      const qtyRung = qtyBase / rung.factor;
      const lista = rung.price * qtyRung;
      const real = Number(l.erp_gross_total);
      if (!(lista > 0) || !Number.isFinite(real) || real >= lista * 0.999) return null;
      const unitReal = real / qtyRung;
      return {
        unit: unitReal,
        base: rung.price,
        savedUnit: rung.price - unitReal,
        pct: Math.round(((rung.price - unitReal) / rung.price) * 100),
        savedTotal: +(lista - real).toFixed(2),
      };
    }
    const base = this.basePriceById(l.product_id);
    const unit = Number(l.unit_price);
    if (base == null || !Number.isFinite(unit) || unit <= 0) return null;
    if (unit >= base * 0.999) return null; // sin descuento real por cantidad
    const savedUnit = base - unit;
    const qty = Number(l.quantity) || 0;
    return {
      unit,
      base,
      savedUnit,
      pct: Math.round((savedUnit / base) * 100),
      savedTotal: +(savedUnit * qty).toFixed(2),
    };
  }
  /**
   * [MCP.3.6] Precio de mayoreo de la tarjeta, como REFERENCIA, en la unidad activa:
   * `from` = desde cuántas unidades aplica · `unit` = precio por unidad en mayoreo.
   * Null si el SKU no tiene un mayoreo real (sin quiebre, o no más barato que el normal):
   * la tarjeta muestra entonces sólo el precio normal, nunca un «$0.00».
   *
   * Sale de la MISMA fuente con la que cobra el servidor: con escalera de la sucursal, el
   * volumen de ESE peldaño en Kepler (`rungs[].volume_*`, el que usa el motor de
   * cotizaciones al guardar el renglón); sin escalera, los quiebres `tiers`
   * (analytics.product_volume_tiers, los mismos que lee `resolvePriceForQty`).
   * El celular NO calcula el subtotal con él: el subtotal lo pone el servidor.
   */
  mayoreoDe(p: PriceRow): { from: number; unit: number } | null {
    const rung = this.rungOf(p);
    if (rung) {
      if (rung.volume_min_qty == null || rung.volume_price == null) return null;
      const vp = Number(rung.volume_price);
      if (!(vp > 0) || !(Number(rung.price) > 0) || vp >= Number(rung.price) * 0.999) return null;
      return { from: Math.max(1, Number(rung.volume_min_qty) || 1), unit: vp };
    }
    const tiers = p.tiers;
    const base = Number(p.price);
    if (!tiers?.length || !Number.isFinite(base) || base <= 0) return null;
    const first = tiers.reduce((a, b) => (Number(b.min_qty) < Number(a.min_qty) ? b : a));
    const fromBase = Math.max(2, Number(first.min_qty) || 0);
    const unitBase = Number(first.price);
    if (!Number.isFinite(unitBase) || unitBase <= 0 || unitBase >= base * 0.999) return null;
    // El quiebre viaja en unidad base: se dice en la unidad que la fila está usando.
    const f = this.unitFactor(p);
    return { from: Math.max(1, Math.ceil(fromBase / f)), unit: unitBase * f };
  }

  /**
   * [MCP.3.6] ¿El servidor ya cobra mayoreo en el renglón de este producto? Sólo se dice que
   * sí cuando el renglón guardado lo trae (mismo criterio que el carrito: `mayoreoInfo`) y no
   * hay un cambio de cantidad sin confirmar: mientras tanto el precio que aplica no se sabe,
   * y no se adivina en el celular.
   */
  mayoreoAplicado(productId: string): boolean {
    if (this.pendingQty().has(productId) || this.sentQty().has(productId)) return false;
    return this.cartLines().some((l) => l.product_id === productId && this.mayoreoInfo(l) != null);
  }

  // ───── Medidas de venta (PZA/PAQ/CJA) ─────
  // La línea SIEMPRE se guarda en unidad base; la medida es capa de entrada/display.
  // Default = la unidad más chica (units[0]); [VTK.4]. Antes era PAQ si el SKU lo tenía.
  //
  // La aritmética vive en libs/ui-web (order/qty-units.ts), con sus candados y sus pruebas
  // negativas. La invariante que sostiene todo: lo que la fila MUESTRA, por el
  // factor, es exactamente lo que el pedido PIDE. Cuando no se puede cumplir, la
  // fila lo declara en unidad base en vez de redondear (ADR-056).

  /** Unidad seleccionada por producto (label). Vacío = usar el default. */
  readonly unitSel = signal<Record<string, string>>({});

  /**
   * Escalera de medidas YA saneada, por producto. Se calcula una vez por catálogo
   * y no en cada ciclo de detección: la fila la consulta en cada binding y el pad
   * puede traer cientos de renglones.
   */
  private readonly unitsById = computed(() => {
    const m = new Map<string, Presentacion[]>();
    for (const p of this.prices()) m.set(p.product_id, escalera(p.units));
    return m;
  });
  /** Presentaciones ofrecidas para el SKU (sin rótulos repetidos ni factores basura). */
  unitsOf(p: PriceRow): Presentacion[] {
    return this.unitsById().get(p.product_id) ?? escalera(p.units);
  }

  /**
   * [VTK.4] Por defecto, la unidad MÁS CHICA (decisión de Francisco, 2026-10-04: el cliente de
   * ruta compra poco y la sugerencia va de menor a mayor). La escalera ya viene ordenada de menor
   * a mayor, así que es la primera. Antes era PAQ si existía.
   */
  private defaultUnit(p: PriceRow): Presentacion | null {
    const us = this.unitsOf(p);
    if (!us.length) return null;
    return us[0];
  }

  /**
   * [VTK.3] El peldaño de Kepler de la unidad activa (precio de lista + mayoreo en ESA unidad).
   * Null si el catálogo no trajo escalera de la sucursal: entonces se usa `price × factor`.
   */
  private rungOf(p: PriceRow): NonNullable<PriceRow['rungs']>[number] | null {
    const sel = this.selectedUnit(p);
    if (!sel || !p.rungs?.length) return null;
    const f = factorDe(sel);
    return p.rungs.find((r) => r.factor === f) ?? null;
  }
  /** Presentación activa del producto (default PAQ). Null si el SKU no tiene medidas. */
  selectedUnit(p: PriceRow): Presentacion | null {
    const us = this.unitsOf(p);
    if (!us.length) return null;
    const sel = this.unitSel()[p.product_id];
    return (sel ? us.find((u) => u.unit === sel) : null) ?? this.defaultUnit(p);
  }
  /** Factor a unidad base de la presentación activa (1 si no hay medidas). */
  unitFactor(p: PriceRow): number {
    return factorDe(this.selectedUnit(p));
  }
  /** Factor por product_id (para el carrito, que trae OrderLine sin PriceRow). */
  unitFactorById(productId: string): number {
    const p = this.byIdMap().get(productId);
    return p ? this.unitFactor(p) : 1;
  }
  unitLabelById(productId: string): string {
    const p = this.byIdMap().get(productId);
    if (!p) return '';
    // Fuera de rejilla la fila habla en unidad base: el rótulo tiene que acompañar.
    return conteoExacto(this.cartQty(productId), this.unitFactor(p)) == null
      ? this.baseUnitLabel(p)
      : this.selectedUnit(p)?.unit || '';
  }
  /** Rótulo de la unidad base del SKU (el primer peldaño de la escalera). */
  private baseUnitLabel(p: PriceRow): string {
    return this.unitsOf(p)[0]?.unit || '';
  }

  /**
   * [VU.4] El sello con el que se manda una cantidad al servidor: en qué unidad la capturó
   * el vendedor y con qué factor la mostró la pantalla. Con él, `quantity` viaja **en esa
   * unidad** y convierte el servidor (que además contrasta el factor contra el ERP y frena
   * el desacuerdo). Antes no se mandaba nada: la pantalla convertía a base y la línea
   * quedaba sin decir si esas 116 piezas eran "2 cajas" o "116 piezas sueltas".
   *
   * Devuelve null cuando no hay nada que declarar:
   *  - el SKU no publica escalera de medidas, o
   *  - la fila está fuera de rejilla y habla en unidad base cruda (`offGrid`): el número
   *    tecleado no está en la presentación elegida, así que sellarlo con ella sería mentir.
   * En ambos casos la cantidad va en base, como siempre.
   */
  private selloDe(p: PriceRow): { qty_unit: string; qty_factor: number } | null {
    if (this.offGrid(p)) return null;
    const sel = this.selectedUnit(p);
    const unit = rotuloCrudo(sel);
    if (!sel || !unit) return null;
    return { qty_unit: unit, qty_factor: factorDe(sel) };
  }

  /** Igual que `selloDe` pero por product_id (el carrito trae OrderLine, no PriceRow). */
  private selloDeId(productId: string): { qty_unit: string; qty_factor: number } | null {
    const p = this.byIdMap().get(productId);
    return p ? this.selloDe(p) : null;
  }
  /** ¿Mostrar el selector? Solo si el SKU ofrece más de una presentación DISTINTA. */
  hasUnitChoice(p: PriceRow): boolean {
    return this.unitsOf(p).length > 1;
  }
  /**
   * Cambia la presentación de captura. Si ya hay cantidad, se acomoda a la rejilla
   * de la medida nueva: el vendedor eligió hablar en cajas, así que la fila pasa a
   * cajas completas y el número que ve vuelve a ser el que se pide.
   */
  setUnit(p: PriceRow, unit: string): void {
    const destino = this.unitsOf(p).find((u) => u.unit === unit);
    if (!destino) return;
    this.unitSel.update((m) => ({ ...m, [p.product_id]: unit }));
    const base = this.cartQty(p.product_id);
    if (base <= 0) return;
    const ajustada = ajustarARejilla(base, factorDe(destino), p.min_qty || 1);
    if (ajustada !== base) this.bumpQty(p.product_id, ajustada);
  }
  /**
   * Cantidad mostrada en la fila, en la unidad activa. null = la cantidad no cae
   * en la rejilla (llegó de voz, de la canasta predicha o de un pedido viejo) y NO
   * se redondea: la fila muestra el crudo en unidad base. Antes esto era
   * Math.round(base/factor) y publicaba 1 sobre un pedido de 5, o 0 sobre uno de 3.
   */
  dispCount(p: PriceRow): number {
    const f = this.unitFactor(p);
    const base = this.cartQty(p.product_id);
    return conteoExacto(base, f) ?? base;
  }
  /** ¿La fila está hablando en unidad base porque la cantidad no cae en la rejilla? */
  offGrid(p: PriceRow): boolean {
    return this.unitFactor(p) > 1 && conteoExacto(this.cartQty(p.product_id), this.unitFactor(p)) == null;
  }
  /** Rótulo de lo que cuenta el stepper de la fila AHORA (no lo que está elegido). */
  rowUnitLabel(p: PriceRow): string {
    return this.offGrid(p) ? this.baseUnitLabel(p) : this.selectedUnit(p)?.unit || '';
  }
  /**
   * Precio mostrado en la unidad activa. [VTK.3] Con escalera de la sucursal es el precio que
   * Kepler tiene para ESA unidad (un paquete de 42029: $131.99), que es lo que cobra el pedido;
   * sin escalera, el de siempre: precio base × factor.
   */
  unitPriceDisplay(p: PriceRow): number {
    const rung = this.rungOf(p);
    return rung ? rung.price : Number(p.price) * this.unitFactor(p);
  }

  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  trackProduct(_: number, p: PriceRow): string { return p.product_id; }
  trackLine(_: number, l: OrderLine): string { return l.id; }

  /**
   * Recarga el pedido y completa cuando `cartLines` ya refleja al servidor. Misma
   * lectura que `reloadCart`, en forma encadenable — la necesita `submit()`, que no
   * puede preguntar el monto hasta que el total sea el firme.
   */
  private reloadCart$(): Observable<void> {
    return new Observable<void>((sub) => {
      this.reloadCart(() => {
        sub.next();
        sub.complete();
      });
    });
  }

  /**
   * ⚠️ `after` se invoca SIEMPRE — también sin pedido y también si la lectura falla.
   * Antes solo corría en el camino feliz: como el único uso era refrescar sugerencias,
   * perderlo no se notaba. Encadenado a `submit()` (reloadCart$) un fallo de red dejaba
   * la pantalla trabada en "Calculando…" sin forma de salir.
   */
  private reloadCart(after?: () => void): void {
    const orderId = this.cartOrderId();
    if (!orderId) { after?.(); return; }
    // [MCP.3.5] Varias lecturas pueden ir en vuelo (crear renglón + flush + otra creación) y
    // la red no garantiza el orden de vuelta: una respuesta vieja que llegaba después de la
    // nueva pisaba el carrito con renglones de antes. Sólo la lectura más reciente escribe;
    // `after` se sigue llamando siempre (ver arriba).
    const seq = ++this.cartReadSeq;
    // [MCP.3.6] Lo que el servidor ya confirmó ANTES de que saliera esta lectura: esta lectura
    // lo trae, así que al aplicarla se puede soltar. Lo que sigue en vuelo NO se suelta.
    const confirmadas = new Map<string, number>();
    for (const [id, e] of this.sentQty()) if (e.done) confirmadas.set(id, e.qty);
    const soltarConfirmadas = () => {
      if (!confirmadas.size) return;
      this.sentQty.update((m) => {
        const n = new Map(m);
        for (const [id, q] of confirmadas) {
          const e = n.get(id);
          if (e && e.done && e.qty === q) n.delete(id);
        }
        return n;
      });
    };
    if (this.offlineMode()) {
      void this.offlineApi
        .getById(orderId)
        .then((draft) => {
          if (seq !== this.cartReadSeq) return;
          const lines = draft ? this.offlineApi.toOrderLines(draft) : [];
          this.cartLines.set(lines);
          if (!lines.length) this.cartOpen.set(false);
        })
        .catch(() => void 0)
        .finally(() => after?.());
      return;
    }
    this.api.orderById(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (full) => {
        if (seq === this.cartReadSeq) {
          const lines = full.lines || [];
          this.cartLines.set(lines);
          soltarConfirmadas();
          if (!lines.length) this.cartOpen.set(false); // se vació → cerrar el sheet
        }
        after?.();
      },
      error: () => {
        // [MCP.3.5] Antes fallaba en silencio y el carrito se quedaba con lo de antes sin
        // decirlo. Sólo avisa la lectura vigente: una vieja que falla ya fue reemplazada.
        if (seq === this.cartReadSeq) {
          this.toast.add({ severity: 'warn', summary: 'No se pudo actualizar el pedido', detail: 'Revisa la conexión. Lo que ves puede no ser lo último.', life: 5000 });
        }
        after?.();
      },
    });
  }

  fmtMoney(n: unknown): string {
    return this.money.format(Number(n) || 0);
  }
}
