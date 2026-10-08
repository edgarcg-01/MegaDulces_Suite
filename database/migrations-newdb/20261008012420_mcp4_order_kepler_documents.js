'use strict';
/**
 * `[MCP.4]` — `commercial.order_kepler_documents`: la liga entre un pedido de preventa (`PD-`) y
 * el documento de Kepler con el que se cobró.
 *
 * ── Por qué existe (Fase MCP, ADR-089) ───────────────────────────────────────────────────
 * El pedido de preventa se levanta y se surte en la Suite, pero **se cobra en Kepler**: la cajera
 * emite un ticket `U-D-10` a nombre del cliente. Hasta hoy nada unía las dos mitades. Medido en
 * prod el 2026-10-08: de 27 pedidos de preventa "confirmados y vencidos", al menos 7 de Yurécuaro
 * ya tenían ticket en la Caja 3 con la clave del cliente — se cobraron y la Suite no se enteró.
 *
 * ── Por qué la tabla guarda SÓLO la liga ─────────────────────────────────────────────────
 * El documento NO se copia: total, renglones, caja y fecha se leen en vivo de
 * `analytics.erp_sale_tickets` / `_lines` (vistas sobre `kepler_ods`, regla principal del
 * proyecto: cero importers). Lo único que no existe en ninguna fuente es **la decisión humana**
 * de que *este* documento corresponde a *este* pedido: eso es dato propio (HITL) y vive aquí.
 *
 * ── Quién liga ───────────────────────────────────────────────────────────────────────────
 * Decisión de Francisco (D2/D6): **el repartidor o el vendedor, en su celular, al entregar**,
 * eligiendo entre los documentos del cliente. El encargado de sucursal puede ligar o corregir
 * desde la mesa (sobre todo los pedidos de antes de la mesa). `link_source` dice cuál fue.
 *
 * ── Desligar no borra ────────────────────────────────────────────────────────────────────
 * Una liga equivocada se cierra con `unlinked_at/unlinked_by/unlink_reason`; la fila queda. Así se
 * puede responder "¿quién ligó este ticket a este pedido y quién lo corrigió?".
 *
 * ── Las dos llaves (sólo sobre ligas vivas) ──────────────────────────────────────────────
 *   · un documento no se liga a dos pedidos (cobraría dos veces el mismo dinero);
 *   · un pedido tiene un documento vivo (D10: lo no entregado sale otro día con el MISMO
 *     documento; si se devuelve, la NC es otro documento que no se liga aquí).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // La FK hacia `commercial.orders` toma un candado sobre una tabla con mucho movimiento: si hay
  // una transacción larga encima, mejor fallar en 3 s que bloquear todas las escrituras de pedidos.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const existe = await knex.schema.withSchema('commercial').hasTable('order_kepler_documents');
  if (!existe) {
    await knex.schema.withSchema('commercial').createTable('order_kepler_documents', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('order_id').notNullable();
      // Sucursal Kepler del documento (2 dígitos) y su folio digital, p. ej. `04UD1003-0002097`.
      // Es la llave que publica `analytics.erp_sale_tickets.folio_digital`.
      t.string('sucursal', 4).notNullable();
      t.string('folio_digital', 40).notNullable();
      t.string('link_source', 12).notNullable();
      t.timestamp('linked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('linked_by').notNullable();
      t.timestamp('unlinked_at', { useTz: true });
      t.uuid('unlinked_by');
      t.text('unlink_reason');
      t.primary(['tenant_id', 'id']);
    });

    await knex.raw(`
      ALTER TABLE commercial.order_kepler_documents
        ADD CONSTRAINT order_kepler_documents_order_fk
        FOREIGN KEY (tenant_id, order_id) REFERENCES commercial.orders(tenant_id, id)
        ON DELETE CASCADE`);
    await knex.raw(`
      ALTER TABLE commercial.order_kepler_documents
        ADD CONSTRAINT order_kepler_documents_source_ck
        CHECK (link_source IN ('mesa', 'celular'))`);
    // Desligar es coherente o no es: fecha y autor van juntos.
    await knex.raw(`
      ALTER TABLE commercial.order_kepler_documents
        ADD CONSTRAINT order_kepler_documents_unlink_ck
        CHECK ((unlinked_at IS NULL) = (unlinked_by IS NULL))`);
    // El folio digital empieza con la sucursal: si no, la fila apunta a otra plaza.
    await knex.raw(`
      ALTER TABLE commercial.order_kepler_documents
        ADD CONSTRAINT order_kepler_documents_folio_ck
        CHECK (left(folio_digital, length(sucursal)) = sucursal)`);

    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_okd_documento_vivo
        ON commercial.order_kepler_documents (tenant_id, folio_digital)
        WHERE unlinked_at IS NULL`);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_okd_pedido_vivo
        ON commercial.order_kepler_documents (tenant_id, order_id)
        WHERE unlinked_at IS NULL`);
  }

  await knex.raw('ALTER TABLE commercial.order_kepler_documents ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.order_kepler_documents FORCE ROW LEVEL SECURITY');
  await knex.raw(`DROP POLICY IF EXISTS order_kepler_documents_tenant ON commercial.order_kepler_documents`);
  await knex.raw(`
    CREATE POLICY order_kepler_documents_tenant ON commercial.order_kepler_documents
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin DELETE: una liga se cierra, no se borra.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.order_kepler_documents TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.order_kepler_documents IS
    'MCP.4 — liga pedido de preventa (PD-) ↔ documento de Kepler con que se cobró. Guarda SOLO la decisión humana; el documento se lee en vivo de analytics.erp_sale_tickets. Desligar cierra la fila, no la borra.'`);

  // ── COMPUERTAS ───────────────────────────────────────────────────────────────────────
  const { rows: rls } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='commercial' AND c.relname='order_kepler_documents'`);
  if (!rls[0]?.on || !rls[0]?.forced) {
    throw new Error('[MCP.4] RLS no quedó habilitado+forzado en order_kepler_documents.');
  }

  // PRUEBA NEGATIVA: el mismo documento ligado vivo a dos pedidos tiene que rebotar.
  // Dentro de un SAVEPOINT (la migración corre en una transacción; un error la abortaría).
  // Necesita dos pedidos y un usuario; sin sujeto se DECLARA, no se da por buena (ADR-056).
  // Pedidos SIN liga viva: al re-correr la migración, uno ya ligado rebotaría por la llave del
  // PEDIDO y el candado pasaría por verde midiendo otra cosa (la trampa que documenta VEC.4).
  const { rows: pedidos } = await knex.raw(`
    SELECT o.tenant_id, o.id FROM commercial.orders o
     WHERE NOT EXISTS (SELECT 1 FROM commercial.order_kepler_documents d
                        WHERE d.order_id = o.id AND d.unlinked_at IS NULL)
     ORDER BY o.created_at DESC LIMIT 2`);
  const { rows: usuario } = await knex.raw(`SELECT id FROM identity.users LIMIT 1`);
  if (pedidos.length < 2 || !usuario.length || pedidos[0].tenant_id !== pedidos[1].tenant_id) {
    console.log('  [MCP.4] ◻ NO MEDIDO: faltan dos pedidos del mismo tenant y un usuario para probar la llave.');
  } else {
    const folio = '99UD9999-CANDADO';
    await knex.raw('SAVEPOINT mcp4_neg');
    // ⚠️ La tabla tiene RLS FORZADO: si quien migra no es superusuario, sin tenant en sesión el
    // INSERT rebotaría por la política y no por la llave — y el candado fallaría por la razón
    // equivocada. Se fija el tenant del sujeto; el ROLLBACK TO SAVEPOINT lo deshace.
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [pedidos[0].tenant_id]);
    let rebotó = false;
    try {
      for (const p of pedidos) {
        await knex.raw(
          `INSERT INTO commercial.order_kepler_documents
             (tenant_id, order_id, sucursal, folio_digital, link_source, linked_by)
           VALUES (?, ?, '99', ?, 'mesa', ?)`,
          [p.tenant_id, p.id, folio, usuario[0].id],
        );
      }
    } catch (e) {
      // Sólo cuenta si rebota la llave del DOCUMENTO; cualquier otro error no prueba nada.
      rebotó = /ux_okd_documento_vivo/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT mcp4_neg');
    await knex.raw('RELEASE SAVEPOINT mcp4_neg');
    if (!rebotó) {
      throw new Error('[MCP.4] la llave NO impidió ligar el mismo documento a dos pedidos: es decorativa.');
    }
    console.log('  [MCP.4] prueba negativa OK: un documento no se liga a dos pedidos.');
  }
  console.log('  [MCP.4] tabla lista · RLS forzado.');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.order_kepler_documents');
};
