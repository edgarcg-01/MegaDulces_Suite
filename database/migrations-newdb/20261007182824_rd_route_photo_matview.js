'use strict';
/**
 * `[RD.45]` — **La foto del camion, materializada CON el nombre del producto: es la HOJA DE CONTEO.**
 *
 * `analytics.v_rd_route_photo` es lo que cada camioneta declara de si misma (FDW al runner), o
 * sea **exactamente lo que hoy se imprime en papel y se recorre con una regla**. Al convertirla
 * en la hoja de una pantalla de conteo deja de ser un reporte que alguien mira una vez al dia y
 * pasa a ser lo que una persona abre 300 veces seguidas, renglon por renglon.
 *
 * ── Lo medido, y la correccion de un diagnostico equivocado ─────────────────────────────────
 *
 * ⛔ **La primera version de esta migracion FALLO en su propio freno, y tenia razon.** Decia que
 * los 2,642 ms de la hoja venian de que la vista recalcula el empalme de toda la flota; se
 * materializo, y la hoja siguio tardando **2,449 ms**. El freno de proposito la rechazo: *una
 * copia que no resuelve el problema que la justifica no se queda*.
 *
 * Partido de verdad (prod, 2026-10-07, ruta 28 con 348 renglones):
 *
 *  | pedazo                                   | costo    |
 *  |------------------------------------------|----------|
 *  | la foto sola (FDW + empalme)             |  ~900 ms |
 *  | ⛔ `LEFT JOIN catalog ON btrim(p.sku)`   | +3,100 ms|
 *  | el mismo join **sin** `btrim`            |    ~0 ms |
 *  | `LATERAL` a `route_push_lines` por SKU   |  ~300 ms |
 *
 * ⭐ **El `btrim` del lado del catalogo era el 70% del costo y no rescataba NI UNA fila**: con y
 * sin el, los mismos 3 renglones de 3,035 no encuentran producto, porque **0 de los 11,301 SKUs
 * del catalogo tienen espacios** (ni los 230,398 de `route_push_lines`). Anulaba el indice
 * `products_tenant_sku_unique` y forzaba un seq scan de 14,887 filas **por cada renglon**.
 *
 * ⚠️ Y de paso cae otra conclusion mia: los renglones "sin nombre" NO eran culpa del join. Son
 * **217 productos que SI estan en el catalogo con la descripcion VACIA**. El nombre que usa el
 * propio camion al venderlos rescata 166; quedan **54 de 3,035 (1.8%)** que se muestran con su
 * codigo pelado, y eso se DECLARA en el candado en vez de redondearse a "100% cubierto".
 *
 * ── Por que la copia trae el NOMBRE adentro ─────────────────────────────────────────────────
 *
 * Con los joins arreglados la hoja queda en ~300 ms contra la vista: pasa el liston de 500, pero
 * paga **348 busquedas** del nombre cada vez que alguien abre un camion. Resolviendolo dentro de
 * la copia, la pantalla lee **una sola tabla sin un solo join** y el nombre se calcula una vez
 * cada 30 minutos para toda la flota.
 *
 * ⭐ Materializar por COSTO es lo que `GOTCHAS §19` permite: el pecado es materializar un valor
 * **inventado**. Aca no se inventa nada — las columnas de la foto se copian tal cual (el freno 1
 * lo prueba al centavo) y `producto`/`barcode` son una derivacion del catalogo, no un dato nuevo.
 *
 * ⚠️ **El freno 3 es sensible a la carga del momento, y eso es a proposito.** Esta version
 * tambien fallo una vez, con 2,916 ms, mientras otra sesion corria un
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY`; libre de contencion, el mismo plan da **0.265 ms**
 * de servidor. O sea que el freno puede dar un rojo que no es del codigo. Se deja asi: un freno
 * que a veces es demasiado estricto falla **fuerte y a la vista**, y uno que promedia o reintenta
 * deja pasar justo la pantalla lenta que vino a atrapar. Por eso imprime los DOS relojes — con
 * el plan a la vista, distinguir "mi consulta es lenta" de "la base esta ocupada" toma un vistazo.
 *
 * ⚠️ **Lo que la copia cuesta: frescura.** Se refresca con los demas (cada 30 min), asi que entre
 * el push de la camioneta y la hoja puede haber hasta media hora de rezago, y un nombre corregido
 * en el catalogo tarda lo mismo en verse. Es tolerable porque la foto es **diaria**, pero NO se
 * da por supuesto: `foto_fecha` viaja en cada renglon y la pantalla la publica arriba.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_rd_route_photo';
const MAT = 'analytics.mv_rd_route_photo';
/** Gate del proyecto para una consulta que sirve una pantalla. */
const GATE_MS = 500;

/** La consulta REAL de la pantalla: una tabla, cero joins. */
const HOJA = (fuente) => `
  SELECT sku, unidad, producto, qty, costo_unitario, importe, barcode
    FROM ${fuente}
   WHERE route_no = ?`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: [hay] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS si`, [VISTA]);
  if (!hay.si) throw new Error(`[RD.45] falta ${VISTA}: correr primero 20261006230000_rd_route_photo_fdw`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MAT} AS
    WITH vocab AS (
      -- Como llama el PROPIO camion a cada producto cuando lo vende. Es el segundo recurso para
      -- los 217 que el catalogo tiene sin descripcion. Se agrega UNA vez para toda la flota, no
      -- con un LATERAL por renglon: el correlacionado cuesta ~300 ms por hoja y esto se paga una
      -- vez cada 30 min.
      -- Sin btrim(l.sku): medido, 0 de 230,398 filas traen espacios, y envolverlo anula el indice.
      SELECT tenant_id, route_no, sku, max(producto) AS producto
        FROM analytics.route_push_lines
       WHERE coalesce(btrim(producto),'') <> ''
       GROUP BY 1,2,3
    )
    SELECT f.*,
           coalesce(nullif(btrim(p.description),''), v.producto, f.sku) AS producto,
           nullif(btrim(p.barcode),'')                                  AS barcode
      FROM ${VISTA} f
      -- Sin btrim(p.sku): usa products_tenant_sku_unique. Con el, seq scan de 14,887 filas por
      -- renglon = 3.1 s por hoja, y NO rescata ninguna fila (0 SKUs del catalogo con espacios).
      LEFT JOIN catalog.products p
        ON p.tenant_id = f.tenant_id AND p.sku = f.sku AND p.deleted_at IS NULL
      LEFT JOIN vocab v
        ON v.tenant_id = f.tenant_id AND v.route_no = f.route_no AND v.sku = f.sku`);

  // La llave. Si la foto pudiera devolver dos renglones del mismo (ruta, sku, unidad) esto falla
  // aca y la migracion no entra -- que es lo correcto: una hoja con el mismo producto dos veces
  // le pide a una persona que lo cuente dos veces.
  // Ademas habilita REFRESH CONCURRENTLY, sin el cual el refresco bloquea a quien este contando.
  await knex.raw(`CREATE UNIQUE INDEX mv_rd_route_photo_pk ON ${MAT} (tenant_id, route_no, sku, unidad)`);
  // El indice de la pantalla: una ruta entera de un saque.
  await knex.raw(`CREATE INDEX mv_rd_route_photo_ruta ON ${MAT} (route_no)`);
  // Sin estadisticas el planificador elige a ciegas sobre una tabla recien nacida, y el freno de
  // abajo mediria ese plan malo en vez del que va a correr en produccion.
  await knex.raw(`ANALYZE ${MAT}`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MAT} IS
    'RD.45 - la HOJA DE CONTEO de un camion: la foto del FDW con el nombre del producto ya resuelto. La pantalla lee esto SIN joins. Medido: la hoja costaba 2,642 ms (gate 500) y el 70% era un btrim(p.sku) que anulaba el indice sin rescatar una sola fila. Se refresca cada 30 min; foto_fecha viaja en cada renglon porque el rezago es real y se declara.'`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO dev_ro`);

  // ── Freno 1: PARIDAD. Las columnas de la foto se copian tal cual, al centavo ──────────────
  const { rows: [par] } = await knex.raw(`
    WITH v AS (SELECT route_no, count(*) n, sum(qty) q, sum(importe) i FROM ${VISTA} GROUP BY 1),
         m AS (SELECT route_no, count(*) n, sum(qty) q, sum(importe) i FROM ${MAT}   GROUP BY 1)
    SELECT count(*)::int AS rutas,
           count(*) FILTER (WHERE v.n IS DISTINCT FROM m.n)::int                             AS difieren_filas,
           count(*) FILTER (WHERE round(coalesce(v.i,0),2) <> round(coalesce(m.i,0),2))::int AS difieren_importe
      FROM v FULL JOIN m USING (route_no)`);
  if (Number(par.rutas) === 0) {
    throw new Error('[RD.45] la foto no tiene una sola ruta: el FDW no esta respondiendo, revisar antes de seguir');
  }
  if (Number(par.difieren_filas) || Number(par.difieren_importe)) {
    throw new Error(`[RD.45] la copia NO cuadra con la vista: ${par.difieren_filas} ruta(s) con otro conteo de renglones, ${par.difieren_importe} con otro importe`);
  }
  console.log(`  · [RD.45] paridad OK en ${par.rutas} ruta(s)`);

  // ── Freno 2: el NOMBRE. La copia existe para que la hoja sea legible ──────────────────────
  //
  // No se exige 100%: se exige que no se derrumbe. Medido hoy, 54 de 3,035 renglones (1.8%) se
  // muestran con el codigo pelado porque el catalogo los tiene sin descripcion y el camion
  // tampoco los nombra. El umbral esta por debajo de lo medido a proposito -- un freno calibrado
  // al valor exacto de hoy se pone rojo con la primera alta de producto.
  const { rows: [nom] } = await knex.raw(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE producto = sku)::int AS sin_nombre FROM ${MAT}`);
  const pctNom = Number(nom.total) ? (100 * (nom.total - nom.sin_nombre) / nom.total) : 0;
  if (pctNom < 95) {
    throw new Error(`[RD.45] solo el ${pctNom.toFixed(1)}% de los renglones tiene nombre (${nom.sin_nombre} de ${nom.total} saldrian como un codigo pelado)`);
  }
  console.log(`  · [RD.45] nombre resuelto en el ${pctNom.toFixed(2)}% (${nom.sin_nombre} de ${nom.total} sin nombre, se declaran)`);

  // ── Freno 3: PROPOSITO. La hoja mas grande tiene que entrar en el gate ────────────────────
  //
  // Se mide la consulta REAL que sirve la pantalla, no la matvista pelada: medir una consulta
  // parecida no mide nada. Es el freno que rechazo la primera version de esta migracion.
  const { rows: [una] } = await knex.raw(`SELECT route_no FROM ${MAT} GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  let t = Date.now();
  const { rows: hoja } = await knex.raw(HOJA(MAT), [una.route_no]);
  const msMat = Date.now() - t;

  // Diagnostico: el reloj del CLIENTE y el del SERVIDOR miden cosas distintas. Si el plan dice
  // milisegundos y el cliente dice segundos, el costo no es la consulta -- es el viaje, y
  // cambiar la consulta no arregla nada. Se imprime siempre: una medicion que solo aparece
  // cuando algo falla no deja comparar contra la vez que salio bien.
  const { rows: plan } = await knex.raw(`EXPLAIN (ANALYZE, BUFFERS) ${HOJA(MAT).replace('?', `'${una.route_no}'`)}`);
  const txt = plan.map((r) => r['QUERY PLAN']).join('\n');
  const exec = /Execution Time: ([\d.]+) ms/.exec(txt);
  const plan2 = /Planning Time: ([\d.]+) ms/.exec(txt);
  console.log(`  · [RD.45] reloj: cliente ${msMat} ms · servidor ${exec ? exec[1] : '?'} ms (plan ${plan2 ? plan2[1] : '?'} ms) · ${hoja.length} filas`);
  console.log(txt.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n'));

  if (msMat > GATE_MS) {
    throw new Error(`[RD.45] la hoja de la ruta ${una.route_no} tarda ${msMat} ms con la copia: no alcanza el gate de ${GATE_MS} ms, la copia no resolvio el problema`);
  }

  // ── Freno 4 (PRUEBA NEGATIVA): y la fuente viva NO lo alcanzaba ───────────────────────────
  //
  // Sin esto, el freno 3 se pondria verde igual si la vista ya fuera rapida -- o sea declararia
  // ganancia donde no hubo ninguna, que es la forma mas facil de justificar una copia inutil.
  // Se compara contra la consulta EQUIVALENTE sobre la vista: misma salida, otra fuente.
  t = Date.now();
  await knex.raw(`
    SELECT f.sku, f.unidad,
           coalesce(nullif(btrim(p.description),''), v.producto, f.sku) AS producto,
           f.qty, f.costo_unitario, f.importe, nullif(btrim(p.barcode),'') AS barcode
      FROM ${VISTA} f
      LEFT JOIN catalog.products p
        ON p.tenant_id = f.tenant_id AND p.sku = f.sku AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT max(l.producto) AS producto FROM analytics.route_push_lines l
         WHERE l.tenant_id = f.tenant_id AND l.route_no = f.route_no AND l.sku = f.sku
      ) v ON true
     WHERE f.route_no = ?`, [una.route_no]);
  const msVista = Date.now() - t;
  if (msVista <= msMat) {
    throw new Error(`[RD.45] la fuente viva tarda ${msVista} ms y la copia ${msMat} ms: la copia NO es mas rapida, no hay razon para materializar`);
  }
  console.log(`  · [RD.45] hoja de la ruta ${una.route_no} (${hoja.length} renglones): viva ${msVista} ms -> copia ${msMat} ms`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila mas. La vista queda intacta. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
};
