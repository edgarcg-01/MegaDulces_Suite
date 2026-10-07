'use strict';
/**
 * `[ID.14]` — Normaliza el catálogo de roles (Fase ID / esquema CRM-ERP).
 *
 * Lo medido (ver `FASE_ID_ESQUEMA_USUARIOS_ERP.md`): **47 roles para 142
 * cuentas**, 22 de ellos con 1 o 2 usuarios, nombrados por la PERSONA que los
 * ocupa —con género incluido: `coordinadora_marketing`, `encargada_prevencion`—
 * y no por la función. Más 13 roles sin un solo usuario, uno de ellos
 * (`sistemas`) con 145 permisos otorgados: un arma cargada sobre la mesa.
 *
 * Esta migración hace TRES cosas, en este orden y con esta regla:
 *
 *   1. **RETIRAR** los roles sin usuarios. Se les cambia el nombre a
 *      `retirado_<nombre>` y se marcan `deleted_at`. Lo primero libera los
 *      nombres buenos (`contabilidad`, `tesoreria`, `mercadotecnia`, `rh` eran
 *      roles muertos); lo segundo los saca de los selectores. **Reversible**:
 *      el set de permisos queda intacto, restaurar es renombrar de vuelta.
 *
 *   2. **RENOMBRAR** a función. Cero cambio de permisos: se copia la fila con el
 *      nombre nuevo y se mueve todo lo que apunta a ella (usuarios, `user_roles`,
 *      `role_scopes`). Es un rename real y no un UPDATE del nombre porque la FK
 *      compuesta `(tenant_id, role_name)` no tiene ON UPDATE CASCADE.
 *
 *   3. **FUSIONAR** sólo cuando es defendible. La fusión sube a todos al máximo
 *      del grupo, así que hay un **guard duro**: si algún usuario ganaría más de
 *      `MAX_GANANCIA` permisos, la fusión NO se hace y queda reportada como
 *      decisión. Medido antes de escribir esto: el cluster de 5 roles de finanzas
 *      tiene unión de 13 permisos y la ganancia máxima es **2**
 *      (`FINANCE_RECON_ASIGNAR`, `FINANCE_EXPENSES_CAPTURAR`); y
 *      `coordinador_presupuestos` es IDÉNTICO a `coordinadora_contabilidad`
 *      (27 permisos exactos), o sea ganancia 0.
 *
 * Y una cuarta, chica pero necesaria para que la UI pueda dejar de mentir:
 *   4. `role_permissions.kind` = `perfil` | `complemento`. Hay "roles" que son
 *      TAREAS: `captura_gastos` (22 usuarios, **1 permiso**), `etiquetas_tienda`
 *      (2), `auxiliar_mercadotecnia` (3). Peor: `FINANCE_EXPENSES_CAPTURAR` está
 *      copiado dentro de 5 roles distintos. Marcarlos permite que la pantalla
 *      ofrezca "perfil base" (uno) y "complementos" (varios) — que es lo que
 *      `[ID.13]` hizo posible.
 *
 * Lo que esta migración NO hace a propósito: reasignarle el perfil base a nadie.
 * Que los 22 de `captura_gastos` tengan una tarea como perfil base es un dato a
 * corregir **desde la UI**, persona por persona, con criterio de Edgar. Un
 * script que decida eso sube a 22 personas a un perfil que nadie eligió.
 *
 * Verificación: `snapshot-user-permissions.js` antes y después. Criterio de
 * aceptación **cero PIERDE**; las ganancias quedan listadas una por una.
 *
 * @param { import("knex").Knex } knex
 */

/** Máximo de permisos que un usuario puede GANAR por una fusión. */
const MAX_GANANCIA = 3;

/** El único rol-dios que queda. `admin` y `sistemas` se van. */
const GOD = 'superadmin';

/**
 * Renombres a función. Sin cambio de permisos.
 * El nombre nuevo describe QUÉ HACE, medido sobre sus permisos reales — no lo
 * que sugiere el nombre viejo. Dos ejemplos de eso:
 *   - `auxiliar_sucursal` no es "piso de venta": sus 12 permisos son recepción
 *     de mercancía, despacho de reparto, etiquetas, arqueo y bot de WhatsApp
 *     → `auxiliar_tienda`.
 *   - `colaborador` (19 usuarios) captura visitas y mueve pedidos que NO puede
 *     ver ni crear, con acceso a la app del vendedor → `promotor_ruta`, no
 *     "vendedor" (ése es el que crea el pedido).
 */
const RENOMBRAR = [
  ['cajera', 'cajero'], // sin género: es un puesto, no una persona
  ['encargado_sucursal', 'encargado_tienda'],
  ['auxiliar_sucursal', 'auxiliar_tienda'],
  ['colaborador', 'promotor_ruta'], // "colaborador" no dice nada
  ['vendedor', 'vendedor_ruta'],
  ['etiquetas_tienda', 'etiquetas_anaquel'],
  ['auxiliar_mercadotecnia', 'analisis_ventas'],
  ['coordinadora_marketing', 'marketing'],
  ['encargada_prevencion', 'prevencion'],
  ['auxiliar_prevencion', 'prevencion_auxiliar'],
  ['encargada_operaciones_compras', 'compras_operaciones'],
  ['gestor_tesoreria', 'tesoreria'], // el nombre lo libera el paso 1
  ['coordinadora_contabilidad', 'contabilidad'], // idem
  ['analista_credito_cobranza', 'finanzas_operativo'], // es la UNIÓN del cluster (13p)
];

/**
 * Fusiones [origen, destino]. El destino se queda con la UNIÓN.
 * Los 5 roles de finanzas de ~12 permisos son el mismo perfil operativo con ±1
 * permiso de conciliación; la distinción real (cobranza vs egresos vs depósitos)
 * la sostienen el PUESTO y el alcance por área de gasto, no 5 roles.
 */
const FUSIONAR = [
  // `admin` (153 permisos, 2 usuarios) y `superadmin` (152, 7) son el mismo rol
  // con 3 permisos de diferencia, y los dos pasan por el god-mode de
  // `ability.factory` (`isPlatformAdminRole`). Se fusionan con UNION para que
  // los 2 de `admin` no pierdan sus 2 permisos propios. NO se renombra
  // `superadmin` a `admin_plataforma`: ese nombre esta escrito como literal en
  // `ELEVATED_ROLES` y en `isPlatformAdminRole`, y renombrarlo sin tocar el
  // codigo deja a los 7 gods sin god-mode.
  ['admin', 'superadmin'],
  ['gerente_finanzas', 'finanzas_operativo'],
  ['auxiliar_finanzas', 'finanzas_operativo'],
  ['gestor_egresos', 'finanzas_operativo'],
  ['control_depositos_pagos', 'finanzas_operativo'],
  ['coordinador_presupuestos', 'contabilidad'], // sets idénticos → ganancia 0
];

/** Roles que son TAREAS, no puestos. Se marcan tras los renombres. */
const COMPLEMENTOS = ['captura_gastos', 'etiquetas_anaquel', 'analisis_ventas'];

// ── helpers ────────────────────────────────────────────────────────────────

const permisosDe = (row) =>
  new Set(
    Object.entries(row?.permissions ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k),
  );

async function rolDe(knex, tenant, nombre) {
  return knex('identity.role_permissions')
    .where({ tenant_id: tenant })
    .whereRaw('LOWER(role_name) = ?', [nombre.toLowerCase()])
    .first();
}

async function usuariosDe(knex, tenant, nombre) {
  return knex('identity.users')
    .where({ tenant_id: tenant })
    .whereNull('deleted_at')
    .whereRaw('LOWER(role_name) = ?', [nombre.toLowerCase()])
    .pluck('username');
}

/**
 * Rename real: copia la fila con el nombre nuevo, mueve todo lo que apunta a
 * ella y borra la vieja. No se puede hacer con un UPDATE del nombre porque las
 * FK compuestas de `user_roles` y `role_scopes` no traen ON UPDATE CASCADE.
 */
async function renombrar(knex, tenant, de, a) {
  const viejo = await rolDe(knex, tenant, de);
  if (!viejo) return { ok: false, motivo: `"${de}" no existe` };
  const ocupado = await rolDe(knex, tenant, a);
  if (ocupado) return { ok: false, motivo: `"${a}" ya está ocupado` };

  const usuarios = await usuariosDe(knex, tenant, de);
  // Los complementos se leen ANTES de mover a los usuarios. Si se leyeran
  // despues, el trigger de `[ID.13]` ya habria degradado el perfil base viejo a
  // complemento y lo arrastrariamos al nombre nuevo: el rol "retirado" seguiria
  // dandole permisos a esa gente. Lo encontro el `down` de esta migracion, que
  // no pudo renombrar `retirado_admin` porque tenia 2 filas colgando.
  const complementos = await knex('identity.user_roles')
    .where({ tenant_id: tenant, role_name: viejo.role_name, is_primary: false })
    .pluck('user_id');

  await knex('identity.role_permissions').insert({
    tenant_id: tenant,
    role_name: a,
    permissions: JSON.stringify(viejo.permissions ?? {}),
    kind: viejo.kind ?? 'perfil',
    created_at: viejo.created_at,
    created_by: viejo.created_by ?? null,
  });

  // El alcance por default del rol se muda con el rol.
  const scopes = await knex('identity.role_scopes').where({ tenant_id: tenant, role_name: viejo.role_name });
  for (const s of scopes) {
    const { id, ...resto } = s;
    await knex('identity.role_scopes')
      .insert({ ...resto, role_name: a })
      .onConflict(['tenant_id', 'role_name', 'dimension'])
      .ignore();
  }

  // Los usuarios: el trigger de `[ID.13]` mueve solo el perfil base en
  // `user_roles` y degrada el viejo a complemento; esas sobras se limpian abajo.
  if (usuarios.length) {
    await knex('identity.users')
      .where({ tenant_id: tenant })
      .whereRaw('LOWER(role_name) = ?', [de.toLowerCase()])
      .update({ role_name: a });
  }
  // Los complementos genuinos (los de ANTES de mover usuarios) se mudan al
  // nombre nuevo. El perfil base ya lo movio el trigger.
  for (const userId of complementos) {
    await knex('identity.user_roles')
      .insert({ tenant_id: tenant, user_id: userId, role_name: a, is_primary: false })
      .onConflict(['tenant_id', 'user_id', 'role_name'])
      .ignore();
  }
  await knex('identity.user_roles').where({ tenant_id: tenant, role_name: viejo.role_name }).del();
  await knex('identity.role_scopes').where({ tenant_id: tenant, role_name: viejo.role_name }).del();
  await knex('identity.role_permissions').where({ tenant_id: tenant, role_name: viejo.role_name }).del();

  return { ok: true, usuarios: usuarios.length };
}

/** Retira un rol: le libera el nombre y lo saca de los selectores. */
async function retirar(knex, tenant, nombre, motivo) {
  const rol = await rolDe(knex, tenant, nombre);
  if (!rol) return { ok: false, motivo: `"${nombre}" no existe` };
  const usuarios = await usuariosDe(knex, tenant, nombre);
  if (usuarios.length) return { ok: false, motivo: `tiene ${usuarios.length} usuario(s)` };

  const retirado = `retirado_${rol.role_name}`;
  const r = await renombrar(knex, tenant, rol.role_name, retirado);
  if (!r.ok) return r;
  await knex('identity.role_permissions')
    .where({ tenant_id: tenant, role_name: retirado })
    // `activo` NO se escribe: es una columna GENERATED AS (deleted_at IS NULL).
    // Escribirla tira "sólo puede actualizarse a DEFAULT" (mismo patrón que
    // K-debt en catalogs/stores). El soft-delete se hace con `deleted_at`.
    .update({ deleted_at: knex.fn.now() });
  return { ok: true, permisos: permisosDe(rol).size, motivo };
}

/** Fusiona origen→destino con el guard de ganancia máxima. */
async function fusionar(knex, tenant, origen, destino) {
  const o = await rolDe(knex, tenant, origen);
  const d = await rolDe(knex, tenant, destino);
  if (!o) return { ok: false, motivo: `"${origen}" no existe` };
  if (!d) return { ok: false, motivo: `"${destino}" no existe` };

  const so = permisosDe(o);
  const sd = permisosDe(d);
  const union = new Set([...so, ...sd]);
  const ganaOrigen = [...union].filter((p) => !so.has(p));
  const ganaDestino = [...union].filter((p) => !sd.has(p));
  const peor = Math.max(ganaOrigen.length, ganaDestino.length);
  if (peor > MAX_GANANCIA) {
    return {
      ok: false,
      motivo:
        `la fusión le daría ${peor} permisos nuevos a alguien (máx ${MAX_GANANCIA}). ` +
        `origen gana [${ganaOrigen.join(', ')}], destino gana [${ganaDestino.join(', ')}]`,
    };
  }

  const usuarios = await usuariosDe(knex, tenant, origen);
  const complementos = await knex('identity.user_roles')
    .where({ tenant_id: tenant, role_name: o.role_name, is_primary: false })
    .pluck('user_id');
  const permisosUnion = {};
  for (const p of union) permisosUnion[p] = true;
  await knex('identity.role_permissions')
    .where({ tenant_id: tenant, role_name: d.role_name })
    .update({ permissions: JSON.stringify(permisosUnion), updated_at: knex.fn.now() });

  if (usuarios.length) {
    await knex('identity.users')
      .where({ tenant_id: tenant })
      .whereRaw('LOWER(role_name) = ?', [origen.toLowerCase()])
      .update({ role_name: d.role_name });
  }
  await knex('identity.user_roles').where({ tenant_id: tenant, role_name: o.role_name }).del();
  for (const userId of complementos) {
    await knex('identity.user_roles')
      .insert({ tenant_id: tenant, user_id: userId, role_name: d.role_name, is_primary: false })
      .onConflict(['tenant_id', 'user_id', 'role_name'])
      .ignore();
  }
  await knex('identity.role_scopes').where({ tenant_id: tenant, role_name: o.role_name }).del();
  await knex('identity.role_permissions').where({ tenant_id: tenant, role_name: o.role_name }).del();

  return {
    ok: true,
    usuarios: usuarios.length,
    detalle: [...new Set([...ganaOrigen, ...ganaDestino])],
  };
}

// ── migración ──────────────────────────────────────────────────────────────

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').pluck('id');
  const pendientes = [];

  // ── 0. role_permissions.kind ──────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasColumn('role_permissions', 'kind'))) {
    await knex.schema.withSchema('identity').alterTable('role_permissions', (t) => {
      t.string('kind', 20).notNullable().defaultTo('perfil');
    });
    await knex.raw(`
      ALTER TABLE identity.role_permissions ADD CONSTRAINT role_permissions_kind_valido
        CHECK (kind = ANY (ARRAY['perfil','complemento']))`);
    await knex.raw(`COMMENT ON COLUMN identity.role_permissions.kind IS
      '[ID.14] perfil = puesto tipo, uno por cuenta. complemento = tarea que se suma (captura_gastos, etiquetas_anaquel...).'`);
  }

  for (const tenant of tenants) {
    const total0 = await knex('identity.role_permissions')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    console.log(`\n  === tenant ${tenant} · ${total0.n} roles vivos ===`);

    // Los muertos se calculan EN VIVO y no de una lista escrita a mano: una
    // lista queda vieja, y retirar un rol que alguien empezó a usar sería un
    // desastre silencioso. Se protegen los destinos de renombre/fusión.
    //
    // Se protege SOLO el rol-dios. El primer intento protegía también los
    // destinos de renombre, y eso se comía el punto: `contabilidad`, `tesoreria`,
    // `mercadotecnia` y `rh` ERAN roles muertos, y retirarlos es exactamente lo
    // que libera el nombre bueno para el renombre de abajo. Los complementos y
    // cualquier rol con gente no entran en esta lista porque no están muertos.
    const protegidos = new Set([GOD].map((r) => r.toLowerCase()));
    const muertos = await knex.raw(
      `SELECT rp.role_name,
              (SELECT count(*) FROM jsonb_each(rp.permissions) e WHERE e.value = 'true')::int otorgados
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM identity.users u
                           WHERE u.tenant_id = rp.tenant_id AND u.deleted_at IS NULL
                             AND LOWER(u.role_name) = LOWER(rp.role_name))
        ORDER BY otorgados DESC`,
      [tenant],
    );

    console.log(`\n  -- 1. Retirar roles sin usuarios (${muertos.rows.length}) --`);
    for (const m of muertos.rows) {
      if (protegidos.has(m.role_name.toLowerCase())) continue;
      const r = await retirar(knex, tenant, m.role_name, 'sin usuarios');
      console.log(
        r.ok
          ? `     OK  ${m.role_name} (${m.otorgados} permisos otorgados) -> retirado_${m.role_name}`
          : `     --  ${m.role_name}: ${r.motivo}`,
      );
      if (!r.ok) pendientes.push(`retirar ${m.role_name}: ${r.motivo}`);
    }

    console.log(`\n  -- 2. Renombrar a función (sin cambio de permisos) --`);
    for (const [de, a] of RENOMBRAR) {
      const r = await renombrar(knex, tenant, de, a);
      console.log(r.ok ? `     OK  ${de} -> ${a} (${r.usuarios} usuario/s)` : `     --  ${de} -> ${a}: ${r.motivo}`);
      if (!r.ok && !/no existe/.test(r.motivo)) pendientes.push(`renombrar ${de}->${a}: ${r.motivo}`);
    }

    console.log(`\n  -- 3. Fusionar duplicados (guard: máx ${MAX_GANANCIA} permisos ganados) --`);
    for (const [origen, destino] of FUSIONAR) {
      const r = await fusionar(knex, tenant, origen, destino);
      if (r.ok) {
        console.log(
          `     OK  ${origen} -> ${destino} (${r.usuarios} usuario/s)` +
            (r.detalle.length ? ` · suma [${r.detalle.join(', ')}]` : ' · sets idénticos, ganancia 0'),
        );
      } else {
        console.log(`     !!  ${origen} -> ${destino}: ${r.motivo}`);
        if (!/no existe/.test(r.motivo)) pendientes.push(`fusionar ${origen}->${destino}: ${r.motivo}`);
      }
    }

    console.log(`\n  -- 4. Marcar tareas como complemento --`);
    for (const c of COMPLEMENTOS) {
      const rol = await rolDe(knex, tenant, c);
      if (!rol) {
        console.log(`     --  ${c}: no existe`);
        continue;
      }
      await knex('identity.role_permissions')
        .where({ tenant_id: tenant, role_name: rol.role_name })
        .update({ kind: 'complemento', updated_at: knex.fn.now() });
      const conBase = await usuariosDe(knex, tenant, rol.role_name);
      console.log(
        `     OK  ${rol.role_name} (${permisosDe(rol).size} permiso/s) marcado complemento` +
          (conBase.length
            ? ` · OJO ${conBase.length} usuario/s lo tienen como PERFIL BASE (corregir desde la UI)`
            : ''),
      );
    }

    // ── 5. El rol-dios absorbe lo que tenia `admin` ──────────────────────
    // En una corrida limpia esto lo hace el paso 3 (`admin` tiene usuarios, se
    // fusiona con UNION y nadie pierde nada). Pero si `admin` llega al paso 1 ya
    // sin usuarios, se retira como muerto y sus 2 permisos propios
    // (`PORTAL_B2B_ACCESS`, `FINANCE_EXPENSES_VER_ALL`) se quedan afuera: sus ex
    // usuarios PIERDEN dos permisos. Lo detecto `snapshot-user-permissions.js`,
    // que es justamente para lo que existe. Este paso cierra ese hueco en las
    // dos rutas y es idempotente.
    const adminRetirado = await rolDe(knex, tenant, 'retirado_admin');
    if (adminRetirado) {
      const god = await rolDe(knex, tenant, GOD);
      if (god) {
        const union = { ...(god.permissions ?? {}) };
        const suma = [];
        for (const [k, v] of Object.entries(adminRetirado.permissions ?? {})) {
          if (v === true && union[k] !== true) {
            union[k] = true;
            suma.push(k);
          }
        }
        if (suma.length) {
          await knex('identity.role_permissions')
            .where({ tenant_id: tenant, role_name: god.role_name })
            .update({ permissions: JSON.stringify(union), updated_at: knex.fn.now() });
          console.log(`\n  -- 5. "${GOD}" absorbe de "admin": ${suma.join(', ')}`);
        }
      }
    }

    const total1 = await knex('identity.role_permissions')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    const comp = await knex('identity.role_permissions')
      .where({ tenant_id: tenant, kind: 'complemento' })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    console.log(
      `\n  === ${total0.n} -> ${total1.n} roles vivos (${Number(total1.n) - Number(comp.n)} perfiles + ${comp.n} complementos) ===`,
    );
  }

  if (pendientes.length) {
    console.log(`\n  OJO: quedaron ${pendientes.length} pendiente/s (decisión, no error):`);
    pendientes.forEach((p) => console.log(`     · ${p}`));
  }
};

exports.down = async function down(knex) {
  // Los renombres y fusiones NO se revierten automaticamente: revertir una
  // fusion exige saber que usuario venia de que rol. Lo que si se revierte es lo
  // reversible: los roles retirados vuelven a su nombre y quedan vivos.
  //
  // Se usa `renombrar` y NO un UPDATE del nombre, por lo mismo que en el `up`:
  // las FK compuestas de `role_scopes` y `user_roles` no traen ON UPDATE
  // CASCADE, asi que un UPDATE directo revienta (lo vivio este mismo down).
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    const retirados = await knex('identity.role_permissions')
      .where({ tenant_id: tenant })
      .whereRaw('role_name LIKE ?', ['retirado\_%'])
      .pluck('role_name');
    for (const nombre of retirados) {
      const original = nombre.replace(/^retirado_/, '');
      const r = await renombrar(knex, tenant, nombre, original);
      console.log(r.ok ? `  OK  restaurado "${original}"` : `  --  "${original}": ${r.motivo}`);
    }
  }
  console.log('  [ID.14] down: retirados restaurados. Renombres/fusiones NO (ver el log del up).');
};
