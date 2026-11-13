import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import type { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { coincideBusqueda } from '@megadulces/ui-web';
import {
  grupoDeAnticipo, llaveAnticipo, neteableHoy, tipoDeAcreedor, warehouseName,
  type AnticipoDeudaRow, type AnticipoGrupo, type AnticipoRow,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { DEUDA_PROVEEDORES_TABS } from '../deuda-proveedores-tabs';

/** Un anticipo con lo que la pantalla deriva de él. */
interface Fila extends AnticipoRow { grupo: AnticipoGrupo }
interface Grupo { key: AnticipoGrupo; titulo: string; ayuda: string; filas: Fila[]; monto: number }

/**
 * `[PGP.118]` **Anticipos a proveedor** — el submódulo de *Deuda con proveedores*.
 *
 * Contesta UNA pregunta: *¿qué hay que hacer con cada anticipo que sigue sin aplicar?* La respuesta
 * es el grupo: aplicarlo (el acreedor tiene facturas abiertas), pedir factura o reembolso (no las
 * tiene) o nada aquí (es gasto o tarjeta capturado como `X-D-60`). Sólo lee: aplicar el anticipo lo
 * hace CxP en Kepler (D5) y programar uno nuevo es `[PGP.119]`.
 *
 * Diseño: las doce preguntas de la skill `diseno`, contestadas en `FASE_PGP_PAGO_A_PROVEEDOR.md`
 * §«El submódulo de Anticipos». Primario = el veredicto y lo aplicable hoy; secundario = la lista por
 * grupo; terciario = la referencia, lo aplicado y lo que no es de mercancía.
 *
 * ⛔ La deuda de los acreedores llega en una SEGUNDA llamada (~390-570 ms: no cabe con la lista en
 *    500 ms). Mientras no llega, esos anticipos dicen «calculando», nunca «sin contra qué» ni $0.
 */
@Component({
  selector: 'app-finanzas-anticipos',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, TableModule, TagModule, MetricStripComponent, LoadStateComponent,
    FreshnessPillComponent, PageTabsComponent, ContextHelpComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page an-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="surf-page-title">Anticipos a proveedor <app-context-help topic="anticipos-proveedor" /></h1>
          <p class="surf-page-sub">El dinero adelantado a proveedores que Kepler todavía no aplica a una factura: cuál se puede aplicar hoy y cuál no tiene contra qué.</p>
        </div>
        <div class="an-head-actions">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="cargar()" aria-label="Volver a leer">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>
      <app-page-tabs [tabs]="apartadoTabs" />

      <section class="an-body">
        <app-load-state [loading]="loading()" [error]="error()" [skeletonRows]="8" [isEmpty]="!loading() && !error() && !filas().length"
          errorTitle="No se pudieron leer los anticipos" emptyTitle="Sin anticipos por aplicar"
          emptyHint="Kepler no tiene ningún anticipo a proveedor con saldo." (retry)="cargar()"></app-load-state>

        @if (!loading() && !error() && filas().length) {
          <p class="an-veredicto">{{ veredicto() }}</p>
          @if (deudaError()) {
            <p class="an-aviso" role="status">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              No se pudo leer lo que les debemos a estos acreedores: no se puede decir cuáles se aplican hoy.
              <button pButton type="button" class="p-button-sm p-button-text" (click)="cargarDeuda()">Reintentar</button>
            </p>
          }
          <app-metric-strip [items]="kpis()" [instant]="true" ariaLabel="Anticipos a proveedor sin aplicar" />

          <div class="an-buscar">
            <label class="sr-only" for="an-q">Buscar anticipo</label>
            <input id="an-q" pInputText type="search" enterkeyhint="search" autocomplete="off" class="an-q"
              placeholder="Buscar acreedor, folio o referencia" [ngModel]="q()" (ngModelChange)="q.set($event)" />
            @if (q()) { <span class="an-count">{{ visibles() }} de {{ filas().length }}</span> }
          </div>

          @for (g of grupos(); track g.key) {
            <h2 class="an-h2">{{ g.titulo }} <span class="an-count">{{ g.filas.length }} · {{ money(g.monto) }}</span></h2>
            <p class="an-help">{{ g.ayuda }}</p>
            @if (g.filas.length) {
              <div class="dt-scope">
                <p-table [value]="g.filas" size="small" class="dt-stack surf-table surf-table--plain surf-table--sticky an-table">
                  <ng-template #header>
                    <tr>
                      <th>Acreedor</th><th>Documento en Kepler</th><th class="comm-num">Días</th>
                      <th class="comm-num">A favor</th><th>{{ g.key === 'no_mercancia' ? 'Tipo' : 'Contra qué se aplica' }}</th><th>Referencia</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr>
                      <td role="cell" data-label="Acreedor">
                        <div class="an-strong">{{ r.proveedor_nombre || r.proveedor }}</div>
                        <div class="an-muted">{{ r.proveedor }}</div>
                      </td>
                      <td role="cell" data-label="Documento en Kepler" class="an-nowrap">
                        <div>Anticipo {{ r.folio }} · {{ r.sucursal | sucursal }}</div>
                        <div class="an-muted">{{ r.fecha ? fecha(r.fecha) : 'sin fecha' }}</div>
                      </td>
                      <td role="cell" data-label="Días" class="comm-num">
                        @if (r.dias !== null && r.dias > 90) { <p-tag [value]="r.dias + ' días'" severity="warn" /> }
                        @else { {{ r.dias ?? '—' }} }
                      </td>
                      <td role="cell" data-label="A favor" class="comm-num">
                        <div class="an-strong">{{ money2(r.a_favor) }}</div>
                        @if (r.aplicado > 0.005) { <div class="an-muted">de {{ money2(r.importe) }}; aplicado {{ money2(r.aplicado) }}</div> }
                        @if (r.apartado > 0.005) { <div class="an-muted">{{ money2(r.apartado) }} ya apartado en el Calendario de pagos</div> }
                      </td>
                      <td role="cell" [attr.data-label]="g.key === 'no_mercancia' ? 'Tipo' : 'Contra qué se aplica'">{{ contraQue(r) }}</td>
                      <td role="cell" data-label="Referencia">
                        @if (r.referencia) { {{ r.referencia }} } @else { <span class="an-muted">sin referencia en Kepler</span> }
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            } @else {
              <p class="an-empty">{{ q() ? 'Ninguno coincide con la búsqueda.' : 'Ninguno.' }}</p>
            }
          }

          <details class="an-nomedido">
            <summary>Lo que esta pantalla no dice (3)</summary>
            <ul>
              <li>De qué cuenta salió cada anticipo: la vista de Kepler que se lee no la trae.</li>
              <li>A qué orden de compra corresponde: en Kepler la referencia es texto libre.</li>
              <li>Las facturas abiertas una por una: se ven en el Calendario de pagos, en el acreedor.</li>
            </ul>
          </details>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .an-page { display: block; }
    .an-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .an-body { padding: var(--sp-3) 1.5rem var(--sp-8); display: block; }
    .an-veredicto { font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); max-width: 72rem; }
    .an-aviso { font-size: var(--fs-sm); color: var(--text-main); margin: 0 0 var(--sp-3); display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    app-metric-strip { display: block; margin: 0 0 var(--sp-4); }
    .an-buscar { display: flex; align-items: center; gap: var(--sp-3); margin: 0 0 var(--sp-2); }
    .an-q { width: 100%; max-width: 28rem; }
    .an-h2 { font-size: var(--fs-md); font-weight: 600; color: var(--text-main); margin: var(--sp-6) 0 var(--sp-1); display: flex; gap: var(--sp-2); align-items: baseline; }
    .an-count { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .an-help { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-2); max-width: 72rem; }
    .an-empty { font-size: var(--fs-sm); color: var(--text-muted); margin: var(--sp-1) 0 var(--sp-2); }
    .an-strong { font-weight: 600; color: var(--text-main); }
    .an-muted { font-size: var(--fs-xs); color: var(--text-muted); }
    .an-nowrap { white-space: nowrap; }
    .an-table { display: block; margin-bottom: var(--sp-2); }
    .an-nomedido { margin-top: var(--sp-6); font-size: var(--fs-sm); color: var(--text-muted); }
    .an-nomedido summary { cursor: pointer; font-weight: 600; color: var(--text-main); }
    .an-nomedido summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .an-nomedido ul { margin: var(--sp-2) 0 0; padding-left: var(--sp-5); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) { .an-body { padding: var(--sp-2) 1rem var(--sp-6); } }
  `],
})
export class FinanzasAnticiposComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/payment-calendar`;
  private peticion?: Subscription;
  private peticionDeuda?: Subscription;

  readonly apartadoTabs = DEUDA_PROVEEDORES_TABS;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly filas = signal<AnticipoRow[]>([]);
  /** Lo que les debemos, por acreedor. `null` = todavía no llega (o falló): «calculando», nunca cero. */
  readonly deuda = signal<ReadonlyMap<string, AnticipoDeudaRow> | null>(null);
  readonly deudaError = signal(false);
  readonly cargadoEn = signal<Date | null>(null);
  readonly q = signal('');

  /**
   * La deuda viva de un acreedor EN LA SUCURSAL del anticipo; `null` mientras no se sabe. `[PGP.120]` Un
   * anticipo sólo se aplica contra facturas de su sucursal (Kepler: 115 de 115). Sin deuda ahí = cero.
   */
  deudaDe(proveedor: string, sucursal: string): number | null {
    const d = this.deuda();
    if (!d) return null;
    return d.get(llaveAnticipo(proveedor, sucursal))?.deuda ?? 0;
  }

  /** Todas las filas con su grupo (sin filtrar por la búsqueda: las cifras de arriba son del universo). */
  readonly conGrupo = computed<Fila[]>(() => {
    this.deuda(); // se lee siempre: el grupo depende de ella aunque no haya filas todavía.
    return this.filas().map((r) => ({ ...r, grupo: grupoDeAnticipo(r.proveedor, this.deudaDe(r.proveedor, r.sucursal)) }));
  });

  private readonly filtradas = computed<Fila[]>(() => {
    const q = this.q();
    return this.conGrupo().filter((r) => coincideBusqueda(q, r.proveedor_nombre, r.proveedor, r.folio, r.referencia, warehouseName(r.sucursal)));
  });
  readonly visibles = computed(() => this.filtradas().length);

  readonly grupos = computed<Grupo[]>(() => {
    const f = this.filtradas();
    const de = (k: AnticipoGrupo) => f.filter((r) => r.grupo === k);
    const suma = (xs: Fila[]) => xs.reduce((s, r) => s + r.a_favor, 0);
    const porMonto = (xs: Fila[]) => [...xs].sort((a, b) => b.a_favor - a.a_favor);
    const porDias = (xs: Fila[]) => [...xs].sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1) || b.a_favor - a.a_favor);
    const out: Grupo[] = [];
    const calc = de('calculando');
    if (calc.length || this.deuda() === null) {
      out.push({ key: 'calculando', titulo: 'Mercancía — calculando contra qué se aplica', filas: porMonto(calc), monto: suma(calc),
        ayuda: this.deudaError() ? 'No se pudo leer lo que les debemos a estos acreedores. Reintenta arriba.' : 'Se está leyendo lo que les debemos a estos acreedores.' });
    } else {
      const ap = de('aplicable');
      const sc = de('sin_contra_que');
      out.push({ key: 'aplicable', titulo: 'Aplicable hoy', filas: porMonto(ap), monto: suma(ap),
        ayuda: 'El acreedor tiene facturas abiertas en la misma sucursal del anticipo. Al programar una de esas facturas en el Calendario de pagos, «Aplicar anticipo» lo resta de lo que se transfiere; CxP lo aplica en Kepler. Los de más dinero primero.' });
      out.push({ key: 'sin_contra_que', titulo: 'Sin contra qué', filas: porDias(sc), monto: suma(sc),
        ayuda: 'El acreedor no tiene ninguna factura abierta en la sucursal del anticipo (Kepler no lo aplica contra otra sucursal): hay que pedirle la factura o el reembolso. Los más viejos primero.' });
    }
    const nm = de('no_mercancia');
    out.push({ key: 'no_mercancia', titulo: 'No es anticipo de mercancía', filas: porMonto(nm), monto: suma(nm),
      ayuda: 'Gasto y tarjeta capturados en Kepler como anticipo (X-D-60). Se muestran para que el total cuadre con Kepler, pero no se aplican contra compras.' });
    return out;
  });

  private readonly mercancia = computed(() => this.conGrupo().filter((r) => r.grupo !== 'no_mercancia'));
  private readonly totalMercancia = computed(() => this.mercancia().reduce((s, r) => s + r.a_favor, 0));
  /**
   * Lo que se puede aplicar hoy, por ACREEDOR Y SUCURSAL: nunca más que su anticipo ni más que lo que le
   * debemos en esa sucursal. `null` sin deuda. `[PGP.120]` Sumarlo por acreedor (todas las sucursales)
   * daba $2.18 M; por acreedor y sucursal, $2.02 M (prod, 2026-11-13).
   */
  readonly neteable = computed<number | null>(() => {
    if (!this.deuda()) return null;
    const porLlave = new Map<string, { af: number; p: string; s: string }>();
    for (const r of this.mercancia()) {
      const k = llaveAnticipo(r.proveedor, r.sucursal);
      const x = porLlave.get(k) ?? { af: 0, p: r.proveedor, s: r.sucursal };
      x.af += r.a_favor;
      porLlave.set(k, x);
    }
    let s = 0;
    for (const x of porLlave.values()) s += neteableHoy(x.af, this.deudaDe(x.p, x.s)) ?? 0;
    return s;
  });

  readonly veredicto = computed(() => {
    const merc = this.mercancia();
    const otros = this.conGrupo().length - merc.length;
    const otrosMonto = this.conGrupo().filter((r) => r.grupo === 'no_mercancia').reduce((s, r) => s + r.a_favor, 0);
    const cola = otros ? ` Además, ${otros} de gasto o tarjeta por ${this.money(otrosMonto)}.` : '';
    const base = `${this.money(this.totalMercancia())} de anticipos de mercancía sin aplicar en ${merc.length} ${merc.length === 1 ? 'documento' : 'documentos'}`;
    const net = this.neteable();
    if (net === null) return `${base}; ${this.deudaError() ? 'no se pudo leer' : 'calculando'} contra qué se aplican.${cola}`;
    const sc = merc.filter((r) => r.grupo === 'sin_contra_que').reduce((s, r) => s + r.a_favor, 0);
    return `${base}: ${this.money(net)} se pueden aplicar hoy contra facturas abiertas; ${this.money(sc)} no tienen contra qué (pedir factura o reembolso).${cola}`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const merc = this.mercancia();
    const net = this.neteable();
    const sinMedir = { value: '—', format: 'text' as const, state: 'no_medido' as const, stateNote: this.deudaError() ? 'No se pudo leer la deuda de los acreedores.' : 'Calculando la deuda de los acreedores.' };
    const ap = merc.filter((r) => r.grupo === 'aplicable');
    const sc = merc.filter((r) => r.grupo === 'sin_contra_que');
    const viejos = merc.filter((r) => (r.dias ?? 0) > 90);
    const nm = this.conGrupo().filter((r) => r.grupo === 'no_mercancia');
    const suma = (xs: Fila[]) => xs.reduce((s, r) => s + r.a_favor, 0);
    const acreedores = (xs: Fila[]) => new Set(xs.map((r) => r.proveedor.trim())).size;
    return [
      net === null
        ? { label: 'Se puede aplicar hoy', ...sinMedir }
        : { label: 'Se puede aplicar hoy', value: net, format: 'currency-short', tone: net > 0 ? 'brand' : 'default', sub: `de ${this.money(suma(ap))} a favor de ${acreedores(ap)} acreedores con facturas abiertas` },
      net === null
        ? { label: 'Sin contra qué', ...sinMedir }
        : { label: 'Sin contra qué', value: suma(sc), format: 'currency-short', tone: sc.length ? 'warn' : 'default', sub: `${acreedores(sc)} acreedores sin facturas abiertas` },
      { label: 'Mercancía con más de 90 días', value: suma(viejos), format: 'currency-short', tone: viejos.length ? 'bad' : 'default', sub: `${viejos.length} documentos: pedir factura o reembolso` },
      { label: 'No es de mercancía', value: suma(nm), format: 'currency-short', tone: 'muted', sub: `${nm.length} de gasto o tarjeta` },
    ];
  });

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.peticion?.unsubscribe();
    this.peticionDeuda?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.deuda.set(null);
    this.deudaError.set(false);
    this.peticion = this.http.get<AnticipoRow[]>(`${this.base}/anticipos`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.filas.set((rows ?? []).map((r) => ({ ...r, importe: Number(r.importe), aplicado: Number(r.aplicado), a_favor: Number(r.a_favor), apartado: Number(r.apartado ?? 0) })));
          this.cargadoEn.set(new Date());
          this.loading.set(false);
          this.cargarDeuda();
        },
        error: (e) => { this.error.set(e?.error?.message || 'Intenta de nuevo en un momento.'); this.loading.set(false); },
      });
  }

  /** La deuda sólo de los acreedores de mercancía: gasto y tarjeta no se aplican contra compras (D2). */
  cargarDeuda(): void {
    this.peticionDeuda?.unsubscribe();
    this.deuda.set(null);
    this.deudaError.set(false);
    const codes = [...new Set(this.filas().filter((r) => tipoDeAcreedor(r.proveedor) === 'mercancia').map((r) => r.proveedor.trim()))];
    if (!codes.length) { this.deuda.set(new Map()); return; }
    this.peticionDeuda = this.http.get<AnticipoDeudaRow[]>(`${this.base}/anticipos/deuda`, { params: { proveedores: codes.join(',') } })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => this.deuda.set(new Map((rows ?? []).map((d) => [llaveAnticipo(d.proveedor, d.sucursal), { ...d, deuda: Number(d.deuda) }]))),
        error: () => this.deudaError.set(true),
      });
  }

  contraQue(r: Fila): string {
    if (r.grupo === 'no_mercancia') {
      const t = tipoDeAcreedor(r.proveedor);
      return t === 'gasto' ? 'Gasto' : t === 'tarjeta' ? 'Tarjeta' : 'Otro acreedor';
    }
    if (r.grupo === 'calculando') return this.deudaError() ? 'No se pudo leer' : 'Calculando…';
    if (r.grupo === 'sin_contra_que') return `Ninguna factura abierta en ${warehouseName(r.sucursal)}: pedir factura o reembolso`;
    const d = this.deuda()?.get(llaveAnticipo(r.proveedor, r.sucursal));
    if (!d) return '—';
    const vence = d.vence_primero ? ` · vence ${this.fecha(d.vence_primero)}` : '';
    return `Le debemos ${this.money2(d.deuda)} en ${d.facturas} ${d.facturas === 1 ? 'factura' : 'facturas'} de ${warehouseName(r.sucursal)}${vence}`;
  }

  fecha(ymd: string): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1];
    return `${d}-${mes}${y !== new Date().getFullYear() ? `-${y}` : ''}`;
  }
  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  money2(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
