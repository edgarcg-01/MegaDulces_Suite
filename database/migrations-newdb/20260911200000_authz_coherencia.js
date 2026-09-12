'use strict';
/**
 * `[OR.7.1]` — La vista que cruza los tres ejes y le pone NOMBRE a cada desacuerdo.
 *
 * ── El problema ─────────────────────────────────────────────────────────────────────────────
 * La Fase OR construyó un eje nuevo —puesto, jefe, responsabilidad— **al lado** de los dos que ya
 * existían: el permiso (ADR-054) y el alcance (`ScopeService`). Que convivan no garantiza que
 * coincidan, y hasta ahora el único que miraba las tres cosas a la vez era yo, a mano, con
 * consultas sueltas.
 *
 * ── ⛔ Lo que esta vista NO hace ────────────────────────────────────────────────────────────
 * **No corrige nada y no gatea nada.** Nombra. La regla que sostiene toda la fase sigue intacta:
 *
 *     el PERMISO decide si podés abrirlo · la RESPONSABILIDAD decide si es tuyo ·
 *     la TAREA dice que alguien te lo asignó
 *
 * Si esta vista otorgara o quitara algo, sería el cuarto sistema de autorización — el defecto que
 * ADR-054 retiró tras medir 4 compuertas muertas por tener la autorización en dos lugares.
 *
 * ── Por qué sincronizar NO puede significar derivar uno del otro ─────────────────────────────
 * Medido en prod: un rol sirve hasta a **6 puestos** (`piso_tienda`), 5 (`almacenista`), 4
 * (`cajero`), 4 (`supervisor_ventas`) — **el rol no identifica al puesto**. Y hay roles con gente
 * que ningún puesto propone — **el puesto no cubre al rol**. Derivar cualquiera del otro perdería
 * información real. La sincronía es cruzarlos y que los desacuerdos se vean.
 *
 * ── Los cinco tipos, y qué significa cada uno ────────────────────────────────────────────────
 *
 *  `puesto_con_dos_roles`    un subconjunto consistente de un puesto hace otro trabajo. Hoy: 1 —
 *                            `vendedor_ruta` con 13 `promotor_ruta` + 11 `vendedor_ruta`, y **no es
 *                            un recorte**: cada rol tiene permisos que el otro no tiene (el vendedor
 *                            cobra y gestiona cartera; el promotor levanta caducidades).
 *  `complemento_universal`   lo tienen TODAS las personas del puesto -> es el perfil, no una
 *                            excepción. `[OR.7.0b]` ya subió los que tienen n≥2; esto vigila que no
 *                            vuelvan a aparecer.
 *  `override_masivo`         una persona necesita muchas claves sueltas -> el rol no le queda.
 *                            Hoy: `ernesto_zarate` con 28 sobre `contabilidad`.
 *  `rol_huerfano`            ningún puesto lo propone. ⚠️ `kind` es una excusa VÁLIDA: `customer_b2b`
 *                            (cliente), `etiquetas_anaquel` (dispositivo) y `servicio` no tienen ni
 *                            deben tener puesto, así que no se reportan.
 *  `scope_override_masivo`   una dimensión necesita demasiadas excepciones por persona -> el que
 *                            está mal es el rol. Hoy: `warehouse` con 37.
 *
 * ⚠️ Falta `responsabilidad_sin_permiso` —el puesto responde de algo que no puede abrir— porque
 * `position_responsibilities` está VACÍA hasta que se decida `DEUDA-OR-CARTA`. **Se declara en el
 * comentario de la vista en vez de agregar una rama que siempre devuelve cero**: una rama muerta se
 * lee igual que «no hay problemas».
 *
 * ⚠️ Re-aplicar `security_invoker` y el `GRANT` tras cada `CREATE OR REPLACE VIEW`: no se heredan, y
 * una migración de la Fase U ya perdió uno.
 *
 * Aditiva e idempotente. Sólo lectura.
 *
 * @param { import("knex").Knex } knex
 */

/** Desde cuántas claves sueltas un override deja de ser una excepción. */
const UMBRAL_OVERRIDE = 5;
/** Desde cuántas excepciones por persona una dimensión acusa al rol. */
const UMBRAL_SCOPE = 10;

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW identity.v_authz_coherencia AS

    -- 1. Un puesto con más de un rol adentro: falta un puesto.
    WITH gente AS (
      SELECT tenant_id, position_code, role_name, count(*)::int n
        FROM identity.users
       WHERE activo AND deleted_at IS NULL AND kind = 'interno' AND position_code IS NOT NULL
       GROUP BY 1, 2, 3),
    total AS (
      SELECT tenant_id, position_code, sum(n)::int t FROM gente GROUP BY 1, 2)

    SELECT
      g.tenant_id,
      'puesto_con_dos_roles'::text            AS tipo,
      g.position_code                         AS sujeto,
      g.role_name                             AS detalle,
      g.n                                     AS cuantos,
      t.t                                     AS de_cuantos,
      format('%s de %s personas de "%s" tienen el rol "%s" y el puesto propone "%s"',
             g.n, t.t, g.position_code, g.role_name, coalesce(p.default_role, '(ninguno)')) AS dice
      FROM gente g
      JOIN total t ON t.tenant_id = g.tenant_id AND t.position_code = g.position_code
      LEFT JOIN identity.positions p
        ON p.tenant_id = g.tenant_id AND p.code = g.position_code AND p.deleted_at IS NULL
     WHERE t.t > 1
       AND g.role_name IS DISTINCT FROM p.default_role

    UNION ALL

    -- 2. Un complemento que tienen TODOS los del puesto es el perfil del puesto.
    SELECT
      c.tenant_id,
      'complemento_universal'::text,
      c.position_code,
      c.complemento,
      c.n,
      c.t,
      format('las %s personas de "%s" tienen el complemento "%s": es el perfil del puesto, no una excepcion',
             c.n, c.position_code, c.complemento)
      FROM (
        SELECT u.tenant_id, u.position_code, ur.role_name AS complemento,
               count(*)::int n,
               (SELECT count(*)::int FROM identity.users v
                 WHERE v.tenant_id = u.tenant_id AND v.position_code = u.position_code
                   AND v.activo AND v.deleted_at IS NULL AND v.kind = 'interno') AS t
          FROM identity.user_roles ur
          JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
         WHERE ur.role_name <> u.role_name
           AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'
           AND u.position_code IS NOT NULL
         GROUP BY 1, 2, 3) c
      LEFT JOIN identity.positions p
        ON p.tenant_id = c.tenant_id AND p.code = c.position_code AND p.deleted_at IS NULL
     WHERE c.n = c.t
       -- Ya subido al puesto por [OR.7.0b] = ya no es un desacuerdo.
       AND NOT (c.complemento = ANY(coalesce(p.default_complements, '{}'::text[])))

    UNION ALL

    -- 3. Un override de permisos grande dice que el rol no le queda a esa persona.
    SELECT
      o.tenant_id,
      'override_masivo'::text,
      o.username,
      o.role_name,
      o.n,
      NULL::int,
      format('"%s" necesita %s claves sueltas sobre su rol "%s": el rol no le queda',
             o.username, o.n, o.role_name)
      FROM (
        SELECT up.tenant_id, u.username, u.role_name, count(*)::int n
          FROM identity.user_permissions up
          JOIN identity.users u ON u.id = up.user_id AND u.tenant_id = up.tenant_id
         WHERE u.activo AND u.deleted_at IS NULL
         GROUP BY 1, 2, 3) o
     WHERE o.n >= ${UMBRAL_OVERRIDE}

    UNION ALL

    -- 4. Un rol con gente que ningún puesto propone.
    --    El kind es excusa valida: cliente / dispositivo / servicio no llevan puesto.
    SELECT
      rp.tenant_id,
      'rol_huerfano'::text,
      rp.role_name,
      NULL::text,
      (SELECT count(*)::int FROM identity.users u
        WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
          AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno'),
      NULL::int,
      format('el rol "%s" tiene gente y ningun puesto lo propone', rp.role_name)
      FROM identity.role_permissions rp
     WHERE rp.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM identity.users u
                    WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                      AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno')
       AND NOT EXISTS (SELECT 1 FROM identity.positions p
                        WHERE p.tenant_id = rp.tenant_id AND p.deleted_at IS NULL
                          AND (p.default_role = rp.role_name
                               OR rp.role_name = ANY(p.default_complements)))

    UNION ALL

    -- 5. Una dimensión que necesita muchas excepciones acusa al rol, no a la gente.
    SELECT
      s.tenant_id,
      'scope_override_masivo'::text,
      s.dimension,
      NULL::text,
      s.n,
      NULL::int,
      format('la dimension "%s" necesita %s excepciones por persona: el que esta mal es el rol',
             s.dimension, s.n)
      FROM (
        SELECT us.tenant_id, us.dimension, count(*)::int n
          FROM identity.user_scopes us
          JOIN identity.users u ON u.id = us.user_id AND u.tenant_id = us.tenant_id
         WHERE u.activo AND u.deleted_at IS NULL
         GROUP BY 1, 2) s
     WHERE s.n >= ${UMBRAL_SCOPE}`);

  await knex.raw(`ALTER VIEW identity.v_authz_coherencia SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON identity.v_authz_coherencia TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW identity.v_authz_coherencia IS
    '[OR.7.1] Cruza los tres ejes (puesto / rol+permiso / alcance) y NOMBRA cada desacuerdo. NO corrige ni gatea: el permiso decide si podes abrirlo, la responsabilidad si es tuyo. Cinco tipos: puesto_con_dos_roles (falta un puesto) · complemento_universal (es el perfil, no una excepcion) · override_masivo (el rol no le queda) · rol_huerfano (ningun puesto lo propone; kind cliente/dispositivo/servicio es excusa valida) · scope_override_masivo (el que esta mal es el rol). FALTA responsabilidad_sin_permiso: position_responsibilities esta vacia hasta DEUDA-OR-CARTA, y una rama que siempre da cero se lee igual que "no hay problemas".'`);

  console.log('  [OR.7.1] identity.v_authz_coherencia creada (security_invoker + GRANT)');

  const foto = await knex.raw(
    `SELECT tipo, count(*)::int n FROM identity.v_authz_coherencia GROUP BY 1 ORDER BY 2 DESC`);
  console.log('  [OR.7.1] desacuerdos hoy:');
  if (!foto.rows.length) console.log('     (ninguno)');
  foto.rows.forEach((r) => console.log(`     ${String(r.n).padStart(3)}  ${r.tipo}`));

  const detalle = await knex.raw(`SELECT tipo, dice FROM identity.v_authz_coherencia ORDER BY tipo`);
  detalle.rows.forEach((r) => console.log(`     · ${r.dice}`));
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS identity.v_authz_coherencia`);
  console.log('  [OR.7.1] down: vista retirada.');
};
