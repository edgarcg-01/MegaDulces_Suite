import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AndenRedComponent } from './anden-red.component';
import type { OpAnden } from '../anden-offline';

/**
 * `[WMS-REC.20]` El aviso de red y cola del Andén: sólo habla cuando hay algo que decir, dice un
 * rechazo por vale, y descartar —que pierde lo capturado sin red— pide confirmación.
 */
const error = (valeKey: string, seq: number, msg: string): OpAnden =>
  ({ id: `${valeKey}-${seq}`, seq, valeKey, creadoEn: '', intentos: 1, estado: 'error', tipo: 'cerrar', error: msg }) as OpAnden;

async function montar(inputs: Record<string, unknown>) {
  TestBed.configureTestingModule({ imports: [AndenRedComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(AndenRedComponent);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  f.detectChanges();
  await f.whenStable();
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement };
}

describe('[WMS-REC.20] aviso de red y cola', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('con red y nada por mandar no ocupa lugar', async () => {
    const { el } = await montar({ online: true, pendientes: 0 });
    expect(el.textContent?.trim()).toBe('');
  });

  it('sin red lo dice, con la hora de los vales y sin punto doble', async () => {
    const { el } = await montar({ online: false, paqueteAl: '2026-10-07T18:40:00.000Z' });
    const t = el.textContent || '';
    expect(t).toContain('Sin conexión.');
    expect(t).toContain('Vales del equipo al 12:40.');
    expect(t).not.toContain('..');
  });

  it('un rechazo por vale: el primero, que es el que detiene a los demás', async () => {
    const { f } = await montar({ online: true, errores: [error('a', 2, 'segundo'), error('a', 1, 'primero'), error('b', 3, 'otro vale')] });
    expect(f.componentInstance.detenidos()).toEqual([{ key: 'a', error: 'primero' }, { key: 'b', error: 'otro vale' }]);
  });

  it('descartar pide confirmación antes de emitir', async () => {
    const { f, el } = await montar({ online: true, errores: [error('a', 1, 'congelado')] });
    const emitidos: string[] = [];
    f.componentInstance.descartar.subscribe((k) => emitidos.push(k));
    const boton = (t: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)!;
    boton('Descartar').click();
    f.detectChanges();
    expect(emitidos).toEqual([]);
    expect(el.textContent).toContain('Se pierde lo capturado sin conexión');
    boton('Sí, descartar').click();
    expect(emitidos).toEqual(['a']);
  });
});
