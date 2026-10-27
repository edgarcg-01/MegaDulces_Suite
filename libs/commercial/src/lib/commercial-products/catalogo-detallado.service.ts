import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { FotoSwr } from '../shared/foto-swr';
import { CatalogoFichaService } from './catalogo-ficha.service';
import { ProductFlowService } from './product-flow.service';
import { NewProductsService } from './new-products.service';
import { CORTE_SQL, RESUMEN_HISTORIA_SQL, VENTA_VIVO_SQL } from './product-flow.sql';
import { ULTIMA_ENTRADA_SQL } from './catalogo-ficha.sql';
import { ACTIVOS_CON_SKU_SQL, COMPRAS_VENTANA_SQL } from './catalogo-detallado.sql';
import { CRITERIO_FLUJO, periodos, sumarDias, type HistoriaPlaza, type Periodos, type VentaVivo, type VeredictoCompra } from './product-flow';
import {
  TOPE_VEREDICTO,
  armarCompras90,
  contarDetallado,
  cuidadoDe,
  direccionValida,
  etiquetaNuevo,
  filaDetallada,
  filtroDetalladoValido,
  ordenValido,
  ordenarDetallado,
  pasa,
  ventaMesDeProductos,
  type CatalogoListaDetallada,
  type Compras90,
  type Cuidado,
  type FiltroDetallado,
  type Medido,
  type VentaMes,
} from './catalogo-detallado';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana de «Compras» en la ficha: la misma del reparto de PF. */
const DIAS_COMPRAS = CRITERIO_FLUJO.ventanaReparto;

/**
 * Las fotos caras (venta del mes de todo el catálogo, productos nuevos, veredicto de una búsqueda) se sirven
 * al momento y se recargan detrás (`FotoSwr`). La pantalla pide cada minuto: se recargan al minuto; pasados
 * 10 minutos sin recargar, se espera la recarga (no se publica un dato de edad indefinida).
 */
const RECARGAR_MS = 60_000;
const VENCE_MS = 10 * 60_000;
/** Cuántas búsquedas distintas guardan su veredicto antes de tirarlas todas. */
const MAX_BUSQUEDAS = 300;

interface VentaFoto { p: Periodos; mapa: Map<string, VentaMes> }

/**
 * Compras › Catálogo › Detallado. La lista de Sencillo (mismo buscador, mismas celdas) + «Este mes», etiquetas
 * y el menú «Mostrar» con los filtros de compra y cuidado, todo filtrado, contado, ordenado y paginado en el
 * SERVIDOR. Las reglas son del motor PF y de Productos nuevos; aquí sólo se juntan (`catalogo-detallado.ts`).
 */
@Injectable()
export class CatalogoDetalladoService {
  private readonly logger = new Logger(CatalogoDetalladoService.name);
  private readonly ventaFoto = new FotoSwr<VentaFoto>({ recargarMs: RECARGAR_MS, venceMs: VENCE_MS, alFallar: (_c, e) => this.avisar('venta', e) });
  private readonly nuevosFoto = new FotoSwr<Map<string, string> | null>({ recargarMs: RECARGAR_MS, venceMs: VENCE_MS, alFallar: (_c, e) => this.avisar('nuevos', e) });
  private readonly veredictoFoto = new FotoSwr<Map<string, VeredictoCompra>>({ recargarMs: RECARGAR_MS, venceMs: VENCE_MS, alFallar: (_c, e) => this.avisar('veredicto', e) });

  private readonly clavesVeredicto = new Set<string>();

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly catalogo: CatalogoFichaService,
    private readonly flow: ProductFlowService,
    private readonly nuevos: NewProductsService,
  ) {}

  private avisar(que: string, e: unknown): void {
    this.logger.warn(`Catálogo detallado: la recarga de ${que} falló: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }

  async lista(q: {
    search?: string; sucursal?: string; page?: number; pageSize?: number; mostrar?: string; orden?: string; dir?: string;
  }): Promise<CatalogoListaDetallada> {
    const pageSize = Math.min(Math.max(Math.trunc(Number(q.pageSize)) || 50, 1), 200);
    const page = Math.max(Math.trunc(Number(q.page)) || 1, 1);
    const tenant = this.tenantCtx.requireTenantId();

    // El universo de la búsqueda y todo lo medido van en paralelo; cada pieza que falle se DECLARA.
    const [u, venta, cuidar, nuevos] = await Promise.all([
      this.catalogo.universo({ search: q.search, sucursal: q.sucursal }),
      this.ventaFoto.obtener(tenant, () => this.calcularVenta()).catch((e) => { this.avisar('venta', e); return null; }),
      this.flow.cuidar({ puedeVerCosto: false }).catch((e) => { this.avisar('Para cuidar hoy', e); return null; }),
      this.nuevosFoto.obtener(tenant, () => this.calcularNuevos()).catch((e) => { this.avisar('nuevos', e); return null; }),
    ]);

    let veredicto: Map<string, VeredictoCompra> | null = null;
    let veredictoNota: string | null = null;
    if (u.filas.length > TOPE_VEREDICTO) {
      veredictoNota = `Busca un proveedor, una marca o un producto: se calcula para ${TOPE_VEREDICTO} productos o menos (la búsqueda tiene ${u.filas.length.toLocaleString('es-MX')})`;
    } else if (u.filas.length) {
      const ids = u.filas.map((f) => f.id).sort();
      // Una foto por búsqueda: se tiran todas si se juntan demasiadas (la memoria no crece sin tope).
      if (this.clavesVeredicto.size >= MAX_BUSQUEDAS) { this.veredictoFoto.olvidar(); this.clavesVeredicto.clear(); }
      this.clavesVeredicto.add(tenant + ':' + ids.join(','));
      try {
        veredicto = (await this.veredictoFoto.obtener(`${tenant}:${ids.join(',')}`, () => this.calcularVeredicto(ids))).valor;
      } catch (e) {
        this.avisar('veredicto', e);
        veredictoNota = 'No se pudo calcular «Qué hacer»';
      }
    } else {
      veredicto = new Map();
    }

    let cuidado: Cuidado | null = null;
    try { cuidado = cuidar ? cuidadoDe(cuidar) : null; } catch (e) { this.avisar('Para cuidar hoy', e); }
    const m: Medido = {
      conPrecio: u.conPrecio,
      venta: venta?.valor.mapa ?? null,
      cuidado,
      nuevos: nuevos?.valor ?? null,
      veredicto,
      veredictoNota,
    };

    const { conteos, notas } = contarDetallado(u.filas, m);
    let mostrar: FiltroDetallado = filtroDetalladoValido(q.mostrar);
    if (conteos[mostrar] === null) mostrar = 'todos';
    const orden = m.venta ? ordenValido(q.orden) : 'producto';
    const dir = direccionValida(q.dir, orden);

    const filtrados = u.filas.filter((f) => pasa(f, mostrar, m) === true);
    const ordenados = ordenarDetallado(filtrados, orden, dir, m.venta);
    const pagina = ordenados.slice((page - 1) * pageSize, page * pageSize);
    const base = await this.catalogo.filasDe(pagina, u.texto, u.sucursal);

    const vp = venta?.valor.p;
    return {
      vista: 'detallado',
      sucursal: u.sucursal,
      total: filtrados.length,
      filas: base.map((f) => filaDetallada(f, m)),
      calculado_al: new Date().toISOString(),
      mostrar,
      orden,
      dir,
      conteos,
      notas,
      venta: {
        medida: !!m.venta,
        calculado_al: venta ? new Date(venta.at).toISOString() : null,
        periodos: vp ? { hoy: vp.hoy, mesIni: vp.mesIni, prevIni: vp.prevIni, prevFin: vp.prevFin, dias: vp.dias } : null,
      },
      etiquetas: { lider: !!m.cuidado, caducidad: !!m.cuidado, nuevo: !!m.nuevos },
      cuidar: cuidar?.origen ?? null,
    };
  }

  /**
   * «Este mes» de TODO el catálogo activo con las consultas del motor PF: la historia cerrada por producto y
   * sucursal (`RESUMEN_HISTORIA_SQL`, desde el mes anterior) + lo en vivo del corte a hoy (`VENTA_VIVO_SQL`).
   */
  private async calcularVenta(): Promise<VentaFoto> {
    return this.tk.run(async (trx) => {
      const r = (await trx.raw(CORTE_SQL)).rows[0] as { hoy: string; corte: string };
      const p = periodos(r.hoy);
      const prods = (await trx.raw(ACTIVOS_CON_SKU_SQL)).rows as Array<{ id: string; sku: string }>;
      if (!prods.length) return { p, mapa: new Map() };
      const ids = prods.map((x) => x.id);
      const skus = [...new Set(prods.map((x) => x.sku))];
      // Desde el inicio del mes anterior basta para «mes» y «mismos días del anterior» (lo único que se usa).
      const desde = p.prevIni < p.desde30 ? p.prevIni : p.desde30;
      const [hist, vivo] = await Promise.all([
        trx.raw(RESUMEN_HISTORIA_SQL, [p.mesIni, p.prevIni, p.prevFin, p.prevIni, p.mesIni, p.desde30, p.desde30, ids, desde, r.corte])
          .then((x) => x.rows as HistoriaPlaza[]),
        trx.raw(VENTA_VIVO_SQL, [skus, r.corte, p.hoy]).then((x) => x.rows as VentaVivo[]),
      ]);
      return { p, mapa: ventaMesDeProductos(p, hist, vivo, new Map(prods.map((x) => [x.id, x.sku]))) };
    });
  }

  /** «Nuevo · día N» de Productos nuevos; null si su matvista no está poblada (se declara). */
  private async calcularNuevos(): Promise<Map<string, string> | null> {
    const r = await this.nuevos.list({ puedeVerCosto: false });
    if (!r.calculado) return null;
    const m = new Map<string, string>();
    for (const f of r.filas) {
      const e = etiquetaNuevo(f);
      if (e) m.set(f.product_id, e);
    }
    return m;
  }

  /** El veredicto del motor PF para los productos de una búsqueda chica (≤ `TOPE_VEREDICTO`). */
  private async calcularVeredicto(ids: string[]): Promise<Map<string, VeredictoCompra>> {
    const r = await this.flow.list(ids, { puedeVerCosto: false });
    return new Map(r.productos.map((x) => [x.product_id, x.compra.veredicto]));
  }

  /** Ficha › Compras de los últimos 90 días + la última entrada (el costo sólo con permiso de costo). */
  async compras(id: string, opts: { puedeVerCosto: boolean }): Promise<Compras90> {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id de producto inválido');
    return this.tk.run(async (trx) => {
      const prod = (await trx.raw(`
        SELECT btrim(sku) AS sku FROM catalog.products
         WHERE tenant_id = public.current_tenant_id() AND id = ?::uuid AND deleted_at IS NULL`, [id])).rows[0] as { sku: string | null } | undefined;
      if (!prod) throw new NotFoundException('Producto no encontrado');
      const hoy = ((await trx.raw(CORTE_SQL)).rows[0] as { hoy: string }).hoy;
      const desde = sumarDias(hoy, -(DIAS_COMPRAS - 1));
      if (!prod.sku) return armarCompras90(desde, DIAS_COMPRAS, [], null, null, opts.puedeVerCosto);
      const [filas, ultima] = await Promise.all([
        trx.raw(COMPRAS_VENTANA_SQL, [prod.sku, desde]).then((x) => x.rows as Array<{ docs: string; unidad: string; cantidad: string; primera: string | null }>),
        trx.raw(ULTIMA_ENTRADA_SQL, [prod.sku]).then((x) => (x.rows[0] as {
          sucursal: string; fecha: string; unidad: string; cantidad: string; costo: string | null;
        } | undefined) ?? null),
      ]);
      let nombre: string | null = null;
      if (ultima) {
        const w = (await trx.raw(
          `SELECT min(name) AS name FROM commercial.warehouses
            WHERE tenant_id = public.current_tenant_id() AND deleted_at IS NULL AND kepler_code = ?`,
          [ultima.sucursal],
        )).rows[0] as { name: string | null } | undefined;
        nombre = w?.name ?? null;
      }
      return armarCompras90(desde, DIAS_COMPRAS, filas, ultima, nombre, opts.puedeVerCosto);
    });
  }
}

