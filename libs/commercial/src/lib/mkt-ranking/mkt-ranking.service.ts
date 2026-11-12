import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';
import {
  Canal, CANALES, CANAL_TEXTO, Semana, TipoIncentivo, Redondeo,
  esCanal, resolverSemana, sumarDias, cubrimiento, puntaje, ordenarRanking, promedioGeneral,
  objetivoSugerido, unidadesDePago, textoRegla, lunesDe,
  identificarProductos, ProductosDePromo, MetodoProducto, CandidatoProducto,
} from './mkt-ranking.logic';

/**
 * `[MKT.10]` — Ranking de promociones y sus incentivos, en vivo desde Kepler.
 *
 * ── De dónde sale cada número ─────────────────────────────────────────────────────────────────
 *  · VENTA: `analytics.v_kepler_sales_lines` (la línea de venta canónica: sin cancelados, sin la
 *    factura global U-D-6 que duplica tickets, cada documento en SU plaza). Se cuenta la CANTIDAD
 *    del código de promo = veces que se aplicó. Contrastado contra el Excel de la semana 45: 81 %
 *    exacto, 88 % con ±1; el resto son errores del Excel (ver la migración `[MKT.9]`).
 *  · EXISTENCIA del código (los regalos disponibles): `analytics.v_erp_stock_on_hand`, según
 *    Kepler — el Excel traía un conteo físico con unidades mezcladas.
 *  · CAJAS de un incentivo: cantidad base ÷ `analytics.v_kepler_unit_ladder.factor_caja`, la
 *    escalera de Kepler de ESA sucursal. Sin factor, la cantidad se declara sin resolver.
 *
 * Medido en prod (2026-11-11): la semana del ranking sobre la línea, 93 códigos, 0.43–0.58 s
 * (la línea trae la descripción con que se vendió: detecta un código reutilizado). Incentivos y
 * sugerido miran semanas o meses y leen `analytics.mv_kepler_sales_daily` (2 meses en 259 ms; sus
 * unidades base cuadraron con la línea en 21 de 21 cruces). El sugerido es una ACCIÓN, no carga.
 */

export interface PromoMkt {
  id: string;
  code: string;
  descripcion_kepler: string | null;
  mecanica: string;
  vigencia_desde: string;
  vigencia_hasta: string | null;
  canales: Canal[];
  warehouse_codes: string[] | null;
  activo: boolean;
  notas: string | null;
  objetivos: number;
  updated_at: string;
  updated_by_username: string | null;
  /** `[MKT.15]` Qué producto activa la promoción, derivado de los tickets (sólo en el listado). */
  productos?: ProductosDePromo;
}

/** `[MKT.15]` La venta de la semana de un producto de la promoción, en el participante. */
export interface VentaProductoPromo {
  sku: string;
  nombre: string | null;
  /** Unidades base de Kepler (`qty` de la línea canónica). */
  unidades: number;
  /** unidades ÷ factor de caja de la ficha de ESA sucursal; NULL = sin factor (se declara). */
  cajas: number | null;
}

export interface PromoDto {
  code?: string;
  descripcion_kepler?: string | null;
  mecanica?: string;
  vigencia_desde?: string;
  vigencia_hasta?: string | null;
  canales?: string[];
  warehouse_codes?: string[] | null;
  activo?: boolean;
  notas?: string | null;
}

export interface ObjetivoDto {
  warehouse_code: string;
  canal: string;
  vendor_code?: string;
  objetivo_semanal: number | null;
  fuente?: 'sugerido' | 'manual';
}

/** `[MKT.17]` El objetivo dinámico de un participante en una promo, para una semana. */
export interface ObjetivoDinamico {
  promo_id: string; warehouse_code: string; canal: Canal; vendor_code: string; vendor_name: string;
  sugerido: number | null; semanas_historia: number;
}

export interface Quien { id?: string; username?: string }

export interface RenglonRanking {
  promo_id: string;
  code: string;
  mecanica: string;
  objetivo: number | null;
  /** `fijo` = lo fijó Marketing (gana) · `dinamico` = promedio de las 4 semanas previas, recalculado cada semana. */
  objetivo_fuente: 'fijo' | 'dinamico' | null;
  venta: number;
  cubrimiento: number | null;
  /** Existencia del código en Kepler (sólo canal mostrador). NULL = sin dato. */
  existencia: number | null;
  /** La descripción con la que se vendió no es la del alta: el código cambió de promo en Kepler. */
  descripcion_distinta: boolean;
  /** `[MKT.15]` El producto que activa la promoción y lo que se vendió de él en la semana. */
  productos: VentaProductoPromo[];
  productos_metodo: MetodoProducto;
  productos_nota: string;
}

export interface ParticipanteRanking {
  clave: string;
  warehouse_code: string;
  warehouse_name: string;
  vendor_code: string;
  nombre: string;
  lugar: number | null;
  puntaje: number | null;
  con_objetivo: number;
  sin_objetivo: number;
  cumplidas: number;
  sin_venta: number;
  promos: RenglonRanking[];
}

export interface RankingSemana {
  semana: Semana;
  canal: Canal;
  canal_texto: string;
  promos_vigentes: number;
  /** `[MKT.16]` Todas las promos vigentes del canal, para el filtro (aunque se pida una sola). */
  promos_lista: Array<{ id: string; code: string; mecanica: string }>;
  /** La promo pedida en el filtro; NULL = todas (o el id no es una promo vigente de este canal). */
  promo_filtrada: string | null;
  promedio_general: number | null;
  participantes: ParticipanteRanking[];
  /** `[MKT.16]` El ranking de promociones: cada promo, con los participantes que la tienen. */
  promos_ranking: PromoEnRanking[];
  criterio: string;
  consultado_at: string;
}

export interface PromoEnRanking {
  promo_id: string;
  code: string;
  nombre: string;
  productos: string[];
  productos_metodo: MetodoProducto;
  participantes: number;
  venta_total: number;
  objetivo_total: number;
  lugar: number | null;
  /** Promedio del cubrimiento con tope entre los participantes CON objetivo. */
  puntaje: number | null;
  con_objetivo: number;
  sin_objetivo: number;
  /** Participantes que llegaron a su objetivo. */
  cumplidas: number;
  sin_venta: number;
}

export interface CodigoKepler {
  code: string;
  descripcion: string;
  sucursales: string[];
  ultima_venta: string | null;
  ya_registrada: boolean;
}

export interface IncentivoDto {
  nombre?: string;
  tipo?: string;
  pago?: number;
  base_monto?: number | null;
  redondeo?: string;
  skus?: string[];
  vigencia_desde?: string;
  vigencia_hasta?: string | null;
  canales?: string[];
  warehouse_codes?: string[] | null;
  activo?: boolean;
  notas?: string | null;
}

export interface Incentivo {
  id: string;
  nombre: string;
  tipo: TipoIncentivo;
  regla: string;
  pago: number;
  base_monto: number | null;
  redondeo: Redondeo;
  skus: string[];
  productos: Array<{ sku: string; nombre: string | null }>;
  vigencia_desde: string;
  vigencia_hasta: string | null;
  canales: Canal[];
  warehouse_codes: string[] | null;
  activo: boolean;
  notas: string | null;
}

export interface ResultadoIncentivo {
  warehouse_code: string;
  warehouse_name: string;
  vendor_code: string;
  vendor_name: string;
  canal: Canal | null;
  semana_cantidad: number;
  acumulado_cantidad: number;
  acumulado_unidades: number;
  acumulado_pago: number;
  semana_pago: number;
  /** Cantidad que no se pudo convertir a cajas (sin factor en la ficha de Kepler). */
  sin_resolver: number;
}

export interface IncentivoConResultado extends Incentivo {
  resultados: ResultadoIncentivo[];
  total_semana: number;
  total_acumulado: number;
  medido: boolean;
  nota_medicion: string | null;
}

const TIPOS: readonly TipoIncentivo[] = ['por_caja', 'por_unidad', 'por_monto', 'por_cliente', 'por_captura'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const CODIGO = /^[0-9A-Za-z]{1,20}$/;

const n = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
/** Una `date` de pg llega como Date en medianoche UTC: se formatea en UTC (GOTCHAS, Fase LC). */
const ymd = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const ymdOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : ymd(v));
/** Para comparar descripciones de Kepler sin que un espacio o una mayúscula las haga distintas. */
const normal = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

@Injectable()
export class MktRankingService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ═════════════════════════════════ promociones (alta) ═════════════════════════════════

  async listarPromos(opts: { todas?: boolean } = {}): Promise<PromoMkt[]> {
    return this.tk.run(async (trx) => {
      const q = trx('commercial.mkt_ranking_promos as p')
        .whereNull('p.deleted_at')
        .select('p.*')
        .select(trx.raw('(SELECT count(*) FROM commercial.mkt_ranking_objectives o WHERE o.promo_id = p.id)::int AS objetivos'))
        .orderBy([{ column: 'p.activo', order: 'desc' }, { column: 'p.vigencia_desde', order: 'desc' }, { column: 'p.code' }]);
      if (!opts.todas) {
        q.where('p.activo', true).where((w) => w.whereNull('p.vigencia_hasta').orWhere('p.vigencia_hasta', '>=', todayMx()));
      }
      const promos = (await q).map((r: Record<string, unknown>) => this.mapPromo(r));
      // `[MKT.15]` El producto de cada promo, de los tickets de sus últimas 4 semanas de vigencia.
      const hoy = todayMx();
      const productos = await this.productosDePromos(trx, promos.map((p) => {
        const hasta = p.vigencia_hasta && p.vigencia_hasta < hoy ? p.vigencia_hasta : hoy;
        const hace4 = sumarDias(hasta, -27);
        return { code: p.code, descripcion: p.descripcion_kepler ?? p.mecanica, desde: p.vigencia_desde > hace4 ? p.vigencia_desde : hace4, hasta };
      }));
      return promos.map((p) => ({ ...p, productos: productos.get(p.code) }));
    });
  }

  /**
   * `[MKT.15]` Qué producto activa cada código de promoción — Kepler no lo guarda (ver
   * `identificarProductos`). Se deriva de los tickets donde se aplicó el código, en su ventana.
   * Medido en prod (2026-11-11): con la forma de abajo, 3 códigos reales (09066, 00517, 27100) × 4 semanas en 2.0 s y 30 en lote en 1.8 s; unir la línea de venta con
   * `kdm2` por una llave armada (sin índice) tardaba 25 s — aquí se une por `ix_kdm2_venta_doc`.
   */
  private async productosDePromos(
    trx: Knex.Transaction,
    pedidos: Array<{ code: string; descripcion: string | null; desde: string; hasta: string }>,
  ): Promise<Map<string, ProductosDePromo>> {
    const out = new Map<string, ProductosDePromo>();
    // Un código repetido (dos altas del mismo código) se identifica una vez, con la ventana más amplia.
    const porCode = new Map<string, { code: string; descripcion: string | null; desde: string; hasta: string }>();
    for (const p of pedidos) {
      const a = porCode.get(p.code);
      porCode.set(p.code, a ? { ...a, desde: a.desde < p.desde ? a.desde : p.desde, hasta: a.hasta > p.hasta ? a.hasta : p.hasta } : p);
    }
    const lista = [...porCode.values()].filter((p) => p.desde <= p.hasta);
    if (!lista.length) {
      for (const p of porCode.values()) out.set(p.code, identificarProductos({ ...p, esSimbolico: true, tickets: 0, candidatos: [] }));
      return out;
    }
    const minDesde = lista.reduce((a, p) => (p.desde < a ? p.desde : a), lista[0].desde);
    const maxHasta = lista.reduce((a, p) => (p.hasta > a ? p.hasta : a), lista[0].hasta);
    const co = await trx.raw(
      `WITH p AS (SELECT * FROM unnest(?::text[], ?::date[], ?::date[]) AS p(code, desde, hasta)),
       -- La vista se filtra SÓLO con constantes; unida a «p» el planificador recorría los 104 mil
       -- encabezados del periodo una vez por código (5.7 s medido contra 2.0 s así).
       l AS MATERIALIZED (
         SELECT DISTINCT sku code, warehouse_code w, caja, folio, doc_tipo, business_date d
           FROM analytics.v_kepler_sales_lines
          WHERE sku = ANY(?::text[]) AND business_date BETWEEN ? AND ?
       ),
       t AS MATERIALIZED (
         SELECT DISTINCT l.code, l.w, l.caja, l.folio, l.doc_tipo FROM l JOIN p ON p.code = l.code AND l.d BETWEEN p.desde AND p.hasta
       ),
       n AS (SELECT code, count(*)::int tickets FROM t GROUP BY 1),
       co AS (
         SELECT t.code, btrim(d.c8) sku, count(DISTINCT (t.w, t.caja, t.folio))::int tk
           FROM t JOIN kepler_ods.kdm2 d
             ON btrim(d.sucursal) = t.w AND d.c2 = 'U' AND d.c3 = 'D' AND d.c4::int = t.doc_tipo
            AND d.c5::int = t.caja::int AND btrim(d.c6) = t.folio AND btrim(d.c1) = t.w
          WHERE btrim(d.c8) <> t.code
          GROUP BY 1, 2
       )
       SELECT n.code, n.tickets, co.sku, co.tk
         FROM n LEFT JOIN co ON co.code = n.code AND co.tk >= greatest(2, ceil(n.tickets * 0.1))`,
      [lista.map((p) => p.code), lista.map((p) => p.desde), lista.map((p) => p.hasta), lista.map((p) => p.code), minDesde, maxHasta],
    );
    const filas = co.rows as Array<{ code: string; tickets: number; sku: string | null; tk: number | null }>;
    const skus = [...new Set([...porCode.keys(), ...filas.map((f) => f.sku).filter((s): s is string => !!s)])];
    // Simbólico = «= GRATIS» en el nombre o $0.01 en TODAS las plazas (ERP_KEPLER §2.9). Un candidato
    // simbólico es otra promoción del mismo ticket, no un producto.
    const fichas = await trx.raw(
      `SELECT btrim(c1) sku, (array_agg(btrim(c2) ORDER BY sucursal))[1] nombre,
              (bool_or(c2 ~* '= *GRAT') OR bool_and(c90 = 0.01)) simbolico
         FROM kepler_ods.kdii WHERE btrim(c1) = ANY(?::text[]) GROUP BY 1`,
      [skus],
    );
    const ficha = new Map<string, { nombre: string | null; simbolico: boolean }>(
      (fichas.rows as Array<{ sku: string; nombre: string | null; simbolico: boolean }>).map((f) => [f.sku, { nombre: f.nombre, simbolico: f.simbolico === true }]));
    const tickets = new Map<string, number>();
    const cands = new Map<string, CandidatoProducto[]>();
    for (const f of filas) {
      tickets.set(f.code, n(f.tickets));
      if (!f.sku || ficha.get(f.sku)?.simbolico) continue;
      (cands.get(f.code) ?? cands.set(f.code, []).get(f.code)!).push({ sku: f.sku, nombre: ficha.get(f.sku)?.nombre ?? null, tickets: n(f.tk) });
    }
    for (const p of porCode.values()) {
      out.set(p.code, identificarProductos({
        code: p.code, descripcion: p.descripcion,
        // Sin ficha en kdii no se sabe: se trata como simbólico (se busca su producto, no se asume).
        esSimbolico: ficha.get(p.code)?.simbolico ?? true,
        tickets: tickets.get(p.code) ?? 0, candidatos: cands.get(p.code) ?? [],
      }));
    }
    return out;
  }

  private mapPromo(r: Record<string, unknown>): PromoMkt {
    return {
      id: String(r['id']),
      code: String(r['code']),
      descripcion_kepler: (r['descripcion_kepler'] as string) ?? null,
      mecanica: String(r['mecanica'] ?? ''),
      vigencia_desde: ymd(r['vigencia_desde']),
      vigencia_hasta: ymdOrNull(r['vigencia_hasta']),
      canales: ((r['canales'] as string[]) ?? []).filter(esCanal),
      warehouse_codes: (r['warehouse_codes'] as string[]) ?? null,
      activo: r['activo'] === true,
      notas: (r['notas'] as string) ?? null,
      objetivos: n(r['objetivos']),
      updated_at: r['updated_at'] instanceof Date ? (r['updated_at'] as Date).toISOString() : String(r['updated_at'] ?? ''),
      updated_by_username: (r['updated_by_username'] as string) ?? (r['created_by_username'] as string) ?? null,
    };
  }

  /** Valida y normaliza lo que llega de la pantalla. `parcial` = edición (sólo lo que viene). */
  validarPromo(dto: PromoDto, parcial: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!parcial || dto.code !== undefined) {
      const code = String(dto.code ?? '').trim().toUpperCase().replace(/O/g, '0');
      if (!CODIGO.test(code)) throw new BadRequestException('El código de la promoción no es válido');
      out['code'] = code;
    }
    if (!parcial || dto.mecanica !== undefined) {
      const m = String(dto.mecanica ?? '').trim();
      if (m.length < 3) throw new BadRequestException('Describe la mecánica de la promoción');
      out['mecanica'] = m.slice(0, 500);
    }
    if (!parcial || dto.vigencia_desde !== undefined) {
      if (!FECHA.test(String(dto.vigencia_desde ?? ''))) throw new BadRequestException('Falta la fecha de inicio');
      out['vigencia_desde'] = dto.vigencia_desde;
    }
    if (dto.vigencia_hasta !== undefined) {
      if (dto.vigencia_hasta !== null && dto.vigencia_hasta !== '' && !FECHA.test(String(dto.vigencia_hasta))) {
        throw new BadRequestException('La fecha de fin no es válida');
      }
      out['vigencia_hasta'] = dto.vigencia_hasta || null;
    }
    const desde = (out['vigencia_desde'] as string | undefined) ?? undefined;
    const hasta = (out['vigencia_hasta'] as string | null | undefined) ?? undefined;
    if (desde && hasta && hasta < desde) throw new BadRequestException('La fecha de fin es anterior a la de inicio');
    if (!parcial || dto.canales !== undefined) {
      const c = [...new Set((dto.canales ?? ['mostrador']).filter(esCanal))];
      if (!c.length) throw new BadRequestException('Elige al menos un canal');
      out['canales'] = c;
    }
    if (dto.warehouse_codes !== undefined) {
      const w = (dto.warehouse_codes ?? []).map((x) => String(x).trim()).filter((x) => /^\d{2}$/.test(x));
      out['warehouse_codes'] = w.length ? [...new Set(w)] : null;
    }
    if (dto.descripcion_kepler !== undefined) out['descripcion_kepler'] = dto.descripcion_kepler ? String(dto.descripcion_kepler).slice(0, 300) : null;
    if (dto.activo !== undefined) out['activo'] = dto.activo === true;
    if (dto.notas !== undefined) out['notas'] = dto.notas ? String(dto.notas).slice(0, 1000) : null;
    return out;
  }

  async crearPromo(dto: PromoDto, quien: Quien): Promise<PromoMkt> {
    const datos = this.validarPromo(dto, false);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!datos['descripcion_kepler']) {
        datos['descripcion_kepler'] = await this.descripcionKepler(trx, String(datos['code']));
      }
      const [row] = await trx('commercial.mkt_ranking_promos')
        .insert({
          ...datos, tenant_id: tenantId,
          created_by: quien.id ?? null, created_by_username: quien.username ?? null,
          updated_by: quien.id ?? null, updated_by_username: quien.username ?? null,
        })
        .returning('*');
      return this.mapPromo({ ...row, objetivos: 0 });
    });
  }

  async editarPromo(id: string, dto: PromoDto, quien: Quien): Promise<PromoMkt> {
    const datos = this.validarPromo(dto, true);
    return this.tk.run(async (trx) => {
      const actual = await trx('commercial.mkt_ranking_promos').where({ id }).whereNull('deleted_at').first();
      if (!actual) throw new NotFoundException('Promoción no encontrada');
      const desde = (datos['vigencia_desde'] as string) ?? ymd(actual.vigencia_desde);
      const hasta = 'vigencia_hasta' in datos ? (datos['vigencia_hasta'] as string | null) : ymdOrNull(actual.vigencia_hasta);
      if (hasta && hasta < desde) throw new BadRequestException('La fecha de fin es anterior a la de inicio');
      const [row] = await trx('commercial.mkt_ranking_promos')
        .where({ id })
        .update({ ...datos, updated_by: quien.id ?? null, updated_by_username: quien.username ?? null, updated_at: trx.fn.now() })
        .returning('*');
      const objetivos = await trx('commercial.mkt_ranking_objectives').where({ promo_id: id }).count<{ c: string }[]>({ c: '*' });
      return this.mapPromo({ ...row, objetivos: n(objetivos[0]?.c) });
    });
  }

  /** Baja lógica: el historial de rankings pasados se queda como estaba. */
  async borrarPromo(id: string, quien: Quien): Promise<{ ok: true }> {
    return this.tk.run(async (trx) => {
      const k = await trx('commercial.mkt_ranking_promos').where({ id }).whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), updated_by: quien.id ?? null, updated_by_username: quien.username ?? null });
      if (!k) throw new NotFoundException('Promoción no encontrada');
      return { ok: true as const };
    });
  }

  /** La descripción con la que Kepler tiene hoy el código (la más común entre sucursales). */
  private async descripcionKepler(trx: Knex.Transaction, code: string): Promise<string | null> {
    const r = await trx.raw(
      `SELECT btrim(c2) d, count(*) n FROM kepler_ods.kdii WHERE btrim(c1) = ? GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [code]);
    return (r.rows[0]?.d as string) ?? null;
  }

  /**
   * Los códigos de promoción de Kepler para elegir al dar de alta: los SIMBÓLICOS de `kdii`
   * (nombre con «GRATIS» o precio de $0.01, ERP_KEPLER §2.9), con la fecha de su última venta.
   */
  async codigosKepler(q: string | undefined): Promise<CodigoKepler[]> {
    const texto = String(q ?? '').trim();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `WITH c AS (
           SELECT btrim(k.c1) code, btrim(k.c2) descr, k.sucursal
             FROM kepler_ods.kdii k
            WHERE (k.c2 ILIKE '%GRAT%' OR k.c90 = 0.01)
              AND (? = '' OR btrim(k.c1) ILIKE ? OR k.c2 ILIKE ?)
         ),
         d AS (
           SELECT code, (array_agg(descr ORDER BY cnt DESC))[1] descr
             FROM (SELECT code, descr, count(*) cnt FROM c GROUP BY 1, 2) x GROUP BY code
         ),
         s AS (SELECT code, array_agg(DISTINCT sucursal ORDER BY sucursal) sucursales FROM c GROUP BY code),
         v AS (
           SELECT sku code, max(business_date) ultima
             FROM analytics.v_kepler_sales_lines
            WHERE business_date >= current_date - 60 AND sku IN (SELECT code FROM d)
            GROUP BY 1
         )
         SELECT d.code, d.descr, s.sucursales, v.ultima,
                EXISTS (SELECT 1 FROM commercial.mkt_ranking_promos p
                         WHERE p.code = d.code AND p.deleted_at IS NULL AND p.activo
                           AND (p.vigencia_hasta IS NULL OR p.vigencia_hasta >= current_date)) ya
           FROM d JOIN s USING (code) LEFT JOIN v USING (code)
          ORDER BY v.ultima DESC NULLS LAST, d.code
          LIMIT 80`,
        [texto, `${texto}%`, `%${texto}%`],
      );
      return r.rows.map((x: Record<string, unknown>) => ({
        code: String(x['code']),
        descripcion: String(x['descr'] ?? ''),
        sucursales: (x['sucursales'] as string[]) ?? [],
        ultima_venta: ymdOrNull(x['ultima']),
        ya_registrada: x['ya'] === true,
      }));
    });
  }

  // ═════════════════════════════════ objetivos ═════════════════════════════════

  async objetivosDePromo(promoId: string): Promise<Array<ObjetivoDto & { fuente: 'sugerido' | 'manual'; updated_by_username: string | null }>> {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.mkt_ranking_objectives').where({ promo_id: promoId })
        .orderBy(['canal', 'warehouse_code', 'vendor_code']);
      return rows.map((r: Record<string, unknown>) => ({
        warehouse_code: String(r['warehouse_code']),
        canal: String(r['canal']),
        vendor_code: String(r['vendor_code'] ?? ''),
        objetivo_semanal: nOrNull(r['objetivo_semanal']),
        fuente: (r['fuente'] as 'sugerido' | 'manual') ?? 'manual',
        updated_by_username: (r['updated_by_username'] as string) ?? null,
      }));
    });
  }

  /**
   * Guarda objetivos. `objetivo_semanal` NULL o 0 = quitarlo (vuelve a «sin objetivo», que no es
   * cero). Lo capturado a mano queda `manual`; el sugerido aceptado tal cual queda `sugerido`.
   */
  async guardarObjetivos(promoId: string, items: ObjetivoDto[], quien: Quien): Promise<{ guardados: number; quitados: number }> {
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('No hay objetivos que guardar');
    if (items.length > 2000) throw new BadRequestException('Demasiados objetivos en una sola llamada');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const promo = await trx('commercial.mkt_ranking_promos').where({ id: promoId }).whereNull('deleted_at').first();
      if (!promo) throw new NotFoundException('Promoción no encontrada');
      let guardados = 0, quitados = 0;
      for (const it of items) {
        const wh = String(it.warehouse_code ?? '').trim();
        if (!/^\d{2}$/.test(wh)) throw new BadRequestException(`Sucursal inválida: ${wh}`);
        if (!esCanal(it.canal)) throw new BadRequestException(`Canal inválido: ${it.canal}`);
        const vendor = it.canal === 'mostrador' ? '' : String(it.vendor_code ?? '').trim().slice(0, 40);
        const llave = { tenant_id: tenantId, promo_id: promoId, warehouse_code: wh, canal: it.canal, vendor_code: vendor };
        const v = it.objetivo_semanal === null || it.objetivo_semanal === undefined ? null : Number(it.objetivo_semanal);
        if (v === null || !(v > 0)) {
          quitados += await trx('commercial.mkt_ranking_objectives').where(llave).delete();
          continue;
        }
        if (!Number.isFinite(v) || v > 1_000_000) throw new BadRequestException('Objetivo fuera de rango');
        await trx('commercial.mkt_ranking_objectives')
          .insert({
            ...llave, objetivo_semanal: Math.round(v * 100) / 100, fuente: it.fuente === 'sugerido' ? 'sugerido' : 'manual',
            created_by: quien.id ?? null, created_by_username: quien.username ?? null,
            updated_by: quien.id ?? null, updated_by_username: quien.username ?? null,
          })
          .onConflict(['tenant_id', 'promo_id', 'warehouse_code', 'canal', 'vendor_code'])
          .merge(['objetivo_semanal', 'fuente', 'updated_by', 'updated_by_username', 'updated_at']);
        guardados++;
      }
      return { guardados, quitados };
    });
  }

  /**
   * El sugerido de cada participante de cada promo vigente en la semana: el promedio semanal de lo
   * vendido en las 4 semanas anteriores (sólo las que caen en la vigencia). Si `aplicar`, lo guarda
   * como `sugerido` SÓLO donde no hay objetivo — nunca pisa una captura.
   */
  async sugerirObjetivos(semanaPedida: string | undefined, canal: string | undefined, aplicar: boolean, quien: Quien): Promise<{
    semana: Semana; sugeridos: ObjetivoDinamico[];
    aplicados: number;
  }> {
    const semana = this.semana(semanaPedida);
    const canales: Canal[] = canal ? (esCanal(canal) ? [canal] : []) : [...CANALES];
    if (!canales.length) throw new BadRequestException('Canal inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const promos = await this.promosVigentes(trx, semana);
      const sugeridos = await this.objetivosDinamicos(trx, promos, semana, canales);
      let aplicados = 0;
      if (aplicar) {
        for (const s of sugeridos) {
          if (s.sugerido === null) continue;
          const ins = await trx.raw(
            `INSERT INTO commercial.mkt_ranking_objectives
               (tenant_id, promo_id, warehouse_code, canal, vendor_code, objetivo_semanal, fuente,
                created_by, created_by_username, updated_by, updated_by_username)
             VALUES (?, ?, ?, ?, ?, ?, 'sugerido', ?, ?, ?, ?)
             ON CONFLICT (tenant_id, promo_id, warehouse_code, canal, vendor_code) DO NOTHING`,
            [tenantId, s.promo_id, s.warehouse_code, s.canal, s.vendor_code, s.sugerido,
              quien.id ?? null, quien.username ?? null, quien.id ?? null, quien.username ?? null],
          );
          aplicados += ins.rowCount ?? 0;
        }
      }
      return { semana, sugeridos, aplicados };
    });
  }

  /**
   * `[MKT.17]` El objetivo DINÁMICO de una semana para cada participante de cada promo: el promedio
   * de lo vendido en las 4 semanas anteriores que caen en la vigencia (`objetivoSugerido`: hacia
   * arriba, mínimo 1; sin historia, NULL). Lo usan el ranking (en vivo) y el editor de objetivos.
   */
  private async objetivosDinamicos(trx: Knex.Transaction, promos: PromoMkt[], semana: Semana, canales: Canal[]): Promise<ObjetivoDinamico[]> {
      const sugeridos: ObjetivoDinamico[] = [];
      const nombreVendedor = new Map<string, string>();
      if (!promos.length) return sugeridos;
      const desde = sumarDias(semana.lunes, -28);
      const hasta = sumarDias(semana.lunes, -1);
      const codes = [...new Set(promos.map((p) => p.code))];
      const r = await trx.raw(
        // La venta diaria materializada: mismas unidades base y mismo canal/vendedor que la línea
        // (21 de 21 cruces), en una fracción del tiempo.
        `SELECT date_trunc('week', business_date)::date semana, warehouse_code, channel canal,
                CASE WHEN channel = 'mostrador' THEN '' ELSE vendor_code END vendor_code, sku, sum(units) qty, max(vendor_name) vendor_name
           FROM analytics.mv_kepler_sales_daily
          WHERE business_date BETWEEN ? AND ? AND sku = ANY(?::text[]) AND channel = ANY(?::text[])
          GROUP BY 1, 2, 3, 4, 5`,
        [desde, hasta, codes, canales],
      );
      // (promo, sucursal, canal, vendedor) -> { semana -> qty }
      const hist = new Map<string, Map<string, number>>();
      for (const row of r.rows as Array<Record<string, unknown>>) {
        const sem = ymd(row['semana']);
        for (const p of promos) {
          if (p.code !== row['sku']) continue;
          const c = String(row['canal']) as Canal;
          if (!p.canales.includes(c)) continue;
          if (p.warehouse_codes && !p.warehouse_codes.includes(String(row['warehouse_code']))) continue;
          if (sumarDias(sem, 6) < p.vigencia_desde) continue; // antes de la promo no cuenta
          const k = `${p.id}|${row['warehouse_code']}|${c}|${row['vendor_code']}`;
          const m = hist.get(k) ?? new Map<string, number>();
          m.set(sem, (m.get(sem) ?? 0) + n(row['qty']));
          if (row['vendor_name']) nombreVendedor.set(String(row['vendor_code']), String(row['vendor_name']));
          hist.set(k, m);
        }
      }
      for (const [k, m] of hist) {
        const [promo_id, warehouse_code, c, vendor_code] = k.split('|');
        if (!canales.includes(c as Canal)) continue;
        // Semanas de historia dentro de la vigencia (las que no vendieron cuentan como 0).
        const p = promos.find((x) => x.id === promo_id)!;
        const semanas: string[] = [];
        for (let s = desde; s <= hasta; s = sumarDias(s, 7)) if (sumarDias(s, 6) >= p.vigencia_desde) semanas.push(s);
        const ventas = semanas.map((s) => m.get(s) ?? 0);
        sugeridos.push({
          promo_id, warehouse_code, canal: c as Canal, vendor_code, vendor_name: nombreVendedor.get(vendor_code) ?? '',
          sugerido: objetivoSugerido(ventas), semanas_historia: semanas.length,
        });
      }
      return sugeridos;
  }

  // ═════════════════════════════════ ranking ═════════════════════════════════

  semana(pedida: string | undefined): Semana {
    try {
      return resolverSemana(pedida, todayMx());
    } catch {
      throw new BadRequestException('Esa semana todavía no empieza');
    }
  }

  private async promosVigentes(trx: Knex.Transaction, s: Semana): Promise<PromoMkt[]> {
    const rows = await trx('commercial.mkt_ranking_promos')
      .whereNull('deleted_at').where('activo', true)
      .where('vigencia_desde', '<=', s.domingo)
      .where((w) => w.whereNull('vigencia_hasta').orWhere('vigencia_hasta', '>=', s.lunes))
      .select('*');
    return rows.map((r: Record<string, unknown>) => this.mapPromo({ ...r, objetivos: 0 }));
  }

  private async nombresSucursal(trx: Knex.Transaction): Promise<Map<string, string>> {
    const rows = await trx('commercial.warehouses').whereNull('deleted_at').whereNotNull('kepler_code')
      .select('kepler_code', 'name');
    return new Map(rows.map((r: { kepler_code: string; name: string }) => [String(r.kepler_code).trim(), r.name]));
  }

  /**
   * `promoId` (`[MKT.16]`): el ranking de UNA promoción — el lugar se recalcula sólo con ella, con
   * la misma regla. La lista de promos del filtro (`promos_lista`) sale siempre completa.
   * `sucursales`: el ranking de PROMOCIONES se calcula sólo con los participantes de esas sucursales;
   * el de participantes no cambia (su lugar es el de toda la semana; la pantalla sólo filtra filas).
   */
  async ranking(semanaPedida: string | undefined, canalPedido: string | undefined, promoId?: string, sucursales?: string[]): Promise<RankingSemana> {
    const canal: Canal = esCanal(canalPedido) ? canalPedido : 'mostrador';
    const semana = this.semana(semanaPedida);
    return this.tk.run(async (trx) => {
      const nombres = await this.nombresSucursal(trx);
      const todas = (await this.promosVigentes(trx, semana)).filter((p) => p.canales.includes(canal));
      const promos = promoId ? todas.filter((p) => p.id === promoId) : todas;
      const base: RankingSemana = {
        semana, canal, canal_texto: CANAL_TEXTO[canal], promos_vigentes: promos.length,
        promos_lista: todas.map((p) => ({ id: p.id, code: p.code, mecanica: p.mecanica }))
          .sort((a, b) => a.mecanica.localeCompare(b.mecanica, 'es')),
        promo_filtrada: promoId ? (promos[0]?.id ?? null) : null,
        promedio_general: null, participantes: [], promos_ranking: [],
        criterio: 'Objetivo = el que fijó Mercadotecnia o, si no fijó, el DINÁMICO: el promedio de las 4 semanas anteriores '
          + 'dentro de la vigencia, recalculado cada semana. '
          + 'Cubrimiento = venta ÷ objetivo semanal, con tope de 100 % por promoción. El lugar es el promedio de '
          + 'las promociones CON objetivo; las que no tienen se cuentan aparte. Venta = veces que se aplicó el código de '
          + 'promoción en Kepler, de lunes a domingo.',
        consultado_at: new Date().toISOString(),
      };
      if (!promos.length) return base;

      const codes = [...new Set(promos.map((p) => p.code))];
      const ids = promos.map((p) => p.id);
      const [identificados, ventas, objetivos, existencias, dinamicos] = await Promise.all([
        // `[MKT.15]` El producto de cada promo: tickets de las 4 semanas que cierran ésta, sin salir de su vigencia.
        this.productosDePromos(trx, promos.map((p) => {
          const hace4 = sumarDias(semana.lunes, -21);
          return { code: p.code, descripcion: p.descripcion_kepler ?? p.mecanica, desde: p.vigencia_desde > hace4 ? p.vigencia_desde : hace4, hasta: semana.hasta };
        })),
        trx.raw(
          `SELECT warehouse_code, CASE WHEN ? = 'mostrador' THEN '' ELSE vendor_code END vendor_code,
                  max(vendor_name) vendor_name, sku, sum(qty) qty, array_agg(DISTINCT producto) descripciones
             FROM analytics.v_kepler_sales_lines
            WHERE business_date BETWEEN ? AND ? AND sku = ANY(?::text[]) AND canal = ?
            GROUP BY 1, 2, 4`,
          [canal, semana.lunes, semana.hasta, codes, canal],
        ),
        trx('commercial.mkt_ranking_objectives').whereIn('promo_id', ids).where('canal', canal),
        canal === 'mostrador'
          ? trx.raw(`SELECT warehouse_code, sku, qty_stock_units FROM analytics.v_erp_stock_on_hand WHERE sku = ANY(?::text[])`, [codes])
          : Promise.resolve({ rows: [] }),
        // `[MKT.17]` El objetivo dinámico de ESTA semana (la matview, ~130 ms medido).
        this.objetivosDinamicos(trx, promos, semana, [canal]),
      ]);

      const ventaDe = new Map<string, { qty: number; desc: string[]; vendor_name: string }>();
      for (const v of ventas.rows as Array<Record<string, unknown>>) {
        ventaDe.set(`${v['warehouse_code']}|${v['vendor_code']}|${v['sku']}`, {
          qty: n(v['qty']), desc: ((v['descripciones'] as string[]) ?? []).filter(Boolean), vendor_name: String(v['vendor_name'] ?? ''),
        });
      }
      // `[MKT.17]` Lo que Marketing FIJÓ gana; donde no fijó nada, el dinámico de esta semana.
      const objDe = new Map<string, { v: number; fuente: 'fijo' | 'dinamico' }>();
      for (const d of dinamicos) {
        if (d.sugerido !== null) objDe.set(`${d.promo_id}|${d.warehouse_code}|${d.vendor_code}`, { v: d.sugerido, fuente: 'dinamico' });
      }
      for (const o of objetivos as Array<Record<string, unknown>>) {
        objDe.set(`${o['promo_id']}|${o['warehouse_code']}|${o['vendor_code'] ?? ''}`, { v: n(o['objetivo_semanal']), fuente: 'fijo' });
      }
      const exDe = new Map<string, number>();
      for (const e of existencias.rows as Array<Record<string, unknown>>) exDe.set(`${e['warehouse_code']}|${e['sku']}`, n(e['qty_stock_units']));

      // `[MKT.15]` La venta de la semana de esos productos, en el mismo canal y participante. Se lee
      // la línea (no la matview: ésa pide el producto en el catálogo) y la caja sale de la ficha de
      // Kepler de cada sucursal, en consulta aparte (unirla dentro tardaba 31 s, ver incentivos).
      const skusProducto = [...new Set([...identificados.values()].flatMap((x) => x.productos.map((p) => p.sku)))];
      const [ventaProd, factores] = skusProducto.length
        ? await Promise.all([
          trx.raw(
            `SELECT warehouse_code, CASE WHEN ? = 'mostrador' THEN '' ELSE vendor_code END vendor_code, sku, sum(qty) qty
               FROM analytics.v_kepler_sales_lines
              WHERE business_date BETWEEN ? AND ? AND sku = ANY(?::text[]) AND canal = ?
              GROUP BY 1, 2, 3`,
            [canal, semana.lunes, semana.hasta, skusProducto, canal]),
          trx.raw(`SELECT sucursal, sku, factor_caja FROM analytics.v_kepler_unit_ladder WHERE sku = ANY(?::text[])`, [skusProducto]),
        ])
        : [{ rows: [] }, { rows: [] }];
      const prodDe = new Map<string, number>();
      for (const v of ventaProd.rows as Array<Record<string, unknown>>) prodDe.set(`${v['warehouse_code']}|${v['vendor_code']}|${v['sku']}`, n(v['qty']));
      const factorDe = new Map<string, number>();
      for (const f of factores.rows as Array<Record<string, unknown>>) {
        const v = nOrNull(f['factor_caja']);
        if (v && v > 0) factorDe.set(`${String(f['sucursal']).trim()}|${f['sku']}`, v);
      }

      // Participantes: en mostrador, cada sucursal donde aplica alguna promo; en los demás canales,
      // cada vendedor que vendió algún código o que tiene un objetivo.
      const part = new Map<string, { warehouse_code: string; vendor_code: string; vendor_name: string }>();
      const sucursalesDePromo = (p: PromoMkt) => p.warehouse_codes ?? [...nombres.keys()].filter((k) => k !== '00');
      if (canal === 'mostrador') {
        for (const p of promos) for (const w of sucursalesDePromo(p)) part.set(`${w}|`, { warehouse_code: w, vendor_code: '', vendor_name: '' });
      } else {
        for (const v of ventas.rows as Array<Record<string, unknown>>) {
          const k = `${v['warehouse_code']}|${v['vendor_code']}`;
          if (!part.has(k)) part.set(k, { warehouse_code: String(v['warehouse_code']), vendor_code: String(v['vendor_code']), vendor_name: String(v['vendor_name'] ?? '') });
        }
        for (const o of objetivos as Array<Record<string, unknown>>) {
          const k = `${o['warehouse_code']}|${o['vendor_code']}`;
          if (!part.has(k)) part.set(k, { warehouse_code: String(o['warehouse_code']), vendor_code: String(o['vendor_code']), vendor_name: '' });
        }
        // `[MKT.17]` Quien vendió en las semanas previas tiene objetivo dinámico: si esta semana no
        // vendió, entra con venta 0 (antes desaparecía del ranking sin que se notara).
        for (const d of dinamicos) {
          const k = `${d.warehouse_code}|${d.vendor_code}`;
          if (d.sugerido !== null && !part.has(k)) part.set(k, { warehouse_code: d.warehouse_code, vendor_code: d.vendor_code, vendor_name: d.vendor_name });
        }
      }

      const participantes = [...part.values()].map((pa) => {
        const promosDe = promos.filter((p) => !p.warehouse_codes || p.warehouse_codes.includes(pa.warehouse_code));
        const renglones: RenglonRanking[] = promosDe.map((p) => {
          const v = ventaDe.get(`${pa.warehouse_code}|${pa.vendor_code}|${p.code}`);
          const o = objDe.get(`${p.id}|${pa.warehouse_code}|${pa.vendor_code}`);
          const venta = v?.qty ?? 0;
          const alta = normal(p.descripcion_kepler);
          const ident = identificados.get(p.code);
          const productos: VentaProductoPromo[] = (ident?.productos ?? []).map((x) => {
            const unidades = prodDe.get(`${pa.warehouse_code}|${pa.vendor_code}|${x.sku}`) ?? 0;
            const f = factorDe.get(`${pa.warehouse_code}|${x.sku}`);
            return { sku: x.sku, nombre: x.nombre, unidades, cajas: f ? Math.round((unidades / f) * 100) / 100 : null };
          });
          return {
            productos,
            productos_metodo: ident?.metodo ?? 'sin_identificar',
            productos_nota: ident?.nota ?? 'Sin dato.',
            promo_id: p.id, code: p.code, mecanica: p.mecanica,
            objetivo: o?.v ?? null, objetivo_fuente: o?.fuente ?? null,
            venta, cubrimiento: cubrimiento(venta, o?.v ?? null),
            existencia: canal === 'mostrador' ? (exDe.get(`${pa.warehouse_code}|${p.code}`) ?? null) : null,
            descripcion_distinta: !!alta && !!v?.desc.length && v.desc.some((d) => normal(d) !== alta),
          };
        }).sort((a, b) => (b.cubrimiento ?? -1) - (a.cubrimiento ?? -1) || b.venta - a.venta);
        const pt = puntaje(renglones.map((r) => ({ promo_id: r.promo_id, objetivo: r.objetivo, venta: r.venta })));
        const wname = nombres.get(pa.warehouse_code) ?? `Sucursal ${pa.warehouse_code}`;
        // Un vendedor con objetivo y sin venta no trae nombre de la venta: se muestra su clave de Kepler.
        const vname = pa.vendor_name || pa.vendor_code.split(':').pop() || pa.vendor_code;
        return {
          clave: `${pa.warehouse_code}|${pa.vendor_code}`, warehouse_code: pa.warehouse_code, warehouse_name: wname,
          vendor_code: pa.vendor_code, nombre: canal === 'mostrador' ? wname : vname,
          ...pt, promos: renglones,
        };
      });
      const ordenados = ordenarRanking(participantes);

      // `[MKT.16]` Ranking de PROMOCIONES: cada promo con los renglones de todos sus participantes,
      // con la MISMA regla (tope de 100 %, sólo los que tienen objetivo, sin lugar si nadie tiene).
      const promosRanking = ordenarRanking(promos.map((p) => {
        const filas = ordenados.filter((pa) => !sucursales?.length || sucursales.includes(pa.warehouse_code))
          .flatMap((pa) => pa.promos.filter((x) => x.promo_id === p.id));
        const pt = puntaje(filas.map((x) => ({ promo_id: p.id, objetivo: x.objetivo, venta: x.venta })));
        const ident = identificados.get(p.code);
        return {
          promo_id: p.id, code: p.code, nombre: p.mecanica,
          productos: (ident?.productos ?? []).map((x) => x.nombre ?? x.sku),
          productos_metodo: ident?.metodo ?? ('sin_identificar' as MetodoProducto),
          participantes: filas.length,
          venta_total: filas.reduce((a, x) => a + x.venta, 0),
          objetivo_total: filas.reduce((a, x) => a + (x.objetivo ?? 0), 0),
          ...pt,
        };
      }));
      return { ...base, participantes: ordenados, promedio_general: promedioGeneral(ordenados), promos_ranking: promosRanking };
    });
  }

  // ═════════════════════════════════ incentivos ═════════════════════════════════

  validarIncentivo(dto: IncentivoDto, parcial: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!parcial || dto.nombre !== undefined) {
      const v = String(dto.nombre ?? '').trim();
      if (v.length < 3) throw new BadRequestException('Ponle nombre al incentivo (producto o marca)');
      out['nombre'] = v.slice(0, 200);
    }
    if (!parcial || dto.tipo !== undefined) {
      if (!TIPOS.includes(dto.tipo as TipoIncentivo)) throw new BadRequestException('Tipo de incentivo inválido');
      out['tipo'] = dto.tipo;
    }
    if (!parcial || dto.pago !== undefined) {
      const p = Number(dto.pago);
      if (!(p > 0) || p > 100_000) throw new BadRequestException('El monto a pagar debe ser mayor a cero');
      out['pago'] = Math.round(p * 100) / 100;
    }
    if (dto.base_monto !== undefined) out['base_monto'] = dto.base_monto === null ? null : Number(dto.base_monto);
    const tipo = (out['tipo'] as string) ?? dto.tipo;
    if (tipo === 'por_monto' && (out['base_monto'] ?? dto.base_monto) !== undefined) {
      const b = Number(out['base_monto'] ?? dto.base_monto);
      if (!(b > 0)) throw new BadRequestException('Indica cada cuántos pesos se paga');
    }
    if (dto.redondeo !== undefined) {
      if (dto.redondeo !== 'proporcional' && dto.redondeo !== 'completo') throw new BadRequestException('Redondeo inválido');
      out['redondeo'] = dto.redondeo;
    }
    if (!parcial || dto.skus !== undefined) {
      const s = [...new Set((dto.skus ?? []).map((x) => String(x).trim().toUpperCase()).filter((x) => CODIGO.test(x)))];
      if (tipo !== 'por_captura' && !s.length) throw new BadRequestException('Elige al menos un producto');
      out['skus'] = s;
    }
    if (!parcial || dto.vigencia_desde !== undefined) {
      if (!FECHA.test(String(dto.vigencia_desde ?? ''))) throw new BadRequestException('Falta la fecha de inicio');
      out['vigencia_desde'] = dto.vigencia_desde;
    }
    if (dto.vigencia_hasta !== undefined) {
      if (dto.vigencia_hasta && !FECHA.test(dto.vigencia_hasta)) throw new BadRequestException('La fecha de fin no es válida');
      out['vigencia_hasta'] = dto.vigencia_hasta || null;
    }
    if (out['vigencia_desde'] && out['vigencia_hasta'] && String(out['vigencia_hasta']) < String(out['vigencia_desde'])) {
      throw new BadRequestException('La fecha de fin es anterior a la de inicio');
    }
    if (!parcial || dto.canales !== undefined) {
      const c = [...new Set((dto.canales ?? [...CANALES]).filter(esCanal))];
      if (!c.length) throw new BadRequestException('Elige al menos un canal');
      out['canales'] = c;
    }
    if (dto.warehouse_codes !== undefined) {
      const w = (dto.warehouse_codes ?? []).map((x) => String(x).trim()).filter((x) => /^\d{2}$/.test(x));
      out['warehouse_codes'] = w.length ? [...new Set(w)] : null;
    }
    if (dto.activo !== undefined) out['activo'] = dto.activo === true;
    if (dto.notas !== undefined) out['notas'] = dto.notas ? String(dto.notas).slice(0, 1000) : null;
    return out;
  }

  private mapIncentivo(r: Record<string, unknown>, nombres: Map<string, string | null>): Incentivo {
    const tipo = r['tipo'] as TipoIncentivo;
    const pago = n(r['pago']);
    const base_monto = nOrNull(r['base_monto']);
    const skus = (r['skus'] as string[]) ?? [];
    return {
      id: String(r['id']), nombre: String(r['nombre']), tipo, regla: textoRegla({ tipo, pago, base_monto }),
      pago, base_monto, redondeo: (r['redondeo'] as Redondeo) ?? 'proporcional', skus,
      productos: skus.map((s) => ({ sku: s, nombre: nombres.get(s) ?? null })),
      vigencia_desde: ymd(r['vigencia_desde']), vigencia_hasta: ymdOrNull(r['vigencia_hasta']),
      canales: ((r['canales'] as string[]) ?? []).filter(esCanal),
      warehouse_codes: (r['warehouse_codes'] as string[]) ?? null,
      activo: r['activo'] === true, notas: (r['notas'] as string) ?? null,
    };
  }

  private async nombresProducto(trx: Knex.Transaction, skus: string[]): Promise<Map<string, string | null>> {
    if (!skus.length) return new Map();
    const r = await trx.raw(
      `SELECT btrim(c1) sku, (array_agg(btrim(c2) ORDER BY sucursal))[1] nombre FROM kepler_ods.kdii WHERE btrim(c1) = ANY(?::text[]) GROUP BY 1`,
      [skus]);
    return new Map(r.rows.map((x: { sku: string; nombre: string }) => [x.sku, x.nombre]));
  }

  async crearIncentivo(dto: IncentivoDto, quien: Quien): Promise<Incentivo> {
    const datos = this.validarIncentivo(dto, false);
    if (datos['tipo'] === 'por_monto' && !(Number(datos['base_monto']) > 0)) throw new BadRequestException('Indica cada cuántos pesos se paga');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.mkt_incentives').insert({
        ...datos, tenant_id: tenantId,
        created_by: quien.id ?? null, created_by_username: quien.username ?? null,
        updated_by: quien.id ?? null, updated_by_username: quien.username ?? null,
      }).returning('*');
      return this.mapIncentivo(row, await this.nombresProducto(trx, row.skus ?? []));
    });
  }

  async editarIncentivo(id: string, dto: IncentivoDto, quien: Quien): Promise<Incentivo> {
    const datos = this.validarIncentivo(dto, true);
    return this.tk.run(async (trx) => {
      const actual = await trx('commercial.mkt_incentives').where({ id }).whereNull('deleted_at').first();
      if (!actual) throw new NotFoundException('Incentivo no encontrado');
      const tipo = (datos['tipo'] as string) ?? actual.tipo;
      const base = 'base_monto' in datos ? datos['base_monto'] : actual.base_monto;
      if (tipo === 'por_monto' && !(Number(base) > 0)) throw new BadRequestException('Indica cada cuántos pesos se paga');
      const [row] = await trx('commercial.mkt_incentives').where({ id })
        .update({ ...datos, updated_by: quien.id ?? null, updated_by_username: quien.username ?? null, updated_at: trx.fn.now() })
        .returning('*');
      return this.mapIncentivo(row, await this.nombresProducto(trx, row.skus ?? []));
    });
  }

  async borrarIncentivo(id: string, quien: Quien): Promise<{ ok: true }> {
    return this.tk.run(async (trx) => {
      const k = await trx('commercial.mkt_incentives').where({ id }).whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), updated_by: quien.id ?? null, updated_by_username: quien.username ?? null });
      if (!k) throw new NotFoundException('Incentivo no encontrado');
      return { ok: true as const };
    });
  }

  /** Capturas «por exhibidor colocado»: lo único que no sale de Kepler. */
  async guardarCapturas(id: string, semanaPedida: string, items: Array<{ warehouse_code: string; vendor_code: string; cantidad: number }>, quien: Quien): Promise<{ guardadas: number }> {
    if (!FECHA.test(String(semanaPedida ?? ''))) throw new BadRequestException('Falta la semana');
    const semana = lunesDe(semanaPedida);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const inc = await trx('commercial.mkt_incentives').where({ id }).whereNull('deleted_at').first();
      if (!inc) throw new NotFoundException('Incentivo no encontrado');
      if (inc.tipo !== 'por_captura') throw new BadRequestException('Este incentivo se calcula de la venta; no lleva captura');
      let guardadas = 0;
      for (const it of items ?? []) {
        const wh = String(it.warehouse_code ?? '').trim();
        const vendor = String(it.vendor_code ?? '').trim().slice(0, 40);
        const c = Number(it.cantidad);
        if (!/^\d{2}$/.test(wh) || !vendor || !Number.isFinite(c) || c < 0) throw new BadRequestException('Captura inválida');
        await trx('commercial.mkt_incentive_captures').insert({
          tenant_id: tenantId, incentive_id: id, warehouse_code: wh, vendor_code: vendor, semana, cantidad: c,
          created_by: quien.id ?? null, created_by_username: quien.username ?? null,
          updated_by: quien.id ?? null, updated_by_username: quien.username ?? null,
        }).onConflict(['tenant_id', 'incentive_id', 'warehouse_code', 'vendor_code', 'semana'])
          .merge(['cantidad', 'updated_by', 'updated_by_username', 'updated_at']);
        guardadas++;
      }
      return { guardadas };
    });
  }

  /**
   * Los incentivos vigentes en la semana con lo que lleva cada vendedor: la cantidad de la semana
   * y la ACUMULADA desde el inicio del incentivo (el Excel llevaba las dos: VENTA y ACUM).
   */
  async incentivos(semanaPedida: string | undefined, opts: { todos?: boolean } = {}): Promise<{ semana: Semana; incentivos: IncentivoConResultado[]; consultado_at: string }> {
    const semana = this.semana(semanaPedida);
    return this.tk.run(async (trx) => {
      const q = trx('commercial.mkt_incentives').whereNull('deleted_at').orderBy([{ column: 'activo', order: 'desc' }, { column: 'vigencia_desde', order: 'desc' }]);
      if (!opts.todos) {
        q.where('activo', true).where('vigencia_desde', '<=', semana.domingo)
          .where((w) => w.whereNull('vigencia_hasta').orWhere('vigencia_hasta', '>=', semana.lunes));
      }
      const rows = (await q) as Array<Record<string, unknown>>;
      const nombresSuc = await this.nombresSucursal(trx);
      const nombresProd = await this.nombresProducto(trx, [...new Set(rows.flatMap((r) => (r['skus'] as string[]) ?? []))]);
      const out: IncentivoConResultado[] = [];
      for (const r of rows) {
        const inc = this.mapIncentivo(r, nombresProd);
        out.push({ ...inc, ...(await this.resultadoIncentivo(trx, inc, semana, nombresSuc)) });
      }
      return { semana, incentivos: out, consultado_at: new Date().toISOString() };
    });
  }

  private async resultadoIncentivo(trx: Knex.Transaction, inc: Incentivo, semana: Semana, nombres: Map<string, string>): Promise<Pick<IncentivoConResultado, 'resultados' | 'total_semana' | 'total_acumulado' | 'medido' | 'nota_medicion'>> {
    const desde = inc.vigencia_desde;
    const hasta = inc.vigencia_hasta && inc.vigencia_hasta < semana.hasta ? inc.vigencia_hasta : semana.hasta;
    const vacio = { resultados: [], total_semana: 0, total_acumulado: 0 };
    if (hasta < desde) return { ...vacio, medido: false, nota_medicion: 'El incentivo empieza después de esta semana.' };
    const lunes = semana.lunes > desde ? semana.lunes : desde;
    let rows: Array<Record<string, unknown>>;

    if (inc.tipo === 'por_captura') {
      const r = await trx.raw(
        `SELECT warehouse_code, vendor_code, NULL::text vendor_name, NULL::text canal,
                sum(cantidad) FILTER (WHERE semana = ?) sem, sum(cantidad) acum, 0 sin_resolver
           FROM commercial.mkt_incentive_captures
          WHERE incentive_id = ? AND semana BETWEEN ? AND ?
          GROUP BY 1, 2`,
        [semana.lunes, inc.id, lunesDe(desde), semana.lunes]);
      rows = r.rows;
    } else if (inc.tipo === 'por_cliente') {
      // El cliente sólo viaja en la LÍNEA de venta, y recorrerla meses tarda (8.7 s medido para
      // 2 meses): se mide la semana y se paga por semana. El acumulado se declara igual a la semana.
      const r = await trx.raw(
        `SELECT l.warehouse_code, l.vendor_code, max(l.vendor_name) vendor_name, min(l.canal) canal,
                count(DISTINCT l.cliente) FILTER (WHERE l.cliente IS NOT NULL) sem,
                count(DISTINCT l.cliente) FILTER (WHERE l.cliente IS NOT NULL) acum, 0 sin_resolver
           FROM analytics.v_kepler_sales_lines l
          WHERE l.business_date BETWEEN ? AND ?
            AND l.sku = ANY(?::text[])
            AND l.canal = ANY(?::text[])
            ${inc.warehouse_codes ? 'AND l.warehouse_code = ANY(?::text[])' : ''}
          GROUP BY 1, 2`,
        [lunes, hasta, inc.skus, inc.canales, ...(inc.warehouse_codes ? [inc.warehouse_codes] : [])]);
      rows = r.rows;
    } else {
      // Unidades y monto de la venta diaria materializada (2 meses: 259 ms medido; contra la línea,
      // 8.7 s). Sus unidades son las BASE de Kepler: cuadraron con `kdm2.c9` en 21 de 21 cruces
      // (sucursal × SKU, semana 45). Se agrupa por SKU para poder dividir entre SU factor de caja.
      const r = await trx.raw(
        `SELECT warehouse_code, vendor_code, sku, max(vendor_name) vendor_name, min(channel) canal,
                sum(units) FILTER (WHERE business_date >= ?) sem_u, sum(units) acum_u,
                sum(monto) FILTER (WHERE business_date >= ?) sem_m, sum(monto) acum_m
           FROM analytics.mv_kepler_sales_daily
          WHERE business_date BETWEEN ? AND ?
            AND sku = ANY(?::text[])
            AND channel = ANY(?::text[])
            ${inc.warehouse_codes ? 'AND warehouse_code = ANY(?::text[])' : ''}
          GROUP BY 1, 2, 3`,
        [lunes, lunes, desde, hasta, inc.skus, inc.canales, ...(inc.warehouse_codes ? [inc.warehouse_codes] : [])]);
      // El factor de caja de la ficha de Kepler de cada sucursal, sólo de estos SKUs (11 ms medido;
      // unirlo dentro de la consulta de venta tardaba 31 s).
      const factor = new Map<string, number>();
      if (inc.tipo === 'por_caja') {
        const f = await trx.raw(
          `SELECT sucursal, sku, factor_caja FROM analytics.v_kepler_unit_ladder WHERE sku = ANY(?::text[])`, [inc.skus]);
        for (const x of f.rows as Array<Record<string, unknown>>) {
          const v = nOrNull(x['factor_caja']);
          if (v && v > 0) factor.set(`${x['sucursal']}|${x['sku']}`, v);
        }
      }
      const porVendedor = new Map<string, Record<string, unknown> & { sem: number; acum: number; sin_resolver: number }>();
      for (const x of r.rows as Array<Record<string, unknown>>) {
        const k = `${x['warehouse_code']}|${x['vendor_code']}`;
        const acc = porVendedor.get(k) ?? { warehouse_code: x['warehouse_code'], vendor_code: x['vendor_code'], vendor_name: x['vendor_name'], canal: x['canal'], sem: 0, acum: 0, sin_resolver: 0 };
        if (inc.tipo === 'por_monto') {
          acc.sem += n(x['sem_m']); acc.acum += n(x['acum_m']);
        } else if (inc.tipo === 'por_unidad') {
          acc.sem += n(x['sem_u']); acc.acum += n(x['acum_u']);
        } else {
          const f = factor.get(`${x['warehouse_code']}|${x['sku']}`);
          if (f) { acc.sem += n(x['sem_u']) / f; acc.acum += n(x['acum_u']) / f; }
          else acc.sin_resolver += n(x['acum_u']);
        }
        porVendedor.set(k, acc);
      }
      rows = [...porVendedor.values()];
    }

    const base = inc.tipo === 'por_monto' ? (inc.base_monto ?? 0) : 1;
    const resultados: ResultadoIncentivo[] = rows.map((x) => {
      const semCant = n(x['sem']) / (base || 1);
      const acumCant = n(x['acum']) / (base || 1);
      const acumUnid = unidadesDePago(acumCant, inc.redondeo);
      // Lo de la semana es la diferencia de lo acumulado: con redondeo «completo», una caja que se
      // termina de juntar esta semana se paga esta semana, no antes.
      const previas = unidadesDePago(acumCant - semCant, inc.redondeo);
      const wh = String(x['warehouse_code']);
      return {
        warehouse_code: wh, warehouse_name: nombres.get(wh) ?? `Sucursal ${wh}`,
        vendor_code: String(x['vendor_code'] ?? ''),
        vendor_name: String(x['vendor_name'] ?? '') || String(x['vendor_code'] ?? '').split(':').pop() || 'Sin vendedor',
        canal: esCanal(x['canal']) ? (x['canal'] as Canal) : null,
        semana_cantidad: Math.round(semCant * 100) / 100,
        acumulado_cantidad: Math.round(acumCant * 100) / 100,
        acumulado_unidades: acumUnid,
        acumulado_pago: Math.round(acumUnid * inc.pago * 100) / 100,
        semana_pago: Math.round((acumUnid - previas) * inc.pago * 100) / 100,
        sin_resolver: n(x['sin_resolver']),
      };
    }).filter((x) => x.acumulado_cantidad > 0 || x.sin_resolver > 0)
      .sort((a, b) => b.acumulado_pago - a.acumulado_pago || a.vendor_name.localeCompare(b.vendor_name, 'es'));
    const sinFactor = resultados.reduce((a, x) => a + x.sin_resolver, 0);
    return {
      resultados,
      total_semana: Math.round(resultados.reduce((a, x) => a + x.semana_pago, 0) * 100) / 100,
      total_acumulado: Math.round(resultados.reduce((a, x) => a + x.acumulado_pago, 0) * 100) / 100,
      medido: true,
      nota_medicion: sinFactor > 0
        ? `${sinFactor} unidades vendidas no tienen factor de caja en la ficha de Kepler: no se pagan hasta corregir la ficha.`
        : inc.tipo === 'por_captura' ? 'Capturado por Marketing: Kepler no registra exhibidores colocados.'
          : inc.tipo === 'por_cliente' ? 'Se mide por semana: clientes distintos de la semana (el acumulado es el de la semana).' : null,
    };
  }
}
