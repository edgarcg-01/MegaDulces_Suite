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
import { NEVER, of, Subject, throwError } from 'rxjs';
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
  let enlaceDeposito: ReturnType<typeof vi.fn>;

  function configurar() {
    TestBed.configureTestingModule({
      imports: [FinanzasCarteraComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
        { provide: CarteraService, useValue: { cartera, detalle, createPromise, tendencia: () => of([]), resolvePromise: () => of({}), enlaceDeposito } },
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
    enlaceDeposito = vi.fn(() => of({ url: 'https://suite.test/deposito/TOKEN' }));
  });

  afterEach(() => TestBed.resetTestingModule());

  function crear() {
    configurar();
    const f = TestBed.createComponent(FinanzasCarteraComponent);
    f.detectChanges();
    return f;
  }
  const el = (f: { nativeElement: HTMLElement }) => f.nativeElement as HTMLElement;

  it('1 · abre en «Cliente», ordenada por más vencido, y pide TODAS las cuentas del filtro', () => {
    cartera = vi.fn(() => of(resp([cli('S', 'Mucho saldo', 900, 10), cli('V', 'Mucho vencido', 100, 100)])));
    const f = crear();
    expect(cartera).toHaveBeenCalledTimes(1);
    expect(cartera.mock.calls[0][0]).toMatchObject({ cuenta: 'cliente_final', limit: 5000 });
    expect(f.componentInstance.visibles()[0].cliente_code).toBe('V');
  });

  it('1b · un enlace ?cliente= abre en «Todas» y deja la búsqueda puesta', () => {
    query = { cliente: 'C1', suc: '01' };
    const f = crear();
    expect(cartera.mock.calls[0][0].cuenta).toBeUndefined();
    expect(f.componentInstance.busqueda()).toBe('C1');
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

  it('4 · la tabla pinta hasta 500 y el tope se dice ARRIBA de ella', () => {
    const muchas = Array.from({ length: 620 }, (_, i) => cli(`C${i}`, `Cliente ${i}`, 1000 - i, 1000 - i));
    cartera = vi.fn(() => of(resp(muchas)));
    const f = crear();
    const aviso = el(f).querySelector('.ct-more-top');
    const tabla = el(f).querySelector('.ct-table');
    expect(el(f).querySelectorAll('tr.ct-row').length).toBe(500);
    expect(aviso?.textContent).toContain('620');
    expect(aviso && tabla && (aviso.compareDocumentPosition(tabla) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  });

  it('5 · el CSV sale de memoria con TODAS las cuentas de lo que ves, sin otra petición', () => {
    const muchas = Array.from({ length: 620 }, (_, i) => cli(`C${i}`, `Cliente ${i}`, 1000 - i, 1000 - i));
    cartera = vi.fn(() => of(resp(muchas)));
    const f = crear();
    // jsdom no trae Blob.text(): se lee con FileReader, y se ESPERA su onload (un setTimeout(0)
    // no alcanza: la lectura es asíncrona y su duración varía).
    let leido!: Promise<string>;
    const crearUrl = vi.fn((b: Blob) => {
      leido = new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsText(b); });
      return 'blob:x';
    });
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = crearUrl;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    f.componentInstance.exportCsv();
    f.detectChanges();
    expect(cartera).toHaveBeenCalledTimes(1);
    expect(crearUrl).toHaveBeenCalledTimes(1);
    expect(f.componentInstance.csvAviso()?.texto).toContain('620 cuentas');
    return leido.then((csv) => {
      expect(csv.trim().split('\n').length).toBe(621); // encabezado + 620
    });
  });

  it('5b · si el servidor se cortó (más de 5,000), el CSV lo dice', () => {
    cartera = vi.fn(() => of(resp([cli('C1', 'Abarrotes Uno', 100, 100)], { total: 7000 })));
    const f = crear();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    f.componentInstance.exportCsv();
    f.detectChanges();
    expect(f.componentInstance.csvAviso()?.error).toBe(true);
    expect(el(f).querySelector('.ct-csv-aviso')?.textContent).toContain('7,000');
  });

  it('9 · la búsqueda es instantánea: sin Enter, sin otra petición, sin acentos y por varias palabras', () => {
    cartera = vi.fn(() => of(resp([
      cli('C1', 'Abarrotes Peña', 100, 100), cli('C2', 'Dulcería La Estrella', 50, 50, { rfc: 'DLE010101AAA' }),
      cli('C3', 'Abarrotes Sol', 30, 30),
    ])));
    const f = crear();
    const c = f.componentInstance;
    c.busqueda.set('pena');
    f.detectChanges();
    expect(c.filtradas().map((x) => x.cliente_code)).toEqual(['C1']);
    c.busqueda.set('abarrotes sol');
    expect(c.filtradas().map((x) => x.cliente_code)).toEqual(['C3']);
    c.busqueda.set('dle0101');
    f.detectChanges();
    expect(c.filtradas().map((x) => x.cliente_code)).toEqual(['C2']);
    expect(el(f).textContent).toContain('Los totales de arriba son del filtro');
    expect(cartera).toHaveBeenCalledTimes(1);
  });

  it('10 · el orden cambia al instante, sin otra petición', () => {
    cartera = vi.fn(() => of(resp([cli('S', 'Mucho saldo', 900, 10), cli('V', 'Mucho vencido', 100, 100)])));
    const f = crear();
    f.componentInstance.orden.set('saldo');
    f.detectChanges();
    expect((el(f).querySelector('tr.ct-row') as HTMLElement).textContent).toContain('Mucho saldo');
    expect(cartera).toHaveBeenCalledTimes(1);
  });

  it('11 · «Siguiente cliente» abre la ficha que ya se pidió por adelantado', () => {
    cartera = vi.fn(() => of(resp([cli('A', 'Primero', 300, 300), cli('B', 'Segundo', 200, 200)])));
    detalle = vi.fn((suc: string, code: string) => of({ ...DET, cliente: { ...DET.cliente, cliente_code: code, cliente_nombre: code === 'A' ? 'Primero' : 'Segundo' } }));
    const f = crear();
    const c = f.componentInstance;
    c.openDetalle(c.visibles()[0]);
    expect(detalle.mock.calls.map((a) => a[1])).toEqual(['A', 'B']); // la ficha y la precarga
    c.irA(1);
    f.detectChanges();
    expect(detalle).toHaveBeenCalledTimes(2); // la segunda salió de la caché
    expect(c.detalle()?.cliente.cliente_nombre).toBe('Segundo');
    expect(c.posicion()).toEqual({ i: 1, n: 2 });
  });

  it('12 · la primera carga reserva su lugar con un esqueleto (no brinca) y no dibuja la tabla', () => {
    const pendiente = new Subject<CarteraResp>();
    cartera = vi.fn(() => pendiente);
    const f = crear();
    expect(el(f).querySelector('app-load-state .ls-sk')).toBeTruthy();
    expect(el(f).querySelector('.ct-table')).toBeNull();
    pendiente.next(resp([cli('C1', 'Abarrotes Uno', 100, 100)]));
    f.detectChanges();
    expect(el(f).querySelector('.ct-table')).toBeTruthy();
  });

  it('13 · mientras se aplica un filtro se ve «Actualizando…» y lo viejo queda atenuado', () => {
    const segunda = new Subject<CarteraResp>();
    cartera = vi.fn().mockReturnValueOnce(of(resp([cli('C1', 'Abarrotes Uno', 100, 100)]))).mockReturnValueOnce(segunda);
    const f = crear();
    f.componentInstance.load();
    f.detectChanges();
    expect(el(f).querySelector('.ct-actualizando')?.textContent).toContain('Actualizando');
    expect(el(f).querySelector('.ct-cuerpo')?.classList.contains('ct-cargando')).toBe(true);
    segunda.next(resp([cli('C2', 'Otro', 5, 5)]));
    f.detectChanges();
    expect(el(f).querySelector('.ct-actualizando')).toBeNull();
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

  it('14 · [CXC.43] el ACTO registra el contacto y la fila dice «hoy»', () => {
    cartera = vi.fn(() => of({ ...resp([cli('C1', 'Abarrotes Uno', 100, 100)]), contactos_medidos: true }));
    const ahora = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const registrarContacto = vi.fn(() => of({ id: 'k1', canal: 'whatsapp' as const, contacted_at: ahora }));
    configurar();
    TestBed.overrideProvider(CarteraService, { useValue: { cartera, detalle, createPromise, registrarContacto, tendencia: () => of([]), resolvePromise: () => of({}), enlaceDeposito } });
    const f = TestBed.createComponent(FinanzasCarteraComponent);
    f.detectChanges();
    const c = f.componentInstance;
    c.registrarContacto(DET, 'whatsapp');
    c.registrarContacto(DET, 'whatsapp'); // doble clic: no se repite
    f.detectChanges();
    expect(registrarContacto).toHaveBeenCalledTimes(1);
    expect(registrarContacto).toHaveBeenCalledWith('01', 'C1', 'whatsapp');
    expect(el(f).querySelector('.ct-contactado-hoy')?.textContent).toContain('hoy');
    expect(c.contactoTexto(DET)?.texto).toContain('por WhatsApp');
  });

  it('15 · [CXC.43] sin la tabla de contactos, la ficha lo DECLARA y la fila no afirma nada', () => {
    cartera = vi.fn(() => of({ ...resp([cli('C1', 'Abarrotes Uno', 100, 100, { ultimo_contacto: { at: new Date().toISOString(), canal: 'telefono', por: null } })]), contactos_medidos: false }));
    const f = crear();
    expect(el(f).querySelector('.ct-contactado')).toBeNull();
    expect(f.componentInstance.contactoTexto(DET)?.texto).toContain('todavía no está activo');
  });

  it('16 · [CXC.43] un contacto que no quedó registrado SE DICE', () => {
    cartera = vi.fn(() => of({ ...resp([cli('C1', 'Abarrotes Uno', 100, 100)]), contactos_medidos: true }));
    configurar();
    TestBed.overrideProvider(CarteraService, { useValue: { cartera, detalle, createPromise, registrarContacto: () => throwError(() => ({ status: 500 })), tendencia: () => of([]), resolvePromise: () => of({}), enlaceDeposito } });
    const f = TestBed.createComponent(FinanzasCarteraComponent);
    f.detectChanges();
    f.componentInstance.registrarContacto(DET, 'telefono');
    expect(f.componentInstance.contactoTexto(DET)).toMatchObject({ error: true });
    expect(f.componentInstance.contactoTexto(DET)?.texto).toContain('No quedó registrado');
  });

  it('17 · [CC.20] el enlace de depósito del cliente va en el mensaje de WhatsApp', () => {
    const f = crear();
    const c = f.componentInstance;
    c.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    expect(enlaceDeposito).toHaveBeenCalledWith('01', 'C1');
    const det = { ...DET, partidas: [], cliente: { ...DET.cliente, telefono: '3312345678' } } as CarteraDetalle;
    expect(decodeURIComponent(c.waLink(det))).toContain('https://suite.test/deposito/TOKEN');
    // Sin enlace, el mensaje sale como antes (pide compartir el comprobante).
    c.enlaceDeposito.set(null);
    expect(decodeURIComponent(c.waLink(det))).not.toContain('/deposito/');
  });

  it('18 · [CC.20] la ficha muestra las fichas que subió el cliente, y lo por revisar lleva a Cobranza', () => {
    detalle = vi.fn(() => of({ ...DET, depositos_reportados: [
      { id: 'r1', status: 'recibido', folio: null, motivo_rechazo: null, monto: 12500, fecha: '2026-11-15', banco: 'BBVA', reportado: '2026-11-15T10:00:00Z' },
      { id: 'r2', status: 'validado', folio: '4820', motivo_rechazo: null, monto: 300, fecha: '2026-11-10', banco: null, reportado: '2026-11-10T10:00:00Z' },
    ] }));
    const f = crear();
    f.componentInstance.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    f.detectChanges();
    const txt = (document.body.textContent || '');
    expect(txt).toContain('Fichas que subió el cliente');
    expect(txt).toContain('Por revisar en Cobranza');
    expect(txt).toContain('Aplicada · cobro 4820');
  });

  it('18b · [CXC.46] pagos que Kepler no aplicó a ninguna factura se dicen como tales, no como «cobros de más»', () => {
    detalle = vi.fn(() => of({ ...DET, sin_documento: -14295.92 }));
    const f = crear();
    f.componentInstance.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    f.detectChanges();
    const nota = (document.body.querySelector('.ct-sin-doc')?.textContent || '').replace(/\s+/g, ' ');
    expect(nota).toContain('14,295.92');
    expect(nota).toContain('en pagos que Kepler todavía no aplica a ninguna factura');
    expect(nota).not.toContain('por encima');
    expect(nota).not.toContain('-$');
    // Y la nota del pie ya no promete el reparto «a las partidas más viejas».
    expect(document.body.textContent || '').not.toContain('partidas más viejas primero');
  });

  it('18c · [CXC.46] con saldo que ninguna factura explica, sigue el aviso de siempre', () => {
    detalle = vi.fn(() => of({ ...DET, sin_documento: 500 }));
    const f = crear();
    f.componentInstance.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    f.detectChanges();
    expect(document.body.querySelector('.ct-sin-doc')?.textContent || '').toContain('por encima de lo que la cuenta justifica');
  });

  it('19 · [CXC.44] UN solo botón entrega el estado de cuenta: chat del teléfono + contacto, con el enlace adentro (y el PDF va EN el enlace: [CC.20.2])', () => {
    const conTel = { ...DET, cliente: { ...DET.cliente, telefono: '3314855906' } } as CarteraDetalle;
    detalle = vi.fn(() => of(conTel));
    const estadoCuentaPdf = vi.fn(() => NEVER); // el PDF sigue generándose: el segundo clic no lo pide otra vez
    const registrarContacto = vi.fn(() => of({ id: 'k1', canal: 'whatsapp' as const, contacted_at: new Date().toISOString() }));
    configurar();
    TestBed.overrideProvider(CarteraService, { useValue: { cartera, detalle, createPromise, registrarContacto, estadoCuentaPdf, tendencia: () => of([]), resolvePromise: () => of({}), enlaceDeposito } });
    const f = TestBed.createComponent(FinanzasCarteraComponent);
    f.detectChanges();
    const c = f.componentInstance;
    c.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    f.detectChanges();
    const botones = document.body.querySelectorAll('[data-testid="enviar-estado-cuenta"]');
    expect(botones.length).toBe(1);
    // Los cuatro de antes ya no están.
    const txt = document.body.textContent || '';
    expect(txt).not.toContain('Copiar enlace para depósitos');
    expect(txt).not.toContain('Estado de cuenta (PDF)');
    expect(txt).toContain('3314855906');
    expect(txt).toContain('PDF y depósitos en su enlace');
    const href = decodeURIComponent((botones[0] as HTMLAnchorElement).href);
    expect(href).toMatch(/^https:\/\/wa\.me\/523314855906\?text=/);
    expect(href).toContain('https://suite.test/deposito/TOKEN');
    expect(href).toContain('puede descargar el PDF');
    expect(href).not.toContain('Le adjuntamos');
    c.enviarEstadoCuenta(conTel);
    // [CC.20.2] Con enlace no se descarga nada: el cliente baja el PDF desde su enlace, y se dice.
    expect(estadoCuentaPdf).not.toHaveBeenCalled();
    expect(c.pdfAviso()?.texto).toContain('va en su enlace');
    expect(registrarContacto).toHaveBeenCalledWith('01', 'C1', 'whatsapp');
  });

  it('19b · [CC.20.2] SIN enlace el PDF se descarga para adjuntarlo, y un doble clic no lo pide dos veces', () => {
    const conTel = { ...DET, cliente: { ...DET.cliente, telefono: '3314855906' } } as CarteraDetalle;
    detalle = vi.fn(() => of(conTel));
    enlaceDeposito = vi.fn(() => throwError(() => ({ status: 500 })));
    const estadoCuentaPdf = vi.fn(() => NEVER); // el PDF sigue generándose: el segundo clic no lo pide otra vez
    const registrarContacto = vi.fn(() => of({ id: 'k1', canal: 'whatsapp' as const, contacted_at: new Date().toISOString() }));
    configurar();
    TestBed.overrideProvider(CarteraService, { useValue: { cartera, detalle, createPromise, registrarContacto, estadoCuentaPdf, tendencia: () => of([]), resolvePromise: () => of({}), enlaceDeposito } });
    const f = TestBed.createComponent(FinanzasCarteraComponent);
    f.detectChanges();
    const c = f.componentInstance;
    c.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    f.detectChanges();
    expect(document.body.textContent).toContain('con el PDF para adjuntar');
    const href = decodeURIComponent((document.body.querySelector('[data-testid="enviar-estado-cuenta"]') as HTMLAnchorElement).href);
    expect(href).toContain('Le adjuntamos el PDF');
    c.enviarEstadoCuenta(conTel);
    c.enviarEstadoCuenta(conTel); // doble clic
    expect(estadoCuentaPdf).toHaveBeenCalledTimes(1);
  });

  it('20 · [CXC.44] sin teléfono el botón sigue: WhatsApp abre para elegir a quién', () => {
    const f = crear();
    const c = f.componentInstance;
    c.openDetalle(cli('C1', 'Abarrotes Uno', 100, 100));
    f.detectChanges();
    const a = document.body.querySelector('[data-testid="enviar-estado-cuenta"]') as HTMLAnchorElement;
    expect(a).toBeTruthy();
    expect(a.href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(document.body.textContent).toContain('eliges a quién');
  });

  it('8 · la fila se abre con Enter', () => {
    const f = crear();
    const fila = el(f).querySelector('tr.ct-row') as HTMLElement;
    expect(fila.getAttribute('tabindex')).toBe('0');
    fila.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(detalle).toHaveBeenCalledWith('01', 'C1');
  });

  it('17 · [GP.R.1] el vencido que es puro redondeo dice «Redondeo», no pinta la fila y va al final de «cobrar»', () => {
    cartera = vi.fn(() => of(resp([
      cli('R', 'Solo centavos', 0.37, 0.37, { solo_resto_vencido: true, resto_redondeo: 0.37, n_restos: 1 }),
      cli('V', 'Debe de verdad', 0.5, 0.2),
    ])));
    const f = crear();
    const filas = Array.from(el(f).querySelectorAll('tr.ct-row')) as HTMLElement[];
    expect(filas[0].textContent).toContain('Debe de verdad');
    const resto = filas[1];
    expect(resto.textContent).toContain('Redondeo');
    expect(resto.textContent).toContain('0.37');
    expect(resto.classList.contains('ct-row-venc')).toBe(false);
  });

  it('17b · [GP.R.1] negativo: con vencido real además del resto, la fila sigue vencida y sin «Redondeo»', () => {
    cartera = vi.fn(() => of(resp([cli('B', 'Mixto', 500.37, 500.37, { solo_resto_vencido: false, resto_redondeo: 0.37, n_restos: 1 })])));
    const f = crear();
    const fila = el(f).querySelector('tr.ct-row') as HTMLElement;
    expect(fila.classList.contains('ct-row-venc')).toBe(true);
    expect(fila.textContent).not.toContain('Redondeo');
  });

  it('17c · [GP.R.1] la partida de centavos de una factura cobrada es resto; la nunca cobrada no', () => {
    const f = crear();
    const c = f.componentInstance;
    const p = (saldo: number, importe: number, saldada = false) => ({ saldo_documento: saldo, importe, saldada }) as never;
    expect(c.esResto(p(0.37, 15730.37))).toBe(true);
    expect(c.esResto(p(0.08, 0.08))).toBe(false);
    expect(c.esResto(p(1.5, 100))).toBe(false);
    expect(c.esResto(p(0, 100, true))).toBe(false);
  });
});
