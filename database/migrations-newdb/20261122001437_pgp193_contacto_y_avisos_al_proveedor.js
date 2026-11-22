'use strict';
/**
 * `[PGP.193]` + `[PGP.194]` — **El contacto de cobranza del proveedor y el aviso de pago que se le manda** (anexo AV).
 *
 * Francisco (2026-11-21): al proveedor se le comparte el desglose del pago —sus facturas, las notas de crédito
 * aplicadas y la transferencia— para que su cobranza haga el complemento de pago (REP), por WhatsApp o correo (DA3).
 * Hoy eso se arma a mano en recortes.
 *
 * Dos tablas propias (decisiones humanas, no copias de nada — regla 2):
 *  · `finance.supplier_collection_contacts` — a quién de cobranza se le avisa: correo y WhatsApp, por acreedor de
 *    Kepler (`proveedor_code` = `kdxe.c2`, la misma llave de los hábitos de pago `[PGP.30]`). Se captura al avisar y
 *    se recuerda. Una por acreedor.
 *  · `finance.payment_notices` — cada aviso que se generó de un pago: por qué canal, a quién, quién y cuándo. Su `id`
 *    va firmado en la liga que abre el proveedor; `revoked_at` la apaga. Es también lo que `[PGP.195]` lee para la
 *    etapa «Por notificar».
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-21) ─────────────────────────────────────────────────────────
 *  · Ninguna columna de correo, teléfono o WhatsApp en `catalog.suppliers` ni en `finance.supplier_payment_accounts`.
 *  · Ninguna de las dos tablas existe; nada las lee hoy: las escribe y las lee `AvisoDePagoService`.
 *
 * Tablas nuevas: `tenant_id` + auditoría + RLS (regla 18). Nada se borra: un aviso se revoca con un UPDATE.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const ESQUEMA = 'finance';
const CONTACTOS = 'supplier_collection_contacts';
const AVISOS = 'payment_notices';
const TC = `${ESQUEMA}.${CONTACTOS}`;
const TA = `${ESQUEMA}.${AVISOS}`;

async function rls(knex, tabla) {
  const t = `${ESQUEMA}.${tabla}`;
  await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${tabla}_tenant ON ${t}`);
  await knex.raw(`CREATE POLICY ${tabla}_tenant ON ${t} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${t} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema(ESQUEMA).hasTable(CONTACTOS))) {
    await knex.schema.withSchema(ESQUEMA).createTable(CONTACTOS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('proveedor_code').notNullable();
      t.text('contact_name');
      t.text('email');
      t.text('whatsapp');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by').notNullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${CONTACTOS}_proveedor ON ${TC} (tenant_id, proveedor_code)`);
  await knex.raw(`COMMENT ON TABLE ${TC} IS '[PGP.193] A quién de cobranza del proveedor se le manda el aviso de pago (correo y WhatsApp), por acreedor de Kepler. Se captura al avisar y se recuerda.'`);
  await rls(knex, CONTACTOS);

  if (!(await knex.schema.withSchema(ESQUEMA).hasTable(AVISOS))) {
    await knex.schema.withSchema(ESQUEMA).createTable(AVISOS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('allocation_id').notNullable().references('id').inTable(`${ESQUEMA}.payment_allocations`);
      t.text('canal').notNullable();
      t.text('destino');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by').notNullable();
      t.timestamp('revoked_at', { useTz: true });
      t.text('revoked_by');
    });
    await knex.raw(`ALTER TABLE ${TA} ADD CONSTRAINT ck_${AVISOS}_canal CHECK (canal IN ('whatsapp', 'correo', 'liga'))`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${AVISOS}_pago ON ${TA} (tenant_id, allocation_id, created_at DESC)`);
  await knex.raw(`COMMENT ON TABLE ${TA} IS '[PGP.194] Cada aviso de pago que se generó para un proveedor: canal, a quién, quién y cuándo. Su id va firmado en la liga del PDF; revoked_at la apaga.'`);
  await rls(knex, AVISOS);

  const { rows: [n] } = await knex.raw(`SELECT (SELECT count(*) FROM ${TC})::int AS contactos, (SELECT count(*) FROM ${TA})::int AS avisos`);
  // eslint-disable-next-line no-console
  console.log(`[PGP.193] ${TC}: ${n.contactos} contacto(s) · ${TA}: ${n.avisos} aviso(s)`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): una tabla con filas (contactos capturados o
 * avisos enviados) se conserva y se dice; sólo vacía se quita. Los avisos van primero (llave al pago).
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const tabla of [AVISOS, CONTACTOS]) {
    if (!(await knex.schema.withSchema(ESQUEMA).hasTable(tabla))) continue;
    const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM ${ESQUEMA}.${tabla}`)).rows[0].n);
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(`[PGP.193] ${ESQUEMA}.${tabla} tiene ${n} fila(s) hechas por personas: se conserva (regla 5).`);
      continue;
    }
    await knex.schema.withSchema(ESQUEMA).dropTableIfExists(tabla);
  }
};
