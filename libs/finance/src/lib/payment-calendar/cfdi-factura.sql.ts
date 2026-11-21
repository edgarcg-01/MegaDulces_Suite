import type { Knex } from 'knex';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { VENTANA_CFDI_DIAS, cfdisDeFacturas, type CfdiDeLaFactura, type CfdiDelRenglon, type CfdiRecibido, type FacturaPagadaCancelada, type FacturaParaCfdi } from '@megadulces/contracts/finance/cfdi-factura';

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
SELECT sucursal, proveedor_code, proveedor_nombre, rfc FROM analytics.v_supplier_rfc WHERE proveedor_code = ANY(?::text[])`;

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

/**
 * `[PGP.158]` Pasos 1–3: lo que se sabe de cada factura por su documento de Kepler (importe, fecha,
 * RFC). Salió de `leerCfdiDeFacturas` para que el aviso de cancelados use las MISMAS facturas.
 */
/** `[PGP.178]` La factura con su acreedor de Kepler: de ahí salen las demás facturas del mismo proveedor. */
type FacturaLeida = FacturaParaCfdi & { sucursal: string | null; acreedor: string | null };

async function leerFacturasParaCfdi(trx: Knex | Knex.Transaction, tenantId: string, itemIds: readonly string[]): Promise<FacturaLeida[]> {
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
  const facturas = llaves.map<FacturaLeida>((l) => {
    const d = l.oid ? docDe.get(l.oid) : undefined;
    const rfc = d ? rfcDe.get(`${d.sucursal}|${d.acreedor}`) : null;
    return { item_id: l.item_id, importe: d ? Number(d.importe) : null, fecha: d?.fecha ?? null, rfc: rfc ? rfc.trim().toUpperCase() : null, sucursal: d?.sucursal ?? null, acreedor: d?.acreedor ?? null };
  });
  return facturas;
}

/** Paso 4: los CFDI (vigentes o, `[PGP.163]`, cancelados) de esas facturas, en su ventana de fechas. */
async function leerCandidatos(trx: Knex | Knex.Transaction, tenantId: string, facturas: readonly FacturaParaCfdi[], sql: string): Promise<CfdiRecibido[]> {
  const conRfc = facturas.filter((f) => f.rfc && f.fecha);
  if (!conRfc.length) return [];
  const fechas = conRfc.map((f) => f.fecha as string).sort();
  const rfcs = [...new Set(conRfc.map((f) => f.rfc as string))];
  return ((await trx.raw(sql, [tenantId, rfcs, sumarDias(fechas[0], -VENTANA_CFDI_DIAS), sumarDias(fechas[fechas.length - 1], VENTANA_CFDI_DIAS)])).rows as CfdiRecibido[])
    .map((c) => ({ ...c, total: Number(c.total) }));
}

/** El CFDI de cada renglón de pago (por id de renglón). Los que no son factura de Kepler no aparecen. */
export async function leerCfdiDeFacturas(trx: Knex | Knex.Transaction, tenantId: string, itemIds: readonly string[]): Promise<Map<string, CfdiDeLaFactura>> {
  if (!itemIds.length) return new Map();
  const facturas = await leerFacturasParaCfdi(trx, tenantId, itemIds);
  return cfdisDeFacturas(facturas, await leerCandidatos(trx, tenantId, facturas, SQL_CFDIS_CANDIDATOS));
}

/**
 * `[PGP.163]` Los MISMOS candidatos, pero cancelados: la factura que el proveedor canceló en el SAT
 * (medido 2026-11-19: 65 de 2026 ligadas a una factura ya pagada; 6 sin sustituta).
 */
export const SQL_CFDIS_CANCELADOS = SQL_CFDIS_CANDIDATOS.replace("c.estatus_sat <> 'cancelado'", "c.estatus_sat = 'cancelado'");

/**
 * `[PGP.158][PGP.163]` El CFDI de cada renglón y, cuando no hay uno vigente (`ninguno`), el cancelado
 * que casa con la factura por la MISMA regla (RFC + total ±$1 + fecha ±45 días, uno solo).
 */
export async function leerCfdiConCancelados(trx: Knex | Knex.Transaction, tenantId: string, itemIds: readonly string[]): Promise<Map<string, CfdiDelRenglon>> {
  if (!itemIds.length) return new Map();
  const facturas = await leerFacturasParaCfdi(trx, tenantId, itemIds);
  const vigentes = cfdisDeFacturas(facturas, await leerCandidatos(trx, tenantId, facturas, SQL_CFDIS_CANDIDATOS));
  const sinVigente = facturas.filter((f) => vigentes.get(f.item_id)?.estado === 'ninguno');
  const cancelados = sinVigente.length
    ? cfdisDeFacturas(sinVigente, await leerCandidatos(trx, tenantId, sinVigente, SQL_CFDIS_CANCELADOS))
    : new Map<string, CfdiDeLaFactura>();
  const rfcs = [...new Set(facturas.map((f) => f.rfc).filter((x): x is string => !!x))];
  const efos = rfcs.length
    ? (await trx.raw(SQL_PROVEEDORES_69B, [rfcs])).rows as { rfc: string; situacion: 'Presunto' | 'Definitivo'; publicado: string | null }[]
    : [];
  const efosDe = new Map(efos.map((e) => [e.rfc, { situacion: e.situacion, publicado: e.publicado }]));
  const pagadasDe = await leerPagadasCanceladas(trx, tenantId, facturas);
  const rfcDe = new Map(facturas.map((f) => [f.item_id, f.rfc]));
  const out = new Map<string, CfdiDelRenglon>();
  for (const [id, cfdi] of vigentes) {
    const c = cancelados.get(id);
    const rfc = rfcDe.get(id);
    const renglon: CfdiDelRenglon = { cfdi, cancelado_uuid: c?.estado === 'unico' && c.cfdi ? c.cfdi.uuid : null, efos: (rfc && efosDe.get(rfc)) || null };
    // Sin RFC no se puede saber: se deja ausente (NO MEDIDO), nunca `[]`.
    if (rfc) renglon.pagadas_canceladas = pagadasDe.get(rfc) ?? [];
    out.set(id, renglon);
  }
  return out;
}

/**
 * `[PGP.178]` **Las facturas que ya se le pagaron al proveedor y que él canceló en el SAT sin sustituta.**
 * Parte de los acreedores del día (sucursal + clave de Kepler + RFC), no de todo el padrón: así la cuenta es de
 * decenas de documentos y no de todo `kdxe` × `kdxf` (la consulta abierta tardaba minutos).
 *
 * - El CFDI cancelado (último año) se liga a SU factura de Kepler con la regla de `[PGP.108]`: mismo acreedor,
 *   total ±$1 y fecha del CFDI entre 45 días antes y 5 después de la de Kepler.
 * - «Pagada» = tiene pagos en `kdxf` (transferencia 26, cheque 25 o 60), los mismos que lee el cierre.
 * - «Sin sustituta» = ningún CFDI vigente del mismo RFC, emitido después y en 120 días, por el total cancelado o
 *   por lo pagado (±$1). El SAT no nos da el folio de la sustituta (`cancel_sustitucion_uuid` vacío en 223 de 223).
 *
 * Parámetros: `[sucursales, acreedores, rfcs (los tres alineados), tenant, rfcs distintos, tenant]`.
 */
export const SQL_PAGADAS_CANCELADAS = `
WITH par AS (
  SELECT DISTINCT p.sucursal, p.acreedor, p.rfc FROM unnest(?::text[], ?::text[], ?::text[]) AS p(sucursal, acreedor, rfc)
), canc AS MATERIALIZED (
  SELECT c.uuid::text AS uuid, upper(btrim(c.emisor_rfc)) AS rfc, nullif(coalesce(c.serie, '') || coalesce(c.folio, ''), '') AS folio,
         c.total::float8 AS total, (c.fecha AT TIME ZONE 'America/Mexico_City')::date AS f
    FROM fiscal.cfdis c
   WHERE c.tenant_id = ? AND c.rol = 'recibidas' AND c.tipo_comprobante = 'I' AND c.estatus_sat = 'cancelado'
     AND c.emisor_rfc = ANY(?::text[]) AND c.fecha >= now() - interval '365 days'
), fact AS MATERIALIZED (
  SELECT e.sucursal, btrim(e.c2) AS acreedor, e.c4 AS t, e.c5 AS s, btrim(e.c6) AS doc, e.c7::date AS f_kep, e.c11::float8 AS importe
    FROM kepler_ods.kdxe e
    JOIN (SELECT DISTINCT sucursal, acreedor FROM par) p ON p.sucursal = e.sucursal AND p.acreedor = btrim(e.c2)
   WHERE btrim(e.c1) = e.sucursal AND e.c3 = 'A' AND e.c11 > 0
), liga AS (
  SELECT DISTINCT ON (c.uuid) c.uuid, c.rfc, c.folio, c.total, c.f, f.sucursal, f.acreedor, f.t, f.s, f.doc
    FROM canc c
    JOIN par p ON p.rfc = c.rfc
    JOIN fact f ON f.sucursal = p.sucursal AND f.acreedor = p.acreedor AND abs(f.importe - c.total) <= 1
               AND c.f >= f.f_kep - 45 AND c.f < f.f_kep + 6
   ORDER BY c.uuid, abs(c.f - f.f_kep)
), pagada AS (
  SELECT l.uuid, l.rfc, l.folio, l.total, l.f, sum(k.c10)::float8 AS pagado, max(k.c3::date) AS f_pago
    FROM liga l
    JOIN kepler_ods.kdxf k ON k.sucursal = l.sucursal AND btrim(k.c1) = k.sucursal AND btrim(k.c2) = l.acreedor
                          AND k.c7 = l.t AND k.c8 = l.s AND btrim(k.c9) = l.doc AND k.c4 IN (25, 26, 60)
   GROUP BY l.uuid, l.rfc, l.folio, l.total, l.f
)
SELECT g.uuid, g.rfc, g.folio, g.total, g.pagado, to_char(g.f_pago, 'YYYY-MM-DD') AS fecha_pago
  FROM pagada g
 WHERE NOT EXISTS (
   SELECT 1 FROM fiscal.cfdis v
    WHERE v.tenant_id = ? AND v.rol = 'recibidas' AND v.tipo_comprobante = 'I' AND v.estatus_sat <> 'cancelado'
      AND v.emisor_rfc = g.rfc
      AND (v.fecha AT TIME ZONE 'America/Mexico_City')::date > g.f AND (v.fecha AT TIME ZONE 'America/Mexico_City')::date < g.f + 120
      AND (abs(v.total - g.total) <= 1 OR abs(v.total - g.pagado) <= 1))`;

/** `[PGP.178]` Por RFC, las pagadas que el proveedor canceló sin sustituta (de los acreedores de estas facturas). */
async function leerPagadasCanceladas(trx: Knex | Knex.Transaction, tenantId: string, facturas: readonly FacturaLeida[]): Promise<Map<string, FacturaPagadaCancelada[]>> {
  const pares = facturas.filter((f): f is FacturaLeida & { rfc: string; sucursal: string; acreedor: string } => !!(f.rfc && f.sucursal && f.acreedor));
  const out = new Map<string, FacturaPagadaCancelada[]>();
  if (!pares.length) return out;
  const rfcs = [...new Set(pares.map((p) => p.rfc))];
  const filas = (await trx.raw(SQL_PAGADAS_CANCELADAS, [pares.map((p) => p.sucursal), pares.map((p) => p.acreedor), pares.map((p) => p.rfc), tenantId, rfcs, tenantId])).rows as
    { uuid: string; rfc: string; folio: string | null; total: number; pagado: number; fecha_pago: string | null }[];
  for (const f of filas) {
    const lista = out.get(f.rfc) ?? [];
    lista.push({ uuid: f.uuid, folio: f.folio, total: Number(f.total), pagado: Number(f.pagado), fecha_pago: f.fecha_pago });
    out.set(f.rfc, lista);
  }
  return out;
}

/**
 * `[PGP.177]` Los acreedores del día que el SAT tiene en la lista 69-B (presunto o definitivo).
 * `fiscal.sat_list_rfcs` es global y su llave es `(lista, rfc)`. Parámetros: `[rfcs (text[])]`.
 */
export const SQL_PROVEEDORES_69B = `
SELECT r.rfc, r.situacion, to_char(r.fecha_publicacion, 'YYYY-MM-DD') AS publicado
  FROM fiscal.sat_list_rfcs r
 WHERE r.lista = '69B' AND r.situacion IN ('Presunto', 'Definitivo') AND r.rfc = ANY(?::text[])`;
