import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DbHealthService, DbHealthReport, HealthStatus, SourceHealth } from './db-health.service';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

type Sev = 'success' | 'warn' | 'danger' | 'secondary';

@Component({
  selector: 'app-admin-db-health',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TableModule, TagModule, ButtonModule, FreshnessPillComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="ttl">
          <h1>Salud de la base de datos</h1>
          <span class="sub">
            Frescura de las fuentes críticas · DB <strong>{{ report()?.db_label || '—' }}</strong>
          </span>
        </div>
        <div class="actions">
          @if (report(); as r) {
            <app-freshness-pill [since]="r.checked_at" label="verificado" [staleAfterSec]="300" />
            <p-tag [severity]="sev(r.overall)" [value]="'Global: ' + statusLabel(r.overall)" [rounded]="true" />
          }
          <button pButton type="button" icon="pi pi-refresh" label="Refrescar"
                  [loading]="loading()" (click)="load()" size="small"></button>
        </div>
      </header>

      @if (error()) {
        <div class="banner err">
          <i class="pi pi-exclamation-triangle"></i>
          No se pudo consultar la salud de la DB. {{ error() }}
        </div>
      } @else if (report()?.overall === 'critical') {
        <div class="banner crit">
          <i class="pi pi-times-circle"></i>
          Hay fuentes <strong>sin actualizarse</strong> más allá de su cadencia. Revisá el feed correspondiente.
        </div>
      }

      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: appRows(), title: 'DB de la app', firstCol: 'Tabla' }"></ng-container>
      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: sourceRows(), title: 'Fuentes / orígenes (se leen desde local; en prod no alcanza la LAN)', firstCol: 'Origen' }"></ng-container>

      <ng-template #tbl let-data let-title="title" let-firstCol="firstCol">
        <h2 class="sec">{{ title }}</h2>
        <div class="card">
          <p-table [value]="data" [loading]="false" styleClass="p-datatable-sm" [tableStyle]="{ 'min-width': '48rem' }">
            <ng-template pTemplate="header">
              <tr>
                <th>{{ firstCol }}</th>
                <th>Última actualización</th>
                <th class="num">Antigüedad</th>
                <th>Estado</th>
                <th>Cadencia esperada</th>
                <th class="num">Filas</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-s>
              <tr>
                <td>
                  <div class="src">{{ s.label }}</div>
                  <div class="tbl">{{ s.table }}</div>
                </td>
                <td>
                  @if (s.last_update) {
                    <span class="when">{{ s.last_update | date: 'dd/MM HH:mm' }}</span>
                  } @else {
                    <span class="when muted">{{ s.status === 'unknown' ? '—' : 'nunca' }}</span>
                  }
                </td>
                <td class="num" [class.txt-warn]="s.status==='warn'" [class.txt-crit]="s.status==='critical'">
                  {{ relAge(s.age_seconds) }}
                </td>
                <td>
                  <p-tag [severity]="sev(s.status)" [value]="statusLabel(s.status)" />
                  @if (s.note) { <span class="note">{{ s.note }}</span> }
                </td>
                <td class="cadence">{{ s.cadence }}</td>
                <td class="num tnum">{{ s.rows != null ? (s.rows | number) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="6" class="empty">
                @if (loading()) { Cargando… } @else { Sin fuentes. }
              </td></tr>
            </ng-template>
          </p-table>
        </div>
      </ng-template>

      <p class="foot">
        La antigüedad se infiere de <code>max(updated_at)</code> por tabla — la huella de que el feed corrió.
        Un valor en rojo = la información dejó de actualizarse.
      </p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .page { padding: 1rem 1.25rem 2rem; max-width: 1100px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .page-head h1 { font-size: var(--text-page-head, 18px); font-weight: 700; letter-spacing: -0.01em; margin: 0; color: var(--text-main); }
    .page-head .sub { font-size: var(--fs-xs, .72rem); color: var(--text-faint); }
    .actions { display: inline-flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .banner { display: flex; align-items: center; gap: .5rem; font-size: .8rem; padding: .6rem .8rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); margin-bottom: .9rem; }
    .banner.crit { color: var(--danger-fg, #DC2626); border-color: color-mix(in srgb, var(--danger-fg, #DC2626) 40%, var(--border-color)); }
    .banner.err  { color: var(--warn-fg); border-color: color-mix(in srgb, var(--warn-fg) 40%, var(--border-color)); }
    .sec { font-size: .8rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text-main); margin: 1.1rem 0 .5rem; }
    .card { border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); overflow: hidden; }
    .src { font-weight: 600; color: var(--text-main); font-size: .82rem; }
    .tbl { font-size: .68rem; color: var(--text-faint); font-family: var(--font-mono, monospace); }
    .when { font-size: .78rem; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .when.muted { color: var(--text-faint); }
    .num { text-align: right; }
    .tnum { font-variant-numeric: tabular-nums; }
    .txt-warn { color: var(--warn-fg); font-weight: 600; }
    .txt-crit { color: var(--danger-fg, #DC2626); font-weight: 700; }
    .cadence { font-size: .76rem; color: var(--text-faint); }
    .note { font-size: .68rem; color: var(--text-faint); margin-left: .4rem; }
    .empty { text-align: center; color: var(--text-faint); padding: 1rem; font-size: .8rem; }
    .foot { font-size: .7rem; color: var(--text-faint); margin-top: .8rem; }
    .foot code { font-family: var(--font-mono, monospace); }
  `],
})
export class AdminDbHealthComponent implements OnInit {
  private svc = inject(DbHealthService);

  readonly report = signal<DbHealthReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly appRows = computed<SourceHealth[]>(() => (this.report()?.sources ?? []).filter((s) => s.group === 'app'));
  readonly sourceRows = computed<SourceHealth[]>(() => (this.report()?.sources ?? []).filter((s) => s.group === 'source'));

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc.getReport().subscribe({
      next: (r) => { this.report.set(r); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'Error de red'); this.loading.set(false); },
    });
  }

  sev(s: HealthStatus): Sev {
    return s === 'ok' ? 'success' : s === 'warn' ? 'warn' : s === 'critical' ? 'danger' : 'secondary';
  }
  statusLabel(s: HealthStatus): string {
    return s === 'ok' ? 'OK' : s === 'warn' ? 'Atrasado' : s === 'critical' ? 'Crítico' : 'Desconocido';
  }
  relAge(sec: number | null): string {
    if (sec == null) return '—';
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h`;
    return `${Math.floor(h / 24)} d`;
  }
}
