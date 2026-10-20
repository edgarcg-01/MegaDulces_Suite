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
  // `[CG.195]` El esperado va POSITIVO en la base: es el caso normal, y así los casos de abajo
  // prueban lo que dicen probar en vez de caer todos en `esperado_imposible`.
  const base = { huboConteo: true, fondoSinMedir: false, esperado: 1000 };

  it('el orden de las tres preguntas NO es intercambiable', () => {
    // Sin conteo gana `sin_contar` aunque la diferencia dé cero: si devolviera `cuadra`, un día
    // que nadie contó se vería igual que uno que cuadró al centavo.
    expect(veredictoDe({ huboConteo: false, fondoSinMedir: false, diferencia: 0, esperado: 1000 })).toBe('sin_contar');
    // Y gana incluso sin base: no hay con qué comparar, tenga fondo o no.
    expect(veredictoDe({ huboConteo: false, fondoSinMedir: true, diferencia: 0, esperado: 1000 })).toBe('sin_contar');
    // Con conteo pero sin base, `sin_base` va ANTES del cuadre: declarar `cuadra` contra un
    // esperado que arranca de un supuesto afirma coincidencia con algo que nadie midió.
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: true, diferencia: 0, esperado: 1000 })).toBe('sin_base');
    // `[CG.195]` Y `sin_contar`/`sin_base` ganan TAMBIÉN sobre el esperado imposible: son hechos
    // más específicos. Un corte que nadie contó no se describe por la forma de su esperado.
    expect(veredictoDe({ huboConteo: false, fondoSinMedir: false, diferencia: 0, esperado: -500 })).toBe('sin_contar');
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: true, diferencia: 0, esperado: -500 })).toBe('sin_base');
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
      expect(veredictoDe({ huboConteo, fondoSinMedir: c.fondoInicial == null, diferencia: t.diferencia, esperado: t.esperado }))
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

/**
 * ⭐⭐ `[CG.195]` **Un cajón no debe dinero: el esperado negativo se DECLARA, no se publica.**
 *
 * Medido en prod el 2026-10-20 (`system_identifier` 7688376744939610156), sobre los 7 cortes que
 * existen en la vida del módulo:
 *
 *     folio            esperado        contado      diferencia     lo que PUBLICABA
 *     CC-2026-00001    3,402.45       3,653.50        +251.05      sobra   ← creíble
 *     CC-2026-00002  -149,915.32     57,571.00    +207,486.32      sobra   ← imposible
 *     CC-2026-00004   -68,199.86     11,820.00     +80,019.86      sobra   ← imposible
 *     CC-2026-00005   -62,631.80     32,198.50     +94,830.30      sobra   ← imposible
 *     CC-2026-00006   -81,227.27        618.50     +81,845.77      sobra   ← imposible
 *
 * **4 de 7 cortes afirmaban «sobra efectivo» por decenas de miles de pesos** en una caja cuyo
 * conteo real iba de $618.50 a $88,272.50. Y no podía ser otra cosa: `contado` es una suma de
 * piezas, nunca negativa, así que contra un esperado bajo cero la diferencia es positiva SIEMPRE.
 * Cuanto más rota la cuenta, más grande el «sobrante» que la pantalla afirmaba.
 *
 * ⛔ **Esto NO arregla la causa**, y la distinción importa: el libro no tiene **una sola** fila
 * `tipo='deposito'` en toda su vida (0 de 250 movimientos), así que nada registra el efectivo que
 * sale del cajón hacia el banco y el esperado arrastra la entrada entera como si se hubiera
 * quedado adentro. Eso es una decisión de negocio pendiente. Lo que esta prueba fija es que
 * mientras tanto el número **no se publique como veredicto** (ADR-056).
 */
describe('[CG.195] el esperado imposible se declara', () => {
  it('⛔ PRUEBA NEGATIVA: con el esperado bajo cero NO se publica «sobra»', () => {
    // Los cuatro cortes reales de prod, al centavo. Sin la guarda, los cuatro devolvían 'sobra'.
    const reales = [
      { esperado: -149915.32, contado: 57571.00 },
      { esperado: -68199.86, contado: 11820.00 },
      { esperado: -62631.80, contado: 32198.50 },
      { esperado: -81227.27, contado: 618.50 },
    ];
    for (const r of reales) {
      const diferencia = Math.round((r.contado - r.esperado) * 100) / 100;
      // La diferencia es positiva en los cuatro: es justo lo que hacía que dijera «sobra».
      expect(diferencia).toBeGreaterThan(0);
      expect(veredictoDe({ huboConteo: true, fondoSinMedir: false, diferencia, esperado: r.esperado }))
        .toBe('esperado_imposible');
    }
  });

  it('el corte creíble sigue dando su veredicto de siempre', () => {
    // CC-2026-00001, el único con esperado plausible: la guarda no lo toca. Sin esta comprobación
    // «ningún corte dice sobra» se cumpliría también rompiéndolos todos.
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: false, diferencia: 251.05, esperado: 3402.45 }))
      .toBe('sobra');
  });

  it('el cero NO es imposible: una caja vacía es un hecho, no un error', () => {
    // `[CG.42]`/`[CGP-V.9]` ya pelearon esta distinción. `esperado: 0` significa «no debería quedar
    // nada», que es perfectamente posible; sólo el NEGATIVO es la cuenta imposible.
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: false, diferencia: 0, esperado: 0 })).toBe('cuadra');
    // Y con el esperado en cero el juicio sigue siendo el de siempre a los dos lados del centavo:
    // dentro de la tolerancia cuadra, fuera FALTA. Que la guarda nueva no se coma esa distinción
    // es justo lo que se está comprobando.
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: false, diferencia: -0.004, esperado: 0 })).toBe('cuadra');
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: false, diferencia: -0.02, esperado: 0 })).toBe('falta');
  });

  it('`esperado` nulo no se declara imposible: eso ya lo dice `sin_medir`', () => {
    // El servicio devuelve 'sin_medir' antes de llegar acá cuando el esperado no quedó guardado.
    // Si esta rama lo tratara como imposible, dos ausencias distintas se verían igual.
    expect(veredictoDe({ huboConteo: true, fondoSinMedir: false, diferencia: 100, esperado: null })).toBe('sobra');
  });

  it('es una AUSENCIA de respuesta, no un faltante ni un sobrante', () => {
    expect(VEREDICTOS_SIN_RESPUESTA).toContain('esperado_imposible');
    expect(veredictoConcluyente('esperado_imposible')).toBe(false);
  });

  it('`calcularCorte` tampoco puede divergir: lo declara de punta a punta', () => {
    // Un gasto que supera al fondo más los ingresos deja el esperado bajo cero sin inventar nada.
    const t = calcularCorte({
      fondoInicial: 1000,
      movimientos: [
        { tipo: 'ingreso', monto: 500 },
        { tipo: 'gasto', monto: 9000 },
      ],
      conteo: [{ denominacion: 500, piezas: 1 }],
      morralla: 0,
    });
    expect(t.esperado).toBe(-7500);
    expect(t.contado).toBe(500);
    expect(t.diferencia).toBe(8000);
    expect(t.veredicto).toBe('esperado_imposible');
  });
});
