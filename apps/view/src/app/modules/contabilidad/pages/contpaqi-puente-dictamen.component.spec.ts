import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpHeaders, HttpResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { computed, signal } from '@angular/core';
import { EMPTY, Observable, Subject, of, throwError } from 'rxjs';

import { ContabilidadContpaqiPuenteComponent } from './contabilidad-contpaqi-puente.component';
import { ContpaqiPuenteService, type DictamenResp, type LoteRow, type LotesResp } from '../contpaqi-puente.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[CP.8.97]` — **La entrega con el dictamen, en LOCAL**: la plantilla real del paso 4 de
 * /contabilidad/contpaqi-puente, montada con TestBed (jsdom) y la API simulada.
 *
 * Es el espejo de `e2e/contpaqi-puente/dictamen-entrega.e2e.ts`, que no puede correr hasta que prod tenga
 * `GET dictamen` (hoy 404). Las mismas afirmaciones, contra un mes inventado cuyo resultado se conoce:
 *
 *   · 6 filas en `lotes`: 2 listas (un pago y un lote del día SIN `clave`, que se liga por `cuenta|fecha`),
 *     1 por revisar, 1 frenada, 1 ya entregada y 1 sin póliza;
 *   · salen 3 (2 listas + 1 por revisar) por $3,400; la frenada ($3,000) y la entregada no viajan.
 *
 * ⛔ Lo que esto NO cubre y sí cubre la e2e: el navegador real, el dato de prod y el encabezado HTTP de verdad.
 * ⛔ Ningún método del servicio que escriba se puede llamar: el doble los registra y la prueba sale roja.
 */

const PAGO = (clave: string, fecha: string, total: number, extra: Partial<LoteRow> = {}): LoteRow => ({
  cuenta_banco: '0000000001', banco_label: 'BANCO PRUEBA 0001', fecha, movimientos: 1, incluidas: 1, renglones: 3,
  total, iva_traspaso: null, motivos: {}, tipo: 'pago_proveedor', fuente: 'cadena_kepler', cfdis: 2, clave, ...extra,
});

const MSG = {
  frena: 'La factura ya viene en una póliza que contabilidad capturó.',
  revisarC: 'La cuenta del proveedor no está en el catálogo vigente.',
  avisoC: 'El pago cruza de mes.',
  revisarB: 'El importe no cuadra con las facturas por $0.40.',
  avisoB: 'Una nota de crédito se aplicó completa.',
};

function lotesDe(mes: string): LotesResp {
  const d = (dia: string) => `${mes}-${dia}`;
  return {
    mes,
    lotes: [
      PAGO('pp:lista', d('03'), 1000, { movimientos: 1 }),
      PAGO('pp:revisar', d('04'), 2000, { movimientos: 2 }),
      PAGO('pp:frenada', d('06'), 3000, { movimientos: 1 }),
      PAGO('pp:entregada', d('07'), 5000, { movimientos: 4 }),
      // El lote del día: sin `clave`, su fila es `cuenta|fecha` — el camino que el backend espeja en `filaDeLote`.
      { cuenta_banco: '0000000002', banco_label: 'BANCO PRUEBA 0002', fecha: d('05'), movimientos: 9, incluidas: 2,
        renglones: 4, total: 400, iva_traspaso: null, motivos: { sin_regla: 7 } },
      { cuenta_banco: '0000000003', banco_label: 'BANCO PRUEBA 0003', fecha: d('08'), movimientos: 6, incluidas: 0,
        renglones: 0, total: 0, iva_traspaso: null, motivos: { sin_regla: 6 } },
    ],
    resumen: { lotes: 6, con_asiento: 5, movimientos: 23, incluidas: 7, universo: 23 },
    fuera_de_lote: { movimientos: 0, importe: 0, cuentas: [] },
    motivos: [{ motivo: 'sin_regla', movimientos: 13, dueno: 'Contabilidad — firmar la regla' }],
  };
}

function dictamenDe(mes: string): DictamenResp {
  const p = (clave: string, lote: string, veredicto: 'lista' | 'revisar' | 'bloqueada', total: number,
    hallazgos: DictamenResp['polizas'][number]['hallazgos'] = []) =>
    ({ clave, lote, veredicto, hallazgos, total, fecha: `${mes}-01`, evento_tipo: 'x', tipo: 'x', banco_label: null });
  return {
    mes, hoy: `${mes}-28`,
    resumen: { polizas: 4, por_veredicto: { lista: 2, revisar: 1, bloqueada: 1 } },
    polizas: [
      p('pp:lista', 'pp:lista', 'lista', 1000),
      p('pp:revisar', 'pp:revisar', 'revisar', 2000, [
        { regla: 'r2', perspectiva: 'x', severidad: 'aviso', mensaje: MSG.avisoB },
        { regla: 'r1', perspectiva: 'x', severidad: 'revisar', mensaje: MSG.revisarB },
      ]),
      // Desordenados a propósito: la pantalla los ordena por gravedad.
      p('pp:frenada', 'pp:frenada', 'bloqueada', 3000, [
        { regla: 'r3', perspectiva: 'x', severidad: 'aviso', mensaje: MSG.avisoC },
        { regla: 'r4', perspectiva: 'x', severidad: 'revisar', mensaje: MSG.revisarC },
        { regla: 'r5', perspectiva: 'x', severidad: 'bloquea', mensaje: MSG.frena },
      ]),
      p('lote:0000000002', `0000000002|${mes}-05`, 'lista', 400),
    ],
    ya_entregadas: 1, cambiados: [], entregadas: ['pp:entregada'],
  };
}

describe('[CP.8.97] /contabilidad/contpaqi-puente · la entrega con el dictamen (plantilla real, local)', () => {
  let fixture: ComponentFixture<ContabilidadContpaqiPuenteComponent>;
  let dictamen$: Subject<DictamenResp>;
  let dictamenFalla: string | null;
  let escrituras: string[];
  let archivoHeaders: Record<string, string>;
  let mes: string;

  const el = () => fixture.nativeElement as HTMLElement;
  const txt = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const numero = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));
  const pinta = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const todos = <T extends Element = HTMLElement>(sel: string) => Array.from(el().querySelectorAll<T & HTMLElement>(sel));
  const boton = (sel: string, t: string | RegExp) =>
    todos<HTMLButtonElement>(sel).find((b) => (typeof t === 'string' ? txt(b).includes(t) : t.test(txt(b))));
  const filas = () => todos('tr.cpp-lote');
  const veredictos = () => filas().map((f) => txt(f.querySelectorAll('td')[1]));
  const chips = () => {
    const out: Record<string, number> = {};
    for (const c of todos('.cpp-chip')) {
      const m = txt(c).match(/^(.*?)\s*([\d,]+)$/);
      if (m) out[m[1]] = numero(m[2]);
    }
    return out;
  };
  const chip = (nombre: string) => todos('.cpp-chip').find((c) => txt(c).startsWith(nombre + ' '));
  /** Las tarjetas de la tira que se abren son `div role="button"`, no `<button>`. */
  const tarjeta = (label: string) => todos('.ms-item[role="button"]').find((b) => b.getAttribute('aria-label') === label);
  const paso4 = async () => { boton('.cpp-paso', 'Revisar y entregar')!.click(); await pinta(); };

  /** Monta la pantalla. Lo que no sea lectura queda registrado en `escrituras` y devuelve EMPTY. */
  async function montar(gestionar = true): Promise<void> {
    const lecturas: Record<string, (...a: unknown[]) => Observable<unknown>> = {
      lotes: (m) => of(lotesDe(m as string)),
      dictamen: () => (dictamenFalla ? throwError(() => ({ error: { message: dictamenFalla } })) : dictamen$.asObservable()),
      cuadre: () => of({ hay_entregas: true, por_estado: {}, verificadas: 1, esperando: 0, divergentes: 0, plazo_dias: 5 }),
      pendientes: (m) => of({ mes: m, total_importe: 0, filas: [] }),
      reglas: (m) => of({ mes: m, reglas: [] }),
      cuentasGasto: () => of({ cuentas: [] }),
      pagosPorConfirmar: (m) => of({ mes: m, pagos: [] }),
      archivo: () => of(new HttpResponse({
        body: new Blob(['POLIZA'], { type: 'text/plain' }), headers: new HttpHeaders(archivoHeaders), status: 200,
      })),
    };
    const api = new Proxy({}, {
      get: (_t, prop: string) => lecturas[prop] ?? ((..._a: unknown[]) => { escrituras.push(prop); return EMPTY; }),
    });
    const permisos = gestionar ? { [Permission.FISCAL_CONTPAQI_BRIDGE_GESTIONAR]: true } : {};
    TestBed.configureTestingModule({
      imports: [ContabilidadContpaqiPuenteComponent],
      providers: [
        provideRouter([]),
        { provide: ContpaqiPuenteService, useValue: api },
        { provide: AuthService, useValue: { user: signal({ permissions: permisos }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false, has$: () => computed(() => false) } },
      ],
    });
    fixture = TestBed.createComponent(ContabilidadContpaqiPuenteComponent);
    mes = fixture.componentInstance.mes();
    await pinta();
  }
  const llegaDictamen = async () => { dictamen$.next(dictamenDe(mes)); await pinta(); };

  beforeEach(() => {
    dictamen$ = new Subject();
    dictamenFalla = null;
    escrituras = [];
    archivoHeaders = { 'X-Polizas': '3', 'X-Bloqueadas-Dictamen': '1' };
  });
  afterEach(() => {
    expect(escrituras, '⛔ la pantalla llamó un método que escribe').toEqual([]);
    vi.restoreAllMocks();
  });

  it('antes del dictamen dice lo ARMADO y que está revisando; no adelanta un veredicto', async () => {
    await montar();
    expect(txt(el().querySelector('.cpp-verdict h2'))).toMatch(/^5 pólizas armadas/);
    expect(txt(el().querySelector('.cpp-v-sub'))).toContain('Revisando cada póliza');
    await paso4();
    expect(todos('tr.cpp-lote p-tag')).toHaveLength(0);
    expect(chip('Frenadas')).toBeUndefined();
  });

  it('arriba: cuántas salen y cuánto suman = listas + por revisar; lo frenado y lo entregado no', async () => {
    await montar();
    await llegaDictamen();
    const h2 = txt(el().querySelector('.cpp-verdict h2'));
    expect(h2).toMatch(/^3 pólizas salen en el archivo/);
    expect(numero(txt(el().querySelector('.cpp-v-imp')))).toBe(3400);
    const sub = txt(el().querySelector('.cpp-v-sub'));
    expect(sub).toContain('1 por revisar antes de entregar');
    expect(sub).toContain('1 frenada por el dictamen, no sale');
    expect(sub).toContain('1 ya entregada');
  });

  it('el paso 4 dice lo que sale, no lo armado', async () => {
    await montar();
    expect(numero(txt(boton('.cpp-paso', 'Revisar y entregar')!.querySelector('.cpp-paso-s')))).toBe(5);
    await llegaDictamen();
    expect(numero(txt(boton('.cpp-paso', 'Revisar y entregar')!.querySelector('.cpp-paso-s')))).toBe(3);
  });

  it('cada chip cuenta lo que dice la API, y al elegirlo la lista muestra sólo eso', async () => {
    await montar();
    await llegaDictamen();
    await paso4();
    const c = chips();
    expect(c['Frenadas']).toBe(1);
    expect(c['Por revisar']).toBe(1);
    expect(c['Listas']).toBe(2);
    expect(c['Ya entregadas']).toBe(1);
    expect(c['Todas']).toBe(6);

    for (const [nombre, etiqueta, n] of [['Frenadas', 'Frenada', 1], ['Por revisar', 'Por revisar', 1],
      ['Listas', 'Lista', 2], ['Ya entregadas', 'Ya entregada', 1]] as const) {
      chip(nombre)!.click();
      await pinta();
      expect(chip(nombre)!.getAttribute('aria-pressed'), nombre).toBe('true');
      expect(filas(), `filas con «${nombre}»`).toHaveLength(n);
      expect(new Set(veredictos()), nombre).toEqual(new Set([etiqueta]));
      chip('Todas')!.click();
      await pinta();
    }
    expect(filas()).toHaveLength(6);
  });

  it('el lote del día sin `clave` se liga por cuenta|fecha (no queda sin veredicto)', async () => {
    await montar();
    await llegaDictamen();
    await paso4();
    const fila = filas().find((f) => txt(f).includes('BANCO PRUEBA 0002'))!;
    expect(txt(fila.querySelectorAll('td')[1])).toBe('Lista');
    // La fila sin póliza no inventa veredicto.
    expect(txt(filas().find((f) => txt(f).includes('BANCO PRUEBA 0003'))!.querySelectorAll('td')[1])).toBe('');
  });

  it('sin filtro, lo frenado va primero y después lo por revisar', async () => {
    await montar();
    await llegaDictamen();
    await paso4();
    expect(veredictos().slice(0, 2)).toEqual(['Frenada', 'Por revisar']);
  });

  it('el porqué en la fila es su hallazgo más grave, y el detalle los lista del más grave al más leve', async () => {
    await montar();
    await llegaDictamen();
    await paso4();
    const [frenada, revisar] = filas();
    expect(txt(frenada.querySelector('.cpp-porque'))).toBe(MSG.frena);
    expect(txt(revisar.querySelector('.cpp-porque'))).toBe(MSG.revisarB);
    // Un aviso no es un porqué; una lista no lleva porqué.
    const lista = filas().find((f) => txt(f).includes('BANCO PRUEBA 0002'))!;
    expect(lista.querySelector('.cpp-porque')).toBeNull();

    frenada.querySelector('td')!.click();
    await pinta();
    const peek = todos('.cpp-peek').find((p) => p.querySelector('.cpp-dict'))!;
    expect(txt(peek.querySelector('.cpp-dict'))).toContain('Frenada');
    expect(todos('.cpp-hallazgos li').map(txt)).toEqual([
      `Frena: ${MSG.frena}`, `Revisar: ${MSG.revisarC}`, `Aviso: ${MSG.avisoC}`,
    ]);
  });

  it('la frase de arriba y la tira de métricas abren lo frenado', async () => {
    await montar();
    await llegaDictamen();
    boton('.cpp-v-sub button', /frenada por el dictamen/)!.click();
    await pinta();
    expect(chip('Frenadas')!.getAttribute('aria-pressed')).toBe('true');
    expect(filas()).toHaveLength(1);

    chip('Todas')!.click();
    await pinta();
    tarjeta('Ver las pólizas frenadas por el dictamen')!.click();
    await pinta();
    expect(chip('Frenadas')!.getAttribute('aria-pressed')).toBe('true');

    tarjeta('Ver las pólizas por revisar')!.click();
    await pinta();
    expect(chip('Por revisar')!.getAttribute('aria-pressed')).toBe('true');
    expect(veredictos()).toEqual(['Por revisar']);
  });

  it('la ayuda del dictamen está junto a la frase', async () => {
    await montar();
    await llegaDictamen();
    // El diccionario de ayuda se carga con import() perezoso: se espera a que llegue.
    const ayuda = () => todos<HTMLButtonElement>('.cpp-v-sub button').find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Ayuda: El dictamen'));
    await vi.waitFor(async () => { await pinta(); if (!ayuda()) throw new Error('sin botón todavía'); }, { timeout: 10_000 });
    expect(ayuda(), 'botón de ayuda del tema contpaqi-dictamen').toBeTruthy();
  });

  it('el aviso de descarga cuenta lo que dicen los ENCABEZADOS del archivo, no la pantalla', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // Distintos a los del dictamen a propósito: si el aviso leyera la pantalla, diría 3 y 1.
    archivoHeaders = { 'X-Polizas': '2', 'X-Bloqueadas-Dictamen': '4' };
    await montar();
    await llegaDictamen();
    await paso4();
    boton('button', 'Descargar el archivo')!.click();
    await pinta();
    const aviso = txt(todos('.cpp-aviso').find((a) => txt(a).includes('generado')));
    expect(aviso).toContain('con 2 pólizas');
    expect(aviso).toContain('4 frenadas por el dictamen no van');
    expect(aviso).toContain('NO quedó marcado como entregado');
  });

  it('el aviso «por revisar sí van» acompaña al botón de descarga', async () => {
    await montar();
    await llegaDictamen();
    await paso4();
    expect(txt(el().querySelector('.cpp-ojo'))).toContain('1 póliza por revisar sí va en el archivo');
  });

  it('sin _GESTIONAR no hay botón de descarga, y el dictamen igual se ve', async () => {
    await montar(false);
    await llegaDictamen();
    await paso4();
    expect(boton('button', 'Descargar el archivo')).toBeUndefined();
    expect(chips()['Frenadas']).toBe(1);
  });

  it('⛔ si el dictamen falla, lo dice con Reintentar y arriba sigue diciendo lo armado (no «salen»)', async () => {
    dictamenFalla = 'tiempo agotado';
    await montar();
    expect(txt(el().querySelector('.cpp-verdict h2'))).toMatch(/^5 pólizas armadas/);
    const sub = el().querySelector('.cpp-v-sub[role="alert"]');
    expect(txt(sub)).toContain('No se pudo dictaminar el mes: tiempo agotado');
    expect(boton('.cpp-v-sub button', 'Reintentar')).toBeTruthy();
    await paso4();
    expect(chip('Frenadas')).toBeUndefined();
    expect(tarjeta('Ver las pólizas frenadas por el dictamen')).toBeUndefined();

    // Reintentar con el servicio sano trae el dictamen.
    dictamenFalla = null;
    boton('.cpp-v-sub button', 'Reintentar')!.click();
    await llegaDictamen();
    expect(txt(el().querySelector('.cpp-verdict h2'))).toMatch(/^3 pólizas salen/);
  });

  it('un dictamen de OTRO mes (respuesta tardía) no se pinta', async () => {
    await montar();
    dictamen$.next({ ...dictamenDe(mes), mes: '1999-01' });
    await pinta();
    expect(txt(el().querySelector('.cpp-verdict h2'))).toMatch(/^5 pólizas armadas/);
  });
});
