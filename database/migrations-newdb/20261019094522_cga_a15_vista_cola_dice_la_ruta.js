'use strict';
/**
 * ⭐⭐ `[CGA-A.15]` — **La cola dice DE QUÉ RUTA viene cada cobro, en una columna propia.**
 *
 * ── El problema, visto en pantalla el 2026-10-19 ───────────────────────────────────────────
 *
 * Con nueve camionetas entregando, la bandeja muestra una pila de filas **idénticas**:
 * `CONTADO · U-A-5 0000014`, nueve veces, con montos distintos. Quien captura no puede saber
 * cuál es de cuál, y el folio no ayuda —es consecutivo **por unidad**, así que se repite entre
 * rutas el mismo día (la causa de `GOTCHAS` §86).
 *
 * El dato existe y la vista lo tiraba: `analytics.route_collections` trae `truck`, y la rama de
 * camioneta lo descartaba para escribir `'CONTADO'` a mano en `entidad_code` y `beneficiario`.
 *
 * ── Por qué una COLUMNA NUEVA y no reusar un campo ─────────────────────────────────────────
 *
 * Se midieron las tres salidas antes de elegir:
 *
 *  · **`entidad_code`** parece el lugar natural y **es una LLAVE VIVA**: `caja-autofill.service`
 *    hace `porEntidad()` → `WHERE entidad_code = $1` para ofrecer lo que esa persona ya repitió.
 *    Cambiarlo a `RUTA_27` **no rompe con error: deja de encontrar el historial**, que vive bajo
 *    `CONTADO`. (Reglas de clasificación tocadas: **0 de 3** — eso sí estaba limpio.)
 *  · **`beneficiario`** se ve de una... y **se copia a `finance.cash_ledger` al capturar**.
 *    Quedarían movimientos viejos con `CONTADO` y nuevos con `Ruta 27 · CONTADO`: dos formas del
 *    mismo dato conviviendo. **Es exactamente el defecto que escondió $1,325,687.43** — meter
 *    identidad adentro de un campo de texto que ya significaba otra cosa.
 *  · **Columna propia**: aditiva. Nada existente cambia de significado, ninguna llave se mueve,
 *    nada se copia al libro.
 *
 * ── Por qué NO se adivina por el formato de la sucursal ────────────────────────────────────
 *
 * ⛔ Tentaba resolverlo con «si la sucursal es `NN-NNN` es ruta». Medido: de los **136** cobros
 * `CONTADO` de la cola, **100 son de camioneta y 36 NO** (sucursales `01, 02, 03, 07, 08`,
 * $799,738.36) — son cobros de **mostrador**, donde `CONTADO` es el cliente de verdad.
 * Etiquetarlos con una ruta sería inventar.
 *
 * ⭐ No hace falta ninguna heurística: **la rama que lee `analytics.route_collections` es la
 * única que sabe de camionetas.** Emite `r.truck`; la otra emite `NULL`. La verdad sale de la
 * procedencia del renglón, no de cómo se ve su código — que es la lección de §86.
 *
 * ── Detalles ───────────────────────────────────────────────────────────────────────────────
 *
 * · `ruta` va **al final**: `CREATE OR REPLACE VIEW` admite agregar columnas al final sin
 *   soltar la vista, y soltarla rompería el `GRANT` a `dev_ro` y los planes en caché.
 * · Se usa `string_agg(DISTINCT r.truck, ' · ')` y **no** `min()`: hoy el almacén es 1:1 con la
 *   unidad (verificado, 9 de 9), pero si eso dejara de ser cierto `min()` **escondería** una y
 *   `string_agg` las **muestra las dos**. Mismo criterio que la línea de `concepto`, justo
 *   arriba. Y no se agrega al `GROUP BY`: eso partiría un cobro en dos renglones.
 * · El resto de la definición se preserva **textual**, tal como `pg_get_viewdef` la devolvió.
 *
 * Idempotente: `CREATE OR REPLACE`.
 *
 * @param { import("knex").Knex } knex
 */

/** La definición con `ruta`. `$ruta$` como delimitador: el cuerpo lleva comillas simples. */
const VISTA = (conRuta) => `
CREATE OR REPLACE VIEW finance.v_caja_movimientos_pendientes AS
 SELECT k.tenant_id,
    k.clave_banco,
    k.banco_nombre AS caja_nombre,
    k.sucursal,
    k.doc_tipo,
    k.folio,
    (((((k.sucursal || '|'::text) || k.doc_tipo) || '|'::text) || k.folio) || '|'::text) || k.clave_banco AS origen_ref,
        CASE
            WHEN k.signo > 0 THEN 'ingreso'::text
            ELSE 'gasto'::text
        END AS tipo,
        CASE
            WHEN k.signo > 0 THEN 'cobro'::text
            ELSE 'pago_proveedor'::text
        END AS origen_tipo,
    k.fecha_valor,
    k.fecha_captura,
    k.entidad_code,
    k.beneficiario,
    k.concepto,
    k.metodo,
    k.importe AS monto${conRuta ? `,
    NULL::text AS ruta` : ''}
   FROM analytics.mv_caja_movimientos k
  WHERE k.tenant_id = current_tenant_id() AND k.signo <> 0 AND k.es_traspaso = false AND k.importe > 0::numeric AND NOT (EXISTS ( SELECT 1
           FROM finance.cash_ledger l
          WHERE l.tenant_id = k.tenant_id AND l.origen_tipo =
                CASE
                    WHEN k.signo > 0 THEN 'cobro'::text
                    ELSE 'pago_proveedor'::text
                END AND l.origen_ref = ((((((k.sucursal || '|'::text) || k.doc_tipo) || '|'::text) || k.folio) || '|'::text) || k.clave_banco) AND l.deleted_at IS NULL AND l.estado <> 'cancelado'::text))
UNION ALL
 SELECT r.tenant_id,
    '0011'::text AS clave_banco,
    'CAJA GENERAL'::text AS caja_nombre,
    r.almacen AS sucursal,
    'U-A-5'::text AS doc_tipo,
    r.cobro_folio AS folio,
    ((r.almacen || '|U-A-5|'::text) || r.cobro_folio) || '|0011'::text AS origen_ref,
    'ingreso'::text AS tipo,
    'cobro'::text AS origen_tipo,
    r.fecha AS fecha_valor,
    r.fecha AS fecha_captura,
    'CONTADO'::text AS entidad_code,
    'CONTADO'::text AS beneficiario,
    string_agg(DISTINCT COALESCE(r.referencia, r.folio_corte), ' · '::text) AS concepto,
    NULL::text AS metodo,
    sum(r.importe) AS monto${conRuta ? `,
    string_agg(DISTINCT r.truck, ' · '::text) AS ruta` : ''}
   FROM analytics.route_collections r
  WHERE r.tenant_id = current_tenant_id() AND r.cuenta = '0011'::text AND NOT (EXISTS ( SELECT 1
           FROM finance.cash_ledger l
          WHERE l.tenant_id = r.tenant_id AND l.origen_tipo = 'cobro'::text AND l.origen_ref = (((r.almacen || '|U-A-5|'::text) || r.cobro_folio) || '|0011'::text) AND l.deleted_at IS NULL AND l.estado <> 'cancelado'::text))
  GROUP BY r.tenant_id, r.almacen, r.cobro_folio, r.fecha`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VISTA(true));

  // ⛔ `COMMENT ON` NO acepta parámetros ligados (GOTCHAS §51).
  await knex.raw(
    `COMMENT ON COLUMN finance.v_caja_movimientos_pendientes.ruta IS ` +
    `'[CGA-A.15] La unidad de reparto de la que viene este cobro (ruta_27, ruta_503...). ` +
    `NULL = no es de camioneta: cobro de mostrador, donde CONTADO es el cliente de verdad. ` +
    `Sale de analytics.route_collections.truck, NO de adivinar por el formato de la sucursal: ` +
    `de 136 cobros CONTADO medidos el 2026-10-19, 36 eran de mostrador.'`);

  // La vista se recrea, pero el GRANT sobrevive a CREATE OR REPLACE. Se re-afirma por si acaso:
  // un `dev_ro` sin SELECT deja ciegas a las compuertas que leen prod.
  await knex.raw(`GRANT SELECT ON finance.v_caja_movimientos_pendientes TO dev_ro`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista sin la columna. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⚠️ Quitar una columna NO lo admite `CREATE OR REPLACE`: hay que soltar y recrear.
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_movimientos_pendientes`);
  await knex.raw(VISTA(false));
  await knex.raw(`GRANT SELECT ON finance.v_caja_movimientos_pendientes TO dev_ro`);
};
