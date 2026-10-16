import { ChangeDetectionStrategy, Component, computed, inject, input, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ComercialService, RouteCreditSales, RouteCreditSaleRow, RouteCreditCobranza } from '../comercial.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

/**
 * `[VEC.21]` — **La venta a CRÉDITO de la ruta: factura → cobro → cuenta.**
 *
 * Edgar, 2026-10-15: *"se llama telemarketing pero son ventas a crédito que después… hay que
 * agregarlas aquí y cazarlas con su depósito"*.
 *
 * ⛔ `U-D-8` se publicaba como *"venta de otro canal"* y quedaba FUERA del total de la ruta,
 * esperando una decisión de negocio que **el ERP ya había tomado**: Kepler lo registra como
 * **cargo en cartera** (`UD0801`), con cliente, vencimiento, saldo y estatus.
 *
 * ⭐ Es un componente aparte y no un bloque dentro de la pantalla porque lo piden **dos**:
 * `/comercial/ventas-por-ruta` y `/comercial/documentos`. Con `route` muestra el crédito de esa
 * ruta; sin `route`, el de todas.
 *
 * ⛔ `U-D-12` NO entra: en estas rutas re-emite el mismo ticket (98.2 % de solape, placebo 0, y
 * el arqueo lo ignora). Lo que se publica acá es el crédito de verdad.
 */
@Component({
  selector: 'app-route-credit',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, LoadStateComponent, MetricStripComponent],
  template: `
    <section class="rc-panel">
      <button type="button" class="rc-head" (click)="toggle()" [attr.aria-expanded]="open()">
        <i class="pi" [class.pi-chevron-right]="!open()" [class.pi-chevron-down]="open()" aria-hidden="true"></i>
        <span class="rc-title">Venta a crédito de la ruta</span>
        @if (data(); as d) {
          @if (d.summary.facturas_vencidas) {
            <p-tag [value]="d.summary.facturas_vencidas + ' vencida(s)'" severity="danger" />
          } @else if (d.summary.facturas) {
            <p-tag value="sin vencidas" severity="success" />
          }
        }
        <span class="rc-hint">factura → cobro → cuenta</span>
      </button>

      @if (open()) {
        <div class="rc-body">
          <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!filas().length"
                          [skeletonRows]="6" emptyIcon="pi-file"
                          emptyTitle="Esta ruta no facturó a crédito en el período"
                          emptyHint="El crédito de ruta es U-D-8, que Kepler registra como cargo en cartera. Ampliá el rango si esperabas verlo."
                          (retry)="reload()">
            @if (data(); as d) {
              <app-metric-strip [items]="kpis()" ariaLabel="Venta a crédito de la ruta" />

              <!-- ⛔ El grano es el DOCUMENTO: cada factura con su cobro. No se agrega por dia
                   porque la pregunta es "esta factura, ¿la cobraron?", no "cuanto se facturo". -->
              <div class="dt-scope">
              <p-table [value]="filas()" class="dt-stack surf-table surf-table--plain surf-table--sticky"
                       size="small" [rowHover]="true" [scrollable]="true" scrollHeight="44vh"
                       [tableStyle]="{ 'min-width': '62rem' }">
                <ng-template #header>
                  <tr>
                    <th scope="col">Factura</th>
                    <th scope="col">Fecha</th>
                    <th scope="col">Vence</th>
                    <th scope="col">Cliente</th>
                    <th scope="col" class="comm-num">Importe</th>
                    <th scope="col" class="comm-num">Cobrado</th>
                    <th scope="col" class="comm-num">Saldo</th>
                    <th scope="col">Cobranza</th>
                    <th scope="col">¿Dónde entró el dinero?</th>
                  </tr>
                </ng-template>
                <ng-template #body let-f>
                  <tr>
                    <td class="rc-mono" role="cell" data-label="Factura">
                      {{ f.folio }}
                      @if (!rutaFija()) { <span class="rc-tenue"> · {{ f.route_no }}</span> }
                    </td>
                    <td class="rc-mono" role="cell" data-label="Fecha">{{ f.fecha }}</td>
                    <td class="rc-mono" role="cell" data-label="Vence">
                      @if (f.vence) { {{ f.vence }} } @else { <span class="rc-tenue">—</span> }
                    </td>
                    <td class="rc-mono rc-tenue" role="cell" data-label="Cliente">{{ f.cliente_code ?? '—' }}</td>
                    <td class="comm-num rc-mono" role="cell" data-label="Importe">{{ money(f.importe) }}</td>
                    <td class="comm-num rc-mono" role="cell" data-label="Cobrado">{{ money(f.cobrado) }}</td>
                    <td class="comm-num rc-mono rc-strong" role="cell" data-label="Saldo"
                        [class.rc-bad]="f.cobranza === 'vencida'">{{ money(f.saldo) }}</td>
                    <td role="cell" data-label="Cobranza">
                      <p-tag [value]="etiqueta(f)" [severity]="severidad(f.cobranza)" />
                    </td>
                    <td role="cell" data-label="¿Dónde entró el dinero?">
                      <!-- ⛔ Sin abonos NO se escribe "efectivo" ni nada: se dice que no se cobró.
                           Y un abono sin cuenta se declara como no resuelto, no como caja. -->
                      @if (!f.abonos.length) { <span class="rc-tenue">todavía no se cobró</span> }
                      @else {
                        <ul class="rc-abonos">
                          @for (a of f.abonos; track a.folio) {
                            <li>
                              <span class="rc-mono">{{ a.folio }}</span>
                              <span class="rc-tenue"> {{ a.fecha ?? '' }}</span>
                              @if (a.cuenta) { <strong> {{ a.cuenta }}</strong> }
                              @else { <span class="rc-warn"> sin cuenta resuelta</span> }
                              <span class="rc-mono rc-tenue"> {{ money(a.monto) }}</span>
                            </li>
                          }
                        </ul>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              </div>

              <p class="rc-nota">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>
                  En Kepler esto se llama <span class="rc-mono">«Factura Telemarketing»</span>
                  (<span class="rc-mono">U-D-8</span>), pero es <strong>venta a crédito</strong>:
                  el propio ERP la registra como cargo en cartera con vencimiento y saldo.
                  «¿Dónde entró el dinero?» sale de la <strong>cuenta de tesorería</strong> del
                  cobro aplicado.
                  @if (d.summary.abonos) {
                    <strong>{{ d.summary.abonos_con_cuenta }}</strong> de
                    {{ d.summary.abonos }} abonos la declaran.
                  }
                  ⛔ La re-factura (<span class="rc-mono">U-D-12</span>) <strong>no entra</strong>:
                  en estas rutas re-emite el mismo ticket.
                </span>
              </p>
            }
          </app-load-state>
        </div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .rc-panel { border: 1px solid var(--border-color); border-radius: var(--r-md); margin-bottom: var(--sp-4); overflow: hidden; }
    .rc-head { width: 100%; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 0; background: transparent; font: inherit; text-align: left; cursor: pointer; }
    .rc-head:hover { background: var(--overlay-hover); }
    .rc-head:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .rc-title { font-weight: var(--fw-bold); font-size: var(--fs-sm); color: var(--text-main); }
    .rc-hint { margin-left: auto; font-size: var(--fs-micro); color: var(--text-faint); }
    .rc-body { padding: var(--sp-3); border-top: 1px solid var(--border-color); }
    .rc-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rc-tenue { color: var(--text-faint); }
    .rc-strong { font-weight: var(--fw-bold); }
    .rc-bad { color: var(--bad-fg); }
    .rc-warn { color: var(--warn-fg); }
    .rc-abonos { margin: 0; padding: 0; list-style: none; font-size: var(--fs-micro); line-height: 1.5; }
    .rc-nota { display: flex; gap: var(--sp-2); align-items: flex-start; margin: var(--sp-3) 0 0;
      font-size: var(--fs-micro); color: var(--text-muted); line-height: 1.5; }
    .rc-nota .pi { margin-top: 2px; color: var(--text-faint); }
  `],
})
export class RouteCreditComponent {
  private readonly api = inject(ComercialService);

  /** La ruta a mostrar. Vacío = todas (así lo usa `/comercial/documentos`). */
  readonly route = input<string>('');
  readonly from = input<string>('');
  readonly to = input<string>('');

  readonly open = signal(false);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<RouteCreditSales | null>(null);

  /** Con ruta fija la columna de ruta sobra: ya está en el encabezado de la pantalla. */
  readonly rutaFija = computed(() => !!this.route());
  readonly filas = computed<RouteCreditSaleRow[]>(() => this.data()?.filas ?? []);

  readonly kpis = computed<MetricStripItem[]>(() => {
    const s = this.data()?.summary;
    if (!s) return [];
    return [
      { label: 'Facturado', value: s.facturado, format: 'currency', sub: `${s.facturas} factura(s)` },
      { label: 'Cobrado', value: s.cobrado, format: 'currency' },
      { label: 'Saldo', value: s.saldo, format: 'currency' },
      // ⭐ Lo vencido va aparte del saldo: es el número que mueve a alguien a hacer algo.
      { label: 'Vencido', value: s.vencido, format: 'currency', sub: `${s.facturas_vencidas} factura(s)` },
    ];
  });

  constructor() {
    // Al abrir, o al cambiar de ruta/rango con el panel abierto, se vuelve a pedir.
    effect(() => {
      const abierto = this.open();
      this.route(); this.from(); this.to();
      if (abierto) this.reload();
    });
  }

  toggle() { this.open.update((v) => !v); }

  reload() {
    this.cargando.set(true);
    this.error.set(null);
    this.api.routeCreditSales(this.from() || undefined, this.to() || undefined, this.route() || undefined)
      .subscribe({
        next: (r) => { this.data.set(r); this.cargando.set(false); },
        error: () => {
          this.error.set('No se pudo leer la venta a crédito de la ruta.');
          this.cargando.set(false);
        },
      });
  }

  /**
   * ⛔ Las CUATRO etiquetas son distintas a propósito. `sin_vencimiento` no es «vigente»: es que
   * el cargo no trae fecha y no hay con qué juzgarlo (ADR-056).
   */
  etiqueta(f: RouteCreditSaleRow): string {
    switch (f.cobranza) {
      case 'cobrada': return 'Cobrada';
      case 'vigente': return f.dias_vencida === null ? 'Vigente' : `Vence en ${-f.dias_vencida} d`;
      case 'vencida': return f.dias_vencida === null ? 'Vencida' : `Vencida ${f.dias_vencida} d`;
      default: return 'Sin vencimiento';
    }
  }

  severidad(c: RouteCreditCobranza): 'success' | 'danger' | 'warn' | 'secondary' {
    switch (c) {
      case 'cobrada': return 'success';
      case 'vencida': return 'danger';
      case 'vigente': return 'warn';
      default: return 'secondary';
    }
  }

  /** ⚠️ `Number()` antes de formatear: los `numeric` de Postgres llegan como string por JSON. */
  money(n: number | null): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })
      .format(Number(n));
  }
}
