import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { OfflineDatabaseService } from '../../core/services/offline-database.service';
import { ResultadoBusqueda, VerificadorService } from './verificador.service';

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
});
