'use strict';
/**
 * `[MKT.6]` — **¿La activación movió la aguja? Lo que la medición tiene que impedir.**
 *
 * `commercial.v_promo_agreement_sellout` contesta, para cada canal de un acuerdo MKTN001, si la
 * venta de esos códigos en esa plaza subió respecto de una línea base del mismo largo. Lo que se
 * afirma acá NO es "la vista devuelve filas" —eso es lo fácil— sino **las seis maneras de mentir
 * con un número de resultado**, cada una rota a propósito:
 *
 *  1. **Dar por medido lo que no se midió.** Un acuerdo cuyos códigos no están ligados a ningún
 *     producto del catálogo no vendió cero: *no se puede mirar*. `sin_alcance` y `sin_venta` son
 *     estados distintos porque son conclusiones opuestas (ADR-056).
 *  2. **Publicar un bruto disfrazado de resultado.** Sin línea base no hay uplift: va NULL, no
 *     el bruto. Y con base en 0 no hay porcentaje: no es "+infinito%", es "no había base".
 *  3. **Mover la ventana.** La base son EXACTAMENTE los mismos días inmediatamente anteriores.
 *     Un día de más o de menos cambia el resultado, así que se prueba el BORDE: el día anterior
 *     al arranque de la base no entra, y el último día de la vigencia sí.
 *  4. **Sumar peras con manzanas.** `v_sellout_daily.units` viene cruda con su `unit_kind`. Si el
 *     alcance mezcla peldaños, las unidades van NULL con `unidad_estado='mixta'` (ADR-055/057).
 *     El dinero, que siempre es conmensurable, se sigue publicando.
 *  5. **Medir 2 de 6 códigos y que parezca el acuerdo entero.** `codigos_ligados/codigos_total`
 *     tiene que declarar cuánto se está mirando de verdad.
 *  6. **Comparar contra un número que se mueve solo.** Un "HASTA AGOTAR" no tiene fin: la ventana
 *     se corta HOY y `ventana_abierta` lo dice, en vez de que mañana la cifra cambie sin motivo
 *     visible.
 *
 * Y el candado transversal: la cifra de la ventana se compara contra un **recálculo
 * independiente** hecho acá con otra consulta. Un test que reusa el SQL de la vista se pone verde
 * aunque la vista esté mal — sólo prueba que Postgres es determinista.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-promo-sellout.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
let medidos = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); medidos++; if (!c) fail++; };
/** Lo que no se puede comprobar se DECLARA, no se pone en verde (ADR-056). */
const nm = (m) => console.log(`  ⚠️  NO MEDIDO — ${m}`);

/**
 * Marca propia: sin esto no se puede limpiar sin tocar acuerdos de gente de verdad.
 * ⚠️ `promo_agreements.folio` es varchar(20) y UNIQUE por tenant: una marca más larga se trunca
 * y el segundo acuerdo del smoke choca con el primero. Los 9 últimos dígitos del reloj alcanzan
 * (se repiten cada ~11 días) y dejan lugar al sufijo.
 */
const MARCA = `SMK${String(Date.now()).slice(-9)}`;
const creados = [];

const num = (v) => (v === null || v === undefined ? null : Number(v));
const money = (v) => (v === null ? null : Math.round(Number(v) * 100) / 100);

/** Inserta un acuerdo completo (carátula + códigos + canal) y devuelve sus ids. */
async function sembrarAcuerdo({ desde, hasta, hastaTexto = null, codigos, warehouseId, warehouseCode }) {
  const [ag] = await knex('commercial.promo_agreements')
    .insert({
      tenant_id: T,
      folio: `${MARCA}-${creados.length + 1}`,
      empresa: 'SMOKE',
      proveedor: `Proveedor ${MARCA}`.slice(0, 160),
      fecha_negociacion: desde,
      vigencia_desde: desde,
      vigencia_hasta: hasta,
      vigencia_hasta_texto: hastaTexto,
      mecanica: 'smoke',
      recurso: 'cedis_nota_credito',
      status: 'vigente',
      authorized_at: knex.fn.now(),
      authorized_by: T, // cualquier uuid: el CHECK exige presencia, no existencia
    })
    .returning('id');
  const agreementId = ag.id || ag;
  creados.push(agreementId);

  let pos = 0;
  for (const cod of codigos) {
    pos += 1;
    await knex('commercial.promo_agreement_codes').insert({
      tenant_id: T, agreement_id: agreementId, position: pos,
      code: cod.code, product_id: cod.product_id || null,
    });
  }

  const [ch] = await knex('commercial.promo_agreement_channels')
    .insert({
      tenant_id: T, agreement_id: agreementId,
      warehouse_id: warehouseId, warehouse_code: warehouseCode,
    })
    .returning('id');
  return { agreementId, channelId: ch.id || ch };
}

const fila = (channelId) =>
  knex('commercial.v_promo_agreement_sellout').where({ tenant_id: T, channel_id: channelId }).first();

(async () => {
  try {
    // ── [0] Preflight: sin las piezas de `[MKT.1]` esto no se puede medir ────────────────────
    const vista = (await knex.raw(`SELECT to_regclass('commercial.v_promo_agreement_sellout') AS t`)).rows[0]?.t;
    const base = (await knex.raw(`SELECT to_regclass('commercial.promo_agreement_channels') AS t`)).rows[0]?.t;
    if (!base || !vista) {
      nm(`faltan objetos (canales=${base || 'no'}, vista=${vista || 'no'}): ¿migraciones 20260928120000 / 20260928150000 pendientes?`);
      process.exit(2);
    }

    console.log('\n[0] La vista existe y no es un agujero de aislamiento');
    const meta = (await knex.raw(`
      SELECT c.reloptions,
             has_table_privilege('app_runtime','commercial.v_promo_agreement_sellout','SELECT') AS lee
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='commercial' AND c.relname='v_promo_agreement_sellout'`)).rows[0];
    // Sin security_invoker la vista corre como su dueño y el RLS del que consulta NO aplica.
    ok((meta.reloptions || []).includes('security_invoker=true'), 'la vista tiene security_invoker=true');
    ok(meta.lee === true, 'app_runtime puede leerla');

    // ── Fixture: un (plaza, producto) con historia densa y un solo peldaño ───────────────────
    const cand = (await knex.raw(`
      SELECT s.warehouse_code, s.product_id, min(s.sku) AS sku
        FROM analytics.v_sellout_daily s
        JOIN commercial.warehouses w
          ON w.tenant_id = s.tenant_id AND w.code = s.warehouse_code AND w.deleted_at IS NULL
       WHERE s.tenant_id = ?
       GROUP BY 1, 2
      HAVING count(*) >= 40 AND count(DISTINCT s.unit_kind) = 1
       ORDER BY count(*) DESC
       LIMIT 1`, [T])).rows[0];
    if (!cand) {
      nm('no hay ningún (plaza, producto) con >=40 días de sell-out: sin historia no se puede medir uplift');
      process.exit(2);
    }
    const wh = await knex('commercial.warehouses')
      .select('id').where({ tenant_id: T, code: cand.warehouse_code }).whereNull('deleted_at').first();

    // Ventana de 14 días que cae dentro de la historia, con otros 14 antes para la base.
    const rango = (await knex.raw(
      `SELECT min(business_date)::date AS d0, max(business_date)::date AS d1
         FROM analytics.v_sellout_daily
        WHERE tenant_id = ? AND warehouse_code = ? AND product_id = ?`,
      [T, cand.warehouse_code, cand.product_id])).rows[0];
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    const dias = 14;
    const desdeD = new Date(rango.d1); desdeD.setDate(desdeD.getDate() - (dias - 1) - 7);
    const desde = iso(desdeD);
    const hastaD = new Date(desdeD); hastaD.setDate(hastaD.getDate() + dias - 1);
    const hasta = iso(hastaD);
    console.log(`\n  fixture: ${cand.warehouse_code} × ${cand.sku} · ventana ${desde}..${hasta} (${dias} d)`);

    const A = await sembrarAcuerdo({
      desde, hasta,
      codigos: [{ code: cand.sku, product_id: cand.product_id }],
      warehouseId: wh.id, warehouseCode: cand.warehouse_code,
    });

    // ── [1] ⭐ La cifra cuadra con un recálculo INDEPENDIENTE ────────────────────────────────
    console.log('\n[1] ⭐ La venta de la ventana coincide con un recálculo hecho aparte');
    const f = await fila(A.channelId);
    ok(!!f, 'la vista devuelve la fila del canal sembrado');

    // Otra consulta, escrita distinto a propósito: si reusara el SQL de la vista, este bloque
    // se pondría verde aunque la vista estuviera mal.
    const esperado = (await knex.raw(`
      SELECT round(sum(monto)::numeric, 2) AS monto, count(DISTINCT business_date)::int AS dias
        FROM analytics.v_sellout_daily
       WHERE tenant_id = ? AND warehouse_code = ? AND product_id = ?
         AND business_date >= ?::date AND business_date <= ?::date`,
      [T, cand.warehouse_code, cand.product_id, desde, hasta])).rows[0];
    ok(money(f.monto_ventana) === money(esperado.monto),
      `monto_ventana = ${money(f.monto_ventana)} == recálculo independiente ${money(esperado.monto)}`);
    ok(num(f.dias_con_venta) === num(esperado.dias),
      `dias_con_venta = ${f.dias_con_venta} == ${esperado.dias}`);
    ok(num(f.dias_ventana) === dias, `dias_ventana = ${f.dias_ventana} (inclusivo en los dos extremos)`);

    // ── [2] ⭐ El BORDE de la línea base ─────────────────────────────────────────────────────
    console.log('\n[2] ⭐ La línea base son EXACTAMENTE los N días previos, ni uno más');
    const baseEsp = (await knex.raw(`
      SELECT round(sum(monto)::numeric, 2) AS monto
        FROM analytics.v_sellout_daily
       WHERE tenant_id = ? AND warehouse_code = ? AND product_id = ?
         AND business_date >= (?::date - ?::int) AND business_date <= (?::date - 1)`,
      [T, cand.warehouse_code, cand.product_id, desde, dias, desde])).rows[0];
    ok(money(f.monto_baseline) === money(baseEsp.monto),
      `monto_baseline = ${money(f.monto_baseline)} == recálculo ${money(baseEsp.monto)}`);

    // NEGATIVA del borde: el día ANTERIOR al arranque de la base no puede estar contado.
    const unDiaMas = (await knex.raw(`
      SELECT round(sum(monto)::numeric, 2) AS monto
        FROM analytics.v_sellout_daily
       WHERE tenant_id = ? AND warehouse_code = ? AND product_id = ?
         AND business_date >= (?::date - ?::int - 1) AND business_date <= (?::date - 1)`,
      [T, cand.warehouse_code, cand.product_id, desde, dias, desde])).rows[0];
    if (money(unDiaMas.monto) === money(baseEsp.monto)) {
      nm('ese día extra no tuvo venta, así que el borde no se puede distinguir con este fixture');
    } else {
      ok(money(f.monto_baseline) !== money(unDiaMas.monto),
        `la base NO incluye el día previo extra (${money(unDiaMas.monto)} ≠ ${money(f.monto_baseline)})`);
    }

    // ── [3] El uplift es una resta, y el % sólo con denominador > 0 ──────────────────────────
    console.log('\n[3] Uplift: resta explícita, y nada de dividir entre cero');
    if (f.monto_ventana !== null && f.monto_baseline !== null) {
      ok(money(f.uplift_monto) === money(Number(f.monto_ventana) - Number(f.monto_baseline)),
        `uplift_monto = ${money(f.uplift_monto)} == ventana − base`);
      if (Number(f.monto_baseline) > 0) {
        const pct = Math.round(((f.monto_ventana - f.monto_baseline) / f.monto_baseline) * 10000) / 100;
        ok(Math.abs(Number(f.uplift_pct) - pct) < 0.02, `uplift_pct = ${f.uplift_pct}% == ${pct}%`);
      } else {
        ok(f.uplift_pct === null, 'base en 0 → uplift_pct NULL (no un infinito publicado)');
      }
      ok(f.medicion === 'medida', `medicion = '${f.medicion}'`);
    } else {
      nm('el fixture no tiene ventana+base simultáneas: el uplift no se puede comprobar acá');
    }

    // ── [4] ⭐ NEGATIVA: sin alcance NO es "vendió cero" ─────────────────────────────────────
    console.log('\n[4] ⭐ "No se puede medir" y "vendió cero" son estados DISTINTOS');
    const B = await sembrarAcuerdo({
      desde, hasta,
      // Código sin product_id: existe en el papel, no está ligado al catálogo.
      codigos: [{ code: 'SIN-LIGAR' }],
      warehouseId: wh.id, warehouseCode: cand.warehouse_code,
    });
    const fb = await fila(B.channelId);
    ok(fb.medicion === 'sin_alcance', `códigos sin ligar → medicion='${fb.medicion}' (no 'sin_venta')`);
    ok(fb.monto_ventana === null, 'y el monto va NULL, nunca 0');
    ok(num(fb.codigos_total) === 1 && num(fb.codigos_ligados) === 0,
      `cobertura declarada: ${fb.codigos_ligados} de ${fb.codigos_total} códigos ligados`);

    // Mismo producto, pero una ventana donde NO hubo venta: eso sí es 'sin_venta'.
    const C = await sembrarAcuerdo({
      desde: '2019-01-01', hasta: '2019-01-14',
      codigos: [{ code: cand.sku, product_id: cand.product_id }],
      warehouseId: wh.id, warehouseCode: cand.warehouse_code,
    });
    const fc = await fila(C.channelId);
    ok(fc.medicion === 'sin_venta', `ventana sin ventas → medicion='${fc.medicion}'`);
    ok(fc.uplift_monto === null && fc.uplift_pct === null, 'sin venta no se publica uplift');

    // ── [5] Cobertura parcial: 1 de 3 códigos ligados ───────────────────────────────────────
    console.log('\n[5] Medir 2 de 6 códigos no puede parecer el acuerdo entero');
    const D = await sembrarAcuerdo({
      desde, hasta,
      codigos: [
        { code: cand.sku, product_id: cand.product_id },
        { code: 'OTRO-1' },
        { code: 'OTRO-2' },
      ],
      warehouseId: wh.id, warehouseCode: cand.warehouse_code,
    });
    const fd = await fila(D.channelId);
    ok(num(fd.codigos_total) === 3 && num(fd.codigos_ligados) === 1,
      `codigos_ligados=${fd.codigos_ligados} / codigos_total=${fd.codigos_total}`);
    ok(fd.medicion === 'medida' || fd.medicion === 'sin_baseline',
      `con al menos un código ligado sí se mide (medicion='${fd.medicion}')`);

    // ── [6] "HASTA AGOTAR": la ventana se corta HOY y se declara ────────────────────────────
    console.log('\n[6] Una vigencia abierta se corta hoy, y lo dice');
    const E = await sembrarAcuerdo({
      desde, hasta: null, hastaTexto: 'HASTA AGOTAR',
      codigos: [{ code: cand.sku, product_id: cand.product_id }],
      warehouseId: wh.id, warehouseCode: cand.warehouse_code,
    });
    const fe = await fila(E.channelId);
    ok(fe.ventana_abierta === true, 'ventana_abierta = true');
    ok(iso(fe.hasta) === iso(new Date()), `hasta = hoy (${iso(fe.hasta)})`);
    ok(num(fe.dias_ventana) > dias, `la ventana abierta es más larga que la cerrada (${fe.dias_ventana} > ${dias})`);

    // ── [7] Unidades: sólo si son conmensurables ────────────────────────────────────────────
    console.log('\n[7] Las unidades no se suman a ciegas');
    const kinds = (await knex.raw(`
      SELECT count(DISTINCT unit_kind)::int AS k
        FROM analytics.v_sellout_daily
       WHERE tenant_id = ? AND warehouse_code = ? AND product_id = ?
         AND business_date BETWEEN ?::date AND ?::date`,
      [T, cand.warehouse_code, cand.product_id, desde, hasta])).rows[0].k;
    if (kinds === 1) {
      ok(f.unidad_estado === 'unica' && f.units_ventana !== null,
        `un solo peldaño → unidad_estado='${f.unidad_estado}' y units_ventana publicado`);
      nm('no hay en este fixture un alcance con peldaños MEZCLADOS: el caso `mixta` queda sin ejercer');
    } else {
      ok(f.unidad_estado === 'mixta' && f.units_ventana === null,
        'peldaños mezclados → units NULL con unidad_estado=mixta');
    }

    // ── [8] ⭐ RLS: la vista no puede ser la puerta de atrás ─────────────────────────────────
    console.log('\n[8] ⭐ RLS: sin tenant en contexto no se ve nada');
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL ROLE app_runtime`);
      const sinTenant = await trx.raw(`SELECT count(*)::int AS n FROM commercial.v_promo_agreement_sellout`);
      ok(sinTenant.rows[0].n === 0, `app_runtime sin app.tenant_id ve 0 filas (vio ${sinTenant.rows[0].n})`);
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const conTenant = await trx.raw(`SELECT count(*)::int AS n FROM commercial.v_promo_agreement_sellout`);
      ok(conTenant.rows[0].n > 0, `con el tenant puesto sí ve (${conTenant.rows[0].n} filas)`);
      const otro = '00000000-0000-0000-0000-0000000000ff';
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [otro]);
      const ajeno = await trx.raw(`SELECT count(*)::int AS n FROM commercial.v_promo_agreement_sellout`);
      ok(ajeno.rows[0].n === 0, `con un tenant ajeno ve 0 (vio ${ajeno.rows[0].n})`);
      await trx.rollback(new Error('__fin_rls__'));
    }).catch((e) => { if (e.message !== '__fin_rls__') throw e; });

    // ── [9] El diagnóstico de captura: un `sin_alcance` mudo es inútil ──────────────────────
    // Es la MISMA consulta que corre `PromoSelloutService.coberturaDeCodigos`. Se ejerce acá
    // porque toca Postgres; la capa HTTP queda declarada abajo como no medida.
    console.log('\n[9] "sin_alcance" tiene que decir si el arreglo está a un clic');
    const diag = (await knex.raw(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE k.product_id IS NOT NULL)::int AS ligados,
             count(*) FILTER (
               WHERE k.product_id IS NULL AND EXISTS (
                 SELECT 1 FROM catalog.products p
                  WHERE p.tenant_id = k.tenant_id AND p.deleted_at IS NULL
                    AND btrim(p.sku) = btrim(k.code)))::int AS resolubles
        FROM commercial.promo_agreement_codes k
       WHERE k.tenant_id = ? AND k.agreement_id = ?`, [T, B.agreementId])).rows[0];
    ok(num(diag.total) === 1 && num(diag.ligados) === 0,
      `el acuerdo sin ligar reporta ${diag.ligados} de ${diag.total} ligados`);
    ok(num(diag.resolubles) + num(diag.ligados) <= num(diag.total),
      'resolubles + ligados nunca excede el total (las tres categorías particionan)');

    // El código 'SIN-LIGAR' no existe en el catálogo → no es resoluble, y eso también se declara.
    ok(num(diag.resolubles) === 0, 'un código inventado NO cuenta como resoluble');

    // ── [10] La conciliación: una fuente vacía NO es un cero acreditado ─────────────────────
    console.log('\n[10] ⭐ Notas de crédito del proveedor: fuente vacía ≠ $0 acreditado');
    const espejo = (await knex.raw(`SELECT to_regclass('analytics.erp_purchase_adjustments') AS t`)).rows[0]?.t;
    if (!espejo) {
      nm('analytics.erp_purchase_adjustments no existe en esta base: la conciliación no se puede medir');
    } else {
      const n = num((await knex.raw(
        `SELECT count(*)::int AS n FROM analytics.erp_purchase_adjustments WHERE tenant_id = ?`, [T],
      )).rows[0].n);
      ok(true, `el espejo existe y tiene ${n} fila(s) para el tenant`);
      if (n === 0) {
        // Éste es el camino que el servicio DECLARA como `fuente_vacia`. Que esté vacío no es
        // una falla del código: es la razón por la que el código no puede devolver 0.
        nm('el espejo está VACÍO → la conciliación queda CONSTRUIDA pero NO MEDIDA contra datos reales');
      } else {
        const cruce = (await knex.raw(
          `SELECT count(*)::int AS n FROM analytics.erp_purchase_adjustments
            WHERE tenant_id = ? AND upper(btrim(proveedor_nombre)) = upper(btrim(?))
              AND adjustment_date >= ?::date AND adjustment_date <= ?::date`,
          [T, `Proveedor ${MARCA}`, desde, hasta])).rows[0].n;
        ok(num(cruce) === 0, 'un proveedor inventado no cruza con ninguna nota de crédito real');
      }
    }

    // La capa HTTP no se ejerce acá y se DECLARA: un smoke que calla lo que no probó se lee
    // igual que uno que lo probó (ADR-044 + ADR-056).
    nm('la capa HTTP (/commercial/promo-sellout/*) NO se ejerció: hace falta la API levantada');

  } catch (e) {
    console.error('\n  💥', e.message);
    fail++;
  } finally {
    // Limpieza por MARCA: el CASCADE de las FK se lleva códigos, canales y archivos.
    if (creados.length) {
      await knex('commercial.promo_agreements').where({ tenant_id: T }).whereIn('id', creados).del();
    }
    console.log(`\n  ${fail ? '❌' : '✅'} ${medidos - fail}/${medidos} aserciones · ${fail} fallas`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }
})();
