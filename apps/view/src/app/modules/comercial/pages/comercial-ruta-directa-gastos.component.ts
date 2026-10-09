import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import {
  ComercialService, RouteProfitGasto, RouteProfitGastoRenglon, RouteProfitPeriodo,
} from '../comercial.service';

/**
 * `[RD.60]` — **Gasto de flota, renglón por renglón.**
 *
 * Es la hoja `CONTROL DE GASTOS RD` del libro (2,066 renglones), con la diferencia de que acá
 * los renglones **ya existen**: salen de la contabilidad, no se capturan. La pestaña «Por plaza»
 * de Rentabilidad muestra el mismo gasto **agregado**; ésta muestra el movimiento.
 *
 * ── ⭐ El comentario es el dato que nadie estaba mirando ──────────────────────────────────
 * Medido en la quincena 20: **95 renglones, 89 con comentario**. Y el comentario dice cosas:
 * *«ARRENDAMIENTO NP300 RD PH»* $18,525.86 · *«ROTULACIÓN CAMIONETA PIN PON»* $7,000 ·
 * *«LONA PARA CAMIONETA DE RD»* $350.
 *
 * ⛔ **Se muestra como texto y no se parsea.** A veces nombra la camioneta, pero derivar la ruta
 * de una cadena escrita a mano sería adivinar — y la contabilidad, estructuralmente, llega al
 * departamento y no al camión.
 *
 * ── Lo que el libro tenía y esto no ──────────────────────────────────────────────────────
 * **Los litros.** No existen en ninguna fuente: el CFDI guarda sólo el encabezado y el XML
 * completo está en 105 de 6,241 facturas del proveedor de combustible. Por eso no hay `$/litro`.
 */
@Component({
  selector: 'app-comercial-ruta-directa-gastos',
  standalone: true,
  imports: [FormsModule, LoadStateComponent, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gf">
      <header class="gf-head">
        <div>
          <h1>Gasto de flota</h1>
          <p class="gf-sub">
            Cada movimiento de los tres departamentos de Ruta Directa, con su concepto y su
            comentario. Sale de la contabilidad: nadie lo captura dos veces.
          </p>
        </div>
        @if (data(); as d) {
          <div class="gf-period">
            <label for="gf-sel">Quincena</label>
            <select id="gf-sel" [value]="periodKey()" (change)="elegir($any($event.target).value)">
              @for (p of periodos(); track p.id) {
                <option [value]="p.anio + '|' + p.period_no">
                  Q{{ p.period_no }} · {{ dia(p.date_from) }} al {{ dia(p.date_to) }}
                </option>
              }
            </select>
          </div>
        }
      </header>

      <app-load-state
        [loading]="cargando()" [isEmpty]="!data()" [skeletonRows]="8"
        emptyIcon="pi-receipt" emptyTitle="Sin movimientos"
        emptyHint="Esa quincena no tiene gasto registrado en los departamentos de Ruta Directa.">

        @if (data(); as d) {
          <section class="gf-tira" aria-label="Gasto por familia">
            @for (f of d.por_familia; track f.familia) {
              <button type="button" class="gf-chip" [class.gf-on]="familia() === f.familia"
                      (click)="toggleFamilia(f.familia)">
                <span class="gf-chip-l">{{ etiquetaFamilia(f.familia) }}</span>
                <span class="gf-chip-v mono">{{ dinero(f.importe) }}</span>
                <span class="gf-chip-n">{{ f.lineas }} renglones</span>
              </button>
            }
          </section>

          <p class="gf-proc">
            <b>{{ dinero(d.total) }}</b> en la quincena del {{ dia(d.date_from) }} al
            {{ dia(d.date_to) }} · {{ d.renglones.length }} renglones a la vista
            @if (familia()) { · filtrando <b>{{ etiquetaFamilia(familia()!) }}</b> }
          </p>

          @if (d.huecos.length) {
            <section class="gf-gaps" aria-label="Lo que este gasto no dice">
              <h2>Lo que este gasto no dice</h2>
              <ul>
                @for (h of d.huecos; track h.clave) {
                  <li><b>{{ etiquetaHueco(h.clave) }}</b> — {{ h.detalle }}</li>
                }
              </ul>
            </section>
          }

          <app-segmented [options]="vistas" [value]="vista()" (valueChange)="vista.set($event)"
                         ariaLabel="Cómo se ordena" />

          <div class="gf-wrap dt-scope">
            <table class="gf-table dt-stack">
              <caption class="sr-only">Movimientos de gasto de la quincena</caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Plaza</th>
                  <th scope="col">Concepto</th>
                  <th scope="col">Qué dice el comentario</th>
                  <th scope="col">Documento</th>
                  <th scope="col" class="num">Importe</th>
                </tr>
              </thead>
              <tbody>
                @for (r of visibles(); track r.doc_tipo + r.doc_folio + r.fecha + r.importe) {
                  <tr>
                    <td role="cell" data-label="Fecha" class="mono dt-id">{{ dia(r.fecha) }}</td>
                    <td role="cell" data-label="Plaza">
                      {{ r.plaza || r.dpto_norm }}
                      @if (!r.plaza) { <span class="gf-nd">sin rutas</span> }
                    </td>
                    <td role="cell" data-label="Concepto">
                      {{ r.concepto_norm || '—' }}
                      <span class="gf-fam">{{ etiquetaFamilia(r.familia) }}</span>
                    </td>
                    <td role="cell" data-label="Qué dice el comentario">
                      @if (r.comentario) { {{ r.comentario }} }
                      @else { <span class="gf-nd">sin comentario</span> }
                    </td>
                    <td role="cell" data-label="Documento" class="mono dim">
                      {{ r.doc_tipo || '—' }} {{ r.doc_folio || '' }}
                    </td>
                    <td role="cell" data-label="Importe" class="num dt-num mono fuerte">
                      {{ dinero(r.importe) }}
                    </td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5">
                    {{ visibles().length }} renglones a la vista
                    @if (familia()) { de {{ d.renglones.length }} }
                  </td>
                  <td class="num mono fuerte">{{ dinero(sumaVisible()) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p class="gf-mini">
            ⛔ El total de arriba (<b>{{ dinero(d.total) }}</b>) es el de la <b>quincena entera</b>;
            el de aquí abajo es el de lo que estás viendo. No son lo mismo cuando hay un filtro
            puesto, y por eso se dicen los dos.
          </p>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    .gf { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .gf-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .gf-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .gf-sub { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--c-text-3); max-width: 74ch; line-height: 1.5; }
    .gf-period { display: flex; align-items: center; gap: 8px; }
    .gf-period label { font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .gf-period select {
      padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px;
      background: var(--card-bg); color: var(--c-text-1); font-size: var(--fs-sm);
    }

    .gf-tira { display: flex; gap: 10px; flex-wrap: wrap; }
    .gf-chip {
      display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
      border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 14px;
      background: var(--card-bg); cursor: pointer; text-align: left; min-width: 140px;
    }
    .gf-on { border-color: var(--action); }
    .gf-chip-l { font-size: var(--fs-micro); color: var(--c-text-3); text-transform: uppercase; letter-spacing: .06em; }
    .gf-chip-v { font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .gf-chip-n { font-size: var(--fs-micro); color: var(--c-text-3); }

    .gf-proc { margin: 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .gf-gaps {
      border: 1px solid var(--border-color); border-left: 3px solid var(--c-warn);
      border-radius: 8px; padding: 12px 14px; background: var(--card-bg);
    }
    .gf-gaps h2 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .gf-gaps ul { margin: 8px 0 0; padding-left: 18px; }
    .gf-gaps li { font-size: var(--fs-sm); color: var(--c-text-2); line-height: 1.6; }

    .gf-wrap { overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px; }
    .gf-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .gf-table th {
      text-align: left; padding: 9px 11px; font-weight: var(--fw-medium);
      color: var(--c-text-3); font-size: var(--fs-micro);
      border-bottom: 1px solid var(--border-color); white-space: nowrap;
    }
    .gf-table td { padding: 9px 11px; border-bottom: 1px solid var(--border-color); color: var(--c-text-2); }
    .gf-table tfoot td { border-bottom: none; border-top: 1px solid var(--border-color); color: var(--c-text-1); }
    .gf-table .num { text-align: right; }
    .mono { font-variant-numeric: tabular-nums; }
    .dim { color: var(--c-text-3); }
    .fuerte { color: var(--c-text-1); font-weight: var(--fw-medium); }
    .gf-nd { color: var(--c-text-3); font-size: var(--fs-micro); margin-left: 4px; }
    .gf-fam {
      display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
      border: 1px solid var(--border-color); font-size: var(--fs-micro); color: var(--c-text-3);
    }
    .gf-mini { margin: 0; font-size: var(--fs-micro); color: var(--c-text-3); line-height: 1.6; }

    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class ComercialRutaDirectaGastosComponent {
  private readonly svc = inject(ComercialService);

  readonly cargando = signal(true);
  readonly data = signal<RouteProfitGasto | null>(null);
  readonly periodos = signal<RouteProfitPeriodo[]>([]);
  readonly anio = signal(new Date().getFullYear());
  readonly periodNo = signal(1);
  readonly familia = signal<string | null>(null);
  readonly vista = signal('monto');

  readonly vistas: SegOption[] = [
    { label: 'Lo más caro primero', value: 'monto' },
    { label: 'Lo más reciente primero', value: 'fecha' },
  ];

  readonly periodKey = computed(() => `${this.anio()}|${this.periodNo()}`);

  readonly visibles = computed(() => {
    const d = this.data();
    if (!d) return [];
    const f = this.familia();
    const base = f ? d.renglones.filter((r) => r.familia === f) : d.renglones;
    // El servidor ya los manda por fecha y luego por importe; acá sólo se cambia el eje.
    return this.vista() === 'monto'
      ? [...base].sort((a, b) => Math.abs(Number(b.importe)) - Math.abs(Number(a.importe)))
      : base;
  });

  readonly sumaVisible = computed(() =>
    this.visibles().reduce((a, r) => a + Number(r.importe), 0));

  constructor() {
    this.svc.routeProfitPeriodos().subscribe({
      next: (p) => {
        this.periodos.set(p);
        if (p.length) { this.anio.set(p[0].anio); this.periodNo.set(p[0].period_no); }
        this.cargar();
      },
      error: () => { this.periodos.set([]); this.cargar(); },
    });
  }

  elegir(key: string): void {
    const [a, n] = key.split('|');
    this.anio.set(Number(a));
    this.periodNo.set(Number(n));
    this.cargar();
  }

  toggleFamilia(f: string): void {
    this.familia.set(this.familia() === f ? null : f);
  }

  private cargar(): void {
    this.cargando.set(true);
    this.svc.routeProfitGasto(this.anio(), this.periodNo()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: () => { this.data.set(null); this.cargando.set(false); },
    });
  }

  etiquetaFamilia(f: string): string {
    const m: Record<string, string> = {
      combustible: 'Combustible', personal: 'Personal y comisiones', vehiculo: 'Vehículo',
      viaje: 'Viaje y casetas', valores: 'Traslado de valores', local: 'Local y servicios',
      tecnologia: 'Tecnología', otros: 'Otros',
    };
    return m[f] ?? f;
  }

  etiquetaHueco(c: string): string {
    const m: Record<string, string> = {
      gasto_no_baja_a_la_ruta: 'El gasto llega al departamento',
      tabla_topada: 'La tabla está topada',
    };
    return m[c] ?? c;
  }

  dinero(v: string | number | null): string {
    if (v === null || v === undefined || v === '') return '—';
    return Number(v).toLocaleString('es-MX', {
      style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  /** La fecha llega como texto YYYY-MM-DD desde el servidor, sin pasar por Date. */
  dia(iso: string | null): string {
    if (!iso) return '—';
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }
}
