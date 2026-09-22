'use strict';
/**
 * `[E.12.0]` — Cotizaciones de mayoreo: `commercial.quotes` + `quote_lines` + `quote_sequences`.
 *
 * ── Para qué existe el submódulo ────────────────────────────────────────────────────────────
 * Hoy Telemarketing sabe hacer UNA cosa con un cliente: levantarle un pedido en firme
 * (`/telemarketing/lead/:id/take-order` → `commercial.orders`). Pero el trabajo real del canal
 * de mayoreo casi nunca empieza en un pedido. Empieza en una PREGUNTA de precio:
 *
 *   1. **El cliente manda su lista.** Llega por correo o WhatsApp una lista de productos —con
 *      SUS nombres y SUS códigos, no los nuestros— y pide precio. Alguien la cotiza a mano en
 *      Excel, la manda, y ahí muere: no queda registro de qué se ofreció, a qué precio, con qué
 *      vigencia, ni si el cliente contestó.
 *   2. **La visita de ruta.** Se visita un cliente de mayoreo y se le levanta la venta ahí mismo.
 *      Eso a veces es pedido en firme y a veces es "déjame el precio y te confirmo".
 *
 * Los dos casos producen el mismo objeto: **una oferta de precio, con vigencia, que todavía no
 * es una venta**. Este submódulo le da casa a ese objeto para que deje de vivir en Excel y en
 * la memoria del operador.
 *
 * ── Por qué una tabla propia y no un 5º status de `commercial.orders` ───────────────────────
 * Era la opción barata y se descartó **con medición**, por dos razones independientes:
 *
 *   · **Confirmar un pedido RESERVA STOCK** (Fase B.2: `reserve`/`sale` en la misma trx del
 *     confirm, con `FOR UPDATE` anti-race). Una cotización **no debe tocar el inventario** —
 *     cotizamos a diez clientes lo mismo y se lleva uno. Meter cotizaciones en `orders` obliga a
 *     poner un `if` en el camino del dinero, que es exactamente donde no se ponen `if`.
 *   · **`commercial.orders` tiene 163 referencias en 30 archivos** (medido 2026-09-21), y **21
 *     lugares filtran por `status='draft'`**. Un status nuevo no se queda quieto: se filtra solo
 *     en el pipeline del Command Center, en los conteos de analytics, en las olas de surtido y
 *     en las guías de logística. Serían 30 archivos a auditar para no publicar una cifra falsa,
 *     contra una tabla nueva que no le cambia el número a nadie.
 *
 * La cotización **se convierte** en pedido cuando el cliente acepta: se crea un
 * `commercial.orders` normal y se guarda su `order_id` acá (linaje). Un solo camino al dinero.
 *
 * ── El renglón que NO matchea es el punto, no el borde ──────────────────────────────────────
 * `quote_lines.product_id` es **NULL-able a propósito**, y por eso existe `requested_text`.
 * Cuando el cliente manda su lista, una parte de los renglones NO se va a poder casar con
 * nuestro catálogo: pide algo que no manejamos, o lo llama distinto, o manda su propio código de
 * proveedor. Ese renglón **es información de negocio** —es demanda que estamos rechazando, el
 * mismo hecho que `commercial.floor_stockouts` captura en el mostrador— y desaparece si la tabla
 * exige un `product_id`. Se guarda lo que el cliente escribió, tal cual, y `availability` declara
 * por qué no hay precio. **NUNCA se cotiza en $0 un renglón sin precio**: va NULL y se declara.
 *
 * ── Cliente vs. contacto suelto ─────────────────────────────────────────────────────────────
 * `customer_id` también es NULL-able: una lista de cotización puede llegar de alguien que todavía
 * no es cliente (es justo el momento antes de serlo). El CHECK exige **una de las dos** — cliente
 * registrado o al menos un nombre de contacto — para que no exista una cotización anónima.
 *
 * ── Precio ofrecido vs. precio de lista ─────────────────────────────────────────────────────
 * Se guardan los DOS (`unit_price` y `list_price`). El descuento no se guarda como número
 * suelto: se DERIVA de la diferencia, porque un descuento guardado aparte se desincroniza del
 * precio en cuanto alguien edita uno de los dos. Y no hay CHECK de que el ofrecido sea menor:
 * a veces se cotiza arriba de lista (flete, urgencia). Lo que la pantalla hace es **mostrar la
 * diferencia**, no impedirla.
 *
 * El folio (`code`) se genera con el mismo UPSERT atómico de `commercial.order_sequences`
 * (ver esa migración): `ON CONFLICT (tenant_id, year) DO UPDATE ... RETURNING`. No se usa una
 * SEQUENCE de Postgres porque son globales (no por tenant) y no se rebobinan por año.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ───────────────────────────────────────────────────────────────────────────
  // commercial.quote_sequences — folio COT-YYYY-NNNNN por (tenant, año)
  // ───────────────────────────────────────────────────────────────────────────
  const hasSeq = await knex.schema.withSchema('commercial').hasTable('quote_sequences');
  if (!hasSeq) {
    await knex.schema.withSchema('commercial').createTable('quote_sequences', (table) => {
      table.uuid('tenant_id').notNullable();
      table.integer('year').notNullable();
      table.integer('current_value').notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      table.primary(['tenant_id', 'year']);
      table.check('?? > 0', ['year'], 'commercial_quote_sequences_year_positive');
      table.check('?? >= 0', ['current_value'], 'commercial_quote_sequences_current_nonneg');
    });

    await knex.raw(`
      ALTER TABLE commercial.quote_sequences
        ADD CONSTRAINT fk_commercial_quote_sequences_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE CASCADE
    `);
    await knex.raw(`ALTER TABLE commercial.quote_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.quote_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.quote_sequences
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.quote_sequences TO app_runtime',
    );
    await knex.raw(
      `COMMENT ON TABLE commercial.quote_sequences IS '[E.12] Counter atomico por (tenant, year) para generar quotes.code = COT-YYYY-NNNNN. Mismo patron que order_sequences.'`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // commercial.quotes — la oferta de precio
  // ───────────────────────────────────────────────────────────────────────────
  const hasQuotes = await knex.schema.withSchema('commercial').hasTable('quotes');
  if (!hasQuotes) {
    await knex.schema.withSchema('commercial').createTable('quotes', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.string('code', 30).notNullable(); // COT-2026-00001

      // A quién. Uno de los dos es obligatorio (CHECK abajo).
      table.uuid('customer_id'); // cliente registrado
      table.string('contact_name', 200); // prospecto sin alta todavia
      table.string('contact_phone', 40);
      table.string('contact_email', 200);

      // De dónde salió el pedido de cotización. No es cosmético: la lista que manda el cliente
      // y la venta levantada en la visita se trabajan distinto y se miden distinto.
      table.string('origin', 20).notNullable().defaultTo('telemarketing');

      table.uuid('user_id').notNullable(); // quien la está cotizando
      table.uuid('warehouse_id').notNullable(); // desde qué almacén se cotiza (precio y disponibilidad)
      table.uuid('price_list_id'); // lista base usada, snapshot

      table.string('status', 20).notNullable().defaultTo('draft');
      table.date('quote_date').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
      table.date('valid_until').notNullable(); // una cotización sin vigencia es una promesa eterna

      table.decimal('subtotal', 14, 2).notNullable().defaultTo(0);
      table.decimal('tax_total', 14, 2).notNullable().defaultTo(0);
      table.decimal('total', 14, 2).notNullable().defaultTo(0);
      table.string('currency', 3).notNullable().defaultTo('MXN');

      table.text('customer_request'); // la lista cruda que mandó el cliente, tal cual llegó
      table.text('notes'); // lo que ve el cliente
      table.text('internal_notes'); // lo que NO ve el cliente

      table.timestamp('sent_at');
      table.timestamp('accepted_at');
      table.timestamp('rejected_at');
      table.timestamp('cancelled_at');
      table.text('close_reason'); // por qué se perdió / se canceló

      // Linaje: el pedido en firme que nació de esta cotización.
      table.uuid('order_id');

      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');
      table.timestamp('deleted_at');
      table.uuid('deleted_by');

      table.primary('id');
      table.unique(['tenant_id', 'code'], { indexName: 'commercial_quotes_tenant_code_unique' });
      table.unique(['tenant_id', 'id'], { indexName: 'commercial_quotes_tenant_id_composite' });

      table.index('tenant_id', 'idx_commercial_quotes_tenant');
      table.index(['tenant_id', 'status'], 'idx_commercial_quotes_status');
      table.index(['tenant_id', 'customer_id'], 'idx_commercial_quotes_customer');
      table.index(['tenant_id', 'user_id'], 'idx_commercial_quotes_user');
      table.index(['tenant_id', 'valid_until'], 'idx_commercial_quotes_valid_until');
    });

    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT commercial_quotes_status_valid
        CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'))
    `);
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT commercial_quotes_origin_valid
        CHECK (origin IN ('telemarketing', 'route_visit', 'counter', 'portal'))
    `);
    // Una cotización anónima no le sirve a nadie: o hay cliente, o hay al menos un nombre.
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT commercial_quotes_has_recipient
        CHECK (customer_id IS NOT NULL OR nullif(btrim(coalesce(contact_name, '')), '') IS NOT NULL)
    `);
    // La vigencia no puede terminar antes de empezar.
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT commercial_quotes_valid_until_after_date
        CHECK (valid_until >= quote_date)
    `);
    // El pedido sólo puede colgar de una cotización aceptada. Si algún día hay un order_id
    // sobre una cotización rechazada, es que alguien convirtió por la puerta de atrás.
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT commercial_quotes_order_only_when_accepted
        CHECK (order_id IS NULL OR status = 'accepted')
    `);
    await knex.raw(
      `ALTER TABLE commercial.quotes ADD CONSTRAINT commercial_quotes_subtotal_nonneg CHECK (subtotal >= 0)`,
    );
    await knex.raw(
      `ALTER TABLE commercial.quotes ADD CONSTRAINT commercial_quotes_tax_nonneg CHECK (tax_total >= 0)`,
    );
    await knex.raw(
      `ALTER TABLE commercial.quotes ADD CONSTRAINT commercial_quotes_total_nonneg CHECK (total >= 0)`,
    );

    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT fk_commercial_quotes_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT fk_commercial_quotes_customer
        FOREIGN KEY (tenant_id, customer_id)
        REFERENCES commercial.customers(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT fk_commercial_quotes_user
        FOREIGN KEY (tenant_id, user_id)
        REFERENCES identity.users(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT fk_commercial_quotes_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT fk_commercial_quotes_price_list
        FOREIGN KEY (tenant_id, price_list_id)
        REFERENCES commercial.price_lists(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT fk_commercial_quotes_order
        FOREIGN KEY (tenant_id, order_id)
        REFERENCES commercial.orders(tenant_id, id) ON DELETE SET NULL
    `);

    await knex.raw(`ALTER TABLE commercial.quotes ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.quotes FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.quotes
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.quotes TO app_runtime');

    await knex.raw(
      `COMMENT ON TABLE commercial.quotes IS '[E.12] Cotizacion de mayoreo: oferta de precio con vigencia que todavia NO es venta. NO reserva stock. Al aceptarse se convierte en commercial.orders y se guarda el order_id (linaje). Dato propio HITL: no existe en ningun ERP.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quotes.customer_id IS 'NULL-able: una lista de cotizacion puede llegar de quien todavia no es cliente. El CHECK commercial_quotes_has_recipient exige cliente O contact_name.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quotes.origin IS 'telemarketing = el cliente mando su lista | route_visit = venta levantada en la visita | counter = mostrador | portal = autoservicio.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quotes.customer_request IS 'La lista cruda del cliente, tal cual llego (correo/WhatsApp pegado). Se conserva porque es la evidencia de que se cotizo lo que pidio.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quotes.order_id IS 'Linaje hacia el pedido en firme. La cotizacion NO se convierte en pedido: crea uno y lo apunta.'`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // commercial.quote_lines — el renglón, incluido el que no matchea
  // ───────────────────────────────────────────────────────────────────────────
  const hasLines = await knex.schema.withSchema('commercial').hasTable('quote_lines');
  if (!hasLines) {
    await knex.schema.withSchema('commercial').createTable('quote_lines', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('quote_id').notNullable();
      table.integer('line_number').notNullable();

      // NULL = lo que el cliente pidió no se pudo casar con el catálogo. Es el caso que este
      // submódulo existe para no perder, no un borde.
      table.uuid('product_id');
      // Lo que el cliente escribió, tal cual: su nombre, su código, su descripción.
      table.text('requested_text');
      table.decimal('requested_quantity', 14, 3);

      table.decimal('quantity', 14, 3).notNullable().defaultTo(0);
      // NULL = no se pudo poner precio. NUNCA 0 para decir "no sé" (regla dura del proyecto).
      table.decimal('unit_price', 14, 4);
      table.decimal('list_price', 14, 4); // precio de catálogo al momento: el descuento se DERIVA
      table.decimal('tax_rate', 5, 4).notNullable().defaultTo(0.16);
      table.decimal('line_subtotal', 14, 2).notNullable().defaultTo(0);
      table.decimal('line_total', 14, 2).notNullable().defaultTo(0);

      table.string('availability', 20).notNullable().defaultTo('unknown');
      table.decimal('stock_at_quote', 14, 3); // existencia al momento de cotizar, snapshot
      table.text('notes');

      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');

      table.primary('id');
      table.unique(['tenant_id', 'id'], { indexName: 'commercial_quote_lines_tenant_id_composite' });
      table.unique(['tenant_id', 'quote_id', 'line_number'], {
        indexName: 'commercial_quote_lines_quote_linenum_unique',
      });

      table.index(['tenant_id', 'quote_id'], 'idx_commercial_quote_lines_quote');
      table.index(['tenant_id', 'product_id'], 'idx_commercial_quote_lines_product');
    });

    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT commercial_quote_lines_availability_valid
        CHECK (availability IN ('available', 'partial', 'unavailable', 'not_carried', 'unmatched', 'unknown'))
    `);
    // Un renglón sin producto tiene que decir QUÉ pidió el cliente, o no es un renglón.
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT commercial_quote_lines_identified
        CHECK (product_id IS NOT NULL OR nullif(btrim(coalesce(requested_text, '')), '') IS NOT NULL)
    `);
    // Sin producto no hay precio nuestro: el renglón informa demanda, no cobra.
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT commercial_quote_lines_unmatched_has_no_price
        CHECK (product_id IS NOT NULL OR unit_price IS NULL)
    `);
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT commercial_quote_lines_qty_nonneg CHECK (quantity >= 0)
    `);
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT commercial_quote_lines_price_nonneg CHECK (unit_price IS NULL OR unit_price >= 0)
    `);
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT commercial_quote_lines_list_price_nonneg CHECK (list_price IS NULL OR list_price >= 0)
    `);

    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT fk_commercial_quote_lines_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT fk_commercial_quote_lines_quote
        FOREIGN KEY (tenant_id, quote_id)
        REFERENCES commercial.quotes(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE commercial.quote_lines
        ADD CONSTRAINT fk_commercial_quote_lines_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
    `);

    await knex.raw(`ALTER TABLE commercial.quote_lines ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.quote_lines FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.quote_lines
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.quote_lines TO app_runtime');

    await knex.raw(
      `COMMENT ON TABLE commercial.quote_lines IS '[E.12] Renglon de cotizacion. product_id NULL-able A PROPOSITO: el renglon que no casa con el catalogo es demanda que estamos rechazando, y se pierde si la tabla exige producto.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quote_lines.requested_text IS 'Lo que el cliente escribio, tal cual (su nombre / su codigo). Unica identificacion cuando product_id es NULL.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quote_lines.unit_price IS 'Precio OFRECIDO. NULL = no se pudo cotizar; NUNCA 0 para decir no-se.'`,
    );
    await knex.raw(
      `COMMENT ON COLUMN commercial.quote_lines.list_price IS 'Precio de catalogo al momento. El descuento se DERIVA de la diferencia con unit_price: guardarlo aparte se desincroniza en cuanto alguien edita uno de los dos.'`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Permisos: COMMERCIAL_QUOTES_VER y COMMERCIAL_QUOTES_GESTIONAR
  // ───────────────────────────────────────────────────────────────────────────
  const roles_ver = ['superadmin', 'admin', 'supervisor', 'supervisor_ventas', 'telemarketing', 'direccion'];
  const roles_manage = ['superadmin', 'admin', 'supervisor', 'supervisor_ventas', 'telemarketing'];

  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || ?::jsonb
      WHERE role_name = ANY(?)`,
    [JSON.stringify({ COMMERCIAL_QUOTES_VER: true }), roles_ver],
  );
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || ?::jsonb
      WHERE role_name = ANY(?)`,
    [JSON.stringify({ COMMERCIAL_QUOTES_GESTIONAR: true }), roles_manage],
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('quote_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('quotes');
  await knex.schema.withSchema('commercial').dropTableIfExists('quote_sequences');
};
