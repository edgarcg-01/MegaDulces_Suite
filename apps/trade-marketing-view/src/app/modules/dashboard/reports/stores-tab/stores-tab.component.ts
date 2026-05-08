import { Component, inject, signal, computed, OnInit, OnDestroy, effect } from '@angular/core';
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
  error = signal<string | null>(null);
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

  private filterEffect = effect(() => {
    this.filtersState.filters();
    this.loadData();
  });

  ngOnInit() {}

  ngOnDestroy() {
    this.filterEffect.destroy();
  }

  loadData() {
    this.loading.set(true);
    this.error.set(null);
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
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.status === 403
          ? 'No tienes permisos para ver estos datos.'
          : 'Error al cargar datos. Intenta de nuevo.');
      }
    });
  }
}
