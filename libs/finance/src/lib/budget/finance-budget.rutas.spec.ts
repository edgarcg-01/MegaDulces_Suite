import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { FinanceBudgetModule } from './finance-budget.module';
import { BudgetLinesController } from './budget-lines.controller';
import { BudgetComparisonController } from './budget-comparison.controller';

/**
 * `[PU.15]` **Ninguna ruta fija del presupuesto queda tapada por una con `:param`.**
 *
 * Express prueba las rutas en el orden en que se registran, y Nest las registra en el orden de
 * `controllers: [...]` del módulo y, dentro de cada controlador, en el orden de los métodos.
 * `GET budgets/direccion` (`BudgetComparisonController`) se registraba DESPUÉS de
 * `GET budgets/:id` (`BudgetLinesController`), así que la petición entraba como
 * `getBudget('direccion')` → Postgres `invalid input syntax for type uuid: "direccion"` → 500.
 * La vista Dirección de `/presupuesto` mostró «Internal server error» desde que nació (`[TES.21]`).
 *
 * ⭐ Se lee la metadata real que escriben `@Controller`/`@Get`, no el texto del archivo: lo que
 * decide a qué handler llega la petición es esa metadata y ese orden.
 *
 * Prueba negativa (regla 12): con el orden viejo de `controllers`, el primer caso se pone rojo
 * y nombra `GET finance/budget/budgets/direccion` tapada por `GET finance/budget/budgets/:id`.
 */

type Ruta = { metodo: string; path: string; handler: string };

const segmentos = (p: string) => p.split('/').filter(Boolean);
const unir = (...partes: string[]) => segmentos(partes.join('/')).join('/');

function rutasEnOrden(controllers: Array<new (...a: never[]) => unknown>): Ruta[] {
  const out: Ruta[] = [];
  for (const ctrl of controllers) {
    const prefijo = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const nombre of Object.getOwnPropertyNames(proto)) {
      if (nombre === 'constructor') continue;
      const fn = proto[nombre];
      if (typeof fn !== 'function') continue;
      const p = Reflect.getMetadata(PATH_METADATA, fn);
      const m = Reflect.getMetadata(METHOD_METADATA, fn);
      if (p === undefined || m === undefined) continue;
      for (const sub of Array.isArray(p) ? p : [p]) {
        out.push({ metodo: RequestMethod[m as number], path: unir(prefijo, String(sub)), handler: `${ctrl.name}.${nombre}` });
      }
    }
  }
  return out;
}

/** ¿La ruta `antes` (registrada primero) se queda con las peticiones dirigidas a `despues`? */
function tapa(antes: Ruta, despues: Ruta): boolean {
  if (antes.metodo !== despues.metodo) return false;
  const a = segmentos(antes.path);
  const d = segmentos(despues.path);
  if (a.length !== d.length) return false;
  let hayParamContraFijo = false;
  for (let i = 0; i < a.length; i++) {
    const aParam = a[i].startsWith(':');
    const dParam = d[i].startsWith(':');
    if (aParam) { if (!dParam) hayParamContraFijo = true; continue; }
    if (dParam || a[i] !== d[i]) return false;
  }
  return hayParamContraFijo;
}

function tapadas(rutas: Ruta[]): string[] {
  const hallazgos: string[] = [];
  rutas.forEach((d, j) => {
    for (let i = 0; i < j; i++) {
      if (tapa(rutas[i], d)) {
        hallazgos.push(`${d.metodo} ${d.path} (${d.handler}) tapada por ${rutas[i].metodo} ${rutas[i].path} (${rutas[i].handler})`);
        break;
      }
    }
  });
  return hallazgos;
}

const controllersDelModulo = () =>
  (Reflect.getMetadata('controllers', FinanceBudgetModule) ?? []) as Array<new (...a: never[]) => unknown>;

describe('[PU.15] las rutas del presupuesto llegan a su handler', () => {
  it('⭐ ninguna ruta fija queda detrás de una con :param, en el orden real del módulo', () => {
    expect(tapadas(rutasEnOrden(controllersDelModulo()))).toEqual([]);
  });

  it('⭐ GET budgets/direccion se registra antes que GET budgets/:id', () => {
    const rutas = rutasEnOrden(controllersDelModulo());
    const iDir = rutas.findIndex((r) => r.metodo === 'GET' && r.path === 'finance/budget/budgets/direccion');
    const iId = rutas.findIndex((r) => r.metodo === 'GET' && r.path === 'finance/budget/budgets/:id');
    expect(iDir).toBeGreaterThanOrEqual(0);
    expect(iId).toBeGreaterThanOrEqual(0);
    expect(iDir).toBeLessThan(iId);
  });

  it('⛔ el detector SÍ ve el defecto con el orden viejo (prueba negativa que vive en la suite)', () => {
    const viejo = rutasEnOrden([BudgetLinesController, BudgetComparisonController]);
    expect(tapadas(viejo)).toContain(
      'GET finance/budget/budgets/direccion (BudgetComparisonController.direccion) tapada por GET finance/budget/budgets/:id (BudgetLinesController.getBudget)',
    );
  });
});
