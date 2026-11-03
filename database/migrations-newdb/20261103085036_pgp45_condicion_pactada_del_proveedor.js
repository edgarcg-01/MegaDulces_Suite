'use strict';
/**
 * `[PGP.45]` — **La condición PACTADA del proveedor: saber que no da descuento deja de ser
 * indistinguible de no haber preguntado.**
 *
 * `[PP.0]` dejó esto escrito como el hueco que faltaba, textual: *«El acuerdo real no existe como
 * dato en ningún lado (ADR-056: se declara el hueco, no se dibuja). Cuando exista la ficha de
 * acuerdo, ESTA matvista pasa a ser el contraste: ¿nos dan lo que dijeron?»*. Esto es esa ficha.
 *
 * ── Lo medido antes de escribir nada (prod, sólo lectura, sid 7688376744939610156, 2026-11-03) ──
 *
 * **1 · El titular de `[PGP.36]` mezclaba cosas, y lo corrijo acá.** Sobre $143,746,177.10 de deuda
 * viva, el «sin medir» son $72,748,758.86 — pero **sólo $28,064,252.05 es deuda de COMPRA**:
 *
 * | naturaleza de la clave | acreedores | sin medir |
 * |---|---:|---:|
 * | **`C` compra** | 218 | **$28,064,252.05** |
 * | `AB` crédito bancario | 3 | $19,898,880.71 |
 * | `A` préstamos (incluye los socios) | 3 | $17,980,000.00 |
 * | `G` gasto (nómina, SAT, arrendamiento) | 130 | $6,321,622.70 |
 * | `GB` bancos · `TC` tarjetas · factoraje | 10 | $477,859.40 |
 *
 * ⛔ Un descuento por pronto pago sobre un crédito de BBVA no existe. Perseguir los $72.7M era
 * perseguir un número que incluye la deuda bancaria y los préstamos de socios.
 *
 * **2 · Y dentro de compra la concentración es extrema:** **9 acreedores cubren el 80 %**, y uno
 * solo —`CB005` BOLSAS DE LOS ALTOS, 139 facturas— es **$14,861,580.73, el 53 %**. La captura no
 * son 245 fichas: son nueve preguntas.
 *
 * **3 · ⭐⭐ Lo que apareció al mirar a quién le estamos pagando.** No son proveedores
 * desconocidos: son los que más nos cobran, y en 12 meses **no registraron un peso de descuento**.
 *
 * | acreedor | pagos 12m | pagado 12m | descuento |
 * |---|---:|---:|---:|
 * | `CB005` Bolsas de los Altos | 120 | $34,465,840.40 | **$0.00** |
 * | `CH003` Hernán Valencia | 41 | $9,195,568.11 | **$0.00** |
 * | `CJ0036` José Adrián Romo | 46 | $5,903,842.23 | **$0.00** |
 * | `CF005` Fábricas Selectas | 10 | $1,435,578.57 | $0.00 |
 * | `CF010` Fernando Zermeño | 6 | $552,825.90 | $0.00 |
 *
 * **223 pagos · $51,553,655.21 · cero descuento registrado.** Hoy el sistema los pinta
 * `sin_medir`, o sea **se calla**, y un silencio se lee como «acá no hay nada que ganar». Hay dos
 * explicaciones y el sistema **no puede distinguirlas**: que esos proveedores no den pronto pago,
 * o que lo estemos dejando pasar 120 veces al año. Esa distinción es lo que esta ficha compra.
 *
 * **4 · Kepler no tiene el dato, y lo verifiqué en vez de suponerlo** (regla 10). `kdxd.c16` sí
 * trae **días de crédito** (1,356 de 6,584 filas, 137 proveedores de compra) — pero eso es el
 * plazo, no la ventana del descuento. Los descuentos del proveedor `c17/c18/c19` están **vacíos**
 * (8 · 0 · 0 filas de 6,584). El acuerdo de pronto pago no existe en el ERP: por eso una tabla
 * propia es legítima acá (regla 1: tabla real sólo para datos propios).
 *
 * **5 · La tabla ya existía y estaba muerta.** `commercial.supplier_discount_policy`: **147 filas,
 * todas `source='observed'`, todas del 2026-08-05, `discount_days` vacío en el 100 %, nunca
 * actualizadas.** La matvista nocturna de `[PP.0]` (190 proveedores) ya las superó. No se borran
 * (regla 5); quedan como lo que son: una foto vieja de lo observado.
 *
 * ── Lo que esta migración hace ──────────────────────────────────────────────────────────────
 *
 * **a)** `source` admite **`'pactado'`**, y una fila pactada **exige la fecha en que se pactó**:
 * un acuerdo sin fecha no se puede contrastar contra lo que pasó después.
 *
 * **b)** ⭐ **`source='pactado'` con `expected_discount_rate = 0` significa «preguntamos y NO da
 * descuento»** — que es una MEDICIÓN, no una ausencia. Es la mitad del valor de esta ficha: hoy
 * «no da» y «no preguntamos» se pintan iguales, y el segundo caso es el que cuesta dinero.
 * ⛔ Esa lectura vale **sólo** para `pactado`. Una fila `observed` con tasa 0 no afirma nada.
 *
 * **c)** `analytics.v_supplier_payment_terms` resuelve, por proveedor, **qué condición rige y de
 * dónde salió** (ADR-056 / VP: el número declara con qué se calculó). **Lo pactado gana sobre lo
 * observado** — observar es inferir de la conducta, pactar es saberlo. Y publica las dos, que es
 * lo que permite la pregunta que `[PP.0]` dejó pedida: *¿nos dan lo que dijeron?*
 *
 * ⚠️ `security_invoker = true` **no es decorativo**: la vista toca una tabla con FORCE RLS y las
 * vistas de `analytics` son de `postgres`, que tiene BYPASSRLS. Sin eso, la condición pactada de
 * un tenant se vería desde otro.
 *
 * ⚠️ Vista, no matvista: la tabla tiene 147 filas y el lado caro (la derivación de 12 meses) ya
 * está materializado en `mv_supplier_prompt_discount`.
 *
 * Idempotente. No borra ni reescribe ninguna fila existente.
 *
 * @param { import("knex").Knex } knex
 */

/** Mínimo de observaciones para publicar una ventana OBSERVADA. Espejo de `PRONTO_PAGO_MIN_OBS`
 *  del contrato: si uno cambia, el otro también — están nombrados en los dos lados a propósito
 *  porque una migración no puede importar de `libs/`. */
const MIN_OBS = 3;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── a) la fuente 'pactado' ────────────────────────────────────────────────────────────────
  // El CHECK se reemplaza por nombre fijo: `supplier_discount_policy_source_check`, medido en
  // prod. Si mañana no existiera, el DROP IF EXISTS no falla y el ADD lo deja correcto igual.
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      DROP CONSTRAINT IF EXISTS supplier_discount_policy_source_check`);
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      ADD CONSTRAINT supplier_discount_policy_source_check
      CHECK (source IN ('kepler','observed','manual','pactado'))`);

  for (const [col, tipo] of [
    ['agreed_on', 'date'],
    ['agreed_evidence', 'text'],
    ['agreed_contact', 'text'],
  ]) {
    const existe = await knex.schema.withSchema('commercial')
      .hasColumn('supplier_discount_policy', col);
    if (!existe) {
      await knex.raw(`ALTER TABLE commercial.supplier_discount_policy ADD COLUMN ${col} ${tipo}`);
    }
  }

  await knex.raw(`
    COMMENT ON COLUMN commercial.supplier_discount_policy.agreed_on IS
      'PGP.45 - fecha en que se pacto la condicion. Obligatoria en filas source=pactado: sin ella no se puede contrastar el acuerdo contra lo que paso despues.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.supplier_discount_policy.agreed_evidence IS
      'PGP.45 - como consta el acuerdo (correo, contrato, llamada con fecha). Texto libre: es el respaldo de quien lo capturo, no un enum.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.supplier_discount_policy.agreed_contact IS
      'PGP.45 - con quien se pacto del lado del proveedor.'`);

  // Una fila pactada sin fecha no se puede contrastar. Se valida sólo para 'pactado', así que
  // las 147 filas 'observed' existentes no se tocan ni bloquean la migración (regla 14: acá NO
  // hay otros caminos de inserción que recorrer porque la fuente 'pactado' nace hoy).
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      DROP CONSTRAINT IF EXISTS supplier_discount_policy_pactado_con_fecha`);
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      ADD CONSTRAINT supplier_discount_policy_pactado_con_fecha
      CHECK (source <> 'pactado' OR agreed_on IS NOT NULL)`);

  // Una condición pactada CON descuento necesita los días: sin ellos no hay fecha límite que
  // publicar, y publicar una tasa sin ventana es justo el defecto que [PP.0] midió (147 filas
  // con tasa y 0 con días: «este proveedor a veces da descuento» no sirve para decidir hoy).
  //
  // ⛔ `discount_days IS NOT NULL AND` NO sobra, y lo cazó la prueba negativa de esta misma
  // migración antes de que saliera: escrito como `... OR discount_days > 0`, una fila con los
  // días en NULL evalúa `false OR false OR NULL` = **NULL**, y un CHECK sólo rechaza con FALSE
  // — así que el caso que el candado existe para frenar (tasa pactada sin ventana) pasaba
  // derecho. Es la lógica de tres valores de SQL, el mismo filo que vuelve inútil un
  // `NOT (col >= n)` cuando `col` puede ser NULL.
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      DROP CONSTRAINT IF EXISTS supplier_discount_policy_pactado_con_dias`);
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      ADD CONSTRAINT supplier_discount_policy_pactado_con_dias
      CHECK (source <> 'pactado' OR expected_discount_rate = 0
             OR (discount_days IS NOT NULL AND discount_days > 0))`);

  // ── c) la vista que resuelve qué condición rige ───────────────────────────────────────────
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_payment_terms`);
  await knex.raw(`
    CREATE VIEW analytics.v_supplier_payment_terms
    WITH (security_invoker = true) AS
    WITH pactado AS (
      SELECT proveedor_code, expected_discount_rate, discount_days,
             agreed_on, agreed_evidence, agreed_contact, notes
        FROM commercial.supplier_discount_policy
       WHERE source = 'pactado' AND active
    )
    SELECT
      coalesce(p.proveedor_code, d.proveedor_code)                          AS proveedor_code,

      /* De donde sale lo que se publica. Lo pactado gana: observar es inferir de la conducta,
         pactar es saberlo. */
      CASE WHEN p.proveedor_code IS NOT NULL      THEN 'pactado'
           WHEN d.n_observaciones >= ${MIN_OBS}   THEN 'observado'
           ELSE 'ninguno' END                                               AS origen,

      /* Tres valores, no dos. TRUE da descuento - FALSE preguntamos y no da - NULL no sabemos.
         Un FALSE y un NULL se pintan igual hoy y NO son lo mismo (ADR-056). */
      CASE WHEN p.proveedor_code IS NOT NULL THEN (p.expected_discount_rate > 0)
           WHEN d.n_observaciones >= ${MIN_OBS} THEN true
           END                                                              AS da_descuento,

      /* La tasa y los dias que RIGEN. Quedan NULL cuando no hay descuento que capturar: un 0 se
         leeria como "no da", que es distinto de "no aplica porque ya sabemos que no da". */
      CASE WHEN p.proveedor_code IS NOT NULL AND p.expected_discount_rate > 0
                THEN p.expected_discount_rate
           WHEN p.proveedor_code IS NULL AND d.n_observaciones >= ${MIN_OBS}
                THEN d.tasa_observada END                                   AS tasa,
      CASE WHEN p.proveedor_code IS NOT NULL AND p.expected_discount_rate > 0
                THEN p.discount_days
           WHEN p.proveedor_code IS NULL AND d.n_observaciones >= ${MIN_OBS}
                THEN d.dias_mediana END                                     AS dias,

      /* El contraste que [PP.0] dejo pedido: lo observado viaja SIEMPRE, tambien cuando hay
         pacto, porque la pregunta "nos dan lo que dijeron?" necesita los dos lados. */
      d.n_observaciones, d.tasa_observada, d.dias_mediana                   AS dias_observados,
      d.descuento_12m, d.base_12m,

      p.agreed_on                                                           AS pactado_el,
      p.agreed_evidence                                                     AS pactado_consta,
      p.agreed_contact                                                      AS pactado_con,
      p.notes                                                               AS pactado_notas,

      /* cumplimos responde UNA cosa y hay que leerla literal: con la ventana pactada en la
         mano, la mediana de lo que de hecho tardamos en pagar, cae dentro? NULL si falta
         cualquiera de los dos lados -- no se inventa un verdadero ni un falso. */
      CASE WHEN p.proveedor_code IS NOT NULL AND p.expected_discount_rate > 0
                AND p.discount_days IS NOT NULL AND d.dias_mediana IS NOT NULL
                THEN d.dias_mediana <= p.discount_days END                  AS cumplimos
      FROM pactado p
      FULL JOIN analytics.mv_supplier_prompt_discount d
             ON d.proveedor_code = p.proveedor_code`);

  await knex.raw(`GRANT SELECT ON analytics.v_supplier_payment_terms TO PUBLIC`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_supplier_payment_terms IS
      'PGP.45 - condicion de pronto pago que RIGE por proveedor, con su procedencia. Lo pactado (commercial.supplier_discount_policy source=pactado) gana sobre lo observado (analytics.mv_supplier_prompt_discount). da_descuento es de TRES valores: true / false (preguntamos y no da) / null (no sabemos).'`);

  // ── el control: una medición cuya respuesta ya conozco por otro camino ────────────────────
  //
  // ⛔ Antes de leer nada: una matvista creada `WITH NO DATA` **no se puede consultar**. Postgres
  // no devuelve cero filas, RECHAZA el SELECT con `55000 - materialized view has not been
  // populated`. En prod está poblada (la refresca el nocturno de [PP.0]), pero en una base recién
  // levantada —desarrollo, y la del job `pruebas-db` del CI— puede no estarlo, y entonces el
  // control tumbaría una migración que no tiene nada malo. Se DECLARA en vez de reventar: la
  // estructura queda creada igual, que es lo que esa base necesita.
  const { rows: pobl } = await knex.raw(`
    SELECT c.relispopulated AS poblada
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'mv_supplier_prompt_discount'`);
  if (!pobl.length || pobl[0].poblada !== true) {
    console.log(
      '[PGP.45] vista v_supplier_payment_terms creada. ⚠️ CONTROL NO MEDIDO: ' +
      'analytics.mv_supplier_prompt_discount no esta poblada en esta base, asi que no se pudo ' +
      'contrastar la vista contra ella. La estructura quedo aplicada igual.');
    return;
  }

  const { rows: ctl } = await knex.raw(`
    SELECT count(*)::int                                                    AS filas,
           count(*) FILTER (WHERE origen = 'pactado')::int                  AS pactados,
           count(*) FILTER (WHERE origen = 'observado')::int                AS observados,
           count(*) FILTER (WHERE origen = 'ninguno')::int                  AS ninguno,
           count(*) FILTER (WHERE da_descuento IS NULL)::int                AS no_sabemos,
           count(*) FILTER (WHERE da_descuento = false)::int                AS no_dan
      FROM analytics.v_supplier_payment_terms`);
  const c = ctl[0];
  const { rows: mv } = await knex.raw(`
    SELECT count(*) FILTER (WHERE n_observaciones >= ${MIN_OBS})::int AS con_ventana,
           count(*)::int                                              AS total
      FROM analytics.mv_supplier_prompt_discount`);

  // CONTROL NEGATIVO: hoy no existe NINGUNA fila 'pactado'. Si la vista publicara aunque sea
  // una, estaria inventando un acuerdo que nadie capturo -- que es exactamente el defecto que
  // esta ficha viene a cerrar, cometido por la ficha misma.
  const { rows: cuantos } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.supplier_discount_policy
      WHERE source = 'pactado' AND active`);
  if (c.pactados !== cuantos[0].n) {
    throw new Error(
      `[PGP.45] control negativo roto: la vista publica ${c.pactados} condiciones pactadas ` +
      `contra ${cuantos[0].n} filas source='pactado' activas en la tabla.`);
  }
  // Y los 'observado' tienen que ser los de la matvista con n >= MIN_OBS, menos los que un
  // pacto ya haya tapado.
  const { rows: tapados } = await knex.raw(`
    SELECT count(*)::int AS n
      FROM commercial.supplier_discount_policy p
      JOIN analytics.mv_supplier_prompt_discount d ON d.proveedor_code = p.proveedor_code
     WHERE p.source = 'pactado' AND p.active AND d.n_observaciones >= ${MIN_OBS}`);
  const esperados = mv[0].con_ventana - tapados[0].n;
  if (c.observados !== esperados) {
    throw new Error(
      `[PGP.45] control roto: ${c.observados} observados en la vista contra ${esperados} ` +
      `esperados (${mv[0].con_ventana} con n >= ${MIN_OBS} menos ${tapados[0].n} ya pactados).`);
  }

  console.log(
    `[PGP.45] vista v_supplier_payment_terms: ${c.filas} proveedores - ` +
    `${c.pactados} pactados - ${c.observados} observados - ${c.ninguno} sin condicion - ` +
    `da_descuento: ${c.no_dan} "no dan" / ${c.no_sabemos} "no sabemos". ` +
    `Matvista: ${mv[0].con_ventana} con ventana de ${mv[0].total}.`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_payment_terms`);
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      DROP CONSTRAINT IF EXISTS supplier_discount_policy_pactado_con_dias`);
  await knex.raw(`
    ALTER TABLE commercial.supplier_discount_policy
      DROP CONSTRAINT IF EXISTS supplier_discount_policy_pactado_con_fecha`);
  // El CHECK de `source` vuelve a su forma vieja SOLO si no quedo ninguna fila 'pactado':
  // restaurarlo con filas pactadas vivas tiraria la migracion y dejaria la tabla a medias.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.supplier_discount_policy WHERE source = 'pactado'`);
  if (rows[0].n === 0) {
    await knex.raw(`
      ALTER TABLE commercial.supplier_discount_policy
        DROP CONSTRAINT IF EXISTS supplier_discount_policy_source_check`);
    await knex.raw(`
      ALTER TABLE commercial.supplier_discount_policy
        ADD CONSTRAINT supplier_discount_policy_source_check
        CHECK (source IN ('kepler','observed','manual'))`);
  }
};
