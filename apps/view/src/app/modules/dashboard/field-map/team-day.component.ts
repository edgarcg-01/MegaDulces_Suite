import { Component, OnInit, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { SkeletonModule } from 'primeng/skeleton';
import { environment } from '../../../../environments/environment';

interface TeamRow {
  user_id: string;
  username: string;
  last_at: string | null;
  active_min: number;
  distance_km: number;
  detected_visits: number;
  uncaptured_visits: number;
  status: 'moving' | 'instore' | 'idle' | 'offline';
  pings: number;
}

const STATUS_LABEL: Record<string, string> = {
  moving: 'En traslado', instore: 'En tienda', idle: 'Detenido', offline: 'Sin señal',
};

/**
 * Resumen del equipo HOY — la vista de un vistazo del supervisor (pestaña Equipo
 * de Mapa de Campo). Por vendedor: estado en vivo, jornada, km aprox, visitas
 * detectadas por GPS y cuántas sin captura (gap de cobertura). Clic en una fila
 * → salta a "Por vendedor". Reusa /reports/team-day (sin map-matching, barato).
 */
@Component({
  selector: 'app-team-day',
  standalone: true,
  imports: [CommonModule, SkeletonModule],
  template: `
    <div class="td-wrap">
      <header class="td-head">
        <div>
          <h2 class="td-title">Equipo hoy</h2>
          <p class="td-sub">Actividad GPS del personal de campo</p>
        </div>
        <input type="date" class="td-date" [value]="date()" [max]="today" (change)="onDate($event)" />
      </header>

      @if (loading()) {
        <p-skeleton height="220px"></p-skeleton>
      } @else if (rows().length === 0) {
        <div class="td-empty">Sin personal con actividad GPS el {{ date() }}.</div>
      } @else {
        <div class="td-totals">
          <span class="t-chip">{{ rows().length }} activos</span>
          <span class="t-chip warn">{{ totalUncaptured() }} visitas sin captura</span>
          <span class="t-chip">{{ totalDetected() }} visitas detectadas</span>
        </div>
        <div class="td-scroll">
          <table class="td-table">
            <thead>
              <tr>
                <th>Vendedor</th><th>Estado</th><th>Última señal</th>
                <th class="num">Jornada</th><th class="num">Km aprox</th>
                <th class="num">Visitas GPS</th><th class="num">Sin captura</th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.user_id) {
                <tr (click)="selectVendor.emit({ user_id: r.user_id, date: date() })">
                  <td class="td-name">{{ r.username }}</td>
                  <td><span class="st" [class]="'st-' + r.status">{{ label(r.status) }}</span></td>
                  <td>{{ ago(r.last_at) }}</td>
                  <td class="num">{{ fmtMin(r.active_min) }}</td>
                  <td class="num">{{ r.distance_km }}</td>
                  <td class="num">{{ r.detected_visits }}</td>
                  <td class="num">
                    @if (r.uncaptured_visits > 0) { <span class="gap">{{ r.uncaptured_visits }}</span> } @else { 0 }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .td-wrap { padding:1rem; display:flex; flex-direction:column; gap:.8rem; }
    .td-head { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
    .td-title { font:700 1.1rem/1.2 'Hanken Grotesk',sans-serif; margin:0; color:var(--text,#1c1917); }
    .td-sub { margin:.15rem 0 0; font-size:.8rem; color:var(--text-dim,#78716c); }
    .td-date { padding:.4rem .6rem; border:1px solid var(--divider,#d6d3d1); border-radius:8px; background:var(--card-bg,#fff); color:var(--text,#1c1917); font-size:.85rem; }
    .td-empty { padding:2.5rem; text-align:center; color:var(--text-dim,#78716c); font-size:.9rem; }
    .td-totals { display:flex; gap:.4rem; flex-wrap:wrap; }
    .t-chip { font-size:.74rem; font-weight:600; padding:.25rem .6rem; border-radius:999px; background:var(--hover,#f5f5f4); color:var(--text,#1c1917); }
    .t-chip.warn { background:#fef2f2; color:#b91c1c; }
    .td-scroll { overflow-x:auto; border:1px solid var(--divider,#e7e5e4); border-radius:10px; }
    .td-table { width:100%; border-collapse:collapse; font-size:.82rem; }
    .td-table th { text-align:left; padding:.55rem .7rem; font:600 .72rem 'Hanken Grotesk',sans-serif; color:var(--text-dim,#78716c); border-bottom:1px solid var(--divider,#e7e5e4); white-space:nowrap; }
    .td-table th.num, .td-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .td-table td { padding:.55rem .7rem; border-bottom:1px solid var(--divider,#f0efed); color:var(--text,#1c1917); white-space:nowrap; }
    .td-table tbody tr { cursor:pointer; }
    .td-table tbody tr:hover { background:var(--hover,#f5f5f4); }
    .td-name { font-weight:600; }
    .st { font-size:.7rem; font-weight:700; padding:.15rem .5rem; border-radius:999px; }
    .st-moving { background:#dbeafe; color:#1d4ed8; }
    .st-instore { background:#dcfce7; color:#15803d; }
    .st-idle { background:#f3f4f6; color:#6b7280; }
    .st-offline { background:#fef2f2; color:#b91c1c; }
    .gap { font-weight:700; color:#b91c1c; }
  `],
})
export class TeamDayComponent implements OnInit {
  private http = inject(HttpClient);
  readonly today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  readonly selectVendor = output<{ user_id: string; date: string }>();

  readonly date = signal(this.today);
  readonly rows = signal<TeamRow[]>([]);
  readonly loading = signal(false);

  ngOnInit(): void {
    this.load();
  }

  onDate(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    if (!v) return;
    this.date.set(v);
    this.load();
  }

  totalUncaptured(): number {
    return this.rows().reduce((a, r) => a + r.uncaptured_visits, 0);
  }
  totalDetected(): number {
    return this.rows().reduce((a, r) => a + r.detected_visits, 0);
  }

  label(s: string): string {
    return STATUS_LABEL[s] || s;
  }

  fmtMin(m: number): string {
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  ago(iso: string | null): string {
    if (!iso) return '—';
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return `hace ${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `hace ${min} min`;
    return `hace ${Math.round(min / 60)} h`;
  }

  private load(): void {
    this.loading.set(true);
    const params = new HttpParams().set('date', this.date());
    this.http.get<{ rows: TeamRow[] }>(`${environment.apiUrl}/reports/team-day`, { params }).subscribe({
      next: (r) => { this.rows.set(r?.rows || []); this.loading.set(false); },
      error: () => { this.rows.set([]); this.loading.set(false); },
    });
  }
}
