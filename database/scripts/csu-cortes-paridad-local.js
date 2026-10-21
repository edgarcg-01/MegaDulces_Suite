/* eslint-disable no-console */
/**
 * `[CSU.10]` Paridad de CASOS BORDE de Cortes/Sucursales: la SQL de antes (un LATERAL por corte) y la
 * nueva (agregados + una consulta de cobros) deben devolver lo MISMO, campo por campo.
 *
 *   PGPASSWORD=… node database/scripts/csu-cortes-paridad-local.js            → PARIDAD OK (exit 0)
 *   PGPASSWORD=… node database/scripts/csu-cortes-paridad-local.js --mutar    → PARIDAD ROTA (exit 1)
 *   [--antes=<ref git>]   versión vieja contra la que se compara (default: la de antes de CSU.10)
 *
 * Contra la base LOCAL (`LOCAL_DB_URL`, default 127.0.0.1:5442), en UNA transacción que termina en
 * ROLLBACK: no deja filas. `--mutar` quita el casado por folio del corte en `ap` — la prueba negativa:
 * si eso no pone la paridad en rojo, la paridad no está midiendo nada.
 *
 * Los casos: cobro sin fila en la vista (detalle null), el mismo folio de corte y de cobro en dos
 * sucursales, aplicación en la réplica de otra plaza, corte sin cobros, corte en blanco (< $1),
 * devolución cancelada, devolución a 6 días y nota U-A-35 (las tres fuera).
 */
const { Client } = require('pg');
const L = require('./_lib/csu-cortes-sql');

const MUTAR = process.argv.includes('--mutar');
const MUTAR_CANCELADO = process.argv.includes('--mutar=cancelado');
const ANTES = (process.argv.find((a) => a.startsWith('--antes=')) || '').slice(8) || L.ANTES_CSU10;
/** `[CSU.11]` El cobro cancelado de las fixtures: la versión de antes lo contaba; la de ahora NO debe. */
const CANCELADO = { sucursal: '05', folio: '0000009' };

/**
 * Lo que la versión de antes DEBERÍA haber devuelto si hubiera excluido cancelados: sin esa aplicación
 * y con `cobrado` recalculado. Montos a número en las dos salidas (pg devuelve `sum` como texto).
 */
function normalizar(filas, quitarCancelado) {
  return filas.map((f) => {
    let cobros = f.cobros ? f.cobros.map((x) => ({ ...x, monto: Number(x.monto) })) : null;
    if (quitarCancelado && cobros && f.sucursal === CANCELADO.sucursal) {
      cobros = cobros.filter((x) => x.folio !== CANCELADO.folio);
      if (!cobros.length) cobros = null;
    }
    const cobrado = quitarCancelado ? Math.round((cobros || []).reduce((t, x) => t + x.monto, 0) * 100) / 100 : Number(f.cobrado);
    return { ...f, cobros, cobrado };
  });
}

async function fixtures(c) {
  const kdue = (suc, c1, folio, fecha, monto, ref) => c.query(
    `INSERT INTO kepler_ods.kdue (sucursal, c1, c2, c3, c4, c5, c6, c7, c11, c16, c29) VALUES ($1,$2,'CONTADO','D',23,1,$3,$4,$5,$6,'C')`,
    [suc, c1, folio, fecha, monto, ref]);
  await kdue('05', '05', '0000101', '2026-10-03', 12728.61, 'Caja 2-171'); // 2 cobros + devoluciones
  await kdue('05', '05', '0000102', '2026-10-03', 1203.36, 'Caja 5-151');  // sin cobros
  await kdue('05', '05', '0000103', '2026-10-04', 0.01, 'Caja 1-90');      // en blanco
  await kdue('02', '02', '0000101', '2026-10-05', 5000, 'Caja 1-12');      // mismo folio, otra sucursal
  await kdue('02', '05', '0000999', '2026-10-05', 777, 'Caja 9-9');        // réplica cruzada: fuera

  const kdm5 = (suc, c1, cobro, corte, monto) => c.query(
    `INSERT INTO kepler_ods.kdm5 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c13) VALUES ($1,$2,'U','A',5,1,$3,1,'D',23,1,$4,$5)`,
    [suc, c1, cobro, corte, monto]);
  await kdm5('05', '05', '0000003', '0000101', 1907.62);
  await kdm5('05', '05', '0000004', '0000101', 421.63); // sin fila en kdm1 → detalle null
  await kdm5('02', '02', '0000003', '0000101', 5000);   // mismo folio de cobro, otra sucursal
  await kdm5('02', '05', '0000077', '0000102', 99);     // réplica cruzada: fuera

  const cobro = (suc, folio, fecha, monto, concepto) => c.query(
    `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c24, c32, c45) VALUES ($1,$1,'U','A',5,1,$2,$3,'CONTADO',$4,$5,'PUBLICO','7')`,
    [suc, folio, fecha, monto, concepto]);
  await cobro('05', '0000003', '2026-10-04', 1907.62, 'PAGO CON TARJETA');
  await cobro('02', '0000003', '2026-10-06', 5000, 'DEPOSITO BANCO');
  // [CSU.11] Cobro CANCELADO en Kepler: cabecera c43='C' y c16=0, pero la aplicación conserva el monto.
  await kdm5('05', '05', CANCELADO.folio, '0000101', 500);
  await c.query(
    `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c24, c32, c43, c45) VALUES ('05','05','U','A',5,1,$1,'2026-10-04','CONTADO',0,'PAGO CANCELADO','PUBLICO','C','7')`,
    [CANCELADO.folio]);
  await c.query(`INSERT INTO kepler_ods.kdb1 (sucursal, c1, c2, c3, c5) VALUES ('05','7','BANCO PRUEBA','012345678901234567','102-01')`);

  const devol = (c4, folio, fecha, monto, cancel) => c.query(
    `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c32, c43, c67, c80, c81) VALUES ('05','05','U','A',$1,1,$2,$3,$4,'DEVOLUCION','CLIENTE X',$5,'CAJ1','171','2')`,
    [c4, folio, fecha, monto, cancel]);
  await devol(21, '0000071', '2026-10-03', 179.92, null);
  await devol(25, '0000005', '2026-10-04', 10, null);    // +1 día: entra
  await devol(21, '0000072', '2026-10-03', 50, 'C');     // cancelada: fuera
  await devol(21, '0000073', '2026-10-09', 60, null);    // 6 días: fuera
  await devol(35, '0000001', '2026-10-03', 70, null);    // U-A-35: fuera

  const cc = (wh, caja, folio, fecha, ef, cajero) => c.query(
    `INSERT INTO analytics.cash_cuts (tenant_id, warehouse_code, warehouse_name, caja, folio, business_date, efectivo_esperado, efectivo_contado, cajero_cierre)
     VALUES ($1,$2,'Suc '||$2,$3,$4,$5,$6,$6,$7)`, [L.TENANT, wh, caja, folio, fecha, ef, cajero]);
  await cc('05', '2', '171', '2026-10-03', 12908.53, 'A1');
  await cc('05', '5', '151', '2026-10-02', 10067.30, 'B1');
  await cc('02', '1', '12', '2026-10-05', 5000, 'C1');
}

(async () => {
  const sql = L.sqlNueva();
  if (MUTAR_CANCELADO) {
    const roto = sql.SQL.replace('JOIN analytics.kepler_kdm5_vigente m', 'JOIN kepler_ods.kdm5 m'); // vuelve a la tabla cruda
    if (roto === sql.SQL) throw new Error('--mutar=cancelado no encontró el filtro: la mutación no se aplicó');
    sql.SQL = roto;
  } else if (MUTAR) {
    // Rompe el casado aplicación↔corte comparando contra el TURNO en vez del folio. ⚠️ No QUITAR la
    // condición: sin ella cada corte se une con todas las aplicaciones de su sucursal y, sobre datos a
    // escala, la consulta corrió 44 min sin terminar (medido 2026-10-21) — un negativo que no termina
    // no prueba nada.
    const roto = sql.SQL.replace('AND btrim(m.c11) = co.folio', 'AND btrim(m.c11) = co.turno');
    if (roto === sql.SQL) throw new Error('--mutar no encontró qué romper: la mutación no se aplicó');
    sql.SQL = roto;
  }
  const vieja = L.sqlVieja(ANTES);
  const c = new Client({ connectionString: L.urlLocal(), application_name: 'csu10-paridad-local' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await L.vistaCobrosAlDia(c);
    await fixtures(c);
    const p = ['2026-10-01', '2026-10-31'];
    const a = (await c.query(vieja, L.paramsVieja(...p))).rows;
    const b = (await L.nueva(c, sql, ...p)).filas;
    const cobros = a.flatMap((x) => x.cobros || []);
    console.log(`vieja (${ANTES}): ${a.length} filas · nueva: ${b.length} filas`);
    console.log(`cobros ${cobros.length} (con detalle ${cobros.filter((x) => x.forma_pago).length}) · devoluciones ${a.flatMap((x) => x.devoluciones || []).length}`);
    const viejaContabaCancelado = cobros.some((x) => x.folio === CANCELADO.folio);
    if (!a.length || !cobros.length) { console.log('NO MEDIDO: las fixtures no produjeron filas'); process.exitCode = 1; }
    else if (!viejaContabaCancelado) { console.log('NO MEDIDO: la versión de antes no traía el cobro cancelado; el caso no se ejercitó'); process.exitCode = 1; }
    else {
      // Esperado = lo de antes MENOS el cobro cancelado (CSU.11); todo lo demás, idéntico.
      const esperado = normalizar(a, true), obtenido = normalizar(b, false);
      if (L.iguales(esperado, obtenido)) console.log('PARIDAD OK: salida idéntica campo por campo, salvo el cobro cancelado (que ya no suma)');
      else { console.log('PARIDAD ROTA'); console.log(L.diferencias(esperado, obtenido).join('\n')); process.exitCode = 1; }
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); console.error('NO MEDIDO: la prueba no llegó a comparar (esto NO es un rojo de paridad)'); process.exit(2); });
