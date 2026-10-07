'use strict';
/**
 * `[OR.7.0]` — Un solo catálogo de la organización: se parte `administracion` (y `operaciones`).
 *
 * ── El hallazgo: había DOS catálogos de la misma empresa ─────────────────────────────────────
 * `libs/contracts/src/authz/role-presets.ts` trae **`AREAS`, 13 áreas «del organigrama Mega
 * Dulces»** con sus plantillas de permisos. `identity.departments` trae **13 departamentos**. No son
 * el mismo corte, y se complementan de una forma que explica lo que pasó en `[OR.0]`:
 *
 *     AREAS (código)          desglosa LA OFICINA (contabilidad, finanzas, tesorería, crédito y
 *                             cobranza, mercadotecnia, RH, prevención) y aplasta la operación
 *     departments (base)      desglosa LA OPERACIÓN (tienda, cajas, ruta directa, ruta vecinal,
 *                             mayoreo, almacén, logística) y aplasta la oficina en `administracion`
 *
 * ⭐ **El desglose de oficina que `[OR.0]` tuvo que reconstruir desde los roles YA ESTABA en el
 * repo**, en `role-presets.ts`, y nadie había conectado los dos catálogos.
 *
 * ── Por qué el corte no se inventa acá ──────────────────────────────────────────────────────
 * No hace falta decidir quién va a dónde: **ya está escrito en el puesto de cada persona**. Los 11
 * puestos que creó `[OR.0]` se derivaron del rol que esa gente ya tenía, y mapean casi 1:1 contra
 * las áreas. Esta migración sólo **sube ese corte un nivel**: del puesto al departamento.
 *
 *     administracion  17 personas  ->  finanzas 7 · administracion 3 · contabilidad 2 ·
 *                                      credito_cobranza 2 · mercadotecnia 2 · tesoreria 1
 *     operaciones     10 personas  ->  compras 7 · prevencion_auditoria 2 · operaciones 1
 *
 * ── Lo que esto NO toca, y conviene decirlo ─────────────────────────────────────────────────
 * **Ni un permiso, ni un alcance.** Verificado por grep: `department_code` sólo se lee en el módulo
 * de usuarios (`libs/trade/src/lib/users/*` y la pantalla de alta). **No gatea ni filtra nada.**
 *
 * El único efecto de segundo orden es el EJE de `[ID.24.2]`, que se resuelve como
 * `coalesce(positions.scope_axis, departments.scope_axis)`. Por eso **los 8 departamentos nuevos
 * nacen con `scope_axis = 'red'`**, que es exactamente lo que `administracion` y `operaciones` ya
 * declaran: el eje de las 27 personas queda idéntico. La migración lo **comprueba** al final en vez
 * de confiar — si alguno cambiara, 27 personas de oficina dejarían de ver la red.
 *
 * ── Lo que queda declarado y sin tocar ──────────────────────────────────────────────────────
 *  · `rodrigo_ortiz` tiene puesto `auxiliar_mkt` y departamento `telemarketing`. Por puesto le
 *    tocaría `mercadotecnia`. Es una de las incoherencias que `[ID.15]` ya reportaba y **no se
 *    corrige acá**: sólo se mueve a quien HOY está en `administracion`/`operaciones`, así que él
 *    queda como estaba. Corregirlo exige saber si el puesto o el departamento es el correcto.
 *  · `rh` se crea **vacío**: el puesto `auxiliar_rh` existe con 0 personas. Un departamento sin
 *    gente es correcto —igual que un puesto vacante— y deja el catálogo completo.
 *  · `auxiliar_administrativo` (3) e `intendencia` se quedan en `administracion`, que pasa a ser
 *    el residual honesto en vez de la bolsa de toda la oficina.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [code, nombre, orden]. Todos `scope_axis='red'`: es el eje que ya tenían sus padres. */
const DEPARTAMENTOS = [
  ['compras', 'Compras', 101],
  ['prevencion_auditoria', 'Prevención y Auditoría', 102],
  ['contabilidad', 'Contabilidad', 111],
  ['finanzas', 'Finanzas', 112],
  ['tesoreria', 'Tesorería', 113],
  ['credito_cobranza', 'Crédito y Cobranza', 114],
  ['mercadotecnia', 'Mercadotecnia', 115],
  ['rh', 'Recursos Humanos', 116],
];

/** puesto -> departamento nuevo. Lo que no está acá se queda donde está. */
const PUESTO_A_DEPTO = {
  // desde `administracion`
  auxiliar_contabilidad: 'contabilidad',
  jefe_finanzas: 'finanzas',
  auxiliar_finanzas: 'finanzas',
  tesoreria: 'tesoreria',
  auxiliar_credito_cobranza: 'credito_cobranza',
  jefe_marketing: 'mercadotecnia',
  auxiliar_mkt: 'mercadotecnia',
  auxiliar_rh: 'rh',
  // desde `operaciones`
  gerente_compras: 'compras',
  comprador: 'compras',
  auxiliar_compras: 'compras',
  prevencion: 'prevencion_auditoria',
  auxiliar_prevencion: 'prevencion_auditoria',
};

/** Sólo se mueve gente que HOY cuelga de estos dos. */
const ORIGEN = ['administracion', 'operaciones'];

/** El eje efectivo de cada persona, que es lo que NO puede cambiar. */
const SQL_EJE = `
  SELECT u.id, u.username, coalesce(ps.scope_axis, d.scope_axis) AS eje
    FROM identity.users u
    LEFT JOIN identity.positions ps ON ps.tenant_id = u.tenant_id AND ps.code = u.position_code
    LEFT JOIN identity.departments d ON d.tenant_id = u.tenant_id AND d.code = u.department_code
   WHERE u.tenant_id = ? AND u.deleted_at IS NULL`;

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');

  for (const tenant of tenants) {
    // Foto del eje ANTES. Es la prueba negativa de esta migración.
    const antes = await knex.raw(SQL_EJE, [tenant]);
    const ejeAntes = new Map(antes.rows.map((r) => [r.id, r.eje]));

    // ── 1. Los 8 departamentos ──────────────────────────────────────────────
    let creados = 0;
    for (const [code, name, orden] of DEPARTAMENTOS) {
      const res = await knex.raw(
        `INSERT INTO identity.departments (tenant_id, code, name, orden, scope_axis)
         VALUES (?, ?, ?, ?, 'red')
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenant, code, name, orden],
      );
      if (res.rowCount) creados++;
    }
    console.log(`  [OR.7.0] departamentos: ${creados} creado/s de ${DEPARTAMENTOS.length}`);

    // ── 2. Los puestos se mudan ─────────────────────────────────────────────
    let puestos = 0;
    for (const [code, dep] of Object.entries(PUESTO_A_DEPTO)) {
      const n = await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .whereIn('department_code', ORIGEN)
        .whereNull('deleted_at')
        .update({ department_code: dep, updated_at: knex.fn.now() });
      if (n) { puestos++; console.log(`     · ${String(code).padEnd(26)} -> ${dep}`); }
    }
    console.log(`  [OR.7.0] ${puestos} puesto/s mudado/s`);

    // ── 3. Las personas siguen a su puesto ──────────────────────────────────
    // Sólo las que HOY están en administracion/operaciones: así `rodrigo_ortiz`
    // (puesto de mkt, departamento telemarketing) queda como está, y su
    // incoherencia se decide aparte en vez de resolverse de callado.
    const mudanza = await knex.raw(
      `UPDATE identity.users u
          SET department_code = p.department_code, updated_at = now()
         FROM identity.positions p
        WHERE p.tenant_id = u.tenant_id AND p.code = u.position_code AND p.deleted_at IS NULL
          AND u.tenant_id = ? AND u.deleted_at IS NULL
          AND u.department_code = ANY(?)
          AND p.department_code <> u.department_code
      RETURNING u.username, u.department_code`,
      [tenant, ORIGEN],
    );
    console.log(`  [OR.7.0] ${mudanza.rows.length} persona/s mudada/s de departamento`);

    const porDepto = {};
    mudanza.rows.forEach((r) => { porDepto[r.department_code] = (porDepto[r.department_code] ?? 0) + 1; });
    Object.entries(porDepto)
      .sort((a, b) => b[1] - a[1])
      .forEach(([d, n]) => console.log(`     ${String(n).padStart(3)}  -> ${d}`));

    // ── 4. La prueba negativa: NADIE puede haber perdido su eje ─────────────
    const despues = await knex.raw(SQL_EJE, [tenant]);
    const cambiaron = despues.rows.filter((r) => ejeAntes.get(r.id) !== r.eje);
    if (cambiaron.length) {
      // Fail-closed: si el eje se movió, alguien deja de ver la red y es peor
      // que no haber hecho nada. Revienta y la transacción de knex revierte.
      throw new Error(
        `[OR.7.0] ABORTA: ${cambiaron.length} persona/s cambiaron de eje de alcance. ` +
          cambiaron.slice(0, 5).map((r) => `${r.username}: ${ejeAntes.get(r.id)} -> ${r.eje}`).join(' · '),
      );
    }
    console.log(`  [OR.7.0] eje de alcance INTACTO en las ${despues.rows.length} cuentas (prueba negativa)`);

    // ── 5. La foto ──────────────────────────────────────────────────────────
    const foto = await knex.raw(
      `SELECT d.code, d.scope_axis,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = d.tenant_id AND u.department_code = d.code
                  AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno') AS gente
         FROM identity.departments d
        WHERE d.tenant_id = ? AND d.deleted_at IS NULL
        ORDER BY d.orden`, [tenant]);
    console.log(`\n  [OR.7.0] los ${foto.rows.length} departamentos:`);
    foto.rows.forEach((r) =>
      console.log(`     ${String(r.gente).padStart(3)}  ${String(r.code).padEnd(22)} ${r.scope_axis}`));

    const incoherentes = await knex.raw(
      `SELECT u.username, u.department_code AS depto_persona, p.department_code AS depto_puesto
         FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          AND p.department_code IS DISTINCT FROM u.department_code
        ORDER BY 1`, [tenant]);
    if (incoherentes.rows.length) {
      console.log(`\n  [OR.7.0] ${incoherentes.rows.length} persona/s cuyo departamento NO coincide con el de su puesto — se REPORTAN, no se tocan:`);
      incoherentes.rows.forEach((r) =>
        console.log(`     · ${String(r.username).padEnd(20)} persona=${r.depto_persona}  puesto=${r.depto_puesto}`));
    }
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const inverso = { compras: 'operaciones', prevencion_auditoria: 'operaciones' };
  for (const tenant of await knex('identity.tenants').pluck('id')) {
    for (const [code] of DEPARTAMENTOS) {
      const destino = inverso[code] ?? 'administracion';
      await knex('identity.users').where({ tenant_id: tenant, department_code: code }).update({ department_code: destino });
      await knex('identity.positions').where({ tenant_id: tenant, department_code: code }).update({ department_code: destino });
      const gente = await knex('identity.users').where({ tenant_id: tenant, department_code: code }).first('id');
      if (!gente) await knex('identity.departments').where({ tenant_id: tenant, code }).del();
    }
  }
  console.log('  [OR.7.0] down: gente y puestos devueltos a administracion/operaciones.');
};
