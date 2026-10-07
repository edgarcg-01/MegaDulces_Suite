'use strict';
/**
 * `[OR.7.0b]` — El puesto puede proponer un perfil COMPUESTO.
 *
 * ── El hueco del modelo ─────────────────────────────────────────────────────────────────────
 * `positions.default_role` es **singular**. Pero medido en prod: **las 3 personas de
 * `auxiliar_administrativo` tienen las 3 el mismo complemento `analisis_ventas`**. Eso ya no es una
 * excepción por persona: es **el perfil del puesto**, viviendo como tres filas idénticas en
 * `identity.user_roles`. Y la cuarta persona que entre a ese puesto **no lo hereda**, porque el
 * puesto no sabe expresarlo.
 *
 * ── La regla, y su umbral ───────────────────────────────────────────────────────────────────
 * **Un complemento que tienen TODAS las personas de un puesto sube al puesto.**
 *
 * ⚠️ Con un umbral, porque la regla tiene una trampa: con **una sola persona en el puesto, «todas»
 * es trivialmente cierto** y no distingue un perfil de una excepción. Medido, hay dos casos:
 *
 *     auxiliar_administrativo + analisis_ventas   3 de 3   -> sube (evidencia real)
 *     tesoreria               + analisis_ventas   1 de 1   -> NO sube, se DECLARA
 *
 * El backfill exige **n ≥ 2**. Lo de n = 1 se imprime para que alguien lo decida, no se asume.
 *
 * ── Lo que esto NO hace ─────────────────────────────────────────────────────────────────────
 * ⛔ **No otorga ni revoca un solo permiso.** Quien concede sigue siendo
 * `identity.role_permissions` + `identity.user_roles`; el puesto sólo **propone** qué debería
 * llevar quien lo ocupe. Y por eso **las filas de `user_roles` NO se borran**: borrarlas al declarar
 * el complemento en el puesto le quitaría el permiso a las 3 personas en el acto.
 *
 * ── Por qué un trigger y no una FK ──────────────────────────────────────────────────────────
 * Postgres no admite una FK compuesta desde un `text[]`. La garantía equivalente —que cada
 * complemento exista en el catálogo de roles del mismo tenant— se hace con un trigger. Sin eso, el
 * puesto podría proponer un rol inexistente y el alta reventaría al confirmarlo, que es justo lo que
 * `[ID.15]` evitó poniéndole FK a `default_role`.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** Con menos personas que esto, «todas lo tienen» no dice nada. */
const MINIMO_PARA_SUBIR = 2;

exports.up = async function up(knex) {
  // ── 1. La columna ─────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasColumn('positions', 'default_complements'))) {
    await knex.raw(`SET LOCAL lock_timeout = '3s'`);
    await knex.raw(
      `ALTER TABLE identity.positions
         ADD COLUMN default_complements text[] NOT NULL DEFAULT '{}'::text[]`);
    console.log('  [OR.7.0b] + identity.positions.default_complements');
  }
  await knex.raw(`COMMENT ON COLUMN identity.positions.default_complements IS
    '[OR.7.0b] Roles COMPLEMENTARIOS que este puesto propone, ademas de default_role. PROPONE, no otorga: quien concede sigue siendo role_permissions + user_roles. Nace de la regla "un complemento que tienen TODAS las personas de un puesto es el perfil del puesto, no una excepcion" (umbral n>=2: con una sola persona, "todas" es trivialmente cierto).'`);

  // ── 2. El trigger que hace de FK ──────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.positions_complementos_existen() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = identity, public AS $fn$
    DECLARE
      faltante text;
    BEGIN
      IF NEW.default_complements IS NULL OR array_length(NEW.default_complements, 1) IS NULL THEN
        RETURN NEW;
      END IF;
      SELECT c INTO faltante
        FROM unnest(NEW.default_complements) AS c
       WHERE NOT EXISTS (
         SELECT 1 FROM identity.role_permissions rp
          WHERE rp.tenant_id = NEW.tenant_id AND rp.role_name = c AND rp.deleted_at IS NULL)
       LIMIT 1;
      IF faltante IS NOT NULL THEN
        RAISE EXCEPTION
          'el puesto % propone el complemento "%" y ese rol no existe en el catalogo', NEW.code, faltante
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      IF NEW.default_role IS NOT NULL AND NEW.default_role = ANY(NEW.default_complements) THEN
        RAISE EXCEPTION
          'el puesto % repite su perfil base "%" como complemento', NEW.code, NEW.default_role
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$`);

  const trg = await knex.raw(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.positions'::regclass
      AND tgname = 'trg_positions_complementos_existen'`);
  if (!trg.rows.length) {
    await knex.raw(`
      CREATE TRIGGER trg_positions_complementos_existen
        BEFORE INSERT OR UPDATE OF default_complements, default_role ON identity.positions
        FOR EACH ROW EXECUTE FUNCTION identity.positions_complementos_existen()`);
    console.log('  [OR.7.0b] + trigger trg_positions_complementos_existen');
  }

  // ── 3. El backfill de la regla ────────────────────────────────────────────
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');
  for (const tenant of tenants) {
    const candidatos = await knex.raw(
      `WITH gente AS (
         SELECT position_code p, count(*)::int n
           FROM identity.users
          WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND kind = 'interno'
            AND position_code IS NOT NULL
          GROUP BY 1),
       comp AS (
         SELECT u.position_code p, ur.role_name c, count(*)::int n
           FROM identity.user_roles ur
           JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
          WHERE ur.tenant_id = ? AND ur.role_name <> u.role_name
            AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
          GROUP BY 1, 2)
       SELECT comp.p AS puesto, comp.c AS complemento, comp.n AS con_el, gente.n AS total
         FROM comp JOIN gente ON gente.p = comp.p
        WHERE comp.n = gente.n
        ORDER BY gente.n DESC, comp.p`,
      [tenant, tenant]);

    const suben = candidatos.rows.filter((r) => r.total >= MINIMO_PARA_SUBIR);
    const debiles = candidatos.rows.filter((r) => r.total < MINIMO_PARA_SUBIR);

    for (const r of suben) {
      await knex.raw(
        `UPDATE identity.positions
            SET default_complements = (
                  SELECT array_agg(DISTINCT x) FROM unnest(default_complements || ARRAY[?::text]) AS x),
                updated_at = now()
          WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL
            AND NOT (? = ANY(default_complements))`,
        [r.complemento, tenant, r.puesto, r.complemento]);
      console.log(`  [OR.7.0b] ${r.puesto} + ${r.complemento}  (lo tienen ${r.con_el}/${r.total})`);
    }
    if (!suben.length) console.log('  [OR.7.0b] ningún complemento alcanzó el umbral');

    debiles.forEach((r) =>
      console.log(
        `  [OR.7.0b] DECLARADO, no se sube: ${r.puesto} + ${r.complemento} — lo tiene ${r.con_el}/${r.total}. ` +
        `Con una sola persona no se distingue el perfil del puesto de una excepción suya.`));

    // ⚠️ Las filas de user_roles NO se tocan: son las que CONCEDEN.
    const conservadas = await knex.raw(
      `SELECT count(*)::int n FROM identity.user_roles ur
         JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
        WHERE ur.tenant_id = ? AND ur.role_name <> u.role_name`, [tenant]);
    console.log(
      `  [OR.7.0b] ${conservadas.rows[0].n} fila/s de user_roles CONSERVADAS: el puesto propone, ` +
      `ellas conceden. Borrarlas quitaría el permiso en el acto.`);

    const foto = await knex.raw(
      `SELECT code, default_role, default_complements
         FROM identity.positions
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND array_length(default_complements, 1) IS NOT NULL
        ORDER BY code`, [tenant]);
    console.log(`  [OR.7.0b] ${foto.rows.length} puesto/s proponen perfil compuesto:`);
    foto.rows.forEach((r) =>
      console.log(`     · ${String(r.code).padEnd(26)} ${r.default_role} + [${r.default_complements.join(', ')}]`));
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_positions_complementos_existen ON identity.positions`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.positions_complementos_existen()`);
  await knex('identity.positions').update({ default_complements: knex.raw(`'{}'::text[]`) });
  // La columna no se borra (regla del proyecto).
  console.log('  [OR.7.0b] down: trigger y contenido retirados. La columna se conserva.');
};
