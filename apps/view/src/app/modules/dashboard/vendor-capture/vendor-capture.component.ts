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
import { CardModule } from 'primeng/card';
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
  confidence: string; // high|medium|low|no_match
  confirmed: boolean;
}

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
 * Reusa DailyCaptureService solo para GPS/tienda/catálogos.
 */
@Component({
  selector: 'app-vendor-capture',
  standalone: true,
  imports: [CommonModule, FormsModule, CardModule, ButtonModule, TagModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="vc">
      <h1 class="title">Captura de vendedor</h1>
      <p class="subtitle">Foto del exhibidor + ticket de venta. Los productos alimentan tu venta del día y la visita.</p>

      <!-- Paso 1: tienda -->
      <p-card *ngIf="step() === 'start'" styleClass="card">
        <div class="store-box">
          <ng-container *ngIf="store() as s; else noStore">
            <i class="pi pi-map-marker ok"></i>
            <div>
              <div class="store-name">{{ s.nombre }}</div>
              <div class="hint">a {{ s.distance }} m</div>
            </div>
          </ng-container>
          <ng-template #noStore>
            <span class="hint">{{ starting() ? 'Detectando ubicación…' : 'Iniciá para detectar tu tienda.' }}</span>
          </ng-template>
        </div>

        <div *ngIf="nearby().length > 1" class="nearby">
          <label>Cambiar tienda</label>
          <select [ngModel]="store()?.id" (ngModelChange)="onSelectStore($event)">
            <option *ngFor="let s of nearby()" [value]="s.id">{{ s.nombre }} ({{ s.distance }} m)</option>
          </select>
        </div>

        <button pButton [label]="store() ? 'Continuar' : 'Iniciar captura'"
          [icon]="starting() ? 'pi pi-spin pi-spinner' : 'pi pi-play'"
          [disabled]="starting()"
          (click)="store() ? step.set('exhibidor') : start()"></button>
      </p-card>

      <!-- Paso 2: foto exhibidor -->
      <p-card *ngIf="step() === 'exhibidor'" styleClass="card">
        <h2 class="step-title">Foto del exhibidor</h2>
        <img *ngIf="exhibidorPreview()" [src]="exhibidorPreview()!" class="preview" alt="exhibidor" />
        <input #exhInput type="file" accept="image/*" capture="environment" hidden (change)="onExhibidor($event)" />
        <button pButton label="Tomar / elegir foto" icon="pi pi-camera" severity="secondary" (click)="exhInput.click()"></button>
        <div class="nav-row">
          <button pButton label="Atrás" icon="pi pi-arrow-left" text severity="secondary" (click)="step.set('start')"></button>
          <button pButton label="Continuar" icon="pi pi-arrow-right" [disabled]="!exhibidorFile()" (click)="step.set('ticket')"></button>
        </div>
      </p-card>

      <!-- Paso 3: ticket + OCR -->
      <p-card *ngIf="step() === 'ticket'" styleClass="card">
        <h2 class="step-title">Ticket de venta</h2>
        <p-card *ngIf="processing()" styleClass="status">
          <i class="pi pi-spin pi-spinner"></i> Leyendo el ticket…
        </p-card>
        <img *ngIf="ticketPreview() && !processing()" [src]="ticketPreview()!" class="preview" alt="ticket" />
        <input #tkInput type="file" accept="image/*" capture="environment" hidden (change)="onTicket($event)" />
        <button *ngIf="!items().length" pButton label="Tomar / elegir foto del ticket" icon="pi pi-receipt" severity="secondary" [disabled]="processing()" (click)="tkInput.click()"></button>

        <div *ngIf="items().length" class="items">
          <div class="items-head">
            <span>{{ confirmedCount() }} de {{ items().length }} productos</span>
            <button pButton label="Otra foto" icon="pi pi-refresh" text size="small" (click)="tkInput.click()"></button>
          </div>
          <div class="item-row" *ngFor="let it of items(); let i = index">
            <input type="checkbox" [ngModel]="it.confirmed" (ngModelChange)="toggleItem(i, $event)" />
            <span class="item-name" [class.off]="!it.confirmed">{{ it.product_name || it.raw }}</span>
            <p-tag [value]="it.confidence" [severity]="confSeverity(it.confidence)"></p-tag>
            <span class="qty">×{{ it.quantity }}</span>
          </div>
        </div>

        <div class="nav-row">
          <button pButton label="Atrás" icon="pi pi-arrow-left" text severity="secondary" (click)="step.set('exhibidor')"></button>
          <button pButton label="Revisar" icon="pi pi-arrow-right" [disabled]="!items().length" (click)="step.set('review')"></button>
        </div>
      </p-card>

      <!-- Paso 4: revisar + guardar -->
      <p-card *ngIf="step() === 'review'" styleClass="card">
        <h2 class="step-title">Resumen</h2>
        <ul class="summary">
          <li><i class="pi pi-map-marker"></i> {{ store()?.nombre }}</li>
          <li><i class="pi pi-shopping-cart"></i> Venta: {{ confirmedCount() }} líneas</li>
          <li><i class="pi pi-images"></i> Visita (planograma, sin ponderación): {{ planogramCount() }} productos</li>
        </ul>
        <button pButton label="Guardar captura" icon="pi pi-check"
          [loading]="saving()" [disabled]="saving() || confirmedCount() === 0"
          (click)="save()"></button>
        <button pButton label="Atrás" icon="pi pi-arrow-left" text severity="secondary" [disabled]="saving()" (click)="step.set('ticket')"></button>
      </p-card>
    </div>
  `,
  styles: [`
    .vc { max-width: 640px; margin: 0 auto; padding: 1rem; }
    .title { margin: 0 0 .25rem; font-size: 1.4rem; color: var(--text-main); }
    .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: .85rem; }
    :host ::ng-deep .p-card.card { margin-bottom: 1rem; background: var(--card-bg); border: 1px solid var(--border-color); }
    .step-title { font-size: 1rem; color: var(--text-main); margin: 0 0 .75rem; }
    .store-box { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; }
    .store-box .ok { color: var(--ok, #15803d); font-size: 1.4rem; }
    .store-name { font-weight: 600; color: var(--text-main); }
    .hint { color: var(--text-muted); font-size: .8rem; }
    .nearby { display: flex; flex-direction: column; gap: .25rem; margin-bottom: 1rem; }
    .nearby label { font-size: .8rem; color: var(--text-muted); }
    .nearby select { padding: .5rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--text-main); }
    .preview { width: 100%; max-height: 260px; object-fit: contain; border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 1rem; background: #000; }
    :host ::ng-deep .p-card.status .p-card-body { padding: .75rem; }
    .status { color: var(--text-muted); }
    .items { margin: .5rem 0 1rem; border: 1px solid var(--border-color); border-radius: 8px; padding: .75rem; }
    .items-head { display: flex; justify-content: space-between; align-items: center; font-size: .8rem; color: var(--text-muted); margin-bottom: .5rem; }
    .item-row { display: flex; align-items: center; gap: .5rem; padding: .375rem 0; border-top: 1px solid var(--border-color); }
    .item-row:first-of-type { border-top: none; }
    .item-name { flex: 1; font-size: .875rem; color: var(--text-main); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item-name.off { color: var(--text-muted); text-decoration: line-through; }
    .qty { font-variant-numeric: tabular-nums; color: var(--text-main); }
    .summary { list-style: none; padding: 0; margin: 0 0 1rem; }
    .summary li { display: flex; align-items: center; gap: .5rem; padding: .375rem 0; color: var(--text-main); }
    .summary i { color: var(--text-muted); width: 1.2rem; }
    .nav-row { display: flex; justify-content: space-between; margin-top: 1rem; }
    :host ::ng-deep button.p-button { width: 100%; }
    .nav-row :host ::ng-deep button.p-button, .nav-row button { width: auto; }
  `],
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
    // Fecha local del dispositivo (MX) en YYYY-MM-DD.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
