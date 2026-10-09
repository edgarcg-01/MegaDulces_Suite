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
  LogisticaService,
  Shipment,
  ShipmentType,
} from '../logistica.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** `YYYY-MM-DD` con las partes LOCALES de la fecha (no UTC). */
export function fechaLocal(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
 *  - Selectores cargados via forkJoin (vehicles + routes config).
 *  - EMB.22: la GUÍA (chofer, ayudantes, horario) ya no se captura aquí: se captura
 *    sólo en la pestaña Guías del embarque, donde se calculan comisión y viáticos.
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
            <p-selectbutton formControlName="delivery_type" [options]="deliveryTypeOptions" optionLabel="label" optionValue="value" styleClass="sb-liquid"></p-selectbutton>
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
        @if (form.get('order_id')?.value) {
          <div class="link-banner">
            <i class="pi pi-link"></i>
            <span>Pre-vinculado al pedido. Al cerrar el embarque, el pedido pasará a <strong>fulfilled</strong> automáticamente.</span>
          </div>
        }
        <label>
          Order ID (pegar UUID o dejar vacío)
          <input pInputText formControlName="order_id" placeholder="UUID del pedido confirmed (opcional)" />
        </label>
    
        <!-- EMB.22 — la guía se captura sólo en la pestaña Guías del embarque -->
        <p-divider></p-divider>
        <p class="muted small sf-guia-nota">La guía (chofer, ayudantes y horario) se captura en la pestaña <strong>Guías</strong> del embarque, una vez creado; ahí se calculan la comisión y los viáticos.</p>

        <!-- ─── Notas ─── -->
        <p-divider></p-divider>
        <label>
          Notas
          <textarea pTextarea rows="2" formControlName="notes"></textarea>
        </label>
      </form>
    
      <ng-template #footer>
        <button pButton severity="secondary" [text]="true" (click)="cancel()" [disabled]="saving()"><span class="p-button-label">Cancelar</span></button>
        <button pButton [loading]="saving()" [disabled]="form.invalid" (click)="submit()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Crear embarque</span></button>
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


    .muted { color: var(--c-text-2); }
    .small { font-size: var(--fs-xs); }
    .checkbox-label { flex-direction: row; align-items: center; gap: .5rem; padding-top: 1.25rem; }


    @media (max-width: 37.5rem) {
      .row.two, .row.three { grid-template-columns: 1fr; }
    }

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
  readonly vehicles = signal<{ id: string; plate: string; model?: string | null }[]>([]);
  readonly routes = signal<RouteOption[]>([]);
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
  });

  constructor() {
    // Initial load
    forkJoin({
      vehicles: this.api.listVehicles({ active: true }),
      routes: this.api.listRoutes({ active: true }),
    }).subscribe({
      next: ({ vehicles, routes }) => {
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
    });
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
    });
  }

  submit(): void {
    if (this.form.invalid) {
      this.toast.add({ severity: 'warn', summary: 'Form inválido', detail: 'Revisá los campos obligatorios' });
      return;
    }
    const raw = this.form.getRawValue();
    const shipmentPayload: Partial<Shipment> = {
      // ⚠️ Fecha LOCAL, no toISOString(): el valor por defecto es `new Date()` con la hora actual,
      // y en México (UTC-6) después de las 18:00 el ISO ya es el día siguiente.
      shipment_date: raw.shipment_date instanceof Date
        ? fechaLocal(raw.shipment_date)
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
      // EMB.12 — se pedía en el formulario y no se mandaba: no existía la columna.
      delivery_type: raw.delivery_type || undefined,
    };

    this.saving.set(true);
    this.api.createShipment(shipmentPayload).subscribe({
      next: (ship) => {
        this.saving.set(false);
        this.toast.add({ severity: 'success', summary: 'Creado', detail: `Embarque ${ship.folio}: su guía se captura en la pestaña Guías` });
        this.saved.emit(ship);
        this.visibleChange.emit(false);
        this.cancel();
      },
      error: (err) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se creó el embarque' });
      },
    });
  }
}
