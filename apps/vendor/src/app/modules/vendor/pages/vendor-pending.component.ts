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
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, map, of, switchMap } from 'rxjs';
import { POR_ENTREGAR_TOPE, VendorService, VendorOrder } from '../vendor.service';

/** `[MCP.30]` Lo mínimo que se busca (igual que el servidor) y cuánto se espera a que deje de escribir. */
const BUSQUEDA_MINIMO = 2;
const BUSQUEDA_ESPERA_MS = 300;
/** Letras y números que cuentan (sin acentos, espacios ni signos), la misma cuenta que el servidor. */
const largoUtil = (q: string): number => q.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '').length;
import { OrderLine } from '../../portal/portal.service';
import { MOTIVOS_CORREGIR, type MotivoElegido } from '@megadulces/contracts';
import { VendorMotivoSheetComponent } from '../components/vendor-motivo-sheet.component';

/**
 * Apartado "Por entregar": pedidos pendientes de la cartera del vendedor
 * (preventa del Portal B2B + de campo) en pending_approval / confirmed.
 *  - pending_approval → el vendedor APRUEBA (pasa a confirmed / listo para entregar).
 *  - confirmed        → el vendedor marca ENTREGADO (fulfill, consume stock).
 * Cada card expande sus líneas bajo demanda. Toasts en el p-toast del shell.
 */
@Component({
  selector: 'app-vendor-pending',
  standalone: true,
  imports: [
    CommonModule,
    CardModule,
    TagModule,
    ButtonModule,
    SkeletonModule,
    ConfirmDialogModule,
    VendorMotivoSheetComponent,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirmdialog></p-confirmdialog>
    <!-- [MCP.18] El justificante de «Corregir»: el surtidor y la caja ven por qué cambió el pedido. -->
    @if (corrigiendo(); as c) {
      <app-vendor-motivo-sheet
        titulo="¿Por qué lo corriges?"
        [sub]="(c.folio || c.code) + ' · ' + (c.customer_name || 'Cliente') + ' · vuelve a borrador con el mismo folio; al terminar lo agendas de nuevo'"
        [opciones]="motivosCorregir"
        confirmarTexto="Corregir el pedido"
        [busy]="guardandoMotivo()"
        (confirm)="confirmarCorregir(c, $event)"
        (cancel)="corrigiendo.set(null)"
      ></app-vendor-motivo-sheet>
    }

    <div class="page-head">
      <div>
        <h1 class="page-title">Por entregar</h1>
        @if (!loading() && !loadError() && !enBusqueda()) {
          <p class="subtitle">
            {{ toApprove().length }} por aprobar · {{ toDeliver().length }} por entregar
          </p>
        }
      </div>
      @if (!loading()) {
        <button
          type="button"
          class="refresh"
          [class.spinning]="refreshing()"
          [disabled]="refreshing()"
          (click)="refresh()"
          aria-label="Actualizar pendientes"
          >
          <i class="pi pi-refresh"></i>
        </button>
      }
    </div>
    
    <!-- [MCP.30] Buscador de PEDIDOS (el de arriba es de precios): busca en el servidor, en TODOS los pendientes de
         tu cartera, no sólo en los que caben en la lista. Cada palabra en cualquier orden, sin acentos. -->
    @if (!loading() && !(loadError() && orders().length === 0)) {
      <div class="pe-bs" role="search">
        <i class="pi pi-box" aria-hidden="true"></i>
        <input type="search" class="pe-bs-in" [value]="busqueda()" (input)="buscar($any($event.target).value)"
               placeholder="Pedido: folio, cliente o producto" aria-label="Buscar en todos tus pedidos por entregar"
               enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" />
        @if (busqueda()) {
          <button type="button" class="pe-bs-x" (click)="buscar('')" aria-label="Borrar la búsqueda"><i class="pi pi-times" aria-hidden="true"></i></button>
        }
      </div>
      @if (enBusqueda()) {
        @if (sinSenal()) {
          <p class="pe-nota pe-aviso" role="status"><i class="pi pi-wifi" aria-hidden="true"></i> Para buscar necesitas señal.</p>
        } @else if (errorBusqueda()) {
          <p class="pe-nota pe-aviso" role="alert">{{ errorBusqueda() }} <button type="button" class="pe-re" (click)="rebuscar()">Reintentar</button></p>
        } @else if (!resultados()) {
          <p class="pe-nota">Buscando…</p>
        } @else {
          <p class="pe-nota" role="status">
            <b>Resultados · {{ resultados()!.total }}</b> en tus pedidos por entregar
            @if (resultados()!.total > resultados()!.data.length) { · se muestran los {{ resultados()!.data.length }} más recientes }
          </p>
          @if (!resultados()!.data.length) {
            <p-card><div class="empty"><i class="pi pi-search pe-ico-muted"></i><p>Ningún pedido por entregar tiene «{{ busqueda().trim() }}».</p></div></p-card>
          }
        }
      } @else if (total() > orders().length) {
        <!-- [MCP.30] La lista tiene tope: se dice cuántos hay de verdad (antes decía «200 por entregar» y callaba el resto). -->
        <p class="pe-nota pe-tope" role="status">
          Se muestran los {{ orders().length }} más recientes de {{ total() }}. Usa el buscador para encontrar los demás.
        </p>
      }
    }

    @if (loading()) {
      <p-skeleton height="400px"></p-skeleton>
    }

    <!-- Fallo de red (distinto de "sin pendientes") -->
    @if (!loading() && loadError() && orders().length === 0) {
      <p-card>
        <div class="empty">
          <i class="pi pi-cloud"></i>
          <p>No se pudo cargar los pendientes.</p>
          <button pButton size="small" [text]="true" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Reintentar</span></button>
        </div>
      </p-card>
    }
    
    @if (!loading() && !loadError() && orders().length === 0 && !enBusqueda()) {
      <p-card>
        <div class="empty">
          <i class="pi pi-check-circle"></i>
          <p>No tienes pedidos pendientes en tu cartera.</p>
        </div>
      </p-card>
    }
    
    @if (!loading() && fuente().length > 0) {
      <ng-container
        *ngTemplateOutlet="section; context: { title: 'Por aprobar', list: toApprove(), kind: 'approve' }"
      ></ng-container>
      <ng-container
        *ngTemplateOutlet="section; context: { title: 'Listos para entregar', list: toDeliver(), kind: 'deliver' }"
      ></ng-container>
    }
    
    <ng-template #section let-title="title" let-list="list" let-kind="kind">
      @if (list.length > 0) {
        <div class="section">
          <h2 class="section-title">{{ title }}</h2>
          <div class="order-list">
            @for (o of list; track o) {
              <p-card styleClass="order-card">
                <div
                  class="order-head"
                  role="button"
                  tabindex="0"
                  [attr.aria-expanded]="isOpen(o.id)"
                  (click)="toggle(o)"
                  (keydown.enter)="toggle(o)"
                  (keydown.space)="$event.preventDefault(); toggle(o)"
                  >
                  <div class="info">
                    <div class="customer">{{ o.customer_name || '—' }}</div>
                    <div class="sub">
                      <span class="folio">{{ o.folio || o.code }}</span>
                      <span class="time">{{ fmtTime(o.created_at) }}</span>
                    </div>
                  </div>
                  <div class="right">
                    <p-tag
                      [value]="o.is_preventa ? 'Preventa' : 'Campo'"
                      [severity]="o.is_preventa ? 'info' : 'secondary'"
                      styleClass="origin-tag"
                    ></p-tag>
                    <div class="total">{{ fmtMoney(o.total) }}</div>
                  </div>
                  <i class="pi chevron" [ngClass]="isOpen(o.id) ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
                </div>
                @if (isOpen(o.id)) {
                  <div class="lines">
                    @if (linesLoading().has(o.id)) {
                      <p-skeleton height="60px"></p-skeleton>
                    }
                    @if (!linesLoading().has(o.id)) {
                      @for (l of linesOf(o.id); track l) {
                        <div class="line">
                          <span class="qty">{{ l.quantity }}×</span>
                          <span class="pname">{{ l.product_name || l.product_id }}</span>
                          <span class="ltotal">{{ fmtMoney(l.line_total) }}</span>
                        </div>
                      }
                      @if (linesOf(o.id).length === 0) {
                        <div class="line empty-line">Sin líneas.</div>
                      }
                    }
                  </div>
                }
                <div class="actions">
                  <!-- Corregir sin cancelar: hasta acá la única salida era cancelar el
                       pedido y recapturarlo entero. Entregado no aparece: eso es devolución. -->
                  <button pButton size="small" [text]="true" [loading]="processing().has(o.id)" (click)="askReopen(o)"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span><span class="p-button-label">Corregir</span></button>
                  @if (kind === 'approve') {
                    <button pButton size="small" [loading]="processing().has(o.id)" (click)="askApprove(o)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Aprobar</span></button>
                  }
                  @if (kind === 'deliver') {
                    <button pButton severity="success" size="small" [loading]="processing().has(o.id)" (click)="askFulfill(o)"><span class="p-button-icon p-button-icon-left pi pi-truck" aria-hidden="true"></span><span class="p-button-label">Marcar entregado</span></button>
                  }
                </div>
              </p-card>
            }
          </div>
        </div>
      }
    </ng-template>
    `,
  styles: [
    `
      .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
      .page-title { margin: 0 0 0.25rem; font-size: 1.5rem; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: var(--fs-body); }
      .refresh { flex-shrink: 0; width: 2.1rem; height: 2.1rem; border-radius: 50%; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); display: grid; place-items: center; cursor: pointer; transition: transform 0.08s var(--ease, ease); }
      .refresh:active { transform: scale(0.92); } .refresh:disabled { opacity: 0.6; }
      .refresh i { font-size: 0.9rem; }
      .refresh.spinning i { animation: pend-spin 0.8s linear infinite; }
      @keyframes pend-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .refresh.spinning i { animation: none; } }
      .empty { text-align: center; padding: 1.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; color: var(--ok-fg); }
      .section { margin-bottom: 1.25rem; }
      .section-title {
        margin: 0 0 0.5rem;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }
      .order-list { display: flex; flex-direction: column; gap: 0.5rem; }
      :host ::ng-deep .p-card.order-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.order-card .p-card-body { padding: 0.75rem 0.875rem; }
      :host ::ng-deep .p-card.order-card .p-card-content { padding: 0; }
      :host ::ng-deep .origin-tag .p-tag { font-size: 0.65rem; }
      .order-head { display: flex; align-items: center; gap: 0.75rem; cursor: pointer; }
      .info { flex: 1; min-width: 0; }
      .customer {
        font-weight: 600;
        color: var(--text-main);
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub { display: flex; gap: 0.625rem; font-size: var(--fs-xs); color: var(--text-muted); margin-top: 0.125rem; }
      .folio { font-weight: 600; }
      .right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; flex-shrink: 0; }
      .total { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .chevron { color: var(--text-muted); font-size: 0.85rem; flex-shrink: 0; }
      .lines {
        margin-top: 0.625rem;
        padding-top: 0.625rem;
        border-top: 1px dashed var(--border-color);
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .line { display: flex; gap: 0.5rem; font-size: 0.8rem; color: var(--text-main); align-items: baseline; }
      .line .qty { font-weight: 700; color: var(--brand-700); min-width: 2.25rem; }
      .line .pname { flex: 1; min-width: 0; }
      .line .ltotal { font-variant-numeric: tabular-nums; color: var(--text-muted); }
      .empty-line { color: var(--text-muted); font-style: italic; }
      .actions { margin-top: 0.75rem; display: flex; justify-content: flex-end; }
      /* [MCP.30] El buscador de pedidos: 44 px, 16 px de letra (iOS no hace zoom al enfocarlo). */
      .pe-bs { position: relative; margin-bottom: var(--sp-3); }
      .pe-bs > .pi-box { position: absolute; left: var(--sp-3); top: 50%; transform: translateY(-50%); color: var(--text-faint); pointer-events: none; }
      .pe-bs-in { width: 100%; min-height: var(--tap-min); padding: 0 var(--tap-min) 0 calc(var(--sp-3) * 2 + 1rem); font-family: inherit; font-size: 1rem;
        border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); }
      .pe-bs-in:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
      .pe-bs-in::-webkit-search-cancel-button { display: none; }
      .pe-bs-x { position: absolute; right: 0; top: 0; width: var(--tap-min); height: var(--tap-min); border: 0; background: none; color: var(--text-muted); cursor: pointer; }
      .pe-bs-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
      .pe-nota { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
      .pe-nota b { color: var(--text-main); }
      .pe-tope { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--info-border); border-radius: var(--r-md); background: var(--info-soft-bg); color: var(--info-soft-fg); }
      .pe-aviso { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--warn-border); border-radius: var(--r-md); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .pe-re { border: 0; background: none; color: inherit; font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; min-height: var(--tap-min); }
      .empty .pe-ico-muted { color: var(--text-faint); }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorPendingComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  readonly loading = signal(true);
  /** Falló la carga (red) — distinto de "sin pendientes" (estándar PWA §5). */
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly orders = signal<VendorOrder[]>([]);

  /** Formatters reutilizados — no instanciar Intl por fila (estándar PWA perf). */
  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  private readonly dateFmt = new Intl.DateTimeFormat('es-MX', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  /** `[MCP.30]` Cuántos pendientes hay de verdad (la lista trae como mucho {@link POR_ENTREGAR_TOPE}). */
  readonly total = signal(0);

  // ─── [MCP.30] Buscador ───
  readonly busqueda = signal('');
  readonly enBusqueda = computed(() => largoUtil(this.busqueda()) >= BUSQUEDA_MINIMO);
  readonly resultados = signal<{ data: VendorOrder[]; total: number } | null>(null);
  readonly errorBusqueda = signal<string | null>(null);
  readonly sinSenal = signal(false);
  private readonly busquedas = new Subject<string>();

  /** Lo que se ve: los resultados mientras busca, si no la lista. Las dos secciones salen de aquí. */
  readonly fuente = computed<VendorOrder[]>(() => (this.enBusqueda() ? (this.resultados()?.data ?? []) : this.orders()));
  readonly toApprove = computed(() => this.fuente().filter((o) => o.status === 'pending_approval'));
  readonly toDeliver = computed(() => this.fuente().filter((o) => o.status === 'confirmed'));

  readonly open = signal<Set<string>>(new Set());
  readonly linesById = signal<Record<string, OrderLine[]>>({});
  readonly linesLoading = signal<Set<string>>(new Set());
  readonly processing = signal<Set<string>>(new Set());
  /** `[MCP.18]` El pedido al que se le está pidiendo el motivo de «Corregir»; `null` = hoja cerrada. */
  readonly corrigiendo = signal<VendorOrder | null>(null);
  readonly guardandoMotivo = signal(false);
  readonly motivosCorregir = MOTIVOS_CORREGIR;

  ngOnInit(): void {
    this.conectarBuscador();
    this.reload();
  }

  /** `[MCP.30]` Lo que escribió: con 2 letras o números o más, busca en el servidor. */
  buscar(v: string): void {
    this.busqueda.set(v);
    this.errorBusqueda.set(null);
    this.resultados.set(null);
    if (!this.enBusqueda()) {
      this.sinSenal.set(false);
      return;
    }
    this.busquedas.next(v);
  }

  rebuscar(): void {
    if (!this.enBusqueda()) return;
    this.errorBusqueda.set(null);
    this.busquedas.next(this.busqueda());
  }

  private conectarBuscador(): void {
    this.busquedas.pipe(
      debounceTime(BUSQUEDA_ESPERA_MS),
      switchMap((q) => {
        if (largoUtil(q) < BUSQUEDA_MINIMO) return of(null);
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return of({ q, r: null, sinRed: true, msg: null });
        return this.api.pendingDeliveriesPage(q).pipe(
          map((r) => ({ q, r, sinRed: false, msg: null as string | null })),
          catchError((e: { status?: number; error?: { message?: string } }) =>
            of({ q, r: null, sinRed: e?.status === 0, msg: e?.error?.message || 'No se pudo buscar. Intenta de nuevo.' })),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((x) => {
      if (!x || x.q !== this.busqueda()) return; // escribió otra cosa mientras tanto
      this.sinSenal.set(x.sinRed);
      if (x.r) this.resultados.set(x.r);
      else if (!x.sinRed) this.errorBusqueda.set(x.msg);
    });
  }

  reload(silent = false): void {
    if (silent) this.refreshing.set(true);
    else this.loading.set(true);
    this.loadError.set(false);
    this.rebuscar();
    this.api
      .pendingDeliveriesPage()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ data: list, total }) => {
          this.orders.set(list);
          this.total.set(total);
          this.loading.set(false);
          this.refreshing.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.refreshing.set(false);
          this.loadError.set(true);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar los pendientes' });
        },
      });
  }

  /** Refresh manual: trae pendientes nuevos sin blanquear la pantalla. */
  refresh(): void {
    if (this.refreshing()) return;
    this.reload(true);
  }

  isOpen(id: string): boolean {
    return this.open().has(id);
  }
  linesOf(id: string): OrderLine[] {
    return this.linesById()[id] || [];
  }

  toggle(o: VendorOrder): void {
    const next = new Set(this.open());
    if (next.has(o.id)) {
      next.delete(o.id);
      this.open.set(next);
      return;
    }
    next.add(o.id);
    this.open.set(next);
    if (this.linesById()[o.id]) return; // ya cacheado

    const loading = new Set(this.linesLoading());
    loading.add(o.id);
    this.linesLoading.set(loading);
    this.api
      .orderById(o.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (full) => {
          this.linesById.set({ ...this.linesById(), [o.id]: full?.lines || [] });
          this.clearLoading(o.id);
        },
        error: () => {
          this.linesById.set({ ...this.linesById(), [o.id]: [] });
          this.clearLoading(o.id);
        },
      });
  }

  askApprove(o: VendorOrder): void {
    this.confirmSvc.confirm({
      header: 'Aprobar pedido',
      message: `¿Aprobar ${o.folio || o.code} de ${o.customer_name || 'este cliente'}? Quedará listo para entregar.`,
      icon: 'pi pi-check-circle',
      acceptLabel: 'Aprobar',
      rejectLabel: 'Cancelar',
      accept: () => this.run(o, this.api.approve(o.id), 'Pedido aprobado'),
    });
  }

  /**
   * Corregir un pedido ya agendado: lo reabre como borrador (mismo folio) y lleva
   * al vendedor a la pantalla de captura, con el pedido cargado. Si el backend
   * rechaza —otro vendedor, ya entregado, o el cliente con otro pedido en curso—
   * se muestra el motivo tal cual y NO se navega.
   *
   * `[MCP.18]` Primero se pregunta si se puede (D1: con el surtido empezado ya no): así no se le pide
   * el motivo para después decirle que no. Si se puede, se pide el justificante y con él se reabre.
   */
  askReopen(o: VendorOrder): void {
    if (this.processing().has(o.id)) return;
    const busy = new Set(this.processing());
    busy.add(o.id);
    this.processing.set(busy);
    this.api
      .puedeCorregir(o.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.clearProcessing(o.id);
          this.corrigiendo.set(o);
        },
        error: (e) => {
          this.clearProcessing(o.id);
          this.toast.add({
            severity: 'warn',
            summary: 'No se puede corregir',
            detail: e?.error?.message || 'Intenta de nuevo.',
            life: 12000,
          });
        },
      });
  }

  /** `[MCP.18]` Con el motivo elegido, se reabre y se va a corregir. */
  confirmarCorregir(o: VendorOrder, motivo: MotivoElegido): void {
    if (this.guardandoMotivo()) return;
    this.guardandoMotivo.set(true);
    this.api
      .reopenOrder(o.id, motivo)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.guardandoMotivo.set(false);
          this.corrigiendo.set(null);
          if (!o.customer_id) {
            this.toast.add({ severity: 'warn', summary: 'Pedido reabierto', detail: 'Ábrelo desde el cliente para corregirlo.' });
            this.reload();
            return;
          }
          this.router.navigate(['/vendor/take-order', o.customer_id], {
            queryParams: { order: o.id },
          });
        },
        error: (e) => {
          this.guardandoMotivo.set(false);
          this.corrigiendo.set(null);
          this.toast.add({
            severity: 'error',
            summary: 'No se puede corregir',
            detail: e?.error?.message || 'Intenta de nuevo.',
            life: 12000,
          });
        },
      });
  }

  askFulfill(o: VendorOrder): void {
    this.confirmSvc.confirm({
      header: 'Marcar entregado',
      message: `¿Confirmas la entrega de ${o.folio || o.code} a ${o.customer_name || 'este cliente'}? Se descuenta del inventario.`,
      icon: 'pi pi-truck',
      acceptLabel: 'Entregar',
      rejectLabel: 'Cancelar',
      accept: () => this.run(o, this.api.fulfill(o.id), 'Pedido entregado'),
    });
  }

  private run(o: VendorOrder, op: ReturnType<VendorService['approve']>, okMsg: string): void {
    const busy = new Set(this.processing());
    busy.add(o.id);
    this.processing.set(busy);
    op.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.add({ severity: 'success', summary: okMsg, detail: o.folio || o.code });
        this.clearProcessing(o.id);
        this.reload();
      },
      error: (e) => {
        this.clearProcessing(o.id);
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo completar',
          detail: e?.error?.message || 'Intenta de nuevo.',
        });
      },
    });
  }

  private clearLoading(id: string): void {
    const s = new Set(this.linesLoading());
    s.delete(id);
    this.linesLoading.set(s);
  }
  private clearProcessing(id: string): void {
    const s = new Set(this.processing());
    s.delete(id);
    this.processing.set(s);
  }

  fmtMoney(n: unknown): string {
    return this.money.format(Number(n) || 0);
  }
  fmtTime(s: string): string {
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : this.dateFmt.format(d);
  }
}
