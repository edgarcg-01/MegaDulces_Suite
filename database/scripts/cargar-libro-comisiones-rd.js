/* eslint-disable no-console */
/**
 * `[RD.51]` — **El espejo del libro**: carga las quincenas YA PAGADAS de
 * `INDICADORES RD 2026.xlsx` a `commercial.commission_runs` / `_run_lines`.
 *
 * ── Por qué esto existe ─────────────────────────────────────────────────────────────────────
 * Una quincena pagada **no es un cálculo: es el registro de un depósito que ocurrió**. El motor
 * ya lo dice en `persist()` ("lo pagado no se edita, nunca, ni con `replace`"), pero el módulo
 * nació sin historia, así que la única forma de llenar la pantalla era pedirle que
 * reconstruyera 20 quincenas desde fuentes que, para esas fechas, ya no son el testigo que se
 * usó para pagar. Medido: publicar Q20 con el motor **le pagaría $0 a la 504 en vez de
 * $1,092.46**, porque le faltan 7 de 12 días y el tramo más bajo es un acantilado en
 * $189,999.99 de venta.
 *
 * Esto NO es un importer: es una **carga única de un histórico congelado**, que es el caso que
 * la regla de "cero importers" permite como tabla real. Se corre una vez, se cuadra al centavo,
 * y las filas nacen `pagado` — que `persist()` se niega a tocar aunque alguien pida `replace`.
 *
 * ── Lo que NO carga, y por qué ──────────────────────────────────────────────────────────────
 * ⛔ **La línea del supervisor queda fuera.** No por falta de dato sino porque el libro le paga
 * **dos cosas distintas a dos supervisores**, medido en `FORMATO DE SUPERVISOR`:
 *
 *     T19 (ANGEL)     → INDEX(... MATCH($T$16, $B$12:$E$12) ...)  → columna E = "Comisión" (el 20 %)
 *     T25 (FRANCISCO) → INDEX(... MATCH($G$12, $B$12:$G$12) ...)  → columna G = "Bono por alcance"
 *
 * Y el pie del recibo de FRANCISCO suma el bono **dos veces** ("Suma de Comisiónes a Pagar"
 * 2,400 + "Bono por alcance de %" 2,400 = "Total a Pagar" 4,800) mientras su 20 % del periodo
 * —2,004.77 + 1,771.86 + 2,405.04 + 1,680.81 = **7,862.48**— no entra en ningún renglón. El
 * mismo recibo además publica "Neto del recibo" 2,400 contra "Total a Pagar" 4,800.
 *
 * Escribir eso como `pagado` sería afirmar un hecho que el archivo no sostiene. Se DECLARA en
 * la nota de cada corrida y queda como decisión (abierto #3 de FASE_RD: los tres Jefes de Zona).
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────────────────────
 *     node database/scripts/cargar-libro-comisiones-rd.js "<ruta>/INDICADORES RD 2026.xlsx"
 *     ... --apply      # recién entonces escribe
 *
 * Sin `--apply` no toca la base: imprime el cuadre y sale.
 */
'use strict';

const path = require('path');
const { Client } = require('pg');
const ExcelJS = require('exceljs');

const ARCHIVO = process.argv.find((a) => /\.xlsx$/i.test(a));
const APPLY = process.argv.includes('--apply');
const REEMPLAZAR = process.argv.includes('--reemplazar');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;

/** Los tres totales de la hoja COMISIONES, medidos el 2026-10-08. El cuadre es PRECONDICIÓN. */
const ESPERADO = { comision: 1580327.48, a_pagar: 796981.88, supervisor: 395081.87 };
const TOLERANCIA = 0.01;

/**
 * ⛔ **Los bonos del chofer NO están en la hoja `COMISIONES`** — están en el recibo
 * (`FORMATO DE PAGO`, filas 40-42), y por eso la primera carga los dejó en cero y publicó
 * **$140,800 de menos, el 17.67 %** de lo que decía que se había pagado. Lo encontró el
 * contraste de `[RD.52]`, que es exactamente para lo que existe.
 *
 * La regla, leída de las fórmulas `BN40`/`BN41`/`BN42` del propio recibo:
 *
 *     Lavadas  IF(venta >= 215999.99,  200, 0)
 *     Lonche   IF(venta >= 239999.99,  800, 0)
 *     Chalan   IF(venta >= 259999.99, 1000, 0)
 *     Total a Pagar = IF(comision = "NO APLICA", banco, comision - banco + los tres bonos)
 *
 * ⭐ Corroboración independiente: `commercial.commission_bonuses` trae los **mismos tres
 * umbrales y los mismos tres montos**, sembrados por `[RD.6]` desde este mismo workbook.
 *
 * ⚠️ Y acá hay una diferencia de rango con el resto del espejo, que se DECLARA: esto se
 * **deriva**, no se lee. El workbook no guarda historia de bonos — el recibo los recalcula
 * para la quincena que tengas seleccionada en `BQ7`, así que no hay una celda por periodo que
 * copiar. Si la regla cambió a mitad de año, el espejo no lo vería.
 */
const BONOS_CHOFER = [
  { nombre: 'Lavadas', umbral: 215999.99, monto: 200 },
  { nombre: 'Lonche', umbral: 239999.99, monto: 800 },
  { nombre: 'Chalan', umbral: 259999.99, monto: 1000 },
];
const bonosDe = (venta, paga) => (!paga || venta == null ? 0
  : BONOS_CHOFER.reduce((s, b) => s + (venta >= b.umbral ? b.monto : 0), 0));

const V = (cell) => {
  const v = cell && cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result === undefined ? null : v.result;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return v.text ?? null;
  }
  return v;
};
const F = (cell) => {
  const v = cell && cell.value;
  if (!v || typeof v !== 'object') return null;
  return v.formula || null;
};
const num = (x) => (typeof x === 'number' ? x : null);
/**
 * ⭐ A CENTAVOS, en el borde — al LEER el libro, no al escribir.
 *
 * El libro guarda full precision y sólo MUESTRA dos decimales: su "comisión" de la Q1 ruta 21
 * es `9135.2008`, no `9135.20`. Las columnas son `numeric(14,2)`, así que Postgres redondea
 * cada renglón al insertarlo. La primera carga sumó los flotantes crudos por periodo y
 * redondeó al final: lo guardado quedó **3 centavos** por encima del libro y, peor, el total
 * de la corrida no coincidía con la suma de sus propias líneas. Dos campos del mismo hecho
 * tienen que salir del mismo cálculo.
 */
const cent = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);
/** Suma de una columna de dinero en centavos ENTEROS, devuelta como cadena de dos decimales. */
const sumC = (filas, k) => (filas.reduce((s, x) => s + Math.round((x[k] ?? 0) * 100), 0) / 100).toFixed(2);
/** `YYYY-MM-DD` venga como texto o como `Date` (exceljs entrega medianoche UTC). */
const fechaISO = (x) => {
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10);
  return null;
};
const money = (n) => (n === null ? '       —' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const letras = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };

/**
 * ⭐ El mapa ruta → bloque sale del PROPIO workbook, no de una lista tecleada.
 * `FORMATO DE PAGO` filas 12-24: columna B = la ruta, columna C = una fórmula gigante cuyo
 * primer `COMISIONES!<col><fila>` dice exactamente de qué bloque sale esa ruta. Los rótulos de
 * la hoja COMISIONES no sirven para esto: dicen "RUTA CANINDO 503 (501)" — el número entre
 * paréntesis es un nombre viejo, y leerlo mal cambia a quién se le paga.
 */
function mapaRutas(wb) {
  const ws = wb.getWorksheet('FORMATO DE PAGO');
  const mapa = [];
  for (let r = 12; r <= 30; r++) {
    const ruta = V(ws.getRow(r).getCell(2));
    const f = F(ws.getRow(r).getCell(3));
    if (ruta === null || !f) continue;
    const m = /COMISIONES!([A-Z]+)(\d+)/.exec(f);
    if (!m) continue;
    mapa.push({ route_code: String(ruta).trim(), colCosto: letras(m[1]), filaBase: Number(m[2]) });
  }
  return mapa;
}

/** Una fila del libro: periodo × ruta, con las diez columnas del bloque. */
function leerBloque(ws, { route_code, colCosto, filaBase }) {
  const out = [];
  // El bloque arranca en `filaBase` (periodo 1) y baja de a una fila por quincena.
  for (let i = 0; i < 27; i++) {
    const r = filaBase + i;
    const row = ws.getRow(r);
    const periodo = num(V(row.getCell(3)));
    if (periodo === null) continue;
    const g = (off) => V(row.getCell(colCosto + off));
    const costo = num(g(0)); const subtotal = num(g(1)); const venta = num(g(2));
    if (costo === null && subtotal === null && venta === null) continue;
    const tierTxt = g(4);
    const pct = typeof tierTxt === 'string' && /%$/.test(tierTxt) ? Number(tierTxt.replace('%', '')) : null;
    out.push({
      route_code, periodo,
      // ⚠️ La fecha llega de DOS formas: texto en la fila que alguien tecleó, y `Date` (UTC
      // medianoche) en las ~19 que son fórmula. Tomar sólo el texto dejaba **1 de 20**
      // comprobadas y la precondición salía ✔ igual — que es dibujar un verde sobre una
      // muestra de uno. Es la alineación periodo-del-libro ↔ periodo-de-la-base: si el bloque
      // estuviera corrido una fila, sin esto no se notaría.
      fecha_fin: fechaISO(V(row.getCell(2))),
      costo: cent(costo), subtotal: cent(subtotal), venta: cent(venta),
      markup: num(g(3)) === null ? null : Math.round(num(g(3)) * 100 * 10000) / 10000,
      pct_aplicado: pct,
      // Los crudos se conservan para poder DECLARAR cuánto mueve el redondeo, en vez de
      // comparar contra el libro con un número y guardar otro.
      comision_crudo: num(g(7)), a_pagar_crudo: num(g(9)), supervisor_crudo: num(g(6)),
      supervisor: cent(num(g(6))),
      comision: cent(num(g(7))),
      nomina_banco: cent(num(g(8))),
      // `a_pagar_hoja` es lo que trae la columna A PAGAR de COMISIONES (comision - nomina).
      // Lo que de verdad se le deposita al chofer lleva los bonos encima: se arma abajo.
      a_pagar_hoja: cent(num(g(9))),
      /** El libro dice `NO APLICA` cuando la venta no alcanzó el tramo: NO es cero. */
      motivo_no_pago: typeof g(9) === 'string' ? 'bajo_umbral' : null,
    });
  }
  // Los bonos se derivan de la venta YA redondeada, y el pago real del recibo se arma acá:
  // `comision - nomina + bonos`, que es la formula BN43 del propio FORMATO DE PAGO.
  for (const f of out) {
    f.bonos = bonosDe(f.venta, f.motivo_no_pago === null);
    f.a_pagar = f.a_pagar_hoja === null ? null : cent(f.a_pagar_hoja + f.bonos);
    // ⚠️ `a_pagar_crudo` se deja COMO LO TRAE LA HOJA (sin bonos): es contra eso que se valida
    // el parseo. El del recibo va aparte -- mezclarlos hacía que el cuadre comparara una cifra
    // contra otra que no es la suya, y el chequeo de redondeo marcara $140,800 de "redondeo".
    f.a_pagar_recibo_crudo = f.a_pagar_crudo === null ? null : f.a_pagar_crudo + f.bonos;
  }
  return out;
}

(async () => {
  if (!ARCHIVO) throw new Error('falta la ruta del .xlsx como argumento');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ARCHIVO);
  const ws = wb.getWorksheet('COMISIONES');

  const mapa = mapaRutas(wb);
  console.log(`\n=== [RD.51] espejo del libro · ${path.basename(ARCHIVO)} ===`);
  console.log(`mapa de rutas derivado de FORMATO DE PAGO: ${mapa.length} rutas`);
  console.log(`  ${mapa.map((m) => m.route_code).join(' · ')}`);

  const filas = [];
  for (const b of mapa) filas.push(...leerBloque(ws, b));

  // ── Cuadre, antes de mirar la base ────────────────────────────────────────────────────────
  const suma = (k, f = () => true) => filas.filter(f).reduce((s, x) => s + (x[k] ?? 0), 0);
  const totComision = suma('comision_crudo');
  // ⚠️ Contra la HOJA se valida lo que la hoja trae: `A PAGAR` es comision - nomina, SIN bonos.
  // El pago real del recibo se declara aparte, abajo, porque es derivado y no leído.
  const totPagar = suma('a_pagar_crudo');
  const totBonos = suma('bonos');
  const totPagarRecibo = suma('a_pagar_recibo_crudo');
  const totSuper = suma('supervisor_crudo');
  // Lo que de verdad se va a guardar: la suma de los renglones YA redondeados a centavos.
  const centavos = (k) => filas.reduce((s, x) => s + Math.round((x[k] ?? 0) * 100), 0) / 100;
  const guardComision = centavos('comision');
  const guardPagar = centavos('a_pagar');
  const d = (a, b) => Math.abs(a - b);

  console.log(`\n--- cuadre contra lo medido el 2026-10-08 ---`);
  const filasConPago = filas.filter((x) => x.a_pagar !== null).length;
  console.log(`  ruta-periodo leidas            : ${filas.length}  (con pago: ${filasConPago}, sin tramo: ${filas.length - filasConPago})`);
  const pruebas = [
    ['comision del chofer', totComision, ESPERADO.comision],
    ['a pagar segun la HOJA (sin bonos)', totPagar, ESPERADO.a_pagar],
    ['20% del supervisor (NO se carga)', totSuper, ESPERADO.supervisor],
  ];
  let cuadra = true;
  for (const [etq, got, exp] of pruebas) {
    const ok = d(got, exp) <= TOLERANCIA;
    if (!ok && etq.startsWith('comision') === false && etq.startsWith('a pagar') === false) {
      // el del supervisor es informativo
    } else if (!ok) cuadra = false;
    console.log(`  ${ok ? '✔' : '✖'} ${etq.padEnd(34)} ${money(got).padStart(14)}  esperado ${money(exp).padStart(14)}  Δ ${money(got - exp)}`);
  }
  if (!cuadra) {
    console.log('\n⛔ NO CUADRA. No se carga nada: el cuadre es precondicion, no reporte posterior.\n');
    process.exit(1);
  }

  // ⭐ Y lo que se GUARDA es otro número: el libro lleva full precision (su comisión de Q1
  // ruta 21 es 9135.2008) y las columnas son numeric(14,2). El efecto del redondeo se DECLARA
  // con su monto, no se esconde detrás de un "cuadra al centavo" que compara contra otra cosa.
  // ── Los bonos del recibo: DERIVADOS, no leídos. Se declaran con su regla y su monto. ──────
  const conBono = filas.filter((f) => (f.bonos ?? 0) > 0).length;
  console.log(`\n--- los bonos del RECIBO (FORMATO DE PAGO 40-42), derivados de la venta ---`);
  for (const b of BONOS_CHOFER) {
    const n = filas.filter((f) => f.motivo_no_pago === null && (f.venta ?? 0) >= b.umbral).length;
    console.log(`  ${b.nombre.padEnd(9)} venta >= ${money(b.umbral)} → $${String(b.monto).padStart(5)}  ·  ${String(n).padStart(3)} renglon(es)`);
  }
  console.log(`  total de bonos ${money(totBonos).padStart(14)}  en ${conBono} de ${filas.length} renglones`);
  console.log(`  ⭐ pago real del recibo = hoja ${money(totPagar)} + bonos ${money(totBonos)} = ${money(totPagar + totBonos)}`);

  console.log(`\n--- lo que se GUARDA (${filas.length} renglones redondeados a centavos) ---`);
  console.log(`  comision   ${money(guardComision).padStart(14)}  · el libro a full precision ${money(totComision)}  → redondeo ${money(guardComision - totComision)}`);
  console.log(`  a pagar    ${money(guardPagar).padStart(14)}  · el recibo a full precision ${money(totPagarRecibo)}  → redondeo ${money(guardPagar - totPagarRecibo)}`);
  const techo = filas.length * 0.005;
  const redondeoOk = d(guardComision, totComision) <= techo && d(guardPagar, totPagarRecibo) <= techo;
  console.log(`  ${redondeoOk ? '✔' : '✖'} el desvio por redondeo cabe en el techo teorico (${filas.length} × 0.005 = ${techo.toFixed(2)})`);
  if (!redondeoOk) { console.log('\n⛔ el redondeo mueve mas de lo que puede: no se carga.\n'); process.exit(1); }

  // ── Agregado por periodo ──────────────────────────────────────────────────────────────────
  const porPeriodo = new Map();
  for (const f of filas) {
    if (!porPeriodo.has(f.periodo)) porPeriodo.set(f.periodo, []);
    porPeriodo.get(f.periodo).push(f);
  }
  console.log(`\n--- ${porPeriodo.size} quincenas a espejar ---`);
  console.log('  Q  | rutas | pagan |     subtotal |        venta |     comision |      a pagar');
  for (const q of [...porPeriodo.keys()].sort((a, b) => a - b)) {
    const g = porPeriodo.get(q);
    const pagan = g.filter((x) => x.a_pagar !== null).length;
    console.log(`  ${String(q).padStart(2)} | ${String(g.length).padStart(5)} | ${String(pagan).padStart(5)} | `
      + `${money(g.reduce((s, x) => s + (x.subtotal ?? 0), 0)).padStart(12)} | ${money(g.reduce((s, x) => s + (x.venta ?? 0), 0)).padStart(12)} | `
      + `${money(g.reduce((s, x) => s + (x.comision ?? 0), 0)).padStart(12)} | ${money(g.reduce((s, x) => s + (x.a_pagar ?? 0), 0)).padStart(12)}`);
  }

  if (!URL) { console.log('\nⓘ sin DATABASE_URL_NEW: no se contrasta contra la base.\n'); return; }

  const db = new Client({
    connectionString: URL, statement_timeout: 60000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  if (!APPLY) await db.query('SET default_transaction_read_only = on');
  await db.query(`SET app.tenant_id = '${TENANT}'`);

  // ── Precondiciones contra la base ─────────────────────────────────────────────────────────
  const { rows: periodos } = await db.query(
    `SELECT id, period_no, to_char(date_to,'YYYY-MM-DD') date_to, to_char(pay_date,'YYYY-MM-DD') pay_date
       FROM commercial.commission_periods
      WHERE tenant_id = $1 AND anio = 2026 AND deleted_at IS NULL`, [TENANT]);
  const porNo = new Map(periodos.map((p) => [p.period_no, p]));
  const { rows: [escala] } = await db.query(
    `SELECT id FROM commercial.commission_scales
      WHERE tenant_id = $1 AND code = 'RD-2026' AND deleted_at IS NULL`, [TENANT]);
  const { rows: cfg } = await db.query(
    `SELECT route_code, chofer_nombre, zona, nomina_banco FROM commercial.commission_route_config
      WHERE tenant_id = $1 AND deleted_at IS NULL`, [TENANT]);
  const porRuta = new Map(cfg.map((c) => [c.route_code, c]));

  console.log('\n--- precondiciones ---');
  let listo = true;
  const chk = (etq, cond, det = '') => { if (!cond) listo = false; console.log(`  ${cond ? '✔' : '✖'} ${etq}${det ? ` — ${det}` : ''}`); };
  chk('existe la escala RD-2026', !!escala);
  chk(`las ${porPeriodo.size} quincenas del libro existen en commission_periods`,
    [...porPeriodo.keys()].every((q) => porNo.has(q)),
    [...porPeriodo.keys()].filter((q) => !porNo.has(q)).join(', '));
  const rutasSinCfg = mapa.map((m) => m.route_code).filter((r) => !porRuta.has(r));
  chk('las rutas del libro estan en commission_route_config', rutasSinCfg.length === 0, rutasSinCfg.join(', '));

  // La fecha de cierre que trae el libro tiene que ser la misma que la de la quincena en la DB.
  let fechasOk = 0; let fechasMal = 0;
  for (const [q, g] of porPeriodo) {
    const conFecha = g.find((x) => x.fecha_fin);
    if (!conFecha || !porNo.has(q)) continue;
    if (conFecha.fecha_fin === porNo.get(q).date_to) fechasOk++;
    else { fechasMal++; console.log(`    ✖ Q${q}: libro ${conFecha.fecha_fin} vs DB ${porNo.get(q).date_to}`); }
  }
  // ⭐ La COBERTURA es parte de la aserción. "0 desacuerdos" sobre 1 de 20 quincenas se lee
  // igual de verde que sobre 20 de 20, y no es lo mismo: lo primero no comprobó la alineación.
  chk(`las fechas de cierre coinciden Y cubren las ${porPeriodo.size} quincenas`,
    fechasMal === 0 && fechasOk === porPeriodo.size,
    `${fechasOk} comprobadas, ${fechasMal} en desacuerdo`);

  const { rows: [{ n: yaHay }] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_runs WHERE tenant_id = $1 AND deleted_at IS NULL`, [TENANT]);
  const { rows: [{ n: yaLibro }] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_runs
      WHERE tenant_id = $1 AND deleted_at IS NULL AND origen = 'libro'`, [TENANT]);
  // ⚠️ `--reemplazar` sólo borra lo que ESTE script escribió (`origen = 'libro'`). Una corrida
  // del motor no se toca ni con la bandera puesta: no es de acá.
  chk('commission_runs no tiene corridas ajenas',
    Number(yaHay) === Number(yaLibro), `${yaHay} corrida(s), ${yaLibro} del libro`);
  chk(REEMPLAZAR ? `hay ${yaLibro} espejo(s) previo(s) y se van a reemplazar` : 'no hay un espejo previo',
    REEMPLAZAR || Number(yaLibro) === 0, `hay ${yaLibro}; corré con --reemplazar si querés rehacerlo`);

  if (!listo) { console.log('\n⛔ precondiciones no cumplidas: no se carga nada.\n'); await db.end(); process.exit(1); }

  if (!APPLY) {
    console.log('\nⓘ DRY-RUN. Nada escrito. Volvé a correrlo con --apply para cargarlo.\n');
    await db.end();
    return;
  }

  // ── La carga ──────────────────────────────────────────────────────────────────────────────
  const NOTA = 'RD.51 - espejo del libro INDICADORES RD 2026. Lo que se pago, congelado: status=pagado, '
    + 'origen=libro. SOLO la linea del CHOFER. La del SUPERVISOR queda fuera a proposito: el libro le paga '
    + 'dos cosas distintas a dos supervisores (a uno la comision del 20%, al otro el bono, contado dos veces '
    + 'en el pie del recibo) y escribirlo como pagado afirmaria un hecho que el archivo no sostiene. '
    + 'dias/fuentes/veredicto de costo van NULL: el libro no los trae, y cero no es lo mismo que no se midio.';

  let runs = 0; let lineas = 0;
  await db.query('BEGIN');
  try {
    if (REEMPLAZAR) {
      const { rowCount: borradas } = await db.query(
        `DELETE FROM commercial.commission_run_lines l
           USING commercial.commission_runs r
          WHERE l.run_id = r.id AND r.tenant_id = $1 AND r.origen = 'libro'`, [TENANT]);
      const { rowCount: borradasR } = await db.query(
        `DELETE FROM commercial.commission_runs WHERE tenant_id = $1 AND origen = 'libro'`, [TENANT]);
      console.log(`  reemplazo: ${borradasR} corrida(s) y ${borradas} linea(s) previas borradas`);
    }
    for (const q of [...porPeriodo.keys()].sort((a, b) => a - b)) {
      const g = porPeriodo.get(q);
      const p = porNo.get(q);
      const pagables = g.filter((x) => x.a_pagar !== null);
      const { rows: [run] } = await db.query(
        `INSERT INTO commercial.commission_runs
           (tenant_id, period_id, scale_id, status, origen,
            total_subtotal, total_venta, total_comision, total_a_pagar,
            total_deduccion, total_neto, dias_multifuente,
            rutas_con_dato, rutas_sin_dato, rutas_fuera, gates, data_as_of, notes, paid_at)
         VALUES ($1,$2,$3,'pagado','libro',$4,$5,$6,$7,
                 NULL, NULL, NULL,
                 $8, $9, NULL, $10::jsonb, NULL, $11, $12::date)
         RETURNING id`,
        [TENANT, p.id, escala.id,
          // En centavos enteros: sumar flotantes y redondear al final fue lo que dejó el total
          // de la corrida 3 centavos arriba de la suma de sus propias líneas.
          sumC(g, 'subtotal'), sumC(g, 'venta'),
          sumC(pagables, 'comision'), sumC(pagables, 'a_pagar'),
          g.length,
          // ⚠️ `rutas_sin_dato` es NOT NULL con default 0, y mandarle NULL aborta la carga
          // entera (lo descubrió el primer `--apply`: es justo el hueco que el candado de
          // [RD.50] DECLARA que no cubre — mide existencia de columna, no NOT NULL).
          // ⭐ Pero no hace falta dibujar un cero: esto SÍ es medible en el libro — cuántas de
          // las rutas configuradas no tienen renglón en esta quincena. Es un conteo de lo que
          // el libro contiene, no una afirmación sobre POR QUÉ falta (eso el libro no lo dice,
          // igual que el motor no distingue "no salió" de "se perdió el día").
          mapa.length - g.length,
          JSON.stringify([{ gate: 'origen', estado: 'no_medido', detalle: 'espejo del libro: no paso por las compuertas del motor' }]),
          NOTA, p.pay_date ?? p.date_to]);
      runs++;
      for (const f of g) {
        const c = porRuta.get(f.route_code) || {};
        await db.query(
          `INSERT INTO commercial.commission_run_lines
             (tenant_id, run_id, route_code, beneficiario, beneficiario_nombre, zona,
              subtotal, venta, costo, markup_sobre_costo_pct, pct_aplicado,
              comision, bonos, bonos_detalle, nomina_banco, a_pagar, motivo_no_pago,
              subtotal_origen, costo_status, venta_arbitro, costo_veredicto,
              dias_multifuente, dias_con_venta, dias_esperados, deduccion_status)
           VALUES ($1,$2,$3,'chofer',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,
                   'libro','libro','libro','libro', NULL, NULL, NULL, $17)`,
          [TENANT, run.id, f.route_code, c.chofer_nombre ?? null, c.zona ?? null,
            f.subtotal, f.venta, f.costo, f.markup, f.pct_aplicado,
            f.comision ?? 0, f.bonos ?? 0,
            JSON.stringify(BONOS_CHOFER
              .filter((b) => f.motivo_no_pago === null && (f.venta ?? 0) >= b.umbral)
              .map((b) => ({ nombre: b.nombre, monto: b.monto, metrica: 'venta', umbral: b.umbral }))),
            f.nomina_banco ?? 0, f.a_pagar ?? 0, f.motivo_no_pago,
            f.nomina_banco ? 'aplicada' : 'no_aplica']);
        lineas++;
      }
    }
    // ⭐ CANDADO: el total de cada corrida tiene que ser la suma de SUS PROPIAS lineas. Dos
    // campos del mismo hecho salen del mismo calculo -- la primera carga los dejo discrepando
    // 3 centavos porque sumaba flotantes por periodo y redondeaba al final.
    const { rows: malas } = await db.query(
      `SELECT p.period_no, r.total_comision, r.total_a_pagar,
              coalesce(sum(l.comision) FILTER (WHERE l.motivo_no_pago IS NULL), 0) sc,
              coalesce(sum(l.a_pagar)  FILTER (WHERE l.motivo_no_pago IS NULL), 0) sp
         FROM commercial.commission_runs r
         JOIN commercial.commission_periods p ON p.id = r.period_id
         LEFT JOIN commercial.commission_run_lines l ON l.run_id = r.id
        WHERE r.tenant_id = $1 AND r.origen = 'libro'
        GROUP BY p.period_no, r.total_comision, r.total_a_pagar
       HAVING r.total_comision <> coalesce(sum(l.comision) FILTER (WHERE l.motivo_no_pago IS NULL), 0)
           OR r.total_a_pagar  <> coalesce(sum(l.a_pagar)  FILTER (WHERE l.motivo_no_pago IS NULL), 0)`,
      [TENANT]);
    if (malas.length) {
      for (const m of malas) {
        console.error(`  ✖ Q${m.period_no}: corrida ${m.total_comision}/${m.total_a_pagar} vs lineas ${m.sc}/${m.sp}`);
      }
      throw new Error(`${malas.length} corrida(s) no cuadran con sus lineas`);
    }
    console.log('  ✔ las 20 corridas cuadran EXACTO con la suma de sus lineas');
    await db.query('COMMIT');
    console.log(`\n✔ cargado: ${runs} corrida(s) · ${lineas} linea(s) de chofer\n`);
  } catch (e) {
    await db.query('ROLLBACK');
    console.error(`\n⛔ ROLLBACK — ${e.message}\n`);
    process.exitCode = 1;
  }
  await db.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
