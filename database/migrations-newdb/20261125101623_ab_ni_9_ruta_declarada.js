'use strict';
/**
 * `[AB.NI.9]` — **La ruta de abasto pasa a ser una decisión con dueño, no un cálculo de madrugada.**
 *
 * Pedido de Edgar el 2026-11-25: «se deben poder hacer ambos desde la misma, con un pedido manual»
 * y «debemos eliminar por completo los import».
 *
 * ── Lo medido antes, en prod, sólo lectura (2026-11-25) ─────────────────────────────────────
 *  · El renglón cuyo producto no tiene ruta **no se puede mandar a ningún lado**
 *    (`motivoNoEnviable()` → «No tiene a quién pedírselo»). Cruzando los **375 proveedores
 *    activos con producto** contra `commercial.replenishment_channel`, **entre un cuarto y la
 *    mitad no tienen ruta en cada sucursal**: 05 y 07 el **48.8 %**, 04 Yurécuaro **151/375
 *    (40.3 %)**. *Ese es el momento en que la sucursal agarra papel.*
 *  · La ruta la deriva `import-replenishment-cadence.js` del histórico de 180 días: **un
 *    proveedor que apenas empezó a llegar nunca tiene ruta.**
 *  · El candado ya existía y nunca se usó: **2,390 filas, las 2,390 `derived`, cero `manual`**,
 *    y **ninguna línea de TypeScript nombra `cadence_source`**.
 *
 * ⭐⭐ ── Y lo que de verdad decidió este diseño: LA RUTA DERIVADA ES UNA MONEDA AL AIRE ───────
 *  Comparando la misma derivación corrida **ahora** contra la tabla que el importer dejó a las
 *  **03:23 del mismo día**, sobre los 2,076 pares que están en ambas:
 *    · **145 pares traen otra `via`** — 141 pasaron de «de matriz» a «compra directa» **en siete
 *      horas**, porque entraron **284 entradas hoy, las 284 después de las 03:23** (última
 *      ingesta 10:15). *La tabla es una foto que ya está vieja cuando alguien la mira.*
 *    · El voto que decide la `via` es **un empate en 70 pares**, y **61 de esos 70 discrepan**:
 *      el desempate lo da `ORDER BY ... , channel`, o sea **el orden alfabético**.
 *    · Otros **109 pares ganan por UN día**, y 41 de ellos discrepan.
 *    · De los 1,279 pares con un solo canal, discrepan **3**.
 *  ➡️ Para ~180 pares, *dónde se pide la mercancía* lo decide una entrega de más. Eso **no es una
 *     medición**: derivar la ruta no era sólo caro, era **incorrecto**.
 *
 * ── Qué hace esta migración ─────────────────────────────────────────────────────────────────
 *  1. `commercial.replenishment_route` — la ruta **declarada**: dato propio (HITL), escrita por
 *     EVENTO (la sucursal propone / Compras confirma). ⛔ Ningún job la toca.
 *  2. **Siembra** desde `replenishment_channel`, marcada `origen='inherited'` para **no cambiar
 *     el comportamiento de hoy** (una ruta heredada sigue siendo enviable: cero regresión).
 *  3. `commercial.v_replenishment_route` — la ruta para el camino de pantalla. ⛔ **No toca
 *     `analytics.stock_movements`** (criterio §10.7.8 del anexo).
 *
 * ⛔ **La CADENCIA no entra acá, y la medición dice por qué.** El cuerpo de la derivación corrido
 *    como vista tarda **58.9 s** (y **1,276 ms** sólo su tramo de clasificación), y sus columnas
 *    las consumen **pantallas** —`compras-pedido-real.component.ts`, 45 usos en
 *    `commercial-replenishment.service.ts`—, no sólo el escáner. *Materializar por costo es
 *    legítimo; lo que no es legítimo es refrescarlo con un importer de madrugada.* La cadencia se
 *    queda materializada y su refresco pasa a ser **por evento** en un item aparte.
 *
 * ⛔ Esta migración **NO borra** `commercial.replenishment_channel`: es la única copia de 2,390
 *    filas y borrarla pide la autorización explícita de la regla 5.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La ruta declarada ──────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('replenishment_route'))) {
    await knex.raw(`
      CREATE TABLE commercial.replenishment_route (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        warehouse_id        uuid NOT NULL,
        supplier_id         uuid NOT NULL,
        via                 varchar(10) NOT NULL CHECK (via IN ('purchase','transfer')),
        source_warehouse_id uuid,
        -- 'inherited' = lo que el importer había derivado al sembrar. NO es decisión de nadie,
        --               pero SÍ es enviable: preservar el comportamiento de hoy es la prioridad.
        -- 'proposed'  = una sucursal la declaró y espera a Compras. Todavía NO autoriza escribir
        --               en Kepler: un X-A-30 a un proveedor equivocado es un acto hacia afuera.
        -- 'declared'  = confirmada por Compras. Es la ruta.
        origen              varchar(10) NOT NULL DEFAULT 'proposed'
                            CHECK (origen IN ('inherited','proposed','declared')),
        -- ⚠️ Marca las rutas heredadas cuyo valor derivado era RUIDO (empate o ventaja de un solo
        -- día en el voto del importer). Medido el 2026-11-25: 70 empates + 109 por un día, y de
        -- esos 102 ya habían cambiado de valor en siete horas. Sirven para que Compras las revise;
        -- NO las bloquea, porque bloquearlas rompería lo que hoy funciona.
        ruta_fragil         boolean NOT NULL DEFAULT false,
        declared_by         uuid,
        declared_at         timestamptz,
        confirmed_by        uuid,
        confirmed_at        timestamptz,
        nota                text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, warehouse_id, supplier_id),
        UNIQUE (tenant_id, id),
        -- ⛔ Un traspaso sin origen no es una ruta: no se sabe quién surte.
        CHECK (via <> 'transfer' OR source_warehouse_id IS NOT NULL),
        -- ⛔ Confirmada sin confirmante es una afirmación sin autor (ADR-056).
        CHECK (origen <> 'declared' OR confirmed_at IS NOT NULL),
        FOREIGN KEY (tenant_id, warehouse_id)        REFERENCES commercial.warehouses (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, supplier_id)         REFERENCES catalog.suppliers     (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, source_warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_replen_route_wh ON commercial.replenishment_route (tenant_id, warehouse_id)`);
    await knex.raw(`CREATE INDEX ix_replen_route_pendiente ON commercial.replenishment_route (tenant_id, origen) WHERE origen = 'proposed'`);
    await knex.raw(`CREATE INDEX ix_replen_route_fragil ON commercial.replenishment_route (tenant_id, warehouse_id) WHERE ruta_fragil`);
    await knex.raw(`COMMENT ON TABLE commercial.replenishment_route IS '[AB.NI.9] Ruta de abasto DECLARADA por una persona (HITL). Escrita por evento: la sucursal propone, Compras confirma. Ningún job la toca. origen=inherited son las filas sembradas del importer que se retira; ruta_fragil marca aquellas cuyo valor derivado era un empate o ganaba por un día.'`);

    await knex.raw(`ALTER TABLE commercial.replenishment_route ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.replenishment_route FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='replenishment_route' AND policyname='tenant_isolation'
        ) THEN
          CREATE POLICY tenant_isolation ON commercial.replenishment_route
            USING (tenant_id = public.current_tenant_id())
            WITH CHECK (tenant_id = public.current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.replenishment_route TO app_runtime`);
  }

  // ── 2. Siembra: lo que el importer dejó, marcado como HEREDADO ────────────────────────────
  // ⛔ `origen='inherited'` y SIN `declared_by`: nadie decidió estas filas, se midieron. Que la
  //    pantalla pueda distinguirlas es el punto — una ruta heredada se corrige sin culpa.
  // ⚠️ Un `transfer` sin `source_warehouse_id` toma el de la topología del almacén
  //    (`warehouses.source_warehouse_id`, que es de donde salía). Si tampoco hay, la fila **no se
  //    siembra** —el CHECK la rechazaría— y queda como «sin ruta», que es la verdad.
  if (await knex.schema.withSchema('commercial').hasTable('replenishment_channel')) {
    const sembradas = await knex.raw(`
      INSERT INTO commercial.replenishment_route
        (tenant_id, warehouse_id, supplier_id, via, source_warehouse_id, origen, nota, created_at, updated_at)
      SELECT rc.tenant_id, rc.warehouse_id, rc.supplier_id, rc.via,
             CASE WHEN rc.via = 'transfer' THEN COALESCE(rc.source_warehouse_id, w.source_warehouse_id) END,
             'inherited',
             'Sembrada de commercial.replenishment_channel al retirar import-replenishment-cadence.js ([AB.NI.9], 2026-11-25). Derivada del histórico de entregas, NO decidida por una persona.',
             now(), now()
        FROM commercial.replenishment_channel rc
        JOIN commercial.warehouses w ON w.tenant_id = rc.tenant_id AND w.id = rc.warehouse_id
       WHERE rc.via = 'purchase'
          OR COALESCE(rc.source_warehouse_id, w.source_warehouse_id) IS NOT NULL
      ON CONFLICT (tenant_id, warehouse_id, supplier_id) DO NOTHING`);
    // eslint-disable-next-line no-console
    console.log(`  [AB.NI.9] rutas sembradas: ${sembradas.rowCount}`);
  }

  // ── 3. La ruta para el camino de pantalla ─────────────────────────────────────────────────
  // ⛔ NO toca `analytics.stock_movements`: la pantalla lee ruta, no cadencia. `enviable` dice si
  //    la Suite puede escribir el documento.
  await knex.raw(`
    CREATE OR REPLACE VIEW commercial.v_replenishment_route AS
    SELECT r.tenant_id, r.warehouse_id, r.supplier_id, r.via, r.source_warehouse_id,
           r.origen, r.ruta_fragil, r.declared_by, r.declared_at, r.confirmed_by, r.confirmed_at, r.nota,
           (r.origen IN ('inherited','declared')) AS enviable
      FROM commercial.replenishment_route r`);
  await knex.raw(`COMMENT ON VIEW commercial.v_replenishment_route IS '[AB.NI.9] La ruta de abasto para el camino de pantalla. NO toca analytics.stock_movements. enviable=false mientras una ruta propuesta espera a Compras.'`);
  await knex.raw(`GRANT SELECT ON commercial.v_replenishment_route TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS commercial.v_replenishment_route`);
  await knex.schema.withSchema('commercial').dropTableIfExists('replenishment_route');
};
