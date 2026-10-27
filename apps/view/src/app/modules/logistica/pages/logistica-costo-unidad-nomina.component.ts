import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { MetodoReparto, NominaAdministrativaMes } from '@megadulces/contracts';
import { METODO_REPARTO_LABEL } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LogisticaService } from '../logistica.service';
import { COSTO_UNIDAD_TABS } from '../costo-unidad-tabs';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** `[FCU.3.6]` Los 12 meses del año, con lo capturado (o vacío, para capturarlo). */
export function mesesDelAnio(anio: number, capturados: NominaAdministrativaMes[]): Array<NominaAdministrativaMes & { capturado: boolean; nombre: string }> {
  return MESES.map((nombre, i) => {
    const ym = `${anio}-${String(i + 1).padStart(2, '0')}`;
    const c = capturados.find((x) => x.year_month === ym);
    return c ? { ...c, capturado: true, nombre } : { year_month: ym, sueldos_admin: 0, gastos_directos: 0, metodo: 'km' as MetodoReparto, notes: null, capturado: false, nombre };
  });
}

/**
 * `[FCU.3.6]` — **Nómina administrativa de Logística, mes por mes.**
 *
 * La pregunta que contesta: ¿cuánto cuesta el personal administrativo de Logística y cómo se reparte
 * entre las unidades? No está en Kepler: se captura aquí. Reemplaza el «SUELDOS ADMIN» de la hoja,
 * que ponía $82,000 idéntico en las 15 fichas (no salía de dividir nada). Se reparte por los km del
 * GPS de cada unidad en el mes (o en partes iguales), y la unidad sin km queda fuera y se dice.
 *
 * ⚠️ Dato sensible: sólo la ve y la captura quien gestiona Costo por unidad.
 *
 * Jerarquía: primario = lo capturado en el año y los meses que faltan; secundario = la fila por mes.
 */
@Component({
  selector: 'app-logistica-costo-unidad-nomina',
  standalone: true,
  imports: [CurrencyPipe, FormsModule, TableModule, SelectModule, ButtonModule, InputNumberModule, InputTextModule, ToastModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cn">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo por unidad</h1>
          <p class="surf-page-sub">La nómina administrativa de Logística y los gastos directos de cada mes, y cómo se reparten entre las unidades de Transportes. No están en Kepler: se capturan aquí.</p>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de costo por unidad" />

      <section class="cn-barra" aria-label="Año">
        <p-select [options]="anios" optionLabel="label" optionValue="value" [ngModel]="anio()" (ngModelChange)="cambiarAnio($event)" ariaLabel="Año" appendTo="body" class="cn-sel"
                  [disabled]="hayCambios()" />
        @if (hayCambios()) { <span class="cn-sub">Guarda o descarta los meses cambiados para cambiar de año.</span>
          <button pButton type="button" size="small" [text]="true" severity="secondary" (click)="descartar()"><span class="p-button-label">Descartar</span></button> }
        <span class="cn-espacio"></span>
        @if (data()) { <app-freshness-pill measures="fetch" [since]="leido()" label="nómina capturada" /> }
      </section>

      @if (data()) {
        <p class="cn-titular">{{ titular() }}</p>
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Nómina administrativa del año" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
        <div class="dt-scope">
          <p-table [value]="filas()" dataKey="year_month" size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack" [tableStyle]="{ 'min-width': '52rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Mes</th>
                <th scope="col" class="comm-num">Sueldos administrativos</th>
                <th scope="col" class="comm-num">Gastos directos</th>
                <th scope="col">Cómo se reparte</th>
                <th scope="col">Notas</th>
                <th scope="col"><span class="sr-only">Guardar</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-m>
              <tr [class.cn-falta]="!m.capturado">
                <td data-label="Mes">{{ m.nombre }}<span class="cn-sub">{{ m.capturado ? 'capturado' : 'sin capturar' }}</span></td>
                <td data-label="Sueldos administrativos" class="comm-num">
                  <p-inputnumber [ngModel]="m.sueldos_admin" (ngModelChange)="editar(m.year_month, 'sueldos_admin', $event)" mode="currency" currency="MXN" locale="es-MX" [min]="0" [ariaLabel]="'Sueldos administrativos de ' + m.nombre" class="cn-in" />
                </td>
                <td data-label="Gastos directos" class="comm-num">
                  <p-inputnumber [ngModel]="m.gastos_directos" (ngModelChange)="editar(m.year_month, 'gastos_directos', $event)" mode="currency" currency="MXN" locale="es-MX" [min]="0" [ariaLabel]="'Gastos directos de ' + m.nombre" class="cn-in" />
                </td>
                <td data-label="Cómo se reparte">
                  <p-select [options]="metodos" optionLabel="label" optionValue="value" [ngModel]="m.metodo" (ngModelChange)="editar(m.year_month, 'metodo', $event)" appendTo="body" [ariaLabel]="'Reparto de ' + m.nombre" />
                </td>
                <td data-label="Notas"><input pInputText [ngModel]="m.notes ?? ''" (ngModelChange)="editar(m.year_month, 'notes', $event)" [attr.aria-label]="'Notas de ' + m.nombre" maxlength="500" /></td>
                <td>
                  <button pButton type="button" size="small" [outlined]="true" [disabled]="!sucio(m.year_month) || guardando() === m.year_month" (click)="guardar(m.year_month)">
                    <span class="p-button-label">{{ guardando() === m.year_month ? 'Guardando…' : 'Guardar' }}</span></button>
                </td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr>
                <td>Año</td>
                <td class="comm-num">{{ total('sueldos_admin') | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="comm-num">{{ total('gastos_directos') | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td></td><td></td><td></td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cn { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .cn-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .cn-sel { min-width: 8rem; }
    .cn-espacio { flex: 1; }
    .cn-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cn-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .cn-falta .cn-sub { color: var(--warn-soft-fg); }
    .cn-in { width: 10rem; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class LogisticaCostoUnidadNominaComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  readonly tabs = [...COSTO_UNIDAD_TABS];
  readonly metodos = (Object.keys(METODO_REPARTO_LABEL) as MetodoReparto[]).map((v) => ({ value: v, label: METODO_REPARTO_LABEL[v] }));
  private readonly hoy = new Date().getFullYear();
  readonly anios = [this.hoy - 1, this.hoy, this.hoy + 1].map((a) => ({ value: a, label: String(a) }));
  readonly anio = signal(this.hoy);

  readonly data = signal<NominaAdministrativaMes[] | null>(null);
  readonly leido = signal(new Date().toISOString());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardando = signal<string | null>(null);
  private readonly editado = signal(new Map<string, Partial<NominaAdministrativaMes>>());

  readonly filas = computed(() => mesesDelAnio(this.anio(), this.data() ?? []).map((m) => ({ ...m, ...(this.editado().get(m.year_month) ?? {}) })));
  sucio(ym: string): boolean { return this.editado().has(ym); }
  readonly hayCambios = computed(() => this.editado().size > 0);
  descartar(): void { this.editado.set(new Map()); }
  total(k: 'sueldos_admin' | 'gastos_directos'): number { return this.filas().filter((m) => m.capturado).reduce((a, m) => a + Number(m[k] ?? 0), 0); }

  readonly titular = computed(() => {
    const f = this.filas();
    const cap = f.filter((m) => m.capturado);
    const hastaMes = this.anio() === this.hoy ? new Date().getMonth() + 1 : 12;
    const faltan = f.slice(0, hastaMes).filter((m) => !m.capturado).map((m) => m.nombre.toLowerCase());
    const $ = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (!cap.length) return `${this.anio()}: no hay nada capturado. Sin esto, el rubro «Sueldos administrativos» de cada unidad queda «falta capturar».`;
    return `${this.anio()}: ${cap.length} mes${cap.length === 1 ? '' : 'es'} capturado${cap.length === 1 ? '' : 's'}, ${$(this.total('sueldos_admin') + this.total('gastos_directos'))} en total.`
      + (faltan.length ? ` Faltan: ${faltan.join(', ')}.` : '');
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const cap = this.filas().filter((m) => m.capturado);
    return [
      { label: 'Sueldos administrativos', value: this.total('sueldos_admin'), format: 'currency' },
      { label: 'Gastos directos', value: this.total('gastos_directos'), format: 'currency' },
      { label: 'Meses capturados', value: cap.length, format: 'number', tone: cap.length ? 'ok' : 'warn' },
    ];
  });

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.costoUnidadNomina(this.anio()).subscribe({
      next: (d) => { this.data.set(d); this.editado.set(new Map()); this.leido.set(new Date().toISOString()); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudo leer la nómina administrativa.'); },
    });
  }

  cambiarAnio(a: number): void {
    if (this.hayCambios()) return;
    this.anio.set(Number(a));
    this.data.set(null);
    this.cargar();
  }

  editar(ym: string, k: keyof NominaAdministrativaMes, v: unknown): void {
    this.editado.update((m) => new Map(m).set(ym, { ...(m.get(ym) ?? {}), [k]: k === 'notes' ? (String(v ?? '') || null) : k === 'metodo' ? v : Number(v ?? 0) }));
  }

  guardar(ym: string): void {
    const m = this.filas().find((x) => x.year_month === ym);
    if (!m || this.guardando()) return;
    this.guardando.set(ym);
    this.api.costoUnidadGuardarNomina({ year_month: ym, sueldos_admin: Number(m.sueldos_admin), gastos_directos: Number(m.gastos_directos), metodo: m.metodo, notes: m.notes }).subscribe({
      next: (d) => {
        this.guardando.set(null);
        this.data.set(d);
        this.editado.update((x) => { const n = new Map(x); n.delete(ym); return n; });
        this.toast.add({ severity: 'success', summary: `${m.nombre} guardado`, life: 2500 });
      },
      error: (e) => { this.guardando.set(null); this.toast.add({ severity: 'error', summary: 'No se guardó', detail: e?.error?.message ?? '' }); },
    });
  }
}
