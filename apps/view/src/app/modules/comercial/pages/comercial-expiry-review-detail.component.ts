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
type LineUnit = 'caja' | 'pieza' | 'bulto' | 'kg';
type PlazoLevel = 'bueno' | 'intermedio' | 'riesgoso' | 'vencido';

/**
 * Umbrales del PLAZO (días entre hoy y la caducidad). **Esta es la perilla**:
 * si el negocio decide otra ventana, se cambia acá y cambia en toda la pantalla.
 *
 * `RIESGOSO_DIAS = 30` no es arbitrario: es el mismo umbral con el que el sistema
 * ya alerta lotes por vencer (`ALERT_THRESHOLDS.EXPIRING_LOTS_DAYS`), así que la
 * hoja y las alertas dicen lo mismo. 90 días (un trimestre) es el plazo cómodo
 * para rotar en tienda; entre 31 y 90 hay que traerlo vigilado.
 */
const PLAZO_RIESGOSO_DIAS = 30;
const PLAZO_INTERMEDIO_DIAS = 90;

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
            <p class="erd-sub">{{ r.warehouse_code }} · {{ r.warehouse_name }} — {{ fmtDate(r.review_date) }} · {{ r.responsible_name || 'sin responsable' }}</p>
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
              <input pInputText [(ngModel)]="codeRaw" (ngModelChange)="onCodeChange()" placeholder="Código de anaquel" class="erd-full" />
            </label>
            <div class="erd-field">
              <span class="erd-lbl">Cantidad</span>
              <div class="erd-qtyrow">
                <p-inputnumber [(ngModel)]="qty" [min]="0" [showButtons]="true" buttonLayout="horizontal" styleClass="erd-full"
                  incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"></p-inputnumber>
                <div class="erd-units" role="radiogroup" aria-label="Unidad de medida">
                  @for (u of units; track u.value) {
                    <button type="button" class="erd-unit" role="radio" [attr.aria-checked]="unit() === u.value"
                      [class.on]="unit() === u.value" (click)="pickUnit(u.value)" [title]="u.hint">{{ u.label }}</button>
                  }
                </div>
              </div>
              @if (unitSuggested()) {
                <small class="erd-hint"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ unitSuggested() }}</small>
              }
            </div>
            <label class="erd-field">
              <span class="erd-lbl">Fecha de caducidad</span>
              <p-datepicker [(ngModel)]="expiry" dateFormat="yy-mm-dd" [showButtonBar]="true" appendTo="body" styleClass="erd-full"></p-datepicker>
              @if (plazo(); as pz) {
                <div class="erd-plazo" [attr.data-p]="pz.level">
                  <i class="pi" [class.pi-check-circle]="pz.level === 'bueno'" [class.pi-eye]="pz.level === 'intermedio'"
                     [class.pi-exclamation-triangle]="pz.level === 'riesgoso'" [class.pi-times-circle]="pz.level === 'vencido'" aria-hidden="true"></i>
                  <strong>{{ pz.title }}</strong>
                  <span>{{ pz.detail }}</span>
                </div>
              }
            </label>
            <label class="erd-field">
              <span class="erd-lbl">Ubicación</span>
              <input pInputText [(ngModel)]="location" placeholder="Anaquel / bodega / exhibidor" class="erd-full" />
            </label>
            <div class="erd-field">
              <span class="erd-lbl">Estado físico <em class="erd-lbl-em">(cómo llegó, no la fecha)</em></span>
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
                  <img [src]="pendingPhoto()!.preview_url || pendingPhoto()!.url" alt="Evidencia por adjuntar" (error)="onPhotoError($event)" />
                  @if (previewBroken()) {
                    <span class="erd-photo-noprev"><i class="pi pi-check-circle" aria-hidden="true"></i> Foto adjunta (sin vista previa)</span>
                  }
                  <button pButton [text]="true" severity="danger" size="small" (click)="clearPhoto()" pTooltip="Quitar la foto"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button>
                </div>
              } @else {
                @if (photoFailed()) {
                  <div class="erd-photo-failed" role="alert">
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    La foto no se subió. Si guardás así, el renglón queda <strong>sin evidencia</strong>.
                  </div>
                }
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
                  <span class="erd-qty">{{ l.quantity | number }} {{ unitLabel(l.unit) }}</span>
                  @if (l.expiry_date) {
                    <span class="erd-exp">Vence {{ fmtDate(l.expiry_date) }}</span>
                    <p-tag [value]="dayLabel(l.expiry_date)" [severity]="daySeverity(l.expiry_date)"></p-tag>
                    <span class="erd-plazo-chip" [attr.data-p]="plazoOf(l.expiry_date)?.level">{{ plazoOf(l.expiry_date)?.title }}</span>
                  }
                  @if (l.condition) { <span class="erd-cond" [attr.data-c]="l.condition">{{ l.condition }}</span> }
                  @if (l.location) { <span class="erd-loc"><i class="pi pi-map-marker" aria-hidden="true"></i> {{ l.location }}</span> }
                  @if (l.fed_to_fefo) { <span class="erd-fefo" title="Alimentó FEFO">FEFO ✓</span> }
                </div>
                @if (l.observations) { <div class="erd-line-obs">{{ l.observations }}</div> }
                @if (l.action) { <div class="erd-line-act"><i class="pi pi-flag" aria-hidden="true"></i> {{ l.action }}</div> }
              </div>
              @if (linePhoto(l); as photo) {
                <img class="erd-line-photo" [src]="photo" alt="Evidencia del renglón" (error)="onPhotoError($event)" />
              } @else if (l.files?.length) {
                <!-- Hay evidencia guardada pero el storage no devolvió URL firmada
                     (signedUrl() cae a '' si falla): mostrar el hecho, no un <img> roto. -->
                <span class="erd-photo-missing" title="La evidencia existe pero no se pudo cargar">
                  <i class="pi pi-image" aria-hidden="true"></i> sin vista previa
                </span>
              }
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
    .erd-lbl-em { font-style: normal; font-weight: 400; color: var(--text-color-secondary); font-size: .72rem; }
    .erd-hint { display: flex; align-items: center; gap: .3rem; font-size: .72rem; color: var(--text-color-secondary); margin-top: .25rem; }
    .erd-qtyrow { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .erd-qtyrow > *:first-child { flex: 1 1 130px; }
    .erd-units { display: inline-flex; border: 1px solid var(--surface-border); border-radius: 8px; overflow: hidden; }
    .erd-unit { appearance: none; background: transparent; border: 0; border-right: 1px solid var(--surface-border);
      padding: .4rem .6rem; font-size: .78rem; font-weight: 600; cursor: pointer; color: var(--text-color-secondary); }
    .erd-unit:last-child { border-right: 0; }
    .erd-unit.on { background: var(--overlay-selected, rgba(0,0,0,.06)); color: var(--text-color); }
    .erd-unit:focus-visible { outline: 2px solid var(--action, #c2410c); outline-offset: -2px; }
    /* Plazo — el veredicto que da el sistema desde la fecha */
    .erd-plazo { display: flex; align-items: center; gap: .4rem; margin-top: .35rem; font-size: .78rem; }
    .erd-plazo strong { font-weight: 700; }
    .erd-plazo span { color: var(--text-color-secondary); }
    .erd-plazo[data-p="bueno"] { color: var(--ok-fg, #15803d); }
    .erd-plazo[data-p="intermedio"] { color: var(--warn-fg, #b45309); }
    .erd-plazo[data-p="riesgoso"], .erd-plazo[data-p="vencido"] { color: var(--bad-fg, #b91c1c); }
    .erd-plazo-chip { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .erd-plazo-chip[data-p="bueno"] { color: var(--ok-fg, #15803d); }
    .erd-plazo-chip[data-p="intermedio"] { color: var(--warn-fg, #b45309); }
    .erd-plazo-chip[data-p="riesgoso"], .erd-plazo-chip[data-p="vencido"] { color: var(--bad-fg, #b91c1c); }
    .erd-photo-failed { display: flex; align-items: center; gap: .4rem; font-size: .76rem; margin-bottom: .4rem;
      padding: .4rem .55rem; border-radius: 8px; color: var(--bad-fg, #b91c1c);
      border: 1px solid var(--bad-border, #fecaca); background: var(--bad-soft-bg, #fef2f2); }
    @media (pointer: coarse) { .erd-unit { min-height: 44px; padding-inline: .8rem; } }
    .erd-exp { font-size: .78rem; color: var(--text-color-secondary); font-variant-numeric: tabular-nums; }
    .erd-photo-noprev { display: inline-flex; align-items: center; gap: .3rem; font-size: .74rem; color: var(--ok-fg, #15803d); }
    .erd-photo-missing { display: inline-flex; align-items: center; gap: .3rem; font-size: .72rem;
      color: var(--text-color-secondary); white-space: nowrap; }
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
  /** Unidades reales de recepción (no todo llega en piezas). */
  readonly units: { label: string; value: LineUnit; hint: string }[] = [
    { label: 'Caja', value: 'caja', hint: 'Caja cerrada — lo común con código de anaquel' },
    { label: 'Pieza', value: 'pieza', hint: 'Suelto: piñatas, producto individual' },
    { label: 'Bulto', value: 'bulto', hint: 'Bolsa grande / costal' },
    { label: 'Kg', value: 'kg', hint: 'Granel, por peso' },
  ];

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
  unit = signal<LineUnit>('caja');
  /** True mientras el operador no toque el selector: permite auto-sugerir. */
  private unitTouched = false;
  observations = '';
  action = '';
  location = '';
  pendingPhoto = signal<ReviewFile | null>(null);
  /** Hubo un intento de foto que falló: el renglón se guardaría SIN evidencia. */
  readonly photoFailed = signal(false);
  /** La foto está adjunta pero su vista previa no cargó (firma vencida/no firmada). */
  readonly previewBroken = signal(false);

  uploading = signal(false);
  addingLine = signal(false);
  submitting = signal(false);

  private readonly canCapture =
    this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_EXPIRY_CAPTURAR];

  editable = computed(() => this.canCapture && this.review()?.status === 'draft');
  canAddLine = () => (!!this.productId() || !!this.codeRaw.trim()) && this.qty != null && this.qty >= 0;

  constructor() {
    this.load();
    this.svc.myBrands()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.promoterBrands.set(r?.brands || []),
        // No se cambia el flujo (sin marcas = no es promotor), pero no se traga en
        // silencio: un 403 acá se veía igual que "no tiene marcas" (GOTCHAS §4).
        error: (e) => console.warn('[caducidades] no se pudieron leer las marcas del promotor:', e?.status || e),
      });
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
    this.suggestUnit();
  }

  /** El código de anaquel manda sobre la sugerencia: al teclearlo se re-evalúa. */
  onCodeChange(): void { this.suggestUnit(); }
  /** A partir del primer toque manual, el sistema deja de sugerir. */
  pickUnit(u: LineUnit): void { this.unitTouched = true; this.unit.set(u); }

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
          next: (f) => { this.pendingPhoto.set(f); this.photoFailed.set(false); this.uploading.set(false); },
          error: (e) => {
            this.uploading.set(false);
            this.photoFailed.set(true);
            // El backend explica el motivo real (p.ej. "Almacenamiento no configurado
            // (faltan env S3_*)"). Tragarlo en un genérico dejaba al operador
            // intentando de nuevo contra algo que nunca iba a funcionar.
            this.toast.add({
              severity: 'error', life: 8000,
              summary: 'No se pudo subir la foto',
              detail: e?.error?.message || 'Revisá la conexión e intentá de nuevo.',
            });
          },
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
      unit: this.unit(),
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

  /** Quita la foto adjunta del formulario (no borra nada del storage). */
  clearPhoto(): void { this.pendingPhoto.set(null); this.previewBroken.set(false); }

  private resetForm() {
    this.productId.set(null); this.nameRaw.set(''); this.codeRaw = '';
    this.qty = null; this.expiry = null; this.condition.set(null);
    this.observations = ''; this.action = ''; this.pendingPhoto.set(null);
    this.photoFailed.set(false); this.previewBroken.set(false);
    this.unitTouched = false; this.unit.set('caja');
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

  // ── Plazo: el sistema lo dice solo, desde la fecha ────────────────────────

  /**
   * Clasifica la caducidad contra HOY. Es lo que el operador pidió: que el sistema
   * diga si es buen plazo, hay que vigilarlo, o es riesgoso para la tienda —
   * sin que nadie lo tenga que juzgar a ojo.
   */
  private classify(days: number | null): { level: PlazoLevel; title: string; detail: string } | null {
    if (days === null) return null;
    if (days < 0) return { level: 'vencido', title: 'Vencido', detail: `hace ${Math.abs(days)} d — retirar` };
    if (days <= PLAZO_RIESGOSO_DIAS)
      return { level: 'riesgoso', title: 'Riesgoso', detail: `vence en ${days} d — sacarlo ya` };
    if (days <= PLAZO_INTERMEDIO_DIAS)
      return { level: 'intermedio', title: 'Intermedio', detail: `${days} d — vigilar` };
    return { level: 'bueno', title: 'Buen plazo', detail: `${days} d` };
  }

  /** Plazo de la fecha que se está capturando en el formulario. */
  plazo(): { level: PlazoLevel; title: string; detail: string } | null {
    return this.classify(this.daysFromDate(this.expiry));
  }
  /** Plazo de un renglón ya guardado. */
  plazoOf(expiry: string | null | undefined): { level: PlazoLevel; title: string; detail: string } | null {
    return this.classify(this.daysTo(String(expiry || '')));
  }
  private daysFromDate(d: Date | null): number | null {
    if (!d) return null;
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    const today = new Date(); today.setHours(12, 0, 0, 0);
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  // ── Unidad de medida ──────────────────────────────────────────────────────

  unitLabel(u: string | null | undefined): string {
    switch (u) {
      case 'caja': return 'cajas';
      case 'bulto': return 'bultos';
      case 'kg': return 'kg';
      case 'pieza': return 'pz';
      default: return 'pz'; // renglones anteriores a la columna
    }
  }

  /**
   * Sugerencia (no imposición): un código de anaquel puramente numérico casi
   * siempre viene de caja; un producto resuelto por código de barras se cuenta
   * suelto. Solo aplica mientras el operador no haya elegido unidad a mano.
   */
  private suggestUnit(): void {
    if (this.unitTouched) return;
    const code = (this.codeRaw || '').trim();
    if (code && /^\d+$/.test(code)) this.unit.set('caja');
    else if (this.productId()) this.unit.set('pieza');
  }
  unitSuggested(): string | null {
    if (this.unitTouched) return null;
    const code = (this.codeRaw || '').trim();
    if (code && /^\d+$/.test(code)) return 'Código de anaquel numérico: se asume caja. Cambialo si llegó suelto.';
    if (this.productId()) return 'Producto escaneado: se asume pieza.';
    return null;
  }

  /** URL utilizable de la evidencia, o null si el storage no la firmó. */
  linePhoto(l: { files?: { url?: string }[] | null }): string | null {
    const url = l.files?.[0]?.url;
    return url && /^(https?:|data:|blob:)/.test(url) ? url : null;
  }
  /** Si la imagen no carga (URL firmada vencida), se oculta en vez de dejar el ícono roto. */
  onPhotoError(ev: Event): void {
    const el = ev.target as HTMLImageElement | null;
    if (el) el.style.display = 'none';
    // Ocultar la imagen dejaba la caja vacía con la × suelta: parecía que la foto
    // se había perdido. La evidencia SÍ está adjunta; lo que falla es la vista previa.
    this.previewBroken.set(true);
  }

  /**
   * Días a la caducidad.
   *
   * `expiry_date` es un `date` de Postgres y la API lo serializa como ISO COMPLETO
   * (`2027-03-15T06:00:00.000Z`), no como `YYYY-MM-DD`. Concatenarle `'T00:00:00'`
   * producía `...ZT00:00:00` → **Invalid Date → NaN** → el tag salía "NaN d" y el
   * semáforo caía siempre a 'secondary'. Se toma el tramo de fecha TAL CUAL (sin
   * re-convertir a la TZ del navegador: ya viene normalizada del backend, DESIGN §10)
   * y se compara a mediodía para que el horario de verano no corra un día.
   */
  private daysTo(expiry: string): number | null {
    const ymd = String(expiry || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
    const [y, m, d] = ymd.split('-').map(Number);
    const target = new Date(y, m - 1, d, 12, 0, 0, 0);
    const today = new Date(); today.setHours(12, 0, 0, 0);
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }
  dayLabel(expiry: string): string {
    const d = this.daysTo(expiry);
    if (d === null) return 'Sin fecha';
    if (d < 0) return `Vencido ${Math.abs(d)} d`;
    if (d === 0) return 'Vence hoy';
    return `${d} d`;
  }
  daySeverity(expiry: string): 'danger' | 'warn' | 'secondary' {
    const d = this.daysTo(expiry);
    if (d === null) return 'secondary';
    if (d <= 7) return 'danger';
    if (d <= 15) return 'warn';
    return 'secondary';
  }
  /** Fecha legible (DD/MM/AAAA) del mismo tramo YYYY-MM-DD, sin new Date() sobre el ISO. */
  fmtDate(v: string | null | undefined): string {
    const ymd = String(v || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '—';
    const parts = ymd.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }
}
