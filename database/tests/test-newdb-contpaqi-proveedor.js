/* eslint-disable no-console */
/**
 * `[CP.8.35]` — Candado del **resolvedor de proveedor**: el paso que faltaba para que el puente
 * emita su primera póliza.
 *
 * Tres cosas distintas, porque fallan por motivos distintos:
 *   1. las reglas puras (normalizar, negarse ante ambigüedad, negarse ante veredicto sin RFC);
 *   2. ⭐ la **medición contra prod con placebo** — un pareo por nombre sin placebo no se puede
 *      citar (regla del proyecto);
 *   3. ⛔ la **prueba negativa del rubro**: sin honrar `cuenta_prefijo` la resolución se desploma.
 *      Eso no es una curiosidad: fue el defecto real que tuvo esto en 1.4 %.
 *
 * Lee prod en SOLO LECTURA.
 */
const path = require('path');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const SRC = path.resolve(__dirname, '../../libs/finance/src/lib/contpaqi');
const {
  normalizarNombre, construirIndice, resolverProveedor, VEREDICTOS_USABLES,
} = require(path.join(SRC, 'proveedor-resolver.ts'));

const MEGA = '00000000-0000-0000-0000-00000000d01c';
let ok = 0; let fail = 0; let nm = 0;
const check = (c, m) => { if (c) { ok += 1; console.log(`  ✓ ${m}`); } else { fail += 1; console.log(`  ✗ ${m}`); } };
const lanza = (fn, m) => { try { fn(); check(false, `${m} (no lanzó)`); } catch { check(true, m); } };

const CTA = (cuenta, nombre, veredicto = 'confirmado', rfc = 'XAXX010101000') =>
  ({ cuenta, proveedor_nombre: nombre, cuenta_nombre: nombre, veredicto, rfc });

(async () => {
  console.log('\n[1] Normalizar: el banco escribe el mismo proveedor de cualquier forma');
  const rosa = ['Distribuidora de la Rosa', 'DISTRIBUIDORA DE LA ROSA', 'Distribuidora de la Rosa SA de CV'];
  const n = rosa.map(normalizarNombre);
  check(new Set(n).size === 1, `las 3 formas de "Distribuidora de la Rosa" dan una sola: "${n[0]}"`);
  // ⛔ La puntuación intra-palabra se BORRA. Convertirla en espacio parte la palabra y deja de parear.
  check(normalizarNombre("CANEL'S") === 'CANELS', `CANEL'S → ${normalizarNombre("CANEL'S")} (no "CANEL S")`);
  check(normalizarNombre('Hersheys Mexico') === normalizarNombre('Hersheys de Mexico'),
    'con y sin "de México" son el mismo nombre');

  console.log('\n[2] Se niega a adivinar');
  const idx = construirIndice([
    CTA('2120000108', 'MONDELEZ'),
    CTA('2120000209', 'DULCES LAS DELICIAS'),
    CTA('5010000108', 'MONDELEZ'),
  ], '2120');
  check(resolverProveedor(idx, 'Mondelez').veredicto === 'resuelto', 'resuelve un nombre con UNA cuenta en el rubro');
  check(resolverProveedor(idx, 'Mondelez').cuenta === '2120000108',
    '⭐ elige la cuenta del rubro 2120, NO la 5010 del mismo nombre');

  const amb = construirIndice([CTA('2120000108', 'MONDELEZ'), CTA('2120000999', 'MONDELEZ')], '2120');
  const r2 = resolverProveedor(amb, 'Mondelez');
  check(r2.veredicto === 'ambiguo' && r2.cuenta === null,
    '⛔ dos cuentas del MISMO rubro → `ambiguo` y cuenta null: elegir una sería inventar');

  const debil = construirIndice([CTA('2120000108', 'MONDELEZ', 'solo_nombre', null)], '2120');
  const r3 = resolverProveedor(debil, 'Mondelez');
  check(r3.veredicto === 'veredicto_debil' && r3.cuenta === null,
    '⛔ un veredicto sin RFC NO se usa, aunque haya pareado exacto');
  check(!VEREDICTOS_USABLES.has('solo_nombre') && !VEREDICTOS_USABLES.has('sin_proveedor'),
    'los veredictos usables son sólo los que llevan RFC');

  check(resolverProveedor(idx, '').veredicto === 'sin_concepto', 'sin concepto se DECLARA, no se parea');
  check(resolverProveedor(idx, 'NO EXISTE ESTE PROVEEDOR').veredicto === 'sin_pareo', 'sin pareo se declara');
  // ⛔ Nada de parecidos: un prefijo que casara con otro nombre cargaría a la cuenta equivocada.
  check(resolverProveedor(idx, 'MONDELEZ INTERNACIONAL').veredicto === 'sin_pareo',
    '⛔ NO parea por subcadena: "MONDELEZ INTERNACIONAL" no es "MONDELEZ"');
  lanza(() => construirIndice([], ''), '⛔ construir el índice SIN rubro lanza: olvidarlo costó 69 pp');

  console.log('\n[2b] `[CP.8.36]` El alias que afirmó una persona le gana a lo derivado');
  const conAlias = construirIndice(
    [CTA('2120000108', 'MONDELEZ')],
    '2120',
    [{ alias_normalizado: 'HERSHEYS', cuenta: '2120009999' }],
  );
  const a1 = resolverProveedor(conAlias, 'Hersheys Mexico');
  check(a1.veredicto === 'resuelto' && a1.cuenta === '2120009999',
    '⭐ un nombre que el padrón NO tiene se resuelve por alias');
  check(a1.veredicto_padron === 'alias_confirmado', 'y queda marcado como alias, no como derivado');

  const pisa = construirIndice(
    [CTA('2120000108', 'MONDELEZ')],
    '2120',
    [{ alias_normalizado: 'MONDELEZ', cuenta: '2120007777' }],
  );
  check(resolverProveedor(pisa, 'Mondelez').cuenta === '2120007777',
    '⭐ el alias GANA sobre el padrón: lo que alguien confirmó manda sobre lo derivado');

  // ⛔ Un alias a otro rubro sería una puerta trasera al defecto que costó 69 pp.
  const fuera = construirIndice(
    [CTA('2120000108', 'MONDELEZ')],
    '2120',
    [{ alias_normalizado: 'HERSHEYS', cuenta: '5010009999' }],
  );
  check(resolverProveedor(fuera, 'Hersheys').veredicto === 'sin_pareo',
    '⛔ un alias que apunta FUERA del rubro se ignora: no hay puerta trasera al 5010');

  console.log('\n[3] ⭐ Contra prod, con control de placebo');
  const url = process.env.DATABASE_URL_NEW;
  if (!url) {
    nm += 1;
    console.log('  [NO MEDIDO] sin DATABASE_URL_NEW');
  } else {
    const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });
    try {
      const padron = await knex('contpaqi.supplier_accounts').where({ tenant_id: MEGA })
        .select('cuenta', 'proveedor_nombre', 'cuenta_nombre', 'veredicto', 'rfc');
      const movs = await knex('finance.bank_movements as m')
        .join('finance.movement_categories as c', 'c.id', 'm.category_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
        .select('m.concept', 'm.amount_out')
        .where('m.tenant_id', MEGA).whereNull('m.deleted_at').where('m.amount_out', '>', 0)
        .where('c.code', 'compra_mercancia').whereNotNull('ba.contpaqi_cuenta')
        .whereRaw(`to_char(m.movement_date,'YYYY-MM') = '2026-01'`);

      if (!movs.length || !padron.length) {
        nm += 1;
        console.log('  [NO MEDIDO] sin movimientos o sin padrón en este destino');
      } else {
        const conRubro = construirIndice(padron, '2120');
        const resueltos = movs.filter((m) => resolverProveedor(conRubro, m.concept).veredicto === 'resuelto');
        const pct = (resueltos.length / movs.length) * 100;
        check(pct > 50,
          `⭐ resuelve ${resueltos.length} de ${movs.length} (${pct.toFixed(1)}%) de compra_mercancia de enero`);

        // ⭐ PLACEBO: el mismo método contra un padrón con los nombres INVERTIDOS. Si parea algo,
        // el resolvedor está pareando ruido y su porcentaje no se puede citar.
        const falso = padron.map((p) => ({
          ...p,
          proveedor_nombre: String(p.proveedor_nombre ?? '').split('').reverse().join(''),
          cuenta_nombre: String(p.cuenta_nombre ?? '').split('').reverse().join(''),
        }));
        const idxFalso = construirIndice(falso, '2120');
        const ruido = movs.filter((m) => resolverProveedor(idxFalso, m.concept).veredicto === 'resuelto');
        check(ruido.length === 0,
          `⭐ PLACEBO: contra el padrón invertido parea ${ruido.length} (debe ser 0)`);

        // ⛔ PRUEBA NEGATIVA DEL RUBRO, medida sobre el dato real: ¿cuántos nombres del padrón
        // viven en MÁS de un rubro? Cada uno de ésos sale `ambiguo` si no se honra el prefijo, y
        // ésa fue la diferencia entre 1.4 % y 70.4 %. No se simula la versión rota: se mide la
        // condición que la rompía.
        const otros = ['5010', '5020'].map((p) => construirIndice(padron, p));
        const compartidos = [...conRubro.porNombre.keys()]
          .filter((n) => otros.some((o) => o.porNombre.has(n)));
        check(compartidos.length > 0,
          `⛔ ${compartidos.length} nombres existen en 2120 Y en 5010/5020 — por eso el rubro no es opcional`);
        const afectados = movs.filter((m) => {
          const r = resolverProveedor(conRubro, m.concept);
          return r.veredicto === 'resuelto' && compartidos.includes(
            require(path.join(SRC, 'proveedor-resolver.ts')).normalizarNombre(m.concept));
        });
        check(afectados.length > 0,
          `⛔ y ${afectados.length} de los ${resueltos.length} resueltos son de esos nombres: sin rubro se perderían`);

        /**
         * ⭐⭐ [4] **Cruce de DOS implementaciones del mismo hecho**, que es como aparecen los
         * bugs en este repo:
         *   A = este resolvedor: el **concepto del banco** → cuenta `2120*`.
         *   B = el camino de `[CP.8.23]`: el **pago registrado en Kepler** trae el nombre del
         *       proveedor, y ese nombre se resuelve contra el mismo padrón.
         *
         * Son dos fuentes independientes. Si contradicen, una está mal — y hay que verlo
         * **antes** de que salga en una póliza, no al cuadrar la balanza.
         *
         * ⚠️ El pareo A↔B es por (fecha, importe exacto) y sólo cuando hay **un** candidato:
         * dos pagos del mismo importe el mismo día no se desempatan, y forzarlo inventaría la
         * contradicción o la taparía.
         */
        const pagos = await knex('analytics.erp_supplier_payments')
          .select('proveedor_nombre', 'monto', knex.raw(`to_char(pago_date,'YYYY-MM-DD') as f`))
          .whereRaw(`to_char(pago_date,'YYYY-MM') = '2026-01'`)
          .catch(() => []);
        if (!pagos.length) {
          nm += 1;
          console.log('  [NO MEDIDO] `analytics.erp_supplier_payments` vacía: el cruce A↔B no corre');
        } else {
          const porClave = new Map();
          for (const p of pagos) {
            const key = `${p.f}|${Math.round(Number(p.monto) * 100)}`;
            if (!porClave.has(key)) porClave.set(key, []);
            porClave.get(key).push(p);
          }
          const conFecha = await knex('finance.bank_movements as m')
            .join('finance.movement_categories as c', 'c.id', 'm.category_id')
            .join('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
            .select('m.concept', 'm.amount_out', knex.raw(`to_char(m.movement_date,'YYYY-MM-DD') as f`))
            .where('m.tenant_id', MEGA).whereNull('m.deleted_at').where('m.amount_out', '>', 0)
            .where('c.code', 'compra_mercancia').whereNotNull('ba.contpaqi_cuenta')
            .whereRaw(`to_char(m.movement_date,'YYYY-MM') = '2026-01'`);
          let de = 0; let contra = 0;
          const choques = [];
          for (const m of conFecha) {
            const a = resolverProveedor(conRubro, m.concept);
            if (a.veredicto !== 'resuelto') continue;
            const cand = porClave.get(`${m.f}|${Math.round(Number(m.amount_out) * 100)}`);
            if (!cand || cand.length !== 1) continue;
            const b = resolverProveedor(conRubro, cand[0].proveedor_nombre);
            if (b.veredicto !== 'resuelto') continue;
            de += 1;
            if (b.cuenta !== a.cuenta) {
              contra += 1;
              choques.push(`"${m.concept}"→${a.cuenta} vs "${cand[0].proveedor_nombre}"→${b.cuenta}`);
            }
          }
          if (!de) {
            nm += 1;
            console.log('  [NO MEDIDO] ningún movimiento pudo cruzarse contra un pago de Kepler');
          } else {
            const acuerdo = ((de - contra) / de) * 100;
            check(acuerdo >= 95,
              `⭐⭐ las DOS vías (banco y pago de Kepler) coinciden en ${de - contra} de ${de} (${acuerdo.toFixed(1)}%)`);
            // ⚠️ No se exige CERO contradicciones: un nombre comercial contra el nombre legal
            // puede ser el mismo proveedor con dos cuentas en el catálogo de ContPAQi, y eso se
            // arregla allá, no acá. Lo que no se tolera es que crezcan.
            check(contra <= 2,
              `⛔ contradicciones: ${contra}${choques.length ? ' — ' + choques.slice(0, 2).join(' · ') : ''}`);
          }
        }

        // `[CP.8.36]` La tabla de alias: existe, y la base impide dos cuentas para un mismo texto.
        const tabla = await knex('information_schema.tables').select('table_name')
          .where({ table_schema: 'contpaqi', table_name: 'supplier_aliases' }).first();
        if (!tabla) {
          nm += 1;
          console.log('  [NO MEDIDO] la migración 20261010104218 todavía no se aplicó a este destino');
        } else {
          const idxs = await knex.raw(
            `SELECT indexdef FROM pg_indexes
              WHERE schemaname = 'contpaqi' AND tablename = 'supplier_aliases'
                AND indexname = 'supplier_aliases_uno_por_texto'`);
          check(idxs.rows.length === 1 && /UNIQUE/i.test(idxs.rows[0].indexdef),
            '⛔ la base impide DOS cuentas activas para el mismo texto: elegir no es del resolvedor');
          const pend = await knex('contpaqi.supplier_aliases').count({ n: '*' }).first();
          check(Number(pend.n) >= 0, `alias confirmados hasta hoy: ${pend.n}`);
        }

        // Ninguna cuenta devuelta puede salirse del rubro pedido.
        const fuera = resueltos
          .map((m) => resolverProveedor(conRubro, m.concept).cuenta)
          .filter((c) => !String(c).startsWith('2120'));
        check(fuera.length === 0, `ninguna cuenta resuelta se sale de 2120* (${fuera.length} fuera)`);
      }
    } finally {
      await knex.destroy();
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.35 resolvedor de proveedor: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  console.log(`\n❌ CP.8.35 resolvedor de proveedor: ${ok} ✓ / ${fail + 1} ✗\n`);
  process.exit(1);
});
