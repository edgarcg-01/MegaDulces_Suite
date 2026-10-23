import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { AutoabastoPedidoLinea, AutoabastoPedidoResponse, AutoabastoVieneDoc } from '@megadulces/contracts';
import { AlmacenAutoabastoPedidoComponent } from './almacen-autoabasto-pedido.component';
import { AutoabastoService } from '../autoabasto.service';
import { AuthService } from '../../../core/services/auth.service';

/**
 * `[AB.23]`–`[AB.24]` «Mi pedido» dice lo que le va a llegar a la sucursal, para que no pida dos veces.
 * Pedido del PM (2026-10-22): «el objetivo es que los encargados sepan qué mercancía les va a llegar
 * para que no hagan pedido».
 */
class ResizeObserverStub { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const doc = (p: Partial<AutoabastoVieneDoc>): AutoabastoVieneDoc => ({
  tipo: 'embarque', origen: '00', serie: 2, folio: '0001', estado: 'EMBARCADO', fecha: '2026-10-21', dias: 1, renglones: 4, monto: 1000, se_resta: true, ...p,
});
const linea = (p: Partial<AutoabastoPedidoLinea> = {}): AutoabastoPedidoLinea => ({
  product_id: 'p-1', sku: '70056', nombre: 'MAZAPÁN', venta_30d: 10, existencia: 2, objetivo: 12, falta: 10,
  ya_pedido: 2, atorado: 0, negado_30d: 0, en_camino: 3, planeado_compras: 0, falta_neta: 5,
  a_pedir: { cantidad: 5, unidad: 'cj', factor: 16, cantidad_base: 80, regla: 'cajas' } as never,
  ajuste: null, valor: 100, costo_base: 1, posicion: 'bajo_minimo', minimo_menor: 'no_aplica' as never, valor_menor: null,
  estado: 'sin_pedir', surte: { tipo: 'matriz', clave: '00', nombre: '00' }, ...p,
});
const RESP = (docs: AutoabastoVieneDoc[]): AutoabastoPedidoResponse => ({
  almacen: { id: 'w-01', code: '01', name: 'Padre Hidalgo' }, fecha_mx: '2026-10-22', hora_mx: '13:00', cobertura_dias: 15,
  ventana_ya_pedido_dias: 7, ventana_negado_dias: 30, ventana_en_camino_dias: 7,
  viene: { documentos: docs, renglones_sin_unidad: 0 },
  grupos: [{ tipo: 'matriz', clave: '00', nombre: '00', lineas: [linea()], renglones_a_pedir: 1, total_cajas: 5, renglones_sin_caja: 0,
    total_valor: 100, sin_valuar: 0, minimo_cajas: null, minimo_valor: null }],
  pedidos_medidos: true, pedido_id: null, puede_ajustar: false, guardado_disponible: true, posiciones: ['agotado', 'bajo_minimo'] as never,
});

function montar(resp: AutoabastoPedidoResponse) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AlmacenAutoabastoPedidoComponent],
    providers: [
      provideZonelessChangeDetection(), provideRouter([]),
      { provide: AutoabastoService, useValue: {
        filtros: () => of({ warehouses: [{ id: 'w-01', code: '01', name: 'Padre Hidalgo' }] }),
        pedido: () => of(resp), abrirPedido: () => of(null),
      } },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1', username: 'u1' }), token: () => null } },
    ],
  });
  const f = TestBed.createComponent(AlmacenAutoabastoPedidoComponent);
  f.detectChanges();
  return f;
}
const texto = (f: ReturnType<typeof montar>) => ((f.nativeElement as HTMLElement).textContent || '').replace(/\s+/g, ' ');

describe('[AB.23] «Mi pedido»: lo que te va a llegar', () => {
  it('arriba dice cuántos embarques y pedidos vienen, por NOMBRE de sucursal, y que ya se restaron', () => {
    const f = montar(RESP([doc({}), doc({ folio: '0002', origen: '08' }), doc({ tipo: 'pedido', estado: 'SURTIDO', folio: '0450', origen: '01', dias: 2 })]));
    const t = texto(f);
    expect(t).toContain('Lo que te va a llegar');
    expect(t).toContain('2 embarques en camino');
    expect(t).toContain('1 pedido en preparación');
    expect(t).toContain('ya se restaron');
    expect(t).toContain('desde CEDIS');
    expect(t).toContain('desde Morelia Abastos');
    expect(t).not.toMatch(/desde 0[0-9]\b/);   // nunca un código
  });

  it('⛔ lo viejo se muestra para reclamarlo y NO se cuenta como «ya se restó»', () => {
    const c = montar(RESP([doc({}), doc({ folio: '0009', dias: 12, se_resta: false })])).componentInstance;
    expect(c.viene()!.embarques).toBe(1);
    expect(c.viene()!.viejos).toBe(1);
  });

  it('lo que planeó Compras y no está en Kepler se muestra aparte y nunca se resta', () => {
    const f = montar(RESP([doc({}), doc({ tipo: 'plan', estado: 'PLANEADO', folio: 'RQ-1', se_resta: false, origen: '00' })]));
    const c = f.componentInstance;
    expect(c.viene()!.planes).toBe(1);
    expect(c.viene()!.viejos).toBe(0);
    expect(c.viene()!.embarques + c.viene()!.pedidos).toBe(1);
    expect(texto(f)).toContain('aún no está en Kepler');
  });

  it('«Ya viene» suma lo pedido y lo que va en camino, y la cuenta lo explica', () => {
    const c = montar(RESP([])).componentInstance;
    const l = linea();
    expect(c.yaViene(l)).toBe(5);
    expect(c.yaVieneTitle(l)).toBe('Ya viene: pedido a la matriz 2 + en camino 3 cajas. Ya se restó de «A pedir».');
    expect(c.porQueAPedir(l)).toContain('Falta 10 − ya pedido 2 − en camino 3 = 5 cajas.');
  });

  it('sin nada en camino lo dice, no pinta una lista vacía', () => {
    const t = texto(montar(RESP([])));
    expect(t).toContain('No hay pedidos de traspaso abiertos ni embarques en camino hacia Padre Hidalgo');
  });

  it('nunca esconde documentos sin decirlo: muestra 6 y ofrece «Ver los N»', () => {
    const docs = Array.from({ length: 9 }, (_, i) => doc({ folio: String(i) }));
    const f = montar(RESP(docs));
    expect(f.componentInstance.viene()!.visibles.length).toBe(6);
    expect(texto(f)).toContain('Ver los 9');
    f.componentInstance.verTodoViene.set(true);
    expect(f.componentInstance.viene()!.visibles.length).toBe(9);
  });
});
