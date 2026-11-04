import { commitDelLatido, etiquetaBase, filasEstimadas, mismoCommit, pctMuertas } from './db-health-lecturas';

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

describe('[DH.5] commit del latido de auto-deploy', () => {
  it('lee «desplegado <sha>» y «al día en <sha>»', () => {
    expect(commitDelLatido('desplegado 7db184b1f desde 43b58464c · servicios: api worker')).toBe('7db184b1f');
    expect(commitDelLatido('al día en 7db184b1f')).toBe('7db184b1f');
  });

  it('⛔ un latido sin commit (error, espera) no da commit: no hay contra qué comparar', () => {
    expect(commitDelLatido('fetch falló (llave o red)')).toBeNull();
    expect(commitDelLatido(null)).toBeNull();
  });

  it('mismoCommit tolera largos distintos y rechaza sha cortos o vacíos', () => {
    expect(mismoCommit('7db184b1f', '7db184b1f0a1b2c3')).toBe(true);
    expect(mismoCommit('7db184b1f', 'ece8269aa')).toBe(false);
    expect(mismoCommit('7db', '7db184b1f')).toBe(false);
    expect(mismoCommit('unknown', '7db184b1f')).toBe(false);
  });
});
