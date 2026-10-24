import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ConfigItem, LogisticaService, Route, TariffChange } from '../logistica.service';

/** Las tarifas de carga y viáticos con las que se le paga a una persona. */
const CLAVE_CARGA = 'tarifa_carga_caja';
const ESTADO_RUTA = { sin_comision: 'Sin comisión (local)', sin_tarifa: 'Sin tarifa', activa: 'Con tarifa', apagada: 'Apagada' } as const;
type EstadoRuta = keyof typeof ESTADO_RUTA;

interface Historia { titulo: string; entity: 'config' | 'route'; id: string }

/**
 * `[EMB.43]` — **Logística › Pagos de viaje › Tarifas.**
 *
 * La pregunta que contesta: ¿con qué se le paga a cada persona y desde cuándo? Carga por caja,
 * viáticos por comida y comisión por ruta, con el historial de cada cambio (quién, cuándo, antes
 * y después). Aquí se CONSULTAN; se cambian en Logística › Configuración, que lleva el candado de
 * EMB.28.1 (cambiar una tarifa ya fijada exige autorizar). No se duplica ese candado aquí.
 *
 * La tarifa con que se paga un viaje es la vigente EL DÍA del viaje (EMB.39): cambiarla no mueve
 * lo que ya se cargó.
 *
 * Jerarquía: primario = la tarifa de carga y cuántas rutas están sin tarifa; secundario = las dos
 * tablas; terciario = el historial de una tarifa, en el panel.
 */
@Component({
  selector: 'app-logistica-pagos-tarifas',
  standalone: true,
  imports: [
    CurrencyPipe, DecimalPipe, RouterLink, TableModule, ButtonModule, TagModule, LoadStateComponent, MetricStripComponent,
    FreshnessPillComponent, SidePeekComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pt">
      <div class="pt-cabeza">
        <p class="pt-titular">{{ titular() }}</p>
        <div class="pt-acciones">
          @if (leidoAt(); as t) { <app-freshness-pill measures="fetch" [since]="t" label="tarifas" /> }
          @if (puedeCambiar()) {
            <a pButton routerLink="/logistica/config" [outlined]="true" size="small"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span><span class="p-button-label">Cambiar en Configuración</span></a>
          }
        </div>
      </div>
      @if (!cargando() && !error()) {
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Tarifas de pago" />
      }

      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
        <section class="pt-seccion" aria-labelledby="pt-carga">
          <h2 id="pt-carga">Carga y viáticos</h2>
          <p class="pt-sub">La carga se paga por caja del embarque y se reparte en partes iguales entre quienes cargaron. Los viáticos, por comida según el horario del viaje.</p>
          <div class="dt-scope">
            <p-table [value]="porPersona()" size="small" class="surf-table surf-table--plain dt-stack">
              <ng-template #header>
                <tr><th scope="col">Tarifa</th><th scope="col" class="comm-num">Valor</th><th scope="col">Unidad</th><th scope="col">Estado</th><th scope="col"><span class="sr-only">Historial</span></th></tr>
              </ng-template>
              <ng-template #body let-c>
                <tr>
                  <td data-label="Tarifa"><strong>{{ c.description || c.key }}</strong><span class="pt-clave">{{ c.key }}</span></td>
                  <td data-label="Valor" class="comm-num">{{ c.value | currency:'MXN':'symbol-narrow':'1.2-4' }}</td>
                  <td data-label="Unidad">{{ c.unit || '—' }}</td>
                  <td data-label="Estado">
                    @if (c.active) { <p-tag value="Vigente" severity="success" /> } @else { <p-tag value="Apagada" severity="secondary" /> }
                  </td>
                  <td>
                    <button pButton type="button" [text]="true" size="small"
                            (click)="verHistoria({ titulo: c.description || c.key, entity: 'config', id: c.id })"><span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span><span class="p-button-label">Historial</span></button>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        </section>

        <section class="pt-seccion" aria-labelledby="pt-rutas">
          <h2 id="pt-rutas">Comisión por ruta</h2>
          <p class="pt-sub">Cada viaje paga la comisión de su ruta: si cruza varias, la mayor. Chofer y ayudante tienen tarifa propia. Un viaje a una ruta sin tarifa no deja completar la guía.</p>
          <div class="pt-barra">
            <label class="pt-buscar">
              <span class="sr-only">Buscar ruta</span>
              <input type="search" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
                     placeholder="Destino" autocomplete="off" spellcheck="false" />
            </label>
            <span class="pt-cuenta">{{ rutasFiltradas().length }} de {{ rutas().length }} rutas</span>
          </div>
          <div class="dt-scope">
            <p-table [value]="rutasFiltradas()" [paginator]="rutasFiltradas().length > 50" [rows]="50"
                     size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack">
              <ng-template #header>
                <tr>
                  <th scope="col">Destino</th><th scope="col" class="comm-num">Chofer</th><th scope="col" class="comm-num">Ayudante</th>
                  <th scope="col" class="comm-num">Km</th><th scope="col">Estado</th><th scope="col"><span class="sr-only">Historial</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td data-label="Destino"><strong>{{ r.name }}</strong></td>
                  <td data-label="Chofer" class="comm-num">{{ r.sin_comision ? '—' : (r.driver_commission | currency:'MXN':'symbol-narrow':'1.2-2') }}</td>
                  <td data-label="Ayudante" class="comm-num">{{ r.sin_comision ? '—' : (r.helper_commission | currency:'MXN':'symbol-narrow':'1.2-2') }}</td>
                  <td data-label="Km" class="comm-num">{{ r.estimated_km ? (r.estimated_km | number:'1.0-0') : '—' }}</td>
                  <td data-label="Estado"><p-tag [value]="estadoLabel(r)" [severity]="estadoTono(r)" /></td>
                  <td>
                    <button pButton type="button" [text]="true" size="small"
                            (click)="verHistoria({ titulo: r.name, entity: 'route', id: r.id })"><span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span><span class="p-button-label">Historial</span></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6" class="pt-vacio">Ninguna ruta con ese nombre.</td></tr></ng-template>
            </p-table>
          </div>
        </section>
      </app-load-state>

      <app-side-peek [open]="!!historia()" (openChange)="!$event && historia.set(null)" width="34rem"
                     [title]="historia()?.titulo ?? ''" subtitle="Historial de la tarifa">
        <app-load-state [loading]="cargandoHistoria()" [error]="errorHistoria()" [isEmpty]="!cargandoHistoria() && !cambios().length"
                        emptyIcon="pi-history" emptyTitle="Sin cambios registrados"
                        emptyHint="La bitácora existe desde el 12-oct-2026: una tarifa fijada antes y nunca cambiada no tiene renglones."
                        [skeletonRows]="3" (retry)="cargarHistoria()">
          <ol class="pt-historia">
            @for (c of cambios(); track c.id) {
              <li>
                <span class="pt-cuando">{{ cuando(c.changed_at) }}</span>
                <span>{{ campo(c.field) }}: <strong>{{ c.old_value ?? '—' }}</strong> → <strong>{{ c.new_value ?? 'borrada' }}</strong></span>
                <span class="pt-sub">{{ c.changed_by_username || 'sin usuario' }}@if (c.autorizado) { · autorizado }</span>
              </li>
            }
          </ol>
        </app-load-state>
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pt { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-4); }
    .pt-cabeza { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2); }
    .pt-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); max-width: 70ch; }
    .pt-acciones { display: flex; align-items: center; gap: var(--sp-2); }
    .pt-seccion { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pt-seccion h2 { margin: var(--sp-3) 0 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .pt-sub { margin: 0; display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .pt-clave { display: block; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .pt-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .pt-buscar input { min-width: 16rem; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; }
    .pt-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .pt-cuenta { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pt-vacio { padding: var(--sp-4); color: var(--text-muted); }
    .pt-historia { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .pt-historia li { display: flex; flex-direction: column; gap: 2px; padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border-color); }
    .pt-cuando { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 40rem) { .pt-cuenta { margin-left: 0; } }
  `],
})
export class LogisticaPagosTarifasComponent {
  private readonly api = inject(LogisticaService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly config = signal<ConfigItem[]>([]);
  readonly rutas = signal<Route[]>([]);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly leidoAt = signal<string | null>(null);
  readonly busqueda = signal('');

  readonly historia = signal<Historia | null>(null);
  readonly cambios = signal<TariffChange[]>([]);
  readonly cargandoHistoria = signal(false);
  readonly errorHistoria = signal<string | null>(null);

  /** Cambiar tarifas es de Configuración (con su candado); aquí sólo se enlaza si la persona puede. */
  readonly puedeCambiar = computed(() => {
    if (this.perms.isAdmin()) return true;
    const p = this.auth.user()?.permissions ?? {};
    return p[Permission.LOGISTICS_CONFIG_GESTIONAR] === true || p[Permission.LOGISTICS_TARIFAS_AUTORIZAR] === true;
  });

  /** Lo que se le paga a una persona: carga y viáticos (no factores ni costo por km). La vigente primero. */
  readonly porPersona = computed(() => this.config()
    .filter((c) => c.category === 'tarifa_maniobra' || c.category === 'viatico')
    .sort((a, b) => Number(b.key === CLAVE_CARGA) - Number(a.key === CLAVE_CARGA) || Number(b.active) - Number(a.active) || a.key.localeCompare(b.key)));

  readonly carga = computed(() => this.config().find((c) => c.key === CLAVE_CARGA && c.active) ?? null);

  readonly rutasFiltradas = computed(() => {
    const q = this.busqueda();
    return this.rutas().filter((r) => coincideBusqueda(q, r.name, r.destination, r.origin));
  });

  private readonly conteo = computed(() => {
    const rs = this.rutas().filter((r) => r.active);
    return {
      con: rs.filter((r) => this.estado(r) === 'activa').length,
      sinTarifa: rs.filter((r) => this.estado(r) === 'sin_tarifa').length,
      locales: rs.filter((r) => this.estado(r) === 'sin_comision').length,
    };
  });

  readonly titular = computed(() => {
    if (this.cargando()) return 'Tarifas de pago';
    const c = this.carga();
    const n = this.conteo();
    const carga = c ? `La carga se paga a ${this.dinero(Number(c.value))} por caja.` : 'No hay tarifa de carga por caja vigente: sin ella no se registran cargadores.';
    const rutas = n.sinTarifa ? ` ${n.sinTarifa} ruta${n.sinTarifa === 1 ? '' : 's'} sin tarifa frena${n.sinTarifa === 1 ? '' : 'n'} la guía.` : ' Todas las rutas activas tienen tarifa o son locales.';
    return carga + rutas;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.carga();
    const n = this.conteo();
    return [
      c
        ? { label: 'Carga por caja', value: Number(c.value), format: 'currency2' as const, sub: 'se reparte entre quienes cargaron' }
        : { label: 'Carga por caja', value: 'Sin tarifa', format: 'text' as const, tone: 'bad' as const },
      { label: 'Rutas con tarifa', value: n.con, format: 'number' },
      { label: 'Rutas sin tarifa', value: n.sinTarifa, format: 'number', tone: n.sinTarifa ? 'warn' : 'muted', sub: 'frenan la guía' },
      { label: 'Rutas locales', value: n.locales, format: 'number', tone: 'muted', sub: 'no pagan comisión' },
    ];
  });

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    forkJoin({ config: this.api.listConfig(), rutas: this.api.listRoutes({}) }).subscribe({
      next: ({ config, rutas }) => {
        this.config.set(config);
        this.rutas.set(rutas.slice().sort((a, b) => a.name.localeCompare(b.name)));
        this.leidoAt.set(new Date().toISOString());
        this.cargando.set(false);
      },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudieron leer las tarifas.'); },
    });
  }

  verHistoria(h: Historia): void {
    this.historia.set(h);
    this.cargarHistoria();
  }

  cargarHistoria(): void {
    const h = this.historia();
    if (!h) return;
    this.cargandoHistoria.set(true);
    this.errorHistoria.set(null);
    this.cambios.set([]);
    this.api.historialTarifa(h.entity, h.id).subscribe({
      next: (r) => { this.cambios.set(r); this.cargandoHistoria.set(false); },
      error: (e) => { this.cargandoHistoria.set(false); this.errorHistoria.set(e?.error?.message ?? 'No se pudo leer el historial.'); },
    });
  }

  estado(r: Route): EstadoRuta {
    if (!r.active) return 'apagada';
    if (r.sin_comision) return 'sin_comision';
    return Number(r.driver_commission) > 0 || Number(r.helper_commission) > 0 ? 'activa' : 'sin_tarifa';
  }
  estadoLabel(r: Route): string { return ESTADO_RUTA[this.estado(r)]; }
  estadoTono(r: Route): 'success' | 'warn' | 'secondary' | 'info' {
    return ({ activa: 'success', sin_tarifa: 'warn', sin_comision: 'info', apagada: 'secondary' } as const)[this.estado(r)];
  }
  campo(f: string): string {
    return ({ value: 'Valor', active: 'Prendida', driver_commission: 'Comisión chofer', helper_commission: 'Comisión ayudante',
      name: 'Nombre', sin_comision: 'Sin comisión', borrado: 'Borrada', key: 'Clave', category: 'Categoría' } as Record<string, string>)[f] ?? f;
  }
  cuando(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  private dinero(n: number): string {
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
}
