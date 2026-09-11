'use strict';
/**
 * `[OR.1a]` — La cadena de mando pasa a vivir entre PUESTOS, no entre personas.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 * Hoy el único jefe que el sistema conoce es `identity.users.supervisor_id`, persona a persona.
 * Medido en prod (2026-09-11): **30 filas con jefe, 4 jefes distintos, UN SOLO NIVEL, y ningún
 * jefe tiene jefe.** Por departamento:
 *
 *     ruta_directa    24 / 27      <- lo único cubierto
 *     cajas            0 / 19
 *     administracion   0 / 17
 *     operaciones      0 / 10
 *     tienda           0 /  9
 *     sistemas         0 /  9
 *     almacen          0 /  3   ·  telemarketing 0/3  ·  logistica 0/2
 *
 * Con 76 personas sin jefe, un escalamiento no tiene a dónde ir y «asignarle trabajo al jefe de
 * Fulano» no es una consulta posible. Atar el jefe al PUESTO lo arregla de raíz: 100 personas
 * heredan de 43 puestos en vez de que cada alta tenga que acordarse de apuntar a un humano.
 * `supervisor_id` NO se borra ni se vacía — baja de categoría a **excepción por persona**.
 *
 * ── Lo que esta migración NO hace: dibujar el organigrama ────────────────────────────────────
 * Se midió qué pares (puesto del jefe <- puesto del subordinado) implica hoy `supervisor_id`:
 *
 *     29  supervisor_rd  <-  vendedor_ruta        (tres supervisores: 13 + 10 + 6)
 *      1  encargado_tienda(tania_sanchez) <- vendedor_ruta   <- anomalía, ver abajo
 *
 * **Eso es TODO lo que el dato sostiene.** Sembrar el resto sería inventar el organigrama de la
 * empresa desde un editor de texto, que es exactamente lo que la regla del proyecto prohíbe
 * («nunca adivinar una fuente — investigarla y verificarla»). Así que acá va **el mecanismo**
 * (columna + FK + candado anti-ciclo) más **la única arista probada**, y el resto se imprime como
 * hoja de trabajo para decidir con el lead, puesto por puesto.
 *
 * ⚠️ La anomalía que queda reportada y sin tocar: `tania_sanchez` es encargada de tienda y
 * aparece como jefa de un `vendedor_ruta` (`benjamin_alonso`). Puede ser un dato viejo o una
 * excepción real. Justo para eso sobrevive `supervisor_id`.
 *
 * ── El candado ──────────────────────────────────────────────────────────────────────────────
 * Un ciclo en la cadena (A reporta a B, B reporta a A) colgaría a cualquier recorrido que suba
 * buscando al jefe. Se previene en DOS niveles, porque el CHECK sólo ve la fila:
 *   · CHECK  `code <> reports_to_position_code`  -> el auto-reporte directo.
 *   · TRIGGER que recorre la cadena hacia arriba -> el ciclo indirecto A->B->C->A.
 * ADR-056: **un gate sin prueba negativa es una intención.** El smoke de esta etapa mete un ciclo
 * a propósito y verifica el rechazo.
 *
 * La función es SECURITY DEFINER con filtro EXPLÍCITO por `NEW.tenant_id`: `identity.positions`
 * tiene FORCE ROW LEVEL SECURITY, y un candado que no ve las filas no encuentra el ciclo — se
 * pondría verde por ceguera, que es el defecto que ADR-056 vino a matar.
 *
 * Aditiva e idempotente. No toca personas ni permisos.
 *
 * @param { import("knex").Knex } knex
 */

/** La única arista que el dato prueba. [puesto, reporta_a] */
const ARISTAS_PROBADAS = [['vendedor_ruta', 'supervisor_rd']];

exports.up = async function up(knex) {
  // ── 1. La columna ─────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasColumn('positions', 'reports_to_position_code'))) {
    await knex.raw(`SET LOCAL lock_timeout = '3s'`);
    await knex.raw(`ALTER TABLE identity.positions ADD COLUMN reports_to_position_code varchar(50)`);
    console.log('  [OR.1a] + identity.positions.reports_to_position_code');
  }
  await knex.raw(`COMMENT ON COLUMN identity.positions.reports_to_position_code IS
    '[OR.1] Puesto al que reporta este puesto. La cadena de mando vive ENTRE PUESTOS; identity.users.supervisor_id queda como EXCEPCION por persona. NULL = todavia no se decidio (ver la hoja de trabajo de la migracion), NO "no tiene jefe".'`);

  // FK compuesta: un jefe que no existe sería una cadena rota al recorrerla.
  const fk = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'positions_reports_to_fk'`);
  if (!fk.rows.length) {
    await knex.raw(`
      ALTER TABLE identity.positions
        ADD CONSTRAINT positions_reports_to_fk
        FOREIGN KEY (tenant_id, reports_to_position_code)
        REFERENCES identity.positions (tenant_id, code)
        ON DELETE SET NULL`);
    console.log('  [OR.1a] + FK positions_reports_to_fk');
  }

  const chk = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'positions_no_autoreporte'`);
  if (!chk.rows.length) {
    await knex.raw(`
      ALTER TABLE identity.positions
        ADD CONSTRAINT positions_no_autoreporte
        CHECK (reports_to_position_code IS NULL OR reports_to_position_code <> code)`);
    console.log('  [OR.1a] + CHECK positions_no_autoreporte');
  }

  // ── 2. El candado anti-ciclo ──────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.positions_sin_ciclo() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = identity, public AS $fn$
    DECLARE
      cur   varchar(50) := NEW.reports_to_position_code;
      pasos integer := 0;
      TOPE  constant integer := 50;
    BEGIN
      WHILE cur IS NOT NULL AND pasos < TOPE LOOP
        IF cur = NEW.code THEN
          RAISE EXCEPTION
            'ciclo en la cadena de mando: el puesto % no puede reportar a % (ya esta arriba de el)',
            NEW.code, NEW.reports_to_position_code
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT p.reports_to_position_code INTO cur
          FROM identity.positions p
         WHERE p.tenant_id = NEW.tenant_id AND p.code = cur AND p.deleted_at IS NULL;
        pasos := pasos + 1;
      END LOOP;
      IF pasos >= TOPE THEN
        RAISE EXCEPTION 'cadena de mando de mas de % niveles desde %: se aborta por seguridad', TOPE, NEW.code
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$`);

  const trg = await knex.raw(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.positions'::regclass AND tgname = 'trg_positions_sin_ciclo'`,
  );
  if (!trg.rows.length) {
    await knex.raw(`
      CREATE TRIGGER trg_positions_sin_ciclo
        BEFORE INSERT OR UPDATE OF reports_to_position_code ON identity.positions
        FOR EACH ROW WHEN (NEW.reports_to_position_code IS NOT NULL)
        EXECUTE FUNCTION identity.positions_sin_ciclo()`);
    console.log('  [OR.1a] + trigger trg_positions_sin_ciclo');
  }

  // ── 3. La única arista probada + la hoja de trabajo ───────────────────────
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');
  for (const tenant of tenants) {
    for (const [code, jefe] of ARISTAS_PROBADAS) {
      const existe = await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .whereNull('deleted_at')
        .first('code', 'reports_to_position_code');
      const hayJefe = await knex('identity.positions')
        .where({ tenant_id: tenant, code: jefe })
        .whereNull('deleted_at')
        .first('code');
      if (!existe || !hayJefe) continue;
      if (existe.reports_to_position_code) {
        console.log(`  [OR.1a] ${code} ya reporta a ${existe.reports_to_position_code} — sin cambio`);
        continue;
      }
      await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .update({ reports_to_position_code: jefe, updated_at: knex.fn.now() });
      console.log(`  [OR.1a] ${code} -> reporta a ${jefe}  (29 personas lo respaldan)`);
    }

    // La hoja de trabajo: puestos CON gente que todavía no declaran jefe.
    const pend = await knex.raw(
      `SELECT p.code, p.department_code AS depto,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                  AND u.activo AND u.deleted_at IS NULL) AS gente
         FROM identity.positions p
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL
          AND p.reports_to_position_code IS NULL
        ORDER BY gente DESC, p.department_code, p.code`,
      [tenant],
    );
    const conGente = pend.rows.filter((x) => x.gente > 0);
    console.log(
      `\n  [OR.1a] HOJA DE TRABAJO — ${conGente.length} puesto/s CON gente y sin jefe declarado.`,
    );
    console.log(`          NULL acá significa "no se decidió todavía", NO "no tiene jefe".`);
    conGente.forEach((x) =>
      console.log(`     · ${String(x.code).padEnd(26)} ${String(x.depto || '-').padEnd(18)} ${x.gente} persona/s`),
    );
    console.log(`          (+ ${pend.rows.length - conGente.length} puestos vacíos, sin urgencia)`);

    // La anomalía que no se toca.
    const anomalias = await knex.raw(
      `SELECT s.username AS jefe, sp.code AS jefe_puesto, u.username AS sub, up.code AS sub_puesto
         FROM identity.users u
         JOIN identity.users s ON s.id = u.supervisor_id AND s.tenant_id = u.tenant_id
         LEFT JOIN identity.positions up ON up.tenant_id = u.tenant_id AND up.code = u.position_code
         LEFT JOIN identity.positions sp ON sp.tenant_id = s.tenant_id AND sp.code = s.position_code
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
          AND (sp.code IS NULL OR up.code IS NULL OR sp.code <> 'supervisor_rd')
        ORDER BY 1`,
      [tenant],
    );
    if (anomalias.rows.length) {
      console.log(`\n  [OR.1a] ${anomalias.rows.length} jefatura/s por persona que NO calzan con el patrón — se reportan, no se tocan:`);
      anomalias.rows.forEach((x) =>
        console.log(`     · ${x.jefe} (${x.jefe_puesto || 'sin puesto'})  manda a  ${x.sub} (${x.sub_puesto || 'sin puesto'})`),
      );
    }
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_positions_sin_ciclo ON identity.positions`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.positions_sin_ciclo()`);
  await knex.raw(`ALTER TABLE identity.positions DROP CONSTRAINT IF EXISTS positions_no_autoreporte`);
  await knex.raw(`ALTER TABLE identity.positions DROP CONSTRAINT IF EXISTS positions_reports_to_fk`);
  await knex('identity.positions').update({ reports_to_position_code: null });
  // La columna NO se borra (regla del proyecto: borrar columnas pide autorización).
  console.log('  [OR.1a] down: candados y contenido retirados. La columna se conserva.');
};
