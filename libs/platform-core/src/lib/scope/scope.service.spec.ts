/**
 * `[COT.20]` — Una regla de usuario CON ÁREA le gana al god-mode, sólo en esa área.
 *
 * Caso real (prod, 2026-10-30): los jefes de zona tienen `superadmin` como rol principal y
 * cotizaban en las 8 sucursales; deben cotizar sólo en las de su zona (área `televenta`).
 */
// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver [CG.38.1]).
import { ScopeService } from './scope.service';

type Fila = Record<string, any>;

/** Un knex falso: filtra por igualdad (`where`) y por lista (`whereIn`); el resto se encadena. */
function fakeKnex(tablas: Record<string, Fila[]>) {
  return (tabla: string) => {
    const filtros: Array<(f: Fila) => boolean> = [];
    const builder: any = {
      where: (o: Fila) => {
        filtros.push((f) => Object.entries(o).every(([k, v]) => f[k] === v));
        return builder;
      },
      whereIn: (col: string, vals: unknown[]) => {
        filtros.push((f) => vals.includes(f[col]));
        return builder;
      },
      whereRaw: (_sql: string, [rol]: string[]) => {
        filtros.push((f) => String(f.role_name).toLowerCase() === rol);
        return builder;
      },
      select: () => builder,
      first: async () => filas()[0],
      then: (ok: (v: Fila[]) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(filas()).then(ok, ko),
    };
    const filas = () => (tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f)));
    return builder;
  };
}

const T = 't';
const regla = (o: Fila) => ({ tenant_id: T, dimension: 'warehouse', mode_write: null, nota: null, ...o });

function servicio(tablas: Record<string, Fila[]>) {
  return new ScopeService(fakeKnex(tablas) as any, { get: () => null } as any);
}

describe('[COT.20] ScopeService.forUser — god-mode y reglas de usuario por área', () => {
  const jefeZona = {
    'identity.users': [{ tenant_id: T, id: 'ivette', role_name: 'superadmin', warehouse_code: '01' }],
    'identity.user_scopes': [
      regla({ user_id: 'ivette', area: '*', mode: 'listed', values: ['01', '02', '03', '04'] }),
      regla({ user_id: 'ivette', area: 'televenta', mode: 'listed', values: ['01', '02', '03', '04'] }),
    ],
  };

  it('un superadmin con regla en el área queda limitado a esas sucursales EN esa área', async () => {
    const s = await servicio(jefeZona).forUser(T, 'ivette', 'superadmin', 'televenta');
    expect(s.dims.warehouse).toMatchObject({ mode: 'listed', modeWrite: 'listed', valuesWrite: ['01', '02', '03', '04'], source: 'user' });
    expect(s.dims.zone.mode).toBe('all'); // las otras dimensiones siguen en god-mode
  });

  it('su regla `*` NO lo limita: en otras áreas sigue viendo todo', async () => {
    const s = await servicio(jefeZona).forUser(T, 'ivette', 'superadmin', 'compras');
    expect(s.dims.warehouse).toMatchObject({ mode: 'all', modeWrite: 'all', source: 'platform_admin' });
    const sinArea = await servicio(jefeZona).forUser(T, 'ivette', 'superadmin');
    expect(sinArea.dims.warehouse.source).toBe('platform_admin');
  });

  it('un superadmin sin regla en el área sigue en god-mode (superoot)', async () => {
    const s = await servicio({ 'identity.users': [{ tenant_id: T, id: 'root', role_name: 'superadmin' }] }).forUser(
      T, 'root', 'superadmin', 'televenta',
    );
    expect(s.dims.warehouse).toMatchObject({ mode: 'all', modeWrite: 'all', source: 'platform_admin' });
  });

  it('direccion: la regla de rol en televenta le da escritura aunque `*` diga none', async () => {
    const s = await servicio({
      'identity.users': [{ tenant_id: T, id: 'su', role_name: 'direccion' }],
      'identity.role_scopes': [
        regla({ role_name: 'direccion', area: '*', mode: 'all', mode_write: 'none', values: null }),
        regla({ role_name: 'direccion', area: 'televenta', mode: 'all', mode_write: 'all', values: null }),
      ],
    }).forUser(T, 'su', 'direccion', 'televenta');
    expect(s.dims.warehouse).toMatchObject({ mode: 'all', modeWrite: 'all', source: 'role' });
  });

  it('prueba negativa: sin la regla de televenta, direccion no escribe en ninguna (el bug)', async () => {
    const s = await servicio({
      'identity.users': [{ tenant_id: T, id: 'su', role_name: 'direccion' }],
      'identity.role_scopes': [regla({ role_name: 'direccion', area: '*', mode: 'all', mode_write: 'none', values: null })],
    }).forUser(T, 'su', 'direccion', 'televenta');
    expect(s.dims.warehouse.modeWrite).toBe('none');
  });
});
