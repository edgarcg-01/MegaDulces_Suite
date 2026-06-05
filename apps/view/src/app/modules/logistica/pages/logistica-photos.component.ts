import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  LogisticaService,
  PhotoCategory,
  Shipment,
  ShipmentPhoto,
} from '../logistica.service';

@Component({
  selector: 'app-logistica-photos',
  standalone: true,
  imports: [
    CommonModule, RouterLink, FormsModule,
    ButtonModule, CardModule, TagModule, SelectModule, InputTextModule,
    ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <header class="surf-page-head" *ngIf="shipment() as s">
      <div class="surf-page-head-text">
        <a [routerLink]="['/logistica/shipments', s.id]" class="back">
          <i class="pi pi-arrow-left"></i> Volver al embarque
        </a>
        <h1>Fotos — <code>{{ s.folio }}</code></h1>
        <p class="surf-page-sub">Sube fotos categorizadas. GPS y captura desde cámara disponibles en mobile.</p>
      </div>
    </header>

    <!-- Upload form -->
    <p-card>
      <h3>Nueva foto</h3>
      <div class="upload-grid">
        <label>
          Categoría
          <p-select
            [options]="categoryOptions"
            [(ngModel)]="category"
            optionLabel="label"
            optionValue="value"
          ></p-select>
        </label>
        <label class="full">
          Descripción (opcional)
          <input pInputText [(ngModel)]="description" placeholder="Ej: Carga completa antes de salir" />
        </label>
        <label class="gps-row">
          GPS
          <div class="gps-controls">
            <input pInputText type="number" step="0.0000001" [(ngModel)]="gpsLat" placeholder="Lat" />
            <input pInputText type="number" step="0.0000001" [(ngModel)]="gpsLng" placeholder="Lng" />
            <button pButton icon="pi pi-map-marker" size="small" severity="secondary" label="Mi ubicación" (click)="captureLocation()" [loading]="capturingLocation()"></button>
          </div>
        </label>
      </div>

      <div class="capture-row">
        <button pButton icon="pi pi-camera" label="Tomar foto (Capacitor)" (click)="takePhoto()" [loading]="capturing()"></button>
        <span class="muted">o</span>
        <input type="file" accept="image/*" (change)="onFileSelected($event)" #fileInput hidden />
        <button pButton icon="pi pi-upload" label="Elegir archivo" severity="secondary" (click)="fileInput.click()"></button>
      </div>

      <div class="preview" *ngIf="previewBase64()">
        <img [src]="previewBase64()" alt="preview" />
        <button pButton icon="pi pi-check" label="Subir" (click)="upload()" [loading]="uploading()"></button>
        <button pButton icon="pi pi-times" label="Descartar" severity="secondary" [text]="true" (click)="clearPreview()"></button>
      </div>
    </p-card>

    <!-- Filter + grid -->
    <p-card class="grid-card">
      <div class="filter-row">
        <label>
          Filtrar por categoría
          <p-select
            [options]="filterOptions"
            [(ngModel)]="filterCategory"
            (onChange)="reload()"
            optionLabel="label"
            optionValue="value"
            [showClear]="true"
          ></p-select>
        </label>
        <span class="muted">{{ photos().length }} fotos</span>
      </div>

      <div class="photos-grid">
        <div *ngFor="let p of photos()" class="photo-card">
          <a [href]="p.url" target="_blank"><img [src]="p.url" alt="" /></a>
          <div class="photo-meta">
            <p-tag [value]="p.category" severity="secondary"></p-tag>
            <span class="muted">{{ p.uploaded_at | date:'short' }}</span>
          </div>
          <p *ngIf="p.description" class="desc">{{ p.description }}</p>
          <p *ngIf="p.gps_lat && p.gps_lng" class="gps">
            📍 {{ p.gps_lat }}, {{ p.gps_lng }}
          </p>
          <button pButton icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="confirmDelete(p)" label="Borrar"></button>
        </div>
        <div *ngIf="!photos().length" class="empty">No hay fotos en esta categoría.</div>
      </div>
    </p-card>
  `,
  styles: [`
    :host { display:block; }
    .back { color: var(--primary-color); text-decoration:none; font-size:.85rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; }
    h3 { margin:0 0 .75rem; font-size:1rem; }
    .upload-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:1rem; }
    .upload-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--text-color-secondary); }
    .upload-grid .full { grid-column: 1 / -1; }
    .gps-controls { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
    .gps-controls input { width: 100px; }
    .capture-row { display:flex; gap:1rem; align-items:center; margin-top:1rem; flex-wrap:wrap; }
    .preview { display:flex; gap:1rem; align-items:center; margin-top:1rem; padding:1rem; background: var(--surface-50); border-radius:8px; }
    .preview img { max-width: 200px; max-height: 200px; border-radius:6px; }
    .grid-card { margin-top:1rem; }
    .filter-row { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; }
    .filter-row label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--text-color-secondary); min-width:200px; }
    .photos-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:1rem; }
    .photo-card { background: var(--surface-50); border-radius:8px; padding:.5rem; display:flex; flex-direction:column; gap:.5rem; }
    .photo-card img { width:100%; height: 180px; object-fit:cover; border-radius:6px; }
    .photo-meta { display:flex; justify-content:space-between; align-items:center; gap:.5rem; }
    .desc { font-size:.85rem; margin:0; }
    .gps { font-size:.75rem; color: var(--text-color-secondary); margin:0; }
    .empty { grid-column: 1 / -1; text-align:center; padding:2rem; color: var(--text-color-secondary); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaPhotosComponent {
  private readonly api = inject(LogisticaService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly shipmentId = signal<string>('');
  readonly shipment = signal<Shipment | null>(null);
  readonly photos = signal<ShipmentPhoto[]>([]);
  readonly capturing = signal(false);
  readonly capturingLocation = signal(false);
  readonly uploading = signal(false);
  readonly previewBase64 = signal<string | null>(null);

  category: PhotoCategory = 'delivery';
  description = '';
  gpsLat: number | null = null;
  gpsLng: number | null = null;
  filterCategory: PhotoCategory | null = null;

  readonly categoryOptions: Array<{ label: string; value: PhotoCategory }> = [
    { label: 'Carga (loading)', value: 'loading' },
    { label: 'En tránsito (transit)', value: 'transit' },
    { label: 'Entrega (delivery)', value: 'delivery' },
    { label: 'Incidente (incident)', value: 'incident' },
    { label: 'Checklist', value: 'checklist' },
    { label: 'Otro', value: 'other' },
  ];
  readonly filterOptions = this.categoryOptions;

  constructor() {
    const id = this.route.snapshot.paramMap.get('shipmentId');
    if (!id) {
      this.router.navigate(['/logistica/shipments']);
      return;
    }
    this.shipmentId.set(id);
    this.loadShipment();
    this.reload();
  }

  loadShipment(): void {
    this.api.getShipment(this.shipmentId()).subscribe({
      next: (s) => this.shipment.set(s),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargó shipment' }),
    });
  }

  reload(): void {
    this.api.listPhotosByShipment(this.shipmentId(), this.filterCategory || undefined).subscribe({
      next: (list) => this.photos.set(list),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron fotos' }),
    });
  }

  /** Toma foto usando Capacitor camera (mobile native + web fallback). */
  async takePhoto(): Promise<void> {
    this.capturing.set(true);
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
      const photo = await Camera.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Prompt, // user picks Camera or Photos
        promptLabelHeader: 'Tomar foto',
        promptLabelPhoto: 'Galería',
        promptLabelPicture: 'Cámara',
      });
      if (photo.dataUrl) {
        this.previewBase64.set(photo.dataUrl);
      }
    } catch (e: any) {
      // Si usuario canceló no es error
      if (e?.message && !/cancel/i.test(e.message)) {
        this.toast.add({ severity: 'error', summary: 'Cámara', detail: e.message });
      }
    } finally {
      this.capturing.set(false);
    }
  }

  /** Captura GPS usando Capacitor geolocation. */
  async captureLocation(): Promise<void> {
    this.capturingLocation.set(true);
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
      });
      this.gpsLat = Number(pos.coords.latitude.toFixed(7));
      this.gpsLng = Number(pos.coords.longitude.toFixed(7));
      this.toast.add({
        severity: 'success',
        summary: 'GPS capturado',
        detail: `${this.gpsLat}, ${this.gpsLng}`,
      });
    } catch (e: any) {
      this.toast.add({ severity: 'error', summary: 'GPS', detail: e?.message || 'No se obtuvo ubicación' });
    } finally {
      this.capturingLocation.set(false);
    }
  }

  /** Fallback web: file picker. */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.previewBase64.set(reader.result as string);
    reader.readAsDataURL(file);
  }

  clearPreview(): void {
    this.previewBase64.set(null);
  }

  upload(): void {
    const base64 = this.previewBase64();
    if (!base64) {
      this.toast.add({ severity: 'warn', summary: 'Sin foto', detail: 'Toma o elige una foto primero' });
      return;
    }
    this.uploading.set(true);
    this.api.uploadPhoto({
      shipment_id: this.shipmentId(),
      category: this.category,
      description: this.description || undefined,
      image_base64: base64,
      gps_lat: this.gpsLat ?? undefined,
      gps_lng: this.gpsLng ?? undefined,
      captured_at: new Date().toISOString(),
    }).subscribe({
      next: () => {
        this.toast.add({ severity: 'success', summary: 'Subida OK', detail: 'Foto registrada' });
        this.uploading.set(false);
        this.clearPreview();
        this.description = '';
        this.reload();
      },
      error: (e) => {
        this.uploading.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'Error upload',
          detail: e?.error?.message || 'Falló el upload',
        });
      },
    });
  }

  confirmDelete(p: ShipmentPhoto): void {
    this.confirm.confirm({
      message: '¿Borrar esta foto? Se eliminará también de Cloudinary.',
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.api.deletePhoto(p.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Borrada' });
            this.reload();
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se borró' }),
        });
      },
    });
  }
}
