import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { ConfirmationService, type Confirmation } from 'primeng/api';
import { Select } from 'primeng/select';
import { sucursalPropuesta, type FacturaPorRegistrar, type FaltanteSolicitud, type LecturaDelComprobante, type PrecargaDeLaSolicitud } from '@megadulces/contracts';
import { FinanzasPedirGastoComponent } from './finanzas-pedir-gasto.component';
import { campoQueFalta, enLista, loQueReemplaza, origenDelRenglon, sinBaseTexto, textoDelPlazo, type RenglonEnCaptura } from './pedir-gasto.ayudas';

/**
 * `[PGP.123]` S.13 + `[PGP.122]` S.17 — Candado de «Registrar o pedir un gasto».
 *  · S.13 (anexo S §14): cada campo del renglón dice SU origen (H1), «¿reemplazo?» nace con el foco en «No» (H7) y
 *    nombra sólo lo que hay (H19), y con la factura del SAT la foto deja de ser la acción principal y el foco va a lo
 *    que falta (H20).
 *  · S.17 (anexo S §15, Francisco 2026-11-16): el orden base → proveedor (y SUS facturas del SAT) → comprobante →
 *    qué y cuánto → cómo se paga; con un almacén la base es fija y con varios se elige (DS27); «Usar esta factura» no
 *    borra al proveedor ni su hábito (DS29); el plazo vuelve fecha de pago (DS30); la información de pago es opcional y
 *    se valida (DS31).
 * Datos sintéticos (repo público).
 */
const VACIO: RenglonEnCaptura = { concepto: null, proyecto: null, departamento: null, importe: null };
const LLENO: RenglonEnCaptura = { concepto: 'GAS', proyecto: 'P1', departamento: 'D1', importe: 431.03 };
const falta = (id: FaltanteSolicitud['id'], label = 'x'): FaltanteSolicitud => ({ id, label, motivo: 'm' });
/** Una CLABE con su dígito de control bien (regla de Banxico) y la misma con el último dígito mal. */
const CLABE = '012180001234567899';
const CLABE_MALA = '012180001234567890';

describe('[PGP.122] pedir-gasto · las reglas puras', () => {
  it('enLista: «a», «a y b», «a, b y c», y «e» antes de «i»', () => {
    expect(enLista([])).toBe('');
    expect(enLista(['el folio'])).toBe('el folio');
    expect(enLista(['el folio', 'el acreedor'])).toBe('el folio y el acreedor');
    expect(enLista(['concepto', 'proyecto', 'departamento', 'importe'])).toBe('concepto, proyecto, departamento e importe');
    expect(enLista(['a', 'hielo'])).toBe('a y hielo');
  });

  it('H1 · cada campo del renglón con SU origen (el hábito no se rotula como factura)', () => {
    expect(origenDelRenglon({ concepto_1: 'habito', proyecto_1: 'habito', departamento_1: 'habito', importe_1: 'cfdi', renglon_1: 'cfdi' }, 1))
      .toBe('Concepto, proyecto y departamento: como la última vez · importe: de la factura del SAT');
    expect(origenDelRenglon({ importe_1: 'cfdi' }, 1)).toBe('Importe: de la factura del SAT');
    // Lo que escribió la persona no se rotula; sin nada de la Suite, no hay línea.
    expect(origenDelRenglon({ concepto_1: 'persona', proyecto_1: 'habito' }, 1)).toBe('Proyecto: como la última vez');
    expect(origenDelRenglon({ concepto_1: 'persona', renglon_1: 'habito' }, 1)).toBeNull();
    expect(origenDelRenglon({ concepto_1: 'habito' }, 2)).toBeNull();
  });

  it('S.17 DS29 · «Usar esta factura» sólo nombra lo del comprobante que reemplaza (nunca al proveedor)', () => {
    const base = { archivo: null, folio: '', uuid: null, fuentes: {} };
    expect(loQueReemplaza(base, 'u1')).toEqual([]);
    // El proveedor y su hábito NO cuentan: elegir al proveedor y luego su factura es el camino normal.
    expect(loQueReemplaza({ ...base, fuentes: { acreedor: 'persona', concepto_1: 'habito', forma_pago: 'habito' } }, 'u1')).toEqual([]);
    expect(loQueReemplaza({ ...base, archivo: { live: true }, folio: 'T-1', fuentes: { folio: 'persona' } }, 'u1')).toEqual(['la foto', 'el folio']);
    expect(loQueReemplaza({ ...base, archivo: { live: false } }, 'u1')).toEqual(['el archivo']);
    expect(loQueReemplaza({ ...base, uuid: 'u0', folio: 'A-1', fuentes: { folio: 'cfdi' } }, 'u1')).toEqual(['la otra factura del SAT']);
    // La misma factura otra vez no reemplaza nada.
    expect(loQueReemplaza({ ...base, uuid: 'u1', folio: 'A-1', fuentes: { folio: 'cfdi' } }, 'u1')).toEqual([]);
    expect(loQueReemplaza({ ...base, fuentes: { importe_1: 'persona', iva: 'persona', fecha: 'persona' } }, 'u1')).toEqual(['la fecha', 'el importe', 'el IVA']);
  });

  it('S.17 · el primer campo que falta, en el orden NUEVO de la pantalla (proveedor → comprobante → renglón → pago)', () => {
    // El proveedor (2) va antes que el comprobante (3).
    expect(campoQueFalta([falta('fecha_documento'), falta('acreedor')], [LLENO])).toBe('pg-acreedor');
    // El comprobante (3) antes que el renglón (4).
    expect(campoQueFalta([falta('renglon', 'Renglón 1'), falta('fecha_documento')], [{ ...LLENO, proyecto: null }])).toBe('pg-fecha');
    expect(campoQueFalta([falta('forma_pago'), falta('iva')], [LLENO])).toBe('pg-iva');
    expect(campoQueFalta([falta('forma_pago')], [LLENO])).toBe('pg-como');
    // La información de pago va al final, después de la forma de pago.
    expect(campoQueFalta([falta('pago_correo'), falta('pago_cuenta')], [LLENO])).toBe('pg-cuenta');
    expect(campoQueFalta([falta('pago_correo'), falta('forma_pago')], [LLENO])).toBe('pg-como');
    // En el renglón, el primer campo vacío de izquierda a derecha; el renglón 1 antes que el 2.
    expect(campoQueFalta([falta('renglon', 'Renglón 2'), falta('importe', 'Renglón 1')], [{ ...LLENO, importe: null }, VACIO])).toBe('pg-imp-0');
    expect(campoQueFalta([falta('alcance', 'Renglón 1')], [LLENO])).toBe('pg-con-0');
    expect(campoQueFalta([falta('alcance', 'Fuera de la primera versión')], [LLENO])).toBe('pg-acreedor');
    expect(campoQueFalta([], [LLENO])).toBeNull();
  });

  it('S.17 DS27 · sin base dice por qué y qué hacer (Sistemas, o «Tengo un folio de Kepler»)', () => {
    expect(sinBaseTexto('sin_almacen')).toContain('pídele a Sistemas');
    expect(sinBaseTexto('una')).toContain('tu almacén');
    expect(sinBaseTexto('varias')).toContain('tus almacenes');
    for (const a of ['sin_almacen', 'ninguna', 'una', 'varias', 'todas', null] as const) expect(sinBaseTexto(a)).toContain('Tengo un folio de Kepler');
  });

  it('S.17 DS30 · la línea del plazo, en llano', () => {
    const fl = (d: string) => d;
    expect(textoDelPlazo({ dias: 0, fecha: '2026-11-16', vencio: null, desde: 'hoy', fechaLarga: fl })).toBe('De contado: se pide para hoy.');
    expect(textoDelPlazo({ dias: 30, fecha: '2026-12-10', vencio: null, desde: 'documento', fechaLarga: fl })).toBe('Se paga el 2026-12-10: 30 días después del documento.');
    expect(textoDelPlazo({ dias: 15, fecha: '2026-12-01', vencio: null, desde: 'hoy', fechaLarga: fl })).toBe('Se paga el 2026-12-01: 15 días después de hoy.');
    expect(textoDelPlazo({ dias: 7, fecha: '2026-11-16', vencio: '2026-10-27', desde: 'documento', fechaLarga: fl })).toBe('Venció el 2026-10-27 (7 días después del documento): se pide para hoy.');
    expect(textoDelPlazo({ dias: null, fecha: null, vencio: null, desde: 'hoy', fechaLarga: fl })).toBe('Elige la fecha de pago.');
  });
});

const dia = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hoy = dia(0);
const ACREEDOR = { clave: 'GZS13A', nombre: 'GASOLINERA DE PRUEBA', via: 'tal_cual' as const, en_la_sucursal: true, registrable: true, por_que_no: null };
const PROVEEDOR = { clave: 'GZS13A', nombre: 'GASOLINERA DE PRUEBA', rfc: 'QZA991231AA1', usos: 3 };
const F = (over: Partial<FacturaPorRegistrar> = {}): FacturaPorRegistrar => ({
  uuid: '5a5a0001-0000-4000-8000-000000000001', emisor_rfc: 'QZA991231AA1', emisor_nombre: 'GASOLINERA DE PRUEBA', serie_folio: 'A-501',
  fecha: hoy, dias: 0, total: 500, subtotal: 431.03, descuento: 0, iva: 68.97, metodo_pago: 'PUE', forma_pago: '04',
  acreedores: [ACREEDOR], sucursal: sucursalPropuesta(new Map([['06', 5]])), contabilizada: false, motivo: 'm', avisos: [], ...over,
});
const PRECARGA = (forma_pago: string | null, extra: Partial<PrecargaDeLaSolicitud> = {}): PrecargaDeLaSolicitud => ({
  acreedor: null, alcance: { dentro: true }, conceptos: [{ codigo: 'GAS', nombre: 'GASOLINA', cuenta: '601-001', fuera_de_alcance: null, usos: 3 }],
  ultimo: { concepto: 'GAS', proyecto: 'P1', departamento: 'D1', fecha: '2026-11-01' }, forma_pago, plazo: null, pago: null, ...extra,
});
const BANDEJA = (por_registrar: FacturaPorRegistrar[] = []) => ({ sucursal: '06', desde: '2026-10-01', ultima_llegada: null, horas_sin_llegadas: null, por_registrar,
  registradas: [], descartadas: [], sin_sucursal_clara: 0, declarado: [] });

describe('[PGP.122] S.17 FinanzasPedirGastoComponent · base, proveedor y sus facturas, y cómo se paga', () => {
  let fix: ComponentFixture<FinanzasPedirGastoComponent>;
  let c: FinanzasPedirGastoComponent;
  let http: HttpTestingController;
  let confirmar: ConfirmationService;

  // jsdom no implementa `scrollIntoView` (los navegadores sí): se pone uno vacío sólo mientras corre este archivo.
  const sinScroll = !Element.prototype.scrollIntoView;
  beforeAll(() => {
    registerLocaleData(localeEsMx);
    if (sinScroll) Element.prototype.scrollIntoView = function () { /* jsdom */ };
  });
  afterAll(() => { if (sinScroll) delete (Element.prototype as Partial<Element>).scrollIntoView; });
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasPedirGastoComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), ConfirmationService, { provide: LOCALE_ID, useValue: 'es-MX' }],
    });
    http = TestBed.inject(HttpTestingController);
    confirmar = TestBed.inject(ConfirmationService);
  });
  afterEach(() => {
    // La revisión de duplicados sale sola 400 ms después de elegir acreedor y total: no es de estas pruebas.
    http.match((r) => r.url.endsWith('/duplicados'));
    http.verify();
  });

  const pide = (fin: string) => http.expectOne((r) => r.url.endsWith(fin));
  const txt = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const montar = () => {
    fix = TestBed.createComponent(FinanzasPedirGastoComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  };
  /** Lo que pasa al abrir una base: la puerta, el catálogo, los frecuentes y la bandeja del SAT. */
  const abrirBase = (s: string, facturas: FacturaPorRegistrar[] = [], extra: object[] = []) => {
    pide('/disponibilidad').flush({ sucursal: s, disponible: true, motivos: [] });
    pide('/catalogo').flush({ sucursal: s, conceptos: [{ codigo: 'GAS', nombre: 'GASOLINA', cuenta: '601-001', fuera_de_alcance: null }, ...extra],
      proyectos: [{ codigo: 'P1', nombre: 'GENERAL' }], departamentos: [{ codigo: 'D1', nombre: 'ADMINISTRACION' }] });
    pide('/acreedores').flush([]);
    fix.detectChanges();
    pide('/facturas-sat').flush({ ...BANDEJA(facturas), sucursal: s });
    fix.detectChanges();
  };
  /** Una persona con un solo almacén (la 06): la base queda fija y se abre sola. */
  const abrir = (facturas: FacturaPorRegistrar[] = []) => {
    montar();
    pide('/abiertas').flush({ sucursales: ['06'], alcance: 'una' });
    abrirBase('06', facturas);
  };
  /** Elige al proveedor y contesta su hábito. */
  const elegir = (precarga = PRECARGA(null)) => {
    c.elegirAcreedor(PROVEEDOR);
    pide('/precarga').flush(precarga);
    fix.detectChanges();
  };
  const espera = () => new Promise((r) => setTimeout(r, 0));

  it('R14 · el concepto que aquí va a otro rubro que en CEDIS no se ofrece, pero se DICE; y si es el de siempre del proveedor, se dice eso', () => {
    const MOTIVO = 'CAPITAN DE MARCA (074) va a la cuenta 102 en el Kepler de esta sucursal y a 606-014 en CEDIS: no se puede pedir hasta que Contabilidad corrija el catálogo';
    montar();
    pide('/abiertas').flush({ sucursales: ['06'], alcance: 'una' });
    abrirBase('06', [], [{ codigo: '074', nombre: 'CAPITAN DE MARCA.', cuenta: '102', fuera_de_alcance: null, distinto_de_cedis: MOTIVO }]);
    expect(c.conceptos().map((x) => x.codigo)).toEqual(['GAS']);
    expect(txt()).toContain(`No se ofrece: ${MOTIVO}`);
    elegir(PRECARGA(null, {
      conceptos: [{ codigo: '074', nombre: 'CAPITAN DE MARCA.', cuenta: '102', fuera_de_alcance: null, distinto_de_cedis: MOTIVO, usos: 5 }],
      ultimo: { concepto: '074', proyecto: 'P1', departamento: 'D1', fecha: '2026-11-01' },
    }));
    expect(c.renglones()[0].concepto).toBeFalsy();
    expect(txt()).toContain(`El concepto que usa este proveedor no se ofrece aquí: ${MOTIVO}`);
    expect(txt()).not.toContain('No se ofrece: '); // un solo aviso, no dos
  });

  it('[PGP.122.14] lo que no se puede pedir (SUA, sin cuenta) sale al final, deshabilitado y con su motivo; nada se propone con eso', () => {
    // [PGP.122.17] El ejemplo era el 364 (activo fijo); desde DS47 el activo entra con su formulario: ahora es el SUA.
    const SUA = 'La cuenta 601-015 es de SUA, no de gasto: ese renglón se captura en Kepler';
    const SIN = 'Le falta la cuenta contable en el catálogo de Kepler de 06: se podrá pedir cuando Contabilidad la ponga';
    montar();
    pide('/abiertas').flush({ sucursales: ['06'], alcance: 'una' });
    abrirBase('06', [], [
      { codigo: '047', nombre: 'SUA', cuenta: '601-015', fuera_de_alcance: SUA },
      { codigo: '274', nombre: 'ALINEACION Y BALANCEO', cuenta: '', fuera_de_alcance: SIN },
      { codigo: 'AGU', nombre: 'AGUA', cuenta: '601-002', fuera_de_alcance: null },
    ]);
    // El selector trae TODO el catálogo: lo que se puede pedir primero, lo que no al final y con su motivo.
    expect(c.opcionesConcepto().map((x) => [x.codigo, x.bloqueado])).toEqual([['GAS', false], ['AGU', false], ['047', true], ['274', true]]);
    expect(c.opcionesConcepto().find((x) => x.codigo === '047')?.motivo).toBe(SUA);
    expect(c.opcionesConcepto().find((x) => x.codigo === '274')?.motivo).toBe(SIN);
    // Y el p-select del renglón los recibe deshabilitados (buscar «364» lo encuentra, pero no se puede elegir).
    const sel = fix.debugElement.queryAll(By.directive(Select)).map((d) => d.componentInstance as Select).find((s) => s.inputId() === 'pg-con-0');
    expect(sel?.optionDisabled()).toBe('bloqueado');
    expect(sel?.options()?.map((o: { codigo: string }) => o.codigo)).toEqual(['GAS', 'AGU', '047', '274']);
    expect(sel?.isOptionDisabled(sel.options()![2])).toBe(true);
    // Lo que la pantalla propone sola sale únicamente de lo que se puede pedir.
    expect(c.conceptos().map((x) => x.codigo)).toEqual(['GAS', 'AGU']);
    // Si el concepto de siempre del proveedor no se puede pedir aquí, no se pone y se dice por qué.
    elegir(PRECARGA(null, {
      conceptos: [{ codigo: '047', nombre: 'SUA', cuenta: '601-015', fuera_de_alcance: SUA, usos: 2 }],
      ultimo: { concepto: '047', proyecto: 'P1', departamento: 'D1', fecha: '2026-11-01' },
    }));
    expect(c.renglones()[0].concepto).toBeFalsy();
    expect(txt()).toContain(`El concepto que usa este proveedor no se ofrece aquí: ${SUA}`);
  });

  describe('[PGP.122.17] la compra de un activo (anexo S §20)', () => {
    const ACT = { codigo: '364', nombre: 'PC VERIFICADOR DE PRECIO.', cuenta: '150-002', fuera_de_alcance: null, activo: { grupo: 'ECE', nombre: 'EQUIPO DE COMPUTO ELECTRONICO', tasa: 30, vida_meses: 40 } };
    const SIN_GRUPO = { codigo: '213', nombre: 'HERRAMIENTAS Y EQUIPO', cuenta: '150-009', fuera_de_alcance: null, activo: { grupo: null, nombre: null, tasa: null, vida_meses: null } };
    const preparar = (factura = F({ total: 11600, subtotal: 10000, iva: 1600 })) => {
      montar();
      pide('/abiertas').flush({ sucursales: ['06'], alcance: 'una' });
      abrirBase('06', [factura], [ACT, SIN_GRUPO]);
      elegir(PRECARGA('transferencia'));
      c.usarFactura(factura);
      fix.detectChanges();
    };
    const bloque = () => (fix.nativeElement as HTMLElement).querySelector('.pg-activo')?.textContent?.replace(/\s+/g, ' ') ?? '';
    const activoFalta = () => c.faltan().filter((f) => f.id === 'activo').map((f) => f.motivo);

    it('un concepto de gasto no abre nada; uno de activo abre «Compra de activo» con su grupo y vida fiscal de Kepler', () => {
      preparar();
      expect((fix.nativeElement as HTMLElement).querySelector('.pg-activo')).toBeNull();
      c.cambiarRenglon(0, 'concepto', '364'); fix.detectChanges();
      expect(bloque()).toContain('Compra de activo · renglón 1');
      expect(bloque()).toContain('Grupo: Equipo de computo electronico · vida fiscal 40 meses (30 % al año), de Kepler.');
      expect(c.renglones()[0].activo).toEqual({ tipo: null, descripcion: '', cantidad: 1, lugar: '' });
      // Sin grupo en Kepler (DS54) se dice; no se inventa una tasa.
      c.cambiarRenglon(0, 'concepto', '213'); fix.detectChanges();
      expect(bloque()).toContain('Contabilidad aún no lo define en Kepler');
      // De vuelta a un concepto de gasto, el bloque se va.
      c.cambiarRenglon(0, 'concepto', 'GAS'); fix.detectChanges();
      expect(c.renglones()[0].activo).toBeNull();
      expect((fix.nativeElement as HTMLElement).querySelector('.pg-activo')).toBeNull();
    });

    it('⭐ primero la pregunta; «reparación, refacción o consumible» es gasto y «Cambiar el concepto» lo quita', () => {
      preparar();
      c.cambiarRenglon(0, 'concepto', '364'); fix.detectChanges();
      expect(activoFalta()[0]).toMatch(/bien nuevo o es una reparación/);
      c.cambiarActivo(0, 'tipo', 'gasto'); fix.detectChanges();
      expect(bloque()).toContain('Una reparación, refacción o consumible es gasto, no activo');
      expect(activoFalta()[0]).toMatch(/es gasto, no activo/);
      c.cambiarConceptoAGasto(0); fix.detectChanges();
      expect(c.renglones()[0].concepto).toBeNull();
      expect(c.renglones()[0].activo).toBeNull();
    });

    it('⭐ DS53: con $5,000 o menos por unidad es gasto (lo dice junto a cuántos); con más se puede pedir y el envío lleva el activo', () => {
      preparar();
      c.cambiarRenglon(0, 'concepto', '364');
      c.cambiarActivo(0, 'tipo', 'bien');
      c.cambiarActivo(0, 'descripcion', 'PC verificador de precio, marca X, modelo Y');
      c.cambiarActivo(0, 'cantidad', 2); fix.detectChanges();
      expect(bloque()).toContain('— es gasto, no activo');
      expect(activoFalta()[0]).toContain('cada uno es gasto');
      c.cambiarActivo(0, 'cantidad', 1); c.cambiarActivo(0, 'lugar', 'Piso de venta'); fix.detectChanges();
      expect(bloque()).not.toContain('es gasto, no activo');
      expect(c.faltan()).toEqual([]);
      c.enviar();
      const req = http.expectOne((x) => x.method === 'POST' && x.url.endsWith('/finance/expenses/solicitudes'));
      expect(req.request.body.renglones[0].activo).toEqual({ tipo: 'bien', descripcion: 'PC verificador de precio, marca X, modelo Y', cantidad: 1, lugar: 'Piso de venta' });
      req.flush({ id: 'x', status: 'recibida', kepler_request_status: 'pending', total: 11600, retroactiva: false, duplicados: [] });
      fix.detectChanges();
      pide('/facturas-sat').flush(BANDEJA());
    });

    it('el concepto de siempre del proveedor puede ser de activo: su bloque nace como al elegirlo a mano (cuántos = 1)', () => {
      montar();
      pide('/abiertas').flush({ sucursales: ['06'], alcance: 'una' });
      abrirBase('06', [], [ACT, SIN_GRUPO]);
      elegir(PRECARGA(null, { conceptos: [{ ...ACT, usos: 4 }], ultimo: { concepto: '364', proyecto: 'P1', departamento: 'D1', fecha: '2026-11-01' } }));
      expect(c.renglones()[0].concepto).toBe('364');
      expect(c.renglones()[0].activo).toEqual({ tipo: null, descripcion: '', cantidad: 1, lugar: '' });
      expect(bloque()).toContain('Compra de activo · renglón 1');
      expect(activoFalta()[0]).toMatch(/bien nuevo o es una reparación/);
    });

    it('el renglón de gasto no manda activo', () => {
      preparar();
      expect(c.faltan()).toEqual([]);
      c.enviar();
      const req = http.expectOne((x) => x.method === 'POST' && x.url.endsWith('/finance/expenses/solicitudes'));
      expect(req.request.body.renglones[0].activo).toBeUndefined();
      req.flush({ id: 'x', status: 'recibida', kepler_request_status: 'pending', total: 11600, retroactiva: false, duplicados: [] });
      fix.detectChanges();
      pide('/facturas-sat').flush(BANDEJA());
    });
  });
  it('DS27 · con un solo almacén la base es fija y no se pregunta', () => {
    abrir();
    const base = (fix.nativeElement as HTMLElement).querySelector('#pg-base')!;
    expect(base.querySelector('p-selectbutton, p-select')).toBeNull();
    expect(base.textContent).toContain('06 Canindo');
    expect(c.sucursal()).toBe('06');
  });

  it('DS27 · con varios almacenes nada se abre hasta elegir la base, y no se preselecciona ninguna', () => {
    montar();
    pide('/abiertas').flush({ sucursales: ['07', '08'], alcance: 'varias' });
    fix.detectChanges();
    expect(c.sucursal()).toBe('');
    expect(txt()).toContain('Elige la base para empezar.');
    http.expectNone((r) => r.url.endsWith('/disponibilidad'));
    const base = (fix.nativeElement as HTMLElement).querySelector('#pg-base p-selectbutton')!;
    expect(base.textContent).toContain('07 Morelia Madero');
    expect(base.textContent).toContain('08 Morelia Abastos');
    c.cambiarSucursal('08');
    abrirBase('08');
    expect(c.disponible()).toBe(true);
  });

  it('⛔ DS27 · sin almacén en su ficha no se ofrece ninguna base y dice que lo arregla Sistemas', () => {
    montar();
    pide('/abiertas').flush({ sucursales: [], alcance: 'sin_almacen' });
    fix.detectChanges();
    expect(c.sucursal()).toBe('');
    expect(txt()).toContain('pídele a Sistemas');
    http.expectNone((r) => r.url.endsWith('/disponibilidad'));
  });

  it('el orden de la pantalla: base → franja → proveedor (con su bandeja) → comprobante → qué y cuánto → cómo se paga', () => {
    abrir();
    const raiz = fix.nativeElement as HTMLElement;
    const orden = ['#pg-base', 'app-metric-strip', '#pg-prov-t', 'app-facturas-sat-bandeja', '#pg-documento', '#pg-que', '#pg-como']
      .map((s) => raiz.querySelector(s)!);
    for (let i = 1; i < orden.length; i++) expect(orden[i - 1].compareDocumentPosition(orden[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // La bandeja vive dentro del paso «Proveedor».
    expect(raiz.querySelector('#pg-prov-t')!.closest('fieldset')!.contains(raiz.querySelector('app-facturas-sat-bandeja'))).toBe(true);
    // «Se necesita pagar el» ya no está en «Más datos»: ahora es el plazo.
    expect(raiz.querySelector('#pg-necesita')).toBeNull();
  });

  it('DS29 · usar la factura del proveedor elegido no pregunta ni toca al proveedor ni su hábito', async () => {
    abrir([F()]);
    elegir(PRECARGA('efectivo'));
    const spy = vi.spyOn(confirmar, 'confirm');
    c.usarFactura(F());
    fix.detectChanges();
    await espera();
    expect(spy).not.toHaveBeenCalled();
    http.expectNone((r) => r.url.endsWith('/precarga')); // el mismo proveedor: no se vuelve a pedir su hábito
    expect(c.acreedorSel()?.clave).toBe('GZS13A');
    expect(c.renglones()[0]).toMatchObject({ concepto: 'GAS', proyecto: 'P1', departamento: 'D1', importe: 431.03 });
    expect(c.cfdiUuid()).toBe(F().uuid);
    expect(c.formaPago()).toBe('efectivo');
    expect(c.faltan()).toEqual([]);
    // Nada falta: el foco va a «Qué es y cuánto» (el concepto y el área, que son lo que se revisa).
    expect(document.activeElement?.id).toBe('pg-que');
  });

  it('H7 · H19 · DS29: con un comprobante capturado pregunta antes, con el foco en «No», y nombra sólo eso', () => {
    abrir([F()]);
    elegir();
    let opciones: Confirmation | undefined;
    vi.spyOn(confirmar, 'confirm').mockImplementation((o: Confirmation) => { opciones = o; return confirmar; });
    c.folioDoc.set('T-77');
    c.marcar('folio');
    c.usarFactura(F());
    expect(opciones?.defaultFocus).toBe('reject');
    expect(opciones?.acceptButtonStyleClass).not.toMatch(/danger|primary/);
    expect(opciones?.message).toContain('reemplaza el folio. El proveedor y lo demás se quedan.');
    expect(opciones?.message).not.toContain('foto');
    expect(c.cfdiUuid()).toBeNull(); // hasta que diga que sí
  });

  it('H1 · H20 · DS28: el proveedor desde sus facturas; cada campo dice su origen, la foto pasa a opcional y el foco va a lo que falta', async () => {
    abrir([F()]);
    c.elegirDesdeFactura({ clave: 'GZS13A', nombre: 'GASOLINERA DE PRUEBA', rfc: 'QZA991231AA1' });
    pide('/precarga').flush(PRECARGA(null));
    fix.detectChanges();
    expect(c.fuente('acreedor')).toBe('de la factura del SAT');
    c.usarFactura(F());
    fix.detectChanges();
    await espera();
    expect(c.origenRenglon(0)).toBe('Concepto, proyecto y departamento: como la última vez · importe: de la factura del SAT');
    const camara = fix.nativeElement.querySelector('.cv-abrir') as HTMLButtonElement;
    expect(camara.classList.contains('is-sec')).toBe(true);
    expect(camara.textContent).toContain('Tomar foto (opcional)');
    // La factura y el hábito llenaron todo menos la forma de pago: el foco va ahí.
    expect(c.faltan().map((f) => f.id)).toEqual(['forma_pago']);
    expect(document.activeElement?.id).toBe('pg-como');
  });

  it('H20 · sin factura casada al SAT, «Tomar foto» sigue siendo el botón principal', () => {
    abrir();
    const camara = fix.nativeElement.querySelector('.cv-abrir') as HTMLButtonElement;
    expect(camara.classList.contains('is-sec')).toBe(false);
    expect(camara.textContent?.trim()).toBe('Tomar foto');
  });

  it('DS30 · el plazo del catálogo de Kepler: cuenta desde la factura y viaja como fecha de pago', () => {
    abrir([F()]);
    elegir(PRECARGA('transferencia', { plazo: { dias: 15, fuente: 'catalogo' } }));
    c.usarFactura(F());
    fix.detectChanges();
    expect(c.plazoSel()).toBe('15');
    expect(c.necesitaParaIso()).toBe(dia(15));
    expect(c.textoPlazo()).toContain('15 días después del documento');
    expect(c.fuente('plazo')).toBe('del catálogo de Kepler');
    // De contado no manda fecha: Kepler pone la de solicitud, como hoy.
    c.elegirPlazo('0');
    expect(c.necesitaParaIso()).toBeNull();
    expect(c.textoPlazo()).toBe('De contado: se pide para hoy.');
  });

  it('⛔ DS30 · un plazo ya vencido se pide para hoy y lo dice', () => {
    abrir();
    c.fechaDoc.set(new Date(`${dia(-40)}T12:00:00`));
    c.elegirPlazo('30');
    expect(c.necesitaParaIso()).toBe(hoy);
    expect(c.textoPlazo()).toMatch(/^Venció el .+ \(30 días después del documento\): se pide para hoy\.$/);
  });

  it('DS31 · la información de pago nace cerrada; «Agregar información de pago» la abre; lo mal escrito bloquea y se dice', () => {
    abrir();
    expect(c.pagoAbierto()).toBe(false);
    const boton = [...(fix.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.includes('Agregar información de pago'))!;
    boton.click();
    fix.detectChanges();
    expect(c.pagoAbierto()).toBe(true);
    expect((fix.nativeElement as HTMLElement).querySelector('#pg-cuenta')).not.toBeNull();
    c.pagoCuenta.set(CLABE_MALA);
    expect(c.faltan().map((f) => f.id)).toContain('pago_cuenta');
    expect(c.textoCuenta()).toContain('dígito de control');
    c.pagoCuenta.set('0121 8000 1234 5678 99');
    expect(c.faltan().map((f) => f.id)).not.toContain('pago_cuenta');
    expect(c.textoCuenta()).toBe('CLABE con su dígito de control correcto');
    c.pagoCorreo.set('pagos@proveedor');
    expect(c.faltan().map((f) => f.id)).toContain('pago_correo');
    // «Quitar» la vacía y no viaja.
    c.quitarPago();
    expect(c.pagoAbierto()).toBe(false);
    expect(c.pagoDto()).toBeNull();
  });

  it('DS31 · si el acreedor ya la trae (el correo de Kepler, la cuenta de la última vez), nace abierta con su origen', () => {
    abrir();
    elegir(PRECARGA(null, { pago: { cuenta: CLABE, banco: 'BBVA', correo: 'pagos@proveedor.com.mx', fuente_cuenta: 'habito', fuente_correo: 'catalogo' } }));
    expect(c.pagoAbierto()).toBe(true);
    expect(c.pagoCuenta()).toBe(CLABE);
    expect(c.textoCuenta()).toBe('CLABE con su dígito de control correcto · como la última vez');
    expect(c.fuente('pago_correo')).toBe('del catálogo de Kepler');
  });

  it('el payload de la pantalla lleva la información de pago y la fecha de pago del plazo', () => {
    abrir([F()]);
    elegir(PRECARGA('transferencia', { plazo: { dias: 30, fuente: 'habito' } }));
    c.usarFactura(F());
    c.abrirPago();
    c.pagoCuenta.set('0121 8000 1234 5678 99');
    c.pagoBanco.set('BBVA');
    c.pagoCorreo.set('pagos@proveedor.com.mx');
    fix.detectChanges();
    expect(c.faltan()).toEqual([]);
    c.enviar();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/finance/expenses/solicitudes'));
    expect(req.request.body.necesita_para).toBe(dia(30));
    expect(req.request.body.pago).toEqual({ cuenta: '0121 8000 1234 5678 99', banco: 'BBVA', correo: 'pagos@proveedor.com.mx' });
    expect(req.request.body.comprobante).toMatchObject({ tipo: 'cfdi', uuid: F().uuid });
    req.flush({ id: 'x', status: 'recibida', kepler_request_status: 'pending', total: 500, retroactiva: false, duplicados: [] });
    // Al mandarse, la bandeja se vuelve a leer (la factura usada sale sola) y la solicitud vuelve al plazo de contado.
    fix.detectChanges();
    pide('/facturas-sat').flush(BANDEJA());
    expect(c.plazoSel()).toBe('0');
    expect(c.pagoAbierto()).toBe(false);
  });

  /**
   * `[PGP.122.9]` modern-web-guidance (forms, required-field-feedback, accessible-error-announcement): no se regaña
   * antes de intentar, el botón no se bloquea por validación, al intentar se marca lo que falta y el foco va al
   * resumen; el rechazo del servidor se queda escrito (un toast se cerraba solo a los 3–8 s).
   */
  it('[PGP.122.9] sin intentar no hay resumen ni campos marcados, y «Mandar a firma» NO está deshabilitado', () => {
    abrir([]);
    fix.detectChanges();
    expect(c.faltan().length).toBeGreaterThan(0);
    expect(fix.nativeElement.querySelector('#pg-faltan')).toBeNull();
    expect(c.mal('pg-acreedor')).toBe(false);
    const boton = fix.nativeElement.querySelector('.pg-barra button') as HTMLButtonElement;
    expect(boton.disabled).toBe(false);
  });

  it('[PGP.122.9] al intentar con faltantes: no se manda nada, sale el resumen con el foco y se marcan los campos', async () => {
    abrir([]);
    fix.detectChanges();
    c.enviar();
    fix.detectChanges();
    await espera();
    http.expectNone((r) => r.method === 'POST' && r.url.endsWith('/finance/expenses/solicitudes'));
    const resumen = fix.nativeElement.querySelector('#pg-faltan') as HTMLElement;
    expect(resumen).not.toBeNull();
    expect(resumen.querySelectorAll('button.pg-faltan-ir').length).toBe(c.faltan().length);
    expect(document.activeElement?.id).toBe('pg-faltan');
    expect(c.mal('pg-acreedor')).toBe(true);
    expect(c.mal('pg-con-0')).toBe(true);
  });

  it('[PGP.122.9] el rechazo del servidor queda escrito junto al botón (role=alert) hasta volver a mandar', () => {
    abrir([F()]);
    elegir(PRECARGA('transferencia'));
    c.usarFactura(F());
    fix.detectChanges();
    expect(c.faltan()).toEqual([]);
    c.enviar();
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/finance/expenses/solicitudes'))
      .flush({ message: 'El acreedor no existe en esta base' }, { status: 400, statusText: 'Bad Request' });
    fix.detectChanges();
    const err = fix.nativeElement.querySelector('.pg-error[role=alert]') as HTMLElement;
    expect(err?.textContent).toContain('El acreedor no existe en esta base');
    c.enviar();
    expect(c.errorEnvio()).toBeNull();
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/finance/expenses/solicitudes'));
  });

  /**
   * `[PGP.122.13]` La fecha que propone el lector va con lo que dice el papel, y lo que leyó y no es fecha se DICE en vez
   * de proponerse. Medido el 2026-11-21: las dos primeras solicitudes de usuarios traían la fecha mal leída y las dos
   * personas la corrigieron a mano; lo leído no se guardaba, así que no se podía medir cuánto pasa.
   */
  const LECTURA = (leido: Partial<NonNullable<LecturaDelComprobante['leido']>>): LecturaDelComprobante => ({
    legible: true, motivo: null, acreedor: null, cfdi: null,
    leido: { total: 116, subtotal: 100, iva: 16, fecha: null, fecha_impresa: null, folio: '102933', rfc: null, comercio: 'X', ...leido },
  });
  const leer = (l: LecturaDelComprobante) => {
    c.lectura.set(l);
    (c as unknown as { aplicarLectura(x: LecturaDelComprobante): void }).aplicarLectura(l);
    fix.detectChanges();
  };
  const campoFecha = () => (fix.nativeElement as HTMLElement).querySelector('#pg-fecha')?.closest('.pg-campo')?.textContent ?? '';

  it('[PGP.122.13] la fecha que propone el lector va con lo impreso en el comprobante, para compararla de un vistazo', () => {
    abrir();
    leer(LECTURA({ fecha: '2026-11-20', fecha_impresa: '20/11/26' }));
    expect(c.fuente('fecha')).toBe('leído del comprobante');
    expect(campoFecha()).toContain('leído del comprobante: «20/11/26»');
  });

  it('[PGP.122.13] lo que el servidor no propuso (incompleto, futuro o con el año mal) no se pone: se dice qué se leyó y por qué', () => {
    abrir();
    // «26/11/21»: el año mal leído —el caso de las dos primeras usuarias— queda a años de hoy y el servidor no lo propone.
    leer(LECTURA({ fecha: null, fecha_impresa: '26/11/21' }));
    expect(c.fechaDoc()).toBeNull();
    expect(campoFecha()).toContain('Se leyó «26/11/21», pero no se propone (sólo una fecha completa de los últimos 30 días): escríbela viendo el comprobante.');
    // Dice «se leyó», no «el comprobante dice»: la lectura puede estar mal.
    expect(campoFecha()).not.toContain('El comprobante dice');
    // En cuanto la persona escribe una, el aviso se va.
    c.fechaDoc.set(new Date(2026, 10, 20, 12));
    fix.detectChanges();
    expect(campoFecha()).not.toContain('Se leyó');
  });

  it('[PGP.122.13] el payload lleva lo que propuso el lector (limpio), para medir cuánto se corrige', () => {
    abrir([F()]);
    elegir(PRECARGA('transferencia'));
    c.usarFactura(F());
    // «Usar esta factura» descarta la foto Y su lectura (ya no es el documento): por eso la lectura va después.
    expect(c.lectura()).toBeNull();
    c.lectura.set(LECTURA({ fecha: '2026-11-20', fecha_impresa: '20/11/26', total: 580, folio: 'A-1' }));
    fix.detectChanges();
    expect(c.faltan()).toEqual([]);
    c.enviar();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/finance/expenses/solicitudes'));
    expect(req.request.body.lectura).toEqual({ fecha: '2026-11-20', fecha_impresa: '20/11/26', total: 580, folio: 'A-1' });
    req.flush({ id: 'x', status: 'recibida', kepler_request_status: 'pending', total: 500, retroactiva: false, duplicados: [] });
    fix.detectChanges();
    pide('/facturas-sat').flush(BANDEJA());
  });
});
