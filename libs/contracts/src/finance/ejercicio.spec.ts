import {
  ETAPAS_VISIBLES, ETIQUETA_ETAPA, EXPLICACION_ETAPA,
  NO_CONSTA_EN_KEPLER, constanciaDeAutorizacion, documentoKepler, etapaDeEjercicio, seDebeAvisar, type EstadoEjercicio, type EtapaEjercicio,
  ETIQUETA_CIERRE, ETIQUETA_ESPERA_KEPLER, cicloCerrado, esHallazgoCanceladaConGasto, esperaDeKepler, motivoDeCierre,
  ETIQUETA_FALTA_EN_KEPLER, faltaEnKepler, importeDelVale, solicitudCanceladaEnKepler,
  lecturaDeLaCancelada, faltaEnLaNotaDeRevision, type PistaCancelada,
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

  /**
   * `[GX.93]` ⛔ El caso que el parrafo describe y que nadie probaba: cancelada **con** gasto
   * generado. Salia «ejercido» porque `aplicada` se preguntaba primero (24 vales en prod).
   */
  it('cancelada CON gasto generado sigue siendo cancelada, no ejercida', () => {
    expect(etapaDeEjercicio({ status: 'validada', kepler_aplicada: true, kepler_estado: 'C' })).toBe('cancelado_kepler');
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

/**
 * `[GX.48]` — **La constancia de autorizacion.**
 *
 * ⛔ Kepler NO guarda ningun documento al autorizar: se midio de cinco formas y lo unico que
 * cambia es `c43`, de `N` a `A`. Asi que la constancia se **genera** con lo que Kepler si
 * tiene, y lo que no tiene se DECLARA. Lo que estas pruebas vigilan es justamente eso: que no
 * afirme nada que la base no respalde.
 */
describe('[GX.48] la constancia de autorizacion de Kepler', () => {
  const datos = () => ({
    folio: '0009008', estado: 'A' as const, importe: 224.4, fecha: '2026-09-04',
    destinatario: 'BBVA MEXICO SA', concepto: 'COMISION', area_autoriza: 'FINANZAS',
  });

  it('reproduce la fila de «Autorizacion de Sol Gasto»', () => {
    const c = constanciaDeAutorizacion(datos());
    expect(c).toBeTruthy();
    expect(c?.documento).toBe('XA1501-0009008');
    expect(c?.autorizado).toBe('A');
    expect(c?.monto).toBe(224.4);
    expect(c?.destinatario).toBe('BBVA MEXICO SA');
    expect(c?.area_autoriza).toBe('FINANZAS');
  });

  /**
   * ⛔ **La prueba que sostiene el bloque.** Kepler no guarda ni la fecha ni la persona de la
   * autorizacion. Una constancia que las omitiera en silencio se leeria como completa.
   */
  it('DECLARA lo que Kepler no registra', () => {
    const c = constanciaDeAutorizacion(datos());
    expect(c?.no_consta).toEqual(NO_CONSTA_EN_KEPLER);
    expect(c?.no_consta.length).toBeGreaterThan(0);
    expect(c?.no_consta.join(' ')).toMatch(/fecha/i);
    expect(c?.no_consta.join(' ')).toMatch(/qui[eé]n/i);
  });

  /**
   * ⚠️ Y el campo de fecha se llama `fecha_documento`, no `fecha_autorizacion`: es la del
   * documento. Ponerle el otro nombre seria bautizar un dato que no existe.
   */
  it('la fecha es la del DOCUMENTO, y el nombre del campo lo dice', () => {
    const c = constanciaDeAutorizacion(datos());
    expect(c?.fecha_documento).toBe('2026-09-04');
    expect(Object.keys(c ?? {})).not.toContain('fecha_autorizacion');
  });

  it('la F se lee como autorizado Y aplicado', () => {
    const c = constanciaDeAutorizacion({ ...datos(), estado: 'F' });
    expect(c?.autorizado).toBe('F');
    expect(c?.autorizado_label).toMatch(/dinero/i);
  });

  /** ⛔ Antes de la `A` no hay nada que constatar. Una constancia vacia diria que si la hubo. */
  it('no existe mientras el vale no este autorizado', () => {
    expect(constanciaDeAutorizacion({ ...datos(), estado: 'N' })).toBeNull();
    expect(constanciaDeAutorizacion({ ...datos(), estado: 'C' })).toBeNull();
    expect(constanciaDeAutorizacion({ ...datos(), estado: null })).toBeNull();
    expect(constanciaDeAutorizacion({ ...datos(), folio: null })).toBeNull();
  });

  /** Los campos que Kepler puede traer vacios llegan `null`, nunca inventados. */
  it('lo que falta va en null, no en un texto de relleno', () => {
    const c = constanciaDeAutorizacion({ folio: '0009008', estado: 'A' });
    expect(c?.destinatario).toBeNull();
    expect(c?.concepto).toBeNull();
    expect(c?.area_autoriza).toBeNull();
    expect(c?.fecha_documento).toBeNull();
    expect(c?.monto).toBe(0);
  });
});

/**
 * `[GX.92]` / `[GX.96]` **¿Cerró el ciclo? y si no, ¿a qué espera?** UNA regla para «Mis gastos» y la cola
 * de quien aprueba. Medido en prod el 2026-11-05: 32 revisados con la solicitud cancelada se quedaban
 * para siempre en «Falta el gasto en Kepler».
 */
describe('[GX.92] el ciclo de un vale revisado', () => {
  it('revisado con su gasto aplicado: cerrado', () => {
    expect(motivoDeCierre({ status: 'validada', etapa: 'ejercido', gasto_folios: ['0000123'] })).toBe('gasto_aplicado');
  });

  /** ⭐ El defecto: esto antes NO cerraba. */
  it('⭐ revisado con la solicitud cancelada en Kepler: cerrado, aunque no haya gasto', () => {
    expect(motivoDeCierre({ status: 'validada', etapa: 'cancelado_kepler', gasto_folios: [] })).toBe('cancelada_en_kepler');
    expect(cicloCerrado({ status: 'validada', etapa: 'cancelado_kepler', gasto_folios: [] })).toBe(true);
  });

  /** ⛔ Sólo el revisado: un aprobado con gasto todavía le debe algo a alguien (`[GX.77]`). */
  it('⛔ un vale que no está revisado nunca cierra, tenga lo que tenga', () => {
    for (const status of ['recibida', 'aprobada', 'revision', 'rechazada']) {
      expect(cicloCerrado({ status, etapa: 'cancelado_kepler', gasto_folios: ['1'] })).toBe(false);
    }
  });

  it('revisado sin gasto y sin cancelar: abierto, y dice a qué espera', () => {
    expect(cicloCerrado({ status: 'validada', etapa: 'autorizado', gasto_folios: [] })).toBe(false);
    expect(esperaDeKepler({ status: 'validada', etapa: 'autorizado', gasto_folios: [] })).toBe('falta_generar_gasto');
    expect(esperaDeKepler({ status: 'validada', etapa: 'por_ejercer', gasto_folios: [] })).toBe('falta_autorizar');
    expect(esperaDeKepler({ status: 'validada', etapa: 'ejercido', gasto_folios: [] })).toBe('aplicada_sin_ligar');
    expect(esperaDeKepler({ status: 'validada', etapa: 'sin_medir', gasto_folios: null })).toBe('sin_medir');
  });

  it('lo cerrado, y lo que no está revisado, no espera a Kepler', () => {
    expect(esperaDeKepler({ status: 'validada', etapa: 'cancelado_kepler', gasto_folios: [] })).toBeNull();
    expect(esperaDeKepler({ status: 'validada', etapa: 'autorizado', gasto_folios: ['9'] })).toBeNull();
    expect(esperaDeKepler({ status: 'recibida', etapa: 'en_captura', gasto_folios: [] })).toBeNull();
  });

  it('cada motivo tiene su texto', () => {
    expect(Object.keys(ETIQUETA_CIERRE).sort()).toEqual(['cancelada_en_kepler', 'gasto_aplicado']);
    expect(Object.keys(ETIQUETA_ESPERA_KEPLER).sort()).toEqual(['aplicada_sin_ligar', 'falta_autorizar', 'falta_generar_gasto', 'sin_medir']);
  });

  /** `[GX.96]` El hallazgo: cancelada DESPUÉS de generar su gasto. Sólo ése. */
  it('hallazgo: cancelada con gasto sí; cancelada sin gasto o viva con gasto, no', () => {
    expect(esHallazgoCanceladaConGasto('C', true)).toBe(true);
    expect(esHallazgoCanceladaConGasto(' C ', true)).toBe(true);
    expect(esHallazgoCanceladaConGasto('C', false)).toBe(false);
    expect(esHallazgoCanceladaConGasto('A', true)).toBe(false);
    expect(esHallazgoCanceladaConGasto(null, null)).toBe(false);
  });
});

/**
 * `[PGP.123]` G.UI.1b — Qué le falta en Kepler a un vale validado sin gasto ligado, con las reglas de la cola. ⛔ Lo que
 * cuida: que una solicitud cancelada no se lea «Falta el gasto en Kepler» (38 vales así en la copia local, 2026-11-16).
 */
describe('[PGP.123] G.UI.1b qué le falta en Kepler', () => {
  const v = (kepler_estado: string | null, kepler_aplicada: boolean | null, status = 'validada') => faltaEnKepler({ status, kepler_estado, kepler_aplicada });

  it('autorizada sin gasto: falta el gasto; sin autorizar: falta que la autoricen', () => {
    expect(v('A', false)).toBe('falta_generar_gasto');
    expect(ETIQUETA_FALTA_EN_KEPLER.falta_generar_gasto).toBe('Falta el gasto en Kepler');
    expect(v('N', false)).toBe('falta_autorizar');
  });

  it('⛔ cancelada: no «espera su gasto»; con el gasto ya generado, la pregunta de GX.96', () => {
    expect(v('C', false)).toBe('cancelada');
    expect(v('C', true)).toBe('cancelada_con_gasto');
    expect(ETIQUETA_FALTA_EN_KEPLER.cancelada).toBe('Solicitud cancelada en Kepler');
    expect(ETIQUETA_FALTA_EN_KEPLER.cancelada_con_gasto).toContain('¿salió dinero?');
  });

  it('aplicada sin el gasto ligado y lo que no se pudo leer, con las palabras de la cola', () => {
    expect(v('F', true)).toBe('aplicada_sin_ligar');
    expect(ETIQUETA_FALTA_EN_KEPLER.aplicada_sin_ligar).toBe(ETIQUETA_ESPERA_KEPLER.aplicada_sin_ligar);
    expect(v(null, null)).toBe('sin_medir');
  });

  it('G.UI.1c: cancelada en Kepler es la C de c43, venga con espacios o no; nada más lo es', () => {
    expect(solicitudCanceladaEnKepler('C')).toBe(true);
    expect(solicitudCanceladaEnKepler(' C ')).toBe(true);
    expect(solicitudCanceladaEnKepler('A')).toBe(false);
    expect(solicitudCanceladaEnKepler(null)).toBe(false);
  });

  it('un vale que no está validado no espera nada de Kepler', () => {
    expect(v('A', false, 'aprobada')).toBeNull();
    expect(v('C', true, 'rechazada')).toBeNull();
  });
});

/** `[PGP.123]` G.UI.2 — El monto de un vale cuya solicitud Kepler canceló: lo capturado, con lo de Kepler como nota. */
describe('[PGP.123] G.UI.2 el monto del vale', () => {
  it('⛔ cancelada: lo capturado, y el 0 de Kepler como nota', () => {
    expect(importeDelVale({ importe: 0, importe_capturado: 3215, kepler_estado: 'C' })).toEqual({ importe: 3215, kepler: 0 });
    expect(importeDelVale({ importe: '0.00', importe_capturado: '712.43', kepler_estado: ' C ' })).toEqual({ importe: 712.43, kepler: 0 });
  });

  it('viva, o sin lo capturado: lo de Kepler, sin nota (no se inventa)', () => {
    expect(importeDelVale({ importe: 518, importe_capturado: 347.59, kepler_estado: 'A' })).toEqual({ importe: 518, kepler: null });
    expect(importeDelVale({ importe: 0, importe_capturado: null, kepler_estado: 'C' })).toEqual({ importe: 0, kepler: null });
    expect(importeDelVale({ importe: 100, importe_capturado: 100, kepler_estado: 'C' })).toEqual({ importe: 100, kepler: null });
  });
});

/**
 * `[PGP.123]` G.UI.1d — La pista de una cancelada: lo que la Suite averigua sola (pagos en Kepler, la forma de pago del
 * vale y la recaptura) para que una persona sólo decida. Cada caso es uno medido en prod el 2026-11-16.
 */
describe('[PGP.123] G.UI.1d la pista de una cancelada', () => {
  const P = (over: Partial<PistaCancelada> = {}): PistaCancelada => ({ forma_pago: 'efectivo', pagos: [], recapturas: [], gasto_vivo: null, ...over });
  const pago = (over = {}) => ({ folio: '0000123', gasto_folio: '0000050', aplicado: 712.43, fecha: '2026-10-12', cancelado: false, ...over });
  const rec = (over = {}) => ({ folio: '0010181', estado: 'N', fecha: '2026-10-07', con_vale: false, ...over });

  it('⛔ Kepler lo pagó: el pago con su folio, monto y fecha, en rojo (salió dinero por un documento cancelado)', () => {
    const l = lecturaDeLaCancelada(P({ forma_pago: 'transferencia', pagos: [pago()] }));
    expect(l.dinero).toBe('Kepler lo pagó: XD2601-0000123 · $712.43 · 12/10/26');
    expect(l.tono).toBe('bad');
  });

  it('⛔ en efectivo salió de caja aunque Kepler no tenga el pago (no se dice «no salió dinero»)', () => {
    const l = lecturaDeLaCancelada(P({ pagos: [pago({ cancelado: true })] }));
    expect(l.dinero).toBe('Pagado en efectivo según el vale: salió de caja, y Kepler no tiene el pago');
  });

  it('sin pago en Kepler: dónde buscarlo según la forma de pago; sin poder leer los pagos, se dice', () => {
    expect(lecturaDeLaCancelada(P({ forma_pago: 'transferencia' })).dinero).toBe('Sin pago en Kepler; el vale dice transferencia: búscala en el banco');
    expect(lecturaDeLaCancelada(P({ forma_pago: 'tarjeta' })).dinero).toBe('Sin pago en Kepler; el vale dice tarjeta: búscalo en su estado de cuenta');
    expect(lecturaDeLaCancelada(P({ forma_pago: 'otro' })).dinero).toBe('Sin pago en Kepler, y el vale no dice cómo se pagó: revísalo');
    expect(lecturaDeLaCancelada(P({ pagos: null })).dinero).toBe('No se pudieron leer los pagos de Kepler');
    expect(lecturaDeLaCancelada(null).tono).toBe('warn');
  });

  it('una sola recaptura libre: se ofrece ligar el vale a ella', () => {
    const l = lecturaDeLaCancelada(P({ recapturas: [rec()] }));
    expect(l.recaptura).toBe('Posible recaptura: XA1501-0010181 (sin autorizar, 07/10/26), mismo acreedor y total');
    expect(l.accion).toEqual({ tipo: 'ligar', folio: '0010181' });
  });

  it('⛔ con su gasto vivo en Kepler no se ofrece ligar (el gasto quedaría dos veces); sin el dato, tampoco', () => {
    const l = lecturaDeLaCancelada(P({ recapturas: [rec()], gasto_vivo: '0000050' }));
    expect(l.recaptura).toBe('Posible recaptura: XA1501-0010181 (sin autorizar, 07/10/26), mismo acreedor y total; pero su gasto sigue vivo en Kepler (X-A-10 0000050): ligarla duplicaría el gasto');
    expect(l.accion).toBeNull();
    expect(l.tono).toBe('warn');
    const { gasto_vivo: _sinDato, ...anterior } = P({ recapturas: [rec()] });
    expect(lecturaDeLaCancelada(anterior).accion).toBeNull();
  });

  it('⛔ varias iguales (un gasto que se repite): no se adivina cuál; ninguna, se dice', () => {
    const l = lecturaDeLaCancelada(P({ recapturas: [rec(), rec({ folio: '0010190' })] }));
    expect(l.recaptura).toBe('2 solicitudes del mismo acreedor y total: no se sabe cuál la reemplaza');
    expect(l.accion).toBeNull();
    expect(lecturaDeLaCancelada(P()).recaptura).toBe('Sin recaptura con el mismo acreedor y total');
    expect(lecturaDeLaCancelada(P({ recapturas: null })).recaptura).toBeNull();
  });

  it('la recaptura ya tiene su vale: éste puede estar repetido (y el rojo del pago manda)', () => {
    const l = lecturaDeLaCancelada(P({ recapturas: [rec({ con_vale: true })] }));
    expect(l.recaptura).toBe('La recaptura XA1501-0010181 ya tiene su vale: éste puede estar repetido');
    expect(l.accion).toEqual({ tipo: 'repetido', folio: '0010181' });
    expect(l.tono).toBe('warn');
    expect(lecturaDeLaCancelada(P({ pagos: [pago()], recapturas: [rec({ con_vale: true })] })).tono).toBe('bad');
  });
});

describe('[PGP.123] G.UI.1e la nota de «Ya lo revisé»', () => {
  it('⛔ cuenta caracteres como la base (char_length), no unidades UTF-16: dos emojis no son una nota', () => {
    expect(faltaEnLaNotaDeRevision('👍👍')).not.toBeNull();
    expect(faltaEnLaNotaDeRevision('👍👍👍')).toBeNull();
    expect(faltaEnLaNotaDeRevision('  ok ')).not.toBeNull();
    expect(faltaEnLaNotaDeRevision('😀'.repeat(500))).toBeNull();
    expect(faltaEnLaNotaDeRevision('😀'.repeat(501))).not.toBeNull();
  });
});
