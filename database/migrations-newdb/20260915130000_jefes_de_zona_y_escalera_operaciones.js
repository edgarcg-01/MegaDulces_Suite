/**
 * `[AU.18]` — Los tres jefes de zona, y la escalera de operaciones.
 *
 * ── Qué se corrige, dicho por Dirección el 2026-09-15 ──────────────────────
 *
 *  1. **`jefe_zona` estaba VACANTE** y de él cuelgan 7 puestos, entre ellos
 *     `encargado_sucursal` (6 personas) y `encargado_operaciones`. Ése era el
 *     motivo real de que 29 personas «no tuvieran jefe»: el nodo del medio no
 *     tenía a nadie. Lo ocupan Ivette Cruz (La Piedad), Aaron Alejo (Morelia) y
 *     José Ramón Rodríguez (Zamora).
 *  2. **Dos de ellos tenían mal la zona.** Alejo figuraba en OFICINAS y Ramón en
 *     CANINDO, los dos por default. Pertenecen a Morelia y a Zamora.
 *  3. **La escalera García → Piceno → Alejo** se declara donde corresponde: entre
 *     PUESTOS. `auxiliar_compras` pasa a reportar a `encargado_operaciones`, que
 *     ya reportaba a `jefe_zona`.
 *
 * ⚠️ **Arrastra a los otros 3 auxiliares de compras** (Gerardo Ramírez, Juan
 * Elizarraras, Mario Ventura), que dejan de colgar de Gerente de compras.
 * Decidido explícitamente: la cadena es del puesto, no de la persona.
 *
 * ⚠️ **Alejo y Ramón quedan con desvío.** `jefe_zona` propone `supervisor_ventas`
 * y ellos conservan `superadmin` porque siguen siendo Sistemas. El perfil NO se
 * toca acá; el desvío se asienta con su motivo, que es exactamente lo que `[OR.2]`
 * pide y lo que distingue una decisión de un descuido.
 *
 * ⛔ Aborta si algo no está como se midió. No inventa: si una persona no existe,
 * si el puesto no existe o si al mover a Ivette el almacén 03 se queda sin
 * encargado, la migración falla entera.
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

const JEFES = [
  { username: 'ivette_cruz', zona: 'LA PIEDAD RD', desde: 'encargado_sucursal' },
  { username: 'aaron_alejo', zona: 'MORELIA ABASTOS', desde: 'sistemas' },
  { username: 'ramon_rodriguez', zona: 'ZAMORA', desde: 'sistemas' },
];

const MOTIVO =
  'Ocupa la jefatura de zona de su plaza. Conserva su perfil actual: el que el puesto propone ' +
  '(supervisor_ventas) le quitaría accesos que necesita por su área. Decidido por Dirección, 2026-09-15.';

exports.up = async function up(knex) {
  const puesto = await knex('identity.positions')
    .where({ tenant_id: TENANT, code: 'jefe_zona' })
    .whereNull('deleted_at')
    .first('code', 'default_role');
  if (!puesto) throw new Error('[AU.18] El puesto "jefe_zona" no existe: nada que ocupar.');

  const ops = await knex('identity.positions')
    .where({ tenant_id: TENANT, code: 'encargado_operaciones' })
    .whereNull('deleted_at')
    .first('code');
  if (!ops) throw new Error('[AU.18] El puesto "encargado_operaciones" no existe.');

  // ── 1. Los tres jefes ────────────────────────────────────────────────────
  let movidos = 0;
  for (const j of JEFES) {
    const u = await knex('identity.users')
      .where({ tenant_id: TENANT, username: j.username })
      .whereNull('deleted_at')
      .first('id', 'username', 'role_name', 'position_code', 'zona_id');
    if (!u) throw new Error(`[AU.18] No existe la persona "${j.username}".`);

    const z = await knex('trade.zones')
      .where({ tenant_id: TENANT, name: j.zona })
      .whereNull('deleted_at')
      .first('id', 'name');
    if (!z) throw new Error(`[AU.18] No existe la zona "${j.zona}".`);
    if (u.position_code === 'jefe_zona' && u.zona_id === z.id) continue;

    const zonaAntes = u.zona_id;
    await knex('identity.users')
      .where({ id: u.id })
      .update({ position_code: 'jefe_zona', zona_id: z.id, updated_at: knex.fn.now() });
    movidos += 1;

    await knex('identity.user_events').insert({
      tenant_id: TENANT,
      user_id: u.id,
      event: 'puesto_asignado',
      detalle: JSON.stringify({
        de: u.position_code,
        a: 'jefe_zona',
        zona_de: zonaAntes,
        zona_a: z.id,
        zona_nombre: z.name,
        origen: 'migracion_AU.18',
      }),
      actor_username: 'migracion [AU.18]',
    });

    // El desvío se asienta SIEMPRE que el perfil no sea el que el puesto propone.
    if (
      puesto.default_role &&
      String(u.role_name ?? '').toLowerCase() !== String(puesto.default_role).toLowerCase()
    ) {
      await knex('identity.user_events').insert({
        tenant_id: TENANT,
        user_id: u.id,
        event: 'desvio_de_puesto',
        detalle: JSON.stringify({
          position_code: 'jefe_zona',
          propone: puesto.default_role,
          elegido: u.role_name,
          motivo: MOTIVO,
          origen: 'migracion_AU.18',
        }),
        actor_username: 'migracion [AU.18]',
      });
    }
  }

  // ── 2. La escalera ───────────────────────────────────────────────────────
  const aux = await knex('identity.positions')
    .where({ tenant_id: TENANT, code: 'auxiliar_compras' })
    .whereNull('deleted_at')
    .first('code', 'reports_to_position_code');
  if (!aux) throw new Error('[AU.18] El puesto "auxiliar_compras" no existe.');

  let cadena = 0;
  if (aux.reports_to_position_code !== 'encargado_operaciones') {
    await knex('identity.positions')
      .where({ tenant_id: TENANT, code: 'auxiliar_compras' })
      .update({ reports_to_position_code: 'encargado_operaciones', updated_at: knex.fn.now() });
    cadena = 1;
  }

  // ── 3. Los candados ──────────────────────────────────────────────────────
  const { rows: guardia } = await knex.raw(
    `SELECT
       (SELECT count(*)::int FROM identity.users u
         WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.position_code = 'encargado_sucursal'
           AND u.warehouse_code = '03') AS encargados_del_03,
       (SELECT count(DISTINCT u.zona_id)::int FROM identity.users u
         WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.position_code = 'jefe_zona') AS zonas_con_jefe,
       (SELECT count(*)::int FROM identity.users u
         WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.position_code = 'jefe_zona') AS jefes`,
    [TENANT, TENANT, TENANT],
  );
  const g = guardia[0];

  if (g.encargados_del_03 < 1) {
    throw new Error(
      '[AU.18] Al mover a Ivette, el almacén 03 se quedó sin encargado de sucursal. Se revierte.',
    );
  }
  if (g.jefes !== g.zonas_con_jefe) {
    throw new Error(
      `[AU.18] Hay ${g.jefes} jefe(s) de zona repartidos en ${g.zonas_con_jefe} zona(s): dos jefes ` +
        `en la misma zona dejan «¿quién manda acá?» con dos respuestas.`,
    );
  }

  const { rows: alcance } = await knex.raw(
    `SELECT z.name AS zona,
            (SELECT string_agg(u.username, ', ') FROM identity.users u
              WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.position_code = 'jefe_zona'
                AND u.zona_id = z.id) AS jefe,
            count(*)::int AS gente
       FROM identity.users u2
       JOIN trade.zones z ON z.id = u2.zona_id
      WHERE u2.tenant_id = ? AND u2.deleted_at IS NULL AND u2.kind = 'interno'
      GROUP BY z.id, z.name ORDER BY 3 DESC`,
    [TENANT, TENANT],
  );

  console.log(`[AU.18] ${movidos} persona(s) a jefe_zona · ${cadena} arista de mando movida.`);
  for (const a of alcance) {
    console.log(`  ${String(a.zona).padEnd(19)} jefe: ${a.jefe ?? '(ninguno)'} · ${a.gente} persona(s)`);
  }
};

exports.down = async function down(knex) {
  // Se revierte por lo que la migración hizo, no por regla: cada uno vuelve a su
  // puesto anterior según el evento que quedó asentado.
  for (const j of JEFES) {
    const u = await knex('identity.users')
      .where({ tenant_id: TENANT, username: j.username })
      .first('id');
    if (!u) continue;
    const ev = await knex('identity.user_events')
      .where({ tenant_id: TENANT, user_id: u.id, event: 'puesto_asignado' })
      .whereRaw(`detalle ->> 'origen' = 'migracion_AU.18'`)
      .orderBy('created_at', 'desc')
      .first('detalle');
    if (!ev) continue;
    const d = typeof ev.detalle === 'string' ? JSON.parse(ev.detalle) : ev.detalle;
    await knex('identity.users')
      .where({ id: u.id })
      .update({ position_code: d.de, zona_id: d.zona_de, updated_at: knex.fn.now() });
  }
  await knex('identity.positions')
    .where({ tenant_id: TENANT, code: 'auxiliar_compras' })
    .update({ reports_to_position_code: 'gerente_compras', updated_at: knex.fn.now() });
};
