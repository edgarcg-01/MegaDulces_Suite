import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService, ConfirmationService } from 'primeng/api';
import { environment } from '../../../../environments/environment';

interface Directive {
  id: string;
  directive_type: string;
  target_kind: string;
  target_name: string;
  boost: number;
  reason: string;
  sponsor: string | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
}
interface BrandOpt { id: string; nombre: string; products: number; }

/**
 * Thot T.2 — Empuje dirigido. El negocio define QUÉ empujar (marca foco) y Thot
 * lo amplifica en el take-order. Gateado por COMMERCIAL_PROMOTIONS_GESTIONAR.
 * Surface Operations: page-head + tabla densa (p-table) como organismo primario +
 * alta vía p-dialog con controles PrimeNG (p-select/p-autoComplete/p-inputNumber/p-datePicker).
 */
@Component({
  selector: 'app-comercial-thot-directives',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, InputNumberModule,
    AutoCompleteModule, DatePickerModule, DialogModule, ToastModule, ConfirmDialogModule,
    TooltipModule, SkeletonModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page td">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Empuje dirigido <span class="td-thot">· Thot</span></h1>
          <p class="surf-page-sub">
            Definí qué empujar (marca del mes, lanzamiento, liquidación). El motor lo sube en
            "Para impulsar" del vendedor.
          </p>
        </div>
        <div class="td-head-actions">
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small"
                  (click)="reload()" [loading]="loading()" pTooltip="Refrescar"></button>
          <button pButton icon="pi pi-plus" label="Nueva directriz" size="small" severity="contrast"
                  (click)="openCreate()"></button>
        </div>
      </header>

      <!-- TABLA flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table [value]="directives()" [loading]="loading()" responsiveLayout="scroll"
                   styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first">
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Razón</th>
                <th scope="col" class="comm-num">Boost</th>
                <th scope="col">Patrocinador</th>
                <th scope="col">Vigencia</th>
                <th scope="col">Estado</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-d>
              <tr [class.td-off]="!d.active">
                <td>
                  <span class="comm-cell-strong">{{ d.target_name || '—' }}</span>
                  <div class="comm-muted is-small">
                    <p-tag [value]="kindLabel(d.target_kind)" severity="secondary" styleClass="td-kind"></p-tag>
                  </div>
                </td>
                <td>{{ d.reason }}</td>
                <td class="comm-num is-strong">{{ d.boost }}</td>
                <td>{{ d.sponsor || '—' }}</td>
                <td><span class="td-dates">{{ d.valid_from || '∞' }} → {{ d.valid_to || '∞' }}</span></td>
                <td>
                  <span class="comm-pill no-dot" [class.is-active]="d.active" [class.is-inactive]="!d.active">
                    {{ d.active ? 'Activa' : 'Pausada' }}
                  </span>
                </td>
                <td class="comm-actions">
                  <button pButton [icon]="d.active ? 'pi pi-pause' : 'pi pi-play'" size="small" [text]="true"
                          severity="secondary" (click)="toggle(d)"
                          [pTooltip]="d.active ? 'Pausar' : 'Activar'"></button>
                  <button pButton icon="pi pi-trash" size="small" [text]="true" severity="secondary"
                          class="icon-btn-ghost-bad" (click)="confirmRemove(d)" pTooltip="Eliminar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="7" class="comm-empty-cell">
                  <div class="comm-empty">
                    <div class="comm-empty-icon"><i class="pi pi-megaphone" aria-hidden="true"></i></div>
                    <h3>Sin directrices</h3>
                    <p>Creá una directriz para empezar a empujar una marca foco en la app del vendedor.</p>
                    <button pButton icon="pi pi-plus" severity="contrast" size="small" label="Nueva directriz"
                            (click)="openCreate()"></button>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>

    <!-- DIALOG: alta de directriz -->
    <p-dialog [(visible)]="dialogVisible" [modal]="true" [draggable]="false" [style]="{ width: '480px' }"
              header="Nueva directriz" (onHide)="resetForm()">
      <div class="td-form">
        <label class="td-field">
          <span>Tipo</span>
          <p-select [options]="typeOptions" [(ngModel)]="dType" optionLabel="label" optionValue="value"
                    appendTo="body" styleClass="td-w-full"></p-select>
        </label>

        <label class="td-field">
          <span>Marca <em>*</em></span>
          <p-autoComplete [(ngModel)]="brandModel" [suggestions]="brandSuggestions()"
                          (completeMethod)="searchBrands($event)" (onSelect)="onBrandSelect($event)"
                          (onClear)="selectedBrand.set(null)" field="nombre" [delay]="250"
                          [forceSelection]="true" placeholder="Buscar marca…" appendTo="body"
                          styleClass="td-w-full">
            <ng-template let-b pTemplate="item">
              <div class="td-ac-item"><span>{{ b.nombre }}</span><small>{{ b.products }} prod.</small></div>
            </ng-template>
          </p-autoComplete>
        </label>

        <label class="td-field">
          <span>Razón <em>*</em> <small>(la ve el vendedor)</small></span>
          <input pInputText [(ngModel)]="reason" maxlength="80" placeholder="Marca del mes" />
        </label>

        <div class="td-row">
          <label class="td-field">
            <span>Empuje (boost)</span>
            <p-inputNumber [(ngModel)]="boost" [min]="0" [max]="5" [step]="0.25" [minFractionDigits]="2"
                           [showButtons]="true" styleClass="td-w-full"></p-inputNumber>
            <small class="td-hint">0.5 moderado · 1 fuerte · 2 dominante</small>
          </label>
          <label class="td-field">
            <span>Patrocinador <small>(opcional)</small></span>
            <input pInputText [(ngModel)]="sponsor" maxlength="80" placeholder="Quién lo financia" />
          </label>
        </div>

        <div class="td-row">
          <label class="td-field">
            <span>Vigencia desde</span>
            <p-datePicker [(ngModel)]="validFrom" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                          styleClass="td-w-full" placeholder="∞"></p-datePicker>
          </label>
          <label class="td-field">
            <span>Vigencia hasta</span>
            <p-datePicker [(ngModel)]="validTo" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"
                          styleClass="td-w-full" placeholder="∞"></p-datePicker>
          </label>
        </div>
      </div>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="dialogVisible = false"></button>
        <button pButton label="Crear directriz" icon="pi pi-check" [loading]="creating()"
                [disabled]="!canCreate()" (click)="create()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .td-head-actions { display:flex; gap:var(--sp-2); align-items:center; }
    .td-thot { color:var(--action); font-weight:var(--fw-bold); }
    .surf-page-sub { max-width:62ch; }

    .td-off { opacity:.55; }
    .td-dates { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); }
    :host ::ng-deep .td-kind { font-size:var(--fs-micro); }

    /* Dialog form */
    .td-form { display:flex; flex-direction:column; gap:var(--sp-3); }
    .td-row { display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-3); }
    .td-field { display:flex; flex-direction:column; gap:var(--sp-1); font-size:var(--fs-micro); font-weight:var(--fw-bold);
                text-transform:uppercase; letter-spacing:.06em; color:var(--c-text-2); }
    .td-field > span em { color:var(--bad-fg); font-style:normal; }
    .td-field > span small { font-weight:var(--fw-medium); text-transform:none; letter-spacing:0; color:var(--c-text-3); }
    .td-hint { font-weight:var(--fw-medium); text-transform:none; letter-spacing:0; color:var(--c-text-3); }
    :host ::ng-deep .td-w-full, :host ::ng-deep .td-w-full input { width:100%; }
    .td-ac-item { display:flex; justify-content:space-between; align-items:center; gap:var(--sp-2); }
    .td-ac-item small { color:var(--c-text-3); }
    @media (max-width:640px) { .td-row { grid-template-columns:1fr; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialThotDirectivesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly base = environment.apiUrl + '/commercial/intelligence/directives';

  readonly directives = signal<Directive[]>([]);
  readonly brandSuggestions = signal<BrandOpt[]>([]);
  readonly selectedBrand = signal<BrandOpt | null>(null);
  readonly loading = signal(true);
  readonly creating = signal(false);

  dialogVisible = false;
  dType = 'focus_brand';
  readonly typeOptions = [{ label: 'Marca foco', value: 'focus_brand' }];
  brandModel: BrandOpt | string | null = null;
  reason = 'Marca del mes';
  boost = 1;
  sponsor = '';
  validFrom: Date | null = null;
  validTo: Date | null = null;

  readonly canCreate = computed(() => !!this.selectedBrand());

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.http.get<Directive[]>(this.base).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.directives.set(d || []); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las directrices' }); },
    });
  }

  searchBrands(e: { query: string }): void {
    this.http.get<BrandOpt[]>(`${this.base}/brands`, { params: new HttpParams().set('search', e.query || '') })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (b) => this.brandSuggestions.set(b || []), error: () => this.brandSuggestions.set([]) });
  }

  onBrandSelect(e: { value: BrandOpt }): void {
    this.selectedBrand.set(e?.value ?? null);
  }

  kindLabel(k: string): string {
    return k === 'brand' ? 'Marca' : k === 'product' ? 'Producto' : 'Categoría';
  }

  openCreate(): void {
    this.resetForm();
    this.dialogVisible = true;
  }

  resetForm(): void {
    this.selectedBrand.set(null);
    this.brandModel = null;
    this.dType = 'focus_brand';
    this.reason = 'Marca del mes';
    this.boost = 1;
    this.sponsor = '';
    this.validFrom = null;
    this.validTo = null;
  }

  create(): void {
    const b = this.selectedBrand();
    if (!b || !this.reason.trim()) return;
    this.creating.set(true);
    this.http.post(this.base, {
      directive_type: this.dType,
      target_id: b.id,
      reason: this.reason.trim(),
      boost: Number(this.boost),
      sponsor: this.sponsor.trim() || undefined,
      valid_from: this.toIso(this.validFrom),
      valid_to: this.toIso(this.validTo),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.creating.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: 'Directriz creada', detail: b.nombre });
        this.reload();
      },
      error: (e) => {
        this.creating.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo crear', detail: e?.error?.message || 'Error desconocido' });
      },
    });
  }

  toggle(d: Directive): void {
    this.http.patch(`${this.base}/${d.id}`, { active: !d.active }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: d.active ? 'Directriz pausada' : 'Directriz activada', life: 2000 }); this.reload(); },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cambiar el estado' }),
    });
  }

  confirmRemove(d: Directive): void {
    this.confirm.confirm({
      header: 'Eliminar directriz',
      message: `¿Eliminar la directriz "${d.reason}" (${d.target_name})? El motor dejará de empujar esta marca.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.http.delete(`${this.base}/${d.id}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => { this.toast.add({ severity: 'success', summary: 'Directriz eliminada' }); this.reload(); },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' }),
        });
      },
    });
  }

  private toIso(d: Date | null): string | undefined {
    if (!d) return undefined;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
