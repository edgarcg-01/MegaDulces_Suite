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
import { toSignal } from '@angular/core/rxjs-interop';
import { startWith } from 'rxjs';
import type { NuevaGuiaBody, TarifaDeRuta, TarifasViatico } from '@megadulces/contracts';
import {
  comisionesDeLaGuia, erroresDeGuiaManual, erroresDeTarifaDeRuta, erroresDeViaticos, tarifasDeViatico, viaticosDeLaGuia,
} from '@megadulces/contracts';
import { GuiaCalculadaComponent, PersonaDeLaGuia } from './guia-calculada.component';
import { forkJoin } from 'rxjs';
import {
  ConfigItem,
  Driver,
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
 *  - Selectores cargados via forkJoin (vehicles + drivers + routes config).
 *  - Sección expandible "Asignar guía" que crea delivery_guide inmediatamente tras
 *    el shipment. EMB.19: se eligen tripulación y horario; la comisión (tarifa de la
 *    ruta) y los viáticos (regla de horario de la beta) se calculan y no se teclean.
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
    ToastModule, TooltipModule, GuiaCalculadaComponent,
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
    
        <!-- ─── Sección expandible: asignar guía + comisiones ─── -->
        <p-divider></p-divider>
        <div class="expandable-header" role="button" tabindex="0"
          [attr.aria-expanded]="includeGuide()"
          (click)="toggleGuideSection()" (keydown.enter)="toggleGuideSection()" (keydown.space)="$event.preventDefault(); toggleGuideSection()">
          <i class="pi" [class.pi-chevron-down]="includeGuide()" [class.pi-chevron-right]="!includeGuide()"></i>
          <h4 class="section-title inline">Asignar guía (opcional)</h4>
          <p-checkbox [binary]="true" [ngModel]="includeGuide()" (onChange)="setIncludeGuide($event.checked)" [ngModelOptions]="{ standalone: true }"></p-checkbox>
        </div>
    
        @if (includeGuide()) {
          <div class="guide-section" formGroupName="guide">
            <p class="muted small">Se crea la guía del embarque al guardarlo. La comisión sale de la tarifa de la ruta y los viáticos del horario: se calculan, no se teclean.</p>
            <label>
              Chofer
              <p-select formControlName="driver_id" [options]="driverOptions()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true" placeholder="Seleccionar chofer"></p-select>
            </label>
            <div class="row two">
              <label>
                Ayudante 1
                <p-select formControlName="helper1_id" [options]="helperOptions()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true" placeholder="Sin ayudante"></p-select>
              </label>
              <label>
                Ayudante 2
                <p-select formControlName="helper2_id" [options]="helperOptions()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true" placeholder="Sin ayudante"></p-select>
              </label>
            </div>
            <div class="row three">
              <label>
                Hora de salida
                <input pInputText type="time" formControlName="departure_time" />
              </label>
              <label>
                Hora de llegada (estimada)
                <input pInputText type="time" formControlName="arrival_time" />
              </label>
              <label class="checkbox-label">
                <p-checkbox formControlName="overnight" [binary]="true" inputId="overnight"></p-checkbox>
                Se queda a dormir fuera
              </label>
            </div>
            <app-guia-calculada [personas]="guiaPersonas()" [comisiones]="guiaComisiones()"
              [viaticos]="guiaViaticos()" [tarifas]="viaticoRates()"></app-guia-calculada>
            @if (guiaErrores().length) {
              <div class="faltan">
                <p class="faltan-titulo">Para crear la guía falta:</p>
                <ul id="sf-guia-faltan" role="status">
                  @for (e of guiaErrores(); track e) { <li>{{ e }}</li> }
                </ul>
              </div>
            }
          </div>
        }

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
    
      <ng-template #footer>
        <button pButton severity="secondary" [text]="true" (click)="cancel()" [disabled]="saving()"><span class="p-button-label">Cancelar</span></button>
        <button pButton [loading]="saving()" [disabled]="form.invalid || (includeGuide() && guiaErrores().length > 0)"
          [attr.aria-describedby]="includeGuide() && guiaErrores().length ? 'sf-guia-faltan' : null" (click)="submit()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Crear embarque</span></button>
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
    .small { font-size: var(--fs-xs); }
    .checkbox-label { flex-direction: row; align-items: center; gap: .5rem; padding-top: 1.25rem; }

    .margin-summary { background: var(--c-surface-2); padding: 1rem; border-radius: 8px; display:flex; flex-direction:column; gap:.35rem; }
    .ms-item { display:flex; justify-content:space-between; font-size: .85rem; }
    .ms-divider { height: 1px; background: var(--c-divider); margin: .25rem 0; }
    .ms-total { font-size: 1rem; font-weight: 700; }
    .ms-total .ms-value { color: var(--ok-fg); }
    .ms-total.neg .ms-value { color: var(--bad-fg); }

    @media (max-width: 37.5rem) {
      .row.two, .row.three { grid-template-columns: 1fr; }
    }

    .faltan { font-size: var(--fs-xs); color: var(--bad-soft-fg); }
    .faltan-titulo { margin: 0; font-weight: var(--fw-bold); }
    .faltan ul { margin: .2rem 0 0; padding-left: 1rem; }
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
  /** Tarifas de viático por comida (`config_finance`, categoría `viatico`). null = aún no se leen. */
  readonly viaticoRates = signal<TarifasViatico | null>(null);

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
    // EMB.19 — sólo lo que se elige. Comisión y viáticos se calculan (ver `guiaComisiones`/`guiaViaticos`).
    guide: this.fb.group({
      driver_id: [null as string | null],
      helper1_id: [null as string | null],
      helper2_id: [null as string | null],
      departure_time: [''],
      arrival_time: [''],
      overnight: [false],
    }),
  });

  private readonly valor = toSignal(this.form.valueChanges.pipe(startWith(this.form.value)), { initialValue: this.form.value });
  /** La ruta elegida con su tarifa. null = sin ruta. */
  readonly rutaGuia = computed((): TarifaDeRuta | null => {
    const r = this.routes().find((x) => x.id === this.valor().route_id);
    return r ? { route_id: r.id, nombre: r.name, driver: r.driver_commission, helper: r.helper_commission } : null;
  });
  private readonly guiaVa = computed(() => {
    const g = this.valor().guide || {};
    return { driver: !!g.driver_id, helper1: !!g.helper1_id, helper2: !!g.helper2_id };
  });
  readonly guiaErrores = computed(() => {
    const t = this.viaticoRates();
    if (!t) return ['Leyendo las tarifas de viáticos…'];
    return erroresDeGuiaManual(this.valor().guide || {}, this.rutaGuia(), t);
  });
  readonly guiaComisiones = computed(() => {
    const r = this.rutaGuia();
    const va = this.guiaVa();
    if (!r || erroresDeTarifaDeRuta(r, va).length) return null;
    return comisionesDeLaGuia({ driver: r.driver, helper: r.helper }, va);
  });
  readonly guiaViaticos = computed(() => {
    const t = this.viaticoRates();
    const g = this.valor().guide || {};
    if (!t) return null;
    const h = { salida: g.departure_time || null, llegada: g.arrival_time || null, duerme_fuera: !!g.overnight };
    return erroresDeViaticos(h, t).length ? null : viaticosDeLaGuia(h, t, this.guiaVa());
  });
  readonly guiaPersonas = computed((): PersonaDeLaGuia[] => {
    const g = this.valor().guide || {};
    const nombre = (id: string | null | undefined) => (id ? this.drivers().find((d) => d.id === id)?.full_name ?? null : null);
    const xs: PersonaDeLaGuia[] = [{ key: 'driver', rol: 'Chofer', nombre: nombre(g.driver_id) }];
    if (g.helper1_id) xs.push({ key: 'helper1', rol: 'Ayudante 1', nombre: nombre(g.helper1_id) });
    if (g.helper2_id) xs.push({ key: 'helper2', rol: 'Ayudante 2', nombre: nombre(g.helper2_id) });
    return xs;
  });

  // ── Computed financiero ─────────────────────────────────────────────────
  readonly revenue = computed(() => Number(this.valor().freight_revenue || 0));
  /** Sin guía, o con la guía incompleta, no hay comisión ni viático que restar: el margen lo dice. */
  readonly totalCommissions = computed(() => {
    const k = this.includeGuide() ? this.guiaComisiones() : null;
    return k ? k.driver_commission + k.helper1_commission + k.helper2_commission : 0;
  });
  readonly perDiem = computed(() => (this.includeGuide() ? this.guiaViaticos()?.total ?? 0 : 0));
  readonly estimatedMargin = computed(() => this.revenue() - this.totalCommissions() - this.perDiem());

  constructor() {
    // Initial load
    forkJoin({
      drivers: this.api.listDrivers({ active: true }),
      vehicles: this.api.listVehicles({ active: true }),
      routes: this.api.listRoutes({ active: true }),
      viatico: this.api.listConfig('viatico', true),
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
        this.viaticoRates.set(tarifasDeViatico((viatico as ConfigItem[]) || []));
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
      // La comisión de la guía no se copia aquí: se calcula de la ruta (`guiaComisiones`).
    });
  }

  toggleGuideSection(): void {
    this.includeGuide.update((v) => !v);
  }
  setIncludeGuide(v: boolean): void {
    this.includeGuide.set(v);
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
        driver_id: null, helper1_id: null, helper2_id: null,
        departure_time: '', arrival_time: '', overnight: false,
      },
    });
    this.includeGuide.set(false);
  }

  submit(): void {
    if (this.form.invalid) {
      this.toast.add({ severity: 'warn', summary: 'Form inválido', detail: 'Revisá los campos obligatorios' });
      return;
    }
    // Con guía incompleta no se crea ni el embarque: antes quedaba creado y la guía fallaba aparte.
    if (this.includeGuide() && this.guiaErrores().length) {
      this.toast.add({ severity: 'warn', summary: 'Falta para la guía', detail: this.guiaErrores().join(' ') });
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
        // Si incluyó guide, crearla
        if (this.includeGuide()) {
          const guideBody: NuevaGuiaBody = {
            shipment_id: ship.id,
            driver_id: raw.guide.driver_id || null,
            helper1_id: raw.guide.helper1_id || null,
            helper2_id: raw.guide.helper2_id || null,
            departure_time: raw.guide.departure_time || null,
            arrival_time: raw.guide.arrival_time || null,
            overnight: !!raw.guide.overnight,
          };
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
