import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { CajaCuentasKeplerComponent } from './caja-cuentas-kepler.component';
import { CashLedgerService, type CoberturaCuentasKepler } from '../../cash-ledger.service';

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar el botón. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

/**
 * `[CGA-A.19]` Cuentas de Kepler: la cifra que dice si el 100 % se cumple NO puede mentir.
 *
 * Las dos negativas que importan:
 *   · un universo TRUNCADO (la cola pasó el tope) no se pinta como «100 %» en verde aunque las
 *     filas medidas lo den — se declara parcial;
 *   · declarar exige motivo de 10+ caracteres Y un par elegido del catálogo: lo tecleado suelto en
 *     el buscador no es una cuenta.
 */
function cobertura(p: Partial<CoberturaCuentasKepler> = {}): CoberturaCuentasKepler {
  return {
    desde: '2026-10-01', hasta: '2026-10-23', universo: 619, truncado: false, tope: 3000,
    con_cuenta: { movimientos: 619, monto: 4_948_592.91 },
    falta_concepto: { movimientos: 0, monto: 0 },
    sin_cuenta: { movimientos: 0, monto: 0 },
    por_fuente: [
      { fuente: 'documento', movimientos: 590, monto: 4_800_000 },
      { fuente: 'tipo_documento', movimientos: 19, monto: 101_840.17 },
    ],
    sin_cuenta_por_entidad: [],
    datos_al: '2026-10-23T20:00:00Z', medido_ms: 420,
    ...p,
  };
}

function montar(c: CoberturaCuentasKepler) {
  const svc = {
    coberturaCuentasKepler: vi.fn(() => of(c)),
    declaradas: vi.fn(() => of([])),
    declararEntidad: vi.fn(() => of({})),
    quitarDeclarada: vi.fn(() => of({ quitada: true })),
    conceptos: vi.fn(() => of({ rows: [], limit: 30 })),
  };
  TestBed.configureTestingModule({
    imports: [CajaCuentasKeplerComponent],
    providers: [provideZonelessChangeDetection(), { provide: CashLedgerService, useValue: svc }],
  });
  const fx = TestBed.createComponent(CajaCuentasKeplerComponent);
  fx.componentRef.setInput('puedeDeclarar', true);
  fx.detectChanges();
  return { fx, cmp: fx.componentInstance, svc };
}

describe('CajaCuentasKeplerComponent · [CGA-A.19]', () => {
  it('619 de 619 con cuenta: 100 % en tono ok y medido', () => {
    const { cmp } = montar(cobertura());
    const k = cmp.kpis()[0];
    expect(k.value).toBe('100.0 %');
    expect(k.tone).toBe('ok');
    expect(k.state).toBe('medido');
  });

  it('⛔ [negativa] truncado: aunque las filas medidas den 100 %, NO es ok y se declara parcial', () => {
    const { cmp } = montar(cobertura({ truncado: true, universo: 3000, con_cuenta: { movimientos: 3000, monto: 1 } }));
    const k = cmp.kpis()[0];
    expect(k.tone).not.toBe('ok');
    expect(k.state).toBe('parcial');
  });

  it('con faltantes: el tono avisa y «Sin cuenta» cuenta los movimientos', () => {
    const { cmp } = montar(cobertura({
      con_cuenta: { movimientos: 600, monto: 1 },
      sin_cuenta: { movimientos: 19, monto: 26_919.95 },
      sin_cuenta_por_entidad: [{ entidad_code: 'GG022', beneficiario: 'CAJA CHICA MORELIA MADERO', tipo: 'gasto',
        doc_tipos: ['X-D-26'], movimientos: 19, monto: 26_919.95, motivo_texto: null, mas_viejo: '2026-10-22' }],
    }));
    expect(cmp.kpis()[0].tone).toBe('warn');
    expect(cmp.kpis()[2].value).toBe(19);
    expect(cmp.kpis()[2].tone).toBe('bad');
  });

  it('⛔ [negativa] no guarda sin motivo de 10+ caracteres ni sin un par del catálogo', () => {
    const { cmp, svc } = montar(cobertura());
    cmp.abrir('GG022', 'CAJA CHICA MORELIA MADERO');
    cmp.setForm({ motivo: 'corto' });
    cmp.guardar();
    expect(svc.declararEntidad).not.toHaveBeenCalled();

    cmp.setForm({ motivo: 'Es la caja chica de Morelia Madero' });
    cmp.guardar();
    // Sin elegir del catálogo, el motivo solo no alcanza.
    expect(svc.declararEntidad).not.toHaveBeenCalled();
    expect(cmp.formValido()).toBe(false);

    cmp.elegir({ value: { sucursal: '07', cuenta: '102', concepto: '037', concepto_nombre: 'CAJA CHICA', cuenta_mayor: '' } } as never);
    expect(cmp.formValido()).toBe(true);
    cmp.guardar();
    expect(svc.declararEntidad).toHaveBeenCalledWith(expect.objectContaining({
      entidad_code: 'GG022', kepler_cuenta: '102', kepler_concepto: '037', sucursal: '07',
    }));
  });
});
