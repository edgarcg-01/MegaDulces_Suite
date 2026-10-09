#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.18]` — **El derivador del mapa categoría(CB) → cuenta(ContPAQi).**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * `[CP.8.1c]` declaró que el mapa **no era derivable**. Esa conclusión se sacó cruzando
 * `analytics.gl_polizas` contra los *conceptos* de ContPAQi, y era la llave equivocada. Con la
 * llave correcta — **(cuenta de banco, fecha, importe)** contra los abonos a `102*` — sí cruza:
 * **27.8 % de pareo exacto contra 0.1 % de placebo** (ene–feb 2026). 278× el piso de ruido.
 *
 * ⛔ **El placebo no es opcional ni es un adorno.** Un cruce por importe SIEMPRE encuentra algo:
 * con suficientes filas, fechas e importes repetidos, el azar pare coincidencias. El número real
 * sólo significa algo **al lado del número que produce el azar**, y por eso este script imprime
 * los dos juntos y se niega a reportar uno sin el otro.
 *
 * ── Qué entrega ─────────────────────────────────────────────────────────────────────────────
 * Una fila por (categoría de CB × cuenta candidata de ContPAQi) con su conteo, su porcentaje, y
 * **la forma medida del asiento real** — que es lo que decide el `tipo_regla`:
 *
 *   · toca 2120*   (cuenta por pagar)  → `por_proveedor`  (la cuenta la decide el PROVEEDOR)
 *   · toca 215011* (sueldos x pagar)   → `por_sucursal`   (la decide la PLAZA)
 *   · toca 52* y nada de lo anterior   → `por_categoria`  (la decide la categoría)
 *   · no toca ninguna                  → `no_aplica`      (no es un gasto: banco↔banco)
 *
 * ⭐ Con eso, la media hora del contador deja de ser *"decidí 21 cosas desde cero"* y pasa a
 * *"confirmá estos renglones, cada uno con su evidencia"*.
 *
 * ── ⚠️ Lo que este script NO afirma ─────────────────────────────────────────────────────────
 * · **No es una regla aprobada.** Produce candidatas medidas; `estado` sigue siendo del contador.
 * · **No resuelve `por_sucursal`.** CB no trae centro de costo por movimiento (es la razón de
 *   `seg_negocio: 0` en el armador). Lo detecta y lo DECLARA; no lo inventa.
 * · **Una muestra chica no es una regla.** Debajo del umbral la fila sale marcada `CHICA` en
 *   vez de publicarse como si fuera un hallazgo.
 *
 * READ-ONLY de los dos lados. No escribe en ninguna base.
 *
 * Uso:
 *   node database/scripts/derivar-reglas-contpaqi.js
 *   node database/scripts/derivar-reglas-contpaqi.js --desde 2026-01-01 --hasta 2026-07-01
 *   node database/scripts/derivar-reglas-contpaqi.js --csv salida.csv --min-votos 3
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const sql = require('mssql');
const { Client } = require('pg');

// ── Parámetros ────────────────────────────────────────────────────────────────────────────────
const arg = (n, def) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? def : process.argv[i + 1];
};
const DESDE = arg('desde', '2026-01-01');
const HASTA = arg('hasta', '2026-03-01');
const MIN_VOTOS = Number(arg('min-votos', 2));
const CSV = arg('csv', null);

/**
 * ⚠️ El desplazamiento del placebo es **primo con la semana y mayor que un mes** a propósito: 43
 * días no cae en el mismo día de la semana ni en el mismo día del mes, que son los dos ritmos que
 * tienen los pagos recurrentes. Un placebo de 7 o de 30 mediría la repetición del calendario, no
 * el azar — y saldría alto por una razón que no tiene nada que ver con lo que se quiere probar.
 */
const PLACEBO_DIAS = Number(arg('placebo-dias', 43));

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => {
  throw new Error('falta DATABASE_URL_NEW');
})();
const MSCFG = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: {
    instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC',
    encrypt: false,
    trustServerCertificate: true,
  },
  requestTimeout: 180000,
};

const SEP = '\u0000';
const money = (n) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const pct = (a, b) => (b === 0 ? 0 : +((100 * a) / b).toFixed(1));

/**
 * ⛔ `MovimientosPoliza.TipoMovto` es **`bit` en SQL Server**, y el driver lo entrega como
 * `boolean` — no como `0`/`1`. La primera versión de este script comparaba `=== 0` y **nunca
 * empataba**: la tabla de formas salió con ceros en todas las columnas y en las doce categorías,
 * que se lee como *"ningún egreso toca una cuenta de gasto"* — un hallazgo espectacular y falso.
 *
 * ⭐ Ésa es la falla peligrosa: una comparación de tipo equivocado **no tira error, dibuja un
 * cero**. `Number()` normaliza las dos formas (`false`→0, `0`→0) y sobrevive si algún día la
 * columna cambia a `tinyint`.
 */
const esCargo = (x) => Number(x.TipoMovto) === 0;

// ── Lectura ───────────────────────────────────────────────────────────────────────────────────

/** Egresos de CB con cuenta de banco enlazada al crosswalk de `[CP.2]`. */
async function leerCb() {
  const pg = new Client({ connectionString: DST });
  await pg.connect();
  try {
    const { rows } = await pg.query(
      `SELECT m.id,
              to_char(m.movement_date, 'YYYY-MM-DD') AS fecha,
              round(m.amount_out, 2)::float8         AS importe,
              c.code                                 AS categoria,
              ba.contpaqi_cuenta                     AS cuenta_banco
         FROM finance.bank_movements m
         JOIN finance.movement_categories c ON c.id = m.category_id
         JOIN finance.bank_accounts      ba ON ba.id = m.bank_account_id
        WHERE m.tenant_id = $1
          AND m.deleted_at IS NULL
          AND m.amount_out > 0
          AND m.movement_date >= $2
          AND m.movement_date <  $3
          AND ba.contpaqi_cuenta IS NOT NULL
          -- El IVA no es un asiento: es el renglón 2 del asiento de su hermano (CP.8.7 §16.1).
          AND c.code <> 'iva_acreditable'`,
      [TENANT, DESDE, HASTA],
    );
    return rows;
  } finally {
    await pg.end();
  }
}

/** Los abonos a cuentas de banco (102*) y TODOS los renglones de esas pólizas. */
async function leerContpaqi() {
  const pool = await sql.connect(MSCFG);
  try {
    const abonos = (await pool.request()
      .input('d', sql.Date, DESDE).input('h', sql.Date, HASTA)
      .query(`
        SELECT p.Id AS idpol,
               CONVERT(varchar(10), p.Fecha, 23) AS fecha,
               ROUND(mp.Importe, 2) AS importe,
               c.Codigo AS cuenta_banco
          FROM MovimientosPoliza mp
          JOIN Polizas  p ON p.Id = mp.IdPoliza
          JOIN Cuentas  c ON c.Id = mp.IdCuenta
         WHERE p.Fecha >= @d AND p.Fecha < @h
           AND mp.TipoMovto = 1
           AND c.Codigo LIKE '102%'`)).recordset;

    const renglones = (await pool.request()
      .input('d', sql.Date, DESDE).input('h', sql.Date, HASTA)
      .query(`
        SELECT p.Id AS idpol, c.Codigo AS cuenta, LEFT(c.Nombre, 45) AS nombre,
               mp.TipoMovto, ROUND(mp.Importe, 2) AS importe
          FROM MovimientosPoliza mp
          JOIN Polizas  p ON p.Id = mp.IdPoliza
          JOIN Cuentas  c ON c.Id = mp.IdCuenta
         WHERE p.Fecha >= @d AND p.Fecha < @h`)).recordset;

    return { abonos, renglones };
  } finally {
    await pool.close();
  }
}

// ── Cruce ─────────────────────────────────────────────────────────────────────────────────────

const corre = (dias) => (cb, idx, porPoliza) => {
  const votos = new Map();
  const forma = new Map();
  let exacto = 0;
  let ambiguo = 0;
  let sin = 0;

  for (const m of cb) {
    let f = m.fecha;
    if (dias) {
      const d = new Date(`${f}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + dias);
      f = d.toISOString().slice(0, 10);
    }
    const hit = idx.get(`${m.cuenta_banco}|${f}|${m.importe.toFixed(2)}`);
    if (!hit) { sin++; continue; }
    // Más de una póliza con el mismo banco/fecha/importe NO se resuelve eligiendo la primera:
    // se cuenta aparte. Elegir una sería fabricar certeza donde la evidencia no alcanza.
    if (hit.length > 1) { ambiguo++; continue; }
    exacto++;

    const lineas = porPoliza.get(hit[0].idpol) || [];
    const cargos = lineas.filter(esCargo);

    const f0 = forma.get(m.categoria)
      || { n: 0, renglones: 0, con_iva: 0, con_2120: 0, con_215011: 0, con_52: 0 };
    f0.n += 1;
    f0.renglones += lineas.length;
    if (lineas.some((x) => x.cuenta.startsWith('106') || x.cuenta.startsWith('1470'))) f0.con_iva += 1;
    if (cargos.some((x) => x.cuenta.startsWith('2120'))) f0.con_2120 += 1;
    if (cargos.some((x) => x.cuenta.startsWith('215011'))) f0.con_215011 += 1;
    if (cargos.some((x) => x.cuenta.startsWith('52'))) f0.con_52 += 1;
    forma.set(m.categoria, f0);

    // La cuenta candidata: el cargo mayor que no sea impuesto acreditable.
    const cand = cargos.filter((x) => !x.cuenta.startsWith('106') && !x.cuenta.startsWith('1470'));
    if (!cand.length) continue;
    const mayor = cand.reduce((a, b) => (Math.abs(b.importe) > Math.abs(a.importe) ? b : a));
    const k = [m.categoria, mayor.cuenta, mayor.nombre].join(SEP);
    votos.set(k, (votos.get(k) || 0) + 1);
  }
  return { exacto, ambiguo, sin, total: cb.length, votos, forma };
};

/**
 * El tipo de regla sale de la FORMA medida, no de la cuenta candidata — porque una categoría
 * puede repartirse entre decenas de cuentas de proveedor y aun así tener un tipo clarísimo.
 */
function tipoRegla(f) {
  if (!f || f.n === 0) return { tipo: 'sin_medir', por_que: 'cero pareos' };
  const p = (x) => pct(x, f.n);
  if (p(f.con_2120) >= 50) return { tipo: 'por_proveedor', por_que: `${p(f.con_2120)}% toca 2120*` };
  if (p(f.con_215011) >= 50) return { tipo: 'por_sucursal', por_que: `${p(f.con_215011)}% toca 215011*` };
  if (p(f.con_52) >= 50) return { tipo: 'por_categoria', por_que: `${p(f.con_52)}% toca 52*` };
  return { tipo: 'no_aplica', por_que: `no toca cuenta de gasto (${p(f.con_52)}% en 52*)` };
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n[CP.8.18] derivador de reglas · ventana ${DESDE} -> ${HASTA}`);

  const cb = await leerCb();
  const { abonos, renglones } = await leerContpaqi();

  const idx = new Map();
  for (const a of abonos) {
    const k = `${a.cuenta_banco}|${a.fecha}|${a.importe.toFixed(2)}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(a);
  }
  const porPoliza = new Map();
  for (const r of renglones) {
    if (!porPoliza.has(r.idpol)) porPoliza.set(r.idpol, []);
    porPoliza.get(r.idpol).push(r);
  }

  const real = corre(0)(cb, idx, porPoliza);
  const placebo = corre(PLACEBO_DIAS)(cb, idx, porPoliza);

  console.log(`\nCB egresos con cuenta de banco enlazada : ${cb.length}`);
  console.log(`ContPAQi abonos 102*                    : ${abonos.length}`);
  console.log(`ContPAQi renglones en la ventana        : ${renglones.length}`);

  // El número real NUNCA se imprime solo.
  const razon = placebo.exacto === 0 ? Infinity : real.exacto / placebo.exacto;
  console.log('\n=== PAREO (el placebo va al lado, siempre) ===');
  console.table([
    {
      corrida: 'real',
      exacto: real.exacto,
      pct: pct(real.exacto, real.total),
      ambiguo: real.ambiguo,
      sin_pareo: real.sin,
    },
    {
      corrida: `placebo +${PLACEBO_DIAS}d`,
      exacto: placebo.exacto,
      pct: pct(placebo.exacto, placebo.total),
      ambiguo: placebo.ambiguo,
      sin_pareo: placebo.sin,
    },
  ]);
  console.log(`razon real/placebo : ${razon === Infinity ? 'sin ruido medible' : `${razon.toFixed(0)}x`}`);
  if (razon !== Infinity && razon < 10) {
    console.log('ADVERTENCIA: menos de 10x el piso de ruido. Esta derivacion NO es evidencia suficiente.');
  }

  // ── Forma del asiento y tipo de regla propuesto ──────────────────────────────────────────
  const formaFilas = [...real.forma.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([categoria, f]) => {
      const t = tipoRegla(f);
      return {
        categoria,
        pareados: f.n,
        rengl_prom: +(f.renglones / f.n).toFixed(1),
        pct_IVA: pct(f.con_iva, f.n),
        pct_2120: pct(f.con_2120, f.n),
        pct_215011: pct(f.con_215011, f.n),
        pct_52: pct(f.con_52, f.n),
        tipo_regla: t.tipo,
        evidencia: t.por_que,
        muestra: f.n < MIN_VOTOS * 3 ? 'CHICA' : '',
      };
    });
  console.log('\n=== FORMA DEL ASIENTO REAL -> tipo_regla propuesto ===');
  console.table(formaFilas);

  /**
   * ⛔ **Freno de clasificador muerto.** Si TODAS las categorías caen en el mismo tipo, o si
   * ninguna toca una cuenta de gasto, lo que está roto es el clasificador — no el mundo. Es
   * exactamente lo que pasó con `TipoMovto` (`bit` leído como `=== 0`): doce categorías en
   * `no_aplica` con una evidencia que sonaba razonable.
   *
   * Un cero que nadie cuestiona es peor que un error, porque se publica.
   */
  const tiposVistos = new Set(formaFilas.map((f) => f.tipo_regla));
  const algunaTocaGasto = formaFilas.some((f) => f.pct_52 > 0 || f.pct_2120 > 0 || f.pct_215011 > 0);
  if (formaFilas.length >= 3 && (tiposVistos.size === 1 || !algunaTocaGasto)) {
    console.error(
      '\nFATAL: el clasificador puso TODO en el mismo cubo '
      + `(${[...tiposVistos].join(', ')}) o nada toca una cuenta de gasto.\n`
      + 'Eso no es un hallazgo: es un clasificador roto. No se publica.',
    );
    process.exit(2);
  }

  // ── Cuentas candidatas por categoría ─────────────────────────────────────────────────────
  const totalPorCat = new Map();
  for (const [k, n] of real.votos) {
    const cat = k.split(SEP)[0];
    totalPorCat.set(cat, (totalPorCat.get(cat) || 0) + n);
  }
  const candidatas = [...real.votos.entries()]
    .map(([k, n]) => {
      const [categoria, cuenta, nombre] = k.split(SEP);
      return { categoria, cuenta, nombre, votos: n, pct: pct(n, totalPorCat.get(categoria)) };
    })
    .filter((r) => r.votos >= MIN_VOTOS)
    .sort((a, b) => a.categoria.localeCompare(b.categoria) || b.votos - a.votos);

  console.log(`\n=== CUENTAS CANDIDATAS (>=${MIN_VOTOS} votos) — el contador CONFIRMA, no decide ===`);
  console.table(candidatas);

  // Las tres ausencias son distintas y se nombran distinto (ADR-056).
  const vistas = new Set(cb.map((m) => m.categoria));
  const sinPareo = [...vistas].filter((c) => !real.forma.has(c));
  const sinCandidata = [...real.forma.keys()].filter((c) => !totalPorCat.has(c));
  if (sinCandidata.length) console.log(`pareadas pero SIN cuenta candidata : ${sinCandidata.join(', ')}`);
  if (sinPareo.length) console.log(`SIN MEDIR (cero pareos en la ventana): ${sinPareo.join(', ')}`);

  if (CSV) {
    const cab = 'categoria,cuenta,nombre,votos,pct\n';
    const cuerpo = candidatas
      .map((r) => `${r.categoria},${r.cuenta},"${r.nombre.replace(/"/g, '""')}",${r.votos},${r.pct}`)
      .join('\n');
    fs.writeFileSync(CSV, `${cab}${cuerpo}\n`, 'utf8');
    console.log(`\nCSV escrito: ${CSV}`);
  }

  const importe = cb.reduce((s, m) => s + m.importe, 0);
  console.log(`\nuniverso medido: ${money(importe)} en ${cb.length} egresos\n`);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
