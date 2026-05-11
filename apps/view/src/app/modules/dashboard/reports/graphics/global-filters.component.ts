import { Component, inject, signal, OnInit, OnDestroy, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';

import { FiltersStateService } from './filters-state.service';
import { ReportsService } from '../reports.service';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { DailyCaptureService } from '../../captures/daily-capture.service';

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
    <div class="bg-surface-card rounded-xl border border-divider mb-6">
      <!-- Main row: filters críticos -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4">
        <div class="flex flex-col gap-1">
          <label class="filter-label">Período</label>
          <p-select
            [options]="periods"
            [(ngModel)]="selectedPeriod"
            optionLabel="label" optionValue="value"
            (onChange)="onPeriodChange()"
            class="w-full" />
        </div>

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

        <div class="flex flex-col gap-1">
          <label class="filter-label">Zona</label>
          <p-select
            [options]="zones"
            [(ngModel)]="selectedZone"
            optionLabel="label" optionValue="value"
            [showClear]="true"
            placeholder="Todas"
            (onChange)="onZoneChange()"
            (onClear)="onZoneClear()"
            class="w-full" />
        </div>
      </div>

      <!-- Toggle filtros avanzados -->
      <div class="px-4 pb-3">
        <button type="button" (click)="showAdvanced.set(!showAdvanced())"
          class="text-xs font-bold text-content-muted hover:text-content-main transition-colors flex items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0">
          <i class="pi" [ngClass]="showAdvanced() ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
          Filtros avanzados
        </button>
      </div>

      <!-- Panel avanzado colapsable -->
      <div *ngIf="showAdvanced()" class="border-t border-divider grid grid-cols-1 sm:grid-cols-3 gap-3 p-4">
        <div class="flex flex-col gap-1">
          <label class="filter-label">Encargado</label>
          <p-select
            [options]="supervisors"
            [(ngModel)]="selectedSupervisorId"
            optionLabel="label" optionValue="value"
            [showClear]="true"
            placeholder="Todos"
            (onChange)="onSupervisorChange()"
            (onClear)="onSupervisorClear()"
            class="w-full" />
        </div>

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

        <div class="flex flex-col gap-1">
          <label class="filter-label">Marca</label>
          <p-select
            [options]="brands"
            [(ngModel)]="selectedBrand"
            optionLabel="label" optionValue="value"
            [showClear]="true"
            placeholder="Todas"
            (onChange)="onBrandChange()"
            (onClear)="onBrandClear()"
            class="w-full" />
        </div>
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
  readonly filtersChanged = output<void>();

  private filtersState = inject(FiltersStateService);
  private reportsService = inject(ReportsService);
  private authService = inject(AuthService);
  private perms = inject(PermissionsService);
  private dailyCaptureService = inject(DailyCaptureService);

  showAdvanced = signal(false);

  zones: DropOption[] = [{ label: 'Todas las zonas', value: null }];
  supervisors: DropOption[] = [{ label: 'Todos', value: null }];
  sellers: DropOption[] = [];
  brands: DropOption[] = [{ label: 'Todas las marcas', value: null }];

  periods: DropOption[] = [
    { label: 'Hoy', value: 'hoy' },
    { label: 'Semana', value: 'semanal' },
    { label: 'Quincena', value: 'quincenal' },
    { label: 'Mes', value: 'mensual' },
    { label: 'Personalizado', value: 'custom' },
  ];

  selectedPeriod = 'semanal';
  dateRange: Date[] = [];
  selectedZone: string | null = null;
  selectedSupervisorId: string | null = null;
  selectedSellerIds: string[] = [];
  selectedBrand: string | null = null;

  ngOnInit() {
    const f = this.filtersState.filters();
    this.selectedPeriod = f.period;
    this.selectedZone = f.zone;
    this.selectedSupervisorId = f.supervisorId;
    this.selectedSellerIds = f.sellerIds;
    this.selectedBrand = f.brand;

    this.loadZones();
    this.loadSupervisors();
    this.loadSellers();
    this.loadBrands();
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
    if (!this.perms.can('read', 'users')) {
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

  private loadBrands() {
    const groupedProducts = this.dailyCaptureService.groupedProducts();
    if (groupedProducts && groupedProducts.length > 0) {
      this.brands = [
        { label: 'Todas las marcas', value: null },
        ...groupedProducts.map((brand: any) => ({
          label: brand.marca || brand.name || brand.brand || brand.id,
          value: brand.marca || brand.name || brand.brand || brand.id
        }))
      ];
    }
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

  onZoneClear() {
    this.selectedZone = null;
    this.filtersState.setZone(null);
    this.emit();
  }

  onSupervisorChange() {
    this.filtersState.setSupervisor(this.selectedSupervisorId);
    this.emit();
  }

  onSupervisorClear() {
    this.selectedSupervisorId = null;
    this.filtersState.setSupervisor(null);
    this.emit();
  }

  onSellerChange() {
    this.filtersState.setSellers(this.selectedSellerIds);
    this.emit();
  }

  onBrandChange() {
    this.filtersState.setBrand(this.selectedBrand);
    this.emit();
  }

  onBrandClear() {
    this.selectedBrand = null;
    this.filtersState.setBrand(null);
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
    this.selectedBrand = f.brand;
    this.emit();
  }

  private emit() {
    this.filtersChanged.emit();
  }
}
