import { ConflictException } from '@nestjs/common';
import { InventoryCountService } from './inventory-count.service';

/**
 * ⛔⛔ `[ICR.M10]` — **El código que el escáner EMITE no es, carácter por carácter, el que está
 * guardado: un UPC-A leído en modo EAN-13 llega con un cero adelante.**
 *
 * ## El defecto
 *
 * La resolución comparaba cadenas exactas (`.where({ barcode })`). Un escáner configurado para
 * emitir EAN-13 le pone un cero adelante a un UPC-A de 12 dígitos; esa cadena deja de machear y
 * la pantalla dice **«producto no encontrado»** para un producto que está en el folio. Al revés
 * —guardado con cero, emitido sin él— pasa igual.
 *
 * ## Lo medido en pg-prod, sólo lectura, 2026-11-27 (`system_identifier` 7688376744939610156)
 *
 * Universo: los **2,024 artículos con existencia de Yurécuaro**, el piloto del martes 1-dic.
 *
 * | | |
 * |---|---:|
 * | Códigos distintos que el escáner puede leer (`catalog.product_barcodes`) | **2,313** |
 * | De 13 dígitos (EAN-13) · de 12 (UPC-A) · de 8 · de 14 | 1,468 · **786** · 36 · 20 |
 * | De 12 dígitos que **ya** empiezan con cero | **117** |
 * | Códigos que existen **en las dos formas a la vez** | **21** |
 *
 * Y sobre `public.products`, que es la tabla que este resolvedor consulta:
 *
 * | | |
 * |---|---:|
 * | UPC-A de 12 en el folio | **605** |
 * | De ésos, los que **hoy fallan** si el escáner pone el cero | **603** |
 * | Los que **recupera** la normalización, a un solo producto | **601** |
 * | Los que quedan **ambiguos** (la pantalla pregunta) | **4** |
 * | Guardados con cero adelante; recuperados en el sentido inverso | 19 · **15** |
 *
 * ⭐ **El control negativo, que es lo que vuelve barato el arreglo:** normalizar crea ambigüedad
 * nueva y hay que saber cuánta. Los códigos que apuntan a más de un producto pasan de **713 a
 * 718** globales (+5) y de **8 a 10** en el universo de Yurécuaro (+2). Por eso la normalización
 * se acota a `^[0-9]{8,14}$`: sin ese recorte el salto global era **+12**, porque arrastraba los
 * 336 códigos internos de 5 dígitos, donde un cero adelante no significa nada.
 *
 * ## Alcance de lo que afirma este archivo
 *
 * El `trx` es un **doble en memoria**. El `ltrim`/`~` de Postgres NO se ejerce acá; se midió
 * aparte, contra prod y en sólo lectura: para tres UPC-A reales del folio, el código con el cero
 * adelante da **0 coincidencias exactas y exactamente 1 normalizada**. Lo que este archivo fija
 * es el **orden de los niveles**, que exacta gana siempre, y que un código ambiguo **no se
 * resuelve solo**. Que el endpoint completo funcione contra base real sigue **NO MEDIDO**.
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales.
 */

type Prod = { id: string; sku: string; nombre: string; barcode: string | null };

const UPC = '724869100090'; // 12 dígitos, real: existe en Yurécuaro
const UPC_EAN13 = '0724869100090'; // lo que emite un escáner en modo EAN-13

const P_UPC: Prod = { id: 'p-upc', sku: '00182', nombre: 'Paleta payaso', barcode: UPC };
const P_CON_CERO: Prod = { id: 'p-cero', sku: '00900', nombre: 'Gomita', barcode: '0735257003909' };
const P_GEMELO: Prod = { id: 'p-gemelo', sku: '00777', nombre: 'Clon', barcode: UPC_EAN13 };
const P_CORTO: Prod = { id: 'p-corto', sku: '00300', nombre: 'Interno', barcode: '00123' };
const P_CORTO_2: Prod = { id: 'p-corto2', sku: '00301', nombre: 'Interno 2', barcode: '123' };

/** `ltrim(x,'0')` de Postgres, con el borde de la cadena de puros ceros. */
const ltrim0 = (s: string) => s.replace(/^0+/, '') || '0';

/**
 * Doble de `trx` con las dos consultas que usa `resolverProductoPorCodigo`. Es deliberadamente
 * estrecho: una tabla o un `whereRaw` que no esté modelado **revienta** en vez de devolver
 * vacío — un doble que contesta `[]` a lo que no entiende haría pasar todo por vacuidad.
 */
function doble(catalogo: Prod[], idsDelFolio: string[]) {
  const predicado = () => {
    const partes: { op: 'and' | 'or'; f: (p: Prod) => boolean }[] = [];
    const qb: any = {
      where(col: string, val: any) {
        const c = String(col).replace(/^p\./, '');
        partes.push({ op: 'and', f: (p: any) => p[c] === val });
        return qb;
      },
      orWhere(col: string, val: any) {
        const c = String(col).replace(/^p\./, '');
        partes.push({ op: 'or', f: (p: any) => p[c] === val });
        return qb;
      },
      whereRaw(sql: string, binds: any[]) {
        if (!/ltrim\(p\.barcode/.test(sql)) throw new Error(`doble: whereRaw no modelado: ${sql}`);
        const objetivo = binds[0];
        partes.push({
          op: 'and',
          f: (p: Prod) =>
            !!p.barcode && /^[0-9]{8,14}$/.test(p.barcode) && ltrim0(p.barcode) === objetivo,
        });
        return qb;
      },
      __eval(p: Prod) {
        if (!partes.length) return true;
        let acc = partes[0].f(p);
        for (const parte of partes.slice(1)) {
          acc = parte.op === 'or' ? acc || parte.f(p) : acc && parte.f(p);
        }
        return acc;
      },
    };
    return qb;
  };

  const consulta = (filas: Prod[]) => {
    const filtros: ((p: Prod) => boolean)[] = [];
    const api: any = {
      join: () => api,
      where(a: any, b?: any) {
        if (typeof a === 'function') {
          const qb = predicado();
          a(qb);
          filtros.push((p) => qb.__eval(p));
        } else if (typeof a === 'object') {
          filtros.push((p: any) => Object.entries(a).every(([k, v]) => p[k] === v));
        } else {
          const c = String(a).replace(/^[ip]\./, '');
          if (c === 'count_id') return api; // el folio ya viene acotado por `idsDelFolio`
          filtros.push((p: any) => p[c] === b);
        }
        return api;
      },
      andWhere(a: any, b?: any) {
        return api.where(a, b);
      },
      async first() {
        return filas.filter((p) => filtros.every((f) => f(p)))[0];
      },
      distinct(...cols: string[]) {
        const res = filas
          .filter((p) => filtros.every((f) => f(p)))
          .map((p: any) =>
            Object.fromEntries(cols.map((c) => [String(c).replace(/^p\./, ''), p[String(c).replace(/^p\./, '')]])),
          );
        return Promise.resolve(res);
      },
      then: (r: any, j: any) =>
        Promise.resolve(filas.filter((p) => filtros.every((f) => f(p)))).then(r, j),
    };
    return api;
  };

  const trx: any = (tabla: string) => {
    if (tabla === 'public.products as p' || tabla === 'public.products') return consulta(catalogo);
    if (tabla === 'commercial.inventory_count_items as i')
      return consulta(catalogo.filter((p) => idsDelFolio.includes(p.id)));
    throw new Error(`doble: tabla no modelada: ${tabla}`);
  };
  return trx;
}

function resolver(catalogo: Prod[], idsDelFolio: string[], code: string, countId: string | null = 'folio-1') {
  const svc = new InventoryCountService({} as any, {} as any, {} as any);
  return (svc as any).resolverProductoPorCodigo(doble(catalogo, idsDelFolio), countId, code);
}

const normalizar = (c: string) => (InventoryCountService as any).normalizarCodigoDeBarras(c);

describe('[ICR.M10] el cero que pone el escáner no puede perder un producto', () => {
  describe('la normalización, como función', () => {
    it('CONTROL — quita los ceros de la izquierda de un código con forma de EAN/UPC', () => {
      expect(normalizar(UPC_EAN13)).toBe(UPC);
      expect(normalizar(UPC)).toBe(UPC); // nada que quitar
      expect(normalizar('00000000')).toBe('0'); // el borde: no devuelve cadena vacía
    });

    it('⛔ NO normaliza lo que no tiene forma de EAN/UPC: ahí el cero sí significa algo', () => {
      expect(normalizar('00123'), 'un código interno de 5 dígitos').toBeNull();
      expect(normalizar('00182'), 'un SKU').toBeNull();
      expect(normalizar('ABC00123'), 'con letras').toBeNull();
      expect(normalizar('012345678901234'), '15 dígitos no es ningún estándar').toBeNull();
      expect(normalizar('')).toBeNull();
    });
  });

  describe('la resolución, por niveles', () => {
    it('CONTROL — un código que existe TAL CUAL se resuelve, y por el nivel exacto', async () => {
      const r = await resolver([P_UPC], ['p-upc'], UPC);
      expect(r).toEqual({ product_id: 'p-upc', fuente: 'folio-exacto' });
    });

    it('CONTROL — un código que no existe en ningún lado devuelve null (no inventa)', async () => {
      expect(await resolver([P_UPC], ['p-upc'], '9999999999999')).toBeNull();
    });

    it('⭐ 12 → 13: el escáner pone el cero y el producto SE ENCUENTRA (603 del folio)', async () => {
      const r = await resolver([P_UPC], ['p-upc'], UPC_EAN13);
      expect(r).toEqual({ product_id: 'p-upc', fuente: 'folio-normalizado' });
    });

    it('⭐ 13 → 12: guardado con cero y leído sin él, también (19 del folio)', async () => {
      const r = await resolver([P_CON_CERO], ['p-cero'], '735257003909');
      expect(r).toEqual({ product_id: 'p-cero', fuente: 'folio-normalizado' });
    });

    it('⛔ EXACTA antes que normalizada: la normalización nunca desvía un escaneo que ya funciona', async () => {
      // Los dos existen: el UPC-A de 12 y otro producto cuyo código es ese mismo con el cero.
      const catalogo = [P_UPC, P_GEMELO];
      expect(await resolver(catalogo, ['p-upc', 'p-gemelo'], UPC)).toEqual({
        product_id: 'p-upc',
        fuente: 'folio-exacto',
      });
      expect(await resolver(catalogo, ['p-upc', 'p-gemelo'], UPC_EAN13)).toEqual({
        product_id: 'p-gemelo',
        fuente: 'folio-exacto',
      });
    });

    it('el FOLIO sigue mandando sobre el catálogo ([IC.F1] no se tocó)', async () => {
      const otroIgual: Prod = { id: 'p-dup', sku: '', nombre: 'Duplicado del catálogo', barcode: UPC };
      const r = await resolver([otroIgual, P_UPC], ['p-upc'], UPC);
      expect(r!.product_id, 'resolvió contra la fila duplicada del catálogo').toBe('p-upc');
      expect(r!.fuente).toBe('folio-exacto');
    });

    it('fuera del folio se resuelve igual: un sobrante legítimo sigue dándose de alta', async () => {
      const r = await resolver([P_UPC], [], UPC_EAN13);
      expect(r).toEqual({ product_id: 'p-upc', fuente: 'catalogo-normalizado' });
    });

    it('⛔ el SKU no se normaliza: «182» no resuelve al SKU «00182»', async () => {
      expect(await resolver([P_UPC], ['p-upc'], '182')).toBeNull();
    });

    it('⛔ un código interno corto no arrastra a su vecino sin ceros (los 336 de 5 dígitos)', async () => {
      const r = await resolver([P_CORTO, P_CORTO_2], ['p-corto', 'p-corto2'], '00123');
      expect(r, 'si se normalizara, 00123 y 123 serían el mismo producto').toEqual({
        product_id: 'p-corto',
        fuente: 'folio-exacto',
      });
    });
  });

  describe('lo ambiguo no se resuelve solo', () => {
    /** Dos productos distintos cuyos códigos normalizan al mismo: los +2 del folio. */
    const A: Prod = { id: 'p-a', sku: '001', nombre: 'Uno', barcode: '0724869100091' };
    const B: Prod = { id: 'p-b', sku: '002', nombre: 'Dos', barcode: '724869100091' };

    it('⛔⛔ un código ambiguo devuelve 409 con los candidatos, no el primero que aparece', async () => {
      // Se escanea algo que NO existe exacto pero normaliza a los dos.
      const p = resolver([A, B], ['p-a', 'p-b'], '00724869100091');
      await expect(p).rejects.toBeInstanceOf(ConflictException);
      const err: any = await p.catch((e: any) => e);
      const cuerpo = err.getResponse();
      expect(cuerpo.code).toBe('CODIGO_AMBIGUO');
      expect(cuerpo.candidates).toHaveLength(2);
      expect(cuerpo.candidates.map((c: any) => c.product_id).sort()).toEqual(['p-a', 'p-b']);
      expect(cuerpo.candidates[0].sku, 'la pantalla necesita con qué preguntar').toBeTruthy();
    });

    /**
     * PRUEBA NEGATIVA del propio candado: sin esto, un resolvedor que lanzara 409 ante
     * **cualquier** coincidencia múltiple —incluso cuando las filas son del MISMO producto—
     * dejaría sin contar todo el folio y la prueba de arriba seguiría verde.
     */
    it('PRUEBA NEGATIVA — dos filas del MISMO producto no son ambigüedad', async () => {
      const mismo1: Prod = { ...P_UPC };
      const mismo2: Prod = { ...P_UPC, sku: '00182-bis' };
      const r = await resolver([mismo1, mismo2], ['p-upc'], UPC_EAN13);
      expect(r!.product_id).toBe('p-upc');
    });
  });
});
