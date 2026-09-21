import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../../../core/services/auth.service';
import { branchName } from '../../../core/constants/store-branches';
import {
  BreakdownGrain, BreakdownReport, RangeReport, SupplierProductsReport, SupplierReport,
  TopProductsReport, CustomersReport, WeeklyService,
} from '../weekly.service';

/**
 * `[TDA.A1]` Estado compartido de **Análisis de ventas** (`/tienda/analisis-semanal/*`).
 *
 * Las 4 secciones —Tráfico · Productos y proveedores · Clientes · Promociones— son
 * cuatro lecturas del MISMO recorte: un rango de fechas y una sucursal. Por eso el
 * filtro vive acá y no en cada página: cambiar de pestaña no debe hacerte volver a
 * elegir el período, y dos controles de tiempo que no se hablan es justo lo que hace
 * que nadie confíe en la cifra que está mirando.
 *
 * NO es `providedIn: 'root'`: se provee en la ruta padre (ver `app.routes.ts`), así que
 * entrar al módulo arranca limpio y salir lo suelta.
 *
 * Carga BAJO DEMANDA (`need()`): una pestaña declara qué necesita y el servicio lo trae
 * una sola vez. Sin eso, abrir Tráfico pagaría el top de productos que nadie va a ver.
 */

/** Qué dato necesita la pestaña que está montada. */
export type AnalisisNeed = 'range' | 'products' | 'breakdown' | 'suppliers' | 'top' | 'customers';

export type PresetKey =
  | '7d' | '30d' | '90d' | '180d' | '12m'
  | 'mes' | 'mes_prev' | 'anio' | 'anio_prev'
  | 'custom';

export interface PresetOpt { label: string; value: PresetKey; }

/**
 * Presets del único control de tiempo de la pantalla. Van en un desplegable y no en
 * botones: son **diez valores excluyentes**, y la regla D.1 de `DESIGN.md` dice que un
 * control que ELIGE UN VALOR no puede verse como uno que activa un filtro.
 *
 * El tope duro son 760 días (≈2 años, `MAX_RANGE_DAYS` del backend): más atrás la pierna
 * Kepler del fact ni existe y se pintarían años vacíos que parecen caída de venta.
 */
export const PRESET_OPTIONS: PresetOpt[] = [
  { label: 'Últimos 7 días', value: '7d' },
  { label: 'Últimos 30 días', value: '30d' },
  { label: 'Últimos 3 meses', value: '90d' },
  { label: 'Últimos 6 meses', value: '180d' },
  { label: 'Últimos 12 meses', value: '12m' },
  { label: 'Este mes', value: 'mes' },
  { label: 'Mes pasado', value: 'mes_prev' },
  { label: 'Este año', value: 'anio' },
  { label: 'Año pasado', value: 'anio_prev' },
  { label: 'Personalizado', value: 'custom' },
];

export interface GrainOpt {
  label: string;
  value: BreakdownGrain;
  /** Días que el rango necesita para que el grano tenga al menos dos filas que comparar. */
  minDays: number;
  /** Qué se ve al abrir una fila. */
  hijo: string;
}

/**
 * Los cinco granos de la cascada. `minDays` NO bloquea —el rango es del usuario— pero
 * deja decir en pantalla «con este rango el grano da una sola fila», que es distinto de
 * dibujar una fila sola y dejar que parezca un resultado.
 */
export const GRAIN_OPTIONS: GrainOpt[] = [
  { label: 'Semana', value: 'week', minDays: 14, hijo: 'los días de esa semana' },
  { label: 'Día de la semana', value: 'weekday', minDays: 14, hijo: 'cada lunes, cada martes…' },
  { label: 'Mes', value: 'month', minDays: 62, hijo: 'los días de ese mes' },
  { label: 'Trimestre', value: 'quarter', minDays: 185, hijo: 'los meses del trimestre' },
  { label: 'Año', value: 'year', minDays: 400, hijo: 'los trimestres del año' },
];

/** Tope del rango. Espejo de `MAX_RANGE_DAYS` del backend — si cambia allá, cambia acá. */
export const MAX_RANGE_DAYS = 760;

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

@Injectable()
export class AnalisisStateService {
  private readonly svc = inject(WeeklyService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal fija por login ('' = rol global que ve la red). */
  readonly scopedWarehouse = this.auth.user()?.warehouse_code || '';
  readonly branchLabel = computed(() => branchName(this.scopedWarehouse));

  // ── Filtro (uno solo para las 4 secciones) ──────────────────────────────
  readonly preset = signal<PresetKey>('30d');
  readonly from = signal('');
  readonly to = signal('');
  /** Ligado al datepicker de rango; sólo se lee cuando `preset()==='custom'`. */
  customRange: Date[] | null = null;
  readonly storeFilter = signal<string>('');           // '' = todas las de tu alcance
  readonly branchOpts = signal<{ label: string; value: string }[]>([]);

  readonly grain = signal<BreakdownGrain>('month');

  // ── Datos ───────────────────────────────────────────────────────────────
  readonly rangeRep = signal<RangeReport | null>(null);
  readonly rangeError = signal(false);
  readonly breakdownRep = signal<BreakdownReport | null>(null);
  readonly breakdownError = signal(false);

  // ── `[TDA.A2]` Líneas (el proveedor del catálogo) ───────────────────────
  readonly suppliersRep = signal<SupplierReport | null>(null);
  readonly suppliersError = signal(false);
  /**
   * Línea seleccionada en el maestro-detalle. `''` = ninguna, y la pantalla muestra el
   * total. Es la MISMA selección que acota la cascada: dos selecciones separadas —una
   * para la tabla y otra para la evolución— es cómo se termina mirando la evolución de
   * una línea con los productos de otra abajo.
   */
  readonly lineaSel = signal<string>('');
  readonly lineaProductos = signal<SupplierProductsReport | null>(null);
  readonly lineaProductosError = signal(false);

  // ── `[TDA.A3]` Productos TOP (Pareto + Línea · Tipo · Grupo) ────────────
  readonly topRep = signal<TopProductsReport | null>(null);
  readonly topError = signal(false);
  /** Filtros de la pestaña. Van al SERVIDOR: el acumulado tiene que ser el del universo filtrado. */
  readonly topTipo = signal<string>('');
  readonly topGrupo = signal<string>('');
  readonly topLinea = signal<string>('');
  readonly topQ = signal<string>('');
  readonly topMode = signal<'pareto' | 'all'>('pareto');
  /**
   * Producto seleccionado, que acota la cascada de esa pestaña. Mismo patrón que la línea
   * en Proveedores: elegir una fila responde «¿y cómo viene esto en el tiempo?».
   */
  readonly productoSel = signal<string>('');

  // ── `[TDA.A4]` Clientes (cartera + el techo de cobertura) ───────────────
  readonly customersRep = signal<CustomersReport | null>(null);
  readonly customersError = signal(false);
  /** `externos` (default) · `internos` · `todos`. Ver `es_interno` del maestro. */
  readonly cliSegmento = signal<'externos' | 'internos' | 'todos'>('externos');
  readonly cliQ = signal<string>('');

  /** Lo que las pestañas visitadas declararon necesitar; sobrevive el cambio de pestaña. */
  private readonly needs = new Set<AnalisisNeed>();
  /** ¿La respuesta que tenemos en mano trae el top de productos? */
  private productsLoaded = false;

  readonly days = computed(() => {
    const f = this.from(), t = this.to();
    if (!f || !t) return 0;
    return Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000) + 1;
  });

  /**
   * ¿El rango alcanza para que el grano elegido tenga con qué comparar? Se DECLARA en
   * pantalla en vez de corregir el rango por detrás: mover el filtro del usuario sin
   * avisarle es peor que mostrarle una fila sola y decírselo.
   */
  readonly grainCorto = computed(() => {
    const g = GRAIN_OPTIONS.find((o) => o.value === this.grain());
    const d = this.days();
    return !!g && d > 0 && d < g.minDays ? g : null;
  });

  constructor() {
    this.applyPreset('30d');
  }

  // ── Filtro ──────────────────────────────────────────────────────────────

  /** Traduce un preset a [from,to]. `custom` no calcula nada: lo pone el datepicker. */
  private computePreset(p: PresetKey): { from: string; to: string } | null {
    const now = new Date();
    const back = (n: number) => { const f = new Date(now); f.setDate(f.getDate() - (n - 1)); return { from: iso(f), to: iso(now) }; };
    switch (p) {
      case '7d': return back(7);
      case '30d': return back(30);
      case '90d': return back(90);
      case '180d': return back(180);
      case '12m': { const f = new Date(now); f.setFullYear(f.getFullYear() - 1); f.setDate(f.getDate() + 1); return { from: iso(f), to: iso(now) }; }
      case 'mes': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
      case 'mes_prev': return {
        from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),   // día 0 = último del mes anterior
      };
      case 'anio': return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
      case 'anio_prev': return {
        from: iso(new Date(now.getFullYear() - 1, 0, 1)),
        to: iso(new Date(now.getFullYear() - 1, 11, 31)),
      };
      default: return null;
    }
  }

  applyPreset(p: PresetKey): void {
    this.preset.set(p);
    if (p === 'custom') {
      if (this.customRange?.length === 2 && this.customRange[1]) this.applyCustom();
      return;                                   // sin fechas todavía: no se recarga nada
    }
    const r = this.computePreset(p);
    if (!r) return;
    this.from.set(r.from); this.to.set(r.to);
    this.reload();
  }

  applyCustom(): void {
    const r = this.customRange;
    if (!r || r.length < 2 || !r[0] || !r[1]) return;
    this.from.set(iso(r[0])); this.to.set(iso(r[1]));
    this.reload();
  }

  changeStore(code: string): void {
    if (this.storeFilter() === code) return;
    this.storeFilter.set(code);
    this.reload();
  }

  changeGrain(g: BreakdownGrain): void {
    if (this.grain() === g) return;
    this.grain.set(g);
    // Sólo la cascada depende del grano; la fotografía no se vuelve a pedir.
    if (this.needs.has('breakdown')) this.loadBreakdown();
  }

  /**
   * `[TDA.A2]` Elegir (o soltar) una línea. Mueve las DOS cosas al mismo tiempo —sus
   * productos y su evolución— porque son la misma pregunta vista de dos maneras.
   */
  changeLinea(code: string): void {
    const nuevo = this.lineaSel() === code ? '' : code;   // volver a hacer clic la suelta
    this.lineaSel.set(nuevo);
    this.lineaProductos.set(null);
    this.lineaProductosError.set(false);
    if (nuevo) this.loadLineaProductos();
    if (this.needs.has('breakdown')) this.loadBreakdown();
  }

  /** `[TDA.A3]` Elegir (o soltar) un producto en Productos TOP: acota la cascada de esa pestaña. */
  changeProducto(id: string): void {
    this.productoSel.set(this.productoSel() === id ? '' : id);
    if (this.needs.has('breakdown')) this.loadBreakdown();
  }

  /**
   * `[TDA.A3]` Suelta el recorte que NO pertenece a la pestaña que se está abriendo.
   *
   * Las pestañas comparten una sola cascada. Sin esto, entrar a «Productos TOP» con una
   * línea elegida en la pestaña anterior mostraría la evolución de esa línea bajo una
   * tabla de productos — dos cosas distintas, una encima de la otra, sin nada que lo
   * delate. Cada pestaña declara cuál es el suyo (`null` = ninguno, la tienda completa).
   */
  limpiarAlcanceSalvo(cual: 'linea' | 'producto' | null): void {
    let cambio = false;
    if (cual !== 'linea' && this.lineaSel()) {
      this.lineaSel.set(''); this.lineaProductos.set(null); this.lineaProductosError.set(false); cambio = true;
    }
    if (cual !== 'producto' && this.productoSel()) { this.productoSel.set(''); cambio = true; }
    if (cambio && this.needs.has('breakdown')) this.loadBreakdown();
  }

  /**
   * Cualquier filtro de Productos TOP. Suelta el producto elegido: si sobreviviera a un
   * cambio de tipo, la cascada seguiría mostrando un producto que ya no está en la tabla.
   */
  changeTopFiltro(patch: Partial<{ tipo: string; grupo: string; linea: string; q: string; mode: 'pareto' | 'all' }>): void {
    if (patch.tipo !== undefined) this.topTipo.set(patch.tipo);
    if (patch.grupo !== undefined) this.topGrupo.set(patch.grupo);
    if (patch.linea !== undefined) this.topLinea.set(patch.linea);
    if (patch.q !== undefined) this.topQ.set(patch.q);
    if (patch.mode !== undefined) this.topMode.set(patch.mode);
    if (this.productoSel()) { this.productoSel.set(''); if (this.needs.has('breakdown')) this.loadBreakdown(); }
    this.loadTop();
  }

  /**
   * El picker de sucursal se puebla UNA vez y sólo desde una respuesta sin filtrar: si
   * se repoblara con la respuesta ya filtrada, elegir una sucursal dejaría el
   * desplegable con una sola opción y no habría forma de volver a «Todas».
   */
  captureBranchOpts(rows: { code: string; name: string }[]): void {
    if (this.scopedWarehouse || this.storeFilter() || rows.length < 2) return;
    const opts = rows
      .map((b) => ({ label: b.name || b.code, value: b.code }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
    this.branchOpts.set([{ label: 'Todas las sucursales', value: '' }, ...opts]);
  }

  // ── Carga ───────────────────────────────────────────────────────────────

  /** Una pestaña declara qué necesita. Idempotente: si ya está cargado, no repite. */
  need(...ks: AnalisisNeed[]): void {
    let pedirRango = false;
    for (const k of ks) {
      const nuevo = !this.needs.has(k);
      this.needs.add(k);
      if (k === 'breakdown') { if (nuevo || !this.breakdownRep()) this.loadBreakdown(); }
      else if (k === 'suppliers') { if (nuevo || !this.suppliersRep()) this.loadSuppliers(); }
      else if (k === 'top') { if (nuevo || !this.topRep()) this.loadTop(); }
      else if (k === 'customers') { if (nuevo || !this.customersRep()) this.loadCustomers(); }
      // 'products' sube el pedido de la MISMA llamada de rango a su versión completa.
      else if (nuevo || !this.rangeRep()) pedirRango = true;
      else if (k === 'products' && !this.productsLoaded) pedirRango = true;
    }
    if (pedirRango) this.loadRange();
  }

  /** Recarga lo que las pestañas visitadas hayan declarado. Se llama al mover el filtro. */
  reload(): void {
    if (this.needs.has('range') || this.needs.has('products')) this.loadRange();
    if (this.needs.has('breakdown')) this.loadBreakdown();
    if (this.needs.has('suppliers')) this.loadSuppliers();
    if (this.needs.has('top')) this.loadTop();
    if (this.needs.has('customers')) this.loadCustomers();
    // La línea elegida sobrevive el cambio de filtro —seguís mirando La Rosa— pero sus
    // productos son de OTRO período, así que se vuelven a pedir.
    if (this.lineaSel()) this.loadLineaProductos();
  }

  loadRange(): void {
    const from = this.from(), to = this.to();
    if (!from || !to) return;
    const conProductos = this.needs.has('products');
    this.rangeError.set(false);
    this.rangeRep.set(null);
    this.svc.range({ from, to, warehouse_code: this.storeFilter() || undefined, with_products: conProductos })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.productsLoaded = conProductos; this.rangeRep.set(r); this.captureBranchOpts(r.by_branch); },
        error: () => { this.productsLoaded = false; this.rangeError.set(true); this.rangeRep.set(null); },
      });
  }

  loadBreakdown(): void {
    const from = this.from(), to = this.to();
    if (!from || !to) return;
    this.breakdownError.set(false);
    this.breakdownRep.set(null);
    this.svc.breakdown({
      from, to, grain: this.grain(),
      warehouse_code: this.storeFilter() || undefined,
      supplier_code: this.lineaSel() || undefined,
      product_id: this.productoSel() || undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.breakdownRep.set(r),
        error: () => { this.breakdownError.set(true); this.breakdownRep.set(null); },
      });
  }

  loadSuppliers(): void {
    const from = this.from(), to = this.to();
    if (!from || !to) return;
    this.suppliersError.set(false);
    this.suppliersRep.set(null);
    this.svc.suppliers({ from, to, warehouse_code: this.storeFilter() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.suppliersRep.set(r),
        error: () => { this.suppliersError.set(true); this.suppliersRep.set(null); },
      });
  }

  loadTop(): void {
    const from = this.from(), to = this.to();
    if (!from || !to) return;
    this.topError.set(false);
    this.topRep.set(null);
    this.svc.topProducts({
      from, to,
      warehouse_code: this.storeFilter() || undefined,
      tipo: this.topTipo() || undefined,
      grupo: this.topGrupo() || undefined,
      supplier_code: this.topLinea() || undefined,
      q: this.topQ() || undefined,
      mode: this.topMode(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.topRep.set(r),
        error: () => { this.topError.set(true); this.topRep.set(null); },
      });
  }

  /** `[TDA.A4]` Cambiar segmento o búsqueda de la cartera. Los dos van al servidor. */
  changeCliFiltro(patch: Partial<{ segmento: 'externos' | 'internos' | 'todos'; q: string }>): void {
    if (patch.segmento !== undefined) this.cliSegmento.set(patch.segmento);
    if (patch.q !== undefined) this.cliQ.set(patch.q);
    this.loadCustomers();
  }

  loadCustomers(): void {
    const from = this.from(), to = this.to();
    if (!from || !to) return;
    this.customersError.set(false);
    this.customersRep.set(null);
    this.svc.customers({
      from, to,
      warehouse_code: this.storeFilter() || undefined,
      segmento: this.cliSegmento(),
      q: this.cliQ() || undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.customersRep.set(r),
        error: () => { this.customersError.set(true); this.customersRep.set(null); },
      });
  }

  loadLineaProductos(): void {
    const from = this.from(), to = this.to(), code = this.lineaSel();
    if (!from || !to || !code) return;
    this.lineaProductosError.set(false);
    this.lineaProductos.set(null);
    this.svc.supplierProducts({ from, to, supplier_code: code, warehouse_code: this.storeFilter() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.lineaProductos.set(r),
        error: () => { this.lineaProductosError.set(true); this.lineaProductos.set(null); },
      });
  }
}
