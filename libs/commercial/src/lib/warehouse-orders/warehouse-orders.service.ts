import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService, branchName } from '@megadulces/platform-core';
import type {
  WarehouseOrderDetail,
  WarehouseOrderLine,
  WarehouseOrderRow,
  WarehouseOrderShipment,
  WarehouseOrdersAlcance,
  WarehouseOrdersResponse,
} from '@megadulces/contracts';
import type { Knex } from 'knex';
import { ESTATUS_VIGENTE_SQL } from '../commercial-picking/kepler-origen';
import { ENTREGADO_SQL, sucursalKeplerSql } from '../presale-control/presale-control.service';
import { etapaDePedido } from './etapa-pedido';
import { armarRespuesta, horasAbierto, ORIGEN_PREVENTA, periodo, PeriodoInvalido, relojMx, type Filtros } from './warehouse-orders.engine';

/**
 * `[GP.1]` Tablero de pedidos del almacén — lectura pura sobre el ODS, sin importer
 * (derive-no-copy, mismo patrón que Cortes/Sucursales). La Suite NO escribe en Kepler (ADR-086).
 *
 *  · Pedido   = `kepler_ods.kdm1` `U-D-40`. Origen `c27`, estatus `c11` (o CANCELADO si `c43 = 'C'`:
 *               Kepler conserva el `c11` viejo al cancelar, `[GP.10.0]`), responsables
 *               `c100/c102/c103`, transporte/chofer/guía `c83/c84/c86`. Decode: ERP_KEPLER §3.y.3.
 *  · Renglón  = `kepler_ods.kdm2`. Cantidades por etapa `c51..c54` (en la unidad `c55`), ubicación
 *               por etapa `c59/c60/c61`, etapa en que se agregó el renglón `c28`.
 *  · Embarque = `U-D-41` con `c37='40'` y `c39` = folio del pedido.
 *
 * Claves en cero (`0`, `00000`, `0000000`) = SIN capturar: Kepler guarda ceros en vez de vacío
 * en transporte, chofer, guía y responsables. Se devuelven `null`, nunca como si fueran una clave.
 *
 * `btrim(c1) = sucursal`: el documento es de SU plaza (filtro canónico, Fase PO); sin él, una
 * réplica cruzada fabricaría pedidos duplicados.
 *
 * ⚠️ RENDIMIENTO, medido en prod 2026-10-06 (octubre, 514 pedidos, todas las sucursales): con el
 * conteo de renglones como JOIN + GROUP BY, el planner estimaba UN pedido y volvía a agregar kdm2
 * por cada uno (~780 mil búsquedas, 10–12 s). Con `h` MATERIALIZED y el conteo como LATERAL por
 * pedido (índice `kdm2_pkey`) baja a 130–215 ms. No volver al JOIN.
 */
function headerSql(filtro: 'periodo' | 'folio'): string {
  const donde =
    filtro === 'periodo'
      ? `AND h.c9 >= ?::date AND h.c9 < (?::date + 1)
     AND (?::boolean OR h.sucursal = ANY(?::text[]))`
      : `AND h.sucursal = ? AND (h.c5)::int = ? AND btrim(h.c6::text) = ?`;
  return `
WITH h AS MATERIALIZED (
  SELECT DISTINCT ON (h.sucursal, h.c5, h.c6)
         h.sucursal, h.c2 AS k2, h.c3 AS k3, h.c4 AS k4, h.c5 AS k5, h.c6 AS k6,
         (h.c5)::int                                         AS serie,
         btrim(h.c6::text)                                   AS folio,
         to_char(h.c9::date, 'YYYY-MM-DD')                   AS fecha,
         NULLIF(btrim(h.c62::text), '')                      AS hora,
         upper(NULLIF(btrim(h.c27::text), ''))               AS origen,
         ${ESTATUS_VIGENTE_SQL} AS estatus,
         upper(NULLIF(btrim(h.c11::text), ''))               AS estatus_kepler,
         NULLIF(btrim(h.c10::text), '')                      AS cliente_code,
         NULLIF(btrim(h.c32::text), '')                      AS destino_nombre,
         NULLIF(btrim(h.c34::text), '')                      AS destino_ciudad,
         NULLIF(btrim(h.c12::text), '')                      AS vendedor_code,
         round(NULLIF(btrim(h.c16::text), '')::numeric, 2)   AS importe,
         CASE WHEN btrim(h.c86::text) ~ '^0*$' THEN NULL ELSE btrim(h.c86::text) END AS guia,
         CASE WHEN btrim(h.c83::text) ~ '^0*$' THEN NULL ELSE btrim(h.c83::text) END AS transporte,
         CASE WHEN btrim(h.c84::text) ~ '^0*$' THEN NULL ELSE btrim(h.c84::text) END AS chofer,
         CASE WHEN btrim(h.c100::text) ~ '^0*$' THEN NULL ELSE btrim(h.c100::text) END AS resp_surtido,
         CASE WHEN btrim(h.c102::text) ~ '^0*$' THEN NULL ELSE btrim(h.c102::text) END AS resp_checado,
         CASE WHEN btrim(h.c103::text) ~ '^0*$' THEN NULL ELSE btrim(h.c103::text) END AS resp_embarque
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 40
     AND btrim(h.c1) = btrim(h.sucursal)
     ${donde}
   ORDER BY h.sucursal, h.c5, h.c6, h.c9 DESC
),
vend AS (
  SELECT DISTINCT ON (btrim(u.sucursal), btrim(u.c2::text))
         btrim(u.sucursal) AS sucursal, btrim(u.c2::text) AS code, NULLIF(btrim(u.c3::text), '') AS nombre
    FROM kepler_ods.kduv u
   ORDER BY btrim(u.sucursal), btrim(u.c2::text)
)
SELECT h.sucursal, h.serie, h.folio, h.fecha, h.hora, h.origen, h.estatus, h.estatus_kepler, h.cliente_code,
       h.destino_nombre, h.destino_ciudad, h.vendedor_code, v.nombre AS vendedor_nombre,
       coalesce(lc.renglones, 0) AS renglones, lc.volumen, h.importe, h.guia, h.transporte, h.chofer,
       h.resp_surtido, h.resp_checado, h.resp_embarque
  FROM h
  -- Renglones y volumen por unidad de presentación (c55, cantidad c56), una búsqueda por pedido.
  -- Medido 2026-10-06: octubre, 532 pedidos, 55-140 ms; el 0000367 da 16 CJA, igual que su ticket.
  -- Los renglones también anclan c1: la base de la 03 guarda copias de pedidos de la 02 con la
  -- misma serie y folio que los suyos (41 de 41 chocan, medido 2026-10-06) y se mezclarían.
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(x.n), 0)::int AS renglones,
           jsonb_agg(jsonb_build_object('unidad', x.u, 'cantidad', x.q) ORDER BY x.q DESC) AS volumen
      FROM (SELECT coalesce(upper(NULLIF(btrim(l.c55::text), '')), 'SIN UNIDAD') AS u,
                   sum(coalesce(NULLIF(btrim(l.c56::text), '')::numeric, 0)) AS q, count(*) AS n
              FROM kepler_ods.kdm2 l
             WHERE l.sucursal = h.sucursal AND l.c2 = h.k2 AND l.c3 = h.k3 AND l.c4 = h.k4 AND l.c5 = h.k5 AND l.c6 = h.k6
               AND btrim(l.c1) = btrim(l.sucursal)
             GROUP BY 1) x
  ) lc ON true
  LEFT JOIN vend v ON v.sucursal = h.sucursal AND v.code = h.vendedor_code
 ORDER BY h.fecha DESC, h.hora DESC NULLS LAST, h.sucursal, h.folio DESC`;
}

const LIST_SQL = headerSql('periodo');
const HEADER_SQL = headerSql('folio');

const LINES_SQL = `
SELECT (l.c7)::int                                         AS renglon,
       btrim(l.c8::text)                                   AS sku,
       NULLIF(btrim(l.c10::text), '')                      AS descripcion,
       NULLIF(btrim(l.c9::text), '')::numeric              AS cantidad,
       NULLIF(btrim(l.c11::text), '')                      AS unidad,
       NULLIF(btrim(l.c55::text), '')                      AS unidad_presentacion,
       NULLIF(btrim(l.c51::text), '')::numeric             AS cant_pedida,
       NULLIF(btrim(l.c52::text), '')::numeric             AS cant_surtida,
       NULLIF(btrim(l.c53::text), '')::numeric             AS cant_checada,
       NULLIF(btrim(l.c54::text), '')::numeric             AS cant_embarcada,
       NULLIF(btrim(l.c59::text), '')                      AS ubic_surtido,
       NULLIF(btrim(l.c60::text), '')                      AS ubic_checado,
       NULLIF(btrim(l.c61::text), '')                      AS ubic_embarque,
       upper(NULLIF(btrim(l.c28::text), ''))               AS etapa_alta,
       round(NULLIF(btrim(l.c13::text), '')::numeric, 2)   AS importe
  FROM kepler_ods.kdm2 l
 WHERE l.sucursal = ? AND l.c2 = 'U' AND l.c3 = 'D' AND (l.c4)::int = 40 AND (l.c5)::int = ? AND btrim(l.c6::text) = ?
   AND btrim(l.c1) = btrim(l.sucursal)
 ORDER BY (l.c7)::int`;

const SHIPMENTS_SQL = `
SELECT DISTINCT ON (e.c5, e.c6)
       (e.c5)::int AS serie, btrim(e.c6::text) AS folio, to_char(e.c9::date, 'YYYY-MM-DD') AS fecha,
       upper(NULLIF(btrim(e.c11::text), '')) AS estatus,
       CASE WHEN btrim(e.c86::text) ~ '^0*$' THEN NULL ELSE btrim(e.c86::text) END AS guia
  FROM kepler_ods.kdm1 e
 WHERE e.sucursal = ? AND e.c2 = 'U' AND e.c3 = 'D' AND (e.c4)::int = 41
   AND btrim(e.c1) = btrim(e.sucursal)
   AND btrim(e.c37::text) = '40' AND btrim(e.c39::text) = ?
 ORDER BY e.c5, e.c6, e.c9 DESC`;

const SUC = /^\d{2}$/;
const FOLIO = /^\d{1,10}$/;

export interface WarehouseOrdersQuery {
  month?: string;
  from?: string;
  to?: string;
  /** Uno o varios estatus de Kepler, separados por coma. */
  estatus?: string;
  /** `[GP.10.3]` Una o varias etapas de almacén (`EtapaPedido`), separadas por coma. */
  etapa?: string;
  origen?: string;
  sucursal?: string;
  q?: string;
  /** `[GP.10.3]` `1` = incluir los pedidos de preventa (`PD-`). Sin él, la respuesta es la de siempre. */
  preventa?: string;
}

/**
 * `[GP.10.3]` Lo que sabe el PISO de los pedidos de Kepler desde una fecha: la ola más reciente de
 * cada pedido y su checado vivo. Tablas chicas (63 y 0 filas el 2026-11-13): una consulta, no una
 * por pedido.
 */
const PISO_KEPLER_SQL = `
SELECT x.sucursal, x.serie, x.folio, x.ola_status, x.ola_stage, ck.status AS checado
  FROM (SELECT DISTINCT ON (wo.kepler_sucursal, wo.kepler_serie, wo.kepler_folio)
               wo.kepler_sucursal AS sucursal, wo.kepler_serie AS serie, wo.kepler_folio AS folio,
               pw.status AS ola_status, wo.stage AS ola_stage
          FROM commercial.wave_orders wo
          JOIN commercial.picking_waves pw ON pw.id = wo.wave_id
         WHERE wo.source = 'kepler' AND wo.added_at >= ?::date
         ORDER BY wo.kepler_sucursal, wo.kepler_serie, wo.kepler_folio, wo.added_at DESC) x
  LEFT JOIN LATERAL (
    SELECT oc.status FROM commercial.order_checks oc
     WHERE oc.kepler_sucursal = x.sucursal AND oc.kepler_serie = x.serie AND oc.kepler_folio = x.folio
       AND oc.status <> 'cancelado'
     ORDER BY oc.created_at DESC LIMIT 1) ck ON true`;

/**
 * `[GP.10.3]` Los pedidos de PREVENTA (`PD-`) que el almacén tiene que surtir en el periodo: por su
 * fecha de ENTREGA, que es el día en que se surten. Los hechos de «ya salió» son los mismos que usa
 * la Mesa de Control (`presale-control.service`): documento de Kepler ligado (cobrado), guía de carga
 * impresa y entrega registrada (`ENTREGADO_SQL`, importado de allá).
 * Parámetros: [desde, hasta, todas, sucursales[]].
 */
const SUCURSAL_PREVENTA_SQL = sucursalKeplerSql('w');
const PREVENTA_SQL = `
SELECT o.id, o.code, o.status, to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS fecha,
       round(o.total::numeric, 2) AS importe, (${SUCURSAL_PREVENTA_SQL}) AS sucursal,
       c.erp_customer_code AS cliente_code, c.name AS cliente_nombre, u.nombre AS vendedor_nombre,
       (SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS renglones,
       pp.iniciado, pp.terminado, pp.revisado, ola.status AS ola_status, ola.stage AS ola_stage,
       EXISTS (SELECT 1 FROM commercial.order_kepler_documents d
                WHERE d.order_id = o.id AND d.tenant_id = o.tenant_id AND d.unlinked_at IS NULL) AS ligado,
       EXISTS (SELECT 1 FROM commercial.load_guide_orders lgo
                 JOIN commercial.load_guides g ON g.id = lgo.guide_id AND g.tenant_id = lgo.tenant_id
                WHERE lgo.order_id = o.id AND lgo.tenant_id = o.tenant_id AND lgo.status = 'cargado'
                  AND g.status = 'impresa') AS en_guia,
       EXISTS (${ENTREGADO_SQL}) AS entregado
  FROM commercial.orders o
  LEFT JOIN commercial.customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
  LEFT JOIN commercial.warehouses w ON w.id = o.warehouse_id AND w.tenant_id = o.tenant_id
  LEFT JOIN identity.users u ON u.id = o.user_id AND u.tenant_id = o.tenant_id
  LEFT JOIN LATERAL (
    SELECT pp.started_at IS NOT NULL AS iniciado, pp.finished_at IS NOT NULL AS terminado,
           pp.reviewed_at IS NOT NULL AS revisado
      FROM commercial.presale_picks pp WHERE pp.order_id = o.id AND pp.tenant_id = o.tenant_id LIMIT 1) pp ON true
  LEFT JOIN LATERAL (
    SELECT pw.status, wo.stage FROM commercial.wave_orders wo JOIN commercial.picking_waves pw ON pw.id = wo.wave_id
     WHERE wo.order_id = o.id AND wo.source <> 'kepler' ORDER BY wo.added_at DESC LIMIT 1) ola ON true
 WHERE o.deleted_at IS NULL AND o.delivery_type = 'route' AND o.status IN ('confirmed', 'fulfilled', 'cancelled')
   AND o.requested_delivery_date >= ?::date AND o.requested_delivery_date < (?::date + 1)
   AND (?::boolean OR (${SUCURSAL_PREVENTA_SQL}) = ANY(?::text[]))`;

interface PisoKepler { ola_status: string; ola_stage: string | null; checado: string | null }
interface PreventaCruda {
  id: string; code: string; status: string; fecha: string; importe: string | number | null; sucursal: string | null;
  cliente_code: string | null; cliente_nombre: string | null; vendedor_nombre: string | null; renglones: number;
  iniciado: boolean | null; terminado: boolean | null; revisado: boolean | null;
  ola_status: string | null; ola_stage: string | null; ligado: boolean; en_guia: boolean; entregado: boolean;
}

type Crudo = Omit<
  WarehouseOrderRow,
  'clave' | 'sucursal_nombre' | 'documento' | 'importe' | 'horas_abierto' | 'serie' | 'volumen' | 'etapa' | 'etapa_fuente' | 'desfase' | 'order_id'
> & {
  serie: number | string;
  importe: string | number | null;
  /** jsonb de pg: los números pueden llegar como texto. */
  volumen: Array<{ unidad: string; cantidad: string | number }> | null;
};

/** Renglón crudo de kdm2: los numéricos llegan como texto desde pg. */
type LineaCruda = Record<
  'sku' | 'descripcion' | 'unidad' | 'unidad_presentacion' | 'ubic_surtido' | 'ubic_checado' | 'ubic_embarque' | 'etapa_alta',
  string | null
> &
  Record<'renglon' | 'cantidad' | 'cant_pedida' | 'cant_surtida' | 'cant_checada' | 'cant_embarcada' | 'importe', string | number | null>;

interface EmbarqueCrudo {
  serie: number | string;
  folio: string;
  fecha: string;
  estatus: string | null;
  guia: string | null;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const documento = (serie: number, folio: string) => `UD40${String(serie).padStart(2, '0')}-${folio}`;

@Injectable()
export class WarehouseOrdersService {
  private readonly logger = new Logger(WarehouseOrdersService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** Sucursales que puede ver quien consulta, en el proyecto Almacén. Fuera de `tk.run`. */
  private async alcance(): Promise<WarehouseOrdersAlcance> {
    const s = await this.scope.current('almacen');
    const visibles = this.scope.intersect(s, 'warehouse', null);
    if (visibles === null) return { todas: true, sucursales: [] };
    return {
      todas: false,
      sucursales: [...visibles].sort().map((codigo) => ({ codigo, nombre: branchName(codigo) })),
    };
  }

  private aFila(r: Crudo, reloj: { fecha: string; minutos: number }, piso: Map<string, PisoKepler>): WarehouseOrderRow {
    const serie = Number(r.serie);
    const clave = `${r.sucursal}-${serie}-${r.folio}`;
    const p = piso.get(clave);
    // [GP.10.2] La etapa sale de UNA función: Kepler (estatus vigente) contra lo que registró el piso.
    const e = etapaDePedido({
      origen: 'kepler',
      kepler: r.estatus,
      ola: p ? { status: p.ola_status, stage: p.ola_stage } : null,
      checado: p?.checado === 'en_checado' || p?.checado === 'checado' ? p.checado : null,
    });
    return {
      ...r,
      serie,
      clave,
      sucursal_nombre: branchName(r.sucursal),
      documento: documento(serie, r.folio),
      importe: num(r.importe),
      renglones: Number(r.renglones) || 0,
      volumen: (r.volumen ?? []).map((v) => ({ unidad: v.unidad, cantidad: Number(v.cantidad) || 0 })),
      horas_abierto: horasAbierto(r.fecha, r.hora, r.estatus, reloj),
      etapa: e.etapa,
      etapa_fuente: e.fuente,
      desfase: e.desfase,
      order_id: null,
    };
  }

  /** `[GP.10.3]` Un pedido de preventa como fila de la consola. */
  private aFilaPreventa(r: PreventaCruda): WarehouseOrderRow {
    const e = etapaDePedido({
      origen: 'preventa',
      kepler: null,
      checado: null,
      pedido_status: r.status,
      ola: r.ola_status ? { status: r.ola_status, stage: r.ola_stage } : null,
      pick: r.iniciado ? { iniciado: true, terminado: !!r.terminado, revisado: !!r.revisado } : null,
      salio: r.ligado || r.en_guia || r.entregado,
    });
    const suc = r.sucursal ?? '';
    return {
      clave: `${suc}-PD-${r.code}`,
      sucursal: suc,
      sucursal_nombre: suc ? branchName(suc) : '',
      serie: 0,
      folio: r.code,
      documento: r.code,
      fecha: r.fecha,
      hora: null,
      origen: ORIGEN_PREVENTA,
      estatus: null,
      estatus_kepler: null,
      cliente_code: r.cliente_code,
      destino_nombre: r.cliente_nombre,
      destino_ciudad: null,
      vendedor_code: null,
      vendedor_nombre: r.vendedor_nombre,
      renglones: Number(r.renglones) || 0,
      // NO MEDIDO en GP.10.3: el volumen de un PD- por presentación (sus renglones no son kdm2).
      volumen: [],
      importe: num(r.importe),
      guia: null,
      transporte: null,
      chofer: null,
      resp_surtido: null,
      resp_checado: null,
      resp_embarque: null,
      horas_abierto: null,
      etapa: e.etapa,
      etapa_fuente: e.fuente,
      desfase: e.desfase,
      order_id: r.id,
    };
  }

  /** `[GP.10.3]` Hechos de piso de los pedidos de Kepler, por clave (`<sucursal>-<serie>-<folio>`). */
  private async pisoKepler(trx: Knex.Transaction, desde: string): Promise<Map<string, PisoKepler>> {
    const { rows } = await trx.raw(PISO_KEPLER_SQL, [desde]);
    const m = new Map<string, PisoKepler>();
    for (const r of rows as Array<PisoKepler & { sucursal: string; serie: number | string; folio: string }>) {
      m.set(`${r.sucursal}-${Number(r.serie)}-${r.folio}`, { ola_status: r.ola_status, ola_stage: r.ola_stage, checado: r.checado });
    }
    return m;
  }

  async list(q: WarehouseOrdersQuery): Promise<WarehouseOrdersResponse> {
    this.tenantCtx.requireTenantId();
    const ahora = new Date();
    const reloj = relojMx(ahora);
    let per: { from: string; to: string };
    try {
      per = periodo(q, reloj.fecha);
    } catch (e) {
      if (e instanceof PeriodoInvalido) throw new BadRequestException(e.message);
      throw e;
    }
    const filtros: Filtros = {
      estatus: (q.estatus ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
      etapa: (q.etapa ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
      origen: q.origen?.trim().toUpperCase() || null,
      sucursal: q.sucursal && SUC.test(q.sucursal) ? q.sucursal : null,
      q: q.q?.trim() || null,
      preventa: q.preventa === '1' || q.preventa === 'true',
    };
    const alcance = await this.alcance();
    // Sin sucursal asignada no hay nada que consultar: se declara en `alcance`, no se pinta vacío a secas.
    if (!alcance.todas && alcance.sucursales.length === 0) return armarRespuesta([], filtros, per, alcance, ahora);
    const codigos = alcance.sucursales.map((x) => x.codigo);
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(LIST_SQL, [per.from, per.to, alcance.todas, codigos]);
      const piso = await this.pisoKepler(trx, per.from);
      const filas = (r.rows as Crudo[]).map((x) => this.aFila(x, reloj, piso));
      if (filtros.preventa) {
        const pv = await trx.raw(PREVENTA_SQL, [per.from, per.to, alcance.todas, codigos]);
        filas.push(...(pv.rows as PreventaCruda[]).map((x) => this.aFilaPreventa(x)));
      }
      const resp = armarRespuesta(filas, filtros, per, alcance, ahora);
      this.logger.debug(`pedidos ${per.from}..${per.to}: ${filas.length} en ${Date.now() - t0} ms`);
      return resp;
    });
  }

  async detail(sucursal: string, serieTxt: string, folioTxt: string): Promise<WarehouseOrderDetail> {
    this.tenantCtx.requireTenantId();
    if (!SUC.test(sucursal) || !/^\d{1,2}$/.test(serieTxt) || !FOLIO.test(folioTxt)) {
      throw new BadRequestException('Pedido inválido: se espera sucursal de 2 dígitos, serie y folio numéricos.');
    }
    const serie = Number(serieTxt);
    const folio = folioTxt.padStart(7, '0');
    const alcance = await this.alcance();
    // Fuera de alcance responde igual que "no existe": no se confirma qué folios tiene otra sucursal.
    if (!alcance.todas && !alcance.sucursales.some((x) => x.codigo === sucursal)) {
      throw new NotFoundException('Pedido no encontrado.');
    }
    const reloj = relojMx(new Date());
    return this.tk.run(async (trx) => {
      const cab = (await trx.raw(HEADER_SQL, [sucursal, serie, folio])).rows[0] as Crudo | undefined;
      if (!cab) throw new NotFoundException('Pedido no encontrado.');
      const lin = await trx.raw(LINES_SQL, [sucursal, serie, folio]);
      const emb = await trx.raw(SHIPMENTS_SQL, [sucursal, folio]);
      const lineas: WarehouseOrderLine[] = (lin.rows as LineaCruda[]).map((l) => ({
        renglon: Number(l.renglon),
        sku: l.sku ?? '',
        descripcion: l.descripcion,
        cantidad: num(l.cantidad),
        unidad: l.unidad,
        unidad_presentacion: l.unidad_presentacion,
        cant_pedida: num(l.cant_pedida),
        cant_surtida: num(l.cant_surtida),
        cant_checada: num(l.cant_checada),
        cant_embarcada: num(l.cant_embarcada),
        ubic_surtido: l.ubic_surtido,
        ubic_checado: l.ubic_checado,
        ubic_embarque: l.ubic_embarque,
        etapa_alta: l.etapa_alta,
        importe: num(l.importe),
      }));
      const embarques: WarehouseOrderShipment[] = (emb.rows as EmbarqueCrudo[]).map((e) => ({
        documento: `UD41${String(e.serie).padStart(2, '0')}-${e.folio}`,
        fecha: e.fecha,
        estatus: e.estatus,
        guia: e.guia,
      }));
      // [GP.10.3] La etapa del detalle sale igual que la de la lista (hechos de piso desde su fecha).
      const piso = await this.pisoKepler(trx, cab.fecha);
      return { pedido: this.aFila(cab, reloj, piso), lineas, embarques };
    });
  }
}
