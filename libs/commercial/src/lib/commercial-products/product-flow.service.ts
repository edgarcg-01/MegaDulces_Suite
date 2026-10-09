import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { escaleraComun } from './new-products';
import { EXISTENCIA_KEPLER_SQL } from './new-products.sql';
import {
  CRITERIO_FLUJO,
  DatosPlaza,
  ExistenciaPlaza,
  FlujoDetalle,
  FlujoListaRespuesta,
  HistoriaPlaza,
  KardexFila,
  Periodos,
  PlazaFlujo,
  RepartoPlaza,
  VentaVivo,
  escaleraDeFicha,
  existenciaEnDuda,
  juntarPlaza,
  juzgarPlaza,
  kardexPorPlaza,
  llegadaDeKardex,
  ordenPlazasFlujo,
  periodos,
  resumirProducto,
  serieAcumulada,
  sumarDias,
  type FichaPlaza,
  type KardexPlaza,
} from './product-flow';
import {
  CORTE_SQL,
  FICHAS_SQL,
  HISTORIA_DIARIA_SQL,
  KARDEX_SQL,
  KDIL_CRUDO_SQL,
  RESUMEN_HISTORIA_SQL,
  SALIDAS_SQL,
  TRASPASOS_SQL,
  VENTA_VIVO_SQL,
} from './product-flow.sql';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lo más que pide una página del catálogo (su paginador llega a 200). */
const MAX_IDS = 200;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const agrupar = <T,>(xs: T[], k: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return m;
};

/**
 * `[PF.1]` Flujo de venta de cualquier producto: el mes contra los mismos días del anterior en tiempo
 * real, dónde se estancó, y si de verdad hace falta comprarlo. Las consultas viven en
 * `product-flow.sql.ts` (medidas en prod) y las decisiones en `product-flow.ts` (puras y probadas).
 */
@Injectable()
export class ProductFlowService {
  constructor(private readonly tk: TenantKnexService) {}

  private async base(trx: Knex.Transaction): Promise<{ hoy: string; corte: string; p: Periodos }> {
    const r = (await trx.raw(CORTE_SQL)).rows[0] as { hoy: string; corte: string };
    return { hoy: r.hoy, corte: r.corte, p: periodos(r.hoy) };
  }

  /** Sucursal de Kepler → nombre. */
  private async nombres(trx: Knex.Transaction): Promise<Map<string, string>> {
    const r = await trx.raw(`
      SELECT kepler_code AS plaza, name FROM commercial.warehouses
       WHERE tenant_id = public.current_tenant_id() AND deleted_at IS NULL AND kepler_code IS NOT NULL`);
    return new Map(r.rows.map((w: { plaza: string; name: string }) => [w.plaza, w.name]));
  }

  private async fichas(trx: Knex.Transaction, skus: string[]): Promise<Map<string, Map<string, FichaPlaza>>> {
    if (!skus.length) return new Map();
    const rows = (await trx.raw(FICHAS_SQL, [skus])).rows as Array<FichaPlaza & { plaza: string; sku: string }>;
    const out = new Map<string, Map<string, FichaPlaza>>();
    for (const { plaza, sku, ...f } of rows) {
      const m = out.get(sku) ?? new Map<string, FichaPlaza>();
      m.set(plaza, f);
      out.set(sku, m);
    }
    return out;
  }

  /** Kardex + existencia cruda + costo de unos SKU, para la existencia en duda y la llegada. */
  private async kardex(trx: Knex.Transaction, skus: string[], desde: string) {
    if (!skus.length) return { kardex: [] as KardexFila[], kdil: [] as Array<{ plaza: string; sku: string; kdil: string; costo: string | null }> };
    const kardex = (await trx.raw(KARDEX_SQL, [desde, skus])).rows as KardexFila[];
    const kdil = (await trx.raw(KDIL_CRUDO_SQL, [skus])).rows as Array<{ plaza: string; sku: string; kdil: string; costo: string | null }>;
    return { kardex, kdil };
  }

  /** La lista: un resumen por producto de la página. */
  async list(ids: string[], opts: { puedeVerCosto: boolean }): Promise<FlujoListaRespuesta> {
    const limpios = [...new Set((ids ?? []).filter((x) => UUID_RE.test(x)))];
    if (limpios.length > MAX_IDS) throw new BadRequestException(`A lo más ${MAX_IDS} productos por consulta`);
    return this.tk.run(async (trx) => {
      const { corte, p } = await this.base(trx);
      const respuesta = (productos: FlujoListaRespuesta['productos']): FlujoListaRespuesta => ({
        periodos: p, corte, en_vivo_al: new Date().toISOString(), costo_visible: opts.puedeVerCosto,
        criterio: CRITERIO_FLUJO, productos,
      });
      if (!limpios.length) return respuesta([]);
      const prods = (await trx.raw(`
        SELECT id::text AS id, sku FROM catalog.products
         WHERE tenant_id = public.current_tenant_id() AND id = ANY(?::uuid[]) AND deleted_at IS NULL AND sku IS NOT NULL`,
      [limpios])).rows as Array<{ id: string; sku: string }>;
      if (!prods.length) return respuesta([]);
      const ids2 = prods.map((x) => x.id);
      const skus = [...new Set(prods.map((x) => x.sku))];

      const hist = (await trx.raw(RESUMEN_HISTORIA_SQL, [
        p.mesIni, p.prevIni, p.prevFin, p.prevIni, p.mesIni, p.desde30, p.desde30, ids2, p.desdeHistoria, corte,
      ])).rows as HistoriaPlaza[];
      const vivo = (await trx.raw(VENTA_VIVO_SQL, [skus, corte, p.hoy])).rows as VentaVivo[];
      const exist = (await trx.raw(EXISTENCIA_KEPLER_SQL, [skus, ids2])).rows as ExistenciaPlaza[];
      const nombres = await this.nombres(trx);

      // La existencia en duda sólo cambia el veredicto donde Kepler la da por agotada y sí se vende:
      // el kardex de toda la página costaba 0.5–1.8 s, el de esos pocos productos no.
      const histPor = agrupar(hist, (h) => h.product_id);
      const vivoPor = agrupar(vivo, (v) => v.sku);
      const exPor = agrupar(exist, (e) => e.product_id);
      const candidatos = prods.filter((x) => {
        const conVenta = new Set([
          ...(histPor.get(x.id) ?? []).filter((h) => (num(h.monto30) ?? 0) > 0).map((h) => h.plaza),
          ...(vivoPor.get(x.sku) ?? []).map((v) => v.plaza),
        ]);
        const conExistencia = new Set((exPor.get(x.id) ?? []).filter((e) => (num(e.cantidad) ?? 0) > 0).map((e) => e.sucursal));
        return [...conVenta].some((pl) => !conExistencia.has(pl));
      }).map((x) => x.sku);
      const skusKardex = [...new Set(candidatos)];
      const { kardex, kdil } = await this.kardex(trx, skusKardex, sumarDias(p.hoy, -CRITERIO_FLUJO.ventanaReparto));
      const costos = opts.puedeVerCosto
        ? (await trx.raw(KDIL_CRUDO_SQL, [skus])).rows as Array<{ plaza: string; sku: string; costo: string | null }>
        : [];
      const fichas = await this.fichas(trx, skusKardex);

      const productos = prods.map((x) => {
        const plazas = this.armarPlazas(p, {
          hist: histPor.get(x.id) ?? [], vivo: vivoPor.get(x.sku) ?? [], exist: exPor.get(x.id) ?? [],
          kardex: kardex.filter((k) => k.sku === x.sku), kdil: kdil.filter((k) => k.sku === x.sku),
          costos: costos.filter((c) => c.sku === x.sku), fichas: fichas.get(x.sku) ?? new Map(), nombres,
        });
        return resumirProducto(x.id, p, plazas);
      });
      return respuesta(productos);
    });
  }

  /** El detalle de UN producto. */
  async detail(productId: string, opts: { puedeVerCosto: boolean }): Promise<FlujoDetalle> {
    if (!UUID_RE.test(productId || '')) throw new BadRequestException('Producto inválido');
    return this.tk.run(async (trx) => {
      const prod = (await trx.raw(`
        SELECT id::text AS id, sku, nombre FROM catalog.products
         WHERE tenant_id = public.current_tenant_id() AND id = ? AND deleted_at IS NULL`, [productId])).rows[0] as
        { id: string; sku: string | null; nombre: string | null } | undefined;
      if (!prod) throw new NotFoundException('Producto no encontrado');
      if (!prod.sku) throw new NotFoundException('El producto no tiene código de Kepler');
      const { corte, p } = await this.base(trx);
      const desdeReparto = sumarDias(p.hoy, -CRITERIO_FLUJO.ventanaReparto);

      const diario = (await trx.raw(HISTORIA_DIARIA_SQL, [prod.id, p.desdeHistoria, corte])).rows as
        Array<{ plaza: string; fecha: string; monto: string; unidades: string }>;
      const vivo = (await trx.raw(VENTA_VIVO_SQL, [[prod.sku], corte, p.hoy])).rows as VentaVivo[];
      const exist = (await trx.raw(EXISTENCIA_KEPLER_SQL, [[prod.sku], [prod.id]])).rows as ExistenciaPlaza[];
      const nombres = await this.nombres(trx);
      const { kardex, kdil } = await this.kardex(trx, [prod.sku], desdeReparto);
      const fichas = (await this.fichas(trx, [prod.sku])).get(prod.sku) ?? new Map<string, FichaPlaza>();
      const salidas = (await trx.raw(SALIDAS_SQL, [prod.sku, desdeReparto])).rows as
        Array<{ plaza: string; destino: string; unidad: string; q: string }>;
      const traspasos = (await trx.raw(TRASPASOS_SQL, [prod.sku, desdeReparto])).rows as
        Array<{ plaza: string; unidad: string; q: string }>;

      // La historia diaria, partida en periodos como en la lista (misma regla en un solo lugar).
      const hist: HistoriaPlaza[] = [...agrupar(diario, (d) => d.plaza)].map(([plaza, ds]) => {
        const suma = (f: (d: { fecha: string }) => boolean, campo: 'monto' | 'unidades') =>
          ds.filter(f).reduce((a, d) => a + (num(d[campo]) ?? 0), 0);
        const conVenta = ds.filter((d) => (num(d.unidades) ?? 0) > 0).map((d) => d.fecha).sort();
        return {
          product_id: prod.id, plaza,
          mes: suma((d) => d.fecha >= p.mesIni, 'monto'),
          mes_anterior_mismo: suma((d) => d.fecha >= p.prevIni && d.fecha < p.prevFin, 'monto'),
          mes_anterior_total: suma((d) => d.fecha >= p.prevIni && d.fecha < p.mesIni, 'monto'),
          monto30: suma((d) => d.fecha >= p.desde30, 'monto'),
          unidades30: suma((d) => d.fecha >= p.desde30, 'unidades'),
          ultima: conVenta.at(-1) ?? null,
        };
      });
      const plazas = this.armarPlazas(p, {
        hist, vivo, exist, kardex, kdil, costos: opts.puedeVerCosto ? kdil : [], fichas, nombres,
        todas: true,
      }).sort(ordenPlazasFlujo);
      const resumen = resumirProducto(prod.id, p, plazas);

      const porDia = new Map<string, number>();
      for (const d of diario) porDia.set(d.fecha, (porDia.get(d.fecha) ?? 0) + (num(d.monto) ?? 0));
      for (const v of vivo) porDia.set(v.fecha, (porDia.get(v.fecha) ?? 0) + (num(v.monto) ?? 0));

      // El reparto de la ventana: compras del kardex (X-A-40), traspasos recibidos y salidas.
      const reparto = new Map<string, RepartoPlaza>();
      const rp = (plaza: string) => {
        const x = reparto.get(plaza) ?? { plaza, nombre: nombres.get(plaza) ?? null, comprado: {}, recibido: {},
          mandado_sucursales: {}, mandado_rutas: {}, escalera: escaleraDeFicha(fichas.get(plaza)) };
        reparto.set(plaza, x);
        return x;
      };
      const sumar = (o: Record<string, number>, u: string, q: unknown) => { o[u] = Math.round(((o[u] ?? 0) + (num(q) ?? 0)) * 1000) / 1000; };
      for (const k of kardex) if ((num(k.comprado) ?? 0) > 0) sumar(rp(k.plaza).comprado, k.unidad, k.comprado);
      for (const t of traspasos) sumar(rp(t.plaza).recibido, t.unidad, t.q);
      for (const s of salidas) {
        if (s.destino === 'sucursal') sumar(rp(s.plaza).mandado_sucursales, s.unidad, s.q);
        else if (s.destino === 'ruta') sumar(rp(s.plaza).mandado_rutas, s.unidad, s.q);
      }

      return {
        product_id: prod.id, sku: prod.sku, nombre: prod.nombre,
        periodos: p, corte, en_vivo_al: new Date().toISOString(), costo_visible: opts.puedeVerCosto,
        criterio: CRITERIO_FLUJO,
        resumen: opts.puedeVerCosto ? resumen : { ...resumen, compra: { ...resumen.compra, inmovilizado: null } },
        serie: serieAcumulada(p, porDia),
        plazas,
        llegada: llegadaDeKardex(kardex, nombres),
        reparto: [...reparto.values()].sort((a, b) => a.plaza.localeCompare(b.plaza)),
        escalera: escaleraComun(plazas.map((x) => x.escalera)),
      };
    });
  }

  /** Junta las fuentes de un producto en sus sucursales y las juzga. */
  private armarPlazas(p: Periodos, x: {
    hist: HistoriaPlaza[]; vivo: VentaVivo[]; exist: ExistenciaPlaza[];
    kardex: KardexFila[]; kdil: Array<{ plaza: string; kdil: string }>;
    costos: Array<{ plaza: string; costo: string | null }>;
    fichas: Map<string, FichaPlaza>; nombres: Map<string, string>; todas?: boolean;
  }): PlazaFlujo[] {
    const kdil = new Map(x.kdil.map((k) => [k.plaza, num(k.kdil) ?? 0]));
    const porKardex: Map<string, KardexPlaza> = kardexPorPlaza(x.kardex, kdil);
    const costo = new Map(x.costos.map((c) => [c.plaza, num(c.costo)]));
    const exist = new Map(x.exist.map((e) => [e.sucursal, num(e.cantidad) ?? 0]));
    const histPor = new Map(x.hist.map((h) => [h.plaza, h]));
    const vivoPor = agrupar(x.vivo, (v) => v.plaza);
    const codigos = new Set([
      ...x.hist.map((h) => h.plaza), ...x.vivo.map((v) => v.plaza),
      ...[...exist].filter(([, q]) => q > 0).map(([pl]) => pl),
    ]);
    return [...codigos].sort().map((plaza) => {
      const esc = escaleraDeFicha(x.fichas.get(plaza));
      const existencia = exist.has(plaza) ? exist.get(plaza)! : null;
      const duda = existencia !== null ? existenciaEnDuda(porKardex.get(plaza), esc) : null;
      const datos: DatosPlaza = {
        plaza, nombre: x.nombres.get(plaza) ?? null,
        ...juntarPlaza(p, histPor.get(plaza), vivoPor.get(plaza) ?? []),
        existencia, duda, escalera: esc, costo: costo.get(plaza) ?? null,
      };
      return juzgarPlaza(p, datos);
    }).filter((pl) => x.todas || pl.estado !== 'sin_movimiento');
  }
}
