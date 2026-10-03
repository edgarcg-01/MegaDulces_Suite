import {
  ORDEN_ETAPA_PROTOCOLO, protocoloCompleto, protocoloDelVale,
  type EstadoProtocolo, type EtapaProtocolo,
} from './protocolo-gasto.contract';

/**
 * `[GX.59]` La regla del protocolo. Se prueba acá —y no en la pantalla— porque la leen los
 * dos lados: la tabla del Expediente la usa para el chip y el servidor para contar.
 *
 * Cada caso arranca de un vale COMPLETO y le quita una cosa. Al revés (armar el mínimo que
 * falla) la prueba se pone verde sin distinguir si la regla exige de más.
 */
const completo = (): EstadoProtocolo => ({
  status: 'validada',
  provisional: false,
  archivos: [{ role: 'comprobante_1' }],
  comprobacion_kepler: true,
});

const ids = (e: EstadoProtocolo) => protocoloDelVale(e).faltan.map((f) => f.id);

describe('[GX.59] el protocolo del vale', () => {
  it('con todo puesto, cierra', () => {
    expect(protocoloDelVale(completo()).etapa).toBe('completo');
    expect(protocoloDelVale(completo()).faltan).toEqual([]);
    expect(protocoloCompleto(completo())).toBe(true);
  });

  /**
   * ⭐ **La prueba que sostiene el pedido.** La comprobación de Kepler es forzosa: un vale
   * aprobado, con su ticket subido y sin comprobación **no cerró el protocolo**. Hasta hoy
   * ese vale se veía idéntico a uno cerrado.
   */
  it('sin la comprobación de Kepler NO cierra, aunque todo lo demás esté', () => {
    const v = { ...completo(), comprobacion_kepler: false };
    expect(protocoloDelVale(v).etapa).toBe('incompleto');
    expect(ids(v)).toEqual(['comprobacion_kepler']);
    expect(protocoloCompleto(v)).toBe(false);
  });

  /**
   * ⭐ **Lo que no se midió NO es lo que falta.** Un endpoint que no hace el join devuelve
   * `null`; pintarlo como «falta» acusaría a todos de no comprobar por una consulta que nadie
   * escribió. Es la regla de ADR-056, y acá es la diferencia entre un tablero útil y una
   * pantalla que miente.
   */
  it('⛔ sin medir la comprobación, el veredicto se declara — no acusa', () => {
    for (const sin of [null, undefined]) {
      const v = { ...completo(), comprobacion_kepler: sin } as EstadoProtocolo;
      const r = protocoloDelVale(v);
      expect(r.etapa).toBe('sin_medir');
      expect(r.medido).toBe(false);
      // ⛔ Y NO aparece como si le faltara la comprobación.
      expect(r.faltan.map((f) => f.id)).not.toContain('comprobacion_kepler');
      expect(protocoloCompleto(v)).toBe(false);
    }
  });

  it('medido en false SÍ es una acusación, y se distingue del sin medir', () => {
    const v = { ...completo(), comprobacion_kepler: false };
    expect(protocoloDelVale(v).medido).toBe(true);
  });

  describe('la factura del gasto', () => {
    /** Sólo se le pide al que quedó debiendo: al resto sería inventarle una deuda. */
    it('al vale provisional sin comprobante se le pide', () => {
      const v = { ...completo(), provisional: true, archivos: [{ role: 'cotizacion' }] };
      expect(ids(v)).toEqual(['factura_del_gasto']);
      expect(protocoloDelVale(v).etapa).toBe('incompleto');
    });

    it('al provisional que YA la subió, no', () => {
      const v = { ...completo(), provisional: true, archivos: [{ role: 'cotizacion' }, { role: 'comprobante_1' }] };
      expect(protocoloDelVale(v).etapa).toBe('completo');
    });

    /** ⛔ El que nunca fue provisional no debe nada, aunque sólo traiga la cotización. */
    it('al que no es provisional no se le inventa una deuda', () => {
      const v = { ...completo(), provisional: false, archivos: [{ role: 'cotizacion' }] };
      expect(ids(v)).toEqual([]);
    });
  });

  describe('la firma', () => {
    it('el que espera firma es «en captura», no «incompleto»', () => {
      const v = { ...completo(), status: 'recibida' };
      expect(protocoloDelVale(v).etapa).toBe('en_captura');
      expect(ids(v)).toEqual(['firma']);
    });

    /**
     * ⚠️ **Lo que un `switch` habría escondido.** A este vale le faltan DOS cosas; una regla
     * que elige una sola mostraría la firma, y al firmarlo volvería a salir rojo sin que nadie
     * entienda por qué.
     */
    it('⭐ cuando faltan varias, salen TODAS', () => {
      const v: EstadoProtocolo = {
        status: 'recibida', provisional: true, archivos: [{ role: 'cotizacion' }],
        comprobacion_kepler: false,
      };
      expect(ids(v)).toEqual(['firma', 'comprobacion_kepler', 'factura_del_gasto']);
      // ⛔ Pero el TITULAR sigue siendo «en captura»: ver la prueba de abajo.
      expect(protocoloDelVale(v).etapa).toBe('en_captura');
    });

    /**
     * ⛔⛔ **El bug que destapó el seed, no una prueba.** La regla decía «en captura» sólo si
     * la firma era lo ÚNICO que faltaba — y como ningún vale sin firmar puede tener su
     * comprobación de Kepler (es de un gasto ya ejercido), **de 78 vales esperando firma sólo
     * 1 salía «en captura»**: los otros 77 se mostraban como «protocolo incompleto».
     *
     * Es acusar a alguien de no hacer algo que todavía no puede hacer, y borra la distinción
     * que esta pantalla existe para mostrar: el que no hizo nada contra el que hizo todo menos
     * el último papel.
     */
    it('⭐⭐ sin firma la etapa es «en captura», aunque falten las otras dos', () => {
      const v: EstadoProtocolo = {
        status: 'recibida', provisional: true, archivos: [{ role: 'cotizacion' }],
        comprobacion_kepler: false,
      };
      expect(protocoloDelVale(v).etapa).toBe('en_captura');
      // Y la lista NO se recorta: el titular cambia, la información no se pierde.
      expect(protocoloDelVale(v).faltan.length).toBe(3);
    });

    /** ⛔ La prueba negativa: firmado, lo que falte ya SÍ es «incompleto». */
    it('firmado, lo que falte sí asciende a «incompleto»', () => {
      const v: EstadoProtocolo = {
        status: 'validada', provisional: true, archivos: [{ role: 'cotizacion' }],
        comprobacion_kepler: false,
      };
      expect(protocoloDelVale(v).etapa).toBe('incompleto');
      expect(ids(v)).toEqual(['comprobacion_kepler', 'factura_del_gasto']);
    });

    it('los tres estados firmados valen igual para la firma', () => {
      for (const s of ['aprobada', 'revision', 'validada']) {
        expect(ids({ ...completo(), status: s }), s).toEqual([]);
      }
    });
  });

  describe('el rechazo', () => {
    /** Un «no» no es una falta: nadie tiene que ir a buscar el papel que falta. */
    it('el rechazado no acumula faltantes', () => {
      const v = { status: 'rechazada', provisional: true, archivos: [], comprobacion_kepler: false };
      const r = protocoloDelVale(v);
      expect(r.etapa).toBe('rechazado');
      expect(r.faltan).toEqual([]);
      expect(r.medido).toBe(true);
    });

    /** ⛔ Y gana incluso sin haber medido: no hay nada que medirle. */
    it('el rechazado no cae en «sin medir»', () => {
      expect(protocoloDelVale({ status: 'rechazada' }).etapa).toBe('rechazado');
    });
  });

  describe('la forma del veredicto', () => {
    it('cada faltante trae chip corto y detalle largo', () => {
      const v: EstadoProtocolo = {
        status: 'recibida', provisional: true, archivos: [], comprobacion_kepler: false,
      };
      for (const f of protocoloDelVale(v).faltan) {
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.detalle.length).toBeGreaterThan(f.label.length);
      }
    });

    /**
     * El orden de la tabla: arriba lo que alguien debe atender. `completo` último y
     * `sin_medir` primero — lo que nadie pudo juzgar es lo que hay que destrabar, no lo
     * último que se descubre scrolleando.
     */
    it('el orden pone «completo» al final y «sin medir» al principio', () => {
      expect(ORDEN_ETAPA_PROTOCOLO[0]).toBe('sin_medir');
      expect(ORDEN_ETAPA_PROTOCOLO[ORDEN_ETAPA_PROTOCOLO.length - 1]).toBe('completo');
      const todas: EtapaProtocolo[] = ['en_captura', 'rechazado', 'incompleto', 'completo', 'sin_medir'];
      expect([...ORDEN_ETAPA_PROTOCOLO].sort()).toEqual([...todas].sort());
    });
  });

  /**
   * ⛔ **El retrato del día 1, como prueba.** `finance.expense_comprobaciones` tiene 0 filas:
   * el módulo GX.8 existe y nunca se usó. Con la comprobación forzosa, un vale que hoy se ve
   * cerrado («validada», con su ticket) sale **incompleto**. Está bien que así sea — es el
   * estado real del trámite — pero que no sorprenda a nadie después.
   */
  it('un vale «validada» de hoy, sin comprobación, sale incompleto', () => {
    const comoEstanHoy: EstadoProtocolo = {
      status: 'validada', provisional: false,
      archivos: [{ role: 'comprobante_1' }], comprobacion_kepler: false,
    };
    expect(protocoloDelVale(comoEstanHoy).etapa).toBe('incompleto');
    expect(ids(comoEstanHoy)).toEqual(['comprobacion_kepler']);
  });
});
