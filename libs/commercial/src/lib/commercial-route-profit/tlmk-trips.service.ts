import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  armarViajesTlmk, resumirViajesTlmk,
  type CierreGuiaTlmk, type ParadaTlmk, type ViajesTlmkResponse,
} from '@megadulces/contracts';

/**
 * `[FCT.2.1]` — Los viajes de entrega de Telemarketing con su venta (Kepler) y su costo (el cierre
 * del viaje en Logística). Reemplaza la hoja «RENTABILIDAD TLMKT 2026». Las reglas viven en
 * `tlmk-viajes.contract.ts`; aquí sólo se lee.
 *
 * ── Medido en prod (sólo lectura, 2026-11-04) ───────────────────────────────────────────────
 *  · Paradas de un mes, todas las sucursales: 24–28 ms; cuatro meses: 46–71 ms (la vista baja el
 *    filtro de fecha a `ix_kdm1_venta_fecha`).
 *  · El rango se ensancha ±MARGEN días para traer la guía COMPLETA y luego se queda con los viajes
 *    que EMPIEZAN dentro: sin eso, una guía con paradas en dos días (la 0001661 de Hidalgo, 6 y
 *    8-oct) se partía en dos viajes de dos rangos vecinos.
 *  · Los cierres se buscan sólo para las guías del rango (lista de llaves), no se cruza la vista.
 *
 * ⛔ Sólo lectura: el costo se corrige en el cierre del viaje (Logística), no aquí.
 */
const MARGEN_DIAS = 7;
const MAX_DIAS = 186;

const PARADAS = `
  SELECT p.sucursal, b.nombre AS sucursal_nombre, p.guia, to_char(p.fecha, 'YYYY-MM-DD') AS fecha,
         p.cliente_code, p.destino_ciudad, p.vendedor_code, p.vendedor_nombre, p.total::float8 AS total
    FROM analytics.v_tlmk_trip_stops p
    LEFT JOIN analytics.v_erp_branch_catalog b ON b.tenant_id = p.tenant_id AND b.suc_code = p.sucursal
   WHERE p.fecha BETWEEN (?::date - ${MARGEN_DIAS}) AND (?::date + ${MARGEN_DIAS})
     AND p.guia IS NOT NULL
     AND (?::text IS NULL OR p.sucursal = ?::text)`;

/**
 * Una fila por embarque de la Suite (`shipments`) colgado de una guía de Kepler. «Capturado» es la
 * regla de EMB para una guía buena (`pendientesDeLaGuia`: chofer, salida y llegada), contada aquí
 * como `guias_incompletas`. No `shipments.status`: Pagos de viaje completa guías sin tocarlo. No
 * `v_trip_state`: cierra las paradas contra Kepler y cuesta ~2.5 s aun filtrado (medido 2026-11-04).
 * Las guías de reparto canceladas no suman.
 * `gastos_ruta` excluye `driver_per_diem` (los viáticos van por la guía) y `total_cost` (trae el
 * costo por km de `config_finance`, la hoja congelada).
 */
const CIERRES = `
  SELECT s.kepler_sucursal AS sucursal, s.kepler_guia AS guia, s.id::text AS shipment_id,
         (s.status::text = 'cancelado') AS cancelado,
         count(g.id)::int AS guias,
         (count(g.id) FILTER (WHERE g.driver_id IS NULL OR g.departure_time IS NULL
                                 OR g.arrival_time IS NULL))::int AS guias_incompletas,
         s.actual_km::float8 AS km,
         coalesce(sum(g.driver_commission), 0)::float8 AS comision_chofer,
         coalesce(sum(g.helper1_commission + g.helper2_commission), 0)::float8 AS comision_auxiliares,
         coalesce(sum(g.per_diem_total), 0)::float8 AS viaticos,
         (SELECT sum(e.fuel + e.tolls + e.lodging + e.parking + e.permits + e.repairs
                     + e.external_helpers + e.handling + e.other)::float8
            FROM logistics.shipment_expenses e WHERE e.shipment_id = s.id) AS gastos_ruta
    FROM logistics.shipments s
    LEFT JOIN logistics.delivery_guides g
           ON g.shipment_id = s.id AND g.deleted_at IS NULL AND g.status::text <> 'cancelada'
   WHERE s.deleted_at IS NULL
     AND s.kepler_sucursal || '|' || s.kepler_guia = ANY (?::text[])
   GROUP BY s.id, s.kepler_sucursal, s.kepler_guia, s.status, s.actual_km`;

/** Desde cuándo trae el ODS embarques TM de cada sucursal: antes de eso, «no hay viajes» es falso. */
const COBERTURA = `
  SELECT p.sucursal, to_char(min(p.fecha), 'YYYY-MM-DD') AS desde
    FROM analytics.v_tlmk_trip_stops p
   WHERE p.fecha >= (?::date - 400) AND p.fecha <= ?::date
   GROUP BY 1 ORDER BY 1`;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class TlmkTripsService {
  constructor(private readonly tk: TenantKnexService) {}

  async viajes(q: { desde?: string; hasta?: string; sucursal?: string }): Promise<ViajesTlmkResponse> {
    const { desde, hasta } = rango(q.desde, q.hasta);
    const sucursal = q.sucursal?.trim() ? q.sucursal.trim() : null;
    if (sucursal && !/^\d{2}$/.test(sucursal)) throw new BadRequestException('sucursal: dos dígitos');

    return this.tk.run(async (trx) => {
      const { rows: paradasRaw } = await trx.raw(PARADAS, [desde, hasta, sucursal, sucursal]);
      const paradas = paradasRaw as ParadaTlmk[];
      const llaves = [...new Set(paradas.map((p) => `${p.sucursal}|${p.guia}`))];
      const { rows: cierres } = llaves.length
        ? await trx.raw(CIERRES, [llaves])
        : { rows: [] as CierreGuiaTlmk[] };
      const viajes = armarViajesTlmk(paradas, cierres as CierreGuiaTlmk[])
        .filter((v) => v.fecha >= desde && v.fecha <= hasta);

      const { rows: cobertura } = await trx.raw(COBERTURA, [hasta, hasta]);
      const sucursales = new Map<string, string | null>();
      for (const p of paradas) sucursales.set(p.sucursal, p.sucursal_nombre);

      return {
        desde, hasta, sucursal,
        sucursales: [...sucursales].map(([code, nombre]) => ({ code, nombre })).sort((a, b) => a.code.localeCompare(b.code)),
        resumen: resumirViajesTlmk(viajes),
        viajes,
        cobertura: cobertura as { sucursal: string; desde: string | null }[],
      };
    });
  }
}

/** Sin rango: el mes en curso. Tope de ~6 meses: más que eso es otra pregunta (y otro costo). */
function rango(desde?: string, hasta?: string): { desde: string; hasta: string } {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const h = hasta && FECHA.test(hasta) ? hasta : hoy;
  const d = desde && FECHA.test(desde) ? desde : `${h.slice(0, 8)}01`;
  if ((desde && !FECHA.test(desde)) || (hasta && !FECHA.test(hasta))) {
    throw new BadRequestException('desde/hasta: YYYY-MM-DD');
  }
  if (d > h) throw new BadRequestException('desde es posterior a hasta');
  const dias = (Date.parse(h) - Date.parse(d)) / 86_400_000;
  if (dias > MAX_DIAS) throw new BadRequestException(`El rango máximo es de ${MAX_DIAS} días`);
  return { desde: d, hasta: h };
}

export const TLMK_SQL = { PARADAS, CIERRES, COBERTURA };
