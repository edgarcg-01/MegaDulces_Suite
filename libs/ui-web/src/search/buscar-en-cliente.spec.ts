// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import {
  normalizarBusqueda, tokensDeBusqueda, coincideBusqueda, filtrarPorBusqueda, resaltarCoincidencias,
  type TramoResaltado,
} from './buscar-en-cliente';

/**
 * `[KBD.2]` Las pruebas están escritas contra las CUATRO formas en que falla
 * `x.toLowerCase().includes(q)` — el patrón que hoy usan 24 archivos. Cada bloque trae además
 * lo que ese patrón habría devuelto, para que la prueba no sólo diga "funciona" sino **qué se
 * estaba perdiendo**.
 */

/** El patrón viejo, para medir contra él y no contra una idea de él. */
const viejo = (q: string, ...campos: string[]) =>
  campos.some((c) => (c ?? '').toLowerCase().includes(q.toLowerCase()));

describe('las cuatro fallas del .includes() que esto reemplaza', () => {
  it('1 · ACENTOS — "pina" encuentra "PIÑA"; el viejo no', () => {
    expect(coincideBusqueda('pina', 'PIÑA EN ALMIBAR')).toBe(true);
    expect(viejo('pina', 'PIÑA EN ALMIBAR')).toBe(false);
  });

  it('2 · VARIAS PALABRAS — "coca 600" encuentra "COCA COLA 600 ML"; el viejo no', () => {
    expect(coincideBusqueda('coca 600', 'COCA COLA 600 ML')).toBe(true);
    expect(viejo('coca 600', 'COCA COLA 600 ML')).toBe(false);
  });

  it('3 · ORDEN — "600 coca" encuentra lo mismo: los tokens no van en fila', () => {
    expect(coincideBusqueda('600 coca', 'COCA COLA 600 ML')).toBe(true);
    expect(viejo('600 coca', 'COCA COLA 600 ML')).toBe(false);
  });

  it('4 · UN SOLO CAMPO — un token del SKU y otro del nombre, en la misma consulta', () => {
    expect(coincideBusqueda('88222 piña', '88222', 'PIÑA EN ALMIBAR')).toBe(true);
    expect(viejo('88222 piña', '88222', 'PIÑA EN ALMIBAR')).toBe(false);
  });
});

describe('normalizarBusqueda — tiene que decir lo mismo que f_unaccent(lower(…))', () => {
  it('quita acentos y baja a minúsculas', () => {
    expect(normalizarBusqueda('Puruándiro')).toBe('puruandiro');
    expect(normalizarBusqueda('PIÑA')).toBe('pina');
    expect(normalizarBusqueda('  Café  ')).toBe('cafe');
  });
  it('null/undefined no tiran', () => {
    expect(normalizarBusqueda(null)).toBe('');
    expect(normalizarBusqueda(undefined)).toBe('');
  });
});

describe('tokensDeBusqueda', () => {
  it('parte por espacios y descarta vacíos', () => {
    expect(tokensDeBusqueda('  coca   600  ')).toEqual(['coca', '600']);
  });
  it('texto vacío da CERO tokens — y cero tokens significa "no filtres"', () => {
    expect(tokensDeBusqueda('')).toEqual([]);
    expect(tokensDeBusqueda('   ')).toEqual([]);
  });
});

describe('coincideBusqueda — los bordes que deciden si la pantalla se ve vacía', () => {
  it('⛔ buscador vacío muestra TODO, no nada', () => {
    expect(coincideBusqueda('', 'lo que sea')).toBe(true);
    expect(coincideBusqueda(null, 'lo que sea')).toBe(true);
  });

  it('una fila sin ningún campo con texto NO casa (pero no tira)', () => {
    expect(coincideBusqueda('coca', null, undefined, '')).toBe(false);
  });

  it('exige TODOS los tokens, no alguno', () => {
    expect(coincideBusqueda('coca pepsi', 'COCA COLA 600 ML')).toBe(false);
  });

  it('los números se aceptan como campo sin convertirlos a mano', () => {
    expect(coincideBusqueda('88222', 88222, 'PIÑA')).toBe(true);
  });

  it('el acento va de los DOS lados: consulta con acento sobre dato sin acento', () => {
    expect(coincideBusqueda('piña', 'PINA EN ALMIBAR')).toBe(true);
  });
});

describe('filtrarPorBusqueda', () => {
  const filas = [
    { sku: '88222', nombre: 'PIÑA EN ALMIBAR' },
    { sku: '70001', nombre: 'COCA COLA 600 ML' },
    { sku: '17063', nombre: 'CAFÉ SOLUBLE' },
    { sku: '99999', nombre: null as string | null },
  ];
  const campos = (f: (typeof filas)[number]) => [f.sku, f.nombre];

  it('devuelve las que casan', () => {
    expect(filtrarPorBusqueda(filas, 'cafe', campos).map((f) => f.sku)).toEqual(['17063']);
  });

  it('sin consulta devuelve TODAS, y una COPIA (no la lista original)', () => {
    const r = filtrarPorBusqueda(filas, '', campos);
    expect(r).toHaveLength(4);
    expect(r).not.toBe(filas);
  });

  it('una fila con nombre null no rompe el filtro ni casa de más', () => {
    expect(filtrarPorBusqueda(filas, 'pina', campos).map((f) => f.sku)).toEqual(['88222']);
    expect(filtrarPorBusqueda(filas, '99999', campos).map((f) => f.sku)).toEqual(['99999']);
  });
});

describe('⚠️ el LÍMITE declarado: acá NO hay tolerancia a typos', () => {
  it('"erejon" NO encuentra "HERREJON" — eso es trigramas y vive sólo en el servidor', () => {
    // Está probado a propósito: si algún día alguien "mejora" esto imitando word_similarity en
    // JS, esta prueba se pone roja y obliga a discutirlo. Dos criterios de verdad para el mismo
    // texto es peor que un criterio con un hueco declarado.
    expect(coincideBusqueda('erejon', 'HERREJON GARCIA')).toBe(false);
  });
});

/**
 * `[GX.103]` Resaltar dónde coincide lo buscado, en los resultados del buscador de gastos. Cada
 * caso trae el texto ENTERO: juntar los tramos tiene que devolver el original, letra por letra.
 */
describe('resaltarCoincidencias — dónde coincide lo que se buscó', () => {
  /** Los tramos, escritos como `ab[cd]ef`: lo marcado va entre corchetes. */
  const ver = (tramos: TramoResaltado[]) => tramos.map((x) => (x.m ? `[${x.t}]` : x.t)).join('');

  it('marca el número adentro del folio: por eso salió «0009915» al buscar «15»', () => {
    expect(ver(resaltarCoincidencias('0009915', '15'))).toBe('00099[15]');
  });

  it('sin acentos ni mayúsculas, pero marca el texto ORIGINAL (con su acento)', () => {
    expect(ver(resaltarCoincidencias('SERVICIO MÉDICO', 'medico'))).toBe('SERVICIO [MÉDICO]');
    expect(ver(resaltarCoincidencias('Servicio medico', 'MÉDICO'))).toBe('Servicio [medico]');
  });

  it('varias palabras en cualquier orden, y cada vez que aparecen', () => {
    expect(ver(resaltarCoincidencias('COCA COLA 600 ML', '600 coca'))).toBe('[COCA] COLA [600] ML');
    expect(ver(resaltarCoincidencias('15 Y 15', '15'))).toBe('[15] Y [15]');
  });

  it('dos tokens que se enciman dan UN solo tramo marcado', () => {
    expect(ver(resaltarCoincidencias('0093155', '15 155'))).toBe('0093[155]');
  });

  it('un acento escrito aparte se queda con su letra', () => {
    expect(ver(resaltarCoincidencias('CAFÉ X', 'cafe'))).toBe('[CAFÉ] X');
  });

  it('⛔ una sola letra no se marca: marcaría media pantalla', () => {
    expect(ver(resaltarCoincidencias('PAPELERIA A', 'a'))).toBe('PAPELERIA A');
  });

  it('⛔ lo que el servidor encontró por PARECIDO no se marca: no hay un tramo igual que señalar', () => {
    expect(ver(resaltarCoincidencias('PROVEEDOR DEMO', 'provedor'))).toBe('PROVEEDOR DEMO');
  });

  it('sin consulta, un solo tramo sin marcar; sin texto, ningún tramo', () => {
    expect(resaltarCoincidencias('PAPELERIA', '')).toEqual([{ t: 'PAPELERIA', m: false }]);
    expect(resaltarCoincidencias('', 'pape')).toEqual([]);
    expect(resaltarCoincidencias(null, 'pape')).toEqual([]);
  });

  it('acepta números y los trata como su texto', () => {
    expect(ver(resaltarCoincidencias(10570, '057'))).toBe('1[057]0');
  });

  it('juntar los tramos devuelve el original, siempre', () => {
    for (const [t, q] of [['SERVICIO MÉDICO', 'medico ser'], ['0010570', '10570'], ['AÑO ÑOÑO', 'nono ano'], ['x', 'zz']]) {
      expect(resaltarCoincidencias(t, q).map((x) => x.t).join('')).toBe(t);
    }
  });
});
