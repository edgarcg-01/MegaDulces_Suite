import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import type { SdReportResponse } from '@megadulces/contracts';
import { PRIORITY_LABEL, ServiceDeskService, sdError } from '../service-desk.service';
import { fmtCumplimiento, fmtMin, fmtPct, fmtTiempo, notaCumplimiento } from '../report-format';

/** `AAAA-MM-DD` de hoy en la zona horaria de México (no la del navegador: el reporte se cuenta por día de la mesa). */
function hoyMx(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function restarDias(fecha: string, n: number): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `[MS.3.5]` Mesa de Servicio › Reportes (`/servicio/reportes`) — sólo coordinación.
 *
 * Responde: ¿se cumple el SLA?, ¿cuánto tardamos en contestar y en resolver?, ¿dónde se concentran los problemas?,
 * ¿qué se repite? Se cuenta por la fecha de CREACIÓN del ticket, en la zona horaria de la mesa.
 *
 * ⛔ **Sin semáforo**: no hay una meta de cumplimiento registrada (nadie ha dicho «90 % es verde»), y pintar
 * rojo/verde exigiría inventarla aquí. El porcentaje se publica y habla solo; el color llega cuando haya meta.
 * ⛔ **Sin ranking de personas** (el reporte mide el servicio). ⛔ Lo que no se midió sale «—», nunca 0.
 */
@Component({
  selector: 'app-servicio-reportes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sr-page">
      <header class="sr-head">
        <div>
          <h1>Reportes de la Mesa de Servicio</h1>
          <p>Cumplimiento de plazos, tiempos y lo que se repite. Se cuenta por la fecha en que se creó cada solicitud.</p>
        </div>
      </header>

      <section class="sr-filtros" aria-label="Periodo">
        @for (p of presets; track p.dias) {
          <button type="button" class="sr-chip" [class.on]="preset() === p.dias" (click)="aplicarPreset(p.dias)">{{ p.label }}</button>
        }
        <label class="sr-fecha"><span>Desde</span><input pInputText type="date" [(ngModel)]="desde" aria-label="Desde" /></label>
        <label class="sr-fecha"><span>Hasta</span><input pInputText type="date" [(ngModel)]="hasta" aria-label="Hasta" /></label>
        <p-button label="Ver" icon="pi pi-search" [loading]="cargando()" (onClick)="aplicarFechas()" />
      </section>

      @if (error(); as e) { <p class="sr-banner bad" role="alert">{{ e }}</p> }

      @if (r(); as d) {
        @if (d.truncado) { <p class="sr-banner warn" role="status">El periodo trae más solicitudes de las que el reporte calcula: los números son de las más recientes. Acorta el periodo para verlos completos.</p> }

        <section class="sr-kpis" aria-label="Resumen del periodo">
          <div class="sr-kpi"><b>{{ d.totales.creados }}</b><span>Creadas</span></div>
          <div class="sr-kpi"><b>{{ d.totales.resueltos }}</b><span>Resueltas</span></div>
          <div class="sr-kpi"><b>{{ d.totales.abiertos }}</b><span>Abiertas</span></div>
          <div class="sr-kpi" [title]="nota(d.primera_respuesta)"><b>{{ fmtPct(d.primera_respuesta.cumplimiento_pct) }}</b><span>Primera respuesta a tiempo</span></div>
          <div class="sr-kpi" [title]="nota(d.resolucion)"><b>{{ fmtPct(d.resolucion.cumplimiento_pct) }}</b><span>Resolución a tiempo</span></div>
          <div class="sr-kpi" title="Solicitudes que alguna vez se reabrieron: «resuelto» no resolvió."><b>{{ fmtPct(d.totales.reabiertos_pct) }}</b><span>Reabiertas</span></div>
        </section>

        <section class="sr-card" aria-labelledby="h-pri">
          <h2 id="h-pri">Por prioridad</h2>
          <div class="sr-wrap dt-scope">
            <table class="sr-table dt-stack">
              <thead><tr><th>Prioridad</th><th>Creadas</th><th>Resueltas</th><th>1ª respuesta a tiempo</th><th>Mediana 1ª resp.</th><th>P90 1ª resp.</th><th>Resolución a tiempo</th><th>Mediana resolución</th><th>P90 resolución</th></tr></thead>
              <tbody>
                @for (p of d.por_prioridad; track p.priority) {
                  <tr>
                    <td class="dt-id" role="cell" data-label="Prioridad"><span class="sr-pri" [attr.data-p]="p.priority">{{ prioridad[p.priority] }}</span></td>
                    <td role="cell" data-label="Creadas">{{ p.creados }}</td>
                    <td role="cell" data-label="Resueltas">{{ p.resueltos }}</td>
                    <td role="cell" data-label="1ª respuesta a tiempo" [title]="nota(p.primera_respuesta)">{{ cumplimiento(p.primera_respuesta) }}</td>
                    <td role="cell" data-label="Mediana 1ª resp.">{{ tiempo(p.t_primera_respuesta) }}</td>
                    <td role="cell" data-label="P90 1ª resp.">{{ fmtMin(p.t_primera_respuesta.p90) }}</td>
                    <td role="cell" data-label="Resolución a tiempo" [title]="nota(p.resolucion)">{{ cumplimiento(p.resolucion) }}</td>
                    <td role="cell" data-label="Mediana resolución">{{ tiempo(p.t_resolucion) }}</td>
                    <td role="cell" data-label="P90 resolución">{{ fmtMin(p.t_resolucion.p90) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="sr-hint">Los tiempos van en minutos del reloj de cada prioridad (hábil o corrido, según su política) y la resolución <b>no cuenta lo que estuvo en espera del solicitante</b>. «—» = no hubo con qué medir, no «cero».</p>
        </section>

        <section class="sr-card" aria-labelledby="h-cat">
          <h2 id="h-cat">Por categoría</h2>
          <div class="sr-wrap dt-scope">
            <table class="sr-table dt-stack">
              <thead><tr><th>Categoría</th><th>Creadas</th><th>Resueltas</th><th>Resolución fuera de plazo</th><th>Reabiertas</th><th>Mediana resolución</th></tr></thead>
              <tbody>
                @for (c of d.por_categoria; track c.category_id) {
                  <tr>
                    <td class="dt-id" role="cell" data-label="Categoría">{{ c.name }}</td>
                    <td role="cell" data-label="Creadas">{{ c.creados }}</td>
                    <td role="cell" data-label="Resueltas">{{ c.resueltos }}</td>
                    <td role="cell" data-label="Fuera de plazo">{{ c.resolucion_incumplidos }}</td>
                    <td role="cell" data-label="Reabiertas">{{ c.reabiertos }}</td>
                    <td role="cell" data-label="Mediana resolución">{{ tiempo(c.t_resolucion) }}</td>
                  </tr>
                } @empty { <tr><td colspan="6" class="sr-vacio">Sin solicitudes en el periodo.</td></tr> }
              </tbody>
            </table>
          </div>
        </section>

        <section class="sr-card" aria-labelledby="h-suc">
          <h2 id="h-suc">Por sucursal</h2>
          <div class="sr-wrap dt-scope">
            <table class="sr-table dt-stack">
              <thead><tr><th>Sucursal</th><th>Creadas</th><th>Resueltas</th><th>Resolución fuera de plazo</th></tr></thead>
              <tbody>
                @for (s of d.por_sucursal; track s.warehouse_code ?? 'sin') {
                  <tr>
                    <td class="dt-id" role="cell" data-label="Sucursal">{{ s.warehouse_name || s.warehouse_code || 'Sin sucursal indicada' }}</td>
                    <td role="cell" data-label="Creadas">{{ s.creados }}</td>
                    <td role="cell" data-label="Resueltas">{{ s.resueltos }}</td>
                    <td role="cell" data-label="Fuera de plazo">{{ s.resolucion_incumplidos }}</td>
                  </tr>
                } @empty { <tr><td colspan="4" class="sr-vacio">Sin solicitudes en el periodo.</td></tr> }
              </tbody>
            </table>
          </div>
        </section>

        <section class="sr-card" aria-labelledby="h-rec">
          <h2 id="h-rec">Lo que se repite</h2>
          <p class="sr-hint">La misma categoría en la misma sucursal, al menos 3 veces en el periodo: probablemente es un problema de fondo y no solicitudes sueltas.</p>
          <div class="sr-wrap dt-scope">
            <table class="sr-table dt-stack">
              <thead><tr><th>Categoría</th><th>Sucursal</th><th>Veces</th></tr></thead>
              <tbody>
                @for (x of d.recurrentes; track x.category_id + (x.warehouse_code ?? '')) {
                  <tr>
                    <td class="dt-id" role="cell" data-label="Categoría">{{ x.category_name }}</td>
                    <td role="cell" data-label="Sucursal">{{ x.warehouse_name || x.warehouse_code || 'Sin sucursal indicada' }}</td>
                    <td role="cell" data-label="Veces">{{ x.n }}</td>
                  </tr>
                } @empty { <tr><td colspan="3" class="sr-vacio">Nada se repitió 3 veces o más en el periodo.</td></tr> }
              </tbody>
            </table>
          </div>
        </section>

        <section class="sr-card sr-nm" aria-labelledby="h-nm">
          <h2 id="h-nm">Lo que este reporte no mide</h2>
          <ul>@for (t of d.no_medido; track t) { <li>{{ t }}</li> }</ul>
          <p class="sr-hint">Periodo {{ d.periodo.desde }} a {{ d.periodo.hasta }} · calculado en vivo sobre las solicitudes ({{ medido(d.medido_at) }}). Sin semáforo: no hay una meta de cumplimiento registrada.</p>
        </section>
      } @else if (!error()) {
        <p class="sr-hint">Cargando…</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sr-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); max-width: 1200px; }
    .sr-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); }
    .sr-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .sr-filtros { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: flex-end; }
    .sr-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill);
      padding: 4px var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
    .sr-chip.on { border-color: var(--action); color: var(--text-main); background: var(--surface-selected-bg); }
    .sr-chip:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .sr-fecha { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: 600; color: var(--text-main); }
    .sr-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .sr-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sr-banner.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .sr-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-3); }
    .sr-kpi { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
    .sr-kpi b { font: 700 var(--fs-h2)/1.1 var(--font-body); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .sr-kpi span { font-size: var(--fs-xs); color: var(--text-muted); }
    .sr-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
    .sr-card h2 { margin: 0; font: 700 var(--fs-h3)/1.2 var(--font-body); color: var(--text-main); }
    .sr-hint { margin: 0; color: var(--text-muted); font-size: var(--fs-xs); line-height: 1.4; }
    .sr-wrap { overflow-x: auto; }
    .sr-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
    .sr-table th { text-align: left; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 600; padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .sr-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); }
    .sr-vacio { text-align: center; color: var(--text-muted); }
    .sr-pri { font-weight: 600; font-size: var(--fs-xs); padding: 2px 8px; border-radius: var(--r-pill); background: var(--surface-2); }
    .sr-pri[data-p='urgente'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sr-pri[data-p='alta'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .sr-pri[data-p='media'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .sr-nm ul { margin: 0; padding-left: var(--sp-4); color: var(--text-main); font-size: var(--fs-sm); display: flex; flex-direction: column; gap: var(--sp-1); }
    @media (max-width: 640px) { .sr-table { display: block; overflow-x: auto; } }
  `],
})
export class ServicioReportesComponent implements OnInit {
  private readonly api = inject(ServiceDeskService);

  readonly prioridad = PRIORITY_LABEL;
  readonly presets = [{ dias: 7, label: '7 días' }, { dias: 30, label: '30 días' }, { dias: 90, label: '90 días' }];
  readonly fmtPct = fmtPct;
  readonly fmtMin = fmtMin;
  readonly cumplimiento = fmtCumplimiento;
  readonly tiempo = fmtTiempo;
  readonly nota = notaCumplimiento;

  readonly r = signal<SdReportResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly cargando = signal(false);
  /** Cuál preset está activo (`null` = fechas a mano). */
  readonly preset = signal<number | null>(30);
  desde = restarDias(hoyMx(), 29);
  hasta = hoyMx();

  ngOnInit(): void { this.cargar(); }

  aplicarPreset(dias: number): void {
    this.preset.set(dias);
    this.hasta = hoyMx();
    this.desde = restarDias(this.hasta, dias - 1);
    this.cargar();
  }

  aplicarFechas(): void {
    this.preset.set(null);
    this.cargar();
  }

  medido(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short' });
  }

  private cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.report(this.desde, this.hasta).subscribe({
      next: (d) => { this.r.set(d); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(sdError(e, 'No se pudo cargar el reporte.')); },
    });
  }
}
