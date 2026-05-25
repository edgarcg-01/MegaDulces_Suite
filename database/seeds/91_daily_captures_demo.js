/**
 * Seed: daily_captures demo para los tres capturistas activos.
 *
 * Genera ~320 capturas diarias distribuidas entre maria_rocha, angel_vazquez y
 * enrique_fuentes durante el mes 2026-04-22 → 2026-05-21 (lun-sáb, sin domingos).
 *
 * Fórmula maestra (idéntica a ScoringV2Service.calcularScoreExhibicionSync):
 *   score_exh = ubicacion.puntuacion × concepto.puntuacion × nivel.puntuacion
 *   score_visita = Σ score_exh
 *
 * Productos sesgados: ~60% del catálogo de productos "top" (canels, japoneses,
 * mazapán, chicles/gummies) y ~40% del resto del catálogo activo.
 *
 * Idempotente: si ya hay capturas en el rango de fechas, NO inserta nada.
 *
 * Para correrlo:
 *   npx knex seed:run --specific 91_daily_captures_demo.js --knexfile database/knexfile.js
 *
 * Para revertirlo (si fuera necesario):
 *   DELETE FROM daily_captures
 *   WHERE fecha BETWEEN '2026-04-22' AND '2026-05-21'
 *     AND captured_by_username IN ('maria_rocha','angel_vazquez','enrique_fuentes');
 */

const { randomUUID } = require('crypto');

// ─── Configuración ───────────────────────────────────────────────────────────

const START_DATE = '2026-04-22';
const END_DATE = '2026-05-21';

const USER_TARGETS = {
  maria_rocha: { initial: 'M', target: 130 },
  angel_vazquez: { initial: 'A', target: 110 },
  enrique_fuentes: { initial: 'E', target: 80 },
};

// Centro aproximado de La Piedad de Cabadas, Michoacán
const GPS_CENTER = { lat: 20.3475, lng: -102.0617 };
const GPS_JITTER = 0.025; // ~2.5 km radio

// Bias de distribución (calibrado para score visita promedio mensual 90-100
// con visitas altas y bajas — variabilidad natural)
const POSICION_WEIGHTS = {
  Adyacente: 25,
  Vitrina: 25,
  Exhibidor: 20,
  Caja: 15,
  Refrigerador: 8,
  Anaquel: 5,
  Detras: 2,
};

const CONCEPTO_WEIGHTS = {
  Tira: 35,
  Refrigerador: 25,
  Vitrina: 25,
  Exhibidor: 15,
};

const NIVEL_WEIGHTS = {
  Medio: 45,
  Alto: 40,
  Bajo: 10,
  'Crítico': 5,
};

const RANGOS_COMPRA = ['>500', '>1000', '>1500', '>2000', '>2500'];
const RANGO_WEIGHTS = [40, 30, 18, 8, 4];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function pickWeighted(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickWeightedByMap(items, weightMap, keyField = 'value') {
  const weights = items.map((it) => weightMap[it[keyField]] ?? 1);
  return pickWeighted(items, weights);
}

function gaussian(mean, std) {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function workingDaysBetween(start, end) {
  // Inclusive on both ends, excluding Sundays (getDay() === 0).
  const days = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    if (d.getUTCDay() !== 0) {
      days.push(new Date(d));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function distributeAcrossDays(target, days) {
  // Reparte `target` capturas en los `days` con variación natural.
  const counts = days.map(() => 0);
  for (let i = 0; i < target; i++) {
    counts[randInt(0, days.length - 1)]++;
  }
  return days.map((d, i) => ({ date: d, count: counts[i] }));
}

function formatDateYYYYMMDD(d) {
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

function formatTimeHHMMSS(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function buildFolio(initial, dateObj, hhmmss, extra) {
  // J-31-153045 estilo → adaptado: M-20260430-091523
  return `${initial}-${formatDateYYYYMMDD(dateObj)}-${hhmmss}${extra ? '-' + extra : ''}`;
}

// Distribución global por tier (suma 1.0).
// Los 3 productos hero del estudio de mercado tienen slot propio dedicado.
const TIER_PROBABILITY = {
  hero_mazapan_larosa: 0.15, // 7 SKUs La Rosa con mazap*
  hero_canels_4s:      0.15, // 6 SKUs Canel's 4s
  hero_japoneses_60g:  0.12, // 2 SKUs (Japonés 60g + JAPONES TUBO 60G)
  larosa:              0.10, // resto de La Rosa (bombones, paletas, nugs, ranita, etc.)
  pelon:               0.08, // Pelón Pelo Rico (18)
  canels_otros:        0.06, // resto Canel's (gomitas, ICEE)
  cajeta:              0.05, // Cajeta (11) — Michoacán
  picoso:              0.07, // Lucas/Muecas/Skwinkles/Vero/Pulparindo/Tamarindo/Chamoy
  otros_top:           0.05, // Carlos V/Bubulubu/Mamut/Bocadín/Halls/Sonric's/Takis/Trident/Bubbaloo (sin LaPosse mazapanes)
  other:               0.17, // resto del catálogo (gummies, abarrotes, LaPosse mazapanes)
};

// Cap global: ningún producto puede aparecer más de N veces en todo el seed
const PER_PRODUCT_CAP = 200;

// Compatibilidad concepto ↔ formato del producto.
// Un mazapán NO se presenta en tira, un chicle 4S NO se exhibe en refrigerador, etc.
// Canels 4s (chicles) NO van en Tira — van en Exhibidor (formato display típico de abarrote).
function isConceptoCompatible(productName, conceptoValue) {
  const n = productName.toLowerCase();
  const isRefri = /(electrolit|jumex|boing|lala|leche)/i.test(n);
  const isBulk = /(bolsa\s*\d|granel|vitrolero|\d+\s?kg|\d\.\d+\s?kg|kilo|surtido|display)/i.test(n);
  const isMazapanOrSuelto = /(mazapa|mazapan|nugs|bombon|bombón)/i.test(n);
  const isCanelsChicle = /^canels?\s*4s?|canels?\s*4\s/i.test(n);

  if (conceptoValue === 'Refrigerador') {
    return isRefri || /hershey|ferrero|kinder/i.test(n);
  }
  if (conceptoValue === 'Tira') {
    // Tira: productos pequeños individuales (Pelón tira, Lucas tira, etc.)
    // NO bulk, NO mazapán, NO refrigerados, NO Canels chicles (van en Exhibidor)
    if (isBulk || isMazapanOrSuelto || isRefri || isCanelsChicle) return false;
    return true;
  }
  // Vitrina y Exhibidor: cualquier cosa excepto refrigerados explícitos
  return !isRefri;
}

function pickProductsMarcados(pools, conceptoValue, n, globalPickCounts, perProductCap = PER_PRODUCT_CAP) {
  // pools = { hero_mazapan_larosa: [...], hero_canels_4s: [...], ... }
  // Filtramos cada pool por:
  //   (a) compatibilidad con el concepto
  //   (b) cap global de apariciones (un producto se excluye si ya alcanzó el cap)
  const filtered = {};
  for (const key of Object.keys(pools)) {
    filtered[key] = pools[key].filter(
      (p) =>
        isConceptoCompatible(p.nombre, conceptoValue) &&
        (globalPickCounts.get(p.id) ?? 0) < perProductCap,
    );
  }

  const tiers = Object.keys(TIER_PROBABILITY);
  const cumulative = [];
  let acc = 0;
  for (const t of tiers) {
    acc += TIER_PROBABILITY[t];
    cumulative.push([t, acc]);
  }

  const picked = new Set();
  let attempts = 0;
  while (picked.size < n && attempts < n * 8) {
    attempts++;
    const r = Math.random();
    let chosenTier = 'other';
    for (const [tier, threshold] of cumulative) {
      if (r < threshold) {
        chosenTier = tier;
        break;
      }
    }
    let pool = filtered[chosenTier];
    if (!pool || pool.length === 0) {
      // Fallback: si el tier elegido no tiene productos compatibles, intenta cualquier tier no vacío
      const nonEmpty = tiers.filter((t) => filtered[t].length > 0);
      if (nonEmpty.length === 0) break;
      pool = filtered[nonEmpty[randInt(0, nonEmpty.length - 1)]];
    }
    const p = pool[randInt(0, pool.length - 1)];
    if (!picked.has(p.id)) {
      picked.add(p.id);
      globalPickCounts.set(p.id, (globalPickCounts.get(p.id) ?? 0) + 1);
    }
  }
  return [...picked];
}

// ─── Generador de una captura ────────────────────────────────────────────────

function generateCapture({
  user,
  dateObj,
  ubicaciones,
  conceptos,
  niveles,
  pools,
  globalPickCounts,
  configVersionId,
  scoreMaximoPorExhibicion,
}) {
  // Hora de inicio: jornada típica 8:00-18:00 con ligero sesgo a media mañana
  const horaBase = 8 + clamp(gaussian(3, 2), 0, 10); // pico ~11am
  const horaInicio = new Date(dateObj);
  horaInicio.setUTCHours(
    Math.floor(horaBase),
    randInt(0, 59),
    randInt(0, 59),
    0,
  );

  // Duración: 10.5 min ± 2 min, truncado a [5, 20]
  const duracionMin = clamp(gaussian(10.5, 2.2), 5, 20);
  const horaFin = new Date(horaInicio.getTime() + duracionMin * 60_000);

  // Número de exhibiciones: casi siempre 1 (realidad de campo), ocasional 2-3, raros 4-5
  const r = Math.random();
  const numExh =
    r < 0.75 ? 1
    : r < 0.93 ? 2
    : r < 0.98 ? 3
    : randInt(4, 5);
  const exhibiciones = [];
  let scoreVisitaTotal = 0;
  let totalProductosMarcados = 0;

  // rangoCompra y ventaAdicional son POR VISITA, no por exhibidor
  // (el frontend hace exactamente esto: _visitaVentaAdicional + rangoCompraVisita)
  const rangoCompraVisita = pickWeighted(RANGOS_COMPRA, RANGO_WEIGHTS);

  // Venta adicional de la VISITA completa:
  //   70% → 0 (la visita no generó venta extra)
  //   20% → venta pequeña 50-200
  //   10% → venta media 200-400 (cap 400)
  const ventaRollVisita = Math.random();
  const ventaAdicionalVisita =
    ventaRollVisita < 0.70 ? 0
    : ventaRollVisita < 0.90 ? randInt(50, 200)
    : randInt(200, 400);

  for (let i = 0; i < numExh; i++) {
    const ubicacion = pickWeightedByMap(ubicaciones, POSICION_WEIGHTS);
    const concepto = pickWeightedByMap(conceptos, CONCEPTO_WEIGHTS);
    const nivel = pickWeightedByMap(niveles, NIVEL_WEIGHTS);

    const puntos = Number(
      (
        Number(ubicacion.puntuacion) *
        Number(concepto.puntuacion) *
        Number(nivel.puntuacion)
      ).toFixed(2),
    );

    const numProductos = randInt(2, 6);
    const productosMarcados = pickProductsMarcados(
      pools,
      concepto.value,
      numProductos,
      globalPickCounts,
    );

    // ventaAdicional por exhibidor = 0 (la venta es a nivel visita, no por exhibidor)
    const ventaAdicional = 0;

    const horaRegistro = new Date(
      horaInicio.getTime() +
        ((i + 1) / (numExh + 1)) * (horaFin.getTime() - horaInicio.getTime()),
    );

    exhibiciones.push({
      id: randomUUID(),
      conceptoId: concepto.id,
      ubicacionId: ubicacion.id,
      perteneceMegaDulces: Math.random() < 0.58,
      nivelEjecucion: nivel.value.toLowerCase(),
      nivelEjecucionId: nivel.id,
      productosMarcados,
      rangoCompra: rangoCompraVisita, // mismo para toda la visita
      ventaAdicional,
      fotoUrl: null,
      fotoPublicId: null,
      puntuacionCalculada: puntos,
      horaRegistro: horaRegistro.toISOString(),
    });

    scoreVisitaTotal += puntos;
    totalProductosMarcados += productosMarcados.length;
  }

  scoreVisitaTotal = Number(scoreVisitaTotal.toFixed(2));
  const scoreMaximo = Number((scoreMaximoPorExhibicion * numExh).toFixed(2));
  const scoreFinalPct = scoreMaximo > 0
    ? Number(((scoreVisitaTotal / scoreMaximo) * 100).toFixed(2))
    : null;

  // Calidad = promedio del factor de nivel × 100
  const avgNivel =
    exhibiciones.reduce(
      (sum, e) =>
        sum + Number(niveles.find((n) => n.id === e.nivelEjecucionId).puntuacion),
      0,
    ) / exhibiciones.length;
  const scoreCalidadPct = Number((avgNivel * 100).toFixed(2));

  // Cobertura: proxy basado en promedio de productos por exhibición vs. máximo razonable (6)
  const avgProductosPorExh = totalProductosMarcados / exhibiciones.length;
  const scoreCoberturaPct = Number(
    (clamp(avgProductosPorExh / 6, 0, 1) * 100).toFixed(2),
  );

  // Folio único: incluye fecha completa + segundo
  const folio = buildFolio(
    user.initial,
    horaInicio,
    formatTimeHHMMSS(horaInicio),
  );

  // GPS con jitter alrededor de La Piedad
  const latitud = GPS_CENTER.lat + (Math.random() - 0.5) * GPS_JITTER * 2;
  const longitud = GPS_CENTER.lng + (Math.random() - 0.5) * GPS_JITTER * 2;

  const stats = {
    totalExhibiciones: exhibiciones.length,
    totalProductosMarcados,
    puntuacionTotal: scoreVisitaTotal,
    ventaTotal: ventaAdicionalVisita,
    ventaAdicional: ventaAdicionalVisita,
    rangoCompra: rangoCompraVisita,
  };

  return {
    folio,
    user_id: user.id,
    captured_by_username: user.username,
    zona_captura: user.zona,
    fecha: horaInicio.toISOString().split('T')[0],
    hora_inicio: horaInicio.toISOString(),
    hora_fin: horaFin.toISOString(),
    exhibiciones: JSON.stringify(exhibiciones),
    stats: JSON.stringify(stats),
    latitud,
    longitud,
    store_id: null,
    config_version_id: configVersionId,
    score_maximo: scoreMaximo,
    score_calidad_pct: scoreCalidadPct,
    score_cobertura_pct: scoreCoberturaPct,
    score_final_pct: scoreFinalPct,
    sync_uuid: randomUUID(),
    distancia_tienda: null,
    confianza_ubicacion: 'alta',
    flag_fraude_frontend: false,
    flag_fraude_backend: false,
    flag_revisado_auditoria: false,
    intentos_sincronizacion: 1,
    fecha_creacion_dispositivo: horaInicio.toISOString(),
    fecha_sincronizacion: horaFin.toISOString(),
  };
}

// ─── Seed principal ──────────────────────────────────────────────────────────

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function (knex) {
  // ── Idempotencia ──
  const existing = await knex('daily_captures')
    .whereBetween('fecha', [START_DATE, END_DATE])
    .whereIn(
      'captured_by_username',
      Object.keys(USER_TARGETS),
    )
    .count('* as c');
  const existingCount = Number(existing[0].c);
  if (existingCount > 0) {
    console.log(
      `[91_daily_captures_demo] Ya existen ${existingCount} capturas en ${START_DATE}..${END_DATE} para los 3 capturistas. Skipping.`,
    );
    return;
  }

  // ── Cargar datos del catálogo ──
  const users = await knex('users')
    .whereIn('username', Object.keys(USER_TARGETS))
    .select('id', 'username', 'zona');
  if (users.length !== 3) {
    throw new Error(
      `[91_daily_captures_demo] Esperaba 3 usuarios, encontré ${users.length}. Aborta.`,
    );
  }
  const userMap = Object.fromEntries(
    users.map((u) => [
      u.username,
      { ...u, initial: USER_TARGETS[u.username].initial, target: USER_TARGETS[u.username].target },
    ]),
  );

  const ubicaciones = await knex('catalogs')
    .where({ catalog_id: 'ubicaciones' })
    .select('id', 'value', 'puntuacion');
  const conceptos = await knex('catalogs')
    .where({ catalog_id: 'conceptos' })
    .select('id', 'value', 'puntuacion');
  const niveles = await knex('catalogs')
    .where({ catalog_id: 'niveles' })
    .select('id', 'value', 'puntuacion');

  if (!ubicaciones.length || !conceptos.length || !niveles.length) {
    throw new Error(
      `[91_daily_captures_demo] Faltan catálogos: ubicaciones=${ubicaciones.length}, conceptos=${conceptos.length}, niveles=${niveles.length}`,
    );
  }

  const activeVersion = await knex('scoring_config_versions')
    .whereNull('fecha_fin')
    .orderBy('fecha_inicio', 'desc')
    .first();
  if (!activeVersion) {
    throw new Error(
      `[91_daily_captures_demo] No hay versión activa en scoring_config_versions.`,
    );
  }

  // ── Productos: weighted pool por TIER ──
  // Realidad del abarrote en Michoacán (corregido):
  //   Tier 1 (presencia dominante): La Rosa (marca completa) y Canel's 4s específicamente
  //   Tier 2 (alto): otros Canel's, cajeta (Michoacán), Pelón Pelo Rico
  //   Tier 3 (medio): picosos (Lucas/Muecas/Skwinkles/Vero/Pulparindo/Tamarindo/Chamoy),
  //                   chocolate top (Carlos V/Bubulubu/Mamut/Bocadín), Halls/Sonric's/Takis
  //   Other (bajo): resto del catálogo (gummies Hubin/Jovy, abarrotes generales, etc.)
  const allProducts = await knex('products as p')
    .leftJoin('brands as b', 'p.brand_id', 'b.id')
    .where({ 'p.activo': true })
    .select('p.id', 'p.nombre', 'b.nombre as brand_name');

  const isHeroMazapanLaRosa = (p) =>
    /la\s*rosa/i.test(p.brand_name || '') && /mazap/i.test(p.nombre);

  const isHeroCanels4s = (p) =>
    /^canels?\s*4s?|canels?\s*4\s/i.test(p.nombre);

  const isHeroJaponeses60g = (p) =>
    /japon[eé]s/i.test(p.nombre) && /60\s*g/i.test(p.nombre);

  const isLaRosaRest = (p) => {
    const isBrand =
      /la\s*rosa/i.test(p.brand_name || '') ||
      /(^a\s*rosa|la\s*rosa)/i.test(p.nombre);
    return isBrand && !isHeroMazapanLaRosa(p) && !isHeroJaponeses60g(p);
  };

  const isCanelsOtro = (p) =>
    /canel/i.test(p.brand_name || '') && !isHeroCanels4s(p);
  const isCajeta = (p) => /cajeta/i.test(p.nombre);
  const isPelon = (p) => /pel[oó]n/i.test(p.nombre);
  const isPicoso = (p) =>
    /(lucas|muecas|skwinkle|vero\s|pulparindo|tamarindo|chamoy)/i.test(p.nombre);

  // IMPORTANTE: `mazapa` ya NO está en isOtroTop. LaPosse mazapanes caen
  // en `other`, no en `otros_top`, porque NO son top en abarrote.
  const isOtroTop = (p) =>
    /(carlos\s?v|bubulubu|mamut|bocadin|halls|sonric|takis|trident|bub+aloo)/i.test(
      p.nombre,
    );

  function classifyTier(p) {
    if (isHeroMazapanLaRosa(p)) return 'hero_mazapan_larosa';
    if (isHeroCanels4s(p))      return 'hero_canels_4s';
    if (isHeroJaponeses60g(p))  return 'hero_japoneses_60g';
    if (isLaRosaRest(p))        return 'larosa';
    if (isPelon(p))             return 'pelon';
    if (isCanelsOtro(p))        return 'canels_otros';
    if (isCajeta(p))            return 'cajeta';
    if (isPicoso(p))            return 'picoso';
    if (isOtroTop(p))           return 'otros_top';
    return 'other';
  }

  const pools = {
    hero_mazapan_larosa: [],
    hero_canels_4s:      [],
    hero_japoneses_60g:  [],
    larosa:              [],
    pelon:               [],
    canels_otros:        [],
    cajeta:              [],
    picoso:              [],
    otros_top:           [],
    other:               [],
  };
  for (const p of allProducts) {
    const tier = classifyTier(p);
    pools[tier].push({ id: p.id, nombre: p.nombre });
  }

  console.log(
    `[91_daily_captures_demo] Pool por tier:`,
    Object.entries(pools)
      .map(
        ([t, arr]) =>
          `${t}=${arr.length} (${(TIER_PROBABILITY[t] * 100).toFixed(0)}%)`,
      )
      .join(', '),
  );

  console.log(
    `[91_daily_captures_demo] Catálogo cargado: ${allProducts.length} productos activos.`,
  );

  // ── Score máximo por exhibición (constante) ──
  const maxPos = Math.max(...ubicaciones.map((u) => Number(u.puntuacion)));
  const maxConc = Math.max(...conceptos.map((c) => Number(c.puntuacion)));
  const maxNivel = Math.max(...niveles.map((n) => Number(n.puntuacion)));
  const scoreMaximoPorExhibicion = maxPos * maxConc * maxNivel;

  // ── Calendario hábil ──
  const days = workingDaysBetween(START_DATE, END_DATE);
  console.log(
    `[91_daily_captures_demo] Días hábiles en período: ${days.length}`,
  );

  // ── Generar capturas por usuario ──
  // globalPickCounts: contador compartido entre todas las capturas del seed
  // para enforzar el cap de PER_PRODUCT_CAP apariciones por producto.
  const globalPickCounts = new Map();
  const allCaptures = [];
  const folioSet = new Set();
  for (const username of Object.keys(USER_TARGETS)) {
    const user = userMap[username];
    const dailyCounts = distributeAcrossDays(user.target, days);
    for (const { date, count } of dailyCounts) {
      for (let i = 0; i < count; i++) {
        let cap = generateCapture({
          user,
          dateObj: date,
          ubicaciones,
          conceptos,
          niveles,
          pools,
          globalPickCounts,
          configVersionId: activeVersion.id,
          scoreMaximoPorExhibicion,
        });
        // Garantía dura de unicidad de folio (collision extremadamente rara)
        let suffix = 1;
        while (folioSet.has(cap.folio)) {
          cap.folio = `${cap.folio.split('-').slice(0, 3).join('-')}-${suffix++}`;
        }
        folioSet.add(cap.folio);
        allCaptures.push(cap);
      }
    }
  }

  // ── Bulk insert en batches ──
  console.log(
    `[91_daily_captures_demo] Insertando ${allCaptures.length} capturas...`,
  );
  const BATCH = 100;
  for (let i = 0; i < allCaptures.length; i += BATCH) {
    await knex('daily_captures').insert(allCaptures.slice(i, i + BATCH));
  }
  console.log(
    `[91_daily_captures_demo] ✓ Insertadas ${allCaptures.length} capturas.`,
  );

  // ── Resumen rápido ──
  const summary = await knex('daily_captures')
    .whereBetween('fecha', [START_DATE, END_DATE])
    .whereIn('captured_by_username', Object.keys(USER_TARGETS))
    .select('captured_by_username')
    .count('* as total')
    .avg('score_final_pct as avg_pct')
    .groupBy('captured_by_username');
  console.log('[91_daily_captures_demo] Resumen por capturista:');
  for (const row of summary) {
    console.log(
      `  ${row.captured_by_username}: ${row.total} capturas, score_final_pct avg = ${Number(row.avg_pct).toFixed(1)}`,
    );
  }
};
