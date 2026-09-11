'use strict';
/**
 * `[OR.0]` — Cerrar el catálogo de puestos: la oficina existía como gente, no como puesto.
 *
 * ── El hueco, medido en prod (2026-09-11) ───────────────────────────────────────────────────
 * De 100 personas (`kind='interno'`, activas), **41 no tienen puesto**. Partidas por qué tan
 * derivable es su puesto a partir de (rol + departamento):
 *
 *     14  derivable   -> un único puesto candidato; los arregla el backfill de `[OR.1]`
 *      5  ambiguo     -> 3 con 2 candidatos, 2 con 4
 *     22  SIN CANDIDATO -> su rol no lo propone NINGÚN puesto de su departamento
 *
 * La foto que lo explica: **`administracion` tiene 17 personas y exactamente 4 puestos**
 * (`auxiliar_mkt`, `auxiliar_administrativo`, `auxiliar_rh`, `intendencia`) — ninguno de
 * contabilidad, finanzas, tesorería ni crédito y cobranza. El catálogo se canonicalizó del
 * ORGANIGRAMA 2026 (`[UN.1]`), y ese PDF describe **el campo y la tienda**. La oficina nunca entró.
 *
 * ── De dónde salen estos 11 puestos, y por qué NO es inventarlos ────────────────────────────
 * No se deducen de un organigrama nuevo: se derivan del **rol que esas personas ya tienen** en
 * `identity.users.role_name`. Los 22 sin candidato se agrupan en 13 roles, y el rol ya nombra el
 * oficio (`contabilidad`, `tesoreria`, `gerente_compras`, …). Los 12 roles usados acá se
 * verificaron uno por uno contra `identity.role_permissions`: **los 12 existen y están vivos**.
 *
 * ⚠️ Por eso `org_labels` queda **vacío** en los 12, a diferencia de los 43 originales: esas
 * etiquetas son la trazabilidad de la canonicalización del PDF (59 variantes -> 43 puestos), y
 * estos puestos NO vienen del PDF. Poner una etiqueta inventada ahí rompería justo lo que esa
 * columna sirve para probar.
 *
 * ── ⭐ La corrección que resuelve cuatro personas con una fila ───────────────────────────────
 * `auxiliar_mkt` propone hoy `default_role = 'administrativo'`, que no es lo que hace ese puesto.
 * Al cambiarlo a `'marketing'` pasan DOS cosas:
 *   (a) `fer_zambrano` (rol `marketing`) deja de estar huérfano;
 *   (b) los **3 `administrativo` ambiguos** dejan de serlo — hoy dudan entre `auxiliar_mkt` y
 *       `auxiliar_administrativo`, y al liberar el primero les queda un único candidato.
 * Es decir: 22 sin candidato + 3 ambiguos -> 19 + 0 con un solo `UPDATE`.
 *
 * ── Lo que esta migración NO resuelve, y se DECLARA (ADR-056) ────────────────────────────────
 * Quedan **3 personas** que ningún puesto puede cubrir sin una decisión humana. No se les inventa
 * un puesto "parecido": eso les daría responsabilidades que nadie eligió.
 *   · `claudia_mata`  — rol `supervisor`, **sin departamento**. Sin depto no hay candidato posible
 *                       (el candidato se busca dentro del departamento).
 *   · `brian_zavala`  — rol `almacenista`, 4 candidatos (`almacenista`, `auxiliar_almacen`,
 *   · `luis_navarro`     `bodeguero`, `surtidor`). Elegir por ellos sería adivinar.
 * La corrida los imprime por nombre. **Que se sigan contando es la prueba negativa de esta etapa.**
 *
 * ── Qué NO toca ─────────────────────────────────────────────────────────────────────────────
 *  · Ninguna persona. Cero UPDATE sobre `identity.users` — el backfill es `[OR.1]`.
 *  · `scope_axis` queda NULL en los 12: `[ID.24.2]` lo resuelve como
 *    `coalesce(positions.scope_axis, departments.scope_axis)` y los 13 departamentos ya lo
 *    declaran. Escribirlo acá sería un override sin motivo, y crearía la segunda fuente de verdad
 *    que `[ID.15]` evitó a propósito con `default_scope`.
 *  · Permisos. Un puesto no otorga nada; propone.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * [code, nombre, department_code, default_role]
 * El rol se resuelve contra el catálogo VIVO antes de escribirlo (FK compuesta
 * `positions_default_role_fk` -> `identity.role_permissions (tenant_id, role_name)`).
 */
const PUESTOS_OFICINA = [
  // Administración — el bloque que no existía
  ['auxiliar_contabilidad', 'Auxiliar de contabilidad', 'administracion', 'contabilidad'],
  ['auxiliar_credito_cobranza', 'Auxiliar de crédito y cobranza', 'administracion', 'credito_cobranza'],
  ['jefe_finanzas', 'Jefe de finanzas', 'administracion', 'finanzas'],
  ['auxiliar_finanzas', 'Auxiliar de finanzas', 'administracion', 'finanzas_operativo'],
  ['tesoreria', 'Tesorería', 'administracion', 'tesoreria'],
  ['jefe_marketing', 'Jefe de mercadotecnia', 'administracion', 'jefe_marketing'],
  // Operaciones
  ['comprador', 'Comprador', 'operaciones', 'compras'],
  ['gerente_compras', 'Gerente de compras', 'operaciones', 'gerente_compras'],
  ['prevencion', 'Prevención de pérdidas', 'operaciones', 'prevencion'],
  ['auxiliar_prevencion', 'Auxiliar de prevención', 'operaciones', 'prevencion_auxiliar'],
  // Logística
  ['repartidor', 'Repartidor', 'logistica', 'repartidor'],
];

/** El puesto que ya existía y sólo proponía mal. [code, rol_viejo, rol_nuevo] */
const CORRECCION = ['auxiliar_mkt', 'administrativo', 'marketing'];

/** Las 3 que quedan fuera a propósito. Se imprimen para que nadie las dé por resueltas. */
const DECLARADAS = ['claudia_mata', 'brian_zavala', 'luis_navarro'];

/** Cuenta las personas sin puesto partidas por cuántos candidatos tienen. */
async function foto(knex, tenant) {
  const r = await knex.raw(
    `SELECT cand, count(*)::int n FROM (
       SELECT (SELECT count(*)::int FROM identity.positions p
                WHERE p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
                  AND p.department_code IS NOT DISTINCT FROM u.department_code
                  AND p.default_role = u.role_name) AS cand
         FROM identity.users u
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
          AND u.kind = 'interno' AND u.position_code IS NULL) t
      GROUP BY 1 ORDER BY 1`,
    [tenant],
  );
  const m = { sin: 0, uno: 0, varios: 0 };
  for (const x of r.rows) {
    if (x.cand === 0) m.sin = x.n;
    else if (x.cand === 1) m.uno = x.n;
    else m.varios += x.n;
  }
  return m;
}

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');

  for (const tenant of tenants) {
    const antes = await foto(knex, tenant);
    console.log(
      `\n  [OR.0] tenant ${tenant} — ANTES: ${antes.sin} sin candidato · ${antes.varios} ambiguos · ${antes.uno} derivables`,
    );

    // ── 1. Los 11 puestos que faltaban ──────────────────────────────────────
    let creados = 0;
    let yaEstaban = 0;
    const rolAusente = [];
    let orden = 440; // el máximo actual es 430

    for (const [code, name, dept, rol] of PUESTOS_OFICINA) {
      orden += 10;

      // El rol se resuelve contra el catálogo vivo: si alguien lo renombró, es
      // mejor dejar el puesto sin propuesta que reventar la FK.
      const r = await knex('identity.role_permissions')
        .where({ tenant_id: tenant })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) = ?', [rol.toLowerCase()])
        .first('role_name');
      if (!r) rolAusente.push(`${code} -> ${rol}`);

      const dep = await knex('identity.departments')
        .where({ tenant_id: tenant, code: dept })
        .whereNull('deleted_at')
        .first('code');
      if (!dep) {
        console.log(`     ! ${code}: el departamento "${dept}" no existe en este tenant — se salta`);
        continue;
      }

      const res = await knex.raw(
        `INSERT INTO identity.positions (tenant_id, code, name, org_labels, orden, department_code, default_role)
         VALUES (?, ?, ?, '{}', ?, ?, ?)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenant, code, name, orden, dept, r ? r.role_name : null],
      );
      if (res.rowCount) creados++;
      else yaEstaban++;
    }
    console.log(`  [OR.0] puestos de oficina: ${creados} creado/s · ${yaEstaban} ya existía/n`);
    if (rolAusente.length) {
      console.log(`     OJO: roles del mapa que no están en el catálogo (quedan sin propuesta):`);
      rolAusente.forEach((x) => console.log(`       · ${x}`));
    }

    // ── 2. La corrección de `auxiliar_mkt` ──────────────────────────────────
    // Guardada por el valor viejo: si alguien ya lo curó a mano, no se pisa.
    const [code, viejo, nuevo] = CORRECCION;
    const rolNuevo = await knex('identity.role_permissions')
      .where({ tenant_id: tenant, role_name: nuevo })
      .whereNull('deleted_at')
      .first('role_name');

    if (!rolNuevo) {
      console.log(`  [OR.0] "${nuevo}" no está en el catálogo de roles — ${code} queda como está`);
    } else {
      const upd = await knex('identity.positions')
        .where({ tenant_id: tenant, code, default_role: viejo })
        .whereNull('deleted_at')
        .update({ default_role: rolNuevo.role_name, updated_at: knex.fn.now() });
      console.log(
        upd
          ? `  [OR.0] ${code}: default_role ${viejo} -> ${nuevo} (desambigua a los 3 "administrativo")`
          : `  [OR.0] ${code}: ya no proponía "${viejo}" — sin cambio`,
      );
    }

    // ── 3. La foto de después, y lo que queda declarado ─────────────────────
    const despues = await foto(knex, tenant);
    console.log(
      `  [OR.0] DESPUÉS: ${despues.sin} sin candidato · ${despues.varios} ambiguos · ${despues.uno} derivables`,
    );

    const huerfanos = await knex.raw(
      `SELECT u.username, u.role_name, coalesce(u.department_code, '(sin depto)') AS depto,
              (SELECT count(*)::int FROM identity.positions p
                WHERE p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
                  AND p.department_code IS NOT DISTINCT FROM u.department_code
                  AND p.default_role = u.role_name) AS cand
         FROM identity.users u
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
          AND u.kind = 'interno' AND u.position_code IS NULL
        ORDER BY cand, u.username`,
      [tenant],
    );
    const sinSalida = huerfanos.rows.filter((x) => x.cand !== 1);

    if (sinSalida.length) {
      console.log(`\n  [OR.0] ${sinSalida.length} persona/s que NINGÚN puesto resuelve — DECLARADAS, no escondidas:`);
      sinSalida.forEach((x) =>
        console.log(
          `     · ${String(x.username).padEnd(20)} rol=${String(x.role_name).padEnd(16)} depto=${String(x.depto).padEnd(16)} candidatos=${x.cand}`,
        ),
      );
      const inesperadas = sinSalida.map((x) => x.username).filter((u) => !DECLARADAS.includes(u));
      if (inesperadas.length) {
        console.log(`\n     ⚠️ SORPRESA: además de las 3 previstas aparecen ${inesperadas.length} más.`);
        console.log(`        El padrón se edita en vivo; revisar antes de correr [OR.1]: ${inesperadas.join(', ')}`);
      }
    } else {
      console.log(`\n  [OR.0] no quedan personas sin puesto posible.`);
    }
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    // Sólo se retiran los puestos que ESTA migración creó y que nadie ocupa.
    // Un puesto con gente no se toca: borrarlo dejaría personas colgadas.
    for (const [code] of PUESTOS_OFICINA) {
      const ocupado = await knex('identity.users')
        .where({ tenant_id: tenant, position_code: code })
        .whereNull('deleted_at')
        .first('id');
      if (ocupado) {
        console.log(`  [OR.0] down: ${code} tiene gente asignada — se conserva`);
        continue;
      }
      await knex('identity.positions').where({ tenant_id: tenant, code }).del();
    }
    const [code, viejo, nuevo] = CORRECCION;
    await knex('identity.positions')
      .where({ tenant_id: tenant, code, default_role: nuevo })
      .update({ default_role: viejo, updated_at: knex.fn.now() });
  }
  console.log('  [OR.0] down: puestos de oficina vacíos retirados; auxiliar_mkt revertido.');
};
