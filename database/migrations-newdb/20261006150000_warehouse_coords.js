'use strict';
/**
 * `[VEC.9]` — Coordenadas de las sucursales. Sin esto no hay "la más cercana".
 *
 * ── Por qué hacía falta ─────────────────────────────────────────────────────────────────
 * `commercial.warehouses` tiene `latitude`/`longitude` desde hace tiempo y estaban en **NULL
 * en los 22 almacenes activos**: la columna existía y nadie la pobló. Es el patrón que este
 * proyecto ya midió varias veces (`warehouse_bins` con backend y UI completos y 0 filas):
 * **una columna que existe no es una columna poblada.**
 *
 * Datos provistos por Edgar el 2026-10-06 (domicilio + coordenada de cada sucursal).
 *
 * ── Sólo las 9 SUCURSALES, no los 22 almacenes ──────────────────────────────────────────
 * De los 22 activos, **13 son camiones de ruta** (`kind='truck'`: RUTA-21, RUTA-501…). Un
 * camión no tiene domicilio fijo — se mueve — así que una coordenada suya sería una mentira
 * con formato de dato. Quedan 9 `kind='central'`.
 *
 * ⚠️ **CEDIS (`00`) queda SIN coordenada, declarado.** No vino en los datos. No se deduce de
 * la dirección ni se le pone la de otra: una coordenada inventada no falla — manda a alguien
 * al lugar equivocado y nadie se entera. El motor de sugerencias lo va a declarar como
 * `sin_coordenada` en vez de excluirlo en silencio. **Pendiente: Edgar.**
 *
 * ── Lo que las compuertas cuidan ────────────────────────────────────────────────────────
 * Una coordenada mal tecleada —o con el signo cambiado, o lat/lng invertidas— **no rompe
 * nada**: el sistema calcula una distancia y recomienda la sucursal equivocada. Por eso no
 * alcanza con "se escribieron 8 filas"; hay que comprobar que la GEOGRAFÍA tiene sentido:
 *
 *   · dentro de la caja de México (lat 14–33, lng −118…−86) → caza signos invertidos;
 *   · dos sucursales distintas no pueden estar en el mismo punto → caza un copiar/pegar;
 *   · **pares conocidos**: las tres de La Piedad tienen que quedar a menos de 5 km entre sí,
 *     y Morelia a más de 50 km de La Piedad. Si alguien invierte lat y lng, esto revienta.
 *
 * Verificado antes de escribir (matriz completa, lectura contra prod):
 *   Padre Hidalgo ↔ 8ESQ 0.8 km · ↔ La Piedad Abastos 2.3 km · 8ESQ ↔ La Piedad 1.6 km
 *   Zamora Centro ↔ Canindo 6.8 km · Morelia Madero ↔ Morelia Abastos 6.6 km
 *   La Piedad ↔ Yurécuaro 25.3 km · ↔ Zamora 48 km · ↔ Morelia 110 km
 *
 * Idempotente: re-correrla escribe los mismos valores.
 *
 * @param { import("knex").Knex } knex
 */

/** code → [nombre esperado, lat, lng]. El nombre es para la compuerta, no para escribir. */
const COORDENADAS = {
  '01': ['Padre Hidalgo', 20.346363, -102.018444],
  '02': ['La Piedad Abastos', 20.345874, -102.040322],
  '03': ['8ESQ', 20.343141, -102.025576],
  '04': ['Yurécuaro', 20.341472, -102.283127],
  '05': ['Zamora Centro', 19.980057, -102.285881],
  '06': ['Canindo', 19.9367, -102.2406],
  '07': ['Morelia Madero', 19.703538, -101.228775],
  '08': ['Morelia Abastos', 19.715472, -101.167317],
};

/** Haversine en km. La misma fórmula que va a usar el motor de sugerencias. */
function km(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLng = (bLng - aLng) * r;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

exports.up = async function up(knex) {
  let escritas = 0;
  for (const [code, [nombre, lat, lng]] of Object.entries(COORDENADAS)) {
    const n = await knex('commercial.warehouses')
      .where({ code })
      .whereNull('deleted_at')
      .update({ latitude: lat, longitude: lng, updated_at: knex.fn.now() });
    if (n === 0) {
      throw new Error(
        `[VEC.9] no existe el almacén con code='${code}' (${nombre}). ` +
          'El catálogo cambió: revisar antes de escribir coordenadas a ciegas.',
      );
    }
    escritas += n;
  }
  console.log(`  [VEC.9] ${escritas} sucursal(es) con coordenada.`);

  // ── COMPUERTAS sobre el RESULTADO ────────────────────────────────────────────────────
  const { rows: geo } = await knex.raw(`
    SELECT code, name, latitude::float8 AS lat, longitude::float8 AS lng
      FROM commercial.warehouses
     WHERE kind = 'central' AND active AND deleted_at IS NULL
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY code`);

  // [1] PISO — una comparación sobre un conjunto vacío se pone verde sola ([ID.28]).
  if (geo.length < Object.keys(COORDENADAS).length) {
    throw new Error(`[VEC.9] sólo ${geo.length} sucursales con coordenada; se esperaban ${Object.keys(COORDENADAS).length}.`);
  }

  // [2] Dentro de México. Caza un signo invertido, que es el error más fácil de cometer
  //     (y el más difícil de ver: la distancia sale enorme pero plausible).
  const fuera = geo.filter((g) => g.lat < 14 || g.lat > 33 || g.lng < -118 || g.lng > -86);
  if (fuera.length) {
    throw new Error(
      `[VEC.9] fuera de México: ${fuera.map((f) => `${f.name} (${f.lat}, ${f.lng})`).join(' · ')}`,
    );
  }

  // [3] Dos sucursales distintas no comparten punto. Caza un copiar/pegar entre renglones.
  for (let i = 0; i < geo.length; i++) {
    for (let j = i + 1; j < geo.length; j++) {
      if (km(geo[i].lat, geo[i].lng, geo[j].lat, geo[j].lng) < 0.05) {
        throw new Error(`[VEC.9] ${geo[i].name} y ${geo[j].name} están en el mismo punto.`);
      }
    }
  }

  // [4] PARES CONOCIDOS — la compuerta que de verdad caza lat/lng invertidas. Las tres de
  //     La Piedad son vecinas; Morelia está a más de 100 km. Si alguien invierte el par, las
  //     dos afirmaciones se rompen a la vez.
  const porCode = Object.fromEntries(geo.map((g) => [g.code, g]));
  const dist = (a, b) => km(porCode[a].lat, porCode[a].lng, porCode[b].lat, porCode[b].lng);
  const vecinas = dist('01', '03'); // Padre Hidalgo ↔ 8ESQ, medido 0.8 km
  const lejanas = dist('02', '07'); // La Piedad ↔ Morelia Madero, medido 110.9 km
  if (!(vecinas < 5)) {
    throw new Error(`[VEC.9] Padre Hidalgo y 8ESQ dan ${vecinas.toFixed(1)} km y están a menos de 1: coordenadas mal cargadas.`);
  }
  if (!(lejanas > 50)) {
    throw new Error(`[VEC.9] La Piedad y Morelia dan ${lejanas.toFixed(1)} km y están a más de 100: coordenadas mal cargadas.`);
  }
  console.log(`  [VEC.9] geografía coherente: PH↔8ESQ ${vecinas.toFixed(1)} km · LP↔Morelia ${lejanas.toFixed(1)} km.`);

  // [5] Lo que FALTA se declara, no se esconde. CEDIS no vino en los datos.
  const { rows: sinGeo } = await knex.raw(`
    SELECT code, name FROM commercial.warehouses
     WHERE kind = 'central' AND active AND deleted_at IS NULL
       AND (latitude IS NULL OR longitude IS NULL)
     ORDER BY code`);
  if (sinGeo.length) {
    console.log(
      `  [VEC.9] ◻ DECLARADO — sin coordenada: ${sinGeo.map((s) => `${s.code} ${s.name}`).join(', ')}. ` +
        'El motor las va a reportar como sin_coordenada, no las va a excluir en silencio.',
    );
  }
  // Si mañana aparecen 5 sucursales nuevas sin coordenada, esto tiene que doler.
  if (sinGeo.length > 1) {
    throw new Error(
      `[VEC.9] ${sinGeo.length} sucursales sin coordenada (al escribir esto era 1, CEDIS): ` +
        `${sinGeo.map((s) => s.name).join(', ')}. Cargarlas o ampliar esta migración.`,
    );
  }
};

exports.down = async function down(knex) {
  await knex('commercial.warehouses')
    .whereIn('code', Object.keys(COORDENADAS))
    .update({ latitude: null, longitude: null });
};
