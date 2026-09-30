'use strict';
/**
 * `[PR.S1.3]` — **A4 pasa a cableada, y la regla de medicion se muda a la tabla.**
 *
 * ── ⛔ El motivo que caduco ────────────────────────────────────────────────────────────────
 * A4 -el COGS del kardex, o sea **el arbitro del costo** de ADR-059- estaba en `no_existe` con
 * este motivo, escrito la manana del 2026-09-30:
 *
 *   *"analytics.mv_erp_margin_daily existe pero nunca se poblo (relispopulated=false)"*
 *
 * Esa misma tarde: **poblada, 889,806 filas, 134 MB**, 97.28 % de los renglones con costo. La
 * lleno el carril nocturno que `[PR.R1]` cableo.
 *
 * ⭐ Un markdown con esa frase adentro la seguiria diciendo hoy. El registro la volvio a medir.
 * Y el hueco no era menor: A4 cubre **22.9 % de las celdas pero el 99.3 % de la venta**.
 *
 * ── ⭐⭐ La regla de medicion se muda de la migracion a la TABLA ───────────────────────────
 * `[PR.S1.2]` dejo la lista de "que expresion mide la cobertura de cada senal" **dentro de la
 * migracion**. Eso ya se rompio una vez en este proyecto con otra forma: una regla que vive en
 * un archivo que ya corrio es una regla que la proxima migracion **tiene que copiar**, y una
 * copia diverge.
 *
 * Ahora vive en `cobertura_expr`, una columna de la tabla. La migracion no trae la lista: la
 * **lee**, la valida y la ejecuta. Agregar una senal deja de ser "acordarse de dos lugares".
 *
 * ⛔ Y como se arma SQL desde una columna, cada expresion pasa por un filtro conservador antes
 * de tocar la base -- identificadores, IS [NOT] NULL, comparaciones y literales entre comillas,
 * nada mas. Una expresion que no pase **detiene la migracion**; no se salta en silencio.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'analytics.price_signal_registry';
const V = 'analytics.v_price_signals';

/**
 * ⛔ El filtro. No pretende ser un parser de SQL: pretende que nada que no se parezca a
 * "columna IS NOT NULL" o "columna <> 'literal'" llegue a ejecutarse.
 */
const EXPR_SEGURA = /^[a-z0-9_ ()<>='.]+$/i;
const EXPR_PROHIBIDA = /;|--|\/\*|\bselect\b|\bfrom\b|\bunion\b|\bdrop\b|\binsert\b|\bupdate\b|\bdelete\b/i;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${V}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S1.3] falta analytics.v_price_signals');

  // ── 1 · La columna donde vive la regla ──────────────────────────────────────────────
  if (!(await knex.schema.withSchema('analytics').hasColumn('price_signal_registry', 'cobertura_expr'))) {
    await knex.schema.withSchema('analytics').alterTable('price_signal_registry', (t) => {
      t.text('cobertura_expr');
    });
  }
  await knex.raw(`COMMENT ON COLUMN ${T}.cobertura_expr IS
    $c$La expresion booleana sobre analytics.v_price_signals que define "esta celda TIENE esta
    senal". Vive aca y no en una migracion porque una regla que vive en un archivo ya corrido es
    una regla que la proxima migracion tiene que COPIAR, y una copia diverge. Casi siempre es
    "su columna IS NOT NULL"; las excepciones son las senales cuya columna nunca es NULL por
    construccion (un COALESCE o un booleano), donde contar no-nulos daria 100% falso.$c$`);

  // ── 2 · Sembrar la regla de las que ya estan cableadas ──────────────────────────────
  // Por defecto: "su columna no es NULL". Las excepciones van explicitas.
  await knex.raw(`
    UPDATE ${T} SET cobertura_expr = fuente_columna || ' IS NOT NULL'
     WHERE estado = 'cableada' AND cobertura_expr IS NULL`);
  /**
   * ⛔ LA EXCEPCION, nombrada: e4_reportes_faltante llega con COALESCE(...,0), o sea que nunca
   *    es NULL, y contar no-nulos daria 100 % sobre siete plazas donde nadie ha reportado jamas
   *    un faltante. Su cobertura real es "en cuantas plazas alguien mira".
   */
  await knex(T).where({ clave: 'E4' }).update({ cobertura_expr: `f12_cobertura <> 'sin_dato'` });

  // ── 3 · A4 entra ────────────────────────────────────────────────────────────────────
  const [{ pob }] = (await knex.raw(`
    SELECT relispopulated AS pob FROM pg_class
     WHERE oid = 'analytics.mv_erp_margin_daily'::regclass`)).rows;
  if (!pob) throw new Error('[PR.S1.3] el arbitro volvio a estar vacio: A4 no se puede cablear');

  await knex(T).where({ clave: 'A4' }).update({
    estado: 'cableada',
    fuente_objeto: V,
    fuente_columna: 'a4_margen_realizado_pct',
    cobertura_expr: 'a4_margen_realizado_pct IS NOT NULL',
    motivo_ausencia: null,
    nombre: 'Margen realizado (arbitro del costo)',
    definicion: 'Dinero contra dinero: venta costeada menos COGS arbitrado. Lo que de verdad se gano',
    unidad: 'pct',
    direccion: 'mas_es_mejor',
    nucleo: true,
    updated_at: knex.fn.now(),
  });

  // ── 4 · ⭐ Medir TODAS, leyendo la regla de la tabla ────────────────────────────────
  const filas = await knex(T).select('clave', 'cobertura_expr', 'cobertura_pct', 'estado')
    .where({ estado: 'cableada' }).orderBy('clave');
  if (!filas.length) throw new Error('[PR.S1.3] ninguna senal cableada');

  for (const f of filas) {
    if (!f.cobertura_expr) throw new Error(`[PR.S1.3] ${f.clave} esta cableada y no declara `
      + 'cobertura_expr: su cobertura no se podria volver a medir.');
    if (!EXPR_SEGURA.test(f.cobertura_expr) || EXPR_PROHIBIDA.test(f.cobertura_expr)) {
      throw new Error(`[PR.S1.3] la expresion de ${f.clave} no pasa el filtro: `
        + `"${f.cobertura_expr}"`);
    }
  }

  const sel = filas.map((f) =>
    `round((100.0 * count(*) FILTER (WHERE ${f.cobertura_expr}) / count(*))::numeric, 1)`
    + ` AS "${f.clave}"`).join(', ');
  const [med] = (await knex.raw(`SELECT ${sel} FROM ${V}`)).rows;

  const HOY = new Date().toISOString().slice(0, 10);
  const movidas = [];
  for (const f of filas) {
    const cob = Number(med[f.clave]);
    if (!Number.isFinite(cob)) throw new Error(`[PR.S1.3] no se pudo medir ${f.clave}`);
    if (Math.abs(Number(f.cobertura_pct) - cob) >= 0.15) {
      movidas.push(`${f.clave} ${Number(f.cobertura_pct).toFixed(1)}% -> ${cob.toFixed(1)}%`);
    }
    await knex(T).where({ clave: f.clave }).update({
      cobertura_pct: cob,
      cobertura_medida_al: HOY,
      peso_max: cob / 100,
      updated_at: knex.fn.now(),
    });
  }

  // ⛔ Cableada exige su regla de medicion, o su cobertura no se puede volver a comprobar.
  const [{ n: sinExpr }] = (await knex.raw(`
    SELECT count(*)::int n FROM pg_constraint
     WHERE conrelid = '${T}'::regclass AND conname = 'psr_cableada_con_expr'`)).rows;
  if (!sinExpr) {
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT psr_cableada_con_expr
      CHECK (estado <> 'cableada' OR btrim(coalesce(cobertura_expr, '')) <> '')`);
  }

  // ── 5 · Compuertas ──────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    WITH r AS (SELECT * FROM ${T}),
    reales AS (SELECT a.attname FROM pg_attribute a
                WHERE a.attrelid = '${V}'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
    SELECT (SELECT count(*)::int FROM r)                                  AS total,
           (SELECT count(*)::int FROM r WHERE estado = 'cableada')        AS cableadas,
           (SELECT count(*)::int FROM r WHERE estado = 'disponible')      AS disponibles,
           (SELECT count(*)::int FROM r WHERE estado = 'refutada')        AS refutadas,
           (SELECT count(*)::int FROM r WHERE estado = 'no_existe')       AS inexistentes,
           (SELECT count(*)::int FROM r WHERE estado = 'cableada'
              AND fuente_columna NOT IN (SELECT attname FROM reales))     AS mentirosas`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S1.3] ${g.total} senales · cableadas ${g.cableadas} · disponibles `
    + `${g.disponibles} · refutadas ${g.refutadas} · no existen ${g.inexistentes}`);
  if (movidas.length) {
    // eslint-disable-next-line no-console
    console.log(`  · [PR.S1.3] coberturas que se movieron al re-medir: ${movidas.join(' · ')}`);
  }

  if (g.mentirosas > 0) throw new Error(`[PR.S1.3] ${g.mentirosas} cableadas sin columna real.`);
  if (g.disponibles > 0) throw new Error(`[PR.S1.3] ${g.disponibles} senales en 'disponible'.`);
  if (g.cableadas !== 29) {
    throw new Error(`[PR.S1.3] ${g.cableadas} cableadas y se esperaban 29 (28 + A4).`);
  }
  if (g.total !== 46) throw new Error(`[PR.S1.3] el registro tiene ${g.total} senales, no 46.`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS psr_cableada_con_expr`);
};
