import {
  CajaCobertura,
  cajaCoberturaPct,
  ventanaDeCobertura,
  CajaPeriodoContado,
  type CajaCoberturaEstado,
} from './caja-cobertura.contract';

/**
 * ⭐⭐ `[CG.183]` **El contrato de la cobertura, probado en sus TRES estados.**
 *
 * Un contrato no se verifica leyéndolo. Y éste tiene un modo de falla concreto y ya visto: **se
 * degrada a dos valores sin que nadie lo note**, porque el estado que nunca se ejercita es el del
 * fallo. Es `[CG.181]` —el 429 publicado como «0 corte(s)»— en este mismo módulo y el mismo día.
 *
 * Medido contra prod el 2026-10-14 (ventana 01→14-oct): capturado 70 movs / \$774,890.89 contra 549
 * movs / \$3,827,485.38 por confirmar = **11.3 % de los movimientos y 16.8 % del dinero**.
 */
const frescuraOk = {
  data_as_of: '2026-10-14T16:00:00.000Z',
  status: 'fresh' as const,
  stale: false,
  age_human: 'hace menos de una hora',
  inputs: [{
    key: 'ods_live_hot', label: 'Carril del ODS',
    at: '2026-10-14T16:00:00.000Z', age_human: 'hace menos de una hora',
    status: 'fresh' as const, stale: false,
  }],
};

const base = {
  ventana: { from: '2026-10-01', to: '2026-10-14' },
  capturado: { movimientos: 70, monto: 774890.89 },
  frescura: frescuraOk,
};

const medida = { ...base, estado: 'medida' as const, por_confirmar: { movimientos: 549, monto: 3827485.38 }, motivo: null };

describe('[CG.183] CajaCobertura — los tres estados', () => {
  it('`medida` lleva denominador y NO lleva motivo', () => {
    expect(CajaCobertura.safeParse(medida).success).toBe(true);
  });

  it('`no_corresponde` nombra TODOS los filtros activos, en orden fijo', () => {
    const r = CajaCobertura.safeParse({
      ...base, estado: 'no_corresponde', por_confirmar: null,
      motivo: { tipo: 'filtro', filtros: ['cuenta', 'search', 'mios'], texto: 'Con estos filtros no hay con qué comparar.' },
    });
    expect(r.success).toBe(true);
  });

  it('`sin_medir` lleva un motivo de fallo', () => {
    expect(CajaCobertura.safeParse({
      ...base, estado: 'sin_medir', por_confirmar: null,
      motivo: { tipo: 'fallo', texto: 'No se pudo leer la cola por confirmar.' },
    }).success).toBe(true);
  });
});

describe('[CG.183] ⛔ PRUEBAS NEGATIVAS: así es como se degrada a dos valores', () => {
  it('un `sin_medir` CON denominador se rechaza — es la degradación exacta', () => {
    // Si esto pasara, la pantalla dividiría igual y publicaría un porcentaje sobre un cálculo que
    // falló. El número se vería perfectamente normal.
    expect(CajaCobertura.safeParse({
      ...medida, estado: 'sin_medir',
      motivo: { tipo: 'fallo', texto: 'falló' },
    }).success).toBe(false);
  });

  it('un estado que no es `medida` SIN motivo se rechaza', () => {
    for (const estado of ['no_corresponde', 'sin_medir'] as CajaCoberturaEstado[]) {
      expect(CajaCobertura.safeParse({ ...base, estado, por_confirmar: null, motivo: null }).success)
        .toBe(false);
    }
  });

  it('los motivos no se pueden cruzar: `no_corresponde` con motivo de fallo se rechaza', () => {
    // Cruzarlos manda a la persona equivocada a arreglar el problema: `no_corresponde` lo resuelve
    // quien mira quitando un filtro, `sin_medir` lo resuelve Sistemas.
    expect(CajaCobertura.safeParse({
      ...base, estado: 'no_corresponde', por_confirmar: null,
      motivo: { tipo: 'fallo', texto: 'x' },
    }).success).toBe(false);
    expect(CajaCobertura.safeParse({
      ...base, estado: 'sin_medir', por_confirmar: null,
      motivo: { tipo: 'filtro', filtros: ['cuenta'], texto: 'x' },
    }).success).toBe(false);
  });

  it('`medida` CON motivo se rechaza: no hay nada que explicar', () => {
    expect(CajaCobertura.safeParse({ ...medida, motivo: { tipo: 'fallo', texto: 'x' } }).success).toBe(false);
  });

  it('`filtro` con la lista vacía se rechaza: un motivo que no nombra nada no es un motivo', () => {
    expect(CajaCobertura.safeParse({
      ...base, estado: 'no_corresponde', por_confirmar: null,
      motivo: { tipo: 'filtro', filtros: [], texto: 'x' },
    }).success).toBe(false);
  });

  it('⛔ una ventana con forma inválida se rechaza — «Wed Jan 28» ya viajó por acá', () => {
    // `pg` devuelve `date` como objeto y `String(f).slice(0,10)` produjo exactamente eso en este
    // módulo: viajaba al front, volvía como `?from=` y Postgres tiraba 22007.
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: 'Wed Jan 28', to: '2026-10-14' } }).success).toBe(false);
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: '2026-10-01', to: '' } }).success).toBe(false);
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: '2026-1-1', to: '2026-10-14' } }).success).toBe(false);
  });

  it('⛔ una ventana INVERTIDA se rechaza: tiene forma perfecta y devuelve cero filas', () => {
    // Es el caso que se lee como «no se capturó nada» en vez de «la ventana estaba al revés».
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: '2026-10-14', to: '2026-10-01' } }).success).toBe(false);
  });

  it('⛔ un `monto` NEGATIVO se rechaza: la base lo prohíbe en los dos lados', () => {
    // `cash_ledger_monto_chk: monto > 0` y la vista de la cola filtra `importe > 0`. Medido: 0
    // negativos en 75 filas del libro y en 13,330 de la cola.
    expect(CajaCobertura.safeParse({ ...medida, capturado: { movimientos: 1, monto: -5 } }).success).toBe(false);
  });

  it('⛔ el monto como STRING se rechaza — es lo que Postgres manda hoy', () => {
    // El repo no fija `setTypeParser`, así que `::numeric` llega como string y la pantalla
    // sobrevive sólo porque `money()` hace `Number(v || 0)`. Acá el contrato lo corta.
    expect(CajaCobertura.safeParse({
      ...medida, capturado: { movimientos: 70, monto: '774890.89' },
    }).success).toBe(false);
  });
});

/**
 * ⛔⛔ `[CG.183]` **Un denominador que se persigue la cola.**
 *
 * La primera versión derivaba la ventana del `min`/`max` de lo capturado, y el denominador se
 * acotaba a ella — o sea al tramo donde el numerador casualmente vive. Medido en prod sin
 * `from`/`to`: **835 contra 13,235** de denominador, cobertura publicada **8.2 %** contra **0.6 %**
 * real. Quince veces mejor, y nada se rompe.
 *
 * ⭐ El candado afirma la **PROPIEDAD**, no la cifra: una aserción sobre «8.2 % → 0.6 %» envejece
 * en cuanto cambie el libro y —peor— pasaría igual si alguien vuelve a derivar la ventana de otro
 * modo que hoy dé casualmente lo mismo.
 */
describe('[CG.183] la ventana es lo que se PREGUNTÓ, no lo que contestó', () => {
  it('con `from`/`to` pedidos, los publica tal cual', () => {
    expect(ventanaDeCobertura({ from: '2026-10-01', to: '2026-10-31' }))
      .toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('⛔ una ventana PEDIDA más ancha que los datos se publica entera', () => {
    // El caso LLENO, que es el que nadie va a mirar porque no revienta: pedir 01→31 sobre un libro
    // que va del 05 al 12 publicaría «05→12» sobre cifras calculadas en 31 días, y el porcentaje
    // se leería como cobertura de doce días.
    const pedida = ventanaDeCobertura({ from: '2026-10-01', to: '2026-10-31' });
    expect(pedida.from).toBe('2026-10-01');
    expect(pedida.to).toBe('2026-10-31');
    // La prueba vive o muere acá: la función NO recibe el span de los datos, así que no puede
    // publicarlo aunque alguien quiera. Si vuelve a aceptarlo como parámetro, esto se revisa.
    expect(ventanaDeCobertura.length).toBe(1);
  });

  it('⭐ sin `from`/`to`, `null` = SIN LÍMITE — y no es lo mismo que `sin_medir`', () => {
    // Son dos ausencias distintas, la misma distinción que separa `no_corresponde` de `sin_medir`.
    // Un `null` acá dice que la pregunta no tenía tope; lo que no se pudo determinar va en `estado`.
    expect(ventanaDeCobertura({})).toEqual({ from: null, to: null });
    expect(ventanaDeCobertura({ from: undefined, to: undefined })).toEqual({ from: null, to: null });
    expect(ventanaDeCobertura({ from: null, to: null })).toEqual({ from: null, to: null });
  });

  it('una sola punta pedida se respeta: media ventana es «desde X, sin tope»', () => {
    expect(ventanaDeCobertura({ from: '2026-10-01' })).toEqual({ from: '2026-10-01', to: null });
  });
});

describe('[CG.183] cajaCoberturaPct — los dos ejes dan números distintos, y por eso sale de un solo lugar', () => {
  it('reproduce lo medido en prod: 11.3 % de movimientos y 16.8 % del dinero', () => {
    expect(cajaCoberturaPct(medida, 'movimientos')).toBe(11.3);
    expect(cajaCoberturaPct(medida, 'monto')).toBe(16.8);
  });

  it('⛔ sin cobertura devuelve `null`, NUNCA 0', () => {
    // Un 0 se lee como «no se capturó nada», que es un hecho; `null` se lee como «no se sabe», que
    // es lo que pasa. Es la distinción que ADR-056 existe para sostener.
    const sinMedir = { ...base, estado: 'sin_medir' as const, por_confirmar: null, motivo: { tipo: 'fallo' as const, texto: 'x' } };
    expect(cajaCoberturaPct(sinMedir, 'movimientos')).toBeNull();
    expect(cajaCoberturaPct(sinMedir, 'monto')).toBeNull();
  });

  it('⭐ la ventana VACÍA es válida y es lo primero que ve quien abre un día nuevo', () => {
    // Guardia contra «arreglar» el cero con `positive()`: el CHECK de la base es sobre la FILA
    // (`monto > 0`), y este contrato describe el AGREGADO. Cero capturado no es un dato inválido:
    // es una ventana sin movimientos. Si alguien endurece el esquema, esta prueba se pone roja.
    const vacia = { ...base, estado: 'medida' as const, motivo: null,
      capturado: { movimientos: 0, monto: 0 },
      por_confirmar: { movimientos: 33, monto: 12500.5 } };
    expect(CajaCobertura.safeParse(vacia).success).toBe(true);
    expect(cajaCoberturaPct(vacia, 'movimientos')).toBe(0);
  });

  it('⭐ la ventana de UN SOLO DÍA es legítima: `from === to` pasa', () => {
    // Medido: `from = to = 2026-10-08` da 1 capturado contra 33 por confirmar. Es el camino de
    // quien revisa el día de un corte concreto desde la liga con `?from=`/`?to=`.
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: '2026-10-08', to: '2026-10-08' } }).success).toBe(true);
  });

  it('⭐ SIN PERIODO: la ventana nula es válida cuando no se contó nada', () => {
    // Medido y alcanzable desde la pantalla: `tipo = 'deposito'` da 0 filas en TODO el libro y el
    // selector lo ofrece. Sin `from`/`to`, `min(fecha)`/`max(fecha)` vienen NULL. La primera
    // versión ponía `''` ahí y el esquema lo rechazaba — un 500 a un clic de distancia.
    expect(CajaCobertura.safeParse({
      ...base, estado: 'medida', motivo: null,
      ventana: { from: null, to: null },
      capturado: { movimientos: 0, monto: 0 },
      por_confirmar: { movimientos: 508, monto: 3571067.99 },
    }).success).toBe(true);
  });

  it('⛔ PRUEBA NEGATIVA: con movimientos contados la ventana NO puede ser nula', () => {
    // Es lo que impide que el `null` se vuelva comodín. Si hubo movimientos, hubo un periodo; un
    // `null` que se puede poner siempre deja de significar algo.
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: null, to: null } }).success).toBe(false);
  });

  it('⛔ PRUEBA NEGATIVA: media ventana se rechaza — invita a completar la otra con un default', () => {
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: '2026-10-01', to: null } }).success).toBe(false);
    expect(CajaCobertura.safeParse({ ...medida, ventana: { from: null, to: '2026-10-14' } }).success).toBe(false);
  });

  it('un denominador en cero devuelve `null`, no una división por cero', () => {
    expect(cajaCoberturaPct({
      ...base, estado: 'medida', por_confirmar: { movimientos: 0, monto: 0 },
      capturado: { movimientos: 0, monto: 0 }, motivo: null,
    }, 'movimientos')).toBeNull();
  });

  it('cobertura total da 100, no `null`: medido y completo es un resultado', () => {
    expect(cajaCoberturaPct({
      ...base, estado: 'medida', por_confirmar: { movimientos: 0, monto: 0 }, motivo: null,
    }, 'movimientos')).toBe(100);
  });
});

/**
 * ⚠️ `[CG.183]` `periodo_contado` merece el mismo rigor que `ventana` **aunque sea informativo**:
 * es el campo que hizo caer la primera versión — lo que se publicaba como ventana era justamente
 * esto. Y vive en el contrato porque `z.object` **descarta las claves desconocidas en silencio**:
 * un campo que ningún esquema describe desaparece sin un error el día que alguien parsee.
 */
describe('[CG.183] CajaPeriodoContado — describir no es acotar, pero se describe bien', () => {
  it('acepta un periodo real y el vacío', () => {
    expect(CajaPeriodoContado.safeParse({ from: '2026-09-25', to: '2026-12-10' }).success).toBe(true);
    expect(CajaPeriodoContado.safeParse({ from: null, to: null }).success).toBe(true);
  });

  it('⛔ usa `from`/`to`, no `desde`/`hasta` — dos vocabularios en el mismo payload', () => {
    // `CLAUDE.md` §Convenciones: English snake_case para campos de DTO. Un rango de fechas no es un
    // término de dominio sin traducción limpia, y `ventana` ya usa `from`/`to` diez líneas arriba.
    expect(CajaPeriodoContado.safeParse({ desde: '2026-09-25', hasta: '2026-12-10' }).success).toBe(false);
  });

  it('⛔ media punta se rechaza, igual que en la ventana', () => {
    expect(CajaPeriodoContado.safeParse({ from: '2026-09-25', to: null }).success).toBe(false);
  });

  it('⛔ y la forma de la fecha también se verifica acá', () => {
    expect(CajaPeriodoContado.safeParse({ from: 'Wed Jan 28', to: '2026-12-10' }).success).toBe(false);
  });
});
