import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../../../environments/environment';
import { FiltersStateService } from '../graphics/filters-state.service';

@Component({
  selector: 'app-stores-tab',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, TagModule, ButtonModule,
    SelectModule, InputTextModule,
  ],
  templateUrl: './stores-tab.component.html',
  styleUrls: ['./stores-tab.component.css'],
})
export class StoresTabComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private filtersState = inject(FiltersStateService);

  loading = signal(false);
  data = signal<any>(null);
  searchQuery = signal('');

  filteredStores = computed(() => {
    const stores = this.data()?.stores || [];
    const q = (this.searchQuery() || '').toLowerCase().trim();
    if (!q) return stores;
    return stores.filter((s: any) =>
      s.nombre?.toLowerCase().includes(q) ||
      s.zona?.toLowerCase().includes(q)
    );
  });

  // ── Mini-rings de las KPI cards ─────────────────────────────────
  readonly RING_C = 2 * Math.PI * 16;
  /** stroke-dasharray del arco según % (clamp 0–100). */
  ringDash(pct: number): string {
    const p = Math.max(0, Math.min(100, pct || 0));
    return `${(p / 100) * this.RING_C} ${this.RING_C}`;
  }
  /** % de una fracción parte/total (clamp). */
  fracPct(part: number, total: number): number {
    return total > 0 ? Math.min(100, (part / total) * 100) : 0;
  }
  scoreSev(score: number): 'ok' | 'warn' | 'bad' {
    return score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
  }
  surtidoSev(v: number): 'ok' | 'warn' | 'bad' {
    return v >= 3 ? 'ok' : v >= 1 ? 'warn' : 'bad';
  }

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

    this.http.get<any>(`${environment.apiUrl}/reports/stores`, { params }).subscribe({
      next: (res) => {
        this.data.set(res);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      }
    });
  }
}
