import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DbHealthService, DbHealthReport, HealthStatus, SourceHealth, HealthAlert } from './db-health.service';
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
          <button pButton type="button" [loading]="scanning()" (click)="scan()" size="small" class="p-button-outlined"><span class="p-button-icon p-button-icon-left pi pi-bolt" aria-hidden="true"></span><span class="p-button-label">Escanear ahora</span></button>
          <button pButton type="button" [loading]="loading()" (click)="load()" size="small"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Refrescar</span></button>
          <button pButton type="button" (click)="toggleAuto()" size="small" [class.p-button-outlined]="!auto()" [title]="auto() ? 'Auto-refresco cada 60s activo' : 'Auto-refresco pausado'"><span class="p-button-icon p-button-icon-left pi" [class.pi-pause]="auto()" [class.pi-play]="!auto()" aria-hidden="true"></span><span class="p-button-label">{{ auto() ? 'Auto 60s' : 'Manual' }}</span></button>
        </div>
      </header>

      <!-- Marcador — lectura instantánea de toda la parvada de feeds/fuentes -->
      <div class="scoreboard">
        <button class="tile ok"   [class.on]="filter()==='ok'"       (click)="setFilter('ok')"><span class="n">{{ counts().ok }}</span><span class="l">OK</span></button>
        <button class="tile warn" [class.on]="filter()==='warn'"     (click)="setFilter('warn')"><span class="n">{{ counts().warn }}</span><span class="l">Atrasados</span></button>
        <button class="tile crit" [class.on]="filter()==='critical'" (click)="setFilter('critical')"><span class="n">{{ counts().critical }}</span><span class="l">Críticos</span></button>
        <button class="tile unk"  [class.on]="filter()==='unknown'"  (click)="setFilter('unknown')"><span class="n">{{ counts().unknown }}</span><span class="l">Sin dato</span></button>
        <div class="tile tot"><span class="n">{{ counts().total }}</span><span class="l">Fuentes</span></div>
        @if (filter()) { <button class="clr" (click)="setFilter(null)"><i class="pi pi-filter-slash"></i> ver todo</button> }
      </div>

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

      <!-- Bandeja PERSISTENTE de alertas (abre/resuelve el scanner cada 5 min) -->
      <h2 class="sec">Bandeja de alertas
        <span class="cnt" [class.bad]="openAlerts().length">{{ openAlerts().length }} abierta(s)</span></h2>
      <div class="card">
        <p-table [value]="openAlerts()" styleClass="p-datatable-sm" [tableStyle]="{ 'min-width': '48rem' }">
          <ng-template #header>
            <tr><th>Fuente</th><th>Estado</th><th class="num">Desactualizada</th><th>Detectada</th><th></th></tr>
          </ng-template>
          <ng-template #body let-a>
            <tr [class.row-ack]="a.acknowledged_at">
              <td>
                <div class="src">{{ a.source_label }}</div>
                @if (a.note) { <div class="note2">{{ a.note }}</div> }
              </td>
              <td><p-tag [severity]="a.status==='critical' ? 'danger' : 'warn'" [value]="a.status==='critical' ? 'Crítico' : 'Atrasado'" /></td>
              <td class="num" [class.txt-warn]="a.status==='warn'" [class.txt-crit]="a.status==='critical'">{{ relAge(a.age_seconds) }}</td>
              <td><span class="when">{{ a.first_seen_at | date: 'dd/MM HH:mm' }}</span></td>
              <td class="num">
                @if (a.acknowledged_at) { <span class="ackd"><i class="pi pi-check"></i> visto</span> }
                @else { <button pButton type="button" size="small" class="p-button-text p-button-sm" (click)="ack(a)"><span class="p-button-label">Marcar visto</span></button> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="5" class="empty ok-empty"><i class="pi pi-check-circle"></i> Sin alertas abiertas — todo sano.</td></tr>
          </ng-template>
        </p-table>
      </div>
      @if (resolvedAlerts().length) {
        <details class="resolved">
          <summary>Resueltas recientes ({{ resolvedAlerts().length }})</summary>
          @for (a of resolvedAlerts(); track a.id) {
            <div class="rrow">
              <span class="src">{{ a.source_label }}</span>
              <span class="muted">falló {{ a.first_seen_at | date: 'dd/MM HH:mm' }} → recuperada {{ a.resolved_at | date: 'dd/MM HH:mm' }}</span>
            </div>
          }
        </details>
      }

      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: cronRows(), title: 'Crons / feeds (estado de ejecución)', firstCol: 'Cron' }"></ng-container>
      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: appRows(), title: 'DB de la app', firstCol: 'Tabla' }"></ng-container>
      <ng-container *ngTemplateOutlet="tbl; context: { $implicit: sourceRows(), title: 'Fuentes / orígenes (se leen desde local; en prod no alcanza la LAN)', firstCol: 'Origen' }"></ng-container>

      <ng-template #tbl let-data let-title="title" let-firstCol="firstCol">
        <h2 class="sec">{{ title }}</h2>
        <div class="card">
          <p-table [value]="data" [loading]="false" styleClass="p-datatable-sm" [tableStyle]="{ 'min-width': '48rem' }">
            <ng-template #header>
              <tr>
                <th>{{ firstCol }}</th>
                <th>Última actualización</th>
                <th class="num">Antigüedad</th>
                <th>Estado</th>
                <th>Cadencia esperada</th>
                <th class="num">Filas</th>
              </tr>
            </ng-template>
            <ng-template #body let-s>
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
            <ng-template #emptymessage>
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
    .scoreboard { display: flex; gap: .5rem; flex-wrap: wrap; align-items: stretch; margin-bottom: 1rem; }
    .tile { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: .1rem; min-width: 92px; padding: .5rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); background: var(--surface-card, transparent); cursor: pointer; transition: border-color .12s, background .12s; text-align: left; }
    .tile:hover { border-color: color-mix(in srgb, var(--text-faint) 45%, var(--border-color)); }
    .tile.on { background: color-mix(in srgb, currentColor 8%, transparent); border-color: currentColor; }
    .tile .n { font-size: 1.35rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: var(--text-main); }
    .tile .l { font-size: .66rem; letter-spacing: .02em; text-transform: uppercase; color: var(--text-faint); }
    .tile.ok   { color: var(--ok-fg, #16A34A); }
    .tile.warn { color: var(--warn-fg, #D97706); }
    .tile.crit { color: var(--danger-fg, #DC2626); }
    .tile.unk  { color: var(--text-faint); }
    .tile.ok .n, .tile.warn .n, .tile.crit .n { color: currentColor; }
    .tile.tot { cursor: default; background: transparent; }
    .tile.tot:hover { border-color: var(--border-color); }
    .clr { align-self: center; display: inline-flex; align-items: center; gap: .3rem; border: none; background: none; cursor: pointer; font-size: .74rem; color: var(--text-faint); padding: 0 .4rem; }
    .clr:hover { color: var(--text-main); }
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
    .ok-empty { color: var(--ok-fg, #16A34A); }
    .foot { font-size: .7rem; color: var(--text-faint); margin-top: .8rem; }
    .foot code { font-family: var(--font-mono, monospace); }
    .cnt { font-size: .7rem; font-weight: 600; color: var(--text-faint); margin-left: .4rem; }
    .cnt.bad { color: var(--danger-fg, #DC2626); }
    .note2 { font-size: .68rem; color: var(--text-faint); margin-top: 1px; }
    .row-ack { opacity: .6; }
    .ackd { font-size: .7rem; color: var(--ok-fg, #16A34A); }
    .resolved { margin-top: .6rem; font-size: .76rem; }
    .resolved summary { cursor: pointer; color: var(--text-faint); }
    .rrow { display: flex; gap: .6rem; padding: .25rem 0 .25rem .8rem; align-items: baseline; }
    .rrow .muted { color: var(--text-faint); font-size: .72rem; }
  `],
})
export class AdminDbHealthComponent implements OnInit, OnDestroy {
  private svc = inject(DbHealthService);

  readonly report = signal<DbHealthReport | null>(null);
  readonly loading = signal(false);
  readonly scanning = signal(false);
  readonly error = signal<string | null>(null);
  readonly openAlerts = signal<HealthAlert[]>([]);
  readonly resolvedAlerts = signal<HealthAlert[]>([]);
  /** Filtro de severidad activo (clic en el marcador). null = ver todo. */
  readonly filter = signal<HealthStatus | null>(null);
  /** Auto-refresco cada 60s (pantalla viva). */
  readonly auto = signal(true);
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Conteo por severidad sobre TODAS las fuentes (crons + app + orígenes). */
  readonly counts = computed(() => {
    const s = this.report()?.sources ?? [];
    return {
      ok: s.filter((x) => x.status === 'ok').length,
      warn: s.filter((x) => x.status === 'warn').length,
      critical: s.filter((x) => x.status === 'critical').length,
      unknown: s.filter((x) => x.status === 'unknown').length,
      total: s.length,
    };
  });

  private byGroup(g: SourceHealth['group']): SourceHealth[] {
    const f = this.filter();
    return (this.report()?.sources ?? []).filter((s) => s.group === g && (!f || s.status === f));
  }
  readonly appRows = computed<SourceHealth[]>(() => this.byGroup('app'));
  readonly sourceRows = computed<SourceHealth[]>(() => this.byGroup('source'));
  readonly cronRows = computed<SourceHealth[]>(() => this.byGroup('cron'));

  ngOnInit(): void {
    this.load();
    this.startAuto();
  }

  ngOnDestroy(): void { this.stopAuto(); }

  private startAuto(): void {
    this.stopAuto();
    if (this.auto()) this.timer = setInterval(() => this.silentLoad(), 60_000);
  }
  private stopAuto(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  toggleAuto(): void { this.auto.update((v) => !v); this.startAuto(); }
  setFilter(s: HealthStatus | null): void { this.filter.update((cur) => (cur === s ? null : s)); }

  /** Refresco de fondo (auto): NO prende el spinner grande para no parpadear la vista. */
  private silentLoad(): void {
    this.svc.getReport().subscribe({
      next: (r) => { this.report.set(r); this.error.set(null); },
      error: () => { /* silencioso: no romper la pantalla viva por un blip de red */ },
    });
    this.loadAlerts();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc.getReport().subscribe({
      next: (r) => { this.report.set(r); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || e?.message || 'Error de red'); this.loading.set(false); },
    });
    this.loadAlerts();
  }

  loadAlerts(): void {
    this.svc.listAlerts().subscribe({
      next: (r) => { this.openAlerts.set(r.open ?? []); this.resolvedAlerts.set(r.recent_resolved ?? []); },
      error: () => { /* la tabla puede no existir pre-deploy; no romper la vista */ },
    });
  }

  scan(): void {
    this.scanning.set(true);
    this.svc.scanNow().subscribe({
      next: () => { this.scanning.set(false); this.load(); },
      error: () => { this.scanning.set(false); },
    });
  }

  ack(a: HealthAlert): void {
    this.svc.ackAlert(a.id).subscribe({ next: () => this.loadAlerts() });
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
