import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CheckboxModule } from 'primeng/checkbox';
import { DividerModule } from 'primeng/divider';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import {
  ConfigItem,
  DeliveryGuide,
  Driver,
  LogisticaService,
  Shipment,
  ShipmentType,
} from '../logistica.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Route minimal — usar config endpoint en lugar de un endpoint dedicado. */
interface RouteOption {
  id: string;
  name: string;
  origin?: string | null;
  destination?: string | null;
  driver_commission: number;
  helper_commission: number;
  estimated_km: number | null;
}

/**
 * J.9.10 — Shipment Form (Dialog).
 *
 * Migrado del repo `_imported/logistica/.../features/shipments/shipment-form.component.*`
 * (~402 LOC + 436 HTML). Adaptado a nuestro schema multi-tenant:
 *  - Auto-folio: backend genera EMB-YYYY-NNNNN (no se muestra editable).
 *  - FormGroup con todos los campos de logistics.shipments.
 *  - Selectores cargados via forkJoin (vehicles + drivers + routes config).
 *  - Sección expandible "Asignar guía + comisiones" que crea delivery_guide
 *    inmediatamente tras el shipment, con comisiones auto-calculadas desde
 *    la route si está seleccionada.
 *  - Cálculo computed de margen estimado en vivo.
 *  - Auto-cálculo de km×2 (ida+vuelta) y flete sugerido si hay route con km.
 *
 * Usa @Input visible + @Output visibleChange (two-way binding) y `saved` con
 * el shipment creado para que el padre refresque su lista.
 */
@Component({
  selector: 'app-shipment-form-dialog',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, FormsModule,
    ButtonModule, CardModule, DialogModule,
    InputTextModule, InputNumberModule, TextareaModule, DatePickerModule,
    SelectModule, SelectButtonModule, CheckboxModule, DividerModule, TagModule,
    ToastModule, TooltipModule,
  ],
  providers: [MessageService],
  template: `
    <p-toast position="bottom-right"></p-toast>

    <p-dialog
      [visible]="visible()"
      (visibleChange)="visibleChange.emit($event)"
      [modal]="true"
      [closable]="!saving()"
      [style]="{ width: '90vw', maxWidth: '800px' }"
      [draggable]="false"
      header="Nuevo embarque"
    >
      <form [formGroup]="form" class="form">

        <!-- ─── Info banner: folio + status ─── -->
        <div class="info-banner">
          <i class="pi pi-info-circle"></i>
          <span>El folio se asignará automáticamente al crear (formato <code>EMB-{{ currentYear }}-NNNNN</code>). El estado inicial será <strong>programado</strong>.</span>
        </div>

        <p-divider></p-divider>

        <!-- ─── Datos generales ─── -->
        <h4 class="section-title">Datos generales</h4>
        <div class="row three">
          <label>
            Fecha *
            <p-datepicker formControlName="shipment_date" dateFormat="yy-mm-dd" [showIcon]="true"></p-datepicker>
          </label>
          <label>
            Tipo *
            <p-select formControlName="type" [options]="typeOptions" optionLabel="label" optionValue="value"></p-select>
          </label>
          <label>
            Entrega *
            <p-selectButton formControlName="delivery_type" [options]="deliveryTypeOptions" optionLabel="label" optionValue="value"></p-selectButton>
          </label>
        </div>

        <div class="row two">
          <label>
            Vehículo
            <p-select formControlName="vehicle_id" [options]="vehicleOptions()" optionLabel="label" optionValue="value" [showClear]="true" placeholder="Sin asignar"></p-select>
          </label>
          <label>
            Ruta (catálogo destinos)
            <p-select formControlName="route_id" [options]="routeOptions()" optionLabel="name" optionValue="id" [showClear]="true" [filter]="true" placeholder="Sin ruta"></p-select>
          </label>
        </div>

        <div class="row two">
          <label>
            Origen
            <input pInputText formControlName="origin" placeholder="CEDIS Central" />
          </label>
          <label>
            Destino
            <input pInputText formControlName="destination" placeholder="Cliente / sucursal" />
          </label>
        </div>

        <!-- ─── Métricas + flete ─── -->
        <h4 class="section-title">Carga y flete</h4>
        <div class="row three">
          <label>
            Cajas
            <p-inputnumber formControlName="boxes_count" [min]="0"></p-inputnumber>
          </label>
          <label>
            Peso total (kg)
            <p-inputnumber formControlName="total_weight_kg" [min]="0" [minFractionDigits]="2"></p-inputnumber>
          </label>
          <label>
            Km estimados <i class="pi pi-info-circle" pTooltip="Si seleccionás una ruta del catálogo, se sugiere km×2 (ida+vuelta)."></i>
            <p-inputnumber formControlName="actual_km" [min]="0" [minFractionDigits]="0"></p-inputnumber>
          </label>
        </div>

        <div class="row two">
          <label>
            Valor mercancía
            <p-inputnumber formControlName="cargo_value" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
          </label>
          <label>
            Flete cobrado
            <p-inputnumber formControlName="freight_revenue" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
          </label>
        </div>

        <!-- ─── Opcional: vincular order del comercial ─── -->
        <p-divider></p-divider>
        <h4 class="section-title">Vínculo con pedido (opcional)</h4>
        <div class="link-banner" *ngIf="form.get('order_id')?.value">
          <i class="pi pi-link"></i>
          <span>Pre-vinculado al pedido. Al cerrar el embarque, el pedido pasará a <strong>fulfilled</strong> automáticamente.</span>
        </div>
        <label>
          Order ID (pegar UUID o dejar vacío)
          <input pInputText formControlName="order_id" placeholder="UUID del pedido confirmed (opcional)" />
        </label>

        <!-- ─── Sección expandible: asignar guía + comisiones ─── -->
        <p-divider></p-divider>
        <div class="expandable-header" role="button" tabindex="0"
             [attr.aria-expanded]="includeGuide()"
             (click)="toggleGuideSection()" (keydown.enter)="toggleGuideSection()" (keydown.space)="$event.preventDefault(); toggleGuideSection()">
          <i class="pi" [class.pi-chevron-down]="includeGuide()" [class.pi-chevron-right]="!includeGuide()"></i>
          <h4 class="section-title inline">Asignar guía + comisiones (opcional)</h4>
          <p-checkbox [binary]="true" [ngModel]="includeGuide()" (onChange)="setIncludeGuide($event.checked)" [ngModelOptions]="{ standalone: true }"></p-checkbox>
        </div>

        <div *ngIf="includeGuide()" class="guide-section" formGroupName="guide">
          <p class="muted small">Se creará una delivery_guide vinculada al embarque tras crearlo. Comisiones sugeridas desde la ruta seleccionada.</p>
          <div class="row two">
            <label>
              Chofer *
              <p-select formControlName="driver_id" [options]="driverOptions()" optionLabel="full_name" optionValue="id" [filter]="true" placeholder="Seleccionar chofer"></p-select>
            </label>
            <label>
              Comisión chofer
              <p-inputnumber formControlName="driver_commission" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
            </label>
          </div>
          <div class="row two">
            <label>
              Ayudante 1
              <p-select formControlName="helper1_id" [options]="helperOptions()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true" placeholder="Sin ayudante"></p-select>
            </label>
            <label>
              Comisión ayudante 1
              <p-inputnumber formControlName="helper1_commission" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
            </label>
          </div>
          <div class="row two">
            <label>
              Ayudante 2
              <p-select formControlName="helper2_id" [options]="helperOptions()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true" placeholder="Sin ayudante"></p-select>
            </label>
            <label>
              Comisión ayudante 2
              <p-inputnumber formControlName="helper2_commission" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2"></p-inputnumber>
            </label>
          </div>
          <div class="row two">
            <label>
              Viáticos totales
              <p-inputnumber formControlName="per_diem_total" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="2" [readonly]="autoPerDiem()"></p-inputnumber>
            </label>
            <label class="checkbox-label">
              <p-checkbox formControlName="overnight" [binary]="true" inputId="overnight"></p-checkbox>
              Pernocta (chofer duerme fuera)
            </label>
          </div>

          <!-- Viáticos: checklist auto-cálculo -->
          <div class="per-diem-toggle">
            <label class="checkbox-label">
              <p-checkbox [(ngModel)]="autoPerDiemModel" [ngModelOptions]="{ standalone: true }" [binary]="true" inputId="auto-per-diem" (onChange)="onAutoPerDiemToggle($event.checked)"></p-checkbox>
              Calcular viáticos automáticamente desde checklist (café / desayuno / comida / cena por persona)
            </label>
          </div>
          <div class="per-diem-checklist" *ngIf="autoPerDiem()">
            <table class="pd-table">
              <thead>
                <tr>
                  <th>Persona</th>
                  <th *ngFor="let m of mealColumns" class="meal-col">
                    {{ m.label }}<br>
                    <small>\${{ viaticoRate(m.key) | number:'1.2-2' }}</small>
                  </th>
                  <th class="num">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let p of personRows">
                  <td>{{ p.label }}</td>
                  <td *ngFor="let m of mealColumns" class="meal-col">
                    <p-checkbox [(ngModel)]="perDiemCheck()[p.key][m.key]" [ngModelOptions]="{ standalone: true }" [binary]="true" (onChange)="recalcPerDiem()"></p-checkbox>
                  </td>
                  <td class="num">\${{ perDiemSubtotal(p.key) | number:'1.2-2' }}</td>
                </tr>
              </tbody>
            </table>
            <p class="muted small">Tarifas de <code>config_finance.viatico_*</code>. El backend recalcula al guardar — este preview es solo informativo.</p>
          </div>
        </div>

        <!-- ─── Cálculo de margen estimado ─── -->
        <p-divider></p-divider>
        <div class="margin-summary">
          <div class="ms-item">
            <span class="ms-label">Revenue</span>
            <span class="ms-value">\${{ revenue() | number:'1.2-2' }}</span>
          </div>
          <div class="ms-item">
            <span class="ms-label">Comisiones</span>
            <span class="ms-value">- \${{ totalCommissions() | number:'1.2-2' }}</span>
          </div>
          <div class="ms-item">
            <span class="ms-label">Viáticos</span>
            <span class="ms-value">- \${{ perDiem() | number:'1.2-2' }}</span>
          </div>
          <div class="ms-divider"></div>
          <div class="ms-item ms-total" [class.neg]="estimatedMargin() < 0">
            <span class="ms-label">Margen estimado</span>
            <span class="ms-value">\${{ estimatedMargin() | number:'1.2-2' }}</span>
          </div>
          <p class="muted small" style="margin-top:.5rem">No incluye combustible/casetas (se cargan al cerrar el embarque).</p>
        </div>

        <!-- ─── Notas ─── -->
        <p-divider></p-divider>
        <label>
          Notas
          <textarea pTextarea rows="2" formControlName="notes"></textarea>
        </label>
      </form>

      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="cancel()" [disabled]="saving()"></button>
        <button pButton label="Crear embarque" icon="pi pi-check" [loading]="saving()" [disabled]="form.invalid" (click)="submit()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:contents; }
    .form { display:flex; flex-direction:column; gap:.75rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--c-text-2); }
    .row { display:grid; gap:1rem; }
    .row.two { grid-template-columns: 1fr 1fr; }
    .row.three { grid-template-columns: 1fr 1fr 1fr; }
    .section-title { margin: 0; font-size: .9rem; font-weight: 600; color: var(--c-text-1); }
    .section-title.inline { display: inline; flex: 1; }

    .info-banner { display:flex; align-items:flex-start; gap:.5rem; background: var(--c-surface-2); color: var(--c-text-1); padding:.65rem .85rem; border-radius:6px; font-size:.85rem; }
    .info-banner i { margin-top: .15rem; color: var(--action); }
    code { background: var(--c-surface-2); padding:.05rem .35rem; border-radius:3px; font-family: var(--font-mono); }

    .link-banner { display:flex; align-items:flex-start; gap:.5rem; background: var(--ok-soft-bg); color: var(--ok-soft-fg); padding:.6rem .8rem; border-radius:6px; font-size:.85rem; }

    .expandable-header { display:flex; align-items:center; gap:.75rem; cursor: pointer; padding:.5rem; border-radius:6px; margin: 0 -.5rem; }
    .expandable-header:hover { background: var(--c-surface-2); }
    .expandable-header:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .expandable-header i.pi { color: var(--c-text-2); }

    .guide-section { display:flex; flex-direction:column; gap:.75rem; padding:.75rem; background: var(--c-surface-2); border-radius: 8px; }
    .muted { color: var(--c-text-2); }
    .small { font-size: .75rem; }
    .checkbox-label { flex-direction: row; align-items: center; gap: .5rem; padding-top: 1.25rem; }

    .margin-summary { background: var(--c-surface-2); padding: 1rem; border-radius: 8px; display:flex; flex-direction:column; gap:.35rem; }
    .ms-item { display:flex; justify-content:space-between; font-size: .85rem; }
    .ms-divider { height: 1px; background: var(--c-divider); margin: .25rem 0; }
    .ms-total { font-size: 1rem; font-weight: 700; }
    .ms-total .ms-value { color: var(--ok-fg); }
    .ms-total.neg .ms-value { color: var(--bad-fg); }

    @media (max-width: 600px) {
      .row.two, .row.three { grid-template-columns: 1fr; }
    }

    .per-diem-toggle { background: var(--c-surface-2); padding: .65rem .85rem; border-radius: 6px; margin-top: .5rem; }
    .per-diem-checklist { background: var(--c-surface-2); padding: .85rem; border-radius: 6px; margin-top: .5rem; }
    .pd-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    .pd-table th { text-align: center; padding: .5rem; font-weight: 600; color: var(--c-text-2); font-size: .8rem; }
    .pd-table th small { font-weight: 400; font-size: .7rem; color: var(--c-text-2); }
    .pd-table td { padding: .5rem; text-align: center; border-top: 1px solid var(--c-divider); }
    .pd-table td:first-child { text-align: left; font-weight: 500; }
    .pd-table .meal-col { width: 5rem; }
    .pd-table .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShipmentFormDialogComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);

  // ── I/O ──────────────────────────────────────────────────────────────────
  visible = input<boolean>(false);
  prefilledOrderId = input<string | null>(null);
  visibleChange = output<boolean>();
  saved = output<Shipment>();

  readonly currentYear = new Date().getFullYear();

  // ── State ────────────────────────────────────────────────────────────────
  readonly saving = signal(false);
  readonly drivers = signal<Driver[]>([]);
  readonly vehicles = signal<{ id: string; plate: string; model?: string | null }[]>([]);
  readonly routes = signal<RouteOption[]>([]);
  readonly includeGuide = signal(false);
  readonly autoPerDiem = signal(false);
  autoPerDiemModel = false;
  readonly viaticoRates = signal<Record<string, number>>({ cafe: 0, desayuno: 0, comida: 0, cena: 0 });
  readonly perDiemCheck = signal<Record<'driver' | 'helper1' | 'helper2', Record<'cafe' | 'desayuno' | 'comida' | 'cena', boolean>>>({
    driver:  { cafe: false, desayuno: false, comida: false, cena: false },
    helper1: { cafe: false, desayuno: false, comida: false, cena: false },
    helper2: { cafe: false, desayuno: false, comida: false, cena: false },
  });

  readonly personRows = [
    { key: 'driver',  label: 'Chofer' },
    { key: 'helper1', label: 'Ayudante 1' },
    { key: 'helper2', label: 'Ayudante 2' },
  ] as const;
  readonly mealColumns = [
    { key: 'cafe',     label: '☕ Café' },
    { key: 'desayuno', label: '🍳 Desayuno' },
    { key: 'comida',   label: '🍽️ Comida' },
    { key: 'cena',     label: '🌙 Cena' },
  ] as const;

  readonly typeOptions: { label: string; value: ShipmentType }[] = [
    { label: 'Entrega', value: 'entrega' },
    { label: 'Traspaso', value: 'traspaso' },
    { label: 'Recolección', value: 'recoleccion' },
  ];
  readonly deliveryTypeOptions = [
    { label: 'Por ruta', value: 'route' },
    { label: 'Viaje largo', value: 'long_trip' },
  ];

  readonly vehicleOptions = computed(() =>
    this.vehicles().map((v) => ({ label: `${v.plate}${v.model ? ' — ' + v.model : ''}`, value: v.id })),
  );
  readonly routeOptions = computed(() => this.routes());
  readonly driverOptions = computed(() =>
    this.drivers().filter((d) => d.active && d.roles.includes('chofer')),
  );
  readonly helperOptions = computed(() =>
    this.drivers().filter((d) => d.active && (d.roles.includes('ayudante') || d.roles.includes('cargador'))),
  );

  form: FormGroup = this.fb.group({
    shipment_date: [new Date(), Validators.required],
    type: ['entrega' as ShipmentType, Validators.required],
    delivery_type: ['route'],
    vehicle_id: [null],
    route_id: [null],
    order_id: [null],
    origin: [''],
    destination: [''],
    actual_km: [0],
    boxes_count: [0],
    total_weight_kg: [0],
    cargo_value: [0],
    freight_revenue: [0],
    notes: [''],
    guide: this.fb.group({
      driver_id: [null],
      driver_commission: [0],
      helper1_id: [null],
      helper1_commission: [0],
      helper2_id: [null],
      helper2_commission: [0],
      per_diem_total: [0],
      overnight: [false],
    }),
  });

  // ── Computed financiero ─────────────────────────────────────────────────
  readonly revenue = signal(0);
  readonly totalCommissions = signal(0);
  readonly perDiem = signal(0);
  readonly estimatedMargin = computed(() => this.revenue() - this.totalCommissions() - this.perDiem());

  constructor() {
    // Initial load
    forkJoin({
      drivers: this.api.listDrivers({ active: true }),
      vehicles: this.api.listVehicles({ active: true }),
      routes: this.api.listRoutes({ active: true }),
      viatico: this.api.listConfig('viatico'),
    }).subscribe({
      next: ({ drivers, vehicles, routes, viatico }) => {
        this.drivers.set(drivers || []);
        this.vehicles.set(vehicles || []);
        this.routes.set(
          (routes || []).map((r: any) => ({
            id: r.id,
            name: r.name,
            origin: r.origin ?? null,
            destination: r.destination ?? null,
            driver_commission: Number(r.driver_commission) || 0,
            helper_commission: Number(r.helper_commission) || 0,
            estimated_km: r.estimated_km != null ? Number(r.estimated_km) : null,
          })),
        );
        const rates: Record<string, number> = { cafe: 0, desayuno: 0, comida: 0, cena: 0 };
        for (const v of (viatico as ConfigItem[]) || []) {
          const meal = v.key.replace(/^viatico_/, '');
          rates[meal] = Number(v.value) || 0;
        }
        this.viaticoRates.set(rates);
      },
      error: () => {
        this.toast.add({ severity: 'warn', summary: 'Carga parcial', detail: 'Algunos catálogos no se cargaron' });
      },
    });

    // Effect: pre-fill order_id desde input
    effect(() => {
      const oid = this.prefilledOrderId();
      if (oid && this.visible()) {
        this.form.patchValue({ order_id: oid });
      }
    });

    // Effect: cuando route cambia, autocompletar comisiones + km sugerido
    this.form.get('route_id')?.valueChanges.subscribe((routeId) => {
      const route = this.routes().find((r) => r.id === routeId);
      if (!route) return;
      // Auto-fill km si está vacío
      if (route.estimated_km && !this.form.get('actual_km')?.value) {
        this.form.patchValue({ actual_km: route.estimated_km * 2 }); // ida + vuelta
      }
      // Auto-fill origen/destino desde la ruta si están vacíos
      const patch: any = {};
      if (route.origin && !this.form.get('origin')?.value) patch.origin = route.origin;
      if (!this.form.get('destination')?.value) patch.destination = route.destination || route.name;
      if (Object.keys(patch).length) this.form.patchValue(patch);
      // Auto-fill comisiones de guía si la sección está activa
      if (this.includeGuide()) {
        this.form.get('guide')?.patchValue({
          driver_commission: route.driver_commission || 0,
          helper1_commission: route.helper_commission || 0,
          helper2_commission: route.helper_commission || 0,
        });
      }
    });

    // Effect: recalcular margen en vivo
    this.form.valueChanges.subscribe((v) => {
      this.revenue.set(Number(v.freight_revenue || 0));
      if (this.includeGuide()) {
        const g = v.guide || {};
        this.totalCommissions.set(
          Number(g.driver_commission || 0) +
          Number(g.helper1_commission || 0) +
          Number(g.helper2_commission || 0),
        );
        this.perDiem.set(Number(g.per_diem_total || 0));
      } else {
        this.totalCommissions.set(0);
        this.perDiem.set(0);
      }
    });
  }

  toggleGuideSection(): void {
    this.includeGuide.update((v) => !v);
  }
  setIncludeGuide(v: boolean): void {
    this.includeGuide.set(v);
  }

  // ── Auto per-diem helpers ──────────────────────────────────────────────
  onAutoPerDiemToggle(on: boolean): void {
    this.autoPerDiem.set(!!on);
    if (on) this.recalcPerDiem();
  }
  viaticoRate(meal: string): number {
    return this.viaticoRates()[meal] || 0;
  }
  perDiemSubtotal(person: 'driver' | 'helper1' | 'helper2'): number {
    const checks = this.perDiemCheck()[person];
    let s = 0;
    for (const m of ['cafe', 'desayuno', 'comida', 'cena'] as const) {
      if (checks[m]) s += this.viaticoRates()[m] || 0;
    }
    return s;
  }
  recalcPerDiem(): void {
    if (!this.autoPerDiem()) return;
    // Force signal re-emission (object mutation no triggers it)
    this.perDiemCheck.set({ ...this.perDiemCheck() });
    const total = this.perDiemSubtotal('driver') + this.perDiemSubtotal('helper1') + this.perDiemSubtotal('helper2');
    this.form.get('guide')?.patchValue({ per_diem_total: total });
  }

  cancel(): void {
    this.visibleChange.emit(false);
    this.form.reset({
      shipment_date: new Date(),
      type: 'entrega', delivery_type: 'route',
      vehicle_id: null, route_id: null, order_id: null,
      origin: '', destination: '',
      actual_km: 0, boxes_count: 0, total_weight_kg: 0, cargo_value: 0, freight_revenue: 0,
      notes: '',
      guide: {
        driver_id: null, driver_commission: 0,
        helper1_id: null, helper1_commission: 0,
        helper2_id: null, helper2_commission: 0,
        per_diem_total: 0, overnight: false,
      },
    });
    this.includeGuide.set(false);
    this.autoPerDiem.set(false);
    this.autoPerDiemModel = false;
    this.perDiemCheck.set({
      driver:  { cafe: false, desayuno: false, comida: false, cena: false },
      helper1: { cafe: false, desayuno: false, comida: false, cena: false },
      helper2: { cafe: false, desayuno: false, comida: false, cena: false },
    });
  }

  submit(): void {
    if (this.form.invalid) {
      this.toast.add({ severity: 'warn', summary: 'Form inválido', detail: 'Revisá los campos obligatorios' });
      return;
    }
    const raw = this.form.getRawValue();
    const shipmentPayload: Partial<Shipment> = {
      shipment_date: raw.shipment_date instanceof Date
        ? raw.shipment_date.toISOString().slice(0, 10)
        : raw.shipment_date,
      type: raw.type,
      vehicle_id: raw.vehicle_id || undefined,
      route_id: raw.route_id || undefined,
      order_id: raw.order_id || undefined,
      origin: raw.origin || undefined,
      destination: raw.destination || undefined,
      actual_km: Number(raw.actual_km) || undefined,
      boxes_count: Number(raw.boxes_count) || 0,
      total_weight_kg: Number(raw.total_weight_kg) || 0,
      cargo_value: Number(raw.cargo_value) || 0,
      freight_revenue: Number(raw.freight_revenue) || 0,
      notes: raw.notes || undefined,
    };

    this.saving.set(true);
    this.api.createShipment(shipmentPayload).subscribe({
      next: (ship) => {
        // Si incluyó guide, crearla
        if (this.includeGuide() && raw.guide?.driver_id) {
          const guideBody: Partial<DeliveryGuide> & {
            shipment_id: string;
            auto_per_diem?: boolean;
            per_diem_breakdown?: any;
          } = {
            shipment_id: ship.id,
            driver_id: raw.guide.driver_id,
            driver_commission: Number(raw.guide.driver_commission) || 0,
            helper1_id: raw.guide.helper1_id || undefined,
            helper1_commission: Number(raw.guide.helper1_commission) || 0,
            helper2_id: raw.guide.helper2_id || undefined,
            helper2_commission: Number(raw.guide.helper2_commission) || 0,
            per_diem_total: Number(raw.guide.per_diem_total) || 0,
            overnight: raw.guide.overnight || false,
          };
          if (this.autoPerDiem()) {
            guideBody.auto_per_diem = true;
            guideBody.per_diem_breakdown = this.perDiemCheck();
          }
          this.api.createGuide(guideBody).subscribe({
            next: () => {
              this.saving.set(false);
              this.toast.add({ severity: 'success', summary: 'Creado', detail: `Embarque ${ship.folio} con guía asignada` });
              this.saved.emit(ship);
              this.visibleChange.emit(false);
              this.cancel();
            },
            error: (err) => {
              this.saving.set(false);
              // El shipment ya está creado, la guide falló — informar al user
              this.toast.add({ severity: 'warn', summary: 'Parcial', detail: `Embarque creado pero falló la guía: ${err?.error?.message || ''}` });
              this.saved.emit(ship);
              this.visibleChange.emit(false);
              this.cancel();
            },
          });
        } else {
          this.saving.set(false);
          this.toast.add({ severity: 'success', summary: 'Creado', detail: `Embarque ${ship.folio}` });
          this.saved.emit(ship);
          this.visibleChange.emit(false);
          this.cancel();
        }
      },
      error: (err) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se creó el embarque' });
      },
    });
  }
}
