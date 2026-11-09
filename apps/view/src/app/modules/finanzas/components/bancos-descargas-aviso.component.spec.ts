import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { BancosDescargasAvisoComponent, cuentasAtrasadas, diaAnterior } from './bancos-descargas-aviso.component';
import { BankService } from '../bank.service';

/** `[CB.59]` El aviso del Cierre: qué cuentas no tienen la descarga del banco hasta ayer. Datos inventados. */
const cta = (alias: string, hasta: string | null, con_lector = true) =>
  ({ id: alias, bank: alias.split(' ')[0], alias, hasta, archivos: hasta ? 1 : 0, sin_testigo: 0, con_lector });

function montar(respuesta: unknown) {
  TestBed.configureTestingModule({
    imports: [BancosDescargasAvisoComponent],
    providers: [provideZonelessChangeDetection(), { provide: BankService, useValue: { archivosDelBanco: () => respuesta } }],
  });
  const fx = TestBed.createComponent(BancosDescargasAvisoComponent);
  fx.componentInstance.hoy.set('2026-11-09');
  fx.detectChanges();
  return { fx, el: fx.nativeElement as HTMLElement };
}

describe('[CB.59] aviso de descargas en el Cierre', () => {
  it('ayer se calcula sin la zona del navegador, también al cambiar de mes', () => {
    expect(diaAnterior('2026-11-09')).toBe('2026-11-08');
    expect(diaAnterior('2026-12-01')).toBe('2026-11-30');
  });

  it('atrasada = con lector y sin descarga hasta ayer; Banamex (sin lector) no cuenta', () => {
    const r = cuentasAtrasadas([cta('BB 1', '2026-11-08'), cta('BB 2', '2026-11-07'), cta('BB 3', null), cta('BNMX 4', null, false)], '2026-11-08');
    expect(r.map((c) => c.alias)).toEqual(['BB 2', 'BB 3']);
  });

  it('nombra las cuentas atrasadas y lleva a subirlas', () => {
    const { fx, el } = montar(of({ archivos: [], total: 0, tope: 100, cuentas: [cta('BB 1', '2026-11-08'), cta('BB 2', null), cta('BNMX 4', null, false)] }));
    expect(el.textContent).toContain('1 de 2 cuentas no llegan a ayer (08/11)');
    expect(el.textContent).toContain('BB 2');
    let fue = false;
    fx.componentInstance.irA.subscribe(() => (fue = true));
    el.querySelector('button')!.click();
    expect(fue).toBe(true);
  });

  it('[negativa] todo al día: no ocupa lugar', () => {
    const { el } = montar(of({ archivos: [], total: 0, tope: 100, cuentas: [cta('BB 1', '2026-11-08')] }));
    expect(el.textContent?.trim()).toBe('');
  });

  it('[negativa] si no se pudo leer, lo dice: no se calla como si todo estuviera al día', () => {
    const { el } = montar(throwError(() => new Error('500')));
    expect(el.textContent).toContain('No se pudo leer qué descargas del banco faltan');
  });
});
