import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, branchName } from '@megadulces/platform-core';

import { CommercialQuotesService } from './commercial-quotes.service';
import type { QuienCotiza } from './quote-scope';
import {
  armarPasos, docPedido, hallazgosAbiertos, identidadDelPedido, llavesHallazgo,
  type EmbarqueCrudo, type FacturaCruda, type HallazgoCrudo, type PedidoCrudo, type PisoCrudo, type SeguimientoCotizacion,
} from './quote-tracking.reglas';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El pedido que la cotización escribió. La cotización guarda sucursal y folio (no la serie): se
 * prefiere el que trae el código de la cotización en «Comentarios» (`c24`, Kepler lo copia al
 * escribir el pedido), que es la prueba de identidad; si alguien editó el comentario, el de serie 1.
 * `DISTINCT ON`: el ODS puede traer el mismo documento más de una vez (ver `WarehouseOrdersService`).
 */
const PEDIDO_SQL = `
SELECT (h.c5)::int AS serie, btrim(h.c6::text) AS folio, to_char(h.c9::date, 'YYYY-MM-DD') AS fecha,
       NULLIF(btrim(h.c62::text), '') AS hora, upper(NULLIF(btrim(h.c11::text), '')) AS estatus,
       NULLIF(btrim(h.c100::text), '') AS resp_surtido, NULLIF(btrim(h.c102::text), '') AS resp_checado,
       NULLIF(btrim(h.c103::text), '') AS resp_embarque,
       NULLIF(btrim(h.c10::text), '') AS cliente, (position(? in coalesce(h.c24::text, '')) > 0) AS trae_cotizacion
  FROM kepler_ods.kdm1 h
 WHERE h.sucursal = ? AND h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 40 AND btrim(h.c6::text) = ?
   AND btrim(h.c1) = btrim(h.sucursal)
 ORDER BY (position(? in coalesce(h.c24::text, '')) > 0) DESC, ((h.c5)::int = 1) DESC, h.c9 DESC
 LIMIT 1`;

/** Embarques `U-D-41` que apuntan al pedido (`c37 = 40`, `c38` serie, `c39` folio). Responsables `c80/c81/c82`. */
const EMBARQUES_SQL = `
SELECT DISTINCT ON (e.c5, e.c6)
       (e.c5)::int AS serie, btrim(e.c6::text) AS folio, to_char(e.c9::date, 'YYYY-MM-DD') AS fecha,
       NULLIF(btrim(e.c80::text), '') AS resp_surtido, NULLIF(btrim(e.c81::text), '') AS resp_checado,
       NULLIF(btrim(e.c82::text), '') AS resp_embarque,
       round(NULLIF(btrim(e.c16::text), '')::numeric, 2)::float8 AS importe
  FROM kepler_ods.kdm1 e
 WHERE e.sucursal = ? AND e.c2 = 'U' AND e.c3 = 'D' AND (e.c4)::int = 41
   AND btrim(e.c1) = btrim(e.sucursal)
   AND btrim(e.c37::text) = '40' AND NULLIF(btrim(e.c38::text), '')::numeric = ? AND btrim(e.c39::text) = ?
 ORDER BY e.c5, e.c6, e.c9 DESC`;

/** Facturas `U-D-8` que apuntan a esos embarques; las canceladas (`c43 = 'C'`) se muestran tachadas, no se esconden. */
const facturasSql = (n: number) => `
SELECT DISTINCT ON (f.c5, f.c6)
       (f.c5)::int AS serie, btrim(f.c6::text) AS folio, to_char(f.c9::date, 'YYYY-MM-DD') AS fecha,
       NULLIF(btrim(f.c62::text), '') AS hora, (coalesce(btrim(f.c43::text), '') = 'C') AS cancelada,
       round(NULLIF(btrim(f.c16::text), '')::numeric, 2)::float8 AS importe
  FROM kepler_ods.kdm1 f
  JOIN (VALUES ${Array.from({ length: n }, () => '(?::int, ?::text)').join(', ')}) k(se, fo)
    ON NULLIF(btrim(f.c38::text), '')::numeric = k.se AND btrim(f.c39::text) = k.fo
 WHERE f.sucursal = ? AND f.c2 = 'U' AND f.c3 = 'D' AND (f.c4)::int = 8
   AND btrim(f.c1) = btrim(f.sucursal) AND btrim(f.c37::text) = '41'
 ORDER BY f.c5, f.c6, f.c9 DESC`;

/** Lo que el piso marcó en la Suite (GP): el surtido es la ola terminada, el checado su `order_checks`. */
const PISO_SQL = `
SELECT (SELECT u.nombre FROM identity.users u WHERE u.id = s.picked_by) AS surtio, s.finished_at AS surtido_at,
       (SELECT u.nombre FROM identity.users u WHERE u.id = c.assigned_to) AS checo, c.finished_at AS checado_at
  FROM (SELECT 1) uno
  LEFT JOIN LATERAL (
    SELECT pw.picked_by, pw.finished_at
      FROM commercial.wave_orders wo JOIN commercial.picking_waves pw ON pw.id = wo.wave_id
     WHERE wo.source = 'kepler' AND wo.kepler_sucursal = ? AND wo.kepler_serie = ? AND wo.kepler_folio = ?
       AND pw.finished_at IS NOT NULL
     ORDER BY pw.finished_at DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT oc.assigned_to, oc.finished_at
      FROM commercial.order_checks oc
     WHERE oc.kepler_sucursal = ? AND oc.kepler_serie = ? AND oc.kepler_folio = ? AND oc.status = 'checado'
     ORDER BY oc.finished_at DESC NULLS LAST LIMIT 1
  ) c ON true`;

/**
 * `[GP.9.1]` Seguimiento de una cotización ya mandada a Kepler: los pasos del pedido hasta la
 * factura, en sólo lectura sobre el ODS (derive-no-copy) y lo que el piso marcó en la Suite.
 * Las reglas viven en `quote-tracking.reglas.ts`.
 *
 * Quien NO puede abrir la cotización tampoco ve su seguimiento (`assertPuedeAbrir`, COT.21).
 */
@Injectable()
export class QuoteTrackingService {
  private readonly logger = new Logger(QuoteTrackingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly quotes: CommercialQuotesService,
  ) {}

  async seguimiento(id: string, quien?: QuienCotiza | null): Promise<SeguimientoCotizacion> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    await this.quotes.assertPuedeAbrir(id, quien);
    const t0 = Date.now();
    const leido_en = new Date().toISOString();

    return this.tk.run(async (k) => {
      // `to_jsonb(q)`: mismo patrón que QuoteKeplerService, por si la columna aún no existe.
      const cab = (await k.raw(
        `SELECT q.code, q.erp_customer_code, to_jsonb(q) ->> 'kepler_sucursal' AS kepler_sucursal, to_jsonb(q) ->> 'kepler_folio' AS kepler_folio
           FROM commercial.quotes q WHERE q.tenant_id = ? AND q.id = ? AND q.deleted_at IS NULL`,
        [tenantId, id],
      )).rows[0] as { code: string; erp_customer_code: string | null; kepler_sucursal: string | null; kepler_folio: string | null } | undefined;
      if (!cab) throw new NotFoundException('Cotización no encontrada');

      const vacio = { pedido: null, pasos: [], hallazgos: [], leido_en };
      if (!cab.kepler_folio || !cab.kepler_sucursal) return { en_kepler: false, pendiente_replica: false, ...vacio };
      const suc = cab.kepler_sucursal.trim();
      const folio = cab.kepler_folio.trim().padStart(7, '0');

      const p = (await k.raw(PEDIDO_SQL, [cab.code, suc, folio, cab.code])).rows[0] as PedidoCrudo | undefined;
      if (!p) return { en_kepler: true, pendiente_replica: true, ...vacio };
      const pedido: PedidoCrudo = { ...p, serie: Number(p.serie) };

      const embarques = ((await k.raw(EMBARQUES_SQL, [suc, pedido.serie, pedido.folio])).rows as EmbarqueCrudo[])
        .map((e) => ({ ...e, serie: Number(e.serie) }));
      const facturas: FacturaCruda[] = embarques.length
        ? ((await k.raw(facturasSql(embarques.length), [...embarques.flatMap((e) => [e.serie, e.folio]), suc])).rows as FacturaCruda[])
            .map((f) => ({ ...f, serie: Number(f.serie) }))
            .sort((a, b) => Number(a.cancelada) - Number(b.cancelada) || b.fecha.localeCompare(a.fecha))
        : [];
      const piso = (await k.raw(PISO_SQL, [suc, pedido.serie, pedido.folio, suc, pedido.serie, pedido.folio])).rows[0] as PisoCrudo | undefined;
      const hall = (await k.raw(
        `SELECT titulo, resumen, importe::float8 AS importe, severity, status
           FROM finance.findings WHERE tenant_id = ? AND dedup_key = ANY(?::text[])
          ORDER BY last_seen DESC`,
        [tenantId, llavesHallazgo(suc, pedido, embarques)],
      )).rows as HallazgoCrudo[];

      const r: SeguimientoCotizacion = {
        en_kepler: true,
        pendiente_replica: false,
        pedido: {
          sucursal: suc, sucursal_nombre: branchName(suc), documento: docPedido(pedido.serie, pedido.folio), estatus: pedido.estatus,
          identidad: identidadDelPedido(pedido, cab.erp_customer_code),
        },
        pasos: armarPasos(pedido, embarques, facturas, piso ?? null),
        hallazgos: hallazgosAbiertos(hall),
        leido_en,
      };
      this.logger.debug(`seguimiento ${cab.code} → ${r.pedido?.documento}: ${embarques.length} emb, ${facturas.length} fac, ${Date.now() - t0} ms`);
      return r;
    });
  }
}
