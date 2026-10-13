/**
 * `[RH.2.4]` El catálogo de hojas de competencias (copia del de Mega Talento): que esté completo y que el empate por
 * nombre de puesto funcione como allá («Cajero(a)» ≈ «CAJERA», «Aux de chofer» ≈ «AUXILIAR DE CHOFER»).
 */
import { CATALOGO_COMPETENCIAS, HOJAS_COMPETENCIAS, hojaPorKey, hojaPorNombrePuesto } from './competencias-puesto';

describe('[RH.2.4] hojas de competencias', () => {
  it('cada hoja tiene competencias completas, con claves únicas y las 3 anclas', () => {
    expect(HOJAS_COMPETENCIAS.length).toBeGreaterThan(0);
    for (const h of Object.values(CATALOGO_COMPETENCIAS)) {
      expect(h.competencias.length).toBeGreaterThan(0);
      expect(new Set(h.competencias.map((c) => c.key)).size).toBe(h.competencias.length);
      for (const c of h.competencias) expect([c.preguntaStar, c.anclas.inferior, c.anclas.cumple, c.anclas.supera].every((t) => !!t?.trim())).toBe(true);
    }
  });

  it('por clave (la que RH asigna a la vacante) y por nombre del puesto', () => {
    expect(hojaPorKey('vendedor-a-detalle')?.nombre).toBe('VENDEDOR A DETALLE');
    expect(hojaPorKey(undefined)).toBeUndefined();
    expect(hojaPorNombrePuesto('Vendedor a detalle')?.key).toBe('vendedor-a-detalle');
    expect(hojaPorNombrePuesto('Cajero(a)')?.nombre).toBe('CAJERA');
    expect(hojaPorNombrePuesto('Aux de chofer')?.nombre).toBe('AUXILIAR DE CHOFER');
    expect(hojaPorNombrePuesto('Astronauta')).toBeUndefined();
    expect(hojaPorNombrePuesto('')).toBeUndefined();
  });
});
