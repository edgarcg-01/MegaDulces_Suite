/**
 * `[K.VEC.1]` **Prueba NEGATIVA de la compuerta de corpus vectorial.**
 *
 * Lo que se rompió el 2026-09-22 y nadie vio hasta el 2026-10-16: las tablas
 * del vector store (`product_embeddings`, `active_product_embeddings`) no
 * existían en prod. El KNN tiraba `relation ... does not exist`, el catch POR
 * ITEM de `matchExtractedItems()` lo volvía `no_match`, y el vendedor leía las
 * 9 líneas de su ticket como «— sin match —» durante 24 días. Un defecto de
 * infraestructura era INDISTINGUIBLE de "este producto no está en el catálogo".
 *
 * Lo que se fija acá es que el caso roto **grita** (503 con causa) en vez de
 * devolver 200 con ceros, y que **no le paga a Voyage** por una consulta que no
 * tiene contra qué correr.
 *
 * ⚠️ ALCANCE HONESTO: estos dobles de Knex **no ejecutan SQL** — no validan que
 * las consultas de la sonda sean correctas contra Postgres. Eso se verificó
 * aparte, contra prod: `SELECT ... FROM active_product_embeddings` devolvió el
 * `relation ... does not exist` real, y tras crear las tablas devolvió filas.
 * Lo que este archivo prueba es la LÓGICA de la compuerta, nada más.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { AiProductMatcherService } from './ai-product-matcher.service';

type Fila = Record<string, unknown>;

/** Doble mínimo de Knex: sólo `.raw()`, que es lo único que toca la sonda. */
function vectorFalso(responder: (sql: string) => { rows: Fila[] }) {
  const raw = (sql: string) => Promise.resolve(responder(sql));
  return Object.assign(() => ({}), { raw }) as never;
}

const ITEMS = [
  { raw: '1PAQ BUBBALOO FRESA 239.7 GR/ 47', normalized: 'bubbaloo fresa', quantity: 1 },
  { raw: '1PAQ TRIDENT 4 S MENTA /40 MONDEL', normalized: 'trident menta', quantity: 1 },
];

function construir(opts: {
  vectorDb: unknown;
  onEmbed?: () => void;
}): { svc: AiProductMatcherService; embebidas: { n: number } } {
  const embebidas = { n: 0 };
  const embeddings = {
    embedBatch: async (textos: string[]) => {
      embebidas.n += textos.length;
      opts.onEmbed?.();
      return textos.map(() => [0.1, 0.2, 0.3]);
    },
  };
  const svc = new AiProductMatcherService(
    vectorFalso(() => ({ rows: [] })),
    opts.vectorDb as never,
    embeddings as never,
    {} as never,
  );
  return { svc, embebidas };
}

describe('[K.VEC.1] compuerta de corpus vectorial', () => {
  it('NEGATIVO — tabla AUSENTE: 503 con causa, no no_match silencioso', async () => {
    const { svc, embebidas } = construir({
      vectorDb: vectorFalso(() => {
        throw new Error('relation "active_product_embeddings" does not exist');
      }),
    });

    await expect(svc.matchExtractedItems(ITEMS, Date.now(), 'active')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Y no se le pagó a Voyage por una consulta sin corpus contra el cual correr.
    expect(embebidas.n).toBe(0);
  });

  it('NEGATIVO — tabla VACÍA: 503 que dice que el catálogo se está construyendo', async () => {
    const { svc, embebidas } = construir({ vectorDb: vectorFalso(() => ({ rows: [] })) });

    await expect(
      svc.matchExtractedItems(ITEMS, Date.now(), 'active'),
    ).rejects.toThrow(/vac[ií]o/i);
    expect(embebidas.n).toBe(0);
  });

  it('NEGATIVO — corpus del ticket sin DB vector: 503, nunca match contra el corpus equivocado', async () => {
    const { svc, embebidas } = construir({ vectorDb: null });

    await expect(svc.matchExtractedItems(ITEMS, Date.now(), 'active')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(embebidas.n).toBe(0);
  });

  it('POSITIVO — con filas, el match corre y SÍ embebe (la compuerta no estorba)', async () => {
    const { svc, embebidas } = construir({
      vectorDb: vectorFalso((sql) =>
        /LIMIT 1/.test(sql)
          ? { rows: [{ '?column?': 1 }] } // sonda: hay corpus
          : { rows: [{ sku: 'X1', product_name: 'BUBBALOO FRESA', category: null, score: 0.9 }] },
      ),
    });

    const r = await svc.matchExtractedItems(ITEMS, Date.now(), 'active');
    expect(r.items).toHaveLength(2);
    expect(embebidas.n).toBe(2);
  });

  it('el negativo NO se cachea: un corpus que se llena destraba sin reiniciar el pod', async () => {
    let hayFilas = false;
    const { svc } = construir({
      vectorDb: vectorFalso((sql) => {
        if (/LIMIT 1/.test(sql)) return { rows: hayFilas ? [{ '?column?': 1 }] : [] };
        return { rows: [{ sku: 'X1', product_name: 'BUBBALOO FRESA', category: null, score: 0.9 }] };
      }),
    });

    await expect(svc.matchExtractedItems(ITEMS, Date.now(), 'active')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    hayFilas = true; // el tick del worker llenó el corpus
    const r = await svc.matchExtractedItems(ITEMS, Date.now(), 'active');
    expect(r.items).toHaveLength(2);
  });
});
