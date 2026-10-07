/* eslint-disable no-console */
/**
 * FIQ.5 (geolocalización) — Smoke del CONTRATO de datos de la ubicación.
 *
 * Sin DB: valida que un pin de ubicación de Meta fluye correcto por toda la
 * cadena y aterriza donde el geofence de entrega lo lee:
 *   Meta webhook (location) → adapter.normalize → InboundMessage.location
 *   → orchestrator merge → delivery_address {lat,lng,street}
 *   → home-delivery parseCoords (§LM.4 geofence) → {lat,lng}
 *
 * Replica EXACTA de las 3 piezas (adapter/orchestrator/home-delivery) para
 * blindar el contrato entre el canal y la última milla.
 */
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// 1) Réplica de MetaCloudWhatsAppAdapter.normalize (rama 'location').
function adapterNormalize(m) {
  let type = 'unsupported';
  let text = null;
  let location = null;
  if (m?.type === 'location') {
    type = 'location';
    const lat = Number(m?.location?.latitude);
    const lng = Number(m?.location?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      location = { lat, lng, name: m?.location?.name ?? null, address: m?.location?.address ?? null };
      text = m?.location?.address || m?.location?.name || null;
    }
  }
  return { type, text, location };
}

// 2) Réplica del merge del orquestador (handleTurn).
function orchestratorMerge(existingAddress, loc) {
  if (!(loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng))) return existingAddress;
  return {
    ...(existingAddress || {}),
    lat: loc.lat,
    lng: loc.lng,
    street: (existingAddress && existingAddress.street) || loc.address || loc.name || 'Ubicación compartida (pin)',
  };
}

// 3) Réplica de CommercialHomeDeliveryService.parseCoords (consumidor del geofence).
function parseCoords(deliveryAddress) {
  if (!deliveryAddress) return null;
  const a = typeof deliveryAddress === 'string' ? JSON.parse(deliveryAddress) : deliveryAddress;
  const lat = Number(a?.lat);
  const lng = Number(a?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

(async () => {
  try {
    // Pin real de WhatsApp (CDMX centro), sin dirección textual.
    const metaMsg = { type: 'location', location: { latitude: 19.4326, longitude: -99.1332 } };
    const inbound = adapterNormalize(metaMsg);
    ok(inbound.type === 'location', 'adapter reconoce type=location');
    ok(inbound.location && inbound.location.lat === 19.4326 && inbound.location.lng === -99.1332, 'adapter extrae lat/lng del pin');

    // Sin domicilio previo → toma placeholder + coords.
    const addr1 = orchestratorMerge(null, inbound.location);
    ok(addr1.lat === 19.4326 && addr1.lng === -99.1332, 'orchestrator mete coords en delivery_address');
    ok(addr1.street === 'Ubicación compartida (pin)', 'sin calle previa → placeholder');
    const coords1 = parseCoords(addr1);
    ok(coords1 && coords1.lat === 19.4326 && coords1.lng === -99.1332, 'geofence (parseCoords) LEE las coords del pin');
    // Y también desde el JSONB serializado (como lo guarda la DB).
    ok(!!parseCoords(JSON.stringify(addr1)), 'parseCoords funciona sobre el delivery_address serializado (JSONB)');

    // Con domicilio textual previo → conserva la calle, agrega coords.
    const addr2 = orchestratorMerge({ street: 'Av. Juárez 100', references: 'casa azul' }, inbound.location);
    ok(addr2.street === 'Av. Juárez 100' && addr2.references === 'casa azul', 'conserva calle/referencias previas');
    ok(addr2.lat === 19.4326, 'agrega coords al domicilio textual existente');

    // Pin con dirección de Meta → usa esa dirección como street.
    const withAddr = adapterNormalize({ type: 'location', location: { latitude: 20.1, longitude: -98.7, address: 'Calle Falsa 123' } });
    const addr3 = orchestratorMerge(null, withAddr.location);
    ok(addr3.street === 'Calle Falsa 123', 'usa la dirección del pin como street si viene');

    // Ubicación malformada (sin coords) → no rompe, no ensucia el domicilio.
    const bad = adapterNormalize({ type: 'location', location: { name: 'x' } });
    ok(bad.location === null, 'pin sin lat/lng → location null (no coords inválidas)');
    ok(orchestratorMerge({ street: 'X' }, bad.location).lat === undefined, 'merge ignora una ubicación sin coords');

    console.log(`\nFIQ.5 location: ${pass} ✓ / ${fail} ✗`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message || e);
    process.exit(1);
  }
})();
