import {
  ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { KeplerCustomerLookup, NewCustomerRow, NewCustomersInboxResponse } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ClientesNuevosService } from '../clientes-nuevos.service';

/** Lo que se sabe de la clave tecleada en una tarjeta. */
type Busqueda =
  | { estado: 'buscando'; code: string }
  | { estado: 'listo'; code: string; r: KeplerCustomerLookup }
  | { estado: 'error'; code: string; mensaje: string };

/**
 * `[MCP.3.8]` **Clientes nuevos por dar de alta en Kepler** (surtidor y caja de la sucursal).
 *
 * El vendedor dio de alta al cliente en la app: se le levanta y se le surte el pedido, pero sin
 * clave de Kepler no se cobra en Kepler ni entra en guía. Aquí se teclea la clave que le dieron en
 * Kepler, se ve el nombre que tiene allá para confirmar, y «Ligar con Kepler» deja la MISMA ficha
 * (pedidos y visitas incluidos) con los datos de Kepler.
 *
 * Jerarquía: primario = cuántos faltan (y cuántos ya tienen pedido esperando); secundario = cada
 * cliente con su clave por ligar; terciario = quién lo dio de alta, cuándo, domicilio.
 */
@Component({
  selector: 'app-almacen-clientes-nuevos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, ToastModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cn-page">
      <p-toast position="top-center"></p-toast>
      <p class="cn-oculto" role="status" aria-live="polite">{{ anuncio() }}</p>

      <header class="cn-top">
        <button pButton type="button" [text]="true" severity="secondary" class="cn-tap" (click)="volver()" aria-label="Volver a Surtir">
          <span class="p-button-icon pi pi-arrow-left" aria-hidden="true"></span>
        </button>
        <div class="cn-top-mid">
          <h1 class="cn-h1">Clientes nuevos por dar de alta en Kepler</h1>
          <span class="cn-sub">{{ sucursales() }}</span>
        </div>
        <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="300"></app-freshness-pill>
      </header>

      @if (bandeja()?.scope === 'ninguno') {
        <div class="cn-banda cn-banda-warn" role="status">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <span>Tu usuario no tiene una sucursal asignada. Pide que te la asignen en Administración › Personas.</span>
        </div>
      }
      @if (bandeja()?.truncated) {
        <div class="cn-banda cn-banda-warn" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>Se muestran los primeros {{ lista().length }}: hay más clientes sin ligar de los que caben en la lista.</span>
        </div>
      }

      @if (bandeja() && lista().length) {
        <app-metric-strip [items]="kpis()" ariaLabel="Clientes nuevos sin clave de Kepler"></app-metric-strip>
        <input pInputText type="search" class="cn-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Buscar por nombre, teléfono o ruta" aria-label="Buscar cliente nuevo" />
      }

      <app-load-state [loading]="cargando() && !bandeja()" [error]="error()" [isEmpty]="!!bandeja() && !visibles().length"
                      emptyIcon="pi-check-circle" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="cargar()">
        <div class="cn-lista">
          @for (c of visibles(); track c.id) {
            <article class="cn-card" [class.cn-card-pedido]="c.orders.length > 0">
              <div class="cn-r1">
                <strong class="cn-nombre">{{ c.name }}</strong>
                @if (c.orders.length) {
                  <span class="cn-pill">{{ c.orders.length === 1 ? '1 pedido esperando' : c.orders.length + ' pedidos esperando' }}</span>
                }
              </div>
              <div class="cn-meta">
                <span><i class="pi pi-user" aria-hidden="true"></i>{{ c.created_by_name || 'Alta sin registro de quién' }} · {{ fecha(c.created_at) }}</span>
                @if (c.phone) { <span><i class="pi pi-phone" aria-hidden="true"></i>{{ c.phone }}</span> }
                @if (c.sales_route) { <span>Ruta {{ c.sales_route }}</span> }
                @if (varias()) { <span>{{ c.warehouse_name || 'Sucursal sin identificar' }}</span> }
              </div>
              @if (c.address) { <p class="cn-dom"><i class="pi pi-map-marker" aria-hidden="true"></i>{{ c.address }}</p> }

              @if (c.orders.length) {
                <ul class="cn-pedidos" aria-label="Pedidos pendientes">
                  @for (o of c.orders; track o.order_id) {
                    <li>
                      <span class="cn-folio">{{ o.code }}</span>
                      <span class="cn-num">{{ dinero(o.total) }}</span>
                      @if (o.requested_delivery_date) { <span class="cn-tenue">entrega {{ fechaCorta(o.requested_delivery_date) }}</span> }
                    </li>
                  }
                </ul>
              } @else {
                <p class="cn-tenue cn-sin">Sin pedidos pendientes.</p>
              }

              @if (!c.branch) {
                <p class="cn-aviso">No se sabe de qué sucursal es: su ruta no tiene sucursal y no tiene pedidos. No se puede ligar todavía.</p>
              } @else {
                <div class="cn-liga">
                  <label class="cn-l" [attr.for]="'cn-clave-' + c.id">Clave que le diste en Kepler</label>
                  <div class="cn-liga-fila">
                    <input pInputText [id]="'cn-clave-' + c.id" class="cn-clave" autocomplete="off" autocapitalize="characters"
                           spellcheck="false" inputmode="text" [ngModel]="clave(c.id)" (ngModelChange)="teclear(c.id, $event)"
                           (keydown.enter)="buscar(c)" (blur)="buscar(c)" />
                    <button pButton type="button" severity="secondary" class="cn-tap" [disabled]="!clave(c.id).trim() || buscandoAhora(c.id)"
                            (click)="buscar(c)"><span class="p-button-label">Buscar</span></button>
                  </div>
                  @if (busq(c.id); as b) {
                    @if (b.estado === 'buscando') {
                      <p class="cn-res cn-tenue"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando en Kepler…</p>
                    } @else if (b.estado === 'error') {
                      <p class="cn-res cn-res-bad" role="alert">{{ b.mensaje }}</p>
                    } @else if (!b.r.found) {
                      <p class="cn-res cn-res-bad" role="alert">No existe la clave {{ b.r.code }} en Kepler de la sucursal {{ b.r.branch }}.</p>
                    } @else if (b.r.internal) {
                      <p class="cn-res cn-res-bad" role="alert">La clave {{ b.r.code }} es una cuenta interna de Kepler (tienda o vendedor), no un cliente.</p>
                    } @else if (b.r.linked_to) {
                      <p class="cn-res cn-res-warn" role="alert">
                        La clave {{ b.r.code }} ya está ligada a otro cliente: <strong>{{ b.r.linked_to.name }}</strong>. Puede ser un cliente duplicado.
                      </p>
                    } @else {
                      <p class="cn-res cn-res-ok">
                        En Kepler: <strong>{{ b.r.name }}</strong>
                        @if (b.r.address) { <span class="cn-tenue"> · {{ b.r.address }}</span> }
                      </p>
                    }
                  }
                  @if (puedeLigar()) {
                    <button type="button" class="cn-btn" [disabled]="!listoParaLigar(c.id) || ligando() === c.id" (click)="ligar(c)">
                      <i class="pi" [class.pi-link]="ligando() !== c.id" [class.pi-spin]="ligando() === c.id" [class.pi-spinner]="ligando() === c.id" aria-hidden="true"></i>
                      <span>Ligar con Kepler</span>
                    </button>
                  } @else {
                    <p class="cn-tenue">Para ligar hace falta el permiso «Gestionar Surtido».</p>
                  }
                </div>
              }
            </article>
          }
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cn-page { max-width: 46rem; }
    .cn-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .cn-tap { min-height: var(--tap-min); }
    .cn-top { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .cn-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .cn-h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); line-height: 1.2; color: var(--text-main); }
    .cn-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .cn-banda { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3);
      border-radius: var(--r-md); border: 1px solid currentColor; font-size: var(--fs-body); }
    .cn-banda-warn { color: var(--warn-fg); }
    .cn-buscar { width: 100%; margin: var(--sp-3) 0 0; }
    .cn-lista { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
    .cn-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color);
      border-radius: var(--r-lg); background: var(--card-bg); color: var(--text-main); }
    .cn-card-pedido { border-left: 4px solid var(--warn-fg); }
    .cn-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .cn-nombre { font-size: var(--fs-lg); line-height: 1.2; }
    .cn-pill { font-size: var(--fs-xs); font-weight: var(--fw-bold); padding: 2px var(--sp-2); border-radius: var(--r-pill);
      background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .cn-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .cn-meta i, .cn-dom i { margin-right: var(--sp-1); }
    .cn-dom { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .cn-pedidos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .cn-pedidos li { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); }
    .cn-folio { font-family: var(--font-mono); }
    .cn-num { font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .cn-tenue { color: var(--text-muted); font-size: var(--fs-sm); margin: 0; }
    .cn-sin { margin: 0; }
    .cn-aviso { margin: 0; font-size: var(--fs-sm); color: var(--warn-fg); }
    .cn-liga { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--border-color); }
    .cn-l { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--text-main); }
    .cn-liga-fila { display: flex; gap: var(--sp-2); }
    .cn-clave { flex: 1; min-width: 0; min-height: var(--tap-min); font-family: var(--font-mono); text-transform: uppercase; }
    .cn-res { margin: 0; font-size: var(--fs-body); }
    .cn-res-ok { color: var(--text-main); }
    .cn-res-bad { color: var(--bad-fg); }
    .cn-res-warn { color: var(--warn-fg); }
    .cn-btn { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: var(--tap-min); width: 100%;
      border-radius: var(--r-md); border: 0; background: var(--action); color: var(--action-ink); font-size: var(--fs-body);
      font-weight: var(--fw-bold); cursor: pointer; }
    .cn-btn:not(:disabled):hover { background: var(--action-hover); }
    .cn-btn:disabled { opacity: .5; cursor: not-allowed; }
    .cn-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class AlmacenClientesNuevosComponent implements OnInit {
  private readonly api = inject(ClientesNuevosService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly bandeja = signal<NewCustomersInboxResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly busqueda = signal('');
  readonly anuncio = signal('');
  readonly ligando = signal<string | null>(null);
  private readonly claves = signal<Record<string, string>>({});
  private readonly busquedas = signal<Record<string, Busqueda>>({});

  readonly puedeLigar = computed(() => this.perms.has(Permission.COMMERCIAL_PICKING_GESTIONAR));
  readonly lista = computed(() => this.bandeja()?.data ?? []);
  readonly visibles = computed(() => {
    const q = this.busqueda();
    return this.lista().filter((c) => coincideBusqueda(q, c.name, c.phone, c.sales_route, c.address));
  });
  /** Con alcance de varias sucursales se dice de cuál es cada cliente. */
  readonly varias = computed(() => new Set(this.lista().map((c) => c.warehouse_id ?? '')).size > 1);
  readonly sucursales = computed(() => {
    const nombres = [...new Set(this.lista().map((c) => c.warehouse_name).filter((n): n is string => !!n))];
    if (this.bandeja()?.scope === 'todos') return 'Todas las sucursales';
    return nombres.length ? nombres.join(' · ') : 'Tu sucursal';
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const l = this.lista();
    const conPedido = l.filter((c) => c.orders.length > 0).length;
    return [
      { label: 'Sin clave de Kepler', value: l.length, format: 'number', tone: l.length ? 'warn' : 'ok' },
      { label: 'Con pedido esperando', value: conPedido, format: 'number', tone: conPedido ? 'warn' : 'default',
        sub: 'No se cobran en Kepler ni entran en guía hasta ligarlos' },
    ];
  });
  readonly vacioTitulo = computed(() =>
    this.lista().length ? 'Ningún cliente coincide con la búsqueda' : 'No hay clientes nuevos por ligar',
  );
  readonly vacioPista = computed(() =>
    this.lista().length ? 'Prueba con otra parte del nombre.' : 'Todos los clientes que dieron de alta los vendedores ya tienen su clave de Kepler.',
  );

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.bandeja().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.bandeja.set(r);
        this.cargadoEn.set(new Date());
        this.cargando.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message || 'No se pudo cargar la lista. Revisa tu conexión.');
        this.cargando.set(false);
      },
    });
  }

  clave(id: string): string {
    return this.claves()[id] ?? '';
  }

  busq(id: string): Busqueda | null {
    return this.busquedas()[id] ?? null;
  }

  buscandoAhora(id: string): boolean {
    return this.busq(id)?.estado === 'buscando';
  }

  teclear(id: string, v: string): void {
    this.claves.update((m) => ({ ...m, [id]: v }));
    // Lo que se buscó era para otra clave: no se deja ligar con un resultado viejo.
    const b = this.busq(id);
    if (b && b.code !== v.trim().toUpperCase()) {
      this.busquedas.update((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      });
    }
  }

  /** ¿La clave tecleada ya se buscó, existe y está libre? Sólo entonces se puede ligar. */
  listoParaLigar(id: string): boolean {
    const b = this.busq(id);
    return !!b && b.estado === 'listo' && b.r.found && !b.r.internal && !b.r.linked_to
      && b.code === this.clave(id).trim().toUpperCase();
  }

  buscar(c: NewCustomerRow): void {
    const code = this.clave(c.id).trim().toUpperCase();
    if (!code) return;
    const previa = this.busq(c.id);
    if (previa && previa.code === code && previa.estado !== 'error') return;
    this.busquedas.update((m) => ({ ...m, [c.id]: { estado: 'buscando', code } }));
    this.api.buscarClave(c.id, code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.busquedas.update((m) => ({ ...m, [c.id]: { estado: 'listo', code, r } }));
        this.anuncio.set(r.found ? `En Kepler: ${r.name ?? ''}` : `No existe la clave ${code}`);
      },
      error: (e) => this.busquedas.update((m) => ({
        ...m,
        [c.id]: { estado: 'error', code, mensaje: e?.error?.message || 'No se pudo buscar en Kepler. Intenta de nuevo.' },
      })),
    });
  }

  ligar(c: NewCustomerRow): void {
    if (!this.listoParaLigar(c.id) || this.ligando()) return;
    const code = this.clave(c.id).trim().toUpperCase();
    this.ligando.set(c.id); // síncrono: un segundo toque no liga dos veces
    this.api.ligar(c.id, code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ligando.set(null);
        const pedidos = r.pending_orders === 1 ? 'Su pedido sigue igual' : r.pending_orders > 1 ? `Sus ${r.pending_orders} pedidos siguen igual` : '';
        const txt = `${r.previous_name} quedó ligado como ${r.name} (${r.code}).${pedidos ? ' ' + pedidos + '.' : ''}`;
        this.toast.add({ severity: 'success', summary: 'Ligado con Kepler', detail: txt, life: 6000 });
        this.anuncio.set(txt);
        this.bandeja.update((b) => (b ? { ...b, data: b.data.filter((x) => x.id !== c.id) } : b));
      },
      error: (e) => {
        this.ligando.set(null);
        this.toast.add({ severity: 'error', summary: 'No se ligó', detail: e?.error?.message || 'No se pudo ligar. Intenta de nuevo.', life: 7000 });
      },
    });
  }

  volver(): void {
    this.router.navigate(['/almacen/surtir']);
  }

  dinero(v: number | string): string {
    return Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  fecha(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }

  fechaCorta(ymd: string): string {
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
}
