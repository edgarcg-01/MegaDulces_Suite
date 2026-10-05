/**
 * [PP.9] `analytics.erp_supplier_payments` declara CON QUÉ se pagó, no sólo qué documento se usó.
 *
 * ── El defecto, medido contra prod el 2026-10-05 ─────────────────────────────────────────────
 *
 * `metodo_pago` sale de `kdm1.c31` (`tra%`→transferencia · `che%`→cheque · `ant%`→anticipo). Eso
 * es el **tipo de documento** de Kepler, NO el medio por el que salió el dinero. Resultado: la
 * pantalla `/finanzas/pagos-comprobantes` publica —y deja **filtrar por**—
 *
 *     "Transferencia" · CAJA GENERAL · 2,682 pagos · $52,256,085.26
 *     "Anticipo"      · CAJA GENERAL ·    31 pagos ·  $3,975,624.52
 *
 * o sea **$56.2M que salieron en EFECTIVO rotulados como transferencia bancaria**. Un filtro por
 * "transferencia" devuelve hoy pagos en efectivo, y nadie puede sacar de esa pantalla cuánto se
 * pagó en efectivo — que es justamente la pregunta que abrió esta fase.
 *
 * ── Qué se hace, y qué NO ───────────────────────────────────────────────────────────────────
 *
 * ⛔ **`metodo_pago` NO se toca.** No está "mal": dice fielmente qué doctype usó Kepler, tiene
 * consumidores (`supplier-payment-proofs`, el filtro `?metodo=`) y cambiarle el significado de
 * abajo sería peor que el defecto. Se AGREGA el medio real como columna propia y se declara la
 * diferencia — dos preguntas distintas, dos columnas (ADR-056).
 *
 * ⭐ **La lógica NO se reinventa:** sale de `kdm1.c45` ⋈ `kepler_ods.kdb1`, exactamente como ya lo
 * hace `analytics.kepler_bank_movements.tipo_cuenta` — y conserva su vocabulario
 * (`caja`/`banco`/`puente`) para que las dos pantallas sean comparables en vez de inventar un
 * tercer juego de nombres. El discriminante es `kdb1.c3` (la palabra `EFECTIVO` contra una CLABE),
 * NO `c5`, que tiene `102` pelado en tres de las cinco cajas — ver
 * [[reference_kepler_c45_cuenta_de_tesoreria]].
 *
 * ── Cobertura medida (2026, read-only) ──────────────────────────────────────────────────────
 *
 *   · `c45` poblado en **4,655 de 4,660** documentos (99.9 %); los 5 restantes quedan
 *     `sin_declarar`, **nunca** colgados del lado "banco" por default.
 *   · Resuelve contra `kdb1` sin residuo: `0011 CAJA GENERAL` (caja) 2,715 · bancos · `2103
 *     FACTORAJE` (puente) 101.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` sólo permite AGREGAR columnas **al final** y con los tipos previos
 * intactos; por eso `medio_pago`/`cuenta_tesoreria` van últimas. La definición de abajo se tomó de
 * `pg_get_viewdef` sobre prod (la vista ya fue recreada por varias migraciones; la más vieja ya no
 * la describe).
 *
 * ⚠️ El `LEFT JOIN` a `kdb1` **no cambia la cardinalidad**: el subselect trae `DISTINCT ON
 * (btrim(c1))`, o sea una fila por clave de cuenta.
 *
 * ⚠️ Se re-aplica el `GRANT` después del replace. La vista **no** tiene `security_invoker` hoy
 * (`reloptions` vacío, verificado) y esta migración **no se lo agrega**: cambiar quién evalúa los
 * permisos sobre `kepler_ods` es otra decisión y otro riesgo, no el de esta línea.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const VIEW_SQL = `
  CREATE OR REPLACE VIEW analytics.erp_supplier_payments AS
  SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio)
    '${M}'::uuid AS tenant_id,
    q.sucursal, q.folio, q.doc_prefix, q.pago_date,
    q.proveedor_code, q.proveedor_nombre, q.proveedor_rfc, q.concepto, q.monto,
    'md_00'::text AS source_branch, now() AS computed_at, q.metodo_pago, q.descuento,
    w.id AS warehouse_id,
    -- [PP.9] El MEDIO real por el que salió el dinero. 'sin_declarar' cuando el documento no trae
    -- cuenta de tesorería, y 'no_resuelve' cuando la trae pero no existe en el catálogo: dos
    -- ausencias distintas, dos etiquetas — ninguna se dibuja como 'banco'.
    CASE
      WHEN btrim(COALESCE(q.cuenta_tes, '')) = '' THEN 'sin_declarar'
      ELSE COALESCE(b.tipo, 'no_resuelve')
    END AS medio_pago,
    b.nombre AS cuenta_tesoreria
  FROM (
    SELECT '00'::text AS sucursal, btrim(kdm1.c6) AS folio,
      CASE btrim(kdm1.c4::text)
        WHEN '26'::text THEN 'XD2601'::text
        WHEN '60'::text THEN 'XD6001'::text
        ELSE 'XD2501'::text
      END AS doc_prefix,
      CASE
        WHEN lower(btrim(kdm1.c31)) LIKE 'tra%' THEN 'transferencia'::text
        WHEN lower(btrim(kdm1.c31)) LIKE 'che%' THEN 'cheque'::text
        WHEN lower(btrim(kdm1.c31)) LIKE 'ant%' THEN 'anticipo'::text
        ELSE NULL::text
      END AS metodo_pago,
      kdm1.c9::date AS pago_date,
      NULLIF(btrim(kdm1.c10), ''::text) AS proveedor_code,
      NULLIF(btrim(kdm1.c32), ''::text) AS proveedor_nombre,
      NULLIF(btrim(kdm1.c22), ''::text) AS proveedor_rfc,
      NULLIF(btrim(kdm1.c24), ''::text) AS concepto,
      round(COALESCE(NULLIF(regexp_replace(kdm1.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
      round(COALESCE(NULLIF(regexp_replace(kdm1.c84, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS descuento,
      btrim(kdm1.c45) AS cuenta_tes
    FROM kepler_ods.kdm1
    WHERE kdm1.c2 = 'X'::text AND kdm1.c3 = 'D'::text
      AND (btrim(kdm1.c4::text) = ANY (ARRAY['25'::text, '26'::text, '60'::text]))
      AND btrim(kdm1.c10) ILIKE 'C%'::text
      AND kdm1.sucursal = '00'::text AND btrim(kdm1.c1) = '00'::text
      AND btrim(COALESCE(kdm1.c43, ''::text)) <> 'C'::text
  ) q
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id = '${M}'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL
  LEFT JOIN (
    SELECT DISTINCT ON (btrim(kdb1.c1)) btrim(kdb1.c1) AS clave, btrim(kdb1.c2) AS nombre,
      CASE
        WHEN btrim(kdb1.c5) NOT LIKE '102%' THEN 'puente'::text
        WHEN upper(btrim(COALESCE(kdb1.c3, ''::text))) = 'EFECTIVO'::text THEN 'caja'::text
        ELSE 'banco'::text
      END AS tipo
    FROM kepler_ods.kdb1
    WHERE btrim(COALESCE(kdb1.c1, ''::text)) <> ''::text
    ORDER BY btrim(kdb1.c1), kdb1.sucursal
  ) b ON b.clave = q.cuenta_tes
  ORDER BY q.sucursal, q.doc_prefix, q.folio`;

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS a, to_regclass('kepler_ods.kdb1') AS b`);
  // Sin ODS (entorno de dev pelado) no hay nada que derivar: la vista no existe o no tiene fuente.
  if (!ods.rows[0]?.a || !ods.rows[0]?.b) return;

  const r = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_supplier_payments')`);
  if (r.rows[0]?.relkind !== 'v') return;

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VIEW_SQL);
  // El GRANT no sobrevive por sí solo a un replace en todos los casos: se re-aplica siempre.
  await knex.raw('GRANT SELECT ON analytics.erp_supplier_payments TO app_runtime');
  await knex.raw(`
    COMMENT ON COLUMN analytics.erp_supplier_payments.medio_pago IS
      '[PP.9] Medio REAL por el que salió el dinero (caja|banco|puente|sin_declarar|no_resuelve), derivado de kdm1.c45 ⋈ kdb1 igual que kepler_bank_movements.tipo_cuenta. NO confundir con metodo_pago, que es el TIPO DE DOCUMENTO (c31) y rotula como transferencia pagos hechos en efectivo.'`);
};

/**
 * Rollback: la vista EXACTA de antes (copiada de `pg_get_viewdef` sobre prod), escrita literal.
 *
 * ⚠️ Se escribe entera a propósito. La primera versión derivaba este SQL recortando el de arriba
 * con un regex — un rollback que depende de una expresión regular es un rollback que falla el día
 * que se necesita, y encima en silencio: produciría una vista *parecida*.
 *
 * `CREATE OR REPLACE` no puede QUITAR columnas, así que hay que `DROP` + recrear. Si algo ya
 * consume `medio_pago`, el DROP falla — y es correcto que falle en vez de romper al consumidor.
 */
exports.down = async function (knex) {
  const r = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_supplier_payments')`);
  if (r.rows[0]?.relkind !== 'v') return;
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW analytics.erp_supplier_payments`);
  await knex.raw(`
    CREATE VIEW analytics.erp_supplier_payments AS
    SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio)
      '${M}'::uuid AS tenant_id,
      q.sucursal, q.folio, q.doc_prefix, q.pago_date,
      q.proveedor_code, q.proveedor_nombre, q.proveedor_rfc, q.concepto, q.monto,
      'md_00'::text AS source_branch, now() AS computed_at, q.metodo_pago, q.descuento,
      w.id AS warehouse_id
    FROM (
      SELECT '00'::text AS sucursal, btrim(kdm1.c6) AS folio,
        CASE btrim(kdm1.c4::text)
          WHEN '26'::text THEN 'XD2601'::text
          WHEN '60'::text THEN 'XD6001'::text
          ELSE 'XD2501'::text
        END AS doc_prefix,
        CASE
          WHEN lower(btrim(kdm1.c31)) LIKE 'tra%' THEN 'transferencia'::text
          WHEN lower(btrim(kdm1.c31)) LIKE 'che%' THEN 'cheque'::text
          WHEN lower(btrim(kdm1.c31)) LIKE 'ant%' THEN 'anticipo'::text
          ELSE NULL::text
        END AS metodo_pago,
        kdm1.c9::date AS pago_date,
        NULLIF(btrim(kdm1.c10), ''::text) AS proveedor_code,
        NULLIF(btrim(kdm1.c32), ''::text) AS proveedor_nombre,
        NULLIF(btrim(kdm1.c22), ''::text) AS proveedor_rfc,
        NULLIF(btrim(kdm1.c24), ''::text) AS concepto,
        round(COALESCE(NULLIF(regexp_replace(kdm1.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
        round(COALESCE(NULLIF(regexp_replace(kdm1.c84, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS descuento
      FROM kepler_ods.kdm1
      WHERE kdm1.c2 = 'X'::text AND kdm1.c3 = 'D'::text
        AND (btrim(kdm1.c4::text) = ANY (ARRAY['25'::text, '26'::text, '60'::text]))
        AND btrim(kdm1.c10) ILIKE 'C%'::text
        AND kdm1.sucursal = '00'::text AND btrim(kdm1.c1) = '00'::text
        AND btrim(COALESCE(kdm1.c43, ''::text)) <> 'C'::text
    ) q
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id = '${M}'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL
    ORDER BY q.sucursal, q.doc_prefix, q.folio`);
  await knex.raw('GRANT SELECT ON analytics.erp_supplier_payments TO app_runtime');
};
