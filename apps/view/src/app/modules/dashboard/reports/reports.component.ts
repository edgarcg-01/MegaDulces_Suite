import { Component, inject, signal, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ChartModule } from 'primeng/chart';
import { FormsModule } from '@angular/forms';
import { ReportsService, ReportsData } from './reports.service';
import { AuthService } from '../../../core/services/auth.service';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { TabsModule } from 'primeng/tabs';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [
    CommonModule,
    TableModule,
    TagModule,
    ButtonModule,
    SelectModule,
    DatePickerModule,
    ChartModule,
    FormsModule,
    ToastModule,
    TabsModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    MultiSelectModule,
    DialogModule,
    ImageModule,
  ],
  providers: [MessageService],
  template: `
    <div class="p-6 space-y-6">
      <!-- Header -->
      <div
        class="flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div>
          <h1 class="text-3xl font-bold tracking-tight text-content-main">
            Mercadeo Inteligente
          </h1>
          <p class="text-content-muted">
            Reportes avanzados y auditoría reactiva.
          </p>
        </div>
        <div class="flex gap-3">
          <p-button
            icon="pi pi-refresh"
            severity="secondary"
            styleClass="p-button-modern p-button-ghost"
            (onClick)="resetFilters()"
            [disabled]="loading()"
          />
          <p-button
            label="CSV"
            icon="pi pi-file-excel"
            severity="secondary"
            styleClass="p-button-modern"
            (onClick)="exportCsv()"
            [disabled]="loading()"
          />
          <p-button
            label="PDF"
            icon="pi pi-file-pdf"
            styleClass="p-button-modern p-button-brand"
            (onClick)="exportPdf()"
            [disabled]="loading()"
          />
        </div>
      </div>

      <!-- Filters -->
      <div
        class="bg-surface-card p-4 rounded-xl border border-divider shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4"
      >
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-bold text-content-faint uppercase"
            >Período</label
          >
          <p-select
            [options]="periodos"
            [(ngModel)]="selectedPeriod"
            (onChange)="onPeriodChange()"
            optionLabel="label"
            optionValue="value"
            placeholder="Seleccionar período"
            class="w-full"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-bold text-content-faint uppercase"
            >Fechas</label
          >
          <p-datepicker
            [(ngModel)]="dateRange"
            selectionMode="range"
            [showIcon]="true"
            class="w-full"
            (onSelect)="onDateChange()"
            (onBlur)="onDateChange()"
            [readonlyInput]="true"
            [showButtonBar]="true"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-bold text-content-faint uppercase"
            >Zona</label
          >
          <p-select
            [options]="zonas"
            [(ngModel)]="selectedZone"
            (onChange)="onZoneChange()"
            optionLabel="label"
            optionValue="value"
            placeholder="Todas las zonas"
            [showClear]="true"
            class="w-full"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-bold text-content-faint uppercase"
            >Encargado</label
          >
          <p-select
            [options]="supervisors"
            [(ngModel)]="selectedSupervisorId"
            (onChange)="onSupervisorChange()"
            optionLabel="label"
            optionValue="value"
            placeholder="Todos los encargados"
            [showClear]="true"
            class="w-full"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-bold text-content-faint uppercase"
            >Vendedor</label
          >
          <p-multiSelect
            [options]="filteredSellers"
            [(ngModel)]="selectedSellerIds"
            (onChange)="onSellerChange()"
            optionLabel="label"
            optionValue="value"
            placeholder="Todos los vendedores"
            [filter]="true"
            filterBy="label"
            display="chip"
            class="w-full"
          />
        </div>
      </div>

      <!-- Tabs -->
      <div class="modern-tabs-wrapper">
        <p-tabs [value]="0">
          <p-tablist>
            <p-tab [value]="0">Métricas</p-tab>
            <p-tab [value]="1">Registros</p-tab>
          </p-tablist>
          <p-tabpanels>
            <p-tabpanel [value]="0">
              <div class="pt-4 space-y-6" *ngIf="reportsData() as data">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div class="card-premium text-center">
                    <div class="text-content-faint text-xs font-bold uppercase">
                      Visitas
                    </div>
                    <div class="text-2xl font-bold text-content-main">
                      {{ data.metrics.totalVisitas }}
                    </div>
                  </div>
                  <div class="card-premium text-center font-bold">
                    <div class="text-content-faint text-xs font-bold uppercase">
                      Avg Score
                    </div>
                    <div class="text-2xl text-content-main">
                      {{ data.metrics.avgScore }}%
                    </div>
                  </div>
                  <div class="card-premium text-center font-bold">
                    <div class="text-content-faint text-xs font-bold uppercase">
                      Impacto Venta
                    </div>
                    <div class="text-2xl text-content-main">
                      {{ data.metrics.totalVentas | number }}
                    </div>
                  </div>
                </div>
                <div class="card-premium" style="height: 350px">
                  <p-chart
                    type="line"
                    [data]="chartData"
                    [options]="chartOptions"
                    height="100%"
                    *ngIf="chartData"
                  />
                </div>
              </div>
            </p-tabpanel>
            <p-tabpanel [value]="1">
              <div class="pt-4 space-y-4">
                <!-- Table Header / Search info -->
                <div class="flex items-center justify-between mb-2">
                  <p class="text-xs text-content-muted italic">
                    Desglose de visitas consolidadas por fecha.
                  </p>
                  <p-iconfield>
                    <p-inputicon class="pi pi-search" />
                    <input
                      pInputText
                      type="text"
                      [(ngModel)]="searchText"
                      placeholder="Buscar día o folio..."
                      (input)="dt.filterGlobal(searchText, 'contains')"
                    />
                  </p-iconfield>
                </div>

                <p-table
                  #dt
                  [value]="groupedRows() || []"
                  [paginator]="true"
                  [rows]="10"
                  dataKey="id"
                  [expandedRowKeys]="expandedRows"
                  styleClass="p-datatable-modern overflow-hidden rounded-2xl border border-divider"
                >
                  <ng-template pTemplate="header">
                    <tr
                      class="text-[10px] uppercase text-content-faint bg-surface-ground border-b border-divider"
                    >
                      <th style="width: 3rem"></th>
                      <th class="py-3 px-4">Jornada / Fecha</th>
                      <th class="text-center">Visitas</th>
                      <th class="text-center">Avg Score</th>
                      <th class="text-right pr-6">Total Venta</th>
                    </tr>
                  </ng-template>

                  <ng-template pTemplate="body" let-day let-expanded="expanded">
                    <tr
                      class="hover:bg-surface-hover cursor-pointer transition-colors"
                      (click)="toggleExpand(day)"
                    >
                      <td>
                        <button
                          type="button"
                          pButton
                          [pRowToggler]="day"
                          class="p-button-text p-button-rounded p-button-plain w-8 h-8 flex items-center justify-center p-0"
                          [icon]="
                            expanded
                              ? 'pi pi-chevron-down'
                              : 'pi pi-chevron-right'
                          "
                        ></button>
                      </td>
                      <td class="py-4 px-4 font-bold text-content-main">
                        <!-- Utilizamos 'UTC' para que no desplace la fecha 1 día atrás -->
                        {{ day.fecha | date: 'fullDate' : 'UTC' }}
                      </td>
                      <td class="text-center">
                        <span
                          class="bg-surface-active text-content-active px-2.5 py-0.5 rounded-full text-[10px] font-bold"
                          >{{ day.totalVisitas }}</span
                        >
                      </td>
                      <td class="text-center">
                        <div class="flex flex-col items-center">
                          <span class="font-black text-accent-brand"
                            >{{ day.avgScore }}%</span
                          >
                          <div
                            class="w-16 h-1 bg-surface-ground rounded-full mt-1 overflow-hidden"
                          >
                            <div
                              class="h-full bg-accent-brand"
                              [style.width]="day.avgScore + '%'"
                            ></div>
                          </div>
                        </div>
                      </td>
                      <td class="text-right pr-6 font-black text-accent-brand">
                        {{ day.totalVenta | number: '1.0-0' }}
                      </td>
                    </tr>
                  </ng-template>

                  <!-- ROW EXPANSION: Lista de visitas capturadas ese día -->
                  <ng-template pTemplate="rowexpansion" let-day>
                    <tr>
                      <td
                        colspan="5"
                        class="bg-surface-ground p-4 border-b border-surface-border"
                      >
                        <div
                          class="bg-surface-card rounded border border-surface-border shadow-sm overflow-hidden auto-mx"
                        >
                          <p-table
                            [value]="day.visits"
                            styleClass="p-datatable-sm p-datatable-striped"
                          >
                            <ng-template pTemplate="header">
                              <tr
                                class="text-[10px] uppercase text-content-muted bg-surface-ground border-b border-surface-border"
                              >
                                <th class="pl-4 py-2 w-24">Folio</th>
                                <th>Ejecutivo</th>
                                <th class="w-32">Zona</th>
                                <th class="text-center w-24">Score</th>
                                <th class="text-center w-24">Acción</th>
                              </tr>
                            </ng-template>
                            <ng-template pTemplate="body" let-visit>
                              <tr
                                class="text-xs hover:bg-surface-hover border-b border-surface-border last:border-0 cursor-pointer"
                                (click)="viewDetail(visit)"
                              >
                                <td class="pl-4 font-black text-content-main py-3">
                                  #{{ visit.folio }}
                                </td>
                                <td class="font-medium text-content-main">
                                  {{ visit.captured_by_username }}
                                </td>
                                <td>
                                  <span
                                    class="bg-surface-ground border border-surface-border px-2 py-0.5 rounded text-[9px] uppercase font-bold text-content-muted"
                                    >{{ visit.zona_captura }}</span
                                  >
                                </td>
                                <td
                                  class="text-center font-black text-content-main"
                                >
                                  {{ visit.stats?.puntuacionTotal }}%
                                </td>
                                <td class="text-center">
                                  <p-button
                                    icon="pi pi-eye"
                                    [text]="true"
                                    [rounded]="true"
                                    severity="info"
                                    size="small"
                                    (click)="
                                      viewDetail(visit);
                                      $event.stopPropagation()
                                    "
                                  />
                                </td>
                              </tr>
                            </ng-template>
                          </p-table>
                        </div>
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            </p-tabpanel>
          </p-tabpanels>
        </p-tabs>
      </div>

      <!-- VISIT MODAL -->
      <p-dialog
        header="Detalle Visita"
        [(visible)]="showDetail"
        [modal]="true"
        appendTo="body"
        [style]="{ width: '90vw', maxWidth: '600px' }"
        styleClass="surface-card border-divider rounded-2xl"
        [contentStyleClass]="'bg-surface-card text-content-main'"
      >
        <div *ngIf="selectedRow" class="space-y-4 pt-2">
          <div
            class="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-surface-ground p-4 rounded-2xl border border-surface-border gap-3"
          >
            <div>
              <div class="text-[10px] font-black text-content-faint uppercase tracking-widest">
                Visita Folio
              </div>
              <div class="text-xl font-black text-content-main">
                #{{ selectedRow.folio }}
              </div>
            </div>
            <p-button
              label="Exportar PDF"
              icon="pi pi-file-pdf"
              severity="success"
              styleClass="w-full sm:w-auto p-button-sm"
              (onClick)="exportSingleVisitPdf(selectedRow)"
            />
          </div>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div class="space-y-1">
              <p>
                <span class="text-content-muted">Ejecutivo:</span>
                <span class="font-bold text-content-main"
                  >{{ selectedRow.captured_by_username }}</span
                >
              </p>
              <p>
                <span class="text-content-muted">Zona:</span>
                <span class="font-bold text-content-main">{{ selectedRow.zona_captura }}</span>
              </p>
              <p>
                <span class="text-content-muted">Fecha:</span>
                <span class="font-bold text-content-main"
                  >{{ selectedRow.fecha | date: 'mediumDate' }}</span
                >
              </p>
              <p>
                <span class="text-content-muted">Hora Inicio:</span>
                <span class="font-bold text-content-main"
                  >{{ selectedRow.hora_inicio | date: 'shortTime' }}</span
                >
              </p>
              <p>
                <span class="text-content-muted">Hora Fin:</span>
                <span class="font-bold text-content-main"
                  >{{ selectedRow.hora_fin | date: 'shortTime' }}</span
                >
              </p>
            </div>
            <div
              class="bg-surface-active text-content-active p-4 rounded-2xl text-center flex flex-col justify-center shadow-lg border border-surface-border transition-all hover:scale-[1.02]"
            >
              <div
                class="text-[10px] opacity-70 uppercase font-black tracking-[0.2em] text-content-active"
              >
                Score Final
              </div>
              <div class="text-4xl font-black my-1">
                {{ selectedRow.stats?.puntuacionTotal }}%
              </div>
              <div class="text-[10px] font-bold opacity-80 uppercase">
                {{ selectedRow.exhibiciones?.length || 0 }} exhibiciones
              </div>
            </div>
          </div>

          <!-- Geolocation Card -->
          <div
            class="flex items-center justify-between p-4 border border-surface-border bg-surface-ground rounded-2xl shadow-sm"
          >
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-full bg-surface-hover flex items-center justify-center"
              >
                <i class="pi pi-map-marker text-content-main"></i>
              </div>
              <div>
                <div class="text-[10px] font-bold text-content-main uppercase">
                  Ubicación Geo-Referenciada
                </div>
                <div
                  class="text-xs text-content-dim font-mono"
                  *ngIf="selectedRow.latitud && selectedRow.longitud"
                >
                  {{ selectedRow.latitud | number: '1.6-6' }}, {{
                    selectedRow.longitud | number: '1.6-6'
                  }}
                </div>
                <div
                  class="text-xs text-content-faint font-bold"
                  *ngIf="!selectedRow.latitud"
                >
                  No se capturó GPS
                </div>
              </div>
            </div>
            <p-button
              *ngIf="selectedRow.latitud"
              label="Ver en Mapa"
              icon="pi pi-external-link"
              [text]="true"
              size="small"
              (onClick)="openMap(selectedRow.latitud, selectedRow.longitud)"
            />
          </div>
          <div class="border border-surface-border rounded-2xl overflow-hidden shadow-inner">
            <p-table
              [value]="selectedRow.exhibiciones || []"
              styleClass="p-datatable-sm"
            >
              <ng-template pTemplate="header">
                <tr class="text-[10px] bg-surface-ground uppercase text-content-muted">
                  <th>Concepto</th>
                  <th>Ubicación</th>
                  <th class="text-center">Imagen</th>
                  <th class="text-right pr-3">Puntuación</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-ex>
                <tr class="text-xs">
                  <td>{{ ex.conceptoId || 'N/A' }}</td>
                  <td>{{ ex.ubicacionId || 'N/A' }}</td>
                  <td class="text-center">
                    <p-image 
                      *ngIf="ex.fotoUrl"
                      [src]="getImageUrl(ex.fotoUrl)" 
                      alt="Exhibición" 
                      width="50"
                      [preview]="true"
                      class="rounded shadow-sm cursor-zoom-in"
                    />
                    <span *ngIf="!ex.fotoUrl" class="text-[9px] text-content-faint">Sin foto</span>
                  </td>
                  <td class="text-right pr-3 font-bold">
                    {{ ex.puntuacionCalculada || 0 }}
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        </div>
      </p-dialog>
      <p-toast />
    </div>
  `,
  styles: [
    `
      :host ::ng-deep .p-datatable-sm .p-datatable-tbody > tr > td {
        padding: 0.5rem;
      }
      :host ::ng-deep .p-tablist-tablist {
        border-bottom: 2px solid var(--surface-border);
      }
      :host ::ng-deep .p-button.p-button-info {
        color: var(--content-muted);
        background: transparent;
        border: none;
      }
      :host ::ng-deep .p-button.p-button-info:hover {
        color: var(--content-main);
        background: var(--surface-hover);
      }
    `,
  ],
})
export class ReportsComponent implements OnInit {
  private reportsService = inject(ReportsService);
  private auth = inject(AuthService);
  private messageService = inject(MessageService);

  dateRange: Date[] | undefined;
  selectedPeriod = 'semanal';
  selectedZone: string | null = null;
  selectedUserIds: string[] = [];
  searchText = '';

  reportsData = signal<ReportsData | null>(null);

  // Agrupación jerárquica por día (Desglose solicitado)
  groupedRows = computed(() => {
    const data = this.reportsData();
    if (!data || !data.rows) return [];

    const groups: Record<string, any> = {};
    data.rows.forEach((row) => {
      // Normalizar fecha para obtener YYYY-MM-DD exacto y evitar desplazamiento UTC
      let dStr =
        typeof row.fecha === 'string'
          ? row.fecha.split('T')[0]
          : row.fecha instanceof Date
            ? row.fecha.toISOString().split('T')[0]
            : row.fecha;

      if (!groups[dStr]) {
        groups[dStr] = {
          id: dStr,
          fecha: dStr,
          totalVisitas: 0,
          puntosAcumulados: 0,
          totalVenta: 0,
          visits: [],
        };
      }
      groups[dStr].visits.push(row);
      groups[dStr].totalVisitas += 1;
      groups[dStr].puntosAcumulados += row.stats?.puntuacionTotal || 0;
      groups[dStr].totalVenta += row.stats?.ventaTotal || 0;
    });

    return Object.values(groups)
      .map((day: any) => ({
        ...day,
        avgScore:
          day.visits.length > 0
            ? (day.puntosAcumulados / day.visits.length).toFixed(1)
            : 0,
      }))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  });

  selectedRow: any = null;
  showDetail = false;
  expandedRows: { [key: string]: boolean } = {};
  loading = signal(false);

  allUsers: any[] = [];
  filteredUsers: any[] = [];
  allZones: any[] = [];
  zonas: { label: string; value: string | null }[] = [{ label: 'Todas las Zonas', value: null }];

  // Filtros separados: Encargados y Vendedores
  supervisors: any[] = [];
  allSellers: any[] = [];
  filteredSellers: any[] = [];
  selectedSupervisorId: string | null = null;
  selectedSellerIds: string[] = [];

  periodos = [
    { label: 'Hoy', value: 'hoy' },
    { label: 'Semana', value: 'semanal' },
    { label: 'Quincena', value: 'quincenal' },
    { label: 'Mes', value: 'mensual' },
    { label: 'Personalizado', value: 'custom' },
  ];

  isSuperAdmin = signal(false);
  chartData: any;
  chartOptions: any;

  ngOnInit() {
    const user = this.auth.user();
    this.isSuperAdmin.set(user?.role_name === 'superadmin');
    this.loadZones();
    this.loadUsers();
    this.applyPeriodPreset();
    this.loadData();
    this.initChartConfig();
  }

  loadZones() {
    this.reportsService.getZones().subscribe({
      next: (zones) => {
        console.log('Zonas cargadas:', zones);
        this.allZones = zones;
        this.zonas = [
          { label: 'Todas las Zonas', value: null },
          ...zones.map((z: any) => ({
            label: z.value,
            value: z.value as string | null,
          })),
        ];
        console.log('Zonas mapeadas:', this.zonas);
      },
      error: (err) => {
        console.error('Error cargando zonas:', err);
        // Fallback a zonas estáticas si falla la carga
        this.zonas = [
          { label: 'Todas las Zonas', value: null },
          { label: 'Norte', value: 'Norte' as string | null },
          { label: 'Centro', value: 'Centro' as string | null },
          { label: 'Sur', value: 'Sur' as string | null },
        ];
      },
    });
  }

  loadUsers() {
    // Cargar supervisores y vendedores por separado
    this.loadSupervisors();
    this.loadSellers();
  }

  loadSupervisors() {
    const zona = this.selectedZone || undefined;
    console.log('[loadSupervisors] Cargando supervisores, zona:', zona);

    this.reportsService.getSupervisors(zona).subscribe({
      next: (supervisors) => {
        console.log('[loadSupervisors] Respuesta:', supervisors);
        this.supervisors = [
          { label: 'Todos los encargados', value: null },
          ...supervisors.map((s: any) => ({
            label: `${s.username}`,
            value: s.id,
            zona: s.zona,
          })),
        ];
        console.log('[loadSupervisors] Mapeado:', this.supervisors);
      },
      error: (err) => {
        console.error('[loadSupervisors] Error:', err);
        this.supervisors = [{ label: 'Todos los encargados', value: null }];
      },
    });
  }

  loadSellers() {
    const zona = this.selectedZone || undefined;
    const supervisorId = this.selectedSupervisorId || undefined;
    console.log('[loadSellers] Cargando vendedores, zona:', zona, 'supervisorId:', supervisorId);

    this.reportsService.getSellers(zona, supervisorId).subscribe({
      next: (sellers) => {
        console.log('[loadSellers] Respuesta:', sellers);
        this.allSellers = sellers.map((s: any) => ({
          label: `${s.username}`,
          value: s.id,
          zona: s.zona,
          supervisor_id: s.supervisor_id,
        }));
        console.log('[loadSellers] Mapeado:', this.allSellers);
        this.updateFilteredSellers();
      },
      error: (err) => {
        console.error('[loadSellers] Error:', err);
        this.allSellers = [];
        this.filteredSellers = [];
      },
    });
  }

  updateFilteredSellers() {
    // Si hay un supervisor seleccionado, filtrar vendedores por ese supervisor
    if (this.selectedSupervisorId) {
      this.filteredSellers = this.allSellers.filter(
        (s) => s.supervisor_id === this.selectedSupervisorId,
      );
    } else {
      this.filteredSellers = [...this.allSellers];
    }
    // Limpiar vendedores seleccionados que ya no están en la lista filtrada
    this.selectedSellerIds = this.selectedSellerIds.filter((id) =>
      this.filteredSellers.find((s) => s.value === id),
    );
  }

  onSupervisorChange() {
    // Cuando cambia el supervisor, recargar vendedores y actualizar filtro
    this.loadSellers();
    this.loadData();
  }

  onSellerChange() {
    this.loadData();
  }

  // Legacy method - mantener para compatibilidad
  updateFilteredUsers() {
    // Actualizar vendedores filtrados
    this.updateFilteredSellers();
  }

  resetFilters() {
    this.selectedPeriod = 'semanal';
    this.selectedZone = null;
    this.selectedSupervisorId = null;
    this.selectedSellerIds = [];
    this.applyPeriodPreset();
    this.loadSupervisors();
    this.loadSellers();
    this.loadData();
  }

  initChartConfig() {
    this.chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: true, grid: { display: false } },
        y: { display: true, beginAtZero: true },
      },
    };
  }

  applyPeriodPreset() {
    const end = new Date();
    const start = new Date();
    switch (this.selectedPeriod) {
      case 'hoy':
        break;
      case 'semanal':
        start.setDate(end.getDate() - 7);
        break;
      case 'quincenal':
        start.setDate(end.getDate() - 15);
        break;
      case 'mensual':
        start.setDate(end.getDate() - 30);
        break;
      case 'custom':
        return;
    }
    this.dateRange = [start, end];
  }

  onPeriodChange() {
    if (this.selectedPeriod !== 'custom') {
      this.applyPeriodPreset();
      this.loadData();
    }
  }

  onZoneChange() {
    // Cuando cambia la zona, recargar supervisores y vendedores filtrados por zona
    this.loadSupervisors();
    this.loadSellers();
    this.loadData();
  }

  onUserChange() {
    // Legacy - redirigir a onSellerChange
    this.onSellerChange();
  }

  onDateChange() {
    if (!this.dateRange || (this.dateRange[0] && this.dateRange[1])) {
      this.loadData();
    }
  }

  loadData() {
    if (!this.dateRange || !this.dateRange[0]) return;
    this.loading.set(true);

    // Combinar IDs: si hay vendedores seleccionados, usarlos. Si no, usar el filtro legacy
    const userIds = this.selectedSellerIds.length > 0
      ? this.selectedSellerIds
      : this.selectedUserIds;

    const filters = {
      startDate: this.dateRange[0].toLocaleDateString('en-CA'),
      endDate:
        this.dateRange[1]?.toLocaleDateString('en-CA') ||
        this.dateRange[0].toLocaleDateString('en-CA'),
      zone: this.selectedZone,
      supervisorId: this.selectedSupervisorId,
      sellerIds: this.selectedSellerIds,
      userIds: userIds, // Legacy support
    };
    this.reportsService.getReportsData(filters).subscribe({
      next: (data: ReportsData) => {
        this.reportsData.set(data);
        this.updateChart(data);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  updateChart(data: ReportsData) {
    this.chartData = {
      labels: data.trendData.map((d: any) => d.date),
      datasets: [
        {
          label: 'Visitas',
          data: data.trendData.map((d: any) => d.visits),
          borderColor: 'var(--content-main)',
          backgroundColor: 'var(--content-main)',
          tension: 0.4,
        },
        {
          label: 'Score',
          data: data.trendData.map((d: any) => d.avgScore),
          borderColor: 'var(--content-dim)',
          backgroundColor: 'var(--content-dim)',
          tension: 0.4,
        },
      ],
    };
  }

  viewDetail(row: any) {
    console.log('Detalles de la visita:', row);
    console.log('GPS data - Latitud:', row.latitud, 'Longitud:', row.longitud);
    this.selectedRow = row;
    this.showDetail = true;
  }

  toggleExpand(day: any) {
    if (this.expandedRows[day.id]) {
      delete this.expandedRows[day.id];
    } else {
      this.expandedRows[day.id] = true;
    }
    this.expandedRows = { ...this.expandedRows }; // trigger cd
  }

  exportCsv() {
    if (!this.dateRange || !this.dateRange[0]) return;
    const filters = {
      startDate: this.dateRange[0].toLocaleDateString('en-CA'),
      endDate:
        this.dateRange[1]?.toLocaleDateString('en-CA') ||
        this.dateRange[0].toLocaleDateString('en-CA'),
      zone: this.selectedZone,
      userIds: this.selectedUserIds,
    };
    (this.reportsService as any).exportCsv(filters).subscribe((blob: Blob) => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'reporte.csv';
      a.click();
    });
  }

  exportPdf() {
    const data = this.reportsData();
    if (!data) return;
    const doc = new jsPDF();
    doc.text('Reporte Detailado', 14, 20);
    autoTable(doc, {
      startY: 30,
      head: [['Folio', 'User', 'Score', 'Venta']],
      body: data.rows.map((r: any) => [
        r.folio,
        r.captured_by_username,
        r.stats?.puntuacionTotal,
        r.stats?.ventaTotal,
      ]),
    });
    doc.save('reporte.pdf');
  }

  exportSingleVisitPdf(row: any) {
    const doc = new jsPDF();
    doc.text(`Visita #${row.folio}`, 14, 20);

    // Información básica
    autoTable(doc, {
      startY: 30,
      body: [
        ['User', row.captured_by_username],
        ['Zone', row.zona_captura],
        ['Fecha', new Date(row.fecha).toLocaleDateString()],
        ['Hora Inicio', new Date(row.hora_inicio).toLocaleTimeString()],
        ['Hora Fin', new Date(row.hora_fin).toLocaleTimeString()],
        ['Score', row.stats?.puntuacionTotal + '%'],
        ['Venta Total', '$' + (row.stats?.ventaTotal || 0)],
        ['Total Exhibiciones', row.exhibiciones?.length || 0],
        [
          'GPS',
          row.latitud
            ? `${row.latitud.toFixed(6)}, ${row.longitud.toFixed(6)}`
            : 'No capturado',
        ],
      ],
    });

    // Exhibiciones si existen
    if (row.exhibiciones && row.exhibiciones.length > 0) {
      doc.text('Exhibiciones:', 14, (doc as any).lastAutoTable.finalY + 20);
      autoTable(doc, {
        startY: (doc as any).lastAutoTable.finalY + 30,
        head: [['Concepto', 'Ubicación', 'Puntuación']],
        body: row.exhibiciones.map((ex: any) => [
          ex.conceptoId || 'N/A',
          ex.ubicacionId || 'N/A',
          ex.puntuacionCalculada || 0,
        ]),
      });
    }

    doc.save(`visita_${row.folio}.pdf`);
  }

  openMap(lat: number, lng: number) {
    const url = `https://www.google.com/maps?q=${lat},${lng}`;
    
    // Detectar si es móvil para evitar bloqueos de ventanas emergentes o pantallas en blanco
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (isMobile) {
      // En móvil, es más seguro redirigir la pestaña actual o usar un enlace directo
      window.location.href = url;
    } else {
      window.open(url, '_blank');
    }
  }

  getImageUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    // Si empieza con '/', asumir que es relativo a la API
    const apiBase = (this.reportsService as any).apiUrl.replace('/reports', ''); // Obtener base URL
    return `${apiBase}${url}`;
  }
}
