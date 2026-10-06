/* eslint-disable no-console */
/**
 * `[RD.32]` — **Quién de las once ya manda su existencia, y quién no.**
 *
 *   node database/scripts/check-route-stock-push.js
 *   node database/scripts/check-route-stock-push.js --truck ruta_21
 *
 * Lee el runner (`kepler_consolidado`, `DATABASE_URL_KEPLER_CONSOLIDADO`). No escribe nada.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * El reparto son once laptops que viajan, y el agente —por diseño— **sale en silencio cuando el
 * runner no contesta**. Así se perdieron cuatro vans durante semanas cuando murió `.249`: nadie
 * se enteró porque *no fallar* y *no hacer nada* se ven igual desde afuera.
 *
 * ⭐ Por eso esto compara **dos latidos**: el de la venta (que ya existía) contra el de la
 * existencia (nuevo). Un camión con venta fresca y sin existencia **no está roto: está sin
 * repartir**, y son dos acciones distintas. Mezclarlos manda a alguien a arreglar lo que no falla.
 *
 * ⚠️ Lo que NO se puede contestar desde acá: si la foto es *correcta*. Eso sólo lo dice la
 * aceptación por camioneta (su propio Kepler imprime el mismo total). Acá se mide **entrega**,
 * que es lo que ADR-053 pide de un latido.
 */
'use strict';
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const SOLO = (() => {
  const i = process.argv.indexOf('--truck');
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** Horas desde un instante, o `null` si nunca pasó. Un `null` NO es un 0 (ADR-056). */
const horas = (t) => (t ? (Date.now() - new Date(t).getTime()) / 3.6e6 : null);
const money = (v) => (v == null ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
const edad = (h) => (h == null ? 'nunca' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`);

(async () => {
  const url = process.env.DATABASE_URL_KEPLER_CONSOLIDADO;
  if (!url) {
    console.error('⛔ falta DATABASE_URL_KEPLER_CONSOLIDADO en el .env');
    process.exit(1);
  }
  const c = new Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 10000 });
  await c.connect();

  // El universo son los camiones que YA empujan venta: el reparto de existencia se mide contra
  // ellos, no contra una lista tecleada que envejece (la tabla del inventario declaró 6 cuando
  // en produccion habia 11, y nadie lo noto porque el control se habia declarado "cerrado").
  const { rows } = await c.query(
    `SELECT v.truck,
            v.last_ok   AS venta_ok,   v.rows_last AS venta_filas,
            s.last_ok   AS stock_ok,   s.rows_last AS stock_filas, s.valor_last AS stock_valor,
            -- [RD.32.2] De donde se conecto en su ULTIMO push. Reemplaza a la tabla a mano del
            -- inventario, que el propio documento declara poco confiable (son laptops que viajan
            -- y toman DHCP; una IP equivocada ya mando a alguien a la maquina que no era).
            host(coalesce(s.client_ip, v.client_ip)) AS ip,
            f.fecha::text AS foto_fecha, f.filas AS foto_filas, f.importe AS foto_importe
       FROM ingest.route_push_heartbeat v
       LEFT JOIN ingest.route_stock_heartbeat s ON s.truck = v.truck
       LEFT JOIN LATERAL (
            SELECT fecha, count(*)::int AS filas, round(sum(importe),2) AS importe
              FROM mart.existencias_ruta e
             WHERE e.truck = v.truck
             GROUP BY fecha ORDER BY fecha DESC LIMIT 1
       ) f ON true
      WHERE ($1::text IS NULL OR v.truck = $1)
      ORDER BY v.truck`, [SOLO]);

  console.log('\n[RD.32] Existencia de camion: quien ya manda, quien falta, y DONDE esta\n');
  console.log('camion    | venta        | existencia   | donde esta      | foto del dia                    | estado');
  console.log('----------+--------------+--------------+-----------------+---------------------------------+------------------------');

  let repartidos = 0, pendientes = 0, mudos = 0, valorTotal = 0;
  for (const r of rows) {
    const hv = horas(r.venta_ok), hs = horas(r.stock_ok);
    let estado;
    if (hv == null || hv > 48) { estado = '⛔ ni venta: van caida'; mudos++; }
    else if (hs == null) { estado = '⬜ sin repartir'; pendientes++; }
    else if (hs > 24) { estado = '⚠️ dejo de mandar foto'; mudos++; }
    else { estado = '✅ al dia'; repartidos++; valorTotal += Number(r.foto_importe || 0); }
    const foto = r.foto_fecha
      ? `${r.foto_fecha}  ${String(r.foto_filas).padStart(4)} prod  ${money(r.foto_importe).padStart(10)}`
      : '—';
    // `—` cuando todavia no empuja desde que la columna existe: es "no lo sé", no una IP.
    const donde = r.ip || '—';
    console.log(
      `${r.truck.padEnd(9)} | ${edad(hv).padEnd(12)} | ${edad(hs).padEnd(12)} | ${donde.padEnd(15)} | ${foto.padEnd(31)} | ${estado}`,
    );
  }

  console.log(`\n  ✅ al dia: ${repartidos}   ⬜ sin repartir: ${pendientes}   ⛔/⚠️ sin latido: ${mudos}   (de ${rows.length})`);
  if (repartidos) console.log(`  inventario de la flota, segun lo que ella misma declara: ${money(valorTotal)}`);

  // ── ¿La foto es PLAUSIBLE? ────────────────────────────────────────────────────────────────
  // De la ruta 21 tenemos el numero que su propio Kepler imprimio ($37,765.58). De las otras
  // diez NO hay referencia, y mirar diez cifras a ojo no escala. Lo que si hay es nuestra
  // reconstruccion: no es la verdad —ese es justo el problema que esta fase resuelve— pero sirve
  // de BANDA. Un error de peldano de unidad no se equivoca por poco: se equivoca por 12, por 20.
  //
  // ⭐ La foto DEBE salir MAYOR que el lado a favor de la reconstruccion, porque la reconstruccion
  // no ve la mercancia que el camion ya traia. Que salga MENOR, o diez veces mayor, es la senal.
  const conFoto = rows.filter((r) => r.foto_importe != null);
  if (conFoto.length && process.env.PROD_DB_URL) {
    const p = new Client({ connectionString: process.env.PROD_DB_URL, ssl: false, connectionTimeoutMillis: 10000 });
    try {
      await p.connect();
      const { rows: rec } = await p.query(
        `WITH win AS (
           SELECT route_no, sku, unidad,
                  sum(qty) FILTER (WHERE clase='carga')  AS cq,
                  sum(qty) FILTER (WHERE clase='conteo') AS kq,
                  sum(qty) FILTER (WHERE clase='venta')  AS vq
             FROM analytics.mv_rd_route_ledger GROUP BY 1,2,3)
         SELECT w.route_no,
                round(sum((coalesce(w.cq,0)+coalesce(w.kq,0)-coalesce(w.vq,0)) * u.costo_u)
                      FILTER (WHERE coalesce(w.cq,0)+coalesce(w.kq,0)-coalesce(w.vq,0) > 0),2)::float AS a_favor
           FROM win w LEFT JOIN analytics.mv_rd_route_unit_value u
             ON u.route_no=w.route_no AND u.sku=w.sku AND u.unidad=w.unidad
          GROUP BY 1`);
      const m = new Map(rec.map((x) => [x.route_no, x.a_favor]));
      console.log('\n  ¿la foto es plausible? (contra nuestra reconstruccion — es una BANDA, no la verdad)');
      for (const r of conFoto) {
        const rt = String(r.truck).split('_')[1];
        const base = m.get(rt);
        if (!base) { console.log(`    ${r.truck.padEnd(9)} sin reconstruccion con que comparar — NO MEDIDO`); continue; }
        const k = Number(r.foto_importe) / base;
        const v = k < 0.8 ? '⛔ la foto trae MENOS que la reconstruccion: revisar'
          : k > 8 ? '⛔ desproporcionada: huele a peldaño de unidad'
            : k > 1.0 ? '✔ plausible' : '⚠️ justo en el borde';
        console.log(`    ${r.truck.padEnd(9)} foto ${money(r.foto_importe).padStart(10)}  vs reconstruido ${money(base).padStart(10)}  = ${k.toFixed(2)}x  ${v}`);
      }
      await p.end();
    } catch (e) {
      // Que falle la comparacion NO puede volverse un veredicto: se declara.
      console.log(`\n  (no se pudo comparar contra prod: ${e.message} — plausibilidad NO MEDIDA)`);
      try { await p.end(); } catch { /* ya cerrado */ }
    }
  }

  // ⭐ La compuerta: mientras falte una sola, el inventario publicado de ESA ruta sigue siendo una
  // reconstruccion. Decirlo evita que "ya quedo" se lea como "las once".
  if (pendientes || mudos) {
    console.log(`\n  ⚠️ ${pendientes + mudos} camion(es) sin foto fresca: su inventario sigue RECONSTRUIDO,`);
    console.log('     no medido. No es lo mismo y la pantalla tiene que decirlo.');
  }
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
