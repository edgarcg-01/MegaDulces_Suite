import 'reflect-metadata';
import { FinanceExpenseProofsModule } from '@megadulces/finance';

/**
 * ⛔ `[PGP.122]` S.13 — Regla 30 del protocolo de PR: lo que se rompe al agregar un controlador y un provider de Nest
 * es el ARRANQUE, y eso no lo ven ni `nx build` ni vitest (#414 tiró la API con el CI en verde). Se prueba por
 * `design:paramtypes`, que es lo que Nest lee al arrancar: la bandeja de facturas del SAT trae un controlador con
 * ruta propia y un servicio.
 */
type Clase = { name: string };

describe('[PGP.122] S.13 FinanceExpenseProofsModule: la bandeja de facturas del SAT arranca', () => {
  const providers = (Reflect.getMetadata('providers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const controllers = (Reflect.getMetadata('controllers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const servicio = () => providers.find((c) => c?.name === 'FacturasSatService');
  const ctrl = () => controllers.find((c) => c?.name === 'FacturasSatController');

  it('el módulo registra el controlador y el servicio', () => {
    expect(ctrl(), 'falta registrar FacturasSatController').toBeDefined();
    expect(servicio(), 'falta registrar FacturasSatService').toBeDefined();
  });

  it('el controlador recibe su servicio por CLASE, en su ruta propia', () => {
    expect(Reflect.getMetadata('design:paramtypes', ctrl()!)).toEqual([servicio()]);
    expect(Reflect.getMetadata('path', ctrl()!)).toBe('finance/expenses/solicitudes/facturas-sat');
  });

  it('el servicio recibe cada dependencia por su CLASE (el alcance por sucursal, ScopeService, también)', () => {
    const ts = Reflect.getMetadata('design:paramtypes', servicio()!) as Clase[] | undefined;
    expect(ts?.map((t) => t?.name)).toEqual(['TenantKnexService', 'TenantContextService', 'ScopeService']);
  });

  it('⛔ ningún parámetro de los métodos del controlador es un esquema Zod (es lo que tiró #414 al arrancar)', () => {
    const proto = (ctrl() as unknown as { prototype: object }).prototype;
    const metodos = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor');
    expect(metodos.length, 'el controlador sin métodos: la prueba no mide nada').toBe(5);
    for (const k of metodos) {
      const p = (Reflect.getMetadata('design:paramtypes', proto, k) ?? []) as unknown[];
      expect(p.length, `${k}: sin design:paramtypes la prueba no mide nada`).toBeGreaterThan(0);
      for (const t of p) expect(typeof t === 'function', `${k}: un parámetro no es una clase (${String((t as { name?: string })?.name ?? t)})`).toBe(true);
    }
  });
});
