'use strict';
/**
 * `[PQ.94]` — Temporadas: el calendario y los productos de cada temporada, como dato propio de la Suite.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md` §19 (19.7 regla de compra única y
 * remate · 19.8 arquitectura y D36). Las tres tablas viven en el catálogo DE LA SUITE (`catalog.*`),
 * nunca en la copia del catálogo de Kepler (D36, Francisco 2026-11-10). El producto se liga por su clave
 * de Kepler `(tenant_id, sku)`, como el resto de `commercial.*` y el Catálogo digital.
 *
 *   catalog.seasons          · las temporadas (Navidad, Día de Muertos…), fecha fija o móvil
 *   catalog.season_dates     · temporada × año: venta, compra, corte de reposición y remate
 *   catalog.season_products  · temporada × producto: la DECISIÓN de las áreas (confirmado o descartado),
 *                              recurrencia (anual o sólo un año) y reposición (compra única o hasta el corte)
 *
 * Y dos vistas que DERIVAN (no copian nada), más la regla de meses que usa la primera:
 *   catalog.v_season_candidates     · los productos que la venta propone para cada temporada-año
 *   catalog.v_product_season_status · dónde está hoy cada producto CONFIRMADO dentro de su temporada
 *   catalog.fn_season_window_months · qué meses cuentan como ventana (los que cubre al menos a la mitad)
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-10) ─────────────────────────────────────────────────
 *  · Fuente de venta: `analytics.mv_sellout_monthly`, el sell-out canónico (VERDAD_ABSOLUTA §22.4):
 *    une Wincaja y Kepler y cubre 2025 completo (16–21 almacenes por mes). Control: el total de oct-2025
 *    difiere 1.4 % del de `sales_daily`. ⛔ NO `analytics.sales_daily` (importer, doble linaje,
 *    lo retira la fase SD) ni `mv_kepler_sales_daily` (2025 en UNA sucursal: no ve la temporada pasada).
 *  · ⭐ La temporada del MAYORISTA va adelantada a la del consumidor (curva semanal 2025 y 2026 de los
 *    productos con nombre de la temporada, plan §19.11): Día de Muertos se vende del 1-sep al 2-nov
 *    (con la ventana del consumidor, 10-oct a 2-nov, 22008 PAL CALAVERAS MEXICANAS tenía sólo 31 % de su
 *    año y la repetición 2025→2026 era 1 de 16; con la del mayorista, 26 de 58). Navidad desde el
 *    20-oct; San Valentín desde el 5-ene; Fiestas Patrias desde el 15-ago.
 *  · Grano mensual: un mes cuenta si la ventana cubre al menos la mitad de sus días. Contra el análisis
 *    diario recupera 93 % (Muertos 2025), 94 % (San Valentín 2026) y 75 % (Navidad 2025: la preventa de
 *    fin de octubre no llena medio mes), en ~0.4-1.6 s por temporada-año (medido en prod el 2026-11-10, con la base de meses). Más de 500 ms: la API la guarda
 *    por temporada-año (una temporada pasada no cambia). ⛔ Una 2ª materialización de la venta no (regla 2).
 *    Controles: 22008 PAL CALAVERAS MEXICANAS y 12517 PAL PARCA salen; también salen falsos (Ferrero
 *    Navidad, «Actividades de ventas»): por eso son CANDIDATOS y deciden las áreas.
 *  · Llave: en el plan de reabasto, `product_id` y `sku` van 1 a 1 en los 6,490 productos.
 *  · El Catálogo digital (`catalog.product_sheets`) tiene 12 fichas: la temporada NO va en la ficha.
 *
 * ── La siembra es PROPUESTA, nunca dato (ADR-056) ─────────────────────────────────────────────────────
 *  La LISTA de temporadas sale del Plan Anual de Mercadotecnia 2026 de Mega Dulces (Dirección General,
 *  15-ene-2026), sección «Eventos de temporalidad»: San Valentín, Día del Niño, Día de las Madres y del
 *  Padre, Fiestas Patrias, Día de Muertos y Navidad. Reyes (la Cabalgata) y la Candelaria son eventos:
 *  la Candelaria es la cola de Navidad (levantamientos, hasta el 2-feb) y Reyes no tiene señal de
 *  producto en la venta. El Tianguis de Semana Santa, Regreso a Clases y el Aniversario son eventos
 *  comerciales, no temporadas de compra única.
 *  Las VENTANAS de 2025 y 2026 se siembran con `status = 'propuesta'`: las medidas en la curva (Muertos,
 *  Navidad, San Valentín, Patrias) y las estimadas (Niño, Madres, Padre: ~4 semanas antes de la fecha,
 *  la curva por nombre no se ve). `v_product_season_status` —la que leerán el motor, Pedido y el
 *  catálogo— SÓLO lee fechas y productos `confirmada`: lo que nadie confirmó no frena ni etiqueta nada.
 *  Ni la fecha de compra ni la de corte se siembran: nadie las definió.
 *
 * Sin DELETE para `app_runtime` (soft-delete): las decisiones son el rastro.
 * Idempotente: tablas e índices si no existen; RLS, policies, grants, vistas y siembra se re-aplican.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const HOY_MX = `(now() AT TIME ZONE 'America/Mexico_City')::date`;

/** Las temporadas propuestas. `hint` es un CONTROL para proponer candidatos por nombre, nunca una regla. */
const TEMPORADAS = [
  { key: 'san_valentin', name: 'San Valentín', rule: 'fija', orden: 10, hint: '(valent|amor|coraz[oó]n|love|beso)' },
  { key: 'dia_del_nino', name: 'Día del Niño', rule: 'fija', orden: 20, hint: '(d[ií]a del ni[ñn]o|juguete)' },
  { key: 'dia_de_las_madres', name: 'Día de las Madres', rule: 'fija', orden: 30, hint: '(mam[aá]|madre)' },
  // Tercer domingo de junio: fecha móvil.
  { key: 'dia_del_padre', name: 'Día del Padre', rule: 'movil', orden: 40, hint: '(pap[aá]\\M|d[ií]a del padre)' },
  { key: 'fiestas_patrias', name: 'Fiestas Patrias', rule: 'fija', orden: 50, hint: '(patri|tricolor|independ|bandera|charro|grito)' },
  {
    key: 'dia_de_muertos', name: 'Día de Muertos y Halloween', rule: 'fija', orden: 60,
    hint: '(calaver|calaca|hallow|catr[ií]n|bruj|calabaz|muert|fantasm|esquelet|zombi|vampir|monstru|ofrenda|macabr|tumba|boo\\M|calak|ata[uú]d|parca|colmill)',
  },
  { key: 'navidad', name: 'Navidad y posadas', rule: 'fija', orden: 70, hint: '(navid|santa|arbolito|nieve|noel|posada|aguinaldo|bota |x ?mas|christmas|pi[ñn]ata)' },
];

/**
 * Ventanas de VENTA DEL MAYORISTA por año: [venta desde, venta hasta, remate desde].
 * Medidas en la curva semanal 2025–2026 (plan §19.11): Muertos, Navidad, San Valentín, Patrias.
 * Estimadas (~4 semanas antes de la fecha; la curva por nombre no se ve): Niño, Madres, Padre.
 * Navidad: el remate arranca el 26-dic y su cola (levantamientos) llega a la Candelaria, 2-feb.
 */
const VENTANAS = {
  san_valentin: (y) => [`${y}-01-05`, `${y}-02-14`, `${y}-02-15`],
  dia_del_nino: (y) => [`${y}-04-01`, `${y}-04-30`, `${y}-05-01`],
  dia_de_las_madres: (y) => [`${y}-04-15`, `${y}-05-10`, `${y}-05-11`],
  dia_del_padre: (y) => ({ 2025: ['2025-05-25', '2025-06-15', '2025-06-16'], 2026: ['2026-05-31', '2026-06-21', '2026-06-22'] }[y]),
  fiestas_patrias: (y) => [`${y}-08-15`, `${y}-09-16`, `${y}-09-17`],
  dia_de_muertos: (y) => [`${y}-09-01`, `${y}-11-02`, `${y}-11-03`],
  navidad: (y) => [`${y}-10-20`, `${y}-12-24`, `${y}-12-26`],
};
const ANIOS = [2025, 2026];
// Texto que se ve en la pantalla: en español con acentos y sin jerga técnica.
const FUENTE_PROPUESTA = 'la lista sale del Plan Anual de Mercadotecnia 2026 (Dirección General, 15 de enero de 2026); las ventanas de San Valentín, Fiestas Patrias, Día de Muertos y Navidad se midieron en la venta real de 2025 y 2026, y las del Día del Niño, de las Madres y del Padre son estimadas. Las confirman Compras, Mercadotecnia, Dirección Comercial y Dirección General';

const AUDIT = `
        created_at          timestamptz NOT NULL DEFAULT now(),
        created_by          uuid,
        created_by_username varchar(80),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        updated_by          uuid,
        updated_by_username varchar(80),
        deleted_at          timestamptz,
        deleted_by          uuid`;

async function rlsYGrants(knex, tabla) {
  await knex.raw(`ALTER TABLE catalog.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE catalog.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='catalog' AND tablename='${tabla}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON catalog.${tabla}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`REVOKE DELETE ON catalog.${tabla} FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON catalog.${tabla} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = (t) => knex.schema.withSchema('catalog').hasTable(t);

  // ── 1 · catalog.seasons ─────────────────────────────────────────────────────────────────────────
  if (!(await hay('seasons'))) {
    await knex.raw(`
      CREATE TABLE catalog.seasons (
        id         uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL,
        key        text NOT NULL,
        name       text NOT NULL,
        date_rule  text NOT NULL,
        name_hint  text,
        sort_order integer NOT NULL DEFAULT 0,
        active     boolean NOT NULL DEFAULT true,${AUDIT},
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT catalog_seasons_key_chk CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
        CONSTRAINT catalog_seasons_name_chk CHECK (length(trim(name)) > 0),
        CONSTRAINT catalog_seasons_rule_chk CHECK (date_rule IN ('fija','movil')),
        CONSTRAINT fk_catalog_seasons_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_seasons_key ON catalog.seasons (tenant_id, key) WHERE deleted_at IS NULL`);
  }

  // ── 2 · catalog.season_dates ────────────────────────────────────────────────────────────────────
  if (!(await hay('season_dates'))) {
    await knex.raw(`
      CREATE TABLE catalog.season_dates (
        id              uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        season_id       uuid NOT NULL,
        year            integer NOT NULL,
        sale_from       date NOT NULL,
        sale_to         date NOT NULL,
        buy_by          date,
        cutoff          date,
        clearance_from  date,
        status          text NOT NULL DEFAULT 'propuesta',
        proposal_source text,
        confirmed_by    uuid,
        confirmed_at    timestamptz,${AUDIT},
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT catalog_season_dates_year_chk CHECK (year BETWEEN 2020 AND 2100),
        CONSTRAINT catalog_season_dates_window_chk CHECK (sale_to >= sale_from),
        CONSTRAINT catalog_season_dates_buy_chk CHECK (buy_by IS NULL OR buy_by <= sale_from),
        CONSTRAINT catalog_season_dates_cutoff_chk CHECK (cutoff IS NULL OR cutoff BETWEEN sale_from AND sale_to),
        CONSTRAINT catalog_season_dates_clearance_chk CHECK (clearance_from IS NULL OR clearance_from > sale_to),
        CONSTRAINT catalog_season_dates_status_chk CHECK (status IN ('propuesta','confirmada')),
        -- Confirmar tiene dueño y fecha (D35): sin ellos la fila sigue siendo propuesta.
        CONSTRAINT catalog_season_dates_confirmed_chk CHECK (
          status <> 'confirmada' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
        CONSTRAINT fk_catalog_season_dates_season
          FOREIGN KEY (tenant_id, season_id) REFERENCES catalog.seasons (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_season_dates_year ON catalog.season_dates (tenant_id, season_id, year) WHERE deleted_at IS NULL`);
  }

  // ── 3 · catalog.season_products ─────────────────────────────────────────────────────────────────
  if (!(await hay('season_products'))) {
    await knex.raw(`
      CREATE TABLE catalog.season_products (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        season_id     uuid NOT NULL,
        sku           varchar(20) NOT NULL,
        decision      text NOT NULL,
        recurrence    text,
        only_year     integer,
        replenishment text,
        origin        text NOT NULL,
        evidence      jsonb,
        reason        text,
        decided_by    uuid NOT NULL,
        decided_at    timestamptz NOT NULL DEFAULT now(),${AUDIT},
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT catalog_season_products_sku_chk CHECK (length(trim(sku)) > 0 AND sku = trim(sku)),
        CONSTRAINT catalog_season_products_decision_chk CHECK (decision IN ('confirmada','descartada')),
        CONSTRAINT catalog_season_products_recurrence_chk CHECK (recurrence IS NULL OR recurrence IN ('anual','solo_un_anio')),
        CONSTRAINT catalog_season_products_replenishment_chk CHECK (replenishment IS NULL OR replenishment IN ('compra_unica','hasta_corte')),
        CONSTRAINT catalog_season_products_origin_chk CHECK (origin IN ('propuesta_del_sistema','manual')),
        -- Un producto confirmado dice cómo se comporta: si vuelve cada año y si se repone.
        CONSTRAINT catalog_season_products_confirmada_chk CHECK (
          decision <> 'confirmada' OR (recurrence IS NOT NULL AND replenishment IS NOT NULL)),
        CONSTRAINT catalog_season_products_only_year_chk CHECK (
          (recurrence = 'solo_un_anio') = (only_year IS NOT NULL) OR decision = 'descartada'),
        -- Descartar lleva motivo: es lo que impide que la propuesta vuelva a aparecer sin explicación.
        CONSTRAINT catalog_season_products_reason_chk CHECK (
          decision <> 'descartada' OR length(trim(coalesce(reason, ''))) > 0),
        CONSTRAINT catalog_season_products_evidence_chk CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
        CONSTRAINT fk_catalog_season_products_season
          FOREIGN KEY (tenant_id, season_id) REFERENCES catalog.seasons (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_season_products ON catalog.season_products (tenant_id, season_id, sku) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_season_products_sku ON catalog.season_products (tenant_id, sku) WHERE deleted_at IS NULL`);
  }

  for (const t of ['seasons', 'season_dates', 'season_products']) await rlsYGrants(knex, t);

  // ── 4 · La regla de la mitad del mes (plan §19.11), en una función para poder probarla sola ───────
  // Un mes entra a la ventana si ésta cubre al menos la MITAD de sus días; si ninguno llega (ventana
  // corta a caballo entre dos meses), entra el que más días tiene. Devuelve el primer y último mes.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION catalog.fn_season_window_months(p_from date, p_to date)
    RETURNS TABLE (m_ini date, m_fin date)
    LANGUAGE sql STABLE AS $fn$
      SELECT coalesce(min(g.mes) FILTER (WHERE g.dias * 2 >= g.dias_mes), (array_agg(g.mes ORDER BY g.dias DESC, g.mes))[1]),
             coalesce(max(g.mes) FILTER (WHERE g.dias * 2 >= g.dias_mes), (array_agg(g.mes ORDER BY g.dias DESC, g.mes))[1])
        FROM (
          SELECT gs::date AS mes,
                 (least(p_to, (gs + interval '1 month - 1 day')::date) - greatest(p_from, gs::date) + 1) AS dias,
                 extract(day FROM gs + interval '1 month - 1 day')::int AS dias_mes
            FROM generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') gs
        ) g
    $fn$`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION catalog.fn_season_window_months(date, date) TO app_runtime`);

  // ── 5 · Vistas (derivan; `security_invoker` para que valga la RLS de quien consulta) ─────────────
  // Candidatos: una LATERAL por temporada-año, para que filtrar por `season_date_id` calcule sólo esa.
  await knex.raw(`
    CREATE OR REPLACE VIEW catalog.v_season_candidates WITH (security_invoker = true) AS
    SELECT d.tenant_id, d.id AS season_date_id, d.season_id, s.key AS season_key, s.name AS season_name,
           d.year, d.status AS dates_status, d.sale_from, d.sale_to,
           v.product_id, v.sku, v.nombre,
           round(v.sales_window, 2) AS sales_window,
           round(v.sales_12m, 2) AS sales_12m,
           round(v.sales_window / NULLIF(v.sales_12m, 0), 4) AS concentration,
           round(coalesce(v.sales_next_month, 0), 2) AS sales_next_month,
           -- NULL = el mes siguiente no ha cerrado: no se puede decir si se desplomó.
           CASE WHEN m.post_closed THEN coalesce(v.sales_next_month, 0) < 0.25 * v.sales_window / m.n_months END AS collapsed_after,
           (s.name_hint IS NOT NULL AND v.nombre ~* s.name_hint) AS name_match,
           sp.decision, sp.decided_at,
           -- Con cuántos meses de venta se calculó «su año» (12 = completo). En las temporadas de 2025 sale menos:
           -- antes de 2025 no hay historia y la concentración sale INFLADA; la pantalla lo dice (revisión, hallazgo 3).
           m.base_months
      FROM catalog.season_dates d
      JOIN catalog.seasons s ON s.tenant_id = d.tenant_id AND s.id = d.season_id AND s.deleted_at IS NULL AND s.active
      CROSS JOIN LATERAL (
        SELECT to_char(w.m_ini, 'YYYY-MM') AS m_ini,
               to_char(w.m_fin, 'YYYY-MM') AS m_fin,
               to_char(w.m_fin - interval '11 months', 'YYYY-MM') AS m_12,
               to_char(w.m_fin + interval '1 month', 'YYYY-MM') AS m_post,
               (w.m_fin + interval '2 months')::date <= ${HOY_MX} AS post_closed,
               ((date_part('year', w.m_fin) - date_part('year', w.m_ini)) * 12
                 + date_part('month', w.m_fin) - date_part('month', w.m_ini) + 1)::int AS n_months,
               -- Meses de la base con venta registrada: 12 preguntas por índice (no un conteo producto por producto,
               -- que llevaba la consulta de ~1 s a ~2-3 s, medido en prod el 2026-11-10).
               (SELECT count(*) FROM generate_series(w.m_fin - interval '11 months', w.m_fin, interval '1 month') gm
                 WHERE EXISTS (SELECT 1 FROM analytics.mv_sellout_monthly x
                                WHERE x.tenant_id = d.tenant_id AND x.year_month = to_char(gm, 'YYYY-MM')))::int AS base_months
          FROM catalog.fn_season_window_months(d.sale_from, d.sale_to) w
      ) m
      CROSS JOIN LATERAL (
        SELECT so.product_id, max(so.sku) AS sku, max(so.nombre) AS nombre,
               sum(so.monto_neto) FILTER (WHERE so.year_month BETWEEN m.m_ini AND m.m_fin) AS sales_window,
               sum(so.monto_neto) FILTER (WHERE so.year_month BETWEEN m.m_12 AND m.m_fin) AS sales_12m,
               sum(so.monto_neto) FILTER (WHERE so.year_month = m.m_post) AS sales_next_month
          FROM analytics.mv_sellout_monthly so
         WHERE so.tenant_id = d.tenant_id AND so.year_month BETWEEN m.m_12 AND m.m_post
         GROUP BY so.product_id
      ) v
      LEFT JOIN catalog.season_products sp
        ON sp.tenant_id = d.tenant_id AND sp.season_id = d.season_id AND sp.sku = v.sku AND sp.deleted_at IS NULL
     WHERE d.deleted_at IS NULL
       AND v.sales_window >= 5000
       AND v.sales_window / NULLIF(v.sales_12m, 0) >= 0.6
       AND ((s.name_hint IS NOT NULL AND v.nombre ~* s.name_hint)
            OR (m.post_closed AND coalesce(v.sales_next_month, 0) < 0.25 * v.sales_window / m.n_months))`);
  await knex.raw(`COMMENT ON VIEW catalog.v_season_candidates IS
    '[PQ.94] Productos que la venta PROPONE para cada temporada-anio (sell-out canonico mv_sellout_monthly, grano mes; un mes entra si la ventana cubre la mitad de sus dias, fn_season_window_months): 60%+ de su venta de 12 meses en la ventana y $5,000+, y nombre de la temporada o desplome el mes siguiente. Propuesta, no decision: decide catalog.season_products. Filtrar por season_date_id.'`);

  // Estado de hoy: SOLO lo confirmado (fechas y producto). Lo propuesto no frena ni etiqueta (ADR-056).
  // La ventana relevante va de la fecha de compra (o 60 d antes de la venta) a 60 d después de que empieza el remate.
  // Entre el cierre de la venta y el remate (Navidad: 25-dic) el estado es «pasado_el_corte», no «en_remate».
  await knex.raw(`
    CREATE OR REPLACE VIEW catalog.v_product_season_status WITH (security_invoker = true) AS
    SELECT sp.tenant_id, sp.sku, s.id AS season_id, s.key AS season_key, s.name AS season_name,
           d.id AS season_date_id, d.year, d.sale_from, d.sale_to, d.buy_by, d.cutoff, d.clearance_from,
           sp.recurrence, sp.replenishment,
           CASE WHEN h.hoy < d.sale_from THEN 'por_iniciar'
                WHEN h.hoy <= coalesce(d.cutoff, d.sale_to) THEN 'en_venta'
                WHEN h.hoy < coalesce(d.clearance_from, d.sale_to + 1) THEN 'pasado_el_corte'
                ELSE 'en_remate' END AS state,
           (sp.replenishment = 'hasta_corte' AND h.hoy <= coalesce(d.cutoff, d.sale_to)) AS replenish_allowed
      FROM catalog.season_products sp
      JOIN catalog.seasons s
        ON s.tenant_id = sp.tenant_id AND s.id = sp.season_id AND s.deleted_at IS NULL AND s.active
      JOIN catalog.season_dates d
        ON d.tenant_id = sp.tenant_id AND d.season_id = sp.season_id AND d.deleted_at IS NULL AND d.status = 'confirmada'
      CROSS JOIN (SELECT ${HOY_MX} AS hoy) h
     WHERE sp.deleted_at IS NULL
       AND sp.decision = 'confirmada'
       AND (sp.recurrence = 'anual' OR sp.only_year = d.year)
       AND h.hoy BETWEEN coalesce(d.buy_by, d.sale_from - 60) AND coalesce(d.clearance_from, d.sale_to + 1) + 59`);
  await knex.raw(`COMMENT ON VIEW catalog.v_product_season_status IS
    '[PQ.94] Donde esta HOY (hora de Mexico) cada producto confirmado de una temporada con fechas confirmadas: por_iniciar, en_venta, pasado_el_corte, en_remate; y si se puede reponer. Lo propuesto no aparece (ADR-056). La leen el motor (PQ.45), Pedido, Autoabasto y el catalogo.'`);
  await knex.raw(`GRANT SELECT ON catalog.v_season_candidates, catalog.v_product_season_status TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE catalog.seasons IS '[PQ.94] Temporadas de venta (Navidad, Dia de Muertos...). Dato propio de la Suite (D36).'`);
  await knex.raw(`COMMENT ON TABLE catalog.season_dates IS '[PQ.94] Temporada x anio: venta, compra, corte de reposicion y remate. status propuesta|confirmada; solo lo confirmado lo usa v_product_season_status.'`);
  await knex.raw(`COMMENT ON TABLE catalog.season_products IS '[PQ.94] Temporada x producto (clave de Kepler): la decision de las areas (D35), su recurrencia y su reposicion. Se escribe solo desde Temporadas (una sola puerta).'`);

  // ── 6 · Siembra: PROPUESTA, sólo si existe el tenant (en una base vacía no siembra nada) ──────────
  for (const t of TEMPORADAS) {
    await knex.raw(`
      INSERT INTO catalog.seasons (tenant_id, key, name, date_rule, name_hint, sort_order, created_by_username)
      SELECT t.id, ?, ?, ?, ?, ?, 'migracion-pq94'
        FROM identity.tenants t
       WHERE t.id = ?
         AND NOT EXISTS (SELECT 1 FROM catalog.seasons s WHERE s.tenant_id = t.id AND s.key = ? AND s.deleted_at IS NULL)`,
    [t.key, t.name, t.rule, t.hint, t.orden, TENANT, t.key]);
  }
  for (const [key, ventana] of Object.entries(VENTANAS)) {
    for (const y of ANIOS) {
      const [desde, hasta, remate] = ventana(y);
      await knex.raw(`
        INSERT INTO catalog.season_dates
               (tenant_id, season_id, year, sale_from, sale_to, clearance_from, status, proposal_source, created_by_username)
        SELECT s.tenant_id, s.id, ?, ?::date, ?::date, ?::date, 'propuesta', ?, 'migracion-pq94'
          FROM catalog.seasons s
         WHERE s.tenant_id = ? AND s.key = ? AND s.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM catalog.season_dates d
                            WHERE d.tenant_id = s.tenant_id AND d.season_id = s.id AND d.year = ? AND d.deleted_at IS NULL)`,
      [y, desde, hasta, remate, FUENTE_PROPUESTA, TENANT, key, y]);
    }
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`. Se niega si ya hay decisiones de personas: un producto
 * confirmado o descartado, o unas fechas confirmadas. La siembra (sólo propuestas) sí se va.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.v_product_season_status`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.v_season_candidates`);
  await knex.raw(`DROP FUNCTION IF EXISTS catalog.fn_season_window_months(date, date)`);
  const hay = (t) => knex.schema.withSchema('catalog').hasTable(t);
  // RLS FORZADA: con `row_security = off`, un rol que no la salta FALLA en vez de contar de menos.
  await knex.raw(`SET LOCAL row_security = off`);
  if (await hay('season_products')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM catalog.season_products`);
    if (rows[0].n > 0) {
      throw new Error(`[PQ.94] down rechazado: catalog.season_products tiene ${rows[0].n} decisiones de las áreas. Respáldalas antes de borrar.`);
    }
  }
  if (await hay('season_dates')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM catalog.season_dates WHERE status = 'confirmada'`);
    if (rows[0].n > 0) {
      throw new Error(`[PQ.94] down rechazado: catalog.season_dates tiene ${rows[0].n} fechas confirmadas. Respáldalas antes de borrar.`);
    }
  }
  await knex.raw(`DROP TABLE IF EXISTS catalog.season_products`);
  await knex.raw(`DROP TABLE IF EXISTS catalog.season_dates`);
  await knex.raw(`DROP TABLE IF EXISTS catalog.seasons`);
};
