import { ESTADOS_CERRADOS, ESTADOS_DECIDIDOS, PESTANAS, diaValido, diasDeAtraso, esperaDecision, etapaDe, hoyMx, particionarDelDia, queFalta, type EtapaGasto, type ExpedienteDelDia, visibleEn } from './etapas-del-dia';

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
  /** El corte es la DECISIÓN: lo que espera una, lo que se dijo que sí, lo que se dijo que no. */
  it('reparte los cinco estados del ciclo por su decisión', () => {
    expect(etapaDe('recibida')).toBe('entrada');
    expect(etapaDe('aprobada')).toBe('aprobados');
    expect(etapaDe('validada')).toBe('aprobados');
    expect(etapaDe('rechazada')).toBe('rechazados');
  });

  /**
   * ⭐ `revision` es el expediente que volvió con evidencia y el cuadre NO dio. La decisión
   * sobre él **ya fue que sí**: lo que falta es cerrar, no autorizar. Mandarlo a «Rechazados»
   * diría que se le negó, que es exactamente lo contrario de lo que pasó.
   */
  it('revision está APROBADO: el cuadre falló, la decisión no', () => {
    expect(etapaDe('revision')).toBe('aprobados');
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
    expect(etapaDe('  Recibida ')).toBe('entrada');
    expect(etapaDe('APROBADA')).toBe('aprobados');
  });
});

describe('[GX.20] qué muestra cada pestaña', () => {
  it('la bandeja de entrada sólo trae lo que espera decisión', () => {
    expect(visibleEn('entrada', 'recibida')).toBe(true);
    expect(visibleEn('entrada', 'aprobada')).toBe(false);
    expect(visibleEn('entrada', 'validada')).toBe(false);
    expect(visibleEn('entrada', 'rechazada')).toBe(false);
  });

  /** Los tres momentos del cierre viven juntos: la decisión fue una sola. */
  it('Aprobados trae los TRES estados del sí', () => {
    expect(visibleEn('aprobados', 'aprobada')).toBe(true);
    expect(visibleEn('aprobados', 'revision')).toBe(true);
    expect(visibleEn('aprobados', 'validada')).toBe(true);
    expect(visibleEn('aprobados', 'recibida')).toBe(false);
    expect(visibleEn('aprobados', 'rechazada')).toBe(false);
  });

  it('Rechazados trae sólo lo rechazado', () => {
    expect(visibleEn('rechazados', 'rechazada')).toBe(true);
    for (const s of ['recibida', 'aprobada', 'revision', 'validada']) {
      expect(visibleEn('rechazados', s)).toBe(false);
    }
  });

  /**
   * ⛔ Un estado que el servidor no reconoce entra por la bandeja de entrada — la que
   * significa «alguien tiene que mirar esto». Sin esta red no saldría en ninguna de las
   * tres, o sea que el expediente no existiría en la aplicación.
   */
  it('un estado desconocido no desaparece: entra por la bandeja de entrada', () => {
    expect(visibleEn('entrada', 'pagada')).toBe(true);
    expect(visibleEn('entrada', null)).toBe(true);
    expect(visibleEn('aprobados', 'pagada')).toBe(false);
    expect(visibleEn('rechazados', 'pagada')).toBe(false);
  });

  /**
   * ⭐ La invariante de fondo: las tres pestañas **particionan** el día. Cada estado se ve en
   * una y sólo una — ni dos veces, ni ninguna.
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
    expect(Object.keys(r.etapas).sort()).toEqual(['aprobados', 'entrada', 'rechazados', 'sin_etapa']);
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
    expect(r.etapas.entrada).toEqual({ n: 2, monto: 150 });
    expect(r.etapas.aprobados).toEqual({ n: 3, monto: 335 });
    expect(r.etapas.rechazados).toEqual({ n: 1, monto: 5 });
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
    expect(r.etapas.entrada).toEqual({ n: 3, monto: 10 });
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

/**
 * `[GX.67]` **La lista de estados ya decididos se DERIVA del mapa, no se copia.**
 *
 * La consume un `WHERE status NOT IN (...)` del servicio, que es el que arma la bandeja de
 * entrada sin acotarla por día. Con la lista escrita a mano en el SQL, agregar un estado al
 * mapa y olvidarse de esa línea tendría una de dos consecuencias, las dos silenciosas:
 * un expediente ya decidido colándose en la bandeja, o —peor— uno pendiente desapareciendo
 * de ella. Es el «primitivo duplicado a mano» de ADR-056.
 */
describe('[GX.67] ESTADOS_DECIDIDOS y esperaDecision', () => {
  it('son exactamente los estados que NO caen en la bandeja de entrada', () => {
    expect([...ESTADOS_DECIDIDOS].sort()).toEqual(['aprobada', 'rechazada', 'revision', 'validada']);
  });

  /**
   * ⭐ El candado que importa: la lista y el repartidor no pueden separarse. Si alguien
   * agrega un estado al mapa, esta prueba lo obliga a decidir de qué lado cae.
   */
  it('⭐ ningún estado decidido cae en la bandeja, y ninguno de la bandeja está en la lista', () => {
    for (const e of ESTADOS_DECIDIDOS) {
      expect(visibleEn('entrada', e)).toBe(false);
      expect(esperaDecision(e)).toBe(false);
    }
    expect(ESTADOS_DECIDIDOS).not.toContain('recibida');
  });

  it('`recibida` espera decisión', () => {
    expect(esperaDecision('recibida')).toBe(true);
  });

  /**
   * ⛔ Un estado que el repartidor no conoce espera decisión. Es la misma red que
   * `visibleEn()`: trabajo que nadie reconoce es trabajo que alguien tiene que mirar, no
   * trabajo terminado. Si cayera del otro lado, el `NOT IN` lo sacaría de la bandeja y el
   * expediente no existiría en ninguna pantalla.
   */
  it('⛔ NEGATIVA: un estado desconocido espera decisión, no se da por cerrado', () => {
    expect(esperaDecision('inventado_manana')).toBe(true);
    expect(esperaDecision(null)).toBe(true);
    expect(esperaDecision(undefined)).toBe(true);
    expect(esperaDecision('')).toBe(true);
    expect(visibleEn('entrada', 'inventado_manana')).toBe(true);
  });

  /** Las dos lecturas tienen que ser complementarias para TODO estado conocido. */
  it('esperaDecision es el complemento exacto de la lista', () => {
    for (const e of ['recibida', 'aprobada', 'revision', 'validada', 'rechazada', 'raro']) {
      expect(esperaDecision(e)).toBe(!ESTADOS_DECIDIDOS.includes(e));
    }
  });
});

/**
 * `[GX.88]` **Los atrasados.** Pedido del usuario (2026-10-30): un apartado que diga cuáles se
 * quedaron atrasados, en orden. Medido en prod ese día: 5 vales ($78,804.91) esperaban que
 * alguien los diera por comprobados y no aparecían en ningún lado de la pantalla.
 */
describe('[GX.88] qué cuenta como cerrado', () => {
  it('sólo validada y rechazada: lo demás sigue abierto y va a Atrasados', () => {
    expect(ESTADOS_CERRADOS).toEqual(['validada', 'rechazada']);
  });

  /** ⛔ El servidor filtra con `whereNotIn(ESTADOS_CERRADOS)`: un estado nuevo cae en Atrasados, a la vista. */
  it('⛔ NEGATIVA: los estados abiertos del ciclo NO están en la lista de cerrados', () => {
    for (const s of ['recibida', 'aprobada', 'revision']) expect(ESTADOS_CERRADOS).not.toContain(s);
  });
});

describe('[GX.88] qué le falta a un atrasado, y a quién le toca', () => {
  it('sin firmar: le toca a quien aprueba', () => {
    expect(queFalta({ status: 'recibida' })).toEqual({ texto: 'Falta firmarlo: aprobarlo o rechazarlo.', toca: 'aprueba' });
  });

  it('con el comprobante subido después: le toca a quien aprueba revisarlo', () => {
    const f = queFalta({ status: 'revision' });
    expect(f.toca).toBe('aprueba');
    expect(f.texto).toContain('falta revisarlo');
  });

  it('aprobado como provisional: espera el comprobante definitivo de quien lo levantó', () => {
    const f = queFalta({ status: 'aprobada', provisional: true, requiere_evidencia: false });
    expect(f.toca).toBe('levanto');
    expect(f.texto).toContain('provisional');
  });

  it('aprobado sin evidencia que la pide: espera a quien lo levantó', () => {
    const f = queFalta({ status: 'aprobada', provisional: false, requiere_evidencia: true, tiene_evidencia: false });
    expect(f.toca).toBe('levanto');
    expect(f.texto).toContain('suba la evidencia');
  });

  it('aprobado y con evidencia: falta darlo por comprobado, le toca a quien aprueba', () => {
    const f = queFalta({ status: 'aprobada', provisional: false, requiere_evidencia: true, tiene_evidencia: true });
    expect(f.toca).toBe('aprueba');
    expect(f.texto).toContain('darlo por comprobado');
  });

  it('⛔ un estado desconocido se dice tal cual, no se adivina', () => {
    const f = queFalta({ status: 'pagada' });
    expect(f.texto).toContain('«pagada»');
    expect(f.toca).toBe('aprueba');
    expect(queFalta({ status: null }).texto).toContain('«vacío»');
  });

  it('no se cae por mayúsculas ni espacios', () => {
    expect(queFalta({ status: ' RECIBIDA ' }).toca).toBe('aprueba');
  });
});

describe('[GX.88] días de atraso', () => {
  it('cuenta días de calendario', () => {
    expect(diasDeAtraso('2026-10-29', '2026-10-30')).toBe(1);
    expect(diasDeAtraso('2026-08-25', '2026-10-30')).toBe(66);
    expect(diasDeAtraso('2026-10-30', '2026-10-30')).toBe(0);
  });

  it('cruza fin de mes y de año sin correrse', () => {
    expect(diasDeAtraso('2026-12-31', '2027-01-01')).toBe(1);
    expect(diasDeAtraso('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('⛔ una fecha ilegible da null, no 0 (0 diría «es de hoy»)', () => {
    expect(diasDeAtraso('25/10/2026', '2026-10-30')).toBeNull();
    expect(diasDeAtraso(null, '2026-10-30')).toBeNull();
    expect(diasDeAtraso('2026-10-29', 'basura')).toBeNull();
  });
});
