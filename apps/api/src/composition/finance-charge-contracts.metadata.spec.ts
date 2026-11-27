import 'reflect-metadata';
import { FinancePaymentCalendarModule } from '@megadulces/finance';
import { Permission } from '@megadulces/platform-core';

/**
 * ⛔ `[PGP.213]` Regla 30 del protocolo de PR: un controlador NUEVO en el módulo del Calendario (`finance/charge-contracts`).
 * Se prueba por la metadata que Nest lee al arrancar —no por un regex sobre el texto (#414 tiró la API con el CI en
 * verde)—. Vive en `apps/api` porque aquí se compila con `decoratorMetadata`.
 *
 * Lo que fija: cada ruta, su método, que las que sólo leen o confirman contesten 200, y que TODO lo que escribe pida la
 * clave propia de Tesorería (`FINANCE_CHARGE_CONTRACTS_GESTIONAR`), no la de Pagos (que tienen también Marketing,
 * Compras, Crédito y Contabilidad).
 */
type Clase = { name: string; prototype: object };
const GET = 0, POST = 1, PATCH = 4; // RequestMethod de Nest
const VER = [Permission.FINANCE_PAYMENTS_VER];
const ESCRIBE = [Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR];

describe('[PGP.213] FinancePaymentCalendarModule: la API de contratos de cargos del banco arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', FinancePaymentCalendarModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', FinancePaymentCalendarModule) ?? []) as Clase[];
  const ctrl = controllers.find((c) => c?.name === 'ChargeContractsController');
  const metodo = (n: string) => (ctrl!.prototype as Record<string, unknown>)[n] as object;

  it('el módulo declara el controlador, su servicio y el oyente del banco', () => {
    expect(ctrl, 'el módulo no declara ChargeContractsController').toBeDefined();
    expect(Reflect.getMetadata('path', ctrl as object)).toBe('finance/charge-contracts');
    expect(providers.map((p) => p?.name)).toEqual(expect.arrayContaining(['ChargeContractsService', 'CargosDelBancoService']));
  });

  const RUTAS: [string, string, number, number | undefined, Permission[]][] = [
    ['listar', '/', GET, undefined, VER],
    ['sinContrato', 'sin-contrato', GET, undefined, VER],
    ['documento', ':id/documento', GET, undefined, VER],
    ['proponer', 'proponer', POST, 200, ESCRIBE],
    ['pasada', 'pasada', POST, 200, ESCRIBE],
    ['crear', '/', POST, undefined, ESCRIBE],
    ['editar', ':id', PATCH, undefined, ESCRIBE],
    ['confirmar', ':id/confirmar', POST, 200, ESCRIBE],
    ['terminar', ':id/terminar', POST, 200, ESCRIBE],
    ['rechazar', ':id/rechazar', POST, 200, ESCRIBE],
    ['subirDocumento', ':id/documento', POST, 200, ESCRIBE],
  ];

  it.each(RUTAS)('%s → %s, método %i, código %s, permiso', (nombre, ruta, verbo, codigo, permiso) => {
    const m = metodo(nombre);
    expect(typeof m, `falta el método ${nombre}`).toBe('function');
    expect(Reflect.getMetadata('path', m)).toBe(ruta);
    expect(Reflect.getMetadata('method', m)).toBe(verbo);
    expect(Reflect.getMetadata('__httpCode__', m)).toBe(codigo);
    expect(Reflect.getMetadata('permissions', m)).toEqual(permiso);
  });

  it('⛔ ninguna ruta que escribe pide la clave de Pagos (la tienen 10 roles)', () => {
    for (const [nombre, , verbo] of RUTAS) {
      if (verbo === GET) continue;
      expect(Reflect.getMetadata('permissions', metodo(nombre)), nombre).not.toContain(Permission.FINANCE_PAYMENTS_GESTIONAR);
    }
  });

  it('los parámetros son tipos que Nest resuelve sin inyectar nada (cuerpos = Object, ids = String)', () => {
    const tipos = (n: string) => Reflect.getMetadata('design:paramtypes', ctrl!.prototype, n) as unknown[] | undefined;
    expect(tipos('confirmar'), 'sin metadata esta prueba no mide nada').toEqual([String, Object, Object]);
    expect(tipos('crear')).toEqual([Object, Object]);
    expect(tipos('sinContrato')).toEqual([String, String, String]);
    expect(tipos('listar')).toEqual([]);
  });

  it('el constructor del controlador pide sólo su servicio; el del servicio, tres', () => {
    expect((ctrl as unknown as { length: number }).length).toBe(1);
    const svc = providers.find((p) => p?.name === 'ChargeContractsService') as unknown as { length: number };
    expect(svc.length).toBe(3);
  });
});
