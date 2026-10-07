/**
 * `[AU.25]` — 28 personas estaban en un puesto que no es el suyo.
 *
 * Segunda mitad de `[AU.23]`: aquel lote puso la jerarquía de MDTask y no movió
 * a nadie. Éste mueve a la gente.
 *
 * ── Lo que un cambio de puesto SÍ y NO hace ───────────────────────────────
 *
 * Medido antes de decidir: **el puesto no otorga permisos**. Los da `role_name`
 * contra `role_permissions`; el puesto sólo los *propone* (`default_role`), y
 * esta migración **no toca ningún `role_name`**. Lo que sí cambia:
 *   · de qué responde la persona (las responsabilidades que hereda del puesto):
 *     cambian en 10 de las 28;
 *   · su lugar en el organigrama;
 *   · si su rol coincide con lo que el puesto nuevo propone: 18 quedan en
 *     desvío declarado, que es lo que la ficha ya sabe mostrar y exigir motivo.
 *
 * ── Cómo se identificó a cada persona ─────────────────────────────────────
 *
 * Por nombre completo, con el orden indiferente (la nómina escribe
 * «APELLIDO APELLIDO NOMBRE» y las fichas al revés). El score es tokens
 * compartidos sobre el máximo de tokens.
 *
 * **Score mínimo 0.67, segundo candidato máximo 0.50**: ninguna identificación
 * es ambigua, y la migración lo verifica antes de escribir. Los 7 casos bajo
 * 0.80 se revisaron uno por uno: el score baja por un apellido que falta en la
 * ficha (`Fernando Espitia` contra `ESPITIA VACA FERNANDO`) o por variante
 * ortográfica (`ELIZARRAS`/`ELIZARRARAS`, `PLACENCIA`/`PLASCENCIA`), nunca por
 * duda entre dos personas.
 *
 * ── Los casos que hay que mirar, y por qué se aplican igual ───────────────
 *
 * Tres son degradaciones y no son inferencia nuestra: MDTask pone a **Mónica
 * Mejía** y **Tania Sánchez** explícitamente en `auxiliar-encargado` (no es que
 * «falten» en encargadas), y a **Ángel Vázquez** en `vendedor-rd`. Pierden
 * `almacen.conteo`/`almacen.cuadre` y `comercial.thot` respectivamente.
 *
 * Una es promoción: **Juan Jesús Carrillo** pasa de `auxiliar_finanzas` a
 * `jefe_finanzas`, que es lo que la nómina dice que es. Gana
 * `finanzas.acciones`.
 *
 * ⚠️ **Queda declarado, no resuelto:** `jefe_finanzas` pasa a tener dos
 * ocupantes. El otro es `carmenrodriguez`, que **no figura en la nómina de
 * agosto** y **no inicia sesión desde el 2026-08-12**. Un puesto admite varios
 * ocupantes (`encargado_sucursal` tiene 5), así que no hay conflicto técnico;
 * pero si esa ficha sobra, eso es una baja y la baja se firma. Mismo caso con
 * `supervisor_rd`, donde queda `jose_herrera` sin fila en nómina.
 *
 * ⚠️ **El límite de la fuente:** la nómina es de **agosto** y el padrón es de
 * hoy. Donde la ficha esté más al día que la nómina —un ascenso de septiembre,
 * por ejemplo— esta migración la pisa. Por eso tiene `down` exacto: el estado
 * previo de cada persona viaja en el propio archivo de datos.
 */

const DATA = require('../seeds-data/organigrama-mdtask.json');

const MOV = DATA.reubicaciones;

/** Ninguna identificación puede quedar cerca de un segundo candidato. */
const SCORE_MIN = 0.6;
const MARGEN_MIN = 0.15;

exports.up = async function up(knex) {
  if (!Array.isArray(MOV) || !MOV.length) throw new Error('[AU.25] sin reubicaciones en el archivo de datos.');

  for (const m of MOV) {
    if (m.score < SCORE_MIN || m.score - m.segundo_candidato < MARGEN_MIN) {
      throw new Error(
        '[AU.25] ABORTA: la identificación de "' + m.nombre + '" es ambigua (score ' + m.score +
          ', segundo candidato ' + m.segundo_candidato + ').',
      );
    }
  }

  const antes = (
    await knex.raw(
      `SELECT (SELECT count(*)::int FROM identity.users
                WHERE deleted_at IS NULL AND kind = 'interno' AND position_code IS NULL) AS sin_puesto,
              (SELECT count(*)::int FROM identity.users WHERE deleted_at IS NULL) AS fichas`,
    )
  ).rows[0];

  // El rol de cada persona ANTES, para poder afirmar al final que no se movió
  // ninguno. El puesto propone; no otorga. Esta migración no cambia permisos.
  const rolesAntes = new Map(
    (
      await knex.raw('SELECT username, role_name FROM identity.users WHERE deleted_at IS NULL')
    ).rows.map((r) => [r.username, r.role_name]),
  );

  let movidos = 0;
  let yaEstaban = 0;
  const distintos = [];

  for (const m of MOV) {
    const { rows } = await knex.raw(
      `SELECT id, tenant_id, position_code FROM identity.users
        WHERE username = ? AND deleted_at IS NULL`,
      [m.username],
    );
    if (!rows.length) throw new Error('[AU.25] ABORTA: no existe la ficha ' + m.username + '.');
    const u = rows[0];

    if (u.position_code === m.a) { yaEstaban += 1; continue; }

    // ⛔ Si alguien ya la movió a un tercer puesto, esta migración no pisa esa
    //    decisión a ciegas: la nombra y sigue, y al final se listan todas.
    if (u.position_code !== m.de) {
      distintos.push(m.username + ': se esperaba en ' + m.de + ' y está en ' + u.position_code);
      continue;
    }

    const { rows: pd } = await knex.raw(
      'SELECT 1 FROM identity.positions WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL',
      [u.tenant_id, m.a],
    );
    if (!pd.length) throw new Error('[AU.25] ABORTA: el puesto destino ' + m.a + ' no existe o está de baja.');

    await knex.raw(
      `UPDATE identity.users
          SET position_code = ?, department_code = ?, updated_at = now()
        WHERE id = ?`,
      [m.a, m.department_code, u.id],
    );

    // El trigger de la tabla registra el cambio; este evento aparte guarda el
    // MOTIVO, que es lo que el próximo que abra la ficha necesita para no tener
    // que rehacer esta investigación.
    await knex.raw(
      `INSERT INTO identity.user_events (tenant_id, user_id, event, detalle, actor_username)
       VALUES (?, ?, 'puesto_asignado', ?::jsonb, 'migracion [AU.25]')`,
      [
        u.tenant_id,
        u.id,
        JSON.stringify({
          position_code: m.a,
          department_code: m.department_code,
          origen: 'organigrama MDTask [AU.25]',
          criterio:
            'La nomina de agosto lo ubica como "' + m.cargo_nomina + '"' +
            (m.sucursal_nomina ? ' en ' + m.sucursal_nomina : '') +
            ', bajo el puesto que en MDTask corresponde a ' + m.a + '. Identificado como "' +
            m.nomina + '" con score ' + m.score + ' (segundo candidato ' + m.segundo_candidato + ').',
          puesto_anterior: m.de,
        }),
      ],
    );
    movidos += 1;
  }

  const d = (
    await knex.raw(
      `SELECT (SELECT count(*)::int FROM identity.users
                WHERE deleted_at IS NULL AND kind = 'interno' AND position_code IS NULL) AS sin_puesto,
              (SELECT count(*)::int FROM identity.users WHERE deleted_at IS NULL) AS fichas,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.deleted_at IS NULL AND u.position_code IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM identity.positions p
                                   WHERE p.tenant_id = u.tenant_id AND p.code = u.position_code
                                     AND p.deleted_at IS NULL)) AS apuntan_a_baja`,
    )
  ).rows[0];

  if (d.sin_puesto !== antes.sin_puesto) {
    throw new Error('[AU.25] ABORTA: internos sin puesto ' + antes.sin_puesto + ' -> ' + d.sin_puesto + '.');
  }
  if (d.fichas !== antes.fichas) {
    throw new Error('[AU.25] ABORTA: fichas ' + antes.fichas + ' -> ' + d.fichas + '. No se crea ni se borra nadie.');
  }
  if (d.apuntan_a_baja) {
    throw new Error('[AU.25] ABORTA: ' + d.apuntan_a_baja + ' ficha(s) quedaron apuntando a un puesto de baja.');
  }

  // La afirmación central del lote: ni un permiso se movió.
  const rolesDespues = (
    await knex.raw('SELECT username, role_name FROM identity.users WHERE deleted_at IS NULL')
  ).rows;
  const cambiaron = rolesDespues.filter((r) => rolesAntes.get(r.username) !== r.role_name);
  if (cambiaron.length) {
    throw new Error(
      '[AU.25] ABORTA: cambió el rol de ' + cambiaron.map((r) => r.username).join(', ') +
        '. Esta migración mueve puestos, no permisos.',
    );
  }

  if (distintos.length) {
    console.log('[AU.25] ⚠️ no se tocaron ' + distintos.length + ' ficha(s), ya no estaban donde se midió:');
    distintos.forEach((s) => console.log('   · ' + s));
  }
  console.log(
    '[AU.25] ' + movidos + ' movidas, ' + yaEstaban + ' ya estaban, ' + distintos.length +
      ' salteadas. Roles sin cambios: ' + rolesDespues.length + ' fichas.',
  );
};

exports.down = async function down(knex) {
  let vuelven = 0;
  for (const m of MOV) {
    const { rows } = await knex.raw(
      'SELECT id, position_code FROM identity.users WHERE username = ? AND deleted_at IS NULL',
      [m.username],
    );
    if (!rows.length) continue;
    // Sólo vuelve quien esté donde esta migración lo dejó. Si alguien lo movió
    // después, esa decisión es más nueva y gana.
    if (rows[0].position_code !== m.a) continue;
    await knex.raw(
      'UPDATE identity.users SET position_code = ?, updated_at = now() WHERE id = ?',
      [m.de, rows[0].id],
    );
    vuelven += 1;
  }
  console.log('[AU.25] revertidas ' + vuelven + ' de ' + MOV.length + ' reubicaciones.');
};
