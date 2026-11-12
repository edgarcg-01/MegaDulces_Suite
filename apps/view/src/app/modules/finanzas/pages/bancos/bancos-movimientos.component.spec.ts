import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { BancosMovimientosComponent } from './bancos-movimientos.component';
import { BankMovement, BankService, DescargaEnMovimientos } from '../../bank.service';

/**
 * `[CB.64]` La descarga del banco dentro de Movimientos: una sola lista. Cada renglón del libro dice si la descarga
 * lo trae; los de la descarga que el libro no tiene entran a la misma tabla, marcados y con su porqué. Sin el dato
 * (API anterior) no se pinta nada de la descarga. Datos inventados.
 */
const mov = (p: Partial<BankMovement>): BankMovement => ({
  id: 'm', movement_date: '2026-11-12', bank: 'BBVA', account_label: '4885', bank_account_id: 'a',
  category_id: null, category_code: null, category_name: null, group_key: null, kepler_account: null,
  raw_type: null, raw_code: null, sucursal: null, concept: 'X', amount_in: 0, amount_out: 0, running_balance: null, recon_status: 'pending', ...p,
});
const FILAS = [
  mov({ id: 'd1', fuente: 'descarga', motivo: 'falta_en_libro', concept: 'COMISION', amount_out: 100, recon_status: null as never, referencia: '0001',
    subido_en: '2026-11-13T02:30:00Z', subido_por: 'carmen', running_balance: 1100 }),
  mov({ id: 'd2', fuente: 'descarga', motivo: 'libro_no_llega', concept: 'VENTAS', amount_in: 500, recon_status: null as never }),
  mov({ id: 'l1', fuente: 'libro', en_descarga: 'trae', category_id: 'c', category_name: 'Cobranza', amount_in: 1000 }),
  mov({ id: 'l2', fuente: 'libro', en_descarga: 'no_trae', amount_out: 7 }),
  mov({ id: 'l3', fuente: 'libro', en_descarga: null, amount_in: 1 }),
];
const RESUMEN: DescargaEnMovimientos = { solo_descarga: 2, no_trae: 1, trae: 1 };

function montar(rows: BankMovement[], descarga: DescargaEnMovimientos | null, fDescarga = '') {
  const flujos: string[] = [];
  const api = { movementFlow: (id: string) => { flujos.push(id); return of({ tipo: 'pago', proveedor: null, cadena: [], docs: [], cobranza: null, nota: 'n' }); } };
  TestBed.configureTestingModule({
    imports: [BancosMovimientosComponent],
    providers: [provideZonelessChangeDetection(), { provide: BankService, useValue: api }],
  });
  const fx = TestBed.createComponent(BancosMovimientosComponent);
  for (const [k, v] of Object.entries({ movements: rows, movTotal: rows.length, accountOpts: [], groupOpts: [], reconOpts: [], descarga, fDescarga })) {
    fx.componentRef.setInput(k, v);
  }
  fx.detectChanges();
  const filtros: { field: string; value: unknown }[] = [];
  fx.componentInstance.filter.subscribe((e) => filtros.push(e));
  const el = fx.nativeElement as HTMLElement;
  const fila = (i: number) => el.querySelectorAll('tr.fb-mov-row')[i] as HTMLElement;
  const celdaDescarga = (i: number) => (fila(i).querySelector('.fb-desc-c')?.textContent ?? '').trim();
  return { fx, cmp: fx.componentInstance, el, flujos, filtros, fila, celdaDescarga };
}

describe('[CB.64] la descarga del banco dentro de Movimientos', () => {
  it('una sola lista: lo del libro dice si la descarga lo trae y lo de la descarga entra marcado con su porqué', () => {
    const { el, fila, celdaDescarga } = montar(FILAS, RESUMEN);
    expect(Array.from(el.querySelectorAll('th')).map((t) => t.textContent?.trim())).toContain('Descarga');
    expect(celdaDescarga(0)).toBe('sólo ahí');
    expect(fila(0).classList).toContain('fb-row-desc');
    expect(fila(0).textContent).toContain('falta en el libro');
    expect(fila(1).textContent).toContain('el libro aún no llega');
    expect(celdaDescarga(2)).toBe('La descarga lo trae');
    expect(celdaDescarga(3)).toBe('no viene');
    expect(celdaDescarga(4)).toBe('');
    expect(fila(2).classList).not.toContain('fb-row-desc');
  });

  it('[negativa] lo de la descarga no se pinta como «sin clasificar»: no es del libro, no se clasifica aquí', () => {
    const { fx, cmp, fila } = montar(FILAS, RESUMEN);
    cmp.colorByGroup.set(false);
    fx.detectChanges();
    expect(fila(0).classList).not.toContain('fb-uncat');
    expect(fila(0).textContent).not.toContain('sin clasificar');
    expect(fila(3).classList).toContain('fb-uncat');
  });

  it('el resumen arriba se recorre: cada número filtra la lista, y otro clic lo quita', () => {
    const { el, filtros } = montar(FILAS, RESUMEN);
    const tira = el.querySelector('.fb-desc')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(tira).toContain('2 que el libro no tiene');
    expect(tira).toContain('1 del libro que el banco no trae');
    expect(tira).toContain('1 coinciden');
    const [solo, noTrae] = Array.from(el.querySelectorAll('button.fb-desc-b')) as HTMLButtonElement[];
    solo.click(); noTrae.click();
    expect(filtros).toEqual([{ field: 'descarga', value: 'solo_descarga' }, { field: 'descarga', value: 'no_trae' }]);
    TestBed.resetTestingModule();
    const activo = montar(FILAS, RESUMEN, 'solo_descarga');
    const b = activo.el.querySelector('button.fb-desc-b') as HTMLButtonElement;
    expect(b.getAttribute('aria-pressed')).toBe('true');
    b.click();
    expect(activo.filtros).toEqual([{ field: 'descarga', value: '' }]);
  });

  it('[negativa] una API sin la descarga: ni resumen ni columna; la tabla queda como antes', () => {
    const { el } = montar([mov({ id: 'l1' })], null);
    expect(el.querySelector('.fb-desc')).toBeNull();
    expect(Array.from(el.querySelectorAll('th')).map((t) => t.textContent?.trim())).not.toContain('Descarga');
    expect(el.querySelector('.fb-desc-c')).toBeNull();
  });

  it('abrir un renglón de la descarga: su detalle dice de dónde viene y por qué falta, sin pedir el flujo (no está en Movimientos)', () => {
    const { cmp, flujos } = montar(FILAS, RESUMEN);
    cmp.openMov(FILAS[0]);
    const d = cmp.detail();
    expect(d?.title).toBe('Movimiento de la descarga del banco');
    expect(d?.note).toContain('Falta capturarlo en el libro');
    expect(d?.fields.find((f) => f.k === 'Referencia')?.v).toBe('0001');
    expect(flujos).toEqual([]);
  });

  it('[negativa] la hora de subida va en hora de México: 02:30 UTC del 13 es el 12 a las 20:30', () => {
    const { cmp } = montar(FILAS, RESUMEN);
    cmp.openMov(FILAS[0]);
    const subido = cmp.detail()?.fields.find((f) => f.k === 'Subido')?.v ?? '';
    expect(subido).toMatch(/^12\/11\/26/);
    expect(subido).toContain('20:30');
    expect(subido).toContain('carmen');
  });

  it('abrir uno del libro sí pide su flujo y dice si la descarga lo trae', () => {
    const { cmp, flujos } = montar(FILAS, RESUMEN);
    cmp.openMov(FILAS[3]);
    expect(flujos).toEqual(['l2']);
    expect(cmp.detail()?.fields.find((f) => f.k === 'Descarga del banco')?.v).toBe('la descarga no lo trae');
  });

  it('el detalle se despliega bajo su fila (la lista ya vive en una ventana: nada de otro panel encima) y otro clic lo cierra', () => {
    const { fx, el, fila } = montar(FILAS, RESUMEN);
    fila(3).click();
    fx.detectChanges();
    const det = el.querySelector('tr.fb-mov-det');
    expect(det?.textContent).toContain('Detalle del movimiento');
    expect(det?.previousElementSibling).toBe(fila(3));
    expect(fila(3).getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('app-side-peek')).toBeNull();
    fila(3).click();
    fx.detectChanges();
    expect(el.querySelector('tr.fb-mov-det')).toBeNull();
  });

  it('[negativa] el de la descarga se despliega sin la sección del flujo (no está en Movimientos, no tiene flujo)', () => {
    const { fx, el, fila } = montar(FILAS, RESUMEN);
    fila(0).click();
    fx.detectChanges();
    const det = el.querySelector('tr.fb-mov-det') as HTMLElement;
    expect(det.textContent).toContain('Movimiento de la descarga del banco');
    expect((det.querySelector('.fb-flow-sec') as HTMLElement).hidden).toBe(true);
  });

  it('el Excel dice lo mismo que la columna, en palabras', () => {
    const { cmp } = montar(FILAS, RESUMEN);
    expect(FILAS.map((m) => cmp.descargaTexto(m))).toEqual([
      'sólo en la descarga (falta en el libro)', 'sólo en la descarga (el libro aún no llega)', 'la descarga lo trae', 'la descarga no lo trae', '',
    ]);
  });
});
