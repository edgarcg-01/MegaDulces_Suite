'use strict';
/**
 * `[ID.32]` — Etapa 4a: renombrar un rol pasa a ser un `UPDATE`.
 *
 * ── El síntoma que se ve en el padrón ────────────────────────────────────────
 * Hay **14 roles `retirado_*`** en prod. No son roles: son **nombres liberados**.
 * Existen porque renombrar un rol era imposible — las FK compuestas
 * `(tenant_id, role_name)` estaban en `ON UPDATE NO ACTION`, así que cambiar el
 * nombre reventaba con violación de FK. La salida fue prefijar el viejo con
 * `retirado_` y crear otro al lado.
 *
 * Con `ON UPDATE CASCADE` eso deja de hacer falta: se renombra la fila y las
 * dependientes siguen al nombre nuevo. Es la corrección de mayor palanca por
 * menor riesgo de toda la fase — y por eso va antes que `identity.roles` con
 * `id` propio, que el plan pedía y que queda como deuda con nombre: con esto se
 * cobra el 80% del valor sin recrear las FK de 3 tablas ni migrar ~200 lectores
 * del JSONB.
 *
 * ⚠️ **Son CUATRO FK, no tres.** El plan decía tres (`users`, `user_roles`,
 * `role_scopes`) y medido en prod hay una cuarta: `positions_default_role_fk`
 * sobre `identity.positions(tenant_id, default_role)`. Dejarla afuera habría
 * hecho que el renombre siguiera fallando en cualquier rol que algún puesto
 * proponga por default — o sea justo los que más se usan. El puesto que
 * *propone* un rol es la pieza de la Etapa 5, así que no es un detalle.
 *
 * ── Y trae su propia prueba de comportamiento ────────────────────────────────
 * Afirmar que la cascada existe leyendo `pg_constraint` afirma que alguien
 * escribió `ADD CONSTRAINT`. Acá se **ejerce**: dentro de la misma transacción
 * de la migración se renombra un rol `retirado_*` (ya dado de baja, con 6 filas
 * de `role_scopes` y **cero** usuarios), se verifica que las 6 siguieron al
 * nombre nuevo, y se lo renombra de vuelta. Efecto neto cero, FK reales, tablas
 * reales, y nunca se toca un rol vivo.
 *
 * Idempotente: los `ALTER` se hacen con DROP + ADD del constraint por nombre.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * Las cuatro FK, con su `ON DELETE` ACTUAL — que hay que preservar. Cambiarlo
 * de paso sería colar una decisión distinta dentro de esta: `RESTRICT` en
 * `users` es a propósito (borrar un rol con gente adentro debe fallar) y
 * `CASCADE` en las otras dos también (el alcance y los complementos no
 * sobreviven a su rol).
 */
const FKS = [
  {
    tabla: 'identity.users',
    nombre: 'fk_users_tenant_role',
    cols: '(tenant_id, role_name)',
    onDelete: 'RESTRICT',
  },
  {
    tabla: 'identity.user_roles',
    nombre: 'user_roles_tenant_id_role_name_foreign',
    cols: '(tenant_id, role_name)',
    onDelete: 'CASCADE',
  },
  {
    tabla: 'identity.role_scopes',
    nombre: 'role_scopes_tenant_id_role_name_foreign',
    cols: '(tenant_id, role_name)',
    onDelete: 'CASCADE',
  },
  {
    tabla: 'identity.positions',
    nombre: 'positions_default_role_fk',
    cols: '(tenant_id, default_role)',
    onDelete: 'SET NULL',
  },
];

exports.up = async function up(knex) {
  for (const fk of FKS) {
    await knex.raw(`ALTER TABLE ${fk.tabla} DROP CONSTRAINT IF EXISTS ${fk.nombre}`);
    await knex.raw(
      `ALTER TABLE ${fk.tabla} ADD CONSTRAINT ${fk.nombre}
         FOREIGN KEY ${fk.cols}
         REFERENCES identity.role_permissions (tenant_id, role_name)
         ON UPDATE CASCADE ON DELETE ${fk.onDelete}`,
    );
    console.log(`  ${fk.tabla}.${fk.nombre} → ON UPDATE CASCADE (ON DELETE ${fk.onDelete} preservado)`);
  }

  // ── Compuerta 1: las cuatro quedaron en CASCADE ───────────────────────────
  const { rows: cat } = await knex.raw(
    `SELECT c.conname, c.confupdtype
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'identity.role_permissions'::regclass`,
  );
  const sinCascade = cat.filter((r) => r.confupdtype !== 'c').map((r) => r.conname);
  if (sinCascade.length) {
    throw new Error(`Quedaron FK sin ON UPDATE CASCADE: ${sinCascade.join(', ')}`);
  }
  if (cat.length !== FKS.length) {
    throw new Error(
      `Hay ${cat.length} FK apuntando a role_permissions y esta migración conoce ${FKS.length}. ` +
        'Alguien agregó una: agregarla a FKS o el renombre va a seguir fallando por ahí.',
    );
  }

  // ── Compuerta 2: se EJERCE la cascada, no se supone ───────────────────────
  // Sujeto: un rol ya retirado, con dependientes y sin un solo usuario. Si no
  // hay ninguno, se declara en vez de pasar en vacío.
  const { rows: sujeto } = await knex.raw(
    `SELECT rp.tenant_id, rp.role_name,
            (SELECT count(*)::int FROM identity.role_scopes rs
              WHERE rs.tenant_id = rp.tenant_id AND rs.role_name = rp.role_name) AS reglas
       FROM identity.role_permissions rp
      WHERE rp.role_name LIKE 'retirado%'
        AND NOT EXISTS (SELECT 1 FROM identity.users u
                         WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name)
        AND NOT EXISTS (SELECT 1 FROM identity.user_roles ur
                         WHERE ur.tenant_id = rp.tenant_id AND ur.role_name = rp.role_name)
      ORDER BY 3 DESC LIMIT 1`,
  );

  if (!sujeto.length || sujeto[0].reglas === 0) {
    console.log(
      '  ~ NO MEDIDO: no hay un rol retirado con dependientes y sin usuarios ' +
        'con el que ejercer la cascada. Queda afirmada por el catálogo, no por comportamiento.',
    );
  } else {
    const { tenant_id: tid, role_name: rol, reglas } = sujeto[0];
    const temporal = `${rol}__cascada_tmp`;

    await knex.raw(
      `UPDATE identity.role_permissions SET role_name = ? WHERE tenant_id = ? AND role_name = ?`,
      [temporal, tid, rol],
    );
    const { rows: siguieron } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.role_scopes
        WHERE tenant_id = ? AND role_name = ?`,
      [tid, temporal],
    );
    // Vuelve al nombre real ANTES de evaluar, para que un fallo de la aserción
    // no deje el rol con el nombre de prueba.
    await knex.raw(
      `UPDATE identity.role_permissions SET role_name = ? WHERE tenant_id = ? AND role_name = ?`,
      [rol, tid, temporal],
    );

    if (siguieron[0].n !== reglas) {
      throw new Error(
        `La cascada NO funcionó: se renombró "${rol}" y sólo ${siguieron[0].n} de ${reglas} ` +
          'filas de role_scopes siguieron al nombre nuevo.',
      );
    }
    const { rows: vuelta } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.role_scopes WHERE tenant_id = ? AND role_name = ?`,
      [tid, rol],
    );
    if (vuelta[0].n !== reglas) {
      throw new Error(`El renombre de vuelta dejó ${vuelta[0].n} de ${reglas} filas. Abortando.`);
    }
    console.log(
      `  ✓ cascada EJERCIDA: renombrar "${rol}" arrastró sus ${reglas} filas de alcance, y volvió sin pérdida`,
    );
  }

  // ── Compuerta 3: nada quedó con el nombre de prueba ───────────────────────
  const { rows: sobras } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions WHERE role_name LIKE '%__cascada_tmp'`,
  );
  if (sobras[0].n !== 0) {
    throw new Error(`Quedaron ${sobras[0].n} rol(es) con el nombre temporal de la prueba.`);
  }

  // ── Compuerta 4: los triggers de las FK nuevas quedaron ENCENDIDOS ────────
  // Una FK en Postgres se implementa con triggers internos, y este proyecto ya
  // pagó ese boleto: `[IDG.6]` encontró `identity.users` con **144 de sus 195
  // triggers deshabilitados** en prod —la única tabla de toda la base así—
  // porque un `DISABLE TRIGGER ALL` de un script `local-*` se corrió contra
  // producción. Y lo peor no fue eso: `pg_constraint.convalidated` decía `true`
  // todo el tiempo, o sea que **la metadata afirmaba que la FK validaba
  // mientras no validaba nada**. Por eso acá se mira `tgenabled`, no
  // `convalidated`.
  const { rows: trg } = await knex.raw(
    `SELECT t.tgname, t.tgenabled, c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_constraint k ON k.oid = t.tgconstraint
      WHERE k.confrelid = 'identity.role_permissions'::regclass
        AND t.tgenabled <> 'O'`,
  );
  if (trg.length) {
    throw new Error(
      `Las FK de rol quedaron con ${trg.length} trigger(s) NO habilitados: ` +
        `${trg.map((r) => `${r.relname}.${r.tgname}=${r.tgenabled}`).join(', ')}. ` +
        'Una FK con triggers apagados no valida nada, y la metadata no lo denuncia.',
    );
  }

  console.log(
    `  ✓ las ${cat.length} FK de rol cascadean el renombre — los 14 "retirado_*" dejan de tener razón de existir`,
  );
};

exports.down = async function down(knex) {
  for (const fk of FKS) {
    await knex.raw(`ALTER TABLE ${fk.tabla} DROP CONSTRAINT IF EXISTS ${fk.nombre}`);
    await knex.raw(
      `ALTER TABLE ${fk.tabla} ADD CONSTRAINT ${fk.nombre}
         FOREIGN KEY ${fk.cols}
         REFERENCES identity.role_permissions (tenant_id, role_name)
         ON DELETE ${fk.onDelete}`,
    );
  }
  console.log('  Revertido: renombrar un rol vuelve a ser imposible.');
};
