import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Permission } from '@megadulces/platform-core';
import { actorDe } from './logistics-config.controller';
import { ActorTarifas, LogisticsConfigService } from './logistics-config.service';
import { cambiosDeConfig, cambiosDeRuta, configFijada, rutaFijada } from './tarifas-fijas.logic';

/**
 * `[EMB.28.1]` Tarifas fijas: capturar la primera vez es de quien configura; cambiar, borrar o
 * desactivar una tarifa ya fijada es de un autorizador, y todo queda en la historia.
 * Base de mentira que contesta por tabla; montos inventados.
 */

const RUTA = '11111111-1111-4111-8111-111111111111';
const CFG = '22222222-2222-4222-8222-222222222222';
const USUARIO = '33333333-3333-4333-8333-333333333333';
const CONFIGURA: ActorTarifas = { userId: USUARIO, username: 'configura', autorizador: false };
const AUTORIZA: ActorTarifas = { userId: USUARIO, username: 'autoriza', autorizador: true };

describe('regla del candado', () => {
  it('una ruta en cero todavía no está fijada; con cualquier comisión, sí', () => {
    expect(rutaFijada({ driver_commission: '0.00', helper_commission: '0.00' })).toBe(false);
    expect(rutaFijada({ driver_commission: '180.00', helper_commission: '0.00' })).toBe(true);
    expect(rutaFijada({ driver_commission: 0, helper_commission: 120 })).toBe(true);
  });

  it('sólo viáticos y maniobras pagan a una persona; un factor o un costo por km no se candadea', () => {
    expect(configFijada({ category: 'viatico', value: '100.0000' })).toBe(true);
    expect(configFijada({ category: 'tarifa_maniobra', value: 30 })).toBe(true);
    expect(configFijada({ category: 'viatico', value: 0 })).toBe(false);
    expect(configFijada({ category: 'costo_km', value: 8.5 })).toBe(false);
    expect(configFijada({ category: 'factor', value: 1.2 })).toBe(false);
  });

  it('el mismo monto escrito distinto («180.00» contra 180) no es un cambio', () => {
    expect(cambiosDeRuta({ driver_commission: '180.00', helper_commission: '120.00' }, { driver_commission: 180, helper_commission: 120 })).toEqual([]);
    expect(cambiosDeConfig({ value: '100.0000' }, { value: 100 })).toEqual([]);
  });

  it('renombrar una ruta tarifada cuenta: el nombre es lo que empareja con Kepler', () => {
    expect(cambiosDeRuta({ name: 'CANINDO ZAMORA' }, { name: 'ZAMORA' }).map((c) => c.field)).toEqual(['name']);
  });

  it('desactivar cuenta; notas y kilómetros no', () => {
    expect(cambiosDeRuta({ active: true }, { active: false }).map((c) => c.field)).toEqual(['active']);
    expect(cambiosDeRuta({ name: 'X', driver_commission: 180 }, { name: 'X', driver_commission: 180, active: true })).toEqual([]);
  });
});

function baseFalsa(tablas: Record<string, any>) {
  const updates: Array<{ tabla: string; patch: any }> = [];
  const historia: any[] = [];
  const borrados: string[] = [];
  const trx: any = (tabla: string) => {
    const b: any = {
      where: () => b, whereNull: () => b, whereNot: () => b, orderBy: () => b, limit: () => b,
      first: async () => tablas[tabla],
      update: (patch: any) => {
        updates.push({ tabla, patch });
        return { returning: async () => [{ ...tablas[tabla], ...patch }] };
      },
      insert: (filas: any) => {
        if (tabla === 'logistics.tariff_changes') { historia.push(...filas); return Promise.resolve([]); }
        return { returning: async () => [{ id: 'nuevo', ...filas }] };
      },
      del: async () => { borrados.push(tabla); return 1; },
    };
    return b;
  };
  trx.fn = { now: () => 'NOW()' };
  trx.raw = (sql: string) => ({ sql });
  const tk: any = { run: async (fn: (t: any) => any) => fn(trx) };
  return { svc: new LogisticsConfigService(tk), updates, historia, borrados };
}

const RUTA_FIJADA = { id: RUTA, name: 'CANINDO ZAMORA', driver_commission: '180.00', helper_commission: '120.00', active: true };
const RUTA_EN_CERO = { id: RUTA, name: 'LA PIEDAD', driver_commission: '0.00', helper_commission: '0.00', active: true };
const VIATICO = { id: CFG, key: 'viatico_comida', category: 'viatico', value: '100.0000', active: true };

describe('LogisticsConfigService — rutas', () => {
  it('PRUEBA NEGATIVA: sin ser autorizador no se cambia la comisión de una ruta fijada', async () => {
    const { svc, updates, historia } = baseFalsa({ 'logistics.routes': RUTA_FIJADA });
    await expect(svc.updateRoute(RUTA, { driver_commission: 200 }, CONFIGURA)).rejects.toBeInstanceOf(ForbiddenException);
    expect(updates).toHaveLength(0);
    expect(historia).toHaveLength(0);
  });

  it('el autorizador sí la cambia, y queda en la historia como autorizado', async () => {
    const { svc, updates, historia } = baseFalsa({ 'logistics.routes': RUTA_FIJADA });
    await svc.updateRoute(RUTA, { driver_commission: 200, helper_commission: 120 }, AUTORIZA);
    expect(updates).toHaveLength(1);
    expect(historia).toEqual([expect.objectContaining({
      entity: 'route', entity_id: RUTA, field: 'driver_commission', old_value: '180.00', new_value: '200.00',
      autorizado: true, changed_by: USUARIO, changed_by_username: 'autoriza',
    })]);
  });

  it('una ruta en cero la captura quien configura, sin autorizador, y queda la primera captura', async () => {
    const { svc, updates, historia } = baseFalsa({ 'logistics.routes': RUTA_EN_CERO });
    await svc.updateRoute(RUTA, { driver_commission: 90, helper_commission: 60 }, CONFIGURA);
    expect(updates).toHaveLength(1);
    expect(historia.map((h) => [h.field, h.old_value, h.new_value, h.autorizado])).toEqual([
      ['driver_commission', '0.00', '90.00', false],
      ['helper_commission', '0.00', '60.00', false],
    ]);
  });

  it('cambiar notas o kilómetros de una ruta fijada no necesita autorizador ni deja historia', async () => {
    const { svc, updates, historia } = baseFalsa({ 'logistics.routes': RUTA_FIJADA });
    await svc.updateRoute(RUTA, { notes: 'sale de Canindo', estimated_km: 40, driver_commission: 180, helper_commission: 120 }, CONFIGURA);
    expect(updates).toHaveLength(1);
    expect(historia).toHaveLength(0);
  });

  it('PRUEBA NEGATIVA: renombrar, desactivar o borrar una ruta fijada también exige autorizador', async () => {
    for (const intento of [
      (s: LogisticsConfigService) => s.updateRoute(RUTA, { name: 'ZAMORA' }, CONFIGURA),
      (s: LogisticsConfigService) => s.updateRoute(RUTA, { active: false }, CONFIGURA),
      (s: LogisticsConfigService) => s.deleteRoute(RUTA, CONFIGURA),
    ]) {
      const { svc, updates } = baseFalsa({ 'logistics.routes': RUTA_FIJADA });
      await expect(intento(svc)).rejects.toBeInstanceOf(ForbiddenException);
      expect(updates).toHaveLength(0);
    }
  });
});

describe('LogisticsConfigService — viáticos y maniobras', () => {
  it('PRUEBA NEGATIVA: sin autorizador no se cambia ni se BORRA un viático fijado (se borra de verdad)', async () => {
    const a = baseFalsa({ 'logistics.config_finance': VIATICO });
    await expect(a.svc.update(CFG, { value: 120 }, CONFIGURA)).rejects.toBeInstanceOf(ForbiddenException);
    const b = baseFalsa({ 'logistics.config_finance': VIATICO });
    await expect(b.svc.delete(CFG, CONFIGURA)).rejects.toBeInstanceOf(ForbiddenException);
    expect(b.borrados).toHaveLength(0);
  });

  it('el autorizador borra y queda el valor que tenía', async () => {
    const { svc, historia, borrados } = baseFalsa({ 'logistics.config_finance': VIATICO });
    await svc.delete(CFG, AUTORIZA);
    expect(borrados).toEqual(['logistics.config_finance']);
    expect(historia).toEqual([expect.objectContaining({ field: 'borrado', old_value: '100', new_value: null, autorizado: true })]);
  });

  it('un costo por km no está candadeado', async () => {
    const { svc, updates } = baseFalsa({ 'logistics.config_finance': { id: CFG, key: 'costo_km_f350', category: 'costo_km', value: '4.05', active: true } });
    await svc.update(CFG, { value: 4.2 }, CONFIGURA);
    expect(updates).toHaveLength(1);
  });
});

describe('actorDe — el autorizador sale de la sesión', () => {
  it('con el permiso o siendo administrador de plataforma es autorizador; con sólo configurar, no', () => {
    expect(actorDe({ user: { sub: USUARIO, username: 'a', role_name: 'direccion', permissions: { [Permission.LOGISTICS_TARIFAS_AUTORIZAR]: true } } }).autorizador).toBe(true);
    expect(actorDe({ user: { sub: USUARIO, username: 'b', role_name: 'superadmin', permissions: {} } }).autorizador).toBe(true);
    expect(actorDe({ user: { sub: USUARIO, username: 'c', role_name: 'finanzas', permissions: { [Permission.LOGISTICS_CONFIG_GESTIONAR]: true } } }).autorizador).toBe(false);
    expect(actorDe(undefined)).toEqual({ userId: null, username: null, autorizador: false });
  });
});

describe('LogisticsConfigController — quién entra a escribir', () => {
  it('las 6 rutas de escritura aceptan a quien configura O al autorizador (dirección no configura)', async () => {
    const { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } = await import('@megadulces/platform-core');
    const { LogisticsConfigController } = await import('./logistics-config.controller');
    const p = LogisticsConfigController.prototype as any;
    for (const m of ['create', 'update', 'remove', 'createRoute', 'updateRoute', 'deleteRoute']) {
      expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, p[m])).toEqual([Permission.LOGISTICS_CONFIG_GESTIONAR, Permission.LOGISTICS_TARIFAS_AUTORIZAR]);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, p[m])).toBeUndefined();
    }
  });
});

describe('[EMB.33] «sin comisión» también es una tarifa fijada', () => {
  const LOCAL = { id: RUTA, name: 'SANTA ANA PACUECO', driver_commission: '0.00', helper_commission: '0.00', active: true, sin_comision: true };

  it('una ruta local marcada cuenta como fijada', () => {
    expect(rutaFijada(LOCAL)).toBe(true);
    expect(cambiosDeRuta(LOCAL, { sin_comision: false }).map((c) => c.field)).toEqual(['sin_comision']);
  });

  it('PRUEBA NEGATIVA: quien configura no puede quitarle la marca ni ponerle comisión', async () => {
    for (const dto of [{ sin_comision: false }, { driver_commission: 50 }]) {
      const { svc, updates } = baseFalsa({ 'logistics.routes': LOCAL });
      await expect(svc.updateRoute(RUTA, dto, CONFIGURA)).rejects.toBeInstanceOf(ForbiddenException);
      expect(updates).toHaveLength(0);
    }
  });

  it('marcar una ruta en $0 como local lo puede quien configura, y queda en la historia', async () => {
    const { svc, historia } = baseFalsa({ 'logistics.routes': { ...LOCAL, sin_comision: false } });
    await svc.updateRoute(RUTA, { sin_comision: true }, CONFIGURA);
    expect(historia).toEqual([expect.objectContaining({ field: 'sin_comision', old_value: 'false', new_value: 'true', autorizado: false })]);
  });
});
