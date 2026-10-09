import {
  LADOS_NECESARIOS,
  TIPOS_LEDGER,
  ladosFaltantes,
  resumenEjercicioPendiente,
  tipoLedgerLabel,
} from './budget-lados.contract';

/**
 * `[PVI.17]` — **Lo que la torre AFIRMA de un ejercicio que espera firma.**
 *
 * El riesgo de esta regla no es calcular mal: es **afirmar de más**. Decir «4 supuestos sin
 * respaldo» cuando lo único medible es «sin procedencia registrada» convierte una columna vacía
 * en una acusación — y la columna puede estar vacía porque el autopiloto todavía no pasó.
 *
 * Los dos primeros casos son el estado REAL de producción, medido el 2026-10-09:
 *
 *     PRE-2027-002   tipos {gasto, ingreso}   crecimiento 4 canales con número   procedencia NULL
 *     PRE-2026-002   tipos {gasto, ingreso}   crecimiento 4 canales EN CERO      procedencia NULL
 *
 * Los dos cuelgan del mismo defecto —falta `costo_ventas`— y **sólo uno tiene supuestos que
 * respaldar**. Si la regla no distinguiera el cero, le inventaría 4 pendientes al segundo.
 */

describe('[PVI.17] el estado real de prod', () => {
  it('⛔ PRE-2027-002: falta el costo de ventas Y tiene 4 supuestos sin procedencia', () => {
    const r = resumenEjercicioPendiente({
      tipos: ['gasto', 'ingreso'],
      crecimiento: { ruta: 0.0826, mayoreo: 0.2667, preventa: 0.5121, mostrador: 0.2105 },
      procedencia: null,
    });
    expect(r.faltan).toEqual(['costo_ventas']);
    expect(r.supuestos_sin_procedencia).toBe(4);
    expect(r.nota).toBe('falta Costo de ventas · 4 supuestos de crecimiento sin procedencia registrada');
    expect(r.hay_pendiente).toBe(true);
  });

  it('⛔ PRE-2026-002: mismos tipos, pero sus 4 canales están EN CERO — no hay supuesto que respaldar', () => {
    const r = resumenEjercicioPendiente({
      tipos: ['gasto', 'ingreso'],
      crecimiento: { ruta: 0, mayoreo: 0, preventa: 0, mostrador: 0 },
      procedencia: null,
    });
    expect(r.faltan).toEqual(['costo_ventas']);
    expect(r.supuestos_sin_procedencia).toBe(0);
    expect(r.nota).toBe('falta Costo de ventas');
  });

  it('⛔ PRUEBA NEGATIVA: contar los ceros le inventaría 4 pendientes al ejercicio que no los tiene', () => {
    const crecimiento = { ruta: 0, mayoreo: 0, preventa: 0, mostrador: 0 };
    const ingenuo = Object.keys(crecimiento).length; // lo que daría no mirar el valor
    expect(ingenuo).toBe(4);
    expect(resumenEjercicioPendiente({ tipos: [], crecimiento, procedencia: null }).supuestos_sin_procedencia).toBe(0);
  });
});

describe('[PVI.17] procedencia: NULL no es lo mismo que «ningún canal respaldado»', () => {
  it('un canal CON procedencia deja de contar', () => {
    const r = resumenEjercicioPendiente({
      tipos: ['ingreso', 'costo_ventas', 'gasto'],
      crecimiento: { ruta: 0.08, mayoreo: 0.26 },
      procedencia: { ruta: { basis: 'preexistente', at: '2026-10-09' } },
    });
    expect(r.supuestos_sin_procedencia).toBe(1);
    expect(r.faltan).toEqual([]);
    expect(r.nota).toBe('1 supuesto de crecimiento sin procedencia registrada');
  });

  it('el singular se escribe en singular', () => {
    const r = resumenEjercicioPendiente({ tipos: [], crecimiento: { ruta: 0.08 }, procedencia: null });
    expect(r.nota).toContain('1 supuesto de crecimiento');
    expect(r.nota).not.toContain('1 supuestos');
  });

  it('⛔ el texto dice «sin procedencia registrada», NUNCA «sin respaldo»', () => {
    // La columna en NULL puede significar que el autopiloto no pasó. Acusar a alguien de no
    // respaldar un número a partir de una columna vacía es afirmar lo que no se midió.
    const r = resumenEjercicioPendiente({ tipos: [], crecimiento: { ruta: 0.08 }, procedencia: null });
    expect(r.nota).toContain('sin procedencia registrada');
    expect(r.nota).not.toMatch(/sin respaldo|nadie|inventad/i);
  });

  it('una procedencia con el canal en null cuenta como ausente', () => {
    const r = resumenEjercicioPendiente({
      tipos: [],
      crecimiento: { ruta: 0.08 },
      procedencia: { ruta: null },
    });
    expect(r.supuestos_sin_procedencia).toBe(1);
  });
});

describe('[PVI.17] los lados', () => {
  it('«vale cero» NO es «no existe»: un costo de ventas en 0 está presente', () => {
    expect(ladosFaltantes(['ingreso', 'costo_ventas', 'gasto'])).toEqual([]);
    expect(ladosFaltantes(['ingreso', 'gasto'])).toEqual(['costo_ventas']);
  });

  it('los tres necesarios son ingreso, costo de ventas y gasto — los otros tres no entran al P&L', () => {
    expect(LADOS_NECESARIOS).toEqual(['ingreso', 'costo_ventas', 'gasto']);
    // `compra_inventario`, `inversion` y `flujo` son balance y tesorería: tenerlos no habilita
    // la resta, y exigirlos la bloquearía para siempre.
    expect(ladosFaltantes(['compra_inventario', 'inversion', 'flujo'])).toEqual(LADOS_NECESARIOS);
  });

  it('el vocabulario son los SEIS del CHECK de la tabla, en orden de lectura', () => {
    expect([...TIPOS_LEDGER]).toEqual([
      'ingreso', 'costo_ventas', 'gasto', 'compra_inventario', 'inversion', 'flujo',
    ]);
  });

  it('un tipo que la tabla no admite no se cuela ni rompe', () => {
    expect(ladosFaltantes(['ingreso', 'inventado', 'gasto'])).toEqual(['costo_ventas']);
  });

  it('los rótulos son legibles', () => {
    expect(tipoLedgerLabel('costo_ventas')).toBe('Costo de ventas');
    expect(tipoLedgerLabel('gasto')).toBe('Gasto operativo');
  });
});

describe('[PVI.17] «Listo para firmar» es una afirmación fuerte', () => {
  it('sólo se emite cuando NO falta nada de nada', () => {
    const r = resumenEjercicioPendiente({
      tipos: ['ingreso', 'costo_ventas', 'gasto'],
      crecimiento: { ruta: 0.08 },
      procedencia: { ruta: { basis: 'yoy' } },
    });
    expect(r.nota).toBe('Listo para firmar');
    expect(r.hay_pendiente).toBe(false);
  });

  it('⛔ con un solo lado faltante NO dice que está listo', () => {
    const r = resumenEjercicioPendiente({ tipos: ['ingreso', 'gasto'], crecimiento: {}, procedencia: {} });
    expect(r.nota).not.toContain('Listo');
    expect(r.hay_pendiente).toBe(true);
  });

  it('un ejercicio sin partidas ni plan no se declara listo', () => {
    const r = resumenEjercicioPendiente({ tipos: [], crecimiento: null, procedencia: null });
    expect(r.faltan).toEqual(['ingreso', 'costo_ventas', 'gasto']);
    expect(r.nota).toBe('falta Ingreso y Costo de ventas y Gasto operativo');
  });
});
