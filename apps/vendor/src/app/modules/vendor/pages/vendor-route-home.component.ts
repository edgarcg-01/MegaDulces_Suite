import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
  DOCUMENT
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError, timeout } from 'rxjs';
import type { SellerRouteDay } from '@megadulces/contracts';
import { VendorService, HomeCustomer, NearbyCustomer, DayPickState } from '../vendor.service';
import { RouteDayService, horaMx } from '../route-day.service';
import { Order } from '../../portal/portal.service';
import { GeolocationService } from '../../../core/services/geolocation.service';
import { AuthService } from '../../../core/services/auth.service';
import { MX_TZ } from '../../../core/utils/mx-date';
import { VendorArrivalCardComponent } from '../components/vendor-arrival-card.component';
import { VendorNoSaleSheetComponent } from '../components/vendor-no-sale-sheet.component';
import { ArrivalResult, NoSaleKey, RecentFix, VisitProtocolService } from '../visit-protocol';

/** [MCP.3.7] Lo que se dice junto a «Visita registrada»: a cuántos metros, o por qué no se sabe. */
export function arrivalDetail(res: ArrivalResult | null | undefined): string {
  const loc = res?.location;
  if (loc?.conflict) return ` · ubicación no guardada: se encima con ${loc.conflict.name}`;
  if (loc?.location_set) return ' · se guardó la ubicación del cliente';
  if (res?.distance_m != null) return ` · a ${res.distance_m} m`;
  return ' · sin ubicación para medir la distancia';
}

/**
 * Home "Mi ruta" — única pantalla del vendedor (rediseño Mercado mobile-first).
 * Hero full-bleed con anillo de progreso + KPIs del día, cartera en orden de
 * visita con riel de estado, FAB sunset y un
 * bottom-sheet por cliente con la acción primaria destacada.
 */
@Component({
  selector: 'app-vendor-route-home',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    CardModule,
    SkeletonModule,
    InputTextModule,
    ButtonModule,
    VendorArrivalCardComponent,
    VendorNoSaleSheetComponent,
  ],
  template: `
    <!-- [MCP.3.6] Primero se sabe si la ruta de hoy está iniciada; un error NUNCA se lee como sin iniciar. -->
    @if (routeDayStatus() === 'loading') {
      <div class="rd-loading" role="status" aria-live="polite">
        <span class="sr-only">Cargando tu ruta</span>
        <p-skeleton height="500px"></p-skeleton>
      </div>
    } @else if (showStart()) {
      <section class="start" aria-labelledby="start-title">
        <h1 id="start-title">{{ greeting() }}</h1>
        <p class="start-date">{{ todayLong }}</p>
        <button
          type="button"
          class="start-btn"
          [disabled]="starting()"
          (click)="startRoute()"
          >
          <i class="pi" [ngClass]="starting() ? 'pi-spin pi-spinner' : 'pi-play'" aria-hidden="true"></i>
          {{ starting() ? 'Iniciando…' : 'Iniciar ruta' }}
        </button>
        <p class="start-note">Al iniciar se registra la hora. Al finalizar, al surtidor le llega un solo pedido con todo lo que vendiste.</p>
        @if (startFailed()) {
          <p class="start-err" role="alert">No se pudo iniciar la ruta. Revisa tu conexión e intenta de nuevo.</p>
          <button type="button" class="start-skip" (click)="skipStart.set(true)">Seguir sin iniciar</button>
        }
      </section>
    } @else {
    <!-- Hero full-bleed -->
    @if (!loading() && !showError()) {
      <section class="hero">
        <button
          type="button"
          class="hero-refresh"
          [class.spinning]="refreshing()"
          [disabled]="refreshing()"
          (click)="refresh()"
          aria-label="Actualizar mi ruta"
          >
          <i class="pi pi-refresh"></i>
        </button>
        <div class="hero-main">
          <div class="ring" [style.--pct]="progressPct()">
            <div class="inner"><b>{{ visitedCount() }}</b><span>/{{ customers().length }}</span></div>
          </div>
          <div class="hero-h">
            <div class="ey">Hoy · {{ todayLabel }}</div>
            <h1>{{ routeLabel() || 'Mi ruta' }}</h1>
            <div class="sub">{{ pendingVisits() }} por visitar</div>
            @if (dayPick()?.can_pick) {
              <a class="change-route" routerLink="/vendor/route-pick">
                <i class="pi pi-arrow-right-arrow-left" aria-hidden="true"></i>
                {{ dayPick()?.current ? 'Escogida para hoy · Cambiar ruta' : 'Cambiar ruta' }}
              </a>
            }
          </div>
        </div>
        @if (customers().length > 0) {
          <div class="kpis">
            <div class="kpi"><div class="v">{{ pedidosHoy() }}</div><div class="l">Pedidos</div></div>
            <div class="kpi hl"><div class="v">{{ fmtMoney(vendidoHoy()) }}</div><div class="l">Vendido</div></div>
            <div class="kpi"><div class="v">{{ porEntregar() }}</div><div class="l">Entregar</div></div>
          </div>
        }
      </section>
    }
    
    <div class="body-pad">
      <!-- [MCP.3.6] Estado de la ruta del día -->
      @if (routeDayStatus() === 'error') {
        <div class="rd-line rd-warn" role="status">
          <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
          <span class="rd-text">No pudimos saber si tu ruta está iniciada.</span>
          <button type="button" class="rd-act" (click)="loadRouteDay(true)">Reintentar</button>
        </div>
      } @else if (routeDay()?.state === 'en_ruta') {
        <div class="rd-line rd-live">
          <span class="rd-dot" aria-hidden="true"></span>
          <span class="rd-text">En curso desde <b>{{ startedAt() }}</b></span>
        </div>
      } @else if (routeDay()?.state === 'finalizada') {
        <div class="rd-line">
          <i class="pi pi-check-circle" aria-hidden="true"></i>
          <span class="rd-text">Ruta finalizada a las <b>{{ finishedAt() }}</b>. Si levantas otro pedido, le llega al surtidor como pedido fuera de la ruta.</span>
        </div>
      } @else if (routeDay()?.state === 'sin_iniciar') {
        <div class="rd-line">
          <i class="pi pi-clock" aria-hidden="true"></i>
          <span class="rd-text">Ruta sin iniciar.</span>
          <button type="button" class="rd-act" [disabled]="starting()" (click)="startRoute()">Iniciar ruta</button>
        </div>
      }

      <!-- [MCP.3.7] Llegada: cliente de la ruta a menos de 80 m. «Abrir cliente» registra la visita. -->
      @if (!loading() && detected(); as d) {
        <app-vendor-arrival-card [customer]="d" [pendingLabel]="arrivalPending()" (open)="openSheetById($event.id)" />
      }
    
      @if (!loading() && geoStatus() === 'locating') {
        <div class="geo-hint">
          <i class="pi pi-spin pi-spinner"></i> Buscando tu ubicación…
        </div>
      }
      @if (!loading() && (geoStatus() === 'denied' || (geoStatus() === 'found' && !detected()))) {
        <button
          type="button"
          class="geo-hint retry"
          (click)="detectArrival()"
          >
          <i class="pi pi-map-marker"></i>
          {{ geoStatus() === 'denied' ? 'Activa la ubicación para detectar dónde estás' : 'Ningún cliente cerca · reintentar' }}
        </button>
      }
    
      @if (!loading() && customers().length > 0) {
        <div class="search-bar">
          <span class="search-wrap">
            <i class="pi pi-search"></i>
            <input
              pInputText
              type="search"
              placeholder="Filtrar mi ruta"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
              inputmode="search"
              enterkeyhint="search"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              />
            </span>
            <button type="button" class="add-client" (click)="addCustomer()" aria-label="Agregar cliente nuevo">
              <i class="pi pi-user-plus"></i>
            </button>
          </div>
        }
    
        @if (loading()) {
          <p-skeleton height="500px"></p-skeleton>
        }
    
        <!-- Estado de error de red (distinto del vacío real) -->
        @if (showError()) {
          <p-card>
            <div class="empty">
              <i class="pi pi-cloud"></i>
              <p>No se pudo cargar tu ruta.</p>
              <p class="hint">Revisa tu conexión e intenta de nuevo.</p>
              <button pButton (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Reintentar</span></button>
            </div>
          </p-card>
        }
    
        <!-- Vacío real: sin clientes en la ronda de hoy -->
        @if (showEmpty()) {
          <p-card>
            <div class="empty">
              <i class="pi pi-sitemap"></i>
              <p>No hay clientes en tu ronda de hoy.</p>
              <p class="hint">Agrega un cliente nuevo o pedile a tu supervisor que te asigne rutas.</p>
              <div class="empty-actions">
                <button pButton (click)="addCustomer()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Agregar cliente</span></button>
                <a pButton severity="secondary" [text]="true" routerLink="/vendor/search"><span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Buscar un cliente</span></a>
              </div>
            </div>
          </p-card>
        }
    
        @if (!loading() && customers().length > 0) {
          <div class="list">
            @for (c of filtered(); track trackId(i, c); let i = $index) {
              <button
                class="client"
                [style.animation-delay.ms]="(i > 9 ? 9 : i) * 35"
                [class.visited]="c.visited_today"
                [class.preventa]="!c.visited_today && c.has_preventa_pending"
                (click)="openSheet(c)"
                >
                <span class="seq" [class.ok]="c.visited_today">
                  @if (c.visited_today) {
                    <i class="pi pi-check"></i>
                  }
                  @if (!c.visited_today) {
                    {{ c.visit_sequence ?? '·' }}
                  }
                </span>
                <span class="cbody">
                  <span class="nm">{{ c.name }}</span>
                  <span class="chips">
                    @if (c.has_preventa_pending) {
                      <span class="chip pre">
                        <i class="pi pi-inbox"></i> Preventa {{ fmtMoney(c.pending_total) }}
                      </span>
                    }
                    @if (!c.has_preventa_pending && c.pending_count > 0) {
                      <span class="chip pend">
                        {{ c.pending_count }} por entregar
                      </span>
                    }
                    @if (c.ordered_today) {
                      <span class="chip ok">Pedido hoy</span>
                    }
                  </span>
                </span>
                <i class="pi pi-ellipsis-v more"></i>
              </button>
            }
            @if (filtered().length === 0) {
              <div class="filter-empty">Sin resultados para "{{ search() }}".</div>
            }
          </div>
        }
        <!-- Reserva el alto del dock fijo para que no tape el último cliente -->
        @if (enRuta()) {
          <div class="dock-spacer" aria-hidden="true"></div>
        }
      </div>

      @if (enRuta()) {
        <!-- [MCP.3.6] Finalizar ruta + Pedido, fijos ARRIBA de la barra de abajo (5rem, z-index 10) -->
        <div class="dock">
          <button type="button" class="finish-btn" (click)="goFinish()">
            <i class="pi pi-flag" aria-hidden="true"></i> Finalizar ruta
          </button>
          @if (!loading() && customers().length > 0) {
            <button class="fab docked" (click)="fabOrder()">
              <i class="pi pi-plus"></i> Pedido
            </button>
          }
        </div>
      } @else if (!loading() && customers().length > 0) {
        <!-- FAB: tomar pedido del próximo cliente (zona del pulgar) -->
        <button class="fab" (click)="fabOrder()">
          <i class="pi pi-plus"></i> Pedido
        </button>
      }
    
      <!-- Bottom-sheet de acciones por cliente -->
      @if (sheet(); as c) {
        <div class="sheet-backdrop" [class.closing]="sheetClosing()" (click)="closeSheet()"></div>
        <div
          #sheetEl
          class="sheet"
          [class.closing]="sheetClosing()"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vsheet-title"
          tabindex="-1"
          (keydown)="trapFocus($event)"
          >
          <div class="sheet-handle"></div>
          <div class="sheet-head">
            <span class="av">{{ initials(c.name) }}</span>
            <div>
              <span class="n" id="vsheet-title">{{ c.name }}</span>
              <span class="cd">{{ c.code }}@if (c.sales_route) {
                · {{ c.sales_route }}
              }</span>
            </div>
          </div>
          <button class="sheet-primary" (click)="goOrder(c, 'futuro')">
            <i class="pi pi-shopping-cart"></i> Tomar pedido
          </button>
          @if (c.pending_count > 0) {
            <button class="action" (click)="goPending()">
              <i class="pi pi-inbox"></i>
              <span class="lbl">Ver pedido pendiente</span>
              <span class="badge">{{ fmtMoney(c.pending_total) }}</span>
            </button>
          }
          <!-- [MCP.3.7] Abrir al cliente ya registró la llegada; aquí se ve si quedó y se cierra sin pedido. -->
          <div class="visit-line" role="status" aria-live="polite">
            @switch (arrival().state) {
              @case ('saving') { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Registrando visita… }
              @case ('ok') {
                <i class="pi pi-check-circle ok" aria-hidden="true"></i>
                Visita registrada {{ arrival().at }}{{ arrival().detail }}
              }
              @case ('error') {
                <i class="pi pi-exclamation-circle bad" aria-hidden="true"></i>
                No se pudo registrar la visita.
                <button type="button" class="visit-retry" (click)="registerArrival(c)">Reintentar</button>
              }
            }
          </div>
          <button class="action" [disabled]="arrival().state === 'saving'" (click)="openNoSale(c)">
            <i class="pi pi-ban"></i>
            <span class="lbl">El cliente no pidió nada</span>
          </button>
          <button class="action" (click)="goCapture(c)">
            <i class="pi pi-camera"></i>
            <span class="lbl">Capturar exhibición</span>
          </button>
          @if (c.phone || c.whatsapp) {
            <div class="contact">
              @if (c.phone) {
                <a class="contact-btn" [href]="'tel:' + c.phone"><i class="pi pi-phone"></i> Llamar</a>
              }
              @if (c.whatsapp) {
                <a class="contact-btn wa" [href]="waLink(c.whatsapp)" target="_blank" rel="noopener">
                  <i class="pi pi-whatsapp"></i> WhatsApp
                </a>
              }
            </div>
          }
        </div>
      }

      <!-- [MCP.3.7] «El cliente no pidió nada»: motivo y se cierra la visita sin pedido -->
      @if (noSaleFor(); as ns) {
        <app-vendor-no-sale-sheet
          [customerName]="ns.name"
          [busy]="closingNoSale()"
          (confirm)="confirmNoSale(ns, $event)"
          (cancel)="noSaleFor.set(null)" />
      }
    }
    `,
  styles: [
    `
      :host { display: block; }
      /* full-bleed: escapa el padding 1rem del shell .vendor-main */
      @property --pct { syntax: '<number>'; inherits: false; initial-value: 0; }
      .hero {
        margin: -1rem -1rem 0;
        padding: 1.3rem 1rem 1.4rem;
        background: var(--card-bg);
        color: var(--text-main);
        position: relative;
        overflow: hidden;
        isolation: isolate;
        border-bottom: 1px solid var(--border-color, rgba(40,30,20,0.08));
      }
      /* sheen cálido que deriva lento → superficie viva, no un bloque plano */
      .hero::before {
        content: ''; position: absolute; inset: -45% -15%; z-index: 0; pointer-events: none;
        background:
          radial-gradient(55% 75% at 18% 2%, rgba(255,255,255,0.08), transparent 60%),
          radial-gradient(50% 68% at 96% 112%, rgba(240,90,40,0.07), transparent 58%);
        animation: hero-drift 16s ease-in-out infinite alternate;
      }
      @keyframes hero-drift {
        from { transform: translate3d(-3%, -2%, 0) scale(1.04); }
        to   { transform: translate3d(4%, 3%, 0) scale(1.16); }
      }
      .hero-refresh {
        position: absolute; top: 1rem; right: 1rem; z-index: 2;
        width: 2.1rem; height: 2.1rem; border-radius: 50%;
        border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted);
        display: grid; place-items: center; cursor: pointer;
        transition: transform 0.08s var(--ease, ease);
      }
      .hero-refresh:active { transform: scale(0.92); }
      .hero-refresh:disabled { opacity: 0.6; }
      .hero-refresh i { font-size: 0.9rem; }
      .hero-refresh.spinning i { animation: hero-spin 0.8s linear infinite; }
      @keyframes hero-spin { to { transform: rotate(360deg); } }
      .hero-main { display: flex; align-items: center; gap: 1rem; position: relative; z-index: 1; }
      .ring {
        width: 66px; height: 66px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center;
        background: conic-gradient(var(--action) calc(var(--pct, 0) * 1%), var(--border-color) 0);
        transition: --pct var(--dur-max, 350ms) var(--ease-out, cubic-bezier(0.23,1,0.32,1));
      }
      .ring .inner {
        width: 54px; height: 54px; border-radius: 50%; background: var(--card-bg); display: grid; place-items: center;
        font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; color: var(--text-main);
      }
      .ring .inner b { font-size: 1.2rem; } .ring .inner span { font-size: 0.72rem; color: var(--text-muted); }
      .hero-h { min-width: 0; }
      .hero-h .ey { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
      .hero-h h1 { margin: 2px 0 0; font-size: 1.7rem; font-weight: 800; letter-spacing: -0.025em; line-height: 1.04; color: var(--text-main); }
      .hero-h .sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 2px; }
      .change-route {
        display: inline-flex; align-items: center; gap: 0.35rem; margin-top: 0.45rem;
        min-height: 2rem; padding: 0.25rem 0.7rem; border-radius: 999px;
        border: 1px solid var(--border-color); background: var(--card-bg);
        font-size: var(--fs-xs); font-weight: 700; color: var(--action); text-decoration: none;
      }
      .change-route:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
      .change-route i { font-size: var(--fs-xs); }
      .kpis {
        display: flex; margin-top: 1.2rem; padding-top: 0.95rem; position: relative; z-index: 1;
        border-top: 1px solid var(--border-color, rgba(40,30,20,0.1));
      }
      .kpi { flex: 1; text-align: center; position: relative; }
      .kpi + .kpi::before { content: ''; position: absolute; left: 0; top: 52%; transform: translateY(-50%); height: 56%; width: 1px; background: var(--border-color, rgba(40,30,20,0.1)); }
      .kpi .v { font-family: var(--font-mono); font-weight: 700; font-size: 1.1rem; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--text-main); }
      .kpi.hl .v { font-size: 1.28rem; }
      .kpi .l { font-size: 0.58rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-muted); margin-top: 0.2rem; }

      .body-pad { padding-top: 0.875rem; }

      /* [MCP.3.6] Iniciar ruta */
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .start {
        min-height: 60vh; display: flex; flex-direction: column; justify-content: center; align-items: stretch;
        gap: var(--sp-3); padding: var(--sp-8) var(--sp-2); text-align: center;
      }
      .start h1 { margin: 0; font-size: var(--fs-h1); font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .start-date { margin: 0 0 var(--sp-4); font-size: var(--fs-body); color: var(--text-muted); }
      .start-date::first-letter { text-transform: uppercase; }
      .start-btn {
        min-height: 3.75rem; border: none; border-radius: var(--r-lg); cursor: pointer;
        background: var(--action); color: var(--action-ink);
        font-family: var(--font-body); font-size: var(--fs-lg); font-weight: 700;
        display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
        transition: transform 0.08s var(--ease, ease);
      }
      .start-btn:active:not(:disabled) { transform: scale(0.98); }
      .start-btn:disabled { opacity: 0.7; }
      .start-btn:focus-visible, .start-skip:focus-visible, .rd-act:focus-visible, .finish-btn:focus-visible {
        outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px;
      }
      .start-note { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); line-height: 1.45; color: var(--text-muted); }
      .start-err { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--bad-fg); }
      .start-skip {
        align-self: center; min-height: 2.75rem; padding: 0 var(--sp-4); border: none; background: none; cursor: pointer;
        font-family: var(--font-body); font-size: var(--fs-sm); font-weight: 700; color: var(--text-muted); text-decoration: underline;
      }

      /* [MCP.3.6] Línea del estado de la ruta */
      .rd-line {
        display: flex; align-items: center; gap: var(--sp-2); margin-bottom: 0.875rem;
        padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
        background: var(--surface-ground); border: 1px solid var(--border-color);
        font-size: var(--fs-sm); line-height: 1.35; color: var(--text-main);
      }
      .rd-line > .pi { flex-shrink: 0; color: var(--text-muted); }
      .rd-line b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
      .rd-text { flex: 1; min-width: 0; }
      .rd-live { background: var(--ok-soft-bg); border-color: var(--ok-border); color: var(--ok-soft-fg); }
      .rd-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--ok-fg); flex-shrink: 0; }
      .rd-warn { background: var(--warn-soft-bg); border-color: var(--warn-border); color: var(--warn-soft-fg); }
      .rd-warn > .pi { color: var(--warn-soft-fg); }
      .rd-act {
        flex-shrink: 0; min-height: 2.75rem; padding: 0 var(--sp-3); border-radius: var(--r-pill);
        border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer;
        font-family: var(--font-body); font-size: var(--fs-xs); font-weight: 700;
      }
      .rd-act:disabled { opacity: 0.6; }

      /* [MCP.3.6] Dock: Finalizar ruta + Pedido. ARRIBA de la barra de abajo de la app (fija, 5rem,
         z-index 10), mismo arreglo que .acts de vendor-order-success. */
      .dock {
        position: fixed; left: 1rem; right: 1rem; z-index: 40;
        bottom: calc(5rem + 0.75rem + env(safe-area-inset-bottom));
        display: flex; gap: var(--sp-2); align-items: center;
      }
      .finish-btn {
        flex: 1; min-width: 0; height: 3.25rem; border-radius: var(--r-pill); cursor: pointer;
        border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main);
        font-family: var(--font-body); font-size: var(--fs-body); font-weight: 700;
        display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
        box-shadow: 0 6px 18px -8px rgba(16,13,9,0.35);
        transition: transform 0.08s var(--ease, ease);
      }
      .finish-btn:active { transform: scale(0.97); }
      .fab.docked { position: static; flex-shrink: 0; }
      .dock-spacer { height: 4.5rem; }


      .geo-hint {
        display: flex; align-items: center; gap: 0.45rem; width: 100%;
        margin-bottom: 0.875rem; padding: 0.55rem 0.7rem; border-radius: var(--r-md, 12px);
        background: var(--surface-ground); border: 1px dashed var(--border-color);
        color: var(--text-muted); font-size: 0.78rem; text-align: left;
      }
      .geo-hint.retry { cursor: pointer; }
      .geo-hint.retry i { color: var(--action); }

      .search-bar { margin-bottom: 0.75rem; display: flex; gap: 0.5rem; align-items: center; }
      .search-wrap { display: block; position: relative; flex: 1; min-width: 0; }
      .search-wrap input { width: 100%; padding-left: 2.25rem; border-radius: var(--r-pill, 999px); }
      .search-wrap i { position: absolute; left: 0.85rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
      .add-client { flex-shrink: 0; width: 2.9rem; height: 2.9rem; border-radius: var(--r-pill, 999px); border: none; background: var(--action); color: #fff; display: grid; place-items: center; font-size: 1.15rem; cursor: pointer; box-shadow: 0 1px 2px rgba(16,13,9,0.08); transition: transform 0.07s var(--ease, ease); }
      .add-client:active { transform: scale(0.94); }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty p { margin: 0 0 0.5rem; } .empty .hint { font-size: 0.8rem; margin-bottom: 1rem; }
      .empty-actions { display: flex; flex-direction: column; gap: 0.5rem; align-items: center; }

      .list { display: flex; flex-direction: column; gap: 0.5rem; }
      .client {
        position: relative; display: flex; align-items: center; gap: 0.8rem; width: 100%; text-align: left;
        border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px);
        background: var(--card-bg); padding: 0.8rem 0.875rem 0.8rem 1.05rem; cursor: pointer;
        box-shadow: 0 1px 2px rgba(16,13,9,0.05); overflow: hidden;
        transition: transform 0.06s var(--ease, ease);
        animation: client-in 0.32s var(--ease-out, cubic-bezier(0.23,1,0.32,1)) backwards;
      }
      @keyframes client-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .client::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--border-color); }
      .client.visited::before { background: var(--ok-fg); }
      .client.preventa::before { background: var(--warn-fg); }
      .client:active { transform: scale(0.985); }
      .seq {
        flex-shrink: 0; width: 2.1rem; height: 2.1rem; border-radius: 14px; display: grid; place-items: center;
        background: var(--surface-ground); color: var(--text-muted);
        font-family: var(--font-mono); font-weight: 700; font-size: 0.9rem; font-variant-numeric: tabular-nums;
      }
      .seq.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .cbody { flex: 1; min-width: 0; }
      .nm { display: block; font-weight: 700; font-size: 0.95rem; letter-spacing: -0.01em; color: var(--text-main); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .chips { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.35rem; }
      .chip { font-size: 0.68rem; font-weight: 600; padding: 0.12rem 0.5rem; border-radius: var(--r-pill, 999px); display: inline-flex; align-items: center; gap: 0.25rem; }
      .chip i { font-size: 0.62rem; }
      .chip.pre { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .chip.pend { background: var(--info-soft-bg); color: var(--info-soft-fg); }
      .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .more { color: var(--text-faint); flex-shrink: 0; font-size: 1rem; }
      .filter-empty { text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: var(--fs-body); }

      /* FAB — zona del pulgar */
      .fab {
        position: fixed; right: 1rem; bottom: calc(4.75rem + env(safe-area-inset-bottom));
        height: 3.25rem; padding: 0 1.35rem; border: none; border-radius: var(--r-pill, 999px);
        background: var(--accent-brand); color: #000; font-family: var(--font-body); font-weight: 700; font-size: 0.95rem;
        display: flex; align-items: center; gap: 0.55rem; z-index: 40;
        box-shadow: 0 8px 22px -6px rgba(199,150,15,0.5);
        transition: transform 0.07s var(--ease, ease);
      }
      .fab:active { transform: scale(0.95); }

      /* Bottom-sheet */
      .sheet-backdrop { position: fixed; inset: 0; background: rgba(16,13,9,0.45); z-index: 50; animation: backdrop-in 0.2s ease; }
      .sheet-backdrop.closing { animation: backdrop-out 0.2s ease forwards; }
      @keyframes backdrop-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes backdrop-out { from { opacity: 1; } to { opacity: 0; } }
      .sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        background: var(--card-bg); border-radius: var(--r-2xl, 24px) var(--r-2xl, 24px) 0 0;
        padding: 0.6rem 1rem calc(1.4rem + env(safe-area-inset-bottom));
        box-shadow: 0 -10px 34px rgba(16,13,9,0.2); max-height: 88vh; overflow-y: auto;
        animation: sheet-up 0.3s var(--ease-drawer, cubic-bezier(0.32,0.72,0,1));
      }
      .sheet.closing { animation: sheet-down 0.2s var(--ease-out, cubic-bezier(0.23,1,0.32,1)) forwards; }
      @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      @keyframes sheet-down { from { transform: translateY(0); } to { transform: translateY(100%); } }
      .sheet-handle { width: 2.5rem; height: 0.25rem; border-radius: 999px; background: var(--neutral-200); margin: 0 auto 0.875rem; }
      .sheet-head { display: flex; align-items: center; gap: 0.75rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); }
      .sheet-head .av { width: 2.6rem; height: 2.6rem; border-radius: 16px; background: var(--ember-grad); color: #fff; display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
      .sheet-head .n { display: block; font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; color: var(--text-main); }
      .sheet-head .cd { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
      .sheet-primary {
        width: 100%; height: 3.25rem; border: none; border-radius: var(--r-lg, 16px); background: var(--accent-brand); color: #000;
        font-family: var(--font-body); font-weight: 700; font-size: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.6rem;
        margin: 0.75rem 0 0.25rem; box-shadow: 0 4px 14px -4px rgba(199,150,15,0.4);
        transition: transform 0.07s var(--ease, ease);
      }
      .sheet-primary:active { transform: scale(0.97); }
      .action {
        display: flex; align-items: center; gap: 0.875rem; width: 100%; text-align: left;
        border: none; background: none; cursor: pointer; padding: 0.85rem 0.25rem;
        border-bottom: 1px solid var(--border-color); font-size: 0.95rem; color: var(--text-main);
      }
      .action:last-of-type { border-bottom: none; }
      .action:disabled { opacity: 0.5; }
      .action i { font-size: 1.2rem; width: 1.5rem; text-align: center; color: var(--action); flex-shrink: 0; }
      .action .lbl { display: flex; flex-direction: column; font-weight: 600; }
      .action .lbl small { font-size: 0.72rem; color: var(--text-muted); font-weight: 400; }
      .action .badge { margin-left: auto; font-family: var(--font-mono); font-size: 0.72rem; font-weight: 700; color: var(--warn-soft-fg); background: var(--warn-soft-bg); padding: 0.1rem 0.5rem; border-radius: var(--r-pill, 999px); }
      .visit-line { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; min-height: 2.2rem; padding: 0.35rem 0.25rem 0; font-size: var(--fs-sm); color: var(--text-muted); }
      .visit-line .ok { color: var(--ok-fg); }
      .visit-line .bad { color: var(--bad-fg); }
      .visit-retry { border: none; background: none; padding: 0.4rem 0.2rem; color: var(--action); font-weight: 700; font-size: var(--fs-sm); cursor: pointer; }
      .contact { display: flex; gap: 0.5rem; margin-top: 0.875rem; }
      .contact-btn { flex: 1; height: 2.9rem; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: var(--r-md, 12px); text-decoration: none; font-weight: 700; font-size: var(--fs-body); border: 1px solid var(--border-color); color: var(--text-main); background: var(--surface-ground); }
      .contact-btn.wa { background: #25d366; color: #fff; border-color: #25d366; }

      /* feedback táctil — todo lo presionable responde al press */
      .contact-btn { transition: transform 0.08s var(--ease, ease); }
      .action { transition: background-color 0.12s ease; }
      .action:active:not(:disabled) { background: var(--hover-bg, var(--surface-ground)); }
      .contact-btn:active { transform: scale(0.97); }

      @media (prefers-reduced-motion: reduce) {
        .sheet, .sheet.closing, .sheet-backdrop, .sheet-backdrop.closing, .client { animation: none; }
        .hero::before { animation: none; }
        .ring { transition: none; }
        .client, .fab, .sheet-primary, .contact-btn, .start-btn, .finish-btn { transition: none; }
        .hero-refresh.spinning i { animation: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorRouteHomeComponent implements OnInit, OnDestroy {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly geo = inject(GeolocationService);
  private readonly doc = inject(DOCUMENT);
  private readonly routeDays = inject(RouteDayService);
  private readonly auth = inject(AuthService);

  @ViewChild('sheetEl') private sheetEl?: ElementRef<HTMLElement>;

  readonly loading = signal(true);
  /** Distingue "sin cartera" (vacío real) de un fallo de red (estándar PWA §5). */
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly customers = signal<HomeCustomer[]>([]);
  readonly ordersToday = signal<Order[]>([]);
  readonly sheet = signal<HomeCustomer | null>(null);
  readonly sheetClosing = signal(false);
  /** [VR.SUP.1] Estado de la ruta del día (supervisor). null = no cargó / no aplica. */
  readonly dayPick = signal<DayPickState | null>(null);

  /** Elemento que tenía el foco antes de abrir el sheet (para restaurarlo). */
  private prevFocus: HTMLElement | null = null;

  /** Cifra constante reutilizada — no instanciar Intl en cada llamada. */
  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  readonly todayLabel = new Date().toLocaleDateString('es-MX', { weekday: 'long' });

  /** Estados mutuamente excluyentes de la pantalla (error de red ≠ vacío real). */
  readonly showError = computed(
    () => !this.loading() && this.loadError() && this.customers().length === 0,
  );
  readonly showEmpty = computed(
    () => !this.loading() && !this.loadError() && this.customers().length === 0,
  );

  /** Autodetección de llegada (GPS). */
  readonly detected = signal<NearbyCustomer | null>(null);
  readonly geoStatus = signal<'idle' | 'locating' | 'found' | 'denied' | 'none'>('idle');
  /** El HomeCustomer (con info de pendientes) que corresponde al cliente detectado. */
  readonly arrivalCustomer = computed(() => {
    const d = this.detected();
    if (!d) return null;
    return this.customers().find((c) => c.id === d.id) || null;
  });
  /** [MCP.3.7] El pedido pendiente del cliente detectado, para la tarjeta de llegada. */
  readonly arrivalPending = computed(() => {
    const ac = this.arrivalCustomer();
    if (!ac || !ac.pending_count) return null;
    return `${ac.has_preventa_pending ? 'Ya tiene preventa' : 'Ya tiene pedido'} ${this.fmtMoney(ac.pending_total)}`;
  });

  // ── [MCP.3.7] Protocolo de visitas ───────────────────────────────────────────────────────
  private readonly visits = inject(VisitProtocolService);
  /** La llegada al cliente abierto: abrirlo la registra. `error` se dice, nunca se da por hecha. */
  readonly arrival = signal<{ state: 'idle' | 'saving' | 'ok' | 'error'; at: string; detail: string }>({
    state: 'idle', at: '', detail: '',
  });
  /** Cliente al que se le está cerrando la visita sin pedido (abre la hoja de motivos). */
  readonly noSaleFor = signal<HomeCustomer | null>(null);
  readonly closingNoSale = signal(false);
  /** Última toma de GPS (la de la detección): se reusa al abrir para no esperar otra vez al GPS. */
  private lastFix: RecentFix | null = null;
  /** Re-detección de llegada mientras la pantalla está abierta. */
  private arrivalTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly ARRIVAL_EVERY_MS = 60_000;

  /** Signal (no propiedad plana): un computed() solo reacciona a signals. */
  readonly search = signal('');

  readonly visitedCount = computed(() => this.customers().filter((c) => c.visited_today).length);
  readonly pendingVisits = computed(() => this.customers().filter((c) => !c.visited_today).length);
  readonly progressPct = computed(() => {
    const t = this.customers().length;
    return t ? (this.visitedCount() / t) * 100 : 0;
  });
  readonly routeLabel = computed(() => {
    const routes = [...new Set(this.customers().map((c) => c.sales_route).filter(Boolean))];
    return routes.length === 1 ? routes[0] : routes.length > 1 ? `${routes.length} rutas` : '';
  });
  // Un draft (p.ej. el que se crea al abrir take-order y se abandona sin líneas)
  // NO es un pedido tomado. Contar solo pedidos reales, para no inflar el KPI.
  readonly pedidosHoy = computed(() => this.ordersToday().filter((o) => o.status !== 'draft').length);
  readonly vendidoHoy = computed(() =>
    this.ordersToday()
      .filter((o) => o.status === 'fulfilled' || o.status === 'confirmed')
      .reduce((s, o) => s + Number(o.total), 0),
  );
  readonly porEntregar = computed(() => this.customers().reduce((s, c) => s + (c.pending_count || 0), 0));
  readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    const all = this.customers();
    if (!term) return all;
    return all.filter(
      (c) => c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term),
    );
  });

  // ── [MCP.3.6] Iniciar / finalizar ruta ─────────────────────────────────────────────────────
  /** La ruta de hoy; `null` mientras no se sabe. */
  readonly routeDay = signal<SellerRouteDay | null>(null);
  /** `error` ≠ `sin_iniciar`: si no se pudo leer, se dice y se deja vender. */
  readonly routeDayStatus = signal<'loading' | 'ok' | 'error'>('loading');
  readonly starting = signal(false);
  readonly startFailed = signal(false);
  /** El vendedor eligió seguir sin iniciar después de que iniciar falló. */
  readonly skipStart = signal(false);

  readonly showStart = computed(() => {
    const st = this.routeDayStatus();
    const state = this.routeDay()?.state;
    const skip = this.skipStart();
    return st === 'ok' && state === 'sin_iniciar' && !skip;
  });
  readonly enRuta = computed(() => {
    const st = this.routeDayStatus();
    const state = this.routeDay()?.state;
    return st === 'ok' && state === 'en_ruta';
  });
  readonly startedAt = computed(() => horaMx(this.routeDay()?.started_at));
  readonly finishedAt = computed(() => horaMx(this.routeDay()?.finished_at));
  readonly greeting = computed(() => {
    const name = this.auth.user()?.username?.trim();
    return name ? `Hola, ${name}` : 'Hola';
  });
  readonly todayLong = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: MX_TZ,
  }).format(new Date());

  ngOnInit(): void {
    this.loadRouteDay();
    this.load();
    // [MCP.3.7] Mientras Mi ruta está abierta se vuelve a buscar al cliente cercano cada minuto:
    // así aparece la tarjeta de llegada al llegar, sin tocar nada. Sin GPS no se programa.
    if (this.geo.supported) {
      this.arrivalTimer = setInterval(() => {
        if (!this.loading() && this.customers().length && this.doc.visibilityState !== 'hidden') void this.detectArrival(true);
      }, VendorRouteHomeComponent.ARRIVAL_EVERY_MS);
    }
  }

  /**
   * Lee el estado de la ruta de hoy. `silent` no vuelve a poner la pantalla en carga. Con red
   * lenta (>6 s) o error queda `error`: Mi ruta se ve con un aviso, nunca la vista de Iniciar.
   */
  loadRouteDay(silent = false): void {
    if (!silent) this.routeDayStatus.set('loading');
    this.routeDays
      .today()
      .pipe(timeout(6000), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rd) => {
          this.routeDay.set(rd);
          this.routeDayStatus.set('ok');
        },
        error: () => {
          this.routeDay.set(null);
          this.routeDayStatus.set('error');
        },
      });
  }

  startRoute(): void {
    if (this.starting()) return;
    this.starting.set(true);
    this.startFailed.set(false);
    this.routeDays
      .start()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rd) => {
          this.routeDay.set(rd);
          this.routeDayStatus.set('ok');
          this.starting.set(false);
        },
        error: (e) => {
          this.starting.set(false);
          this.startFailed.set(true);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo iniciar la ruta',
            detail: e?.error?.message || 'Intenta de nuevo.',
          });
          // Puede que sí se haya iniciado (p. ej. otro intento): se vuelve a preguntar.
          this.loadRouteDay(true);
        },
      });
  }

  goFinish(): void {
    this.router.navigate(['/vendor/route-finish']);
  }

  ngOnDestroy(): void {
    if (this.arrivalTimer) clearInterval(this.arrivalTimer);
    // Si el componente muere con el sheet abierto, no dejar el body bloqueado.
    this.doc.body.style.removeProperty('overflow');
  }

  /**
   * Carga la ruta del día. `silent` recarga sin blanquear la pantalla (refresh
   * manual): conserva la data en pantalla y solo gira el ícono. Un fallo en
   * refresh silencioso NO borra lo que ya se ve — solo avisa por toast.
   */
  load(silent = false): void {
    if (silent) this.refreshing.set(true);
    else this.loading.set(true);
    this.loadError.set(false);
    forkJoin({
      home: this.api.home(),
      today: this.api.myOrdersToday().pipe(catchError(() => of([] as Order[]))),
      // [VR.SUP.1] Best-effort: si falla, no hay botón "Cambiar ruta" pero la ruta carga.
      dayPick: this.api.dayPickState().pipe(catchError(() => of(null))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ home, today, dayPick }) => {
          this.dayPick.set(dayPick);
          this.customers.set(home);
          this.ordersToday.set(today);
          this.loading.set(false);
          this.refreshing.set(false);
          // Autodetección de llegada una vez que tenemos cartera + pendientes.
          if (home.length) void this.detectArrival();
        },
        error: () => {
          this.loading.set(false);
          this.refreshing.set(false);
          this.loadError.set(true);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo cargar tu ruta',
            detail: 'Revisa tu conexión e intenta de nuevo.',
          });
        },
      });
  }

  /** Refresh manual desde el hero (no blanquea la pantalla). */
  refresh(): void {
    if (this.refreshing()) return;
    this.load(true);
    this.loadRouteDay(true);
  }

  openSheet(c: HomeCustomer): void {
    this.prevFocus = (this.doc.activeElement as HTMLElement) ?? null;
    this.sheet.set(c);
    this.doc.body.style.setProperty('overflow', 'hidden');
    // Mover el foco al sheet una vez renderizado.
    setTimeout(() => this.sheetEl?.nativeElement?.focus(), 0);
    // [MCP.3.7] Abrir al cliente registra la llegada (hora y desde dónde). No espera: la hoja ya se ve.
    void this.registerArrival(c);
  }
  openSheetById(id: string): void {
    const c = this.customers().find((x) => x.id === id);
    if (c) this.openSheet(c);
  }
  closeSheet(): void {
    if (!this.sheet() || this.sheetClosing()) return;
    this.sheetClosing.set(true);
    setTimeout(() => {
      this.sheet.set(null);
      this.sheetClosing.set(false);
      this.doc.body.style.removeProperty('overflow');
      this.prevFocus?.focus?.();
      this.prevFocus = null;
    }, 200);
  }

  /** Cierra el sheet con Escape (no hay "back" del browser en la PWA instalada). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.sheet()) this.closeSheet();
  }

  /** Atrapa el Tab dentro del sheet mientras está abierto. */
  trapFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const root = this.sheetEl?.nativeElement;
    if (!root) return;
    const f = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
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

  /**
   * Pide GPS y resuelve el cliente de la cartera más cercano (best-effort). `silent` (la
   * re-detección de cada minuto) no muestra «Buscando…» ni borra la tarjeta si el GPS falla.
   */
  async detectArrival(silent = false): Promise<void> {
    if (!this.geo.supported) {
      this.geoStatus.set('none');
      return;
    }
    if (!silent) this.geoStatus.set('locating');
    try {
      const fix = await this.geo.getCurrentPosition();
      this.lastFix = { lat: fix.lat, lng: fix.lng, at: Date.now() };
      this.api
        .nearbyCustomers(fix.lat, fix.lng)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (list) => {
            this.detected.set(list[0] ?? null);
            this.geoStatus.set('found');
          },
          error: () => {
            if (!silent) this.geoStatus.set('none');
          },
        });
    } catch {
      if (silent) return;
      this.detected.set(null);
      this.geoStatus.set('denied');
    }
  }

  /** FAB: abre la toma de pedido del próximo cliente sin visitar (o el primero). */
  fabOrder(): void {
    const list = this.customers();
    const next = list.find((c) => !c.visited_today) || list[0];
    if (next) this.router.navigate(['/vendor/take-order', next.id], { queryParams: { mode: 'futuro' } });
  }

  /** Ronda vacía: alta de cliente nuevo (abre el form de alta en /vendor/search). */
  addCustomer(): void {
    this.router.navigate(['/vendor/search'], { queryParams: { new: 1 } });
  }


  goOrder(c: HomeCustomer, mode: 'instante' | 'futuro'): void {
    this.closeSheet();
    this.router.navigate(['/vendor/take-order', c.id], { queryParams: { mode } });
  }
  goPending(): void {
    this.closeSheet();
    this.router.navigate(['/vendor/pending']);
  }
  goTicket(): void {
    this.closeSheet();
    this.router.navigate(['/vendor/close-route']);
  }
  goCapture(c: HomeCustomer): void {
    this.closeSheet();
    // Captura customer-driven: pasamos el cliente; la captura ya no detecta tienda por GPS.
    this.router.navigate(['/vendor/capture'], {
      queryParams: { customerId: c.id, customerName: c.name },
    });
  }

  /**
   * [MCP.3.7] Registra la llegada al cliente abierto. Si el cliente no tenía ubicación, el servidor
   * se la fija con esta toma (con su guarda contra encimar dos clientes). Abrirlo otra vez el mismo
   * día con la visita abierta no crea otra. Un fallo se DICE en la hoja, con Reintentar.
   */
  async registerArrival(c: HomeCustomer): Promise<void> {
    // Ya visitado hoy: la llegada ya está registrada; abrirlo de nuevo no crea otra visita.
    if (c.visited_today) {
      this.arrival.set({ state: 'ok', at: c.last_visit_at ? horaMx(c.last_visit_at) : '', detail: c.last_visit_at ? '' : 'hoy' });
      return;
    }
    this.arrival.set({ state: 'saving', at: '', detail: '' });
    try {
      const res = await this.visits.registerArrival(c.id, this.lastFix);
      if (this.sheet()?.id !== c.id && this.noSaleFor()?.id !== c.id) return; // ya cambió de cliente
      this.arrival.set({ state: 'ok', at: horaMx(new Date().toISOString()), detail: arrivalDetail(res) });
      this.customers.set(
        this.customers().map((x) =>
          x.id === c.id ? { ...x, visited_today: true, last_visit_at: new Date().toISOString() } : x,
        ),
      );
    } catch {
      if (this.sheet()?.id !== c.id) return;
      this.arrival.set({ state: 'error', at: '', detail: '' });
    }
  }

  /** «El cliente no pidió nada»: cierra la hoja del cliente y abre la de motivos. */
  openNoSale(c: HomeCustomer): void {
    this.noSaleFor.set(c);
    this.closeSheet();
  }

  /** Cierra la visita sin pedido. El botón se deshabilita en el primer toque (sin doble envío). */
  confirmNoSale(c: HomeCustomer, e: { reason: NoSaleKey; notes: string }): void {
    if (this.closingNoSale()) return;
    this.closingNoSale.set(true);
    this.visits
      .closeWithoutOrder(c.id, e.reason, e.notes)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.closingNoSale.set(false);
          this.noSaleFor.set(null);
          this.customers.set(this.customers().map((x) => (x.id === c.id ? { ...x, visited_today: true } : x)));
          if (this.detected()?.id === c.id) this.detected.set(null);
          this.toast.add({ severity: 'success', summary: 'Visita cerrada sin pedido', detail: c.name });
        },
        error: (err) => {
          this.closingNoSale.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo cerrar la visita',
            detail: err?.error?.message || 'Revisa tu conexión e intenta de nuevo.',
          });
        },
      });
  }

  waLink(wa: string): string {
    return 'https://wa.me/' + wa.replace(/[^0-9]/g, '');
  }
  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  trackId(_: number, c: HomeCustomer): string {
    return c.id;
  }
  fmtMoney(n: unknown): string {
    return this.money.format(Number(n) || 0);
  }
}
