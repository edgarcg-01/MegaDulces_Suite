/**
 * `[AU.23]` — El organigrama pasa a ser el de MDTask.
 *
 * ── Qué se decidió ────────────────────────────────────────────────────────
 *
 * Edgar declaró a MDTask fuente de verdad del organigrama. Su árbol tiene 89
 * puestos, una sola raíz y 88 aristas; `identity.positions` tenía 57 puestos y
 * **10 sin jefe**. La jerarquía de MDTask manda.
 *
 * ── Por qué NO se reemplaza el catálogo ───────────────────────────────────
 *
 * Medido antes de tocar nada:
 *   · `identity.users.position_code` es **ON DELETE SET NULL** → borrar los 57
 *     dejaría 100 fichas sin puesto, en silencio.
 *   · `identity.position_responsibilities.position_code` es **ON DELETE
 *     CASCADE** → se llevaría las 17 responsabilidades, incluida
 *     `logistica.flota`, la única que apunta a `encargado_logistica`.
 *
 * Y hay una razón de fondo: MDTask no trae `default_role`, `scope_axis` ni
 * responsabilidades. Aporta jerarquía, nivel y unidad; no aporta autorización.
 *
 * Entonces cada nodo del árbol recibe el código de prod cuando hay equivalencia
 * real (45 de 89) y uno nuevo cuando no la hay (44). El mapeo se hizo a mano,
 * nodo por nodo: el emparejamiento automático por nombre daba falsos como
 * `auxiliar-cedis` contra `auxiliar_mkt`, que coinciden sólo en la palabra
 * «auxiliar». El árbol resuelto vive en `database/seeds-data/organigrama-mdtask.json`.
 *
 * ⛔ Lo que esta migración NO hace: **no mueve a nadie de puesto**. El cruce
 * detectó 29 fichas que MDTask ubica en otro lado —entre ellas el Jefe de
 * Finanzas figurando como `auxiliar_finanzas`—. Mover personas cambia permisos
 * y va en su propio lote, con su propia firma.
 *
 * ── Los 12 códigos que el árbol de MDTask no contempla ────────────────────
 *
 * No se borran: 5 tienen gente o responsabilidades. Se les da lugar en el árbol
 * y se declara por qué. Telemarketing es el caso a mirar: no existe en MDTask,
 * pero la Fase E opera en producción, así que retirarlo sería borrar un módulo
 * vivo. Los otros 7 tienen 0 fichas y 0 responsabilidades y se dan de baja
 * blanda, que no dispara ni el SET NULL ni el CASCADE.
 *
 * ── Deuda que esta migración AGRANDA, y se declara ────────────────────────
 *
 * `DEUDA-AU-PUESTOS-VACANTES`: los 44 códigos nuevos nacen sin `default_role`
 * —MDTask no lo trae y no se inventa un perfil de acceso—. Los puestos sin
 * propuesta pasan de 13 a 57. No rompe: `detectarDesvio` ya devuelve
 * `propone: null` y la ficha exige motivo escrito igual. Pero es más superficie
 * sin perfil propuesto, y hay que asignarlos.
 */

const DATA = require('../seeds-data/organigrama-mdtask.json');

const ARBOL = DATA.arbol;

/** Los 12 que el árbol no contempla. `jefe` null significa baja blanda. */
const HUERFANOS = [
  { code: 'auxiliar_finanzas', jefe: 'tesoreria', motivo: '6 fichas y la responsabilidad finanzas.hallazgos' },
  { code: 'comprador', jefe: 'gerente_compras', motivo: '2 fichas y la responsabilidad compras.reabasto' },
  { code: 'supervisor_inventarios', jefe: 'jefe_zona', motivo: '1 ficha y 2 responsabilidades PRINCIPAL de conteo y cuadre' },
  { code: 'vendedor_tlmk', jefe: 'encargado_operaciones', motivo: '2 fichas; la Fase E opera en produccion' },
  { code: 'coordinador_tlmk', jefe: 'encargado_operaciones', motivo: 'par del anterior; la Fase E opera en produccion' },
  { code: 'supervisor_zona', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
  { code: 'auxiliar_piso_venta', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
  { code: 'vendedor_local', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
  { code: 'auxiliar_almacen', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
  { code: 'chofer_foraneo', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
  { code: 'chofer_rd', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
  { code: 'almacenista_surtidor_rv', jefe: null, motivo: '0 fichas, 0 responsabilidades' },
];

const NIVELES = ['direccion', 'gerencia', 'jefatura', 'coordinacion', 'supervision', 'operativo', 'practicante'];

const CONSERVADOS = HUERFANOS.filter((h) => h.jefe).length;

exports.up = async function up(knex) {
  // ── 1. `nivel`: la columna que no existía y es la mitad de lo que MDTask aporta.
  const hay = await knex.schema.withSchema('identity').hasColumn('positions', 'nivel');
  if (!hay) {
    await knex.raw('ALTER TABLE identity.positions ADD COLUMN nivel varchar(20)');
    // ⚠️ El CHECK es DDL: Postgres no parametriza un ALTER TABLE, así que la
    // lista va inline. Sale de la constante de este archivo, no de un input.
    const lista = NIVELES.map((n) => "'" + n + "'").join(', ');
    await knex.raw(
      'ALTER TABLE identity.positions ADD CONSTRAINT positions_nivel_check ' +
        'CHECK (nivel IS NULL OR nivel IN (' + lista + '))',
    );
  }

  const { rows: tn } = await knex.raw(
    'SELECT DISTINCT tenant_id FROM identity.positions WHERE deleted_at IS NULL',
  );
  if (tn.length !== 1) throw new Error('Se esperaba 1 tenant en identity.positions, hay ' + tn.length);
  const tenant = tn[0].tenant_id;

  // Lo de antes, para que las guardas comparen contra algo medido y no contra
  // una expectativa escrita a mano.
  const antes = (
    await knex.raw(
      `SELECT (SELECT count(*) FROM identity.users
                WHERE deleted_at IS NULL AND position_code IS NOT NULL)::int AS fichas,
              (SELECT count(*) FROM identity.position_responsibilities
                WHERE deleted_at IS NULL)::int AS resp`,
    )
  ).rows[0];

  // ── 2. Los 89 puestos, primero SIN jefe: la FK es autorreferencial y el árbol
  //      no viene ordenado topológicamente.
  for (const p of ARBOL) {
    await knex.raw(
      `INSERT INTO identity.positions
              (tenant_id, code, name, nivel, department_code, orden, org_labels)
       VALUES (?, ?, ?, ?, ?, ?, ?::text[])
       ON CONFLICT (tenant_id, code) DO UPDATE
          SET name            = EXCLUDED.name,
              nivel           = EXCLUDED.nivel,
              department_code = EXCLUDED.department_code,
              orden           = EXCLUDED.orden,
              org_labels      = (
                SELECT coalesce(array_agg(DISTINCT x), '{}'::text[])
                  FROM unnest(identity.positions.org_labels || EXCLUDED.org_labels) AS x
                 WHERE x NOT LIKE 'unidad:%' OR x = EXCLUDED.org_labels[1]),
              deleted_at      = NULL,
              deleted_by      = NULL,
              updated_at      = now()`,
      [tenant, p.code, p.name, p.nivel, p.department_code, p.orden, ['unidad:' + p.unidad]],
    );
  }

  // ── 3. Ahora sí la arista de mando, con todos los códigos ya existiendo.
  for (const p of ARBOL) {
    await knex.raw(
      `UPDATE identity.positions SET reports_to_position_code = ?, updated_at = now()
        WHERE tenant_id = ? AND code = ?`,
      [p.reports_to, tenant, p.code],
    );
  }

  // ── 4. Los 12 que el árbol no contempla.
  for (const h of HUERFANOS) {
    if (h.jefe) {
      await knex.raw(
        `UPDATE identity.positions SET reports_to_position_code = ?, updated_at = now()
          WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`,
        [h.jefe, tenant, h.code],
      );
      continue;
    }
    // Baja blanda. Se re-verifica que siga vacío: entre la medición y la corrida
    // alguien pudo asignarle una persona, y ahí el SET NULL sí la dejaría huérfana.
    const { rows } = await knex.raw(
      `SELECT (SELECT count(*) FROM identity.users
                WHERE position_code = ? AND deleted_at IS NULL)::int AS fichas,
              (SELECT count(*) FROM identity.position_responsibilities
                WHERE position_code = ? AND deleted_at IS NULL)::int AS resp`,
      [h.code, h.code],
    );
    if (rows[0].fichas || rows[0].resp) {
      throw new Error(
        'ABORT: "' + h.code + '" iba a baja blanda pero tiene ' + rows[0].fichas +
          ' ficha(s) y ' + rows[0].resp + ' responsabilidad(es). Dejó de estar vacío desde que se midió.',
      );
    }
    await knex.raw(
      `UPDATE identity.positions SET deleted_at = now(), updated_at = now()
        WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`,
      [tenant, h.code],
    );
  }

  // ── 5. Guardas. Un gate sin prueba negativa es una intención.
  const d = (
    await knex.raw(
      `SELECT (SELECT count(*) FROM identity.users
                WHERE deleted_at IS NULL AND position_code IS NOT NULL)::int AS fichas,
              (SELECT count(*) FROM identity.position_responsibilities
                WHERE deleted_at IS NULL)::int AS resp,
              (SELECT count(*) FROM identity.positions WHERE deleted_at IS NULL)::int AS puestos,
              (SELECT count(*) FROM identity.positions
                WHERE deleted_at IS NULL AND reports_to_position_code IS NULL)::int AS raices,
              (SELECT count(*) FROM identity.positions
                WHERE deleted_at IS NULL AND nivel IS NULL)::int AS sin_nivel,
              (SELECT count(*) FROM identity.users u
                WHERE u.deleted_at IS NULL AND u.position_code IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM identity.positions p
                                   WHERE p.tenant_id = u.tenant_id AND p.code = u.position_code
                                     AND p.deleted_at IS NULL))::int AS fichas_a_baja`,
    )
  ).rows[0];

  if (d.fichas !== antes.fichas) {
    throw new Error('ABORT: fichas con puesto ' + antes.fichas + ' -> ' + d.fichas + '. Nadie debía moverse.');
  }
  if (d.resp !== antes.resp) {
    throw new Error('ABORT: responsabilidades ' + antes.resp + ' -> ' + d.resp + '. Ninguna debía perderse.');
  }
  if (d.fichas_a_baja) {
    throw new Error('ABORT: ' + d.fichas_a_baja + ' ficha(s) quedaron apuntando a un puesto dado de baja.');
  }
  if (d.puestos !== ARBOL.length + CONSERVADOS) {
    throw new Error('ABORT: se esperaban ' + (ARBOL.length + CONSERVADOS) + ' puestos vivos, hay ' + d.puestos + '.');
  }
  if (d.raices !== 1) {
    throw new Error('ABORT: el árbol debe tener exactamente 1 raíz, tiene ' + d.raices + '.');
  }
  if (d.sin_nivel !== CONSERVADOS) {
    throw new Error('ABORT: sin nivel debían quedar sólo los ' + CONSERVADOS + ' huérfanos conservados, quedaron ' + d.sin_nivel + '.');
  }

  // Ciclos: la FK no los impide y el CHECK sólo ataja el autorreporte directo.
  const { rows: ciclo } = await knex.raw(`
    WITH RECURSIVE sube(code, jefe, camino, hay_ciclo) AS (
      SELECT code::text, reports_to_position_code::text, ARRAY[code::text], false
        FROM identity.positions WHERE deleted_at IS NULL
      UNION ALL
      SELECT s.code, p.reports_to_position_code::text, s.camino || p.code::text,
             p.code::text = ANY (s.camino)
        FROM sube s
        JOIN identity.positions p ON p.code = s.jefe AND p.deleted_at IS NULL
       WHERE NOT s.hay_ciclo AND array_length(s.camino, 1) < 20
    )
    SELECT DISTINCT code FROM sube WHERE hay_ciclo`);
  if (ciclo.length) {
    throw new Error('ABORT: ciclo de mando en ' + ciclo.map((r) => r.code).join(', '));
  }

  console.log(
    '[AU.23] organigrama MDTask: ' + d.puestos + ' puestos vivos, 1 raíz, ' +
      d.fichas + ' fichas y ' + d.resp + ' responsabilidades intactas.',
  );
};

/**
 * Revierte al estado medido en prod ANTES de esta migración: 57 puestos vivos,
 * 47 con jefe, 10 sin. El snapshot vive en el mismo JSON y se tomó de la tabla
 * real — no es una copia de tabla, es el inverso de esta migración versionado
 * junto a ella.
 *
 * ⚠️ Los 44 códigos nuevos se dan de **baja blanda**, nunca DELETE: si alguien
 * ya asignó una persona a uno de ellos, el `ON DELETE SET NULL` la dejaría sin
 * puesto en silencio. Si eso pasó, el down ABORTA y lo nombra.
 */
exports.down = async function down(knex) {
  const previo = DATA.estado_previo;
  if (!Array.isArray(previo) || !previo.length) {
    throw new Error('[AU.23] down sin snapshot: no se puede revertir a ciegas.');
  }

  const { rows: tn } = await knex.raw(
    'SELECT DISTINCT tenant_id FROM identity.positions WHERE deleted_at IS NULL',
  );
  const tenant = tn[0].tenant_id;
  const conocidos = new Set(previo.map((p) => p.code));

  // Los códigos que esta migración creó y que ahora tienen gente: se nombran y
  // se aborta, en vez de dejarlas huérfanas.
  const { rows: ocupados } = await knex.raw(
    `SELECT u.position_code, count(*)::int AS n
       FROM identity.users u
      WHERE u.deleted_at IS NULL AND u.position_code IS NOT NULL
        AND NOT (u.position_code = ANY (?::text[]))
      GROUP BY 1`,
    [[...conocidos]],
  );
  if (ocupados.length) {
    throw new Error(
      '[AU.23] down ABORTA: hay fichas en puestos creados por esta migración (' +
        ocupados.map((o) => o.position_code + '=' + o.n).join(', ') +
        '). Reubicalas antes de revertir.',
    );
  }

  // Primero soltar las aristas: evita pelearse con la FK autorreferencial.
  await knex.raw(
    'UPDATE identity.positions SET reports_to_position_code = NULL WHERE tenant_id = ?',
    [tenant],
  );

  for (const p of previo) {
    await knex.raw(
      `UPDATE identity.positions
          SET name = ?, department_code = ?, orden = ?, org_labels = ?::text[],
              nivel = NULL, deleted_at = ?, updated_at = now()
        WHERE tenant_id = ? AND code = ?`,
      [p.name, p.department_code, p.orden, p.org_labels || [], p.de_baja ? new Date() : null, tenant, p.code],
    );
  }
  for (const p of previo) {
    await knex.raw(
      'UPDATE identity.positions SET reports_to_position_code = ? WHERE tenant_id = ? AND code = ?',
      [p.reports_to, tenant, p.code],
    );
  }
  // Baja blanda de lo que esta migración creó.
  await knex.raw(
    `UPDATE identity.positions SET deleted_at = now(), updated_at = now()
      WHERE tenant_id = ? AND deleted_at IS NULL AND NOT (code = ANY (?::text[]))`,
    [tenant, [...conocidos]],
  );

  const hay = await knex.schema.withSchema('identity').hasColumn('positions', 'nivel');
  if (hay) {
    await knex.raw('ALTER TABLE identity.positions DROP CONSTRAINT IF EXISTS positions_nivel_check');
    await knex.raw('ALTER TABLE identity.positions DROP COLUMN nivel');
  }

  const d = (
    await knex.raw(
      `SELECT (SELECT count(*) FROM identity.positions WHERE deleted_at IS NULL)::int AS vivos,
              (SELECT count(*) FROM identity.positions
                WHERE deleted_at IS NULL AND reports_to_position_code IS NULL)::int AS sin_jefe`,
    )
  ).rows[0];
  const esperadoVivos = previo.filter((p) => !p.de_baja).length;
  const esperadoSinJefe = previo.filter((p) => !p.de_baja && !p.reports_to).length;
  if (d.vivos !== esperadoVivos || d.sin_jefe !== esperadoSinJefe) {
    throw new Error(
      '[AU.23] down no restauró el estado previo: vivos ' + d.vivos + '/' + esperadoVivos +
        ', sin jefe ' + d.sin_jefe + '/' + esperadoSinJefe,
    );
  }
  console.log('[AU.23] revertido: ' + d.vivos + ' puestos vivos, ' + d.sin_jefe + ' sin jefe.');
};
