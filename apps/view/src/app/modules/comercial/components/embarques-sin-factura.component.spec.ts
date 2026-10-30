import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { EmbarquesSinFacturaComponent } from './embarques-sin-factura.component';
import { SalesDocumentsService, type EmbarquesSinFacturaReport } from '../sales-documents.service';

/**
 * `[AX.18]` El botón «Embarques sin factura» y su ventana.
 *
 * Lo que se fija: el botón dice cuántos y cuánto SIN abrir nada; lo que no se pudo medir se
 * declara («sin medir»), nunca se dibuja como «ninguno»; la ventana distingue «nunca se facturó»
 * de «sus facturas quedaron en $0» y nombra los folios; y la medición sigue a la sucursal.
 * Casos tomados de prod (2026-10-29).
 */

const REPORT: EmbarquesSinFacturaReport = {
  dias: 365,
  total: '13431.66',
  embarques: [
    { folio_digital: '01UD4101-0003222', sucursal: '01', folio: '0003222', fecha: '2026-10-21',
      cliente_code: 'C1068', cliente_nombre: 'BLANCA ANDREA CAMPOS RAMIREZ', total_embarcado: '5015.85',
      situacion: 'facturas_en_cero', facturas: ['0001789', '0001837'] },
    { folio_digital: '00UD4101-0000653', sucursal: '00', folio: '0000653', fecha: '2026-09-17',
      cliente_code: '20589', cliente_nombre: 'YSABEL RUIZ SOTO', total_embarcado: '8415.81',
      situacion: 'sin_factura', facturas: [] },
  ],
};

describe('[AX.18] EmbarquesSinFacturaComponent', () => {
  let fix: ComponentFixture<EmbarquesSinFacturaComponent>;
  let c: EmbarquesSinFacturaComponent;
  let pedir: ReturnType<typeof vi.fn>;
  const texto = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

  beforeAll(() => registerLocaleData(localeEsMx));

  async function montar(resp: () => unknown) {
    pedir = vi.fn(resp);
    await TestBed.configureTestingModule({
      imports: [EmbarquesSinFacturaComponent],
      providers: [{ provide: SalesDocumentsService, useValue: { embarquesSinFactura: pedir } }],
    }).compileComponents();
    fix = TestBed.createComponent(EmbarquesSinFacturaComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('el botón dice cuántos y cuánto sin abrir la ventana', async () => {
    await montar(() => of(REPORT));
    expect(c.resumen()).toBe('2 · $13,431.66');
    expect(texto()).toContain('Embarques sin factura · 2 · $13,431.66');
    expect(c.abierta()).toBe(false);
  });

  it('NEGATIVA — si la medición falla dice «sin medir», nunca «ninguno»', async () => {
    await montar(() => throwError(() => ({ error: { message: 'timeout' } })));
    expect(c.resumen()).toBe('sin medir');
    expect(c.resumen()).not.toBe('ninguno');
  });

  it('CONTROL: sin embarques pendientes dice «ninguno»', async () => {
    await montar(() => of({ dias: 365, total: '0.00', embarques: [] }));
    expect(c.resumen()).toBe('ninguno');
  });

  it('la ventana distingue «nunca se facturó» de «facturas en $0» y nombra los folios', async () => {
    await montar(() => of(REPORT));
    c.abierta.set(true);
    fix.detectChanges();
    await fix.whenStable();
    const t = texto();
    expect(t).toContain('UD4101-0003222');
    expect(t).toContain('Sus 2 facturas quedaron en $0');
    expect(t).toContain('0001789, 0001837');
    expect(t).toContain('Nunca se facturó');
    expect(t).toContain('YSABEL RUIZ SOTO');
  });

  it('vuelve a medir cuando cambia la sucursal de la pantalla', async () => {
    await montar(() => of(REPORT));
    expect(pedir).toHaveBeenLastCalledWith(null);
    fix.componentRef.setInput('sucursal', '06');
    fix.detectChanges();
    expect(pedir).toHaveBeenLastCalledWith('06');
    expect(pedir).toHaveBeenCalledTimes(2);
  });
});
