import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { HojaGastos, HojasDeGastos, PagoHojaResultado, RenglonHoja } from '@megadulces/contracts';
import { FinanzasHojaGastosComponent } from './finanzas-hoja-gastos.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[CGA-A.65]` La hoja de gastos de zona en pantalla: lo que se ve, quién puede qué, y qué viaja al
 * servidor al cerrar (QUÉ pagos y la venta del día; nunca importes: el servidor los relee de Kepler)
 * y al pagar (SÓLO el retiro que la paga: los importes y el reparto los pone el servidor).
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
const RETIRO = { device: 'AST700-19758', external_id: 1707, ref: 'gnf ma', total: 58900, dia: '2026-10-23', cajon: 53.69 };
const hoja = (numero: number, estado: HojaGastos['estado'], cerradaPor: string, extra: Partial<HojaGastos> = {}): HojaGastos => ({
  id: `h${numero}`, numero, folio: `HG-${numero}`, zona: 'morelia', nombre_zona: 'Zona Morelia', venta_del_dia: '2026-10-23', estado,
  total: 58953.69, renglones: RENGLONES, por_sucursal: [{ sucursal: '08', renglones: 2, total: 7935.89 }, { sucursal: '07', renglones: 1, total: 2850 }],
  cerrada_por: cerradaPor, cerrada_por_nombre: 'aaron', cerrada_at: '2026-10-23T18:00:00Z',
  aprobada_por: null, aprobada_por_nombre: null, aprobada_at: null,
  resuelta_por_nombre: null, resuelta_at: null, motivo: null,
  instruccion: { retiro: 58950, cajon: 3.69, deposito: 58953.69, referencia: `HG-${numero}` }, retiros_que_cuadran: [], pago: null, ...extra,
});
const aprobada = { aprobada_por: 'u-fin', aprobada_por_nombre: 'maria', aprobada_at: '2026-10-23T19:00:00Z' };
const DATOS = (o: Partial<HojasDeGastos> = {}): HojasDeGastos => ({
  abiertas: [
    {
      zona: 'morelia', nombre: 'Zona Morelia', desde: '2026-10-23', renglones: RENGLONES, total: 10785.89,
      por_sucursal: [{ sucursal: '08', renglones: 2, total: 7935.89 }, { sucursal: '07', renglones: 1, total: 2850 }],
      por_clase: [{ clase: 'proveedor', renglones: 2, total: 10180 }, { clase: 'gasto', renglones: 1, total: 605.89 }],
      fuera: [{ ...r('08', '0000530', 'CAPITAN DE MARCA', 1050, 'gasto'), motivo: 'apoyo_proveedores' }],
      pagados_aparte: [{ ...r('07', '0000290', 'ESTACION DE SERVICIO TAVISA', 400, 'gasto'), como: 'cajon', cg_folio: 'CG-2026-00600' }],
      instruccion: { retiro: 10780, cajon: 5.89, deposito: 10785.89, referencia: null }, datos_al: '2026-10-29T18:00:00Z',
    },
    { zona: 'canindo', nombre: 'Zona Canindo', desde: '2026-10-29', renglones: [], total: 0, por_sucursal: [{ sucursal: '06', renglones: 0, total: 0 }],
      por_clase: [], fuera: [], pagados_aparte: [], instruccion: null, datos_al: '2026-10-29T18:00:00Z' },
  ],
  cerradas: [
    hoja(3, 'pagada', 'u-zona', { ...aprobada, pago: {
      medio: 'caos', retiro: { device: RETIRO.device, external_id: 1706, ref: 'gnf morelia', total: 58900, dia: '2026-10-23' }, cajon: 53.69,
      pagada_por_nombre: 'carmen', pagada_at: '2026-10-23T20:00:00Z', sin_capturar: 1,
      deposito: { estado: 'no_aparece', depositos: null, nota: 'El depósito todavía no aparece en el estado de cuenta.' } } }),
    hoja(2, 'cerrada', 'u-zona'),
    hoja(1, 'aprobada', 'u-zona', { ...aprobada, retiros_que_cuadran: [RETIRO] }),
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
  /** Los botones de la página y los de las ventanas (que se pintan en `body`). */
  const botones = (texto: string) => ([...document.body.querySelectorAll('button')] as HTMLButtonElement[])
    .filter((b) => b.textContent?.includes(texto));
  const boton = (texto: string) => ([...fix.nativeElement.querySelectorAll('button')] as HTMLButtonElement[])
    .find((b) => b.textContent?.includes(texto)) ?? null;
  const resultado = (h: HojaGastos, extra: Partial<PagoHojaResultado> = {}): PagoHojaResultado =>
    ({ hoja: h, ligados: 0, capturados: 3, sin_capturar: [], ...extra });

  afterEach(() => http.verify());

  it('abre en la zona que tiene pagos, con su total y los nombres de las sucursales (no su código)', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    expect(txt()).toContain('Hoja abierta');
    expect(txt()).toContain('$10,785.89');
    expect(txt()).toContain('Morelia Abastos');
    expect(txt()).toContain('Morelia Madero');
  });

  it('abajo: lo que no va en la hoja con su motivo, y lo que ya salió del cajón sin hoja', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    expect(txt()).toContain('1 pago no va en la hoja');
    expect(txt()).toContain('Apoyo a proveedores (Capitán de marca, bonos)');
    expect(txt()).toContain('1 pago ya salió de Caja General sin hoja');
    expect(txt()).toContain('Del cajón · CG-2026-00600');
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
    req.flush(hoja(4, 'cerrada', 'u-zona'));
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
    req.flush(hoja(2, 'aprobada', 'u-zona', aprobada));
    http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos')).flush(DATOS());
  });

  it('NEGATIVA (cuatro ojos): quien la cerró no ve «Aprobar» en su propia hoja', () => {
    montar([Permission.FINANCE_EXPENSES_COMPROBAR, Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona');
    expect(boton('Aprobar')).toBeNull();
    expect(txt()).toContain('La cerraste tú: la aprueba otra persona');
  });

  it('⭐ Caja General paga la aprobada de un clic con el retiro que la cuadra, y manda SÓLO el retiro', () => {
    montar([Permission.FINANCE_CAJA_GESTIONAR, Permission.FINANCE_CAJA_VER], 'u-caja');
    expect(txt()).toContain('Cuadra el retiro «gnf ma» del 23/10');
    boton('Pagar HG-1')!.click();
    fix.detectChanges();
    // Un solo retiro cuadra: ya viene elegido. El de la ventana es el último «Pagar HG-1».
    expect(fix.componentInstance.eleccion()).toBe('AST700-19758|1707');
    botones('Pagar HG-1').pop()!.click();
    const req = http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos/h1/pagar'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ medio: 'caos', device: 'AST700-19758', external_id: 1707 });
    req.flush(resultado(hoja(1, 'pagada', 'u-zona', aprobada)));
    http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos')).flush(DATOS());
  });

  it('por excepción, con el cajón: pide contar lo que sale y no paga hasta que cuadra (Edgar, 2026-10-30)', () => {
    montar([Permission.FINANCE_CAJA_GESTIONAR, Permission.FINANCE_CAJA_VER], 'u-caja');
    boton('Pagar HG-1')!.click();
    fix.componentInstance.eleccion.set('cajon');
    fix.detectChanges();
    expect(document.body.textContent).toContain('cuenta las piezas que entregas');
    // [negativa] sin conteo, «Pagar» no manda nada
    botones('Pagar HG-1').pop()!.click();
    http.expectNone((q) => q.url.endsWith('/finance/hoja-gastos/h1/pagar'));
    // El total en piezas del catálogo (de la mayor a la menor) y lo de menos de 50¢ como morralla.
    let resto = Math.round(fix.componentInstance.pagando()!.total * 100);
    const piezas: Record<string, number> = {};
    for (const [k, c] of [['1000', 100000], ['500', 50000], ['200', 20000], ['100', 10000], ['50', 5000], ['20', 2000], ['10', 1000], ['5', 500], ['2', 200], ['1', 100], ['0.5', 50]] as const) {
      const n = Math.floor(resto / c);
      if (n > 0) { piezas[k] = n; resto -= n * c; }
    }
    fix.componentInstance.conteoPiezas.set(piezas);
    fix.componentInstance.conteoMorralla.set(resto / 100);
    fix.detectChanges();
    expect(fix.componentInstance.conteoListo()).toBe(true);
    botones('Pagar HG-1').pop()!.click();
    const req = http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos/h1/pagar'));
    expect(req.request.body).toEqual({ medio: 'cajon', conteo: { piezas, morralla: resto / 100 } });
    req.flush(resultado(hoja(1, 'pagada', 'u-zona', aprobada)));
    http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos')).flush(DATOS());
  });

  it('NEGATIVA (cuatro ojos): quien aprobó la hoja no ve «Pagar»', () => {
    montar([Permission.FINANCE_CAJA_GESTIONAR, Permission.FINANCE_EXPENSES_COMPROBAR], 'u-fin');
    expect(boton('Pagar HG-1')).toBeNull();
    expect(txt()).toContain('La aprobaste tú: la paga otra persona');
  });

  it('NEGATIVA: sin la clave de la caja no hay «Pagar» (y la cerrada nunca lo tiene); dice cómo se paga', () => {
    montar([Permission.FINANCE_CAJA_VER], 'u-caja');
    expect(boton('Pagar')).toBeNull();
    expect(txt()).toContain('La paga Caja General con un solo retiro');
  });

  it('la pagada dice con qué se pagó, si llegó el depósito y lo que falta capturar; se reintenta', () => {
    montar([Permission.FINANCE_CAJA_GESTIONAR, Permission.FINANCE_CAJA_VER], 'u-caja');
    expect(txt()).toContain('Retiro «gnf morelia» $58,900.00 · cajón $53.69');
    expect(txt()).toContain('Sin depósito todavía');
    expect(txt()).toContain('1 pago sin capturar en el libro');
    boton('Capturar lo que falta')!.click();
    const req = http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos/h3/capturar'));
    expect(req.request.method).toBe('POST');
    req.flush(resultado(hoja(3, 'pagada', 'u-zona', aprobada), { capturados: 1 }));
    http.expectOne((q) => q.url.endsWith('/finance/hoja-gastos')).flush(DATOS());
  });

  it('sin la migración aplicada: lo dice, y no deja cerrar', () => {
    montar([Permission.FINANCE_HOJA_GASTOS_CERRAR], 'u-zona', DATOS({ instalada: false, cerradas: [] }));
    expect(txt()).toContain('todavía no se puede cerrar');
    expect(boton('Cerrar hoja')?.disabled).toBe(true);
  });
});
