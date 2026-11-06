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
    expect(texto()).toContain('2 · $13,431.66');
    expect(c.abierta()).toBe(false);
  });

  it('[AX.19] el botón desglosa sin abrir nada: nunca facturados y facturas en $0, con su ventana', async () => {
    await montar(() => of(REPORT));
    const t = texto();
    expect(t).toContain('365 días');
    expect(t).toContain('1 nunca facturado · 1 con factura en $0');
    expect(c.ariaBoton()).toContain('1 nunca facturados, 1 con factura en cero');
  });

  it('[AX.19] el desglose por sucursal suma por situación y filtra la lista al elegir una', async () => {
    await montar(() => of(REPORT));
    const d = c.porSucursal();
    expect(d.map((s) => s.sucursal)).toEqual(['00', '01']); // de la que más debe a la que menos
    expect(d[0]).toMatchObject({ nunca: 1, nuncaMonto: 8415.81, enCero: 0, total: 8415.81 });
    expect(d[1]).toMatchObject({ nunca: 0, enCero: 1, enCeroMonto: 5015.85 });
    c.elegirSucursal(d[1]);
    expect(c.vista().map((e) => e.folio)).toEqual(['0003222']);
    c.elegirSucursal(d[1]); // elegirla otra vez quita el filtro
    expect(c.vista()).toHaveLength(2);
  });

  it('[AX.19] el filtro de situación recorta la lista y cada opción dice cuántos hay', async () => {
    await montar(() => of(REPORT));
    expect(c.opcionesSituacion().map((o) => o.count)).toEqual([2, 1, 1]);
    c.situacion.set('sin_factura');
    expect(c.vista().map((e) => e.cliente_nombre)).toEqual(['YSABEL RUIZ SOTO']);
  });

  const conEstado = (cancelada: boolean | null): EmbarquesSinFacturaReport => ({
    ...REPORT,
    embarques: REPORT.embarques.map((e) => ({
      ...e, estatus_embarque: 'EMBARCADO',
      facturas_detalle: e.facturas.map((folio) => ({ folio, fecha: '2026-10-21', cancelada })),
    })),
  });

  it('[AX.19] facturas canceladas en Kepler: lo dice el botón, la fila y «lo que se sabe»', async () => {
    await montar(() => of(conEstado(true)));
    expect(texto()).toContain('1 con factura cancelada');
    expect(c.estadoCero()).toEqual({ total: 2, canceladas: 2, vivas: 0, sinSaber: 0 });
    c.abierta.set(true);
    fix.detectChanges();
    await fix.whenStable();
    const t = texto();
    expect(t).toContain('Sus 2 facturas se cancelaron');
    expect(t).toContain('2 de 2 están canceladas en Kepler');
    expect(t).toContain('2 de 2 embarques siguen como «EMBARCADO»');
    expect(t).toContain('¿Se volvió a facturar?');
    expect(t).toContain('¿Por qué se canceló?');
  });

  it('NEGATIVA [AX.19] — una factura que no se pudo casar NO se cuenta como cancelada', async () => {
    await montar(() => of(conEstado(null)));
    expect(c.estadoCero()).toEqual({ total: 2, canceladas: 0, vivas: 0, sinSaber: 2 });
    expect(c.todasCanceladas()).toBe(false);
    expect(texto()).toContain('1 con factura en $0');
    expect(c.cancelacion(c.enCero()[0])).toBe('no_se_sabe');
  });

  it('NEGATIVA [AX.19] — una API sin el detalle dice «no se sabe», no «viva» ni «cancelada»', async () => {
    await montar(() => of(REPORT));
    expect(c.estadoCero()).toEqual({ total: 2, canceladas: 0, vivas: 0, sinSaber: 2 });
    expect(c.embarcados()).toBeNull();
  });

  it('NEGATIVA — sin medición el botón no inventa un desglose', async () => {
    await montar(() => throwError(() => ({ error: { message: 'timeout' } })));
    expect(texto()).not.toContain('nunca facturado');
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
