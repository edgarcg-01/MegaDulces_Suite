import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { DailyCaptureService } from '../captures/daily-capture.service';
import { buildVisitFormData } from '../../../core/http/visit-form-data';

interface OcrItem {
  raw: string;
  quantity: number;
  product_id: string | null;
  product_name: string | null;
  brand_name: string | null;
  confidence: string; // high|medium|low|no_match
  confirmed: boolean;
  inPlanogram?: boolean; // matchea trade.planogram_skus → va a la visita
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
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="px-6 pt-6 pb-6 space-y-6">

      <!-- Encabezado -->
      <div class="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 md:w-14 md:h-14 rounded-2xl bg-brand border border-divider flex flex-col items-center justify-center shadow-lg shrink-0">
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
              <ng-container *ngIf="store(); else noStoreSub">Tienda: <span class="font-bold text-content-main">{{ store()?.nombre }}</span></ng-container>
              <ng-template #noStoreSub>Inicio: <span class="font-bold text-content-main">—</span></ng-template>
            </p>
          </div>
        </div>
        <div class="flex gap-2 w-full md:w-auto">
          <p-button *ngIf="!svc.hasActiveVisit()" label="Iniciar captura" icon="pi pi-play"
                    (onClick)="start()" [disabled]="needsRoute() || starting()"
                    styleClass="p-button-brand w-full md:w-auto"></p-button>
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
            <div class="text-[10px] sm:text-xs font-black uppercase tracking-[0.15em] text-brand truncate">Ruta de Hoy</div>
            <div class="text-sm sm:text-lg font-black text-content-main uppercase truncate">{{ route()?.name }}</div>
            <button type="button" (click)="changingRoute.set(true)" class="text-[10px] sm:text-xs font-bold text-brand/80 hover:text-brand underline mt-0.5">Cambiar ruta</button>
          </div>
          <div *ngIf="!route() || changingRoute()" class="min-w-0 flex-1">
            <div class="text-[10px] sm:text-xs font-black uppercase tracking-[0.15em] text-brand mb-1">¿En qué ruta estás hoy?</div>
            <select [ngModel]="route()?.id || ''" (ngModelChange)="onSelectRoute($event)"
                    class="w-full sm:w-64 rounded-lg border border-divider bg-surface-card text-content-main text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="" disabled>Seleccioná tu ruta</option>
              <option *ngFor="let r of zoneRoutes()" [value]="r.value">{{ r.label }}</option>
            </select>
            <div *ngIf="zoneRoutes().length === 0" class="text-[10px] sm:text-xs text-content-muted mt-1">No hay rutas para tu zona. Avisá a tu supervisor.</div>
          </div>
        </div>
        <div *ngIf="visitaNumero() > 1" class="bg-surface-card px-3 py-2 rounded-xl border border-divider shadow-sm flex items-center gap-3 self-start sm:self-auto">
          <div class="flex flex-col items-end">
            <span class="text-[8px] sm:text-[9px] font-black text-content-faint uppercase tracking-tighter">Progreso de Jornada</span>
            <span class="text-xs sm:text-sm font-black text-content-main">Visita #{{ visitaNumero() }}</span>
          </div>
        </div>
      </div>

      <!-- Banner de Tienda Detectada -->
      <div *ngIf="svc.hasActiveVisit() && store()"
           class="bg-ok-soft-bg border border-ok-border p-3 sm:p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-in fade-in slide-in-from-top-4 duration-500">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-surface-card border border-ok-border flex items-center justify-center text-ok-fg shrink-0">
            <i class="pi pi-check-circle text-lg sm:text-xl"></i>
          </div>
          <div class="min-w-0">
            <div class="text-[10px] sm:text-xs font-black uppercase tracking-[0.15em] text-ok-fg truncate">Tienda Detectada</div>
            <div class="text-sm sm:text-lg font-black text-content-main uppercase truncate">{{ store()?.nombre }}</div>
          </div>
        </div>
        <button *ngIf="nearby().length > 1" type="button" (click)="changingStore.set(!changingStore())"
                class="text-xs font-bold text-ok-fg/80 hover:text-ok-fg underline self-start sm:self-auto">Cambiar tienda</button>
      </div>
      <div *ngIf="svc.hasActiveVisit() && changingStore() && nearby().length > 1" class="-mt-3">
        <select [ngModel]="store()?.id" (ngModelChange)="onSelectStore($event)"
                class="w-full rounded-lg border border-divider bg-surface-card text-content-main text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand">
          <option *ngFor="let s of nearby()" [value]="s.id">{{ s.nombre }} ({{ s.distance }} m)</option>
        </select>
      </div>

      <!-- Sin tienda tras iniciar -->
      <div *ngIf="svc.hasActiveVisit() && !store()"
           class="bg-amber-500/5 border border-amber-500/30 p-3 sm:p-4 rounded-2xl flex items-center gap-3">
        <i class="pi pi-exclamation-triangle text-amber-500 text-xl" aria-hidden="true"></i>
        <div class="text-sm text-content-main">No se detectó una tienda cercana. Acercate al PdV y tocá <strong>Cancelar</strong> y reintentá.</div>
      </div>

      <!-- Empty state (sin visita activa) -->
      <ng-container *ngIf="!svc.hasActiveVisit()">
        <div class="p-12 text-center bg-surface-card border border-divider rounded-xl">
          <div class="w-16 h-16 rounded-full bg-surface-ground border border-divider flex items-center justify-center mx-auto mb-4 text-content-muted shadow-inner">
            <i class="pi pi-map-marker text-2xl"></i>
          </div>
          <h3 class="text-lg font-bold text-content-main mb-2">Listo para iniciar tu ruta</h3>
          <p class="text-sm text-content-dim mb-6 max-w-sm mx-auto">Tomá la foto del exhibidor y el ticket de venta. El sistema capturará tu ubicación GPS.</p>
          <p-button label="Iniciar Visita de Campo" icon="pi pi-play" (onClick)="start()"
                    [disabled]="needsRoute() || starting()" styleClass="p-button-brand"></p-button>
        </div>
      </ng-container>

      <!-- Flujo de captura (visita activa con tienda) -->
      <ng-container *ngIf="svc.hasActiveVisit() && store()">

        <!-- Foto del exhibidor -->
        <div class="bg-surface-card border border-divider rounded-2xl p-5 space-y-4">
          <header class="space-y-1">
            <h3 class="text-base font-semibold text-content-main">Evidencia fotográfica</h3>
            <p class="text-xs text-content-muted leading-relaxed">Una foto del exhibidor es obligatoria para registrar la visita.</p>
          </header>
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
                            : !it.product_id ? 'border-divider bg-surface-ground/40 opacity-60' : 'border-divider bg-surface-card'">
                <label class="flex gap-3 items-start cursor-pointer">
                  <input type="checkbox" [ngModel]="it.confirmed" [disabled]="!it.product_id"
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

        <!-- Guardar -->
        <div class="bg-surface-card border border-divider rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div class="text-sm text-content-dim">
            Venta: <strong class="text-content-main">{{ confirmedCount() }}</strong> líneas
            <span class="mx-2 opacity-30">|</span>
            Visita (planograma): <strong class="text-content-main">{{ planogramCount() }}</strong>
          </div>
          <p-button label="Guardar captura" icon="pi pi-check" styleClass="p-button-brand w-full sm:w-auto"
                    [loading]="saving()" [disabled]="saving() || !exhibidorFile() || confirmedCount() === 0"
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
  private readonly toast = inject(MessageService);
  private readonly apiUrl = environment.apiUrl;

  readonly user = this.auth.user;

  readonly starting = signal(false);
  readonly exhibidorFile = signal<File | null>(null);
  readonly exhibidorPreview = signal<string | null>(null);
  readonly ticketPhotos = signal<string[]>([]); // previews; el vendedor puede tomar varias fotos del mismo ticket
  readonly processing = signal(false);
  readonly items = signal<OcrItem[]>([]);
  readonly saving = signal(false);
  readonly changingRoute = signal(false);
  readonly changingStore = signal(false);

  private ticketUrl: string | null = null;
  private ticketPublicId: string | null = null;
  private syncUuid: string | null = null;

  readonly store = this.svc.detectedStore;
  readonly nearby = this.svc.nearbyStores;
  readonly route = this.svc.activeRoute;
  readonly zoneRoutes = this.svc.zoneRoutes;
  readonly visitasHoy = this.svc.visitasHoy;
  readonly needsRoute = computed(() => !this.svc.activeRoute());

  readonly visitaNumero = computed(() => this.svc.visitasHoy().length + 1);
  readonly confirmedCount = computed(() => this.items().filter((i) => i.confirmed && i.product_id).length);
  readonly planogramCount = computed(
    () => this.items().filter((i) => i.confirmed && i.product_id && i.inPlanogram).length,
  );

  ngOnInit(): void {
    this.svc.refreshAll(); // catálogos + tiendas + asignación de ruta
  }

  ngOnDestroy(): void {
    this.svc.clearActiveState();
  }

  async start(): Promise<void> {
    if (this.starting()) return;
    if (this.needsRoute()) {
      this.toast.add({ severity: 'warn', summary: 'Elegí tu ruta', detail: 'Seleccioná tu ruta de hoy antes de iniciar.' });
      return;
    }
    this.starting.set(true);
    try {
      await this.svc.iniciarVisita();
      if (!this.store()) {
        this.toast.add({ severity: 'warn', summary: 'Sin tienda', detail: 'No se detectó una tienda cercana. Acercate al PdV e intentá de nuevo.' });
      }
    } catch (e: any) {
      this.toast.add({ severity: 'error', summary: 'Error de GPS', detail: e?.message || 'No se pudo capturar la ubicación.' });
    } finally {
      this.starting.set(false);
    }
  }

  cancel(): void {
    this.reset();
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

    this.processing.set(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'ticket.jpg');
      const res = await firstValueFrom(this.http.post<any>(`${this.apiUrl}/ai/ticket/extract`, fd));
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
          product_id: it.suggested?.product_id ?? null,
          product_name: it.suggested?.product_name ?? null,
          brand_name: it.suggested?.brand_name ?? null,
          confidence: conf,
          confirmed: !!it.suggested?.product_id && conf !== 'no_match',
        };
      });
      // Acumular entre fotos (un ticket grande se parte en varias): dedupe por
      // product_id, quedándonos con la mayor cantidad (evita doble conteo si las
      // fotos se solapan).
      this.mergeOcrItems(ocr);
      // Relacionar con el planograma de trade: solo los que matchean van a la visita.
      await this.matchPlanogram();
      this.toast.add({
        severity: ocr.length ? 'success' : 'warn',
        summary: ocr.length ? `${ocr.length} productos detectados` : 'Ticket ilegible',
        detail: ocr.length ? `${this.confirmedCount()} confirmados` : 'Tomá la foto con mejor luz.',
      });
    } catch (e: any) {
      this.toast.add({ severity: 'error', summary: 'OCR falló', detail: e?.error?.message || 'Intentá de nuevo.' });
    } finally {
      this.processing.set(false);
    }
  }

  toggleItem(i: number, checked: boolean): void {
    this.items.update((arr) => arr.map((it, idx) => (idx === i ? { ...it, confirmed: checked } : it)));
  }

  /** Acumula items OCR de varias fotos: dedupe por product_id (mayor cantidad). */
  private mergeOcrItems(incoming: OcrItem[]): void {
    this.items.update((prev) => {
      const result = prev.map((p) => ({ ...p }));
      const byId = new Map<string, OcrItem>();
      for (const r of result) if (r.product_id) byId.set(r.product_id, r);
      for (const it of incoming) {
        if (it.product_id && byId.has(it.product_id)) {
          const d = byId.get(it.product_id)!;
          d.quantity = Math.max(d.quantity, it.quantity);
        } else {
          const copy = { ...it };
          result.push(copy);
          if (copy.product_id) byId.set(copy.product_id, copy);
        }
      }
      return result;
    });
  }

  /** Marca qué items están en el planograma de trade (los demás no van a la visita). */
  private async matchPlanogram(): Promise<void> {
    const pids = Array.from(
      new Set(this.items().map((i) => i.product_id).filter((x): x is string => !!x)),
    );
    if (pids.length === 0) return;
    try {
      const inPlan = await firstValueFrom(
        this.http.post<string[]>(`${this.apiUrl}/planograms/brands/match-skus`, { product_ids: pids }),
      );
      const set = new Set(inPlan || []);
      this.items.update((arr) => arr.map((it) => ({ ...it, inPlanogram: !!it.product_id && set.has(it.product_id) })));
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
    const store = this.store();
    if (!store) return;
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

    const confirmed = this.items().filter((i) => i.confirmed && i.product_id);
    if (confirmed.length === 0) return;

    this.saving.set(true);
    this.syncUuid = this.syncUuid || this.newUuid();
    const today = this.todayMx();
    try {
      // 1) Venta — líneas confirmadas.
      const sale = await firstValueFrom(
        this.http.post<any>(`${this.apiUrl}/commercial/vendor-sales`, {
          store_id: store.id,
          sale_date: today,
          route_id: this.route()?.id ?? null,
          capture_ref: this.syncUuid,
          ticket_photo_url: this.ticketUrl,
          ticket_cloudinary_public_id: this.ticketPublicId,
          lines: confirmed.map((i) => ({
            product_id: i.product_id,
            product_name: i.product_name,
            quantity: i.quantity,
            confidence: i.confidence,
          })),
        }),
      );

      // 2) Visita sin ponderación — SOLO productos que matchean el planograma de
      // trade (deduplicados). Los demás productos vendidos no van a la visita.
      const planogramPids = Array.from(
        new Set(confirmed.filter((i) => i.inPlanogram).map((i) => i.product_id as string)),
      );

      // Visita sin ponderación: NO clasificamos el exhibidor (concepto/ubicación/
      // nivel van vacíos a propósito — el vendedor no audita). El backend lo
      // acepta porque skip_scoring=true.
      if (planogramPids.length > 0) {
        const payload: any = {
          folio: this.makeFolio(),
          sync_uuid: this.syncUuid,
          horaInicio: this.svc.horaInicio() || new Date().toISOString(),
          horaFin: new Date().toISOString(),
          latitud: lat,
          longitud: lng,
          store_id: store.id,
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
        await firstValueFrom(this.http.post<any>(`${this.apiUrl}/daily-captures`, buildVisitFormData(payload)));
      }

      this.toast.add({
        severity: 'success',
        summary: 'Captura guardada',
        detail: `Venta: ${sale?.lines ?? confirmed.length} líneas · Visita: ${planogramPids.length} productos`,
      });
      this.reset();
    } catch (e: any) {
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
