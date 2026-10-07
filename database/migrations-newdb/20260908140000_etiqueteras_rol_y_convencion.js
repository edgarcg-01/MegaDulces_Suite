'use strict';
/**
 * `[IDG.9.12]` — Las etiqueteras son cuentas de PUESTO, una por tienda, y sólo
 * sacan etiquetas.
 *
 * ── Lo que se midió antes de tocar nada ──────────────────────────────────────
 * La etiquetera (`/store/labels`, `commercial-labels.controller`) es **ciega a la
 * sucursal**: no consume ninguna dimensión del `ScopeService`, y
 * `commercial.product_label_prices` **no tiene columna de almacén** — el precio
 * de la etiqueta es el mismo para las 8 tiendas. O sea que una cuenta por tienda
 * NO cambia lo que nadie ve; sirve para tener credencial propia por tienda en vez
 * de una compartida, para saber por `last_login_at` cuál la usa, y para poder
 * revocar una sin tocar las otras.
 *
 * Existían **2** (`etiquetas.lpa` suc 02 · `etiquetas_yur` suc 04), las dos con
 * rol **`piso_tienda` = 7 permisos**, entre ellos `STORE_ARQUEO_CAPTURAR`
 * (contar el efectivo de la caja, y el backend SÍ lo enforza en
 * `POST /store/arqueo`) y `COMMERCIAL_EXPIRY_CAPTURAR`. Medido en
 * `reconciliation.blind_counts`: **ninguna de las dos capturó jamás un arqueo**
 * (sólo cajeras `10c01/02/04` y admins). El permiso estaba de más, no en uso.
 *
 * ── El rol correcto ya existía y nadie lo usaba de verdad ────────────────────
 * `etiquetas_anaquel` (creado 2026-07-09) tenía **0 usuarios con él de perfil
 * base**, aunque las 2 etiqueteras —y `rodrigo_ortiz`— ya lo cargaban como
 * **complemento** en `identity.user_roles` (`is_primary = false`). El perfil
 * base seguía siendo `piso_tienda`, y el JWT lleva la **UNIÓN** de los dos
 * (`auth-mt.service`, `[ID.13]`) — así que agregar el rol de etiquetas no quitó
 * nada, sólo sumó.
 *
 * Tampoco era «sólo etiquetas»: traía `FINANCE_EXPENSES_CAPTURAR`, y su alcance
 * venía con `brand`, `customer` y `route` en `all`. Medido: **nadie** capturó
 * nunca una comprobación de gasto salvo superadmins (`finance.expense_proofs` y
 * `expense_comprobaciones`: sólo `superoot` y `superuser`), así que recortarlo no
 * le quita nada medible a `rodrigo_ortiz` tampoco.
 *
 * ── El detalle que hace falta hacer explícito ────────────────────────────────
 * El trigger `sync_primary_role_from_user` **degrada** el rol anterior a
 * complemento en vez de borrarlo — a propósito: «quitarle un permiso a alguien
 * tiene que ser una decisión explícita, no un efecto secundario». Perfecto, pero
 * degradado **sigue sumando al JWT**. Así que cambiar `users.role_name` NO basta:
 * hay que **borrar** la fila de `piso_tienda` en `user_roles`. Esta migración lo
 * hace explícito, que es justo lo que el trigger pide.
 *
 * ── Convención ───────────────────────────────────────────────────────────────
 * `etiquetas.NN` con la llave canónica de 2 dígitos de `[RE.23]`. Inequívoco:
 * hay dos «Abastos» (La Piedad `02` y Morelia `30`), así que un mnemónico se
 * presta a confusión. Renombrar no huérfana historia: se verificó que las 16
 * columnas de texto del padrón que guardan un username no contienen a ninguna de
 * las dos (sólo `identity.users` y su vista de compatibilidad).
 *
 * La zona sale de la sucursal (`[ID.23]`, `sucursal -> zona` es función). Eso
 * resuelve de paso la contradicción que `[IDG.9.10]` reportó y no tocó:
 * `etiquetas.lpa` decía `zona = OFICINAS` con sucursal `02`. Confirmado con el
 * lead: es un perfil de etiquetas de la tienda `02`, no una cuenta de oficina.
 * `rodrigo_ortiz` (persona real, misma contradicción) NO se toca.
 *
 * ── Lo que esta migración NO hace ────────────────────────────────────────────
 * Las 6 tiendas que faltan (`01`, `03`, `05`, `06`, `30`, `32`) se dan de alta
 * con `database/scripts/provision-etiqueteras.js`: crear un usuario exige una
 * contraseña, y un hash de contraseña no va en un archivo versionado.
 *
 * Idempotente y derivada en tiempo de corrida.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'etiquetas_anaquel';
const CLAVE = 'STORE_LABELS_VER';

/** Llave canónica de sucursal de 2 dígitos, `[RE.23]`. */
const BK = "(CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END)";

exports.up = async function up(knex) {
  // ── 0. El rol tiene que existir y conceder la clave de etiquetas ──────────
  // Si no la concede, recortarlo dejaría a las etiqueteras sin nada. Un gate
  // previo, no un gate de salida.
  const { rows: rol } = await knex.raw(
    `SELECT tenant_id, role_name, permissions -> ? AS clave
       FROM identity.role_permissions
      WHERE role_name = ? AND deleted_at IS NULL`,
    [CLAVE, ROL],
  );
  if (!rol.length) throw new Error(`El rol ${ROL} no existe en identity.role_permissions.`);
  for (const r of rol) {
    if (r.clave !== true) {
      throw new Error(`El rol ${ROL} no concede ${CLAVE} (vale ${JSON.stringify(r.clave)}).`);
    }
  }

  // ── 1. El rol queda en SOLO etiquetas ─────────────────────────────────────
  // Se ponen en false todas las demás claves, NO se vacía el mapa: las 157
  // claves siguen ahí (ausente y false se comportan igual en el lookup, pero un
  // mapa completo es lo que /admin/roles guarda y lee).
  const recorte = await knex.raw(
    `UPDATE identity.role_permissions rp
        SET permissions = (
              SELECT jsonb_object_agg(e.k, CASE WHEN e.k = ? THEN e.v ELSE 'false'::jsonb END)
                FROM jsonb_each(rp.permissions) AS e(k, v)),
            updated_at = now()
      WHERE rp.role_name = ? AND rp.deleted_at IS NULL`,
    [CLAVE, ROL],
  );
  console.log(`  ✓ rol ${ROL}: recortado a la sola clave ${CLAVE} (${recorte.rowCount} fila/s).`);

  // ── 2. Su alcance también se recorta ──────────────────────────────────────
  // Una cuenta que sólo imprime etiquetas no tiene nada que hacer con la cartera
  // de clientes, las marcas ni las rutas. Quedan warehouse/zone en `own`, que es
  // inerte para esta pantalla y deja la ficha coherente.
  const alc = await knex.raw(
    `UPDATE identity.role_scopes
        SET mode = 'none', values = NULL, updated_at = now()
      WHERE role_name = ? AND dimension IN ('brand', 'customer', 'route') AND mode <> 'none'`,
    [ROL],
  );
  if (alc.rowCount) console.log(`  ✓ alcance del rol: ${alc.rowCount} dimension(es) de all a none.`);

  // ── 3. Las etiqueteras existentes: convención, rol, sucursal y zona ───────
  const { rows: antes } = await knex.raw(
    `SELECT username, role_name, warehouse_code FROM identity.users
      WHERE username ~ '^etiquetas[._]' AND deleted_at IS NULL ORDER BY username`,
  );
  if (!antes.length) console.log('  ~ no hay cuentas etiquetas.* que normalizar.');

  const norm = await knex.raw(
    `WITH suc AS (
       SELECT w.tenant_id, ${BK} AS bk, w.name AS sucursal, z.id AS zona_id
         FROM commercial.warehouses w
         JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
        WHERE w.deleted_at IS NULL AND ${BK} ~ '^[0-9]{2}$')
     UPDATE identity.users u
        SET username        = 'etiquetas.' || s.bk,
            nombre          = 'Etiquetas - ' || s.sucursal,
            role_name       = ?,
            zona_id         = s.zona_id,
            department_code = 'tienda',
            position_code   = NULL,
            kind            = 'interno',
            updated_at      = now()
       FROM suc s
      WHERE u.deleted_at IS NULL
        AND u.username ~ '^etiquetas[._]'
        AND s.tenant_id = u.tenant_id
        AND s.bk = u.warehouse_code`,
    [ROL],
  );
  console.log(`  ✓ ${norm.rowCount} etiquetera(s) normalizada(s) a etiquetas.NN con rol ${ROL}.`);
  for (const a of antes) {
    console.log(`      ${a.username} (${a.role_name}, suc ${a.warehouse_code}) → etiquetas.${a.warehouse_code}`);
  }

  // ── 4. Y se le BORRA el rol viejo, no se degrada ──────────────────────────
  // El trigger dejó `piso_tienda` como complemento, y un complemento suma al JWT.
  // `kind = 'interno'` a propósito: `kind = 'servicio'` bloquea el login
  // interactivo (`[ID.17]`) y estas cuentas las teclea una persona en el piso.
  const sobras = await knex.raw(
    `DELETE FROM identity.user_roles ur
       USING identity.users u
      WHERE u.tenant_id = ur.tenant_id AND u.id = ur.user_id
        AND u.deleted_at IS NULL
        AND u.username ~ '^etiquetas[.]'
        AND ur.role_name <> ?`,
    [ROL],
  );
  if (sobras.rowCount) {
    console.log(`  ✓ ${sobras.rowCount} rol(es) complemento retirado(s): degradar no alcanza, el JWT lleva la union.`);
  }

  // ── Gates ─────────────────────────────────────────────────────────────────
  // (a) El rol concede exactamente una clave, y es la de etiquetas.
  const { rows: g1 } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND e.k <> ?`,
    [ROL, CLAVE],
  );
  if (g1[0].n > 0) throw new Error(`El rol ${ROL} sigue concediendo ${g1[0].n} clave(s) fuera de ${CLAVE}.`);

  // (b) Ninguna etiquetera arrastra un rol de más.
  const { rows: g2 } = await knex.raw(
    `SELECT u.username, ur.role_name, ur.is_primary
       FROM identity.users u
       JOIN identity.user_roles ur ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
      WHERE u.username ~ '^etiquetas[.]' AND u.deleted_at IS NULL AND ur.role_name <> ?`,
    [ROL],
  );
  if (g2.length) {
    throw new Error(`Etiqueteras con rol de mas: ${g2.map((r) => r.username + '/' + r.role_name).join(', ')}`);
  }

  // (c) Cada etiquetera tiene sucursal, y su zona es la que la sucursal implica.
  const { rows: g3 } = await knex.raw(
    `SELECT u.username, u.warehouse_code, u.zona_id
       FROM identity.users u
      WHERE u.username ~ '^etiquetas' AND u.deleted_at IS NULL
        AND (u.warehouse_code IS NULL OR u.zona_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM commercial.warehouses w
                 JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
                WHERE w.tenant_id = u.tenant_id AND w.deleted_at IS NULL
                  AND ${BK} = u.warehouse_code AND z.id = u.zona_id))`,
  );
  if (g3.length) {
    throw new Error(
      `Etiqueteras con sucursal o zona incoherente: ${g3.map((r) => r.username + '/' + r.warehouse_code).join(', ')}`,
    );
  }

  // (d) La convención se cumple: nada de guiones bajos sueltos.
  const { rows: g4 } = await knex.raw(
    `SELECT username FROM identity.users
      WHERE username ~ '^etiquetas' AND deleted_at IS NULL AND username !~ '^etiquetas[.][0-9]{2}$'`,
  );
  if (g4.length) throw new Error(`Usernames fuera de convencion: ${g4.map((r) => r.username).join(', ')}`);

  // ── Cobertura: cuántas tiendas tienen etiquetera y cuántas no ─────────────
  // Se DECLARA, no se dibuja: el alta de las que faltan la hace el script de
  // provisión, porque exige contraseña.
  const { rows: cob } = await knex.raw(
    `WITH tiendas AS (
       SELECT w.tenant_id, ${BK} AS bk, w.name AS sucursal
         FROM commercial.warehouses w
         JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
        WHERE w.deleted_at IS NULL AND ${BK} ~ '^[0-9]{2}$')
     SELECT t.bk, t.sucursal, (u.id IS NOT NULL) AS tiene_etiquetera
       FROM tiendas t
       LEFT JOIN identity.users u
         ON u.tenant_id = t.tenant_id AND u.deleted_at IS NULL
        AND u.username = 'etiquetas.' || t.bk
      ORDER BY t.bk`,
  );
  const faltan = cob.filter((c) => !c.tiene_etiquetera);
  console.log(`\n  Cobertura: ${cob.length - faltan.length} de ${cob.length} tienda(s) con etiquetera.`);
  if (faltan.length) {
    console.log(`  Faltan: ${faltan.map((f) => f.bk + ' ' + f.sucursal).join(' · ')}`);
    console.log('  Alta: node database/scripts/provision-etiqueteras.js --apply');
  }
};

exports.down = async function down(knex) {
  // Se revierte el recorte del ALCANCE (es configuración), no el de permisos ni
  // el rol de las cuentas: devolverles `piso_tienda` seria regalarles otra vez
  // el permiso de contar el efectivo de la caja, que nunca usaron.
  await knex.raw(
    `UPDATE identity.role_scopes SET mode = 'all', values = NULL, updated_at = now()
      WHERE role_name = ? AND dimension IN ('brand', 'customer', 'route')`,
    [ROL],
  );
  console.log('  Revertido el alcance del rol. El recorte de permisos y el rol de las cuentas NO se revierten.');
};
