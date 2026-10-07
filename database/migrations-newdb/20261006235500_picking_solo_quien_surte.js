'use strict';
/**
 * `[VEC.12]` — Retira `COMMERCIAL_PICKING_*` a los 4 roles que NO surten.
 *
 * ── De dónde salió el permiso de más ────────────────────────────────────────────────────
 * Nadie se lo dio a propósito: lo heredaron de la **derivación** de SU.2, que repartió
 * `COMMERCIAL_PICKING_VER` a todo el que tuviera `COMMERCIAL_INVENTORY_VER`. Esa regla
 * («quien ve el inventario de un almacén puede ver cómo se surte») es razonable en abstracto
 * y falsa en concreto para estos cuatro: miran inventario por su trabajo, no surten.
 *
 * ⭐ Se nota recién ahora porque `[VEC.11]` mueve Surtido al proyecto **Almacén**: el permiso
 * deja de ser una puerta teórica y pasa a pintar un ÍTEM EN EL SIDEBAR de gente que no lo usa.
 * *Un permiso de más no se ve hasta que algo lo muestra.*
 *
 * Decisión de Edgar (2026-10-06) sobre la medición de los 4 roles / 7 personas.
 *
 * ── Qué se quita, y qué NO ──────────────────────────────────────────────────────────────
 * Se retira a: `marketing`, `direccion`, `prevencion`, `prevencion_auxiliar`.
 *
 * ⚠️ A `marketing` se le quitan **las DOS** claves: tiene `GESTIONAR` además de `VER`.
 * Quitarle sólo `VER` lo dejaría en un estado **incoherente** — la ruta se gatea con `VER`,
 * así que tendría permiso de armar olas y un 403 al intentar abrir la pantalla. Un permiso
 * huérfano es peor que uno de más: no se puede usar y no se ve que sobra.
 *
 * ⛔ **`compras` y `gerente_compras` NO se tocan, a propósito** (4 personas, con VER y
 * GESTIONAR). También heredaron el permiso de SU.2 y tampoco surten — pero Compras sí tiene
 * motivo para mirar qué está pendiente de surtir (es el otro extremo del abasto), y esa
 * decisión no se pidió. Queda **declarada**, no resuelta por analogía.
 *
 * ⚠️ Se retira con `-` (se borra la clave), NO se pone en `false`. Un `false` explícito es una
 * decisión registrada; acá la decisión es «este rol no tiene nada que ver con surtido», y
 * dejarlo en `false` haría que la próxima derivación lo saltara por una razón equivocada
 * (`permissions -> 'KEY' IS NULL` no matchea un `false`) — justo el no-op silencioso de
 * `[LC.6.2]`. Borrarla devuelve el rol al estado «nunca se le planteó».
 *
 * Idempotente: re-correrla no encuentra nada que borrar.
 *
 * @param { import("knex").Knex } knex
 */

/** Los 4 roles, con el motivo por el que miran inventario pero no surten. */
const NO_SURTEN = {
  marketing: 'mira inventario para campañas y exhibición; no prepara pedidos',
  direccion: 'lectura directiva; no opera el almacén',
  prevencion: 'investiga pérdida; su facultad es COMMERCIAL_PREVENTION_*',
  prevencion_auxiliar: 'igual que prevencion',
};

exports.up = async function up(knex) {
  const roles = Object.keys(NO_SURTEN);

  // Foto ANTES: sin esto no se puede afirmar qué cambió, sólo que el UPDATE corrió.
  const { rows: antes } = await knex.raw(
    `SELECT role_name,
            (permissions ->> 'COMMERCIAL_PICKING_VER')       AS ver,
            (permissions ->> 'COMMERCIAL_PICKING_GESTIONAR') AS gestionar
       FROM identity.role_permissions
      WHERE role_name = ANY(?) AND deleted_at IS NULL
      ORDER BY role_name`,
    [roles],
  );
  for (const a of antes) {
    console.log(`  [VEC.12] antes · ${a.role_name}: ver=${a.ver ?? '(ausente)'} gestionar=${a.gestionar ?? '(ausente)'}`);
  }

  const { rows: tocados } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - 'COMMERCIAL_PICKING_VER' - 'COMMERCIAL_PICKING_GESTIONAR',
            updated_at = now()
      WHERE role_name = ANY(?)
        AND deleted_at IS NULL
        -- ATENCION: se pregunta con IS NOT NULL sobre el operador flecha, NUNCA con el
        -- operador de existencia de JSONB (el signo de interrogacion): knex lo lee como
        -- placeholder de BINDING y revienta con "Expected N bindings" -- o peor, en una query
        -- sin bindings falla MUDO. Es regla del repo y ademas mordio hoy mismo en [VEC.1].
        -- (Y este bloque va sin acentos graves: es un template literal de JS.)
        AND (permissions -> 'COMMERCIAL_PICKING_VER' IS NOT NULL
             OR permissions -> 'COMMERCIAL_PICKING_GESTIONAR' IS NOT NULL)
      RETURNING role_name`,
    [roles],
  );
  console.log(`  [VEC.12] retirado a ${tocados.length}: ${tocados.map((t) => t.role_name).join(', ') || '(ninguno)'}`);

  // ── COMPUERTAS ───────────────────────────────────────────────────────────────────────
  // [1] El resultado, no la intención: al terminar, ninguno de los 4 puede tener la clave.
  const { rows: quedan } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE role_name = ANY(?) AND deleted_at IS NULL
        AND (permissions -> 'COMMERCIAL_PICKING_VER' IS NOT NULL
             OR permissions -> 'COMMERCIAL_PICKING_GESTIONAR' IS NOT NULL)`,
    [roles],
  );
  if (quedan.length) {
    throw new Error(`[VEC.12] siguen con la clave: ${quedan.map((q) => q.role_name).join(', ')}`);
  }

  // [2] ⭐ NO se tocó a nadie más. Un `- 'KEY'` sobre un JSONB es quirúrgico, pero el WHERE
  //     puede estar mal escrito: esto comprueba que los que SÍ surten conservan el permiso.
  //     Sin esta compuerta, un typo en la lista de roles dejaría al almacén sin poder surtir
  //     y la migración saldría verde.
  const { rows: surten } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE deleted_at IS NULL AND (permissions ->> 'COMMERCIAL_PICKING_VER') = 'true'`,
  );
  if (surten[0].n < 3) {
    throw new Error(
      `[VEC.12] sólo quedan ${surten[0].n} roles con COMMERCIAL_PICKING_VER; se esperaban al menos 3 ` +
        '(almacenista, encargado_tienda, superadmin). El filtro de roles borró de más.',
    );
  }

  // [3] `almacenista` es la razón de ser del módulo: si pierde el permiso, nadie surte.
  const { rows: alm } = await knex.raw(
    `SELECT (permissions ->> 'COMMERCIAL_PICKING_VER') AS ver,
            (permissions ->> 'COMMERCIAL_PICKING_GESTIONAR') AS ges
       FROM identity.role_permissions WHERE role_name = 'almacenista' AND deleted_at IS NULL`,
  );
  if (alm[0]?.ver !== 'true' || alm[0]?.ges !== 'true') {
    throw new Error('[VEC.12] `almacenista` perdió el permiso de surtir. Es quien surte.');
  }
  console.log(`  [VEC.12] intacto: almacenista conserva VER+GESTIONAR · ${surten[0].n} roles pueden ver surtido.`);
};

/**
 * ⚠️ Devuelve **sólo `VER`**, que es lo que la derivación de SU.2 les había dado por su
 * `COMMERCIAL_INVENTORY_VER`. El `GESTIONAR` de `marketing` venía de `INVENTORY_AJUSTAR` y
 * revertirlo acá sería reponer un permiso que esta migración declaró equivocado — un `down`
 * restituye el estado anterior, no vuelve a cometer el error que corrigió.
 */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"COMMERCIAL_PICKING_VER": true}'::jsonb,
            updated_at = now()
      WHERE role_name = ANY(?) AND deleted_at IS NULL`,
    [Object.keys(NO_SURTEN)],
  );
};
