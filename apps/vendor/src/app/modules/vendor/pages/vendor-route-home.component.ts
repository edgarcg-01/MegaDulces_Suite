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
} from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError } from 'rxjs';
import { VendorService, HomeCustomer, NbaDue, NearbyCustomer } from '../vendor.service';
import { Order } from '../../portal/portal.service';
import { GeolocationService } from '../../../core/services/geolocation.service';

/**
 * Home "Mi ruta" — única pantalla del vendedor (rediseño Mercado mobile-first).
 * Hero full-bleed con anillo de progreso + KPIs del día, banner IA (ember) de
 * reorden, cartera en orden de visita con riel de estado, FAB sunset y un
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
  ],
  template: `
    <!-- Hero full-bleed -->
    <section class="hero" *ngIf="!loading() && !showError()">
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
        </div>
      </div>
      <div class="kpis" *ngIf="customers().length > 0">
        <div class="kpi"><div class="v">{{ pedidosHoy() }}</div><div class="l">Pedidos</div></div>
        <div class="kpi hl"><div class="v">{{ fmtMoney(vendidoHoy()) }}</div><div class="l">Vendido</div></div>
        <div class="kpi"><div class="v">{{ porEntregar() }}</div><div class="l">Entregar</div></div>
      </div>
    </section>

    <div class="body-pad">
      <!-- Banner de llegada: autodetección GPS del cliente más cercano de la cartera -->
      <button
        type="button"
        class="arrival"
        *ngIf="!loading() && detected() as d"
        [class.has-pending]="arrivalCustomer()?.pending_count"
        (click)="openSheetById(d.id)"
      >
        <span class="pin"><i class="pi pi-map-marker"></i></span>
        <span class="a-body">
          <span class="a-top">Estás en <b>{{ d.name }}</b> · {{ d.distance_m }} m</span>
          <span class="a-sub" *ngIf="arrivalCustomer() as ac">
            <ng-container *ngIf="ac.pending_count > 0; else noPend">
              <i class="pi" [ngClass]="ac.has_preventa_pending ? 'pi-inbox' : 'pi-clock'"></i>
              {{ ac.has_preventa_pending ? 'Ya tiene preventa' : 'Ya tiene pedido' }}
              {{ fmtMoney(ac.pending_total) }} — entregar / ver
            </ng-container>
            <ng-template #noPend>
              <span class="muted"><i class="pi pi-bolt"></i> Tocá para tomar pedido</span>
            </ng-template>
          </span>
        </span>
        <i class="pi pi-chevron-right go-chev"></i>
      </button>

      <div class="geo-hint" *ngIf="!loading() && geoStatus() === 'locating'">
        <i class="pi pi-spin pi-spinner"></i> Buscando tu ubicación…
      </div>
      <button
        type="button"
        class="geo-hint retry"
        *ngIf="!loading() && (geoStatus() === 'denied' || (geoStatus() === 'found' && !detected()))"
        (click)="detectArrival()"
      >
        <i class="pi pi-map-marker"></i>
        {{ geoStatus() === 'denied' ? 'Activá la ubicación para detectar dónde estás' : 'Ningún cliente cerca · reintentar' }}
      </button>

      <button
        type="button"
        class="smart"
        *ngIf="!loading() && dueCount() > 0"
        [class.active]="onlyDue()"
        (click)="toggleOnlyDue()"
      >
        <span class="spark"><i class="pi pi-sparkles"></i></span>
        <span class="t">
          <b>{{ dueCount() }} {{ dueCount() === 1 ? 'cliente' : 'clientes' }} para reordenar hoy</b>
          <span>Según su ritmo de compra · IA</span>
        </span>
        <span class="go">{{ onlyDue() ? 'Ver todos' : 'Ver ›' }}</span>
      </button>

      <div class="search-bar" *ngIf="!loading() && customers().length > 0">
        <span class="search-wrap">
          <i class="pi pi-search"></i>
          <input
            pInputText
            type="search"
            placeholder="Filtrar mi ruta"
            [(ngModel)]="search"
            inputmode="search"
            enterkeyhint="search"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
          />
        </span>
      </div>

      <p-skeleton *ngIf="loading()" height="500px"></p-skeleton>

      <!-- Estado de error de red (distinto del vacío real) -->
      <p-card *ngIf="showError()">
        <div class="empty">
          <i class="pi pi-cloud"></i>
          <p>No se pudo cargar tu ruta.</p>
          <p class="hint">Revisá tu conexión e intentá de nuevo.</p>
          <button pButton label="Reintentar" icon="pi pi-refresh" (click)="load()"></button>
        </div>
      </p-card>

      <!-- Vacío real: sin cartera asignada -->
      <p-card *ngIf="showEmpty()">
        <div class="empty">
          <i class="pi pi-sitemap"></i>
          <p>No tenés cartera asignada todavía.</p>
          <p class="hint">Pedile a tu supervisor que te asigne tus rutas de venta.</p>
          <a pButton label="Buscar un cliente" icon="pi pi-search" severity="secondary" [text]="true" routerLink="/vendor/search"></a>
        </div>
      </p-card>

      <div *ngIf="!loading() && customers().length > 0" class="list">
        <button
          *ngFor="let c of filtered(); let i = index; trackBy: trackId"
          class="client"
          [style.animation-delay.ms]="(i > 9 ? 9 : i) * 35"
          [class.visited]="c.visited_today"
          [class.preventa]="!c.visited_today && c.has_preventa_pending"
          [class.due]="!c.visited_today && !c.has_preventa_pending && isDue(c)"
          (click)="openSheet(c)"
        >
          <span class="seq" [class.ok]="c.visited_today">
            <i *ngIf="c.visited_today" class="pi pi-check"></i>
            <ng-container *ngIf="!c.visited_today">{{ c.visit_sequence ?? '·' }}</ng-container>
          </span>
          <span class="cbody">
            <span class="nm">{{ c.name }}</span>
            <span class="chips">
              <span class="chip pre" *ngIf="c.has_preventa_pending">
                <i class="pi pi-inbox"></i> Preventa {{ fmtMoney(c.pending_total) }}
              </span>
              <span class="chip pend" *ngIf="!c.has_preventa_pending && c.pending_count > 0">
                {{ c.pending_count }} por entregar
              </span>
              <span class="chip due" *ngIf="!c.has_preventa_pending && isDue(c)"><i class="pi pi-sparkles"></i> Reordenar</span>
              <span class="chip ok" *ngIf="c.ordered_today">Pedido hoy</span>
            </span>
          </span>
          <i class="pi pi-ellipsis-v more"></i>
        </button>
        <div class="filter-empty" *ngIf="filtered().length === 0">Sin resultados para "{{ search }}".</div>
      </div>
    </div>

    <!-- FAB: tomar pedido del próximo cliente (zona del pulgar) -->
    <button class="fab" *ngIf="!loading() && customers().length > 0" (click)="fabOrder()">
      <i class="pi pi-plus"></i> Pedido
    </button>

    <!-- Bottom-sheet de acciones por cliente -->
    <ng-container *ngIf="sheet() as c">
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
            <span class="cd">{{ c.code }}<ng-container *ngIf="c.sales_route"> · {{ c.sales_route }}</ng-container></span>
          </div>
        </div>

        <button class="sheet-primary" (click)="goOrder(c, 'futuro')">
          <i class="pi pi-shopping-cart"></i> Tomar pedido
        </button>

        <button class="action" *ngIf="c.pending_count > 0" (click)="goPending()">
          <i class="pi pi-inbox"></i>
          <span class="lbl">Ver pedido pendiente</span>
          <span class="badge">{{ fmtMoney(c.pending_total) }}</span>
        </button>

        <button class="action" *ngIf="!c.visited_today" [disabled]="checking()" (click)="markVisit(c)">
          <i class="pi pi-map-marker"></i>
          <span class="lbl">Marcar visita</span>
        </button>

        <button class="action" (click)="goCapture()">
          <i class="pi pi-camera"></i>
          <span class="lbl">Capturar exhibición</span>
        </button>

        <div class="contact" *ngIf="c.phone || c.whatsapp">
          <a *ngIf="c.phone" class="contact-btn" [href]="'tel:' + c.phone"><i class="pi pi-phone"></i> Llamar</a>
          <a *ngIf="c.whatsapp" class="contact-btn wa" [href]="waLink(c.whatsapp)" target="_blank" rel="noopener">
            <i class="pi pi-whatsapp"></i> WhatsApp
          </a>
        </div>
      </div>
    </ng-container>
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
        transition: --pct 0.8s var(--ease-out, cubic-bezier(0.23,1,0.32,1));
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

      /* Smart banner (IA / ember) */
      .smart {
        display: flex; align-items: center; gap: 0.7rem; width: 100%; text-align: left;
        margin-bottom: 0.875rem; padding: 0.7rem 0.8rem; border-radius: var(--r-lg, 16px);
        background: var(--card-bg); border: 1px solid var(--ember-border); cursor: pointer;
      }
      .smart .spark { width: 34px; height: 34px; border-radius: 12px; background: var(--card-bg); border: 1px solid var(--ember-border); display: grid; place-items: center; color: var(--action); font-size: 0.95rem; flex-shrink: 0; }
      .smart .t { flex: 1; min-width: 0; }
      .smart .t b { display: block; font-size: 0.85rem; color: var(--text-main); }
      .smart .t span { font-size: 0.75rem; color: var(--text-muted); }
      .smart .go { font-size: 0.75rem; font-weight: 700; color: var(--action); white-space: nowrap; }

      /* Banner de llegada (autodetección GPS) */
      .arrival {
        display: flex; align-items: center; gap: 0.7rem; width: 100%; text-align: left;
        margin-bottom: 0.875rem; padding: 0.75rem 0.85rem; border-radius: var(--r-lg, 16px);
        background: var(--card-bg); border: 1px solid var(--action); cursor: pointer;
        box-shadow: 0 6px 18px -8px rgba(240,90,40,0.5);
        animation: client-in 0.3s var(--ease-out, cubic-bezier(0.23,1,0.32,1)) backwards;
        transition: transform 0.08s var(--ease, ease);
      }
      .arrival:active { transform: scale(0.99); }
      .arrival .pin { width: 36px; height: 36px; border-radius: 14px; background: var(--action); color: #fff; display: grid; place-items: center; font-size: 1rem; flex-shrink: 0; }
      .arrival.has-pending .pin { background: var(--warn-fg); }
      .arrival .a-body { flex: 1; min-width: 0; }
      .arrival .a-top { display: block; font-size: 0.9rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .arrival .a-top b { font-weight: 800; }
      .arrival .a-sub { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.76rem; font-weight: 700; color: var(--warn-soft-fg); margin-top: 1px; }
      .arrival .a-sub i { font-size: 0.7rem; }
      .arrival .a-sub .muted { display: inline-flex; align-items: center; gap: 0.3rem; color: var(--text-muted); font-weight: 500; }
      .arrival .go-chev { color: var(--text-faint); flex-shrink: 0; }

      .geo-hint {
        display: flex; align-items: center; gap: 0.45rem; width: 100%;
        margin-bottom: 0.875rem; padding: 0.55rem 0.7rem; border-radius: var(--r-md, 12px);
        background: var(--surface-ground); border: 1px dashed var(--border-color);
        color: var(--text-muted); font-size: 0.78rem; text-align: left;
      }
      .geo-hint.retry { cursor: pointer; }
      .geo-hint.retry i { color: var(--action); }

      .search-bar { margin-bottom: 0.75rem; }
      .search-wrap { display: block; position: relative; }
      .search-wrap input { width: 100%; padding-left: 2.25rem; border-radius: var(--r-pill, 999px); }
      .search-wrap i { position: absolute; left: 0.85rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty p { margin: 0 0 0.5rem; } .empty .hint { font-size: 0.8rem; margin-bottom: 1rem; }

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
      .client.due::before { background: var(--action); }
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
      .chip.due { background: var(--ember-soft); color: var(--brand-900); border: 1px solid var(--ember-border); }
      .more { color: var(--text-faint); flex-shrink: 0; font-size: 1rem; }
      .filter-empty { text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.875rem; }

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
      .sheet-handle { width: 2.5rem; height: 0.25rem; border-radius: 999px; background: var(--stone-200); margin: 0 auto 0.875rem; }
      .sheet-head { display: flex; align-items: center; gap: 0.75rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); }
      .sheet-head .av { width: 2.6rem; height: 2.6rem; border-radius: 16px; background: var(--ember-grad); color: #fff; display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
      .sheet-head .n { display: block; font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; color: var(--text-main); }
      .sheet-head .cd { font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); }
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
      .contact { display: flex; gap: 0.5rem; margin-top: 0.875rem; }
      .contact-btn { flex: 1; height: 2.9rem; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: var(--r-md, 12px); text-decoration: none; font-weight: 700; font-size: 0.875rem; border: 1px solid var(--border-color); color: var(--text-main); background: var(--surface-ground); }
      .contact-btn.wa { background: #25d366; color: #fff; border-color: #25d366; }

      /* feedback táctil — todo lo presionable responde al press */
      .smart, .contact-btn { transition: transform 0.08s var(--ease, ease); }
      .action { transition: background-color 0.12s ease; }
      .smart:active { transform: scale(0.99); }
      .action:active:not(:disabled) { background: var(--hover-bg, var(--surface-ground)); }
      .contact-btn:active { transform: scale(0.97); }

      @media (prefers-reduced-motion: reduce) {
        .sheet, .sheet.closing, .sheet-backdrop, .sheet-backdrop.closing, .client { animation: none; }
        .hero::before { animation: none; }
        .ring { transition: none; }
        .client, .fab, .sheet-primary, .smart, .contact-btn { transition: none; }
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

  @ViewChild('sheetEl') private sheetEl?: ElementRef<HTMLElement>;

  readonly loading = signal(true);
  /** Distingue "sin cartera" (vacío real) de un fallo de red (estándar PWA §5). */
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly customers = signal<HomeCustomer[]>([]);
  readonly ordersToday = signal<Order[]>([]);
  readonly sheet = signal<HomeCustomer | null>(null);
  readonly sheetClosing = signal(false);
  readonly checking = signal(false);
  readonly dueIds = signal<Set<string>>(new Set());
  readonly onlyDue = signal(false);

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

  search = '';

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
  readonly pedidosHoy = computed(() => this.ordersToday().length);
  readonly vendidoHoy = computed(() =>
    this.ordersToday()
      .filter((o) => o.status === 'fulfilled' || o.status === 'confirmed')
      .reduce((s, o) => s + Number(o.total), 0),
  );
  readonly porEntregar = computed(() => this.customers().reduce((s, c) => s + (c.pending_count || 0), 0));
  readonly dueCount = computed(() => {
    const ids = this.dueIds();
    return this.customers().filter((c) => ids.has(c.id)).length;
  });
  readonly filtered = computed(() => {
    const term = this.search.trim().toLowerCase();
    const ids = this.dueIds();
    let all = this.customers();
    if (this.onlyDue()) all = all.filter((c) => ids.has(c.id));
    if (!term) return all;
    return all.filter(
      (c) => c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term),
    );
  });

  ngOnInit(): void {
    this.load();
  }

  ngOnDestroy(): void {
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
      due: this.api.nbaDue().pipe(catchError(() => of([] as NbaDue[]))),
      today: this.api.myOrdersToday().pipe(catchError(() => of([] as Order[]))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ home, due, today }) => {
          this.customers.set(home);
          this.dueIds.set(new Set(due.map((d) => d.customer_id)));
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
            detail: 'Revisá tu conexión e intentá de nuevo.',
          });
        },
      });
  }

  /** Refresh manual desde el hero (no blanquea la pantalla). */
  refresh(): void {
    if (this.refreshing()) return;
    this.load(true);
  }

  openSheet(c: HomeCustomer): void {
    this.prevFocus = (this.doc.activeElement as HTMLElement) ?? null;
    this.sheet.set(c);
    this.doc.body.style.setProperty('overflow', 'hidden');
    // Mover el foco al sheet una vez renderizado.
    setTimeout(() => this.sheetEl?.nativeElement?.focus(), 0);
    if (this.isDue(c)) {
      this.api.recordSignal(c.id, 'offer_shown', 'vendor').subscribe({ error: () => {} });
    }
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

  /** Pide GPS y resuelve el cliente de la cartera más cercano (best-effort). */
  async detectArrival(): Promise<void> {
    if (!this.geo.supported) {
      this.geoStatus.set('none');
      return;
    }
    this.geoStatus.set('locating');
    try {
      const fix = await this.geo.getCurrentPosition();
      this.api
        .nearbyCustomers(fix.lat, fix.lng)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (list) => {
            this.detected.set(list[0] ?? null);
            this.geoStatus.set('found');
          },
          error: () => this.geoStatus.set('none'),
        });
    } catch {
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

  isDue(c: HomeCustomer): boolean {
    return this.dueIds().has(c.id);
  }
  toggleOnlyDue(): void {
    this.onlyDue.update((v) => !v);
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
  goCapture(): void {
    this.closeSheet();
    this.router.navigate(['/vendor/capture']);
  }

  async markVisit(c: HomeCustomer): Promise<void> {
    this.checking.set(true);
    // Capture-on-visit: adjuntamos el GPS al check-in (best-effort; sin permiso
    // igual se registra la visita, solo no backfillea coords).
    let coords: { latitude?: number; longitude?: number } = {};
    try {
      if (this.geo.supported) {
        const fix = await this.geo.getCurrentPosition();
        coords = { latitude: fix.lat, longitude: fix.lng };
      }
    } catch {
      /* sin GPS: check-in sin coords */
    }
    this.api
      .checkIn(c.id, coords)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.customers.set(
            this.customers().map((x) =>
              x.id === c.id ? { ...x, visited_today: true, last_visit_at: new Date().toISOString() } : x,
            ),
          );
          this.checking.set(false);
          this.closeSheet();
          const loc = res?.location;
          if (loc && loc.conflict) {
            this.toast.add({
              severity: 'warn',
              summary: 'Visita registrada',
              detail: `Ubicación se traslapa con ${loc.conflict.name} (${loc.conflict.distance_m} m) — no se guardó`,
            });
          } else if (loc?.location_set) {
            this.toast.add({ severity: 'success', summary: 'Visita registrada', detail: `${c.name} · ubicación guardada` });
          } else {
            this.toast.add({ severity: 'success', summary: 'Visita registrada', detail: c.name });
          }
        },
        error: (e) => {
          this.checking.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo registrar', detail: e?.error?.message || 'Intentá de nuevo.' });
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
