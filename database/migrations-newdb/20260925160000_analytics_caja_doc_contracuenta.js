/**
 * CS.3.1b — La contra-cuenta del PROPIO documento de caja, derivada de su póliza de Kepler.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 *
 * La captura de Caja General pedía la cuenta/concepto a MANO ("Falta la cuenta y el concepto de
 * Kepler") aunque el movimiento ES un documento de Kepler y su póliza ya trae la contra-cuenta.
 * La medición (2026-09-25, prod read-only) lo confirmó:
 *
 *   · Fuente: `analytics.gl_poliza_lines` con `source='kepler'` (281,173 líneas) = el detalle de
 *     póliza keyed por `tipo_pol` (doc_tipo COMPACTO: X-D-26→XD2601, U-A-5→UA0501, X-D-60→XD6001,
 *     X-A-45→XA4501) + `folio` + `num_movto`=pata. La pata que NO es `102…` (la caja) es la contra.
 *   · 9,189 docs de caja (180 d) → 9,162 ligan (99.7%), 9,161 con UNA contra-cuenta limpia (99.75%).
 *     1 split, 27 sin ligar (recientes/timing). Por tipo: X-D-26 6647/6667 · U-A-5 2480/2486 ·
 *     X-D-60 31/32 · X-A-45 3/3.
 *   · Grano MAYOR (medido): gasto X-D-26 → `201 PASIVO A PROVEEDORES`, cobro U-A-5 → `115 CLIENTES`,
 *     alguno → `103 OTROS INGRESOS`. Es lo que Kepler realmente postea para ese documento → mirror
 *     fiel (ADR-059). Los tres existen en `analytics.v_kepler_conceptos` (el catálogo que valida la
 *     captura): 201→5 conceptos, 115→14, 103→1.
 *
 * ── Qué hace esta vista ──────────────────────────────────────────────────────────────────────
 *
 * Por documento (tenant, sucursal, tipo_pol, folio) devuelve:
 *   · `contra_n` = cuántas contra-cuentas distintas tiene (1 = limpio → se puede fijar; >1 = split,
 *     se declara y cae a manual, nunca se inventa una sola).
 *   · `contra_cuenta` / `contra_cuenta_nombre` = la contra dominante por importe.
 *
 * El consumidor (`cash-ledger.service.ts:resolverCuentas`) la lee POR PÁGINA (whereIn de ~100
 * tuplas) — medido 19 ms — como piso de resolución DESPUÉS de la regla/ruta y ANTES de manual. No
 * se mete en la vista de pendientes ni en el matview: agregar 281k filas en cada carga rompería el
 * gate de <1 s; la consulta batch por página no.
 *
 * `analytics.*` no tiene RLS → el filtro de tenant lo pone el consumidor. Vista plana (la fuente no
 * tiene RLS que invocar). ⛔ Ni un `?` en el SQL (knex lo toma como binding).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const g = await knex.raw(`SELECT to_regclass('analytics.gl_poliza_lines') AS t`);
  if (!g.rows[0] || !g.rows[0].t) return; // entorno sin el GL derivado: nada que derivar

  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_doc_contracuenta`);
  await knex.raw(`
    CREATE VIEW analytics.v_caja_doc_contracuenta AS
    SELECT g.tenant_id,
           g.sucursal,
           g.tipo_pol,
           g.folio,
           count(DISTINCT g.cuenta) FILTER (WHERE left(g.cuenta, 3) <> '102') AS contra_n,
           (array_agg(g.cuenta ORDER BY g.importe DESC NULLS LAST)
              FILTER (WHERE left(g.cuenta, 3) <> '102'))[1]                    AS contra_cuenta,
           (array_agg(g.cuenta_nombre ORDER BY g.importe DESC NULLS LAST)
              FILTER (WHERE left(g.cuenta, 3) <> '102'))[1]                    AS contra_cuenta_nombre
      FROM analytics.gl_poliza_lines g
     WHERE g.source = 'kepler'
     GROUP BY g.tenant_id, g.sucursal, g.tipo_pol, g.folio`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_doc_contracuenta TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_caja_doc_contracuenta IS
    'CS.3.1b — contra-cuenta del propio documento de caja desde su poliza Kepler '
    '(gl_poliza_lines source=kepler, pata NO 102). contra_n=1 => limpio (99.75% medido). '
    'La lee cash-ledger.service por pagina (whereIn ~100), NO por JOIN (rompe gate <1s).'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_doc_contracuenta`);
};
