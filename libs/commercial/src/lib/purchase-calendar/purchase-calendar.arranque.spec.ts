import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission } from '@megadulces/platform-core';
import { PurchaseCalendarController } from './purchase-calendar.controller';
import { PurchaseCalendarModule } from './purchase-calendar.module';
import { PurchaseCalendarService, traducir } from './purchase-calendar.service';
import { CalendarioError } from './purchase-calendar.repo';

/**
 * `[PQ.3.4]` Que compile no es que arranque (`#414`): vitest no emite `design:paramtypes`, así que el
 * grafo se lee de los decoradores, y cada ruta se verifica por su metadata (método, camino y permiso).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
const clavesDe = (h: object): unknown[] => Reflect.getMetadataKeys(h).flatMap((k) => [Reflect.getMetadata(k, h)].flat());

describe('[PQ.3.4] el módulo del Calendario de compras arranca', () => {
  it('servicio con 3 dependencias (TenantKnex, TenantContext y, desde PQ.3.6, Scope) y controlador con 1', () => {
    expect(PurchaseCalendarService.length).toBe(3);
    expect(PurchaseCalendarController.length).toBe(1);
  });

  it('controlador y servicio registrados en su módulo', () => {
    expect(meta('controllers', PurchaseCalendarModule)).toContain(PurchaseCalendarController);
    expect(meta('providers', PurchaseCalendarModule)).toContain(PurchaseCalendarService);
  });

  const P = PurchaseCalendarController.prototype;
  const rutas: [string, (...a: never[]) => unknown, RequestMethod, string, Permission[], Permission[]][] = [
    ['calendario', P.calendario, RequestMethod.GET, '/', [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR, Permission.COMPRAS_CALENDARIO_CICLO], []],
    // [PQ.3.24] El aviso vive en Pedido: también lo lee quien sólo tiene COMPRAS_PEDIDO_VER (son conteos, con alcance).
    ['aviso', P.aviso, RequestMethod.GET, 'aviso', [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR, Permission.COMPRAS_CALENDARIO_CICLO, Permission.COMPRAS_PEDIDO_VER], [Permission.COMPRAS_PROVEEDORES_VER]],
    // [PQ.3.6] «Sin regla» es de toda la empresa: sólo quien define ciclos (la pantalla y la API dicen lo mismo).
    ['propuestas', P.propuestas, RequestMethod.GET, 'propuestas', [Permission.COMPRAS_CALENDARIO_CICLO], [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR]],
    ['guardarRegla', P.guardarRegla, RequestMethod.POST, 'reglas', [Permission.COMPRAS_CALENDARIO_CICLO], [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR]],
    // `[PQ.3.22]` Quién puede ser responsable: sólo quien define reglas (lista personas y dónde escriben).
    ['responsables', P.responsables, RequestMethod.GET, 'responsables', [Permission.COMPRAS_CALENDARIO_CICLO], [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR]],
    // [PQ.3.18] (c) Los ocasionales en bloque: escribe reglas corporativas, sólo quien define ciclos.
    ['definirOcasionales', P.definirOcasionales, RequestMethod.POST, 'reglas/ocasionales', [Permission.COMPRAS_CALENDARIO_CICLO], [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR]],
    ['darDeBaja', P.darDeBaja, RequestMethod.POST, 'reglas/:id/baja', [Permission.COMPRAS_CALENDARIO_CICLO], [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR]],
    ['fueraDeCiclo', P.fueraDeCiclo, RequestMethod.POST, 'reglas/:id/fuera-de-ciclo', [Permission.COMPRAS_CALENDARIO_CICLO], [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR]],
    ['marcar', P.marcar, RequestMethod.POST, 'reglas/:id/marcas', [Permission.COMPRAS_CALENDARIO_GESTIONAR], [Permission.COMPRAS_CALENDARIO_VER]],
  ];

  it('todo cuelga de compras/calendario', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PurchaseCalendarController)).toBe('compras/calendario');
  });

  for (const [nombre, h, metodo, camino, exige, noBasta] of rutas) {
    it(`${nombre}: ${RequestMethod[metodo]} ${camino}, con ${exige.join(' | ')}${noBasta.length ? ` y NO con ${noBasta.join(', ')}` : ''}`, () => {
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(metodo);
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe(camino);
      const v = clavesDe(h);
      for (const p of exige) expect(v).toContain(p);
      for (const p of noBasta) expect(v).not.toContain(p);
    });
  }

  it('PRUEBA NEGATIVA: un método sin decorador de permiso no lleva ninguna clave del calendario', () => {
    class Desnudo { calendario(): void { /* nada */ } }
    const v = clavesDe(Desnudo.prototype.calendario);
    expect(v).not.toContain(Permission.COMPRAS_CALENDARIO_VER);
  });
});

describe('[PQ.3.4] los errores del dominio llegan a la pantalla con su código y su mensaje', () => {
  it('no encontrada → 404 · conflicto → 409 · inválida → 400 · fuera de alcance → 403; lo demás pasa tal cual', () => {
    const status = (e: unknown) => { try { traducir(e); } catch (x) { return (x as { getStatus?: () => number }).getStatus?.() ?? 'crudo'; } return 'nada'; };
    expect(status(new CalendarioError('no_encontrada', 'x'))).toBe(404);
    expect(status(new CalendarioError('conflicto', 'x'))).toBe(409);
    expect(status(new CalendarioError('invalida', 'x'))).toBe(400);
    expect(status(new CalendarioError('fuera_de_alcance', 'x'))).toBe(403);
    expect(status(new Error('base caída'))).toBe('crudo');
  });

  it('el servicio no toca la base si no hay tenant (falla antes)', async () => {
    const run = vi.fn();
    const s = new PurchaseCalendarService({ run } as never, { requireTenantId: () => { throw new Error('sin tenant'); } } as never, {} as never);
    await expect(async () => s.calendario()).rejects.toThrow('sin tenant');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('[PQ.3.6] el alcance de la persona llega al repositorio (área compras)', () => {
  /** Un ScopeService falso con el alcance de lectura y de escritura ya resuelto. */
  const scopeDe = (lee: string[] | null, escribe: string[] | null) => {
    const current = vi.fn(async () => ({}));
    return { current, intersect: () => lee, intersectWrite: () => escribe };
  };
  const ctx = { requireTenantId: () => 't1' };

  it('el calendario se lee con las sucursales que la persona VE, preguntadas en el área compras', async () => {
    const sc = scopeDe(['05'], []);
    let leido: unknown = 'sin llamar';
    const run = vi.fn(async (fn: (trx: unknown) => unknown) => { leido = 'llamado'; return fn({ raw: () => { throw new Error('alto'); } }); });
    const s = new PurchaseCalendarService({ run } as never, ctx as never, sc as never);
    await expect(s.calendario()).rejects.toThrow('alto');
    expect(sc.current).toHaveBeenCalledWith('compras');
    expect(leido).toBe('llamado');
  });

  it('una escritura lleva el alcance de ESCRITURA (no el de lectura) dentro de quien escribe', async () => {
    const sc = scopeDe(null, ['04']);
    const run = vi.fn(async () => 'ok');
    const s = new PurchaseCalendarService({ run } as never, ctx as never, sc as never);
    // El repositorio real lo recibe por el cierre; aquí se espía lo que `conAlcance` arma.
    const quien = await (s as unknown as { conAlcance: (x: object) => Promise<unknown> }).conAlcance({ userId: 'u1', username: 'x' });
    expect(quien).toEqual({ userId: 'u1', username: 'x', escribe: ['04'] });
  });

  it('PRUEBA NEGATIVA: sin alcance resuelto (`null` = todas) no se inventa uno recortado, y `[]` no se vuelve «todas»', async () => {
    const todas = new PurchaseCalendarService({ run: vi.fn() } as never, ctx as never, scopeDe(null, null) as never);
    const nada = new PurchaseCalendarService({ run: vi.fn() } as never, ctx as never, scopeDe([], []) as never);
    const c = (x: PurchaseCalendarService) => (x as unknown as { conAlcance: (q: object) => Promise<{ escribe: unknown }> }).conAlcance({ userId: 'u', username: null });
    expect((await c(todas)).escribe).toBeNull();
    expect((await c(nada)).escribe).toEqual([]);
  });
});
