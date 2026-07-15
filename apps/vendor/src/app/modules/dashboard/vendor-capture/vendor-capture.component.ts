import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { DailyCaptureService } from '../captures/daily-capture.service';
import { RoutePingService } from '../../../core/services/route-ping.service';
import { buildVisitFormData } from '../../../core/http/visit-form-data';
import { OfflineSyncService } from '../../../core/services/offline-sync.service';
import type { PendingVendorSale } from '../../../core/services/offline-database.service';

const TRANSIENT_STATUSES = new Set([0, 408, 500, 502, 503, 504, 522, 524]);
const isTransientStatus = (status: number | undefined): boolean =>
  status === undefined || TRANSIENT_STATUSES.has(status);

interface OcrItem {
  raw: string;
  quantity: number;
  sku: string | null; // identificador del set activo ERP (match del ticket)
  product_name: string | null;
  brand_name: string | null;
  confidence: string; // high|medium|low|no_match
  confirmed: boolean;
  inPlanogram?: boolean; // su sku está en trade.planogram_skus → va a la visita
  planogramProductId?: string | null; // catalog UUID canónico (para productosMarcados de la visita)
}

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
];

/**
 * Captura diaria especial del vendedor. Replica el layout de /captures (header
 * VISITA + banner RUTA DE HOY + empty-state + banner Tienda Detectada). Flujo:
 * iniciar (GPS+tienda) → foto exhibidor + foto ticket (OCR) → guardar. Los
 * productos van a DOS destinos (2 llamadas, no atómicas por boundaries):
 *   - venta: POST /commercial/vendor-sales (líneas confirmadas)
 *   - visita SIN ponderación: POST /daily-captures (skip_scoring=true), productos
 *     de planograma (confidence high/medium).
 * Reusa DailyCaptureService para GPS/tienda/ruta/catálogos.
 */
@Component({
  selector: 'app-vendor-capture',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, ToastModule, SelectModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="px-6 pt-6 pb-6 space-y-6">

      <!-- Encabezado -->
      <div class="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 md:w-14 md:h-14 rounded-2xl bg-brand border border-divider flex flex-col items-center justify-center shrink-0">
            <span class="text-[10px] md:text-xs font-black text-black uppercase leading-none">Visita</span>
            <span class="text-xl md:text-2xl font-black text-black">#{{ visitaNumero() }}</span>
          </div>
          <div>
            <h2 class="text-xl md:text-2xl font-bold text-content-main leading-tight tracking-tighter flex items-center gap-3">
              <i class="pi pi-file-edit text-content-main"></i> Captura de Vendedor
            </h2>
            <p class="text-xs md:text-sm text-content-dim">
              Capturador: <span class="font-bold text-content-main">{{ user()?.username }}</span>
              <span class="mx-2 opacity-30">|</span>
              <ng-container *ngIf="customer(); else noCustomerSub">Cliente: <span class="font-bold text-content-main">{{ customer()?.name }}</span></ng-container>
              <ng-template #noCustomerSub>Inicio: <span class="font-bold text-content-main">—</span></ng-template>
            </p>
          </div>
        </div>
        <div class="flex gap-2 w-full md:w-auto">
          <p-button *ngIf="svc.hasActiveVisit()" label="Cancelar" icon="pi pi-times"
                    severity="secondary" [outlined]="true" (onClick)="cancel()"
                    [disabled]="saving()" styleClass="w-full md:w-auto"></p-button>
        </div>
      </div>

      <!-- Ruta de hoy -->
      <div class="bg-brand/10 border border-brand/20 p-3 sm:p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-in fade-in slide-in-from-top-4 duration-500">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-brand/20 flex items-center justify-center text-brand shrink-0">
            <i class="pi pi-map text-lg sm:text-xl"></i>
          </div>
          <div *ngIf="route() && !changingRoute()" class="min-w-0">
            <div class="text-[10px] sm:text-xs font-semibold uppercase tracking-[0.15em] text-brand truncate">Ruta de Hoy</div>
            <div class="text-sm sm:text-lg font-black text-content-main uppercase truncate">{{ route()?.name }}</div>
            <button type="button" (click)="changingRoute.set(true)" class="btn-ghost btn-ghost-brand mt-1 text-xs" aria-label="Cambiar ruta">Cambiar ruta</button>
          </div>
          <div *ngIf="!route() || changingRoute()" class="min-w-0 flex-1">
            <div class="text-[10px] sm:text-xs font-semibold uppercase tracking-[0.15em] text-brand mb-1">¿En qué ruta estás hoy?</div>
            <p-select
                [options]="zoneRoutes()"
                [ngModel]="route()?.id"
                (onChange)="onSelectRoute($event.value)"
                optionLabel="label"
                optionValue="value"
                placeholder="Seleccioná tu ruta"
                appendTo="body"
                styleClass="w-full sm:w-64"
                [filter]="zoneRoutes().length > 8"></p-select>
            <div *ngIf="zoneRoutes().length === 0" class="text-[10px] sm:text-xs text-content-muted mt-1">No hay rutas para tu zona. Avisá a tu supervisor.</div>
          </div>
        </div>
        <div *ngIf="visitaNumero() > 1" class="bg-surface-card px-3 py-2 rounded-xl border border-divider shadow-sm flex items-center gap-3 self-start sm:self-auto">
          <div class="flex flex-col items-end">
            <span class="text-[10px] sm:text-xs font-semibold text-content-faint uppercase tracking-[0.12em]">Progreso de Jornada</span>
            <span class="text-xs sm:text-sm font-bold text-content-main">Visita #{{ visitaNumero() }}</span>
          </div>
        </div>
      </div>

      <!-- Banner del Cliente (captura customer-driven) -->
      <div *ngIf="svc.hasActiveVisit() && customer()"
           class="bg-ok-soft-bg border border-ok-border p-3 sm:p-4 rounded-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-500">
        <div class="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-surface-card border border-ok-border flex items-center justify-center text-ok-fg shrink-0">
          <i class="pi pi-shop text-lg sm:text-xl"></i>
        </div>
        <div class="min-w-0">
          <div class="text-[10px] sm:text-xs font-semibold uppercase tracking-[0.15em] text-ok-fg truncate">Cliente</div>
          <div class="text-sm sm:text-lg font-black text-content-main uppercase truncate">{{ customer()?.name }}</div>
        </div>
      </div>

      <!-- Auto-inicio: loading mientras captura GPS + detecta tienda (sin pantalla intermedia). -->
      <div *ngIf="starting()" class="p-12 text-center bg-surface-card border border-divider rounded-xl">
        <div class="w-16 h-16 rounded-full bg-surface-ground border border-divider flex items-center justify-center mx-auto mb-4 text-brand-orange">
          <i class="pi pi-spin pi-spinner text-2xl"></i>
        </div>
        <h3 class="text-lg font-bold text-content-main mb-2">Iniciando visita…</h3>
        <p class="text-sm text-content-dim max-w-sm mx-auto">Capturando tu ubicación.</p>
      </div>

      <!-- Sin visita y sin iniciar: error+reintento, elegí ruta, o preparando. -->
      <ng-container *ngIf="!svc.hasActiveVisit() && !starting()">
        <div class="p-12 text-center bg-surface-card border border-divider rounded-xl">
          <ng-container *ngIf="startError(); else needRouteOrPrep">
            <div class="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mx-auto mb-4 text-amber-500">
              <i class="pi pi-exclamation-triangle text-2xl"></i>
            </div>
            <h3 class="text-lg font-bold text-content-main mb-2">No se pudo iniciar la visita</h3>
            <p class="text-sm text-content-dim mb-6 max-w-sm mx-auto">{{ startError() }}</p>
            <p-button label="Reintentar" icon="pi pi-refresh" (onClick)="start()"
                      [disabled]="needsRoute() || starting()" styleClass="p-button-brand"></p-button>
          </ng-container>
          <ng-template #needRouteOrPrep>
            <ng-container *ngIf="needsRoute(); else preparing">
              <div class="w-16 h-16 rounded-full bg-surface-ground border border-divider flex items-center justify-center mx-auto mb-4 text-content-muted shadow-inner">
                <i class="pi pi-map text-2xl"></i>
              </div>
              <h3 class="text-lg font-bold text-content-main mb-2">Elegí tu ruta</h3>
              <p class="text-sm text-content-dim max-w-sm mx-auto">Seleccioná tu ruta de hoy arriba para iniciar la visita.</p>
            </ng-container>
            <ng-template #preparing>
              <div class="w-16 h-16 rounded-full bg-surface-ground border border-divider flex items-center justify-center mx-auto mb-4 text-brand-orange">
                <i class="pi pi-spin pi-spinner text-2xl"></i>
              </div>
              <h3 class="text-lg font-bold text-content-main mb-2">Preparando…</h3>
            </ng-template>
          </ng-template>
        </div>
      </ng-container>

      <!-- Flujo de captura (visita activa anclada al cliente) -->
      <ng-container *ngIf="svc.hasActiveVisit() && customer()">

        <!-- Foto del exhibidor -->
        <div class="bg-surface-card border border-divider rounded-2xl p-5 space-y-4">
          <header class="space-y-1">
            <h3 class="text-base font-semibold text-content-main">Evidencia fotográfica</h3>
            <p class="text-xs text-content-muted leading-relaxed">Una foto del exhibidor es obligatoria para registrar la visita.</p>
          </header>
          <!-- HV (b): encuadre guiado. El audit HV.0 mostró que las fotos salen muy
               abiertas (se marcan ~37 productos y en la foto se leen ~8). Estas 3 reglas
               suben la legibilidad para que la IA reconozca marcas y productos. -->
          <div *ngIf="!exhibidorPreview()" class="rounded-xl bg-brand-orange/5 border border-brand-orange/20 p-3 space-y-2">
            <p class="text-xs font-semibold text-brand-orange flex items-center gap-1.5">
              <i class="pi pi-sparkles text-[0.7rem]" aria-hidden="true"></i> Para que la IA lea bien el exhibidor
            </p>
            <ul class="text-xs text-content-muted space-y-1.5">
              <li class="flex items-start gap-2"><i class="pi pi-search text-[0.7rem] mt-0.5 text-brand-orange/70" aria-hidden="true"></i><span><strong class="text-content-main">Acercate</strong>: que se lean las marcas en los empaques, no la tienda entera.</span></li>
              <li class="flex items-start gap-2"><i class="pi pi-th-large text-[0.7rem] mt-0.5 text-brand-orange/70" aria-hidden="true"></i><span><strong class="text-content-main">Enfocá tu sección</strong>: si el exhibidor es grande, encuadrá la zona con más producto propio.</span></li>
              <li class="flex items-start gap-2"><i class="pi pi-sun text-[0.7rem] mt-0.5 text-brand-orange/70" aria-hidden="true"></i><span><strong class="text-content-main">Buena luz y de frente</strong>: sin reflejos ni sombras sobre los productos.</span></li>
            </ul>
          </div>
          <label *ngIf="!exhibidorPreview()"
                 class="block border-2 border-dashed border-divider rounded-xl p-8 text-center bg-surface-ground/40 motion-safe:transition-colors hover:bg-surface-ground hover:border-brand-orange/40 cursor-pointer relative focus-within:ring-2 focus-within:ring-brand-orange focus-within:ring-offset-2">
            <input type="file" accept="image/*" capture="environment" (change)="onExhibidor($event)"
                   class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" aria-label="Tomar fotografía del exhibidor">
            <div class="w-14 h-14 rounded-full bg-brand-orange/10 text-brand-orange flex items-center justify-center mx-auto mb-4">
              <i class="pi pi-camera text-2xl" aria-hidden="true"></i>
            </div>
            <p class="text-sm font-medium text-content-main">Tomar fotografía</p>
            <p class="text-xs text-content-muted mt-1">Toca para abrir la cámara</p>
          </label>
          <div *ngIf="exhibidorPreview()" class="space-y-3">
            <div class="relative rounded-xl border border-divider overflow-hidden bg-black max-w-sm mx-auto">
              <img [src]="exhibidorPreview()!" alt="Vista previa del exhibidor" class="w-full h-64 object-cover">
            </div>
            <div class="flex justify-center">
              <p-button icon="pi pi-refresh" label="Cambiar foto" severity="secondary" [outlined]="true" size="small" (onClick)="removeExhibidor()"></p-button>
            </div>
          </div>
        </div>

        <!-- Ticket de venta -->
        <div class="bg-surface-card border border-divider rounded-2xl p-5 space-y-4">
          <header class="space-y-1">
            <h3 class="text-base font-semibold text-content-main">Ticket de venta</h3>
            <p class="text-xs text-content-muted leading-relaxed">Si el ticket es largo, tomá varias fotos para que se lea bien. La IA detecta los productos; solo los del planograma se registran en la visita.</p>
          </header>
          <label *ngIf="!ticketPhotos().length"
                 class="block border-2 border-dashed border-divider rounded-xl p-8 text-center bg-surface-ground/40 motion-safe:transition-colors hover:bg-surface-ground hover:border-brand-orange/40 cursor-pointer relative focus-within:ring-2 focus-within:ring-brand-orange focus-within:ring-offset-2">
            <input type="file" accept="image/*" capture="environment" (change)="onTicket($event)"
                   class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" aria-label="Tomar fotografía del ticket">
            <div class="w-14 h-14 rounded-full bg-brand-orange/10 text-brand-orange flex items-center justify-center mx-auto mb-4">
              <i class="pi pi-receipt text-2xl" aria-hidden="true"></i>
            </div>
            <p class="text-sm font-medium text-content-main">Tomar foto del ticket</p>
            <p class="text-xs text-content-muted mt-1">Toca para abrir la cámara</p>
          </label>

          <div *ngIf="ticketPhotos().length" class="space-y-3">
            <div class="flex gap-2 flex-wrap">
              <div *ngFor="let p of ticketPhotos(); let i = index" class="relative rounded-lg border border-divider overflow-hidden bg-black w-20 h-20">
                <img [src]="p" alt="Ticket {{ i + 1 }}" class="w-full h-full object-cover">
                <span class="absolute bottom-0 right-0 text-[9px] bg-black/60 text-white px-1 rounded-tl">{{ i + 1 }}</span>
              </div>
            </div>
            <div class="flex justify-center">
              <label class="inline-flex">
                <input type="file" accept="image/*" capture="environment" (change)="onTicket($event)" class="hidden" [disabled]="processing()">
                <span class="p-button p-button-sm p-button-secondary p-button-outlined inline-flex items-center gap-2 cursor-pointer" [class.opacity-60]="processing()">
                  <i class="pi pi-plus"></i> Agregar otra foto
                </span>
              </label>
            </div>
          </div>

          <div *ngIf="processing()" class="flex items-center gap-3 p-4 bg-surface-ground rounded-xl">
            <i class="pi pi-spin pi-spinner text-brand-orange text-xl"></i>
            <span class="text-sm text-content-muted">Leyendo ticket…</span>
          </div>

          <div *ngIf="items().length && !processing()" class="space-y-2">
            <div class="flex items-center justify-between text-sm">
              <span><strong>{{ confirmedCount() }}</strong> de {{ items().length }} confirmados</span>
              <span class="text-xs text-content-muted">{{ planogramCount() }} en planograma</span>
            </div>
            <ul class="flex flex-col gap-1.5 list-none p-0 m-0 max-h-80 overflow-y-auto">
              <li *ngFor="let it of items(); let i = index"
                  class="rounded-lg p-2.5 border"
                  [ngClass]="it.confirmed ? 'border-brand-orange/40 bg-brand-orange/5'
                            : !it.sku ? 'border-divider bg-surface-ground/40 opacity-60' : 'border-divider bg-surface-card'">
                <label class="flex gap-3 items-start cursor-pointer">
                  <input type="checkbox" [ngModel]="it.confirmed" [disabled]="!it.sku"
                         (ngModelChange)="toggleItem(i, $event)" class="mt-1 w-4 h-4 accent-brand-orange shrink-0" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-content-main truncate">{{ it.product_name || '— sin match —' }}</div>
                    <div class="text-xs text-content-muted mt-0.5" *ngIf="it.brand_name">{{ it.brand_name }}</div>
                    <div class="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span class="text-[10px] text-content-muted italic truncate">«{{ it.raw }}»</span>
                      <p-tag [severity]="confSeverity(it.confidence)" [value]="confLabel(it.confidence)" styleClass="text-[9px] py-0 px-1.5"></p-tag>
                      <span *ngIf="it.inPlanogram" class="text-[9px] bg-brand/20 text-brand px-1.5 py-0 rounded font-semibold uppercase tracking-wide">Planograma</span>
                      <span *ngIf="it.quantity > 1" class="text-[10px] bg-brand-orange text-white px-1.5 py-0 rounded font-semibold">×{{ it.quantity }}</span>
                    </div>
                  </div>
                </label>
              </li>
            </ul>
          </div>
        </div>

        <!-- OCR diferido (sin red al tomar el ticket) -->
        <div *ngIf="ticketOcrDeferred()" class="bg-amber-500/5 border border-amber-500/30 p-3 rounded-2xl flex items-center gap-3">
          <i class="pi pi-clock text-amber-500 text-xl" aria-hidden="true"></i>
          <div class="text-sm text-content-main">
            <strong>Reconocimiento diferido.</strong> Sin conexión al tomar el ticket: se guardará la foto y el reconocimiento se procesará al sincronizar.
          </div>
        </div>

        <!-- Guardar -->
        <div class="bg-surface-card border border-divider rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div class="text-sm text-content-dim">
            Venta: <strong class="text-content-main">{{ confirmedCount() }}</strong> líneas
            <span class="mx-2 opacity-30">|</span>
            Visita (planograma): <strong class="text-content-main">{{ planogramCount() }}</strong>
            <span *ngIf="ticketOcrDeferred()" class="ml-2 text-amber-500 text-xs uppercase tracking-wider font-semibold">· OCR diferido</span>
          </div>
          <p-button label="Guardar captura" icon="pi pi-check" styleClass="p-button-brand w-full sm:w-auto"
                    [loading]="saving()"
                    [disabled]="saving() || !exhibidorFile() || (confirmedCount() === 0 && !ticketOcrDeferred())"
                    (onClick)="save()"></p-button>
        </div>
      </ng-container>

      <!-- Historial de capturas de hoy -->
      <div *ngIf="visitasHoy().length" class="mt-6">
        <div class="flex items-center gap-2 mb-4">
          <i class="pi pi-history text-brand-orange"></i>
          <h3 class="text-lg font-bold text-content-main uppercase tracking-tight">Capturas de Hoy</h3>
        </div>
        <div class="bg-surface-card border border-divider rounded-2xl shadow-sm overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-content-muted uppercase bg-surface-ground border-b border-divider text-left">
                <th class="px-4 py-2">Folio</th>
                <th class="px-4 py-2">Productos</th>
                <th class="px-4 py-2">Hora</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let v of visitasHoy()" class="border-b border-divider last:border-0">
                <td class="px-4 py-2 font-mono font-bold text-content-main">#{{ v.folio }}</td>
                <td class="px-4 py-2 text-content-dim">{{ v.exhibiciones?.length || 0 }} items</td>
                <td class="px-4 py-2 text-content-dim">{{ v.horaFin }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  `,
})
export class VendorCaptureComponent implements OnInit, OnDestroy {
  readonly svc = inject(DailyCaptureService);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  // Instancia el tracker de breadcrumbs GPS (se autoarranca con la ruta activa).
  private readonly routePing = inject(RoutePingService);
  private readonly toast = inject(MessageService);
  private readonly offlineSync = inject(OfflineSyncService);
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly apiUrl = environment.apiUrl;

  /** Cliente comercial recibido por query param (?customerId&customerName). */
  private customerId: string | null = null;
  private customerName = '';

  readonly user = this.auth.user;

  readonly starting = signal(false);
  /** Mensaje de fallo del auto-inicio (GPS/tienda) para el estado de reintento. */
  readonly startError = signal<string | null>(null);
  /** Guard: el auto-inicio corre una sola vez por entrada a la pantalla. */
  private autoStartTried = false;

  constructor() {
    // Auto-inicia la visita apenas hay ruta resuelta (elimina la pantalla
    // intermedia "Listo para iniciar"): captura GPS + detecta la tienda sin un
    // tap extra. queueMicrotask saca el start() del ciclo del effect (no escribe
    // signals dentro del effect). Corre una sola vez por instancia (autoStartTried).
    effect(() => {
      const route = this.svc.activeRoute();
      const active = this.svc.hasActiveVisit();
      if (route && this.customerId && !active && !this.autoStartTried && !this.starting()) {
        this.autoStartTried = true;
        queueMicrotask(() => void this.start());
      }
    });
  }
  readonly exhibidorFile = signal<File | null>(null);
  readonly exhibidorPreview = signal<string | null>(null);
  readonly ticketPhotos = signal<string[]>([]); // previews; el vendedor puede tomar varias fotos del mismo ticket
  readonly processing = signal(false);
  readonly items = signal<OcrItem[]>([]);
  readonly saving = signal(false);
  readonly changingRoute = signal(false);
  readonly changingStore = signal(false);
  /** OCR del ticket diferido al sync (sin red al tomar la foto). */
  readonly ticketOcrDeferred = signal(false);

  private ticketUrl: string | null = null;
  private ticketPublicId: string | null = null;
  private syncUuid: string | null = null;
  /** Blob crudo del ticket para offline path (sync hace OCR diferido). */
  private ticketBlob: Blob | null = null;

  readonly store = this.svc.detectedStore;
  readonly customer = this.svc.activeCustomer;
  readonly nearby = this.svc.nearbyStores;
  readonly route = this.svc.activeRoute;
  readonly zoneRoutes = this.svc.zoneRoutes;
  readonly visitasHoy = this.svc.visitasHoy;
  readonly needsRoute = computed(() => !this.svc.activeRoute());

  readonly visitaNumero = computed(() => this.svc.visitasHoy().length + 1);
  readonly confirmedCount = computed(() => this.items().filter((i) => i.confirmed && i.sku).length);
  readonly planogramCount = computed(
    () => this.items().filter((i) => i.confirmed && i.inPlanogram && i.planogramProductId).length,
  );

  ngOnInit(): void {
    // Captura customer-driven: el cliente llega por query param desde el menú de
    // opciones. Sin customerId no se auto-inicia (la captura es siempre por cliente).
    const qp = this.activatedRoute.snapshot.queryParamMap;
    this.customerId = qp.get('customerId');
    this.customerName = qp.get('customerName') || '';
    if (!this.customerId) {
      this.startError.set('Abrí la captura desde el menú de un cliente (Buscar cliente o Mi ruta).');
    }
    this.svc.refreshAll(); // catálogos + asignación de ruta
  }

  ngOnDestroy(): void {
    this.svc.clearActiveState();
  }

  async start(): Promise<void> {
    if (this.starting()) return;
    if (!this.customerId) {
      this.startError.set('Entrá a capturar desde el menú de un cliente.');
      return;
    }
    if (this.needsRoute()) {
      this.toast.add({ severity: 'warn', summary: 'Elegí tu ruta', detail: 'Seleccioná tu ruta de hoy antes de iniciar.' });
      return;
    }
    this.starting.set(true);
    this.startError.set(null);
    try {
      await this.svc.iniciarVisitaParaCliente({ id: this.customerId, name: this.customerName || 'Cliente' });
    } catch (e: any) {
      this.startError.set(e?.message || 'No se pudo capturar la ubicación. Verificá que el GPS esté activado.');
      this.toast.add({ severity: 'error', summary: 'Error de GPS', detail: e?.message || 'No se pudo capturar la ubicación.' });
    } finally {
      this.starting.set(false);
    }
  }

  cancel(): void {
    this.reset();
    this.router.navigate(['/vendor']);
  }

  onSelectStore(id: string): void {
    const s = this.nearby().find((x) => x.id === id);
    if (s) this.svc.selectStore(s);
    this.changingStore.set(false);
  }

  onSelectRoute(id: string): void {
    if (!id) {
      this.svc.setActiveRoute(null);
      return;
    }
    const opt = this.zoneRoutes().find((r) => r.value === id);
    this.svc.setActiveRoute(opt ? { id: opt.value, name: opt.label } : { id, name: id });
    this.changingRoute.set(false);
  }

  onExhibidor(ev: Event): void {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      this.toast.add({ severity: 'warn', summary: 'Formato no soportado', detail: file.type });
      return;
    }
    this.exhibidorFile.set(file);
    const reader = new FileReader();
    reader.onload = () => this.exhibidorPreview.set(reader.result as string);
    reader.readAsDataURL(file);
  }

  removeExhibidor(): void {
    this.exhibidorFile.set(null);
    this.exhibidorPreview.set(null);
  }

  async onTicket(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      this.toast.add({ severity: 'warn', summary: 'Formato no soportado', detail: file.type });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this.ticketPhotos.update((p) => [...p, reader.result as string]);
    reader.readAsDataURL(file);

    // Guardamos SIEMPRE el Blob de la primera foto: si luego el save cae a
    // offline (red murió entre OCR y save), el sync diferido lo necesita.
    if (!this.ticketBlob) this.ticketBlob = file;

    // Offline-first: si no hay red, no intentamos OCR — se difiere al sync.
    if (!navigator.onLine) {
      this.ticketOcrDeferred.set(true);
      this.toast.add({
        severity: 'info',
        summary: 'Sin conexión',
        detail: 'La foto del ticket se guardará. El reconocimiento se procesará al sincronizar.',
      });
      return;
    }

    this.processing.set(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'ticket.jpg');
      // Timeout cliente apenas por encima del deadline server (45s): si el server
      // responde 504 limpio, ese gana; si igual cuelga, cortamos a los 50s en vez
      // de esperar a que el navegador cancele (~2min → 502).
      const res = await firstValueFrom(
        this.http.post<any>(`${this.apiUrl}/ai/ticket/extract`, fd).pipe(timeout(50_000)),
      );
      // Primera foto = ticket de referencia para la venta/visita.
      if (!this.ticketUrl) {
        this.ticketUrl = res?.ticket_url ?? null;
        this.ticketPublicId = res?.ticket_public_id ?? null;
      }
      const ocr: OcrItem[] = (res?.match?.items || []).map((it: any) => {
        const conf = it.suggested?.confidence ?? it.confidence ?? 'no_match';
        return {
          raw: it.raw,
          quantity: Number(it.quantity) || 1,
          sku: it.suggested?.sku ?? null,
          product_name: it.suggested?.product_name ?? null,
          brand_name: it.suggested?.brand_name ?? null,
          confidence: conf,
          confirmed: !!it.suggested?.sku && conf !== 'no_match',
        };
      });
      this.mergeOcrItems(ocr);
      await this.matchPlanogram();
      this.ticketOcrDeferred.set(false);
      this.toast.add({
        severity: ocr.length ? 'success' : 'warn',
        summary: ocr.length ? `${ocr.length} productos detectados` : 'Ticket ilegible',
        detail: ocr.length ? `${this.confirmedCount()} confirmados` : 'Tomá la foto con mejor luz.',
      });
    } catch (e: any) {
      // Si la falla es transient (red caída mid-flight, 500/504 del server, o
      // timeout cliente), no bloqueamos: la foto ya está en ticketBlob y el sync
      // diferirá el OCR.
      if (e instanceof TimeoutError || isTransientStatus(e?.status)) {
        this.ticketOcrDeferred.set(true);
        this.toast.add({
          severity: 'warn',
          summary: 'OCR no disponible',
          detail: 'La foto se guardará y el reconocimiento se procesará al sincronizar.',
        });
      } else {
        this.toast.add({ severity: 'error', summary: 'OCR falló', detail: e?.error?.message || 'Intentá de nuevo.' });
      }
    } finally {
      this.processing.set(false);
    }
  }

  toggleItem(i: number, checked: boolean): void {
    this.items.update((arr) => arr.map((it, idx) => (idx === i ? { ...it, confirmed: checked } : it)));
  }

  /** Acumula items OCR de varias fotos: dedupe por sku (mayor cantidad). */
  private mergeOcrItems(incoming: OcrItem[]): void {
    this.items.update((prev) => {
      const result = prev.map((p) => ({ ...p }));
      const byId = new Map<string, OcrItem>();
      for (const r of result) if (r.sku) byId.set(r.sku, r);
      for (const it of incoming) {
        if (it.sku && byId.has(it.sku)) {
          const d = byId.get(it.sku)!;
          d.quantity = Math.max(d.quantity, it.quantity);
        } else {
          const copy = { ...it };
          result.push(copy);
          if (copy.sku) byId.set(copy.sku, copy);
        }
      }
      return result;
    });
  }

  /**
   * Relaciona los productos vendidos (sku del set activo) con el planograma de
   * trade. Respuesta [{sku, product_id}] — marca inPlanogram + guarda el
   * product_id canónico (catalog) para la visita. Los que no matchean no van a
   * la visita (evita dulces fuera de planograma / duplicados en reportes).
   */
  private async matchPlanogram(): Promise<void> {
    const skus = Array.from(
      new Set(this.items().map((i) => i.sku).filter((x): x is string => !!x)),
    );
    if (skus.length === 0) return;
    try {
      const matched = await firstValueFrom(
        this.http.post<{ sku: string; product_id: string }[]>(
          `${this.apiUrl}/planograms/brands/match-skus`,
          { skus },
        ),
      );
      const bySku = new Map((matched || []).map((m) => [m.sku, m.product_id]));
      this.items.update((arr) =>
        arr.map((it) => ({
          ...it,
          inPlanogram: !!it.sku && bySku.has(it.sku),
          planogramProductId: it.sku ? bySku.get(it.sku) ?? null : null,
        })),
      );
    } catch {
      // best-effort: si falla, no taggeamos planograma (la visita quedará sin productos).
    }
  }

  confSeverity(c: string): 'success' | 'warn' | 'danger' | 'secondary' {
    return c === 'high' ? 'success' : c === 'medium' ? 'warn' : c === 'low' ? 'danger' : 'secondary';
  }

  confLabel(c: string): string {
    return c === 'high' ? 'Alta' : c === 'medium' ? 'Media' : c === 'low' ? 'Baja' : 'Sin match';
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    const cust = this.customer();
    if (!cust) return;
    const lat = this.svc.latitud();
    const lng = this.svc.longitud();
    if (!lat || !lng) {
      this.toast.add({ severity: 'error', summary: 'Sin GPS', detail: 'Re-iniciá la captura para tomar ubicación.' });
      return;
    }
    if (!this.exhibidorFile()) {
      this.toast.add({ severity: 'warn', summary: 'Falta foto', detail: 'Tomá la foto del exhibidor.' });
      return;
    }

    const confirmed = this.items().filter((i) => i.confirmed && i.sku);
    // OCR diferido (sin red al tomar ticket): permitimos guardar sin items
    // si hay ticketBlob — el sync correrá OCR y populará la venta automáticamente.
    const ocrDeferred = this.ticketOcrDeferred() && !!this.ticketBlob;
    if (confirmed.length === 0 && !ocrDeferred) return;

    this.saving.set(true);
    this.syncUuid = this.syncUuid || this.newUuid();
    const today = this.todayMx();
    const userId = this.auth.user()?.sub || '';

    // Productos que matchean el planograma de trade (dedup), con su product_id
    // CANÓNICO (catalog). En modo OCR-diferido va vacío y el sync lo rellena.
    const planogramPids = Array.from(
      new Set(
        confirmed
          .filter((i) => i.inPlanogram && i.planogramProductId)
          .map((i) => i.planogramProductId as string),
      ),
    );

    const visitPayload: any = {
      folio: this.makeFolio(),
      sync_uuid: this.syncUuid,
      horaInicio: this.svc.horaInicio() || new Date().toISOString(),
      horaFin: new Date().toISOString(),
      latitud: lat,
      longitud: lng,
      customer_id: cust.id,
      route_id: this.route()?.id ?? null,
      skip_scoring: true,
      stats: {
        totalExhibiciones: 1,
        totalProductosMarcados: planogramPids.length,
        puntuacionTotal: 0,
        ventaTotal: 0,
        ventaAdicional: 0,
      },
      exhibiciones: [
        {
          perteneceMegaDulces: true,
          productosMarcados: planogramPids,
          ticket_foto_url: this.ticketUrl,
          _photoBlob: this.exhibidorFile(),
        },
      ],
    };

    const buildPendingSale = (): PendingVendorSale => ({
      customer_id: cust.id,
      sale_date: today,
      route_id: this.route()?.id ?? null,
      capture_ref: this.syncUuid!,
      ticket_photo_url: this.ticketUrl,
      ticket_cloudinary_public_id: this.ticketPublicId,
      lines: confirmed.map((i) => ({
        sku: i.sku as string,
        product_name: i.product_name,
        quantity: i.quantity,
        confidence: i.confidence,
      })),
      deferredFromTicket: ocrDeferred,
    });

    const saveOffline = async (motivo: 'sin-red' | 'falló-online'): Promise<void> => {
      await this.offlineSync.guardarVisitaOffline(
        null,
        userId,
        {
          customerId: cust.id,
          horaInicio: visitPayload.horaInicio,
          horaFin: visitPayload.horaFin,
          exhibiciones: visitPayload.exhibiciones,
          stats: visitPayload.stats,
          syncUuid: this.syncUuid,
          // ticketBlob solo se persiste si necesitamos OCR diferido (offline al
          // tomar el ticket). Si OCR ya corrió online, la venta lleva las líneas.
          ticketBlob: ocrDeferred ? this.ticketBlob : undefined,
          pendingSale: buildPendingSale(),
        },
        { lat, lng, precision: 0 },
      );
      this.toast.add({
        severity: 'info',
        summary: motivo === 'sin-red' ? 'Guardada sin conexión' : 'Guardada para sync',
        detail: ocrDeferred
          ? 'El ticket se procesará automáticamente cuando vuelva la conexión.'
          : 'Se sincronizará automáticamente apenas vuelva la conexión.',
        life: 6000,
      });
      this.reset();
    };

    // Path offline puro: sin red, no intentamos POST online.
    if (!navigator.onLine) {
      try {
        await saveOffline('sin-red');
      } catch (offErr: any) {
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo guardar offline',
          detail: offErr?.message || 'Storage local no disponible. Reintentá.',
        });
      } finally {
        this.saving.set(false);
      }
      return;
    }

    // Path online: visita + venta. Si falla por transient → fallback offline.
    try {
      const visit = await firstValueFrom(
        this.http.post<any>(`${this.apiUrl}/daily-captures`, buildVisitFormData(visitPayload)),
      );

      // Venta solo si hay líneas confirmadas (si OCR diferido sin items, no
      // tenemos qué postear — pero al estar online el OCR debería haber corrido,
      // así que `ocrDeferred && online` es improbable).
      let saleLines = 0;
      if (confirmed.length > 0) {
        const sale = await firstValueFrom(
          this.http.post<any>(`${this.apiUrl}/commercial/vendor-sales`, {
            customer_id: cust.id,
            sale_date: today,
            route_id: this.route()?.id ?? null,
            capture_ref: this.syncUuid,
            daily_capture_id: visit?.id ?? null,
            ticket_photo_url: this.ticketUrl,
            ticket_cloudinary_public_id: this.ticketPublicId,
            lines: confirmed.map((i) => ({
              sku: i.sku,
              product_name: i.product_name,
              quantity: i.quantity,
              confidence: i.confidence,
            })),
          }),
        );
        saleLines = sale?.lines ?? confirmed.length;
      }

      this.toast.add({
        severity: 'success',
        summary: 'Captura guardada',
        detail: `Venta: ${saleLines} líneas · Visita: ${planogramPids.length} productos`,
      });
      this.reset();
    } catch (e: any) {
      // Si fue transient (red murió mid-POST), fallback offline. El syncUuid
      // permite dedup server-side cuando el sync reintenté: si el server ya
      // grabó la visita en el POST fallido, devuelve la fila existente.
      if (isTransientStatus(e?.status)) {
        try {
          await saveOffline('falló-online');
          return;
        } catch (offErr: any) {
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo guardar',
            detail: `Red inestable y storage local también falló: ${offErr?.message || 'desconocido'}`,
          });
          return;
        }
      }
      // Error no-transient (validación, FK inválida, etc): mostrar al user.
      this.toast.add({
        severity: 'error',
        summary: 'No se pudo guardar',
        detail: e?.error?.message || e?.message || 'Reintentá — no se duplicará.',
      });
    } finally {
      this.saving.set(false);
    }
  }

  private reset(): void {
    this.svc.clearActiveState();
    this.exhibidorFile.set(null);
    this.exhibidorPreview.set(null);
    this.ticketPhotos.set([]);
    this.items.set([]);
    this.changingStore.set(false);
    this.ticketUrl = null;
    this.ticketPublicId = null;
    this.syncUuid = null;
    this.ticketBlob = null;
    this.ticketOcrDeferred.set(false);
  }

  private makeFolio(): string {
    const u = this.auth.user();
    const initial = (u?.username?.charAt(0) || 'V').toUpperCase();
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const rand = Math.random().toString(16).slice(2, 6);
    return `${initial}-${hh}${mm}${ss}-${rand}`;
  }

  private newUuid(): string {
    return typeof crypto !== 'undefined' && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private todayMx(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
