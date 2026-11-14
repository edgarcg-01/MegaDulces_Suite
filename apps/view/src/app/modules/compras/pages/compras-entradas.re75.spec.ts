import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ComprasEntradasComponent } from './compras-entradas.component';

/**
 * `[RE.75]` Lo que la auditoría de `/compras/entradas` encontró en el recorrido:
 *  · una búsqueda de ajustes FALLIDA se leía como «sin devoluciones ni notas»;
 *  · Enter en el buscador, parado en la página 2, buscaba el término nuevo en la página 2 (vacía).
 * Sin TestBed, como `compras-entradas.siguiente.spec.ts`: se arma sobre el prototipo.
 */
function armar() {
  const adj: Subject<unknown>[] = [];
  const c = Object.create(ComprasEntradasComponent.prototype) as ComprasEntradasComponent & Record<string, unknown>;
  Object.assign(c, {
    detailTarget: signal(null), explains: signal([]), explainsLoading: signal(false), explainsTotal: signal(0), explainsError: signal(false),
    destroyRef: { onDestroy: () => () => undefined, destroyed: false },
    compras: { adjustmentsForEntrada: () => { const s = new Subject<unknown>(); adj.push(s); return s; } },
  });
  return { c, adj };
}

describe('[RE.75] una búsqueda de ajustes fallida no se lee como «no hay»', () => {
  it('el error queda declarado; la carga siguiente lo limpia', () => {
    const { c, adj } = armar();
    const fila = { sucursal: '08', folio: '0000421', proveedor_code: 'P1', receipt_date: '2026-10-31' };
    (c.detailTarget as ReturnType<typeof signal>).set(fila);
    (c as unknown as { loadExplains(f: unknown): void }).loadExplains(fila);
    adj[0].error(new Error('500'));
    expect(c.explainsError()).toBe(true);
    expect(c.explainsLoading()).toBe(false);

    (c as unknown as { loadExplains(f: unknown): void }).loadExplains(fila);
    expect(c.explainsError()).toBe(false);
  });
});

describe('[RE.75] Enter en el buscador busca desde la página 1', () => {
  it('parado en la página 3, Enter vuelve a la 1 y carga', () => {
    const c = Object.create(ComprasEntradasComponent.prototype) as ComprasEntradasComponent;
    let cargas = 0;
    Object.assign(c, { page: signal(3), load: () => { cargas++; } });
    c.buscarAhora();
    expect(c.page()).toBe(1);
    expect(cargas).toBe(1);
  });
});
