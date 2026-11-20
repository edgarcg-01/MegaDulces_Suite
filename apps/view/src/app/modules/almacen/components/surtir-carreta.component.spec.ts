import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CartRow, WaveCartsResponse } from '@megadulces/contracts';
import { SurtirCarretaComponent } from './surtir-carreta.component';
import { AlmacenCarretasService } from '../almacen-carretas.service';
import { UsoService } from '../../../core/services/uso.service';

/** `[GP.11.5]` El paso de la carreta en Surtir (D7): antes del primer renglón, en una ola de un pedido. */

const C07: CartRow = { id: 'b-C07', code: 'C07', numero: 7, tipo: 'carreta', estado: 'activa', motivo_estado: null, ocupacion: null };
const W = (p: Partial<WaveCartsResponse> = {}): WaveCartsResponse => ({ wave_id: 'w-1', pedidos: 1, tanda: false, catalogo: 40, carretas: [], ...p });

function montar(respuestas: WaveCartsResponse[], occupyFalla?: HttpErrorResponse) {
  const cola = [...respuestas];
  const api = {
    forWave: vi.fn(() => of(cola.length > 1 ? cola.shift()! : cola[0])),
    occupy: vi.fn(() => (occupyFalla ? throwError(() => occupyFalla) : of({ carreta: C07, ya_estaba: false }))),
    undo: vi.fn(() => of(C07)),
  };
  const uso = { reportarIncidente: vi.fn() };
  TestBed.configureTestingModule({
    imports: [SurtirCarretaComponent],
    providers: [{ provide: AlmacenCarretasService, useValue: api }, { provide: UsoService, useValue: uso }],
  });
  const fix = TestBed.createComponent(SurtirCarretaComponent);
  const listo: boolean[] = [];
  fix.componentInstance.listo.subscribe((v) => listo.push(v));
  fix.componentRef.setInput('warehouseId', 'wh-ph');
  fix.componentRef.setInput('waveId', 'w-1');
  fix.componentRef.setInput('pedido', 'UD4001-0002840');
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const pausa = async () => { await fix.whenStable(); for (let i = 0; i < 6; i++) await Promise.resolve(); fix.detectChanges(); };
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const escribir = async (v: string) => {
    fix.componentInstance.entrada.set(v);
    await fix.componentInstance.tomar();
    await pausa();
  };
  return { fix, el, api, uso, listo, pausa, texto, escribir };
}

describe('[GP.11.5] Surtir · la carreta antes del primer renglón', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('⭐ sin carreta pide escanearla (no está lista); al teclear «7» toma la C07 por la OLA y queda lista', async () => {
    const { api, listo, pausa, texto, escribir, el } = montar([W(), W({ carretas: [{ ...C07, ocupacion: null }] })]);
    await pausa();
    expect(texto()).toContain('Escanea la carreta para UD4001-0002840');
    expect(el.querySelector('#sc-in')?.getAttribute('inputmode')).toBe('numeric');
    expect(listo.at(-1)).toBe(false);
    await escribir('7');
    expect(api.occupy).toHaveBeenCalledWith({ warehouse_id: 'wh-ph', carreta: 'C07', pedido: { source: 'ola', wave_id: 'w-1' } });
    expect(texto()).toContain('Va en');
    expect(texto()).toContain('Carreta 7');
    expect(listo.at(-1)).toBe(true);
  });

  it('⭐ NEGATIVA D7: si la carreta trae otro pedido, lo dice, deja el motivo como incidente y NO queda lista', async () => {
    const falla = new HttpErrorResponse({ status: 409, error: { message: 'La carreta C07 ya trae el pedido U-D-40 12345, de Ana desde las 10:42. Usa otra.' } });
    const { uso, listo, pausa, texto, escribir } = montar([W()], falla);
    await pausa();
    await escribir('C07');
    expect(texto()).toContain('ya trae el pedido U-D-40 12345, de Ana');
    expect(uso.reportarIncidente).toHaveBeenCalledWith('carreta_rechazada', expect.objectContaining({ status: 409, carreta: 'C07', wave_id: 'w-1' }));
    expect(listo.at(-1)).toBe(false);
  });

  it('NEGATIVA: un número fuera de C01–C99 se explica sin llamar al servidor', async () => {
    const { api, pausa, texto, escribir } = montar([W()]);
    await pausa();
    await escribir('C100');
    expect(api.occupy).not.toHaveBeenCalled();
    expect(texto()).toContain('Las carretas van de la C01 a la C99');
  });

  it('una tanda va sin carreta por ahora: lo dice y queda lista (no se bloquea el surtido)', async () => {
    const { listo, pausa, texto, el } = montar([W({ pedidos: 12, tanda: true })]);
    await pausa();
    expect(texto()).toContain('Tanda de 12 pedidos: por ahora se surte sin carreta.');
    expect(el.querySelector('#sc-in')).toBeNull();
    expect(listo.at(-1)).toBe(true);
  });

  it('⭐ un almacén SIN carretas dadas de alta surte como hoy y lo dice (el primer día no se bloquea la sucursal)', async () => {
    const { listo, pausa, texto, el } = montar([W({ catalogo: 0 })]);
    await pausa();
    expect(texto()).toContain('todavía no tiene carretas dadas de alta: se surte sin carreta');
    expect(el.querySelector('#sc-in')).toBeNull();
    expect(listo.at(-1)).toBe(true);
  });

  it('UI.4: el Enter del escáner en el campo de la carreta no llega a la pantalla de abajo (no marca un renglón)', async () => {
    const { el, pausa } = montar([W()]);
    await pausa();
    const abajo = vi.fn();
    el.addEventListener('keydown', abajo);
    el.querySelector('#sc-in')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(abajo).not.toHaveBeenCalled();
  });

  it('«Deshacer» suelta la carreta tomada por error', async () => {
    const { fix, api, pausa } = montar([W({ carretas: [C07] }), W()]);
    await pausa();
    await fix.componentInstance.deshacer(C07);
    expect(api.undo).toHaveBeenCalledWith('b-C07');
  });
});
