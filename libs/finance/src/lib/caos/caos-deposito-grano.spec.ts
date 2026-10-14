import { atribuirDeposito, esVecinal } from './caos-deposito-grano';

/**
 * `[CG.58.6]` El candado del grano de atribución.
 *
 * Los textos son los `ref` REALES de `analytics.caos_cash_movements` (749 depósitos, may→oct
 * 2026), con sus erratas. Un clasificador de prosa probado con prosa limpia no prueba nada.
 */
describe('atribuirDeposito — el grano que el texto aguanta, ni uno más fino', () => {
  const CAP = '2026-10-13';

  describe('ruta_dia: el texto declara las dos mitades', () => {
    const casos: [string, string, string][] = [
      ['rd 28 13 10 26', '28', '2026-10-13'],
      ['ruta 21 13 10 26', '21', '2026-10-13'],
      ['r23 12 10 26', '23', '2026-10-12'],
      ['ruta22131026', '22', '2026-10-13'],
      ['rd21 09/10', '21', '2026-10-09'],
    ];
    it.each(casos)('%s', (ref, ruta, fecha) => {
      expect(atribuirDeposito(ref, CAP)).toMatchObject({ grano: 'ruta_dia', ruta, fecha });
    });
  });

  /**
   * ⭐ El caso que justifica el grano intermedio. Son 26 depósitos / $414,110 de la ruta 28, y
   * sin ellos la 28 aparece depositando el **67.4%** de lo que vende mientras sus hermanas van
   * entre 105% y 112%. Sumándolos cierra en **99.5%** — pero **sin fecha**, porque el texto no
   * la dice y cazarla por monto se midió y no funciona (35% de acierto, 28 errores a $200).
   */
  describe('ruta: declara la ruta y NO el día', () => {
    /**
     * ⛔ `ruta 28 ph` nombra la ruta Y su plaza, y no trae fecha. Mi primera regla exigía que el
     * texto TERMINARA en el número y lo mandaba a `sin_declarar` — perdía una ruta perfectamente
     * declarada por culpa de dos letras. Lo que se prohíbe después del número son **dígitos**.
     */
    it.each(['rd28', 'rd 26', 'RD 23', 'ruta 27', 'ruta 28 ph'])('%s', (ref) => {
      const r = atribuirDeposito(ref, CAP);
      expect(r.grano).toBe('ruta');
      expect(r.fecha).toBeNull();
      expect(r.ruta).not.toBeNull();
    });

    /**
     * ⚠️ Si el texto trae dígitos sueltos MÁS ALLÁ del número de ruta, intentó declarar una
     * fecha y algo no se leyó. Bajar a `ruta` escondería que hay algo sin entender, así que va a
     * `sin_declarar` CON su motivo — que es lo que después manda a alguien a mirarlo.
     */
    it('⛔ un texto con dígitos que no se entendieron NO baja a `ruta`: se declara', () => {
      expect(atribuirDeposito('rd 26 99 99 99', CAP).grano).toBe('sin_declarar');
    });
  });

  /**
   * ⭐⭐ Canindo cierra al **95.2%** ($3,864,610 depositados contra $4,059,584 vendidos) **sin
   * saber cuál de las 501–505**. Elegir una sería inventar, y una ruta inventada le cobra el
   * depósito a un camión que no fue.
   */
  describe('plaza: nombra la plaza y no la ruta', () => {
    const casos: [string, string][] = [
      ['rd can 26/05', 'canindo'],
      ['rd canindo', 'canindo'],
      ['rd canindo 1/06', 'canindo'],
      ['rd mor 26/05', 'morelia'],
      ['rd morelia', 'morelia'],
      ['rd mor 29 /05', 'morelia'],
    ];
    it.each(casos)('%s', (ref, plaza) => {
      expect(atribuirDeposito(ref, CAP)).toMatchObject({ grano: 'plaza', plaza, ruta: null, fecha: null });
    });

    /**
     * ⛔⛔ La aserción que impide el error más caro de toda esta fase: en `rd mor 29 /05` el
     * **29 es el día**, no la ruta 29. Si alguien "mejora" el clasificador haciéndolo leer ese
     * número como ruta, el depósito de Morelia se le cobra a un camión de Padre Hidalgo.
     */
    it('⛔ en `rd mor 29 /05` el 29 es el DÍA: no existe la ruta 29 acá', () => {
      expect(atribuirDeposito('rd mor 29 /05', CAP).ruta).toBeNull();
    });
  });

  describe('sin_declarar: y el motivo dice por qué', () => {
    const casos: [string, string][] = [
      ['deposito caja general', 'no declara'],
      ['cj 15 26/05', 'no declara'],
      ['', 'no trae referencia'],
    ];
    it.each(casos)('%s', (ref, trozo) => {
      const r = atribuirDeposito(ref, CAP);
      expect(r.grano).toBe('sin_declarar');
      expect(r.motivo).toContain(trozo);
    });

    /** La vecinal es otro circuito: se excluye y se dice, no se deja caer en el cajón de «otro». */
    it.each(['RV MORELIA RV15-321-15-321', 'rv 01/07', 'ruta vecinal 03/06'])('vecinal: %s', (ref) => {
      const r = atribuirDeposito(ref, CAP);
      expect(r.grano).toBe('sin_declarar');
      expect(r.motivo).toContain('vecinal');
    });
  });

  /** Nunca devuelve una fecha fuera del grano que la admite. Es la invariante de la tabla. */
  it('⭐ la fecha SÓLO existe en `ruta_dia`, y la plaza SÓLO en `plaza`', () => {
    for (const ref of ['rd 28 13 10 26', 'rd28', 'rd can 26/05', 'deposito caja general', 'rv 01/07']) {
      const r = atribuirDeposito(ref, '2026-10-13');
      if (r.grano !== 'ruta_dia') expect(r.fecha).toBeNull();
      if (r.grano !== 'plaza') expect(r.plaza).toBeNull();
      if (r.grano === 'plaza') expect(r.ruta).toBeNull();
    }
  });
});

/**
 * [CG.58.7] El predicado que separa las DOS ausencias. Sin el, quien consume la atribucion
 * tiene que leer la prosa de motivo para saber si el deposito es vecinal o simplemente mudo,
 * y entonces un cambio de redaccion le rompe la cuenta sin que nada se ponga rojo.
 */
describe('esVecinal — vecinal y mudo NO son la misma ausencia', () => {
  it.each(['RV MORELIA RV15-321-15-321', 'rv 01/07', 'ruta vecinal 03/06', 'RV24416\RV321-16531', 'R V 15 06-10-2026'])(
    'reconoce la vecinal: %s', (ref) => { expect(esVecinal(ref)).toBe(true); });

  /** Prueba negativa: las rutas directas y el texto mudo NO son vecinal. */
  it.each(['rd 28 13 10 26', 'rd28', 'rd can 26/05', 'ruta 21 13 10 26', 'deposito caja general', '', null, undefined])(
    'NO la confunde con: %s', (ref) => { expect(esVecinal(ref)).toBe(false); });

  /** El predicado y el clasificador NO pueden discrepar: salen de la misma expresion. */
  it('⭐ coincide con el motivo que publica atribuirDeposito', () => {
    for (const ref of ['RV MORELIA RV15-321-15-321', 'rd28', 'deposito caja general', 'rv 01/07']) {
      const r = atribuirDeposito(ref, '2026-10-13');
      expect(esVecinal(ref)).toBe(r.motivo.includes('vecinal'));
    }
  });
});
