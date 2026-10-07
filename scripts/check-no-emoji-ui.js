/**
 * Compuerta: **el texto que ve el usuario no lleva emojis**.
 *
 * La regla existe en el proyecto desde hace rato —*iconos, nunca emojis*— y no la vigilaba nada.
 * El 2026-10-01 se reportó desde una captura: el expediente del motor de margen imprimía
 * ⚠️ y ⛔ en párrafos de la interfaz. Diez instancias, escritas por quien conocía la regla.
 *
 * Por qué importa, y no es estética: un emoji **lo pinta la fuente del sistema operativo**, así
 * que el mismo párrafo sale distinto en Windows, en Android y en el navegador del vendedor; no
 * hereda el color del texto; no se puede alinear a la rejilla; y un lector de pantalla lo lee en
 * voz alta con el nombre Unicode completo. Un `<i class="pi pi-...">` resuelve las cuatro.
 *
 * ── Qué mira y qué NO ─────────────────────────────────────────────────────────────────────
 *  · Mira **sólo lo que se renderiza**: el interior de `template:`, salteando los comentarios
 *    HTML y de línea. Un emoji en un comentario de código no lo ve nadie y no es asunto de esta
 *    compuerta — marcarlo la volvería ruidosa, y una compuerta ruidosa se ignora.
 *  · **Deja fuera a propósito** las marcas tipográficas `✓ ✗ ✕`: son glifos de texto, no
 *    pictogramas, y meterlas en la misma bolsa triplicaría el conteo con casos discutibles.
 *    Si alguna vez se decide que tampoco van, se agregan acá **con su medición**, no de prepo.
 *  · Las flechas (`→`) y los matemáticos (`≥`) tampoco: son puntuación.
 */
const fs = require('fs');
const path = require('path');

/** Pictogramas. Sin flechas (2190-21FF) ni operadores matemáticos (2200-22FF). */
const EMOJI = /[☀-➿⬀-⯿]|[\u{1F000}-\u{1FAFF}]/gu;
/** Marcas tipográficas que NO cuentan, por la razón de arriba. */
const TIPOGRAFICAS = new Set(['✓', '✔', '✗', '✘', '✕', '✖']);

/**
 * ⚠️ Deuda MEDIDA el 2026-10-01, no una meta. Cada una es un párrafo de la interfaz que se pinta
 *    distinto según el sistema operativo de quien lo abre. Congelada para que la siguiente no
 *    entre; se baja arreglando, nunca subíendola.
 */
const TECHO = 75;

const RAICES = ['apps'];
const hallazgos = [];

function recorrer(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (f !== 'node_modules' && f !== 'dist' && !f.startsWith('.')) recorrer(p);
      continue;
    }
    if (!f.endsWith('.ts') && !f.endsWith('.html')) continue;

    const src = fs.readFileSync(p, 'utf8');
    // En un .html todo es template; en un .ts, sólo lo que está adentro de `template:`.
    let tramos = [];
    if (f.endsWith('.html')) {
      tramos = [{ texto: src, desde: 0 }];
    } else {
      const i = src.indexOf('template: `');
      if (i < 0) continue;
      const j = src.indexOf('`,', i);
      if (j < 0) continue;
      tramos = [{ texto: src.slice(i, j), desde: i }];
    }

    for (const t of tramos) {
      let linea = src.slice(0, t.desde).split('\n').length;
      for (const l of t.texto.split('\n')) {
        linea++;
        // Comentario: no se renderiza.
        if (!/^\s*(<!--|\/\/|\*)/.test(l)) {
          const m = l.match(EMOJI);
          if (m) {
            const reales = m.filter((e) => !TIPOGRAFICAS.has(e));
            for (const e of reales) {
              hallazgos.push({ archivo: p, linea, emoji: e, texto: l.trim().slice(0, 78) });
            }
          }
        }
      }
    }
  }
}

for (const r of RAICES) if (fs.existsSync(r)) recorrer(r);

const n = hallazgos.length;
if (n > TECHO) {
  console.log(`\n⛔ ${n} emoji(s) en texto visible (techo ${TECHO})\n`);
  for (const h of hallazgos.slice(0, 12)) {
    console.log(`   ${h.archivo}:${h.linea}  ${JSON.stringify(h.emoji)}`);
    console.log(`      ${h.texto}`);
  }
  if (n > 12) console.log(`   … y ${n - 12} más`);
  console.log('\n   Cómo se arregla: un icono de PrimeIcons con su rótulo, que es lo que la regla');
  console.log('   del proyecto pide. Los que más salen tienen equivalente directo:');
  console.log('      ⚠️  ->  <i class="pi pi-exclamation-triangle" aria-label="Advertencia"></i>');
  console.log('      ⛔  ->  <i class="pi pi-ban" aria-label="Bloqueante"></i>');
  console.log('      ⭐  ->  <i class="pi pi-star-fill" aria-label="Clave"></i>');
  console.log('   ⛔ Subir el techo no es una salida: cada uno se pinta distinto según el sistema');
  console.log('      operativo de quien abre la pantalla.\n');
  process.exit(1);
}

console.log(`✅ ${n} emoji(s) en texto visible (techo ${TECHO}) — ninguno nuevo.`);
