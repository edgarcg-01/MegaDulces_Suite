import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatePickerModule } from 'primeng/datepicker';
import { TooltipModule } from 'primeng/tooltip';

interface StatusFilter { key: string; label: string; }
interface DatePreset { key: string; label: string; }

/**
 * Barra de filtros de pedidos: chips por status (con counts) + presets de fecha +
 * date range + búsqueda de folio + reset. Presentacional puro — el padre es dueño
 * del estado (signals/fields) y de la lógica; el hijo emite eventos. Extraído de
 * comercial-orders (CV.3). No usa two-way: one-way inputs + outputs.
 */
@Component({
  selector: 'app-order-filters',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePickerModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sheet cols-12">
      <article class="cell cell-span-12 is-flush co-filters-cell">
        <!-- Row 1: status chips -->
        <nav class="co-chips" role="tablist" aria-label="Filtrar por estado">
          <button
            *ngFor="let f of filters"
            type="button"
            class="co-chip"
            [class.active]="statusFilter === f.key"
            role="tab"
            [attr.aria-selected]="statusFilter === f.key"
            (click)="statusChange.emit(f.key)"
          >
            <span>{{ f.label }}</span>
            <span class="co-chip-count" *ngIf="statusCounts[f.key] !== undefined">
              {{ statusCounts[f.key] }}
            </span>
          </button>
        </nav>

        <!-- Row 2: toolbar compacta — presets · date range · search · reset -->
        <div class="co-toolbar">
          <!-- Presets segment -->
          <div class="co-segment" role="group" aria-label="Rango de fechas">
            <button
              *ngFor="let p of presets"
              type="button"
              class="co-seg-btn"
              [class.active]="datePreset === p.key"
              (click)="presetChange.emit(p.key)"
            >{{ p.label }}</button>
          </div>

          <!-- Date range inline: from → to -->
          <div class="co-daterange" role="group" aria-label="Rango personalizado">
            <i class="pi pi-calendar co-daterange-icon" aria-hidden="true"></i>
            <p-datepicker
              [ngModel]="fromDate"
              (ngModelChange)="fromDateChange.emit($event)"
              dateFormat="dd/mm/yy"
              [showClear]="false"
              placeholder="Desde"
              appendTo="body"
              styleClass="co-date-input"
            ></p-datepicker>
            <i class="pi pi-arrow-right co-daterange-arrow" aria-hidden="true"></i>
            <p-datepicker
              [ngModel]="toDate"
              (ngModelChange)="toDateChange.emit($event)"
              dateFormat="dd/mm/yy"
              [showClear]="false"
              placeholder="Hasta"
              appendTo="body"
              styleClass="co-date-input"
            ></p-datepicker>
          </div>

          <!-- Spacer -->
          <div class="co-toolbar-spacer"></div>

          <!-- Search folio -->
          <div class="co-search">
            <i class="pi pi-search co-search-icon" aria-hidden="true"></i>
            <input
              type="search"
              [ngModel]="folioSearch"
              (ngModelChange)="searchChange.emit($event)"
              placeholder="Buscar folio (PD-2026-…)"
              inputmode="search"
              autocomplete="off"
              autocapitalize="characters"
              aria-label="Buscar por folio"
            />
            <button
              *ngIf="folioSearch"
              type="button"
              class="co-search-clear"
              (click)="clearSearch.emit()"
              aria-label="Limpiar búsqueda"
            >
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>

          <!-- Reset si hay filtros activos -->
          <button
            *ngIf="hasActiveFilters"
            type="button"
            class="co-reset"
            (click)="resetFilters.emit()"
            pTooltip="Limpiar todos los filtros"
          >
            <i class="pi pi-refresh" aria-hidden="true"></i>
            <span>Reset</span>
          </button>
        </div>
      </article>
    </div>
  `,
  styles: [`
    /* ── FILTERS CELL: chips arriba + toolbar abajo ──
       Estos estilos viven aquí (no en el padre): con encapsulación emulada los
       estilos del padre no alcanzan el DOM de este componente. ── */
    .co-filters-cell { display: flex; flex-direction: column; }

    .co-chips {
      display: flex;
      gap: .375rem;
      flex-wrap: wrap;
      align-items: center;
      padding: .625rem .875rem;
      border-bottom: 1px solid var(--c-divider);
    }
    .co-chip {
      flex-shrink: 0;
      height: 28px;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 999px;
      padding: 0 .65rem;
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: .375rem;
      transition: all 120ms var(--ease-standard);
    }
    .co-chip:hover {
      border-color: var(--c-text-3);
      color: var(--c-text-1);
      background: var(--c-surface-2);
    }
    .co-chip.active {
      background: var(--c-text-1);
      border-color: var(--c-text-1);
      color: var(--c-surface-1);
    }
    .co-chip-count {
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-micro);
      font-weight: var(--fw-bold);
      padding: .05rem .4rem;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
      min-width: 18px;
      text-align: center;
    }
    .co-chip.active .co-chip-count {
      background: rgba(255,255,255,.20);
      color: var(--c-surface-1);
    }

    .co-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .co-toolbar-spacer { flex: 1; min-width: 0; }

    .co-segment {
      display: inline-flex;
      align-items: stretch;
      height: 32px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }
    .co-seg-btn {
      background: transparent;
      border: none;
      padding: 0 .65rem;
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      border-radius: 6px;
      transition: all 100ms var(--ease-standard);
      white-space: nowrap;
    }
    .co-seg-btn:hover { color: var(--c-text-1); }
    .co-seg-btn.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }

    .co-daterange {
      display: inline-flex;
      align-items: center;
      height: 32px;
      gap: .25rem;
      padding: 0 .5rem;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      transition: border-color 120ms var(--ease-standard);
    }
    .co-daterange:focus-within {
      border-color: var(--action);
      box-shadow: 0 0 0 3px var(--action-ring);
    }
    .co-daterange-icon { color: var(--c-text-3); font-size: var(--fs-sm); }
    .co-daterange-arrow { color: var(--c-text-3); font-size: var(--fs-xs); padding: 0 .15rem; }
    :host ::ng-deep .co-date-input.p-datepicker { width: 90px; }
    :host ::ng-deep .co-date-input.p-datepicker .p-inputtext,
    :host ::ng-deep .co-date-input.p-datepicker input {
      border: none !important;
      background: transparent !important;
      padding: 0 !important;
      height: 28px !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      box-shadow: none !important;
      width: 100%;
    }
    :host ::ng-deep .co-date-input.p-datepicker input::placeholder { color: var(--c-text-3); }
    :host ::ng-deep .co-date-input.p-datepicker .p-datepicker-trigger { display: none !important; }

    .co-search {
      display: inline-flex;
      align-items: center;
      height: 32px;
      width: 240px;
      max-width: 100%;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .co-search:focus-within {
      border-color: var(--action);
      box-shadow: 0 0 0 3px var(--action-ring);
    }
    .co-search-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    .co-search input {
      flex: 1;
      border: none;
      background: transparent;
      outline: none;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      min-width: 0;
      padding: 0;
      height: 28px;
    }
    .co-search input::placeholder { color: var(--c-text-3); }
    .co-search-clear {
      background: transparent;
      border: none;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      color: var(--c-text-3);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      font-size: var(--fs-xs);
    }
    .co-search-clear:hover { color: var(--c-text-1); background: var(--c-surface-2); }

    .co-reset {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      height: 32px;
      padding: 0 .75rem;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      cursor: pointer;
      transition: all 120ms var(--ease-standard);
    }
    .co-reset:hover { color: var(--c-text-1); border-color: var(--c-text-1); background: var(--c-surface-2); }
    .co-reset i { font-size: var(--fs-xs); }

    @media (max-width: 640px) {
      .co-toolbar { gap: .5rem; }
      .co-toolbar-spacer { display: none; }
      .co-search { width: 100%; }
      .co-daterange { flex: 1; }
    }
  `],
})
export class OrderFiltersComponent {
  @Input() filters: StatusFilter[] = [];
  @Input() statusFilter = 'all';
  @Input() statusCounts: Record<string, number> = {};
  @Input() presets: DatePreset[] = [];
  @Input() datePreset = 'all';
  @Input() fromDate: Date | null = null;
  @Input() toDate: Date | null = null;
  @Input() folioSearch = '';
  @Input() hasActiveFilters = false;

  @Output() statusChange = new EventEmitter<string>();
  @Output() presetChange = new EventEmitter<string>();
  @Output() fromDateChange = new EventEmitter<Date | null>();
  @Output() toDateChange = new EventEmitter<Date | null>();
  @Output() searchChange = new EventEmitter<string>();
  @Output() clearSearch = new EventEmitter<void>();
  @Output() resetFilters = new EventEmitter<void>();
}
