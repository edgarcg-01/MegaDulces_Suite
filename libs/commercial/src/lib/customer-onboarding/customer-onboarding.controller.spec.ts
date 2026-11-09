import { Permission, PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from '@megadulces/platform-core';
import { CustomerOnboardingController } from './customer-onboarding.controller';

/**
 * `[ALC.0.6]` Quién entra a cada endpoint de alta de clientes.
 *
 * Decisión de Francisco (2026-11-06): las gestoras de Crédito y Cobranza **ven** las solicitudes.
 * Ver no es capturar: `COMMERCIAL_ALTA_CLIENTES_VER` abre las lecturas y ninguna escritura.
 *
 * ⚠️ Lo que se prueba es la metadata que lee `RolesGuard` (`@RequirePermissions` = todas,
 * `@RequireAnyPermission` = basta una), recorriendo TODOS los métodos del controlador: un endpoint
 * nuevo que se agregue sin llave, o con la de consulta, rompe esta prueba en vez de quedar abierto.
 */
type Metodo = keyof CustomerOnboardingController;
const proto = CustomerOnboardingController.prototype as unknown as Record<string, object>;
const metodos = Object.getOwnPropertyNames(CustomerOnboardingController.prototype)
  .filter((m) => m !== 'constructor' && m !== 'actor' && typeof proto[m] === 'function') as Metodo[];
const todas = (m: Metodo): string[] | undefined => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]);
const alguna = (m: Metodo): string[] | undefined => Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[m]);

/** La misma regla que `RolesGuard`: todas las de AND y al menos una de OR. */
function entra(m: Metodo, llaves: Permission[]): boolean {
  const and = todas(m) ?? [];
  const any = alguna(m) ?? [];
  return and.every((k) => llaves.includes(k as Permission)) && (!any.length || any.some((k) => llaves.includes(k as Permission)));
}
const alcanza = (llaves: Permission[]) => metodos.filter((m) => entra(m, llaves)).sort();

const LECTURAS = ['catalogs', 'constanciaUrl', 'inbox', 'one', 'planKepler'];

describe('[ALC.0.6] alta de clientes: cada endpoint pide su llave', () => {
  it('el recorrido mide algo: trece endpoints, y ninguno sin llave', () => {
    expect(metodos.sort()).toEqual(
      ['cancel', 'catalogs', 'constancia', 'constanciaUrl', 'create', 'credit', 'inbox', 'link', 'one', 'planKepler', 'postalCode', 'validate', 'writeKepler'],
    );
    for (const m of metodos) {
      expect((todas(m)?.length ?? 0) + (alguna(m)?.length ?? 0), `${m} no declara llave: quedaría abierto a cualquiera con sesión`).toBeGreaterThan(0);
    }
    // Ninguna llave a nivel clase que se sume en silencio.
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CustomerOnboardingController)).toBeUndefined();
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, CustomerOnboardingController)).toBeUndefined();
  });

  it('sólo consultar (`_VER`) abre las cinco lecturas (con el plan de Kepler) y ninguna escritura', () => {
    expect(alcanza([Permission.COMMERCIAL_ALTA_CLIENTES_VER])).toEqual(LECTURAS);
  });

  it('control: capturar (`ALTA_CLIENTES`) abre lecturas, captura (con el CP), liga y cancela; no decide crédito', () => {
    expect(alcanza([Permission.COMMERCIAL_ALTA_CLIENTES])).toEqual(
      ['cancel', 'catalogs', 'constancia', 'constanciaUrl', 'create', 'inbox', 'link', 'one', 'planKepler', 'postalCode', 'validate'],
    );
  });

  it('[ALC.2.8] escribir en Kepler pide SU llave: ni capturar, ni crédito, ni consultar la abren', () => {
    for (const llave of [Permission.COMMERCIAL_ALTA_CLIENTES, Permission.COMMERCIAL_ALTA_CLIENTES_CREDITO, Permission.COMMERCIAL_ALTA_CLIENTES_VER]) {
      expect(alcanza([llave])).not.toContain('writeKepler');
    }
    expect(alcanza([Permission.COMMERCIAL_ALTA_CLIENTES_KEPLER])).toEqual(['writeKepler']);
    expect(alcanza([Permission.COMMERCIAL_ALTA_CLIENTES_VER, Permission.COMMERCIAL_ALTA_CLIENTES_KEPLER])).toEqual([...LECTURAS, 'writeKepler'].sort());
  });

  it('control: decidir crédito (`_CREDITO`) abre lecturas y el crédito; no captura ni liga', () => {
    expect(alcanza([Permission.COMMERCIAL_ALTA_CLIENTES_CREDITO])).toEqual([...LECTURAS, 'credit'].sort());
  });

  it('sin ninguna de las cuatro no se entra a nada', () => {
    expect(alcanza([Permission.COMMERCIAL_CUSTOMERS_VER])).toEqual([]);
  });

  it('quien sólo consulta no aparece como aprobador de crédito en la bandeja', async () => {
    let actor: unknown;
    const ctl = Object.create(CustomerOnboardingController.prototype) as CustomerOnboardingController;
    Object.assign(ctl as object, {
      tenantCtx: { get: () => ({ userId: 'u1', roleName: 'credito_cobranza' }) },
      service: { bandeja: async (_q: unknown, a: unknown) => { actor = a; return null; } },
    });
    await ctl.inbox({}, { user: { permissions: { [Permission.COMMERCIAL_ALTA_CLIENTES_VER]: true }, roles_frescos: ['credito_cobranza'] } });
    expect(actor).toMatchObject({ userId: 'u1', puedeCredito: false, puedeKepler: false });
  });
});
