import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { DocumentoEnCaja } from '@megadulces/contracts';
import {
  MovimientoDocumentosComponent, documentoCompleto, documentoNuevo, documentosParaGuardar, totalDeDocumentos,
} from './movimiento-documentos.component';

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar el botón. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

/**
 * ⭐ `[CGS.60]` Con cheque o papel, en la captura de un movimiento. Edgar, 2026-10-30: «y si un
 * movimiento se quiere hacer con cheque, o papel (crédito)». Lo que importa: un cobro agrega cheques
 * o papeles; un pago elige cheques de la caja; nada de esto es efectivo y su total va al monto.
 */
const CHEQUE: DocumentoEnCaja = {
  pieza: 'p-1', tipo: 'cheque', clase: null, monto: 8000, banco: 'Banamex', numero: '0012345',
  de_quien: 'Abarrotes La Luz', concepto: null, fecha: null, visto_desde: '2026-10-30',
};

function montar(tipo: 'ingreso' | 'gasto', enCaja: DocumentoEnCaja[] | null = null) {
  TestBed.configureTestingModule({ imports: [MovimientoDocumentosComponent], providers: [provideZonelessChangeDetection()] });
  const fx = TestBed.createComponent(MovimientoDocumentosComponent);
  fx.componentRef.setInput('tipo', tipo);
  fx.componentRef.setInput('enCaja', enCaja);
  fx.detectChanges();
  return { fx, cmp: fx.componentInstance, el: fx.nativeElement as HTMLElement };
}

describe('MovimientoDocumentosComponent · [CGS.60]', () => {
  it('en un cobro ofrece agregar cheque y papel', () => {
    const cobro = montar('ingreso').el.textContent ?? '';
    expect(cobro).toContain('Agregar cheque');
    expect(cobro).toContain('Agregar papel (crédito)');
  });

  it('[negativa] en un pago ofrece elegir un cheque de la caja, y no agregar papel: con papel no se paga', () => {
    const pago = montar('gasto').el.textContent ?? '';
    expect(pago).toContain('Elegir cheque');
    expect(pago).not.toContain('Agregar papel');
  });

  it('agregar un cheque deja un renglón para teclear y avisa al padre', () => {
    const { cmp, fx } = montar('ingreso');
    let cambios = 0;
    cmp.cambio.subscribe(() => { cambios += 1; });
    cmp.agregar('cheque');
    fx.detectChanges();
    expect(cmp.entran()).toEqual([documentoNuevo('cheque')]);
    expect(cambios).toBe(1);
  });

  it('en un pago, elegir un cheque de la caja suma su importe; quitarlo lo resta', () => {
    const { cmp, fx, el } = montar('gasto', [CHEQUE]);
    fx.detectChanges();
    expect(el.textContent).toContain('Banamex 0012345 · Abarrotes La Luz');
    cmp.elegir('p-1', true);
    expect(cmp.total()).toBe(8000);
    cmp.elegir('p-1', false);
    expect(cmp.total()).toBe(0);
  });

  it('[negativa] sin cheques en la caja lo dice, en vez de una lista vacía', () => {
    const { el } = montar('gasto', []);
    expect(el.textContent).toContain('No hay cheques en la caja.');
  });
});

describe('documentos del movimiento · [CGS.60] las reglas que comparte con el servidor', () => {
  it('un cheque completo lleva banco, número, de quién e importe; un papel, quién debe, por qué e importe', () => {
    expect(documentoCompleto(documentoNuevo('cheque', { banco: 'BBVA', numero: '8', de_quien: 'Dulcería Mary', monto: 10 }))).toBe(true);
    expect(documentoCompleto(documentoNuevo('cheque', { banco: 'BBVA', numero: '', de_quien: 'Dulcería Mary', monto: 10 }))).toBe(false);
    expect(documentoCompleto(documentoNuevo('papel', { de_quien: 'Tienda Lupita', concepto: 'ruta 27', monto: 10 }))).toBe(true);
    expect(documentoCompleto(documentoNuevo('papel', { de_quien: 'Tienda Lupita', concepto: 'ruta 27', monto: 0 }))).toBe(false);
  });

  it('el total suma lo que entra y los cheques que salen, por su importe en la caja', () => {
    expect(totalDeDocumentos([documentoNuevo('papel', { monto: 1952 })], ['p-1'], [CHEQUE])).toBe(9952);
    expect(totalDeDocumentos([], ['no-existe'], [CHEQUE])).toBe(0);
  });

  it('lo que viaja: el cheque con banco y número, el papel con su porqué; todo en efectivo = null', () => {
    expect(documentosParaGuardar([], [])).toBeNull();
    expect(documentosParaGuardar(
      [documentoNuevo('cheque', { banco: ' BBVA ', numero: '8 ', de_quien: ' Dulcería Mary ', monto: 10 })], ['p-1'],
    )).toEqual({
      entran: [{ tipo: 'cheque', monto: 10, de_quien: 'Dulcería Mary', banco: 'BBVA', numero: '8' }],
      salen: [{ pieza: 'p-1' }],
    });
  });
});
