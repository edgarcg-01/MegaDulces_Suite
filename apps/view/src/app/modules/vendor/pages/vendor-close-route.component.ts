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
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  VendorService,
  RouteTicket,
  RouteTicketType,
  ProcesarRouteTicketResult,
} from '../vendor.service';

type Step = 'pick' | 'review';

interface EditableCargaLine {
  product_id: string;
  product_name: string;
  quantity: number;
  include: boolean;
}

const TYPE_META: Record<RouteTicketType, { label: string; icon: string }> = {
  venta: { label: 'Corte de venta', icon: 'pi-receipt' },
  carga: { label: 'Carga', icon: 'pi-box' },
  combustible: { label: 'Combustible', icon: 'pi-bolt' },
};

@Component({
  selector: 'app-vendor-close-route',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="crt">
      <header class="crt-head">
        <div class="crt-head-text">
          <h1>Cierre de ruta</h1>
          <p>Sube tus tickets del día: corte, carga y combustible</p>
        </div>
        @if (step() === 'pick' && !loadingList()) {
          <div class="crt-daycount" aria-label="Tickets de hoy">
            <span class="crt-daycount-n">{{ tickets().length }}</span>
            <span class="crt-daycount-l">hoy</span>
          </div>
        }
      </header>

      <input
        #fileInput
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        (change)="onFile($event)"
      />

      <!-- Paso 1: elegir tipo -->
      <div *ngIf="step() === 'pick'" class="crt-pick">
        <button *ngFor="let t of types" type="button" class="crt-tile" [attr.data-type]="t" (click)="choose(t)">
          <span class="crt-tile-icon"><i class="pi {{ meta[t].icon }}" aria-hidden="true"></i></span>
          <span class="crt-tile-label">{{ meta[t].label }}</span>
          <span class="crt-tile-cta"><i class="pi pi-camera" aria-hidden="true"></i> Tomar foto</span>
        </button>
      </div>

      <!-- Procesando OCR -->
      <div *ngIf="processing()" class="crt-processing">
        <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
        <span>Extrayendo datos del ticket…</span>
      </div>

      <!-- Paso 2: revisar + guardar -->
      <div *ngIf="step() === 'review'" class="crt-review">
        <div class="crt-review-head">
          <span class="crt-type-chip" [attr.data-type]="selectedType()">
            <i class="pi {{ meta[selectedType()!].icon }}" aria-hidden="true"></i>{{ meta[selectedType()!].label }}
          </span>
          <button type="button" class="crt-change" (click)="reset()">
            <i class="pi pi-times" aria-hidden="true"></i> Cambiar
          </button>
        </div>

        <img *ngIf="photoPreview()" [src]="photoPreview()!" class="crt-preview" alt="Ticket capturado" />

        <div class="crt-fields">
          <label class="crt-field">
            <span class="crt-field-label">Ruta (RD)</span>
            <div class="crt-input-wrap">
              <input type="text" [(ngModel)]="form.route_code" placeholder="ej. 12" />
              <span class="crt-detect" [class.ok]="!!form.route_code">{{ form.route_code ? 'detectado' : 'sin detectar' }}</span>
            </div>
          </label>

          <label class="crt-field">
            <span class="crt-field-label">Fecha</span>
            <div class="crt-input-wrap">
              <input type="date" [(ngModel)]="form.ticket_date" />
              <span class="crt-detect" [class.ok]="!!form.ticket_date">{{ form.ticket_date ? 'detectado' : 'sin detectar' }}</span>
            </div>
          </label>

          <label class="crt-field">
            <span class="crt-field-label">Total ($)</span>
            <input type="number" step="0.01" [(ngModel)]="form.total" placeholder="0.00" />
          </label>

          <label class="crt-field" *ngIf="selectedType() === 'venta'">
            <span class="crt-field-label">Número de corte</span>
            <input type="text" [(ngModel)]="form.corte_number" />
          </label>

          <label class="crt-field" *ngIf="selectedType() === 'combustible'">
            <span class="crt-field-label">Litros</span>
            <input type="number" step="0.01" [(ngModel)]="form.liters" placeholder="0.00" />
          </label>

          <label class="crt-field" *ngIf="selectedType() === 'combustible'">
            <span class="crt-field-label">Referencia / folio</span>
            <input type="text" [(ngModel)]="form.reference" />
          </label>
        </div>

        <!-- Carga: productos detectados → descargan al camión -->
        <div *ngIf="selectedType() === 'carga'" class="crt-lines">
          <div class="crt-lines-head">
            <span>Productos cargados al camión</span>
            <span class="crt-lines-count">{{ includedCount() }} de {{ cargaLines().length }}</span>
          </div>
          <p class="crt-lines-empty" *ngIf="cargaLines().length === 0">
            No se detectaron productos. Puedes guardar solo el total igual.
          </p>
          <label class="crt-line" *ngFor="let l of cargaLines()" [class.off]="!l.include">
            <input type="checkbox" [(ngModel)]="l.include" />
            <span class="crt-line-name">{{ l.product_name }}</span>
            <input class="crt-line-qty" type="number" min="1" step="1" [(ngModel)]="l.quantity" [disabled]="!l.include" />
          </label>
        </div>

        <p class="crt-warn" *ngIf="!canSave()">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          Faltan datos obligatorios (ruta y fecha). Corrige o vuelve a tomar la foto.
        </p>

        <button type="button" class="crt-save" [disabled]="!canSave() || saving()" (click)="save()">
          <i class="pi" [ngClass]="saving() ? 'pi-spin pi-spinner' : 'pi-check'" aria-hidden="true"></i>
          Guardar ticket
        </button>
      </div>

      <!-- Tickets de hoy -->
      <section *ngIf="step() === 'pick'" class="crt-recent">
        <h2 class="crt-section">Tickets de hoy</h2>
        <div class="crt-list">
          <div *ngFor="let t of tickets()" class="crt-ticket" [attr.data-type]="t.ticket_type">
            <span class="crt-ticket-icon"><i class="pi {{ meta[t.ticket_type].icon }}" aria-hidden="true"></i></span>
            <div class="crt-ticket-info">
              <span class="crt-ticket-type">{{ meta[t.ticket_type].label }}</span>
              <span class="crt-ticket-meta">RD{{ t.route_code }} · {{ t.ticket_date }}</span>
            </div>
            <span class="crt-ticket-total">{{ t.total != null ? fmtMoney(t.total) : '—' }}</span>
          </div>
          <div class="crt-empty" *ngIf="!loadingList() && tickets().length === 0">
            <i class="pi pi-receipt" aria-hidden="true"></i>
            <p>Aún no subiste tickets hoy.</p>
          </div>
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .crt { max-width: 720px; margin: 0 auto; }

      /* ── header ── */
      .crt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
      .crt-head-text h1 { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .crt-head-text p { margin: 0; color: var(--text-muted); font-size: 0.875rem; }
      .crt-daycount { display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; width: 3.25rem; height: 3.25rem; border-radius: 1rem; background: var(--card-bg); border: 1px solid var(--border-color); }
      .crt-daycount-n { font-size: 1.25rem; font-weight: 800; line-height: 1; color: var(--text-main); font-variant-numeric: tabular-nums; }
      .crt-daycount-l { font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); font-weight: 700; }

      /* ── paso 1: tiles ── */
      .crt-pick { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
      .crt-tile {
        display: flex; flex-direction: column; align-items: center; gap: 0.625rem;
        padding: 1.25rem 0.75rem; cursor: pointer;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 1rem;
        transition: transform 0.12s ease, box-shadow 0.18s ease, border-color 0.18s ease;
      }
      .crt-tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover, 0 8px 24px -12px rgba(0,0,0,.18)); border-color: var(--action); }
      .crt-tile:active { transform: translateY(0); }
      .crt-tile:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
      .crt-tile-icon { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: 0.875rem; font-size: 1.375rem; }
      .crt-tile-label { font-size: 0.875rem; font-weight: 700; color: var(--text-main); text-align: center; }
      .crt-tile-cta { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.6875rem; font-weight: 600; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; }
      .crt-tile[data-type='venta'] .crt-tile-icon { background: var(--ok-soft-bg); color: var(--ok-fg); }
      .crt-tile[data-type='carga'] .crt-tile-icon { background: var(--info-soft-bg); color: var(--info-fg); }
      .crt-tile[data-type='combustible'] .crt-tile-icon { background: var(--warn-soft-bg); color: var(--warn-fg); }

      /* ── procesando ── */
      .crt-processing {
        display: flex; align-items: center; gap: 0.625rem; justify-content: center;
        padding: 1.5rem; margin-bottom: 1.5rem; color: var(--text-muted);
        background: var(--card-bg); border: 1px dashed var(--border-color); border-radius: 1rem;
      }
      .crt-processing i { color: var(--action); }

      /* ── paso 2: review ── */
      .crt-review-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 1rem; }
      .crt-type-chip { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.7rem; border-radius: 999px; font-size: 0.8125rem; font-weight: 700; }
      .crt-type-chip[data-type='venta'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .crt-type-chip[data-type='carga'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
      .crt-type-chip[data-type='combustible'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .crt-change { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: none; cursor: pointer; font-size: 0.8125rem; font-weight: 600; color: var(--text-muted); padding: 0.3rem 0.5rem; border-radius: 0.5rem; transition: background 0.15s, color 0.15s; }
      .crt-change:hover { background: var(--hover-bg); color: var(--text-main); }

      .crt-preview { width: 100%; max-height: 260px; object-fit: contain; border: 1px solid var(--border-color); border-radius: 1rem; margin-bottom: 1.25rem; background: var(--surface-ground); }

      .crt-fields { display: flex; flex-direction: column; gap: 0.875rem; }
      .crt-field { display: flex; flex-direction: column; gap: 0.35rem; }
      .crt-field-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-faint); }
      .crt-input-wrap { position: relative; }
      .crt-field input {
        width: 100%; padding: 0.6875rem 0.875rem; font-size: 0.9375rem;
        border: 1px solid var(--border-color); border-radius: 0.75rem;
        background: var(--card-bg); color: var(--text-main);
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .crt-field input:focus { outline: none; border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring, rgba(240,90,40,.25)); }
      .crt-input-wrap input { padding-right: 5.5rem; }
      .crt-detect { position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%); font-size: 0.625rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.1rem 0.4rem; border-radius: 999px; background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
      .crt-detect.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }

      /* ── carga lines ── */
      .crt-lines { margin-top: 1.25rem; border: 1px solid var(--border-color); border-radius: 1rem; padding: 0.875rem 1rem; }
      .crt-lines-head { display: flex; justify-content: space-between; align-items: center; font-size: 0.8125rem; font-weight: 700; color: var(--text-main); margin-bottom: 0.5rem; }
      .crt-lines-count { font-weight: 600; font-size: 0.6875rem; color: var(--text-muted); background: var(--surface-ground); padding: 0.1rem 0.5rem; border-radius: 999px; }
      .crt-lines-empty { font-size: 0.8125rem; color: var(--text-muted); margin: 0.25rem 0; }
      .crt-line { display: flex; align-items: center; gap: 0.625rem; padding: 0.5rem 0; border-top: 1px solid var(--border-color); cursor: pointer; }
      .crt-line:first-of-type { border-top: none; }
      .crt-line input[type='checkbox'] { width: 1.05rem; height: 1.05rem; accent-color: var(--action); flex-shrink: 0; }
      .crt-line-name { flex: 1; font-size: 0.875rem; color: var(--text-main); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .crt-line.off .crt-line-name { color: var(--text-faint); text-decoration: line-through; }
      .crt-line-qty { width: 4.25rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 0.5rem; background: var(--card-bg); color: var(--text-main); font-variant-numeric: tabular-nums; }
      .crt-line-qty:disabled { opacity: 0.5; }

      /* ── warn + save ── */
      .crt-warn { display: flex; align-items: center; gap: 0.4rem; color: var(--bad-soft-fg); background: var(--bad-soft-bg); font-size: 0.8125rem; margin: 1.25rem 0 0; padding: 0.625rem 0.875rem; border-radius: 0.75rem; }
      .crt-save {
        display: flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%;
        margin-top: 1.25rem; padding: 0.875rem; cursor: pointer;
        background: var(--action); color: var(--action-ink, #fff); border: none; border-radius: 0.875rem;
        font-size: 0.9375rem; font-weight: 700; transition: background 0.15s, opacity 0.15s;
      }
      .crt-save:hover:not(:disabled) { background: var(--action-hover, var(--action)); }
      .crt-save:disabled { opacity: 0.5; cursor: not-allowed; }
      .crt-save:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }

      /* ── tickets de hoy ── */
      .crt-recent { margin-top: 2rem; }
      .crt-section { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); margin: 0 0 0.75rem; }
      .crt-list { display: flex; flex-direction: column; gap: 0.5rem; }
      .crt-ticket { display: flex; align-items: center; gap: 0.875rem; padding: 0.75rem 0.875rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.875rem; }
      .crt-ticket-icon { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: 0.625rem; font-size: 1rem; flex-shrink: 0; }
      .crt-ticket[data-type='venta'] .crt-ticket-icon { background: var(--ok-soft-bg); color: var(--ok-fg); }
      .crt-ticket[data-type='carga'] .crt-ticket-icon { background: var(--info-soft-bg); color: var(--info-fg); }
      .crt-ticket[data-type='combustible'] .crt-ticket-icon { background: var(--warn-soft-bg); color: var(--warn-fg); }
      .crt-ticket-info { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; flex: 1; }
      .crt-ticket-type { font-size: 0.875rem; font-weight: 700; color: var(--text-main); }
      .crt-ticket-meta { font-size: 0.75rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
      .crt-ticket-total { font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); flex-shrink: 0; }
      .crt-empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; text-align: center; color: var(--text-muted); padding: 2rem 1rem; background: var(--card-bg); border: 1px dashed var(--border-color); border-radius: 1rem; }
      .crt-empty i { font-size: 1.75rem; color: var(--text-faint); }
      .crt-empty p { margin: 0; font-size: 0.875rem; }

      @media (prefers-reduced-motion: reduce) {
        .crt-tile { transition: none; }
      }
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
  readonly cargaLines = signal<EditableCargaLine[]>([]); // productos detectados en carga

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
            // carga: precargar productos detectados (solo los matcheados).
            this.cargaLines.set(
              (res.lines ?? [])
                .filter((l) => !!l.product_id)
                .map((l) => ({
                  product_id: l.product_id as string,
                  product_name: l.product_name ?? l.normalized,
                  quantity: l.quantity || 1,
                  include: true,
                })),
            );
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

  includedCount(): number {
    return this.cargaLines().filter((l) => l.include).length;
  }

  save(): void {
    const type = this.selectedType();
    if (!type || !this.canSave()) return;
    this.saving.set(true);
    const lines =
      type === 'carga'
        ? this.cargaLines()
            .filter((l) => l.include && l.product_id && Number(l.quantity) > 0)
            .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }))
        : undefined;
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
        lines,
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
    this.cargaLines.set([]);
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
