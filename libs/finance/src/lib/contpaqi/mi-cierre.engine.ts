/**
 * `[CPA.10]` — **La regla de la bandeja «Mi cierre», pura.**
 *
 * Mismo reparto que `cierre.engine.ts` (`[CPA.0]`) y `cuadre.engine.ts` (`[CP.8.10]`): la REGLA
 * vive acá, sin DI y sin base, y el servicio sólo hace la I/O. Lo que puede mentir con un número
 * se prueba con funciones, no montando un componente.
 *
 * ── Qué contesta esta bandeja, y en qué se diferencia del semáforo ────────────────────────────
 * El semáforo de `[CPA.0]` contesta *¿el mes está asentado?*. Esto contesta *¿qué estoy
 * tecleando y de eso cuánto te puedo armar?* — y por eso **no re-juzga si el mes está completo**:
 * para eso enlaza al semáforo. Dos tableros que emiten el mismo veredicto por caminos distintos
 * es la forma más común de que se contradigan.
 *
 * ── ⛔ La regla que puede mentir en silencio: `verificada` es TERNARIA ─────────────────────────
 * `contpaqi.poliza_exports.verificada` es `boolean NULL`, y el `NULL` **no es `false`**: significa
 * *nadie comprobó que ContPAQi la haya aceptado*. Colapsar `null` en `false` convierte "no sé" en
 * "no", y colapsarlo en `true` convierte "no sé" en "listo" — las dos son mentiras, y la segunda
 * es la que deja un mes dado por cerrado sin estarlo. Hay un estado propio,
 * `aplicada_sin_verificar`, y ninguna de las dos colapsa (ADR-056).
 */

/** Lo que `analytics.v_contpaqi_captura_mensual` publica. Los numéricos llegan como texto de `pg`. */
export interface FilaCapturaCruda {
  anio_mes: string;
  familia: string;
  orden: string | number;
  polizas: string | number;
  renglones: string | number;
  cargos: string | number;
  en_curso: boolean;
}

/** Una entrega viva de `contpaqi.poliza_exports`, ya agregada por (periodo, familia). */
export interface EntregaCruda {
  periodo: string;
  evento_tipo: string;
  estado: 'armada' | 'entregada' | 'aplicada' | 'rechazada';
  /** ⛔ TERNARIO. `null` = no se verificó, y no es `false`. */
  verificada: boolean | null;
  total: string | number;
  motivo: string | null;
  actualizada_en: string | null;
}

/**
 * El estado que se pinta en el renglón. **No** reusa `KpiEstado`: aquél mide *¿está bien?* y éste
 * mide *¿en qué parte del camino va?*. Forzar uno en el otro fue el error que `[CP.8.32]` pagó.
 */
export type EstadoBandeja =
  | 'lista'                    // armable hoy, nada entregado todavía
  | 'entregada'                // el TXT se bajó; ContPAQi todavía no confirmó
  | 'aplicada'                 // confirmada CON bitácora
  | 'aplicada_sin_verificar'   // alguien la marcó aplicada y nadie la comprobó
  | 'rechazada'                // ContPAQi la rechazó
  | 'falta_mapa'               // la fuente existe, el diccionario de cuentas no
  | 'no_automatizable';        // se declara, con motivo y con dueño

/**
 * Orden de atención: lo que exige acción humana primero, lo resuelto al final.
 * ⭐ `aplicada_sin_verificar` va ARRIBA de `aplicada` a propósito — si se ordenaran juntas, lo que
 * nadie comprobó se escondería entre lo que sí, que es justo lo que hay que mirar.
 */
export const ORDEN_ESTADO_BANDEJA: readonly EstadoBandeja[] = [
  'rechazada',
  'falta_mapa',
  'lista',
  'entregada',
  'aplicada_sin_verificar',
  'no_automatizable',
  'aplicada',
] as const;

/** Por qué una familia NO se puede armar hoy. Con dueño: una deuda sin dueño no se paga. */
export interface MotivoNoAutomatizable {
  motivo: string;
  dueno: string;
}

/** Qué hace falta para que una familia armable pase de `falta_mapa` a `lista`. */
export interface RequisitoMapa {
  /** Clave del diccionario que falta, para que la pantalla enlace a dónde se resuelve. */
  clave: string;
  descripcion: string;
}

export interface DefinicionFamilia {
  familia: string;
  etiqueta: string;
  /** De dónde saldría el asiento de este lado. `null` cuando no hay fuente. */
  fuente: string | null;
  automatizable: boolean;
  /** Presente sólo cuando `automatizable === false`. */
  no_automatizable?: MotivoNoAutomatizable;
  /** Diccionarios que este armado necesita. Vacío = no necesita nada más. */
  requiere: readonly RequisitoMapa[];
  /** El `evento_tipo` con el que sus entregas viven en `contpaqi.poliza_exports`. */
  evento_tipo: string;
}

/**
 * ⭐ El registro de familias. **Medido contra prod el 2026-10-12** (jul–sep 2026, renglones/mes):
 * cobranza 3,477 · pago_gasto 2,722 · venta_diaria 2,653 · comisiones 1,532 · nomina 706 ·
 * telemarketing 408 · libro 407 · traspasos 371 · otros 44 · gastos_varios 37 = **12,357/mes**,
 * de los cuales **93.6 %** cae en familias con fuente ya cargada de este lado.
 *
 * ⚠️ `automatizable` dice *tenemos la fuente*, **no** *está listo*. Lo segundo lo decide
 * `requiere`: una familia con fuente y sin diccionario sale `falta_mapa`, que es un estado
 * accionable, no un verde prematuro.
 */
export const FAMILIAS: readonly DefinicionFamilia[] = [
  {
    familia: 'cobranza_sucursal',
    etiqueta: 'Cobranza por sucursal',
    fuente: 'Depósitos de banco (finance.bank_movements) + cobros de Kepler (analytics.erp_collections)',
    automatizable: true,
    evento_tipo: 'cobranza_sucursal',
    requiere: [
      { clave: 'cuentas_cliente_sucursal', descripcion: 'Cuenta 103* de cliente por sucursal y por tasa' },
    ],
  },
  {
    familia: 'pago_gasto',
    etiqueta: 'Pago de gasto',
    fuente: 'analytics.erp_supplier_payments + finance.bank_movements',
    automatizable: true,
    evento_tipo: 'egreso',
    requiere: [
      { clave: 'account_rules', descripcion: 'Cuenta de gasto por categoría (contpaqi.account_rules)' },
    ],
  },
  {
    familia: 'venta_diaria',
    etiqueta: 'Venta diaria por sucursal',
    fuente: 'Sell-out (analytics.mv_kepler_sales_daily) + cortes de caja (analytics.cash_cuts)',
    automatizable: true,
    evento_tipo: 'venta_diaria',
    requiere: [
      { clave: 'cuentas_venta_sucursal', descripcion: 'Cuenta 401*/403* por sucursal, canal y tasa' },
    ],
  },
  {
    familia: 'comisiones_bancarias',
    etiqueta: 'Comisiones bancarias',
    fuente: 'finance.bank_movements clasificados comision_bancaria / comisiones_venta',
    automatizable: true,
    evento_tipo: 'comision_bancaria',
    // ⭐ El mapa se DERIVÓ de sus propios libros (2026-10-12): el cargo va a `5200650000
    // COMISIONES Y SITUACIONES`, el IVA a `1060000000 IVA ACREDITABLE`, y el banco a su `1020*`
    // (18 de 20 mapeados). Lo que falta NO es el diccionario, son esas 2 cuentas de banco.
    requiere: [
      { clave: 'bank_accounts.contpaqi_cuenta', descripcion: '2 cuentas de banco sin cuenta de ContPAQi asignada' },
    ],
  },
  {
    familia: 'nomina',
    etiqueta: 'Nómina',
    fuente: null,
    automatizable: false,
    evento_tipo: 'nomina',
    requiere: [],
    no_automatizable: {
      motivo: 'La fuente no está en la Suite todavía: la nómina vive en Mega Talento.',
      dueno: 'Fase RH',
    },
  },
  {
    familia: 'venta_telemarketing',
    etiqueta: 'Venta de telemarketing',
    fuente: 'Pedidos de telemarketing (commercial.orders) + remisiones de Kepler',
    automatizable: true,
    evento_tipo: 'venta_telemarketing',
    requiere: [
      { clave: 'cuentas_venta_sucursal', descripcion: 'Cuenta 401*/403* del canal TLMKT por sucursal' },
    ],
  },
  {
    familia: 'libro_compras',
    etiqueta: 'Libro de compras',
    fuente: 'fiscal.cfdis recibidas (ADD de ContPAQi) — módulo de Fase LC, 4 puertas anti-duplicado',
    automatizable: true,
    evento_tipo: 'libro_compras',
    requiere: [],
  },
  {
    familia: 'traspasos',
    etiqueta: 'Traspasos entre cuentas',
    fuente: 'finance.bank_movements — la conciliación ya verifica que TI = TE',
    automatizable: true,
    evento_tipo: 'traspaso',
    requiere: [
      { clave: 'bank_accounts.contpaqi_cuenta', descripcion: '2 cuentas de banco sin cuenta de ContPAQi asignada' },
    ],
  },
  {
    familia: 'gastos_varios',
    etiqueta: 'Gastos varios',
    fuente: null,
    automatizable: false,
    evento_tipo: 'gastos_varios',
    requiere: [],
    no_automatizable: {
      motivo: 'Gasto con tarjeta, efectivo o viaje capturado suelto: no hay un evento del que derivarlo.',
      dueno: 'sin asignar',
    },
  },
  {
    familia: 'otros',
    etiqueta: 'Otros',
    fuente: null,
    automatizable: false,
    evento_tipo: 'otros',
    requiere: [],
    no_automatizable: {
      motivo: 'Nadie los ha abierto todavía. Son 44 renglones al mes (0.4 %) y se cuentan aparte, no se reparten.',
      dueno: 'sin asignar',
    },
  },
] as const;

const POR_FAMILIA = new Map(FAMILIAS.map((f) => [f.familia, f]));

/** Lo que la bandeja publica por renglón. */
export interface FilaBandeja {
  familia: string;
  etiqueta: string;
  orden: number;
  renglones: number;
  polizas: number;
  cargos: number;
  fuente: string | null;
  automatizable: boolean;
  estado: EstadoBandeja;
  /** Por qué NO se puede armar, o por qué quedó sin verificar. `null` cuando no hay nada que declarar. */
  motivo: string | null;
  dueno: string | null;
  /** Lo que falta para que pase a `lista`. Vacío cuando no falta nada. */
  requiere: readonly RequisitoMapa[];
  /** ⛔ TERNARIO, tal cual viene. `null` = no se verificó. */
  verificada: boolean | null;
  actualizada_en: string | null;
}

export interface Bandeja {
  anio_mes: string;
  en_curso: boolean;
  total_renglones: number;
  /** Renglones en familias con fuente de este lado. */
  automatizables: number;
  /** `automatizables / total_renglones`, en puntos porcentuales. `null` si el mes no tiene nada. */
  cobertura_pct: number | null;
  conteo: Record<EstadoBandeja, number>;
  filas: FilaBandeja[];
}

/** `pg` devuelve `numeric` como texto. Un `+` sobre texto concatena y nadie lo nota. */
function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * El estado de un renglón. Las entregas mandan sobre el catálogo: si hay una entrega viva, su
 * estado es el que vale; si no la hay, el estado lo decide si la familia puede armarse hoy.
 */
export function estadoDeFila(
  def: DefinicionFamilia,
  entrega: EntregaCruda | undefined,
): { estado: EstadoBandeja; motivo: string | null; dueno: string | null } {
  if (entrega) {
    switch (entrega.estado) {
      case 'rechazada':
        return {
          estado: 'rechazada',
          motivo: entrega.motivo ?? 'ContPAQi la rechazó y no se guardó el motivo.',
          dueno: 'contabilidad',
        };
      case 'aplicada':
        // ⛔ Acá vive la regla ternaria. `verificada === true` es la ÚNICA forma de llegar a
        // `aplicada`: `false` y `null` son cosas distintas pero ninguna es "comprobada".
        return entrega.verificada === true
          ? { estado: 'aplicada', motivo: null, dueno: null }
          : {
              estado: 'aplicada_sin_verificar',
              motivo:
                entrega.verificada === false
                  ? 'Se marcó aplicada y el cuadre contra ContPAQi NO coincidió.'
                  : 'Se marcó aplicada sin la bitácora de ContPAQi: nadie comprobó que la haya aceptado.',
              dueno: 'contabilidad',
            };
      case 'entregada':
        return { estado: 'entregada', motivo: null, dueno: 'contabilidad' };
      case 'armada':
        return { estado: 'lista', motivo: null, dueno: 'contabilidad' };
    }
  }

  if (!def.automatizable) {
    return {
      estado: 'no_automatizable',
      motivo: def.no_automatizable?.motivo ?? null,
      dueno: def.no_automatizable?.dueno ?? null,
    };
  }

  if (def.requiere.length > 0) {
    return {
      estado: 'falta_mapa',
      motivo: def.requiere.map((r) => r.descripcion).join(' · '),
      dueno: 'sistemas',
    };
  }

  return { estado: 'lista', motivo: null, dueno: 'contabilidad' };
}

/** Un conteo que arranca en cero para TODOS los estados: un estado ausente vale 0, no `undefined`. */
export function conteoVacio(): Record<EstadoBandeja, number> {
  return ORDEN_ESTADO_BANDEJA.reduce(
    (acc, e) => { acc[e] = 0; return acc; },
    {} as Record<EstadoBandeja, number>,
  );
}

/**
 * Arma la bandeja de un mes.
 *
 * ⚠️ `filas` tiene que venir con **todas** las familias del mes (la vista las cruza con
 * `CROSS JOIN` justo para eso). Una familia ausente acá es una familia que desaparece del
 * tablero, que es como se perdió la póliza de compras de septiembre-2026.
 */
export function armarBandeja(
  filas: readonly FilaCapturaCruda[],
  entregas: readonly EntregaCruda[],
): Bandeja | null {
  if (filas.length === 0) return null;

  const porEvento = new Map(entregas.map((e) => [e.evento_tipo, e]));
  const conteo = conteoVacio();
  let total = 0;
  let automatizables = 0;

  const salida: FilaBandeja[] = [];
  for (const f of filas) {
    const def = POR_FAMILIA.get(f.familia);
    // Una familia que la vista publica y el registro no conoce no se inventa ni se esconde:
    // cae en `otros`, que es el bucket que ya se declara.
    const d = def ?? POR_FAMILIA.get('otros')!;
    const renglones = num(f.renglones);
    const { estado, motivo, dueno } = estadoDeFila(d, porEvento.get(d.evento_tipo));

    total += renglones;
    if (d.automatizable) automatizables += renglones;
    conteo[estado] += 1;

    const entrega = porEvento.get(d.evento_tipo);
    salida.push({
      familia: f.familia,
      etiqueta: d.etiqueta,
      orden: num(f.orden),
      renglones,
      polizas: num(f.polizas),
      cargos: num(f.cargos),
      fuente: d.fuente,
      automatizable: d.automatizable,
      estado,
      motivo,
      dueno,
      requiere: d.requiere,
      verificada: entrega ? entrega.verificada : null,
      actualizada_en: entrega?.actualizada_en ?? null,
    });
  }

  const rank = new Map(ORDEN_ESTADO_BANDEJA.map((e, i) => [e, i]));
  salida.sort((a, b) => {
    const da = (rank.get(a.estado) ?? 99) - (rank.get(b.estado) ?? 99);
    if (da !== 0) return da;
    // Dentro del mismo estado, el que más tecleo ahorra primero.
    if (b.renglones !== a.renglones) return b.renglones - a.renglones;
    return a.orden - b.orden;
  });

  return {
    anio_mes: filas[0].anio_mes,
    en_curso: filas[0].en_curso === true,
    total_renglones: total,
    automatizables,
    // ⛔ Sin renglones no hay cobertura: es `null`, no `0` ni `100`. Un cero dibujado se lee como
    // "no cubrimos nada" y un cien como "está todo" — las dos sobre un mes del que no sabemos.
    cobertura_pct: total > 0 ? Math.round((automatizables / total) * 1000) / 10 : null,
    conteo,
    filas: salida,
  };
}
