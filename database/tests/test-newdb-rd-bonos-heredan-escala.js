/* eslint-disable no-console */
/**
 * `[RD.85.0]` CANDADO: **una versión nueva del tabulador NO puede nacer sin bonos.**
 *
 * ── Qué destapó esto ─────────────────────────────────────────────────────────────────────
 *
 * `commission_bonuses` cuelga de `scale_id`, y el motor los lee con
 * `where({ scale_id: scale.id })`. `createScaleVersion()` —el acto para el que existe la
 * pantalla de configuración— copiaba los **escalones** a la escala nueva y **no los bonos**.
 * Medido contra prod el 2026-10-20:
 *
 *     la única escala que existe ..... 17 bonos · 4 escalones
 *     el libro pagó en bonos ......... $140,800 en 20 quincenas = $7,040 por quincena
 *
 * ⛔ O sea: **cambiar un escalón habría dejado de pagar $7,040 por quincena**, sin error y sin
 * aviso — porque *«no hay bonos configurados» es indistinguible de «ningún bono se cumplió»*.
 * Es el mismo defecto que dejó el arqueo de caja ocho días en cero.
 *
 * ── Qué vigila ───────────────────────────────────────────────────────────────────────────
 *
 * **1. La invariante:** si alguna escala tuvo bonos, **ninguna escala vigente puede tener 0**.
 * Es lo que se rompe en el momento exacto en que alguien estrena un tabulador con el bug vivo.
 *
 * **2. El CONTROL, para que la invariante no sea un no-op.** Con una sola escala la regla se
 * cumple sola y el verde no significa nada. Así que primero se comprueba que **exista al menos
 * una escala con bonos**; si no, se declara **NO MEDIDO** en vez de ✔ (ADR-056).
 *
 * **3. Lo que se hereda tiene que estar COMPLETO**: `periodo` en todas las filas (sin él un
 * bono mensual entra a las dos quincenas y se paga dos veces, `[RD.59]`) y `grupo`/`peso_pct`
 * siempre juntos (el CHECK lo exige, pero una copia parcial lo violaría en el INSERT y es más
 * barato saber que la invariante se mira acá).
 *
 * **4. Los pesos del objetivo siguen sumando 100** en la escala vigente. Si la copia perdiera
 * un criterio, el techo del bono mensual bajaría en silencio.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-bonos-heredan-escala.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 120000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  console.log(`\n=== [RD.85.0] los bonos se heredan · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  const { rows: escalas } = await db.query(
    `SELECT s.id, s.nombre, to_char(s.valid_from,'YYYY-MM-DD') desde,
            to_char(s.valid_to,'YYYY-MM-DD') hasta, (s.valid_to IS NULL) vigente,
            (SELECT count(*)::int FROM commercial.commission_bonuses b
              WHERE b.scale_id = s.id AND b.deleted_at IS NULL) bonos,
            (SELECT count(*)::int FROM commercial.commission_scale_tiers t
              WHERE t.scale_id = s.id AND t.deleted_at IS NULL) escalones
       FROM commercial.commission_scales s
      WHERE s.tenant_id = $1 AND s.deleted_at IS NULL
      ORDER BY s.valid_from`, [TENANT]);

  check('hay al menos un tabulador', escalas.length > 0);
  for (const e of escalas) {
    console.log(`     ${e.desde} → ${e.hasta ?? 'vigente'} · ${e.bonos} bono(s) · ${e.escalones} escalón(es)`);
  }

  // ── 2. El CONTROL: ¿hay con qué probar la invariante? ───────────────────────────────────
  const conBonos = escalas.filter((e) => e.bonos > 0);
  if (!conBonos.length) {
    noMedido('la herencia de bonos',
      'ninguna escala tiene bonos: la invariante se cumpliría sola y el verde no significaría nada');
  } else {
    check('existe el control: al menos una escala con bonos', true,
      `${conBonos.length} de ${escalas.length}`);

    // ── 1. La invariante ──────────────────────────────────────────────────────────────────
    const vigentesVacias = escalas.filter((e) => e.vigente && e.bonos === 0);
    check('ninguna escala VIGENTE tiene cero bonos', vigentesVacias.length === 0,
      vigentesVacias.length
        ? `${vigentesVacias.map((e) => e.desde).join(', ')} — se estrenó un tabulador y los bonos `
          + 'se quedaron en la escala anterior: la quincena siguiente paga $0 de bono, en silencio'
        : '');
  }

  // ── 3. Lo heredado está completo ────────────────────────────────────────────────────────
  const { rows: [sinPeriodo] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_bonuses
      WHERE tenant_id = $1 AND deleted_at IS NULL
        AND (periodo IS NULL OR periodo NOT IN ('quincena','mes'))`, [TENANT]);
  check('todos los bonos declaran su periodo', sinPeriodo.n === 0,
    `${sinPeriodo.n} sin periodo — un bono mensual sin marcar se paga DOS VECES (RD.59)`);

  const { rows: [pesoHuerfano] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_bonuses
      WHERE tenant_id = $1 AND deleted_at IS NULL
        AND ((grupo IS NULL) <> (peso_pct IS NULL))`, [TENANT]);
  check('grupo y peso_pct viajan juntos', pesoHuerfano.n === 0, `${pesoHuerfano.n} fila(s) a medias`);

  // ── 4. Los pesos del objetivo suman 100 en la escala vigente ────────────────────────────
  const { rows: grupos } = await db.query(
    `SELECT b.grupo, sum(b.peso_pct)::numeric total, count(*)::int n
       FROM commercial.commission_bonuses b
       JOIN commercial.commission_scales s ON s.id = b.scale_id
      WHERE b.tenant_id = $1 AND b.deleted_at IS NULL AND s.valid_to IS NULL
        AND b.grupo IS NOT NULL
      GROUP BY 1`, [TENANT]);
  if (!grupos.length) {
    noMedido('los pesos del objetivo', 'la escala vigente no tiene criterios con grupo');
  } else {
    for (const g of grupos) {
      check(`los pesos de "${g.grupo}" suman 100 en la escala vigente`,
        Math.abs(Number(g.total) - 100) < 0.0001, `suman ${g.total}% en ${g.n} criterio(s)`);
    }
  }

  // ⛔ Lo que esto NO prueba, declarado en vez de darse por verde.
  noMedido('la copia en sí (createScaleVersion)',
    'estrenar una escala es una ESCRITURA: exige API arriba y el repo prohíbe levantar backend '
    + 'local. Este candado caza el resultado —una vigente sin bonos— la próxima vez que corra');

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n✖ error:', e.message); process.exit(1); });
