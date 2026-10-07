/**
 * `[TK.d4]` `analytics.erp_sale_tickets` gana `descuento_pct` — el % de descuento del cliente que
 * el ticket de mostrador SÍ trae, contra lo que decía la medición vieja.
 *
 * ── Por qué no estaba ────────────────────────────────────────────────────────────────────────
 * La fase TK midió el 2026-09-18 que en `U-D-10` la cabecera del descuento (`kdm1.c13`) es
 * **0.00 en el 100%** de 30,549 documentos, y de ahí salieron dos cosas: el comentario de la
 * columna `descuento_documento` en la mig `20260918160000` y el `descuento_pct_erp: null` clavado
 * en `detalleMostrador()`. Con esa medición, exponer el porcentaje habría sido publicar una
 * columna estructuralmente vacía.
 *
 * ── Por qué sí está ahora ────────────────────────────────────────────────────────────────────
 * ⭐ **Ese 100% se midió SIN Morelia.** Verificado contra prod el 2026-09-28 (Fase DC §6): las
 * ramas `06`, `07` y `08` traen `c13 != 0` en mostrador — **20 tickets, $1,948.15** — porque ahí
 * la caja cobra el descuento negociado del cliente. El caso trabajado, al centavo:
 *
 *     07 · U-D-10 · serie 4 · folio 0000513   (cliente 20361, 51 renglones)
 *       Sigma importe de renglones   $4,914.44
 *       total de cabecera (c16)      $4,767.01
 *       descuento REAL                 $147.43  = 3.0000% exacto
 *       c19 (el % declarado)                 3
 *
 * Y `c19` no es un número suelto: cruzado contra `kdud.c17` —el % negociado en el **maestro de
 * clientes**— coincide en **533 de 578 (92.2%)** de las ventas de septiembre 2026. Por eso el
 * papel puede llamarlo «Descuento de cliente» y no estar adivinando.
 *
 * ── Lo que esta columna NO es ────────────────────────────────────────────────────────────────
 * ⛔ **No se expone `c13`.** Viaja SIN impuesto mientras el total va CON: en el documento de
 * arriba dice $135.26 contra los $147.43 reales — **subdeclara 8.3%**. El importe del descuento
 * lo sigue calculando el servicio como `Sigma renglones - total`, que cierra por construcción.
 * Esta columna es **sólo el porcentaje**, para poder rotularlo al lado del importe medido.
 *
 * ── Forma del cambio ─────────────────────────────────────────────────────────────────────────
 * Aditiva y al FINAL: `CREATE OR REPLACE VIEW` no admite quitar, reordenar ni insertar en medio.
 * Las 22 columnas actuales quedan **idénticas** —mismo nombre, mismo tipo, mismo orden— y el
 * candado de abajo lo comprueba contra el catálogo, antes y después.
 *
 * ⚠️ `regexp_replace` sin el signo: un porcentaje negativo no existe y dejarlo pasar convertiría
 * un dato sucio en un recargo. `NULLIF` + `::numeric` sin `COALESCE(...,0)`: **un documento que no
 * declara porcentaje no es uno con 0% de descuento** (ADR-056), y el papel imprime una cosa y la
 * otra distinto.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;

const HEAD = `h.c2='U' AND h.c3='D' AND (h.c4)::int=10 AND btrim(h.c1)=btrim(h.sucursal)`;

/**
 * Las 22 columnas VERBATIM de la definicion viva (mig 20260921220000) + `descuento_pct` al final.
 * No se toca una sola linea de las anteriores: cualquier retoque de paso aca seria un cambio de
 * datos viajando de polizon en una migracion que dice ser aditiva.
 */
const VIEW = `
  SELECT
    '${M}'::uuid AS tenant_id,
    q.sucursal, w.id AS warehouse_id, w.name AS warehouse_name,
    q.doc_prefix, 'ticket'::text AS doc_tipo, q.doc_label, q.caja, q.folio,
    q.sucursal || q.doc_prefix || '-' || q.folio AS folio_digital,
    q.fecha,
    q.cliente_code, q.cliente_nombre, q.cliente_rfc,
    q.cajero_code, q.cajero_nombre,
    q.total, q.iva, q.ieps, q.descuento_documento,
    'md_' || q.sucursal AS source_branch, now() AS computed_at,
    q.descuento_pct
  FROM (
    SELECT
      btrim(h.sucursal) AS sucursal,
      'UD' || lpad((h.c4)::int::text,2,'0') || lpad((h.c5)::int::text,2,'0') AS doc_prefix,
      (h.c5)::int AS caja,
      COALESCE(NULLIF(btrim(dm.c5::text),''), 'Ticket Contado Caja ' || (h.c5)::int) AS doc_label,
      btrim(h.c6::text) AS folio,
      h.c9::date AS fecha,
      NULLIF(btrim(h.c10::text),'') AS cliente_code,
      NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
      NULLIF(btrim(h.c22::text),'') AS cliente_rfc,
      NULLIF(btrim(h.c12::text),'') AS cajero_code,
      NULLIF(btrim(v.c3::text),'')  AS cajero_nombre,
      ${money('h.c16')} AS total,
      ${money('h.c14')} AS iva,
      ${money('h.c15')} AS ieps,
      -- CADUCO el "siempre 0.00 en el mostrador": se midio sin Morelia. Las ramas 06/07/08
      -- traen c13 != 0 (20 tickets, $1,948.15 -- Fase DC 6). Sigue sin ser el descuento REAL:
      -- va sin impuesto y subdeclara 8.3%. El servicio lo mide como Sigma renglones - total.
      ${money('h.c13')} AS descuento_documento,
      -- El % del descuento de cliente. NULL cuando el documento no lo declara, NUNCA 0.
      NULLIF(regexp_replace(h.c19::text,'[^0-9.]','','g'),'')::numeric AS descuento_pct
    FROM kepler_ods.kdm1 h
    -- La igualdad CRUDA va junto a la de btrim, no en su lugar: con cero padding (medido) el
    -- conjunto de filas es identico, y es la unica forma de que kduv_pkey / kdmm_pkey se usen.
    LEFT JOIN kepler_ods.kduv v
      ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2::text)=btrim(h.c12::text)
     AND v.sucursal=h.sucursal AND v.c2=h.c12
    LEFT JOIN kepler_ods.kdmm dm
      ON btrim(dm.sucursal)=btrim(h.sucursal) AND btrim(dm.c1)='U' AND btrim(dm.c2)='D'
     AND (dm.c3)::int=(h.c4)::int AND (dm.c4)::int=(h.c5)::int
     AND dm.sucursal=h.sucursal AND dm.c1='U' AND dm.c2='D'
    WHERE ${HEAD}
  ) q
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL`;

/**
 * Las 22 columnas de hoy, en orden. Se comprueban ANTES y DESPUES: si la vista viva ya no es
 * esta, otra migracion la movio y agregarle una columna encima seria pisarla a ciegas.
 */
const ANTES = [
  'tenant_id', 'sucursal', 'warehouse_id', 'warehouse_name', 'doc_prefix', 'doc_tipo',
  'doc_label', 'caja', 'folio', 'folio_digital', 'fecha', 'cliente_code', 'cliente_nombre',
  'cliente_rfc', 'cajero_code', 'cajero_nombre', 'total', 'iva', 'ieps', 'descuento_documento',
  'source_branch', 'computed_at',
];

const columnas = async (knex) => {
  const { rows } = await knex.raw(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_sale_tickets'
      ORDER BY ordinal_position`);
  return rows.map((r) => r.column_name);
};

exports.up = async function up(knex) {
  const antes = await columnas(knex);

  // Idempotente: si ya esta, no hay nada que hacer y tampoco hay que fallar.
  if (antes.length === 23 && antes[22] === 'descuento_pct') {
    console.log('  ✓ erp_sale_tickets ya trae descuento_pct: nada que hacer.');
    return;
  }

  // ── El candado, ANTES de tocar nada ────────────────────────────────────────────────────
  if (antes.join(',') !== ANTES.join(',')) {
    throw new Error(
      'analytics.erp_sale_tickets NO es la definicion que esta migracion conoce.\n' +
      `  esperaba: ${ANTES.join(', ')}\n` +
      `  encontro: ${antes.join(', ')}\n` +
      'Otra migracion la movio. Agregarle una columna encima pisaria ese cambio: se para aca.');
  }

  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sale_tickets AS ${VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sale_tickets TO app_runtime');

  // ── Y DESPUES: las 22 intactas, la 23 al final, y nada de por medio ────────────────────
  const despues = await columnas(knex);
  if (despues.slice(0, 22).join(',') !== ANTES.join(',')) {
    throw new Error(
      'Las 22 columnas originales NO quedaron identicas tras el CREATE OR REPLACE:\n' +
      `  ${despues.slice(0, 22).join(', ')}`);
  }
  if (despues.length !== 23 || despues[22] !== 'descuento_pct') {
    throw new Error(`erp_sale_tickets quedo con ${despues.length} columnas: ${despues.join(', ')}`);
  }
  console.log('  ✓ erp_sale_tickets: 23 columnas, las 22 de antes intactas + descuento_pct.');
};

/**
 * Vuelve a las 22 columnas. Se puede: nada NOT NULL, ningun indice ni vista encima depende de
 * `descuento_pct` — lo consume solo `detalleMostrador()`, que ya toleraba el `null`.
 */
exports.down = async function down(knex) {
  const hoy = await columnas(knex);
  if (hoy.length !== 23) {
    console.log(`[erp_sale_tickets_descuento_pct] down: la vista tiene ${hoy.length} columnas, no 23. No se toca.`);
    return;
  }
  // Quitar una columna no se puede con REPLACE aunque sea la ULTIMA: Postgres no admite
  // reducir la lista. Por eso va DROP + CREATE, no REPLACE.
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sale_tickets');
  const sinPct = VIEW.replace(',\n    q.descuento_pct', '');
  await knex.raw(`CREATE VIEW analytics.erp_sale_tickets AS ${sinPct}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sale_tickets TO app_runtime');
  console.log('  ✓ erp_sale_tickets de vuelta en 22 columnas.');
};
