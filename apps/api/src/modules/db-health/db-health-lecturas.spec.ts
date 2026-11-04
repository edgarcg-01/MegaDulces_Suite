import { esCarrilRetirado, etiquetaBase, filasEstimadas, pctMuertas } from './db-health-lecturas';

/**
 * `[DH.5]` Tres lecturas que el tablero publicaba falsas (medido en prod el 2026-11-04).
 * Cada bloque abre con el caso real que la regla vieja pintaba mal.
 */
describe('[DH.5] etiquetaBase — por el HOST, nunca por el nombre de la base', () => {
  it('⛔ NEGATIVA — prod en md se llama `railway` y NO es Railway', () => {
    // La regla vieja (`/railway/i` sobre la cadena) devolvía «prod (Railway)» para esto.
    expect(etiquetaBase('postgres://pg-prod:5432/railway')).toBe('producción (md)');
    expect(etiquetaBase('postgres://192.168.0.222:5434/railway')).toBe('producción (md)');
  });

  it('Railway de verdad se nombra como la prod vieja', () => {
    expect(etiquetaBase('postgres://roundhouse.proxy.rlwy.net:41234/railway')).toBe('Railway (prod vieja, congelada)');
  });

  it('local es local, y un host que no conoce se dice tal cual (no se inventa «local»)', () => {
    expect(etiquetaBase('postgres://localhost:5432/dev')).toBe('local');
    expect(etiquetaBase('postgres://10.0.0.9:5432/x')).toBe('10.0.0.9');
    expect(etiquetaBase(undefined)).toBe('desconocida');
    expect(etiquetaBase('pg-prod')).toBe('producción (md)');
  });
});

describe('[DH.5] % de filas muertas sobre reltuples', () => {
  it('⛔ NEGATIVA — kdm1: 12,164 en el contador, 751,673 estimadas, 7,132 muertas → 0.9 %, no 58.6 %', () => {
    const filas = filasEstimadas(12164, 751673);
    expect(filas).toBe(751673);
    expect(pctMuertas(7132, filas)).toBe(0.9);
    // Lo que pintaba la regla vieja, para que el control sepa distinguir:
    expect(pctMuertas(7132, 12164)).toBe(58.6);
  });

  it('reltuples = -1 (nunca analizada) cae al contador', () => {
    expect(filasEstimadas(500, -1)).toBe(500);
  });

  it('sin filas no hay porcentaje: null, nunca 0', () => {
    expect(pctMuertas(30, filasEstimadas(0, -1))).toBeNull();
  });
});

describe('[TOR.4] carril retirado', () => {
  it('⛔ NEGATIVA — route_collections: sin declarar y 16 días sin latir → retirado, no crítico eterno', () => {
    expect(esCarrilRetirado(false, 16 * 86400)).toBe(true);
  });
  it('un carril declarado nunca es «retirado», por viejo que sea: eso es una falla', () => {
    expect(esCarrilRetirado(true, 30 * 86400)).toBe(false);
  });
  it('sin declarar pero latiendo esta semana: NO es retirado (sigue corriendo y hay que verlo)', () => {
    expect(esCarrilRetirado(false, 2 * 3600)).toBe(false);
    expect(esCarrilRetirado(false, null)).toBe(false);
  });
});
