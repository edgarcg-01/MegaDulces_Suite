import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
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
import { forkJoin, of, catchError } from 'rxjs';
import { VendorService, HomeCustomer, NbaDue } from '../vendor.service';
import { Order } from '../../portal/portal.service';

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
    <section class="hero" *ngIf="!loading()">
      <div class="hero-main">
        <div class="ring" [style.--pct]="progressPct()">
          <div class="inner"><b>{{ visitedCount() }}</b><span>/{{ customers().length }}</span></div>
        </div>
        <div class="hero-h">
          <div class="ey">Hoy · {{ todayLabel() }}</div>
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

      <p-card *ngIf="!loading() && customers().length === 0">
        <div class="empty">
          <i class="pi pi-sitemap"></i>
          <p>No tenés cartera asignada todavía.</p>
          <p class="hint">Pedile a tu supervisor que te asigne tus rutas de venta.</p>
          <a pButton label="Buscar un cliente" icon="pi pi-search" severity="secondary" [text]="true" routerLink="/vendor/search"></a>
        </div>
      </p-card>

      <div *ngIf="!loading() && customers().length > 0" class="list">
        <button
          *ngFor="let c of filtered(); trackBy: trackId"
          class="client"
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
      <div class="sheet-backdrop" (click)="closeSheet()"></div>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-handle"></div>
        <div class="sheet-head">
          <span class="av">{{ initials(c.name) }}</span>
          <div>
            <span class="n">{{ c.name }}</span>
            <span class="cd">{{ c.code }}<ng-container *ngIf="c.sales_route"> · {{ c.sales_route }}</ng-container></span>
          </div>
        </div>

        <button class="sheet-primary" (click)="goOrder(c, 'instante')">
          <i class="pi pi-bolt"></i> Pedido al instante
        </button>

        <button class="action" *ngIf="c.pending_count > 0" (click)="goPending()">
          <i class="pi pi-inbox"></i>
          <span class="lbl">Ver pedido pendiente</span>
          <span class="badge">{{ fmtMoney(c.pending_total) }}</span>
        </button>

        <button class="action" (click)="goOrder(c, 'futuro')">
          <i class="pi pi-calendar-plus"></i>
          <span class="lbl">Pedido futuro <small>Agendar entrega</small></span>
        </button>

        <button class="action" *ngIf="!c.visited_today" [disabled]="checking()" (click)="markVisit(c)">
          <i class="pi pi-map-marker"></i>
          <span class="lbl">Marcar visita</span>
        </button>

        <button class="action" (click)="goTicket()">
          <i class="pi pi-receipt"></i>
          <span class="lbl">Registrar ticket</span>
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
      .hero {
        margin: -1rem -1rem 0;
        padding: 1.1rem 1rem 1.25rem;
        background: var(--v-hero-grad, linear-gradient(160deg, #F8B400 -10%, #F68F1E 55%, #C53E15 125%));
        color: #fff;
        position: relative;
        overflow: hidden;
      }
      .hero::after { content: ''; position: absolute; right: -40px; top: -30px; width: 160px; height: 160px; border-radius: 50%; background: rgba(255,255,255,0.12); }
      .hero-main { display: flex; align-items: center; gap: 0.95rem; position: relative; z-index: 2; }
      .ring {
        width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center;
        background: conic-gradient(#fff calc(var(--pct, 0) * 1%), rgba(255,255,255,0.28) 0);
      }
      .ring .inner {
        width: 52px; height: 52px; border-radius: 50%; background: #C53E15; display: grid; place-items: center;
        font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1;
      }
      .ring .inner b { font-size: 1.15rem; } .ring .inner span { font-size: 0.75rem; opacity: 0.85; }
      .hero-h { min-width: 0; }
      .hero-h .ey { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; opacity: 0.85; }
      .hero-h h1 { margin: 1px 0 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
      .hero-h .sub { font-size: 0.8rem; opacity: 0.9; }
      .kpis { display: flex; gap: 0; margin-top: 1rem; background: rgba(255,255,255,0.14); border-radius: var(--r-md, 12px); padding: 4px; position: relative; z-index: 2; }
      .kpi { flex: 1; text-align: center; padding: 0.45rem 0.25rem; border-radius: 12px; }
      .kpi.hl { background: rgba(255,255,255,0.18); }
      .kpi .v { font-family: var(--font-mono); font-weight: 700; font-size: 1rem; font-variant-numeric: tabular-nums; }
      .kpi .l { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.82; }

      .body-pad { padding-top: 0.875rem; }

      /* Smart banner (IA / ember) */
      .smart {
        display: flex; align-items: center; gap: 0.7rem; width: 100%; text-align: left;
        margin-bottom: 0.875rem; padding: 0.7rem 0.8rem; border-radius: var(--r-lg, 16px);
        background: var(--ember-soft); border: 1px solid var(--ember-border); cursor: pointer;
      }
      .smart .spark { width: 34px; height: 34px; border-radius: 14px; background: var(--ember-grad); display: grid; place-items: center; color: #fff; font-size: 0.95rem; flex-shrink: 0; box-shadow: 0 3px 10px rgba(240,90,40,0.35); }
      .smart .t { flex: 1; min-width: 0; }
      .smart .t b { display: block; font-size: 0.85rem; color: var(--text-main); }
      .smart .t span { font-size: 0.75rem; color: var(--text-muted); }
      .smart .go { font-size: 0.75rem; font-weight: 700; color: var(--action); white-space: nowrap; }

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
      }
      .client::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--stone-300); }
      .client.visited::before { background: var(--ok-fg); }
      .client.preventa::before { background: var(--warn-fg); }
      .client.due::before { background: var(--action); }
      .client:active { transform: scale(0.985); }
      .seq {
        flex-shrink: 0; width: 2.1rem; height: 2.1rem; border-radius: 14px; display: grid; place-items: center;
        background: var(--v-seq-bg, var(--brand-100)); color: var(--v-seq-fg, var(--brand-900));
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
        background: var(--action); color: #fff; font-family: var(--font-body); font-weight: 700; font-size: 0.95rem;
        display: flex; align-items: center; gap: 0.55rem; z-index: 40;
        box-shadow: 0 10px 24px -4px rgba(240,90,40,0.55);
        transition: transform 0.07s var(--ease, ease);
      }
      .fab:active { transform: scale(0.95); }

      /* Bottom-sheet */
      .sheet-backdrop { position: fixed; inset: 0; background: rgba(16,13,9,0.45); z-index: 50; }
      .sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        background: var(--card-bg); border-radius: var(--r-2xl, 24px) var(--r-2xl, 24px) 0 0;
        padding: 0.6rem 1rem calc(1.4rem + env(safe-area-inset-bottom));
        box-shadow: 0 -10px 34px rgba(16,13,9,0.2); max-height: 88vh; overflow-y: auto;
        animation: sheet-up 0.28s var(--spring, cubic-bezier(.34,1.56,.64,1));
      }
      @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      .sheet-handle { width: 2.5rem; height: 0.25rem; border-radius: 999px; background: var(--stone-200); margin: 0 auto 0.875rem; }
      .sheet-head { display: flex; align-items: center; gap: 0.75rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border-color); }
      .sheet-head .av { width: 2.6rem; height: 2.6rem; border-radius: 16px; background: var(--ember-grad); color: #fff; display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
      .sheet-head .n { display: block; font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; color: var(--text-main); }
      .sheet-head .cd { font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); }
      .sheet-primary {
        width: 100%; height: 3.25rem; border: none; border-radius: var(--r-lg, 16px); background: var(--action); color: #fff;
        font-family: var(--font-body); font-weight: 700; font-size: 1rem; display: flex; align-items: center; justify-content: center; gap: 0.6rem;
        margin: 0.75rem 0 0.25rem; box-shadow: 0 6px 18px -4px rgba(240,90,40,0.45);
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

      @media (prefers-reduced-motion: reduce) {
        .sheet { animation: none; }
        .client, .fab, .sheet-primary { transition: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorRouteHomeComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  readonly loading = signal(true);
  readonly customers = signal<HomeCustomer[]>([]);
  readonly ordersToday = signal<Order[]>([]);
  readonly sheet = signal<HomeCustomer | null>(null);
  readonly checking = signal(false);
  readonly dueIds = signal<Set<string>>(new Set());
  readonly onlyDue = signal(false);

  search = '';

  readonly visitedCount = computed(() => this.customers().filter((c) => c.visited_today).length);
  readonly pendingVisits = computed(() => this.customers().filter((c) => !c.visited_today).length);
  readonly progressPct = computed(() => {
    const t = this.customers().length;
    return t ? Math.round((this.visitedCount() / t) * 100) : 0;
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

  load(): void {
    this.loading.set(true);
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
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar tu ruta' });
        },
      });
  }

  openSheet(c: HomeCustomer): void {
    this.sheet.set(c);
    if (this.isDue(c)) {
      this.api.recordSignal(c.id, 'offer_shown', 'vendor').subscribe({ error: () => {} });
    }
  }
  closeSheet(): void {
    this.sheet.set(null);
  }

  /** FAB: abre la toma de pedido del próximo cliente sin visitar (o el primero). */
  fabOrder(): void {
    const list = this.customers();
    const next = list.find((c) => !c.visited_today) || list[0];
    if (next) this.router.navigate(['/vendor/take-order', next.id], { queryParams: { mode: 'instante' } });
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

  markVisit(c: HomeCustomer): void {
    this.checking.set(true);
    this.api
      .checkIn(c.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.customers.set(
            this.customers().map((x) =>
              x.id === c.id ? { ...x, visited_today: true, last_visit_at: new Date().toISOString() } : x,
            ),
          );
          this.checking.set(false);
          this.closeSheet();
          this.toast.add({ severity: 'success', summary: 'Visita registrada', detail: c.name });
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
  todayLabel(): string {
    return new Date().toLocaleDateString('es-MX', { weekday: 'long' });
  }
  trackId(_: number, c: HomeCustomer): string {
    return c.id;
  }
  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
