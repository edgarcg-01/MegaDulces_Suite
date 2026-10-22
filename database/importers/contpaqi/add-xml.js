/**
 * `[LC.20]` — El XML de cada CFDI, del ADD de ContPAQi a `fiscal.cfdis.xml`.
 *
 * Pedido de Edgar (2026-10-22): *«hay que guardarlas»* — poder abrir la factura desde el libro de
 * compras. Medido ese día: de 965 recibidos de octubre, **0 con XML y 0 con PDF** en `fiscal.cfdis`;
 * el feed sólo copiaba el encabezado. El XML vive en el ADD, en la base `document_<guid>_content`
 * (`DocumentContent.Content`, nvarchar, una fila por documento: 627,239, las mismas que
 * `Comprobante`), ligado por `GuidDocument` = nuestro `stored_ref`. ⛔ El PDF NO está en el ADD:
 * `other_<guid>_content` sólo trae resultados de validación (500,916) y 743 «OTHER» sin contenido.
 *
 * Se llena la columna que YA existe (`xml`, la que leen `/fiscal/cfdi/:id/xml` y el ZIP del
 * auditor), sin tabla nueva. Y sólo donde falta: la resincronización diaria del feed reescribe el
 * encabezado de 169k filas, y volver a traer el XML cada vez serían ~1.4 GB al día para nada.
 *
 * Cada XML se valida antes de guardarse: el UUID de su `TimbreFiscalDigital` tiene que ser el de la
 * fila. Uno que no casa no se guarda y se cuenta — un documento ajeno pegado a una factura es peor
 * que no tener documento.
 */

/** El UUID del timbre (`<tfd:TimbreFiscalDigital ... UUID="...">`), o null. */
function uuidDelXml(xml) {
  const m = String(xml || '').match(/<(?:\w+:)?TimbreFiscalDigital\b[^>]*\bUUID="([0-9A-Fa-f-]{36})"/);
  return m ? m[1].toUpperCase() : null;
}

const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Trae del ADD el XML de los documentos pedidos. `refs` = GuidDocument (nuestro `stored_ref`).
 * Los GUID se validan como GUID antes de ir al SQL (son nuestros, pero una validación que se da por
 * obvia es la que no está).
 * @returns {Promise<Map<string, string>>} GuidDocument (mayúsculas) → XML
 */
async function traerXml(poolContent, refs) {
  const validos = [...new Set(refs.map((r) => String(r || '').toUpperCase()).filter((r) => GUID.test(r)))];
  const out = new Map();
  for (let i = 0; i < validos.length; i += 200) {
    const lote = validos.slice(i, i + 200);
    const rs = (await poolContent.request().query(
      `SELECT CAST(GuidDocument AS varchar(36)) AS g, Content FROM DocumentContent
        WHERE DocumentType = 'CFDI' AND GuidDocument IN (${lote.map((g) => `'${g}'`).join(',')})`)).recordset;
    for (const r of rs) if (r.Content) out.set(String(r.g).toUpperCase(), r.Content);
  }
  return out;
}

/** Lo reciente se pide en CADA pasada: es lo que se está contabilizando y lo que acaba de llegar. */
const DIAS_RECIENTES = 45;

/**
 * Completa `fiscal.cfdis.xml` de las filas que no lo tienen, en dos tramos:
 *   1. **lo reciente** (últimos 45 días), en cada pasada;
 *   2. **el histórico**, con un CURSOR que sólo baja (`analytics.feed_watermarks`, llave
 *      `<feedKey>_xml`): cada pasada sigue donde quedó la anterior.
 *
 * ⛔ Por qué el cursor y no «las N más nuevas sin XML»: medido el 2026-10-22, el ADD ARCHIVÓ a disco
 * el XML de 2017 a mediados de 2022 (`SubDirectory = 'Z'`, la fila existe y `Content` está vacío:
 * 0 de 1,160 en 2017 … 18,862 de 56,623 en 2022; 100 % desde 2023). Con «las N más nuevas», al
 * terminar lo reciente cada pasada volvería a pedir para siempre las mismas mil sin contenido.
 * Con el cursor, cada una se pide UNA vez y se cuenta como `sin_contenido`.
 *
 * @returns {Promise<{pedidas: number, guardadas: number, sin_contenido: number, uuid_distinto: number, cursor: string|null}>}
 */
async function completarXml(pg, poolContent, { tenant, rol, tipos, limite = 1000, apply = true, feedKey = null }) {
  const llave = feedKey ? `${feedKey}_xml` : null;
  const recientes = (await pg.query(
    `SELECT uuid, stored_ref, fecha FROM fiscal.cfdis
      WHERE tenant_id = $1 AND source = 'contpaqi_add' AND rol = $2 AND xml IS NULL
        AND stored_ref IS NOT NULL AND tipo_comprobante = ANY ($3)
        AND fecha >= now() - make_interval(days => $5)
      ORDER BY fecha DESC LIMIT $4`, [tenant, rol, tipos, limite, DIAS_RECIENTES])).rows;
  let cursor = null;
  if (llave) {
    const w = await pg.query(`SELECT watermark_ts FROM analytics.feed_watermarks WHERE tenant_id = $1 AND feed_key = $2`, [tenant, llave]);
    cursor = w.rows[0]?.watermark_ts ?? null;
  }
  const resto = Math.max(0, limite - recientes.length);
  // `<=` y no `<`: dos CFDI con la misma fecha al segundo en el borde no se saltan; los que ya se
  // guardaron no vuelven (xml IS NULL), y los de borde sin contenido son unos cuantos.
  const historicos = resto ? (await pg.query(
    `SELECT uuid, stored_ref, fecha FROM fiscal.cfdis
      WHERE tenant_id = $1 AND source = 'contpaqi_add' AND rol = $2 AND xml IS NULL
        AND stored_ref IS NOT NULL AND tipo_comprobante = ANY ($3)
        AND fecha < now() - make_interval(days => $5)
        AND ($6::timestamptz IS NULL OR fecha <= $6::timestamptz)
      ORDER BY fecha DESC LIMIT $4`, [tenant, rol, tipos, resto, DIAS_RECIENTES, cursor])).rows : [];
  const rows = [...recientes, ...historicos];
  const res = { pedidas: rows.length, guardadas: 0, sin_contenido: 0, uuid_distinto: 0, cursor: cursor ? new Date(cursor).toISOString() : null };
  if (!rows.length) return res;
  const xmls = await traerXml(poolContent, rows.map((r) => r.stored_ref));
  const uuids = []; const contenidos = [];
  for (const r of rows) {
    const x = xmls.get(String(r.stored_ref).toUpperCase());
    if (!x) { res.sin_contenido++; continue; }
    if (uuidDelXml(x) !== String(r.uuid).toUpperCase()) { res.uuid_distinto++; continue; }
    uuids.push(r.uuid); contenidos.push(x);
  }
  if (apply && uuids.length) {
    for (let i = 0; i < uuids.length; i += 200) {
      const u = uuids.slice(i, i + 200); const c = contenidos.slice(i, i + 200);
      const r = await pg.query(
        `UPDATE fiscal.cfdis t SET xml = v.xml, updated_at = now()
           FROM unnest($2::text[], $3::text[]) AS v(uuid, xml)
          WHERE t.tenant_id = $1 AND t.uuid = v.uuid AND t.xml IS NULL`, [tenant, u, c]);
      res.guardadas += r.rowCount;
    }
  } else {
    res.guardadas = uuids.length; // dry-run: las que se guardarían
  }
  // El cursor baja hasta la fecha más vieja que se pidió en este tramo (sólo baja: LEAST).
  if (apply && llave && historicos.length) {
    const masVieja = historicos[historicos.length - 1].fecha;
    await pg.query(
      `INSERT INTO analytics.feed_watermarks (tenant_id, feed_key, label, watermark_ts, rows_last, rows_total, last_run, updated_at)
       VALUES ($1, $2, 'XML de CFDIs desde el ADD (cursor del histórico, baja)', $3, $4::integer, $5::bigint, now(), now())
       ON CONFLICT (tenant_id, feed_key) DO UPDATE
         SET watermark_ts = LEAST(analytics.feed_watermarks.watermark_ts, EXCLUDED.watermark_ts),
             rows_last = EXCLUDED.rows_last,
             rows_total = analytics.feed_watermarks.rows_total + EXCLUDED.rows_last,
             last_run = now(), updated_at = now()`,
      [tenant, llave, masVieja, res.guardadas, res.guardadas]);
    res.cursor = new Date(masVieja).toISOString();
  }
  return res;
}

module.exports = { uuidDelXml, traerXml, completarXml };
