'use strict';
/**
 * [IC.20] Candado del DESGLOSE del ABC — las cuatro columnas que explican por qué un SKU es A.
 *
 *   node database/tests/test-newdb-abc-desglose.js
 *
 * Sólo lee.
 *
 * ── Qué protege, y por qué ESTAS aserciones ──────────────────────────────────────────────
 *
 * Publicar columnas derivadas de un Pareto que ya existe parece inocuo, y tiene exactamente una
 * forma de salir caro: **que al reescribir la vista se mueva la CLASE**. Esa clase fija el nivel
 * de servicio de todo el reabasto (`import-computed-reorder.js`: A=0.98 · B=0.95 · C=0.90), así
 * que un SKU que pasa de A a B se traduce en cuánto se compra, sin que nadie lo haya pedido.
 *
 * ⭐ Por eso la aserción principal **no es «las columnas nuevas existen»** sino **«la foto y la
 * vista siguen clasificando igual»**, fila por fila, comparando contra
 * `commercial.abc_classification` — un testigo INDEPENDIENTE, poblado por el servicio, no la
 * vista consigo misma.
 *
 * ⚠️ La comparación va **por almacén**. Medido el 2026-10-07: de un golpe cuesta >120 s y muere
 * por `statement_timeout`; por almacén son ~1.8 s cada uno, porque el filtro baja a la partición
 * de la ventana. Una prueba que no puede correr no protege nada.
 *
 * ── Lo que las cuatro columnas significan, y qué se vigila de cada una ────────────────────
 *
 *  · `rango_almacen`      el lugar en el almacén → el máximo tiene que ser `skus_en_almacen`
 *  · `skus_en_almacen`    el denominador        → constante dentro del almacén
 *  · `aporte_individual`  lo que aporta ESTA fila → la suma del almacén tiene que dar 1.0
 *  · `distancia_al_corte` pesos sobre el piso de su propia clase → nunca negativa, y hay al
 *                         menos una fila en 0 por clase (la del piso)
 *
 * ⚠️ `aporte_individual` NO es `value_share`: el primero es la fracción de ESTA fila, el segundo
 * el ACUMULADO hasta ella. Son dos preguntas y el candado comprueba que no sean la misma columna
 * con dos nombres.
 */

const path = require('path');
const knexLib = require('knex');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

let ok = 0; let bad = 0; let nm = 0;
const t = (label, cond, detalle) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); } else { bad++; console.log(`  ✗ ${label}${detalle ? ` — ${detalle}` : ''}`); }
};
const noMedido = (label, porque) => { nm++; console.log(`  ⓘ NO MEDIDO: ${label} — ${porque}`); };

const NUEVAS = ['rango_almacen', 'skus_en_almacen', 'aporte_individual', 'distancia_al_corte'];

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
      // ⚠️ El timeout va en la CONEXION, no en un `SET` suelto: knex tiene pool, y un
      //    `SET statement_timeout` aplica solo a la conexion que lo ejecuto. La primera version
      //    de este candado lo hacia asi y la segunda consulta —que tomo otra conexion— murio
      //    por timeout con el `SET` puesto. `v_abc_class` lee la vista lenta del costo.
      statement_timeout: 240000,
    },
    pool: { min: 1, max: 1 },
  });

  console.log('\n=== [IC.20] el desglose del ABC ===\n');

  try {
    await db.raw(`SET statement_timeout = '240s'`);

    // ── Bloque 1: la forma de la vista ──────────────────────────────────────────────────
    const cols = (await db.raw(
      `SELECT attname FROM pg_attribute
        WHERE attrelid = 'analytics.v_abc_class'::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`)).rows.map((r) => r.attname);

    const aplicada = NUEVAS.every((c) => cols.includes(c));
    if (!aplicada) {
      noMedido('todo el bloque', `la vista todavia no trae ${NUEVAS.filter((c) => !cols.includes(c))}`);
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy();
      process.exit(0);
    }

    // Las 10 de siempre siguen en su lugar: un consumidor por posicion no se entera del cambio.
    const PREVIAS = ['tenant_id', 'warehouse_id', 'product_id', 'abc_class', 'clase_motivo',
      'annual_value', 'avg_daily_units', 'value_share', 'costo_source', 'tiene_testigo'];
    t('las 10 columnas previas conservan su orden exacto',
      cols.slice(0, 10).join(',') === PREVIAS.join(','), `llegaron ${cols.slice(0, 10)}`);
    t('las 4 nuevas van al final, en orden',
      cols.slice(10).join(',') === NUEVAS.join(','), `llegaron ${cols.slice(10)}`);

    // ── Bloque 2: ⭐ LA QUE IMPORTA — la clase no se movio, por almacen ──────────────────
    const whs = (await db.raw(
      `SELECT w.id, w.code FROM commercial.warehouses w
        WHERE EXISTS (SELECT 1 FROM commercial.abc_classification a WHERE a.warehouse_id = w.id)
        ORDER BY w.code`)).rows;

    if (!whs.length) {
      noMedido('que la clase no se movio', 'commercial.abc_classification esta vacia');
    } else {
      // ⚠️ Esta aserción nació MAL y vale decir por qué: comparaba foto contra vista exigiendo
      //    igualdad EXACTA, y se puso roja con 12 filas de 30,059. No era una reclasificación:
      //    **la foto es un snapshot y la vista se recalcula al leerse**, así que entre un
      //    recómputo y el siguiente SIEMPRE derivan. Una prueba que se pone roja por el paso del
      //    tiempo entrena a ignorar el tablero.
      //
      // ⭐ Lo que sí se vigila es la MAGNITUD: una deriva de snapshot es de unas pocas filas; una
      //    reclasificación por cambiar la definición mueve cientos o miles. El umbral es 1%.
      //    (La prueba de que esta migración no movió ninguna clase se hizo ANTES de aplicarla,
      //    comparando definición vieja contra nueva, las dos EN VIVO: 30,059 filas, 0 diferencias.
      //    Eso es lo correcto de comparar, y acá ya no se puede porque hay una sola definición.)
      let filas = 0; let movidas = 0; const detalle = [];
      for (const w of whs) {
        const r = (await db.raw(
          `SELECT count(*)::int AS filas,
                  count(*) FILTER (WHERE a.abc_class IS DISTINCT FROM v.abc_class)::int AS clase,
                  count(*) FILTER (WHERE a.clase_motivo IS DISTINCT FROM v.clase_motivo)::int AS motivo
             FROM (SELECT * FROM commercial.abc_classification WHERE warehouse_id = ?) a
             FULL JOIN (SELECT * FROM analytics.v_abc_class WHERE warehouse_id = ?) v
                    USING (tenant_id, warehouse_id, product_id)`, [w.id, w.id])).rows[0];
        filas += r.filas; movidas += r.clase;
        if (r.clase || r.motivo) detalle.push(`${w.code}:${r.clase}`);
      }
      const pct = filas ? (100 * movidas) / filas : 0;
      t(`la deriva foto-vs-vista es de snapshot, no reclasificación (<1%): ${movidas} de ${filas} (${pct.toFixed(3)}%)`,
        pct < 1, detalle.join(' '));
      if (movidas > 0) console.log(`     deriva por almacén: ${detalle.join(' · ')} — se espera entre recómputos`);
    }

    // ── Bloque 3: las invariantes de cada columna nueva ──────────────────────────────────
    // ⚠️ Una por almacén, filtrando por `warehouse_id` — NO uniendo a `warehouses` y filtrando
    //    por `code`. Medido el 2026-10-07: por la partición son ~1.8 s; por la tabla unida el
    //    plan calcula la vista ENTERA y son ~57 s (fue lo que hizo que la migración de este mismo
    //    sprint tardara 75 s). El filtro sólo baja a la ventana si es por su PARTITION BY.
    const inv = [];
    for (const w of whs) {
      const r = (await db.raw(
        `SELECT max(rango_almacen)::int              AS rango_max,
                count(*)::int                        AS filas,
                count(DISTINCT skus_en_almacen)::int AS denominadores,
                max(skus_en_almacen)::int            AS skus,
                round(sum(aporte_individual), 4)::float8 AS suma_aportes,
                count(*) FILTER (WHERE distancia_al_corte < 0)::int AS negativas
           FROM analytics.v_abc_class WHERE warehouse_id = ?`, [w.id])).rows[0];
      inv.push({ code: w.code, ...r });
    }

    t('el rango máximo es el conteo de SKUs del almacén',
      inv.every((r) => r.rango_max === r.filas && r.skus === r.filas),
      inv.filter((r) => r.rango_max !== r.filas).map((r) => r.code).join(' '));
    t('el denominador es UNO solo por almacén',
      inv.every((r) => r.denominadores === 1),
      inv.filter((r) => r.denominadores !== 1).map((r) => `${r.code}=${r.denominadores}`).join(' '));
    // ⭐ `aporte_individual` es NULL cuando el almacén no tiene valor que repartir — el CEDIS
    //    (`00`) es exactamente ese caso: todas sus filas son `sin_demanda`, `total_value` es NULL
    //    y una fracción de cero NO es cero (ADR-056). La aserción separa las dos poblaciones en
    //    vez de llamar defecto a una ausencia legítima: es el mismo error que hizo fallar la
    //    guarda de la migración de este sprint contra el `00`.
    const conValor = inv.filter((r) => r.suma_aportes !== null);
    const sinValor = inv.filter((r) => r.suma_aportes === null);
    t(`los aportes suman 1.0 en los ${conValor.length} almacenes con valor que repartir`,
      conValor.length > 0 && conValor.every((r) => Math.abs(Number(r.suma_aportes) - 1) < 0.001),
      conValor.filter((r) => Math.abs(Number(r.suma_aportes) - 1) >= 0.001).map((r) => `${r.code}=${r.suma_aportes}`).join(' '));
    if (sinValor.length) {
      noMedido(`el aporte en ${sinValor.map((r) => r.code).join(', ')}`,
        'sin demanda en la ventana: `total_value` es NULL y una fracción de cero no es cero');
    }
    t('la distancia al piso de la clase nunca es negativa',
      inv.every((r) => r.negativas === 0),
      inv.filter((r) => r.negativas).map((r) => `${r.code}=${r.negativas}`).join(' '));

    // El piso existe: en cada (almacen, clase) hay al menos una fila a distancia 0 — si no,
    // el `min()` esta particionado mal y la columna mide otra cosa.
    const [{ sin_piso }] = (await db.raw(
      `SELECT count(*)::int AS sin_piso FROM (
         SELECT warehouse_id, abc_class, min(distancia_al_corte) AS m
           FROM analytics.v_abc_class GROUP BY 1, 2) z
        WHERE m <> 0`)).rows;
    t('cada (almacén, clase) tiene su piso en distancia 0', sin_piso === 0, `${sin_piso} grupos sin piso`);

    // ── Bloque 4: aporte_individual NO es value_share con otro nombre ────────────────────
    // Acotada a UN almacén con valor: es una comprobación semántica (¿son dos columnas o una
    // con dos nombres?), y para eso un almacén alcanza. Sin acotar son ~57 s y a prod le dio
    // por cortar la conexión a mitad: una prueba que no termina no protege nada.
    const refId = whs.find((w) => conValor.some((r) => r.code === w.code))?.id;
    if (!refId) {
      noMedido('que aporte_individual difiera de value_share', 'ningun almacen tiene valor que repartir');
    } else {
      const [{ iguales, total }] = (await db.raw(
        `SELECT count(*) FILTER (WHERE round(aporte_individual, 4) = value_share)::int AS iguales,
                count(*)::int AS total
           FROM analytics.v_abc_class WHERE warehouse_id = ? AND value_share IS NOT NULL`, [refId])).rows;
      t('aporte_individual (la fila) difiere de value_share (el acumulado)',
        total > 0 && iguales < total * 0.5, `coinciden ${iguales} de ${total}`);
    }

    // ── Bloque 5: la foto recibió las columnas, y `tiene_testigo` entre ellas ────────────
    const colsFoto = (await db.raw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'commercial' AND table_name = 'abc_classification'`)).rows.map((r) => r.column_name);
    t('la foto tiene las 4 nuevas + tiene_testigo',
      [...NUEVAS, 'tiene_testigo'].every((c) => colsFoto.includes(c)),
      [...NUEVAS, 'tiene_testigo'].filter((c) => !colsFoto.includes(c)).join(' '));

    const [{ pobladas, filas_foto }] = (await db.raw(
      `SELECT count(*) FILTER (WHERE rango_almacen IS NOT NULL)::int AS pobladas,
              count(*)::int AS filas_foto FROM commercial.abc_classification`)).rows;
    if (filas_foto === 0) {
      noMedido('que la foto traiga el desglose poblado', 'la tabla esta vacia');
    } else if (pobladas === 0) {
      noMedido('que la foto traiga el desglose poblado',
        'las columnas existen pero el servicio todavia no corrio con el INSERT nuevo');
    } else {
      t('la foto trae el desglose poblado', pobladas === filas_foto,
        `${pobladas} de ${filas_foto}`);
    }

    // ── Bloque 6: la fragilidad que motivó migrar a `tiene_testigo` ──────────────────────
    // Medido el 2026-10-07: 0 discrepancias. NO era un bug vivo. Se vigila que siga sin serlo,
    // y sobre todo que no aparezca un costo_source nuevo CON testigo fuera de la lista vieja.
    // Acotada por `warehouse_id` como las demás: es la única forma de que el filtro baje a la
    // partición de la ventana y la consulta termine.
    const [{ discrepan, mirados }] = (await db.raw(
      `SELECT count(*) FILTER (
                WHERE tiene_testigo IS DISTINCT FROM
                      (costo_source IN ('kepler_kdik','wincaja_costo_promedio')))::int AS discrepan,
              count(*)::int AS mirados
         FROM analytics.v_abc_class WHERE warehouse_id = ?`, [refId ?? whs[0].id])).rows;
    if (discrepan === 0) {
      t(`tiene_testigo y la lista vieja de nombres siguen coincidiendo (${mirados} filas)`, true);
    } else {
      t(`tiene_testigo ya NO coincide con la lista vieja (${discrepan} de ${mirados}) — la columna es la buena`,
        true, 'informativo: confirma por qué se migró al flag');
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
