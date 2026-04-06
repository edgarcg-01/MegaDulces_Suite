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
            class="w-full"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] font-bold text-content-faint uppercase"
            >Ejecutivos</label
          >
          <p-multiSelect
            [options]="filteredUsers"
            [(ngModel)]="selectedUserIds"
            display="chip"
            class="w-full"
            (onChange)="onUserChange()"
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
                      \${{ data.metrics.totalVisitas }}
                    </div>
                  </div>
                  <div class="card-premium text-center font-bold">
                    <div class="text-content-faint text-xs font-bold uppercase">
                      Avg Score
                    </div>
                    <div class="text-2xl text-accent-brand">
                      \${{ data.metrics.avgScore }}%
                    </div>
                  </div>
                  <div class="card-premium text-center font-bold">
                    <div class="text-content-faint text-xs font-bold uppercase">
                      Impacto Venta
                    </div>
                    <div class="text-2xl text-accent-brand">
                      \${{ data.metrics.totalVentas | number }}
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
                  styleClass="p-datatable-modern overflow-hidden rounded-xl border border-divider"
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
                        \${{ day.fecha | date: 'fullDate' : 'UTC' }}
                      </td>
                      <td class="text-center">
                        <span
                          class="bg-surface-active text-content-active px-2.5 py-0.5 rounded-full text-[10px] font-bold"
                          >\${{ day.totalVisitas }}</span
                        >
                      </td>
                      <td class="text-center">
                        <div class="flex flex-col items-center">
                          <span class="font-black text-accent-brand"
                            >\${{ day.avgScore }}%</span
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
                        \${{ day.totalVenta | number: '1.0-0' }}
                      </td>
                    </tr>
                  </ng-template>

                  <!-- ROW EXPANSION: Lista de visitas capturadas ese día -->
                  <ng-template pTemplate="rowexpansion" let-day>
                    <tr>
                      <td
                        colspan="5"
                        class="bg-zinc-100 p-4 border-b border-zinc-200"
                      >
                        <div
                          class="bg-white rounded border border-zinc-200 shadow-sm overflow-hidden auto-mx"
                        >
                          <p-table
                            [value]="day.visits"
                            styleClass="p-datatable-sm p-datatable-striped"
                          >
                            <ng-template pTemplate="header">
                              <tr
                                class="text-[10px] uppercase text-zinc-500 bg-zinc-50 border-b"
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
                                class="text-xs hover:bg-zinc-50 border-b border-zinc-100 last:border-0 cursor-pointer"
                                (click)="viewDetail(visit)"
                              >
                                <td class="pl-4 font-black text-zinc-700 py-3">
                                  #\${{ visit.folio }}
                                </td>
                                <td class="font-medium text-zinc-900">
                                  \${{ visit.captured_by_username }}
                                </td>
                                <td>
                                  <span
                                    class="bg-zinc-200 px-2 py-0.5 rounded text-[9px] uppercase font-bold text-zinc-600"
                                    >\${{ visit.zona_captura }}</span
                                  >
                                </td>
                                <td
                                  class="text-center font-black"
                                  [ngClass]="
                                    visit.stats?.puntuacionTotal >= 80
                                      ? 'text-emerald-600'
                                      : 'text-amber-600'
                                  "
                                >
                                  \${{ visit.stats?.puntuacionTotal }}%
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
        [style]="{ width: '35rem' }"
      >
        <div *ngIf="selectedRow" class="space-y-4 pt-2">
          <div
            class="flex justify-between items-center bg-zinc-50 p-3 rounded-lg border"
          >
            <div>
              <div class="text-[10px] font-bold text-zinc-400 uppercase">
                Visita Folio
              </div>
              <div class="text-lg font-bold text-blue-600">
                #\${{ selectedRow.folio }}
              </div>
            </div>
            <p-button
              label="Exportar PDF"
              icon="pi pi-file-pdf"
              (onClick)="exportSingleVisitPdf(selectedRow)"
            />
          </div>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div class="space-y-1">
              <p>
                <span class="text-zinc-500">Ejecutivo:</span>
                <span class="font-bold"
                  >\${{ selectedRow.captured_by_username }}</span
                >
              </p>
              <p>
                <span class="text-zinc-500">Zona:</span>
                <span class="font-bold">\${{ selectedRow.zona_captura }}</span>
              </p>
              <p>
                <span class="text-zinc-500">Fecha:</span>
                <span class="font-bold"
                  >\${{ selectedRow.fecha | date: 'mediumDate' }}</span
                >
              </p>
              <p>
                <span class="text-zinc-500">Hora Inicio:</span>
                <span class="font-bold"
                  >\${{ selectedRow.hora_inicio | date: 'shortTime' }}</span
                >
              </p>
              <p>
                <span class="text-zinc-500">Hora Fin:</span>
                <span class="font-bold"
                  >\${{ selectedRow.hora_fin | date: 'shortTime' }}</span
                >
              </p>
            </div>
            <div
              class="bg-zinc-900 text-white p-3 rounded-xl text-center flex flex-col justify-center shadow-lg"
            >
              <div
                class="text-[10px] opacity-70 uppercase font-black tracking-widest text-emerald-400"
              >
                Score Final
              </div>
              <div class="text-3xl font-black">
                \${{ selectedRow.stats?.puntuacionTotal }}%
              </div>
              <div class="text-xs opacity-80 mt-1">
                \${{ selectedRow.exhibiciones?.length || 0 }} exhibiciones
              </div>
            </div>
          </div>

          <!-- Geolocation Card -->
          <div
            class="flex items-center justify-between p-3 border border-blue-100 bg-blue-50/50 rounded-xl"
          >
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center"
              >
                <i class="pi pi-map-marker text-blue-600"></i>
              </div>
              <div>
                <div class="text-[10px] font-bold text-blue-600 uppercase">
                  Ubicación Geo-Referenciada
                </div>
                <div
                  class="text-xs text-blue-500 font-mono"
                  *ngIf="selectedRow.latitud && selectedRow.longitud"
                >
                  \${{ selectedRow.latitud | number: '1.6-6' }}, \${{
                    selectedRow.longitud | number: '1.6-6'
                  }}
                </div>
                <div
                  class="text-xs text-amber-600 font-bold"
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
          <div class="border rounded-lg overflow-hidden">
            <p-table
              [value]="selectedRow.exhibiciones || []"
              styleClass="p-datatable-sm"
            >
              <ng-template pTemplate="header">
                <tr class="text-[10px] bg-zinc-50 uppercase">
                  <th>Concepto</th>
                  <th>Ubicación</th>
                  <th class="text-right pr-3">Puntuación</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-ex>
                <tr class="text-xs">
                  <td>\${{ ex.conceptoId || 'N/A' }}</td>
                  <td>\${{ ex.ubicacionId || 'N/A' }}</td>
                  <td class="text-right pr-3 font-bold">
                    \${{ ex.puntuacionCalculada || 0 }}
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
        border-bottom: 2px solid #e5e7eb;
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

  zonas = [
    { label: 'Todas las Zonas', value: null },
    { label: 'Norte', value: 'Norte' },
    { label: 'Centro', value: 'Centro' },
    { label: 'Sur', value: 'Sur' },
  ];

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
    this.isSuperAdmin.set(user?.rol === 'superadmin');
    this.loadUsers();
    this.applyPeriodPreset();
    this.loadData();
    this.initChartConfig();
  }

  loadUsers() {
    this.reportsService.getUsers().subscribe((users) => {
      this.allUsers = users.map((u) => ({
        label: u.nombre,
        value: u.id,
        zona: u.zona,
      }));
      this.updateFilteredUsers();
    });
  }

  updateFilteredUsers() {
    if (!this.selectedZone) {
      this.filteredUsers = [...this.allUsers];
    } else {
      this.filteredUsers = this.allUsers.filter(
        (u) => u.zona === this.selectedZone,
      );
    }
    this.selectedUserIds = this.selectedUserIds.filter((id) =>
      this.filteredUsers.find((u) => u.value === id),
    );
  }

  resetFilters() {
    this.selectedPeriod = 'semanal';
    this.selectedZone = null;
    this.selectedUserIds = [];
    this.applyPeriodPreset();
    this.updateFilteredUsers();
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
    this.updateFilteredUsers();
    this.loadData();
  }

  onUserChange() {
    this.loadData();
  }

  onDateChange() {
    if (!this.dateRange || (this.dateRange[0] && this.dateRange[1])) {
      this.loadData();
    }
  }

  loadData() {
    if (!this.dateRange || !this.dateRange[0]) return;
    this.loading.set(true);
    const filters = {
      startDate: this.dateRange[0].toLocaleDateString('en-CA'),
      endDate:
        this.dateRange[1]?.toLocaleDateString('en-CA') ||
        this.dateRange[0].toLocaleDateString('en-CA'),
      zone: this.selectedZone,
      userIds: this.selectedUserIds,
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
          borderColor: '#2563eb',
          tension: 0.4,
        },
        {
          label: 'Score',
          data: data.trendData.map((d: any) => d.avgScore),
          borderColor: '#059669',
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
    window.open(url, '_blank');
  }
}
