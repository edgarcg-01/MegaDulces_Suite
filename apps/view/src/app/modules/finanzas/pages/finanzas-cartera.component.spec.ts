/**
 * `[CXC.41]` **Cartera de clientes, montada de verdad.** Ejerce lo que cambió la auditoría del
 * 2026-11-17 desde el DOM y los gestos, no desde las piezas:
 *
 *  1. **Abre en «Cliente», por más vencido** (lo que cobranza trabaja) y un enlace `?cliente=` abre
 *     en «Todas» (ese cliente puede ser una cuenta interna).
 *  2. ⛔ **Sin carreras:** una carga nueva cancela la anterior. Si la vieja responde DESPUÉS, no
 *     pinta encima.
 *  3. **La tira por tipo sale del universo sin el filtro de tipo:** con «Cliente» elegido sigue
 *     mostrando internas y rutas con su monto.
 *  4. **El tope se dice ARRIBA de la tabla**, no al pie de 500 filas.
 *  5. **El CSV pide todas las cuentas del filtro** (`limit=5000`) y avisa si aun así se corta.
 *  6. **El monto del compromiso acepta la forma** («1,250.00», «$1250») y rechaza lo que no es un
 *     número positivo.
 *  7. ⛔ **Un guardado que falla se VE.** Antes se callaba.
 *  8. **La fila se abre con Enter** (antes sólo con mouse).
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter, ActivatedRoute, convertToParamMap } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';

import { FinanzasCarteraComponent } from './finanzas-cartera.component';
import { CarteraService, CarteraResp, CarteraCliente, CarteraDetalle, PorTipoCuenta } from '../cartera.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

const aging = { por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };

const cli = (code: string, nombre: string, saldo: number, vencido: number, extra: Partial<CarteraCliente> = {}): CarteraCliente => ({
  sucursal: '01', cliente_code: code, cliente_nombre: nombre, rfc: null, vendedor: null,
  cuenta_kind: 'cliente_final', cuenta_kind_source: 'codigo', vendedor_nombre: null,
  grupo: null, zona: null, telefono: null, limite_credito: null, dias_credito: null,
  uso_linea: null, sobre_linea: false, saldo, vencido, n_partidas: 1, n_saldadas: 0,
  aging, sin_documento: 0, saldo_a_favor: 0, dias_pago_prom: null, n_pagos: 0,
  ...extra,
} as CarteraCliente);

const tipos = (c: number, i: number, r: number): PorTipoCuenta => ({
  cliente_final: { saldo: c, vencido: c, clientes: c ? 1 : 0 },
  interno: { saldo: i, vencido: i, clientes: i ? 1 : 0 },
  ruta: { saldo: r, vencido: r, clientes: r ? 1 : 0 },
});

function resp(clientes: CarteraCliente[], extra: { total?: number; porTipo?: PorTipoCuenta; universo?: PorTipoCuenta; marca?: string } = {}): CarteraResp {
  const saldo = clientes.reduce((s, c) => s + c.saldo, 0);
  return {
    hoy: extra.marca ?? '2026-11-17',
    freshness: { status: 'fresh', stale: false, age_human: '1 min', data_as_of: '2026-11-17T12:00:00Z', inputs: [] } as never,
    kpi: {
      total_saldo: saldo, total_vencido: saldo, n_clientes: clientes.length, n_partidas: clientes.length,
      n_sobre_linea: 0, total_a_favor: 0, n_a_favor: 0, aging, sin_documento: { monto: 0, clientes: 0 },
      por_tipo: extra.porTipo ?? tipos(saldo, 0, 0),
      ...(extra.universo ? { por_tipo_universo: extra.universo } : {}),
    },
    clientes,
    total_clientes: extra.total ?? clientes.length,
    resumen: {
      hoy: '2026-11-17', saldo_total: saldo, vencido_total: saldo, pct_vencido: 100, dso: null, ventas_90d: 0,
      n_clientes: clientes.length, pago: null, concentracion: { top10_pct: 0, top10: [] },
      proyeccion: { vencido: 0, d0_7: 0, d8_15: 0, d16_30: 0, d30_plus: 0, sin_fecha: 0 },
      por_vendedor: [], por_zona: [], base_rollups: 'documento', sin_documento: { monto: 0, clientes: 0 },
    } as never,
    filtros: { sucursales: [], grupos: [], zonas: [], vendedores: [], cuentas: [] },
  } as CarteraResp;
}

const DET: CarteraDetalle = {
  hoy: '2026-11-17',
  cliente: { sucursal: '01', cliente_code: 'C1', cliente_nombre: 'Abarrotes Uno', rfc: null, vendedor: null, vendedor_nombre: null, grupo: null, zona: null, telefono: null, limite_credito: null, dias_credito: null },
  saldo: 100, vencido: 100, saldo_a_favor: 0, dias_pago_prom: null, n_pagos: 0, pagadas: 0, importe_pagado: 0,
  partidas: [], abonos: [], compromisos: [], cobranza: null, sin_documento: 0,
} as unknown as CarteraDetalle;

describe('FinanzasCarteraComponent — [CXC.41]', () => {
  let cartera: ReturnType<typeof vi.fn>;
  let detalle: ReturnType<typeof vi.fn>;
  let createPromise: ReturnType<typeof vi.fn>;
  let query: Record<string, string>;

  function configurar() {
    TestBed.configureTestingModule({
      imports: [FinanzasCarteraComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
        { provide: CarteraService, useValue: { cartera, detalle, createPromise, tendencia: () => of([]), resolvePromise: () => of({}) } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => true } },
      ],
    });
  }

  beforeEach(() => {
    query = {};
    cartera = vi.fn(() => of(resp([cli('C1', 'Abarrotes Uno', 100, 100)])));
    detalle = vi.fn(() => of(DET));
    createPromise = vi.fn(() => of({ id: 'p1', estado: 'abierta' }));
  });

  afterEach(() => TestBed.resetTestingModule());

  function crear() {
    configurar();
    const f = TestBed.createComponent(FinanzasCarteraComponent);
    f.detectChanges();
    return f;
  }
  const el = (f: { nativeElement: HTMLElement }) => f.nativeElement as HTMLElement;

  it('1 · abre en «Cliente», ordenada por más vencido', () => {
    crear();
    expect(cartera).toHaveBeenCalledTimes(1);
    expect(cartera.mock.calls[0][0]).toMatchObject({ cuenta: 'cliente_final', sort: 'vencido' });
  });

  it('1b · un enlace ?cliente= abre en «Todas»: ese cliente puede ser una cuenta interna', () => {
    query = { cliente: 'C1', suc: '01' };
    crear();
    expect(cartera.mock.calls[0][0].cuenta).toBeUndefined();
    expect(cartera.mock.calls[0][0].search).toBe('C1');
  });

  it('2 · ⛔ una carga nueva cancela la anterior: la respuesta vieja no pinta encima', () => {
    const primera = new Subject<CarteraResp>();
    const segunda = new Subject<CarteraResp>();
    cartera = vi.fn().mockReturnValueOnce(primera).mockReturnValueOnce(segunda);
    const f = crear();
    f.componentInstance.sucursal = '07';
    f.componentInstance.load();
    segunda.next(resp([cli('NUEVO', 'Filtro nuevo', 5, 5)], { marca: 'segunda' }));
    primera.next(resp([cli('VIEJO', 'Filtro viejo', 9, 9)], { marca: 'primera' }));
    f.detectChanges();
    expect(f.componentInstance.data()?.hoy).toBe('segunda');
    expect(el(f).textContent).toContain('Filtro nuevo');
    expect(el(f).textContent).not.toContain('Filtro viejo');
  });

  it('3 · con «Cliente» elegido, la tira sigue mostrando internas y rutas (universo sin filtro de tipo)', () => {
    cartera = vi.fn(() => of(resp([cli('C1', 'Abarrotes Uno', 100, 100)], {
      porTipo: tipos(100, 0, 0), universo: tipos(100, 300, 50),
    })));
    const f = crear();
    const tiles = Array.from(el(f).querySelectorAll('.ct-tipo'));
    expect(tiles.map((t) => t.querySelector('.ct-tipo-h')?.textContent?.trim().split(' ')[0])).toEqual(['Cliente', 'Cuenta', 'Ruta']);
    expect(tiles[1].textContent).toContain('300');
    expect(tiles[0].classList.contains('on')).toBe(true);
    // El saldo de arriba dice de qué tipo es.
    expect(el(f).textContent).toContain('Saldo · Cliente');
  });

  it('4 · el tope se dice ARRIBA de la tabla', () => {
    cartera = vi.fn(() => of(resp([cli('C1', 'Abarrotes Uno', 100, 100)], { total: 1455 })));
    const f = crear();
    const aviso = el(f).querySelector('.ct-more-top');
    const tabla = el(f).querySelector('.ct-table');
    expect(aviso?.textContent).toContain('1,455');
    expect(aviso && tabla && (aviso.compareDocumentPosition(tabla) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  });

  it('5 · el CSV pide TODAS las cuentas del filtro y avisa si aun así se corta', () => {
    const f = crear();
    const crearUrl = vi.fn(() => 'blob:x');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = crearUrl;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    cartera.mockReturnValueOnce(of(resp([cli('C1', 'Abarrotes Uno', 100, 100)], { total: 7000 })));
    f.componentInstance.exportCsv();
    f.detectChanges();
    expect(cartera.mock.calls[1][0]).toMatchObject({ limit: 5000, cuenta: 'cliente_final', sort: 'vencido' });
    expect(crearUrl).toHaveBeenCalledTimes(1);
    expect(f.componentInstance.csvAviso()?.error).toBe(true);
    expect(el(f).querySelector('.ct-csv-aviso')?.textContent).toContain('7,000');
  });

  it('6 · el monto del compromiso acepta la forma y no adivina el significado', () => {
    const c = crear().componentInstance;
    const m = (t: string) => { c.promMontoTxt = t; return c.montoPromesa(); };
    expect(m('1,250.00')).toBe(1250);
    expect(m('$1250')).toBe(1250);
    expect(m(' 980.5 ')).toBe(980.5);
    expect(m('0')).toBeNull();
    expect(m('-5')).toBeNull();
    expect(m('12.345')).toBeNull();
    expect(m('abc')).toBeNull();
  });

  it('7 · ⛔ un guardado de compromiso que falla se VE, y lo tecleado se queda', () => {
    createPromise = vi.fn(() => throwError(() => ({ error: { message: 'monto inválido' } })));
    const f = crear();
    const c = f.componentInstance;
    c.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    c.promFormAbierto.set(true);
    c.promMontoTxt = '500';
    c.promFecha = new Date(2026, 10, 20);
    c.savePromise(DET);
    f.detectChanges();
    expect(c.promError()).toContain('No se guardó el compromiso');
    expect(c.promMontoTxt).toBe('500');
    expect(c.savingProm()).toBe(false);
  });

  it('8 · la fila se abre con Enter', () => {
    const f = crear();
    const fila = el(f).querySelector('tr.ct-row') as HTMLElement;
    expect(fila.getAttribute('tabindex')).toBe('0');
    fila.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(detalle).toHaveBeenCalledWith('01', 'C1');
  });
});
