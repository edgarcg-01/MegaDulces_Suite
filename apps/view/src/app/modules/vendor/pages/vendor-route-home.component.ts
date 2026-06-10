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
import { VendorService, HomeCustomer } from '../vendor.service';

/**
 * Home "Mi ruta" — la única pantalla del vendedor. La cartera en orden de visita;
 * cada cliente abre un bottom-sheet con TODAS sus acciones (ver pendiente, vender
 * al instante, agendar futuro, ticket, visita, contacto, exhibición) sin salir de
 * la lista. Un fetch (`home()`) trae todo lo anotado.
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
    <header class="head">
      <div class="title-row">
        <h1>Mi ruta</h1>
        <span class="route" *ngIf="routeLabel()">{{ routeLabel() }}</span>
      </div>
      <div class="progress" *ngIf="!loading() && customers().length > 0">
        <div class="progress-track">
          <div class="progress-fill" [style.width.%]="progressPct()"></div>
        </div>
        <span class="progress-text">{{ visitedCount() }}/{{ customers().length }} visitados</span>
      </div>
    </header>

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
      <button *ngFor="let c of filtered(); trackBy: trackId" class="client" (click)="openSheet(c)">
        <span class="seq" [class.ok]="c.visited_today" [class.unset]="c.visit_sequence == null">
          <i *ngIf="c.visited_today" class="pi pi-check"></i>
          <ng-container *ngIf="!c.visited_today">{{ c.visit_sequence ?? '·' }}</ng-container>
        </span>
        <span class="body">
          <span class="name">{{ c.name }}</span>
          <span class="chips">
            <span class="chip pre" *ngIf="c.has_preventa_pending">
              <i class="pi pi-inbox"></i> Preventa {{ fmtMoney(c.pending_total) }}
            </span>
            <span class="chip pend" *ngIf="!c.has_preventa_pending && c.pending_count > 0">
              {{ c.pending_count }} por entregar
            </span>
            <span class="chip ok" *ngIf="c.ordered_today">Pedido hoy</span>
          </span>
        </span>
        <i class="pi pi-ellipsis-v more"></i>
      </button>
      <div class="filter-empty" *ngIf="filtered().length === 0">Sin resultados para "{{ search }}".</div>
    </div>

    <!-- Bottom-sheet de acciones por cliente -->
    <ng-container *ngIf="sheet() as c">
      <div class="sheet-backdrop" (click)="closeSheet()"></div>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-handle"></div>
        <div class="sheet-title">
          <span class="n">{{ c.name }}</span>
          <span class="cd">{{ c.code }}<ng-container *ngIf="c.sales_route"> · {{ c.sales_route }}</ng-container></span>
        </div>

        <button class="action" *ngIf="c.pending_count > 0" (click)="goPending()">
          <i class="pi pi-inbox"></i>
          <span class="lbl">Ver pedido pendiente
            <span class="sub">{{ c.pending_count }} pedido(s) · {{ fmtMoney(c.pending_total) }}</span>
          </span>
        </button>

        <button class="action" (click)="goOrder(c, 'instante')">
          <i class="pi pi-bolt"></i>
          <span class="lbl">Pedido al instante <span class="sub">Vender y entregar ahora</span></span>
        </button>

        <button class="action" (click)="goOrder(c, 'futuro')">
          <i class="pi pi-calendar-plus"></i>
          <span class="lbl">Pedido futuro <span class="sub">Agendar entrega</span></span>
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
      .head { margin-bottom: 0.75rem; }
      .title-row { display: flex; align-items: baseline; gap: 0.625rem; }
      .title-row h1 { margin: 0; font-size: 1.5rem; color: var(--text-main); }
      .route { font-size: 0.8rem; font-weight: 700; color: var(--brand-700); }
      .progress { display: flex; align-items: center; gap: 0.625rem; margin-top: 0.5rem; }
      .progress-track { flex: 1; height: 0.5rem; border-radius: 999px; background: var(--surface-100); overflow: hidden; }
      .progress-fill { height: 100%; background: var(--ok-fg, var(--brand-700)); border-radius: 999px; transition: width 0.25s ease; }
      .progress-text { font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; }
      .search-bar { margin-bottom: 0.75rem; }
      .search-wrap { display: block; position: relative; }
      .search-wrap input { width: 100%; padding-left: 2.25rem; }
      .search-wrap i { position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty p { margin: 0 0 0.5rem; }
      .empty .hint { font-size: 0.8rem; margin-bottom: 1rem; }

      .list { display: flex; flex-direction: column; gap: 0.375rem; }
      .client {
        display: flex; align-items: center; gap: 0.75rem; width: 100%;
        text-align: left; border: 1px solid var(--border-color); border-radius: var(--radius-md, 0.625rem);
        background: var(--card-bg); padding: 0.625rem 0.75rem; cursor: pointer;
      }
      .client:active { transform: scale(0.995); }
      .seq {
        flex-shrink: 0; width: 1.85rem; height: 1.85rem; border-radius: 999px;
        background: var(--brand-50, var(--surface-100)); color: var(--brand-700);
        font-weight: 700; font-size: 0.85rem; display: flex; align-items: center; justify-content: center;
        font-variant-numeric: tabular-nums;
      }
      .seq.ok { background: var(--ok-fg, #16a34a); color: #fff; }
      .seq.unset { background: var(--surface-100); color: var(--text-muted); }
      .body { flex: 1; min-width: 0; }
      .name { display: block; font-weight: 600; color: var(--text-main); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .chips { display: flex; gap: 0.375rem; flex-wrap: wrap; margin-top: 0.2rem; }
      .chip { font-size: 0.68rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 999px; display: inline-flex; align-items: center; gap: 0.25rem; }
      .chip i { font-size: 0.65rem; }
      .chip.pre { background: #fef3c7; color: #92400e; }
      .chip.pend { background: #dbeafe; color: #1e40af; }
      .chip.ok { background: #dcfce7; color: #166534; }
      .more { color: var(--text-muted); flex-shrink: 0; }
      .filter-empty { text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.875rem; }

      .sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 50; }
      .sheet {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
        background: var(--card-bg); border-radius: 1rem 1rem 0 0;
        padding: 0.75rem 1rem calc(1rem + env(safe-area-inset-bottom));
        box-shadow: 0 -4px 20px rgba(0,0,0,0.18); max-height: 85vh; overflow-y: auto;
        animation: sheet-up 0.2s ease;
      }
      @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      .sheet-handle { width: 2.5rem; height: 0.25rem; border-radius: 999px; background: var(--border-color); margin: 0 auto 0.75rem; }
      .sheet-title { margin-bottom: 0.5rem; }
      .sheet-title .n { display: block; font-weight: 700; font-size: 1.05rem; color: var(--text-main); }
      .sheet-title .cd { font-size: 0.78rem; color: var(--text-muted); }
      .action {
        display: flex; align-items: center; gap: 0.875rem; width: 100%;
        text-align: left; border: none; background: none; cursor: pointer;
        padding: 0.85rem 0.25rem; border-bottom: 1px solid var(--border-color);
        font-size: 1rem; color: var(--text-main);
      }
      .action:disabled { opacity: 0.5; }
      .action i { font-size: 1.2rem; width: 1.5rem; text-align: center; color: var(--brand-700); flex-shrink: 0; }
      .action .lbl { display: flex; flex-direction: column; }
      .action .sub { font-size: 0.72rem; color: var(--text-muted); font-weight: 400; }
      .contact { display: flex; gap: 0.5rem; margin-top: 0.875rem; }
      .contact-btn {
        flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
        padding: 0.7rem; border-radius: var(--radius-md, 0.625rem); text-decoration: none;
        font-weight: 600; border: 1px solid var(--border-color); color: var(--text-main); background: var(--surface-50, var(--card-bg));
      }
      .contact-btn.wa { background: #25d366; color: #fff; border-color: #25d366; }
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
  readonly sheet = signal<HomeCustomer | null>(null);
  readonly checking = signal(false);

  search = '';

  readonly visitedCount = computed(() => this.customers().filter((c) => c.visited_today).length);
  readonly progressPct = computed(() => {
    const t = this.customers().length;
    return t ? Math.round((this.visitedCount() / t) * 100) : 0;
  });
  readonly routeLabel = computed(() => {
    const routes = [...new Set(this.customers().map((c) => c.sales_route).filter(Boolean))];
    return routes.length === 1 ? routes[0] : routes.length > 1 ? `${routes.length} rutas` : '';
  });
  readonly filtered = computed(() => {
    const term = this.search.trim().toLowerCase();
    const all = this.customers();
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
    this.api
      .home()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.customers.set(list);
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
  }
  closeSheet(): void {
    this.sheet.set(null);
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
    this.router.navigate(['/dashboard/vendor-capture']);
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

  trackId(_: number, c: HomeCustomer): string {
    return c.id;
  }
  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
