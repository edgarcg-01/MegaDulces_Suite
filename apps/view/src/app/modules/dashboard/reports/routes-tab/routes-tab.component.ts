import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../../../environments/environment';
import { FiltersStateService } from '../graphics/filters-state.service';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';

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
  imports: [CommonModule, FormsModule, InputTextModule, ButtonModule, TableModule, TagModule, SkeletonModule],
  templateUrl: './routes-tab.component.html',
  styleUrls: ['./routes-tab.component.css'],
})
export class RoutesTabComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private filtersState = inject(FiltersStateService);

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

  ngOnInit() {
    this.loadData();
  }

  ngOnDestroy() {}

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
      error: () => { this.loading.set(false); },
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
    if (s >= 80) return '#1D9E75';
    if (s >= 60) return '#EF9F27';
    return '#E24B4A';
  }

  fmtCurrency(n: number): string {
    return '$' + n.toLocaleString('es-MX');
  }
}
