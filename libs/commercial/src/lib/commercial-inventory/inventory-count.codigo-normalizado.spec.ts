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
/** Una fila de `catalog.product_barcodes`, ya unida a su producto como la devuelve el join. */
type Cod = {
  id: string;
  sku: string;
  nombre: string;
  barcode: string;
  unit: string | null;
  factor: number | null;
  is_primary: boolean | null;
  deleted_at?: string | null;
};

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
function doble(catalogo: Prod[], idsDelFolio: string[], codigos: Cod[] = []) {
  const predicado = () => {
    const partes: { op: 'and' | 'or'; f: (p: Prod) => boolean }[] = [];
    const qb: any = {
      // ⚠️ El prefijo se quita para `p.` **y para `b.`**: la tabla de códigos se consulta con
      // alias `b`, y un doble que sólo entendiera `p.` dejaría el nivel exacto de códigos sin
      // macher nunca — y la resolución caería al nivel normalizado dando el mismo producto.
      // O sea: verde por el camino equivocado.
      where(col: string, val: any) {
        const c = String(col).replace(/^[pb]\./, '');
        partes.push({ op: 'and', f: (p: any) => p[c] === val });
        return qb;
      },
      orWhere(col: string, val: any) {
        const c = String(col).replace(/^[pb]\./, '');
        partes.push({ op: 'or', f: (p: any) => p[c] === val });
        return qb;
      },
      whereRaw(sql: string, binds: any[]) {
        if (!/ltrim\([pb]\.barcode/.test(sql))
          throw new Error(`doble: whereRaw no modelado: ${sql}`);
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

  const consulta = (filas: any[], yaAcotadoAlFolio = false) => {
    const filtros: ((p: any) => boolean)[] = [];
    const ordenes: { col: string; dir: string }[] = [];
    const api: any = {
      /**
       * `[ICR.M11]` El `join` importa: la consulta a la tabla de códigos se acota al folio
       * **uniéndose a los renglones**, no por el `FROM`. Si el doble lo ignorara, el nivel
       * «códigos del folio» miraría el catálogo entero y la prueba de IC.F1 pasaría sola.
       */
      join(tabla: string) {
        if (!yaAcotadoAlFolio && String(tabla).startsWith('commercial.inventory_count_items'))
          filtros.push((p: any) => idsDelFolio.includes(p.id));
        return api;
      },
      where(a: any, b?: any) {
        if (typeof a === 'function') {
          const qb = predicado();
          a(qb);
          filtros.push((p) => qb.__eval(p));
        } else if (typeof a === 'object') {
          filtros.push((p: any) => Object.entries(a).every(([k, v]) => p[k] === v));
        } else {
          const c = String(a).replace(/^[ipb]\./, '');
          if (c === 'count_id') return api; // el folio se acota por el FROM o por el join
          filtros.push((p: any) => p[c] === b);
        }
        return api;
      },
      whereNull(col: string) {
        const c = String(col).replace(/^[ipb]\./, '');
        filtros.push((p: any) => p[c] == null);
        return api;
      },
      orderBy(col: string, dir = 'asc') {
        ordenes.push({ col: String(col).replace(/^[ipb]\./, ''), dir });
        return api;
      },
      andWhere(a: any, b?: any) {
        return api.where(a, b);
      },
      async first() {
        return filas.filter((p) => filtros.every((f) => f(p)))[0];
      },
      distinct(...cols: string[]) {
        let res = filas.filter((p) => filtros.every((f) => f(p)));
        for (const o of [...ordenes].reverse()) {
          res = [...res].sort((x: any, y: any) => {
            const a2 = x[o.col] ?? null;
            const b2 = y[o.col] ?? null;
            const n = a2 === b2 ? 0 : a2 === null ? 1 : b2 === null ? -1 : a2 < b2 ? -1 : 1;
            return o.dir === 'desc' ? -n : n;
          });
        }
        return Promise.resolve(
          res.map((p: any) =>
            Object.fromEntries(
              cols.map((c) => {
                const k = String(c).replace(/^[pb]\./, '');
                return [k, p[k]];
              }),
            ),
          ),
        );
      },
      then: (r: any, j: any) =>
        Promise.resolve(filas.filter((p) => filtros.every((f) => f(p)))).then(r, j),
    };
    return api;
  };

  const trx: any = (tabla: string) => {
    if (tabla === 'public.products as p' || tabla === 'public.products') return consulta(catalogo);
    if (tabla === 'commercial.inventory_count_items as i')
      return consulta(catalogo.filter((p) => idsDelFolio.includes(p.id)), true);
    if (tabla === 'catalog.product_barcodes as b') return consulta(codigos);
    throw new Error(`doble: tabla no modelada: ${tabla}`);
  };
  return trx;
}

function resolver(
  catalogo: Prod[],
  idsDelFolio: string[],
  code: string,
  opts: { codigos?: Cod[]; countId?: string | null } = {},
) {
  const svc = new InventoryCountService({} as any, {} as any, {} as any);
  const countId = opts.countId === undefined ? 'folio-1' : opts.countId;
  return (svc as any).resolverProductoPorCodigo(
    doble(catalogo, idsDelFolio, opts.codigos ?? []),
    countId,
    code,
  );
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
      expect(r).toMatchObject({ product_id: 'p-upc', fuente: 'folio-exacto' });
    });

    it('CONTROL — un código que no existe en ningún lado devuelve null (no inventa)', async () => {
      expect(await resolver([P_UPC], ['p-upc'], '9999999999999')).toBeNull();
    });

    it('⭐ 12 → 13: el escáner pone el cero y el producto SE ENCUENTRA (603 del folio)', async () => {
      const r = await resolver([P_UPC], ['p-upc'], UPC_EAN13);
      expect(r).toMatchObject({ product_id: 'p-upc', fuente: 'folio-normalizado' });
    });

    it('⭐ 13 → 12: guardado con cero y leído sin él, también (19 del folio)', async () => {
      const r = await resolver([P_CON_CERO], ['p-cero'], '735257003909');
      expect(r).toMatchObject({ product_id: 'p-cero', fuente: 'folio-normalizado' });
    });

    it('⛔ EXACTA antes que normalizada: la normalización nunca desvía un escaneo que ya funciona', async () => {
      // Los dos existen: el UPC-A de 12 y otro producto cuyo código es ese mismo con el cero.
      const catalogo = [P_UPC, P_GEMELO];
      expect(await resolver(catalogo, ['p-upc', 'p-gemelo'], UPC)).toMatchObject({
        product_id: 'p-upc',
        fuente: 'folio-exacto',
      });
      expect(await resolver(catalogo, ['p-upc', 'p-gemelo'], UPC_EAN13)).toMatchObject({
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
      expect(r).toMatchObject({ product_id: 'p-upc', fuente: 'catalogo-normalizado' });
    });

    it('⛔ el SKU no se normaliza: «182» no resuelve al SKU «00182»', async () => {
      expect(await resolver([P_UPC], ['p-upc'], '182')).toBeNull();
    });

    it('⛔ un código interno corto no arrastra a su vecino sin ceros (los 336 de 5 dígitos)', async () => {
      const r = await resolver([P_CORTO, P_CORTO_2], ['p-corto', 'p-corto2'], '00123');
      expect(r, 'si se normalizara, 00123 y 123 serían el mismo producto').toMatchObject({
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

/**
 * ⭐⭐ `[ICR.M11]` — **Los códigos que la gente escanea no están todos en `public.products`.**
 *
 * ## El defecto (F39)
 *
 * El resolvedor miraba `public.products`, que guarda **un** código por producto. Los códigos que
 * el escáner lee de verdad viven en `catalog.product_barcodes`, que guarda **varios**, incluido
 * el de la **CAJA**. Resultado medido: de los 2,313 códigos que el escáner puede leer en el
 * folio de Yurécuaro, **670 (29 %) no resolvían a nada** — «producto no encontrado» para
 * mercancía que está en el folio. **359 de ellos son códigos no primarios**: cajas y paquetes.
 *
 * ## El control que corrió ANTES de cambiar nada (prod, sólo lectura, 2026-11-27)
 *
 * Esto cambia **a qué producto resuelve un escaneo**, así que lo primero fue simular las dos
 * escaleras —la de hoy y la nueva— contra los 2,313 códigos y clasificar cada cambio:
 *
 * | | |
 * |---|---:|
 * | Igual: resolvía y resuelve al MISMO producto | 1,625 |
 * | **ARREGLADO**: 404 → producto **del folio** | **649** |
 * | **MEJORA**: resolvía a un producto de **FUERA** del folio → ahora dentro | **17** |
 * | 404 → ahora pregunta (ambiguo) · preguntaba y sigue preguntando | 2 · 6 |
 * | Preguntaba y ahora resuelve (una exacta le gana a una normalizada) | 14 |
 * | ⛔ **Cambia de identidad hacia un producto equivocado** | **0** |
 * | ⛔ **Sobrante fantasma** (404 → producto fuera del folio) | **0** |
 *
 * Los 17 de «MEJORA» son el daño de `[IC.F1]` ocurriendo hoy: `public.products` tiene el mismo
 * producto dos veces y la fila que gana —cuatro de ellas **sin SKU**— no es la del folio.
 *
 * ## Lo que este archivo fija
 *
 * Que la tabla de códigos entra **sin alterar el orden**: folio antes que catálogo, exacta antes
 * que normalizada, y `public.products` antes que la tabla de códigos dentro de cada casilla —que
 * es la propiedad que vuelve imposible que un escaneo que hoy funciona cambie de respuesta.
 */
describe('[ICR.M11] los códigos de caja también resuelven, sin mover a los demás', () => {
  const P_CAJA: Prod = { id: 'p-caja', sku: '00500', nombre: 'Mazapán', barcode: '7501000000011' };
  /** El código de la CAJA del mismo producto: sólo vive en `catalog.product_barcodes`. */
  const C_CAJA: Cod = {
    id: 'p-caja', sku: '00500', nombre: 'Mazapán', barcode: '7501000000028',
    unit: 'CJA', factor: null, is_primary: false, deleted_at: null,
  };
  const C_NATIVO: Cod = {
    id: 'p-caja', sku: '00500', nombre: 'Mazapán', barcode: '7501000000011',
    unit: 'PAQ', factor: 1, is_primary: true, deleted_at: null,
  };

  it('CONTROL — sin la tabla de códigos, el código de la caja NO resuelve (el defecto F39)', async () => {
    expect(await resolver([P_CAJA], ['p-caja'], C_CAJA.barcode)).toBeNull();
  });

  it('⭐ con la tabla de códigos, la caja resuelve al producto del folio (649 rescatados)', async () => {
    const r = await resolver([P_CAJA], ['p-caja'], C_CAJA.barcode, { codigos: [C_NATIVO, C_CAJA] });
    expect(r).toMatchObject({ product_id: 'p-caja', fuente: 'folio-exacto-codigos' });
  });

  it('⭐ y dice EN QUÉ UNIDAD está el código escaneado (es lo que [ICR.M6] necesita)', async () => {
    const r = await resolver([P_CAJA], ['p-caja'], C_CAJA.barcode, { codigos: [C_NATIVO, C_CAJA] });
    expect(r.unidad_del_codigo).toBe('CJA');
    expect(r.es_codigo_nativo).toBe(false);
    // ⚠️ Y el factor viene NULL, que es la verdad: 248 de 254 códigos CJA del folio no lo tienen.
    expect(r.factor_del_codigo).toBeNull();
  });

  it('el código NATIVO se reconoce como tal, no como una unidad rara', async () => {
    // Se resuelve por `public.products` (nivel 1), así que no trae unidad: eso es correcto y
    // se declara con `null`, no con una suposición.
    const r = await resolver([P_CAJA], ['p-caja'], C_NATIVO.barcode, { codigos: [C_NATIVO, C_CAJA] });
    expect(r).toMatchObject({ fuente: 'folio-exacto' });
    expect(r.unidad_del_codigo).toBeNull();
    expect(r.es_codigo_nativo).toBeNull();
  });

  it('⛔ `public.products` gana sobre la tabla de códigos: ningún escaneo de hoy cambia', async () => {
    // El mismo código apunta a UN producto en `public.products` y a OTRO en la tabla de códigos
    // (medido: pasa en 8 códigos del folio). Tiene que ganar el de hoy.
    //
    // ⚠️ Los DOS productos tienen que estar en el folio. Con el competidor afuera, el nivel de
    // códigos del folio lo filtra y la prueba pasaría sin ejercer la precedencia — verde por el
    // camino equivocado. (Se descubrió corriendo la mutación: invertir el orden no la ponía en
    // rojo.)
    const otroProd: Prod = { id: 'p-otro', sku: '00999', nombre: 'Otro', barcode: null };
    const otro: Cod = {
      id: 'p-otro', sku: '00999', nombre: 'Otro', barcode: P_CAJA.barcode as string,
      unit: 'PAQ', factor: 1, is_primary: true, deleted_at: null,
    };
    const r = await resolver([P_CAJA, otroProd], ['p-caja', 'p-otro'], P_CAJA.barcode as string, {
      codigos: [otro],
    });
    expect(r).toMatchObject({ product_id: 'p-caja', fuente: 'folio-exacto' });
  });

  it('⛔ el FOLIO sigue ganándole al catálogo, también con la tabla nueva ([IC.F1])', async () => {
    // El código de caja apunta a un producto del folio y a otro que no lo está.
    const fuera: Cod = {
      id: 'p-fuera', sku: '00111', nombre: 'De otra sucursal', barcode: C_CAJA.barcode,
      unit: 'CJA', factor: 12, is_primary: false, deleted_at: null,
    };
    const fueraProd: Prod = { id: 'p-fuera', sku: '00111', nombre: 'De otra sucursal', barcode: null };
    const r = await resolver([P_CAJA, fueraProd], ['p-caja'], C_CAJA.barcode, {
      codigos: [fuera, C_CAJA],
    });
    expect(r.product_id, 'resolvió al producto que no está en el folio').toBe('p-caja');
    expect(r.fuente).toBe('folio-exacto-codigos');
  });

  it('un código borrado (`deleted_at`) no resuelve nada', async () => {
    const borrado: Cod = { ...C_CAJA, deleted_at: '2026-01-01' };
    expect(await resolver([P_CAJA], ['p-caja'], C_CAJA.barcode, { codigos: [borrado] })).toBeNull();
  });

  it('el cero del escáner también funciona sobre la tabla de códigos (12 → 13)', async () => {
    const upc: Cod = {
      id: 'p-caja', sku: '00500', nombre: 'Mazapán', barcode: '724869100099',
      unit: 'CJA', factor: 24, is_primary: false, deleted_at: null,
    };
    const r = await resolver([P_CAJA], ['p-caja'], '0724869100099', { codigos: [upc] });
    expect(r).toMatchObject({ product_id: 'p-caja', fuente: 'folio-normalizado-codigos' });
    expect(r.factor_del_codigo).toBe(24);
  });

  it('⛔⛔ dos productos con el mismo código de caja PREGUNTAN, no adivinan', async () => {
    const a: Cod = { id: 'p-a', sku: '1', nombre: 'Uno', barcode: '7500000000099', unit: 'CJA', factor: 12, is_primary: false, deleted_at: null };
    const b: Cod = { id: 'p-b', sku: '2', nombre: 'Dos', barcode: '7500000000099', unit: 'CJA', factor: 24, is_primary: false, deleted_at: null };
    const pa: Prod = { id: 'p-a', sku: '1', nombre: 'Uno', barcode: null };
    const pb: Prod = { id: 'p-b', sku: '2', nombre: 'Dos', barcode: null };
    const p = resolver([pa, pb], ['p-a', 'p-b'], '7500000000099', { codigos: [a, b] });
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    const err: any = await p.catch((e: any) => e);
    expect(err.getResponse().code).toBe('CODIGO_AMBIGUO');
    expect(err.getResponse().candidates).toHaveLength(2);
  });

  /**
   * PRUEBA NEGATIVA del propio arnés: sin esto, un doble que ignorara el `join` a los renglones
   * haría que «el folio gana» pasara por vacuidad, porque la consulta de códigos del folio
   * estaría mirando el catálogo entero.
   */
  it('PRUEBA NEGATIVA — el nivel «códigos del folio» SÍ está acotado al folio', async () => {
    const soloFuera: Cod = {
      id: 'p-fuera', sku: '00111', nombre: 'De otra sucursal', barcode: C_CAJA.barcode,
      unit: 'CJA', factor: 12, is_primary: false, deleted_at: null,
    };
    const fuera: Prod = { id: 'p-fuera', sku: '00111', nombre: 'De otra sucursal', barcode: null };
    // El único dueño del código NO está en el folio → no puede resolver por el nivel del folio.
    const r = await resolver([P_CAJA, fuera], ['p-caja'], C_CAJA.barcode, { codigos: [soloFuera] });
    expect(r.fuente, 'el nivel del folio resolvió algo que no es del folio').toBe(
      'catalogo-exacto-codigos',
    );
    expect(r.product_id).toBe('p-fuera');
  });
});
