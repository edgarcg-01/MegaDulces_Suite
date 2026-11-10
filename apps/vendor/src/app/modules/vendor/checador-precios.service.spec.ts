import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { VerificadorSnapshot } from '@megadulces/contracts';
import { OfflineDatabaseService, type CatalogoOffline } from '../../core/services/offline-database.service';
import { ChecadorPreciosService } from './checador-precios.service';

/**
 * `[VTK.17]` `[VTK.18]` El servicio del checador contra un servidor y una Dexie de mentira.
 *
 * Lo que se cuida, con su negativa: sin señal y con copia → precio DE LA COPIA con su fecha; sin
 * señal y sin copia → «no se puede», NUNCA un precio inventado; un «no encontrado» del servidor NO
 * se re-pregunta a la copia; la copia no se re-baja si es de hoy.
 */

const hoy = () => new Date().toISOString();
const COPIA = (generado = hoy()): VerificadorSnapshot => ({
  v: 4, total: 2, sucursal: '02', generado,
  productos: [
    { c: '00052', n: 'DULCE PRUEBA /12', b: ['840004096513'], bu: ['PAQ'], u: [{ u: 'PZA', p: 8.78, s: 8.13, f: 1 }, { u: 'PAQ', p: 93.48, s: 86.56, f: 12 }] },
    { c: '14055', n: 'TAMARINDO PRUEBA 20P', b: ['7501056320011'], u: [{ u: 'PZA', p: 6.5, s: 6, f: 1 }] },
  ],
});

function montar(copias: Record<string, VerificadorSnapshot> = {}) {
  const guardadas = new Map<string, CatalogoOffline>();
  for (const [suc, datos] of Object.entries(copias)) {
    guardadas.set(suc, { id: `verificador-precios:${suc}`, tipo: 'verificador-precios', datos, version: datos.generado, ultima_sincronizacion: hoy() });
  }
  const db = {
    getCopiaPrecios: vi.fn(async (s: string) => guardadas.get(s)),
    guardarCopiaPrecios: vi.fn(async (s: string, datos: VerificadorSnapshot) => {
      guardadas.set(s, { id: `verificador-precios:${s}`, tipo: 'verificador-precios', datos, version: datos.generado, ultima_sincronizacion: hoy() });
    }),
    ultimaCopiaPrecios: vi.fn(async () => [...guardadas.values()][0]),
  };
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: OfflineDatabaseService, useValue: db }],
  });
  return { svc: TestBed.inject(ChecadorPreciosService), http: TestBed.inject(HttpTestingController), db };
}

/** Deja correr las promesas pendientes (Dexie de mentira + firstValueFrom). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('ChecadorPreciosService · consultar (en línea primero, copia después)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('en línea: el precio de Kepler de la sucursal, con la sucursal en la consulta', async () => {
    const { svc, http } = montar();
    const p = svc.consultar('840004096513', '02');
    const req = http.expectOne((r) => r.url.endsWith('/kp/precio'));
    expect(req.request.params.get('q')).toBe('840004096513');
    expect(req.request.params.get('sucursal')).toBe('02');
    req.flush({ ok: true, codigo: '00052', nombre: 'DULCE PRUEBA /12', unidades: [{ u: 'PZA', precio_con_iva: 8.78, precio_sin_iva: 8.13, factor: 1 }], unidad_escaneada: null });
    const r = await p;
    expect(r.estado).toBe('encontrado');
    if (r.estado === 'encontrado') expect(r.origen).toBe('en_linea');
  });

  it('⭐ sin señal (504 sin cuerpo del service worker) y con copia: precio DE LA COPIA, con su fecha y el motivo', async () => {
    const generado = '2026-11-09T14:12:00.000Z';
    const { svc, http } = montar({ '02': COPIA(generado) });
    const p = svc.consultar('840004096513', '02');
    http.expectOne((r) => r.url.endsWith('/kp/precio')).flush(null, { status: 504, statusText: 'Gateway Timeout' });
    const r = await p;
    expect(r).toMatchObject({ estado: 'encontrado', origen: 'copia', al: generado, motivo: 'sin_senal' });
    if (r.estado === 'encontrado') {
      expect(r.ficha.clave).toBe('00052');
      expect(r.ficha.unidadLeida).toBe('PAQ');
    }
  });

  it('⛔ [negativa] sin señal y SIN copia: «no se puede», nunca un precio inventado', async () => {
    const { svc, http } = montar();
    const p = svc.consultar('840004096513', '02');
    http.expectOne((r) => r.url.endsWith('/kp/precio')).error(new ProgressEvent('error'), { status: 0 });
    const r = await p;
    expect(r).toEqual({ estado: 'sin_datos', codigo: '840004096513', motivo: 'sin_senal' });
  });

  it('⛔ [negativa] un «no encontrado» del servidor es la respuesta: NO se re-pregunta a la copia', async () => {
    const { svc, http, db } = montar({ '02': COPIA() });
    const p = svc.consultar('840004096513', '02');
    http.expectOne((r) => r.url.endsWith('/kp/precio')).flush({ ok: false, error: 'Producto no encontrado' });
    const r = await p;
    expect(r).toMatchObject({ estado: 'no_encontrado', origen: 'en_linea' });
    expect(db.getCopiaPrecios).not.toHaveBeenCalled();
  });

  it('código que la copia no tiene: «no está en tu copia», con la fecha de la copia (no «no existe»)', async () => {
    const generado = '2026-11-09T14:12:00.000Z';
    const { svc, http } = montar({ '02': COPIA(generado) });
    const p = svc.consultar('9999999999999', '02');
    http.expectOne((r) => r.url.endsWith('/kp/precio')).flush({ message: 'x' }, { status: 500, statusText: 'Error' });
    expect(await p).toEqual({ estado: 'no_encontrado', origen: 'copia', codigo: '9999999999999', al: generado, motivo: 'servidor' });
  });
});

describe('ChecadorPreciosService · la copia del teléfono', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('copia de hoy: NO se vuelve a bajar', async () => {
    const { svc, http } = montar({ '02': COPIA() });
    const r = await svc.asegurarCopia('02', true);
    http.expectNone((q) => q.url.endsWith('/kp/precios-todos'));
    expect(r.copia?.total).toBe(2);
    expect(r.fallo).toBeNull();
  });

  it('⭐ copia de otro día: con señal se vuelve a bajar y se guarda con su fecha', async () => {
    const { svc, http, db } = montar({ '02': COPIA('2026-11-01T14:00:00.000Z') });
    const p = svc.asegurarCopia('02', true);
    await tick();
    const req = http.expectOne((q) => q.url.endsWith('/kp/precios-todos'));
    expect(req.request.params.get('sucursal')).toBe('02');
    const nueva = COPIA();
    req.flush(nueva);
    const r = await p;
    expect(db.guardarCopiaPrecios).toHaveBeenCalledWith('02', nueva, nueva.generado);
    expect(r.copia?.generado).toBe(nueva.generado);
    expect(svc.bajandoCopia()).toBe(false);
  });

  it('⛔ [negativa] sin señal no se intenta bajar: sirve la vieja, tal como es', async () => {
    const vieja = '2026-11-01T14:00:00.000Z';
    const { svc, http } = montar({ '02': COPIA(vieja) });
    const r = await svc.asegurarCopia('02', false);
    http.expectNone((q) => q.url.endsWith('/kp/precios-todos'));
    expect(r.copia?.generado).toBe(vieja);
  });

  it('si la bajada falla, se DICE (fallo) y la copia que había sigue sirviendo', async () => {
    const vieja = '2026-11-01T14:00:00.000Z';
    const { svc, http } = montar({ '02': COPIA(vieja) });
    const p = svc.asegurarCopia('02', true);
    await tick();
    http.expectOne((q) => q.url.endsWith('/kp/precios-todos')).flush({ message: 'x' }, { status: 500, statusText: 'Error' });
    const r = await p;
    expect(r.fallo).toBeTruthy();
    expect(r.copia?.generado).toBe(vieja);
  });

  it('⛔ [negativa] la copia en memoria de OTRA sucursal no se pinta como de ésta', async () => {
    const { svc } = montar({ '02': COPIA() });
    await svc.asegurarCopia('02', false);
    expect(svc.copia()?.sucursal).toBe('02');
    await svc.asegurarCopia('05', false);
    expect(svc.copia()).toBeNull();
  });

  it('buscar por nombre en la copia; sin copia devuelve null («no puedo buscar» ≠ «no hay»)', async () => {
    const { svc } = montar({ '02': COPIA() });
    expect((await svc.buscarEnCopia('02', 'tamarindo'))?.map((x) => x.b.codigo)).toEqual(['14055']);
    expect(await svc.buscarEnCopia('02', 'nada parecido')).toEqual([]);
    expect(await svc.buscarEnCopia('05', 'tamarindo')).toBeNull();
  });
});

describe('ChecadorPreciosService · claveDeCodigo para Tomar pedido [VTK.18]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('con copia: la clave sale del teléfono, sin pedir nada a la red', async () => {
    const { svc, http } = montar({ '02': COPIA() });
    expect(await svc.claveDeCodigo('7501056320011', '02')).toEqual({ estado: 'hallado', clave: '14055', nombre: 'TAMARINDO PRUEBA 20P', ambiguo: false });
    http.verify();
  });

  it('sin copia: pregunta en línea', async () => {
    const { svc, http } = montar();
    const p = svc.claveDeCodigo('7509999999999', '02');
    await tick();
    http.expectOne((r) => r.url.endsWith('/kp/precio')).flush({ ok: true, codigo: '33259', nombre: 'OTRO PRUEBA', codigo_ambiguo: false });
    expect(await p).toEqual({ estado: 'hallado', clave: '33259', nombre: 'OTRO PRUEBA', ambiguo: false });
  });

  it('⛔ [negativa] «no está» (lo contestó Kepler) y «no se pudo» (sin señal) son respuestas distintas', async () => {
    const { svc, http } = montar();
    const p1 = svc.claveDeCodigo('7500000000000', '02');
    await tick();
    http.expectOne((r) => r.url.endsWith('/kp/precio')).flush({ ok: false, error: 'Producto no encontrado' });
    expect(await p1).toEqual({ estado: 'no_esta' });
    const p2 = svc.claveDeCodigo('7500000000000', '02');
    await tick();
    http.expectOne((r) => r.url.endsWith('/kp/precio')).error(new ProgressEvent('error'), { status: 0 });
    expect(await p2).toEqual({ estado: 'no_se_pudo' });
  });

  it('⛔ [negativa] NO baja la copia (Tomar pedido no gasta datos en eso)', async () => {
    const { svc, http } = montar();
    const p = svc.claveDeCodigo('7509999999999', '02');
    await tick();
    http.expectNone((r) => r.url.endsWith('/kp/precios-todos'));
    http.expectOne((r) => r.url.endsWith('/kp/precio')).flush({ ok: false, error: 'x' });
    await p;
  });
});
