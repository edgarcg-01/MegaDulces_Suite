import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, ExpiryReviewDetail, ExpiryReviewLine, ReviewFile, ExpiryLineInput } from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';

type Condition = 'bueno' | 'regular' | 'malo';

/**
 * P2.6 — captura de una hoja de Control de Caducidades (mobile-first).
 * Alta de renglones (producto + cantidad + caducidad + estado + observación +
 * acción + foto de evidencia) y envío. Al enviar, alimenta FEFO.
 */
@Component({
  selector: 'app-comercial-expiry-review-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, InputTextModule, InputNumberModule, DatePickerModule, ToastModule, ConfirmDialogModule, ProductSearchComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in erd">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="erd-head">
        <button pButton [text]="true" severity="secondary" size="small" (click)="back()" aria-label="Volver"><span class="p-button-icon pi pi-arrow-left" aria-hidden="true"></span></button>
        <div class="erd-head-text">
          <h1>Control de Caducidades</h1>
          @if (review(); as r) {
            <p class="erd-sub">{{ r.warehouse_code }} · {{ r.warehouse_name }} — {{ r.review_date }} · {{ r.responsible_name || 'sin responsable' }}</p>
          }
        </div>
        @if (review(); as r) {
          <p-tag [value]="r.status === 'submitted' ? 'Enviada' : 'Borrador'" [severity]="r.status === 'submitted' ? 'success' : 'warn'"></p-tag>
        }
      </header>

      <!-- Alta de renglón -->
      @if (editable()) {
        <section class="erd-form surf-card">
          <h2 class="erd-form-title">Agregar producto</h2>
          <div class="erd-grid">
            <label class="erd-field erd-col-2">
              <span class="erd-lbl">Producto</span>
              <app-product-search [brandIds]="promoterBrandIds()" (productSelected)="onProduct($event)"></app-product-search>
              @if (promoterBrands().length) {
                <small class="erd-scoped"><i class="pi pi-filter" aria-hidden="true"></i> Solo tus marcas: {{ promoterBrandNames() }}</small>
              }
            </label>
            <label class="erd-field">
              <span class="erd-lbl">Código (si no aparece)</span>
              <input pInputText [(ngModel)]="codeRaw" placeholder="Código de anaquel" class="erd-full" />
            </label>
            <label class="erd-field">
              <span class="erd-lbl">Cantidad</span>
              <p-inputnumber [(ngModel)]="qty" [min]="0" [showButtons]="true" buttonLayout="horizontal" styleClass="erd-full"
                incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"></p-inputnumber>
            </label>
            <label class="erd-field">
              <span class="erd-lbl">Fecha de caducidad</span>
              <p-datepicker [(ngModel)]="expiry" dateFormat="yy-mm-dd" [showButtonBar]="true" appendTo="body" styleClass="erd-full"></p-datepicker>
            </label>
            <label class="erd-field">
              <span class="erd-lbl">Ubicación</span>
              <input pInputText [(ngModel)]="location" placeholder="Anaquel / bodega / exhibidor" class="erd-full" />
            </label>
            <div class="erd-field">
              <span class="erd-lbl">Estado</span>
              <div class="erd-chips">
                @for (c of conditions; track c.value) {
                  <button type="button" class="erd-chip" [class.on]="condition() === c.value" [attr.data-c]="c.value" (click)="condition.set(c.value)">{{ c.label }}</button>
                }
              </div>
            </div>
            <label class="erd-field erd-col-2">
              <span class="erd-lbl">Observaciones</span>
              <input pInputText [(ngModel)]="observations" placeholder="Ej. la goma se ve dura / bolsas grasosas" class="erd-full" />
            </label>
            <label class="erd-field erd-col-2">
              <span class="erd-lbl">Acción / seguimiento</span>
              <input pInputText [(ngModel)]="action" placeholder="Ej. retirar / promocionar / firma" class="erd-full" />
            </label>
            <div class="erd-field">
              <span class="erd-lbl">Foto de evidencia</span>
              @if (pendingPhoto()) {
                <div class="erd-photo">
                  <img [src]="pendingPhoto()!.url" alt="evidencia" />
                  <button pButton [text]="true" severity="danger" size="small" (click)="pendingPhoto.set(null)"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button>
                </div>
              } @else {
                <label class="erd-pickbtn" [class.busy]="uploading()">
                  <i class="pi" [class.pi-camera]="!uploading()" [class.pi-spin]="uploading()" [class.pi-spinner]="uploading()" aria-hidden="true"></i>
                  {{ uploading() ? 'Subiendo…' : 'Tomar / elegir foto' }}
                  <input type="file" accept="image/*" capture="environment" (change)="onPhoto($event)" hidden [disabled]="uploading()" />
                </label>
              }
            </div>
          </div>
          <div class="erd-form-actions">
            <button pButton [disabled]="!canAddLine() || addingLine()" [loading]="addingLine()" (click)="addLine()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Agregar renglón</button>
          </div>
        </section>
      }

      <!-- Renglones capturados -->
      <section class="erd-lines">
        <div class="erd-lines-head">
          <h2>Renglones <span class="erd-count">{{ lines().length }}</span></h2>
        </div>
        @if (lines().length === 0) {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div><h3>Sin renglones aún</h3><p>Agregá productos por vencer arriba.</p></div>
        } @else {
          @for (l of lines(); track l.id) {
            <article class="erd-line surf-card">
              <div class="erd-line-main">
                <div class="erd-line-name">{{ l.product_name || l.product_name_raw || l.product_code_raw || 'Producto' }}</div>
                <div class="erd-line-meta">
                  <span class="erd-qty">{{ l.quantity }} pz</span>
                  @if (l.expiry_date) { <p-tag [value]="dayLabel(l.expiry_date)" [severity]="daySeverity(l.expiry_date)"></p-tag> }
                  @if (l.condition) { <span class="erd-cond" [attr.data-c]="l.condition">{{ l.condition }}</span> }
                  @if (l.location) { <span class="erd-loc"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ l.location }}</span> }
                  @if (l.fed_to_fefo) { <span class="erd-fefo" title="Alimentó FEFO">FEFO ✓</span> }
                </div>
                @if (l.observations) { <div class="erd-line-obs">{{ l.observations }}</div> }
                @if (l.action) { <div class="erd-line-act"><i class="pi pi-flag" aria-hidden="true"></i> {{ l.action }}</div> }
              </div>
              @if (l.files?.length) { <img class="erd-line-photo" [src]="l.files![0].url" alt="evidencia" /> }
              @if (editable()) {
                <button pButton [text]="true" severity="danger" size="small" (click)="removeLine(l)" aria-label="Borrar"><span class="p-button-icon pi pi-trash" aria-hidden="true"></span></button>
              }
            </article>
          }
        }
      </section>

      <!-- Barra de envío (sticky) -->
      @if (editable()) {
        <footer class="erd-submitbar">
          <button pButton severity="success" [disabled]="lines().length === 0 || submitting()" [loading]="submitting()" (click)="confirmSubmit()">
            <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span> Guardar y enviar
          </button>
        </footer>
      }
    </div>
    `,
  styles: [`
    .erd { padding-bottom: 5rem; }
    .erd-head { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; }
    .erd-head-text { flex: 1; min-width: 0; }
    .erd-head-text h1 { margin: 0; }
    .erd-sub { margin: .15rem 0 0; font-size: var(--fs-sm, .85rem); color: var(--c-text-2, var(--text-muted)); }
    .surf-card { background: var(--surface-card, var(--c-bg-1)); border: 1px solid var(--border-soft, var(--c-border)); border-radius: var(--radius-lg, 12px); padding: 1rem; }
    .erd-form { margin-bottom: 1.25rem; }
    .erd-form-title { margin: 0 0 .75rem; font-size: var(--fs-md, 1rem); }
    .erd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .85rem; }
    .erd-col-2 { grid-column: 1 / -1; }
    .erd-field { display: flex; flex-direction: column; gap: .35rem; min-width: 0; }
    .erd-lbl { font-size: var(--fs-xs, .72rem); text-transform: uppercase; letter-spacing: .03em; color: var(--c-text-2, var(--text-muted)); }
    .erd-full, :host ::ng-deep .erd-full, :host ::ng-deep .erd-full input { width: 100%; }
    .erd-chips { display: flex; gap: .4rem; }
    .erd-chip { flex: 1; padding: .55rem .5rem; border-radius: var(--radius-md, 8px); border: 1px solid var(--border-soft, var(--c-border)); background: transparent; color: var(--c-text-1); font-size: var(--fs-sm, .85rem); cursor: pointer; min-height: 44px; }
    .erd-chip.on[data-c="bueno"] { background: var(--good-soft-bg, #e6f4ea); border-color: var(--good-fg, #1a7f37); color: var(--good-fg, #1a7f37); }
    .erd-chip.on[data-c="regular"] { background: var(--warn-soft-bg, #fff4e5); border-color: var(--warn-fg, #b25e00); color: var(--warn-fg, #b25e00); }
    .erd-chip.on[data-c="malo"] { background: var(--bad-soft-bg, #fdeaea); border-color: var(--bad-fg, #b42318); color: var(--bad-fg, #b42318); }
    .erd-pickbtn { display: inline-flex; align-items: center; gap: .5rem; padding: .6rem .9rem; border: 1px dashed var(--border-soft, var(--c-border)); border-radius: var(--radius-md, 8px); cursor: pointer; color: var(--c-text-1); font-size: var(--fs-sm, .85rem); min-height: 44px; }
    .erd-pickbtn.busy { opacity: .6; cursor: default; }
    .erd-photo { position: relative; display: inline-block; }
    .erd-photo img { max-height: 80px; border-radius: var(--radius-md, 8px); display: block; }
    .erd-photo button { position: absolute; top: -8px; right: -8px; }
    .erd-form-actions { margin-top: 1rem; display: flex; justify-content: flex-end; }
    .erd-lines-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: .5rem; }
    .erd-lines-head h2 { margin: 0; font-size: var(--fs-md, 1rem); }
    .erd-count { display: inline-block; margin-left: .4rem; padding: .05rem .5rem; border-radius: 999px; background: var(--c-bg-2, var(--surface-100)); font-size: var(--fs-sm, .85rem); }
    .erd-line { display: flex; align-items: flex-start; gap: .75rem; margin-bottom: .6rem; padding: .75rem; }
    .erd-line-main { flex: 1; min-width: 0; }
    .erd-line-name { font-weight: 600; }
    .erd-line-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .3rem; }
    .erd-qty { font-family: var(--font-mono, monospace); font-size: var(--fs-sm, .85rem); }
    .erd-cond { font-size: var(--fs-xs, .72rem); text-transform: capitalize; padding: .05rem .45rem; border-radius: 999px; }
    .erd-cond[data-c="bueno"] { color: var(--good-fg, #1a7f37); }
    .erd-cond[data-c="regular"] { color: var(--warn-fg, #b25e00); }
    .erd-cond[data-c="malo"] { color: var(--bad-fg, #b42318); }
    .erd-scoped { display: inline-flex; align-items: center; gap: .35rem; margin-top: .3rem; font-size: var(--fs-xs, .72rem); color: var(--action, var(--c-accent, #b25e00)); }
    .erd-loc { font-size: var(--fs-xs, .72rem); color: var(--c-text-2, var(--text-muted)); }
    .erd-fefo { font-size: var(--fs-xs, .72rem); color: var(--good-fg, #1a7f37); }
    .erd-line-obs { margin-top: .35rem; font-size: var(--fs-sm, .85rem); color: var(--c-text-2, var(--text-muted)); }
    .erd-line-act { margin-top: .25rem; font-size: var(--fs-sm, .85rem); }
    .erd-line-photo { width: 56px; height: 56px; object-fit: cover; border-radius: var(--radius-md, 8px); }
    .erd-submitbar { position: sticky; bottom: 0; margin-top: 1rem; padding: .75rem 0; display: flex; justify-content: flex-end; background: linear-gradient(to top, var(--c-bg-0, var(--surface-ground)) 60%, transparent); }
    @media (max-width: 640px) {
      .erd-grid { grid-template-columns: 1fr; }
      .erd-submitbar button { width: 100%; }
    }
  `],
})
export class ComercialExpiryReviewDetailComponent {
  readonly conditions: { label: string; value: Condition }[] = [
    { label: 'Bueno', value: 'bueno' },
    { label: 'Regular', value: 'regular' },
    { label: 'Malo', value: 'malo' },
  ];

  private readonly svc = inject(ComercialService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly reviewId = this.route.snapshot.paramMap.get('id')!;

  review = signal<ExpiryReviewDetail | null>(null);
  lines = signal<ExpiryReviewLine[]>([]);

  // Promotor de marca propia: si tiene marcas asignadas, el buscador solo muestra sus SKUs.
  promoterBrands = signal<{ id: string; nombre: string }[]>([]);
  promoterBrandIds = computed(() => this.promoterBrands().map((b) => b.id));
  promoterBrandNames = computed(() => this.promoterBrands().map((b) => b.nombre).join(', '));

  // form state
  productId = signal<string | null>(null);
  nameRaw = signal<string>('');
  codeRaw = '';
  qty: number | null = null;
  expiry: Date | null = null;
  condition = signal<Condition | null>(null);
  observations = '';
  action = '';
  location = '';
  pendingPhoto = signal<ReviewFile | null>(null);

  uploading = signal(false);
  addingLine = signal(false);
  submitting = signal(false);

  private readonly canCapture =
    this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_EXPIRY_CAPTURAR];

  editable = computed(() => this.canCapture && this.review()?.status === 'draft');
  canAddLine = () => (!!this.productId() || !!this.codeRaw.trim()) && this.qty != null && this.qty >= 0;

  constructor() {
    this.load();
    this.svc.myBrands()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.promoterBrands.set(r?.brands || []), error: () => {} });
  }

  load() {
    this.svc.getExpiryReview(this.reviewId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.review.set(r); this.lines.set(r.lines || []); if (!this.location) this.location = r.default_location || ''; },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo cargar la hoja' }),
      });
  }

  onProduct(p: ProductHit | null) {
    this.productId.set(p?.id || null);
    this.nameRaw.set(p?.label || '');
    if (p?.sku) this.codeRaw = p.sku;
  }

  onPhoto(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { this.toast.add({ severity: 'warn', summary: 'La foto supera 10 MB' }); return; }
    const reader = new FileReader();
    reader.onload = () => {
      this.uploading.set(true);
      this.svc.uploadExpiryFile(reader.result as string, 'evidencia')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (f) => { this.pendingPhoto.set(f); this.uploading.set(false); },
          error: () => { this.uploading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo subir la foto' }); },
        });
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  private toYmd(d: Date | null): string | null {
    if (!d) return null;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  addLine() {
    if (!this.canAddLine()) return;
    const body: ExpiryLineInput = {
      product_id: this.productId(),
      product_code_raw: this.codeRaw.trim() || undefined,
      product_name_raw: this.nameRaw() || undefined,
      quantity: this.qty ?? 0,
      expiry_date: this.toYmd(this.expiry),
      condition: this.condition() || undefined,
      observations: this.observations.trim() || undefined,
      action: this.action.trim() || undefined,
      location: this.location.trim() || undefined,
      files: this.pendingPhoto() ? [this.pendingPhoto()!] : undefined,
    };
    this.addingLine.set(true);
    this.svc.addExpiryLine(this.reviewId, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (line) => { this.lines.update((ls) => [...ls, line]); this.resetForm(); this.addingLine.set(false); },
        error: () => { this.addingLine.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo agregar el renglón' }); },
      });
  }

  private resetForm() {
    this.productId.set(null); this.nameRaw.set(''); this.codeRaw = '';
    this.qty = null; this.expiry = null; this.condition.set(null);
    this.observations = ''; this.action = ''; this.pendingPhoto.set(null);
  }

  removeLine(l: ExpiryReviewLine) {
    this.confirm.confirm({
      message: `¿Borrar el renglón "${l.product_name || l.product_name_raw || l.product_code_raw || ''}"?`,
      header: 'Borrar renglón', icon: 'pi pi-trash', acceptLabel: 'Borrar', rejectLabel: 'Cancelar',
      accept: () => {
        this.svc.deleteExpiryLine(l.id)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => this.lines.update((ls) => ls.filter((x) => x.id !== l.id)),
            error: () => this.toast.add({ severity: 'error', summary: 'No se pudo borrar' }),
          });
      },
    });
  }

  confirmSubmit() {
    this.confirm.confirm({
      message: 'Al enviar, los productos con caducidad alimentarán el inventario FEFO y la hoja quedará bloqueada. ¿Continuar?',
      header: 'Enviar hoja', icon: 'pi pi-send', acceptLabel: 'Enviar', rejectLabel: 'Cancelar',
      accept: () => this.doSubmit(),
    });
  }

  private doSubmit() {
    this.submitting.set(true);
    this.svc.submitExpiryReview(this.reviewId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          this.toast.add({ severity: 'success', summary: 'Hoja enviada', detail: `${res.fed_lines}/${res.total_lines} renglones alimentaron FEFO` });
          this.load();
        },
        error: (e) => { this.submitting.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo enviar', detail: e?.error?.message }); },
      });
  }

  back() { this.router.navigate(['..'], { relativeTo: this.route }); }

  private daysTo(expiry: string): number {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(expiry + 'T00:00:00');
    return Math.round((d.getTime() - today.getTime()) / 86400000);
  }
  dayLabel(expiry: string): string {
    const d = this.daysTo(expiry);
    if (d < 0) return `Vencido ${Math.abs(d)}d`;
    if (d === 0) return 'Vence hoy';
    return `${d} d`;
  }
  daySeverity(expiry: string): 'danger' | 'warn' | 'secondary' {
    const d = this.daysTo(expiry);
    if (d <= 7) return 'danger';
    if (d <= 15) return 'warn';
    return 'secondary';
  }
}
