'use strict';
/**
 * `[PR.S1]` — **Capa 1 completa: el REGISTRO de señales, ejecutable.**
 *
 * ── Por qué una tabla y no el documento ────────────────────────────────────────────────────
 * La capa 1 estaba escrita en markdown. Un documento **no avisa cuando deja de ser cierto**: la
 * Fase CDRP lo pagó con una medición que sostenía una decisión, vivía en un `COMMENT ON TABLE`
 * de prod y **envejeció en tres días** sin que nada se pusiera rojo.
 *
 * ⭐ Acá el registro es **ejecutable**: declara cada señal con su fuente exacta, y el candado
 * **cruza lo declarado contra lo que existe de verdad**. Una señal que dice `cableada` y cuya
 * columna no existe pone la migración en rojo.
 *
 * ── ⭐⭐ La regla de oro, que sólo una tabla puede imponer ─────────────────────────────────
 *
 *     peso_max ≤ cobertura_pct / 100
 *
 * El peso de una señal **nunca puede exceder su cobertura**. Sin esto, el motor promediaría la
 * fuga —medida sobre el **6 %** de las celdas y el 33 % de la venta— con la terminación, que
 * cubre el **100 %**, y estaría decidiendo el precio del mostrador (dos tercios de la venta) con
 * evidencia que **no lo incluye**. El resultado se vería igual de confiable que cualquier otro.
 *
 * Esa regla no se puede sostener en un `const` ni en la buena memoria de quien escriba el
 * servicio: vive en un CHECK.
 *
 * ── Y una corrección de conteo ─────────────────────────────────────────────────────────────
 * El plan decía **41 señales**. Son **46**: 11 costo + 10 demanda + 6 cliente + 8 psicología +
 * 4 inventario + 2 competencia + 5 estrategia. Sumé mal. El registro lleva el número real, y el
 * candado lo verifica — es justamente lo que un documento no hace.
 *
 * ⛔ **Lo que el registro NO hace:** no fija los pesos (eso es la capa lógica) ni los umbrales
 * (ésos viven en `analytics.kpi_thresholds`, ADR-076). Fija el **techo** de cada peso.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'analytics.price_signal_registry';

async function check(knex, nombre, expr) {
  const [{ hay }] = (await knex.raw(
    `SELECT count(*)::int AS hay FROM pg_constraint
      WHERE conrelid = ?::regclass AND conname = ?`, [T, nombre])).rows;
  if (!hay) await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
}

/**
 * Las 46. `cob` es la cobertura MEDIDA el 2026-09-30; `col` la columna real en
 * `analytics.v_price_signals` cuando está cableada.
 */
const SENALES = [
  // ── A · COSTO (11) ───────────────────────────────────────────────────────────────────
  ['A1', 'costo', 'Costo de reposición', 'Lo que cuesta reponer hoy, en el peldaño base', 'mxn', 'menos_es_mejor', 'cableada', 38.2, 'a1_costo_hoy', true, null],
  ['A2', 'costo', 'Costo estándar de la ficha', 'El costo con el que Kepler fijó el precio vigente', 'mxn', 'menos_es_mejor', 'cableada', 100.0, 'a2_costo_ficha', true, null],
  ['A3', 'costo', 'Antigüedad del último costo', 'Días desde la última compra. La señal es la ANTIGÜEDAD, no el costo', 'dias', 'menos_es_mejor', 'cableada', 38.2, 'a3_dias_sin_comprar', true, null],
  ['A4', 'costo', 'COGS del kardex', 'El costo que contabilidad reconoce por la venta', 'mxn', 'menos_es_mejor', 'no_existe', 0, null, false, 'analytics.mv_erp_margin_daily existe pero nunca se poblo (relispopulated=false): la matvista esta vacia'],
  ['A5', 'costo', 'Escalera del proveedor', 'Lo pagado al proveedor por volumen', 'mxn', 'menos_es_mejor', 'disponible', 0, null, true, 'v_supplier_cost_ladder existe, sin cablear a la vista de senales'],
  ['A6', 'costo', 'Deriva del costo', 'Cuanto se aparto el costo de hoy del que fijo el precio', 'pct', 'menos_es_mejor', 'cableada', 38.2, 'a6_deriva_costo_pct', true, null],
  ['A7', 'costo', 'Volatilidad del costo', 'Dispersion del costo en el tiempo: un costo erratico pide colchon', 'pct', 'menos_es_mejor', 'no_existe', 0, null, true, 'derivable de v_label_price_changes, no construida'],
  ['A8', 'costo', 'Costo logistico atribuible', 'Flete imputable al SKU o a la zona', 'mxn', 'menos_es_mejor', 'no_existe', 0, null, false, '98.76% del gasto contable cae en la sucursal 00: prorratear para inventar un neto por SKU esta prohibido por ADR-056'],
  ['A9', 'costo', 'Dias de credito regalados', 'Dias pagados menos dias pactados', 'dias', 'menos_es_mejor', 'cableada', 6.0, 'a9_dias_exceso', true, null],
  ['A10', 'costo', 'Merma y caducidad', 'Lo que se pierde, como costo de lo que si se vende', 'pct', 'menos_es_mejor', 'disponible', 0, null, false, 'erp_count_rollforward mide la merma del periodo, sin cablear'],
  ['A11', 'costo', 'Apoyo del proveedor', 'Rebate que baja el costo EFECTIVO, no el facturado', 'mxn', 'mas_es_mejor', 'no_existe', 0, null, false, 'vive a nivel PROVEEDOR: la nota de credito no tiene renglones (1,256 docs, 0 lineas). Bajarlo a SKU exige prorratear, prohibido por ADR-056'],

  // ── B · DEMANDA (10) ─────────────────────────────────────────────────────────────────
  ['B1', 'demanda', 'Elasticidad jerarquica', 'Como responde el volumen al precio, con shrinkage del grupo al SKU', 'razon', 'ninguna', 'no_existe', 0, null, true, 'solo existe la agregada en markdown (region AR [-1.415,-0.045]); por SKU el error estandar es 0.94 y seria ruido'],
  ['B2', 'demanda', 'Elasticidad por segmento', 'La elasticidad del mayoreo no es la del mostrador', 'razon', 'ninguna', 'no_existe', 0, null, true, 'requiere B1 y el segmento de cliente (D4 abierta)'],
  ['B3', 'demanda', 'Estacionalidad', 'Indice por dia de semana y mes', 'razon', 'ninguna', 'disponible', 0, null, true, 'demand_acceleration tiene z_seasonal por SKU (no por plaza); el indice de calendario vive en markdown'],
  ['B4', 'demanda', 'Estacionalidad por canal', 'La forma de la semana cambia por canal: mayoreo martes, tienda sabado', 'razon', 'ninguna', 'no_existe', 0, null, true, 'medido y escrito en markdown, sin tabla'],
  ['B5', 'demanda', 'Momentum', 'Aceleracion contra los mismos dias del ano anterior', 'razon', 'mas_es_mejor', 'disponible', 0, null, false, 'demand_acceleration.iad, sin cablear'],
  ['B6', 'demanda', 'Velocidad de rotacion', 'Unidades por dia', 'unidades', 'mas_es_mejor', 'cableada', 100.0, 'unidades_30d', true, null],
  ['B7', 'demanda', 'Intermitencia', 'Dias con venta de cada 30', 'razon', 'mas_es_mejor', 'no_existe', 0, null, true, 'el CV clasico NO discrimina (89% cae en clase Z); se mide por dias-con-venta, derivable de product_sales_daily'],
  ['B8', 'demanda', 'Pronostico de demanda', 'Unidades esperadas por semana', 'unidades', 'mas_es_mejor', 'no_existe', 0, null, true, 'no existe; product_demand.daily_pieces es un promedio movil'],
  ['B9', 'demanda', 'Canibalizacion', 'Volumen que se va al sustituto cuando sube el precio', 'pct', 'menos_es_mejor', 'no_existe', 0, null, true, 'el pipeline de afinidad calcula el lift bajo y lo DESCARTA al quedarse con el top-25'],
  ['B10', 'demanda', 'Efecto canasta', 'Lo que arrastra al ticket', 'razon', 'mas_es_mejor', 'disponible', 0, null, false, 'intelligence.product_affinity, 28,787 pares. Solo retail U/D/10: EXCLUYE el mayoreo'],

  // ── C · CLIENTE (6) ──────────────────────────────────────────────────────────────────
  ['C1', 'cliente', 'Segmento / grupo par', 'Que clientes son comparables', 'categoria', 'ninguna', 'no_existe', 0, null, true, 'no existe segmento formal; hay grupo, zona y vendedor del ERP sin unificar'],
  ['C2', 'cliente', 'Fuga de descuento', 'Cuanto se descuenta sobre la lista', 'pct', 'menos_es_mejor', 'cableada', 6.0, 'c2_fuga_pct', true, null],
  ['C3', 'cliente', 'Concentracion', 'Cuantos clientes sostienen la venta del SKU', 'unidades', 'mas_es_mejor', 'cableada', 6.0, 'c3_clientes', true, null],
  ['C4', 'cliente', 'Vendedores que lo tocan', 'Cuantos vendedores lo venden: el descuento varia 3x entre ellos', 'unidades', 'ninguna', 'cableada', 6.0, 'c4_vendedores', true, null],
  ['C5', 'cliente', 'Precio de referencia', 'A cuanto se le vendio antes: el ancla del cliente', 'mxn', 'ninguna', 'cableada', 6.0, 'c5_precio_cobrado_mediano', true, null],
  ['C6', 'cliente', 'Dispersion de precio', 'Rango entre el mas caro y el mas barato del mismo SKU', 'pct', 'menos_es_mejor', 'cableada', 6.0, 'c2_rango_precio_pct', true, null],

  // ── D · PSICOLOGIA (8) ───────────────────────────────────────────────────────────────
  ['D1', 'psicologia', 'Terminacion del precio', 'En que centavo cae, y si eso senala algo', 'categoria', 'ninguna', 'cableada', 100.0, 'd1_terminacion', true, null],
  ['D2', 'psicologia', 'Digito izquierdo', 'Distancia a la decena: de $99 a $101 el salto percibido es enorme', 'mxn', 'ninguna', 'cableada', 100.0, 'd2_falta_decena', true, null],
  ['D3', 'psicologia', 'Umbral redondo', 'Si esta pegado a una barrera de $10 o $100', 'booleano', 'ninguna', 'cableada', 100.0, 'd3_pegado_decena', true, null],
  ['D4', 'psicologia', 'Umbral de percepcion', 'Bajo este pct el cambio no se distingue del ruido (Weber-Fechner)', 'pct', 'ninguna', 'cableada', 100.0, 'd4_umbral_percepcion', true, null],
  ['D5', 'psicologia', 'Frecuencia de cambio', 'Cuantas veces cambio el precio: cambiar mucho erosiona confianza', 'unidades', 'menos_es_mejor', 'disponible', 0, null, true, 'v_label_price_changes lo permite, sin cablear'],
  ['D6', 'psicologia', 'Fatiga', 'Dias desde el ultimo cambio: dos alzas seguidas duelen mas que una del doble', 'dias', 'mas_es_mejor', 'disponible', 0, null, true, 'idem D5'],
  ['D7', 'psicologia', 'Senalizacion de calidad', 'Un precio demasiado bajo genera sospecha, no volumen', 'pct', 'ninguna', 'no_existe', 0, null, false, 'no medible sin el A/B'],
  ['D8', 'psicologia', 'Coherencia de la escalera', 'Si la caja NO sale mas barata por pieza, el catalogo se lee como error', 'booleano', 'ninguna', 'disponible', 0, null, true, 'v_kepler_unit_ladder lo permite, sin cablear'],

  // ── E · INVENTARIO (4) ───────────────────────────────────────────────────────────────
  ['E1', 'inventario', 'Cobertura en dias', 'Subir el precio de lo agotado no vende mas', 'dias', 'ninguna', 'disponible', 0, null, true, 'inventory_health.days_cover; choque de llaves (UUID vs sucursal/sku)'],
  ['E2', 'inventario', 'Riesgo de caducidad', 'Habilita BAJAR para liquidar', 'dias', 'mas_es_mejor', 'no_existe', 0, null, false, 'la tuberia FEFO existe pero el backfill dejo casi todos los lotes en NA sin fecha real'],
  ['E3', 'inventario', 'Sobrestock', 'Habilita bajar para liberar capital', 'booleano', 'ninguna', 'disponible', 0, null, true, 'inventory_health.status; mismo choque de llaves'],
  ['E4', 'inventario', 'Quiebre reciente', 'Subir y quedarse sin producto confunde causa y efecto', 'booleano', 'menos_es_mejor', 'disponible', 0, null, false, 'commercial.floor_stockouts, 1 fila medida'],

  // ── F · COMPETENCIA (2) ──────────────────────────────────────────────────────────────
  ['F1', 'competencia', 'Precio de competencia', 'A cuanto lo vende el de enfrente', 'mxn', 'ninguna', 'no_existe', 0, null, false, 'REFUTADO con medicion: el catalogo publico de PROFECO cubre 0% de nuestro catalogo. No existe fuente'],
  ['F2', 'competencia', 'Precio de la venta perdida', 'Contra que precio se perdio una cotizacion', 'mxn', 'ninguna', 'no_existe', 0, null, true, 'la unica via real; se captura en la cotizacion perdida y no esta construido'],

  // ── G · ESTRATEGIA (5) ───────────────────────────────────────────────────────────────
  ['G1', 'estrategia', 'Rol del SKU', 'Ancla, trafico, margen o imagen', 'categoria', 'ninguna', 'no_existe', 0, null, true, 'no existe. ⛔ is_promo NO sirve: marca artefactos del ERP de <=$0.05, no promociones'],
  ['G2', 'estrategia', 'Clase ABC', 'Concentracion de la venta', 'categoria', 'ninguna', 'disponible', 0, null, false, 'v_abc_class; choque de llaves'],
  ['G3', 'estrategia', 'Meta de margen', 'El margen que la ficha pide, por peldano', 'pct', 'mas_es_mejor', 'cableada', 97.5, 'm1_meta_margen', true, null],
  ['G4', 'estrategia', 'Intocables y contratos', 'Precio pactado que no se propone', 'booleano', 'ninguna', 'no_existe', 0, null, true, 'no existe ninguna marca de precio pactado. Hay que capturarla'],
  ['G5', 'estrategia', 'Promocion vigente', 'No se sube encima de una promo activa', 'booleano', 'ninguna', 'disponible', 0, null, true, 'v_erp_discount_rules: 4 mecanismos, 2 con umbral NO verificado'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('analytics').hasTable('price_signal_registry'))) {
    await knex.schema.withSchema('analytics').createTable('price_signal_registry', (t) => {
      t.text('clave').primary();
      t.text('familia').notNullable();
      t.text('nombre').notNullable();
      t.text('definicion').notNullable();
      t.text('unidad').notNullable();
      t.text('direccion').notNullable();
      t.text('estado').notNullable();

      // ⭐ La cobertura MEDIDA, con su fecha. Una cobertura sin fecha es una cobertura que
      //    alguien va a creer para siempre.
      t.decimal('cobertura_pct', 5, 2).notNullable().defaultTo(0);
      t.date('cobertura_medida_al');

      t.text('fuente_objeto');
      t.text('fuente_columna');
      t.text('motivo_ausencia');

      /**
       * ⭐⭐ EL TECHO DEL PESO. Nunca puede exceder la cobertura. Sin este candado, el motor
       * promediaria la fuga (6% de las celdas) con la terminacion (100%) y decidiria el precio
       * del mostrador -dos tercios de la venta- con evidencia que no lo incluye.
       */
      t.decimal('peso_max', 4, 3).notNullable().defaultTo(0);

      t.boolean('nucleo').notNullable().defaultTo(false);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  await check(knex, 'psr_familia_valida',
    `familia IN ('costo','demanda','cliente','psicologia','inventario','competencia','estrategia')`);
  await check(knex, 'psr_unidad_valida',
    `unidad IN ('pct','mxn','dias','unidades','razon','categoria','booleano')`);
  await check(knex, 'psr_direccion_valida',
    `direccion IN ('mas_es_mejor','menos_es_mejor','ninguna')`);
  await check(knex, 'psr_estado_valido',
    `estado IN ('cableada','disponible','no_existe')`);
  // ⛔ Cableada exige su columna: si no, "cableada" es una intención.
  await check(knex, 'psr_cableada_con_columna',
    `estado <> 'cableada' OR (fuente_objeto IS NOT NULL AND fuente_columna IS NOT NULL)`);
  // ⛔ Y lo que NO existe exige su motivo: una ausencia sin razón se lee como un olvido.
  await check(knex, 'psr_ausencia_con_motivo',
    `estado = 'cableada' OR btrim(coalesce(motivo_ausencia, '')) <> ''`);
  await check(knex, 'psr_cobertura_rango',
    `cobertura_pct >= 0 AND cobertura_pct <= 100`);
  // ⭐⭐ LA REGLA DE ORO.
  await check(knex, 'psr_peso_no_excede_cobertura',
    `peso_max <= cobertura_pct / 100.0`);
  // ⛔ Una señal que no existe no puede tener cobertura.
  await check(knex, 'psr_inexistente_sin_cobertura',
    `estado <> 'no_existe' OR cobertura_pct = 0`);
  await check(knex, 'psr_cobertura_con_fecha',
    `cobertura_pct = 0 OR cobertura_medida_al IS NOT NULL`);

  const HOY = '2026-09-30';
  for (const [clave, familia, nombre, definicion, unidad, direccion, estado, cob, col, nucleo, motivo] of SENALES) {
    await knex(T).insert({
      clave, familia, nombre, definicion, unidad, direccion, estado,
      cobertura_pct: cob,
      cobertura_medida_al: cob > 0 ? HOY : null,
      fuente_objeto: col ? 'analytics.v_price_signals' : null,
      fuente_columna: col,
      motivo_ausencia: motivo,
      // El techo arranca en la cobertura: la capa lógica lo baja, nunca lo sube.
      peso_max: cob / 100,
      nucleo,
    }).onConflict('clave').merge();
  }

  await knex.raw(`GRANT SELECT ON ${T} TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE ${T} IS
    $c$[PR.S1] Capa 1 del motor de margen: el REGISTRO de las 46 senales, EJECUTABLE. Existe como
    tabla y no como documento porque un markdown no avisa cuando deja de ser cierto -- la Fase
    CDRP lo pago con una medicion que sostenia una decision, vivia en un COMMENT ON TABLE y
    envejecio en tres dias sin que nada se pusiera rojo. El candado cruza lo DECLARADO contra lo
    que EXISTE: una senal cableada cuya columna no esta pone la migracion en rojo.
    ⭐⭐ La regla de oro, que solo una tabla puede imponer: peso_max <= cobertura_pct/100. Sin
    ella el motor promediaria la fuga -6% de las celdas, 33% de la venta- con la terminacion
    -100%- y decidiria el precio del mostrador, dos tercios de la venta, con evidencia que no lo
    incluye. ⛔ NO fija los pesos (eso es la capa logica) ni los umbrales (kpi_thresholds,
    ADR-076): fija el TECHO. El plan decia 41 senales y son 46 -- una suma mal hecha que este
    registro corrige y su candado verifica.$c$`);

  // ── Compuerta: cruzar lo DECLARADO contra lo que EXISTE ─────────────────────────────
  const [g] = (await knex.raw(`
    WITH r AS (SELECT * FROM ${T}),
    reales AS (
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'analytics.v_price_signals'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
    )
    SELECT (SELECT count(*)::int FROM r) AS total,
           (SELECT count(*)::int FROM r WHERE estado = 'cableada') AS cableadas,
           (SELECT count(*)::int FROM r WHERE estado = 'disponible') AS disponibles,
           (SELECT count(*)::int FROM r WHERE estado = 'no_existe') AS inexistentes,
           (SELECT count(*)::int FROM r WHERE nucleo) AS nucleo,
           -- ⛔ Declarada cableada y su columna NO existe en la vista
           (SELECT count(*)::int FROM r
             WHERE estado = 'cableada'
               AND fuente_columna NOT IN (SELECT attname FROM reales)) AS mentirosas,
           (SELECT count(DISTINCT familia)::int FROM r) AS familias`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S1] ${g.total} señales en ${g.familias} familias · `
    + `cableadas ${g.cableadas} · disponibles ${g.disponibles} · no existen ${g.inexistentes} · `
    + `núcleo ${g.nucleo}`);

  /**
   * ⭐ ÉSTA es la compuerta que un documento no puede tener: el registro dice que una señal está
   * cableada y la columna tiene que EXISTIR de verdad en la vista.
   */
  if (g.mentirosas > 0) {
    throw new Error(`[PR.S1] ${g.mentirosas} señales declaradas CABLEADAS cuya columna no existe `
      + 'en analytics.v_price_signals. El registro estaría mintiendo.');
  }
  if (g.total !== 46) {
    throw new Error(`[PR.S1] el registro tiene ${g.total} señales y el conteo declarado es 46.`);
  }
  if (g.familias !== 7) {
    throw new Error(`[PR.S1] ${g.familias} familias, se esperaban 7.`);
  }
  if (g.cableadas === 0) {
    throw new Error('[PR.S1] cero señales cableadas: el motor no tendría con qué decidir.');
  }
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('price_signal_registry');
};
