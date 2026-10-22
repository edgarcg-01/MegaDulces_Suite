import { describe, expect, it } from 'vitest';
import {
  VISIT_RADIUS_M,
  addCounts,
  classifyVisit,
  countVisits,
  emptyCounts,
  haversineM,
  parseYmd,
  type VisitCustomerFacts,
} from './visit-protocol.engine';
import { isoDow, mergeVisits } from './visit-monitor.service';
import { arrivalDistanceM } from './commercial-vendor-routes.service';

/**
 * `[MCP.3.7]` Las reglas del protocolo de visitas. Cada `it` fija UNA regla del orden documentado en
 * visit-protocol.engine.ts; la más cara es que lo NO medido nunca sale como falta.
 */
const base = (o: Partial<VisitCustomerFacts> = {}): VisitCustomerFacts => ({
  customer_id: 'c1', code: 'C-1', name: 'Abarrotes Lupita', on_route: true, has_location: true,
  visit: null, ordered: false, nearest_m: null, ...o,
});
const visita = (o: Record<string, unknown> = {}) => ({
  visited_at: '2026-10-21T15:00:00Z', ended_at: null, had_order: false, had_ticket: false,
  no_sale_reason: null, notes: null, distance_m: 12, ...o,
});
const CERRADO = { closed: true, has_gps: true };

describe('classifyVisit — el estado de un cliente en el día', () => {
  it('pedido levantado ese día = con pedido, aunque no haya cerrado la visita', () => {
    expect(classifyVisit(base({ ordered: true }), CERRADO).status).toBe('con_pedido');
    expect(classifyVisit(base({ visit: visita({ had_order: true, ended_at: 'x' }) }), CERRADO).status).toBe('con_pedido');
    expect(classifyVisit(base({ visit: visita({ had_ticket: true }) }), CERRADO).status).toBe('con_pedido');
  });

  it('abrió y cerró sin pedido = sin pedido, con su motivo', () => {
    const r = classifyVisit(base({ visit: visita({ ended_at: '2026-10-21T15:05:00Z', no_sale_reason: 'sin_recursos' }) }), CERRADO);
    expect(r.status).toBe('sin_pedido');
    expect(r.no_sale_reason).toBe('sin_recursos');
  });

  it('un motivo fuera de la lista no se publica', () => {
    const r = classifyVisit(base({ visit: visita({ ended_at: 'x', no_sale_reason: 'inventado' }) }), CERRADO);
    expect(r.no_sale_reason).toBeNull();
  });

  it('abrió y no cerró = abierta (visitado, sin resultado)', () => {
    expect(classifyVisit(base({ visit: visita() }), CERRADO).status).toBe('abierta');
  });

  it('con la ruta abierta, lo no visitado es pendiente — aunque haya pasado cerca', () => {
    expect(classifyVisit(base({ nearest_m: 10 }), { closed: false, has_gps: true }).status).toBe('pendiente');
    expect(classifyVisit(base({ has_location: false }), { closed: false, has_gps: false }).status).toBe('pendiente');
  });

  it('⛔ cliente sin ubicación NUNCA es falta: se declara sin ubicación', () => {
    expect(classifyVisit(base({ has_location: false, nearest_m: null }), CERRADO).status).toBe('sin_ubicacion');
  });

  it('⛔ sin GPS del vendedor NUNCA es falta: se declara sin GPS', () => {
    expect(classifyVisit(base({ nearest_m: 5 }), { closed: true, has_gps: false }).status).toBe('sin_gps');
  });

  it('estuvo dentro del radio y no abrió = se fue sin abrir (falta)', () => {
    expect(classifyVisit(base({ nearest_m: VISIT_RADIUS_M }), CERRADO).status).toBe('se_fue_sin_abrir');
  });

  it('nunca entró al radio = no pasó (falta); sin punto cerca en ~2 km también', () => {
    expect(classifyVisit(base({ nearest_m: VISIT_RADIUS_M + 1 }), CERRADO).status).toBe('no_paso');
    expect(classifyVisit(base({ nearest_m: null }), CERRADO).status).toBe('no_paso');
  });

  it('abrir lejos del cliente se marca (far) con su distancia redondeada', () => {
    const r = classifyVisit(base({ visit: visita({ distance_m: 1234.6 }) }), CERRADO);
    expect(r.distance_m).toBe(1235);
    expect(r.far).toBe(true);
    expect(classifyVisit(base({ visit: visita({ distance_m: 40 }) }), CERRADO).far).toBe(false);
    expect(classifyVisit(base({ visit: visita({ distance_m: null }) }), CERRADO).far).toBe(false);
  });
});

describe('countVisits / addCounts', () => {
  it('visitados = con pedido + sin pedido + abiertas; faltas = se fue + no pasó; lo no medido aparte', () => {
    const rows = [
      classifyVisit(base({ ordered: true }), CERRADO),
      classifyVisit(base({ visit: visita({ ended_at: 'x', distance_m: 500 }) }), CERRADO),
      classifyVisit(base({ visit: visita() }), CERRADO),
      classifyVisit(base({ nearest_m: 3 }), CERRADO),
      classifyVisit(base({ nearest_m: 900 }), CERRADO),
      classifyVisit(base({ has_location: false }), CERRADO),
      classifyVisit(base(), { closed: true, has_gps: false }),
      classifyVisit(base(), { closed: false, has_gps: true }),
    ];
    const c = countVisits(rows);
    expect(c).toEqual({
      clientes: 8, visitados: 3, con_pedido: 1, sin_pedido: 1, abiertas: 1, faltas: 2,
      se_fue_sin_abrir: 1, no_paso: 1, sin_ubicacion: 1, sin_gps: 1, pendientes: 1, lejos: 1,
    });
    expect(addCounts(c, c).faltas).toBe(4);
    expect(addCounts(emptyCounts(), c)).toEqual(c);
  });
});

describe('mergeVisits — varias aperturas del mismo cliente el mismo día', () => {
  const v = (o: Record<string, unknown>) => ({
    user_id: 'u', customer_id: 'c1', visited_at: 'x', ended_at: null, had_order: false, had_ticket: false,
    no_sale_reason: null, notes: null, latitude: null, longitude: null, ...o,
  });
  it('llegada = la primera; pedido si cualquiera lo tuvo; una visita cerrada no se reabre', () => {
    const m = mergeVisits([
      v({ visited_at: 'T1', ended_at: 'T2', had_order: true }),
      v({ visited_at: 'T3', ended_at: null }),
    ], { latitude: null, longitude: null })!;
    expect(m.visited_at).toBe('T1');
    expect(m.had_order).toBe(true);
    expect(m.ended_at).toBe('T2');
    expect(mergeVisits([v({ visited_at: 'T1' })], { latitude: null, longitude: null })!.ended_at).toBeNull();
  });
  it('la distancia sale de la primera apertura con GPS', () => {
    const m = mergeVisits([v({ latitude: null }), v({ latitude: '19.4326', longitude: '-99.1332' })], { latitude: '19.4326', longitude: '-99.1332' })!;
    expect(m.distance_m).toBe(0);
  });
  it('sin visitas = null', () => expect(mergeVisits([], { latitude: null, longitude: null })).toBeNull());
});

describe('utilidades', () => {
  it('haversine: 0.001° de latitud ≈ 111 m', () => {
    expect(Math.round(haversineM(19, -99, 19.001, -99))).toBe(111);
  });
  it('arrivalDistanceM: null si falta cualquier coordenada (no 0)', () => {
    expect(arrivalDistanceM(null, -99, 19, -99)).toBeNull();
    expect(arrivalDistanceM('19', '-99', null, null)).toBeNull();
    expect(arrivalDistanceM('19', '-99', '19.001', '-99')).toBe(111);
  });
  it('parseYmd rechaza fechas imposibles y formatos raros', () => {
    expect(parseYmd('2026-10-21')).toBe('2026-10-21');
    expect(parseYmd('2026-02-30')).toBeNull();
    expect(parseYmd('21/10/2026')).toBeNull();
    expect(parseYmd(undefined)).toBeNull();
  });
  it('isoDow: lunes 1 … domingo 7', () => {
    expect(isoDow('2026-10-19')).toBe(1);
    expect(isoDow('2026-10-25')).toBe(7);
  });
});
