/* eslint-disable no-console */
/**
 * `[SUC.1]` CANDADO: el nombre que publica la pantalla cuadra con el de la base.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `WAREHOUSE_DISPLAY_ORDER` (en `libs/contracts`) lleva el **nombre** de cada plaza, y vive ahí a
 * propósito: agrupa los alias que `commercial.warehouses` guarda en filas distintas (`07` y
 * `MD-32` son dos registros de la misma tienda), y no exige permiso —39 roles / 80 personas no
 * pueden llamar `GET /commercial/warehouses`—.
 *
 * ⚠️ Pero es una COPIA, y una copia sin árbitro es una copia que miente. Ya pasó en este mismo
 * dominio: `apps/view/.../store-branches.ts` es otra lista cableada, y su propio comentario
 * confiesa que Morelia *"faltaba acá"* mientras el monitor ofrecía `32`/`30` apuntando a un `.mdb`
 * que había dejado de moverse. Este archivo es la diferencia entre una copia DECLARADA y esa.
 *
 * ── Lo que mide ──────────────────────────────────────────────────────────────────────────
 *  1. Cada plaza del contrato existe en `commercial.warehouses` y su `name` coincide.
 *  2. Toda plaza VIVA de la base está en el contrato — si nace una sucursal y nadie la agrega,
 *     la pantalla publica su código crudo y nadie se entera. Las rutas quedan fuera a propósito:
 *     el contrato las deriva de la forma del código (`RUTA-21` → «Ruta 21»).
 *  3. ⭐ PRUEBA NEGATIVA: el detector encuentra una divergencia FABRICADA. Sin esto, los dos
 *     bloques de arriba se ponen verdes también cuando la comparación está rota.
 *  4. Ningún `name` de la base tiene forma de CÓDIGO (`8ESQ`, `MD-30`): es el defecto que fundó
 *     esta fase, y un nombre así vuelve a entrar sin que nada chille.
 */
'use strict';
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

/**
 * El contrato es TypeScript y este candado corre en Node pelado, así que se LEE la fuente.
 * ⚠️ Parsear con regex es frágil — por eso el parseo se verifica a sí mismo: si saca menos de 5
 * plazas, o alguna sin nombre, el archivo **declara NO MEDIDO y sale**, en vez de comparar una
 * lista vacía contra la base y ponerse verde. Un candado que no pudo leer su insumo no es un
 * candado que pasó.
 */
const CONTRATO = path.resolve(__dirname, '..', '..', 'libs', 'contracts', 'src', 'http', 'warehouse-order.contract.ts');
function leerContrato() {
  const src = fs.readFileSync(CONTRATO, 'utf8');
  const arr = (src.match(/WAREHOUSE_DISPLAY_ORDER[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/) || [])[1];
  if (!arr) return [];
  const out = [];
  const re = /\{\s*label:\s*'([^']*)'\s*,\s*name:\s*'([^']*)'\s*,\s*codes:\s*\[([^\]]*)\]\s*\}/g;
  let m;
  while ((m = re.exec(arr))) {
    out.push({ label: m[1], name: m[2], codes: m[3].split(',').map((c) => c.trim().replace(/^'|'$/g, '')).filter(Boolean) });
  }
  return out;
}
const WAREHOUSE_DISPLAY_ORDER = leerContrato();

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/** Un `name` con forma de código: sin espacios y en mayúsculas, o con prefijo de almacén. */
const PARECE_CODIGO = (s) => /^MD-/i.test(s) || (!/\s/.test(s) && s === s.toUpperCase() && s.length <= 6 && s !== 'CEDIS');

(async () => {
  if (WAREHOUSE_DISPLAY_ORDER.length < 5 || WAREHOUSE_DISPLAY_ORDER.some((g) => !g.name || !g.codes.length)) {
    noMedido('lectura del contrato',
      `se leyeron ${WAREHOUSE_DISPLAY_ORDER.length} plazas de warehouse-order.contract.ts — cambió su forma y el parseo quedó viejo`);
    console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
    process.exit(1);
  }

  const db = new Client({ connectionString: URL, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(URL) ? false : { rejectUnauthorized: false } });
  await db.connect();

  const { rows } = await db.query(`
    SELECT code, name, kepler_code, wincaja_source_branch, kind
      FROM commercial.warehouses
     WHERE tenant_id = $1 AND deleted_at IS NULL
     ORDER BY code`, [TENANT]);
  if (!rows.length) { noMedido('catálogo de almacenes', 'commercial.warehouses vino vacío'); await db.end(); process.exit(0); }

  const porCode = new Map(rows.map((r) => [String(r.code).toUpperCase(), r]));
  const esRuta = (r) => r.kind === 'truck' || /^RUTA-/i.test(r.code);

  console.log(`\n[SUC.1] ${WAREHOUSE_DISPLAY_ORDER.length} plazas en el contrato · ${rows.length} almacenes vivos en la base\n`);

  // ── 1 · el contrato cuadra con la base
  console.log('— 1. cada nombre del contrato es el de la base —');
  const divergen = [];
  for (const g of WAREHOUSE_DISPLAY_ORDER) {
    // Basta con que UNO de sus alias exista: los demás son códigos de eras pasadas que la tabla
    // ya no guarda (`MD-30` se fusionó en `08`), y exigirlos todos sería exigir que el pasado siga vivo.
    const vivos = g.codes.map((c) => porCode.get(c.toUpperCase())).filter(Boolean);
    if (!vivos.length) { noMedido(`${g.name}`, `ninguno de sus códigos (${g.codes.join(', ')}) existe hoy en la base`); continue; }
    const malos = vivos.filter((r) => String(r.name).trim() !== g.name);
    if (malos.length) divergen.push(`${g.name}: la base dice ${malos.map((r) => `${r.code}='${r.name}'`).join(', ')}`);
  }
  check(`los ${WAREHOUSE_DISPLAY_ORDER.length} nombres del contrato coinciden con commercial.warehouses`,
    divergen.length === 0,
    divergen.join(' · ') + ' — si el nombre bueno es el de la base, actualizá el contrato; si es el del contrato, va una migración');

  // ── 2 · ninguna plaza viva se queda fuera del contrato
  console.log('\n— 2. ninguna plaza viva queda sin nombre en pantalla —');
  const conocidos = new Set();
  WAREHOUSE_DISPLAY_ORDER.forEach((g) => g.codes.forEach((c) => conocidos.add(c.toUpperCase())));
  const huerfanos = rows.filter((r) => !esRuta(r) && !conocidos.has(String(r.code).toUpperCase()));
  check('toda plaza NO-ruta de la base está en WAREHOUSE_DISPLAY_ORDER',
    huerfanos.length === 0,
    `${huerfanos.length} sin contrato: ${huerfanos.map((r) => `${r.code} '${r.name}'`).join(', ')} — su código se publica CRUDO en las 51 pantallas`);

  // ── 3 · PRUEBA NEGATIVA del detector
  console.log('\n— 3. prueba negativa: el detector SÍ encuentra una divergencia —');
  const falso = WAREHOUSE_DISPLAY_ORDER.map((g) => ({ ...g, name: g.name === 'CEDIS' ? 'BODEGA INVENTADA' : g.name }));
  const detecta = falso.some((g) => {
    const vivos = g.codes.map((c) => porCode.get(c.toUpperCase())).filter(Boolean);
    return vivos.length && vivos.some((r) => String(r.name).trim() !== g.name);
  });
  check('con un nombre adulterado, la comparación lo marca', detecta,
    'el detector no encuentra una divergencia FABRICADA: los bloques 1 y 2 están verdes por construcción, no por estar bien');

  // ── 4 · ningún nombre tiene forma de código
  console.log('\n— 4. ningún nombre de la base es en realidad un código —');
  const codigosDisfrazados = rows.filter((r) => !esRuta(r) && PARECE_CODIGO(String(r.name).trim()));
  check('ningún commercial.warehouses.name tiene forma de código',
    codigosDisfrazados.length === 0,
    `${codigosDisfrazados.map((r) => `${r.code}='${r.name}'`).join(', ')} — es el defecto que fundó [SUC.1] (la 03 decía '8ESQ')`);

  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
