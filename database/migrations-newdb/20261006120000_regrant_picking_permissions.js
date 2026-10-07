'use strict';
/**
 * `[VEC.0]` — Re-reparte `COMMERCIAL_PICKING_VER` / `_GESTIONAR`, y corrige la regla de
 * GESTIONAR. Requisito del flujo vecinal: sin esto, la persona que ARMA el pedido no puede
 * abrir el módulo de surtido, y el "pedido global" no lo levanta nadie.
 *
 * ── EL DEFECTO NO ES "NADIE LO REPARTIÓ" ────────────────────────────────────────────────
 * Ese era mi diagnóstico y la medición lo refutó. `20260917140100_grant_picking_permissions`
 * (Fase SU.2) **sí corrió** en prod el 2026-09-17 (batch 450) y repartió bien.
 *
 * Lo que falla es otra cosa, y es más general: **una derivación es una FOTO del momento en
 * que corre la migración, no una regla viva.** SU.2 derivó de `COMMERCIAL_INVENTORY_*` el
 * 17-sep; `almacenista` recibió sus permisos de inventario **once días después** (Fase IC,
 * mig `20260928120000`, batch 552 — la fila de `almacenista` quedó sellada a las 14:25:15 de
 * ese día). Nada volvió a correr la derivación, así que el rol que de verdad surte quedó
 * fuera para siempre. El propio encabezado de SU.2 dice *"si mañana un rol gana o pierde el
 * permiso de inventario, este reparto sigue siendo el que se documentó"* — esa frase
 * describe una **intención**, no un mecanismo: la migración corre una vez.
 *
 * Por eso esta migración viene con su compuerta en `test-newdb-permission-delivery.js`
 * (bloque `[5]`, pares declarados): sin ella, el mismo defecto vuelve con el próximo rol.
 *
 * Medido en prod el 2026-10-06, antes de escribir:
 *
 *   rol                  INV_VER  INV_AJUSTAR  INV_RECIBIR  PICK_VER  PICK_GEST  personas
 *   almacenista          true     false        true         (falta)   (falta)    6
 *   supervisor           true     true         true         true      true       1
 *   encargado_tienda     true     true         —            true      true       7
 *   direccion            true     —            —            (falta)   —          2
 *   prevencion           true     false        —            (falta)   —          1
 *   prevencion_auxiliar  true     false        —            (falta)   —          2
 *
 * ── GESTIONAR: la regla de SU.2 estaba MAL para este caso ───────────────────────────────
 * SU.2 derivó GESTIONAR de `COMMERCIAL_INVENTORY_AJUSTAR`. Pero **surtir no es ajustar**:
 * levantar del anaquel lo que un pedido pide es de la familia de RECIBIR (mover mercancía
 * física), no de AJUSTAR (corregir el saldo del sistema). Y la diferencia no es cosmética:
 * la Fase IC le quitó `AJUSTAR` a `almacenista` **a propósito** (segregación: quien cuenta
 * no ajusta, para que un faltante no se tape con un ajuste). Derivar de AJUSTAR obliga a
 * elegir entre romper esa segregación o dejar al almacén sin poder surtir.
 *
 *   GESTIONAR ← INVENTORY_AJUSTAR **OR** INVENTORY_RECIBIR
 *
 * `RECIBIR = true` existe hoy en exactamente 2 roles (`almacenista`, `supervisor`): es la
 * marca más limpia de "esta persona toca la mercancía". La segregación de IC queda intacta
 * — acá NO se le da `AJUSTAR` a nadie.
 *
 * ⛔ **`customer_b2b` sigue fuera** aunque tenga `INVENTORY_VER` (3 personas): es un cliente
 * externo. Ve existencia para saber si le pueden surtir, no el trabajo interno del almacén.
 * Misma excepción deliberada que SU.2.
 *
 * ⛔ **`auxiliar_tienda` (5 personas) y `encargado_bodega` (1) NO entran, y se declara.**
 * Yo mismo los había prometido antes de medir: ninguno de los dos tiene **ningún** permiso
 * de inventario (`auxiliar_tienda` los tiene en `false` explícito; `encargado_bodega` ni
 * siquiera tiene las claves). La derivación no los alcanza y **meterlos a mano sería
 * inventar la regla** — justo lo que este archivo viene a corregir. Si tienen que surtir,
 * se les da el permiso de inventario desde `/admin/roles` y la compuerta `[5]` obliga a que
 * el de surtido los siga. Dueño de esa decisión: Edgar.
 *
 * ── Forma ───────────────────────────────────────────────────────────────────────────────
 * Aditiva y sólo donde la clave FALTA (`permissions -> 'KEY' IS NULL`), **no** `jsonb_set`
 * con overwrite como SU.2: un `false` explícito es un dato real (alguien decidió que no) y
 * no se pisa. Verificado antes de escribir: hoy nadie tiene las dos claves en `false`, así
 * que en esta corrida ambas formas coinciden — se elige la que no destruye información.
 *
 * ⚠️ `permissions -> 'KEY' IS NULL`, NUNCA el operador `?` de JSONB (knex no lo escapa).
 *
 * ⚠️ Se escribe sobre `identity.role_permissions`, la TABLA. `public.role_permissions` es
 * una vista (auto-actualizable, por eso SU.2 funcionó) pero escribirle esconde el destino.
 *
 * Alcance por `role_name` sin filtrar `tenant_id`: es el catálogo de roles, igual que el
 * resto de los backfills de permisos.
 *
 * ⚠️ Después de aplicarla, los afectados tienen que **volver a entrar**: los permisos viajan
 * dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */

/** Quién NO recibe nunca, con el motivo a la vista. */
const EXCLUIDOS = `role_name <> 'customer_b2b' AND role_name NOT LIKE 'retirado_%'`;

exports.up = async function up(knex) {
  // ── VER ← INVENTORY_VER (la misma regla de SU.2, re-aplicada contra el estado de HOY) ──
  const ver = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"COMMERCIAL_PICKING_VER": true}'::jsonb,
            updated_at = now()
      WHERE ${EXCLUIDOS}
        AND deleted_at IS NULL
        AND permissions -> 'COMMERCIAL_PICKING_VER' IS NULL
        AND (permissions ->> 'COMMERCIAL_INVENTORY_VER') = 'true'
      RETURNING role_name`,
  );

  // ── GESTIONAR ← AJUSTAR OR RECIBIR (la corrección: surtir no es ajustar) ───────────────
  const gestionar = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"COMMERCIAL_PICKING_GESTIONAR": true}'::jsonb,
            updated_at = now()
      WHERE ${EXCLUIDOS}
        AND deleted_at IS NULL
        AND permissions -> 'COMMERCIAL_PICKING_GESTIONAR' IS NULL
        AND (   (permissions ->> 'COMMERCIAL_INVENTORY_AJUSTAR') = 'true'
             OR (permissions ->> 'COMMERCIAL_INVENTORY_RECIBIR') = 'true')
      RETURNING role_name`,
  );

  const rolesVer = ver.rows.map((r) => r.role_name);
  const rolesGes = gestionar.rows.map((r) => r.role_name);
  console.log(`  [VEC.0] COMMERCIAL_PICKING_VER       → ${rolesVer.length}: ${rolesVer.join(', ') || '(ninguno)'}`);
  console.log(`  [VEC.0] COMMERCIAL_PICKING_GESTIONAR → ${rolesGes.length}: ${rolesGes.join(', ') || '(ninguno)'}`);

  // ── COMPUERTAS SOBRE EL RESULTADO, no sobre la intención ──────────────────────────────
  // El invariante no es "esta corrida movió N filas" (re-correrla mueve 0 y está bien): es
  // que al TERMINAR, el estado cumpla la regla. Así la migración es idempotente y la
  // verificación sigue siendo real en la segunda corrida.
  const { rows: huecos } = await knex.raw(
    `SELECT role_name,
            (permissions ->> 'COMMERCIAL_INVENTORY_VER')     AS inv_ver,
            (permissions ->> 'COMMERCIAL_INVENTORY_AJUSTAR') AS inv_ajustar,
            (permissions ->> 'COMMERCIAL_INVENTORY_RECIBIR') AS inv_recibir,
            (permissions ->> 'COMMERCIAL_PICKING_VER')       AS pick_ver,
            (permissions ->> 'COMMERCIAL_PICKING_GESTIONAR') AS pick_ges
       FROM identity.role_permissions
      WHERE ${EXCLUIDOS} AND deleted_at IS NULL
        AND (
              ((permissions ->> 'COMMERCIAL_INVENTORY_VER') = 'true'
                AND permissions -> 'COMMERCIAL_PICKING_VER' IS NULL)
           OR (((permissions ->> 'COMMERCIAL_INVENTORY_AJUSTAR') = 'true'
                OR (permissions ->> 'COMMERCIAL_INVENTORY_RECIBIR') = 'true')
                AND permissions -> 'COMMERCIAL_PICKING_GESTIONAR' IS NULL)
            )`,
  );
  if (huecos.length) {
    throw new Error(
      `[VEC.0] la derivación quedó incompleta en ${huecos.length} rol(es): ` +
        `${huecos.map((h) => h.role_name).join(', ')}. El UPDATE no alcanzó lo que su propia regla exige.`,
    );
  }

  // Quien puede GESTIONAR tiene que poder VER: la ruta y el controller se gatean con VER,
  // así que un rol con sólo el gestionar recibe 403 y parece un bug de código.
  const { rows: ciegos } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE deleted_at IS NULL
        AND (permissions ->> 'COMMERCIAL_PICKING_GESTIONAR') = 'true'
        AND coalesce(permissions ->> 'COMMERCIAL_PICKING_VER', 'false') <> 'true'`,
  );
  if (ciegos.length) {
    throw new Error(
      `[VEC.0] ${ciegos.map((c) => c.role_name).join(', ')} puede gestionar una ola y no puede verla ` +
        '(la ruta se gatea con VER). Reparto incoherente.',
    );
  }

  // El módulo tiene que quedar ALCANZABLE POR UNA PERSONA, no sólo concedido a un rol.
  // Un rol sin gente es tan inalcanzable como un permiso sin rol — lección de `[ID.29]`.
  const { rows: alcance } = await knex.raw(
    `SELECT count(DISTINCT u.id)::int AS personas
       FROM identity.users u
       JOIN identity.role_permissions rp ON rp.role_name = u.role_name AND rp.deleted_at IS NULL
      WHERE u.activo AND u.deleted_at IS NULL
        AND (rp.permissions ->> 'COMMERCIAL_PICKING_GESTIONAR') = 'true'`,
  );
  if (!alcance[0] || alcance[0].personas === 0) {
    throw new Error('[VEC.0] cero personas activas pueden surtir. El módulo quedaría sin dueño otra vez.');
  }
  console.log(`  [VEC.0] pueden surtir: ${alcance[0].personas} persona(s) activa(s).`);
};

/**
 * ⚠️ Revierte SÓLO la población que esta migración puede PROBAR que agregó: la que califica
 * por la regla nueva (`RECIBIR` sí, `AJUSTAR` no). Corrido en seco contra prod el
 * 2026-10-06, ese conjunto es exactamente `almacenista` — el único rol que el `up` toca.
 *
 * ⛔ Lo que este `down` NO deshace, a propósito: el `COMMERCIAL_PICKING_VER` de un rol que
 * sólo tiene `INVENTORY_VER` (`direccion`, `prevencion`, `prevencion_auxiliar`…). Esa clave
 * **la repartió SU.2**, y `role_permissions` no guarda quién concedió qué — borrarla acá
 * desharía el trabajo de otra migración sin saberlo. Primera versión de este archivo hacía
 * justo eso. Un `down` que revierte de más es peor que uno que revierte de menos: el de
 * menos deja permiso sobrante (se ve y se quita), el de más cierra puertas que nadie pidió
 * cerrar y el síntoma es un 403 sin causa a la vista.
 */
exports.down = async function down(knex) {
  const soloPorRecibir =
    `(permissions ->> 'COMMERCIAL_INVENTORY_RECIBIR') = 'true'
     AND coalesce(permissions ->> 'COMMERCIAL_INVENTORY_AJUSTAR', 'false') <> 'true'`;
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - 'COMMERCIAL_PICKING_GESTIONAR' - 'COMMERCIAL_PICKING_VER',
            updated_at = now()
      WHERE ${soloPorRecibir}`,
  );
};
