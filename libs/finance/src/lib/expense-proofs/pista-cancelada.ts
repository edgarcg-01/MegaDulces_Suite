import type { Knex } from 'knex';
import type { PistaCancelada } from '@megadulces/contracts';
import { leerTransferenciasDelGasto, llaveGasto } from './transferencias-del-gasto';

/**
 * `[PGP.123]` G.UI.1d — **La pista de cada cancelada, en lote** (anexo G §14.8): lo que la Suite averigua sola para que
 * una persona sólo decida (pedido de Francisco, 2026-11-16).
 *
 *   · **El dinero:** los pagos (`X-D-26`, `kdm5`) aplicados a los gastos de su solicitud, aunque estén cancelados (Kepler
 *     conserva la aplicación). Es la MISMA lectura que el Expediente (`leerTransferenciasDelGasto`, GX.75).
 *   · **La recaptura:** solicitudes vivas de la misma sucursal y acreedor, con el mismo total al centavo y fecha cercana,
 *     y si ya tienen su propio vale.
 *
 * Medido en prod el 2026-11-16 sobre las 43 canceladas: de las 29 con gasto, 14 se pagaron en efectivo según el vale y sólo
 * 1 tiene un pago aplicado en Kepler (ningún `X-D-25`); de las 14 sin gasto, 2 tienen una recaptura clara, 1 varias iguales
 * y 11 ninguna. ⚠️ El criterio de recaptura (mismo acreedor y total, de 15 días antes a 45 después) es una pista, no una
 * prueba: la decisión es de una persona.
 */
export interface CanceladaParaPista {
  id: string;
  sucursal: string | null;
  folio_solicitud: string | null;
  forma_pago: string | null;
  importe_capturado: number | string | null;
  /** `c10` de la solicitud cancelada (Kepler la conserva al cancelar). */
  kepler_acreedor: string | null;
  /** `c9` de la solicitud cancelada, `YYYY-MM-DD`. */
  kepler_fecha: string | null;
}

/** Los gastos (`X-A-10`) que nacieron de cada solicitud, en cualquier estado (con su estado). Por `c39`: usa `idx_kdm1_xa_chain`. */
export const SQL_GASTOS_DE_LAS_SOLICITUDES = `
SELECT g.sucursal, btrim(g.c39) AS solicitud, lpad(btrim(g.c6), 7, '0') AS gasto, btrim(g.c43) AS estado
  FROM unnest(?::text[], ?::text[]) AS p(suc, fol)
  JOIN kepler_ods.kdm1 g ON g.sucursal = p.suc AND g.c2 = 'X' AND g.c3 = 'A' AND btrim(g.c4::text) = '10' AND g.c4 = 10
   AND g.c5 = 1 AND btrim(g.c39) = p.fol`;

/** Las solicitudes que pueden ser su recaptura, y si ya tienen un vale vivo en la Suite. */
export const SQL_RECAPTURAS = `
SELECT p.suc, p.fol, btrim(s.c6) AS folio, btrim(s.c43) AS estado, to_char(s.c9, 'YYYY-MM-DD') AS fecha,
       EXISTS (SELECT 1 FROM finance.expense_proofs e
                WHERE e.tenant_id = ? AND e.sucursal = p.suc AND btrim(e.folio_solicitud) = btrim(s.c6)
                  AND e.status <> 'rechazada') AS con_vale
  FROM unnest(?::text[], ?::text[], ?::text[], ?::numeric[], ?::date[]) AS p(suc, fol, acreedor, capturado, fecha)
  JOIN kepler_ods.kdm1 s ON s.sucursal = p.suc AND s.c2 = 'X' AND s.c3 = 'A' AND btrim(s.c4::text) = '15' AND s.c4 = 15
   AND s.c5 = 1 AND btrim(s.c10) = p.acreedor AND btrim(s.c6) <> p.fol AND btrim(s.c43) IN ('A', 'F', 'N')
   AND round(s.c16::numeric, 2) = round(p.capturado, 2)
   AND s.c9::date BETWEEN p.fecha - 15 AND p.fecha + 45
 ORDER BY s.c9, btrim(s.c6)`;

const limpio = (v: unknown): string => String(v ?? '').trim();

/**
 * La pista de cada cancelada, por id del vale. Sin la tabla de pagos, `pagos: null` (no se midió); sin el acreedor, la
 * fecha o lo capturado, `recapturas: null`. Nunca un `[]` que diga «no hay» cuando no se pudo medir.
 */
export async function pistasDeCanceladas(
  trx: Knex | Knex.Transaction, tenantId: string, vales: readonly CanceladaParaPista[],
): Promise<Map<string, PistaCancelada>> {
  const out = new Map<string, PistaCancelada>();
  const con = vales.filter((v) => limpio(v.sucursal) && limpio(v.folio_solicitud));
  if (!con.length) return out;

  const gastos = ((await trx.raw(SQL_GASTOS_DE_LAS_SOLICITUDES, [con.map((v) => limpio(v.sucursal)), con.map((v) => limpio(v.folio_solicitud))])) as {
    rows: { sucursal: string; solicitud: string; gasto: string; estado: string }[];
  }).rows;
  const transf = await leerTransferenciasDelGasto(trx, gastos.map((g) => ({ sucursal: g.sucursal, gasto_folio: g.gasto })));

  const medibles = con.filter((v) => limpio(v.kepler_acreedor) && /^\d{4}-\d{2}-\d{2}$/.test(limpio(v.kepler_fecha))
    && v.importe_capturado != null && Number.isFinite(Number(v.importe_capturado)));
  const recs = medibles.length ? ((await trx.raw(SQL_RECAPTURAS, [
    tenantId,
    medibles.map((v) => limpio(v.sucursal)), medibles.map((v) => limpio(v.folio_solicitud)), medibles.map((v) => limpio(v.kepler_acreedor)),
    medibles.map((v) => Number(v.importe_capturado)), medibles.map((v) => limpio(v.kepler_fecha)),
  ])) as { rows: { suc: string; fol: string; folio: string; estado: string; fecha: string | null; con_vale: boolean }[] }).rows : [];

  for (const v of con) {
    const suc = limpio(v.sucursal), fol = limpio(v.folio_solicitud);
    const susGastos = gastos.filter((g) => g.sucursal === suc && g.solicitud === fol).map((g) => g.gasto);
    const pagos = transf === null ? null : susGastos.flatMap((g) => (transf.get(llaveGasto(suc, g)) ?? []).map((t) => ({
      folio: t.folio, gasto_folio: t.gasto_folio, aplicado: Number(t.aplicado) || 0, fecha: t.fecha, cancelado: t.cancelada === true,
    })));
    const recapturas = medibles.includes(v)
      ? recs.filter((r) => r.suc === suc && r.fol === fol).map((r) => ({ folio: r.folio, estado: r.estado, fecha: r.fecha, con_vale: r.con_vale === true }))
      : null;
    // El gasto que SIGUE vivo sobre la cancelada: con uno, ligar el vale a otra solicitud duplicaría el gasto.
    const vivo = gastos.find((g) => g.sucursal === suc && g.solicitud === fol && g.estado !== 'C')?.gasto ?? null;
    out.set(v.id, { forma_pago: limpio(v.forma_pago) || null, pagos, recapturas, gasto_vivo: vivo });
  }
  return out;
}
