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
import { armarRespuesta, horasAbierto, periodo, PeriodoInvalido, relojMx, type Filtros } from './warehouse-orders.engine';

/**
 * `[GP.1]` Tablero de pedidos del almacén — lectura pura sobre el ODS, sin importer
 * (derive-no-copy, mismo patrón que Cortes/Sucursales). La Suite NO escribe en Kepler (ADR-086).
 *
 *  · Pedido   = `kepler_ods.kdm1` `U-D-40`. Origen `c27`, estatus `c11`, responsables
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
         upper(NULLIF(btrim(h.c11::text), ''))               AS estatus,
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
SELECT h.sucursal, h.serie, h.folio, h.fecha, h.hora, h.origen, h.estatus, h.cliente_code,
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
  origen?: string;
  sucursal?: string;
  q?: string;
}

type Crudo = Omit<WarehouseOrderRow, 'clave' | 'sucursal_nombre' | 'documento' | 'importe' | 'horas_abierto' | 'serie' | 'volumen'> & {
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

  private aFila(r: Crudo, reloj: { fecha: string; minutos: number }): WarehouseOrderRow {
    const serie = Number(r.serie);
    return {
      ...r,
      serie,
      clave: `${r.sucursal}-${serie}-${r.folio}`,
      sucursal_nombre: branchName(r.sucursal),
      documento: documento(serie, r.folio),
      importe: num(r.importe),
      renglones: Number(r.renglones) || 0,
      volumen: (r.volumen ?? []).map((v) => ({ unidad: v.unidad, cantidad: Number(v.cantidad) || 0 })),
      horas_abierto: horasAbierto(r.fecha, r.hora, r.estatus, reloj),
    };
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
      origen: q.origen?.trim().toUpperCase() || null,
      sucursal: q.sucursal && SUC.test(q.sucursal) ? q.sucursal : null,
      q: q.q?.trim() || null,
    };
    const alcance = await this.alcance();
    // Sin sucursal asignada no hay nada que consultar: se declara en `alcance`, no se pinta vacío a secas.
    if (!alcance.todas && alcance.sucursales.length === 0) return armarRespuesta([], filtros, per, alcance, ahora);
    const codigos = alcance.sucursales.map((x) => x.codigo);
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(LIST_SQL, [per.from, per.to, alcance.todas, codigos]);
      const filas = (r.rows as Crudo[]).map((x) => this.aFila(x, reloj));
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
      return { pedido: this.aFila(cab, reloj), lineas, embarques };
    });
  }
}
