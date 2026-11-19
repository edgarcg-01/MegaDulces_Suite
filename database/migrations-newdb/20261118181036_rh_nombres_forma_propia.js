'use strict';
/**
 * `[RH.14.9]` — Una sola forma de escribir el nombre de las personas (Edgar, 2026-11-18: «para todos los usuarios … que
 * no se quede sólo minúsculas o sólo mayúsculas»). Corrige los nombres que YA existen; los que entran después los
 * escriben así la Suite (Administración › Personas) y RH (`nombrePropio` en `libs/contracts/src/personas`).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-18) ────────────────────────────────────────
 *  · `identity.users` con `kind = 'interno'`: 1,241 sin borrar → 419 en MAYÚSCULAS, 14 en minúsculas, ~38 mezcladas a
 *    medias («Juan pablo», «EDITH Picard»). El ensayo de esta regla contra prod: ver el tracker `[RH.14.9]`.
 *  · Se dejan como están: las cuentas que no son personas (`servicio`, `dispositivo`, `cliente`: razones sociales y
 *    equipos) y los nombres que son una credencial o un ID («francisco.compras», «Empleado 96»): reformatearlos los
 *    escondería en vez de arreglarlos.
 *
 * Cada cambio deja su asiento en `identity.user_events` (`nombre_forma_propia`, con el nombre ANTERIOR): el `down` lo
 * regresa desde ahí, sólo si nadie lo volvió a cambiar después.
 *
 * ⚠️ Sólo hace UPDATE/INSERT: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA a todo el equipo hasta que
 *    alguien la aplique a mano. Aplicala ANTES de mergear (`database/scripts/apply-one-migration-prod.js`).
 *
 * Idempotente: una segunda corrida no encuentra nada que cambiar.
 *
 * @param { import("knex").Knex } knex
 */

const MARCA = '20261118181036_rh_nombres_forma_propia';
const EVENTO = 'nombre_forma_propia';

// ── COPIA de `libs/contracts/src/personas/nombre-propio.ts` (la migración corre sin `libs/`). ─────────────────────
// `nombre-propio.spec.ts` exige que las dos decidan IGUAL: si cambias una, cambia la otra.
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos', 'van', 'von', 'di']);
/** «la», «las», «los» van en minúscula sólo después de «de» («María de la Paz»); solos son apellido («La Rosa»). */
const ARTICULOS = new Set(['la', 'las', 'los']);
const MAYUS = /[A-ZÁÉÍÓÚÜÑ]/;
const VOCAL = /[AEIOUÁÉÍÓÚÜaeiouáéíóúü]/;
/** Minúscula seguida de mayúscula dentro de la palabra («JorgeRubio»): se escribió así a propósito o pegada; no se toca. */
const CAMEL = /[a-záéíóúüñ][A-ZÁÉÍÓÚÜÑ]/;

function esNombreDePersona(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  if (/[0-9@_]/.test(s)) return false;
  if (!/\s/.test(s) && s.includes('.')) return false;
  return /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(s);
}

function capitalizar(seg, respetarSiglas) {
  if (!seg) return seg;
  if (/^(jr|sr)\.?$/i.test(seg)) return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
  if (seg.length <= 3 && seg === seg.toUpperCase() && MAYUS.test(seg) && (respetarSiglas || !VOCAL.test(seg))) return seg;
  const bajo = seg.toLocaleLowerCase('es-MX');
  return bajo.charAt(0).toLocaleUpperCase('es-MX') + bajo.slice(1);
}

function nombrePropio(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!esNombreDePersona(s)) return s;
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  const uniforme = letras === letras.toUpperCase() || letras === letras.toLowerCase();
  const palabras = s.split(' ');
  return palabras.map((palabra, i) => {
    const bajo = palabra.toLocaleLowerCase('es-MX');
    const previa = i > 0 ? palabras[i - 1].toLocaleLowerCase('es-MX') : '';
    if (i > 0 && PARTICULAS.has(bajo) && (!ARTICULOS.has(bajo) || previa === 'de')) return bajo;
    if (CAMEL.test(palabra)) return palabra;
    return palabra.split(/([-'’/])/).map((seg) => (/^[-'’/]$/.test(seg) ? seg : capitalizar(seg, !uniforme))).join('');
  }).join(' ');
}
// ── fin de la copia ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que cambiaría: personas internas sin borrar cuyo nombre no está en su forma propia. */
async function propuestas(knex) {
  const filas = await knex('identity.users').where({ kind: 'interno' }).whereNull('deleted_at').whereNotNull('nombre')
    .select('id', 'tenant_id', 'nombre');
  return filas.map((f) => ({ ...f, nuevo: nombrePropio(f.nombre) })).filter((f) => f.nuevo !== f.nombre);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const cambios = await propuestas(knex);
  for (const c of cambios) {
    // Se vuelve a exigir el nombre leído: si cambió en medio, no se pisa.
    const n = await knex('identity.users').where({ id: c.id, nombre: c.nombre }).update({ nombre: c.nuevo, updated_at: knex.fn.now() });
    if (!n) continue;
    await knex('identity.user_events').insert({
      tenant_id: c.tenant_id, user_id: c.id, event: EVENTO,
      detalle: JSON.stringify({ antes: c.nombre, despues: c.nuevo, migracion: MARCA }),
      actor_username: MARCA,
    });
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: sólo donde el nombre sigue siendo el que dejó. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const eventos = await knex('identity.user_events').where({ event: EVENTO }).whereRaw(`detalle->>'migracion' = ?`, [MARCA])
    .select('id', 'user_id', 'detalle');
  for (const e of eventos) {
    const d = typeof e.detalle === 'string' ? JSON.parse(e.detalle) : e.detalle;
    await knex('identity.users').where({ id: e.user_id, nombre: d.despues }).update({ nombre: d.antes, updated_at: knex.fn.now() });
    await knex('identity.user_events').where({ id: e.id }).del();
  }
};

exports.nombrePropio = nombrePropio;
exports.propuestas = propuestas;
