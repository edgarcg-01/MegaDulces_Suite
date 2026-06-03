import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  VendorService,
  RouteTicket,
  RouteTicketType,
  ProcesarRouteTicketResult,
} from '../vendor.service';

type Step = 'pick' | 'review';

const TYPE_META: Record<RouteTicketType, { label: string; icon: string }> = {
  venta: { label: 'Corte de venta', icon: 'pi-receipt' },
  carga: { label: 'Carga', icon: 'pi-box' },
  combustible: { label: 'Combustible', icon: 'pi-bolt' },
};

@Component({
  selector: 'app-vendor-close-route',
  standalone: true,
  imports: [CommonModule, FormsModule, CardModule, ButtonModule, TagModule],
  template: `
    <h1 class="page-title">Cierre de ruta</h1>
    <p class="subtitle">Sube tus tickets del día: corte, carga y combustible</p>

    <!-- Paso 1: elegir tipo -->
    <div *ngIf="step() === 'pick'" class="pick-grid">
      <p-card *ngFor="let t of types" styleClass="pick-card" (click)="choose(t)">
        <div class="pick-content">
          <i class="pi {{ meta[t].icon }}"></i>
          <span>{{ meta[t].label }}</span>
        </div>
      </p-card>
    </div>

    <input
      #fileInput
      type="file"
      accept="image/*"
      capture="environment"
      hidden
      (change)="onFile($event)"
    />

    <p-card *ngIf="processing()" styleClass="status-card">
      <div class="status"><i class="pi pi-spin pi-spinner"></i> Extrayendo datos del ticket…</div>
    </p-card>

    <!-- Paso 2: revisar + guardar -->
    <div *ngIf="step() === 'review'" class="review">
      <div class="review-head">
        <p-tag [value]="meta[selectedType()!].label" severity="info"></p-tag>
        <button pButton label="Cambiar" icon="pi pi-times" severity="secondary" text size="small" (click)="reset()"></button>
      </div>

      <img *ngIf="photoPreview()" [src]="photoPreview()!" class="preview" alt="ticket" />

      <div class="field">
        <label>Ruta (RD)</label>
        <input type="text" [(ngModel)]="form.route_code" placeholder="ej. 12" />
        <span class="badge" [class.ok]="!!form.route_code">{{ form.route_code ? 'detectado' : 'sin detectar' }}</span>
      </div>
      <div class="field">
        <label>Fecha</label>
        <input type="date" [(ngModel)]="form.ticket_date" />
        <span class="badge" [class.ok]="!!form.ticket_date">{{ form.ticket_date ? 'detectado' : 'sin detectar' }}</span>
      </div>
      <div class="field">
        <label>Total ($)</label>
        <input type="number" step="0.01" [(ngModel)]="form.total" />
      </div>
      <div class="field" *ngIf="selectedType() === 'venta'">
        <label>Número de corte</label>
        <input type="text" [(ngModel)]="form.corte_number" />
      </div>
      <div class="field" *ngIf="selectedType() === 'combustible'">
        <label>Litros</label>
        <input type="number" step="0.01" [(ngModel)]="form.liters" />
      </div>
      <div class="field" *ngIf="selectedType() === 'combustible'">
        <label>Referencia / folio</label>
        <input type="text" [(ngModel)]="form.reference" />
      </div>

      <p class="warn" *ngIf="!canSave()">Faltan datos obligatorios (ruta y fecha). Corrige o vuelve a tomar la foto.</p>

      <button
        pButton
        label="Guardar ticket"
        icon="pi pi-check"
        styleClass="w-full"
        [disabled]="!canSave() || saving()"
        [loading]="saving()"
        (click)="save()"
      ></button>
    </div>

    <!-- Tickets recientes -->
    <h2 class="section-title" *ngIf="step() === 'pick'">Tickets de hoy</h2>
    <div *ngIf="step() === 'pick'" class="ticket-list">
      <p-card *ngFor="let t of tickets()" styleClass="ticket-card">
        <div class="ticket-row">
          <div class="info">
            <p-tag [value]="meta[t.ticket_type].label" [severity]="typeSeverity(t.ticket_type)"></p-tag>
            <span class="meta">RD{{ t.route_code }} · {{ t.ticket_date }}</span>
          </div>
          <div class="total">{{ t.total != null ? fmtMoney(t.total) : '—' }}</div>
        </div>
      </p-card>
      <p class="empty" *ngIf="!loadingList() && tickets().length === 0">Aún no subiste tickets hoy.</p>
    </div>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.25rem; font-size: 1.5rem; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; }
      .pick-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; margin-bottom: 1.5rem; }
      :host ::ng-deep .p-card.pick-card { cursor: pointer; background: var(--card-bg); border: 1px solid var(--border-color); transition: box-shadow .15s; }
      :host ::ng-deep .p-card.pick-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,.08); }
      :host ::ng-deep .p-card.pick-card .p-card-body { padding: 1rem 0.5rem; }
      .pick-content { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; text-align: center; }
      .pick-content i { font-size: 1.75rem; color: var(--brand-700); }
      .pick-content span { font-size: 0.8rem; color: var(--text-main); font-weight: 600; }
      .status { display: flex; align-items: center; gap: 0.5rem; color: var(--text-muted); }
      .review-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
      .preview { width: 100%; max-height: 240px; object-fit: contain; border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 1rem; background: #000; }
      .field { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.875rem; position: relative; }
      .field label { font-size: 0.8rem; color: var(--text-muted); font-weight: 600; }
      .field input { padding: 0.625rem 0.75rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--text-main); font-size: 1rem; }
      .badge { position: absolute; right: 0; top: 0; font-size: 0.65rem; text-transform: uppercase; letter-spacing: .04em; color: var(--bad, #b91c1c); }
      .badge.ok { color: var(--ok, #15803d); }
      .warn { color: var(--bad, #b91c1c); font-size: 0.8rem; margin: 0 0 0.75rem; }
      :host ::ng-deep .w-full { width: 100%; }
      .section-title { font-size: 1rem; color: var(--text-main); margin: 1.5rem 0 0.75rem; }
      .ticket-list { display: flex; flex-direction: column; gap: 0.5rem; }
      :host ::ng-deep .p-card.ticket-card { background: var(--card-bg); border: 1px solid var(--border-color); }
      :host ::ng-deep .p-card.ticket-card .p-card-body { padding: 0.75rem; }
      .ticket-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
      .info { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
      .meta { font-size: 0.75rem; color: var(--text-muted); }
      .total { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .empty { text-align: center; color: var(--text-muted); padding: 1rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorCloseRouteComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly types: RouteTicketType[] = ['venta', 'carga', 'combustible'];
  readonly meta = TYPE_META;

  readonly step = signal<Step>('pick');
  readonly selectedType = signal<RouteTicketType | null>(null);
  readonly processing = signal(false);
  readonly saving = signal(false);
  readonly photoPreview = signal<string | null>(null);
  readonly tickets = signal<RouteTicket[]>([]);
  readonly loadingList = signal(true);

  private lastResult: ProcesarRouteTicketResult | null = null;
  form: {
    route_code: string;
    ticket_date: string;
    total: number | null;
    corte_number: string | null;
    reference: string | null;
    liters: number | null;
  } = this.emptyForm();

  ngOnInit(): void {
    this.loadList();
  }

  choose(t: RouteTicketType): void {
    this.selectedType.set(t);
    // dispara el file picker (definido en el template con #fileInput)
    queueMicrotask(() => {
      const el = document.querySelector<HTMLInputElement>('input[type=file]');
      el?.click();
    });
  }

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // permite re-seleccionar la misma foto
    const type = this.selectedType();
    if (!file || !type) return;

    this.processing.set(true);
    try {
      const compressed = await this.compress(file);
      this.photoPreview.set(URL.createObjectURL(compressed));
      this.api
        .procesarTicket(type, compressed)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            this.lastResult = res;
            this.form = {
              route_code: res.fields.route_code ?? '',
              ticket_date: res.fields.ticket_date ?? this.today(),
              total: res.fields.total,
              corte_number: res.fields.corte_number,
              reference: res.fields.reference,
              liters: res.fields.liters,
            };
            this.processing.set(false);
            this.step.set('review');
          },
          error: (e) => {
            this.processing.set(false);
            this.toast.add({ severity: 'error', summary: 'OCR falló', detail: e?.error?.message || 'Intenta de nuevo' });
          },
        });
    } catch {
      this.processing.set(false);
      this.toast.add({ severity: 'error', summary: 'Imagen inválida' });
    }
  }

  canSave(): boolean {
    return !!this.form.route_code?.trim() && !!this.form.ticket_date;
  }

  save(): void {
    const type = this.selectedType();
    if (!type || !this.canSave()) return;
    this.saving.set(true);
    this.api
      .guardarTicket({
        ticket_type: type,
        route_code: this.form.route_code.trim(),
        ticket_date: this.form.ticket_date,
        total: this.form.total,
        corte_number: type === 'venta' ? this.form.corte_number : null,
        reference: type === 'combustible' ? this.form.reference : null,
        liters: type === 'combustible' ? this.form.liters : null,
        cloudinary_public_id: this.lastResult?.cloudinary_public_id ?? null,
        photo_url: this.lastResult?.photo_url ?? null,
        photo_preview_url: this.lastResult?.photo_preview_url ?? null,
        ocr_json: this.lastResult?.fields ?? null,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.toast.add({ severity: 'success', summary: 'Ticket guardado' });
          this.reset();
          this.loadList();
        },
        error: (e) => {
          this.saving.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || '' });
        },
      });
  }

  reset(): void {
    this.step.set('pick');
    this.selectedType.set(null);
    this.photoPreview.set(null);
    this.lastResult = null;
    this.form = this.emptyForm();
  }

  private loadList(): void {
    this.loadingList.set(true);
    this.api
      .listTickets({ pageSize: 30 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.tickets.set(r.data || []);
          this.loadingList.set(false);
        },
        error: () => this.loadingList.set(false),
      });
  }

  /** Downscale a 1920px máx + JPEG calidad 0.8 vía canvas (sin dependencias). */
  private compress(file: File): Promise<File> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1920;
        let { width, height } = img;
        if (width > max || height > max) {
          const r = Math.min(max / width, max / height);
          width = Math.round(width * r);
          height = Math.round(height * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('no canvas ctx'));
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('toBlob falló'));
            resolve(new File([blob], 'ticket.jpg', { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.8,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('no se pudo leer la imagen'));
      };
      img.src = url;
    });
  }

  typeSeverity(t: RouteTicketType): 'success' | 'info' | 'warn' {
    return t === 'venta' ? 'success' : t === 'combustible' ? 'warn' : 'info';
  }
  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
  private emptyForm() {
    return { route_code: '', ticket_date: this.today(), total: null, corte_number: null, reference: null, liters: null };
  }
}
