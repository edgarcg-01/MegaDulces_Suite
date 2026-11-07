/**
 * `[PGP.94]` La lectura de Kepler para el cierre de los pagos del Calendario, y su armado.
 *
 * Vive aparte del servicio para que el texto que corre en producción sea el MISMO que se mide
 * contra prod y se prueba aquí (la consulta no se copia en un script: se importa).
 *
 * Por factura del pago: su importe y cada aplicación de `kdxf` (abono → cargo) con la fecha y
 * la cuenta de tesorería del documento que la hizo, y el comprobante PDF subido para ese pago.
 *
 * ⛔ **Misma cuenta que `analytics.v_supplier_payables`**, columna por columna: aplicaciones por
 * `(sucursal, tipo, subtipo, btrim(folio))` de la factura, y fuera las de un pago CANCELADO con el
 * cruce de `[PGP.67]` (`kdm1.c43 = 'C'`, tipos 25/26/60, con el proveedor y el folio sin `btrim`
 * porque el folio colisiona). Si se separan, el renglón diría «el ERP ya no la debe» y el cierre
 * «sin pagar». Medido el 2026-11-06: 707 de 11,955 aplicaciones de `kdxf` desde septiembre son de
 * documentos cancelados.
 */
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { cierreDelPago, type AplicacionKepler, type CierreKeplerPago, type FacturaParaCierre } from '@megadulces/contracts';

/** Parámetros: `[ids de factura (uuid[]), tenant_id]`. */
export const SQL_CIERRE_KEPLER = `WITH fac AS (
  SELECT k.obligation_id, k.sucursal, k.c1, k.acreedor, k.doc_tipo, k.doc_sub, k.folio, k.importe
    FROM (SELECT ${sqlKeplerPayableId('d')} AS obligation_id, d.*
            FROM (SELECT kdxe.sucursal, kdxe.c1, kdxe.c2 AS acreedor,
                         kdxe.c4 AS doc_tipo, kdxe.c5 AS doc_sub, btrim(kdxe.c6) AS folio,
                         kdxe.c11 AS importe
                    FROM kepler_ods.kdxe
                   WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A') d) k
   WHERE k.obligation_id = ANY(?::uuid[])
)
SELECT fac.obligation_id::text AS obligation_id, fac.importe::float8 AS importe,
       x.sucursal AS psuc, x.c4::int AS p_tipo, x.c5::int AS p_sub, btrim(x.c6) AS p_folio,
       x.c10::float8 AS aplicado,
       to_char(coalesce(p.c7, x.c3), 'YYYY-MM-DD') AS fecha,
       nullif(btrim(p.c22), '') AS cuenta, b.nombre AS cuenta_nombre,
       pr.id AS comprobante_id, pr.status AS comprobante_estado
  FROM fac
  LEFT JOIN kepler_ods.kdxf x
    ON btrim(x.c1) = x.sucursal AND x.sucursal = fac.sucursal
   -- c1 y proveedor no cambian el resultado (medido 2026-11-06: 0 de 38,262 aplicaciones casan con
   -- una factura de otro c1 o proveedor, y 0 llaves de factura se repiten entre proveedores), pero
   -- son el prefijo del índice de kdxf: sin ellos se recorría la sucursal entera (4.4 ms por factura).
   AND x.c1 = fac.c1 AND x.c2 = fac.acreedor
   AND x.c7 = fac.doc_tipo AND x.c8 = fac.doc_sub AND btrim(x.c9) = fac.folio
   AND NOT EXISTS (
         SELECT 1 FROM kepler_ods.kdm1 m
          WHERE m.c3 = 'D' AND m.c4 IN ('25', '26', '60') AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal
            AND m.sucursal = x.sucursal AND m.c1 = x.c1 AND m.c10 = x.c2
            AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6)
  LEFT JOIN kepler_ods.kdxe p
    ON p.sucursal = x.sucursal AND p.c1 = x.c1 AND p.c2 = x.c2 AND p.c3 = 'D'
   AND p.c4 = x.c4 AND p.c5 = x.c5 AND p.c6 = x.c6
  LEFT JOIN LATERAL (
         SELECT btrim(kb.c2) AS nombre FROM kepler_ods.kdb1 kb
          WHERE btrim(kb.c1) = btrim(p.c22) ORDER BY (kb.sucursal <> '00'), kb.sucursal LIMIT 1) b ON p.c22 IS NOT NULL
  LEFT JOIN LATERAL (
         SELECT s.id::text AS id, s.status FROM finance.supplier_payment_proofs s
          WHERE s.tenant_id = ? AND s.sucursal = x.sucursal AND s.folio = btrim(x.c6)
            AND s.doc_prefix = 'XD' || lpad(x.c4::text, 2, '0') || lpad(x.c5::text, 2, '0')
            AND s.status <> 'rechazado'
          ORDER BY (s.status = 'validado') DESC, s.created_at DESC LIMIT 1) pr ON x.c6 IS NOT NULL`;

/** Una fila de {@link SQL_CIERRE_KEPLER}. Sin aplicaciones, las columnas del documento vienen en null. */
export interface FilaCierreKepler {
  obligation_id: string; importe: number;
  psuc: string | null; p_tipo: number | null; p_sub: number | null; p_folio: string | null;
  aplicado: number | null; fecha: string | null; cuenta: string | null; cuenta_nombre: string | null;
  comprobante_id: string | null; comprobante_estado: string | null;
}

export interface PagoParaCierre { id: string; lotDate: string; alta: string }
export interface ItemParaCierre { allocation_id: string; obligation_source: string; obligation_id: string }

/** Las facturas que se le preguntan a Kepler: sólo las que vienen de Kepler, sin repetir. */
export function idsParaCierre(items: ItemParaCierre[]): string[] {
  return [...new Set(items.filter((i) => i.obligation_source === 'kepler_payable').map((i) => i.obligation_id))];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Arma el cierre de cada pago con las filas de la consulta. Lo que todavía se debe se calcula como
 * la vista: importe − lo aplicado por documentos vigentes. Una factura que no vino en las filas
 * (no es de Kepler, o no se encontró) queda `pendiente: null` → `sin_medir`.
 */
export function armarCierres(pagos: PagoParaCierre[], items: ItemParaCierre[], filas: FilaCierreKepler[]): Map<string, CierreKeplerPago> {
  const porFactura = new Map<string, { importe: number; apps: AplicacionKepler[] }>();
  for (const r of filas) {
    const f = porFactura.get(r.obligation_id) ?? { importe: Number(r.importe), apps: [] };
    if (r.p_folio !== null && r.psuc !== null && r.p_tipo !== null && r.p_sub !== null) {
      f.apps.push({
        sucursal: r.psuc, doc_tipo: Number(r.p_tipo), doc_sub: Number(r.p_sub), folio: r.p_folio, fecha: r.fecha,
        aplicado: Number(r.aplicado ?? 0), cuenta: r.cuenta, cuenta_nombre: r.cuenta_nombre,
        comprobante_id: r.comprobante_id, comprobante_estado: r.comprobante_estado,
      });
    }
    porFactura.set(r.obligation_id, f);
  }
  const porPago = new Map<string, FacturaParaCierre[]>();
  for (const it of items) {
    const f = it.obligation_source === 'kepler_payable' ? porFactura.get(it.obligation_id) : undefined;
    const arr = porPago.get(it.allocation_id) ?? [];
    arr.push(f
      ? { pendiente: r2(f.importe - f.apps.reduce((s, a) => s + a.aplicado, 0)), aplicaciones: f.apps }
      : { pendiente: null, aplicaciones: [] });
    porPago.set(it.allocation_id, arr);
  }
  const out = new Map<string, CierreKeplerPago>();
  for (const p of pagos) {
    out.set(p.id, cierreDelPago({ lotDate: p.lotDate, programadoDesde: p.alta, facturas: porPago.get(p.id) ?? [] }));
  }
  return out;
}
