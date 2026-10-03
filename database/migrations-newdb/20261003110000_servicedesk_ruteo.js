'use strict';
/**
 * `[MS.3.10]` — Asignación AUTOMÁTICA de tickets: una regla = una persona + lo que la dispara.
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Sistemas, 2026-10-02: *«si una solicitud menciona algo como sistemas, cpu, impresora, asignarla
 * automáticamente a Felipe_Galvan; toda la parte de desarrollo a David_Cisneros»*.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. `servicedesk.routing_rules`: las reglas, por tenant, editables desde `/servicio/configuracion`. Una regla
 *     se dispara por **categoría** (la señal confiable) o por **palabras clave** en lo que la persona escribe.
 *     Gana la primera por `sort_order`. Es tabla y no constante para que cambiar a quién le toca algo no exija
 *     un despliegue ni a mí.
 *  2. Dos categorías nuevas en la cola TI —«Equipo de cómputo e impresoras» y «Desarrollo»— para que quien
 *     reporta pueda ELEGIR la ruta en vez de depender de adivinar la palabra.
 *  3. Siembra las dos reglas del pedido, **resolviendo las personas por usuario en el momento de migrar**.
 *     Si el usuario no existe en esa base, la regla NO se crea y se dice en el log: no se inventa una persona.
 *  4. Les da a esas dos personas la responsabilidad `servicio.atender` (por PERSONA, con nota): son quienes
 *     reciben los tickets, y es la clave que pone la cola «sin asignar» —lo que ninguna regla atrapó— en su
 *     portada. Cierra la decisión que quedó abierta en MS.3.8.
 *
 * ── ⛔ Qué NO hace, a propósito ─────────────────────────────────────────────────────────────
 * **No les da el permiso `SERVICIO_ATENDER`.** Asignarle un ticket a quien no puede abrir su propia ficha es una
 * trampa, así que al crear el ticket el ruteo VERIFICA que la persona pueda atender y, si no, lo deja sin asignar
 * (y la pantalla de reglas lo marca). El permiso es un acto aparte, de quien administra roles.
 *
 * Las palabras clave sembradas son un punto de partida mío a partir de lo que dijo el pedido («sistemas, cpu,
 * impresora» y «desarrollo»), más sinónimos evidentes. Se editan en pantalla.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

/** Categorías nuevas de la cola TI: `[code, nombre, prioridad por defecto, exige sucursal, orden]`. */
const CATEGORIAS = [
  ['equipo_computo', 'Equipo de cómputo e impresoras', 'media', true, 55],
  ['desarrollo', 'Desarrollo', 'media', false, 95],
];

/**
 * Reglas de arranque. `usuario` se busca sin distinguir mayúsculas. `categoria` es el `code` de arriba.
 * Felipe va primero (10) y David después (20): si un ticket menciona las dos cosas, gana el primero.
 */
const REGLAS = [
  {
    nombre: 'Equipo de cómputo, impresoras y sistemas',
    usuario: 'felipe_galvan',
    categoria: 'equipo_computo',
    orden: 10,
    palabras: ['sistemas', 'cpu', 'impresora', 'computadora', 'laptop', 'monitor', 'teclado', 'mouse', 'toner'],
  },
  {
    nombre: 'Desarrollo',
    usuario: 'david_cisneros',
    categoria: 'desarrollo',
    orden: 20,
    palabras: ['desarrollo', 'desarrollador', 'programacion', 'funcionalidad', 'suite', 'portal'],
  },
];

const normalizar = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.routing_rules (
      id           uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id    uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      name         text        NOT NULL,
      keywords     text[]      NOT NULL DEFAULT '{}',
      category_id  uuid,
      assignee_id  uuid        NOT NULL,
      sort_order   integer     NOT NULL DEFAULT 100,
      active       boolean     NOT NULL DEFAULT true,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT routing_rules_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT routing_rules_name_ck CHECK (length(btrim(name)) > 0),
      -- Una regla sin categoría ni palabras no se dispara nunca: es un typo, no una política.
      CONSTRAINT routing_rules_trigger_ck CHECK (category_id IS NOT NULL OR cardinality(keywords) > 0),
      CONSTRAINT routing_rules_category_fk FOREIGN KEY (tenant_id, category_id)
        REFERENCES servicedesk.categories (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT routing_rules_assignee_fk FOREIGN KEY (tenant_id, assignee_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_routing_rules_order ON servicedesk.routing_rules (tenant_id, sort_order) WHERE deleted_at IS NULL`);
  await knex.raw(`ALTER TABLE servicedesk.routing_rules ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.routing_rules FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.routing_rules`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.routing_rules
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON servicedesk.routing_rules TO app_runtime`);
  await knex.raw(
    `COMMENT ON TABLE servicedesk.routing_rules IS 'MS.3.10 — a quién se asigna solo un ticket nuevo: por categoría o por palabra clave en lo que escribe quien reporta. Gana la primera por sort_order. Se edita en /servicio/configuracion; el ruteo verifica que el destino pueda atender y, si no, deja el ticket sin asignar.'`,
  );

  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    const cola = await knex('servicedesk.queues').where({ tenant_id: tenant, code: 'ti' }).first('id');
    if (!cola) {
      console.log(`  [MS.3.10] tenant ${tenant}: sin cola TI — no se siembra nada`);
      continue;
    }
    for (const [code, name, prioridad, sucursal, orden] of CATEGORIAS) {
      await knex.raw(
        `INSERT INTO servicedesk.categories (tenant_id, queue_id, code, name, default_priority, requires_branch, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, queue_id, code) DO NOTHING`,
        [tenant, cola.id, code, name, prioridad, sucursal, orden],
      );
    }

    for (const r of REGLAS) {
      const persona = await knex('identity.users')
        .where({ tenant_id: tenant })
        .whereRaw('lower(username) = ?', [r.usuario])
        .whereNull('deleted_at')
        .first('id', 'nombre');
      if (!persona) {
        console.log(`  [MS.3.10] ⚠️ el usuario "${r.usuario}" NO existe en este tenant — la regla "${r.nombre}" no se crea (se da de alta desde /servicio/configuracion)`);
        continue;
      }
      const cat = await knex('servicedesk.categories').where({ tenant_id: tenant, queue_id: cola.id, code: r.categoria }).first('id');
      const ya = await knex('servicedesk.routing_rules').where({ tenant_id: tenant, name: r.nombre }).whereNull('deleted_at').first('id');
      if (ya) {
        console.log(`  [MS.3.10] la regla "${r.nombre}" ya existe — sin cambios`);
      } else {
        await knex('servicedesk.routing_rules').insert({
          tenant_id: tenant,
          name: r.nombre,
          keywords: [...new Set(r.palabras.map(normalizar))],
          category_id: cat ? cat.id : null,
          assignee_id: persona.id,
          sort_order: r.orden,
        });
        console.log(`  [MS.3.10] regla "${r.nombre}" → ${r.usuario} (${r.palabras.length} palabras + categoría ${r.categoria})`);
      }

      // La responsabilidad se da por PERSONA, con nota (dato operativo editable desde /admin/personas).
      const tiene = await knex('identity.user_responsibilities')
        .where({ tenant_id: tenant, user_id: persona.id, responsibility_key: 'servicio.atender' })
        .whereNull('deleted_at')
        .first('id');
      if (!tiene) {
        await knex('identity.user_responsibilities').insert({
          tenant_id: tenant,
          user_id: persona.id,
          responsibility_key: 'servicio.atender',
          accion: 'suma',
          nota: 'MS.3.10 — recibe los tickets de la Mesa de Servicio por asignación automática y reparte lo que ninguna regla atrapó',
        });
        console.log(`  [MS.3.10] ${r.usuario} → responsabilidad servicio.atender`);
      }
    }
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS servicedesk.routing_rules');
  // Las categorías y las responsabilidades sembradas se conservan: pueden tener tickets y reparto ya.
};
