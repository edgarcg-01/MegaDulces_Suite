/**
 * `[CC.13]` **`analytics.erp_collections` no contaba un tipo de cobro entero.**
 *
 * La vista canónica de cobros filtraba `c4 = 5` (**Cobro PUE**) y dejaba fuera `c4 = 7`
 * (**Cobro CFDI**), que el catálogo `kdmm` declara como cobro con todas las letras:
 *
 *     U-A-5-1   Cobro PUE
 *     U-A-7-1   Cobro CFDI                 <- quedaba fuera
 *     U-A-7-2   Cobro efectivo CFDI 16%    <- quedaba fuera
 *     U-A-21    Nota Créd/Dev              <- NO es cobro, sigue fuera (bien)
 *     U-A-25    Nota Créd/Dev NoFis        <- NO es cobro
 *     U-A-50    Recepción Traspaso Suc     <- NO es cobro
 *
 * Estaba anotado como diferido en Fase CC («grupo 7 Cobro CFDI») y nadie volvió a mirarlo
 * mientras **crecía ×6 en tres meses**: medido contra prod el 2026-09-24, días 1–24 de cada mes,
 * **$0.86M (jul) → $1.87M (ago) → $5.14M (sep)**. Toda la cartera, la cobranza y la
 * conciliación bancaria lo ignoraban, así que sus cobros aparecían como *«abonos sin cobro»*
 * aunque Kepler los tuviera registrados.
 *
 * Entra: **2,624 cobros vivos por $10,460,000** (+9% de documentos, **+2.3% del dinero**).
 * ⛔ **Esto NO cierra la brecha de ~$14M/mes** contra la línea base mayo–julio. Son dos cosas
 * distintas y no se mezclan: ésta es una omisión nuestra; aquélla sigue sin explicar.
 *
 * ── LO QUE HUBO QUE ARREGLAR PARA PODER AGREGARLO ────────────────────────────────────────
 *
 * **1. La vista clavaba `sucursal = '00'`.** El Cobro PUE sólo existe en oficinas, así que el
 * literal nunca molestó; el Cobro CFDI vive en las sucursales **01, 02, 05 y 06**. Ahora la
 * sucursal sale del dato.
 *
 * **2. ⛔ Réplicas.** `kdm1.c1` es la sucursal DUEÑA y `sucursal` la base de la que se leyó:
 * cuando difieren, la fila es una **réplica de otra sucursal**. Medido: **787 documentos por
 * $0.51M** llegan de la base de la `03` perteneciendo a la `02`. Sin `btrim(c1) = btrim(sucursal)`
 * se duplicaban. (Ya estaba avisado para `kdfe33pagm1` — vale igual acá.)
 *
 * **3. ⛔ `DISTINCT ON (sucursal, folio)` sin el doctype.** En Kepler **el folio NO es único
 * entre doctypes**: con dos doctypes en la misma vista, un `UA0501` y un `UA0701` del mismo
 * folio se pisaban y uno desaparecía en silencio. Ahora la llave lleva `doc_prefix`.
 *
 * **4. La fecha del Cobro CFDI no está en la póliza.** `kdm1.c9` es el día en que se TECLEÓ;
 * la fecha real del pago vive en el complemento de pago SAT (`analytics.v_kepler_payment_complement`,
 * `fecha_pago`). Medido: **2,618 de 2,624 (99.8%) tienen complemento y 652 traen una fecha
 * distinta**. Sin esto, 652 cobros quedaban fechados mal.
 *
 * **5. ⭐ La `forma_pago` del CFDI deja de adivinarse.** Para el PUE se infiere con un regex
 * sobre el concepto capturado a mano (por eso el 70% cae en `'otro'`); el CFDI trae la **forma
 * de pago declarada al SAT** (`01` efectivo · `02` cheque · `03` transferencia). Se usa el dato
 * cuando existe y se cae al regex cuando no.
 *
 * **6b. ⛔ 144 cobros PUE vivían fuera de oficinas y la vista los escondía.** El literal
 * `sucursal = '00'` tapaba **137 cobros en la sucursal 02 ($348,942.50, nov-2025 → dic-2026) y
 * 7 en la 03 ($312,800.07, ene-2026)**: $661,742.57 de cobranza real que nadie contaba. Y son
 * los que hacen chocar el folio con los `UA0701` de la misma plaza — de ahí el punto 3.
 *
 * **6. ⛔ `tipo_cuenta` tenía una copia INLINE del clasificador, y estaba ROTA.** La regex
 * almacenada en prod decía `'^(RUTA|R\.$1[DV]\.$2|R[DV][\s\-0-9])'`: esos `$1`/`$2` son
 * **signos de interrogación que knex convirtió en placeholders** y quedaron horneados en la
 * vista. Medido: **504 cobros salían como `cliente_final` siendo de RUTA**. `[CXC.25]` ya había
 * creado el resolvedor único `analytics.v_customer_account_kind` para que esta clasificación
 * tuviera un solo dueño; la vista seguía con su copia. Ahora la LEE de ahí (derive-no-copy) y el
 * `CASE` que queda es sólo el respaldo para un código que el resolvedor no conozca.
 *
 * ── LO QUE CAMBIA EN LAS CIFRAS PUBLICADAS ───────────────────────────────────────────────
 *   +2,768 documentos / +$11,117,209.85 en total, repartidos asi:
 *       +2,624 cobros / +$10,455,467.28  Cobro CFDI, que no se contaba
 *         +144 cobros /    +$661,742.57  PUE fuera de oficinas, que el literal '00' tapaba
 *          504 cobros pasan de `cliente_final` a `ruta`  (el clasificador roto)
 *          229 cobros pasan de `cliente_final` a `ruta`  (no estaban en el catalogo del
 *                                                         resolvedor; los clasifica su funcion)
 *          652 cobros CFDI cambian de fecha (la real, del complemento SAT)
 *   Totales medidos contra prod: 23,834 -> 26,602 documentos, $455,408,007.15 -> $466,525,217.00
 *
 * ⚠️ `doc_prefix` deja de ser la constante `'UA0501'`: los consumidores que lo escribían como
 * literal en `finance.bank_recon_matches` tienen que escribir el del renglón.
 */

/** La definición nueva. Sin un solo `?`: knex lo toma como binding aunque viva dentro de una regex. */
const VIEW_SQL = `
CREATE OR REPLACE VIEW analytics.erp_collections AS
SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio)
    '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    q.sucursal,
    q.folio,
    q.doc_prefix,
    q.cobro_date,
    q.cliente_code,
    q.cliente_nombre,
    q.concepto,
    q.forma_pago,
    q.monto,
    -- [CC.13] El tipo de cuenta lo dice el resolvedor unico de [CXC.25]. Cuando el codigo NO
    -- esta en su catalogo se llama a SU PROPIA FUNCION -- nunca se re-implementa la regla aca,
    -- que es justo el pecado que esta migracion viene a borrar.
    -- Medido: 229 filas no estan en el catalogo del resolvedor y las 229 son de RUTA. Con un
    -- CASE de respaldo casero salian como 'cliente_final'. COALESCE evalua perezoso, asi que la
    -- funcion solo corre para esas 229.
    COALESCE(k.kind,
             analytics.customer_account_kind_by_code(q.cliente_code),
             'cliente_final') AS tipo_cuenta,
    q.source_branch,
    now() AS computed_at,
    w.id AS warehouse_id,
    -- [CC.13] Que clase de cobro es. Se DECLARA en vez de esconderse detras del filtro: un
    -- consumidor que de verdad necesite solo PUE ahora tiene como pedirlo, y se le ve pedirlo.
    q.cobro_clase
   FROM ( SELECT
            btrim(m.sucursal) AS sucursal,
            btrim(m.c6) AS folio,
            'UA' || lpad(m.c4::text, 2, '0') || lpad(m.c5::text, 2, '0') AS doc_prefix,
            -- La fecha REAL del pago: para el CFDI vive en el complemento SAT, no en la poliza.
            CASE WHEN m.c4 = 7 THEN COALESCE(cp.fecha_pago::date, m.c9::date)
                 ELSE m.c9::date END AS cobro_date,
            NULLIF(btrim(m.c10), '') AS cliente_code,
            NULLIF(btrim(m.c32), '') AS cliente_nombre,
            NULLIF(btrim(m.c24), '') AS concepto,
            COALESCE(
              -- 1) Lo que se le declaro al SAT (solo existe para el Cobro CFDI).
              CASE cp.forma_pago_sat
                WHEN '01' THEN 'efectivo'
                WHEN '02' THEN 'cheque'
                WHEN '03' THEN 'transferencia'
                ELSE NULL
              END,
              -- 2) El regex sobre el concepto tecleado a mano. Su cajon 'otro' es el ELSE, o sea
              --    "el texto no trajo la palabra" -- NUNCA significa "sin ficha" (ver [CC.8]).
              CASE
                WHEN upper(m.c24) ~ 'DEP[OÓ]SITO|\\mDEP\\M'     THEN 'deposito'
                WHEN upper(m.c24) ~ 'TRANSFER|SPEI'             THEN 'transferencia'
                WHEN upper(m.c24) ~ 'TARJETA|TARJ|TDC|TDD'      THEN 'tarjeta'
                WHEN upper(m.c24) ~ 'EFECTIVO|EFVO|EFECTICO'    THEN 'efectivo'
                WHEN upper(m.c24) ~ 'CHEQUE|\\mCHQ\\M'          THEN 'cheque'
                ELSE 'otro'
              END) AS forma_pago,
            round(COALESCE(NULLIF(regexp_replace(m.c16::text, '[^0-9.-]', '', 'g'), '')::numeric,
                           0::numeric), 2) AS monto,
            'md_' || btrim(m.sucursal) AS source_branch,
            CASE WHEN m.c4 = 5 THEN 'PUE' ELSE 'CFDI' END AS cobro_clase
           FROM kepler_ods.kdm1 m
           LEFT JOIN analytics.v_kepler_payment_complement cp
             ON m.c4 = 7
            AND cp.sucursal = btrim(m.sucursal)
            AND cp.folio = btrim(m.c6)
          WHERE btrim(m.c2) = 'U' AND btrim(m.c3) = 'A'
            AND m.c4 IN (5, 7)
            -- Replica de otra sucursal: c1 es la DUEÑA. 787 documentos de la 03 son de la 02.
            AND btrim(m.c1) = btrim(m.sucursal)
            AND btrim(COALESCE(m.c43, '')) <> 'C') q
     LEFT JOIN analytics.v_customer_account_kind k ON k.cliente_code = q.cliente_code
     LEFT JOIN commercial.warehouses w
            ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
           AND w.code::text = q.sucursal
           AND w.deleted_at IS NULL
  ORDER BY q.sucursal, q.doc_prefix, q.folio`;

/**
 * La definición anterior, para el rollback. ⚠️ Se restaura el alcance viejo (sólo PUE, sólo
 * oficinas) pero **NO el regex roto**: volver a hornear `$1`/`$2` sería reintroducir un defecto
 * medido a propósito. El cuantificador va como `{0,1}`, que es lo mismo que `?` sin que knex lo
 * confunda con un binding.
 */
const VIEW_SQL_PREV = `
CREATE OR REPLACE VIEW analytics.erp_collections AS
SELECT DISTINCT ON (q.sucursal, q.folio)
    '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    q.sucursal, q.folio, q.doc_prefix, q.cobro_date, q.cliente_code, q.cliente_nombre,
    q.concepto, q.forma_pago, q.monto, q.tipo_cuenta,
    'md_00'::text AS source_branch, now() AS computed_at, w.id AS warehouse_id,
    'PUE'::text AS cobro_clase
   FROM ( SELECT '00'::text AS sucursal,
            btrim(m.c6) AS folio,
            'UA0501'::text AS doc_prefix,
            m.c9::date AS cobro_date,
            NULLIF(btrim(m.c10), '') AS cliente_code,
            NULLIF(btrim(m.c32), '') AS cliente_nombre,
            NULLIF(btrim(m.c24), '') AS concepto,
            CASE
              WHEN upper(m.c24) ~ 'DEP[OÓ]SITO|\\mDEP\\M'     THEN 'deposito'
              WHEN upper(m.c24) ~ 'TRANSFER|SPEI'             THEN 'transferencia'
              WHEN upper(m.c24) ~ 'TARJETA|TARJ|TDC|TDD'      THEN 'tarjeta'
              WHEN upper(m.c24) ~ 'EFECTIVO|EFVO|EFECTICO'    THEN 'efectivo'
              WHEN upper(m.c24) ~ 'CHEQUE|\\mCHQ\\M'          THEN 'cheque'
              ELSE 'otro'
            END AS forma_pago,
            round(COALESCE(NULLIF(regexp_replace(m.c16::text, '[^0-9.-]', '', 'g'), '')::numeric,
                           0::numeric), 2) AS monto,
            CASE
              WHEN btrim(m.c10) ~* '^(RUTA|R\\.{0,1}[DV]\\.{0,1}|R[DV][[:space:]0-9-])' THEN 'ruta'
              WHEN btrim(m.c10) ~ '^[0-9]{2}-[0-9]{2}' THEN 'interno'
              ELSE 'cliente_final'
            END AS tipo_cuenta
           FROM kepler_ods.kdm1 m
          WHERE m.c2 = 'U' AND m.c3 = 'A' AND btrim(m.c4::text) = '5'
            AND m.sucursal = '00' AND btrim(m.c1) = '00'
            AND btrim(COALESCE(m.c43, '')) <> 'C') q
     LEFT JOIN commercial.warehouses w
            ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
           AND w.code::text = q.sucursal
           AND w.deleted_at IS NULL
  ORDER BY q.sucursal, q.folio`;

/**
 * `[CC.13]` **La vista de Caja General cuelga de ésta, y se la CONGELA en lo que hace hoy.**
 *
 * `finance.v_caja_ingresos_pendientes` (Caja General) lee `analytics.erp_collections` y usa
 * `sucursal || '|' || folio` como `origen_ref` contra `finance.cash_ledger`. Con la vista
 * ampliada ganaría **+2,768 renglones de ingreso pendiente** que nadie pidió, y su llave
 * quedaría **ambigua** en los 137 folios que existen como los dos doctypes.
 *
 * ⛔ No se arregla su llave acá: `cash_ledger.origen_ref` ya tiene filas escritas con el
 * formato viejo, y cambiarlo las dejaría huérfanas. Se le pone el alcance que tenía de hecho
 * —PUE de oficinas— para que **su salida no se mueva ni un renglón**, y queda declarado como
 * decisión de Caja General si quieren ver también el Cobro CFDI (`[CC.13.2]` en el tracker).
 *
 * *Ampliar una vista canónica es correcto; arrastrar a un consumidor a un cambio que no pidió,
 * no.*
 */
const VIEW_CAJA_SQL = `
CREATE OR REPLACE VIEW finance.v_caja_ingresos_pendientes AS
SELECT tenant_id, sucursal, folio,
    (sucursal || '|'::text) || folio AS origen_ref,
    cobro_date, cliente_code, cliente_nombre, concepto, monto, tipo_cuenta, forma_pago
   FROM analytics.erp_collections c
  WHERE tenant_id = current_tenant_id()
    AND monto > 0::numeric
    -- [CC.13] Alcance CONGELADO al que tenia antes de incorporar el Cobro CFDI. Sin esto,
    -- Caja General estrena 2,768 renglones sin que nadie lo haya pedido.
    AND c.cobro_clase = 'PUE'
    AND c.sucursal = '00'
    AND NOT (EXISTS ( SELECT 1
           FROM finance.cash_ledger l
          WHERE l.tenant_id = c.tenant_id AND l.origen_tipo = 'cobro'::text
            AND l.origen_ref = ((c.sucursal || '|'::text) || c.folio)
            AND l.deleted_at IS NULL AND l.estado <> 'cancelado'::text))`;

/**
 * Se re-aplica el `GRANT` por defensa (ADR-057: tras recrear una vista los permisos se pierden
 * con facilidad y sólo lo ve una aserción de metadata).
 *
 * ⛔ **NO se toca `security_invoker`.** Medido antes de escribir esto: `erp_collections` **no
 * lo tiene** (`reloptions` vacío) y ponerlo cambiaría con qué privilegios corre la vista. Es un
 * cambio de comportamiento que nadie pidió y que se paga en producción, no en el diff.
 *
 * ⚠️ La vista anida `analytics.v_kepler_payment_complement`, que **sí** es `security_invoker`:
 * o sea que el lector necesita permiso sobre lo de abajo. Verificado contra prod antes de
 * cablearlo — `app_runtime` tiene SELECT sobre `kdm1`, `kdfe33pagm1`, la vista del complemento y
 * `commercial.warehouses`. Si alguna vez deja de tenerlo, la vista falla con *permission denied*,
 * no con filas de menos.
 */
async function reaplicarPermisos(knex) {
  await knex.raw('GRANT SELECT ON analytics.erp_collections TO app_runtime');
}

exports.up = async function up(knex) {
  await knex.raw(VIEW_SQL);
  await reaplicarPermisos(knex);
  await knex.raw(VIEW_CAJA_SQL);
};

exports.down = async function down(knex) {
  await knex.raw(VIEW_SQL_PREV);
  await reaplicarPermisos(knex);
};
