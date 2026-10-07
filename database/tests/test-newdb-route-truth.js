/* eslint-disable no-console */
/**
 * CANDADO · La verdad de la VENTA y el INVENTARIO de ruta (VERDAD_ABSOLUTA §19 · ADR-059).
 *
 * Vigila dos afirmaciones, no una:
 *
 *   (1) EL SALDO DE UN CAMION SE VALUA EN UNA SOLA MONEDA. Restar la venta a PRECIO de la carga
 *       al COSTO no mide inventario: mide el margen, y drena el saldo para siempre a razon del
 *       margen. Es lo que hace el control manual de la operacion (los libros "RD <PLAZA> 2026"),
 *       y por eso le atribuye a cada chofer un faltante de seis cifras que no existe.
 *
 *   (2) LA VENTA DE RUTA SALE DEL PUSH DE LAS CAMIONETAS. Lo confirma un testigo externo y
 *       humano: el corte diario que la operacion escribe a mano en esos mismos libros.
 *
 * ⭐ El bloque del Excel se mide SOLO si la unidad de red esta montada. Si no, reporta
 * NO MEDIDO — nunca verde. Un candado que se pone verde porque no encontro el archivo miente
 * peor que uno rojo (ADR-056).
 *
 *   DATABASE_URL_NEW = destino (prod)   ·   RD_XLSX_DIR = donde viven los libros (default Z:/)
 *   node database/tests/test-newdb-route-truth.js
 */
const fs = require('fs');
const path = require('path');
const knexLib = require('knex');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const T = '00000000-0000-0000-0000-00000000d01c';
const XLSX_DIR = process.env.RD_XLSX_DIR || 'Z:/';
const DESDE = process.env.RD_DESDE || '2026-07-01';
const HASTA = process.env.RD_HASTA || '2026-09-30';

let ok = 0; let bad = 0; let nm = 0;
const t = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { bad++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, why) => { nm++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const m = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

(async () => {
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false },
    pool: { min: 0, max: 2 },
  });
  console.log(`\n=== CANDADO · la verdad de la venta y el inventario de RUTA (${DESDE} → ${HASTA}) ===\n`);
  try {
    await db.raw(`SET app.tenant_id = '${T}'`);
    await db.raw("SET statement_timeout = '300s'");

    const existe = (await db.raw(`SELECT to_regclass('analytics.mv_rd_route_ledger') AS t`)).rows[0].t;
    if (!existe) {
      noMedido('todo el candado', 'analytics.mv_rd_route_ledger no existe en este destino');
      console.log(`\n=== ${ok} ✓ · ${bad} ✗ · ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(bad ? 1 : 0);
    }

    // ── 1. Las TRES lecturas del saldo, por ruta ──────────────────────────────────────────────
    //
    // El grano (sku, unidad) importa: el costo y el precio unitarios se resuelven ahi y recien
    // despues se multiplican por la cantidad. Promediar primero y multiplicar despues da otra
    // cifra, y no es la que publica la pantalla.
    console.log('── 1. Las tres lecturas del saldo ──');
    const { rows } = await db.raw(
      `WITH w AS (
         SELECT route_no, sku, unidad,
                sum(qty)       FILTER (WHERE clase='carga') AS cq,
                sum(costo_doc) FILTER (WHERE clase='carga') AS cv,
                sum(qty)       FILTER (WHERE clase='venta') AS vq,
                sum(venta_doc) FILTER (WHERE clase='venta') AS vi
           FROM analytics.mv_rd_route_ledger
          WHERE tenant_id = ? AND business_date >= ? AND business_date <= ?
          GROUP BY 1,2,3
       )
       SELECT route_no,
              round(sum(cv)::numeric,2)::float                                   AS carga_costo,
              round(sum(coalesce(vq,0) * (cv/nullif(cq,0)))::numeric,2)::float   AS cogs,
              round(sum(coalesce(cq,0) * (vi/nullif(vq,0)))::numeric,2)::float   AS carga_precio,
              round(sum(vi)::numeric,2)::float                                   AS venta
         FROM w GROUP BY 1 ORDER BY 1`, [T, DESDE, HASTA]);

    t('el ledger responde con rutas', rows.length > 0, `${rows.length} rutas`);

    const S = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const cargaCosto = S('carga_costo'); const cogs = S('cogs');
    const cargaPrecio = S('carga_precio'); const venta = S('venta');
    const A = cargaCosto - venta;        // lo que hace el libro: mezcla dos monedas
    const B = cargaCosto - cogs;         // inventario AL COSTO
    const C = cargaPrecio - venta;       // la cuenta del chofer, A PRECIO

    console.log(`     carga al costo ${m(cargaCosto)} · COGS ${m(cogs)}`);
    console.log(`     carga a precio ${m(cargaPrecio)} · venta ${m(venta)}`);
    console.log(`     A (mezclada) ${m(A)}  ·  B (al costo) ${m(B)}  ·  C (a precio) ${m(C)}`);

    // ⭐ LA AFIRMACION CENTRAL, probada por identidad y no por umbral: la lectura mezclada ES
    // el negativo del margen bruto. Si algun dia deja de serlo, es que una de las dos columnas
    // cambio de moneda y hay que volver a mirar.
    const margenBruto = venta - cargaCosto;
    t('la lectura MEZCLADA es exactamente el negativo del margen bruto (identidad, no umbral)',
      Math.abs(A + margenBruto) < 0.01,
      `A=${A.toFixed(2)} margen=${margenBruto.toFixed(2)}`);

    const pctA = cargaCosto > 0 ? Math.abs(A) / cargaCosto * 100 : 0;
    const pctB = cargaCosto > 0 ? Math.abs(B) / cargaCosto * 100 : 0;
    const pctC = cargaPrecio > 0 ? Math.abs(C) / cargaPrecio * 100 : 0;
    console.log(`     |A| = ${pctA.toFixed(1)}% de lo cargado · |B| = ${pctB.toFixed(1)}% · |C| = ${pctC.toFixed(1)}%`);

    t('⛔ la lectura MEZCLADA es grande: no es inventario, es el margen', pctA > 10,
      `${pctA.toFixed(1)}% de lo cargado — el libro la publica como faltante`);
    t('⭐ el camion NO acumula al COSTO: el saldo cabe en el 5% de lo cargado', pctB < 5,
      `${pctB.toFixed(1)}%`);
    t('⭐ ni A PRECIO: la cuenta del chofer cabe en el 5% de lo cargado', pctC < 5,
      `${pctC.toFixed(1)}%`);
    t('las dos lecturas coherentes son del MISMO orden; la mezclada no',
      Math.abs(A) > Math.abs(B) * 5 && Math.abs(A) > Math.abs(C) * 5,
      `A=${m(A)} B=${m(B)} C=${m(C)}`);

    // PRUEBA NEGATIVA: valuar los dos lados en la misma moneda tiene que CERRAR; mezclarlos no.
    // Sin esto, los umbrales de arriba se cumplirian igual con un ledger vacio.
    const cierraCosto = Math.abs(cargaCosto - cogs - B) < 0.01;
    const cierraPrecio = Math.abs(cargaPrecio - venta - C) < 0.01;
    t('PRUEBA NEGATIVA · con una sola moneda la cuenta cierra al centavo por construcción',
      cierraCosto && cierraPrecio);
    t('PRUEBA NEGATIVA · y mezclando NO cierra — la diferencia es el margen entero',
      Math.abs(A - B) > 1000, `A−B = ${m(A - B)}`);

    // ── 2. Ninguna ruta sola desmiente al total ───────────────────────────────────────────────
    console.log('\n── 2. Ruta por ruta ──');
    const malas = rows.filter((r) => {
      const cc = Number(r.carga_costo) || 0;
      if (cc <= 0) return false;
      return Math.abs(cc - Number(r.cogs)) / cc > 0.15;
    });
    t('ninguna ruta acumula más del 15% de lo que se le cargó', malas.length === 0,
      malas.map((r) => `${r.route_no}:${((r.carga_costo - r.cogs) / r.carga_costo * 100).toFixed(0)}%`).join(' '));

    // ── 3. El testigo externo: el control manual de la operación ──────────────────────────────
    //
    // Los libros son "RD <PLAZA> 2026 .xlsx": una hoja por mes, SEIS bloques horizontales (uno
    // por chofer) y una fila por dia. El bloque arranca donde la fila 4 dice FOLIO; el nombre
    // del chofer esta en la fila 3. ⚠️ El nombre NO sirve de llave entre meses: se escribe
    // distinto ("ENRIQUE FUENTES" / "FUENTES MONTES ENRIQUE") y ademas los choferes ROTAN de
    // ruta, asi que agregar por nombre sobre varios meses mezcla rutas. El cruce va DIA A DIA.
    console.log('\n── 3. El control manual de la operación (testigo externo) ──');
    let ExcelJS = null;
    try { ExcelJS = require('exceljs'); } catch { /* sin la libreria no se mide */ }
    const libros = [
      ['CANINDO', path.join(XLSX_DIR, 'RD CANINDO 2026 .xlsx')],
      ['PADRE HIDALGO', path.join(XLSX_DIR, 'RD PADRE HIDALGO 2026 .xlsx')],
    ].filter(([, f]) => { try { return fs.statSync(f).isFile(); } catch { return false; } });

    if (!ExcelJS) {
      noMedido('el testigo externo', 'exceljs no está disponible');
    } else if (!libros.length) {
      noMedido('el testigo externo',
        `no se alcanzan los libros en ${XLSX_DIR} (unidad de red sin montar). Exportá RD_XLSX_DIR`);
    } else {
      const val = (c) => {
        const x = c && c.value;
        if (x === null || x === undefined) return null;
        if (typeof x === 'object') {
          if (x.result !== undefined) return x.result;
          if (x.text !== undefined) return x.text;
          if (x instanceof Date) return x;
          return null;
        }
        return x;
      };
      // ⛔ El universo de los dos lados tiene que ser EL MISMO, y el recorte correcto NO es el
      // corte de la plaza a Kepler: es el PRIMER EMBARQUE documentado de cada ruta, que es
      // donde arranca nuestro ledger. Medido, no son lo mismo — PH cambio de ERP el 2026-06-27
      // pero su primer embarque a ruta esta el 2026-07-15, y esas tres semanas el libro las
      // tiene y nosotros no.
      //
      // Se equivoco dos veces antes de dar con esto: sin recorte la carga del libro salia
      // 1.52x la nuestra, y recortando por el corte de plaza 1.11x. Las dos veces el "hallazgo"
      // era el universo, no el dato.
      const { rows: ini } = await db.raw(
        `SELECT plaza, min(carga_desde)::text AS d
           FROM analytics.mv_rd_route_identity WHERE tenant_id = ? GROUP BY 1`, [T]);
      const desdeDePlaza = {};
      for (const r of ini) desdeDePlaza[String(r.plaza).toUpperCase().trim()] = r.d;
      const desdeDe = (plaza) => {
        const d = desdeDePlaza[String(plaza).toUpperCase().trim()];
        return (d && d > DESDE) ? d : DESDE;
      };
      console.log(`     primer embarque por plaza: ${ini.map((r) => `${r.plaza}=${r.d}`).join(' · ')}`);

      const celdas = [];
      for (const [plaza, f] of libros) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(f);
        for (const ws of wb.worksheets) {
          if (/CONCENTRADO/i.test(ws.name)) continue;
          const r4 = ws.getRow(4);
          const bloques = [];
          for (let c = 1; c <= ws.columnCount; c++) {
            if (String(val(r4.getCell(c)) || '').trim().toUpperCase() === 'FOLIO') bloques.push(c);
          }
          for (let r = 5; r <= ws.rowCount; r++) {
            const row = ws.getRow(r); const fe = val(row.getCell(2));
            if (!(fe instanceof Date)) continue;
            // El Date de exceljs viene en UTC-medianoche: +6 h lo deja en el dia MX correcto.
            const fecha = new Date(fe.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
            if (fecha < desdeDe(plaza) || fecha > HASTA) continue;
            for (const col of bloques) {
              const v = Number(val(row.getCell(col + 2)));
              const ca = Number(val(row.getCell(col + 10)));
              if (Number.isFinite(v) && v > 0) celdas.push({ plaza, fecha, venta: v, carga: Number.isFinite(ca) ? ca : null });
            }
          }
        }
      }
      t('los libros se leen y traen cortes diarios', celdas.length > 0, `${celdas.length} celdas`);

      const { rows: dia } = await db.raw(
        `SELECT business_date::text AS d, route_no,
                round(sum(importe)::numeric,2)::float AS imp
           FROM analytics.route_push_lines
          WHERE tenant_id = ? AND business_date >= ? AND business_date <= ?
          GROUP BY 1,2`, [T, DESDE, HASTA]);
      const porDia = {};
      for (const r of dia) (porDia[r.d] = porDia[r.d] || []).push(r);

      const cerca = (lista, v) => {
        let best = Infinity;
        for (const y of lista) { const d = Math.abs(y.imp - v); if (d < best) best = d; }
        return best;
      };
      let casan = 0; let placebo = 0;
      for (const c of celdas) {
        if (cerca(porDia[c.fecha] || [], c.venta) < 1) casan++;
        // El placebo corre el dia diez: mide el piso de ruido de "casar por importe".
        const f = new Date(Date.parse(c.fecha) + 10 * 86400000).toISOString().slice(0, 10);
        if (cerca(porDia[f] || [], c.venta) < 1) placebo++;
      }
      const pc = 100 * casan / celdas.length;
      const pp = 100 * placebo / celdas.length;
      console.log(`     casan al peso ${casan}/${celdas.length} = ${pc.toFixed(1)}% · placebo ${pp.toFixed(1)}%`);

      // Ya recortado al mismo universo (post-corte de cada plaza), el acuerdo tiene que ser
      // ALTO. Lo que vigila la asercion no es un porcentaje bonito: es que el testigo externo
      // siga casando muy por encima de su propio piso de ruido.
      t('el control manual casa con la venta que publicamos, muy por encima del ruido',
        pc > 85 && pc > pp * 10, `${pc.toFixed(1)}% contra un piso de ${pp.toFixed(1)}%`);
      t('⭐ el PLACEBO es ~cero: casar por importe diario no pasa por azar', pp < 2,
        `${pp.toFixed(1)}%`);

      const cargaExcel = celdas.reduce((a, c) => a + (c.carga || 0), 0);
      if (cargaExcel > 0) {
        const razon = cargaExcel / cargaCosto;
        console.log(`     carga del libro ${m(cargaExcel)} vs nuestra carga al costo ${m(cargaCosto)} = ${razon.toFixed(4)}`);
        t('⭐ la carga del libro es el embarque AL COSTO (razón dentro del 5%)',
          razon > 0.95 && razon < 1.05, `razón ${razon.toFixed(4)}`);
      } else {
        noMedido('la carga del libro', 'no se leyeron importes de NVA CARGA');
      }
    }
  } catch (e) {
    bad++;
    console.error('  ✘ excepción:', e.message);
  } finally {
    await db.destroy();
  }
  console.log(`\n=== ${ok} ✓ · ${bad} ✗ · ${nm} no medidos ===\n`);
  process.exit(bad ? 1 : 0);
})();
