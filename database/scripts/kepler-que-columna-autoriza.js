#!/usr/bin/env node
/**
 * `[GX.28]` — **¿En qué columna de Kepler queda QUIÉN autorizó el vale?**
 *
 * ## El problema, exacto
 * En Kepler alguien abre el vale y le pone **N** o **A**. Ese flag ya lo tenemos: es
 * `kdm1.c43` → `analytics.expense_requests.estado`, decodificado y documentado
 * (`N` por ejercer · `A` autorizada · `F` aplicada · `C` cancelada).
 *
 * Lo que **no** sabemos es dónde queda el NOMBRE de quien le dio la A. Los dos candidatos
 * obvios ya están descartados por la documentación de la vista:
 *
 *   · `c30` → se expone como `autoriza`, pero la migración `20260821200000` lo midió y es
 *     un **ÁREA**, no una persona: «FINANZAS / DPTO FINANZAS / DEPARTAMENTO DE FINANSAS
 *     conviven». 94% de las solicitudes lo traen, y traen el departamento.
 *   · `c67` → se expone como `usuario`, y es **quien CAPTURÓ** la solicitud, no quien la
 *     autorizó. Son dos personas distintas y dos momentos distintos.
 *
 * ⛔ La regla del proyecto es no adivinar una fuente: hay que MEDIRLA. Y no se puede medir
 * desde una base de desarrollo, porque `kepler_ods.kdm1` está vacía ahí.
 *
 * ## Qué hace este script
 * Fotografía **todas** las columnas con dato de UNA solicitud, dos veces: antes y después
 * de que una persona la autorice en Kepler. La columna que cambió —y que contiene un
 * nombre o unas iniciales— es la respuesta. No hay que leer 201 columnas a mano: el diff
 * las nombra.
 *
 * ## Cómo usarlo (necesita LAN al ODS, no corre desde una máquina sin acceso)
 *   1. Elegí un vale que todavía esté en `N` y anotá su folio y sucursal.
 *   2.  node database/scripts/kepler-que-columna-autoriza.js --folio=0009843 --sucursal=00 --antes
 *   3. Pedile a quien autoriza que le dé **A** en Kepler, y esperá a que el CDC lo traiga
 *      (segundos; el carril `ods_live_hot` corre cada 15 s).
 *   4.  node database/scripts/kepler-que-columna-autoriza.js --folio=0009843 --sucursal=00 --despues
 *
 * El paso 4 imprime el diff y marca las columnas sospechosas.
 *
 * ## Lo que este script NO prueba
 * Que la columna sea SIEMPRE la del autorizador. Una sola observación puede confundirse
 * con otra cosa que cambió al mismo tiempo (una fecha de modificación, un consecutivo).
 * Por eso imprime TODO lo que se movió, no sólo su favorita, y por eso conviene repetirlo
 * con un segundo vale antes de escribir código que dependa de la respuesta.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const DIR = path.resolve(__dirname, '../../tmp');

function arg(nombre, porDefecto) {
  const m = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return m ? m.split('=')[1] : porDefecto;
}

/** Las que ya sabemos qué son: si cambian, no son noticia. */
const CONOCIDAS = {
  c6: 'folio', c9: 'fecha', c16: 'importe', c43: 'estado (N/A/F/C) — el flag que ya leemos',
  c48: 'solicitante', c32: 'beneficiario', c24: 'concepto', c67: 'usuario que CAPTURÓ',
  c30: 'autoriza (es un ÁREA, no una persona)', c10: 'cuenta', c22: 'rfc', c14: 'iva',
  c90: 'forma de pago', c11: 'referencia', c68: 'fecha de captura', c69: 'hora de captura',
};

/** ¿El valor parece un nombre de persona o unas iniciales? Pista, no veredicto. */
function pareceUsuario(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 60) return false;
  if (/^\d+([.,]\d+)?$/.test(s)) return false;          // números: no
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;       // fechas: no
  return /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(s);
}

async function foto(knex, folio, sucursal) {
  const r = await knex('kepler_ods.kdm1')
    .where({ sucursal })
    .whereRaw('btrim(c6) = ?', [folio])
    .whereRaw("c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '15' AND btrim(c5::text) = '1'")
    .first();
  if (!r) throw new Error(`No existe la solicitud ${folio} en la sucursal ${sucursal}.`);
  // Sólo las columnas CON dato: de 201, las vacías no dicen nada.
  const con = {};
  for (const [k, v] of Object.entries(r)) {
    const s = v == null ? '' : String(v).trim();
    if (s !== '') con[k] = s;
  }
  return con;
}

async function main() {
  const folio = String(arg('folio', '')).trim();
  const sucursal = String(arg('sucursal', '')).trim();
  const antes = process.argv.includes('--antes');
  const despues = process.argv.includes('--despues');

  if (!folio || !sucursal || (!antes && !despues)) {
    console.error('Uso: --folio=0009843 --sucursal=00 --antes   (y luego --despues)');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL_LOCAL;
  if (!url) {
    console.error('⛔ Falta DATABASE_URL_NEW: este script lee `kepler_ods`, que sólo existe donde llega el CDC.');
    process.exit(1);
  }
  const knex = require('knex')({ client: 'pg', connection: url });
  const archivo = path.join(DIR, `kepler-autoriza-${sucursal}-${folio}.json`);

  try {
    const ahora = await foto(knex, folio, sucursal);

    if (antes) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(archivo, JSON.stringify(ahora, null, 2));
      console.log(`✔ Foto ANTES guardada: ${Object.keys(ahora).length} columnas con dato → ${archivo}`);
      console.log(`  estado actual (c43): ${ahora.c43 ?? '—'}`);
      console.log('\n  Ahora pedí que lo autoricen en Kepler y volvé con --despues.');
      return;
    }

    if (!fs.existsSync(archivo)) {
      console.error(`⛔ No hay foto ANTES para ${folio}. Corré primero con --antes.`);
      process.exit(1);
    }
    const previo = JSON.parse(fs.readFileSync(archivo, 'utf8'));

    const cambios = [];
    for (const k of new Set([...Object.keys(previo), ...Object.keys(ahora)])) {
      if (previo[k] !== ahora[k]) cambios.push({ col: k, antes: previo[k] ?? '(vacía)', despues: ahora[k] ?? '(vacía)' });
    }

    console.log(`\nDiff de la solicitud ${folio} (sucursal ${sucursal}) — ${cambios.length} columna(s) cambiaron\n`);
    if (!cambios.length) {
      // ⚠️ Cero cambios NO significa «no existe la columna»: puede que nadie haya
      // autorizado todavía, o que el CDC no lo haya traído. Se DECLARA, no se concluye.
      console.log('  Ninguna. O todavía no lo autorizaron, o el CDC aún no trajo el cambio.');
      console.log(`  estado (c43) sigue en: ${ahora.c43 ?? '—'}`);
      return;
    }

    for (const c of cambios) {
      const sabida = CONOCIDAS[c.col];
      const pista = !sabida && pareceUsuario(c.despues) && c.antes === '(vacía)' ? '  ⭐ CANDIDATA' : '';
      console.log(`  ${c.col.padEnd(6)} ${String(c.antes).slice(0, 30).padEnd(32)} → ${String(c.despues).slice(0, 30).padEnd(32)}${sabida ? '  (' + sabida + ')' : ''}${pista}`);
    }

    const candidatas = cambios.filter((c) => !CONOCIDAS[c.col] && pareceUsuario(c.despues));
    console.log('');
    if (candidatas.length === 1) {
      console.log(`⭐ Una sola candidata: **${candidatas[0].col}** = "${candidatas[0].despues}".`);
      console.log('   Repetilo con OTRO vale antes de escribir código que dependa de esto:');
      console.log('   una sola observación no distingue al autorizador de algo que cambió al mismo tiempo.');
    } else if (candidatas.length > 1) {
      console.log(`⚠️ ${candidatas.length} candidatas: ${candidatas.map((c) => c.col).join(', ')}.`);
      console.log('   Hace falta un segundo vale para desempatar.');
    } else {
      console.log('⚠️ Ninguna columna nueva con texto: puede que Kepler guarde al autorizador');
      console.log('   en otra tabla (una bitácora), y no en el renglón de la solicitud.');
    }
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
