import {
  diaValido, etapaDe, hoyMx, particionarDelDia, visibleEn, PESTANAS,
  type EtapaGasto, type ExpedienteDelDia,
} from './etapas-del-dia';

/**
 * `[GX.20]` Esta partición decide **qué trabajo se ve y cuál no**. Un expediente que cae en
 * la bandeja equivocada no es un detalle visual: es dinero esperando sin que nadie sepa que
 * espera. Y si la suma de las pestañas no da el total del día, quien mira deja de creerle a
 * la pantalla.
 */

const E = (over: Partial<ExpedienteDelDia> = {}): ExpedienteDelDia => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  status: 'recibida',
  importe: 100,
  ...over,
});

describe('[GX.20] en qué bandeja cae cada estado', () => {
  it('reparte los cinco estados del ciclo', () => {
    expect(etapaDe('recibida')).toBe('aprobar');
    expect(etapaDe('aprobada')).toBe('ejercer');
    expect(etapaDe('validada')).toBe('cerrado');
    expect(etapaDe('rechazada')).toBe('cerrado');
  });

  /**
   * ⭐ `revision` es el expediente que volvió con evidencia y NO cuadró. Sigue abierto y lo
   * resuelve la misma persona que firma. En «Cerrado» desaparecería de su vista.
   */
  it('revision queda en EJERCER, no en cerrado', () => {
    expect(etapaDe('revision')).toBe('ejercer');
  });

  /**
   * ⛔ La prueba negativa del reparto: un estado que este código no conoce **no** se cuela
   * en «Cerrado». Si mañana alguien agrega un estado a la tabla y olvida esta línea, tiene
   * que salir a la luz, no desaparecer.
   */
  it('un estado desconocido se declara, no se archiva', () => {
    expect(etapaDe('pagada')).toBe('sin_etapa');
    expect(etapaDe('')).toBe('sin_etapa');
    expect(etapaDe(null)).toBe('sin_etapa');
    expect(etapaDe(undefined)).toBe('sin_etapa');
  });

  it('no se cae por espacios ni por mayúsculas', () => {
    expect(etapaDe('  Recibida ')).toBe('aprobar');
    expect(etapaDe('APROBADA')).toBe('ejercer');
  });
});

describe('[GX.20] qué muestra cada pestaña', () => {
  it('Aprobar sólo trae lo que espera firma', () => {
    expect(visibleEn('aprobar', 'recibida')).toBe(true);
    expect(visibleEn('aprobar', 'aprobada')).toBe(false);
    expect(visibleEn('aprobar', 'validada')).toBe(false);
  });

  it('Ejercer trae lo aprobado y lo que quedó en revisión', () => {
    expect(visibleEn('ejercer', 'aprobada')).toBe(true);
    expect(visibleEn('ejercer', 'revision')).toBe(true);
    expect(visibleEn('ejercer', 'recibida')).toBe(false);
    expect(visibleEn('ejercer', 'validada')).toBe(false);
  });

  it('«Rechazados y aprobados» trae lo ya resuelto, y nada más', () => {
    expect(visibleEn('cerrado', 'validada')).toBe(true);
    expect(visibleEn('cerrado', 'rechazada')).toBe(true);
    expect(visibleEn('cerrado', 'recibida')).toBe(false);
    expect(visibleEn('cerrado', 'aprobada')).toBe(false);
    expect(visibleEn('cerrado', 'revision')).toBe(false);
  });

  /**
   * ⛔ Al irse «Todos» se fue el único lugar donde un estado desconocido seguía siendo
   * visible. Cae en la última pestaña **a propósito**: verlo marcado es peor que nada, pero
   * mucho mejor que no verlo en ninguna pantalla.
   */
  it('un estado desconocido no desaparece: cae en la última', () => {
    expect(visibleEn('cerrado', 'pagada')).toBe(true);
    expect(visibleEn('cerrado', null)).toBe(true);
    expect(visibleEn('aprobar', 'pagada')).toBe(false);
    expect(visibleEn('ejercer', 'pagada')).toBe(false);
  });

  /**
   * ⭐ La invariante que reemplaza a «Todos»: las tres pestañas **particionan** el día. Cada
   * estado se ve en una y sólo una — ni dos veces, ni ninguna.
   */
  it('las tres pestañas particionan: cada estado cae en exactamente una', () => {
    for (const s of ['recibida', 'aprobada', 'revision', 'validada', 'rechazada', 'pagada', '', null]) {
      const n = PESTANAS.filter((p) => visibleEn(p, s)).length;
      expect({ estado: s, pestanas: n }).toEqual({ estado: s, pestanas: 1 });
    }
  });
});

describe('[GX.20] los números del día', () => {
  it('un día sin movimiento devuelve ceros con las cuatro bandejas, no un objeto a medias', () => {
    const r = particionarDelDia([]);
    expect(r.total).toBe(0);
    expect(r.monto_total).toBe(0);
    expect(Object.keys(r.etapas).sort()).toEqual(['aprobar', 'cerrado', 'ejercer', 'sin_etapa']);
    for (const k of Object.keys(r.etapas) as EtapaGasto[]) expect(r.etapas[k]).toEqual({ n: 0, monto: 0 });
  });

  it('cuenta y suma cada bandeja por separado', () => {
    const r = particionarDelDia([
      E({ status: 'recibida', importe: 100 }),
      E({ status: 'recibida', importe: 50 }),
      E({ status: 'aprobada', importe: 300 }),
      E({ status: 'revision', importe: 25 }),
      E({ status: 'validada', importe: 10 }),
      E({ status: 'rechazada', importe: 5 }),
    ]);
    expect(r.etapas.aprobar).toEqual({ n: 2, monto: 150 });
    expect(r.etapas.ejercer).toEqual({ n: 2, monto: 325 });
    expect(r.etapas.cerrado).toEqual({ n: 2, monto: 15 });
    expect(r.total).toBe(6);
    expect(r.monto_total).toBe(490);
  });

  /**
   * ⭐ La invariante que sostiene el encabezado: **las bandejas suman el día, al centavo**.
   * Redondear en cada paso corre el total y la cifra de arriba deja de cuadrar con la suma
   * de las pestañas de abajo.
   */
  it('la suma de las etapas es el total del día, al centavo', () => {
    const filas = [
      E({ status: 'recibida', importe: 33.33 }),
      E({ status: 'aprobada', importe: 33.33 }),
      E({ status: 'validada', importe: 33.34 }),
      E({ status: 'pagada', importe: 0.01 }),
    ];
    const r = particionarDelDia(filas);
    expect(r.monto_total).toBe(100.01);
    const suma = (Object.values(r.etapas) as { n: number; monto: number }[])
      .reduce((a, e) => a + e.monto, 0);
    expect(Math.round(suma * 100) / 100).toBe(r.monto_total);
    const n = (Object.values(r.etapas) as { n: number }[]).reduce((a, e) => a + e.n, 0);
    expect(n).toBe(r.total);
  });

  it('un importe nulo o basura cuenta como renglón pero suma cero — no rompe el total', () => {
    const r = particionarDelDia([
      E({ status: 'recibida', importe: null as unknown as number }),
      E({ status: 'recibida', importe: Number.NaN }),
      E({ status: 'recibida', importe: 10 }),
    ]);
    expect(r.total).toBe(3);
    expect(r.monto_total).toBe(10);
    expect(r.etapas.aprobar).toEqual({ n: 3, monto: 10 });
  });
});

describe('[GX.20] el día que se mira', () => {
  it('acepta una fecha ISO', () => {
    expect(diaValido('2026-09-25')).toBe('2026-09-25');
    expect(diaValido('2026-09-25T18:00:00.000Z')).toBe('2026-09-25');
  });

  /**
   * ⛔ Un parámetro roto NO cae a «hoy». Si cayera, un día sin movimiento y una fecha mal
   * escrita se verían idénticos, y quien mira creería que no se levantó nada.
   */
  it('lo que no tiene forma de fecha devuelve null, no hoy', () => {
    for (const v of ['', 'hoy', '25/09/2026', '2026-9-5', null, undefined, {}]) {
      expect(diaValido(v)).toBeNull();
    }
  });

  it('una fecha que el calendario no tiene se rechaza', () => {
    expect(diaValido('2026-02-31')).toBeNull();
    expect(diaValido('2026-13-01')).toBeNull();
  });

  /**
   * ⚠️ El día es el de México, no el de UTC. A las 20:00 de México ya son las 02:00 UTC del
   * día siguiente: con `toISOString()` la pantalla saltaría de día a media tarde y el gasto
   * levantado a las 8 de la noche no aparecería en «hoy».
   */
  it('hoyMx usa la hora de México, no UTC', () => {
    expect(hoyMx(new Date('2026-09-26T02:30:00.000Z'))).toBe('2026-09-25');
    expect(hoyMx(new Date('2026-09-25T18:00:00.000Z'))).toBe('2026-09-25');
    expect(hoyMx()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
