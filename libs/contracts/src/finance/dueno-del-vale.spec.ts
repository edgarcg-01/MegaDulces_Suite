import { esDuenoDelVale, MENSAJE_PROPIO_VALE, normalizarPersona } from './dueno-del-vale.contract';

/**
 * `[GX.65.4a]` — Candado de **«nadie aprueba, valida ni rechaza su propio vale»**.
 * Medido en local antes: 5 de 18 decisiones las tomó el dueño del vale.
 */
describe('[GX.65.4a] esDuenoDelVale', () => {
  it('quien levantó el vale es dueño', () => {
    expect(esDuenoDelVale({ created_by: 'david_cisneros' }, { username: 'david_cisneros', full_name: 'David Cisneros' })).toBe(true);
  });

  it('quien subió la evidencia también es dueño (GX.34)', () => {
    expect(esDuenoDelVale({ created_by: 'otra', evidencia_por: 'David Cisneros' }, { username: 'david_cisneros', full_name: 'David Cisneros' })).toBe(true);
  });

  /**
   * ⭐ El hueco que una comparación de un solo texto dejaba abierto: capturó cuando no tenía
   * nombre completo (el vale dice su username) y aprueba ya con nombre cargado.
   */
  it('⭐ capturó con su username y decide con su nombre: igual es dueño', () => {
    expect(esDuenoDelVale({ created_by: 'david_cisneros' }, { username: 'david_cisneros', full_name: 'David Cisneros' })).toBe(true);
    expect(esDuenoDelVale({ created_by: 'David Cisneros' }, { username: 'david_cisneros', full_name: 'David Cisneros' })).toBe(true);
  });

  it('no lo engañan mayúsculas, espacios ni el prefijo link:', () => {
    expect(esDuenoDelVale({ created_by: 'link:  david   CISNEROS ' }, { full_name: 'David Cisneros' })).toBe(true);
  });

  /** ⛔ Prueba NEGATIVA: otra persona SÍ puede decidir. Si esto falla, la regla bloquea de más. */
  it('⛔ otra persona NO es dueña: puede revisar', () => {
    expect(esDuenoDelVale({ created_by: 'david_cisneros', evidencia_por: 'david_cisneros' },
      { username: 'maripaz', full_name: 'María Paz Gutiérrez' })).toBe(false);
  });

  /** ⛔ Un vale sin dueño registrado no convierte en dueño a quien no trae nombre. */
  it('vacíos no hacen dueño a nadie', () => {
    expect(esDuenoDelVale({ created_by: null, evidencia_por: '' }, { username: '', full_name: null })).toBe(false);
    expect(esDuenoDelVale({ created_by: '', evidencia_por: null }, { username: 'maripaz' })).toBe(false);
  });

  it('un nombre que CONTIENE al otro no basta: se compara completo', () => {
    expect(esDuenoDelVale({ created_by: 'David Cisneros Pérez' }, { full_name: 'David Cisneros' })).toBe(false);
  });

  it('normaliza igual de los dos lados', () => {
    expect(normalizarPersona(' link:Ana  Ruiz ')).toBe('ANA RUIZ');
    expect(normalizarPersona(null)).toBe('');
  });

  it('el mensaje dice qué hacer, no sólo que está prohibido', () => {
    expect(MENSAJE_PROPIO_VALE).toContain('otra persona');
  });
});
