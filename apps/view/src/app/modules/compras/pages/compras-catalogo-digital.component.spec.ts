import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import type { CoberturaLevantamiento, FichaPublicada, FichasPublicadas, RevisionBandeja, RevisionFicha } from '@megadulces/contracts';
import {
  anexarPublicadas, ComprasCatalogoDigitalComponent, kpisCobertura, lineaIa, pctVentaTexto, respuestaCobertura,
} from './compras-catalogo-digital.component';

/**
 * `[NP.7.L.5]` Catálogo digital › Publicadas.
 *
 * Lo que cuida: (1) cambiar de sección PIDE `/publicadas` (y Por revisar sigue pidiendo `/revision`);
 * (2) la medición se pinta como la da la API —0.888 % se ve «0.89 %», nunca «1 %» ni «0.9 %», y un % que no
 * se pudo medir no se dibuja como 0 %—; (3) con la IA apagada sale la línea «Sólo fotos…», y con otra lectura
 * NO (control negativo); (4) es de sólo lectura: la P no publica nada desde aquí.
 *
 * Los números son la medición de control del 2026-11-04 en Padre Hidalgo (sólo lectura, prod): universo 4,230 ·
 * publicadas 7 · faltan 4,223 · 0.888 % de la venta de 90 días. Montar el componente compila su plantilla:
 * `tsc` no mira adentro de una plantilla de Angular.
 */

const COBERTURA: CoberturaLevantamiento = {
  branch_code: '01', branch_name: 'Padre Hidalgo', universe: 4230, published: 7, missing: 4223,
  sales_share_pct: 0.888, measured_at: '2026-11-04T16:00:00.000Z',
};

const FICHA = (sku: string, p: Partial<FichaPublicada> = {}): FichaPublicada => ({
  id: 'f-' + sku, sku, name: 'Producto ' + sku, branch_code: '01', branch_name: 'Padre Hidalgo', rung: 'base',
  unit_label: 'PAQ', unit_factor: 20, scanned_code: '7501000000001', kepler_codes: ['7501000000001', 'C123'],
  captured_by: 'Ana López', captured_at: '2026-11-04T15:00:00.000Z',
  published_by: 'Francisco López', published_at: '2026-11-04T16:00:00.000Z',
  photos: [
    { face: 'frente', url: 'https://fotos.example/frente.jpg?firma=1', skipped_reason: null, sharpness: 100 },
    { face: 'reverso', url: null, skipped_reason: 'no_tiene_esa_cara', sharpness: null },
  ],
  ai_reading: 'apagada',
  ...p,
});

/** Los 7 SKUs publicados medidos el 2026-11-04, en el orden en que los da el servidor (el más reciente primero). */
const SKUS = ['97390', '97245', '96509', '65038', '65031', '65001', '63004'];
const PUBLICADAS = (p: Partial<FichasPublicadas> = {}): FichasPublicadas => ({
  coverage: COBERTURA, total: SKUS.length, rows: SKUS.map((s) => FICHA(s)), ...p,
});

const FICHA_REVISION: RevisionFicha = {
  id: 'r-1', sku: '11111', name: 'Por revisar 1', branch_code: '01', branch_name: 'Padre Hidalgo', rung: 'base',
  unit_label: 'PZA', unit_factor: 1, scanned_code: '7501000000002', kepler_codes: ['7501000000002'], status: 'en_revision',
  reasons: ['sin_analizar'], captured_by: 'Ana López', captured_at: '2026-11-04T15:00:00.000Z',
  photos: [{ face: 'frente', url: 'https://fotos.example/r1.jpg?firma=1', skipped_reason: null, sharpness: 100 }],
};
const BANDEJA = (rows: RevisionFicha[] = []): RevisionBandeja => ({
  counts: { sin_analizar: rows.length, caras_saltadas: 0, entro_por_busqueda: 0, foto_repetida: 0 },
  total: rows.length, total_all: rows.length, rows,
});

const esRevision = (r: { url: string }) => r.url.endsWith('/catalog/fichas/revision');
const esPublicadas = (r: { url: string }) => r.url.endsWith('/catalog/fichas/publicadas');
const esDecision = (r: { url: string; method: string }) => r.method === 'POST' && /\/catalog\/fichas\/[^/]+\/decision$/.test(r.url);

describe('pctVentaTexto — el % como lo dio la API, sin redondear a entero', () => {
  it('0.888 se escribe 0.89 %, nunca 1 % ni 0.9 %', () => {
    expect(pctVentaTexto(0.888)).toBe('0.89 %');
    expect(pctVentaTexto(0.888)).not.toBe('1 %');
    expect(pctVentaTexto(0.888)).not.toBe('0.9 %');
  });
  it('un numeric de Postgres llega como texto y se lee igual', () => {
    expect(pctVentaTexto('0.888')).toBe('0.89 %');
  });
  it('los extremos que un redondeo vuelve falsos se dicen con palabras', () => {
    expect(pctVentaTexto(0.001)).toBe('menos de 0.01 %');
    expect(pctVentaTexto(99.96)).toBe('más de 99.9 %');
    expect(pctVentaTexto(100)).toBe('100.0 %');
    expect(pctVentaTexto(48.25)).toBe('48.3 %');
  });
  it('cero medido es 0 %; no medible es null (no se dibuja como cero)', () => {
    expect(pctVentaTexto(0)).toBe('0 %');
    expect(pctVentaTexto(null)).toBeNull();
    expect(pctVentaTexto(undefined)).toBeNull();
    expect(pctVentaTexto('')).toBeNull();
    expect(pctVentaTexto('no')).toBeNull();
  });
});

describe('kpisCobertura / respuestaCobertura — la tira dice la sucursal por nombre y los números de la API', () => {
  it('la respuesta, en una oración, con el control del 2026-11-04: PRIMERO el % de la venta (plan §10b.2, pregunta 1) y la meta sin fijar', () => {
    expect(respuestaCobertura(COBERTURA)).toBe(
      'Padre Hidalgo: 0.89 % de su venta de 90 días tiene ficha publicada · 7 de 4,230 productos · faltan 4,223 · meta: sin fijar');
  });
  it('«faltan» es el de la API, no se recalcula; el primer renglón es el % de la venta, no el conteo de SKUs', () => {
    const k = kpisCobertura({ ...COBERTURA, missing: 4223 });
    expect(k.map((x) => x.value)).toEqual(['0.89 %', '7 de 4,230', 4223]);
    expect(k[0].label).toBe('Padre Hidalgo · venta con ficha publicada');
  });
  it('la meta se dice como texto «sin fijar», nunca como un número', () => {
    const k = kpisCobertura(COBERTURA);
    expect(k[0].sub).toContain('meta: sin fijar');
    expect(k.some((x) => /meta/i.test(x.label))).toBe(false);
  });
  it('«Faltan» declara que su lista todavía no se abre desde aquí (deuda con nombre, Q.4): no aparenta ser recorrible', () => {
    const f = kpisCobertura(COBERTURA)[2];
    expect(f.label).toBe('Faltan');
    expect(f.drill).toBeUndefined();
    expect(f.sub).toContain('la lista de cuáles aún no está en esta pantalla');
  });
  it('sin nombre del servidor usa el resolvedor común: nunca «01»', () => {
    expect(kpisCobertura({ ...COBERTURA, branch_name: null })[0].label).not.toMatch(/^01\b/);
  });
  it('un % no medible se declara no_medido, no 0 %, y la RAZÓN se lee en pantalla (no sólo en el title del chip)', () => {
    const k = kpisCobertura({ ...COBERTURA, sales_share_pct: null });
    expect(k[0].value).toBe('no medible');
    expect(k[0].state).toBe('no_medido');
    expect(k[0].sub).toContain('la venta de 90 días de la sucursal está en cero o no se pudo leer');
    expect(k[0].sub).not.toContain('no se dibuja');
    expect(respuestaCobertura({ ...COBERTURA, sales_share_pct: null })).not.toContain('0 %');
  });
});

describe('anexarPublicadas — «Ver más» sobre una lista que va de la más reciente a la más vieja', () => {
  it('CONTROL: sin cambios entre páginas, junta las filas y no avisa', () => {
    const r = anexarPublicadas(PUBLICADAS({ total: 9 }), PUBLICADAS({ total: 9, rows: [FICHA('10001'), FICHA('10002')] }));
    expect(r.datos.rows).toHaveLength(9);
    expect(r.cambio).toBe(false);
  });
  it('⭐ alguien publicó entre dos clics: la página siguiente repite la última fila → se quita la repetida y se avisa', () => {
    const d = PUBLICADAS({ total: 8 });
    const r = anexarPublicadas(d, PUBLICADAS({ total: 9, rows: [FICHA('63004'), FICHA('10001')] }));
    expect(r.datos.rows.map((x) => x.id)).toEqual([...d.rows.map((x) => x.id), 'f-10001']);
    expect(new Set(r.datos.rows.map((x) => x.id)).size).toBe(r.datos.rows.length);
    expect(r.cambio).toBe(true);
  });
  it('se reemplazó una entre dos clics (el total bajó): se avisa aunque no haya repetidas', () => {
    expect(anexarPublicadas(PUBLICADAS({ total: 9 }), PUBLICADAS({ total: 8, rows: [FICHA('10001')] })).cambio).toBe(true);
  });
});

describe('lineaIa', () => {
  it('apagada → la línea de sólo fotos; las otras NO la dicen', () => {
    expect(lineaIa('apagada')).toBe('Sólo fotos: la lectura de la IA está apagada');
    expect(lineaIa('sin_leer')).not.toContain('está apagada');
    expect(lineaIa('leida')).not.toContain('Sólo fotos');
  });
});

describe('ComprasCatalogoDigitalComponent — sección Publicadas', () => {
  let fix: ComponentFixture<ComprasCatalogoDigitalComponent>;
  let http: HttpTestingController;

  const texto = () => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';
  const asentar = async () => { await fix.whenStable(); fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };
  const botonSeccion = (nombre: string) =>
    Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('app-segmented button'))
      .find((b) => (b.textContent ?? '').includes(nombre))!;
  const montar = async () => {
    fix = TestBed.createComponent(ComprasCatalogoDigitalComponent);
    http = TestBed.inject(HttpTestingController);
    fix.detectChanges();
  };
  const aPublicadas = async (resp: FichasPublicadas = PUBLICADAS()) => {
    botonSeccion('Publicadas').click();
    fix.detectChanges();
    const req: TestRequest = http.expectOne(esPublicadas);
    req.flush(resp);
    await asentar();
    return req;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoDigitalComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => http.verify());

  it('entra en Por revisar (pide /revision) y al cambiar de sección pide /publicadas, sin búsqueda, desde 0', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    expect(texto()).toContain('Catálogo digital · Por revisar');
    http.expectNone(esPublicadas);

    const req = await aPublicadas();
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('offset')).toBe('0');
    expect(req.request.params.get('limit')).toBe('30');
    expect(req.request.params.has('q')).toBe(false);
    expect(texto()).toContain('Catálogo digital · Publicadas');
    expect(TestBed.inject(Router).url).toContain('seccion=publicadas');

    // Volver a Por revisar vuelve a pedir la bandeja (lo recién publicado ya no está ahí).
    botonSeccion('Por revisar').click();
    fix.detectChanges();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    expect(texto()).toContain('Catálogo digital · Por revisar');
  });

  it('⭐ una foto guardada que el servidor no pudo firmar NO se dibuja como «Saltada» (veracidad)', async () => {
    // Sin almacenamiento configurado, `signedUrl` devuelve '' (object-storage.service.ts): la foto existe.
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas(PUBLICADAS({
      total: 1,
      rows: [FICHA('65038', { photos: [
        { face: 'frente', url: '', skipped_reason: null, sharpness: 120 },
        { face: 'reverso', url: null, skipped_reason: 'no_tiene_esa_cara', sharpness: null },
      ] })],
    }));
    expect(texto()).toContain('Guardada, no se puede mostrar aquí');
    // Control: el salto de verdad sí se sigue diciendo, y sólo uno.
    expect(texto().match(/Saltada:/g)?.length ?? 0).toBe(1);
  });

  it('pinta la medición como la da la API: 0.89 %, nunca 1 %, y la sucursal por nombre', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas();

    const t = texto();
    expect(t).toContain('Padre Hidalgo · venta con ficha publicada');
    expect(t).toContain('7 de 4,230');
    expect(t).toContain('0.89 %');
    expect(t).not.toMatch(/(^|[^.\d])1 %/);
    expect(t).toContain('4,223');
    expect(t).toContain('meta: sin fijar');
    const tira = (fix.nativeElement as HTMLElement).querySelector('app-metric-strip [role="group"]');
    expect(tira?.getAttribute('aria-label')).toBe(
      'Padre Hidalgo: 0.89 % de su venta de 90 días tiene ficha publicada · 7 de 4,230 productos · faltan 4,223 · meta: sin fijar');
    // La lista se recorre completa y lo dice; la red es otro universo y también lo dice.
    expect(t).toContain('Se muestran 7 de 7 en toda la red');
    // La primera de la lista es la primera que dio el servidor (la más reciente).
    expect((fix.nativeElement as HTMLElement).querySelector('.cd-fila.on .cd-fila-n')?.textContent).toContain('97390');
  });

  it('con la IA apagada sale la línea de sólo fotos, la de a dónde no llega todavía (en palabras, sin «D19»), y ningún botón de decisión', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas();

    const t = texto();
    expect(t).toContain('Sólo fotos: la lectura de la IA está apagada');
    expect(t).toContain('Todavía no llega al portal ni al verificador: falta decidir si esta foto reemplaza la imagen que ya tienen');
    expect(t).not.toContain('D19');
    expect(t).toContain('Francisco López');
    const botones = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(botones.some((b) => /Publicar|Descartar|Pedir otra foto/.test(b))).toBe(false);
  });

  it('control: con la IA leída NO dice «está apagada»', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas(PUBLICADAS({ rows: [FICHA('97390', { ai_reading: 'leida' })], total: 1 }));
    expect(texto()).not.toContain('la lectura de la IA está apagada');
  });

  it('es de sólo lectura: la P no publica la ficha de Por revisar que quedó atrás', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA([FICHA_REVISION]));
    await asentar();
    await aPublicadas();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    fix.detectChanges();
    http.expectNone(esDecision);
  });

  it('control de la prueba anterior: en Por revisar la P SÍ publica (si no, la anterior no probaría nada)', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA([FICHA_REVISION]));
    await asentar();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    fix.detectChanges();
    http.expectOne(esDecision).flush({ id: 'r-1', status: 'publicada' });
    await asentar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
  });

  it('con una foto ampliada, la P tampoco publica (la ventana tapa la ficha de atrás)', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA([FICHA_REVISION]));
    await asentar();
    const foto = (fix.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.cd-foto');
    expect(foto).toBeTruthy();
    foto!.click();
    fix.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    fix.detectChanges();
    http.expectNone(esDecision);
  });

  it('«Ver más» pide la página siguiente de la misma búsqueda', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas(PUBLICADAS({ total: 40 }));
    expect(texto()).toContain('Se muestran 7 de 40 en toda la red');

    const mas = Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.cd-link'))
      .find((b) => b.textContent?.includes('Ver más'))!;
    mas.click();
    const req = http.expectOne(esPublicadas);
    expect(req.request.params.get('offset')).toBe('7');
    req.flush(PUBLICADAS({ total: 40, rows: [FICHA('10001')] }));
    await asentar();
    expect(texto()).toContain('Se muestran 8 de 40 en toda la red');
    expect(texto()).not.toContain('mientras recorrías la lista'); // CONTROL de la siguiente
  });

  it('«Ver más» cuando alguien publicó entre dos clics: sin filas repetidas, no afirma «N de N» y ofrece volver a cargar', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas(PUBLICADAS({ total: 40 }));

    const verMas = Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.cd-link'))
      .find((b) => b.textContent?.includes('Ver más'))!;
    verMas.click();
    // La nueva entró ARRIBA: la página siguiente empieza con la última de la anterior (63004).
    http.expectOne(esPublicadas).flush(PUBLICADAS({ total: 41, rows: [FICHA('63004'), FICHA('10001')] }));
    await asentar();

    const filas = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('.cd-fila-n')).map((e) => e.textContent?.trim());
    expect(filas).toHaveLength(8);
    expect(filas.filter((n) => n === 'Producto 63004')).toHaveLength(1);
    const t = texto();
    expect(t).toContain('Se publicaron o reemplazaron fichas mientras recorrías la lista');
    expect(t).not.toMatch(/Se muestran \d+ de \d+/);

    const recargar = Array.from((fix.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.cd-link'))
      .find((b) => b.textContent?.includes('Volver a cargar'))!;
    expect(recargar).toBeTruthy();
    recargar.click();
    const req = http.expectOne(esPublicadas);
    expect(req.request.params.get('offset')).toBe('0');
    req.flush(PUBLICADAS({ total: 8, rows: [FICHA('99999'), ...SKUS.map((s) => FICHA(s))] }));
    await asentar();
    expect(texto()).toContain('Se muestran 8 de 8 en toda la red');
    expect(texto()).not.toContain('mientras recorrías la lista');
  });

  it('la búsqueda no afirma un resultado que todavía no llega: el vacío habla de lo que se buscó, y mientras viaja dice «Buscando…»', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas();

    const input = (fix.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.cd-busca input')!;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    fix.detectChanges();
    // Mientras viaja: la lista de antes sigue, pero se dice que se está buscando.
    expect(texto()).toContain('Buscando «zzz»…');
    await new Promise((r) => setTimeout(r, 300));
    http.expectOne(esPublicadas).flush(PUBLICADAS({ total: 0, rows: [] }));
    await asentar();
    expect(texto()).toContain('Ninguna ficha publicada coincide con «zzz»');
    expect(texto()).not.toContain('Buscando');

    // Se borra la caja: hasta que llegue la respuesta, el vacío sigue hablando de «zzz» (lo que se ve), no afirma
    // «Todavía no hay fichas publicadas» (que sería falso: hay 7).
    input.value = '';
    input.dispatchEvent(new Event('input'));
    fix.detectChanges();
    expect(texto()).not.toContain('Todavía no hay fichas publicadas');
    expect(texto()).toContain('Ninguna ficha publicada coincide con «zzz»');
    expect(texto()).toContain('Volviendo a la lista completa…');
    await new Promise((r) => setTimeout(r, 300));
    http.expectOne(esPublicadas).flush(PUBLICADAS());
    await asentar();
    expect(texto()).toContain('Se muestran 7 de 7 en toda la red');
    expect(texto()).not.toContain('Volviendo a la lista completa');
  });

  it('al publicar en Por revisar, el conteo de «Publicadas» deja de mostrar el número viejo (no se suma a mano: otro pudo publicar)', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA([FICHA_REVISION]));
    await asentar();
    await aPublicadas();
    expect(botonSeccion('Publicadas').textContent).toContain('7'); // CONTROL: el conteo sí se mostraba

    botonSeccion('Por revisar').click();
    fix.detectChanges();
    http.expectOne(esRevision).flush(BANDEJA([FICHA_REVISION]));
    await asentar();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    fix.detectChanges();
    http.expectOne(esDecision).flush({ id: 'r-1', status: 'publicada' });
    await asentar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    expect(botonSeccion('Publicadas').textContent?.trim()).toBe('Publicadas');
  });

  it('la búsqueda espera 250 ms y manda UNA consulta con lo último tecleado', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas();

    const input = (fix.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.cd-busca input')!;
    input.value = 'cho';
    input.dispatchEvent(new Event('input'));
    input.value = 'choco';
    input.dispatchEvent(new Event('input'));
    http.expectNone(esPublicadas);

    await new Promise((r) => setTimeout(r, 300));
    const req = http.expectOne(esPublicadas);
    expect(req.request.params.get('q')).toBe('choco');
    req.flush(PUBLICADAS({ total: 0, rows: [] }));
    await asentar();
    expect(texto()).toContain('Ninguna ficha publicada coincide con «choco»');
  });

  it('vacío de verdad: «Todavía no hay fichas publicadas» (distinto de error)', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    await aPublicadas(PUBLICADAS({ total: 0, rows: [] }));
    expect(texto()).toContain('Todavía no hay fichas publicadas');
  });

  it('error: lo dice y ofrece reintentar (no es un vacío)', async () => {
    await montar();
    http.expectOne(esRevision).flush(BANDEJA());
    await asentar();
    botonSeccion('Publicadas').click();
    fix.detectChanges();
    http.expectOne(esPublicadas).flush({ message: 'falló' }, { status: 500, statusText: 'Error' });
    await asentar();
    const t = texto();
    expect(t).toContain('falló');
    expect(t).toContain('Reintentar');
    expect(t).not.toContain('Todavía no hay fichas publicadas');
  });
});
