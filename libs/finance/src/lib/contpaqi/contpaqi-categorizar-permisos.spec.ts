import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '@megadulces/platform-core';
import { ContpaqiBridgeController } from './contpaqi-bridge.controller';

/**
 * `[CB.70]` Quién entra a categorizar un egreso, con el guard de verdad (`RolesGuard` + `Reflector`) sobre los
 * métodos reales del controlador.
 *
 * Desde CB.70, `tesoreria` y `finanzas_operativo` categorizan desde Bancos con `FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR`
 * y SIN `_VER` (no ven el puente). La pieza lee las categorías y la vista previa: si esas dos lecturas siguieran
 * pidiendo `_VER`, el botón aparecería y el formulario daría 403. Lo que no debe cambiar: categorizar sigue
 * pidiendo `_CATEGORIZAR`, y el resto del puente sigue pidiendo `_VER`.
 */
const VER = 'FISCAL_CONTPAQI_BRIDGE_VER';
const CATEGORIZAR = 'FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR';

async function entra(metodo: keyof ContpaqiBridgeController, permisos: string[], rol = 'tesoreria'): Promise<boolean> {
  const mapa = Object.fromEntries(permisos.map((p) => [p, true]));
  const cache = { getPermissionsForUser: async () => mapa, getRolesForUser: async () => [rol] };
  const guard = new RolesGuard(new Reflector(), cache as never);
  const req = { user: { sub: 'u', tenant_id: 't', role_name: rol, username: 'prueba' } };
  const ctx = {
    getHandler: () => ContpaqiBridgeController.prototype[metodo],
    getClass: () => ContpaqiBridgeController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  };
  try { return await guard.canActivate(ctx as never); } catch (e) { if (e instanceof ForbiddenException) return false; throw e; }
}

describe('[CB.70] categorizar desde Bancos sin ver el puente', () => {
  it('sólo con _CATEGORIZAR (tesorería): lee categorías y vista previa, y categoriza', async () => {
    expect(await entra('categoriasEgreso', [CATEGORIZAR])).toBe(true);
    expect(await entra('vistaPreviaBeneficiario', [CATEGORIZAR])).toBe(true);
    expect(await entra('categorizar', [CATEGORIZAR])).toBe(true);
  });

  it('[negativa] sólo con _CATEGORIZAR NO ve el resto del puente', async () => {
    expect(await entra('lotes', [CATEGORIZAR])).toBe(false);
  });

  it('[negativa] sólo con _VER (dirección): lee, pero no categoriza', async () => {
    expect(await entra('categoriasEgreso', [VER], 'direccion')).toBe(true);
    expect(await entra('categorizar', [VER], 'direccion')).toBe(false);
  });

  it('[negativa] sin ninguno de los dos: ni lee', async () => {
    expect(await entra('categoriasEgreso', ['FINANCE_BANK_VER'])).toBe(false);
    expect(await entra('vistaPreviaBeneficiario', ['FINANCE_BANK_VER'])).toBe(false);
  });
});
