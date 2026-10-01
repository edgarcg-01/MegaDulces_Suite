/**
 * `[PR.M1]` — Carga la entrega mensual de **ISCAM** (medicion de mercado, externa).
 *
 *   node database/importers/import-iscam.js "C:/ISCAMPRECIOS/Entregables ISCAM Jul26 1145DEFY61"
 *   node database/importers/import-iscam.js <carpeta> --apply
 *
 * Sin `--apply` sólo mide y reporta: nada se escribe.
 *
 * ── ⛔ Por que es un CLI y NO un feed agendado ─────────────────────────────────────────────
 * El archivo llega por correo una vez al mes y lo sube una persona. Un cron apuntando a una
 * carpeta que puede estar vacia, o que todavia tiene el mes anterior, **publicaria el mes viejo
 * como si fuera el nuevo** y nadie se enteraria: las cifras se ven igual de plausibles. La regla
 * principal del proyecto pide cero importers porque casi todo se puede derivar del ODS; esto no
 * se puede, y por eso entra como snapshot con la entrega en la llave y carga explicita.
 *
 * ── De donde sale cada cosa ────────────────────────────────────────────────────────────────
 *  · **SURF/*.xlsm** → `analytics.iscam_market`. Tiene las cuatro medidas (nuestras y del
 *    mercado, actual y anterior) por region/subcanal/mercado/division/categoria.
 *  · **Cubos/Cubo ISCAM SubCanales*.xlsx** → `analytics.iscam_taxonomy`. Es el unico que trae
 *    **codigo de barras**, y es lo que deja que una pantalla por SKU alcance un share por
 *    categoria.
 *
 * ⚠️ Los dos son cachés de tabla dinamica: el dato NO esta en la hoja, esta en
 *    `xl/pivotCache/pivotCacheRecords1.xml` y se decodifica con los indices de
 *    `pivotCacheDefinition1.xml`. La hoja visible muestra todos los filtros en "(Todas)".
 *
 * ⛔ **`PcioDisp` no se importa.** Su formula, leida del propio archivo, es `Val / Vol / 24`:
 *    un divisor FIJO de 24 para todo el catalogo. Parece un precio y no lo es.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL ya viene del entorno */ }

const DST = process.env.DATABASE_URL_NEW;
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CARPETA = process.argv[2];
const APLICAR = process.argv.includes('--apply');

const MESES = { Ene: 1, Feb: 2, Mar: 3, Abr: 4, May: 5, Jun: 6, Jul: 7, Ago: 8, Sep: 9, Oct: 10, Nov: 11, Dic: 12 };

/**
 * Saca UNA entrada del zip, por streaming.
 *
 * ⚠️ Con `unzip` del sistema funcionaba en esta maquina y NO en el contenedor de prod, que no
 *    lo trae. Un importador que depende de un binario del sistema corre donde lo probaste y
 *    falla donde se usa. `yauzl` ademas transmite la entrada en vez de cargar el zip entero:
 *    el cache de registros del SURF son 290 MB.
 */
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

/** Lee el cache de un xlsx/xlsm y devuelve {dims, registros}. Los calculados NO viajan. */
async function leerCache(zip) {
  const def = await entradaDelZip(zip, 'xl/pivotCache/pivotCacheDefinition1.xml');
  const campos = [...def.matchAll(/<cacheField name="([^"]+)"[\s\S]*?(?=<cacheField |<\/cacheFields>)/g)];
  const dims = [];
  for (const m of campos) {
    if (/formula="/.test(m[0])) continue;
    dims.push({
      nombre: m[1].trim(),
      vals: [...m[0].matchAll(/<s v="([^"]*)"/g)]
        .map((v) => v[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')),
    });
  }
  const pos = Object.fromEntries(dims.map((d, i) => [d.nombre, i]));
  const xml = await entradaDelZip(zip, 'xl/pivotCache/pivotCacheRecords1.xml');
  return { dims, pos, xml, defXml: def };
}

/**
 * ⛔⛔ Tokeniza TODOS los hijos del registro, no solo `<x>` y `<n>`.
 *
 * Medido el 2026-10-01: de los 1,500,880 registros del SURF hay **1,491,108 elementos `<m/>`**
 * (medida AUSENTE). Un parser que solo reconoce `<x>` y `<n>` deja esos registros con menos
 * hijos de los esperados y, si ademas filtra por cantidad, **los descarta enteros**: la primera
 * version de este lector se quedo con **9,772 de 1,500,880 registros, el 0.65%**, y publico un
 * share de 5.79% donde el real es 3.80%.
 *
 * ⚠️ Y la trampa es silenciosa: el subconjunto sobreviviente da cifras perfectamente plausibles.
 *    Lo unico que la delato fue contar los registros leidos contra el `recordCount` declarado.
 *
 * Devuelve cada hijo como `{ tipo, valor }`, con `valor === null` cuando el tipo es `m`.
 */
function* registros(xml, nCampos) {
  const re = /<r>([\s\S]*?)<\/r>/g;
  let m;
  while ((m = re.exec(xml))) {
    const c = [...m[1].matchAll(/<([a-z]+)(?:\s+v="([^"]*)")?\s*\/>/g)]
      .map((h) => ({ tipo: h[1], valor: h[1] === 'm' ? null : h[2] }));
    if (c.length !== nCampos) continue;   // forma inesperada: se declara abajo, no se adivina
    yield c;
  }
}

function archivoQueEmpieza(dir, prefijo, ext) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.startsWith(prefijo) && x.toLowerCase().endsWith(ext));
  return f ? path.join(dir, f) : null;
}

(async () => {
  if (!CARPETA) throw new Error('uso: import-iscam.js <carpeta de la entrega> [--apply]');
  if (!DST) throw new Error('DATABASE_URL_NEW obligatorio');
  if (!fs.existsSync(CARPETA)) throw new Error('no existe la carpeta: ' + CARPETA);

  const entrega = path.basename(CARPETA);
  console.log('entrega: ' + entrega + (APLICAR ? '  [APLICA]' : '  [solo mide, no escribe]'));

  const surf = archivoQueEmpieza(path.join(CARPETA, 'SURF'), 'SURF', '.xlsm');
  const cubo = archivoQueEmpieza(path.join(CARPETA, 'Cubos'), 'Cubo ISCAM SubCanales', '.xlsx');
  if (!surf) throw new Error('no se encontro el SURF en ' + path.join(CARPETA, 'SURF'));
  if (!cubo) throw new Error('no se encontro el Cubo SubCanales en ' + path.join(CARPETA, 'Cubos'));

  // ── 1 · El mercado, desde el SURF ───────────────────────────────────────────────────
  console.log('\nleyendo SURF …');
  const S = await leerCache(surf);
  const need = ['TipoMedida', 'TipoPeriodo', 'SubCanal', 'Mercado', 'Division', 'Categoria',
    'Región', 'MedActMayo', 'MedActMdo', 'MedAntMayo', 'MedAntMdo'];
  for (const n of need) {
    if (S.pos[n] === undefined) throw new Error('el SURF no trae el campo ' + n + ': la entrega cambio de forma');
  }
  const mkt = new Map();
  let leidos = 0, saltadosPeriodo = 0, sinMercado = 0;
  for (const c of registros(S.xml, S.dims.length)) {
    leidos++;
    const g = (n) => (c[S.pos[n]].valor === null ? null : S.dims[S.pos[n]].vals[+c[S.pos[n]].valor]);
    const tipoPeriodo = g('TipoPeriodo');
    // Sólo MES: RY (año móvil) y YTD son acumulados y mezclarlos duplicaría el mercado.
    if (tipoPeriodo !== 'MES') { saltadosPeriodo++; continue; }
    const medida = g('TipoMedida') === 'Valor' ? 'valor' : 'volumen';
    const k = [g('Región'), g('SubCanal'), g('Mercado'), g('Division'), g('Categoria'), medida].join('\u0001');
    const a = mkt.get(k) || { aMayo: 0, aMdo: 0, pMayo: 0, pMdo: 0 };
    // ⛔ Ausente NO es cero cuando es el MERCADO: sin denominador no hay share y la celda
    //    no se carga. Ausente en LO NUESTRO si es cero: significa que no vendimos nada.
    const aMdo = c[S.pos.MedActMdo].valor === null ? null : Number(c[S.pos.MedActMdo].valor);
    if (aMdo === null) { sinMercado++; continue; }
    const pMdo = c[S.pos.MedAntMdo].valor === null ? null : Number(c[S.pos.MedAntMdo].valor);
    a.aMayo += Number(c[S.pos.MedActMayo].valor) || 0;
    a.aMdo += aMdo;
    if (pMdo !== null) { a.pMayo += Number(c[S.pos.MedAntMayo].valor) || 0; a.pMdo += pMdo; }
    mkt.set(k, a);
  }
  // ⭐ Se compara contra el recordCount DECLARADO: es lo unico que delata un parser que se come
  //   registros en silencio. Sin esta linea, el bug de los <m/> no se habria notado nunca.
  const declarados = Number((/recordCount="(\d+)"/.exec(S.defXml) || [])[1] || 0);
  console.log('  registros leidos: ' + leidos.toLocaleString('es-MX')
    + ' de ' + declarados.toLocaleString('es-MX') + ' declarados');
  if (declarados && leidos < declarados) {
    throw new Error('el lector se comio ' + (declarados - leidos) + ' registros: NO se carga a medias');
  }
  console.log('  descartados por no ser MES: ' + saltadosPeriodo.toLocaleString('es-MX')
    + ' · sin mercado: ' + sinMercado.toLocaleString('es-MX')
    + ' · filas a cargar: ' + mkt.size.toLocaleString('es-MX'));

  // ⚠️ El SURF NO trae el mes en el registro: el periodo es el de la ENTREGA. Se toma del nombre
  //    de la carpeta ("… Jul26 …"), que es el unico lugar donde esta escrito.
  const mm = /\b(\w{3})(\d\d)\b/.exec(entrega);
  const periodo = mm && MESES[mm[1]] ? `20${mm[2]}-${String(MESES[mm[1]]).padStart(2, '0')}-01` : null;
  if (!periodo) throw new Error('no se pudo leer el periodo del nombre de la entrega: ' + entrega);
  console.log('  periodo: ' + periodo);

  // ── 2 · El puente, desde el Cubo ────────────────────────────────────────────────────
  console.log('\nleyendo Cubo SubCanales …');
  const C = await leerCache(cubo);
  for (const n of ['CodBar', 'Segmento', 'Categoria']) {
    if (C.pos[n] === undefined) throw new Error('el Cubo no trae el campo ' + n);
  }
  const tax = new Map();
  for (const c of registros(C.xml, C.dims.length)) {
    const g = (n) => (C.pos[n] === undefined || c[C.pos[n]].valor === null
      ? null : C.dims[C.pos[n]].vals[+c[C.pos[n]].valor]);
    const cb = g('CodBar');
    if (!cb || !/^\d{8,14}$/.test(cb) || tax.has(cb)) continue;
    tax.set(cb, {
      segmento: g('Segmento'), categoria: g('Categoria'), subcategoria: g('SubCategoria'),
      marca: g('Marca'), fabricante: g('Fabricante'),
    });
  }
  console.log('  codigos de barras con taxonomia: ' + tax.size.toLocaleString('es-MX'));

  if (!APLICAR) {
    console.log('\nnada escrito. Volve a correr con --apply para cargar.');
    return;
  }

  // ── 3 · Escritura, idempotente ──────────────────────────────────────────────────────
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${TENANT}'`);

    let nMkt = 0;
    for (const [k, v] of mkt) {
      const [region, subcanal, mercado, division, categoria, medida] = k.split('\u0001');
      // ⛔ El CHECK exige mercado >= nuestro. Si la entrega viene al reves se sabe acá y no
      //    tres pantallas despues; se reporta y se salta, nunca se "corrige" el numero.
      if (v.aMdo < v.aMayo || v.pMdo < v.pMayo) {
        console.log('  ⚠ saltada (mercado < nuestro): ' + [division, categoria, medida].join(' / '));
        continue;
      }
      await db.query(`
        INSERT INTO analytics.iscam_market
          (tenant_id, periodo, region, subcanal, mercado, division, categoria, tipo_medida,
           med_act_mayo, med_act_mdo, med_ant_mayo, med_ant_mdo, entrega)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (tenant_id, periodo, region, subcanal, mercado, division, categoria, tipo_medida)
        DO UPDATE SET med_act_mayo = EXCLUDED.med_act_mayo, med_act_mdo = EXCLUDED.med_act_mdo,
                      med_ant_mayo = EXCLUDED.med_ant_mayo, med_ant_mdo = EXCLUDED.med_ant_mdo,
                      entrega = EXCLUDED.entrega, importado_at = now()`,
        [TENANT, periodo, region, subcanal, mercado, division, categoria, medida,
          v.aMayo, v.aMdo, v.pMayo, v.pMdo, entrega]);
      nMkt++;
    }

    let nTax = 0;
    for (const [cb, t] of tax) {
      await db.query(`
        INSERT INTO analytics.iscam_taxonomy
          (tenant_id, barcode, segmento, categoria, subcategoria, marca, fabricante, entrega)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id, barcode)
        DO UPDATE SET segmento = EXCLUDED.segmento, categoria = EXCLUDED.categoria,
                      subcategoria = EXCLUDED.subcategoria, marca = EXCLUDED.marca,
                      fabricante = EXCLUDED.fabricante, entrega = EXCLUDED.entrega,
                      importado_at = now()`,
        [TENANT, cb, t.segmento, t.categoria, t.subcategoria, t.marca, t.fabricante, entrega]);
      nTax++;
    }

    await db.query('COMMIT');
    console.log(`\nOK · mercado: ${nMkt} filas · taxonomia: ${nTax} codigos · periodo ${periodo}`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
