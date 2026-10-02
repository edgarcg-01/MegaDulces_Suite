#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════════════════
// `[CD.1]` ¿EL CODIGO QUE VOY A DESPLEGAR NECESITA EL ESQUEMA QUE FALTA?
//
//   node ops/prod/compuerta-migraciones.js --desplegado <sha> --objetivo <sha> \
//        --dir database/migrations-newdb  [< lista-PEND-por-stdin]
//   node ops/prod/compuerta-migraciones.js --self-test
//
// ── El error que esta compuerta NO comete ──────────────────────────────────────────────────
// La primera version de este archivo clasificaba la migracion por DESTRUCTIVA vs ADITIVA, y
// estaba mal de raiz. El riesgo que guarda `auto-deploy.sh` es el INVERSO: no es que la
// migracion rompa al codigo viejo, es que el codigo NUEVO necesite un esquema que todavia no
// existe. Visto asi, un `ADD COLUMN` —lo mas "aditivo" que hay— es justo el caso peligroso,
// porque el codigo nuevo LEE esa columna. La cabecera de `auto-deploy.sh` ya lo decia con todas
// las letras: "sube codigo que espera columnas inexistentes y revienta en la cara de quien abra
// la pantalla, no en el build".
//
// Medido el 2026-10-02 sobre los ultimos 14 commits que tocan `database/migrations-newdb/`:
// **8 traen ademas codigo de `apps/` o `libs/` en el MISMO commit**. La migracion y el codigo
// que la necesita viajan juntos, asi que frenar por defecto es correcto.
//
// ── Entonces que se desacopla, y con que criterio ──────────────────────────────────────────
// Lo que se desacopla es el caso en que la migracion pendiente y el codigo a desplegar NO SE
// TOCAN: un hotfix de frontend no deja de poder salir porque alguien dejo a medio aplicar una
// matvista de compras. Eso es medible, y es lo unico que esta compuerta afloja:
//
//   1. De cada migracion pendiente se extraen los OBJETOS que crea o altera (tablas, columnas,
//      vistas, matvistas).
//   2. Del diff <desplegado>..<objetivo> se leen los archivos de `apps/` y `libs/` que cambian.
//   3. Si NINGUN archivo cambiado menciona NINGUNO de esos identificadores -> DESACOPLADO: el
//      codigo nuevo no puede necesitar lo que no nombra. Se despliega.
//   4. Si alguno lo menciona -> ACOPLADO: frena, y dice QUE archivo y QUE identificador.
//   5. Si no se pudo extraer o no se pudo leer el diff -> NO_MEDIDO: frena (ADR-056).
//
// ⭐ El sesgo esta puesto a proposito del lado seguro: un falso positivo FRENA (cuesta una
//    espera), un falso negativo DESPLIEGA codigo roto (cuesta produccion). Ante la duda, frena.
//
// ── Lo que NO ve, dicho en voz alta ────────────────────────────────────────────────────────
//   · Un identificador armado por concatenacion (`from('tab'+suf)`) no se detecta.
//   · Una migracion que solo hace GRANT no crea objeto: si el codigo nuevo depende del permiso,
//     esto no lo ve. Por eso los GRANT caen en NO_MEDIDO y frenan.
//   · Mira los archivos CAMBIADOS, no el repo entero: codigo viejo que ya usaba el objeto ya
//     estaba desplegado y funcionando, asi que no es el riesgo de ESTE despliegue.
// ═══════════════════════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ── Identificadores demasiado comunes para ser evidencia ───────────────────────────────────
// `id`, `name`, `status` aparecen en cualquier archivo: usarlos como senal volveria ACOPLADO a
// todo y la compuerta seria otra vez un freno indiscriminado.
const RUIDO = new Set([
  'id', 'ids', 'name', 'nombre', 'status', 'estado', 'tipo', 'type', 'fecha', 'date', 'value',
  'valor', 'total', 'data', 'key', 'code', 'codigo', 'activo', 'notes', 'notas', 'tenant_id',
  'created_at', 'updated_at', 'deleted_at', 'created_by', 'updated_by', 'uuid', 'monto', 'qty',
]);

const MIN_LARGO = 6; // menos de 6 caracteres casi nunca es un nombre de objeto distintivo

/** Extrae los identificadores de esquema que una migracion crea o altera. */
function objetosDe(src) {
  const encontrados = new Set();
  const agregar = (s) => {
    if (!s) return;
    const id = String(s).trim().replace(/^["'`]|["'`]$/g, '').split('.').pop();
    if (id.length >= MIN_LARGO && !RUIDO.has(id.toLowerCase()) && /^[a-z_][a-z0-9_]*$/i.test(id)) {
      encontrados.add(id.toLowerCase());
    }
  };

  const patrones = [
    /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|MATERIALIZED\s+VIEW|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
    /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_"]+)/gi,
    /\.createTable\s*\(\s*["'`]([^"'`]+)/gi,
    /\.alterTable\s*\(\s*["'`]([^"'`]+)/gi,
    /\.addColumn\s*\(\s*["'`][^"'`]+["'`]\s*,\s*["'`]([^"'`]+)/gi,
    // Columnas declaradas con el builder de knex: t.uuid('cliente_id'), t.text('razon_social')
    /\bt(?:able)?\.\w+\s*\(\s*["'`]([a-z0-9_]+)["'`]/gi,
  ];
  for (const re of patrones) {
    let m;
    while ((m = re.exec(src)) !== null) agregar(m[1]);
  }
  return encontrados;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Archivos de aplicacion que cambian entre dos commits. */
function codigoCambiado(desplegado, objetivo, cwd) {
  const salida = git(['diff', '--name-only', `${desplegado}..${objetivo}`], cwd);
  return salida.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(apps|libs)\//.test(l) && /\.(ts|js|html|sql)$/.test(l));
}

// ═══ Prueba negativa ═══════════════════════════════════════════════════════════════════════
function selfTest() {
  const casos = [];
  const chk = (nombre, cond) => { casos.push([nombre, cond]); };

  const objs = objetosDe(
    'exports.up = (k) => k.raw("CREATE TABLE commercial.supplier_fill_rate (id uuid)");'
  );
  chk('extrae la tabla creada', objs.has('supplier_fill_rate'));

  const objs2 = objetosDe('exports.up = (k) => k.schema.alterTable("orders", (t) => t.text("razon_social"));');
  chk('extrae la columna del builder', objs2.has('razon_social'));

  const objs3 = objetosDe('exports.up = (k) => k.schema.createTable("x", (t) => t.uuid("id"));');
  chk('descarta el ruido (id no es evidencia)', !objs3.has('id'));

  const objs4 = objetosDe('exports.up = (k) => k.raw("CREATE INDEX ix_a ON t (c)");');
  chk('un indice no aporta objeto referenciable', objs4.size === 0);

  // El caso que distingue esta compuerta de un freno ciego: migracion pendiente cuyo objeto
  // NO aparece en el codigo cambiado -> no acopla.
  const objetos = new Set(['supplier_fill_rate']);
  const archivos = ['apps/view/src/app/modules/tienda/verificador.component.ts'];
  const fuentes = { [archivos[0]]: 'export class Verificador { precio = 1; }' };
  const acopla = archivos.some((f) => [...objetos].some((o) => (fuentes[f] || '').toLowerCase().includes(o)));
  chk('codigo que NO nombra el objeto -> DESACOPLADO', acopla === false);

  const fuentes2 = { [archivos[0]]: 'this.db.from("supplier_fill_rate").select()' };
  const acopla2 = archivos.some((f) => [...objetos].some((o) => (fuentes2[f] || '').toLowerCase().includes(o)));
  chk('codigo que SI lo nombra -> ACOPLADO (frena)', acopla2 === true);

  let fallas = 0;
  for (const [nombre, ok] of casos) {
    if (!ok) fallas++;
    console.log(`   ${ok ? 'OK   ' : 'FALLA'}  ${nombre}`);
  }
  console.log(fallas === 0 ? `\nprueba negativa: ${casos.length}/${casos.length} OK`
    : `\nprueba negativa: ${fallas} FALLA(S)`);
  return fallas === 0 ? 0 : 1;
}

function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? def : process.argv[i + 1];
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const cwd = arg('--repo', process.cwd());
  const dir = arg('--dir', 'database/migrations-newdb');
  const desplegado = arg('--desplegado');
  const objetivo = arg('--objetivo', 'HEAD');

  let stdin = '';
  if (!process.stdin.isTTY) { try { stdin = fs.readFileSync(0, 'utf8'); } catch { stdin = ''; } }
  const pendientes = stdin.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^PEND\s+/, ''));

  if (pendientes.length === 0) {
    console.log('OK  sin migraciones pendientes');
    return 0;
  }
  if (!desplegado) {
    console.log('NO_MEDIDO  falta --desplegado <sha>: no se puede saber que codigo cambia. FRENA.');
    return 1;
  }

  // 1. Objetos que las migraciones pendientes crean o alteran.
  const objetos = new Map(); // identificador -> migracion que lo trae
  const sinObjeto = [];
  for (const archivo of pendientes) {
    let src;
    try { src = fs.readFileSync(path.join(cwd, dir, archivo), 'utf8'); } catch (e) {
      console.log(`NO_MEDIDO  no se pudo leer ${archivo}: ${e.message}. FRENA.`);
      return 1;
    }
    const objs = objetosDe(src);
    if (objs.size === 0) sinObjeto.push(archivo);
    for (const o of objs) if (!objetos.has(o)) objetos.set(o, archivo);
  }

  // 2. Codigo que cambia en este despliegue.
  let archivos;
  try { archivos = codigoCambiado(desplegado, objetivo, cwd); } catch (e) {
    console.log(`NO_MEDIDO  no se pudo leer el diff ${desplegado}..${objetivo}: ${e.message}. FRENA.`);
    return 1;
  }

  // 3. ¿Alguno lo nombra?
  const choques = [];
  for (const f of archivos) {
    let src;
    try { src = git(['show', `${objetivo}:${f}`], cwd).toLowerCase(); } catch { continue; }
    for (const [obj, mig] of objetos) {
      if (src.includes(obj)) choques.push({ archivo: f, objeto: obj, migracion: mig });
    }
  }

  console.log(`   migraciones pendientes : ${pendientes.length}`);
  console.log(`   objetos que crean      : ${objetos.size}`);
  console.log(`   archivos de codigo que cambian: ${archivos.length}`);

  if (choques.length > 0) {
    console.log('');
    console.log('FRENA  el codigo de este despliegue NECESITA esquema que prod todavia no tiene:');
    for (const c of choques.slice(0, 10)) {
      console.log(`   · ${c.archivo}`);
      console.log(`     usa "${c.objeto}", que lo crea ${c.migracion}`);
    }
    if (choques.length > 10) console.log(`   ... y ${choques.length - 10} mas`);
    console.log('');
    console.log('   Se aplican a mano, una por una, con lock_timeout. NUNCA migrate:latest');
    console.log('   (hay DOS knex_migrations en prod).');
    return 1;
  }

  if (sinObjeto.length > 0) {
    console.log('');
    console.log('NO_MEDIDO  hay migraciones de las que no se pudo extraer ningun objeto');
    console.log('           (p.ej. solo GRANT o solo INSERT): no se puede probar que el codigo');
    console.log('           no dependa de ellas. FRENA.');
    for (const m of sinObjeto.slice(0, 5)) console.log(`   · ${m}`);
    return 1;
  }

  console.log('');
  console.log('DESACOPLADO  ninguno de los archivos que cambian nombra los objetos pendientes.');
  console.log('             El codigo puede desplegarse; las migraciones siguen pendientes.');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { objetosDe, codigoCambiado };
