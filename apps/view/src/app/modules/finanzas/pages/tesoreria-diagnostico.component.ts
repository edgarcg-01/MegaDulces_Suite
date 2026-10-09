import { Component, inject, signal, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

interface Runway {
  ventana_dias: number; saldo_inicial: number; cobro_en_ventana: number; pago_en_ventana: number;
  hueco_de_la_ventana: number; recuperacion_semanal_requerida: number;
  cobro_semanal_historico: number | null; requerido_pct_del_historico: number | null;
  holgura_veces: number | null; veredicto: string; nota: string;
}
interface Cycle {
  ventana_dias: number;
  insumos: { venta: number; cogs: number; compra: number; cartera: number; deuda: number; margen_implicito_pct: number | null };
  dso_dias: number | null; dpo_dias: number | null; dpo_dias_sin_disputa: number | null;
  dpo_masa_en_disputa: number; dpo_nota: string;
  dio_dias: number | null; dio_motivo: string; ciclo_dias: number | null; ciclo_motivo: string;
  coverage?: { measured: boolean; pct: number | null; note: string };
}

/**
 * `[TES.15]` **Tesorería · diagnosticar — página propia, NO una pestaña más.**
 *
 * Dos razones, y la segunda es de arquitectura, no de conveniencia:
 *
 *  1. ⛔ `finanzas-presupuesto.component.ts` tiene **2,719 líneas**, lo editan **cinco sesiones**
 *     y está partiéndose ahora mismo. Meterle dos pestañas encima garantiza la quinta mezcla del
 *     día — hoy ya hubo cuatro, y ninguna la reportó git.
 *  2. ⭐ **Operar y diagnosticar no son la misma frecuencia.** Flujo, Capacidad y Obligaciones se
 *     miran todos los días; esto se mira una vez por semana. Mezclarlos en la misma tira de
 *     pestañas es lo que convierte un tablero en una pantalla.
 *
 * Reusa `PRESUPUESTOS_VER` — los dos endpoints ya lo exigen, así que **no hay permiso nuevo y no
 * hace falta re-login**.
 */
@Component({
  selector: 'app-tesoreria-diagnostico',
  standalone: true,
  imports: [CommonModule, MetricStripComponent],
  template: `
    <div class="td">
      <header class="td-head">
        <h1 class="surf-page-title">Tesorería · diagnóstico</h1>
        <p class="surf-page-sub">¿Alcanza el dinero para pagar lo que se debe, y cuánto tardamos en cobrar y pagar?</p>
      </header>

      @if (error()) {
        <p class="td-nodata"><span class="pi pi-exclamation-triangle"></span> {{ error() }}</p>
      }

      <!-- ── EL VEREDICTO, primero. DESIGN.md 15: answer-first. ── -->
      @if (runway(); as r) {
        <section class="td-sec">
          <h2 class="td-h2">¿Alcanza?</h2>
          @if (r.requerido_pct_del_historico !== null) {
            <p class="td-verdict">
              Para cubrir lo que vence en {{ r.ventana_dias }} días hay que cobrar
              <strong class="td-big">{{ r.requerido_pct_del_historico }}%</strong>
              de lo que el negocio ya cobra cada semana.
              @if (r.holgura_veces) { <span class="td-muted">Holgura {{ r.holgura_veces }}×.</span> }
            </p>
            <!-- El umbral se DIBUJA. Un numero sin su umbral no se puede juzgar, y un verde sin
                 umbral es el cfg ? classify : 'ok' otra vez. -->
            <div class="td-bar" role="img"
                 [attr.aria-label]="'Requerido ' + r.requerido_pct_del_historico + ' por ciento, umbral ' + UMBRAL + ' por ciento'">
              <span class="td-bar-fill" [style.width.%]="min100(r.requerido_pct_del_historico)"></span>
              <span class="td-bar-um" [style.left.%]="UMBRAL"></span>
              <span class="td-bar-lab">
                <span>requerido {{ r.requerido_pct_del_historico }}%</span>
                <span>umbral {{ UMBRAL }}%</span>
              </span>
            </div>
            <p class="td-nodata">
              <span class="pi pi-info-circle"></span>
              ⚠️ <strong>El umbral del {{ UMBRAL }}% todavía no tiene dueño.</strong> Es una propuesta,
              no una meta registrada: por ADR-076 va a <code>analytics.kpi_thresholds</code> o el
              estado de esta cifra es <em>sin meta</em>.
            </p>
          } @else {
            <p class="td-nodata"><span class="pi pi-info-circle"></span> Sin histórico de cobro no hay con qué juzgar si lo requerido es alcanzable. La cifra queda <strong>sin medir</strong>, no en cero.</p>
          }
          <app-metric-strip [items]="runwayKpis(r)" mode="strip" ariaLabel="Holgura de liquidez" />
          <p class="td-nodata"><span class="pi pi-info-circle"></span> {{ r.nota }}</p>
        </section>
      }

      @if (cycle(); as c) {
        <section class="td-sec">
          <h2 class="td-h2">Ciclo de conversión de efectivo <span class="td-muted">— {{ c.ventana_dias }} días</span></h2>
          <app-metric-strip [items]="cycleKpis(c)" mode="strip" ariaLabel="Ciclo de conversión de efectivo" />
          @if (c.dpo_masa_en_disputa > 0) {
            <p class="td-nodata"><span class="pi pi-info-circle"></span> {{ c.dpo_nota }}</p>
          }
          <p class="td-nodata"><span class="pi pi-info-circle"></span> <strong>DIO e Ciclo no se calculan:</strong> {{ c.dio_motivo }}</p>
          @if (c.coverage?.note) {
            <p class="td-nodata"><span class="pi pi-info-circle"></span> {{ c.coverage!.note }}</p>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .td { display:flex; flex-direction:column; gap:var(--sp-4); padding-block-end:var(--sp-8); }
    .td-head { display:flex; flex-direction:column; gap:var(--sp-1); }
    .td-sec { background:var(--card-bg); border:1px solid var(--border-color); border-radius:var(--r-lg);
              padding:var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-3); }
    .td-h2 { font-size:var(--fs-lg); font-weight:700; margin:0; }
    .td-muted { color:var(--text-muted); font-weight:400; }
    .td-verdict { font-size:var(--fs-body); margin:0; color:var(--text-main); }
    .td-big { font-family:var(--font-mono); font-size:var(--fs-h1); font-variant-numeric:tabular-nums;
              letter-spacing:-.02em; color:var(--ok-fg); }
    .td-nodata { font-size:var(--fs-xs); color:var(--text-muted); margin:0;
                 display:flex; gap:var(--sp-2); align-items:flex-start; }
    .td-bar { position:relative; height:2rem; border:1px solid var(--border-color);
              border-radius:var(--r-md); background:var(--hover-bg); overflow:hidden; }
    .td-bar-fill { position:absolute; inset:0 auto 0 0; background:var(--ok-soft-bg);
                   border-right:2px solid var(--ok-fg); }
    .td-bar-um { position:absolute; top:0; bottom:0; width:0; border-left:2px dashed var(--warn-fg); }
    .td-bar-lab { position:absolute; inset:0; display:flex; align-items:center;
                  justify-content:space-between; padding-inline:var(--sp-2);
                  font-size:var(--fs-nano); color:var(--text-muted); font-family:var(--font-mono); }
  `],
})
export class TesoreriaDiagnosticoComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = '/api/finance/budget';

  /** ⚠️ Propuesta, NO meta registrada. Ver el aviso en pantalla y ADR-076. */
  readonly UMBRAL = 70;

  readonly runway = signal<Runway | null>(null);
  readonly cycle = signal<Cycle | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    forkJoin({
      r: this.http.get<Runway>(`${this.base}/cash-runway`),
      c: this.http.get<Cycle>(`${this.base}/cash-cycle`),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ r, c }) => { this.runway.set(r); this.cycle.set(c); },
      // Un error de red NO es un cero: la pantalla lo dice en vez de quedarse vacía.
      error: () => this.error.set('No se pudieron cargar las cifras de tesorería. No es que den cero: no llegaron.'),
    });
  }

  min100(n: number): number { return Math.max(0, Math.min(100, n)); }

  runwayKpis(r: Runway): MetricStripItem[] {
    return [
      { label: 'Requerido por semana', value: r.recuperacion_semanal_requerida, format: 'currency-short',
        state: 'medido', stateNote: 'De la masa vencida, para cerrar el hueco de la ventana' },
      r.cobro_semanal_historico != null
        ? { label: 'Cobro semanal real', value: r.cobro_semanal_historico, format: 'currency-short',
            state: 'medido', stateNote: 'Promedio de las 8 semanas cerradas' }
        : { label: 'Cobro semanal real', value: '—', format: 'text', state: 'no_medido',
            stateNote: 'Sin cobros registrados en las 8 semanas cerradas' },
      // ⛔ Sin tono a propósito: el hueco es el caso base, no una alarma. La curva agenda por
      // vencimiento y lo vencido viaja sin fecha, así que un rojo acá gritaría todos los días —
      // y una alarma que grita en falso enseña a ignorar el tablero.
      { label: 'Hueco de la ventana', value: r.hueco_de_la_ventana, format: 'currency-short',
        state: 'parcial', stateNote: 'Saldo + cobro en ventana − pago en ventana. Negativo por construcción: lo vencido no se agenda' },
      { label: 'Saldo inicial', value: r.saldo_inicial, format: 'currency-short',
        state: 'medido', stateNote: 'Movimientos de fecha imposible excluidos y declarados' },
    ];
  }

  cycleKpis(c: Cycle): MetricStripItem[] {
    const d = (n: number | null) => (n == null ? null : `${n} d`);
    return [
      c.dso_dias != null
        ? { label: 'DSO · cobrar', value: d(c.dso_dias) as string, format: 'text', state: 'medido',
            stateNote: `Cartera ${this.money(c.insumos.cartera)} ÷ venta diaria` }
        : { label: 'DSO · cobrar', value: '—', format: 'text', state: 'no_medido', stateNote: 'Sin venta en la ventana no hay con qué dividir' },
      c.dpo_dias != null
        ? { label: 'DPO · pagar', value: d(c.dpo_dias) as string, format: 'text', state: 'parcial',
            stateNote: c.dpo_dias_sin_disputa != null ? `y ${c.dpo_dias_sin_disputa} d sin la masa en disputa` : undefined }
        : { label: 'DPO · pagar', value: '—', format: 'text', state: 'no_medido', stateNote: 'Sin compra en la ventana no hay con qué dividir' },
      { label: 'DIO · rotar', value: '—', format: 'text', state: 'no_medido', stateNote: c.dio_motivo },
      { label: 'Ciclo', value: '—', format: 'text', state: 'no_medido', stateNote: c.ciclo_motivo },
      c.insumos.margen_implicito_pct != null
        ? { label: 'Margen implícito', value: c.insumos.margen_implicito_pct, format: 'percent',
            state: 'medido', stateNote: 'Derivado de venta y COGS del mismo fact' }
        : { label: 'Margen implícito', value: '—', format: 'text', state: 'no_medido', stateNote: 'Sin venta en la ventana' },
    ];
  }

  private money(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
