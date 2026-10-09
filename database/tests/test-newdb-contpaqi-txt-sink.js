/**
 * `[CP.8.5]` — Candado del sink de archivo (`ContpaqiTxtSinkAdapter`).
 *
 * Carga el `.ts` REAL vía ts-node. Prueba las tres cosas que este adaptador tiene que garantizar
 * y que no se ven mirando el código:
 *
 *  1. **Que use el layout de LC, no uno propio.** Se verifica haciendo round-trip con el
 *     `parsearTxt` de `poliza-txt.ts`: si el adaptador serializara por su cuenta, el parser de
 *     LC no lo podría leer.
 *  2. **Que NO rompa el libro de compras.** `construirTxt` se generalizó para aceptar `tipoPol`
 *     y `seg_negocio`; acá se comprueba que llamarlo como lo llama LC sigue dando el MISMO byte
 *     que antes del cambio.
 *  3. **Que diga `entregada` y nunca `aplicada`.** Generar un archivo no es asentar una póliza.
 *
 * Fixture: la póliza real `PAGO TRASLADO DE EFECTIVO` (folio 260, 2026-03-01), leída de
 * ContPAQi el 2026-10-08 — la misma del candado del armador, con su `IdSegNeg=8`.
 *
 * No necesita base de datos.
 */
'use strict';

require('reflect-metadata');
const path = require('path');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
    experimentalDecorators: true, emitDecoratorMetadata: true,
    baseUrl: path.resolve(__dirname, '..', '..'),
    paths: { '@megadulces/contracts': ['libs/contracts/src/index.ts'] },
  },
});
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '..', '..'),
  paths: { '@megadulces/contracts': ['libs/contracts/src/index.ts'] },
});

const LIB = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib');
const { ContpaqiTxtSinkAdapter } = require(path.join(LIB, 'contpaqi', 'txt-sink.adapter.ts'));
const { guidDe } = require(path.join(LIB, 'contpaqi', 'token.ts'));
const { construirTxt, parsearTxt, largoLinea, LAYOUT_P, LAYOUT_M, LAYOUT_SIN_VERIFICAR, LAYOUT_ARBITRO } =
  require(path.join(LIB, 'purchase-book', 'poliza-txt.ts'));

let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};

// La póliza real: traslado de efectivo, con el IVA que NO sale de multiplicar.
const ENTRADA = {
  evento_tipo: 'bank_movement',
  evento_id: 'demo-0001',
  tipo_poliza: 2,
  fecha: '2026-03-01',
  concepto: 'PAGO TRASLADO DE EFECTIVO',
  total: 155535.47,
  movimientos: [
    { cuenta: '5200680000', abono: false, importe: 134082.29, concepto: '', seg_negocio: 8 },
    { cuenta: '1060000000', abono: false, importe: 21453.18, concepto: '', seg_negocio: 0 },
    { cuenta: '1020020000', abono: true, importe: 155535.47, concepto: '', seg_negocio: 0 },
  ],
};

(async () => {
  const sink = new ContpaqiTxtSinkAdapter();

  console.log('\n[1] Entrega el archivo y declara lo que de verdad hizo');
  check(sink.sink === 'txt', 'se identifica como sink `txt`');
  check((await sink.disponible()) === true, 'siempre disponible (no depende de máquina ni licencia)');
  const r = await sink.entregar({ ...ENTRADA, token: 'MD:a1b2c3d4' });
  check(r.estado === 'entregada', 'estado = entregada');
  check(r.estado !== 'aplicada', '⭐ NUNCA dice `aplicada` — eso lo decide el cuadre, no el sink');
  check(!!r.archivo && r.archivo.contenido.length > 0, 'trae contenido de archivo');
  check(/\.txt$/.test(r.archivo.nombre) && r.archivo.nombre.includes('demo-0001'),
    'el nombre del archivo identifica el evento');

  console.log('\n[2] ⭐ Usa el layout de LC — lo prueba el parser de LC leyéndolo');
  const p = parsearTxt(r.archivo.contenido);
  check(p.invalidos.length === 0, `el parser de LC no encuentra renglones inválidos (${p.invalidos.length})`);
  check(p.header !== null && p.header.tipo_pol === '2', 'el encabezado dice TipoPol 2 (Egreso), no 3');
  check(p.movimientos.length === 3, 'vuelven los 3 renglones');
  check(p.movimientos[0].cuenta === '5200680000' && p.movimientos[0].abono === false
    && p.movimientos[0].importe === 134082.29, '#1 cargo al gasto, íntegro');
  check(p.movimientos[2].cuenta === '1020020000' && p.movimientos[2].abono === true
    && p.movimientos[2].importe === 155535.47, '#3 abono al banco, íntegro');
  check(String(p.movimientos[0].seg_negocio) === '8', 'el segmento 8 sobrevive el viaje');
  check(String(p.movimientos[1].seg_negocio) === '', 'el renglón de IVA va sin segmento');

  console.log('\n[3] El token viaja en el concepto del encabezado (lo que el cuadre buscará)');
  check(p.header.concepto.startsWith('MD:a1b2c3d4'), 'el token va adelante del concepto');
  check(p.header.concepto.includes('PAGO TRASLADO DE EFECTIVO'), 'el concepto original sobrevive');

  console.log('\n[4] Los anchos siguen siendo los de LC');
  const lineas = r.archivo.contenido.split('\r\n').filter((l) => l.length);
  check(lineas[0].length === largoLinea(LAYOUT_P), `encabezado mide ${largoLinea(LAYOUT_P)}`);
  check(lineas.slice(1).every((l) => l.length === largoLinea(LAYOUT_M)),
    `cada movimiento mide ${largoLinea(LAYOUT_M)}`);
  check(r.archivo.contenido.endsWith('\r\n'), 'cierra con CRLF');

  console.log('\n[5] ⛔ El libro de compras NO cambió — misma llamada, mismo byte');
  // Así llama LC: sin `tipoPol` y sin `seg_negocio`. Tiene que salir Diario y sin segmento.
  const comoLC = construirTxt('20260731', 1, 'REGISTRO DE COMPRAS DEL MES', [
    { cuenta: '5020000008', referencia: '', abono: false, importe: 1000, concepto: '' },
    { cuenta: '2120000000', referencia: '', abono: true, importe: 1000, concepto: '' },
  ]);
  const pLC = parsearTxt(comoLC);
  check(pLC.header.tipo_pol === '3', 'sin pasar tipoPol sigue siendo Diario (3)');
  check(pLC.invalidos.length === 0, 'el archivo de LC sigue siendo válido');
  check(String(pLC.movimientos[0].seg_negocio) === '', 'sin seg_negocio el campo sale vacío, como siempre');
  check(construirTxt('20260731', 1, 'REGISTRO DE COMPRAS DEL MES', pLC.movimientos) === comoLC,
    '⭐ round-trip byte a byte del archivo de LC');

  console.log('\n[6] Pruebas negativas — se niega en vez de entregar algo roto');
  const sinMovs = await sink.entregar({ ...ENTRADA, movimientos: [] });
  check(sinMovs.estado === 'rechazada' && /sin_movimientos/.test(sinMovs.motivo),
    'un asiento sin renglones se rechaza');

  const fechaMala = await sink.entregar({ ...ENTRADA, fecha: '01/03/2026' });
  check(fechaMala.estado === 'rechazada' && /fecha_invalida/.test(fechaMala.motivo),
    'una fecha que no es YYYY-MM-DD se rechaza (el bug de día corrido de [LC.16])');

  // [CP.8.6] El contrato cambió para MEJOR: lo que se recorta es la DESCRIPCION (texto para que
  // un humano se ubique), nunca el token. Se rechaza sólo si el TOKEN no entra en el campo.
  const descLarga = await sink.entregar({ ...ENTRADA, token: 'MD:ABCDEF123456', concepto: 'Z'.repeat(300) });
  check(descLarga.estado === 'entregada', 'una descripción enorme NO tumba la entrega');
  check(descLarga.archivo.contenido.includes('MD:ABCDEF123456'),
    '⭐ se recorta la descripción y el TOKEN sobrevive entero');
  const tokenLargo = await sink.entregar({ ...ENTRADA, token: 'X'.repeat(120) });
  check(tokenLargo.estado === 'rechazada' && /concepto_excede/.test(tokenLargo.motivo),
    '⭐ un token que no entra en el campo se RECHAZA, no se recorta');

  const sinCuenta = await sink.entregar({
    ...ENTRADA,
    movimientos: [{ cuenta: '', abono: false, importe: 1, concepto: '', seg_negocio: 0 }],
  });
  check(sinCuenta.estado === 'rechazada' && /layout_rechaza/.test(sinCuenta.motivo),
    'un renglón sin cuenta se rechaza (el nulo que padR vuelve 30 espacios, [LC.9])');

  console.log('\n[7] Los parámetros están DECLARADOS, no clavados');
  const P = require(path.join(LIB, 'contpaqi', 'layout.params.ts'));
  check(P.PERFIL_PUENTE.P === P.PERFIL_ACTUAL.P && P.PERFIL_PUENTE.M === P.PERFIL_ACTUAL.M,
    '⭐ mientras ESTRATEGIA sea `alinear`, el perfil del puente es IDÉNTICO al actual');
  check(P.EMITE_AD_UUID.valor === false,
    '⛔ los renglones AD arrancan APAGADOS (prenderlos sin confirmar tumba el archivo entero)');
  check(P.FOLIO.valor === 0 && P.FOLIO.estado === 'decidido',
    'el folio lo asigna ContPAQi — decidido, no en duda');
  check(P.TOKEN.prefijo.valor === 'MD:' && P.TOKEN.estado === undefined,
    'el token es decisión nuestra entera (no depende de ninguna duda de formato)');
  check(P.SEPARADOR.estado === 'heredado' && P.SEPARADOR.valor === ' ',
    'el separador quedó RESUELTO: espacio, con dos fuentes');
  const pend = P.pendientes();
  check(pend.length === 2, `${pend.length} parámetros pendientes, enumerados con dueño`);
  check(pend.every((x) => x.respaldo && x.respaldo.length > 10),
    'ningún pendiente sin respaldo escrito');
  console.log('  — pendientes de decidir/confirmar:');
  for (const x of pend) console.log(`      · [${x.estado}] ${x.que}`);

  console.log('\n[8] ⭐ EL ÁRBITRO: el layout REAL, medido contra una exportación de ContPAQi');
  const fs = require('fs');
  const FIX = path.resolve(__dirname, 'fixtures', 'poliza-contpaqi-real-2026-09.txt');
  if (!fs.existsSync(FIX)) {
    // Skip limpio, no verde falso: el archivo trae datos contables reales y el repo es PÚBLICO,
    // así que está en .gitignore y en CI no existe. Que falte es esperado; que se dé por bueno
    // sin medir, no.
    console.log('  [NO MEDIDO] sin el fixture local — es correcto que falte en CI (datos reales, repo público)');
  } else {
    const lineas = fs.readFileSync(FIX, 'latin1').split(/\r?\n/).filter((l) => l.length);
    const largoReal = (L) => L.reduce((a, c) => a + c.ancho, 0) + L.length; // +1 por el espacio final
    const Ps = lineas.filter((l) => l.slice(0, 2) === 'P ');
    const Ms = lineas.filter((l) => l.slice(0, 2) === 'M1');
    const ADs = lineas.filter((l) => l.slice(0, 2) === 'AD');
    check(Ps.length > 0 && Ms.length > 0, `el fixture trae ${Ps.length} P y ${Ms.length} M1`);
    check(Ps.every((l) => l.length === P.RESUELTO_CON_ARCHIVO_REAL.largo_P),
      `todas las P miden ${P.RESUELTO_CON_ARCHIVO_REAL.largo_P}`);
    check(Ms.every((l) => l.length === P.RESUELTO_CON_ARCHIVO_REAL.largo_M),
      `todas las M1 miden ${P.RESUELTO_CON_ARCHIVO_REAL.largo_M}`);
    check(largoReal(P.LAYOUT_REAL_P) === P.RESUELTO_CON_ARCHIVO_REAL.largo_P,
      '⭐ LAYOUT_REAL_P reproduce el largo real por aritmética de anchos');
    check(largoReal(P.LAYOUT_REAL_M) === P.RESUELTO_CON_ARCHIVO_REAL.largo_M,
      '⭐ LAYOUT_REAL_M reproduce el largo real por aritmética de anchos');
    check(lineas.every((l) => l.endsWith(' ')), '⭐ TODA línea termina en espacio (lo que el emisor viejo no hacía)');
    check(ADs.length > 0 && ADs.every((l) => l.length === P.LARGO_AD),
      `⭐ ${ADs.length} renglones AD de ${P.LARGO_AD} chars — el formato SÍ lleva el UUID del CFDI`);

    // ⭐⭐ LA prueba. Todo lo demás verifica el emisor contra sí mismo; esto lo verifica contra
    // ContPAQi: desarmar cada póliza real y volver a armarla tiene que dar el MISMO BYTE.
    // Es lo que atrapó el `impTxt` que escribía 11787.50 donde ContPAQi escribe 11787.5, y el
    // `impresa` clavado en 0 — dos defectos que ninguna prueba de coherencia interna podía ver.
    let bloques = 0;
    let identicos = 0;
    let primerDiff = null;
    for (let i = 0; i < lineas.length; i++) {
      if (lineas[i].slice(0, 2) !== 'P ') continue;
      const b = [lineas[i]];
      for (let j = i + 1; j < lineas.length && lineas[j].slice(0, 2) === 'M1'; j++) b.push(lineas[j]);
      if (b.length < 2) continue;
      const orig = `${b.join('\r\n')}\r\n`;
      const pz = parsearTxt(orig);
      if (pz.invalidos.length) { primerDiff = primerDiff ?? `inválido: ${pz.invalidos[0].motivo}`; continue; }
      const re = construirTxt(pz.header.fecha, pz.header.folio, pz.header.concepto, pz.movimientos,
        pz.header.tipo_pol, pz.header.guid, pz.header.impresa, pz.header.ajuste);
      bloques++;
      if (re === orig) identicos++;
      else if (!primerDiff) {
        const k = [...orig].findIndex((c, idx) => c !== re[idx]);
        primerDiff = `pos ${k}: real ${JSON.stringify(orig.substr(Math.max(0, k - 12), 24))} vs nuestro ${JSON.stringify(re.substr(Math.max(0, k - 12), 24))}`;
      }
    }
    check(bloques > 0 && identicos === bloques,
      `⭐⭐ ROUND-TRIP BYTE A BYTE contra ContPAQi: ${identicos}/${bloques} pólizas reales idénticas${primerDiff ? ` — ${primerDiff}` : ''}`);
    // ⭐ El emisor ya converge con el archivo real.
    check(largoLinea(LAYOUT_P) === P.RESUELTO_CON_ARCHIVO_REAL.largo_P
      && largoLinea(LAYOUT_M) === P.RESUELTO_CON_ARCHIVO_REAL.largo_M,
      `⭐ el emisor YA escribe el layout real (${largoLinea(LAYOUT_P)}/${largoLinea(LAYOUT_M)})`);
  }

  // ── `[CP.8.24]` El `Guid` del encabezado ───────────────────────────────────────────────────
  // ⛔ Este bloque existe porque al cablear `guidDe` al sink, este candado siguió en 44 ✓ sin
  // notarlo: **un candado que no ve lo que guarda no lo guarda**.
  //
  // El `Guid` es el mejor candidato a llave de correlación del puente — estructural, y no gasta
  // los 100 caracteres del concepto. Sigue SIN VERIFICARSE si ContPAQi lo respeta o lo pisa con
  // el suyo; lo que estas pruebas defienden es que lo EMITAMOS, que es la única forma de llegar
  // a saberlo.
  {
    const ent = (id) => ({
      evento_tipo: 'bank_movement', evento_id: id, tipo_poliza: 2, fecha: '2026-03-04',
      concepto: 'PRUEBA GUID', total: 100,
      movimientos: [
        { cuenta: '5200800000', abono: false, importe: 100, concepto: 'X' },
        { cuenta: '1020020000', abono: true, importe: 100, concepto: 'X' },
      ],
    });
    const r1 = await sink.entregar(ent('A-1'));
    const r2 = await sink.entregar(ent('A-1'));
    const r3 = await sink.entregar(ent('A-2'));
    const cab = (r) => r.archivo.contenido.split('\r\n')[0];
    // El layout real pone el `Guid` al final del encabezado: 36 chars + el separador.
    const guidDe_ = (r) => cab(r).slice(-37).trim();

    check(cab(r1).length === 185, 'el encabezado sigue midiendo 185 con el guid adentro');
    check(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(guidDe_(r1)),
      `el encabezado trae un UUID v4 bien formado (${guidDe_(r1)})`);
    // ⭐ Determinista: con uno aleatorio, re-emitir el mismo evento dejaría huérfana la entrega
    // anterior — exactamente la razón por la que `tokenDe` también lo es.
    check(guidDe_(r1) === guidDe_(r2), 'el mismo evento produce el MISMO guid');
    check(guidDe_(r1) !== guidDe_(r3), 'dos eventos distintos producen guids distintos');
    check(guidDe_(r1) === guidDe('bank_movement', 'A-1'),
      'el guid del archivo es el que `guidDe` deriva del evento');
    // Prueba negativa del propio lector: si recortara mal, esto pasaría igual.
    check(guidDe_(r1) !== '' && guidDe_(r1).length === 36,
      'el guid leído del archivo mide 36 (si el recorte estuviera mal, esto lo delata)');
  }

  // ── `[CP.8.29]` Los renglones `AD` (asociación de CFDI) ───────────────────────────────────
  // El formato está verificado contra el esquema del fabricante (`[CP.8.28]`: `asocdocto.1` =
  // etiqueta 2 + sep + UUID 36 + sep = 40) y contra el archivo real (62 renglones, los 62 de 40).
  //
  // ⛔ Lo que estas pruebas NO dicen: si ContPAQi los HONRA al importar. Eso lo contesta el
  // archivo B de `[CP.8.24]`, y hasta entonces el `[NO MEDIDO]` de abajo se queda.
  {
    const U1 = '3D4468D0-BEE5-49FA-9048-CFF7022FA4B7';
    const U2 = '09a42d9c-42da-46fe-a276-4b0f25e45e0a';
    const base = (extra) => ({
      evento_tipo: 'bank_movement', evento_id: 'AD-1', tipo_poliza: 2, fecha: '2026-03-04',
      concepto: 'PRUEBA AD', total: 100,
      movimientos: [
        { cuenta: '5200800000', abono: false, importe: 100, concepto: 'X' },
        { cuenta: '1020020000', abono: true, importe: 100, concepto: 'X' },
      ],
      ...extra,
    });

    const sinAd = await sink.entregar(base());
    const conAd = await sink.entregar(base({ uuids: [U1] }));
    const dosAd = await sink.entregar(base({ uuids: [U1, U2] }));
    const lineas = (r) => r.archivo.contenido.split('\r\n').filter(Boolean);

    // ⭐ Sin `uuids` el archivo sale EXACTAMENTE como antes. Es lo que permite prender esto sin
    // tocar el libro de compras, que mueve $30-56M al mes.
    check(lineas(sinAd).length === 3, 'sin uuids: 3 líneas (encabezado + 2 movimientos)');
    check(!lineas(sinAd).some((l) => l.startsWith('AD')), 'sin uuids: ningún renglón AD');

    check(lineas(conAd).length === 4, 'con 1 uuid: 4 líneas');
    const ad = lineas(conAd)[3];
    check(ad.startsWith('AD '), 'el renglón AD arranca con la etiqueta');
    check(ad.length === 40, `el renglón AD mide ${ad.length} (esquema: 40)`);
    check(ad.slice(3, 39) === U1, 'el UUID va en 4-39 y sale sin tocar');
    check(ad.endsWith(' '), 'cierra con separador, como toda línea del formato');

    // ⭐⭐ Van al FINAL, después de los movimientos. Las fuentes externas decían "después del P"
    // (§9.1) y el archivo real lo desmiente: su primera póliza es `P M1 M1 M1 AD`.
    const tags = lineas(dosAd).map((l) => l.slice(0, 2));
    check(tags.join(',') === 'P ,M1,M1,AD,AD'.replace(/AD,AD/, 'AD,AD'),
      `el orden es P M1 M1 AD AD (salió ${tags.join(' ')})`);
    check(lineas(dosAd).length === 5, 'dos uuids producen dos renglones AD');

    // ⛔ Un UUID que no mide 36 NO se rellena ni se recorta: se rechaza. Rellenarlo daría un
    // renglón de 40 que el importador acepta y que asocia el comprobante equivocado.
    for (const malo of ['', '3D4468D0-BEE5-49FA-9048', `${U1}X`, '   ']) {
      const r = await sink.entregar(base({ uuids: [malo] }));
      check(r.estado === 'rechazada',
        `un UUID de ${malo.trim().length} caracteres es RECHAZADO, no rellenado`);
    }
    // Positiva: el bueno, al lado de los malos, sí pasa.
    check((await sink.entregar(base({ uuids: [U1, U2] }))).estado === 'entregada',
      'dos UUID válidos pasan');
  }

  // ── NO MEDIDO ───────────────────────────────────────────────────────────────────────────────
  // ⭐ Esto NO es una aserción: es un tercer estado. Todo lo de arriba prueba que el sink es
  // coherente CONSIGO MISMO y con el layout que tenemos. Ninguna de esas 26 pruebas puede decir
  // si ese layout es el que ContPAQi espera — un round-trip verifica una vista contra sí misma.
  // Va impreso y no en un comentario porque un comentario no avisa cuando deja de ser cierto.
  console.log('\n[NO MEDIDO] ⛔ El emisor escribe el layout VIEJO — diferencias MEDIDAS contra el real');
  for (const d of LAYOUT_SIN_VERIFICAR) {
    console.log(`  ⚠ ${d.campo}: acá ${d.aqui}, el REAL dice ${d.fuente ?? '(existe y acá no)'} — ${d.impacto}`);
  }
  console.log('  ⚠ renglones `AD `: YA se emiten ([CP.8.29]) con el layout del esquema; falta medir si ContPAQi los HONRA al importar');
  console.log('  ⚠ el `Guid` YA se emite ([CP.8.24]); falta medir si ContPAQi lo RESPETA o lo pisa');
  console.log(`  → árbitro: ${LAYOUT_ARBITRO}`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.5 sink de archivo: ${ok} ✓ / ${fail} ✗ · ${LAYOUT_SIN_VERIFICAR.length + 1} NO MEDIDO\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  fail++;
  console.log(`  ✗ excepción no esperada: ${e && e.message}`);
  console.log(`\n❌ CP.8.5 sink de archivo: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(1);
});
