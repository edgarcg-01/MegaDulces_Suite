/* eslint-disable no-console */
/**
 * `[PR.M5]` — Carga el **Cubo** de la entrega de ISCAM: NUESTRA venta por producto y sucursal.
 *
 *   node database/importers/import-iscam-cubo.js "C:/ISCAMPRECIOS/Entregables ISCAM Jul26 ..."
 *   node database/importers/import-iscam-cubo.js <carpeta> --apply
 *
 * Sin `--apply` sólo mide y reporta: nada se escribe.
 *
 * ── Qué trae, y por qué no se puede derivar ───────────────────────────────────────────────
 * **445,310 registros · 31 meses (ene-2024 → jul-2026) · 11 nombres de sucursal · 8,207
 * presentaciones**, con `Vol` y `Val` por celda y taxonomía de siete niveles.
 *
 * ⭐ Es **el único lugar de la plataforma donde existe** la venta de Morelia Abastos antes de
 * sep-2026, la de 8 Esquinas / Yurécuaro / Zamora Centro antes de ene-2026, y la de 2024 entera:
 * `analytics.sales_daily` no las tiene. No sale del ODS porque ahí no está.
 *
 * ⛔ Los DOS Cubos de la entrega (CM y SubCanales) traen medidas **idénticas** — $1,885.44M y
 * 9,018,964 unidades los dos — y sólo difieren en la etiqueta de subcanal. Se carga uno, y el
 * cargador **comprueba** que el otro coincide antes de dar por buena esa afirmación.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL ya viene del entorno */ }

const DST = process.env.DATABASE_URL_NEW;
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CARPETA = process.argv[2];
const APLICAR = process.argv.includes('--apply');
const MES = { Ene: 1, Feb: 2, Mar: 3, Abr: 4, May: 5, Jun: 6, Jul: 7, Ago: 8, Sep: 9, Oct: 10, Nov: 11, Dic: 12 };

/**
 * ⭐ El mapeo de nombre de ISCAM a nuestro almacén, **declarado y con fecha**, no adivinado.
 *
 * ⛔ Las tres primeras NO se mapean a propósito: hasta ene-2025 ISCAM agregaba en TRES plazas y
 *    desde feb-2025 desagrega en ocho. Una plaza agregada no es una sucursal nuestra, y
 *    asignarle una inventaría una serie que nadie midió.
 */
const MAPA = {
  'LA PIEDAD': { code: null, nota: 'plaza agregada hasta ene-2025; desde feb-2025 ISCAM la parte en 8 Esquinas y La Piedad Abastos' },
  MORELIA: { code: null, nota: 'plaza agregada hasta ene-2025; desde feb-2025 ISCAM la parte en Morelia Abastos y Morelia Madero' },
  ZAMORA: { code: null, nota: 'plaza agregada hasta ene-2025' },
  'SUCURSAL PADRE HIDALGO': { code: '01', nota: null },
  'SUCURSAL LA PIEDAD ABASTOS': { code: '02', nota: null },
  'SUCURSAL 8 ESQUINAS': { code: '03', nota: null },
  YURECUARO: { code: '04', nota: null },
  'ZAMORA CENTRO': { code: '05', nota: null },
  'SUCURSAL CANINDO ABASTOS': { code: '06', nota: null },
  'SUCURSAL MORELIA MADERO': { code: '07', nota: null },
  'SUCURSAL MORELIA ABASTOS': { code: '08', nota: null },
};

function entradaDelZip(zip, nombre) {
  return new Promise((resolve, reject) => {
    yauzl.open(zip, { lazyEntries: true }, (err, zf) => {
      if (err) return reject(err);
      let hallada = false;
      zf.on('entry', (e) => {
        if (e.fileName !== nombre) return zf.readEntry();
        hallada = true;
        zf.openReadStream(e, (err2, rs) => {
          if (err2) return reject(err2);
          const trozos = [];
          rs.on('data', (d) => trozos.push(d));
          rs.on('end', () => { zf.close(); resolve(Buffer.concat(trozos).toString('utf8')); });
          rs.on('error', reject);
        });
      });
      zf.on('end', () => { if (!hallada) reject(new Error('el archivo no trae ' + nombre)); });
      zf.on('error', reject);
      zf.readEntry();
    });
  });
}

async function leerCache(zip) {
  const def = await entradaDelZip(zip, 'xl/pivotCache/pivotCacheDefinition1.xml');
  const campos = [...def.matchAll(/<cacheField name="([^"]+)"[\s\S]*?(?=<cacheField |<\/cacheFields>)/g)];
  const dims = [];
  for (const m of campos) {
    if (/formula="/.test(m[0])) continue;
    dims.push({
      nombre: m[1].trim(),
      vals: [...m[0].matchAll(/<s v="([^"]*)"/g)].map((v) => v[1]
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')),
    });
  }
  const pos = Object.fromEntries(dims.map((d, i) => [d.nombre, i]));
  const xml = await entradaDelZip(zip, 'xl/pivotCache/pivotCacheRecords1.xml');
  const declarados = Number((/recordCount="(\d+)"/.exec(def) || [])[1] || 0);
  return { dims, pos, xml, declarados };
}

/**
 * ⛔⛔ Tokeniza TODOS los hijos del registro, no sólo `<x>` y `<n>`.
 *
 * Es la misma trampa que en el SURF: un lector que sólo reconoce dos tipos y filtra por
 * cantidad de hijos descarta registros enteros **y las cifras que quedan son plausibles**.
 * Lo único que lo delata es contar lo leído contra el `recordCount` declarado.
 */
function* registros(xml, nCampos) {
  const re = /<r>([\s\S]*?)<\/r>/g;
  let m;
  while ((m = re.exec(xml))) {
    const c = [...m[1].matchAll(/<([a-z]+)(?:\s+v="([^"]*)")?\s*\/>/g)]
      .map((h) => ({ tipo: h[1], valor: h[1] === 'm' ? null : h[2] }));
    if (c.length !== nCampos) continue;
    yield c;
  }
}

/** El empaque y el gramaje viven en el TEXTO: "... [32 D/100 P] - 2.8 Grs". */
function desglosar(detalle) {
  const dp = /\[\s*([\d.]+)\s*D\s*\/\s*([\d.]+)\s*P\s*\]/i.exec(detalle || '');
  const gr = /-\s*([\d.]+)\s*(Grs|Ml|Kg|Lt|Pzs)\b/i.exec(detalle || '');
  return {
    d: dp ? Number(dp[1]) : null,
    p: dp ? Number(dp[2]) : null,
    gramaje: gr ? Number(gr[1]) : null,
    unidad: gr ? gr[2] : null,
  };
}

function cuboDe(carpeta, patron) {
  const dir = path.join(carpeta, 'Cubos');
  const f = fs.readdirSync(dir).find((x) => patron.test(x));
  return f ? path.join(dir, f) : null;
}

(async () => {
  if (!CARPETA) throw new Error('falta la carpeta de la entrega');
  if (APLICAR && !DST) throw new Error('falta DATABASE_URL_NEW');
  const entrega = path.basename(CARPETA.replace(/[\\/]+$/, ''));
  console.log('entrega: ' + entrega + (APLICAR ? '  [APLICA]' : '  [solo mide]'));

  const cm = cuboDe(CARPETA, /Cubo ISCAM CM .*\.xlsx$/i);
  const sc = cuboDe(CARPETA, /Cubo ISCAM SubCanales .*\.xlsx$/i);
  if (!cm) throw new Error('no se encontro el Cubo CM en ' + path.join(CARPETA, 'Cubos'));

  console.log('\nleyendo Cubo CM …');
  const C = await leerCache(cm);
  for (const n of ['Sucursal', 'MesAnio', 'ProductoDetalle', 'Vol', 'Val']) {
    if (C.pos[n] === undefined) throw new Error('el Cubo no trae el campo ' + n + ': la entrega cambio de forma');
  }

  const celdas = new Map();
  let leidos = 0;
  let sinMes = 0;
  const sucsVistas = new Set();
  for (const c of registros(C.xml, C.dims.length)) {
    leidos++;
    // ⛔ El lector tiene que mirar el TIPO del hijo. Las dimensiones vienen como indice al
    //   diccionario (`<x v="7"/>`), pero Vol y Val no tienen diccionario -- llegan como numero
    //   directo (`<n v="123.4"/>`). Un lector que siempre busca en el diccionario devuelve
    //   undefined para las medidas y las carga como CERO, sin fallar.
    //   ⭐ Lo cazo el control de los dos Cubos: uno dio $1,885.44M y el otro $0.00M.
    const g = (n) => {
      const x = c[C.pos[n]];
      if (!x || x.valor === null) return null;
      return x.tipo === 'x' ? C.dims[C.pos[n]].vals[+x.valor] : x.valor;
    };
    const etiqueta = g('MesAnio');
    const mm = /_(\w{3})\/(\d\d)$/.exec(etiqueta || '');
    if (!mm || !MES[mm[1]]) { sinMes++; continue; }
    const periodo = `20${mm[2]}-${String(MES[mm[1]]).padStart(2, '0')}-01`;
    const suc = g('Sucursal');
    sucsVistas.add(suc);
    const dimTupla = ['ProductoDetalle', 'CodBar', 'Producto', 'Segmento', 'Categoria',
      'SubCategoria', 'Fabricante', 'Marca', 'SubMarca'].map((n) => g(n) || '');
    const hash = crypto.createHash('md5').update(dimTupla.join('\u0001')).digest('hex');
    const k = periodo + '\u0001' + suc + '\u0001' + hash;
    const a = celdas.get(k) || { periodo, suc, hash, dim: dimTupla, vol: 0, val: 0 };
    a.vol += Number(g('Vol')) || 0;
    a.val += Number(g('Val')) || 0;
    celdas.set(k, a);
  }
  if (C.declarados && leidos < C.declarados) {
    throw new Error('el lector se comio ' + (C.declarados - leidos) + ' registros: NO se carga a medias');
  }
  console.log('  registros leidos: ' + leidos.toLocaleString('es-MX')
    + ' de ' + C.declarados.toLocaleString('es-MX') + ' declarados'
    + (sinMes ? ' · sin mes legible: ' + sinMes : ''));
  console.log('  celdas a cargar: ' + celdas.size.toLocaleString('es-MX')
    + ' (se fusionaron ' + (leidos - sinMes - celdas.size).toLocaleString('es-MX') + ' por tupla repetida)');

  // ⭐ Una sucursal nueva NO se carga con mapeo en blanco y en silencio: se grita.
  const desconocidas = [...sucsVistas].filter((s) => !(s in MAPA));
  if (desconocidas.length) {
    throw new Error('la entrega trae sucursales que el mapeo no conoce: ' + desconocidas.join(', ')
      + '. Agregalas a MAPA con su codigo, o con code:null y el motivo.');
  }

  const totVal = [...celdas.values()].reduce((a, x) => a + x.val, 0);
  const totVol = [...celdas.values()].reduce((a, x) => a + x.vol, 0);
  const meses = [...new Set([...celdas.values()].map((x) => x.periodo))].sort();
  console.log(`  Val $${(totVal / 1e6).toFixed(2)}M · Vol ${Math.round(totVol).toLocaleString('es-MX')}`);
  console.log(`  meses: ${meses.length} · de ${meses[0]} a ${meses[meses.length - 1]}`);
  console.log(`  sucursales: ${sucsVistas.size} · sin mapear a proposito: `
    + [...sucsVistas].filter((s) => !MAPA[s].code).join(', '));

  // ⭐ El control: la afirmacion "los dos Cubos son identicos" se COMPRUEBA, no se repite.
  if (sc) {
    const S = await leerCache(sc);
    let v2 = 0;
    let l2 = 0;
    for (const c of registros(S.xml, S.dims.length)) {
      l2++;
      v2 += Number(c[S.pos.Val].valor) || 0;
    }
    if (S.declarados && l2 < S.declarados) throw new Error('el lector se comio registros del Cubo SubCanales');
    const dif = Math.abs(v2 - totVal);
    console.log(`  ⭐ control: Cubo SubCanales $${(v2 / 1e6).toFixed(2)}M · diferencia $${dif.toFixed(2)}`);
    if (dif > 1) {
      throw new Error('los dos Cubos NO coinciden (diferencia $' + dif.toFixed(2)
        + '): deja de ser cierto que da igual cual se cargue. Hay que decidir cual y por que.');
    }
  } else {
    console.log('  — NO MEDIDO: no esta el Cubo SubCanales, no se pudo comprobar que coincidan');
  }

  if (!APLICAR) {
    console.log('\nnada escrito. Volve a correr con --apply para cargar.');
    return;
  }

  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${TENANT}'`);

    const COLS = 22;
    const LOTE = 300;
    const filas = [...celdas.values()];
    let n = 0;
    for (let i = 0; i < filas.length; i += LOTE) {
      const trozo = filas.slice(i, i + LOTE);
      const vals = [];
      const args = [];
      trozo.forEach((f, j) => {
        const [detalle, codbar, producto, segmento, categoria, subcategoria,
          fabricante, marca, submarca] = f.dim;
        const e = desglosar(detalle);
        const map = MAPA[f.suc];
        const b = j * COLS;
        vals.push('(' + Array.from({ length: COLS }, (_, x) => '$' + (b + x + 1)).join(',') + ')');
        args.push(TENANT, f.periodo, f.suc, map.code, map.nota, f.hash,
          codbar || null, detalle, producto || null, segmento || null, categoria || null,
          subcategoria || null, fabricante || null, marca || null, submarca || null,
          e.d, e.p, e.gramaje, e.unidad, f.vol, f.val, entrega);
      });
      // Vol y Val viajan YA sumados por celda: la tupla de dimensiones puede repetirse dentro
      // del mismo mes y sucursal, y sumarlas acá es lo que evita una PK que no existe.
      await db.query(`
        INSERT INTO analytics.iscam_sales
          (tenant_id, periodo, sucursal_iscam, warehouse_code, mapeo_nota, dim_hash,
           codbar, producto_detalle, producto, segmento, categoria, subcategoria,
           fabricante, marca, submarca, empaque_d, empaque_p, gramaje, gramaje_unidad,
           vol, val, entrega)
        VALUES ${vals.join(',')}
        ON CONFLICT (tenant_id, periodo, sucursal_iscam, dim_hash)
        DO UPDATE SET warehouse_code = EXCLUDED.warehouse_code, mapeo_nota = EXCLUDED.mapeo_nota,
                      vol = EXCLUDED.vol, val = EXCLUDED.val,
                      entrega = EXCLUDED.entrega, importado_at = now()`, args);
      n += trozo.length;
      if (n % 60000 < LOTE) console.log('    … ' + n.toLocaleString('es-MX') + ' celdas');
    }

    await db.query('COMMIT');
    console.log(`\nOK · ${n.toLocaleString('es-MX')} celdas · ${meses.length} meses · entrega ${entrega}`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
