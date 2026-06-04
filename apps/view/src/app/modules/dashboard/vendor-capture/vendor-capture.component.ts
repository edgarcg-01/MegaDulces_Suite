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

type Step = 'start' | 'exhibidor' | 'ticket' | 'review';

interface OcrItem {
  raw: string;
  quantity: number;
  product_id: string | null;
  product_name: string | null;
  brand_name: string | null;
  confidence: string; // high|medium|low|no_match
  confirmed: boolean;
}

const STEP_INDEX: Record<Step, number> = { start: 1, exhibidor: 2, ticket: 3, review: 4 };

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
];

/**
 * Captura diaria especial del vendedor. Flujo: tienda (GPS) → foto exhibidor →
 * foto ticket de venta (OCR) → guardar. Los productos detectados van a DOS
 * destinos (2 llamadas, no atómicas por boundaries):
 *   - venta: POST /commercial/vendor-sales (todas las líneas confirmadas)
 *   - visita SIN ponderación: POST /daily-captures (skip_scoring=true) con los
 *     productos de planograma (confidence high/medium).
 * Reusa DailyCaptureService solo para GPS/tienda/catálogos. El diseño replica
 * el wizard de /captures (mismos tokens content/surface/brand-orange).
 */
@Component({
  selector: 'app-vendor-capture',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="max-w-xl mx-auto px-4 py-6">
      <header class="mb-5">
        <h1 class="text-xl font-bold text-content-main">Captura de vendedor</h1>
        <p class="text-sm text-content-muted mt-0.5">Foto del exhibidor + ticket de venta. Los productos alimentan tu venta del día y la visita.</p>
      </header>

      <div class="bg-surface-card border border-divider rounded-2xl p-5">

        <!-- Progress -->
        <div class="mb-6 mt-1 px-2">
          <div class="flex justify-between items-center relative" role="progressbar"
               [attr.aria-valuenow]="stepIndex()" aria-valuemin="1" aria-valuemax="4"
               [attr.aria-label]="'Paso ' + stepIndex() + ' de 4'">
            <div class="absolute top-1/2 left-0 right-0 h-px bg-surface-ground border border-divider -z-10 -translate-y-1/2" aria-hidden="true"></div>
            <div class="absolute top-1/2 left-0 h-px bg-brand-orange -z-10 -translate-y-1/2 motion-safe:transition-all motion-safe:duration-300"
                 [style.width]="((stepIndex() - 1) / 3) * 100 + '%'" aria-hidden="true"></div>
            <div *ngFor="let s of [1, 2, 3, 4]"
                 class="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold bg-surface-card motion-safe:transition-colors z-10 border"
                 [ngClass]="s < stepIndex() ? 'border-brand-orange bg-brand-orange text-white'
                           : s === stepIndex() ? 'border-brand-orange text-brand-orange'
                           : 'border-divider text-content-muted'"
                 [attr.aria-current]="s === stepIndex() ? 'step' : null">{{ s }}</div>
          </div>
        </div>

        <div class="py-2 px-1" style="min-height: 320px;">

          <!-- Paso 1: tienda -->
          <div *ngIf="step() === 'start'" class="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
            <header class="space-y-1">
              <h2 class="text-base font-semibold text-content-main">¿En qué tienda estás?</h2>
              <p class="text-xs text-content-muted leading-relaxed">Detectamos tu tienda por GPS. Si hay varias cerca, podés elegir.</p>
            </header>

            <div *ngIf="store() as s; else noStore"
                 class="flex items-center gap-3 p-4 rounded-xl border border-divider bg-surface-ground/40">
              <div class="w-12 h-12 rounded-full bg-brand-orange/10 text-brand-orange flex items-center justify-center shrink-0">
                <i class="pi pi-map-marker text-xl" aria-hidden="true"></i>
              </div>
              <div class="min-w-0">
                <div class="text-sm font-semibold text-content-main truncate">{{ s.nombre }}</div>
                <div class="text-xs text-content-muted">a {{ s.distance }} m</div>
              </div>
            </div>
            <ng-template #noStore>
              <div class="border-2 border-dashed border-divider rounded-xl p-8 text-center bg-surface-ground/40">
                <div class="w-14 h-14 rounded-full bg-brand-orange/10 text-brand-orange flex items-center justify-center mx-auto mb-4">
                  <i class="pi text-2xl" [ngClass]="starting() ? 'pi-spin pi-spinner' : 'pi-map-marker'" aria-hidden="true"></i>
                </div>
                <p class="text-sm font-medium text-content-main">{{ starting() ? 'Detectando ubicación…' : 'Sin tienda detectada' }}</p>
                <p class="text-xs text-content-muted mt-1">Tocá “Iniciar captura” para detectar.</p>
              </div>
            </ng-template>

            <div *ngIf="nearby().length > 1" class="space-y-1.5">
              <label class="text-xs font-medium text-content-muted">Cambiar tienda</label>
              <select [ngModel]="store()?.id" (ngModelChange)="onSelectStore($event)"
                      class="w-full rounded-lg border border-divider bg-surface-card text-content-main text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-orange">
                <option *ngFor="let s of nearby()" [value]="s.id">{{ s.nombre }} ({{ s.distance }} m)</option>
              </select>
            </div>
          </div>

          <!-- Paso 2: foto exhibidor -->
          <div *ngIf="step() === 'exhibidor'" class="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
            <header class="space-y-1">
              <h2 class="text-base font-semibold text-content-main">Evidencia fotográfica</h2>
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

          <!-- Paso 3: ticket + OCR -->
          <div *ngIf="step() === 'ticket'" class="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
            <header class="space-y-1">
              <h2 class="text-base font-semibold text-content-main">Foto del ticket</h2>
              <p class="text-xs text-content-muted leading-relaxed">Capturamos el ticket y la IA detecta los productos. Vos confirmás cuáles van a la venta y la visita.</p>
            </header>

            <label *ngIf="!ticketPreview()"
                   class="block border-2 border-dashed border-divider rounded-xl p-8 text-center bg-surface-ground/40 motion-safe:transition-colors hover:bg-surface-ground hover:border-brand-orange/40 cursor-pointer relative focus-within:ring-2 focus-within:ring-brand-orange focus-within:ring-offset-2">
              <input type="file" accept="image/*" capture="environment" (change)="onTicket($event)"
                     class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" aria-label="Tomar fotografía del ticket">
              <div class="w-14 h-14 rounded-full bg-brand-orange/10 text-brand-orange flex items-center justify-center mx-auto mb-4">
                <i class="pi pi-receipt text-2xl" aria-hidden="true"></i>
              </div>
              <p class="text-sm font-medium text-content-main">Tomar foto del ticket</p>
              <p class="text-xs text-content-muted mt-1">Toca para abrir la cámara</p>
            </label>

            <div *ngIf="ticketPreview()" class="space-y-3">
              <div class="relative rounded-xl border border-divider overflow-hidden bg-black max-w-sm mx-auto">
                <img [src]="ticketPreview()!" alt="Ticket" class="w-full max-h-64 object-cover">
              </div>
              <div class="flex justify-center">
                <label class="inline-flex">
                  <input type="file" accept="image/*" capture="environment" (change)="onTicket($event)" class="hidden" [disabled]="processing()">
                  <span class="p-button p-button-sm p-button-secondary p-button-outlined inline-flex items-center gap-2 cursor-pointer"
                        [class.opacity-60]="processing()">
                    <i class="pi pi-refresh"></i> Otro ticket
                  </span>
                </label>
              </div>
            </div>

            <!-- Loading -->
            <div *ngIf="processing()" class="flex items-center gap-3 p-4 bg-surface-ground rounded-xl">
              <i class="pi pi-spin pi-spinner text-brand-orange text-xl"></i>
              <span class="text-sm text-content-muted">Leyendo ticket…</span>
            </div>

            <!-- Resultados OCR -->
            <div *ngIf="items().length && !processing()" class="space-y-2">
              <div class="flex items-center justify-between text-sm">
                <span><strong>{{ confirmedCount() }}</strong> de {{ items().length }} confirmados</span>
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
                        <span *ngIf="it.quantity > 1" class="text-[10px] bg-brand-orange text-white px-1.5 py-0 rounded font-semibold">×{{ it.quantity }}</span>
                      </div>
                    </div>
                  </label>
                </li>
              </ul>
            </div>
          </div>

          <!-- Paso 4: revisar + guardar -->
          <div *ngIf="step() === 'review'" class="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
            <header class="space-y-1">
              <h2 class="text-base font-semibold text-content-main">Resumen</h2>
              <p class="text-xs text-content-muted leading-relaxed">Revisá antes de guardar. La visita se registra sin ponderación.</p>
            </header>
            <ul class="flex flex-col gap-2 list-none p-0 m-0">
              <li class="flex items-center gap-3 p-3 rounded-xl border border-divider bg-surface-ground/40">
                <i class="pi pi-map-marker text-brand-orange w-5 text-center" aria-hidden="true"></i>
                <span class="text-sm text-content-main">{{ store()?.nombre }}</span>
              </li>
              <li class="flex items-center gap-3 p-3 rounded-xl border border-divider bg-surface-ground/40">
                <i class="pi pi-shopping-cart text-brand-orange w-5 text-center" aria-hidden="true"></i>
                <span class="text-sm text-content-main">Venta: <strong>{{ confirmedCount() }}</strong> líneas</span>
              </li>
              <li class="flex items-center gap-3 p-3 rounded-xl border border-divider bg-surface-ground/40">
                <i class="pi pi-images text-brand-orange w-5 text-center" aria-hidden="true"></i>
                <span class="text-sm text-content-main">Visita (planograma, sin ponderación): <strong>{{ planogramCount() }}</strong> productos</span>
              </li>
            </ul>
          </div>

        </div>

        <!-- Navegación -->
        <nav class="flex justify-between items-center gap-2 pt-5 mt-2 border-t border-divider" aria-label="Navegación de la captura">
          <p-button label="Atrás" icon="pi pi-arrow-left" severity="secondary" [text]="true"
                    [disabled]="step() === 'start' || saving()" (onClick)="back()"></p-button>

          <p-button *ngIf="step() === 'start' && !store()" label="Iniciar captura"
                    [icon]="starting() ? 'pi pi-spin pi-spinner' : 'pi pi-play'" iconPos="right"
                    styleClass="p-button-brand" [disabled]="starting()" (onClick)="start()"></p-button>
          <p-button *ngIf="step() === 'start' && store()" label="Continuar" icon="pi pi-arrow-right" iconPos="right"
                    styleClass="p-button-brand" (onClick)="step.set('exhibidor')"></p-button>

          <p-button *ngIf="step() === 'exhibidor'" label="Continuar" icon="pi pi-arrow-right" iconPos="right"
                    styleClass="p-button-brand" [disabled]="!exhibidorFile()" (onClick)="step.set('ticket')"></p-button>

          <p-button *ngIf="step() === 'ticket'" label="Revisar" icon="pi pi-arrow-right" iconPos="right"
                    styleClass="p-button-brand" [disabled]="!items().length || processing()" (onClick)="step.set('review')"></p-button>

          <p-button *ngIf="step() === 'review'" label="Guardar captura" icon="pi pi-check"
                    styleClass="p-button-brand" [loading]="saving()" [disabled]="saving() || confirmedCount() === 0"
                    (onClick)="save()"></p-button>
        </nav>

      </div>
    </div>
  `,
})
export class VendorCaptureComponent implements OnInit, OnDestroy {
  private readonly svc = inject(DailyCaptureService);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly apiUrl = environment.apiUrl;

  readonly step = signal<Step>('start');
  readonly starting = signal(false);
  readonly exhibidorFile = signal<File | null>(null);
  readonly exhibidorPreview = signal<string | null>(null);
  readonly ticketPreview = signal<string | null>(null);
  readonly processing = signal(false);
  readonly items = signal<OcrItem[]>([]);
  readonly saving = signal(false);

  private ticketUrl: string | null = null;
  private ticketPublicId: string | null = null;
  private syncUuid: string | null = null;

  readonly store = this.svc.detectedStore;
  readonly nearby = this.svc.nearbyStores;

  readonly stepIndex = computed(() => STEP_INDEX[this.step()]);
  readonly confirmedCount = computed(() => this.items().filter((i) => i.confirmed && i.product_id).length);
  readonly planogramCount = computed(
    () => this.items().filter((i) => i.confirmed && i.product_id && (i.confidence === 'high' || i.confidence === 'medium')).length,
  );

  ngOnInit(): void {
    this.svc.refreshAll(); // carga catálogos (conceptos/ubicaciones/niveles) + tiendas
  }

  ngOnDestroy(): void {
    // Liberar el estado de visita del service singleton para no dejar una
    // visita "activa" colgada si el usuario navega a /captures.
    this.svc.clearActiveState();
  }

  back(): void {
    const s = this.step();
    if (s === 'exhibidor') this.step.set('start');
    else if (s === 'ticket') this.step.set('exhibidor');
    else if (s === 'review') this.step.set('ticket');
  }

  async start(): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    try {
      await this.svc.iniciarVisita();
      if (this.store()) this.step.set('exhibidor');
      else this.toast.add({ severity: 'warn', summary: 'Sin tienda', detail: 'No se detectó una tienda cercana. Acercate al PdV e intentá de nuevo.' });
    } catch (e: any) {
      this.toast.add({ severity: 'error', summary: 'Error de GPS', detail: e?.message || 'No se pudo capturar la ubicación.' });
    } finally {
      this.starting.set(false);
    }
  }

  onSelectStore(id: string): void {
    const s = this.nearby().find((x) => x.id === id);
    if (s) this.svc.selectStore(s);
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
    reader.onload = () => this.ticketPreview.set(reader.result as string);
    reader.readAsDataURL(file);

    this.processing.set(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'ticket.jpg');
      const res = await firstValueFrom(this.http.post<any>(`${this.apiUrl}/ai/ticket/extract`, fd));
      this.ticketUrl = res?.ticket_url ?? null;
      this.ticketPublicId = res?.ticket_public_id ?? null;
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
      this.items.set(ocr);
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

    const confirmed = this.items().filter((i) => i.confirmed && i.product_id);
    if (confirmed.length === 0) return;

    this.saving.set(true);
    this.syncUuid = this.syncUuid || this.newUuid();
    const today = this.todayMx();
    try {
      // 1) Venta — todas las líneas confirmadas.
      const sale = await firstValueFrom(
        this.http.post<any>(`${this.apiUrl}/commercial/vendor-sales`, {
          store_id: store.id,
          sale_date: today,
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

      // 2) Visita sin ponderación — productos de planograma (high/medium).
      const planogramPids = confirmed
        .filter((i) => i.confidence === 'high' || i.confidence === 'medium')
        .map((i) => i.product_id as string);

      const concepto = this.svc.conceptos()[0];
      const ubicacion = this.svc.ubicaciones()[0];
      const nivel = this.svc.niveles()[0];
      if (concepto && ubicacion && planogramPids.length > 0) {
        const payload: any = {
          folio: this.makeFolio(),
          sync_uuid: this.syncUuid,
          horaInicio: this.svc.horaInicio() || new Date().toISOString(),
          horaFin: new Date().toISOString(),
          latitud: lat,
          longitud: lng,
          store_id: store.id,
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
              conceptoId: concepto.id,
              ubicacionId: ubicacion.id,
              nivelEjecucionId: nivel?.id,
              nivelEjecucion: nivel?.value?.toLowerCase(),
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
    this.step.set('start');
    this.exhibidorFile.set(null);
    this.exhibidorPreview.set(null);
    this.ticketPreview.set(null);
    this.items.set([]);
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
