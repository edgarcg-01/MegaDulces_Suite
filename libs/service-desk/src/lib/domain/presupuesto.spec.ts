/**
 * `[MSP.1]` Reglas de un área como Presupuestos y Requerimientos: quién levanta, descripción, dictamen, orden de servicio y la
 * resolución del padre. Cada negativa con su control.
 */
import type { SdStatus } from '@megadulces/contracts';
import {
  colaSeOfrece,
  exigeDictamenParaResolver,
  mensajeQuienLevanta,
  notaResolucionPorOrdenes,
  puedeLevantarEnCola,
  resolverPadrePorOrdenes,
  validarDescripcion,
  validarDictamen,
  validarOrdenDeServicio,
  type EntradaDictamen,
  type EntradaOrden,
} from './presupuesto';

const PUESTOS = ['encargado_sucursal', 'auxiliar_encargado', 'jefe_zona'];

describe('[MSP.1.1] quién levanta', () => {
  it('⭐ los tres puestos de D1 sí; cualquier otro no', () => {
    for (const p of PUESTOS) expect(puedeLevantarEnCola(p, PUESTOS)).toBe(true);
    for (const p of ['cajera', 'vendedor_ruta', 'auxiliar_rh', 'sistemas', 'direccion']) expect(puedeLevantarEnCola(p, PUESTOS)).toBe(false);
  });
  it('⭐ sin puesto en la ficha NO pasa (no se adivina)', () => {
    expect(puedeLevantarEnCola(null, PUESTOS)).toBe(false);
    expect(puedeLevantarEnCola('', PUESTOS)).toBe(false);
  });
  it('CONTROL: una cola sin lista la levanta cualquiera (TI, Mantenimiento: lo de siempre)', () => {
    expect(puedeLevantarEnCola('cajera', null)).toBe(true);
    expect(puedeLevantarEnCola(null, undefined)).toBe(true);
  });
  it('la cola se ofrece a quien puede levantar y a sus miembros; a nadie más', () => {
    expect(colaSeOfrece('encargado_sucursal', PUESTOS, false)).toBe(true);
    expect(colaSeOfrece('presupuestos_compras_corp', PUESTOS, true)).toBe(true);
    expect(colaSeOfrece('cajera', PUESTOS, false)).toBe(false);
  });
  it('el 403 dice quién SÍ puede', () => {
    expect(mensajeQuienLevanta(['Encargado(a) de Sucursal', 'Gerencia de Zona'])).toContain('Encargado(a) de Sucursal, Gerencia de Zona');
  });
});

describe('[MSP.1.2] descripción obligatoria', () => {
  it('⭐ vacía o en blanco → 400 cuando la cola la exige', () => {
    expect(validarDescripcion(true, '')?.http).toBe(400);
    expect(validarDescripcion(true, '   ')?.http).toBe(400);
  });
  it('CONTROL: con texto pasa; y una cola que no la exige no pide nada', () => {
    expect(validarDescripcion(true, 'Se rompió la cortina')).toBeNull();
    expect(validarDescripcion(false, '')).toBeNull();
  });
});

describe('[MSP.1.3] el dictamen', () => {
  const base: EntradaDictamen = { colaExige: true, coordina: true, status: 'asignado', decision: 'autorizado', nota: 'Hay presupuesto en el rubro', previo: null, ordenes: 0 };
  it('CONTROL: la coordinación autoriza o no autoriza con motivo', () => {
    expect(validarDictamen(base)).toBeNull();
    expect(validarDictamen({ ...base, decision: 'no_autorizado' })).toBeNull();
    expect(validarDictamen({ ...base, status: 'nuevo' })).toBeNull();
    expect(validarDictamen({ ...base, status: 'en_espera' })).toBeNull();
  });
  it('⭐ sólo la coordinación de ESA área (403)', () => {
    expect(validarDictamen({ ...base, coordina: false })?.http).toBe(403);
  });
  it('⭐ un área que no usa dictamen lo rechaza (409)', () => {
    expect(validarDictamen({ ...base, colaExige: false })?.http).toBe(409);
  });
  it('⭐ valor inventado o sin motivo → 400', () => {
    expect(validarDictamen({ ...base, decision: 'quizas' })?.http).toBe(400);
    expect(validarDictamen({ ...base, decision: undefined })?.http).toBe(400);
    expect(validarDictamen({ ...base, nota: '  ' })?.http).toBe(400);
  });
  it('⭐ ya resuelta, cerrada o cancelada → 409', () => {
    for (const s of ['resuelto', 'cerrado', 'cancelado'] as SdStatus[]) expect(validarDictamen({ ...base, status: s })?.http).toBe(409);
  });
  it('⭐ con una orden en marcha el dictamen ya no se cambia', () => {
    expect(validarDictamen({ ...base, ordenes: 1 })?.http).toBe(409);
  });
  it('repetir EXACTAMENTE el mismo dictamen es 409; corregir el motivo o la decisión pasa', () => {
    const previo = { decision: 'autorizado' as const, nota: 'Hay presupuesto en el rubro' };
    expect(validarDictamen({ ...base, previo })?.http).toBe(409);
    expect(validarDictamen({ ...base, previo, nota: 'Hay presupuesto en el rubro 6100' })).toBeNull();
    expect(validarDictamen({ ...base, previo, decision: 'no_autorizado' })).toBeNull();
  });
});

describe('[MSP.1.4] resolver exige dictamen', () => {
  it('⭐ sin dictamen en una cola que lo exige → mensaje', () => {
    expect(exigeDictamenParaResolver(true, null)).toMatch(/dictamen/);
  });
  it('CONTROL: con dictamen, o en una cola que no lo exige, no frena', () => {
    expect(exigeDictamenParaResolver(true, 'no_autorizado')).toBeNull();
    expect(exigeDictamenParaResolver(true, 'autorizado')).toBeNull();
    expect(exigeDictamenParaResolver(false, null)).toBeNull();
  });
});

describe('[MSP.1.5] la orden de servicio', () => {
  const base: EntradaOrden = {
    coordina: true,
    destinosPermitidos: ['mantenimiento', 'ti'],
    colaExigeDictamen: true,
    decision: 'autorizado',
    padreStatus: 'en_proceso',
    padreEsOrden: false,
    destinoCode: 'mantenimiento',
    destinoConfidencial: false,
    categoriaEsDelDestino: true,
    miembrosDestino: 1,
    instrucciones: 'Cambiar la cortina de la entrada',
  };
  it('CONTROL: autorizada, tomada y con destino válido → pasa (a Mantenimiento y a TI)', () => {
    expect(validarOrdenDeServicio(base)).toBeNull();
    expect(validarOrdenDeServicio({ ...base, destinoCode: 'ti' })).toBeNull();
    expect(validarOrdenDeServicio({ ...base, padreStatus: 'en_espera' })).toBeNull();
    expect(validarOrdenDeServicio({ ...base, padreStatus: 'asignado' })).toBeNull();
  });
  it('⭐ sólo la coordinación (403)', () => {
    expect(validarOrdenDeServicio({ ...base, coordina: false })?.http).toBe(403);
  });
  it('⭐ NO autorizada o sin dictamen → 409, con mensajes distintos', () => {
    const no = validarOrdenDeServicio({ ...base, decision: 'no_autorizado' });
    const sin = validarOrdenDeServicio({ ...base, decision: null });
    expect(no?.http).toBe(409);
    expect(sin?.http).toBe(409);
    expect(no?.mensaje).not.toBe(sin?.mensaje);
  });
  it('CONTROL: en un área que no exige dictamen, no hace falta', () => {
    expect(validarOrdenDeServicio({ ...base, colaExigeDictamen: false, decision: null })).toBeNull();
  });
  it('⭐ un área sin destinos no genera órdenes', () => {
    expect(validarOrdenDeServicio({ ...base, destinosPermitidos: null })?.http).toBe(409);
    expect(validarOrdenDeServicio({ ...base, destinosPermitidos: [] })?.http).toBe(409);
  });
  it('⭐ un destino fuera de la lista, inexistente o apagado → 400', () => {
    expect(validarOrdenDeServicio({ ...base, destinoCode: 'compras' })?.http).toBe(400);
    expect(validarOrdenDeServicio({ ...base, destinoCode: null })?.http).toBe(400);
  });
  it('⭐ el padre debe estar tomado y vivo', () => {
    expect(validarOrdenDeServicio({ ...base, padreStatus: 'nuevo' })?.mensaje).toMatch(/Toma/);
    for (const s of ['resuelto', 'cerrado', 'cancelado'] as SdStatus[]) expect(validarOrdenDeServicio({ ...base, padreStatus: s })?.http).toBe(409);
  });
  it('⭐ sin instrucciones, a un área confidencial, con categoría ajena o sin quien atienda → rechazo', () => {
    expect(validarOrdenDeServicio({ ...base, instrucciones: ' ' })?.http).toBe(400);
    expect(validarOrdenDeServicio({ ...base, destinoConfidencial: true })?.http).toBe(409);
    expect(validarOrdenDeServicio({ ...base, categoriaEsDelDestino: false })?.http).toBe(400);
    expect(validarOrdenDeServicio({ ...base, miembrosDestino: 0 })?.http).toBe(409);
  });
  it('⭐ una orden no genera otra orden (un solo nivel)', () => {
    expect(validarOrdenDeServicio({ ...base, padreEsOrden: true })?.http).toBe(409);
  });
});

describe('[MSP.1.6] el padre se resuelve con sus órdenes', () => {
  const base = { padreStatus: 'en_espera' as SdStatus, colaExigeDictamen: true, decision: 'autorizado' as const };
  it('⭐ con la única orden resuelta → se resuelve', () => {
    expect(resolverPadrePorOrdenes({ ...base, ordenes: ['resuelto'] })).toBe(true);
    expect(resolverPadrePorOrdenes({ ...base, ordenes: ['cerrado', 'resuelto'] })).toBe(true);
  });
  it('⭐ con una orden todavía abierta → NO', () => {
    for (const abierta of ['nuevo', 'asignado', 'en_proceso', 'en_espera'] as SdStatus[]) {
      expect(resolverPadrePorOrdenes({ ...base, ordenes: ['resuelto', abierta] })).toBe(false);
    }
  });
  it('⭐ sólo canceladas → NO (nada se resolvió: decide la coordinación)', () => {
    expect(resolverPadrePorOrdenes({ ...base, ordenes: ['cancelado'] })).toBe(false);
    expect(resolverPadrePorOrdenes({ ...base, ordenes: [] })).toBe(false);
  });
  it('CONTROL: una cancelada junto a una resuelta → sí', () => {
    expect(resolverPadrePorOrdenes({ ...base, ordenes: ['cancelado', 'resuelto'] })).toBe(true);
  });
  it('⭐ un padre que ya no está en trabajo vivo, o sin dictamen autorizado, no se toca', () => {
    for (const s of ['nuevo', 'asignado', 'resuelto', 'cerrado', 'cancelado'] as SdStatus[]) {
      expect(resolverPadrePorOrdenes({ ...base, padreStatus: s, ordenes: ['resuelto'] })).toBe(false);
    }
    expect(resolverPadrePorOrdenes({ ...base, decision: null as never, ordenes: ['resuelto'] })).toBe(false);
    expect(resolverPadrePorOrdenes({ ...base, padreStatus: 'en_proceso', ordenes: ['resuelto'] })).toBe(true);
  });
  it('la nota dice qué orden lo resolvió y cómo (no las canceladas)', () => {
    const nota = notaResolucionPorOrdenes([
      { folio: 'SRV-2026-00010', area: 'Mantenimiento', status: 'resuelto', nota: 'Cortina cambiada' },
      { folio: 'SRV-2026-00011', area: 'TI (Sistemas)', status: 'cancelado', nota: null },
    ]);
    expect(nota).toContain('SRV-2026-00010 (Mantenimiento): Cortina cambiada');
    expect(nota).not.toContain('SRV-2026-00011');
  });
});
