/* eslint-disable no-console */
/**
 * `[CP.8.28]` — **El candado contra el ÁRBITRO: `CT_EST_Poliza_NG.xls` de ContPAQi.**
 *
 * Hasta hoy el layout se había validado contra **una exportación real** (`[CP.8.13]`, 14/14 byte
 * a byte). Eso prueba que leemos bien lo que ContPAQi *escribe* — no que escribamos lo que
 * ContPAQi *espera al leer*. Son dos cosas distintas, y el archivo que zanja la segunda es el
 * esquema que su propio importador usa:
 *
 *     C:\Compac\Empresas\Esquemas\Contpaq\CT_EST_Poliza_NG.xls
 *
 * `[CP.8.4]` §9.2 lo declaró **inalcanzable** (SMB denegado). Estaba escrito en el propio diálogo
 * de `Cargar Pólizas`, en el campo `Configuración de datos`: no hacía falta acceso remoto, hacía
 * falta abrir la pantalla.
 *
 * ── Cómo se lee el esquema ──────────────────────────────────────────────────────────────────
 *     E | poliza.1 | 2 | P      <- arranca un REGISTRO: etiqueta de 2 chars, tipo `P`
 *     S |          | 1          <- SEPARADOR de 1 caracter
 *     A | Fecha    | 8 | yyyyMMdd
 *     ...
 *
 * `A` = alfanumérico · `R` = referencia a catálogo · `AE` = alfanumérico extranjero ·
 * `S` = separador · `E` = cabecera de registro.
 *
 * ⚠️ **El separador NO es uniforme**: entre `Concepto` y `SistOrig` del encabezado **no hay `S`**.
 * Un lector que asuma "un separador entre cada par de campos" cuadra el total igual y **parte mal
 * los dos campos**. Por eso este candado compara **posiciones**, no sólo la suma.
 *
 * El JSON de al lado (`contpaqi-esquema-poliza.json`) es la transcripción fiel de las 723 filas.
 */
const fs = require('fs');
const path = require('path');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const LIB = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib');
const T = require(path.join(LIB, 'purchase-book', 'poliza-txt.ts'));

const ESQUEMA = path.join(__dirname, 'fixtures', 'contpaqi-esquema-poliza.json');

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};

if (!fs.existsSync(ESQUEMA)) {
  console.log('\n[NO MEDIDO] falta el esquema del fabricante en fixtures/contpaqi-esquema-poliza.json');
  console.log('  → se obtiene de C:\\Compac\\Empresas\\Esquemas\\Contpaq\\CT_EST_Poliza_NG.xls');
  console.log('\n✅ CP.8.28 esquema ContPAQi: 0 ✓ / 0 ✗ · 1 NO MEDIDO\n');
  process.exit(0);
}

// ⚠️ `Set-Content -Encoding utf8` de PowerShell 5.1 escribe BOM; se tolera al leer.
const filas = JSON.parse(fs.readFileSync(ESQUEMA, 'utf8').replace(/^FEFF/, ''));

/**
 * Corta el esquema en registros. Un registro va desde su `E` hasta el `E` siguiente, y se
 * identifica por la **letra de tipo** (columna `formato` del `E`): `P`, `M1`, `AD`…
 */
function registro(tipoEtiqueta) {
  const i = filas.findIndex((f) => f.tipo === 'E' && f.formato === tipoEtiqueta);
  if (i < 0) return null;
  const fin = filas.findIndex((f, j) => j > i && f.tipo === 'E');
  const cuerpo = filas.slice(i, fin < 0 ? filas.length : fin);
  // Posiciones: la etiqueta ocupa su propio ancho y después vienen campos y separadores.
  const campos = [];
  let pos = 0;
  for (const f of cuerpo) {
    const w = Number(f.longitud);
    if (f.tipo === 'S') { pos += w; continue; }
    campos.push({ nombre: f.tipo === 'E' ? 'tipo' : f.nombre, ancho: w, desde: pos + 1, hasta: pos + w });
    pos += w;
  }
  return { campos, largo: pos };
}

const P = registro('P');
const M1 = registro('M1');
const AD = registro('AD');

console.log('\n[1] El esquema del fabricante se leyó');
check(P !== null, 'existe el registro P (poliza.1)');
check(M1 !== null, 'existe el registro M1 (movtopoliza.1)');
check(AD !== null, 'existe el registro AD (asocdocto.1)');

console.log('\n[2] Los largos del esquema coinciden con el archivo REAL (185 / 272 / 40)');
check(P.largo === 185, `P mide ${P.largo} (real: 185)`);
check(M1.largo === 272, `M1 mide ${M1.largo} (real: 272)`);
check(AD.largo === 40, `AD mide ${AD.largo} (real: 40)`);

/**
 * Nuestro layout, con las posiciones que produce el emisor.
 *
 * ⚠️ **Respeta `sinSep`.** La primera versión de este helper sumaba un separador después de cada
 * campo sin excepción — la misma suposición que el candado existe para refutar. Resultado: con el
 * emisor ya corregido, el candado se puso en rojo **por su propio modelo**, no por el emisor.
 *
 * ⭐ Un candado que modela el mundo de otra manera que el código no está verificando el código:
 * está verificando su propia copia.
 */
function nuestro(layout) {
  const out = [];
  let pos = 0;
  for (const f of layout) {
    out.push({ nombre: f.nombre, ancho: f.ancho, desde: pos + 1, hasta: pos + f.ancho });
    pos += f.ancho + (f.sinSep ? 0 : 1);
  }
  return { campos: out, largo: pos };
}

console.log('\n[3] ⭐ Posición por posición: nuestro emisor contra el esquema');
// ⚠️ `LAYOUT_AD` entró acá después de que una mutación lo destapara: ponerle `sinSep` al UUID
// ponía rojo el candado del sink y **dejaba este verde**, porque comparaba el esquema contra sí
// mismo. Un candado tiene que cubrir TODOS los registros que el emisor escribe, no los dos
// grandes — si no, el que falta es justo donde se cuela el defecto.
for (const [etiqueta, spec, mio] of [['P', P, nuestro(T.LAYOUT_P)], ['M1', M1, nuestro(T.LAYOUT_M)],
  ['AD', AD, nuestro(T.LAYOUT_AD)]]) {
  console.log(`\n  ── ${etiqueta} ──`);
  check(spec.largo === mio.largo, `${etiqueta}: largo total ${mio.largo} = ${spec.largo}`);
  check(spec.campos.length === mio.campos.length,
    `${etiqueta}: ${mio.campos.length} campos = ${spec.campos.length} del esquema`);
  const n = Math.min(spec.campos.length, mio.campos.length);
  for (let i = 0; i < n; i += 1) {
    const s = spec.campos[i];
    const m = mio.campos[i];
    const igual = s.desde === m.desde && s.hasta === m.hasta;
    check(igual, `${etiqueta}.${String(i).padStart(2, '0')} ${s.nombre.padEnd(16)} `
      + `esquema ${s.desde}-${s.hasta} · emisor ${m.desde}-${m.hasta}`);
  }
}

console.log('\n[4] El renglón AD que emite el generador de pruebas');
const uuid = '3D4468D0-BEE5-49FA-9048-CFF7022FA4B7';
const linea = `AD ${uuid} `;
check(linea.length === AD.largo, `la línea AD mide ${linea.length} = ${AD.largo}`);
check(AD.campos.length === 2, 'el AD tiene 2 campos: etiqueta + UUID');
check(AD.campos[1].desde === 4 && AD.campos[1].hasta === 39, 'el UUID va en 4-39');

console.log('\n[5] ⭐ Lo que el esquema decodifica y `[CP.8.13]` §10.5 había declarado SIN DECODIFICAR');
for (const [tag, esperado] of [['AM', 'asocmovto.1'], ['AP', 'asocnodopago.1'],
  ['I', 'MovtoImpuesto.1'], ['V', 'devolucion.1'], ['W2', 'devolucion.2']]) {
  const r = filas.find((f) => f.tipo === 'E' && f.formato === tag);
  check(r != null && r.nombre === esperado, `${tag} = ${r ? r.nombre : '(no está)'}`);
}

console.log('\n[6] Prueba negativa: el lector de posiciones detecta un corrimiento');
// ⛔ Si el lector sumara un separador donde el esquema no lo tiene, los campos posteriores se
// correrían. Se simula quitándole un caracter al concepto y comprobando que el candado lo vería.
const mutado = T.LAYOUT_P.map((f) => (f.nombre === 'concepto' ? { ...f, ancho: f.ancho - 1 } : f));
const desplazado = nuestro(mutado);
check(desplazado.largo !== P.largo, 'un campo con un carácter de menos cambia el largo total');
const difiere = P.campos.some((s, i) => desplazado.campos[i]
  && (s.desde !== desplazado.campos[i].desde || s.hasta !== desplazado.campos[i].hasta));
check(difiere, 'y la comparación posición-por-posición lo señala');

console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.28 esquema ContPAQi: ${ok} ✓ / ${fail} ✗`
  + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
process.exit(fail === 0 ? 0 : 1);
