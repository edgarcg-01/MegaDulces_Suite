import { Component, inject, OnInit, OnDestroy, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';

import { FiltersStateService } from './filters-state.service';
import { ReportsService } from '../reports.service';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';

interface DropOption {
  label: string;
  value: any;
}

@Component({
  selector: 'app-global-filters',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SelectModule,
    DatePickerModule,
    MultiSelectModule,
  ],
  template: `
    <div class="grid grid-cols-1 md:grid-cols-5 gap-3 p-4 bg-surface-card rounded-xl border border-divider mb-6">
      <!-- Período -->
      <div class="flex flex-col gap-1">
        <label class="filter-label">Período</label>
        <p-select
          [options]="periods"
          [(ngModel)]="selectedPeriod"
          optionLabel="label" optionValue="value"
          (onChange)="onPeriodChange()"
          class="w-full" />
      </div>

      <!-- Fechas (solo visible si custom) -->
      <div class="flex flex-col gap-1">
        <label class="filter-label">Fechas</label>
        <p-datepicker
          [(ngModel)]="dateRange"
          selectionMode="range"
          [showIcon]="true"
          [readonlyInput]="true"
          [showButtonBar]="true"
          (onSelect)="onDateChange()"
          class="w-full" />
      </div>

      <!-- Zona -->
      <div class="flex flex-col gap-1">
        <label class="filter-label">Zona</label>
        <p-select
          [options]="zones"
          [(ngModel)]="selectedZone"
          optionLabel="label" optionValue="value"
          [showClear]="true"
          placeholder="Todas"
          (onChange)="onZoneChange()"
          class="w-full" />
      </div>

      <!-- Encargado -->
      <div class="flex flex-col gap-1">
        <label class="filter-label">Encargado</label>
        <p-select
          [options]="supervisors"
          [(ngModel)]="selectedSupervisorId"
          optionLabel="label" optionValue="value"
          [showClear]="true"
          placeholder="Todos"
          (onChange)="onSupervisorChange()"
          class="w-full" />
      </div>

      <!-- Vendedores -->
      <div class="flex flex-col gap-1">
        <label class="filter-label">Vendedor</label>
        <p-multiSelect
          [options]="sellers"
          [(ngModel)]="selectedSellerIds"
          optionLabel="label" optionValue="value"
          [filter]="true"
          filterBy="label"
          display="chip"
          placeholder="Todos"
          (onChange)="onSellerChange()"
          class="w-full" />
      </div>

    </div>
  `,
  styles: [`
    :host ::ng-deep .filter-label {
        font-size: 10px;
        font-weight: 700;
      text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--content-faint);
      }
    `,
  ],
})
export class GlobalFiltersComponent implements OnInit {
  // Emite cuando cualquier filtro cambia para que el padre recargue datos
  readonly filtersChanged = output<void>();

  private filtersState = inject(FiltersStateService);
  private reportsService = inject(ReportsService);
  private authService = inject(AuthService);

  // ── Opciones de dropdowns (cargadas desde API) ──
  zones: DropOption[] = [{ label: 'Todas las zonas', value: null }];
  supervisors: DropOption[] = [{ label: 'Todos', value: null }];
  sellers: DropOption[] = [];

  periods: DropOption[] = [
    { label: 'Hoy', value: 'hoy' },
    { label: 'Semana', value: 'semanal' },
    { label: 'Quincena', value: 'quincenal' },
    { label: 'Mes', value: 'mensual' },
    { label: 'Personalizado', value: 'custom' },
  ];

  // Bind locales (se sincronizan con el servicio)
  selectedPeriod = 'semanal';
  dateRange: Date[] = [];
  selectedZone: string | null = null;
  selectedSupervisorId: string | null = null;
  selectedSellerIds: string[] = [];

  ngOnInit() {
    const f = this.filtersState.filters();
    this.selectedPeriod = f.period;
    this.selectedZone = f.zone;
    this.selectedSupervisorId = f.supervisorId;
    this.selectedSellerIds = f.sellerIds;

    // Cargar filtros desde la API
    this.loadZones();
    this.loadSupervisors();
    this.loadSellers();
  }

  private loadZones() {
    this.reportsService.getZones().subscribe({
      next: (zones) => {
        this.zones = [
          { label: 'Todas las zonas', value: null },
          ...zones.map((z: any) => ({
            label: z.value || z.name || z.nombre || z.zone || z.id,
            value: z.id
          }))
        ];
      },
      error: () => {
        console.warn('No se pudieron cargar las zonas');
      }
    });
  }

  private loadSupervisors() {
    // Solo cargar supervisores si el usuario tiene el permiso USUARIOS_VER
    if (!this.authService.hasPermission(Permission.USUARIOS_VER)) {
      return;
    }

    this.reportsService.getSupervisors().subscribe({
      next: (supervisors) => {
        this.supervisors = [
          { label: 'Todos', value: null },
          ...supervisors.map((s: any) => ({
            label: s.full_name || s.name || s.nombre || s.username || s.id,
            value: s.id
          }))
        ];
      },
      error: () => {
        console.warn('No se pudieron cargar los supervisores');
      }
    });
  }

  private loadSellers() {
    this.reportsService.getSellers().subscribe({
      next: (sellers) => {
        this.sellers = sellers.map((s: any) => ({
          label: s.full_name || s.name || s.nombre || s.username || s.id,
          value: s.id
        }));
      },
      error: () => {
        console.warn('No se pudieron cargar los vendedores');
      }
    });
  }

  onPeriodChange() {
    this.filtersState.setPeriod(this.selectedPeriod);
    if (this.selectedPeriod !== 'custom') this.emit();
  }

  onDateChange() {
    if (this.dateRange?.[0] && this.dateRange?.[1]) {
      this.filtersState.setDateRange(this.dateRange[0], this.dateRange[1]);
      this.emit();
    }
  }

  onZoneChange() {
    this.filtersState.setZone(this.selectedZone);
    this.emit();
  }

  onSupervisorChange() {
    this.filtersState.setSupervisor(this.selectedSupervisorId);
    this.emit();
  }

  onSellerChange() {
    this.filtersState.setSellers(this.selectedSellerIds);
    this.emit();
  }

  /** Carga externa de opciones (el padre llama a estos setters) */
  setZones(list: DropOption[]) {
    this.zones = [{ label: 'Todas las zonas', value: null }, ...list];
  }
  setSupervisors(list: DropOption[]) {
    this.supervisors = [{ label: 'Todos', value: null }, ...list];
  }
  setSellers(list: DropOption[]) {
    this.sellers = list;
  }

  reset() {
    this.filtersState.reset();
    const f = this.filtersState.filters();
    this.selectedPeriod = f.period;
    this.selectedZone = f.zone;
    this.selectedSupervisorId = f.supervisorId;
    this.selectedSellerIds = f.sellerIds;
    this.emit();
  }

  private emit() {
    this.filtersChanged.emit();
  }
}
