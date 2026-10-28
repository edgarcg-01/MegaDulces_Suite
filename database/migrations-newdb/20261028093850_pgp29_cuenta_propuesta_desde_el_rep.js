'use strict';
/**
 * `[PGP.29]` (objetivo **O6**) — **La cuenta del proveedor, propuesta desde el comprobante que
 * él mismo timbró.**
 *
 * ── Qué estaba mal ──────────────────────────────────────────────────────────────────────────
 *
 * `/finanzas/cuentas-pago` tiene un botón **«Solicitar cuenta»** que abre un formulario **vacío**:
 * alguien tiene que ir a conseguir la CLABE y teclearla. Por eso el catálogo
 * `commercial.supplier_payment_accounts` tiene **0 filas** (medido el 2026-10-28, sid
 * `7688376744939610156`) y por eso ningún pago del Calendario se prepara solo.
 *
 * ⭐ **El dato ya está en la casa, y no es un dicho: es del propio proveedor.** Cuando nos cobra,
 * timbra un **REP** ante el SAT y declara en él `CtaBeneficiario` — la cuenta a la que quiere
 * que le paguen. Vive en `fiscal.cfdi_payment_links`, y `[PGP.27]` acaba de hacerlo alcanzable
 * para más acreedores al resolver su RFC por nombre.
 *
 * ── Lo medido antes de escribir esto, contra prod ───────────────────────────────────────────
 *
 *  · **63 acreedores** declaran alguna cuenta en su REP.
 *  · **23 traen UNA CLABE de 18 que pasa el dígito de control** → son las proponibles.
 *  · 2 traen **varias** distintas (hay que elegir: no se propone) · 2 no pasan el control.
 *  · ⛔ **36 traen sólo una cuenta de 10 dígitos, que NO es una CLABE** y **no se puede
 *    completar**: le falta la **plaza** (banco 3 + plaza 3 + cuenta 11 + control 1), y tener el
 *    RFC del banco —522 REP lo traen— no alcanza. Ésos siguen necesitando que el proveedor la dé.
 *  · Los 23 cubren **165 documentos · 15 acreedores · $10,251,411** de deuda viva, y **38 de esos
 *    documentos sólo se alcanzan por el RFC que `[PGP.27]` resolvió por nombre**.
 *
 * ── Lo que esta vista NO hace, y es deliberado ──────────────────────────────────────────────
 *
 * ⛔⛔ **No da de alta nada.** Es de **sólo lectura**: propone, con su evidencia, y el alta sigue
 * pasando por `supplier_payment_account_change_requests` — `requested_by` ≠ `decided_by`, nunca
 * alta directa. Cambiar la cuenta de un proveedor es exactamente el movimiento que un fraude
 * necesita, así que **la firma no se automatiza** (misma línea que `[VE.3]`).
 *
 * ⛔ **No inventa el nombre del banco.** No existe en la casa ningún catálogo que traduzca el
 * código de 3 dígitos de la CLABE a un nombre (`finance.bank_accounts` son las NUESTRAS y no
 * guardan CLABE). Se publica el código tal cual y el RFC del banco que el proveedor declaró;
 * el nombre lo pone quien solicita. Inventarlo sería publicar un valor que nadie midió.
 *
 * ⛔ **No elige cuando hay varias.** Si un acreedor declaró dos CLABE válidas distintas, la vista
 * dice `varias` y **no propone ninguna**: elegir la cuenta de un proveedor a cara o cruz es
 * peor que no proponer.
 *
 * Idempotente: sólo `CREATE OR REPLACE VIEW` y `GRANT`. No toca ninguna fila.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * El dígito de control de la CLABE (Banxico): pesos 3·7·1 sobre los 17 primeros, cada producto
 * módulo 10, y el verificador es `(10 - suma % 10) % 10`.
 *
 * ⚠️ Va como subconsulta por fila a propósito: el universo son las **42 cuentas distintas de 18
 * dígitos** que existen, no 170 mil. Sobre un conjunto grande esto habría que rehacerlo.
 */
const CLABE_OK = (col) => `(
  ${col} ~ '^[0-9]{18}$'
  AND ( (10 - (SELECT sum((substr(${col}, g.i, 1)::int * (ARRAY[3,7,1])[((g.i - 1) % 3) + 1]) % 10)
                 FROM generate_series(1, 17) AS g(i)) % 10) % 10 )::int = substr(${col}, 18, 1)::int)`;

const CUERPO = `
WITH reps AS (
  SELECT c.tenant_id, c.emisor_rfc AS rfc, btrim(l.cta_beneficiario) AS cta,
         nullif(btrim(coalesce(l.rfc_banco_beneficiario, '')), '') AS rfc_banco,
         count(*)::int AS veces,
         max(l.fecha_pago)::date AS ultima_vez,
         (array_agg(l.rep_uuid::text ORDER BY l.fecha_pago DESC NULLS LAST))[1] AS rep_uuid
    FROM fiscal.cfdi_payment_links l
    JOIN fiscal.cfdis c ON c.tenant_id = l.tenant_id AND c.uuid = l.rep_uuid
   WHERE c.rol = 'recibidas'
     AND nullif(btrim(coalesce(l.cta_beneficiario, '')), '') IS NOT NULL
   GROUP BY 1, 2, 3, 4),
val AS (
  SELECT r.*, ${CLABE_OK('r.cta')} AS clabe_ok, (r.cta ~ '^[0-9]{18}$') AS tiene_18
    FROM reps r),
-- Una fila por acreedor fiscal (RFC), con el veredicto ya tomado.
porRfc AS (
  SELECT tenant_id, rfc,
         count(*) FILTER (WHERE clabe_ok)::int                       AS n_validas,
         count(DISTINCT cta) FILTER (WHERE clabe_ok)::int            AS distintas_validas,
         count(*) FILTER (WHERE tiene_18 AND NOT clabe_ok)::int      AS n_control_malo,
         count(*) FILTER (WHERE NOT tiene_18)::int                   AS n_no_clabe,
         -- La más declarada; a igualdad, la más reciente. Sólo se usa si hay UNA sola distinta.
         (array_agg(cta        ORDER BY (clabe_ok) DESC, veces DESC, ultima_vez DESC NULLS LAST))[1] AS cta_top,
         (array_agg(rfc_banco  ORDER BY (clabe_ok) DESC, veces DESC, ultima_vez DESC NULLS LAST))[1] AS banco_top,
         (array_agg(rep_uuid   ORDER BY (clabe_ok) DESC, veces DESC, ultima_vez DESC NULLS LAST))[1] AS rep_top,
         max(veces) FILTER (WHERE clabe_ok)                          AS veces_top,
         max(ultima_vez) FILTER (WHERE clabe_ok)                     AS ultima_top,
         (array_agg(cta ORDER BY veces DESC))[1]                     AS cualquiera
    FROM val GROUP BY 1, 2)
-- ⚠️ El tenant sale del lado FISCAL (los CFDI sí lo llevan y RLS ya los acotó); el lado de
--    Kepler (kdxd) no es multi-tenant, así que para un acreedor que nunca timbró un REP se cae
--    al tenant de la sesión. Sin esto la vista no se puede filtrar y el servicio la leería entera.
SELECT coalesce(p.tenant_id, (nullif(current_setting('app.tenant_id', true), ''))::uuid) AS tenant_id,
       r.sucursal,
       r.proveedor_code,
       r.proveedor_nombre,
       r.rfc,
       -- De dónde salió el RFC con el que se busco (PGP.27): no se presenta como dato del ERP
       -- lo que resolvió un cruce de nombre, y quien firma el alta tiene derecho a saberlo.
       r.fuente AS rfc_fuente,
       CASE WHEN p.distintas_validas = 1 THEN 'propuesta'
            WHEN p.distintas_validas > 1 THEN 'varias'
            WHEN p.n_control_malo > 0    THEN 'control_invalido'
            WHEN p.n_no_clabe > 0        THEN 'solo_cuenta_corta'
            ELSE 'sin_rep' END::text AS estado,
       CASE WHEN p.distintas_validas = 1 THEN p.cta_top END AS clabe_propuesta,
       -- El código de banco son los 3 primeros dígitos de la CLABE. Se publica el CODIGO, no un
       -- nombre: no hay catálogo que lo traduzca y no se inventa.
       CASE WHEN p.distintas_validas = 1 THEN left(p.cta_top, 3) END AS banco_codigo,
       CASE WHEN p.distintas_validas = 1 THEN p.banco_top END AS banco_rfc,
       CASE WHEN p.distintas_validas = 1 THEN p.rep_top   END AS rep_uuid,
       CASE WHEN p.distintas_validas = 1 THEN p.veces_top END AS veces_declarada,
       CASE WHEN p.distintas_validas = 1 THEN p.ultima_top END AS ultima_vez,
       -- Lo que NO se pudo proponer dice por qué, con el dato a la vista (ADR-056).
       CASE WHEN p.distintas_validas = 1 THEN NULL
            WHEN p.distintas_validas > 1 THEN 'declaro ' || p.distintas_validas || ' CLABE distintas en sus comprobantes: hay que elegir una, no se propone'
            WHEN p.n_control_malo > 0    THEN 'la cuenta de 18 digitos que declaro (' || coalesce(p.cualquiera, '?') || ') no pasa el digito de control de la CLABE'
            WHEN p.n_no_clabe > 0        THEN 'solo declaro una cuenta de ' || length(coalesce(p.cualquiera, '')) || ' digitos, que no es una CLABE: le falta la plaza y no se puede completar'
            WHEN r.rfc IS NULL           THEN 'no se sabe su RFC, asi que no hay con que buscar su comprobante'
            ELSE 'nunca timbro un comprobante de pago que declare a que cuenta le pagamos'
            END::text AS motivo
  FROM analytics.v_supplier_rfc r
  LEFT JOIN porRfc p ON p.rfc = r.rfc`;

exports.SQL = { CUERPO };

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_supplier_account_proposal AS ${CUERPO}`);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_supplier_account_proposal IS ` +
      `'[PGP.29] La cuenta que el propio proveedor declaro en su REP timbrado (CtaBeneficiario), ` +
      `con el digito de control de la CLABE verificado y su evidencia (rep_uuid, veces, ultima vez). ` +
      `Solo PROPONE: el alta sigue pasando por supplier_payment_account_change_requests. ` +
      `Lo que no se puede proponer dice por que. Derivada: no materializa nada.'`,
  );
  await knex.raw(`GRANT SELECT ON analytics.v_supplier_account_proposal TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_supplier_account_proposal TO dev_ro`);

  // Lo que la migracion movio, dicho en voz alta: si no hay proponibles, algo no quedo.
  const [r] = (await knex.raw(
    `SELECT count(*) FILTER (WHERE estado = 'propuesta')::int AS proponibles,
            count(*) FILTER (WHERE estado = 'solo_cuenta_corta')::int AS cortas,
            count(*) FILTER (WHERE estado = 'varias')::int AS varias
       FROM analytics.v_supplier_account_proposal`,
  )).rows;
  console.log(
    `[PGP.29] cuentas proponibles: ${r.proponibles} · con varias (elegir): ${r.varias} · ` +
      `solo cuenta corta (hay que pedirla): ${r.cortas}`,
  );
  if (Number(r.proponibles) === 0) {
    throw new Error(
      '[PGP.29] cero cuentas proponibles: medido el 2026-10-28 contra prod eran 23. Cero puede ser ' +
        'un defecto del verificador de la CLABE o de la llave contra v_supplier_rfc, y cero por ' +
        'defecto es indistinguible de cero por desuso. Se revierte y se mide antes de reintentar.',
    );
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_account_proposal`);
};
