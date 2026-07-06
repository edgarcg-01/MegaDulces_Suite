import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  input,
  output,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { CardModule } from 'primeng/card';
import { ProgressBarModule } from 'primeng/progressbar';
import { StepsModule } from 'primeng/steps';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  Checklist,
  ChecklistResponse,
  LogisticaService,
  Shipment,
  ShipmentStatus,
} from '../logistica.service';
import { TrackingService } from '../../../core/services/tracking.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * J.9.6 — DeliveryWizard.
 *
 * Migrado del repo `_imported/logistica/.../shared/components/delivery-wizard/`.
 *
 * Wizard mobile-first para el chofer: 4 pasos guían el flujo formal del state
 * machine extendido (J.8). Adaptado a nuestro schema multi-tenant:
 *
 * Pasos:
 *  1. Checklist Salida → POST /logistics/shipments/:id/start-salida-checklist
 *     + crear+completar checklist tipo 'salida'
 *  2. En tránsito → POST .../depart (status='en_ruta')
 *  3. Llegada + fotos → POST .../deliver (status='entregado')
 *     + subir fotos categoría 'delivery'
 *  4. Checklist Llegada → POST .../start-llegada-checklist
 *     + crear+completar checklist tipo 'llegada'
 *     + POST .../close (consume stock, dispara fulfill commercial)
 */
@Component({
  selector: 'app-delivery-wizard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    ButtonModule, DialogModule, CardModule, ProgressBarModule, StepsModule, TagModule,
    InputTextModule, TextareaModule, SelectButtonModule, ToastModule,
  ],
  providers: [MessageService],
  template: `
    <p-toast position="bottom-center"></p-toast>

    <p-dialog
      [visible]="visible()"
      (visibleChange)="visibleChange.emit($event)"
      [modal]="true"
      [closable]="!busy()"
      [style]="{ width: '90vw', maxWidth: '720px' }"
      [contentStyle]="{ padding: '0' }"
      [draggable]="false"
      [resizable]="false"
    >
      <ng-template pTemplate="header">
        <div class="wizard-header">
          <h3>Entrega <code>{{ shipment()?.folio || '—' }}</code></h3>
          <p-tag [severity]="statusSeverity()" [value]="shipment()?.status || ''"></p-tag>
        </div>
      </ng-template>

      <!-- Progress bar -->
      <div class="progress-wrap">
        <p-progressBar [value]="progress()" [showValue]="false"></p-progressBar>
        <span class="progress-label">{{ stepLabel() }} · {{ progress() }}%</span>
      </div>

      <!-- Step indicator -->
      <div class="steps-wrap">
        <div class="step" *ngFor="let s of stepsList; let i = index"
             [class.active]="currentStepIdx() === i"
             [class.done]="currentStepIdx() > i">
          <div class="step-num">{{ i + 1 }}</div>
          <div class="step-label">{{ s.label }}</div>
        </div>
      </div>

      <div class="step-body">
        <!-- ──────────── STEP 1: Checklist Salida ──────────── -->
        <ng-container *ngIf="currentStepIdx() === 0">
          <h4><i class="pi pi-clipboard-check"></i> Checklist de inspección — Salida</h4>
          <p class="muted">Marcá cada item como OK o Issue. Los items con * son obligatorios.</p>

          <div *ngFor="let item of templateSalida()?.items || []" class="item-row">
            <div class="item-label">
              <strong>{{ item.label }}</strong>
              <span *ngIf="item.required" class="req">*</span>
            </div>
            <div class="item-controls">
              <p-selectButton
                [options]="okOptions"
                [(ngModel)]="responsesSalida[item.id].ok"
                optionLabel="label"
                optionValue="value"
              ></p-selectButton>
              <input
                pInputText
                [(ngModel)]="responsesSalida[item.id].comment"
                placeholder="Comentario (opcional)"
                class="comment-input"
              />
            </div>
          </div>

          <div class="step-actions">
            <button pButton severity="secondary" [text]="true" label="Saltar paso" (click)="skipToDepart()" [disabled]="busy()"></button>
            <button pButton label="Completar y salir" icon="pi pi-check" (click)="completeSalidaChecklistAndDepart()" [loading]="busy()"></button>
          </div>
        </ng-container>

        <!-- ──────────── STEP 2: En tránsito ──────────── -->
        <ng-container *ngIf="currentStepIdx() === 1">
          <h4><i class="pi pi-send"></i> En tránsito</h4>
          <div class="transit-card">
            <i class="pi pi-truck transit-icon"></i>
            <p>Dirigite al destino. Cuando llegues, marcá como entregado.</p>
            <p class="muted" *ngIf="shipment()?.destination">Destino: <strong>{{ shipment()?.destination }}</strong></p>
            <p class="muted" *ngIf="shipment()?.departure_at">Salida: {{ shipment()?.departure_at | date:'short' }}</p>
          </div>

          <div class="step-actions">
            <button pButton label="Llegué al destino" icon="pi pi-map-marker" (click)="markDelivered()" [loading]="busy()"></button>
          </div>
        </ng-container>

        <!-- ──────────── STEP 3: Llegada + Fotos ──────────── -->
        <ng-container *ngIf="currentStepIdx() === 2">
          <h4><i class="pi pi-camera"></i> Fotos de entrega</h4>
          <p class="muted">Capturá fotos de la entrega (firma, evidencia, INE receptor). Mínimo 1.</p>

          <div class="photo-actions">
            <button pButton label="Tomar foto (cámara)" icon="pi pi-camera" severity="secondary" (click)="takePhoto()" [loading]="capturingPhoto()"></button>
            <input type="file" accept="image/*" (change)="onFileSelected($event)" #fileInput hidden />
            <button pButton label="Elegir archivo" icon="pi pi-upload" severity="secondary" [text]="true" (click)="fileInput.click()"></button>
          </div>

          <div class="photos-grid" *ngIf="uploadedPhotos().length > 0">
            <div *ngFor="let p of uploadedPhotos()" class="photo-thumb">
              <img [src]="p.url" alt="" />
              <span class="muted small">{{ p.category }}</span>
            </div>
          </div>
          <p *ngIf="uploadedPhotos().length === 0" class="muted small empty-photos">Sin fotos cargadas todavía.</p>

          <div class="step-actions">
            <button pButton severity="secondary" [text]="true" label="Saltar" (click)="skipToLlegadaChecklist()" [disabled]="busy()"></button>
            <button pButton label="Continuar a checklist llegada" icon="pi pi-arrow-right" (click)="continueToLlegada()" [loading]="busy()"></button>
          </div>
        </ng-container>

        <!-- ──────────── STEP 4: Checklist Llegada ──────────── -->
        <ng-container *ngIf="currentStepIdx() === 3">
          <h4><i class="pi pi-flag"></i> Checklist de inspección — Llegada</h4>
          <p class="muted">Inspección post-entrega. Daños, devoluciones, observaciones.</p>

          <div *ngFor="let item of templateLlegada()?.items || []" class="item-row">
            <div class="item-label">
              <strong>{{ item.label }}</strong>
              <span *ngIf="item.required" class="req">*</span>
            </div>
            <div class="item-controls">
              <p-selectButton
                [options]="okOptions"
                [(ngModel)]="responsesLlegada[item.id].ok"
                optionLabel="label"
                optionValue="value"
              ></p-selectButton>
              <input
                pInputText
                [(ngModel)]="responsesLlegada[item.id].comment"
                placeholder="Comentario (opcional)"
                class="comment-input"
              />
            </div>
          </div>

          <div class="step-actions">
            <button pButton severity="secondary" [text]="true" label="Cerrar sin checklist" (click)="closeWithoutChecklist()" [disabled]="busy()"></button>
            <button pButton label="Completar y cerrar entrega" icon="pi pi-check-circle" severity="success" (click)="completeLlegadaAndClose()" [loading]="busy()"></button>
          </div>
        </ng-container>
      </div>
    </p-dialog>
  `,
  styles: [`
    :host { display: contents; }

    .wizard-header { display:flex; align-items:center; gap:1rem; }
    .wizard-header h3 { margin: 0; font-size: 1.1rem; font-weight: 600; }
    code { background: var(--c-surface-2); padding:.1rem .4rem; border-radius: 4px; font-family: var(--font-mono); font-size:.9rem; }

    .progress-wrap { padding: 1rem 1.5rem .5rem; display:flex; flex-direction:column; gap:.5rem; }
    .progress-label { font-size:.75rem; color: var(--c-text-2); text-align: right; }

    .steps-wrap { display:flex; justify-content:space-between; padding: .5rem 1.5rem 1rem; border-bottom: 1px solid var(--c-divider); }
    .step { display:flex; flex-direction:column; align-items:center; gap:.25rem; flex:1; opacity: .5; transition: opacity .2s; }
    .step.active, .step.done { opacity: 1; }
    .step-num { width: 28px; height: 28px; border-radius: 50%; background: var(--c-surface-2); display:flex; align-items:center; justify-content:center; font-weight:600; font-size:.8rem; }
    .step.active .step-num { background: var(--action); color: var(--action-ink); }
    .step.done .step-num { background: var(--ok-fg); color: #fff; }
    .step-label { font-size:.7rem; color: var(--c-text-2); text-align:center; }

    .step-body { padding: 1.5rem; }
    .step-body h4 { margin: 0 0 .5rem; font-size: 1rem; font-weight: 600; }
    .muted { color: var(--c-text-2); font-size: .85rem; margin: 0 0 1rem; }
    .small { font-size: .75rem; }

    .item-row { display:flex; flex-direction:column; gap:.5rem; padding:.75rem; border: 1px solid var(--c-divider); border-radius:8px; margin-bottom:.5rem; }
    .item-label { display:flex; align-items:center; gap:.5rem; }
    .req { color: var(--bad-fg); }
    .item-controls { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
    .comment-input { flex:1; min-width: 180px; }

    .transit-card { text-align:center; padding: 2rem; background: var(--c-surface-2); border-radius: 12px; }
    .transit-icon { font-size: 3rem; color: var(--action); margin-bottom: 1rem; display:block; }

    .photo-actions { display:flex; gap:.5rem; flex-wrap:wrap; margin-bottom: 1rem; }
    .photos-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap:.5rem; margin-bottom:1rem; }
    .photo-thumb { background: var(--c-surface-2); border-radius:6px; padding:.25rem; display:flex; flex-direction:column; gap:.25rem; }
    .photo-thumb img { width: 100%; height: 100px; object-fit: cover; border-radius:4px; }
    .empty-photos { text-align: center; padding: 1rem; background: var(--c-surface-2); border-radius: 6px; }

    .step-actions { display:flex; justify-content:space-between; gap:.5rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--c-divider); flex-wrap:wrap; }

    /* Mobile responsive */
    @media (max-width: 600px) {
      .item-controls { flex-direction: column; align-items: stretch; }
      .step-actions { flex-direction: column-reverse; }
      .step-actions button { width: 100%; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryWizardComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);
  private readonly tracking = inject(TrackingService);

  // ── Inputs / Outputs ─────────────────────────────────────────────────────
  visible = input<boolean>(false);
  shipmentId = input<string | null>(null);
  visibleChange = output<boolean>();
  completed = output<void>();
  statusChanged = output<ShipmentStatus>();

  // ── State ────────────────────────────────────────────────────────────────
  readonly shipment = signal<Shipment | null>(null);
  readonly templateSalida = signal<{ items: any[] } | null>(null);
  readonly templateLlegada = signal<{ items: any[] } | null>(null);
  readonly uploadedPhotos = signal<Array<{ id: string; url: string; category: string }>>([]);
  readonly busy = signal(false);
  readonly capturingPhoto = signal(false);

  // Maps editables por template item
  responsesSalida: Record<string, ChecklistResponse> = {};
  responsesLlegada: Record<string, ChecklistResponse> = {};

  // IDs de checklists creados (para complete)
  private salidaChecklistId: string | null = null;
  private llegadaChecklistId: string | null = null;

  // ── Computed ─────────────────────────────────────────────────────────────
  readonly stepsList = [
    { label: 'Checklist salida' },
    { label: 'En tránsito' },
    { label: 'Fotos entrega' },
    { label: 'Checklist llegada' },
  ];

  /** Mapea status del shipment al index del step actual (0..3). */
  readonly currentStepIdx = computed(() => {
    const s = this.shipment()?.status;
    if (!s) return 0;
    if (s === 'programado' || s === 'checklist_salida') return 0;
    if (s === 'en_ruta') return 1;
    if (s === 'entregado') return 2;
    if (s === 'checklist_llegada' || s === 'costos_pendientes') return 3;
    return 3; // cerrado/cancelado caen acá pero el wizard se cierra
  });

  readonly progress = computed(() => Math.round((this.currentStepIdx() / 3) * 100));
  readonly stepLabel = computed(() => this.stepsList[this.currentStepIdx()]?.label || '');

  readonly statusSeverity = computed<Severity>(() => {
    const s = this.shipment()?.status;
    if (s === 'cerrado') return 'success';
    if (s === 'cancelado') return 'danger';
    if (s === 'en_ruta' || s === 'costos_pendientes') return 'warn';
    if (s === 'entregado' || s === 'checklist_llegada') return 'success';
    return 'info';
  });

  readonly okOptions = [
    { label: 'OK', value: true },
    { label: 'Issue', value: false },
  ];

  constructor() {
    // Cuando shipmentId o visible cambian, cargar shipment + templates + fotos
    effect(() => {
      const id = this.shipmentId();
      const open = this.visible();
      if (id && open) {
        this.loadAll(id);
      }
    });
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  private loadAll(shipmentId: string): void {
    this.busy.set(true);
    this.api.getShipment(shipmentId).subscribe({
      next: (s) => {
        this.shipment.set(s);
        this.busy.set(false);
        this.loadTemplatesAndExisting(shipmentId);
      },
      error: () => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargó el embarque' });
      },
    });
  }

  private loadTemplatesAndExisting(shipmentId: string): void {
    // Templates
    this.api.getChecklistTemplate('salida').subscribe((tpl) => {
      this.templateSalida.set({ items: tpl.items });
      for (const it of tpl.items) {
        if (!this.responsesSalida[it.id]) this.responsesSalida[it.id] = { ok: true };
      }
    });
    this.api.getChecklistTemplate('llegada').subscribe((tpl) => {
      this.templateLlegada.set({ items: tpl.items });
      for (const it of tpl.items) {
        if (!this.responsesLlegada[it.id]) this.responsesLlegada[it.id] = { ok: true };
      }
    });

    // Checklists previos
    this.api.listChecklistsByShipment(shipmentId).subscribe((list) => {
      for (const cl of list) {
        if (cl.type === 'salida') this.salidaChecklistId = cl.id;
        if (cl.type === 'llegada') this.llegadaChecklistId = cl.id;
        // Si hay responses guardadas, las inyectamos para mostrar como editado
        if (cl.responses) {
          const map = cl.type === 'salida' ? this.responsesSalida : this.responsesLlegada;
          for (const [k, v] of Object.entries(cl.responses)) map[k] = v as ChecklistResponse;
        }
      }
    });

    // Fotos previas
    this.api.listPhotosByShipment(shipmentId, 'delivery').subscribe((list) => {
      this.uploadedPhotos.set(list.map((p) => ({ id: p.id, url: p.url, category: p.category })));
    });
  }

  // ── STEP 1 actions ───────────────────────────────────────────────────────

  /** Completa checklist salida (crea si no existe) + transición programado→checklist_salida→en_ruta. */
  async completeSalidaChecklistAndDepart(): Promise<void> {
    const sid = this.shipmentId();
    if (!sid) return;
    this.busy.set(true);

    // Intentar arrancar rastreo antes de salir a ruta
    await this.tracking.startBackgroundTracking();

    const items = this.templateSalida()?.items || [];
    const ensureChecklist$ = this.salidaChecklistId
      ? Promise.resolve({ id: this.salidaChecklistId })
      : new Promise<{ id: string }>((resolve, reject) => {
          this.api.createChecklist({ shipment_id: sid, type: 'salida', items }).subscribe({
            next: (cl) => { this.salidaChecklistId = cl.id; resolve({ id: cl.id }); },
            error: (e) => reject(e),
          });
        });

    ensureChecklist$
      .then((cl) =>
        new Promise((resolve, reject) =>
          this.api.completeChecklist(cl.id, { responses: this.responsesSalida }).subscribe({
            next: resolve, error: reject,
          })
        )
      )
      .then(() => this.transitionTo('depart'))
      .catch((e: any) => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se completó el checklist' });
      });
  }

  /** Sin completar checklist — directo a en_ruta (programado → en_ruta). */
  async skipToDepart(): Promise<void> {
    await this.tracking.startBackgroundTracking();
    this.transitionTo('depart');
  }

  // ── STEP 2 actions ───────────────────────────────────────────────────────

  markDelivered(): void {
    this.transitionTo('deliver');
  }

  // ── STEP 3 actions ───────────────────────────────────────────────────────

  async takePhoto(): Promise<void> {
    const sid = this.shipmentId();
    if (!sid) return;
    this.capturingPhoto.set(true);
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
      const photo = await Camera.getPhoto({
        quality: 75,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Prompt,
      });
      if (photo.dataUrl) {
        await this.uploadPhotoBase64(photo.dataUrl);
      }
    } catch (e: any) {
      if (e?.message && !/cancel/i.test(e.message)) {
        this.toast.add({ severity: 'error', summary: 'Cámara', detail: e.message });
      }
    } finally {
      this.capturingPhoto.set(false);
    }
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result as string;
      this.uploadPhotoBase64(b64);
    };
    reader.readAsDataURL(file);
  }

  private async uploadPhotoBase64(dataUrl: string): Promise<void> {
    const sid = this.shipmentId();
    if (!sid) return;
    this.capturingPhoto.set(true);
    // GPS opcional (no bloquea si falla)
    let gps_lat: number | undefined; let gps_lng: number | undefined;
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      const pos = await Geolocation.getCurrentPosition({ timeout: 5000 });
      gps_lat = Number(pos.coords.latitude.toFixed(7));
      gps_lng = Number(pos.coords.longitude.toFixed(7));
    } catch (_) { /* GPS opcional */ }

    this.api.uploadPhoto({
      shipment_id: sid,
      category: 'delivery',
      image_base64: dataUrl,
      gps_lat, gps_lng,
      captured_at: new Date().toISOString(),
    }).subscribe({
      next: (p) => {
        this.uploadedPhotos.update((arr) => [...arr, { id: p.id, url: p.url, category: p.category }]);
        this.toast.add({ severity: 'success', summary: 'Foto subida', detail: '' });
        this.capturingPhoto.set(false);
      },
      error: (e) => {
        this.capturingPhoto.set(false);
        this.toast.add({ severity: 'error', summary: 'Error upload', detail: e?.error?.message || 'No se subió' });
      },
    });
  }

  continueToLlegada(): void {
    // entregado → checklist_llegada
    this.transitionTo('startLlegadaChecklist');
  }

  skipToLlegadaChecklist(): void {
    this.transitionTo('startLlegadaChecklist');
  }

  // ── STEP 4 actions ───────────────────────────────────────────────────────

  completeLlegadaAndClose(): void {
    const sid = this.shipmentId();
    if (!sid) return;
    this.busy.set(true);

    const items = this.templateLlegada()?.items || [];
    const ensureChecklist$ = this.llegadaChecklistId
      ? Promise.resolve({ id: this.llegadaChecklistId })
      : new Promise<{ id: string }>((resolve, reject) => {
          this.api.createChecklist({ shipment_id: sid, type: 'llegada', items }).subscribe({
            next: (cl) => { this.llegadaChecklistId = cl.id; resolve({ id: cl.id }); },
            error: (e) => reject(e),
          });
        });

    ensureChecklist$
      .then((cl) =>
        new Promise((resolve, reject) =>
          this.api.completeChecklist(cl.id, { responses: this.responsesLlegada }).subscribe({
            next: resolve, error: reject,
          })
        )
      )
      .then(() => this.transitionTo('close'))
      .catch((e: any) => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se completó el checklist' });
      });
  }

  closeWithoutChecklist(): void {
    this.transitionTo('close');
  }

  // ── Common state machine transition ──────────────────────────────────────

  private transitionTo(action: 'depart' | 'deliver' | 'startLlegadaChecklist' | 'close'): void {
    const sid = this.shipmentId();
    if (!sid) return;
    this.busy.set(true);
    const obs$ =
      action === 'depart' ? this.api.shipmentDepart(sid) :
      action === 'deliver' ? this.api.shipmentDeliver(sid) :
      action === 'startLlegadaChecklist' ? this.api.shipmentStartLlegadaChecklist(sid) :
      this.api.shipmentClose(sid);

    obs$.subscribe({
      next: (s) => {
        this.shipment.set(s);
        this.statusChanged.emit(s.status);
        this.busy.set(false);
        if (action === 'close') {
          // Detener rastreo al cerrar entrega
          this.tracking.stopTracking();
          this.toast.add({ severity: 'success', summary: 'Entrega cerrada', detail: `Folio ${s.folio}` });
          this.completed.emit();
          // Cerrar dialog tras 1.5s
          setTimeout(() => this.visibleChange.emit(false), 1500);
        }
      },
      error: (e) => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: 'Transición fallida', detail: e?.error?.message || '' });
      },
    });
  }
}
