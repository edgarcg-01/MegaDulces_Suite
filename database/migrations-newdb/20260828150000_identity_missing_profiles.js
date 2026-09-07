'use strict';
/**
 * `[ID.17]` — Los perfiles que faltaban (Fase ID / esquema CRM-ERP).
 *
 * Cierra cuatro huecos que `[ID.14]` dejo reportados en vez de tapar a ciegas:
 *
 *  1. **27 personas tienen una TAREA como perfil base** (22 `captura_gastos`,
 *     3 `analisis_ventas`, 2 `etiquetas_anaquel`). Se les da un perfil de verdad
 *     y su rol viejo queda como **complemento**. Los perfiles nuevos nacen con
 *     **CERO permisos a proposito**: esa gente hoy no tiene ningun otro acceso, y
 *     darles uno "parecido al de al lado" seria repartir permisos que nadie
 *     eligio. El efecto para ellos es **exactamente el mismo de hoy**; lo que
 *     cambia es que el padron ya dice la verdad y que ampliarles el acceso es
 *     editar UN perfil, no 22 usuarios.
 *
 *  2. **`direccion`**: lectura global sin gestion. Hoy la unica forma de ver todo
 *     es `superadmin`, que es ver todo **con escritura**. El set se calcula del
 *     catalogo vivo (claves de lectura), no de una lista escrita a mano que
 *     quedaria vieja al agregar un modulo.
 *
 *  3. **`auditor_externo`**: lectura de contabilidad y finanzas, `kind='externo'`
 *     y **con vencimiento** (`users.expires_at`, que corta en el login desde
 *     `[ID.13]`). El contador de la Fase CP es externo y no tenia forma de entrar
 *     que no fuera prestarle una cuenta interna.
 *
 *  4. **Cuenta de servicio**: `kind='servicio'` + `svc_feeds`. Los feeds escriben
 *     como superusuario de Postgres, sin identidad (`created_by` vacio en los
 *     117 usuarios). Esta migracion crea la identidad y el login la RECHAZA
 *     (auth-mt): una cuenta de servicio no debe poder entrar con contrasena.
 *
 * Lo que NO se hace, con motivo:
 *   - **`proveedor` y `rh` no se crean.** No hay portal de proveedor ni modulo de
 *     asistencia; serian roles muertos, justo lo que `[ID.14]` acabo de limpiar.
 *   - **Los 20 puestos sin perfil siguen sin perfil.** Inventarles un set de
 *     permisos es exactamente lo que llevo a 47 roles. Quedan listados y se
 *     asignan desde la UI cuando exista la decision.
 *
 * Verificable con `snapshot-user-permissions.js`: el criterio es **0 PIERDE y 0
 * GANA** — esta migracion no le mueve el acceso a nadie.
 *
 * @param { import("knex").Knex } knex
 */

/** Claves que implican ESCRIBIR, aunque el nombre lleve VER. */
const ESCRITURA =
  /GESTIONAR|CREAR|EDITAR|BORRAR|APROBAR|CONFIRMAR|CANCELAR|FULFILL|CAPTURAR|REGISTRAR|AJUSTAR|ASIGNAR|CONTAR|RECIBIR|RECONCILIAR|OPERATE|_USE|PASSWORDS|CONFIGURAR|REVERSAR|VERIFICAR|DESPACHAR|SUPERVISAR|ACCESS|REFRESH|LIQUIDATION|NOTIFICAR/;

/** Perfiles nuevos para los que hoy tienen una tarea como perfil base. */
const REBASE = [
  // [rol_tarea, perfil_nuevo, nombre_legible_del_perfil]
  ['captura_gastos', 'administrativo', 'administracion'],
  ['analisis_ventas', 'administrativo', 'administracion'],
  ['etiquetas_anaquel', 'piso_tienda', 'tienda'],
];

const DIMENSIONES = ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'];

/** Crea un rol si no existe. Idempotente. */
async function crearRol(knex, tenant, nombre, permisos, kind = 'perfil') {
  const existe = await knex('identity.role_permissions')
    .where({ tenant_id: tenant })
    .whereRaw('LOWER(role_name) = ?', [nombre.toLowerCase()])
    .first('role_name', 'deleted_at');
  if (existe) {
    // Si estaba retirado se reactiva; si no, se deja como esta (no se pisan
    // permisos que alguien pudo haber ajustado desde /admin/roles).
    if (existe.deleted_at) {
      await knex('identity.role_permissions')
        .where({ tenant_id: tenant, role_name: existe.role_name })
        .update({ deleted_at: null });
      return { creado: false, reactivado: true, nombre: existe.role_name };
    }
    return { creado: false, reactivado: false, nombre: existe.role_name };
  }
  const mapa = {};
  for (const p of permisos) mapa[p] = true;
  await knex('identity.role_permissions').insert({
    tenant_id: tenant,
    role_name: nombre,
    permissions: JSON.stringify(mapa),
    kind,
  });
  return { creado: true, reactivado: false, nombre };
}

/**
 * Alcance por default de un rol. `mode_write` explicito: es lo que permite
 * expresar "ve toda la red pero no escribe en ninguna parte", que es
 * exactamente lo que necesita direccion y lo que hoy no se podia decir.
 */
async function fijarAlcance(knex, tenant, rol, mode, modeWrite, nota) {
  for (const dim of DIMENSIONES) {
    const fila = {
      tenant_id: tenant,
      role_name: rol,
      dimension: dim,
      mode,
      mode_write: modeWrite,
      nota,
    };
    await knex('identity.role_scopes')
      .insert(fila)
      .onConflict(['tenant_id', 'role_name', 'dimension'])
      .merge(fila);
  }
}

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').pluck('id');

  for (const tenant of tenants) {
    console.log(`\n  === tenant ${tenant} ===`);

    // Catalogo vivo de claves: el set de lectura se DERIVA, no se escribe a mano.
    const claves = (
      await knex.raw(
        `SELECT DISTINCT e.key k FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
          WHERE rp.tenant_id = ? ORDER BY 1`,
        [tenant],
      )
    ).rows.map((r) => r.k);
    const lectura = claves.filter((k) => /(^VER_|_VER$|_VER_)/.test(k) && !ESCRITURA.test(k));
    const lecturaFinanzas = lectura.filter((k) => /^(FISCAL_|FINANCE_|RECONCILIATION_)/.test(k));

    // ── 1. Perfil de verdad para los que tienen una TAREA como perfil base ──
    console.log(`\n  -- 1. Re-basar a los que tienen una tarea como perfil base --`);
    for (const [tarea, perfil] of REBASE) {
      const rolTarea = await knex('identity.role_permissions')
        .where({ tenant_id: tenant })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) = ?', [tarea.toLowerCase()])
        .first('role_name');
      if (!rolTarea) {
        console.log(`     --  ${tarea}: no existe en este tenant`);
        continue;
      }
      const gente = await knex('identity.users')
        .where({ tenant_id: tenant })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) = ?', [rolTarea.role_name.toLowerCase()])
        .pluck('username');
      if (!gente.length) {
        console.log(`     --  ${tarea}: ya nadie lo tiene como perfil base`);
        continue;
      }

      const r = await crearRol(knex, tenant, perfil, [], 'perfil');
      if (r.creado) console.log(`     OK  perfil "${perfil}" creado (0 permisos: hoy esa gente no tiene otro acceso)`);

      // El UPDATE dispara el trigger de `[ID.13]`, que degrada el perfil base
      // anterior a COMPLEMENTO en vez de borrarlo. O sea: la tarea se conserva y
      // el acceso efectivo no cambia. Ese comportamiento del trigger es justo lo
      // que hace que esto sea un cambio de forma y no de permisos.
      await knex('identity.users')
        .where({ tenant_id: tenant })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) = ?', [rolTarea.role_name.toLowerCase()])
        .update({ role_name: perfil });

      console.log(`     OK  ${gente.length} usuario/s: perfil base "${perfil}" + complemento "${rolTarea.role_name}"`);
    }

    // ── 2. direccion: ve todo, no escribe nada ──────────────────────────────
    console.log(`\n  -- 2. Perfil "direccion" (lectura global) --`);
    const rDir = await crearRol(knex, tenant, 'direccion', lectura, 'perfil');
    console.log(
      rDir.creado
        ? `     OK  "direccion" creado con ${lectura.length} permisos de LECTURA (de ${claves.length} del catalogo)`
        : `     --  "direccion" ya existia${rDir.reactivado ? ' (reactivado)' : ''}`,
    );
    await fijarAlcance(knex, tenant, 'direccion', 'all', 'none', '[ID.17] ve toda la red, no escribe en ninguna parte');
    console.log(`     OK  alcance: las 6 dimensiones en "all" con escritura "none"`);

    // ── 3. auditor_externo: contabilidad y finanzas, con vencimiento ─────────
    console.log(`\n  -- 3. Perfil "auditor_externo" --`);
    const rAud = await crearRol(knex, tenant, 'auditor_externo', lecturaFinanzas, 'perfil');
    console.log(
      rAud.creado
        ? `     OK  "auditor_externo" creado con ${lecturaFinanzas.length} permisos (fiscal + finanzas, solo lectura)`
        : `     --  "auditor_externo" ya existia${rAud.reactivado ? ' (reactivado)' : ''}`,
    );
    await fijarAlcance(knex, tenant, 'auditor_externo', 'all', 'none', '[ID.17] externo con vencimiento: users.expires_at');

    // ── 4. Cuenta de servicio ───────────────────────────────────────────────
    // Los feeds escriben como superusuario de Postgres, sin identidad. Esto crea
    // la identidad; el login la rechaza por `kind` (auth-mt), y el hash es
    // deliberadamente INVALIDO como bcrypt para que ninguna contrasena matchee
    // aunque el chequeo por kind se cayera.
    console.log(`\n  -- 4. Cuenta de servicio para los feeds --`);
    const rSvc = await crearRol(knex, tenant, 'servicio', [], 'perfil');
    if (rSvc.creado) console.log(`     OK  perfil "servicio" creado (0 permisos: los feeds no pasan por el guard HTTP)`);
    const yaSvc = await knex('identity.users')
      .where({ tenant_id: tenant, username: 'svc_feeds' })
      .first('id');
    if (!yaSvc) {
      const [nuevo] = await knex('identity.users')
        .insert({
          tenant_id: tenant,
          username: 'svc_feeds',
          nombre: 'Feeds y tareas programadas',
          password_hash: 'servicio-sin-login',
          role_name: 'servicio',
          kind: 'servicio',
          department_code: 'sistemas',
        })
        .returning(['id']);
      console.log(`     OK  cuenta "svc_feeds" creada (kind=servicio, sin login posible): ${nuevo.id}`);
      console.log(`         Los importers pueden usar este id como created_by/updated_by.`);
    } else {
      await knex('identity.users').where({ id: yaSvc.id }).update({ kind: 'servicio' });
      console.log(`     --  "svc_feeds" ya existia (kind normalizado a servicio)`);
    }

    // ── 4b. Los puestos que ya tienen donde caer ────────────────────────────
    // Con `piso_tienda` y `administrativo` creados, 8 de los 20 puestos sin
    // perfil ya tienen uno. Y como los dos perfiles nacen con CERO permisos,
    // esto no le inventa acceso a nadie: le da al alta un lugar donde aterrizar
    // y un solo lugar donde otorgar cuando se decida.
    const NUEVO_DEFAULT = [
      ['auxiliar_piso_venta', 'piso_tienda'],
      ['anaquelista', 'piso_tienda'],
      ['empaquetador', 'piso_tienda'],
      ['surtidor_tienda', 'piso_tienda'],
      ['vendedor_piso', 'piso_tienda'],
      ['vendedor_promociones', 'piso_tienda'],
      ['auxiliar_administrativo', 'administrativo'],
      ['auxiliar_mkt', 'administrativo'],
    ];
    let asignados = 0;
    for (const [puesto, perfil] of NUEVO_DEFAULT) {
      const n = await knex('identity.positions')
        .where({ tenant_id: tenant, code: puesto })
        .whereNull('deleted_at')
        .whereNull('default_role')
        .update({ default_role: perfil, updated_at: knex.fn.now() });
      asignados += n;
    }
    if (asignados) console.log(`\n  -- 4b. ${asignados} puesto/s ahora proponen un perfil (piso_tienda / administrativo) --`);

    // ── 5. Lo que sigue faltando, listado ───────────────────────────────────
    const sinPerfil = await knex('identity.positions')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .whereNull('default_role')
      .orderBy('orden')
      .pluck('code');
    if (sinPerfil.length) {
      console.log(`\n  -- 5. ${sinPerfil.length} puesto/s siguen sin perfil (decision, no codigo) --`);
      console.log(`     ${sinPerfil.join(', ')}`);
      console.log(`     Se asignan desde /admin/usuarios cuando exista el criterio. Inventarles`);
      console.log(`     un set de permisos es lo que llevo a 47 roles.`);
    }

    const resumen = await knex.raw(
      `SELECT count(*) FILTER (WHERE kind = 'perfil') perfiles,
              count(*) FILTER (WHERE kind = 'complemento') complementos
         FROM identity.role_permissions WHERE tenant_id = ? AND deleted_at IS NULL`,
      [tenant],
    );
    console.log(
      `\n  === catalogo: ${resumen.rows[0].perfiles} perfiles + ${resumen.rows[0].complementos} complementos ===`,
    );
  }
};

exports.down = async function down(knex) {
  // Los roles nuevos se retiran (soft-delete) en vez de borrarse: si alguien ya
  // los tiene asignados, borrarlos se lo llevaria por CASCADE.
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    for (const rol of ['direccion', 'auditor_externo']) {
      const gente = await knex('identity.users')
        .where({ tenant_id: tenant })
        .whereNull('deleted_at')
        .whereRaw('LOWER(role_name) = ?', [rol])
        .count('* as n')
        .first();
      if (Number(gente.n) > 0) {
        console.log(`  --  "${rol}" tiene ${gente.n} usuario/s: se deja`);
        continue;
      }
      await knex('identity.role_permissions')
        .where({ tenant_id: tenant })
        .whereRaw('LOWER(role_name) = ?', [rol])
        .update({ deleted_at: knex.fn.now() });
      console.log(`  OK  "${rol}" retirado`);
    }
  }
  console.log('  [ID.17] down: el re-basado de los 27 NO se revierte (ver identity.user_roles).');
};
