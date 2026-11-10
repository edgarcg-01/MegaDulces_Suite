import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { ChecadorPreciosService, type HalladoEnCopia } from '../checador-precios.service';
import type { EstadoCopia, ResultadoConsulta } from '../checador-precios';
import { LectorCodigoComponent } from '../components/lector-codigo.component';
import { VendorChecadorPreciosComponent } from './vendor-checador-precios.component';

/**
 * `[VTK.17]` El checador de precios montado de verdad, con el servicio y la red simulados.
 *
 * Una negativa por regla de pantalla: la copia de ayer NO se presenta como de hoy; un código que
 * Kepler no tiene NO pinta un precio; sin permiso de cámara se sigue pudiendo escribir; sin
 * sucursal asignada NO se consulta con una adivinada.
 */

const HOY = new Date().toISOString();
const AYER = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

const ficha = {
  clave: '00052', nombre: 'DULCE PRUEBA /12',
  presentaciones: [
    { u: 'PZA', nombre: 'Pieza', precio: 8.78, trae: null, precioPorTrae: null, etiquetaPorTrae: null },
    { u: 'PAQ', nombre: 'Paquete', precio: 93.48, trae: { n: 12, u: 'PZA', palabra: 'piezas' }, precioPorTrae: 7.79, etiquetaPorTrae: 'c/pieza' },
  ],
  unidadLeida: 'PAQ', esPromocion: false, otrosConElCodigo: [], precioAmbiguo: false, deOtraPlaza: false, corregidoAMano: false,
  mayoreo: [
    { u: 'PZA', singular: 'pieza', plural: 'piezas', desde: 12, precio: 8.2, precioNormal: 8.78, descuentoPct: 6.6, etiqueta: 'c/pieza' },
    { u: 'PAQ', singular: 'paquete', plural: 'paquetes', desde: 3, precio: 88, precioNormal: 93.48, descuentoPct: 5.9, etiqueta: 'c/paquete' },
  ],
  mayoreoSabido: true,
};

const copia = (generado: string): EstadoCopia => ({
  sucursal: '02', nombreSucursal: 'La Piedad Abastos', total: 9537, generado, guardadaAl: generado, formatoAnterior: false,
});

function montar(o: {
  sucursal?: unknown;
  fuentesFallan?: unknown;
  copia?: EstadoCopia | null;
  ultima?: EstadoCopia | null;
  consulta?: ResultadoConsulta;
  hallados?: HalladoEnCopia[] | null;
  enLinea?: boolean;
} = {}) {
  const copiaSig = signal<EstadoCopia | null>(o.copia === undefined ? copia(HOY) : o.copia);
  const svc = {
    copia: copiaSig,
    bajandoCopia: signal(false),
    asegurarCopia: vi.fn(async () => ({ copia: copiaSig(), fallo: null })),
    descargarCopia: vi.fn(async () => copiaSig()),
    ultimaCopia: vi.fn(async () => o.ultima ?? null),
    buscarEnCopia: vi.fn(async () => o.hallados === undefined ? [] : o.hallados),
    consultar: vi.fn(async () => o.consulta ?? ({ estado: 'encontrado', origen: 'en_linea', ficha, al: HOY } as ResultadoConsulta)),
  };
  const vendor = {
    myStockSources: vi.fn(() => o.fuentesFallan
      ? throwError(() => o.fuentesFallan)
      : of({ sucursal: 'sucursal' in o ? o.sucursal : { id: 'w1', code: '02', name: 'La Piedad Abastos', assigned: true }, camioneta: null })),
  };
  TestBed.configureTestingModule({
    imports: [VendorChecadorPreciosComponent],
    providers: [
      { provide: ChecadorPreciosService, useValue: svc },
      { provide: VendorService, useValue: vendor },
      { provide: ConnectivityService, useValue: { online: signal(o.enLinea ?? true), isOnline: () => o.enLinea ?? true } },
    ],
  });
  const fix = TestBed.createComponent(VendorChecadorPreciosComponent);
  const el = fix.nativeElement as HTMLElement;
  const texto = () => (el.textContent || '').replace(/\s+/g, ' ');
  const listo = async () => { fix.detectChanges(); await fix.whenStable(); await new Promise((r) => setTimeout(r, 0)); fix.detectChanges(); };
  return { fix, el, texto, svc, vendor, cmp: fix.componentInstance, listo };
}

describe('Checador de precios [VTK.17]', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('compacto: en el encabezado de la app, como el buscador del arqueo', () => {
    it('cerrado es SÓLO la caja con la cámara: sin título, sin la línea de la copia, sin ventana', async () => {
      const { texto, el, listo, fix } = montar();
      fix.componentRef.setInput('compacto', true);
      await listo();
      expect(el.querySelector('h1')).toBeNull();
      expect(el.querySelector('input[type=search]')).toBeTruthy();
      expect(el.querySelector('app-lector-codigo')).toBeTruthy();
      expect(el.querySelector('.ck-flota')).toBeNull();
      expect(texto()).not.toContain('Copia para usar sin señal');
    });

    it('un código leído: la ventana baja con el precio y de cuándo es (en la ficha); la X y Esc la cierran', async () => {
      const { texto, el, listo, fix, cmp } = montar();
      fix.componentRef.setInput('compacto', true);
      await listo();
      await cmp.alLeerCodigo('7501000044340');
      await listo();
      const ventana = el.querySelector('.ck-flota');
      expect(ventana).toBeTruthy();
      expect(texto()).toContain('$93.48');
      expect(texto()).toContain('En línea · hoy');
      (el.querySelector('.ck-limpiar') as HTMLButtonElement).click();
      await listo();
      expect(el.querySelector('.ck-flota')).toBeNull();
      cmp.alEscribir('paleta');
      await listo();
      expect(el.querySelector('.ck-flota')).toBeTruthy();
      (el.querySelector('input[type=search]') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await listo();
      expect(el.querySelector('.ck-flota')).toBeNull();
    });

    it('tocar fuera cierra la ventana; NEGATIVO: tocar dentro (la ventana o la cámara) no la cierra', async () => {
      const { el, listo, fix, cmp } = montar();
      fix.componentRef.setInput('compacto', true);
      await listo();
      cmp.alEscribir('paleta');
      await listo();
      el.querySelector('.ck-flota')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await listo();
      expect(el.querySelector('.ck-flota')).toBeTruthy();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await listo();
      expect(el.querySelector('.ck-flota')).toBeNull();
      expect(cmp.texto()).toBe('');
    });

    it('la lista trae lo que contiene cada presentación y los dos mayoreos, sin las 3 líneas de contexto', async () => {
      const hallado = { b: { codigo: '00052', item: {
        c: '00052', n: 'DULCE PRUEBA /12', b: [],
        u: [{ u: 'PZA', p: 8.78, s: 8.13, f: 1 }, { u: 'PAQ', p: 93.48, s: 86.56, f: 12 }, { u: 'CJA', p: 1057.11, s: 978.81, f: 144 }],
        m: [
          { e: 'pieza', d: 12, w: 'piezas', p: 8.2, au: 0.58, am: 6.96, pc: 6.6, r: 1, a: 0, um: 'c/u' },
          { e: 'paquete', d: 3, w: 'paquetes', p: 88, au: 5.48, am: 16.44, pc: 5.9, r: 1, a: 1, um: 'por paquete' },
        ] } }, por: 'nombre', exacto: false, esPromocion: false } as unknown as HalladoEnCopia;
      const { texto, listo, fix, cmp } = montar({ hallados: [hallado] });
      fix.componentRef.setInput('compacto', true);
      await listo();
      cmp.alEscribir('dulce');
      await new Promise((r) => setTimeout(r, 150));
      await listo();
      expect(texto()).toContain('Paquete $93.48 · 12 piezas');
      expect(texto()).toContain('Caja $1,057.11 · 12 paquetes');
      expect(texto()).toContain('Mayoreo desde 12 piezas $8.20 c/pieza');
      expect(texto()).toContain('Mayoreo desde 3 paquetes $88.00 c/paquete');
      // David: «esto quítalo».
      expect(texto()).not.toContain('Precio al público de Kepler');
      expect(texto()).not.toContain('Copia para usar sin señal');
      expect(texto()).not.toContain('en tu copia');
    });

    it('por proveedor: la caja lo dice y cada renglón trae su proveedor; ⛔ sin proveedor en la copia no se inventa', async () => {
      const item = { c: '00052', n: 'DULCE PRUEBA /12', b: [], u: [{ u: 'PZA', p: 8.78, s: 8.13, f: 1 }] };
      const conProv = { b: { codigo: '00052', proveedor: 'PROVEEDOR PRUEBA', item }, por: 'proveedor', exacto: false, esPromocion: false } as unknown as HalladoEnCopia;
      const sinProv = { b: { codigo: '00053', proveedor: null, item: { ...item, c: '00053', n: 'OTRO PRUEBA' } }, por: 'nombre', exacto: false, esPromocion: false } as unknown as HalladoEnCopia;
      const { texto, listo, fix, cmp, el, svc } = montar({ hallados: [conProv, sinProv] });
      fix.componentRef.setInput('compacto', true);
      await listo();
      expect((el.querySelector('input[type=search]') as HTMLInputElement).placeholder).toContain('proveedor');
      cmp.alEscribir('proveedor prueba');
      await new Promise((r) => setTimeout(r, 150));
      await listo();
      expect(svc.buscarEnCopia).toHaveBeenCalledWith('02', 'proveedor prueba', expect.any(Number));
      expect(texto()).toContain('Clave 00052 · PROVEEDOR PRUEBA');
      expect(texto()).toContain('Clave 00053');
      expect(texto()).not.toContain('Clave 00053 ·');
    });

    it('⛔ [negativa] si la copia NO es de hoy, en compacto SÍ se avisa (un precio viejo no se ve como de hoy)', async () => {
      const { texto, listo, fix, cmp } = montar({ copia: copia(AYER) });
      fix.componentRef.setInput('compacto', true);
      await listo();
      cmp.alEscribir('dulce');
      await listo();
      expect(texto()).toContain('no es de hoy');
    });

    it('la ficha muestra los dos mayoreos; ⛔ sin mayoreo en la copia lo DICE, no lo calla', async () => {
      const r1 = montar({ consulta: { estado: 'encontrado', origen: 'en_linea', ficha, al: HOY } as ResultadoConsulta });
      r1.fix.componentRef.setInput('compacto', true);
      await r1.listo();
      await r1.cmp.alLeerCodigo('840004096513');
      await r1.listo();
      expect(r1.texto()).toContain('Mayoreo desde 12 piezas: $8.20 c/pieza');
      expect(r1.texto()).toContain('Mayoreo desde 3 paquetes: $88.00 c/paquete');
      TestBed.resetTestingModule();
      const r2 = montar({ consulta: { estado: 'encontrado', origen: 'copia', motivo: 'sin_senal', ficha: { ...ficha, mayoreo: [], mayoreoSabido: false }, al: HOY } as ResultadoConsulta });
      await r2.listo();
      await r2.cmp.alLeerCodigo('840004096513');
      await r2.listo();
      expect(r2.texto()).toContain('Esta copia no trae el mayoreo');
    });

    it('NEGATIVO: en la página normal (no compacto) tocar fuera NO borra la búsqueda', async () => {
      const { listo, cmp } = montar();
      await listo();
      cmp.alEscribir('paleta');
      await listo();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(cmp.texto()).toBe('paleta');
    });
  });

  it('abre con la sucursal NOMBRADA, el buscador, la cámara y de cuándo es la copia', async () => {
    const { texto, el, listo, svc } = montar();
    await listo();
    expect(texto()).toContain('Checador de precios');
    expect(texto()).toContain('Precio al público de Kepler en La Piedad Abastos');
    expect(texto()).toContain('No es la lista de precio del cliente');
    expect(el.querySelector('input[type=search]')).toBeTruthy();
    expect(el.querySelector('app-lector-codigo button[aria-label]')).toBeTruthy();
    expect(texto()).toMatch(/Copia para usar sin señal: hoy \d{2}:\d{2} · 9,537 productos/);
    expect(svc.asegurarCopia).toHaveBeenCalledWith('02', true);
  });

  it('⭐⛔ [negativa] la copia de AYER no se presenta como de hoy: dice su fecha y «no es de hoy»', async () => {
    const { texto, listo, el } = montar({ copia: copia(AYER) });
    await listo();
    expect(texto()).toContain('no es de hoy');
    expect(texto()).not.toMatch(/sin señal: hoy/);
    expect(el.querySelector('.ck-copia')?.classList.contains('warn')).toBe(true);
  });

  it('un código leído: el precio de cada presentación, la que se leyó marcada, y que es en línea', async () => {
    const { cmp, texto, listo, svc } = montar();
    await listo();
    await cmp.alLeerCodigo('840004096513');
    await listo();
    expect(svc.consultar).toHaveBeenCalledWith('840004096513', '02');
    expect(texto()).toContain('DULCE PRUEBA /12');
    expect(texto()).toContain('$93.48');
    expect(texto()).toContain('Trae 12 piezas');
    expect(texto()).toContain('Es la que leíste');
    expect(texto()).toContain('En línea');
  });

  it('⭐ precio de la COPIA: lo dice, con su fecha y el motivo (sin señal)', async () => {
    const { cmp, texto, listo } = montar({
      consulta: { estado: 'encontrado', origen: 'copia', ficha, al: AYER, motivo: 'sin_senal' },
    });
    await listo();
    await cmp.alLeerCodigo('840004096513');
    await listo();
    expect(texto()).toContain('Copia · ayer');
    expect(texto()).toMatch(/Sin señal: este precio es de la copia de ayer \d{2}:\d{2} y pudo cambiar/);
    expect(texto()).not.toContain('En línea');
  });

  it('⛔ [negativa] un código que Kepler no tiene: lo dice y NO pinta ningún precio', async () => {
    const { cmp, texto, listo } = montar({ consulta: { estado: 'no_encontrado', origen: 'en_linea', codigo: '7500000000000', al: HOY } });
    await listo();
    await cmp.alLeerCodigo('7500000000000');
    await listo();
    expect(texto()).toContain('Kepler no tiene el código 7500000000000 en La Piedad Abastos');
    expect(texto()).not.toContain('$');
  });

  it('⛔ [negativa] sin señal y sin copia: «no se puede consultar», sin precio', async () => {
    const { cmp, texto, listo } = montar({ copia: null, enLinea: false, consulta: { estado: 'sin_datos', codigo: '7500000000000', motivo: 'sin_senal' } });
    await listo();
    await cmp.alLeerCodigo('7500000000000');
    await listo();
    expect(texto()).toContain('Sin señal y no hay copia guardada en este teléfono');
    expect(texto()).not.toContain('$');
  });

  it('⭐ sin permiso de cámara: lo dice, y se sigue pudiendo escribir y buscar', async () => {
    const hallado = { b: { codigo: '00052', item: { c: '00052', n: 'DULCE PRUEBA /12', b: [], u: [{ u: 'PZA', p: 8.78, s: 8.13, f: 1 }] } }, por: 'nombre', exacto: false, esPromocion: false } as unknown as HalladoEnCopia;
    const { fix, texto, listo, el, svc } = montar({ hallados: [hallado] });
    await listo();
    const lector = fix.debugElement.query(By.directive(LectorCodigoComponent)).componentInstance as LectorCodigoComponent;
    lector.sinCamara.emit('No se dio permiso para usar la cámara. Puedes escribir el código o el nombre.');
    await listo();
    expect(texto()).toContain('No se dio permiso para usar la cámara');
    const input = el.querySelector('input[type=search]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    input.value = 'dulce';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    await listo();
    expect(svc.buscarEnCopia).toHaveBeenCalledWith('02', 'dulce', 30);
    expect(texto()).toContain('DULCE PRUEBA /12');
    expect(texto()).toContain('Pieza $8.78');
  });

  it('⛔ [negativa] sin sucursal asignada: lo dice y NO consulta con la de omisión', async () => {
    const { texto, listo, el, svc } = montar({ sucursal: { id: 'w2', code: '02', name: 'La Piedad Abastos', assigned: false } });
    await listo();
    expect(texto()).toContain('No tienes sucursal de surtido asignada');
    expect(el.querySelector('input[type=search]')).toBeNull();
    expect(svc.asegurarCopia).not.toHaveBeenCalled();
  });

  it('sin señal al abrir: usa la sucursal de la última copia y lo dice', async () => {
    const { texto, listo } = montar({ fuentesFallan: { status: 504, error: null }, ultima: copia(HOY) });
    await listo();
    expect(texto()).toContain('Precio al público de Kepler en La Piedad Abastos');
    expect(texto()).toContain('Sin señal: se usa la sucursal de tu última copia guardada');
  });
});
