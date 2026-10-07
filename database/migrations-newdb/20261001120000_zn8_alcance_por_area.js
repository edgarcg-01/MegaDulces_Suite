/**
 * `[ZN.8]` — El alcance deja de ser UNO por persona: pasa a poder variar por ÁREA.
 *
 * ── El pedido, y por qué el modelo de hoy no lo expresa ─────────────────────
 * *«Aide hace el pedido de TODAS las sucursales, ve reportes de ALGUNAS, y en
 * otras sólo quiere ver la zona Morelia»*.
 *
 * Hoy `identity.user_scopes` tiene PK `(tenant, user, dimension)`: **un solo
 * valor por persona y dimensión, igual en toda la app**. Entonces la única
 * forma de que alguien vea más en un lado y menos en otro es mover esa palanca
 * — y eso ya pasó, medido en la bitácora de esta misma persona: cuatro cambios
 * en quince días (`all` → `listed` → `all` → `own`), cada uno arreglando una
 * pantalla y rompiendo otra.
 *
 * ── Qué hace esta migración ────────────────────────────────────────────────
 * Agrega `area` a las dos tablas de alcance y la mete en la PK. `'*'` = la
 * regla de siempre, la que vale donde no haya una más específica.
 *
 * ⭐ **Es ADITIVA y NO cambia el comportamiento de nadie el día uno.** Todas las
 * filas que existen quedan en `'*'`, que es exactamente lo que el resolvedor lee
 * hoy. Nada se mueve hasta que alguien cree una excepción por área a propósito.
 *
 * ── ⛔ Por qué NO hay CHECK sobre los valores de `area` ──────────────────────
 * Las áreas ya existen: son los proyectos de `AUTHZ_TREE` (`libs/contracts`) —
 * `compras`, `comercial`, `pdv`, `finanzas`, `almacen`, `logistica`… Meter
 * esa lista en un CHECK sería copiar a mano un primitivo que ya vive en otro
 * lado, que es el modo de falla de ADR-056: el día que alguien agregue un
 * proyecto, la copia de la DB no se entera y el `setScope` empieza a rechazar
 * algo legítimo. La lista la valida el servicio contra el árbol, y el candado
 * `test-newdb-zn8-areas.js` verifica que no haya en la DB un área que el árbol
 * no conozca.
 */

const TABLAS = ['identity.user_scopes', 'identity.role_scopes'];

/** `'*'` y no NULL: en una PK, NULL no compara — dos filas con NULL serían distintas. */
const DEFECTO = '*';

/**
 * ⚠️ El DDL **no acepta parámetros ligados**. `ADD COLUMN ... DEFAULT ?` revienta con
 * *«bind message supplies 1 parameters, but prepared statement requires 0»* — es la misma
 * familia que el `SET` que necesita `set_config(k, v, true)` (GOTCHAS §67). El valor va
 * interpolado, y por eso es una constante del archivo y no algo que venga de afuera.
 */
const DEFECTO_SQL = `'${DEFECTO}'`;

async function pkDe(knex, tabla) {
  const { rows } = await knex.raw(
    `SELECT conname FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'p'`,
    [tabla],
  );
  return rows[0]?.conname ?? null;
}

exports.up = async function up(knex) {
  for (const tabla of TABLAS) {
    const [schema, nombre] = tabla.split('.');

    const existe = await knex.schema.withSchema(schema).hasColumn(nombre, 'area');
    if (!existe) {
      await knex.raw(
        `ALTER TABLE ${tabla} ADD COLUMN area varchar(40) NOT NULL DEFAULT ${DEFECTO_SQL}`,
      );
    }

    // La PK vieja no distingue áreas, así que dos reglas de la misma dimensión para áreas
    // distintas chocarían. Se reemplaza, no se agrega un UNIQUE al lado: dos candados para
    // la misma identidad terminan discrepando.
    const pk = await pkDe(knex, tabla);
    const yaTieneArea = pk
      ? (await knex.raw(
          `SELECT 1 FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.conname = ? AND a.attname = 'area'`,
          [pk],
        )).rows.length > 0
      : false;

    if (pk && !yaTieneArea) {
      const llave = nombre === 'user_scopes' ? 'user_id' : 'role_name';
      await knex.raw(`ALTER TABLE ${tabla} DROP CONSTRAINT ${pk}`);
      await knex.raw(
        `ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre}_pkey PRIMARY KEY (tenant_id, ${llave}, dimension, area)`,
      );
    }

    // Lo que el resolvedor pregunta en cada request: las reglas de ESTA área y las de `'*'`.
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${nombre}_area_idx ON ${tabla} (tenant_id, dimension, area)`,
    );

    await knex.raw(
      `COMMENT ON COLUMN ${tabla}.area IS ` +
        `'[ZN.8] Proyecto de AUTHZ_TREE donde aplica esta regla (compras, pdv, finanzas...). ` +
        `''*'' = vale donde no haya una mas especifica. La lista NO se valida con un CHECK a ` +
        `proposito: vive en libs/contracts/authz/authz-tree.ts y copiarla aca la haria divergir.'`,
    );
  }

  // ── Candado: nada se movió ────────────────────────────────────────────────
  // Esta migración es aditiva. Si alguna fila quedó fuera de `'*'`, alguien cambió
  // comportamiento sin decirlo y hay que mirarlo antes de seguir.
  const { rows: fuera } = await knex.raw(
    `SELECT 'user_scopes' AS t, count(*)::int AS n FROM identity.user_scopes WHERE area <> ?
      UNION ALL
     SELECT 'role_scopes', count(*)::int FROM identity.role_scopes WHERE area <> ?`,
    [DEFECTO, DEFECTO],
  );
  const movidas = fuera.filter((r) => r.n > 0);
  if (movidas.length) {
    throw new Error(
      `[ZN.8] ${movidas.map((r) => `${r.t}: ${r.n}`).join(' · ')} filas quedaron fuera de '*'. ` +
        `Esta migración no debe mover a nadie.`,
    );
  }

  const { rows: [c] } = await knex.raw(
    `SELECT (SELECT count(*)::int FROM identity.user_scopes) AS usuarios,
            (SELECT count(*)::int FROM identity.role_scopes) AS roles`,
  );
  console.log(
    `[ZN.8] area agregada · ${c.usuarios} reglas de usuario y ${c.roles} de rol, todas en '*' ` +
      `(o sea: mismo comportamiento que antes hasta que se cree la primera excepción).`,
  );
};

exports.down = async function down(knex) {
  for (const tabla of TABLAS) {
    const [schema, nombre] = tabla.split('.');
    const llave = nombre === 'user_scopes' ? 'user_id' : 'role_name';

    // ⛔ Bajar con excepciones vivas las borraría en silencio al colapsar la PK.
    const { rows: [x] } = await knex.raw(
      `SELECT count(*)::int AS n FROM ${tabla} WHERE area <> ?`, [DEFECTO],
    );
    if (x.n > 0) {
      throw new Error(
        `[ZN.8 down] ${tabla} tiene ${x.n} regla(s) por área. Volver atrás las perdería al ` +
          `colapsar la PK. Retiralas desde /admin/personas primero.`,
      );
    }

    const pk = await pkDe(knex, tabla);
    if (pk) await knex.raw(`ALTER TABLE ${tabla} DROP CONSTRAINT ${pk}`);
    await knex.raw(
      `ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre}_pkey PRIMARY KEY (tenant_id, ${llave}, dimension)`,
    );
    await knex.raw(`DROP INDEX IF EXISTS identity.${nombre}_area_idx`);
    if (await knex.schema.withSchema(schema).hasColumn(nombre, 'area')) {
      await knex.raw(`ALTER TABLE ${tabla} DROP COLUMN area`);
    }
  }
};
