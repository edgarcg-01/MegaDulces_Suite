import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

// PrimeNG
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';

// Shared UI & Services
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { ThemeService } from '../../../core/services/theme.service';
import { AuthService } from '../../../core/services/auth.service';
import {
  DetalleHomeService,
  DetalleReport,
  DetalleRouteRow,
  DetalleTopProduct,
  DetalleCustomerRow,
  DetalleRouteCatalogItem,
} from './detalle-home.service';

export type PresetKey =
  | '7d' | '30d' | '90d' | '180d'
  | 'mes' | 'mes_prev' | 'anio'
  | 'custom';

export interface PresetOpt {
  label: string;
  value: PresetKey;
}

export type DetalleTabId = 'trafico' | 'rutas' | 'productos' | 'clientes' | 'incentivos';

export interface DetalleTabItem {
  id: DetalleTabId;
  label: string;
  icon: string;
}

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Módulo de **Venta al Detalle** (`/dashboard/ventas-detalle`, gateado por `STORE_ANALYTICS_VER`).
 *
 * Primera interfaz del equipo de ventas al detalle (Rutas Directas RD y Preventa Vecinal).
 * Mantiene fielmente el estilo y la filosofía de medición de Piso de Venta (tienda/analisis-semanal):
 *   - Matriz 5 × 2 de KPIs (volumen arriba, precio/eficiencia abajo).
 *   - Descomposición de la venta: tickets, partidas/ticket, $/partida, unidades/ticket, $/unidad, clientes.
 *   - Control único de tiempo con presets instantáneos y selector de rango.
 *   - Desglose por canal (Venta a bordo RD vs Preventa Vecinal).
 *   - Desglose detallado por ruta con chofer, supervisor y cumplimiento.
 *   - Tendencia diaria con switch de variable y lectura Pareto de productos TOP.
 */
@Component({
  selector: 'app-ventas-detalle',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    SelectModule,
    DatePickerModule,
    ButtonModule,
    SelectButtonModule,
    TableModule,
    ChartModule,
    TagModule,
    TooltipModule,
    SkeletonModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    MetricCardComponent,
  ],
  templateUrl: './ventas-detalle.component.html',
  styleUrls: ['./ventas-detalle.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VentasDetalleComponent implements OnInit {
  private readonly detalleSvc = inject(DetalleHomeService);
  private readonly theme = inject(ThemeService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly hoy = new Date();

  // ── Pestañas de Navegación (estilo Piso de Venta) ──────────────────────
  readonly tabs: DetalleTabItem[] = [
    { id: 'trafico', label: 'Tráfico', icon: 'pi pi-chart-line' },
    { id: 'rutas', label: 'Rutas y Canales', icon: 'pi pi-truck' },
    { id: 'productos', label: 'Productos TOP', icon: 'pi pi-box' },
    { id: 'clientes', label: 'Clientes', icon: 'pi pi-users' },
    { id: 'incentivos', label: 'Incentivos y Liquidación', icon: 'pi pi-percentage' },
  ];
  readonly activeTab = signal<DetalleTabId>('trafico');

  // ── Filtros Globales ──────────────────────────────────────────────────
  readonly presetOptions: PresetOpt[] = [
    { label: 'Últimos 7 días', value: '7d' },
    { label: 'Últimos 30 días', value: '30d' },
    { label: 'Últimos 3 meses', value: '90d' },
    { label: 'Últimos 6 meses', value: '180d' },
    { label: 'Este mes', value: 'mes' },
    { label: 'Mes pasado', value: 'mes_prev' },
    { label: 'Este año', value: 'anio' },
    { label: 'Personalizado', value: 'custom' },
  ];
  readonly preset = signal<PresetKey>('30d');
  readonly from = signal<string>('');
  readonly to = signal<string>('');
  customRange: Date[] | null = null;

  // Canal: Todos, Venta a bordo RD o Preventa Vecinal
  readonly canalOptions = [
    { label: 'Todos los canales (RD + Preventa)', value: 'all' as const },
    { label: 'Venta a bordo (Rutas Directas RD)', value: 'rd' as const },
    { label: 'Preventa en campo (Vecinales RV)', value: 'vecinal' as const },
  ];
  readonly canalFilter = signal<'all' | 'rd' | 'vecinal'>('all');

  // Sucursal origen
  readonly branchOptions = [
    { label: 'Todas las sucursales', value: '' },
    { label: '10 · Padre Hidalgo (01)', value: '01' },
    { label: '32 · Morelia Madero (07)', value: '07' },
    { label: '50 · Canindo (06)', value: '06' },
    { label: '02 · La Piedad (02)', value: '02' },
    { label: '08 · Morelia Abastos (08)', value: '08' },
  ];
  readonly storeFilter = signal<string>('');

  // Ruta individual
  readonly routeFilter = signal<string>('');
  readonly routeCatalog = signal<DetalleRouteCatalogItem[]>([]);

  // Búsqueda en tablas
  readonly routeSearch = signal<string>('');
  readonly productSearch = signal<string>('');
  readonly clientSearch = signal<string>('');

  // Variable de tendencia diaria
  readonly chartMetricOptions = [
    { label: 'Venta $', value: 'revenue' as const },
    { label: 'Tickets', value: 'tickets' as const },
    // `[AUD-DAT.21]` Decia «Unidades» y graficaba `count(*)` de renglones. La fuente por rango
    // no tiene cantidad vendida, asi que la serie se rotula por lo que de verdad cuenta.
    { label: 'Renglones', value: 'lines' as const },
  ];
  readonly chartMetric = signal<'revenue' | 'tickets' | 'lines'>('revenue');

  // ── Estado de Datos ───────────────────────────────────────────────────
  readonly loading = signal<boolean>(true);
  readonly error = signal<boolean>(false);
  readonly report = signal<DetalleReport | null>(null);
  /**
   * `[AUD-DAT.20]` Las dos tablas pesadas cargan APARTE y después. Su espera es propia: la
   * pantalla no se bloquea por ellas, pero tampoco se dibujan vacías como si no hubiera venta.
   */
  readonly topsLoading = signal<boolean>(false);
  /** Rango (`from|to`) cuyas listas ya están cargadas: evita reconsultar al volver a la pestaña. */
  readonly topsLoadedFor = signal<string>('');
  /** Con qué se calcularon esas dos listas (si Wincaja entró en el universo y por qué). */
  readonly topsFuente = signal<{ incluye_wincaja: boolean; wincaja_ultimo_dia: string | null; motivo: string } | null>(null);

  // Días transcurridos
  readonly days = computed(() => {
    const f = this.from(), t = this.to();
    if (!f || !t) return 30;
    return Math.max(1, Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000) + 1);
  });

  // Rutas filtradas para la tabla
  readonly filteredRoutes = computed<DetalleRouteRow[]>(() => {
    const rep = this.report();
    if (!rep) return [];
    let list = rep.by_route;
    const q = this.routeSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.route_code.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.warehouse_name.toLowerCase().includes(q) ||
          (r.chofer_nombre && r.chofer_nombre.toLowerCase().includes(q)) ||
          (r.supervisor_nombre && r.supervisor_nombre.toLowerCase().includes(q))
      );
    }
    return list;
  });

  // Top productos filtrados
  readonly filteredProducts = computed<DetalleTopProduct[]>(() => {
    const rep = this.report();
    if (!rep) return [];
    let list = rep.top_products;
    const q = this.productSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.sku.toLowerCase().includes(q) ||
          p.nombre.toLowerCase().includes(q) ||
          (p.brand && p.brand.toLowerCase().includes(q))
      );
    }
    return list;
  });

  // Clientes filtrados
  readonly filteredCustomers = computed<DetalleCustomerRow[]>(() => {
    const rep = this.report();
    if (!rep) return [];
    let list = rep.customers;
    const q = this.clientSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.cliente_code.toLowerCase().includes(q) ||
          c.cliente_nombre.toLowerCase().includes(q) ||
          c.route_code.toLowerCase().includes(q)
      );
    }
    return list;
  });

  // ── Gráfico de Tendencia Diaria ──────────────────────────────────────
  readonly chartData = computed(() => {
    this.theme.isMonochrome();
    const rep = this.report();
    const m = this.chartMetric();
    if (!rep || !rep.series.length) return { labels: [], datasets: [] };

    const color = this.cssVar('--action', '#F05A28');
    const pick = (s: typeof rep.series[0]) => (m === 'revenue' ? s.revenue : m === 'tickets' ? s.tickets : s.lines);

    return {
      labels: rep.series.map((s) => s.label),
      datasets: [
        {
          label: m === 'revenue' ? 'Venta $' : m === 'tickets' ? 'Tickets' : 'Unidades',
          data: rep.series.map(pick),
          backgroundColor: `color-mix(in srgb, ${color} 70%, transparent)`,
          borderColor: color,
          borderWidth: 1.5,
          borderRadius: 4,
          hoverBackgroundColor: color,
        },
      ],
    };
  });

  readonly chartOptions = computed(() => {
    this.theme.isMonochrome();
    const m = this.chartMetric();
    const axis = this.cssVar('--text-muted', '#6B7280');
    const grid = this.cssVar('--border-color', 'rgba(0,0,0,.08)');
    const fmt = (v: number) =>
      m === 'revenue'
        ? '$' + Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 })
        : Number(v).toLocaleString('es-MX');

    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: any) => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: axis, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { ticks: { color: axis, callback: (v: number) => fmt(v) }, grid: { color: grid } },
      },
    };
  });

  ngOnInit(): void {
    this.applyPreset('30d');
    this.loadCatalog();
  }

  loadCatalog(): void {
    this.detalleSvc
      .loadRoutesCatalog()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((routes) => {
        this.routeCatalog.set([{ label: 'Todas las rutas', value: '' }, ...routes]);
      });
  }

  onPresetChange(p: PresetKey): void {
    this.applyPreset(p);
  }

  applyPreset(p: PresetKey): void {
    this.preset.set(p);
    if (p === 'custom') {
      if (this.customRange?.length === 2 && this.customRange[1]) this.applyCustom();
      return;
    }
    const r = this.computePresetDates(p);
    if (!r) return;
    this.from.set(r.from);
    this.to.set(r.to);
    this.loadData();
  }

  applyCustom(): void {
    const r = this.customRange;
    if (!r || r.length < 2 || !r[0] || !r[1]) return;
    this.from.set(iso(r[0]));
    this.to.set(iso(r[1]));
    this.loadData();
  }

  onFilterChange(): void {
    this.loadData();
  }

  setTab(tab: DetalleTabId): void {
    this.activeTab.set(tab);
    // `[AUD-DAT.20]` Abrir «Productos» o «Clientes» es lo que dispara su consulta.
    this.ensureTops();
  }

  loadData(): void {
    const f = this.from(), t = this.to();
    if (!f || !t) return;

    this.loading.set(true);
    this.error.set(false);

    this.detalleSvc
      .getDetalleReport({
        from: f,
        to: t,
        canal: this.canalFilter(),
        warehouse_code: this.storeFilter() || undefined,
        route_code: this.routeFilter() || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (data) => {
          this.report.set(data);
          this.loading.set(false);
          // El rango cambió: lo que estuviera cargado ya no corresponde.
          this.topsLoadedFor.set('');
          this.ensureTops();
        },
        error: (err) => {
          console.error('[DetalleHome] Error al cargar análisis:', err);
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }

  /**
   * `[AUD-DAT.20]` — **Top Productos y Top Clientes se piden cuando se MIRAN, no antes.**
   *
   * Las dos tablas viven en sus propias pestañas y la pestaña de entrada es «Tráfico», así que
   * en la carga normal de la pantalla **nadie las está viendo**. Traerlas igual era pagar
   * 3,941 ms medidos —y el escaneo correspondiente en la base— por dos tablas que la mayoría de
   * las visitas no abre. Se piden al abrir la pestaña y se recuerdan por rango: volver a la
   * pestaña no vuelve a consultar; cambiar el rango sí.
   */
  private ensureTops(): void {
    const tab = this.activeTab();
    if (tab !== 'productos' && tab !== 'clientes') return;
    const f = this.from(), t = this.to();
    if (!f || !t) return;
    const clave = `${f}|${t}`;
    if (this.topsLoadedFor() === clave || this.topsLoading()) return;

    this.topsLoading.set(true);
    this.detalleSvc
      .getTops(f, t)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (tops) => {
          this.topsLoading.set(false);
          // Si el usuario ya cambió el rango, esta respuesta es vieja: se descarta en vez de
          // pintarse sobre un periodo que no es el suyo.
          if (this.from() !== f || this.to() !== t) return;
          const rep = this.report();
          if (rep) {
            this.report.set({ ...rep, top_products: tops.top_products, customers: tops.customers });
          }
          this.topsFuente.set(tops.fuente);
          this.topsLoadedFor.set(clave);
        },
        error: () => this.topsLoading.set(false),
      });
  }

  private computePresetDates(p: PresetKey): { from: string; to: string } | null {
    const now = new Date();
    const back = (n: number) => {
      const f = new Date(now);
      f.setDate(f.getDate() - (n - 1));
      return { from: iso(f), to: iso(now) };
    };
    switch (p) {
      case '7d':
        return back(7);
      case '30d':
        return back(30);
      case '90d':
        return back(90);
      case '180d':
        return back(180);
      case 'mes':
        return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
      case 'mes_prev':
        return {
          from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
          to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
        };
      case 'anio':
        return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
      default:
        return null;
    }
  }

  /**
   * `[AUD-DAT.19]` El rotulo del margen DECLARA por que no hay numero.
   *
   * ⛔ Decia «sin venta en el período», que es falso y ademas tranquilizador: con $13.4M de venta
   * en pantalla, el motivo nunca fue que no se vendiera. El margen falta porque **el costo no
   * esta en la fuente** — medido en prod, en el ultimo mes cerrado el costo solo existe en el
   * 12.4 % de la venta de ruta, porque el push de camionetas no lo trae.
   *
   * Y cuando SI hay margen, no se publica «% de la venta»: se publica sobre la venta QUE TIENE
   * COSTO, con su cobertura al lado, para que nadie lo lea como si cubriera el total.
   */
  margenSub(r: DetalleReport): string {
    const p = r.kpis.margin_pct.cur;
    if (p == null) return 'el costo no está en la fuente';
    return `${p.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de la venta con costo`;
  }

  goToRouteDetails(r: DetalleRouteRow): void {
    this.router.navigate(['/comercial/ventas-por-ruta'], {
      queryParams: { route: r.route_code, year: this.to().slice(0, 4) },
    });
  }

  goToAudit(): void {
    this.router.navigate(['/dashboard/route-audit']);
  }

  private cssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  money(v: number): string {
    return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }

  moneyDec(v: number): string {
    return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  num(v: number): string {
    return Math.round(v || 0).toLocaleString('es-MX');
  }

  numDec(v: number, dec = 1): string {
    return (v || 0).toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
}
