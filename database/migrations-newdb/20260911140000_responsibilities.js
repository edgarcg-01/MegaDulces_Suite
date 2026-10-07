'use strict';
/**
 * `[OR.1b]` — De qué responde cada puesto. El eje que faltaba.
 *
 * ── El hueco ────────────────────────────────────────────────────────────────────────────────
 * `identity.users` tiene 33 columnas y **ninguna dice de qué responde la persona**. Por eso hay
 * **106,603 items de trabajo pendientes sin dueño**: no hay a quién asignárselos, porque el
 * sistema no sabe de qué responde nadie.
 *
 *     finance.findings (nuevo)                   82,289
 *     commercial.replenishment_findings (open)   21,940
 *     reconciliation.discrepancies (nuevo)        2,371
 *     logistics.fleet_alerts (open)                   3
 *
 * ⛔ **La regla que estas tablas existen para sostener: el PERMISO decide si podés ABRIRLO; la
 * RESPONSABILIDAD decide si es TUYO.** La responsabilidad NO gatea — enruta y ordena. Si también
 * gateara, habría un cuarto sistema de autorización y dos verdades sobre «puede ver», que es el
 * defecto que ADR-054 retiró tras medir 4 compuertas muertas por tener la autorización en dos
 * lugares.
 *
 * ── ⚠️ Medición que corrige al plan: 5 de 8 colas NO tienen eje de ruteo ─────────────────────
 * Se buscó en cada cola una columna de ruteo o de dueño (`warehouse|route|zone|store|customer|
 * brand|user|assign|owner`). Resultado real:
 *
 *     commercial.replenishment_findings   warehouse_id
 *     commercial.inventory_counts         warehouse_id
 *     commercial.expiry_reviews           warehouse_id + responsible_user_id
 *     reconciliation.discrepancies        -- ninguna --
 *     finance.findings                    -- ninguna --
 *     finance.proposed_actions            -- ninguna --
 *     logistics.fleet_alerts              -- ninguna --   <- el plan decía `warehouse`. NO.
 *     commercial.commercial_actions       -- ninguna --   <- el plan decía `route`. NO.
 *
 * O sea que **la mayoría del trabajo sólo se puede reenviar por responsabilidad sola**, sin eje
 * geográfico. Eso hace al catálogo más importante, no menos. `dimension` queda NULL en esas
 * cinco: inventarle un eje a una cola que no lo tiene sería repartir al azar con cara de precisión.
 *
 * ── Por qué `position_responsibilities` nace VACÍA, a propósito ──────────────────────────────
 * La tentación era sembrarla derivándola del permiso: «responde de la bandeja todo puesto cuyo
 * `default_role` tenga la clave que la gatea». Se descartó: eso **colapsa la distinción que la
 * tabla existe para crear** (permiso ≠ responsabilidad) y dejaría el reparto funcionando el día 1
 * sin que nadie haya decidido nada — con aspecto de que funciona. La corrida imprime esa
 * derivación como **hoja de trabajo**, para decidirla con el lead puesto por puesto.
 * Hasta entonces `[OR.3]` reportará `sin_dueño = 106,603`, que es la verdad.
 *
 * ── La lección que le da forma a `user_responsibilities` ────────────────────────────────────
 * `identity.user_roles` nació como «complemento por persona» y hoy tiene **134 filas de las que
 * 129 repiten el `role_name` que ya está en la fila de `users`**: 96% espejo de una columna que
 * ya existía. Para que la excepción no se vuelva la norma otra vez, acá la excepción **cuesta**:
 * `nota` NOT NULL y no vacía, y **vigencia** (`valid_from`/`valid_to`) — que es justo lo que no
 * tiene ninguna de las tres tablas de override de hoy (`user_roles`, `user_permissions`,
 * `user_scopes`).
 *
 * `identity.responsibilities` es catálogo **a nivel producto** (sin `tenant_id`, sin RLS,
 * `GRANT SELECT`), calcado de `identity.scope_dimensions`: agregar una responsabilidad es **una
 * fila**, no un deploy.
 *
 * Aditiva e idempotente. No toca personas, ni permisos, ni puestos.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * [key, label, descripcion, dimension, orden]
 * `dimension` = columna de `identity.scope_dimensions`, o null si la cola NO tiene eje (medido).
 * Las 8 corresponden 1:1 con las bandejas que `libs/trade/src/lib/users/me-work.ts` ya declara.
 */
const RESPONSABILIDADES = [
  ['finanzas.hallazgos', 'Hallazgos de finanzas', 'Triage de lo que detecta Maat sobre pólizas, cadenas y proveedores.', null, 10],
  ['finanzas.acciones', 'Acciones de finanzas por aprobar', 'Propuestas de Maat que esperan una decision humana.', null, 20],
  ['almacen.cuadre', 'Descuadres de caja e inventario', 'Diferencias detectadas al cruzar caja, inventario y ERP.', null, 30],
  ['compras.reabasto', 'Reabastecimiento', 'Agotados y bajo punto de reorden del barrido nocturno.', 'warehouse', 40],
  ['almacen.conteo', 'Conteos de inventario', 'Sesiones de conteo ciclico y su conciliacion.', 'warehouse', 50],
  ['tienda.caducidades', 'Revision de caducidades', 'Hojas de revision de producto proximo a vencer.', 'warehouse', 60],
  ['logistica.flota', 'Alertas de flota', 'Unidades sin senal o con exceso de velocidad.', null, 70],
  ['comercial.thot', 'Acciones comerciales por aprobar', 'Sugerencias de Thot que esperan curacion.', null, 80],
];

/**
 * Hoja de trabajo: qué permiso abre cada bandeja hoy. NO se siembra — se imprime.
 * Espejo de `anyOf` en `me-work.ts`; si allá cambia, acá queda viejo y sólo afecta al reporte.
 */
const PERMISO_DE_BANDEJA = {
  'finanzas.hallazgos': ['FINANCE_AI_CHAT'],
  'finanzas.acciones': ['FINANCE_AI_CHAT'],
  'almacen.cuadre': ['RECONCILIATION_VER'],
  'compras.reabasto': ['COMPRAS_HALLAZGOS_VER'],
  'almacen.conteo': ['COMMERCIAL_INVENTORY_CONTAR'],
  'tienda.caducidades': ['COMMERCIAL_EXPIRY_VER', 'COMMERCIAL_EXPIRY_CAPTURAR'],
  'logistica.flota': ['LOGISTICS_FLEET_VER'],
  'comercial.thot': ['COMMERCIAL_THOT_GESTIONAR'],
};

const AUDIT = (knex, t) => {
  t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.uuid('created_by');
  t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  t.uuid('updated_by');
  t.timestamp('deleted_at', { useTz: true });
  t.uuid('deleted_by');
};

async function rlsForzado(knex, tabla) {
  await knex.raw(`ALTER TABLE identity.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE identity.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename='${tabla}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON identity.${tabla}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.${tabla} TO app_runtime`);
  const trg = await knex.raw(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.${tabla}'::regclass AND tgname = 'trg_auto_populate_tenant_id'`,
  );
  if (!trg.rows.length) {
    await knex.raw(`
      CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON identity.${tabla}
        FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id()`);
  }
}

exports.up = async function up(knex) {
  // ── 1. Catálogo a nivel producto (patrón `scope_dimensions`) ──────────────
  if (!(await knex.schema.withSchema('identity').hasTable('responsibilities'))) {
    await knex.raw(`
      CREATE TABLE identity.responsibilities (
        key          varchar(60) PRIMARY KEY,
        label        varchar(150) NOT NULL,
        descripcion  text NOT NULL DEFAULT '',
        dimension    varchar(40) REFERENCES identity.scope_dimensions(code),
        orden        integer NOT NULL DEFAULT 0,
        created_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`GRANT SELECT ON identity.responsibilities TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE identity.responsibilities IS
      '[OR.1] Catalogo de lo que se puede tener a cargo. A NIVEL PRODUCTO (sin tenant_id, sin RLS), patron identity.scope_dimensions: agregar una responsabilidad es UNA FILA, no un deploy. NO otorga permisos -- el permiso decide si podes abrirlo, la responsabilidad decide si es tuyo.'`);
    await knex.raw(`COMMENT ON COLUMN identity.responsibilities.dimension IS
      '[OR.1] Eje por el que se reparte esta cola, contra identity.scope_dimensions. NULL = la cola NO tiene columna de ruteo (medido: 5 de 8) y se reparte por responsabilidad sola. NULL NO significa "no se reviso".'`);
    console.log('  [OR.1b] identity.responsibilities creada (producto, sin RLS)');
  }

  for (const [key, label, desc, dim, orden] of RESPONSABILIDADES) {
    await knex.raw(
      `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                       dimension = EXCLUDED.dimension, orden = EXCLUDED.orden`,
      [key, label, desc, dim, orden],
    );
  }
  const cat = await knex('identity.responsibilities').count('* as n').first();
  console.log(`  [OR.1b] catálogo: ${cat.n} responsabilidad/es`);

  // ── 2. De qué responde cada PUESTO ────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasTable('position_responsibilities'))) {
    await knex.schema.withSchema('identity').createTable('position_responsibilities', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('position_code', 50).notNullable();
      t.string('responsibility_key', 60).notNullable();
      t.boolean('es_principal').notNullable().defaultTo(false);
      AUDIT(knex, t);
      t.index(['tenant_id', 'position_code']);
      t.index(['tenant_id', 'responsibility_key']);
    });
    await knex.raw(`
      ALTER TABLE identity.position_responsibilities
        ADD CONSTRAINT position_responsibilities_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        ADD CONSTRAINT position_responsibilities_position_fk FOREIGN KEY (tenant_id, position_code)
        REFERENCES identity.positions (tenant_id, code) ON DELETE CASCADE,
        ADD CONSTRAINT position_responsibilities_key_fk FOREIGN KEY (responsibility_key)
        REFERENCES identity.responsibilities (key) ON DELETE CASCADE`);
    // Parcial: un soft-delete no debe bloquear volver a asignar lo mismo.
    await knex.raw(`
      CREATE UNIQUE INDEX position_responsibilities_unica
        ON identity.position_responsibilities (tenant_id, position_code, responsibility_key)
        WHERE deleted_at IS NULL`);
    await rlsForzado(knex, 'position_responsibilities');
    await knex.raw(`COMMENT ON TABLE identity.position_responsibilities IS
      '[OR.1] De que responde cada PUESTO. Es la fuente normal; identity.user_responsibilities es la excepcion por persona. Nace VACIA a proposito: sembrarla desde el permiso colapsaria la distincion que existe para crear.'`);
    console.log('  [OR.1b] identity.position_responsibilities creada (RLS forzado) — VACÍA a propósito');
  }

  // ── 3. La excepción por persona, que cuesta ───────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasTable('user_responsibilities'))) {
    await knex.schema.withSchema('identity').createTable('user_responsibilities', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.string('responsibility_key', 60).notNullable();
      t.string('accion', 10).notNullable();
      t.text('nota').notNullable();
      t.date('valid_from').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
      t.date('valid_to');
      AUDIT(knex, t);
      t.index(['tenant_id', 'user_id']);
      t.index(['tenant_id', 'responsibility_key']);
    });
    await knex.raw(`
      ALTER TABLE identity.user_responsibilities
        ADD CONSTRAINT user_responsibilities_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        ADD CONSTRAINT user_responsibilities_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE CASCADE,
        ADD CONSTRAINT user_responsibilities_key_fk FOREIGN KEY (responsibility_key)
        REFERENCES identity.responsibilities (key) ON DELETE CASCADE,
        ADD CONSTRAINT user_responsibilities_accion_valida CHECK (accion IN ('suma', 'resta')),
        ADD CONSTRAINT user_responsibilities_nota_obligatoria CHECK (btrim(nota) <> ''),
        ADD CONSTRAINT user_responsibilities_vigencia CHECK (valid_to IS NULL OR valid_to >= valid_from)`);
    await rlsForzado(knex, 'user_responsibilities');
    await knex.raw(`COMMENT ON TABLE identity.user_responsibilities IS
      '[OR.1] EXCEPCION por persona sobre lo que dice su puesto. nota NOT NULL y vigencia son deliberados: identity.user_roles nacio como complemento y hoy 129 de sus 134 filas repiten el role_name que ya esta en users. Una excepcion que no cuesta se vuelve la norma.'`);
    console.log('  [OR.1b] identity.user_responsibilities creada (nota obligatoria + vigencia)');
  }

  // ── 4. La hoja de trabajo (se imprime, NO se siembra) ─────────────────────
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');
  for (const tenant of tenants) {
    const yaAsignadas = await knex('identity.position_responsibilities')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .count('* as n')
      .first();
    console.log(
      `\n  [OR.1b] HOJA DE TRABAJO — puesto x responsabilidad asignadas hoy: ${yaAsignadas.n}.`,
    );
    console.log(`          Abajo, QUIÉN PUEDE ABRIR cada bandeja hoy (por permiso). Es el punto de`);
    console.log(`          partida para decidir QUIÉN RESPONDE — no son lo mismo, y por eso no se siembra.`);

    for (const [key, , , dim] of RESPONSABILIDADES) {
      const claves = PERMISO_DE_BANDEJA[key] || [];
      if (!claves.length) continue;
      const cond = claves.map(() => `(rp.permissions -> ? )::text = 'true'`).join(' OR ');
      const r = await knex.raw(
        `SELECT p.code, p.department_code AS depto,
                (SELECT count(*)::int FROM identity.users u
                  WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                    AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno') AS gente
           FROM identity.positions p
           JOIN identity.role_permissions rp
             ON rp.tenant_id = p.tenant_id AND rp.role_name = p.default_role AND rp.deleted_at IS NULL
          WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND (${cond})
          ORDER BY gente DESC, p.code`,
        [tenant, ...claves],
      );
      const conGente = r.rows.filter((x) => x.gente > 0);
      const etiqueta = dim ? `eje ${dim}` : 'SIN eje — reparto por responsabilidad sola';
      console.log(`\n     ${key}  (${etiqueta})`);
      if (!r.rows.length) {
        console.log(`        ningún puesto la abre hoy — su permiso no está en ningún default_role`);
        continue;
      }
      conGente.forEach((x) => console.log(`        · ${String(x.code).padEnd(26)} ${String(x.depto || '-').padEnd(16)} ${x.gente} persona/s`));
      const vacios = r.rows.length - conGente.length;
      if (vacios) console.log(`        (+ ${vacios} puesto/s sin gente que también lo abren)`);
    }
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.schema.withSchema('identity').dropTableIfExists('user_responsibilities');
  await knex.schema.withSchema('identity').dropTableIfExists('position_responsibilities');
  await knex.schema.withSchema('identity').dropTableIfExists('responsibilities');
  console.log('  [OR.1b] down: las 3 tablas retiradas.');
};
