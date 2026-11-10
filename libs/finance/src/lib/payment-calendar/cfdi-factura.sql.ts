import type { Knex } from 'knex';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { VENTANA_CFDI_DIAS, cfdisDeFacturas, type CfdiDeLaFactura, type CfdiRecibido, type FacturaParaCfdi } from '@megadulces/contracts/finance/cfdi-factura';

/**
 * `[PGP.108]` **La lectura del CFDI de cada factura de los pagos de un día.** La regla vive en el
 * contrato (`cfdisDeFacturas`); aquí sólo se juntan sus fuentes, sin tablas nuevas ni importers
 * (regla 1): el documento de Kepler (`kepler_ods.kdxe`, con la MISMA llave que el cierre `[PGP.94]`),
 * el RFC del acreedor (`analytics.v_supplier_rfc`) y los CFDI recibidos (`fiscal.cfdis`, tipo I, no
 * cancelados).
 *
 * Una factura capturada (`supplier_payable`) se lee por la llave de Kepler que guarda su obligación;
 * gastos y compromisos (`budget_expense`, `financial_commitment`) no tienen documento de Kepler y
 * quedan fuera (`sin_documento`).
 */

/**
 * Paso 1 — la llave del documento de Kepler de cada renglón. Parámetros: `[tenant, item ids (uuid[])]`.
 * ⚠️ Medido en prod (2026-11-10, un día de 47 facturas): todo en UNA consulta tardaba 600–1,000 ms
 * por `v_supplier_rfc` sin filtrar (373 ms con `LIMIT 50`). En cuatro pasos: 6 + 138 + 163 + 19 ms.
 */
export const SQL_LLAVES_DE_RENGLONES = `
SELECT i.id::text AS item_id,
       (CASE WHEN i.obligation_source = 'kepler_payable' THEN i.obligation_id
             WHEN o.kepler_folio IS NOT NULL
             THEN md5('kepler_payable|' || o.kepler_sucursal || '|' || o.kepler_doc_tipo || '|' || o.kepler_doc_sub || '|' || btrim(o.kepler_folio))::uuid
        END)::text AS oid
  FROM finance.payment_allocation_items i
  LEFT JOIN commercial.supplier_payment_obligations o
    ON i.obligation_source = 'supplier_payable' AND o.id = i.obligation_id
 WHERE i.tenant_id = ? AND i.id = ANY(?::uuid[])`;

/** Paso 2 — el documento de Kepler (la MISMA forma que el cierre `[PGP.94]`). Parámetros: `[llaves (uuid[])]`. */
export const SQL_DOCUMENTOS_KEPLER = `
SELECT k.oid::text AS oid, k.sucursal, k.acreedor, k.importe::float8 AS importe, to_char(k.fecha, 'YYYY-MM-DD') AS fecha
  FROM (SELECT ${sqlKeplerPayableId('d')} AS oid, d.*
          FROM (SELECT kdxe.sucursal, btrim(kdxe.c2) AS acreedor, kdxe.c4 AS doc_tipo, kdxe.c5 AS doc_sub,
                       btrim(kdxe.c6) AS folio, kdxe.c11 AS importe, kdxe.c7 AS fecha
                  FROM kepler_ods.kdxe
                 WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A') d) k
 WHERE k.oid = ANY(?::uuid[])`;

/** Paso 3 — el RFC, sólo de los acreedores del día (filtrar por acreedor es lo que la vista aprovecha). Parámetros: `[acreedores (text[])]`. */
export const SQL_RFC_DE_ACREEDORES = `
SELECT sucursal, proveedor_code, rfc FROM analytics.v_supplier_rfc WHERE proveedor_code = ANY(?::text[])`;

/**
 * Los CFDI recibidos tipo I, no cancelados, de esos RFC y alrededor de esas fechas. El IVA y el IEPS
 * salen del propio CFDI (`impuestos`), nunca se calculan. Parámetros: `[tenant, rfcs (text[]), desde, hasta]`.
 */
export const SQL_CFDIS_CANDIDATOS = `
SELECT c.uuid::text AS uuid, upper(btrim(c.emisor_rfc)) AS emisor_rfc, c.total::float8 AS total,
       to_char(c.fecha AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS fecha,
       c.metodo_pago, c.forma_pago,
       nullif(c.impuestos ->> 'iva_trasladado', '')::float8 AS iva,
       nullif(c.impuestos ->> 'ieps_trasladado', '')::float8 AS ieps,
       c.total_retenidos::float8 AS retenido
  FROM fiscal.cfdis c
 WHERE c.tenant_id = ? AND c.rol = 'recibidas' AND c.tipo_comprobante = 'I' AND c.estatus_sat <> 'cancelado'
   AND c.emisor_rfc = ANY(?::text[])
   AND c.fecha >= ?::date AND c.fecha < (?::date + 1)`;

function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** El CFDI de cada renglón de pago (por id de renglón). Los que no son factura de Kepler no aparecen. */
export async function leerCfdiDeFacturas(trx: Knex | Knex.Transaction, tenantId: string, itemIds: readonly string[]): Promise<Map<string, CfdiDeLaFactura>> {
  if (!itemIds.length) return new Map();
  const llaves = (await trx.raw(SQL_LLAVES_DE_RENGLONES, [tenantId, [...itemIds]])).rows as { item_id: string; oid: string | null }[];
  const oids = [...new Set(llaves.map((l) => l.oid).filter((x): x is string => !!x))];
  const docs = oids.length
    ? (await trx.raw(SQL_DOCUMENTOS_KEPLER, [oids])).rows as { oid: string; sucursal: string; acreedor: string; importe: number; fecha: string | null }[]
    : [];
  const docDe = new Map(docs.map((d) => [d.oid, d]));
  const acreedores = [...new Set(docs.map((d) => d.acreedor))];
  const rfcs = acreedores.length
    ? (await trx.raw(SQL_RFC_DE_ACREEDORES, [acreedores])).rows as { sucursal: string; proveedor_code: string; rfc: string | null }[]
    : [];
  const rfcDe = new Map(rfcs.map((r) => [`${r.sucursal}|${r.proveedor_code}`, r.rfc]));
  const facturas = llaves.map<FacturaParaCfdi>((l) => {
    const d = l.oid ? docDe.get(l.oid) : undefined;
    const rfc = d ? rfcDe.get(`${d.sucursal}|${d.acreedor}`) : null;
    return { item_id: l.item_id, importe: d ? Number(d.importe) : null, fecha: d?.fecha ?? null, rfc: rfc ? rfc.trim().toUpperCase() : null };
  });
  const conRfc = facturas.filter((f) => f.rfc && f.fecha);
  let cfdis: CfdiRecibido[] = [];
  if (conRfc.length) {
    const fechas = conRfc.map((f) => f.fecha as string).sort();
    const rfcs = [...new Set(conRfc.map((f) => f.rfc as string))];
    cfdis = ((await trx.raw(SQL_CFDIS_CANDIDATOS, [tenantId, rfcs, sumarDias(fechas[0], -VENTANA_CFDI_DIAS), sumarDias(fechas[fechas.length - 1], VENTANA_CFDI_DIAS)])).rows as CfdiRecibido[])
      .map((c) => ({ ...c, total: Number(c.total) }));
  }
  return cfdisDeFacturas(facturas, cfdis);
}
