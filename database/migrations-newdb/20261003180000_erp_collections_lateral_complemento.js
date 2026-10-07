/**
 * `[IG.12]` El indice no alcanzaba: el join vivia donde ningun indice puede entrar.
 *
 * Esta es la SEGUNDA mitad del arreglo de la pestana "Cuadra" (la primera es 20261003170000, el
 * indice). Y la leccion esta en que la primera, sola, **no movio ni un milisegundo**:
 *
 *     sin indice ....................... 93,348 ms
 *     con el indice, vista sin tocar ... 90,539 ms   <-- el plan seguia con Seq Scan
 *     con indice + esta migracion ......    314 ms
 *
 * -- POR QUE EL INDICE SOLO NO SERVIA -------------------------------------------------------
 * analytics.erp_collections hacia:
 *
 *     LEFT JOIN analytics.v_kepler_payment_complement cp
 *       ON m.c4 = 7 AND cp.sucursal = btrim(m.sucursal) AND cp.folio = btrim(m.c6)
 *
 * "cp" es una VISTA y esta del lado ANULABLE de un LEFT JOIN. Cuando Postgres sube una subconsulta
 * asi, sus columnas calculadas (btrim(p.c1), btrim(p.c3)) no quedan como expresiones de la tabla:
 * quedan como **PlaceHolderVar**, porque tienen que poder valer NULL cuando el join no casa. Y un
 * PlaceHolderVar **no puede ser condicion de indice**. Por eso el plan mostraba el join como
 * "Join Filter" y no como "Index Cond", y por eso recorria kdfe33pagm1 entero (3,613 filas) por
 * cada uno de los 27,410 cobros = 99 millones de comparaciones con btrim de los dos lados.
 *
 * ⭐ *Un indice no se usa por existir: se usa si la consulta lo deja alcanzable.*
 *
 * -- QUE CAMBIA -----------------------------------------------------------------------------
 * El mismo join, escrito como LEFT JOIN LATERAL con los predicados DENTRO de la subconsulta. Ahi
 * no hay PlaceHolderVar: son quals propios de la subconsulta, bajan hasta kepler_ods.kdfe33pagm1 y
 * el plan pasa a "Index Scan using ix_kdfe33pagm1_cobro ... Index Cond: (btrim(c1) =
 * btrim(m.sucursal) AND btrim(c3) = btrim(m.c6))". De paso el "m.c4 = 7" entra a la subconsulta,
 * asi que los **24,583 cobros PUE** (de 27,410) ni siquiera la ejecutan: solo los 2,827 con
 * complemento de pago.
 *
 * El LIMIT 1 es lo que impide que el planner vuelva a aplanar la subconsulta -- y es exacto, no
 * una heuristica: (sucursal, folio) es **unica** en el complemento (2,826 filas, 2,826 llaves),
 * medido antes de escribir esto.
 *
 * -- EL CANDADO: no es "el total da igual", es LA VISTA ENTERA FILA POR FILA -----------------
 * Medido contra prod, sobre TODA la historia, con EXCEPT ALL en las dos direcciones y las 14
 * columnas estables (todas menos computed_at, que es now()):
 *
 *     filas nueva 27,410 · filas vieja 27,410 · solo en nueva 0 · solo en vieja 0
 *
 * Comparar solo el total habria dejado pasar una compensacion entre filas. El cobro del rango por
 * defecto da $141,865,179.26 en las dos, al centavo.
 *
 * ⚠️ CREATE OR REPLACE VIEW: se re-aplican GRANTs a proposito (ADR-057 ya cobro una vez que no se
 * heredan). El ACL de origen, medido: app_runtime=r, dev_ro=r, duenio postgres, SIN reloptions
 * (esta vista NO es security_invoker, al reves que su hermana v_kepler_payment_complement).
 *
 * ⚠️ String.raw y no una plantilla comun: el cuerpo trae \mDEP\M y \mCHQ\M (limites de palabra de
 * la regex POSIX). En un template literal normal JS se come las barras y queda "mDEPM", que **no
 * falla**: clasifica mal el medio de pago y nadie se entera.
 *
 * @param { import("knex").Knex } knex
 */

const SELECCION = String.raw`
 SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio) '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    q.sucursal, q.folio, q.doc_prefix, q.cobro_date, q.cliente_code, q.cliente_nombre,
    q.concepto, q.forma_pago, q.monto,
    COALESCE(k.kind, analytics.customer_account_kind_by_code(q.cliente_code), 'cliente_final'::text) AS tipo_cuenta,
    q.source_branch, now() AS computed_at, w.id AS warehouse_id, q.cobro_clase
   FROM ( SELECT btrim(m.sucursal) AS sucursal,
            btrim(m.c6) AS folio,
            ('UA'::text || lpad(m.c4::text, 2, '0'::text)) || lpad(m.c5::text, 2, '0'::text) AS doc_prefix,
                CASE WHEN m.c4 = 7::numeric THEN COALESCE(cp.fecha_pago, m.c9::date)
                     ELSE m.c9::date END AS cobro_date,
            NULLIF(btrim(m.c10), ''::text) AS cliente_code,
            NULLIF(btrim(m.c32), ''::text) AS cliente_nombre,
            NULLIF(btrim(m.c24), ''::text) AS concepto,
            COALESCE(
                CASE cp.forma_pago_sat
                    WHEN '01'::text THEN 'efectivo'::text
                    WHEN '02'::text THEN 'cheque'::text
                    WHEN '03'::text THEN 'transferencia'::text
                    ELSE NULL::text END,
                CASE WHEN upper(m.c24) ~ 'DEP[OÓ]SITO|\mDEP\M'::text THEN 'deposito'::text
                     WHEN upper(m.c24) ~ 'TRANSFER|SPEI'::text THEN 'transferencia'::text
                     WHEN upper(m.c24) ~ 'TARJETA|TARJ|TDC|TDD'::text THEN 'tarjeta'::text
                     WHEN upper(m.c24) ~ 'EFECTIVO|EFVO|EFECTICO'::text THEN 'efectivo'::text
                     WHEN upper(m.c24) ~ 'CHEQUE|\mCHQ\M'::text THEN 'cheque'::text
                     ELSE 'otro'::text END) AS forma_pago,
            round(COALESCE(NULLIF(regexp_replace(m.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
            'md_'::text || btrim(m.sucursal) AS source_branch,
                CASE WHEN m.c4 = 5::numeric THEN 'PUE'::text ELSE 'CFDI'::text END AS cobro_clase
           FROM kepler_ods.kdm1 m
           __JOIN__
          WHERE btrim(m.c2) = 'U'::text AND btrim(m.c3) = 'A'::text AND (m.c4 = ANY (ARRAY[5::numeric, 7::numeric])) AND btrim(m.c1) = btrim(m.sucursal) AND btrim(COALESCE(m.c43, ''::text)) <> 'C'::text) q
     LEFT JOIN analytics.v_customer_account_kind k ON k.cliente_code = q.cliente_code
     LEFT JOIN commercial.warehouses w ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL
  ORDER BY q.sucursal, q.doc_prefix, q.folio`;

// El unico renglon que cambia. El de antes queda escrito para que down() lo pueda devolver.
const JOIN_LATERAL = String.raw`LEFT JOIN LATERAL (
                  SELECT c.fecha_pago, c.forma_pago_sat
                    FROM analytics.v_kepler_payment_complement c
                   WHERE m.c4 = 7::numeric
                     AND c.sucursal = btrim(m.sucursal)
                     AND c.folio    = btrim(m.c6)
                   LIMIT 1) cp ON true`;

const JOIN_VIEJO = String.raw`LEFT JOIN analytics.v_kepler_payment_complement cp
                  ON m.c4 = 7::numeric AND cp.sucursal = btrim(m.sucursal) AND cp.folio = btrim(m.c6)`;

/**
 * Reemplaza el cuerpo y deja los permisos como estaban.
 *
 * ⚠️ replace() con FUNCION de reemplazo, no con el string pelado: el texto a insertar trae "$" y
 * en JS "$'" dentro de un reemplazo significa "todo lo que viene despues del match" -- ya duplico
 * un cuerpo de SQL entero en esta misma fase.
 */
async function definir(knex, join) {
  await knex.raw('CREATE OR REPLACE VIEW analytics.erp_collections AS' + SELECCION.replace('__JOIN__', () => join));
  await knex.raw('GRANT SELECT ON analytics.erp_collections TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.erp_collections TO dev_ro');
}

exports.up = async function up(knex) {
  await definir(knex, JOIN_LATERAL);

  // El indice hermano es lo que vuelve barato este LATERAL. Sin el esto sigue siendo un seq scan
  // por fila: se comprueba que exista Y que este VALIDO, porque un indice invalido se ve presente.
  const { rows: [ix] } = await knex.raw(
    "SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid"
    + " WHERE c.relname = 'ix_kdfe33pagm1_cobro'");
  if (!ix || !ix.indisvalid) {
    throw new Error(
      'Falta ix_kdfe33pagm1_cobro valido (migracion 20261003170000). Sin el, el LATERAL recorre '
      + 'kdfe33pagm1 entero por cada cobro y la pestana Cuadra sigue arriba de 90 s.');
  }

  const { rows: [acl] } = await knex.raw(
    "SELECT has_table_privilege('app_runtime','analytics.erp_collections','SELECT') AS app,"
    + " has_table_privilege('dev_ro','analytics.erp_collections','SELECT') AS ro");
  if (!acl.app || !acl.ro) throw new Error('erp_collections quedo sin los GRANT de lectura.');
  console.log('  ✓ analytics.erp_collections con LATERAL · indice valido · GRANTs puestos');
};

exports.down = async function down(knex) { await definir(knex, JOIN_VIEJO); };
