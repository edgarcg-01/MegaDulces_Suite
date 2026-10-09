import { BudgetSalesPlanService } from './budget-sales-plan.service';

/**
 * `[PVI.11]` — **Un ejercicio de PRUEBA no publica metas a la operación.**
 *
 * `commercial.sales_targets` alimenta el «vs objetivo» del sub-módulo Análisis, que es con lo que
 * se mide a un vendedor. `projectToSalesTargets` no preguntaba nada, y el **autopilot la llama por
 * CADA ejercicio abierto** — su filtro mira `status`, nunca `is_test`. O sea que el ejercicio
 * marcado de prueba se proyectaba todas las noches junto con los reales.
 *
 * ⚠️ **Por qué nadie lo vio, y por qué el candado hace falta igual.** Medido en prod el 2026-10-09:
 * el ejercicio `is_test` es una copia **byte a byte** del real —los dos FY2027, 429 renglones,
 * $604,775,116 cada uno— y el upsert va por `(scope, scope_key, year_month)`: escribía los mismos
 * números encima de los mismos números. El total publicado cuadra **al peso** con los dos
 * ejercicios reales ($806,217,119 + $604,775,116 = $1,410,992,235), así que **todo se veía bien**.
 * Cuadraba por CASUALIDAD, no por diseño: el día que alguien toque una cifra en la copia de prueba,
 * esa cifra aterriza en la meta de un vendedor — y `sales_targets` **no tiene `budget_id`**, así que
 * nada registraría de dónde salió.
 *
 * ⛔ Lo que se prueba NO es el SQL: un doble de knex no ejecuta SQL y creerle sería el defecto que
 * esta suite ya pagó. Se prueba **la rama**, y por la vía más dura disponible — que con `is_test`
 * la función **nunca llega a tocar `budget.sales_plan_lines`**. Si alguien quita el freno, la tabla
 * se consulta y esto se pone rojo.
 */

interface Tocada { tabla: string }

/** Doble mínimo de `trx`: registra qué tablas se consultaron y devuelve el ejercicio pedido. */
function hacerTrx(budget: Record<string, unknown>, tocadas: Tocada[]) {
  const trx = (tabla: string) => {
    tocadas.push({ tabla });
    const chain = {
      where: () => chain,
      select: async () => [],
      first: async () => (tabla === 'budget.budgets' ? budget : undefined),
    };
    return chain;
  };
  return trx;
}

function hacerServicio(budget: Record<string, unknown>, tocadas: Tocada[]): BudgetSalesPlanService {
  const tk = { run: (cb: (trx: unknown) => Promise<unknown>) => cb(hacerTrx(budget, tocadas)) };
  const tenantCtx = { requireTenantId: () => 'T-1' };
  return new BudgetSalesPlanService(tk as never, tenantCtx as never, {} as never);
}

describe('[PVI.11] un ejercicio de prueba no proyecta al «vs objetivo»', () => {
  it('⛔ con is_test=true devuelve la nota y NO consulta el plan de ventas', async () => {
    const tocadas: Tocada[] = [];
    const svc = hacerServicio({ id: 'b-test', fiscal_year: 2027, is_test: true }, tocadas);

    const r = await svc.projectToSalesTargets('b-test', 'alguien') as { note?: string; projected?: number };

    expect(r.note).toBe('ejercicio de prueba');
    expect(r.projected).toBe(0);
    // ⭐ La aserción con dientes: se cortó ANTES de leer el plan.
    expect(tocadas.map((t) => t.tabla)).toEqual(['budget.budgets']);
    expect(tocadas.some((t) => t.tabla === 'budget.sales_plan_lines')).toBe(false);
  });

  it('⭐ PRUEBA NEGATIVA: con is_test=false SÍ sigue y consulta el plan', async () => {
    const tocadas: Tocada[] = [];
    const svc = hacerServicio({ id: 'b-real', fiscal_year: 2027, is_test: false }, tocadas);

    const r = await svc.projectToSalesTargets('b-real', 'alguien') as { note?: string };

    // El doble devuelve un plan vacío, así que se detiene en el siguiente freno — pero YA leyó el
    // plan, que es lo que distingue "no proyecta porque es prueba" de "no proyecta porque no hay".
    expect(r.note).toBe('plan vacío');
    expect(tocadas.some((t) => t.tabla === 'budget.sales_plan_lines')).toBe(true);
  });

  it('un ejercicio sin la columna poblada (NULL) NO se trata como prueba', async () => {
    const tocadas: Tocada[] = [];
    const svc = hacerServicio({ id: 'b-viejo', fiscal_year: 2026, is_test: null }, tocadas);

    const r = await svc.projectToSalesTargets('b-viejo', 'alguien') as { note?: string };

    // `=== true` y no un truthy: un NULL es "no se marcó", no "es de prueba". Tratarlo como prueba
    // dejaría de publicar metas reales en silencio, que es el daño simétrico.
    expect(r.note).toBe('plan vacío');
    expect(tocadas.some((t) => t.tabla === 'budget.sales_plan_lines')).toBe(true);
  });
});
