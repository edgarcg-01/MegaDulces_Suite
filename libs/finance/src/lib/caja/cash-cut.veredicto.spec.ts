import { VEREDICTOS_SIN_RESPUESTA, veredictoConcluyente } from '@megadulces/contracts';
import { calcularCorte, veredictoDe } from './cash-cut.engine';

/**
 * ⭐⭐ `[CG.156]` **El veredicto del arqueo: una sola definición, y que se pueda volver a leer.**
 *
 * Medido en prod el 2026-10-14 sobre `CC-2026-00001`, el único corte que existió en la vida del
 * módulo:
 *
 *     contado    = 3,653.50   ← sellado
 *     esperado   = NULL
 *     diferencia = NULL       ← justo lo que el diálogo promete revelar
 *
 * `sellarConteo()` escribía sólo `contado` y `morralla`; la revelación se calculaba en memoria y
 * viajaba únicamente en la respuesta de `POST /contar`. Ningún `GET` la devolvía. **Al recargar se
 * perdía para siempre**, la pantalla no tenía cómo saber que el corte ya estaba contado, y volvía
 * a ofrecer «Guardar conteo» — que el servidor rechaza. El corte quedó sin poder cerrarse, ni
 * recontarse, ni volver a verse.
 *
 * Acá se prueba el juicio en sí. Que la base acepte guardar `esperado`/`diferencia` en un corte
 * en borrador se verificó aparte contra los 8 `CHECK` reales de `finance.cash_ledger_cuts`:
 * `cut_cerrado_completo_chk` sólo los exige cuando el estado deja de ser `borrador`.
 */
describe('[CG.156] el veredicto, en una sola definición', () => {
  const base = { huboConteo: true, fondoSinMedir: false };

  it('el orden de las tres preguntas NO es intercambiable', () => {
    // Sin conteo gana `sin_contar` aunque la diferencia dé cero: si devolviera `cuadra`, un día
    // que nadie contó se vería igual que uno que cuadró al centavo.
    expect(veredictoDe({ huboConteo: false, fondoSinMedir: false, diferencia: 0 })).toBe('sin_contar');
    // Y gana incluso sin base: no hay con qué comparar, tenga fondo o no.
    expect(veredictoDe({ huboConteo: false, fondoSinMedir: true, diferencia: 0 })).toBe('sin_contar');
    // Con conteo pero sin base, `sin_base` va ANTES del cuadre: declarar `cuadra` contra un
    // esperado que arranca de un supuesto afirma coincidencia con algo que nadie midió.
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: true, diferencia: 0 })).toBe('sin_base');
  });

  it('la tolerancia es de un centavo, y es simétrica', () => {
    expect(veredictoDe({ ...base, diferencia: 0 })).toBe('cuadra');
    expect(veredictoDe({ ...base, diferencia: 0.004 })).toBe('cuadra');
    expect(veredictoDe({ ...base, diferencia: -0.004 })).toBe('cuadra');
    expect(veredictoDe({ ...base, diferencia: 0.02 })).toBe('sobra');
    expect(veredictoDe({ ...base, diferencia: -0.02 })).toBe('falta');
  });

  it('⛔ PRUEBA NEGATIVA: `calcularCorte` y `veredictoDe` no pueden divergir', () => {
    // Es la razón de extraer la función. Con el veredicto guardado hay un SEGUNDO consumidor —la
    // lectura— y dos implementaciones del mismo juicio divergen el día que una se mueve. Es la
    // misma lección que `[CG.155]` pagó con producción caída dos días por tres copias de la
    // misma escritura.
    const casos = [
      { fondoInicial: 1000, conteo: [{ denominacion: 500, piezas: 2 }], morralla: 0 },
      { fondoInicial: 1000, conteo: [{ denominacion: 500, piezas: 1 }], morralla: 0 },
      { fondoInicial: 1000, conteo: [{ denominacion: 1000, piezas: 2 }], morralla: 0 },
      { fondoInicial: null, conteo: [{ denominacion: 500, piezas: 2 }], morralla: 0 },
      { fondoInicial: 1000, conteo: [], morralla: 0 },
    ];
    for (const c of casos) {
      const t = calcularCorte({ fondoInicial: c.fondoInicial, movimientos: [], conteo: c.conteo, morralla: c.morralla });
      const huboConteo = c.conteo.some((d) => d.piezas > 0) || c.morralla > 0;
      expect(veredictoDe({ huboConteo, fondoSinMedir: c.fondoInicial == null, diferencia: t.diferencia }))
        .toBe(t.veredicto);
    }
  });

  it('`sin_medir` es una AUSENCIA de respuesta, no un faltante', () => {
    // Si cayera del lado de los concluyentes, la pantalla afirmaría un faltante que nadie calculó
    // sobre los cortes sellados antes de que el veredicto se guardara.
    expect(VEREDICTOS_SIN_RESPUESTA).toContain('sin_medir');
    expect(veredictoConcluyente('sin_medir')).toBe(false);
    expect(veredictoConcluyente('falta')).toBe(true);
    expect(veredictoConcluyente(null)).toBe(false);
  });

  it('⭐ el veredicto que se guarda es el del momento de sellar, con sus tres totales', () => {
    // `sellarConteo()` persiste `esperado`, `diferencia` y los tres totales que lo arman. Sin esos
    // totales, un `esperado` guardado es un número que después nadie puede defender.
    const t = calcularCorte({
      fondoInicial: 3000,
      movimientos: [
        { tipo: 'ingreso', monto: 1000 },
        { tipo: 'gasto', monto: 400 },
        { tipo: 'deposito', monto: 100 },
      ],
      conteo: [{ denominacion: 500, piezas: 7 }],
      morralla: 0,
    });
    expect(t.ingresos).toBe(1000);
    expect(t.gastos).toBe(400);
    expect(t.depositos).toBe(100);
    expect(t.esperado).toBe(3500);
    expect(t.contado).toBe(3500);
    expect(t.diferencia).toBe(0);
    expect(t.veredicto).toBe('cuadra');
  });
});
