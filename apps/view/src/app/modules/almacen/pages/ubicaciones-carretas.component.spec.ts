import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CartRow, CartsResponse } from '@megadulces/contracts';
import { UbicacionesCarretasComponent } from './ubicaciones-carretas.component';
import { AlmacenCarretasService } from '../almacen-carretas.service';

/** `[GP.11.5]` Ubicaciones › Carretas: catálogo, alta por rango con sus carteles y liberar (coordinador). */

const WH = { id: 'w-ph', code: '01', name: 'Padre Hidalgo' };
const C = (code: string, p: Partial<CartRow> = {}): CartRow => ({ id: 'b-' + code, code, numero: Number(code.slice(1)), tipo: 'carreta', estado: 'activa', motivo_estado: null, ocupacion: null, ...p });
const R = (carretas: CartRow[]): CartsResponse => ({
  warehouse: WH, carretas,
  libres: carretas.filter((c) => c.estado === 'activa' && !c.ocupacion).length,
  ocupadas: carretas.filter((c) => c.estado === 'activa' && !!c.ocupacion).length,
});
const OCUPADA = C('C07', { ocupacion: { id: 'o1', source: 'kepler', order_id: 'x', pedido: 'U-D-40 2840', occupied_at: '2026-11-20T16:42:00Z', occupied_by: 'u-ana', occupied_by_name: 'Ana' } });

function montar(respuestas: CartsResponse[], opts: { gestiona?: boolean; coordina?: boolean } = {}) {
  const cola = [...respuestas];
  const api = {
    list: vi.fn(() => of(cola.length > 1 ? cola.shift()! : cola[0])),
    bulk: vi.fn(() => of({ creadas: ['C01', 'C02', 'C03'], ya_existian: ['C07'] })),
    release: vi.fn(() => of(C('C07'))),
  };
  TestBed.configureTestingModule({ imports: [UbicacionesCarretasComponent], providers: [{ provide: AlmacenCarretasService, useValue: api }] });
  const fix = TestBed.createComponent(UbicacionesCarretasComponent);
  fix.componentRef.setInput('warehouse', WH);
  fix.componentRef.setInput('puedeGestionar', !!opts.gestiona);
  fix.componentRef.setInput('puedeCoordinar', !!opts.coordina);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const pausa = async () => { await fix.whenStable(); for (let i = 0; i < 6; i++) await Promise.resolve(); fix.detectChanges(); };
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: RegExp) => Array.from(el.querySelectorAll('button')).find((b) => t.test((b.textContent ?? '').replace(/\s+/g, ' ')));
  return { fix, el, api, pausa, texto, boton };
}

describe('[GP.11.5] Ubicaciones › Carretas', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('⭐ cada carreta dice en palabras si está libre o qué pedido trae, de quién y desde cuándo', async () => {
    const { pausa, texto } = montar([R([C('C01'), OCUPADA, C('C09', { estado: 'baja', motivo_estado: 'rueda rota' })])]);
    await pausa();
    expect(texto()).toContain('1 libre · 1 con pedido');
    expect(texto()).toContain('C01 Carreta 1 Libre');
    expect(texto()).toContain('C07 Carreta 7 Con U-D-40 2840 · Ana desde las 10:42');
    expect(texto()).toContain('Dada de baja (rueda rota)');
  });

  it('sin carretas lo dice, y dice que Surtir trabaja sin carreta mientras tanto', async () => {
    const { pausa, texto } = montar([R([])]);
    await pausa();
    expect(texto()).toContain('Padre Hidalgo todavía no tiene carretas dadas de alta. Mientras no haya, Surtir trabaja sin carreta.');
  });

  it('⭐ alta por rango: manda tipo y números, dice qué se creó y qué ya existía, y abre los carteles de las nuevas', async () => {
    const { fix, api, pausa, texto, el } = montar([R([OCUPADA]), R([C('C01'), C('C02'), C('C03'), OCUPADA])], { gestiona: true });
    await pausa();
    fix.componentInstance.desde.set(1);
    fix.componentInstance.hasta.set(3);
    fix.componentInstance.tipo.set('carrito');
    await fix.componentInstance.darDeAlta();
    await pausa();
    expect(api.bulk).toHaveBeenCalledWith({ warehouse_id: 'w-ph', tipo: 'carrito', desde: 1, hasta: 3 });
    expect(texto()).toContain('Se dieron de alta C01 a C03. Ya existían: C07.');
    expect(fix.componentInstance.carteles().map((c) => c.code)).toEqual(['C01', 'C02', 'C03']);
    expect(el.querySelector('app-anden-cartel')).not.toBeNull();
  });

  it('NEGATIVA: sin permiso de gestionar no hay alta; un rango al revés o fuera de C01–C99 no se manda', async () => {
    const sin = montar([R([])]);
    await sin.pausa();
    expect(sin.el.querySelector('form.ca-alta')).toBeNull();
    TestBed.resetTestingModule();
    const { fix, api } = montar([R([])], { gestiona: true });
    fix.componentInstance.desde.set(5);
    fix.componentInstance.hasta.set(2);
    await fix.componentInstance.darDeAlta();
    fix.componentInstance.desde.set(1);
    fix.componentInstance.hasta.set(100);
    await fix.componentInstance.darDeAlta();
    expect(api.bulk).not.toHaveBeenCalled();
  });

  it('⭐ liberar a mano: sólo el coordinador, con confirmación', async () => {
    const sin = montar([R([OCUPADA])]);
    await sin.pausa();
    expect(sin.boton(/Liberar/)).toBeUndefined();
    TestBed.resetTestingModule();
    const { api, pausa, boton } = montar([R([OCUPADA]), R([C('C07')])], { coordina: true });
    await pausa();
    boton(/^\s*Liberar\s*$/)!.click();
    await pausa();
    expect(api.release).not.toHaveBeenCalled();
    boton(/Sí, liberar/)!.click();
    await pausa();
    expect(api.release).toHaveBeenCalledWith('b-C07');
  });
});
