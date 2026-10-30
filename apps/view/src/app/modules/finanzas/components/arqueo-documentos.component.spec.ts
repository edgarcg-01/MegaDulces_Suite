import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { ApartadoEnCaja, DocumentoEnCaja } from '@megadulces/contracts';
import { ArqueoDocumentosComponent } from './arqueo-documentos.component';
import { desgloseRubro } from '../pages/caja-general/posicion-caja.util';

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar el botón. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

/**
 * ⭐ `[CGS.59]` Un apartado del arqueo, uno por uno. Edgar, 2026-10-30: «cuando hay un cheque,
 * crédito o papel… cómo agregar esos apartados». Las negativas que importan: un documento que había
 * no se va sin marcarse, uno que salió dice por qué, y sin tocar nada el apartado es «no se contó».
 */
const cheque = (p: Partial<DocumentoEnCaja> = {}): DocumentoEnCaja => ({
  pieza: 'p-1', tipo: 'cheque', clase: null, monto: 10121, banco: 'Banamex', numero: '0012345',
  de_quien: 'Abarrotes La Luz', concepto: null, fecha: null, visto_desde: '2026-10-23', ...p,
});
const apartado = (piezas: DocumentoEnCaja[] = [], sin_detalle: ApartadoEnCaja['sin_detalle'] = null): ApartadoEnCaja => ({
  desde: piezas.length ? { arqueo_id: 'a-1', at: '2026-10-23T18:00:00Z', quien: 'carmen' } : null, piezas, sin_detalle,
});

function montar(tipo: 'cheque' | 'papel', a: ApartadoEnCaja | null, bloqueo: string | null = null) {
  TestBed.configureTestingModule({ imports: [ArqueoDocumentosComponent], providers: [provideZonelessChangeDetection()] });
  const fx = TestBed.createComponent(ArqueoDocumentosComponent);
  fx.componentRef.setInput('tipo', tipo);
  fx.componentRef.setInput('apartado', a);
  fx.componentRef.setInput('bloqueo', bloqueo);
  fx.detectChanges();
  return { fx, cmp: fx.componentInstance, el: fx.nativeElement as HTMLElement };
}

describe('ArqueoDocumentosComponent · [CGS.59]', () => {
  it('sin tocar nada es «no se contó»: valor null, nada que pedir, y lo dice', () => {
    const { cmp, el } = montar('cheque', apartado());
    expect(cmp.valor()).toBeNull();
    expect(cmp.falta()).toBeNull();
    expect(el.textContent).toContain('Sin contar');
  });

  it('«No hay cheques» es contado y vacío: [] y $0, distinto de null', () => {
    const { cmp } = montar('cheque', apartado());
    cmp.contado.set(true);
    expect(cmp.valor()).toEqual([]);
    expect(cmp.total()).toBe(0);
  });

  it('[negativa] ⭐ lo que había hay que marcarlo, uno por uno: sin marcar no se guarda', () => {
    const { cmp, el } = montar('cheque', apartado([cheque(), cheque({ pieza: 'p-2', numero: '777', monto: 500 })]));
    expect(el.textContent).toContain('Banamex 0012345 · Abarrotes La Luz');
    cmp.marcar('p-1', 'esta');
    expect(cmp.falta()).toContain('marca el cheque que había');
    cmp.marcar('p-2', 'esta');
    expect(cmp.falta()).toBeNull();
    expect(cmp.total()).toBe(10621);
    expect(cmp.valor()).toEqual([{ pieza: 'p-1', estado: 'esta' }, { pieza: 'p-2', estado: 'esta' }]);
  });

  it('[negativa] el que salió dice por qué; «otra cosa» lleva qué pasó', () => {
    const { cmp } = montar('cheque', apartado([cheque()]));
    cmp.marcar('p-1', 'salio');
    expect(cmp.falta()).toContain('Di por qué salió');
    cmp.ponerSalida('p-1', 'otro');
    expect(cmp.falta()).toContain('Escribe qué pasó');
    cmp.ponerSalida('p-1', 'depositado');
    expect(cmp.falta()).toBeNull();
    expect(cmp.total()).toBe(0);
    expect(cmp.valor()).toEqual([{ pieza: 'p-1', estado: 'salio', salida: 'depositado', salida_nota: null }]);
  });

  it('[negativa] un cheque nuevo incompleto no se guarda; completo, suma', () => {
    const { cmp } = montar('cheque', apartado());
    cmp.agregar();
    const id = cmp.nuevos()[0].id;
    expect(cmp.falta()).toContain('Completa el cheque nuevo');
    cmp.poner(id, 'banco', 'BBVA');
    cmp.poner(id, 'numero', '88');
    cmp.poner(id, 'de_quien', 'Dulcería Mary');
    cmp.poner(id, 'monto', 5000);
    expect(cmp.falta()).toBeNull();
    expect(cmp.total()).toBe(5000);
    expect(cmp.valor()).toEqual([{ estado: 'esta', monto: 5000, de_quien: 'Dulcería Mary', fecha: null, banco: 'BBVA', numero: '88' }]);
  });

  it('[negativa] el mismo cheque dos veces (banco y número) no se guarda', () => {
    const { cmp } = montar('cheque', apartado([cheque()]));
    cmp.marcar('p-1', 'esta');
    cmp.agregar();
    const id = cmp.nuevos()[0].id;
    for (const [k, v] of [['banco', ' banamex '], ['numero', '0012345'], ['de_quien', 'Otro Cliente'], ['monto', 1]] as const) cmp.poner(id, k, v);
    expect(cmp.falta()).toContain('ya está en la lista');
  });

  it('[negativa] un papel nuevo dice si es vale o crédito, quién debe y por qué', () => {
    const { cmp } = montar('papel', apartado());
    cmp.agregar();
    const id = cmp.nuevos()[0].id;
    cmp.poner(id, 'de_quien', 'Tienda Lupita');
    cmp.poner(id, 'concepto', 'venta ruta 27');
    cmp.poner(id, 'monto', 1952);
    expect(cmp.falta()).toContain('vale o crédito');
    cmp.poner(id, 'clase', 'credito');
    expect(cmp.falta()).toBeNull();
    expect(cmp.valor()).toEqual([{ estado: 'esta', monto: 1952, de_quien: 'Tienda Lupita', fecha: null, clase: 'credito', concepto: 'venta ruta 27' }]);
  });

  it('lo declarado sin detalle (Control) se muestra para contarlo, no se arrastra', () => {
    const { el, cmp } = montar('papel', apartado([], { monto: 20782, origen: 'control', at: '2026-10-21T23:47:00Z' }));
    expect(el.textContent).toContain('viene de Control');
    expect(el.textContent).toContain('$20,782.00');
    expect(cmp.valor()).toBeNull();
  });

  it('con un bloqueo (la lectura falló) no se puede contar y se dice por qué', () => {
    const { el } = montar('cheque', null, 'No se pudo leer qué cheques y papeles había: esta vez quedan sin contar.');
    expect(el.textContent).toContain('No se pudo leer');
    expect(el.querySelector('p-button')).toBeNull();
  });

  it('«Dejar sin contar» vuelve a null', () => {
    const { cmp } = montar('cheque', apartado([cheque()]));
    cmp.marcar('p-1', 'esta');
    cmp.reiniciar();
    expect(cmp.valor()).toBeNull();
  });
});

describe('desgloseRubro · [CGS.59] el total de cheques y papeles se abre documento por documento', () => {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const cuando = (iso: string) => iso.slice(0, 10);
  const base = {
    rubro: 'papeles' as const, etiqueta: 'Papeles', desde: null,
    ultimo: { monto: 22734, fuente: 'arqueo de la Suite (carmen)', at: '2026-10-30T18:00:00Z' },
    ahora: { monto: 22734, estado: 'medido' as const, nota: '' },
  };
  it('una línea por documento, con desde cuándo está', () => {
    const r = desgloseRubro({ ...base, piezas: [
      { texto: 'Vale · Pedro Ramírez: viáticos', monto: 20782, desde: '2026-10-23' },
      { texto: 'Crédito · Tienda Lupita: ruta 27', monto: 1952, desde: '2026-10-30' },
    ] }, fmt, cuando);
    expect(r.slice(1)).toEqual([
      { monto: '$20782.00', texto: 'Vale · Pedro Ramírez: viáticos · en caja desde el 23/10/26' },
      { monto: '$1952.00', texto: 'Crédito · Tienda Lupita: ruta 27 · en caja desde el 30/10/26' },
    ]);
  });
  it('contado y sin documentos lo dice; sin detalle no inventa renglones', () => {
    expect(desgloseRubro({ ...base, piezas: [] }, fmt, cuando).slice(1)).toEqual([{ monto: null, texto: 'no había ninguno' }]);
    expect(desgloseRubro(base, fmt, cuando)).toHaveLength(1);
  });
});
