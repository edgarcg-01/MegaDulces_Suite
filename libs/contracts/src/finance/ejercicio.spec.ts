import {
  ETAPAS_VISIBLES, ETIQUETA_ETAPA, EXPLICACION_ETAPA,
  documentoKepler, etapaDeEjercicio, seDebeAvisar, type EstadoEjercicio, type EtapaEjercicio,
} from './ejercicio.contract';

/**
 * `[GX.39]` La regla que decide si un gasto esta «por ejercer» o «ejercido». Se prueba aca
 * —y no en el servicio— porque es la MISMA funcion que lee el chip del frontend: si se
 * rompe, se rompen los dos lados a la vez y una sola prueba lo ve. Mismo criterio que
 * `aporte-solicitante.spec.ts`.
 */

/** Firmado por nosotros y aplicado por Kepler: el final feliz. De aca se le quita una cosa. */
const ejercido = (): EstadoEjercicio => ({
  status: 'validada', kepler_aplicada: true, kepler_estado: 'F',
});

describe('[GX.39] la etapa de ejercicio', () => {
  it('firmado y aplicado en Kepler => ejercido', () => {
    expect(etapaDeEjercicio(ejercido())).toBe('ejercido');
  });

  /** Firmamos, y queda esperando a que Kepler lo autorice. */
  it('firmado pero Kepler todavia no lo autoriza => por autorizar', () => {
    expect(etapaDeEjercicio({ ...ejercido(), kepler_aplicada: false, kepler_estado: 'N' })).toBe('por_ejercer');
  });

  /**
   * `[GX.43]` **La `A` de «Autorizacion de Sol Gasto» es su propia etapa.**
   *
   * Aca esta prueba decia que `A` era `por_ejercer`, igual que `N`. Se cambio por pedido del
   * usuario, y la medicion le da la razon: en prod hay **929 solicitudes en `A`**, de las
   * cuales 645 ya tienen su gasto y **284 no**. Colapsar `N` y `A` escondia a esas 284 — la
   * persona no podia distinguir «nadie lo miro» de «ya lo autorizaron, falta el dinero».
   */
  it('la A de Kepler es «autorizado», NO «por autorizar»', () => {
    expect(etapaDeEjercicio({ ...ejercido(), kepler_aplicada: false, kepler_estado: 'A' })).toBe('autorizado');
  });

  it('⛔ y «autorizado» NO es «ejercido»: la A no dice que el dinero salio', () => {
    expect(etapaDeEjercicio({ ...ejercido(), kepler_aplicada: false, kepler_estado: 'A' })).not.toBe('ejercido');
  });

  /** Pero si el puente YA ve el gasto, eso manda sobre la A: el dinero salio. */
  it('con el gasto ya creado, la A pasa a ejercido', () => {
    expect(etapaDeEjercicio({ ...ejercido(), kepler_aplicada: true, kepler_estado: 'A' })).toBe('ejercido');
  });

  /**
   * ⛔ **El caso que sostiene toda la fase.** Sin folio en la vista NO se puede decir «por
   * ejercer»: eso afirma que Kepler no lo aplico, y lo unico cierto es que no lo sabemos.
   * Un booleano no puede decir «no se» — por eso `kepler_aplicada` viaja como `boolean|null`.
   */
  it('sin dato de Kepler NO dice «por ejercer»: dice que no se midio', () => {
    expect(etapaDeEjercicio({ status: 'validada', kepler_aplicada: null, kepler_estado: null })).toBe('sin_medir');
    expect(etapaDeEjercicio({ status: 'validada' })).toBe('sin_medir');
  });

  it('«no medido» y «medido en false» son etapas DISTINTAS', () => {
    const noMedido = etapaDeEjercicio({ status: 'validada', kepler_aplicada: null, kepler_estado: null });
    const medidoNo = etapaDeEjercicio({ status: 'validada', kepler_aplicada: false, kepler_estado: 'N' });
    expect(noMedido).not.toBe(medidoNo);
  });

  /**
   * `c43='F'` acierta 7,949 de 7,949 en prod. Si el puente todavia no ve el gasto pero el
   * documento ya dice «aplicada», el dinero salio igual.
   */
  it('el estado F alcanza aunque el puente no vea el gasto', () => {
    expect(etapaDeEjercicio({ status: 'validada', kepler_aplicada: false, kepler_estado: 'F' })).toBe('ejercido');
  });

  /** Medido: 113 solicitudes canceladas TIENEN gasto. Manda la cancelacion. */
  it('cancelada en Kepler manda sobre el puente', () => {
    expect(etapaDeEjercicio({ status: 'validada', kepler_aplicada: false, kepler_estado: 'C' })).toBe('cancelado_kepler');
  });

  describe('nuestro tramite abierto no es asunto de Kepler', () => {
    /**
     * ⚠️ `aprobada` es «el aprobador firmo pero FALTA la evidencia». Decir «por ejercer» ahi
     * manda a esperar a Kepler por algo que todavia depende de nosotros.
     */
    it.each(['recibida', 'aprobada', 'revision'])('%s => en captura', (status) => {
      expect(etapaDeEjercicio({ ...ejercido(), status })).toBe('en_captura');
    });

    /** Y no se cuela por el lado de Kepler: aunque diga aplicada, nuestro tramite manda. */
    it('ni siquiera con Kepler diciendo que ya aplico', () => {
      expect(etapaDeEjercicio({ status: 'aprobada', kepler_aplicada: true, kepler_estado: 'F' })).toBe('en_captura');
    });
  });

  it('lo que devolvimos es devuelto, diga lo que diga Kepler', () => {
    expect(etapaDeEjercicio({ status: 'rechazada', kepler_aplicada: true, kepler_estado: 'F' })).toBe('rechazada');
  });

  it('un status desconocido cae en «en tramite», no en una etapa que afirme algo', () => {
    expect(etapaDeEjercicio({ ...ejercido(), status: 'lo-que-sea' })).toBe('en_captura');
  });
});

describe('[GX.39] los textos', () => {
  const TODAS: EtapaEjercicio[] = ['en_captura', 'por_ejercer', 'autorizado', 'ejercido', 'cancelado_kepler', 'rechazada', 'sin_medir'];

  it('cada etapa tiene chip corto y explicacion larga', () => {
    for (const e of TODAS) {
      expect(ETIQUETA_ETAPA[e]).toBeTruthy();
      expect(EXPLICACION_ETAPA[e].length).toBeGreaterThan(ETIQUETA_ETAPA[e].length);
    }
  });

  /** ⭐ La frase que el usuario pidio textual: «su gasto se aprobo y se ejercio». */
  it('el ejercido le dice a la persona que el dinero salio', () => {
    expect(EXPLICACION_ETAPA['ejercido']).toContain('ejerci');
    expect(EXPLICACION_ETAPA['ejercido']).toContain('dinero');
  });

  /** ⛔ «Sin medir» no puede sonar a que esta bien ni a que esta mal: tiene que sonar a que no se sabe. */
  it('«sin medir» declara la ignorancia, no la disfraza', () => {
    expect(EXPLICACION_ETAPA['sin_medir']).toMatch(/no podemos ver|no se/i);
    expect(EXPLICACION_ETAPA['sin_medir']).not.toContain('esperando');
  });

  it('las secciones visibles siguen la progresion real de Kepler: N -> A -> F', () => {
    expect(ETAPAS_VISIBLES).toEqual(['en_captura', 'por_ejercer', 'autorizado', 'ejercido']);
  });
});

describe('[GX.39] el aviso se manda UNA vez', () => {
  it('avisa cuando se ejercio y nadie aviso todavia', () => {
    expect(seDebeAvisar('ejercido', false)).toBe(true);
  });

  /** Sin el sello, cada pasada del detector volveria a avisar lo mismo. */
  it('no repite si ya se aviso', () => {
    expect(seDebeAvisar('ejercido', true)).toBe(false);
  });

  it('no avisa de lo que todavia no termino', () => {
    for (const e of ['en_captura', 'por_ejercer', 'autorizado', 'sin_medir', 'rechazada', 'cancelado_kepler'] as EtapaEjercicio[]) {
      expect(seDebeAvisar(e, false)).toBe(false);
    }
  });
});

describe('[GX.43] el documento con el que Kepler respalda la autorizacion', () => {
  /** Es lo que muestra la columna `Documento` de «Autorizacion de Sol Gasto». */
  it('reproduce lo que muestra la pantalla de Kepler', () => {
    expect(documentoKepler('0009008', 'A')).toBe('XA1501-0009008');
    expect(documentoKepler('0008885', 'F')).toBe('XA1501-0008885');
  });

  /**
   * Antes de la `A` no hay documento que mostrar: el papel existe en Kepler desde que se
   * levanta, pero no respalda ninguna autorizacion. Ponerlo en el expediente diria que hay
   * un permiso que nadie dio.
   */
  it('no lo da antes de que lo autoricen', () => {
    expect(documentoKepler('0009008', 'N')).toBeNull();
    expect(documentoKepler('0009008', 'C')).toBeNull();
    expect(documentoKepler('0009008', null)).toBeNull();
    expect(documentoKepler('0009008', undefined)).toBeNull();
  });

  it('sin folio no inventa un documento', () => {
    expect(documentoKepler('', 'A')).toBeNull();
    expect(documentoKepler(null, 'A')).toBeNull();
    expect(documentoKepler('   ', 'A')).toBeNull();
  });
});
