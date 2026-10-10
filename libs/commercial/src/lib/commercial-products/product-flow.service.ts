import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { escaleraComun, margenesDe } from './new-products';
import { EXISTENCIA_KEPLER_SQL } from './new-products.sql';
import {
  CRITERIO_FLUJO,
  DatosPlaza,
  enJuegoPorDia,
  fuentesDeMargen,
  margenRealDe,
  motivosLider,
  noSeVende,
  ExistenciaPlaza,
  FlujoDetalle,
  FlujoListaRespuesta,
  HistoriaPlaza,
  KardexFila,
  Lider,
  LoteFila,
  Periodos,
  PlazaFlujo,
  RepartoPlaza,
  VentaVivo,
  escaleraDeFicha,
  existenciaEnDuda,
  juntarPlaza,
  juzgarLotes,
  juzgarPlaza,
  kardexPorPlaza,
  llegadaDeKardex,
  ordenPlazasFlujo,
  periodos,
  resumirCaducidad,
  resumirProducto,
  serieAcumulada,
  sumarDias,
  type FichaPlaza,
  type KardexPlaza,
  type MargenFila,
  type MargenesProducto,
  type NoSeVendeFila,
} from './product-flow';
import {
  CORTE_SQL,
  FICHAS_SQL,
  HISTORIA_DIARIA_SQL,
  KARDEX_SQL,
  KDIL_CRUDO_SQL,
  LIDERES_SQL,
  LOTES_CADUCIDAD_SQL,
  MARGEN_DETALLE_SQL,
  MARGEN_LISTA_SQL,
  META_MARGEN_SQL,
  NO_SE_VENDEN_SIN_NUEVOS_SQL,
  NO_SE_VENDEN_SQL,
  NUEVOS_POBLADA_SQL,
  RESUMEN_HISTORIA_SQL,
  SALIDAS_SQL,
  TRASPASOS_SQL,
  VENTA_VIVO_SQL,
} from './product-flow.sql';
import type { CaducidadResumen, CuidarRespuesta } from './product-flow';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lo más que pide una página del catálogo (su paginador llega a 200). */
const MAX_IDS = 200;
/** Cuánto se guarda "Para cuidar hoy" (la pantalla lo pide cada minuto). */
const CUIDAR_VIGENCIA_MS = 60_000;
/**
 * `[PF.6]` La foto del worker se sirve si tiene menos de esto. Calcula cada minuto y tarda ~3 s: 3 minutos
 * aguantan dos pasadas perdidas antes de caer al cálculo en vivo (que se declara).
 */
const FOTO_VIGENCIA_MS = 3 * 60_000;
/** El tenant que el worker fotografía (como los demás trabajos programados de comercial). */
const MEGA = '00000000-0000-0000-0000-00000000d01c';
type Variante = 'costo' | 'sin_costo';

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
  private readonly logger = new Logger(ProductFlowService.name);
  private fotoEnCurso = false;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
  ) {}

  /**
   * `[PF.2]`/`[PF.3]` "Para cuidar hoy" junta ~300 productos (medido en prod: ~2 s; la historia y el kardex de
   * los líderes). Es igual para todos los del tenant y la pantalla lo refresca cada minuto: se guarda un minuto
   * y, vencido, se entrega el anterior mientras se recalcula (nunca deja la pantalla esperando dos veces).
   */
  private readonly memoCuidar = new Map<string, { at: number; valor?: CuidarRespuesta; enCurso?: Promise<CuidarRespuesta> }>();

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

  /** `[PF.2]` Los líderes (de unos productos, o todos con `ids = null`) y la fecha de su cálculo. */
  private async lideres(trx: Knex.Transaction, ids: string[] | null) {
    const rows = (await trx.raw(LIDERES_SQL, [CRITERIO_FLUJO.lideresCorte, ids, ids])).rows as
      Array<{ product_id: string; rank: number; participacion: number; computed_at: Date | string | null }>;
    const mapa = new Map<string, Lider>(rows.map((r) => [r.product_id, { rank: Number(r.rank), participacion: Number(r.participacion) }]));
    const calculado = rows.map((r) => (r.computed_at ? new Date(r.computed_at).toISOString() : '')).filter(Boolean).sort().at(-1) ?? null;
    return { mapa, calculado };
  }

  /** `[PF.3]` Los lotes con fecha registrada (de unos productos, o todos con `ids = null`). */
  private async lotes(trx: Knex.Transaction, ids: string[] | null) {
    return (await trx.raw(LOTES_CADUCIDAD_SQL, [ids, ids])).rows as Array<LoteFila & { sku: string; nombre: string | null }>;
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
      return respuesta((await this.resumenes(trx, p, corte, limpios, [opts.puedeVerCosto])).get(opts.puedeVerCosto) ?? []);
    });
  }

  /** `[PF.2]`/`[PF.3]` Para cuidar hoy: los líderes que piden atención y los lotes que caducan antes de venderse. */
  async cuidar(opts: { puedeVerCosto: boolean }): Promise<CuidarRespuesta> {
    // [PF.6] Primero la foto que calcula el worker cada minuto: nadie espera el cálculo.
    const foto = await this.leerFoto(opts.puedeVerCosto ? 'costo' : 'sin_costo');
    if (foto) return foto;
    return this.cuidarEnVivo(opts);
  }

  /** La foto del worker si es reciente; NULL si no hay, está vieja o la tabla aún no existe (se calcula en vivo). */
  private async leerFoto(variante: Variante): Promise<CuidarRespuesta | null> {
    try {
      const r = await this.tk.run(async (trx) => (await trx.raw(`
        SELECT payload, calculado_at FROM analytics.product_flow_watch
         WHERE tenant_id = public.current_tenant_id() AND variante = ?`, [variante])).rows[0] as
        { payload: CuidarRespuesta; calculado_at: Date | string } | undefined);
      if (!r) return null;
      const at = new Date(r.calculado_at).getTime();
      if (Date.now() - at > FOTO_VIGENCIA_MS) return null;
      return { ...r.payload, origen: { fuente: 'foto', calculado_at: new Date(at).toISOString() } };
    } catch (e) {
      // Antes de aplicar la migración la tabla no existe: se calcula en vivo como antes, sin tumbar la pantalla.
      this.logger.warn(`Foto de Para cuidar hoy no disponible: ${(e as Error).message.slice(0, 120)}`);
      return null;
    }
  }

  /** El cálculo en vivo (sin foto o con foto vieja), guardado un minuto en este proceso. */
  private async cuidarEnVivo(opts: { puedeVerCosto: boolean }): Promise<CuidarRespuesta> {
    const key = `${this.tenantCtx.requireTenantId()}:${opts.puedeVerCosto ? 1 : 0}`;
    const m = this.memoCuidar.get(key) ?? { at: 0 };
    this.memoCuidar.set(key, m);
    if (m.valor && Date.now() - m.at < CUIDAR_VIGENCIA_MS) return m.valor;
    if (!m.enCurso) {
      m.enCurso = this.tk.run((trx) => this.calcularCuidar(trx, [opts.puedeVerCosto]))
        .then((vs) => {
          const v = vs.get(opts.puedeVerCosto)!;
          const conOrigen: CuidarRespuesta = { ...v, origen: { fuente: 'en_vivo', calculado_at: v.en_vivo_al } };
          m.valor = conOrigen; m.at = Date.now();
          return conOrigen;
        })
        .finally(() => { m.enCurso = undefined; });
      // Si falla el recálculo de fondo se queda el anterior; sin anterior, el error le llega a quien pidió.
      m.enCurso.catch(() => undefined);
    }
    return m.valor ?? m.enCurso;
  }

  /**
   * `[PF.6]` Calcula «Para cuidar hoy» en las variantes pedidas (con costo = true) con UNA sola pasada de
   * consultas: lo que cambia entre variantes son funciones puras sobre los mismos datos.
   */
  private async calcularCuidar(trx: Knex.Transaction, variantes: boolean[]): Promise<Map<boolean, CuidarRespuesta>> {
    const { corte, p } = await this.base(trx);
    const { mapa, calculado } = await this.lideres(trx, null);
    const lotes = await this.lotes(trx, null);
    const ids = [...new Set([...mapa.keys(), ...lotes.map((l) => l.product_id)])];
    const porVariante = ids.length ? await this.resumenes(trx, p, corte, ids, variantes, { lideres: mapa, lotes }) : new Map<boolean, FlujoListaRespuesta['productos']>();
    const info = new Map<string, { sku: string; nombre: string | null }>();
    for (const r of (await trx.raw(`
      SELECT id::text AS id, sku, nombre FROM catalog.products
       WHERE tenant_id = public.current_tenant_id() AND id = ANY(?::uuid[])`, [ids])).rows as Array<{ id: string; sku: string; nombre: string | null }>) {
      info.set(r.id, { sku: r.sku, nombre: r.nombre });
    }
    const nombres = await this.nombres(trx);
    const caducidadPorId = new Map(([...porVariante.values()][0] ?? []).map((r) => [r.product_id, r.caducidad]));
    const noSeVenden = await this.noSeVenden(trx, p, corte, variantes, caducidadPorId);
    const out = new Map<boolean, CuidarRespuesta>();
    for (const conCosto of variantes) {
      const resumenes = porVariante.get(conCosto) ?? [];
      out.set(conCosto, this.armarCuidar(p, corte, conCosto, resumenes, info, nombres, mapa, calculado, lotes, noSeVenden.get(conCosto)!));
    }
    return out;
  }

  private armarCuidar(p: Periodos, corte: string, conCosto: boolean, resumenes: FlujoListaRespuesta['productos'],
    info: Map<string, { sku: string; nombre: string | null }>, nombres: Map<string, string>, mapa: Map<string, Lider>,
    calculado: string | null, lotes: LoteFila[], noSeVenden: CuidarRespuesta['no_se_venden']): CuidarRespuesta {
    {
      const porId = new Map(resumenes.map((r) => [r.product_id, r]));
      const info = new Map<string, { sku: string; nombre: string | null }>();
      // Los líderes, TODOS y por su lugar en la venta de la red (pedido 2026-10-09: de un lado los
      // líderes, del otro lo que no se vende); cada uno dice lo que pide.
      const lideres = [...mapa.keys()]
        .map((id) => porId.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => ({ ...info.get(r.product_id)!, resumen: r, motivos: motivosLider(p, r), en_juego_dia: enJuegoPorDia(r) }))
        .sort((a, b) => (a.resumen.lider?.rank ?? 0) - (b.resumen.lider?.rank ?? 0));
      const porMotivo = { agotado: 0, comprar: 0, mover: 0, se_freno: 0 };
      for (const x of lideres) for (const m of x.motivos) porMotivo[m]++;
      const caducidad = resumenes
        .filter((r) => r.caducidad && (r.caducidad.vencido > 0 || r.caducidad.en_riesgo > 0 || r.caducidad.por_caducar > 0))
        .sort((a, b) => (a.caducidad!.proxima ?? '9999').localeCompare(b.caducidad!.proxima ?? '9999'))
        .map((r) => ({ ...info.get(r.product_id)!, resumen: r }));
      return {
        periodos: p, corte, en_vivo_al: new Date().toISOString(), costo_visible: conCosto, criterio: CRITERIO_FLUJO,
        lideres: { total: mapa.size, calculado, lista: lideres, por_motivo: porMotivo },
        no_se_venden: noSeVenden,
        caducidad: {
          productos: caducidad,
          cobertura: {
            lotes: lotes.length,
            productos: new Set(lotes.map((l) => l.product_id)).size,
            sucursales: [...new Set(lotes.map((l) => l.plaza))].sort().map((pl) => ({ plaza: pl, nombre: nombres.get(pl) ?? null })),
          },
        },
      };
    }
  }

  /**
   * Resumen de unos productos (ya validados), por variante (con costo = true). Las consultas se hacen una vez;
   * el costo y el margen sólo si alguna variante los lleva. Con `extra` se reusan líderes y lotes ya leídos.
   */
  private async resumenes(trx: Knex.Transaction, p: Periodos, corte: string, ids: string[], variantes: boolean[],
    extra?: { lideres: Map<string, Lider>; lotes: LoteFila[] }): Promise<Map<boolean, FlujoListaRespuesta['productos']>> {
    const conCosto = variantes.includes(true);
    {
      const prods = (await trx.raw(`
        SELECT id::text AS id, sku FROM catalog.products
         WHERE tenant_id = public.current_tenant_id() AND id = ANY(?::uuid[]) AND deleted_at IS NULL AND sku IS NOT NULL`,
      [ids])).rows as Array<{ id: string; sku: string }>;
      if (!prods.length) return new Map(variantes.map((v) => [v, []]));
      const ids2 = prods.map((x) => x.id);
      const lideres = extra?.lideres ?? (await this.lideres(trx, ids2)).mapa;
      const lotesPor = agrupar(extra?.lotes ?? await this.lotes(trx, ids2), (l) => l.product_id);
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
      const costos = conCosto
        ? (await trx.raw(KDIL_CRUDO_SQL, [skus])).rows as Array<{ plaza: string; sku: string; costo: string | null }>
        : [];
      const fichas = await this.fichas(trx, skusKardex);

      // [PF.5] El margen real de los últimos días cerrados, sólo con permiso de costo (un margen deja ver el costo).
      const margen = new Map<string, { n: string; nc: string; c: string }>();
      if (conCosto) {
        for (const r of (await trx.raw(MARGEN_LISTA_SQL, [sumarDias(p.hoy, -CRITERIO_FLUJO.ventanaMargen), p.hoy, ids2])).rows as
          Array<{ product_id: string; n: string; nc: string; c: string }>) margen.set(r.product_id, r);
      }
      const armar = (puedeVerCosto: boolean) => prods.map((x) => {
        const lotes = lotesPor.get(x.id) ?? [];
        const plazas = this.armarPlazas(p, {
          hist: histPor.get(x.id) ?? [], vivo: vivoPor.get(x.sku) ?? [], exist: exPor.get(x.id) ?? [],
          kardex: kardex.filter((k) => k.sku === x.sku), kdil: kdil.filter((k) => k.sku === x.sku),
          // Sin permiso de costo el costo ni entra: el análisis de compra no puede citar pesos detenidos.
          costos: puedeVerCosto ? costos.filter((c) => c.sku === x.sku) : [], fichas: fichas.get(x.sku) ?? new Map(), nombres,
          // Con lotes se juzgan TODAS sus sucursales: un lote donde no se vende es justo el que caduca.
          todas: lotes.length > 0,
        });
        const caducidad = resumirCaducidad(juzgarLotes(p, lotes, plazas, nombres));
        const r = resumirProducto(x.id, p, plazas.filter((pl) => pl.estado !== 'sin_movimiento'), { lider: lideres.get(x.id) ?? null, caducidad });
        if (!puedeVerCosto) return { ...r, margen_real: null, compra: { ...r.compra, inmovilizado: null } };
        const mg = margen.get(x.id);
        return { ...r, margen_real: mg ? margenRealDe(mg.n, mg.nc, mg.c) : null };
      });
      return new Map(variantes.map((v) => [v, armar(v)]));
    }
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
      const lider = (await this.lideres(trx, [prod.id])).mapa.get(prod.id) ?? null;
      const lotesFilas = await this.lotes(trx, [prod.id]);

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
      const lotes = juzgarLotes(p, lotesFilas, plazas, nombres);
      const resumen = resumirProducto(prod.id, p, plazas, { lider, caducidad: resumirCaducidad(lotes) });

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
        lotes,
      };
    });
  }

  /**
   * `[PF.4]` Lo que no se vende en la red. La consulta mira la historia cerrada; aquí se descartan los que
   * vendieron hoy en vivo (una venta de hoy no es "30 días sin vender").
   */
  private async noSeVenden(trx: Knex.Transaction, p: Periodos, corte: string, variantes: boolean[],
    caducidad: Map<string, CaducidadResumen | null>): Promise<Map<boolean, CuidarRespuesta['no_se_venden']>> {
    const C = CRITERIO_FLUJO;
    const nuevosExcluidos = !!(await trx.raw(NUEVOS_POBLADA_SQL)).rows[0]?.poblada;
    const filas = (await trx.raw(nuevosExcluidos ? NO_SE_VENDEN_SQL : NO_SE_VENDEN_SIN_NUEVOS_SQL, [
      sumarDias(p.hoy, -C.ventanaSinVenta), C.diasSinVenta, C.ventanaNuevos, C.limiteNoSeVenden * 4,
    ])).rows as NoSeVendeFila[];
    const vivo = filas.length ? (await trx.raw(VENTA_VIVO_SQL, [filas.map((f) => f.sku), corte, p.hoy])).rows as VentaVivo[] : [];
    const vendioHoy = new Set(vivo.filter((v) => (num(v.unidades) ?? 0) > 0).map((v) => v.sku));
    const quedan = filas.filter((f) => !vendioHoy.has(f.sku));
    const muestra = quedan.slice(0, C.limiteNoSeVenden);
    const fichas = await this.fichas(trx, muestra.map((f) => f.sku));
    const nombres = await this.nombres(trx);
    const porTramo = { mes: 0, trimestre: 0, anio: 0 };
    for (const f of quedan) porTramo[noSeVende(f, nombres, null, false).tramo]++;
    const escaleras = new Map(muestra.map((f) => [f.sku, escaleraComun([...(fichas.get(f.sku) ?? new Map()).entries()]
      .filter(([pl]) => (f.plazas ?? []).includes(pl)).map(([, fi]) => escaleraDeFicha(fi)))]));
    return new Map(variantes.map((puedeVerCosto) => [puedeVerCosto, {
      nuevos_excluidos: nuevosExcluidos,
      total: quedan.length,
      valor_total: puedeVerCosto ? Math.round(quedan.reduce((a, f) => a + (num(f.valor) ?? 0), 0) * 100) / 100 : null,
      por_tramo: { ...porTramo },
      productos: muestra.map((f) => noSeVende(f, nombres, escaleras.get(f.sku) ?? null, puedeVerCosto, caducidad.get(f.product_id) ?? null)),
    }]));
  }

  /**
   * `[PF.6]` La foto de «Para cuidar hoy», cada minuto, en el WORKER (la API tiene los trabajos programados
   * apagados, ADR-043). Una pasada → las dos variantes → `analytics.product_flow_watch`. Latido en
   * `analytics.cron_runs` (`product_flow_watch`, umbral en `CRON_JOBS`): sin él una foto parada se vería verde.
   */
  @Cron('0 * * * * *')
  async refrescarFoto(): Promise<void> {
    if (this.fotoEnCurso) return; // una pasada lenta no se encima con la siguiente
    this.fotoEnCurso = true;
    const t0 = Date.now();
    let error: string | null = null;
    let filas = 0;
    try {
      await this.tk.run(MEGA, async (trx) => {
        const vs = await this.calcularCuidar(trx, [true, false]);
        const calculado = new Date();
        for (const [conCosto, v] of vs) {
          const variante: Variante = conCosto ? 'costo' : 'sin_costo';
          await trx.raw(`
            INSERT INTO analytics.product_flow_watch (tenant_id, variante, payload, calculado_at, duracion_ms)
            VALUES (public.current_tenant_id(), ?, ?::jsonb, ?, ?)
            ON CONFLICT (tenant_id, variante) DO UPDATE
               SET payload = EXCLUDED.payload, calculado_at = EXCLUDED.calculado_at,
                   duracion_ms = EXCLUDED.duracion_ms, updated_at = now()`,
          [variante, JSON.stringify(v), calculado, Date.now() - t0]);
          filas++;
        }
      });
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
      this.logger.error(`Foto de Para cuidar hoy falló: ${error}`);
    } finally {
      this.fotoEnCurso = false;
      await this.latirFoto(t0, filas, error);
    }
  }

  private async latirFoto(t0: number, filas: number, error: string | null): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA, job_key: 'product_flow_watch', label: 'Foto de Para cuidar hoy (Productos)',
          last_start: new Date(t0), last_finish: this.knex.fn.now(), duration_ms: Date.now() - t0,
          // Cero variantes escritas es FALLA aunque no haya excepción.
          status: error || filas < 2 ? 'error' : 'ok', rows_affected: filas,
          error, host: 'worker', updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'duration_ms', 'status', 'rows_affected', 'error', 'host', 'updated_at']);
    } catch { /* el latido no debe romper la foto */ }
  }

  /**
   * `[PF.5]` Los tres márgenes de UN producto (de lista, real y sobre lo pagado), por sucursal y en total, en
   * los últimos días cerrados. Mismas fuentes y misma función (`margenesDe`) que Productos nuevos. Sólo con
   * permiso de costo: un margen junto a la venta deja despejar el costo.
   */
  async margins(productId: string): Promise<MargenesProducto> {
    if (!UUID_RE.test(productId || '')) throw new BadRequestException('Producto inválido');
    return this.tk.run(async (trx) => {
      const prod = (await trx.raw(`
        SELECT id::text AS id, sku FROM catalog.products
         WHERE tenant_id = public.current_tenant_id() AND id = ? AND deleted_at IS NULL`, [productId])).rows[0] as
        { id: string; sku: string | null } | undefined;
      if (!prod) throw new NotFoundException('Producto no encontrado');
      if (!prod.sku) throw new NotFoundException('El producto no tiene código de Kepler');
      const { p } = await this.base(trx);
      const hasta = sumarDias(p.hoy, -1);
      const desde = sumarDias(p.hoy, -CRITERIO_FLUJO.ventanaMargen);
      const filas = (await trx.raw(MARGEN_DETALLE_SQL, [this.tenantCtx.requireTenantId(), prod.sku, desde, hasta])).rows as MargenFila[];
      const meta = (await trx.raw(META_MARGEN_SQL, [prod.sku])).rows as Array<{ plaza: string; factor: string; margen: string }>;
      const { porPlaza, compra } = fuentesDeMargen(filas, meta);
      const nombres = await this.nombres(trx);
      const plazas = [...porPlaza.entries()]
        .map(([plaza, fuente]) => ({ plaza, nombre: nombres.get(plaza) ?? null, margenes: margenesDe([fuente], compra) }))
        .filter((x): x is { plaza: string; nombre: string | null; margenes: NonNullable<typeof x.margenes> } => !!x.margenes)
        .sort((a, b) => b.margenes.venta_neta - a.margenes.venta_neta);
      return {
        product_id: prod.id, desde, hasta, dias: CRITERIO_FLUJO.ventanaMargen,
        total: margenesDe([...porPlaza.values()], compra), plazas,
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
