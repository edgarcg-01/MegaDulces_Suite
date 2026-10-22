// [E.23] Replay: ¿la cotización sale igual que el pedido que Kepler registró?
//
// Re-cotiza con el MOTOR REAL (`quote-pricing.service.ts`, empaquetado con esbuild a un temporal:
// no es un doble, corre su SQL) cada renglón de los pedidos de telemarketing de Kepler (`U-D-40`,
// `c27 = 'TELEMARK'`) y guarda lado a lado lo que Kepler cobró y lo que cotiza la Suite.
// `analiza.js` lo clasifica renglón por renglón y pedido por pedido.
//
// ⛔ SÓLO LECTURA contra prod: sesión psql por ssh → kubectl exec con
// `default_transaction_read_only = on` (ver `psql-session.js`, que trae sus controles). Un renglón
// cuesta ~0.3 s: un día de telemarketing (~2,000 renglones) tarda ~8 min. No es un backend local:
// no abre puertos ni escribe nada.
//
// Uso (desde la raíz del repo):
//   node scripts/kepler/replay-cotizacion/replay.js [dias=1] [salida.json]
//   node scripts/kepler/replay-cotizacion/replay.js <universo.json> [salida.json]   ← re-cotiza los MISMOS
//     renglones de una corrida anterior: así se mide un cambio del motor antes/después sin que el
//     universo se mueva (lo que sí puede moverse es el precio del ERP entre corridas).
//   node scripts/kepler/replay-cotizacion/analiza.js <salida.json>
//   REPLAY_MOTOR_REF=<commit> node .../replay.js <universo.json> <salida.json>   ← el motor de ESE commit
//     (antes/después de un cambio del motor sobre el mismo universo y la misma entrada)
//
// ⭐ [E.28] La entrada es la PRESENTACIÓN capturada (kdm2.c55, cantidad c51), no la unidad guardada
// (c11, c9): Kepler cobra la presentación que se captura y guarda el precio por unidad base. Pasarle
// la base al motor inventó en E.23 un «prorrateo automático» que no existe.
const path = require('path');
const os = require('os');
const fs = require('fs');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CONGELADO = /\.json$/i.test(process.argv[2] || '') ? process.argv[2] : null;
const DIAS = CONGELADO ? JSON.parse(fs.readFileSync(CONGELADO, 'utf8')).dias : Number(process.argv[2] || 1);
const SALIDA = process.argv[3] || path.join(os.tmpdir(), `replay-cotizacion-${DIAS}d.json`);

function motorEmpaquetado() {
  // Dentro de node_modules/.cache (ignorado por git): desde ahí el require del paquete sube solo a
  // los node_modules del repo para @nestjs/common y knex.
  const dir = path.join(RAIZ, 'node_modules', '.cache', 'replay-cotizacion');
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, 'platform-core-stub.js');
  // El motor sólo usa la conexión que se le pasa y el tenant: el resto de platform-core no hace falta.
  fs.writeFileSync(stub, 'class TenantKnexService {}\nclass TenantContextService {}\nclass ScopeService {}\nmodule.exports = { TenantKnexService, TenantContextService, ScopeService };\n');
  const ref = process.env.REPLAY_MOTOR_REF;
  const salida = path.join(dir, ref ? `motor-${ref.replace(/[^w.-]/g, '_')}.cjs` : 'motor.cjs');
  const fuente = 'libs/commercial/src/lib/commercial-quotes/quote-pricing.service.ts';
  const entrada = ref
    ? { stdin: { contents: require('child_process').execSync(`git show ${ref}:${fuente}`, { cwd: RAIZ, maxBuffer: 1e8 }).toString(),
        resolveDir: path.join(RAIZ, path.dirname(fuente)), loader: 'ts', sourcefile: 'motor.ts' } }
    : { entryPoints: [path.join(RAIZ, fuente)] };
  require(path.join(RAIZ, 'node_modules', 'esbuild')).buildSync({
    ...entrada,
    bundle: true, platform: 'node', format: 'cjs', outfile: salida, logLevel: 'warning',
    tsconfig: path.join(RAIZ, 'tsconfig.base.json'),
    external: ['@nestjs/common', 'knex'],
    alias: { '@megadulces/platform-core': stub },
  });
  return salida;
}

const UNIVERSO = `
  WITH h AS (
    SELECT btrim(sucursal) suc, c1, c2, c3, (c4)::int c4, (c5)::int c5, btrim(c6) folio, btrim(c11) estatus,
      (c9)::date fecha, btrim(c10) cliente,
      nullif(regexp_replace(coalesce(c13::text,''),'[^0-9.-]','','g'),'')::numeric h13,
      nullif(regexp_replace(coalesce(c14::text,''),'[^0-9.-]','','g'),'')::numeric iva,
      nullif(regexp_replace(coalesce(c15::text,''),'[^0-9.-]','','g'),'')::numeric ieps,
      nullif(regexp_replace(coalesce(c16::text,''),'[^0-9.-]','','g'),'')::numeric importe,
      coalesce(nullif(regexp_replace(coalesce(c19::text,''),'[^0-9.-]','','g'),'')::numeric,0) pct
    FROM kepler_ods.kdm1
    WHERE c2='U' AND c3='D' AND (c4)::int = 40 AND btrim(c27) = 'TELEMARK'
      AND (c9)::date >= current_date - ${DIAS}),
  l AS (
    SELECT h.suc, h.folio, h.c5 serie, h.estatus, h.fecha::text fecha, h.cliente, h.h13, h.iva, h.ieps, h.importe, h.pct,
      btrim(x.c8) sku, (x.c9)::numeric qty, upper(btrim(x.c11)) un, (x.c12)::numeric pu, (x.c13)::numeric imp,
      upper(btrim(coalesce(x.c55::text, ''))) pres,
      nullif(regexp_replace(coalesce(x.c51::text,''),'[^0-9.-]','','g'),'')::numeric pedida,
      nullif(regexp_replace(coalesce(x.c66::text,''),'[^0-9.-]','','g'),'')::numeric lista,
      coalesce((x.c17)::numeric,0) t_iva, coalesce((x.c18)::numeric,0) t_ieps
    FROM h JOIN kepler_ods.kdm2 x ON btrim(x.sucursal)=h.suc AND x.c1=h.c1 AND x.c2=h.c2 AND x.c3=h.c3
      AND (x.c4)::int=h.c4 AND (x.c5)::int=h.c5 AND btrim(x.c6)=h.folio
    WHERE (x.c9)::numeric > 0),
  kd AS (SELECT DISTINCT ON (btrim(i.sucursal), btrim(i.c1)) btrim(i.sucursal) suc, btrim(i.c1) sku, i.c18::numeric kdii_iva, i.c19::numeric kdii_ieps,
      upper(btrim(i.c80)) u2, nullif(i.c81::numeric, 0) f2, upper(btrim(i.c83)) u3, nullif(i.c84::numeric, 0) f3
    FROM kepler_ods.kdii i WHERE btrim(i.c1) IN (SELECT sku FROM l)),
  w AS (SELECT DISTINCT ON (customer_code, sucursal) customer_code, sucursal, discount_1_pct pct_padron
    FROM analytics.v_erp_wholesale_customers WHERE customer_code IN (SELECT cliente FROM l))
  SELECT l.*, kd.kdii_iva, kd.kdii_ieps, w.pct_padron, w.customer_code AS padron_codigo,
    -- Renglones agregados después de capturar (surtido/checado) traen c55 pero no c51: la cantidad
    -- en la presentación sale de c9 ÷ el factor de esa presentación.
    CASE WHEN l.pres = kd.u3 AND kd.f3 > 0 THEN l.qty / kd.f3 WHEN l.pres = kd.u2 AND kd.f2 > 0 THEN l.qty / kd.f2 END AS qty_pres
  FROM l LEFT JOIN kd ON kd.suc = l.suc AND kd.sku = l.sku LEFT JOIN w ON w.customer_code = l.cliente AND w.sucursal = l.suc`;

// Renglones reales de pedidos de Kepler, con la presentación que se CAPTURÓ (kdm2.c55/c51). Si el
// motor no los reproduce al centavo, no se mide nada. u = precio de la presentación (= base × factor).
const CONTROLES = [
  // 2 CJA de 12 PAQ: 24 × $51.76 (la CJA $621.07 / 12, a centavos) — UD40 01-0002353
  { in: { branch: '01', sku: '89008', quantity: 2, rung_label: 'CJA' }, u: 621.12, l: 621.07, t: 1242.24 },
  // 36 PAQ capturados como PAQ: tramo 10+ del PAQ, sin prorrateo — la captura de la pantalla de Kepler
  { in: { branch: '01', sku: '89008', quantity: 36, rung_label: 'PAQ' }, u: 51.76, l: 55.93, t: 1863.36 },
  // 1 CJA de 144 PZA: 144 × $15.26 — UD40 01-0003315
  { in: { branch: '01', sku: '02195', quantity: 1, rung_label: 'CJA' }, u: 2197.44, l: 2197.95, t: 2197.44 },
  // el tramo se cobra aunque sea MÁS caro que la lista ($11.99) — UD40 08-0000707
  { in: { branch: '08', sku: '40509', quantity: 50, rung_label: 'PAQ' }, u: 12.76, l: 11.99, t: 638 },
  // 1 CJA de 20 PAQ: la CJA no tiene promo (el PAQ sí, 5 %) — UD40 08-0000755
  { in: { branch: '08', sku: '70001', quantity: 1, rung_label: 'CJA' }, u: 1595, l: 1594.96, t: 1595 },
];
// ⚠️ Son renglones reales: si el ERP cambia ese precio, el control se pone rojo con razón y se
// re-ancla a un pedido nuevo del mismo caso (no se relaja la tolerancia).

(async () => {
  require('reflect-metadata');
  const knexLib = require('knex')({ client: 'pg' });
  const { QuotePricingService } = require(motorEmpaquetado());
  const { abrir } = require('./psql-session');

  const s = abrir();
  await s.listo;
  const knex = { raw: async (sql, b) => ({ rows: await s.filas(knexLib.raw(sql, b ?? []).toQuery()) }) };
  const motor = new QuotePricingService(null, { requireTenantId: () => TENANT }, null);

  for (const c of CONTROLES) {
    const r = await motor.priceLine(knex, c.in);
    if (r.unit_price !== c.u || r.list_price !== c.l || r.line_total !== c.t) {
      const msg = 'CONTROL falló: ' + JSON.stringify(c.in) + ' dio ' + JSON.stringify({ u: r.unit_price, l: r.list_price, t: r.line_total });
      // Un motor de REFERENCIA (otro commit) se corre para medir el «antes»: sus fallas se reportan.
      if (!process.env.REPLAY_MOTOR_REF) throw new Error(msg);
      console.error('  (motor de referencia) ' + msg);
    }
  }
  console.error(`controles ok: ${CONTROLES.length} renglones reales de Kepler reproducidos al centavo`);

  const t0 = Date.now();
  const renglones = CONGELADO
    ? JSON.parse(fs.readFileSync(CONGELADO, 'utf8')).renglones.map(({ motor: _m, clase: _c, ...l }) => l)
    : await s.filas(UNIVERSO);
  console.error(`universo: ${renglones.length} renglones (${CONGELADO ? 'congelado de ' + CONGELADO : DIAS + ' día/s'})`);
  const cache = new Map();
  for (const l of renglones) {
    // La presentación capturada (c55) con su cantidad (c51); si no la hay, la unidad guardada.
    const cantPres = Number(l.pedida) > 0 ? Number(l.pedida) : Number(l.qty_pres) > 0 ? Number(l.qty_pres) : null;
    const enPres = !!l.pres && l.pres !== l.un && cantPres !== null;
    l.entrada = { unidad: enPres ? l.pres : l.un, cantidad: enPres ? cantPres : Number(l.qty) };
    const k = [l.suc, l.sku, l.entrada.unidad, l.entrada.cantidad].join('|');
    if (!cache.has(k)) {
      try {
        cache.set(k, await motor.priceLine(knex, { branch: l.suc, sku: l.sku, quantity: l.entrada.cantidad, rung_label: l.entrada.unidad }));
      } catch (e) {
        cache.set(k, { error: e.message });
      }
      if (cache.size % 200 === 0) console.error(`  ${cache.size} cotizados · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    l.motor = cache.get(k);
  }
  s.cerrar();
  fs.writeFileSync(SALIDA, JSON.stringify({ dias: DIAS, generado: new Date().toISOString(), renglones }));
  console.error(`${cache.size} cotizaciones distintas en ${((Date.now() - t0) / 1000).toFixed(0)} s → ${SALIDA}`);
})().catch((e) => { console.error(e); process.exit(1); });
