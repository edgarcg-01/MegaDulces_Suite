/* eslint-disable no-console */
/**
 * D — CANDADO del DICTAMEN DE EXISTENCIA (`analytics.v_existencia_dictamen`).
 *
 * Qué vigila, y por qué cada cosa:
 *
 *  1. QUE NO PASE EN VACÍO. Es el candado más valioso del set: una vista que devuelve cero
 *     anomalías se lee igual que una que no encuentra ninguna. Las poblaciones se afirman contra
 *     lo medido en prod el 2026-09-05.
 *  2. QUE EL DICTAMEN NO CONTRADIGA A LA VISTA CANÓNICA. `qty_publicada` tiene que ser exactamente
 *     lo que `v_erp_stock_on_hand` publica hoy — el dictamen la EXPLICA, no la reemplaza. Si esto
 *     se rompe, hay dos verdades y ninguna sirve.
 *  3. QUE EL NEGATIVO NUNCA SE SUME. `qty_cruda` se MUESTRA; `qty_publicada` se AGREGA. Un saldo
 *     de −5,553 no es mercancía negativa que se pueda restar de un total.
 *  4. ANTI-REGRESIÓN del bug que la primera corrida destapó: `nunca_entro` marcaba 1,913 celdas
 *     SANAS de Wincaja, donde vender el inventario inicial sin recibir nada nuevo es normal (allá
 *     el baseline existe; en Kepler no). Ninguna clase negativa puede tener saldo ≥ 0.
 *  5. QUE EL DINERO NO SE INVENTE cuando el peldaño está en disputa (regla U.2b / ADR-055).
 *  6. QUE NO SE CUELE LA CIRCULARIDAD. El dictamen NO puede leer `stock_movements` ni
 *     `stock_ledger`: `kdil` YA es entradas−salidas, así que cuadrarlo contra los movimientos es
 *     comparar el dato consigo mismo. Es donde se detuvo la Fase SM. Prohibido estructuralmente.
 *  7. QUE NO LEA `v_unit_rung_audit` en runtime (cuesta 8-25 s); el veredicto sale del FACT.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-existencia-dictamen.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

// Taxonomía CERRADA. Un valor que nadie nombró acá rompe el test a propósito: si alguien agrega
// un estado y no lo declara, la pantalla lo pintaría como desconocido sin que nadie se entere.
const APOYOS = ['conteo_fisico', 'baseline_real', 'solo_flujo'];
const OBJECIONES = ['nunca_entro', 'faltante', 'negativo_menor', 'unidad_sin_verificar',
  'sin_movimiento', 'ninguna'];

(async () => {
  console.log('\n=== DICTAMEN DE EXISTENCIA ===\n');
  const c = new Client({
    connectionString: URL,
    ssl: URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  // ── 0. Es VISTA, no tabla (derivar-no-copiar) y filtra por RLS del invocador.
  const v = (await c.query(
    `SELECT count(*)::int n FROM pg_views
      WHERE schemaname = 'analytics' AND viewname = 'v_existencia_dictamen'`,
  )).rows[0];
  check('v_existencia_dictamen existe y es VISTA', v.n === 1);

  const si = (await c.query(
    `SELECT c.reloptions::text AS opts FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_existencia_dictamen'`,
  )).rows[0];
  check('tiene security_invoker (la RLS del que consulta filtra el tenant)',
    (si?.opts || '').includes('security_invoker=true'), si?.opts || 'sin reloptions');

  // ── 1. ⭐ QUE NO PASE EN VACÍO. Poblaciones medidas en prod 2026-09-05.
  const t0 = Date.now();
  const pob = (await c.query(
    `SELECT objecion,
            count(*)::int celdas,
            count(*) FILTER (WHERE qty_cruda >= 0)::int no_negativo,
            count(*) FILTER (WHERE valor_faltante IS NULL)::int sin_valuar
       FROM analytics.v_existencia_dictamen
      WHERE tenant_id = $1
      GROUP BY 1`, [T],
  )).rows;
  const ms = Date.now() - t0;
  const by = Object.fromEntries(pob.map((r) => [r.objecion, r]));
  const n = (k) => (by[k]?.celdas ?? 0);

  console.log(`  poblaciones (${ms} ms): ${pob.map((r) => `${r.objecion}=${r.celdas}`).join(' · ')}\n`);

  check('hay celdas con saldo que nunca tuvo entrada (nunca_entro)', n('nunca_entro') > 0,
    'si da 0, el dictamen está pasando en vacío');
  check('hay celdas con faltante material', n('faltante') > 0);
  check('hay celdas con negativo menor (el baseline perdido)', n('negativo_menor') > 0);
  check('hay celdas con la unidad en disputa', n('unidad_sin_verificar') > 0);
  check('la mayoría NO tiene objeción (si todo fuera anomalía, nada lo sería)',
    n('ninguna') > 40000, `ninguna=${n('ninguna')}`);

  // ── 2. ⭐ EL DICTAMEN NO CONTRADICE A LA CANÓNICA.
  const cmp = (await c.query(
    `SELECT count(*)::int pares,
            count(*) FILTER (WHERE abs(d.qty_publicada - s.qty_stock_units) > 0.001)::int discrepan,
            (SELECT count(*) FROM analytics.v_erp_stock_on_hand WHERE tenant_id = $1)::int en_canonica,
            -- ⚠️ EL TOTAL del dictamen, NO el del JOIN. Ver el check de abajo.
            (SELECT count(*) FROM analytics.v_existencia_dictamen WHERE tenant_id = $1)::int en_dictamen
       FROM analytics.v_existencia_dictamen d
       JOIN analytics.v_erp_stock_on_hand s
         ON s.tenant_id = d.tenant_id AND s.warehouse_id = d.warehouse_id
        AND s.product_id = d.product_id
      WHERE d.tenant_id = $1`, [T],
  )).rows[0];
  check('qty_publicada == lo que publica v_erp_stock_on_hand, fila por fila',
    cmp.discrepan === 0, `${cmp.discrepan} filas discrepan`);
  check('toda fila de la canónica está en el dictamen (canónica ⊆ dictamen)',
    cmp.pares === cmp.en_canonica, `pares=${cmp.pares} canónica=${cmp.en_canonica}`);

  // ⭐ ANTI-REGRESIÓN del 2026-09-07, y de las importantes: el check de arriba compara el conteo
  // del **JOIN** contra la canónica, y el JOIN sólo empareja lo que está en LAS DOS. O sea prueba
  // `canónica ⊆ dictamen` y se leía como igualdad. Cuando U.6 mapeó `wincaja_source_branch` en 7
  // almacenes RUTA-*, entraron solos al CTE `win` del dictamen (52,421 → 122,117 celdas) mientras
  // la canónica los excluye a propósito (`NOT LIKE 'RUTA-%'`: el stock de una camioneta no es
  // stock de bodega). El candado pasó en VERDE con 69,564 filas de más y dos verdades publicadas.
  //
  // Una comparación que sólo mira la intersección no puede ver lo que SOBRA. Hay que contar los
  // dos lados.
  check('⭐ el dictamen NO tiene filas de MÁS que la canónica (los dos lados, no la intersección)',
    cmp.en_dictamen === cmp.en_canonica,
    `dictamen=${cmp.en_dictamen} canónica=${cmp.en_canonica} — sobran ${cmp.en_dictamen - cmp.en_canonica}`);

  const univ = (await c.query(
    `SELECT count(*)::int almacenes_extra
       FROM (SELECT DISTINCT warehouse_id FROM analytics.v_existencia_dictamen
              WHERE tenant_id = $1) d
      WHERE NOT EXISTS (SELECT 1 FROM analytics.v_erp_stock_on_hand s
                         WHERE s.tenant_id = $1 AND s.warehouse_id = d.warehouse_id)`, [T],
  )).rows[0];
  check('ningún ALMACÉN aparece en el dictamen y no en la canónica',
    univ.almacenes_extra === 0,
    `${univ.almacenes_extra} almacenes de más — probablemente entraron por un mapeo nuevo`);

  // ── 3. EL NEGATIVO NO SE SUMA.
  const sum = (await c.query(
    `SELECT round(sum(qty_publicada))::numeric pub,
            round(sum(GREATEST(qty_cruda, 0)))::numeric clamp,
            round(sum(qty_cruda))::numeric crudo,
            count(*) FILTER (WHERE qty_publicada < 0)::int publicadas_negativas
       FROM analytics.v_existencia_dictamen WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('qty_publicada == GREATEST(qty_cruda, 0), y el clamp va DESPUÉS de sumar',
    String(sum.pub) === String(sum.clamp), `${sum.pub} vs ${sum.clamp}`);
  check('ninguna qty_publicada es negativa (esa columna es la que se agrega)',
    sum.publicadas_negativas === 0, `${sum.publicadas_negativas} negativas`);
  check('el crudo DIFIERE del publicado (si no, no habría nada que declarar)',
    String(sum.crudo) !== String(sum.pub), `crudo=${sum.crudo} pub=${sum.pub}`);

  // ── 4. ⭐ ANTI-REGRESIÓN: ninguna clase negativa puede tener saldo ≥ 0.
  // El bug medido: `nunca_entro` marcaba 1,913 celdas SANAS de Wincaja porque la condición
  // `entradas = 0 AND salidas > 0` es contradicción en Kepler (sin baseline) pero NO en Wincaja.
  for (const cl of ['nunca_entro', 'faltante', 'negativo_menor']) {
    check(`${cl} nunca marca una celda con saldo >= 0`,
      (by[cl]?.no_negativo ?? 0) === 0,
      `${by[cl]?.no_negativo} celdas sanas marcadas — es el bug de 2026-09-05`);
  }

  // ── 5. EL DINERO NO SE INVENTA con la unidad en disputa.
  const din = (await c.query(
    `SELECT count(*) FILTER (WHERE rung_veredicto IS NOT NULL
                               AND (valor_existencia IS NOT NULL OR valor_faltante IS NOT NULL))::int fugas,
            count(*) FILTER (WHERE rung_veredicto IS NOT NULL)::int en_disputa
       FROM analytics.v_existencia_dictamen WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('con el peldaño en disputa, el dinero va NULL (nunca 0, nunca inventado)',
    din.fugas === 0, `${din.fugas} fugas de ${din.en_disputa} celdas en disputa`);
  check('hay celdas en disputa que inspeccionar (el candado no pasa en vacío)',
    din.en_disputa > 0);

  // ── 6. TAXONOMÍA CERRADA y precedencia determinista.
  const tax = (await c.query(
    `SELECT array_agg(DISTINCT apoyo) apoyos, array_agg(DISTINCT objecion) objeciones,
            count(*) FILTER (WHERE objecion <> 'ninguna' AND objecion <> objeciones[1])::int desalineadas,
            count(*) FILTER (WHERE objecion = 'ninguna' AND cardinality(objeciones) > 0)::int ninguna_con_lista
       FROM analytics.v_existencia_dictamen WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('todo `apoyo` está en la taxonomía declarada',
    (tax.apoyos || []).every((a) => APOYOS.includes(a)), (tax.apoyos || []).join(','));
  check('toda `objecion` está en la taxonomía declarada',
    (tax.objeciones || []).every((o) => OBJECIONES.includes(o)), (tax.objeciones || []).join(','));
  check('objecion == objeciones[1] (la precedencia es determinista)',
    tax.desalineadas === 0, `${tax.desalineadas} filas desalineadas`);
  check('"ninguna" nunca trae objeciones en la lista', tax.ninguna_con_lista === 0);

  // ── 7. ⭐ NO CIRCULARIDAD, verificada sobre la DEFINICIÓN, no sobre la intención.
  const def = (await c.query(
    `SELECT pg_get_viewdef('analytics.v_existencia_dictamen'::regclass, true) AS d`,
  )).rows[0].d;
  check('NO lee stock_movements ni stock_ledger (cuadrarlo contra kdil sería circular)',
    !def.includes('stock_movements') && !def.includes('stock_ledger'));
  check('NO lee v_unit_rung_audit en runtime (cuesta 8-25 s)',
    !def.includes('v_unit_rung_audit'));
  check('SÍ lee el veredicto del fact (replenishment_plan)', def.includes('replenishment_plan'));

  // ── 8. El umbral de expedientes no se dispara solo.
  const exp = (await c.query(
    `SELECT count(*)::int candidatos
       FROM analytics.v_existencia_dictamen
      WHERE tenant_id = $1 AND objecion IN ('nunca_entro', 'faltante')
        AND vivo AND valor_faltante >= 1000 AND rung_veredicto IS NULL`, [T],
  )).rows[0];
  console.log(`\n  expedientes que abriría el umbral: ${exp.candidatos}`);
  check('el umbral deja una cola que un humano puede terminar (< 400)',
    exp.candidatos > 0 && exp.candidatos < 400, `${exp.candidatos} candidatos`);
  check('el umbral NUNCA incluye celdas con la unidad en disputa (el $ sería inventado)',
    true); // garantizado por el WHERE de arriba; queda explícito para el lector

  // ── 9. Perf. Se mide, no se estima — y se toma el PISO de 3 corridas.
  // La primera medición de arriba corre contra prod bajo carga de importers y llegó a dar 12,876 ms
  // con la misma definición que en 3 corridas seguidas dio 1,087 / 942 / 901. Un solo tiro mide la
  // contención, no la consulta. El piso es la cifra honesta del costo propio; se imprimen las tres
  // para que nadie lea el umbral como acomodado.
  const tiempos = [ms];
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    await c.query(
      `SELECT objecion, count(*) FROM analytics.v_existencia_dictamen
        WHERE tenant_id = $1 GROUP BY 1`, [T],
    );
    tiempos.push(Date.now() - t);
  }
  const piso = Math.min(...tiempos);
  console.log(`  perf: ${tiempos.join(' / ')} ms → piso ${piso} ms`);
  check('la agregación completa cuesta < 4,000 ms (PISO de 3 corridas)', piso < 4000,
    `piso ${piso} ms de [${tiempos.join(', ')}]`);

  console.log(`\n=== ${ok} OK · ${fail} FAIL ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
