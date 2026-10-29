import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { HojaGastos, HojasDeGastos, RenglonHoja } from '@megadulces/contracts';
import { FinanzasHojaGastosComponent } from './finanzas-hoja-gastos.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[CGA-A.65]` La hoja de gastos de zona en pantalla: lo que se ve, quién puede qué, y qué viaja al
 * servidor al cerrar (QUÉ pagos y la venta del día; nunca importes: el servidor los relee de Kepler).
 */
const r = (suc: string, folio: string, benef: string, importe: number, clase: RenglonHoja['clase']): RenglonHoja => ({
  origen_ref: `${suc}|X-D-26|${folio}|0011`, sucursal: suc, doc_tipo: 'X-D-26', folio, fecha_pago: '2026-10-23',
  fecha_captura: '2026-10-23', beneficiario: benef, clave: clase === 'gasto' ? 'GG015' : 'CB013', centro: '007', clase, importe,
});
const RENGLONES = [
  r('08', '0000534', 'BOTANAS PAU', 7330, 'proveedor'),
  r('08', '0000538', 'GASTOS GENERALES CAJA CHICA MORELIA ABASTOS', 605.89, 'gasto'),
  r('07', '0000282', 'CUERITOS PREMIUM ZACAPU', 2850, 'proveedor'),
];
const hoja = (numero: number, estado: HojaGastos['estado'], cerradaPor: string, extra: Partial<HojaGastos> = {}): HojaGastos => ({
  id: `h${numero}`, numero, folio: `HG-${numero}`, zona: 'morelia', nombre_zona: 'Zona Morelia', venta_del_dia: '2026-10-23', estado,
  total: 58953.69, renglones: RENGLONES, por_sucursal: [{ sucursal: '08', renglones: 2, total: 7935.89 }, { sucursal: '07', renglones: 1, total: 2850 }],
  cerrada_por: cerradaPor, cerrada_por_nombre: 'aaron', cerrada_at: '2026-10-23T18:00:00Z', aprobada_por_nombre: null, aprobada_at: null,
  resuelta_por_nombre: null, resuelta_at: null, motivo: null,
  instruccion: { retiro: 58950, cajon: 3.69, deposito: 58953.69, referencia: `HG-${numero}` }, pago: null, ...extra,
});
const DATOS = (o: Partial<HojasDeGastos> = {}): HojasDeGastos => ({
  abiertas: [
    {
      zona: 'morelia', nombre: 'Zona Morelia', desde: '2026-10-23', renglones: RENGLONES, total: 10785.89,
      por_sucursal: [{ sucursal: '08', renglones: 2, total: 7935.89 }, { sucursal: '07', renglones: 1, total: 2850 }],
      por_clase: [{ clase: 'proveedor', renglones: 2, total: 10180 }, { clase: 'gasto', renglones: 1, total: 605.89 }],
      fuera: [{ ...r('08', '0000530', 'CAPITAN DE MARCA', 1050, 'gasto'), motivo: 'apoyo_proveedores' }],
      instruccion: { retiro: 10780, cajon: 5.89, deposito: 10785.89, referencia: null }, datos_al: '2026-10-29T18:00:00Z',
    },
    { zona: 'canindo', nombre: 'Zona Canindo', desde: '2026-10-29', renglones: [], total: 0, por_sucursal: [{ sucursal: '06', renglones: 0, total: 0 }],
      por_clase: [], fuera: [], instruccion: null, datos_al: '2026-10-29T18:00:00Z' },
  ],
  cerradas: [
    hoja(2, 'cerrada', 'u-zona'),
    hoja(1, 'aprobada', 'u-zona', { aprobada_por_nombre: 'maria', aprobada_at: '2026-10-23T19:00:00Z',
      pago: { estado: 'retiro_recibido', retiro: { device: 'AST700', external_id: 1707, ref: 'gnf ma HG-1', total: 58900, dia: '2026-10-23' },
        retiros_extra: 0, depositos: null, nota: 'El depósito todavía no aparece en el estado de cuenta.' } }),
  ],
  instalada: true, datos_al: '2026-10-29T18:00:00Z', caos_al: '2026-10-29T18:00:00Z', ...o,
});

describe('[CGA-A.65] FinanzasHojaGastosComponent', () => {
  let fix: ComponentFixture<FinanzasHojaGastosComponent>;
  let http: HttpTestingController;

  const montar = (permisos: Permission[], yo: string, datos: HojasDeGastos = DATOS()) => {
    TestBed.configureTestingModule({
      imports: [FinanzasHojaGastosComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: PermissionsService, useValue: { has: (p: string) => permisos.includes(p as Permission) } },
        { provide: AuthService, useValue: { user: signal({ sub: yo, username: yo, exp: 0, iat: 0 }) } },
      ],
    });
    fix = TestBed.createComponent(FinanzasHojaGastosComponent);
    http = TestBed.inject(HttpTestingController);
    fix.detectChanges();
    const req = http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos'));
    expect(req.request.method).toBe('GET');
    req.flush(datos);
    fix.detectChanges();
  };
  const txt = () => fix.nativeElement.textContent as string;
  const boton = (texto: string) => ([...fix.nativeElement.querySelectorAll('button')] as HTMLButtonElement[])
    .find((b) => b.textContent?.includes(texto)) ?? null;

  afterEach(() => http.verify());

  it('abre en la zona que tiene pagos, con su total y los nombres de las sucursales (no su código)', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    expect(txt()).toContain('Hoja abierta');
    expect(txt()).toContain('$10,785.89');
    expect(txt()).toContain('Morelia Abastos');
    expect(txt()).toContain('Morelia Madero');
  });

  it('lo que no va en la hoja se ve, con su motivo', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    expect(txt()).toContain('1 pago no va en la hoja');
    expect(txt()).toContain('Apoyo a proveedores (Capitán de marca, bonos)');
  });

  it('⭐ cerrar manda QUÉ pagos, la venta del día y la llave — nunca un importe', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    // La persona deja fuera el de caja chica.
    fix.componentInstance.elegir([RENGLONES[0], RENGLONES[2]]);
    fix.detectChanges();
    expect(txt()).toContain('$10,180.00');
    boton('Cerrar hoja')!.click();
    const req = http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos/morelia/cerrar'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body.origen_refs).toEqual([RENGLONES[0].origen_ref, RENGLONES[2].origen_ref]);
    expect(req.request.body.venta_del_dia).toBe('2026-10-23');
    expect(String(req.request.body.client_key).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(req.request.body).sort()).toEqual(['client_key', 'origen_refs', 'venta_del_dia']);
    req.flush(hoja(3, 'cerrada', 'u-zona'));
    http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos')).flush(DATOS());
  });

  it('NEGATIVA: sin la clave de cerrar no hay botón, y dice quién la cierra', () => {
    montar([Permission.FINANCE_CAJA_VER], 'u-caja');
    expect(boton('Cerrar hoja')).toBeNull();
    expect(txt()).toContain('La cierra quien autoriza por la zona');
  });

  it('finanzas aprueba la que cerró otra persona', () => {
    montar([Permission.FINANCE_EXPENSES_COMPROBAR], 'u-fin');
    expect(boton('Aprobar')).not.toBeNull();
    boton('Aprobar')!.click();
    const req = http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos/h2/aprobar'));
    expect(req.request.method).toBe('POST');
    req.flush(hoja(2, 'aprobada', 'u-zona'));
    http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos')).flush(DATOS());
  });

  it('NEGATIVA (cuatro ojos): quien la cerró no ve «Aprobar» en su propia hoja', () => {
    montar([Permission.FINANCE_EXPENSES_COMPROBAR, Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    expect(boton('Aprobar')).toBeNull();
    expect(txt()).toContain('La cerraste tú: la aprueba otra persona');
  });

  it('la aprobada dice cuánto sacar de CAOS, con qué referencia, y cómo va su pago', () => {
    montar([Permission.FINANCE_CAJA_VER], 'u-caja');
    expect(txt()).toContain('con la referencia');
    expect(txt()).toContain('HG-1');
    expect(txt()).toContain('Retiro recibido');
    expect(txt()).toContain('El depósito todavía no aparece en el estado de cuenta.');
  });

  it('sin la migración aplicada: lo dice, y no deja cerrar', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona', DATOS({ instalada: false, cerradas: [] }));
    expect(txt()).toContain('todavía no se puede cerrar');
    expect(boton('Cerrar hoja')?.disabled).toBe(true);
  });
});
