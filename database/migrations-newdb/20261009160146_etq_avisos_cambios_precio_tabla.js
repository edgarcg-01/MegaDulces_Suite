'use strict';
/**
 * `[ETQ-AVISOS.1]` — `commercial.price_change_notices`: el aviso de «hubo cambios de precio» que
 * SOBREVIVE a que nadie estuviera mirando.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────────────────────
 * La encargada se entera de que un precio cambió sólo si abre «Cambios de precio». Si no la abre,
 * la etiqueta del anaquel queda vieja hasta que un cliente reclama en la caja (caso real del
 * 2026-10-08: el 91059 tenía en el anaquel $5,602.87 por 500 g y Kepler ya decía $203.85).
 *
 * ── Por qué una fila y no sólo un WebSocket ────────────────────────────────────────────────
 * Los avisos nacen en el WORKER (cron), que no tiene WebSocket (ADR-080). La fila ES la entrega:
 * la campana la recoge por poll. Mismo argumento y mismo molde que `[VEC.4]`
 * (`commercial.order_notifications`) y que el canal `app` de la Mesa de Servicio.
 *
 * ── Por qué guarda tan poco ─────────────────────────────────────────────────────────────────
 * Guarda el HECHO (esta plaza tuvo N productos con cambio ese día) y quién lo mandó. NO guarda la
 * lista: la lista se DERIVA de `analytics.v_label_price_changes` al abrir la pantalla. Copiarla acá
 * sería una segunda verdad que envejece — y el aviso diría una cosa y la pantalla otra.
 *
 * ── Reglas que la propia tabla hace cumplir (con prueba negativa al final) ─────────────────
 *  · `productos >= 1`: un día sin cambios NO genera aviso (D4). Un aviso vacío enseña a ignorar la
 *    campana.
 *  · `productos = suben + bajan + sin_precio`: el aviso cuadra por construcción.
 *  · `origen` y `corte` son coherentes, y `created_by` sólo existe cuando lo manda una persona.
 *  · Un aviso AUTOMÁTICO por (plaza, día, corte): reintentar el cron no duplica.
 *
 * Los de Compras NO tienen llave única: una persona puede avisar dos veces la misma plaza (la
 * segunda con otra nota). El freno contra el reenvío accidental vive en el servicio.
 *
 * ⚠️ Migración ADITIVA: va ANTES del código que la lee.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const existe = await knex.schema.withSchema('commercial').hasTable('price_change_notices');
  if (!existe) {
    await knex.schema.withSchema('commercial').createTable('price_change_notices', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      // Plaza de DOS dígitos, la misma forma que valida el backend de la pantalla de cambios.
      t.string('plaza', 2).notNullable();
      // Día de la bitácora que resume. El corte de la mañana resume AYER; el de la tarde, HOY.
      t.date('fecha').notNullable();
      t.string('corte', 10).notNullable();
      t.string('origen', 10).notNullable();
      t.integer('productos').notNullable();
      t.integer('suben').notNullable();
      t.integer('bajan').notNullable();
      t.integer('sin_precio').notNullable();
      t.text('nota');
      t.uuid('created_by');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'id']);
    });
  }

  const ck = async (name, expr) => {
    const { rows } = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'commercial.price_change_notices'::regclass`, [name]);
    if (!rows.length) await knex.raw(`ALTER TABLE commercial.price_change_notices ADD CONSTRAINT ${name} CHECK (${expr})`);
  };
  await ck('pcn_plaza_ck', `plaza ~ '^[0-9]{2}$'`);
  await ck('pcn_corte_ck', `corte IN ('manana','tarde','compras')`);
  await ck('pcn_origen_ck', `origen IN ('auto','compras')`);
  // El corte dice quién lo mandó: los dos automáticos son del cron, `compras` es de una persona.
  await ck('pcn_origen_corte_ck', `(origen = 'auto' AND corte IN ('manana','tarde')) OR (origen = 'compras' AND corte = 'compras')`);
  // D4: nunca un aviso vacío.
  await ck('pcn_productos_ck', `productos >= 1 AND suben >= 0 AND bajan >= 0 AND sin_precio >= 0`);
  await ck('pcn_cuadra_ck', `productos = suben + bajan + sin_precio`);
  // Sólo una persona manda; el cron no tiene usuario. Y la nota es de Compras, no del cron.
  await ck('pcn_autor_ck', `(origen = 'compras') = (created_by IS NOT NULL)`);
  await ck('pcn_nota_ck', `nota IS NULL OR (origen = 'compras' AND char_length(nota) <= 500)`);

  // Idempotencia del cron: UN aviso automático por (plaza, día, corte).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pcn_auto
      ON commercial.price_change_notices (tenant_id, plaza, fecha, corte)
      WHERE origen = 'auto'`);
  // La consulta de la campana: lo más nuevo primero, recortado por plaza.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pcn_campana
      ON commercial.price_change_notices (tenant_id, created_at DESC, plaza)`);
  // El freno contra el reenvío: «¿esta persona ya avisó esta plaza y día hace poco?».
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pcn_reenvio
      ON commercial.price_change_notices (tenant_id, created_by, plaza, fecha, created_at DESC)
      WHERE origen = 'compras'`);

  // RLS forzado + grant, igual que el resto de `commercial.*`. Sin DELETE: un aviso no se borra.
  await knex.raw('ALTER TABLE commercial.price_change_notices ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.price_change_notices FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS price_change_notices_tenant ON commercial.price_change_notices');
  await knex.raw(`
    CREATE POLICY price_change_notices_tenant ON commercial.price_change_notices
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON commercial.price_change_notices TO app_runtime');

  await knex.raw(`COMMENT ON TABLE commercial.price_change_notices IS
    'ETQ-AVISOS.1 — aviso a una plaza de que hubo cambios de precio (corte manana = AYER, tarde = HOY, o enviado por Compras). Guarda el HECHO (conteos) y quien lo mando; la LISTA se deriva de analytics.v_label_price_changes al abrir la pantalla: copiarla seria una segunda verdad que envejece. Nunca vacio (productos >= 1). Nace en el worker, sin WebSocket: la fila es la entrega y la campana la recoge por poll.'`);

  // ── COMPUERTAS ──────────────────────────────────────────────────────────────────────────
  // [1] RLS de verdad, no declarado.
  const { rows: rls } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'price_change_notices'`);
  if (!rls[0]?.on || !rls[0]?.forced) {
    throw new Error('[ETQ-AVISOS.1] RLS no quedó habilitado+forzado en price_change_notices.');
  }

  // [2] PRUEBA NEGATIVA de los CHECK. Cada intento va en un SAVEPOINT: knex corre la migración en UNA
  //     transacción, y un error provocado la aborta (25P02) sin que un try/catch la rescate.
  //     Sin tenant con el que probar se DECLARA (ADR-056), no se da por bueno.
  const { rows: tn } = await knex.raw(`SELECT id FROM public.tenants ORDER BY created_at LIMIT 1`);
  if (!tn.length) {
    console.log('  [ETQ-AVISOS.1] ◻ NO MEDIDO: no hay un tenant con el que probar los CHECK.');
    return;
  }
  const t = tn[0].id;
  // Si la migración no corre como superusuario, el RLS forzado rechazaría hasta lo válido.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]);
  const base = { plaza: '01', fecha: '2026-01-01', corte: 'manana', origen: 'auto', productos: 3, suben: 1, bajan: 1, sin_precio: 1, nota: null, created_by: null };
  const insert = (o) => knex.raw(
    `INSERT INTO commercial.price_change_notices (tenant_id, plaza, fecha, corte, origen, productos, suben, bajan, sin_precio, nota, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [t, o.plaza, o.fecha, o.corte, o.origen, o.productos, o.suben, o.bajan, o.sin_precio, o.nota, o.created_by]);
  const quien = '00000000-0000-0000-0000-000000000001';
  // Tiene que rebotar POR ESE CHECK: un rechazo por otra causa (RLS, tipo) daría verde sin probar nada.
  const debeFallar = async (nombre, constraint, o) => {
    await knex.raw('SAVEPOINT pcn_neg');
    let porEse = false;
    try { await insert({ ...base, ...o }); } catch (e) { porEse = String(e.message).includes(constraint); }
    await knex.raw('ROLLBACK TO SAVEPOINT pcn_neg');
    await knex.raw('RELEASE SAVEPOINT pcn_neg');
    if (!porEse) throw new Error(`[ETQ-AVISOS.1] el CHECK «${nombre}» (${constraint}) NO rechazó lo que debía.`);
  };
  await debeFallar('un aviso vacío', 'pcn_productos_ck', { productos: 0, suben: 0, bajan: 0, sin_precio: 0 });
  await debeFallar('productos = suben+bajan+sin_precio', 'pcn_cuadra_ck', { productos: 5 });
  await debeFallar('plaza de dos dígitos', 'pcn_plaza_ck', { plaza: 'ABC' });
  await debeFallar('origen/corte coherentes', 'pcn_origen_corte_ck', { origen: 'auto', corte: 'compras' });
  await debeFallar('el cron no tiene autor', 'pcn_autor_ck', { created_by: quien });
  await debeFallar('Compras sin autor', 'pcn_autor_ck', { origen: 'compras', corte: 'compras', created_by: null });
  await debeFallar('la nota es de Compras, no del cron', 'pcn_nota_ck', { nota: 'hola' });
  // …y lo válido SÍ entra (si no, los negativos de arriba podrían estar fallando por otra causa).
  await knex.raw('SAVEPOINT pcn_pos');
  await insert(base);
  await knex.raw('ROLLBACK TO SAVEPOINT pcn_pos');
  await knex.raw('RELEASE SAVEPOINT pcn_pos');
  console.log('  [ETQ-AVISOS.1] ✓ RLS forzado y 7 CHECK con prueba negativa.');
};

exports.down = async function down(knex) {
  // Un aviso es historia: no se borra la tabla en un down accidental. Se deja y se declara.
  console.log('  [ETQ-AVISOS.1] down: price_change_notices se CONSERVA (es historial de avisos).');
};
