import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { CeldaPresupuesto, GrupoRubro, PresupuestoAnio, RubroCodigo } from '@megadulces/contracts';
import { GRUPO_RUBRO_LABEL, RUBROS_COSTO_UNIDAD } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LogisticaService } from '../logistica.service';
import { COSTO_UNIDAD_TABS } from '../costo-unidad-tabs';

const GRUPOS: GrupoRubro[] = ['fijos', 'variables', 'administrativos', 'fuera_de_hoja'];

/** `[FCU.3.4]` Las celdas que cambiaron contra lo que vino del servidor (`null` = se borró). */
export function celdasCambiadas(original: PresupuestoAnio, editado: Map<string, number | null>): CeldaPresupuesto[] {
  const out: CeldaPresupuesto[] = [];
  for (const [k, v] of editado) {
    const [vehicle_id, rubro] = k.split('|') as [string, RubroCodigo];
    const antes = original.unidades.find((u) => u.vehicle_id === vehicle_id)?.montos[rubro] ?? null;
    if ((antes ?? null) !== (v ?? null)) out.push({ vehicle_id, rubro, amount: v ?? null });
  }
  return out;
}

/**
 * `[FCU.3.4]` — **Presupuesto: lo que hoy dice la hoja, unidad por rubro.**
 *
 * La pregunta que contesta: ¿cuánto se presupuestó al año para cada unidad y rubro? Arranca con la
 * carga de la hoja «TRANSPORTES 2026» (sus renglones, no sus totales: los totales de la hoja omiten
 * la comisión en 4 unidades) y desde aquí se edita como se editaba la hoja.
 *
 * Jerarquía: primario = el total presupuestado del año; secundario = la fila por unidad; terciario =
 * cada celda.
 */
@Component({
  selector: 'app-logistica-costo-unidad-presupuesto',
  standalone: true,
  imports: [CurrencyPipe, FormsModule, TableModule, SelectModule, ButtonModule, InputNumberModule, ToastModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cb">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo por unidad</h1>
          <p class="surf-page-sub">El presupuesto anual de cada unidad por rubro: lo que hoy se captura en la hoja de costos de Transportes.</p>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de costo por unidad" />

      <section class="cb-barra" aria-label="Año">
        <p-select [options]="anios" optionLabel="label" optionValue="value" [ngModel]="anio()" (ngModelChange)="cambiarAnio($event)" ariaLabel="Año" appendTo="body" class="cb-sel"
                  [disabled]="cambios().length > 0" />
        @if (cambios().length) { <span class="cb-sub">Guarda o descarta los cambios para cambiar de año.</span> }
        <span class="cb-espacio"></span>
        @if (data()) { <app-freshness-pill measures="fetch" [since]="leido()" label="presupuesto" /> }
        @if (puedeGestionar) {
          @if (cambios().length) {
            <button pButton type="button" size="small" [text]="true" severity="secondary" [disabled]="guardando()" (click)="descartar()"><span class="p-button-label">Descartar</span></button>
          }
          <button pButton type="button" size="small" [disabled]="!cambios().length || guardando()" (click)="guardar()">
            <span class="p-button-label">{{ guardando() ? 'Guardando…' : 'Guardar ' + cambios().length + ' cambio' + (cambios().length === 1 ? '' : 's') }}</span></button>
        }
      </section>

      @if (data(); as d) {
        <p class="cb-titular">{{ titular() }}</p>
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Presupuesto del año" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.unidades.length"
                      emptyIcon="pi-table" emptyTitle="Ninguna unidad de Transportes" emptyHint="Marca el área «Transportes» en la ficha de cada unidad." (retry)="cargar()">
        <!--
          dt-matrix-ok: las columnas NO son campos de la unidad, son otra DIMENSIÓN (los rubros de
          costo, agrupados). Apilarla con dt-stack convertiría cada unidad en una lista de ~30
          pares etiqueta/valor y rompería lo único que hace útil a esta pantalla: comparar el mismo
          rubro entre unidades de un vistazo, y capturarlo en la rejilla. El eje NO se pierde en
          estrecho porque la columna «Unidad» va congelada (surf-table--frozen-first) y el
          desplazamiento horizontal vive acotado a dt-scope. Regla: DESIGN_TABLES.md §"Tabla estrecha".
        -->
        <div class="dt-scope cb-scroll">
          <p-table [value]="data()?.unidades ?? []" dataKey="vehicle_id" size="small"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-matrix-ok" [tableStyle]="{ 'min-width': '150rem' }">
            <ng-template #header>
              <tr>
                <th scope="col" rowspan="2">Unidad</th>
                @for (g of grupos; track g) { <th scope="colgroup" [attr.colspan]="rubrosDe(g).length" class="cb-grupo">{{ grupoLabel(g) }}</th> }
                <th scope="col" rowspan="2" class="comm-num">Total anual</th>
              </tr>
              <tr>
                @for (r of rubros; track r.codigo) { <th scope="col" class="comm-num cb-th">{{ r.etiqueta }}</th> }
              </tr>
            </ng-template>
            <ng-template #body let-u>
              <tr>
                <td data-label="Unidad"><span class="cb-unidad">{{ u.economic_number ?? 'Sin número' }}</span><span class="cb-sub">{{ u.nombre }}</span></td>
                @for (r of rubros; track r.codigo) {
                  <td [attr.data-label]="r.etiqueta" class="comm-num">
                    @if (puedeGestionar) {
                      <p-inputnumber [ngModel]="valor(u.vehicle_id, r.codigo)" (ngModelChange)="editar(u.vehicle_id, r.codigo, $event)"
                                     mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="0" [maxFractionDigits]="2" [min]="0"
                                     [ariaLabel]="r.etiqueta + ' de ' + (u.economic_number ?? u.nombre)" class="cb-in" [class.cb-cambio]="cambiado(u.vehicle_id, r.codigo)" />
                    } @else {
                      {{ valor(u.vehicle_id, r.codigo) != null ? (valor(u.vehicle_id, r.codigo) | currency:'MXN':'symbol-narrow':'1.0-2') : '—' }}
                    }
                  </td>
                }
                <td data-label="Total anual" class="comm-num cb-fuerte">{{ totalUnidad(u.vehicle_id) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr>
                <td>Flota</td>
                @for (r of rubros; track r.codigo) { <td class="comm-num">{{ totalRubro(r.codigo) | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                <td class="comm-num cb-fuerte">{{ totalAnio() | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cb { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .cb-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .cb-sel { min-width: 8rem; }
    .cb-espacio { flex: 1; }
    .cb-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cb-scroll { overflow-x: auto; }
    .cb-grupo { text-align: center; font-size: var(--fs-xs); color: var(--text-muted); }
    .cb-th { white-space: normal; min-width: 8rem; }
    .cb-unidad { font-weight: var(--fw-medium); }
    .cb-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .cb-fuerte { font-weight: var(--fw-bold); }
    .cb-in { width: 8rem; }
    .cb-cambio { outline: 2px solid var(--action); outline-offset: 1px; border-radius: var(--r-sm); }
  `],
})
export class LogisticaCostoUnidadPresupuestoComponent {
  private readonly api = inject(LogisticaService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);

  readonly tabs = [...COSTO_UNIDAD_TABS];
  readonly grupos = GRUPOS;
  readonly rubros = [...RUBROS_COSTO_UNIDAD];
  /** Gestionar: la clave exacta, o rol de plataforma (lo mismo que decide el backend). */
  get puedeGestionar(): boolean { return this.perms.has(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR); }
  private readonly hoy = new Date().getFullYear();
  readonly anios = [this.hoy - 1, this.hoy, this.hoy + 1].map((a) => ({ value: a, label: String(a) }));
  readonly anio = signal(this.hoy);

  readonly data = signal<PresupuestoAnio | null>(null);
  readonly leido = signal(new Date().toISOString());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardando = signal(false);
  private readonly editado = signal(new Map<string, number | null>());

  readonly cambios = computed(() => {
    const d = this.data();
    return d ? celdasCambiadas(d, this.editado()) : [];
  });

  valor(v: string, r: RubroCodigo): number | null {
    const k = `${v}|${r}`;
    const e = this.editado();
    if (e.has(k)) return e.get(k) ?? null;
    return this.data()?.unidades.find((u) => u.vehicle_id === v)?.montos[r] ?? null;
  }
  cambiado(v: string, r: RubroCodigo): boolean { return this.cambios().some((c) => c.vehicle_id === v && c.rubro === r); }
  editar(v: string, r: RubroCodigo, x: number | null): void {
    this.editado.update((m) => new Map(m).set(`${v}|${r}`, x == null ? null : Number(x)));
  }
  totalUnidad(v: string): number { return Math.round(this.rubros.reduce((a, r) => a + (this.valor(v, r.codigo) ?? 0), 0) * 100) / 100; }
  totalRubro(r: RubroCodigo): number { return (this.data()?.unidades ?? []).reduce((a, u) => a + (this.valor(u.vehicle_id, r) ?? 0), 0); }
  readonly totalAnio = computed(() => {
    this.editado();
    return Math.round((this.data()?.unidades ?? []).reduce((a, u) => a + this.totalUnidad(u.vehicle_id), 0) * 100) / 100;
  });
  rubrosDe(g: GrupoRubro) { return this.rubros.filter((r) => r.grupo === g); }
  grupoLabel(g: GrupoRubro): string { return GRUPO_RUBRO_LABEL[g]; }

  readonly titular = computed(() => {
    const d = this.data();
    if (!d) return '';
    const conPres = d.unidades.filter((u) => u.total > 0).length;
    return `${d.anio}: $${this.totalAnio().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} presupuestados para ${conPres} de ${d.unidades.length} unidades.`
      + (this.cambios().length ? ` Hay ${this.cambios().length} cambio${this.cambios().length === 1 ? '' : 's'} sin guardar.` : '');
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const sin = d.unidades.filter((u) => u.total === 0).length;
    return [
      { label: 'Presupuesto del año', value: this.totalAnio(), format: 'currency' },
      { label: 'Por mes', value: Math.round((this.totalAnio() / 12) * 100) / 100, format: 'currency' },
      { label: 'Unidades sin presupuesto', value: sin, format: 'number', tone: sin ? 'warn' : 'ok' },
    ];
  });

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.costoUnidadPresupuesto(this.anio()).subscribe({
      next: (d) => { this.data.set(d); this.editado.set(new Map()); this.leido.set(new Date().toISOString()); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudo leer el presupuesto.'); },
    });
  }

  descartar(): void { this.editado.set(new Map()); }

  cambiarAnio(a: number): void {
    if (this.cambios().length) return;
    this.anio.set(Number(a));
    this.data.set(null);
    this.cargar();
  }

  guardar(): void {
    const celdas = this.cambios();
    if (!celdas.length || this.guardando()) return;
    this.guardando.set(true);
    this.api.costoUnidadGuardarPresupuesto(this.anio(), celdas).subscribe({
      next: (d) => {
        this.guardando.set(false);
        this.data.set(d);
        this.editado.set(new Map());
        this.toast.add({ severity: 'success', summary: `${celdas.length} celda${celdas.length === 1 ? '' : 's'} guardada${celdas.length === 1 ? '' : 's'}`, life: 2500 });
      },
      error: (e) => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se guardó el presupuesto', detail: e?.error?.message ?? '' }); },
    });
  }
}
