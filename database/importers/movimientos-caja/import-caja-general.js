/* eslint-disable no-console */
/**
 * Fase CG.2 — Importer del sistema Access de Finanzas → analytics.caja_*.
 *
 * Lee READ-ONLY los .mdb de \\192.168.0.245\D (Z:) vía el extractor PowerShell
 * (extract-mdb.ps1, ACE.OLEDB.16.0) → JSONL, y hace UPSERT churn-free (sin DELETE)
 * a las tablas espejo. Ver [reference_movimientos_finanzas_access].
 *
 * Espina (Sistema B "Base Movimientos SI"): venta diaria → depósito bancario +
 * catálogos (bancos = crosswalk CB, sucursales = almacen→empresa).
 * Detalle (Sistema A "BMovimientosCajas"): arqueo de caja 20 por denominación.
 *
 * Guardas de landmines: fechas basura (año fuera de 2009-2027) filtradas en la
 * query Access Y en Node; rezago de captura preservado (venta_date vs capture_date).
 *
 *   node database/importers/movimientos-caja/import-caja-general.js            # dry-run
 *   node database/importers/movimientos-caja/import-caja-general.js --apply    # commit
 *   node database/importers/movimientos-caja/import-caja-general.js --apply --instance NO
 *   node database/importers/movimientos-caja/import-caja-general.js --apply --only arqueos
 */

const { Client } = require('pg');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const INSTANCE = (arg('--instance', 'SI') || 'SI').toUpperCase();     // SI | NO
const ONLY = arg('--only', null);                                     // ventas|depositos|catalogos|arqueos

// Rutas de los .mdb (Z: = \\192.168.0.245\D). Override por env para prod/otra máquina.
const BASE_DIR = process.env.CAJA_BASE_DIR || 'Z:\\Datos\\Movimientos MegaDulces';
const BASE_MDB = process.env[`CAJA_MDB_${INSTANCE}`] || path.join(BASE_DIR, INSTANCE, `Base Movimientos ${INSTANCE}.mdb`);
const ARQUEO_MDB = process.env.CAJA_ARQUEO_20 || 'Z:\\Datos\\20 Comisionistas\\MegaDulces\\BMovimientosCajas.mdb';
const ARQUEO_CAJA = process.env.CAJA_ARQUEO_CAJA || '20';
// CG.2 — Caja General VIVA (Doctos en BDatos.mdb, backend Wincaja de Comisionistas).
const DOCTOS_MDB = process.env.CAJA_DOCTOS_MDB || 'Z:\\Datos\\20 Comisionistas\\Dulceria\\BDatos.mdb';
const DOCTOS_CAJA = process.env.CAJA_DOCTOS_CAJA || '20';
const DOCTOS_FROM = process.env.CAJA_DOCTOS_FROM || '#01/01/2026#'; // scope: ene-2026 → hoy (Edgar)

const PS = 'powershell';
const EXTRACTOR = path.join(__dirname, 'extract-mdb.ps1');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'caja-'));

const DATE_LO = '#01/01/2009#';
const DATE_HI = '#12/31/2027#';
const TIPO_PAGO = { 1: 'Transferencia', 2: 'Cheque', 3: 'Efectivo', 4: 'Nota De Credito', 5: 'Comision', 6: 'Automatico', 7: 'Cheque Real' };
const TIPO_ARQUEO = { 1: 'Arqueo', 2: 'Retiro', 3: 'Corte', 4: 'Deposito', 5: 'Fondo Caja', 6: 'Mixto' };
const DENOM_COLS = ['B1000', 'B500', 'B200', 'B100', 'B50', 'B20', 'M100', 'M20', 'M10', 'M5', 'M2', 'M1', 'M50C', 'M20C', 'M10C', 'M5C', 'Centavos'];
const TIPO_DTO = { 1: 'Ingreso', 2: 'Gasto', 3: 'Deposito', 6: 'Misc' };
const DOCTOS_DENOM = ['B1000', 'B500', 'B200', 'B100', 'B50', 'B20', 'M20', 'M10', 'M5', 'M2', 'M1', 'M05', 'M02', 'M01', 'Mor'];

/** Corre el extractor PS para una query y devuelve el array de objetos. */
function extract(mdb, query, tag) {
  const out = path.join(TMP, `${tag}.jsonl`);
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXTRACTOR, '-Mdb', mdb, '-Query', query, '-Out', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) { throw new Error(`extractor [${tag}] falló: ${r.stderr || r.stdout}`); }
  if (!fs.existsSync(out)) return [];
  const rows = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  console.log(`  · extract ${tag}: ${rows.length} filas`);
  return rows;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const bool = (v) => v === true || v === 'True' || v === 1 || v === '1';
const txt = (v) => { const s = (v == null ? '' : String(v)).trim(); return s || null; };

/** ISO → 'YYYY-MM-DD' solo si el año ∈ [2009,2027]; si no, null (landmine de fechas basura). */
function cleanDate(v) {
  const s = String(v || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  return (y >= 2009 && y <= 2027) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Hora del día desde un datetime Access (ej. '1899-12-30T13:58:20' → '13:58:20'). */
function hhmm(v) {
  const m = String(v || '').match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/** UPSERT churn-free genérico: stage temp + INSERT..ON CONFLICT DO UPDATE WHERE distinct. */
async function upsert(db, table, cols, pk, rows) {
  if (!rows.length) return 0;
  // Dedupe por PK (la fuente Access repite Control/ID) — última fila gana. Sin esto,
  // Postgres tira "ON CONFLICT no puede afectar una fila por segunda vez".
  const pkCols = pk.filter((c) => c !== 'tenant_id');
  const seen = new Map();
  for (const r of rows) seen.set(pkCols.map((c) => r[c]).join(''), r);
  rows = [...seen.values()];
  const stg = `stg_${table.split('.').pop()}`;
  const colList = cols.join(',');
  await db.query(`CREATE TEMP TABLE ${stg} (LIKE ${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
  const insCols = ['tenant_id', ...cols, 'computed_at'];
  const NC = insCols.length;
  for (let i = 0; i < rows.length; i += 800) {
    const chunk = rows.slice(i, i + 800);
    const vals = chunk.map((_, ri) => `(${insCols.map((__, k) => (k === 0 ? `'${M}'` : k === NC - 1 ? 'now()' : `$${ri * (NC - 2) + (k - 1) + 1}`)).join(',')})`);
    const params = [];
    chunk.forEach((row) => cols.forEach((c) => params.push(row[c] ?? null)));
    await db.query(`INSERT INTO ${stg} (${insCols.join(',')}) VALUES ${vals.join(',')}`, params);
  }
  const upd = cols.filter((c) => !pk.includes(c));
  const setClause = upd.map((c) => `${c}=EXCLUDED.${c}`).concat('computed_at=now()').join(',');
  const distinctL = upd.map((c) => `t.${c}`).join(',');
  const distinctR = upd.map((c) => `EXCLUDED.${c}`).join(',');
  const res = await db.query(
    `INSERT INTO ${table} AS t (${insCols.join(',')})
       SELECT ${insCols.join(',')} FROM ${stg}
     ON CONFLICT (${pk.join(',')}) DO UPDATE SET ${setClause}
     WHERE (${distinctL}) IS DISTINCT FROM (${distinctR})`);
  return res.rowCount;
}

(async () => {
  console.log(`\n=== Fase CG — Movimientos Caja Finanzas → analytics.caja_* (${APPLY ? 'APPLY' : 'DRY-RUN'}) · instancia ${INSTANCE}${ONLY ? ` · only ${ONLY}` : ''} ===\n`);

  const want = (k) => !ONLY || ONLY === k;

  // --- extract + map ---
  let sucRows = [], bancoRows = [], ventaRows = [], depRows = [], arqRows = [];
  const empresaByAlm = {};
  const bancoName = {};

  if (want('catalogos') || want('ventas') || want('depositos')) {
    console.log(`Base Movimientos ${INSTANCE}: ${BASE_MDB}`);
    const suc = extract(BASE_MDB, 'SELECT Almacen, Empresa, [Nom Completo] AS NomCompleto, [Nom Corto] AS NomCorto, EsNomina FROM [0 T Sucursales]', 'sucursales');
    const bancos = extract(BASE_MDB, 'SELECT ID2, Banco, EsBanco, EsCuenta, EsCheques FROM [0 T Tipos Bancos]', 'bancos');
    // catálogo sucursales (dedupe por almacen, gana la fila con empresa)
    const sucMap = {};
    for (const r of suc) {
      const a = txt(r.Almacen); if (!a) continue;
      if (!sucMap[a] || (!sucMap[a].empresa && txt(r.Empresa))) {
        sucMap[a] = { source_instance: INSTANCE, almacen: a, empresa: txt(r.Empresa), nombre: txt(r.NomCompleto), nombre_corto: txt(r.NomCorto), es_nomina: bool(r.EsNomina) };
      }
      if (txt(r.Empresa)) empresaByAlm[a] = txt(r.Empresa);
    }
    sucRows = Object.values(sucMap);
    for (const r of bancos) {
      const code = txt(r.ID2); if (!code) continue;
      bancoName[code] = txt(r.Banco);
      bancoRows.push({ source_instance: INSTANCE, banco_code: code, banco_name: txt(r.Banco), es_banco: bool(r.EsBanco), es_cuenta: bool(r.EsCuenta), es_cheques: bool(r.EsCheques), bank_account_label: null });
    }
  }

  if (want('ventas')) {
    const vd = extract(BASE_MDB,
      `SELECT Control, Almacen, VentaDiariaFecha, CapturaFecha, NombreCapturo, VentaDiariaTotal,
              Efectivo, EfectivoDeposito, Morralla, MorrallaDepositos, Cheques, ChequesDepositos,
              Tarjeta, TarjetaDeposito, CajaChica, CajaChicaDeposito, TotalSobreGiro, TotalSobreGiroDepositos,
              Desglose, Revisado, Eliminado, Observaciones
         FROM [4 T VentasDiarias]
        WHERE VentaDiariaFecha BETWEEN ${DATE_LO} AND ${DATE_HI}`, 'ventas');
    ventaRows = vd.map((r) => {
      const alm = txt(r.Almacen) || '?';
      return {
        source_instance: INSTANCE, control: txt(r.Control), empresa: empresaByAlm[alm] || null, almacen: alm,
        venta_date: cleanDate(r.VentaDiariaFecha), capture_date: cleanDate(r.CapturaFecha), captured_by: txt(r.NombreCapturo),
        venta_total: num(r.VentaDiariaTotal),
        efectivo: num(r.Efectivo), efectivo_deposito: num(r.EfectivoDeposito),
        morralla: num(r.Morralla), morralla_deposito: num(r.MorrallaDepositos),
        cheques: num(r.Cheques), cheques_deposito: num(r.ChequesDepositos),
        tarjeta: num(r.Tarjeta), tarjeta_deposito: num(r.TarjetaDeposito),
        caja_chica: num(r.CajaChica), caja_chica_deposito: num(r.CajaChicaDeposito),
        sobregiro: num(r.TotalSobreGiro), sobregiro_deposito: num(r.TotalSobreGiroDepositos),
        desglose: num(r.Desglose), revisado: bool(r.Revisado), eliminado: bool(r.Eliminado), observaciones: txt(r.Observaciones),
      };
    }).filter((r) => r.control);
  }

  if (want('depositos')) {
    const dp = extract(BASE_MDB,
      `SELECT ID, Control, Almacen, BancoDepositado, BancoCuenta, FechaDeposito, FechaDepositoReal, Tipo,
              TotalDeposito, TotalDepositoReal, Comision, IVA, RevisadoFYH, EliminadoFYH, Observaciones
         FROM [4 T VentasDiarias 1 Depositos]
        WHERE FechaDeposito BETWEEN ${DATE_LO} AND ${DATE_HI}`, 'depositos');
    depRows = dp.map((r) => {
      const code = txt(r.BancoDepositado);
      return {
        source_instance: INSTANCE, deposito_id: txt(r.ID), control: txt(r.Control), almacen: txt(r.Almacen),
        banco_code: code, banco_name: bancoName[code] || null, banco_cuenta: txt(r.BancoCuenta),
        deposito_date: cleanDate(r.FechaDeposito), deposito_date_real: cleanDate(r.FechaDepositoReal),
        tipo_pago_code: txt(r.Tipo), tipo_pago: TIPO_PAGO[num(r.Tipo)] || null,
        total_deposito: num(r.TotalDeposito), total_deposito_real: num(r.TotalDepositoReal),
        comision: num(r.Comision), iva: num(r.IVA),
        revisado: !!txt(r.RevisadoFYH), eliminado: !!txt(r.EliminadoFYH), observaciones: txt(r.Observaciones),
      };
    }).filter((r) => r.deposito_id);
  }

  if (want('arqueos')) {
    console.log(`Arqueo caja ${ARQUEO_CAJA}: ${ARQUEO_MDB}`);
    const aq = extract(ARQUEO_MDB,
      `SELECT ID, Folio, MovimientoPrincipal, Almacen, Caja, MovimientoFecha, Capturo,
              TotalBilletes, TotalMonedas, TotalEfectivo, TotalCredito, TotalCheques, TotalTarjeta, TotalDolares, MovimientoTotal,
              ${DENOM_COLS.join(', ')}, Revisado, Cancelado, Observaciones
         FROM [0 T Movimientos]
        WHERE MovimientoFecha BETWEEN ${DATE_LO} AND ${DATE_HI}`, 'arqueos');
    arqRows = aq.map((r) => {
      const denom = {}; DENOM_COLS.forEach((c) => { denom[c] = num(r[c]); });
      return {
        source_caja: ARQUEO_CAJA, mov_id: txt(r.ID), folio: txt(r.Folio),
        tipo: TIPO_ARQUEO[num(r.MovimientoPrincipal)] || null, almacen: txt(r.Almacen), caja: txt(r.Caja),
        arqueo_date: cleanDate(r.MovimientoFecha), capturo: txt(r.Capturo),
        total_billetes: num(r.TotalBilletes), total_monedas: num(r.TotalMonedas), total_efectivo: num(r.TotalEfectivo),
        total_credito: num(r.TotalCredito), total_cheques: num(r.TotalCheques), total_tarjeta: num(r.TotalTarjeta),
        total_dolares: num(r.TotalDolares), mov_total: num(r.MovimientoTotal), denom: JSON.stringify(denom),
        revisado: bool(r.Revisado), cancelado: bool(r.Cancelado), observaciones: txt(r.Observaciones),
      };
    }).filter((r) => r.mov_id);
  }

  // --- CG.2: Caja General VIVA (Doctos + Cuenta), scope ene-2026 → hoy ---
  let cuentaRows = [], doctosRows = [];
  if (want('doctos')) {
    console.log(`Caja General (Doctos): ${DOCTOS_MDB}  [desde ${DOCTOS_FROM}]`);
    const cta = extract(DOCTOS_MDB, 'SELECT IdCuenta, NombreCuenta, NombreLargoCta, NivelCta, GrupoCta, AcumulaACta, AfectableCta FROM [Cuenta]', 'cuentas');
    cuentaRows = cta.map((r) => ({
      source_caja: DOCTOS_CAJA, id_cuenta: txt(r.IdCuenta), nombre: txt(r.NombreCuenta), nombre_largo: txt(r.NombreLargoCta),
      nivel: num(r.NivelCta), grupo: txt(r.GrupoCta), acumula_a: txt(r.AcumulaACta), afectable: bool(r.AfectableCta),
    })).filter((r) => r.id_cuenta);
    const ctaName = {}; for (const r of cuentaRows) ctaName[r.id_cuenta] = r.nombre;

    const dc = extract(DOCTOS_MDB,
      `SELECT TipoDto, IdDocto, Fecha, HoraD, UsuarioD, Cuenta, NombreCliente, ObservDocto,
              Ingreso, Gasto, Deposito, Efectivo, SaldoD, Corte, DolarD, TipoCambD,
              ${DOCTOS_DENOM.join(', ')}
         FROM [Doctos] WHERE Fecha >= ${DOCTOS_FROM} AND Fecha < #01/01/2027#`, 'doctos');
    doctosRows = dc.map((r) => {
      const denom = {}; DOCTOS_DENOM.forEach((k) => { denom[k] = num(r[k]); });
      const cuenta = txt(r.Cuenta);
      return {
        source_caja: DOCTOS_CAJA, tipo_dto: num(r.TipoDto), mov_id: txt(r.IdDocto),
        tipo: TIPO_DTO[num(r.TipoDto)] || null, fecha: cleanDate(r.Fecha), hora: hhmm(r.HoraD), usuario: txt(r.UsuarioD),
        cuenta, cuenta_nombre: cuenta ? (ctaName[cuenta] || null) : null,
        nombre_cliente: txt(r.NombreCliente), concepto: txt(r.ObservDocto),
        ingreso: num(r.Ingreso), gasto: num(r.Gasto), deposito: num(r.Deposito), efectivo: num(r.Efectivo),
        denom: JSON.stringify(denom), saldo: num(r.SaldoD), corte: bool(r.Corte), dolar: num(r.DolarD), tipo_cambio: num(r.TipoCambD),
      };
    }).filter((r) => r.mov_id && r.fecha);
  }

  // --- resumen ---
  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  console.log(`\nResumen (${INSTANCE}):`);
  if (sucRows.length) console.log(`  sucursales: ${sucRows.length}`);
  if (bancoRows.length) console.log(`  bancos:     ${bancoRows.length}`);
  if (ventaRows.length) console.log(`  ventas:     ${ventaRows.length} · venta $${sum(ventaRows, 'venta_total').toLocaleString('es-MX', { maximumFractionDigits: 0 })} · descuadre Σ$${sum(ventaRows, 'desglose').toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);
  if (depRows.length) console.log(`  depositos:  ${depRows.length} · $${sum(depRows, 'total_deposito').toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);
  if (arqRows.length) console.log(`  arqueos:    ${arqRows.length} · efectivo Σ$${sum(arqRows, 'total_efectivo').toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);
  if (cuentaRows.length) console.log(`  cuentas:    ${cuentaRows.length} (plan de cuentas)`);
  if (doctosRows.length) console.log(`  caja gral:  ${doctosRows.length} movs · ingreso $${sum(doctosRows, 'ingreso').toLocaleString('es-MX', { maximumFractionDigits: 0 })} · gasto $${sum(doctosRows, 'gasto').toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); fs.rmSync(TMP, { recursive: true, force: true }); return; }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    let n = 0;
    if (sucRows.length) n += await upsert(db, 'analytics.caja_sucursales_catalog', ['source_instance', 'almacen', 'empresa', 'nombre', 'nombre_corto', 'es_nomina'], ['tenant_id', 'source_instance', 'almacen'], sucRows);
    if (bancoRows.length) n += await upsert(db, 'analytics.caja_bancos_catalog', ['source_instance', 'banco_code', 'banco_name', 'es_banco', 'es_cuenta', 'es_cheques', 'bank_account_label'], ['tenant_id', 'source_instance', 'banco_code'], bancoRows);
    if (ventaRows.length) n += await upsert(db, 'analytics.caja_ventas_diarias', ['source_instance', 'control', 'empresa', 'almacen', 'venta_date', 'capture_date', 'captured_by', 'venta_total', 'efectivo', 'efectivo_deposito', 'morralla', 'morralla_deposito', 'cheques', 'cheques_deposito', 'tarjeta', 'tarjeta_deposito', 'caja_chica', 'caja_chica_deposito', 'sobregiro', 'sobregiro_deposito', 'desglose', 'revisado', 'eliminado', 'observaciones'], ['tenant_id', 'source_instance', 'control'], ventaRows);
    if (depRows.length) n += await upsert(db, 'analytics.caja_depositos', ['source_instance', 'deposito_id', 'control', 'almacen', 'banco_code', 'banco_name', 'banco_cuenta', 'deposito_date', 'deposito_date_real', 'tipo_pago_code', 'tipo_pago', 'total_deposito', 'total_deposito_real', 'comision', 'iva', 'revisado', 'eliminado', 'observaciones'], ['tenant_id', 'source_instance', 'deposito_id'], depRows);
    if (arqRows.length) n += await upsert(db, 'analytics.caja_arqueos', ['source_caja', 'mov_id', 'folio', 'tipo', 'almacen', 'caja', 'arqueo_date', 'capturo', 'total_billetes', 'total_monedas', 'total_efectivo', 'total_credito', 'total_cheques', 'total_tarjeta', 'total_dolares', 'mov_total', 'denom', 'revisado', 'cancelado', 'observaciones'], ['tenant_id', 'source_caja', 'mov_id'], arqRows);
    if (cuentaRows.length) n += await upsert(db, 'analytics.caja_general_cuentas', ['source_caja', 'id_cuenta', 'nombre', 'nombre_largo', 'nivel', 'grupo', 'acumula_a', 'afectable'], ['tenant_id', 'source_caja', 'id_cuenta'], cuentaRows);
    if (doctosRows.length) n += await upsert(db, 'analytics.caja_general_movimientos', ['source_caja', 'tipo_dto', 'mov_id', 'tipo', 'fecha', 'hora', 'usuario', 'cuenta', 'cuenta_nombre', 'nombre_cliente', 'concepto', 'ingreso', 'gasto', 'deposito', 'efectivo', 'denom', 'saldo', 'corte', 'dolar', 'tipo_cambio'], ['tenant_id', 'source_caja', 'tipo_dto', 'mov_id'], doctosRows);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${n} filas escritas (nuevas/cambiadas). Sin DELETE (append-only).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
