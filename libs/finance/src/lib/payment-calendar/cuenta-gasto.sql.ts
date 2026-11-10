import type { Knex } from 'knex';
import type { CuentaGastoDelPago } from '@megadulces/contracts/finance/momento-poliza';
import { cuentaGastoMasUsada } from '../contpaqi/gasto-con-factura';

/**
 * `[PGP.111b]` **La cuenta de gasto (52) de cada proveedor de gasto del día** — P3 (Edgar, 2026-11-10): la define
 * Contabilidad; lo que ya definió con sus pólizas se REUSA, no se vuelve a preguntar.
 *
 * Misma regla y misma fuente que la póliza de gasto de ContPAQi (`cuentaGastoMasUsada`, `[CP.8.87]`: la cuenta 52 que
 * la contadora usó más con ese RFC; 93 %, placebo 9 %), en dos pasos como `FuentePagoProveedor` (unir por UUID contra
 * `fiscal.cfdis` agotaba el tiempo): los CFDI del RFC de los últimos 400 días, y sus renglones de cargo 52 en
 * `analytics.gl_poliza_lines` (índice por `upper(cfdi_uuid)`).
 *
 * Medido en prod (sólo lectura, 2026-11-10) sobre los 21 RFC de gasto del Calendario: 19 con cuenta en este staging y 19
 * en la réplica (`analytics.v_contpaqi_cfdi_poliza`); en los 18 que tienen los dos, **la misma cuenta en los 18**
 * (dos implementaciones de acuerdo). El staging tarda 74 ms; la réplica, 1.5 s.
 */
export async function leerCuentasGasto(trx: Knex | Knex.Transaction, tenantId: string, rfcs: readonly string[]): Promise<Map<string, CuentaGastoDelPago>> {
  const lista = [...new Set(rfcs.map((r) => r.trim().toUpperCase()).filter(Boolean))];
  const out = new Map<string, CuentaGastoDelPago>();
  if (!lista.length) return out;
  const uuids = (await trx.raw(`
    SELECT upper(uuid) AS u, upper(btrim(emisor_rfc)) AS rfc FROM fiscal.cfdis
     WHERE tenant_id = ? AND rol = 'recibidas' AND tipo_comprobante = 'I' AND emisor_rfc = ANY(?::text[]) AND fecha >= current_date - 400`,
  [tenantId, lista])).rows as { u: string; rfc: string }[];
  const rfcDe = new Map(uuids.map((x) => [x.u, x.rfc]));
  const usos = rfcDe.size ? (await trx.raw(`
    SELECT upper(l.cfdi_uuid) AS u, l.cuenta, coalesce(l.anio_mes, '') AS f
      FROM analytics.gl_poliza_lines l
     WHERE l.tenant_id = ? AND l.source = 'contpaqi' AND l.tipo_pol = '2' AND l.cargo_abono = 'C'
       AND l.cfdi_uuid IS NOT NULL AND l.cuenta ~ '^52' AND upper(l.cfdi_uuid) = ANY(?::text[])`,
  [tenantId, [...rfcDe.keys()]])).rows as { u: string; cuenta: string; f: string }[] : [];
  const porRfc = new Map<string, { cuenta: string; f: string }[]>();
  for (const x of usos) {
    const rfc = rfcDe.get(x.u);
    if (rfc) porRfc.set(rfc, [...(porRfc.get(rfc) ?? []), { cuenta: x.cuenta, f: x.f }]);
  }
  const elegidas = new Map(lista.map((rfc) => [rfc, cuentaGastoMasUsada(porRfc.get(rfc) ?? [])]));
  // `[PGP.111c]` Lo que firmó Contabilidad le gana a lo derivado. Sin la tabla (antes de su migración) no hay firmas.
  const hayFirmas = Boolean((await trx.raw(`SELECT to_regclass('contpaqi.supplier_expense_accounts') IS NOT NULL AS ok`)).rows[0]?.ok);
  const firmas = hayFirmas
    ? new Map(((await trx.raw(`SELECT rfc, cuenta, cuenta_nombre, firmada_por FROM contpaqi.supplier_expense_accounts
        WHERE tenant_id = ? AND active AND rfc = ANY(?::text[])`, [tenantId, lista])).rows as { rfc: string; cuenta: string; cuenta_nombre: string | null; firmada_por: string }[])
      .map((r) => [r.rfc, r]))
    : new Map<string, { rfc: string; cuenta: string; cuenta_nombre: string | null; firmada_por: string }>();
  const codigos = [...new Set([...elegidas.values()].filter(Boolean).map((e) => e!.cuenta))];
  const nombres = codigos.length
    ? new Map(((await trx.raw(`SELECT codigo, nombre FROM analytics.contpaqi_accounts WHERE tenant_id = ? AND codigo = ANY(?::text[])`,
      [tenantId, codigos])).rows as { codigo: string; nombre: string }[]).map((r) => [r.codigo, r.nombre]))
    : new Map<string, string>();
  for (const rfc of lista) {
    const f = firmas.get(rfc);
    const e = elegidas.get(rfc);
    if (f) {
      out.set(rfc, { estado: 'firmada', cuenta: f.cuenta, nombre: f.cuenta_nombre, firmada_por: f.firmada_por, veces: e?.veces ?? 0, total: e?.total ?? 0, rfc });
      continue;
    }
    out.set(rfc, e
      ? { estado: 'derivada', cuenta: e.cuenta, nombre: nombres.get(e.cuenta) ?? null, veces: e.veces, total: e.total, rfc }
      : { estado: 'sin_historia', cuenta: null, nombre: null, veces: 0, total: 0, rfc });
  }
  return out;
}
