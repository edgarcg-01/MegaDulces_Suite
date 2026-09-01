import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { EntradasService, VencimientosReport, VencimientoRow } from '../entradas.service';
import { branchName } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';

/**
 * `[RE.3]` — **Qué vence.** El calendario de pago a proveedores.
 *
 * **No se llama "Cuentas por pagar" a propósito, y ésa es la decisión de diseño de la pantalla.**
 * No existe la liga recepción→pago en el ERP (`erp_supplier_payments` no trae folio de entrada;
 * `expense_doc_chain` está vacía), así que **no se puede saber qué ya se pagó**. Medido: 10,940
 * recepciones tienen vencimiento pasado por **$507M**, y casi todo está pagado — los datos
 * arrancan en ago-2024. Una pantalla de "CxP" publicaría esos $507M como deuda.
 *
 * Así que se muestra **sólo lo que todavía no vence**, donde la pregunta "¿ya se pagó?" casi no
 * aplica, y lo vencido se **declara como número, sin lista**: mandar a alguien a perseguir 1,023
 * facturas mayormente pagadas es daño operativo, no una funcionalidad incompleta.
 *
 * Cuando exista RE.8 (liga a pago heurística), lo vencido se puede abrir de verdad.
 */
@Component({
  selector: 'app-compras-vencimientos',
  standalone: true,
  imports: [CommonModule, ButtonModule, TagModule, MetricStripComponent, SegmentedComponent, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cv-wrap">
      <header class="cv-head">
        <div>
          <h1>Qué vence</h1>
          <p class="cv-sub">Compromisos de pago a proveedor derivados de la orden de entrada.</p>
        </div>
        <div class="cv-head-actions">
          <app-segmented [options]="ventanaOpts" [value]="String(dias())"
                         (valueChange)="setDias($any($event))" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <app-load-state [loading]="loading()" [error]="error()"
                      [isEmpty]="!loading() && !error() && !rows().length"
                      emptyTitle="Nada vence en esta ventana"
                      emptyHint="Ampliá el rango para ver más adelante.">
        @if (report(); as r) {
          <!-- Answer-first: el veredicto antes de la tabla. -->
          <p class="cv-verdict">{{ veredicto() }}</p>

          <app-metric-strip [items]="kpis()" ariaLabel="Vencimientos próximos" />

          <!-- Lo que la pantalla NO sabe, dicho arriba y no escondido en un pie. -->
          @if (r.vencido_sin_confirmar.n > 0) {
            <div class="cv-gap">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              <p>
                Además, <b>{{ r.vencido_sin_confirmar.n }}</b> órdenes por
                <b class="mono">{{ money(r.vencido_sin_confirmar.monto) }}</b>
                vencieron en los últimos {{ r.vencido_sin_confirmar.dias }} días.
                <b>No se listan porque no sabemos cuáles siguen sin pagarse</b>: el ERP no liga el
                pago con la recepción. Cuando esa liga exista, esta sección se puede abrir.
              </p>
            </div>
          }

          <div class="cv-scroll">
            <table class="surf-table surf-table--plain is-dense">
              <thead>
                <tr>
                  <th>Vence</th>
                  <th class="comm-num">En</th>
                  <th>Proveedor</th>
                  <th>Sucursal</th>
                  <th>Entrada</th>
                  <th>Condición</th>
                  <th class="comm-num">Importe</th>
                </tr>
              </thead>
              <tbody>
                @for (v of rows(); track v.sucursal + v.folio) {
                  <tr [class.is-hoy]="v.dias_para_vencer === 0">
                    <td class="mono">{{ v.fecha_vence | date:'dd/MM/yy' }}</td>
                    <td class="comm-num">
                      @if (v.dias_para_vencer === 0) {
                        <p-tag value="hoy" severity="warn" />
                      } @else {
                        {{ v.dias_para_vencer }}d
                      }
                    </td>
                    <td>{{ v.proveedor_nombre || v.proveedor_code || '—' }}</td>
                    <td>{{ branchName(v.sucursal) }}</td>
                    <td class="mono">{{ v.folio }}</td>
                    <td class="cv-cond">{{ v.condicion_pago || '—' }}</td>
                    <td class="comm-num">{{ money(v.monto) }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="6">{{ rows().length }} de {{ r.buckets.ventana.n }} en la ventana</td>
                  <td class="comm-num">{{ money(r.buckets.ventana.monto) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cv-wrap { padding: var(--sp-4); display: grid; gap: var(--sp-3); }
    .cv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
    .cv-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 700; }
    .cv-sub { margin: 2px 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .cv-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

    /* Answer-first (DESIGN §15): el veredicto en llano antes del grid. */
    .cv-verdict { margin: 0; font-size: var(--fs-body); line-height: 1.55; color: var(--text-main); }
    .cv-verdict b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    /* Lo que no se sabe se declara con el mismo peso que lo que sí. Borde, no sombra. */
    .cv-gap {
      display: flex; gap: var(--sp-2); align-items: flex-start;
      padding: var(--sp-2) var(--sp-3);
      border-left: 3px solid var(--info-fg); background: var(--info-soft-bg);
      border-radius: var(--r-md);
    }
    .cv-gap i { color: var(--info-fg); margin-top: 2px; }
    .cv-gap p { margin: 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-main); }

    .cv-scroll { overflow-x: auto; }
    .cv-cond { color: var(--text-muted); font-size: var(--fs-xs); }
    /* Lo que vence HOY se ancla con la barra de acento, no con fondo de color: el color solo
       nunca porta significado (DESIGN regla 5) — el tag "hoy" lo dice con texto. */
    .surf-table--plain > tbody > tr.is-hoy > td:first-child { box-shadow: inset 2px 0 0 var(--warn-fg); }
  `],
})
export class ComprasVencimientosComponent {
  private readonly svc = inject(EntradasService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  /** `LoadState` distingue error de vacío por el MENSAJE, no por un booleano. */
  readonly error = signal<string | null>(null);
  readonly report = signal<VencimientosReport | null>(null);
  readonly dias = signal(30);

  readonly rows = computed<VencimientoRow[]>(() => this.report()?.rows ?? []);
  money = money;
  branchName = branchName;
  String = String;

  readonly ventanaOpts = [
    { label: '7 días', value: '7' },
    { label: '30 días', value: '30' },
    { label: '90 días', value: '90' },
  ];

  /**
   * El veredicto en llano. Se nombra el compromiso más cercano porque es la única acción que la
   * pantalla habilita hoy: qué hay que tener listo para pagar esta semana.
   */
  readonly veredicto = computed(() => {
    const r = this.report();
    if (!r) return '';
    const { hoy, semana, ventana } = r.buckets;
    if (!ventana.n) return `Nada vence en los próximos ${r.ventana_dias} días.`;
    const partes: string[] = [];
    if (hoy.n) partes.push(`hoy vencen ${hoy.n} por ${money(hoy.monto)}`);
    partes.push(`esta semana ${semana.n} por ${money(semana.monto)}`);
    return `En ${r.ventana_dias} días vencen ${ventana.n} órdenes por ${money(ventana.monto)} — ${partes.join(', ')}.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.report();
    const b = r?.buckets;
    return [
      { label: 'Vence hoy', value: b?.hoy.monto ?? 0, format: 'currency-short',
        tone: b?.hoy.n ? 'warn' : 'ok', sub: `${b?.hoy.n ?? 0} órdenes` },
      { label: 'Esta semana', value: b?.semana.monto ?? 0, format: 'currency-short',
        tone: 'default', sub: `${b?.semana.n ?? 0} órdenes` },
      { label: `En ${r?.ventana_dias ?? 30} días`, value: b?.ventana.monto ?? 0, format: 'currency-short',
        tone: 'default', sub: `${b?.ventana.n ?? 0} órdenes` },
    ];
  });

  constructor() { this.load(); }

  setDias(v: string): void { this.dias.set(Number(v) || 30); this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.svc.vencimientos({ dias: this.dias() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.report.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set('No se pudieron cargar los vencimientos.'); },
    });
  }
}
