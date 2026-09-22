'use strict';
/**
 * `[CG.21]` — **De qué responde la caja.**
 *
 * La bandeja «Movimientos de caja por confirmar» entra a `BANDEJAS` en esta misma entrega, y sin
 * su clave en `identity.responsibilities` pasan dos cosas, las dos malas:
 *
 *   1. El candado de biyección de `test-newdb-me-context.js` se pone rojo — una bandeja que
 *      declara una responsabilidad que el catálogo no tiene.
 *   2. Peor: por `[SN.30]` la bandeja no le pertenece a nadie, y una cola sin dueño es una cola
 *      que nadie drena. Es la lección de `[CDRP.3]`: tres commits en prod que no veía ninguna
 *      persona porque el puesto que respondía de ellos tenía **cero** ocupantes.
 *
 * ── A quién se le reparte, y por qué así ─────────────────────────────────────────────────────
 *
 * ⭐ **Derivado del estado vivo, no de una lista escrita a mano.** Se le da a todo puesto cuyo rol
 * por defecto ya trae `FINANCE_CAJA_GESTIONAR` — o sea, a quien la empresa YA autorizó a mover
 * dinero en esta caja. Calcar una lista de puestos sería adivinar, y el precedente existe: la
 * mig `20260902140000` (LC.6.2) tuvo que reparar un módulo entero que llevaba semanas en prod
 * **sin que nadie pudiera abrirlo**, porque su permiso se declaró en el enum y nunca se repartió.
 *
 * ⚠️ Se reparte por PUESTO (`identity.position_responsibilities`), nunca moviendo a una persona
 * de puesto: el puesto arrastra departamento, jerarquía e historial, y ese dato se administra
 * desde `/admin/personas` (regla de Edgar, 2026-08-27 — por UI, para que quede rastro en
 * `identity.user_events`).
 *
 * ⚠️ **Si ningún puesto califica, esta migración NO inventa uno.** Loguea que la clave quedó sin
 * dueño y sigue. Una responsabilidad repartida a un puesto elegido por el programador es
 * exactamente el default disfrazado que ADR-056 prohíbe — y acá el default movería dinero.
 *
 * ⛔ El permiso NO se toca: `FINANCE_CAJA_VER`/`_GESTIONAR` ya existen y ya están repartidos. Esto
 * declara de quién ES el trabajo, que es una pregunta distinta de quién PUEDE abrirlo.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'finanzas.caja';
const LABEL = 'Caja: movimientos por confirmar';
const DESC =
  'Lo que Kepler ya registró en una caja de efectivo y el libro de caja todavía no aplicó, '
  + 'los dos signos. Se confirma, no se teclea: el importe sale del documento del ERP.';
/** El permiso que decide quién la opera. Si lo tiene el rol del puesto, el puesto responde. */
const PERMISO = 'FINANCE_CAJA_GESTIONAR';

exports.up = async function up(knex) {
  await knex.raw(
    `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
     VALUES (?, ?, ?, NULL, 41)
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                     dimension = EXCLUDED.dimension, orden = EXCLUDED.orden`,
    [KEY, LABEL, DESC],
  );
  console.log(`  [CG.21] catálogo: "${KEY}" declarada`);

  // ⛔ `permissions -> 'CLAVE'`, NUNCA el operador `?` de JSONB: knex se lo come como binding y
  // revienta con "Expected 0 bindings, saw 1". Está documentado en CLAUDE.md y ya cobró antes.
  // La clave va embebida (es una constante de este archivo, no entrada de usuario) para que el
  // SQL no lleve ni un signo de interrogación.
  const puestos = await knex.raw(`
    SELECT DISTINCT p.tenant_id, p.code
      FROM identity.positions p
      JOIN role_permissions rp
        ON rp.role_name = COALESCE(p.default_role_name, '')
     WHERE p.deleted_at IS NULL
       AND (rp.permissions ->> '${PERMISO}') = 'true'`);

  const filas = puestos.rows ?? [];
  if (!filas.length) {
    console.log(
      `  [CG.21] ⚠️ NINGÚN puesto tiene ${PERMISO} en su rol por defecto: la clave queda SIN DUEÑO.`,
    );
    console.log(
      '  [CG.21]    La bandeja existe y se abre por permiso, pero no le pertenece a nadie. '
      + 'Hay que asignarla desde /admin/personas.',
    );
    return;
  }

  for (const { tenant_id, code } of filas) {
    const ya = await knex('identity.position_responsibilities')
      .where({ tenant_id, position_code: code, responsibility_key: KEY })
      .whereNull('deleted_at')
      .first();
    if (ya) {
      console.log(`  [CG.21] ${code} ya responde de "${KEY}" — sin cambios`);
      continue;
    }
    await knex('identity.position_responsibilities').insert({
      tenant_id,
      position_code: code,
      responsibility_key: KEY,
      es_principal: false,
    });
    const n = await knex('identity.users')
      .where({ tenant_id, position_code: code })
      .whereNull('deleted_at')
      .count({ n: '*' })
      .first();
    console.log(`  [CG.21] ${code} → ${KEY}  (${n && n.n ? n.n : 0} persona(s) en ese puesto hoy)`);
  }
};

exports.down = async function down(knex) {
  await knex('identity.position_responsibilities').where({ responsibility_key: KEY }).del();
  await knex('identity.responsibilities').where({ key: KEY }).del();
};
