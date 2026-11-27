import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { ScopeDim } from '../../../core/services/data-scope.service';
import { ComprasEntradasComponent } from './compras-entradas.component';

/**
 * `[RE.89]` Medido en prod el 2026-11-26: `superuser` (rol principal `direccion`, «ve toda la red, no
 * escribe», `[ID.17]`) tocó «Dar por buena» dos veces; las dos fueron 403 de alcance y la pantalla dijo
 * «Error al validar», sin el motivo. Sin TestBed, como `compras-entradas.siguiente.spec.ts`.
 */
const dim = (o: Partial<ScopeDim>): ScopeDim => ({ mode: 'all', modeWrite: 'all', source: 'role', options: [], ...o });
const DIRECCION = dim({ modeWrite: 'none', valuesWrite: [] });
const TIENDA_06 = dim({ mode: 'own', modeWrite: 'own', valuesWrite: ['06'] });

function armar(alcance: ScopeDim | null, permiso = true) {
  const c = Object.create(ComprasEntradasComponent.prototype) as ComprasEntradasComponent & Record<string, unknown>;
  const avisos: Array<{ severity?: string; summary?: string; detail?: string }> = [];
  const llamadas = { validate: [] as Subject<unknown>[], reject: [] as Subject<unknown>[] };
  Object.assign(c, {
    canValidate: signal(permiso),
    alcanceSucursal: signal(alcance),
    actingId: signal(null), saving: signal(false), showReject: signal(false),
    rejectTarget: signal(null), rejectCodigo: signal(null), rejectError: signal(''), rejectMotivo: '',
    destroyRef: { onDestroy: () => () => undefined, destroyed: false },
    toast: { add: (m: { severity?: string; summary?: string; detail?: string }) => avisos.push(m) },
    svc: {
      validate: () => { const s = new Subject<unknown>(); llamadas.validate.push(s); return s; },
      reject: () => { const s = new Subject<unknown>(); llamadas.reject.push(s); return s; },
    },
    siguienteDe: () => null, seguirTrasDecidir: () => undefined, load: () => undefined,
  });
  return { c, avisos, llamadas };
}

const fila = (sucursal: string, o: Record<string, unknown> = {}) =>
  ({ sucursal, folio: '0000699', deposit_id: 'd-1', deposit_status: 'recibido', proveedor_code: 'P1', monto: 100, ...o }) as never;

describe('[RE.89] la pantalla no ofrece validar donde el servidor lo va a rechazar', () => {
  it('direccion: tiene el permiso y no escribe en ninguna sucursal — sin botón y lo dice', () => {
    const { c } = armar(DIRECCION);
    expect(c.puedeDecidirEn('08')).toBe(false);
    expect(c.soloConsultaEn('08')).toBe(true);
  });

  it('control: con escritura en todas se ofrece, y no hay aviso de consulta', () => {
    const { c } = armar(dim({ modeWrite: 'all' }));
    expect(c.puedeDecidirEn('08')).toBe(true);
    expect(c.soloConsultaEn('08')).toBe(false);
  });

  it('escribe sólo en su sucursal: en la suya sí, en otra no', () => {
    const { c } = armar(TIENDA_06);
    expect(c.puedeDecidirEn('06')).toBe(true);
    expect(c.puedeDecidirEn('08')).toBe(false);
  });

  it('sin el permiso no se ofrece ni se dice «sólo consulta» (no es su trabajo)', () => {
    const { c } = armar(dim({ modeWrite: 'all' }), false);
    expect(c.puedeDecidirEn('08')).toBe(false);
    expect(c.soloConsultaEn('08')).toBe(false);
  });

  it('si el alcance no contestó se ofrece como antes: decide el servidor', () => {
    const { c } = armar(null);
    expect(c.puedeDecidirEn('08')).toBe(true);
    expect(c.soloConsultaEn('08')).toBe(false);
  });

  it('el lote sólo cuenta lo que se puede aprobar', () => {
    const { c } = armar(TIENDA_06);
    expect(c.elegibleParaLote(fila('06'))).toBe(true);
    expect(c.elegibleParaLote(fila('08'))).toBe(false);
    expect(c.elegibleParaLote(fila('06', { deposit_status: 'validado' }))).toBe(false);
  });
});

describe('[RE.89] el aviso de error dice el motivo del servidor', () => {
  const MOTIVO = 'Tu alcance no incluye sucursal "08" para escritura.';

  it('validar: el 403 de alcance llega con su motivo', () => {
    const { c, avisos, llamadas } = armar(null);
    c.doValidate(fila('08'));
    llamadas.validate[0].error({ status: 403, error: { message: MOTIVO } });
    expect(avisos).toEqual([{ severity: 'error', summary: 'No se pudo validar', detail: MOTIVO }]);
    expect(c.actingId()).toBeNull();
  });

  it('devolver: igual', () => {
    const { c, avisos, llamadas } = armar(null);
    (c.rejectTarget as ReturnType<typeof signal>).set(fila('08'));
    (c.rejectCodigo as ReturnType<typeof signal>).set('ilegible');
    c.doReject();
    llamadas.reject[0].error({ status: 403, error: { message: MOTIVO } });
    expect(avisos).toEqual([{ severity: 'error', summary: 'No se pudo devolver', detail: MOTIVO }]);
    expect(c.saving()).toBe(false);
  });

  it('sin motivo (red caída) no queda vacío', () => {
    const { c, avisos, llamadas } = armar(null);
    c.doValidate(fila('08'));
    llamadas.validate[0].error({ status: 0 });
    expect(avisos[0].detail).toBe('Intenta de nuevo.');
  });
});
