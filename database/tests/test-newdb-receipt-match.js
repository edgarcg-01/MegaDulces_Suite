#!/usr/bin/env node
/**
 * `[RE.25]` — **El motor de cuadre del documento** (total + proveedor), y sus límites medidos.
 *
 * Se carga el `.ts` REAL vía ts-node (no una reimplementación): si el motor cambia de criterio,
 * este archivo se pone rojo. Decide sobre dinero — un cuadre que se relaja en silencio es peor
 * que uno que no existe.
 *
 * Dos bloques:
 *   1. **Reglas** — casos duros y fijados a mano, sin DB. Es el contrato del motor: los pares de
 *      nombres que SÍ son el mismo proveedor y los que no, el RFC sucio, y las tres formas de
 *      "no se puede comparar" que NO son un descuadre.
 *   2. **Realidad** — el motor corrido sobre los comprobantes que de verdad hay en la DB.
 *      No afirma un porcentaje fijo (la data crece); afirma **invariantes**: que los buckets
 *      cubran todo, que `cuadra` nunca salga sin importe confirmado, y que `paquete_ok` NO
 *      influya en el bucket.
 *
 * Correr: node database/tests/test-newdb-receipt-match.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla con TS5011.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const {
  evaluarCuadre, parecidoNombre, rfcComparable, rfcBienFormado, UMBRAL_NOMBRE,
  bucketDeSenales, evaluarPaquete, folioNumero, evaluarFolioInterno, HOJAS_INTERNAS,
  CUADRE_SQL, CUADRE_MOTIVO_SQL,
} = require(path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/receipt-match.ts'));

const base = { keplerMonto: 1000, keplerProveedor: 'AZTECA CONFITERIA S.A DE CV', keplerRfc: 'ACO1011124I1' };

(async () => {
  try {
    // ── 1. Nombres: los pares difíciles de la muestra real ──────────────────
    console.log('\n═══ 1. Parecido de nombres ═══');
    ok(parecidoNombre('AZTECA CONFITERIA, S.A. DE C.V.', 'AZTECA CONFITERIA S.A DE CV') >= UMBRAL_NOMBRE,
      'el mismo proveedor con puntuación distinta cuadra');
    ok(parecidoNombre('AZTECA CONFITERIA', 'AZTECA CONFITERIA DE OCCIDENTE PLANTA 2') >= UMBRAL_NOMBRE,
      'el nombre corto contenido en el largo cuadra (por eso se divide entre el más chico)');
    // El par que motivó el umbral: comparten "ALTOS" y nada más.
    ok(parecidoNombre('ALTOS DE LA LUZ S DE R.L DE CV', 'BOLSAS DE LOS ALTOS S. DE R.L.') < UMBRAL_NOMBRE,
      'dos proveedores DISTINTOS que comparten una palabra NO cuadran');
    ok(parecidoNombre('DULCES DE LOS ALTOS', null) === null,
      'falta un lado → null, que NO es lo mismo que 0');
    // Sin esto, "X S.A. DE C.V." y "Y S.A. DE C.V." arrancan pareciéndose.
    ok(parecidoNombre('GRUPO COMERCIALIZADORA S.A. DE C.V.', 'DISTRIBUIDORA CIA S.A. DE C.V.') === null,
      'un nombre que SÓLO trae sufijos societarios no aporta identidad (null, no 1)');

    // ── 2. RFC: sucio de los dos lados ──────────────────────────────────────
    console.log('\n═══ 2. RFC ═══');
    ok(rfcComparable('ACO-101112-4I1') === rfcComparable('ACO1011124I1'),
      'la puntuación y la I/1 del OCR no rompen el RFC (caso real medido)');
    ok(rfcComparable('GOGI6102O5H10') === rfcComparable('GOGI610205H10'),
      'la O/0 del OCR tampoco (caso real medido)');
    ok(rfcBienFormado('ACO1011124I1') && rfcBienFormado('GOGI610205H10'),
      'un RFC bien formado se reconoce (moral 12 / física 13)');
    // Medido: `NAL73213BKA` es de Kepler y le falta un dígito a la fecha. Compararlo produciría
    // un "el proveedor no cuadra" que es culpa de NUESTRO catálogo, no del papel.
    ok(!rfcBienFormado('NAL73213BKA'), 'un RFC malformado de Kepler se descarta en vez de comparar');
    ok(evaluarCuadre({ ...base, keplerRfc: 'NAL73213BKA', ocrTotal: 1000, ocrRfc: 'NAL730213BKA', ocrProveedor: base.keplerProveedor }).prov_rfc_match === null,
      'con el RFC de Kepler malformado, la señal es null (no `false`)');

    // ── 3. El bucket ────────────────────────────────────────────────────────
    console.log('\n═══ 3. Los tres buckets ═══');
    const v1 = evaluarCuadre({ ...base, ocrTotal: 1000, ocrProveedor: 'AZTECA CONFITERIA SA DE CV', ocrRfc: 'ACO101112411' });
    ok(v1.cuadre === 'cuadra', `importe + proveedor → cuadra (${v1.motivo})`);

    // El importe SOLO no alcanza: dos facturas del mismo monto de proveedores distintos
    // cuadrarían igual, y ahí es donde se paga la factura equivocada.
    const v2 = evaluarCuadre({ ...base, ocrTotal: 1000, ocrProveedor: 'BOLSAS DE LOS ALTOS S. DE R.L.', ocrRfc: null });
    ok(v2.cuadre === 'revisar', `importe correcto pero OTRO proveedor → revisar (${v2.motivo})`);

    const v3 = evaluarCuadre({ ...base, ocrTotal: 1000, ocrProveedor: null, ocrRfc: null });
    ok(v3.cuadre === 'revisar', 'importe correcto y proveedor ilegible → revisar, no cuadra');

    const v4 = evaluarCuadre({ ...base, ocrTotal: null, ocrSubtotal: null, ocrProveedor: null, ocrRfc: null });
    ok(v4.cuadre === 'sin_datos', `nada legible → sin_datos, que NO es un descuadre (${v4.motivo})`);

    const v5 = evaluarCuadre({ ...base, ocrTotal: 862.07, ocrSubtotal: 1000, ocrProveedor: base.keplerProveedor });
    ok(v5.cuadre === 'cuadra', 'cuadra por SUBTOTAL: el IVA puede venir incluido o no (dulce a granel va a 0%)');

    // RE.14.4 — si el papel casa con la copia de oficinas, el documento del proveedor está bien.
    const v6 = evaluarCuadre({ ...base, keplerMonto: 990, gemelaMonto: 1000, ocrTotal: 1000, ocrProveedor: base.keplerProveedor });
    ok(v6.cuadre === 'cuadra', 'cuadra contra la copia de oficinas: lo que difiere son NUESTRAS dos capturas');

    const v7 = evaluarCuadre({ ...base, ocrTotal: 1234.56, ocrProveedor: base.keplerProveedor });
    ok(v7.cuadre === 'revisar' && v7.monto_match === false, 'proveedor bien, importe mal → revisar');

    // ── 4. `paquete_ok`: lo DECLARADO manda, y viaja aparte del bucket ──────
    //
    // La primera versión de esto leía `documents_present` (lo que el OCR adivina) y fijaba
    // "sólo 7 de 161 traen la hoja interna". Medido contra el ROL que el capturista declara al
    // subir cada hoja: **93 de 161 (58%)**. El paquete sí la trae; fallaba el reconocimiento.
    // Estos casos existen para que nadie vuelva a construir el control sobre el OCR.
    console.log('\n═══ 4. La hoja interna: lo declarado manda, e informa sin decidir ═══');
    const conRol = evaluarCuadre({ ...base, ocrTotal: 1000, ocrProveedor: base.keplerProveedor, rolesDeclarados: ['factura', 'orden_entrada'] });
    const sinRol = evaluarCuadre({ ...base, ocrTotal: 1000, ocrProveedor: base.keplerProveedor, rolesDeclarados: ['factura'] });
    ok(conRol.paquete_ok === true && sinRol.paquete_ok === false, 'lo detecta por el rol que declaró el capturista');
    ok(evaluarCuadre({ ...base, ocrTotal: 1000, rolesDeclarados: ['vale'] }).paquete_ok === true,
      'el `vale` de recepción también cuenta: cumple la misma función donde no se imprime la orden');
    // El caso que motivó el cambio: el capturista SÍ subió la hoja y el OCR no la reconoció.
    ok(evaluarPaquete(['factura', 'orden_entrada'], ['factura']) === true,
      'el rol declarado GANA sobre `documents_present` cuando el OCR no reconoció la hoja');
    ok(evaluarPaquete(null, ['factura', 'aplica_orden_entrada']) === true,
      'sin roles (comprobante viejo) se cae al OCR como respaldo');
    ok(evaluarPaquete(null, null) === null && evaluarPaquete([], []) === null,
      'sin ninguna de las dos fuentes → null = "no se sabe", que no es "falta"');
    ok(sinRol.cuadre === conRol.cuadre,
      'el bucket NO cambia por la hoja: "no concuerda el documento" y "falta una hoja" son dos problemas distintos');

    // ── 4-bis. El folio de NUESTRA hoja contra el de la entrada ─────────────
    //
    // Este bloque existe por un error concreto: la primera medición usó "quitá todo lo que no
    // sea dígito" y `XA2001-0000353` se volvió `20010000353`, que no es `353`. Daba 4 de 63
    // coincidencias. Quitando bien el prefijo del doctype da **46 de 63 (73%)** — o sea que el
    // normalizador flojo habría gritado "el folio no coincide" en 42 expedientes correctos.
    console.log('\n═══ 4-bis. El folio interno (el prefijo del doctype NO es parte del número) ═══');
    ok(folioNumero('XA2001-0000353') === '353', '`XA2001-0000353` es el folio 353, no 20010000353');
    ok(folioNumero('0000353') === '353', 'el folio pelado con ceros a la izquierda es el mismo');
    ok(folioNumero('No. 0006668') === '6668', '"No. 0006668" también (así lo imprimen algunas sucursales)');
    ok(evaluarFolioInterno('XA2001-0000353', '0000353') === true, 'la hoja del paquete casa con la entrada');
    ok(evaluarFolioInterno('XA2001-0001120', '0000863') === false,
      'un folio DISTINTO se marca: es evidencia pegada a otra orden (caso real medido)');
    ok(evaluarFolioInterno(null, '0000353') === null && evaluarFolioInterno('XA2001-0000353', null) === null,
      'sin uno de los dos lados → null = "no se pudo comparar", no `false`');
    ok(evaluarFolioInterno('Sin número de folio asignado', '0000353') === null,
      'una hoja sin folio impreso no acusa de nada (caso real medido)');

    // ── 5. TS vs SQL: las dos implementaciones de la MISMA regla ────────────
    //
    // El bucket se decide en TS al escribir y en SQL al leer (filtrar 15,000 entradas no se
    // puede hacer en memoria). Dos implementaciones de una regla de dinero se desincronizan
    // solas, así que acá se comparan sobre **todas** las combinaciones posibles de señales —
    // no sobre una muestra, que dejaría los casos raros sin cubrir.
    console.log('\n═══ 5. El espejo SQL coincide con el TS, en las 72 combinaciones ═══');
    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) { console.log('  ⚠️  sin DATABASE_URL_NEW — el espejo SQL queda SIN VERIFICAR'); }
    else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 3 },
      });
      try {
        const casos = [];
        for (const n of [0, 1]) {
          for (const any_match of [true, false, null]) {
            for (const prov_score of [null, 0.2, 0.5, 1]) {
              for (const prov_rfc_match of [true, false, null]) {
                casos.push({ n, any_match, prov_score, prov_rfc_match });
              }
            }
          }
        }
        // Se evalúa la expresión REAL contra una tabla derivada llamada `d`, que es el mismo
        // alias que usa `list()`. No hace falta la tabla ni la migración: se prueba la REGLA.
        const values = casos.map((c, i) =>
          `(${i}, ${c.n}, ${c.any_match === null ? 'NULL' : c.any_match}::boolean, ` +
          `${c.prov_score === null ? 'NULL' : c.prov_score}::numeric, ` +
          `${c.prov_rfc_match === null ? 'NULL' : c.prov_rfc_match}::boolean)`).join(',');
        const { rows: sqlRows } = await knex.raw(
          `SELECT d.i, ${CUADRE_SQL} AS cuadre, ${CUADRE_MOTIVO_SQL} AS motivo
             FROM (VALUES ${values}) AS d(i, n, any_match, prov_score, prov_rfc_match)
            ORDER BY d.i`);
        let discrepan = 0, motivoVacio = 0;
        for (const r of sqlRows) {
          const esperado = bucketDeSenales(casos[r.i]);
          if (r.cuadre !== esperado) {
            discrepan++;
            if (discrepan <= 3) console.error(`     SQL="${r.cuadre}" vs TS="${esperado}" en ${JSON.stringify(casos[r.i])}`);
          }
          if (!r.motivo) motivoVacio++;
        }
        ok(sqlRows.length === casos.length, `se evaluaron las ${casos.length} combinaciones`);
        ok(discrepan === 0, `SQL y TS deciden IGUAL en las ${casos.length} (discrepan: ${discrepan})`);
        ok(motivoVacio === 0, 'toda combinación cae en alguna rama del motivo (ningún CASE sin ELSE)');
      } finally { await knex.destroy(); }
    }

    // ── 6. El motor sobre la data REAL ──────────────────────────────────────
    console.log('\n═══ 6. Sobre los comprobantes que hay en la DB ═══');
    if (!DST) { console.log('  ⚠️  sin DATABASE_URL_NEW — el bloque contra DB queda SIN VERIFICAR'); }
    else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 3 },
      });
      try {
        const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
        const { rows } = await knex.raw(`
          SELECT p.folio, p.ocr_proveedor, p.ocr_rfc, p.ocr_subtotal, p.ocr_monto, p.ocr_raw, p.files,
                 g.proveedor_nombre, g.proveedor_rfc, g.monto AS kepler
            FROM finance.goods_receipt_proofs p
            JOIN analytics.erp_goods_receipts g
              ON g.tenant_id = p.tenant_id AND g.sucursal = p.sucursal AND g.folio = p.folio
           WHERE p.tenant_id = ?`, [T]);
        if (!rows.length) {
          console.log('  ⚠️  no hay comprobantes en este ambiente — bloque SIN VERIFICAR');
        } else {
          const cuenta = { cuadra: 0, revisar: 0, sin_datos: 0 };
          let cuadraSinImporte = 0, sinMotivo = 0, hojaPorRol = 0, hojaPorOcr = 0, folioCasa = 0, folioNoCasa = 0;
          for (const r of rows) {
            let raw = r.ocr_raw;
            if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
            let files = r.files;
            if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = null; } }
            const roles = Array.isArray(files) ? files.map((f) => f && f.role) : null;
            const docsOcr = Array.isArray(raw && raw.documents_present) ? raw.documents_present.map((d) => d && d.type) : null;
            const v = evaluarCuadre({
              keplerMonto: Number(r.kepler),
              keplerProveedor: r.proveedor_nombre, keplerRfc: r.proveedor_rfc,
              ocrTotal: r.ocr_monto != null ? Number(r.ocr_monto) : null,
              ocrSubtotal: r.ocr_subtotal != null ? Number(r.ocr_subtotal) : null,
              ocrProveedor: r.ocr_proveedor, ocrRfc: r.ocr_rfc,
              rolesDeclarados: roles, documentosEnPaquete: docsOcr,
            });
            cuenta[v.cuadre]++;
            if (v.cuadre === 'cuadra' && v.monto_match !== true) cuadraSinImporte++;
            if (!v.motivo) sinMotivo++;
            if (evaluarPaquete(roles, null) === true) hojaPorRol++;
            if (evaluarPaquete(null, docsOcr) === true) hojaPorOcr++;
            // RE.26 — el folio de nuestra hoja contra el de la entrada.
            const fi = (Array.isArray(files) ? files : [])
              .find((x) => x && HOJAS_INTERNAS.has(String(x.role)) && x.ocr_folio);
            const v2 = evaluarFolioInterno(fi && fi.ocr_folio, r.folio);
            if (v2 === true) folioCasa++; else if (v2 === false) folioNoCasa++;
          }
          // El invariante contra el normalizador flojo: la MAYORÍA de los folios legibles casan.
          // Si alguien vuelve a comparar sin quitar el prefijo del doctype, esto cae a ~6%.
          if (folioCasa + folioNoCasa > 0) {
            const pct = folioCasa / (folioCasa + folioNoCasa);
            ok(pct >= 0.5,
              `el folio de la hoja interna casa en la mayoría (${folioCasa}/${folioCasa + folioNoCasa} = ${(pct * 100).toFixed(0)}%)`);
          }
          // El invariante que protege la corrección: lo declarado tiene que encontrar la hoja
          // interna MÁS veces que lo adivinado. Si alguien vuelve a preferir el OCR, esto cae.
          ok(hojaPorRol > hojaPorOcr,
            `el rol declarado encuentra la hoja interna más que el OCR (${hojaPorRol} vs ${hojaPorOcr})`);
          const n = rows.length;
          ok(cuenta.cuadra + cuenta.revisar + cuenta.sin_datos === n,
            `los 3 buckets cubren los ${n} comprobantes, sin fila huérfana`);
          // El invariante que protege el dinero: nada se declara cuadrado sin importe confirmado.
          ok(cuadraSinImporte === 0, 'ningún `cuadra` sin importe confirmado');
          ok(sinMotivo === 0, 'toda fila trae su motivo escrito (es lo que la pantalla muestra)');
          console.log(`     reparto real: cuadra ${cuenta.cuadra} (${(cuenta.cuadra / n * 100).toFixed(0)}%) · ` +
            `revisar ${cuenta.revisar} (${(cuenta.revisar / n * 100).toFixed(0)}%) · ` +
            `sin_datos ${cuenta.sin_datos} (${(cuenta.sin_datos / n * 100).toFixed(0)}%)`);
          console.log('     (no se afirma un % fijo: la data crece. Lo que se afirma son los invariantes.)');
        }
      } finally { await knex.destroy(); }
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  }
  process.exit(fail === 0 ? 0 : 1);
})();
