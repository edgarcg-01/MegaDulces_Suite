import { ejercicioInicial, esDePrueba } from './presupuesto-seleccion';

/**
 * `[PVI.15]` — **Qué ejercicio abre la pantalla.**
 *
 * La primera prueba reproduce el orden EXACTO que devolvía prod el 2026-10-09, con los nombres
 * reales. Es el caso que Edgar vio en su pantalla: abrió `/presupuesto` y estaba parado sobre
 * **«PRUEBA ciclo ledger — no usar»**, leyendo $604,775,116 de meta que eran de la copia.
 *
 * ⛔ Y la segunda regla es la que hace que el arreglo no cause el daño simétrico: `is_test` en
 * `null` es «la columna no existía cuando se guardó», NO «es de prueba». Tratarlo como prueba
 * escondería ejercicios REALES viejos, y eso es más difícil de notar — la pantalla simplemente
 * abriría en otro, sin avisar.
 */

const PROD = [
  { id: 'f517eabd', folio: null, name: 'PRUEBA ciclo ledger — no usar', fiscal_year: 2027, is_test: true },
  { id: 'e6c86aab', folio: 'PRE-2027-002', name: 'Presupuesto 2027', fiscal_year: 2027, is_test: false },
  { id: 'a0d5f48f', folio: 'PRE-2026-002', name: 'prueba 2', fiscal_year: 2026, is_test: false },
];

describe('[PVI.15] la pantalla no abre sobre un ejercicio de prueba', () => {
  it('⭐ EL CASO REAL: con el de prueba PRIMERO, igual elige el real', () => {
    const b = ejercicioInicial(PROD);
    expect(b?.id).toBe('e6c86aab');
    expect(b?.name).toBe('Presupuesto 2027');
  });

  it('⛔ PRUEBA NEGATIVA: tomar `rows[0]` da el de prueba — es lo que hacía el front', () => {
    expect(PROD[0].name).toContain('PRUEBA');
    expect(PROD[0].id).not.toBe(ejercicioInicial(PROD)?.id);
  });

  it('no depende del orden: con el de prueba al final elige el mismo', () => {
    const alReves = [PROD[1], PROD[2], PROD[0]];
    expect(ejercicioInicial(alReves)?.id).toBe('e6c86aab');
  });

  it('entre varios reales respeta el orden que vino (el más nuevo primero)', () => {
    expect(ejercicioInicial([PROD[2], PROD[1]])?.id).toBe('a0d5f48f');
  });
});

describe('[PVI.15] las ausencias, que no son prueba', () => {
  it('⛔ `is_test` en null o ausente NO es un ejercicio de prueba', () => {
    const viejos = [
      { id: 'viejo-1', is_test: null },
      { id: 'viejo-2' },
    ];
    expect(ejercicioInicial(viejos)?.id).toBe('viejo-1');
    expect(esDePrueba(viejos[0])).toBe(false);
    expect(esDePrueba(viejos[1])).toBe(false);
  });

  it('PRUEBA NEGATIVA: con un truthy en vez de `=== true`, un null escondería un ejercicio REAL', () => {
    const rows = [{ id: 'real-viejo', is_test: null }, { id: 'real-nuevo', is_test: false }];
    // La regla correcta abre en el primero (es real, sólo que anterior a la columna).
    expect(ejercicioInicial(rows)?.id).toBe('real-viejo');
  });

  it('si TODOS son de prueba abre en el primero: hay algo que mirar, y el rótulo lo dice', () => {
    const todos = [{ id: 't1', is_test: true }, { id: 't2', is_test: true }];
    expect(ejercicioInicial(todos)?.id).toBe('t1');
    expect(esDePrueba(ejercicioInicial(todos))).toBe(true);
  });

  it('sin ejercicios no inventa uno', () => {
    expect(ejercicioInicial([])).toBeNull();
    expect(ejercicioInicial(null)).toBeNull();
    expect(ejercicioInicial(undefined)).toBeNull();
    expect(esDePrueba(null)).toBe(false);
  });
});
