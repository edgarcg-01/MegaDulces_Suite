/**
 * `[SB.1]` El corte **Wincaja → Kepler** deja de ser un LITERAL repetido en cada vista y pasa a
 * ser un **DATO** que se declara una vez y se lee desde donde haga falta.
 *
 * ── Qué lo disparó, medido en prod el 2026-09-23 ───────────────────────────────────────────
 * "En `/comercial/salidas`, al imprimir no sale Morelia Abastos". La pantalla, en modo rango
 * (su default de 15 días), deriva el scope de sucursales de `analytics.mv_sales_blended`, y ahí
 * la `08` **no existe en ninguna fecha, por ninguna de las dos piernas**:
 *
 *   pierna KEPLER  → `source_branch IN ('01','02','03','04','05','06','07')` … la `08` no está.
 *   pierna WINCAJA → `wincaja_only = true OR source_branch IN ('10','42','50')` … la `30` tampoco,
 *                    y `wincaja_only` se deriva de `kepler_code IS NULL`, que `[RL.10]` apagó.
 *
 * Lo perdido, contado: **$1,636,170.10** de venta Kepler de Abastos (19–21 sep, 5,725 filas, y
 * crece todos los días) **más todo el histórico Wincaja de Madero `32`**, que se cayó del blend
 * el día que `[RL.10]` le puso el `kepler_code` — el mismo acoplamiento que esa migración
 * documenta para `10/42/50`, sólo que en `v_sellout_daily` sí se enumeró y acá no.
 *
 * ── La causa de fondo: DOS listas con la misma información ──────────────────────────────────
 * `v_sellout_daily` y `mv_sales_blended` llevan cada una su propia copia de los cortes. El
 * cutover de Abastos (`[RL.10]`, 2026-09-18) actualizó la primera y no la segunda, y nada lo
 * avisó: el candado `test-newdb-sellout-parity.js` mide hueco y doble conteo **sólo sobre
 * `v_sellout_daily`/`mv_sellout_monthly`** — `mv_sales_blended` no está en su lista de objetos.
 * Un primitivo copiado a mano no cierra nada (ADR-056); acá se copió dos veces y divergió.
 *
 * ── Por qué la fecha se DECLARA y no se infiere ─────────────────────────────────────────────
 * `wincaja.branches` ya tenía media respuesta: `source_branch` ↔ `kepler_code` ↔
 * `last_movement_date`. Tentaba derivar `cutover = last_movement_date + 1`, y para tres ramas
 * da exacto (`30`→09-18, `32`→09-08, `50`→08-15). **No es regla**, medido contra el dato real:
 *
 *   rama `10` PH       último Wincaja 2026-06-26 · primer Kepler 2026-06-27 · corte 2026-07-01
 *   rama `42` Piedad   último Wincaja 2025-10-09 · primer Kepler 2025-01-01 · corte 2025-10-01
 *
 * En PH el corte va 4 días DESPUÉS de que Kepler ya vendía; en Piedad las dos piernas se
 * traslapan 9 meses. El cutover es una **decisión** (qué pierna manda en la zona de traslape),
 * no un hecho derivable — así que es dato propio, con columna propia (⭐ regla del proyecto:
 * derivar lo derivable, tabla real sólo para lo que nace acá).
 *
 * ── Semántica de `kepler_cutover_date`, sin ambigüedad ──────────────────────────────────────
 *   fecha real   → Kepler manda desde ese día (`>=`), Wincaja hasta el anterior (`<`).
 *   `-infinity`  → Kepler manda SIEMPRE; la rama Wincaja de esa sucursal no entra (`03/04/05`).
 *   NULL         → la rama no participa del fact de venta (CEDIS `00`, que sigue vivo en
 *                  Wincaja y nunca estuvo en el blend; y las rutas, que entran por su propia
 *                  pierna `RUTA-%`).
 *
 * Con eso los `EXISTS` reproducen **exactamente** el filtro literal de hoy — `-infinity` hace
 * verdadero cualquier `business_date >= cutover`, y ninguna fecha es `< -infinity`.
 *
 * ── Qué cambia de cifras, y qué NO ──────────────────────────────────────────────────────────
 * Los cinco cortes se siembran con los valores HOY vigentes: **ningún corte se mueve**. Lo único
 * que cambia en `mv_sales_blended` es que entra lo que le faltaba (Abastos `08` completa +
 * histórico Wincaja de Madero `32`), que es el bug que esto arregla. `v_sellout_daily` queda
 * numéricamente IDÉNTICA: se le cambia la forma del filtro, no su resultado.
 *
 * ⚠️ **Dos huecos medidos que esta migración NO toca, a propósito** (mover un corte es cambiar
 * alcance de negocio, y va en su propio commit con su antes/después):
 *   Abastos `30` · **2026-09-18** · $418,721.65 — Wincaja tiene ese día, el corte lo excluye
 *       (`< 09-18`) y Kepler no arranca hasta el 19. Un día de venta sin ninguna pierna.
 *   Padre Hidalgo `01` · **2026-06-27 → 06-30** · $916,629.73 — Kepler ya vendía y el corte
 *       (`>= 07-01`) lo descarta; Wincaja terminó el 06-26.
 * Quedan declarados en el COMMENT de la columna para que se decidan con dueño, no en silencio.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

/** Los cortes HOY vigentes, leídos de los literales de las vistas en prod (2026-09-23).
 *  Sembrar ≠ decidir: esto congela el estado actual para que el cambio sea de FORMA, no de cifra. */
const CORTES = [
  { rama: '10', kepler: '01', cutover: '2026-07-01' },
  { rama: '42', kepler: '02', cutover: '2025-10-01' },
  { rama: '40', kepler: '03', cutover: '-infinity' },
  { rama: '44', kepler: '04', cutover: '-infinity' },
  { rama: '54', kepler: '05', cutover: '-infinity' },
  { rama: '50', kepler: '06', cutover: '2026-08-15' },
  { rama: '32', kepler: '07', cutover: '2026-09-08' },
  { rama: '30', kepler: '08', cutover: '2026-09-18' },
];

/** Firmas EXACTAS de `pg_get_viewdef(..., true)` leídas en prod el 2026-09-23. Si alguna no
 *  aparece exactamente una vez se ABORTA: parchear a medias una vista de venta mueve dinero. */
const SELLOUT_KEPLER_VIEJO =
  `(k.source_branch = '01'::text AND k.business_date >= '2026-07-01'::date OR k.source_branch = '02'::text AND k.business_date >= '2025-10-01'::date OR k.source_branch = '06'::text AND k.business_date >= '2026-08-15'::date OR (k.source_branch = ANY (ARRAY['03'::text, '04'::text, '05'::text])) OR k.source_branch = '07'::text AND k.business_date >= '2026-09-08'::date OR k.source_branch = '08'::text AND k.business_date >= '2026-09-18'::date)`;
const SELLOUT_WINCAJA_VIEJO =
  `(vl.wincaja_only = true OR vl.source_branch = '10'::text AND vl.business_date < '2026-07-01'::date OR vl.source_branch = '42'::text AND vl.business_date < '2025-10-01'::date OR vl.source_branch = '50'::text AND vl.business_date < '2026-08-15'::date OR vl.source_branch = '30'::text AND vl.business_date < '2026-09-18'::date OR vl.source_branch = '32'::text AND vl.business_date < '2026-09-08'::date)`;

const keplerExists = (alias) => `EXISTS (
        SELECT 1 FROM analytics.v_branch_erp_cutover x
         WHERE x.tenant_id = ${alias}.tenant_id
           AND x.kepler_code = ${alias}.source_branch
           AND ${alias}.business_date >= x.cutover_date)`;

const wincajaExists = (alias) => `(${alias}.wincaja_only = true OR EXISTS (
        SELECT 1 FROM analytics.v_branch_erp_cutover x
         WHERE x.tenant_id = ${alias}.tenant_id
           AND x.wincaja_source_branch = ${alias}.source_branch
           AND ${alias}.business_date < x.cutover_date))`;

async function crearResolvedor(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_branch_erp_cutover AS
      SELECT b.tenant_id,
             b.source_branch  AS wincaja_source_branch,
             b.kepler_code,
             b.warehouse_code,
             b.kepler_cutover_date AS cutover_date
        FROM wincaja.branches b
       WHERE b.kepler_code IS NOT NULL
         AND b.kepler_cutover_date IS NOT NULL
         AND COALESCE(b.is_route, false) = false`);
  await knex.raw(`GRANT SELECT ON analytics.v_branch_erp_cutover TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_branch_erp_cutover IS
    'SB.1 · RESOLVEDOR ÚNICO del corte Wincaja→Kepler. Una fila por sucursal migrada: desde cutover_date manda Kepler (>=), antes manda su rama Wincaja (<). -infinity = Kepler siempre. Lo leen v_sellout_daily y mv_sales_blended por EXISTS; NO volver a escribir el corte como literal en una vista (ADR-056: un primitivo copiado a mano diverge — pasó, y costó $1.63M de Abastos invisibles).'`);
}

/** Reescribe el cuerpo VIVO de `v_sellout_daily` cambiando sólo los dos filtros de corte. */
async function parchearSelloutDaily(knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;
  if (def.includes('v_branch_erp_cutover')) {
    console.log('  v_sellout_daily ya lee el resolvedor — skip (idempotente).');
    return;
  }
  for (const [nombre, ancla] of [['kepler', SELLOUT_KEPLER_VIEJO], ['wincaja', SELLOUT_WINCAJA_VIEJO]]) {
    const veces = def.split(ancla).length - 1;
    if (veces !== 1) {
      throw new Error(`[SB.1] ABORTA: el filtro ${nombre} de v_sellout_daily aparece ${veces} veces `
        + `(se esperaba 1). La vista cambió: leer pg_get_viewdef y reescribir el ancla ANTES de parchear.`);
    }
  }
  def = def.replace(SELLOUT_KEPLER_VIEJO, keplerExists('k'));
  def = def.replace(SELLOUT_WINCAJA_VIEJO, wincajaExists('vl'));
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);
  console.log('  v_sellout_daily → lee v_branch_erp_cutover (mismo resultado, sin literales).');
}

/** `mv_sales_blended` se RECREA entera: es matview, no admite CREATE OR REPLACE.
 *  Cuerpo = el de prod (2026-09-23) con los dos filtros cambiados por EXISTS. */
async function recrearBlend(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sales_blended AS
      SELECT tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind,
             SUM(units) AS units, SUM(revenue) AS revenue, SUM(cost) AS cost,
             SUM(tickets) AS tickets, MAX(updated_at) AS updated_at
        FROM (
          -- (1) KEPLER sucursales — el corte lo pone v_branch_erp_cutover, no un literal.
          SELECT k.tenant_id, k.product_id, w.id AS warehouse_id,
                 CASE k.channel WHEN 'mostrador' THEN 'tienda' WHEN 'credito' THEN 'contado_nf'
                   ELSE k.channel END AS channel,
                 k.business_date AS sale_date, k.unit_kind, k.units,
                 k.monto AS revenue,
                 round(k.monto / (1 + COALESCE(p.markup_pct, 0) / 100.0), 2) AS cost,
                 CASE WHEN row_number() OVER (PARTITION BY k.tenant_id, k.business_date,
                        k.source_branch, k.product_id, k.channel ORDER BY k.unit_kind) = 1
                      THEN COALESCE(ktc.tickets, 0) ELSE 0 END AS tickets,
                 k.business_date::timestamptz AS updated_at
            FROM analytics.mv_kepler_sales_daily k
            JOIN commercial.warehouses w
              ON w.tenant_id = k.tenant_id AND w.code::text = k.warehouse_code::text
             AND w.deleted_at IS NULL
            LEFT JOIN catalog.products p ON p.id = k.product_id
            LEFT JOIN analytics.v_kepler_ticket_count ktc
              ON ktc.tenant_id = k.tenant_id AND ktc.business_date = k.business_date
             AND ktc.source_branch = k.source_branch AND ktc.product_id = k.product_id
             AND ktc.channel = k.channel
           WHERE k.product_deleted = false
             AND ${keplerExists('k')}
          UNION ALL
          -- (2) RUTAS (venta a bordo) — no tienen corte de ERP, entran por su propio prefijo.
          SELECT sd.tenant_id, sd.product_id, sd.warehouse_id, sd.channel, sd.sale_date,
                 sd.unit_kind, sd.units, sd.revenue, sd.cost, sd.tickets, sd.updated_at
            FROM analytics.sales_daily sd
            JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           WHERE sd.channel NOT LIKE 'wincaja_%'
             AND w.code::text LIKE 'RUTA-%'
             AND sd.sale_date >= '2026-07-01'::date
          UNION ALL
          -- (3) WINCAJA — complemento EXACTO de (1): la misma fecha, del otro lado.
          SELECT mw.tenant_id, mw.product_id, w.id AS warehouse_id,
                 'wincaja_' || mw.channel AS channel,
                 mw.business_date AS sale_date, mw.unit_kind, mw.units,
                 mw.monto AS revenue, mw.costo AS cost,
                 CASE WHEN row_number() OVER (PARTITION BY mw.tenant_id, mw.business_date,
                        mw.source_branch, mw.product_id, mw.channel ORDER BY mw.unit_kind) = 1
                      THEN COALESCE(wtc.tickets, 0) ELSE 0 END AS tickets,
                 mw.business_date::timestamptz AS updated_at
            FROM analytics.mv_wincaja_sales_daily mw
            JOIN commercial.warehouses w
              ON w.tenant_id = mw.tenant_id AND w.code::text = mw.warehouse_code::text
             AND w.deleted_at IS NULL
            LEFT JOIN analytics.v_wincaja_ticket_count wtc
              ON wtc.tenant_id = mw.tenant_id AND wtc.business_date = mw.business_date
             AND wtc.source_branch = mw.source_branch AND wtc.product_id = mw.product_id
             AND wtc.channel = mw.channel
           WHERE mw.product_deleted = false
             AND ${wincajaExists('mw')}
        ) q
       GROUP BY tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind
      WITH NO DATA`);

  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sales_blended ON analytics.mv_sales_blended
    (tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_date ON analytics.mv_sales_blended
    (tenant_id, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_channel ON analytics.mv_sales_blended
    (tenant_id, channel, sale_date)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_blended_cover2 ON analytics.mv_sales_blended
    (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units, product_id, updated_at)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sales_blended TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sales_blended IS
    'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(sales_daily RUTA-%)+Wincaja(mv_wincaja), mismo schema que sales_daily. Fuente de los KPIs network del Command Center y del scope de sucursales de /comercial/salidas. SB.1: el corte por sucursal NO va en literales — sale de analytics.v_branch_erp_cutover, igual que v_sellout_daily. ⚠️ CUELGA de mv_kepler_sales_daily: un DROP...CASCADE de ese matview la mata (pasó 2026-09-08). Refresh nightly.'`);
}

/** Expuesto para que el candado pueda comprobar las anclas contra la vista VIVA sin copiarlas
 *  a mano. Una firma que se verifica en dos lugares distintos es una firma que ya divergió. */
exports._anclas = { SELLOUT_KEPLER_VIEJO, SELLOUT_WINCAJA_VIEJO, CORTES };

exports.up = async function (knex) {
  // 1 · La fecha, como columna propia de la tabla que ya mapea rama ↔ sucursal.
  const hasCol = await knex.schema.withSchema('wincaja').hasColumn('branches', 'kepler_cutover_date');
  if (!hasCol) {
    await knex.raw(`ALTER TABLE wincaja.branches ADD COLUMN kepler_cutover_date date`);
  }
  await knex.raw(`COMMENT ON COLUMN wincaja.branches.kepler_cutover_date IS
    'SB.1 · Día desde el cual manda KEPLER para esta sucursal (>=); antes manda su rama Wincaja (<). -infinity = Kepler siempre (nunca hubo traspaso de historia). NULL = la rama no entra al fact de venta (CEDIS 00, rutas). Se DECLARA, no se deriva de last_movement_date: medido 2026-09-23, en PH el corte va 4 días después del primer día Kepler y en Piedad las piernas se traslapan 9 meses. ⚠️ HUECOS CONOCIDOS, sin dueño asignado: rama 30 el 2026-09-18 ($418,721.65 en Wincaja, excluido por < 09-18, Kepler arranca el 19) y rama 10 del 2026-06-27 al 06-30 ($916,629.73 en Kepler, excluido por >= 07-01).'`);

  // 2 · Sembrar los cortes VIGENTES (congela el estado actual; ningún corte se mueve).
  for (const c of CORTES) {
    await knex.raw(
      `UPDATE wincaja.branches SET kepler_cutover_date = ?::date
        WHERE tenant_id = ? AND source_branch = ? AND kepler_cutover_date IS NULL`,
      [c.cutover, TENANT, c.rama],
    );
  }
  const sembrados = (await knex.raw(
    `SELECT source_branch, kepler_code, kepler_cutover_date::text d FROM wincaja.branches
      WHERE tenant_id = ? AND kepler_cutover_date IS NOT NULL ORDER BY kepler_code`, [TENANT],
  )).rows;
  if (sembrados.length !== CORTES.length) {
    throw new Error(`[SB.1] ABORTA: se esperaban ${CORTES.length} cortes sembrados y hay `
      + `${sembrados.length}. Sin el conjunto completo los EXISTS dejan sucursales fuera del fact `
      + `— que es exactamente el bug que esta migración arregla.`);
  }
  console.log(`  cortes declarados: ${sembrados.map((r) => `${r.kepler_code}←${r.source_branch}@${r.d}`).join(' · ')}`);

  // 3 · El resolvedor único.
  await crearResolvedor(knex);

  // 4 · Los dos consumidores dejan de tener su propia copia.
  await parchearSelloutDaily(knex);
  await recrearBlend(knex);

  console.log('  mv_sales_blended recreada WITH NO DATA + 4 índices. Falta REFRESH (aparte, pesado).');
};

exports.down = async function (knex) {
  // El resolvedor se va; las vistas quedan apuntando a él, así que hay que recrearlas desde
  // su migración de origen. Se deja explícito en vez de fingir una reversión limpia.
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended CASCADE`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_branch_erp_cutover CASCADE`);
  const hasCol = await knex.schema.withSchema('wincaja').hasColumn('branches', 'kepler_cutover_date');
  if (hasCol) await knex.raw(`ALTER TABLE wincaja.branches DROP COLUMN kepler_cutover_date`);
};
