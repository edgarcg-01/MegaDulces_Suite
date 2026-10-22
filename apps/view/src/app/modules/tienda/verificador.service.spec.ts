import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { VERIFICADOR_SNAPSHOT_FORMATO } from '@megadulces/contracts';
import { OfflineDatabaseService } from '../../core/services/offline-database.service';
import { ResultadoBusqueda, VerificadorService, causaRespaldo, clasificarFallo, esFormatoAnterior } from './verificador.service';

/**
 * `[CV.24]` — El contrato del verificador de mostrador, que es el que decide si la clienta
 * ve un precio verdadero o uno viejo sin saberlo.
 *
 * Tres cosas se comprueban porque tres cosas se pueden romper en silencio:
 *
 *  1. **En vivo primero.** Si el ODS contesta, se usa el ODS. Obvio, y justo por eso nadie
 *     lo prueba.
 *  2. **Un "no encontrado" del servidor es AUTORITATIVO.** Es la asimetría que importa: el
 *     respaldo es más viejo que el ODS, así que re-preguntarle podría resucitar un producto
 *     que ya no existe o un precio que ya cambió. Solo la falla de RED cae al respaldo.
 *  3. **El origen viaja con el precio.** Un precio de respaldo que llegue rotulado como
 *     `live` es exactamente la mentira que ADR-056 existe para impedir: la pantalla pinta
 *     su advertencia a partir de este campo, así que si el campo miente, la advertencia
 *     no aparece.
 *
 * Más el índice del respaldo, que resuelve por clave Y por código de barras porque Kepler
 * tiene cinco casillas de código de barras y el capturista usa la que encuentra libre.
 */

/** Snapshot mínimo con la forma que serializa `KpService.getPreciosTodos`. */
const SNAPSHOT = {
  v: VERIFICADOR_SNAPSHOT_FORMATO,
  total: 2,
  sucursal: '03',
  generado: '2026-09-08T12:00:00.000Z',
  productos: [
    { c: '17083', b: ['7501030459736'], n: 'PALETA PAYASO', u: [{ u: 'PZA', p: 18.5, s: 15.95 }] },
    { c: '00042', b: [], n: 'GOMITA ENCHILADA', u: [{ u: 'PZA', p: 5, s: 4.31 }] },
  ],
};

/** Doble de la base offline: guarda en memoria, misma firma que la real. */
class OfflineFake {
  guardado = new Map<string, { datos: unknown; version: string; ultima_sincronizacion: string }>();

  async guardarSnapshotPrecios(sucursal: string, datos: unknown, version: string): Promise<void> {
    this.guardado.set(sucursal, { datos, version, ultima_sincronizacion: new Date().toISOString() });
  }

  async getSnapshotPrecios(sucursal: string): Promise<any> {
    return this.guardado.get(sucursal);
  }
}

describe('VerificadorService · en vivo primero, respaldo después, y se dice cuál', () => {
  let svc: VerificadorService;
  let http: HttpTestingController;
  let offline: OfflineFake;

  beforeEach(() => {
    offline = new OfflineFake();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        VerificadorService,
        { provide: OfflineDatabaseService, useValue: offline },
      ],
    });
    svc = TestBed.inject(VerificadorService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Siembra el respaldo de la sucursal 03 sin pasar por HTTP. */
  const sembrarRespaldo = () =>
    offline.guardarSnapshotPrecios('03', SNAPSHOT, SNAPSHOT.generado);

  it('usa el precio del ODS cuando hay red, y lo rotula como en línea', async () => {
    let r: ResultadoBusqueda | undefined;
    svc.buscar('17083', '03').subscribe((x) => (r = x));

    const req = http.expectOne((rq) => rq.url.endsWith('/kp/precio'));
    expect(req.request.params.get('q')).toBe('17083');
    req.flush({
      ok: true, codigo: '17083', nombre: 'PALETA PAYASO', iva_pct: 16, ieps_pct: 0,
      unidades: [{ u: 'PZA', precio_con_iva: 19.9, precio_sin_iva: 17.16, factor: 1 }],
    });

    expect(r).toBeDefined();
    expect(r!.estado).toBe('encontrado');
    if (r!.estado !== 'encontrado') return;
    expect(r!.origen).toBe('live');
    // El precio VIGENTE, no el del snapshot (18.50): si esto trae 18.5, el orden se invirtió.
    expect(r!.producto.unidades[0].precio_con_iva).toBe(19.9);
  });

  it('⭐ [ETQ-PROMO.2] en vivo: es_promocion llega a la pantalla como esPromocion', async () => {
    let r: ResultadoBusqueda | undefined;
    svc.buscar('09089', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio')).flush({
      ok: true, codigo: '09089', nombre: '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS', es_promocion: true,
      unidades: [{ u: 'PZA', precio_con_iva: 0.01, precio_sin_iva: 0.01, factor: 1 }],
    });
    if (r!.estado !== 'encontrado') throw new Error('debía encontrarlo');
    expect(r!.esPromocion).toBe(true);
  });

  it('⛔ [negativa] un servidor anterior (sin es_promocion) NO se lee como promoción', async () => {
    let r: ResultadoBusqueda | undefined;
    svc.buscar('17083', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio')).flush({
      ok: true, codigo: '17083', nombre: 'PALETA PAYASO',
      unidades: [{ u: 'PZA', precio_con_iva: 19.9, precio_sin_iva: 17.16, factor: 1 }],
    });
    if (r!.estado !== 'encontrado') throw new Error('debía encontrarlo');
    expect(r!.esPromocion).toBe(false);
  });

  it('⭐ [ETQ-PROMO.2] sin red: el respaldo (formato 4) marca la promoción con pm:1', async () => {
    await offline.guardarSnapshotPrecios('03', {
      ...SNAPSHOT,
      productos: [...SNAPSHOT.productos, { c: '09089', b: [], n: '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS', u: [{ u: 'PZA', p: 0.01, s: 0.01 }], pm: 1 }],
    }, SNAPSHOT.generado);
    let r: ResultadoBusqueda | undefined;
    svc.buscar('09089', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
    await Promise.resolve();
    await Promise.resolve();
    if (r!.estado !== 'encontrado') throw new Error('debía estar en el respaldo');
    expect(r!.origen).toBe('respaldo');
    expect(r!.esPromocion).toBe(true);
  });

  it('cae al respaldo cuando la red falla, y lo declara como respaldo', async () => {
    await sembrarRespaldo();

    let r: ResultadoBusqueda | undefined;
    svc.buscar('17083', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
    await Promise.resolve();
    await Promise.resolve();

    expect(r).toBeDefined();
    expect(r!.estado).toBe('encontrado');
    if (r!.estado !== 'encontrado') return;
    expect(r!.origen).toBe('respaldo');
    expect(r!.producto.unidades[0].precio_con_iva).toBe(18.5);
    expect(r!.snapshotAl).toBe(SNAPSHOT.generado);
    // El respaldo NO trae las tasas: se declara que no las sabe en vez de dibujar un 0.
    expect(r!.producto.iva_pct).toBeNull();
  });

  it('NO consulta el respaldo cuando el servidor dice que el producto no existe', async () => {
    await sembrarRespaldo();

    let r: ResultadoBusqueda | undefined;
    // '17083' SÍ está en el respaldo: si el fallback se disparara, contestaría "encontrado".
    svc.buscar('17083', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio'))
      .flush({ ok: false, code: '17083', error: 'Producto no encontrado' });

    expect(r!.estado).toBe('no_encontrado');
    if (r!.estado !== 'no_encontrado') return;
    expect(r!.origen).toBe('live');
  });

  /**
   * `[VAC.L3]` Un 503 del servidor (el ODS falló) NO es "no encontrado": cae al respaldo.
   *
   * Antes el backend contestaba un fallo de base como `200 { ok:false, error: <mensaje> }` y esta
   * misma capa lo leía como "el catálogo contestó que no está": pantalla de PRODUCTO NO
   * ENCONTRADO sin mirar el respaldo, que sí tenía el precio. Ahora el backend lanza un 5xx con
   * `codigo_error: 'error_interno'` y el servidor roto se trata como el servidor roto.
   */
  it('un 503 del servidor cae al respaldo y NO se confunde con "no encontrado"', async () => {
    await sembrarRespaldo();

    let r: ResultadoBusqueda | undefined;
    svc.buscar('17083', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio'))
      .flush({ ok: false, codigo_error: 'error_interno' }, { status: 503, statusText: 'Service Unavailable' });
    await Promise.resolve();
    await Promise.resolve();

    expect(r!.estado).toBe('encontrado');
    if (r!.estado !== 'encontrado') return;
    expect(r!.origen).toBe('respaldo');
    expect(r!.producto.unidades[0].precio_con_iva).toBe(18.5);
  });

  /**
   * `[VAC.L10]` La causa de la caída viaja con el resultado: "sin red", "lento", "el servidor falló" y
   * "rechazó la consulta" son cuatro cosas distintas y mandan a la persona a lugares distintos.
   */
  describe('motivo del respaldo [VAC.L10]', () => {
    const tras = async (fallo: (r: { error: (e: unknown, o?: object) => void; flush: (b: unknown, o?: object) => void }) => void) => {
      await sembrarRespaldo();
      let r: ResultadoBusqueda | undefined;
      svc.buscar('17083', '03').subscribe((x) => (r = x));
      fallo(http.expectOne((rq) => rq.url.endsWith('/kp/precio')) as never);
      await Promise.resolve();
      await Promise.resolve();
      return r!;
    };

    it('un corte de red se declara sin_red', async () => {
      const r = await tras((q) => q.error(new ProgressEvent('offline')));
      expect(r.estado).toBe('encontrado');
      if (r.estado === 'encontrado') expect(r.motivoRespaldo).toBe('sin_red');
    });

    it('un 503 se declara servidor: la red estaba bien y falló el servidor', async () => {
      const r = await tras((q) => q.flush({ ok: false, codigo_error: 'error_interno' }, { status: 503, statusText: 'x' }));
      if (r.estado === 'encontrado') expect(r.motivoRespaldo).toBe('servidor');
      else throw new Error('debió encontrar en el respaldo');
    });

    it('un 400 se declara peticion', async () => {
      const r = await tras((q) => q.flush({ message: 'Payload invalido' }, { status: 400, statusText: 'x' }));
      if (r.estado === 'encontrado') expect(r.motivoRespaldo).toBe('peticion');
      else throw new Error('debió encontrar en el respaldo');
    });

    it('sin respaldo, la causa también viaja en "sin datos"', async () => {
      let r: ResultadoBusqueda | undefined;
      svc.buscar('17083', '03').subscribe((x) => (r = x));
      http.expectOne((rq) => rq.url.endsWith('/kp/precio'))
        .flush({}, { status: 500, statusText: 'x' });
      await Promise.resolve();
      await Promise.resolve();
      expect(r).toEqual({ estado: 'sin_datos', codigo: '17083', motivoRespaldo: 'servidor' });
    });

    it('el tiempo de espera agotado se declara lento', async () => {
      vi.useFakeTimers();
      try {
        await sembrarRespaldo();
        let r: ResultadoBusqueda | undefined;
        svc.buscar('17083', '03').subscribe((x) => (r = x));
        http.expectOne((rq) => rq.url.endsWith('/kp/precio'));   // nunca se contesta
        await vi.advanceTimersByTimeAsync(2600);
        await Promise.resolve();
        expect(r?.estado).toBe('encontrado');
        if (r?.estado === 'encontrado') expect(r.motivoRespaldo).toBe('lento');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clasificarFallo: cada forma de fallar cae en su causa', () => {
      const http = (status: number) => new HttpErrorResponse({ status });
      expect(clasificarFallo(http(0))).toBe('sin_red');
      expect(clasificarFallo(http(500))).toBe('servidor');
      expect(clasificarFallo(http(503))).toBe('servidor');
      expect(clasificarFallo(http(400))).toBe('peticion');
      expect(clasificarFallo(http(404))).toBe('peticion');
      expect(clasificarFallo(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('lento');
      // Lo que no se puede ubicar: el servidor (la respuesta se rompió), no la red.
      expect(clasificarFallo(new Error('algo raro'))).toBe('servidor');
    });

    it('sin_red reproduce EXACTO el texto que la pantalla ya tenía; las demás lo cambian', () => {
      expect(causaRespaldo()).toMatchObject({
        prefijo: 'Sin conexión', vuelve: 'vuelva la red', titulo: 'SIN CONEXIÓN AL SERVIDOR', ayuda: 'Verifica la red.',
      });
      expect(causaRespaldo('sin_red')).toEqual(causaRespaldo(undefined));
      // Una falla del servidor NO manda a revisar la red.
      expect(causaRespaldo('servidor').ayuda).not.toMatch(/red\./);
      expect(causaRespaldo('servidor').prefijo).not.toMatch(/conexión/i);
    });
  });

  /**
   * `[VAC.L11]` El snapshot declara la versión de su formato. Uno anterior se DICE y se refresca
   * en cuanto hay red, en vez de esperar las 12 h y degradar en silencio.
   */
  describe('formato del snapshot [VAC.L11]', () => {
    const { v: _v, ...VIEJO } = SNAPSHOT;
    const reciente = () => new Date().toISOString();

    it('esFormatoAnterior: sin v es formato 1; con la versión vigente no lo es', () => {
      expect(esFormatoAnterior(VIEJO as never)).toBe(true);
      expect(esFormatoAnterior({ v: 1 })).toBe(true);
      expect(esFormatoAnterior({ v: VERIFICADOR_SNAPSHOT_FORMATO })).toBe(false);
      expect(esFormatoAnterior(null)).toBe(true);   // sin snapshot no hay nada que dar por vigente
    });

    it('un respaldo sin v se declara de formato anterior al cargarse', async () => {
      await offline.guardarSnapshotPrecios('03', VIEJO, VIEJO.generado);
      svc.buscar('17083', '03').subscribe();
      http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
      await Promise.resolve();
      await Promise.resolve();
      expect(svc.snapshot()?.formatoAnterior).toBe(true);
    });

    it('un respaldo de formato vigente NO se declara anterior', async () => {
      await sembrarRespaldo();
      svc.buscar('17083', '03').subscribe();
      http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
      await Promise.resolve();
      await Promise.resolve();
      expect(svc.snapshot()?.formatoAnterior).toBe(false);
    });

    it('⛔ un respaldo RECIENTE pero de formato anterior se re-descarga ya, sin esperar el TTL', async () => {
      await offline.guardarSnapshotPrecios('03', VIEJO, VIEJO.generado);
      offline.guardado.get('03')!.ultima_sincronizacion = reciente();   // hace segundos: no vencido

      let r: unknown;
      svc.asegurarSnapshot('03').subscribe((x) => (r = x));
      await Promise.resolve();
      await Promise.resolve();
      const req = http.expectOne((rq) => rq.url.endsWith('/kp/precios-todos'));
      req.flush(SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((ok) => setTimeout(ok, 0));
      expect((r as { formatoAnterior?: boolean }).formatoAnterior).toBe(false);
    });

    it('un respaldo reciente y de formato vigente NO se vuelve a bajar', async () => {
      await sembrarRespaldo();
      offline.guardado.get('03')!.ultima_sincronizacion = reciente();
      svc.asegurarSnapshot('03').subscribe();
      await Promise.resolve();
      await Promise.resolve();
      http.expectNone((rq) => rq.url.endsWith('/kp/precios-todos'));
    });
  });

  it('sin red y sin respaldo descargado dice "sin datos", no "no existe"', async () => {
    let r: ResultadoBusqueda | undefined;
    svc.buscar('17083', '03').subscribe((x) => (r = x));
    http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
    await Promise.resolve();
    await Promise.resolve();

    // La distinción es de UI (DESIGN pre-vuelo 6): un fallo de red que se muestra como
    // vacío real le dice al mostrador que el producto no tiene precio, y es falso.
    expect(r!.estado).toBe('sin_datos');
  });

  it('el respaldo resuelve por código de barras y por la clave sin ceros', async () => {
    await sembrarRespaldo();

    for (const [codigo, esperado] of [
      ['7501030459736', 'PALETA PAYASO'],
      ['42', 'GOMITA ENCHILADA'],   // la clave viaja con LPAD 5 ('00042'); el teclado da '42'
      ['00042', 'GOMITA ENCHILADA'],
    ] as const) {
      let r: ResultadoBusqueda | undefined;
      svc.buscar(codigo, '03').subscribe((x) => (r = x));
      http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
      await Promise.resolve();
      await Promise.resolve();

      expect(r!.estado).toBe('encontrado');
      if (r!.estado !== 'encontrado') continue;
      expect(r!.producto.nombre).toBe(esperado);
    }
  });

  it('descargar el respaldo lo persiste por SUCURSAL y publica su estado', async () => {
    let estado: unknown;
    svc.descargarSnapshot('03').subscribe((s) => (estado = s));

    const req = http.expectOne((rq) => rq.url.endsWith('/kp/precios-todos'));
    // Sin sucursal, kdii trae una fila por plaza y el precio mostrado sería el de otra
    // tienda (385 códigos difieren). El parámetro es obligatorio, no opcional.
    expect(req.request.params.get('sucursal')).toBe('03');
    req.flush(SNAPSHOT);
    await Promise.resolve();
    await Promise.resolve();

    expect(estado).toEqual(expect.objectContaining({ sucursal: '03', total: 2 }));
    expect(offline.guardado.has('03')).toBe(true);
    expect(svc.snapshot()?.total).toBe(2);
  });

  describe('[MOS.1] el buscador del mostrador sobre el respaldo', () => {
    const CON_PROVEEDOR = {
      ...SNAPSHOT,
      pr: ['RICOLINO'],
      productos: [
        { c: '17083', b: ['7501030459736'], n: 'PALETA PAYASO', pv: 0,
          u: [{ u: 'PZA', p: 18.5, s: 15.95, f: 1 }, { u: 'CJA', p: 400, s: 344.83, f: 24 }] },
        { c: '00042', b: [], n: 'GOMITA ENCHILADA', u: [{ u: 'PZA', p: 5, s: 4.31, f: 1 }] },
      ],
    };

    it('encuentra por proveedor y entrega el proveedor y el factor de cada presentación', async () => {
      await offline.guardarSnapshotPrecios('03', CON_PROVEEDOR, CON_PROVEEDOR.generado);
      const r = await svc.buscarEnCatalogo('03', 'ricolino');
      expect(r).toHaveLength(1);
      expect(r![0]).toMatchObject({ codigo: '17083', proveedor: 'RICOLINO', por: 'proveedor' });
      expect(r![0].unidades.map((x) => [x.u, x.factor])).toEqual([['PZA', 1], ['CJA', 24]]);
    });

    it('⭐ [ETQ-PROMO.2] marca las promociones (pm:1) y las manda al final: el producto primero', async () => {
      await offline.guardarSnapshotPrecios('03', {
        ...SNAPSHOT,
        productos: [
          { c: '09089', b: [], n: '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS', u: [{ u: 'PZA', p: 0.01, s: 0.01, f: 1 }], pm: 1 },
          { c: '10245', b: [], n: 'OREO GALLETA 36 G', u: [{ u: 'PZA', p: 18.5, s: 15.95, f: 1 }] },
        ],
      }, SNAPSHOT.generado);
      const r = await svc.buscarEnCatalogo('03', 'oreo');
      expect(r!.map((x) => [x.codigo, x.esPromocion])).toEqual([['10245', false], ['09089', true]]);
    });
    it('sin respaldo dice "no puedo buscar" (null), no "no hay resultados"', async () => {
      expect(await svc.buscarEnCatalogo('03', 'paleta')).toBeNull();
    });

    it('un respaldo de formato anterior (sin f ni pv) sigue buscando por nombre, sin inventar proveedor', async () => {
      await sembrarRespaldo();
      const r = await svc.buscarEnCatalogo('03', 'paleta');
      expect(r![0]).toMatchObject({ codigo: '17083', proveedor: null, por: 'nombre' });
      expect(r![0].unidades[0].factor).toBe(1);
    });

    it('el respaldo por código también trae el proveedor y el factor', async () => {
      await offline.guardarSnapshotPrecios('03', CON_PROVEEDOR, CON_PROVEEDOR.generado);
      let r: ResultadoBusqueda | undefined;
      svc.buscar('7501030459736', '03').subscribe((x) => (r = x));
      http.expectOne((rq) => rq.url.endsWith('/kp/precio')).error(new ProgressEvent('offline'));
      await Promise.resolve();
      await Promise.resolve();
      expect(r!.estado).toBe('encontrado');
      if (r!.estado !== 'encontrado') return;
      expect(r!.producto.proveedor).toBe('RICOLINO');
      expect(r!.producto.unidades[1].factor).toBe(24);
    });
  });
});
