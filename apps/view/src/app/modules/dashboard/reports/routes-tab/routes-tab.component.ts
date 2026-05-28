import { Component, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../../../environments/environment';
import { FiltersStateService } from '../graphics/filters-state.service';
import { getChartTokens, colorForScore } from '../../../../shared/theme/chart-theme';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';

interface RouteExec {
  id: string;
  name: string;
  initials: string;
  v: number;
  s: number;
  sale: number;
}

interface RouteData {
  id: string;
  name: string;
  zona: string;
  visitas: number;
  score: number;
  venta: number;
  trend: string;
  execs: RouteExec[];
}

@Component({
  selector: 'app-routes-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, ButtonModule, TableModule, TagModule, SkeletonModule, ToastModule],
  templateUrl: './routes-tab.component.html',
  styleUrls: ['./routes-tab.component.css'],
})
export class RoutesTabComponent {
  private http = inject(HttpClient);
  private filtersState = inject(FiltersStateService);
  private msgService = inject(MessageService);

  loading = signal(false);
  data = signal<{ routes: RouteData[]; kpis: any } | null>(null);
  searchQuery = signal('');
  sortKey = signal<'score' | 'visitas' | 'venta'>('score');
  selectedRouteId = signal<string | null>(null);

  filteredRoutes = computed(() => {
    const routes = this.data()?.routes || [];
    const q = (this.searchQuery() || '').toLowerCase().trim();
    let filtered = q ? routes.filter(r => r.name.toLowerCase().includes(q)) : routes;
    const key = this.sortKey();
    return [...filtered].sort((a, b) => b[key] - a[key]);
  });

  selectedRoute = computed(() => {
    const id = this.selectedRouteId();
    if (!id) return null;
    return this.filteredRoutes().find(r => r.id === id) || null;
  });

  maxSortValue = computed(() => {
    const routes = this.filteredRoutes();
    const key = this.sortKey();
    return routes.length > 0 ? Math.max(...routes.map(r => r[key])) : 1;
  });

  avgScore = computed(() => {
    const execs = this.selectedRoute()?.execs || [];
    return execs.length > 0 ? Math.round(execs.reduce((s, e) => s + e.s, 0) / execs.length) : 0;
  });

  highCount = computed(() => (this.selectedRoute()?.execs || []).filter(e => e.s >= 80).length);
  midCount = computed(() => (this.selectedRoute()?.execs || []).filter(e => e.s >= 60 && e.s < 80).length);
  lowCount = computed(() => (this.selectedRoute()?.execs || []).filter(e => e.s < 60).length);

  private _filtersEffect = effect(() => {
    this.filtersState.filters();
    this.loadData();
  }, { allowSignalWrites: true });

  loadData() {
    this.loading.set(true);
    const f = this.filtersState.filters();
    let params = new HttpParams();
    if (f.startDate) params = params.set('startDate', f.startDate);
    if (f.endDate) params = params.set('endDate', f.endDate);
    if (f.zone) params = params.set('zone', f.zone);
    if (f.supervisorId) params = params.set('supervisorId', f.supervisorId);
    if (f.sellerIds?.length) f.sellerIds.forEach(id => { params = params.append('userIds', id); });

    this.http.get<any>(`${environment.apiUrl}/reports/routes`, { params }).subscribe({
      next: (res) => {
        this.data.set(res);
        this.loading.set(false);
        if (res.routes?.length > 0 && !this.selectedRouteId()) {
          this.selectedRouteId.set(res.routes[0].id);
        }
      },
      error: (err) => {
        this.loading.set(false);
        console.error('Error loading routes:', err);
        this.msgService.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las rutas.' });
      },
    });
  }

  selectRoute(id: string) {
    this.selectedRouteId.set(id);
  }

  setSort(key: 'score' | 'visitas' | 'venta') {
    this.sortKey.set(key);
  }

  formatTrend(t: string): string {
    return t.replace(/[+-]/g, '');
  }

  scoreColor(s: number): string {
    // Re-lee tokens en cada llamada (CD cycle) — los CSS vars resuelven al
    // tema vigente automáticamente.
    return colorForScore(getChartTokens(), s, { high: 80, mid: 60 });
  }

  fmtCurrency(n: number): string {
    return '$' + n.toLocaleString('es-MX');
  }
}
