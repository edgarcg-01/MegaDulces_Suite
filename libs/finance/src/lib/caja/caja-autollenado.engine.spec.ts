import { describe, expect, it } from 'vitest';
import {
  MAX_VUELTAS, PISO_ALCANCE_DEFAULT,
  acumular, diaDe, motivoCeroOk, notaDeCorrida, planearVuelta, resumenVacio,
  type PendienteResuelto, type ResultadoFila,
} from './caja-autollenado.engine';

/**
 * `[CG.190]` — Suite del motor del autollenado.
 *
 * ⭐ Lo que se prueba acá es **a quién se le da curso**, no a qué cuenta va el dinero: esa
 * decisión vive en `resolverCuentas()` y tiene su propia suite. Mezclarlas haría que este archivo
 * probara el resolvedor contra una copia del resolvedor, que es el espejo que ADR-059 prohíbe.
 *
 * Cada caso de abajo se rompió a propósito una vez y se verificó que SU prueba se pone roja.
 */

const HOY = '2026-10-16';
const PISO = '2026-10-10';

function fila(p: Partial<PendienteResuelto> & { origen_ref: string }): PendienteResuelto {
  return { tipo: 'gasto', fecha_valor: '2026-10-15', monto: 100, confirmable: true, ...p };
}

describe('diaDe', () => {
  it('convierte un Date de node-pg sin correr el día', () => {
    // ⛔ El caso que `[CG.162]` pagó: `toISOString()` sobre un Date local de la tarde devuelve el
    // día SIGUIENTE en UTC. Acá tiene que devolver el día tal cual lo trae el objeto.
    expect(diaDe(new Date(2026, 9, 15, 23, 30))).toBe('2026-10-15');
  });

  it('recorta un texto y tolera el vacío', () => {
    expect(diaDe('2026-10-15T00:00:00.000Z')).toBe('2026-10-15');
    expect(diaDe(null)).toBe('');
    expect(diaDe(undefined)).toBe('');
  });
});

describe('planearVuelta', () => {
  it('aplica sólo lo que el resolvedor dio por confirmable', () => {
    const plan = planearVuelta([
      fila({ origen_ref: 'a', confirmable: true, monto: 10 }),
      fila({ origen_ref: 'b', confirmable: false, motivo: 'sin_regla', monto: 20 }),
    ], { piso: PISO, hoy: HOY });

    expect(plan.aplicar).toEqual(['a']);
    expect(plan.monto_aplicar).toBe(10);
    expect(plan.excluidos).toEqual([
      { origen_ref: 'b', motivo: 'sin_resolver', detalle: 'sin_regla', monto: 20 },
    ]);
  });

  it('⛔ NUNCA aplica un documento fechado después de hoy, aunque el resolvedor lo dé por bueno', () => {
    // El caso real: 7 documentos que Kepler fechó en diciembre. Con la cuenta ya resuelta, el
    // único freno que queda es éste — y `[CG.24]` demostró que un aviso que no frena es
    // decoración: un gasto de enero entró al libro como diciembre.
    const plan = planearVuelta([
      fila({ origen_ref: 'futuro', fecha_valor: '2026-12-10', confirmable: true, monto: 3747.66 }),
    ], { piso: PISO, hoy: HOY });

    expect(plan.aplicar).toEqual([]);
    expect(plan.excluidos[0]).toMatchObject({ motivo: 'fecha_futura', detalle: '2026-12-10' });
  });

  it('⛔ NUNCA aplica lo anterior al piso: eso ya está conciliado en el Access', () => {
    // Sin este freno el autollenado escribiría 13,206 movimientos por $162 M que ya existen del
    // otro lado — el libro tendría el mismo dinero dos veces.
    const plan = planearVuelta([
      fila({ origen_ref: 'viejo', fecha_valor: '2026-09-30', confirmable: true, monto: 999 }),
    ], { piso: PISO, hoy: HOY });

    expect(plan.aplicar).toEqual([]);
    expect(plan.excluidos[0]).toMatchObject({ motivo: 'fuera_de_alcance', detalle: '2026-09-30' });
  });

  it('el piso gana sobre la fecha futura: una fila vieja Y futura no existe, pero el orden se fija', () => {
    const plan = planearVuelta([fila({ origen_ref: 'x', fecha_valor: '2026-01-01' })], { piso: PISO, hoy: HOY });
    expect(plan.excluidos[0].motivo).toBe('fuera_de_alcance');
  });

  it('una fila sin `confirmable` explícito NO se aplica', () => {
    // `confirmable !== true` y no `=== false`: un `undefined` por un cambio de forma en la
    // bandeja no puede convertirse en «sí, escribila».
    const plan = planearVuelta([{ origen_ref: 'z', fecha_valor: '2026-10-15', monto: 5 }], { piso: PISO, hoy: HOY });
    expect(plan.aplicar).toEqual([]);
    expect(plan.excluidos[0]).toMatchObject({ motivo: 'sin_resolver', detalle: null });
  });

  it('tolera lista vacía, nula y filas sin origen_ref', () => {
    expect(planearVuelta([], { piso: PISO, hoy: HOY }).aplicar).toEqual([]);
    expect(planearVuelta(null, { piso: PISO, hoy: HOY }).aplicar).toEqual([]);
    expect(planearVuelta([{ origen_ref: '' } as PendienteResuelto], { piso: PISO, hoy: HOY }).aplicar).toEqual([]);
  });

  it('el día de hoy SÍ entra: el corte es `>` hoy, no `>=`', () => {
    // Protege el caso normal de un endurecimiento bienintencionado. Con `>=` el autollenado
    // dejaría de registrar lo del día, que es justo lo que viene a resolver.
    const plan = planearVuelta([fila({ origen_ref: 'hoy', fecha_valor: HOY })], { piso: PISO, hoy: HOY });
    expect(plan.aplicar).toEqual(['hoy']);
  });

  it('el día del piso SÍ entra: el corte es `<` piso, no `<=`', () => {
    // El 10-oct es el día del corte del Access y es DONDE ESTÁ EL 78 % del rezago. Con `<=` se
    // perderían 81 de los 103 movimientos reales.
    const plan = planearVuelta([fila({ origen_ref: 'piso', fecha_valor: PISO })], { piso: PISO, hoy: HOY });
    expect(plan.aplicar).toEqual(['piso']);
  });
});

describe('acumular', () => {
  const plan = { aplicar: ['a'], excluidos: [], monto_aplicar: 10 };

  it('suma lo guardado y separa duplicado de rechazado', () => {
    const filas: ResultadoFila[] = [
      { origen_ref: 'a', estado: 'guardado', folio: 'CG-1' },
      { origen_ref: 'b', estado: 'duplicado' },
      { origen_ref: 'c', estado: 'rechazado', motivo: 'reventó' },
    ];
    const r = acumular(resumenVacio(), plan, filas, new Map([['a', 10]]));

    expect(r).toMatchObject({ registrados: 1, monto_registrado: 10, duplicados: 1, rechazados: 1 });
    // ⛔ Un rechazo callado se lee como guardado. Tiene que viajar con su mensaje.
    expect(r.fallas).toEqual(['c: reventó']);
  });

  it('⛔ los excluidos se PISAN entre vueltas, no se suman', () => {
    // Las mismas filas sin resolver vuelven en cada vuelta porque no se confirmaron. Sumarlas
    // multiplicaría el rezago por el número de vueltas y el aviso diría 3× lo que hay.
    const conExcluido = {
      aplicar: [], excluidos: [{ origen_ref: 'x', motivo: 'sin_resolver' as const, detalle: 'sin_regla', monto: 50 }], monto_aplicar: 0,
    };
    let r = acumular(resumenVacio(), conExcluido, [], new Map());
    r = acumular(r, conExcluido, [], new Map());

    expect(r.vueltas).toBe(2);
    expect(r.excluidos.sin_resolver).toEqual({ movimientos: 1, monto: 50 });
    expect(r.sin_resolver_detalle).toEqual({ sin_regla: 1 });
  });

  it('los registrados SÍ se suman entre vueltas: cada uno ocurrió una vez', () => {
    let r = acumular(resumenVacio(), plan, [{ origen_ref: 'a', estado: 'guardado' }], new Map([['a', 10]]));
    r = acumular(r, plan, [{ origen_ref: 'b', estado: 'guardado' }], new Map([['b', 5]]));
    expect(r).toMatchObject({ registrados: 2, monto_registrado: 15, vueltas: 2 });
  });
});

describe('motivoCeroOk — la diferencia entre «no había nada» y «no pude con nada»', () => {
  it('cero con la cola vacía es LEGÍTIMO y lo declara', () => {
    expect(motivoCeroOk(resumenVacio())).toMatch(/no había documentos pendientes/);
  });

  it('⛔ cero con filas SIN RESOLVER no es legítimo: tiene que latir en rojo', () => {
    // Es la distinción que `[CG.162]` confundió durante 755 depósitos. Si hay cola y no se
    // registró nada, el motor no está pudiendo — y un `ceroEsOk` lo pintaría verde.
    const r = resumenVacio();
    r.excluidos.sin_resolver = { movimientos: 3, monto: 1700 };
    expect(motivoCeroOk(r)).toBeUndefined();
  });

  it('cero porque todo estaba duplicado es legítimo, y se distingue', () => {
    const r = { ...resumenVacio(), duplicados: 4 };
    expect(motivoCeroOk(r)).toMatch(/ya estaba cubierta/);
  });

  it('con registros NO declara excepción: el cero no aplica', () => {
    expect(motivoCeroOk({ ...resumenVacio(), registrados: 1 })).toBeUndefined();
  });
});

describe('notaDeCorrida', () => {
  it('dice lo que hizo Y lo que dejó', () => {
    const r = resumenVacio();
    r.registrados = 117; r.monto_registrado = 445761.53;
    r.excluidos.sin_resolver = { movimientos: 3, monto: 1700 };
    r.sin_resolver_detalle = { sin_regla: 3 };
    r.excluidos.fecha_futura = { movimientos: 7, monto: 50796.4 };

    const nota = notaDeCorrida(r);
    expect(nota).toContain('117 registrados');
    expect(nota).toContain('3 sin resolver (sin_regla×3)');
    expect(nota).toContain('7 mal fechados en Kepler');
  });

  it('declara cuando paró por el tope de vueltas', () => {
    // Un corte por tope y un corte por cola vacía terminan igual de callados si no se dice.
    expect(notaDeCorrida({ ...resumenVacio(), tope_alcanzado: true })).toContain(`tope de ${MAX_VUELTAS} vueltas`);
  });
});

describe('el piso por default', () => {
  it('es la decisión de alcance del 2026-10-16, no un número suelto', () => {
    // Si alguien lo mueve, que sea mirando esta prueba y el porqué: antes del 10-oct el libro
    // vive en el Access `Control` y escribir ahí duplicaría $162,080,748.92.
    expect(PISO_ALCANCE_DEFAULT).toBe('2026-10-10');
  });
});
