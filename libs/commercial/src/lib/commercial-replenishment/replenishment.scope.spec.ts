import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[ZN.3.3]` — En Compras el alcance decide SOBRE QUÉ SUCURSAL, no sólo si la pantalla abre.
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────────
 * Los 8 reportes de `/compras/pedido` (existencia crítica, sugerido, traspasos, sobrestock,
 * workbook, worklist, stock muerto, KPIs) filtraban por almacén con este patrón:
 *
 *     const whIds = this.whIds(q);          // sólo parseaba el query param
 *     if (whIds.length) b.whereIn('rp.warehouse_id', whIds);
 *
 * O sea: **quien no mandaba el parámetro veía la red completa**, sin importar su alcance. El
 * permiso que abre la pantalla (`COMPRAS_PEDIDO_VER`) lo tienen encargadas de tienda con alcance
 * acotado, así que la encargada de una sucursal leía el inventario y el sugerido de las nueve.
 *
 * ── Qué vigila este spec, y qué NO ───────────────────────────────────────────────────────────
 * Vigila **la decisión de recortar**, que es TypeScript puro y ocurre antes de la consulta. La
 * pieza fina es que hay TRES estados y el del medio es el que se pierde siempre:
 *
 *     null  → no filtrar (alcance `all` y nadie pidió nada)
 *     [...] → esas sucursales
 *     []    → NINGUNA, y tiene que llegar al WHERE
 *
 * El patrón viejo colapsaba `[]` contra `null`: un alcance resuelto a cero almacenes se leía como
 * "todas". Por eso la aserción central de acá no es que filtre con una lista —eso es lo fácil—
 * sino que **filtre con la lista vacía**.
 *
 * ⚠️ **NO valida SQL.** El doble de knex registra la llamada; no la ejecuta, así que no puede
 * rechazar SQL inválido (`docs/GOTCHAS.md` §67, aprendido caro en `[ID.37]`). Lo que prueba que
 * la consulta corre es el smoke HTTP del módulo, que queda **declarado NO MEDIDO** en esta
 * entrega por no haber API viva.
 */

/** Registra las llamadas del builder en vez de construir SQL. Encadenable como knex. */
const builderDoble = () => {
  const llamadas: { metodo: string; args: unknown[] }[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['where', 'andWhere', 'whereIn', 'andWhereRaw', 'whereILike', 'orWhere', 'orWhereILike']) {
    b[m] = (...args: unknown[]) => { llamadas.push({ metodo: m, args }); return b; };
  }
  return { llamadas, b };
};

const armar = (warehouseIds: () => Promise<string[] | null>) => {
  const estado = { corridasEnBase: 0, consultasDeAlcance: 0 };
  const svc = new CommercialReplenishmentService(
    { run: async () => { estado.corridasEnBase++; return []; } } as never,
    { requireTenantId: () => 'tenant-de-prueba' } as never,
    {} as never,
    {
      warehouseIds: async () => { estado.consultasDeAlcance++; return warehouseIds(); },
    } as never,
  );
  return { svc, estado };
};

/** `criticalFilters` es privado a propósito: lo que se prueba es su CONTRATO, no su firma. */
const aplicarFiltros = (svc: CommercialReplenishmentService, b: unknown, whIds: string[] | null) =>
  (svc as unknown as {
    criticalFilters: (b: unknown, q: object, t: string, w: string[] | null) => boolean;
  }).criticalFilters(b, {}, 'tenant-de-prueba', whIds);

const filtroDeAlmacen = (llamadas: { metodo: string; args: unknown[] }[]) =>
  llamadas.find((l) => l.metodo === 'whereIn' && l.args[0] === 'rp.warehouse_id');

describe('[ZN.3.3] Compras · el alcance corta por sucursal', () => {
  it('⭐ NEGATIVA: alcance resuelto a CERO almacenes ([]) llega al WHERE — no se lee como "todas"', () => {
    const { svc } = armar(async () => []);
    const { llamadas, b } = builderDoble();

    aplicarFiltros(svc, b, []);

    // Con el patrón viejo (`if (whIds.length)`) esta aserción es la que se pone ROJA: no había
    // filtro de almacén, así que la consulta devolvía la red entera.
    const filtro = filtroDeAlmacen(llamadas);
    expect(filtro).toBeDefined();
    expect(filtro!.args[1]).toEqual([]);
  });

  it('CONTROL POSITIVO: una lista concreta filtra por esos almacenes', () => {
    const { svc } = armar(async () => ['wh-02']);
    const { llamadas, b } = builderDoble();

    aplicarFiltros(svc, b, ['wh-02']);

    expect(filtroDeAlmacen(llamadas)!.args[1]).toEqual(['wh-02']);
  });

  it('CONTROL NEGATIVO DEL CONTROL: `null` (alcance global) NO agrega filtro de almacén', () => {
    const { svc } = armar(async () => null);
    const { llamadas, b } = builderDoble();

    aplicarFiltros(svc, b, null);

    // Sin esta prueba, "filtrar siempre" pasaría los otros dos casos y dejaría ciego al
    // comprador de red, que es quien más usa la pantalla.
    expect(filtroDeAlmacen(llamadas)).toBeUndefined();
    // Los demás filtros sí se aplicaron: el builder se usó, no es que no haya corrido nada.
    expect(llamadas.some((l) => l.metodo === 'where' && l.args[0] === 'rp.tenant_id')).toBe(true);
  });

  it('⭐ el alcance se consulta ANTES de tocar la base (existencia crítica)', async () => {
    const sentinela = new Error('el alcance no se pudo resolver');
    const { svc, estado } = armar(async () => { throw sentinela; });

    await expect(svc.criticalStock({})).rejects.toBe(sentinela);

    // Lo importante no es el error: es que el corte pasó antes de la consulta. Si alguien mueve
    // la resolución adentro de `tk.run`, esta aserción lo agarra.
    expect(estado.consultasDeAlcance).toBe(1);
    expect(estado.corridasEnBase).toBe(0);
  });

  it('el alcance se resuelve UNA sola vez por request, aunque los filtros se apliquen dos veces', async () => {
    const { svc, estado } = armar(async () => ['wh-02']);

    // `criticalStock` arma la página y el conteo con los mismos filtros. Resolver el alcance
    // adentro de `criticalFilters` duplicaría la consulta a `identity.*` en cada request.
    await svc.criticalStock({}).catch(() => undefined);

    expect(estado.consultasDeAlcance).toBe(1);
  });
});
