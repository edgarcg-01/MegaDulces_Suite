import { compararConGps, minutosEntre, TOLERANCIA_MINUTOS } from './revision-gps.contract';

/**
 * `[EMB.21]` Lo capturado contra el GPS. La diferencia que importa es la que mueve dinero: cruzar
 * las 7:00 cambia el desayuno aunque la hora se mueva unos minutos.
 */

const TARIFAS = { cafe: 50, desayuno: 100, comida: 100, cena: 100 };
const SOLO_CHOFER = { driver: true, helper1: false, helper2: false };
const cap = (over = {}) => ({ salida: '08:00', llegada: '17:30', duerme_fuera: false, km: 100, viaticos: 100, ...over });
const gps = (over = {}) => ({ salida: '08:20', llegada: '17:40', duerme_fuera: false, km: 110, km_metodo: 'odometro' as const, puntos: 300, ...over });

describe('minutosEntre', () => {
  it('mide por el lado corto del reloj', () => {
    expect(minutosEntre('08:00', '09:30')).toBe(90);
    expect(minutosEntre('23:30', '00:30')).toBe(60);
    expect(minutosEntre(null, '08:00')).toBeNull();
  });
});

describe('compararConGps', () => {
  it('dentro de las tolerancias y sin cambio de viáticos, coincide', () => {
    const r = compararConGps(cap(), gps(), TARIFAS, SOLO_CHOFER);
    expect(r).toEqual({ estado: 'coincide', diferencias: [], viaticos_gps: 100 });
  });

  it('cruzar las 7:00 cambia el desayuno: difiere aunque sean pocos minutos', () => {
    const r = compararConGps(cap({ salida: '06:50' }), gps({ salida: '07:05' }), TARIFAS, SOLO_CHOFER);
    expect(r.estado).toBe('difiere');
    expect(r.diferencias).toEqual(['Viáticos: con el horario del GPS serían $100.00 en vez de $200.00 (cambia desayuno).']);
    expect(r.viaticos_gps).toBe(100);
  });

  it('una hora que se separa más de la tolerancia se dice con la diferencia', () => {
    const r = compararConGps(cap({ salida: '08:00' }), gps({ salida: '09:30' }), TARIFAS, SOLO_CHOFER);
    expect(r.diferencias[0]).toBe('Salida: se capturó 08:00 y el GPS marca 09:30 (1 h 30 min de diferencia).');
    expect(minutosEntre('08:00', '09:30')).toBeGreaterThan(TOLERANCIA_MINUTOS);
  });

  it('kilómetros fuera del 20% difieren; dentro, no', () => {
    expect(compararConGps(cap({ km: 100 }), gps({ km: 115 }), TARIFAS, SOLO_CHOFER).estado).toBe('coincide');
    expect(compararConGps(cap({ km: 100 }), gps({ km: 140 }), TARIFAS, SOLO_CHOFER).diferencias)
      .toContain('Kilómetros: se capturaron 100 y el GPS marca 140.');
  });

  it('sin kilómetros capturados no se inventa una diferencia', () => {
    expect(compararConGps(cap({ km: null }), gps({ km: 300 }), TARIFAS, SOLO_CHOFER).estado).toBe('coincide');
  });

  it('regresar otro día contra «no durmió fuera» difiere, y cuenta la cena', () => {
    const r = compararConGps(cap(), gps({ llegada: '07:10', duerme_fuera: true }), TARIFAS, SOLO_CHOFER);
    expect(r.estado).toBe('difiere');
    expect(r.diferencias).toContain('Según el GPS la unidad regresó otro día, y la guía dice que no durmió fuera.');
    expect(r.diferencias.some((d) => d.startsWith('Viáticos:') && d.includes('cena'))).toBe(true);
  });
});
