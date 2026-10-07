/**
 * Distancia en metros entre dos coordenadas geograficas usando la formula
 * de Haversine. Replica la misma logica del backend
 * (`apps/api/src/modules/stores/stores.service.ts:haversine`) para que la
 * deteccion offline produzca los mismos resultados que `/stores/nearby`.
 *
 * Asume coordenadas decimales (no DMS) y la Tierra como esfera (radio
 * 6371 km). Error < 0.5% en distancias menores a 1000 km, suficiente para
 * un radio tipico de deteccion de 50-100m.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
