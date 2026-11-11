import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VendorQuoteService } from '../vendor-quote.service';
import { VendorNuevaCotizacionComponent } from '../components/nueva-cotizacion.component';
import { type CotizacionDeLista, type Falla, diaMes, estadoDeCotizacion, motivoDeFalla, vigenciaDe } from '../mis-cotizaciones';

/** Cuántas cotizaciones se piden por vuelta (el servidor topa en 200). */
const POR_PAGINA = 50;

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

const SIN_PERMISO_COTIZACIONES = 'Tu usuario no tiene permiso para ver cotizaciones. Pídeselo a tu supervisor.';

/**
 * `[MCP.16]` **Mis cotizaciones**: la pestaña «Cotizaciones» de «Pedidos» en la app del vendedor.
 *
 * Por qué existe: cotizar vivía sólo en un chip dentro de «Tomar pedido» y en prod sólo hubo 2
 * cotizaciones desde la app; el vendedor capturaba la cotización como PEDIDO, el surtidor apartaba la
 * caja y la caja se rompía cuando el cliente compraba paquetes. Aquí la cotización tiene su lugar:
 * las suyas, más nuevas primero, y «Nueva cotización».
 *
 * Reutiliza lo que existe: la lista es `GET commercial/quotes?mine=true&origin=route_visit` (el
 * servidor de cotizaciones de telemarketing, sin cambios) y abrir una es la pantalla de cotizar de
 * MCP.12 (`/vendor/cotizar/:cliente?cot=:id`). El cliente nuevo se busca como en «Buscar cliente»
 * (sólo los de su ruta, VS.2).
 */
@Component({
  selector: 'app-vendor-mis-cotizaciones',
  standalone: true,
  imports: [VendorNuevaCotizacionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mc">
      <header class="mc-head">
        <div>
          <h1>Mis cotizaciones</h1>
          <span class="mc-sub">Precios para el cliente: no apartan mercancía{{ cargadoEn() ? ' · ' + horaDe(cargadoEn()!) : '' }}</span>
        </div>
        <button type="button" class="mc-ref" (click)="cargar()" [disabled]="cargando()" aria-label="Actualizar">
          <i class="pi pi-refresh" [class.pi-spin]="cargando()" aria-hidden="true"></i>
        </button>
      </header>

      @if (puedeCrear()) {
        <button type="button" class="mc-nueva" (click)="abrirElegirCliente()" [attr.aria-expanded]="eligiendo()">
          <i class="pi pi-plus" aria-hidden="true"></i> Nueva cotización
        </button>
      }

      @if (eligiendo()) {
        <!-- Elegir al cliente: el mismo componente que abre «Cotizar» del encabezado. -->
        <app-vendor-nueva-cotizacion class="mc-cli" (cerrar)="cerrarElegirCliente()" />
      }

      @if (falla(); as f) {
        <div class="mc-err" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ f.texto }}</span>
          <button type="button" (click)="cargar()">Reintentar</button>
        </div>
      }

      @if (cargando() && !cargada()) {
        <p class="mc-vacio">Cargando tus cotizaciones…</p>
      } @else if (cargada() && !falla() && !filas().length) {
        @if (sinSucursal()) {
          <div class="mc-vacio">
            <i class="pi pi-building" aria-hidden="true"></i>
            <p>Tu usuario no tiene sucursal para cotizar: no se pueden ver ni hacer cotizaciones.</p>
            <p class="mc-nota">Pídele a tu supervisor que te asigne tu sucursal.</p>
          </div>
        } @else {
          <div class="mc-vacio">
            <i class="pi pi-file" aria-hidden="true"></i>
            <p>Aún no tienes cotizaciones.</p>
            <p class="mc-nota">Con «Nueva cotización» le das precios a un cliente sin levantar pedido.</p>
          </div>
        }
      }

      @if (filas().length) {
        <ul class="mc-lista">
          @for (c of filas(); track c.id) {
            <li class="mc-card">
              <button type="button" class="mc-card-h" (click)="abrir(c)" [disabled]="!c.customer_id">
                <span class="mc-r1">
                  <strong>{{ c.recipient_name || 'Cliente sin nombre' }}</strong>
                  <span [class]="'chip ' + estado(c).tono">{{ estado(c).texto }}</span>
                </span>
                <span class="mc-r2">
                  <span class="mc-folio">{{ c.code }}</span>
                  <span>hecha el {{ dia(c.quote_date) }}</span>
                  @if (vigencia(c); as v) { <span>{{ v }}</span> }
                  <span class="mc-total">{{ dinero(c.total) }}</span>
                </span>
                @if (!c.customer_id) {
                  <span class="mc-nota">Se hizo fuera de la app: aquí no se abre.</span>
                }
              </button>
            </li>
          }
        </ul>
        @if (faltan() > 0) {
          <!-- La lista no se corta en silencio: dice cuántas hay y deja traer las que siguen. -->
          <div class="mc-mas">
            <span>Mostrando {{ filas().length }} de {{ total() }} · las más nuevas primero.</span>
            <button type="button" (click)="verMas()" [disabled]="cargandoMas()">
              @if (cargandoMas()) { <i class="pi pi-spin pi-spinner" aria-hidden="true"></i> }
              Ver {{ siguientes() }} más
            </button>
            @if (fallaMas(); as fm) { <span class="mc-nota" role="alert">{{ fm }}</span> }
          </div>
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .mc { display: flex; flex-direction: column; gap: var(--sp-3); }
    .mc-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
    .mc-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; }
    .mc-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .mc-ref { width: var(--tap-min); height: var(--tap-min); flex: none; border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); cursor: pointer; }
    .mc-nueva { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); width: 100%; min-height: var(--tap-min);
      border: 0; border-radius: var(--r-lg); background: var(--action); color: var(--action-ink); font-family: inherit;
      font-size: var(--fs-body); font-weight: 800; cursor: pointer; }
    .mc-err { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--bad-border);
      border-radius: var(--r-md); color: var(--bad-fg); font-size: var(--fs-sm); }
    .mc-err button { margin-left: auto; flex: none; min-height: var(--tap-min); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); padding: 0 var(--sp-3); font-family: inherit; cursor: pointer; }
    .mc-vacio { text-align: center; color: var(--text-muted); padding: var(--sp-8) var(--sp-4); }
    .mc-vacio p { margin: var(--sp-2) 0 0; }
    .mc-vacio i { font-size: var(--fs-display); color: var(--text-faint); }
    .mc-nota { color: var(--text-muted); font-size: var(--fs-xs); }
    .mc-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .mc-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); overflow: hidden; }
    .mc-card-h { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; text-align: left; padding: var(--sp-3);
      border: 0; background: transparent; color: var(--text-main); font-family: inherit; cursor: pointer; min-height: var(--tap-min); }
    .mc-card-h:disabled { cursor: default; }
    .mc-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .mc-r1 strong { font-size: var(--fs-body); }
    .mc-r2 { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .mc-folio { font-family: var(--font-mono); }
    .mc-total { margin-left: auto; font-family: var(--font-mono); font-weight: 700; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .chip { font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); white-space: nowrap; }
    .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .chip.bad { background: var(--bad-soft-bg); color: var(--bad-fg); }
    .chip.neutral { border: 1px solid var(--border-color); color: var(--text-muted); }
    .mc-mas { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .mc-mas button { min-height: var(--tap-min); padding: 0 var(--sp-3); border-radius: var(--r-md); border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); font-family: inherit; font-weight: 600; cursor: pointer; }
    .mc-cli { display: block; padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); }
    .mc-ref:focus-visible, .mc-nueva:focus-visible, .mc-card-h:focus-visible, .mc-err button:focus-visible,
    .mc-mas button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class VendorMisCotizacionesComponent implements OnInit {
  private readonly quotes = inject(VendorQuoteService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly filas = signal<CotizacionDeLista[]>([]);
  /** Cuántas hay en el servidor con este filtro (puede ser más que las cargadas). */
  readonly total = signal(0);
  readonly cargando = signal(false);
  /** Ya llegó al menos una respuesta buena: distingue «cargando» de «vacío». */
  readonly cargada = signal(false);
  readonly falla = signal<Falla | null>(null);
  readonly cargadoEn = signal<string | null>(null);
  readonly cargandoMas = signal(false);
  readonly fallaMas = signal<string | null>(null);
  /** La lista salió vacía porque el usuario no tiene sucursal para cotizar (COT.19), no por falta de cotizaciones. */
  readonly sinSucursal = signal(false);

  readonly faltan = computed(() => Math.max(this.total() - this.filas().length, 0));
  readonly siguientes = computed(() => Math.min(this.faltan(), POR_PAGINA));
  /** Sin permiso o sin sucursal, «Nueva cotización» terminaría en un error: no se ofrece. */
  readonly puedeCrear = computed(() => this.falla()?.tipo !== 'sin_permiso' && !this.sinSucursal());

  // ─── Elegir cliente para una cotización nueva (el componente es el mismo del encabezado) ───
  readonly eligiendo = signal(false);

  ngOnInit(): void {
    this.cargar();
  }

  /** La primera página, de nuevo (al entrar y con «Actualizar»). */
  cargar(): void {
    this.cargando.set(true);
    this.falla.set(null);
    this.fallaMas.set(null);
    this.quotes.list({ limit: POR_PAGINA, offset: 0 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const filas = r?.rows ?? [];
        this.filas.set(filas);
        this.total.set(Math.max(Number(r?.total) || 0, filas.length));
        this.cargando.set(false);
        this.cargada.set(true);
        this.cargadoEn.set(new Date().toISOString());
        this.sinSucursal.set(false);
        if (!filas.length) this.revisarSucursal();
      },
      error: (e: unknown) => {
        this.cargando.set(false);
        this.falla.set(motivoDeFalla(e, { generico: 'No se pudieron cargar tus cotizaciones.', sinPermiso: SIN_PERMISO_COTIZACIONES }));
      },
    });
  }

  /** Las que siguen, sin repetir las que ya están (si entró una nueva arriba, el corte se recorre). */
  verMas(): void {
    if (this.cargandoMas()) return;
    this.cargandoMas.set(true);
    this.fallaMas.set(null);
    this.quotes.list({ limit: POR_PAGINA, offset: this.filas().length }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const ya = new Set(this.filas().map((f) => f.id));
        const nuevas = (r?.rows ?? []).filter((f) => !ya.has(f.id));
        this.filas.update((fs) => [...fs, ...nuevas]);
        this.total.set(Math.max(Number(r?.total) || 0, this.filas().length));
        this.cargandoMas.set(false);
      },
      error: (e: unknown) => {
        this.cargandoMas.set(false);
        this.fallaMas.set(motivoDeFalla(e, { generico: 'No se pudieron cargar más.', sinPermiso: SIN_PERMISO_COTIZACIONES }).texto);
      },
    });
  }

  /**
   * Lista vacía: ¿es que no ha cotizado, o que el servidor no le deja ver ninguna porque su usuario no
   * tiene sucursal (COT.19, alcance `own` con la ficha vacía)? Sólo se pregunta en este caso.
   */
  private revisarSucursal(): void {
    this.quotes.branches().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => this.sinSucursal.set(b?.resolvable === false || (Array.isArray(b?.branches) && b.branches.length === 0)),
      // Si no se pudo saber, queda el vacío normal: la lista sí respondió que no hay.
      error: () => this.sinSucursal.set(false),
    });
  }

  /** Abre la cotización en la pantalla de cotizar (MCP.12); «desde» hace que su flecha regrese aquí. */
  abrir(c: CotizacionDeLista): void {
    if (!c.customer_id) return;
    this.router.navigate(['/vendor/cotizar', c.customer_id], { queryParams: { cot: c.id, desde: 'cotizaciones' } });
  }

  abrirElegirCliente(): void {
    this.eligiendo.set(!this.eligiendo());
  }

  cerrarElegirCliente(): void {
    this.eligiendo.set(false);
  }

  estado(c: CotizacionDeLista): { texto: string; tono: string } { return estadoDeCotizacion(c); }
  vigencia(c: CotizacionDeLista): string { return vigenciaDe(c); }
  dia(f: string): string { return diaMes(f); }
  /** Sin total no se dibuja un $0.00: se dice que no hay dato. */
  dinero(n: number | string | null | undefined): string {
    if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '—';
    return pesos.format(Number(n));
  }
  horaDe(iso: string): string { return hora.format(new Date(iso)); }
}
