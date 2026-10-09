/**
 * [PU.VG.1] — A qué ejercicios entra la pasada del autopiloto.
 *
 * Unitaria de verdad: función pura, sin Postgres, sin reloj, sin dobles. Lo que toca Postgres
 * se prueba aparte, contra la DB (ADR-044) — `test-newdb-budget-is-test.js`, que cubre el otro
 * lado del cambio (`ensureBudgetForYear` no puede contar los de prueba).
 *
 * ⭐ El eje de esta suite NO es "¿entra a los buenos?" sino **"¿se NIEGA a entrar a los que no
 * son presupuesto?"** — por eso la mitad son pruebas negativas. Un autopiloto que regenera un
 * ejercicio de prueba todas las mañanas no falla: lo deja fresco, y un ejercicio fresco parece
 * legítimo. Eso fue exactamente lo medido en prod el 2026-10-08 (3 ejercicios, 2 de prueba, uno
 * llamado "PRUEBA ciclo ledger — no usar", recorrido por el cron de las 7:30).
 *
 * PRUEBA NEGATIVA DEL CANDADO: quitá `&& row?.is_test !== true` de `esEjercicioOperable` y los
 * tres casos marcados abajo tienen que ponerse en ROJO. Si siguen verdes, el candado no mide.
 */
import { esEjercicioOperable } from './budget-autopilot.policy';

const ej = (o: Partial<{ status: unknown; is_test: unknown }>) => ({ status: 'borrador', ...o });

describe('esEjercicioOperable · entra a los abiertos', () => {
  it('borrador entra', () => {
    expect(esEjercicioOperable(ej({ status: 'borrador', is_test: false }))).toBe(true);
  });
  it('en_revision entra', () => {
    expect(esEjercicioOperable(ej({ status: 'en_revision', is_test: false }))).toBe(true);
  });
});

describe('esEjercicioOperable · NO entra a lo que no se toca', () => {
  it('aprobado no entra: el autopiloto nunca pisa un ejercicio firmado', () => {
    expect(esEjercicioOperable(ej({ status: 'aprobado', is_test: false }))).toBe(false);
  });
  it('cerrado no entra', () => {
    expect(esEjercicioOperable(ej({ status: 'cerrado', is_test: false }))).toBe(false);
  });
  it('un estado que nadie previó NO entra — el lado seguro de equivocarse', () => {
    expect(esEjercicioOperable(ej({ status: 'estado_que_alguien_agregue_en_2027' }))).toBe(false);
  });
});

describe('esEjercicioOperable · el ejercicio de PRUEBA queda afuera [PRUEBA NEGATIVA]', () => {
  // ⛔ Estos tres son los que tienen que ponerse en rojo si se quita el filtro de is_test.
  it('borrador marcado como prueba NO entra, aunque su estado esté abierto', () => {
    expect(esEjercicioOperable(ej({ status: 'borrador', is_test: true }))).toBe(false);
  });
  it('en_revision marcado como prueba tampoco entra', () => {
    expect(esEjercicioOperable(ej({ status: 'en_revision', is_test: true }))).toBe(false);
  });
  it('el caso real de prod: "PRUEBA ciclo ledger — no usar", borrador, marcado', () => {
    expect(esEjercicioOperable({ status: 'borrador', is_test: true })).toBe(false);
  });
});

describe('esEjercicioOperable · la ausencia de bandera significa REAL, nunca "no sé"', () => {
  // La columna es NOT NULL DEFAULT false, pero esta lista también la arma código viejo. Un
  // ejercicio sin bandera tiene que entrar: tratarlo como prueba lo sacaría del autopiloto en
  // silencio, que es el error caro en la dirección contraria.
  it('sin la propiedad, entra', () => {
    expect(esEjercicioOperable({ status: 'borrador' })).toBe(true);
  });
  it('undefined entra', () => {
    expect(esEjercicioOperable(ej({ is_test: undefined }))).toBe(true);
  });
  it('null entra', () => {
    expect(esEjercicioOperable(ej({ is_test: null }))).toBe(true);
  });
  it('pero el string "true" NO cuenta como marcado: la bandera es booleana', () => {
    // Si algún día una capa serializa la columna como texto, esto se pone rojo y avisa —
    // en vez de dejar pasar un ejercicio de prueba porque "true" no es true.
    expect(esEjercicioOperable(ej({ is_test: 'true' }))).toBe(true);
  });
});

describe('esEjercicioOperable · sobre la lista completa, como la usa el autopiloto', () => {
  it('de los 3 ejercicios medidos en prod, con los 2 de prueba marcados, queda 1', () => {
    const filas = [
      { id: 'a', name: 'prueba 2', status: 'borrador', is_test: true },
      { id: 'b', name: 'Presupuesto 2027', status: 'borrador', is_test: false },
      { id: 'c', name: 'PRUEBA ciclo ledger — no usar', status: 'borrador', is_test: true },
    ];
    const abiertos = filas.filter(esEjercicioOperable);
    expect(abiertos.map((r) => r.id)).toEqual(['b']);
  });
});
