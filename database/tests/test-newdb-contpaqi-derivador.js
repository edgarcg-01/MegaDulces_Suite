/**
 * `[CP.8.45]` — Candado del DERIVADOR como carril.
 *
 * ── Qué defiende, y por qué ─────────────────────────────────────────────────────────────────
 *
 * El derivador existía desde `[CP.8.18]`, era read-only, y **se corrió una sola vez** (feb-2026).
 * Medido el 2026-10-12 sobre 8 meses de egresos, los rechazos del puente por `sin_medir` pasaron
 * de **21 en enero a 254 en julio y 231 en agosto**: cada categoría de CB nacida después de
 * aquella ventana cae ahí y se queda. *Un carril es script + agenda + latido; faltaban los dos
 * últimos.*
 *
 * Lo que este candado vigila NO es que el derivador acierte — eso lo prueba su placebo. Vigila
 * **lo que su `--apply` se niega a tocar**, que es donde está el dinero:
 *
 *   1. ⛔ **Nunca escribe `cuenta_gasto`, `confianza_pct` ni `estado`.** Son la firma del
 *      contador. Una cuenta equivocada **cuadra igual** y no se ve hasta la balanza, así que un
 *      asiento que cuadra y está mal es peor que uno que no cuadra.
 *   2. ⛔ **Sólo toca filas en `sin_medir`.** Reclasificar en silencio una regla ya medida es
 *      mover dinero sin que nadie lo haya decidido.
 *   3. ⛔ **Exige que el tipo sobreviva al filtro 1:1.** `[CP.8.27]` midió que `cobranza` y
 *      `servicios` CAMBIAN de tipo al restringir (sus pólizas promedian 255 y 4.9 renglones): un
 *      tipo que depende del agrupamiento no es un tipo.
 *   4. ⭐ **Sin `--apply` no escribe nada**, y el `.trim()` del argumento está puesto por la
 *      quemada de `[VL.4]`, donde un `--apply` con CR de un crontab con CRLF dejó nueve carriles
 *      corriendo en seco e imprimiendo "ok".
 *   5. El carril tiene **umbral registrado** — sin él `db-health` da verde incondicional.
 *
 * ⚠️ NO ejerce la escritura: necesita el SQL Server de ContPAQi (.35) y `dev_ro` es read-only
 * por diseño. Se declara `NO MEDIDO` en vez de inventar un verde (ADR-056).
 *
 * Lee prod en SOLO LECTURA.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const knexLib = require('knex');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'database/scripts/derivar-reglas-contpaqi.js');
const AGENDA = path.join(ROOT, 'ops/vl/crontab.feeds');
const HEALTH = path.join(ROOT, 'apps/api/src/modules/db-health/db-health.service.ts');
const TENANT = '00000000-0000-0000-0000-00000000d01c';

let pass = 0;
let fail = 0;
let nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const noMedido = (m) => { nm++; console.log('  ◻ NO MEDIDO: ' + m); };

(async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  console.log('\n[1] El --apply se NIEGA a escribir la firma del contador');
  const updates = src.match(/UPDATE contpaqi\.account_rules[\s\S]*?WHERE[\s\S]*?`/g) || [];
  ok(updates.length === 1, `hay exactamente UN UPDATE a account_rules (hay ${updates.length})`);
  const upd = updates[0] || '';
  /**
   * ⚠️ La primera versión de esta aserción decía `SET[\s\S]*estado\s*=` y daba **ROJO sobre un
   * UPDATE correcto**: `[\s\S]*` cruza el `SET` y llega hasta el `WHERE`, donde
   * `estado = 'sin_regla'` aparece a propósito. Medía el tramo equivocado.
   *
   * ⭐ *Una aserción que no acota su alcance no prueba lo que dice su mensaje.* El SET se AÍSLA.
   */
  const setClause = (upd.match(/SET([\s\S]*?)WHERE/) || [, ''])[1];
  ok(setClause.length > 0, 'el tramo SET del UPDATE se puede aislar del WHERE');
  for (const col of ['cuenta_gasto', 'confianza_pct', 'estado']) {
    ok(!new RegExp(`\\b${col}\\s*=`).test(setClause),
      `el SET NO escribe \`${col}\` — es la firma del contador`);
  }
  ok(/SET\s+tipo_regla\s*=/.test(upd), 'escribe `tipo_regla` (la clasificacion, que si es nuestra)');
  ok(/forma_medida\s*=/.test(upd), 'y deja la evidencia en `forma_medida`');

  console.log('\n[2] Las guardas del WHERE — una sola que falte y pisa trabajo ajeno');
  ok(/tipo_regla\s*=\s*'sin_medir'/.test(upd), 'solo toca filas en `sin_medir`');
  ok(/estado\s*=\s*'sin_regla'/.test(upd), 'solo si el contador NO firmo');

  console.log('\n[3] El tipo tiene que sobrevivir al filtro 1:1 ([CP.8.27])');
  ok(/estables\.get\([^)]*\)\s*===\s*'SI'/.test(src),
    'el candidato exige `estable === SI` — un tipo que cambia bajo 1:1 no se aplica');
  ok(/pareados\s*>=\s*MIN_VOTOS/.test(src), 'y exige muestra (`pareados >= MIN_VOTOS`)');

  console.log('\n[4] En seco no escribe, y el argumento se compara TRIMEADO ([VL.4])');
  ok(/\.map\(\(a\)\s*=>\s*a\.trim\(\)\)\.includes\('--apply'\)/.test(src),
    '`--apply` se compara con .trim() — un CR dejo 9 carriles en seco diciendo "ok"');
  // ⚠️ `[^}]*` tampoco servía: el cuerpo trae un template literal con `${...}`, o sea llaves.
  ok(/if\s*\(!APPLY\)[\s\S]{0,200}?continue;/.test(src), 'sin `--apply` sigue de largo sin tocar la base');
  ok(/if\s*\(APPLY\)\s*\{[\s\S]{0,400}cron_runs/.test(src), 'el latido tambien cuelga de APPLY (no late en seco)');

  console.log('\n[5] La ventana se DERIVA, no esta escrita a mano');
  ok(!/arg\('hasta',\s*'20\d\d-\d\d-\d\d'\)/.test(src),
    '`--hasta` ya no tiene una fecha literal por default (caducaba sin avisar)');
  ok(/primeroDeMesActual/.test(src), 'la ventana llega hasta el 1 del mes actual: solo meses cerrados');

  console.log('\n[6] El carril: agenda + umbral (sin los dos, es un script)');
  const agenda = fs.readFileSync(AGENDA, 'utf8');
  ok(/contpaqi-derivador/.test(agenda), 'tiene linea en `ops/vl/crontab.feeds`');
  ok(/derivar-reglas-contpaqi\.js --apply/.test(agenda), 'y la linea lleva `--apply`');
  const health = fs.readFileSync(HEALTH, 'utf8');
  ok(/key:\s*'contpaqi_derivador'/.test(health),
    'umbral registrado en `CRON_JOBS` — sin el, db-health da verde incondicional');

  console.log('\n[7] El freno de clasificador muerto sigue ANTES del apply');
  const iFreno = src.indexOf('FATAL: el clasificador puso TODO en el mismo cubo');
  const iApply = src.indexOf('const APPLY =');
  ok(iFreno > 0 && iApply > 0 && iFreno < iApply,
    'el process.exit(2) del clasificador roto corre ANTES de escribir nada');

  console.log('\n[8] Contra prod: el estado que este carril existe para mover');
  const knex = knexLib({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
  try {
    const filas = await knex('contpaqi.account_rules').where({ tenant_id: TENANT })
      .select('tipo_regla').count({ n: '*' }).groupBy('tipo_regla');
    const porTipo = Object.fromEntries(filas.map((f) => [f.tipo_regla, Number(f.n)]));
    console.log('     tipos en prod:', JSON.stringify(porTipo));
    ok(Object.keys(porTipo).length > 0, 'las reglas existen en prod');
    const sinMedir = porTipo.sin_medir ?? 0;
    console.log(`     ${sinMedir} reglas en \`sin_medir\` — es lo que este carril va a ir bajando`);
    const latido = await knex('analytics.cron_runs').where({ job_key: 'contpaqi_derivador' }).first();
    if (latido) {
      ok(['ok', 'error'].includes(latido.status), `el carril ya latio (${latido.status})`);
    } else {
      noMedido('el carril nunca corrio en prod: falta desplegar la agenda (`ops/vl/deploy.sh`)');
    }
    noMedido('la ESCRITURA del --apply: necesita el SQL Server de ContPAQi y `dev_ro` es read-only');
  } finally {
    await knex.destroy();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.45 derivador como carril: ${pass} ✓ / ${fail} ✗ · ${nm} NO MEDIDO`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
