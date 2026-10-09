/**
 * [CSU.8] `analytics.erp_collections` declara A QUÉ CUENTA entró el dinero del cobro.
 *
 * ── Qué faltaba ─────────────────────────────────────────────────────────────────────────────
 *
 * `/finanzas/cortes-sucursales` muestra «Cobros aplicados en Kepler» con folio, fecha, forma de
 * pago y concepto — pero **no dice a qué banco se depositó**, que es la pregunta que cierra el
 * recorrido del dinero. El dato existe y nadie lo leía: `kdm1.c45` es la cuenta de tesorería del
 * documento de cobro.
 *
 * ⭐ **La lógica NO se reinventa.** Sale de `kdm1.c45` ⋈ `kepler_ods.kdb1`, exactamente como ya lo
 * hacen `analytics.kepler_bank_movements.tipo_cuenta` y `erp_supplier_payments.medio_pago`
 * (`[PP.9]`), y conserva su vocabulario (`caja`/`banco`/`puente`) para que las pantallas sean
 * comparables en vez de inventar un tercer juego de nombres. El discriminante es `kdb1.c3` (la
 * palabra `EFECTIVO` contra una CLABE), **NO** `c5`, que tiene `102` pelado en tres de las cinco
 * cajas — ver [[reference_kepler_c45_cuenta_de_tesoreria]].
 *
 * ── Cobertura medida contra prod (2026, sólo lectura) ───────────────────────────────────────
 *
 *   · `c45` poblado en **24,757 de 24,763** cobros (99.98 %). Los **6** restantes ($101,527.14)
 *     quedan `sin_declarar`, **nunca** colgados del lado «banco» por default.
 *   · Resuelve contra `kdb1` **sin residuo**: cero `no_resuelve`.
 *   · 17 bancos · `CAJA GENERAL` · 3 cuentas puente (`DEVOLUCIONES` 109, `AJUSTE A SALDO` 20,
 *     `TRASPASOS DE SUCURSAL` 1).
 *
 * ⭐⭐ **El hallazgo que define la forma de la columna: 3,599 cobros por $75,075,947.72 entraron a
 * `CAJA GENERAL`, no a un banco.** O sea que «a qué banco se depositó» tiene una respuesta
 * legítima que **no es un banco** en ~15 % de los cobros. Por eso van DOS columnas y no una sola
 * de texto: `medio_cobro` dice de qué clase es la cuenta y `cuenta_tesoreria` cómo se llama. Una
 * columna sola obligaría a la pantalla a decidir si «CAJA GENERAL» se pinta como banco o se deja
 * en blanco, y las dos opciones mienten (ADR-056).
 *
 * ── Trampas ────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ `CREATE OR REPLACE VIEW` sólo permite AGREGAR columnas **al final** y con los tipos previos
 * intactos; por eso `medio_cobro`/`cuenta_tesoreria` van últimas. La definición de abajo se tomó
 * de `pg_get_viewdef` sobre **prod**, no de una migración vieja: la vista ya fue recreada por
 * varias (`20260925120000`, `20261003180000`, `20261006160000`) y la más antigua ya no la
 * describe.
 *
 * ⚠️ `pg_get_viewdef(..., true)` imprime `warehouses` **sin esquema** porque estaba en el
 * `search_path` de quien la creó. Acá se escribe `commercial.warehouses` explícito —verificado
 * contra `pg_depend`—: copiar el nombre pelado deja la migración a merced del `search_path` del
 * que la corre.
 *
 * ⚠️ El `LEFT JOIN` a `kdb1` **no cambia la cardinalidad**: el subselect trae `DISTINCT ON
 * (btrim(c1))`, o sea una fila por clave de cuenta. `kdb1` viene replicado por sucursal (cada
 * clave aparece ~9 veces) y sin el `DISTINCT ON` cada cobro se multiplicaría.
 *
 * ⚠️ Se re-aplica el `GRANT` después del replace. La vista **no** tiene `security_invoker` hoy
 * (`reloptions` vacío, verificado contra prod) y esta migración **no se lo agrega**: cambiar quién
 * evalúa los permisos sobre `kepler_ods` es otra decisión y otro riesgo, no el de esta línea.
 *
 * ⛔ No toca `forma_pago` ni `tipo_cuenta`. `forma_pago` es cómo pagó el cliente (se deriva del
 * complemento SAT y del concepto) y `tipo_cuenta` es la clase del CLIENTE (`cliente_final`) —
 * ninguna de las dos habla de tesorería. Tres preguntas distintas, tres columnas.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

/** El clasificador de cuenta de tesorería, calcado de `[PP.9]`. Una fila por clave. */
const KDB1 = `
    SELECT DISTINCT ON (btrim(kdb1.c1)) btrim(kdb1.c1) AS clave, btrim(kdb1.c2) AS nombre,
      CASE
        WHEN btrim(kdb1.c5) NOT LIKE '102%' THEN 'puente'::text
        WHEN upper(btrim(COALESCE(kdb1.c3, ''::text))) = 'EFECTIVO'::text THEN 'caja'::text
        ELSE 'banco'::text
      END AS tipo
    FROM kepler_ods.kdb1
    WHERE btrim(COALESCE(kdb1.c1, ''::text)) <> ''::text
    ORDER BY btrim(kdb1.c1), kdb1.sucursal`;

/** El cuerpo común a las dos versiones: sólo cambian las columnas del final y el join a kdb1. */
const CUERPO = (colsExtra, joinExtra) => `
  CREATE OR REPLACE VIEW analytics.erp_collections AS
  SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio) '${M}'::uuid AS tenant_id,
     q.sucursal,
     q.folio,
     q.doc_prefix,
     q.cobro_date,
     q.cliente_code,
     q.cliente_nombre,
     q.concepto,
     q.forma_pago,
     q.monto,
     COALESCE(k.kind, analytics.customer_account_kind_by_code(q.cliente_code), 'cliente_final'::text) AS tipo_cuenta,
     q.source_branch,
     now() AS computed_at,
     w.id AS warehouse_id,
     q.cobro_clase${colsExtra}
    FROM ( SELECT btrim(m.sucursal) AS sucursal,
             btrim(m.c6) AS folio,
             ('UA'::text || lpad(m.c4::text, 2, '0'::text)) || lpad(m.c5::text, 2, '0'::text) AS doc_prefix,
                 CASE
                     WHEN m.c4 = 7::numeric THEN COALESCE(cp.fecha_pago, m.c9::date)
                     ELSE m.c9::date
                 END AS cobro_date,
             NULLIF(btrim(m.c10), ''::text) AS cliente_code,
             NULLIF(btrim(m.c32), ''::text) AS cliente_nombre,
             NULLIF(btrim(m.c24), ''::text) AS concepto,
             COALESCE(
                 CASE cp.forma_pago_sat
                     WHEN '01'::text THEN 'efectivo'::text
                     WHEN '02'::text THEN 'cheque'::text
                     WHEN '03'::text THEN 'transferencia'::text
                     ELSE NULL::text
                 END,
                 CASE
                     WHEN upper(m.c24) ~ 'DEP[OÓ]SITO|\\mDEP\\M'::text THEN 'deposito'::text
                     WHEN upper(m.c24) ~ 'TRANSFER|SPEI'::text THEN 'transferencia'::text
                     WHEN upper(m.c24) ~ 'TARJETA|TARJ|TDC|TDD'::text THEN 'tarjeta'::text
                     WHEN upper(m.c24) ~ 'EFECTIVO|EFVO|EFECTICO'::text THEN 'efectivo'::text
                     WHEN upper(m.c24) ~ 'CHEQUE|\\mCHQ\\M'::text THEN 'cheque'::text
                     ELSE 'otro'::text
                 END) AS forma_pago,
             round(COALESCE(NULLIF(regexp_replace(m.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
             'md_'::text || btrim(m.sucursal) AS source_branch,
                 CASE
                     WHEN m.c4 = 5::numeric THEN 'PUE'::text
                     ELSE 'CFDI'::text
                 END AS cobro_clase,
             btrim(m.c45) AS cuenta_tes
            FROM kepler_ods.kdm1 m
              LEFT JOIN LATERAL ( SELECT c.fecha_pago,
                     c.forma_pago_sat
                    FROM analytics.v_kepler_payment_complement c
                   WHERE m.c4 = 7::numeric AND c.sucursal = btrim(m.sucursal) AND c.folio = btrim(m.c6)
                  LIMIT 1) cp ON true
           WHERE btrim(m.c2) = 'U'::text AND btrim(m.c3) = 'A'::text AND (m.c4 = ANY (ARRAY[5::numeric, 7::numeric])) AND btrim(m.c1) = btrim(m.sucursal) AND btrim(COALESCE(m.c43, ''::text)) <> 'C'::text) q
      LEFT JOIN analytics.v_customer_account_kind k ON k.cliente_code = q.cliente_code
      LEFT JOIN commercial.warehouses w ON w.tenant_id = '${M}'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL${joinExtra}
   ORDER BY q.sucursal, q.doc_prefix, q.folio`;

const CON_BANCO = CUERPO(
  `,
     -- [CSU.8] A qué cuenta de tesorería entró el dinero. 'sin_declarar' cuando el documento no
     -- trae cuenta, y 'no_resuelve' cuando la trae pero no existe en el catálogo: dos ausencias
     -- distintas, dos etiquetas — ninguna se dibuja como 'banco'.
     CASE
       WHEN btrim(COALESCE(q.cuenta_tes, ''::text)) = ''::text THEN 'sin_declarar'::text
       ELSE COALESCE(b.tipo, 'no_resuelve'::text)
     END AS medio_cobro,
     b.nombre AS cuenta_tesoreria`,
  `
      LEFT JOIN (${KDB1}
      ) b ON b.clave = q.cuenta_tes`,
);

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS a, to_regclass('kepler_ods.kdb1') AS b`);
  // Sin ODS (entorno de dev pelado) no hay nada que derivar: la vista no existe o no tiene fuente.
  if (!ods.rows[0]?.a || !ods.rows[0]?.b) return;

  const r = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_collections')`);
  if (r.rows[0]?.relkind !== 'v') return;

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(CON_BANCO);
  // El GRANT no sobrevive por sí solo a un replace en todos los casos: se re-aplica siempre.
  await knex.raw('GRANT SELECT ON analytics.erp_collections TO app_runtime');
  // ⛔ `COMMENT ON` es una sentencia de UTILIDAD: no admite parámetros ligados (lección de PVI.4,
  // 2026-10-09). El texto va inlineado.
  await knex.raw(`
    COMMENT ON COLUMN analytics.erp_collections.medio_cobro IS
      '[CSU.8] Clase de la cuenta de tesoreria a la que entro el cobro (caja|banco|puente|sin_declarar|no_resuelve), derivada de kdm1.c45 join kdb1 igual que kepler_bank_movements.tipo_cuenta y erp_supplier_payments.medio_pago. NO confundir con forma_pago, que es como pago el CLIENTE, ni con tipo_cuenta, que es la clase del cliente.'`);
  await knex.raw(`
    COMMENT ON COLUMN analytics.erp_collections.cuenta_tesoreria IS
      '[CSU.8] Nombre de la cuenta (kdb1.c2): el banco del deposito, o CAJA GENERAL cuando el cobro entro en efectivo. NULL cuando medio_cobro es sin_declarar o no_resuelve.'`);
};

/**
 * Rollback: la vista EXACTA de antes, sin las dos columnas ni el join a `kdb1`.
 *
 * ⚠️ Se reconstruye con el MISMO generador que la versión nueva, pasándole cadenas vacías. Derivar
 * el rollback recortando el SQL de arriba con un regex sería un rollback que falla el día que se
 * necesita, y encima en silencio: produciría una vista *parecida*.
 *
 * ⚠️ `cuenta_tes` se queda en el subselect `q` también al revertir. Es una columna interna del
 * `FROM`, no sale en la lista de selección, y dejarla no cambia ni el contrato ni el plan — pero
 * quitarla obligaría a mantener dos cuerpos distintos, que es la forma de que se desincronicen.
 */
exports.down = async function (knex) {
  const r = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_collections')`);
  if (r.rows[0]?.relkind !== 'v') return;

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(CUERPO('', ''));
  await knex.raw('GRANT SELECT ON analytics.erp_collections TO app_runtime');
};
