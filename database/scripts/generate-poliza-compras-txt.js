/* eslint-disable no-console */
/**
 * LC.5 (Fase LC, ADR-052) — Genera el TXT de la póliza mensual de compras para que la
 * contadora lo importe a ContPAQi. **No escribimos nada en ContPAQi** (ADR-040): esto
 * produce un archivo, el trámite lo sigue haciendo ella.
 *
 * ── El layout (investigado y validado campo por campo contra la póliza real) ──────────
 * Longitud fija, campos separados por espacio, un renglón por movimiento.
 *   P  tipo(2 izq) fecha yyyyMMdd(8 der) tipoPol(4 der) folio(9 der) clase(1 der)
 *      diario(10 izq) concepto(100 izq) sistOrigen(2 der) impresa(1 der) ajuste(1 der)
 *   M  tipo(2 izq) cuenta sin guiones(30 izq) referencia(10 izq) tipoMovto(1 der)
 *      importe(20 izq) diario(10 izq) importeME(20 izq) concepto(100 izq) segNeg(10 izq)
 * `TipoPol 3` = Diario · `TipoMovto` **0 = cargo, 1 = abono** · `SistOrigen 11`.
 *
 * ── La estructura del asiento ────────────────────────────────────────────────────────
 * Por cada factura: cargo a `501<sufijo>` por la base exenta, cargo a `502<sufijo>` por la
 * base gravada de IVA, y abono a `212<sufijo>` por el total. Más los impuestos.
 *
 * ── Dos cosas que este generador hace mejor que el Excel ─────────────────────────────
 * 1. **`--impuestos por-cuenta`**: hoy el IVA y el IEPS entran en UN renglón global al mes
 *    cada uno, así que el acreditamiento no es auditable por proveedor. Con esta opción se
 *    postean por cuenta de proveedor. Cuesta ~90 renglones más al mes.
 * 2. **`--uuid`**: mete el folio fiscal en el `Concepto` del movimiento, que el layout deja
 *    libre y hoy va vacío en el 100% de las patas. Es la razón por la que las 5,521 patas
 *    de compras están sin CFDI asociado mientras el resto del diario va al 97%.
 *
 * ── Bases: `--bases cfdi` (default) vs `--bases legacy` ──────────────────────────────
 * El Excel calcula la base exenta por RESTA (`total − IVA − IEPS − base16`). El CFDI trae
 * la base gravable explícita por impuesto y tasa. Casi siempre coinciden; cuando no, la
 * diferencia son centavos de redondeo — salvo el caso del IEPS por cuota, donde el Excel
 * se equivoca de a de veras (ver EURO CANDY en el doc de la fase). Manda el CFDI; `legacy`
 * existe solo para poder reproducir el TXT histórico y compararlo.
 *
 * ── De dónde sale la lista de facturas ───────────────────────────────────────────────
 * `--uuids <archivo>` con un UUID por renglón. **Es provisional**: LC.2 (qué CFDI entra al
 * libro) sigue abierto, así que hoy la lista se toma del libro que la contadora ya armó.
 * Cuando LC.2 se resuelva, solo cambia de dónde sale la lista; el resto no se toca.
 *
 * Flags: --mes YYYY-MM · --uuids <archivo> · --out <archivo> · --folio N
 *        --impuestos global|por-cuenta · --bases cfdi|legacy · --uuid · --validar
 * Env: DATABASE_URL_NEW.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const MES = arg('--mes');
const UUIDS_FILE = arg('--uuids');
const OUT = arg('--out');
const FOLIO = Number(arg('--folio', 1));
const IMPUESTOS = arg('--impuestos', 'global');       // global | por-cuenta
const BASES = arg('--bases', 'cfdi');                 // cfdi | legacy
const CON_UUID = has('--uuid');
const VALIDAR = has('--validar');

const CTA_IVA = '1470040000';
const CTA_IEPS = '1470110000';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const padR = (s, n) => String(s ?? '').slice(0, n).padEnd(n, ' ');
const padL = (s, n) => String(s ?? '').slice(0, n).padStart(n, ' ');
/** ContPAQi pide entre 1 y 2 decimales; 6.5 y 6.53 son válidos, 6 no. */
const imp = (n) => {
  const v = r2(n);
  return Number.isInteger(v) ? `${v}.0` : v.toFixed(2);
};

/** Último día del mes — el asiento siempre va fechado ahí. */
const finDeMes = (mes) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)); };
const yyyymmdd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

const encabezado = (fecha, folio, concepto) => [
  padR('P', 2), padL(yyyymmdd(fecha), 8), padL('3', 4), padL(String(folio), 9), padL('1', 1),
  padR('0', 10), padR(concepto, 100), padL('11', 2), padL('0', 1), padL('0', 1),
].join(' ');

const movimiento = ({ cuenta, referencia, abono, importe, concepto }) => [
  padR('M', 2), padR(cuenta, 30), padR(referencia || '', 10), padL(abono ? '1' : '0', 1),
  padR(imp(importe), 20), padR('0', 10), padR('0.0', 20), padR(concepto || '', 100), padR('', 10),
].join(' ');

(async () => {
  if (!MES || !/^\d{4}-\d{2}$/.test(MES)) throw new Error('falta --mes YYYY-MM');
  if (!UUIDS_FILE) throw new Error('falta --uuids <archivo con un UUID por renglón>');

  const uuids = fs.readFileSync(UUIDS_FILE, 'utf8').split(/\r?\n/)
    .map((s) => s.trim().toUpperCase()).filter(Boolean);
  console.log(`Póliza de compras ${MES} · ${uuids.length} facturas · impuestos ${IMPUESTOS} · bases ${BASES}${CON_UUID ? ' · con UUID' : ''}`);

  const pg = new Client({ connectionString: DST, ssl: DST.includes('rlwy.net') ? { rejectUnauthorized: false } : false });
  await pg.connect();

  // DISTINCT ON: un RFC puede tener más de una cuenta en el mapa (razones sociales que
  // comparten RFC), y sin esto el join duplicaría el renglón de esa factura.
  const { rows } = await pg.query(`
    SELECT DISTINCT ON (upper(f.uuid))
           upper(f.uuid) uuid, f.emisor_rfc, f.emisor_nombre, f.folio, f.total, f.fecha,
           coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
           coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
           coalesce((f.impuestos->>'base_iva_16')::numeric, 0)     AS base16_fiscal,
           coalesce((f.impuestos->>'subtotal_iva_16')::numeric, 0) AS subtotal16,
           a.account_suffix, a.cuenta_proveedor, a.cuenta_compra_exenta, a.cuenta_compra_iva,
           a.proveedor_existe, a.compra_exenta_existe, a.compra_iva_existe
      FROM fiscal.cfdis f
      LEFT JOIN finance.gl_supplier_accounts a
        ON a.tenant_id = f.tenant_id AND a.rfc = f.emisor_rfc AND a.deleted_at IS NULL
     WHERE f.tenant_id = $1 AND upper(f.uuid) = ANY($2::text[])
     ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`, [TENANT, uuids]);
  console.log(`  ${rows.length} CFDIs resueltos en fiscal.cfdis`);

  // ── Frenos: mejor no generar el archivo que generarlo mal ────────────────────────────
  const faltantes = uuids.filter((u) => !rows.some((r) => r.uuid === u));
  const sinMapa = rows.filter((r) => !r.account_suffix);
  const ctaMala = rows.filter((r) => r.account_suffix && r.proveedor_existe === false);
  if (faltantes.length) console.error(`  ⚠️ ${faltantes.length} UUID de la lista no están en fiscal.cfdis`);
  if (sinMapa.length) console.error(`  ⚠️ ${sinMapa.length} CFDIs sin proveedor en el mapa: ${[...new Set(sinMapa.map((r) => r.emisor_rfc))].slice(0, 5).join(', ')}`);
  if (ctaMala.length) console.error(`  ⚠️ ${ctaMala.length} CFDIs cuya cuenta de pasivo no existe en ContPAQi`);
  if (faltantes.length || sinMapa.length || ctaMala.length) {
    await pg.end();
    throw new Error('no se genera el TXT con renglones que ContPAQi va a rechazar — resuélvelo primero');
  }

  // ── Armado de los movimientos ────────────────────────────────────────────────────────
  const movs = [];
  let sumaCargos = 0, sumaAbonos = 0;
  const ivaPorCuenta = new Map(), iepsPorCuenta = new Map();

  for (const f of rows.sort((a, b) => (a.fecha < b.fecha ? -1 : 1))) {
    const total = r2(f.total), iva = r2(f.iva), ieps = r2(f.ieps);
    // Lo que se carga a la cuenta 502 es el SUBTOTAL de lo gravado a 16%, no la base fiscal
    // del IVA — esa incluye al IEPS y lo contaría dos veces. `legacy` usa la base fiscal
    // justamente para reproducir el TXT histórico, con su error incluido.
    const base16 = BASES === 'legacy' ? r2(f.base16_fiscal) : r2(f.subtotal16);
    // Lo demás del subtotal va a la cuenta de compras exentas. Sale por diferencia contra
    // el total, que es la única cifra que el CFDI garantiza: subtotal + traslados = total.
    const baseExenta = r2(total - iva - ieps - base16);
    const concepto = CON_UUID ? f.uuid : '';
    const ref = String(f.folio || '').slice(0, 10);

    if (baseExenta > 0.004) {
      movs.push({ cuenta: f.cuenta_compra_exenta, referencia: ref, abono: false, importe: baseExenta, concepto });
      sumaCargos += baseExenta;
    }
    if (base16 > 0.004) {
      if (!f.compra_iva_existe) throw new Error(`${f.emisor_nombre} tiene base 16% pero no existe la cuenta ${f.cuenta_compra_iva}`);
      movs.push({ cuenta: f.cuenta_compra_iva, referencia: ref, abono: false, importe: base16, concepto });
      sumaCargos += base16;
    }
    movs.push({ cuenta: f.cuenta_proveedor, referencia: ref, abono: true, importe: total, concepto });
    sumaAbonos += total;

    if (iva > 0.004) ivaPorCuenta.set(f.account_suffix, r2((ivaPorCuenta.get(f.account_suffix) || 0) + iva));
    if (ieps > 0.004) iepsPorCuenta.set(f.account_suffix, r2((iepsPorCuenta.get(f.account_suffix) || 0) + ieps));
  }

  const totalIva = r2([...ivaPorCuenta.values()].reduce((a, b) => a + b, 0));
  const totalIeps = r2([...iepsPorCuenta.values()].reduce((a, b) => a + b, 0));

  if (IMPUESTOS === 'por-cuenta') {
    // Mismas cuentas de impuesto, pero un renglón por proveedor: el acreditamiento queda
    // auditable sin abrir el Excel. La referencia lleva el sufijo para poder rastrearlo.
    for (const [suf, monto] of [...ivaPorCuenta].sort()) {
      movs.push({ cuenta: CTA_IVA, referencia: suf, abono: false, importe: monto, concepto: 'IVA acreditable' });
    }
    for (const [suf, monto] of [...iepsPorCuenta].sort()) {
      movs.push({ cuenta: CTA_IEPS, referencia: suf, abono: false, importe: monto, concepto: 'IEPS acreditable' });
    }
  } else {
    if (totalIva > 0.004) movs.push({ cuenta: CTA_IVA, referencia: '', abono: false, importe: totalIva, concepto: '' });
    if (totalIeps > 0.004) movs.push({ cuenta: CTA_IEPS, referencia: '', abono: false, importe: totalIeps, concepto: '' });
  }
  sumaCargos = r2(sumaCargos + totalIva + totalIeps);
  sumaAbonos = r2(sumaAbonos);

  const neto = r2(sumaCargos - sumaAbonos);
  console.log(`\n  cargos ${sumaCargos.toLocaleString('es-MX')} · abonos ${sumaAbonos.toLocaleString('es-MX')} · neto ${neto}`);
  if (Math.abs(neto) >= 0.01) { await pg.end(); throw new Error(`la póliza NO cuadra por ${neto} — no se genera`); }

  const fecha = finDeMes(MES);
  const concepto = `REGISTRO DE COMPRAS DEL MES ${MES}`;
  const lineas = [encabezado(fecha, FOLIO, concepto), ...movs.map(movimiento)];
  console.log(`  ${movs.length} movimientos · ${lineas.length} renglones`);

  const destino = OUT || path.resolve(process.cwd(), `poliza-compras-${MES}.txt`);
  fs.writeFileSync(destino, lineas.join('\r\n') + '\r\n', 'latin1');
  console.log(`  ✅ ${destino}`);

  // ── Validación contra la póliza que ya está en ContPAQi ──────────────────────────────
  if (VALIDAR) {
    const real = (await pg.query(`
      SELECT cuenta, cargo_abono, importe FROM analytics.gl_poliza_lines
       WHERE tenant_id=$1 AND source='contpaqi' AND tipo_pol='3' AND folio='1' AND anio_mes=$2`,
    [TENANT, MES])).rows;
    const clave = (c, ab, i) => `${c}|${ab}|${Math.round(Number(i) * 100)}`;
    const gen = new Map(), act = new Map();
    movs.forEach((m) => { const k = clave(m.cuenta, m.abono ? 'A' : 'C', m.importe); gen.set(k, (gen.get(k) || 0) + 1); });
    real.forEach((m) => { const k = clave(m.cuenta, m.cargo_abono, m.importe); act.set(k, (act.get(k) || 0) + 1); });
    let casan = 0, soloGen = 0, soloReal = 0;
    for (const k of new Set([...gen.keys(), ...act.keys()])) {
      const g = gen.get(k) || 0, a = act.get(k) || 0;
      casan += Math.min(g, a); soloGen += Math.max(0, g - a); soloReal += Math.max(0, a - g);
    }
    console.log('\n  == contra la póliza real en ContPAQi ==');
    console.table([{ 'patas generadas': movs.length, 'patas en ContPAQi': real.length,
      casan, 'solo en el generado': soloGen, 'solo en ContPAQi': soloReal }]);
  }
  await pg.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
